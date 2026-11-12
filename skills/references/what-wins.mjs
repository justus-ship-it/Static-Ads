/**
 * what-wins.mjs — the gym's leads read per attribute, and what to do about it, by rule (2026-11-09).
 *
 * Joins every ad the gym has run (the app's and the account's, the API's and an Ads Manager export's) with the
 * vision reading of its picture (read-creatives.mjs) and says, for each attribute — format, subject, backdrop,
 * pose, expression, media, offer, ratio, words on the picture, logo, eye contact — what each value cost per
 * lead, how many leads stand behind it (early / enough / solid) and how it sits against the account's median.
 * Then the suggestions: keep, tiring, consider pausing, what matters most, never tried, not read yet. All of it
 * is code: no model writes a conclusion, and nothing here touches Meta. The owner decides.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { allRows, pullAccountHistory, pullResults, fetchPictures } from "./meta-results.mjs";
import { readsFor, readCreatives, unreadCount, FORMATS } from "./read-creatives.mjs";
import { metaConfig, graphClient, scrubTokens } from "./meta-api.mjs";

/** Under 5 leads a value is "early"; from 20 it is "solid". Between, "enough" to compare. An ad is named a keeper from 10. */
export const LEADS_EARLY = 5, LEADS_SOLID = 20, LEADS_KEEP = 10;
/** Seen three times per person or more, an ad is tiring. */
export const FREQ_TIRED = 3;
/** A lead at 85% of the median or less is cheap; at 150% or more, dear. */
export const CHEAP = 0.85, DEAR = 1.5;
export const ATTRIBUTES = [["format", "Format"], ["subject", "Subject"], ["backdrop", "Backdrop"], ["pose", "Pose"], ["expression", "Expression"], ["media", "Media"], ["offer", "Offer"], ["ratio", "Ratio"], ["text_density", "Words on the picture"], ["logo", "Logo"], ["eye_contact", "Eye contact"]];
const FROM_ROW = new Set(["media", "offer"]);

export const confidence = (leads) => (leads >= LEADS_SOLID ? "solid" : leads >= LEADS_EARLY ? "enough" : leads > 0 ? "early" : "none");
const round2 = (v) => Math.round(v * 100) / 100;
const yesNo = (v) => (v === true ? "yes" : v === false ? "no" : null);

