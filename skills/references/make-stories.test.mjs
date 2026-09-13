/**
 * Tests for make-stories.mjs — Stories/Reels (9:16) versions of the selected ads (Step 8).
 * Offline: a batch is made with faked Gemini calls (as the batch tests do), then its stories are made
 * with faked generation, checks and sibling checks. Rendering is real, in Chrome, on synthetic photos.
 *
 *   node --test skills/references/make-stories.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import zlib from "node:zlib";
import { launchBrowser, loadCatalogue, layoutFor } from "./render-composites.mjs";
import { cropImage } from "./clean-photo.mjs";
import { runBatch } from "./plan-offer-batch.mjs";
import { buildVisualPrompt, ANCHOR_CLAUSE } from "./visual-prompts.mjs";
import { generateVisuals } from "./generate-visuals.mjs";
import { judgeSibling } from "./check-quality.mjs";
import { runStories, planStories, bandImage, storiesFile, STORIES_CHECKS, RATIO } from "./make-stories.mjs";

const CAT = loadCatalogue();
const T = CAT.treatments;
const svg = (w, h, body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
const SCENES = [
  { id: "m-up", audience: "men", pose: "upright", people: 1, scene: "A man mid-set of a barbell back squat." },
  { id: "m-cmp", audience: "men", pose: "compact", people: 1, scene: "A man seated pressing dumbbells overhead." },
  { id: "m-low", audience: "men", pose: "low", people: 1, scene: "A man holding the top of a push-up." },
];
const BRIEF = { batch_id: "test-batch", offer: "12 Week Total Body Reset", free: false, locations: ["BISHAN", "ANG MO KIO"], audience: "MEN", generated: 2, real: ["real/r1.png", "real/r2.png"], looks_per_photo: 2, scenes: null, max_calls: 4, attempts: 2, seed: "t" };
const SIZES = { "3:4": [896, 1200], "4:3": [1200, 896], "1:1": [1024, 1024], "9:16": [1080, 1920] };
const short = (id) => id.split("-")[0];

function pngSize(buf) { return [buf.readUInt32BE(16), buf.readUInt32BE(20)]; }

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

/** A synthetic "generated" photo: a dark room with a lighter figure high in the frame. */
async function fakePhoto(w, h, out) {
  return cropImage(browser, svg(w, h, `<rect width="100%" height="100%" fill="#3a1414"/><rect x="${w * 0.2}" y="${h * 0.55}" width="${w * 0.6}" height="${h * 0.3}" fill="#2a2a2a"/><rect x="${w * 0.42}" y="${h * 0.1}" width="${w * 0.16}" height="${h * 0.3}" fill="#c9a27e"/><circle cx="${w * 0.5}" cy="${h * 0.12}" r="${w * 0.04}" fill="#e0b48f"/>`), [0, 0, w, h], out);
}
function brandSetup() {
  const dir = mkdtempSync(join(tmpdir(), "stories-"));
  mkdirSync(join(dir, "brand-assets", "real"), { recursive: true });
  writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym", brand_lock: { photography: { must: ["a real gym"], never: ["the old logo"], people: "SEA mix, 25-45" } } }));
  writeFileSync(join(dir, "scenes.json"), JSON.stringify({ approved: true, scenes: SCENES }));
  return dir;
}
const generate = (calls) => async (prompt, refs, { aspectRatio }) => {
  calls.push({ aspectRatio, prompt, refs });
  const [w, h] = SIZES[aspectRatio] || SIZES["1:1"], p = join(tmpdir(), `gen-${Date.now()}-${Math.random()}.png`);
  await fakePhoto(w, h, p);
  const buffer = readFileSync(p); rmSync(p);
  return { buffer, ext: "png" };
};
// The batch's check: the figure where fakePhoto drew it (fits the 1:1 plan, as in the batch tests).
const check1x1 = async () => ({ ok: true, failures: [], notes: [], stray_text: [], excluded: [], dismissed: [], faces: [[80, 460, 160, 540]], focus: [0.5, 0.35], placement: { people_box: [80, 400, 420, 600], people_count: 1 } });
// A 9:16 photo's check: the people where the layout it was composed for wants them — and nowhere
// else, so a photo composed for one look does not fit the others (the fit-or-second-photo rule).
const box9 = (la) => (short(la) === "t3" ? [300, 60, 700, 420] : short(la) === "t6" ? [300, 580, 700, 940] : short(la) === "t2" ? [330, 350, 440, 650] : [150, 350, 370, 650]);
const check9 = async (file, opts) => { const b = box9(opts.treatment); return { ok: true, failures: [], notes: [], stray_text: [], excluded: [], dismissed: [], faces: [[b[0], (b[1] + b[3]) / 2 - 40, b[0] + 70, (b[1] + b[3]) / 2 + 40]], focus: [0.5, 0.5], placement: { people_box: b, people_count: 1 } }; };
const realPhotos = async (dir) => {
  await cropImage(browser, svg(1535, 1146, `<rect width="100%" height="100%" fill="#8e1b1b"/><rect y="700" width="1535" height="446" fill="#2b2b2b"/><rect x="200" y="420" width="120" height="300" fill="#111"/>`), [0, 0, 1535, 1146], join(dir, "brand-assets", "real", "r1.png"));
  await cropImage(browser, svg(1874, 795, `<rect width="100%" height="100%" fill="#1c1c1c"/><rect y="0" width="1874" height="360" fill="#9c2a2a"/><rect x="900" y="300" width="200" height="300" fill="#444"/>`), [0, 0, 1874, 795], join(dir, "brand-assets", "real", "r2.png"));
};
/** A finished offline batch with every ad selected. Returns its dir and records. */
async function finishedBatch(dir) {
  await realPhotos(dir);
  const calls = [];
  const deps = { generate: generate(calls), check: check1x1, checkRef: async () => [], checkPhoto: async () => ({ text: [], never: [], people_count: 0, people_box: null, face_boxes: [] }), compositor: null, browser };
  const r = await runBatch({ brandDir: dir, brief: BRIEF, deps, log: () => {} });
  const selections = Object.fromEntries(r.batch.ads.map((a) => [a.folder, { "1x1": a.file }]));
  writeFileSync(join(r.out, "selections.json"), JSON.stringify({ ...selections, excluded: [] }));
  return { out: r.out, batch: r.batch };
}
const safe = () => { const [x, y, w, h] = T.safe_area[RATIO], [W, H] = T.canvas[RATIO]; return { x: (x / 100) * W, y: (y / 100) * H, w: (w / 100) * W, h: (h / 100) * H }; };
const inside = (r, S) => r.x >= S.x - 0.01 && r.y >= S.y - 0.01 && r.x + r.w <= S.x + S.w + 0.01 && r.y + r.h <= S.y + S.h + 0.01;

