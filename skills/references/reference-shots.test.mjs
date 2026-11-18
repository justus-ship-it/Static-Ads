/**
 * Tests for the reference shot reader (reference-shots.mjs) — offline, with a fake model.
 *
 *   node --test skills/references/reference-shots.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceFiles, readReferences, readShots, countShots, buildGuide, buildGuidePrompt, leaks, seenWords, shotBrief, READING_SCHEMA, ENUMS } from "./reference-shots.mjs";

const PNG = (n) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from([n])]);
const reading = (over = {}) => ({ people: 1, audience: "women", apparent_ages: ["40s"], activity: "a plank on the floor, holding", moment: "lockout-or-hold", expression: "determined-focus", gaze: "at-the-work", camera_distance: "medium-close", camera_height: "low", camera_angle: "side", subject_fill_pct: 70, subject_position: "right", crop: "cut at the knees", lens_feel: "normal", depth_of_field: "shallow", motion: ["sweat"], light_direction: "window-side", light_quality: "hard-contrast", colour_temperature: "warm", dominant_colours: ["lime green", "black"], saturation: "vivid", background: "a bright studio wall, blurred", clutter: "some", photo_feel: "phone-snapshot", words_over: "body-not-face", scroll_stopper: "the effort on her face", words_seen: ["MOUNT DORA", "LADIES WANTED", "6 WEEK"], ...over });

test("RS1 the references are read once each by content: a file saved twice counts once; each reading is tidied to the schema (unknown values dropped, numbers bounded); the image goes to the reader and nowhere else; a second run reads nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-")), lib = mkdtempSync(join(tmpdir(), "lib-"));
  writeFileSync(join(dir, "a.jpg"), PNG(1)); writeFileSync(join(dir, "a (1).jpg"), PNG(1)); writeFileSync(join(dir, "b.png"), PNG(2)); writeFileSync(join(dir, "notes.txt"), "x");
  assert.deepEqual(referenceFiles(dir).map((f) => f.file), ["a (1).jpg", "b.png"], "one per content, images only");
  const asked = [];
  const ask = async (img, prompt, schema, opts) => { asked.push({ img, prompt, schema, opts }); return asked.length === 1 ? reading() : reading({ camera_distance: "zoomed", subject_fill_pct: 180, motion: ["sweat", "glitter"] }); };
  const r = await readReferences({ dir, lib, ask, model: "m-pro" });
  assert.deepEqual([r.files, r.read, r.total], [2, 2, 2]);
  assert.ok(asked.every((a) => a.img.startsWith(dir) && a.schema === READING_SCHEMA && a.opts.model === "m-pro"));
  assert.match(asked[0].prompt, /Describe THE PHOTOGRAPH beneath the words/); assert.match(asked[0].prompt, /words_seen, apart from everything else/);
  const got = Object.values(readShots(lib).readings).map((x) => x.reading);
  assert.deepEqual([got[1].camera_distance, got[1].subject_fill_pct, got[1].motion], [null, 100, ["sweat"]], "unknown values dropped, the share bounded to 100");
  assert.deepEqual(ENUMS.camera_distance.includes(got[0].camera_distance), true);
  assert.deepEqual((await readReferences({ dir, lib, ask })).read, 0, "nothing read twice");
});

test("RS2 the counts are code's, not the model's: each value's count, the share of the frame the person fills (median, range, how many at 60% or more), the head counts", () => {
  const rs = [reading(), reading({ camera_distance: "close-up", subject_fill_pct: 85, people: 2, motion: [] }), reading({ camera_distance: "wide", subject_fill_pct: 30, moment: "celebration", apparent_ages: ["20s", "30s"] })];
  const c = countShots(rs);
  assert.equal(c.n, 3);
  assert.deepEqual(c.camera_distance, { "medium-close": 1, "close-up": 1, wide: 1 });
  assert.deepEqual(c.subject_fill_pct, { min: 30, median: 70, max: 85, at_least_60: 2 });
  assert.deepEqual([c.people, c.moment["lockout-or-hold"], c.apparent_ages["40s"], c.motion.sweat], [{ one: 2, two: 1, more: 0, none: 0 }, 2, 2, 2]);
});

test("RS3 the guide: one text call given the counts and the readings without their words; a rule, recipe or avoid line that repeats a word printed on any reference is dropped with the reason; recipes point only at real readings; written as JSON and as a page to read", async () => {
  const lib = mkdtempSync(join(tmpdir(), "lib-"));
  writeFileSync(join(lib, "reference-shots.json"), JSON.stringify({ schema: 1, readings: { a: { file: "a.jpg", reading: reading() }, b: { file: "b.jpg", reading: reading({ words_seen: ["ASHEVILLE AREA", "MEN WANTED", "HIGH PERFORMANCE"] }) } } }));
  assert.deepEqual(seenWords(Object.values(readShots(lib).readings)).sort(), ["asheville", "dora", "high", "mount", "performance"], "candidates: the ads' commonest words (area, wanted, ladies, week) and numbers are never candidates");
  assert.deepEqual(leaks("Shoot like the Mount Dora studio", ["mount", "dora"]), ["mount", "dora"]); assert.deepEqual(leaks("Mountain light", ["mount"]), [], "whole words only");
  let prompt = null;
  let namesAsked = 0;
  const ask = async (img, p, schema) => { if (schema.properties.names) { namesAsked++; assert.match(p, /Which of them are names/); return { names: ["asheville", "mount", "dora", "invented"] }; } prompt = p; assert.equal(img, null); assert.ok(schema.properties.rules);
    return { rules: [{ rule: "Shoot from waist height, close, the person filling 60-85% of the frame's height.", evidence: "2 of 2" }, { rule: "Use the lime walls of the Asheville studio.", evidence: "1 of 2" }],
      recipes: [{ name: "Low plank close-up", when: "floor holds", camera: "low, side, medium-close", moment: "the hold", light: "window light from the side", colour: "warm, vivid", background: "blurred wall", words: "over the legs, never the face", refs: [1, 2, 9] }],
      avoid: ["A small figure in a big empty room", "Shoot from high overhead angles."] }; };
  const g = await buildGuide({ lib, ask, model: "m-pro" });
  assert.doesNotMatch(prompt, /MOUNT DORA|LADIES WANTED|ASHEVILLE/, "the readings reach the guide writer without their words");
  assert.match(prompt, /"camera_distance":\{"medium-close":2\}/, "with the counts");
  assert.deepEqual([g.rules.length, g.avoid.length, g.dropped.map((d) => d.why)], [1, 2, ["repeats names from the ads: asheville"]], "only names are banned: \"high\" is an ordinary word");
  assert.equal(readShots(lib).names.join(","), "asheville,mount,dora", "a word the model calls a name but no ad printed is ignored");
  await buildGuide({ lib, ask }); assert.equal(namesAsked, 1, "the names are asked once and kept");
  assert.equal(g.briefs.length, 2); assert.match(g.briefs[0].brief, /^one person \(40s\): a plank on the floor, holding\. medium-close shot, low camera, side angle, normal lens; the person fills 70% of the height, right; cut at the knees/);
  assert.match(shotBrief(reading()), /words sit body not face; phone-snapshot feel\. Why it stops the scroll: the effort on her face/);
  assert.deepEqual(g.recipes[0].refs, [1, 2], "a reading that does not exist is not cited");
  const md = readFileSync(join(lib, "shot-guide.md"), "utf8");
  assert.match(md, /# Shot guide/); assert.match(md, /1\. Shoot from waist height, close/); assert.match(md, /Person fills \(share of frame height\): median 70%/); assert.match(md, /Dropped from the model's draft/); assert.match(md, /## Each reference in words\n\n1\. one person/);
  assert.ok(existsSync(join(lib, "shot-guide.json")));
  await assert.rejects(buildGuide({ lib: mkdtempSync(join(tmpdir(), "empty-")), ask }), /no readings yet/);
  assert.ok(buildGuidePrompt([reading()], countShots([reading()])).includes("8 to 12"));
});
