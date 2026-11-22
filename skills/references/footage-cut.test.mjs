// The raw-footage editor, stage 2 (footage-cut.mjs): where the voice sounds, which words fall where, what is kept of a
// take, the pieces of the cut and its captions. The rules are pure and tested here with no file; one small real cut is
// made with ffmpeg and headless Chrome (no model, no whisper: the hearing is passed in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { CUT, PACE, stretchesOf, assignWords, timeWords, keptRanges, digitsIn, planCut, captionBlocks, cutShoot, listCuts } from "./footage-cut.mjs";
import { buildSheet } from "./footage-editor.mjs";

const levels = (spans, seconds, step = 0.02) => Array.from({ length: Math.round(seconds / step) }, (_, i) => (spans.some(([a, b]) => i * step >= a && i * step < b) ? -20 : -55));
const texts = (t) => t.words.map((w) => w.text);

test("FC1 where the voice sounds, and which words fall where: stretches come from the clip's own levels; the words are placed pause by pause at a believable pace with what was heard as a loose guide — a line's first words heard early, in the silence before the voice, still land on the voice; a short noise at the edge of a take is left out; with no hearing the pace alone decides", () => {
  const lv = levels([[1.0, 2.0], [2.6, 4.0], [6.0, 6.2]], 8), st = stretchesOf(lv, 0.5, 7.5);
  assert.deepEqual([st.out, st.floor, st.top, st.line < st.top && st.line > st.floor], [[[1, 2], [2.6, 4], [6, 6.2]], -55, -20, true]);
  assert.deepEqual(stretchesOf(lv, 2.3, 4.5).out, [[2.6, 4]], "only what lies in the window"); assert.deepEqual(stretchesOf([], 0, 1).out, []);
  // Two phrases with a pause between: the words go where they were heard.
  let t = timeWords("Give us six weeks, and you will feel new", [[1, 2], [2.6, 4]], [{ text: "Give", at: 1.0 }, { text: "us", at: 1.2 }, { text: "six", at: 1.4 }, { text: "weeks,", at: 1.6 }, { text: "and", at: 2.6 }, { text: "you", at: 2.8 }, { text: "will", at: 3.0 }, { text: "feel", at: 3.3 }, { text: "new", at: 3.6 }]);
  assert.deepEqual([t.by, t.used, texts(t).slice(0, 4), t.words[0].from, t.words[3].to, t.words[4].from, t.words.at(-1).to], ["heard", [[1, 2], [2.6, 4]], ["Give", "us", "six", "weeks,"], 1, 2, 2.6, 4]);
  assert.ok(t.words.every((w, i) => w.to > w.from && (!i || w.from >= t.words[i - 1].from)), "in order, each with its own time");
  // The first words heard early (a known habit of the hearing): the long stretch is where the line is, the short sound before it is a noise.
  t = timeWords("You'll also learn how to maintain your new body and never be overweight again.", [[3.72, 3.9], [5.72, 9.48]], [["You'll", 2.9], ["also", 3.79], ["learn", 4.39], ["how", 5.13], ["to", 5.74], ["maintain", 5.88], ["your", 7.1], ["new", 7.22], ["body", 7.52], ["and", 7.94], ["never", 8.18], ["be", 8.52], ["overweight", 8.58], ["again.", 9.2]].map(([text, at]) => ({ text, at })));
  assert.deepEqual([t.used, t.words[0].from, t.words.length], [[[5.72, 9.48]], 5.72, 14], "the end of someone's 'okay' before the line is not the line's first word");
  // The next line's first words inside the window are not this line's.
  t = timeWords("We will follow these three core principles,", [[1.42, 3.28], [3.78, 4.15]], [["We", 0.17], ["will", 0.34], ["follow", 0.69], ["these", 1.42], ["three", 1.7], ["core", 2.09], ["principles,", 2.45], ["no", 3.51], ["going", 3.78]].map(([text, at]) => ({ text, at })));
  assert.deepEqual([t.used, t.words.at(-1).to], [[[1.42, 3.28]], 3.28]);
  // A word the hearing got wrong is still placed (the caption's words are the sheet's, never the hearing's).
  t = timeWords("a full body diagnosis", [[1, 2.2]], [{ text: "a", at: 1 }, { text: "footballing", at: 1.2 }, { text: "diagnosis", at: 1.7 }]);
  assert.deepEqual([texts(t), t.by], [["a", "full", "body", "diagnosis"], "heard"]);
  // No hearing: the pace alone. Nine syllables do not fit a fifth of a second.
  t = timeWords("Click the link below and we will be in touch", [[0.2, 0.4], [1.5, 4.0]], []);
  assert.deepEqual([t.by, t.used], ["pace", [[1.5, 4]]]);
  assert.deepEqual(timeWords("", [[1, 2]]).words, []); assert.deepEqual(timeWords("words here", []).by, "none");
  assert.deepEqual(assignWords([1, 1, 1, 1, 1, 1], [null, null, null, null, null, null], [[0, 0.6], [1, 1.6]]), [0, 0, 0, 1, 1, 1], "an even pace over two equal stretches");
  assert.ok(PACE.ideal > 3 && PACE.ideal < 7);
});

