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
