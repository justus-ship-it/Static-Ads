/**
 * meta-results.mjs — what a published batch is doing on Meta, and the table that ties every result to
 * everything the batch knew about the ad: its photo and scene, layout, style, palette, words, callout,
 * pin, ages, gender, targeting preset, budget, form, copy. The table is what the iteration loop reads.
 *
 *   outputs/{batch}/results.json   — the last pull: statuses and insights per campaign, ad set and ad
 *   brands/{gym}/results.csv       — every published ad of every batch, one row each (rebuilt on demand)
 *
 * `pullResults` is the only thing here that calls Meta (read-only: statuses, all-time and last-7-day
 * insights at ad level, the campaign's daily spend and leads for the last 30 days). Everything else
 * joins files on disk.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { metaConfig, graphClient, scrubTokens, actId } from "./meta-api.mjs";
import { audienceLabel, summarise, adsetCountries, isAbroad } from "./meta-targeting.mjs";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const num = (v) => (v == null || v === "" ? 0 : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;

/** Meta's effective statuses in words. */
export const STATUS_WORDS = {
  ACTIVE: "live", PAUSED: "paused", CAMPAIGN_PAUSED: "paused with its campaign", ADSET_PAUSED: "paused with its ad set", DELETED: "deleted", ARCHIVED: "archived",
  IN_PROCESS: "in Meta's review", WITH_ISSUES: "has issues", PENDING_REVIEW: "pending review", DISAPPROVED: "disapproved", PREAPPROVED: "pre-approved", PENDING_BILLING_INFO: "waiting for billing details",
};
export const statusWords = (s) => STATUS_WORDS[s] || (s ? String(s).toLowerCase().replace(/_/g, " ") : "unknown");

/** One insights row → the numbers we keep. `lead` is Meta's count of instant-form leads. */
export function metrics(r) {
  const act = (name) => num((r?.actions || []).find((a) => a.action_type === name)?.value);
  const spend = num(r?.spend), impressions = num(r?.impressions), clicks = num(r?.inline_link_clicks ?? r?.clicks), leads = act("lead");
  return {
    spend: round2(spend), impressions, reach: num(r?.reach), clicks, leads,
    cost_per_lead: leads ? round2(spend / leads) : null, ctr: impressions ? round2((clicks / impressions) * 100) : null, cpm: impressions ? round2((spend / impressions) * 1000) : null,
    from: r?.date_start || null, to: r?.date_stop || null,
  };
}
const EMPTY = () => metrics(null);

