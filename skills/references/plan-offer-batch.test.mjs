/**
 * Offline tests for a batch, end to end (plan-offer-batch.mjs) and the pieces it joins.
 *
 *   node --test skills/references/plan-offer-batch.test.mjs
 *
 * No network and no Gemini spend: the image model and the vision checks are faked. Rendering, colour
 * measurement, the gallery and every verification run for real, in Chrome, on synthetic photos. The
 * live gate is the Step 6 test batch itself, reported separately.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { launchBrowser, loadCatalogue, renderComposite } from "./render-composites.mjs";
import { fitLayouts } from "./check-visual.mjs";
import { assignVariants } from "./assign-variants.mjs";
import { cropImage } from "./clean-photo.mjs";
import { validateBrief, sceneAudience, planVisuals, primaryLayouts, loadScenes, adFolders, resolveSelections, runBatch, slug, sceneProblems, sceneWarnings, CHECKS_VERSION, loadRulings, withRulings, MAX_CALLS_CAP } from "./plan-offer-batch.mjs";
const sceneProblemsOf = (s) => sceneProblems(s).join("; ");
import { poseProblem } from "./visual-prompts.mjs";
import { rejectScene } from "./scene-library.mjs";

const CAT = loadCatalogue();
const svg = (w, h, body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
const SCENES = [
  { id: "m-up", audience: "men", pose: "upright", people: 1, scene: "A man mid-set of a barbell back squat." },
  { id: "m-cmp", audience: "men", pose: "compact", people: 1, scene: "A man seated pressing dumbbells overhead." },
  { id: "m-low", audience: "men", pose: "low", people: 1, scene: "A man holding the top of a push-up." },
  { id: "w-up", audience: "women", pose: "upright", people: 1, scene: "A woman swinging a kettlebell." },
  { id: "w-low", audience: "women", pose: "low", people: 2, scene: "Two women holding forearm planks." },
];
const BRIEF = { batch_id: "test-batch", offer: "12 Week Total Body Reset", free: false, locations: ["BISHAN", "ANG MO KIO"], audience: "MEN", generated: 2, real: ["real/r1.png", "real/r2.png"], looks_per_photo: 2, scenes: null, max_calls: 4, attempts: 2, seed: "t" };

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === "IDAT") idat.push(d); else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const A = i >= ch ? cur[i - ch] : 0, B = prev[i], C = i >= ch ? prev[i - ch] : 0, x = line[i], p = A + B - C, pa = Math.abs(p - A), pb = Math.abs(p - B), pc = Math.abs(p - C);
      cur[i] = (ft === 0 ? x : ft === 1 ? x + A : ft === 2 ? x + B : ft === 3 ? x + ((A + B) >> 1) : x + (pa <= pb && pa <= pc ? A : pb <= pc ? B : C)) & 255;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, px: out };
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// ── B1 the brief ──────────────────────────────────────────────────────────

test("B1 a brief is refused before anything runs, with a reason for each problem; the offer is never filled in", () => {
  assert.deepEqual(validateBrief(BRIEF), []);
  const cases = [
    [{ offer: undefined }, /offer is required, written exactly/],
    [{ offer: "  " }, /offer is required/],
    [{ offer: "12 Week — Reset" }, /em\/en dash/],
    [{ locations: [] }, /1 to 4 location/],
    [{ locations: ["A", "B", "C", "D", "E"] }, /1 to 4 location/],
    [{ locations: ["BISHAN", "BISHAN"] }, /locations repeat/],
    [{ locations: ["BISHAN\nNORTH"] }, /line break/],
    [{ locations: ["X".repeat(41)] }, /limit is 40/],
    [{ audience: "MEN — ONLY" }, /em\/en dash/],
    [{ batch_id: "Test Batch!" }, /batch_id/],
    [{ generated: 0, real: [] }, /no photos/],
    [{ max_calls: 1 }, /must cover at least one call per generated photo/],
    [{ max_calls: MAX_CALLS_CAP + 1 }, /split the batch/],
    [{ attempts: 0 }, /attempts/],
    [{ looks_per_photo: 0 }, /looks_per_photo/],
    [{ free: "yes" }, /free must be true or false/],
    [{ scenes: [{ scene: 'A sign reading "OPEN"', pose: "upright", people: 1 }, SCENES[1]] }, /quotation marks/],
    [{ scenes: [SCENES[0]] }, /at least one per generated photo/],
    [{ scene_audience: "kids" }, /scene_audience/],
  ];
  for (const [change, why] of cases) {
    const errs = validateBrief({ ...BRIEF, ...change });
    assert.ok(errs.some((e) => why.test(e)), `${JSON.stringify(change)} should be refused for ${why}; got ${errs}`);
  }
  assert.deepEqual(validateBrief({ ...BRIEF, audience: null }), [], "the audience is optional");
  const dashes = validateBrief({ ...BRIEF, offer: "12 Week — Reset", locations: ["BISHAN", "ANG MO KIO", "TOA PAYOH"] }).filter((e) => /dash/.test(e));
  assert.equal(dashes.length, 1, `one problem, one message — not one per location: ${dashes}`);
  assert.deepEqual(validateBrief({ ...BRIEF, locations: ["BISHAN", " TOA PAYOH"] }), ['" TOA PAYOH": location has leading or trailing spaces'], "a location's own problem names the location");
});

test("B1b scenes suit the audience callout; an unapproved library is refused for generation", () => {
  assert.equal(sceneAudience("MEN"), "men");
  assert.equal(sceneAudience("MEN WANTED"), "men");
  assert.equal(sceneAudience("LADIES WANTED"), "women");
  assert.equal(sceneAudience("MUMS OF BISHAN"), "women");
  assert.equal(sceneAudience(null), "any");
  assert.equal(sceneAudience("NEW TO THE GYM?"), "any");
  assert.equal(sceneAudience("MEN", "any"), "any", "the brief can say outright");
  const dir = mkdtempSync(join(tmpdir(), "scenes-"));
  try {
    const p = join(dir, "scenes.json");
    writeFileSync(p, JSON.stringify({ approved: false, scenes: SCENES }));
    assert.throws(() => loadScenes(p), /not approved yet/);
    assert.equal(loadScenes(p, { allowDraft: true }).length, SCENES.length, "a dry run may plan from a draft");
    writeFileSync(p, JSON.stringify({ approved: true, scenes: [...SCENES, { id: "bad", pose: "flying", people: 1, scene: "x" }] }));
    assert.throws(() => loadScenes(p), /pose must be one of/);
    // A gendered callout draws from its own scenes; mixed ("any") scenes serve ungendered callouts and
    // fill in only when the gendered scenes are too few (2026-09-12: a women's batch had planned men).
    const MIX = [...SCENES, { id: "a-pair", audience: "any", pose: "upright", people: 2, scene: "A man and a woman lifting." }, { id: "a-class", audience: "any", pose: "upright", people: 3, scene: "A mixed class." }];
    const ids = (v) => v.map((x) => x.scene_id);
    const women = planVisuals({ count: 2, scenes: MIX, audience: "women", seed: "s", catalogue: CAT });
    assert.ok(ids(women).every((id) => id.startsWith("w-")), `women only: ${ids(women)}`);
    const many = planVisuals({ count: 4, scenes: MIX, audience: "women", seed: "s", catalogue: CAT });
    assert.ok(ids(many).some((id) => id.startsWith("a-")) && ids(many).filter((id) => id.startsWith("w-")).length === 2, `the two women's scenes, then mixed ones to fill: ${ids(many)}`);
    assert.ok(!ids(many).some((id) => id.startsWith("m-")), "never the other gender's");
    const anyone = planVisuals({ count: 4, scenes: MIX, audience: "any", seed: "s", catalogue: CAT });
    assert.ok(ids(anyone).some((id) => id.startsWith("a-")), `an ungendered callout uses the mixed scenes: ${ids(anyone)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── B2 photos to generate ─────────────────────────────────────────────────

test("B2 each photo to generate gets a layout it is made for and a scene that suits the audience and that layout's pose", () => {
  const prim = primaryLayouts(CAT);
  assert.deepEqual([...prim].sort(), ["t1-bottom-stack", "t2-top-bottom-split", "t3-right-column", "t5-offer-band", "t6-left-column"], "only single-photo layouts with a subject area");
  for (const seed of ["a", "b", "c", "d"]) {
    const vs = planVisuals({ count: 5, scenes: SCENES, audience: "men", seed });
    for (const v of vs) {
      assert.ok(v.scene_id.startsWith("m-"), `${v.id}: a men's scene for a MEN brief (${v.scene_id})`);
      assert.equal(poseProblem(v.treatment, v.pose), null, `${v.id}: ${v.pose} fits ${v.treatment}`);
      assert.ok(prim.includes(v.treatment));
    }
    assert.equal(new Set(vs.slice(0, 3).map((v) => v.scene_id)).size, 3, "no scene repeats while an unused one fits");
  }
  assert.deepEqual(planVisuals({ count: 3, scenes: SCENES, audience: "men", seed: "x" }), planVisuals({ count: 3, scenes: SCENES, audience: "men", seed: "x" }), "seeded");
  assert.equal(planVisuals({ count: 0, scenes: [], audience: "men" }).length, 0);
  assert.throws(() => planVisuals({ count: 1, scenes: SCENES.filter((s) => s.audience === "women"), audience: "men" }), /no scene in the library suits/);
  // A layout that only holds low poses (T2, T5) is only given a low scene.
  const lowOnly = planVisuals({ count: 5, scenes: SCENES, audience: "men", seed: "q" }).filter((v) => ["t2-top-bottom-split", "t5-offer-band"].includes(v.treatment));
  for (const v of lowOnly) assert.equal(v.pose, "low");
  assert.deepEqual(planVisuals({ count: 2, scenes: SCENES, audience: "men", seed: "e", exclude: { layouts: ["t1-bottom-stack", "t3-right-column", "t6-left-column"] } }).map((v) => v.treatment).sort(), ["t2-top-bottom-split", "t5-offer-band"], "the client's excluded layouts are never used");
});

test("B2b ten photos spread across exercise, age, setting and equipment — not six squats", () => {
  const T = (id, pose, people, exercise, age, setting, equipment, muscles) => ({ id, audience: "men", pose, people, exercise, age, setting, equipment, muscles, scene: `Scene ${id}.` });
  const LIB = [
    T("a", "upright", 1, "back-squat", "young", "solo", "barbell", "legs"), T("b", "upright", 1, "back-squat", "prime", "solo", "barbell", "legs"),
    T("c", "upright", 1, "back-squat", "older", "solo", "barbell", "legs"), T("d", "upright", 1, "goblet-squat", "prime", "solo", "kettlebell", "legs"),
    T("e", "upright", 1, "deadlift", "young", "solo", "barbell", "back"), T("f", "upright", 2, "deadlift", "prime", "coached", "barbell", "back"),
    T("g", "low", 1, "bench-press", "prime", "solo", "dumbbells", "chest"), T("h", "upright", 2, "bench-press", "prime", "coached", "barbell", "chest"),
    T("i", "upright", 1, "lunge", "young", "solo", "dumbbells", "legs"), T("j", "upright", 1, "lunge", "older", "solo", "bodyweight", "legs"),
    T("k", "low", 1, "push-up", "prime", "solo", "bodyweight", "chest"), T("l", "compact", 1, "seated-press", "prime", "solo", "dumbbells", "shoulders"),
    T("m", "upright", 3, "kettlebell-swing", "prime", "group", "kettlebell", "full-body"), T("n", "low", 4, "plank", "prime", "group", "bodyweight", "core"),
    T("o", "compact", 1, "cable-row", "older", "solo", "cable", "back"), T("p", "upright", 2, "box-squat", "older", "coached", "bodyweight", "legs"),
  ];
  for (const seed of ["v1", "v2", "v3"]) {
    const vs = planVisuals({ count: 10, scenes: LIB, audience: "men", seed });
    const distinct = (k) => new Set(vs.map((v) => v.tags[k])).size;
    assert.equal(new Set(vs.map((v) => v.scene_id)).size, 10, "ten different scenes");
    assert.ok(distinct("exercise") >= 9, `exercises: ${vs.map((v) => v.tags.exercise)}`);
    assert.equal(distinct("age"), 3, "young, prime and older all appear");
    assert.equal(distinct("setting"), 3, "solo, coached and group all appear");
    assert.ok(distinct("equipment") >= 5, `equipment: ${vs.map((v) => v.tags.equipment)}`);
    assert.ok(vs.filter((v) => v.tags.exercise === "back-squat").length <= 1, "not three back squats while other exercises are unused");
    for (const v of vs) assert.equal(poseProblem(v.treatment, v.pose), null);
    assert.ok(new Set(vs.map((v) => v.treatment)).size >= 4, "layouts spread too");
  }
  // The tags are checked, and the head count must agree with the setting.
  assert.match(sceneProblemsOf({ ...LIB[0], age: "ancient" }), /age must be one of young, prime, older/);
  assert.match(sceneProblemsOf({ ...LIB[0], setting: "group" }), /a group scene has at least 3 people/);
  assert.match(sceneProblemsOf({ ...LIB[12], people: 7 }), /people must be 1 to 6/);
  assert.match(sceneProblemsOf({ ...LIB[5], people: 1 }), /a coached scene has at least 2 people/);
  assert.equal(sceneProblemsOf(LIB[13]), "", "a group of four planking is fine");

  // must_show: what the brief names comes first, and stays close to even.
  const must = { exercise: ["lunge", "squat", "deadlift", "bench-press"], age: ["young", "prime", "older"], setting: ["solo", "coached", "group"] };
  for (const seed of ["m1", "m2", "m3", "m4"]) {
    const vs = planVisuals({ count: 9, scenes: LIB, audience: "men", seed, mustShow: must });
    const src = vs.map((v) => LIB.find((x) => x.id === v.scene_id));
    for (const ex of must.exercise) assert.ok(src.some((x) => x.exercise.split("-").includes(ex) || x.exercise.includes(ex)), `${seed}: ${ex} is shown`);
    for (const k of ["age", "setting"]) {
      const n = must[k].map((v) => src.filter((x) => x[k] === v).length);
      assert.ok(Math.min(...n) >= 1 && Math.max(...n) - Math.min(...n) <= 3, `${seed}: ${k} close to even: ${n}`);
    }
  }
  assert.throws(() => planVisuals({ count: 3, scenes: LIB, audience: "men", mustShow: { exercise: ["snatch"] } }), /must_show asks for exercise "snatch", which no men's scene in the library shows/);
  const few = planVisuals({ count: 1, scenes: LIB, audience: "men", mustShow: must });
  assert.ok(few.notShown?.length > 0, "too few photos: the plan says what could not be shown");
  assert.match(validateBrief({ ...BRIEF, must_show: { hair: ["long"] } }).join(), /unknown tag "hair"/);
  assert.match(validateBrief({ ...BRIEF, must_show: { age: ["teen"] } }).join(), /"teen" is not one of young, prime, older/);
  assert.deepEqual(validateBrief({ ...BRIEF, must_show: must }), []);
});

test("B2c a scene added to an approved library waits as a draft until it is approved", () => {
  const dir = mkdtempSync(join(tmpdir(), "drafts-"));
  try {
    const p = join(dir, "scenes.json");
    writeFileSync(p, JSON.stringify({ approved: true, scenes: [SCENES[0], { ...SCENES[1], id: "new-one", draft: true }] }));
    assert.deepEqual(loadScenes(p).map((x) => x.id), ["m-up"], "drafts are not generated from");
    assert.deepEqual(loadScenes(p, { allowDraft: true }).map((x) => x.id), ["m-up", "new-one"], "a dry run can plan with them for review");
    writeFileSync(p, JSON.stringify({ approved: true, scenes: [SCENES[0], { ...SCENES[1], id: "m-up" }] }));
    assert.throws(() => loadScenes(p), /share an id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── B3 fit ────────────────────────────────────────────────────────────────

test("B3 one check judges a photo against every layout: looks only where it works, each with its own crop", () => {
  const f = (a, size) => Object.fromEntries(Object.entries(fitLayouts(a, { imageSize: size, expectPeople: true, maxPeople: 1 })).map(([k, v]) => [k.split("-")[0], v]));
  const high = f({ people_box: [80, 380, 420, 620], face_boxes: [[90, 460, 170, 540]], people_count: 1 }, [896, 1200]);
  assert.ok(high.t1.ok && high.t4.ok, "a subject high in the frame carries bottom text");
  assert.ok(!high.t3.ok && !high.t6.ok, "but not a column over a centred subject");
  assert.ok(high.t1.focus[1] < 0.5, "and T1's crop keeps the subject clear of the bottom text");
  const left = f({ people_box: [150, 60, 900, 330], face_boxes: [[160, 150, 250, 240]], people_count: 1 }, [1200, 896]);
  assert.ok(left.t3.ok && !left.t6.ok && !left.t1.ok, "a subject on the left carries the right-hand column only");
  assert.ok(left.t3.focus[0] < 0.5);
  const low = f({ people_box: [420, 150, 600, 850], face_boxes: [[430, 700, 500, 780]], people_count: 1 }, [1024, 1024]);
  assert.ok(low.t2.ok && low.t5.ok, "a low, wide pose fits the split layouts");
  const empty = f({ people_box: null, face_boxes: [], people_count: 0 }, [1535, 1146]);
  assert.equal(Object.values(fitLayouts({ people_box: null, face_boxes: [], people_count: 0 }, { imageSize: [1535, 1146], expectPeople: false })).every((v) => v.ok), true, "a real photo with no people fits every layout");
  assert.ok(!empty.t1.ok, "…but a generated photo that should show people and shows none fits nothing");
});

// ── B4 looks from the layouts each photo can carry ─────────────────────────

test("B4 the planner only picks layouts each photo can carry; a generated photo's own layout is its first look", () => {
  const visuals = ["g01", "g02", "r01", "r02"].map((id) => ({ id }));
  const all = Object.keys(CAT.treatments.treatments);
  const allowed = { g01: ["t1-bottom-stack", "t4-centred-stack", "t7-collage", "t8-panels-band"], g02: ["t3-right-column", "t4-centred-stack", "t7-collage", "t8-panels-band"], r01: all, r02: all };
  const prefer = { g01: "t1-bottom-stack", g02: "t3-right-column" };
  for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
    const plan = assignVariants({ visuals, perVisual: 2, text: { audience: "MEN" }, seed, allowed, prefer });
    const looks = new Set();
    for (const c of plan.candidates) {
      for (const id of c.images) assert.ok(allowed[id].includes(c.treatment), `${seed} ${c.id}: ${c.treatment} on ${id}, which cannot carry it`);
      const key = `${c.treatment}|${c.style}|${c.palette}`;
      assert.ok(!looks.has(key), "no look repeats"); looks.add(key);
    }
    for (const [id, want] of Object.entries(prefer)) assert.equal(plan.candidates.find((c) => c.visual === id).treatment, want, `${seed}: ${id}'s first look is the layout it was made for`);
    for (const v of visuals) {
      const on = plan.candidates.filter((c) => c.visual === v.id);
      assert.equal(new Set(on.map((c) => c.treatment)).size, on.length, "a photo never repeats a layout");
    }
  }
  assert.throws(() => assignVariants({ visuals: [{ id: "g01" }], perVisual: 2, allowed: { g01: ["t1-bottom-stack"] } }), /could not find an unused look for photo g01 among the layouts it can carry \(t1-bottom-stack\)/);
  // A small batch leaves most palettes unused because it has few ads, not because of colour: say so only when a palette really clashed.
  const grey = { overall: { hue: 0, strength: 0 }, layouts: Object.fromEntries(Object.keys(CAT.treatments.treatments).map((k) => [k, { hue: 0, strength: 0, cells: [] }])) };
  const small = assignVariants({ visuals: [{ id: "r01" }, { id: "r02" }], perVisual: 2, text: { audience: "MEN" }, photoStats: [grey, grey], seed: "n" });
  assert.ok(!small.notes.some((n) => /clash/.test(n)), `no palette clashes with a grey photo: ${small.notes}`);
});

// ── B5–B8 the whole batch, offline ─────────────────────────────────────────

/** A synthetic "generated" photo: a dark room with a lighter figure high in the frame. */
async function fakePhoto(w, h, out) {
  return cropImage(browser, svg(w, h, `<rect width="100%" height="100%" fill="#3a1414"/><rect x="${w * 0.2}" y="${h * 0.55}" width="${w * 0.6}" height="${h * 0.3}" fill="#2a2a2a"/><rect x="${w * 0.42}" y="${h * 0.1}" width="${w * 0.16}" height="${h * 0.3}" fill="#c9a27e"/><circle cx="${w * 0.5}" cy="${h * 0.12}" r="${w * 0.04}" fill="#e0b48f"/>`), [0, 0, w, h], out);
}
const SIZES = { "3:4": [896, 1200], "4:3": [1200, 896], "1:1": [1024, 1024] };

