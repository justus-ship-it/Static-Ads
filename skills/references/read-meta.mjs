/**
 * read-meta.mjs — onboarding, part three: what the gym's own Facebook Page and ad account already know (2026-10-07).
 *
 * The website and Instagram readers are good at pictures and colours and nothing else; F45 Xinyi's onboarding found
 * no address, no pin, no offers and no budget while its Page carried the exact address (and the point Meta pins their
 * ads on), and its 106 ad sets showed the radius, ages, genders and budgets they run and the offers they named.
 * This reads those once into `brands/{gym}/onboarding/meta/reading.json` and proposes them; nothing is applied
 * until the owner accepts (`acceptMetaFacts`, on a copy of the profile validated first).
 *
 * Reads only. The Page's public fields need no Page token (a Page shared but not yet assigned still answers them).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { countryRules, profileCountry, pinUsable, validateProfile } from "./client-config.mjs";
import { addWording, wordingProblems } from "./ad-wordings.mjs";

export const META_DIR = "onboarding/meta";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const count = (items) => { const m = new Map(); for (const k of items) if (k != null && k !== "") m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

/** Currencies Meta counts in whole units (budgets of 500 are 500 of them); everything else is hundredths. Kept in step with meta-publish. */
const WHOLE = ["TWD", "JPY", "KRW", "VND", "CLP", "HUF", "ISK", "PYG", "UGX", "COP", "IDR"];
export const budgetUnits = (currency) => (WHOLE.includes(String(currency || "").toUpperCase()) ? 1 : 100);

/** The Page's opening hours, Meta's `{ mon_1_open: "09:00", mon_1_close: "21:00", … }`, as one readable line. */
export function hoursLine(hours) {
  if (!hours || typeof hours !== "object") return "";
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], names = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const parts = [];
  for (const d of days) {
    const spans = [];
    for (let i = 1; i <= 3; i++) { const o = hours[`${d}_${i}_open`], c = hours[`${d}_${i}_close`]; if (o && c) spans.push(`${o}-${c}`); }
    if (spans.length) parts.push(`${names[d]} ${spans.join(", ")}`);
  }
  return parts.join("; ");
}

/** The place the ads call out, from the address: a Chinese district (信義區), else the Page's city. */
export function calloutFrom(location = {}) {
  const street = oneLine(location.street), city = oneLine(location.city);
  // Taiwan: the district after the city or county (台北市信義區 → 信義區); a street that starts with the district still answers.
  const d = street.match(/(?:市|縣)([一-鿿]{1,3}區)/) || street.match(/^([一-鿿]{1,3}區)/);
  return d ? d[1] : city || "";
}

/**
 * An offer name as an ad set named it (their campaigns are test buckets — "Jan 8 2025 - Text Creative Testing - Blue";
 * their ad sets carry the offer: "0713 6 Week 中年體態雕塑", "0404 Male - 40天川字肌計畫 | Audience: …"): the date
 * prefix and a version tag off, the first "|" segment, a gender prefix off, a "照片 3" / "影片 1" suffix off. A bare
 * duration ("6 Week"), a test label or anything under four characters is nothing.
 */