test("FC2 what is kept of a take and the pieces of the cut: a take runs from just before its first word to just after its last, a long pause inside it tightened to a short one (the owner's default, with a switch); two takes that follow one another in one clip meet half-way and never play a sound twice; footage goes under a voice and over a line said to camera in even shots, a clip used twice going on from where it stopped; numbers read as the script writes them", () => {
  assert.deepEqual(keptRanges([[2, 3], [3.4, 5]]), [[1.88, 5.25]], "a short pause is kept");
  assert.deepEqual(keptRanges([[2, 3], [4.5, 5]]), [[1.88, 3.2], [4.3, 5.25]], `a pause of ${CUT.long_pause} s or more is cut to ${CUT.pause_to} s`);
  assert.deepEqual(keptRanges([[2, 3], [4.5, 5]], { tighten: false }), [[1.88, 5.25]]);
  assert.deepEqual([keptRanges([[0.05, 1]], { duration: 1.1 }), keptRanges([])], [[[0, 1.1]], []], "never before the clip starts or past its end");
  assert.deepEqual([digitsIn("Just give us six weeks, in week one we take ten individuals and one of the coaches"), digitsIn("our six-weeks challenge")], ["Just give us 6 weeks, in week 1 we take 10 individuals and one of the coaches", "our 6 weeks challenge"]);
  // A sheet of four lines: a voice recording under footage, two lines in one clip, a line said to camera with B-roll over it.
  const T = (file, from, to, spoken, extra = {}) => ({ file, from, to, spoken, said: 1, own: 1, complete: true, sound_only: false, ...extra });
  const row = (n, takes, extra = {}) => ({ n, text: `line ${n}`, parts: [{ text: `line ${n}`, takes, pick: 0, auto: 0 }], drop: false, missing: false, show: "take", ...extra });
  const sheet = { lines: [
    row(1, [T("vo.m4a", 1, 5, "one two three four", { sound_only: true })], { show: "footage", pictures: ["b1.mov", "b2.mov"] }),
    row(2, [T("talk.mov", 1, 3, "five six")]), row(3, [T("talk.mov", 3.2, 5, "seven eight")]),
    row(4, [T("talk2.mov", 2, 4, "nine ten")], { show: "footage", pictures: ["b1.mov"] }),
    row(5, [T("talk2.mov", 9, 10, "left out")], { drop: true }) ] };
  const W = (words) => words.map(([text, from, to]) => ({ text, from, to }));
  const timings = {
    "vo.m4a@1": { used: [[1, 5]], words: W([["one", 1, 2], ["two", 2, 3], ["three", 3, 4], ["four", 4, 5]]), top: -8 },
    "talk.mov@1": { used: [[1.2, 2.9]], words: W([["five", 1.2, 2], ["six", 2, 2.9]]), top: -22 },
    "talk.mov@3.2": { used: [[3.1, 4.8]], words: W([["seven", 3.1, 4], ["eight", 4, 4.8]]), top: -22 },
    "talk2.mov@2": { used: [[2, 3.5]], words: W([["nine", 2, 2.8], ["ten", 2.8, 3.5]]), top: -24 } };
  const files = { "vo.m4a": { seconds: 6, video: false }, "talk.mov": { seconds: 6, video: true }, "talk2.mov": { seconds: 12, video: true }, "b1.mov": { seconds: 10, video: true }, "b2.mov": { seconds: 2, video: true } };
  const p = planCut(sheet, timings, { files });
  assert.deepEqual(p.pieces.map((x) => [x.line, x.v, x.a, !!x.footage]), [
    [1, ["b1.mov", 1.5, 3.685], ["vo.m4a", 0.88, 3.065], true], [1, ["b2.mov", 0, 2.185], ["vo.m4a", 3.065, 5.25], true],
    [2, ["talk.mov", 1.08, 3], ["talk.mov", 1.08, 3], false], [3, ["talk.mov", 3, 5.05], ["talk.mov", 3, 5.05], false],
    [4, ["b1.mov", 3.685, 5.555], ["talk2.mov", 1.88, 3.75], true]]);
  assert.ok(p.notes.some((x) => /b2\.mov is 2 s, shorter than the 2\.19 s it has to cover: its last frame holds/.test(x)), p.notes.join(" | "));
  assert.equal(p.seconds, 10.21); assert.ok(Math.abs(p.pieces.reduce((s, x) => s + (x.a[2] - x.a[1]), 0) - p.seconds) < 0.02, "the pieces add up to the cut");
  assert.ok(p.pieces.every((x) => Math.abs((x.v[2] - x.v[1]) - (x.a[2] - x.a[1])) < 1e-6), "every piece has a picture and a sound of one length");
  // The words on the video's clock: in order, the dropped line's nowhere.
  assert.deepEqual(p.words.map((w) => [w.text, w.line]), [["one", 1], ["two", 1], ["three", 1], ["four", 1], ["five", 2], ["six", 2], ["seven", 3], ["eight", 3], ["nine", 4], ["ten", 4]]);
  assert.deepEqual([p.words[0].from, p.words[4].from, p.words[6].from, p.words[8].from], [0.12, 4.49, 6.39, 8.46]);
  assert.ok(p.words.every((w, i) => !i || w.from >= p.words[i - 1].from));
  // A take with no voice found is said and left out; a sound-only take with no footage too.
  const q = planCut({ lines: [row(1, [T("vo.m4a", 1, 5, "x", { sound_only: true })]), row(2, [T("talk.mov", 1, 3, "y")]), row(3, [T("gone.mov", 1, 3, "z")])] }, { ...timings, "talk.mov@1": timings["talk.mov@1"] }, { files });
  assert.deepEqual([q.pieces.map((x) => x.line), q.notes.length], [[2], 2]); assert.match(q.notes.join(" | "), /line 1: its take is sound only and it has no footage/); assert.match(q.notes.join(" | "), /line 3: no voice was found in gone\.mov/);
  // Tightening off: the take plays whole.
  const pause = { "talk.mov@1": { used: [[1, 2], [3.5, 4]], words: W([["five", 1, 2], ["six", 3.5, 4]]), top: -22 } };
  assert.deepEqual([planCut({ lines: [row(2, [T("talk.mov", 1, 4, "five six")])] }, pause, { files }).pieces.length, planCut({ lines: [row(2, [T("talk.mov", 1, 4, "five six")])] }, pause, { files, tighten: false }).pieces.length], [2, 1]);
});

