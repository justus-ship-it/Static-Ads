/**
 * meta-targeting.mjs — a gym's detailed-targeting presets: what its ad sets may name beyond the pin,
 * the age range and the gender (interests, behaviours, demographics, custom audiences, exclusions).
 *
 *   brands/{gym}/targeting-presets.json
 *   { schema: 1, account, imported, presets: [{ id, name, source, spec, summary, stats, examples, notes, retired }] }
 *
 * Where presets come from, in order:
 *   1. the account's own history — every distinct targeting its ad sets have run, with what it cost
 *      and what it brought (Meta's insights: spend, leads) — `importPresets`; nothing is guessed, the
 *      ids are the ones Meta already accepted;
 *   2. the account's saved audiences (made in Ads Manager);
 *   3. the owner, from Meta's own targeting search (`addPreset`).
 * "Broad" (no detailed targeting) is always there, with its own record, so it can be compared.
 *
 * A preset's `spec` is exactly what goes into an ad set's `targeting` beside the pin, ages and gender:
 * `flexible_spec` (groups AND-ed, items within a group OR-ed), `exclusions`, `custom_audiences`,
 * `excluded_custom_audiences`. Two ad sets with the same spec, whatever the order Meta lists it in,
 * are the same preset (`fingerprint`).
 *
 * Suggesting one (`rankPresets`): the presets that ran for this gender first, then the ones whose
 * words match the offer or the audience callout, then the cheapest lead — every reason said in words.
 * Never Advantage+ audience: a preset never carries `targeting_automation`.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";
import { metaConfig, graphClient, actId, scrubTokens } from "./meta-api.mjs";
import { calloutGender } from "./client-config.mjs";

export const FILE = "targeting-presets.json";
export const BROAD = "broad";
export const MAX_PRESETS = 60;
/** The keys of a targeting a preset may carry; everything else (pin, ages, gender) is per ad set. */
export const SPEC_KEYS = ["flexible_spec", "exclusions", "custom_audiences", "excluded_custom_audiences"];
/** What a flexible_spec group may name, as Meta names them. */
export const GROUP_KEYS = ["interests", "behaviors", "life_events", "industries", "income", "family_statuses", "education_statuses", "education_schools", "education_majors", "work_positions", "work_employers", "relationship_statuses", "politics", "user_adclusters", "home_type", "home_ownership", "household_composition", "generation", "office_type", "user_device", "user_os", "connections", "friends_of_connections"];
const ID = /^\d{5,20}$/;
const today = () => new Date().toISOString().slice(0, 10);
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ── the spec ─────────────────────────────────────────────────────────────────
/** Only the preset keys, in a fixed order, items sorted by id — the same targeting always reads the same. */
export function normaliseSpec(targeting) {
  const t = targeting || {}, out = {};
  const items = (list) => (Array.isArray(list) ? list : []).map((x) => (isObj(x) ? { id: String(x.id), ...(x.name ? { name: String(x.name) } : {}) } : { id: String(x) })).filter((x) => x.id).sort((a, b) => a.id.localeCompare(b.id));
  const group = (g) => { const o = {}; for (const k of Object.keys(g || {}).sort()) { const v = items(g[k]); if (v.length) o[k] = v; } return o; };
  const groups = (list) => (Array.isArray(list) ? list : []).map(group).filter((g) => Object.keys(g).length).sort((a, b) => JSON.stringify(idsOnly(a)).localeCompare(JSON.stringify(idsOnly(b))));
  const fs = groups(t.flexible_spec); if (fs.length) out.flexible_spec = fs;
  const ex = group(t.exclusions); if (Object.keys(ex).length) out.exclusions = ex;
  for (const k of ["custom_audiences", "excluded_custom_audiences"]) { const v = items(t[k]); if (v.length) out[k] = v; }
  return out;
}
const idsOnly = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.id)]));
/** The same targeting → the same 12 characters, whatever names or order Meta sent. */
export function fingerprint(spec) {
  const n = normaliseSpec(spec);
  const bare = { flexible_spec: (n.flexible_spec || []).map(idsOnly), exclusions: idsOnly(n.exclusions || {}), custom_audiences: (n.custom_audiences || []).map((x) => x.id), excluded_custom_audiences: (n.excluded_custom_audiences || []).map((x) => x.id) };
  if (!bare.flexible_spec.length && !Object.keys(bare.exclusions).length && !bare.custom_audiences.length && !bare.excluded_custom_audiences.length) return BROAD;
  return createHash("sha256").update(JSON.stringify(bare)).digest("hex").slice(0, 12);
}
const KIND_WORDS = { interests: "interests", behaviors: "behaviours", life_events: "life events", work_positions: "job titles", work_employers: "employers", education_statuses: "education", family_statuses: "family", relationship_statuses: "relationships", income: "income", industries: "industries", home_ownership: "home ownership", household_composition: "household", generation: "generation" };
/** The spec in words, one line per part: "Physical fitness, Health club +4 (interests)", "AND …", "not Members-List". */
export function summarise(spec) {
  const n = normaliseSpec(spec), lines = [];
  const namesOf = (items, max = 3) => { const names = items.map((x) => x.name || x.id); return names.slice(0, max).join(", ") + (names.length > max ? ` +${names.length - max}` : ""); };
  const groupWords = (g) => Object.entries(g).map(([k, v]) => `${namesOf(v)} (${KIND_WORDS[k] || k.replace(/_/g, " ")})`).join("; ");
  (n.flexible_spec || []).forEach((g, i) => lines.push(`${i ? "AND " : ""}${groupWords(g)}`));
  if (n.custom_audiences) lines.push(`audience: ${namesOf(n.custom_audiences, 4)}`);
  if (n.exclusions) lines.push(`not ${groupWords(n.exclusions)}`);
  if (n.excluded_custom_audiences) lines.push(`not ${namesOf(n.excluded_custom_audiences, 4)}`);
  return lines.length ? lines : ["Broad — no detailed targeting"];
}
/** Their ad-set names carry the audience: "… | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60" → "Fitness+Fatherhood". */
export function audienceLabel(adsetName) {
  const m = String(adsetName || "").match(/Audience:\s*([^|]+)/i);
  if (!m) return null;
  const parts = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  const label = parts.find((p, i) => i > 0 && !/^(male|female|men|women|all|any)$/i.test(p) && !/^\d{2}\s*[-–]\s*\d{2}\+?$/.test(p) && !/\d\s*km/i.test(p));
  return label || null;
}
/** A name for a preset nobody named yet: the ad sets' own audience label when they carry one, else its first interests. */
export function nameFor(spec, examples = []) {
  const labels = examples.map(audienceLabel).filter(Boolean);
  if (labels.length) { const count = {}; for (const l of labels) count[l] = (count[l] || 0) + 1; return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0]; }
  const n = normaliseSpec(spec);
  if (!n.flexible_spec?.length) {
    if (n.custom_audiences) return `Audience: ${n.custom_audiences.map((x) => x.name || x.id).slice(0, 2).join(", ")}`;
    return "Broad";
  }
  return n.flexible_spec.map((g) => Object.values(g).flat().slice(0, 2).map((x) => (x.name || x.id).replace(/\s*\(.*?\)\s*$/, "")).join(" / ")).join(" + ");
}
/** The first two named items of a spec, for telling two presets apart. */
const firstItems = (spec) => { const n = normaliseSpec(spec); const items = [...(n.flexible_spec || []).flatMap((g) => Object.values(g).flat()), ...(n.custom_audiences || [])]; return items.slice(0, 2).map((x) => (x.name || x.id).replace(/\s*\(.*?\)\s*$/, "")).join(", ") || "no items"; };
/** Why a preset cannot be used — ids that are not Meta ids, keys Meta does not know, an empty group. */
export function specProblems(spec) {
  const e = [];
  if (!isObj(spec)) return ["a preset's targeting must be an object"];
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.includes(k)) e.push(`"${k}" is not something a preset may carry (the pin, ages and gender are set per ad set; Advantage+ audience never)`);
  const checkGroup = (g, where) => {
    if (!isObj(g)) { e.push(`${where}: not a group`); return; }
    if (!Object.keys(g).length) e.push(`${where}: an empty group`);
    for (const [k, v] of Object.entries(g)) {
      if (!GROUP_KEYS.includes(k)) e.push(`${where}: "${k}" is not a kind of targeting Meta knows`);
      if (!Array.isArray(v) || !v.length) e.push(`${where}: ${k} needs at least one item`);
      for (const x of Array.isArray(v) ? v : []) if (!ID.test(String(isObj(x) ? x.id : x))) e.push(`${where}: ${k} has an item without a Meta id`);
    }
  };
  if (spec.flexible_spec != null) { if (!Array.isArray(spec.flexible_spec)) e.push("flexible_spec must be a list of groups"); else spec.flexible_spec.forEach((g, i) => checkGroup(g, `group ${i + 1}`)); }
  if (spec.exclusions != null) checkGroup(spec.exclusions, "exclusions");
  for (const k of ["custom_audiences", "excluded_custom_audiences"]) if (spec[k] != null) { if (!Array.isArray(spec[k])) e.push(`${k} must be a list`); else for (const x of spec[k]) if (!ID.test(String(isObj(x) ? x.id : x))) e.push(`${k} has an item without a Meta id`); }
  return e;
}

