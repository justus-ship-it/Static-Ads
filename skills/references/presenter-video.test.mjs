// presenter-video.test.mjs — a presenter talking to camera (PV1–PV4). No model call: the still, the clip and the
// watching pass are fakes; the cut and the words are real (ffmpeg and headless Chrome), so the finished file is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { presenterOf, presenterWords, presenterProblems, PRESENTER_GENDERS, scriptProblems, addScript, decideScript, readScripts, keptScripts, scriptCost, buildScriptPrompt, draftScripts, sameWords, fillLine, clipSeconds, captions, captionChunks, speechFrom, speechOf, LEAD, TAIL, END_HOLD, captionWords, CAPTION_ACCENT, addPain, stillPrompt, clipPrompt, makePresenterVideos, durationOf, hasFfmpeg, SCRIPTS_FILE, LINES, LINE_WORDS, CLIP_SECONDS, FIRST_PERSON, LIVE, USD_PER_SECOND, videoNeeds, setAside, keepTake, ownerKeptClip, judgeClip, letteringOf, spokenLine } from "./presenter-video.mjs";
import { PROFILE_STARTER, validateProfile } from "./client-config.mjs";

// The shared library (the samples and the closing line) is never the real one in a test.
process.env.VIDEO_LIBRARY_DIR = mkdtempSync(join(tmpdir(), "pv-lib-"));
const OFFER = "12 Week Full Body Transformation", PAIN = "your work clothes have been fitting tighter lately";
// The drafting tests from before a drafted line was held to 17 words (2026-11-16) keep their longer fixture lines: the limit is a parameter. PV14 tests the limit itself.
const LOOSE = { line: 26, last: 40 };
const GOOD = [
  "People in {AREA}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.",
  "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and a plan that fits your week.",
  "If you are ready to train in small groups with people like you, now is your time. Click the link below and we'll be in touch!",
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
function fakes({ say = (line) => line, people = () => 1, text = () => [], faults = () => [], lettering = null, moved = null } = {}) {
  const calls = { image: [], clip: [], watch: [] }, lineOf = new Map();
  return { calls, models: {
    async image({ out, prompt, refs }) { calls.image.push({ out, prompt, refs }); writeFileSync(out, PNG); },
    async clip({ out, image, prompt, seconds }) { calls.clip.push({ out, image, prompt, seconds }); lineOf.set(out, prompt.match(/pace: "([^"]+)"/)[1]);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=180x320:r=24:d=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds - QUIET_START - QUIET_END}`, "-af", `adelay=${QUIET_START * 1000}|${QUIET_START * 1000},apad=whole_dur=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", String(seconds), out]); },
    async watch(file) { const n = calls.watch.push(file), line = lineOf.get(file); return { spoken: say(line, n, file), ...(lettering ? { lettering: lettering(line, n) } : { on_screen_text: text(line, n) }), people: people(line, n), lips_match_speech: true, faults: faults(line, n, file), looks_real: 9, ...(moved ? { did_move: moved(line, n, file) } : {}) }; },
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
    // The presenter speaks for the gym (2026-11-14, the owner: "allow the presenter to say 'we' representing the gym"): we, our and us are said; one person's own voice — I, my, me — is not, since the presenter is no real coach or member.
    assert.deepEqual(scriptProblems([GOOD[0], "We built the 12 Week Full Body Transformation for exactly that, and our coaches stay with you.", GOOD[2]], { offer: OFFER, profile }), []);
    assert.match(bad([GOOD[0], "I built the 12 Week Full Body Transformation for exactly that, with a coach beside you.", GOOD[2]]), /line 2 speaks as one person \("I"\): the presenter may speak for the gym \(we, our, us\), never as a coach or a member with a story of their own \(I, my, me\)/);
    assert.match(bad([GOOD[0], "The 12 Week Full Body Transformation changed my life, and it can change the week ahead of you.", GOOD[2]]), /line 2 speaks as one person \("my"\)/);
    assert.match(bad([GOOD[0], "Our coaches run it.", GOOD[2]]), /line 2 is 4 words: a line is one breath, 6 to 26 words/);
    assert.match(bad([GOOD[0], "Test Gym's twelve week plan is built for exactly that, with a coach beside you every time.", GOOD[2]]), /must name the offer in its exact words: "12 Week Full Body Transformation"/);
    assert.match(bad([GOOD[0].replace("{AREA}", "{CITY}"), GOOD[1], GOOD[2]]), /only \{AREA\} may stand in for a word \(found \{CITY\}\)/);
    assert.match(bad([GOOD[0], GOOD[1], "Start with a free trial this week and see how it feels. Click the link below and we'll be in touch!"]), /free/i);
    assert.match(bad([GOOD[0], GOOD[1], "People lose 5kg in the first month here, every single time. Click the link below and we'll be in touch!"]), /weight-loss number/);
    assert.ok(FIRST_PERSON.test("that is what my plan does") && FIRST_PERSON.test("I'm here every day") && !FIRST_PERSON.test("that is what our plan does, and we mean it for all of us") && !FIRST_PERSON.test("a tour of the gym, with music, in time"), "one person's voice, whole words only");
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
    assert.deepEqual([S1, S2, S3], [10, 10, 11], "lines of 23, 23 and 26 words");
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
    assert.match(prompt, /written as \{AREA\}/); assert.match(prompt, /in these exact words — "Test Gym's 12 Week Full Body Transformation"/); assert.match(prompt, /"we", "our" and "us" mean Test Gym and its coaches/); assert.match(prompt, /the script never says I, my or me, and never tells a personal story/);
    assert.match(prompt, /NEVER: a price or any money; free or a free trial; before and after; a guarantee/); assert.match(prompt, /Already written — do not repeat or closely rephrase:\n- an old one/);
    assert.equal(schema.properties.scripts.items.properties.lines.type, "ARRAY");
    const asked = [];
    const ask = async (img, p, s, o) => { asked.push({ img, p, model: o.model }); return { scripts: [{ pain: PAIN, lines: GOOD }, { pain: PAIN, lines: [GOOD[0], "I built the 12 Week Full Body Transformation for exactly that, with a coach beside you.", GOOD[2]] }, { pain: PAIN, lines: [GOOD[0], "The programme is built for exactly that, with a coach beside you and a plan for the week.", GOOD[2]] }, { pain: PAIN, lines: GOOD }] }; };
    addPain(g, OFFER, PAIN, { profile });
    const r = await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, audience: "LADIES WANTED", count: 4, ask, words: LOOSE });
    assert.deepEqual([asked.length, asked[0].img, r.calls, r.reads, r.unread, r.added.length, r.added[0].status, r.added[0].source, r.added[0].pain], [2, null, 1, 1, true, 1, "draft", "drafted", PAIN], "one drafting call, and one call that reads the drafts aloud");
    assert.match(asked[1].p, /^Each numbered line below is spoken aloud to the camera by one person in a short video advert for Test Gym./);
    assert.deepEqual(r.dropped.map((x) => x.reason.slice(0, 36)), ['line 2 speaks as one person ("I"): t', "the script must name the offer in it", "this script is already here"]);
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
    // A line that never comes out as written: both takes are spent — and the video is cut all the same, with that line flagged, for the owner to watch and decide (2026-11-15: "I don't even see the final output").
    const WRONG = 'it said "You train in small groups. Tap below."', sayA = (line) => (/small groups/.test(line) ? "You train in small groups. Tap below." : line);
    const A = fakes({ say: sayA }), logA = [];
    let r = await makePresenterVideos({ ...base, outDir: join(g, "o1"), store: join(g, "o1", "clips"), models: A.models, log: (m) => logA.push(m) });
    assert.deepEqual([r.videos[0].failed, r.videos[0].flags, existsSync(r.videos[0].file), A.calls.clip.length], [undefined, [{ line: 3, label: "line 3", why: WRONG, kind: "words" }], true, 4]);
    assert.deepEqual(r.videos[0].parts.map((p) => [p.line, p.text === r.videos[0].words[p.line - 1], p.takes.length, p.seconds, !!p.flag, p.at >= 0]), [[1, true, 1, S1, false, true], [2, true, 1, S2, false, true], [3, true, 2, S3, true, true]], "every line of the cut: its words, its takes on file, what a fresh take takes, where it starts");
    assert.ok(r.videos[0].parts[1].at > r.videos[0].parts[0].at && r.videos[0].parts[2].at > r.videos[0].parts[1].at);
    assert.deepEqual(r.tally, { filmed: S1 + S2 + 2 * S3, in_videos: S1 + S2 + S3, replaced: 0, failed: S3, waiting: 0 }, "what the run filmed and what became of it");
    // Run again as it is: the takes are used up, so nothing is filmed and it is flagged as before.
    const A2 = fakes({ say: sayA }); r = await makePresenterVideos({ ...base, outDir: join(g, "o1"), store: join(g, "o1", "clips"), models: A2.models });
    assert.deepEqual([A2.calls.clip.length, A2.calls.watch.length, r.videos[0].flags.length, r.tally.filmed], [0, 0, 1, 0]);
    assert.deepEqual(videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, store: join(g, "o1", "clips"), takes: 2 }).clips.map((c) => [c.on_file, c.flagged]), [[true, false], [true, false], [false, true]], "known before a run: that line waits for the owner, and a run films nothing for it");
    assert.equal(videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, store: join(g, "o1", "clips"), takes: 2 }).seconds, 0);
    // Film this line again: its takes are set aside (kept on disk, never used) and two fresh ones may be filmed.
    const flaggedClip = r.videos[0].parts[2].clip, takesOnFile = r.videos[0].parts[2].takes;
    assert.throws(() => setAside(join(g, "o1", "clips"), ["../x.mp4"]), /which take\?/); assert.throws(() => setAside(join(g, "o1", "clips"), ["line-9-nope.mp4"]), /no such take on file/);
    assert.equal(setAside(join(g, "o1", "clips"), takesOnFile, "the owner asked"), 2);
    assert.equal(videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, store: join(g, "o1", "clips"), takes: 2 }).seconds, S3, "now it is to film");
    const A3 = fakes({ say: (line, n) => (/small groups/.test(line) && n === 1 ? "You train in small groups. Tap below." : line) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o1"), store: join(g, "o1", "clips"), models: A3.models });
    assert.deepEqual([A3.calls.clip.map((c) => plain(c.out)), r.videos[0].flags, r.videos[0].parts[2].clip !== flaggedClip, takesOnFile.every((f) => existsSync(join(g, "o1", "clips", f)))], [["line-3-take3.mp4", "line-3-take4.mp4"], undefined, true, true]);
    // Use this take anyway: on the owner's word that file passes — nothing is filmed, and the video says so.
    const K = fakes({ say: sayA }); r = await makePresenterVideos({ ...base, outDir: join(g, "o1k"), store: join(g, "o1k", "clips"), models: K.models });
    const keptClip = r.videos[0].parts[2].clip; assert.throws(() => keepTake(join(g, "o1k", "clips"), "line-9-nope.mp4"), /no such take on file/);
    assert.equal(keepTake(join(g, "o1k", "clips"), keptClip, WRONG).left, WRONG); assert.ok(ownerKeptClip(join(g, "o1k", "clips"), join(g, "o1k", "clips", keptClip)));
    const K2 = fakes({ say: sayA }); r = await makePresenterVideos({ ...base, outDir: join(g, "o1k"), store: join(g, "o1k", "clips"), takes: 3, models: K2.models });
    assert.deepEqual([K2.calls.clip.length, r.videos[0].flags, r.videos[0].parts[2].kept, r.videos[0].notes], [0, undefined, WRONG, [`line 3 kept on your word (${WRONG})`]], "kept on his word: never filmed again, not even where more takes are allowed");
    assert.equal(videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, store: join(g, "o1k", "clips") }).clips[2].on_file, true);
    writeFileSync(join(g, "o1k", "clips", keptClip), "changed"); assert.equal(ownerKeptClip(join(g, "o1k", "clips"), join(g, "o1k", "clips", keptClip)), null, "a file changed since is checked like any other");
    // A fault on the only take the cap allows: the take stands (a fault is a note), and nothing beyond the cap is asked for.
    const Ft = fakes({ faults: (line) => (/small groups/.test(line) ? ["warped fingers"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o1b"), store: join(g, "o1b", "clips"), caps: { seconds: S1 + S2 + S3, images: 5 }, models: Ft.models });
    assert.deepEqual([r.videos[0].failed, r.videos[0].notes, Ft.calls.clip.length, r.spent.seconds, r.videos[0].lines[2].takes], [undefined, ["warped fingers"], 3, S1 + S2 + S3, 1]);
    // A second person in the area's own line: that location is refused, the other is made.
    const B = fakes({ people: (line) => (/Bishan/.test(line) ? 2 : 1) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o2"), store: join(g, "o2", "clips"), areas: ["BISHAN", "KATONG"], models: B.models });
    assert.deepEqual(r.videos.map((v) => [v.area, v.failed, v.flags ? v.flags.map((f) => `${f.label}: ${f.why}`).join() : "made"]), [["BISHAN", undefined, "line 1: 2 people are in it"], ["KATONG", undefined, "made"]]);
    // Lettering in the picture, by what it is on (2026-11-15: two takes were refused for "Life Fitness", the maker's name on the gym's own cross-trainer).
    // Lettering the check cannot place fails the take; it may be in the picture itself, so the second take is filmed from a fresh picture of the presenter.
    const C = fakes({ text: (line) => (/built for exactly/.test(line) ? ["GYM"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3"), store: join(g, "o3", "clips"), models: C.models });
    assert.deepEqual([r.videos[0].failed, r.videos[0].flags.map((f) => [f.line, f.why, f.kind]), C.calls.image.length, C.calls.clip.map((c) => /-b\.jpg$/.test(c.image))], [undefined, [[2, "words appear in the picture: GYM", "lettering"]], 4, [false, false, true, false]]);
    // A maker's name on a machine, a machine's display: the room's own — a note, never a failure and never a retake.
    const Ce = fakes({ lettering: (line) => (/built for exactly/.test(line) ? [{ text: "Life Fitness", on: "equipment" }, { text: "12:40", on: "screen" }] : []) }), logE = [];
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3e"), store: join(g, "o3e", "clips"), models: Ce.models, log: (m) => logE.push(m) });
    assert.deepEqual([r.videos[0].failed, r.videos[0].flags, r.videos[0].notes, Ce.calls.clip.length, Ce.calls.image.length], [undefined, undefined, ["the maker's name on the equipment: Life Fitness", "on a screen in the room: 12:40"], 3, 3]);
    assert.ok(logE.some((l) => /line-2-[a-f0-9]{6}\.mp4: said as written, one person, no lettering · in the room: the maker's name on the equipment: Life Fitness; on a screen in the room: 12:40$/.test(l)), logE.join("\n"));
    // A caption the video model laid over the picture, writing on clothes, a sign: each still fails; a caption is not the picture's fault, so no fresh picture is made for it.
    const Co = fakes({ lettering: (line) => (/built for exactly/.test(line) ? [{ text: "SUBSCRIBE", on: "overlay" }] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3o"), store: join(g, "o3o", "clips"), models: Co.models });
    assert.deepEqual([r.videos[0].flags.map((f) => f.why), Co.calls.image.length, Co.calls.clip.length], [["words appear in the picture: SUBSCRIBE (a caption or watermark over the picture)"], 3, 4]);
    assert.deepEqual([judgeClip({ spoken: "Hi there", people: 1, lettering: [{ text: "NIKE", on: "clothing" }] }, "Hi there").why, judgeClip({ spoken: "Hi there", people: 1, lettering: [{ text: "SALE", on: "sign" }] }, "Hi there").why, judgeClip({ spoken: "Hi there", people: 1, lettering: [{ text: "x", on: "nonsense" }] }, "Hi there").kind, judgeClip({ spoken: "Hi there", people: 1, lettering: [] }, "Hi there").passed], ["words appear in the picture: NIKE (on clothing)", "words appear in the picture: SALE (a sign or writing in the room)", "lettering", true]);
    assert.deepEqual(letteringOf({ on_screen_text: ["LifeFitness"] }), { fails: [{ text: "LifeFitness", on: "other" }], notes: [] }, "a check from before lettering said what it is on cannot be placed");
    // …so such a check is watched again once, at no filming: the clip that was refused for the maker's name passes.
    const Cs = fakes(); r = await makePresenterVideos({ ...base, outDir: join(g, "o3s"), store: join(g, "o3s", "clips"), takes: 1, models: Cs.models });
    const oldCheck = join(g, "o3s", "clips", r.videos[0].parts[1].clip.replace(/\.mp4$/, ".check.json")), was = JSON.parse(readFileSync(oldCheck, "utf-8"));
    writeFileSync(oldCheck, JSON.stringify({ spoken: was.spoken, on_screen_text: ["Life Fitness"], people: 1, lips_match_speech: true, faults: [], looks_real: 7 }));
    assert.equal(videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, store: join(g, "o3s", "clips"), takes: 1 }).seconds, 0, "nothing to film for it");
    const Cs2 = fakes({ say: () => was.spoken, lettering: () => [{ text: "Life Fitness", on: "equipment" }] }); r = await makePresenterVideos({ ...base, outDir: join(g, "o3s"), store: join(g, "o3s", "clips"), takes: 1, models: Cs2.models });
    assert.deepEqual([Cs2.calls.clip.length, Cs2.calls.watch.length, r.spent, r.videos[0].flags, r.videos[0].notes], [0, 1, { seconds: 0, images: 0, checks: 1 }, undefined, ["the maker's name on the equipment: Life Fitness"]]);
    // One automatic retake for small notes, never two (the owner's choice, 2026-11-15), however many takes a failure is allowed.
    const N = fakes({ faults: (line) => (/built for exactly/.test(line) ? ["warped fingers"] : []) });
    r = await makePresenterVideos({ ...base, outDir: join(g, "o3n"), store: join(g, "o3n", "clips"), takes: 4, models: N.models });
    assert.deepEqual([N.calls.clip.length, r.videos[0].lines[1].takes, r.videos[0].notes, r.tally.replaced], [4, 2, ["warped fingers"], S2]);
    // The cap: 20 seconds covers lines 1 and 2; line 3's clip is never asked for.
    const D = fakes();
    r = await makePresenterVideos({ ...base, outDir: join(g, "o4"), store: join(g, "o4", "clips"), caps: { seconds: 20, images: 5 }, models: D.models });
    assert.deepEqual([r.videos[0].failed, D.calls.clip.length, r.spent.seconds], ["line 3: the cap of 20 seconds of video was reached", 2, S1 + S2]);
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
    assert.match(prompt, new RegExp(`where it marks the place, write \\{AREA\\}; where it marks the programme, write its exact words, "${OFFER}"; where it marks the gym, write "${profile.display_name}"; where the sample says we or our, it may stay — the speaker speaks for the gym\\. No other braces may appear in a script:`));
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
    assert.match(seen[0], /--- STYLE A — "Sample 1"\nThe owner's script in this style:\nHey, if you live in Katong/, "a sample not read yet is still a style of its own, followed from its text");
    decideSample(L, s1.id, { retired: true, reason: "an old offer" }); assert.deepEqual(liveSamples(L), []);
    await draftScripts({ brandDir: g, libraryDir: join(d, "lib"), offer: OFFER, count: 1, ask: async (i, p) => { seen.push(p); return { scripts: [] }; } });
    assert.ok(!/STYLE A|Sample 1/.test(seen[1])); assert.equal(readSamples(L).samples.length, 1, "retired, never deleted");
    assert.equal(decideSample(L, s1.id, { retired: false }).retired, undefined);
    // A batch's videos: how many, and which scripts.
    assert.deepEqual([videosProblems(undefined), videosProblems({ presenter: 2 }), videoCount({ presenter: 2 }), videoCount(null), MAX_VIDEOS], [[], [], 2, 0, 3]);
    assert.deepEqual(videosProblems({ presenter: 4, talking: 1 }), ['videos: "talking" is not a kind of video (presenter, active, paper)', "videos.presenter must be a whole number from 0 to 3"]);
    // No script for the offer: the refusal says which case it is and what to press (2026-11-12: a sample on the screen was taken for a script).
    const { noScriptWhy } = await import("./presenter-video.mjs");
    assert.throws(() => pickScripts(g, { count: 1, offer: OFFER, libraryDir: L }), /1 presenter video asked for, but no script is kept for "12 Week Full Body Transformation": keep 1 more on Draft Scenes → Video scripts \(nothing is written for this offer yet\. The sample script there is a template, not a script to film: press Draft scripts…, read the drafts and keep one\)$/);
    assert.deepEqual([noScriptWhy(g, OFFER, { libraryDir: L }).state, noScriptWhy(g, OFFER, { libraryDir: join(d, "empty-lib") }).state, noScriptWhy(g, OFFER, { libraryDir: join(d, "empty-lib") }).text], ["sample_only", "none", "nothing is written for this offer yet: press Draft scripts… there, or write your own"]);
    const a = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), b = addScript(g, { lines: [GOOD[0], GOOD[1], "If you are ready to feel stronger every day, now is your time. Click the link below and we'll be in touch!"], offer: OFFER }, { profile });
    addScript(g, { lines: [GOOD[0], GOOD[1], "If you are ready to walk into your week with more energy, now is your time. Click the link below and we'll be in touch!"], offer: OFFER, source: "drafted" }, { profile });
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
    assert.match(seen[0], /--- STYLE A — "Sample 1"\nThe owner's script in this style:\nIf you are in the \{AREA\} area, we have just launched our \{CHALLENGE NAME\}/);
    // A sample from before, in a gym's own file: it joins the library once, as it is; the gym's file is untouched.
    const legacy = join(b.g, SCRIPTS_FILE), old = { schema: 1, scripts: [], samples: [{ id: "vs-old0000001", text: "Hey Katong, tired of starting over every January? This one is about feeling strong again.", added: "2026-11-12" }, { id: row.id, text: T, added: "2026-11-12" }] };
    writeFileSync(legacy, JSON.stringify(old));
    assert.deepEqual([adoptSamples(L, [a.g, b.g]), adoptSamples(L, [a.g, b.g]), readSamples(L).samples.map((x) => [x.id, x.from]), JSON.parse(readFileSync(legacy, "utf-8")).samples.length], [1, 0, [[row.id, "gym-a"], ["vs-old0000001", "testgym"]], 2]);
    // Two to seven lines.
    const seven = [GOOD[0], GOOD[1], "The coaches start with a full body scan, so the plan is built on what is really there.", "Then the food side is sorted, with recipes, shopping lists and a guide for eating out.", "Only ten places are open, so every person gets real attention from a coach.", "Feeling strong and confident again is closer than it looks from where you are today.", "If you are ready for that change, now is your time. Click the link below and we'll be in touch!"];
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
    assert.match(P, /a part that needs a fact you were NOT given \(an assessment, a number of places, how many people were helped\) is left out, never invented\./); assert.match(P, /THE ENDING is two beats, both in the last line\./);
    assert.match(P, /may be stated are these, in the owner's words: "A full body scan assessment at the start"; "Only 10 places"\. Say them as given, and nothing else about how the programme works\./);
    assert.match(P, /"we", "our" and "us" mean Test Gym and its coaches, and are said the way a gym speaks/);
    assert.ok(!/may be stated are these/.test(seen[0]), "the other gym gave no facts, so its drafter is given none");
    // No sample and no facts: the three-line script, as it was.
    const plain = buildScriptPrompt({ profile: a.profile, offer: OFFER }).prompt;
    assert.match(plain, /A script is exactly 3 lines\./); assert.match(plain, /Line 3 is the ending\. THE ENDING is two beats, both in the last line\./);
    setFacts(a.g, OFFER, [], { profile: a.profile }); assert.deepEqual([factsFor(a.g, OFFER), Object.keys(readScripts(a.g).facts)], [[], []], "an empty list clears it");
  } finally { rmSync(a.d, { recursive: true, force: true }); rmSync(b.d, { recursive: true, force: true }); }
});

test("PV7 a script opens on a pain point and ends on one closing line, and the place is never the whole country (2026-11-14, the owner on the first video from the panel: \"'Keep putting off getting back into shape' … is not a pain point\", \"Don't say 'tap below'. CTA is always 'click the link below and we'll be in touch!'\", \"We can't say the full of Singapore no matter what\"): the closing line is one sentence for every gym, the last words of every script; 'tap below' and the country's name are refused; a script kept before the rule needs one edit and is not filmed until then; pain points are the owner's per offer — typed and kept at once, or suggested from the gym's best adverts and the library and kept by him, never a judgement of the person; the agent proposes — with none kept it works them out itself from the gym's best adverts and the library — and every draft says the one it opens on", async () => {
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
    assert.deepEqual([probs([GOOD[0], GOOD[1], "If you are ready, we will look after you from the first day. Click the link below and we'll be in touch!"]), probs([GOOD[0], GOOD[1], "If you are ready, I will look after you from the first day. Click the link below and we'll be in touch!"])], [[], ['line 3 speaks as one person ("I"): the presenter may speak for the gym (we, our, us), never as a coach or a member with a story of their own (I, my, me)']], "the gym's voice is the presenter's to use; one person's own is not");
    assert.deepEqual(probs(["If you live in Singapore and your work clothes have been fitting tighter lately, keep watching.", GOOD[1], GOOD[2]]), ['line 1 names the whole country ("Singapore"): the place is only ever {AREA}, the area around the gym']);
    assert.deepEqual(scriptProblems([GOOD[0], "Singapore Strength Club's 12 Week Full Body Transformation is built for exactly that, with a coach beside you.", GOOD[2]], { offer: OFFER, profile: { ...profile, display_name: "Singapore Strength Club" }, closing: C }), [], "the gym's own name may carry the word");
    // His to change, for every gym: the scripts kept with the old one then need an edit, and are not filmed until they have it.
    const mine = addScript(g, { lines: GOOD, offer: OFFER }, { profile, closing: C });
    assert.throws(() => setClosing(L, "Tap below now"), /4 to 14 words/); assert.throws(() => setClosing(L, "Tap the button below and the team will call you"), /does not say "tap"/);
    assert.equal(setClosing(L, "Click the link below and the team will be in touch."), "Click the link below and the team will be in touch."); const C2 = closingLine(L);
    assert.deepEqual([C2, scriptIssues(mine, { profile, closing: C2 }), readyScripts(g, OFFER, { profile, closing: C2 }).length, readyScripts(g, OFFER, { profile, closing: C }).length], ["Click the link below and the team will be in touch.", [`the last line ends with the closing line, word for word: "${C2}"`], 0, 1]);
    assert.deepEqual([noScriptWhy(g, OFFER, { libraryDir: L, profile }).state, noScriptWhy(g, OFFER, { libraryDir: L, profile }).text], ["needs_edit", `the script kept for this offer needs an edit first — the last line ends with the closing line, word for word: "${C2}": press Edit… there`]);
    assert.throws(() => pickScripts(g, { count: 1, offer: OFFER, libraryDir: L }), /^Error: 1 presenter video asked for, but no script is ready for "12 Week Full Body Transformation": the script kept for this offer needs an edit first — the last line ends with the closing line, word for word: "Click the link below and the team will be in touch\.": press Edit… there \(Draft Scenes → Video scripts\)$/);
    await assert.rejects(makePresenterVideos({ gymDir: g, outDir: join(g, "o"), store: join(g, "o", "clips"), script: mine, areas: ["BISHAN"], offer: OFFER, room, profile, closing: C2, models: fakes().models }), /this script cannot be made: .*the last line ends with the closing line/);
    decideScript(g, mine.id, { status: "draft" }, { profile, closing: C2 });
    assert.throws(() => decideScript(g, mine.id, { status: "kept" }, { profile, closing: C2 }), /^Error: edit it first: .*the last line ends with the closing line/, "a draft that breaks today's rules is not kept as it is");
    const fixed = decideScript(g, mine.id, { status: "kept", lines: [GOOD[0], GOOD[1], "If you are ready to train with people like you, now is your time. Click the link below and the team will be in touch."] }, { profile, closing: C2 }); assert.equal(fixed.status, "kept");
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
    const opening = "If you live in {AREA} and you have been avoiding fitted clothes lately, this one is for you.", CL = "If you are ready to feel at ease in your clothes, now is your time. Click the link below and the team will be in touch.";
    const seen2 = [], d2 = await draftScripts({ brandDir: g2.g, libraryDir: L, offer: OFFER, count: 3, words: LOOSE, ask: async (i2, p, schema) => { seen2.push({ p, schema }); return { scripts: [
      { pain: "avoiding fitted clothes lately.", lines: [opening, GOOD[1], CL] },
      { pain: "being overweight", lines: [opening.replace("this one is for you", "keep watching"), GOOD[1], CL] },
      { pain: "", lines: [opening.replace("this one is for you", "stay with this"), GOOD[1], CL] }] }; } });
    assert.deepEqual([d2.added.map((x) => [x.status, x.source, x.pain]), d2.dropped.map((x) => x.reason.slice(0, 60)), d2.calls, d2.sources], [[["draft", "drafted", "avoiding fitted clothes lately"]], ['the pain point it opens on ("being overweight"): "overweight', "it does not say which pain point it opens on"], 1, { pains: 0, ads: 2, library: 1 }]);
    assert.match(seen2[0].p, /PAIN POINTS\. A pain point is something that HAPPENS to this person[^\n]*"getting back into shape", "putting off fitness", "starting a fitness journey" are NOT pain points\. Work them out yourself before you write: who this advert is for, and what they are living with, drawing on the adverts below\./);
    assert.match(seen2[0].p, /--- ADVERT 1 \(80 leads\)\nFour classes/); assert.match(seen2[0].p, /--- LIBRARY 1\nLosing strength/); assert.ok(!/The owner's own list comes first/.test(seen2[0].p));
    rmSync(g2.d, { recursive: true, force: true });
    // His own kept pain points come first; the closing line follows a few words, never a line on its own; the rules are checked on every draft.
    const seen = [], dr = await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 4, words: LOOSE, ask: async (i2, p, schema) => { seen.push({ p, schema }); return { scripts: [
      { pain: "you have been avoiding fitted clothes", lines: [opening, GOOD[1], "If you are ready to feel at ease in your clothes, now is your time. Click the link below and the team will be in touch."] },
      { pain: PAIN, lines: [opening.replace("this one is for you", "stay with this"), GOOD[1], "Feel at ease in your own clothes again. Tap below to find out more today."] },
      { pain: PAIN, lines: ["If you live in Singapore and your work clothes have been fitting tighter lately, this is for you.", GOOD[1], "If you are ready to feel stronger for the day ahead, now is your time. Click the link below and the team will be in touch."] }] }; } });
    assert.deepEqual([dr.added.map((x) => [x.status, x.pain]), dr.dropped.map((x) => x.reason.slice(0, 44))], [[["draft", "you have been avoiding fitted clothes"]], ['line 3 says "Tap below": the only call to ac', 'line 1 names the whole country ("Singapore")']]);
    const P = seen[0].p;
    assert.match(P, /Line 1 says where — the place written as \{AREA\} \(it is filled in for each location\) — and opens on ONE pain point: what this person is living with and wants gone/);
    assert.match(P, new RegExp(`The owner's own list comes first — open on these, close to his words, one for each script; for the scripts beyond the list, work out further ones yourself the same way:\\n1\\. ${PAIN}\\n2\\. you have been avoiding fitted clothes(\\n|$)`));
    assert.match(P, /THE ENDING is two beats, both in the last line\. First ONE sentence that turns to the viewer and names what they want, tied to the pain the script opened on, in this shape: "If you're ready to \[what they want\], now is your time\." Then exactly this sentence, word for word; it is the ONLY call to action in the script: "Click the link below and the team will be in touch\." Never go straight from a benefit into the call to action, and never use a bare lead-in/);
    assert.match(P, /never an ideal body and never a promised result \("the body you've always wanted" is out\)\. The last line is at most 24 words in all, so keep the first sentence short\. Never write "tap", never name a button/);
    assert.match(P, /The closing sentence is said word for word as given\./); assert.match(P, /The place is only ever \{AREA\}, the area around the gym: the script never names the country/);
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
    const ALONE = [GOOD[0], GOOD[1], "If you are ready to feel stronger and more at ease, now is your time.", C];
    assert.deepEqual([closingAlone(C, C), closingAlone("click the link below and we’ll be in touch", C), closingAlone(GOOD[2], C), filmedLines(GOOD, C), filmedLines(ALONE, C)], [true, true, false, GOOD, [GOOD[0], GOOD[1], `${ALONE[2]} ${C}`]]);
    assert.deepEqual(scriptProblems(ALONE, { offer: OFFER, profile, closing: C }), []);
    const longLine = "If you are ready to feel stronger, sleep better, move more easily, have more energy for your day and feel at ease, now is your time.";
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
    const edited = decideScript(g, script.id, { lines: [GOOD[0], GOOD[1], "If you are ready to feel stronger every week, now is your time. Click the link below and we'll be in touch!"] }, { profile, closing: C });
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
    const stale = addScript(g, { lines: [GOOD[0].replace("keep watching", "listen up"), GOOD[1], "If you are ready to train with people like you, now is your time. Click the link below and we'll be in touch!"], offer: OFFER }, { profile, closing: C });
    const C2 = "Click the link below and the team will be in touch.", L = join(d, "lib"); mkdirSync(L, { recursive: true }); writeFileSync(join(L, "video-samples.json"), JSON.stringify({ schema: 1, samples: [], closing: { text: C2 } }));
    const fixedLast = "If you are ready to train with people like you, now is your time. Click the link below and the team will be in touch.";
    const asked = [], pr = await proposeEdit({ brandDir: g, id: stale.id, libraryDir: L, ask: async (i, p, schema) => { asked.push({ p, schema }); return { lines: [stale.lines[0], stale.lines[1], fixedLast], note: "The last line now ends with the closing line." }; } });
    assert.deepEqual([pr.lines, pr.changed, pr.note, pr.calls, pr.problems.some((x) => /the last line ends with the closing line, word for word/.test(x))], [[stale.lines[0], stale.lines[1], fixedLast], [3], "The last line now ends with the closing line.", 2, true]);
    assert.match(asked[0].p, /Propose the SMALLEST edit that mends it, for the owner to approve\./); assert.match(asked[0].p, /THE SCRIPT:\n1\. People in \{AREA\}/); assert.match(asked[0].p, /WHAT IS WRONG:\n- /); assert.match(asked[0].p, /Keep every line that breaks no rule exactly as it is, word for word and in its place/); assert.match(asked[0].p, /and then exactly this sentence, word for word: "Click the link below and the team will be in touch\."/); assert.match(asked[0].p, /When the script goes straight into the closing sentence, add the bridge sentence before it and change nothing else\./);
    assert.deepEqual(readScripts(g).scripts.find((x) => x.id === stale.id).lines, stale.lines, "nothing is saved by proposing");
    // He approves it (or changes it first): saved by the usual edit, checked again.
    assert.deepEqual(decideScript(g, stale.id, { lines: pr.lines }, { profile, closing: C2 }).lines, pr.lines);
    await assert.rejects(proposeEdit({ brandDir: g, id: stale.id, libraryDir: L, ask: async () => ({ lines: [], note: "" }) }), /this script breaks no rule and reads well aloud: nothing to propose/);
    // An answer that still breaks a rule is asked for once more, and then not offered.
    const stale2 = addScript(g, { lines: [GOOD[0].replace("keep watching", "hear this"), GOOD[1], "If you are ready to train with people like you, now is your time. Click the link below and we'll be in touch!"], offer: OFFER }, { profile, closing: C });
    let calls = 0;
    await assert.rejects(proposeEdit({ brandDir: g, id: stale2.id, libraryDir: L, ask: async () => { calls++; return { lines: [stale2.lines[0], stale2.lines[1], "You train with people just like you. Tap below to find out more today."], note: "x" }; } }), /^Error: the agent's edit still breaks a rule \(line 3 says "Tap below": the only call to action is the closing line\): edit the script yourself$/);
    assert.equal(calls, 2);
    let round = 0; const pr2 = await proposeEdit({ brandDir: g, id: stale2.id, libraryDir: L, ask: async (i, p) => { round++; return round === 1 ? { lines: [stale2.lines[0], stale2.lines[1], "Tap below now and the team will be in touch soon enough."], note: "x" } : { lines: [stale2.lines[0], stale2.lines[1], fixedLast], note: "Second try." }; } });
    assert.deepEqual([pr2.calls, pr2.changed, pr2.note], [3, [3], "Second try."]);
    await assert.rejects(proposeEdit({ brandDir: g, id: "v-nope", libraryDir: L, ask: async () => ({}) }), /no such script/);
    assert.equal(buildEditPrompt({ profile, script: stale2, problems: ["x"], closing: C2 }).schema.required.join(), "lines,note");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV10 how a word is said, and an ending in two beats (2026-11-14, the owner on Aether's finished video: \"'Quay' is pronounced 'Kee' in Singapore. Edge case but let's account for it too\"; \"it's too abrupt when we transition into 'Click the link below and we'll be in touch'\", with the end of his own sample as the model): a short list for every gym says how a word is said — the presenter is GIVEN the word written the way it sounds (Boat Key: told that Quay is pronounced kee, the video model still said kway, 2026-11-15), the captions keep the word as written, the check takes either spelling and is no judge of the sound (the owner's ear is: the line names the word to listen for), and adding a word films again only the lines that say it; a script's closing line follows a sentence of its own that turns to the viewer — a bare lead-in or none needs an edit — and an ideal body is never promised", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { SAID_AS, saidAs, setSaid, saidProblems, saidIn, videoNeeds, bridgeOf, isBridge, BRIDGE_WHY, BRIDGE_WORDS, CLOSING_LINE } = await import("./presenter-video.mjs");
  const { d, g, profile, room } = gym(), L = join(d, "lib"), C = CLOSING_LINE;
  try {
    // The list: the standing entry, the owner's own beside it, a change, a removal that stays removed.
    assert.deepEqual([SAID_AS, saidAs(L)], [[{ word: "Quay", say: "Key", heard: ["kee"] }], [{ word: "Quay", say: "Key", heard: ["kee"] }]]);
    assert.deepEqual([saidProblems("Quay", "kee"), saidProblems("Boat Quay", "kee").length, saidProblems("Quay", "k33").length, saidProblems("", "").length], [[], 1, 1, 2]);
    assert.deepEqual(setSaid(L, "Yishun", "ee-shoon").map((x) => [x.word, x.say]), [["Quay", "Key"], ["Yishun", "ee-shoon"]]);
    assert.throws(() => setSaid(L, "Boat Quay", "kee"), /the word is one word as it is written/);
    assert.deepEqual(setSaid(L, "Quay", "").map((x) => x.word), ["Yishun"], "a standing word taken off stays off");
    assert.deepEqual(setSaid(L, "quay", "kee").map((x) => [x.word, x.say]), [["quay", "kee"], ["Yishun", "ee-shoon"]]);
    assert.deepEqual(setSaid(L, "Yishun", "").map((x) => x.word), ["quay"]);
    const LIST = SAID_AS;
    assert.deepEqual([saidIn("If you live in Boat Quay and work late", LIST).length, saidIn("down by the quayside", LIST).length, saidIn("CLARKE QUAY", LIST).length, saidIn("People in Bishan", LIST).length], [1, 0, 1, 0], "the whole word, any case");
    // The word as said is the word as written.
    const SOUNDS = [["quay", "kee", "key"]];
    assert.deepEqual([sameWords("People in Boat Key, hello", "People in Boat Quay, hello", { sounds: SOUNDS }), sameWords("People in Boat Kee, hello", "People in Boat Quay, hello", { sounds: SOUNDS }), sameWords("People in Boat Key, hello", "People in Boat Quay, hello"), sameWords("People in Boat Tree, hello", "People in Boat Quay, hello", { sounds: SOUNDS })], [true, true, false, false]);
    // The presenter is given the word the way it sounds, capitalised as the line has it, and is told nothing about pronunciation; a line without the word is asked for as it always was.
    assert.match(clipPrompt({ presenter: { gender: "man", age: 36, look: "" }, profile, line: "People in Boat Quay, hello.", seconds: 6, said: LIST }), /at an easy conversational pace: "People in Boat Key, hello\." His mouth forms exactly these words/);
    assert.deepEqual([spokenLine("Boat Quay and CLARKE QUAY, by the quay; the quayside.", LIST), spokenLine("People in Bishan.", LIST), spokenLine("In Yishun today.", [{ word: "Yishun", say: "ee shoon" }])], ["Boat Key and CLARKE Key, by the key; the quayside.", "People in Bishan.", "In Ee shoon today."]);
    assert.equal(clipPrompt({ presenter: { gender: "man", age: 36, look: "" }, profile, line: "Hello there.", seconds: 6, said: [] }), clipPrompt({ presenter: { gender: "man", age: 36, look: "" }, profile, line: "Hello there.", seconds: 6 }));
    // Filmed with no list, then with it: only the line that says the word is filmed again; the check is told the word, takes "Key" for it, and a take heard as "kway" is made once more.
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile, closing: C }), store = join(g, "clips");
    const base = { gymDir: g, outDir: join(g, "o1"), store, script, areas: ["BOAT QUAY"], offer: OFFER, room, profile, closing: C, caps: { seconds: 120, images: 5 } };
    const A = fakes(), ra = await makePresenterVideos({ ...base, takes: 1, saidList: [], models: A.models });
    assert.deepEqual([ra.videos[0].failed, A.calls.clip.length, /is pronounced/.test(A.calls.clip[0].prompt)], [undefined, 3, false]);
    assert.match(A.calls.clip[0].prompt, /"People in Boat Quay, this one is for you\./, "with no list the line is read as written");
    assert.deepEqual([videoNeeds({ gymDir: g, script, areas: ["BOAT QUAY"], room, profile, closing: C, store, saidList: [] }).seconds, videoNeeds({ gymDir: g, script, areas: ["BOAT QUAY"], room, profile, closing: C, store, saidList: LIST }).clips.map((c) => c.on_file)], [0, [false, true, true]], "known before the run: the one line with the word");
    // The fake hears what the presenter was given ("Boat Key"): the check takes it for the word as written, one take is enough, and the line names the word for the owner's ear.
    const B = fakes(), rb = await makePresenterVideos({ ...base, takes: 2, saidList: LIST, models: B.models });
    assert.deepEqual([rb.videos[0].failed, rb.videos[0].flags, B.calls.clip.map((c) => plain(c.out)), B.calls.image.length, rb.videos[0].lines[0].takes, rb.videos[0].notes, rb.spent.seconds], [undefined, undefined, ["line-1-boat-quay.mp4"], 0, 1, [], S(GOOD[0], "BOAT QUAY")]);
    assert.ok(/"People in Boat Key, this one is for you\./.test(B.calls.clip[0].prompt) && !/is pronounced/.test(B.calls.clip[0].prompt), B.calls.clip[0].prompt);
    assert.deepEqual(rb.videos[0].words[0], GOOD[0].replace("{AREA}", "Boat Quay"), "the words on screen are the words as written");
    assert.deepEqual(rb.videos[0].parts.map((p) => p.listen), [[{ word: "Quay", say: "Key" }], undefined, undefined], "which word to listen for, and on which line");
    // How it sounded is not the check's to say (it wrote "kee" for a clip the owner heard as "kway"): whatever an old check says about it is no fault and no retake.
    const Cc = fakes(), watchC = Cc.models.watch; Cc.models.watch = async (file) => ({ ...(await watchC(file)), pronounced: [{ word: "Quay", sounded_like: "kway" }] });
    const rc = await makePresenterVideos({ ...base, outDir: join(g, "o2"), store: join(g, "clips2"), takes: 2, saidList: LIST, models: Cc.models });
    assert.deepEqual([rc.videos[0].failed, rc.videos[0].notes, Cc.calls.clip.length, existsSync(rc.videos[0].file)], [undefined, [], 3, true]);
    // ── The ending ──
    const end = (last, before = GOOD[1]) => scriptProblems([GOOD[0], before, last], { offer: OFFER, profile, closing: C });
    assert.deepEqual([BRIDGE_WORDS, end(GOOD[2])], [8, []]);
    assert.deepEqual(end(`You will feel stronger and your clothes will fit better. ${C}`), [BRIDGE_WHY], "straight from a benefit into the closing line");
    assert.deepEqual(end(`If that sounds like you, ${C.charAt(0).toLowerCase()}${C.slice(1)}`), [BRIDGE_WHY], "a bare lead-in is no bridge");
    assert.deepEqual(end(`If you want it, go. ${C}`), [BRIDGE_WHY], "a bridge is a sentence of eight words or more");
    assert.deepEqual([end(`When you are ready to feel stronger in your own body, now is the moment. ${C}`), end(`So if you are tired of feeling flat after lunch, now is your time. ${C}`)], [[], []], "it turns to the viewer: an if, or being ready");
    assert.equal(BRIDGE_WHY, 'the script goes straight into the closing line: just before it, in the same cut, one sentence turns to the viewer and names what they want — "If you\'re ready to …, now is your time." (8 words or more)');
    // The closing line as a line of its own: the bridge is the line before it, in the same cut.
    assert.deepEqual([scriptProblems([GOOD[0], GOOD[1], "If you are ready to feel stronger and more at ease, now is your time.", C], { offer: OFFER, profile, closing: C }), scriptProblems([GOOD[0], GOOD[1], "You will feel stronger and your clothes will fit better.", C], { offer: OFFER, profile, closing: C })], [[], [BRIDGE_WHY]]);
    assert.deepEqual([bridgeOf(GOOD, C), isBridge(bridgeOf(GOOD, C)), bridgeOf([GOOD[0], GOOD[1], "A benefit here. If you are ready for it, now is your time.", C], C), isBridge("If that sounds like you,")], ["If you are ready to train in small groups with people like you, now is your time.", true, "If you are ready for it, now is your time.", false]);
    // An ideal body is never promised (his ruling the same day; his sample's own ending says it, and a sample is only ever a template).
    assert.deepEqual(end(`If you're ready to get the body that you've always wanted, now is your time. ${C}`), ['line 3 promises an ideal body ("body that you\'ve always wanted"): say what the person will feel or be able to do']);
    assert.match(end(`If you are ready for your dream body by summer, now is your time. ${C}`).join(), /promises an ideal body \("dream body"\)/);
    assert.deepEqual(end(`If you are ready to feel at home in your own body again, now is your time. ${C}`), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV11 each sample is a style, and a draft follows one (2026-11-14, the owner, with seven scripts that have worked: \"I need more variation for the video scripts … more variation on style\"): a sample is read once into how it is built — a name, how it opens, its parts in order — checked in code and his to rename; a round of drafts is spread across the styles, the ones this gym has used least first, or written all in one he picks; each script says the style it follows; the drafter is given each style's parts and its script and told to take how it is built and nothing it says; the area is said only where a style calls people out by place; and the facts the samples state are proposed for the owner to tick, never said until he does", async () => {
  const { addSample, readStyle, readStyles, nameStyle, liveStyles, pickStyles, letteredStyles, styleProblems, buildStylePrompt, HOOKS, suggestFacts, buildFactsPrompt, setFacts, factsFor } = await import("./presenter-video.mjs");
  const { d, g, profile } = gym(), L = join(d, "lib"), C = "Click the link below and we'll be in touch!";
  try {
    const T1 = "Give us 6 weeks and you will go from feeling tired to feeling strong.\n\nIn Week 1, we will start with a full body diagnosis. (Voiceover)\n\nBy week 6, you will feel as energetic as you have ever been.\n\nClick the link now, let's get started!";
    const T2 = "To all my friends in the {AREA} area, in just 6 weeks from now, you could feel completely different.\n\nWe're looking for 10 individuals who want the best version of themselves.\n\nClick the button down below and we'll be in touch.";
    const T3 = "Quick question - have you started a routine full of energy, and stopped a few weeks later?\n\nThis is for you if you are done going round that cycle. This is not for you if you want a quick fix.\n\nClick that link below.";
    const a = addSample(L, T1), b = addSample(L, T2), c = addSample(L, T3);
    // Not read yet: each is still a style of its own, named by its place.
    assert.deepEqual(liveStyles(L).map((x) => [x.name, x.read, x.says_area, x.beats.length]), [["Sample 1", false, false, 0], ["Sample 2", false, true, 0], ["Sample 3", false, false, 0]]);
    // Read: one text call a sample, told the names already taken; checked in code.
    const answers = { [a.id]: { name: "Week by week", hook: "promise", beats: ["the promise for the whole programme", "what happens in week 1", "how it feels by the last week", "the ask"], says_area: false }, [b.id]: { name: "Local casting call", hook: "call-out", beats: ["a call-out to people by where they are", "who the gym is looking for", "the ask"], says_area: true }, [c.id]: { name: "Week by week", hook: "question", beats: ["a question that names the cycle", "who it is for and who it is not for", "the ask"], says_area: false } };
    const asked = [], ask = async (i, p, schema) => { asked.push({ p, schema }); const id = [a, b, c].find((x) => p.includes(x.text)).id; return answers[id]; };
    const r = await readStyles({ libDir: L, ask });
    assert.deepEqual([r, asked.length, liveStyles(L).map((x) => [x.name, x.hook, x.read, x.says_area, x.beats.length])], [{ read: 3, failed: [] }, 3, [["Week by week", "promise", true, false, 4], ["Local casting call", "call-out", true, true, 3], ["Week by week 2", "question", true, false, 3]]], "a name already taken is told apart");
    assert.match(asked[0].p, /Say how it is BUILT, so that other scripts can be written the same way for other gyms and other programmes\./); assert.match(asked[0].p, /each a short phrase saying what that part DOES and never its words/); assert.match(asked[2].p, /not one of these, which are taken: "Week by week", "Local casting call"/);
    assert.deepEqual([asked[0].schema.properties.hook.enum, buildStylePrompt("x").schema.required], [HOOKS, ["name", "hook", "beats", "says_area"]]);
    assert.deepEqual([styleProblems(answers[a.id]), styleProblems({ name: "x", hook: "shout", beats: ["one"] })], [[], ["a style's name is 3 to 40 characters", `how it opens is one of: ${HOOKS.join(", ")}`, "a style has 3 to 9 parts"]]);
    await assert.rejects(readStyle({ libDir: L, id: a.id, ask: async () => ({ name: "", hook: "promise", beats: [], says_area: false }) }), /the style could not be read \(a style's name is 3 to 40 characters\)/);
    assert.equal((await readStyles({ libDir: L, ask })).read, 0, "read once: a second pass has nothing to read");
    // His own name for one; never two alike.
    assert.equal(nameStyle(L, c.id, "Question, then the cycle").style.name, "Question, then the cycle");
    assert.throws(() => nameStyle(L, c.id, "week by week"), /another style has this name/); assert.throws(() => nameStyle(L, c.id, "x"), /3 to 40 characters/);
    // One style a script: the least used first, round again past the last; one picked style for a whole round.
    const st = liveStyles(L), ids = (xs) => xs.map((x) => x.name);
    assert.deepEqual([ids(pickStyles(st, 3)), ids(pickStyles(st, 5)), ids(pickStyles(st, 2, { used: { [a.id]: 2, [b.id]: 1 } })), pickStyles([], 3)], [["Week by week", "Local casting call", "Question, then the cycle"], ["Week by week", "Local casting call", "Question, then the cycle", "Week by week", "Local casting call"], ["Question, then the cycle", "Local casting call"], []]);
    assert.deepEqual(letteredStyles([st[0], st[1], st[0]]).map((x) => [x.letter, x.style.name, x.scripts]), [["A", "Week by week", [1, 3]], ["B", "Local casting call", [2]]]);
    // The drafter: each script given its style — its parts, its script — and told to take how it is built and nothing it says.
    const line2 = "Our 12 Week Full Body Transformation is built for exactly that, and we stay beside you every week.";
    const seen = [], dr = await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 3, words: LOOSE, ask: async (i, p, schema) => { seen.push({ p, schema }); return { scripts: [
      { style: "A", pain: "energy gone by mid-afternoon", lines: ["Give us twelve weeks, and that flat feeling after lunch stops running your whole day for you.", line2, `If you are ready to feel strong again, now is your time. ${C}`] },
      { style: "B", pain: "work clothes fitting tighter", lines: ["To everyone in {AREA} whose work clothes have been fitting tighter lately, this one is for you.", line2.replace("exactly that", "just that"), `If you are ready to feel at ease again, now is your time. ${C}`] },
      { pain: "starting and stopping", lines: ["Quick question: have you started a routine full of energy and dropped it a few weeks later?", line2.replace("exactly that", "that cycle"), `If you are ready to stop going round it, now is your time. ${C}`] }] }; } });
    assert.deepEqual([dr.added.map((x) => [x.style.name, x.style.id, x.pain, /\{AREA\}/.test(x.lines[0])]), dr.dropped, dr.styles], [[["Week by week", a.id, "energy gone by mid-afternoon", false], ["Local casting call", b.id, "work clothes fitting tighter", true], ["Question, then the cycle", c.id, "starting and stopping", false]], [], ["Week by week", "Local casting call", "Question, then the cycle"]], "a draft that names no style takes the one its place in the round was given; only the call-out style says the area");
    const P = seen[0].p;
    assert.match(P, /Each script follows ONE style — the one it is given under STYLES below — and no other: its kind of opening, its parts in their order, its rhythm and its tone, so that two scripts in two styles read as two different adverts\./);
    assert.match(P, /within its first two lines the script speaks to ONE pain point/); assert.match(P, /where its style calls people out by where they live or work, the place is written \{AREA\} \(it is filled in for each location\) — a style that does not, names no place at all\./);
    assert.match(P, /Take from a style HOW it is built, never its sentences, and never its facts, names, places, numbers, promises of results, stage directions \("\(Voiceover\)", slides\) or its call to action\. Where a style has someone introduce themselves by name, the script speaks as "we" for the gym instead\./);
    assert.match(P, /SCRIPT 1 follows STYLE A\. SCRIPT 2 follows STYLE B\. SCRIPT 3 follows STYLE C\.\n--- STYLE A — "Week by week" \(it opens with a promise\)\nIts parts, in order: 1\) the promise for the whole programme; 2\) what happens in week 1; 3\) how it feels by the last week; 4\) the ask\nThe owner's script in this style:\nGive us 6 weeks/);
    assert.match(P, /--- STYLE B — "Local casting call" \(it opens with a call-out\)/); assert.match(P, /and the style it follows \(style: its letter\)\./);
    assert.ok(!/Line 1 says where|The first line says where/.test(P), "the one fixed skeleton is gone when there are styles");
    assert.deepEqual([seen[0].schema.properties.scripts.items.properties.style.enum, seen[0].schema.properties.scripts.items.required], [["A", "B", "C"], ["style", "pain", "lines"]]);
    // The next round starts with the styles used least; a round all in one style he picks; a style that is not there is refused.
    const seen2 = []; await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 1, ask: async (i, p) => { seen2.push(p); return { scripts: [] }; } });
    decideScript(g, dr.added[1].id, { status: "retired", reason: "only for the test" }, { profile, closing: C });
    await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 1, ask: async (i, p) => { seen2.push(p); return { scripts: [] }; } });
    assert.match(seen2[0], /SCRIPT 1 follows STYLE A\.\n--- STYLE A — "Week by week"/); assert.match(seen2[1], /SCRIPT 1 follows STYLE A\.\n--- STYLE A — "Local casting call"/, "a retired script does not count as a use of its style: that style is the least used again");
    await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 2, style: c.id, ask: async (i, p) => { seen2.push(p); return { scripts: [] }; } });
    assert.match(seen2[2], /SCRIPTS 1 and 2 follow STYLE A\.\n--- STYLE A — "Question, then the cycle"/); assert.ok(!/Week by week|Local casting call/.test(seen2[2]));
    await assert.rejects(draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 1, style: "vs-nope", ask: async () => ({ scripts: [] }) }), /no such style/);
    // No sample at all: the three-line script, with no style to name.
    const g2 = gym(); const seen3 = []; await draftScripts({ brandDir: g2.g, libraryDir: join(g2.d, "empty"), offer: OFFER, count: 1, ask: async (i, p, schema) => { seen3.push({ p, schema }); return { scripts: [] }; } });
    assert.ok(/A script is exactly 3 lines\./.test(seen3[0].p) && !/STYLES —/.test(seen3[0].p) && !seen3[0].schema.properties.scripts.items.properties.style); rmSync(g2.d, { recursive: true, force: true });
    // Facts the samples state, proposed for him to tick: held to the facts' rules, the ones already on the list left out, nothing saved.
    setFacts(g, OFFER, ["Only 10 places"], { profile });
    const fa = [], sf = await suggestFacts({ brandDir: g, libraryDir: L, offer: OFFER, ask: async (i, p, schema) => { fa.push({ p, schema }); return { facts: ["A full body diagnosis at the start.", "Only 10 places", "only 10 places", "A free trial week first", "A full body diagnosis at the start", "ok"] }; } });
    assert.deepEqual([sf.suggestions, sf.dropped.map((x) => x.text), sf.calls, factsFor(g, OFFER)], [["A full body diagnosis at the start"], ["A free trial week first", "ok"], 1, ["Only 10 places"]]);
    assert.match(fa[0].p, /List every FACT they state about how a programme or a gym works/); assert.match(fa[0].p, /with no gym's name, no place and no programme's name, so the owner of another gym can tick the ones that are true there/); assert.match(fa[0].p, /--- SCRIPT 1\nGive us 6 weeks/);
    assert.equal(buildFactsPrompt(["x"]).schema.required.join(), "facts");
    await assert.rejects(suggestFacts({ brandDir: g, libraryDir: join(d, "empty"), offer: OFFER, ask: async () => ({ facts: [] }) }), /there is no sample script to read facts from/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV12 plain words (2026-11-15, the owner: \"the vocabulary in the video … must be third grade reading and below. 'mid-afternoon slumps', 'vitality', 'functional muscle', 'baseline', 'oversized jackets' should be 'jackets that are too big'\"): a script is in words a nine-year-old knows — a word on the list is named with the plain way to say it, a long word is named, and the programme's name, the gym's name and the owner's facts are said as they are; the list is his to add to, a long word his to call fine; the drafter, the editor and the pain points are told the rule, and a draft whose only fault is its words is said again in small words before it is dropped", async () => {
  const { hardWords, plainWords, setPlain, plainProblems, syllables, PLAIN_RULE, HARD_WORDS, LONG_SYLLABLES, buildPainsPrompt, buildEditPrompt, proposeEdit, setFacts, readSamples, scriptIssues, readyScripts, CLOSING_LINE } = await import("./presenter-video.mjs");
  const { d, g, profile } = gym(), lib = join(d, "lib");
  try {
    // His five, each with the plain way to say it; a word is found with its endings, and once.
    assert.deepEqual(hardWords("Beat the mid-afternoon slumps, get your vitality back with functional muscle, a new baseline, and no more oversized jackets. Slumps again.", { plain: plainWords(lib) }).map((h) => [h.word, h.say, h.why]),
      [["vitality", "energy", "listed"], ["functional", "for everyday things", "listed"], ["baseline", "where you are now", "listed"], ["slumps", "feeling tired", "listed"], ["oversized", "too big", "listed"], ["mid-afternoon", "after lunch", "listed"]]);
    assert.deepEqual(hardWords("We'll help you achieve more, sustainably, with accountability and a tailored plan.", { plain: plainWords(lib) }).map((h) => h.word), ["sustainably", "accountability", "tailored", "achieve"]);
    assert.ok(HARD_WORDS.length >= 80 && HARD_WORDS.every((x) => x.word && x.say && !hardWords(x.say, { plain: plainWords(lib) }).length), "what to say instead is itself plain");
    // A long word, by its syllables: a rule of thumb with the everyday ones let through.
    assert.deepEqual(["tired", "clothes", "stairs", "energy", "completely", "everything", "movement", "vitality", "motivation", "accountability"].map(syllables), [1, 1, 1, 3, 3, 3, 2, 4, 4, 6]);
    assert.equal(LONG_SYLLABLES, 4);
    assert.deepEqual(hardWords("You lose motivation and it gets uncomfortable, especially when everybody is exercising.", { plain: plainWords(lib) }), [{ word: "motivation", say: null, why: "long" }]);
    assert.deepEqual(hardWords("You feel tired after lunch and your jackets are too big. You want energy for the day.", { plain: plainWords(lib) }), []);
    // What is said as it is: the offer's own words, the gym's name, a fact the owner typed — and {AREA}.
    assert.deepEqual(hardWords("A real transformation in {AREA}.", { plain: plainWords(lib) }).map((h) => h.word), ["transformation"]);
    assert.deepEqual(hardWords("A real transformation in {AREA}.", { plain: plainWords(lib), allow: [OFFER] }), []);
    // In a script: the line, the word, what to say; the good script passes as it is.
    assert.deepEqual(scriptProblems(GOOD, { offer: OFFER, profile, closing: CLOSING_LINE, plain: plainWords(lib) }), []);
    const HARD = [GOOD[0], "Test Gym's 12 Week Full Body Transformation is built to bring back your vitality. A coach beside you, and real accountability.", GOOD[2]];
    assert.deepEqual(scriptProblems(HARD, { offer: OFFER, profile, closing: CLOSING_LINE, plain: plainWords(lib) }), ['line 2: "vitality" is not a plain word — say "energy"', 'line 2: "accountability" is not a plain word — say "someone to keep you going"']);
    assert.throws(() => addScript(g, { lines: HARD, offer: OFFER }, { profile, plain: plainWords(lib) }), /line 2: "vitality" is not a plain word/);
    const LONG = [GOOD[0], "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and help with motivation.", GOOD[2]];
    assert.deepEqual(scriptProblems(LONG, { offer: OFFER, profile, closing: CLOSING_LINE, plain: plainWords(lib) }), ['line 2: "motivation" is a long word — say it in small words']);
    setFacts(g, OFFER, ["Help with motivation every week"], { profile });
    assert.equal(addScript(g, { lines: LONG, offer: OFFER }, { profile, plain: plainWords(lib) }).status, "kept", "a fact the owner typed is said as he typed it");
    assert.deepEqual([scriptIssues(readScripts(g).scripts[0], { profile, plain: plainWords(lib), gymDir: g }), readyScripts(g, OFFER, { profile }).length], [[], 1]);
    // The list is the owner's: a word of his own with what to say, a long word that is fine, a standing word taken off — for every gym, kept in the shared library.
    assert.deepEqual(plainProblems("x", { say: "y" }).length, 2); assert.match(plainProblems("journey", { say: "vitality" })[0], /itself not a plain word/); assert.match(plainProblems("two words", { fine: true })[0], /one word/);
    assert.throws(() => setPlain(lib, "journey", {}), /say what to use in its place/);
    setPlain(lib, "journey", { say: "road" }); setPlain(lib, "Motivation", { fine: true }); setPlain(lib, "however", { remove: true });
    const P = plainWords(lib);
    assert.deepEqual([P.never.find((x) => x.word === "journey").say, P.never.find((x) => x.word === "journey").standing, P.fine, P.never.some((x) => x.word === "however"), P.never.length], ["road", false, ["motivation"], false, HARD_WORDS.length]);
    assert.deepEqual(hardWords("However long the journeys, keep your motivation and your vitality.", { plain: P }).map((h) => [h.word, h.say]), [["vitality", "energy"], ["journeys", "road"]]);
    assert.deepEqual(readSamples(lib).plain.map((x) => [x.word, x.say || (x.fine ? "fine" : "removed")]), [["journey", "road"], ["motivation", "fine"], ["however", "removed"]]);
    setPlain(lib, "journey", { remove: true }); setPlain(lib, "however", { remove: true });
    assert.deepEqual([plainWords(lib).never.some((x) => x.word === "journey"), readSamples(lib).plain.length], [false, 2], "his own word is taken off whole; a standing one stays off");
    // What the three writers are told.
    assert.match(PLAIN_RULE, /reading level of a nine-year-old \(third grade\)/); assert.match(PLAIN_RULE, /"jackets that are too big", not "oversized jackets"/);
    for (const p of [buildScriptPrompt({ profile, offer: OFFER }).prompt, buildPainsPrompt({ profile, offer: OFFER }).prompt, buildEditPrompt({ profile, script: { lines: HARD, offer: OFFER }, problems: ["x"] }).prompt]) assert.ok(p.includes(PLAIN_RULE));
    assert.doesNotMatch(buildScriptPrompt({ profile, offer: OFFER }).prompt + buildPainsPrompt({ profile, offer: OFFER }).prompt, /mid-afternoon(?! slumps")/, "the writers' own examples are in small words");
    assert.match(buildScriptPrompt({ profile, offer: OFFER, styles: [{ id: "vs-1", name: "Week by week", text: "Give us 6 weeks…", beats: [] }] }).prompt, /A style's or a sample's own big words are NOT carried over/);
    // The drafter: a draft whose only fault is its words is said again in small words (one more text call); one that is still not plain, or that breaks another rule too, is dropped with the reason.
    const asked = [], SECOND = [GOOD[0].replace("stronger", "fitter"), HARD[1].replace("vitality", "energy").replace("real accountability", "someone to keep you going"), GOOD[2]];
    const ask = async (img, p) => { asked.push(p);
      if (/Propose the SMALLEST edit/.test(p)) return /bring back your vitality\. A coach/.test(p) && /fitter/.test(p) ? { lines: SECOND, note: "small words" } : { lines: p.match(/^\d\. .*$/gm).map((l) => l.replace(/^\d\. /, "")), note: "nothing" };
      return { scripts: [{ pain: PAIN, lines: [SECOND[0], HARD[1], GOOD[2]] }, { pain: PAIN, lines: [GOOD[0].replace("stronger", "leaner"), HARD[1], GOOD[2]] }, { pain: PAIN, lines: [GOOD[0].replace("stronger", "better"), "I built the 12 Week Full Body Transformation to bring back your vitality, with a coach beside you.", GOOD[2]] }] }; };
    const r = await draftScripts({ brandDir: g, libraryDir: join(d, "lib2"), offer: OFFER, count: 3, ask, words: LOOSE });
    assert.deepEqual([r.calls, r.reads, r.mended, r.added.length, r.added[0].lines[1], asked.length], [3, 1, 1, 1, SECOND[1], 4]);
    assert.deepEqual(r.dropped.map((x) => x.reason.slice(0, 26)), ['line 2: "vitality" is not ', 'line 2 speaks as one perso']);
    // A script kept before the rule needs an edit, and the agent proposes it: the hard words swapped, the rest as it was.
    const data = JSON.parse(readFileSync(join(g, SCRIPTS_FILE), "utf-8")); data.scripts.push({ id: "v-old", lines: HARD, offer: OFFER, status: "kept", source: "drafted", added: "2026-11-14" }); writeFileSync(join(g, SCRIPTS_FILE), JSON.stringify(data));
    assert.equal(readyScripts(g, OFFER, { profile }).some((x) => x.id === "v-old"), false, "not filmed until it is edited");
    const prop = await proposeEdit({ brandDir: g, id: "v-old", libraryDir: join(d, "lib2"), ask: async (img, p) => { if (/^Each numbered line below is spoken aloud/.test(p)) return { lines: [] }; assert.match(p, /line 2: "vitality" is not a plain word/); assert.ok(p.includes(PLAIN_RULE)); assert.match(p, /REWRITE THE WHOLE SENTENCE it is in/); return { lines: [HARD[0], SECOND[1].replace("someone to keep you going", "someone to keep you on track"), HARD[2]], note: "Said in small words." }; } });
    assert.deepEqual([prop.changed, prop.problems.length, prop.calls], [[2], 2, 2], "the edit, and the edit read aloud before it is offered");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV13 the second kind, with exercises (2026-11-15, the owner, with a coach's video — a move in silence, then she stops and talks holding the kit: \"the coach is doing associated exercises too\"; \"agent must pick the moves … common in most gyms and look simple for the user to do. A clean and jerk is too hard … a bench press is not suitable … Russian twists with a plate or kettlebell squats would be highly adaptable\"): the same script filmed move, stop, talk — the agent picks a move for the first and last cut and a hold for the second from the pre-approved list, by the kit the room's own photos show; a move cut is pictured in its start position, asks for the move in silence before the line, is given the seconds for it, is checked for the move, and keeps a second and a half of it in the cut; a brief asks for the two kinds with one total", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { MOVES, KIT, VIDEO_KINDS, MOVE_LEAD, MOVE_KEEP, movesFor, moveLabel, kitFor, moveStillPrompt, moveClipPrompt, knownKit, kitPhotos, videosProblems, videoCount, videoKinds, MAX_VIDEOS, CLOSING_LINE } = await import("./presenter-video.mjs");
  const { d, g, profile, room } = gym();
  try {
    // The list he pre-approved: eight moves, three holds; nothing technical, heavy-looking or face-down.
    assert.deepEqual([MOVES.filter((m) => m.kind === "move").map((m) => m.id), MOVES.filter((m) => m.kind === "hold").map((m) => m.id), VIDEO_KINDS], [["russian-twist", "goblet-squat", "shoulder-press", "bicep-curl", "deadlift", "reverse-lunge", "step-up", "squat"], ["seated", "chest-hold", "foot-up"], ["presenter", "active"]]);
    assert.ok(!MOVES.some((m) => /bench.?press|clean|jerk|snatch|swing|burpee|push.?up|pull.?up|plank|rope|barbell/i.test(m.id + " " + m.name)));
    // The kit: the first of a move's own the room has; another weight for the same move; none of it, and the move is not picked.
    const M = (id) => MOVES.find((m) => m.id === id);
    assert.deepEqual([kitFor(M("goblet-squat"), KIT), kitFor(M("goblet-squat"), ["dumbbell"]), kitFor(M("russian-twist"), ["dumbbell", "plate"]), kitFor(M("step-up"), ["dumbbell"]), kitFor(M("squat"), [])], ["kettlebell", "dumbbell", "plate", null, ""]);
    assert.deepEqual([M("goblet-squat").label("dumbbell"), M("russian-twist").label("plate"), M("seated").label("box")], ["goblet squats with a dumbbell", "Russian twists with a plate", "sitting on a box"]);
    // The agent's pick: the first and last cut a move, the second a hold, the rest standing; by the script, so the same every time; never one move twice.
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), picks = movesFor(script, { kit: KIT });
    assert.deepEqual([picks.map((p) => p?.m.kind), picks[0].m.id !== picks[2].m.id, movesFor(script, { kit: KIT }).map(moveLabel)], [["move", "hold", "move"], true, picks.map(moveLabel)]);
    const five = movesFor({ id: "v-five", lines: [GOOD[0], GOOD[1], GOOD[1].replace("exactly", "just"), GOOD[1].replace("exactly", "only"), GOOD[2]] }, { kit: KIT });
    assert.deepEqual(five.map((p) => p?.m.kind || "standing"), ["move", "hold", "standing", "standing", "move"]);
    assert.deepEqual(movesFor(script, { kit: [] }).map(moveLabel), ["bodyweight squats", null, null], "a room with no kit on show: one bodyweight move, the rest standing");
    assert.ok(movesFor(script, { kit: ["dumbbell"] }).every((p) => !p || ["dumbbell", ""].includes(p.k)), "only kit the room shows");
    // A cut whose words leave no room for a move inside the model's longest clip is a hold instead.
    const long = movesFor({ id: "v-long", lines: [GOOD[0], GOOD[1], "If you are ready to feel strong again and to have more energy for the long days at work and at home with the ones you love, now is your time.", CLOSING_LINE] }, { kit: KIT, closing: CLOSING_LINE });
    assert.deepEqual(long.map((p) => p?.m.kind), ["move", "hold", "hold"]);
    // A brief: the two kinds, MAX_VIDEOS between them; the talking ones are picked first.
    assert.deepEqual([videosProblems({ presenter: 1, active: 2 }), videoCount({ presenter: 1, active: 2 }), videoKinds({ presenter: 1, active: 2 }), videoCount({ active: 1 }), videoCount({ presenter: 2 })], [[], 3, ["presenter", "active", "active"], 1, 2]);
    assert.match(videosProblems({ presenter: 2, active: 2 })[0], /at most 3 presenter videos in all/); assert.match(videosProblems({ active: MAX_VIDEOS + 1 })[0], /videos\.active must be a whole number from 0 to 3/); assert.match(videosProblems({ walking: 1 })[0], /not a kind of video \(presenter, active, paper\)/);
    // The prompts: the picture is the start of the move; the clip is the move in silence, then the line said in place; a hold is said as it is held.
    const P = presenterOf(profile), twist = { m: M("russian-twist"), k: "plate" }, seat = { m: M("seated"), k: "box" };
    assert.match(moveStillPrompt({ presenter: P, profile, move: twist, kit: KIT }), /The person is the SAME person as in the first image.*He sits on the gym floor, side-on to the camera.*holding one round black weight plate in both hands.*fills the width of the frame\..*There is no text of any kind/);
    assert.match(moveStillPrompt({ presenter: P, profile, move: seat, kit: ["box"] }), /He sits on a black wooden box.*his hands loosely together/); assert.match(moveStillPrompt({ presenter: P, profile, move: seat, kit: KIT }), /one dumbbell held loosely in one hand/);
    assert.match(moveClipPrompt({ presenter: P, profile, line: "Hello there.", seconds: 9, move: twist }), /^Bring this photograph to life as 9 seconds of video\. For the first two seconds he says nothing and does two smooth Russian twists: .* Then he stops, holds the plate still against his chest, turns his face to the camera, looks into the lens and says, .*pace: "Hello there\." .*He stays seated on the floor\./);
    assert.match(moveClipPrompt({ presenter: P, profile, line: "Hello there.", seconds: 9, move: seat }), /The man keeps looking into the camera and says, .*pace: "Hello there\." .*He stays seated and keeps his hands low and still/);
    // Filmed: the room's photos are read once for their kit; the presenter's own picture comes first, then each cut's; a move cut is given the seconds for the move and keeps a second and a half of it.
    const kitRead = [], F1 = fakes({ moved: () => true }); F1.models.kit = async (p) => { kitRead.push(plain(p)); return ["dumbbell", "plate", "box"]; };
    assert.deepEqual([knownKit(g, room), kitPhotos(g, room).map(plain)], [null, ["room.png"]]);
    const out = join(g, "outputs", "b1", "videos"), logged = [];
    const need0 = videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, kind: "active" });
    const R = await makePresenterVideos({ gymDir: g, outDir: out, script, areas: ["BISHAN"], offer: OFFER, room, profile, kind: "active", caps: { seconds: 120, images: 8 }, takes: 2, models: F1.models, log: (m) => logged.push(m) });
    const mine = movesFor(script, { kit: ["dumbbell", "plate", "box"] }), v = R.videos[0];
    assert.deepEqual([kitRead, knownKit(g, room)], [["room.png"], ["dumbbell", "plate", "box"]]);
    assert.ok(logged.some((m) => m === `with exercises — line 1: ${moveLabel(mine[0])}, then the line · line 2: ${moveLabel(mine[1])} · line 3: ${moveLabel(mine[2])}, then the line`), logged.join("\n"));
    assert.deepEqual(F1.calls.image.map((c) => c.refs.map(plain)), [["room.png"], ["still-1.jpg", "room.png"], ["still-1.jpg", "room.png"], ["still-1.jpg", "room.png"]], "the presenter's own picture first, from the room; every cut's picture from it and the room");
    assert.match(F1.calls.image[0].prompt, /standing beside the dumbbell rack/); assert.ok(F1.calls.image[1].prompt.includes(mine[0].m.pose({ He: "He", he: "he", his: "his" }, mine[0].k, (k) => ["dumbbell", "plate", "box"].includes(k))));
    assert.deepEqual(F1.calls.clip.map((c) => c.seconds), [S1 + MOVE_LEAD, S2, S3 + MOVE_LEAD]); assert.match(F1.calls.clip[0].prompt, /For the first two seconds he says nothing and does two/); assert.match(F1.calls.clip[1].prompt, /keeps looking into the camera and says/);
    assert.deepEqual([v.kind, v.failed, v.flags, v.moves, v.parts.map((p) => p.move)], ["active", undefined, undefined, [1, 2, 3].map((n) => ({ line: n, move: moveLabel(mine[n - 1]) })), mine.map(moveLabel)]);
    assert.deepEqual(v.lines.map((l) => l.speech.kept[0]), [Math.max(0, QUIET_START - MOVE_KEEP), Math.round((QUIET_START - LEAD) * 100) / 100, Math.max(0, QUIET_START - MOVE_KEEP)], "the cut keeps the move before the first word; a hold is cut to its voice as always");
    assert.deepEqual([need0.images, need0.seconds, need0.clips.map((c) => !!c.move)], [4, S1 + S2 + S3 + 2 * MOVE_LEAD, [true, true, true]], "before the first run the plan counts on every kit: the pictures and seconds are the same");
    // On file afterwards: nothing to film, nothing to picture; the same script filmed talking uses the same presenter's picture and films its own clips.
    const need1 = videoNeeds({ gymDir: g, script, areas: ["BISHAN"], room, profile, kind: "active" }); assert.deepEqual([need1.seconds, need1.images, need1.reused], [0, 0, S1 + S2 + S3 + 2 * MOVE_LEAD]);
    const F2 = fakes(); const T = await makePresenterVideos({ gymDir: g, outDir: join(g, "outputs", "b2", "videos"), script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 120, images: 8 }, takes: 2, models: F2.models });
    assert.deepEqual([T.videos[0].kind, T.videos[0].moves, F2.calls.image.length, F2.calls.clip.map((c) => c.seconds)], ["presenter", undefined, 2, [S1, S2, S3]], "its own clips, the words alone; two pictures, the presenter's own being on file");
    assert.ok(F2.calls.image.every((c) => plain(c.refs[0]) === "still-1.jpg"), "one presenter for both kinds of the script");
    // The check: a move that was not done fails the take; the cut is made all the same, flagged, for the owner to decide.
    const B = gym(), s2 = addScript(B.g, { lines: GOOD, offer: OFFER }, { profile: B.profile }), F3 = fakes({ moved: (line) => !/this one is for you/.test(line) });
    try {
      const X = await makePresenterVideos({ gymDir: B.g, outDir: join(B.g, "outputs", "b1", "videos"), script: s2, areas: ["BISHAN"], offer: OFFER, room: B.room, profile: B.profile, kind: "active", caps: { seconds: 120, images: 8 }, takes: 1, models: F3.models });
      assert.deepEqual([X.videos[0].flags.length, X.videos[0].flags[0].line, X.videos[0].flags[0].kind], [1, 1, "move"]); assert.match(X.videos[0].flags[0].why, /^the move \(.+\) was not done before the line$/);
      assert.equal(judgeClip({ spoken: "Hi there", people: 1, lettering: [], faults: [], did_move: false }, "Hi there", { move: seat }).passed, true, "a hold has no move to check");
      assert.equal(judgeClip({ spoken: "Hi there", people: 1, lettering: [], faults: [] }, "Hi there", { move: twist }).passed, true, "a check that does not say is not held against the take");
      await assert.rejects(makePresenterVideos({ gymDir: B.g, outDir: join(B.g, "o"), script: s2, areas: ["BISHAN"], offer: OFFER, room: B.room, profile: B.profile, kind: "dancing", models: F3.models }), /no such kind of presenter video/);
    } finally { rmSync(B.d, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV14 takes said as written the first time (2026-11-16, the owner on a batch that lost a third of its filming: \"if an output fails, I'm wasting money AND time\"; \"this is horrible grammar from the script drafting\"): a drafted line is at most 17 words (the last 22, more for a longer closing sentence) and a longer one is said again or dropped; every draft is read aloud by one more call, a line that does not read as speech is rewritten once and then dropped; the edit rewrites the sentence, is read aloud before it is offered, and is proposed for a script that breaks no rule but reads badly; the presenter is told to stop and stay silent after the line; a clip is given a little less spare time; a take refused for its words is heard once more by its sound alone before a second is filmed again; a move cut is never filmed again for a small note", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { DRAFT_WORDS, CLIP_PAD, READ_MIN, READ_RULE, draftLengths, lastWords, readAloud, buildReadPrompt, silentAfter, clipPrompt, moveClipPrompt, MOVES, judgeClip, buildEditPrompt, proposeEdit, CLOSING_LINE, movesFor, KIT } = await import("./presenter-video.mjs");
  const { d, g, profile, room } = gym();
  try {
    const C = CLOSING_LINE, L = join(d, "lib");
    const A = ["People in {AREA}, this one is for you. Do your work clothes feel tight?", "Test Gym's 12 Week Full Body Transformation is built for that, with a coach beside you.", `If you are ready to feel strong every day, now is your time. ${C}`];
    // The lengths, in code.
    assert.deepEqual([DRAFT_WORDS, CLIP_PAD, READ_MIN, lastWords(C), lastWords("Click the link below and the team will be in touch.")], [{ line: 17, last: 22 }, 0.8, 8, 22, 24]);
    assert.deepEqual(draftLengths(A, C), []);
    const LONG1 = "People in {AREA}, this one is for you. Have your work clothes been feeling tight on you for months?";
    assert.deepEqual(draftLengths([LONG1, A[1], A[2]], C), ["line 1 is 21 words: a drafted line is at most 17, so that it is said cleanly in one take — say it shorter, or split it in two lines"]);
    assert.match(draftLengths([A[0], A[1], `If you are ready to feel strong and sure of yourself every single day, now is your time. ${C}`], C)[0], /^line 3 is 27 words: a drafted line is at most 22/);
    assert.deepEqual(draftLengths([A[0], A[1], "If you are ready to feel strong every day, now is your time.", C], C), [], "the closing line on its own is measured with the line it is filmed with");
    assert.deepEqual([clipSeconds(Array(17).fill("word").join(" ")), clipSeconds(Array(20).fill("word").join(" ")), clipSeconds(Array(15).fill("word").join(" "))], [7, 8, 7]);
    // What the writers are told.
    const DP = buildScriptPrompt({ profile, offer: OFFER }).prompt;
    assert.match(DP, /Each line is one breath, 10 to 17 words and never more/); assert.ok(DP.includes(READ_RULE)); assert.match(DP, /The last line is at most 22 words in all, so keep the first sentence short\./);
    const EP = buildEditPrompt({ profile, script: { lines: A, offer: OFFER }, problems: ["x"] }).prompt;
    assert.match(EP, /REWRITE THE WHOLE SENTENCE it is in, so that it says the same thing in small words and reads as something a person would say out loud\. Never swap the word and leave the rest standing/); assert.ok(EP.includes(READ_RULE)); assert.match(EP, /A line you change is at most 17 words \(the last line 22\)\./);
    // Read aloud: one call for every script of a round; a line under 8 is a fault, in words; an answer that cannot be read judges nothing and says so.
    const RP = buildReadPrompt({ scripts: [A, [A[0], "x y"]], offer: OFFER, profile }).prompt;
    assert.match(RP, /score it 1 to 10 for how natural it is as something a person would SAY/); assert.match(RP, /THE LINES:\n1\.1 People in \{AREA\}, this one is for you\. Do your work clothes feel tight\?\n1\.2 /); assert.match(RP, /\n2\.2 x y/); assert.match(RP, /Do NOT judge what the line claims, how long it is in words, or these fixed parts.*"12 Week Full Body Transformation".*"Test Gym"/);
    let got = await readAloud([A, A], { offer: OFFER, profile, ask: async () => ({ lines: [{ id: "1.1", score: 9, why: "" }, { id: "1.2", score: 8, why: "" }, { id: "2.3", score: 5, why: '"feel strong every day" is said twice' }, { id: "9.9", score: 1, why: "no such line" }] }) });
    assert.deepEqual([got.faults, got.unread], [[[], [{ line: 3, score: 5, why: '"feel strong every day" is said twice' }]], false]);
    got = await readAloud([A], { offer: OFFER, profile, ask: async () => ({ scripts: [] }) }); assert.deepEqual([got.faults, got.unread], [[[]], true]);
    // Drafting: a long line is said again; a line that does not read as speech is rewritten once; one that still does not is dropped.
    const B_LONG = [LONG1, A[1].replace("that,", "just that,"), A[2]], B_SHORT = ["People in {AREA}, this one is for you. Have your work clothes been feeling tight?", A[1].replace("that,", "just that,"), A[2]];
    const CLUMSY = ["Stairs leave you out of breath? You are not alone in that.", "Our 12 Week Full Body Transformation gives you plenty of energy that lasts left for evenings.", `If you are ready to climb stairs with ease, now is your time. ${C}`], C_FIXED = [CLUMSY[0], "Our 12 Week Full Body Transformation leaves you with lots of energy for your evenings.", CLUMSY[2]];
    const D_BAD = ["Do you start a plan and stop two weeks later? Many people do.", "Our 12 Week Full Body Transformation is here to help you every step.", `If you are ready to keep going this time, now is your time. ${C}`];
    const asked = [];
    const ask = async (img, p) => { asked.push(p);
      if (/^Each numbered line below is spoken aloud/.test(p)) { const ids = [...p.matchAll(/^(\d+)\.(\d+) (.*)$/gm)]; return { lines: ids.map(([, s, i, text]) => ({ id: `${s}.${i}`, score: /energy that lasts left|help you every step|help you with each step/.test(text) ? 4 : 9, why: /energy that lasts left/.test(text) ? '"plenty of energy that lasts left" is stitched together' : /every step|each step/.test(text) ? '"help you every step" is not finished' : "" })) }; }
      if (/Propose the SMALLEST edit/.test(p)) return /feeling tight on you for months/.test(p) ? { lines: B_SHORT, note: "shorter" } : /gives you plenty of energy that lasts left/.test(p) ? { lines: C_FIXED, note: "rewritten" } : { lines: [D_BAD[0], D_BAD[1].replace("every step", "with each step"), D_BAD[2]], note: "tried" };
      return { scripts: [{ pain: PAIN, lines: A }, { pain: PAIN, lines: B_LONG }, { pain: "stairs leave you out of breath", lines: CLUMSY }, { pain: "starting a plan and stopping", lines: D_BAD }] }; };
    const r = await draftScripts({ brandDir: g, libraryDir: L, offer: OFFER, count: 4, ask });
    assert.deepEqual([r.added.map((x) => x.lines), r.calls, r.reads, r.mended, r.unread], [[A, B_SHORT, C_FIXED], 4, 2, 2, false], "one drafting call, one to shorten, two to rewrite; two readings");
    assert.deepEqual(r.dropped.map((x) => x.reason), ['line 2 does not read as something a person would say out loud ("help you every step" is not finished), after one rewrite']);
    assert.match(asked.find((p) => /Propose the SMALLEST edit/.test(p) && /gives you plenty of energy that lasts left/.test(p)), /WHAT IS WRONG:\n- line 2 does not read as something a person would say out loud \("plenty of energy that lasts left" is stitched together\)/);
    // The proposed edit, for a kept script that breaks no rule and reads badly; one that reads well has nothing to propose; an edit that reads badly twice is not offered.
    const kept = addScript(g, { lines: CLUMSY, offer: OFFER }, { profile, closing: C });
    assert.deepEqual(scriptProblems(kept.lines, { offer: OFFER, profile, closing: C }), [], "no rule sees it");
    const pr = await proposeEdit({ brandDir: g, id: kept.id, libraryDir: L, ask });
    assert.deepEqual([pr.lines, pr.changed, pr.calls, pr.problems], [C_FIXED, [2], 3, ['line 2 does not read as something a person would say out loud ("plenty of energy that lasts left" is stitched together)']]);
    const fine = readScripts(g).scripts.find((x) => x.lines[0] === A[0]);
    await assert.rejects(proposeEdit({ brandDir: g, id: fine.id, libraryDir: L, ask }), /^Error: this script breaks no rule and reads well aloud: nothing to propose$/);
    const bad = addScript(g, { lines: D_BAD, offer: OFFER }, { profile, closing: C });
    await assert.rejects(proposeEdit({ brandDir: g, id: bad.id, libraryDir: L, ask }), /^Error: the agent's edit does not read well aloud \(line 2 does not read as something a person would say out loud \("help you every step" is not finished\)\): edit the script yourself$/);
    // The presenter stops and stays silent after the line, in both kinds of clip.
    const man = { gender: "man", age: 36, look: "" }, woman = { gender: "woman", age: 30, look: "" };
    assert.equal(silentAfter(man), "When the sentence is finished he stops talking: he closes his mouth, keeps looking into the lens with a small smile and stays silent until the clip ends — no more words, nothing said twice.");
    assert.match(silentAfter(woman), /she stops talking: she closes her mouth/);
    const cp = clipPrompt({ presenter: man, profile, line: "Hello there, this is the line.", seconds: 6 }), mp = moveClipPrompt({ presenter: man, profile, line: "Hello there, this is the line.", seconds: 10, move: { m: MOVES.find((m) => m.id === "bicep-curl"), k: "dumbbell" } });
    for (const p of [cp, mp]) { assert.ok(p.includes(`"Hello there, this is the line." His mouth forms exactly these words, once, in time with his voice. ${silentAfter(man)}`), p); assert.doesNotMatch(p, /says nothing else; the sentence is finished before the clip ends/); }
    // A second listen: the watching pass's words, or — once it has been heard by its sound alone — those.
    const J = (seen) => judgeClip({ people: 1, lettering: [], faults: [], ...seen }, "Plenty of energy left for your evenings.", { profile });
    assert.deepEqual([J({ spoken: "Plenty of energy left over for your evenings." }).kind, J({ spoken: "Plenty of energy left over for your evenings.", heard: "Plenty of energy left for your evenings." }).passed, J({ spoken: "Plenty of energy left over for your evenings.", heard: "Plenty of energy energy left for your evenings." }).kind, J({ spoken: "Plenty of energy left for your evenings.", heard: "" }).passed], ["words", true, "words", true]);
    // In a run: refused for its words by the watching pass, heard as written by sound alone — no second take is filmed; a take both hear wrong is filmed again.
    const script = readScripts(g).scripts.find((x) => x.lines[0] === A[0]); decideScript(g, script.id, { status: "kept" }, { profile, closing: C });
    const base = { gymDir: g, script, areas: ["BISHAN"], offer: OFFER, room, profile, caps: { seconds: 200, images: 9 }, takes: 2 };
    const H = fakes({ say: (line) => (/built for that/.test(line) ? line.replace("built for that", "made for that") : line) }), heardCalls = [], log = [];
    H.models.hear = async (file) => { heardCalls.push(file); return A[1]; };
    let v = await makePresenterVideos({ ...base, outDir: join(g, "h1"), store: join(g, "h1", "clips"), models: H.models, log: (m) => log.push(m) });
    assert.deepEqual([v.videos[0].failed, v.videos[0].flags, H.calls.clip.length, heardCalls.length, v.spent.checks], [undefined, undefined, 3, 1, 4], "three clips, three checks and one second listen");
    assert.ok(log.some((l) => /line-2-[0-9a-f]{6}\.mp4: heard again by its sound alone, the words are as written/.test(l)), log.join("\n"));
    const H2 = fakes(); H2.models.hear = async () => { throw new Error("not asked"); };
    v = await makePresenterVideos({ ...base, outDir: join(g, "h1b"), store: join(g, "h1", "clips"), models: H2.models });
    assert.deepEqual([H2.calls.clip.length, H2.calls.watch.length, v.spent.checks, v.videos[0].flags], [0, 0, 0, undefined], "the second listen is kept with the check: a later run films nothing and asks nothing");
    const W = fakes({ say: (line, n, file) => (/built for that/.test(line) && !/take2/.test(file) ? line.replace("built for that", "made for that") : line) }); let heard2 = 0; W.models.hear = async () => { heard2++; return A[1].replace("built for that", "made for that"); };
    v = await makePresenterVideos({ ...base, outDir: join(g, "h2"), store: join(g, "h2", "clips"), models: W.models });
    assert.deepEqual([v.videos[0].flags, W.calls.clip.length, heard2, v.videos[0].lines[1].takes], [undefined, 4, 1, 2], "both heard it wrong: it is filmed again");
    // A move cut is never filmed again for a small note; a talking cut still has its one retake.
    const picks = movesFor(script, { kit: KIT }), N = fakes({ faults: () => ["slight facial distortion"], moved: () => true }), nlog = [];
    v = await makePresenterVideos({ ...base, kind: "active", outDir: join(g, "n1"), store: join(g, "n1", "clips"), takes: 3, models: N.models, log: (m) => nlog.push(m) });
    const perCut = picks.map((p, i) => N.calls.clip.filter((c) => new RegExp(`/line-${i + 1}-`).test(c.out)).length);
    assert.deepEqual([picks.map((p) => p?.m.kind), perCut, v.videos[0].failed, v.videos[0].notes], [["move", "hold", "move"], [1, 2, 1], undefined, ["slight facial distortion"]]);
    assert.ok(!nlog.some((l) => /line-1-.*made once more/.test(l)) && nlog.some((l) => /line-2-.*made once more/.test(l)), nlog.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
