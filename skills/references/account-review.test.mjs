/**
 * Tests for the account review and the suggested next brief (Phase 6, 2026-11-11) — offline: a throwaway gym
 * folder, no Meta, no Gemini.
 *
 *   node --test skills/references/account-review.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownLeans, portfolioLeans, lastBrief, suggestBrief, buildReview, reviewText, reviewAccount, LEAN_MIN_LEADS, LEAN_MIN_PICTURES, REVIEW_FILE } from "./account-review.mjs";
import { importExport } from "./ads-export.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";
import { validateBrief, planVisuals, leanProblems, LEAN_SHARE } from "./plan-offer-batch.mjs";
import { loadCatalogue } from "./render-composites.mjs";
import { sceneGuideFrom, sceneKindOf, pictureKey, WINNERS_MAX } from "./what-wins.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** A different picture each time: the bytes differ, so each is read once. */
const png = (n) => { const b = Buffer.from(PNG); b.writeUInt32BE(1080, 16); b.writeUInt32BE(1350 + n, 20); return b; };
const R = (over) => ({ source: "account", ad_id: "x", ad_name: "x", status: "active", media: "image", offer: "Offer A", spend: 0, impressions: 0, leads: 0, cost_per_lead: null, frequency: 1, hashes: [over.ad_id || "x"], ...over });
const read = (over) => ({ format: "studio-portrait", subject: "woman", backdrop: "dark-wall", pose: "easy-posed", expression: "smile", eye_contact: false, text_density: "light", logo: false, ratio: "4:5", ...over });
const portrait = (id, over = {}) => ({ id, audience: "any", format: "studio-portrait", scene: `A woman stands at ease, ${id}.`, pose: "upright", people: 1, age: "prime", backdrop: "dark-wall", stance: "easy-posed", expression: "smile", eye_contact: false, ...over });
const workout = (id, over = {}) => ({ id, audience: "any", scene: `A woman lifts, ${id}.`, pose: "upright", people: 1, exercise: "squat", age: "prime", setting: "solo", equipment: "dumbbells", ...over });

function gym({ scenes = null, brief = null } = {}) {
  const d = mkdtempSync(join(tmpdir(), "acct-review-")), g = join(d, "brands", "testgym");
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify(PROFILE_STARTER("testgym", "Test Gym", "SG")));
  if (scenes) writeFileSync(join(g, "scenes.json"), JSON.stringify({ approved: true, approved_on: "2026-11-01", scenes }));
  if (brief) { mkdirSync(join(g, "batches", brief.batch_id), { recursive: true }); writeFileSync(join(g, "batches", brief.batch_id, "brief.json"), JSON.stringify(brief)); }
  return { d, g };
}

