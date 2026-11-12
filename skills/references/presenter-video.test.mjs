// presenter-video.test.mjs — a presenter talking to camera (PV1–PV4). No model call: the still, the clip and the
// watching pass are fakes; the cut and the words are real (ffmpeg and headless Chrome), so the finished file is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { presenterOf, presenterWords, presenterProblems, PRESENTER_GENDERS, scriptProblems, addScript, decideScript, readScripts, keptScripts, scriptCost, buildScriptPrompt, draftScripts, sameWords, fillLine, clipSeconds, captions, lockWords, stillPrompt, clipPrompt, makePresenterVideos, durationOf, hasFfmpeg, SCRIPTS_FILE, LINES, LINE_WORDS, CLIP_SECONDS, END_CARD_SECONDS, FIRST_PERSON, LIVE, USD_PER_SECOND } from "./presenter-video.mjs";
import { PROFILE_STARTER, validateProfile } from "./client-config.mjs";

const OFFER = "12 Week Full Body Transformation";
const GOOD = [
  "People in {AREA}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.",
  "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and a plan that fits your week.",
  "You train in small groups, with people just like you. Tap below to find out more.",
];
const S = (line, area) => clipSeconds(fillLine(line, area)), S1 = S(GOOD[0], "BISHAN"), S1B = S(GOOD[0], "ANG MO KIO"), S2 = S(GOOD[1], ""), S3 = S(GOOD[2], "");
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
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=180x320:r=24:d=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]); },
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
    const r = await draftScripts({ brandDir: g, offer: OFFER, audience: "LADIES WANTED", count: 4, ask });
    assert.deepEqual([asked.length, asked[0].img, r.calls, r.added.length, r.added[0].status, r.added[0].source], [1, null, 1, 1, "draft", "drafted"]);
    assert.deepEqual(r.dropped.map((x) => x.reason.slice(0, 36)), ["line 2 speaks as the gym or a member", "the script must name the offer in it", "this script is already here"]);
    assert.deepEqual(keptScripts(g, OFFER), [], "a draft is not made into a video until the owner keeps it");
    await assert.rejects(draftScripts({ brandDir: g, offer: "", ask }), /exact words are needed/); await assert.rejects(draftScripts({ brandDir: g, offer: OFFER, count: 9, ask }), /count must be 1 to 6/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PV3 one script, a video for each location: a still for each line (the first from the room, the rest from the first, so it is one person), a clip for each line — the line that says the area once a location, the others once and shared — each watched: a clip that says other words is made again; the cut is real (the clips, the last frame held for the end card), every word on screen is set by software inside Meta's live area, and what was spent is counted", { skip: !hasFfmpeg() && "ffmpeg is not installed" }, async () => {
  const { d, g, profile, room } = gym();
  try {
    const script = addScript(g, { lines: GOOD, offer: OFFER }, { profile }), out = join(g, "outputs", "b1", "videos");
    // The first take of line 2 says something else; its second take is right. Line 3's only fault is seen on both of its takes.
    let l2 = 0; const F = fakes({ say: (line) => (/built for exactly that/.test(line) && ++l2 === 1 ? "Test Gym's 12 week programme is built for that." : line), faults: (line, n, file) => (/small groups/.test(line) ? (/take2/.test(file) ? ["a stiff hand"] : ["warped fingers", "a stiff hand"]) : []) });
    const log = [], prog = [];
    const R = await makePresenterVideos({ gymDir: g, outDir: out, script, areas: ["BISHAN", "ANG MO KIO"], offer: OFFER, audience: "LADIES WANTED", room, profile, caps: { seconds: 80, images: 5 }, takes: 2, models: F.models, log: (m) => log.push(m), onProgress: (p) => prog.push(p) });
    // Stills: three, the first from the room alone, the others from the first still and the room.
    assert.deepEqual(F.calls.image.map((c) => c.refs.map((r) => r.split("/").pop())), [["room.png"], ["still-1.jpg", "room.png"], ["still-1.jpg", "room.png"]]);
    assert.match(F.calls.image[0].prompt, /^A real photograph taken on a phone held upright, 9:16\. He is a Singaporean man of about 36, .* standing beside the dumbbell rack\./); assert.match(F.calls.image[1].prompt, /The person is the SAME person as in the first image/);
    assert.ok(F.calls.image.every((c) => /There is no text of any kind anywhere in the picture/.test(c.prompt) && /nobody in that image appears/.test(c.prompt)));
    // Clips: line 1 once a location; line 2 twice (other words, made again); line 3 twice (a noted fault, made once more); the shared lines are never made again for the second location.
    assert.deepEqual(F.calls.clip.map((c) => [c.out.split("/").pop(), c.seconds, c.image.split("/").pop()]), [["line-1-bishan.mp4", S1, "still-1.jpg"], ["line-2.mp4", S2, "still-2.jpg"], ["line-2-take2.mp4", S2, "still-2.jpg"], ["line-3.mp4", S3, "still-3.jpg"], ["line-3-take2.mp4", S3, "still-3.jpg"], ["line-1-ang-mo-kio.mp4", S1B, "still-1.jpg"]]);
    assert.match(F.calls.image[1].prompt, /a different part of the room from the first image.*a step closer, framed from the chest up/); assert.match(F.calls.image[2].prompt, /a few steps back, framed from the thighs up/);
    assert.match(F.calls.clip[0].prompt, /says, in a warm, natural Singaporean English voice, at an easy conversational pace: "People in Bishan, this one is for you\./); assert.match(F.calls.clip[5].prompt, /"People in Ang Mo Kio, this one is for you\./);
    assert.ok(F.calls.clip.every((c) => /Exactly one person is in the room for the whole clip/.test(c.prompt) && /His mouth forms exactly these words/.test(c.prompt)));
    assert.deepEqual(R.spent, { seconds: S1 + S2 + S2 + S3 + S3 + S1B, images: 3, checks: 6 });
    assert.ok(log.some((l) => /line-3\.mp4: said as written, one person, no lettering · noted: warped fingers; a stiff hand — made once more/.test(l)), log.join("\n"));
    assert.ok(log.some((l) => /line-2\.mp4: it said "Test Gym's 12 week programme is built for that\."/.test(l)) && log.some((l) => /line-2-take2\.mp4: said as written, one person, no lettering/.test(l)), log.join("\n"));
    // Two finished videos, each its own first line and the shared others.
    assert.deepEqual(R.videos.map((v) => [v.area, v.failed, v.file.split("/").pop(), v.lines.map((l) => l.file.split("/").pop()), v.lines[1].takes]), [
      ["BISHAN", undefined, `${script.id}-bishan.mp4`, ["line-1-bishan.mp4", "line-2-take2.mp4", "line-3-take2.mp4"], 2], ["ANG MO KIO", undefined, `${script.id}-ang-mo-kio.mp4`, ["line-1-ang-mo-kio.mp4", "line-2-take2.mp4", "line-3-take2.mp4"], 2]]);
    assert.deepEqual(R.videos[0].words, [GOOD[0].replace("{AREA}", "Bishan"), GOOD[1], GOOD[2]]); assert.deepEqual(R.videos[0].notes, ["a stiff hand"], "the cleaner take is kept; what is still noticed is kept for the owner, and is no refusal");
    for (const v of R.videos) {
      assert.ok(existsSync(v.file) && existsSync(v.poster));
      assert.ok(Math.abs(durationOf(v.file) - ((v.area === "BISHAN" ? S1 : S1B) + S2 + S3 + END_CARD_SECONDS)) < 0.4, `the three clips and the end card: ${durationOf(v.file)}`); assert.equal(v.seconds, Math.round(durationOf(v.file) * 10) / 10);
      assert.equal(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "csv=p=0", v.file]).toString().trim(), "h264,720,1280");
      assert.ok(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", v.file]).toString().trim() === "aac", "it has sound");
    }
    // The words on screen are software's: captions a few words at a time, the end card from the brief's own words.
    assert.deepEqual(captions("one two three four five six seven", 0, 7).map((c) => c.text), ["one two three", "four five six", "seven"]);
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
