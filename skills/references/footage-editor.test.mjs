// The raw-footage editor, stage 1 (footage-editor.mjs): the script's lines, the files read, the takes matched, the cutting sheet.
// No model is called: the tests pass their own listening and looking; ffmpeg makes the small media files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pullNotes, wantsOf, brollGroups, footagePool, footageKey, matchFootage, shareClips, buildFootagePrompt, scriptLines, shootProblems, wordsOf, cover, differs, matchLine, saidInstead, pickTake, kindOf, buildSheet, decideSheet, addShoot, readShoot, listShoots, syncFiles, dropFile, editShoot, readShootFiles, sheetText, shootDir, MATCH } from "./footage-editor.mjs";

const SCRIPT = `Quick question - when did you last feel strong? (voiceover)

You started out full of energy, going to the gym every week. But after a few weeks nothing changes. (voiceover)

This is for you if you are done going round in circles and want to get into your best shape.

(Show video of people working out)
We are the coaches here, and we have helped hundreds of people.

Give us 6 weeks and you will go from tired and out of shape to healthy, happy, and toned.

Click the link now, let's get started!`;
const P = (text, start, end, kind = "line") => ({ text, start, end, kind });
const video = (phrases, extra = {}) => ({ seconds: 20, video: { w: 1080, h: 1920 }, sound: true, phrases, music: false, sounds: "", spans: [], ...extra });
const sound = (phrases) => ({ seconds: 20, video: null, sound: true, phrases, music: false, sounds: "", spans: [] });
const F = (key, read) => ({ key, name: key, path: `/x/${key}`, source: "folder", bytes: 1, mtime: 1, ...(read ? { read } : {}) });
const FILES = () => [
  F("b1.mov", video([])), F("b2.mov", video([P("Okay.", 0.2, 0.6, "chatter")])), F("b3.mov", video([])),
  F("t1.mov", video([P("3, 2, 1", 0.5, 1.5, "countdown"), P("This is for you if you're done going round in circles", 2, 5), P("and you want to get into your best shape.", 5.2, 8)])),
  F("t2.mov", video([P("Just give us six weeks, and you'll go from tired and out of shape,", 3, 7), P("Okay, again.", 8, 9, "chatter"), P("Just give us six weeks, and you'll go from tired and out of shape,", 10, 14)])),
  F("t3.mov", video([P("To healthy, happy and tone.", 1, 3, "chatter"), P("Ready?", 4, 4.5, "chatter"), P("To healthy, happy and toned.", 6, 8)])),
  F("t4.mov", video([P("Click on the link below, see if you're a good fit for our challenge.", 2, 6)])),
  F("vo.m4a", sound([P("Quick question. When did you last feel strong?", 1, 4), P("You started out full of energy, going to the gym every week,", 4.5, 8), P("but after a few weeks, nothing changes.", 8.2, 11)])),
  F("coach.m4a", sound([P("We are the coaches,", 0.5, 1.5), P("okay", 1.6, 1.9, "chatter"), P("We are the coaches here, and we have helped hundreds of people.", 3, 8)])),
  F("class.mp4", video([P("la la la", 1, 9, "lyrics")], { music: true })),
];

