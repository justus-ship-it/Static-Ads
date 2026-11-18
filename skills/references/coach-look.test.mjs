/**
 * Tests for the coaches' intake and gate (coach-look.mjs). No model call, no image call: a sample video is made by ffmpeg.
 * Run: node --test skills/references/coach-look.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { readCoaches, addCoach, setConsent, switchCoach, usable, addSample, samples, setSamples, extractFrames, probe, hasFfmpeg, readSamples, groupsOf, buildStarts, startCrop, setVoice, setUniform, switchStart, coachWhy, readyCoaches, pickCoaches, coachForVideo, START, COACHES_FILE, SAMPLES_DIR } from "./coach-look.mjs";

test("CK1 a real coach is generated only with their written consent on file: named by the owner, consent for the face and for the voice apart, taken back by recording it, switched off with a reason and never deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "coach-"));
  try {
    assert.deepEqual(readCoaches(dir), { coaches: [] });
    assert.throws(() => addCoach(dir, { name: "A" }), /a coach needs a name/);
    const c = addCoach(dir, { name: "Coach  Mei", note: "the one in sample 2" });
    assert.deepEqual([c.id, c.name, c.note, c.status, c.consent, c.frames], ["coach-coach-mei", "Coach Mei", "the one in sample 2", "on", null, []]);
    assert.throws(() => addCoach(dir, { name: "coach mei" }), /already on this gym's list/);
    // No consent: refused in words, for the face and so for anything.
    assert.deepEqual(usable(c), { ok: false, why: "Coach Mei's written consent is not on file: a video in a real person's likeness is not made without it" });
    assert.equal(usable(null).ok, false);
    // Consent needs who gave it and how, and says face and voice each.
    assert.throws(() => setConsent(dir, c.id, { face: true, voice: true }), /say who gave the consent and how/);
    assert.throws(() => setConsent(dir, c.id, { face: "yes", by: "signed form" }), /true or false each/);
    assert.throws(() => setConsent(dir, "coach-nobody", { face: true, by: "signed form" }), /no coach coach-nobody/);
    const faceOnly = setConsent(dir, c.id, { face: true, voice: false, by: "signed form, given to the owner" });
    assert.match(faceOnly.consent.on, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual([usable(faceOnly).ok, usable(faceOnly, { voice: true })], [true, { ok: false, why: "Coach Mei has consented to their likeness but not to their voice: the video may look like them, with a voice that is not theirs" }]);
    const both = setConsent(dir, c.id, { face: true, voice: true, by: "signed form, given to the owner" });
    assert.equal(usable(both, { voice: true }).ok, true);
    // Taken back: recorded as false, and the gate closes.
    const back = setConsent(dir, c.id, { face: false, voice: false, by: "message to the owner: please stop" });
    assert.deepEqual(usable(back), { ok: false, why: "Coach Mei has not consented to videos in their likeness" });
    // Switched off with a reason, kept on file; back on restores the gate to the consent.
    setConsent(dir, c.id, { face: true, voice: true, by: "signed form again" });
    assert.throws(() => switchCoach(dir, c.id, { on: false }), /say why this coach is switched off/);
    const off = switchCoach(dir, c.id, { on: false, reason: "left the gym" });
    assert.deepEqual([usable(off).ok, usable(off).why, readCoaches(dir).coaches.length], [false, "Coach Mei is switched off (left the gym)", 1]);
    assert.equal(usable(switchCoach(dir, c.id, { on: true })).ok, true);
    assert.ok(existsSync(join(dir, COACHES_FILE)) && !JSON.stringify(readCoaches(dir)).includes("race"), "nothing about a person is read off a face: only what the owner typed is on file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CK2 the gym's sample videos: taken in as they are and never twice, measured, and still frames pulled evenly through them", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-"));
  try {
    const video = join(dir, "from-the-gym.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=360x640:r=24:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
    assert.deepEqual(probe(video), { seconds: 4, width: 360, height: 640, audio: true });
    const s = addSample(dir, video);
    assert.deepEqual([s.name, s.kind, s.original, s.seconds, s.audio, existsSync(join(dir, SAMPLES_DIR, "video-01.mp4"))], ["video-01.mp4", "video", "from-the-gym.mp4", 4, true, true]);
    assert.deepEqual([addSample(dir, video).already, samples(dir).length], [true, 1], "the same video again is not taken twice");
    assert.equal(readFileSync(join(dir, SAMPLES_DIR, "video-01.mp4")).length, readFileSync(video).length, "kept as it is");
    // Not a video or a still, or not there: said.
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.throws(() => addSample(dir, join(dir, "notes.txt")), /a sample is a video .* or a still/);
    assert.throws(() => addSample(dir, join(dir, "missing.mp4")), /no such file/);
    // Frames: one a second through a 4 s video, named for their second; pulling again makes nothing new.
    const frames = extractFrames(dir, "video-01.mp4", { every: 1 });
    assert.deepEqual(frames.map((f) => f.at), [0.2, 1.2, 2.2, 3.2]);
    assert.ok(frames.every((f) => existsSync(f.file) && readFileSync(f.file).length > 500));
    const again = extractFrames(dir, "video-01.mp4", { every: 1 });
    assert.deepEqual(again.map((f) => f.file), frames.map((f) => f.file));
    assert.equal(extractFrames(dir, "video-01.mp4", { every: 0.1, max: 5 }).length, 5, "never more than the cap");
    assert.throws(() => extractFrames(dir, "video-09.mp4"), /no sample video-09\.mp4/);
    // Who a sample shows is the owner's word: a sample shows one coach, and naming it for another moves it.
    const a = addCoach(dir, { name: "Xena" }), b = addCoach(dir, { name: "Faye", note: "first guess" });
    assert.throws(() => setSamples(dir, a.id, ["video-07.mp4"]), /no sample video-07\.mp4/);
    assert.throws(() => setSamples(dir, "coach-nobody", ["video-01.mp4"]), /no coach coach-nobody/);
    assert.deepEqual(setSamples(dir, b.id, ["video-01.mp4"]).samples, ["video-01.mp4"]);
    const moved = setSamples(dir, a.id, ["video-01.mp4", " video-01.mp4 "], { note: "black shirt" });
    assert.deepEqual([moved.samples, moved.note, readCoaches(dir).coaches.find((c) => c.id === b.id).samples], [["video-01.mp4"], "black shirt", []]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CK3 the samples read once, grouped by what the person wears, and each coach's starting pictures cut from real frames with the shirt's print clear of the captions", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "look-"));
  try {
    const mk = (name, colour) => { const f = join(dir, name); execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=1080x1920:r=12:d=5`, "-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]); return f; };
    addSample(dir, mk("a.mp4", "gray")); addSample(dir, mk("b.mp4", "navy")); addSample(dir, mk("c.mp4", "white"));
    // The models are told nothing about who anyone is, and say nothing about it.
    const calls = [], wearing = { "video-01": ["black T-shirt", false, "on the turf lane"], "video-02": ["black T-shirt", false, "by the dumbbell rack"], "video-03": ["white T-shirt", true, "in the treatment room"] };
    const models = {
      async hear(file) { calls.push("hear " + basename(file)); return { transcript: basename(file) === "video-02.mp4" ? "one two three four five six seven eight nine ten" : "one two three", speakers: 1, pitch: "medium-low", pace: "measured", accent: "Singaporean English, moderate", energy: "warm and clear.", voice: "A clear voice with light chest resonance." }; },
      async look(frames) { const key = basename(dirname(frames[0])), [top, glasses, spot] = wearing[key]; calls.push(`look ${key} ${frames.length}`);
        return { top, bottom: "black shorts", glasses, spot, shirt_words: "Stronger than yesterday", shirt_logo: "a hexagon", wall_words: ["BE STRONG."], frames: frames.map((_, index) => ({ index, people: 1, looks_at_lens: index !== 0, eyes_open: true, mouth_closed: index === 2, sharp: true, hands_low: true, head_box: key === "video-03" ? [370, 430, 470, 560] : [150, 400, 290, 600], print_box: key === "video-03" ? [520, 400, 600, 600] : [400, 350, 570, 650] })) }; },
    };
    const r = await readSamples({ gymDir: dir, models });
    assert.deepEqual([r.read, r.calls, r.left, calls.filter((c) => c.startsWith("look")).every((c) => /\s[2-8]$/.test(c))], [["video-01.mp4", "video-02.mp4", "video-03.mp4"], 6, 0, true]);
    assert.deepEqual([(await readSamples({ gymDir: dir, models })).calls, samples(dir)[1].read.heard.words, samples(dir)[1].read.heard.per_second], [0, 10, 2], "a sample is read once; how fast they speak is counted");
    assert.ok(!JSON.stringify(samples(dir)).match(/race|ethnic|"name":\s*"[A-Z][a-z]+ [A-Z]/), "nothing about who a person is is kept");
    // Groups are a help for the owner's click, never a name.
    const g0 = groupsOf(dir);
    assert.deepEqual(g0.map((g) => [g.label, g.samples.map((s) => s.name), g.coach]), [["black T-shirt, no glasses", ["video-01.mp4", "video-02.mp4"], null], ["white T-shirt, glasses", ["video-03.mp4"], null]]);
    const x = addCoach(dir, { name: "Xena" }), f = addCoach(dir, { name: "Faye" });
    setSamples(dir, x.id, ["video-01.mp4", "video-02.mp4"]); setSamples(dir, f.id, ["video-03.mp4"]);
    assert.deepEqual(groupsOf(dir).map((g) => g.coach), [x.id, f.id]);
    // The crop, pure: a frame filmed close is cut a little so the print ends above the captions; one filmed from far is cut closer, never softer than the floor.
    const close = startCrop({ width: 1080, height: 1920, head: [150, 400, 290, 600], print: [400, 350, 570, 650] }), far = startCrop({ width: 1080, height: 1920, head: [370, 430, 470, 560], print: [520, 400, 600, 600] });
    assert.ok(close.clear && close.print_bottom <= START.print_bottom + 0.012 && close.head_top >= 0.04 && close.w > 900, JSON.stringify(close));
    assert.ok(far.clear && far.w >= START.min_crop_w && far.w < 700 && Math.abs(far.w / far.h - 9 / 16) < 0.01, JSON.stringify(far));
    assert.equal(startCrop({ width: 1080, height: 1920, head: [800, 400, 990, 600], print: [] }), null, "a head at the foot of the frame cannot start a clip");
    assert.equal(startCrop({ width: 1080, height: 1920, head: [], print: [] }), null);
    // The starting pictures: the best frame of each sample (looking into the lens, the mouth closed), in the framings it can be cut to.
    const built = buildStarts(dir), cx = readCoaches(dir).coaches.find((c) => c.id === x.id), cf = readCoaches(dir).coaches.find((c) => c.id === f.id);
    assert.deepEqual(built.map((b) => [b.id, b.starts]), [[x.id, 2], [f.id, 2]]);
    assert.ok(cx.starts.every((s) => s.clear && s.framing === "close" && existsSync(join(dir, SAMPLES_DIR, s.file))) && cf.starts.map((s) => s.framing).sort().join() === "close,wide");
    const at = samples(dir)[0].read.frames.find((fr) => fr.mouth_closed).at; assert.ok(cx.starts.some((s) => s.sample === "video-01.mp4" && s.at === at), "the frame with the mouth closed is the one cut");
    assert.deepEqual(probe(join(dir, SAMPLES_DIR, cx.starts[0].file)), { seconds: 0.04, width: 720, height: 1280, audio: false });
    assert.deepEqual([cx.wears, cf.wears.glasses, readCoaches(dir).uniform], [{ top: "black T-shirt", bottom: "black shorts", glasses: false }, true, { words: "STRONGER THAN YESTERDAY", logo: "a hexagon", by: "read" }]);
    assert.deepEqual([cx.voice.from, cx.voice.per_second, cx.voice.by], ["video-02.mp4", 2, "read"], "the voice is described from the sample where the most is said");
    assert.match(cx.voice.description, /^a clear voice with light chest resonance; medium-low pitch; Singaporean English, moderate accent; warm and clear$/);
    // The owner's words on the voice and the uniform stand over any reading; a picture taken off stays off.
    assert.throws(() => setVoice(dir, x.id, "deep"), /12 to 400 characters/);
    setVoice(dir, x.id, "a calm, low voice with a light Singaporean accent"); setUniform(dir, { words: "stronger than yesterday", logo: "the hexagon b" });
    assert.throws(() => switchStart(dir, x.id, cx.starts[0].file, { on: false }), /say why this picture is taken off/);
    switchStart(dir, x.id, cx.starts[0].file, { on: false, reason: "eyes half closed" }); buildStarts(dir);
    const after = readCoaches(dir); const ax = after.coaches.find((c) => c.id === x.id);
    assert.deepEqual([ax.voice.by, ax.voice.description, after.uniform.by, after.uniform.words, ax.starts.find((s) => s.file === cx.starts[0].file).off.reason], ["owner", "a calm, low voice with a light Singaporean accent", "owner", "STRONGER THAN YESTERDAY", "eyes half closed"]);
    // Who can be filmed: consent for the face and the voice, switched on, a starting picture.
    assert.match(coachWhy(ax), /written consent is not on file/); assert.throws(() => pickCoaches(dir, 2), /no coach can be filmed yet — Xena's written consent/);
    setConsent(dir, x.id, { face: true, voice: false, by: "signed form" }); assert.match(coachWhy(readCoaches(dir).coaches[0]), /not to their voice/);
    setConsent(dir, x.id, { face: true, voice: true, by: "signed form" }); setConsent(dir, f.id, { face: true, voice: true, by: "signed form" });
    assert.deepEqual(readyCoaches(dir).map((c) => c.name), ["Xena", "Faye"]);
    // Shared evenly, the same on every run; one coach for a whole batch when asked.
    const five = pickCoaches(dir, 5, { seed: "b1" }).map((c) => c.name);
    assert.deepEqual([five.filter((n) => n === "Xena").length + five.filter((n) => n === "Faye").length, Math.abs(five.filter((n) => n === "Xena").length - five.filter((n) => n === "Faye").length), pickCoaches(dir, 5, { seed: "b1" }).map((c) => c.name)], [5, 1, five]);
    assert.deepEqual(pickCoaches(dir, 3, { only: f.id }).map((c) => c.name), ["Faye", "Faye", "Faye"]);
    switchCoach(dir, f.id, { on: false, reason: "on leave" }); assert.throws(() => pickCoaches(dir, 1, { only: f.id }), /Faye is switched off \(on leave\)/); assert.deepEqual(pickCoaches(dir, 2).map((c) => c.name), ["Xena", "Xena"]);
    // As a maker takes one: the live pictures, two real pictures to re-make from, the voice, the uniform.
    const v = coachForVideo(dir, readCoaches(dir).coaches[0]);
    assert.deepEqual([v.key, v.name, v.voice, v.starts.length, v.starts.every((p) => existsSync(p)), v.refs.length, v.uniform.words, v.wears.top], ["xena", "Xena", "a calm, low voice with a light Singaporean accent", 1, true, 2, "STRONGER THAN YESTERDAY", "black T-shirt"]);
    switchStart(dir, x.id, v.starts[0].split("video-samples/")[1], { on: false, reason: "soft" });
    assert.match(coachWhy(readCoaches(dir).coaches[0]), /no starting picture yet/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CK4 a starting picture is of the coach standing, the shirt's words readable (2026-11-18: BFIT's re-make first started a coach from a frame of them seated and leaning, the words creased, and every take failed the uniform check): a frame whose print reads in full is picked before one with the mouth closed; a seated sample's pictures are kept but used only when there is none of the coach standing", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "look4-"));
  try {
    const mk = (name, colour) => { const f = join(dir, name); execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=1080x1920:r=12:d=5`, "-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]); return f; };
    addSample(dir, mk("standing.mp4", "gray")); addSample(dir, mk("seated.mp4", "navy")); addSample(dir, mk("creased.mp4", "white"));
    const frame = (index, over = {}) => ({ index, people: 1, looks_at_lens: true, eyes_open: true, mouth_closed: false, sharp: true, hands_low: true, ready: true, print_readable: true, head_box: [370, 430, 470, 560], print_box: [520, 400, 600, 600], ...over });
    const models = {
      async hear() { return { transcript: "one two three", speakers: 1, pitch: "medium", pace: "measured", accent: "light", energy: "warm", voice: "A clear voice." }; },
      async look(frames) { const key = basename(dirname(frames[0]));
        return { top: "white T-shirt", bottom: "black trousers", glasses: true, seated: key === "video-02", spot: key === "video-02" ? "on a treatment bed" : "on the turf lane", shirt_words: "STRONGER THAN YESTERDAY", shirt_logo: "a hexagon", wall_words: [],
          // standing: frame 1 has the mouth closed but the print hidden; frame 2 reads in full, mid-word — the readable one is the picture
          frames: frames.map((_, i) => (key === "video-01" ? frame(i, i === 1 ? { mouth_closed: true, print_readable: false } : i === 2 ? {} : { ready: false }) : key === "video-03" ? frame(i, { print_readable: false }) : frame(i, { mouth_closed: i === 1 }))) }; },
    };
    await readSamples({ gymDir: dir, models });
    assert.deepEqual(samples(dir).map((s) => s.read.seated), [false, true, false]);
    const c = addCoach(dir, { name: "Faye" }); setSamples(dir, c.id, ["video-01.mp4", "video-02.mp4", "video-03.mp4"]); setConsent(dir, c.id, { face: true, voice: true, by: "signed form" });
    buildStarts(dir);
    const me = readCoaches(dir).coaches[0], of = (name) => me.starts.filter((s) => s.sample === name);
    const at2 = samples(dir)[0].read.frames[2].at;
    assert.ok(of("video-01.mp4").length >= 1 && of("video-01.mp4").every((s) => s.clear && !s.seated && !s.creased && s.at === at2), JSON.stringify(of("video-01.mp4")));
    assert.ok(of("video-02.mp4").length >= 1 && of("video-02.mp4").every((s) => s.seated === true && s.clear === false), "a seated sample's pictures are kept, and are not clear");
    assert.ok(of("video-03.mp4").length >= 1 && of("video-03.mp4").every((s) => s.creased === true && s.clear === false), "no frame of it reads in full: its pictures are not clear");
    // The makers are given the standing, readable pictures only…
    const v = coachForVideo(dir, me);
    assert.ok(v.starts.length >= 1 && v.starts.every((p) => /video-01-/.test(p)), JSON.stringify(v.starts.map((p) => basename(p))));
    // …and the others only when there is none of them.
    for (const s of of("video-01.mp4")) switchStart(dir, c.id, s.file, { on: false, reason: "test" });
    const left = coachForVideo(dir, readCoaches(dir).coaches[0]);
    assert.ok(left.starts.length >= 2 && left.starts.every((p) => /video-0[23]-/.test(p)), JSON.stringify(left.starts.map((p) => basename(p))));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
