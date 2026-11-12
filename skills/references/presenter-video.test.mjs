// presenter-video.test.mjs — a presenter talking to camera (PV1–PV4). No model call: the still, the clip and the
// watching pass are fakes; the cut and the words are real (ffmpeg and headless Chrome), so the finished file is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { presenterOf, presenterWords, presenterProblems, PRESENTER_GENDERS, scriptProblems, addScript, decideScript, readScripts, keptScripts, scriptCost, buildScriptPrompt, draftScripts, sameWords, fillLine, clipSeconds, captions, captionChunks, speechFrom, speechOf, LEAD, TAIL, lockWords, stillPrompt, clipPrompt, makePresenterVideos, durationOf, hasFfmpeg, SCRIPTS_FILE, LINES, LINE_WORDS, CLIP_SECONDS, END_CARD_SECONDS, FIRST_PERSON, LIVE, USD_PER_SECOND } from "./presenter-video.mjs";
import { PROFILE_STARTER, validateProfile } from "./client-config.mjs";

const OFFER = "12 Week Full Body Transformation";
const GOOD = [
  "People in {AREA}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.",
  "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and a plan that fits your week.",
  "You train in small groups, with people just like you. Tap below to find out more.",
];
const S = (line, area) => clipSeconds(fillLine(line, area)), S1 = S(GOOD[0], "BISHAN"), S1B = S(GOOD[0], "ANG MO KIO"), S2 = S(GOOD[1], ""), S3 = S(GOOD[2], "");
const QUIET_START = 0.8, QUIET_END = 1.5, KEPT = (seconds) => seconds - QUIET_START - QUIET_END + LEAD + TAIL; // what is left of a fake clip once it is cut to its "speech"
const plain = (p) => p.split("/").pop().replace(/-[0-9a-f]{6}(?=(-take\d+)?\.(mp4|jpg)$)/, ""); // a file's name without the mark of what it is of
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
function gym({ presenter = { gender: "man", age: 36 } } = {}) {
  const d = mkdtempSync(join(tmpdir(), "pv-")), g = join(d, "brands", "testgym"); mkdirSync(join(g, "brand-assets", "facility-clean"), { recursive: true });
  const profile = { ...PROFILE_STARTER("testgym", "Test Gym", "SG") }; profile.creative_defaults = { ...(profile.creative_defaults || {}), ...(presenter ? { presenter } : {}) };
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile)); writeFileSync(join(g, "brand-assets", "facility-clean", "room.png"), PNG);
  return { d, g, profile, room: join(g, "brand-assets", "facility-clean", "room.png") };
}
/** Fake models: a still is a tiny picture; a clip is real video of the length asked for (grey, a tone), so the cut is real; the watching pass answers from `say`. */
function fakes({ say = (line) => line, people = () => 1, text = () => [], faults = () => [] } = {}) {
  const calls = { image: [], clip: [], watch: [] }, lineOf = new Map();
  return { calls, models: {
    async image({ out, prompt, refs }) { calls.image.push({ out, prompt, refs }); writeFileSync(out, PNG); },
    async clip({ out, image, prompt, seconds }) { calls.clip.push({ out, image, prompt, seconds }); lineOf.set(out, prompt.match(/pace: "([^"]+)"/)[1]);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=180x320:r=24:d=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds - QUIET_START - QUIET_END}`, "-af", `adelay=${QUIET_START * 1000}|${QUIET_START * 1000},apad=whole_dur=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", String(seconds), out]); },
    async watch(file) { const n = calls.watch.push(file), line = lineOf.get(file); return { spoken: say(line, n, file), on_screen_text: text(line, n), people: people(line, n), lips_match_speech: true, faults: faults(line, n, file), looks_real: 9 }; },
  } };
}

