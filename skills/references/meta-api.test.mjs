/**
 * Tests for the Meta link (meta-api.mjs): a fake Graph API on this machine answers every call, so
 * the tests prove what the client sends, how it pages, how it explains Meta's errors, and how a
 * gym's chosen assets are resolved — with no token ever leaving the process.
 *
 *   node --test skills/references/meta-api.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { metaConfig, metaKeyNames, metaKeySuffix, graphClient, checkLink, appsecretProof, scrubTokens, explainError, MetaError, META_API_VERSION, actId } from "./meta-api.mjs";

const TOKEN = "EAA" + "t".repeat(60), SECRET = "s3cr3t-app-secret", APP = "1234567890";
let server, url, calls = [];
/** What the fake Graph answers, by path (after the version). Tests may override entries. */
const answers = {
  "me": () => ({ id: "9001", name: "strategym-panel" }),
  "me/adaccounts": (q) => (q.get("after") === "c1"
    ? { data: [{ id: "act_222", account_id: "222", name: "IronHaus Ads", currency: "SGD", account_status: 2 }], paging: { cursors: { before: "c1", after: "c2" } } }
    : { data: [{ id: "act_111", account_id: "111", name: "Sculpt Society Ads", currency: "SGD", account_status: 1, timezone_name: "Asia/Singapore", business: { id: "555", name: "Sculpt Society" } }], paging: { cursors: { before: "c0", after: "c1" }, next: "https://graph.facebook.com/next" } }),
  "me/accounts": () => ({ data: [{ id: "77", name: "Sculpt Society", category: "Gym/Physical Fitness Center", instagram_business_account: { id: "88", username: "sculptsociety" } }, { id: "78", name: "IronHaus", category: "Gym" }] }),
  "me/businesses": () => ({ data: [{ id: "555", name: "Sculpt Society" }, { id: "999", name: "Strategym" }] }),
  "77": (q) => (q.get("fields") === "access_token" ? { access_token: "PAGE-TOKEN-77" } : { id: "77", name: "Sculpt Society", instagram_business_account: { id: "88", username: "sculptsociety" } }),
  "77/leadgen_forms": () => ({ data: [{ id: "4001", name: "12 Week Reset", status: "ACTIVE", leads_count: 12 }, { id: "4002", name: "Old form", status: "ARCHIVED" }] }),
  "act_111/adspixels": () => ({ data: [{ id: "6001", name: "Sculpt pixel", last_fired_time: "2026-09-12T10:00:00+0000" }] }),
  "act_111/instagram_accounts": () => ({ data: [{ id: "88", username: "sculptsociety" }, { id: "86", username: "sculpt_old" }] }),
  "act_111/adsets": () => ({ data: [
    { id: "s1", name: "0715 Thomson | Fit Fathers", targeting: { geo_locations: { places: [{ key: "107327800879305", name: "6 Sin Ming Road, Tower 2", latitude: "1.353055", longitude: "103.836321", radius: 5, distance_unit: "kilometer" }], location_types: ["home", "recent"] } } },
    { id: "s2", name: "0331 Thomson | Abs", targeting: { geo_locations: { places: [{ key: "107327800879305", name: "6 Sin Ming Road, Tower 2", latitude: "1.353055", longitude: "103.836321", radius: 5 }], location_types: ["home", "recent"] } } },
    { id: "s3", name: "Bishan test", targeting: { geo_locations: { custom_locations: [{ latitude: 1.3524823, longitude: 103.835747, radius: 3, distance_unit: "kilometer" }], location_types: ["home"] } } },
    { id: "s4", name: "no geo" },
  ] }),
  "search": (q) => (q.get("type") === "adgeolocationmeta" ? { data: { places: Object.fromEntries(JSON.parse(q.get("places")).filter((k) => k === "107327800879305").map((k) => [k, { key: k, type: "place", name: "6 Sin Ming Road, Tower 2", address_string: "Singapore, Singapore", latitude: "1.353055", longitude: "103.836321", country_code: "SG" }])) } } : { data: [] }),
  "act_111": () => ({ id: "act_111", account_id: "111", name: "Sculpt Society Ads", currency: "SGD", account_status: 1 }),
  "act_333": () => ({ id: "act_333", account_id: "333", name: "Foreign account", currency: "USD", account_status: 1 }),
};
const errorFor = (path) => null;
let errorHook = errorFor;

