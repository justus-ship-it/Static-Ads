/**
 * Tests for targeting changed in Ads Manager (targeting-drift.mjs). A fake Meta client; no network.
 * Run: node --test skills/references/targeting-drift.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canon, sentCanon, targetingDiff, targetingItems, changedByHand, takeTargeting, acknowledge } from "./targeting-drift.mjs";
import { buildPlan, createPlan, freshRecord } from "./meta-publish.mjs";
import { pullResults, putBudgetBack, takeMetaValue } from "./meta-results.mjs";
import { readPresets } from "./meta-targeting.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";

const PLACE = { geo_locations: { places: [{ key: "107327800879305", radius: 3, distance_unit: "kilometer" }], location_types: ["home", "recent"] }, age_min: 25, age_max: 60, targeting_automation: { advantage_audience: 0 } };
/** The same targeting as Meta answers it: more fields, names, another order. */
const META_PLACE = { age_max: 60, age_min: 25, geo_locations: { location_types: ["recent", "home"], places: [{ key: "107327800879305", name: "6 Sin Ming Road", radius: 3, distance_unit: "kilometer", latitude: 1.35, longitude: 103.83, country: "SG" }] }, targeting_automation: { advantage_audience: 0 }, brand_safety_content_filter_levels: ["X"] };
const META_POINT = { ...META_PLACE, geo_locations: { location_types: ["home", "recent"], custom_locations: [{ latitude: 1.352211, longitude: 103.849611, radius: 3, distance_unit: "kilometer", primary_city_id: 1 }] } };

test("TD1 what differs and what does not: Meta's own extra fields and order are no difference; the place, its radius, ages, gender, detailed targeting and Advantage+ audience are, in words; miles are kilometres; a part not known on either side is never called different; an older record is compared by its facts", () => {
  const S = canon(PLACE), D = (live) => targetingDiff(S, canon(live));
  assert.deepEqual([D(META_PLACE), D(null), targetingDiff(null, S)], [[], [], []]);
  assert.deepEqual(D(META_POINT), [{ kind: "adset_pin", app: "place 107327800879305 + 3 km", meta: "the point 1.3522, 103.8496 + 3 km" }]);
  assert.deepEqual(D({ ...META_PLACE, age_max: 50, genders: [2] }).map((x) => [x.kind, x.app, x.meta]), [["adset_ages", "25-60", "25-50"], ["adset_gender", "everyone", "women"]]);
  assert.deepEqual(D({ ...META_PLACE, flexible_spec: [{ interests: [{ id: "6003107902433", name: "Fitness" }] }] }).map((x) => [x.kind, x.app, x.meta]), [["adset_detail", "Broad — no detailed targeting", "Fitness (interests)"]]);
  assert.deepEqual(D({ ...META_PLACE, targeting_automation: { advantage_audience: 1 } }).map((x) => x.kind), ["adset_advantage"]);
  const mile = { ...META_PLACE, geo_locations: { ...META_PLACE.geo_locations, places: [{ key: "107327800879305", radius: 1.864, distance_unit: "mile" }] } };
  assert.deepEqual(D(mile), [], "1.864 miles is 3 km");
  assert.deepEqual(D({ ...META_PLACE, geo_locations: { ...META_PLACE.geo_locations, location_types: ["home"] } }).map((x) => x.kind), ["adset_pin"]);
  // An older record: the Meta place and the rest by its facts; a dropped point was never recorded, so it is not compared.
  const facts = { place_key: "107327800879305", pin: "Sin Ming", radius_km: 3, age_min: 25, age_max: 60, gender: "all", preset_id: "broad" };
  assert.deepEqual([targetingItems("BISHAN", { facts }, META_PLACE, { presets: [] }), targetingItems("BISHAN", { facts: { ...facts, place_key: null } }, META_POINT, { presets: [] })], [[], []]);
  const [it] = targetingItems("BISHAN", { facts }, META_POINT, { presets: [] });
  assert.deepEqual([it.kind, it.fixable, it.back, it.text], ["adset_pin", true, true, "ad set BISHAN's place on Meta: the point 1.3522, 103.8496 + 3 km; the app sent Sin Ming + 3 km. A create leaves Ads Manager's targeting as it is until you choose"]);
  assert.equal(sentCanon({ facts: { ...facts, preset_id: "gone" } }).spec, null, "a preset that is gone is not compared");
  const two = { ...META_PLACE, geo_locations: { places: [...META_PLACE.geo_locations.places, { key: "9", name: "Other", radius: 2 }] } };
  assert.deepEqual(targetingItems("BISHAN", { targeting: PLACE }, two, {}).map((x) => [x.kind, x.fixable, x.back]), [["adset_pin", false, true]], "two places: the app holds one, so it is kept only in Ads Manager");
  assert.deepEqual(targetingItems("X", { targeting: PLACE }, { ...META_PLACE, targeting_automation: { advantage_audience: 1 } }, {}).map((x) => [x.kind, x.fixable]), [["adset_advantage", false]]);
});

