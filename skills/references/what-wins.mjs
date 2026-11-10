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

import { allRows } from "./meta-results.mjs";
import { readsFor, FORMATS } from "./read-creatives.mjs";

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
  const r = row.read; if (!r) return null;
  if (key === "logo" || key === "eye_contact") return yesNo(r[key]);
  return r[key] ?? null;
}
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
    const values = [...by.entries()].map(([value, rs]) => { const s = sum(rs); return { value, ...s, cost_per_lead: s.leads ? round2(s.spend / s.leads) : null, share: totalLeads ? round2((s.leads / totalLeads) * 100) : 0, vs_median: s.leads && median ? round2(s.spend / s.leads / median) : null, confidence: confidence(s.leads) }; })
      .sort((a, b) => (a.cost_per_lead ?? Infinity) - (b.cost_per_lead ?? Infinity) || b.leads - a.leads || b.spend - a.spend);
    return { key, label, values, unread, unread_leads: unreadLeads };
  });
}
/** The ads shown too often: active, with a frequency at or over the bar, the most shown first. */
export const fatigueRows = (rows) => rows.filter((r) => (r.frequency || 0) >= FREQ_TIRED && /active/i.test(r.status || "")).sort((a, b) => b.frequency - a.frequency);

const adName = (r) => r.ad_name || (r.folder ? `${r.batch}/${r.folder.replace(/^\d+-/, "")}` : r.ad_id);
const kindOf = (r) => { const d = r.read; if (!d) return r.media || "ad"; return [d.format, d.subject !== "none" ? d.subject : null, d.backdrop].filter(Boolean).join(", "); };
const money = (n, cur) => (n == null ? "—" : `${cur} ${Number(n).toFixed(2)}`);

/** What to do, by rule. Each item: { kind, text, ads?, attribute? }. Nothing here acts. */
export function suggestions(rows, tables, { median = medianCpl(rows), currency = "SGD", everyRows = rows } = {}) {
  const out = [], total = rows.reduce((t, r) => t + (r.leads || 0), 0);
  const active = rows.filter((r) => /active/i.test(r.status || ""));
  if (total < LEADS_SOLID) out.push({ kind: "thin", text: `Too few leads to conclude anything yet: ${total} in all. Let the current ads run to ${LEADS_SOLID} before changing the mix.` });
  if (median == null) { out.push({ kind: "thin", text: `No ad has ${LEADS_EARLY} leads yet, so there is no median cost per lead to compare against.` }); return out; }
  const keep = active.filter((r) => (r.leads || 0) >= LEADS_KEEP && r.cost_per_lead != null && r.cost_per_lead <= CHEAP * median).sort((a, b) => b.leads - a.leads);
  for (const r of keep.slice(0, 6)) out.push({ kind: "keep", ads: [r.ad_id], text: `Keep running: ${adName(r)} — ${r.leads} leads at ${money(r.cost_per_lead, currency)} against a median of ${money(median, currency)} (${kindOf(r)}).` });
  for (const r of fatigueRows(active)) {
    const cheap = keep.includes(r);
    out.push({ kind: "tiring", ads: [r.ad_id], text: `Tiring: ${adName(r)} has been seen ${r.frequency} times per person${cheap ? " and still leads cheaply" : ""}. Make new versions of the same kind (${kindOf(r)}) before it fades${cheap ? "" : ", or let it go"}.` });
  }
  const retire = active.filter((r) => ((r.leads || 0) >= LEADS_EARLY && r.cost_per_lead >= DEAR * median) || (!(r.leads || 0) && (r.spend || 0) >= 2 * median)).sort((a, b) => (b.cost_per_lead ?? -1) - (a.cost_per_lead ?? -1));
  for (const r of retire.slice(0, 6)) out.push({ kind: "pause", ads: [r.ad_id], text: `Consider pausing: ${adName(r)} — ${r.leads ? `${r.leads} leads at ${money(r.cost_per_lead, currency)}` : `${money(r.spend, currency)} spent for no lead`} (${kindOf(r)}).` });
  // The attribute whose values differ most, among values with solid leads on both sides (a 7-lead value proves nothing).
  const gaps = tables.map((t) => { const vs = t.values.filter((v) => v.cost_per_lead != null && v.confidence === "solid"); if (vs.length < 2) return null; const best = vs[0], worst = vs[vs.length - 1]; return { t, best, worst, gap: round2(worst.cost_per_lead / best.cost_per_lead) }; }).filter((g) => g && g.gap >= 1.25).sort((a, b) => b.gap - a.gap);
  for (const g of gaps.slice(0, 3)) out.push({ kind: "matters", attribute: g.t.key, text: `${g.t.label} matters: ${g.best.value} leads at ${money(g.best.cost_per_lead, currency)} (${g.best.leads} leads) against ${g.worst.value} at ${money(g.worst.cost_per_lead, currency)} (${g.worst.leads}). Make more of the first.` });
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

/** The ads a scope keeps: "active" — the ads running now (the account's old campaigns would otherwise set the median); "all" — every ad the gym ran. */
export const SCOPES = ["active", "all"];
export const inScope = (rows, scope) => (scope === "active" ? rows.filter((r) => /active/i.test(r.status || "")) : rows);

/** Everything the Results page shows under What wins. The scope falls back to every ad when nothing is active. */
export function whatWins(gymDir, { currency = "SGD", scope = "active" } = {}) {
  const { byAd, total: pictures } = readsFor(gymDir);
  const every = joinReads(allRows(gymDir), byAd);
  let rows = inScope(every, scope);
  if (!rows.length && scope === "active") { scope = "all"; rows = every; }
  const median = medianCpl(rows), tables = attributeTables(rows, { median });
  return { scope, active: every.filter((r) => /active/i.test(r.status || "")).length, every: every.length, median, currency, ads: rows.length, read: rows.filter((r) => r.read).length, pictures, leads: rows.reduce((t, r) => t + (r.leads || 0), 0), spend: round2(rows.reduce((t, r) => t + (r.spend || 0), 0)),
    tables, fatigue: fatigueRows(rows).map((r) => ({ ad_id: r.ad_id, name: adName(r), frequency: r.frequency, leads: r.leads, cost_per_lead: r.cost_per_lead, kind: kindOf(r) })), suggestions: suggestions(rows, tables, { median, currency, everyRows: every }), floors: { early: LEADS_EARLY, solid: LEADS_SOLID, tired: FREQ_TIRED } };
}
