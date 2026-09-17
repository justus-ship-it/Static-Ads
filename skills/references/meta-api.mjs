/**
 * meta-api.mjs — the Meta Marketing API, read-only for now (E1: the Meta link).
 *
 * What it does: with Strategym's system-user token it says who the token is, lists the ad accounts,
 * Pages (with their Instagram accounts) and business portfolios it can act on, and for one gym's
 * profile resolves the chosen ids into names, currency, status, lead forms and pixels — so the owner
 * picks from lists in the panel instead of typing ids, and sees at once whether the link works.
 * Nothing here writes to Meta. Publishing (campaigns, ad sets, ads — created PAUSED) is E2/E3.
 *
 * Credentials live in .env only (META_ACCESS_TOKEN, META_APP_ID, META_APP_SECRET); every call
 * carries appsecret_proof; no token ever reaches a log, an error message or a profile file.
 * META_GRAPH_URL overrides the endpoint (tests point it at a fake).
 *
 *   node skills/references/meta-api.mjs --check                 who the token is, what it can act on
 *   node skills/references/meta-api.mjs --check --gym sculpt-society   plus that gym's chosen assets
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHmac } from "crypto";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Pinned: v25.0 (February 2026). Bump deliberately, with the changelog read. */
export const META_API_VERSION = "v25.0";
export const META_ENV_KEYS = ["META_ACCESS_TOKEN", "META_APP_ID", "META_APP_SECRET"];
/** The permissions the system-user token needs for the link and, later, for publishing. */
export const META_PERMISSIONS = ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads"];
export const ACCOUNT_STATUS = { 1: "active", 2: "disabled", 3: "unsettled", 7: "pending risk review", 8: "pending settlement", 9: "in grace period", 100: "pending closure", 101: "closed", 201: "any active", 202: "any closed" };

/** The .env key names for one gym: `META_ACCESS_TOKEN_SCULPT_SOCIETY` and so on (the gym's slug, upper-cased,
 *  hyphens as underscores). One Meta app links to one business portfolio, and every client has its own, so
 *  every gym can carry its own app id, secret and system-user token; a key without a suffix is shared by the
 *  gyms that have none of their own. */
