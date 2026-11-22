/**
 * Tests for testimonial videos and their own copy (testimonial-video.mjs). No model call: the listening, the look and the
 * text calls are fakes; the videos are made by ffmpeg.
 * Run: node --test skills/references/testimonial-video.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { addFootageBatch } from "./footage-video.mjs";
import { readTestimonials, readReadings, testimonialAds, testimonialsView, draftTestimonialCopy, testimonialProblems, decideOf, figuresIn, saidIn, correctName, buildCopyPrompt, videoId, TESTIMONIAL } from "./testimonial-video.mjs";
import { readCopy, keptCopies, ownCopies, decideCopy, kindOf } from "./draft-copy.mjs";
import { keptAds, buildPlan } from "./meta-publish.mjs";
import { mergeBatches } from "./merge-batches.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";

const HAS = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = { skip: !HAS && "ffmpeg is not installed" };
const OFFER = "6 Week Reset", SAID = "I was really very low. My shifts were messy. Now I feel fitter and healthier, and coming here is my first priority. I lost 8 kilos.";
const gym = () => {
  const d = mkdtempSync(join(tmpdir(), "tv-")), g = join(d, "brands", "testgym"); mkdirSync(g, { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ ...PROFILE_STARTER("testgym", "Test Gym", "SG"), website: "https://testgym.sg" }));
  const mk = (name, colour) => { const f = join(d, name); execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=720x1280:r=12:d=4`, "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]); return f; };
  return { d, g, files: [mk("a.mp4", "gray"), mk("b.mp4", "navy")] };
};
const add = (G, over = {}) => addFootageBatch({ brandDir: G.g, batchId: "stories-of-members", offer: OFFER, locations: ["BISHAN"], videos: G.files.map((file, i) => ({ file, title: `Caption ${i + 1}` })), kind: TESTIMONIAL, consent: { by: "the owner, in chat" }, ...over });
const models = (over = {}) => ({
  async listen() { return { phrases: [{ text: SAID, start: 0.5, end: 3.5, kind: "line" }], music: true }; },
  async look() { return { people: 1, who: "a woman talking to the camera", setting: "a gym", on_screen_text: ["8KG down"], before_after: true, before_after_what: "two photos side by side", shows: "She talks." }; },
  async ask() { return { speaker: "a member", name: "Anita Lee", summary: "She was low and is fitter now.", struggle: ["really very low", "messy shifts"], change: ["feel fitter", "lost 8kg"], liked: [], quotes: ["I was really very low.", "Nobody ever said this line here", "I lost 8 kilos."], figures: ["8 kilos"], language: "English" }; }, ...over });
const copyText = (n, extra = "") => `Some weeks nothing goes to plan, and that is way ${n}.\n\n"I was really very low." That is how Anita felt. ${extra}\n\nOur ${OFFER} near {AREA} is a place to start. Tap {BUTTON}.`;

test("TV1 a testimonial added as it is and read: the owner's word on consent is needed and recorded, 720 wide is taken and said, the video keeps one id by its content; the reading keeps only quotes that were really said and never a figure in what changed; a weight figure, before-and-after or a swear word is for the owner to decide, and such a video is published only on their own Keep", skip, async () => {
  const G = gym();
  try {
    assert.throws(() => add(G, { consent: null }), /a testimonial shows a real person: say who confirmed/);
    assert.throws(() => add(G, { kind: "real", consent: undefined }), /smaller than 1080×1920/, "the gym's own cut is still 1080");
    const r = add(G), out = r.dir, ads = testimonialAds(out);
    assert.deepEqual([r.ads, ads.length, ads[0].id, ads[0].title, /-testimonial-video$/.test(ads[0].folder)], [2, 2, videoId(G.files[0]), "Caption 1", true]);
    const b = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
    assert.deepEqual([b.ads[0].video.kind, b.ads[0].video.small, b.ads[0].video.consent.by, b.ads[0].treatment, b.videos], [TESTIMONIAL, true, "the owner, in chat", "video-testimonial", { testimonial: 2 }]);
    assert.equal(keptAds(out).length, 2, "nothing read yet: nothing to decide");
    const log = [], read = await readTestimonials({ batchDir: out, models: models(), log: (m) => log.push(m) });
    assert.deepEqual([read.read.length, read.left, read.calls], [2, 0, 6]);
    const R = readReadings(out).videos[ads[0].id].reading;
    assert.deepEqual([R.name, R.quotes, R.change, R.music, R.before_after], ["Anita", ["I was really very low."], ["feel fitter"], true, true]);
    assert.deepEqual(decideOf(R).map((x) => x.kind), ["figure", "before_after"]);
    assert.deepEqual(decideOf({ transcript: "I'm very fucking proud", figures: [] }).map((x) => x.kind), ["swear"]);
    assert.equal((await readTestimonials({ batchDir: out, models: models({ async listen() { throw new Error("read twice"); } }) })).read.length, 0, "a video is read once");
    // Published only on the owner's own Keep.
    assert.equal(keptAds(out).length, 0);
    writeFileSync(join(out, "review.json"), JSON.stringify({ ads: { [ads[1].folder]: "keep" }, photos: {} }));
    assert.deepEqual(keptAds(out).map((a) => [a.folder, a.video_id]), [[ads[1].folder, ads[1].id]]);
    const V = testimonialsView(out); assert.deepEqual([V.length, V[0].read, V[0].decide.length, V[0].drafts], [2, true, 2, 0]);
  } finally { rmSync(G.d, { recursive: true, force: true }); }
});

test("TV2 the checks on a testimonial's copy: no weight or size figure, a quote only as said, no promise of the same result, no swear word, no medical condition, no coach's name; a distance or the offer's weeks is no figure", () => {
  const r = { transcript: SAID, quotes: [] }, P = (message) => testimonialProblems({ message, headline: "", description: "" }, r);
  assert.deepEqual(P(copyText(1)), []);
  assert.ok(P("She lost 8kg here.").some((e) => /a weight or size figure \("8kg"\)/.test(e)));
  assert.ok(P('"I love this place so much."').some((e) => /a quote the person does not say/.test(e)));
  assert.ok(P("You will lose the weight too.").some((e) => /a promise to the reader/.test(e)));
  assert.ok(P("So fucking proud.").some((e) => /a swear word/.test(e)));
  assert.ok(P("Her diastasis recti is better.").some((e) => /a medical condition/.test(e)));
  assert.ok(P("Coach Joel was there.").some((e) => /a coach's name \("Coach Joel"\)/.test(e)));
  assert.deepEqual([figuresIn("73KG → 65KG, 16.2KG"), figuresIn("a 15 km race in our 12 Week Full Body Sculpt")], [["73KG", "65KG", "16.2KG"], []]);
  assert.deepEqual([saidIn("my shifts were messy", SAID), saidIn("My shifts were terrible", SAID)], [true, false]);
  const { prompt } = buildCopyPrompt({ profile: { display_name: "Test Gym" }, reading: { speaker: "a member", name: "", summary: "s", struggle: [], change: [], liked: [], quotes: ["I was low", "so fucking proud of it"], transcript: SAID }, offer: OFFER, area: "BISHAN" });
  assert.ok(/NO FIGURES/.test(prompt) && /Never name a coach/.test(prompt) && prompt.includes('- "I was low"') && !prompt.includes("so fucking proud"), "a quote with a swear word is never offered");
});

test("TV3 five copies and five headlines for each video, its own: drafts marked for the video, a draft that breaks a rule or says what the video does not is dropped and asked for once more, one block of text gets its line breaks; the batch's shared lists never hold them; what is kept is that ad's text on Facebook, an ad with none takes the shared copy, and a merge carries the copy and the reading along; the name as the owner spells it goes through every draft", skip, async () => {
  const G = gym();
  try {
    const out = add(G).dir, [a, b] = testimonialAds(out);
    await readTestimonials({ batchDir: out, models: models() });
    let drafts = 0; const asked = [];
    const ask = async (prompt) => {
      asked.push(prompt);
      if (/Check each one against what is actually said/.test(prompt)) { const bad = prompt.split("\n").findIndex((l) => /^\d+\. .*way 4/.test(l)); return { drafts: bad >= 0 ? [{ id: prompt.split("\n")[bad].match(/^(\d+)\./)[1], supported: false, unsupported: "on every day of the week" }] : [] }; }
      if (/LAYOUT|line breaks/i.test(prompt) && !/ONE video advert/.test(prompt)) return { texts: [] };   // the line-break call gives nothing: broken by rule
      drafts++; const k = drafts * 10;
      return drafts % 2 ? { copies: [1, 2, 3, 4, 5].map((n) => ({ message: n === 5 ? `She lost 8kg. Our ${OFFER}.` : n === 1 ? copyText(`${k}${n}`, "She did not know where to begin, and that is where many people are too, week after week.").replace(/\n\n/g, " ") : copyText(n === 4 ? 4 : `${k}${n}`), angle: "story" })), headlines: [1, 2, 3, 4, 5].map((n) => ({ headline: `A member's story ${k}${n}`, description: "" })) }
        : { copies: [1, 2].map((n) => ({ message: copyText(`${k}${n}`), angle: "pain" })), headlines: [] };
    };
    const r = await draftTestimonialCopy({ brandDir: G.g, batchDir: out, only: [a.id], ask });
    const mine = readCopy(out).drafts.filter((d) => d.for === a.id), C = mine.filter((d) => kindOf(d) === "copy"), H = mine.filter((d) => kindOf(d) === "headline");
    assert.deepEqual([r.videos[0].added, C.length, H.length, r.videos[0].dropped.map((x) => /8kg/.test(x.reason) ? "figure" : "unsupported").sort()], [10, 5, 5, ["figure", "unsupported"]]);
    assert.ok(C.every((d) => d.message.includes("\n") && d.status === "draft" && d.source === "testimonial"), "no copy is one block");
    assert.ok(asked.some((p) => /THESE WERE REFUSED/.test(p)) && asked.some((p) => /THE GYM'S OWN CAPTION for this video/.test(p)));
    assert.equal((await draftTestimonialCopy({ brandDir: G.g, batchDir: out, only: [a.id], ask: async () => { throw new Error("asked again"); } })).calls, 0, "a video with its ten is not drafted again");
    // Kept: that video's own, never the shared list.
    for (const d of mine) decideCopy(out, d.id, { status: "keep" }, { offer: OFFER });
    assert.deepEqual([keptCopies(out).length, keptCopies(out, "headline").length, ownCopies(out)[a.id].copies.length, ownCopies(out)[a.id].headlines.length], [0, 0, 5, 5]);
    // The name as the owner spells it.
    assert.deepEqual([correctName(out, a.id, "Anitha").changed, readReadings(out).videos[a.id].reading.name, readCopy(out).drafts.filter((d) => d.for === a.id).some((d) => /Anita/.test(d.message)), readCopy(out).drafts.filter((d) => d.for === a.id && d.status === "keep").length], [5, "Anitha", false, 10]);
    assert.throws(() => correctName(out, a.id, "12"), /a first name/);
    // The plan: its own text on the first video, the shared copy on the second.
    writeFileSync(join(out, "review.json"), JSON.stringify({ ads: { [a.folder]: "keep", [b.folder]: "keep" }, photos: {} }));
    const profile = { ...JSON.parse(readFileSync(join(G.g, "gym-profile.json"), "utf-8")), meta_assets: { ad_account_id: "act_1", page_id: "77", lead_form_id: "4001", singapore_beneficiary_id: "1", singapore_payer_id: "1" }, targeting_defaults: { geo: { radius_pins: [{ label: "P", place_key: "1", radius_km: 5, callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60 } } };
    const shared = { id: "s1", message: `Shared words for ${OFFER}`, headline: "Shared headline", description: "" };
    const plan = buildPlan({ profile, batch: JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")), kept: keptAds(out), presets: { presets: [] }, copies: [shared], headlines: [shared], own: ownCopies(out) });
    assert.deepEqual([plan.ads[0].copies.length, plan.ads[0].headlines.length, plan.ads[0].own_copy, plan.ads[1].copies, plan.ads[1].own_copy], [5, 5, { copies: 5, headlines: 5 }, ["s1"], undefined]);
    assert.ok(JSON.stringify(plan.ads[0].creative).includes("Anitha") && !JSON.stringify(plan.ads[0].creative).includes("{BUTTON}") && !JSON.stringify(plan.ads[1].creative).includes("Anitha"));
    // Merged: the copy and the reading come along, tied by the video's id.
    mkdirSync(join(G.g, "batches", "pics"), { recursive: true }); mkdirSync(join(G.g, "outputs", "pics", "101-c01-x", "4x5"), { recursive: true });
    writeFileSync(join(G.g, "batches", "pics", "brief.json"), JSON.stringify({ batch_id: "pics", offer: OFFER, locations: ["BISHAN"] })); writeFileSync(join(G.g, "outputs", "pics", "101-c01-x", "4x5", "c.png"), "x");
    writeFileSync(join(G.g, "outputs", "pics", "batch.json"), JSON.stringify({ batch_id: "pics", ratio: "4x5", photos: [], ads: [{ folder: "101-c01-x", file: "101-c01-x/4x5/c.png", candidate: "c01", location: "BISHAN", photos: [], words: { location: "BISHAN", audience: null, offer: OFFER } }], failed: [] }));
    writeFileSync(join(G.g, "outputs", "pics", "copy.json"), JSON.stringify({ drafts: [{ id: "p1", kind: "copy", status: "keep", message: "Pics copy", headline: "", description: "" }] }));
    const m = mergeBatches({ brandDir: G.g, sources: ["pics", "stories-of-members"] });
    assert.deepEqual([testimonialAds(m.dir).length, ownCopies(m.dir)[a.id].copies.length, keptCopies(m.dir).map((d) => d.id), readReadings(m.dir).videos[a.id].reading.name, keptAds(m.dir).length], [2, 5, ["p1"], "Anitha", 3]);
  } finally { rmSync(G.d, { recursive: true, force: true }); }
});
