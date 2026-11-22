/**
 * Targeting changed in Ads Manager (2026-11-22). Sculpt Society's "0924 Bishan" ad set was moved by hand to a dropped
 * point and "0924 Ang Mo Kio" to another place, and the app never knew: a pull compared names and budgets only, and a
 * later create from that batch could have put the app's own targeting back over the change.
 *
 *   · what the app sent is on the ad set's record (`targeting`, from this date; an older record has its facts: the Meta
 *     place, radius, ages, gender and preset — a dropped point is not among them, so it is not compared);
 *   · `targetingDiff(sent, live)` — the pin, the ages, the gender, the detailed targeting, Advantage+ audience: each
 *     part that differs, in words. A part that is not known on one side is never called different;
 *   · a pull says each difference (`targetingItems`, part of results.json → drift), and the owner settles it:
 *     Keep Ads Manager's (`takeTargeting`: the campaign's settings, and for a pin the gym's saved pins, follow Meta) or
 *     Put the app's back (`acknowledge`: the next create sends the app's again);
 *   · until then a create NEVER overwrites a change made by hand (`changedByHand`, asked of Meta before an ad set is
 *     updated): the ad set keeps its targeting on Meta and the run says so.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fingerprint, normaliseSpec, summarise, readPresets, addPreset, restorePreset, nameFor, BROAD } from "./meta-targeting.mjs";
import { addPinTo, validateProfile } from "./client-config.mjs";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, o) => { writeFileSync(p + ".tmp", JSON.stringify(o, null, 2) + "\n"); renameSync(p + ".tmp", p); };
const km = (p) => (p.radius == null ? null : Math.round((p.distance_unit === "mile" ? Number(p.radius) * 1.609344 : Number(p.radius)) * 10) / 10);
const num = (v) => (v == null || v === "" ? null : Number(v));
export const TARGETING_KINDS = ["adset_pin", "adset_ages", "adset_gender", "adset_detail", "adset_advantage"];

/** A targeting as it compares: { geo, types, ages, gender, spec, advantage }; a part Meta or the app did not give is null. */
export function canon(t) {
  if (!t || typeof t !== "object") return null;
  const g = t.geo_locations, others = g ? ["countries", "regions", "cities", "zips", "geo_markets", "neighborhoods", "subcities", "country_groups", "places", "custom_locations"].flatMap((k) => (Array.isArray(g[k]) ? g[k].map((x) => ({ k, x })) : [])) : [];
  const geo = g ? others.map(({ k, x }) => (k === "places" ? { kind: "place", key: String(x.key), name: x.name || null, lat: num(x.latitude), lng: num(x.longitude), radius_km: km(x) }
    : k === "custom_locations" ? { kind: "point", lat: num(x.latitude), lng: num(x.longitude), radius_km: km(x) } : { kind: k, key: typeof x === "object" ? String(x.key ?? x.id ?? x.name) : String(x), name: typeof x === "object" ? x.name || null : String(x), radius_km: typeof x === "object" ? km(x) : null })) : null;
  const gs = Array.isArray(t.genders) ? t.genders.map(Number).filter((x) => x === 1 || x === 2) : null;
  return { geo, types: Array.isArray(g?.location_types) ? [...g.location_types].sort() : null, ages: t.age_min != null && t.age_max != null ? [Number(t.age_min), Number(t.age_max)] : null,
    gender: gs && gs.length === 1 ? (gs[0] === 1 ? "men" : "women") : "all", spec: normaliseSpec(t), advantage: Number(t.targeting_automation?.advantage_audience) === 1 };
}
/** What the app last sent, as it compares: the record's own targeting, else (an older record) what its facts say. */
export function sentCanon(had, presets = { presets: [] }) {
  if (had?.targeting) return canon(had.targeting);
  const f = had?.facts; if (!f) return null;
  const preset = f.preset_id === BROAD ? { spec: {} } : (presets.presets || []).find((p) => p.id === f.preset_id);
  return { geo: f.place_key ? [{ kind: "place", key: String(f.place_key), name: f.pin || null, radius_km: f.radius_km ?? null }] : null, types: null, ages: f.age_min != null && f.age_max != null ? [Number(f.age_min), Number(f.age_max)] : null, gender: f.gender || null, spec: preset ? normaliseSpec(preset.spec || {}) : null, advantage: false };
}
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.0002;
const sameSpot = (a, b) => a.kind === b.kind && (a.kind === "point" ? near(a.lat, b.lat) && near(a.lng, b.lng) : a.key === b.key) && (a.radius_km == null || b.radius_km == null || Math.abs(a.radius_km - b.radius_km) < 0.06);
const sameGeo = (a, b) => a.length === b.length && a.every((x) => b.some((y) => sameSpot(x, y)));
const r4 = (n) => Math.round(n * 1e4) / 1e4;
export const geoWords = (geo) => (geo || []).map((x) => `${x.kind === "point" ? `the point ${r4(x.lat)}, ${r4(x.lng)}` : x.name || `${x.kind} ${x.key}`}${x.radius_km ? ` + ${x.radius_km} km` : ""}`).join(" and ") || "no place";
/** Each part that differs: [{ kind, app, meta }] in words. A part unknown on either side is not compared. */
export function targetingDiff(sent, live) {
  if (!sent || !live) return [];
  const out = [], W = { men: "men", women: "women", all: "everyone" };
  if (sent.geo && live.geo && (!sameGeo(sent.geo, live.geo) || (sent.types && live.types && sent.types.join() !== live.types.join()))) out.push({ kind: "adset_pin", app: geoWords(sent.geo) + (sameGeo(sent.geo, live.geo) ? ` (${sent.types.join(" and ")})` : ""), meta: geoWords(live.geo) + (sameGeo(sent.geo, live.geo) ? ` (${live.types.join(" and ")})` : "") });
  if (sent.ages && live.ages && sent.ages.join() !== live.ages.join()) out.push({ kind: "adset_ages", app: sent.ages.join("-"), meta: live.ages.join("-") });
  if (sent.gender && live.gender && sent.gender !== live.gender) out.push({ kind: "adset_gender", app: W[sent.gender], meta: W[live.gender] });
  if (sent.spec && live.spec && fingerprint(sent.spec) !== fingerprint(live.spec)) out.push({ kind: "adset_detail", app: summarise(sent.spec).join(" · "), meta: summarise(live.spec).join(" · ") });
  if (live.advantage && !sent.advantage) out.push({ kind: "adset_advantage", app: "off", meta: "on" });
  return out;
}
const NAMES = { adset_pin: "place", adset_ages: "ages", adset_gender: "gender", adset_detail: "detailed targeting", adset_advantage: "Advantage+ audience" };
/** What a pull says of one ad set's targeting. `live` is Meta's targeting of it. */
export function targetingItems(callout, had, live, presets) {
  const L = canon(live); if (!L) return [];
  return targetingDiff(sentCanon(had, presets), L).map((d) => {
    const one = L.geo?.length === 1 && ["place", "point"].includes(L.geo[0].kind) && L.geo[0].radius_km >= 1 && L.geo[0].radius_km <= 80;
    const keep = d.kind === "adset_advantage" ? false : d.kind === "adset_pin" ? one : true;
    const why = d.kind === "adset_advantage" ? " — your rule is never: turn it off in Ads Manager" : keep ? "" : " — the app holds one place with a radius, so this is kept only in Ads Manager";
    return { kind: d.kind, callout, meta: d.meta, app: d.app, fixable: keep, back: true, text: `ad set ${callout}'s ${NAMES[d.kind]} on Meta: ${d.meta}; the app sent ${d.app}${why}. A create leaves Ads Manager's targeting as it is until you choose` };
  });
}
/** Asked before an ad set on Meta is updated: the parts changed there by hand since the app last sent them. */
export const changedByHand = (had, live, presets) => (live ? targetingDiff(sentCanon(had, presets), canon(live)) : []);

