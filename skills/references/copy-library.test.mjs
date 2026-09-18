/**
 * Tests for the central copy library (copy-library.mjs): the file and its rules, filling a skeleton, the
 * model's skeleton verified in code, a gym's reference sent to the library — offline, with a fake model.
 *
 *   node --test skills/references/copy-library.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLibrary, liveEntries, placeholdersIn, entryProblems, entryWarnings, addEntry, editEntry, retireEntry, restoreEntry, fill, verifySkeleton, skeletonFrom, sendToLibrary, buildSkeletonPrompt, PLACEHOLDERS, KINDS, LIBRARY_FILE } from "./copy-library.mjs";
import { ANGLES, readCopyRefs } from "./draft-copy.mjs";

const lib = () => mkdtempSync(join(tmpdir(), "copylib-"));
const SKEL = "{AUDIENCE} in {AREA}, if nothing stuck it was the plan.\n\nOur {OFFER} gives you:\n✔ Coach-led sessions\n✔ A plan that fits\n\nTap {BUTTON} to start.";

test("L1 the library file: kinds and angles from the fixed lists, only known placeholders, Meta's lengths, a headline on one line; add (ids by content, no duplicate), edit (re-checked), retire with a reason (never deleted), restore; warnings on what the standing rules forbid", () => {
  const d = lib();
  assert.deepEqual(readLibrary(d), { schema: 1, entries: [] }, "an empty library reads as empty");
  assert.deepEqual(KINDS, ["copy", "headline"]); assert.deepEqual(Object.keys(PLACEHOLDERS), ["GYM", "OFFER", "AREA", "AUDIENCE", "BUTTON", "DURATION"]);
  assert.deepEqual(placeholdersIn(SKEL), ["AUDIENCE", "AREA", "OFFER", "BUTTON"]);
  // The rules.
  const bad = (e, re) => assert.match(entryProblems(e).join("; "), re, JSON.stringify(e));
  bad({ kind: "poem", text: "x" }, /kind is copy or headline/); bad({ kind: "copy", text: "" }, /no text/);
  bad({ kind: "copy", text: "x", angle: "hype" }, /angle is one of/); bad({ kind: "copy", text: "Hi {COACH}" }, /unknown placeholder \{COACH\}/);
  bad({ kind: "headline", text: "two\nlines" }, /one line/); bad({ kind: "headline", text: "x".repeat(300) }, /headline over 255/);
  bad({ kind: "copy", text: "x".repeat(2100) }, /primary text over 2000/); bad({ kind: "copy", text: "x", description: "d".repeat(300) }, /description over 255/);
  assert.deepEqual(entryProblems({ kind: "copy", text: SKEL, angle: "pain" }), []);
  // Warnings: the skeleton stays, the owner is told.
  assert.deepEqual(entryWarnings({ kind: "copy", text: "Book your free trial at {GYM}. Guaranteed. Lose 10 kg for $99." }), ['says "free trial"', 'says "trial"', 'says "guaranteed"', "names a price", "a weight-loss number"]);
  assert.deepEqual(entryWarnings({ kind: "copy", text: "Join for free at {GYM}" }), ['says "free"']);
  assert.deepEqual(entryWarnings({ kind: "headline", text: "Nothing changes here" }), ["no placeholders: nothing in it changes from gym to gym"]);
  // Add.
  const e = addEntry(d, { kind: "copy", text: SKEL, angle: "pain", note: "the opener" });
  assert.match(e.id, /^lib-[0-9a-f]{10}$/); assert.deepEqual([e.placeholders, e.warnings, e.origin, e.retired], [["AUDIENCE", "AREA", "OFFER", "BUTTON"], [], { source: "owner" }, null]);
  assert.throws(() => addEntry(d, { kind: "copy", text: SKEL, angle: "pain" }), /already in the library/);
  assert.throws(() => addEntry(d, { kind: "copy", text: "Hi {COACH}" }), /unknown placeholder/);
  const h = addEntry(d, { kind: "headline", text: "{OFFER} for {AUDIENCE} in {AREA}", angle: "call-out" });
  assert.deepEqual(liveEntries(d).map((x) => x.id), [e.id, h.id]); assert.deepEqual(liveEntries(d, "headline").map((x) => x.id), [h.id]);
  // Edit, re-checked.
  assert.throws(() => editEntry(d, e.id, { text: "{NOPE}" }), /unknown placeholder/);
  const e2 = editEntry(d, e.id, { note: "changed", angle: "structure" }); assert.deepEqual([e2.note, e2.angle, !!e2.edited], ["changed", "structure", true]);
  assert.throws(() => editEntry(d, "lib-nope", { note: "x" }), /no entry/);
  // Retire with a reason, never deleted; restore.
  assert.throws(() => retireEntry(d, e.id, ""), /reason is required/);
  retireEntry(d, e.id, "outdated"); assert.deepEqual(liveEntries(d).map((x) => x.id), [h.id]);
  assert.equal(readLibrary(d).entries.length, 2, "still in the file"); assert.equal(readLibrary(d).entries[0].retired.reason, "outdated");
  restoreEntry(d, e.id); assert.equal(liveEntries(d).length, 2);
  assert.ok(existsSync(join(d, LIBRARY_FILE)));
});

test("L2 filling a skeleton: every placeholder gets its value, dashes come out plain, a missing value is named, a placeholder may be left for later (the area per ad set)", () => {
  const filled = fill(SKEL, { AUDIENCE: "Ladies", AREA: "Bishan", OFFER: "12 Week Total Body Reset", BUTTON: "Sign up" });
  assert.equal(filled, "Ladies in Bishan, if nothing stuck it was the plan.\n\nOur 12 Week Total Body Reset gives you:\n✔ Coach-led sessions\n✔ A plan that fits\n\nTap Sign up to start.");
  assert.throws(() => fill(SKEL, { AUDIENCE: "Ladies", OFFER: "x" }), /no value for \{AREA\}, \{BUTTON\}/);
  assert.equal(fill("{AUDIENCE} in {AREA} — go", { AUDIENCE: "Men" }, { leave: ["AREA"] }), "Men in {AREA} - go", "the area waits for the ad set; the dash is plain");
  assert.equal(fill("{DURATION} of coaching", { DURATION: "12 weeks" }), "12 weeks of coaching");
});

test("L3 the model's skeleton is verified in code: fragments word for word and in order (quotes and spacing aside); a line left out is recorded, a rewrite or an invented placeholder is refused; a gym's reference goes to the library as a copy and a headline skeleton, remembering its ids, and never twice", async () => {
  const original = "🔥 Hayward women! 6 Weeks. 14 Spots.\n\nLadies, it’s your time. Our 6-Week Total Body Reset builds strength — without crazy diets.\n\n✔ Founded by a TEDx speaker\n✔ Get leaner and stronger\n\nTap “Learn More” now — only 14 spots!";
  const good = "🔥 {AREA} {AUDIENCE}! {DURATION}.\n\n{AUDIENCE}, it's your time. Our {OFFER} builds strength — without crazy diets.\n\n✔ Get leaner and stronger\n\nTap \"{BUTTON}\" now — only 14 spots!";
  let v = verifySkeleton(original, good);
  assert.deepEqual([v.ok, v.dropped], [true, ["✔ Founded by a TEDx speaker"]], "straight quotes for curly ones are fine; the founder line is a drop");
  v = verifySkeleton(original, "{AUDIENCE}, it is your moment. Our {OFFER} builds strength."); assert.equal(v.ok, false); assert.match(v.why, /rewritten: ", it is your moment/);
  v = verifySkeleton(original, "Our {OFFER} builds strength — without crazy diets.\n\nLadies, it’s your time."); assert.equal(v.ok, false, "out of order is a rewrite");
  v = verifySkeleton(original, "Something else entirely"); assert.deepEqual([v.ok, v.why], [false, "no placeholders and the text was changed"]);
  assert.deepEqual(verifySkeleton("Plain {GYM} words", "Plain {GYM} words").dropped, []);
  // The call and its checks.
  const answers = [], asked = [];
  const ask = async (img, prompt, schema, opts) => { asked.push({ img, prompt, schema, opts }); return answers.shift(); };
  answers.push({ skeleton: good, angle: "call-out", note: "Opens on the place — then lists.", replaced: [{ placeholder: "{AREA}", was: "Hayward" }, { placeholder: "NOPE", was: "x" }, { placeholder: "OFFER", was: "6-Week Total Body Reset" }] });
  const sk = await skeletonFrom({ text: original, kind: "copy", ask, model: "m" });
  assert.deepEqual([sk.text, sk.angle, sk.note, sk.dropped, sk.replaced], [good, "call-out", "Opens on the place - then lists.", ["✔ Founded by a TEDx speaker"], [{ placeholder: "AREA", was: "Hayward" }, { placeholder: "OFFER", was: "6-Week Total Body Reset" }]]);
  assert.equal(asked[0].img, null); assert.match(asked[0].prompt, /Hayward women/); assert.match(asked[0].prompt, /\{DURATION\}/); assert.deepEqual(asked[0].schema.properties.angle.enum, ANGLES); assert.equal(asked[0].opts.model, "m");
  assert.match(buildSkeletonPrompt({ text: "x", kind: "headline" }), /headline into a reusable skeleton/);
  answers.push({ skeleton: "{AUDIENCE}, it is your moment.", angle: "pain", note: "n", replaced: [] });
  await assert.rejects(skeletonFrom({ text: original, ask }), /not the copy with placeholders \(rewritten/);
  answers.push({ skeleton: "Our {OFFER} builds strength — without crazy diets. {COACH}", angle: "pain", note: "n", replaced: [] });
  await assert.rejects(skeletonFrom({ text: original, ask }), /rewritten|does not exist/);
  await assert.rejects(skeletonFrom({ text: "  ", ask }), /nothing to make/);
  // A gym's reference into the library.
  const d = lib(), g = mkdtempSync(join(tmpdir(), "gym-"));
  writeFileSync(join(g, "copy-references.json"), JSON.stringify({ refs: [
    { id: "own-1", source: "owner", message: original, headline: "🔥 6-Week Total Body Reset for Hayward ladies", angle: "call-out", note: "the owner's note stays", results: null, retired: null },
    { id: "own-2", source: "owner", message: "", headline: "Start today at Moses Fitness", note: "", retired: null },
  ] }));
  answers.push({ skeleton: good, angle: "pain", note: "the model's note", replaced: [] }, { skeleton: "🔥 {OFFER} for {AREA} {AUDIENCE}", angle: "call-out", note: "a headline note", replaced: [{ placeholder: "OFFER", was: "6-Week Total Body Reset" }] });
  const r = await sendToLibrary(g, "own-1", { dir: d, ask, gym: "sculpt-society" });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.angle, e.note, e.origin.ref, e.origin.gym]), [["copy", "call-out", "the owner's note stays", "own-1", "sculpt-society"], ["headline", "call-out", "a headline note", "own-1", "sculpt-society"]], "the copy keeps the reference's own angle and note; the headline takes the model's");
  assert.deepEqual(readCopyRefs(g).refs[0].in_library, r.entries.map((e) => e.id), "the reference remembers its library ids");
  answers.push({ skeleton: good, angle: "pain", note: "n", replaced: [] }, { skeleton: "🔥 {OFFER} for {AREA} {AUDIENCE}", angle: "call-out", note: "n", replaced: [] });
  const again = await sendToLibrary(g, "own-1", { dir: d, ask });
  assert.deepEqual([again.entries.length, again.skipped.map((s) => s.why)], [0, ["that skeleton is already in the library", "that skeleton is already in the library"]], "never twice");
  answers.push({ skeleton: "Start today at {GYM}", angle: "call-out", note: "n", replaced: [] });
  const one = await sendToLibrary(g, "own-2", { dir: d, ask });
  assert.deepEqual([one.entries.length, one.entries[0].kind, asked.length], [1, "headline", 8], "no primary text → the headline alone, one call");
  await assert.rejects(sendToLibrary(g, "own-9", { dir: d, ask }), /no reference own-9/);
  assert.equal(liveEntries(d).length, 3);
});