/** Pull the campaign's statuses and numbers from Meta into results.json (2–5 read-only calls). */
export async function pullResults({ client, record, batchDir, now = new Date().toISOString() }) {
  const cid = record?.campaign?.id;
  if (!cid) throw new Error("this batch has not been created on Meta yet");
  const fields = "ad_id,adset_id,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start,date_stop";
  const [campaign, adsets, ads, allTime, week, daily] = await Promise.all([
    client.get(cid, { fields: "id,name,status,effective_status,daily_budget,updated_time" }),
    client.list(`${cid}/adsets`, { fields: "id,name,status,effective_status,daily_budget" }),
    client.list(`${cid}/ads`, { fields: "id,name,status,effective_status,adset_id,updated_time" }),
    client.list(`${cid}/insights`, { level: "ad", fields, date_preset: "maximum" }),
    client.list(`${cid}/insights`, { level: "ad", fields, date_preset: "last_7d" }),
    client.list(`${cid}/insights`, { level: "campaign", fields: "spend,actions,date_start", time_increment: 1, date_preset: "last_30d" }).catch(() => []),
  ]);
  const byAd = (rows) => Object.fromEntries(rows.map((r) => [r.ad_id, metrics(r)]));
  const all = byAd(allTime), last7 = byAd(week);
  const sum = (rows) => rows.reduce((t, m) => ({ spend: round2(t.spend + m.spend), impressions: t.impressions + m.impressions, reach: t.reach + m.reach, clicks: t.clicks + m.clicks, leads: t.leads + m.leads }), { spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0 });
  const finish = (s) => ({ ...s, cost_per_lead: s.leads ? round2(s.spend / s.leads) : null, ctr: s.impressions ? round2((s.clicks / s.impressions) * 100) : null });
  const out = {
    pulled: now,
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, effective_status: campaign.effective_status, words: statusWords(campaign.effective_status), daily_budget: campaign.daily_budget ? num(campaign.daily_budget) / 100 : null, all_time: finish(sum(Object.values(all))), last_7d: finish(sum(Object.values(last7))) },
    adsets: Object.fromEntries(adsets.map((s) => {
      const mine = ads.filter((a) => a.adset_id === s.id).map((a) => a.id);
      return [s.id, { id: s.id, name: s.name, status: s.status, effective_status: s.effective_status, words: statusWords(s.effective_status), daily_budget: s.daily_budget ? num(s.daily_budget) / 100 : null, ads: mine.length, all_time: finish(sum(mine.map((id) => all[id] || EMPTY()))), last_7d: finish(sum(mine.map((id) => last7[id] || EMPTY()))) }];
    })),
    ads: Object.fromEntries(ads.map((a) => [a.id, { id: a.id, name: a.name, adset_id: a.adset_id, status: a.status, effective_status: a.effective_status, words: statusWords(a.effective_status), updated: a.updated_time || null, all_time: all[a.id] || EMPTY(), last_7d: last7[a.id] || EMPTY() }])),
    daily: daily.map((r) => ({ date: r.date_start, ...(({ spend, leads }) => ({ spend, leads }))(metrics(r)) })),
  };
  writeWhole(join(batchDir, "results.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

/**
 * One row per ad this batch put on Meta: what it was (from batch.json, visuals.json, the publish record's
 * facts) and what it did (from the last pull). Ads superseded by a later creative are rows too, marked.
 */
export function batchRows(gymDir, batchId) {
  const out = join(gymDir, "outputs", batchId);
  const batch = readJson(join(out, "batch.json")), rec = readJson(join(out, "publish.json")), res = readJson(join(out, "results.json"));
  if (!batch || !rec?.campaign?.id) return [];
  const visuals = Object.fromEntries((readJson(join(out, "visuals.json"))?.visuals || []).map((v) => [v.id, v]));
  const photoOf = Object.fromEntries((batch.photos || []).map((p) => [p.id, p]));
  const byFolder = Object.fromEntries(batch.ads.map((a) => [a.folder, a]));
  const rows = [];
  const row = (folder, entry, superseded) => {
    const a = byFolder[folder]; if (!a) return;
    const set = rec.adsets?.[entry.adset] || {}, sf = set.facts || {}, af = entry.facts || {};
    const r = res?.ads?.[entry.id], s = res?.adsets?.[set.id];
    const scenes = a.photos.map((id) => visuals[id]?.scene_id || (photoOf[id]?.kind === "real" ? "real photo" : null)).filter(Boolean);
    const tags = a.photos.map((id) => visuals[id]?.tags).filter(Boolean);
    rows.push({
      source: "app", gym: gymDir.split("/").pop(), batch: batchId, folder, ad_id: entry.id, creative_id: entry.creative_id, adset_id: set.id || null, adset_name: set.name || null, campaign_id: rec.campaign.id, campaign: res?.campaign?.name || rec.campaign.name || batchId, campaign_status: res?.campaign?.words || null, published: entry.at || null, superseded,
      offer: a.words?.offer || null, location: a.words?.location || null, audience: a.words?.audience || null, callout: entry.adset || null,
      photos: a.photos.join("+"), scenes: scenes.join("+") || null, exercise: tags.map((t) => t.exercise).filter(Boolean).join("+") || null, age_tag: tags.map((t) => t.age).filter(Boolean).join("+") || null, setting: tags.map((t) => t.setting).filter(Boolean).join("+") || null, equipment: tags.map((t) => t.equipment).filter(Boolean).join("+") || null,
      layout: a.treatment, style: a.style, palette: a.palette, has_story: !!entry.hashes?.story,
      pin: sf.pin || null, radius_km: sf.radius_km ?? null, age_min: sf.age_min ?? null, age_max: sf.age_max ?? null, gender: sf.gender || null, preset: sf.preset || null, preset_id: sf.preset_id || null, daily_budget: sf.daily ?? null, budget_level: sf.level || null,
      form_id: af.form_id || null, cta: af.cta || null, headline: af.headline || null, primary_text: af.message || null, placeholder_words: af.placeholders ?? null,
      status: r?.words || (superseded ? "superseded" : "not pulled yet"), adset_status: s?.words || null,
      ...Object.fromEntries(Object.entries(r?.all_time || EMPTY()).filter(([k]) => !["from", "to"].includes(k))),
      leads_7d: r?.last_7d?.leads ?? null, spend_7d: r?.last_7d?.spend ?? null, pulled: res?.pulled || null,
    });
  };
  for (const [folder, entry] of Object.entries(rec.ads || {})) row(folder, entry, false);
  for (const old of rec.superseded || []) if (old.folder && old.id) row(old.folder, old, true);
  return rows;
}
/** Every published ad of every batch of a gym, the cheapest lead first, unpulled last. */
export function gymRows(gymDir) {
  const dir = join(gymDir, "outputs");
  if (!existsSync(dir)) return [];
  const rows = readdirSync(dir).filter((id) => existsSync(join(dir, id, "publish.json"))).sort().flatMap((id) => batchRows(gymDir, id));
  return rows.sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0));
}
export const CSV_COLUMNS = ["source", "gym", "batch", "countries", "abroad", "folder", "ad_id", "adset_id", "campaign_id", "published", "superseded", "status", "adset_status", "offer", "location", "audience", "callout", "photos", "scenes", "exercise", "age_tag", "setting", "equipment", "layout", "style", "palette", "has_story", "pin", "radius_km", "age_min", "age_max", "gender", "preset", "preset_id", "daily_budget", "budget_level", "form_id", "cta", "headline", "primary_text", "placeholder_words", "spend", "impressions", "reach", "clicks", "leads", "cost_per_lead", "ctr", "cpm", "spend_7d", "leads_7d", "pulled"];
const cell = (v) => { if (v == null) return ""; const s = Array.isArray(v) ? v.join("|") : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function resultsCsv(rows) { return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((k) => cell(r[k])).join(","))].join("\n") + "\n"; }
/** The gym's results.csv on disk, rebuilt from every batch. */
export function writeGymCsv(gymDir) { const rows = gymRows(gymDir); writeWhole(join(gymDir, "results.csv"), resultsCsv(rows)); return rows; }

