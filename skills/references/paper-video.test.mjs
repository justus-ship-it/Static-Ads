// paper-video.test.mjs — the white-paper video (PP1–PP4). No model call: the picture, the clips, the reading and the
// watching pass are fakes; finding the paper, writing on it, measuring the drop and the cut are real (headless Chrome
// and ffmpeg), so the finished file is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { SHEETS, SHEET_WORDS, SHEET_SECONDS, MIN_HOLD, DROP_KEEP, SHEET_FADE, LAST_KEEP, PAPER, PAPER_FONT, SCARCE, scarceSheets, scarcityOf, sheetProblems, addSheetScript, decideSheetScript, readSheetScripts, keptSheetScripts, readySheetScripts, sheetIssues, pickSheetScripts, noSheetScriptWhy, sheetCost, buildSheetPrompt, draftSheetScripts, blankPrompt, sheetClipPrompt, paperFacts, dropFrom, judgeSheet, sameWriting, inkText, paperNeeds, makePaperVideos } from "./paper-video.mjs";
import { addScript, readScripts, setFacts, fillLine, clipStore, setAside, keepTake, durationOf, hasFfmpeg, LIVE, USD_PER_SECOND, USD_PER_IMAGE, videosProblems, videoCount, videoKinds, spokenCount, paperCount } from "./presenter-video.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";
import { launchBrowser } from "./render-composites.mjs";

// The shared library (the closing line, the plain words) is never the real one in a test.
process.env.VIDEO_LIBRARY_DIR = mkdtempSync(join(tmpdir(), "pp-lib-"));
const OFFER = "12 Week Full Body Transformation", CLOSING = "Click the link below and we'll be in touch!";
const GOOD = ["Do your work clothes feel tight?", "Live near {AREA}?", "Join our 12 Week Full Body Transformation", "You get a coach beside you", "And a plan that fits your week", "Feel strong for everyday things", CLOSING];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function gym({ presenter = { gender: "man", age: 36 } } = {}) {
  const d = mkdtempSync(join(tmpdir(), "pp-")), g = join(d, "brands", "testgym"); mkdirSync(join(g, "brand-assets", "facility-clean"), { recursive: true });
  const profile = { ...PROFILE_STARTER("testgym", "Test Gym", "SG") }; profile.creative_defaults = { ...(profile.creative_defaults || {}), ...(presenter ? { presenter } : {}) };
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile)); writeFileSync(join(g, "brand-assets", "facility-clean", "room.png"), PNG);
  return { d, g, profile, room: join(g, "brand-assets", "facility-clean", "room.png") };
}
// A picture of "the presenter holding paper": grey, with a white sheet. BOX: 44% of the width, high enough for its words to sit in Meta's live area.
const BOX = { x: 200, y: 400, w: 320, h: 450 }, SMALL = { x: 300, y: 500, w: 120, h: 170 }, LOW = { x: 200, y: 760, w: 320, h: 450 };
const ffm = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const picture = (out, b) => ffm(["-f", "lavfi", "-i", "color=c=0x707070:s=720x1280", "-vf", `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=white:t=fill`, "-frames:v", "1", "-q:v", "2", out]);
/**
 * Fake models. The picture is grey with a white sheet; a clip is real video made from the picture it was given (the
 * words software wrote on it), the sheet going blank at `dropAt` — never for the last sheet, which is held; the
 * reading answers the sheet's own words unless told otherwise; the watching pass hears nobody.
 */
function fakes({ sheets = GOOD, areas = ["BISHAN"], boxes = [BOX], read = (text) => text, dropAt = () => 2.7, spoken = () => "", people = () => 1, faults = () => [], lettering = () => [] } = {}) {
  const calls = { image: [], clip: [], read: [], watch: [] };
  const textOf = (file) => { const m = basename(file).match(/^line-(\d+)(?:-(.+))?-[0-9a-f]{6}/); return fillLine(sheets[Number(m[1]) - 1], areas.find((a) => slug(a) === m[2]) || ""); };
  return { calls, textOf, models: {
    async image({ out, prompt, refs }) { const n = calls.image.push({ out, prompt, refs }); picture(out, boxes[Math.min(n - 1, boxes.length - 1)]); },
    async clip({ out, image, prompt, seconds }) {
      const n = calls.clip.push({ out, image, prompt, seconds }), at = /The sheet is not dropped/.test(prompt) ? null : dropAt(out, n), b = BOX;
      ffm(["-loop", "1", "-t", String(seconds), "-i", image, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-vf", at == null ? "fps=24" : `fps=24,drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=white:t=fill:enable='gte(t,${at})'`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", String(seconds), out]);
    },
    async read(frame) { const clip = frame.replace(/\.frame-\d\.jpg$/, ".mp4"), n = calls.read.push(frame); return { written: read(textOf(clip), n, clip), clean: true }; },
    async watch(file, opts) { const n = calls.watch.push({ file, opts }); return { spoken: spoken(file, n), lettering: lettering(file, n), people: people(file, n), lips_match_speech: true, faults: faults(file, n), looks_real: 9 }; },
  } };
}