// ── the file ─────────────────────────────────────────────────────────────────
const empty = () => ({ schema: 1, account: null, imported: null, presets: [] });
export function readPresets(gymDir) {
  const p = join(gymDir, FILE);
  if (!existsSync(p)) return empty();
  try { const j = JSON.parse(readFileSync(p, "utf-8")); return { ...empty(), ...j, presets: Array.isArray(j.presets) ? j.presets : [] }; } catch { return empty(); }
}
export function writePresets(gymDir, data) { writeWhole(join(gymDir, FILE), JSON.stringify(data, null, 2) + "\n"); return data; }
/** The presets an ad set may pick: live ones, Broad first. */
export const livePresets = (data) => data.presets.filter((p) => !p.retired).sort((a, b) => (a.id === BROAD ? -1 : b.id === BROAD ? 1 : 0));
const broadPreset = () => ({ id: BROAD, name: "Broad", source: "built-in", spec: {}, summary: summarise({}), stats: null, examples: [], notes: "", retired: null });

// ── import from the account ─────────────────────────────────────────────────
/**
 * Every distinct targeting the account's ad sets have run → a preset with its record; the saved
 * audiences too. Names, notes and retirements the owner set are kept; stats and examples refreshed.
 */
/** The countries an ad set's targeting names, beside its pins (a pin carries its own country). */
export const adsetCountries = (t) => [...new Set([...((t?.geo_locations?.countries) || []), ...((t?.geo_locations?.custom_locations) || []).map((p) => p.country), ...((t?.geo_locations?.places) || []).map((p) => p.country_code || p.country), ...((t?.geo_locations?.cities) || []).map((c) => c.country)].filter(Boolean).map((c) => String(c).toUpperCase()))];
/** Does the ad set reach people outside the gym's country? (Sculpt Society's cheapest "leads" were all from Bangladesh, 2026-09-18.) */
export const isAbroad = (t, home = "SG") => adsetCountries(t).some((c) => c !== String(home).toUpperCase());
export async function importPresets({ client, accountId, gymDir, now = new Date().toISOString(), home = null }) {
  const before = readPresets(gymDir);
  home = home || (() => { try { return JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf-8")).locale?.country || "SG"; } catch { return "SG"; } })();
  const sets = await client.adsetHistory(accountId);
  const insights = await client.adsetInsights(accountId, { datePreset: "maximum" });
  const byAdset = new Map(insights.map((r) => [r.adset_id, r]));
  const saved = await client.savedAudiences(accountId).catch(() => []);
  const found = new Map();
  for (const s of sets) {
    const spec = normaliseSpec(s.targeting), id = fingerprint(spec);
    const cur = found.get(id) || { id, spec, adsets: [], spend: 0, leads: 0, impressions: 0, genders: { men: 0, women: 0, all: 0 }, ages: {}, first: null, last: null, abroad: { adsets: 0, spend: 0, leads: 0, countries: [] } };
    const ins = byAdset.get(s.id);
    // An ad set reaching outside the gym's country is counted apart: its leads say nothing about people near the gym.
    if (isAbroad(s.targeting, home)) { cur.abroad.adsets++; if (ins) { cur.abroad.spend += ins.spend; cur.abroad.leads += ins.leads; } for (const c of adsetCountries(s.targeting)) if (c !== home.toUpperCase() && !cur.abroad.countries.includes(c)) cur.abroad.countries.push(c); found.set(id, cur); continue; }
    cur.adsets.push(s.name); if (ins) { cur.spend += ins.spend; cur.leads += ins.leads; cur.impressions += ins.impressions; }
    const g = s.targeting?.genders, gk = !g?.length ? "all" : g.includes(1) && !g.includes(2) ? "men" : g.includes(2) && !g.includes(1) ? "women" : "all";
    cur.genders[gk]++;
    if (s.targeting?.age_min != null) { const a = `${s.targeting.age_min}-${s.targeting.age_max ?? "65+"}`; cur.ages[a] = (cur.ages[a] || 0) + 1; }
    const made = (s.created_time || "").slice(0, 10), used = (s.updated_time || s.created_time || "").slice(0, 10);
    if (made && (!cur.first || made < cur.first)) cur.first = made;
    if (used && (!cur.last || used > cur.last)) cur.last = used;
    found.set(id, cur);
  }
  const keep = new Map(before.presets.map((p) => [p.id, p]));
  const presets = [];
  const stats = (c) => ({ adsets: c.adsets.length, spend: Math.round(c.spend * 100) / 100, leads: c.leads, impressions: c.impressions, cost_per_lead: c.leads ? Math.round((c.spend / c.leads) * 100) / 100 : null, genders: c.genders, ages: Object.entries(c.ages).sort((a, b) => b[1] - a[1]).map(([a]) => a), first_used: c.first, last_used: c.last, ...(c.abroad.adsets ? { abroad: { adsets: c.abroad.adsets, spend: Math.round(c.abroad.spend * 100) / 100, leads: c.abroad.leads, countries: c.abroad.countries } } : {}) });
  // Broad, always, with the record of the ad sets that ran broad.
  const broad = found.get(BROAD);
  presets.push({ ...broadPreset(), ...(keep.get(BROAD) ? { notes: keep.get(BROAD).notes || "" } : {}), stats: broad ? stats(broad) : null, examples: broad ? [...new Set(broad.adsets)].slice(0, 5) : [] });
  for (const [id, c] of found) {
    if (id === BROAD) continue;
    if (!c.adsets.length && c.abroad.adsets && !keep.get(id)) continue; // only ever run abroad: not a preset for this gym
    const old = keep.get(id), examples = [...new Set(c.adsets)].slice(0, 5);
    presets.push({ id, name: old?.renamed ? old.name : nameFor(c.spec, c.adsets), source: old?.source === "owner" ? "owner" : "account", spec: c.spec, summary: summarise(c.spec), stats: stats(c), examples, notes: old?.notes || "", renamed: !!old?.renamed, retired: old?.retired || null, added: old?.added || now.slice(0, 10) });
  }
  for (const a of saved) {
    const spec = normaliseSpec(a.targeting), id = fingerprint(spec);
    if (id === BROAD) continue;
    const at = presets.find((p) => p.id === id);
    if (at) { at.saved_audience = { id: a.id, name: a.name }; continue; }
    const old = keep.get(id);
    presets.push({ id, name: old?.renamed ? old.name : a.name, source: "saved_audience", spec, summary: summarise(spec), stats: null, examples: [], saved_audience: { id: a.id, name: a.name }, size: a.approximate_count_lower_bound ?? null, notes: old?.notes || "", renamed: !!old?.renamed, retired: old?.retired || null, added: old?.added || now.slice(0, 10) });
  }
  // The owner's own presets, and anything imported before that the account no longer shows, stay.
  for (const p of before.presets) if (!presets.some((q) => q.id === p.id)) presets.push(p);
  // Two presets with the same derived name (their ad sets carried the same label): each says what sets it apart.
  const byName = {};
  for (const p of presets) if (!p.renamed) (byName[p.name] ||= []).push(p);
  for (const same of Object.values(byName)) if (same.length > 1) for (const p of same) p.name = `${p.name} · ${firstItems(p.spec)}`;
  const data = { schema: 1, account: actId(accountId), imported: now, presets };
  writePresets(gymDir, data);
  return { data, added: presets.filter((p) => !keep.has(p.id)).length, adsets: sets.length, with_results: insights.length, saved: saved.length };
}

// ── the owner's changes ─────────────────────────────────────────────────────
export function renamePreset(gymDir, id, { name, notes }) {
  const data = readPresets(gymDir), p = data.presets.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  if (name != null) { const n = String(name).trim(); if (!n || n.length > 80 || /[\r\n]/.test(n)) throw new Error("a preset's name is one line, up to 80 characters"); if (id === BROAD && n !== "Broad") throw new Error("Broad keeps its name"); p.name = n; p.renamed = true; }
  if (notes != null) { if (typeof notes !== "string" || notes.length > 500) throw new Error("notes are up to 500 characters"); p.notes = notes; }
  writePresets(gymDir, data); return p;
}
export function retirePreset(gymDir, id, reason) {
  const data = readPresets(gymDir), p = data.presets.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  if (id === BROAD) throw new Error("Broad cannot be retired");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("a reason is needed to retire a preset");
  p.retired = { on: today(), reason: reason.trim() };
  writePresets(gymDir, data); return p;
}
export function restorePreset(gymDir, id) {
  const data = readPresets(gymDir), p = data.presets.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  p.retired = null; writePresets(gymDir, data); return p;
}
/** A preset the owner built from Meta's search: named items in groups (AND between groups), exclusions, audiences. */
export function addPreset(gymDir, { name, spec, notes = "" }) {
  const problems = specProblems(spec);
  if (problems.length) throw new Error(problems.join("; "));
  const n = String(name || "").trim();
  if (!n || n.length > 80 || /[\r\n]/.test(n)) throw new Error("a preset needs a one-line name, up to 80 characters");
  const data = readPresets(gymDir);
  if (!data.presets.some((p) => p.id === BROAD)) data.presets.unshift(broadPreset());
  const clean = normaliseSpec(spec), id = fingerprint(clean);
  if (id === BROAD) throw new Error("that is Broad — no detailed targeting — which is always there");
  const at = data.presets.find((p) => p.id === id);
  if (at) { if (at.retired) { at.retired = null; at.name = n; at.renamed = true; writePresets(gymDir, data); return at; } throw new Error(`the same targeting is already the preset "${at.name}"`); }
  if (livePresets(data).length >= MAX_PRESETS) throw new Error(`no more than ${MAX_PRESETS} presets — retire one first`);
  const p = { id, name: n, source: "owner", spec: clean, summary: summarise(clean), stats: null, examples: [], notes: String(notes || "").slice(0, 500), renamed: true, retired: null, added: today() };
  data.presets.push(p); writePresets(gymDir, data); return p;
}

// ── suggesting one ──────────────────────────────────────────────────────────
const words = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9+ ]/g, " ").split(/[\s+]+/).filter((w) => w.length > 2 && !STOP.has(w)));
const STOP = new Set(["the", "and", "for", "week", "weeks", "challenge", "wanted", "audience", "with", "thomson", "bishan", "copy", "ladies", "men", "women", "male", "female", "all"]);
/**
 * The presets in the order worth suggesting them for this ad set, each with why. `gender` is the
 * callout's ("men" | "women" | "all"); `words` the offer and audience callout.
 */
