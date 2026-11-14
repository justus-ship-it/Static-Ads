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
import { ownTests, shareTests, TEST_PHOTOS, MAX_TESTS, ownLeans, portfolioLeans, lastBrief, suggestBrief, buildReview, reviewText, reviewAccount, readLedger, recordReview, recordAction, lastTime, LEDGER_FILE, LEAN_MIN_LEADS, LEAN_MIN_PICTURES, REVIEW_FILE, actionFor, ledgerFrom, ledgerAcross, ledgerTests, gymLedger, LEDGER_VERDICTS } from "./account-review.mjs";
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
  // A workout picture's group is a scene's setting; its room (the studio room, the gym floor) is what the photo is matched to (2026-11-11); any other backdrop is nothing a workout photo is asked for.
  const w = [R({ ad_id: "g1", spend: 300, leads: 30, read: read({ format: "workout", subject: "group", backdrop: "studio-room" }) }), R({ ad_id: "g2", spend: 300, leads: 30, read: read({ format: "workout", subject: "group", backdrop: "studio-room" }) }), R({ ad_id: "s1", spend: 400, leads: 20, read: read({ format: "workout", subject: "woman", backdrop: "gym-floor" }) })];
  assert.deepEqual(ownLeans(w).map((l) => [l.format, l.tag, l.value]), [["workout", "setting", "group"], ["workout", "room", "studio-room"]]);
  assert.deepEqual(ownLeans(w.map((r) => ({ ...r, read: { ...r.read, backdrop: r.read.backdrop === "studio-room" ? "outdoors" : r.read.backdrop } }))).map((l) => l.tag), ["setting"]);
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
    assert.deepEqual(r.brief.lean.filter((l) => !l.test).map((l) => [l.format, l.tag, l.value]), [["studio-portrait", "backdrop", "dark-wall"], ["studio-portrait", "eye_contact", false]]);
    // What is not confirmed is tested, never leaned on: a tiring winner's kind, on photos set aside for it (2026-11-11).
    assert.ok(r.brief.lean.filter((l) => l.test).every((l) => Number.isInteger(l.photos) && l.photos >= 1 && l.photos <= 3 && !["backdrop", "eye_contact"].includes(l.tag)), JSON.stringify(r.brief.lean));
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
    assert.deepEqual(s.scenes.map((x) => [x.format, x.audience, x.count, x.from_results, x.needed, x.approved, x.drafts_waiting, x.cover || null]), [["workout", "women", 6, true, false, 2, 0, ["setting:group"]], ["studio-portrait", "women", 6, true, true, 0, 1, null]]);
    assert.match(s.scenes[0].why, /^New versions of what earns this gym's leads: its best workout picture has 198 leads at SGD 17\.68 \(scene w-group-swing\)\. No approved scene shows a smile mood \(workout\), which the results favour\. The batch tests group setting \(workout\) on 3 photos with only 1 approved scene that shows it: new versions need new scenes\.$/, "the old ad's smile is a lead too, but no scene says its mood yet: said, and drafted for");
    // The winner stands on one picture (run in two places): the batch tests its setting on three photos rather than leaning on it.
    assert.deepEqual(s.brief.lean.map((l) => [l.tag, l.value, l.format, l.test || false, l.photos ?? null]), [["setting", "group", "workout", true, 3]]);
    assert.ok(s.reasons.some((x) => x.field === "test" && /^Test group setting \(workout\) on 3 of the 8 workout photos — To test: group earned 198 leads at SGD 17\.68 on one picture, against /.test(x.text)), JSON.stringify(s.reasons.map((x) => x.text)));
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

test("AR6 the ledger (2026-11-11): the owner's review keeps every checked line with its verdict then, and marks what is no longer said; an action of the owner's (a pause) is kept with the ad's numbers; the next review opens with what happened — how the last batch's leans and tests came out against the rest of that batch, the paused ads, and what changed (a keeper now fading)", () => {
  const { d, g } = gym({ scenes: [workout("w-group", { audience: "women", people: 3, setting: "group" }), workout("w-solo", { audience: "women" }), workout("w-solo2", { audience: "women", exercise: "lunge" })] });
  try {
    assert.deepEqual([readLedger(g).insights, readLedger(g).actions], [{}, []]);
    const keep = { key: "keep:111", kind: "keep", verdict: "confirmed", text: "Keep running: Ad one", name: "Ad one", ads: ["111"], numbers: { leads: 30, cost_per_lead: 16, recent: { days: 7, leads: 6, spend: 90, cost_per_lead: 15 } }, checks: [] };
    const lead = { key: "attr:format=class-group", kind: "lead", verdict: "test", text: "To test…", label: "Format", attribute: "format", best: { value: "class-group", leads: 198, pictures: 1, cost_per_lead: 17.81 }, worst: { value: "workout", leads: 54, pictures: 5, cost_per_lead: 24.22 }, checks: [] };
    let L = recordReview(g, { insights: [keep, lead] }, { now: new Date("2026-11-04T02:00:00Z") });
    assert.deepEqual([Object.keys(L.insights).sort(), L.insights["keep:111"].history.length, L.insights["keep:111"].history[0].recent.cost_per_lead, L.insights["attr:format=class-group"].history[0].best.pictures, L.reviewed], [["attr:format=class-group", "keep:111"], 1, 15, 1, "2026-11-04T02:00:00.000Z"]);
    assert.ok(existsSync(join(g, LEDGER_FILE)));
    // A week on: the keeper is fading (said under another key), the lead is confirmed.
    const fading = { key: "tiring:111", kind: "tiring", verdict: "confirmed", fading: true, text: "Fading: Ad one", name: "Ad one", ads: ["111"], numbers: { leads: 48, cost_per_lead: 19, recent: { days: 7, leads: 18, spend: 529, cost_per_lead: 29.42 } }, checks: [] };
    const found = { ...lead, kind: "matters", verdict: "confirmed", best: { ...lead.best, pictures: 3 } };
    let T = lastTime(g, { rows: [], insights: [fading, found], currency: "SGD" });
    assert.deepEqual([T.since, T.changed.map((c) => c.text).sort()], ["2026-11-04T02:00:00.000Z", ["Ad one was a keeper on 2026-11-04; it is fading now.", "Format was a lead to test on 2026-11-04; it is a finding now."]]);
    L = recordReview(g, { insights: [fading, found] }, { now: new Date("2026-11-11T02:00:00Z") });
    assert.deepEqual([L.insights["keep:111"].gone, L.insights["tiring:111"].first_seen, L.insights["attr:format=class-group"].history.map((h) => h.kind)], ["2026-11-11T02:00:00.000Z", "2026-11-11T02:00:00.000Z", ["lead", "matters"]]);
    assert.deepEqual(lastTime(g, { rows: [], insights: [fading, found] }).changed, [], "nothing changed since the review just kept");
    // The owner paused an ad from here: kept with what it had cost; the next look says whether it has stayed paused.
    recordAction(g, { what: "pause", key: "pause:222", ad_id: "222", name: "Ad two", spend: 52.2, leads: 0 }, { now: new Date("2026-11-11T03:00:00Z") });
    T = lastTime(g, { rows: [{ ad_id: "222", status: "paused", paused_here: "2026-11-11T03:00:00.000Z", spend: 52.2 }], insights: [] });
    assert.deepEqual([T.paused[0].status, T.paused[0].text], ["paused", "Ad two: paused from here on 2026-11-11 after SGD 52.20 for 0 leads — still paused"]);
    T = lastTime(g, { rows: [{ ad_id: "222", status: "live", spend: 80 }], insights: [] });
    assert.deepEqual([T.paused[0].status, / it is running again on Meta \(SGD 80\.00 spent now\)$/.test(T.paused[0].text)], ["running", true]);
    // The last batch on Meta tested a group setting on three photos and leaned on older people: how each came out, against the rest of that batch.
    mkdirSync(join(g, "outputs", "2026-11-12-offer"), { recursive: true });
    writeFileSync(join(g, "outputs", "2026-11-12-offer", "batch.json"), JSON.stringify({ made: "2026-11-12T05:00:00Z", lean: [{ tag: "setting", value: "group", format: "workout", test: true, photos: 3 }, { tag: "exercise", value: "lunge", format: "workout" }, { tag: "setting", value: "coached", format: "workout" }] }));
    const row = (ad_id, scenes, photos, spend, leads) => ({ source: "app", batch: "2026-11-12-offer", ad_id, scenes, photos, format: "workout", status: "live", spend, leads, cost_per_lead: leads ? spend / leads : null });
    const rows = [row("1", "w-group", "g01", 300, 20), row("2", "w-group", "g02", 150, 10), row("3", "w-solo", "g03", 500, 20), row("4", "w-solo2", "g04", 90, 3), { ...row("5", "w-solo", "g05", 999, 0), superseded: true }, { ...row("9", "w-group", "g09", 10, 9), batch: "another" }];
    T = lastTime(g, { rows, insights: [], currency: "SGD" });
    assert.deepEqual([T.batch.id, T.batch.ads, T.batch.leads], ["2026-11-12-offer", 4, 53]);
    assert.deepEqual(T.tested.map((t) => [t.name, t.test, t.verdict, t.pictures, t.tested.leads]), [["group setting (workout)", true, "held", 2, 30], ["lunge exercise (workout)", false, "early", 1, 3], ["coached setting (workout)", false, "not_made", 0, 0]]);
    assert.equal(T.tested[0].text, "it held: 30 leads at SGD 15.00 over 2 pictures, against SGD 25.65 for the rest of the batch (23 leads)");
    assert.equal(T.tested[1].text, "too early: 3 leads so far from 1 picture (it takes 10 to say)");
    const worse = lastTime(g, { rows: rows.map((r) => (r.ad_id === "1" ? { ...r, spend: 900 } : r)), insights: [] }).tested[0];
    assert.deepEqual([worse.verdict, /^it did not hold: 30 leads at SGD 35\.00 over 2 pictures, against SGD 25\.65/.test(worse.text)], ["not_held", true]);
    // The report says it first.
    const text = reviewText({ ...buildReview(g, { now: new Date("2026-11-13T00:00:00Z") }), last_time: T });
    assert.match(text, /Last time, and what happened:\n- 2026-11-12-offer tested group setting \(workout\): it held: 30 leads at SGD 15\.00 over 2 pictures[^\n]+\n- 2026-11-12-offer leaned on lunge exercise \(workout\): too early[^\n]+\n[^\n]+not_made|no ad of the batch shows/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AR7 tests in a batch (2026-11-11): what is clear but not confirmed is tested, not leaned on — a lead on one picture, a tiring or fading winner's kind — on photos set aside for it (three to one test, two and one to two), one test per picture, on the broadest thing a scene can be asked for, never on what is already leaned on; the planner gives a test its photos ahead of any lean; a brief's test is checked like a lean", () => {
  const app = (ad_id, over) => R({ ad_id, source: "app", batch: "b1", status: "live", format: "workout", ...over });
  const wr = (over) => read({ format: "workout", backdrop: "gym-floor", pose: "mid-exercise", expression: "effort", ...over });
  const rows = [
    app("g1", { photos: "r03", scenes: "w-group", setting: "group", equipment: "kettlebell", exercise: "kettlebell-swing", spend: 1800, leads: 100, read: wr({ format: "class-group", subject: "group" }) }),
    app("g2", { photos: "r03", scenes: "w-group", setting: "group", equipment: "kettlebell", exercise: "kettlebell-swing", spend: 1700, leads: 98, read: wr({ format: "class-group", subject: "group" }) }),
    app("s1", { photos: "r05", scenes: "w-solo", setting: "solo", equipment: "bodyweight", exercise: "lunge", spend: 660, leads: 30, read: wr() }),
    app("s2", { photos: "r06", scenes: "w-solo2", setting: "solo", equipment: "machine", exercise: "chest-press", spend: 510, leads: 20, read: wr() }),
  ];
  // One picture (run in two places) names its setting, its equipment and its exercise at once: one test, on the setting.
  assert.deepEqual(ownLeans(rows, { formats: ["workout"] }), [], "nothing is confirmed on one picture");
  const tests = shareTests(ownTests(rows, { formats: ["workout"], currency: "SGD" }));
  assert.deepEqual(tests.map((t) => [t.format, t.tag, t.value, t.test, t.photos]), [["workout", "setting", "group", true, 3]]);
  assert.match(tests[0].why, /^To test: group earned 198 leads at SGD 17\.68 on one picture, against (woman|solo) with \d+ at SGD \d+\.\d\d\. One picture's leads are that picture's: this repeats it in new versions\.$/);
  assert.deepEqual([TEST_PHOTOS, MAX_TESTS], [3, 2]);
  // A second picture of the same kind and it is a lean, not a test; something already leaned on is never tested as well.
  const two = [...rows, app("g3", { photos: "r09", scenes: "w-group2", setting: "group", equipment: "dumbbells", exercise: "squat", spend: 400, leads: 22, read: wr({ format: "class-group", subject: "group" }) })];
  assert.deepEqual([ownLeans(two, { formats: ["workout"] }).map((l) => [l.tag, l.value]), ownTests(two, { formats: ["workout"], have: ownLeans(two, { formats: ["workout"] }) }).filter((t) => t.tag === "setting")], [[["setting", "group"]], []]);
  // A tiring winner: new versions of its kind — the scene's setting for an ad this app made, what its reading maps to for another.
  const tiring = (ad, fading = false) => ({ key: `tiring:${ad}`, kind: "tiring", verdict: "confirmed", fading, ads: [ad], name: `Ad ${ad}` });
  const t2 = shareTests(ownTests([app("s1", { photos: "r05", scenes: "w-solo", setting: "coached", spend: 300, leads: 30, read: wr() })], { formats: ["workout"], insights: [tiring("s1", true)] }));
  assert.deepEqual(t2.map((t) => [t.tag, t.value, t.photos, t.why]), [["setting", "coached", 3, "Fading: Ad s1 — new versions of the same kind before it stops paying."]]);
  const portraits = [R({ ad_id: "p1", spend: 900, leads: 60, read: read({ subject: "couple", pose: "holding-equipment" }) }), R({ ad_id: "p2", spend: 500, leads: 20, read: read({ backdrop: "seamless-colour" }) })];
  const t3 = shareTests(ownTests(portraits, { formats: ["studio-portrait"], insights: [tiring("p1")], have: [{ format: "studio-portrait", tag: "backdrop" }] }));
  assert.deepEqual(t3.map((t) => [t.tag, t.value, t.photos]), [["stance", "holding-equipment", 3]], "the backdrop is leaned on already: its pose is the next thing a scene can be asked for");
  // Two tests share the three photos; a third waits for another batch.
  const every = ownTests([...rows, ...portraits], { formats: ["workout", "studio-portrait"], insights: [tiring("p1")] }), three = shareTests(every);
  assert.deepEqual([every.length >= 2, three.length, three.map((t) => t.photos)], [true, 2, [2, 1]]);
  // The planner: a test's photos come first, ahead of a lean; the plan says how far each was followed.
  const scenes = [...["a", "b", "c", "d"].map((x) => workout(`w-group-${x}`, { audience: "women", people: 3, setting: "group", exercise: `swing-${x}` })), ...["a", "b", "c", "d", "e", "f", "g", "h"].map((x, i) => workout(`w-solo-${x}`, { audience: "women", setting: i % 2 ? "coached" : "solo", people: i % 2 ? 2 : 1, exercise: `lift-${x}`, age: i < 4 ? "older" : "prime" }))];
  const cat = loadCatalogue(), plan = (lean) => planVisuals({ count: 8, scenes, audience: "women", seed: "ar7", catalogue: cat, ratio: "4x5", lean });
  const vis = plan([{ tag: "setting", value: "group", format: "workout", test: true, photos: 3 }, { tag: "age", value: "older", format: "workout" }]);
  const groupAt = vis.map((v, i) => (scenes.find((s) => s.id === v.scene_id).setting === "group" ? i : -1)).filter((i) => i >= 0);
  assert.ok(groupAt.length >= 3 && groupAt.slice(0, 3).join() === "0,1,2", `the three test photos are planned first: ${groupAt}`);
  assert.deepEqual(vis.leaned.map((l) => [l.tag, l.value, l.test || false, l.cap, l.photos >= l.cap]), [["setting", "group", true, 3, true], ["age", "older", false, 5, false]].map((x, i) => (i === 1 ? [x[0], x[1], x[2], x[3], vis.leaned[1].photos >= 5] : x)));
  // A brief's test is checked like a lean: a whole number of photos, true or false.
  const ok = { tag: "setting", value: "group", format: "workout", test: true, photos: 3 };
  assert.deepEqual([leanProblems([ok]), leanProblems([{ ...ok, photos: 0 }]).length, leanProblems([{ ...ok, photos: 2.5 }]).length, leanProblems([{ ...ok, test: "yes" }]).length], [[], 1, 1, 1]);
});

test("AR8 rooms (2026-11-11): a photo is matched to one of the gym's rooms by the planner — a scene that names its room keeps it, a lean or a test on a room gives it to its share of the workout photos, never to a portrait — and the run takes that room's own photo as the reference for exactly those photos; a brief's room is checked against the rooms there are; a room the results favour with no photo tagged for it is said, with where to tag it", async () => {
  const { generateVisuals } = await import("./generate-visuals.mjs");
  const { ROOMS, SCENE_OPTIONAL_TAGS, sceneProblems } = await import("./scene-library.mjs");
  assert.deepEqual([Object.keys(ROOMS), SCENE_OPTIONAL_TAGS.room, SCENE_OPTIONAL_TAGS.mood], [["studio-room", "gym-floor"], ["studio-room", "gym-floor"], ["effort", "smile", "calm"]]);
  // A scene may say its room and its mood; anything else there is refused.
  const base = workout("w-x", { audience: "women", muscles: "legs" });
  assert.deepEqual([sceneProblems({ ...base, room: "gym-floor", mood: "smile" }), sceneProblems({ ...base, room: "rooftop" }).length, sceneProblems({ ...base, mood: "angry" }).length], [[], 1, 1]);
  assert.deepEqual([leanProblems([{ tag: "room", value: "studio-room", format: "workout" }, { tag: "mood", value: "calm" }]), leanProblems([{ tag: "room", value: "rooftop" }]).length], [[], 1]);
  // The planner: six workout photos, a lean on the studio room (60% of them), one scene that only makes sense on the gym floor.
  const scenes = [...["a", "b", "c", "d", "e"].map((x) => workout(`w-${x}`, { audience: "women", exercise: `lift-${x}` })), workout("w-rack", { audience: "women", exercise: "rack-pull", room: "gym-floor" }), portrait("w-p", { audience: "women" })];
  const cat = loadCatalogue();
  const vis = planVisuals({ count: 7, scenes, audience: "women", seed: "ar8", catalogue: cat, ratio: "4x5", mix: { workout: 6, "studio-portrait": 1 }, lean: [{ tag: "room", value: "studio-room", format: "workout" }] });
  const rooms = vis.map((v) => [v.scene_id, v.format || "workout", v.room || null]);
  assert.deepEqual([rooms.filter((r) => r[2] === "studio-room").length, rooms.find((r) => r[0] === "w-rack")[2], rooms.find((r) => r[1] === "studio-portrait")[2]], [4, "gym-floor", null], `60% of six workout photos, the rack scene keeps its floor, the portrait has no room: ${JSON.stringify(rooms)}`);
  assert.deepEqual(vis.leaned.map((l) => [l.tag, l.value, l.photos, l.cap, l.shown]), [["room", "studio-room", 4, 4, true]]);
  // A test on a room: exactly its photos.
  const t = planVisuals({ count: 6, scenes: scenes.slice(0, 5), audience: "women", seed: "ar8", catalogue: cat, ratio: "4x5", lean: [{ tag: "room", value: "gym-floor", format: "workout", test: true, photos: 2 }] });
  assert.equal(t.filter((v) => v.room === "gym-floor").length, 2);
  // The run: each photo's own room photo goes to the model, the default room reference to the rest.
  const dir = mkdtempSync(join(tmpdir(), "rooms-"));
  try {
    const file = (n) => { const p = join(dir, n); writeFileSync(p, png(n.length)); return p; };
    const def = file("default.png"), studio = file("studio-room.png"), sent = [];
    const visuals = [{ id: "g01", treatment: vis[0].treatment, scene: "A woman lifts.", pose: "upright", people: 1, tags: {}, room: "studio-room" }, { id: "g02", treatment: vis[0].treatment, scene: "A woman rows.", pose: "upright", people: 1, tags: {} }, { id: "g03", treatment: vis[0].treatment, scene: "A woman presses.", pose: "upright", people: 1, tags: {}, room: "gym-floor" }];
    const checked = [];
    await generateVisuals({ visuals, outDir: join(dir, "out"), ratio: "4x5", refs: [def], roomRefs: { "studio-room": studio, "gym-floor": join(dir, "missing-is-never-asked.png") }.constructor === Object ? { "studio-room": studio } : {}, maxCalls: 3, attempts: 1, catalogue: cat,
      checkRef: async (p) => { checked.push(p.split("/").pop()); return []; },
      generate: async ({ parts, outPath, images }) => { sent.push((parts || images || []).length); writeFileSync(outPath, png(7)); return { file: outPath }; },
      check: async () => ({ status: "passed", failures: [], notes: [], answer: { people_box: null, face_boxes: [], people_count: 1 } }), finish: null, log: () => {} }).catch((e) => { sent.push("error: " + e.message); });
    assert.deepEqual(checked.sort(), ["default.png", "studio-room.png"], "the room's own photo is checked like any reference; a room no photo asks for is not");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The review: the studio room earns the leads, on two pictures — a lean once a photo is tagged for it; said, with where, until then.
  const wr = (over) => read({ format: "workout", backdrop: "gym-floor", pose: "mid-exercise", expression: "effort", ...over });
  const rows = [R({ ad_id: "a", spend: 300, leads: 30, read: wr({ backdrop: "studio-room" }) }), R({ ad_id: "b", spend: 320, leads: 30, read: wr({ backdrop: "studio-room" }) }), R({ ad_id: "c", spend: 500, leads: 20, read: wr() })];
  assert.deepEqual(ownLeans(rows, { formats: ["workout"] }).map((l) => [l.format, l.tag, l.value]), [["workout", "room", "studio-room"]]);
  const { d, g } = gym({ scenes: scenes.slice(0, 5), brief: { batch_id: "2026-10-20-offer", offer: "6 Week Reset", locations: ["BISHAN"], audience: "LADIES" } });
  try {
    const profile = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8")); profile.creative_defaults = { ...profile.creative_defaults, generated: 10 };
    let s = suggestBrief(g, { rows, every: rows, currency: "SGD", profile });
    assert.deepEqual([s.brief.lean || [], s.left.map((l) => [l.kind, l.tag, l.value])], [[], [["no_room", "room", "studio-room"]]]);
    assert.match(s.left[0].text, /^the studio room \(workout\): no premises photo is tagged as the studio room yet, so a photo cannot be matched to it\. Say which photo shows it on Photos & assets \(one click\)\./);
    assert.deepEqual(s.scenes, [], "a room is not a scene's to show: nothing to draft for it");
    profile.creative_defaults.room_references = { "studio-room": "facility-clean/studio.png" };
    s = suggestBrief(g, { rows, every: rows, currency: "SGD", profile });
    assert.deepEqual([s.brief.lean.map((l) => [l.tag, l.value, l.format]), s.left], [[["room", "studio-room", "workout"]], []]);
    assert.ok(s.reasons.some((x) => x.field === "lean" && /^Lean on the studio room \(workout\) — studio-room earns this gym's leads cheaper \(60 over 2 pictures at SGD 10\.33, against gym-floor with 20 at SGD 25\.00\)\.$/.test(x.text)), JSON.stringify(s.reasons.map((x) => x.text)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("AR9 what becomes of each line (2026-11-11): every checked line of the review says whether the next batch acts on it — a lean, a test with its photos, the words' size — or that it waits on something (a room not tagged, no approved scene), or that the press is the owner's (Pause on Meta, or Ads Manager when the ad cannot be reached), or that there is nothing to do and why", () => {
  const sug = (over = {}) => ({ brief: { mix: { workout: 8, "studio-portrait": 2 }, lean: [], ...over.brief }, left: over.left || [] });
  const A = (x, s = sug(), o) => { const a = actionFor(x, s, o); return [a.state, a.text]; };
  // Nothing to do, and why.
  assert.deepEqual(A({ kind: "keep" }), ["none", "Nothing to do: leave it running."]);
  assert.deepEqual(A({ kind: "wait" }), ["none", "Nothing to do yet: it is judged once it has had a fair chance."]);
  assert.deepEqual(A({ kind: "fact", attribute: "ratio", best: { value: "4:5" } }), ["none", "Not acted on: nothing in the app changes this."]);
  // A pause is the owner's press: the button when Meta can reach the ad, Ads Manager when it cannot; never before its checks.
  assert.deepEqual(A({ kind: "pause", verdict: "confirmed", ads: ["120211112222"] }, sug(), { linked: true }), ["yours", "Yours to press: Pause on Meta, below. Nothing is paused by itself."]);
  assert.deepEqual(A({ kind: "pause", verdict: "confirmed", ads: ["120211112222"] }, sug(), { linked: false })[1], "Yours to do in Ads Manager: this ad cannot be reached from here.");
  assert.deepEqual(A({ kind: "pause", verdict: "confirmed", ads: ["export:ab12"] }, sug(), { linked: true })[1], "Yours to do in Ads Manager: this ad cannot be reached from here.");
  assert.deepEqual(A({ kind: "pause", verdict: "early", ads: ["120211112222"] }, sug(), { linked: true }), ["none", "Nothing to do yet: it has not passed its checks."]);
  // A confirmed finding the brief leans on; a lead it tests, with its photos.
  const lean = { tag: "backdrop", value: "dark-wall", format: "studio-portrait", why: "dark-wall earns leads cheaper" };
  const found = { kind: "matters", attribute: "backdrop", best: { value: "dark-wall" } };
  assert.deepEqual(A(found, sug({ brief: { lean: [lean] } })), ["acting", "In the next batch: about 60% of the studio portrait photos lean on it (dark-wall backdrop (studio-portrait))."]);
  const test3 = { tag: "setting", value: "group", format: "workout", test: true, photos: 3, why: "c11-bishan is one picture" };
  assert.deepEqual(A({ kind: "lead", attribute: "format", best: { value: "class-group" } }, sug({ brief: { lean: [test3] } })), ["acting", "In the next batch: 3 photos test it, in new versions (group setting (workout))."]);
  assert.match(A({ kind: "lead", attribute: "subject", best: { value: "group" } }, sug({ brief: { lean: [{ ...test3, photos: 1 }] } }))[1], /^In the next batch: 1 photo tests it, in new versions/);
  // A tiring winner is tied to the test made for it by its name.
  assert.deepEqual(A({ kind: "tiring", name: "c11-bishan" }, sug({ brief: { lean: [test3] } }))[0], "acting");
  assert.deepEqual(A({ kind: "tiring", name: "c99-other" }, sug({ brief: { lean: [test3] } })), ["none", "Not in the next batch: its kind maps to nothing a scene can be asked for that is not already leaned on or tested. Draft new versions of it on Draft Scenes."]);
  // It would be acted on, but something is missing first: said with what to do, the repeated reason left off.
  const noRoom = { format: "workout", tag: "room", value: "studio-room", kind: "no_room", why: "studio-room earns leads cheaper", text: "the studio room (workout): no premises photo is tagged as the studio room yet. Say which photo shows it on Photos & assets (one click). (studio-room earns leads cheaper)" };
  assert.deepEqual(A({ kind: "matters", attribute: "backdrop", best: { value: "studio-room" } }, sug({ left: [noRoom] })), ["waiting", "Not yet — the studio room (workout): no premises photo is tagged as the studio room yet. Say which photo shows it on Photos & assets (one click)."]);
  // The words on the picture: only their size, and only when the brief says so.
  const words = { kind: "matters", attribute: "text_density", best: { value: "heavy" } };
  assert.deepEqual(A(words, sug({ brief: { words_weight: "bolder" } })), ["acting", "In the next batch: the words are set larger where a photo allows. The words themselves stay yours."]);
  assert.equal(A(words)[0], "none");
  // A kind of photograph that is in the mix is acted on through the mix; one nothing can express is said.
  assert.deepEqual(A({ kind: "matters", attribute: "format", best: { value: "studio-portrait" } }), ["acting", "In the next batch through the mix: 8 workout, 2 studio portrait."]);
  assert.deepEqual(A({ kind: "matters", attribute: "colours", best: { value: "warm" } }), ["none", "Not acted on: nothing a scene or a photo can be asked for expresses this yet."]);
});

test("AR10 the ledger across every gym (2026-11-12): what each gym's own account says and what its batches tested are pooled per thing a scene can be asked for, with a verdict by rule — holds (held in two gyms' tests, failed none), mixed, held once, did not hold, being tested, said and never tested — and the gyms that have not touched what held; what held elsewhere becomes a TEST in a gym that has neither said nor tried it (never a lean), after its own; the pooled ledger is rebuilt only when a file it reads changes", () => {
  const part = (gym, said, tested) => ({ gym, name: gym.toUpperCase(), currency: "SGD", reviewed: null, said, tested });
  const say = (tag, value, format = "workout", kind = "lean") => ({ key: `${format}|${tag}|${value}`, format, tag, value, kind, why: "its own leads" });
  const tst = (tag, value, verdict, batch, leads = 20) => ({ key: `workout|${tag}|${value}`, batch, made: "2026-11-01", tag, value, format: null, test: true, verdict, pictures: 3, tested: { ads: 3, spend: leads * 15, leads, cost_per_lead: 15 }, rest: { ads: 7, spend: 700, leads: 28, cost_per_lead: 25 },
    text: verdict === "held" ? "it held: 20 leads at SGD 15.00 over 3 pictures, against SGD 25.00 for the rest of the batch (28 leads)" : verdict === "not_held" ? "it did not hold: 20 leads at SGD 15.00" : `too early: ${leads} leads so far from 3 pictures (it takes 10 to say)` });
  const L = ledgerFrom([
    part("a", [say("setting", "group")], [tst("setting", "group", "held", "b1")]),
    part("b", [], [tst("setting", "group", "held", "b2"), tst("mood", "smile", "not_held", "b2")]),
    part("c", [say("mood", "smile"), say("backdrop", "dark-wall", "studio-portrait")], [tst("mood", "smile", "held", "b3"), tst("equipment", "barbell", "early", "b3", 4), tst("exercise", "squat", "held", "b3")]),
    part("d", [say("backdrop", "dark-wall", "studio-portrait", "test")], [tst("age", "older", "not_held", "b4")]),
  ]);
  assert.deepEqual(L.entries.map((e) => [e.name, e.verdict]), [["group setting (workout)", "holds"], ["a smile mood (workout)", "mixed"], ["squat exercise (workout)", "held_once"], ["older age (workout)", "not_held"], ["barbell equipment (workout)", "testing"], ["dark-wall backdrop (studio-portrait)", "untested"]]);
  assert.deepEqual(L.counts, { holds: 1, mixed: 1, held_once: 1, not_held: 1, testing: 1, untested: 1 });
  assert.deepEqual(L.gyms.map((g) => [g.gym, g.said, g.tested]), [["a", 1, 1], ["b", 0, 2], ["c", 2, 3], ["d", 1, 1]]);
  const e = Object.fromEntries(L.entries.map((x) => [x.key, x]));
  assert.deepEqual([e["workout|setting|group"].label, e["workout|setting|group"].text, e["workout|setting|group"].counts, e["workout|setting|group"].try_in.map((g) => g.gym)], ["Holds across gyms", "Held when A and B tested it, and failed no test.", { said: 1, held: 2, not_held: 0, early: 0 }, ["c", "d"]]);
  assert.equal(e["workout|mood|smile"].text, "Held at C; did not hold at B."); assert.deepEqual(e["workout|mood|smile"].try_in, [], "what failed somewhere is not handed on");
  assert.match(e["workout|exercise|squat"].text, /^Held when C tested it \(b3\): it held: 20 leads at SGD 15\.00 over 3 pictures, against SGD 25\.00 for the rest of the batch \(28 leads\)\. One gym so far\.$/);
  assert.deepEqual(e["workout|exercise|squat"].try_in.map((g) => g.gym), ["a", "b", "d"]);
  assert.match(e["workout|age|older"].text, /^Did not hold when D tested it: /); assert.match(e["workout|equipment|barbell"].text, /^In a batch at C: too early: 4 leads so far/);
  assert.equal(e["studio-portrait|backdrop|dark-wall"].text, "C and D's own accounts say it; no batch has tested it yet.");
  assert.deepEqual(e["studio-portrait|backdrop|dark-wall"].said.map((s) => [s.gym, s.kind]), [["c", "lean"], ["d", "test"]]);
  // What held elsewhere is a test here — only for a gym that has neither said nor tried it, only for a kind in the batch, never over something it already wants.
  const t = ledgerTests(L.entries, "d");
  assert.deepEqual(t.map((x) => [x.format, x.tag, x.value, x.test, x.source]), [["workout", "setting", "group", true, "ledger"], ["workout", "exercise", "squat", true, "ledger"]]);
  assert.equal(t[0].why, "Held when A and B tested it (20 leads at SGD 15.00, against SGD 25.00 for the rest of that batch). Not tried in this gym yet: a test here, not a finding.");
  assert.deepEqual(ledgerTests(L.entries, "a").map((x) => x.tag), ["exercise"], "a gym that tested it itself is not told to test it again");
  assert.deepEqual(ledgerTests(L.entries, "d", { formats: ["studio-portrait"] }), []);
  assert.deepEqual(ledgerTests(L.entries, "d", { have: [{ format: "workout", tag: "setting", value: "solo" }] }).map((x) => x.tag), ["exercise"], "its own account already speaks on the setting");
  // In the suggested brief: the gym's own tests first, then what held elsewhere, as a test with its photos — and said as such.
  const { d, g } = gym({ scenes: [workout("w-1"), workout("w-2", { exercise: "lunge" }), workout("w-g1", { setting: "group", people: 3 }), workout("w-g2", { setting: "group", people: 4, exercise: "lunge" }), workout("w-g3", { setting: "group", people: 3, exercise: "deadlift" })], brief: { batch_id: "2026-11-01-six-week", offer: "6 Week Strength Challenge", locations: ["BISHAN"], audience: "LADIES WANTED", generated: 10 } });
  try {
    const S = suggestBrief(g, { rows: [], every: [], ledger: L.entries.filter((x) => x.key === "workout|setting|group"), currency: "SGD" });
    assert.deepEqual(S.brief.lean, [{ tag: "setting", value: "group", format: "workout", test: true, photos: 3, why: t[0].why }]);
    assert.deepEqual(S.reasons.filter((r) => r.field === "test").map((r) => [r.source, r.text.slice(0, 58)]), [["ledger", "Test group setting (workout) on 3 of the 10 workout photos"]]);
    assert.deepEqual(suggestBrief(g, { rows: [], every: [], currency: "SGD" }).brief.lean, undefined, "without the ledger nothing is tested");
    // From the files: a gym with nothing on file says and tested nothing; the pooled ledger is kept until a file it reads changes.
    const brandsDir = join(d, "brands");
    assert.deepEqual(gymLedger(g), { gym: "testgym", name: "Test Gym", currency: "SGD", reviewed: null, said: [], tested: [] });
    const A1 = ledgerAcross(brandsDir), A2 = ledgerAcross(brandsDir);
    assert.deepEqual([A1.entries, A1.gyms.map((x) => x.gym)], [[], ["testgym"]]); assert.equal(A1, A2, "nothing changed: not built again");
    writeFileSync(join(g, "account-history.json"), JSON.stringify({ pulled: "2026-11-12T00:00:00.000Z", campaigns: [], adsets: [], ads: [] }));
    assert.notEqual(ledgerAcross(brandsDir), A1, "a file it reads changed: built again");
    const r = buildReview(g, { brandsDir });
    assert.deepEqual([r.ledger.gyms, r.ledger.entries, r.ledger.counts.holds], [1, [], 0]); assert.ok(!/Tested across every gym/.test(reviewText(r)));
    assert.match(reviewText({ ...r, ledger: { entries: L.entries.map((x) => ({ ...x, try_in: x.try_in.map((y) => (y.gym === "d" ? { ...y, gym: r.gym } : y)) })) } }), /Tested across every gym:\n- group setting \(workout\) — holds across gyms\. Held when A and B tested it, and failed no test\. Not tried here yet\.\n- a smile mood \(workout\) — mixed\. Held at C; did not hold at B\.\n/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
