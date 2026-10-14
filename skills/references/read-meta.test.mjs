/**
 * Tests for onboarding from the gym's own Facebook Page and ad account (read-meta.mjs): what is read and how it is
 * summarised, the offer names, the callout, and the owner's accept applied to the profile — offline, a fake client.
 *
 *   node --test skills/references/read-meta.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMetaFacts, acceptMetaFacts, writeMetaReading, readMetaReading, hoursLine, calloutFrom, offerNameFrom, budgetUnits, META_DIR } from "./read-meta.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";
import { readWordings } from "./ad-wordings.mjs";

const PAGE = { id: "105176144862096", name: "F45 Xinyi 信義", username: "f45xinyi", category: "Gym", fan_count: 943, phone: "+886980660800", emails: ["x@y.tw"], website: "http://f45xinyi.com/6weekplan", about: "我們幫忙碌的現代人有效減肥", hours: { mon_1_open: "06:00", mon_1_close: "21:00", sat_1_open: "08:00", sat_1_close: "12:00" },
  location: { street: "台北市信義區信義路四段413號二樓", city: "Taipei", country: "Taiwan", zip: "110", latitude: 25.033241, longitude: 121.559067 }, single_line_address: "台北市信義區信義路四段413號二樓, Taipei, Taiwan 110", instagram_business_account: { id: "17841449500342630", username: "f45_xinyi" } };
const ACCOUNT = { id: "act_5595320690525032", account_id: "5595320690525032", name: "F45 Xinyi", currency: "TWD", timezone_name: "Asia/Taipei", business_country_code: "TW", business: { id: "1", name: "F45 Xinyi" } };
const place = (radius) => ({ geo_locations: { places: [{ key: "105176144862096", name: "F45 Xinyi 信義", latitude: 25.033241, longitude: 121.559067, radius, distance_unit: "kilometer" }], location_types: ["home", "recent"] } });
const SETS = [
  { id: "1", name: "0713 6 Week 中年體態雕塑", daily_budget: "500", created_time: "2026-07-13T21:50:08+0800", campaign: { name: "0709 6 Week 蜜桃臀｜線條｜體態雕塑", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 50, genders: [1], ...place(2.5) } },
  { id: "2", name: "0713 6 Week  女生蜜桃臀", daily_budget: "300", created_time: "2026-07-13T21:50:08+0800", campaign: { name: "0709 6 Week 蜜桃臀｜線條｜體態雕塑", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 50, genders: [2], ...place(2.5) } },
  { id: "3", name: "0404 Male - 40天川字肌計畫 | Audience: Luxury + Fitness, 28-53, 4.5KM", daily_budget: "2200", created_time: "2026-04-04T10:00:00+0800", campaign: { name: "Jan 8 2025 - Text Creative Testing - Blue", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 53, genders: [1], ...place(4.5) } },
  { id: "4", name: "0121 6 Week | FS UT | Retest - TOF Widenet", daily_budget: "100", created_time: "2026-01-21T10:00:00+0800", campaign: { name: "x", objective: "OUTCOME_TRAFFIC" }, targeting: { age_min: 28, age_max: 50, ...place(2.5) } },
];
const client = (over = {}) => ({
  accountFacts: async () => ACCOUNT, pageFacts: async () => PAGE, adsetHistory: async () => SETS,
  historyPins: async () => [{ kind: "place", key: "105176144862096", name: "F45 Xinyi 信義", lat: 25.033241, lng: 121.559067, radius_km: 2.5, location_types: ["home", "recent"], adsets: 3, example: "0713 6 Week 中年體態雕塑" }],
  ...over,
});
const gymDir = (profile) => { const d = mkdtempSync(join(tmpdir(), "readmeta-")); writeFileSync(join(d, "gym-profile.json"), JSON.stringify(profile, null, 2)); return d; };

test("RM1 the pieces: hours as one line, the callout from a Chinese address (the district) or the city, offer names from ad-set names (the date, a version tag, a gender prefix, a photo/video suffix and the test labels off; a bare duration is nothing), whole-unit currencies", () => {
  assert.equal(hoursLine(PAGE.hours), "Mon 06:00-21:00; Sat 08:00-12:00");
  assert.equal(hoursLine(null), "");
  assert.deepEqual([calloutFrom(PAGE.location), calloutFrom({ street: "26 Sin Ming Lane", city: "Singapore" }), calloutFrom({})], ["信義區", "Singapore", ""]);
  assert.deepEqual(["0713 6 Week 中年體態雕塑", "0404 Male - 40天川字肌計畫 | Audience: Luxury + Fitness, 28-53, 4.5KM", "0713 六週女生蜜桃臀計畫 照片3", "0427 6 Week - Gender Neutral, 28-45, 3KM", "0121 6 Week | FS UT | Retest - TOF Widenet", "(v2) 6Week", "Jan 8 2025 - Text Creative Testing - Blue", "1221 6Week | Video: Girls Battle Ropes", "0915 12 Week Total Body Reset | Audience: Broad"].map(offerNameFrom),
    ["6 Week 中年體態雕塑", "40天川字肌計畫", "六週女生蜜桃臀計畫", "", "", "", "", "", "12 Week Total Body Reset"]);
  assert.deepEqual([budgetUnits("TWD"), budgetUnits("SGD"), budgetUnits("jpy"), budgetUnits(null)], [1, 100, 1, 100]);
});

test("RM2 reading the Page and the account: the address with its point, phone, website, Instagram; the country, currency and time zone; the ad sets summarised (ages and radius most used first, genders, the budget median in the currency's units, objectives); the Page's own place as the pin with the radius they run; the offers their ad sets named; the callout; a part that fails is a problem, not a crash; nothing without ids", async () => {
  const profile = { gym_id: "f45-xinyi", meta_assets: { ad_account_id: "act_5595320690525032", page_id: "105176144862096" } };
  const r = await readMetaFacts({ client: client(), profile, now: "2026-10-07T00:00:00.000Z" });
  assert.deepEqual([r.account.country, r.account.currency, r.account.timezone, r.page.address.zip, r.page.address.lat, r.page.phone, r.page.website, r.page.instagram.username, r.page.hours], ["TW", "TWD", "Asia/Taipei", "110", 25.033241, "+886980660800", "http://f45xinyi.com/6weekplan", "f45_xinyi", "Mon 06:00-21:00; Sat 08:00-12:00"]);
  assert.deepEqual([r.adsets.count, r.adsets.ages[0], r.adsets.genders, r.adsets.radius_km[0], r.adsets.daily_budget, r.adsets.objectives[0]], [4, { min: 28, max: 50, adsets: 3 }, { all: 1, men: 2, women: 1 }, { km: 2.5, adsets: 3 }, { median: 500, min: 100, max: 2200, units: 1, currency: "TWD" }, { objective: "OUTCOME_LEADS", adsets: 3 }]);
  assert.deepEqual([r.pin.kind, r.pin.key, r.pin.radius_km], ["place", "105176144862096", 2.5], "the Page's own Meta place, with the radius their ad sets use");
  assert.deepEqual(r.offers.map((o) => o.text), ["6 Week 中年體態雕塑", "6 Week 女生蜜桃臀", "40天川字肌計畫"]);
  assert.deepEqual(r.callouts, ["信義區"]);
  assert.deepEqual(r.problems, []);
  const r2 = await readMetaFacts({ client: client({ adsetHistory: async () => { throw new Error("no"); } }), profile });
  assert.deepEqual([r2.adsets, r2.offers, r2.problems.length, r2.pin.kind], [null, [], 1, "place"]);
  await assert.rejects(readMetaFacts({ client: client(), profile: { meta_assets: {} } }), /Meta link page first/);
});

test("RM3 accept: on a copy first (a refusal changes nothing); the locale from the account (with the targeting country, the locale and the Singapore starter's people line following), the address as a location (filled into the empty one, with phone and hours; updated not doubled on a second accept), the website, Instagram and Facebook, the pin as a Meta place with the chosen radius and the callout, the ages, the budget in the account's currency, the callout on Ad defaults, the ticked offers as wordings (only ones the account named); nothing without a reading", async () => {
  const profile = PROFILE_STARTER("f45-xinyi", "F45 Xinyi");
  const d = gymDir(profile);
  assert.throws(() => acceptMetaFacts(d, { locale: true }), /read the ad account first/);
  const r = await readMetaFacts({ client: client(), profile: { ...profile, meta_assets: { ad_account_id: "act_5595320690525032", page_id: "105176144862096" } } });
  writeMetaReading(d, r); assert.ok(existsSync(join(d, META_DIR, "reading.json"))); assert.equal(readMetaReading(d).page.id, PAGE.id);
  const out = acceptMetaFacts(d, { locale: true, address: true, phone: true, hours: true, website: true, instagram: true, facebook: true, pin: { radius_km: 3 }, ages: { min: 28, max: 50 }, budget: 500, offers: ["6 Week 中年體態雕塑", "not theirs"], callouts: ["信義區"] });
  const p = out.profile;
  assert.deepEqual([p.locale.country, p.locale.currency, p.locale.timezone, p.locale.languages, p.targeting_defaults.geo.countries, p.targeting_defaults.demographics.locales, p.brand_lock.photography.people], ["TW", "TWD", "Asia/Taipei", ["zh_TW"], ["TW"], ["zh_TW"], "Taiwanese, real training clothes, ages 25-55"]);
  assert.deepEqual([p.locations.length, p.locations[0].postal_code, p.locations[0].lat, p.locations[0].phone, p.locations[0].opening_hours, p.locations[0].label], [1, "110", 25.033241, "+886980660800", "Mon 06:00-21:00; Sat 08:00-12:00", "F45 Xinyi 信義"], "the starter's empty location is filled, not a second one added");
  assert.deepEqual([p.website, p.social], ["http://f45xinyi.com/6weekplan", { instagram: "f45_xinyi", facebook: "https://www.facebook.com/f45xinyi" }]);
  const pin = p.targeting_defaults.geo.radius_pins[0];
  assert.deepEqual([pin.place_key, pin.radius_km, pin.lat, pin.callouts, pin.location_types], ["105176144862096", 3, 25.033241, ["信義區"], ["home", "recent"]]);
  assert.deepEqual([p.targeting_defaults.demographics.age_min, p.targeting_defaults.demographics.age_max, p.campaign_defaults.budget.amount, p.campaign_defaults.budget.currency, p.creative_defaults.locations], [28, 50, 500, "TWD", ["信義區"]]);
  assert.deepEqual([out.wordings.added, out.wordings.skipped.map((s) => s.why)], [["6 Week 中年體態雕塑"], ["not an offer the account named"]]);
  assert.deepEqual(readWordings(d).map((w) => w.text), ["6 Week 中年體態雕塑"]);
  assert.ok(out.changes.some((c) => /locale TW · TWD/.test(c)) && out.changes.some((c) => /pin F45 Xinyi 信義 \(Meta place\) · 3 km/.test(c)));
  // A second accept on the written profile updates the location and the pin rather than doubling them.
  writeFileSync(join(d, "gym-profile.json"), JSON.stringify(p, null, 2));
  const again = acceptMetaFacts(d, { address: true, pin: { radius_km: 4 }, callouts: ["信義區"] });
  assert.deepEqual([again.profile.locations.length, again.profile.targeting_defaults.geo.radius_pins.length, again.profile.targeting_defaults.geo.radius_pins[0].radius_km, again.profile.creative_defaults.locations], [1, 1, 4, ["信義區"]]);
  // A refused accept (a budget of 0) changes nothing and names the reason.
  assert.throws(() => acceptMetaFacts(d, { budget: 0 }), /daily budget must be a number above 0/);
  assert.equal(JSON.parse(readFileSync(join(d, "gym-profile.json"), "utf-8")).campaign_defaults.budget.amount, 500);
});