test("FC3 captions: three words at most, a block ends at a clause or a real pause, is held through a short pause so nothing blinks, and never stays up past its own take; the word being said is one picture each", () => {
  const w = (text, from, to, take = "a") => ({ text, from, to, take, line: 1 });
  const words = [w("Just", 0.2, 0.4), w("give", 0.4, 0.6), w("us", 0.6, 0.8), w("six", 0.8, 1.0), w("weeks,", 1.0, 1.3), w("and", 1.5, 1.7), w("you'll", 1.7, 2.0), w("go", 2.0, 2.2), w("far.", 3.4, 3.8), w("Next", 4.0, 4.3, "b"), w("take.", 4.3, 4.8, "b")];
  const { blocks, shots } = captionBlocks(words, { a: 3.9, b: 5.0 }, 5.0);
  assert.deepEqual(blocks.map((b) => [b.text, b.from, b.to]), [["Just give us", 0.2, 0.8], ["six weeks", 0.8, 1.5], ["and you'll go", 1.5, 2.4], ["far", 3.4, 3.9], ["Next take", 4, 5]]);
  assert.equal(shots.length, words.length); assert.deepEqual(shots.slice(0, 3).map((s) => [s.text, s.i, s.from, s.to]), [["Just give us", 0, 0.2, 0.4], ["Just give us", 1, 0.4, 0.6], ["Just give us", 2, 0.6, 0.8]]);
  assert.ok(shots.every((s, i) => !i || s.from >= shots[i - 1].to - 1e-9), "two words are never lit at once");
  assert.deepEqual(captionBlocks([], {}, 1), { blocks: [], shots: [] });
});

