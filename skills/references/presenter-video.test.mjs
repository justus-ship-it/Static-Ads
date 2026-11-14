// presenter-video.test.mjs — a presenter talking to camera (PV1–PV4). No model call: the still, the clip and the
// watching pass are fakes; the cut and the words are real (ffmpeg and headless Chrome), so the finished file is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { presenterOf, presenterWords, presenterProblems, PRESENTER_GENDERS, scriptProblems, addScript, decideScript, readScripts, keptScripts, scriptCost, buildScriptPrompt, draftScripts, sameWords, fillLine, clipSeconds, captions, captionChunks, speechFrom, speechOf, LEAD, TAIL, END_HOLD, captionWords, CAPTION_ACCENT, addPain, stillPrompt, clipPrompt, makePresenterVideos, durationOf, hasFfmpeg, SCRIPTS_FILE, LINES, LINE_WORDS, CLIP_SECONDS, FIRST_PERSON, LIVE, USD_PER_SECOND } from "./presenter-video.mjs";
import { PROFILE_STARTER, validateProfile } from "./client-config.mjs";

// The shared library (the samples and the closing line) is never the real one in a test.
process.env.VIDEO_LIBRARY_DIR = mkdtempSync(join(tmpdir(), "pv-lib-"));
const OFFER = "12 Week Full Body Transformation", PAIN = "your work clothes have been fitting tighter lately";
const GOOD = [
  "People in {AREA}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.",
  "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and a plan that fits your week.",
  "You train in small groups, with people just like you. Click the link below and we'll be in touch!",
];
const S = (line, area) => clipSeconds(fillLine(line, area)), S1 = S(GOOD[0], "BISHAN"), S1B = S(GOOD[0], "ANG MO KIO"), S2 = S(GOOD[1], ""), S3 = S(GOOD[2], "");
const QUIET_START = 0.8, QUIET_END = 1.5, KEPT = (seconds) => seconds - QUIET_START - QUIET_END + LEAD + TAIL; // what is left of a fake clip once it is cut to its "speech"
const plain = (p) => p.split("/").pop().replace(/-[0-9a-f]{6}(?=(-take\d+|-b)?\.(mp4|jpg)$)/, ""); // a file's name without the mark of what it is of ("-b": a second picture made after a refusal)
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
    assert.match(bad([GOOD[0], GOOD[1], "Start with a free trial this week and see how it feels. Click the link below and we'll be in touch!"]), /free/i);
    assert.match(bad([GOOD[0], GOOD[1], "People lose 5kg in the first month here, every single time. Click the link below and we'll be in touch!"]), /weight-loss number/);
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
    assert.deepEqual([S1, S2, S3], [10, 10, 8], "lines of 23, 23 and 19 words");
    assert.deepEqual([c.clips.map((x) => [x.per_area, x.seconds]), c.seconds, c.images, c.videos], [[[true, S1], [false, S2], [false, S3]], S1 * 2 + S2 + S3, 3, 2]);
    assert.equal(c.usd, Math.round(((S1 * 2 + S2 + S3) * USD_PER_SECOND + 3 * 0.15) * 100) / 100);
    assert.deepEqual([fillLine("People in {AREA}, hello", "ANG MO KIO"), fillLine("In {AREA} now", "CBD"), clipSeconds("one two three"), clipSeconds(Array(40).fill("word").join(" ")), CLIP_SECONDS, LINE_WORDS], ["People in Ang Mo Kio, hello", "In CBD now", 5, 15, [5, 15], [6, 26]]);
    assert.ok(sameWords("Test Gym’s 12-week Full Body Transformation is built for exactly that.", "Test Gym's twelve week full body transformation is built for exactly that") && !sameWords("a plan that fits your weak", "a plan that fits your week") && !sameWords("keep watching now", "keep watching"));
    // What a listener cannot hear is not a difference (2026-11-12: a good take of "Aether Athletics's 6 Week…" was refused twice): a possessive, the spelling of the gym's own name, where a name's spaces fall. Every other word must be the word.
    const AE = "Aether Athletics's 6 Week Full Body Transformation is designed to help you regain your daily energy and confidence.", NM = { names: ["Aether Athletics"] };
    assert.deepEqual([
      sameWords("Aether Athletics 6-week full body transformation is designed to help you regain your daily energy and confidence.", AE, NM),
      sameWords("Ether Athletics' 6-week full body transformation is designed to help you regain your daily energy and confidence.", AE, NM),
      sameWords("Ether Athletics 6-week full body transformation is designed to help you regain your daily energy and confidence.", AE),
      sameWords("Aether Athletics 6-week full body transformation is designed to help you regain your daily energy.", AE, NM),
      sameWords("F 45 Jurong West six week challenge starts now", "F45 Jurong West 6 Week Challenge starts now", { names: ["F45 Jurong West"] }),
      sameWords("the gyms plan works", "the gym's plan works"), sameWords("built for weeks", "built for week"), sameWords("a plan that fits your weak", "a plan that fits your week", NM), sameWords("every one is welcome", "everyone is welcome", NM),
    ], [true, true, false, false, true, true, false, false, false]);
    // The drafter is given the possessive a person says: "Aether Athletics' 6 Week…", never "Athletics's".
    assert.match(buildScriptPrompt({ profile: { display_name: "Aether Athletics" }, offer: "6 Week Full Body Transformation" }).prompt, /in these exact words — "Aether Athletics' 6 Week Full Body Transformation"/);
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
    const ask = async (img, p, s, o) => { asked.push({ img, p, model: o.model }); return { scripts: [{ pain: PAIN, lines: GOOD }, { pain: PAIN, lines: [GOOD[0], "We built the 12 Week Full Body Transformation for exactly that, with a coach beside you.", GOOD[2]] }, { pain: PAIN, lines: [GOOD[0], "The programme is built for exactly that, with a coach beside you and a plan for the week.", GOOD[2]] }, { pain: PAIN, lines: GOOD }] }; };
    addPain(g, OFFER, PAIN, { profile });
    const r = await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, audience: "LADIES WANTED", count: 4, ask });
    assert.deepEqual([asked.length, asked[0].img, r.calls, r.added.length, r.added[0].status, r.added[0].source, r.added[0].pain], [1, null, 1, 1, "draft", "drafted", PAIN]);
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
    const R = await makePresenterVideos({ gymDir: g, outDir: out, store: join(out, "clips"), script, areas: ["BISHAN", "ANG MO KIO"], offer: OFFER, audience: "LADIES WANTED", room, profile, caps: { seconds: 80, images: 5 }, takes: 2, models: F.models, log: (m) => log.push(m), onProgress: (p) => prog.push(p) });
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
      assert.ok(Math.abs(durationOf(v.file) - (KEPT(v.area === "BISHAN" ? S1 : S1B) + KEPT(S2) + KEPT(S3) - TAIL + END_HOLD)) < 0.3, `the three spoken parts and nothing after them — no end card (2026-11-14), the last word held a moment: ${durationOf(v.file)}`);
      assert.deepEqual(v.lines.map((l) => [l.speech.start, Math.round(l.speech.kept[0] * 100) / 100]), v.lines.map(() => [QUIET_START, Math.round((QUIET_START - LEAD) * 100) / 100]), "where the speech starts, and where the clip is cut"); assert.equal(v.seconds, Math.round(durationOf(v.file) * 10) / 10);
      assert.equal(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", v.file]).toString().trim(), "h264,720,1280");
      assert.ok(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", v.file]).toString().trim() === "aac", "it has sound");
    }
    // The words on screen are software's: captions a few words at a time, the word being said in a warm yellow.
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
    // The caption's look (2026-11-14, the owner's pick): one picture of a block for each of its words, that word lit; the block's time is shared between its words by their letters.
    assert.deepEqual(captionWords({ text: "your daily energy", from: 1, to: 2.2 }), [{ i: 0, word: "your", from: 1, to: 1.33 }, { i: 1, word: "daily", from: 1.33, to: 1.73 }, { i: 2, word: "energy", from: 1.73, to: 2.2 }]);
    assert.ok(!existsSync(join(out, script.id, "lock-bishan.png")) && ["0", "1", "2"].every((w) => existsSync(join(out, script.id, `cap-bishan-1-00-${w}.png`))), "no end card; a picture for each word of the first block");
    const frame = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", R.videos[0].file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
    let yellow = 0, white = 0; for (let i = 0; i < frame.length; i += 3) { const [r, g2, b] = [frame[i], frame[i + 1], frame[i + 2]]; if (r > 225 && g2 > 185 && g2 < 235 && b < 130) yellow++; else if (r > 235 && g2 > 235 && b > 235) white++; }
    assert.ok(CAPTION_ACCENT === "#FFD84A" && yellow > 400 && white > 400, `half a second in, one word is yellow and the others white (${yellow} yellow, ${white} white pixels)`);
    assert.deepEqual(LIVE, { left: 0.06, right: 0.94, top: 0.14, bottom: 0.65 });
    // Run again: everything is on disk, so nothing is made and nothing is spent.
    const F2 = fakes(), again = await makePresenterVideos({ gymDir: g, outDir: out, store: join(out, "clips"), script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 80, images: 5 }, models: F2.models });
    assert.deepEqual([F2.calls.image.length, F2.calls.clip.length, F2.calls.watch.length, again.spent, again.videos[0].failed], [0, 0, 0, { seconds: 0, images: 0, checks: 0 }, undefined]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV4 what is refused, and why: nothing is made until the gym says who presents; a script that breaks the rules, no location, no photo of the room; a line that never comes out as written, a second person in the clip and lettering in the picture each refuse that video with the reason — the other locations still get theirs; a call that would pass the cap is never made", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { d, g, profile, room } = gym();
  try {
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), base = { gymDir: g, script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 80, images: 5 }, takes: 2 };
    const none = fakes();
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), store: join(g, "o0", "clips"), profile: { ...profile, creative_defaults: {} }, models: none.models }), /say who presents first \(Ad defaults → Presenter\)/);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), store: join(g, "o0", "clips"), script: { ...script, lines: [GOOD[0], "We run it here.", GOOD[2]] }, models: none.models }), /this script cannot be made: /);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), store: join(g, "o0", "clips"), areas: [], models: none.models }), /needs a location/);
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o0"), store: join(g, "o0", "clips"), room: join(g, "nope.png"), models: none.models }), /a photo of the gym's room is needed/);
    assert.deepEqual([none.calls.image.length, none.calls.clip.length], [0, 0], "refused before any call");
    // A line that never comes out as written: both takes are spent, the video is refused with what was said.
    const A = fakes({ say: (line) => (/small groups/.test(line) ? "You train in small groups. Tap below." : line) });
    let r = await makePresenterVideos({ ...base, outDir: join(g, "o1"), store: join(g, "o1", "clips"), models: A.models });
    assert.equal(r.videos[0].failed, 'line 3 did not pass after 2 takes: it said "You train in small groups. Tap below."'); assert.equal(r.videos[0].file, undefined); assert.equal(A.calls.clip.length, 4);
    // A fault on the only take the cap allows: the take stands (a fault is a note), and nothing beyond the cap is asked for.
    const Ft = fakes({ faults: (line) => (/small groups/.test(line) ? ["warped fingers"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o1b"), store: join(g, "o1b", "clips"), caps: { seconds: S1 + S2 + S3, images: 5 }, models: Ft.models });
    assert.deepEqual([r.videos[0].failed, r.videos[0].notes, Ft.calls.clip.length, r.spent.seconds, r.videos[0].lines[2].takes], [undefined, ["warped fingers"], 3, S1 + S2 + S3, 1]);
    // A second person in the area's own line: that location is refused, the other is made.
    const B = fakes({ people: (line) => (/Bishan/.test(line) ? 2 : 1) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o2"), store: join(g, "o2", "clips"), areas: ["BISHAN", "KATONG"], models: B.models });
    assert.deepEqual(r.videos.map((v) => [v.area, v.failed || "made"]), [["BISHAN", "line 1 did not pass after 2 takes: 2 people are in it"], ["KATONG", "made"]]);
    // Lettering in the picture.
    const C = fakes({ text: (line) => (/built for exactly/.test(line) ? ["GYM"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3"), store: join(g, "o3", "clips"), models: C.models });
    assert.equal(r.videos[0].failed, "line 2 did not pass after 2 takes: words appear in the picture: GYM");
    // The cap: 20 seconds covers lines 1 and 2; line 3's clip is never asked for.
    const D = fakes();
    r = await makePresenterVideos({ ...base, outDir: join(g, "o4"), store: join(g, "o4", "clips"), caps: { seconds: 20, images: 5 }, models: D.models });
    assert.deepEqual([r.videos[0].failed, D.calls.clip.length, r.spent.seconds], ["line 3 did not pass after 0 takes: the cap of 20 seconds of video was reached", 2, S1 + S2]);
    const E = fakes();
    r = await makePresenterVideos({ ...base, outDir: join(g, "o5"), store: join(g, "o5", "clips"), caps: { seconds: 80, images: 2 }, models: E.models });
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
    // The drafter is shown the live samples, and no retired one. (A script opens on a pain point, so one is kept first.)
    addPain(g, OFFER, PAIN, { profile });
    const seen = []; await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.match(seen[0], /--- SAMPLE 1\nHey, if you live in Katong/);
    decideSample(L, s1.id, { retired: true, reason: "an old offer" }); assert.deepEqual(liveSamples(L), []);
    await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.ok(!/SAMPLE 1/.test(seen[1])); assert.equal(readSamples(L).samples.length, 1, "retired, never deleted");
    assert.equal(decideSample(L, s1.id, { retired: false }).retired, undefined);
    // A batch's videos: how many, and which scripts.
    assert.deepEqual([videosProblems(undefined), videosProblems({ presenter: 2 }), videoCount({ presenter: 2 }), videoCount(null), MAX_VIDEOS], [[], [], 2, 0, 3]);
    assert.deepEqual(videosProblems({ presenter: 4, talking: 1 }), ['videos: "talking" is not a kind of video (presenter)', "videos.presenter must be a whole number from 0 to 3"]);
    // No script for the offer: the refusal says which case it is and what to press (2026-11-12: a sample on the screen was taken for a script).
    const { noScriptWhy } = await import("./presenter-video.mjs");
    assert.throws(() => pickScripts(g, { count: 1, offer: OFFER, libraryDir: L }), /1 presenter video asked for, but no script is kept for "12 Week Full Body Transformation": keep 1 more on Draft Scenes → Video scripts \(nothing is written for this offer yet\. The sample script there is a template, not a script to film: press Draft scripts…, read the drafts and keep one\)$/);
    assert.deepEqual([noScriptWhy(g, OFFER, { libraryDir: L }).state, noScriptWhy(g, OFFER, { libraryDir: join(d, "empty-lib") }).state, noScriptWhy(g, OFFER, { libraryDir: join(d, "empty-lib") }).text], ["sample_only", "none", "nothing is written for this offer yet: press Draft scripts… there, or write your own"]);
    const a = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), b = addScript(g, { lines: [GOOD[0], GOOD[1], "Feel stronger and have more energy for your day. Click the link below and we'll be in touch!"], offer: OFFER }, { profile });
    addScript(g, { lines: [GOOD[0], GOOD[1], "Walk into your week with more energy than last month. Click the link below and we'll be in touch!"], offer: OFFER, source: "drafted" }, { profile });
    assert.throws(() => pickScripts(g, { count: 3, offer: OFFER, libraryDir: L }), /3 presenter videos asked for, but only 2 scripts are kept for "12 Week Full Body Transformation": keep 1 more on Draft Scenes → Video scripts$/);
    // Scripts kept for other words, and a draft waiting for these.
    assert.deepEqual([noScriptWhy(g, "6 Week Reset", { libraryDir: L }).state, noScriptWhy(g, "6 Week Reset", { libraryDir: L }).text], ["other_offer", `the scripts kept there are for "${OFFER}": a script is written for one offer's exact words, so press Draft scripts… there for this one`]);
    addScript(g, { lines: [GOOD[0], "Test Gym's 6 Week Reset is built for exactly that, with a coach beside you every week.", GOOD[2]], offer: "6 Week Reset", source: "drafted" }, { profile });
    assert.deepEqual([noScriptWhy(g, "6 week reset", { libraryDir: L }).state, noScriptWhy(g, "6 Week Reset", { libraryDir: L }).text], ["drafts", "1 draft for this offer is waiting there: read it and press Keep"]);
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
    addPain(a.g, OFFER, PAIN, { profile: a.profile }); addPain(b.g, OFFER, PAIN, { profile: b.profile });
    const seen = []; await draftScripts({ brandDir: b.g, libraryDir: L, offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.match(seen[0], /--- SAMPLE 1\nIf you are in the \{AREA\} area, we have just launched our \{CHALLENGE NAME\}/);
    // A sample from before, in a gym's own file: it joins the library once, as it is; the gym's file is untouched.
    const legacy = join(b.g, SCRIPTS_FILE), old = { schema: 1, scripts: [], samples: [{ id: "vs-old0000001", text: "Hey Katong, tired of starting over every January? This one is about feeling strong again.", added: "2026-11-12" }, { id: row.id, text: T, added: "2026-11-12" }] };
    writeFileSync(legacy, JSON.stringify(old));
    assert.deepEqual([adoptSamples(L, [a.g, b.g]), adoptSamples(L, [a.g, b.g]), readSamples(L).samples.map((x) => [x.id, x.from]), JSON.parse(readFileSync(legacy, "utf-8")).samples.length], [1, 0, [[row.id, "gym-a"], ["vs-old0000001", "testgym"]], 2]);
    // Two to seven lines.
    const seven = [GOOD[0], GOOD[1], "The coaches start with a full body scan, so the plan is built on what is really there.", "Then the food side is sorted, with recipes, shopping lists and a guide for eating out.", "Only ten places are open, so every person gets real attention from a coach.", "If feeling strong and confident again is what you want, now is the time.", "If that sounds like you, click the link below and we'll be in touch!"];
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
    assert.match(P, /each fact you were given gets its own short line, said plainly; a beat that needs a fact you were NOT given \(an assessment, a number of places, how many people were helped\) is left out, never invented\. The last line ends with exactly this sentence, word for word; it is the ONLY call to action in the script: "Click the link below and we'll be in touch!"/);
    assert.match(P, /may be stated are these, in the owner's words: "A full body scan assessment at the start"; "Only 10 places"\. Say them as given, and nothing else about how the programme works\./);
    assert.match(P, /where a gym would say we, the script says "Test Gym", "the coaches" or "the team"\./);
    assert.ok(!/may be stated are these/.test(seen[0]), "the other gym gave no facts, so its drafter is given none");
    // No sample and no facts: the three-line script, as it was.
    const plain = buildScriptPrompt({ profile: a.profile, offer: OFFER }).prompt;
    assert.match(plain, /A script is exactly 3 lines\./); assert.match(plain, /Line 3 says, in a few words, one more thing they will get from it, and then closes\. The last line ends with exactly this sentence, word for word; it is the ONLY call to action in the script: "Click the link below and we'll be in touch!"/);
    setFacts(a.g, OFFER, [], { profile: a.profile }); assert.deepEqual([factsFor(a.g, OFFER), Object.keys(readScripts(a.g).facts)], [[], []], "an empty list clears it");
  } finally { rmSync(a.d, { recursive: true, force: true }); rmSync(b.d, { recursive: true, force: true }); }
});

test("PV7 a script opens on a pain point and ends on one closing line, and the place is never the whole country (2026-11-14, the owner on the first video from the panel: \"'Keep putting off getting back into shape' … is not a pain point\", \"Don't say 'tap below'. CTA is always 'click the link below and we'll be in touch!'\", \"We can't say the full of Singapore no matter what\"): the closing line is one sentence for every gym, the last words of every script and the one place it says we; 'tap below' and the country's name are refused; a script kept before the rule needs one edit and is not filmed until then; pain points are the owner's per offer — typed and kept at once, or suggested from the gym's best adverts and the library and kept by him, never a judgement of the person; the agent proposes — with none kept it works them out itself from the gym's best adverts and the library — and every draft says the one it opens on", async () => {
  const { CLOSING_LINE, closingLine, closingProblems, setClosing, endsWithClosing, scriptIssues, readyScripts, noScriptWhy, pickScripts, painProblems, decidePain, painsFor, readPains, painSources, buildPainsPrompt, suggestPains, PAIN_LIMITS } = await import("./presenter-video.mjs");
  const { isWholeCountry } = await import("./render-composites.mjs");
  const { d, g, profile, room } = gym(), L = join(d, "lib"), C = CLOSING_LINE;
  try {
    // The closing line.
    assert.deepEqual([C, closingLine(L), closingProblems(C)], ["Click the link below and we'll be in touch!", C, []]);
    assert.deepEqual(["Click the link below and we'll be in touch!", "If that sounds like you, click the link below and we’ll be in touch.", "click the link below, and we'll be in touch", "Click the link below and we will be in touch!", "Click the link below and we'll be in touch today!", "Unclick the link below and we'll be in touch!"].map((l) => endsWithClosing(l, C)), [true, true, true, false, false, false], "word for word; case, spacing and punctuation aside");
    const probs = (lines) => scriptProblems(lines, { offer: OFFER, profile, closing: C });
    assert.deepEqual(probs(GOOD), []);
    assert.deepEqual(probs([GOOD[0], GOOD[1], "You train in small groups, with people just like you. Tap below to see if this fits."]), ['line 3 says "Tap below": the only call to action is the closing line', `the last line ends with the closing line, word for word: "${C}"`]);
    assert.deepEqual(probs([GOOD[0], GOOD[1], "We will look after you from the first day. Click the link below and we'll be in touch!"]), ['line 3 speaks as the gym or a member ("We"): the presenter is nobody in particular, so no I, we, our, my or us'], "the closing line is the one place a script says we");
    assert.deepEqual(probs(["If you live in Singapore and your work clothes have been fitting tighter lately, keep watching.", GOOD[1], GOOD[2]]), ['line 1 names the whole country ("Singapore"): the place is only ever {AREA}, the area around the gym']);
    assert.deepEqual(scriptProblems([GOOD[0], "Singapore Strength Club's 12 Week Full Body Transformation is built for exactly that, with a coach beside you.", GOOD[2]], { offer: OFFER, profile: { ...profile, display_name: "Singapore Strength Club" }, closing: C }), [], "the gym's own name may carry the word");
    // His to change, for every gym: the scripts kept with the old one then need an edit, and are not filmed until they have it.
    const mine = addScript(g, { lines: GOOD, offer: OFFER }, { profile, closing: C });
    assert.throws(() => setClosing(L, "Tap below now"), /4 to 14 words/); assert.throws(() => setClosing(L, "Tap the button below and the team will call you"), /does not say "tap"/);
    assert.equal(setClosing(L, "Click the link below and the team will be in touch."), "Click the link below and the team will be in touch."); const C2 = closingLine(L);
    assert.deepEqual([C2, scriptIssues(mine, { profile, closing: C2 }), readyScripts(g, OFFER, { profile, closing: C2 }).length, readyScripts(g, OFFER, { profile, closing: C }).length], ["Click the link below and the team will be in touch.", ['line 3 speaks as the gym or a member ("we"): the presenter is nobody in particular, so no I, we, our, my or us', `the last line ends with the closing line, word for word: "${C2}"`], 0, 1], "the old closing's we is no longer the closing line's");
    assert.deepEqual([noScriptWhy(g, OFFER, { libraryDir: L, profile }).state, noScriptWhy(g, OFFER, { libraryDir: L, profile }).text], ["needs_edit", `the script kept for this offer needs an edit first — the last line ends with the closing line, word for word: "${C2}": press Edit… there`]);
    assert.throws(() => pickScripts(g, { count: 1, offer: OFFER, libraryDir: L }), /^Error: 1 presenter video asked for, but no script is ready for "12 Week Full Body Transformation": the script kept for this offer needs an edit first — the last line ends with the closing line, word for word: "Click the link below and the team will be in touch\.": press Edit… there \(Draft Scenes → Video scripts\)$/);
    await assert.rejects(makePresenterVideos({ gymDir: g, outDir: join(g, "o"), store: join(g, "o", "clips"), script: mine, areas: ["BISHAN"], offer: OFFER, room, profile, closing: C2, models: fakes().models }), /this script cannot be made: .*the last line ends with the closing line/);
    decideScript(g, mine.id, { status: "draft" }, { profile, closing: C2 });
    assert.throws(() => decideScript(g, mine.id, { status: "kept" }, { profile, closing: C2 }), /^Error: edit it first: .*the last line ends with the closing line/, "a draft that breaks today's rules is not kept as it is");
    const fixed = decideScript(g, mine.id, { status: "kept", lines: [GOOD[0], GOOD[1], "You train with people just like you. Click the link below and the team will be in touch."] }, { profile, closing: C2 }); assert.equal(fixed.status, "kept");
    assert.equal(pickScripts(g, { count: 1, offer: OFFER, libraryDir: L })[0].id, mine.id);
    // The place is never the whole country: a location, an area passed to the maker.
    assert.deepEqual(["SINGAPORE", "Singapore", "SG", "ALL OF SINGAPORE", "ISLANDWIDE", "新加坡", "TAIWAN", "台灣", "SINGAPORE NORTH EAST", "BOAT QUAY", "CBD", "信義區"].map(isWholeCountry), [true, true, true, true, true, true, true, true, false, false, false, false]);
    await assert.rejects(makePresenterVideos({ gymDir: g, outDir: join(g, "o"), store: join(g, "o", "clips"), script: fixed, areas: ["SINGAPORE"], offer: OFFER, room, profile, closing: C2, models: fakes().models }), /"SINGAPORE" is the whole country: a video says the area around the gym, never the country/);
    // Pain points: the owner's own is kept at once; never a judgement of the person; the ad rules; never twice; retired with a reason.
    assert.deepEqual([painProblems(PAIN, profile), painProblems("you feel fat and ashamed in fitted clothes", profile).length, /judges the person/.test(painProblems("being overweight", profile).join()), painProblems("short", profile).length, /weight-loss number/.test(painProblems("you want to lose 5kg before the holidays", profile).join())], [[], 1, true, 1, true]);
    assert.deepEqual(painsFor(g, OFFER), []);
    const p1 = addPain(g, OFFER, `  ${PAIN}. `, { profile });
    assert.deepEqual([p1.text, p1.status, p1.source, /^p-[0-9a-f]{10}$/.test(p1.id), painsFor(g, OFFER.toUpperCase()), painsFor(g, "6 Week Reset")], [PAIN, "kept", "owner", true, [PAIN], []], "by the offer's words, case aside");
    assert.throws(() => addPain(g, OFFER, PAIN.toUpperCase(), { profile }), /already here/);
    // Suggested from the gym's best adverts and the library's pain-led ones: drafts until he keeps them.
    writeFileSync(join(g, "copy-references.json"), JSON.stringify({ refs: [{ id: "a", message: "If you've been avoiding fitted clothes or hiding behind the blazer lately, you are not alone.", results: { leads: 74 } }, { id: "b", message: "Four classes for a small price, limited time only, message us now to grab it.", results: { leads: 80 } }, { id: "c", message: "An old one that was retired by the owner some time ago, kept on file.", results: { leads: 500 }, retired: "2026-01-01" }] }));
    mkdirSync(L, { recursive: true }); writeFileSync(join(L, "copy-library.json"), JSON.stringify({ entries: [{ id: "l1", kind: "copy", angle: "pain", text: "Losing strength does not happen overnight. It happens little by little." }, { id: "l2", kind: "copy", angle: "call-out", text: "Ladies of {AREA}, this one is for you." }, { id: "l3", kind: "headline", angle: "pain", text: "Tired of starting over?" }] }));
    assert.deepEqual([painSources(g, L).ads.map((x) => x.leads), painSources(g, L).library.length], [[80, 74], 1], "the adverts with the most leads, no retired one; the library's pain-led copies only");
    const asked = []; const sug = await suggestPains({ brandDir: g, libraryDir: L, offer: OFFER, audience: "busy professionals", count: 4, ask: async (i, p, schema) => { asked.push({ p, schema }); return { pains: [{ text: "you have been avoiding fitted clothes", from: "this gym's adverts" }, { text: "everyday things feel harder than they used to", from: "the library" }, { text: "being overweight and unhappy about it", from: "the audience" }, { text: PAIN, from: "the audience" }] }; } });
    assert.deepEqual([sug.added.map((x) => [x.text, x.status, x.source, x.from]), sug.dropped.map((x) => /judges the person|already here/.test(x.reason)), sug.calls, sug.sources], [[["you have been avoiding fitted clothes", "draft", "suggested", "this gym's adverts"], ["everyday things feel harder than they used to", "draft", "suggested", "the library"]], [true, true], 1, { ads: 2, library: 1 }]);
    assert.match(asked[0].p, /Say what HAPPENS to the person, never what they ARE/); assert.match(asked[0].p, /--- ADVERT 1 \(80 leads\)\nFour classes/); assert.match(asked[0].p, /--- LIBRARY 1\nLosing strength/); assert.match(asked[0].p, /It is for: busy professionals\./); assert.match(asked[0].p, new RegExp(`Already on the list — do not repeat or closely rephrase:\\n- ${PAIN}`));
    assert.deepEqual(painsFor(g, OFFER), [PAIN], "a suggestion is not used until it is kept");
    const s1 = sug.added[0], s2 = sug.added[1];
    assert.equal(decidePain(g, OFFER, s1.id, { status: "kept" }, { profile }).status, "kept");
    assert.throws(() => decidePain(g, OFFER, s2.id, { text: "you are fat" }, { profile }), /judges the person/); assert.throws(() => decidePain(g, OFFER, s2.id, { status: "retired" }, { profile }), /needs a reason/);
    assert.deepEqual([decidePain(g, OFFER, s2.id, { status: "retired", reason: "not what clients say" }, { profile }).status, painsFor(g, OFFER), readPains(g)[0].items.length, PAIN_LIMITS.kept], ["retired", [PAIN, "you have been avoiding fitted clothes"], 3, 8], "retired, never deleted");
    assert.match(buildPainsPrompt({ profile, offer: OFFER }).prompt, /"getting back into shape", "wanting to be healthier", "putting off fitness" are NOT pain points/);
    // The drafter — the agent proposes (the owner, the same day: "the agent proposes the scripts for me to review and edit (if necessary), not I tell the agent what to say"): with no pain point kept it is still drafted — the agent works the pain points out from the gym's best adverts and the library's pain-led ones — and every draft says the one it opens on, held to the pain points' own rules.
    const g2 = gym(); writeFileSync(join(g2.g, "copy-references.json"), readFileSync(join(g, "copy-references.json")));
    const opening = "If you live in {AREA} and you have been avoiding fitted clothes lately, this one is for you.", CL = "If that sounds like you, click the link below and the team will be in touch.";
    const seen2 = [], d2 = await draftScripts({ brandDir: g2.g, libraryDir: L, offer: OFFER, count: 3, ask: async (i2, p, schema) => { seen2.push({ p, schema }); return { scripts: [
      { pain: "avoiding fitted clothes lately.", lines: [opening, GOOD[1], CL] },
      { pain: "being overweight", lines: [opening.replace("this one is for you", "keep watching"), GOOD[1], CL] },
      { pain: "", lines: [opening.replace("this one is for you", "stay with this"), GOOD[1], CL] }] }; } });
    assert.deepEqual([d2.added.map((x) => [x.status, x.source, x.pain]), d2.dropped.map((x) => x.reason.slice(0, 60)), d2.calls, d2.sources], [[["draft", "drafted", "avoiding fitted clothes lately"]], ['the pain point it opens on ("being overweight"): "overweight', "it does not say which pain point it opens on"], 1, { pains: 0, ads: 2, library: 1 }]);
    assert.match(seen2[0].p, /PAIN POINTS\. A pain point is something that HAPPENS to this person[^\n]*"getting back into shape", "putting off fitness", "starting a fitness journey" are NOT pain points\. Work them out yourself before you write: who this advert is for, and what they are living with, drawing on the adverts below\./);
    assert.match(seen2[0].p, /--- ADVERT 1 \(80 leads\)\nFour classes/); assert.match(seen2[0].p, /--- LIBRARY 1\nLosing strength/); assert.ok(!/The owner's own list comes first/.test(seen2[0].p));
    rmSync(g2.d, { recursive: true, force: true });
    // His own kept pain points come first; the closing line follows a few words, never a line on its own; the rules are checked on every draft.
    const seen = [], dr = await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 4, ask: async (i2, p, schema) => { seen.push({ p, schema }); return { scripts: [
      { pain: "you have been avoiding fitted clothes", lines: [opening, GOOD[1], "Feel at ease in your own clothes again. Click the link below and the team will be in touch."] },
      { pain: PAIN, lines: [opening.replace("this one is for you", "stay with this"), GOOD[1], "Feel at ease in your own clothes again. Tap below to find out more today."] },
      { pain: PAIN, lines: ["If you live in Singapore and your work clothes have been fitting tighter lately, this is for you.", GOOD[1], "Feel stronger for the day ahead. Click the link below and the team will be in touch."] }] }; } });
    assert.deepEqual([dr.added.map((x) => [x.status, x.pain]), dr.dropped.map((x) => x.reason.slice(0, 44))], [[["draft", "you have been avoiding fitted clothes"]], ['line 3 says "Tap below": the only call to ac', 'line 1 names the whole country ("Singapore")']]);
    const P = seen[0].p;
    assert.match(P, /Line 1 says where — the place written as \{AREA\} \(it is filled in for each location\) — and opens on ONE pain point: what this person is living with and wants gone/);
    assert.match(P, new RegExp(`The owner's own list comes first — open on these, close to his words, one for each script; for the scripts beyond the list, work out further ones yourself the same way:\\n1\\. ${PAIN}\\n2\\. you have been avoiding fitted clothes(\\n|$)`));
    assert.match(P, /it is the ONLY call to action in the script: "Click the link below and the team will be in touch\." It follows a few words in the same line \("If that sounds like you, click the link below and the team will be in touch\."\): it is never a line on its own\. Never write "tap", never name a button/);
    assert.match(P, /The closing sentence is the one exception: it is said word for word as given\./); assert.match(P, /The place is only ever \{AREA\}, the area around the gym: the script never names the country/);
    assert.match(P, /Write 4 scripts, each opening on a different pain point, and say for each the pain point it opens on \(pain: a short phrase/);
    assert.deepEqual(seen[0].schema.properties.scripts.items.required, ["pain", "lines"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV8 Google may refuse a clip (2026-11-14: Aether Athletics' closing line, filmed as a clip of its own, came back \"Request blocked due to prohibited content guidelines\" and the run died on the raw JSON; tested: the bare sentence is refused on any picture and passes after a few words in the same clip): the closing line is never a clip of its own — where it is a script's whole last line it is filmed with the line before it, as one cut, the words unchanged; a refusal is a failed take, not a crash — asked once more, then on a fresh picture of the presenter, then that video is refused in words with what to do, its seconds never counted; and every Google error has a plain sentence", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { filmedLines, closingAlone, CLOSING_LINE, JOINED_WORDS } = await import("./presenter-video.mjs");
  const { isRefusal, explainGemini, plainGemini, isBusy } = await import("./gemini-busy.mjs");
  const { d, g, profile, room } = gym(), C = CLOSING_LINE;
  const REFUSED = () => new Error('video line.mp4 failed (400): {"error":{"message":"Request blocked due to prohibited content guidelines. Please modify your input and retry.","code":"prohibited_content"}}');
  try {
    // The closing line alone is filmed with the line before it: one cut, one picture and one clip fewer.
    const ALONE = [GOOD[0], GOOD[1], "You will feel stronger and your clothes will fit better.", C];
    assert.deepEqual([closingAlone(C, C), closingAlone("click the link below and we’ll be in touch", C), closingAlone(GOOD[2], C), filmedLines(GOOD, C), filmedLines(ALONE, C)], [true, true, false, GOOD, [GOOD[0], GOOD[1], `You will feel stronger and your clothes will fit better. ${C}`]]);
    assert.deepEqual(scriptProblems(ALONE, { offer: OFFER, profile, closing: C }), []);
    const longLine = "You will feel stronger, sleep better, move more easily, have more energy for your whole day and feel at ease in every single piece of clothing.";
    // With the standing closing line the two always fit one cut; a longer closing of his own may not, and that is said.
    const C12 = "Click the link below and the whole team will be in touch soon.";
    assert.deepEqual([scriptProblems([GOOD[0], GOOD[1], longLine, C], { offer: OFFER, profile, closing: C }), scriptProblems([GOOD[0], GOOD[1], longLine, C12], { offer: OFFER, profile, closing: C12 }), JOINED_WORDS], [[], ["line 3 and the closing line are filmed as one cut (the closing line cannot be a clip of its own) and together they are 39 words: at most 36, so shorten line 3"], 36]);
    const cost = scriptCost({ lines: ALONE }, ["BISHAN"], { closing: C });
    assert.deepEqual([cost.clips.length, cost.images, cost.clips[2].line, cost.clips[2].seconds], [3, 3, `${ALONE[2]} ${C}`, clipSeconds(`${ALONE[2]} ${C}`)]);
    const script = addScript(g, { lines: ALONE, offer: OFFER }, { profile, closing: C }), log = [];
    const F = fakes(), R = await makePresenterVideos({ gymDir: g, outDir: join(g, "o1"), store: join(g, "o1", "clips"), script, areas: ["BISHAN"], offer: OFFER, room, profile, closing: C, caps: { seconds: 80, images: 5 }, takes: 1, models: F.models, log: (m) => log.push(m) });
    assert.deepEqual([R.videos[0].failed, F.calls.image.length, F.calls.clip.map((c) => plain(c.out)), R.videos[0].words[2], R.spent.images], [undefined, 3, ["line-1-bishan.mp4", "line-2.mp4", "line-3.mp4"], `${ALONE[2]} ${C}`, 3]);
    assert.ok(F.calls.clip[2].prompt.includes(`"${ALONE[2]} ${C}"`) && log.includes("the closing line is filmed with line 3 as one cut: Google's video model refuses it as a clip of its own"), log.join("\n"));
    // A refusal: what counts as one, and what it is in plain words.
    assert.deepEqual([isRefusal(REFUSED()), isRefusal(new Error("Blocked by safety filter: PROHIBITED_CONTENT")), isRefusal(Object.assign(new Error("no video came back for x.mp4"), { refused: true })), isRefusal(new Error("vision check failed (503): overloaded")), isBusy(REFUSED())], [true, true, true, false, false]);
    assert.deepEqual([explainGemini(REFUSED()).kind, explainGemini(new Error("GEMINI_KEY not found (.env or environment)")).kind, explainGemini(new Error('Gemini API error (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}')).kind, explainGemini(new Error("vision check failed (403): PERMISSION_DENIED")).kind, explainGemini(new Error("Gemini API error (404): models/x is not found for API version v1beta")).kind, explainGemini(new Error("vision check failed (503): The model is overloaded")).kind, explainGemini(new Error("fetch failed")).kind, explainGemini(Object.assign(new Error("x"), { name: "TimeoutError" })).kind, explainGemini(new Error("no approved scenes yet"))], ["refused", "key", "quota", "access", "model", "busy", "network", "timeout", null]);
    assert.equal(plainGemini(REFUSED()), "Google's model refused this request under its content rules. Nothing else is lost: run again to try it once more, and if it is refused again change the words or the picture it was asked for. (Google said: Request blocked due to prohibited content guidelines. Please modify your input and retry.)");
    assert.equal(plainGemini(new Error("no approved scenes yet")), "no approved scenes yet", "anything else is said as it is");
    // Refused once (a misfire): asked once more, and it is made. Nothing is counted for the refused request, and it is no take.
    const s2 = addScript(g, { lines: [GOOD[0].replace("keep watching", "stay with this"), GOOD[1], GOOD[2]], offer: OFFER }, { profile, closing: C });
    const base = { gymDir: g, script: s2, areas: ["BISHAN"], offer: OFFER, room, profile, closing: C, caps: { seconds: 80, images: 6 }, takes: 1 };
    let n = 0; const A = fakes(), clipA = A.models.clip; A.models.clip = async (x) => { if (/built for exactly that/.test(x.prompt) && n++ === 0) throw REFUSED(); return clipA(x); };
    const logA = [], ra = await makePresenterVideos({ ...base, outDir: join(g, "o2"), store: join(g, "o2", "clips"), models: A.models, log: (m) => logA.push(m) });
    assert.deepEqual([ra.videos[0].failed, A.calls.clip.length, A.calls.image.length, ra.spent.seconds, ra.videos[0].lines[1].takes], [undefined, 3, 3, S(s2.lines[0], "BISHAN") + S2 + S3, 1]);
    assert.ok(logA.some((l) => /line-2-[0-9a-f]{6}\.mp4: refused by Google's video model under its content rules — asked once more$/.test(l)), logA.join("\n"));
    // Refused twice on its picture: a fresh picture of the presenter is made for that line, and it is filmed on that one; a later run goes straight to it.
    const B = fakes(), clipB = B.models.clip; B.models.clip = async (x) => { if (/built for exactly that/.test(x.prompt) && !/-b\.jpg$/.test(x.image)) throw REFUSED(); return clipB(x); };
    const logB = [], rb = await makePresenterVideos({ ...base, outDir: join(g, "o3"), store: join(g, "o3", "clips"), models: B.models, log: (m) => logB.push(m) });
    assert.deepEqual([rb.videos[0].failed, B.calls.image.length, plain(B.calls.image[3].out), B.calls.image[3].refs.map(plain), B.calls.clip.map((c) => plain(c.image)), rb.spent.images, rb.spent.seconds], [undefined, 4, "still-2-b.jpg", ["still-1.jpg", "room.png"], ["still-1.jpg", "still-2-b.jpg", "still-3.jpg"], 4, S(s2.lines[0], "BISHAN") + S2 + S3]);
    assert.ok(logB.includes("  a fresh picture of the presenter for line 2"), logB.join("\n"));
    const B2 = fakes(), clipB2 = B2.models.clip; let asked = 0; B2.models.clip = async (x) => { asked++; return clipB2(x); };
    const rb2 = await makePresenterVideos({ ...base, outDir: join(g, "o3"), store: join(g, "o3", "clips"), models: B2.models });
    assert.deepEqual([rb2.videos[0].failed, asked, B2.calls.image.length, rb2.spent], [undefined, 0, 0, { seconds: 0, images: 0, checks: 0 }], "again: the clip on the second picture is found, nothing is asked for");
    // Refused every time: that video is refused in words, with what to do; the other lines are made and kept; nothing is thrown; the refused seconds are not counted.
    const Cc = fakes(), clipC = Cc.models.clip; let tries = 0; Cc.models.clip = async (x) => { if (/built for exactly that/.test(x.prompt)) { tries++; throw REFUSED(); } return clipC(x); };
    const rc = await makePresenterVideos({ ...base, outDir: join(g, "o4"), store: join(g, "o4", "clips"), models: Cc.models });
    assert.deepEqual([rc.videos[0].failed, rc.videos[0].refused, tries, Cc.calls.clip.length, rc.spent.seconds, rc.videos[0].file], ["line 2: refused by Google's video model under its content rules, 3 times and on two pictures of the presenter. Nothing else is lost: Run again tries only this cut; if it is refused again, change its words", true, 3, 2, S(s2.lines[0], "BISHAN") + S3, undefined]);
    // Any other fault from Google still stops the run as it did (it is not a refusal to work around).
    const Dd = fakes(); Dd.models.clip = async () => { throw new Error('video x.mp4 failed (400): {"error":{"message":"Invalid duration"}}'); };
    await assert.rejects(makePresenterVideos({ ...base, outDir: join(g, "o5"), store: join(g, "o5", "clips"), models: Dd.models }), /Invalid duration/);
    // The presenter's picture refused twice: nothing is filmed, and that is said.
    const E = fakes(); E.models.image = async () => { throw new Error("Blocked by safety filter: PROHIBITED_CONTENT"); };
    const re = await makePresenterVideos({ ...base, outDir: join(g, "o6"), store: join(g, "o6", "clips"), models: E.models });
    assert.deepEqual([re.videos[0].failed, E.calls.clip.length], ["Google's image model refused the presenter's picture for line 1 twice, under its content rules. Nothing else is lost: Run again asks once more; if it is refused again, change the presenter's look on Ad defaults", 0]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV9 what is filmed is kept per gym and script, not per batch, and the agent proposes the edit a script needs (2026-11-14: Aether's second batch filmed three lines again, word for word what its first batch had; \"have the agent propose any edits required for me to approve, but i can also manually edit it\"): a second batch of the same script films nothing; a new location films its one line; an edited line films that line; a script filmed before brings one batch's pictures and clips in, never a mix; what is still to film is known before a run; a proposed edit is checked in code, saved only when he approves it, and one that still breaks a rule is not offered", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { clipStore, adoptClips, videoNeeds, proposeEdit, buildEditPrompt, CLOSING_LINE, CLIPS_DIR } = await import("./presenter-video.mjs");
  const { readdirSync, copyFileSync } = await import("node:fs");
  const { d, g, profile, room } = gym(), C = CLOSING_LINE;
  try {
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile, closing: C }), store = clipStore(g, script.id);
    assert.equal(store, join(g, CLIPS_DIR, script.id));
    const base = { gymDir: g, script, offer: OFFER, room, profile, closing: C, caps: { seconds: 80, images: 5 }, takes: 1 };
    // Before anything is filmed: everything is to film.
    const need0 = videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, closing: C });
    assert.deepEqual([need0.seconds, need0.reused, need0.images, need0.clips.map((c) => [c.area, c.on_file])], [S1 + S2 + S3, 0, 3, [["BISHAN", false], [null, false], [null, false]]]);
    // The first batch films it all — into the gym's store, not the batch's folder (the captions and the video are the batch's).
    const A = fakes(), ra = await makePresenterVideos({ ...base, outDir: join(g, "outputs", "b1", "videos"), areas: ["BISHAN"], models: A.models });
    assert.deepEqual([ra.videos[0].failed, A.calls.clip.length, A.calls.image.length], [undefined, 3, 3]);
    const inStore = readdirSync(store), inBatch = readdirSync(join(g, "outputs", "b1", "videos", script.id));
    assert.ok(inStore.filter((f) => /^still-\d-[0-9a-f]{6}\.jpg$/.test(f)).length === 3 && inStore.filter((f) => /^line-.*\.mp4$/.test(f)).length === 3 && inStore.filter((f) => /check\.json$/.test(f)).length === 3, inStore.join(" "));
    assert.ok(inBatch.every((f) => /^cap-/.test(f)) && existsSync(ra.videos[0].file), inBatch.join(" "));
    // A second batch of the same script: nothing is filmed, nothing is spent, and it has its video.
    const B = fakes(), rb = await makePresenterVideos({ ...base, outDir: join(g, "outputs", "b2", "videos"), areas: ["BISHAN"], models: B.models });
    assert.deepEqual([rb.videos[0].failed, B.calls.clip.length, B.calls.image.length, B.calls.watch.length, rb.spent, existsSync(rb.videos[0].file)], [undefined, 0, 0, 0, { seconds: 0, images: 0, checks: 0 }, true]);
    // A new location: only the line that says the area. Known before the run.
    const need1 = videoNeeds({ gymDir: g, script, areas: ["BISHAN", "ANG MO KIO"], room, profile, closing: C });
    assert.deepEqual([need1.seconds, need1.reused, need1.images, need1.clips.map((c) => [c.area, c.on_file])], [S1B, S1 + S2 + S3, 0, [["BISHAN", true], ["ANG MO KIO", false], [null, true], [null, true]]]);
    const Cc = fakes(), rc = await makePresenterVideos({ ...base, outDir: join(g, "outputs", "b3", "videos"), areas: ["ANG MO KIO"], models: Cc.models });
    assert.deepEqual([rc.videos[0].failed, Cc.calls.clip.map((c) => plain(c.out)), Cc.calls.image.length, rc.spent.seconds], [undefined, ["line-1-ang-mo-kio.mp4"], 0, S1B]);
    // An edited line: that line alone.
    const edited = decideScript(g, script.id, { lines: [GOOD[0], GOOD[1], "You will feel stronger every week. If that sounds like you, click the link below and we'll be in touch!"] }, { profile, closing: C });
    const need2 = videoNeeds({ gymDir: g, script: edited, areas: ["BISHAN"], room, profile, closing: C });
    assert.deepEqual([need2.clips.map((c) => c.on_file), need2.seconds, need2.images], [[true, true, false], clipSeconds(edited.lines[2]), 0]);
    const Dd = fakes(), rd = await makePresenterVideos({ ...base, script: edited, outDir: join(g, "outputs", "b4", "videos"), areas: ["BISHAN"], models: Dd.models });
    assert.deepEqual([rd.videos[0].failed, Dd.calls.clip.map((c) => plain(c.out)), Dd.calls.image.length], [undefined, ["line-3.mp4"], 0]);
    // A clip on file that did not pass its check is not counted as filmed.
    const bad = inStore.find((f) => /^line-2-.*check\.json$/.test(f)); writeFileSync(join(store, bad), JSON.stringify({ spoken: "Something else.", on_screen_text: [], people: 1, faults: [] }));
    assert.deepEqual(videoNeeds({ gymDir: g, script: edited, areas: ["BISHAN"], room, profile, closing: C }).clips.map((c) => c.on_file), [true, false, true]);
    // A script filmed before the store (its pictures and clips in its batches' folders): one folder's are brought in — the first that has any — and only once.
    const s2 = addScript(g, { lines: [GOOD[0].replace("keep watching", "stay with this"), GOOD[1], GOOD[2]], offer: OFFER }, { profile, closing: C }), store2 = clipStore(g, s2.id);
    const old1 = join(g, "outputs", "old1", "videos", s2.id), old2 = join(g, "outputs", "old2", "videos", s2.id), mine = join(g, "outputs", "b5", "videos", s2.id);
    const E = fakes(); await makePresenterVideos({ ...base, script: s2, outDir: join(g, "outputs", "old1", "videos"), store: old1, areas: ["BISHAN"], models: E.models }); // as an older batch left it: everything in its own folder
    mkdirSync(old2, { recursive: true }); writeFileSync(join(old2, "still-1-aaaaaa.jpg"), PNG); writeFileSync(join(old2, "line-9-zzzzzz.mp4"), "another presenter");
    const before = videoNeeds({ gymDir: g, script: s2, areas: ["BISHAN"], room, profile, closing: C, legacy: [mine, old1, old2] });
    assert.deepEqual([before.seconds, before.images, existsSync(store2)], [0, 0, false], "known before the run, and nothing is written by asking");
    const logs = [], G = fakes(), rg = await makePresenterVideos({ ...base, script: s2, outDir: join(g, "outputs", "b5", "videos"), legacy: [mine, old1, old2], areas: ["BISHAN"], models: G.models, log: (m) => logs.push(m) });
    assert.deepEqual([rg.videos[0].failed, G.calls.clip.length, G.calls.image.length, logs[0], readdirSync(store2).includes("line-9-zzzzzz.mp4"), JSON.parse(readFileSync(join(store2, "adopted.json"), "utf-8")).from], [undefined, 0, 0, "what was already filmed for this script is reused (from old1)", false, old1]);
    assert.equal(adoptClips(store2, [old2]), null, "once: a store that exists takes nothing more");
    // ── The agent proposes the edit ──
    const stale = addScript(g, { lines: [GOOD[0].replace("keep watching", "listen up"), GOOD[1], "You train with people just like you. Click the link below and we'll be in touch!"], offer: OFFER }, { profile, closing: C });
    const C2 = "Click the link below and the team will be in touch.", L = join(d, "lib"); mkdirSync(L, { recursive: true }); writeFileSync(join(L, "video-samples.json"), JSON.stringify({ schema: 1, samples: [], closing: { text: C2 } }));
    const fixedLast = "You train with people just like you. If that sounds like you, click the link below and the team will be in touch.";
    const asked = [], pr = await proposeEdit({ brandDir: g, id: stale.id, libraryDir: L, ask: async (i, p, schema) => { asked.push({ p, schema }); return { lines: [stale.lines[0], stale.lines[1], fixedLast], note: "The last line now ends with the closing line." }; } });
    assert.deepEqual([pr.lines, pr.changed, pr.note, pr.calls, pr.problems.some((x) => /the last line ends with the closing line, word for word/.test(x))], [[stale.lines[0], stale.lines[1], fixedLast], [3], "The last line now ends with the closing line.", 1, true]);
    assert.match(asked[0].p, /Propose the SMALLEST edit that mends it, for the owner to approve\./); assert.match(asked[0].p, /THE SCRIPT:\n1\. People in \{AREA\}/); assert.match(asked[0].p, /WHAT IS WRONG:\n- /); assert.match(asked[0].p, /Keep every line that breaks no rule exactly as it is, word for word and in its place/); assert.match(asked[0].p, /word for word — "Click the link below and the team will be in touch\."/);
    assert.deepEqual(readScripts(g).scripts.find((x) => x.id === stale.id).lines, stale.lines, "nothing is saved by proposing");
    // He approves it (or changes it first): saved by the usual edit, checked again.
    assert.deepEqual(decideScript(g, stale.id, { lines: pr.lines }, { profile, closing: C2 }).lines, pr.lines);
    await assert.rejects(proposeEdit({ brandDir: g, id: stale.id, libraryDir: L, ask: async () => ({ lines: [], note: "" }) }), /this script needs no edit/);
    // An answer that still breaks a rule is asked for once more, and then not offered.
    const stale2 = addScript(g, { lines: [GOOD[0].replace("keep watching", "hear this"), GOOD[1], "You train with people just like you. Click the link below and we'll be in touch!"], offer: OFFER }, { profile, closing: C });
    let calls = 0;
    await assert.rejects(proposeEdit({ brandDir: g, id: stale2.id, libraryDir: L, ask: async () => { calls++; return { lines: [stale2.lines[0], stale2.lines[1], "You train with people just like you. Tap below to find out more today."], note: "x" }; } }), /^Error: the agent's edit still breaks a rule \(line 3 says "Tap below": the only call to action is the closing line\): edit the script yourself$/);
    assert.equal(calls, 2);
    let round = 0; const pr2 = await proposeEdit({ brandDir: g, id: stale2.id, libraryDir: L, ask: async (i, p) => { round++; return round === 1 ? { lines: [stale2.lines[0], stale2.lines[1], "Tap below now and the team will be in touch soon enough."], note: "x" } : { lines: [stale2.lines[0], stale2.lines[1], fixedLast], note: "Second try." }; } });
    assert.deepEqual([pr2.calls, pr2.changed, pr2.note], [2, [3], "Second try."]);
    await assert.rejects(proposeEdit({ brandDir: g, id: "v-nope", libraryDir: L, ask: async () => ({}) }), /no such script/);
    assert.equal(buildEditPrompt({ profile, script: stale2, problems: ["x"], closing: C2 }).schema.required.join(), "lines,note");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
