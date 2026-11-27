// Videos cut from a gym's own footage, added as a batch of ads (footage-video.mjs). No model, no Meta: ffmpeg makes the test videos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
const readdirNames = (d) => (existsSync(d) ? readdirSync(d) : []);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addFootageBatch, footageProblems, probeVideo, FOOTAGE, FOOTAGE_KIND, FOOTAGE_NO_RUN, holdVideo, heldVideos, dropHeld, addHeld, videoContainer, fileProblems, HELD_DIR } from "./footage-video.mjs";
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

test("FV5 finished videos dropped on the page (2026-11-24): a file is told by its first bytes and kept once by its content; a MOV is re-wrapped as an MP4 with nothing re-encoded; each waiting video says what stops it from being an ad of either kind; the ticked ones become one batch named for the day and the offer, with their titles; a testimonial needs the owner's word on consent; a refusal writes nothing and keeps the videos waiting; one taken off the list goes to _trash", () => {
  const { root, dir } = gym();
  try {
    const mp4 = join(root, "Coach intro.mp4"), mov = join(root, "IMG_2231.MOV"), wide = join(root, "wide.mp4"), mute = join(root, "mute.mp4"), small = join(root, "member.mp4");
    clip(mp4); clip(wide, { w: 1920, h: 1080 }); clip(mute, { sound: false }); clip(small, { w: 720, h: 1280, seconds: 6 });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-c", "copy", "-f", "mov", mov]);
    assert.deepEqual([videoContainer(readFileSync(mp4)), videoContainer(readFileSync(mov)), videoContainer(Buffer.from("not a video at all, just words")), videoContainer(Buffer.alloc(4))], ["mp4", "mov", null, null]);
    assert.deepEqual(heldVideos(dir), []);
    const now = new Date("2026-11-24T03:00:00Z");
    const a = holdVideo(dir, "Coach intro.mp4", readFileSync(mp4), { now });
    assert.deepEqual([a.already, a.video.name, a.video.w, a.video.h, a.video.sound, a.video.rewrapped, a.video.problems], [false, "Coach intro.mp4", 1080, 1920, true, false, { real: [], testimonial: [] }]);
    assert.match(a.video.id, /^u-[0-9a-f]{10}$/); assert.ok(existsSync(join(dir, HELD_DIR, a.video.poster)), "a poster frame for the list");
    assert.equal(statSync(a.video.file).size, statSync(mp4).size, "the file as it came");
    assert.equal(holdVideo(dir, "the same file under another name.mp4", readFileSync(mp4)).already, true, "the same content is not kept twice");
    // A MOV: the same picture and sound in an MP4 container.
    const m = holdVideo(dir, "IMG_2231.MOV", readFileSync(mov), { now });
    assert.deepEqual([m.video.rewrapped, m.video.w, m.video.h, m.video.sound, videoContainer(readFileSync(m.video.file)), m.video.problems.real], [true, 1080, 1920, true, "mp4", []]);
    // Held, with what stops each from being an ad.
    const w = holdVideo(dir, "wide.mp4", readFileSync(wide), { now }), q = holdVideo(dir, "mute.mp4", readFileSync(mute), { now }), t = holdVideo(dir, "member.mp4", readFileSync(small), { now });
    assert.match(w.video.problems.real.join("; "), /it is 1920×1080; a video ad here is 9:16/);
    assert.deepEqual(q.video.problems.real, ["the file has no sound track"]);
    assert.deepEqual([t.video.problems.testimonial, /smaller than 1080×1920/.test(t.video.problems.real.join("; "))], [[], true], "a testimonial is taken at 720 wide, the gym's own video is not");
    assert.deepEqual(fileProblems({ video: false }), ["the file has no picture"]);
    assert.throws(() => holdVideo(dir, "notes.mp4", Buffer.from("these are words, not a video file at all")), /an MP4 or a MOV file: this file is neither/);
    assert.equal(heldVideos(dir).length, 5);
    // Taken off the list: to _trash, never deleted.
    assert.equal(dropHeld(dir, q.video.id).length, 4); assert.ok(readdirNames(join(dir, HELD_DIR, "_trash")).some((n) => n.startsWith(q.video.id) && n.endsWith(".mp4")));
    assert.throws(() => dropHeld(dir, q.video.id), /not waiting here/);
    // Refusals write nothing and keep the videos waiting.
    assert.throws(() => addHeld({ brandDir: dir, ids: [], offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"] }), /tick at least one/);
    assert.throws(() => addHeld({ brandDir: dir, ids: [a.video.id, "u-0000000000"], offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"] }), /not waiting here any more/);
    assert.throws(() => addHeld({ brandDir: dir, ids: [a.video.id, w.video.id], offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], now }), /video 2: it is 1920×1080/);
    assert.throws(() => addHeld({ brandDir: dir, ids: [a.video.id], offer: "6 Week Total Body Reset", locations: ["SINGAPORE"], now }), /whole country/);
    assert.throws(() => addHeld({ brandDir: dir, ids: [t.video.id], kind: "testimonial", offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], now }), /say who confirmed that each person agreed/);
    assert.ok(!existsSync(join(dir, "outputs")) && heldVideos(dir).length === 4, "nothing written, nothing lost");
    // The ticked ones, in order, as one batch.
    const r = addHeld({ brandDir: dir, ids: [m.video.id, a.video.id], offer: "6 Week Total Body Reset", locations: ["BOAT QUAY", "CBD"], audience: "LADIES", titles: { [a.video.id]: "  The coach's intro " }, now });
    assert.deepEqual([r.batch_id, r.videos, r.ads], ["2026-11-24-videos-6-week-total-body-reset", 2, 4]);
    const batch = JSON.parse(readFileSync(join(r.dir, "batch.json"), "utf-8"));
    assert.deepEqual(batch.ads.map((x) => [x.folder, x.video.kind, x.video.title, x.video.source, x.words.audience]), [
      ["101-v01-boat-quay-real-video", "real", "IMG 2231", "upload:IMG_2231.MOV", "LADIES"], ["102-v01-cbd-real-video", "real", "IMG 2231", "upload:IMG_2231.MOV", "LADIES"],
      ["103-v02-boat-quay-real-video", "real", "The coach's intro", "upload:Coach intro.mp4", "LADIES"], ["104-v02-cbd-real-video", "real", "The coach's intro", "upload:Coach intro.mp4", "LADIES"]]);
    assert.equal(statSync(join(r.dir, batch.ads[2].video_file)).size, statSync(mp4).size, "the file as it was dropped");
    assert.deepEqual(heldVideos(dir).map((v) => v.name).sort(), ["member.mp4", "wide.mp4"], "the ones added no longer wait; their holding copies are gone");
    assert.ok(!existsSync(a.video.file) && !existsSync(m.video.file));
    // The same offer again the same day: a batch of its own, never written over. A video added before says so when it is dropped again.
    const again = holdVideo(dir, "Coach intro.mp4", readFileSync(mp4), { now });
    assert.deepEqual([again.already, again.video.was_in], [false, ["2026-11-24-videos-6-week-total-body-reset"]]);
    assert.equal(addHeld({ brandDir: dir, ids: [again.video.id], offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], now }).batch_id, "2026-11-24-videos-6-week-total-body-reset-2");
    // Testimonials: the owner's word on consent is kept on each video.
    const tt = addHeld({ brandDir: dir, ids: [t.video.id], kind: "testimonial", offer: "6 Week Total Body Reset", locations: ["BOAT QUAY"], consent: { by: "The owner, in writing" }, now });
    const tb = JSON.parse(readFileSync(join(tt.dir, "batch.json"), "utf-8"));
    assert.deepEqual([tt.batch_id, tb.ads[0].video.kind, tb.ads[0].video.consent, tb.ads[0].video.small, tb.ads[0].folder], ["2026-11-24-testimonials-6-week-total-body-reset", "testimonial", { by: "The owner, in writing", on: "2026-11-24" }, true, "101-v01-boat-quay-testimonial-video"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