/** The value an ad has for an attribute: from the row (media, offer) or from its reading. */
export function valueOf(row, key) {
  if (FROM_ROW.has(key)) return row[key] || null;
  // An ad this app made knows its format from its batch (Phase 4): the record wins over what a reading of the picture guessed.
  if (key === "format" && row.format) return row.format;
  // By record, not by eye (2026-11-11): for this app's own ads the room and the words' size are what the batch recorded.
  // The vision reader called the same words in the same layout "heavy" on one Sculpt Society ad and "light" on another.
  if (row.source === "app") {
    if (key === "backdrop" && row.room) return row.room;
    if (key === "text_density") return row.text_cover == null ? null : coverWord(row.text_cover);
  }
  const r = row.read; if (!r) return null;
  if (key === "logo" || key === "eye_contact") return yesNo(r[key]);
  return r[key] ?? null;
}
/** How much of the picture the words cover, in the reading's own words: under COVER_LIGHT light, from COVER_HEAVY heavy. Measured at render (batch.json → text_cover), never guessed. */
export const COVER_LIGHT = 0.1, COVER_HEAVY = 0.18;
export const coverWord = (c) => (c < COVER_LIGHT ? "light" : c >= COVER_HEAVY ? "heavy" : "medium");
/** Every row with its reading attached (by ad id). */
export function joinReads(rows, byAd) { return rows.map((r) => ({ ...r, read: (r.ad_id && byAd.get(r.ad_id)) || null })); }
/** The median cost per lead over the ads that have at least an early number of leads; null without any. */
export function medianCpl(rows) {
  const v = rows.filter((r) => (r.leads || 0) >= LEADS_EARLY && r.cost_per_lead != null).map((r) => r.cost_per_lead).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : round2((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
}
const sum = (rows) => rows.reduce((t, r) => ({ ads: t.ads + 1, spend: round2(t.spend + (r.spend || 0)), impressions: t.impressions + (r.impressions || 0), leads: t.leads + (r.leads || 0) }), { ads: 0, spend: 0, impressions: 0, leads: 0 });

/** For each attribute, each value's ads, spend, leads, cost per lead, share of the gym's leads, its ratio to the median and its confidence — cheapest lead first, unread ads counted apart. */
export function attributeTables(rows, { median = medianCpl(rows) } = {}) {
  const totalLeads = rows.reduce((t, r) => t + (r.leads || 0), 0);
  return ATTRIBUTES.map(([key, label]) => {
    const by = new Map(); let unread = 0, unreadLeads = 0;
    for (const r of rows) { const v = valueOf(r, key); if (v == null) { unread++; unreadLeads += r.leads || 0; continue; } (by.get(v) || by.set(v, []).get(v)).push(r); }
    const values = [...by.entries()].map(([value, rs]) => { const s = sum(rs); return { value, ...s, pictures: new Set(rs.map(pictureKey)).size, cost_per_lead: s.leads ? round2(s.spend / s.leads) : null, share: totalLeads ? round2((s.leads / totalLeads) * 100) : 0, vs_median: s.leads && median ? round2(s.spend / s.leads / median) : null, confidence: confidence(s.leads) }; })
      .sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || b.spend - a.spend);
    return { key, label, values, unread, unread_leads: unreadLeads };
  });
}
/** The ads shown too often: active, with a frequency at or over the bar, the most shown first. */
export const fatigueRows = (rows) => rows.filter((r) => (r.frequency || 0) >= FREQ_TIRED && isActive(r)).sort((a, b) => b.frequency - a.frequency);

const adName = (r) => r.ad_name || (r.folder ? `${r.batch}/${r.folder.replace(/^\d+-/, "")}` : r.ad_id);
const kindOf = (r) => { const d = r.read; if (!d) return r.media || "ad"; return [d.format, d.subject !== "none" ? d.subject : null, d.backdrop].filter(Boolean).join(", "); };
const money = (n, cur) => (n == null ? "—" : `${cur} ${Number(n).toFixed(2)}`);

// ── checked before it is said (2026-11-11) ───────────────────────────────────
// The review told Sculpt Society to keep running an ad that "still leads cheaply" at SGD 17.81 — its all-time figure — while
// its last 7 days cost SGD 29.42 a lead; and it read one ad's leads as three findings (its backdrop, its kind of shot, its
// words). So every line is checked by rule before it is advice, and carries its verdict:
//   confirmed — it stands: act on it        test  — one picture, or contradicted inside an ad set: the next batch tests it
//   early     — not judged yet (no fair chance, or its whole ad set is weak)        none — true, and nothing here changes it
/** An ad is judged a loser only after this many impressions and a spend of this many median leads. */
export const FAIR_IMPRESSIONS = 1000, FAIR_SPEND_X = 2;
/** A winner is fading when its recent cost per lead is this much above its own all-time figure, on at least this many recent leads. */
export const FADE_X = 1.25, FADE_MIN_LEADS = 5;
/** A pattern is confirmed on at least this many different pictures; a gap between two values matters from this ratio. */
export const CONFIRM_PICTURES = 2, MATTERS_GAP = 1.25;
/** Attributes nothing in the app changes: said for the record, never acted on. */
export const NO_LEVER = new Set(["ratio", "logo", "media", "offer"]);
/**
 * An ad's most recent figures on file: the last 7 days when they hold enough leads to judge (FADE_MIN_LEADS), else the
 * last 30 when those do, else the shortest window on file; null for an export's. Since 2026-11-12 every ad of an
 * account that was read day by day carries both windows (withDaily) — before, this app's ads had 7 days and the
 * account's older ones 30, so two ads of one gym were judged over different stretches.
 */
export function recentOf(r) {
  const c = [[7, "leads_7d", "spend_7d"], [30, "leads_30d", "spend_30d"]].filter(([, l, s]) => r[l] != null || r[s] != null).map(([d, l, s]) => { const leads = r[l] || 0, spend = round2(r[s] || 0); return { days: d, leads, spend, cost_per_lead: leads ? round2(spend / leads) : null }; });
  return c.find((x) => x.leads >= FADE_MIN_LEADS) || c[0] || null;
}
const check = (name, ok, text) => ({ name, ok, text });
/** The other ads of an ad's own ad set: their leads, spend and cost per lead (the same audience, the same budget). */
function restOfAdset(r, rows) { const o = rows.filter((x) => x !== r && x.adset_id && x.adset_id === r.adset_id); const leads = o.reduce((t, x) => t + (x.leads || 0), 0), spend = round2(o.reduce((t, x) => t + (x.spend || 0), 0)); return { ads: o.length, leads, spend, cost_per_lead: leads ? round2(spend / leads) : null }; }
/**
 * The running ads, checked: { key, kind: keep | tiring | pause | wait, verdict, ads, name, what, numbers, checks[], text }.
 *   keep    — 10+ leads at 85% of the median or less, and not fading
 *   tiring  — seen 3 times a person or more, or a winner whose recent leads cost 25% more than its own average ("fading")
 *   pause   — dear (150% of the median on 5+ leads) or spend for nothing — after a fair chance, and not when its whole ad set is weak
 *   wait    — would be paused, but not judged yet
 */
export function adInsights(rows, { median = medianCpl(rows), currency = "SGD" } = {}) {
  if (median == null) return [];
  const out = [], active = rows.filter(isActive);
  const cheap = active.filter((r) => (r.leads || 0) >= LEADS_KEEP && r.cost_per_lead != null && r.cost_per_lead <= CHEAP * median).sort((a, b) => b.leads - a.leads);
  const numbers = (r, rec) => ({ leads: r.leads || 0, spend: r.spend || 0, cost_per_lead: r.cost_per_lead ?? null, impressions: r.impressions || 0, frequency: r.frequency ?? null, median, recent: rec });
  const tired = new Map(); // ad → reasons
  for (const r of cheap.slice(0, 6)) {
    const rec = recentOf(r), fading = !!rec && rec.leads >= FADE_MIN_LEADS && rec.cost_per_lead >= FADE_X * r.cost_per_lead, rest = restOfAdset(r, active);
    const checks = [
      rec ? check("recent", rec.leads < FADE_MIN_LEADS ? null : !fading, rec.leads < FADE_MIN_LEADS ? `only ${rec.leads} lead${rec.leads === 1 ? "" : "s"} in the last ${rec.days} days: too few to say whether it still pays` : `the last ${rec.days} days: ${rec.leads} leads at ${money(rec.cost_per_lead, currency)}, against ${money(r.cost_per_lead, currency)} over its whole run`) : check("recent", null, "no recent figure on file to set beside its total"),
      rest.ads ? check("adset", rest.cost_per_lead == null ? null : r.cost_per_lead <= rest.cost_per_lead, rest.cost_per_lead == null ? "the other ads of its ad set have no lead to compare with" : `the other ${rest.ads} ad${rest.ads === 1 ? "" : "s"} of its ad set cost ${money(rest.cost_per_lead, currency)} a lead`) : check("adset", null, "it is alone in its ad set"),
    ];
    if (fading) { tired.set(r, { fading: rec, checks }); continue; }
    out.push({ key: `keep:${r.ad_id}`, kind: "keep", verdict: "confirmed", ads: [r.ad_id], name: adName(r), what: kindOf(r), numbers: numbers(r, rec), checks,
      text: `Keep running: ${adName(r)} — ${r.leads} leads at ${money(r.cost_per_lead, currency)} against a median of ${money(median, currency)} (${kindOf(r)}).${rec && rec.leads >= FADE_MIN_LEADS ? ` Still paying: ${rec.leads} leads at ${money(rec.cost_per_lead, currency)} in the last ${rec.days} days.` : ""}` });
  }
  for (const r of fatigueRows(active)) if (!tired.has(r)) tired.set(r, { fading: null, checks: [] });
  for (const [r, t] of tired) {
    const rec = recentOf(r), isCheap = cheap.includes(r), seen = (r.frequency || 0) >= FREQ_TIRED;
    const checks = [...t.checks, ...(seen ? [check("frequency", false, `seen ${r.frequency} times per person (${FREQ_TIRED} or more is tiring)`)] : [])];
    const text = t.fading
      ? `Fading: ${adName(r)} — its last ${t.fading.days} days cost ${money(t.fading.cost_per_lead, currency)} a lead (${t.fading.leads} leads) against ${money(r.cost_per_lead, currency)} over its whole run (${r.leads} leads); the median is ${money(median, currency)}.${seen ? ` It has been seen ${r.frequency} times per person.` : ""} Make new versions of the same kind (${kindOf(r)}) now.`
      : `Tiring: ${adName(r)} has been seen ${r.frequency} times per person${isCheap ? " and still leads cheaply" : ""}. Make new versions of the same kind (${kindOf(r)}) before it fades${isCheap ? "" : ", or let it go"}.`;
    out.push({ key: `tiring:${r.ad_id}`, kind: "tiring", verdict: "confirmed", fading: !!t.fading, ads: [r.ad_id], name: adName(r), what: kindOf(r), numbers: numbers(r, rec), checks, text });
  }
  const retire = active.filter((r) => ((r.leads || 0) >= LEADS_EARLY && r.cost_per_lead >= DEAR * median) || (!(r.leads || 0) && (r.spend || 0) >= FAIR_SPEND_X * median)).sort((a, b) => (b.cost_per_lead ?? -1) - (a.cost_per_lead ?? -1));
  for (const r of retire.slice(0, 6)) {
    const rest = restOfAdset(r, active), seenEnough = !(r.impressions > 0) || r.impressions >= FAIR_IMPRESSIONS, spentEnough = (r.spend || 0) >= FAIR_SPEND_X * median, weakSet = rest.ads > 0 && !rest.leads && !(r.leads || 0);
    const checks = [
      check("fair", seenEnough && spentEnough, `${r.impressions > 0 ? `${r.impressions.toLocaleString("en-GB")} impressions and ` : ""}${money(r.spend, currency)} spent (a fair chance is ${FAIR_IMPRESSIONS.toLocaleString("en-GB")} impressions and ${money(round2(FAIR_SPEND_X * median), currency)})`),
      rest.ads ? check("adset", !weakSet, weakSet ? `no ad in its ad set has a lead (${money(rest.spend, currency)} spent between the other ${rest.ads}): that points at the audience, not this ad` : `the other ${rest.ads} ad${rest.ads === 1 ? "" : "s"} of its ad set: ${rest.leads} lead${rest.leads === 1 ? "" : "s"}${rest.cost_per_lead != null ? ` at ${money(rest.cost_per_lead, currency)}` : ""}`) : check("adset", null, "it is alone in its ad set"),
    ];
    const fair = seenEnough && spentEnough && !weakSet, said = r.leads ? `${r.leads} leads at ${money(r.cost_per_lead, currency)}` : `${money(r.spend, currency)} spent for no lead`;
    out.push(fair
      ? { key: `pause:${r.ad_id}`, kind: "pause", verdict: "confirmed", ads: [r.ad_id], name: adName(r), what: kindOf(r), numbers: numbers(r, recentOf(r)), checks, text: `Consider pausing: ${adName(r)} — ${said} (${kindOf(r)}).` }
      : { key: `pause:${r.ad_id}`, kind: "wait", verdict: "early", ads: [r.ad_id], name: adName(r), what: kindOf(r), numbers: numbers(r, recentOf(r)), checks, text: `Not judged yet: ${adName(r)} — ${said}, but ${weakSet ? "no ad in its ad set has a lead, which points at the audience rather than this ad" : "it has not had a fair chance"} (${checks[weakSet ? 1 : 0].text}).` });
  }
  return out;
}
/**
 * What the ads' attributes say, checked: the widest gaps between two values with solid leads on both sides, each
 * { key, kind: matters | lead | fact, verdict, attribute, label, best, worst, gap, checks[], text }.
 *   matters (confirmed) — the cheaper value stands on two or more pictures, and no ad set says the opposite
 *   lead (test)         — one picture's leads are that picture's: something to test, not a finding
 *   fact (none)         — true, and nothing in the app changes it (the ratio, a logo)
 */
export function attrInsights(rows, tables, { currency = "SGD", top = 3 } = {}) {
  const gaps = tables.map((t) => { const vs = t.values.filter((v) => v.cost_per_lead != null && v.confidence === "solid"); if (vs.length < 2) return null; const best = vs[0], worst = vs[vs.length - 1]; return { t, best, worst, gap: round2(worst.cost_per_lead / best.cost_per_lead) }; }).filter((g) => g && g.gap >= MATTERS_GAP).sort((a, b) => b.gap - a.gap);
  // One picture is one lead to test, however many of its attributes it would name (its kind of shot, its subject, its backdrop):
  // the widest gap speaks for it, and the line says which picture it is.
  const soleOf = (t, v) => { const of = rows.filter((r) => valueOf(r, t.key) === v.value); return v.pictures === 1 && of.length ? of[0] : null; }, seenPic = new Set();
  const kept = gaps.filter((g) => { const one = soleOf(g.t, g.best); if (!one || NO_LEVER.has(g.t.key)) return true; const k = pictureKey(one); if (seenPic.has(k)) return false; seenPic.add(k); return true; });
  return kept.slice(0, top).map(({ t, best, worst, gap }) => {
    // Like with like: inside each ad set that ran both values with enough leads, which one was cheaper there?
    const sets = new Map();
    for (const r of rows) { const v = valueOf(r, t.key); if (!r.adset_id || (v !== best.value && v !== worst.value)) continue; const s = sets.get(r.adset_id) || sets.set(r.adset_id, { b: { leads: 0, spend: 0 }, w: { leads: 0, spend: 0 } }).get(r.adset_id), x = v === best.value ? s.b : s.w; x.leads += r.leads || 0; x.spend += r.spend || 0; }
    const both = [...sets.values()].filter((s) => s.b.leads >= FADE_MIN_LEADS && s.w.leads >= FADE_MIN_LEADS), agree = both.filter((s) => s.b.spend / s.b.leads <= s.w.spend / s.w.leads).length;
    const pics = (v) => `${v.pictures === 1 ? "one picture" : `${v.pictures} pictures`}`;
    const checks = [
      check("pictures", best.pictures >= CONFIRM_PICTURES, `${best.value} stands on ${pics(best)} (${best.leads} leads), ${worst.value} on ${pics(worst)} (${worst.leads})`),
      both.length ? check("adset", agree > 0, `inside ${both.length === 1 ? "the one ad set" : `${both.length} ad sets`} that ran both, ${best.value} was cheaper in ${agree}`) : check("adset", null, "no ad set ran both with enough leads to compare like with like"),
    ];
    const lever = !NO_LEVER.has(t.key), confirmed = best.pictures >= CONFIRM_PICTURES && !(both.length && !agree), one = soleOf(t, best);
    const base = { ...(one ? { picture: { name: adName(one), scene: one.source === "app" && one.scenes && !String(one.scenes).includes("+") ? one.scenes : null, ad_id: one.ad_id } } : {}), key: `attr:${t.key}=${best.value}`, attribute: t.key, label: t.label, best: { value: best.value, leads: best.leads, pictures: best.pictures, cost_per_lead: best.cost_per_lead }, worst: { value: worst.value, leads: worst.leads, pictures: worst.pictures, cost_per_lead: worst.cost_per_lead }, gap, checks };
    if (!lever) return { ...base, kind: "fact", verdict: "none", text: `${t.label}: ${best.value} leads at ${money(best.cost_per_lead, currency)} (${best.leads} leads) against ${worst.value} at ${money(worst.cost_per_lead, currency)} (${worst.leads}). For the record: nothing in the app changes this.` };
    return confirmed
      ? { ...base, kind: "matters", verdict: "confirmed", text: `${t.label} matters: ${best.value} leads at ${money(best.cost_per_lead, currency)} (${best.leads} leads over ${pics(best)}) against ${worst.value} at ${money(worst.cost_per_lead, currency)} (${worst.leads} over ${pics(worst).replace(" pictures", "").replace("one picture", "one")}). Make more of the first.` }
      : { ...base, kind: "lead", verdict: "test", text: `To test, not a finding yet — ${t.label}: ${best.value} at ${money(best.cost_per_lead, currency)} (${best.leads} leads, ${pics(best)}) against ${worst.value} at ${money(worst.cost_per_lead, currency)} (${worst.leads} over ${pics(worst)}). ${best.pictures < CONFIRM_PICTURES ? `One picture's leads are that picture's${one ? ` (${one.source === "app" && one.scenes && !String(one.scenes).includes("+") ? `scene ${one.scenes}` : adName(one)})` : ""}` : `Inside the ad sets that ran both, ${best.value} was not the cheaper one`}: the next batch tests it with new versions.` };
  });
}

/** What to do, by rule, each line checked first (adInsights, attrInsights). Each item: { kind, text, ads?, attribute?, verdict?, checks? }. Nothing here acts. */
export function suggestions(rows, tables, { median = medianCpl(rows), currency = "SGD", everyRows = rows } = {}) {
  const out = [], total = rows.reduce((t, r) => t + (r.leads || 0), 0);
  if (total < LEADS_SOLID) out.push({ kind: "thin", text: `Too few leads to conclude anything yet: ${total} in all. Let the current ads run to ${LEADS_SOLID} before changing the mix.` });
  if (median == null) { out.push({ kind: "thin", text: `No ad has ${LEADS_EARLY} leads yet, so there is no median cost per lead to compare against.` }); return out; }
  out.push(...adInsights(rows, { median, currency }));
  out.push(...attrInsights(rows, tables, { currency }));
  const fmt = tables.find((t) => t.key === "format");
  if (fmt && everyRows.some((r) => r.read)) {
    // Tried anywhere in the gym's history, not only in the scope: an old campaign's class shot still counts as tried.
    const tried = new Set(everyRows.map((r) => r.read?.format).filter(Boolean));
    const never = Object.keys(FORMATS).filter((f) => !tried.has(f) && f !== "other" && f !== "before-after");
    if (never.length) out.push({ kind: "test", text: `Never tried in this account: ${never.join(", ")}. Each is a candidate for a small share of the next batch.` });
  }
  const unread = rows.filter((r) => !r.read && (r.leads || 0) > 0);
  if (unread.length) out.push({ kind: "unread", ads: unread.map((r) => r.ad_id), text: `${unread.length} ad${unread.length === 1 ? "" : "s"} with leads ${unread.length === 1 ? "has" : "have"} no picture read yet (${unread.reduce((t, r) => t + r.leads, 0)} leads), so they sit outside every table but Media and Offer. Read the creatives to include them.` });
  return out;
}

/** The ads a scope keeps: "active" — the ads running now (an account's old campaigns would otherwise set the median);
 *  "recent" — running now, or made in the last 6 months (the owner's window, 2026-11-10); "all" — every ad the gym ran. */
export const SCOPES = ["active", "recent", "all"];
export const RECENT_DAYS = 183;
/** Two tracks (the owner's rule, 2026-11-10): the agent makes stills, so stills learn from stills; video is read on its own. */
export const TRACKS = ["stills", "video", "all"];
export const trackOf = (r) => (r.media === "video" ? "video" : "stills");
export const inTrack = (rows, track) => (track === "all" ? rows : rows.filter((r) => trackOf(r) === track));
/** What each track did in a set of rows: ads, leads, spend, cost per lead. */
export const trackSums = (rows) => Object.fromEntries(["stills", "video"].map((t) => { const x = rows.filter((r) => trackOf(r) === t), spend = round2(x.reduce((a, r) => a + (r.spend || 0), 0)), leads = x.reduce((a, r) => a + (r.leads || 0), 0); return [t, { ads: x.length, leads, spend, cost_per_lead: leads ? round2(spend / leads) : null }]; }));
/** Running now: Meta's "live" (the API's word for ACTIVE) or an export's "active". */
export const isActive = (r) => /^(live|active)$/i.test(String(r.status || "").trim());
export function inScope(rows, scope, { now = new Date() } = {}) {
  if (scope === "active") return rows.filter(isActive);
  if (scope === "recent") { const since = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString().slice(0, 10); return rows.filter((r) => isActive(r) || (r.published && String(r.published).slice(0, 10) >= since)); }
  return rows;
}
/** Campaigns that were never after a lead: their spend would count against whatever their picture shows. */
export const NOT_LEAD_OBJECTIVE = /AWARENESS|ENGAGEMENT|TRAFFIC|LINK_CLICKS|VIDEO_VIEWS|REACH|PAGE_LIKES|APP_INSTALLS|APP_PROMOTION/i;
/** Hiring ads: their "leads" are job applicants, not members (F45 Xinyi's "HR | …" ads). */
export const RECRUITMENT = /(^|[^a-z])HR([^a-z]|$)|hiring|recruit|we'?re hiring|join our team|招募|徵才|招聘|徵人/i;
/**
 * What an ad set was after, by its optimisation goal (the owner's ruling, 2026-11-12: "leave it out" — BFIT's 52 ad
 * sets optimised for website conversions spent SGD 12,337 in 180 days for no lead-form lead inside a campaign whose
 * objective says "leads", so the campaign's objective cannot tell them apart): null for one after lead-form leads
 * (or unknown), "website", "chat" (WhatsApp, Messenger and Instagram conversations), "objective" for anything else.
 */
export const LEAD_GOALS = /^(LEAD_GENERATION|QUALITY_LEAD)$/;
export function goalKind(goal) {
  if (!goal || LEAD_GOALS.test(goal)) return null;
  if (/^(OFFSITE_CONVERSIONS|VALUE|LANDING_PAGE_VIEWS)$/.test(goal)) return "website";
  if (/CONVERSATIONS/.test(goal)) return "chat";
  return "objective";
}
/** Why a row is left out of What wins, or null: an ad set reaching outside the gym's country, a campaign that was not after leads, a hiring ad, an ad set after website conversions or chats. */
export function leftOutWhy(r) {
  if (r.abroad) return "abroad";
  if (r.objective && NOT_LEAD_OBJECTIVE.test(r.objective)) return "objective";
  if (RECRUITMENT.test([r.campaign, r.adset_name, r.ad_name].filter(Boolean).join(" | "))) return "recruitment";
  if (r.not_leads) return r.not_leads;
  return null;
}
/** The day-fresh numbers file (portfolio-numbers.mjs reads the account into it once a day). */
export const DAILY_FILE = "account-daily.json";
const dayBack = (date, n) => { const [y, m, d] = String(date).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };
/**
 * A gym's rows with the day's read laid over them (2026-11-12: Review Data on the same numbers as All gyms). For every
 * ad of the account that was read — never an export's rows, which are another account's: its last 7, 30 and 90 days
 * (nought when it did not deliver), whether it is running now (Meta's word as of that read, when the read is newer
 * than the row's own), what its ad set was after, and — for an ad made inside the last 90 days, whose 90-day total is
 * its whole run — its totals and frequency as of the read. A gym with no such file is returned as it is.
 */
export function withDaily(rows, gymDir) {
  let file = null; try { file = JSON.parse(readFileSync(join(gymDir, DAILY_FILE), "utf-8")); } catch { return rows; }
  if (!file?.ads || !file.span?.until) return rows;
  const by = (d) => new Map((file.ads[d] || []).map((a) => [a.ad_id, a])), a7 = by(7), a30 = by(30), a90 = by(90), live = new Set((file.live || []).map((a) => a.id)), since90 = dayBack(file.span.until, 89);
  return rows.map((r) => {
    if (r.origin === "export" || !r.ad_id) return r;
    const out = { ...r, numbers_read: file.pulled }, kind = file.not_leads?.[r.adset_id], of = (m) => { const x = m.get(r.ad_id); return x ? [x.spend, x.leads] : [0, 0]; };
    if (kind) out.not_leads = kind;
    [out.spend_7d, out.leads_7d] = of(a7); [out.spend_30d, out.leads_30d] = of(a30); [out.spend_90d, out.leads_90d] = of(a90);
    if (String(file.pulled) > String(r.pulled || "")) { out.status_read = file.pulled; if (live.has(r.ad_id)) out.status = "live"; else if (isActive(r)) out.status = "not running"; }
    const x = a90.get(r.ad_id);
    if (x && r.published && String(r.published).slice(0, 10) >= since90 && x.spend >= (r.spend || 0)) {
      Object.assign(out, { spend: x.spend, leads: x.leads, impressions: x.impressions, clicks: x.clicks, cost_per_lead: x.leads ? round2(x.spend / x.leads) : null, ctr: x.impressions ? round2((x.clicks / x.impressions) * 100) : null, cpm: x.impressions ? round2((x.spend / x.impressions) * 1000) : null });
      if (x.frequency != null) out.frequency = x.frequency; if (x.reach) out.reach = x.reach;
    }
    return out;
  });
}
/** A gym's rows with their readings, and what was left out and why. */
export function gymRowsSplit(gymDir) {
  // An ad the owner paused from here (insights.json → actions) reads as paused at once: Meta's own word takes over at the next read of the account.
  let paused = new Map(); try { for (const a of JSON.parse(readFileSync(join(gymDir, "insights.json"), "utf-8")).actions || []) if (a.what === "pause" && a.ad_id) paused.set(a.ad_id, a.at); } catch { /* no ledger yet */ }
  const all = withDaily(joinReads(allRows(gymDir), readsFor(gymDir).byAd), gymDir).map((r) => (paused.has(r.ad_id) && String(r.status_read || r.pulled || "") < paused.get(r.ad_id) && isActive(r) ? { ...r, status: "paused", paused_here: paused.get(r.ad_id) } : r)), left_out = { abroad: 0, objective: 0, recruitment: 0 }, rows = [];
  for (const r of all) { const why = leftOutWhy(r); if (why) left_out[why] = (left_out[why] || 0) + 1; else rows.push(r); }
  return { rows, left_out };
}
export const gymRowsRead = (gymDir) => gymRowsSplit(gymDir).rows;

/** The campaigns a set of rows belongs to, for the filter: each with its ads, how many are running, its leads, spend and
 *  cost per lead — the running ones first, then the most leads. A row without a campaign is in none. */
export function campaignList(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.campaign_id) continue;
    const c = by.get(r.campaign_id) || by.set(r.campaign_id, { id: r.campaign_id, name: r.campaign || r.batch || r.campaign_id, origin: r.origin || (r.source === "app" ? "app" : "account"), ads: 0, running: 0, leads: 0, spend: 0 }).get(r.campaign_id);
    c.ads++; if (isActive(r)) c.running++; c.leads += r.leads || 0; c.spend = round2(c.spend + (r.spend || 0));
  }
  return [...by.values()].map((c) => ({ ...c, cost_per_lead: c.leads ? round2(c.spend / c.leads) : null })).sort((a, b) => (b.running > 0) - (a.running > 0) || b.leads - a.leads || b.spend - a.spend || String(a.name).localeCompare(String(b.name)));
}

