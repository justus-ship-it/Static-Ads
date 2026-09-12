/**
 * Offline tests for Layer 1 (pictures only): visual-prompts.mjs, check-visual.mjs, generate-visuals.mjs.
 *
 *   node --test skills/references/visual-pipeline.test.mjs
 *
 * No network and no Gemini spend: the vision answer and the image generator are faked. The live
 * gate is the Step 4 run itself (3 real visuals), reported separately.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogue, layoutFor } from "./render-composites.mjs";
import { buildVisualPrompt, describeTextAreas, describeSubjectArea, maxFigureHeight, coveredSpans, poseProblem, POSES, NO_TEXT_CLAUSE, ONE_PHOTO_CLAUSE } from "./visual-prompts.mjs";
import { judgeVisual, textAreaBoxes, askVision, bestCrop, imageSize, confirmItems, checkVisual, MAX_SUBJECT_UNDER_TEXT } from "./check-visual.mjs";
import { generateVisuals } from "./generate-visuals.mjs";

const CAT = loadCatalogue();
const LAYOUTS = Object.keys(CAT.treatments.treatments);
const PHOTO = {
  must: ["the real Sculpt Society premises", "deep red walls with black ceilings"],
  never: ["the FirenGym wordmark or any text reading FirenGym", "the flame logo or flame-shaped wall sconces"],
  people: "Singaporean / SEA mix, real training clothes, ages 25-45",
};
const SCENE = "a woman in her thirties mid-set of dumbbell shoulder presses";

test("V1 every visual prompt forbids text of every kind and carries no ad copy", () => {
  for (const treatment of LAYOUTS) for (const ratio of ["1x1", "9x16"]) {
    const { prompt } = buildVisualPrompt({ treatment, scene: SCENE, ratio, photography: PHOTO });
    assert.ok(prompt.includes(NO_TEXT_CLAUSE), `${treatment} ${ratio}`);
    for (const copy of ["BISHAN", "LADIES WANTED", "12 Week", "Challenge", "FREE"]) assert.ok(!prompt.includes(copy), `${treatment}: prompt must not contain ad copy "${copy}"`);
    assert.ok(!/No text, letters, signage, logos or watermarks anywhere\.\s*$/m.test(prompt.split("COMPOSITION:")[1].split("\n")[0]), "the hint's own no-text line is not repeated");
  }
  assert.throws(() => buildVisualPrompt({ treatment: "t1-bottom-stack", scene: 'a sign reading "OPEN"', photography: PHOTO }), /quotation marks/);
  assert.throws(() => buildVisualPrompt({ treatment: "t1-bottom-stack", scene: "", photography: PHOTO }), /needs a scene/);
});

test("V2 the composition comes from the layout's own text areas, for the ratio being made", () => {
  const t1 = buildVisualPrompt({ treatment: "t1-bottom-stack", scene: SCENE, photography: PHOTO });
  // A square ad is cut from a 3:4 photo, so the geometry is described in the photo's coordinates (centred crop).
  assert.equal(t1.aspect, "3:4");
  assert.match(t1.prompt, /portrait 3:4/);
  assert.match(t1.prompt, /Text will be laid over the area from 49% to 83% of the height, across the full width/, "48–94% of the ad = 49–83% of the photo");
  assert.match(t1.prompt, /place the subject in the upper half/);
  const t3 = buildVisualPrompt({ treatment: "t3-right-column", scene: SCENE, photography: PHOTO });
  assert.equal(t3.aspect, "4:3");
  assert.match(t3.prompt, /on the right side \(49%–83% of the width\)/);
  const t1tall = buildVisualPrompt({ treatment: "t1-bottom-stack", scene: SCENE, ratio: "9x16", photography: PHOTO });
  assert.match(t1tall.prompt, /vertical 9:16/);
  assert.match(t1tall.prompt, /from 38% to 64% of the height/, "9:16 describes the derived, safe-area geometry");
  assert.deepEqual(describeTextAreas(CAT.treatments.treatments["t2-top-bottom-split"].layouts["1x1"]).length, 2);
  assert.match(buildVisualPrompt({ treatment: "t8-panels-band", scene: SCENE, photography: PHOTO }).prompt, /cropped to a circle/);
});

test("V3 the photography lock is applied, and the logo is never attached", () => {
  const withRef = buildVisualPrompt({ treatment: "t1-bottom-stack", scene: SCENE, photography: PHOTO, hasReference: true, brandNames: ["Sculpt Society"] }).prompt;
  assert.match(withRef, /NEVER SHOW: the flame logo or flame-shaped wall sconces\./);
  assert.match(withRef, /PEOPLE: Singaporean \/ SEA mix/);
  assert.match(withRef, /SETTING \(must show\): the real premises; deep red walls/);
  assert.equal(buildVisualPrompt({ treatment: "t1-bottom-stack", scene: SCENE, photography: { must: ["a (weird) name.* here"] }, brandNames: ["(weird) name.*"] }).prompt.includes("SETTING (must show): a here."), true, "names with regex characters are removed literally");
  // Words are never named, not even to forbid them — naming them invites the model to draw them.
  for (const w of ["FirenGym", "Sculpt Society", "good mood"]) assert.ok(!withRef.includes(w), `prompt names "${w}"`);
  assert.match(withRef, /Do NOT copy any sign, lettering or neon words/);
  assert.doesNotMatch(buildVisualPrompt({ treatment: "t1-bottom-stack", scene: SCENE, photography: PHOTO }).prompt, /reference photo/);
  assert.doesNotMatch(withRef, /logo-horizontal|always_include/i);
});

test("V4 check rules depend on how the layout uses the photo", () => {
  const clean = { text_items: [], people_box: [120, 300, 470, 700], face_boxes: [[130, 450, 220, 530]], people_count: 1 };
  const t1 = { treatment: "t1-bottom-stack" }; // text area: y 480–940 on the 0–1000 scale
  assert.equal(judgeVisual(clean, t1).ok, true, JSON.stringify(judgeVisual(clean, t1).failures));
  // Any legible mark fails, on every layout (an answer without the field counts as legible).
  for (const treatment of LAYOUTS) {
    const r = judgeVisual({ ...clean, text_items: [{ what: "12", kind: "number on dumbbell", box_2d: [400, 500, 420, 520] }] }, { treatment });
    assert.match(r.failures.join(), /stray text in the picture: number on dumbbell "12"/, treatment);
    assert.equal(judgeVisual({ ...clean, text_items: [{ what: "GYM", kind: "wall signage", legible: true }] }, { treatment }).ok, false, treatment);
  }
  // A small mark a viewer could not read is noted, never failed (2026-09-12: a warning label on a machine is fine).
  const small = judgeVisual({ ...clean, text_items: [{ what: "warning label", kind: "label on equipment", legible: false, box_2d: [600, 600, 610, 620] }] }, t1);
  assert.equal(small.ok, true);
  assert.deepEqual(small.notes, ['small marks: label on equipment "warning label"']);
  assert.deepEqual(small.stray_text, []);
  // Placement failures are reported apart from the rest: the batch may keep such a photo for other layouts.
  const under = judgeVisual({ ...clean, people_box: [500, 300, 900, 700], face_boxes: [] }, t1);
  assert.equal(under.ok, false);
  assert.deepEqual(under.placement_failures, under.failures, "only placement failed");
  assert.match(under.failures[0], /of the people sit under text areas/);
  const both = judgeVisual({ ...clean, people_box: [500, 300, 900, 700], face_boxes: [], text_items: [{ what: "GYM", kind: "signage", legible: true }] }, t1);
  assert.equal(both.placement_failures.length, 1);
  assert.equal(both.failures.length, 2, "the text failure is not a placement failure");
  // Faces are not failed here — they are passed on, and the finished ad is judged on its letters.
  const faceLow = judgeVisual({ ...clean, face_boxes: [[520, 450, 600, 530]] }, t1);
  assert.equal(faceLow.ok, true);
  assert.equal(faceLow.placement.faces_under_text_area, 1, "still reported");
  assert.deepEqual(faceLow.faces, [[520, 450, 600, 530]], "handed on to the renderer");
  // A layout with a subject area: at most 40% of the people under its text areas.
  const tall = judgeVisual({ ...clean, people_box: [100, 300, 900, 700] }, t1); // 420/800 under text
  assert.match(tall.failures.join(), /53% of the people sit under text areas/);
  assert.equal(tall.placement.rule, "subject-area");
  assert.ok(MAX_SUBJECT_UNDER_TEXT === 0.4);
  // T4 puts text over the whole frame by design: no body rule.
  const t4 = judgeVisual({ ...clean, people_box: [100, 100, 900, 900] }, { treatment: "t4-centred-stack" });
  assert.equal(t4.ok, true, t4.failures.join());
  assert.equal(t4.placement.rule, "none");
  // T8's photo is cropped to a circle: the people must stay inside it.
  const off = judgeVisual({ ...clean, people_box: [0, 0, 400, 400] }, { treatment: "t8-panels-band" });
  assert.match(off.failures.join(), /fall outside the circular crop/);
  assert.equal(judgeVisual({ ...clean, people_box: [150, 300, 850, 700] }, { treatment: "t8-panels-band" }).ok, true);
  // A collage tile has no placement rule.
  assert.equal(judgeVisual({ ...clean, people_box: [0, 0, 1000, 1000] }, { treatment: "t7-collage" }).placement.rule, "none");
  // People are required unless the scene has none.
  const empty = { text_items: [], people_box: [], face_boxes: [], people_count: 0 };
  assert.match(judgeVisual(empty, t1).failures.join(), /no people found/);
  assert.equal(judgeVisual(empty, { ...t1, expectPeople: false }).ok, true);
  assert.deepEqual(textAreaBoxes("t2-top-bottom-split").map((x) => x.map(Math.round)), [[60, 60, 360, 940], [600, 60, 940, 940]]);
});

test("V5 the vision call sends the key in a header (never the URL) and asks for structured JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    const img = join(dir, "v.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
    let seen;
    const fake = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text_items: [], people_box: [1, 2, 3, 4], face_boxes: [], people_count: 1 }) }] } }] }) }; };
    const ans = await askVision(img, { fetchImpl: fake, key: "TEST-KEY" });
    assert.equal(ans.people_count, 1);
    assert.ok(!seen.url.includes("TEST-KEY"), "key not in the URL");
    assert.equal(seen.init.headers["x-goog-api-key"], "TEST-KEY");
    const body = JSON.parse(seen.init.body);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseSchema.properties.text_items);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V6 generation flow: every paid call is counted, the budget is hard, failures are flagged not retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    let gens = 0;
    const generate = async () => { gens++; return { buffer: Buffer.from("fake"), ext: "png" }; };
    const verdicts = [{ ok: true, failures: [] }, { ok: false, failures: ["stray text in the picture: signage \"GYM\""] }];
    const check = async () => verdicts.shift() || { ok: true, failures: [] };
    const visuals = [1, 2, 3].map((i) => ({ id: `v0${i}`, treatment: "t1-bottom-stack", scene: SCENE }));
    const rep = await generateVisuals({ visuals, photography: PHOTO, outDir: dir, maxCalls: 2, generate, check, log: () => {} });
    assert.equal(gens, 2, "never more calls than the budget");
    assert.equal(rep.image_calls, 2);
    assert.deepEqual(rep.results.map((r) => r.status), ["passed", "flagged", "skipped"]);
    assert.match(rep.results[1].check.failures[0], /stray text/);
    assert.ok(existsSync(join(dir, "v01.png")) && existsSync(join(dir, "v02.png")), "a flagged visual is kept for review");
    assert.ok(existsSync(join(dir, "v03.prompt.txt")) && !existsSync(join(dir, "v03.png")), "a skipped visual has its prompt but no image");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf-8")).results.map((r) => r.status), ["passed", "flagged", "skipped"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V6b the finished ad is the second half of the check: faces go to the renderer; a photo whose own layout's ad puts a letter on a face is retried, then kept for the layouts it fits — as is one that fails only its own layout's placement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    let gens = 0;
    const generate = async () => { gens++; return { buffer: Buffer.from("fake"), ext: "png" }; };
    const check = async () => ({ ok: true, failures: [], faces: [[100, 400, 200, 500]], placement: {} });
    const seen = [], logs = [];
    const compositor = {
      async compose(file, faces, v) { seen.push({ id: v.id.replace(/-a\d$/, ""), faces }); return v.id.startsWith("v02") ? { ok: false, failures: ['"location" covers a face (face 1)'] } : { ok: true, failures: [] }; },
      async close() { seen.push("closed"); },
    };
    const visuals = [1, 2].map((i) => ({ id: `v0${i}`, treatment: "t1-bottom-stack", scene: SCENE }));
    const rep = await generateVisuals({ visuals, text: { location: "BISHAN", offer: "12 Week Challenge" }, photography: PHOTO, outDir: dir, generate, check, compositor, maxCalls: 4, attempts: 2, log: (m) => logs.push(m) });
    assert.equal(gens, 3, "v02 was retried once for its own layout");
    // The retry did not help: the photo is a good picture, so it is kept — with the ad failure on record — for other layouts.
    assert.deepEqual(rep.results.map((r) => r.status), ["passed", "passed"]);
    assert.equal(rep.results[0].own_layout_failed, undefined);
    assert.match(rep.results[1].own_layout_failed.join(), /finished ad: "location" covers a face/);
    assert.match(rep.results[1].file, /v02-a2\.png$/, "the last good picture");
    assert.equal(rep.results[1].check.picture_ok, true);
    assert.ok(logs.some((l) => /v02: v02-a2\.png passes the picture checks; its own layout did not work out .* kept for the layouts it fits/.test(l)), logs.join(" | "));
    assert.deepEqual(seen, [{ id: "v01", faces: [[100, 400, 200, 500]] }, { id: "v02", faces: [[100, 400, 200, 500]] }, { id: "v02", faces: [[100, 400, 200, 500]] }, "closed"], "the check's faces reach the renderer; the browser is closed");
    // A photo that fails the picture checks is never kept.
    const rep2 = await generateVisuals({ visuals: [visuals[0]], text: { location: "BISHAN", offer: "12 Week Challenge" }, photography: PHOTO, outDir: join(dir, "b"), generate, check: async () => ({ ok: false, failures: ["stray text in the picture: sign \"X\""], faces: [], placement: {} }), compositor, log: () => {} });
    assert.equal(rep2.results[0].status, "flagged");
    assert.equal(rep2.results[0].own_layout_failed, undefined);
    // Only its own layout's placement fails (the people under that layout's text): kept, the quality check still run.
    let qualityRan = 0;
    const placementOnly = async () => ({ ok: false, failures: ["64% of the people sit under text areas (max 40%)"], placement_failures: ["64% of the people sit under text areas (max 40%)"], faces: [], placement: {} });
    const { checkPicture } = await import("./generate-visuals.mjs");
    const check3 = (file, opts) => checkPicture(file, opts, { base: placementOnly, quality: async () => { qualityRan++; return { ok: true, failures: [], minor: [], dismissed: [] }; } });
    const rep3 = await generateVisuals({ visuals: [visuals[0]], text: { location: "BISHAN", offer: "12 Week Challenge" }, photography: PHOTO, outDir: join(dir, "c"), generate, check: check3, compositor, attempts: 2, maxCalls: 4, log: () => {} });
    assert.equal(qualityRan, 2, "realism judged on both attempts");
    assert.equal(rep3.results[0].status, "passed");
    assert.match(rep3.results[0].own_layout_failed.join(), /64% of the people sit under text areas/);
    // But a placement failure alongside a realism failure is not kept.
    const check4 = (file, opts) => checkPicture(file, opts, { base: placementOnly, quality: async () => ({ ok: false, failures: ["looks fake (body): the man sits on nothing"], minor: [], dismissed: [] }) });
    const rep4 = await generateVisuals({ visuals: [visuals[0]], text: { location: "BISHAN", offer: "12 Week Challenge" }, photography: PHOTO, outDir: join(dir, "d"), generate, check: check4, compositor, log: () => {} });
    assert.equal(rep4.results[0].status, "flagged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V8 each layout's framing reaches the prompt, with leave to adapt the pose", () => {
  for (const id of LAYOUTS) {
    const p = buildVisualPrompt({ treatment: id, scene: SCENE, photography: PHOTO }).prompt;
    assert.ok(p.includes(`FRAMING: ${CAT.treatments.treatments[id].visual_framing}`), id);
    assert.match(p, /If the scene's pose would not fit this framing, show a variant of the same exercise that does/);
    assert.doesNotMatch(CAT.treatments.treatments[id].visual_framing, /\d+%/, `${id}: framing carries no numbers — geometry supplies them`);
  }
  assert.match(CAT.treatments.treatments["t1-bottom-stack"].visual_framing, /No full-length standing figures/);
});

test("V7 the prompt says where faces go: the biggest stretch of frame no text covers (learned from the first live run)", () => {
  const L = (id) => CAT.treatments.treatments[id].layouts["1x1"];
  assert.equal(describeSubjectArea(L("t1-bottom-stack")), "the top 48% of the frame");
  assert.equal(describeSubjectArea(L("t2-top-bottom-split")), "the band between 36% and 60% of the height");
  assert.equal(describeSubjectArea(L("t3-right-column")), "the left 48% of the frame");
  assert.equal(describeSubjectArea(L("t6-left-column")), "the right 48% of the frame");
  assert.equal(describeSubjectArea(L("t4-centred-stack")), null, "text covers the whole frame");
  const p = buildVisualPrompt({ treatment: "t2-top-bottom-split", scene: SCENE, photography: PHOTO }).prompt;
  assert.match(p, /Place every face, and the subject's head and upper body, within the band between 40% and 58% of the height/, "36–60% of the ad in the 3:4 photo");
  assert.match(p, /treadmills, bikes and any machine with a console are out of the frame or turned so their consoles face away/);
  assert.match(p, /It is a private session\. Apart from the people in the scene, the gym is empty/);
  // With a head count, it is stated outright (the 48-ad batch: "apart from the people in the scene" still drew gym-goers in).
  const two = buildVisualPrompt({ treatment: "t3-right-column", scene: SCENE, photography: PHOTO, people: 2 }).prompt;
  assert.match(two, /Exactly 2 people in the whole photo, and nobody else: no one in the background, at other equipment, or reflected in the mirrors\./);
  assert.match(buildVisualPrompt({ treatment: "t3-right-column", scene: SCENE, photography: PHOTO, people: 1 }).prompt, /Exactly 1 person in the whole photo/);
});

test("V9 learned from runs 1–3: the photo is asked to be plain, never darker, and one untouched scene", () => {
  for (const id of LAYOUTS) for (const ratio of ["1x1", "9x16"]) {
    const p = buildVisualPrompt({ treatment: id, scene: SCENE, ratio, photography: PHOTO }).prompt;
    assert.ok(p.includes(ONE_PHOTO_CLAUSE), `${id} ${ratio}`);
    assert.doesNotMatch(p, /\bdarker\b/, `${id} ${ratio}: asking for "darker" got painted strips`);
  }
  assert.match(ONE_PHOTO_CLAUSE, /no added bars, strips, borders, frames, split screens, mirrored reflections/);
});

test("V10 the size limit comes from the same rule the check applies; 9:16 never sends faces into the covered zones", () => {
  const T = CAT.treatments, o = (r) => ({ canvas: T.canvas[r], covered: coveredSpans(r, T) });
  const L = (id, r) => layoutFor(T.treatments[id], r, T);
  assert.equal(maxFigureHeight(L("t1-bottom-stack", "1x1"), o("1x1")), 65, "(48 − 8) / 0.6 → 65%");
  assert.equal(maxFigureHeight(L("t2-top-bottom-split", "1x1"), o("1x1")), 40, "24 / 0.6 → 40%");
  assert.equal(maxFigureHeight(L("t3-right-column", "1x1"), o("1x1")), null, "columns: height is free");
  assert.match(buildVisualPrompt({ treatment: "t2-top-bottom-split", scene: SCENE, photography: PHOTO }).prompt, /SIZE: each person's whole figure, head to feet, is at most 25% of the frame's height/, "40% of the ad = 30% of the 3:4 photo; asked for 85% of that");
  assert.doesNotMatch(buildVisualPrompt({ treatment: "t3-right-column", scene: SCENE, photography: PHOTO }).prompt, /SIZE:/);
  // In 9:16 the app covers the top 14% and bottom 35%: a face there is hidden, so it is not free space.
  assert.deepEqual(coveredSpans("9x16", T), [[0, 14], [65, 100]]);
  assert.equal(describeSubjectArea(L("t4-centred-stack", "9x16"), o("9x16")), null, "not 'the bottom 36%'");
  assert.equal(describeSubjectArea(L("t1-bottom-stack", "9x16"), o("9x16")), "the band between 14% and 38% of the height");
  assert.equal(describeSubjectArea(L("t2-top-bottom-split", "9x16"), o("9x16")), "the band between 32% and 45% of the height", "261 px — as usable as the 1:1 band");
  assert.equal(judgeVisual({ text_items: [], people_box: [100, 100, 900, 900], face_boxes: [], people_count: 1 }, { treatment: "t4-centred-stack", ratio: "9x16" }).placement.rule, "none");
});

test("V11 people beyond the scene's count are noted, not failed (2026-09-12: the owner is fine with a bystander)", () => {
  const ans = { text_items: [], people_box: [120, 300, 470, 700], face_boxes: [[130, 450, 220, 530]], people_count: 3 };
  const r = judgeVisual(ans, { treatment: "t1-bottom-stack", maxPeople: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes, ["3 people in the picture; the scene has 1"]);
  assert.deepEqual(judgeVisual(ans, { treatment: "t1-bottom-stack" }).notes, [], "no count given, nothing to note");
  assert.equal(judgeVisual({ ...ans, people_box: null, people_count: 0 }, { treatment: "t1-bottom-stack", maxPeople: 1 }).ok, false, "no people at all still fails a scene that asked for people");
});

test("V12 a scene whose pose its layout cannot hold is refused before any image is generated (run 4: a standing coach in T2)", async () => {
  assert.deepEqual(Object.keys(POSES), ["upright", "compact", "low"]);
  assert.equal(poseProblem("t2-top-bottom-split", "low"), null);
  assert.match(poseProblem("t2-top-bottom-split", "upright"), /cannot hold an upright pose \(standing, full-length\); it needs low/);
  assert.match(poseProblem("t1-bottom-stack", "upright"), /it needs compact .* or low/);
  for (const id of ["t3-right-column", "t4-centred-stack", "t6-left-column", "t7-collage", "t8-panels-band"]) assert.equal(poseProblem(id, "upright"), null, id);
  assert.match(poseProblem("t1-bottom-stack", "jumping"), /unknown pose/);
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    let gens = 0;
    await assert.rejects(generateVisuals({ visuals: [{ id: "v01", treatment: "t3-right-column", scene: SCENE, pose: "upright" }, { id: "v02", treatment: "t2-top-bottom-split", scene: SCENE, pose: "upright" }],
      photography: PHOTO, outDir: dir, generate: async () => { gens++; return { buffer: Buffer.from("x"), ext: "png" }; }, check: async () => ({ ok: true, failures: [] }), log: () => {} }), /v02: t2-top-bottom-split cannot hold an upright pose/);
    assert.equal(gens, 0, "nothing was spent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V13 crop to fit: a subject Gemini centred is placed by moving the square crop through the taller photo", () => {
  // Centred people in a 3:4 photo (896 × 1200): a centred square crop puts 54% of them under T1's text;
  // moving the crop down lifts them in the ad, and the rules pass.
  const ans = { text_items: [], people_box: [300, 300, 700, 700], face_boxes: [[310, 450, 380, 550]], people_count: 1 };
  const square = judgeVisual(ans, { treatment: "t1-bottom-stack" });
  assert.match(square.failures.join(), /of the people sit under text areas/, "a square photo has no room to move");
  const tall = judgeVisual(ans, { treatment: "t1-bottom-stack", imageSize: [896, 1200] });
  assert.equal(tall.ok, true, tall.failures.join());
  assert.ok(tall.focus[1] > 0.5 && tall.focus[0] === 0.5, `crop moved down: ${tall.focus}`);
  assert.ok(tall.placement.share_under_text <= MAX_SUBJECT_UNDER_TEXT);
  // A right column: people in the middle of a 4:3 photo are moved left of the column.
  const col = judgeVisual({ ...ans, people_box: [150, 400, 900, 600], face_boxes: [[160, 460, 240, 540]] }, { treatment: "t3-right-column", imageSize: [1200, 896] });
  assert.equal(col.ok, true, col.failures.join());
  assert.ok(col.focus[0] > 0.5, `crop moved right, so the people sit left: ${col.focus}`);
  // A crop never cuts off a face: people too near the top edge stay whole, and the failure says so.
  const r = bestCrop({ imageSize: [896, 1200], canvas: [1080, 1080], people: [20, 300, 900, 700], faces: [[20, 450, 90, 550]], areas: textAreaBoxes("t1-bottom-stack"), rule: "subject-area" });
  assert.equal(r.facesCut, 0);
  assert.ok(r.focus[1] < 0.1, "held at the top so the face stays in");
  // The photo's real size comes from its header.
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(896, 16); png.writeUInt32BE(1200, 20);
  assert.deepEqual(imageSize(png), [896, 1200]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x03, 0x80]);
  assert.deepEqual(imageSize(jpg), [896, 1200]);
});

test("V14 the photo is generated at the frame's exact aspect, the ad uses the judged crop, and retries stay inside the budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    const asked = [], composed = [];
    const generate = async (prompt, refs, opts) => { asked.push(opts.aspectRatio); return { buffer: Buffer.from("x"), ext: "jpg" }; };
    let n = 0;
    const check = async () => (++n <= 2 ? { ok: false, failures: ["stray text in the picture: x"] } : { ok: true, failures: [], faces: [], focus: [0.5, 0.9] });
    const compositor = { async compose(file, faces, v, text, ratio, out, focus) { composed.push(focus); return { ok: true, failures: [] }; }, async close() {} };
    const visuals = [{ id: "v01", treatment: "t1-bottom-stack", scene: SCENE }, { id: "v02", treatment: "t3-right-column", scene: SCENE }];
    const rep = await generateVisuals({ visuals, text: { location: "BISHAN", offer: "12 Week Challenge" }, photography: PHOTO, outDir: dir, maxCalls: 4, attempts: 3, generate, check, checkRef: async () => [], compositor, log: () => {} });
    assert.deepEqual(asked, ["3:4", "3:4", "3:4", "4:3"], "T1 three tries at 3:4 (third passes), T2's column at 4:3");
    assert.equal(rep.image_calls, 4);
    assert.deepEqual(rep.results.map((r) => [r.id, r.status, r.attempts.length]), [["v01", "passed", 3], ["v02", "passed", 1]]);
    assert.deepEqual(composed, [[0.5, 0.9], [0.5, 0.9]], "the finished ad is rendered at the judged crop");
    assert.ok(existsSync(join(dir, "v01.jpg")) && existsSync(join(dir, "v01-a2.jpg")) && existsSync(join(dir, "v01-a3.jpg")), "every attempt is kept");
    // The budget is never exceeded, even with attempts left.
    let calls = 0;
    const rep2 = await generateVisuals({ visuals, photography: PHOTO, outDir: dir, maxCalls: 2, attempts: 5, generate: async () => { calls++; return { buffer: Buffer.from("x"), ext: "jpg" }; }, check: async () => ({ ok: false, failures: ["x"] }), log: () => {} });
    assert.equal(calls, 2);
    assert.deepEqual(rep2.results.map((r) => r.status), ["flagged", "skipped"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V15 a reference photo carrying text is refused before anything is generated (runs 1–6: treadmill consoles)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    const { writeFileSync } = await import("node:fs");
    const ref = join(dir, "ref.png"); writeFileSync(ref, Buffer.from("89504e470d0a1a0a", "hex"));
    let gens = 0;
    await assert.rejects(generateVisuals({ visuals: [{ id: "v01", treatment: "t3-right-column", scene: SCENE }], refs: [ref], photography: PHOTO, outDir: dir,
      generate: async () => { gens++; return { buffer: Buffer.from("x"), ext: "png" }; }, checkRef: async () => [{ what: "SET 15", kind: "treadmill console" }], log: () => {} }),
      /reference photo .*ref\.png contains text the model would copy: treadmill console "SET 15". Crop it out or clean the photo \(Step 5\) first/);
    assert.equal(gens, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V16 the client's never-list is verified, not just requested (run 8: a flame-shaped sconce appeared)", async () => {
  const ans = { text_items: [], people_box: [120, 300, 470, 700], face_boxes: [[130, 450, 220, 530]], people_count: 1, excluded_items: [{ what: "flame-shaped wall sconce", box_2d: [50, 40, 110, 80] }] };
  const r = judgeVisual(ans, { treatment: "t1-bottom-stack" });
  assert.equal(r.ok, false);
  assert.match(r.failures.join(), /shows what the client never allows: flame-shaped wall sconce/);
  assert.equal(judgeVisual({ ...ans, excluded_items: [] }, { treatment: "t1-bottom-stack" }).ok, true);
  // The list reaches the vision call, in full — naming items to the checker is safe; it only looks.
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    const { writeFileSync } = await import("node:fs");
    const img = join(dir, "v.png"); writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
    let body;
    await askVision(img, { key: "K", never: PHOTO.never, fetchImpl: async (u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...ans, excluded_items: [] }) }] } }] }) }; } });
    const q = body.contents[0].parts[0].text;
    for (const n of PHOTO.never) assert.ok(q.includes(`- ${n}`), n);
    assert.ok(body.generationConfig.responseSchema.required.includes("excluded_items"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V17 a flagged item must be confirmed by a second, targeted look before it fails a picture (run 8: an inferred kettlebell marking)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vis-"));
  try {
    const { writeFileSync } = await import("node:fs");
    const img = join(dir, "v.png");
    const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1000, 16); png.writeUInt32BE(1000, 20);
    writeFileSync(img, png);
    const first = { text_items: [{ what: "embossed weight marking", kind: "digit", box_2d: [300, 300, 340, 340] }], people_box: [120, 300, 470, 700], face_boxes: [[130, 450, 220, 530]], people_count: 1,
      excluded_items: [{ what: "flame-shaped wall sconce", box_2d: [50, 40, 110, 80] }] };
    const calls = [];
    const fetchImpl = async (u2, init) => {
      const q = JSON.parse(init.body).contents[0].parts[0].text; calls.push(q.startsWith("A first check") ? "confirm" : "first");
      const reply = q.startsWith("A first check") ? { findings: [{ index: 0, visible: false, seen: "a plain round base" }, { index: 1, visible: true, seen: "a flame-shaped lamp" }] } : first;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) };
    };
    const r = await checkVisual(img, { treatment: "t1-bottom-stack", key: "K", fetchImpl, never: ["flame-shaped wall sconces"] });
    assert.deepEqual(calls, ["first", "confirm"]);
    assert.deepEqual(r.stray_text, [], "the inferred marking is dismissed");
    assert.equal(r.dismissed[0].what, "embossed weight marking", "…and recorded, not hidden");
    assert.match(r.failures.join(), /never allows: flame-shaped wall sconce/, "the confirmed sconce still fails the picture");
    // Nothing flagged: no second call.
    calls.length = 0;
    const clean = await checkVisual(img, { treatment: "t1-bottom-stack", key: "K", fetchImpl: async () => { calls.push("first"); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...first, text_items: [], excluded_items: [] }) }] } }] }) }; } });
    assert.deepEqual(calls, ["first"]);
    assert.equal(clean.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("V18 a second run never overwrites a first run's photos: every attempt keeps its own file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "no-overwrite-"));
  try {
    let n = 0;
    const generate = async () => ({ buffer: Buffer.from(`photo ${++n}`), ext: "png" });
    const check = async () => ({ ok: false, failures: ["3 people in the picture; the scene has 1"], faces: [], focus: [0.5, 0.5], placement: {} });
    const visuals = [{ id: "g01", treatment: "t3-right-column", scene: SCENE, pose: "upright", people: 1 }];
    await generateVisuals({ visuals, photography: PHOTO, outDir: dir, maxCalls: 2, attempts: 2, generate, check, compositor: null, log: () => {} });
    await generateVisuals({ visuals, photography: PHOTO, outDir: dir, maxCalls: 2, attempts: 2, generate, check, compositor: null, log: () => {} });
    const files = ["g01.png", "g01-a2.png", "g01-a3.png", "g01-a4.png"];
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf-8")), ["photo 1", "photo 2", "photo 3", "photo 4"], "four photos, four files, none replaced");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
