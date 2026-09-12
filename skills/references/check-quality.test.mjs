/**
 * Tests for check-quality.mjs (does a photo look real; is a group candid) and where it sits in the
 * picture check. Offline: the vision answers are faked — no network, no client photos.
 *
 *   node --test skills/references/check-quality.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeQuality, checkQuality, seriousFindings, QUALITY_VERSION } from "./check-quality.mjs";
import { checkPicture } from "./generate-visuals.mjs";
import { buildVisualPrompt, CANDID, REAL_CLAUSE } from "./visual-prompts.mjs";

// A photo with nothing wrong, as the vision model answers.
const REAL = { exercise_shown: true, exercise_seen: "a seated cable row", problems: [], people_count: 1, poses_near_identical: false, interaction: false, coach_attending: true, looking_at_camera: 0, duplicate_faces: false };
const GROUP_OK = { ...REAL, exercise_seen: "three men doing bodyweight squats", people_count: 3, interaction: true, interaction_seen: "one grins at the man beside him" };
const ROW = "A man in his late fifties seated at a cable row, pulling the handle to his waist.";

test("Q1 realism: the scene's exercise must be shown; a confirmed serious problem fails; one dismissed on the second look passes, recorded; minor ones never fail", async () => {
  assert.equal(judgeQuality(REAL).ok, true);
  // g07: a cable row with no machine.
  const noMachine = { ...REAL, exercise_shown: false, exercise_seen: "a man sitting in mid-air holding a cable handle" };
  const r1 = judgeQuality(noMachine);
  assert.equal(r1.ok, false);
  assert.match(r1.failures[0], /^not the scene: does not show the scene's exercise; it shows a man sitting in mid-air/);
  const floating = { ...REAL, problems: [{ what: "the man sits on nothing — no seat under him", kind: "body", severity: "fatal", box_2d: [300, 300, 600, 600] }] };
  assert.match(judgeQuality(floating).failures[0], /^looks fake \(body\): the man sits on nothing/);
  assert.equal(judgeQuality(floating).version, QUALITY_VERSION);

  // The flow: serious findings (the missing exercise included) go to a second look; only confirmed ones fail.
  const asked = [];
  const confirmNone = async (file, items) => { asked.push(...items.map((t) => t.what)); return { kept: [], dismissed: items.map((t) => ({ ...t, seen: "a normal seat, seen at an angle" })) }; };
  const d = await checkQuality("x.jpg", { scene: ROW, ask: async () => ({ ...floating, exercise_shown: false, exercise_seen: "a man on a bench" }), confirm: confirmNone });
  assert.equal(d.ok, true, "a finding the second look dismisses does not fail the photo");
  assert.equal(asked.length, 2, "the missing exercise and the serious problem both get the second look");
  assert.match(d.dismissed.join(), /second look: a normal seat/);
  const confirmAll = async (file, items) => ({ kept: items, dismissed: [] });
  const c = await checkQuality("x.jpg", { scene: ROW, ask: async () => floating, confirm: confirmAll });
  assert.equal(c.ok, false);

  // Minor problems are recorded, never failed — and never sent for a second look.
  const minor = { ...REAL, problems: [{ what: "a plate in the far rack is slightly oval", kind: "equipment", severity: "minor" }] };
  assert.equal(seriousFindings(minor).length, 0);
  const m = judgeQuality(minor);
  assert.equal(m.ok, true);
  assert.deepEqual(m.minor, ["equipment: a plate in the far rack is slightly oval"]);
  await assert.rejects(checkQuality("x.jpg", { ask: async () => REAL, confirm: confirmAll }), /needs the scene/);
});

test("Q1b only gross faults on the people fail; equipment nuance, hands, background and mirror claims are notes, never failures", () => {
  // The owner's rulings (2026-09-12): a bench with no visible rear leg, a bar "through the rack", a hand
  // the checker calls merged, handle-less dumbbells — all fine. Only the people themselves being wrong fails.
  const carry = { ...REAL, held: [{ item: "dumbbells in both hands", grip_real: false, size_real: false, position_real: true, note: "fat discs, no handle" }] };
  assert.deepEqual(seriousFindings(carry), [], "equipment in use is never sent for a second look");
  const c = judgeQuality(carry);
  assert.equal(c.ok, true);
  assert.deepEqual(c.minor, ["dumbbells in both hands: not really held or supported; not the size or shape of the real thing (fat discs, no handle)"]);
  assert.deepEqual(judgeQuality({ ...REAL, held: [{ item: "barbell", grip_real: true, size_real: true, position_real: true }] }).minor, []);
  const bench = { what: "the bench has no rear leg under the man", kind: "equipment", severity: "fatal", on_subject: true };
  const hand = { what: "the bar passes through the lifter's right hand", kind: "hands", severity: "fatal", on_subject: true };
  const background = { what: "a man at the back has three legs", kind: "body", severity: "fatal", on_subject: false };
  const mirror = { what: "the mirror does not reflect the man in front of it", kind: "reflection", severity: "fatal", on_subject: true };
  const noisy = { ...REAL, problems: [bench, hand, background, mirror] };
  assert.deepEqual(seriousFindings(noisy), [], "none goes to the second look");
  const n = judgeQuality(noisy);
  assert.equal(n.ok, true);
  assert.deepEqual(n.minor, [`equipment: ${bench.what}`, `hands: ${hand.what}`, `background: ${background.what}`, `mirror (not judged): ${mirror.what}`]);
  // Gross faults on the people: a body on nothing, a missing arm, a broken face.
  for (const p of [{ what: "the man sits on nothing", kind: "body" }, { what: "the middle man's left arm is missing", kind: "body" }, { what: "his face is smeared", kind: "face" }]) {
    assert.equal(seriousFindings({ ...REAL, problems: [{ ...p, severity: "fatal", on_subject: true }] }).length, 1, p.what);
  }
  assert.equal(seriousFindings({ ...REAL, problems: [{ what: "a slightly odd elbow", kind: "body", severity: "minor", on_subject: true }] }).length, 0, "a minor one never");
});

test("Q2 candid: near-identical poses, cloned faces, a class with no interaction, a coach not attending and a line-up facing the lens each fail; one person skips these rules", () => {
  assert.equal(judgeQuality(GROUP_OK, { people: 3, setting: "group" }).ok, true);
  const lineUp = judgeQuality({ ...GROUP_OK, poses_near_identical: true }, { people: 3, setting: "group" });
  assert.deepEqual(lineUp.failures, ["posed, not candid: the 3 people are near-copies of each other's pose"]);
  assert.match(judgeQuality({ ...GROUP_OK, duplicate_faces: true }, { people: 3, setting: "group" }).failures.join(), /same face on more than one person/);
  assert.match(judgeQuality({ ...GROUP_OK, interaction: false }, { people: 3, setting: "group" }).failures.join(), /group class with no interaction/);
  assert.equal(judgeQuality({ ...GROUP_OK, interaction: false }, { people: 2, setting: "coached" }).ok, true, "a coached pair does not need chatter");
  const coach = judgeQuality({ ...GROUP_OK, people_count: 2, coach_attending: false }, { people: 2, setting: "coached" });
  assert.equal(coach.ok, true, "a coach looking away is a note, not a failure");
  assert.match(coach.minor.join(), /coach is not watching or helping/);
  // g06: four planks, four faces into the lens. More than half the people looking into the lens is posed.
  assert.match(judgeQuality({ ...GROUP_OK, people_count: 4, looking_at_camera: 4 }, { people: 4, setting: "group" }).failures.join(), /4 of the 4 people look into the camera/);
  assert.equal(judgeQuality({ ...GROUP_OK, looking_at_camera: 2 }, { people: 3, setting: "group" }).ok, false, "two of three");
  assert.equal(judgeQuality({ ...GROUP_OK, looking_at_camera: 1 }, { people: 3, setting: "group" }).ok, true, "one glance at the camera is not a pose");
  assert.equal(judgeQuality({ ...GROUP_OK, people_count: 2, looking_at_camera: 1 }, { people: 2, setting: "coached" }).ok, true, "half is not more than half");
  assert.equal(judgeQuality({ ...GROUP_OK, people_count: 4, looking_at_camera: 2 }, { people: 4, setting: "group" }).ok, true, "two of four is half, not more");
  assert.equal(judgeQuality({ ...GROUP_OK, people_count: 4, looking_at_camera: 3 }, { people: 4, setting: "group" }).ok, false, "three of four is");
  // One person: the class rules do not apply, whatever the answer says — a bystander behind a solo
  // lifter does not make a class (the base check notes the extra person).
  const solo = judgeQuality({ ...REAL, people_count: 2, poses_near_identical: true, interaction: false, looking_at_camera: 2, duplicate_faces: true }, { people: 1, setting: "solo" });
  assert.equal(solo.ok, true);
  assert.equal(solo.interaction_seen, null);
  // The scene's head count counts even if the checker saw fewer.
  assert.equal(judgeQuality({ ...GROUP_OK, people_count: 1, poses_near_identical: true }, { people: 3, setting: "group" }).ok, false);
});

test("Q3 the picture check: quality runs only once text, placement and head count pass; its failures read in plain words; a check that cannot run fails the photo", async () => {
  const seen = [];
  const base = (ok) => async (file, opts) => ({ ok, failures: ok ? [] : ["stray text in the picture: sign \"X\""], notes: ok ? ["small marks: label \"CAUTION\""] : [], faces: [[1, 1, 2, 2]], focus: [0.5, 0.5], placement: {} });
  const quality = (ok) => async (file, opts) => { seen.push(opts); return { ok, failures: ok ? [] : ["posed, not candid: the 3 people are near-copies of each other's pose"], minor: ["equipment: the bench has no rear leg"], dismissed: [], version: QUALITY_VERSION }; };
  const opts = { treatment: "t3-right-column", maxPeople: 3, scene: "A small group class of three men squatting.", setting: "group" };

  const refused = await checkPicture("x.jpg", opts, { base: base(false), quality: quality(true) });
  assert.equal(refused.ok, false);
  assert.equal(seen.length, 0, "nothing spent judging a photo already refused");

  const posed = await checkPicture("x.jpg", opts, { base: base(true), quality: quality(false) });
  assert.equal(posed.ok, false);
  assert.deepEqual(posed.failures, ["posed, not candid: the 3 people are near-copies of each other's pose"]);
  assert.deepEqual(seen[0], { scene: opts.scene, people: 3, setting: "group" }, "the check is told the scene, its head count and its setting");
  assert.deepEqual(posed.faces, [[1, 1, 2, 2]], "the placement half's answer is kept");

  const good = await checkPicture("x.jpg", opts, { base: base(true), quality: quality(true) });
  assert.equal(good.ok, true);
  assert.equal(good.quality.version, QUALITY_VERSION);
  assert.deepEqual(good.notes, ["small marks: label \"CAUTION\"", "equipment: the bench has no rear leg"], "both halves' notes ride with the photo");

  const ruled = await checkPicture("x.jpg", { ...opts, skipQuality: true }, { base: base(true), quality: quality(false) });
  assert.equal(ruled.ok, true, "a photo the owner passed is not judged again");
  assert.equal(ruled.quality.ruling, "passed by the owner");
  assert.deepEqual(ruled.notes, ["small marks: label \"CAUTION\""]);
  assert.equal(seen.length, 2, "and no quality call is made for it");

  const broken = await checkPicture("x.jpg", opts, { base: base(true), quality: async () => { throw new Error("vision check failed (503)"); } });
  assert.equal(broken.ok, false, "a quality check that cannot run never passes a photo");
  assert.match(broken.failures[0], /quality check could not run/);
});

test("Q4 prompts: group and coached scenes ask for a candid session, solo scenes don't; every scene asks for real equipment in real use and no look into the lens; no fault is named", () => {
  const P = { people: "Singaporean / SEA mix, ages 20-65", must: ["a real gym"], never: [] };
  const make = (setting, people) => buildVisualPrompt({ treatment: "t3-right-column", scene: "Men training.", photography: P, people, setting }).prompt;
  const group = make("group", 3), coached = make("coached", 2), solo = make("solo", 1), untagged = make(null, 1);
  assert.ok(group.includes(CANDID.group) && !group.includes(CANDID.coached));
  assert.ok(coached.includes(CANDID.coached) && !coached.includes(CANDID.group));
  for (const p of [solo, untagged]) assert.ok(!p.includes("CANDID:"), "a single person gets no class wording");
  for (const p of [group, coached, solo, untagged]) {
    assert.ok(p.includes(REAL_CLAUSE));
    assert.match(p, /nobody looks into the camera/);
    // Naming a fault invites it (the flame sconce, 2026-09-10): the prompt only says what is real.
    assert.doesNotMatch(p, /\b(float\w*|fused|merg\w*|extra (fingers?|limbs?)|warped|identical|in unison|in sync|clone\w*|line-?ups?)\b/i);
  }
});