/** Everything the Review Data page shows under What wins. The scope falls back to every ad when nothing is active.
 *  `campaign` (an id from `campaigns`) keeps one campaign's ads: the scope's counts, the median and every table are then
 *  that campaign's own, so its ads are read against one another (one offer, one audience, one stretch of time). An id
 *  the gym does not have is ignored. "Never tried in this account" still looks at the whole account. */
export function whatWins(gymDir, { currency = "SGD", scope = "active", track = "stills", campaign = null, now = new Date() } = {}) {
  const { total: pictures } = readsFor(gymDir);
  const account = gymRowsRead(gymDir), campaigns = campaignList(account);
  const chosen = (campaign && campaigns.find((c) => c.id === String(campaign))) || null;
  const every = chosen ? account.filter((r) => r.campaign_id === chosen.id) : account;
  let scoped = inScope(every, scope, { now });
  if (!scoped.length && scope === "active") { scope = "recent"; scoped = inScope(every, scope, { now }); }
  if (!scoped.length && scope === "recent") { scope = "all"; scoped = every; }
  const rows = inTrack(scoped, track);
  const median = medianCpl(rows), tables = attributeTables(rows, { median }).filter((t) => track === "all" || t.key !== "media");
  return { scope, track, campaign: chosen ? { id: chosen.id, name: chosen.name } : null, campaigns, tracks: trackSums(scoped), active: every.filter(isActive).length, recent: inScope(every, "recent", { now }).length, every: every.length, median, currency, ads: rows.length, read: rows.filter((r) => r.read).length, pictures, leads: rows.reduce((t, r) => t + (r.leads || 0), 0), spend: round2(rows.reduce((t, r) => t + (r.spend || 0), 0)),
    tables, fatigue: fatigueRows(rows).map((r) => ({ ad_id: r.ad_id, name: adName(r), frequency: r.frequency, leads: r.leads, cost_per_lead: r.cost_per_lead, kind: kindOf(r) })), suggestions: suggestions(rows, tables, { median, currency, everyRows: inTrack(account, track) }), floors: { early: LEADS_EARLY, solid: LEADS_SOLID, tired: FREQ_TIRED } };
}

