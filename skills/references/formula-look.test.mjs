/**
 * Tests for Phase 2 of the formats plan (2026-11-10): the 4:5 feed shape, the formula look as its own catalogue
 * family, the plain text effect, the floating text block and the brightness-matched pairings.
 *
 *   node --test skills/references/formula-look.test.mjs
 *
 * Rendering runs for real in Chrome on synthetic photos; nothing reaches a model.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, loadCatalogue, renderComposite, validateLayout, layoutFor, floatRegion, placedRegions, LOOKS } from "./render-composites.mjs";
import { judgeVisual, fitLayouts, floatedAreaBoxes, textAreaBoxes } from "./check-visual.mjs";
import { assignVariants, lumFit, WEAK_NATURAL, GENTLE_SCRIM } from "./assign-variants.mjs";
import { catalogueFor, validateProfile, PROFILE_STARTER, FEED_RATIOS, CREATIVE_DEFAULTS } from "./client-config.mjs";
import { buildVisualPrompt } from "./visual-prompts.mjs";
import { storiesFile, cropWindow } from "./make-stories.mjs";

const svg = (w, h, body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
const DARK = svg(1080, 1350, `<rect width="100%" height="100%" fill="#2e3238"/><rect x="380" y="330" width="320" height="900" fill="#3d444d"/>`);
const DARK_916 = svg(1080, 1920, `<rect width="100%" height="100%" fill="#2e3238"/><rect x="380" y="560" width="320" height="1200" fill="#3d444d"/>`);
const WORDS = { location: "JURONG WEST", audience: null, offer: "42 Day Beginner's Body Reset" };
const FORMULA = loadCatalogue({ look: "formula" }), REF = loadCatalogue();

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test("F1 two families, one catalogue: a batch's loops see its own family only, a lookup by id finds either; the formula's three layouts are valid at 1:1, 4:5 and 9:16 with a floating callout and block, plain type and the callout as the lead line; 4:5 is a canvas with a 5% margin; a gym's look and feed shape are Ad defaults", () => {
  assert.deepEqual(LOOKS, ["reference", "formula"]);
  assert.deepEqual([Object.keys(REF.treatments.treatments).length, Object.keys(REF.styles.styles).length, Object.keys(REF.palettes.palettes).length, REF.look], [8, 9, 10, "reference"], "the reference set is what it was");
  assert.deepEqual([Object.keys(FORMULA.treatments.treatments), Object.keys(FORMULA.styles.styles), Object.keys(FORMULA.palettes.palettes).length, FORMULA.look], [["f1-callout-left", "f2-callout-centre", "f3-offer-card"], ["fs1-heavy-italic", "fs2-condensed", "fs3-tall-sans"], 12, "formula"]);
  assert.ok(REF.treatments.treatments["f1-callout-left"] && REF.styles.styles["fs1-heavy-italic"] && REF.palettes.palettes["f-cream"], "the reference catalogue still answers for a formula id");
  assert.ok(FORMULA.treatments.treatments["t1-bottom-stack"] && FORMULA.styles.styles["s1-heavy-sans"] && FORMULA.palettes.palettes["white-on-dark"], "and the formula catalogue for a reference id (the checks render with a fixed reference look)");
  assert.ok(!("f1-callout-left" in { ...REF.treatments.treatments }), "a spread or a clone carries the family alone");
  assert.throws(() => loadCatalogue({ look: "loud" }), /unknown look "loud"/);
  const T = FORMULA.treatments;
  assert.deepEqual([T.canvas["4x5"], T.safe_area["4x5"]], [[1080, 1350], [5, 5, 90, 90]]);
  for (const [id, tr] of Object.entries(T.treatments)) {
    assert.deepEqual([tr.family, tr.lead, tr.contrast.target, tr.contrast.chain.includes("stroke")], ["formula", "location", 3, false], id);
    for (const ratio of ["1x1", "4x5", "9x16"]) {
      const L = layoutFor(tr, ratio, T);
      assert.deepEqual(validateLayout(L, id, T.canvas[ratio], T.safe_area[ratio]), [], `${id} ${ratio}`);
      assert.deepEqual(L.groups.map((g) => [g.id, g.stack.map((s) => s.block).join("+"), !!g.float, g.float.edge || null]), [["top", "location+audience", true, "top"], ["bottom", "duration+offer_name", true, null]], `${id} ${ratio}`);
    }
  }
  assert.deepEqual(validateLayout({ groups: [{ ...layoutFor(T.treatments["f1-callout-left"], "4x5", T).groups[0], float: { edge: "side" } }, layoutFor(T.treatments["f1-callout-left"], "4x5", T).groups[1]] }, "x").filter((e) => /float/.test(e)).length, 1);
  assert.ok(Object.values(FORMULA.styles.styles).every((s) => Object.values(s.blocks).every((b) => b.effect === "plain")), "plain type: a fill and a soft shadow, no outline");
  // The reference layouts derive to 4:5 as they do to 9:16.
  assert.deepEqual(validateLayout(layoutFor(REF.treatments.treatments["t1-bottom-stack"], "4x5", REF.treatments), "t1", [1080, 1350], [5, 5, 90, 90]), []);
  // Ad defaults: the look family and the feed shape.
  // The owner's rule (2026-11-10): feed ads are 4:5 only, Stories 9:16; the square is no longer made, and a profile cannot ask for it.
  assert.deepEqual([CREATIVE_DEFAULTS.look, CREATIVE_DEFAULTS.ratio, FEED_RATIOS], ["reference", "4x5", ["4x5"]]);
  const p = PROFILE_STARTER("testgym", "Test Gym", "SG");
  assert.match(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, ratio: "1x1" } }).errors.join(" | "), /creative_defaults\.ratio must be 4x5: feed ads are made at 4:5 and Stories at 9:16 \(the square is no longer made\)/);
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, look: "formula", ratio: "4x5" } }).errors, []);
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, look: "loud", ratio: "9x16" } }).errors.filter((e) => /look|ratio/.test(e)), ["creative_defaults.look must be one of reference, formula", "creative_defaults.ratio must be 4x5: feed ads are made at 4:5 and Stories at 9:16 (the square is no longer made)"]);
  assert.deepEqual([catalogueFor({ creative_defaults: { look: "formula" } }).look, catalogueFor({ creative_defaults: { look: "formula" } }, null, { look: "reference" }).look, catalogueFor({}).look, Object.keys(catalogueFor({ creative_defaults: { look: "formula", palettes: "brand" } }).palettes.palettes).length], ["formula", "reference", "reference", 12], "the batch's look wins over the gym's; the formula brings its own pairings whatever the brand-palette mode");
  // The Stories file sits beside the feed image whatever its shape; the feed ad's crop window is its own shape.
  assert.deepEqual([storiesFile("101-c01-x-f1-f-cream/4x5/c01-x_4x5_v1.png", "4x5"), storiesFile("101-c01-x-t1-red/1x1/c01-x_1x1_v1.png")], ["101-c01-x-f1-f-cream/9x16/c01-x_9x16_v1.png", "101-c01-x-t1-red/9x16/c01-x_9x16_v1.png"]);
  assert.deepEqual([cropWindow([928, 1160], [0.5, 0.5], [1080, 1350]), cropWindow([1024, 1024], [0.5, 0.5], [1080, 1350])], [[0, 0, 928, 1160], [102.4, 0, 819.2, 1024]]);
  // The image prompt asks for the feed shape and places people by the formula's own geometry.
  const pr = buildVisualPrompt({ treatment: "f1-callout-left", scene: "A woman holding a kettlebell at her chest.", ratio: "4x5", catalogue: FORMULA });
  assert.equal(pr.aspect, "4:5"); assert.match(pr.prompt, /portrait 4:5 \(a little taller than wide\)/); assert.match(pr.prompt, /Text will be laid over the area from 5% to 19% of the height, across the full width and over the area from 68% to 95% of the height/);
});

test("F2 the floating block, by rule: no face under it and it stays; a face under it and it starts below the lowest one when enough of the frame is left, else it moves above the heads when there is room under what sits above, else it stays (and the render fails on the face as any layout would); the callout is only ever cut short above a face; only faces in its own column count", () => {
  const R = [5, 68, 90, 27], fl = { min_h_pct: 15, gap_pct: 2.5 }, face = (y, h = 10, x = 40, w = 20) => ({ x, y, w, h });
  assert.deepEqual(floatRegion(R, fl, [], 19.5), { region: R, moved: null });
  assert.deepEqual(floatRegion(R, fl, [face(30)], 19.5), { region: R, moved: null }, "a face above the block changes nothing");
  assert.deepEqual(floatRegion(R, fl, [face(60)], 19.5), { region: [5, 72.5, 90, 22.5], moved: "below" }, "60–70: it starts at 72.5 and keeps its bottom edge");
  assert.deepEqual(floatRegion(R, fl, [face(72)], 19.5), { region: [5, 42.5, 90, 27], moved: "above" }, "72–82 leaves 10.5 below, under the 15 it needs: above the head, its full height");
  assert.deepEqual(floatRegion(R, fl, [face(72), face(30)], 19.5), { region: R, moved: null }, "a second head at 30 leaves 8 under the callout: nowhere to go");
  assert.deepEqual(floatRegion(R, fl, [face(72), face(40)], 19.5), { region: [5, 19.5, 90, 18], moved: "above" }, "room for less than its height: it takes what there is");
  assert.deepEqual(floatRegion([5, 68, 40, 27], fl, [face(72, 10, 60, 20)], 19.5).moved, null, "a face beside a column is not under it");
  const top = [5, 5, 90, 13.5], tf = { edge: "top", min_h_pct: 7, gap_pct: 1.5 };
  assert.deepEqual([floatRegion(top, tf, [face(15)], 6), floatRegion(top, tf, [face(10)], 6), floatRegion(top, tf, [face(30)], 6)], [{ region: [5, 5, 90, 8.5], moved: "shrunk" }, { region: top, moved: null }, { region: top, moved: null }]);
  const L = layoutFor(FORMULA.treatments.treatments["f1-callout-left"], "4x5", FORMULA.treatments);
  assert.deepEqual(placedRegions(L, [face(60)], 5), [[5, 5, 90, 13.5], [5, 72.5, 90, 22.5]]);
  assert.deepEqual(placedRegions(layoutFor(REF.treatments.treatments["t1-bottom-stack"], "4x5", REF.treatments), [face(60)], 5), [[6, 48, 88, 46]], "a layout without a float is where it was");
});

test("F3 the formula rendered for real: 4:5 and 9:16, plain type with no contrast stroke, the callout the lead line, every word inside the safe area; the block moves below or above a face and says so; a face under the callout that leaves it no room fails as any layout would; Chinese words take their stand-in faces; a reference layout renders at 4:5 too", async () => {
  const render = (over) => renderComposite(browser, { image: DARK, faces: [[]], ...WORDS, treatment: "f1-callout-left", style: "fs1-heavy-italic", palette: "f-cream", ratio: "4x5", catalogue: FORMULA, ...over });
  let r = await render({});
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  const size = (id) => r.report.blocks.find((b) => b.block === id).size;
  assert.deepEqual([r.report.canvas, r.png.readUInt32BE(16), r.png.readUInt32BE(20)], [[1080, 1350], 1080, 1350]);
  assert.ok(size("location") >= size("duration") && size("duration") >= size("offer_name") && size("offer_name") >= 60, `the callout leads: ${size("location")} / ${size("duration")} / ${size("offer_name")}`);
  assert.ok(r.report.blocks.every((b) => !b.steps.includes("stroke") && b.contrast.after >= 3), JSON.stringify(r.report.blocks.map((b) => [b.block, b.steps, b.contrast.after])));
  assert.deepEqual(r.report.groups.map((g) => [g.id, g.floated, g.scrim.direction]), [["top", null, "top"], ["bottom", null, "local"]]);
  // A face low in the frame: the block starts below it.
  r = await render({ faces: [[[600, 400, 700, 600]]] });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  let bottom = r.report.groups.find((g) => g.id === "bottom");
  assert.equal(bottom.floated, "below"); assert.ok(bottom.region.y / 1350 > 0.72 && Math.abs(bottom.region.y + bottom.region.h - 0.95 * 1350) < 1, JSON.stringify(bottom.region));
  // Lower still: no room below, so above the head; its scrim stays local to the block, never run down over the face.
  r = await render({ faces: [[[720, 400, 820, 600]]] });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  bottom = r.report.groups.find((g) => g.id === "bottom");
  assert.deepEqual([bottom.floated, bottom.scrim.direction], ["above", "local"]);
  assert.ok((bottom.region.y + bottom.region.h) / 1350 < 0.72, "the whole block sits above the face");
  // A face in the callout strip: cut short above it when there is room, refused when there is none.
  r = await render({ faces: [[[150, 400, 250, 600]]] });
  assert.equal(r.ok, true, (r.failures || []).join("; ")); assert.equal(r.report.groups[0].floated, "shrunk");
  r = await render({ faces: [[[90, 400, 190, 600]]] });
  assert.equal(r.ok, false); assert.match(r.failures.join("; "), /"location" covers a face/);
  // 9:16: inside Meta's live area (y 14–65%).
  r = await render({ image: DARK_916, ratio: "9x16", treatment: "f2-callout-centre", style: "fs2-condensed", palette: "f-white-pink" });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  assert.ok(r.report.blocks.every((b) => b.rect.y >= 0.14 * 1920 - 1 && b.rect.y + b.rect.h <= 0.65 * 1920 + 1), JSON.stringify(r.report.blocks.map((b) => [b.block, Math.round(b.rect.y), Math.round(b.rect.y + b.rect.h)])));
  // The card layout: the duration and offer on a solid card, the callout over the photo.
  r = await render({ treatment: "f3-offer-card", style: "fs3-tall-sans", palette: "f-navy-red" });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  assert.deepEqual(r.report.blocks.filter((b) => b.steps.includes("layout-band")).map((b) => b.block), ["duration", "offer_name"]);
  // An audience line sits under the callout, smaller.
  r = await render({ audience: "LADIES WANTED" });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  assert.ok(r.report.blocks.find((b) => b.block === "audience").size < r.report.blocks.find((b) => b.block === "location").size);
  // Chinese words.
  r = await render({ location: "信義區", audience: "女性", offer: "六週全身體態改造計畫" });
  assert.equal(r.ok, true, (r.failures || []).join("; "));
  // The reference set at 4:5, derived as it is for 9:16.
  r = await renderComposite(browser, { image: DARK, faces: [[]], ...WORDS, treatment: "t1-bottom-stack", style: "s1-heavy-sans", palette: "white-on-dark", ratio: "4x5" });
  assert.equal(r.ok, true, (r.failures || []).join("; ")); assert.deepEqual(r.report.canvas, [1080, 1350]);
});

test("F4 the fit stage judges a floating layout where the renderer will put it: a photo whose face sits under the block's usual place still fits the formula (the block moves), while a fixed reference layout over the same face does not clear it; the fit loop sees one family's layouts", () => {
  const answer = { people_box: [300, 300, 990, 700], face_boxes: [[600, 400, 700, 600]], people_count: 1, text_items: [], excluded_items: [] };
  const f = judgeVisual(answer, { treatment: "f1-callout-left", ratio: "4x5", imageSize: [1080, 1350], catalogue: FORMULA });
  assert.deepEqual([f.placement.faces_under_text_area, f.ok], [0, true], f.failures.join("; "));
  assert.deepEqual(floatedAreaBoxes("f1-callout-left", "4x5", answer.face_boxes, FORMULA).map((b) => b.map(Math.round)), [[50, 50, 185, 950], [729, 50, 950, 950]], "the block from just under the face to its own bottom edge");
  assert.deepEqual(textAreaBoxes("f1-callout-left", "4x5", FORMULA).map((b) => b.map(Math.round)), [[50, 50, 185, 950], [680, 50, 950, 950]]);
  const t = judgeVisual(answer, { treatment: "t1-bottom-stack", ratio: "4x5", imageSize: [1080, 1350], catalogue: REF });
  assert.equal(t.placement.faces_under_text_area, 1, "a fixed block has the face under it");
  assert.deepEqual(Object.keys(fitLayouts(answer, { ratio: "4x5", imageSize: [1080, 1350], catalogue: FORMULA })), ["f1-callout-left", "f2-callout-centre", "f3-offer-card"]);
  assert.equal(Object.keys(fitLayouts(answer, { ratio: "4x5", imageSize: [1080, 1350], catalogue: REF })).length, 8);
});

test("F5 pairings matched to the backdrop: a pairing's weakest line against the middle patch under its own group is its figure, and under the floor it is weak — white type on a bright wall, navy type on a dark one; the formula's looks come from its own family only, and a weak pairing is passed over for a photo like a clash", () => {
  const L = layoutFor(FORMULA.treatments.treatments["f1-callout-left"], "4x5", FORMULA.treatments), P = FORMULA.palettes.palettes;
  const stat = (top, bottom) => ({ hue: 0, strength: 0.02, lum: (top + bottom) / 2, cells: [...Array(16).fill({ hue: 0, strength: 0.02, lum: top }), ...Array(16).fill({ hue: 0, strength: 0.02, lum: bottom })] });
  const dark = stat(0.03, 0.03), bright = stat(0.85, 0.85), split = stat(0.03, 0.85);
  assert.deepEqual([lumFit(dark, L, P["f-cream"]).weak, lumFit(dark, L, P["f-navy"]).weak, lumFit(bright, L, P["f-cream"]).weak, lumFit(bright, L, P["f-navy"]).weak], [false, true, true, false]);
  assert.ok(lumFit(dark, L, P["f-cream"]).contrast > 10 && lumFit(bright, L, P["f-white-pink"]).contrast < WEAK_NATURAL);
  // Cream on a mid pink reads as it is and reaches the target under a gentle scrim: the Jurong West look itself.
  const pink = stat(0.4, 0.4), fit = lumFit(pink, L, P["f-cream"]);
  assert.deepEqual([fit.weak, fit.contrast > WEAK_NATURAL, fit.with_scrim >= 3, GENTLE_SCRIM], [false, true, true, 0.35]);
  // A fifth of the patches under the block as dark as the type: weak, however light the rest.
  const patchy = { ...bright, cells: [...Array(16).fill({ lum: 0.85 }), ...Array(11).fill({ lum: 0.85 }), ...Array(5).fill({ lum: 0.02 })] };
  assert.deepEqual([lumFit(patchy, L, P["f-navy"]).weak, lumFit(bright, L, P["f-navy"]).weak], [true, false], "navy type across a black top");
  assert.deepEqual([lumFit(split, L, P["f-white-black"]).weak, lumFit(split, L, P["f-cream"]).weak], [false, true], "white callout on the dark top, black offer on the bright foot");
  assert.equal(lumFit({ hue: 0, strength: 0 }, L, P["f-cream"]), null, "no patches measured, no figure");
  const card = layoutFor(FORMULA.treatments.treatments["f3-offer-card"], "4x5", FORMULA.treatments);
  assert.equal(lumFit(stat(0.03, 0.85), card, P["f-cream"]).weak, false, "lines on the card are judged on the card, not the photo");
  const photoStats = [dark, bright].map((s) => ({ overall: s, layouts: Object.fromEntries(Object.keys(FORMULA.treatments.treatments).map((id) => [id, s])) }));
  const plan = assignVariants({ visuals: [{ id: "g01" }, { id: "g02" }], perVisual: 3, text: { location: "JURONG WEST", audience: null }, seed: "s", photoStats, catalogue: FORMULA, ratio: "4x5" });
  assert.equal(plan.candidates.length, 6);
  assert.ok(plan.candidates.every((c) => /^f[123]-/.test(c.treatment) && /^fs[123]-/.test(c.style) && /^f-/.test(c.palette)), JSON.stringify(plan.candidates));
  const lumOfFill = (id, block) => parseInt(P[id].blocks[block].fill.slice(1, 3), 16);
  for (const c of plan.candidates) {
    const light = lumOfFill(c.palette, "location") > 128;
    if (c.treatment !== "f3-offer-card") assert.equal(light, c.visual === "g01", `${c.visual} ${c.treatment} ${c.palette}: light type on the dark photo, dark type on the bright one`);
    assert.ok(c.palette_fit && c.palette_fit.clash === false);
  }
  assert.deepEqual(new Set(plan.candidates.filter((c) => c.visual === "g01").map((c) => c.treatment)).size, 3, "three looks of one photo, three layouts");
});
