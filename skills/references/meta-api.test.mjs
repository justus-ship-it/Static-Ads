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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "act_111": () => ({ id: "act_111", account_id: "111", name: "Sculpt Society Ads", currency: "SGD", account_status: 1 }),
  "act_333": () => ({ id: "act_333", account_id: "333", name: "Foreign account", currency: "USD", account_status: 1 }),
};
const errorFor = (path) => null;
let errorHook = errorFor;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname.replace(`/${META_API_VERSION}/`, "");
    calls.push({ path, q: u.searchParams, version: u.pathname.split("/")[1] });
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
  const profile = { locale: { currency: "SGD" }, meta_assets: { ad_account_id: "act_111", page_id: "77", instagram_actor_id: "88", pixel_id: "6001", lead_form_id: "4001", business_id: "555" } };
  const r = await checkLink(profile, { client: client() });
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
  const bad = await checkLink({ locale: { currency: "SGD" }, meta_assets: { ad_account_id: "act_333", page_id: "77", instagram_actor_id: "89", pixel_id: "6009", lead_form_id: "4002", business_id: "123" } }, { client: client() });
  assert.ok(bad.problems.some((p) => /bills in USD; the profile's budgets are in SGD/.test(p)), bad.problems.join("\n"));
  assert.ok(bad.problems.some((p) => /pixel 6009 is not one of the ad account's pixels/.test(p)));
  assert.ok(bad.problems.some((p) => /lead form "Old form" is archived/.test(p)));
  assert.ok(bad.problems.some((p) => /Instagram account 89 is not the one linked to this Page \(88, @sculptsociety\)/.test(p)));
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
  assert.deepEqual(none.chosen, { account: null, page: null, instagram: null, forms: [], pixels: [] });
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