// ── across every gym ─────────────────────────────────────────────────────────
// One gym's account is a small sample; the portfolio is a larger one. But a lead costs different money in each
// account (another currency, another suburb, another offer), so costs are never pooled raw: a value's cost per
// lead is measured against ITS OWN gym's overall cost per lead in the scope (all spend over all leads — the same
// kind of figure, so the values of an attribute average out to 1), and those ratios are what is pooled. An index of
// 0.80 reads "20% cheaper than each gym's own average"; how many gyms agree is said beside it. (The first cut used
// the median of the ads with 5+ leads as the baseline: a value's total includes the ads that spent for nothing, the
// median does not, and nearly every value read as a loser — 2026-11-10.)
/**
 * A per-format shot guide from the gym's own winners (Phase 3, 2026-11-10): among its still ads read as `format` — the
 * whole history that was after leads — what each backdrop, subject, pose, expression and gaze cost per lead. By rule,
 * no model. `lines` are what the scene drafter is told, each value with its leads and cost per lead (5+ leads only),
 * the cheapest first; null when the gym has no ad of that format with a lead. Only ever the gym's OWN ads.
 */
export const GUIDE_ATTRIBUTES = ["backdrop", "subject", "pose", "expression", "eye_contact"];
export const formatGuide = (gymDir, format, opts = {}) => formatGuideFrom(gymRowsRead(gymDir), format, opts);
/** The same from rows already joined to their readings (pure). */
export function formatGuideFrom(every, format, { currency = "SGD" } = {}) {
  const rows = inTrack(every, "stills").filter((r) => r.read?.format === format);
  const leads = rows.reduce((t, r) => t + (r.leads || 0), 0);
  if (!rows.length || !leads) return null;
  const lines = [];
  for (const t of attributeTables(rows).filter((x) => GUIDE_ATTRIBUTES.includes(x.key))) {
    const vals = t.values.filter((v) => v.leads >= LEADS_EARLY && v.cost_per_lead != null).sort((a, b) => a.cost_per_lead - b.cost_per_lead);
    if (vals.length) lines.push(`${t.label}: ${vals.map((v) => `${v.value} (${v.leads} leads at ${money(v.cost_per_lead, currency)})`).join(", ")}`);
  }
  return { format, ads: rows.length, leads, spend: round2(rows.reduce((t, r) => t + (r.spend || 0), 0)), lines };
}

