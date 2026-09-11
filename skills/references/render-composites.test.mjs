/**
 * Tests for render-composites.mjs (Layer 2, the text layer).
 *
 *   node --test skills/references/render-composites.test.mjs
 *
 * Uses the installed Google Chrome and synthetic SVG backgrounds, so it needs no client photos
 * (brands/ is gitignored) and no network. Beyond the renderer's own report, it decodes the
 * output PNG and checks pixels directly — the text must physically be where the report says.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  launchBrowser, renderComposite, verifyReport, validateInputs, splitOffer,
} from "./render-composites.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────
const svg = (body, w = 1600, h = 1000) =>
  "data:image/svg+xml;base64," +
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
const DARK = svg(`<rect width="100%" height="100%" fill="#1C1C1C"/>`);
const LIGHT = svg(`<rect width="100%" height="100%" fill="#EFE8DA"/>`); // cream, like the Sin Ming floor
const STRIPES = svg(
  `<defs><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><rect width="40" height="80" fill="#FFFFFF"/><rect x="40" width="40" height="80" fill="#000000"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/>`);
const SOLID = "#202020";
const SOLID_BG = svg(`<rect width="100%" height="100%" fill="${SOLID}"/>`);

const BASE = { location: "BISHAN", audience: "LADIES WANTED", offer: "12 Week Confidence Comeback Challenge" };

// Minimal PNG decoder (8-bit RGB/RGBA, as Chrome's screenshots are), so pixels can be checked
// without adding an image library.
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); assert.equal(d[8], 8, "8-bit PNG expected"); ct = d[9]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : assert.fail(`unsupported PNG colour type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0, x = line[i];
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, px: out };
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// ── input hygiene (no browser) ────────────────────────────────────────────
test("inputs: em/en dashes, line breaks, padding and over-length are refused", () => {
  assert.match(validateInputs({ ...BASE, offer: "12 Week — Comeback" }).join(), /em\/en dash/);
  assert.match(validateInputs({ ...BASE, location: "BISHAN\nAREA" }).join(), /line break/);
  assert.match(validateInputs({ ...BASE, location: " BISHAN" }).join(), /leading or trailing/);
  assert.match(validateInputs({ ...BASE, offer: "x".repeat(91) }).join(), /limit is 90/);
  assert.match(validateInputs({ ...BASE, location: "" }).join(), /location is required/);
  assert.deepEqual(validateInputs(BASE), []);
  assert.deepEqual(validateInputs({ ...BASE, audience: null }), [], "audience is optional");
});

test("splitOffer: splits duration from name without rewording anything", () => {
  assert.deepEqual(splitOffer("12 Week Confidence Comeback Challenge"), { duration: "12 Week", offer_name: "Confidence Comeback Challenge" });
  assert.deepEqual(splitOffer("6-Week Fitness Kickstart"), { duration: "6-Week", offer_name: "Fitness Kickstart" });
  assert.deepEqual(splitOffer("Strength Reset"), { duration: null, offer_name: "Strength Reset" }, "no duration → whole name");
  assert.deepEqual(splitOffer("12 Week Challenge", true), { duration: "FREE 12 Week", offer_name: "Challenge" });
  assert.deepEqual(splitOffer("Strength Reset", true), { duration: null, offer_name: "FREE Strength Reset" });
});

test("inputs are refused before any rendering happens", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, offer: "12 Week – Comeback" });
  assert.equal(r.ok, false);
  assert.equal(r.png, undefined, "no image is produced for rejected input");
});

// ── rendering ─────────────────────────────────────────────────────────────
test("dark background: exact strings, in bounds, 1080x1080, no fallback needed", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const texts = Object.fromEntries(r.report.blocks.map((b) => [b.block, b.text]));
  assert.deepEqual(texts, { location: "BISHAN", audience: "LADIES WANTED", duration: "12 Week", offer_name: "Confidence Comeback Challenge" });
  const png = decodePNG(r.png);
  assert.deepEqual([png.w, png.h], [1080, 1080]);
  for (const b of r.report.blocks) assert.deepEqual(b.steps, [], `${b.block} should not need a fallback on dark`);
  assert.equal(r.report.scrim.alpha, 0);
});

test("light background: the contrast guard fires and the result still meets target", async () => {
  const r = await renderComposite(browser, { image: LIGHT, ...BASE });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const escalated = r.report.blocks.filter((b) => b.steps.length > 0);
  assert.ok(escalated.length > 0, "at least one line must have escalated on a light background");
  for (const b of r.report.blocks) {
    assert.ok(b.contrast.before < b.contrast.after || b.steps.length === 0, `${b.block} contrast should improve when escalated`);
    assert.ok(b.contrast.after >= 3.0, `${b.block} ends at ${b.contrast.after}:1`);
  }
});

test("harsh stripes: still legible, fallback recorded", async () => {
  const r = await renderComposite(browser, { image: STRIPES, ...BASE });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.ok(r.report.blocks.every((b) => b.steps.length > 0), "every line sits on a worst-case background");
});

test("long offer name shrinks to two lines and stays inside the region", async () => {
  const offer = "12 Week Strength and Confidence Comeback Challenge For Busy Parents";
  const short = await renderComposite(browser, { image: DARK, ...BASE });
  const long = await renderComposite(browser, { image: DARK, ...BASE, offer });
  assert.equal(long.ok, true, long.failures.join("\n"));
  const s = (r) => r.report.blocks.find((b) => b.block === "offer_name");
  assert.equal(s(long).lines, 2);
  assert.ok(s(long).size < s(short).size, "a longer name is set smaller");
  assert.equal(s(long).text, "Strength and Confidence Comeback Challenge For Busy Parents");
});

test("ink extent: every line's reported ink rect contains its layout box plus overhang room", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE });
  assert.equal(r.ok, true, r.failures.join("\n"));
  for (const b of r.report.blocks) {
    const L = b.layout_rect, I = b.rect;
    assert.ok(I.x < L.x && I.x + I.w > L.x + L.w, `${b.block} ink rect must be wider than its layout box`);
    assert.ok(I.x >= r.report.region.x - 1 && I.x + I.w <= r.report.region.x + r.report.region.w + 1, `${b.block} ink leaves the region`);
  }
});

test("audience callout is optional", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, audience: null });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.deepEqual(r.report.blocks.map((b) => b.block), ["location", "duration", "offer_name"]);
});

test("FREE prefix is rendered only when asked for", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, free: true });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.equal(r.report.blocks.find((b) => b.block === "duration").text, "FREE 12 Week");
});

test("hierarchy: the duration line is the largest; audience never exceeds location", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, location: "BISHAN AND UPPER THOMSON" });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const size = (id) => r.report.blocks.find((b) => b.block === id).size;
  for (const b of r.report.blocks) assert.ok(b.size <= size("duration"), `${b.block} ${b.size}px > duration`);
  assert.ok(size("audience") <= size("location"));
});

test("text that cannot fit fails loudly instead of clipping", async () => {
  // One unbreakable 68-letter word is wider than the region even at the 30px floor. (Two
  // separate long words would legitimately fit, one per line — that is not a failure case.)
  const r = await renderComposite(browser, { image: DARK, ...BASE, offer: "12 Week " + "Supercalifragilisticexpialidocious".repeat(2) });
  assert.equal(r.ok, false);
  assert.match(r.failures.join(), /does not fit/);
});

test("pixels: nothing is painted outside the text region (checked in the PNG, not the DOM)", async () => {
  const r = await renderComposite(browser, { image: SOLID_BG, ...BASE });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.equal(r.report.scrim.alpha, 0, "solid dark → no scrim, so any non-background pixel outside the region is a leak");
  const { w, h, ch, px } = decodePNG(r.png);
  const R = r.report.region, pad = 0; // letters and outlines must stay strictly inside the region
  const bgRGB = [0x20, 0x20, 0x20];
  let leaks = 0, inside = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * ch;
    const differs = Math.abs(px[i] - bgRGB[0]) + Math.abs(px[i + 1] - bgRGB[1]) + Math.abs(px[i + 2] - bgRGB[2]) > 24;
    const inRegion = x >= R.x - pad && x <= R.x + R.w + pad && y >= R.y - pad && y <= R.y + R.h + pad;
    if (differs && !inRegion) leaks++;
    if (differs && inRegion) inside++;
  }
  assert.equal(leaks, 0, `${leaks} painted pixels outside the region`);
  assert.ok(inside > 20000, "the text really was painted inside the region");
});

// ── the verifier itself must catch problems, not rubber-stamp them ────────
test("verifier catches a wrong string, an out-of-region line and a contrast miss", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE });
  const spec = { canvas: [1080, 1080], text: { location: "BISHAN", audience: "LADIES WANTED", duration: "12 Week", offer_name: "Confidence Comeback Challenge" }, contrast: { target: 4.5, stroke_min: 3 } };
  const tamper = (fn) => { const rep = structuredClone(r.report); fn(rep); return verifyReport(spec, rep).join("\n"); };
  assert.match(tamper((rep) => { rep.blocks[0].text = "BISHAM"; }), /text mismatch/);
  assert.match(tamper((rep) => { rep.blocks[0].rect.y = 5; }), /leaves its region/);
  assert.match(tamper((rep) => { rep.blocks[1].contrast.after = 1.2; rep.blocks[1].steps = []; }), /contrast/);
  assert.match(tamper((rep) => { rep.blocks[0].size = 999; }), /hierarchy/);
  assert.match(tamper((rep) => { rep.fontsLoaded = false; }), /font did not load/);
  assert.equal(verifyReport(spec, r.report).length, 0, "the untampered report passes");
});

// ══════════════════════════════════════════════════════════════════════════
// Step 1b-1 — style variation: 9 type styles × 10 palettes
// ══════════════════════════════════════════════════════════════════════════
import { loadCatalogue, buildSpec } from "./render-composites.mjs";

const CAT = loadCatalogue();
const STYLES = Object.keys(CAT.styles.styles);
const PALETTES = Object.keys(CAT.palettes.palettes);
const TEXT = { location: "BISHAN", audience: "LADIES WANTED", duration: "12 Week", offer_name: "Confidence Comeback Challenge" };
const HEX = /^#[0-9A-Fa-f]{6}$/;

test("catalogue: 9 styles and 10 palettes, every palette complete for all four lines", () => {
  assert.equal(STYLES.length, 9);
  assert.equal(PALETTES.length, 10);
  for (const [id, p] of Object.entries(CAT.palettes.palettes)) {
    for (const line of ["location", "audience", "duration", "offer_name"]) {
      assert.match(p.blocks[line]?.fill ?? "", HEX, `${id}.${line}.fill`);
      assert.match(p.blocks[line]?.outline ?? "", HEX, `${id}.${line}.outline`);
    }
    for (const k of ["band", "scrim", "pill"]) assert.match(p[k] ?? "", HEX, `${id}.${k}`);
    assert.ok(p.seen_in?.length, `${id} must name the reference it came from`);
  }
  for (const [id, s] of Object.entries(CAT.styles.styles)) assert.ok(s.seen_in?.length, `${id} must name the reference it came from`);
});

test("catalogue: all 90 style × palette combinations build a valid spec", () => {
  for (const style of STYLES) for (const palette of PALETTES) {
    const spec = buildSpec({ image: DARK, text: TEXT, style, palette });
    assert.equal(spec.layout.stack.length, 4);
    assert.ok(spec.fonts.length >= 1);
  }
});

test("every style renders and verifies on dark, light and striped backgrounds", async () => {
  const bgs = { DARK, LIGHT, STRIPES };
  let n = 0;
  for (const [si, style] of STYLES.entries()) {
    for (const [bi, [bgName, image]] of Object.entries(bgs).entries()) {
      const palette = PALETTES[(si + bi * 3) % PALETTES.length];
      const r = await renderComposite(browser, { image, ...BASE, style, palette });
      assert.equal(r.ok, true, `${style} / ${palette} / ${bgName}:\n${r.failures.join("\n")}`);
      n++;
    }
  }
  assert.equal(n, 27);
});

test("every palette renders and verifies on dark, light and striped backgrounds", async () => {
  for (const palette of PALETTES) for (const [bgName, image] of Object.entries({ DARK, LIGHT, STRIPES })) {
    const r = await renderComposite(browser, { image, ...BASE, palette });
    assert.equal(r.ok, true, `${palette} / ${bgName}:\n${r.failures.join("\n")}`);
  }
});

test("fonts: every face each style uses genuinely loads, family and style", async () => {
  for (const style of STYLES) {
    const r = await renderComposite(browser, { image: DARK, ...BASE, style });
    assert.equal(r.ok, true, `${style}: ${r.failures.join(" | ")}`);
    const want = r.spec.fonts.map((f) => `${f.family}|${f.style}`).sort();
    const got = r.report.faces.filter((f) => f.loaded).map((f) => `${f.family}|${f.style}`).sort();
    assert.deepEqual(got, want, `${style}: loaded faces must be exactly the faces the style uses`);
  }
});

test("no faux styles: the italic style really uses the italic face, not slanted upright", async () => {
  // The page sets font-synthesis: none, so Chrome can never fake a slant. If the italic face were
  // not actually in use, the text would render upright — pixel-identical to the upright render.
  // So different pixels under the same text prove the real italic face drew it.
  // (Width is NOT a usable proof: Montserrat Italic is designed with exactly the upright's letter
  // widths. An earlier version of this test compared widths and wrongly failed.)
  const mk = (face) => ({ blocks: Object.fromEntries(["location", "audience", "duration", "offer_name"].map((k) => [k, { face, weight: 900 }])) });
  const a = await renderComposite(browser, { image: DARK, ...BASE, palette: "white-on-dark", styleSpec: mk("montserrat") });
  const b = await renderComposite(browser, { image: DARK, ...BASE, palette: "white-on-dark", styleSpec: mk("montserrat-italic") });
  assert.ok(a.ok && b.ok, [...(a.failures || []), ...(b.failures || [])].join("\n"));
  const la = a.report.blocks.find((x) => x.block === "location"), lb = b.report.blocks.find((x) => x.block === "location");
  assert.deepEqual([la.size, la.layout_rect.w], [lb.size, lb.layout_rect.w], "same size and width — only the letter shapes differ");
  const A = decodePNG(a.png), B = decodePNG(b.png), r = la.layout_rect;
  let changed = 0, total = 0;
  for (let y = Math.floor(r.y); y < r.y + r.h; y++) for (let x = Math.floor(r.x); x < r.x + r.w; x++) {
    const i = (y * A.w + x) * A.ch; total++;
    if (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]) > 60) changed++;
  }
  assert.ok(changed / total > 0.05, `only ${(100 * changed / total).toFixed(1)}% of pixels differ — italic face not in use`);
  assert.ok(b.report.faces.some((f) => f.family === "Montserrat" && f.style === "italic" && f.loaded));
});

test("no faux styles: a weight the face does not have is refused before rendering", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, styleSpec: { blocks: { location: { face: "anton", weight: 900 } } } });
  assert.equal(r.ok, false);
  assert.match(r.failures.join(), /only has 400.*would fake it/);
});

test("effects: heavy outline judged on the better of fill and outline; hollow on its own colour", async () => {
  const s2 = await renderComposite(browser, { image: DARK, ...BASE, style: "s2-heavy-outlined", palette: "red-white" });
  assert.equal(s2.ok, true, s2.failures.join("\n"));
  const loc = s2.report.blocks.find((b) => b.block === "location");
  assert.equal(loc.effect, "outline-bold");
  assert.deepEqual(loc.judged_colours, ["#FF2A2A", "#FFFFFF"]);
  const s9 = await renderComposite(browser, { image: DARK, ...BASE, style: "s9-hollow-duration", palette: "cyan-pink" });
  assert.equal(s9.ok, true, s9.failures.join("\n"));
  const dur = s9.report.blocks.find((b) => b.block === "duration");
  assert.equal(dur.effect, "hollow");
  assert.deepEqual(dur.judged_colours, ["#3BE3EA"], "hollow text is drawn, and judged, in its fill colour");
});

test("script: audience line only, exact text underneath, length limit enforced", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, style: "s8-script-accent" });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const aud = r.report.blocks.find((b) => b.block === "audience");
  assert.equal(aud.script, true);
  assert.equal(aud.text, "LADIES WANTED", "shown as 'Ladies Wanted', but the characters are exactly as typed");
  assert.ok(aud.size >= 52);
  const onOffer = await renderComposite(browser, { image: DARK, ...BASE, styleSpec: { blocks: { offer_name: { face: "great-vibes", weight: 400 } } } });
  assert.equal(onOffer.ok, false);
  assert.match(onOffer.failures.join(), /only allowed on: audience/);
  const tooLong = await renderComposite(browser, { image: DARK, ...BASE, audience: "LADIES AND GENTLEMEN WANTED", style: "s8-script-accent" });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.failures.join(), /script style allows 24/);
});

test("wide letter-spacing stays centred and inside the region", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, style: "s4-wide-tracked" });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const R = r.report.region, mid = R.x + R.w / 2;
  for (const b of r.report.blocks.filter((x) => x.lines === 1)) {
    const c = b.layout_rect.x + b.layout_rect.w / 2;
    assert.ok(Math.abs(c - mid) < 2, `${b.block} centre ${c.toFixed(1)} vs region centre ${mid.toFixed(1)}`);
  }
});

test("band style: the pill stays inside the region and meets contrast", async () => {
  for (const palette of PALETTES) {
    const r = await renderComposite(browser, { image: STRIPES, ...BASE, style: "s7-elegant-serif", palette });
    assert.equal(r.ok, true, `${palette}: ${r.failures.join(" | ")}`);
    const off = r.report.blocks.find((b) => b.block === "offer_name");
    assert.ok(off.band, `${palette}: offer_name should carry a band`);
    assert.ok(off.contrast.after >= 4.5, `${palette}: ${off.contrast.after}:1`);
  }
});

test("pixels, per style: no letter is painted outside the region, even at full width", async () => {
  // Long lines fill the region's width, so any face whose overhang is under-reserved (italic
  // slant, script swashes) would paint past the edge. Checked in the PNG, not the DOM.
  const LONG = { location: "BISHAN AND UPPER THOMSON", audience: "LADIES WANTED", offer: "12 Week Strength and Confidence Comeback Challenge For Busy Parents" };
  for (const style of STYLES) {
    const r = await renderComposite(browser, { image: SOLID_BG, ...LONG, style, palette: "white-on-dark" });
    assert.equal(r.ok, true, `${style}: ${r.failures.join(" | ")}`);
    assert.equal(r.report.scrim.alpha, 0, `${style}: no scrim expected on solid dark`);
    const { w, h, ch, px } = decodePNG(r.png);
    const R = r.report.region;
    let leaks = 0, inside = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const differs = Math.abs(px[i] - 0x20) + Math.abs(px[i + 1] - 0x20) + Math.abs(px[i + 2] - 0x20) > 24;
      const inRegion = x >= R.x && x <= R.x + R.w && y >= R.y && y <= R.y + R.h;
      if (differs && !inRegion) leaks++;
      if (differs && inRegion) inside++;
    }
    assert.equal(leaks, 0, `${style}: ${leaks} painted pixels outside the region`);
    assert.ok(inside > 20000, `${style}: text was painted`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Step 2 — layouts
// ══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// E2 — golden snapshots of the approved T1 renders. The snapshot file was written by the engine
// as it stood when Step 1 was approved (commit 5c39930), before the layout engine was built.
// Every later engine change must reproduce it exactly: same sizes, line counts, positions,
// contrast and fallbacks. Pixel hashes are compared too whenever the Chrome version matches
// the one that wrote the snapshot (a Chrome update may legitimately change anti-aliasing).
// Regenerate ONLY for an intended T1 change:  UPDATE_GOLDEN=1 node --test <this file>
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "t1.json");
const LONG_TEXT = { location: "BISHAN AND UPPER THOMSON", audience: "LADIES WANTED", offer: "12 Week Strength and Confidence Comeback Challenge For Busy Parents" };

function goldenCases() {
  const cases = [];
  const bgs = { DARK, LIGHT, STRIPES };
  for (const [si, style] of STYLES.entries()) {
    for (const [bi, [bg, image]] of Object.entries(bgs).entries()) {
      const palette = PALETTES[(si + bi * 3) % PALETTES.length];
      cases.push({ key: `${style}/${palette}/${bg}`, args: { image, ...BASE, style, palette } });
    }
    cases.push({ key: `${style}/white-on-dark/SOLID/long`, args: { image: SOLID_BG, ...LONG_TEXT, style, palette: "white-on-dark" } });
  }
  for (const palette of PALETTES) cases.push({ key: `s7-elegant-serif/${palette}/STRIPES`, args: { image: STRIPES, ...BASE, style: "s7-elegant-serif", palette } });
  cases.push({ key: "s1/no-audience/DARK", args: { image: DARK, ...BASE, audience: null } });
  cases.push({ key: "s1/free/LIGHT", args: { image: LIGHT, ...BASE, free: true } });
  cases.push({ key: "s1/long-location/DARK", args: { image: DARK, ...BASE, location: "BISHAN AND UPPER THOMSON" } });
  return cases;
}

const r2 = (v) => Math.round(v * 100) / 100;
const rect2 = (r) => (r ? { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h), ...(r.colour ? { colour: r.colour } : {}) } : null);
function snapshot(r) {
  return {
    scrim: r.report.scrim.alpha,
    blocks: r.report.blocks.map((b) => ({
      block: b.block, text: b.text, face: b.face, effect: b.effect, size: b.size, lines: b.lines,
      layout_rect: rect2(b.layout_rect), rect: rect2(b.rect), band: rect2(b.band),
      judged_colours: b.judged_colours, contrast: b.contrast, steps: b.steps,
    })),
    png_sha256: createHash("sha256").update(r.png).digest("hex"),
  };
}

test("E2 golden: T1 reproduces the approved Step 1 renders exactly", async () => {
  const { product: chrome } = await browser.cdp.send("Browser.getVersion");
  const got = {};
  for (const c of goldenCases()) {
    const r = await renderComposite(browser, c.args);
    assert.equal(r.ok, true, `${c.key}: ${r.failures.join(" | ")}`);
    got[c.key] = snapshot(r);
  }
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify({ chrome, cases: got }, null, 1) + "\n");
    return;
  }
  assert.ok(existsSync(GOLDEN), "golden snapshot missing");
  const want = JSON.parse(readFileSync(GOLDEN, "utf-8"));
  assert.deepEqual(Object.keys(got), Object.keys(want.cases), "same cases as the snapshot");
  const pixels = chrome === want.chrome;
  for (const [key, g] of Object.entries(got)) {
    const { png_sha256: gh, ...gs } = g, { png_sha256: wh, ...ws } = want.cases[key];
    assert.deepEqual(gs, ws, `${key}: layout, contrast or fallbacks changed`);
    if (pixels) assert.equal(gh, wh, `${key}: pixels changed`);
  }
});

// ── Step 2a — the layout engine (groups, dividers, scrim directions, bands, clear zones) ──
// These use small test layouts passed as `treatmentSpec`, so the engine is proven on its own
// before the real layouts T2–T8 are added to the catalogue (Step 2b/2c, with their own tests).
import { validateLayout, imagesNeeded } from "./render-composites.mjs";

const T1 = CAT.treatments.treatments["t1-bottom-stack"];
const layoutOf = (groups, clear_zones = []) => ({ layouts: { "1x1": { groups, clear_zones } }, contrast: T1.contrast });
const ln = (block, share, max_lines, min_px, optional) => ({ block, share, max_lines, min_px, ...(optional ? { optional: true } : {}) });
const LOC = ln("location", 1, 1, 34), AUD = ln("audience", 0.66, 1, 28, true), DUR = ln("duration", 1.5, 1, 44), OFF = ln("offer_name", 1.4, 2, 30);
const RULE = { block: "divider", width_pct: 30, thickness_pct: 0.5 };

const SPLIT = layoutOf([
  { id: "top", region: [8, 6, 84, 28], anchor: "top", align: "center", gap_pct: 0.9, scrim: { direction: "top", fade_pct: 10 }, stack: [LOC, AUD] },
  { id: "bottom", region: [8, 62, 84, 32], anchor: "bottom", align: "center", gap_pct: 0.9, scrim: { direction: "bottom", fade_pct: 10 }, stack: [DUR, OFF] },
], [{ name: "subject", rect: [5, 36, 90, 24] }]);
const column = (align) => layoutOf([{
  id: "col", region: align === "right" ? [52, 6, 42, 88] : [6, 6, 42, 88], anchor: "center", align, gap_pct: 1.2,
  scrim: { direction: align, fade_pct: 8 },
  stack: [ln("location", 1, 2, 34), AUD, RULE, DUR, ln("offer_name", 1.4, 4, 28)],
}], [{ name: "subject", rect: align === "right" ? [5, 5, 45, 90] : [50, 5, 45, 90] }]);
const banded = (mode, shape) => layoutOf([
  { id: "top", region: [8, 6, 84, 26], anchor: "top", align: "center", gap_pct: 0.9, scrim: { direction: "top", fade_pct: 8 }, stack: [LOC, AUD] },
  { id: "offer", region: [6, 58, 88, 36], anchor: "bottom", align: "center", gap_pct: 0.6, scrim: { direction: "none" },
    band: { mode, shape, blocks: ["duration", "offer_name"], pad_pct: 1.6, radius_pct: 4 }, stack: [DUR, OFF] },
]);
const EVEN = layoutOf([{ id: "all", region: [8, 8, 84, 84], anchor: "center", align: "center", gap_pct: 1, scrim: { direction: "even" }, stack: [LOC, AUD, RULE, DUR, OFF] }]);
const TEST_LAYOUTS = { SPLIT, RIGHT: column("right"), LEFT: column("left"), BAND_FULL: banded("full", "pill"), BAND_LINE: banded("line", "bar"), EVEN };

const lumAt = (png, x, y) => { const i = (y * png.w + x) * png.ch; return 0.2126 * png.px[i] + 0.7152 * png.px[i + 1] + 0.0722 * png.px[i + 2]; };
const meanLum = (png, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = Math.floor(y0); y < y1; y += 3) for (let x = Math.floor(x0); x < x1; x += 3) { s += lumAt(png, x, y); n++; } return s / n; };
// Pixels that differ from the solid #202020 background, outside every group region (a leak), or
// inside a given rect (text where it must not be).
function painted(png, test) {
  let n = 0;
  for (let y = 0; y < png.h; y++) for (let x = 0; x < png.w; x++) {
    const i = (y * png.w + x) * png.ch;
    if (Math.abs(png.px[i] - 0x20) + Math.abs(png.px[i + 1] - 0x20) + Math.abs(png.px[i + 2] - 0x20) > 24 && test(x, y)) n++;
  }
  return n;
}
// Pixel (x, y) is the square [x, x+1) × [y, y+1). It is inside a rect if the two overlap: regions
// sit on fractional pixels (6% of 1080 = 64.8), and the pixel row a region edge passes through is
// partly inside it. (Comparing only the pixel's corner miscounted those rows on top/left edges.)
const within = (R) => (x, y) => x + 1 > R.x && x < R.x + R.w && y + 1 > R.y && y < R.y + R.h;

test("2a layout rules: T1 and every test layout are valid; bad geometry is refused before rendering", () => {
  assert.deepEqual(validateLayout(T1.layouts["1x1"], "t1"), []);
  for (const [k, L] of Object.entries(TEST_LAYOUTS)) assert.deepEqual(validateLayout(L.layouts["1x1"], k), [], k);
  const g = (over) => ({ id: "a", region: [6, 48, 88, 46], anchor: "bottom", align: "center", gap_pct: 1, scrim: { direction: "bottom", fade_pct: 12 }, stack: [LOC, DUR, OFF], ...over });
  const bad = (groups, clear_zones) => validateLayout({ groups, clear_zones }).join(" | ");
  assert.match(bad([g({ region: [2, 48, 88, 46] })]), /crosses the 5% canvas margin/);
  assert.match(bad([g({ stack: [LOC, AUD, DUR] })]), /offer name must appear exactly once/);
  assert.match(bad([g({ stack: [LOC, LOC, DUR, OFF] })]), /location line must appear exactly once/);
  assert.match(bad([g({ stack: [LOC, DUR, OFF, RULE] })]), /divider must sit between two lines/);
  assert.match(bad([g({ stack: [LOC, DUR], id: "a" }), g({ id: "b", region: [6, 60, 88, 30], stack: [OFF] })]), /overlap/);
  assert.match(bad([g({ id: "a", region: [6, 6, 88, 30], stack: [LOC], scrim: { direction: "bottom", fade_pct: 12 } }),
    g({ id: "b", region: [6, 60, 88, 30], stack: [DUR, OFF] })]), /"a"'s bottom scrim would reach group "b"/);
  assert.match(bad([g({ id: "a", region: [6, 6, 88, 30], stack: [LOC], scrim: { direction: "even" } }),
    g({ id: "b", region: [6, 60, 88, 30], stack: [DUR, OFF], scrim: { direction: "none" } })]), /single-group/);
  assert.match(bad([g({ band: { mode: "full", shape: "pill", blocks: ["location", "offer_name"] } })]), /next to each other/);
  assert.match(bad([g()], [{ name: "subject", rect: [10, 40, 80, 20] }]), /touches the clear zone "subject"/);
  assert.throws(() => buildSpec({ image: DARK, text: TEXT, treatmentSpec: layoutOf([g({ region: [2, 48, 88, 46] })]) }), /canvas margin/);
});

test("2a groups: lines render in their own group's region; hierarchy spans groups; clear zone stays empty", async () => {
  const r = await renderComposite(browser, { image: SOLID_BG, ...BASE, treatmentSpec: SPLIT, palette: "white-on-dark" });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const at = Object.fromEntries(r.report.blocks.map((b) => [b.block, b]));
  assert.deepEqual(Object.fromEntries(Object.entries(at).map(([k, b]) => [k, b.group])), { location: "top", audience: "top", duration: "bottom", offer_name: "bottom" });
  for (const b of r.report.blocks) {
    const R = r.report.groups.find((g) => g.id === b.group).region;
    assert.ok(b.rect.y >= R.y - 1 && b.rect.y + b.rect.h <= R.y + R.h + 1, `${b.block} inside group "${b.group}"`);
  }
  assert.ok(at.location.rect.y < 1080 * 0.34 && at.offer_name.rect.y > 1080 * 0.62, "location up top, offer at the bottom");
  for (const b of r.report.blocks) assert.ok(b.size <= at.duration.size, `${b.block} ${b.size}px > duration ${at.duration.size}px`);
  assert.ok(at.audience.size <= at.location.size);
  const png = decodePNG(r.png), Z = r.report.clear_zones[0];
  assert.equal(painted(png, within(Z)), 0, "no text pixels in the subject's space");
  assert.equal(painted(png, (x, y) => !r.report.groups.some((g) => within(g.region)(x, y))), 0, "nothing outside the groups");
});

test("2a scrim directions: each group darkens its own side, and only there", async () => {
  const png = async (L) => {
    const r = await renderComposite(browser, { image: LIGHT, ...BASE, treatmentSpec: L, palette: "white-on-dark" });
    assert.equal(r.ok, true, r.failures.join("\n"));
    return { r, p: decodePNG(r.png) };
  };
  const W = 1080, H = 1080, e = 30;
  const split = await png(SPLIT);
  assert.ok(split.r.report.groups.every((g) => g.scrim.alpha > 0), "both groups needed a scrim on cream");
  const [top, mid, bottom] = [meanLum(split.p, 0, 0, W, e), meanLum(split.p, 0, H * 0.47, W, H * 0.49), meanLum(split.p, 0, H - e, W, H)];
  assert.ok(top < mid - 60 && bottom < mid - 60, `top ${top.toFixed(0)} / middle ${mid.toFixed(0)} / bottom ${bottom.toFixed(0)}`);
  for (const side of ["right", "left"]) {
    const { r, p } = await png(column(side));
    assert.equal(r.report.groups[0].scrim.direction, side);
    const [l, rr] = [meanLum(p, 0, 0, e, H), meanLum(p, W - e, 0, W, H)];
    assert.ok(side === "right" ? rr < l - 60 : l < rr - 60, `${side} column: left edge ${l.toFixed(0)}, right edge ${rr.toFixed(0)}`);
  }
  const even = await png(EVEN);
  const corners = [meanLum(even.p, 0, 0, e, e), meanLum(even.p, W - e, 0, W, e), meanLum(even.p, 0, H - e, e, H), meanLum(even.p, W - e, H - e, W, H)];
  assert.ok(Math.max(...corners) - Math.min(...corners) < 2 && corners[0] < 200, `even scrim corners ${corners.map((c) => c.toFixed(0))}`);
});

test("2a dividers: drawn between the lines, inside the region, 3:1 against the photo, never counted as text", async () => {
  for (const [name, image] of Object.entries({ DARK, LIGHT, STRIPES })) {
    const r = await renderComposite(browser, { image, ...BASE, treatmentSpec: column("right"), palette: "cyan-pink" });
    assert.equal(r.ok, true, `${name}: ${r.failures.join(" | ")}`);
    const [d] = r.report.groups[0].dividers;
    assert.ok(d, `${name}: divider drawn`);
    const aud = r.report.blocks.find((b) => b.block === "audience"), dur = r.report.blocks.find((b) => b.block === "duration");
    assert.ok(d.y >= aud.rect.y + aud.rect.h && d.y + d.h <= dur.rect.y, `${name}: divider sits between audience and duration`);
    assert.ok(d.contrast >= 3, `${name}: divider ${d.contrast}:1`);
    assert.ok(!r.report.blocks.some((b) => b.block === "divider"), "a divider is not a text block");
    if (name === "DARK") assert.equal(d.colour, "#FF5DBB", "the palette's divider colour when it reads");
  }
  // With no audience line, the divider still has text on both sides (location / duration) and stays.
  // A divider whose only neighbour on one side is missing is dropped, so no stray rule is left.
  const lone = layoutOf([{ id: "a", region: [6, 40, 88, 54], anchor: "bottom", align: "center", gap_pct: 1, scrim: { direction: "bottom", fade_pct: 10 },
    stack: [LOC, DUR, OFF, RULE, AUD] }]);
  const r = await renderComposite(browser, { image: DARK, ...BASE, audience: null, treatmentSpec: lone });
  assert.equal(r.ok, true, r.failures.join("\n"));
  assert.equal(r.report.groups[0].dividers.length, 0);
});

test("2a alignment: left and right columns line up their edges (±2px) with any style", async () => {
  for (const side of ["left", "right"]) for (const style of ["s1-heavy-sans", "s4-wide-tracked", "s5-italic-heavy", "s8-script-accent"]) {
    const r = await renderComposite(browser, { image: DARK, ...BASE, location: "UPPER THOMSON", treatmentSpec: column(side), style });
    assert.equal(r.ok, true, `${side} ${style}: ${r.failures.join(" | ")}`);
    const edges = r.report.blocks.map((b) => b.edge);
    assert.ok(Math.max(...edges) - Math.min(...edges) <= 2, `${side} ${style}: edges ${edges.map((x) => x.toFixed(1)).join(", ")}`);
    const R = r.report.groups[0].region;
    const target = side === "left" ? R.x + r.report.groups[0].inset : R.x + R.w - r.report.groups[0].inset;
    assert.ok(Math.abs(edges[0] - target) <= 1, `${side} ${style}: edge on the group's inset line`);
  }
  // Two rules can collide: a long location in a narrow column is set small, "audience ≤ location"
  // then pulls a script audience under its 52px floor. That must fail loudly, never render.
  const clash = await renderComposite(browser, { image: DARK, ...BASE, location: "BISHAN AND UPPER THOMSON", treatmentSpec: column("left"), style: "s8-script-accent" });
  assert.equal(clash.ok, false);
  assert.match(clash.failures.join(), /script is \d+px, below the 52px legibility floor/);
});

test("2a pixels: nothing leaks from any test layout, in any style, at full width", async () => {
  // "UPPER THOMSON" wraps to fill a column's width; the longer location would clash with script (above).
  const LONG = { location: "UPPER THOMSON", audience: "LADIES WANTED", offer: "12 Week Strength and Confidence Comeback Challenge For Busy Parents" };
  for (const [name, L] of Object.entries(TEST_LAYOUTS)) for (const style of STYLES) {
    const r = await renderComposite(browser, { image: SOLID_BG, ...LONG, treatmentSpec: L, style, palette: "white-on-dark" });
    assert.equal(r.ok, true, `${name} ${style}: ${r.failures.join(" | ")}`);
    const png = decodePNG(r.png);
    const leaks = painted(png, (x, y) => !r.report.groups.some((g) => within(g.region)(x, y)));
    assert.equal(leaks, 0, `${name} ${style}: ${leaks} painted pixels outside the text regions`);
    for (const Z of r.report.clear_zones) assert.equal(painted(png, within(Z)), 0, `${name} ${style}: text in clear zone "${Z.name}"`);
  }
});

test("2a layout bands: full-width pill and per-line bars, inside the region, 4.5:1 on every palette", async () => {
  for (const palette of PALETTES) {
    const full = await renderComposite(browser, { image: STRIPES, ...BASE, treatmentSpec: banded("full", "pill"), palette });
    assert.equal(full.ok, true, `full ${palette}: ${full.failures.join(" | ")}`);
    const g = full.report.groups.find((x) => x.id === "offer");
    assert.equal(g.band.rects.length, 1);
    const [k] = g.band.rects;
    assert.ok(Math.abs(k.x - g.region.x) < 0.5 && Math.abs(k.w - g.region.w) < 0.5, `full ${palette}: band spans the group's width`);
    assert.equal(g.scrim.alpha, 0, "no scrim behind a solid band");
    for (const b of full.report.blocks.filter((x) => x.group === "offer")) {
      assert.deepEqual(b.steps, ["layout-band"]);
      assert.ok(b.contrast.after >= 4.5, `full ${palette} ${b.block}: ${b.contrast.after}:1`);
      assert.ok(b.rect.y >= k.y && b.rect.y + b.rect.h <= k.y + k.h, `full ${palette} ${b.block}: letters inside the band`);
    }
    const line = await renderComposite(browser, { image: STRIPES, ...BASE, treatmentSpec: banded("line", "bar"), palette });
    assert.equal(line.ok, true, `line ${palette}: ${line.failures.join(" | ")}`);
    const lg = line.report.groups.find((x) => x.id === "offer");
    const nLines = line.report.blocks.filter((x) => x.group === "offer").reduce((n, b) => n + b.lines, 0);
    assert.equal(lg.band.rects.length, nLines, `line ${palette}: one bar per line of text`);
    for (const b of line.report.blocks.filter((x) => x.group === "offer")) assert.ok(b.contrast.after >= 4.5, `line ${palette} ${b.block}: ${b.contrast.after}:1`);
  }
});

test("2a verifier: catches a line in a clear zone, a stray divider, a weak divider and a line in the wrong group", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, treatmentSpec: column("right") });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const spec = buildSpec({ image: DARK, text: TEXT, treatmentSpec: column("right") });
  const tamper = (fn) => { const rep = structuredClone(r.report); fn(rep); return verifyReport(spec, rep).join("\n"); };
  assert.equal(verifyReport(spec, r.report).length, 0, "the untampered report passes");
  assert.match(tamper((rep) => { rep.blocks[0].rect.x = 100; }), /enters the clear zone "subject"/);
  assert.match(tamper((rep) => { rep.groups[0].dividers[0].x = 10; }), /divider leaves its region/);
  assert.match(tamper((rep) => { rep.groups[0].dividers[0].contrast = 1.4; }), /divider contrast 1.4:1/);
  assert.match(tamper((rep) => { rep.blocks[2].group = "elsewhere"; }), /the layout puts it in "col"/);
});

// ── Step 2b — the catalogue layouts ────────────────────────────────────────
// A: catalogue · B: correctness across combinations · C: each layout has its reference's shape ·
// D: pixel checks. The 108 layout × style × short/long renders are made once (on a solid
// background, so any painted pixel is text, a band or a divider) and shared by B4, C and D.
const LAYOUT_IDS = Object.keys(CAT.treatments.treatments);
const LY = (id) => CAT.treatments.treatments[id];
// As many copies of a background as the layout needs photos (T7's collage takes 4, T8's panels 2).
const photos = (treatment, image) => Array(imagesNeeded(LY(treatment).layouts["1x1"])).fill(image);
const LONG_OFFER = { location: "BISHAN / THOMSON", audience: "LADIES WANTED", offer: "12 Week Strength and Confidence Comeback Challenge For Busy Parents" };
const grid = new Map(); // `${layout}|${style}|short|long` → { r, png }
const gridRender = async (treatment, style, len) => {
  const key = `${treatment}|${style}|${len}`;
  if (!grid.has(key)) {
    const r = await renderComposite(browser, { images: photos(treatment, SOLID_BG), ...(len === "long" ? LONG_OFFER : BASE), treatment, style, palette: "white-on-dark" });
    grid.set(key, { r, png: r.ok ? decodePNG(r.png) : null });
  }
  return grid.get(key);
};
const allGrid = async (layouts = LAYOUT_IDS) => {
  const out = [];
  for (const t of layouts) for (const s of STYLES) for (const len of ["short", "long"]) out.push({ t, s, len, ...(await gridRender(t, s, len)) });
  return out;
};
const blk = (r, id) => r.report.blocks.find((b) => b.block === id);
const bottomOf = (k) => k.y + k.h;

test("A1 catalogue: all 8 layouts, numbered in order, each attributed and with a visual hint", () => {
  assert.deepEqual(LAYOUT_IDS, ["t1-bottom-stack", "t2-top-bottom-split", "t3-right-column", "t4-centred-stack", "t5-offer-band", "t6-left-column", "t7-collage", "t8-panels-band"]);
  LAYOUT_IDS.forEach((id, i) => {
    const t = LY(id);
    assert.equal(t.number, 101 + i, `${id} number`);
    assert.ok(t.name && t.seen_in?.length, `${id} must name the references it came from`);
    assert.ok(t.layouts["1x1"], `${id} has a 1:1 layout`);
    assert.match(t.visual_hint, /No text, letters, signage, logos or watermarks/, `${id} visual hint forbids model-drawn text`);
  });
});

test("A2/A3 catalogue: every layout is geometrically sound and carries the whole message exactly once", () => {
  for (const id of LAYOUT_IDS) {
    const L = LY(id).layouts["1x1"];
    assert.deepEqual(validateLayout(L, id), [], id);
    const lines = L.groups.flatMap((g) => g.stack.filter((it) => it.block !== "divider").map((it) => it.block)).sort();
    assert.deepEqual(lines, ["audience", "duration", "location", "offer_name"], `${id}: each line exactly once`);
    assert.ok(L.groups.flatMap((g) => g.stack).find((it) => it.block === "audience").optional, `${id}: audience is optional`);
  }
  const zones = (id) => LY(id).layouts["1x1"].clear_zones.map((z) => z.name);
  for (const id of ["t2-top-bottom-split", "t3-right-column", "t5-offer-band", "t6-left-column"]) assert.deepEqual(zones(id), ["subject"], `${id} keeps the subject's space clear`);
});

test(`A4 catalogue: all ${LAYOUT_IDS.length * 9 * 10} layout × style × palette combinations build a valid spec`, () => {
  let n = 0;
  for (const treatment of LAYOUT_IDS) for (const style of STYLES) for (const palette of PALETTES) {
    const spec = buildSpec({ images: photos(treatment, DARK), text: TEXT, treatment, style, palette });
    assert.equal(spec.layout.stack.length, 4);
    n++;
  }
  assert.equal(n, LAYOUT_IDS.length * 90);
});

test("B1 every layout renders and verifies on dark, light and striped backgrounds", async () => {
  for (const [li, treatment] of LAYOUT_IDS.entries()) for (const [bi, [bg, image]] of Object.entries({ DARK, LIGHT, STRIPES }).entries()) {
    const palette = PALETTES[(li * 3 + bi) % PALETTES.length];
    const r = await renderComposite(browser, { images: photos(treatment, image), ...BASE, treatment, palette });
    assert.equal(r.ok, true, `${treatment} / ${bg} / ${palette}:\n${r.failures.join("\n")}`);
  }
});

test("B3 every layout × every palette holds contrast (backgrounds rotate dark / light / stripes)", async () => {
  const BGS = [["DARK", DARK], ["LIGHT", LIGHT], ["STRIPES", STRIPES]];
  for (const [li, treatment] of LAYOUT_IDS.entries()) for (const [pi, palette] of PALETTES.entries()) {
    const [bg, image] = BGS[(li + pi) % 3];
    const r = await renderComposite(browser, { images: photos(treatment, image), ...BASE, treatment, palette });
    assert.equal(r.ok, true, `${treatment} / ${palette} / ${bg}:\n${r.failures.join("\n")}`);
  }
});

test("B2/B4 every layout × every style, short and long offer names: fits, exact, long set no larger", async () => {
  const rows = await allGrid();
  assert.equal(rows.length, LAYOUT_IDS.length * 9 * 2);
  for (const { t, s, len, r } of rows) assert.equal(r.ok, true, `${t} / ${s} / ${len}:\n${r.failures.join("\n")}`);
  for (const t of LAYOUT_IDS) for (const s of STYLES) {
    const short = grid.get(`${t}|${s}|short`).r, long = grid.get(`${t}|${s}|long`).r;
    assert.equal(blk(long, "offer_name").text, "Strength and Confidence Comeback Challenge For Busy Parents");
    assert.ok(blk(long, "offer_name").size <= blk(short, "offer_name").size, `${t} / ${s}: the long name is set no larger`);
  }
});

test("B5 the audience line can be left out of every layout", async () => {
  for (const treatment of LAYOUT_IDS) {
    const r = await renderComposite(browser, { images: photos(treatment, DARK), ...BASE, audience: null, treatment });
    assert.equal(r.ok, true, `${treatment}:\n${r.failures.join("\n")}`);
    assert.deepEqual(r.report.blocks.map((b) => b.block).sort(), ["duration", "location", "offer_name"]);
    // Dividers sit between the audience and the offer; with no audience they still have text on both sides.
    for (const g of r.report.groups) for (const d of g.dividers) assert.ok(d.contrast >= 3, `${treatment}: divider ${d.contrast}:1`);
  }
});

test("B6 text that cannot fit fails loudly in every layout, never clips", async () => {
  for (const treatment of LAYOUT_IDS) {
    const r = await renderComposite(browser, { images: photos(treatment, DARK), ...BASE, offer: "12 Week " + "Supercalifragilisticexpialidocious".repeat(2), treatment });
    assert.equal(r.ok, false, treatment);
    assert.match(r.failures.join(), /does not fit/, treatment);
  }
});

test("C1 T1: the stack ends on its region's bottom edge", async () => {
  for (const { r } of await allGrid(["t1-bottom-stack"])) {
    const R = r.report.groups[0].region, last = r.report.blocks.at(-1).layout_rect;
    assert.ok(Math.abs(bottomOf(last) - bottomOf(R)) <= 1, `bottom ${bottomOf(last).toFixed(1)} vs region ${bottomOf(R).toFixed(1)}`);
  }
});

test("C2 T2 and T5: callouts at the top, offer at the bottom, subject's middle band free of text", async () => {
  for (const { t, s, len, r, png } of await allGrid(["t2-top-bottom-split", "t5-offer-band"])) {
    const tag = `${t} / ${s} / ${len}`;
    for (const id of ["location", "audience"]) assert.ok(bottomOf(blk(r, id).rect) <= 1080 * 0.36, `${tag}: ${id} in the top band`);
    for (const id of ["duration", "offer_name"]) assert.ok(blk(r, id).rect.y >= 1080 * 0.55, `${tag}: ${id} in the bottom band`);
    const Z = r.report.clear_zones[0];
    assert.ok(Z.y <= 1080 * 0.37 && bottomOf(Z) >= 1080 * 0.54, `${tag}: the clear zone covers the middle`);
    assert.equal(painted(png, within(Z)), 0, `${tag}: text pixels in the middle band`);
  }
});

// The outermost inked column of a line, read from the PNG — independent of what the page reports.
const inkEdge = (png, k, side) => {
  let best = side === "right" ? -1 : Infinity;
  for (let y = Math.ceil(k.y); y < k.y + k.h; y++) for (let x = 0; x < png.w; x++) {
    const i = (y * png.w + x) * png.ch;
    if (Math.abs(png.px[i] - 0x20) + Math.abs(png.px[i + 1] - 0x20) + Math.abs(png.px[i + 2] - 0x20) > 60) best = side === "right" ? Math.max(best, x) : Math.min(best, x);
  }
  return best;
};

test("C3/C4 T3 and T6: a real column — edges aligned, the subject's side free of text", async () => {
  for (const { t, s, len, r, png } of await allGrid(["t3-right-column", "t6-left-column"])) {
    const tag = `${t} / ${s} / ${len}`, side = t.startsWith("t3") ? "right" : "left";
    const g = r.report.groups[0], R = g.region;
    assert.equal(g.align, side, `${tag}: the column is ${side}-aligned`);
    // Reported: every line's aligned edge on the group's inset line (±2px).
    const line = side === "right" ? R.x + R.w - g.inset : R.x + g.inset;
    for (const b of r.report.blocks) assert.ok(Math.abs(b.edge - line) <= 2, `${tag}: ${b.block} edge ${b.edge.toFixed(1)} vs ${line.toFixed(1)}`);
    // Measured: the letters themselves end within 16px of each other. (Letter shapes differ at the
    // edge — an "E" is square, an "N" slants in italic — measured at 1–13px for real columns vs
    // 35–92px when a column is wrongly centred. Script flourishes are excluded: they reach ~20px.)
    const ink = r.report.blocks.filter((b) => !b.script).map((b) => inkEdge(png, b.layout_rect, side));
    assert.ok(Math.max(...ink) - Math.min(...ink) <= 16, `${tag}: inked ${side} edges ${ink.join(", ")}`);
    const Z = r.report.clear_zones[0];
    assert.ok(side === "right" ? Z.x <= 54 && Z.x + Z.w >= 1080 * 0.45 : Z.x <= 1080 * 0.55 && Z.x + Z.w >= 1026, `${tag}: clear zone covers the subject's side`);
    assert.equal(painted(png, within(Z)), 0, `${tag}: text pixels on the subject's side`);
  }
});

test("C5 T4 and T7: every line centred (±2px) and the stack centred vertically", async () => {
  for (const { s, len, r } of await allGrid(["t4-centred-stack", "t7-collage"])) {
    const R = r.report.groups[0].region, mid = R.x + R.w / 2;
    for (const b of r.report.blocks) assert.ok(Math.abs(b.edge - mid) <= 2, `${s} / ${len}: ${b.block} centre ${b.edge.toFixed(1)} vs ${mid.toFixed(1)}`);
    const top = r.report.blocks[0].layout_rect.y - R.y, bottom = bottomOf(R) - bottomOf(r.report.blocks.at(-1).layout_rect);
    assert.ok(Math.abs(top - bottom) <= 2, `${s} / ${len}: space above ${top.toFixed(1)} vs below ${bottom.toFixed(1)}`);
  }
});

test("C6 T5: the offer name sits on a pill per line, inside its region, at 4.5:1 on every palette", async () => {
  for (const { s, len, r } of await allGrid(["t5-offer-band"])) {
    const off = blk(r, "offer_name"), g = r.report.groups.find((x) => x.id === off.group);
    assert.deepEqual(off.steps, ["layout-band"], `${s} / ${len}`);
    assert.equal(g.band.rects.length, off.lines, `${s} / ${len}: one pill per line`);
    assert.deepEqual(blk(r, "duration").steps.includes("layout-band"), false, "the duration sits on the photo, as in the references");
  }
  for (const palette of PALETTES) {
    const r = await renderComposite(browser, { image: STRIPES, ...BASE, treatment: "t5-offer-band", palette });
    assert.equal(r.ok, true, `${palette}:\n${r.failures.join("\n")}`);
    assert.ok(blk(r, "offer_name").contrast.after >= 4.5, `${palette}: ${blk(r, "offer_name").contrast.after}:1`);
  }
});

test("C9 dividers (T3, T4, T6, T7): between the audience and the offer, inside the region, never text", async () => {
  for (const { t, s, len, r } of await allGrid(["t3-right-column", "t4-centred-stack", "t6-left-column", "t7-collage"])) {
    const tag = `${t} / ${s} / ${len}`;
    const [d] = r.report.groups[0].dividers;
    assert.ok(d, `${tag}: divider drawn`);
    assert.ok(d.y >= bottomOf(blk(r, "audience").rect) && bottomOf(d) <= blk(r, "duration").rect.y, `${tag}: between audience and duration`);
    assert.ok(!r.report.blocks.some((b) => b.block === "divider"));
  }
  for (const t of ["t1-bottom-stack", "t2-top-bottom-split", "t5-offer-band", "t8-panels-band"]) {
    assert.equal(grid.get(`${t}|s1-heavy-sans|short`).r.report.groups.flatMap((g) => g.dividers).length, 0, `${t} has no divider`);
  }
});

test("D1/D2 pixels: nothing outside the text regions and nothing in a clear zone — every layout, style and length", async () => {
  for (const { t, s, len, r, png } of await allGrid()) {
    const tag = `${t} / ${s} / ${len}`;
    assert.equal(r.report.scrim.alpha, 0, `${tag}: no scrim on solid dark, so every painted pixel is text, band or divider`);
    assert.equal(painted(png, (x, y) => !r.report.groups.some((g) => within(g.region)(x, y))), 0, `${tag}: pixels outside the text regions`);
    for (const Z of r.report.clear_zones) assert.equal(painted(png, within(Z)), 0, `${tag}: pixels in clear zone "${Z.name}"`);
    assert.ok(painted(png, () => true) > 15000, `${tag}: text was painted`);
  }
});

test("D3 pixels: on a light photo each layout darkens the side its text is on", async () => {
  const W = 1080, H = 1080, e = 30;
  const shoot = async (treatment) => {
    const r = await renderComposite(browser, { image: LIGHT, ...BASE, treatment, palette: "white-on-dark" });
    assert.equal(r.ok, true, `${treatment}:\n${r.failures.join("\n")}`);
    return decodePNG(r.png);
  };
  const band = (p, y0, y1) => meanLum(p, 0, y0, W, y1), col = (p, x0, x1) => meanLum(p, x0, 0, x1, H);
  let p = await shoot("t1-bottom-stack");
  assert.ok(band(p, H - e, H) < band(p, 0, e) - 60, "T1 darker at the bottom");
  for (const t of ["t2-top-bottom-split", "t5-offer-band"]) {
    p = await shoot(t);
    const mid = band(p, H * 0.44, H * 0.46);
    assert.ok(band(p, 0, e) < mid - 60 && band(p, H - e, H) < mid - 60, `${t} darker at top and bottom than in the middle`);
  }
  p = await shoot("t3-right-column");
  assert.ok(col(p, W - e, W) < col(p, 0, e) - 60, "T3 darker on the right");
  p = await shoot("t6-left-column");
  assert.ok(col(p, 0, e) < col(p, W - e, W) - 60, "T6 darker on the left");
  p = await shoot("t4-centred-stack");
  const corners = [meanLum(p, 0, 0, e, e), meanLum(p, W - e, 0, W, e), meanLum(p, 0, H - e, e, H), meanLum(p, W - e, H - e, W, H)];
  assert.ok(Math.max(...corners) - Math.min(...corners) < 2 && corners[0] < 200, `T4 evenly darkened: ${corners.map((c) => c.toFixed(0))}`);
});

// ── Step 2c — multi-photo layouts: T7 collage, T8 panels + band ─────────────
const tile = (c) => svg(`<rect width="100%" height="100%" fill="${c}"/>`);
const TILE_HEX = ["#E53935", "#43A047", "#1E88E5", "#FDD835", "#8E24AA"];
const TILES = TILE_HEX.map(tile);
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const pixel = (png, x, y) => { const i = (Math.round(y) * png.w + Math.round(x)) * png.ch; return [png.px[i], png.px[i + 1], png.px[i + 2]]; };
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
// Points covered by nothing the text layer draws: no line's ink, band or divider.
const uncovered = (r, x, y) => {
  const inside = (k) => k && x >= k.x - 4 && x <= k.x + k.w + 4 && y >= k.y - 4 && y <= k.y + k.h + 4;
  return !r.report.blocks.some((b) => inside(b.rect) || inside(b.band)) && !r.report.groups.some((g) => g.dividers.some(inside) || (g.band?.rects || []).some(inside));
};

test("A5 multi-photo layouts refuse too few photos, before rendering, with a clear message", async () => {
  const t7 = await renderComposite(browser, { images: TILES.slice(0, 3), ...BASE, treatment: "t7-collage" });
  assert.equal(t7.ok, false);
  assert.equal(t7.png, undefined, "nothing rendered");
  assert.match(t7.failures.join(), /"t7-collage" needs 4 photos for its photo collage; 3 supplied/);
  const t8 = await renderComposite(browser, { image: DARK, ...BASE, treatment: "t8-panels-band" });
  assert.equal(t8.ok, false);
  assert.match(t8.failures.join(), /"t8-panels-band" needs 2 photos for its photo panels; 1 supplied/);
  assert.match(validateLayout({ ...LY("t7-collage").layouts["1x1"], background: { type: "collage", cols: 3, rows: 3, min_images: 3 } }).join(), /would repeat next to itself/);
  assert.match(validateLayout({ ...LY("t8-panels-band").layouts["1x1"], background: { ...LY("t8-panels-band").layouts["1x1"].background, panels: [{ shape: "circle", cx: 27, cy: 40, r: 20 }, { shape: "circle", cx: 73, cy: 53, r: 20 }] } }).join(), /panel 1 touches group "top"/);
});

test("C7 T7: 9 tiles filled from the photos in order, repeating, never beside or above the same photo", async () => {
  for (const n of [4, 5]) {
    const r = await renderComposite(browser, { images: TILES.slice(0, n), ...BASE, treatment: "t7-collage", palette: "white-on-dark" });
    assert.equal(r.ok, true, r.failures.join("\n"));
    const T = r.report.background.tiles;
    assert.equal(T.length, 9);
    assert.deepEqual(T.map((t) => t.image), [...Array(9).keys()].map((i) => i % n), `${n} photos, in order`);
    for (let i = 0; i < 9; i++) {
      if (i % 3 < 2) assert.notEqual(T[i].image, T[i + 1].image, `tile ${i} repeats beside`);
      if (i < 6) assert.notEqual(T[i].image, T[i + 3].image, `tile ${i} repeats below`);
    }
    // Every tile shows its own photo, in the pixels, wherever the text layer leaves it uncovered.
    // The even scrim darkens all of it by the same known amount.
    const png = decodePNG(r.png), A = r.report.scrim.alpha;
    let checked = 0;
    for (const t of T) {
      const want = rgbOf(TILE_HEX[t.image]).map((v) => v * (1 - A));
      const f = [0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.96]; // dense enough to find gaps between lines on the centre tile
      const pts = f.flatMap((fx) => f.map((fy) => [t.x + fx * t.w, t.y + fy * t.h])).filter(([x, y]) => uncovered(r, x, y));
      assert.ok(pts.length, `tile ${t.x},${t.y} has an uncovered point`);
      for (const [x, y] of pts) assert.ok(near(pixel(png, x, y), want), `tile at ${x.toFixed(0)},${y.toFixed(0)}: ${pixel(png, x, y)} vs ${want.map(Math.round)}`);
      checked++;
    }
    assert.equal(checked, 9);
  }
});

test("C8 T8: two round photo panels on a solid backdrop, clear of the text; the offer on a band at the bottom", async () => {
  for (const style of STYLES) {
    const r = await renderComposite(browser, { images: [TILES[0], TILES[2]], ...BASE, treatment: "t8-panels-band", style, palette: "yellow-accent" });
    assert.equal(r.ok, true, `${style}: ${r.failures.join("\n")}`);
    const png = decodePNG(r.png), bgd = r.report.background;
    assert.equal(bgd.type, "panels");
    assert.equal(r.report.scrim.alpha, 0, "a solid backdrop needs no scrim");
    const backdrop = rgbOf(bgd.backdrop);
    for (const [x, y] of [[3, 3], [1076, 3], [3, 1076], [1076, 1076]]) assert.ok(near(pixel(png, x, y), backdrop, 2), `${style}: corner ${x},${y} is the backdrop`);
    bgd.panels.forEach((p, i) => {
      assert.ok(p.cx - p.r >= 0 && p.cx + p.r <= 1080 && p.cy - p.r >= 0 && p.cy + p.r <= 1080, `panel ${i + 1} inside the canvas`);
      assert.ok(near(pixel(png, p.cx, p.cy), rgbOf(TILE_HEX[[0, 2][i]])), `${style}: panel ${i + 1} shows photo ${i + 1}`);
      // Inside the panel's square but outside its circle is backdrop: the panel really is round.
      const d = p.r * 0.92;
      assert.ok(near(pixel(png, p.cx - d, p.cy - d), backdrop, 2), `${style}: panel ${i + 1} is round`);
      for (const b of r.report.blocks) {
        const k = b.band || b.rect;
        assert.ok(k.x + k.w < p.cx - p.r || k.x > p.cx + p.r || k.y + k.h < p.cy - p.r || k.y > p.cy + p.r, `${style}: ${b.block} clear of panel ${i + 1}`);
      }
    });
    const bottom = r.report.groups.find((g) => g.id === "bottom");
    assert.equal(bottom.band.mode, "full");
    for (const id of ["duration", "offer_name"]) {
      const b = blk(r, id);
      assert.deepEqual(b.steps, ["layout-band"], `${style}: ${id} on the band`);
      assert.ok(b.contrast.after >= 4.5, `${style}: ${id} ${b.contrast.after}:1`);
      assert.ok(b.rect.y > bgd.panels[1].cy + bgd.panels[1].r, `${style}: ${id} below the panels`);
    }
  }
});

test("C8 verifier: a line set over a photo panel is caught", async () => {
  const r = await renderComposite(browser, { images: [TILES[0], TILES[2]], ...BASE, treatment: "t8-panels-band" });
  const spec = buildSpec({ images: [TILES[0], TILES[2]], text: TEXT, treatment: "t8-panels-band" });
  assert.equal(verifyReport(spec, r.report).length, 0);
  const rep = structuredClone(r.report);
  rep.blocks[0].rect.y = 500;
  assert.match(verifyReport(spec, rep).join(), /overlaps photo panel 1/);
});

// ══════════════════════════════════════════════════════════════════════════
// Step 3 — 9:16. Each layout is derived from its approved 1:1 layout into Meta's Stories/Reels
// safe area (top 14%, bottom 35%, 6% each side are covered by the app).
// ══════════════════════════════════════════════════════════════════════════
import { deriveLayout, layoutFor } from "./render-composites.mjs";

const TT = CAT.treatments;
const SAFE916 = TT.safe_area["9x16"];
const H916 = 1920;
const safeRect916 = { x: (SAFE916[0] / 100) * 1080, y: (SAFE916[1] / 100) * H916, w: (SAFE916[2] / 100) * 1080, h: (SAFE916[3] / 100) * H916 };
const grid916 = new Map();
const gridRender916 = async (treatment, style, len) => {
  const key = `${treatment}|${style}|${len}`;
  if (!grid916.has(key)) {
    const r = await renderComposite(browser, { images: photos(treatment, SOLID_BG), ...(len === "long" ? LONG_OFFER : BASE), treatment, style, palette: "white-on-dark", ratio: "9x16" });
    grid916.set(key, { r, png: r.ok ? decodePNG(r.png) : null });
  }
  return grid916.get(key);
};
const allGrid916 = async (layouts = LAYOUT_IDS) => {
  const out = [];
  for (const t of layouts) for (const s of STYLES) for (const len of ["short", "long"]) out.push({ t, s, len, ...(await gridRender916(t, s, len)) });
  return out;
};

test("G1 9:16: the safe area is Meta's (top 14%, bottom 35%, 6% each side); every derived layout passes validation against it", () => {
  assert.deepEqual(SAFE916, [6, 14, 88, 51]);
  assert.deepEqual(TT.safe_area["1x1"], [5, 5, 90, 90]);
  for (const id of LAYOUT_IDS) assert.deepEqual(validateLayout(layoutFor(LY(id), "9x16", TT), id, TT.canvas["9x16"], SAFE916), [], id);
  // A region in the covered area is refused before rendering.
  const bad = structuredClone(LY("t1-bottom-stack"));
  bad.layouts["9x16"] = { ...structuredClone(bad.layouts["1x1"]), groups: [{ ...structuredClone(bad.layouts["1x1"].groups[0]), region: [6, 40, 88, 40] }] };
  assert.throws(() => buildSpec({ image: DARK, text: TEXT, treatmentSpec: bad, ratio: "9x16" }), /crosses the safe area \(x 6–94%, y 14–65%\)/);
});

test("G2 9:16 derivation maps the approved 1:1 geometry exactly; an explicit 9:16 layout wins", () => {
  const sx = 88 / 90, sy = 51 / 90, X = (x) => 6 + (x - 5) * sx, Y = (y) => 14 + (y - 5) * sy;
  const close = (a, b, m) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${m}: ${a} vs ${b}`));
  const t1 = layoutFor(LY("t1-bottom-stack"), "9x16", TT);
  close(t1.groups[0].region, [X(6), Y(48), 88 * sx, 46 * sy], "T1 region");
  assert.ok(Math.abs(t1.groups[0].gap_pct - 0.9 * sy) < 1e-9 && Math.abs(t1.groups[0].scrim.fade_pct - 12 * sy) < 1e-9, "gaps and vertical fades scale down the canvas");
  const t3 = layoutFor(LY("t3-right-column"), "9x16", TT);
  close(t3.clear_zones[0].rect, [X(5), Y(5), 41 * sx, 90 * sy], "T3 clear zone");
  assert.ok(Math.abs(t3.groups[0].scrim.fade_pct - 8 * sx) < 1e-9, "a sideways fade scales across the canvas");
  const t8 = deriveLayout(LY("t8-panels-band").layouts["1x1"], "1x1", "9x16", TT);
  close([t8.background.panels[0].cx, t8.background.panels[0].cy, t8.background.panels[0].r], [X(27), Y(50), 20 * sx], "T8 panel");
  assert.equal(layoutFor(LY("t7-collage"), "9x16", TT).background.rows, 5, "collage rows scale to keep tiles near-square");
  // Only T8 carries a hand-tuned 9:16 layout (the derived one left most of the frame flat backdrop).
  assert.deepEqual(LAYOUT_IDS.filter((id) => LY(id).layouts["9x16"]), ["t8-panels-band"]);
  assert.equal(layoutFor(LY("t8-panels-band"), "9x16", TT), LY("t8-panels-band").layouts["9x16"], "the tuned layout is the one used");
  // …and its text sits exactly where the derived layout put it; only the circles and backdrop differ.
  assert.deepEqual(LY("t8-panels-band").layouts["9x16"].groups.map((g) => g.region), t8.groups.map((g) => g.region.map((v) => Math.round(v * 100) / 100)));
  const custom = structuredClone(LY("t1-bottom-stack"));
  custom.layouts["9x16"] = { ...structuredClone(custom.layouts["1x1"]), groups: [{ ...structuredClone(custom.layouts["1x1"].groups[0]), region: [10, 30, 80, 30] }] };
  assert.deepEqual(buildSpec({ image: DARK, text: TEXT, treatmentSpec: custom, ratio: "9x16" }).layout.groups[0].region, [10, 30, 80, 30]);
  assert.deepEqual(deriveLayout(LY("t1-bottom-stack").layouts["1x1"], "1x1", "1x1", TT).groups[0].region, [6, 48, 88, 46], "deriving to the same ratio changes nothing");
});

test(`G3 9:16: all ${LAYOUT_IDS.length * 90} layout × style × palette combinations build`, () => {
  for (const treatment of LAYOUT_IDS) for (const style of STYLES) for (const palette of PALETTES) {
    const spec = buildSpec({ images: photos(treatment, DARK), text: TEXT, treatment, style, palette, ratio: "9x16" });
    assert.deepEqual(spec.canvas, [1080, 1920]);
    assert.deepEqual(spec.safe_area, SAFE916);
  }
});

test("H1 gate — 9:16, every layout × style, short and long names: zero painted pixels outside Meta's safe area", async () => {
  for (const { t, s, len, r, png } of await allGrid916()) {
    const tag = `${t} / ${s} / ${len}`;
    assert.equal(r.ok, true, `${tag}:\n${r.failures.join("\n")}`);
    assert.deepEqual([png.w, png.h], [1080, 1920]);
    assert.equal(r.report.scrim.alpha, 0, `${tag}: no scrim on solid dark, so every painted pixel is text, band or divider`);
    assert.equal(painted(png, (x, y) => !within(safeRect916)(x, y)), 0, `${tag}: pixels in the area the app covers`);
    assert.equal(painted(png, (x, y) => !r.report.groups.some((g) => within(g.region)(x, y))), 0, `${tag}: pixels outside the text regions`);
    for (const Z of r.report.clear_zones) assert.equal(painted(png, within(Z)), 0, `${tag}: pixels in clear zone "${Z.name}"`);
    assert.ok(painted(png, () => true) > 15000, `${tag}: text was painted`);
  }
});

test("H2 9:16 text is not shrunk: every line is at least 90% of its 1:1 size", async () => {
  let worst = 1;
  for (const { t, s, len, r } of await allGrid916()) {
    const one = (await gridRender(t, s, len)).r;
    for (const b of r.report.blocks) {
      const k = b.size / blk(one, b.block).size;
      worst = Math.min(worst, k);
      assert.ok(k >= 0.9, `${t} / ${s} / ${len}: ${b.block} ${b.size}px in 9:16 vs ${blk(one, b.block).size}px in 1:1`);
    }
  }
  assert.ok(worst < 1.01, `sizes compared (worst ratio ${worst.toFixed(3)})`);
});

test("H3 9:16 contrast: every layout on dark, light and stripes; every palette", async () => {
  for (const [li, treatment] of LAYOUT_IDS.entries()) for (const [bi, [bg, image]] of Object.entries({ DARK, LIGHT, STRIPES }).entries()) {
    const palette = PALETTES[(li * 3 + bi) % PALETTES.length];
    const r = await renderComposite(browser, { images: photos(treatment, image), ...BASE, treatment, palette, ratio: "9x16" });
    assert.equal(r.ok, true, `${treatment} / ${bg} / ${palette}:\n${r.failures.join("\n")}`);
  }
  for (const [pi, palette] of PALETTES.entries()) {
    const treatment = LAYOUT_IDS[pi % LAYOUT_IDS.length];
    const r = await renderComposite(browser, { images: photos(treatment, STRIPES), ...BASE, treatment, palette, ratio: "9x16" });
    assert.equal(r.ok, true, `${treatment} / STRIPES / ${palette}:\n${r.failures.join("\n")}`);
  }
});

test("H4 9:16 keeps each layout's shape: anchoring, columns, centring, pills, dividers, collage and panels", async () => {
  for (const { t, s, len, r, png } of await allGrid916()) {
    const tag = `${t} / ${s} / ${len}`, g0 = r.report.groups[0], R = g0.region;
    if (t === "t1-bottom-stack") assert.ok(Math.abs(bottomOf(r.report.blocks.at(-1).layout_rect) - bottomOf(R)) <= 1, `${tag}: bottom-anchored`);
    if (t === "t2-top-bottom-split" || t === "t5-offer-band") {
      const Z = r.report.clear_zones[0];
      for (const id of ["location", "audience"]) assert.ok(bottomOf(blk(r, id).rect) <= Z.y, `${tag}: ${id} above the subject's space`);
      for (const id of ["duration", "offer_name"]) assert.ok(blk(r, id).rect.y >= bottomOf(Z), `${tag}: ${id} below it`);
    }
    if (t === "t3-right-column" || t === "t6-left-column") {
      const side = t.startsWith("t3") ? "right" : "left", line = side === "right" ? R.x + R.w - g0.inset : R.x + g0.inset;
      for (const b of r.report.blocks) assert.ok(Math.abs(b.edge - line) <= 2, `${tag}: ${b.block} edge`);
      const ink = r.report.blocks.filter((b) => !b.script).map((b) => inkEdge(png, b.layout_rect, side));
      assert.ok(Math.max(...ink) - Math.min(...ink) <= 16, `${tag}: inked ${side} edges ${ink.join(", ")}`);
    }
    if (t === "t4-centred-stack" || t === "t7-collage") {
      const mid = R.x + R.w / 2;
      for (const b of r.report.blocks) assert.ok(Math.abs(b.edge - mid) <= 2, `${tag}: ${b.block} centred`);
      const top = r.report.blocks[0].layout_rect.y - R.y, bottom = bottomOf(R) - bottomOf(r.report.blocks.at(-1).layout_rect);
      assert.ok(Math.abs(top - bottom) <= 2, `${tag}: vertically centred`);
    }
    if (t === "t5-offer-band") assert.equal(r.report.groups.find((g) => g.id === blk(r, "offer_name").group).band.rects.length, blk(r, "offer_name").lines, `${tag}: a pill per line`);
    if (["t3-right-column", "t4-centred-stack", "t6-left-column", "t7-collage"].includes(t)) {
      const [d] = g0.dividers;
      assert.ok(d && d.y >= bottomOf(blk(r, "audience").rect) && bottomOf(d) <= blk(r, "duration").rect.y, `${tag}: divider between audience and duration`);
    }
  }
  // Collage: 3 × 5 tiles cover the whole tall canvas.
  const c = await renderComposite(browser, { images: TILES.slice(0, 4), ...BASE, treatment: "t7-collage", palette: "white-on-dark", ratio: "9x16" });
  assert.equal(c.ok, true, c.failures.join("\n"));
  const T = c.report.background.tiles;
  assert.equal(T.length, 15);
  assert.ok(Math.abs(T.at(-1).x + T.at(-1).w - 1080) < 1e-6 && Math.abs(T.at(-1).y + T.at(-1).h - 1920) < 1e-6, "tiles reach the canvas corner");
  // Panels: round, showing their photos, clear of the text, inside the safe area — on a backdrop of
  // the first photo, blurred and dimmed toward the charcoal (a solid tile blurs to itself, so the
  // expected colour is exact).
  const p = await renderComposite(browser, { images: [TILES[0], TILES[2]], ...BASE, treatment: "t8-panels-band", palette: "yellow-accent", ratio: "9x16" });
  assert.equal(p.ok, true, p.failures.join("\n"));
  const png = decodePNG(p.png), bp = p.report.background.backdrop_photo;
  const dimmed = rgbOf(TILE_HEX[0]).map((v, i) => v * (1 - bp.darken) + rgbOf(p.report.background.backdrop)[i] * bp.darken);
  for (const [x, y] of [[3, 3], [1076, 3], [3, 1916], [1076, 1916], [540, 1700]]) assert.ok(near(pixel(png, x, y), dimmed, 3), `backdrop at ${x},${y}: ${pixel(png, x, y)} vs ${dimmed.map(Math.round)}`);
  p.report.background.panels.forEach((pn, i) => {
    assert.ok(near(pixel(png, pn.cx, pn.cy), rgbOf(TILE_HEX[[0, 2][i]])), `panel ${i + 1} shows its photo`);
    assert.ok(near(pixel(png, pn.cx - pn.r * 0.92, pn.cy - pn.r * 0.92), dimmed, 3), `panel ${i + 1} is round`);
    assert.ok(within(safeRect916)(pn.cx - pn.r, pn.cy - pn.r) && within(safeRect916)(pn.cx + pn.r - 1, pn.cy + pn.r - 1), `panel ${i + 1} inside the safe area`);
  });
});

test("H5 9:16 verifier: a line in the top 14%, the bottom 35% or a side 6% is caught", async () => {
  const r = await renderComposite(browser, { image: DARK, ...BASE, ratio: "9x16" });
  assert.equal(r.ok, true, r.failures.join("\n"));
  const spec = buildSpec({ image: DARK, text: TEXT, ratio: "9x16" });
  assert.equal(verifyReport(spec, r.report).length, 0, "the untampered report passes");
  const tamper = (fn) => { const rep = structuredClone(r.report); fn(rep.blocks[0].rect); return verifyReport(spec, rep).join("\n"); };
  const msg = /"location" leaves the 9x16 safe area \(x 6–94%, y 14–65%\): the app covers the rest/;
  assert.match(tamper((k) => { k.y = 0.08 * H916; }), msg);
  assert.match(tamper((k) => { k.y = 0.70 * H916; }), msg);
  assert.match(tamper((k) => { k.x = 0.02 * 1080; }), msg);
});

test("H7 9:16 T8 fills the frame: no flat backdrop left in the areas the app covers (1:1 keeps its plain backdrop)", async () => {
  const flat = (png, hex) => { const c = rgbOf(hex); let n = 0; for (let y = 0; y < png.h; y += 2) for (let x = 0; x < png.w; x += 2) if (near(pixel(png, x, y), c, 2)) n++; return n / ((png.w / 2) * (png.h / 2)); };
  const photosIn = [svg(`<rect width="50%" height="100%" fill="#E53935"/><rect x="50%" width="50%" height="100%" fill="#1E88E5"/>`), TILES[1]];
  const tall = await renderComposite(browser, { images: photosIn, ...BASE, treatment: "t8-panels-band", palette: "white-on-dark", ratio: "9x16" });
  const sq = await renderComposite(browser, { images: photosIn, ...BASE, treatment: "t8-panels-band", palette: "white-on-dark" });
  assert.ok(tall.ok && sq.ok, [...tall.failures, ...sq.failures].join("\n"));
  const tallFlat = flat(decodePNG(tall.png), tall.report.background.backdrop), sqFlat = flat(decodePNG(sq.png), sq.report.background.backdrop);
  assert.ok(tallFlat < 0.02, `9:16: ${(100 * tallFlat).toFixed(1)}% of the frame is flat backdrop`);
  assert.ok(sqFlat > 0.4, `1:1 keeps the approved plain backdrop (${(100 * sqFlat).toFixed(0)}% flat)`);
});

// ══════════════════════════════════════════════════════════════════════════
// Step 4 — faces. The visual check boxes every face; the renderer treats them as keep-out areas,
// so a finished ad fails if any letter, band or divider covers one.
// ══════════════════════════════════════════════════════════════════════════
const SQUARE_DARK = svg(`<rect width="100%" height="100%" fill="#1C1C1C"/>`, 1000, 1000);

test("R1 faces are mapped through the same crop the photo is drawn with (1:1 and a 9:16 crop of a square photo)", async () => {
  const face = [100, 400, 200, 500]; // ymin, xmin, ymax, xmax on 0–1000; zones add 4% room each side
  const one = await renderComposite(browser, { image: SQUARE_DARK, faces: [[face]], ...BASE });
  assert.equal(one.ok, true, one.failures.join("\n"));
  const [z] = one.report.face_zones, k = 1.08; // 1000 → 1080
  for (const [got, want] of [[z.x, 400 * k - 4.32], [z.y, 100 * k - 4.32], [z.w, 108 + 8.64], [z.h, 108 + 8.64]]) assert.ok(Math.abs(got - want) < 0.01, `1:1 ${got} vs ${want}`);
  const tall = await renderComposite(browser, { image: SQUARE_DARK, faces: [[face]], ...BASE, ratio: "9x16" });
  assert.equal(tall.ok, true, tall.failures.join("\n"));
  const [t] = tall.report.face_zones; // cover: 1000 → 1920 square, centred: x offset −420
  for (const [got, want] of [[t.x, -420 + 768 - 7.68], [t.y, 192 - 7.68], [t.w, 192 + 15.36], [t.h, 192 + 15.36]]) assert.ok(Math.abs(got - want) < 0.01, `9:16 ${got} vs ${want}`);
  assert.throws(() => buildSpec({ image: DARK, text: TEXT, faces: [[[1, 2, 3]]] }), /faces must be a list per photo/);
});

test("R2 a letter on a face fails the ad; the same face in the subject's space passes", async () => {
  const low = await renderComposite(browser, { image: SQUARE_DARK, faces: [[[620, 420, 720, 580]]], ...BASE });
  assert.equal(low.ok, false, "T1's text runs across the lower half");
  assert.match(low.failures.join(), /covers a face \(face 1\)/);
  const high = await renderComposite(browser, { image: SQUARE_DARK, faces: [[[150, 420, 250, 580]]], ...BASE });
  assert.equal(high.ok, true, high.failures.join("\n"));
  // The same low face is fine on a layout whose text sits elsewhere — a right column over a face on the left.
  const col = await renderComposite(browser, { image: SQUARE_DARK, faces: [[[620, 100, 720, 260]]], ...BASE, treatment: "t3-right-column" });
  assert.equal(col.ok, true, col.failures.join("\n"));
  // The verifier checks bands and dividers against faces too.
  const spec = buildSpec({ image: SQUARE_DARK, text: TEXT, treatment: "t3-right-column" });
  const rep = structuredClone(col.report);
  const d = rep.groups[0].dividers[0];
  rep.face_zones = [{ name: "face 1", x: d.x + 2, y: d.y - 10, w: 40, h: 40 }];
  assert.match(verifyReport(spec, rep).join(), /divider covers a face/);
});

test("R3 panel photos carry their faces into their circles; collage tiles are exempt", async () => {
  const p = await renderComposite(browser, { images: [TILES[0], TILES[2]], faces: [[[300, 400, 500, 600]], []], ...BASE, treatment: "t8-panels-band" });
  assert.equal(p.ok, true, p.failures.join("\n"));
  const [z] = p.report.face_zones, [pn] = p.report.background.panels;
  assert.ok(z.x > pn.cx - pn.r && z.x + z.w < pn.cx + pn.r && z.y > pn.cy - pn.r && z.y + z.h < pn.cy + pn.r, "the face lands inside its panel");
  const c = await renderComposite(browser, { images: TILES.slice(0, 4), faces: [[[400, 400, 600, 600]], [], [], []], ...BASE, treatment: "t7-collage" });
  assert.equal(c.ok, true, c.failures.join("\n"));
  assert.deepEqual(c.report.face_zones, [], "text over a busy collage is that layout's design");
});

test("R4 each line's reported letter band holds every lit pixel of its letters — checked in the PNG, all 9 styles", async () => {
  // Faces are judged against these bands, so a band that missed any ink would let a letter onto a face.
  for (const style of STYLES) {
    const r = await renderComposite(browser, { image: SOLID_BG, ...BASE, style, palette: "white-on-dark" });
    assert.equal(r.ok, true, `${style}: ${r.failures.join(" | ")}`);
    const png = decodePNG(r.png);
    for (const b of r.report.blocks) {
      assert.equal(b.ink_lines.length, b.lines, `${style} ${b.block}: one band per line`);
      const L = b.layout_rect;
      let outside = 0, lit = 0;
      for (let y = Math.floor(L.y) - 20; y < L.y + L.h + 20; y++) for (let x = Math.floor(L.x); x < L.x + L.w; x++) {
        if (y < 0 || y >= png.h) continue;
        const i = (y * png.w + x) * png.ch;
        if (png.px[i] + png.px[i + 1] + png.px[i + 2] < 3 * 200) continue; // white letters only (the dark outline and shadow do not show on dark)
        // The scan reaches past this line's box to catch overflowing ink; pixels in a neighbouring line's box are that line's.
        if (r.report.blocks.some((o) => o !== b && x >= o.layout_rect.x && x <= o.layout_rect.x + o.layout_rect.w && y >= o.layout_rect.y && y <= o.layout_rect.y + o.layout_rect.h)) continue;
        lit++;
        if (!b.ink_lines.some((k) => x >= k.x - 1 && x <= k.x + k.w + 1 && y >= k.y - 1 && y <= k.y + k.h + 1)) outside++;
      }
      assert.ok(lit > 300, `${style} ${b.block}: letters found`);
      assert.equal(outside, 0, `${style} ${b.block}: ${outside} lit pixels outside the reported letter band`);
    }
  }
  // And the band is the letters, not the line box: capitals leave the box's descender space empty.
  const r = await renderComposite(browser, { image: SOLID_BG, ...BASE, palette: "white-on-dark" });
  const loc = r.report.blocks.find((b) => b.block === "location");
  assert.ok(loc.ink_lines[0].y + loc.ink_lines[0].h < loc.layout_rect.y + loc.layout_rect.h - 0.1 * loc.size, "the band stops well above the bottom of the line box");
});