// ── the account's history: every campaign, ad set and ad it ran before (or beside) this app ─────────
const HISTORY = "account-history.json", COPY_REFS = "copy-references.json";
const CDN_HOSTS = /^https:\/\/[a-z0-9.-]+\.(fbcdn\.net|facebook\.com|xx\.fbcdn\.net)\//i;
const gender = (t) => (!t?.genders?.length ? "all" : t.genders.includes(1) && !t.genders.includes(2) ? "men" : t.genders.includes(2) && !t.genders.includes(1) ? "women" : "all");
const geoWords = (g) => [...(g?.places || []).map((p) => `${p.name || p.key} +${p.radius}km`), ...(g?.custom_locations || []).map((p) => `${p.latitude},${p.longitude} +${p.radius}km`), ...(g?.cities || []).map((c) => c.name), ...(g?.countries || [])].join("; ") || null;
/** The account's campaigns, ad sets and ads with their creatives and all-time numbers → brands/{gym}/account-history.json (read-only, ~6 calls). */
export async function pullAccountHistory({ client, accountId, gymDir, now = new Date().toISOString(), home = null }) {
  const acct = actId(accountId);
  home = home || readJson(join(gymDir, "gym-profile.json"))?.locale?.country || "SG";
  const [campaigns, adsets, ads, allTime, month] = await Promise.all([
    client.list(`${acct}/campaigns`, { fields: "id,name,status,effective_status,objective,created_time,daily_budget", limit: 100 }),
    client.list(`${acct}/adsets`, { fields: "id,name,campaign_id,status,effective_status,daily_budget,created_time,targeting{genders,age_min,age_max,flexible_spec,exclusions,custom_audiences,excluded_custom_audiences,geo_locations}", limit: 100 }),
    client.list(`${acct}/ads`, { fields: "id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id,object_type,thumbnail_url,image_hash,video_id,body,title,object_story_spec,asset_feed_spec{images,videos,bodies,titles,call_to_actions}}", limit: 100 }),
    client.list(`${acct}/insights`, { level: "ad", fields: "ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start,date_stop", date_preset: "maximum", limit: 100 }),
    client.list(`${acct}/insights`, { level: "ad", fields: "ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start,date_stop", date_preset: "last_30d", limit: 100 }).catch(() => []),
  ]);
  const all = Object.fromEntries(allTime.map((r) => [r.ad_id, metrics(r)])), last30 = Object.fromEntries(month.map((r) => [r.ad_id, metrics(r)]));
  const setOf = Object.fromEntries(adsets.map((s) => [s.id, s])), campOf = Object.fromEntries(campaigns.map((c) => [c.id, c]));
  const out = {
    pulled: now, account: acct,
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, effective_status: c.effective_status, words: statusWords(c.effective_status), objective: c.objective || null, created: (c.created_time || "").slice(0, 10), daily_budget: c.daily_budget ? num(c.daily_budget) / 100 : null })),
    adsets: adsets.map((s) => { const t = s.targeting || {}; return { id: s.id, campaign_id: s.campaign_id, name: s.name, status: s.status, effective_status: s.effective_status, words: statusWords(s.effective_status), created: (s.created_time || "").slice(0, 10), daily_budget: s.daily_budget ? num(s.daily_budget) / 100 : null, gender: gender(t), age_min: t.age_min ?? null, age_max: t.age_max ?? null, geo: geoWords(t.geo_locations), countries: adsetCountries(t), abroad: isAbroad(t, home), audience: audienceLabel(s.name), targeting: summarise(t).join(" · ") }; }),
    ads: ads.map((a) => {
      const cr = a.creative || {}, afs = cr.asset_feed_spec || {}, oss = cr.object_story_spec || {}, vd = oss.video_data || null;
      const hashes = [...new Set([...(afs.images || []).map((i) => i.hash), ...(cr.image_hash ? [cr.image_hash] : [])].filter(Boolean))];
      // A video ad (their best ones are, whatever "Image:" in the name says) keeps its poster frame as its picture.
      const isVideo = cr.object_type === "VIDEO" || !!cr.video_id || !!vd || (afs.videos || []).length > 0;
      const poster = vd?.image_hash || afs.videos?.[0]?.thumbnail_hash || null;
      const body = afs.bodies?.[0]?.text || cr.body || oss.link_data?.message || vd?.message || null, title = afs.titles?.[0]?.text || cr.title || oss.link_data?.name || vd?.title || null;
      const form = afs.call_to_actions?.[0]?.value?.lead_gen_form_id || oss.link_data?.call_to_action?.value?.lead_gen_form_id || vd?.call_to_action?.value?.lead_gen_form_id || null;
      const set = setOf[a.adset_id] || {}, camp = campOf[a.campaign_id] || {};
      return { id: a.id, name: a.name, adset_id: a.adset_id, campaign_id: a.campaign_id, campaign: camp.name || null, adset: set.name || null, status: a.status, effective_status: a.effective_status, words: statusWords(a.effective_status), created: (a.created_time || "").slice(0, 10),
        media: isVideo ? "video" : hashes.length ? "image" : "other", hashes, poster, importable: !!(hashes[0] || poster), thumbnail: cr.thumbnail_url || null, creative_id: cr.id || null, body, title, form_id: form,
        all_time: all[a.id] || EMPTY(), last_30d: last30[a.id] || EMPTY() };
    }),
  };
  writeWhole(join(gymDir, HISTORY), JSON.stringify(out, null, 2) + "\n");
  return out;
}
export const readHistory = (gymDir) => readJson(join(gymDir, HISTORY));
/** The ids of every ad this app made for the gym (their rows come from the batches, not the history). */
export function appAdIds(gymDir) {
  const dir = join(gymDir, "outputs");
  if (!existsSync(dir)) return new Set();
  const ids = new Set();
  for (const id of readdirSync(dir)) { const r = readJson(join(dir, id, "publish.json")); for (const a of Object.values(r?.ads || {})) if (a.id) ids.add(a.id); for (const a of r?.superseded || []) if (a.id) ids.add(a.id); }
  return ids;
}
/** The account's ads that were not made here, as rows in the same shape (the parameters Meta knows; the rest empty), cheapest lead first. */
export function historyRows(gymDir) {
  const h = readHistory(gymDir); if (!h) return [];
  const ours = appAdIds(gymDir), setOf = Object.fromEntries(h.adsets.map((s) => [s.id, s])), campOf = Object.fromEntries(h.campaigns.map((c) => [c.id, c]));
  const imported = new Set(readCopyRefs(gymDir).refs.map((r) => r.ad_id).filter(Boolean));
  const refDir = join(gymDir, "references");
  return h.ads.filter((a) => !ours.has(a.id)).map((a) => { const s = setOf[a.adset_id] || {}; return {
    source: "account", gym: gymDir.split("/").pop(), batch: null, folder: null, ad_id: a.id, creative_id: a.creative_id, adset_id: a.adset_id, campaign_id: a.campaign_id, published: a.created, superseded: false,
    campaign: a.campaign, campaign_status: campOf[a.campaign_id]?.words || null, campaign_created: campOf[a.campaign_id]?.created || null, adset_name: a.adset, ad_name: a.name, media: a.media, thumbnail: a.thumbnail, hashes: a.hashes, importable: !!a.importable,
    offer: null, location: null, audience: s.audience || null, callout: null, photos: null, scenes: null, exercise: null, age_tag: null, setting: null, equipment: null, layout: null, style: null, palette: null, has_story: null,
    pin: s.geo || null, countries: (s.countries || []).join("+") || null, abroad: !!s.abroad, radius_km: null, age_min: s.age_min ?? null, age_max: s.age_max ?? null, gender: s.gender || null, preset: s.targeting || null, preset_id: null, daily_budget: s.daily_budget ?? null, budget_level: null,
    form_id: a.form_id, cta: null, headline: a.title, primary_text: a.body, placeholder_words: null,
    status: a.words, adset_status: s.words || null, ...Object.fromEntries(Object.entries(a.all_time).filter(([k]) => !["from", "to"].includes(k))), leads_7d: null, spend_7d: null, leads_30d: a.last_30d?.leads ?? null, spend_30d: a.last_30d?.spend ?? null, pulled: h.pulled,
    in_library: imported.has(a.id) || existsSync(join(refDir, `meta-${a.id}.jpg`)) || existsSync(join(refDir, `meta-${a.id}.png`)),
  }; }).sort((x, y) => (x.cost_per_lead ?? Infinity) - (y.cost_per_lead ?? Infinity) || y.leads - x.leads || (y.spend || 0) - (x.spend || 0));
}
/** The ad-set level: every ad set the rows belong to (both sources), its facts and the sum of its ads' numbers, the cheapest lead first. */
export function adsetRows(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.adset_id) continue;
    const g = by.get(r.adset_id) || { adset_id: r.adset_id, source: r.source, name: r.source === "app" ? (r.callout ? `${r.callout} · ${r.batch}` : r.batch) : (r.adset_name || r.adset_id), callout: r.callout || null, batch: r.batch || null, campaign: r.source === "app" ? r.batch : (r.campaign || null), campaign_id: r.campaign_id || null,
      status: r.adset_status || null, gender: r.gender || null, age_min: r.age_min ?? null, age_max: r.age_max ?? null, pin: r.pin || null, countries: r.countries || null, abroad: !!r.abroad, targeting: r.preset || null, daily_budget: r.daily_budget ?? null, audience: r.audience || null,
      ads: 0, superseded: 0, spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, pulled: r.pulled || null };
    if (r.superseded) g.superseded++; else g.ads++;
    g.spend = Math.round((g.spend + (r.spend || 0)) * 100) / 100; g.impressions += r.impressions || 0; g.reach += r.reach || 0; g.clicks += r.clicks || 0; g.leads += r.leads || 0;
    by.set(r.adset_id, g);
  }
  return [...by.values()].map((g) => ({ ...g, cost_per_lead: g.leads ? round2(g.spend / g.leads) : null, ctr: g.impressions ? round2((g.clicks / g.impressions) * 100) : null }))
    .sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0));
}
/** The campaign level: every campaign the rows belong to, its ad sets and ads counted, its numbers summed, the cheapest lead first. */
export function campaignRows(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.campaign_id) continue;
    const g = by.get(r.campaign_id) || { campaign_id: r.campaign_id, source: r.source, name: r.campaign || r.batch || r.campaign_id, batch: r.batch || null, status: r.campaign_status || null, created: r.source === "app" ? (r.published || "").slice(0, 10) || null : r.campaign_created || null, adset_ids: new Set(), ads: 0, superseded: 0, spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, abroad: false, pulled: r.pulled || null };
    if (r.adset_id) g.adset_ids.add(r.adset_id);
    if (r.superseded) g.superseded++; else g.ads++;
    if (r.abroad) g.abroad = true;
    g.spend = Math.round((g.spend + (r.spend || 0)) * 100) / 100; g.impressions += r.impressions || 0; g.reach += r.reach || 0; g.clicks += r.clicks || 0; g.leads += r.leads || 0;
    by.set(r.campaign_id, g);
  }
  return [...by.values()].map(({ adset_ids, ...g }) => ({ ...g, adsets: adset_ids.size, cost_per_lead: g.leads ? round2(g.spend / g.leads) : null, ctr: g.impressions ? round2((g.clicks / g.impressions) * 100) : null }))
    .sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0));
}
/** Every row the gym has: the app's and the account's, the cheapest lead first. */
export const allRows = (gymDir) => [...gymRows(gymDir), ...historyRows(gymDir)].sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || (b.spend || 0) - (a.spend || 0));
// ── into the library: the best ads' images as references, their words as copy references ──────────
export const readCopyRefs = (gymDir) => { const j = readJson(join(gymDir, COPY_REFS)); return { schema: 1, refs: [], ...(j || {}), refs: Array.isArray(j?.refs) ? j.refs : [] }; };
const imageExt = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : buf[0] === 0x89 && buf[1] === 0x50 ? "png" : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP" ? "webp" : null);
/**
 * Bring chosen ads from the account into the library: each ad's first image (through the account's adimages, fetched
 * from Meta's CDN) as `references/meta-{ad}.{ext}` with its record beside it, and its primary text + headline as a copy
 * reference with its results. Their own ads, never another operator's. Nothing is fetched twice.
 */
