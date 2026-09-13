/**
 * Offline tests for the scene refresh (refresh-scenes.mjs) and the library it writes (scene-library.mjs).
 *
 *   node --test skills/references/refresh-scenes.test.mjs
 *
 * No network and no Gemini spend: the text model and the reference reader are faked. What is proven:
 * the gaps are worked out from the live library; the request carries the gym, the rules and every
 * existing scene; bad drafts are dropped with reasons; approve and reject write what they say and never
 * delete; a reference image reaches the reader only; a gendered refresh never drafts the other gender.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sceneGaps, coverFromGaps, buildRefreshRequest, validateDrafts, nearDuplicate, draftScenes, readReference, normaliseDescription, layoutFromPosition, validateDirection, parseCover, referencePath, MAX_DRAFT_CALLS } from "./refresh-scenes.mjs";
import { loadScenes, readLibrary, approveScenes, rejectScene, libraryStatus, sceneSummary, isRetired, isDraft } from "./scene-library.mjs";
import { planVisuals, validateBrief } from "./plan-offer-batch.mjs";
import { loadCatalogue } from "./render-composites.mjs";

const CAT = loadCatalogue();
const LIB = [
  { id: "m-squat", audience: "men", pose: "upright", people: 1, exercise: "back-squat", age: "prime", setting: "solo", equipment: "barbell", muscles: "legs", scene: "A man in his thirties mid-set of a barbell back squat in a rack, chest up." },
  { id: "m-press", audience: "men", pose: "compact", people: 1, exercise: "shoulder-press", age: "young", setting: "solo", equipment: "dumbbells", muscles: "shoulders", scene: "A man in his twenties seated, pressing dumbbells overhead with effort on his face." },
  { id: "w-swing", audience: "women", pose: "upright", people: 1, exercise: "kettlebell-swing", age: "prime", setting: "solo", equipment: "kettlebell", muscles: "full-body", scene: "A woman in her thirties at the top of a kettlebell swing on the open floor, hips locked out." },
  { id: "w-plank", audience: "women", pose: "low", people: 3, exercise: "plank", age: "prime", setting: "group", equipment: "bodyweight", muscles: "core", scene: "Three women holding forearm planks on black mats, loosely spaced, one grinning at the next." },
  { id: "w-lunge-old", audience: "women", pose: "upright", people: 1, exercise: "lunge", age: "older", setting: "solo", equipment: "bodyweight", muscles: "legs", scene: "A woman in her late fifties stepping into a walking lunge across the floor, steady and focused." },
  { id: "a-pair", audience: "any", pose: "upright", people: 2, exercise: "deadlift", age: "prime", setting: "coached", equipment: "barbell", muscles: "back", scene: "A coach watching a client set up a barbell deadlift, a hand ready at her back." },
  { id: "w-row-old", audience: "women", pose: "compact", people: 1, exercise: "cable-row", age: "older", setting: "solo", equipment: "cable", muscles: "back", scene: "A woman in her sixties seated at the cable row, pulling the handle to her ribs.", status: "retired", reason: "we have no cable row", retired_on: "2026-09-01" },
  { id: "w-curl", audience: "women", pose: "compact", people: 1, exercise: "curl", age: "young", setting: "solo", equipment: "dumbbells", muscles: "arms", scene: "A young woman curling dumbbells by the rack, eyes on the weight.", draft: true, source: "refresh", added: "2026-09-10" },
];
const PROFILE = { display_name: "Test Gym", formerly: "OldName Fitness", brand_lock: { photography: { must: ["the real Test Gym premises", "red walls"], never: ["the OldName wordmark or any text reading OldName", "before-and-after body comparisons"], people: "SEA mix, 20-65" } } };

function brand({ approved = true, scenes = LIB } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "refresh-"));
  writeFileSync(join(dir, "gym-profile.json"), JSON.stringify(PROFILE));
  writeFileSync(join(dir, "scenes.json"), JSON.stringify({ approved, scenes }, null, 2));
  return dir;
}
const draft = (id, over = {}) => ({ id, audience: "women", pose: "upright", people: 1, exercise: "step-up", age: "older", setting: "solo", equipment: "dumbbells", muscles: "legs", scene: `A woman in her fifties stepping onto a box holding dumbbells at her sides, breathing hard but smiling (${id}).`, ...over });

// ── R1 gaps ───────────────────────────────────────────────────────────────

test("R1 gaps are worked out from the live library per audience; drafts and retired scenes do not count", () => {
  const g = sceneGaps(LIB, { audience: "women" });
  assert.equal(g.live, 3, "w-swing, w-plank, w-lunge-old — not the draft, not the retired one, not the mixed pair");
  const count = (tag, value) => g.tags.find((t) => t.tag === tag && t.value === value).count;
  assert.equal(count("setting", "coached"), 0);
  assert.equal(count("equipment", "cable"), 0, "the retired cable row does not count");
  assert.equal(count("equipment", "dumbbells"), 0, "the draft curl does not count");
  assert.equal(count("age", "prime"), 2);
  assert.deepEqual(g.exercises, ["kettlebell-swing", "lunge", "plank"]);
  assert.ok(g.tags[0].count <= g.tags.at(-1).count, "thinnest first");
  const any = sceneGaps(LIB, { audience: "any" });
  assert.equal(any.live, 1, "an ungendered refresh sees the mixed scenes only");
  const men = sceneGaps(LIB, { audience: "men", mustShow: { exercise: ["lunge"], age: ["older"] } });
  assert.deepEqual(men.wanted, [{ tag: "exercise", value: "lunge" }, { tag: "age", value: "older" }], "must_show values nothing shows are wanted");
  const cover = coverFromGaps(men, 4);
  assert.deepEqual(cover.slice(0, 2).map((c) => `${c.tag}:${c.value}`), ["exercise:lunge", "age:older"], "what was asked for comes first");
  assert.ok(cover.every((c) => c.count === 0), `then the thinnest: ${JSON.stringify(cover)}`);
  const perTag = {}; for (const c of cover) perTag[c.tag] = (perTag[c.tag] || 0) + 1;
  assert.ok(Object.values(perTag).every((n) => n <= 2), "at most two per tag");
  assert.deepEqual(parseCover("exercise:lunge, age:older"), [{ tag: "exercise", value: "lunge" }, { tag: "age", value: "older" }]);
  assert.throws(() => parseCover("age:teen"), /not one of/);
  assert.throws(() => parseCover("colour:red"), /unknown tag/);
});

// ── R2 the request ────────────────────────────────────────────────────────

test("R2 the request carries the gym (names scrubbed), the vocabularies, the rules, the direction and every existing scene, live and retired", () => {
  const { prompt, schema } = buildRefreshRequest({ audience: "women", count: 2, direction: { kind: "gaps", cover: [{ tag: "setting", value: "coached", count: 0 }], exercises: ["lunge"] }, scenes: LIB, photography: PROFILE.brand_lock.photography, brandNames: ["Test Gym", "OldName"] });
  assert.match(prompt, /the real premises; red walls/, "the lock, with the client's name scrubbed");
  assert.doesNotMatch(prompt, /Test Gym|OldName/, "no brand name reaches the drafter");
  assert.match(prompt, /Never: before-and-after body comparisons/, "the never-list, minus the items about words");
  assert.match(prompt, /PEOPLE: SEA mix, 20-65/);
  assert.match(prompt, /AUDIENCE: women/);
  for (const w of ["upright", "compact", "low", "young", "prime", "older", "solo", "coached", "group", "kettlebell", "full-body"]) assert.ok(prompt.includes(w), `vocabulary: ${w}`);
  assert.match(prompt, /CANDID:.*Nobody looks into the camera/);
  assert.match(prompt, /REAL:/);
  assert.match(prompt, /never uses quotation marks/);
  assert.match(prompt, /thin on setting coached \(0 scenes\)/, "the gaps");
  assert.match(prompt, /library does not have yet \(it has: lunge\)/);
  for (const s of LIB) assert.ok(prompt.includes(`- ${s.id} [`), `existing scene listed: ${s.id}`);
  assert.match(prompt, /w-row-old \[.*\] \(retired: we have no cable row\)/, "a retired scene is sent as do-not-repeat, with its reason");
  assert.match(prompt, /w-curl \[.*\] \(draft\)/, "drafts too");
  assert.match(prompt, /Write exactly 2 scenes/);
  assert.equal(schema.properties.scenes.items.required.length, 10);
  const words = buildRefreshRequest({ audience: "any", count: 1, direction: { kind: "words", words: "older women doing walking lunges with a coach" }, scenes: [] }).prompt;
  assert.match(words, /DIRECTION from the owner: older women doing walking lunges with a coach/);
  assert.match(words, /\(none yet\)/);
  assert.throws(() => buildRefreshRequest({ audience: "kids" }), /audience must be one of/);
});

// ── R3 validation ─────────────────────────────────────────────────────────

test("R3 drafts are validated in code: bad ones are dropped with a reason, the rest are kept", () => {
  const drafts = [
    draft("w-step-up"),
    draft("w-pair-row", { people: 2, setting: "coached", scene: "Two women side by side, each holding a dumbbell row, matching each other." }),
    draft("w-swing", { scene: "A woman at the bottom of a heavy kettlebell swing, hips back." }),
    draft("w-swing-again", { scene: "A woman in her thirties at the top of a kettlebell swing on the open floor, hips locked out and strong." }),
    draft("w-class", { people: 7, setting: "group", scene: "Seven women in a circuit class, each at a different station." }),
    draft("w-two-solo", { people: 2, scene: "Two women at the rack." }),
    draft("m-bench", { audience: "men", scene: "A man pressing a barbell on the bench, spotter behind." }),
    draft("w-sign", { scene: "A woman stretching under the OldName sign by the window." }),
    draft("w-slogan", { scene: "A woman resting after a set, the words JOIN NOW painted behind her." }),
    draft("w-step-up-2", { scene: 'A woman reading a "PUSH" poster mid-set.' }),
    draft("Bad Id!", { scene: "A woman doing hip thrusts with a barbell across her hips, eyes shut with effort." }),
    draft("w-hip-thrust", { scene: "A woman doing hip thrusts with a barbell across her hips, eyes shut with effort." }),
    draft("w-hip-thrust", { scene: "A woman on a leg press, feet high on the plate, mid-push." }),
  ];
  const { kept, dropped } = validateDrafts(drafts, { scenes: LIB, audience: "women", forbidden: ["OldName", "JOIN NOW"] });
  const why = Object.fromEntries(dropped.map((d) => [d.id, d.reason]));
  assert.deepEqual(kept.map((d) => d.id), ["w-step-up", "w-hip-thrust"], `kept: ${kept.map((d) => d.id)}; dropped: ${JSON.stringify(why)}`);
  assert.match(why["w-pair-row"], /side by side/, "uniformity wording");
  assert.match(why["w-swing"], /id "w-swing" is taken/);
  assert.match(why["w-swing-again"], /near-copy of w-swing/);
  assert.match(why["w-class"], /people must be 1 to 6/);
  assert.match(why["w-two-solo"], /a solo scene has 1 person/);
  assert.match(why["m-bench"], /audience is "men"; this refresh is for women/);
  assert.match(why["w-sign"], /names "OldName"/);
  assert.match(why["w-slogan"], /names "JOIN NOW"/);
  assert.match(why["w-step-up-2"], /quotation marks/);
  assert.match(why["bad id!"], /lower-case slug/);
  assert.equal(dropped.filter((d) => d.id === "w-hip-thrust").length, 1, "the second w-hip-thrust clashes with the first, kept one");
  assert.match(dropped.find((d) => d.id === "w-hip-thrust").reason, /is taken/);
  // A near-copy of a retired scene is refused too — that is what retiring is for.
  const { dropped: d2 } = validateDrafts([draft("w-cable", { people: 1, scene: "A woman in her sixties seated at the cable row, pulling the handle to her ribs." })], { scenes: LIB, audience: "women" });
  assert.match(d2[0].reason, /near-copy of w-row-old \(retired\)/);
  assert.ok(nearDuplicate("A woman pressing dumbbells overhead on a bench", "A woman on a bench pressing dumbbells overhead"));
  assert.ok(!nearDuplicate("A woman pressing dumbbells overhead on a bench", "A man at the bottom of a heavy back squat"));
});

// ── R4 approve / reject ───────────────────────────────────────────────────

test("R4 approve clears the draft with a date; reject needs a reason and retires, never deletes; retired scenes never load", () => {
  const dir = brand();
  try {
    const p = join(dir, "scenes.json");
    assert.deepEqual(loadScenes(p).map((s) => s.id), ["m-squat", "m-press", "w-swing", "w-plank", "w-lunge-old", "a-pair"], "no draft, no retired scene");
    assert.ok(!loadScenes(p, { allowDraft: true }).some((s) => s.id === "w-row-old"), "not even for a dry run");
    assert.deepEqual(libraryStatus(readLibrary(p)), { approved: true, counts: { men: 2, women: 3, any: 1 }, total: 6, drafts: 1, retired: 1 });
    const r = approveScenes(p, ["w-curl", "w-swing"], { date: "2026-09-13" });
    assert.deepEqual(r, { approved: ["w-curl"], already: ["w-swing"] });
    const curl = readLibrary(p).scenes.find((s) => s.id === "w-curl");
    assert.equal(curl.draft, undefined); assert.equal(curl.approved_on, "2026-09-13"); assert.equal(curl.source, "refresh");
    assert.ok(loadScenes(p).some((s) => s.id === "w-curl"), "approved scenes load");
    assert.throws(() => approveScenes(p, ["nope"]), /no such scene: nope/);
    assert.throws(() => approveScenes(p, ["w-row-old"]), /is retired/);
    assert.throws(() => rejectScene(p, "w-plank", ""), /needs a reason/);
    assert.throws(() => rejectScene(p, "w-plank"), /needs a reason/);
    const before = readLibrary(p).scenes.length;
    const rj = rejectScene(p, "w-plank", "planks read as a yoga class", { date: "2026-09-13" });
    assert.deepEqual(rj, { retired: "w-plank", reason: "planks read as a yoga class" });
    const lib = readLibrary(p), plank = lib.scenes.find((s) => s.id === "w-plank");
    assert.equal(lib.scenes.length, before, "nothing deleted");
    assert.equal(plank.status, "retired"); assert.equal(plank.reason, "planks read as a yoga class"); assert.equal(plank.retired_on, "2026-09-13");
    assert.equal(plank.scene, LIB[3].scene, "the wording is kept");
    assert.ok(!loadScenes(p).some((s) => s.id === "w-plank"));
    assert.throws(() => rejectScene(p, "w-plank", "again"), /already retired/);
    assert.throws(() => planVisuals({ count: 1, scenes: loadScenes(p).filter((s) => s.id === "none"), audience: "women", catalogue: CAT }), /no scene in the library suits/);
    assert.match(sceneSummary(plank), /^w-plank \[women, group, 3 people, plank, prime, bodyweight\] \(retired: planks read as a yoga class\): Three women/);
    assert.ok(isRetired(plank) && !isDraft(plank));
    const st = libraryStatus(readLibrary(p));
    assert.deepEqual([st.total, st.drafts, st.retired], [6, 0, 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── R5 a reference image ──────────────────────────────────────────────────

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const READ = { activity: "A coach steadies a woman's elbow as she presses a dumbbell overhead, both smiling", exercise: "shoulder press", people_count: 2, ages: ["prime"], setting: "coached", equipment: "dumbbells", muscles: "shoulders", framing: "waist-up", subject_position: "left", subject_height: "middle", lighting: "bright daylight", energy: "cheerful", text_seen: ["JOIN NOW", "6 WEEK CHALLENGE"], brands_seen: ["Iron Works"] };

test("R5 a reference is read into words by the reader only; the drafts keep its head count, setting, framing and side; its words never appear", async () => {
  const dir = brand();
  try {
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "ad.png"), PNG);
    const calls = [];
    const ask = async (image, text, schema, opts) => {
      calls.push({ image, text, model: opts?.model });
      if (image) return READ;
      // The drafter: one draft strays on head count, one names the reference's words, one is right.
      return { scenes: [
        { id: "w-press-coach", audience: "women", pose: "upright", people: 2, exercise: "shoulder-press", age: "prime", setting: "coached", equipment: "dumbbells", muscles: "shoulders", scene: "A coach cupping a woman's elbow as she presses a dumbbell overhead by the red wall, both laughing at a wobble." },
        { id: "w-press-solo", audience: "women", pose: "compact", people: 1, exercise: "shoulder-press", age: "prime", setting: "solo", equipment: "dumbbells", muscles: "shoulders", scene: "A woman pressing dumbbells overhead alone by the window, focused." },
        { id: "w-press-sign", audience: "women", pose: "compact", people: 2, exercise: "shoulder-press", age: "prime", setting: "coached", equipment: "dumbbells", muscles: "shoulders", scene: "A coach and client pressing under the JOIN NOW banner." },
      ] };
    };
    const logs = [];
    const r = await draftScenes({ brandDir: dir, audience: "women", count: 1, direction: { reference: "ad.png" }, ask, catalogue: CAT, date: "2026-09-13", log: (m) => logs.push(m) });
    assert.equal(r.vision_calls, 1); assert.equal(r.text_calls, 1);
    assert.equal(calls[0].image, join(dir, "references", "ad.png"), "the image goes to the reader");
    assert.match(calls[0].text, /Ignore the graphic layer/);
    assert.equal(calls[1].image, null, "the drafter gets words only — never the image");
    assert.doesNotMatch(calls[1].text, /JOIN NOW|6 WEEK|Iron Works|ad\.png/, "nothing written on the reference, and not its file, reaches the drafter");
    assert.match(calls[1].text, /coach steadies a woman's elbow/, "the reader's description does");
    assert.match(calls[1].text, /head count \(2\), setting \(coached\), framing \(waist-up\)/);
    assert.match(calls[1].text, /people = 2, setting = coached, pose = compact/);
    assert.deepEqual(r.drafts.map((d) => d.id), ["w-press-coach"]);
    const d = r.drafts[0];
    assert.equal(d.pose, "compact", "waist-up framing → compact, whatever the model said");
    assert.equal(d.prefer_layout, "t3-right-column", "people on the left → the right-column layout");
    assert.deepEqual([d.people, d.setting], [2, "coached"]);
    assert.equal(d.draft, true); assert.equal(d.source, "refresh"); assert.equal(d.added, "2026-09-13");
    assert.equal(d.direction.reference, "references/ad.png"); assert.match(d.direction.summary, /2 coached, waist-up, left/);
    const why = Object.fromEntries(r.dropped.map((x) => [x.id, x.reason]));
    assert.match(why["w-press-solo"], /1 people; the reference has 2/);
    assert.match(why["w-press-sign"], /names "JOIN NOW"/);
    assert.ok(existsSync(join(dir, "references", "ad.png.description.json")), "the reading is cached beside the image");
    const lib = readLibrary(join(dir, "scenes.json"));
    assert.ok(lib.scenes.some((s) => s.id === "w-press-coach" && s.draft === true), "written as a draft");
    // A second refresh from the same reference reads nothing again.
    const r2 = await draftScenes({ brandDir: dir, audience: "women", count: 1, direction: { reference: "ad.png", words: "make it an evening class" }, ask: async (image, text) => { calls.push({ image, text }); return { scenes: [] }; }, catalogue: CAT, log: () => {} });
    assert.equal(r2.vision_calls, 0);
    assert.match(calls.at(-1).text, /make it an evening class/, "words given with a reference are folded in");
    // The planner takes the preferred layout when the pose fits it.
    const v = planVisuals({ count: 1, scenes: [d], audience: "women", seed: "x", catalogue: CAT });
    assert.equal(v[0].treatment, "t3-right-column");
    const v2 = planVisuals({ count: 1, scenes: [{ ...d, prefer_layout: "t2-top-bottom-split" }], audience: "women", seed: "x", catalogue: CAT });
    assert.notEqual(v2[0].treatment, "t2-top-bottom-split", "a preference the pose cannot fill is ignored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The reader's answer is tidied to the vocabularies.
  const n = normaliseDescription({ ...READ, people_count: 4, setting: "solo", framing: "floor", subject_position: "center", equipment: "sandbag", ages: ["prime", "teen"] }, { catalogue: CAT });
  assert.deepEqual([n.people, n.setting, n.pose, n.subject_position, n.equipment, n.ages, n.exercise], [4, "group", "low", "centre", null, ["prime"], "shoulder-press"]);
  assert.equal(n.prefer_layout, "t5-offer-band", "centred and low → the band layout");
  assert.equal(layoutFromPosition("centre", "upright", CAT), "t4-centred-stack");
  assert.equal(layoutFromPosition("centre", "compact", CAT), "t1-bottom-stack");
  assert.equal(layoutFromPosition("right", "low", CAT), "t6-left-column");
});

test("R5b a direction is validated: words or a reference image that exists, nothing else", () => {
  const dir = brand();
  try {
    mkdirSync(join(dir, "references")); writeFileSync(join(dir, "references", "ad.jpg"), PNG); writeFileSync(join(dir, "references", "notes.txt"), "x");
    assert.deepEqual(validateDirection({ words: "older women, walking lunges" }, { brandDir: dir }), []);
    assert.deepEqual(validateDirection({ reference: "ad.jpg" }, { brandDir: dir }), []);
    assert.equal(referencePath("ad.jpg", dir), join(dir, "references", "ad.jpg"));
    assert.ok(validateDirection({}, { brandDir: dir }).some((e) => /needs words, a reference image, or both/.test(e)));
    assert.ok(validateDirection({ words: "x" }, { brandDir: dir }).some((e) => /a few words at least/.test(e)));
    assert.ok(validateDirection({ words: "y".repeat(601) }, { brandDir: dir }).some((e) => /limit is 600/.test(e)));
    assert.ok(validateDirection({ reference: "missing.png" }, { brandDir: dir }).some((e) => /not found/.test(e)));
    assert.ok(validateDirection({ reference: "notes.txt" }, { brandDir: dir }).some((e) => /must be an image/.test(e)));
    assert.ok(validateDirection({ words: "fine words", extra: 1 }, { brandDir: dir }).some((e) => /unknown field "extra"/.test(e)));
    assert.ok(validateDirection("words", { brandDir: dir }).some((e) => /must be an object/.test(e)));
    // In a brief: with generated photos, never beside the brief's own scenes.
    const brief = { batch_id: "b-1", offer: "12 Week Reset", locations: ["BISHAN"], audience: "LADIES WANTED", generated: 2, real: [], max_calls: 2, direction: { words: "older women, walking lunges" } };
    assert.deepEqual(validateBrief(brief, { brandDir: dir }), []);
    assert.ok(validateBrief({ ...brief, generated: 0, real: ["x"] }, { brandDir: dir }).some((e) => /direction needs generated photos/.test(e)));
    assert.ok(validateBrief({ ...brief, scenes: [LIB[2], LIB[2]] }, { brandDir: dir }).some((e) => /direction and scenes cannot both/.test(e)));
    assert.ok(validateBrief({ ...brief, direction: { reference: "missing.png" } }, { brandDir: dir }).some((e) => /direction: reference image not found/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── R6 a refresh end to end (offline) ─────────────────────────────────────

test("R6 a refresh: gaps → one text call → validated drafts appended; a shortfall gets one more call, never a third; a dry run writes nothing", async () => {
  const dir = brand();
  try {
    const p = join(dir, "scenes.json");
    const prompts = [];
    let n = 0;
    const ask = async (image, text) => {
      prompts.push(text); n++;
      // First answer: two good, one near-copy of a live scene. Second: the shortfall, plus one dud.
      if (n === 1) return { scenes: [draft("w-step-up"), draft("w-swing-copy", { scene: "A woman in her thirties at the top of a kettlebell swing on the open floor, hips locked out." }), draft("w-box-jump", { exercise: "box-jump", scene: "A woman landing a box jump softly, arms back, breath held." })] };
      return { scenes: [draft("w-goblet", { exercise: "goblet-squat", scene: "A woman at the bottom of a goblet squat, kettlebell tight to her chest, eyes forward." }), draft("w-goblet", { scene: "Another goblet squat with the same wording as the last one, kettlebell tight to her chest." })] };
    };
    const logs = [];
    const r = await draftScenes({ brandDir: dir, audience: "women", count: 3, ask, catalogue: CAT, date: "2026-09-13", log: (m) => logs.push(m) });
    assert.equal(r.text_calls, 2); assert.equal(r.vision_calls, 0);
    assert.deepEqual(r.drafts.map((d) => d.id), ["w-step-up", "w-box-jump", "w-goblet"]);
    assert.equal(r.dropped.length, 2);
    assert.match(prompts[0], /Write exactly 3 scenes/);
    assert.match(prompts[1], /Write exactly 1 scene\b/, "the second call asks for the shortfall only");
    assert.match(prompts[1], /- w-step-up \[/, "and is told what the first call drafted");
    assert.match(prompts[0], /thin on/);
    assert.ok(r.drafts.every((d) => d.draft === true && d.source === "refresh" && d.added === "2026-09-13" && Array.isArray(d.covers)), JSON.stringify(r.drafts[0]));
    // Each draft records the gaps it fills: the step-up (older, solo, dumbbells, legs) covers what was thin among those.
    const asked = r.direction.cover.map((c) => `${c.tag}:${c.value}`);
    for (const d of r.drafts) for (const c of d.covers) { const [tag, value] = c.split(":"); assert.ok(asked.includes(c) && d[tag] === value, `${d.id} says it covers ${c}`); }
    assert.ok(r.drafts[0].covers.includes("equipment:dumbbells"), `${r.drafts[0].id}: ${r.drafts[0].covers} (asked: ${asked})`);
    const lib = readLibrary(p);
    assert.equal(lib.scenes.length, LIB.length + 3, "appended");
    assert.ok(lib.scenes.slice(0, LIB.length).every((s, i) => s.id === LIB[i].id), "nothing before them touched");
    assert.ok(!loadScenes(p).some((s) => s.id === "w-goblet"), "drafts do not load for a batch until approved");
    assert.equal(loadScenes(p, { allowDraft: true }).filter((s) => s.id === "w-goblet").length, 1);
    // Told what to cover: the cover list, not the computed gaps, and only what it asked for.
    const r2 = await draftScenes({ brandDir: dir, audience: "women", count: 1, cover: parseCover("exercise:hip-thrust"), ask: async (i, text) => { prompts.push(text); return { scenes: [draft("w-hip", { exercise: "hip-thrust", scene: "A woman driving her hips up under a barbell, shoulders on the bench, jaw set." })] }; }, catalogue: CAT, log: () => {} });
    assert.match(prompts.at(-1), /thin on exercise hip-thrust \(0 scenes\)/);
    assert.deepEqual(r2.drafts[0].covers, ["exercise:hip-thrust"]);
    // Always short: two calls, then stop.
    let calls = 0;
    const r3 = await draftScenes({ brandDir: dir, audience: "men", count: 2, ask: async () => { calls++; return { scenes: [] }; }, catalogue: CAT, dryRun: true, log: () => {} });
    assert.equal(calls, MAX_DRAFT_CALLS); assert.equal(r3.drafts.length, 0);
    // A dry run writes nothing.
    const before = readLibrary(p).scenes.length;
    const r4 = await draftScenes({ brandDir: dir, audience: "men", count: 1, ask: async () => ({ scenes: [draft("m-row", { audience: "men", exercise: "dumbbell-row", scene: "A man in his forties rowing a dumbbell on a bench, elbow high, face set." })] }), catalogue: CAT, dryRun: true, log: () => {} });
    assert.equal(r4.drafts.length, 1); assert.equal(readLibrary(p).scenes.length, before, "dry run: not written");
    // A bad answer (thrown by the call) costs the call and is tried once more, no more.
    let tries = 0;
    const r5 = await draftScenes({ brandDir: dir, audience: "men", count: 1, ask: async () => { tries++; throw new Error("bad JSON"); }, catalogue: CAT, dryRun: true, log: () => {} });
    assert.equal(tries, 2); assert.equal(r5.text_calls, 2); assert.equal(r5.drafts.length, 0);
    await assert.rejects(draftScenes({ brandDir: dir, audience: "kids", count: 1, ask }), /audience must be one of/);
    await assert.rejects(draftScenes({ brandDir: dir, audience: "men", count: 0, ask }), /count must be 1 to 12/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── R7 audience ───────────────────────────────────────────────────────────

test("R7 an ungendered refresh drafts mixed scenes; a gendered one never keeps the other gender's", async () => {
  const dir = brand();
  try {
    const prompts = [];
    const both = (audience) => ({ scenes: [
      draft(`${audience === "any" ? "a" : audience[0]}-good`, { audience, people: 2, setting: "coached", scene: `A coach and a client working through a dumbbell step-up, the coach's hand at the ready (${audience}).` }),
      draft("m-stray", { audience: "men", scene: "A man in his forties pressing a barbell on the bench, spotter's hands hovering." }),
      draft("w-stray", { audience: "women", scene: "A woman at the top of a pull-up, chin over the bar, legs crossed." }),
    ] });
    const ra = await draftScenes({ brandDir: dir, audience: "any", count: 1, ask: async (i, text) => { prompts.push(text); return both("any"); }, catalogue: CAT, dryRun: true, log: () => {} });
    assert.deepEqual(ra.drafts.map((d) => [d.id, d.audience]), [["a-good", "any"]]);
    assert.match(prompts[0], /AUDIENCE: any — every scene shows a mix of men and women/);
    assert.match(prompts[0], /starting with "a-"/);
    const rw = await draftScenes({ brandDir: dir, audience: "women", count: 2, ask: async (i, text) => { prompts.push(text); return both("women"); }, catalogue: CAT, dryRun: true, log: () => {} });
    assert.deepEqual(rw.drafts.map((d) => d.id), ["w-good", "w-stray"]);
    assert.ok(rw.dropped.some((d) => d.id === "m-stray" && /audience is "men"/.test(d.reason)));
    assert.match(prompts[1], /AUDIENCE: women — every scene shows women/);
    const rm = await draftScenes({ brandDir: dir, audience: "men", count: 1, ask: async () => both("men"), catalogue: CAT, dryRun: true, log: () => {} });
    assert.ok(rm.drafts.every((d) => d.audience === "men") && !rm.drafts.some((d) => d.id === "w-stray"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
