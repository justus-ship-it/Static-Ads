/**
 * Tests for assign-variants.mjs (the variety planner: which look each ad in a batch gets).
 *
 *   node --test skills/references/assign-variants.test.mjs
 *
 * F1–F7 are pure planning checks (no browser) except where photos are measured; F8 renders a
 * whole planned batch. Synthetic SVG photos only — no client photos, no network.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, loadCatalogue } from "./render-composites.mjs";
import { assignVariants, rankPalettes, measurePhotos, renderPlan, excludeFromProfile, COLOURED } from "./assign-variants.mjs";
import { loadClientConfig } from "./client-config.mjs";

const CAT = loadCatalogue();
const P = CAT.palettes.palettes;
const TEXT = { location: "BISHAN", audience: "LADIES WANTED" };
const OFFER = "12 Week Confidence Comeback Challenge";
const vis = (n) => Array.from({ length: n }, (_, i) => ({ id: `v${String(i + 1).padStart(2, "0")}` }));
const SHAPES = [[6, 4], [2, 4], [3, 4], [4, 4], [9, 1], [6, 5], [8, 8]];
const SEEDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const plans = function* () { for (const [n, k] of SHAPES) for (const seed of SEEDS) yield { n, k, seed, plan: assignVariants({ visuals: vis(n), perVisual: k, text: TEXT, seed }) }; };
const look = (c) => `${c.treatment}|${c.style}|${c.palette}`;
const byPhoto = (plan) => Object.values(Object.groupBy(plan.candidates, (c) => c.visual));

const svg = (body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000">${body}</svg>`).toString("base64");
const solid = (c) => svg(`<rect width="100%" height="100%" fill="${c}"/>`);
const RED = { hue: 2, strength: 0.6 }, NEUTRAL = { hue: 40, strength: 0.05 };
const statsOf = (s) => ({ overall: s, layouts: Object.fromEntries(Object.keys(CAT.treatments.treatments).map((k) => [k, s])) });

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test("F1 no two ads in a batch share the same layout + style + palette", () => {
  for (const { n, k, seed, plan } of plans()) {
    assert.equal(plan.candidates.length, n * k);
    assert.equal(new Set(plan.candidates.map(look)).size, n * k, `${n}x${k} seed ${seed}`);
  }
});

test("F2 ads on the same photo never repeat a layout, a style or a palette", () => {
  for (const { n, k, seed, plan } of plans()) for (const cs of byPhoto(plan)) {
    assert.equal(cs.length, k);
    for (const key of ["treatment", "style", "palette"]) assert.equal(new Set(cs.map((c) => c[key])).size, k, `${n}x${k} seed ${seed}: ${cs[0].visual} repeats a ${key}`);
  }
});

test("F3 layouts, styles and palettes are each used evenly (±1) across the batch", () => {
  for (const { n, k, seed, plan } of plans()) {
    for (const [axis, key] of [["L", "treatment"], ["S", "style"], ["P", "palette"]]) {
      const pool = plan.pools[{ L: "layouts", S: "styles", P: "palettes" }[axis]];
      const used = Object.fromEntries(pool.map((id) => [id, plan.candidates.filter((c) => c[key] === id).length]));
      const v = Object.values(used);
      assert.ok(Math.max(...v) - Math.min(...v) <= 1, `${n}x${k} seed ${seed}: ${key} uses ${JSON.stringify(used)}`);
    }
  }
  // The headline batch: 6 photos × 4 looks = 24 ads → each of 8 layouts 3 times.
  const p = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed: "x" });
  assert.deepEqual([...new Set(Object.values(p.counts.L))], [3]);
});

test("F4 the same seed gives the same batch; a new seed gives a different one", () => {
  const a = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed: "2026-09-10" });
  const b = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed: "2026-09-10" });
  assert.deepEqual(a.candidates, b.candidates);
  const looks = new Set(SEEDS.map((seed) => assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed }).candidates.map(look).join()));
  assert.equal(looks.size, SEEDS.length, "every seed gives its own batch");
});

test("F5 a client's excluded layouts, styles and palettes are never used", () => {
  const exclude = { layouts: ["t8-panels-band"], styles: ["s8-script-accent", "s6-serif-display"], palettes: ["red-white", "yellow-accent"] };
  for (const seed of SEEDS) {
    const p = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed, exclude });
    for (const c of p.candidates) {
      assert.ok(!exclude.layouts.includes(c.treatment) && !exclude.styles.includes(c.style) && !exclude.palettes.includes(c.palette), `${seed}: ${look(c)}`);
    }
  }
  assert.throws(() => assignVariants({ visuals: vis(2), perVisual: 2, text: TEXT, exclude: { styles: ["s99-nope"] } }), /exclude.styles names "s99-nope"/);
  const allButThree = Object.keys(P).slice(3);
  assert.throws(() => assignVariants({ visuals: vis(2), perVisual: 4, text: TEXT, exclude: { palettes: allButThree } }), /4 looks per photo need 4 different palettes, but only 3/);
  assert.deepEqual(excludeFromProfile({ exclude_styles: ["s8-script-accent"] }), { layouts: [], styles: ["s8-script-accent"], palettes: [] });
});

test("F5 gym-profile.json: an exclude list naming an unknown look is a config error", () => {
  const root = mkdtempSync(join(tmpdir(), "av-cfg-"));
  try {
    mkdirSync(join(root, "brands", "g", "offers"), { recursive: true });
    writeFileSync(join(root, "brands", "g", "gym-profile.json"), JSON.stringify({ creative: { exclude_palettes: ["red-white", "neon-ghost"], exclude_styles: "s1-heavy-sans" } }));
    writeFileSync(join(root, "brands", "g", "offers", "o.json"), JSON.stringify({}));
    const { errors, resolved } = loadClientConfig("g", "o", { root });
    assert.ok(errors.some((e) => /creative.exclude_palettes names "neon-ghost"/.test(e)), errors.join("\n"));
    assert.ok(errors.some((e) => /creative.exclude_styles must be a list/.test(e)));
    assert.ok(!errors.some((e) => /"red-white"/.test(e)), "known ids are fine");
    assert.deepEqual(resolved.creative.exclude_palettes, ["red-white", "neon-ghost"], "the resolved brief carries the creative block");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("F6 only renderable picks: no script without a short audience line, no collage or panels without enough photos", () => {
  const script = "s8-script-accent";
  for (const seed of SEEDS) {
    assert.ok(!assignVariants({ visuals: vis(6), perVisual: 4, text: { location: "BISHAN" }, seed }).candidates.some((c) => c.style === script), "no audience → no script");
    assert.ok(!assignVariants({ visuals: vis(6), perVisual: 4, text: { location: "BISHAN", audience: "LADIES AND GENTLEMEN WANTED" }, seed }).candidates.some((c) => c.style === script), "audience over 24 characters → no script");
    const three = assignVariants({ visuals: vis(3), perVisual: 4, text: TEXT, seed });
    assert.ok(!three.candidates.some((c) => c.treatment === "t7-collage"), "3 photos → no collage");
    assert.ok(three.notes.some((x) => /t7-collage left out: it needs 4 photos and the batch has 3/.test(x)));
    const one = assignVariants({ visuals: vis(1), perVisual: 4, text: TEXT, seed });
    assert.ok(!one.candidates.some((c) => ["t7-collage", "t8-panels-band"].includes(c.treatment)), "1 photo → neither");
  }
  // When they are used, a collage gets 4 of the batch's photos and panels get 2, starting with its own.
  const p = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed: "a" });
  for (const c of p.candidates) {
    const want = { "t7-collage": 4, "t8-panels-band": 2 }[c.treatment] || 1;
    assert.equal(c.images.length, want, `${c.id} ${c.treatment}`);
    assert.equal(c.images[0], c.visual);
    assert.equal(new Set(c.images).size, want, "no photo twice in one ad");
  }
  assert.ok(p.candidates.some((c) => c.treatment === "t7-collage") && p.candidates.some((c) => c.treatment === "t8-panels-band"));
});

test("F7 colour suits the photo: on red, red and pink palettes rank below cyan, green and blue", () => {
  const rank = rankPalettes(RED, P), pos = (id) => rank.findIndex((r) => r.id === id);
  for (const warm of ["red-white", "red-pink", "pink-white"]) for (const cool of ["cyan-white", "green-white", "blue-white"]) {
    assert.ok(pos(warm) > pos(cool), `${warm} should rank below ${cool}`);
  }
  assert.deepEqual(rank.filter((r) => r.clash).map((r) => r.id).sort(), ["pink-white", "red-pink", "red-white"]);
  assert.ok(rankPalettes(NEUTRAL, P).every((r) => r.score === 1 && !r.clash), "a neutral patch suits every palette");
  // In a batch: the red photo never gets a clashing palette; neutral photos still can.
  for (const seed of SEEDS) {
    const stats = [statsOf(RED), statsOf(NEUTRAL), statsOf(NEUTRAL), statsOf(NEUTRAL), statsOf(NEUTRAL), statsOf(NEUTRAL)];
    const p = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed, photoStats: stats });
    for (const c of p.candidates.filter((x) => x.visual === "v01" && x.treatment !== "t8-panels-band")) {
      assert.ok(!["red-white", "red-pink", "pink-white"].includes(c.palette), `${seed}: ${c.id} puts ${c.palette} on the red photo`);
    }
    assert.ok(p.candidates.some((c) => ["red-white", "red-pink", "pink-white"].includes(c.palette)), "red palettes are still used, elsewhere");
  }
  // A collage is judged on all its photos: a neutral first photo followed by three red ones is red.
  for (const seed of SEEDS) {
    const p = assignVariants({ visuals: vis(4), perVisual: 4, text: TEXT, seed, photoStats: [statsOf(NEUTRAL), statsOf(RED), statsOf(RED), statsOf(RED)] });
    for (const c of p.candidates.filter((x) => x.treatment === "t7-collage")) assert.equal(c.palette_fit.clash, false, `${seed}: ${c.id} collage on ${c.palette}`);
  }
});

test("F7 measuring photos: a red photo reads as red and coloured, cream and dark as neutral", async () => {
  const [red, cream, dark, split] = await measurePhotos(browser, [solid("#E53935"), solid("#EFE8DA"), solid("#1C1C1C"),
    svg(`<rect width="100%" height="50%" fill="#1E88E5"/><rect y="50%" width="100%" height="50%" fill="#E53935"/>`)]);
  assert.ok(red.overall.strength > COLOURED && Math.min(red.overall.hue, 360 - red.overall.hue) < 10, JSON.stringify(red.overall));
  assert.ok(cream.overall.strength < COLOURED && dark.overall.strength < COLOURED);
  // Measured under each layout's text: blue on top, red below → T1 (bottom) is red, T2's top+bottom is mixed.
  const t1 = split.layouts["t1-bottom-stack"];
  assert.ok(t1.strength > COLOURED && Math.min(t1.hue, 360 - t1.hue) < 15, `T1 area ${JSON.stringify(t1)}`);
  assert.equal(split.layouts["t8-panels-band"], undefined, "panels sit on a backdrop, so they are not measured");
});

test("F8 every ad the planner produces renders and verifies", async () => {
  const photos = { v01: solid("#1C1C1C"), v02: solid("#EFE8DA"), v03: solid("#1E88E5"), v04: solid("#43A047"), v05: solid("#E53935"),
    v06: svg(`<defs><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><rect width="40" height="80" fill="#fff"/><rect x="40" width="40" height="80" fill="#000"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/>`) };
  const stats = await measurePhotos(browser, Object.values(photos));
  const plan = assignVariants({ visuals: vis(6), perVisual: 4, text: TEXT, seed: "f8", photoStats: stats });
  const out = await renderPlan(browser, plan, { text: { ...TEXT, offer: OFFER }, imageFor: (id) => photos[id] });
  assert.equal(out.length, 24);
  for (const c of out) {
    assert.ok(!c.failed, `${c.id} ${look(c)}: ${c.failed?.join(" | ")}`);
    assert.equal(c.r.ok, true);
    assert.equal(c.replaced, undefined, `${c.id} needed a replacement: ${c.replaced?.reason}`);
  }
});

test("F8 a look that only fails once rendered is replaced by a valid one, and the swap is recorded", async () => {
  // A long location in a narrow column pulls a script audience under its size floor (found in 2a).
  const text = { location: "BISHAN AND UPPER THOMSON", audience: "LADIES WANTED", offer: OFFER };
  const plan = assignVariants({ visuals: vis(2), perVisual: 2, text, seed: "swap" });
  plan.candidates[0] = { ...plan.candidates[0], treatment: "t6-left-column", style: "s8-script-accent", palette: plan.candidates[0].palette, images: [plan.candidates[0].visual] };
  const onPhoto = plan.candidates.filter((c) => c.visual === plan.candidates[0].visual);
  const out = await renderPlan(browser, plan, { text, imageFor: () => solid("#1C1C1C") });
  const c = out[0];
  assert.ok(!c.failed, c.failed?.join(" | "));
  assert.equal(c.r.ok, true);
  assert.deepEqual(c.replaced.from, { treatment: "t6-left-column", style: "s8-script-accent", palette: plan.candidates[0].palette });
  assert.match(c.replaced.reason, /script is \d+px, below the 52px legibility floor/);
  assert.equal(new Set(out.map(look)).size, out.length, "the replacement is still unique in the batch");
  for (const key of ["treatment", "style", "palette"]) assert.equal(new Set(out.filter((x) => x.visual === c.visual).map((x) => x[key])).size, onPhoto.length, `still no repeated ${key} on the photo`);
});

test("F7 colour behind part of the text counts: a red band behind one line clashes even when the average is weak", async () => {
  // Grey photo with a red band across the top of T1's text area only (48–56% of the height):
  // averaged over the whole area it is under the colour threshold, but it sits behind a line.
  const [p] = await measurePhotos(browser, [svg(`<rect width="100%" height="100%" fill="#8A8A8A"/><rect y="48%" width="100%" height="8%" fill="#E53935"/>`)]);
  const t1 = p.layouts["t1-bottom-stack"];
  assert.ok(t1.strength < COLOURED, `averaged, the area reads as neutral (${t1.strength})`);
  const rank = rankPalettes(t1, P);
  assert.deepEqual(rank.filter((r) => r.clash).map((r) => r.id).sort(), ["pink-white", "red-pink", "red-white"], JSON.stringify(rank));
  // T2's text is at the very top and bottom, away from the band: no clash there.
  assert.ok(rankPalettes(p.layouts["t2-top-bottom-split"], P).every((r) => !r.clash));
});

test("F9 a look whose letters would cover a face is swapped for one that leaves the face clear", async () => {
  const photo = "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="#1C1C1C"/></svg>`).toString("base64");
  const text = { ...TEXT, offer: OFFER };
  const plan = assignVariants({ visuals: vis(1), perVisual: 1, text, seed: "face" });
  plan.candidates[0] = { ...plan.candidates[0], treatment: "t1-bottom-stack", images: ["v01"] };
  const face = [[500, 420, 580, 580]]; // under T1's first line, but in the gap T2 leaves between its text groups
  const [c] = await renderPlan(browser, plan, { text, imageFor: () => photo, facesFor: () => face });
  assert.ok(!c.failed, c.failed?.join(" | "));
  assert.equal(c.r.ok, true);
  assert.match(c.replaced.reason, /covers a face/);
  assert.notEqual(c.treatment, "t1-bottom-stack");
  assert.ok(c.r.report.face_zones.length === 1, "the face was still a keep-out in the replacement");
});