// ── drafting scenes from the results (2026-11-11) ────────────────────────────
// The scene drafter knew the library's gaps, the owner's words or a reference image — never what the gym's own ads
// had done. This is what it is told when the owner asks for scenes "from the results": per kind of photograph the
// agent makes, what each kind of shot cost per lead, and the gym's best PICTURES with what they showed. By rule, no
// model; only ever the gym's own ads (stills, after leads, the home country).
/** Which picture a row's ad shows: the batch's photo for this app's ads, the image for the account's. */
export const pictureKey = (r) => (r.source === "app" ? `${r.batch}/${r.photos}` : (Array.isArray(r.hashes) && r.hashes[0]) || r.creative_file || r.thumbnail || r.ad_id);
/** The kind of photograph the agent makes that a picture's reading is: a class or group shot is a workout scene with a group in it. */
export const READ_KIND = { workout: "workout", "class-group": "workout", "studio-portrait": "studio-portrait" };
const MAKEABLE = new Set(Object.values(READ_KIND));
/** The kind of photograph an ad's picture is, as a scene would be drafted for it: this app's ad is what its batch says; any other, what its reading says; a card, a premises photo or an unread picture is none. */
export const sceneKindOf = (r) => (r.format ? (MAKEABLE.has(r.format) ? r.format : null) : READ_KIND[r.read?.format] || null);
/** The scene tags this app's own ads carry on their rows (one photo per ad: a joined value is skipped). */
const GUIDE_ROW_TAGS = [["setting", "Setting"], ["equipment", "Equipment"], ["exercise", "Exercise"], ["age_tag", "Age"]];
export const WINNERS_MAX = 4;
/**
 * What the drafter is told for one kind of photograph: { format, scope, ads, leads, spend, median, lines[], winners[] }, or
 * null when the gym has no ad of that kind with a lead. The ads running now or made in the last 6 months when they
 * have 20+ leads between them (an old campaign's offer and prices would otherwise set the median: Jurong West's 2024
 * trial ads put it at SGD 58 against the running campaign's 17), else every ad the gym ran. `lines`: each attribute's values with 5+ leads and their cost per
 * lead, the cheapest first. `winners`: its best pictures — one picture run in several places counts once — with 10+
 * leads at or under the ACCOUNT's median cost per lead in that scope (every still, whatever its kind: a kind's own
 * median would call its only ad a winner — Sculpt Society's one portrait at SGD 43 against an account at 22), the most leads first; each says the scene it was made from when
 * this app made it (`scenes`: the library's scenes, any state), else what the reading saw.
 */
export function sceneGuideFrom(every, format, { currency = "SGD", scenes = [], now = new Date() } = {}) {
  const stills = inTrack(every, "stills"), kind = stills.filter((r) => sceneKindOf(r) === format), sumLeads = (x) => x.reduce((t, r) => t + (r.leads || 0), 0);
  const recent = inScope(kind, "recent", { now }), scope = sumLeads(recent) >= LEADS_SOLID ? "recent" : "all", rows = scope === "recent" ? recent : kind;
  const leads = sumLeads(rows);
  if (!rows.length || !leads) return null;
  const lines = [], say = (label, vals) => { const v = vals.filter((x) => x.leads >= LEADS_EARLY && x.cost_per_lead != null).sort((a, b) => a.cost_per_lead - b.cost_per_lead); if (v.length) lines.push(`${label}: ${v.map((x) => `${x.value} (${x.leads} leads at ${money(x.cost_per_lead, currency)})`).join(", ")}`); };
  const keys = format === "workout" ? ["subject", ...GUIDE_ATTRIBUTES.filter((k) => k !== "subject")] : GUIDE_ATTRIBUTES;
  const tables = attributeTables(rows);
  // A workout scene is one person, a coached pair or a group: what the readings called the shot says which.
  if (format === "workout") say("Kind of shot", tally(rows.filter((r) => r.read?.format), (r) => r.read.format));
  for (const k of keys) { const t = tables.find((x) => x.key === k); if (t) say(t.label, t.values); }
  if (format === "workout") for (const [col, label] of GUIDE_ROW_TAGS) say(`${label} (the ads this app made)`, tally(rows.filter((r) => r.source === "app"), (r) => r[col]));
  const median = medianCpl(scope === "recent" ? inScope(stills, "recent", { now }) : stills), byId = new Map(scenes.filter((s) => s && s.id).map((s) => [s.id, s]));
  const pics = new Map();
  for (const r of rows) { const k = pictureKey(r), p = pics.get(k) || pics.set(k, { ads: 0, leads: 0, spend: 0, row: r }).get(k); p.ads++; p.leads += r.leads || 0; p.spend += r.spend || 0; if ((r.leads || 0) > (p.row.leads || 0)) p.row = r; }
  const winners = median == null ? [] : [...pics.values()].map((p) => ({ ...p, cost_per_lead: p.leads ? round2(p.spend / p.leads) : null })).filter((p) => p.leads >= LEADS_KEEP && p.cost_per_lead <= median).sort((a, b) => b.leads - a.leads || a.cost_per_lead - b.cost_per_lead).slice(0, WINNERS_MAX)
    .map((p) => { const r = p.row, sc = r.source === "app" && r.scenes && !String(r.scenes).includes("+") ? byId.get(r.scenes) : null, d = r.read;
      const saw = d ? [d.format, d.subject && d.subject !== "none" ? d.subject : null, d.backdrop, d.pose, d.expression].filter(Boolean).join(", ") : null;
      return { name: adName(r), ads: p.ads, leads: p.leads, cost_per_lead: p.cost_per_lead, scene_id: sc?.id || null, scene: sc?.scene || null, saw, text: `${p.leads} leads at ${money(p.cost_per_lead, currency)}${p.ads > 1 ? ` over ${p.ads} ads` : ""} — ${sc?.scene ? `made from this scene: ${sc.scene}` : saw ? `the picture shows: ${saw}` : adName(r)}` }; });
  return { format, scope, ads: rows.length, leads, spend: round2(rows.reduce((t, r) => t + (r.spend || 0), 0)), median, lines, winners };
}
/** Values of one row field among rows: ads, leads, spend, cost per lead (a joined value — two photos in one ad — is skipped). */
function tally(rows, get) {
  const m = new Map();
  for (const r of rows) { const v = get(r); if (v == null || v === "" || String(v).includes("+")) continue; const x = m.get(v) || m.set(v, { value: v, ads: 0, spend: 0, leads: 0 }).get(v); x.ads++; x.spend += r.spend || 0; x.leads += r.leads || 0; }
  return [...m.values()].map((x) => ({ ...x, spend: round2(x.spend), cost_per_lead: x.leads ? round2(x.spend / x.leads) : null }));
}
/** The guide for a gym folder: its rows and its scene library as they are on disk. */
export function sceneGuide(gymDir, format, opts = {}) {
  let scenes = []; try { scenes = JSON.parse(readFileSync(join(gymDir, "scenes.json"), "utf-8")).scenes || []; } catch { scenes = []; }
  return sceneGuideFrom(gymRowsRead(gymDir), format, { ...opts, scenes });
}