test("TD2 a create never overwrites a change made by hand: the record holds the targeting sent; an ad set whose targeting was changed in Ads Manager keeps it when the campaign is created again with other settings (its name and budget still updated), the run says so; Keep Ads Manager's makes the settings match it, so the next create changes nothing; Put the app's back sends the app's on the next create", async () => {
  const d = mkdtempSync(join(tmpdir(), "td-")), g = join(d, "brands", "testgym"), out = join(g, "outputs", "b1"); mkdirSync(join(out, "101-x", "4x5"), { recursive: true });
  try {
    const profile = { ...PROFILE_STARTER("testgym", "Test Gym", "SG"), website: "https://t.sg", meta_assets: { ad_account_id: "act_11111", page_id: "77777", lead_form_id: "40011", singapore_beneficiary_id: "11111", singapore_payer_id: "11111" } };
    profile.targeting_defaults = { ...profile.targeting_defaults, geo: { countries: ["SG"], radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", place_name: "6 Sin Ming Road", radius_km: 3, location_types: ["home", "recent"], callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60 }, detailed_targeting: { default: "broad" } };
    writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile)); writeFileSync(join(out, "101-x", "4x5", "c.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const kept = [{ folder: "101-x", file: "101-x/4x5/c.png", location: "BISHAN", words: { location: "BISHAN", audience: null, offer: "6 Week Reset" }, story: null }], prof = () => JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8"));
    const settings = () => { try { return JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")); } catch { return {}; } };
    const plan = () => buildPlan({ profile: prof(), batch: { batch_id: "2026-11-22-b1" }, kept, presets: readPresets(g), settings: settings() });
    let live = null, n = 0; const posts = [];
    const client = { post: async (path, body) => { posts.push([path, body]); if (/adsets$/.test(path)) { live = structuredClone(body.targeting); return { id: "s1" }; } if (path === "s1" && body.targeting) live = structuredClone(body.targeting); if (/adimages$/.test(path)) return { images: { x: { hash: "h" } } }; return { id: `id${++n}` }; },
      get: async (id, q) => (/targeting/.test(q.fields) ? { targeting: live } : { id, name: "x", status: "PAUSED", effective_status: "PAUSED" }), adsetAds: async () => [],
      list: async (p) => (/adsets$/.test(p) ? [{ id: "s1", name: "n", status: "PAUSED", effective_status: "PAUSED", targeting: live }] : []) };
    const rp = join(out, "publish.json"), rec = () => ({ ...JSON.parse(readFileSync(rp, "utf-8")), path: rp }), run = () => createPlan(plan(), { client, batchDir: out, record: rec(), log: () => {} });
    await createPlan(plan(), { client, batchDir: out, record: freshRecord(rp, { batch_id: "b1", account: "act_11111" }), log: () => {} });
    assert.deepEqual(rec().adsets.BISHAN.targeting.geo_locations.places[0].key, "107327800879305", "what was sent is on the record");
    // Changed by hand; then the owner changes the ages here and creates again.
    live = { ...META_POINT }; writeFileSync(join(out, "publish-settings.json"), JSON.stringify({ adsets: { BISHAN: { age_max: 50, name: "New name" } } }));
    posts.length = 0; let r = await run();
    const up = posts.find(([p]) => p === "s1");
    assert.deepEqual([up[1].name, "targeting" in up[1], live.geo_locations.custom_locations.length, r.run.kept_on_meta[0].callout, r.run.kept_on_meta[0].parts[0].kind], ["New name", false, 1, "BISHAN", "adset_pin"], "its name went up; its targeting was left alone");
    // The pull says it, with both choices.
    const pulled = await pullResults({ client, record: rec(), batchDir: out, currency: "SGD", timezone: "Asia/Singapore" });
    assert.deepEqual(pulled.drift.filter((x) => /^adset_(pin|ages)/.test(x.kind)).map((x) => [x.kind, x.fixable, x.back]), [["adset_pin", true, true]]);
    // Keep Ads Manager's: the settings name the point, the gym's pins hold it (at the end), the line goes, and a create changes nothing there.
    const t = takeTargeting(out, { kind: "adset_pin", callout: "BISHAN" });
    assert.deepEqual([t.settings.adsets.BISHAN.pin, prof().targeting_defaults.geo.radius_pins.length, prof().targeting_defaults.geo.radius_pins[1].lat, prof().targeting_defaults.geo.radius_pins[0].callouts, t.drift.filter((x) => x.kind === "adset_pin").length], [1, 2, 1.352211, ["BISHAN"], 0]);
    assert.deepEqual(changedByHand(rec().adsets.BISHAN, live, readPresets(g)), []);
    posts.length = 0; r = await run();
    const second = posts.find(([p]) => p === "s1");
    assert.deepEqual([second[1].targeting.geo_locations.custom_locations[0].latitude, second[1].targeting.age_max, r.run.kept_on_meta], [1.352211, 50, undefined], "the point stays, and the ages chosen here go up");
    // Detailed targeting set by hand, kept: a preset of the gym's.
    live = { ...live, flexible_spec: [{ interests: [{ id: "6003107902433", name: "Fitness" }] }] }; await pullResults({ client, record: rec(), batchDir: out, currency: "SGD", timezone: "Asia/Singapore" });
    const k = takeTargeting(out, { kind: "adset_detail", callout: "BISHAN" });
    assert.equal(readPresets(g).presets.find((p) => p.id === k.settings.adsets.BISHAN.preset).name, "Fitness (Ads Manager)");
    // Put the app's back: the next create sends it.
    live = { ...live, age_min: 30, age_max: 40 }; await pullResults({ client, record: rec(), batchDir: out, currency: "SGD", timezone: "Asia/Singapore" });
    assert.ok(acknowledge(out, { callout: "BISHAN" }).drift.every((x) => !/^adset_(pin|ages|gender|detail)/.test(x.kind)));
    posts.length = 0; r = await run();
    assert.deepEqual([posts.find(([p]) => p === "s1")[1].targeting.age_max, live.age_max, r.run.kept_on_meta], [50, 50, undefined]);
    assert.throws(() => takeTargeting(out, { kind: "adset_ages", callout: "BISHAN" }), /pull results again/);
    // A read that fails leaves the update as it was before this.
    writeFileSync(join(out, "publish-settings.json"), JSON.stringify({ adsets: { BISHAN: { age_max: 55 } } })); posts.length = 0;
    await createPlan(plan(), { client: { ...client, get: async () => { throw new Error("down"); } }, batchDir: out, record: rec(), log: () => {} });
    assert.ok(posts.find(([p]) => p === "s1")[1].targeting);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("TD3 a budget changed by hand is left alone too (2026-11-23): a create that changes the budget here leaves Meta's as it is (the name still goes up), the run says so; the pull offers both choices; Put the app's back sends the app's on the next create; Use Meta's budget makes the two agree, so nothing is held back; a campaign budget the same way", async () => {
  const d = mkdtempSync(join(tmpdir(), "td3-")), g = join(d, "brands", "testgym"), out = join(g, "outputs", "b1"); mkdirSync(join(out, "101-x", "4x5"), { recursive: true });
  try {
    const profile = { ...PROFILE_STARTER("testgym", "Test Gym", "SG"), website: "https://t.sg", meta_assets: { ad_account_id: "act_11111", page_id: "77777", lead_form_id: "40011", singapore_beneficiary_id: "11111", singapore_payer_id: "11111" } };
    profile.targeting_defaults = { ...profile.targeting_defaults, geo: { countries: ["SG"], radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", place_name: "6 Sin Ming Road", radius_km: 3, location_types: ["home", "recent"], callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60 }, detailed_targeting: { default: "broad" } };
    writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile)); writeFileSync(join(out, "101-x", "4x5", "c.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const kept = [{ folder: "101-x", file: "101-x/4x5/c.png", location: "BISHAN", words: { location: "BISHAN", audience: null, offer: "6 Week Reset" }, story: null }];
    const settings = (o) => writeFileSync(join(out, "publish-settings.json"), JSON.stringify(o));
    const plan = () => buildPlan({ profile, batch: { batch_id: "2026-11-22-b1" }, kept, presets: readPresets(g), settings: JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")) });
    const live = { s1: {}, c1: {} }; let n = 0; const posts = [];
    const client = { post: async (path, body) => { posts.push([path, body]); if (/campaigns$/.test(path)) { live.c1 = { ...body }; return { id: "c1" }; } if (/adsets$/.test(path)) { live.s1 = { ...body }; return { id: "s1" }; } if (live[path]) Object.assign(live[path], body); if (/adimages$/.test(path)) return { images: { x: { hash: "h" } } }; return { id: `id${++n}` }; },
      get: async (id, q) => (live[id] && /budget|targeting/.test(q.fields) ? { targeting: live[id].targeting, daily_budget: live[id].daily_budget } : { id, name: "x", status: "PAUSED", effective_status: "PAUSED", ...(live[id] ? { daily_budget: live[id].daily_budget } : {}) }), adsetAds: async () => [],
      list: async (p) => (/adsets$/.test(p) ? [{ id: "s1", name: live.s1.name, status: "PAUSED", effective_status: "PAUSED", daily_budget: live.s1.daily_budget, targeting: live.s1.targeting }] : []) };
    const rp = join(out, "publish.json"), rec = () => ({ ...JSON.parse(readFileSync(rp, "utf-8")), path: rp }), run = () => createPlan(plan(), { client, batchDir: out, record: rec(), log: () => {} });
    settings({ campaign: { level: "adset", daily: 100 } });
    await createPlan(plan(), { client, batchDir: out, record: freshRecord(rp, { batch_id: "b1", account: "act_11111" }), log: () => {} });
    assert.equal(rec().adsets.BISHAN.daily_budget, 10000, "what was sent is on the record");
    // Raised to SGD 120 by hand; the owner then changes the budget here to 90 and the name.
    live.s1.daily_budget = 12000; settings({ campaign: { level: "adset", daily: 100 }, adsets: { BISHAN: { daily: 90, name: "New name" } } });
    posts.length = 0; let r = await run();
    let up = posts.find(([p]) => p === "s1");
    assert.deepEqual([up[1].name, "daily_budget" in up[1], live.s1.daily_budget, r.run.kept_on_meta[0].parts.map((h) => [h.kind, h.meta, h.app])], ["New name", false, 12000, [["adset_budget", "SGD 120 a day", "SGD 100 a day"]]]);
    const pulled = await pullResults({ client, record: rec(), batchDir: out, currency: "SGD", timezone: "Asia/Singapore" });
    const line = pulled.drift.find((x) => x.kind === "adset_budget");
    assert.deepEqual([line.meta, line.fixable, line.back, /leaves Ads Manager's budget as it is/.test(line.text)], [120, true, true, true]);
    // Put the app's back: the next create sends 90.
    putBudgetBack(out, line, { currency: "SGD" });
    posts.length = 0; r = await run();
    assert.deepEqual([posts.find(([p]) => p === "s1")[1].daily_budget, live.s1.daily_budget, r.run.kept_on_meta, rec().adsets.BISHAN.daily_budget], [9000, 9000, undefined, 9000]);
    // Raised again; Use Meta's budget: the settings take 150 and the next create holds nothing back.
    live.s1.daily_budget = 15000; const p2 = await pullResults({ client, record: rec(), batchDir: out, currency: "SGD", timezone: "Asia/Singapore" });
    takeMetaValue(out, p2.drift.find((x) => x.kind === "adset_budget"), { currency: "SGD" });
    const s = JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")); s.adsets.BISHAN.name = "Third name"; settings(s);
    posts.length = 0; r = await run();
    assert.deepEqual([posts.find(([p]) => p === "s1")[1].daily_budget, r.run.kept_on_meta], [15000, undefined]);
    // A campaign budget: raised by hand, then a different one asked here — left alone; put back — sent.
    settings({ campaign: { level: "campaign", daily: 200 } }); const fresh = join(out, "pc.json");
    await createPlan(plan(), { client, batchDir: out, record: freshRecord(fresh, { batch_id: "b1", account: "act_11111" }), log: () => {} });
    const crec = () => ({ ...JSON.parse(readFileSync(fresh, "utf-8")), path: fresh });
    live.c1.daily_budget = 25000; settings({ campaign: { level: "campaign", daily: 180, name: "Renamed" } }); posts.length = 0;
    r = await createPlan(plan(), { client, batchDir: out, record: crec(), log: () => {} });
    const cu = posts.find(([p]) => p === "c1");
    assert.deepEqual([cu[1].name, "daily_budget" in cu[1], r.run.kept_on_meta[0].campaign, crec().campaign.daily_budget], ["Renamed", false, true, 20000]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
