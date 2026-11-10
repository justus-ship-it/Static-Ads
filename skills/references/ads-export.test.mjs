/**
 * Tests for the data loop's first pieces (2026-11-09): an Ads Manager export brought into the history
 * (ads-export.mjs), the creatives read once by a (fake) vision model (read-creatives.mjs), and What wins
 * (what-wins.mjs) — offline, a throwaway gym folder, no Meta, no Gemini.
 *
 *   node --test skills/references/ads-export.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, parseExport, adNameParts, adsetNameFacts, similarity, matchCreatives, listCreatives, parseCopyText, rtfToText, importExport, MATCH_FLOOR } from "./ads-export.mjs";
import { readCreatives, readsFor, ratioOf, READS_FILE, FORMATS } from "./read-creatives.mjs";
import { attributeTables, suggestions, medianCpl, joinReads, confidence, whatWins, LEADS_EARLY, LEADS_SOLID, FREQ_TIRED } from "./what-wins.mjs";
import { readHistory, historyRows, pullAccountHistory, readCopyRefs } from "./meta-results.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PNG_4x5 = () => { const b = Buffer.from(PNG); b.writeUInt32BE(1080, 16); b.writeUInt32BE(1350, 20); return b; };
const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach,Ends,Bid,"Bid type","Last significant edit","Quality ranking","Engagement rate ranking","Conversion rate ranking","Ad set name","Results (initial)","Results (initial) indicator"`;
const row = (ad, results, spend, imp, reach, delivery = "active", q = "Average") => `2023-10-08,2026-11-08,"${ad}",${delivery},"7-day click or 1-day view",${results},actions:leadgen.other,${results ? (spend / results).toFixed(4) : 0},100,Daily,${spend},${imp},${reach},Ongoing,0,ABSOLUTE_OCPM,2026-10-15T19:04:37+0800,${q},"Above average","Above average","0413 Broad Audience | Both Genders | 25-50 | +3KM",,`;
const CSV = [HEADER,
  row("0413 Total Body Reset | Image 3: Pink Background Woman Kettlebell Squat", 7, 82.27, 5004, 2193),
  row("0413 Beginner's Body Reset | Image 5: Couple Smiling With Dumbbells", 86, 1248.58, 135032, 30412, "active", '"Below average – bottom 35% of ads"'),
  row("0413 Beginner's Body Reset | Video 2: Shami Intro 3", 2, 64.29, 4428, 2491),
  row("0413 Beginner's Body Reset | Video 4: Shami Intro 3 V2", 5, 52.82, 3678, 2325, "inactive"),
  row("0413 Beginner's Body Reset | Image 2: Lady Lunging Sideways Glance", 6, 141.26, 7956, 4010),
].join("\n") + "\n";

function gym() {
  const d = mkdtempSync(join(tmpdir(), "ads-export-")), g = join(d, "brands", "testgym");
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify(PROFILE_STARTER("testgym", "Test Gym", "SG")));
  return { d, g };
}

test("X1 the export: the CSV read (quoted fields, the currency from the header, the rankings), ad names into offer / media / description, the ad set's facts from its name, creatives matched by description with digits exact (a typo forgiven, 'Shami Intro 3' never 'Shami Intro 3 V2'), the copy file's copies and headlines, the rows written as origin export with export ids, the copies as copy references with the offer's results; a re-import replaces, an API pull keeps the export's rows", async () => {
  const { d, g } = gym();
  try {
    // The pieces.
    assert.deepEqual(parseCsv('a,"b, c","d ""q"" e"\n1,2,"3\n4"\n'), [["a", "b, c", 'd "q" e'], ["1", "2", "3\n4"]]);
    const ex = parseExport(CSV);
    assert.equal(ex.currency, "SGD"); assert.equal(ex.rows.length, 5);
    assert.deepEqual([ex.rows[1].leads, ex.rows[1].spend, ex.rows[1].quality_ranking, ex.rows[1].frequency, ex.rows[3].delivery], [86, 1248.58, "below average (bottom 35%)", 4.44, "inactive"]);
    assert.deepEqual(adNameParts("0413 Toned Tummy Challenge | Image 2: Red Lady Drinking Water Lean Wall"), { prefix: "0413", offer: "Toned Tummy Challenge", media: "image", n: 2, description: "Red Lady Drinking Water Lean Wall" });
    assert.deepEqual(adNameParts("0413 Beginner's Body Reset | Video: Intro 1 Shami").description, "Intro 1 Shami");
    assert.deepEqual(adsetNameFacts("0413 Broad Audience | Both Genders | 25-50 | +3KM"), { gender: "all", age_min: 25, age_max: 50, radius_km: 3, prefix: "0413" });
    assert.ok(similarity("Pink Background Woman Kettlebell Squat", "Pink Background Womawn Kettlebell Squat") >= MATCH_FLOOR, "a typo is forgiven");
    assert.equal(similarity("Shami Intro 3", "Video 2 - Shami Intro 3"), 1, "the folder's 'Video 2 -' lead is dropped before comparing");
    assert.equal(similarity("Shami Intro 3 V2", "Video 2 - Shami Intro 3"), 0, "a version mark is a different edit");
    assert.equal(similarity("Shami Intro 2", "Shami Intro 3"), 0, "digits must agree");
    assert.deepEqual(parseCopyText("Copy 1\n\nJurong West —\nline two\n\n✔ a\n✔ b\n\nCopy 2\n\nSecond.\n\nHeadlines (2 Total):\n🔥 First headline\nSecond headline\n"), { copies: ["Jurong West —\nline two\n\n✔ a\n✔ b", "Second."], headlines: ["First headline", "Second headline"] });
    assert.equal(rtfToText("{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0\\fs24 Copy 1\\par\\par Hello \\'e9 world\\u8212? dash\\par}"), "Copy 1\n\nHello é world— dash");
    // The folders: a typo'd folder, a video folder, a loose file.
    const cr = join(d, "creatives"); mkdirSync(join(cr, "Pink Background Womawn Kettlebell Squat"), { recursive: true }); mkdirSync(join(cr, "Video 2 - Shami Intro 3"));
    writeFileSync(join(cr, "Pink Background Womawn Kettlebell Squat", "TBR_3.png"), PNG_4x5()); writeFileSync(join(cr, "Video 2 - Shami Intro 3", "42TTC_Video_3.mp4"), Buffer.from("not really a video"));
    writeFileSync(join(cr, "Couple Smiling With Dumbbells.png"), PNG_4x5());
    const files = listCreatives(cr); assert.equal(files.length, 3);
    const matched = matchCreatives(parseExport(CSV).rows, files).map((m) => m && m.name);
    assert.deepEqual(matched, ["Pink Background Womawn Kettlebell Squat", "Couple Smiling With Dumbbells", "Video 2 - Shami Intro 3", null, null]);
    const cp = join(d, "copy"); mkdirSync(cp);
    writeFileSync(join(cp, "Beginner's Body Reset - Copy & Headlines.txt"), "Copy 1\n\nJurong West —\nIf you've been putting off…\n\nCopy 2\n\nBe honest.\n\nHeadlines (2 Total):\n6-Week Beginner's Body Reset\nExclusive 42 Day Reset\n");
    writeFileSync(join(cp, "Total Body Reset Copy & Headlines.txt"), "Copy 1\n\nThis is your reset.\n\nHeadlines (1 Total):\nThe 6 Week Total Body Reset\n");
    const csv = join(d, "Shamanee-Param-Ads.csv"); writeFileSync(csv, CSV);
    // The import.
    const done = importExport({ gymDir: g, csv, creatives: cr, copy: cp, label: "Shami's account", now: "2026-11-09T10:00:00.000Z" });
    assert.deepEqual([done.campaigns, done.adsets, done.ads, done.leads, done.spend, done.creatives, done.currency], [1, 1, 5, 106, 1589.22, 3, "SGD"]);
    assert.deepEqual(done.unmatched, ["0413 Beginner's Body Reset | Video 4: Shami Intro 3 V2", "0413 Beginner's Body Reset | Image 2: Lady Lunging Sideways Glance"]);
    assert.deepEqual(done.offers.map((o) => [o.offer, o.ads, o.leads, o.copies, o.headlines]), [["Total Body Reset", 1, 7, 1, 1], ["Beginner's Body Reset", 4, 99, 2, 2]]);
    const h = readHistory(g);
    assert.equal(h.pulled, null, "no API pull yet"); assert.equal(h.exports.length, 1); assert.equal(h.exports[0].label, "Shami's account");
    const couple = h.ads.find((a) => /Couple/.test(a.name));
    assert.ok(couple.id.startsWith("export:") && couple.adset_id.startsWith("export:") && couple.campaign_id.startsWith("export:"));
    assert.deepEqual([couple.origin, couple.media, couple.offer, couple.description, couple.creative_file, couple.status, couple.words, couple.all_time.leads, couple.all_time.cost_per_lead, couple.all_time.frequency, couple.export.quality_ranking, couple.body, couple.title, couple.copies],
      ["export", "image", "Beginner's Body Reset", "Couple Smiling With Dumbbells", "references/export-couple-smiling-with-dumbbells.png", "ACTIVE", "active", 86, 14.52, 4.44, "below average (bottom 35%)", "Jurong West —\nIf you've been putting off…", "6-Week Beginner's Body Reset", 2]);
    assert.ok(existsSync(join(g, couple.creative_file)) && existsSync(join(g, couple.creative_file + ".meta.json")));
    assert.equal(JSON.parse(readFileSync(join(g, couple.creative_file + ".meta.json"), "utf-8")).source, "ads-manager-export");
    const video = h.ads.find((a) => /Video 2: Shami Intro 3$/.test(a.name)), v2 = h.ads.find((a) => /V2/.test(a.name));
    assert.deepEqual([video.media, video.creative_file, v2.media, v2.creative_file, v2.status], ["video", "references/export-shami-intro-3.mp4", "video", null, "PAUSED"]);
    const set = h.adsets[0]; assert.deepEqual([set.gender, set.age_min, set.age_max, set.geo, set.daily_budget, set.origin], ["all", 25, 50, "+3km (from the ad set's name)", 100, "export"]);
    // The rows carry the export's facts; the thumbnail is the filed picture.
    const rows = historyRows(g), rc = rows.find((r) => /Couple/.test(r.ad_name));
    assert.deepEqual([rc.origin, rc.offer, rc.frequency, rc.quality_ranking, rc.thumbnail, rc.in_library, rc.importable, rc.leads, rc.cost_per_lead], ["export", "Beginner's Body Reset", 4.44, "below average (bottom 35%)", "/files/brands/testgym/references/export-couple-smiling-with-dumbbells.png", true, false, 86, 14.52]);
    // The copies: one reference per copy of the offer, the offer's results on each.
    const refs = readCopyRefs(g).refs;
    assert.deepEqual(refs.map((r) => [r.id, r.offer, r.results.leads, r.results.shared_across, r.headline]), [["export-total-body-reset-c1", "Total Body Reset", 7, 1, "The 6 Week Total Body Reset"], ["export-beginners-body-reset-c1", "Beginner's Body Reset", 99, 4, "6-Week Beginner's Body Reset"], ["export-beginners-body-reset-c2", "Beginner's Body Reset", 99, 4, "Exclusive 42 Day Reset"]]);
    // A re-import replaces the rows, never doubles them; a note on a copy reference survives.
    refs[0].note = "the owner's note"; writeFileSync(join(g, "copy-references.json"), JSON.stringify({ schema: 1, refs }));
    importExport({ gymDir: g, csv, creatives: cr, copy: cp });
    assert.equal(readHistory(g).ads.length, 5); assert.equal(readHistory(g).exports.length, 1); assert.equal(readCopyRefs(g).refs.length, 3); assert.equal(readCopyRefs(g).refs[0].note, "the owner's note");
    // An API pull keeps the export's rows and record.
    const client = { list: async (path) => (/\/ads$/.test(path) ? [{ id: "9", name: "API ad", adset_id: "s", campaign_id: "c", status: "PAUSED", effective_status: "PAUSED", created_time: "2026-01-01T00:00:00+0800", creative: { id: "cr", image_hash: "h" } }] : /\/adsets$/.test(path) ? [{ id: "s", name: "API set", campaign_id: "c", status: "PAUSED", effective_status: "PAUSED" }] : /\/campaigns$/.test(path) ? [{ id: "c", name: "API campaign", status: "PAUSED", effective_status: "PAUSED" }] : []) };
    await pullAccountHistory({ client, accountId: "act_1", gymDir: g });
    const after = readHistory(g);
    assert.deepEqual([after.account, after.ads.length, after.ads.filter((a) => a.origin === "export").length, after.exports.length, after.campaigns.length], ["act_1", 6, 5, 1, 2]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("X2 the creatives read once: a fake vision model answers for each picture in the history (an export's image, the API import's meta-{id} picture), the reading is kept by content hash so a second run makes no call and two ads sharing a picture share a reading, a video without a poster is skipped and said, the cap stops the run, and readsFor ties readings back to ad ids; the ratio is read from the file", async () => {
  const { d, g } = gym();
  try {
    const csv = join(d, "x.csv"); writeFileSync(csv, CSV);
    const cr = join(d, "creatives"); mkdirSync(cr); writeFileSync(join(cr, "Couple Smiling With Dumbbells.png"), PNG_4x5()); writeFileSync(join(cr, "Pink Background Woman Kettlebell Squat.png"), PNG);
    importExport({ gymDir: g, csv, creatives: cr });
    // An API-era ad with its imported picture (the same bytes as the couple's: one reading for both).
    const h = readHistory(g); h.ads.push({ id: "777", name: "API ad", adset_id: "s", campaign_id: "c", media: "image", all_time: { leads: 3, spend: 30 } }); writeFileSync(join(g, "account-history.json"), JSON.stringify(h));
    writeFileSync(join(g, "references", "meta-777.png"), PNG_4x5());
    assert.deepEqual([ratioOf([1080, 1350]), ratioOf([1080, 1080]), ratioOf([1080, 1920]), ratioOf([1920, 1080]), ratioOf([1000, 731])], ["4:5", "1:1", "9:16", "16:9", "other"]);
    const calls = [];
    const ask = async (file, question, schema) => { calls.push(file.split("/").pop()); assert.match(question, /studio-portrait/); assert.equal(schema.type, "OBJECT"); return { format: /couple/.test(file) ? "studio-portrait" : "workout", subject: /couple/.test(file) ? "couple" : "woman", people: /couple/.test(file) ? 2 : 1, backdrop: "dark-wall", backdrop_colour: "charcoal", pose: "easy-posed", expression: "smile", eye_contact: true, mood: "warm easy", text_density: "light", words: ["JURONG WEST", "42 DAY"], logo: false, colours: ["black", "pink"], clothing_colour: "pink", notes: "" }; };
    let done = await readCreatives({ gymDir: g, ask, max: 10, now: () => "2026-11-09T10:00:00.000Z" });
    assert.deepEqual([done.read, done.cached, done.calls, done.ads], [2, 0, 2, 3], "two distinct pictures over three ads with a picture (the couple's picture serves the export ad and the API ad; the video and the two unmatched ads have none)");
    assert.deepEqual(calls.sort(), ["export-couple-smiling-with-dumbbells.png", "export-pink-background-woman-kettlebell-squat.png"]);
    assert.ok(done.skipped.some((s) => /Shami Intro 3: a video with no poster frame/.test(s)) && done.skipped.some((s) => /Lady Lunging.*no picture on this machine/.test(s)));
    const store = JSON.parse(readFileSync(join(g, READS_FILE), "utf-8"));
    assert.equal(Object.keys(store.reads).length, 2);
    const couple = Object.values(store.reads).find((r) => r.format === "studio-portrait");
    assert.deepEqual([couple.ratio, couple.size, couple.ad_ids.length, couple.words, couple.logo, couple.read_on], ["4:5", [1080, 1350], 2, ["JURONG WEST", "42 DAY"], false, "2026-11-09T10:00:00.000Z"]);
    done = await readCreatives({ gymDir: g, ask: async () => { throw new Error("no call expected"); }, max: 10 });
    assert.deepEqual([done.read, done.cached, done.calls], [0, 2, 0], "a second run reads nothing again");
    const { byAd } = readsFor(g);
    assert.deepEqual([byAd.get("777")?.format, byAd.get(h.ads.find((a) => /Couple/.test(a.name)).id)?.format, byAd.get(h.ads.find((a) => /Kettlebell/.test(a.name)).id)?.ratio, byAd.has(h.ads.find((a) => /Lunging/.test(a.name)).id)], ["studio-portrait", "studio-portrait", "1:1", false]);
    // The cap: a new picture with the cap spent is skipped and said.
    writeFileSync(join(g, "references", "meta-778.png"), Buffer.concat([PNG, Buffer.from([1])]));
    h.ads.push({ id: "778", name: "Another API ad", media: "image", all_time: { leads: 1, spend: 10 } }); writeFileSync(join(g, "account-history.json"), JSON.stringify(h));
    done = await readCreatives({ gymDir: g, ask: async () => { throw new Error("no call expected"); }, max: 0 });
    assert.ok(done.skipped.some((s) => /Another API ad: the cap of 0 calls/.test(s)));
    assert.ok(Object.keys(FORMATS).includes("testimonial") && Object.keys(FORMATS).includes("review"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("X3 what wins, by rule: the median over ads with enough leads, each attribute's values with leads, cost per lead, share, the ratio to the median and a confidence word (early / enough / solid), unread ads counted apart; the suggestions — keep, tiring, consider pausing, what matters most, never tried, not read yet, too thin — and the active scope with its fallback", async () => {
  const R = (over) => ({ source: "account", ad_id: "x", ad_name: "x", status: "active", media: "image", offer: "Offer A", spend: 0, impressions: 0, leads: 0, cost_per_lead: null, frequency: 1, ...over });
  const read = (over) => ({ format: "workout", subject: "woman", backdrop: "gym-floor", pose: "mid-exercise", expression: "effort", eye_contact: false, text_density: "light", logo: true, ratio: "1:1", ...over });
  const rows = [
    R({ ad_id: "a", ad_name: "Couple", spend: 1161, leads: 86, cost_per_lead: 13.5, frequency: 4.4, read: read({ format: "studio-portrait", subject: "couple", backdrop: "dark-wall", pose: "holding-equipment", expression: "smile", logo: false, ratio: "4:5" }) }),
    R({ ad_id: "b", ad_name: "Red Lady", spend: 560, leads: 33, cost_per_lead: 16.97, frequency: 3.2, read: read({ format: "studio-portrait", backdrop: "dark-wall", pose: "easy-posed", expression: "neutral", logo: false, ratio: "4:5" }) }),
    R({ ad_id: "c", ad_name: "High Pull", spend: 215, leads: 10, cost_per_lead: 21.5, read: read({}) }),
    R({ ad_id: "d", ad_name: "Runner", spend: 59, leads: 2, cost_per_lead: 29.6, read: read({ backdrop: "outdoors" }) }),
    R({ ad_id: "e", ad_name: "Circle", spend: 68, leads: 3, cost_per_lead: 22.7, read: read({ format: "class-group", subject: "group" }) }),
    R({ ad_id: "f", ad_name: "Old video", status: "paused", media: "video", offer: "Offer B", spend: 1466, leads: 92, cost_per_lead: 15.93 }),
    R({ ad_id: "g", ad_name: "Dear one", spend: 400, leads: 8, cost_per_lead: 50, read: read({ subject: "man" }) }),
    R({ ad_id: "h", ad_name: "Nothing", spend: 70, leads: 0 }),
  ];
  assert.deepEqual([confidence(0), confidence(1), confidence(LEADS_EARLY), confidence(LEADS_SOLID)], ["none", "early", "enough", "solid"]);
  assert.equal(medianCpl(rows), 16.97, "over the ads with 5+ leads: 13.5, 15.93, 16.97, 21.5, 50 → the middle one");
  const tables = attributeTables(rows);
  const fmt = tables.find((t) => t.key === "format");
  assert.deepEqual(fmt.values.map((v) => [v.value, v.ads, v.leads, v.cost_per_lead, v.confidence]), [["studio-portrait", 2, 119, 14.46, "solid"], ["class-group", 1, 3, 22.67, "early"], ["workout", 3, 20, 33.7, "solid"]]);
  assert.deepEqual([fmt.unread, fmt.unread_leads, fmt.values[0].share, fmt.values[0].vs_median], [2, 92, 50.85, 0.85]);
  const media = tables.find((t) => t.key === "media");
  assert.deepEqual(media.values.map((v) => [v.value, v.leads]), [["video", 92], ["image", 142]], "media comes from the row, so unread ads count here");
  assert.deepEqual(tables.find((t) => t.key === "logo").values.map((v) => [v.value, v.leads]), [["no", 119], ["yes", 23]]);
  const sug = suggestions(rows, tables, { currency: "SGD" }), kinds = sug.map((s) => s.kind);
  assert.deepEqual(kinds.filter((k) => k === "keep").length, 1, "Couple leads at 85% of the median or less with 10+ leads; Red Lady sits at the median; the paused video is not running");
  assert.match(sug.find((s) => s.kind === "keep").text, /Couple — 86 leads at SGD 13.50 against a median of SGD 16.97 \(studio-portrait, couple, dark-wall\)/);
  assert.deepEqual(sug.filter((s) => s.kind === "tiring").map((s) => s.ads[0]), ["a", "b"], `seen ${FREQ_TIRED}+ times per person`);
  assert.match(sug.find((s) => s.kind === "tiring").text, /4.4 times per person and still leads cheaply. Make new versions of the same kind \(studio-portrait, couple, dark-wall\) before it fades\./);
  assert.deepEqual(sug.filter((s) => s.kind === "pause").map((s) => s.ads[0]), ["g", "h"], "a dear lead with enough leads, and spend for nothing");
  const matters = sug.filter((s) => s.kind === "matters");
  assert.ok(matters.length >= 1 && matters.length <= 3);
  assert.match(matters[0].text, /matters: .* leads at SGD .* against .* Make more of the first\./);
  assert.match(sug.find((s) => s.kind === "test").text, /Never tried in this account: premises, lifestyle, person-talking, testimonial, review, offer-card/);
  assert.match(sug.find((s) => s.kind === "unread").text, /1 ad with leads has no picture read yet \(92 leads\)/);
  assert.ok(!kinds.includes("thin"));
  assert.equal(suggestions(rows.slice(2, 5), attributeTables(rows.slice(2, 5)))[0].kind, "thin", "under 20 leads nothing is concluded");
  // The whole thing on a gym folder: the scope falls back to every ad when none is active.
  const { d, g } = gym();
  try {
    writeFileSync(join(g, "account-history.json"), JSON.stringify({ pulled: null, account: null, campaigns: [{ id: "c", name: "C" }], adsets: [{ id: "s", campaign_id: "c", name: "S" }], ads: [{ id: "1", name: "Paused ad", adset_id: "s", campaign_id: "c", status: "PAUSED", effective_status: "PAUSED", words: "paused", media: "image", all_time: { spend: 100, leads: 6, cost_per_lead: 16.67, impressions: 1000 }, last_30d: {} }] }));
    const w = whatWins(g, { currency: "SGD" });
    assert.deepEqual([w.scope, w.active, w.every, w.ads, w.median, w.leads, w.read, w.suggestions[0].kind], ["all", 0, 1, 1, 16.67, 6, 0, "thin"]);
    assert.equal(whatWins(g, { scope: "all" }).scope, "all");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