export async function importFromAccount({ client, accountId, gymDir, adIds, fetchImpl = globalThis.fetch, maxBytes = 25 * 1024 * 1024 }) {
  const h = readHistory(gymDir); if (!h) throw new Error("pull the account's history first");
  const chosen = adIds.map((id) => h.ads.find((a) => a.id === String(id))).filter(Boolean);
  if (!chosen.length) throw new Error("none of those ads is in the account's history");
  const refDir = join(gymDir, "references"); mkdirSync(refDir, { recursive: true });
  const picture = (a) => a.hashes[0] || a.poster || null;
  const wanted = [...new Set(chosen.map(picture).filter(Boolean))];
  const urls = {};
  for (let i = 0; i < wanted.length; i += 20) {
    const r = await client.get(`${actId(accountId)}/adimages`, { hashes: JSON.stringify(wanted.slice(i, i + 20)), fields: "hash,url,permalink_url" });
    for (const x of r.data || []) urls[x.hash] = x.url || x.permalink_url || null;
  }
  const copy = readCopyRefs(gymDir), done = { images: 0, images_kept: 0, copy: 0, copy_kept: 0, skipped: [] };
  for (const a of chosen) {
    const hash = picture(a);
    if (hash) {
      const have = ["jpg", "png", "webp"].map((e) => join(refDir, `meta-${a.id}.${e}`)).find(existsSync);
      if (have) done.images_kept++;
      else if (!urls[hash] || !CDN_HOSTS.test(urls[hash]) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(urls[hash])) done.skipped.push(`${a.id}: no image url from Meta`);
      else {
        try {
          const res = await fetchImpl(urls[hash]);
          if (!res.ok) throw new Error(`Meta's CDN answered ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = imageExt(buf);
          if (!ext) throw new Error("not an image");
          if (buf.length > maxBytes) throw new Error("too large");
          writeFileSync(join(refDir, `meta-${a.id}.${ext}`), buf);
          writeFileSync(join(refDir, `meta-${a.id}.${ext}.meta.json`), JSON.stringify({ ad_id: a.id, ad: a.name, campaign: a.campaign, adset: a.adset, hash, kind: a.media === "video" ? "the video's poster frame" : "the ad's image", leads: a.all_time.leads, spend: a.all_time.spend, cost_per_lead: a.all_time.cost_per_lead, body: a.body, title: a.title, imported: new Date().toISOString() }, null, 2) + "\n");
          done.images++;
        } catch (e) { done.skipped.push(`${a.id}: image ${scrubTokens(e.message)}`); }
      }
    } else done.skipped.push(`${a.id}: ${a.media} ad with no picture to bring`);
    if (a.body || a.title) {
      const at = copy.refs.find((r) => r.ad_id === a.id);
      const set = h.adsets.find((x) => x.id === a.adset_id);
      const entry = { id: `meta-${a.id}`, source: "account", ad_id: a.id, ad: a.name, campaign: a.campaign, message: a.body, headline: a.title, results: { leads: a.all_time.leads, spend: a.all_time.spend, cost_per_lead: a.all_time.cost_per_lead, ctr: a.all_time.ctr, ...(set?.abroad ? { abroad: set.countries.join("+") } : {}) }, pulled: h.pulled, added: at?.added || new Date().toISOString().slice(0, 10), note: at?.note || "" };
      if (at) { Object.assign(at, entry); done.copy_kept++; } else { copy.refs.push(entry); done.copy++; }
    }
  }
  writeWhole(join(gymDir, COPY_REFS), JSON.stringify(copy, null, 2) + "\n");
  return done;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, "brand-dir": { type: "string" }, batch: { type: "string" }, pull: { type: "boolean", default: false }, table: { type: "boolean", default: false }, csv: { type: "boolean", default: false }, history: { type: "boolean", default: false }, "import-top": { type: "string" } } });
  if (!v.gym || !(v.pull || v.table || v.csv || v.history || v["import-top"])) { console.error("Usage: meta-results.mjs --gym <slug> [--batch <id>] (--pull | --table | --csv | --history | --import-top N) [--brand-dir <dir>]"); process.exit(1); }
  try {
    const gymDir = v["brand-dir"] ? resolve(v["brand-dir"]) : join(REPO_ROOT, "brands", v.gym);
    if (v.history || v["import-top"]) {
      const config = metaConfig({ gym: v.gym });
      if (!config.token) throw new Error(`no ${config.names.META_ACCESS_TOKEN} in .env`);
      const client = graphClient({ config });
      const profile = readJson(join(gymDir, "gym-profile.json")), accountId = profile?.meta_assets?.ad_account_id;
      if (!accountId) throw new Error("the profile has no ad account (Meta link)");
      if (v.history) {
        const h = await pullAccountHistory({ client, accountId, gymDir });
        const rows = historyRows(gymDir);
        console.log(`history: ${h.campaigns.length} campaigns, ${h.adsets.length} ad sets, ${h.ads.length} ads (${rows.length} not made here) · ${rows.reduce((t, r) => t + r.spend, 0).toFixed(2)} spent, ${rows.reduce((t, r) => t + r.leads, 0)} leads all time`);
        for (const r of rows.slice(0, 15)) console.log(`  ${(r.cost_per_lead ?? "—").toString().padStart(7)}  ${String(r.leads).padStart(4)} leads  ${String(r.spend).padStart(9)}  ${r.media.padEnd(5)} ${r.status.padEnd(10)} ${(r.gender || "").padEnd(5)} ${r.ad_name.slice(0, 70)}`);
      }
      if (v["import-top"]) {
        const n = parseInt(v["import-top"], 10);
        const top = historyRows(gymDir).filter((r) => r.importable && r.leads > 0 && !r.abroad).sort((a, b) => b.leads - a.leads).slice(0, n).map((r) => r.ad_id);
        const d = await importFromAccount({ client, accountId, gymDir, adIds: top });
        console.log(`imported: ${d.images} image(s) into references/ (${d.images_kept} already there), ${d.copy} copy reference(s) (${d.copy_kept} updated)${d.skipped.length ? `; skipped: ${d.skipped.join("; ")}` : ""}`);
      }
    }
    if (v.pull) {
      const config = metaConfig({ gym: v.gym });
      if (!config.token) throw new Error(`no ${config.names.META_ACCESS_TOKEN} in .env`);
      const client = graphClient({ config });
      const ids = v.batch ? [v.batch] : readdirSync(join(gymDir, "outputs")).filter((id) => existsSync(join(gymDir, "outputs", id, "publish.json")));
      for (const id of ids) {
        const rec = readJson(join(gymDir, "outputs", id, "publish.json"));
        if (!rec?.campaign?.id) { console.log(`${id}: not on Meta yet`); continue; }
        const r = await pullResults({ client, record: rec, batchDir: join(gymDir, "outputs", id) });
        console.log(`${id}: campaign ${r.campaign.words} · ${Object.keys(r.ads).length} ads · all time ${r.campaign.all_time.spend} spent, ${r.campaign.all_time.leads} leads${r.campaign.all_time.cost_per_lead != null ? ` at ${r.campaign.all_time.cost_per_lead}` : ""} · last 7 days ${r.campaign.last_7d.spend} spent, ${r.campaign.last_7d.leads} leads`);
      }
    }
    if (v.table || v.csv || v.pull) {
      const rows = writeGymCsv(gymDir);
      if (v.table) for (const r of rows.filter((x) => !v.batch || x.batch === v.batch)) console.log(`${(r.cost_per_lead ?? "—").toString().padStart(7)}  ${String(r.leads).padStart(4)} leads  ${String(r.spend).padStart(8)}  ${r.status.padEnd(12)}  ${r.batch}/${r.folder}  ${r.layout} ${r.style} ${r.palette}  ${r.scenes || ""}  ${r.callout || ""} ${r.gender || ""} ${r.preset || ""}${r.superseded ? "  (superseded)" : ""}`);
      if (v.csv) console.log(`results.csv: ${rows.length} rows → ${join(gymDir, "results.csv")}`);
    }
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