function brandSetup() {
  const dir = mkdtempSync(join(tmpdir(), "batch-"));
  mkdirSync(join(dir, "brand-assets", "real"), { recursive: true });
  writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym", brand_lock: { photography: { must: ["a real gym"], never: ["the old logo"], people: "SEA mix, 25-45" } } }));
  writeFileSync(join(dir, "scenes.json"), JSON.stringify({ approved: true, scenes: SCENES }));
  return dir;
}

function fakes(calls) {
  return {
    // The model: a photo of the requested shape.
    generate: async (prompt, refs, { aspectRatio }) => {
      calls.push(aspectRatio);
      const [w, h] = SIZES[aspectRatio] || SIZES["1:1"], p = join(tmpdir(), `gen-${Date.now()}-${Math.random()}.png`);
      await fakePhoto(w, h, p);
      const buffer = readFileSync(p); rmSync(p);
      return { buffer, ext: "png" };
    },
    // A generated photo's check: the figure where fakePhoto drew it.
    check: async () => ({ ok: true, failures: [], notes: ["2 people in the picture; the scene has 1"], stray_text: [], excluded: [], dismissed: [], faces: [[80, 460, 160, 540]], focus: [0.5, 0.35], placement: { people_box: [80, 400, 420, 600], people_count: 1 } }),
    checkRef: async () => [],
    checkPhoto: async () => ({ text: [], never: [], people_count: 0, people_box: null, face_boxes: [] }),
    compositor: null,
  };
}