export function offerNameFrom(name) {
  let t = oneLine(name).replace(/^\d{4}\s*[-|｜]?\s*/, "").replace(/^\(v\d+\)\s*/i, "");
  t = t.split(/\s*[|｜]\s*/)[0];
  t = t.replace(/^(Male|Female|Men|Women|Ladies|Gender Neutral)\s*[-–:]\s*/i, "").replace(/\s*[-–—]\s*(Gender Neutral|Male|Female|Men|Women|Ladies)\b.*$/i, "").replace(/\s+(照片|影片)\s*\d*$/, "").trim();
  if (!t || t.length < 4) return "";
  if (/\b(test|testing|retest|creative|audience|copy|video|headline|widenet|scale|tof|mof|bof|hiring|sales|rep|engagement|messaging|ad set)\b/i.test(t) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b\s*\d/i.test(t) || /^v\d/i.test(t) || /\//.test(t)) return "";
  if (/^\d*\s*(week|weeks|wk|days?)\s*$/i.test(t.replace(/\d+/, "")) || /^\d+\s*-?\s*(week|weeks|day|days)\s*(challenge|plan|program|programme)?$/i.test(t)) return "";
  return t;
}

/**
 * Read the Page and the ad account: { account, page, adsets, pins, offers, callouts }. `client` is the Meta client
 * (graphClient); `profile` gives the ids (meta_assets) — both are needed.
 */
export async function readMetaFacts({ client, profile, now = new Date().toISOString() }) {
  const m = profile?.meta_assets || {};
  const accountId = String(m.ad_account_id || "").trim(), pageId = String(m.page_id || "").trim();
  if (!accountId && !pageId) throw new Error("pick the gym's ad account and Facebook Page on the Meta link page first");
  const out = { schema: 1, read_at: now, gym: profile?.gym_id || null, account: null, page: null, adsets: null, pins: [], offers: [], callouts: [], problems: [] };
  if (accountId) {
    try {
      const a = await client.accountFacts(accountId);
      out.account = { id: a.id, account_id: a.account_id || null, name: a.name || null, currency: a.currency || null, timezone: a.timezone_name || null, country: a.business_country_code ? String(a.business_country_code).toUpperCase() : null, business: a.business ? { id: a.business.id, name: a.business.name } : null };
    } catch (e) { out.problems.push(`ad account: ${e.message}`); }
    try {
      const sets = await client.adsetHistory(accountId);
      const t = (s) => s.targeting || {};
      const ages = count(sets.map((s) => (t(s).age_min != null && t(s).age_max != null ? `${t(s).age_min}-${t(s).age_max}` : null))).map(([k, n]) => ({ min: Number(k.split("-")[0]), max: Number(k.split("-")[1]), adsets: n }));
      const genders = { all: 0, men: 0, women: 0 };
      for (const s of sets) { const g = t(s).genders; if (!g || !g.length || g.includes(0)) genders.all++; else if (g.includes(1)) genders.men++; else if (g.includes(2)) genders.women++; }
      const radius = count(sets.map((s) => num((t(s).geo_locations?.places || t(s).geo_locations?.custom_locations || [])[0]?.radius))).map(([k, n]) => ({ km: Number(k), adsets: n }));
      const units = budgetUnits(out.account?.currency);
      const budgets = sets.map((s) => num(s.daily_budget)).filter((x) => x != null).map((x) => x / units);
      const objectives = count(sets.map((s) => s.campaign?.objective || null)).map(([k, n]) => ({ objective: k, adsets: n }));
      out.adsets = { count: sets.length, ages, genders, radius_km: radius, daily_budget: budgets.length ? { median: median(budgets), min: Math.min(...budgets), max: Math.max(...budgets), units, currency: out.account?.currency || null } : null, objectives, last_created: sets.map((s) => s.created_time).filter(Boolean).sort().pop() || null };
      // The offers their campaigns and ad sets named, most used first.
      out.offers = count(sets.map((s) => offerNameFrom(s.name)).filter(Boolean)).slice(0, 12).map(([text, n]) => ({ text, adsets: n, problems: wordingProblems(text) }));
    } catch (e) { out.problems.push(`the account's ad sets: ${e.message}`); }
    try { out.pins = await client.historyPins(accountId); } catch (e) { out.problems.push(`the account's pins: ${e.message}`); }
  }
  if (pageId) {
    try {
      const p = await client.pageFacts(pageId);
      const loc = p.location || {};
      out.page = { id: p.id, name: p.name || null, username: p.username || null, category: p.category || null, fans: num(p.fan_count), phone: oneLine(p.phone), emails: Array.isArray(p.emails) ? p.emails : [], website: oneLine(p.website), about: oneLine(p.about).slice(0, 300), hours: hoursLine(p.hours),
        address: loc.street || loc.city ? { street: oneLine(loc.street), city: oneLine(loc.city), country: oneLine(loc.country), zip: oneLine(loc.zip), lat: num(loc.latitude), lng: num(loc.longitude), line: oneLine(p.single_line_address) || [loc.street, loc.city, loc.zip].filter(Boolean).map(oneLine).join(", ") } : null,
        instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || null } : null };
      const c = calloutFrom(loc); if (c) out.callouts.push(c);
    } catch (e) { out.problems.push(`the Facebook Page: ${e.message}`); }
  }
  // A pin the ads can use: the Page's own place (what their ad sets pin on, when they do), else the most-used pin.
  const own = out.page && out.pins.find((x) => x.kind === "place" && x.key === out.page.id);
  out.pin = own || out.pins[0] || (out.page?.address?.lat != null ? { kind: "point", key: null, name: out.page.name, lat: out.page.address.lat, lng: out.page.address.lng, radius_km: null, location_types: null, adsets: 0 } : null);
  if (out.pin && out.pin.radius_km == null) out.pin.radius_km = out.adsets?.radius_km?.[0]?.km ?? 5;
  return out;
}