test("S1 the plan: one 9:16 photo per photo in a single-photo look, its primary layout first; collage and panels ads need none; real photos are bands", async () => {
  const dir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(dir);
    const chosen = (await import("./plan-offer-batch.mjs")).resolveSelections(out);
    const plan = planStories(batch, chosen, { catalogue: CAT });
    const singles = plan.ads.filter((a) => a.background === "single"), multis = plan.ads.filter((a) => a.background !== "single");
    assert.equal(plan.ads.length, batch.ads.length);
    assert.ok(singles.length > 0 && multis.length > 0, `the seeded plan has both kinds (${singles.length} single, ${multis.length} multi)`);
    for (const a of multis) assert.ok(["collage", "panels"].includes(layoutFor(T.treatments[a.treatment], RATIO, T).background.type));
    // Every photo of a single-photo ad is planned once, with every layout it is picked in.
    const want = {};
    for (const a of singles) (want[a.photos[0]] ||= new Set()).add(a.treatment);
    assert.deepEqual(plan.photos.map((p) => p.id).sort(), Object.keys(want).sort());
    for (const p of plan.photos) {
      assert.deepEqual(new Set(p.layouts), want[p.id]);
      if (p.primary && p.layouts.includes(p.primary)) assert.equal(p.layouts[0], p.primary, `${p.id}: composed for its own layout first`);
      assert.equal(p.kind, p.id.startsWith("g") ? "generated" : "real");
    }
    assert.equal(plan.generated + plan.real, plan.photos.length);
    // Only collage/panels ads selected: nothing to generate.
    const onlyMulti = planStories(batch, chosen.filter((a) => multis.some((m) => m.folder === a.folder)), { catalogue: CAT });
    assert.deepEqual(onlyMulti.photos, []);
    console.log(`    plan: ${plan.photos.map((p) => `${p.id}→${p.layouts.map(short).join("/")}`).join(" ")}; ${multis.length} collage/panels ads`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S2 the 9:16 prompt is anchored to the chosen photo, which goes first to the model; a photo composed for one look is fitted against the others and a look it misses gets its own photo", async () => {
  const P = { people: "SEA mix, ages 20-65", must: ["a real gym"], never: [] };
  const anchored = buildVisualPrompt({ treatment: "t1-bottom-stack", scene: "A man mid-set.", ratio: RATIO, photography: P, hasReference: true, anchor: true }).prompt;
  assert.ok(anchored.includes(ANCHOR_CLAUSE));
  assert.match(anchored, /vertical 9:16/);
  assert.match(anchored, /The second attached photo is the real gym/);
  const plain = buildVisualPrompt({ treatment: "t1-bottom-stack", scene: "A man mid-set.", ratio: RATIO, photography: P, hasReference: true }).prompt;
  assert.ok(!plain.includes(ANCHOR_CLAUSE));
  assert.match(plain, /The attached reference photo is the real gym/);
  assert.match(anchored, /14% and 38%|band between/, "the subject is placed for the 9:16 layout");

  // The anchor is the first part sent to the model, the room reference second.
  const dir = mkdtempSync(join(tmpdir(), "anchor-"));
  try {
    const anchor = join(dir, "chosen.png"), room = join(dir, "room.png");
    await fakePhoto(200, 200, anchor); await fakePhoto(120, 90, room);
    const calls = [];
    await generateVisuals({ visuals: [{ id: "g01-9x16", treatment: "t1-bottom-stack", scene: "A man mid-set.", pose: "compact", people: 1, anchor }], photography: P, outDir: join(dir, "out"), ratio: RATIO, refs: [room], anchorFor: (v) => v.anchor, generate: generate(calls), check: check9, checkRef: async () => [], log: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].aspectRatio, "9:16");
    assert.equal(calls[0].refs.length, 2);
    assert.equal(calls[0].refs[0].inline_data.data, readFileSync(anchor).toString("base64"), "the chosen photo is the first part");
    assert.equal(calls[0].refs[1].inline_data.data, readFileSync(room).toString("base64"));
    assert.ok(calls[0].prompt.includes(ANCHOR_CLAUSE));
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // Fit or a second photo, on a whole batch. The seeded batch gives each generated photo one
  // single-photo look, so a second look on g01 (a column, T3) is added by hand: its first 9:16 photo
  // is composed for its own layout and, by the fake check, fits only that.
  const bdir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(bdir);
    const g01 = batch.ads.find((a) => a.photos[0] === "g01" && a.photos.length === 1);
    assert.ok(g01 && !g01.treatment.startsWith("t3"), "g01 has a single-photo look that is not T3");
    const extra = { ...g01, folder: "199-cx-bishan-t3-cyan-pink", file: "199-cx-bishan-t3-cyan-pink/1x1/cx-bishan_1x1_v1.png", candidate: "cx", treatment: "t3-right-column", style: "s3-condensed", palette: "cyan-pink", location: "BISHAN", location_index: 0 };
    const bj = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")); bj.ads.push(extra); writeFileSync(join(out, "batch.json"), JSON.stringify(bj));
    const sel = JSON.parse(readFileSync(join(out, "selections.json"), "utf-8")); sel[extra.folder] = { "1x1": extra.file }; writeFileSync(join(out, "selections.json"), JSON.stringify(sel));
    const calls = [], logs = [];
    const r = await runStories({ brandDir: bdir, batchId: "test-batch", deps: { generate: generate(calls), check: check9, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser, gallery: () => {} }, log: (m) => logs.push(m) });
    const twoLooks = r.plan.photos.filter((p) => p.kind === "generated" && p.layouts.length > 1);
    assert.deepEqual(twoLooks.map((p) => [p.id, p.layouts.map(short)]), [["g01", [short(g01.treatment), "t3"]]], "g01 now has two looks, its own first");
    // One call per generated photo, plus one per second look the first photo does not fit.
    const extras = twoLooks.flatMap((p) => p.layouts.slice(1).map((la) => `${p.id}-${RATIO}-${short(la)}`));
    assert.deepEqual(extras, [`g01-${RATIO}-t3`]);
    assert.ok(!r.stories.photos[`g01-${RATIO}`].failures?.length, "the first photo passed its own look");
    const made = Object.keys(r.stories.photos).filter((id) => r.stories.photos[id].kind === "generated");
    assert.deepEqual(made.sort(), [...r.plan.photos.filter((p) => p.kind === "generated").map((p) => `${p.id}-${RATIO}`), ...extras].sort());
    assert.equal(calls.length, made.length, "one image call per 9:16 photo");
    assert.ok(calls.every((c) => c.aspectRatio === "9:16"));
    assert.ok(logs.some((l) => /1 look\(s\) not fitted by the first 9:16 photo: g01-9x16-t3/.test(l)));
    // Every selected ad got its Stories version, from a photo that fits its layout; the added look from the second photo.
    assert.equal(r.stories.ads.length, batch.ads.length + 1, `all ${batch.ads.length + 1} ads: failed ${JSON.stringify(r.stories.failed)} left out ${JSON.stringify(r.stories.left_out)}`);
    assert.deepEqual(r.stories.ads.find((a) => a.candidate === "cx").photos, [`g01-${RATIO}-t3`]);
    assert.deepEqual(r.stories.ads.find((a) => a.candidate === g01.candidate && a.location === "BISHAN").photos, [`g01-${RATIO}`]);
    for (const ad of r.stories.ads.filter((a) => a.photos[0].includes(`-${RATIO}`))) {
      const rec = r.stories.photos[ad.photos[0]];
      assert.equal(rec.status, "passed");
      assert.ok(rec.treatment === ad.treatment || !extras.includes(ad.photos[0]), `${ad.folder}: ${ad.photos[0]} was composed for ${rec.treatment}`);
    }
    console.log(`    9:16 photos: ${made.join(" ")}; ${calls.length} calls`);
  } finally { rmSync(bdir, { recursive: true, force: true }); }
});

test("S3 the sibling check is a gate with a retry; the stories budget holds across runs; photos on disk are re-checked for free; nothing is overwritten", async () => {
  assert.equal(judgeSibling({ same_people: true, same_clothes: true, same_setting: true, differences: "" }).ok, true);
  const people = judgeSibling({ same_people: false, same_clothes: true, same_setting: true, differences: "a younger man" });
  assert.deepEqual(people.failures, ["not the same people as the chosen photo: a younger man"]);
  assert.match(judgeSibling({ same_people: true, same_clothes: false, same_setting: true, differences: "a red shirt" }).failures[0], /clothes differ/);
  const spot = judgeSibling({ same_people: true, same_clothes: true, same_setting: false, differences: "further from the window" });
  assert.equal(spot.ok, true, "the spot in the room is a note, not a gate");
  assert.deepEqual(spot.notes, ["not quite the same spot as the chosen photo: further from the window"]);

  const dir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(dir);
    const calls = [], siblings = [];
    // The first attempt at the first photo (g01-9x16.png) is a different man — every time it is looked at.
    const sibling = async (anchor, file) => { siblings.push({ anchor, file }); if (basename(file) === `g01-${RATIO}.png`) return { ok: false, failures: ["not the same people as the chosen photo: a different man"], notes: [] }; return { ok: true, failures: [], notes: ["not quite the same spot as the chosen photo"] }; };
    const deps = { generate: generate(calls), check: check9, sibling, compositor: null, browser, gallery: () => {} };
    // A budget of 2: the first attempt fails the sibling check and is retried (2 calls); nothing else can be made.
    const logs = [];
    const r1 = await runStories({ brandDir: dir, batchId: "test-batch", maxCalls: 2, deps, log: (m) => logs.push(m) });
    assert.equal(calls.length, 2, "the first photo's failed attempt and its retry");
    assert.equal(r1.stories.image_calls, 2);
    assert.ok(siblings.every((s) => existsSync(s.anchor) && existsSync(s.file)), "the sibling check sees the chosen photo and the candidate");
    const first = r1.plan.photos.find((p) => p.kind === "generated");
    const rec = r1.stories.photos[`${first.id}-${RATIO}`];
    assert.equal(rec.status, "passed");
    assert.match(basename(rec.file), /-a2\.png$/, "the retry is the photo in use");
    assert.ok(existsSync(join(out, "visuals", `${first.id}-${RATIO}.png`)), `the failed attempt is kept on disk (have: ${readdirSync(join(out, "visuals")).join(" ")}; in use: ${basename(rec.file)})`);
    assert.deepEqual(rec.notes, ["not quite the same spot as the chosen photo"], "the sibling's note rides with the photo");
    assert.ok(logs.some((l) => /budget of 2 (image )?calls (is spent|reached)/.test(l)), `the budget stopped the second photo: ${logs.join(" | ")}`);
    // g02 could not be generated within the budget: its ads still get a Stories version, from the chosen photo as a band.
    assert.deepEqual([...r1.stories.left_out, ...r1.stories.failed], []);
    assert.equal(r1.stories.ads.length, r1.plan.ads.length);
    const la2 = short(r1.plan.photos.find((p) => p.id === "g02").layouts[0]);
    for (const a of r1.stories.ads.filter((a) => a.photos[0].startsWith("g02-"))) assert.deepEqual(a.photos, [`g02-${RATIO}-band-${la2}`]);
    assert.equal(r1.stories.photos[`g02-${RATIO}-band-${la2}`].kind, "band");
    assert.equal(JSON.parse(readFileSync(join(out, "spend.json"), "utf-8")).stories_image_calls, 2);
    assert.equal(JSON.parse(readFileSync(join(out, "spend.json"), "utf-8")).image_calls, batch.image_calls, "the batch's own count is untouched");
    const bands = r1.plan.photos.filter((p) => p.kind !== "generated");
    for (const p of bands) assert.equal(r1.stories.photos[`${p.id}-${RATIO}`].kind, "band", "real photos never cost a call");
    // A re-run with the budget raised: the photo in use is re-checked for free and kept; the rest are made.
    const r2 = await runStories({ brandDir: dir, batchId: "test-batch", maxCalls: 6, deps, log: () => {} });
    assert.equal(r2.stories.photos[`${first.id}-${RATIO}`].file, rec.file, "still in use");
    const gen = r2.plan.photos.filter((p) => p.kind === "generated").length;
    assert.ok(calls.length >= 2 + gen - 1, "the others were made");
    assert.equal(r2.stories.image_calls, calls.length, "the stories count is cumulative across runs");
    assert.ok(r2.stories.image_calls <= 6);
    const files = readdirSync(join(out, "visuals")).filter((n) => n.includes(`-${RATIO}`));
    assert.equal(new Set(files).size, files.length);
    // A photo the owner has ruled out is never used, whatever the checks say.
    writeFileSync(join(dir, "quality-calibration.json"), JSON.stringify({ photos: [{ file: rec.file.replace(dir + "/", ""), by: "owner", expect: "fail", why: "a different man after all" }] }));
    const logs3 = [];
    const r3 = await runStories({ brandDir: dir, batchId: "test-batch", maxCalls: 8, deps, log: (m) => logs3.push(m) });
    assert.ok(!r3.stories.ads.some((a) => r3.stories.photos[a.photos[0]]?.file === rec.file), "the ruled-out photo serves no ad");
    // Its two attempts on disk are the run's allowance: no third try — the chosen photo as a band instead.
    assert.ok(logs3.some((l) => new RegExp(`${first.id}-${RATIO}: 2 attempt\\(s\\) on disk already, none passing — no more tries`).test(l)), logs3.join(" | "));
    assert.equal(calls.length, r2.stories.image_calls, "no new call");
    for (const a of r3.stories.ads.filter((a) => a.photos[0].startsWith(`${first.id}-`))) assert.match(a.photos[0], new RegExp(`^${first.id}-${RATIO}-band-t\\d$`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S4 every Stories version renders inside Meta's safe zone with its 1:1's look and words, per location alike; collage and panels reuse the batch's photos; real photos are bands in the live area; the gallery shows both ratios", async () => {
  const dir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(dir);
    const deps = { generate: generate([]), check: check9, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser };
    const r = await runStories({ brandDir: dir, batchId: "test-batch", deps, log: () => {} });
    assert.equal(r.stories.ads.length, batch.ads.length);
    const S = safe(), byFolder = new Map(batch.ads.map((a) => [a.folder, a]));
    for (const ad of r.stories.ads) {
      const one = byFolder.get(ad.folder);
      assert.equal(ad.file, storiesFile(one.file));
      assert.match(ad.file, /\/9x16\/.*_9x16_v1\.png$/);
      const png = readFileSync(join(out, ad.file));
      assert.deepEqual(pngSize(png), T.canvas[RATIO], `${ad.folder}: 1080×1920`);
      for (const k of ["treatment", "style", "palette", "location"]) assert.equal(ad[k], one[k], `${ad.folder}: same ${k} as its 1:1`);
      assert.deepEqual(ad.words, one.words);
      if (["collage", "panels"].includes(layoutFor(T.treatments[ad.treatment], RATIO, T).background?.type)) assert.deepEqual(ad.photos, one.photos, `${ad.folder}: the batch's own photos`);
      else assert.ok(r.stories.photos[ad.photos[0]]?.status === "passed" && ad.photos[0].startsWith(`${one.photos[0]}-${RATIO}`), `${ad.folder}: a 9:16 photo of ${one.photos[0]}`);
    }
    // Each look's locations share the identical look; every line sits inside the safe area (the renderer's report).
    for (const res of r.results) {
      assert.ok(!res.failed, `${res.id}: ${JSON.stringify(res.failed)}`);
      assert.equal(res.renders.length, 2, `${res.id}: both locations`);
      for (const { r: rr } of res.renders) {
        assert.ok(rr.ok);
        for (const g of rr.report.groups) assert.ok(inside(g.region, S), `${res.id}: group region inside the safe area`);
        for (const b of rr.report.blocks) {
          assert.ok(inside(b.rect, S), `${res.id}: "${b.text}" inside the safe area`);
          for (const l of b.ink_lines || []) assert.ok(inside(l, S), `${res.id}: the letters of "${b.text}" inside the safe area`);
          if (b.band) assert.ok(inside(b.band, S), `${res.id}: "${b.text}" band inside the safe area`);
        }
      }
      assert.equal(res.replaced, undefined, "never swapped: a Stories version matches its 1:1");
    }
    // Real photos: a band in the live area, the frame filled by a blurred copy.
    for (const p of r.plan.photos.filter((p) => p.kind !== "generated")) {
      const rec = r.stories.photos[`${p.id}-${RATIO}`];
      assert.equal(rec.kind, "band");
      assert.deepEqual(pngSize(readFileSync(rec.file)), [1080, 1920]);
      const [x, y, w, h] = rec.band, live = [0.14 * 1920, 0.65 * 1920];
      assert.equal(w, 1080, "across the full width");
      assert.ok(y >= live[0] - 1 && y + h <= live[1] + 1, "inside the live area");
      assert.ok(Math.abs((y + h / 2) - (live[0] + live[1]) / 2) <= 1, "centred in it");
    }
    const html = readFileSync(join(out, "gallery.html"), "utf-8");
    assert.ok(html.includes("9x16") && html.includes("_9x16_v1.png"), "the gallery shows the 9:16 versions");
    assert.ok(existsSync(join(out, "selections.json")), "the selections survive the rebuild");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S5 --render-only re-renders every Stories version from the 9:16 photos on disk for the batch's current words: zero image calls", async () => {
  const dir = brandSetup();
  try {
    const { out } = await finishedBatch(dir);
    const calls = [];
    const deps = { generate: generate(calls), check: check9, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser, gallery: () => {} };
    const r1 = await runStories({ brandDir: dir, batchId: "test-batch", deps, log: () => {} });
    const made = calls.length;
    // New words: the batch is re-rendered (free), then its stories.
    const deps1 = { generate: generate(calls), check: check1x1, checkRef: async () => [], checkPhoto: async () => ({ text: [], never: [], people_count: 0, people_box: null, face_boxes: [] }), compositor: null, browser };
    await runBatch({ brandDir: dir, brief: { ...BRIEF, offer: "6 Week Strength Kickstart" }, renderOnly: true, deps: deps1, log: () => {} });
    const r2 = await runStories({ brandDir: dir, batchId: "test-batch", renderOnly: true, deps, log: () => {} });
    assert.equal(calls.length, made, "no image call");
    assert.equal(r2.stories.image_calls_this_run, 0);
    assert.equal(r2.stories.ads.length, r1.stories.ads.length);
    for (const ad of r2.stories.ads) assert.equal(ad.words.offer, "6 Week Strength Kickstart");
    for (const res of r2.results) for (const { r: rr } of res.renders) assert.ok(rr.report.blocks.some((b) => /KICKSTART/i.test(b.text)), `${res.id}: the new offer is on the ad`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S6 a look the scene's pose cannot be composed for is skipped, not fatal; a photo with no passing native 9:16 falls back to the chosen photo as a band, its boxes moved with it", async () => {
  const { inBand } = await import("./make-stories.mjs");
  // A 3:4 photo fitted to the live band's height: x 174–905, y 269–1248 of 1080×1920.
  const band = [174, 269, 731, 979];
  const moved = inBand({ people_box: [0, 0, 1000, 1000], face_boxes: [[100, 400, 200, 600]], people_count: 1 }, band);
  assert.deepEqual(moved.people_box, [140, 161, 650, 838], "the whole photo maps onto the band");
  assert.deepEqual(moved.face_boxes, [[191, 432, 242, 567]]);
  assert.equal(moved.people_count, 1);
  assert.deepEqual(inBand(null, band), { people_box: null, face_boxes: [], people_count: 0 });

  const dir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(dir);
    // P: a generated photo whose scene's pose some layout refuses — it gets that look by hand, so no
    // 9:16 can be composed for it. Q: the other generated photo, whose native 9:16 never places.
    const { poseProblem } = await import("./visual-prompts.mjs");
    const vis = JSON.parse(readFileSync(join(out, "visuals.json"), "utf-8")).visuals;
    const singleAds = batch.ads.filter((a) => a.photos.length === 1 && a.photos[0].startsWith("g"));
    const LAYOUTS = ["t1-bottom-stack", "t2-top-bottom-split", "t3-right-column", "t5-offer-band", "t6-left-column"];
    let picked = null;
    for (const a of singleAds) { const v = vis.find((x) => x.id === a.photos[0]); const bad = LAYOUTS.find((la) => la !== a.treatment && poseProblem(la, v.pose, CAT)); if (bad && !picked) picked = { ad: a, bad, pose: v.pose }; }
    assert.ok(picked, "a generated photo whose pose some layout refuses");
    const other = singleAds.find((a) => a.photos[0] !== picked.ad.photos[0]);
    assert.ok(other, "and another generated photo");
    const P = picked.ad.photos[0], Q = other.photos[0], bad = picked.bad;
    // The batch's recorded 1:1 check for Q: its subject where its layout's prompt put it in the whole
    // photo (the fixture's fixed box is dead centre, which no column photo has) — the band inherits it.
    const pics = JSON.parse(readFileSync(join(out, "pictures.json"), "utf-8")), qb = box9(other.treatment);
    pics[Q].check.placement.people_box = qb; pics[Q].check.faces = [[qb[0], (qb[1] + qb[3]) / 2 - 40, qb[0] + 70, (qb[1] + qb[3]) / 2 + 40]];
    writeFileSync(join(out, "pictures.json"), JSON.stringify(pics));
    const extra = { ...picked.ad, folder: `199-cx-bishan-${short(bad)}-cyan-pink`, file: `199-cx-bishan-${short(bad)}-cyan-pink/1x1/cx-bishan_1x1_v1.png`, candidate: "cx", treatment: bad, style: "s3-condensed", palette: "cyan-pink", location: "BISHAN", location_index: 0 };
    const bj = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")); bj.ads.push(extra); writeFileSync(join(out, "batch.json"), JSON.stringify(bj));
    const sel = JSON.parse(readFileSync(join(out, "selections.json"), "utf-8")); sel[extra.folder] = { "1x1": extra.file }; writeFileSync(join(out, "selections.json"), JSON.stringify(sel));
    const calls = [], logs = [];
    const check = async (file, opts) => (basename(file).startsWith(`${Q}-`) ? { ok: false, failures: ["64% of the people sit under text areas (max 40%)"], notes: [], faces: [], focus: [0.5, 0.5], placement: { people_box: [300, 300, 900, 700], people_count: 1 } } : check9(file, opts));
    const r = await runStories({ brandDir: dir, batchId: "test-batch", deps: { generate: generate(calls), check, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser, gallery: () => {} }, log: (m) => logs.push(m) });
    assert.ok(logs.some((l) => new RegExp(`${P}: no 9:16 photo is composed for ${short(bad)} \\(${bad} cannot hold`).test(l)), logs.join(" | "));
    assert.equal(calls.length, 1 + 2, `${P} once, ${Q} twice — nothing for the ${short(bad)} look`);
    assert.ok(calls.every((c) => !c.prompt.includes(`-${short(bad)}`)));
    // P's own look keeps its native 9:16; the refused look is served by P's band where it fits, else left out — never a crash.
    assert.deepEqual(r.stories.ads.find((a) => a.candidate === picked.ad.candidate && a.location === "BISHAN").photos, [`${P}-${RATIO}`]);
    const cx = r.stories.ads.find((a) => a.candidate === "cx");
    // (The crafted look keeps the 1:1 ad's placement, so the band is tried for it; if its render cannot verify, it is recorded as failed.)
    if (cx) assert.deepEqual(cx.photos, [`${P}-${RATIO}-band-${short(bad)}`]); else assert.ok(r.stories.left_out.some((l) => l.candidate === "cx") || r.stories.failed.some((f) => f.candidate === "cx"), JSON.stringify([r.stories.left_out, r.stories.failed]));
    // Q's looks come from its band; every one of Q's ads has a Stories version.
    const qAds = r.stories.ads.filter((a) => a.photos[0].startsWith(`${Q}-`));
    assert.equal(qAds.length, batch.ads.filter((a) => a.photos.length === 1 && a.photos[0] === Q).length);
    for (const a of qAds) assert.deepEqual(a.photos, [`${Q}-${RATIO}-band-${short(a.treatment)}`]);
    for (const id of [`${P}-${RATIO}-band-${short(bad)}`, `${Q}-${RATIO}-band-${short(other.treatment)}`]) {
      const rec = r.stories.photos[id];
      assert.equal(rec.kind, "band", id);
      assert.deepEqual(pngSize(readFileSync(rec.file)), [1080, 1920]);
      assert.match(rec.notes[0], /^the 1:1 ad's crop of the chosen photo as a band/);
      assert.equal(rec.crop.length, 4, "the window the 1:1 ad showed");
      // The 1:1 check's boxes, moved onto the canvas: inside where the band drew the photo.
      const [bx, by, bw, bh] = rec.band, within = ([y0, x0, y1, x1]) => y0 >= (by / 1920) * 1000 - 1 && x0 >= (bx / 1080) * 1000 - 1 && y1 <= ((by + bh) / 1920) * 1000 + 1 && x1 <= ((bx + bw) / 1080) * 1000 + 1;
      assert.ok(rec.answer.people_box && within(rec.answer.people_box), `${id}: people inside the band`);
      assert.ok(rec.answer.face_boxes.length && rec.answer.face_boxes.every(within), `${id}: faces inside the band`);
    }
    assert.ok(logs.some((l) => new RegExp(`${Q}: t\\d from the chosen photo's 1:1 crop as a band \\(no image call\\)`).test(l)), logs.join(" | "));
    assert.equal(JSON.parse(readFileSync(join(out, "spend.json"), "utf-8")).stories_image_calls, 3);
    assert.equal(r.stories.partial, undefined, "the final record is not a checkpoint");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S7 the band is the 1:1 ad's own crop: the window maths, boxes moved through it; a native 9:16 that verifies for one location but not the other falls back to that band at render time", async () => {
  const { cropWindow, inBand } = await import("./make-stories.mjs");
  assert.deepEqual(cropWindow([896, 1200], [0.5, 0.35]), [0, 106.4, 896, 896], "a portrait photo: a full-width square slid down by fy");
  assert.deepEqual(cropWindow([1200, 896], [0.2, 0.5]), [60.8, 0, 896, 896], "a landscape one: a full-height square slid across by fx");
  assert.deepEqual(cropWindow([1024, 1024]), [0, 0, 1024, 1024]);
  // A face at [200,400,300,600] per mille of a 896×1200 photo, through the crop, onto a 979-px square band at (50, 269).
  const moved = inBand({ people_box: null, face_boxes: [[200, 400, 300, 600]], people_count: 1 }, [50, 269, 979, 979], { crop: [0, 106.4, 896, 896], size: [896, 1200] });
  const want = [216, 408, 284, 591];
  moved.face_boxes[0].forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 1, `face box ${moved.face_boxes[0]} ≈ ${want}`));
  // A box outside the window is clipped to it; one entirely outside vanishes.
  const clipped = inBand({ people_box: [0, 0, 1000, 1000], face_boxes: [[0, 0, 50, 50]], people_count: 1 }, [50, 269, 979, 979], { crop: [0, 106.4, 896, 896], size: [896, 1200] });
  assert.deepEqual(clipped.people_box, [140, 46, 650, 953]);
  assert.deepEqual(clipped.face_boxes, [], "a face above the window is not on the band");

  const dir = brandSetup();
  try {
    const { out, batch } = await finishedBatch(dir);
    // The native 9:16 of one photo places fine but carries a face where its layout's words land in 9:16:
    // the fit passes (faces are the renderer's business), the render fails, the band of the 1:1 crop stands in.
    const victim = batch.ads.find((a) => a.photos.length === 1 && a.photos[0].startsWith("g")), V = victim.photos[0];
    const L = layoutFor(T.treatments[victim.treatment], RATIO, T), g = L.groups[0].region; // [x, y, w, h] in %
    const faceIn = [Math.round((g[1] + g[3] * 0.45) * 10), Math.round((g[0] + g[2] * 0.45) * 10), Math.round((g[1] + g[3] * 0.55) * 10), Math.round((g[0] + g[2] * 0.55) * 10)];
    const check = async (file, opts) => { const c = await check9(file, opts); return basename(file).startsWith(`${V}-`) ? { ...c, faces: [faceIn] } : c; };
    const calls = [], logs = [];
    const r = await runStories({ brandDir: dir, batchId: "test-batch", deps: { generate: generate(calls), check, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser, gallery: () => {} }, log: (m) => logs.push(m) });
    assert.equal(r.stories.ads.length, batch.ads.length, `every ad: failed ${JSON.stringify(r.stories.failed)} left out ${JSON.stringify(r.stories.left_out)}`);
    const band = `${V}-${RATIO}-band-${short(victim.treatment)}`;
    for (const a of r.stories.ads.filter((a) => a.photos[0].startsWith(`${V}-`))) assert.deepEqual(a.photos, [band], `${a.folder}: the band, not the native 9:16`);
    assert.equal(r.stories.photos[`${V}-${RATIO}`].status, "passed", "the native photo passed its checks; it just could not carry the words");
    assert.match(r.stories.photos[band].notes[0], /the native 9:16 did not verify: .*covers a face/);
    assert.equal(r.stories.photos[band].crop?.length, 4, "the window the 1:1 ad showed is recorded");
    assert.equal(r.results.filter((x) => x.failed).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S8 a band keeps the layout its 1:1 ad verified even when its own 9:16 fit misses the 40% rule (the derived layouts scale differently); the finished ad is still verified", async () => {
  const { inBand, cropWindow } = await import("./make-stories.mjs");
  const { fitLayouts, imageSize } = await import("./check-visual.mjs");
  const dir = brandSetup();
  // Compact and low scenes only, so every generated photo may carry the bottom stack — the layout whose
  // 9:16 derivation differs most from the 1:1 crop at the frame's left edge (g03 in the women's batch).
  writeFileSync(join(dir, "scenes.json"), JSON.stringify({ approved: true, scenes: SCENES.filter((s) => s.pose !== "upright") }));
  try {
    const { out, batch } = await finishedBatch(dir);
    const la = "t1-bottom-stack";
    const single = batch.ads.filter((a) => a.photos.length === 1 && a.photos[0].startsWith("g") && a.location === "BISHAN");
    let victim = single.find((a) => a.treatment === la);
    if (!victim) { // give a generated photo a bottom-stack look by hand, as the batch could have
      victim = { ...single[0], folder: "198-cy-bishan-t1-cyan-pink", file: "198-cy-bishan-t1-cyan-pink/1x1/cy-bishan_1x1_v1.png", candidate: "cy", treatment: la, style: "s3-condensed", palette: "cyan-pink", crop: [[0.5, 0.5]], location: "BISHAN", location_index: 0 };
      const bj = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")); bj.ads.push(victim); writeFileSync(join(out, "batch.json"), JSON.stringify(bj));
      const sel = JSON.parse(readFileSync(join(out, "selections.json"), "utf-8")); sel[victim.folder] = { "1x1": victim.file }; writeFileSync(join(out, "selections.json"), JSON.stringify(sel));
    }
    const Q = victim.photos[0];
    const pics = JSON.parse(readFileSync(join(out, "pictures.json"), "utf-8"));
    const size = imageSize(readFileSync(pics[Q].file)), crop = cropWindow(size, victim.crop[0]), band = [50, 269, 979, 979];
    // A people box (per mille of the photo) that fits the layout in 1:1 at this crop but not its 9:16
    // derivation once moved onto the band: a subject hugging the left edge, tall in the frame.
    const toPhoto = ([y0, x0, y1, x1]) => [y0, x0, y1, x1].map((v, i) => Math.round(((i % 2 ? crop[0] : crop[1]) + (v / 1000) * (i % 2 ? crop[2] : crop[3])) / (i % 2 ? size[0] : size[1]) * 1000));
    let found = null;
    for (const w of [120, 160, 200]) for (const h of [500, 600, 660]) for (const x0 of [0, 20]) for (const y0 of [100, 180, 220, 300]) {
      if (y0 + h > 1000) continue;
      const inPhoto = toPhoto([y0, x0, y0 + h, x0 + w]);
      const a1 = { people_box: inPhoto, face_boxes: [[inPhoto[0], inPhoto[1], inPhoto[0] + 40, inPhoto[1] + 40]], people_count: 1 };
      const f1 = fitLayouts(a1, { ratio: "1x1", imageSize: size, expectPeople: true, maxPeople: 1, catalogue: CAT })[la];
      const f9 = fitLayouts(inBand(a1, band, { crop, size }), { ratio: RATIO, imageSize: [1080, 1920], expectPeople: true, maxPeople: 1, catalogue: CAT })[la];
      if (f1.ok && !f9.ok && /under text areas/.test(f9.failures.join(" "))) { found = { a1, f9 }; break; }
    }
    assert.ok(found, `a box that fits ${la} in 1:1 but not in 9:16 (${size.join("×")}, crop ${crop})`);
    pics[Q].check.placement.people_box = found.a1.people_box; pics[Q].check.faces = found.a1.face_boxes;
    writeFileSync(join(out, "pictures.json"), JSON.stringify(pics));
    const calls = [], logs = [];
    // Q's native 9:16 never places, so its looks fall back to the band of the 1:1 crop.
    const check = async (file, opts) => (basename(file).startsWith(`${Q}-`) ? { ok: false, failures: ["64% of the people sit under text areas (max 40%)"], notes: [], faces: [], focus: [0.5, 0.5], placement: { people_box: [300, 300, 900, 700], people_count: 1 } } : check9(file, opts));
    const r = await runStories({ brandDir: dir, batchId: "test-batch", deps: { generate: generate(calls), check, sibling: async () => ({ ok: true, failures: [], notes: [] }), compositor: null, browser, gallery: () => {} }, log: (m) => logs.push(m) });
    const bandId = `${Q}-${RATIO}-band-${short(la)}`, rec = r.stories.photos[bandId];
    assert.ok(rec, "the band was made");
    assert.match(rec.notes.join(" | "), new RegExp(`placement inherited from the 1:1 ad, which verified with this crop \\(the band's own fit for ${short(la)}: \\d+% of the people sit under text areas`));
    assert.ok(logs.some((l) => new RegExp(`${Q}: the ${short(la)} band keeps the 1:1 ad's placement`).test(l)), logs.join(" | "));
    const wanted = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")).ads.filter((a) => a.candidate === victim.candidate).length;
    const made = r.stories.ads.filter((a) => a.candidate === victim.candidate);
    assert.equal(made.length, wanted, `every location made from the band: left out ${JSON.stringify(r.stories.left_out)}, failed ${JSON.stringify(r.stories.failed)}`);
    for (const a of made) assert.deepEqual(a.photos, [bandId]);
    // Still verified: the render puts no letter on the face and stays in the safe area.
    const res = r.results.find((x) => x.id === victim.candidate);
    assert.ok(res && !res.failed, JSON.stringify(res?.failed));
    const S = safe();
    for (const x of res.renders) for (const bl of x.r.report.blocks) assert.ok(inside(bl.rect, S), `${bl.block} inside the safe area`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