// ── the mix suggestion (Phase 4, 2026-11-10) ─────────────────────────────────
// How a gym's next batches should be shared between the kinds of photograph the agent can make, from the gym's own
// lead-form results. By rule, no model, one step at a time, and only ever a suggestion: the owner saves it or not.
/** One suggestion moves this many points; no format the gym makes drops under the floor (testing never stops) or passes the cap. */
export const MIX_STEP = 10, MIX_FLOOR = 20, MIX_CAP = 80;
/**
 * `rows`: the gym's rows joined to their readings (stills). `formats`: the kinds the agent can make, in order.
 * `current`: the gym's mix in shares summing to 100. Returns { current, suggested, changed, formats[], reasons[],
 * median } — `formats` carries each kind's ads, leads, spend, cost per lead, its ratio to the median and a confidence word.
 *   · a kind with 20+ leads at 85% of the account's median cost per lead or less gains a step, taken from the dearest
 *     other kind (one with results first), down to the floor;
 *   · else a kind with 20+ leads at 125% of the median or more gives a step to the cheapest other kind that has 20+ leads itself;
 *   · a kind the gym has never run keeps (or is given) the floor, so it gets tested;
 *   · anything thinner than 20 leads moves nothing, and that is said.
 */
export function mixSuggestionFrom(rows, { formats, current, currency = "SGD" } = {}) {
  const stills = inTrack(rows, "stills"), median = medianCpl(stills);
  const stat = formats.map((f) => {
    const x = stills.filter((r) => valueOf(r, "format") === f), spend = round2(x.reduce((a, r) => a + (r.spend || 0), 0)), leads = x.reduce((a, r) => a + (r.leads || 0), 0);
    const cpl = leads ? round2(spend / leads) : null;
    return { format: f, ads: x.length, spend, leads, cost_per_lead: cpl, vs_median: cpl != null && median ? round2(cpl / median) : null, confidence: confidence(leads), share: current[f] || 0 };
  });
  const next = Object.fromEntries(formats.map((f) => [f, current[f] || 0])), reasons = [];
  const cap = Math.min(MIX_CAP, 100 - MIX_FLOOR * (formats.length - 1));
  const move = (from, to, n) => { const m = Math.min(n, next[from] - MIX_FLOOR, cap - next[to]); if (m > 0) { next[from] -= m; next[to] += m; } return Math.max(0, m); };
  const say = (s) => `${s.format} (${s.leads} leads at ${money(s.cost_per_lead, currency)})`;
  // A kind never run, or with no share at all: it gets the floor from the largest share, so it is tested.
  for (const s of stat) if (next[s.format] < MIX_FLOOR && formats.length > 1) {
    const from = formats.filter((f) => f !== s.format).sort((a, b) => next[b] - next[a])[0];
    const m = Math.min(MIX_FLOOR - next[s.format], next[from] - MIX_FLOOR);
    if (m > 0) { next[from] -= m; next[s.format] += m; reasons.push(`${s.format} ${(current[s.format] || 0) === 0 ? "is not in the mix yet" : "is under the floor"}${s.ads ? "" : " and has never run in this account"}: give it ${next[s.format]}% so it is tested (the floor is ${MIX_FLOOR}%).`); }
  }
  const solid = stat.filter((s) => s.confidence === "solid" && s.vs_median != null).sort((a, b) => a.cost_per_lead - b.cost_per_lead);
  const win = solid.find((s) => s.vs_median <= CHEAP), lose = [...solid].reverse().find((s) => s.vs_median >= LOSES);
  if (win) {
    const others = stat.filter((s) => s.format !== win.format).sort((a, b) => (b.cost_per_lead ?? -1) - (a.cost_per_lead ?? -1) || next[b.format] - next[a.format]);
    let moved = 0, from = null;
    for (const o of others) { moved = move(o.format, win.format, MIX_STEP); if (moved) { from = o; break; } }
    if (moved) reasons.push(`${say(win)} is ${Math.round((1 - win.vs_median) * 100)}% under this account's median of ${money(median, currency)}: +${moved} points, from ${from.format}${from.leads ? ` (${from.leads} leads at ${money(from.cost_per_lead, currency)})` : ""}.`);
    else reasons.push(`${say(win)} leads, and is already at its cap of ${cap}% (the others keep ${MIX_FLOOR}% each so testing never stops).`);
  } else if (lose) {
    // Share only moves toward a kind that has proven itself: 20+ leads of its own, cheaper than the dear one. (A thin kind's
    // few cheap leads pull the median down and would make the proven kind look dear.)
    const to = stat.filter((s) => s.format !== lose.format && s.confidence === "solid" && s.cost_per_lead < lose.cost_per_lead).sort((a, b) => a.cost_per_lead - b.cost_per_lead)[0];
    const moved = to ? move(lose.format, to.format, MIX_STEP) : 0;
    if (!to) { /* nothing proven to move to: the thin kinds are named below */ }
    else if (moved) reasons.push(`${say(lose)} is ${Math.round((lose.vs_median - 1) * 100)}% over this account's median of ${money(median, currency)}: −${moved} points, to ${to.format}.`);
    else reasons.push(`${say(lose)} is dear, and is already at the floor of ${MIX_FLOOR}%.`);
  }
  for (const s of stat) if (s.ads && s.confidence !== "solid") reasons.push(`${s.format}: ${s.leads} lead${s.leads === 1 ? "" : "s"} so far — too few to move the mix (it takes ${LEADS_SOLID}).`);
  if (!reasons.length) reasons.push(median == null ? "No lead-form results to learn from yet: the mix stays as it is." : "No kind is clearly cheaper or dearer than the account's median: the mix stays as it is.");
  const suggested = Object.fromEntries(Object.entries(next).filter(([, n]) => n > 0));
  const changed = formats.some((f) => (suggested[f] || 0) !== (current[f] || 0));
  return { current, suggested, changed, formats: stat, reasons, median, floor: MIX_FLOOR, cap, step: MIX_STEP };
}
/** The same for a gym on disk: its own account's stills (the lead ads in its history and this app's own). */
export function mixSuggestion(gymDir, { now = new Date(), ...opts } = {}) {
  // The owner's window: the last six months (running now included); the whole history only when that is empty.
  const every = gymRowsRead(gymDir);
  let scope = "recent", rows = inScope(every, scope, { now });
  if (!rows.length) { scope = "all"; rows = every; }
  return { ...mixSuggestionFrom(rows, opts), scope };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
/** Attributes that say something about a creative anywhere (an offer's name or a gym's own campaign does not travel). Media only when both tracks are read together. */
export const PORTABLE = ["format", "subject", "backdrop", "pose", "expression", "ratio", "text_density", "logo", "eye_contact"];
/** A value wins across gyms at 85% of the gyms' medians or less; loses at 125% or more. */
export const LOSES = 1.25;

/** Every gym folder with a profile, with its rows in scope and its own median. */
export function gymsFor(brandsDir, { scope = "recent", track = "all", now = new Date() } = {}) {
  if (!existsSync(brandsDir)) return [];
  return readdirSync(brandsDir).filter((n) => !n.startsWith(".") && !n.startsWith("_") && existsSync(join(brandsDir, n, "gym-profile.json")) && statSync(join(brandsDir, n)).isDirectory()).sort().map((gym) => {
    const dir = join(brandsDir, gym), profile = readJson(join(dir, "gym-profile.json")) || {}, h = readJson(join(dir, "account-history.json"));
    const { rows: every, left_out } = gymRowsSplit(dir), scoped = inScope(every, scope, { now }), rows = inTrack(scoped, track);
    const u = unreadCount(dir), leadsIn = rows.reduce((t, r) => t + (r.leads || 0), 0), spendIn = rows.reduce((t, r) => t + (r.spend || 0), 0);
    return { gym, name: profile.display_name || gym, country: profile.locale?.country || "SG", currency: profile.locale?.currency || "SGD", account: profile.meta_assets?.ad_account_id || null,
      pulled: h?.pulled || null, exports: (h?.exports || []).map((e) => ({ file: e.file, to: e.reporting?.to || null, ads: e.ads })), every: every.length, active: every.filter(isActive).length, ads: rows.length, read: rows.filter((r) => r.read).length,
      leads: leadsIn, spend: round2(spendIn), median: medianCpl(rows), base: leadsIn >= LEADS_SOLID ? round2(spendIn / leadsIn) : null, tracks: trackSums(scoped), left_out, pictures: u.pictures, unread: u.unread, rows };
  });
}
/** The pooled tables: for each portable attribute, each value's leads, ads, gyms, and its index against the gyms' own medians. */
export function poolTables(gyms, { withMedia = false } = {}) {
  const withMedian = gyms.filter((g) => g.base);
  return ATTRIBUTES.filter(([k]) => PORTABLE.includes(k) || (withMedia && k === "media")).map(([key, label]) => {
    const by = new Map();
    for (const g of withMedian) for (const r of g.rows) {
      const v = valueOf(r, key); if (v == null) continue;
      const e = by.get(v) || by.set(v, { value: v, ads: 0, leads: 0, units: 0, spend_by_currency: {}, per: new Map() }).get(v);
      const pg = e.per.get(g.gym) || e.per.set(g.gym, { gym: g.gym, name: g.name, currency: g.currency, ads: 0, leads: 0, spend: 0 }).get(g.gym);
      e.ads++; e.leads += r.leads || 0; e.units += (r.spend || 0) / g.base; e.spend_by_currency[g.currency] = round2((e.spend_by_currency[g.currency] || 0) + (r.spend || 0));
      pg.ads++; pg.leads += r.leads || 0; pg.spend = round2(pg.spend + (r.spend || 0));
    }
    const values = [...by.values()].map((e) => {
      const per = [...e.per.values()].map((x) => { const g = withMedian.find((y) => y.gym === x.gym); const cpl = x.leads ? round2(x.spend / x.leads) : null; return { ...x, cost_per_lead: cpl, rel: cpl != null ? round2(cpl / g.base) : null }; }).sort((a, b) => b.leads - a.leads);
      const judged = per.filter((x) => x.leads >= LEADS_EARLY && x.rel != null);
      return { value: e.value, ads: e.ads, leads: e.leads, spend_by_currency: e.spend_by_currency, index: e.leads ? round2(e.units / e.leads) : null, confidence: confidence(e.leads), gyms: per, tried_in: per.length, judged_in: judged.length, cheaper_in: judged.filter((x) => x.rel < 1).length, dearer_in: judged.filter((x) => x.rel > 1).length };
    }).sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || b.leads - a.leads);
    return { key, label, values };
  });
}
const pct = (index) => { const d = Math.round((1 - index) * 100); return d >= 0 ? `${d}% under` : `${-d}% over`; };
/** Does a pooled value hold: solid leads, judged in two gyms or more, and cheaper in more of them than dearer. */
const holds = (v) => v.index != null && v.confidence === "solid" && v.judged_in >= 2 && v.cheaper_in > v.dearer_in;
/** The portfolio's findings in words, by rule. */
export function acrossSuggestions(gyms, tables) {
  const out = [];
  for (const t of tables) for (const v of t.values) {
    if (holds(v) && v.index <= CHEAP) out.push({ kind: "wins", attribute: t.key, value: v.value, text: `${t.label}: ${v.value} leads ${pct(v.index)} each gym's own average — ${v.leads} leads, cheaper in ${v.cheaper_in} of the ${v.judged_in} gyms with enough of it (${v.gyms.filter((x) => x.leads >= LEADS_EARLY).map((x) => x.name).join(", ")}).` });
    else if (v.index != null && v.confidence === "solid" && v.judged_in >= 2 && v.dearer_in > v.cheaper_in && v.index >= LOSES) out.push({ kind: "loses", attribute: t.key, value: v.value, text: `${t.label}: ${v.value} leads ${pct(v.index)} each gym's own average — ${v.leads} leads, dearer in ${v.dearer_in} of ${v.judged_in} gyms.` });
    else if (v.index != null && v.confidence === "solid" && v.judged_in === 1 && v.index <= CHEAP && gyms.filter((g) => g.base).length > 1) out.push({ kind: "one-gym", attribute: t.key, value: v.value, text: `${t.label}: ${v.value} leads ${pct(v.index)} the average at ${v.gyms[0].name} (${v.gyms[0].leads} leads) and no other gym has enough of it to judge. Worth a test elsewhere.` });
  }
  const order = { wins: 0, "one-gym": 1, loses: 2 };
  out.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const g of gyms) {
    if (!g.every) out.push({ kind: "no-data", gym: g.gym, text: `${g.name}: no ads read from its account yet${g.account ? " — refresh the accounts" : " — no ad account on its profile"}.` });
    else if (!g.base) out.push({ kind: "thin", gym: g.gym, text: `${g.name}: ${g.leads} lead${g.leads === 1 ? "" : "s"} in this scope, under the ${LEADS_SOLID} it takes for an average of its own, so it draws on the other gyms.` });
    if (g.unread) out.push({ kind: "unread", gym: g.gym, text: `${g.name}: ${g.unread} of ${g.pictures} pictures not read yet.` });
  }
  return out;
}
/** Everything the portfolio view shows. */
export function whatWinsAcross(brandsDir, { scope = "recent", track = "stills", now = new Date() } = {}) {
  const gyms = gymsFor(brandsDir, { scope, track, now }), tables = poolTables(gyms, { withMedia: track === "all" });
  const both = (t) => { const ads = gyms.reduce((a, g) => a + g.tracks[t].ads, 0), leads = gyms.reduce((a, g) => a + g.tracks[t].leads, 0); return { ads, leads }; };
  return { scope, track, tracks: { stills: both("stills"), video: both("video") }, gyms: gyms.map(({ rows, ...g }) => g), leads: gyms.reduce((t, g) => t + g.leads, 0), ads: gyms.reduce((t, g) => t + g.ads, 0), tables, suggestions: acrossSuggestions(gyms, tables), floors: { early: LEADS_EARLY, solid: LEADS_SOLID, cheap: CHEAP, loses: LOSES }, _gyms: gyms };
}
/**
 * What one gym's next batch should lean on, attribute by attribute: its own account first (two solid values a quarter
 * apart or more), else what holds across the other gyms. Each line says where it comes from and whether the gym has run it.
 */