const dirs = (batchDir) => { const gymDir = resolve(batchDir, "..", ".."); return { gymDir, sp: join(batchDir, "publish-settings.json"), rp: join(batchDir, "publish.json"), xp: join(batchDir, "results.json") }; };
const dropLines = (xp, callout, kinds) => { const x = readJson(xp); if (!x) return []; x.drift = (x.drift || []).filter((d) => !(kinds.includes(d.kind) && d.callout === callout)); writeWhole(xp, x); return x.drift; };
/**
 * Keep Ads Manager's: the campaign's settings follow Meta for that part — a pin joins the gym's saved pins (at the end;
 * an earlier campaign's settings name a pin by its place in the list), a detailed targeting the presets — and the record
 * holds Meta's targeting as what was last sent, for that part, so the next create changes nothing there.
 */
export function takeTargeting(batchDir, { kind, callout }) {
  const { gymDir, sp, rp, xp } = dirs(batchDir), results = readJson(xp), rec = readJson(rp), had = rec?.adsets?.[callout];
  const item = (results?.drift || []).find((d) => d.kind === kind && d.callout === callout), live = had ? results?.adsets?.[had.id]?.targeting : null;
  if (!item || !live) throw new Error("that difference is not in the last pull: pull results again");
  if (!item.fixable) throw new Error("the app cannot hold that: it stays in Ads Manager");
  const L = canon(live), settings = readJson(sp) || {}, set = { ...((settings.adsets || {})[callout] || {}) };
  if (kind === "adset_pin") {
    const pf = join(gymDir, "gym-profile.json"), profile = readJson(pf), g = L.geo[0];
    set.pin = addPinTo(profile, { label: g.name || `${callout} (Ads Manager)`, lat: g.lat, lng: g.lng, place_key: g.kind === "place" ? g.key : "", place_name: g.kind === "place" ? g.name || "" : "", radius_km: g.radius_km, location_types: L.types?.filter((t) => ["home", "recent"].includes(t)), source: "ads-manager" }); set.radius_km = null;
    const { errors } = validateProfile(profile, { gymDir }); if (errors.length) throw new Error(errors[0]);
    writeWhole(pf, profile);
  } else if (kind === "adset_ages") { set.age_min = L.ages[0]; set.age_max = L.ages[1]; }
  else if (kind === "adset_gender") set.gender = L.gender;
  else if (kind === "adset_detail") {
    const id = fingerprint(L.spec), at = readPresets(gymDir).presets.find((p) => p.id === id);
    if (at?.retired) restorePreset(gymDir, id);
    else if (!at && id !== BROAD) addPreset(gymDir, { name: `${nameFor(L.spec)}`.slice(0, 66) + " (Ads Manager)", spec: L.spec, notes: `set in Ads Manager on ad set ${callout}` });
    set.preset = id;
  } else throw new Error(`"${kind}" is not something to take from Meta`);
  settings.adsets = { ...(settings.adsets || {}), [callout]: set }; settings.updated = new Date().toISOString();
  // What was last sent, now with Meta's version of this part.
  const was = had.targeting || null, part = { adset_pin: ["geo_locations"], adset_ages: ["age_min", "age_max"], adset_gender: ["genders"], adset_detail: ["flexible_spec", "exclusions", "custom_audiences", "excluded_custom_audiences"] }[kind];
  if (was) { for (const k of part) { if (live[k] === undefined) delete was[k]; else was[k] = live[k]; } had.targeting = was; }
  else { const f = (had.facts ||= {}); if (kind === "adset_pin") { f.place_key = L.geo[0].kind === "place" ? L.geo[0].key : null; f.radius_km = L.geo[0].radius_km; f.pin = L.geo[0].name || `${callout} (Ads Manager)`; } if (kind === "adset_ages") { f.age_min = L.ages[0]; f.age_max = L.ages[1]; } if (kind === "adset_gender") f.gender = L.gender; if (kind === "adset_detail") f.preset_id = set.preset; }
  writeWhole(sp, settings); writeWhole(rp, rec);
  return { settings, drift: dropLines(xp, callout, [kind]) };
}
/** Put the app's back: Meta's targeting is known and not wanted; the next create sends the app's own. */
export function acknowledge(batchDir, { callout }) {
  const { rp, xp } = dirs(batchDir), results = readJson(xp), rec = readJson(rp), had = rec?.adsets?.[callout], live = had ? results?.adsets?.[had.id]?.targeting : null;
  if (!had || !live) throw new Error("that ad set's targeting is not in the last pull: pull results again");
  had.targeting = live; had.key = null; had.put_back = new Date().toISOString();
  writeWhole(rp, rec);
  return { drift: dropLines(xp, callout, TARGETING_KINDS) };
}