test("PV1 who presents, and the script's rules: the presenter is the gym's own choice (a woman or a man, an age, a look) and nothing is assumed; a script is 2 to 4 lines of one breath each, names the offer in its exact words, may stand {AREA} for the place, never speaks as the gym or a member (no I, we, our, my, us) and never breaks the copy's rules; the owner's own script is kept at once, a drafted one waits; never twice; an edit is checked again; retiring needs a reason; what a script costs is said before it is made", () => {
  const { d, g, profile } = gym({ presenter: null });
  try {
    assert.equal(presenterOf(profile), null, "not set: nothing is assumed");
    assert.deepEqual(presenterOf({ creative_defaults: { presenter: { gender: "man" } } }), { gender: "man", age: 35, look: "" });
    assert.equal(presenterWords({ gender: "man", age: 36, look: "" }, profile), "a Singaporean man of about 36, short black hair, a plain charcoal training tee and black training shorts, no jewellery, no logo or lettering on the clothes");
    assert.match(presenterWords({ gender: "woman", age: 30, look: "a Malay woman in a navy tee" }, profile), /^a Singaporean woman of about 30, a Malay woman in a navy tee, no jewellery/);
    assert.deepEqual(PRESENTER_GENDERS, ["woman", "man"]);
    assert.deepEqual([presenterProblems(null), presenterProblems({ gender: "man", age: 36, look: "tall" })], [[], []]);
    assert.deepEqual(presenterProblems({ gender: "coach", age: 12, look: 7 }), ["presenter.gender must be woman or man", "presenter.age must be a whole number from 20 to 65", "presenter.look is a few words, up to 200 characters"]);
    assert.ok(validateProfile({ ...profile, creative_defaults: { ...profile.creative_defaults, presenter: { gender: "robot" } } }).errors.some((e) => /creative_defaults\.presenter\.gender must be woman or man/.test(e)), "a profile is refused at save");
    // The rules.
    assert.deepEqual(scriptProblems(GOOD, { offer: OFFER, profile }), []);
    assert.deepEqual(scriptProblems(["One line only, and it is long enough to be a line."], { offer: OFFER, profile }), [`a script is ${LINES[0]} to ${LINES[1]} lines, one for each cut`]);
    const bad = (lines) => scriptProblems(lines, { offer: OFFER, profile }).join(" | ");
    assert.match(bad([GOOD[0], "We built the 12 Week Full Body Transformation for exactly that, with a coach beside you.", GOOD[2]]), /line 2 speaks as the gym or a member \("We"\): the presenter is nobody in particular/);
    assert.match(bad([GOOD[0], "Our coaches run it.", GOOD[2]]), /line 2 is 4 words: a line is one breath, 6 to 26 words/);
    assert.match(bad([GOOD[0], "Test Gym's twelve week plan is built for exactly that, with a coach beside you every time.", GOOD[2]]), /must name the offer in its exact words: "12 Week Full Body Transformation"/);
    assert.match(bad([GOOD[0].replace("{AREA}", "{CITY}"), GOOD[1], GOOD[2]]), /only \{AREA\} may stand in for a word \(found \{CITY\}\)/);
    assert.match(bad([GOOD[0], GOOD[1], "Start with a free trial this week and see how it feels. Tap below to find out more."]), /free/i);
    assert.match(bad([GOOD[0], GOOD[1], "People lose 5kg in the first month here, every single time. Tap below to find out more."]), /weight-loss number/);
    assert.ok(FIRST_PERSON.test("that is what our plan does") && !FIRST_PERSON.test("a tour of the gym, with music"), "whole words only");
    // Kept, drafted, never twice, edited, retired.
    const mine = addScript(g, { lines: GOOD, offer: OFFER }, { profile });
    assert.deepEqual([mine.status, mine.source, mine.offer, /^v-[0-9a-f]{10}$/.test(mine.id), mine.lines], ["kept", "owner", OFFER, true, GOOD]);
    assert.throws(() => addScript(g, { lines: GOOD.map((l) => l.toUpperCase()), offer: OFFER }, { profile }), /already here/);
    const other = [GOOD[0].replace("keep watching", "stay with this"), GOOD[1], GOOD[2]], draft = addScript(g, { lines: other, offer: OFFER, source: "drafted" }, { profile });
    assert.equal(draft.status, "draft");
    assert.deepEqual(keptScripts(g, OFFER).map((s) => s.id), [mine.id]); assert.deepEqual(keptScripts(g, "6 Week Challenge"), [], "a script is for the offer it names");
    assert.throws(() => decideScript(g, draft.id, { lines: [other[0], "We run it.", other[2]] }, { profile }), /speaks as the gym|one breath/);
    assert.equal(decideScript(g, draft.id, { status: "kept" }, { profile }).status, "kept");
    assert.throws(() => decideScript(g, draft.id, { status: "retired" }, { profile }), /needs a reason/);
    assert.deepEqual([decideScript(g, draft.id, { status: "retired", reason: "too long" }, { profile }).status, readScripts(g).scripts.length, keptScripts(g, OFFER).length], ["retired", 2, 1], "retired, never deleted");
    assert.ok(existsSync(join(g, SCRIPTS_FILE)));
    // What it costs: the line that says the area is made once a location; the others once.
    const c = scriptCost(mine, ["BISHAN", "ANG MO KIO"]);
    assert.deepEqual([S1, S2, S3], [10, 10, 7], "lines of 23, 23 and 15 words");
    assert.deepEqual([c.clips.map((x) => [x.per_area, x.seconds]), c.seconds, c.images, c.videos], [[[true, S1], [false, S2], [false, S3]], S1 * 2 + S2 + S3, 3, 2]);
    assert.equal(c.usd, Math.round(((S1 * 2 + S2 + S3) * USD_PER_SECOND + 3 * 0.15) * 100) / 100);
    assert.deepEqual([fillLine("People in {AREA}, hello", "ANG MO KIO"), fillLine("In {AREA} now", "CBD"), clipSeconds("one two three"), clipSeconds(Array(40).fill("word").join(" ")), CLIP_SECONDS, LINE_WORDS], ["People in Ang Mo Kio, hello", "In CBD now", 5, 12, [5, 12], [6, 26]]);
    assert.ok(sameWords("Test Gym’s 12-week Full Body Transformation is built for exactly that.", "Test Gym's twelve week full body transformation is built for exactly that") && !sameWords("a plan that fits your weak", "a plan that fits your week") && !sameWords("keep watching now", "keep watching"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV2 scripts drafted for the owner: one text call that is told the shape, the rules and that the speaker is nobody in particular; each draft is checked in code — a good one waits as a draft, one that speaks as the gym, one that misses the offer and a repeat are dropped with the reason", async () => {
  const { d, g, profile } = gym();
  try {
    const { prompt, schema } = buildScriptPrompt({ profile, offer: OFFER, audience: "LADIES WANTED", count: 3, existing: ["an old one"] });
    assert.match(prompt, /talking-to-camera video advert for Test Gym's programme: "12 Week Full Body Transformation"\. The advert is for: LADIES WANTED\./);
    assert.match(prompt, /written as \{AREA\}/); assert.match(prompt, /in these exact words — "Test Gym's 12 Week Full Body Transformation"/); assert.match(prompt, /never says I, we, our, my or us/);
    assert.match(prompt, /NEVER: a price or any money; free or a free trial; before and after; a guarantee/); assert.match(prompt, /Already written — do not repeat or closely rephrase:\n- an old one/);
    assert.equal(schema.properties.scripts.items.properties.lines.type, "ARRAY");
    const asked = [];
    const ask = async (img, p, s, o) => { asked.push({ img, p, model: o.model }); return { scripts: [{ lines: GOOD }, { lines: [GOOD[0], "We built the 12 Week Full Body Transformation for exactly that, with a coach beside you.", GOOD[2]] }, { lines: [GOOD[0], "The programme is built for exactly that, with a coach beside you and a plan for the week.", GOOD[2]] }, { lines: GOOD }] }; };
    const r = await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, audience: "LADIES WANTED", count: 4, ask });
    assert.deepEqual([asked.length, asked[0].img, r.calls, r.added.length, r.added[0].status, r.added[0].source], [1, null, 1, 1, "draft", "drafted"]);
    assert.deepEqual(r.dropped.map((x) => x.reason.slice(0, 36)), ["line 2 speaks as the gym or a member", "the script must name the offer in it", "this script is already here"]);
    assert.deepEqual(keptScripts(g, OFFER), [], "a draft is not made into a video until the owner keeps it");
    await assert.rejects(draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: "", ask }), /exact words are needed/); await assert.rejects(draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 9, ask }), /count must be 1 to 6/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV3 one script, a video for each location: a still for each line (the first from the room, the rest from the first, so it is one person), a clip for each line — the line that says the area once a location, the others once and shared — each watched: a clip that says other words is made again; the cut is real — each clip cut to its speech so no dead air sits before a cut, the captions timed to the voice, a plain card at the end, every word on screen is set by software inside Meta's live area, and what was spent is counted", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { d, g, profile, room } = gym();
  try {
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), out = join(g, "outputs", "b1", "videos");
    // The first take of line 2 says something else; its second take is right. Line 3's only fault is seen on both of its takes.
    let l2 = 0; const F = fakes({ say: (line) => (/built for exactly that/.test(line) && ++l2 === 1 ? "Test Gym's 12 week programme is built for that." : line), faults: (line, n, file) => (/small groups/.test(line) ? (/take2/.test(file) ? ["a stiff hand"] : ["warped fingers", "a stiff hand"]) : []) });
    const logged = [], prog = [], log = { push: (m) => logged.push(m.replace(/-[0-9a-f]{6}(?=(-take\d+)?\.mp4)/, "")), some: (fn) => logged.some(fn), join: (x) => logged.join(x) };
    const R = await makePresenterVideos({ gymDir: g, outDir: out, script, areas: ["BISHAN", "ANG MO KIO"], offer: OFFER, audience: "LADIES WANTED", room, profile, caps: { seconds: 80, images: 5 }, takes: 2, models: F.models, log: (m) => log.push(m), onProgress: (p) => prog.push(p) });
    // Stills: three, the first from the room alone, the others from the first still and the room.
    assert.deepEqual(F.calls.image.map((c) => c.refs.map(plain)), [["room.png"], ["still-1.jpg", "room.png"], ["still-1.jpg", "room.png"]]);
    assert.ok(F.calls.image.every((c) => /^still-\d-[0-9a-f]{6}\.jpg$/.test(c.out.split("/").pop())), "a still is named for what it is of: another presenter or another room is another file");
    assert.match(F.calls.image[0].prompt, /^A real photograph taken on a phone held upright, 9:16\. He is a Singaporean man of about 36, .* standing beside the dumbbell rack\./); assert.match(F.calls.image[1].prompt, /The person is the SAME person as in the first image/);
    assert.ok(F.calls.image.every((c) => /There is no text of any kind anywhere in the picture/.test(c.prompt) && /nobody in that image appears/.test(c.prompt)));
    // Clips: line 1 once a location; line 2 twice (other words, made again); line 3 twice (a noted fault, made once more); the shared lines are never made again for the second location.
    assert.deepEqual(F.calls.clip.map((c) => [plain(c.out), c.seconds, plain(c.image)]), [["line-1-bishan.mp4", S1, "still-1.jpg"], ["line-2.mp4", S2, "still-2.jpg"], ["line-2-take2.mp4", S2, "still-2.jpg"], ["line-3.mp4", S3, "still-3.jpg"], ["line-3-take2.mp4", S3, "still-3.jpg"], ["line-1-ang-mo-kio.mp4", S1B, "still-1.jpg"]]);
    assert.match(F.calls.image[1].prompt, /a different part of the room from the first image.*a step closer, framed from the chest up/); assert.match(F.calls.image[2].prompt, /a few steps back, framed from the thighs up/);
    assert.match(F.calls.clip[0].prompt, /says, in a warm, natural Singaporean English voice, at an easy conversational pace: "People in Bishan, this one is for you\./); assert.match(F.calls.clip[5].prompt, /"People in Ang Mo Kio, this one is for you\./);
    assert.ok(F.calls.clip.every((c) => /Exactly one person is in the room for the whole clip/.test(c.prompt) && /His mouth forms exactly these words/.test(c.prompt)));
    assert.deepEqual(R.spent, { seconds: S1 + S2 + S2 + S3 + S3 + S1B, images: 3, checks: 6 });
    assert.ok(log.some((l) => /line-3\.mp4: said as written, one person, no lettering · noted: warped fingers; a stiff hand — made once more/.test(l)), log.join("\n"));
    assert.ok(log.some((l) => /line-2\.mp4: it said "Test Gym's 12 week programme is built for that\."/.test(l)) && log.some((l) => /line-2-take2\.mp4: said as written, one person, no lettering/.test(l)), log.join("\n"));
    // Two finished videos, each its own first line and the shared others.
    assert.deepEqual(R.videos.map((v) => [v.area, v.failed, v.file.split("/").pop(), v.lines.map((l) => plain(l.file)), v.lines[1].takes]), [
      ["BISHAN", undefined, `${script.id}-bishan.mp4`, ["line-1-bishan.mp4", "line-2-take2.mp4", "line-3-take2.mp4"], 2], ["ANG MO KIO", undefined, `${script.id}-ang-mo-kio.mp4`, ["line-1-ang-mo-kio.mp4", "line-2-take2.mp4", "line-3-take2.mp4"], 2]]);
    assert.deepEqual(R.videos[0].words, [GOOD[0].replace("{AREA}", "Bishan"), GOOD[1], GOOD[2]]); assert.deepEqual(R.videos[0].notes, ["a stiff hand"], "the cleaner take is kept; what is still noticed is kept for the owner, and is no refusal");
    for (const v of R.videos) {
      assert.ok(existsSync(v.file) && existsSync(v.poster));
      // Each clip is cut to its speech (a breath either side), so the silence the model leaves at both ends is gone: no dead air before a cut.
      assert.ok(Math.abs(durationOf(v.file) - (KEPT(v.area === "BISHAN" ? S1 : S1B) + KEPT(S2) + KEPT(S3) + END_CARD_SECONDS)) < 0.5, `the three spoken parts and the end card: ${durationOf(v.file)}`);
      assert.deepEqual(v.lines.map((l) => [l.speech.start, Math.round(l.speech.kept[0] * 100) / 100]), v.lines.map(() => [QUIET_START, Math.round((QUIET_START - LEAD) * 100) / 100]), "where the speech starts, and where the clip is cut"); assert.equal(v.seconds, Math.round(durationOf(v.file) * 10) / 10);
      assert.equal(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", v.file]).toString().trim(), "h264,720,1280");
      assert.ok(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", v.file]).toString().trim() === "aac", "it has sound");
    }
    // The words on screen are software's: captions a few words at a time, the end card from the brief's own words.
    // Captions follow the voice: a few words at a time, never across a clause's end, timed over the SPOKEN time, and changing at the pause where a clause ends.
    assert.deepEqual(captionChunks("One two three four, five six. Seven.").map((c) => [c.text, c.ends]), [["One two three", false], ["four", true], ["five six", true], ["Seven", true]]);
    assert.deepEqual(captions("One two three. Four five.", [[0.5, 2.5], [3.5, 4.5]]), [{ text: "One two three", from: 0.5, to: 2.5 }, { text: "Four five", from: 3.5, to: 4.5 }], "the second caption waits for the second sentence to be spoken");
    const real = captions("If you live or work in Bishan and you have been meaning to get stronger, this one is for you. Keep watching.", [[0.49, 4.1], [4.7, 5.49], [6.33, 6.8]]);
    assert.deepEqual([real.map((c) => c.text), real[0].from, real[4].to, real[5].from, real[6].to, real[7].from, real[7].to], [["If you live", "or work in", "Bishan and you", "have been meaning", "to get stronger", "this one is", "for you", "Keep watching"], 0.49, 4.1, 4.7, 5.49, 6.33, 6.8], "the first real video's own first line: each clause on screen while it is said");
    assert.ok(real.every((c, i) => c.to > c.from && (i === 0 || c.from >= real[i - 1].to)), "in order, never overlapping");
    assert.deepEqual(captions("no pause at all in this one line", [[0, 4]]).map((c) => [c.from, c.to]).flat().slice(0, 2), [0, 1.45]);
    // Where the speech is, from the sound: silences at both ends and a pause inside; a click shorter than a quarter second is no speech; no silence found is the whole clip.
    assert.deepEqual(speechFrom("silence_start: 0\nsilence_end: 0.86\nsilence_start: 5.1\nsilence_end: 5.8\nsilence_start: 8.55\nsilence_end: 9.88", 10.03), { start: 0.86, end: 8.55, spans: [[0.86, 5.1], [5.8, 8.55]], duration: 10.03 });
    assert.deepEqual([speechFrom("", 6).spans, speechFrom("silence_start: 0\nsilence_end: 6", 6).spans], [[[0, 6]], [[0, 6]]]);
    const heard = speechOf(R.videos[0].lines[0].file); assert.ok(Math.abs(heard.start - QUIET_START) < 0.06 && Math.abs(heard.end - (S1 - QUIET_END)) < 0.06, JSON.stringify(heard));
    assert.deepEqual(lockWords({ offer: OFFER, location: "BISHAN", audience: "LADIES WANTED" }), { audience: "LADIES WANTED", location: "BISHAN", duration: "12 WEEK", rest: "FULL BODY TRANSFORMATION" });
    assert.ok(existsSync(join(out, script.id, "lock-bishan.png")) && existsSync(join(out, script.id, "cap-bishan-1-00.png")));
    assert.deepEqual(LIVE, { left: 0.06, right: 0.94, top: 0.14, bottom: 0.65 });
    // Run again: everything is on disk, so nothing is made and nothing is spent.
    const F2 = fakes(), again = await makePresenterVideos({ gymDir: g, outDir: out, script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 80, images: 5 }, models: F2.models });
    assert.deepEqual([F2.calls.image.length, F2.calls.clip.length, F2.calls.watch.length, again.spent, again.videos[0].failed], [0, 0, 0, { seconds: 0, images: 0, checks: 0 }, undefined]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV4 what is refused, and why: nothing is made until the gym says who presents; a script that breaks the rules, no location, no photo of the room; a line that never comes out as written, a second person in the clip and lettering in the picture each refuse that video with the reason — the other locations still get theirs; a call that would pass the cap is never made", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { d, g, profile, room } = gym();
  try {
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), base = { gymDir: g, script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 80, images: 5 }, takes: 2 };
    const none = fakes();
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), profile: { ...profile, creative_defaults: {} }, models: none.models }), /say who presents first \(Ad defaults → Presenter\)/);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), script: { ...script, lines: [GOOD[0], "We run it here.", GOOD[2]] }, models: none.models }), /this script cannot be made: /);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), areas: [], models: none.models }), /needs a location/);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), room: join(g, "nope.png"), models: none.models }), /a photo of the gym's room is needed/);
    assert.deepEqual([none.calls.image.length, none.calls.clip.length], [0, 0], "refused before any call");
    // A line that never comes out as written: both takes are spent, the video is refused with what was said.
    const A = fakes({ say: (line) => (/small groups/.test(line) ? "You train in small groups. Tap below." : line) });
    let r = await makePresenterVideos({ ...base, outDir: join(g, "o1"), models: A.models });
    assert.equal(r.videos[0].failed, 'line 3 did not pass after 2 takes: it said "You train in small groups. Tap below."'); assert.equal(r.videos[0].file, undefined); assert.equal(A.calls.clip.length, 4);
    // A fault on the only take the cap allows: the take stands (a fault is a note), and nothing beyond the cap is asked for.
    const Ft = fakes({ faults: (line) => (/small groups/.test(line) ? ["warped fingers"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o1b"), caps: { seconds: S1 + S2 + S3, images: 5 }, models: Ft.models });
    assert.deepEqual([r.videos[0].failed, r.videos[0].notes, Ft.calls.clip.length, r.spent.seconds, r.videos[0].lines[2].takes], [undefined, ["warped fingers"], 3, S1 + S2 + S3, 1]);
    // A second person in the area's own line: that location is refused, the other is made.
    const B = fakes({ people: (line) => (/Bishan/.test(line) ? 2 : 1) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o2"), areas: ["BISHAN", "KATONG"], models: B.models });
    assert.deepEqual(r.videos.map((v) => [v.area, v.failed || "made"]), [["BISHAN", "line 1 did not pass after 2 takes: 2 people are in it"], ["KATONG", "made"]]);
    // Lettering in the picture.
    const C = fakes({ text: (line) => (/built for exactly/.test(line) ? ["GYM"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3"), models: C.models });
    assert.equal(r.videos[0].failed, "line 2 did not pass after 2 takes: words appear in the picture: GYM");
    // The cap: 20 seconds covers lines 1 and 2; line 3's clip is never asked for.
    const D = fakes();
    r = await makePresenterVideos({ ...base, outDir: join(g, "o4"), caps: { seconds: 20, images: 5 }, models: D.models });
    assert.deepEqual([r.videos[0].failed, D.calls.clip.length, r.spent.seconds], ["line 3 did not pass after 0 takes: the cap of 20 seconds of video was reached", 2, S1 + S2]);
    const E = fakes();
    r = await makePresenterVideos({ ...base, outDir: join(g, "o5"), caps: { seconds: 80, images: 2 }, models: E.models });
    assert.deepEqual([r.videos[0].failed, E.calls.image.length, E.calls.clip.length], ["the cap of 2 image calls was reached before the presenter's stills were made", 2, 0]);
    // The prompts never ask for words in the picture, and say who speaks.
    assert.match(stillPrompt({ presenter: { gender: "woman", age: 30, look: "" }, profile, spot: "next to a bench", first: true }), /^A real photograph taken on a phone held upright, 9:16\. She is a Singaporean woman of about 30/);
    assert.match(clipPrompt({ presenter: { gender: "woman", age: 30, look: "" }, profile, line: "Hello there.", seconds: 6 }), /^Bring this photograph to life as 6 seconds of video\. The woman keeps looking into the camera and says, .*: "Hello there\." Her mouth forms exactly these words/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV5 benefits, not features, and the owner's own samples (2026-11-12): the drafter is told to speak about what changes for the person and to say nothing about how the gym runs (a wrong feature is a false claim: \"small groups\" in a personal-training gym), and is shown the scripts the owner says have worked — to follow how they are built, never to copy; a sample is kept as pasted, never twice, retired with a reason; a batch picks that many kept scripts for its offer in an order its seed fixes, and too few is refused by name", async () => {
  const { addSample, decideSample, liveSamples, readSamples, pickScripts, videosProblems, videoCount, MAX_VIDEOS, SAMPLE_LIMIT } = await import("./presenter-video.mjs");
  const { d, g, profile } = gym(), L = join(d, "lib");
  try {
    // The prompt.
    const { prompt } = buildScriptPrompt({ profile, offer: OFFER, count: 3, facts: ["Every session is one to one with a coach"], samples: ["Hey Katong.\nTired of starting over?\nTap below."] });
    assert.match(prompt, /Speak about BENEFITS, never features\. A benefit is what changes for the person/); assert.match(prompt, /nothing about how training is organised \(no small groups, classes, one-to-one, personal training, session length, timetable, equipment, class size\), because a wrong one is a false claim about this gym/);
    assert.match(prompt, /The only facts about the gym or the programme that may be stated are these, in the owner's words: "Every session is one to one with a coach"\. Say them as given, and nothing else about how the programme works\./); assert.match(prompt, /A benefit is what the programme is built to help with, never a promised result\./);
    assert.match(prompt, /These scripts have worked for this owner\. Follow how they are built, how they sound and what they choose to talk about — never copy a sentence, and never carry over a fact[^\n]*\n--- SAMPLE 1\nHey Katong\.\nTired of starting over\?\nTap below\./);
    // The owner's samples mark what changes from gym to gym in braces (2026-11-12: "area and challenge name, as well as gym name must be custom"): the drafter is told what each becomes for this gym.
    assert.match(prompt, new RegExp(`where it marks the place, write \\{AREA\\}; where it marks the programme, write its exact words, "${OFFER}"; where it marks the gym, or where the sample says we or our, write "${profile.display_name}"\\. No other braces may appear in a script:`));
    assert.ok(!/SAMPLE 1/.test(buildScriptPrompt({ profile, offer: OFFER }).prompt) && !/The only facts about the gym/.test(buildScriptPrompt({ profile, offer: OFFER }).prompt), "no samples and no facts: neither is mentioned");
    // Samples.
    assert.throws(() => addSample(L, "too short"), new RegExp(`a sample script is ${SAMPLE_LIMIT[0]} to ${SAMPLE_LIMIT[1]} characters`));
    const text = "Hey, if you live in Katong and you are tired of starting over every January, listen up.\n\n\n\nThis is about feeling strong in your own body again.";
    const s1 = addSample(L, text, { note: "the best one" });
    assert.deepEqual([/^vs-[0-9a-f]{10}$/.test(s1.id), s1.text, s1.note], [true, text.replace(/\n{3,}/, "\n\n"), "the best one"], "kept as pasted: its line breaks stay, a wall of blank lines does not");
    assert.throws(() => addSample(L, text.toUpperCase()), /already here/);
    assert.throws(() => decideSample(L, s1.id, { retired: true }), /needs a reason/);
    // The drafter is shown the live samples, and no retired one.
    const seen = []; await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.match(seen[0], /--- SAMPLE 1\nHey, if you live in Katong/);
    decideSample(L, s1.id, { retired: true, reason: "an old offer" }); assert.deepEqual(liveSamples(L), []);
    await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.ok(!/SAMPLE 1/.test(seen[1])); assert.equal(readSamples(L).samples.length, 1, "retired, never deleted");
    assert.equal(decideSample(L, s1.id, { retired: false }).retired, undefined);
    // A batch's videos: how many, and which scripts.
    assert.deepEqual([videosProblems(undefined), videosProblems({ presenter: 2 }), videoCount({ presenter: 2 }), videoCount(null), MAX_VIDEOS], [[], [], 2, 0, 3]);
    assert.deepEqual(videosProblems({ presenter: 4, talking: 1 }), ['videos: "talking" is not a kind of video (presenter)', "videos.presenter must be a whole number from 0 to 3"]);
    assert.throws(() => pickScripts(g, { count: 1, offer: OFFER }), /1 presenter video asked for, but no script is kept for "12 Week Full Body Transformation": keep 1 more on Draft Scenes → Video scripts/);
    const a = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), b = addScript(g, { lines: [GOOD[0], GOOD[1], "Feel stronger and have more energy for your day. Tap below to find out more."], offer: OFFER }, { profile });
    addScript(g, { lines: [GOOD[0], GOOD[1], "Walk into your week with more energy than last month. Tap below to find out more."], offer: OFFER, source: "drafted" }, { profile });
    assert.throws(() => pickScripts(g, { count: 3, offer: OFFER }), /3 presenter videos asked for, but only 2 scripts are kept/);
    const one = pickScripts(g, { count: 1, offer: OFFER, seed: "s1" }), again = pickScripts(g, { count: 1, offer: OFFER, seed: "s1" });
    assert.deepEqual([one.length, one[0].id === again[0].id, [a.id, b.id].includes(one[0].id), pickScripts(g, { count: 2, offer: OFFER, seed: "s1" }).map((x) => x.id).sort()], [1, true, true, [a.id, b.id].sort()]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV6 the owner's template for every gym (2026-11-12: share samples across gyms; up to seven lines, shortened to what is relevant; a list of what the challenge includes that only he types; the gym's name where a gym would say we): samples are one library every gym drafts from, and one pasted under a gym before joins it once with the gym's file left as it was; a script may be two to seven lines; the facts for an offer are kept per gym, checked by the rules an ad is held to, and are the only things about the programme the drafter may state — with a sample or facts it is asked for three to seven lines, a beat without a given fact left out", async () => {
  const { addSample, liveSamples, readSamples, adoptSamples, setFacts, factsFor, factsProblems, FACT_LIMITS, LINES, SPOTS, SAMPLES_FILE } = await import("./presenter-video.mjs");
  const a = gym(), b = gym();
  const L = join(a.d, "lib");
  try {
    // One library: a sample pasted under one gym is what the other gym's drafter is shown.
    const T = "If you are in the {AREA} area, we have just launched our {CHALLENGE NAME} to help you feel healthy, strong, and confident again.\n\nHere's the catch. We're only taking on 10 people.";
    const row = addSample(L, T, { gym: "gym-a" });
    assert.deepEqual([row.from, existsSync(join(L, SAMPLES_FILE)), liveSamples(L).length], ["gym-a", true, 1]);
    const seen = []; await draftScripts({ brandDir: b.g, libraryDir: L, offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.match(seen[0], /--- SAMPLE 1\nIf you are in the \{AREA\} area, we have just launched our \{CHALLENGE NAME\}/);
    // A sample from before, in a gym's own file: it joins the library once, as it is; the gym's file is untouched.
    const legacy = join(b.g, SCRIPTS_FILE), old = { schema: 1, scripts: [], samples: [{ id: "vs-old0000001", text: "Hey Katong, tired of starting over every January? This one is about feeling strong again.", added: "2026-11-12" }, { id: row.id, text: T, added: "2026-11-12" }] };
    writeFileSync(legacy, JSON.stringify(old));
    assert.deepEqual([adoptSamples(L, [a.g, b.g]), adoptSamples(L, [a.g, b.g]), readSamples(L).samples.map((x) => [x.id, x.from]), JSON.parse(readFileSync(legacy, "utf-8")).samples.length], [1, 0, [[row.id, "gym-a"], ["vs-old0000001", "testgym"]], 2]);
    // Two to seven lines.
    const seven = [GOOD[0], GOOD[1], "The coaches start with a full body scan, so the plan is built on what is really there.", "Then the food side is sorted, with recipes, shopping lists and a guide for eating out.", "Only ten places are open, so every person gets real attention from a coach.", "If feeling strong and confident again is what you want, now is the time.", "Tap below to see if this is a fit for you."];
    assert.deepEqual([LINES, scriptProblems(seven, { offer: OFFER, profile: a.profile }), scriptProblems([...seven, "One line more than a script may have, to be refused."], { offer: OFFER, profile: a.profile }), SPOTS.length >= 7], [[2, 7], [], ["a script is 2 to 7 lines, one for each cut"], true]);
    assert.equal(addScript(a.g, { lines: seven, offer: OFFER }, { profile: a.profile }).lines.length, 7);
    assert.deepEqual([scriptCost({ lines: seven }, ["BISHAN"]).images, scriptCost({ lines: seven }, ["BISHAN"]).seconds > 50], [7, true], "seven cuts, about a minute");
    // What the challenge includes: the owner's list, per offer, held to the rules an ad is held to.
    assert.deepEqual(factsFor(a.g, OFFER), []);
    assert.deepEqual(setFacts(a.g, OFFER, [" A full body scan assessment at the start ", "Only 10 places", "", "Only 10 places"], { profile: a.profile }), ["A full body scan assessment at the start", "Only 10 places"]);
    assert.deepEqual([factsFor(a.g, OFFER.toUpperCase()), factsFor(a.g, "6 Week Reset"), factsFor(b.g, OFFER), readScripts(a.g).scripts.length], [["A full body scan assessment at the start", "Only 10 places"], [], [], 1], "by the offer's words, case aside; this gym's alone; the scripts untouched");
    assert.throws(() => setFacts(a.g, OFFER, ["A free trial week first"], { profile: a.profile }), /fact 1: /);
    assert.throws(() => setFacts(a.g, OFFER, ["ok"], { profile: a.profile }), /fact 1 is 2 characters: 3 to 140/);
    assert.throws(() => setFacts(a.g, OFFER, Array.from({ length: FACT_LIMITS.items + 1 }, (_, i) => `Fact number ${i + 1} of the list`), { profile: a.profile }), /at most 8 facts/);
    assert.throws(() => setFacts(a.g, "", ["A full body scan"], { profile: a.profile }), /exact words are needed/);
    assert.deepEqual(factsProblems("x"), ["the facts are a list, one to a line"]);
    // The drafter: with a sample or facts, three to seven lines, the facts and nothing else, the gym's name where a gym says we.
    await draftScripts({ brandDir: a.g, libraryDir: L, offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    const P = seen[1];
    assert.match(P, /A script is 3 to 7 lines, one for each cut: as many as there is something true and worth saying, and no more — shorter is better\./);
    assert.match(P, /each fact you were given gets its own short line, said plainly; a beat that needs a fact you were NOT given \(an assessment, a number of places, how many people were helped\) is left out, never invented\. The last line tells them what to do and ends with "Tap below" and a few words/);
    assert.match(P, /may be stated are these, in the owner's words: "A full body scan assessment at the start"; "Only 10 places"\. Say them as given, and nothing else about how the programme works\./);
    assert.match(P, /where a gym would say we, the script says "Test Gym", "the coaches" or "the team"\./);
    assert.ok(!/may be stated are these/.test(seen[0]), "the other gym gave no facts, so its drafter is given none");
    // No sample and no facts: the three-line script, as it was.
    const plain = buildScriptPrompt({ profile: a.profile, offer: OFFER }).prompt;
    assert.match(plain, /A script is exactly 3 lines\./); assert.match(plain, /Line 3 says one more thing they will get from it and ends with exactly: "Tap below to find out more\."/);
    setFacts(a.g, OFFER, [], { profile: a.profile }); assert.deepEqual([factsFor(a.g, OFFER), Object.keys(readScripts(a.g).facts)], [[], []], "an empty list clears it");
  } finally { rmSync(a.d, { recursive: true, force: true }); rmSync(b.d, { recursive: true, force: true }); }
});
