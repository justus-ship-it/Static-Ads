// library-survey.test.mjs — the Ad Library survey (SV1–SV3). No network: the scrape is a fixture and the vision model a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapes, surveyAds, readSurvey, readSurveyReads, unreadSurvey, surveyFrom, candidatesFor, buildSurvey, SURVEY_READS, LONG_RUN_DAYS, MIN_ADVERTISERS, SOLID_ADVERTISERS, MAKE, FITNESS } from "./library-survey.mjs";
import { FORMATS } from "./read-creatives.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const png = (w, h) => { const b = Buffer.from(PNG); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
/** A scrape on disk: each ad { id, page, days, img (the picture's hash, or null), text }. */
function scrape(dir, date, country, ads) {
  const d = join(dir, "raw", date); mkdirSync(join(d, "images"), { recursive: true });
  for (const a of ads) if (a.img) writeFileSync(join(d, "images", `${a.img}.png`), png(1080, 1350));
  writeFileSync(join(d, "ads-normalized.json"), JSON.stringify({ niche: "gym", country, scraped_at: `${date}T02:00:00Z`, terms: ["gym"], ads: ads.map((a) => ({ ad_id: a.id, page_name: a.page, start_date: "2026-01-01", days_active: a.days, variant_count: 1, primary_text: a.text ?? "Join our 6 week challenge", cta: "Sign up", landing_url: "https://example.com", image_files: a.img ? [`images/${a.img}.png`, "images/missing.png"] : [] })) }));
}
const KIND = { p: "studio-portrait", w: "workout", g: "class-group", b: "before-after", r: "review" };
/** The fake vision model: the kind is the first letter of the picture's file name. */
const ask = (calls) => async (file, question, schema) => { calls.push({ file, question, schema }); const k = file.split("/").pop()[0];
  return { format: KIND[k], subject: k === "g" ? "group" : "woman", people: k === "g" ? 4 : 1, backdrop: k === "p" ? "dark-wall" : "gym-floor", backdrop_colour: "grey", pose: k === "p" ? "easy-posed" : "mid-exercise", expression: "smile", eye_contact: k === "p", mood: "calm", text_density: "light", words: ["SECRET WORDS OF ANOTHER GYM"], logo: k === "r", colours: ["grey"], clothing_colour: "", notes: "n" }; };

