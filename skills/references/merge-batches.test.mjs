/**
 * Tests for merging batches (merge-batches.mjs). No model, no browser, no network: the batches are small files made here.
 * Run: node --test skills/references/merge-batches.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePlan, mergeBatches, mergedInto, addPlan, addToMerged, planView, MERGED, MERGED_NO_RUN, ADSET_ADS } from "./merge-batches.mjs";
import { keptAds } from "./meta-publish.mjs";
import { batchRows } from "./meta-results.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const NOW = new Date("2026-11-22T10:00:00Z");
/** A gym with an image batch (three ads on two photos, Stories for two, one excluded, one kept) and a batch of two added videos for another area. */
function gym({ offerB = "6 Week Reset", areaA = "BOAT QUAY & CBD" } = {}) {
  const d = mkdtempSync(join(tmpdir(), "merge-")), g = join(d, "brands", "testgym");
  mkdirSync(g, { recursive: true }); writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym" }));
  const put = (rel, bytes = PNG) => { const f = join(g, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, bytes); };
  const json = (rel, o) => put(rel, JSON.stringify(o, null, 2));
  const img = (n, c, photo) => { const folder = `${n}-${c}-area-t1-navy`, file = `${folder}/4x5/${c}-area_4x5_v1.png`; put(`outputs/a/${file}`);
    return { folder, file, candidate: c, location: areaA, location_index: 0, photos: [photo], photo_files: [`${photo}.jpg`], treatment: "t1-bottom-stack", style: "s1", palette: "navy", ratio: "4x5", format: "workout", crop: [[0.5, 0.5]], words: { location: areaA, audience: null, offer: "6 Week Reset", free: false }, replaced: null, text_cover: 0.04 }; };
  const A = [img(101, "c01", "g01"), img(102, "c02", "g01"), img(103, "c03", "g02")];
  for (const a of A.slice(0, 2)) put(`outputs/a/${a.folder}/9x16/${a.candidate}-area_9x16_v1.png`);
  json("batches/a/brief.json", { batch_id: "a", offer: "6 Week Reset", locations: [areaA], audience: null, generated: 2 });
  json("outputs/a/batch.json", { batch_id: "a", made: "2026-11-22T01:00:00Z", ratio: "4x5", look: "reference", photos: [{ id: "g01", kind: "generated" }, { id: "g02", kind: "generated" }], ads: A, failed: [] });
  json("outputs/a/visuals.json", { visuals: [{ id: "g01", scene_id: "w-squat", tags: { exercise: "squat", setting: "solo" }, room: "gym-floor" }, { id: "g02", scene_id: "w-lunge", tags: { exercise: "lunge", setting: "group" } }] });
  json("outputs/a/stories.json", { batch_id: "a", ads: A.slice(0, 2).map((a) => ({ folder: a.folder, file: `${a.folder}/9x16/${a.candidate}-area_9x16_v1.png` })), failed: [], left_out: [] });
  json("outputs/a/review.json", { ads: { [A[0].folder]: "keep", [A[2].folder]: "exclude" }, photos: {} });
  json("outputs/a/copy.json", { drafts: [{ id: "d1", kind: "copy", status: "kept", message: "Hello" }] });
  json("outputs/a/publish-settings.json", { adsets: { [areaA]: { daily: 60 } } });
  const vid = (n, c) => { const folder = `${n}-${c}-boat-quay-real-video`, base = `${folder}/9x16/${c}-boat-quay_9x16_v1`; put(`outputs/b/${base}.mp4`, Buffer.from("mp4")); put(`outputs/b/${base}.jpg`);
    return { folder, file: `${base}.jpg`, video_file: `${base}.mp4`, candidate: c, location: "BOAT QUAY", location_index: 0, photos: [], photo_files: [], treatment: "video-real", style: "video", palette: null, ratio: "9x16", format: "presenter-video", video: { kind: "real", title: "One", seconds: 30, words: [], notes: [] }, crop: [], words: { location: "BOAT QUAY", audience: null, offer: offerB, free: false }, replaced: null }; };
  json("batches/b/brief.json", { batch_id: "b", offer: offerB, locations: ["BOAT QUAY"], audience: null, generated: 0, real: [], imported: "real-footage" });
  json("outputs/b/batch.json", { batch_id: "b", made: "2026-11-19T01:00:00Z", imported: "real-footage", ratio: "4x5", photos: [], videos: { real: 2 }, ads: [vid(101, "v01"), vid(102, "v02")], failed: [] });
  return { d, g, A, put, json };
}