test("PP1 a white-paper script and its rules: six to nine sheets of two to eight words, one sheet with the offer in its exact words, the last sheet the closing line and nothing else; plain words as for a spoken script; the gym speaks as we, never I; never the whole country; scarcity only from the facts the owner typed, with his number; the owner's own is kept at once, a drafted one waits; never twice; an edit is checked again; retiring needs a reason; the sheets live beside the spoken scripts in one file and neither write drops the other; a batch picks the ready ones; a brief counts the kind", () => {
  const { d, g, profile } = gym();
  try {
    const bad = (sheets, o = {}) => sheetProblems(sheets, { offer: OFFER, profile, ...o }).join(" | "), swap = (i, s) => GOOD.map((x, k) => (k === i ? s : x));
    assert.deepEqual([SHEETS, SHEET_WORDS, SHEET_SECONDS], [[6, 9], [2, 8], 4]);
    assert.deepEqual(sheetProblems(GOOD, { offer: OFFER, profile }), []);
    assert.equal(bad(GOOD.slice(2)), "a white-paper script is 6 to 9 sheets");
    assert.match(bad(swap(0, "Tired?")), /sheet 1 is 1 word: a sheet is 2 to 8 words, read in two seconds/);
    assert.match(bad(swap(3, "You get a coach who stays right beside you every single day")), /sheet 4 is 12 words: a sheet is 2 to 8 words/);
    // The sheet with the offer's name may run to the offer and three words, however long the offer is.
    const LONG = "6 Week Strength and Confidence Challenge for Busy Mums";
    assert.deepEqual(sheetProblems(swap(2, `Join our ${LONG}`), { offer: LONG, profile }), []);
    assert.match(sheetProblems(swap(2, `So come along and join our ${LONG}`), { offer: LONG, profile }).join(" | "), /sheet 3 is 15 words: a sheet is 2 to 12 words/);
    assert.match(bad(swap(2, "Join our 12 Week Body Plan")), /one sheet must name the offer in its exact words: "12 Week Full Body Transformation"/);
    assert.match(bad(swap(6, "Click the link below")), /the last sheet is the closing line, word for word, and nothing else: "Click the link below and we'll be in touch!"/);
    assert.match(bad(swap(6, `Ready? ${CLOSING}`)), /the last sheet is the closing line, word for word, and nothing else/);
    assert.deepEqual(sheetProblems(swap(6, "click the link below and we’ll be in touch"), { offer: OFFER, profile }), [], "case and punctuation aside");
    // Plain words (the owner: "the plain words rule also applies to sheets").
    assert.match(bad(swap(4, "With real accountability every week")), /sheet 5: "accountability" is not a plain word — say "/);
    assert.match(bad(swap(5, "Feel your vitality come back")), /sheet 6: "vitality" is not a plain word — say "energy"/);
    // The gym's voice, the place, the call to action.
    assert.match(bad(swap(3, "I lost my belly here")), /sheet 4 speaks as one person \("I"\)/);
    assert.deepEqual(sheetProblems(swap(3, "We coach you every week"), { offer: OFFER, profile }), []);
    assert.match(bad(swap(1, "Live in Singapore?")), /sheet 2 names the whole country \("Singapore"\): the place is only ever \{AREA\}/);
    assert.match(bad(swap(1, "Live near {TOWN}?")), /sheet 2: only \{AREA\} may stand in for a word \(found \{TOWN\}\)/);
    assert.match(bad(swap(5, "Then tap below to start")), /sheet 6 says "tap below": the only call to action is the closing line, on the last sheet/);
    assert.match(bad(swap(5, "Get your dream body back")), /sheet 6 promises an ideal body/);
    assert.match(bad(swap(5, "Feel strong 💪 every day")), /sheet 6 has a character the marker cannot write/);
    assert.ok(/trial/i.test(bad(swap(4, "Start with a free trial week"))) && /guarantee/i.test(bad(swap(4, "Results are guaranteed here"))), "the ad rules hold: " + bad(swap(4, "Start with a free trial week")));
    // Scarcity is a claim about the gym: it stands on the owner's word — his typed fact (with its number), or the sheet's own words once he has said yes.
    assert.ok(SCARCE.test("limited spots") && SCARCE.test("10 people") && SCARCE.test("Only 10 places") && !SCARCE.test("12 Week Full Body Transformation") && !SCARCE.test("in only 6 weeks"));
    const TEN = swap(0, "We're looking for 10 people"), LIMITED = swap(5, "But… we have limited spots!!");
    assert.match(bad(TEN), /sheet 1 says places are limited \("10 people"\): that is a claim about this gym, so it stands on your word — say it is true when you keep the script, write the sheet yourself, or type it under What each challenge includes \(e\.g\. "Only 10 places"\)/);
    assert.deepEqual([sheetProblems(TEN, { offer: OFFER, profile, approved: ["werelookingfor10people"] }), sheetProblems(TEN, { offer: OFFER, profile, ask: true })], [[], []], "his yes to the sheet's own words; a draft's suggestion waits and is no fault");
    assert.deepEqual([scarceSheets(GOOD, OFFER), scarceSheets(LIMITED, OFFER).map((x) => [x.sheet, x.phrase]), scarcityOf({ sheets: LIMITED, offer: OFFER }), scarcityOf({ sheets: LIMITED, offer: OFFER }, ["Only 10 places"]).by, scarcityOf({ sheets: LIMITED, offer: OFFER, scarce_ok: ["butwehavelimitedspots"] }).by, scarcityOf({ sheets: GOOD, offer: OFFER })],
      [[], [[6, "limited"]], { sheet: 6, text: "But… we have limited spots!!", by: null }, "fact", "you", null]);
    assert.match(bad(LIMITED), /sheet 6 says places are limited \("limited"\)/);
    assert.deepEqual([sheetProblems(TEN, { offer: OFFER, profile, facts: ["Only 10 places"] }), sheetProblems(LIMITED, { offer: OFFER, profile, facts: ["Only 10 places"] })], [[], []]);
    assert.match(bad(swap(0, "We want 20 people"), { facts: ["Only 10 places"] }), /sheet 1 says "20 people": the number you typed for this offer is 10/);
    assert.match(bad(TEN, { facts: ["A full body scan at the start"] }), /sheet 1 says places are limited/, "a fact that is not about places is no ground");
    // Kept, drafted, edited, retired.
    const own = addSheetScript(g, { sheets: GOOD, offer: OFFER }, { profile });
    assert.deepEqual([own.status, own.source, /^p-[0-9a-f]{10}$/.test(own.id), own.sheets], ["kept", "owner", true, GOOD]);
    assert.throws(() => addSheetScript(g, { sheets: GOOD.map((s) => s.toUpperCase()), offer: OFFER }, { profile }), /this script is already here/);
    assert.throws(() => addSheetScript(g, { sheets: swap(0, "Tired?"), offer: OFFER }, { profile }), /sheet 1 is 1 word/);
    const draft = addSheetScript(g, { sheets: swap(0, "Tired after lunch every day?"), offer: OFFER, source: "drafted" }, { profile });
    assert.equal(draft.status, "draft");
    assert.deepEqual([keptSheetScripts(g, OFFER).map((x) => x.id), keptSheetScripts(g, "Another Offer"), readySheetScripts(g, OFFER.toUpperCase(), { profile }).length], [[own.id], [], 1]);
    assert.throws(() => decideSheetScript(g, draft.id, { sheets: swap(0, "I am tired after lunch") }, { profile }), /sheet 1 speaks as one person/);
    assert.equal(decideSheetScript(g, draft.id, { sheets: swap(0, "No energy left after lunch?") }, { profile }).sheets[0], "No energy left after lunch?");
    assert.throws(() => decideSheetScript(g, draft.id, { status: "retired" }, { profile }), /retiring a script needs a reason/);
    assert.equal(decideSheetScript(g, draft.id, { status: "kept" }, { profile }).status, "kept");
    // A drafted script's scarcity sheet is the agent's suggestion: it waits as a draft, Keep needs his yes, and a sheet he changes himself is his word.
    const sug = addSheetScript(g, { sheets: swap(5, "But we have limited spots!"), offer: OFFER, source: "drafted" }, { profile });
    assert.deepEqual([sug.status, sug.scarce_ok, sheetIssues(sug, { profile, gymDir: g })], ["draft", undefined, []]);
    assert.throws(() => decideSheetScript(g, sug.id, { status: "kept" }, { profile }), (e) => /^sheet 6 says "But we have limited spots!": that is the agent's suggestion\. Say it is true of this offer to keep the script, or change the sheet first$/.test(e.message) && e.scarcity.sheet === 6);
    assert.equal(decideSheetScript(g, sug.id, { sheets: swap(5, "But we have limited spots!").map((s, i) => (i === 0 ? "Stairs leave you out of breath?" : s)) }, { profile }).scarce_ok, undefined, "an edit elsewhere is not a yes to the suggestion");
    assert.throws(() => decideSheetScript(g, sug.id, { status: "kept" }, { profile }), /the agent's suggestion/);
    const yes = decideSheetScript(g, sug.id, { status: "kept", scarcity_ok: true }, { profile });
    assert.deepEqual([yes.status, yes.scarce_ok, sheetIssues(yes, { profile, gymDir: g })], ["kept", ["butwehavelimitedspots"], []]);
    const mine = decideSheetScript(g, sug.id, { sheets: yes.sheets.map((s, i) => (i === 5 ? "We only have 8 spots!" : s)) }, { profile });
    assert.deepEqual([mine.scarce_ok, sheetIssues(mine, { profile, gymDir: g })], [["weonlyhave8spots"], []], "the sheet he wrote himself is his word");
    decideSheetScript(g, sug.id, { status: "retired", reason: "only for this check" }, { profile });
    assert.deepEqual(addSheetScript(g, { sheets: swap(5, "Only 12 places this time"), offer: OFFER }, { profile }).scarce_ok, ["only12placesthistime"], "his own script is his word, scarcity included");
    decideSheetScript(g, readSheetScripts(g).at(-1).id, { status: "retired", reason: "only for this check" }, { profile });
    assert.deepEqual([decideSheetScript(g, draft.id, { status: "retired", reason: "not this one" }, { profile }).status, readSheetScripts(g).length], ["retired", 4]);
    // One file, two lists: a spoken script's write keeps the sheets, and a sheet script's write keeps the spoken ones.
    const SPOKEN = ["People in {AREA}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.", "Test Gym's 12 Week Full Body Transformation is built for exactly that. A coach beside you, and a plan that fits your week.", "If you are ready to feel stronger every day, now is your time. Click the link below and we'll be in touch!"];
    addScript(g, { lines: SPOKEN, offer: OFFER }, { profile }); setFacts(g, OFFER, ["Only 10 places"], { profile });
    assert.deepEqual([readScripts(g).scripts.length, readScripts(g).sheets.length], [1, 4]);
    addSheetScript(g, { sheets: TEN, offer: OFFER }, { profile });
    assert.deepEqual([readScripts(g).scripts.length, readScripts(g).sheets.length, Object.keys(readScripts(g).facts).length], [1, 5, 1]);
    // A kept script that today's rules refuse (the number he typed for the offer has changed) is not ready, and the refusal says what to press.
    setFacts(g, OFFER, ["Only 8 places"], { profile });
    assert.deepEqual(readySheetScripts(g, OFFER, { profile }).map((x) => x.id), [own.id]);
    assert.match(noSheetScriptWhy(g, OFFER, { profile }).text, /the white-paper script kept for this offer needs an edit first — sheet 1 says "10 people": the number you typed for this offer is 8/);
    assert.deepEqual(pickSheetScripts(g, { count: 1, offer: OFFER, seed: "b1" }).map((x) => x.id), [own.id]);
    assert.throws(() => pickSheetScripts(g, { count: 2, offer: OFFER, seed: "b1" }), /2 white-paper videos asked for, but only 1 white-paper script is ready for "12 Week Full Body Transformation": .* \(Draft Scenes → Video scripts → White-paper scripts\)/);
    assert.throws(() => pickSheetScripts(g, { count: 1, offer: "6 Week Reset", seed: "b1" }), /no white-paper script is ready for "6 Week Reset": the white-paper scripts kept there are for "12 Week Full Body Transformation"/);
    // What it costs: one picture, four seconds a sheet; the sheet that says the area once for each location.
    assert.deepEqual((({ seconds, images, usd, videos }) => [seconds, images, usd, videos])(sheetCost(own, ["BISHAN"])), [28, 1, Math.round((28 * USD_PER_SECOND + USD_PER_IMAGE) * 100) / 100, 1]);
    assert.equal(sheetCost(own, ["BISHAN", "ANG MO KIO"]).seconds, 32);
    // The brief: a third count, three videos between all kinds.
    assert.deepEqual([videosProblems({ paper: 1 }), videoCount({ presenter: 1, active: 1, paper: 1 }), spokenCount({ presenter: 1, active: 1, paper: 1 }), paperCount({ paper: 2 }), videoKinds({ presenter: 1, active: 1, paper: 1 })], [[], 3, 2, 2, ["presenter", "active", "paper"]]);
    assert.deepEqual(videosProblems({ presenter: 2, paper: 2 }), ["a batch makes at most 3 presenter videos in all, talking, with exercises and white paper together"]);
    assert.deepEqual(videosProblems({ sheets: 1 }), ['videos: "sheets" is not a kind of video (presenter, active, paper)']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PP2 the agent proposes the sheets: one text call told the shape, the rules, plain words and the facts — every script carries exactly one scarcity sheet (with no fact about places, one with no number for the owner to check; with one, as typed) and a draft without one is dropped; every draft is checked in code and a broken one is dropped with the reason; a shortfall is asked for once more, told what was refused; drafts wait for the owner", async () => {
  const { d, g, profile } = gym();
  try {
    const none = buildSheetPrompt({ profile, offer: OFFER, audience: "busy professionals", count: 3 }).prompt;
    assert.match(none, /silent video advert for Test Gym's programme "12 Week Full Body Transformation", for busy professionals/);
    assert.match(none, /4\. ALWAYS exactly one sheet of scarcity, just before the last sheet\. The owner has typed no number of places, so say that places are limited with NO number and no date — "But we have limited spots!", "Places are limited\." — for the owner to check and to put his own number in\. Never invent a number of people or places, and never a deadline\./);
    assert.match(none, /The last sheet is exactly this, and nothing else: "Click the link below and we'll be in touch!"/);
    assert.match(none, /6 to 9 sheets\. Each sheet is 2 to 8 words/); assert.match(none, /PLAIN WORDS: the reading level of a nine-year-old/); assert.match(none, /state no fact about the gym/);
    const withFacts = buildSheetPrompt({ profile, offer: OFFER, count: 2, facts: ["A full body scan at the start", "Only 10 places"], pains: ["your work clothes feel tight"] }).prompt;
    assert.match(withFacts, /ALWAYS exactly one sheet of scarcity, just before the last sheet\. Say it only as the facts state it \("Only 10 places"\): the same number, nothing added/);
    assert.match(withFacts, /THE FACTS the owner has typed as true of this programme \(the only ones that may be stated\):\n- A full body scan at the start\n- Only 10 places/);
    assert.match(withFacts, /WHAT BOTHERS THESE PEOPLE, in the owner's words \(open on one of these\):\n- your work clothes feel tight/);
    const LIM = GOOD.map((x, k) => (k === 5 ? "But we have limited spots!" : x)), swap = (i, s) => LIM.map((x, k) => (k === i ? s : x)), asked = [];
    const ask = async (image, prompt) => { asked.push(prompt); return asked.length === 1
      ? { scripts: [{ sheets: LIM }, { sheets: GOOD }, { sheets: swap(4, "With real accountability every week") }] }
      : { scripts: [{ sheets: swap(0, "No energy left after lunch?") }, { sheets: swap(0, "Stairs leave you out of breath?") }] }; };
    const r = await draftSheetScripts({ brandDir: g, offer: OFFER, count: 3, ask });
    assert.deepEqual([r.calls, r.added.length, r.added.every((x) => x.status === "draft" && x.source === "drafted"), r.dropped.length], [2, 3, true, 2]);
    assert.match(r.dropped[0].reason, /^no sheet says places are limited: every script has exactly one, just before the last sheet$/); assert.match(r.dropped[1].reason, /"accountability" is not a plain word/);
    assert.ok(r.added.every((x) => scarcityOf(x).by === null && !x.scarce_ok), "the suggestion waits for his yes");
    assert.match(asked[1], /Write 2 scripts/); assert.match(asked[1], /THESE WERE REFUSED — do not make the same mistake:\n- "Do your work clothes feel tight\? \/ /); assert.match(asked[1], /ALREADY WRITTEN \(write something different\):\n- Do your work clothes feel tight\? \/ /);
    assert.deepEqual([readSheetScripts(g).length, keptSheetScripts(g, OFFER).length], [3, 0], "nothing is kept until he keeps it");
    // The pain point he gives for a round (2026-11-16): the drafter is told every script is about that one thing, and each draft keeps it.
    const themed = buildSheetPrompt({ profile, offer: OFFER, count: 1, theme: "Not being happy with the way you look in the mirror", pains: ["something he kept before"] }).prompt;
    assert.match(themed, /THE PAIN POINT OF THIS ROUND, in the owner's own words: "Not being happy with the way you look in the mirror"\. It drives every script from start to finish.* The first one or two sheets name it; the sheets of what they get answer it\./); assert.doesNotMatch(themed, /something he kept before/);
    const seenT = [], rt = await draftSheetScripts({ brandDir: g, offer: OFFER, count: 1, pain: "Not being happy with the way you look in the mirror.", ask: async (img, p) => { seenT.push(p); return { scripts: [{ sheets: swap(0, "Avoiding the mirror lately?") }] }; } });
    assert.deepEqual([rt.theme, rt.added.map((x) => x.pain), /THE PAIN POINT OF THIS ROUND/.test(seenT[0]), r.added[0].pain], ["Not being happy with the way you look in the mirror", ["Not being happy with the way you look in the mirror"], true, undefined]);
    await assert.rejects(draftSheetScripts({ brandDir: g, offer: OFFER, count: 1, pain: "being overweight", ask: async () => { throw new Error("never asked"); } }), /the pain point: "overweight" judges the person/);
    await assert.rejects(draftSheetScripts({ brandDir: g, offer: "", ask }), /the offer's exact words are needed/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("PP3 the parts that judge, pure: what a found paper allows (too small, held too low, not blank — else where on it the words may sit inside Meta's live area); when a sheet goes, from the ink in its words' patch (the words start to go, then are gone; a sheet that is never dropped; words that were never there); a clip's check (the paper read back letter for letter on every frame first, then nobody speaks, one person, held long enough, dropped unless it is the last sheet, no other lettering — the sheet's own words are not lettering); the prompts (a blank sheet, high and large; the camera fixed; the last sheet held)", () => {
  const quad = (b) => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]], found = (b, fill = 1) => ({ quad: quad(b), W: 720, H: 1280, fill });
  assert.equal(paperFacts({ W: 720, H: 1280 }).problem, "no blank sheet of paper was found in the picture");
  const ok = paperFacts(found(BOX));
  assert.deepEqual([ok.problem, ok.width, ok.usable], [undefined, 0.444, [PAPER.pad, 0.92]]);
  assert.equal(paperFacts(found(SMALL)).problem, "the paper is too small in the picture (17% of its width; at least 24%)");
  assert.match(paperFacts(found(LOW)).problem, /^the paper is held too low: only \d+% of it is where words may sit on a Story or Reel$/);
  assert.equal(paperFacts(found(BOX, 0.6)).problem, "the paper is not blank, or hands cover too much of it");
  assert.equal(paperFacts(found({ x: 0, y: 400, w: 320, h: 450 })).problem, "the paper runs off the side of the picture");
  // A paper that hangs a little under the live area: the words go in the part of it that is inside.
  const partly = paperFacts(found({ x: 200, y: 480, w: 320, h: 450 })); assert.equal(partly.problem, undefined); assert.ok(partly.usable[1] < 0.8 && partly.usable[1] - partly.usable[0] >= PAPER.usable, JSON.stringify(partly));
  // The drop, from the ink (24 frames a second).
  const series = (f) => Array.from({ length: 96 }, (_, i) => ({ t: i / 24, ink: f(i / 24) }));
  assert.deepEqual(dropFrom(series((t) => (t < 2.7 ? 30 : 0))), { duration: 4, base: 30, leave: 2.71, drop: 2.71 });
  assert.deepEqual(dropFrom(series((t) => (t < 2.6 ? 36 : t < 3.1 ? 18 : 0))), { duration: 4, base: 36, leave: 2.63, drop: 3.13 }, "a sheet that slides before it falls: readable up to 2.6 s, gone at 3.1 s");
  assert.deepEqual(dropFrom(series(() => 30)), { duration: 4, base: 30, leave: null, drop: null });
  assert.deepEqual(dropFrom(series((t) => (t > 1 && t < 1.08 ? 0 : 30))), { duration: 4, base: 30, leave: null, drop: null }, "two frames of a hand passing over the words are no drop");
  assert.deepEqual([dropFrom(series(() => 0)), dropFrom([])], [{ duration: 4, base: 0, leave: 0, drop: 0 }, { duration: 0, base: 0, leave: 0, drop: 0 }]);
  // The check.
  const TEXT = "Join our 12 Week Full Body Transformation", seen = { spoken: "", lettering: [], people: 1, faults: [] }, timing = { duration: 4, base: 30, leave: 2.7, drop: 2.75 };
  const reads = (...w) => w.map((written, i) => ({ at: i, written, clean: true })), J = (c, o) => judgeSheet({ v: 1, timing, seen, reads: reads(TEXT, TEXT), ...c }, TEXT, o);
  assert.ok(sameWriting("JOIN OUR 12 week full body transformation.", TEXT) && !sameWriting("Join our 12 Week Full Body Transformatoin", TEXT) && sameWriting("we'll be in touch", "We’ll be in touch!"));
  assert.equal(inkText("But… we’ll “see”"), 'But... we\'ll "see"');
  assert.deepEqual(J({}), { passed: true, why: null, kind: null, faults: [], marks: [] });
  assert.deepEqual((({ passed, kind, why }) => [passed, kind, why])(J({ reads: reads(TEXT, "Join our 12 Week Full Body Transfarmation") })), [false, "words", 'the paper read "Join our 12 Week Full Body Transfarmation"']);
  assert.equal(J({ reads: reads(TEXT, "") }).why, "the paper was blank when it was read"); assert.equal(J({ reads: [] }).why, "the paper could not be read back");
  assert.deepEqual([J({ seen: { ...seen, spoken: "Join our programme" } }).kind, J({ seen: { ...seen, spoken: "Join our programme" } }).why], ["voice", 'a voice says "Join our programme"']);
  assert.deepEqual([J({ seen: { ...seen, people: 2 } }).kind, J({ timing: { ...timing, leave: 0.9, drop: 1 } }).why, J({ timing: { duration: 4, base: 30, leave: null, drop: null } }).why], ["people", "the sheet goes after 0.9 s, too soon to read", "the sheet is not dropped"]);
  assert.equal(MIN_HOLD, 1.6); assert.equal(J({ timing: { duration: 4, base: 30, leave: null, drop: null } }, { last: true }).passed, true, "the last sheet is held, not dropped");
  // The sheet's own words, listed by the watching pass, are the paper; a maker's name on a machine is a note; anything else fails.
  assert.equal(J({ seen: { ...seen, lettering: [{ text: "JOIN OUR 12 WEEK", on: "other" }, { text: "Full Body Transformation", on: "sign" }] } }).passed, true);
  assert.deepEqual(J({ seen: { ...seen, lettering: [{ text: "Life Fitness", on: "equipment" }] } }).marks, ["the maker's name on the equipment: Life Fitness"]);
  assert.deepEqual([J({ seen: { ...seen, lettering: [{ text: "SALE NOW ON", on: "sign" }] } }).kind, J({ seen: { ...seen, lettering: [{ text: "SALE NOW ON", on: "sign" }] } }).why], ["lettering", "other words appear in the picture: SALE NOW ON"]);
  assert.deepEqual(J({ reads: [{ at: 1, written: TEXT, clean: false }, { at: 2, written: TEXT, clean: true }], seen: { ...seen, faults: ["warped fingers"] } }).faults, ["warped fingers", "the writing looks warped"], "noted, not refused");
  // The prompts.
  const P = { gender: "woman", age: 30, look: "" }, prof = PROFILE_STARTER("testgym", "Test Gym", "SG"), still = blankPrompt({ presenter: P, profile: prof }), clip = sheetClipPrompt({ presenter: P }), end = sheetClipPrompt({ presenter: P, last: true });
  assert.match(still, /holds a small stack of plain white A4 paper sheets upright in front of her chest with both hands\. The paper is LARGE in the picture: about half the picture's width\. Its top edge is just below her chin, so her whole face shows, and its bottom edge is above her waist: the whole sheet sits in the upper two thirds of the picture/);
  assert.match(still, /The paper is COMPLETELY BLANK/); assert.match(still, /There is no text of any kind anywhere in the picture/);
  assert.match(clip, /^Bring this photograph to life as 4 seconds of video\. Nobody speaks/); assert.match(clip, /Then she lets the front sheet go: it slips off the stack and falls straight down out of the picture, and the sheet behind it is completely blank white paper/);
  assert.match(clip, /The camera is fixed in place: it does not move closer, does not zoom and does not drift/); assert.match(clip, /every letter unchanged, sharp, steady and in the same place on the paper/); assert.match(clip, /No voice\. No music\./);
  assert.match(end, /holds the stack of paper perfectly still for the whole clip .* and gives one small nod\. The sheet is not dropped\./); assert.ok(!/lets the front sheet go/.test(end));
  assert.ok(existsSync(PAPER_FONT), "the marker font ships with the repo");
});

test("PP4 a white-paper video end to end: ONE picture of the presenter holding blank sheets; software finds the paper and writes each sheet's words on it, inside Meta's live area; one clip of 4 s for each sheet from its own written picture — the sheet that says the area once for each location, the rest shared; every clip read back on two frames and watched once; each clip cut where its sheet is gone and the last one held; the parts, in the shape Pick Ads uses for a spoken video; a second run films nothing; a paper read back wrong is filmed again and then cut in flagged, set aside it is filmed fresh, kept on his word it passes; a picture whose paper is too small is made again; the cap is never passed", { timeout: 600000 }, async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not installed");
  const { d, g, profile, room } = gym(), browser = await launchBrowser();
  try {
    const script = addSheetScript(g, { sheets: GOOD, offer: OFFER }, { profile }), areas = ["BISHAN", "ANG MO KIO"], store = clipStore(g, script.id), out = join(d, "out");
    const base = { gymDir: g, outDir: out, script, areas, offer: OFFER, room, profile, browser, caps: { seconds: 80, images: 2 } };
    assert.deepEqual((({ seconds, reused, images, flagged, clips }) => [seconds, reused, images, flagged, clips.length])(paperNeeds({ gymDir: g, script, areas, room, profile })), [32, 0, 1, 0, 8]);
    await assert.rejects(makePaperVideos({ ...base, areas: ["SINGAPORE"], models: fakes().models }), /"SINGAPORE" is the whole country/);
    await assert.rejects(makePaperVideos({ ...base, profile: { ...profile, creative_defaults: {} }, models: fakes().models }), /say who presents first/);
    const f = fakes({ areas }), logs = [], seen = [];
    const r = await makePaperVideos({ ...base, models: f.models, log: (m) => logs.push(m), onProgress: (p) => seen.push(p) });
    // One picture, from the room alone; eight clips of four seconds, each from its own written picture.
    assert.deepEqual([f.calls.image.length, f.calls.image[0].refs, f.calls.clip.length, [...new Set(f.calls.clip.map((c) => c.seconds))], f.calls.read.length, f.calls.watch.length, f.calls.watch.every((w) => w.opts.paper === true)], [1, [room], 8, [4], 16, 8, true]);
    assert.deepEqual(r.spent, { seconds: 32, images: 1, checks: 24 }); assert.deepEqual(r.tally, { filmed: 32, in_videos: 32, replaced: 0, failed: 0, waiting: 0 });
    assert.equal(new Set(f.calls.clip.map((c) => c.image)).size, 8, "a written picture for each sheet (the area's sheet: one for each location)");
    assert.ok(f.calls.clip.every((c) => /^sheet-\d/.test(basename(c.image)) && readFileSync(c.image).length !== readFileSync(f.calls.image[0].out).length), "the clip starts from the picture with the words on it, never the blank one");
    assert.deepEqual(f.calls.clip.map((c) => /The sheet is not dropped/.test(c.prompt)), [false, false, false, false, false, false, true, false], "the closing line is held; the second location films only the sheet that says its area");
    // The words sit on the paper, inside Meta's live area, at a size that can be read.
    for (const j of readdirSync(store).filter((x) => x.endsWith(".sheet.json"))) { const s = JSON.parse(readFileSync(join(store, j), "utf-8")); assert.ok(!s.problem && s.letter >= PAPER.min_letter && s.box.x >= 0.27 && s.box.x + s.box.w <= 0.73 && s.box.y >= LIVE.top && s.box.y + s.box.h <= LIVE.bottom, `${j}: ${JSON.stringify(s)}`); }
    assert.ok(seen.some((p) => p.stage === "still" && p.paper) && seen.some((p) => p.stage === "clip" && p.paper && p.line === 2 && p.area === "ANG MO KIO") && seen.some((p) => p.stage === "cut"));
    assert.ok(logs.some((m) => /the paper is 44% of the picture's width; the words go on it by software/.test(m)) && logs.some((m) => /the paper reads as written, dropped at 2\.7\d? s/.test(m)) && logs.some((m) => /the paper reads as written, held/.test(m)), logs.join("\n"));
    // Two videos, each seven cuts: six sheets kept to their drop and the last held.
    assert.deepEqual(r.videos.map((v) => [v.area, v.kind, v.failed, v.flags, v.words[1], v.parts.length]), [["BISHAN", "paper", undefined, undefined, "Live near Bishan?", 7], ["ANG MO KIO", "paper", undefined, undefined, "Live near Ang Mo Kio?", 7]]);
    // Each sheet is kept half a second past its drop, so it falls out of the frame, and fades into the next over a quarter second (the owner's pick of two re-cuts, 2026-11-16).
    assert.deepEqual([DROP_KEEP, SHEET_FADE], [0.5, 0.25]);
    const v = r.videos[0], want = 6 * (2.71 + DROP_KEEP - SHEET_FADE) + LAST_KEEP;
    assert.ok(existsSync(v.file) && existsSync(v.poster) && Math.abs(durationOf(v.file) - want) < 0.5, `${durationOf(v.file)} s, about ${want} expected`);
    assert.deepEqual(v.parts.map((p) => [p.line, p.label, p.text, p.seconds, p.takes.length, !!p.flag, !!p.per_area]), GOOD.map((s, i) => [i + 1, `sheet ${i + 1}`, fillLine(s, "BISHAN"), 4, 1, false, i === 1]));
    assert.ok(v.parts.every((p, i) => /^line-\d+(-[a-z-]+)?-[0-9a-f]{6}\.mp4$/.test(p.clip) && Math.abs(p.at - i * (2.71 + DROP_KEEP - SHEET_FADE)) < 0.2), JSON.stringify(v.parts.map((p) => [p.clip, p.at])));
    assert.deepEqual([r.videos[1].parts[0].clip, r.videos[1].parts[1].clip === v.parts[1].clip], [v.parts[0].clip, false], "a sheet without the area is one clip in both videos");
    // Everything is on file: a second run films nothing and makes no call but the cut.
    assert.deepEqual((({ seconds, reused, images }) => [seconds, reused, images])(paperNeeds({ gymDir: g, script, areas, room, profile })), [0, 32, 0]);
    const f2 = fakes({ areas }), r2 = await makePaperVideos({ ...base, models: f2.models });
    assert.deepEqual([f2.calls.image.length, f2.calls.clip.length, f2.calls.read.length, f2.calls.watch.length, r2.spent, r2.videos.every((x) => x.file)], [0, 0, 0, 0, { seconds: 0, images: 0, checks: 0 }, true]);

    // A paper that reads back wrong: filmed again, then cut in all the same, flagged for the owner.
    const two = addSheetScript(g, { sheets: GOOD.map((s, i) => (i === 0 ? "Stairs leave you out of breath?" : i === 1 ? "Sound like you?" : s)), offer: OFFER }, { profile }), store2 = clipStore(g, two.id);
    const warped = { sheets: two.sheets, areas: ["BISHAN"], read: (text) => (/Stairs/.test(text) ? "Stairs leave you out of breth?" : text) }, f3 = fakes(warped), logs3 = [];
    const r3 = await makePaperVideos({ ...base, script: two, areas: ["BISHAN"], models: f3.models, log: (m) => logs3.push(m) });
    assert.deepEqual([f3.calls.clip.length, r3.spent.seconds, r3.tally, r3.videos[0].failed, r3.videos[0].flags], [8, 32, { filmed: 32, in_videos: 28, replaced: 0, failed: 4, waiting: 0 }, undefined, [{ line: 1, label: "sheet 1", why: 'the paper read "Stairs leave you out of breth?"', kind: "words" }]]);
    assert.ok(existsSync(r3.videos[0].file), "the owner still sees the video"); assert.equal(r3.videos[0].parts[0].takes.length, 2);
    assert.deepEqual((({ seconds, flagged }) => [seconds, flagged])(paperNeeds({ gymDir: g, script: two, areas: ["BISHAN"], room, profile })), [0, 1], "it waits for him: a run films nothing for it");
    // A scarcity sheet he said yes to is his word when the video is MADE too (2026-11-16: a script he had kept and approved stopped a batch
    // after two videos were filmed — "it should have not let me approve the script if the claim was not true": the run's own check left his yes out).
    { const sug = addSheetScript(g, { sheets: GOOD.map((s, i) => (i === 0 ? "Do you turn away from the mirror?" : i === 5 ? "Places are limited." : s)), offer: OFFER, source: "drafted" }, { profile });
      const noCall = { ...fakes().models, image: async () => { throw new Error("no call is expected"); } };
      await assert.rejects(makePaperVideos({ ...base, script: sug, areas: ["BISHAN"], models: noCall }), /^Error: this script cannot be made: sheet 6 says places are limited \("Places are"\)/, "not approved: refused before anything is made");
      const yes = decideSheetScript(g, sug.id, { status: "kept", scarcity_ok: true }, { profile });
      assert.deepEqual([yes.status, yes.scarce_ok, readySheetScripts(g, OFFER, { profile }).some((x) => x.id === sug.id)], ["kept", ["placesarelimited"], true]);
      const fy = fakes({ sheets: yes.sheets, areas: ["BISHAN"] }), ry = await makePaperVideos({ ...base, script: yes, areas: ["BISHAN"], models: fy.models });
      assert.deepEqual([ry.videos[0].failed, ry.videos[0].flags, existsSync(ry.videos[0].file), ry.videos[0].words[5]], [undefined, undefined, true, "Places are limited."], "approved: it is made");
      decideSheetScript(g, sug.id, { status: "retired", reason: "only for this check" }, { profile }); }
    // Film this sheet again: the takes are set aside and one fresh take is filmed — which now reads right.
    assert.equal(setAside(store2, r3.videos[0].parts[0].takes, "the owner asked for a fresh take"), 2);
    assert.equal(paperNeeds({ gymDir: g, script: two, areas: ["BISHAN"], room, profile }).seconds, 4);
    const f4 = fakes({ sheets: two.sheets, areas: ["BISHAN"] }), r4 = await makePaperVideos({ ...base, script: two, areas: ["BISHAN"], models: f4.models });
    assert.deepEqual([f4.calls.clip.length, /-take3\.mp4$/.test(f4.calls.clip[0].out), r4.videos[0].flags, r4.spent.seconds], [1, true, undefined, 4]);
    // Use this take anyway: his word on a take that failed its check.
    const three = addSheetScript(g, { sheets: GOOD.map((s, i) => (i === 0 ? "Tired after lunch every day?" : i === 1 ? "Sound like you?" : s)), offer: OFFER }, { profile }), store3 = clipStore(g, three.id);
    const f5 = fakes({ sheets: three.sheets, areas: ["BISHAN"], spoken: (file) => (/line-4-/.test(file) ? "hello" : "") }), r5 = await makePaperVideos({ ...base, script: three, areas: ["BISHAN"], models: f5.models });
    assert.deepEqual(r5.videos[0].flags, [{ line: 4, label: "sheet 4", why: 'a voice says "hello"', kind: "voice" }]);
    keepTake(store3, r5.videos[0].parts[3].clip, r5.videos[0].flags[0].why);
    const r6 = await makePaperVideos({ ...base, script: three, areas: ["BISHAN"], models: fakes({ sheets: three.sheets, areas: ["BISHAN"] }).models });
    assert.deepEqual([r6.videos[0].flags, r6.videos[0].parts[3].kept, r6.spent.seconds, r6.videos[0].notes], [undefined, 'a voice says "hello"', 0, ['sheet 4 kept on your word (a voice says "hello")']]);

    // A picture whose paper is too small is made again, once; two bad pictures leave no video and say why; the next run asks for a fresh one.
    const four = addSheetScript(g, { sheets: GOOD.map((s, i) => (i === 0 ? "No energy left after lunch?" : i === 1 ? "Sound like you?" : s)), offer: OFFER }, { profile });
    const f7 = fakes({ sheets: four.sheets, areas: ["BISHAN"], boxes: [SMALL, LOW] }), logs7 = [], r7 = await makePaperVideos({ ...base, script: four, areas: ["BISHAN"], models: f7.models, log: (m) => logs7.push(m) });
    assert.deepEqual([f7.calls.image.length, f7.calls.clip.length, r7.spent.seconds], [2, 0, 0]);
    assert.match(r7.videos[0].failed, /^the presenter's picture could not be used: the paper is held too low: only \d+% of it is where words may sit on a Story or Reel\. Nothing was filmed\. Run again asks for a fresh picture$/);
    assert.ok(logs7.some((m) => /the paper is too small in the picture \(1\d% of its width; at least 24%\)/.test(m)), logs7.join("\n"));
    assert.equal(paperNeeds({ gymDir: g, script: four, areas: ["BISHAN"], room, profile }).images, 1, "a picture is still to make");
    const f8 = fakes({ sheets: four.sheets, areas: ["BISHAN"] }), r8 = await makePaperVideos({ ...base, script: four, areas: ["BISHAN"], models: f8.models, caps: { seconds: 8, images: 2 } });
    assert.deepEqual([f8.calls.image.length, /-c\.jpg$/.test(f8.calls.image[0].out), f8.calls.clip.length, r8.spent.seconds], [1, true, 2, 8], "the third picture is the one used; the cap of 8 s films two sheets and no more");
    assert.equal(r8.videos[0].failed, "sheet 3: the cap of 8 seconds of video was reached");
    // Words too many to be read on the paper: said by the sheet, and nothing is filmed for it.
    const tiny = { ...four, id: "p-tiny", sheets: four.sheets }, r9 = await makePaperVideos({ ...base, script: tiny, areas: ["BISHAN"], store: join(d, "tiny"), models: fakes({ sheets: four.sheets, areas: ["BISHAN"], boxes: [{ x: 262, y: 420, w: 196, h: 276 }] }).models, caps: { seconds: 0, images: 1 } });
    assert.match(r9.videos[0].failed, /^sheet \d: the cap of 0 seconds of video was reached$|has too many words to be read on the paper: use fewer/);
  } finally { await browser.close(); rmSync(d, { recursive: true, force: true }); }
});