before(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname.replace(`/${META_API_VERSION}/`, "");
    if (req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; for (const [k, v] of new URLSearchParams(body)) u.searchParams.set(k, v); }
    calls.push({ path, q: u.searchParams, version: u.pathname.split("/")[1], method: req.method });
    const err = errorHook(path, u.searchParams);
    if (err) { res.writeHead(err.status || 400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: err.error })); }
    if (u.searchParams.get("access_token") !== TOKEN && !(path.endsWith("/leadgen_forms") && u.searchParams.get("access_token") === "PAGE-TOKEN-77")) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" } })); }
    const a = answers[path];
    if (!a) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: `Unsupported get request. Object with ID '${path}' does not exist`, code: 803, type: "GraphMethodException" } })); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(a(u.searchParams)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const config = () => ({ token: TOKEN, appId: APP, appSecret: SECRET, graphUrl: url });
const client = () => graphClient({ config: config() });

test("M1 every call carries the token and appsecret_proof on the pinned version and asks for exactly the fields it needs; paging is followed; a Page's lead forms use that Page's own token; no token is ever in a message", async () => {
  calls = [];
  const c = client();
  const me = await c.me();
  assert.deepEqual(me, { id: "9001", name: "strategym-panel" });
  assert.equal(calls[0].version, META_API_VERSION);
  assert.equal(calls[0].q.get("access_token"), TOKEN);
  assert.equal(calls[0].q.get("appsecret_proof"), createHmac("sha256", SECRET).update(TOKEN).digest("hex"));
  assert.equal(appsecretProof(TOKEN, SECRET), calls[0].q.get("appsecret_proof"));
  assert.equal(calls[0].q.get("fields"), "id,name");
  const accounts = await c.adAccounts();
  assert.deepEqual(accounts.map((a) => a.id), ["act_111", "act_222"], "both pages of the edge");
  const pageCalls = calls.filter((x) => x.path === "me/adaccounts");
  assert.equal(pageCalls.length, 2); assert.equal(pageCalls[1].q.get("after"), "c1"); assert.equal(pageCalls[0].q.get("limit"), "100");
  assert.match(pageCalls[0].q.get("fields"), /account_status/);
  const forms = await c.leadForms("77");
  assert.deepEqual(forms.map((f) => f.id), ["4001", "4002"]);
  const fc = calls.find((x) => x.path === "77/leadgen_forms");
  assert.equal(fc.q.get("access_token"), "PAGE-TOKEN-77", "the Page's own token, fetched for the call");
  assert.equal(fc.q.get("appsecret_proof"), appsecretProof("PAGE-TOKEN-77", SECRET), "proof for that token");
  // Without an app secret the proof is left out (and the CLI warns); with one it is always there.
  calls = [];
  await graphClient({ config: { ...config(), appSecret: "" } }).me();
  assert.equal(calls[0].q.has("appsecret_proof"), false);
  // Errors in words, never carrying the token.
  for (const [code, re] of [[190, /token is invalid or has expired/], [10, /not allowed to do this/], [200, /not allowed/], [4, /rate-limiting/], [100, /did not accept the request/], [803, /knows no object/]]) {
    errorHook = () => ({ status: 400, error: { message: `boom ${TOKEN} access_token=${TOKEN}`, code, type: "OAuthException", fbtrace_id: "A1" } });
    try {
      await assert.rejects(c.me(), (e) => { assert.ok(e instanceof MetaError); assert.match(e.message, re); assert.equal(e.code, code); assert.equal(e.trace, "A1"); assert.ok(!e.message.includes(TOKEN), "no token in the message"); return true; });
    } finally { errorHook = errorFor; }
  }
  assert.ok(!scrubTokens(`x ${TOKEN} y access_token=${TOKEN}&z`).includes(TOKEN));
  assert.match(explainError({ message: "m", code: 190 }), /generate a new system-user token/);
  assert.throws(() => graphClient({ config: { ...config(), token: "" } }), /no META_ACCESS_TOKEN/);
  await assert.rejects(graphClient({ config: { ...config(), graphUrl: "http://127.0.0.1:1" } }).me(), /could not reach Meta/);
  assert.equal(actId("111"), "act_111"); assert.equal(actId("act_111"), "act_111");
});

test("M2 the link for a gym: who the token is, what it can act on, and the chosen assets resolved — currency, status, the Page's Instagram, its forms, the account's pixels — with problems in words", async () => {
  const profile = { locale: { currency: "SGD" }, meta_assets: { ad_account_id: "act_111", page_id: "77", instagram_user_id: "88", pixel_id: "6001", lead_form_id: "4001", business_id: "555" } };
  const r = await checkLink(profile, { client: client() });
  assert.deepEqual(r.chosen.instagram_accounts, [{ id: "88", username: "sculptsociety" }, { id: "86", username: "sculpt_old" }], "the Instagram accounts connected to the ad account");
  assert.deepEqual(r.chosen.history_pins.map((p) => [p.kind, p.key, p.name, p.radius_km, p.adsets, p.example]), [["place", "107327800879305", "6 Sin Ming Road, Tower 2", 5, 2, "0715 Thomson | Fit Fathers"], ["point", null, null, 3, 1, "Bishan test"]], "the pins the account already targets, most used first");
  assert.deepEqual(await client().places(["107327800879305", "55555"]), [{ key: "107327800879305", name: "6 Sin Ming Road, Tower 2", address: "Singapore, Singapore", lat: 1.353055, lng: 103.836321, country: "SG" }], "a key Meta does not know is simply absent");
  // The legacy actor id still resolves; with none chosen, the account's only Instagram account, else the Page's.
  assert.equal((await checkLink({ meta_assets: { ad_account_id: "act_111", page_id: "77", instagram_actor_id: "86" } }, { client: client() })).chosen.instagram.username, "sculpt_old");
  answers["act_111/instagram_accounts"] = () => ({ data: [{ id: "86", username: "sculpt_old" }] });
  assert.equal((await checkLink({ meta_assets: { ad_account_id: "act_111", page_id: "77" } }, { client: client() })).chosen.instagram.id, "86", "the account's only one");
  answers["act_111/instagram_accounts"] = () => ({ data: [] });
  assert.equal((await checkLink({ meta_assets: { ad_account_id: "act_111", page_id: "77" } }, { client: client() })).chosen.instagram.id, "88", "else the Page's");
  answers["act_111/instagram_accounts"] = () => ({ data: [{ id: "88", username: "sculptsociety" }, { id: "86", username: "sculpt_old" }] });
  assert.equal(r.version, META_API_VERSION);
  assert.equal(r.me.name, "strategym-panel");
  assert.deepEqual(r.accounts.map((a) => [a.id, a.status]), [["act_111", "active"], ["act_222", "disabled"]]);
  assert.deepEqual(r.pages.map((p) => [p.id, p.instagram?.username || null]), [["77", "sculptsociety"], ["78", null]]);
  assert.deepEqual(r.businesses.map((b) => b.id), ["555", "999"]);
  assert.equal(r.chosen.account.name, "Sculpt Society Ads"); assert.equal(r.chosen.account.timezone, "Asia/Singapore");
  assert.equal(r.chosen.page.name, "Sculpt Society"); assert.deepEqual(r.chosen.instagram, { id: "88", username: "sculptsociety" });
  assert.deepEqual(r.chosen.forms.map((f) => f.id), ["4001", "4002"]);
  assert.deepEqual(r.chosen.pixels.map((p) => p.id), ["6001"]);
  assert.deepEqual(r.problems, []); assert.deepEqual(r.warnings, []);
  // The digits-only account id is the same account.
  const r2 = await checkLink({ ...profile, meta_assets: { ...profile.meta_assets, ad_account_id: "111" } }, { client: client() });
  assert.equal(r2.chosen.account.id, "act_111"); assert.deepEqual(r2.problems, []);
  // Wrong choices are said in words: a pixel not on the account, an archived form, an Instagram account not the Page's,
  // a foreign currency, a disabled account, an account or Page the system user cannot act on.
  const bad = await checkLink({ locale: { currency: "SGD" }, meta_assets: { ad_account_id: "act_333", page_id: "77", instagram_user_id: "89", pixel_id: "6009", lead_form_id: "4002", business_id: "123" } }, { client: client() });
  assert.ok(bad.problems.some((p) => /bills in USD; the profile's budgets are in SGD/.test(p)), bad.problems.join("\n"));
  assert.ok(bad.problems.some((p) => /pixel 6009 is not one of the ad account's pixels/.test(p)));
  assert.ok(bad.problems.some((p) => /lead form "Old form" is archived/.test(p)));
  assert.ok(bad.problems.some((p) => /Instagram account 89 is not one connected to this ad account or Page \(88 @sculptsociety\)/.test(p)), bad.problems.join("\n"));
  assert.ok(bad.warnings.some((w) => /act_333 is not among the accounts assigned/.test(w)));
  assert.ok(bad.warnings.some((w) => /business portfolio 123 is not one the token can see/.test(w)));
  const disabled = await checkLink({ meta_assets: { ad_account_id: "act_222" } }, { client: client() });
  assert.ok(disabled.problems.some((p) => /ad account is disabled/.test(p)));
  const unknown = await checkLink({ meta_assets: { ad_account_id: "act_444", page_id: "79" } }, { client: client() });
  assert.ok(unknown.problems.some((p) => /^ad account: .*knows no object/.test(p)), unknown.problems.join("\n"));
  assert.ok(unknown.problems.some((p) => /^Page: .*knows no object/.test(p)));
  assert.equal(unknown.chosen.account, null); assert.deepEqual(unknown.chosen.forms, []);
  // Nothing chosen yet: the lists alone, no lookups.
  calls = [];
  const none = await checkLink({}, { client: client() });
  assert.deepEqual(none.chosen, { account: null, page: null, instagram: null, instagram_accounts: [], forms: [], pixels: [], history_pins: [] });
  assert.ok(!calls.some((c) => /leadgen_forms|adspixels/.test(c.path)));
  assert.ok(!JSON.stringify([r, bad, unknown, none]).includes(TOKEN) && !JSON.stringify([r, bad]).includes("PAGE-TOKEN"), "no token in what the panel is given");
});

test("M3 the keys come from .env per gym — the gym's own suffixed keys first, shared keys after; the environment wins for a name (empty there means none); placeholders count as missing; the endpoint can be pointed elsewhere", () => {
  const d = mkdtempSync(join(tmpdir(), "meta-env-"));
  try {
    const envFile = join(d, ".env");
    writeFileSync(envFile, `GEMINI_KEY=x\nMETA_ACCESS_TOKEN="${TOKEN}"\nMETA_APP_ID=${APP}\nMETA_APP_SECRET=${SECRET}\n`);
    let c = metaConfig({ env: {}, envFile });
    assert.deepEqual([c.token, c.appId, c.appSecret, c.graphUrl], [TOKEN, APP, SECRET, "https://graph.facebook.com"]);
    assert.deepEqual(c.used, { META_ACCESS_TOKEN: "META_ACCESS_TOKEN", META_APP_ID: "META_APP_ID", META_APP_SECRET: "META_APP_SECRET" });
    c = metaConfig({ env: { META_ACCESS_TOKEN: "", META_GRAPH_URL: url }, envFile });
    assert.equal(c.token, ""); assert.equal(c.graphUrl, url); assert.equal(c.appSecret, SECRET, "the other keys still come from the file");
    writeFileSync(envFile, "META_ACCESS_TOKEN=your-meta-system-user-token-here\nMETA_APP_ID=your-meta-app-id-here\nMETA_APP_SECRET=paste-here\n");
    c = metaConfig({ env: {}, envFile });
    assert.deepEqual([c.token, c.appId, c.appSecret], ["", "", ""], "the example's placeholders are not keys");
    assert.equal(metaConfig({ env: {}, envFile: join(d, "none") }).token, "");
    // Per gym: one app per business portfolio, so each gym has its own keys; the shared ones fill any gap.
    assert.deepEqual(metaKeyNames("sculpt-society"), { META_ACCESS_TOKEN: "META_ACCESS_TOKEN_SCULPT_SOCIETY", META_APP_ID: "META_APP_ID_SCULPT_SOCIETY", META_APP_SECRET: "META_APP_SECRET_SCULPT_SOCIETY" });
    assert.equal(metaKeySuffix("iron-haus-2"), "_IRON_HAUS_2");
    writeFileSync(envFile, `META_ACCESS_TOKEN=${TOKEN}\nMETA_APP_ID=${APP}\nMETA_APP_SECRET=${SECRET}\nMETA_ACCESS_TOKEN_SCULPT_SOCIETY=${TOKEN}sculpt\nMETA_APP_ID_SCULPT_SOCIETY=9999999999\n`);
    c = metaConfig({ env: {}, envFile, gym: "sculpt-society" });
    assert.deepEqual([c.token, c.appId, c.appSecret], [TOKEN + "sculpt", "9999999999", SECRET], "its own token and app id; the shared secret fills the gap");
    assert.deepEqual(c.used, { META_ACCESS_TOKEN: "META_ACCESS_TOKEN_SCULPT_SOCIETY", META_APP_ID: "META_APP_ID_SCULPT_SOCIETY", META_APP_SECRET: "META_APP_SECRET" });
    c = metaConfig({ env: {}, envFile, gym: "iron-haus" });
    assert.deepEqual([c.token, c.used.META_ACCESS_TOKEN], [TOKEN, "META_ACCESS_TOKEN"], "another gym never sees Sculpt Society's keys");
    writeFileSync(envFile, `META_ACCESS_TOKEN_SCULPT_SOCIETY=${TOKEN}sculpt\n`);
    c = metaConfig({ env: {}, envFile, gym: "iron-haus" });
    assert.deepEqual([c.token, c.used.META_ACCESS_TOKEN], ["", null], "and gets nothing when there is no shared key");
    c = metaConfig({ env: { META_ACCESS_TOKEN_SCULPT_SOCIETY: "" }, envFile, gym: "sculpt-society" });
    assert.equal(c.token, "", "the environment's empty value wins over the file for that name");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("M4 one of everything (meta-publish): the payloads are built from the profile and the ad — cents budget, the pin, the callout's gender, PAUSED everywhere, the lead form on the button, placeholders that say so, Singapore's category, identity and 1-day click window; a missing id stops it before any call; the identity is read from the account's existing ad sets", async () => {
  const { buildTestOne, placeholderWords, genderFor, AD_STATUS, adsManagerUrl, NEVER_ADVANTAGE, geoFor } = await import("./meta-publish.mjs");
  const profile = { display_name: "Sculpt Society", gym_abbr: "SCS", website: "https://sculptsociety.com.sg", locale: { country: "SG", currency: "SGD" },
    meta_assets: { ad_account_id: "act_111", page_id: "77", lead_form_id: "4001", pixel_id: "6001", singapore_beneficiary_id: "4260400000000001", singapore_payer_id: "4260400000000001" },
    campaign_defaults: { objective: "OUTCOME_LEADS", budget: { amount: 40, currency: "SGD", bid_strategy: "LOWEST_COST_WITHOUT_CAP" }, attribution: { click_window_days: 7, view_window_days: 1 } },
    targeting_defaults: { geo: { radius_pins: [{ label: "Sin Ming", lat: 1.3524823, lng: 103.835747, radius_km: 5, location_types: ["home", "recent"] }] }, demographics: { age_min: 25, age_max: 45 } } };
  const batch = { batch_id: "b1" };
  const ad = { folder: "101-c01-bishan-t3-green-white", file: "101-c01-bishan-t3-green-white/1x1/c01-bishan_1x1_v1.png", words: { location: "BISHAN", audience: "MEN WANTED", offer: "12 Week Total Body Reset", free: false } };
  const p = buildTestOne({ profile, batch, ad, storyFile: "x/9x16/c01_9x16_v1.png", tag: "2026-09-13" });
  assert.equal(p.account, "act_111");
  assert.deepEqual(p.campaign, { name: "SCS | TEST | Leads | 12 Week Total Body Reset | 2026-09-13", objective: "OUTCOME_LEADS", status: "PAUSED", special_ad_categories: [], buying_type: "AUCTION" }, "ad-set budgets by default: the campaign carries none");
  assert.deepEqual([p.adset.daily_budget, p.adset.bid_strategy, p.adset.bid_amount, p.budget], [4000, "LOWEST_COST_WITHOUT_CAP", undefined, { level: "adset", daily: 40, currency: "SGD", bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cap: null }]);
  assert.equal(p.adset.name, "SCS_BISHAN_TEST_2026-09-13"); assert.equal(p.adset.status, "PAUSED");
  // Campaign budget instead; a capped strategy carries its bid; an unknown strategy or a missing cap stops the plan.
  const cbo = buildTestOne({ profile: { ...profile, campaign_defaults: { budget: { level: "campaign", amount: 60, currency: "SGD", bid_strategy: "COST_CAP", bid_cap: 15 } } }, batch, ad });
  assert.deepEqual([cbo.campaign.daily_budget, cbo.campaign.bid_strategy, cbo.adset.daily_budget, cbo.adset.bid_strategy, cbo.adset.bid_amount, cbo.budget.level], [6000, "COST_CAP", undefined, undefined, 1500, "campaign"]);
  assert.throws(() => buildTestOne({ profile: { ...profile, campaign_defaults: { budget: { amount: 40, bid_strategy: "COST_CAP" } } }, batch, ad }), /Cost per result goal needs an amount/);
  assert.throws(() => buildTestOne({ profile: { ...profile, campaign_defaults: { budget: { amount: 40, bid_strategy: "MAGIC" } } }, batch, ad }), /bid strategy "MAGIC"/);
  assert.equal(buildTestOne({ profile: { ...profile, campaign_defaults: { budget: {} } }, batch, ad }).adset.daily_budget, 5000, "SGD 50/day when nothing is set");
  // Pins: the one naming the callout (a Meta place by key), else the first (said so); the gender map over the words; never Advantage+.
  const pinned = { ...profile, targeting_defaults: { ...profile.targeting_defaults, geo: { radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", place_name: "6 Sin Ming Road, Tower 2", radius_km: 5 }, { label: "Bishan", lat: 1.35, lng: 103.85, radius_km: 3, location_types: ["home"], callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60, callout_genders: { "MEN WANTED": "all" } } } };
  const b1 = buildTestOne({ profile: pinned, batch, ad });
  assert.deepEqual(b1.adset.targeting.geo_locations, { custom_locations: [{ latitude: 1.35, longitude: 103.85, radius: 3, distance_unit: "kilometer" }], location_types: ["home"] });
  assert.deepEqual([b1.pin.label, b1.pin.fallback, b1.adset.targeting.genders, b1.adset.targeting.age_max], ["Bishan", false, undefined, 60], "the owner's map says MEN WANTED is for everyone here");
  const b2 = buildTestOne({ profile: pinned, batch, ad: { ...ad, words: { ...ad.words, location: "ANG MO KIO" } } });
  assert.deepEqual(b2.adset.targeting.geo_locations, { places: [{ key: "107327800879305", radius: 5, distance_unit: "kilometer" }], location_types: ["home", "recent"] }, "a named Meta place, as their own ad sets do");
  assert.deepEqual([b2.pin.label, b2.pin.fallback], ["Sin Ming", true]); assert.match(b2.pin.words, /6 Sin Ming Road, Tower 2 \(Meta place 107327800879305\) · 5 km · the gym's first pin/);
  assert.deepEqual(b1.adset.targeting.targeting_automation, { advantage_audience: 0 }); assert.deepEqual(NEVER_ADVANTAGE, { advantage_audience: 0 });
  assert.equal(JSON.stringify(buildTestOne({ profile: pinned, batch, ad })).includes('"advantage_audience":1'), false);
  assert.throws(() => buildTestOne({ profile: { ...profile, targeting_defaults: { geo: { radius_pins: [{ label: "Only a code", postal_code: "575583" }] } } }, batch, ad }), /no usable radius pin for BISHAN/);
  // The Instagram identity on the creative when the profile has one; none, and Meta picks a Page-backed one (said in the plan).
  assert.equal(p.creative.object_story_spec.instagram_user_id, undefined); assert.equal(p.instagram_user_id, null);
  const ig = buildTestOne({ profile: { ...profile, meta_assets: { ...profile.meta_assets, instagram_user_id: "17841406469590226" } }, batch, ad });
  assert.equal(ig.creative.object_story_spec.instagram_user_id, "17841406469590226"); assert.equal(ig.instagram_user_id, "17841406469590226");
  assert.deepEqual(geoFor({ lat: 1.3, lng: 103.8 }), { custom_locations: [{ latitude: 1.3, longitude: 103.8, radius: 5, distance_unit: "kilometer" }], location_types: ["home", "recent"] });
  assert.deepEqual([p.adset.optimization_goal, p.adset.billing_event, p.adset.destination_type, p.adset.promoted_object], ["LEAD_GENERATION", "IMPRESSIONS", "ON_AD", { page_id: "77" }]);
  assert.deepEqual(p.adset.targeting.geo_locations.custom_locations, [{ latitude: 1.3524823, longitude: 103.835747, radius: 5, distance_unit: "kilometer" }]);
  assert.deepEqual([p.adset.targeting.age_min, p.adset.targeting.age_max, p.adset.targeting.genders, p.adset.targeting.targeting_automation], [25, 45, [1], { advantage_audience: 0 }]);
  assert.deepEqual(p.adset.attribution_spec, [{ event_type: "CLICK_THROUGH", window_days: 1 }], "lead generation only takes a 1-day click window, whatever the profile says for conversions");
  assert.deepEqual(p.adset.regional_regulated_categories, ["SINGAPORE_UNIVERSAL"]);
  assert.deepEqual(p.adset.regional_regulation_identities, { singapore_universal_beneficiary: "4260400000000001", singapore_universal_payer: "4260400000000001" });
  const ld = p.creative.object_story_spec.link_data;
  assert.equal(p.creative.object_story_spec.page_id, "77");
  assert.deepEqual(ld.call_to_action, { type: "SIGN_UP", value: { lead_gen_form_id: "4001" } });
  assert.match(ld.message, /^\[PLACEHOLDER primary text\] 12 Week Total Body Reset at Sculpt Society, Bishan\./); assert.match(ld.name, /^\[PLACEHOLDER headline\]/); assert.match(ld.description, /^\[PLACEHOLDER/);
  assert.equal(ld.link, "https://sculptsociety.com.sg", "a lead ad links to the gym's website (Meta refuses the Page's own address)");
  const features = p.creative.degrees_of_freedom_spec.creative_features_spec;
  assert.equal(features.standard_enhancements, undefined, "the blanket switch is deprecated");
  assert.ok(Object.keys(features).length >= 12 && ["image_touchups", "text_optimizations", "add_text_overlay", "image_templates", "enhance_cta"].every((k) => features[k]?.enroll_status === "OPT_OUT"), "every enhancement that can rewrite the ad is opted out by name");
  assert.throws(() => buildTestOne({ profile: { ...profile, website: "" }, batch, ad }), /must link to an external website/);
  assert.equal(p.ad.status, "PAUSED"); assert.equal(AD_STATUS, "PAUSED");
  assert.equal(p.image.name, "b1__c01-bishan_1x1_v1.png"); assert.equal(p.story.file, "x/9x16/c01_9x16_v1.png");
  assert.equal(adsManagerUrl("act_111", "9"), "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=111&selected_campaign_ids=9");
  // The owner's own words replace the placeholders; the callout decides the gender; no callout, everyone.
  const own = buildTestOne({ profile, batch, ad: { ...ad, words: { ...ad.words, audience: "LADIES WANTED" } }, words: { message: "m", headline: "h", description: "d" } });
  assert.deepEqual([own.creative.object_story_spec.link_data.message, own.creative.object_story_spec.link_data.name, own.adset.targeting.genders], ["m", "h", [2]]);
  assert.equal(buildTestOne({ profile, batch, ad: { ...ad, words: { ...ad.words, audience: null } } }).adset.targeting.genders, undefined);
  assert.deepEqual([genderFor("MEN WANTED"), genderFor("Fit Fathers"), genderFor("LADIES OF BISHAN"), genderFor("Strong Mothers"), genderFor("EVERYONE")], [[1], [1], [2], [2], null]);
  assert.deepEqual(genderFor("EVERYONE", { targeting_defaults: { demographics: { callout_genders: { EVERYONE: "women" } } } }), [2]);
  // Outside Singapore the regulated fields are left out; a missing id stops the plan.
  const abroad = buildTestOne({ profile: { ...profile, locale: { country: "MY", currency: "MYR" }, campaign_defaults: { ...profile.campaign_defaults, budget: { amount: 40, currency: "MYR" } } }, batch, ad });
  assert.equal(abroad.adset.regional_regulated_categories, undefined); assert.equal(abroad.adset.regional_regulation_identities, undefined);
  assert.throws(() => buildTestOne({ profile: { ...profile, meta_assets: { ...profile.meta_assets, lead_form_id: "" } }, batch, ad }), /missing lead_form_id/);
  assert.throws(() => buildTestOne({ profile: { ...profile, meta_assets: { ...profile.meta_assets, singapore_payer_id: "" } }, batch, ad }), /missing singapore_payer_id .*verified advertiser/);
  assert.throws(() => buildTestOne({ profile: { ...profile, targeting_defaults: { geo: { radius_pins: [] } } }, batch, ad }), /no usable radius pin/);
  assert.throws(() => buildTestOne({ profile: { ...profile, campaign_defaults: { budget: { amount: 40, currency: "USD" } } }, batch, ad }), /budget is in USD/);
  assert.match(placeholderWords({ display_name: "X" }, { words: {} }).message, /PLACEHOLDER/);
  // The verified identity, read from the ad sets the account already runs (the fake carries two categories).
  answers["act_111/adsets"] = () => ({ data: [
    { id: "1", name: "0715 Thomson | Fit Fathers", regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: "4260400000000001", singapore_universal_payer: "4260400000000001" } },
    { id: "2", name: "0331 Thomson | Abs", regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: "4260400000000001", singapore_universal_payer: "4260400000000001" } },
    { id: "3", name: "old", regional_regulated_categories: ["TAIWAN_UNIVERSAL"], regional_regulation_identities: { taiwan_universal_beneficiary: "5", taiwan_universal_payer: "6" } },
    { id: "4", name: "none" },
  ] });
  const ids = await client().regulationIdentities("111");
  assert.deepEqual(ids, [{ category: "SINGAPORE_UNIVERSAL", beneficiary: "4260400000000001", payer: "4260400000000001", adsets: 2, example: "0715 Thomson | Fit Fathers" }, { category: "TAIWAN_UNIVERSAL", beneficiary: "5", payer: "6", adsets: 1, example: "old" }]);
  delete answers["act_111/adsets"];
});

test("M5 createTestOne: the five objects are made in order and recorded as they land; a re-run makes nothing; a creative whose link or opt-out no longer matches the plan is remade — and its ad with it — with the old ids kept as superseded; a feature Meta refuses by name is dropped and retried; a refused opt-out as a whole makes the creative without it and says so", async () => {
  const { buildTestOne, createTestOne, ENHANCEMENTS } = await import("./meta-publish.mjs");
  const d = mkdtempSync(join(tmpdir(), "meta-publish-"));
  try {
    mkdirSync(join(d, "outputs", "b1", "101-c01-bishan-t3-green-white", "1x1"), { recursive: true });
    writeFileSync(join(d, "outputs", "b1", "101-c01-bishan-t3-green-white", "1x1", "c01-bishan_1x1_v1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const profile = { display_name: "Sculpt Society", gym_abbr: "SCS", website: "https://sculptsociety.com.sg", locale: { country: "SG", currency: "SGD" },
      meta_assets: { ad_account_id: "act_111", page_id: "77", lead_form_id: "4001", singapore_beneficiary_id: "4260400000000001", singapore_payer_id: "4260400000000001" },
      campaign_defaults: { budget: { amount: 40, currency: "SGD" } }, targeting_defaults: { geo: { radius_pins: [{ lat: 1.35, lng: 103.83, radius_km: 5 }] } } };
    const ad = { folder: "101-c01-bishan-t3-green-white", file: "101-c01-bishan-t3-green-white/1x1/c01-bishan_1x1_v1.png", words: { location: "BISHAN", audience: "MEN WANTED", offer: "12 Week Total Body Reset" } };
    const plan = buildTestOne({ profile, batch: { batch_id: "b1" }, ad, tag: "2026-09-17" });
    let n = 0, refuse = null;
    const bodies = [];
    Object.assign(answers, {
      "act_111/adimages": (q) => { bodies.push(["adimages", q]); return { images: { [q.get("name")]: { hash: "h4sh", url: "https://cdn/x.png" } } }; },
      "act_111/campaigns": (q) => { bodies.push(["campaigns", q]); return { id: "c" + ++n }; },
      "act_111/adsets": (q) => { bodies.push(["adsets", q]); return { id: "s" + ++n }; },
      "act_111/adcreatives": (q) => { bodies.push(["adcreatives", q]); return { id: "cr" + ++n }; },
      "act_111/ads": (q) => { bodies.push(["ads", q]); return { id: "ad" + ++n }; },
    });
    errorHook = (path, q) => (path === "act_111/adcreatives" && refuse ? refuse(q) : null);
    const path = join(d, "outputs", "b1", "publish-test.json");
    const fresh = () => ({ path, test: true, batch_id: "b1", ad: ad.folder, account: "act_111", created: {}, error: null });
    const log = [];
    // 1. Everything made, in order, each POST carrying the token, with the plan's payloads.
    const record = fresh();
    const r = await createTestOne(plan, { client: client(), brandDir: d, record, log: (m) => log.push(m) });
    assert.deepEqual(bodies.map((b) => b[0]), ["adimages", "campaigns", "adsets", "adcreatives", "ads"]);
    assert.ok(bodies.every((b) => b[1].get("access_token") === TOKEN && b[1].get("appsecret_proof")), "every POST is signed");
    assert.equal(bodies[0][1].get("bytes"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"));
    assert.equal(JSON.parse(bodies[2][1].get("targeting")).genders[0], 1); assert.equal(bodies[2][1].get("campaign_id"), "c1"); assert.equal(bodies[2][1].get("status"), "PAUSED");
    const spec = JSON.parse(bodies[3][1].get("degrees_of_freedom_spec")).creative_features_spec;
    assert.deepEqual(Object.keys(spec).sort(), [...ENHANCEMENTS].sort()); assert.ok(Object.values(spec).every((v) => v.enroll_status === "OPT_OUT"));
    assert.equal(JSON.parse(bodies[3][1].get("object_story_spec")).link_data.image_hash, "h4sh");
    assert.equal(JSON.parse(bodies[3][1].get("object_story_spec")).link_data.link, "https://sculptsociety.com.sg");
    assert.deepEqual([bodies[4][1].get("adset_id"), bodies[4][1].get("creative"), bodies[4][1].get("status")], ["s2", JSON.stringify({ creative_id: "cr3" }), "PAUSED"]);
    assert.deepEqual([r.campaign.id, r.adset.id, r.creative.id, r.ad.id, r.creative.enhancements, r.ad.creative_id], ["c1", "s2", "cr3", "ad4", "opted out", "cr3"]);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual([onDisk.created.image.hash, onDisk.created.campaign.id, onDisk.created.ad.id, onDisk.done > "", onDisk.path], ["h4sh", "c1", "ad4", true, undefined]);
    // 2. A re-run makes nothing.
    bodies.length = 0;
    const again = await createTestOne(plan, { client: client(), brandDir: d, record: { ...JSON.parse(readFileSync(path, "utf-8")), path }, log: (m) => log.push(m) });
    assert.equal(bodies.length, 0, "no call at all"); assert.deepEqual([again.creative.id, again.ad.id], ["cr3", "ad4"]);
    // 3. The plan's link changed (the website was filled in later): the creative and its ad are remade, the old ones kept.
    const stale = { ...JSON.parse(readFileSync(path, "utf-8")), path };
    stale.created.creative.link = "https://www.facebook.com/77/";
    const r3 = await createTestOne(plan, { client: client(), brandDir: d, record: stale, log: (m) => log.push(m) });
    assert.deepEqual(bodies.map((b) => b[0]), ["adcreatives", "ads"], "only the creative and the ad");
    assert.deepEqual([r3.campaign.id, r3.adset.id, r3.creative.id, r3.ad.id], ["c1", "s2", "cr5", "ad6"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).superseded.map((x) => [x.step, x.id]), [["creative", "cr3"], ["ad", "ad4"]]);
    assert.match(log.find((m) => /creative: cr3 no longer/.test(m)), /its link was https:\/\/www.facebook.com\/77\//);
    // 4. Meta refuses one feature by name: dropped and retried; the record says which.
    let mark = calls.length;
    const creativeCalls = () => calls.slice(mark).filter((c) => c.path === "act_111/adcreatives").map((c) => c.q);
    refuse = (q) => (JSON.parse(q.get("degrees_of_freedom_spec") || "{}").creative_features_spec?.image_uncrop ? { error: { message: "Invalid parameter", code: 100, error_user_msg: "image_uncrop is not available for this ad" } } : null);
    const r4 = await createTestOne(plan, { client: client(), brandDir: d, record: fresh(), log: (m) => log.push(m) });
    const specs = creativeCalls().map((q) => Object.keys(JSON.parse(q.get("degrees_of_freedom_spec")).creative_features_spec));
    assert.equal(specs.length, 2); assert.ok(specs[0].includes("image_uncrop") && !specs[1].includes("image_uncrop") && specs[1].length === ENHANCEMENTS.length - 1);
    assert.deepEqual([r4.creative.enhancements, r4.creative.opt_out_refused], ["opted out", ["image_uncrop"]]);
    // 5. The opt-out as a whole is refused: made without it, and the record says so.
    mark = calls.length;
    refuse = (q) => (q.get("degrees_of_freedom_spec") ? { error: { message: "Invalid parameter", code: 100, error_user_msg: "degrees_of_freedom_spec is not supported for this creative" } } : null);
    const r5 = await createTestOne(plan, { client: client(), brandDir: d, record: fresh(), log: (m) => log.push(m) });
    assert.equal(creativeCalls().length, 2); assert.equal(creativeCalls()[1].get("degrees_of_freedom_spec"), null);
    assert.match(r5.creative.enhancements, /not opted out/); assert.equal(r5.creative.opt_out_refused.length, ENHANCEMENTS.length);
    // 6. Any other refusal stops the run where it is, recorded with its step.
    refuse = () => ({ error: { message: "Invalid parameter", code: 100, error_user_msg: "Lead Generation ads should always link to external content" } });
    const rec6 = fresh();
    await assert.rejects(createTestOne(plan, { client: client(), brandDir: d, record: rec6, log: () => {} }), /external content/);
    assert.equal(rec6.error.step, "creative"); assert.ok(rec6.created.adset?.id && !rec6.created.creative);
  } finally {
    errorHook = errorFor;
    for (const k of ["act_111/adimages", "act_111/campaigns", "act_111/adsets", "act_111/adcreatives", "act_111/ads"]) delete answers[k];
    rmSync(d, { recursive: true, force: true });
  }
});

test("M6 the publish plan for a batch: the kept ads only (excluded ads and photos out; a Stories version only while its file exists); one campaign; one ad set per location callout with its pin (the owner's pick, the one naming the callout, else the first — said so), ages, gender, preset (the owner's pick, the profile's, else the suggestion) and budget; one ad per kept ad with two images by placement when it has a 9:16, the 1:1 alone when not; placeholders that say so; the owner's settings over the defaults; problems stop it, warnings are said; nothing calls Meta", async () => {
  const { buildPlan, keptAds, creativeFor, campaignWords, PLACEMENT_RULES, ADS_PER_ADSET_CAP, CTA_TYPES } = await import("./meta-publish.mjs");
  const d = mkdtempSync(join(tmpdir(), "meta-plan-"));
  try {
    const ad = (n, loc, photo) => ({ folder: `${n}-c0${n.slice(-1)}-${loc.toLowerCase().replace(/ /g, "-")}-t3-green-white`, file: `${n}-x/1x1/a.png`, location: loc, photos: [photo], words: { location: loc, audience: "MEN WANTED", offer: "12 Week Total Body Reset", free: false } });
    const ads = [ad("101", "BISHAN", "g01"), ad("102", "BISHAN", "g02"), ad("103", "ANG MO KIO", "g01"), ad("104", "ANG MO KIO", "g02"), ad("105", "BISHAN", "g03")];
    writeFileSync(join(d, "batch.json"), JSON.stringify({ batch_id: "2026-09-13-men", ads }));
    writeFileSync(join(d, "review.json"), JSON.stringify({ ads: { [ads[1].folder]: "exclude" }, photos: { g03: "exclude" } }));
    mkdirSync(join(d, "101-x", "9x16"), { recursive: true }); writeFileSync(join(d, "101-x", "9x16", "s.png"), "x");
    writeFileSync(join(d, "stories.json"), JSON.stringify({ ads: [{ folder: ads[0].folder, file: "101-x/9x16/s.png" }, { folder: ads[2].folder, file: "103-x/9x16/missing.png" }] }));
    const kept = keptAds(d);
    assert.deepEqual(kept.map((a) => [a.folder.slice(0, 3), a.location, a.story]), [["101", "BISHAN", "101-x/9x16/s.png"], ["103", "ANG MO KIO", null], ["104", "ANG MO KIO", null]], "the excluded ad and the excluded photo's ad are out; a Stories version counts only while its file exists");
    const profile = { display_name: "Sculpt Society", gym_abbr: "SCS", website: "https://sculptsociety.com.sg", locale: { country: "SG", currency: "SGD" },
      meta_assets: { ad_account_id: "act_111", page_id: "77", instagram_user_id: "88", lead_form_id: "4001", singapore_beneficiary_id: "4260400000000001", singapore_payer_id: "4260400000000001" },
      campaign_defaults: { budget: { level: "adset", amount: 50, currency: "SGD", bid_strategy: "LOWEST_COST_WITHOUT_CAP" } },
      targeting_defaults: { geo: { radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", place_name: "6 Sin Ming Road, Tower 2", radius_km: 5 }, { label: "Bishan", lat: 1.35, lng: 103.85, radius_km: 3, callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60 }, detailed_targeting: { callout_presets: {} } } };
    const presets = { presets: [{ id: "broad", name: "Broad", spec: {}, summary: ["Broad — no detailed targeting"], stats: { adsets: 14, leads: 1021, cost_per_lead: 5.43, genders: { men: 14, women: 0, all: 0 } } }, { id: "a97f701a193c", name: "Fitness+Fatherhood", spec: { flexible_spec: [{ interests: [{ id: "6003101323797", name: "Fatherhood" }] }] }, summary: ["Fatherhood (interests)"], stats: { adsets: 1, leads: 45, cost_per_lead: 56.24, genders: { men: 1, women: 0, all: 0 } } }] };
    const batch = { batch_id: "2026-09-13-men" };
    const p = buildPlan({ profile, batch, kept, presets });
    assert.deepEqual([p.ready, p.problems, p.counts], [true, [], { adsets: 2, ads: 3, with_story: 1 }]);
    assert.deepEqual([p.account, p.page_id, p.instagram_user_id, p.lead_form_id, p.website], ["act_111", "77", "88", "4001", "https://sculptsociety.com.sg"]);
    assert.deepEqual(p.campaign, { name: "0913 12 Week Total Body Reset | SCS | Men Wanted", objective: "OUTCOME_LEADS", status: "PAUSED", special_ad_categories: [], buying_type: "AUCTION", is_adset_budget_sharing_enabled: false }, "an ad-set budget: none on the campaign, and no sharing between ad sets (Meta requires the answer)");
  assert.equal(buildPlan({ profile, batch, kept, presets, settings: { campaign: { level: "campaign" } } }).campaign.is_adset_budget_sharing_enabled, undefined, "not sent with a campaign budget");
    assert.deepEqual(p.budget, { level: "adset", daily: 50, bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cap: null, per_day_total: 100 });
    const [bishan, amk] = p.adsets;
    assert.deepEqual([bishan.callout, bishan.ads, bishan.pin.label, bishan.pin.fallback, bishan.pin.radius_km, bishan.age_min, bishan.age_max, bishan.gender, bishan.preset.id, bishan.preset.how.startsWith("suggested: ran for men 14 times")], ["BISHAN", [ads[0].folder], "Bishan", false, 3, 25, 60, "men", "broad", true]);
    assert.deepEqual([amk.callout, amk.ads.length, amk.pin.label, amk.pin.fallback], ["ANG MO KIO", 2, "Sin Ming", true]);
    assert.ok(p.warnings.some((w) => /ANG MO KIO: no pin names this callout, so the first pin \(Sin Ming\) is used/.test(w)), p.warnings.join("\n"));
    assert.ok(p.warnings.some((w) => /2 of 3 ads have no Stories version/.test(w)));
    assert.ok(p.warnings.some((w) => /placeholder words for the primary text, headline, description/.test(w)));
    assert.equal(bishan.name, "0913 Bishan | 12 Week Total Body Reset | Audience: Bishan + 3KM, Male, Broad, 25-60", "the house naming: the audience in the name, for the reports");
    assert.deepEqual(bishan.payload.targeting, { geo_locations: { custom_locations: [{ latitude: 1.35, longitude: 103.85, radius: 3, distance_unit: "kilometer" }], location_types: ["home", "recent"] }, age_min: 25, age_max: 60, genders: [1], targeting_automation: { advantage_audience: 0 } });
    assert.deepEqual(amk.payload.targeting.geo_locations, { places: [{ key: "107327800879305", radius: 5, distance_unit: "kilometer" }], location_types: ["home", "recent"] });
    assert.deepEqual([bishan.payload.daily_budget, bishan.payload.bid_strategy, bishan.payload.optimization_goal, bishan.payload.status, bishan.payload.regional_regulated_categories, bishan.payload.attribution_spec], [5000, "LOWEST_COST_WITHOUT_CAP", "LEAD_GENERATION", "PAUSED", ["SINGAPORE_UNIVERSAL"], [{ event_type: "CLICK_THROUGH", window_days: 1 }]]);
    // The ads: two images by placement with a Stories version, the 1:1 alone without; the form on the button; the identity; every enhancement opted out.
    const withStory = p.ads[0], without = p.ads[1];
    assert.deepEqual([withStory.adset, withStory.story.file, withStory.name], ["BISHAN", "101-x/9x16/s.png", `0913 Bishan | 12 Week Total Body Reset | Image: ${ads[0].folder}`]);
    const afs = withStory.creative.asset_feed_spec;
    assert.deepEqual(afs.images, [{ hash: "(1:1 hash)", adlabels: [{ name: "square" }] }, { hash: "(9:16 hash)", adlabels: [{ name: "story" }] }]);
    assert.deepEqual(afs.asset_customization_rules, PLACEMENT_RULES("square", "story"));
    assert.deepEqual([afs.asset_customization_rules[0].customization_spec.facebook_positions, afs.asset_customization_rules[0].customization_spec.instagram_positions, afs.asset_customization_rules[0].image_label.name, afs.asset_customization_rules[1].image_label.name, afs.asset_customization_rules[1].customization_spec], [["story", "facebook_reels"], ["story", "reels"], "story", "square", { age_min: 13, age_max: 65 }], "the 9:16 on Stories and Reels, the 1:1 everywhere else");
    assert.deepEqual([afs.call_to_action_types, afs.call_to_actions, afs.link_urls, afs.ad_formats, afs.optimization_type], [["SIGN_UP"], [{ type: "SIGN_UP", value: { lead_gen_form_id: "4001" } }], [{ website_url: "https://sculptsociety.com.sg" }], ["SINGLE_IMAGE"], "PLACEMENT"]);
    assert.deepEqual(withStory.creative.object_story_spec, { page_id: "77", instagram_user_id: "88" });
    assert.deepEqual([withStory.creative.contextual_multi_ads, without.creative.contextual_multi_ads], [{ enroll_status: "OPT_OUT" }, { enroll_status: "OPT_OUT" }], "multi-advertiser ads never, on both creative shapes");
    assert.ok(Object.keys(withStory.creative.degrees_of_freedom_spec.creative_features_spec).length >= 12);
    assert.equal(without.creative.asset_feed_spec, undefined); assert.deepEqual([without.creative.object_story_spec.link_data.image_hash, without.creative.object_story_spec.link_data.call_to_action], ["(1:1 hash)", { type: "SIGN_UP", value: { lead_gen_form_id: "4001" } }]);
    assert.match(afs.bodies[0].text, /^\[PLACEHOLDER primary text\]/); assert.deepEqual(p.words.placeholders, ["primary text", "headline", "description"]);
    // The owner's settings for this campaign win: a campaign budget with a cost cap, a name, a pin and preset per ad set, real words, another form and no Instagram.
    const s = buildPlan({ profile, batch, kept, presets, settings: {
      campaign: { name: "Men Sept", level: "campaign", daily: 80, bid_strategy: "COST_CAP", bid_cap: 15 },
      adsets: { "ANG MO KIO": { pin: 1, radius_km: 7, age_min: 30, age_max: 50, gender: "all", preset: "a97f701a193c", daily: 999 } },
      words: { message: "Join the reset.", headline: "12 weeks", description: "Bishan and AMK", cta: "APPLY_NOW" },
      destination: { lead_form_id: "4002", instagram_user_id: "" } } });
    assert.deepEqual([s.campaign.name, s.campaign.daily_budget, s.campaign.bid_strategy, s.budget.per_day_total, s.adsets[0].budget, s.adsets[0].payload.daily_budget, s.adsets[0].payload.bid_amount], ["Men Sept", 8000, "COST_CAP", 80, null, undefined, 1500], "a campaign budget: on the campaign, the cap as bid_amount on the ad sets");
    const a2 = s.adsets[1];
    assert.deepEqual([a2.pin.label, a2.pin.radius_km, a2.age_min, a2.age_max, a2.gender, a2.preset.id, a2.preset.how, a2.payload.targeting.genders, a2.payload.targeting.flexible_spec], ["Bishan", 7, 30, 50, "all", "a97f701a193c", "chosen for this ad set", undefined, [{ interests: [{ id: "6003101323797", name: "Fatherhood" }] }]]);
    assert.deepEqual([s.words.message, s.words.cta, s.words.placeholders, s.lead_form_id, s.instagram_user_id], ["Join the reset.", "APPLY_NOW", [], "4002", null]);
    assert.deepEqual(s.ads[0].creative.asset_feed_spec.call_to_actions, [{ type: "APPLY_NOW", value: { lead_gen_form_id: "4002" } }]); assert.deepEqual(s.ads[0].creative.object_story_spec, { page_id: "77" });
    assert.ok(s.warnings.some((w) => /no Instagram account chosen/.test(w)) && !s.warnings.some((w) => /placeholder/.test(w)));
    // Problems stop it: no kept ads, no form, no website, a cap without an amount, too many ads in one ad set, an unusable pin.
    const bad = buildPlan({ profile: { ...profile, website: "", meta_assets: { ...profile.meta_assets, lead_form_id: "" }, targeting_defaults: { geo: { radius_pins: [{ label: "code only", postal_code: "575583" }] } } }, batch, kept: [], presets, settings: { campaign: { bid_strategy: "COST_CAP" } } });
    assert.equal(bad.ready, false);
    for (const re of [/no lead form chosen/, /external website/, /Cost per result goal needs an amount/, /no ads kept/]) assert.ok(bad.problems.some((x) => re.test(x)), `${re} in ${bad.problems.join(" | ")}`);
    const many = buildPlan({ profile, batch, kept: Array.from({ length: ADS_PER_ADSET_CAP + 1 }, (_, i) => ({ folder: `f${i}`, file: `f${i}/1x1/a.png`, location: "BISHAN", words: ads[0].words, story: null })), presets });
    assert.ok(many.problems.some((x) => /51 ads in one ad set; Meta allows 50/.test(x)));
    const pinless = buildPlan({ profile: { ...profile, targeting_defaults: { geo: { radius_pins: [{ label: "code only", postal_code: "575583" }] } } }, batch, kept, presets });
    assert.ok(pinless.problems.some((x) => /BISHAN: no usable pin/.test(x)));
    assert.ok(Object.keys(CTA_TYPES).includes("SIGN_UP") && campaignWords(profile, { offer: "X" }, { cta: "NOPE" }).cta === "SIGN_UP");
    assert.equal(creativeFor({ name: "n", page_id: "77", website: "https://x.sg", form_id: "1", words: { message: "m", headline: "h", description: "d", cta: "SIGN_UP" }, story: false }).object_story_spec.instagram_user_id, undefined);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("M7 createPlan: images once per file by content, the campaign, the ad sets a run needs, then each ad's creative and ad — every id recorded as it lands; a re-run reuses everything and makes nothing; changed words make a new creative and ad with the old ones kept as superseded; a changed ad set is updated in place; `first` limits a run and the next continues; a refusal stops with its step recorded; a plan with problems is refused before any call", async () => {
  const { buildPlan, createPlan, freshRecord } = await import("./meta-publish.mjs");
  const d = mkdtempSync(join(tmpdir(), "meta-create-"));
  try {
    const png = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);
    const ads = [];
    for (const [n, loc] of [["101", "BISHAN"], ["102", "BISHAN"], ["103", "ANG MO KIO"]]) {
      mkdirSync(join(d, `${n}-x`, "1x1"), { recursive: true }); mkdirSync(join(d, `${n}-x`, "9x16"), { recursive: true });
      writeFileSync(join(d, `${n}-x`, "1x1", "a.png"), png(+n)); if (n !== "103") writeFileSync(join(d, `${n}-x`, "9x16", "s.png"), png(+n + 50));
      ads.push({ folder: `${n}-c-${loc.toLowerCase().replace(/ /g, "-")}`, file: `${n}-x/1x1/a.png`, location: loc, words: { location: loc, audience: "MEN WANTED", offer: "12 Week Total Body Reset" }, story: n !== "103" ? `${n}-x/9x16/s.png` : null });
    }
    // The same 1:1 twice (two ads sharing a photo): uploaded once.
    writeFileSync(join(d, "102-x", "1x1", "a.png"), png(101));
    const profile = { display_name: "Sculpt Society", gym_abbr: "SCS", website: "https://sculptsociety.com.sg", locale: { country: "SG", currency: "SGD" },
      meta_assets: { ad_account_id: "act_111", page_id: "77", instagram_user_id: "88", lead_form_id: "4001", singapore_beneficiary_id: "4260400000000001", singapore_payer_id: "4260400000000001" },
      campaign_defaults: { budget: { level: "adset", amount: 50, currency: "SGD" } }, targeting_defaults: { geo: { radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", radius_km: 5 }] }, demographics: { age_min: 25, age_max: 60 } } };
    const batch = { batch_id: "2026-09-13-men" };
    let n = 0; const calls = [];
    const refuse = { creative: null };
    Object.assign(answers, {
      "act_111/adimages": (q) => { calls.push(["adimages", q.get("name")]); return { images: { [q.get("name")]: { hash: "h" + q.get("name").slice(-9, -4) } } }; },
      "act_111/campaigns": (q) => { calls.push(["campaigns", q.get("name")]); return { id: "c" + ++n }; },
      "act_111/adsets": (q) => { calls.push(["adsets", q.get("name")]); return { id: "s" + ++n }; },
      "act_111/adcreatives": (q) => { calls.push(["adcreatives", JSON.parse(q.get("asset_feed_spec") || "null")?.images?.map((i) => i.hash) || JSON.parse(q.get("object_story_spec")).link_data.image_hash]); return { id: "cr" + ++n }; },
      "act_111/ads": (q) => { calls.push(["ads", q.get("adset_id"), JSON.parse(q.get("creative")).creative_id]); return { id: "ad" + ++n }; },
      "c1": (q) => { calls.push(["update c1", [...q.keys()].filter((k) => !/access_token|appsecret_proof/.test(k)).join(",")]); return { success: true }; },
      "s2": (q) => { calls.push(["update s2", [...q.keys()].filter((k) => !/access_token|appsecret_proof/.test(k)).join(",")]); return { success: true }; },
    });
    errorHook = (path) => (path === "act_111/adcreatives" && refuse.creative ? { error: { message: refuse.creative, code: 100 } } : null);
    const path = join(d, "publish.json");
    const log = [];
    const plan = buildPlan({ profile, batch, kept: ads, presets: { presets: [] } });
    // 1. The first two ads only: their images (three files, one shared), the campaign, BISHAN's ad set alone, two creatives and ads.
    const rec = freshRecord(path, { batch_id: batch.batch_id, account: "act_111" });
    const r1 = await createPlan(plan, { client: client(), batchDir: d, record: rec, first: 2, log: (m) => log.push(m) });
    assert.deepEqual(calls.map((c) => c[0]), ["campaigns", "adsets", "adimages", "adimages", "adcreatives", "ads", "adimages", "adcreatives", "ads"], "images on demand, once per content; only the ad set the run needs");
    assert.deepEqual([r1.run.made, r1.run.reused, r1.ads, r1.of, r1.url], [{ images: 3, campaign: 1, adsets: 1, creatives: 2, ads: 2 }, { images: 1, campaign: 0, adsets: 0, ads: 0 }, 2, 3, "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=111&selected_campaign_ids=c1"]);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual([onDisk.campaign.id, Object.keys(onDisk.adsets), Object.keys(onDisk.ads), onDisk.done, onDisk.error, onDisk.runs.length, Object.keys(onDisk.images).length], ["c1", ["BISHAN"], [ads[0].folder, ads[1].folder], null, null, 1, 3]);
    assert.equal(calls.filter((c) => c[0] === "adcreatives")[0][1].length, 2, "the first creative carries the 1:1 and the 9:16");
    assert.equal(calls.filter((c) => c[0] === "ads")[0][1], "s2", "the ad sits in BISHAN's ad set");
    // 2. Continue: the third ad only (its 1:1 alone), ANG MO KIO's ad set made now; everything else reused; the record complete.
    calls.length = 0;
    const r2 = await createPlan(plan, { client: client(), batchDir: d, record: { ...JSON.parse(readFileSync(path, "utf-8")), path }, log: (m) => log.push(m) });
    assert.deepEqual(calls.map((c) => c[0]), ["adsets", "adimages", "adcreatives", "ads"]);
    assert.equal(typeof calls[2][1], "string", "the third ad's creative is the 1:1 alone");
    assert.deepEqual([r2.run.made, r2.run.reused.ads, r2.run.reused.images, r2.ads, JSON.parse(readFileSync(path, "utf-8")).done != null], [{ images: 1, campaign: 0, adsets: 1, creatives: 1, ads: 1 }, 2, 4, 3, true], "the two done ads' four images are looked up and found, the third's uploaded");
    // 3. A re-run makes nothing at all.
    calls.length = 0;
    const r3 = await createPlan(plan, { client: client(), batchDir: d, record: { ...JSON.parse(readFileSync(path, "utf-8")), path }, log: () => {} });
    assert.deepEqual([calls, r3.run.made.ads, r3.run.reused.ads, r3.run.reused.campaign, r3.run.reused.adsets], [[], 0, 3, 1, 2]);
    // 4. New words: every ad gets a new creative and ad, the old kept as superseded; a changed ad set is updated in place; the campaign's new name too.
    calls.length = 0;
    const plan2 = buildPlan({ profile, batch, kept: ads, presets: { presets: [] }, settings: { campaign: { name: "Men Sept" }, adsets: { BISHAN: { age_max: 55 } }, words: { message: "Real words now.", headline: "Twelve weeks", description: "Sin Ming" } } });
    const r4 = await createPlan(plan2, { client: client(), batchDir: d, record: { ...JSON.parse(readFileSync(path, "utf-8")), path }, log: () => {} });
    assert.deepEqual(calls.map((c) => c[0]), ["update c1", "update s2", "adcreatives", "ads", "adcreatives", "ads", "adcreatives", "ads"], "no image uploaded again; the campaign and the changed ad set updated; three new creatives and ads");
    assert.deepEqual([calls[0][1], calls[1][1].split(",").sort()], ["name", ["daily_budget", "bid_strategy", "name", "targeting"].sort()]);
    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual([r4.run.superseded, after.superseded.length, after.superseded.map((x) => x.folder).sort(), Object.keys(after.ads).length, after.campaign.name, after.adsets.BISHAN.updated != null, after.adsets["ANG MO KIO"].updated], [3, 3, ads.map((a) => a.folder).sort(), 3, "Men Sept", true, undefined]);
    assert.ok(after.superseded.every((x) => x.id && x.why));
    // 5. A refusal at the creative: the run stops there, the step and the ad recorded, everything before it kept.
    calls.length = 0; refuse.creative = "Invalid parameter — the form is not one of this Page's";
    const plan3 = buildPlan({ profile, batch, kept: ads, presets: { presets: [] }, settings: { words: { message: "Third words." } } });
    const rec5 = { ...JSON.parse(readFileSync(path, "utf-8")), path };
    await assert.rejects(createPlan(plan3, { client: client(), batchDir: d, record: rec5, log: () => {} }), /form is not one of this Page's/);
    const stopped = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual([stopped.error.step, stopped.error.what, Object.keys(stopped.ads).length, stopped.superseded.length, stopped.done], ["creative", ads[0].folder, 2, 4, null], "the first ad was superseded and its new creative refused; the other two untouched");
    refuse.creative = null;
    // 6. A plan with problems is refused before any call; a record for another account is refused by the CLI (tested by shape here).
    calls.length = 0;
    await assert.rejects(createPlan({ ...plan, ready: false, problems: ["no ads kept"] }, { client: client(), batchDir: d, record: freshRecord(join(d, "x.json"), { batch_id: "b", account: "act_111" }) }), /the plan has problems: no ads kept/);
    assert.deepEqual(calls, []);
    assert.ok(!readFileSync(path, "utf-8").includes(TOKEN));
  } finally {
    errorHook = errorFor;
    for (const k of ["act_111/adimages", "act_111/campaigns", "act_111/adsets", "act_111/adcreatives", "act_111/ads", "c1", "s2"]) delete answers[k];
    rmSync(d, { recursive: true, force: true });
  }
});