export function nextWave(gym, across, { currency = "SGD" } = {}) {
  const g = (across._gyms || []).find((x) => x.gym === gym); if (!g) return [];
  const own = attributeTables(g.rows, { median: g.median }), out = [];
  for (const key of (across.tables || []).map((x) => x.key).filter((k) => k !== "media")) {
    const t = own.find((x) => x.key === key), label = t.label;
    const solid = t.values.filter((v) => v.cost_per_lead != null && v.confidence === "solid");
    if (solid.length >= 2 && solid[solid.length - 1].cost_per_lead / solid[0].cost_per_lead >= 1.25) {
      const b = solid[0], w = solid[solid.length - 1];
      out.push({ attribute: key, label, value: b.value, source: "own", text: `${label}: ${b.value} — this gym's own leads (${b.leads} at ${money(b.cost_per_lead, currency)} against ${w.value}'s ${w.leads} at ${money(w.cost_per_lead, currency)}).` });
      continue;
    }
    const pooled = (across.tables.find((x) => x.key === key)?.values || []).find((v) => holds(v) && v.index <= CHEAP);
    if (pooled) {
      const mine = t.values.find((v) => v.value === pooled.value), others = pooled.gyms.filter((x) => x.gym !== gym && x.leads >= LEADS_EARLY);
      if (!others.length) continue;
      out.push({ attribute: key, label, value: pooled.value, source: "portfolio", tried_here: !!mine, text: `${label}: ${pooled.value} — across ${pooled.judged_in} gyms it leads ${pct(pooled.index)} each gym's own average (${pooled.leads} leads; ${others.map((x) => x.name).join(", ")}). ${mine ? `Here: ${mine.leads} lead${mine.leads === 1 ? "" : "s"} so far${mine.cost_per_lead != null ? ` at ${money(mine.cost_per_lead, currency)}` : ""}.` : "Not run here yet."}` });
    }
  }
  return out;
}