test("AR1 the lean from the gym's own leads: a value is leaned on only with solid leads, over two pictures or more, clearly cheaper than a value with enough leads to compare — one picture's leads are that picture's (never its pose, its expression and its head count at once); a reading maps to a scene tag per kind of photograph, and a value no scene can be asked for maps to nothing; this app's own ads lean workout scenes by their tags", () => {
  const rows = [
    R({ ad_id: "a", spend: 600, leads: 40, read: read({}) }),
    R({ ad_id: "b", spend: 900, leads: 60, read: read({ subject: "couple", pose: "holding-equipment" }) }),
    R({ ad_id: "c", spend: 460, leads: 20, read: read({ backdrop: "seamless-colour", eye_contact: true }) }),
    R({ ad_id: "d", spend: 100, leads: 4, read: read({ backdrop: "gym-floor" }) }), // too few leads to compare
  ];
  const own = ownLeans(rows, { currency: "SGD" });
  // dark-wall: 100 leads over 2 pictures at 15.00 against seamless-colour's 20 at 23.00.
  const bd = own.find((l) => l.tag === "backdrop");
  assert.deepEqual([bd.format, bd.value, bd.source], ["studio-portrait", "dark-wall", "own"]);
  assert.match(bd.why, /dark-wall earns this gym's leads cheaper \(100 over 2 pictures at SGD 15\.00, against seamless-colour with 20 at SGD 23\.00\)/);
  // The gaze follows the same two pictures; said in words, a boolean on the scene.
  const eye = own.find((l) => l.tag === "eye_contact");
  assert.equal(eye.value, false); assert.match(eye.why, /looking away earns/);
  // The couple (60 leads at 15.00) is one picture: not a lean on its own, whatever it cost.
  assert.ok(!own.some((l) => l.tag === "people" || l.tag === "stance"), "one picture names nothing");
  assert.ok(LEAN_MIN_PICTURES >= 2 && LEAN_MIN_LEADS >= 20);
  // The same picture under two ads (two locations) is still one picture.
  const twice = [R({ ad_id: "a1", hashes: ["same"], spend: 300, leads: 30, read: read({ pose: "holding-equipment" }) }), R({ ad_id: "a2", hashes: ["same"], spend: 300, leads: 30, read: read({ pose: "holding-equipment" }) }), R({ ad_id: "z", spend: 500, leads: 20, read: read({ pose: "easy-posed" }) })];
  assert.deepEqual(ownLeans(twice).filter((l) => l.tag === "stance"), []);
  // Too small a gap, or a thin winner, is no lean.
  assert.deepEqual(ownLeans([R({ ad_id: "a", spend: 200, leads: 10, read: read({}) }), R({ ad_id: "b", spend: 190, leads: 9, read: read({}) }), R({ ad_id: "c", spend: 460, leads: 20, read: read({ backdrop: "seamless-colour" }) })]).filter((l) => l.tag === "backdrop"), [], "19 leads is not solid");
  assert.deepEqual(ownLeans([R({ ad_id: "a", spend: 400, leads: 20, read: read({}) }), R({ ad_id: "b", spend: 400, leads: 20, read: read({}) }), R({ ad_id: "c", spend: 420, leads: 20, read: read({ backdrop: "seamless-colour" }) })]).filter((l) => l.tag === "backdrop"), [], "5% cheaper is not clearly cheaper");
  // A workout picture's backdrop is not something a workout scene is asked for; a group is.
  const w = [R({ ad_id: "g1", spend: 300, leads: 30, read: read({ format: "workout", subject: "group", backdrop: "studio-room" }) }), R({ ad_id: "g2", spend: 300, leads: 30, read: read({ format: "workout", subject: "group", backdrop: "studio-room" }) }), R({ ad_id: "s1", spend: 400, leads: 20, read: read({ format: "workout", subject: "woman", backdrop: "gym-floor" }) })];
  assert.deepEqual(ownLeans(w).map((l) => [l.format, l.tag, l.value]), [["workout", "setting", "group"]]);
  assert.deepEqual(ownLeans(w, { formats: ["studio-portrait"] }), [], "only the kinds in the batch");
  // This app's own published ads carry their scene tags: the exercise that earns leads cheaper.
  const app = (id, photo, over) => R({ source: "app", ad_id: id, batch: "b1", photos: photo, format: null, ...over });
  const mine = [app("1", "g01", { exercise: "squat", equipment: "barbell", spend: 300, leads: 25 }), app("2", "g02", { exercise: "squat", equipment: "dumbbells", spend: 280, leads: 20 }), app("3", "g03", { exercise: "lunge", equipment: "dumbbells", spend: 500, leads: 20 }), app("4", "g04+g05", { exercise: "squat+lunge", spend: 10, leads: 9 })];
  const ex = ownLeans(mine).find((l) => l.tag === "exercise");
  assert.deepEqual([ex.format, ex.value], ["workout", "squat"]);
  assert.match(ex.why, /squat earns this gym's leads cheaper \(45 over 2 pictures at SGD 12\.89/);
});

test("AR2 what holds across the other gyms becomes a lean only where a scene can be asked for it (a group on the floor, a portrait's plain backdrop), only for a kind in the batch, and never over the gym's own account on the same tag", () => {
  const next = [
    { attribute: "format", value: "class-group", source: "portfolio", text: "Format: class-group — across 2 gyms…" },
    { attribute: "subject", value: "group", source: "portfolio", text: "Subject: group — across 2 gyms…" },
    { attribute: "backdrop", value: "seamless-colour", source: "portfolio", text: "Backdrop: seamless-colour — across 3 gyms…" },
    { attribute: "ratio", value: "1:1", source: "portfolio", text: "Ratio: 1:1 — …" }, // the square is no longer made: never a lean
    { attribute: "expression", value: "effort", source: "portfolio", text: "Expression: effort — …" },
    { attribute: "backdrop", value: "dark-wall", source: "own", text: "own" },
  ];
  assert.deepEqual(portfolioLeans(next).map((l) => [l.format, l.tag, l.value, l.source]), [["workout", "setting", "group", "portfolio"], ["studio-portrait", "backdrop", "seamless-colour", "portfolio"]]);
  assert.deepEqual(portfolioLeans(next, { formats: ["workout"] }).map((l) => l.tag), ["setting"]);
  assert.deepEqual(portfolioLeans(next, { have: [{ format: "studio-portrait", tag: "backdrop", value: "dark-wall" }] }).map((l) => l.tag), ["setting"], "the gym's own account comes first");
});

test("AR3 the suggested brief: the offer, locations and audience are the owner's own last words (never invented), the photos are the suggested mix as photos, a lean is kept only when an approved scene of the audience shows it (else it is said, with what to do), a card of each kind that is ready and has never run is added, and the brief passes the batch's own rules; a gym with no batch leaves the offer for the owner", () => {
  const scenes = [portrait("w-p-1"), portrait("w-p-2", { backdrop: "seamless-colour" }), workout("w-1"), workout("w-2", { exercise: "lunge" })];
  const { d, g } = gym({ scenes, brief: { batch_id: "2026-11-01-six-week", offer: "6 Week Strength Challenge", locations: ["JURONG WEST"], audience: "LADIES WANTED", generated: 6 } });
  try {
    // An older batch is not the last one.
    mkdirSync(join(g, "batches", "2026-10-01-old"), { recursive: true }); writeFileSync(join(g, "batches", "2026-10-01-old", "brief.json"), JSON.stringify({ batch_id: "2026-10-01-old", offer: "Old Offer", locations: ["X"] }));
    assert.equal(lastBrief(g).id, "2026-11-01-six-week");
    const rows = [
      R({ ad_id: "a", spend: 600, leads: 40, offer: "Toned Tummy", read: read({}) }), R({ ad_id: "b", spend: 900, leads: 60, offer: "Toned Tummy", read: read({}) }),
      R({ ad_id: "c", spend: 460, leads: 20, offer: "Body Reset", read: read({ backdrop: "seamless-colour" }) }),
    ];
    const mix = { changed: true, current: { workout: 100 }, suggested: { workout: 80, "studio-portrait": 20 }, reasons: ["studio-portrait is not in the mix yet: give it 20% so it is tested."] };
    const next = [{ attribute: "subject", value: "group", source: "portfolio", text: "Subject: group — across 2 gyms it leads." }];
    const s = suggestBrief(g, { rows, mix, next, currency: "SGD" });
    assert.equal(s.from, "2026-11-01-six-week");
    assert.deepEqual([s.brief.offer, s.brief.locations, s.brief.audience], ["6 Week Strength Challenge", ["JURONG WEST"], "LADIES WANTED"]);
    assert.deepEqual(s.brief.mix, { workout: 8, "studio-portrait": 2 });
    assert.deepEqual(s.brief.lean.map((l) => [l.format, l.tag, l.value]), [["studio-portrait", "backdrop", "dark-wall"]]);
    assert.ok(s.brief.lean[0].why.length <= 300);
    // No approved scene shows a group: said, with what to do — never sent to the planner.
    assert.equal(s.left.length, 1); assert.match(s.left[0].text, /group setting \(workout\): no approved scene shows it yet\. Draft some on Draft Scenes/);
    assert.match(s.reasons.find((x) => x.field === "offer").text, /your last batch's own words \(2026-11-01-six-week\)/);
    assert.match(s.reasons.filter((x) => x.field === "offer")[1].text, /Running now: Toned Tummy \(100 leads at SGD 15\.00\), Body Reset \(20 leads at SGD 23\.00\)/);
    assert.match(s.reasons.find((x) => x.field === "mix").text, /^8 workout, 2 studio portrait — the suggested mix\./);
    assert.equal(s.brief.cards, undefined, "no card is ready");
    // As a brief it passes the batch's own rules.
    assert.deepEqual(validateBrief({ batch_id: "2026-11-11-next", ...s.brief, real: [], looks_per_photo: 2 }, { catalogue: loadCatalogue() }), []);
    // A kept statement, never run here: one card, free to test.
    writeFileSync(join(g, "card-words.json"), JSON.stringify({ statements: [{ id: "st-1", text: "Six weeks of coached strength sessions, built for women who are starting again.", status: "kept", by: "owner", added: "2026-11-11" }], timelines: [] }));
    const s2 = suggestBrief(g, { rows, mix, next });
    assert.deepEqual(s2.brief.cards, { statement: 1 });
    assert.match(s2.reasons.find((x) => x.field === "cards").text, /One statement card: ready and never run here/);
    assert.deepEqual(suggestBrief(g, { rows: [...rows, R({ ad_id: "k", format: "statement", spend: 5, leads: 1 })], mix, next }).brief.cards, undefined, "a kind that has run is not a test any more");
    // The mix as it is, all workout: no mix on the brief, and only workout leans.
    const s3 = suggestBrief(g, { rows, mix: { changed: false, current: { workout: 100 }, suggested: { workout: 100 }, reasons: [] }, next: [] });
    assert.equal(s3.brief.mix, undefined); assert.equal(s3.brief.lean, undefined);
    assert.match(s3.reasons.find((x) => x.field === "mix").text, /this gym's mix as it is/);
  } finally { rmSync(d, { recursive: true, force: true }); }
  // No batch, no wording: the offer is the owner's to type.
  const { d: d2, g: g2 } = gym();
  try { const s = suggestBrief(g2, { rows: [], mix: null, next: [] }); assert.equal(s.brief.offer, ""); assert.match(s.reasons[0].text, /left for you to type/); assert.equal(s.from, null); }
  finally { rmSync(d2, { recursive: true, force: true }); }
});

const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach,Frequency`;
const line = (ad, results, spend, freq = 1.2, delivery = "active") => `2026-04-13,2026-11-08,"${ad}",${delivery},"7-day click or 1-day view",${results},actions:leadgen.other,${results ? (spend / results).toFixed(4) : 0},100,Daily,${spend},${results * 900 + 1000},${results * 300 + 500},${freq}`;

test("AR4 the review, from what is on disk and with no call: an export's running ads read by a (fake) vision model, the numbers (an export carries no 30-day figure, so none is shown), keep / tiring / consider pausing by rule, the drift of this app's campaigns, the mix, and the next batch with its lean; the run records itself, reads new pictures only under its cap, and a gym with no reachable account is reviewed from what is on file", async () => {
  const scenes = [portrait("w-p-1"), portrait("w-p-2", { backdrop: "seamless-colour" }), portrait("w-p-3"), workout("w-1"), workout("w-2", { exercise: "lunge" })];
  const { d, g } = gym({ scenes, brief: { batch_id: "2026-11-01-six-week", offer: "6 Week Strength Challenge", locations: ["JURONG WEST"], audience: null, generated: 6 } });
  try {
    const names = ["Dark Wall Lady One", "Dark Wall Lady Two", "Pink Seamless Lady", "Teal Seamless Lady", "Gym Floor Squat"];
    const csv = join(d, "x.csv");
    writeFileSync(csv, [HEADER, line(`0413 Body Reset | Image 1: ${names[0]}`, 60, 780, 3.6), line(`0413 Body Reset | Image 2: ${names[1]}`, 40, 560), line(`0413 Body Reset | Image 3: ${names[2]}`, 12, 290), line(`0413 Body Reset | Image 4: ${names[3]}`, 10, 240), line(`0413 Body Reset | Image 5: ${names[4]}`, 6, 290)].join("\n") + "\n");
    const cr = join(d, "creatives"); mkdirSync(cr); names.forEach((n, i) => writeFileSync(join(cr, `${n}.png`), png(i)));
    importExport({ gymDir: g, csv, creatives: cr, label: "April campaign" });
    // This app's own campaign, with a budget changed in Ads Manager.
    mkdirSync(join(g, "outputs", "2026-10-01-old"), { recursive: true });
    writeFileSync(join(g, "outputs", "2026-10-01-old", "results.json"), JSON.stringify({ pulled: "2026-11-10T00:00:00Z", drift: [{ kind: "adset_budget", callout: "JURONG WEST", text: "ad set JURONG WEST's budget on Meta is SGD 120 a day; the app's setting is SGD 100", fixable: true }] }));

    // Before any picture is read: the numbers and the unread note, no lean.
    const r0 = buildReview(g, { brandsDir: join(d, "brands"), now: new Date("2026-11-11T02:00:00Z") });
    assert.deepEqual([r0.numbers.running.ads, r0.numbers.running.leads, r0.numbers.running.cost_per_lead], [5, 128, 16.88]);
    assert.equal(r0.numbers.last_30d, null, "an export's rows carry no 30-day figure: nothing is said rather than nought");
    assert.equal(r0.data.unread, 5); assert.equal(r0.brief.lean, undefined);
    assert.ok(r0.notes.some((x) => /no picture read yet/.test(x)));

    // The run: no reachable account (said), the new pictures read under the cap, the run recorded.
    const calls = [], log = [];
    const ask = async (file) => { calls.push(file); const dark = /dark-wall/i.test(file), floor = /gym-floor/i.test(file); return { format: floor ? "workout" : "studio-portrait", subject: "woman", people: 1, backdrop: dark ? "dark-wall" : floor ? "gym-floor" : "seamless-colour", pose: floor ? "mid-exercise" : "easy-posed", expression: floor ? "effort" : "smile", eye_contact: !dark, mood: "warm", text_density: "light", words: [], logo: false, colours: [] }; };
    const run1 = await reviewAccount({ gymDir: g, brandsDir: join(d, "brands"), client: null, readMax: 3, ask, log: (m) => log.push(m), now: () => new Date("2026-11-11T03:00:00Z") });
    assert.equal(calls.length, 3, "the cap is the cap");
    assert.match(log.join("\n"), /no ad account on the profile: nothing to pull from Meta/);
    assert.deepEqual([run1.record.pulled, run1.record.read.read, run1.record.read.left], [false, 3, 2]);
    assert.equal(JSON.parse(readFileSync(join(g, REVIEW_FILE), "utf-8")).reviewed, "2026-11-11T03:00:00.000Z");
    await reviewAccount({ gymDir: g, brandsDir: join(d, "brands"), client: null, readMax: 10, ask, log: () => {} });
    assert.equal(calls.length, 5, "a picture is read once");
    const before = calls.length; await reviewAccount({ gymDir: g, brandsDir: join(d, "brands"), client: null, readMax: 0, ask, log: () => {} }); assert.equal(calls.length, before, "no reading unless asked");

    const r = buildReview(g, { brandsDir: join(d, "brands"), now: new Date("2026-11-11T04:00:00Z") });
    assert.equal(r.data.unread, 0); assert.ok(r.last.reviewed);
    assert.deepEqual(r.data.exports.map((e) => e.label), ["April campaign"]);
    assert.ok(r.tiring.some((x) => /Dark Wall Lady One has been seen 3\.6 times/.test(x)));
    assert.ok(r.pause.some((x) => /Gym Floor Squat — 6 leads at SGD 48\.33/.test(x)));
    assert.deepEqual(r.drift, [{ batch: "2026-10-01-old", kind: "adset_budget", text: "ad set JURONG WEST's budget on Meta is SGD 120 a day; the app's setting is SGD 100", fixable: true }]);
    // Portraits get their floor, then a step more: 122 leads well under the account's median.
    assert.equal(r.mix.changed, true); assert.deepEqual(r.mix.suggested, { workout: 70, "studio-portrait": 30 });
    // The next batch: the owner's last words, the suggested mix as photos, and the lean on what earns leads here.
    assert.deepEqual([r.brief.offer, r.brief.locations, r.brief_from], ["6 Week Strength Challenge", ["JURONG WEST"], "2026-11-01-six-week"]);
    assert.deepEqual(r.brief.mix, { workout: 7, "studio-portrait": 3 });
    assert.deepEqual(r.brief.lean.map((l) => [l.format, l.tag, l.value]), [["studio-portrait", "backdrop", "dark-wall"], ["studio-portrait", "eye_contact", false]]);
    const text = reviewText(r);
    for (const re of [/^Test Gym — account review/, /Running now: 5 ads, SGD 2160\.00 spent, 128 leads at SGD 16\.88\. All time:/, /Tiring:/, /Consider pausing:/, /Meta differs from what the app sent:\n- 2026-10-01-old: ad set JURONG WEST's budget/, /The next batch:/, /Lean on dark-wall backdrop \(studio-portrait\)/]) assert.match(text, re);
    assert.doesNotMatch(text, /Last 30 days/);

    // The planner follows the lean up to its share, and the rest keep the variety.
    const cat = loadCatalogue({ look: "formula" });
    const many = [...Array(4)].map((_, i) => portrait(`d-${i}`)).concat([...Array(4)].map((_, i) => portrait(`s-${i}`, { backdrop: "seamless-colour" })), [...Array(4)].map((_, i) => portrait(`f-${i}`, { backdrop: "gym-floor" })));
    const v = planVisuals({ count: 6, scenes: many, audience: "any", seed: "t", catalogue: cat, ratio: "4x5", mix: { "studio-portrait": 6 }, lean: [{ tag: "backdrop", value: "dark-wall", format: "studio-portrait" }, { tag: "setting", value: "group", format: "workout" }] });
    const dark = v.filter((x) => x.tags.backdrop === "dark-wall").length;
    assert.equal(dark, Math.ceil(LEAN_SHARE * 6), "the lean is followed to its share");
    assert.ok(new Set(v.map((x) => x.tags.backdrop)).size >= 2, "the other backdrops are still tested");
    assert.deepEqual(v.leaned, [{ tag: "backdrop", value: "dark-wall", format: "studio-portrait", photos: 4, cap: 4, shown: true }, { tag: "setting", value: "group", format: "workout", photos: 0, cap: 1, shown: false }]);
    assert.equal(planVisuals({ count: 6, scenes: many, audience: "any", seed: "t", catalogue: cat, ratio: "4x5", mix: { "studio-portrait": 6 } }).filter((x) => x.tags.backdrop === "dark-wall").length, 2, "without it the backdrops are level");
    // The brief's own rules for a lean.
    assert.deepEqual(leanProblems([{ tag: "backdrop", value: "dark-wall", format: "studio-portrait", why: "x" }, { tag: "people", value: 2 }, { tag: "eye_contact", value: false }, { tag: "exercise", value: "squat" }]), []);
    assert.match(leanProblems([{ tag: "backdrop", value: "pink" }])[0], /"pink" is not a value of backdrop/);
    assert.match(leanProblems([{ tag: "logo", value: "yes" }])[0], /unknown tag "logo"/);
    assert.match(leanProblems([{ tag: "setting", value: "group", format: "square" }])[0], /format "square" is not one of/);
    assert.match(leanProblems("dark walls")[0], /lean must be a list of up to 6/);
    assert.ok(existsSync(join(g, REVIEW_FILE)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AR5 scenes drafted from the results (2026-11-11): the guide the drafter is told, by rule — a picture's kind as a scene would be drafted for it (this app's ad is what its batch says, a class or group shot is a workout scene, a card or premises photo is none); the recent ads when they have 20+ leads, else every ad; each attribute's values with 5+ leads, the cheapest first, and this app's own scene tags; the best pictures — one picture in two places counts once — with the scene each was made from; the review warns when the mix names a kind with no approved scene and lists the scenes to draft first, from the results where the gym has any", () => {
  const NOW = new Date("2026-11-11T00:00:00Z"), wr = (over) => read({ format: "workout", backdrop: "gym-floor", pose: "mid-exercise", expression: "effort", ...over });
  assert.deepEqual([sceneKindOf(R({ read: wr({ format: "class-group" }) })), sceneKindOf(R({ read: read({}) })), sceneKindOf(R({ read: wr({ format: "premises" }) })), sceneKindOf(R({})), sceneKindOf(R({ source: "app", format: "review", read: wr({}) })), sceneKindOf(R({ source: "app", format: "studio-portrait", read: wr({}) }))], ["workout", "studio-portrait", null, null, null, "studio-portrait"]);
  assert.equal(pictureKey({ source: "app", batch: "b1", photos: "r03" }), "b1/r03");
  const app = (ad_id, over) => R({ ad_id, source: "app", batch: "b1", published: "2026-10-20", status: "live", read: wr({ format: "class-group", subject: "group", backdrop: "studio-room", expression: "neutral" }), ...over });
  const rows = [
    app("a1", { photos: "r03", scenes: "w-group-swing", setting: "group", equipment: "kettlebell", exercise: "kettlebell-swing", age_tag: "prime", location: "BISHAN", spend: 1800, leads: 100, cost_per_lead: 18 }),
    app("a2", { photos: "r03", scenes: "w-group-swing", setting: "group", equipment: "kettlebell", exercise: "kettlebell-swing", age_tag: "prime", location: "ANG MO KIO", spend: 1700, leads: 98, cost_per_lead: 17.35 }),
    app("a3", { photos: "r05", scenes: "w-lunge", setting: "solo", equipment: "bodyweight", exercise: "lunge", age_tag: "older", spend: 660, leads: 30, cost_per_lead: 22, read: wr({ subject: "woman", backdrop: "studio-room", expression: "neutral" }) }),
    app("a4", { photos: "r07+r08", scenes: "w-press+w-row", setting: "solo+solo", equipment: "machine+cable", exercise: "chest-press+cable-row", spend: 500, leads: 12, cost_per_lead: 41.67, read: wr({ subject: "man" }) }),
    app("a5", { photos: "r09", scenes: "real photo", spend: 60, leads: 0, format: null, read: wr({ format: "premises", subject: "none" }) }), // the empty room: no kind
    R({ ad_id: "old", status: "paused", published: "2024-03-01", spend: 300, leads: 60, cost_per_lead: 5, read: wr({ subject: "woman", backdrop: "seamless-colour", expression: "smile" }) }), // an old campaign, another offer
    R({ ad_id: "vid", media: "video", status: "active", spend: 100, leads: 50, cost_per_lead: 2, read: wr({}) }),
    R({ ad_id: "p1", status: "active", spend: 430, leads: 10, cost_per_lead: 43, read: read({ backdrop: "studio-room", expression: "neutral" }) }),
  ];
  const scenes = [workout("w-group-swing", { audience: "women", people: 3, setting: "group", equipment: "kettlebell", exercise: "kettlebell-swing", scene: "Three women swinging kettlebells, loosely spaced." }), workout("w-lunge", { audience: "women", exercise: "lunge", equipment: "bodyweight", age: "older", scene: "A woman in her sixties in a reverse lunge." })];
  const g = sceneGuideFrom(rows, "workout", { currency: "SGD", scenes, now: NOW });
  assert.deepEqual([g.format, g.scope, g.ads, g.leads, g.median], ["workout", "recent", 4, 240, 22], "the four recent workout stills: the old campaign, the video, the premises photo and the portrait are out; the median is the account's recent stills' (17.35, 18, 22, 41.67 and the portrait's 43)");
  assert.deepEqual(g.lines.slice(0, 3), ["Kind of shot: class-group (198 leads at SGD 17.68), workout (42 leads at SGD 27.62)", "Subject: group (198 leads at SGD 17.68), woman (30 leads at SGD 22.00), man (12 leads at SGD 41.67)", "Backdrop: studio-room (228 leads at SGD 18.25), gym-floor (12 leads at SGD 41.67)"]);
  assert.ok(g.lines.includes("Setting (the ads this app made): group (198 leads at SGD 17.68), solo (30 leads at SGD 22.00)"), "a two-photo ad's joined tags are skipped: " + g.lines.join(" | "));
  assert.ok(g.lines.includes("Exercise (the ads this app made): kettlebell-swing (198 leads at SGD 17.68), lunge (30 leads at SGD 22.00)"));
  assert.deepEqual(g.winners.map((w) => [w.leads, w.cost_per_lead, w.ads, w.scene_id]), [[198, 17.68, 2, "w-group-swing"], [30, 22, 1, "w-lunge"]], "one picture in two locations is one winner; 30 leads at the median counts; 12 at 41.67 is dear");
  assert.equal(g.winners[0].text, "198 leads at SGD 17.68 over 2 ads — made from this scene: Three women swinging kettlebells, loosely spaced.");
  assert.ok(WINNERS_MAX >= 3);
  // Under 20 recent leads the whole history is read; an account's ad says what its reading saw.
  const thin = sceneGuideFrom(rows.filter((r) => ["a4", "old"].includes(r.ad_id)), "workout", { currency: "SGD", now: NOW });
  assert.deepEqual([thin.scope, thin.ads, thin.leads, thin.winners.map((w) => w.text)], ["all", 2, 72, ["60 leads at SGD 5.00 — the picture shows: workout, woman, seamless-colour, mid-exercise, smile"]]);
  const pg = sceneGuideFrom(rows, "studio-portrait", { now: NOW });
  assert.deepEqual([pg.leads, pg.scope, pg.winners], [10, "all", []], "the gym's one portrait at 43 is no winner: the bar is the account's median, not its own");
  assert.equal(sceneGuideFrom([R({ ad_id: "z", spend: 50, leads: 0, read: wr({}) })], "workout", { now: NOW }), null, "no lead: nothing to draft from");

  // The review: the mix names studio portraits, the library has none approved; the workout winner has a scene.
  const { d, g: dir } = gym({ scenes: [...scenes, { ...portrait("w-p-draft", { audience: "women" }), draft: true }], brief: { batch_id: "2026-10-20-offer", offer: "6 Week Reset", locations: ["BISHAN"], audience: "LADIES" } });
  try {
    const profile = JSON.parse(readFileSync(join(dir, "gym-profile.json"), "utf-8")); profile.creative_defaults = { ...profile.creative_defaults, generated: 10, mix: { workout: 80, "studio-portrait": 20 } };
    const s = suggestBrief(dir, { rows, every: rows, currency: "SGD", profile, now: NOW });
    assert.deepEqual(s.brief.mix, { workout: 8, "studio-portrait": 2 });
    const none = s.left.find((l) => l.kind === "no_scenes");
    assert.match(none.text, /^2 studio portraits in the mix, but no studio portrait scene is approved for women \(1 draft await your approval on Draft Scenes\)\. Generate Creatives refuses the batch until one is: draft some first, or take them out of the mix on Generate Creatives\.$/);
    assert.deepEqual(s.scenes.map((x) => [x.format, x.audience, x.count, x.from_results, x.needed, x.approved, x.drafts_waiting]), [["workout", "women", 6, true, false, 2, 0], ["studio-portrait", "women", 6, true, true, 0, 1]]);
    assert.match(s.scenes[0].why, /^New versions of what earns this gym's leads: its best workout picture has 198 leads at SGD 17\.68 \(scene w-group-swing\)\.$/);
    assert.match(s.scenes[1].why, /^2 studio portraits are in the mix, but no studio portrait scene is approved for women: Generate Creatives refuses the batch until one is\. The drafter is told what this gym's studio portrait ads have done \(10 leads over 1 ad\)\.$/);
    assert.equal(s.scenes_waiting, 1);
    // Nothing to say for a kind with approved scenes and no results; and the report carries the list.
    const quiet = suggestBrief(dir, { rows: [], every: [], currency: "SGD", profile: { ...profile, creative_defaults: { ...profile.creative_defaults, mix: { workout: 100 } } }, now: NOW });
    assert.deepEqual(quiet.scenes, []);
    const bare = suggestBrief(dir, { rows: [], every: [], currency: "SGD", profile, now: NOW }).scenes;
    assert.deepEqual(bare.map((x) => [x.format, x.from_results, x.needed]), [["studio-portrait", false, true]], "no results for the kind: drafted by what the library has fewest of");
    const review = buildReview(dir, { now: NOW });
    assert.ok(Array.isArray(review.scenes) && review.scenes_waiting === 1);
    assert.match(reviewText({ ...review, scenes: s.scenes }), /Scenes to draft first \(text calls only, drafts for your approval\):\n- 6 workout scenes for women, from the results: New versions[^\n]+\n- 6 studio portrait scenes for women, from the results: [^\n]+\n- 1 scene draft await your approval on Draft Scenes\./);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
