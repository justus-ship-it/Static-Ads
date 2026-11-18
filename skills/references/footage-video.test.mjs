// Videos cut from a gym's own footage, added as a batch of ads (footage-video.mjs). No model, no Meta: ffmpeg makes the test videos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addFootageBatch, footageProblems, probeVideo, FOOTAGE, FOOTAGE_KIND, FOOTAGE_NO_RUN } from "./footage-video.mjs";
import { runBatch } from "./plan-offer-batch.mjs";
import { keptAds } from "./meta-publish.mjs";
import { videoResults, INVENTED, REAL_FOOTAGE } from "./what-wins.mjs";

const clip = (file, { w = 1080, h = 1920, seconds = 4, sound = true } = {}) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=10:duration=${seconds}`,
  ...(sound ? ["-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`] : []), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(sound ? ["-c:a", "aac", "-shortest"] : []), file]);
const gym = () => { const root = mkdtempSync(join(tmpdir(), "footage-")), dir = join(root, "brands", "test-gym"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ schema: 3, gym: "test-gym", display_name: "Test Gym" })); return { root, dir }; };

test("FV1 finished videos become a batch of video ads, as they are", () => {
  const { root, dir } = gym();
  try {
    const a = join(root, "one.mp4"), b = join(root, "two.mp4"); clip(a); clip(b, { seconds: 5 });
    const f = probeVideo(a); assert.equal(f.w, 1080); assert.equal(f.h, 1920); assert.ok(f.sound && f.video);
    const r = addFootageBatch({ brandDir: dir, batchId: "2026-11-19-real-footage", offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], videos: [{ file: a, title: "The pitch", words: ["Line one.", "Line two."] }, { file: b, poster_at: 2 }], now: new Date("2026-11-19T01:00:00Z") });
    assert.equal(r.ads, 2);
    const brief = JSON.parse(readFileSync(join(dir, "batches", r.batch_id, "brief.json"), "utf-8")), batch = JSON.parse(readFileSync(join(r.dir, "batch.json"), "utf-8"));
    assert.equal(brief.imported, FOOTAGE); assert.equal(brief.offer, "6 Week Total Body Reset"); assert.deepEqual(brief.locations, ["BOAT QUAY"]); assert.equal(brief.generated, 0);
    assert.equal(batch.imported, FOOTAGE); assert.deepEqual(batch.videos, { real: 2 }); assert.equal(batch.image_calls, 0);
    assert.deepEqual(batch.ads.map((x) => x.folder), ["101-v01-boat-quay-real-video", "102-v02-boat-quay-real-video"]);
    for (const ad of batch.ads) {
      assert.equal(ad.video.kind, FOOTAGE_KIND); assert.equal(ad.ratio, "9x16"); assert.equal(ad.treatment, "video-real"); assert.deepEqual(ad.photos, []);
      assert.deepEqual(ad.words, { location: "BOAT QUAY", audience: null, offer: "6 Week Total Body Reset", free: false });
      assert.ok(statSync(join(r.dir, ad.video_file)).size > 1000, "the video is in the ad's folder"); assert.ok(statSync(join(r.dir, ad.file)).size > 500, "with a poster frame");
    }
    assert.equal(statSync(join(r.dir, batch.ads[0].video_file)).size, statSync(a).size, "the file as it was given: nothing re-encoded");
    assert.equal(batch.ads[0].video.title, "The pitch"); assert.deepEqual(batch.ads[0].video.words, ["Line one.", "Line two."]); assert.equal(batch.ads[1].video.seconds, 5);
    assert.equal(JSON.parse(readFileSync(join(r.dir, "progress.json"), "utf-8")).stage, "done");
    // the publish list takes them as videos of their own kind (an ad not looked at counts as kept)
    const kept = keptAds(r.dir);
    assert.equal(kept.length, 2); assert.ok(kept.every((k) => k.video && k.video_kind === "real"));
    // never written over
    assert.throws(() => addFootageBatch({ brandDir: dir, batchId: "2026-11-19-real-footage", offer: "X Y", locations: ["BOAT QUAY"], videos: [{ file: a }] }), /already there/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FV2 what cannot be added is said, and nothing is written", () => {
  const { root, dir } = gym();
  try {
    const good = join(root, "good.mp4"), wide = join(root, "wide.mp4"), mute = join(root, "mute.mp4"); clip(good); clip(wide, { w: 1920, h: 1080 }); clip(mute, { sound: false });
    const refuse = (o, re) => assert.throws(() => addFootageBatch({ brandDir: dir, batchId: "b-1", offer: "6 Week Reset", locations: ["BOAT QUAY"], videos: [{ file: good }], ...o }), re);
    refuse({ locations: ["SINGAPORE"] }, /cannot be added/);                       // a location is never the whole country
    refuse({ locations: [] }, /at least one location/);
    refuse({ videos: [{ file: wide }] }, /1920×1080; a video ad here is 9:16/);
    refuse({ videos: [{ file: mute }] }, /no sound track/);
    refuse({ videos: [{ file: join(root, "nothing.mp4") }] }, /the file is not there/);
    refuse({ videos: [] }, /no video to add/);
    refuse({ batchId: "Bad Id" }, /id of small letters/);
    assert.ok(!existsSync(join(dir, "batches")) && !existsSync(join(dir, "outputs")), "a refusal writes nothing");
    assert.deepEqual(footageProblems({ batchId: "b-1", offer: "6 Week Reset", locations: ["BOAT QUAY"], videos: [{ file: good }], facts: [probeVideo(good)] }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FV3 a batch of added videos is never run, and real footage is nobody's invention in the results", async () => {
  const { root, dir } = gym();
  try {
    const a = join(root, "one.mp4"); clip(a);
    const r = addFootageBatch({ brandDir: dir, batchId: "b-2", offer: "6 Week Reset", locations: ["BOAT QUAY"], videos: [{ file: a }] });
    const brief = JSON.parse(readFileSync(join(dir, "batches", "b-2", "brief.json"), "utf-8")), before = readFileSync(join(r.dir, "batch.json"), "utf-8");
    for (const o of [{}, { renderOnly: true }, { dryRun: true }]) await assert.rejects(() => runBatch({ brandDir: dir, brief, ...o, log: () => {} }), (e) => e.message === FOOTAGE_NO_RUN);
    assert.equal(readFileSync(join(r.dir, "batch.json"), "utf-8"), before, "the batch is as it was");
    const rows = [{ media: "video", video_kind: "real footage", leads: 6, spend: 60 }, { media: "video", video_kind: "talking", leads: 2, spend: 40 }];
    const v = videoResults(rows);
    assert.deepEqual(v.by_coach.map((x) => x.value).sort(), [INVENTED, REAL_FOOTAGE].sort());
    assert.equal(v.by_kind.find((x) => x.value === "real footage").leads, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FV4 the owner's new offer name: the brief and every ad take it, nothing else changes, and only an added batch is touched", async () => {
  const { setFootageWords } = await import("./footage-video.mjs");
  const { root, dir } = gym();
  try {
    const a = join(root, "one.mp4"); clip(a);
    const r = addFootageBatch({ brandDir: dir, batchId: "b-3", offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], videos: [{ file: a, words: ["A line."] }] });
    const size = statSync(join(r.dir, "101-v01-boat-quay-real-video/9x16/v01-boat-quay_9x16_v1.mp4")).size;
    const s = setFootageWords({ brandDir: dir, batchId: "b-3", offer: "6 Week Full Body Transformation" });
    assert.deepEqual(s.was, { offer: "6 Week Total Body Reset", audience: null }); assert.equal(s.now.offer, "6 Week Full Body Transformation"); assert.equal(s.ads, 1);
    const brief = JSON.parse(readFileSync(join(dir, "batches", "b-3", "brief.json"), "utf-8")), batch = JSON.parse(readFileSync(join(r.dir, "batch.json"), "utf-8"));
    assert.equal(brief.offer, "6 Week Full Body Transformation"); assert.equal(brief.imported, FOOTAGE); assert.deepEqual(brief.locations, ["BOAT QUAY"]);
    assert.deepEqual(batch.ads[0].words, { location: "BOAT QUAY", audience: null, offer: "6 Week Full Body Transformation", free: false });
    assert.deepEqual(batch.ads[0].video.words, ["A line."]); assert.equal(statSync(join(r.dir, batch.ads[0].video_file)).size, size);
    assert.equal(keptAds(r.dir)[0].words.offer, "6 Week Full Body Transformation");
    setFootageWords({ brandDir: dir, batchId: "b-3", audience: "LADIES" });
    assert.equal(JSON.parse(readFileSync(join(r.dir, "batch.json"), "utf-8")).ads[0].words.audience, "LADIES");
    assert.throws(() => setFootageWords({ brandDir: dir, batchId: "b-3", offer: "6 Week — Reset" }), /cannot be used/);
    assert.throws(() => setFootageWords({ brandDir: dir, batchId: "nope", offer: "X" }), /no batch called/);
    // a batch the app made is never changed this way
    mkdirSync(join(dir, "batches", "b-4"), { recursive: true }); mkdirSync(join(dir, "outputs", "b-4"), { recursive: true });
    writeFileSync(join(dir, "batches", "b-4", "brief.json"), JSON.stringify({ batch_id: "b-4", offer: "A B", locations: ["BOAT QUAY"] })); writeFileSync(join(dir, "outputs", "b-4", "batch.json"), JSON.stringify({ ads: [] }));
    assert.throws(() => setFootageWords({ brandDir: dir, batchId: "b-4", offer: "C D" }), /only a batch of added videos/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