export function writeMetaReading(gymDir, reading) { writeWhole(join(gymDir, META_DIR, "reading.json"), JSON.stringify(reading, null, 2) + "\n"); return reading; }
export const readMetaReading = (gymDir) => readJson(join(gymDir, META_DIR, "reading.json"));

/**
 * What the owner ticked, applied to the profile — on a copy first, validated, so a refused accept changes nothing:
 *   { locale, address, phone, website, instagram, facebook, hours, pin: { radius_km }, ages: { min, max }, budget: amount, offers: [text], callouts: [text] }
 * Returns { profile, changes, wordings } — the caller writes the profile. Offer wordings go to ad-wordings.json.
 */
export function acceptMetaFacts(gymDir, body = {}, { profile: given = null } = {}) {
  const r = readMetaReading(gymDir);
  if (!r) throw Object.assign(new Error("read the ad account first"), { status: 409 });
  const pf = join(gymDir, "gym-profile.json");
  const base = given || readJson(pf) || {};
  const changes = [];
  const edit = (profile, say) => {
    if (body.locale && r.account) {
      const country = r.account.country || profileCountry(profile), cr = countryRules(country), changed = country !== profileCountry(profile);
      const locale = { ...(profile.locale || {}) };
      if (country) locale.country = country;
      if (r.account.currency) locale.currency = r.account.currency;
      if (r.account.timezone) locale.timezone = r.account.timezone;
      // The language follows the country when the country changes (the starter's en_SG is Singapore's, not the owner's choice).
      if ((changed || !locale.languages?.length) && cr.languages.length) locale.languages = [...cr.languages];
      if ((changed || !locale.spelling) && cr.spelling) locale.spelling = cr.spelling;
      profile.locale = locale;
      const geo = ((profile.targeting_defaults ||= {}).geo ||= {}); if (country) geo.countries = [country];
      const dem = ((profile.targeting_defaults ||= {}).demographics ||= {}); if ((changed || !dem.locales?.length) && cr.languages.length) dem.locales = [...cr.languages];
      if (r.account.currency) (((profile.campaign_defaults ||= {}).budget ||= {}).currency = r.account.currency);
      // The starter's people line is Singapore's; a gym elsewhere gets its country's unless the owner wrote their own.
      const ph = ((profile.brand_lock ||= {}).photography ||= {}); if (!ph.people || ph.people === countryRules("SG").people) { ph.people = cr.people; say(`who is in the photos: ${cr.people}`); }
      say(`locale ${locale.country} · ${locale.currency} · ${locale.timezone}`);
    }
    if (body.address && r.page?.address) {
      const a = r.page.address, locs = (profile.locations ||= []);
      const row = { label: r.page.name || "", address: a.line || a.street, postal_code: a.zip || "", ...(a.lat != null ? { lat: a.lat, lng: a.lng } : {}), ...(body.phone && r.page.phone ? { phone: r.page.phone } : {}), ...(body.hours && r.page.hours ? { opening_hours: r.page.hours } : {}), source: "facebook-page" };
      const same = locs.findIndex((l) => (a.zip && String(l.postal_code) === a.zip && l.lat != null && Math.abs(l.lat - a.lat) < 0.002) || (l.address && a.line && l.address === a.line));
      const empty = locs.findIndex((l) => !l.address && !l.postal_code);
      if (same >= 0) { locs[same] = { ...locs[same], ...row, label: locs[same].label || row.label }; say(`location updated from the Page: ${row.address}`); }
      else if (empty >= 0) { locs[empty] = { ...locs[empty], ...row, label: locs[empty].label || row.label }; say(`location filled from the Page: ${row.address}`); }
      else { locs.push({ nearest_mrt: "", catchment: "", opening_hours: "", ...row }); say(`location added from the Page: ${row.address}`); }
    }
    if (body.website && r.page?.website) { const w = /^https?:\/\//i.test(r.page.website) ? r.page.website : `https://${r.page.website}`; profile.website = w; say(`website ${w}`); }
    const social = { ...(profile.social || {}) };
    if (body.instagram && r.page?.instagram?.username) { social.instagram = r.page.instagram.username.toLowerCase(); say(`Instagram @${social.instagram}`); }
    if (body.facebook && r.page) { social.facebook = `https://www.facebook.com/${r.page.username || r.page.id}`; say(`Facebook ${social.facebook}`); }
    if (Object.keys(social).length) profile.social = social;
    if (body.pin && r.pin) {
      const pins = (((profile.targeting_defaults ||= {}).geo ||= {}).radius_pins ||= []);
      const km = num(body.pin.radius_km) ?? r.pin.radius_km ?? 5;
      const pin = { label: r.pin.name || r.page?.name || "the gym", ...(r.pin.kind === "place" ? { place_key: r.pin.key, place_name: r.pin.name || "" } : {}), lat: r.pin.lat, lng: r.pin.lng, radius_km: km, location_types: r.pin.location_types || ["home", "recent"], callouts: Array.isArray(body.callouts) ? body.callouts.map(oneLine).filter(Boolean).map((c) => c.toUpperCase()) : [] };
      const had = pins.findIndex((p) => (pin.place_key && p.place_key === pin.place_key) || (p.lat != null && Math.abs(p.lat - pin.lat) < 0.0005 && Math.abs(p.lng - pin.lng) < 0.0005));
      if (had >= 0) pins[had] = { ...pins[had], ...pin, callouts: [...new Set([...(pins[had].callouts || []), ...pin.callouts])] }; else pins.push(pin);
      if (!pinUsable(pin)) throw new Error("the pin from the account has no place and no point");
      say(`pin ${pin.label}${pin.place_key ? " (Meta place)" : ""} · ${km} km`);
    }
    if (body.ages && r.adsets?.ages?.length) { const a = r.adsets.ages[0], dem = ((profile.targeting_defaults ||= {}).demographics ||= {}); dem.age_min = num(body.ages.min) ?? a.min; dem.age_max = num(body.ages.max) ?? a.max; say(`ages ${dem.age_min}-${dem.age_max}`); }
    if (body.budget != null && r.adsets?.daily_budget) { const b = ((profile.campaign_defaults ||= {}).budget ||= {}); const amt = num(body.budget) ?? r.adsets.daily_budget.median; if (!(amt > 0)) throw new Error("the daily budget must be a number above 0"); b.amount = amt; b.currency = r.adsets.daily_budget.currency || b.currency; b.level = b.level || "adset"; b.type = "daily"; say(`daily budget ${b.currency} ${amt}`); }
    if (Array.isArray(body.callouts) && body.callouts.length) { const cd = (profile.creative_defaults ||= {}); const have = new Set((cd.locations || []).map((x) => String(x).toUpperCase())); const add = body.callouts.map(oneLine).filter(Boolean).map((c) => c.toUpperCase()).filter((c) => !have.has(c)); if (add.length) { cd.locations = [...(cd.locations || []), ...add]; say(`location callout${add.length === 1 ? "" : "s"} ${add.join(", ")}`); } }
    return profile;
  };
  const trial = edit(JSON.parse(JSON.stringify(base)), () => {});
  const { errors } = validateProfile(trial, { gymDir });
  if (errors.length) throw Object.assign(new Error(errors[0]), { status: 400, errors });
  const profile = edit(JSON.parse(JSON.stringify(base)), (s) => changes.push(s));
  const wordings = { added: [], skipped: [] };
  for (const text of Array.isArray(body.offers) ? body.offers : []) {
    const t = oneLine(text); if (!t) continue;
    if (!r.offers.some((o) => o.text === t)) { wordings.skipped.push({ text: t, why: "not an offer the account named" }); continue; }
    try { addWording(gymDir, t); wordings.added.push(t); changes.push(`offer wording "${t}"`); } catch (e) { wordings.skipped.push({ text: t, why: e.message }); }
  }
  return { profile, changes, wordings };
}
