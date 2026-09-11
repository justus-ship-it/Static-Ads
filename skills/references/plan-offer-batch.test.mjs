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
import { validateBrief, sceneAudience, planVisuals, primaryLayouts, loadScenes, adFolders, resolveSelections, runBatch, slug } from "./plan-offer-batch.mjs";
import { poseProblem } from "./visual-prompts.mjs";

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
    [{ max_calls: 40 }, /split the batch/],
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── B2 photos to generate ─────────────────────────────────────────────────

test("B2 each photo to generate gets a layout it is made for and a scene that suits the audience and that layout's pose", () => {
  const prim = primaryLayouts(CAT);
  assert.deepEqual([...prim].sort(), ["t1-bottom-stack", "t2-top-bottom-split", "t3-right-column", "t5-offer-band", "t6-left-column"], "only single-photo layouts with a subject area");
  for (const seed of ["a", "b", "c", "d"]) {
    const vs = planVisuals({ count: 5, scenes: SCENES, audience: "men", seed });
    assert.equal(new Set(vs.map((v) => v.treatment)).size, 5, "five photos, five different layouts");
    for (const v of vs) {
      assert.ok(v.scene_id.startsWith("m-"), `${v.id}: a men's scene for a MEN brief (${v.scene_id})`);
      assert.equal(poseProblem(v.treatment, v.pose), null, `${v.id}: ${v.pose} fits ${v.treatment}`);
      assert.ok(prim.includes(v.treatment));
    }
  }
  assert.deepEqual(planVisuals({ count: 3, scenes: SCENES, audience: "men", seed: "x" }), planVisuals({ count: 3, scenes: SCENES, audience: "men", seed: "x" }), "seeded");
  assert.equal(planVisuals({ count: 0, scenes: [], audience: "men" }).length, 0);
  assert.throws(() => planVisuals({ count: 1, scenes: SCENES.filter((s) => s.audience === "women"), audience: "men" }), /no scene in the library suits/);
  // A layout that only holds low poses (T2, T5) is only given a low scene.
  const lowOnly = planVisuals({ count: 5, scenes: SCENES, audience: "men", seed: "q" }).filter((v) => ["t2-top-bottom-split", "t5-offer-band"].includes(v.treatment));
  for (const v of lowOnly) assert.equal(v.pose, "low");
  assert.deepEqual(planVisuals({ count: 2, scenes: SCENES, audience: "men", seed: "e", exclude: { layouts: ["t1-bottom-stack", "t3-right-column", "t6-left-column"] } }).map((v) => v.treatment).sort(), ["t2-top-bottom-split", "t5-offer-band"], "the client's excluded layouts are never used");
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
    check: async () => ({ ok: true, failures: [], stray_text: [], excluded: [], dismissed: [], faces: [[80, 460, 160, 540]], focus: [0.5, 0.35], placement: { people_box: [80, 400, 420, 600], people_count: 1 } }),
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