test("MB1 what merging comes to, with nothing written: the ads that are not excluded from each batch, in the batches' order; the images' words are the batch's (they are printed), and a video made for another area goes to the images' area so that they are one ad set — said; the name of the new batch; nothing on disk changes", () => {
  const { d, g } = gym();
  try {
    const before = readdirSync(join(g, "outputs")).join(",");
    const p = planView(mergePlan({ brandDir: g, sources: ["a", "b"], now: NOW }));
    assert.deepEqual([p.ready, p.problems, p.batch_id, p.offer, p.audience, p.locations, p.by_location, p.ads, p.images, p.videos, p.cards], [true, [], "2026-11-22-6-week-reset-merged", "6 Week Reset", null, ["BOAT QUAY & CBD"], { "BOAT QUAY & CBD": 4 }, 4, 2, 2, 0]);
    assert.deepEqual(p.sources, [{ id: "a", ads: 2, kept: 1, left: { excluded: 1, flagged: 0, missing: 0 }, of: 3 }, { id: "b", ads: 2, kept: 0, left: { excluded: 0, flagged: 0, missing: 0 }, of: 2 }]);
    assert.deepEqual(p.notes, ["2 videos made for BOAT QUAY go to the area BOAT QUAY & CBD with the images, so they are one ad set. Nothing is printed on a video: its area is only the ad set's name"]);
    assert.ok(!("_all" in p) && readdirSync(join(g, "outputs")).join(",") === before && !existsSync(join(g, "batches", p.batch_id)), "a plan writes nothing");
    // The order asked for is the order of the ads; a name of one's own is taken, a taken one refused.
    assert.equal(planView(mergePlan({ brandDir: g, sources: ["b", "a"], batchId: "boat-quay-all", now: NOW })).batch_id, "boat-quay-all");
    assert.deepEqual(mergePlan({ brandDir: g, sources: ["a", "b"], batchId: "a", now: NOW }).problems, ["a batch called a is already there: nothing is written over it"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("MB2 the merge: one new batch with the ads as they are — each ad's folder copied whole and renumbered, its Stories version and its video with it, the owner's Keep carried, the copy and the publish settings brought along; the batches it came from are byte for byte what they were, only marked; the merged batch reads as kept ads with their Stories and videos, its results keep each photo's scene, and it is never run", async () => {
  const { d, g, A } = gym();
  try {
    const srcBefore = ["a", "b"].map((x) => readFileSync(join(g, "outputs", x, "batch.json"), "utf-8"));
    const log = [], r = mergeBatches({ brandDir: g, sources: ["a", "b"], now: NOW, log: (m) => log.push(m) });
    const id = "2026-11-22-6-week-reset-merged", out = join(g, "outputs", id);
    assert.deepEqual([r.batch_id, r.ads, r.dir], [id, 4, out]);
    const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")), brief = JSON.parse(readFileSync(join(g, "batches", id, "brief.json"), "utf-8"));
    assert.deepEqual([brief.imported, brief.merged_from, brief.offer, brief.locations, brief.generated, batch.imported, batch.merged_from, batch.ratio, batch.look, batch.videos, batch.video_seconds], [MERGED, ["a", "b"], "6 Week Reset", ["BOAT QUAY & CBD"], 0, MERGED, [{ batch: "a", ads: 2 }, { batch: "b", ads: 2 }], "4x5", "reference", { real: 2 }, 60]);
    assert.deepEqual(batch.ads.map((a) => [a.folder, a.location, a.words.location, a.photos, a.merged.batch, a.merged.folder, !!a.story_file]), [
      ["101-c01-area-t1-navy", "BOAT QUAY & CBD", "BOAT QUAY & CBD", [], "a", A[0].folder, true],
      ["102-c02-area-t1-navy", "BOAT QUAY & CBD", "BOAT QUAY & CBD", [], "a", A[1].folder, true],
      ["103-v01-boat-quay-real-video", "BOAT QUAY & CBD", "BOAT QUAY & CBD", [], "b", "101-v01-boat-quay-real-video", false],
      ["104-v02-boat-quay-real-video", "BOAT QUAY & CBD", "BOAT QUAY & CBD", [], "b", "102-v02-boat-quay-real-video", false]]);
    for (const a of batch.ads) { assert.ok(existsSync(join(out, a.file)), a.file); if (a.video_file) assert.ok(existsSync(join(out, a.video_file))); if (a.story_file) assert.ok(existsSync(join(out, a.story_file))); assert.ok(a.file.startsWith(a.folder + "/")); }
    assert.deepEqual(batch.ads[0].merged.visuals, [{ id: "g01", scene_id: "w-squat", tags: { exercise: "squat", setting: "solo" }, room: "gym-floor" }]);
    assert.deepEqual([batch.ads[0].text_cover, batch.ads[0].treatment, batch.ads[2].video.kind, batch.ads[2].words.offer], [0.04, "t1-bottom-stack", "real", "6 Week Reset"]);
    // The owner's Keep comes along; an ad he had not looked at is still not looked at.
    assert.deepEqual(JSON.parse(readFileSync(join(out, "review.json"), "utf-8")).ads, { "101-c01-area-t1-navy": "keep" });
    assert.equal(JSON.parse(readFileSync(join(out, "copy.json"), "utf-8")).drafts[0].message, "Hello");
    assert.deepEqual(JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")).adsets, { "BOAT QUAY & CBD": { daily: 60 } });
    assert.equal(JSON.parse(readFileSync(join(out, "progress.json"), "utf-8")).stage, "done");
    // The sources: their ads as they were, their briefs only marked.
    assert.deepEqual(["a", "b"].map((x) => readFileSync(join(g, "outputs", x, "batch.json"), "utf-8")), srcBefore);
    assert.ok(existsSync(join(g, "outputs", "a", A[2].folder)) && existsSync(join(g, "outputs", "a", A[0].folder)), "nothing is moved out of a source");
    const ba = JSON.parse(readFileSync(join(g, "batches", "a", "brief.json"), "utf-8"));
    assert.deepEqual([ba.merged_into, mergedInto(g, ba), mergedInto(g, { merged_into: "gone-batch" }), mergedInto(g, {})], [id, id, null, null]);
    // What Publish Ads reads: every ad, with its Stories version or its video.
    const kept = keptAds(out);
    assert.deepEqual(kept.map((k) => [k.folder, k.location, !!k.story, !!k.video]), [["101-c01-area-t1-navy", "BOAT QUAY & CBD", true, false], ["102-c02-area-t1-navy", "BOAT QUAY & CBD", true, false], ["103-v01-boat-quay-real-video", "BOAT QUAY & CBD", false, true], ["104-v02-boat-quay-real-video", "BOAT QUAY & CBD", false, true]]);
    // Results keep what each photo was: the scene and its tags, by the ad's own record.
    writeFileSync(join(out, "publish.json"), JSON.stringify({ campaign: { id: "c1", name: "x" }, adsets: { "BOAT QUAY & CBD": { id: "s1" } }, ads: { "101-c01-area-t1-navy": { id: "ad1", adset: "BOAT QUAY & CBD" } } }));
    const rows = batchRows(g, id);
    assert.deepEqual([rows.length, rows[0].scenes, rows[0].exercise, rows[0].setting, rows[0].room, rows[0].photos, rows[0].merged_from, rows[0].format], [1, "w-squat", "squat", "solo", "gym-floor", "g01", "a", "workout"]);
    // Never run.
    const { runBatch } = await import("./plan-offer-batch.mjs");
    await assert.rejects(runBatch({ brandDir: g, brief, deps: {}, log: () => {} }), (e) => e.message === MERGED_NO_RUN);
    assert.ok(log.some((l) => /copy\.json ← a/.test(l)) && log.some((l) => /103-v01-boat-quay-real-video ← b\/101-v01-boat-quay-real-video/.test(l)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("MB3 what is refused or said: fewer than two batches; a batch with no ads, one on Facebook already, a merged batch itself, one with every ad excluded; images that name two offers (a campaign is one offer); images in two areas make two ad sets, and a video keeps its own area when the images name it; an ad set over Facebook's limit, an image with no Stories version and a flagged video are said", () => {
  const { d, g, A, json } = gym({ offerB: "Another Offer" });
  try {
    const P = (sources, extra = {}) => mergePlan({ brandDir: g, sources, now: NOW, ...extra });
    assert.deepEqual(P(["a"]).problems, ["choose two batches or more to merge"]);
    assert.ok(P(["a", "nope"]).problems.includes("nope has no finished ads to merge"));
    assert.ok(P(["a", "../x"]).problems.includes('"../x" is not a batch'));
    // A video's offer is only a name: it takes the images'. Two image batches with two offers are refused.
    assert.deepEqual([P(["a", "b"]).ready, P(["a", "b"]).offer], [true, "6 Week Reset"]);
    const C = A.slice(0, 1).map((a) => ({ ...a, folder: "101-c09-east-t1-navy", file: "101-c09-east-t1-navy/4x5/c09_4x5_v1.png", candidate: "c09", location: "EAST COAST", words: { ...a.words, location: "EAST COAST", offer: "12 Week Reset" } }));
    json("batches/c/brief.json", { batch_id: "c", offer: "12 Week Reset", locations: ["EAST COAST"] });
    json("outputs/c/batch.json", { batch_id: "c", ratio: "4x5", photos: [], ads: C, failed: [] });
    mkdirSync(join(g, "outputs", "c", "101-c09-east-t1-navy", "4x5"), { recursive: true }); writeFileSync(join(g, "outputs", "c", C[0].file), PNG);
    assert.ok(P(["a", "c"]).problems.some((e) => /the images name 2 different offers \("6 Week Reset", "12 Week Reset"\): a campaign is one offer/.test(e)));
    // Same offer, two areas: two ad sets, said; a video for one of those areas stays there.
    C[0].words.offer = "6 Week Reset"; json("outputs/c/batch.json", { batch_id: "c", ratio: "4x5", photos: [], ads: C, failed: [] });
    const two = P(["a", "c", "b"]);
    assert.deepEqual([two.ready, two.by_location], [true, { "BOAT QUAY & CBD": 4, "EAST COAST": 1 }]);
    assert.ok(two.notes.some((n) => /the ads name 2 areas \(BOAT QUAY & CBD, EAST COAST\): that is 2 ad sets, one for each/.test(n)));
    assert.ok(two.notes.some((n) => /1 image has no Stories version/.test(n)));
    // On Facebook already; a merged batch; every ad excluded; a flagged video.
    writeFileSync(join(g, "outputs", "c", "publish.json"), JSON.stringify({ campaign: { id: "1" }, ads: { x: { id: "2" } } }));
    assert.ok(P(["a", "c"]).problems.includes("c is on Facebook already (1 ad): merging it would make those ads a second time"));
    rmSync(join(g, "outputs", "c", "publish.json"));
    json("outputs/a/review.json", { ads: Object.fromEntries(A.map((a) => [a.folder, "exclude"])), photos: {} });
    assert.ok(P(["a", "b"]).problems.includes("a has no ad left to merge: every one is excluded"));
    json("outputs/a/review.json", { ads: {}, photos: { g01: "exclude" } });
    assert.deepEqual(P(["a", "b"]).sources[0], { id: "a", ads: 1, kept: 0, left: { excluded: 2, flagged: 0, missing: 0 }, of: 3 }, "an excluded photo takes its ads with it");
    const b = JSON.parse(readFileSync(join(g, "outputs", "b", "batch.json"), "utf-8")); b.ads[0].video.flags = [{ line: 2, why: "x" }]; json("outputs/b/batch.json", b);
    const fl = P(["a", "b"]);
    assert.deepEqual([fl.videos, fl.notes.some((n) => /b: 1 video with a line waiting for your decision is left out/.test(n))], [1, true]);
    const made = mergeBatches({ brandDir: g, sources: ["a", "b"], now: NOW });
    assert.ok(P([made.batch_id, "c"]).problems.includes(`${made.batch_id} is itself a merged batch: merge the batches it came from`));
    assert.ok(P(["a", "c"]).notes.some((n) => n === `a is already in the merged batch ${made.batch_id}: its ads will be in both`));
    assert.equal(ADSET_ADS, 50);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/** A third image batch for the same gym: two ads on one photo, one kept, Stories for both. */
function third({ put, json }, id = "c", { offer = "6 Week Reset", area = "BOAT QUAY & CBD", n = 2 } = {}) {
  const ads = Array.from({ length: n }, (_, i) => { const c = `c0${i + 1}`, folder = `${101 + i}-${c}-area-t3-white`, file = `${folder}/4x5/${c}-area_4x5_v1.png`; put(`outputs/${id}/${file}`, Buffer.from(`png-${id}-${i}`)); put(`outputs/${id}/${folder}/9x16/${c}-area_9x16_v1.png`);
    return { folder, file, candidate: c, location: area, location_index: 0, photos: ["g01"], photo_files: ["g01.jpg"], treatment: "t3-left-column", style: "s2", palette: "white", ratio: "4x5", format: "studio-portrait", crop: [[0.5, 0.5]], words: { location: area, audience: null, offer, free: false }, replaced: null }; });
  json(`batches/${id}/brief.json`, { batch_id: id, offer, locations: [area], audience: null, generated: 1 });
  json(`outputs/${id}/batch.json`, { batch_id: id, made: "2026-11-27T01:00:00Z", ratio: "4x5", photos: [{ id: "g01", kind: "generated" }], ads, failed: [] });
  json(`outputs/${id}/visuals.json`, { visuals: [{ id: "g01", scene_id: "w-p-dark-wall", tags: { backdrop: "dark-wall" } }] });
  json(`outputs/${id}/stories.json`, { batch_id: id, ads: ads.map((a) => ({ folder: a.folder, file: `${a.folder}/9x16/${a.candidate}-area_9x16_v1.png` })), failed: [], left_out: [] });
  json(`outputs/${id}/review.json`, { ads: { [ads[0].folder]: "keep" }, photos: {} });
  return ads;
}

test("MB4 more ads for a merged batch (2026-11-28): the ads of another finished batch join it, numbered on from its last ad, with the Keep carried — and nothing that was there moves (its ads, the picks, the copy, the settings); what it comes to is said first with nothing written; an ad that is already here is not added twice, so adding a batch again brings only what is new in it; another offer, a batch on Facebook, a merged batch and a batch that is not merged are refused; an image naming another area is a new ad set, said; a full ad set is said with how to make room", () => {
  const G = gym(), { d, g } = G;
  try {
    const NOW2 = new Date("2026-11-28T03:00:00Z"), id = mergeBatches({ brandDir: g, sources: ["a", "b"], now: NOW }).batch_id, out = join(g, "outputs", id), read = (f) => JSON.parse(readFileSync(join(out, f), "utf-8"));
    const C = third(G), was = { batch: read("batch.json"), copy: readFileSync(join(out, "copy.json"), "utf-8"), settings: readFileSync(join(out, "publish-settings.json"), "utf-8"), review: read("review.json") };
    // What it comes to, nothing written.
    const p = planView(addPlan({ brandDir: g, batchId: id, sources: ["c"] }));
    assert.deepEqual([p.ready, p.problems, p.notes, p.batch_id, p.on_meta, p.was, p.adds, p.images, p.videos, p.locations, p.new_locations, p.by_location], [true, [], [], id, false, 4, 2, 2, 0, ["BOAT QUAY & CBD"], [], { "BOAT QUAY & CBD": { have: 4, adds: 2, after: 6 } }]);
    assert.deepEqual(p.sources, [{ id: "c", ads: 2, kept: 1, left: { excluded: 0, flagged: 0, missing: 0 }, of: 2, already: 0 }]);
    assert.equal(readFileSync(join(out, "batch.json"), "utf-8"), JSON.stringify(was.batch, null, 2) + "\n", "a plan writes nothing");
    // The add.
    const log = [], r = addToMerged({ brandDir: g, batchId: id, sources: ["c"], now: NOW2, log: (m) => log.push(m) }), b = read("batch.json");
    assert.deepEqual([r.adds, r.ads, r.added], [2, 6, ["105-c01-area-t3-white", "106-c02-area-t3-white"]]);
    assert.deepEqual(b.ads.slice(0, 4), was.batch.ads, "the ads that were there are as they were");
    assert.deepEqual(b.ads.slice(4).map((a) => [a.folder, a.file, a.story_file, a.location, a.photos, a.merged.batch, a.merged.folder, a.merged.added, a.merged.visuals[0].scene_id]), [
      ["105-c01-area-t3-white", "105-c01-area-t3-white/4x5/c01-area_4x5_v1.png", "105-c01-area-t3-white/9x16/c01-area_9x16_v1.png", "BOAT QUAY & CBD", [], "c", C[0].folder, "2026-11-28", "w-p-dark-wall"],
      ["106-c02-area-t3-white", "106-c02-area-t3-white/4x5/c02-area_4x5_v1.png", "106-c02-area-t3-white/9x16/c02-area_9x16_v1.png", "BOAT QUAY & CBD", [], "c", C[1].folder, "2026-11-28", "w-p-dark-wall"]]);
    assert.equal(readFileSync(join(out, b.ads[4].file), "utf-8"), "png-c-0", "the file came as it is");
    assert.deepEqual([b.merged_from, b.added.map((x) => [x.sources, x.ads.length]), read("review.json").ads], [[{ batch: "a", ads: 2 }, { batch: "b", ads: 2 }, { batch: "c", ads: 2 }], [[[{ batch: "c", ads: 2 }], 2]], { ...was.review.ads, "105-c01-area-t3-white": "keep" }]);
    assert.deepEqual([readFileSync(join(out, "copy.json"), "utf-8"), readFileSync(join(out, "publish-settings.json"), "utf-8")], [was.copy, was.settings], "the copy and the settings are the owner's and stay");
    assert.deepEqual([JSON.parse(readFileSync(join(g, "batches", id, "brief.json"), "utf-8")).merged_from, JSON.parse(readFileSync(join(g, "batches", "c", "brief.json"), "utf-8")).merged_into, mergedInto(g, JSON.parse(readFileSync(join(g, "batches", "c", "brief.json"), "utf-8")))], [["a", "b", "c"], id, id]);
    assert.deepEqual(keptAds(out).map((a) => [a.folder, !!a.story]).slice(-2), [["105-c01-area-t3-white", true], ["106-c02-area-t3-white", true]], "the new ads are kept ads of the plan, with their Stories versions");
    // The same batch again brings nothing; with a new ad in it, only that one.
    assert.deepEqual(addPlan({ brandDir: g, batchId: id, sources: ["c"] }).problems, ["every ad of c that is not excluded is already in this batch"]);
    assert.throws(() => addToMerged({ brandDir: g, batchId: id, sources: ["c"] }), /these ads cannot be added:\n- every ad of c/);
    const cb = JSON.parse(readFileSync(join(g, "outputs", "c", "batch.json"), "utf-8")), extra = { ...cb.ads[0], folder: "103-c03-area-t3-white", file: "103-c03-area-t3-white/4x5/c03-area_4x5_v1.png", candidate: "c03" };
    G.put(`outputs/c/${extra.file}`); cb.ads.push(extra); G.json("outputs/c/batch.json", cb);
    const p2 = planView(addPlan({ brandDir: g, batchId: id, sources: ["c"] }));
    assert.deepEqual([p2.ready, p2.adds, p2.sources[0].already, p2.notes], [true, 1, 2, ["c: 2 of its ads are in this batch already and are not added again", "1 image has no Stories version: make them in the batch they came from first (Pick Ads → Make Stories versions), or they run on the feed image alone"]]);
    assert.deepEqual(addToMerged({ brandDir: g, batchId: id, sources: ["c"], now: NOW2 }).added, ["107-c03-area-t3-white"]);
    // Refused.
    assert.throws(() => addPlan({ brandDir: g, batchId: "a", sources: ["c"] }), /ads are added to a merged batch only/);
    third(G, "other-offer", { offer: "12 Week Sculpt" }); third(G, "on-fb"); G.json("outputs/on-fb/publish.json", { ads: { x: { id: "1" } } });
    const bad = addPlan({ brandDir: g, batchId: id, sources: ["other-offer", "on-fb", id, "nope"] });
    assert.equal(bad.ready, false);
    assert.match(bad.problems.join(" | "), /on-fb is on Facebook already \(1 ad\): adding it would make those ads a second time \| nope has no finished ads to add \| the images to add name another offer \("12 Week Sculpt"\) and this batch's is "6 Week Reset"/);
    assert.deepEqual(addPlan({ brandDir: g, batchId: id, sources: [] }).problems, ["choose a batch whose ads to add"]);
    // An image naming another area is a new ad set; a video goes to this batch's area.
    third(G, "elsewhere", { area: "TANJONG PAGAR" });
    const p3 = planView(addPlan({ brandDir: g, batchId: id, sources: ["elsewhere"] }));
    assert.deepEqual([p3.ready, p3.locations, p3.new_locations, p3.by_location["TANJONG PAGAR"]], [true, ["BOAT QUAY & CBD", "TANJONG PAGAR"], ["TANJONG PAGAR"], { have: 0, adds: 2, after: 2 }]);
    assert.match(p3.notes[0], /^2 images name the area TANJONG PAGAR, which this batch does not have: that is a new ad set\. For the ad set this batch has, re-render that batch with its area first/);
    // A full ad set, on Facebook: said with how many fit and how to make room.
    const full = read("batch.json"); while (full.ads.length < 49) full.ads.push({ ...full.ads[0], folder: `${200 + full.ads.length}-pad` }); G.json(`outputs/${id}/batch.json`, full); G.json(`outputs/${id}/publish.json`, { campaign: { id: "9" }, ads: {} });
    third(G, "fresh", { n: 2 });
    const p4 = planView(addPlan({ brandDir: g, batchId: id, sources: ["fresh"] }));
    assert.deepEqual([p4.ready, p4.on_meta, p4.by_location["BOAT QUAY & CBD"]], [true, true, { have: 49, adds: 2, after: 51 }]);
    assert.equal(p4.notes[0], `BOAT QUAY & CBD holds 49 ads and this adds 2: Facebook allows ${ADSET_ADS} in an ad set, paused ones included, so only 1 of them fits as it is. To make room, exclude 1 of the old ads on Pick Ads and pause them on Facebook: the create then offers to archive them`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