test("FE1 the script as pasted becomes its lines: one a paragraph; a note in brackets is a direction, never a word to say — it marks a voice-over or other footage, and a bracket on a line of its own belongs to the line after it; a shoot's name, script and folder are checked in words", () => {
  const lines = scriptLines(SCRIPT);
  assert.deepEqual(lines.map((l) => [l.n, l.voiceover, l.broll, l.notes]), [[1, true, false, ["voiceover"]], [2, true, false, ["voiceover"]], [3, false, false, []], [4, false, true, ["Show video of people working out"]], [5, false, false, []], [6, false, false, []]]);
  assert.equal(lines[0].text, "Quick question - when did you last feel strong?"); assert.equal(lines[3].text, "We are the coaches here, and we have helped hundreds of people.");
  assert.ok(lines.every((l) => !/[()]/.test(l.text)), "no direction is left among the words");
  assert.deepEqual(scriptLines("One line.\r\n\r\n[VO] Another line.  \n\n(b-roll of the gym)\n").map((l) => [l.text, l.voiceover, l.broll]), [["One line.", false, false], ["Another line.", true, false]]);
  assert.deepEqual(shootProblems({ title: "November shoot", script: SCRIPT }), []);
  assert.match(shootProblems({ title: "x", script: SCRIPT })[0], /give the shoot a name/); assert.match(shootProblems({ title: "November shoot", script: "short" })[0], /paste the script/);
  assert.match(shootProblems({ title: "November shoot", script: SCRIPT, folder: "Movies/shoot" })[0], /its full path on this Mac, starting with \//);
  assert.match(shootProblems({ title: "November shoot", script: SCRIPT, folder: "/no/such/folder/anywhere" })[0], /there is no folder at \/no\/such\/folder\/anywhere \(is the drive plugged in\?\)/);
  assert.match(shootProblems({ title: "November shoot", script: Array.from({ length: 30 }, (_, i) => `Line number ${i} of the script.`).join("\n\n") })[0], /30 lines; a video takes 24 at most/);
});

test("FE2 matching by rule: words are compared in order with a number the same as its word and one letter's slip forgiven; a run of phrases that says enough of a line is a take of it; the pick is the last complete take; one sentence filmed as two clips is two parts; a line said in other words is offered what was said instead, flagged; a line nobody said is missing — nothing is ever made up", () => {
  assert.deepEqual(wordsOf("Give us SIX weeks — you’ll go: founders/coaches!"), ["give", "us", "6", "weeks", "you'll", "go", "founders", "coaches"]);
  const c = cover(wordsOf("By week 2 you will start feeling stronger"), wordsOf("By week two, you'll start feeling strongr"));
  assert.deepEqual([c.hit, Math.round(c.said * 100)], [6, 75], "two → 2; 'strongr' is one letter from 'stronger'; 'you will' is not 'you'll'");
  assert.deepEqual(differs("We'll help you become the person you wanted to be.", "Then we'll help you become the person you want to be."), { unsaid: ["wanted"], added: ["then", "want"], same: false });
  assert.equal(differs("Click the link.", "click the LINK").same, true);
  const files = FILES(), lines = scriptLines(SCRIPT);
  // A retake: the last complete take is the pick, the first is kept as a choice. The countdown is nobody's line.
  let m = matchLine(lines[2].text, files);
  assert.deepEqual([m.takes.length, m.pick, m.takes[0].file, m.takes[0].from, m.takes[0].to, m.takes[0].complete], [1, 0, "t1.mov", 2, 8, true]);
  m = matchLine(lines[3].text, files);
  assert.deepEqual(m.takes.map((t) => [t.file, t.from, t.complete, t.sound_only]), [["coach.m4a", 3, true, true]], "a false start that says too little of the line is no take");
  // One sentence in two clips: each part has its own takes, and each part's pick is its last complete one.
  m = matchLine(lines[4].text, files);
  assert.equal(m.parts.length, 2); assert.deepEqual(m.parts.map((p) => [p.takes.map((t) => `${t.file}@${t.from}`), p.pick]), [[["t2.mov@3", "t2.mov@10"], 1], [["t3.mov@1", "t3.mov@6"], 1]]);
  assert.equal(m.parts.map((p) => p.text).join(" "), lines[4].text, "the two parts are the line's own words, split where the clips change");
  // Said in other words: nothing matches as a take, the nearest thing said is offered, never picked silently as "complete".
  m = matchLine(lines[5].text, files); assert.deepEqual([m.takes.length, m.missing], [0, true]);
  const inst = saidInstead(lines[5].text, files, []);
  assert.deepEqual(inst.map((t) => [t.file, t.from, t.instead, t.complete]), [["t4.mov", 2, true, false]]);
  assert.deepEqual(saidInstead(lines[5].text, files, [{ file: "t4.mov", from: 2, to: 6 }]), [], "what another line uses is not offered twice");
  assert.deepEqual(matchLine("Bring a friend along for half the fun.", files), { takes: [], pick: -1, missing: true });
  assert.equal(pickTake([{ complete: true, said: 1 }, { complete: false, said: 0.7 }, { complete: true, said: 0.9 }, { complete: false, said: 0.65 }]), 2, "the last complete take");
  assert.equal(pickTake([{ complete: false, said: 0.62 }, { complete: false, said: 0.7 }]), 1, "with none complete, the one that says the most");
  assert.deepEqual([kindOf(files[0].read), kindOf(files[3].read), kindOf(files[7].read), kindOf(files[9].read), kindOf(null)], ["silent", "take", "voice", "montage", null]);
  assert.ok(MATCH.complete > MATCH.take && MATCH.instead < MATCH.take);
});

test("FE3 the cutting sheet: every line with its takes and the pick, what was said where it differs, footage for a line whose take is sound only (the montage for a line that asks for other footage, the silent clips shared in order by length), the files nothing uses; the owner's choices — another take, the footage, a line left out, the order — are kept and nothing else moves them; unread files stop the cut", () => {
  const dir = mkdtempSync(join(tmpdir(), "fe3-")), gym = join(dir, "gym"); mkdirSync(join(gym, "footage", "shoot-1"), { recursive: true });
  try {
    const shoot = { id: "shoot-1", title: "November shoot", created: "2026-11-19T00:00:00Z", script: SCRIPT, folder: null, files: FILES(), choices: {} };
    writeFileSync(join(gym, "footage", "shoot-1", "shoot.json"), JSON.stringify(shoot));
    let s = buildSheet(shoot);
    assert.deepEqual(s.lines.map((r) => [r.n, r.state, r.split, r.needs_picture]), [[1, "ready", false, true], [2, "ready", false, true], [3, "ready", false, false], [4, "ready", false, true], [5, "ready", true, false], [6, "said differently", false, false]]);
    assert.deepEqual(s.lines.map((r) => r.pictures || null), [["b1.mov"], ["b2.mov", "b3.mov"], null, ["class.mp4"], null, null], "the longer voice-over line takes more of the silent clips; the line that asks for other footage takes the video with music");
    assert.deepEqual([s.lines[5].parts[0].takes[0].instead, s.lines[5].parts[0].differs.same, s.lines[2].said_as_written, s.lines[0].said_as_written], [true, false, false, true]);
    assert.deepEqual([s.counts, s.can_cut, s.unread], [{ lines: 6, ready: 5, no_take: 0, differently: 1, needs_footage: 0, left_out: 0, differ: 3 }, true, 0]);
    assert.deepEqual(s.files.filter((f) => !f.used).map((f) => f.key), [], "every file is used by a line");
    assert.deepEqual(s.files.find((f) => f.key === "vo.m4a"), { key: "vo.m4a", name: "vo.m4a", source: "folder", read: true, kind: "voice", seconds: 20, shows: null, frames: null, phrases: 3, used: true });
    assert.match(sheetText(shoot), /5\. Give us 6 weeks[^\n]*— ready\n   part: "Give us 6 weeks and you will go from tired and out of shape"\n     t2\.mov 3\.0–7\.0 s · complete[^\n]*\n   ▶ t2\.mov 10\.0–14\.0 s · complete/);
    // The owner's choices.
    s = decideSheet(gym, "shoot-1", { line: 5, take: [0, 1] });
    assert.deepEqual(s.lines[4].parts.map((p) => [p.pick, p.auto]), [[0, 1], [1, 1]], "the first take of the first part, on his word; the sheet still says which the rule would pick");
    s = decideSheet(gym, "shoot-1", { line: 2, pictures: ["b3.mov", "b1.mov"] });
    assert.deepEqual([s.lines[1].pictures, s.lines[1].pictures_by, s.lines[0].pictures], [["b3.mov", "b1.mov"], "you", ["b2.mov"]], "his footage stands; the other voice-over line takes what he has left");
    s = decideSheet(gym, "shoot-1", { line: 6, drop: true });
    assert.deepEqual([s.lines[5].state, s.counts.left_out, s.counts.differently, s.can_cut], ["left out", 1, 0, true]);
    s = decideSheet(gym, "shoot-1", { order: [3, 1, 2, 4, 5, 6] });
    assert.deepEqual([s.lines.map((r) => r.n), s.order], [[3, 1, 2, 4, 5, 6], [3, 1, 2, 4, 5, 6]]);
    assert.deepEqual(readShoot(gym, "shoot-1").choices, { 5: { take: [0, 1] }, 2: { pictures: ["b3.mov", "b1.mov"] }, 6: { drop: true }, order: [3, 1, 2, 4, 5, 6] });
    s = decideSheet(gym, "shoot-1", { line: 6, drop: false }); assert.equal(s.lines.find((r) => r.n === 6).state, "said differently");
    for (const [bad, re] of [[{ line: 5, take: 1 }, /not one of this line's takes/], [{ line: 3, take: 4 }, /not one of this line's takes/], [{ line: 9, drop: true }, /the script has no line 9/], [{ line: 2, pictures: ["vo.m4a"] }, /clips of this shoot that have a picture/], [{ order: [1, 2, 3] }, /the order names every line once/], [{ order: [1, 1, 2, 3, 4, 5] }, /the order names every line once/]]) assert.throws(() => decideSheet(gym, "shoot-1", bad), re);
    // A file not read yet: the sheet says so and nothing is cut from half a shoot. A line whose only take is sound, with no clip to put under it, needs footage.
    const half = { ...shoot, choices: {}, files: [...FILES().filter((f) => !/^b\d|class/.test(f.key)), F("new.mov")] };
    s = buildSheet(half);
    assert.deepEqual([s.unread, s.can_cut, s.lines[0].state, s.lines[0].pictures, s.counts.needs_footage], [1, false, "needs footage", [], 3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const clip = (file, { seconds = 2, picture = true } = {}) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...(picture ? ["-f", "lavfi", "-i", `testsrc=size=180x320:rate=10:duration=${seconds}`] : []), "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, ...(picture ? ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"] : []), "-c:a", "aac", "-shortest", file]);

test("FE4 a shoot on file: its folder is read where it is (a Recordings folder inside it too) and files can be dropped in; reading is the owner's run — each file listened to once and looked at once, saved as it is read, kept for the gym so a second shoot from the same folder costs nothing; a changed script drops the old choices, a file that is gone is gone from the sheet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fe4-")), gym = join(dir, "gym"), folder = join(dir, "November"); mkdirSync(gym, { recursive: true }); mkdirSync(join(folder, "Recordings"), { recursive: true });
  try {
    clip(join(folder, "IMG_1.MOV")); clip(join(folder, "IMG_2.MOV")); clip(join(folder, "Recordings", "voice.m4a"), { picture: false }); writeFileSync(join(folder, "notes.txt"), "not media"); writeFileSync(join(folder, "._IMG_1.MOV"), "a Mac's shadow file");
    const shoot = addShoot(gym, { title: "November shoot", script: SCRIPT, folder }, { now: new Date("2026-11-19T02:00:00Z") });
    assert.equal(shoot.id, "2026-11-19-november-shoot");
    assert.deepEqual(shoot.files.map((f) => [f.key, f.source, !!f.read]), [["IMG_1.MOV", "folder", false], ["IMG_2.MOV", "folder", false], ["voice.m4a", "folder", false]]);
    assert.equal(addShoot(gym, { title: "November shoot", script: SCRIPT }, { now: new Date("2026-11-19T03:00:00Z") }).id, "2026-11-19-november-shoot-2", "a second shoot of the same name on the same day gets its own id");
    assert.throws(() => addShoot(gym, { title: "November shoot", script: "x" }), /paste the script/);
    // A file dropped in: kept in the shoot's own folder, never the same name twice, only media.
    const bytes = readFileSync(join(folder, "IMG_2.MOV"));
    let s = dropFile(gym, shoot.id, "extra clip.mov", bytes);
    assert.deepEqual(s.files.map((f) => [f.key, f.source]), [["IMG_1.MOV", "folder"], ["IMG_2.MOV", "folder"], ["voice.m4a", "folder"], ["extra clip.mov", "dropped"]]);
    assert.ok(existsSync(join(shootDir(gym, shoot.id), "files", "extra clip.mov")));
    assert.throws(() => dropFile(gym, shoot.id, "extra clip.mov", bytes), /already in this shoot/); assert.throws(() => dropFile(gym, shoot.id, "notes.pdf", bytes), /not a video or a sound file/);
    // Reading: one listen for each file with sound, one look for each with a picture; a stop keeps what is read.
    const calls = [], say = { "IMG_1.MOV": [P("This is for you if you are done going round in circles and want to get into your best shape.", 0.2, 1.8)], "voice.m4a": [P("Quick question. When did you last feel strong?", 0.1, 1.5)] };
    let last = null;   // the clip being read: only IMG_1 has someone talking to the camera
    const models = { listen: async (file) => { last = file.split("/").pop(); calls.push(`listen ${last}`); return { phrases: say[last] || [], music: false, sounds: "room" }; }, look: async (sheet) => { calls.push("look"); assert.ok(existsSync(sheet)); return last === "IMG_1.MOV" ? { shows: "talks to the camera by the rack", to_camera: true, people: 1 } : { shows: "lifts a kettlebell", to_camera: false, people: 1 }; }, spans: () => [[0.2, 1.8]] };
    let r = await readShootFiles({ gymDir: gym, id: shoot.id, models, max: 2 });
    assert.deepEqual([r.read, r.left, calls], [2, 2, ["listen IMG_1.MOV", "look", "listen IMG_2.MOV", "look"]]);
    r = await readShootFiles({ gymDir: gym, id: shoot.id, models });
    assert.deepEqual([r.read, r.left, calls.slice(4)], [2, 0, ["listen voice.m4a", "listen extra clip.mov", "look"]], "what was read is not read again; a sound file is only listened to");
    s = readShoot(gym, shoot.id);
    const one = s.files[0].read;
    assert.deepEqual([one.seconds, one.video, one.sound, one.phrases.length, one.shows, one.to_camera, one.spans, existsSync(join(shootDir(gym, shoot.id), "frames", one.frames))], [2, { w: 180, h: 320 }, true, 1, "talks to the camera by the rack", true, [[0.2, 1.8]], true]);
    assert.deepEqual([s.files[2].read.video, kindOf(s.files[2].read), kindOf(s.files[1].read), kindOf(one)], [null, "voice", "silent", "take"]);
    const sheet = buildSheet(s);
    assert.deepEqual([sheet.unread, sheet.lines[0].state, sheet.lines[0].pictures, sheet.lines[2].state, sheet.lines[3].state, sheet.can_cut], [0, "ready", ["IMG_2.MOV", "extra clip.mov"], "ready", "no take", false]);
    // A second shoot from the same folder: the readings are the gym's, so nothing is read again.
    const again = addShoot(gym, { title: "Second video", script: SCRIPT, folder }, { now: new Date("2026-11-20T02:00:00Z") });
    assert.deepEqual(again.files.map((f) => !!f.read), [true, true, true]); const n = calls.length;
    r = await readShootFiles({ gymDir: gym, id: again.id, models }); assert.deepEqual([r.read, calls.length], [0, n]);
    assert.deepEqual(listShoots(gym).map((x) => x.id), ["2026-11-20-second-video", "2026-11-19-november-shoot-2", "2026-11-19-november-shoot"]);
    // The owner's edits: a new script drops the choices made for the old lines; the readings stay.
    decideSheet(gym, shoot.id, { line: 4, drop: true });
    s = editShoot(gym, shoot.id, { script: "This is for you if you are done going round in circles and want to get into your best shape.\n\nQuick question - when did you last feel strong? (voiceover)" });
    assert.deepEqual([s.choices, s.files.filter((f) => f.read).length, buildSheet(s).lines.map((x) => x.state)], [{}, 4, ["ready", "ready"]]);
    assert.throws(() => editShoot(gym, shoot.id, { folder: "/no/such/place" }), /there is no folder/);
    rmSync(join(folder, "IMG_2.MOV")); s = syncFiles(gym, readShoot(gym, shoot.id));
    assert.deepEqual(s.files.map((f) => f.key), ["IMG_1.MOV", "voice.m4a", "extra clip.mov"]);
    assert.throws(() => readShoot(gym, "../etc"), /no such shoot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FE5 B-roll as the owner writes it (2026-11-20, his first shoot: 'it doesn't understand to look for the B-Roll'): a note on a line of its own covers its whole paragraph, brackets inside brackets and all; a clip nobody talks to the camera in is footage whatever is said in the room, and words heard in it are a take only when nothing else is; the note's words are matched to what the clips show by one text call, a narrow ask never left empty by a wide one, a thing no clip shows flagged and never filled; B-roll covers a line said to camera too, with a switch a line", async () => {
  const SCRIPT2 = "(B-Roll - Measuring Inbody, Working Out, Eating Healthy/Food)\nIf you are not happy with the way you look, here is the truth.\nYou do not need to cut carbs.\n\nWe are looking for ten people to join our challenge.\n\n(B-Roll - Working out, doing spin; Resting + Recovery (plank at home))\nFollow our three core principles of:\nNo going to sleep hungry\n\nClick the link below. (voiceover)";
  assert.deepEqual(pullNotes("(B-Roll - spin; Recovery (plank at home)) Follow our rules [VO]"), { said: "Follow our rules", notes: ["B-Roll - spin; Recovery (plank at home)", "VO"] });
  assert.deepEqual([wantsOf("B-Roll - Measuring Inbody, Working Out, Eating Healthy/Food"), wantsOf("B-Roll - Working out, doing spin; Resting + Recovery (plank at home)"), wantsOf("Show video of people working out"), wantsOf("b roll: the gym")], [["Measuring Inbody", "Working Out", "Eating Healthy/Food"], ["Working out", "doing spin", "Resting + Recovery (plank at home)"], ["people working out"], ["the gym"]]);
  const lines = scriptLines(SCRIPT2);
  assert.deepEqual(lines.map((l) => [l.n, l.para, l.broll, l.group, l.voiceover]), [[1, 0, true, "g1", false], [2, 0, true, "g1", false], [3, 1, false, null, false], [4, 2, true, "g2", false], [5, 2, true, "g2", false], [6, 3, false, null, true]]);
  assert.ok(lines.every((l) => !/[()]/.test(l.text)), "no note is left as a line to say");
  assert.deepEqual(brollGroups(lines).map((g) => [g.id, g.lines, g.items]), [["g1", [1, 2], ["Measuring Inbody", "Working Out", "Eating Healthy/Food"]], ["g2", [4, 5], ["Working out", "doing spin", "Resting + Recovery (plank at home)"]]]);
  assert.deepEqual(scriptLines("(b-roll of the floor)\n\nFirst line here.\nSecond line here.").map((l) => [l.text, l.broll]), [["First line here.", true], ["Second line here.", true]], "a note that is a paragraph of its own covers the next one");
  // What a clip is: nobody talks to the camera → footage, even with people talking around it.
  const cam = (to_camera, phrases, shows) => ({ seconds: 12, video: { w: 1080, h: 1920 }, sound: true, phrases, music: false, sounds: "", spans: [], to_camera, shows });
  assert.deepEqual([kindOf(cam(false, [P("okay go", 1, 2, "chatter"), P("keep going", 3, 4, "chatter"), P("No going to sleep hungry", 5, 7)], "x")), kindOf(cam(true, [], "x")), kindOf(cam(undefined, [P("a", 1, 2, "chatter"), P("b", 3, 4, "chatter")], "x"))], ["silent", "take", "take"]);
  const dir = mkdtempSync(join(tmpdir(), "fe5-")), gym = join(dir, "gym"); mkdirSync(join(gym, "footage", "shoot-2"), { recursive: true });
  try {
    const files = [
      F("a-scan.mov", cam(false, [P("stand still", 1, 2, "chatter"), P("okay", 3, 4, "chatter")], "stands on a smart scale holding handles")),
      F("b-kb1.mov", cam(false, [], "kettlebell deadlifts")), F("c-kb2.mov", cam(false, [P("No going to sleep hungry", 2, 4)], "kettlebell swings")),
      F("d-bike.mov", cam(false, [P("go go", 1, 2, "chatter")], "rides an air bike")), F("e-plank.mov", cam(false, [], "holds a plank on the floor")),
      F("f-talk1.mov", cam(true, [P("We are looking for ten people to join our challenge.", 1, 5)], "talks to the camera")),
      F("g-talk2.mov", cam(true, [P("Follow our three core principles of,", 1, 3), P("no going to sleep hungry.", 3.2, 5)], "talks to the camera")),
      F("h-spare.mov", cam(true, [P("Follow our three core principles of,", 1, 3)], "talks to the camera")),
      F("vo.m4a", sound([P("If you're not happy with the way you look, here is the truth.", 1, 4), P("You do not need to cut carbs.", 4.5, 6), P("Click the link below.", 8, 9.5)])),
    ];
    const shoot = { id: "shoot-2", title: "A shoot", created: "2026-11-20T00:00:00Z", script: SCRIPT2, folder: null, files, choices: {} };
    const save = () => writeFileSync(join(gym, "footage", "shoot-2", "shoot.json"), JSON.stringify(shoot)); save();
    for (const x of files) writeFileSync(join(gym, "footage", "shoot-2", x.key), "x");          // (the files exist only so that a sync keeps them)
    const keep = (sh) => { sh.files = files; return sh; };
    assert.deepEqual(footagePool(shoot).map((c) => c.key), ["a-scan.mov", "b-kb1.mov", "c-kb2.mov", "d-bike.mov", "e-plank.mov"], "the scan and the bike have chatter in them and are footage all the same; a spare take to camera never is");
    // Words heard behind a footage clip are no take while a real take exists.
    let s = buildSheet(shoot); const five = s.lines.find((r) => r.n === 5).parts[0];
    assert.deepEqual([five.takes.map((t) => [t.file, !!t.off_camera]), five.takes[five.pick].file], [[["c-kb2.mov", true], ["g-talk2.mov", false]], "g-talk2.mov"]);
    // Before the notes are matched: the voice-over lines take the footage in file order, a line said to camera shows her, and the sheet says there is something to match.
    assert.deepEqual([s.to_match, s.groups.map((g) => [g.id, g.matched, g.to_match]), s.lines.map((r) => [r.n, r.show, r.pictures || null])], [2, [["g1", false, true], ["g2", false, true]], [[1, "footage", ["a-scan.mov", "b-kb1.mov", "c-kb2.mov"]], [2, "footage", ["d-bike.mov"]], [3, "take", null], [4, "take", null], [5, "take", null], [6, "footage", ["e-plank.mov"]]]]);
    assert.deepEqual([s.lines[3].cover, s.lines[3].no_footage, s.lines[2].cover], [true, true, false]);
    // The matching: one text call; the model may name a clip under several things, the code shares them out.
    const asked = [];
    const ask = async (img, prompt, schema) => { asked.push(prompt); assert.equal(img, null); assert.ok(schema.properties.groups); return { groups: [
      { group: "G1", items: [{ item: 1, clips: ["C1"] }, { item: 2, clips: ["C2", "C3", "C4", "C5"] }, { item: 3, clips: [] }] },
      { group: "g2", items: [{ item: 1, clips: ["C2", "C3", "C4", "C5"] }, { item: 2, clips: ["C4"] }, { item: 3, clips: ["C5", "C9", "f-talk1.mov"] }] }] }; };
    const real = { ...shoot }; // matchFootage reads the shoot from disk and syncs its files: give it one whose files are on disk
    const onDisk = JSON.parse(JSON.stringify(shoot)); onDisk.files = files.map((x) => ({ ...x, path: join(gym, "footage", "shoot-2", x.key) }));
    mkdirSync(join(gym, "footage", "shoot-2", "files"), { recursive: true }); for (const x of onDisk.files) { x.path = join(gym, "footage", "shoot-2", "files", x.key); writeFileSync(x.path, "x"); }
    const { statSync } = await import("node:fs"); for (const x of onDisk.files) { const st = statSync(x.path); x.bytes = st.size; x.mtime = Math.round(st.mtimeMs); x.source = "dropped"; }
    writeFileSync(join(gym, "footage", "shoot-2", "shoot.json"), JSON.stringify(onDisk));
    let m = await matchFootage({ gymDir: gym, id: "shoot-2", ask });
    assert.equal(m.calls, 1); assert.equal(asked.length, 1);
    assert.match(asked[0], /G1:\n  1\. Measuring Inbody\n  2\. Working Out\n  3\. Eating Healthy\/Food\nG2:\n  1\. Working out\n  2\. doing spin\n  3\. Resting \+ Recovery \(plank at home\)/);
    assert.match(asked[0], /C1 \(12 s\): stands on a smart scale holding handles\nC2 \(12 s\): kettlebell deadlifts/); assert.match(asked[0], /A thing no clip shows gets no clip: never stretch a clip to fit/);
    assert.ok(!/talks to the camera/.test(asked[0]), "a take to camera is never offered as footage");
    assert.deepEqual(Object.fromEntries(Object.entries(m.groups).map(([g, items]) => [g, items.map((x) => [x.item, x.clips])])), {
      g1: [["Measuring Inbody", ["a-scan.mov"]], ["Working Out", ["b-kb1.mov"]], ["Eating Healthy/Food", []]],
      g2: [["Working out", ["c-kb2.mov"]], ["doing spin", ["d-bike.mov"]], ["Resting + Recovery (plank at home)", ["e-plank.mov"]]] }, "the narrow asks pick first; the wide one in two notes gets some in each; a clip that is not footage is ignored");
    assert.deepEqual((await matchFootage({ gymDir: gym, id: "shoot-2", ask: async () => { throw new Error("not asked twice"); } })).calls, 0, "matched once: not asked again while the notes and the clips are the same");
    const now = readShoot(gym, "shoot-2"); s = buildSheet(now);
    assert.deepEqual([s.to_match, s.groups.map((g) => [g.id, g.matched, g.missing])], [0, [["g1", true, ["Eating Healthy/Food"]], ["g2", true, []]]]);
    assert.deepEqual(s.lines.map((r) => [r.n, r.show, r.pictures || null, r.pictures_by || null]), [[1, "footage", ["a-scan.mov"], "notes"], [2, "footage", ["b-kb1.mov"], "notes"], [3, "take", null, null], [4, "footage", ["c-kb2.mov", "d-bike.mov"], "notes"], [5, "footage", ["e-plank.mov"], "notes"], [6, "footage", ["a-scan.mov"], "rule"]], "the note's clips in the order it lists them, over the lines it covers — said to camera or not");
    assert.match(sheetText(now), /B-roll over lines 1, 2 — Measuring Inbody: a-scan\.mov · Working Out: b-kb1\.mov · Eating Healthy\/Food: NO FOOTAGE OF THIS/);
    // The switch: a line said to camera can show her instead; his own clips stand over the note's.
    s = decideSheet(gym, "shoot-2", { line: 4, show: "take" });
    assert.deepEqual([s.lines[3].show, s.lines[3].pictures || null, s.lines[4].pictures], ["take", null, ["c-kb2.mov", "d-bike.mov", "e-plank.mov"]], "her face for that line; the note's clips go to the line that still shows footage");
    s = decideSheet(gym, "shoot-2", { line: 4, show: "footage" }); assert.equal(s.lines[3].show, "footage");
    s = decideSheet(gym, "shoot-2", { line: 5, pictures: ["a-scan.mov"] });
    assert.deepEqual([s.lines[4].pictures, s.lines[4].pictures_by, s.lines[0].pictures], [["a-scan.mov"], "you", ["b-kb1.mov"]], "a clip he put somewhere is not handed out again by the notes");
    assert.throws(() => decideSheet(gym, "shoot-2", { line: 4, show: "her" }), /a line shows the take or the footage/);
    // A changed note makes the matching stale; nothing to match is said in words.
    const k = footageKey(now); now.script = SCRIPT2.replace("doing spin", "the bikes"); assert.notEqual(footageKey(now), k); assert.equal(buildSheet(now).to_match, 2);
    await assert.rejects(matchFootage({ gymDir: gym, id: "shoot-2", ask, force: true }).then(() => { const x = readShoot(gym, "shoot-2"); x.script = "No notes here at all, only this line to say."; writeFileSync(join(gym, "footage", "shoot-2", "shoot.json"), JSON.stringify(x)); return matchFootage({ gymDir: gym, id: "shoot-2", ask }); }), /the script asks for no footage by name/);
    assert.deepEqual(shareClips([{ fits: ["a", "b", "c"], clips: [] }, { fits: ["b"], clips: [] }, { fits: [], clips: [] }]).map((x) => x.clips), [["a", "c"], ["b"], []]);
    assert.match(buildFootagePrompt([{ id: "g1", items: ["the gym"] }], [{ key: "m.mp4", seconds: 44, kind: "montage", shows: "members rowing" }]), /C1 \(44 s, an edited video with music\): members rowing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