export const metaKeySuffix = (gym) => (gym ? "_" + String(gym).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") : "");
export const metaKeyNames = (gym) => Object.fromEntries(META_ENV_KEYS.map((k) => [k, k + metaKeySuffix(gym)]));

/** .env values for the Meta keys of one gym: its own suffixed keys first, the shared ones after; the
 *  environment wins over the file for a given name (a key set to "" there means "none", for tests). */
export function metaConfig({ env = process.env, envFile = join(REPO_ROOT, ".env"), gym = null } = {}) {
  const file = {};
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf-8").split("\n")) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) file[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
  const placeholder = (v) => !v || /^your-/i.test(v) || /^(\.\.\.|…|paste-here)$/.test(v);
  const one = (name) => { const v = env[name] !== undefined ? env[name] : file[name] || ""; return placeholder(v) ? "" : v; };
  const names = metaKeyNames(gym), used = {};
  const get = (k) => { for (const name of [...new Set([names[k], k])]) { const v = one(name); if (v) { used[k] = name; return v; } } used[k] = null; return ""; };
  const token = get("META_ACCESS_TOKEN"), appId = get("META_APP_ID"), appSecret = get("META_APP_SECRET");
  return { token, appId, appSecret, graphUrl: one("META_GRAPH_URL") || "https://graph.facebook.com", gym: gym || null, names, used };
}

/** Meta's proof that the caller holds the app secret, sent with every call. */
export const appsecretProof = (token, secret) => createHmac("sha256", secret).update(token).digest("hex");

/** Anything that looks like a token, out of a message before it is shown or logged. */
export const scrubTokens = (s) => String(s).replace(/EAA[A-Za-z0-9]{20,}/g, "[token]").replace(/access_token=[^&\s"']+/g, "access_token=[token]");

export class MetaError extends Error {
  constructor(message, { code = null, subcode = null, type = null, status = null, trace = null, path = null } = {}) {
    super(scrubTokens(message));
    this.name = "MetaError"; this.code = code; this.subcode = subcode; this.type = type; this.status = status; this.trace = trace; this.path = path;
  }
}

/** Meta's error, in words the owner can act on. */
export function explainError(err, path = "") {
  const code = err?.code, sub = err?.error_subcode, msg = scrubTokens(err?.message || "unknown error");
  if (code === 190) return `the Meta token is invalid or has expired (${msg}) — generate a new system-user token and put it in .env`;
  if (code === 10 || code === 200 || (code >= 200 && code <= 299)) return `the token is not allowed to do this (${msg}) — the system user needs ${METAPERMS_TEXT} and the asset assigned to it`;
  if (code === 4 || code === 17 || code === 32 || code === 613) return `Meta is rate-limiting these calls (${msg}) — wait a few minutes and check again`;
  if (code === 100) return `Meta did not accept the request${path ? ` to ${path}` : ""} (${msg})${err?.error_user_msg ? "" : " — a field or an id may be wrong"}`;
  if (code === 803) return `Meta knows no object with that id${path ? ` (${path})` : ""} — the id in the profile may be wrong, or the asset is not assigned to the system user`;
  return `Meta answered with an error${path ? ` for ${path}` : ""}: ${msg}${code != null ? ` (code ${code}${sub != null ? `/${sub}` : ""})` : ""}`;
}
const METAPERMS_TEXT = META_PERMISSIONS.join(", ");

/**
 * A Graph API client. `fetch` is injectable; `config` comes from metaConfig(). Every GET carries the
 * token and appsecret_proof; paging is followed up to `maxPages`; errors become MetaError with the
 * explanation above and never carry the token.
 */
export function graphClient({ config = metaConfig(), fetch: f = globalThis.fetch, maxPages = 10 } = {}) {
  if (!config.token) throw new MetaError("no META_ACCESS_TOKEN in .env — the Meta link is not set up yet");
  const base = `${config.graphUrl.replace(/\/$/, "")}/${META_API_VERSION}`;
  const auth = (token = config.token) => ({ access_token: token, ...(config.appSecret ? { appsecret_proof: appsecretProof(token, config.appSecret) } : {}) });
  async function get(path, params = {}, { token } = {}) {
    const url = new URL(`${base}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries({ ...params, ...auth(token) })) if (v !== undefined && v !== null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    let res, body;
    try { res = await f(url.href, { headers: { accept: "application/json" } }); } catch (e) { throw new MetaError(`could not reach Meta (${scrubTokens(e.message)})`, { path }); }
    try { body = await res.json(); } catch { throw new MetaError(`Meta answered ${res.status} with something that is not JSON`, { status: res.status, path }); }
    if (!res.ok || body?.error) {
      const e = body?.error || {};
      throw new MetaError(explainError(e, path), { code: e.code ?? null, subcode: e.error_subcode ?? null, type: e.type ?? null, status: res.status, trace: e.fbtrace_id ?? null, path });
    }
    return body;
  }
  /** A write: form-encoded (objects as JSON), the token and proof in the body. Same errors as get. */
  async function post(path, params = {}, { token } = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...auth(token) })) if (v !== undefined && v !== null) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    let res, out;
    try { res = await f(`${base}/${path.replace(/^\//, "")}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() }); }
    catch (e) { throw new MetaError(`could not reach Meta (${scrubTokens(e.message)})`, { path }); }
    try { out = await res.json(); } catch { throw new MetaError(`Meta answered ${res.status} with something that is not JSON`, { status: res.status, path }); }
    if (!res.ok || out?.error) {
      const e = out?.error || {};
      throw new MetaError(explainError(e, path) + (e.error_user_msg ? ` — ${scrubTokens(e.error_user_msg)}` : ""), { code: e.code ?? null, subcode: e.error_subcode ?? null, type: e.type ?? null, status: res.status, trace: e.fbtrace_id ?? null, path });
    }
    return out;
  }
  /** Every item of a paged edge, page after page (never more than maxPages). */
  async function list(path, params = {}, opts = {}) {
    const out = [];
    let body = await get(path, { limit: 100, ...params }, opts), pages = 1;
    out.push(...(body.data || []));
    // Meta says "more" by sending paging.next; the last page has cursors but no next.
    while (body.paging?.next && body.paging?.cursors?.after && body.data?.length && pages < maxPages) {
      body = await get(path, { limit: 100, ...params, after: body.paging.cursors.after }, opts); pages++;
      out.push(...(body.data || []));
    }
    return out;
  }
  return {
    version: META_API_VERSION,
    get, list, post,
    me: () => get("me", { fields: "id,name" }),
    adAccounts: () => list("me/adaccounts", { fields: "id,account_id,name,currency,account_status,timezone_name,business{id,name}" }),
    pages: () => list("me/accounts", { fields: "id,name,category,instagram_business_account{id,username}" }),
    businesses: () => list("me/businesses", { fields: "id,name" }),
    adAccount: (id) => get(actId(id), { fields: "id,account_id,name,currency,account_status,timezone_name,business{id,name}" }),
    page: (id) => get(id, { fields: "id,name,category,instagram_business_account{id,username}" }),
    /** A Page's own token, for the edges that need one (its lead forms). Never stored. */
    pageToken: async (id) => (await get(id, { fields: "access_token" })).access_token,
    leadForms: async (pageId) => { const token = await get(pageId, { fields: "access_token" }).then((r) => r.access_token); return list(`${pageId}/leadgen_forms`, { fields: "id,name,status,created_time,leads_count" }, { token }); },
    pixels: (adAccountId) => list(`${actId(adAccountId)}/adspixels`, { fields: "id,name,last_fired_time" }),
    /** The verified advertiser identities the account's ad sets already carry for regulated regions
     *  (Singapore: the beneficiary and payer of every ad). Meta has no listing edge for them that a
     *  system user can read, but every ad set that delivers in Singapore names them. */
    regulationIdentities: async (adAccountId) => {
      const sets = await list(`${actId(adAccountId)}/adsets`, { fields: "id,name,regional_regulated_categories,regional_regulation_identities", limit: 50 });
      const seen = new Map();
      for (const s of sets) {
        const ids = s.regional_regulation_identities || {};
        for (const cat of s.regional_regulated_categories || []) {
          const prefix = cat.toLowerCase(), ben = ids[`${prefix}_beneficiary`] || ids.universal_beneficiary, pay = ids[`${prefix}_payer`] || ids.universal_payer;
          if (!ben && !pay) continue;
          const key = `${cat}|${ben}|${pay}`;
          const cur = seen.get(key) || { category: cat, beneficiary: ben || null, payer: pay || null, adsets: 0, example: s.name };
          cur.adsets++; seen.set(key, cur);
        }
      }
      return [...seen.values()].sort((a, b) => b.adsets - a.adsets);
    },
  };
}
export const actId = (id) => (String(id).startsWith("act_") ? String(id) : `act_${id}`);
/** An id as the profile keeps it: digits (the ad account keeps its act_ prefix). */
const clean = (v) => (v == null ? "" : String(v).trim());

/**
 * The link, checked for one gym: who the token is, what it can act on, and the gym's chosen assets
 * resolved — with problems in words. Read-only. `client` is a graphClient (injectable).
 */
export async function checkLink(profile, { client, locale = null } = {}) {
  const m = profile?.meta_assets || {};
  const out = { version: client.version, me: null, accounts: [], pages: [], businesses: [], chosen: { account: null, page: null, instagram: null, forms: [], pixels: [] }, problems: [], warnings: [] };
  out.me = await client.me();
  out.accounts = (await client.adAccounts()).map(accountView);
  out.pages = (await client.pages()).map(pageView);
  try { out.businesses = await client.businesses(); } catch (e) { out.warnings.push(`business portfolios could not be listed: ${e.message}`); }
  const currency = locale?.currency || profile?.locale?.currency || null;
  const accountId = clean(m.ad_account_id), pageId = clean(m.page_id);
  if (accountId) {
    const mine = out.accounts.find((a) => a.id === actId(accountId));
    try {
      out.chosen.account = mine || accountView(await client.adAccount(accountId));
      if (!mine) out.warnings.push(`ad account ${actId(accountId)} is not among the accounts assigned to the system user — publishing to it will fail until it is`);
      if (currency && out.chosen.account.currency && out.chosen.account.currency !== currency) out.problems.push(`the ad account bills in ${out.chosen.account.currency}; the profile's budgets are in ${currency}`);
      if (out.chosen.account.status !== "active") out.problems.push(`the ad account is ${out.chosen.account.status || "in an unknown state"}`);
      try { out.chosen.pixels = await client.pixels(accountId); } catch (e) { out.warnings.push(`pixels could not be listed: ${e.message}`); }
      if (clean(m.pixel_id) && !out.chosen.pixels.some((p) => p.id === clean(m.pixel_id))) out.problems.push(`pixel ${m.pixel_id} is not one of the ad account's pixels`);
    } catch (e) { out.problems.push(`ad account: ${e.message}`); }
  }
  if (pageId) {
    const mine = out.pages.find((p) => p.id === pageId);
    try {
      out.chosen.page = mine || pageView(await client.page(pageId));
      if (!mine) out.warnings.push(`Page ${pageId} is not among the Pages assigned to the system user — publishing from it will fail until it is`);
      out.chosen.instagram = out.chosen.page.instagram || null;
      if (clean(m.instagram_actor_id) && out.chosen.instagram?.id !== clean(m.instagram_actor_id)) out.problems.push(`Instagram account ${m.instagram_actor_id} is not the one linked to this Page${out.chosen.instagram ? ` (${out.chosen.instagram.id}, @${out.chosen.instagram.username})` : ""}`);
      try { out.chosen.forms = await client.leadForms(pageId); } catch (e) { out.warnings.push(`lead forms could not be listed: ${e.message}`); }
      if (clean(m.lead_form_id)) {
        const form = out.chosen.forms.find((x) => x.id === clean(m.lead_form_id));
        if (!form) out.problems.push(`lead form ${m.lead_form_id} is not one of this Page's instant forms`);
        else if (form.status && form.status !== "ACTIVE") out.problems.push(`the lead form "${form.name}" is ${form.status.toLowerCase()}`);
      }
    } catch (e) { out.problems.push(`Page: ${e.message}`); }
  }
  if (clean(m.business_id) && out.businesses.length && !out.businesses.some((b) => b.id === clean(m.business_id))) out.warnings.push(`business portfolio ${m.business_id} is not one the token can see`);
  return out;
}
const accountView = (a) => ({ id: a.id, account_id: a.account_id, name: a.name, currency: a.currency, status: ACCOUNT_STATUS[a.account_status] || (a.account_status == null ? null : `status ${a.account_status}`), timezone: a.timezone_name || null, business: a.business ? { id: a.business.id, name: a.business.name } : null });
const pageView = (p) => ({ id: p.id, name: p.name, category: p.category || null, instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || null } : null });

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { check: { type: "boolean", default: false }, gym: { type: "string" }, json: { type: "boolean", default: false } } });
  if (!v.check) { console.error("Usage: meta-api.mjs --check [--gym <slug>] [--json]"); process.exit(1); }
  try {
    const config = metaConfig({ gym: v.gym || null });
    if (!config.token) { console.error(`No ${config.names.META_ACCESS_TOKEN}${v.gym ? " (or META_ACCESS_TOKEN)" : ""} in .env. The panel's Meta link page says how to set it up.`); process.exit(2); }
    if (!config.appSecret) console.error("note: no app secret in .env — calls go without appsecret_proof (Meta may refuse them if the app requires it)");
    const client = graphClient({ config });
    const profile = v.gym ? JSON.parse(readFileSync(join(REPO_ROOT, "brands", v.gym, "gym-profile.json"), "utf-8")) : {};
    const r = await checkLink(profile, { client });
    if (v.json) { console.log(JSON.stringify({ keys: config.used, ...r }, null, 2)); process.exit(0); }
    console.log(`Meta ${r.version} · keys ${config.used.META_ACCESS_TOKEN}, ${config.used.META_APP_ID || "(no app id)"}, ${config.used.META_APP_SECRET || "(no app secret)"} · token is "${r.me.name}" (${r.me.id})`);
    console.log(`Ad accounts (${r.accounts.length}):`); for (const a of r.accounts) console.log(`  ${a.id}  ${a.name}  ${a.currency}  ${a.status}${a.business ? `  · ${a.business.name}` : ""}`);
    console.log(`Pages (${r.pages.length}):`); for (const p of r.pages) console.log(`  ${p.id}  ${p.name}${p.instagram ? `  · IG @${p.instagram.username} (${p.instagram.id})` : "  · no Instagram account linked"}`);
    if (r.businesses.length) { console.log(`Business portfolios (${r.businesses.length}):`); for (const b of r.businesses) console.log(`  ${b.id}  ${b.name}`); }
    if (v.gym) {
      console.log(`\n${v.gym}:`);
      console.log(`  ad account: ${r.chosen.account ? `${r.chosen.account.id} ${r.chosen.account.name} (${r.chosen.account.currency}, ${r.chosen.account.status})` : "not chosen"}`);
      console.log(`  Page: ${r.chosen.page ? `${r.chosen.page.id} ${r.chosen.page.name}` : "not chosen"}${r.chosen.instagram ? ` · IG @${r.chosen.instagram.username}` : ""}`);
      console.log(`  lead forms: ${r.chosen.forms.map((f) => `${f.id} "${f.name}" (${f.status})`).join("; ") || "none listed"}`);
      console.log(`  pixels: ${r.chosen.pixels.map((p) => `${p.id} "${p.name}"`).join("; ") || "none listed"}`);
    }
    for (const w of r.warnings) console.log(`warning: ${w}`);
    for (const p of r.problems) console.log(`PROBLEM: ${p}`);
    process.exit(r.problems.length ? 3 : 0);
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