test("SV1 the ads on file: every scrape read, an ad seen twice counted once (the later scrape, where it has run longer), and what is left out without a call — an advertiser that is not a fitness business, an ad with no picture on disk, this app's own gyms", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv1-"));
  try {
    assert.deepEqual(scrapes(dir), []); assert.deepEqual(surveyAds(dir), []);
    scrape(dir, "2026-10-01", "SG", [{ id: "1", page: "Iron Gym", days: 40, img: "w1" }, { id: "2", page: "Android Developers", days: 300, img: "w2", text: "Build apps faster" }, { id: "3", page: "Core Pilates", days: 10, img: null }]);
    scrape(dir, "2026-11-01", "SG", [{ id: "1", page: "Iron Gym", days: 71, img: "w1" }, { id: "4", page: "Sculpt Society", days: 200, img: "p1" }, { id: "5", page: "", days: 9, img: "w5" }]);
    scrape(dir, "2026-11-02", "TW", [{ id: "6", page: "健身工廠", days: 120, img: "g1", text: "六週計畫" }]);
    mkdirSync(join(dir, "raw", "notes")); // not a scrape
    assert.deepEqual(scrapes(dir).map((s) => [s.date, s.country, s.ads.length]), [["2026-10-01", "SG", 3], ["2026-11-01", "SG", 3], ["2026-11-02", "TW", 1]]);
    const ads = surveyAds(dir, { ours: ["Sculpt Society", "abc"] });
    assert.deepEqual(ads.map((a) => [a.ad_id, a.advertiser, a.country, a.scraped, a.days, a.sha, a.left_out]), [
      ["1", "Iron Gym", "SG", "2026-11-01", 71, "w1", null], ["2", "Android Developers", "SG", "2026-10-01", 300, "w2", "not_fitness"], ["3", "Core Pilates", "SG", "2026-10-01", 10, null, "no_picture"],
      ["4", "Sculpt Society", "SG", "2026-11-01", 200, "p1", "ours"], ["5", "", "SG", "2026-11-01", 9, "w5", "no_advertiser"], ["6", "健身工廠", "TW", "2026-11-02", 120, "g1", null]]);
    assert.ok(ads[0].file.endsWith("/raw/2026-11-01/images/w1.png") && existsSync(ads[0].file), "the first picture that is on disk");
    assert.deepEqual(surveyAds(dir, { country: "tw" }).map((a) => a.ad_id), ["6"]);
    assert.equal(surveyAds(dir).find((a) => a.ad_id === "4").left_out, null, "without the gyms' names nothing is known to be ours");
    assert.equal(unreadSurvey(dir, { ours: ["Sculpt Society"] }), 2);
    assert.ok(FITNESS.test("Anytime Fitness Bishan") && FITNESS.test("瑜伽教室") && !FITNESS.test("Android Developers build apps"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SV2 the reading: one vision call per picture not read yet, under the cap, with the schema this app reads its own creatives with; kept by the picture's hash, so a second run calls nothing and the same picture under two ads is read once; the words printed on another operator's ad are never kept; a failed reading is said and the rest goes on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv2-"));
  try {
    scrape(dir, "2026-11-01", "SG", [{ id: "1", page: "Iron Gym", days: 120, img: "w1" }, { id: "2", page: "Iron Gym", days: 30, img: "w1" }, { id: "3", page: "Core Pilates", days: 95, img: "p3" }, { id: "4", page: "Flow Yoga", days: 12, img: "g4" }, { id: "5", page: "Phone Shop", days: 500, img: "w9", text: "New phones" }]);
    const calls = [], log = [];
    let d = await readSurvey({ swipeDir: dir, ask: ask(calls), max: 2, log: (m) => log.push(m), now: () => "2026-11-12T00:00:00.000Z" });
    assert.deepEqual(d, { read: 2, cached: 0, calls: 2, left: 1, failed: [] });
    assert.deepEqual(calls.map((c) => c.file.split("/").pop()), ["w1.png", "p3.png"], "the picture shared by two ads is read once; the phone shop's is never sent");
    assert.match(calls[0].question, /^You are reading a finished advertisement image that another fitness business is running/); assert.ok(!/own ad account/.test(calls[0].question));
    assert.deepEqual(Object.keys(calls[0].schema.properties).slice(0, 4), ["format", "subject", "people", "backdrop"]);
    const onDisk = readFileSync(join(dir, SURVEY_READS), "utf-8"), store = JSON.parse(onDisk);
    assert.deepEqual(store.reads.w1, { ratio: "4:5", read_on: "2026-11-12T00:00:00.000Z", model: store.model, format: "workout", subject: "woman", people: 1, backdrop: "gym-floor", pose: "mid-exercise", expression: "smile", eye_contact: false, text_density: "light", logo: false });
    assert.ok(!/SECRET WORDS/.test(onDisk), "the words on another operator's ad are not kept");
    assert.equal(unreadSurvey(dir), 1);
    // The rest, with a reading that fails; then nothing left to read.
    const bad = async (f, q, s) => { if (f.endsWith("g4.png")) throw new Error("the model was busy"); return ask(calls)(f, q, s); };
    d = await readSurvey({ swipeDir: dir, ask: bad, max: 10 });
    assert.deepEqual([d.read, d.cached, d.calls, d.left, d.failed], [0, 2, 1, 0, ["Flow Yoga: the model was busy"]]);
    d = await readSurvey({ swipeDir: dir, ask: ask(calls), max: 10 });
    assert.deepEqual([d.read, d.cached, d.calls], [1, 2, 1]); assert.equal(calls.length, 3);
    d = await readSurvey({ swipeDir: dir, ask: ask(calls), max: 10 });
    assert.deepEqual([d.read, d.cached, d.calls], [0, 3, 0]); assert.equal(readSurveyReads(dir).reads.g4.subject, "group");
    // The country asked for is read first, and the newest pull before an older one: the cap is not spent on another country's older ads.
    scrape(dir, "2026-11-02", "US", [{ id: "u1", page: "Texas Gym", days: 50, img: "w21" }, { id: "u2", page: "Ohio Gym", days: 50, img: "w22" }]);
    scrape(dir, "2026-11-03", "SG", [{ id: "s1", page: "Bishan Gym", days: 50, img: "w31" }]); scrape(dir, "2026-11-04", "SG", [{ id: "s2", page: "Katong Gym", days: 50, img: "w41" }]);
    const order = []; await readSurvey({ swipeDir: dir, ask: ask(order), max: 3, country: "sg" });
    assert.deepEqual(order.map((c) => c.file.split("/").pop()), ["w41.png", "w31.png", "w21.png"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SV3 the survey, by rule: counted per advertiser (ten ads of one are one voice) — for each kind, the advertisers that run it and the ones that kept one running 90 days or more, the share against the survey's own, a confidence word from the number of advertisers; the longest-running advertisers; and for a gym, each kind with whether it has run it and how this app makes it — a kind this app never makes (before-and-after) is said so and is never a candidate", () => {
  const A = (n, advertiser, kind, days) => ({ ad_id: String(n), advertiser, country: "SG", scraped: "2026-11-01", days, sha: `${kind}${n}`, file: "x", left_out: null });
  const ads = [
    // studio portraits: 4 advertisers, 3 of them long-running — one of them with five ads
    A(1, "P1", "p", 200), A(2, "P1", "p", 10), A(3, "P1", "p", 20), A(4, "P1", "p", 30), A(5, "P1", "p", 40), A(6, "P2", "p", 95), A(7, "P3", "p", 400), A(8, "P4", "p", 5),
    // workout: 4 advertisers, 1 long-running
    A(9, "W1", "w", 12), A(10, "W2", "w", 30), A(11, "W3", "w", 91), A(12, "P4", "w", 60),
    // before-after: 3 advertisers, all long-running; a review: one advertiser only
    A(13, "B1", "b", 300), A(14, "B2", "b", 250), A(15, "B3", "b", 100), A(16, "R1", "r", 365),
    { ...A(17, "Phone Shop", "w", 900), left_out: "not_fitness" }, A(18, "U1", "g", 700), // U1's picture is not read yet
  ];
  const reads = Object.fromEntries(ads.filter((a) => a.ad_id !== "18").map((a) => [a.sha, { format: KIND[a.sha[0]], subject: "woman", people: 1, backdrop: a.sha[0] === "p" ? "dark-wall" : "gym-floor", pose: "easy-posed", expression: "smile", eye_contact: a.sha[0] === "p", text_density: "light", logo: false, ratio: "4:5" }]));
  const S = surveyFrom(ads, reads);
  assert.deepEqual([S.ads, S.kept, S.read, S.unread, S.advertisers, S.long_running, S.overall, S.left_out, S.long_run_days], [18, 17, 16, 1, 11, 8, 73, { not_fitness: 1 }, LONG_RUN_DAYS]);
  const fmt = S.tables.find((t) => t.key === "format");
  assert.deepEqual(fmt.values.map((v) => [v.value, v.ads, v.advertisers, v.long_running, v.share, v.confidence]), [["before-after", 3, 3, 3, 100, "enough"], ["studio-portrait", 8, 4, 3, 75, "enough"], ["workout", 4, 4, 1, 25, "enough"], ["review", 1, 1, 1, 100, "early"]], "said from three advertisers; under that it goes last, whatever its share");
  assert.deepEqual([fmt.values[1].index, fmt.values[1].median_days, fmt.values[2].index], [1.03, 35, 0.34]);
  assert.deepEqual(S.tables.find((t) => t.key === "eye_contact").values.map((v) => [v.value, v.advertisers, v.long_running]), [["yes", 4, 3], ["no", 8, 5]], "the larger share of survivors first");
  assert.deepEqual(S.tables.map((t) => t.key), ["format", "subject", "backdrop", "pose", "expression", "eye_contact", "text_density", "logo", "ratio"]);
  assert.deepEqual(S.long_runners.slice(0, 3).map((r) => [r.advertiser, r.days, r.format]), [["P3", 400, "studio-portrait"], ["R1", 365, "review"], ["B1", 300, "before-after"]]);
  assert.deepEqual([MIN_ADVERTISERS, SOLID_ADVERTISERS], [3, 8]);
  // For a gym that has only ever run workout ads.
  const C = candidatesFor(S, { ran: ["workout"] });
  assert.deepEqual(C.map((c) => [c.format, c.tried, c.makeable, c.candidate]), [["before-after", false, false, false], ["studio-portrait", false, true, true], ["workout", true, true, false]], "the early kind is not listed");
  assert.equal(C[0].text, "before-after: 3 advertisers run it, 3 of them for 90 days or more (100%, against 73% of all). Never run in this account, and never used here: before-and-after photos are a standing rule.");
  assert.equal(C[1].text, "studio-portrait: 4 advertisers run it, 3 of them for 90 days or more (75%, against 73% of all). Never run in this account: made here as a studio portrait scene.");
  assert.equal(C[2].text, "workout: 4 advertisers run it, 1 of them for 90 days or more (25%, against 73% of all). This gym has run it.");
  assert.deepEqual(Object.keys(MAKE).sort(), Object.keys(FORMATS).sort(), "every kind the reader can answer has a line on how it is made here, or why not");
  // Nothing read: no shares, no candidates — never a division by nought.
  const E = surveyFrom(ads, {}); assert.deepEqual([E.read, E.advertisers, E.overall, E.tables[0].values, candidatesFor(E, { ran: [] })], [0, 0, null, [], []]);
  // From the files: a gym's own country when it has been surveyed, else every country on file, and that is said.
  const dir = mkdtempSync(join(tmpdir(), "sv3-"));
  try {
    assert.deepEqual([buildSurvey(dir).ads, buildSurvey(dir).scrapes], [0, []]);
    scrape(dir, "2026-11-01", "US", [{ id: "1", page: "Iron Gym", days: 120, img: "w1" }]);
    const B = buildSurvey(dir, { country: "SG", ran: ["workout"] });
    assert.deepEqual([B.ads, B.scope, B.asked, B.countries, B.unread, B.candidates, B.scrapes.map((x) => [x.date, x.country, x.ads])], [1, null, "SG", ["US"], 1, [], [["2026-11-01", "US", 1]]]);
    assert.equal(buildSurvey(dir, { country: "US" }).scope, "US");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