export function rankPresets(data, { gender = "all", words: text = "", minLeads = 5 } = {}) {
  const want = words(text);
  const scored = livePresets(data).map((p) => {
    const st = p.stats, why = [];
    const ranFor = st ? (gender === "all" ? st.genders.all : st.genders[gender]) : 0;
    if (ranFor) why.push(`ran for ${gender === "all" ? "everyone" : gender} ${ranFor} time${ranFor === 1 ? "" : "s"}`);
    const mine = words(`${p.name} ${(p.examples || []).join(" ")} ${(p.summary || []).join(" ")}`);
    const overlap = [...want].filter((w) => mine.has(w));
    if (overlap.length) why.push(`matches ${overlap.slice(0, 3).join(", ")}`);
    const cpl = st && st.leads >= minLeads ? st.cost_per_lead : null;
    if (cpl != null) why.push(`${st.leads} leads at ${cpl.toFixed(2)} each over ${st.adsets} ad set${st.adsets === 1 ? "" : "s"}`);
    else if (st?.adsets) why.push(`${st.adsets} ad set${st.adsets === 1 ? "" : "s"}, ${st.leads} lead${st.leads === 1 ? "" : "s"}`);
    if (st?.abroad) why.push(`(${st.abroad.adsets} ad set${st.abroad.adsets === 1 ? "" : "s"} reaching ${st.abroad.countries.join(", ")} left out: ${st.abroad.leads} leads there)`);
    else if (p.source === "saved_audience") why.push("a saved audience in Ads Manager, not run yet");
    else if (p.source === "owner") why.push("built here, not run yet");
    return { preset: p, ranFor, overlap: overlap.length, cpl, why };
  });
  scored.sort((a, b) => (b.ranFor > 0) - (a.ranFor > 0) || b.overlap - a.overlap || (a.cpl ?? 1e9) - (b.cpl ?? 1e9) || (b.preset.stats?.adsets || 0) - (a.preset.stats?.adsets || 0));
  return scored.map((s) => ({ id: s.preset.id, name: s.preset.name, why: s.why.join(" · ") || "no record yet" }));
}
/** The preset for an audience callout: the profile's own choice, else the best suggestion, else Broad. */
export function presetFor(data, profile, { audience, offer } = {}) {
  const map = profile?.targeting_defaults?.detailed_targeting?.callout_presets || {};
  const key = Object.keys(map).find((k) => k.trim().toUpperCase() === String(audience || "").trim().toUpperCase());
  const chosen = key ? map[key] : "suggest";
  if (chosen && chosen !== "suggest") { const p = livePresets(data).find((x) => x.id === chosen); if (p) return { preset: p, how: "the profile's choice" }; }
  const ranked = rankPresets(data, { gender: calloutGender(audience, profile), words: `${offer || ""} ${audience || ""}` });
  const top = ranked[0] && livePresets(data).find((p) => p.id === ranked[0].id);
  return top ? { preset: top, how: chosen === "suggest" ? `suggested: ${ranked[0].why}` : "the profile's choice is gone; suggested instead" } : { preset: broadPreset(), how: "nothing to suggest yet" };
}
/** A preset's spec as it goes into an ad set's targeting (a copy, ids and names only). */
export const specForAdset = (preset) => structuredClone(normaliseSpec(preset?.spec || {}));

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, import: { type: "boolean", default: false }, list: { type: "boolean", default: false }, search: { type: "string" }, suggest: { type: "string" }, gender: { type: "string", default: "all" } } });
  if (!v.gym) { console.error("Usage: meta-targeting.mjs --gym <slug> (--import | --list | --search <words> | --suggest <offer words> [--gender men|women|all])"); process.exit(1); }
  try {
    const gymDir = join(REPO_ROOT, "brands", v.gym);
    const profile = JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf-8"));
    const accountId = profile.meta_assets?.ad_account_id;
    if (v.import || v.search) {
      const config = metaConfig({ gym: v.gym });
      if (!config.token) throw new Error(`no ${config.names.META_ACCESS_TOKEN} in .env`);
      if (!accountId) throw new Error("the profile has no ad account yet (Meta link)");
      const client = graphClient({ config });
      if (v.import) { const r = await importPresets({ client, accountId, gymDir }); console.log(`imported: ${r.adsets} ad sets (${r.with_results} with results), ${r.saved} saved audiences → ${r.data.presets.length} presets, ${r.added} new`); }
      if (v.search) for (const x of await client.targetingSearch(accountId, v.search)) console.log(`  ${x.id}  ${x.name}  [${x.type}]  ${x.path.join(" › ")}  ${x.size_lower != null ? `~${x.size_lower.toLocaleString()}` : ""}`);
    }
    if (v.list || v.import) for (const p of livePresets(readPresets(gymDir))) console.log(`${p.id.padEnd(12)}  ${p.name}${p.saved_audience ? ` (saved audience "${p.saved_audience.name}")` : ""}\n    ${p.summary.join("\n    ")}\n    ${p.stats ? `${p.stats.adsets} ad sets · ${p.stats.spend} spent · ${p.stats.leads} leads${p.stats.cost_per_lead != null ? ` · ${p.stats.cost_per_lead}/lead` : ""} · men ${p.stats.genders.men} / women ${p.stats.genders.women} / all ${p.stats.genders.all} · ${p.stats.first_used} → ${p.stats.last_used}` : "no record"}`);
    if (v.suggest != null) for (const r of rankPresets(readPresets(gymDir), { gender: v.gender, words: v.suggest })) console.log(`  ${r.id.padEnd(12)}  ${r.name}  — ${r.why}`);
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