async function realPhotos(dir) {
  await cropImage(browser, svg(1535, 1146, `<rect width="100%" height="100%" fill="#8e1b1b"/><rect y="700" width="1535" height="446" fill="#2b2b2b"/><rect x="200" y="420" width="120" height="300" fill="#111"/>`), [0, 0, 1535, 1146], join(dir, "brand-assets", "real", "r1.png"));
  await cropImage(browser, svg(1874, 795, `<rect width="100%" height="100%" fill="#1c1c1c"/><rect y="0" width="1874" height="360" fill="#9c2a2a"/><rect x="900" y="300" width="200" height="300" fill="#444"/>`), [0, 0, 1874, 795], join(dir, "brand-assets", "real", "r2.png"));
}

test("B5–B8 a whole batch offline: planned, generated within budget, fitted, rendered for each location, in the gallery, re-rendered for free", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [], out = join(dir, "outputs", "test-batch"), logs = [];
    const deps = { ...fakes(calls), browser };
    const r = await runBatch({ brandDir: dir, brief: BRIEF, deps, log: (m) => logs.push(m) });

    // B7 budget: two photos to make, each passed first time.
    assert.equal(r.calls, 2);
    assert.ok(calls.length <= BRIEF.max_calls);
    // B8 every ad rendered and verified; 4 photos × 2 looks × 2 locations.
    assert.equal(r.batch.failed.length, 0, JSON.stringify(r.batch.failed));
    assert.equal(r.batch.ads.length, 16);
    for (const c of r.results) for (const x of c.renders) assert.ok(x.r.ok, `${c.id} ${x.text.location}: ${x.r.failures}`);
    // Looks only in layouts the photos can carry.
    const allowed = Object.fromEntries(r.batch.photos.map((p) => [p.id, p.allowed]));
    for (const ad of r.batch.ads) for (const id of ad.photos) assert.ok(allowed[id].includes(ad.treatment), `${ad.folder}: ${id} cannot carry ${ad.treatment}`);
    for (const p of r.batch.photos.filter((p) => p.kind === "generated")) assert.ok(poseProblem(p.primary, SCENES.find((s) => s.id === p.scene_id).pose) === null);

    // B5 locations: the same look, photos and crop for each location; only the location line's words differ.
    const byCand = {};
    for (const ad of r.batch.ads) (byCand[ad.candidate] ||= []).push(ad);
    for (const [cid, pair] of Object.entries(byCand)) {
      assert.deepEqual(pair.map((a) => a.location), ["BISHAN", "ANG MO KIO"]);
      const [a, b] = pair;
      for (const k of ["treatment", "style", "palette", "photos", "crop"]) assert.deepEqual(a[k], b[k], `${cid}: ${k} differs between locations`);
      assert.deepEqual({ ...a.words, location: null }, { ...b.words, location: null });
      const c = r.results.find((x) => x.id === cid);
      const words = (x) => Object.fromEntries(x.r.report.blocks.map((bl) => [bl.block, bl.text]));
      const [wa, wb] = c.renders.map(words);
      assert.deepEqual({ ...wa, location: null }, { ...wb, location: null }, `${cid}: every line but the location is identical`);
      assert.equal(wa.location, "BISHAN"); assert.equal(wb.location, "ANG MO KIO");
      assert.equal(wa.duration, "12 Week"); assert.equal(wa.offer_name, "Total Body Reset"); assert.equal(wa.audience, "MEN");
      // Outside the text groups, the two ads are the same picture: same photo, same crop.
      const A = decodePNG(readFileSync(join(out, a.file))), B = decodePNG(readFileSync(join(out, b.file)));
      let diff = 0, n = 0;
      for (let y = 0; y < A.h; y += 3) for (let x = 0; x < A.w; x += 3) {
        const inText = c.renders.some((rr) => rr.r.report.blocks.some((bl) => x >= bl.rect.x - 40 && x <= bl.rect.x + bl.rect.w + 40 && y >= bl.rect.y - 40 && y <= bl.rect.y + bl.rect.h + 40));
        if (inText) continue;
        n++; const i = (y * A.w + x) * A.ch;
        if (Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]) > 6) diff++;
      }
      assert.ok(diff / n < 0.02, `${cid}: away from the text, the two locations' ads are the same picture (${(100 * diff / n).toFixed(1)}% differ)`);
    }

    // B6 gallery: every ad is found by the unchanged gallery; a pick maps back to its full record.
    const html = readFileSync(join(out, "gallery.html"), "utf-8");
    for (const ad of r.batch.ads) assert.ok(html.includes(ad.folder), `gallery is missing ${ad.folder}`);
    // What the checks noted about a photo is shown under each of its ads, and kept in batch.json.
    const notes = JSON.parse(readFileSync(join(out, "gallery-notes.json"), "utf-8"));
    const genAds = r.batch.ads.filter((a) => a.photos[0].startsWith("g"));
    assert.ok(genAds.length > 0);
    for (const ad of genAds) assert.match(notes[ad.folder] || "", /^g0\d: 2 people in the picture; the scene has 1/, `no note for ${ad.folder}`);
    assert.ok(html.includes("Checks noted: g0"), "the gallery shows the notes");
    assert.ok(r.batch.photos.filter((p) => p.kind === "generated").every((p) => p.notes?.[0] === "2 people in the picture; the scene has 1"));
    assert.ok(r.batch.photos.filter((p) => p.kind === "real").every((p) => !p.notes), "real photos carry no notes");
    const [first, second] = r.batch.ads;
    const picks = { excluded: [second.folder], [first.folder]: { "1x1": first.file }, [second.folder]: { "1x1": second.file } };
    const chosen = resolveSelections(out, picks);
    assert.equal(chosen.length, 1, "an excluded ad is not chosen");
    assert.equal(chosen[0].folder, first.folder);
    assert.deepEqual(chosen[0].words, { location: first.location, audience: "MEN", offer: "12 Week Total Body Reset", free: false });
    assert.ok(chosen[0].photo_files.length >= 1 && chosen[0].treatment && chosen[0].style && chosen[0].palette);
    assert.throws(() => resolveSelections(out, { excluded: [], "999-c99-x": { "1x1": "x" } }), /did not make: 999-c99-x/);
    for (const ad of r.batch.ads) assert.match(ad.folder, /^\d{3}-c\d{2}-[a-z0-9-]+-t\d-[a-z-]+$/);

    // B7 resume: a second run with the photos on disk makes no image calls and gives the same batch.
    const again = await runBatch({ brandDir: dir, brief: BRIEF, deps, log: () => {} });
    assert.equal(again.calls, 0, "photos already passed are reused");
    assert.deepEqual(again.batch.ads.map((a) => a.folder), r.batch.ads.map((a) => a.folder), "same seed, same batch");

    // B7 render-only: a new offer name, zero image calls, and every ad carries the new words.
    const n0 = calls.length;
    const renamed = await runBatch({ brandDir: dir, brief: { ...BRIEF, offer: "6 Week Strength Kickstart" }, renderOnly: true, deps, log: () => {} });
    assert.equal(calls.length, n0, "no image calls");
    assert.equal(renamed.calls, 0);
    assert.equal(renamed.batch.image_calls, r.calls, "a free re-render keeps the record of what the batch's photos cost");
    assert.equal(renamed.batch.image_calls_this_run, 0);
    for (const c of renamed.results) for (const x of c.renders) {
      const w = Object.fromEntries(x.r.report.blocks.map((bl) => [bl.block, bl.text]));
      assert.equal(w.duration, "6 Week"); assert.equal(w.offer_name, "Strength Kickstart");
    }
    for (const ad of renamed.batch.ads) assert.equal(ad.words.offer, "6 Week Strength Kickstart");
    assert.ok(renamed.batch.ads.every((ad) => existsSync(join(out, ad.file))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B7b the budget holds when photos fail, and a photo that never passes is left out, not used", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [];
    const deps = { ...fakes(calls), browser, check: async () => ({ ok: false, failures: ["stray text in the picture: sign \"X\""], faces: [], focus: [0.5, 0.5], placement: { people_box: null, people_count: 1 } }) };
    const logs = [];
    const r = await runBatch({ brandDir: dir, brief: { ...BRIEF, max_calls: 3, attempts: 5 }, deps, log: (m) => logs.push(m) });
    assert.equal(calls.length, 3, "never more than max_calls");
    assert.ok(r.batch.photos.every((p) => p.kind === "real"), "no failed photo is used");
    assert.ok(logs.some((l) => /g0\d: no passing photo/.test(l)));
    assert.equal(r.batch.ads.length, 2 * 2 * 2, "the real photos still make their ads");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B7e a photo whose own layout's ad does not verify still joins the batch, with no primary look, for the layouts it fits", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [], logs = [];
    // The finished-ad check fails g01 for its own layout every time; everything else verifies.
    const compositor = { async compose(file, faces, v) { return v.id.startsWith("g01") ? { ok: false, failures: ['"duration" covers a face (face 1)'] } : { ok: true, failures: [] }; }, async close() {} };
    const deps = { ...fakes(calls), browser, compositor };
    const r = await runBatch({ brandDir: dir, brief: { ...BRIEF, max_calls: 4, attempts: 2 }, deps, log: (m) => logs.push(m) });
    assert.equal(calls.length, 3, "g01 twice (its retry), g02 once");
    assert.ok(logs.some((l) => /g01: g01-a2\.png passes the picture checks; its own layout did not work out .* kept for the layouts it fits/.test(l)), logs.join(" | "));
    const g01 = r.batch.photos.find((p) => p.id === "g01");
    assert.ok(g01, "g01 is in the batch");
    assert.equal(g01.primary, null, "with no primary look");
    assert.match(g01.notes.join(), /not used in its own layout: finished ad: "duration" covers a face/);
    assert.ok(r.batch.ads.some((a) => a.photos.includes("g01")), "and it appears in ads, in layouts it fits");
    assert.ok(r.batch.photos.find((p) => p.id === "g02").primary, "the other photo keeps its primary");
    const pics = JSON.parse(readFileSync(join(r.out, "pictures.json"), "utf-8"));
    assert.equal(pics.g01.status, "passed");
    assert.match(pics.g01.own_layout_failed.join(), /covers a face/);
    // A re-run under newer checks re-checks it for free and keeps it the same way (the free re-check's own salvage).
    delete pics.g01.checks; writeFileSync(join(r.out, "pictures.json"), JSON.stringify(pics));
    const logs2 = [];
    const r2 = await runBatch({ brandDir: dir, brief: { ...BRIEF, max_calls: 4, attempts: 2 }, deps, log: (m) => logs2.push(m) });
    assert.equal(calls.length, 3, "no new call");
    assert.ok(logs2.some((l) => /g01: g01(-a2)?\.png passes the picture checks; its own layout did not work out — kept for the layouts it fits/.test(l)), logs2.join(" | "));
    assert.equal(r2.batch.photos.find((p) => p.id === "g01").primary, null);
    assert.equal(JSON.parse(readFileSync(join(r.out, "pictures.json"), "utf-8")).g01.checks, CHECKS_VERSION);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B7c a real photo that is not clean stops the batch before any spend", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [];
    const deps = { ...fakes(calls), browser, checkPhoto: async () => ({ text: [{ kind: "neon", what: "mood" }], never: [], people_count: 0 }) };
    await assert.rejects(runBatch({ brandDir: dir, brief: BRIEF, deps, log: () => {} }), /real photo real\/r1\.png is not clean/);
    assert.equal(calls.length, 0);
    await assert.rejects(runBatch({ brandDir: dir, brief: { ...BRIEF, offer: "" }, deps, log: () => {} }), /offer is required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── B9 per-photo crop ─────────────────────────────────────────────────────

test("B9 a collage or panels ad crops each photo where its own check said", async () => {
  // Wide photos, red on the left half and blue on the right: the crop decides which shows.
  const wide = svg(2000, 1000, `<rect width="1000" height="1000" fill="#c62828"/><rect x="1000" width="1000" height="1000" fill="#1e3a8a"/>`);
  const text = { location: "BISHAN", audience: "MEN", offer: "12 Week Total Body Reset" };
  const tileColour = async (focus) => {
    const r = await renderComposite(browser, { images: [wide, wide], ...text, treatment: "t8-panels-band", style: "s1-heavy-sans", palette: "white-on-dark", focus });
    assert.ok(r.ok, r.failures?.join("; "));
    const P = decodePNG(r.png);
    return r.report.background.panels.map((pn) => { const i = (Math.round(pn.cy) * P.w + Math.round(pn.cx - pn.r * 0.6)) * P.ch; return P.px[i] > P.px[i + 2] ? "red" : "blue"; });
  };
  assert.deepEqual(await tileColour([[0, 0.5], [1, 0.5]]), ["red", "blue"], "each panel uses its own photo's crop");
  assert.deepEqual(await tileColour([[1, 0.5], [0, 0.5]]), ["blue", "red"]);
  assert.deepEqual(adFolders([{ id: "c01", treatment: "t1-bottom-stack", palette: "red-white" }, { id: "c02", failed: ["x"] }, { id: "c03", treatment: "t7-collage", palette: "cyan-pink" }], ["BISHAN", "ANG MO KIO"]).map((a) => a.folder),
    ["101-c01-bishan-t1-red-white", "102-c01-ang-mo-kio-t1-red-white", "103-c03-bishan-t7-cyan-pink", "104-c03-ang-mo-kio-t7-cyan-pink"], "a look that failed to verify gets no folder");
  assert.equal(slug("ANG MO KIO"), "ang-mo-kio");
});

test("B7d the budget is for the batch, not each run; a photo rejected earlier gets a free second look when the checks change", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [];
    let strict = true;
    // First run: the check rejects everything (as the mirror-reflection count did); 3 of 4 calls spent.
    const deps = { ...fakes(calls), browser };
    const good = deps.check;
    deps.check = async (...a) => (strict ? { ok: false, failures: ["3 people in the picture; the scene has 1"], faces: [], focus: [0.5, 0.5], placement: { people_box: null, people_count: 3 } } : good(...a));
    const brief = { ...BRIEF, generated: 2, max_calls: 3, attempts: 2 };
    const r1 = await runBatch({ brandDir: dir, brief, deps, log: () => {} });
    assert.equal(calls.length, 3, "three calls, the batch's whole budget");
    assert.equal(r1.batch.image_calls, 3);
    // A plain re-run: nothing left to spend, so no call — the budget does not reset.
    const logs = [];
    const r2 = await runBatch({ brandDir: dir, brief, deps, log: (m) => logs.push(m) });
    assert.equal(calls.length, 3, "no call beyond the batch's budget");
    assert.ok(logs.some((l) => /budget of 3 image calls is spent/.test(l)));
    assert.equal(r2.batch.image_calls, 3);
    // The check is fixed: the photos already on disk are looked at again, and used — no new image.
    strict = false;
    const logs3 = [];
    const r3 = await runBatch({ brandDir: dir, brief, deps, log: (m) => logs3.push(m) });
    assert.equal(calls.length, 3, "still no new call");
    assert.equal(r3.batch.photos.filter((p) => p.kind === "generated").length, 2, "both earlier photos now pass and are used");
    assert.ok(logs3.filter((l) => /g0\d(-a\d)?\.png on disk passes today's checks/.test(l)).length === 2);
    assert.equal(r3.batch.image_calls, 3);
    assert.equal(r3.batch.ads.length, 4 * 2 * 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Q5 photos passed before the quality check are re-checked for free before reuse; one that fails is replaced within the batch's budget, the other kept", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [], out = join(dir, "outputs", "test-batch"), picsPath = join(out, "pictures.json");
    const deps = { ...fakes(calls), browser };
    const brief = { ...BRIEF, max_calls: 4, attempts: 1 };
    await runBatch({ brandDir: dir, brief, deps, log: () => {} });
    assert.equal(calls.length, 2);
    const pics = JSON.parse(readFileSync(picsPath, "utf-8"));
    assert.ok(Object.values(pics).every((p) => p.checks === CHECKS_VERSION), "a photo passed today carries today's checks");
    // As the 48-ad batch: its photos passed before the quality check existed.
    for (const p of Object.values(pics)) delete p.checks;
    writeFileSync(picsPath, JSON.stringify(pics));
    const [bad, good] = Object.keys(pics).sort(), badFile = pics[bad].file, goodFile = pics[good].file;

    // A free re-render keeps them — re-checking is a run's job — and says so.
    const logsR = [];
    const rr = await runBatch({ brandDir: dir, brief, renderOnly: true, deps, log: (m) => logsR.push(m) });
    assert.equal(calls.length, 2);
    assert.equal(rr.batch.photos.filter((p) => p.kind === "generated").length, 2);
    assert.ok(logsR.some((l) => /passed before today's checks — a full run re-checks them/.test(l)));

    // A run: today's check finds the first photo fake.
    const checked = [], pass = deps.check;
    deps.check = async (file, opts) => {
      checked.push(file);
      return file === badFile ? { ok: false, failures: ["looks fake (equipment): a cable row with no machine"], faces: [], focus: [0.5, 0.5], placement: { people_box: null, people_count: 1 } } : pass(file, opts);
    };
    const logs = [];
    const r = await runBatch({ brandDir: dir, brief, deps, log: (m) => logs.push(m) });
    assert.ok(checked.includes(goodFile) && checked.includes(badFile), "both old photos were looked at again");
    assert.equal(calls.length, 3, "one new image — only for the photo that failed");
    assert.equal(r.batch.image_calls, 3, "counted against the batch's budget");
    assert.ok(logs.some((l) => l.includes(`${bad}.png fails today's checks: looks fake (equipment)`)));
    const after = JSON.parse(readFileSync(picsPath, "utf-8"));
    assert.equal(after[good].file, goodFile, "a photo that still passes is kept");
    assert.notEqual(after[bad].file, badFile, "the fake one is replaced");
    assert.ok(existsSync(badFile), "and kept on disk, never overwritten");
    assert.ok(Object.values(after).every((p) => p.checks === CHECKS_VERSION));
    assert.equal(r.batch.ads.length, 4 * 2 * 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Q7 the owner's rulings win: a photo ruled fail is never used, whatever the checks say; one ruled pass skips the quality check; the agent's labels change nothing", async () => {
  // The wrapper on its own.
  const seen = [];
  const base = async (file, opts) => { seen.push(opts); return { ok: true, failures: [], faces: [], focus: [0.5, 0.5], placement: {} }; };
  const check = withRulings(base, { [join("/x", "bad.png")]: { expect: "fail", why: "bar over the face" }, [join("/x", "good.png")]: { expect: "pass", why: "" } });
  const bad = await check(join("/x", "bad.png"), { treatment: "t1-bottom-stack" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures, ["ruled out by the owner: bar over the face"]);
  assert.equal(seen.length, 0, "no check is spent on a photo the owner has ruled out");
  await check(join("/x", "good.png"), { treatment: "t1-bottom-stack" });
  assert.equal(seen[0].skipQuality, true);
  await check(join("/x", "other.png"), { treatment: "t1-bottom-stack" });
  assert.equal(seen[1].skipQuality, undefined, "no ruling, no change");

  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [], out = join(dir, "outputs", "test-batch"), picsPath = join(out, "pictures.json");
    const deps = { ...fakes(calls), browser };
    const brief = { ...BRIEF, max_calls: 4, attempts: 1 };
    await runBatch({ brandDir: dir, brief, deps, log: () => {} });
    const pics = JSON.parse(readFileSync(picsPath, "utf-8"));
    const [a, b] = Object.keys(pics).sort();
    // The owner rules the first photo out; the agent's own label on the second is only a calibration label.
    writeFileSync(join(dir, "quality-calibration.json"), JSON.stringify({ photos: [
      { file: pics[a].file.replace(dir + "/", ""), by: "owner", expect: "fail", why: "sits on nothing" },
      { file: pics[b].file.replace(dir + "/", ""), by: "agent", expect: "fail", why: "the agent thought so" },
    ] }));
    assert.deepEqual(Object.values(loadRulings(dir)).map((r) => r.expect), ["fail"], "only the owner's rulings load");
    const logs = [];
    const r = await runBatch({ brandDir: dir, brief, deps, log: (m) => logs.push(m) });
    assert.equal(calls.length, 3, "one new image, for the ruled-out photo only");
    assert.ok(logs.some((l) => l.includes(`${a}.png fails today's checks: ruled out by the owner: sits on nothing`)));
    const after = JSON.parse(readFileSync(picsPath, "utf-8"));
    assert.notEqual(after[a].file, pics[a].file, "the ruled-out photo is replaced");
    assert.equal(after[b].file, pics[b].file, "the agent's label changed nothing");
    assert.equal(r.batch.photos.filter((p) => p.kind === "generated").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Q6 scene wording that asks a class to move as one is warned about; a candid scene, or one person, is not", () => {
  const group = (scene) => sceneWarnings({ scene, people: 3, setting: "group", pose: "upright" });
  assert.match(group("Three men swinging kettlebells side by side, in time with each other.").join(), /"side by side" asks the people to move as one/);
  assert.equal(group("Four men in planks, each holding a forearm plank.").length, 1);
  assert.equal(group("Three men squatting in unison.").length, 1);
  assert.deepEqual(group("Three men squatting on the rubber floor, loosely spaced, one at the bottom of his squat, one rising, one grinning at the man beside him."), []);
  assert.deepEqual(sceneWarnings({ scene: "A man walking side by side with the wall.", people: 1, setting: "solo" }), [], "one person cannot move in unison with anyone");
});

test("B4b when a photo's other look took its last free layout and the words would cover a face, the ad moves to panels or a collage with the batch's next photos", async () => {
  const { renderPlan } = await import("./assign-variants.mjs");
  const face = svg(1024, 1024, `<rect width="100%" height="100%" fill="#2a1a1a"/><circle cx="230" cy="512" r="60" fill="#c9a27e"/>`);
  const room = svg(1024, 1024, `<rect width="100%" height="100%" fill="#8e1b1b"/><rect y="600" width="1024" height="424" fill="#222"/>`);
  const all = Object.keys(CAT.treatments.treatments);
  const plan = {
    ratio: "1x1",
    // As in the 48-ad batch: this photo can carry T3, T4, T7 and T8 only.
    allowed: { p1: ["t3-right-column", "t4-centred-stack", "t7-collage", "t8-panels-band"], p2: all, p3: all, p4: all },
    pools: { layouts: all, styles: Object.keys(CAT.styles.styles), palettes: Object.keys(CAT.palettes.palettes) },
    candidates: [
      { id: "c01", visual: "p1", images: ["p1"], treatment: "t4-centred-stack", style: "s1-heavy-sans", palette: "white-on-dark" },
      { id: "c02", visual: "p1", images: ["p1"], treatment: "t3-right-column", style: "s3-condensed", palette: "cyan-pink" },
      { id: "c03", visual: "p2", images: ["p2"], treatment: "t1-bottom-stack", style: "s4-wide-tracked", palette: "blue-white" },
      { id: "c04", visual: "p3", images: ["p3"], treatment: "t2-top-bottom-split", style: "s5-italic-heavy", palette: "green-white" },
      { id: "c05", visual: "p4", images: ["p4"], treatment: "t5-offer-band", style: "s6-serif-display", palette: "purple-white" },
    ],
  };
  const results = await renderPlan(browser, plan, { text: { location: "BISHAN", audience: "MEN", offer: "12 Week Total Body Reset" }, imageFor: (id) => (id === "p1" ? face : room), facesFor: (id) => (id === "p1" ? [[440, 170, 560, 290]] : []) });
  const r = results.find((x) => x.id === "c01");
  assert.ok(!r.failed, `c01 found a layout: ${r.failed}`);
  assert.ok(["t7-collage", "t8-panels-band"].includes(r.treatment), `moved to a multi-photo layout, got ${r.treatment}`);
  assert.equal(r.images[0], "p1", "its own photo leads");
  assert.deepEqual(r.images.slice(1), ["p2", "p3", "p4"].slice(0, r.images.length - 1), "then the batch's next photos, in order");
  assert.match(r.replaced.reason, /covers a face/);
  assert.equal(results.find((x) => x.id === "c02").treatment, "t3-right-column", "the other look is untouched");
});

// ── B10 a directed batch ──────────────────────────────────────────────────

test("B10 a directed batch drafts its own scenes in the dry run, is refused until they are confirmed, and confirming approves them into the library", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const drafted = [];
    // The drafter, faked: writes `count` drafts for the batch into the library, as the real one does.
    const draft = async ({ audience, count, direction, source, scenesPath }) => {
      drafted.push({ audience, count, direction, source });
      const lib = JSON.parse(readFileSync(scenesPath, "utf-8"));
      const made = Array.from({ length: count }, (_, i) => ({ id: `w-dir-${drafted.length}-${i + 1}`, audience, pose: "compact", people: 1, exercise: "step-up", age: "older", setting: "solo", equipment: "dumbbells", muscles: "legs", scene: `A woman in her fifties stepping onto a box with dumbbells at her sides (${drafted.length}-${i + 1}).`, draft: true, source, added: "2026-09-13", direction }));
      lib.scenes.push(...made); writeFileSync(scenesPath, JSON.stringify(lib, null, 2));
      return { drafts: made, dropped: [], text_calls: 1, vision_calls: 0 };
    };
    const brief = { ...BRIEF, batch_id: "directed", audience: "LADIES WANTED", generated: 2, real: [], max_calls: 2, direction: { words: "older women stepping onto boxes" } };
    const calls = [], logs = [];
    const deps = { ...fakes(calls), browser, draft };
    const lib = () => JSON.parse(readFileSync(join(dir, "scenes.json"), "utf-8")).scenes;
    // 1 the dry run drafts the batch's scenes and plans with them — and only them, not the library at large.
    const d1 = await runBatch({ brandDir: dir, brief, deps, dryRun: true, log: (m) => logs.push(m) });
    assert.equal(drafted.length, 1);
    assert.deepEqual([drafted[0].audience, drafted[0].count, drafted[0].source, drafted[0].direction], ["women", 2, "batch:directed", brief.direction]);
    assert.deepEqual(d1.plan.visuals.map((v) => v.scene_id).sort(), ["w-dir-1-1", "w-dir-1-2"]);
    assert.ok(!d1.plan.visuals.some((v) => SCENES.some((s) => s.id === v.scene_id)), "the library's own women's scenes are not used");
    assert.ok(logs.some((m) => /2 scene\(s\) drafted for this batch/.test(m)), logs.join("\n"));
    assert.equal(lib().filter((s) => s.source === "batch:directed" && s.draft === true).length, 2, "written as drafts");
    // 2 a real run before confirmation is refused — no image call.
    await assert.rejects(runBatch({ brandDir: dir, brief, deps, log: () => {} }), /2 drafted scene\(s\) await confirmation: w-dir-1-1, w-dir-1-2/);
    assert.equal(calls.length, 0);
    // 3 another dry run drafts nothing more.
    await runBatch({ brandDir: dir, brief, deps, dryRun: true, log: () => {} });
    assert.equal(drafted.length, 1);
    // 4 rejecting one (with a reason) makes the next dry run draft one replacement.
    rejectScene(join(dir, "scenes.json"), "w-dir-1-2", "not the box we have", { date: "2026-09-13" });
    const d2 = await runBatch({ brandDir: dir, brief, deps, dryRun: true, log: () => {} });
    assert.equal(drafted.length, 2); assert.equal(drafted[1].count, 1);
    assert.deepEqual(d2.plan.visuals.map((v) => v.scene_id).sort(), ["w-dir-1-1", "w-dir-2-1"]);
    assert.ok(lib().some((s) => s.id === "w-dir-1-2" && s.status === "retired" && s.reason === "not the box we have"), "the rejected one is kept, retired");
    // 5 confirming approves the drafts into the library and runs the batch.
    const r = await runBatch({ brandDir: dir, brief, deps, approveScenes: true, log: (m) => logs.push(m) });
    assert.equal(r.calls, 2);
    assert.ok(logs.some((m) => /2 scene\(s\) confirmed for this batch: w-dir-1-1, w-dir-2-1/.test(m)), logs.join("\n"));
    const mine = lib().filter((s) => s.source === "batch:directed" && s.status !== "retired");
    assert.equal(mine.length, 2);
    assert.ok(mine.every((s) => s.draft === undefined && s.approved_on && s.approved_via === "directed"), JSON.stringify(mine));
    assert.equal(r.batch.ads.length, 2 * 2 * 2);
    assert.deepEqual(r.batch.photos.map((p) => p.scene_id).sort(), ["w-dir-1-1", "w-dir-2-1"]);
    // 6 a further run drafts nothing and spends nothing; the scenes now live in the library for any women's batch.
    const r2 = await runBatch({ brandDir: dir, brief, deps, log: () => {} });
    assert.equal(drafted.length, 2); assert.equal(r2.calls, 0);
    assert.ok(loadScenes(join(dir, "scenes.json")).some((s) => s.id === "w-dir-2-1"));
    // A directed brief with nothing to generate, or beside the brief's own scenes, is refused up front.
    await assert.rejects(runBatch({ brandDir: dir, brief: { ...brief, generated: 0, real: ["real/r1.png"] }, deps, dryRun: true, log: () => {} }), /direction needs generated photos/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B11 progress.json tells the panel what a run is doing, photo by photo: queued, generating, checking, retrying, passed; the stages; a failed run says why", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const calls = [], out = join(dir, "outputs", "test-batch");
    const read = () => JSON.parse(readFileSync(join(out, "progress.json"), "utf-8"));
    const seen = [];
    const f = fakes(calls);
    const deps = {
      ...f, browser,
      // What the panel would read at each moment: while the model is working, and while the checks are.
      generate: async (...a) => { const p = read(); seen.push(["generate", Object.fromEntries(Object.entries(p.photos).map(([id, x]) => [id, x.state])), p.calls, p.stage]); return f.generate(...a); },
      check: async (file, opts) => {
        const p = read(), id = file.match(/(g\d\d)(-a\d)?\.png$/)[1];
        seen.push(["check", id, p.photos[id].state, p.photos[id].attempt, p.photos[id].file]);
        // g01's first photo shows lettering; its second is fine.
        if (/g01\.png$/.test(file)) return { ok: false, failures: ['stray text in the picture: sign "X"'], faces: [], focus: [0.5, 0.5], placement: { people_box: null, people_count: 1 } };
        return f.check(file, opts);
      },
    };
    const r = await runBatch({ brandDir: dir, brief: BRIEF, deps, log: () => {} });
    // Before the first call: both photos queued; the model is at work on g01, the stage is photos.
    assert.deepEqual(seen[0], ["generate", { g01: "generating", g02: "queued" }, 1, "photos"]);
    assert.deepEqual(seen[1], ["check", "g01", "checking", 1, "visuals/g01.png"], "the photo on disk is being checked; its file is relative to the batch folder");
    assert.deepEqual(seen[2][1], { g01: "generating", g02: "queued" }, "g01 is tried again");
    const retried = seen.find((s) => s[0] === "check" && s[1] === "g01" && s[3] === 2);
    assert.ok(retried, "the second attempt is checked as attempt 2");
    const p = read();
    assert.equal(p.stage, "done");
    assert.equal(p.ads, r.batch.ads.length);
    assert.equal(p.calls, 3);
    assert.equal(p.max_calls, BRIEF.max_calls);
    assert.equal(p.real, 2);
    assert.deepEqual({ state: p.photos.g01.state, attempt: p.photos.g01.attempt, file: p.photos.g01.file }, { state: "passed", attempt: 2, file: "visuals/g01-a2.png" });
    assert.deepEqual(p.photos.g01.notes, ["2 people in the picture; the scene has 1"], "the checks' notes ride along");
    assert.equal(p.photos.g02.state, "passed");
    assert.ok(p.photos.g01.scene && p.photos.g01.treatment && p.photos.g01.scene_id, "each photo says what it is for");
    assert.ok(!existsSync(join(out, "progress.json.tmp")), "replaced whole, never left half-written");
    // A second run reuses both photos: they show as passed from the start, with no call.
    await runBatch({ brandDir: dir, brief: BRIEF, deps: { ...f, browser }, log: () => {} });
    const p2 = read();
    assert.equal(p2.calls, 0);
    assert.equal(p2.spent_before, 3);
    assert.ok(p2.photos.g01.reused && p2.photos.g01.state === "passed");
    // A run that stops says where and why.
    rmSync(join(out, "photos.json")); // the real photos are looked at again (the cache is by file contents)
    const dirty = { ...f, browser, checkPhoto: async () => ({ text: [{ kind: "sign", what: "OPEN" }], never: [], people_count: 0 }) };
    await assert.rejects(runBatch({ brandDir: dir, brief: BRIEF, deps: dirty, log: () => {} }), /not clean/);
    const p3 = read();
    assert.equal(p3.stage, "failed");
    assert.match(p3.error, /real photo real\/r1\.png is not clean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("B12 a gym's brand palettes: with palettes \"brand\" every ad uses one of them and verifies; with \"both\" they join the reference pairings in the spread; with \"reference\" none appear; a re-render keeps them", async () => {
  const dir = brandSetup();
  try {
    await realPhotos(dir);
    const pf = join(dir, "gym-profile.json"), base = JSON.parse(readFileSync(pf, "utf-8"));
    const colours = { primary: { hex: "#0A0A0A" }, secondary: { hex: "#FA1414" }, accent: { hex: "#FFFFFF" } };
    const setMode = (palettes, creative = undefined) => writeFileSync(pf, JSON.stringify({ ...base, brand_lock: { ...base.brand_lock, colors: colours }, creative_defaults: { palettes }, ...(creative ? { creative } : {}) }));
    const brief = { ...BRIEF, batch_id: "palettes", generated: 0, real: ["real/r1.png", "real/r2.png"], looks_per_photo: 3, max_calls: 0 };
    const deps = { ...fakes([]), browser };
    const isBrand = (id) => /^brand(-light|-bold)?$/.test(id);
    // Brand only: 2 photos × 3 looks × 2 locations, every look on a brand palette, every ad verified.
    setMode("brand");
    let r = await runBatch({ brandDir: dir, brief, deps, log: () => {} });
    assert.equal(r.batch.failed.length, 0, JSON.stringify(r.batch.failed));
    assert.equal(r.batch.ads.length, 12);
    assert.ok(r.batch.ads.every((a) => isBrand(a.palette)), r.batch.ads.map((a) => a.palette).join(" "));
    assert.deepEqual([...new Set(r.batch.ads.map((a) => a.palette))].sort(), ["brand", "brand-bold", "brand-light"], "each brand palette is used");
    for (const c of r.results) for (const x of c.renders) assert.ok(x.r.ok, `${c.id}: ${x.r.failures}`);
    for (const ad of r.batch.ads) assert.match(ad.folder, /-brand(-light|-bold)?$/);
    // A free re-render of the same batch keeps the brand palettes (the catalogue is rebuilt from the profile).
    const again = await runBatch({ brandDir: dir, brief: { ...brief, offer: "6 Week Strength Kickstart" }, renderOnly: true, deps, log: () => {} });
    assert.deepEqual(again.batch.ads.map((a) => a.palette), r.batch.ads.map((a) => a.palette));
    assert.ok(again.batch.ads.every((a) => a.words.offer === "6 Week Strength Kickstart"));
    // Both: with six reference pairings switched off, 8 ads over 7 palettes use the brand ones too.
    setMode("both", { exclude_palettes: ["cyan-pink", "red-white", "blue-white", "purple-white", "pink-white", "green-white"] });
    r = await runBatch({ brandDir: dir, brief: { ...brief, batch_id: "palettes-both", looks_per_photo: 4 }, deps, log: () => {} });
    assert.equal(r.batch.failed.length, 0, JSON.stringify(r.batch.failed));
    const used = new Set(r.batch.ads.map((a) => a.palette));
    assert.ok([...used].some(isBrand), `a brand palette is in the spread: ${[...used].join(" ")}`);
    assert.ok([...used].some((id) => !isBrand(id)), `and a reference pairing: ${[...used].join(" ")}`);
    // Reference: none of them, whatever colours the profile has.
    setMode("reference");
    r = await runBatch({ brandDir: dir, brief: { ...brief, batch_id: "palettes-ref" }, deps, log: () => {} });
    assert.ok(r.batch.ads.every((a) => !isBrand(a.palette)));
    // A brand mode with no colours stops the batch before anything is made.
    writeFileSync(pf, JSON.stringify({ ...base, creative_defaults: { palettes: "brand" } }));
    await assert.rejects(runBatch({ brandDir: dir, brief: { ...brief, batch_id: "palettes-none" }, deps, log: () => {} }), /no brand colours/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
