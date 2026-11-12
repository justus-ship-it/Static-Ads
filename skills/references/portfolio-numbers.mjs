/**
 * portfolio-numbers.mjs — every gym's marketing numbers for one period, side by side (2026-11-12).
 *
 * The owner's rule for the All gyms screen: data, not a to-do list — spend, lead-form leads, cost per lead and what
 * moved it (CPM, click rate, clicks that became leads, frequency), for a period he picks, against the period before.
 *
 * The numbers on file could not say that honestly: the account's older ads carried all-time and 30-day figures, this
 * app's own campaigns all-time and 7-day ones, an export neither. So one read of its own, read-only on Meta and with
 * no model call (`pullDaily`, 8 calls a gym): each ad set's numbers day by day for the last 180 days, its reach over
 * the last 7, 30 and 90 days (reach cannot be added up from days), each ad's totals over the same three periods, and
 * the ads running now with their budgets → `brands/{gym}/account-daily.json`. Every period, every change and the
 * trend line then come from that one file (`gymNumbers`, pure), so two figures on the screen are never from two
 * different sets of ads.
 *
 * The rules are the rest of the app's: a result is a lead-form lead; a campaign that was not after leads, a hiring ad
 * and an ad set reaching outside the gym's country are left out (their spend is said beside the row, never added);
 * money is never summed across currencies. **The account that can be read comes first** (the owner's rule, 2026-11-12,
 * F45 Jurong West: its linked account ran nothing after August while its 26 running ads sit in an account the link
 * cannot see): a gym whose account was read shows that account's periods, and an Ads Manager export on file is said
 * beside them (`export_also`), never in their place. Only a gym whose account was never read shows the export's own
 * period — no period switch and no trend can be made from it.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { metrics, readHistory } from "./meta-results.mjs";
import { actId, dateWindow, budgetFrom, metaConfig, graphClient, scrubTokens } from "./meta-api.mjs";
import { isAbroad } from "./meta-targeting.mjs";
import { NOT_LEAD_OBJECTIVE, RECRUITMENT, FREQ_TIRED, DAILY_FILE, goalKind, gymRowsSplit, isActive } from "./what-wins.mjs";

export { DAILY_FILE };
/** Days kept day by day (so the 90-day period has a 90 days before it), and the periods the screen offers. */
export const DAYS_KEPT = 180, PERIODS = [7, 30, 90];
/** The marks, by rule from the numbers: cost per lead up a quarter on 5+ leads each side; running with no lead in 3 days; spending under 70% of the budget. */
export const COST_UP = 1.25, CHANGE_MIN_LEADS = 5, NO_LEAD_DAYS = 3, UNDER_PACE = 0.7, PACE_DAYS = 3;
/** An ad is named the best from 3 leads in the period; numbers older than this are said to be old. */
export const BEST_MIN_LEADS = 3, STALE_HOURS = 36;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const round2 = (v) => Math.round(v * 100) / 100, round1 = (v) => Math.round(v * 10) / 10;
export const addDays = (date, n) => { const [y, m, d] = String(date).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/** Why an ad set is left out of the numbers, or null (the same reasons What wins uses; `goal` is the ad set's optimisation goal: one after website conversions or chats was never after a lead-form lead). */
export function leftOut({ abroad, objective, campaign, name, goal }) {
  if (abroad) return "abroad";
  if (objective && NOT_LEAD_OBJECTIVE.test(objective)) return "objective";
  if (RECRUITMENT.test([campaign, name].filter(Boolean).join(" | "))) return "recruitment";
  return goalKind(goal);
}

// ── The read (read-only on Meta) ─────────────────────────────────────────────

/**
 * Read one gym's account for the numbers screen: 9 calls, nothing written to Meta, no model call. A step that fails
 * is recorded and the rest is kept; the day-by-day read failing is the one thing that fails the whole read.
 */
export async function pullDaily({ client, accountId, gymDir, now = new Date() }) {
  const acct = actId(accountId), locale = readJson(join(gymDir, "gym-profile.json"))?.locale || {};
  const home = locale.country || "SG", currency = locale.currency || "SGD", timezone = locale.timezone || "Asia/Singapore";
  const span = dateWindow(DAYS_KEPT, { timezone, now }), errors = [];
  const soft = async (what, p) => { try { return await p; } catch (e) { errors.push(`${what}: ${scrubTokens(e.message)}`); return []; } };
  const daily = await client.list(`${acct}/insights`, { level: "adset", time_increment: 1, time_range: JSON.stringify(span), fields: "adset_id,adset_name,campaign_id,campaign_name,objective,spend,impressions,clicks,inline_link_clicks,actions,date_start", limit: 500 });
  const reach = {}, ads = {};
  for (const d of PERIODS) {
    const range = JSON.stringify(dateWindow(d, { timezone, now }));
    const r = await soft(`reach over ${d} days`, client.list(`${acct}/insights`, { level: "adset", time_range: range, fields: "adset_id,impressions,reach,frequency", limit: 500 }));
    reach[d] = Object.fromEntries(r.map((x) => [x.adset_id, { impressions: Number(x.impressions) || 0, reach: Number(x.reach) || 0, frequency: x.frequency != null ? round2(Number(x.frequency)) : null }]));
    const a = await soft(`ads over ${d} days`, client.list(`${acct}/insights`, { level: "ad", time_range: range, fields: "ad_id,ad_name,adset_id,campaign_id,spend,impressions,reach,frequency,clicks,inline_link_clicks,actions", limit: 500 }));
    ads[d] = a.map((x) => { const m = metrics(x); return { ad_id: x.ad_id, name: x.ad_name || null, adset_id: x.adset_id, campaign_id: x.campaign_id, spend: m.spend, impressions: m.impressions, clicks: m.clicks, leads: m.leads, reach: m.reach, frequency: m.frequency }; }).filter((x) => x.spend > 0 || x.leads > 0);
  }
  const live = await soft("the ads running now", client.list(`${acct}/ads`, { effective_status: JSON.stringify(["ACTIVE"]), fields: "id,name,adset_id,campaign_id,created_time,adset{id,name,daily_budget,targeting{geo_locations}},campaign{id,name,objective,daily_budget}", limit: 100 }));
  // What every ad set of the account was after (its optimisation goal): the ones after website conversions or chats are left out, here and in the review.
  const goals = Object.fromEntries((await soft("what each ad set was after", client.list(`${acct}/adsets`, { fields: "id,optimization_goal", limit: 500 }))).map((s) => [s.id, s.optimization_goal || null]));
  const not_leads = Object.fromEntries(Object.entries(goals).map(([id, g]) => [id, goalKind(g)]).filter(([, k]) => k));
  // What is known of each ad set: Meta's own words on the day rows, the running ads' budgets and reach, and — for an ad set no longer running — whether it reached abroad from the account's history on file.
  const onFile = Object.fromEntries((readHistory(gymDir)?.adsets || []).map((s) => [s.id, s])), adsets = {}, campaigns = {};
  const camp = (id, name, objective) => (campaigns[id] = { name: name || campaigns[id]?.name || null, objective: objective || campaigns[id]?.objective || null, daily_budget: campaigns[id]?.daily_budget ?? null, running: campaigns[id]?.running || false });
  for (const r of daily) { camp(r.campaign_id, r.campaign_name, r.objective); adsets[r.adset_id] = { name: r.adset_name || null, campaign_id: r.campaign_id, abroad: !!onFile[r.adset_id]?.abroad, running: false, daily_budget: null }; }
  for (const a of live) {
    const c = camp(a.campaign_id, a.campaign?.name, a.campaign?.objective); c.running = true; c.daily_budget = budgetFrom(a.campaign?.daily_budget, currency);
    adsets[a.adset_id] = { name: a.adset?.name || adsets[a.adset_id]?.name || null, campaign_id: a.campaign_id, abroad: a.adset?.targeting ? isAbroad(a.adset.targeting, home) : !!onFile[a.adset_id]?.abroad, running: true, daily_budget: budgetFrom(a.adset?.daily_budget, currency) };
  }
  for (const [id, s] of Object.entries(adsets)) { s.goal = goals[id] || null; s.left_out = leftOut({ abroad: s.abroad, objective: campaigns[s.campaign_id]?.objective, campaign: campaigns[s.campaign_id]?.name, name: s.name, goal: s.goal }); }
  const out = {
    schema: 1, pulled: (typeof now === "string" ? new Date(now) : now).toISOString(), account: acct, currency, timezone, span, adsets, campaigns, not_leads,
    days: daily.map((r) => { const m = metrics(r); return { d: r.date_start, s: r.adset_id, spend: m.spend, impressions: m.impressions, clicks: m.clicks, leads: m.leads }; }),
    reach, ads, live: live.map((a) => ({ id: a.id, name: a.name || null, adset_id: a.adset_id, campaign_id: a.campaign_id, created: String(a.created_time || "").slice(0, 10) || null })), errors,
  };
  writeWhole(join(gymDir, DAILY_FILE), JSON.stringify(out) + "\n");
  return out;
}
export const readDaily = (gymDir) => { const j = readJson(join(gymDir, DAILY_FILE)); return j && Array.isArray(j.days) ? j : null; };

// ── The numbers (pure: from what is on file) ─────────────────────────────────

const zero = () => ({ spend: 0, impressions: 0, clicks: 0, leads: 0 });
const add = (t, r) => { t.spend += r.spend || 0; t.impressions += r.impressions || 0; t.clicks += r.clicks || 0; t.leads += r.leads || 0; return t; };
/** Sums → the figures the screen shows. `click_to_lead` is the share of link clicks that became a lead, in percent. */
export function figures(t, frequency = null) {
  return {
    spend: round2(t.spend), leads: t.leads, impressions: t.impressions, clicks: t.clicks,
    cost_per_lead: t.leads ? round2(t.spend / t.leads) : null, cpm: t.impressions ? round2((t.spend / t.impressions) * 1000) : null,
    ctr: t.impressions ? round2((t.clicks / t.impressions) * 100) : null, click_to_lead: t.clicks ? round1((t.leads / t.clicks) * 100) : null, frequency,
  };
}
/** The change from the period before, in percent (null when there is nothing to compare with). */
export const changeOf = (cur, prev) => (cur != null && prev > 0 ? round1((cur / prev - 1) * 100) : null);

/** One period's figures for a set of ad sets: the period, the one before, and how each headline figure moved. */
function periodOf(file, sets, d) {
  const until = file.span.until, from = addDays(until, -(d - 1)), prevFrom = addDays(from, -d), cur = zero(), prev = zero();
  for (const r of file.days) { if (!sets.has(r.s)) continue; if (r.d >= from && r.d <= until) add(cur, r); else if (r.d >= prevFrom && r.d < from) add(prev, r); }
  let imp = 0, rch = 0; for (const id of sets) { const x = file.reach?.[d]?.[id]; if (x) { imp += x.impressions; rch += x.reach; } }
  const f = figures(cur, rch ? round2(imp / rch) : null), p = figures(prev), covered = prevFrom >= file.span.since;
  return { ...f, from, to: until, prev: covered ? { spend: p.spend, leads: p.leads, cost_per_lead: p.cost_per_lead, from: prevFrom, to: addDays(from, -1) } : null,
    // A cost per lead is compared only with 5+ leads on each side: one lead against two is no trend.
    change: covered ? { spend: changeOf(f.spend, p.spend), leads: changeOf(f.leads, p.leads), cost_per_lead: f.leads >= CHANGE_MIN_LEADS && p.leads >= CHANGE_MIN_LEADS ? changeOf(f.cost_per_lead, p.cost_per_lead) : null } : { spend: null, leads: null, cost_per_lead: null } };
}
/** The cheapest ad of a period (3+ leads) and the dearest: the largest spend for no lead when it passes two leads' worth, else the highest cost per lead. */
function extremes(ads, cpl) {
  const withLeads = ads.filter((a) => a.leads > 0).map((a) => ({ ...a, cost_per_lead: round2(a.spend / a.leads) }));
  const best = withLeads.filter((a) => a.leads >= BEST_MIN_LEADS).sort((a, b) => a.cost_per_lead - b.cost_per_lead)[0] || null;
  const dry = ads.filter((a) => !a.leads && cpl && a.spend >= 2 * cpl).sort((a, b) => b.spend - a.spend)[0] || null;
  // The only ad with a lead is not "the dearest": that needs a second one to be dearer than.
  const dear = dry || (withLeads.length >= 2 ? withLeads.filter((a) => a.ad_id !== best?.ad_id).sort((a, b) => b.cost_per_lead - a.cost_per_lead)[0] : null) || null;
  const short = (a) => a && { ad_id: a.ad_id, name: a.name, spend: round2(a.spend), leads: a.leads, cost_per_lead: a.leads ? round2(a.spend / a.leads) : null }; // (an ad's own reach and frequency stay in the file, for the review)
  return { best: short(best), dearest: short(dear) };
}

/** The numbers of a gym whose account was read day by day. */
function fromDaily(file, { now }) {
  const kept = new Set(Object.entries(file.adsets).filter(([, s]) => !s.left_out).map(([id]) => id)), until = file.span.until;
  const liveKept = (file.live || []).filter((a) => kept.has(a.adset_id)), runSets = new Set(liveKept.map((a) => a.adset_id)), runCamps = new Set(liveKept.map((a) => a.campaign_id));
  // A budget is the ad set's own, else its campaign's (counted once per campaign).
  const budgetOf = (sets, camps) => { let b = 0, any = false; const seen = new Set(); for (const id of sets) { const s = file.adsets[id]; if (s?.daily_budget) { b += s.daily_budget; any = true; } else if (s && !seen.has(s.campaign_id) && file.campaigns[s.campaign_id]?.daily_budget) { seen.add(s.campaign_id); b += file.campaigns[s.campaign_id].daily_budget; any = true; } } return any ? round2(b) : null; };
  const paceOf = (sets, budget) => { if (!budget) return null; let s = 0; const a = addDays(until, -PACE_DAYS), ranBefore = file.days.some((r) => sets.has(r.s) && r.d < a && r.d >= addDays(a, -14) && r.spend > 0); if (!ranBefore) return null; for (const r of file.days) if (sets.has(r.s) && r.d >= a && r.d < until) s += r.spend; return round2(s / PACE_DAYS / budget); };
  const periods = {}, flags = {}, ads = {}, other = {};
  const lastLead = file.days.filter((r) => kept.has(r.s) && r.leads > 0).reduce((m, r) => (r.d > m ? r.d : m), "") || null, sinceLead = lastLead ? daysBetween(lastLead, until) : null;
  const budget = budgetOf(runSets), pace = paceOf(runSets, budget), recentSpend = file.days.some((r) => runSets.has(r.s) && r.d > addDays(until, -NO_LEAD_DAYS) && r.spend > 0);
  const tired = [...runSets].map((id) => ({ id, name: file.adsets[id]?.name, frequency: file.reach?.[30]?.[id]?.frequency ?? null })).filter((x) => x.frequency >= FREQ_TIRED).sort((a, b) => b.frequency - a.frequency);
  for (const d of PERIODS) {
    const p = (periods[d] = periodOf(file, kept, d)), from = p.from;
    ads[d] = extremes((file.ads?.[d] || []).filter((a) => kept.has(a.adset_id)), p.cost_per_lead);
    other[d] = round2(file.days.filter((r) => !kept.has(r.s) && r.d >= from && r.d <= until).reduce((t, r) => t + r.spend, 0));
    const f = (flags[d] = []);
    if (!liveKept.length) f.push({ kind: "nothing_running", tone: "bad", text: "nothing running" });
    if (p.cost_per_lead && p.prev?.cost_per_lead && p.leads >= CHANGE_MIN_LEADS && p.prev.leads >= CHANGE_MIN_LEADS && p.cost_per_lead >= COST_UP * p.prev.cost_per_lead) f.push({ kind: "cost_up", tone: "warn", text: "cost up" });
    if (liveKept.length && recentSpend && (sinceLead == null || sinceLead >= NO_LEAD_DAYS)) f.push({ kind: "no_leads", tone: "bad", text: sinceLead == null ? "no lead yet" : `no lead in ${sinceLead} days` });
    if (tired.length) f.push({ kind: "tiring", tone: "warn", text: `frequency ${tired[0].frequency}` });
    if (pace != null && pace < UNDER_PACE) f.push({ kind: "under_budget", tone: "warn", text: `spending ${Math.round(pace * 100)}% of budget` });
  }
  const series = []; { const by = new Map(); for (const r of file.days) if (kept.has(r.s)) { const x = by.get(r.d) || { spend: 0, leads: 0 }; x.spend += r.spend; x.leads += r.leads; by.set(r.d, x); } for (let i = 89; i >= 0; i--) { const date = addDays(until, -i), x = by.get(date); series.push({ date, spend: x ? round2(x.spend) : 0, leads: x ? x.leads : 0 }); } }
  // The campaigns: every one running, and every one that spent in the last 90 days, the biggest spender of the last 30 days first.
  const from90 = addDays(until, -89), campIds = new Set([...runCamps]); for (const r of file.days) if (kept.has(r.s) && r.d >= from90 && r.spend > 0) campIds.add(file.adsets[r.s].campaign_id);
  const campaigns = [...campIds].map((id) => {
    const sets = new Set([...kept].filter((s) => file.adsets[s].campaign_id === id)), run = new Set([...sets].filter((s) => runSets.has(s))), b = budgetOf(run), per = {}, ex = {};
    for (const d of PERIODS) { per[d] = periodOf(file, sets, d); ex[d] = extremes((file.ads?.[d] || []).filter((a) => sets.has(a.adset_id)), per[d].cost_per_lead); }
    const mine = liveKept.filter((a) => a.campaign_id === id), newest = mine.reduce((m, a) => (a.created && a.created > m ? a.created : m), "");
    return { id, name: file.campaigns[id]?.name || id, running: run.size > 0, ads_running: mine.length, adsets_running: run.size, budget: b, pace: paceOf(run, b), newest_ad: newest || null, newest_ad_days: newest ? daysBetween(newest, until) : null,
      frequency_30d: [...run].map((s) => file.reach?.[30]?.[s]?.frequency ?? 0).reduce((m, x) => Math.max(m, x), 0) || null, periods: per, ads: ex };
  }).sort((a, b) => b.running - a.running || b.periods[30].spend - a.periods[30].spend);
  const newest = liveKept.reduce((m, a) => (a.created && a.created > m ? a.created : m), "");
  const nowMs = (typeof now === "string" ? new Date(now) : now).getTime(), age = round1((nowMs - Date.parse(file.pulled)) / 3600000);
  return { source: "meta", read_at: file.pulled, age_hours: age, stale: age > STALE_HOURS, until, periods, flags, ads, other, series, campaigns,
    running: { ads: liveKept.length, adsets: runSets.size, campaigns: runCamps.size, budget, pace }, last_lead: lastLead, days_since_lead: sinceLead, newest_ad: newest || null, newest_ad_days: newest ? daysBetween(newest, until) : null,
    left_out: Object.values(file.adsets).reduce((t, s) => { if (s.left_out) t[s.left_out] = (t[s.left_out] || 0) + 1; return t; }, {}), errors: file.errors || [] };
}

/** All time, and an export's own period: summed from the ad rows on file (the Review's rows, the same three things left out). */
function fromRows(rows) {
  const t = zero(); for (const r of rows) add(t, r);
  return figures(t);
}
const campaignsOf = (rows) => { const by = new Map(); for (const r of rows) { const k = r.campaign_id || r.campaign || "?"; const x = by.get(k) || { id: k, name: r.campaign || k, rows: [] }; x.rows.push(r); by.set(k, x); } return [...by.values()].map((x) => ({ id: x.id, name: x.name, running: x.rows.some(isActive), ads_running: x.rows.filter(isActive).length, ads: x.rows.length, figures: fromRows(x.rows) })).sort((a, b) => b.running - a.running || b.figures.spend - a.figures.spend); };
const rowAds = (rows) => rows.map((r) => ({ ad_id: r.ad_id, name: r.ad_name || r.description || r.folder || null, spend: r.spend || 0, leads: r.leads || 0 }));

/**
 * One gym's numbers, from what is on file. `source`: "meta" (read day by day: every period, change and trend),
 * "export" (the running ads came as an Ads Manager export: that export's own period, nothing else), "file" (only the
 * account's history is here: all time, until the numbers are read), "none".
 */
export function gymNumbers(gymDir, { now = new Date() } = {}) {
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, gym = gymDir.split("/").pop(), history = readHistory(gymDir), file = readDaily(gymDir);
  const base = { gym, name: profile.display_name || gym, currency: profile.locale?.currency || "SGD", account: profile.meta_assets?.ad_account_id || null };
  let rows = [], left = {}; try { const s = gymRowsSplit(gymDir); rows = s.rows; left = s.left_out; } catch { /* nothing on file */ }
  const all = rows.length ? { ...fromRows(rows), as_of: history?.pulled || null, ads: rows.length, campaigns: campaignsOf(rows).slice(0, 12), best_dearest: extremes(rowAds(rows), null) } : null;
  const exported = rows.filter((r) => r.origin === "export" && isActive(r)), daily = file ? fromDaily(file, { now }) : null;
  const ex = (history?.exports || []).slice(-1)[0] || {};
  // The account that was read comes first. An export's running ads are in an account this link cannot read: said beside the row, and "nothing running" is not said over them.
  if (daily) {
    if (!exported.length) return { ...base, ...daily, all };
    const f = fromRows(exported), also = { file: ex.file || null, label: ex.label || null, to: ex.reporting?.to || null, ads: exported.length, spend: f.spend, leads: f.leads, cost_per_lead: f.cost_per_lead, tiring: exported.filter((r) => (r.frequency || 0) >= FREQ_TIRED).length };
    const flags = Object.fromEntries(Object.entries(daily.flags).map(([d, list]) => [d, [...list.filter((x) => x.kind !== "nothing_running" || daily.running.ads), { kind: "export_running", tone: "note", text: `${also.ads} ad${also.ads === 1 ? "" : "s"} in an account not linked` }]]));
    return { ...base, ...daily, flags, all, export_also: also };
  }
  if (exported.length) {
    const f = fromRows(exported), tired = exported.filter((r) => (r.frequency || 0) >= FREQ_TIRED), freq = exported.filter((r) => r.frequency && r.impressions);
    const imp = freq.reduce((t, r) => t + r.impressions, 0), flags = tired.length ? [{ kind: "tiring", tone: "warn", text: `${tired.length} ad${tired.length === 1 ? "" : "s"} tiring` }] : [];
    return { ...base, source: "export", read_at: ex.imported || history?.pulled || null, export: { file: ex.file || null, label: ex.label || null, to: ex.reporting?.to || null },
      fixed: { ...f, ...(exported.some((r) => r.clicks > 0) ? {} : { ctr: null, click_to_lead: null, clicks: null }), frequency: imp ? round2(freq.reduce((t, r) => t + r.frequency * r.impressions, 0) / imp) : null, ads: extremes(rowAds(exported), f.cost_per_lead), campaigns: campaignsOf(exported) },
      flags, running: { ads: exported.length, adsets: new Set(exported.map((r) => r.adset_id)).size, campaigns: new Set(exported.map((r) => r.campaign_id)).size, budget: null, pace: null }, all, left_out: left };
  }
  if (all) return { ...base, source: "file", read_at: history?.pulled || null, running: { ads: rows.filter(isActive).length, adsets: null, campaigns: null, budget: null, pace: null }, all, left_out: left };
  return { ...base, source: "none", read_at: null, running: { ads: 0 }, all: null };
}

/** Every gym side by side, and the totals: leads and running ads summed, money per currency only. */
export function portfolioNumbers(brandsDir, { now = new Date(), gyms: only = null } = {}) {
  const names = only || (existsSync(brandsDir) ? readdirSync(brandsDir).filter((n) => !n.startsWith(".") && !n.startsWith("_") && statSync(join(brandsDir, n)).isDirectory() && existsSync(join(brandsDir, n, "gym-profile.json"))).sort() : []);
  const gyms = names.map((n) => { try { return gymNumbers(join(brandsDir, n), { now }); } catch (e) { return { gym: n, name: n, currency: "SGD", source: "none", read_at: null, running: { ads: 0 }, all: null, error: scrubTokens(e.message) }; } });
  const totals = {};
  for (const d of PERIODS) {
    const t = { leads: 0, leads_prev: 0, gyms: 0, by_currency: {}, compared: true };
    for (const g of gyms) { const p = g.source === "meta" ? g.periods[d] : null; if (!p) continue; t.gyms++; t.leads += p.leads; if (p.prev) t.leads_prev += p.prev.leads; else t.compared = false;
      const c = (t.by_currency[g.currency] ||= { spend: 0, leads: 0, prev_spend: 0, prev_leads: 0, gyms: 0 }); c.gyms++; c.spend += p.spend; c.leads += p.leads; if (p.prev) { c.prev_spend += p.prev.spend; c.prev_leads += p.prev.leads; } }
    for (const c of Object.values(t.by_currency)) { c.spend = round2(c.spend); c.cost_per_lead = c.leads ? round2(c.spend / c.leads) : null; const pc = c.prev_leads ? c.prev_spend / c.prev_leads : null; c.change = t.compared ? changeOf(c.cost_per_lead, pc) : null; }
    t.leads_change = t.compared ? changeOf(t.leads, t.leads_prev) : null; totals[d] = t;
  }
  { const t = { leads: 0, gyms: 0, by_currency: {} }; for (const g of gyms) { if (!g.all) continue; t.gyms++; t.leads += g.all.leads; const c = (t.by_currency[g.currency] ||= { spend: 0, leads: 0, gyms: 0 }); c.gyms++; c.spend += g.all.spend; c.leads += g.all.leads; } for (const c of Object.values(t.by_currency)) { c.spend = round2(c.spend); c.cost_per_lead = c.leads ? round2(c.spend / c.leads) : null; } totals.all = t; }
  const read = gyms.filter((g) => g.source === "meta").map((g) => g.read_at).sort();
  return { periods: PERIODS, gyms, totals, running: { ads: gyms.reduce((t, g) => t + (g.running?.ads || 0), 0), gyms: gyms.filter((g) => g.running?.ads > 0).length, of: gyms.length },
    outside: gyms.filter((g) => g.source === "export").map((g) => g.name), elsewhere: gyms.filter((g) => g.export_also).map((g) => ({ gym: g.gym, name: g.name, ads: g.export_also.ads, to: g.export_also.to })), unread: gyms.filter((g) => g.source === "file" || (g.source === "none" && g.account)).map((g) => g.name), read: { oldest: read[0] || null, newest: read[read.length - 1] || null } };
}

/** Read every linked gym's numbers again (read-only on Meta, no model call). A gym without an account or a failing read is said and the run goes on. */
export async function refreshNumbers({ brandsDir, log = console.log, now = new Date(), clientFor = (gym) => { const config = metaConfig({ gym }); return config.token ? graphClient({ config, maxPages: 40 }) : null; } }) {
  const done = [];
  for (const g of portfolioNumbers(brandsDir, { now }).gyms) {
    if (!g.account) { log(`${g.name}: no ad account on its profile — skipped`); done.push({ gym: g.gym, skipped: "no ad account" }); continue; }
    const client = clientFor(g.gym);
    if (!client) { log(`${g.name}: the Meta link is not set up — skipped`); done.push({ gym: g.gym, skipped: "no Meta link" }); continue; }
    try {
      const f = await pullDaily({ client, accountId: g.account, gymDir: join(brandsDir, g.gym), now }), n = gymNumbers(join(brandsDir, g.gym), { now }), p = n.periods?.[30];
      log(`${g.name}: ${f.days.length} ad-set days, ${f.live.length} ads running${p ? ` · last 30 days ${g.currency} ${p.spend} spent, ${p.leads} leads${p.cost_per_lead != null ? ` at ${p.cost_per_lead}` : ""}` : ""}${f.errors.length ? ` · not read: ${f.errors.join("; ")}` : ""}`);
      done.push({ gym: g.gym, days: f.days.length, running: f.live.length, errors: f.errors });
    } catch (e) { log(`${g.name}: failed — ${scrubTokens(e.message)}`); done.push({ gym: g.gym, error: scrubTokens(e.message) }); }
  }
  return done;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brands-dir": { type: "string" }, refresh: { type: "boolean", default: false }, show: { type: "boolean", default: false }, days: { type: "string", default: "30" } } });
  if (!(v.refresh || v.show)) { console.error("Usage: portfolio-numbers.mjs --refresh | --show [--days 7|30|90]   [--brands-dir <dir>]"); process.exit(1); }
  const brandsDir = v["brands-dir"] ? resolve(v["brands-dir"]) : join(REPO_ROOT, "brands");
  try {
    if (v.refresh) { const done = await refreshNumbers({ brandsDir }); if (done.length && done.every((d) => d.error)) process.exit(1); }
    if (v.show) {
      const d = PERIODS.includes(Number(v.days)) ? Number(v.days) : 30, P = portfolioNumbers(brandsDir);
      for (const g of P.gyms) {
        const p = g.source === "meta" ? g.periods[d] : g.source === "export" ? g.fixed : g.all;
        const what = g.source === "meta" ? `last ${d} days` : g.source === "export" ? `export to ${g.export.to || "?"}` : g.source === "file" ? "all time (numbers not read yet)" : "nothing on file";
        console.log(`${g.name.padEnd(22)} ${g.currency} ${what}: ${p ? `${p.spend} spent, ${p.leads} leads, CPL ${p.cost_per_lead ?? "—"}${p.change?.cost_per_lead != null ? ` (${p.change.cost_per_lead > 0 ? "+" : ""}${p.change.cost_per_lead}%)` : ""}, CPM ${p.cpm ?? "—"}, CTR ${p.ctr ?? "—"}%, click→lead ${p.click_to_lead ?? "—"}%, freq ${p.frequency ?? "—"}` : "—"} · ${g.running?.ads || 0} running${(g.flags?.[d] || g.flags || []).length ? ` · ${(g.flags[d] || g.flags).map((f) => f.text).join(", ")}` : ""}`);
      }
    }
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