// ── every account, refreshed and read ────────────────────────────────────────
/** One gym's account pulled again: its history, its own campaigns' results, its delivered ads' pictures. Read-only on Meta; no model call. A step that fails is said and the rest go on. */
export async function refreshGym({ gymDir, account, client }) {
  const steps = {};
  try { const h = await pullAccountHistory({ client, accountId: account, gymDir }); steps.history = `${h.campaigns.length} campaigns, ${h.ads.length} ads`; } catch (e) { steps.history = `failed: ${scrubTokens(e.message)}`; }
  const outDir = join(gymDir, "outputs");
  if (existsSync(outDir)) for (const id of readdirSync(outDir)) {
    const rec = readJson(join(outDir, id, "publish.json")); if (!rec?.campaign?.id) continue;
    try { await pullResults({ client, record: rec, batchDir: join(outDir, id) }); steps[`results ${id}`] = "pulled"; } catch (e) { steps[`results ${id}`] = `failed: ${scrubTokens(e.message)}`; }
  }
  try { const p = await fetchPictures({ client, accountId: account, gymDir }); steps.pictures = `${p.fetched} fetched, ${p.kept} already here${p.skipped.length ? `, ${p.skipped.length} skipped` : ""}`; } catch (e) { steps.pictures = `failed: ${scrubTokens(e.message)}`; }
  return steps;
}
/** Pull every gym's account again (history, the app's own campaigns' results, the delivered ads' pictures). Read-only on Meta; no model call. */
export async function refreshAll({ brandsDir, log = console.log, clientFor = (gym) => { const config = metaConfig({ gym }); return config.token ? graphClient({ config }) : null; } }) {
  const done = [];
  for (const g of gymsFor(brandsDir, { scope: "all" })) {
    const dir = join(brandsDir, g.gym), d = { gym: g.gym, steps: {} };
    if (!g.account) { log(`${g.name}: no ad account on its profile — skipped`); d.skipped = "no ad account"; done.push(d); continue; }
    const client = clientFor(g.gym);
    if (!client) { log(`${g.name}: the Meta link is not set up — skipped`); d.skipped = "no Meta link"; done.push(d); continue; }
    d.steps = await refreshGym({ gymDir: dir, account: g.account, client });
    const u = unreadCount(dir); d.pictures = u.pictures; d.unread = u.unread;
    log(`${g.name}: ${Object.entries(d.steps).map(([k, v]) => `${k} ${v}`).join(" · ")} · ${u.unread} of ${u.pictures} pictures not read yet`);
    done.push(d);
  }
  return done;
}
/** Read every gym's unread pictures under one cap for the whole portfolio (one vision call per picture). */
export async function readAll({ brandsDir, max = 100, log = console.log, ask }) {
  let left = max; const done = [];
  for (const g of gymsFor(brandsDir, { scope: "all" })) {
    const dir = join(brandsDir, g.gym);
    if (!g.unread) { done.push({ gym: g.gym, read: 0, left: 0 }); continue; }
    try { const d = await readCreatives({ gymDir: dir, max: left, log: (m) => log(`  ${g.gym}: ${m}`), ...(ask ? { ask } : {}) }); left -= d.calls; done.push({ gym: g.gym, read: d.read, left: d.left, failed: d.skipped.filter((x) => /reading failed/.test(x)).length }); log(`${g.name}: read ${d.read}${d.left ? `, ${d.left} left for another run` : ""}`); }
    catch (e) { log(`${g.name}: ${e.message}`); done.push({ gym: g.gym, error: e.message }); }
  }
  return { gyms: done, calls: max - left };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brands-dir": { type: "string" }, all: { type: "boolean", default: false }, refresh: { type: "boolean", default: false }, read: { type: "boolean", default: false }, max: { type: "string", default: "100" }, scope: { type: "string", default: "recent" }, track: { type: "string", default: "stills" }, gym: { type: "string" } } });
  if (!(v.all || v.refresh || v.read || v.gym)) { console.error("Usage: what-wins.mjs (--all | --gym <slug>) [--scope active|recent|all] [--track stills|video|all] | --refresh | --read [--max 100]   [--brands-dir <dir>]"); process.exit(1); }
  const brandsDir = v["brands-dir"] ? resolve(v["brands-dir"]) : join(REPO_ROOT, "brands");
  try {
    if (v.refresh) await refreshAll({ brandsDir });
    if (v.read) { const d = await readAll({ brandsDir, max: parseInt(v.max, 10) || 100 }); console.log(`${d.calls} call(s) in all`); }
    if (v.all || v.gym) {
      const A = whatWinsAcross(brandsDir, { scope: SCOPES.includes(v.scope) ? v.scope : "recent", track: TRACKS.includes(v.track) ? v.track : "stills" });
      console.log(`track ${A.track} (stills ${A.tracks.stills.leads} leads over ${A.tracks.stills.ads} ads · video ${A.tracks.video.leads} over ${A.tracks.video.ads}) · scope ${A.scope}: ${A.leads} leads over ${A.ads} ads in ${A.gyms.length} gyms`);
      for (const g of A.gyms) console.log(`  ${g.name.padEnd(22)} ${g.currency} ads ${String(g.ads).padStart(4)} read ${String(g.read).padStart(4)} leads ${String(g.leads).padStart(5)} average ${String(g.base ?? "—").padStart(8)} median ${String(g.median ?? "—").padStart(8)} active ${String(g.active).padStart(3)} unread ${g.unread}/${g.pictures} pulled ${String(g.pulled || (g.exports.length ? "export" : "never")).slice(0, 10)}`);
      for (const t of A.tables) if (t.values.length) console.log(`${t.label}: ` + t.values.map((x) => `${x.value} ${x.index ?? "—"}× ${x.leads}L ${x.cheaper_in}/${x.judged_in}g ${x.confidence}`).join(" | "));
      for (const s2 of A.suggestions) console.log(`- ${s2.kind}: ${s2.text}`);
      if (v.gym) { console.log(`\nFor ${v.gym}'s next batch:`); const g = A.gyms.find((x) => x.gym === v.gym); for (const n of nextWave(v.gym, A, { currency: g?.currency })) console.log(`  [${n.source}] ${n.text}`); }
    }
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