const clip = (file, { seconds = 4, picture = true, w = 180, h = 320, freq = 300 } = {}) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...(picture ? ["-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=10:duration=${seconds}`] : []), "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, ...(picture ? ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"] : []), "-c:a", "aac", "-shortest", file]);

test("FC4 a shoot cut end to end, with no model: the sheet's lines in order, footage under the voice recording, captions drawn inside Meta's live area, the result a 1080×1920 video with sound beside a record of its pieces, lines and captions; a sheet that is not ready is refused in words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc4-")), gym = join(dir, "gym"), sd = join(gym, "footage", "shoot-1"), fd = join(sd, "files"); mkdirSync(fd, { recursive: true });
  try {
    writeFileSync(join(gym, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym" }));
    clip(join(fd, "a-talk.mov")); clip(join(fd, "b-roll.mov"), { seconds: 6 }); clip(join(fd, "c-voice.m4a"), { picture: false, freq: 500 });
    const P = (text, start, end) => ({ text, start, end, kind: "line" }), st = (name) => { const s = statSync(join(fd, name)); return { name, key: name, path: join(fd, name), source: "dropped", bytes: s.size, mtime: Math.round(s.mtimeMs) }; };
    const shoot = { id: "shoot-1", title: "A shoot", created: "2026-11-20T00:00:00Z", folder: null, choices: {}, script: "Quick question for you. (voiceover)\n\nGive us six weeks and see.",
      files: [{ ...st("a-talk.mov"), read: { seconds: 4, video: { w: 180, h: 320 }, sound: true, phrases: [P("Give us six weeks and see.", 0.8, 3)], music: false, sounds: "", spans: [], to_camera: true, shows: "talks to the camera" } },
        { ...st("b-roll.mov"), read: { seconds: 6, video: { w: 180, h: 320 }, sound: true, phrases: [], music: false, sounds: "", spans: [], to_camera: false, shows: "lifts a kettlebell" } },
        { ...st("c-voice.m4a"), read: { seconds: 4, video: null, sound: true, phrases: [P("Quick question for you.", 0.5, 2.5)], music: false, sounds: "", spans: [] } }] };
    writeFileSync(join(sd, "shoot.json"), JSON.stringify(shoot));
    assert.deepEqual(buildSheet(shoot).lines.map((r) => [r.n, r.state, r.show, r.pictures || null]), [[1, "ready", "footage", ["b-roll.mov"]], [2, "ready", "take", null]]);
    // The sound is a steady tone, so the voice's place is given: where it sounds and what was heard (as whisper would say it).
    const voiced = { "a-talk.mov": [[0.8, 3]], "c-voice.m4a": [[0.5, 2.5]] };
    const deps = { levelsOf: (file) => levels(voiced[file.split("/").pop()] || [], 4), hear: (file) => (file.endsWith("c-voice.m4a") ? [["Quick", 0.5], ["question", 0.9], ["for", 1.7], ["you.", 2.0]] : [["Give", 0.8], ["us", 1.1], ["six", 1.4], ["weeks", 1.7], ["and", 2.2], ["see.", 2.5]]).map(([text, at]) => ({ text, at })) };
    const logs = [], r = await cutShoot({ gymDir: gym, id: "shoot-1", deps, log: (m) => logs.push(m) });
    assert.ok(existsSync(r.file) && statSync(r.file).size > 5000, logs.join(" | "));
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", r.file]).toString());
    const v = pr.streams.find((x) => x.codec_type === "video"), a = pr.streams.find((x) => x.codec_type === "audio");
    assert.deepEqual([v.width, v.height, !!a, Math.abs(Number(pr.format.duration) - r.seconds) < 0.25], [1080, 1920, true, true]);
    const rec = JSON.parse(readFileSync(r.json, "utf-8"));
    assert.deepEqual([rec.name, rec.tightened, rec.timed_by, rec.lines.map((l) => [l.n, l.show, l.footage, l.takes, l.at])], ["cut-1", true, "heard", [[1, "footage", ["b-roll.mov"], ["c-voice.m4a"], 0], [2, "take", null, ["a-talk.mov"], 2.37]]]);
    assert.deepEqual(rec.pieces.map((p) => [p.line, p.video.split(" ")[0], p.sound.split(" ")[0]]), [[1, "b-roll.mov", "c-voice.m4a"], [2, "a-talk.mov", "a-talk.mov"]]);
    assert.deepEqual(rec.captions.map((c) => c.text), ["Quick question", "for you", "Give us 6", "weeks and see"]);
    assert.ok(rec.captions.every((c, i) => c.to > c.from && (!i || c.from >= rec.captions[i - 1].from)));
    assert.ok(existsSync(r.file.replace(/\.mp4$/, ".jpg")), "a poster frame beside it");
    assert.deepEqual(listCuts(gym, "shoot-1").map((c) => c.name), ["cut-1"]);
    assert.ok(logs.some((l) => /done: cut-1\.mp4/.test(l)));
    // A second cut is a new file; the first stays.
    // (given as the CLI gives it, a path from the working folder: the caption list must still find its pictures)
    const again = await cutShoot({ gymDir: relative(process.cwd(), gym), id: "shoot-1", deps }); assert.equal(again.name, "cut-2"); assert.deepEqual(listCuts(gym, "shoot-1").map((c) => c.name), ["cut-2", "cut-1"]);
    // Not ready: a file not listened to yet.
    clip(join(fd, "d-new.mov"));
    await assert.rejects(cutShoot({ gymDir: gym, id: "shoot-1", deps }), /listen to every file first/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
