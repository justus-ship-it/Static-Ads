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
import { readCreatives, readsFor, ratioOf, READS_FILE, FORMATS, pictures, unreadCount } from "./read-creatives.mjs";
import { attributeTables, suggestions, medianCpl, joinReads, confidence, whatWins, campaignList, LEADS_EARLY, LEADS_SOLID, FREQ_TIRED, inScope, inTrack, trackSums, RECENT_DAYS, leftOutWhy, poolTables, acrossSuggestions, nextWave, whatWinsAcross, refreshAll, readAll } from "./what-wins.mjs";
import { readHistory, historyRows, pullAccountHistory, readCopyRefs, fetchPictures, PICTURES_DIR } from "./meta-results.mjs";
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

test("X3 what wins, by rule: the median over ads with enough leads, each attribute's values with leads, cost per lead, share, the ratio to the median and a confidence word (early / enough / solid), unread ads counted apart; the suggestions — keep, tiring, consider pausing, what matters most, never tried, not read yet, too thin — and the active scope with its fallback; one campaign's ads alone (the filter): the campaigns listed with their ads, running ads, leads and cost per lead, the running first; a chosen campaign's median, counts and tables are its own, its scope falls back by itself, and an id the gym does not have is ignored", async () => {
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
    assert.deepEqual([w.scope, w.track, w.tracks.stills.leads, w.tracks.video.ads, w.active, w.every, w.ads, w.median, w.leads, w.read, w.suggestions[0].kind, w.tables.some((t) => t.key === "media")], ["all", "stills", 6, 0, 0, 1, 1, 16.67, 6, 0, "thin", false]);
    assert.deepEqual([whatWins(g, { track: "video" }).ads, whatWins(g, { track: "all" }).tables.some((t) => t.key === "media")], [0, true]);
    assert.equal(whatWins(g, { scope: "all" }).scope, "all");
    // One campaign's ads alone (2026-11-11). Two campaigns: an old one, paused, and the one running now.
    const ad = (id, campaign_id, campaign, words, media, spend, leads) => ({ id, name: `Ad ${id}`, adset_id: `s-${campaign_id}`, campaign_id, campaign, status: words === "live" ? "ACTIVE" : "PAUSED", effective_status: words === "live" ? "ACTIVE" : "PAUSED", words, media, created: "2020-01-01", all_time: { spend, leads, cost_per_lead: leads ? Math.round((spend / leads) * 100) / 100 : null, impressions: 1000 }, last_30d: {} });
    writeFileSync(join(g, "account-history.json"), JSON.stringify({ pulled: null, account: null, campaigns: [{ id: "old", name: "Old offer" }, { id: "now", name: "Running offer" }], adsets: [{ id: "s-old", campaign_id: "old", name: "S" }, { id: "s-now", campaign_id: "now", name: "S" }],
      ads: [ad("1", "old", "Old offer", "paused", "image", 600, 10), ad("2", "old", "Old offer", "paused", "image", 800, 10), ad("3", "old", "Old offer", "paused", "video", 100, 4), ad("4", "now", "Running offer", "live", "image", 90, 9), ad("5", "now", "Running offer", "live", "image", 200, 10), ad("6", "now", "Running offer", "paused", "image", 50, 0)] }));
    const every = whatWins(g, { currency: "SGD" });
    assert.deepEqual(every.campaigns.map((c) => [c.id, c.name, c.origin, c.ads, c.running, c.leads, c.spend, c.cost_per_lead]), [["now", "Running offer", "account", 3, 2, 19, 340, 17.89], ["old", "Old offer", "account", 3, 0, 24, 1500, 62.5]], "the running campaign first, though the old one has more leads");
    assert.deepEqual([every.campaign, every.scope, every.ads, every.median, every.active, every.every], [null, "active", 2, 15, 2, 6]);
    const now = whatWins(g, { currency: "SGD", campaign: "now" }), old = whatWins(g, { currency: "SGD", campaign: "old" });
    assert.deepEqual([now.campaign, now.scope, now.ads, now.leads, now.median, now.active, now.recent, now.every], [{ id: "now", name: "Running offer" }, "active", 2, 19, 15, 2, 2, 3]);
    assert.deepEqual([old.campaign.name, old.scope, old.ads, old.leads, old.median, old.active, old.every, old.tracks.video.leads], ["Old offer", "all", 2, 20, 70, 0, 3, 4], "none of its ads is running, so its scope falls back to all of them; the median is its own (60 and 80), not the account's");
    assert.deepEqual([whatWins(g, { campaign: "old", track: "video" }).ads, whatWins(g, { campaign: "old", scope: "all", track: "all" }).ads, whatWins(g, { campaign: "now", scope: "all" }).ads], [1, 3, 3]);
    const unknown = whatWins(g, { currency: "SGD", campaign: "nope" });
    assert.deepEqual([unknown.campaign, unknown.ads, unknown.campaigns.length], [null, 2, 2], "an id the gym does not have is ignored");
    assert.deepEqual(campaignList([{ campaign_id: null, leads: 5 }, { campaign_id: "a", campaign: "A", source: "app", status: "paused", leads: 2, spend: 30 }, { campaign_id: "b", batch: "b-1", source: "account", origin: "export", status: "active", leads: 1, spend: 9.5 }]).map((c) => [c.id, c.name, c.origin, c.running, c.cost_per_lead]), [["b", "b-1", "export", 1, 9.5], ["a", "A", "app", 0, 15]], "a row without a campaign is in none");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("X4 across every gym: costs are never pooled raw — each value's spend is measured in its own gym's median leads, so SGD and TWD accounts pool; a value wins when it is solid, two gyms can judge it and it is cheaper in more than dearer; loses the other way; one gym alone is said as a test for the others; a gym without a median draws on the rest; each gym's next batch leans on its own account first, then on what holds elsewhere; the recent scope keeps the running ads and the last 12 months", async () => {
  const R = (gym, id, read, spend, leads, over = {}) => ({ source: "account", gym, ad_id: id, ad_name: id, status: "paused", media: "image", spend, leads, cost_per_lead: leads ? Math.round((spend / leads) * 100) / 100 : null, read, ...over });
  const G = (gym, currency, base, rows) => ({ gym, name: gym.toUpperCase(), currency, base, median: base, leads: rows.reduce((t, r) => t + r.leads, 0), rows, every: rows.length, ads: rows.length, unread: 0, pictures: rows.length, account: "act_1" });
  const gyms = [
    G("a", "SGD", 20, [R("a", "a1", { format: "studio-portrait", backdrop: "dark-wall" }, 300, 30), R("a", "a2", { format: "workout", backdrop: "gym-floor" }, 750, 25)]),
    G("b", "TWD", 400, [R("b", "b1", { format: "studio-portrait" }, 6000, 24), R("b", "b2", { format: "workout" }, 12000, 20)]),
    G("c", "SGD", 15, [R("c", "c1", { format: "workout" }, 300, 20), R("c", "c2", { format: "testimonial" }, 120, 20)]),
    G("d", "SGD", null, [R("d", "d1", { format: "workout" }, 90, 2)]),
  ];
  const tables = poolTables(gyms), fmt = tables.find((t) => t.key === "format");
  assert.ok(!tables.some((t) => t.key === "offer"), "an offer's name does not travel between gyms");
  assert.deepEqual(fmt.values.map((v) => [v.value, v.leads, v.index, v.tried_in, v.judged_in, v.cheaper_in, v.dearer_in, v.confidence]), [["testimonial", 20, 0.4, 1, 1, 1, 0, "solid"], ["studio-portrait", 54, 0.56, 2, 2, 2, 0, "solid"], ["workout", 65, 1.35, 3, 3, 0, 2, "solid"]], "300/20 + 6000/400 = 30 average-leads of spend for 54 leads; the gym without an average of its own is left out");
  assert.deepEqual(fmt.values[1].spend_by_currency, { SGD: 300, TWD: 6000 }); assert.deepEqual(fmt.values[1].gyms.map((x) => [x.gym, x.cost_per_lead, x.rel]), [["a", 10, 0.5], ["b", 250, 0.63]]);
  const sug = acrossSuggestions(gyms, tables);
  assert.deepEqual(sug.map((x) => [x.kind, x.value || x.gym]), [["wins", "studio-portrait"], ["one-gym", "testimonial"], ["one-gym", "dark-wall"], ["loses", "workout"], ["thin", "d"]], "the dark wall is read in one gym only, so it is a test for the others, not a finding");
  assert.match(sug[0].text, /Format: studio-portrait leads 44% under each gym's own average — 54 leads, cheaper in 2 of the 2 gyms with enough of it \(A, B\)\./);
  assert.match(sug[1].text, /testimonial leads 60% under the average at C \(20 leads\) and no other gym has enough of it to judge\. Worth a test elsewhere\./);
  assert.match(sug[3].text, /workout leads 35% over each gym's own average — 65 leads, dearer in 2 of 3 gyms\./);
  const across = { tables, _gyms: gyms };
  assert.deepEqual(nextWave("a", across).map((n) => [n.attribute, n.value, n.source]), [["format", "studio-portrait", "own"], ["backdrop", "dark-wall", "own"]], "its own account says so: two solid values a quarter apart or more");
  assert.match(nextWave("a", across)[0].text, /this gym's own leads \(30 at SGD 10\.00 against workout's 25 at SGD 30\.00\)/);
  const d = nextWave("d", across);
  assert.deepEqual(d.map((n) => [n.attribute, n.value, n.source, n.tried_here]), [["format", "studio-portrait", "portfolio", false]], "too thin itself: what holds across the others");
  assert.match(d[0].text, /across 2 gyms it leads 44% under each gym's own average \(54 leads; A, B\)\. Not run here yet\./);
  assert.deepEqual(nextWave("c", across).map((n) => [n.value, n.source]), [["testimonial", "own"]]);
  assert.deepEqual(nextWave("nowhere", across), []);
  // The scopes: Meta's word for a running ad is "live", an export's is "active"; "inactive" is neither.
  const rows = [{ id: 1, status: "active" }, { id: 2, status: "paused", published: "2026-07-01" }, { id: 3, status: "paused", published: "2026-01-01" }, { id: 4, status: "paused" }, { id: 5, status: "live", published: "2023-01-01" }, { id: 6, status: "inactive" }], now = new Date("2026-11-10T00:00:00Z");
  assert.deepEqual([inScope(rows, "active", { now }).map((r) => r.id), inScope(rows, "recent", { now }).map((r) => r.id), inScope(rows, "all", { now }).length], [[1, 5], [1, 2, 5], 6]);
  // Two tracks: the agent makes stills, so stills learn from stills; video is read on its own. Six months is the recent window.
  const tr = [{ media: "video", spend: 100, leads: 10 }, { media: "image", spend: 50, leads: 2 }, { spend: 30, leads: 1 }, { media: "other", spend: 0, leads: 0 }];
  assert.deepEqual([inTrack(tr, "video").length, inTrack(tr, "stills").length, inTrack(tr, "all").length, trackSums(tr), RECENT_DAYS], [1, 3, 4, { stills: { ads: 3, leads: 3, spend: 80, cost_per_lead: 26.67 }, video: { ads: 1, leads: 10, spend: 100, cost_per_lead: 10 } }, 183]);
  assert.ok(!poolTables(gyms).some((t) => t.key === "media") && poolTables(gyms, { withMedia: true }).some((t) => t.key === "media"), "media is an attribute only when both tracks are read together");
  // What is left out, and why.
  assert.deepEqual([leftOutWhy({ abroad: true }), leftOutWhy({ objective: "OUTCOME_AWARENESS" }), leftOutWhy({ objective: "OUTCOME_TRAFFIC" }), leftOutWhy({ objective: "OUTCOME_LEADS", ad_name: "0305 HR | Video: Tired of Job" }), leftOutWhy({ campaign: "招募教練" }), leftOutWhy({ objective: "OUTCOME_SALES", ad_name: "New Sales ad" }), leftOutWhy({ objective: "OUTCOME_LEADS", ad_name: "Shred challenge" }), leftOutWhy({ ad_name: "CHROME finish" })], ["abroad", "objective", "objective", "recruitment", "recruitment", null, null, null]);
});

test("X5 every account, refreshed and read: the delivered ads' pictures fetched once per image hash (a video's poster too; never the app's own ads, an ad set reaching abroad, an ad that spent nothing, an export's rows), the app's published ads read through one finished picture per photo of a batch, the unread count, a refresh of every gym that goes on past a gym without an account or a failing pull, one reading cap for the whole portfolio, and the portfolio view over real gym folders", async () => {
  const d = mkdtempSync(join(tmpdir(), "portfolio-")), brands = join(d, "brands");
  const mk = (gym, account) => { const g = join(brands, gym); mkdirSync(g, { recursive: true }); const p = PROFILE_STARTER(gym, gym.toUpperCase(), "SG"); p.meta_assets.ad_account_id = account || ""; writeFileSync(join(g, "gym-profile.json"), JSON.stringify(p)); return g; };
  const png = (n) => Buffer.concat([PNG, Buffer.from([n])]);
  try {
    const g = mk("one", "act_1"); mk("two", ""); const three = mk("three", "act_3");
    const ad = (id, over = {}) => ({ id, name: `ad ${id}`, adset_id: "s1", campaign_id: "c1", campaign: "C", adset: "S", status: "ACTIVE", effective_status: "ACTIVE", words: "active", created: "2026-09-01", media: "image", hashes: [], poster: null, all_time: { spend: 100, leads: 10, cost_per_lead: 10, impressions: 1000, reach: 500 }, last_30d: {}, ...over });
    const history = { pulled: "2026-11-01T00:00:00Z", account: "act_1", campaigns: [{ id: "c1", name: "C", words: "active" }], adsets: [{ id: "s1", campaign_id: "c1", name: "S", words: "active" }, { id: "s2", campaign_id: "c1", name: "Abroad", abroad: true, countries: ["BD"] }],
      ads: [ad("1", { hashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }), ad("2", { hashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }), ad("3", { media: "video", poster: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), ad("4", { hashes: ["cccccccccccccccccccccccccccccccc"], adset_id: "s2" }), ad("5", { hashes: ["dddddddddddddddddddddddddddddddd"], all_time: { spend: 0, leads: 0 } }), ad("900", { hashes: ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"] }), ad("export:x", { origin: "export", hashes: [] })] };
    writeFileSync(join(g, "account-history.json"), JSON.stringify(history));
    // The app's own batch: two ads of one photo (two locations), one of another; ad 900 is the app's.
    const out = join(g, "outputs", "b1"); for (const f of ["101-c01-a", "102-c01-b", "103-c02-a"]) mkdirSync(join(out, f, "1x1"), { recursive: true });
    writeFileSync(join(out, "101-c01-a", "1x1", "x.png"), png(7)); writeFileSync(join(out, "102-c01-b", "1x1", "x.png"), png(8)); writeFileSync(join(out, "103-c02-a", "1x1", "x.png"), png(9));
    writeFileSync(join(out, "batch.json"), JSON.stringify({ ads: [{ folder: "101-c01-a", file: "101-c01-a/1x1/x.png", photos: ["g01"] }, { folder: "102-c01-b", file: "102-c01-b/1x1/x.png", photos: ["g01"] }, { folder: "103-c02-a", file: "103-c02-a/1x1/x.png", photos: ["g02"] }] }));
    writeFileSync(join(out, "publish.json"), JSON.stringify({ campaign: { id: "c9" }, adsets: {}, ads: { "101-c01-a": { id: "900" }, "102-c01-b": { id: "901" }, "103-c02-a": { id: "902" } }, superseded: [] }));
    const asked = [];
    const client = { get: async (path, q) => { asked.push([path, JSON.parse(q.hashes)]); return { data: JSON.parse(q.hashes).map((h) => ({ hash: h, url: `http://127.0.0.1:1/${h}.png` })) }; } };
    const fetchImpl = async (url) => ({ ok: !/bbbb/.test(url) || true, arrayBuffer: async () => png(/aaaa/.test(url) ? 1 : 2) });
    let p = await fetchPictures({ client, accountId: "act_1", gymDir: g, fetchImpl });
    assert.deepEqual([p.wanted, p.fetched, p.kept, p.skipped], [2, 2, 0, []]);
    assert.deepEqual(asked, [["act_1/adimages", ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]]], "one call for the two hashes: the shared image once, the video's poster; not the abroad ad set's, the unspent ad's, the app's own or the export's");
    assert.ok(existsSync(join(g, PICTURES_DIR, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png")) && existsSync(join(g, PICTURES_DIR, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png")));
    p = await fetchPictures({ client: { get: async () => { throw new Error("no call expected"); } }, accountId: "act_1", gymDir: g, fetchImpl });
    assert.deepEqual([p.fetched, p.kept], [0, 2], "nothing fetched twice");
    // One list of every ad's picture.
    const list = pictures(g), file = (id) => list.find((x) => x.ad_id === id)?.file?.replace(g + "/", "") ?? null;
    assert.deepEqual([file("1"), file("2"), file("3"), file("4"), file("900"), file("901"), file("902"), list.filter((x) => x.ad_id === "900").length],
      [`${PICTURES_DIR}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png`, `${PICTURES_DIR}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png`, `${PICTURES_DIR}/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png`, null, "outputs/b1/101-c01-a/1x1/x.png", "outputs/b1/101-c01-a/1x1/x.png", "outputs/b1/103-c02-a/1x1/x.png", 1], "the app's ad is listed once, from outputs; two locations of one photo share its first finished picture");
    assert.deepEqual(unreadCount(g), { pictures: 4, unread: 4 });
    // Every account refreshed: a gym without an account is skipped, a failing pull is said, the run goes on.
    const lines = [];
    const fake = (gym) => ({ list: async (path) => { if (gym === "three") throw new Error("(#200) no access"); return /\/ads$/.test(path) ? history.ads.filter((a) => a.origin !== "export").map((a) => ({ id: a.id, name: a.name, adset_id: a.adset_id, campaign_id: a.campaign_id, status: "ACTIVE", effective_status: "ACTIVE", created_time: "2026-09-01T00:00:00+0800", creative: { id: "cr", image_hash: a.hashes[0] || null, ...(a.poster ? { object_type: "VIDEO", object_story_spec: { video_data: { image_hash: a.poster } } } : {}) } })) : /\/adsets$/.test(path) ? [{ id: "s1", name: "S", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE" }] : /\/campaigns$/.test(path) ? [{ id: "c1", name: "C", status: "ACTIVE", effective_status: "ACTIVE" }] : /insights$/.test(path) ? history.ads.filter((a) => a.all_time.spend).map((a) => ({ ad_id: a.id, spend: "100", impressions: "1000", reach: "500", actions: [{ action_type: "lead", value: "10" }] })) : []; }, get: async (path) => (/adimages$/.test(path) ? { data: [] } : { id: "c9", status: "PAUSED", effective_status: "PAUSED" }) });
    const done = await refreshAll({ brandsDir: brands, log: (m) => lines.push(m), clientFor: fake });
    assert.deepEqual(done.map((x) => [x.gym, x.skipped || null, x.steps?.history?.replace(/\d+/g, "N") || null]), [["one", null, "N campaigns, N ads"], ["three", null, "failed: (#N) no access"], ["two", "no ad account", null]]);
    assert.ok(lines.some((l) => /TWO: no ad account/.test(l)) && lines.some((l) => /ONE: history .* results b1 pulled · pictures 0 fetched, 2 already here, 1 skipped · 4 of 4 pictures not read yet/.test(l)), lines.join("\n"));
    assert.equal(readHistory(g).ads.length, 6, "the pull kept nothing stale and the history is whole");
    // One cap for the whole portfolio.
    const ask = async (f) => ({ format: /outputs/.test(f) ? "workout" : "studio-portrait", subject: "woman", people: 1, backdrop: /outputs/.test(f) ? "gym-floor" : "dark-wall", pose: "easy-posed", expression: "smile", eye_contact: true, mood: "m", text_density: "light", words: [], logo: false, colours: [] });
    let r = await readAll({ brandsDir: brands, max: 3, log: () => {}, ask });
    assert.deepEqual([r.calls, r.gyms.find((x) => x.gym === "one").read, r.gyms.find((x) => x.gym === "one").left], [3, 3, 1]);
    r = await readAll({ brandsDir: brands, max: 10, log: () => {}, ask });
    assert.deepEqual([r.calls, unreadCount(g)], [1, { pictures: 4, unread: 0 }], "the second run reads only what was left");
    const { byAd } = readsFor(g);
    assert.deepEqual([byAd.get("1").format, byAd.get("2").format, byAd.get("900").format, byAd.get("901").format, byAd.has("4")], ["studio-portrait", "studio-portrait", "workout", "workout", false]);
    // The portfolio view over the folders.
    const A = whatWinsAcross(brands, { scope: "all" });
    assert.deepEqual(A.gyms.map((x) => [x.gym, x.ads > 0, x.unread]), [["one", true, 0], ["three", false, 0], ["two", false, 0]]);
    assert.ok(A.suggestions.some((x) => x.kind === "no-data" && x.gym === "two") && Array.isArray(A.tables));
    assert.ok(!A.gyms[0].rows && A._gyms[0].rows.every((x) => !x.abroad), "ad sets reaching abroad are left out of every table");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
