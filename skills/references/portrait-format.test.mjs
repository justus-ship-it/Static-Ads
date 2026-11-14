/**
 * portrait-format.test.mjs — the studio-portrait format (Phase 3 of the formats plan, 2026-11-10).
 *
 * A scene has a FORMAT (workout unless it says otherwise). A studio portrait is one person or a pair at ease on a
 * plain backdrop: it is asked for differently (posed, a smile, a look into the lens; no room on a plain backdrop),
 * judged differently (posed is correct) and drafted differently (backdrops, stances; the gym's own results as a guide).
 * No model call, no image call: every model is a stub.
 *
 *   node --test skills/references/portrait-format.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENE_FORMATS, PORTRAIT_TAGS, formatOf, sceneProblems, sceneWarnings, sceneSummary, libraryStatus, loadScenes } from "./scene-library.mjs";
import { buildVisualPrompt, needsRoom, PORTRAIT_SHOT, BACKDROP_CLAUSE, ANCHOR_CLAUSE, ANCHOR_CLAUSE_PLAIN, CANDID } from "./visual-prompts.mjs";
import { judgeQuality, checkQuality } from "./check-quality.mjs";
import { generateVisuals } from "./generate-visuals.mjs";
import { buildRefreshRequest, validateDrafts, draftScenes, portraitGaps } from "./refresh-scenes.mjs";
import { formatGuideFrom, GUIDE_ATTRIBUTES } from "./what-wins.mjs";
import { BACKDROPS, POSES as READ_POSES, EXPRESSIONS, FORMATS as READ_FORMATS } from "./read-creatives.mjs";
import { validateProfile, PROFILE_STARTER, CREATIVE_DEFAULTS } from "./client-config.mjs";
import { loadCatalogue } from "./render-composites.mjs";

const FORMULA = loadCatalogue({ look: "formula" });
const portrait = (id, over = {}) => ({ id, audience: "women", format: "studio-portrait", pose: "upright", people: 1, age: "prime", backdrop: "seamless-colour", stance: "easy-posed", expression: "smile", eye_contact: true,
  scene: `A woman in her early thirties in a navy tank top, standing relaxed with her hands on her hips and a warm smile, looking into the camera, against a seamless flat pink studio backdrop (${id}).`, ...over });
const WORKOUT = { id: "w-swing", audience: "women", pose: "upright", people: 1, exercise: "kettlebell-swing", age: "prime", setting: "solo", equipment: "kettlebell", muscles: "full-body", scene: "A woman in her thirties at the top of a kettlebell swing on the open floor, hips locked out." };

test("SP1 a scene has a format: workout unless it says otherwise; a studio portrait names its backdrop, has one or two people and is never a coached session; its words are the creative readings' own; a gym's default format is an Ad default", () => {
  assert.deepEqual(Object.keys(SCENE_FORMATS), ["workout", "studio-portrait"]);
  assert.deepEqual([formatOf(WORKOUT), formatOf(portrait("p")), formatOf({ format: "nonsense" }), formatOf(null)], ["workout", "studio-portrait", "workout", "workout"]);
  assert.deepEqual(sceneProblems(WORKOUT), [], "every scene from before is a workout scene, untouched");
  assert.deepEqual(sceneProblems(portrait("p")), []);
  assert.deepEqual(sceneProblems(portrait("p", { people: 2, setting: undefined, scene: "A couple in their thirties standing side by side, each holding a pair of dumbbells at chest height, laughing, against a plain dark charcoal wall.", backdrop: "dark-wall", stance: "holding-equipment" })), []);
  assert.deepEqual(sceneProblems(portrait("p", { backdrop: undefined })), ["a studio-portrait scene names its backdrop: seamless-colour, dark-wall, gym-floor"]);
  assert.deepEqual(sceneProblems(portrait("p", { people: 3 })), ["a studio-portrait scene has 1 or 2 people"]);
  assert.deepEqual(sceneProblems(portrait("p", { people: 2, setting: "coached" })), ["a studio-portrait scene has no setting but solo (two people are a pair, not a coached session)"]);
  assert.deepEqual(sceneProblems(portrait("p", { backdrop: "beach", stance: "flexing", expression: "grimace", eye_contact: "yes" })), ["backdrop must be one of seamless-colour, dark-wall, gym-floor", "stance must be one of easy-posed, holding-equipment, stretch, walking", "expression must be one of smile, neutral", "eye_contact must be true or false"]);
  assert.deepEqual(sceneProblems({ ...WORKOUT, format: "poster" }), ["format must be one of workout, studio-portrait"]);
  // A pair posed side by side is the picture: no "moves as one" warning on a portrait, still one on a workout pair.
  const pair = "Two friends standing side by side, each holding a kettlebell, grinning.";
  assert.deepEqual(sceneWarnings({ scene: pair, people: 2, format: "studio-portrait" }), []);
  assert.equal(sceneWarnings({ scene: pair, people: 2, setting: "coached" }).length, 1);
  // The vocabulary is the readings' own, so a scene and Meta's numbers for ads like it are named alike.
  assert.ok(READ_FORMATS["studio-portrait"] && READ_FORMATS.workout);
  assert.ok(PORTRAIT_TAGS.backdrop.every((b) => BACKDROPS.includes(b)) && PORTRAIT_TAGS.stance.every((p) => READ_POSES.includes(p)) && PORTRAIT_TAGS.expression.every((e) => EXPRESSIONS.includes(e)));
  assert.match(sceneSummary(portrait("w-p-hips")), /^w-p-hips \[women, studio-portrait, seamless-colour, 1 person, easy-posed, prime\]/);
  assert.match(sceneSummary(WORKOUT), /^w-swing \[women, solo, 1 person, kettlebell-swing, prime, kettlebell\]/, "a workout scene's line is as it was");
  assert.deepEqual(libraryStatus({ approved: true, scenes: [WORKOUT, portrait("p1", { setting: "solo" }), portrait("p2", { audience: "any" }), portrait("p3", { draft: true })] }).formats, { workout: { total: 1, counts: { women: 1 } }, "studio-portrait": { total: 2, counts: { women: 1, any: 1 } } });
  // The gym's default.
  const p = PROFILE_STARTER("testgym", "Test Gym", "SG");
  assert.equal(CREATIVE_DEFAULTS.format, "workout");
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, format: "studio-portrait" } }).errors, []);
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, format: "poster" } }).errors.filter((e) => /format/.test(e)), ["creative_defaults.format must be one of workout, studio-portrait"]);
});

test("SP2 the image prompt: a portrait is asked for as a portrait — at ease, the scene's own expression and gaze, the portrait light, its backdrop — with no candid line, no workout shot guide and, on a plain backdrop, no room reference and no must-show; a workout prompt is word for word what it was", () => {
  const photography = { people: "Singaporean adults, 25 to 55", must: ["the real premises", "blue turf"], never: ["oiled fitness models"] };
  const guide = { rules: [{ rule: "Shoot at eye level." }], recipes: [{ name: "Solo lifter", when: "solo", camera: "eye level", moment: "mid-rep", light: "side light", background: "the gym" }] };
  const base = { treatment: "f1-callout-left", ratio: "4x5", photography, people: 1, age: 34, shotGuide: guide, catalogue: FORMULA };
  const P = buildVisualPrompt({ ...base, scene: portrait("p").scene, format: "studio-portrait", backdrop: "seamless-colour", hasReference: true }).prompt;
  assert.match(P, /^A realistic editorial portrait photograph for a gym's social media advert, portrait 4:5/);
  assert.match(P, /PEOPLE: Singaporean adults, 25 to 55\. Real people with natural builds and natural skin, not fitness models; relaxed and at ease, with the expression and the gaze the scene describes\. Exactly 1 person in the whole photo/);
  assert.ok(P.includes(PORTRAIT_SHOT) && P.includes(BACKDROP_CLAUSE["seamless-colour"]));
  assert.match(P, /AGE: the person is about 34 years old/);
  assert.ok(!/candid and mid-movement|nobody looks into the camera|private session|SHOT TYPE|mid-rep|CANDID/.test(P), "nothing that asks for a candid workout");
  assert.ok(!/reference photo|SETTING \(must show\)|blue turf/.test(P), "a plain backdrop shows no room: the reference and the must-show stay out");
  assert.match(P, /NEVER SHOW: oiled fitness models\./, "the never-list still stands");
  assert.match(P, /Text will be laid over .*No face may fall inside/, "composed around the layout like any photo");
  assert.match(P, /Frame it as a portrait photographer would, a few steps away/);
  assert.match(P, /keep the pose and step the camera back or in until it does/);
  // In front of the blurred gym, the room is the gym's: the reference and the must-show come back.
  const G = buildVisualPrompt({ ...base, scene: portrait("p", { backdrop: "gym-floor" }).scene, format: "studio-portrait", backdrop: "gym-floor", hasReference: true }).prompt;
  assert.ok(G.includes(BACKDROP_CLAUSE["gym-floor"]) && /The attached reference photo is the real gym\. Match its room/.test(G) && /SETTING \(must show\): the real premises; blue turf\./.test(G));
  assert.match(G, /Light the people as SHOT says/);
  assert.deepEqual([needsRoom({}), needsRoom({ format: "workout" }), needsRoom({ format: "studio-portrait", backdrop: "seamless-colour" }), needsRoom({ format: "studio-portrait", backdrop: "dark-wall" }), needsRoom({ format: "studio-portrait", backdrop: "gym-floor" })], [true, true, false, false, true]);
  // The 9:16 sibling of a portrait on a plain backdrop shows more backdrop, not more floor and ceiling.
  const S = buildVisualPrompt({ ...base, ratio: "9x16", scene: portrait("p").scene, format: "studio-portrait", backdrop: "dark-wall", anchor: true }).prompt;
  assert.ok(S.includes(ANCHOR_CLAUSE_PLAIN) && !S.includes(ANCHOR_CLAUSE));
  assert.ok(buildVisualPrompt({ ...base, ratio: "9x16", scene: WORKOUT.scene, anchor: true, setting: "solo" }).prompt.includes(ANCHOR_CLAUSE));
  // A workout prompt is what it was before formats: naming the format changes nothing.
  const W0 = buildVisualPrompt({ ...base, scene: WORKOUT.scene, setting: "solo", hasReference: true }).prompt;
  const W1 = buildVisualPrompt({ ...base, scene: WORKOUT.scene, setting: "solo", hasReference: true, format: "workout", backdrop: null }).prompt;
  assert.equal(W0, W1);
  assert.match(W0, /Real people, candid and mid-movement, not posed models; nobody looks into the camera\. It is a private session\./);
  assert.match(W0, /SHOT TYPE, Solo lifter/);
  assert.ok(buildVisualPrompt({ ...base, scene: "Three women in a class.", setting: "group", people: 3 }).prompt.includes(CANDID.group));
});

test("SP3 the generator attaches the room reference to the photos that show the room only; the checks are told the format; the quality rules: posed is correct for a portrait — a pair in the same pose looking into the lens passes, the same face twice still fails — and a workout's rules are unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portrait-gen-"));
  try {
    const ref = join(dir, "room.png");
    writeFileSync(ref, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const calls = [], checked = [];
    const visuals = [
      { id: "g01", treatment: "f1-callout-left", scene: portrait("a").scene, pose: "upright", people: 1, format: "studio-portrait", tags: { backdrop: "seamless-colour" } },
      { id: "g02", treatment: "f1-callout-left", scene: portrait("b", { backdrop: "gym-floor" }).scene, pose: "upright", people: 1, format: "studio-portrait", tags: { backdrop: "gym-floor" } },
      { id: "g03", treatment: "f1-callout-left", scene: WORKOUT.scene, pose: "upright", people: 1, tags: { setting: "solo" } },
    ];
    const r = await generateVisuals({
      visuals, outDir: dir, ratio: "4x5", refs: [ref], catalogue: FORMULA, checkRef: async () => [],
      generate: async (prompt, parts, opts) => { calls.push({ prompt, parts: parts.length, aspect: opts.aspectRatio }); return { buffer: Buffer.from("x"), ext: "png" }; },
      check: async (file, opts) => { checked.push(opts.format); return { ok: true, failures: [], notes: [], faces: [], focus: [0.5, 0.5], placement: { people_box: null, people_count: 1 } }; },
      log: () => {},
    });
    assert.deepEqual(r.results.map((x) => x.status), ["passed", "passed", "passed"]);
    assert.deepEqual(calls.map((c) => c.parts), [0, 1, 1], "no room reference on the plain backdrop; the blurred gym and the workout get it");
    assert.ok(!/reference photo/.test(calls[0].prompt) && /reference photo is the real gym/.test(calls[1].prompt) && /reference photo is the real gym/.test(calls[2].prompt));
    assert.deepEqual(checked, ["studio-portrait", "studio-portrait", "workout"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The rules.
  const pair = { exercise_shown: true, exercise_seen: "a couple holding dumbbells, smiling at the camera", problems: [], held: [], people_count: 2, poses_near_identical: true, interaction: false, coach_attending: true, looking_at_camera: 2, duplicate_faces: false };
  assert.deepEqual(judgeQuality(pair, { people: 2, format: "studio-portrait" }).failures, []);
  assert.deepEqual(judgeQuality(pair, { people: 2 }).failures, ["posed, not candid: the 2 people are near-copies of each other's pose", "2 of the 2 people look into the camera — posed"], "the same answer fails a workout photo, as before");
  assert.deepEqual(judgeQuality({ ...pair, duplicate_faces: true }, { people: 2, format: "studio-portrait" }).failures, ["the same face on more than one person"]);
  assert.deepEqual(judgeQuality({ ...pair, people_count: 1, exercise_shown: false, exercise_seen: "a man lifting a barbell" }, { people: 1, format: "studio-portrait" }).failures, ["not the scene: does not show the scene's exercise; it shows a man lifting a barbell"], "a different picture is still not the scene");
  assert.deepEqual(judgeQuality({ ...pair, people_count: 1, problems: [{ what: "a third arm", kind: "body", severity: "fatal", on_subject: true }] }, { people: 1, format: "studio-portrait" }).failures, ["looks fake (body): a third arm"]);
  // The question is the portrait's: asked with the format, the model is told a pose and a look into the lens are correct.
  const asked = [];
  const q = await checkQuality("x.png", { scene: portrait("p").scene, people: 1, format: "studio-portrait", ask: async (image, opts) => { asked.push(opts.format); return { ...pair, people_count: 1 }; }, confirm: async (image, items) => ({ kept: items, dismissed: [] }) });
  assert.deepEqual([q.ok, asked], [true, ["studio-portrait"]]);
});

test("SP4 the drafter writes portraits: its own brief (one person or a pair at ease, a backdrop named, no workout fields), the gym's own results as the guide, the backdrops it is thin on; drafts are made portraits in code whatever the model wrote; a workout refresh is as it was", async () => {
  const guide = { format: "studio-portrait", ads: 4, leads: 157, lines: ["Backdrop: dark-wall (136 leads at SGD 15.19), seamless-colour (21 leads at SGD 22.94)", "Subject: couple (86 leads at SGD 14.52), woman (71 leads at SGD 18.29)"] };
  const existing = [WORKOUT, portrait("w-p-hips")];
  const { prompt, schema } = buildRefreshRequest({ audience: "women", count: 4, format: "studio-portrait", direction: { kind: "variety", cover: [{ tag: "backdrop", value: "dark-wall", count: 0 }] }, scenes: existing, photography: { people: "Singaporean adults", never: ["oiled fitness models", "any text reading OldName"] }, guide });
  assert.match(prompt, /Each scene is one PORTRAIT photograph/);
  assert.match(prompt, /PORTRAIT: one person, or two who clearly know each other .* never a coach with a client, never a class\. They are at ease, never straining/);
  assert.match(prompt, /BACKDROP: every scene names one .* seamless-colour .* dark-wall .* gym-floor/);
  assert.match(prompt, /THE PEOPLE: Singaporean adults — natural builds, not fitness models\. Never: oiled fitness models\./);
  assert.ok(!/OldName|CANDID|SHOT TYPES|exercise \(a short/.test(prompt), "no words to show, no workout brief");
  assert.match(prompt, /id \(a new lower-case slug starting with "w-p-"/);
  assert.match(prompt, /WHAT THIS GYM'S OWN ADVERTS OF THIS KIND HAVE DONE[\s\S]*- Backdrop: dark-wall \(136 leads at SGD 15\.19\), seamless-colour \(21 leads at SGD 22\.94\)[\s\S]*- Subject: couple \(86 leads/);
  assert.match(prompt, /DIRECTION: the library is thin on backdrop dark-wall \(0 scenes\)/);
  assert.match(prompt, /EXISTING PORTRAIT SCENES[\s\S]*- w-p-hips \[women, studio-portrait/);
  assert.match(prompt, /Ids already taken by other scenes: w-swing\./);
  assert.match(prompt, /Write exactly 4 scenes/);
  assert.deepEqual(schema.properties.scenes.items.required, ["id", "audience", "pose", "people", "age", "backdrop", "stance", "expression", "eye_contact", "scene"]);
  // Without results the brief has no guide section; a workout request is the old one.
  assert.ok(!/OWN ADVERTS/.test(buildRefreshRequest({ audience: "women", count: 2, format: "studio-portrait", direction: { kind: "variety", cover: [] } }).prompt));
  const w = buildRefreshRequest({ audience: "women", count: 2, scenes: [WORKOUT] });
  assert.ok(/CANDID: when a scene has more than one person/.test(w.prompt) && !/PORTRAIT/.test(w.prompt) && w.schema.properties.scenes.items.required.includes("exercise"));
  assert.throws(() => buildRefreshRequest({ audience: "women", format: "poster" }), /format must be one of workout, studio-portrait/);
  // Validation: the format is set in code, workout tags go, a single person is solo; a bad backdrop or a crowd is dropped.
  const v = validateDrafts([
    { ...portrait("w-p-kettle", { scene: "A woman in her late twenties in a sage green top holding a kettlebell by the horn at her side, an easy smile, against a plain dark charcoal wall with soft side light.", backdrop: "dark-wall", stance: "holding-equipment" }), format: "workout", exercise: "none", equipment: "kettlebell", muscles: "", setting: "coached" },
    portrait("w-p-crowd", { people: 4, scene: "Four women laughing together in front of a seamless yellow backdrop after a class." }),
    portrait("w-p-beach", { backdrop: "outdoors", scene: "A woman stretching on a beach at sunrise, smiling at the horizon." }),
    portrait("w-p-hips", { scene: "A different woman entirely, sitting on a plyo box with her elbows on her knees, grinning, on a seamless teal backdrop." }),
  ], { scenes: existing, audience: "women", format: "studio-portrait" });
  assert.deepEqual(v.kept.map((d) => [d.id, d.format, d.setting, "exercise" in d, "equipment" in d, "muscles" in d]), [["w-p-kettle", "studio-portrait", "solo", false, false, false]]);
  assert.deepEqual(v.dropped.map((d) => [d.id, d.reason]), [["w-p-crowd", "a studio-portrait scene has 1 or 2 people"], ["w-p-beach", "backdrop must be one of seamless-colour, dark-wall, gym-floor"], ["w-p-hips", 'id "w-p-hips" is taken']]);
  // A workout refresh never keeps a portrait's fields.
  const wv = validateDrafts([{ ...WORKOUT, id: "w-new", scene: "A woman pressing a pair of dumbbells overhead from a bench, jaw set, mid-rep.", exercise: "shoulder-press", backdrop: "dark-wall", stance: "easy-posed", format: "studio-portrait" }], { scenes: existing, audience: "women" });
  assert.deepEqual(wv.kept.map((d) => [d.id, "format" in d, "backdrop" in d, "stance" in d]), [["w-new", false, false, false]]);
  // Gaps: the backdrops this audience has fewest of, first.
  assert.deepEqual(portraitGaps([portrait("a"), portrait("b"), portrait("c", { backdrop: "dark-wall" }), portrait("d", { backdrop: "gym-floor", draft: true }), portrait("e", { audience: "men" })], { audience: "women" }), { live: 3, cover: [{ tag: "backdrop", value: "gym-floor", count: 0 }, { tag: "backdrop", value: "dark-wall", count: 1 }, { tag: "backdrop", value: "seamless-colour", count: 2 }] });
  // A refresh end to end: one text call, the drafts written as portrait drafts with what they cover; nothing generates from them until approved.
  const dir = mkdtempSync(join(tmpdir(), "portrait-refresh-"));
  try {
    writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym", brand_lock: { photography: { people: "Singaporean adults" } } }));
    writeFileSync(join(dir, "scenes.json"), JSON.stringify({ approved: true, scenes: [WORKOUT] }));
    const prompts = [], logs = [];
    const r = await draftScenes({ brandDir: dir, audience: "women", count: 2, format: "studio-portrait", guide, date: "2026-11-10", log: (m) => logs.push(m),
      ask: async (image, text, schema) => { prompts.push(text); assert.ok(schema.properties.scenes.items.properties.backdrop); return { scenes: [
        portrait("w-p-band", { scene: "A woman in her mid twenties in a black sports top holding a looped resistance band at waist height, a half smile toward the camera, against a seamless mustard yellow studio backdrop." }),
        portrait("w-p-wall", { backdrop: "dark-wall", stance: "easy-posed", eye_contact: false, scene: "A woman in her forties in a rust-coloured top leaning one shoulder on a raw grey concrete wall, one hand on her hip, smiling past the camera in soft side light." }),
      ] }; } });
    assert.deepEqual([r.text_calls, r.vision_calls, r.drafts.map((d) => d.id)], [1, 0, ["w-p-band", "w-p-wall"]]);
    assert.match(prompts[0], /PORTRAIT photograph[\s\S]*OWN ADVERTS OF THIS KIND[\s\S]*thin on backdrop/);
    assert.ok(logs.some((l) => /this gym's own studio-portrait adverts \(4 ads, 157 leads\)/.test(l)), logs.join(" | "));
    const lib = JSON.parse(readFileSync(join(dir, "scenes.json"), "utf-8"));
    const mine = lib.scenes.filter((s) => s.format === "studio-portrait");
    assert.deepEqual(mine.map((s) => [s.id, s.draft, s.source, s.added, s.covers]), [["w-p-band", true, "refresh", "2026-11-10", ["backdrop:seamless-colour"]], ["w-p-wall", true, "refresh", "2026-11-10", ["backdrop:dark-wall"]]]);
    assert.deepEqual(loadScenes(join(dir, "scenes.json")).map((s) => s.id), ["w-swing"], "drafts are left out until the owner approves them");
    await assert.rejects(draftScenes({ brandDir: dir, audience: "women", count: 2, format: "poster", ask: async () => ({ scenes: [] }), log: () => {} }), /format must be one of/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SP5 the per-format guide, by rule: among the gym's own still ads read as that format, each backdrop, subject, pose, expression and gaze with 5+ leads, the cheapest first; video, other formats and thin values stay out; none when the gym has run no such ad with a lead", () => {
  const R = (over) => ({ source: "account", ad_id: "x", status: "active", media: "image", spend: 0, leads: 0, cost_per_lead: null, ...over });
  const read = (over) => ({ format: "studio-portrait", subject: "woman", backdrop: "dark-wall", pose: "easy-posed", expression: "smile", eye_contact: false, ...over });
  const rows = [
    R({ ad_id: "a", spend: 1249, leads: 86, read: read({ subject: "couple", pose: "holding-equipment" }) }),
    R({ ad_id: "b", spend: 817, leads: 50, read: read({ expression: "neutral" }) }),
    R({ ad_id: "c", spend: 482, leads: 21, read: read({ backdrop: "seamless-colour", eye_contact: true }) }),
    R({ ad_id: "d", spend: 90, leads: 2, read: read({ backdrop: "gym-floor" }) }), // under 5 leads: not a line
    R({ ad_id: "e", spend: 300, leads: 30, read: read({ format: "workout", backdrop: "gym-floor" }) }), // another format
    R({ ad_id: "f", spend: 900, leads: 90, media: "video", read: read({ backdrop: "studio-room" }) }), // video is its own track
  ];
  const g = formatGuideFrom(rows, "studio-portrait");
  assert.deepEqual([g.format, g.ads, g.leads, g.spend], ["studio-portrait", 4, 159, 2638]);
  assert.deepEqual(GUIDE_ATTRIBUTES, ["backdrop", "subject", "pose", "expression", "eye_contact"]);
  const line = (start) => g.lines.find((l) => l.startsWith(start));
  assert.equal(line("Backdrop"), "Backdrop: dark-wall (136 leads at SGD 15.19), seamless-colour (21 leads at SGD 22.95)");
  assert.equal(line("Subject"), "Subject: couple (86 leads at SGD 14.52), woman (73 leads at SGD 19.03)");
  assert.equal(line("Pose"), "Pose: holding-equipment (86 leads at SGD 14.52), easy-posed (73 leads at SGD 19.03)");
  assert.ok(!g.lines.join(" ").includes("gym-floor") && !g.lines.join(" ").includes("studio-room"));
  assert.equal(formatGuideFrom(rows, "testimonial"), null);
  assert.equal(formatGuideFrom([R({ ad_id: "z", spend: 50, read: read({}) })], "studio-portrait"), null, "no lead: nothing to learn from yet");
  assert.match(formatGuideFrom(rows, "studio-portrait", { currency: "TWD" }).lines[0], /TWD/);
});

// ── Phase 4: the mix ──────────────────────────────────────────────────────
import { DEFAULT_MIX, mixProblems, allocateMix, mixName } from "./scene-library.mjs";
import { mixOf } from "./client-config.mjs";
import { batchMix, validateBrief as validateBatchBrief } from "./plan-offer-batch.mjs";
import { mixSuggestionFrom, MIX_STEP, MIX_FLOOR, MIX_CAP } from "./what-wins.mjs";

test("SP6 the mix: shares that sum to 100 on the profile, photos that sum to the batch on a brief; shares become whole photos by the largest remainders; a brief's own mix, else its one format, else the gym's default; a mix and a format together, or a directed mix, are refused", () => {
  assert.deepEqual(DEFAULT_MIX, { workout: 100 });
  assert.deepEqual(mixProblems({ workout: 50, "studio-portrait": 50 }), []);
  assert.deepEqual(mixProblems({ workout: 60, "studio-portrait": 30 }), ["the mix's shares must add up to 100 (they add up to 90)"]);
  assert.deepEqual(mixProblems({ workout: 50, poster: 50 }), ['mix: "poster" is not one of workout, studio-portrait']);
  assert.deepEqual(mixProblems({ workout: 99.5, "studio-portrait": 0.5 }), ["mix.workout must be a whole number from 0 to 100", "mix.studio-portrait must be a whole number from 0 to 100"]);
  assert.deepEqual(mixProblems([50, 50]), ["the mix maps each kind of photograph to its share"]);
  assert.deepEqual(mixProblems({ workout: 4, "studio-portrait": 2 }, { counts: true, total: 6 }), []);
  assert.deepEqual(mixProblems({ workout: 4, "studio-portrait": 3 }, { counts: true, total: 6 }), ["the mix's photos (7) must add up to the batch's generated photos (6)"]);
  // Shares → photos.
  assert.deepEqual(allocateMix({ workout: 50, "studio-portrait": 50 }, 10), { workout: 5, "studio-portrait": 5 });
  assert.deepEqual(allocateMix({ workout: 50, "studio-portrait": 50 }, 5), { workout: 3, "studio-portrait": 2 }, "a tie goes to the first kind");
  assert.deepEqual(allocateMix({ workout: 30, "studio-portrait": 70 }, 6), { workout: 2, "studio-portrait": 4 });
  assert.deepEqual(allocateMix({ workout: 80, "studio-portrait": 20 }, 3), { workout: 2, "studio-portrait": 1 }, "the larger remainder gets the last photo");
  assert.deepEqual(allocateMix({ workout: 80, "studio-portrait": 20 }, 1), { workout: 1 }, "a kind with a share but no photo is left out");
  assert.deepEqual(allocateMix({ workout: 100 }, 4), { workout: 4 });
  assert.deepEqual(allocateMix({ workout: 50, "studio-portrait": 50 }, 0), {});
  for (let n = 1; n <= 12; n++) for (const p of [10, 20, 30, 50, 70]) assert.equal(Object.values(allocateMix({ workout: 100 - p, "studio-portrait": p }, n)).reduce((a, b) => a + b, 0), n, `${p}% of ${n}`);
  assert.deepEqual([mixName({ workout: 3 }), mixName({ "studio-portrait": 2, workout: 0 }), mixName({ workout: 1, "studio-portrait": 1 }), mixName({})], ["workout", "studio-portrait", "mixed", null]);
  // The gym's default.
  const p = PROFILE_STARTER("testgym", "Test Gym", "SG");
  assert.deepEqual(mixOf(p), { workout: 100 });
  assert.deepEqual(mixOf({ creative_defaults: { format: "studio-portrait" } }), { "studio-portrait": 100 }, "Phase 3's one format still reads");
  assert.deepEqual(mixOf({ creative_defaults: { format: "workout", mix: { workout: 40, "studio-portrait": 60 } } }), { workout: 40, "studio-portrait": 60 }, "the mix wins");
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, mix: { workout: 40, "studio-portrait": 60 } } }).errors, []);
  assert.deepEqual(validateProfile({ ...p, creative_defaults: { ...p.creative_defaults, mix: { workout: 40, "studio-portrait": 50 } } }).errors.filter((e) => /mix/.test(e)), ["creative_defaults.mix: shares must add up to 100 (they add up to 90)"]);
  // A batch's photos per kind.
  const gym = { creative_defaults: { mix: { workout: 50, "studio-portrait": 50 } } };
  assert.deepEqual(batchMix({ generated: 6 }, gym), { workout: 3, "studio-portrait": 3 }, "the gym's default");
  assert.deepEqual(batchMix({ generated: 6, format: "studio-portrait" }, gym), { "studio-portrait": 6 }, "the brief's one format");
  assert.deepEqual(batchMix({ generated: 6, mix: { workout: 5, "studio-portrait": 1 } }, gym), { workout: 5, "studio-portrait": 1 }, "the brief's own counts");
  assert.deepEqual(batchMix({ generated: 4, mix: { workout: 4, "studio-portrait": 0 } }, gym), { workout: 4 });
  assert.deepEqual([batchMix({ generated: 0 }, gym), batchMix({ generated: 3 }, null)], [{}, { workout: 3 }]);
  const brief = { batch_id: "mix-test", offer: "6 Week Reset", locations: ["BISHAN"], generated: 4, real: [], max_calls: 4, scenes: null };
  assert.deepEqual(validateBatchBrief({ ...brief, mix: { workout: 2, "studio-portrait": 2 } }), []);
  assert.deepEqual(validateBatchBrief({ ...brief, mix: { workout: 2, "studio-portrait": 1 } }), ["the mix's photos (3) must add up to the batch's generated photos (4)"]);
  assert.deepEqual(validateBatchBrief({ ...brief, mix: { workout: 2, "studio-portrait": 2 }, format: "workout" }), ["give the batch a format or a mix, not both"]);
  assert.ok(validateBatchBrief({ ...brief, mix: { workout: 2, "studio-portrait": 2 }, direction: { words: "couples in their fifties, warm and unposed" } }).includes("a directed batch is one kind of photograph: its words or reference decide the pictures, so it cannot be a mix"));
});

test("SP7 the mix suggestion, by rule and one step at a time: a kind with 20+ leads well under the account's median gains 10 points from the dearest other kind; a dear one gives 10 away; a kind not in the mix is given the floor so it is tested; no kind drops under the floor or passes the cap; thin numbers move nothing; an app-made ad's kind is its batch's record, not the reading's guess", () => {
  assert.deepEqual([MIX_STEP, MIX_FLOOR, MIX_CAP], [10, 20, 80]);
  const R = (id, format, spend, leads, over = {}) => ({ source: "account", ad_id: id, status: "active", media: "image", spend, leads, cost_per_lead: leads ? spend / leads : null, read: { format }, ...over });
  const formats = ["workout", "studio-portrait"];
  // Portraits clearly cheaper: 12.00 a lead against a median of 20.
  const cheap = [R("a", "studio-portrait", 600, 50), R("b", "workout", 1000, 50), R("c", "workout", 900, 30), R("d", "workout", 400, 20)];
  let s = mixSuggestionFrom(cheap, { formats, current: { workout: 50, "studio-portrait": 50 } });
  assert.deepEqual([s.current, s.suggested, s.changed, s.median], [{ workout: 50, "studio-portrait": 50 }, { workout: 40, "studio-portrait": 60 }, true, 20]);
  assert.deepEqual(s.formats.map((f) => [f.format, f.ads, f.leads, f.cost_per_lead, f.vs_median, f.confidence, f.share]), [["workout", 3, 100, 23, 1.15, "solid", 50], ["studio-portrait", 1, 50, 12, 0.6, "solid", 50]]);
  assert.deepEqual(s.reasons, ["studio-portrait (50 leads at SGD 12.00) is 40% under this account's median of SGD 20.00: +10 points, from workout (100 leads at SGD 23.00)."]);
  // At the cap it stops; the other keeps its floor.
  s = mixSuggestionFrom(cheap, { formats, current: { workout: 20, "studio-portrait": 80 } });
  assert.deepEqual([s.suggested, s.changed, s.cap, s.floor], [{ workout: 20, "studio-portrait": 80 }, false, 80, 20]);
  assert.match(s.reasons[0], /leads, and is already at its cap of 80% \(the others keep 20% each so testing never stops\)/);
  s = mixSuggestionFrom(cheap, { formats, current: { workout: 25, "studio-portrait": 75 } });
  assert.deepEqual(s.suggested, { workout: 20, "studio-portrait": 80 }, "a part step, down to the floor");
  // A kind that is not in the mix yet is given the floor, then the winner's step is taken on top.
  s = mixSuggestionFrom(cheap, { formats, current: { workout: 100 } });
  assert.deepEqual(s.suggested, { workout: 70, "studio-portrait": 30 });
  assert.match(s.reasons[0], /^studio-portrait is not in the mix yet: give it 20% so it is tested \(the floor is 20%\)\.$/);
  s = mixSuggestionFrom([R("b", "workout", 1000, 50), R("c", "workout", 900, 30)], { formats, current: { workout: 100 } });
  assert.deepEqual(s.suggested, { workout: 80, "studio-portrait": 20 });
  assert.match(s.reasons[0], /^studio-portrait is not in the mix yet and has never run in this account: give it 20%/);
  // A dear kind gives a step away when nothing is clearly cheap.
  const dear = [R("a", "studio-portrait", 1500, 50), R("b", "workout", 1000, 50), R("c", "workout", 600, 30), R("d", "workout", 380, 20)];
  s = mixSuggestionFrom(dear, { formats, current: { workout: 50, "studio-portrait": 50 } });
  assert.deepEqual([s.median, s.suggested], [20, { workout: 60, "studio-portrait": 40 }]);
  assert.match(s.reasons[0], /^studio-portrait \(50 leads at SGD 30\.00\) is 50% over this account's median of SGD 20\.00: −10 points, to workout\.$/);
  // Thin numbers move nothing, and that is said; near the median nothing moves either.
  s = mixSuggestionFrom([R("a", "studio-portrait", 60, 12), R("b", "workout", 1000, 50)], { formats, current: { workout: 50, "studio-portrait": 50 } });
  assert.deepEqual([s.changed, s.reasons], [false, ["studio-portrait: 12 leads so far — too few to move the mix (it takes 20)."]]);
  s = mixSuggestionFrom([R("a", "studio-portrait", 950, 50), R("b", "workout", 1000, 50)], { formats, current: { workout: 50, "studio-portrait": 50 } });
  assert.deepEqual([s.changed, s.reasons], [false, ["No kind is clearly cheaper or dearer than the account's median: the mix stays as it is."]]);
  assert.deepEqual(mixSuggestionFrom([], { formats, current: { workout: 100 } }).reasons.at(-1), "studio-portrait is not in the mix yet and has never run in this account: give it 20% so it is tested (the floor is 20%).");
  assert.deepEqual(mixSuggestionFrom([], { formats: ["workout"], current: { workout: 100 } }).reasons, ["No lead-form results to learn from yet: the mix stays as it is."]);
  // Video is its own track, and an ad this app made is the kind its batch says, whatever a reading of its picture guessed.
  s = mixSuggestionFrom([...cheap, R("v", "studio-portrait", 5000, 50, { media: "video" }), R("app", "workout", 240, 20, { source: "app", format: "studio-portrait" })], { formats, current: { workout: 50, "studio-portrait": 50 } });
  assert.deepEqual(s.formats.find((f) => f.format === "studio-portrait").leads, 70, "50 from the account's still + 20 from the app's own portrait ad; the video stays out");
  assert.match(mixSuggestionFrom(cheap, { formats, current: { workout: 50, "studio-portrait": 50 }, currency: "TWD" }).reasons[0], /TWD 12\.00/);
});
