#!/usr/bin/env node
/**
 * client-config.mjs — Load, merge and validate a gym client's declared configuration.
 *
 * The pipeline used to carry client knowledge in prose (brand-dna.md) and in conversation,
 * which meant every campaign re-asked the same questions and nothing was enforceable.
 * This module makes the client DATA:
 *
 *   brands/{gym}/gym-profile.json          stable identity, brand lock, targeting defaults
 *   brands/{gym}/offers/{offer}.json       one per campaign — the thing being sold
 *   brands/{gym}/.resolved/{offer}.json    generated: the deep-merged, validated brief
 *
 * Phases 2 (prompts), 4 (copy) and 5 (campaign) all read the resolved file, so they cannot
 * disagree about price, CTA, colours or targeting.
 *
 * Usage:
 *   node skills/references/client-config.mjs --gym ironhaus --offer 6wk-challenge
 *   node skills/references/client-config.mjs --gym ironhaus --init          # scaffold starters
 *   node skills/references/client-config.mjs --gym ironhaus --offer x --json # print resolved
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { loadCatalogue, validateInputs } from "./render-composites.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Enums the rest of the pipeline already depends on ────────────────────────
// CTA values must match Ads Uploader exactly (ad-copy-builder/references/csv-format.md).
export const CTA_ENUM = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "GET_QUOTE",
  "BOOK_NOW", "CONTACT_US", "GET_STARTED", "APPLY_NOW",
];

export const OFFER_TYPES = [
  "challenge", "trial", "intro_pack", "membership",
  "pt_package", "class_pass", "free_session", "referral",
];

export const PRICE_QUALIFIERS = ["one-time", "from", "as_low_as", "per_month", "per_session"];

// ── Small helpers ────────────────────────────────────────────────────────────
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep merge: `patch` wins. Arrays replace rather than concatenate — a targeting
 *  override that lists two interests means exactly those two, not defaults plus two. */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

const readJson = (path, label) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${path}): ${e.message}`);
  }
};

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// Em dashes break the Ads Uploader importer (ad-copy-builder/SKILL.md bans them outright),
// so they must never reach a field that ends up in a campaign/adset/ad name.
const hasEmDash = (s) => typeof s === "string" && /[—–]/.test(s);

// ── Validation ───────────────────────────────────────────────────────────────
function validate(profile, offer, resolved, gymDir) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  // --- profile: identity ---
  if (!profile) return { errors: ["gym-profile.json not found"], warnings };
  for (const f of ["gym_id", "gym_abbr", "display_name"]) {
    if (!get(profile, f)) E(`gym-profile.json: missing required field "${f}"`);
  }
  if (profile.gym_abbr && !/^[A-Z]{2,4}$/.test(profile.gym_abbr)) {
    E(`gym-profile.json: gym_abbr "${profile.gym_abbr}" must be 2-4 uppercase letters (used in Ad Name)`);
  }

  // --- profile: locale. Singapore is the default market; anything else must be deliberate. ---
  const currency = get(profile, "locale.currency");
  if (!currency) E('gym-profile.json: missing "locale.currency"');
  else if (currency !== "SGD" && !profile.locale.non_sg_intentional) {
    E(`gym-profile.json: locale.currency is "${currency}", not SGD. If that is deliberate, set locale.non_sg_intentional = true`);
  }
  if (!get(profile, "locale.timezone")) W('gym-profile.json: no "locale.timezone" — defaulting to Asia/Singapore');

  // --- profile: locations. Radius targeting is the whole game for a gym. ---
  const locations = profile.locations || [];
  if (!locations.length) E("gym-profile.json: at least one entry in \"locations\" is required (radius targeting needs a pin)");
  locations.forEach((loc, i) => {
    if (!loc.postal_code) E(`gym-profile.json: locations[${i}] ("${loc.label || "unnamed"}") has no postal_code`);
    if (loc.lat == null || loc.lng == null) W(`gym-profile.json: locations[${i}] has no lat/lng — radius targeting will need manual pin placement`);
  });

  // --- offer ---
  if (!offer) return { errors: [...errors, "offer file not found"], warnings };
  if (!offer.offer_id) E('offer: missing "offer_id"');
  if (!offer.name) E('offer: missing "name"');
  if (!OFFER_TYPES.includes(offer.offer_type)) {
    E(`offer: offer_type "${offer.offer_type}" is not one of ${OFFER_TYPES.join(", ")}`);
  }

  // --- offer: price. `display` is the exact string writers must use — never re-derive it. ---
  const price = offer.price || {};
  // Some clients deliberately keep price out of the creative and qualify on the form instead.
  // display_in_ads:false makes price.display optional AND bans price from generated copy.
  const showsPrice = price.display_in_ads !== false;
  if (showsPrice && !price.display) {
    E('offer: missing "price.display" — the exact price string ad copy must use. If price is deliberately kept out of the ads, set price.display_in_ads = false');
  }
  if (!showsPrice && price.display) {
    W('offer: price.display_in_ads is false but price.display is set — copy generation will ignore it');
  }
  if (price.currency && currency && price.currency !== currency) {
    E(`offer: price.currency "${price.currency}" disagrees with gym locale.currency "${currency}"`);
  }
  if (price.qualifier && !PRICE_QUALIFIERS.includes(price.qualifier)) {
    E(`offer: price.qualifier "${price.qualifier}" is not one of ${PRICE_QUALIFIERS.join(", ")}`);
  }
  // SG advertisers must be unambiguous about GST in a displayed price.
  if (showsPrice && !price.gst_treatment) W('offer: no "price.gst_treatment" — SG ads showing a price should state whether it includes GST');
  if (price.compare_at && !price.compare_at.basis) {
    W('offer: price.compare_at has no "basis" — a struck-through price needs a defensible derivation');
  }

  // --- offer: compliance gates. These mirror ad-copy-builder/references/compliance.md. ---
  const g = offer.guarantee || {};
  if (g.outcome_guarantee === true) {
    E('offer: guarantee.outcome_guarantee must be false — outcome guarantees are banned for fitness (compliance.md)');
  }
  if (g.posture && g.posture !== "none" && !g.text) {
    E(`offer: guarantee.posture is "${g.posture}" but guarantee.text is empty`);
  }
  const sc = offer.scarcity || {};
  if (sc.honest === false) {
    E('offer: scarcity.honest is false — fabricated urgency is not shippable. Remove the scarcity block or make it real');
  }
  if (sc.type === "capacity") {
    // "Only N spots left" is only shippable if there is a real N behind it.
    const cap = get(offer, "mechanics.capacity") || {};
    if (cap.limited !== true) E('offer: scarcity.type is "capacity" but mechanics.capacity.limited is not true');
    if (!(cap.spots > 0)) E('offer: scarcity.type is "capacity" but mechanics.capacity.spots is not a positive number');
    if (cap.claim_verifiable !== true) E('offer: scarcity.type is "capacity" but mechanics.capacity.claim_verifiable is not true');
  }
  if (sc.type === "deadline" && !sc.signup_deadline) {
    E('offer: scarcity.type is "deadline" but scarcity.signup_deadline is not set');
  }
  if (sc.type === "cohort_start" && !sc.cohort_start_date) {
    E('offer: scarcity.type is "cohort_start" but scarcity.cohort_start_date is not set');
  }
  for (const [f, v] of [["signup_deadline", sc.signup_deadline], ["cohort_start_date", sc.cohort_start_date]]) {
    if (v && Number.isNaN(Date.parse(v))) E(`offer: scarcity.${f} "${v}" is not a parseable date`);
    else if (v && Date.parse(v) < Date.now()) W(`offer: scarcity.${f} "${v}" is in the past`);
  }

  // --- offer: destination ---
  const dest = offer.destination || {};
  const FLOWS = ["leadgen_form", "calendly", "whatsapp", "form", "phone", "website"];
  if (dest.booking_flow && !FLOWS.includes(dest.booking_flow)) {
    E(`offer: destination.booking_flow "${dest.booking_flow}" is not one of ${FLOWS.join(", ")}`);
  }
  // A Meta instant form is the destination — there is no landing page to validate.
  const isLeadForm = dest.booking_flow === "leadgen_form";
  if (isLeadForm) {
    if (!dest.lead_form_name) {
      E('offer: booking_flow is "leadgen_form" but destination.lead_form_name is not set (the instant form to attach in Ads Manager)');
    }
    if (dest.landing_url) W('offer: booking_flow is "leadgen_form" — destination.landing_url is ignored');
  } else if (!dest.landing_url) {
    E('offer: missing "destination.landing_url" (or set destination.booking_flow = "leadgen_form")');
  } else {
    try {
      const u = new URL(dest.landing_url);
      if (u.protocol !== "https:") W(`offer: destination.landing_url is not https (${u.protocol})`);
    } catch {
      E(`offer: destination.landing_url "${dest.landing_url}" is not a valid URL`);
    }
  }
  if (!CTA_ENUM.includes(dest.primary_cta)) {
    E(`offer: destination.primary_cta "${dest.primary_cta}" is not an Ads Uploader CTA (${CTA_ENUM.join(", ")})`);
  }

  // --- naming safety: em dashes break the importer ---
  for (const [label, val] of [
    ["gym_profile.display_name", profile.display_name],
    ["offer.name", offer.name],
    ["offer.offer_id", offer.offer_id],
  ]) {
    if (hasEmDash(val)) E(`${label} contains an em/en dash — these break the Ads Uploader import. Use a plain hyphen.`);
  }

  // --- brand lock ---
  const lock = profile.brand_lock || {};
  const colors = lock.colors || {};
  const hexes = Object.entries(colors)
    .filter(([, v]) => isObj(v) && v.hex)
    .map(([k, v]) => [k, v.hex]);
  if (!hexes.length) W("gym-profile.json: brand_lock.colors is empty — Phase 2 will fall back to scraped colours");
  for (const [k, hex] of hexes) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) E(`gym-profile.json: brand_lock.colors.${k}.hex "${hex}" is not a 6-digit hex`);
  }
  const logo = lock.logo || {};
  if (logo.always_include_as_reference && !logo.files?.primary) {
    E("gym-profile.json: brand_lock.logo.always_include_as_reference is true but logo.files.primary is unset");
  }
  if (logo.files?.primary) {
    // Logo paths are relative to the reference-image root, the same way a prompt's
    // reference_images are — not to the brand folder.
    const roots = ["brand-assets", "reference-images", "product-images"];
    const tried = roots.map((r) => join(gymDir, r, logo.files.primary));
    if (!tried.some((t) => existsSync(t)) && !existsSync(join(gymDir, logo.files.primary))) {
      E(`gym-profile.json: brand_lock.logo.files.primary "${logo.files.primary}" not found under ${gymDir}/{${roots.join(",")}}/`);
    }
  }

  // --- reference images: the pipeline cannot generate without them ---
  const refDirs = ["brand-assets", "reference-images", "product-images"].map((d) => join(gymDir, d));
  const found = refDirs.find((d) => existsSync(d));
  if (!found) {
    W(`no reference-image folder yet (looked for brand-assets/, reference-images/, product-images/ in ${gymDir}) — image generation will fail until real photos are added`);
  }

  // --- creative: looks a client has switched off for the offer-first creative (assign-variants.mjs) ---
  const creative = profile.creative || {};
  const cat = loadCatalogue();
  for (const [k, known] of [["exclude_layouts", cat.treatments.treatments], ["exclude_styles", cat.styles.styles], ["exclude_palettes", cat.palettes.palettes]]) {
    if (creative[k] == null) continue;
    if (!Array.isArray(creative[k])) { E(`gym-profile.json: creative.${k} must be a list`); continue; }
    for (const id of creative[k]) if (!known[id]) E(`gym-profile.json: creative.${k} names "${id}", which is not in the catalogue (${Object.keys(known).join(", ")})`);
  }

  // --- targeting ---
  const tg = resolved.targeting || {};
  const dem = tg.demographics || {};
  if (dem.age_min != null && dem.age_max != null && dem.age_min > dem.age_max) {
    E(`targeting: demographics.age_min (${dem.age_min}) is greater than age_max (${dem.age_max})`);
  }
  if (dem.age_min != null && dem.age_min < 18) {
    E(`targeting: demographics.age_min is ${dem.age_min}; Meta requires 18+ for this category`);
  }
  const budget = get(resolved, "campaign.budget") || {};
  if (budget.amount != null && !(budget.amount > 0)) E("campaign.budget.amount must be greater than 0");
  if (budget.currency && currency && budget.currency !== currency) {
    E(`campaign.budget.currency "${budget.currency}" disagrees with locale.currency "${currency}"`);
  }
  if (isLeadForm) {
    const obj = get(resolved, "campaign.objective");
    if (obj && obj !== "OUTCOME_LEADS") {
      E(`campaign.objective is "${obj}" but the destination is a Meta instant form — that requires OUTCOME_LEADS`);
    }
    const goal = get(resolved, "targeting.optimization.goal");
    if (goal === "OFFSITE_CONVERSIONS") {
      E('targeting.optimization.goal is OFFSITE_CONVERSIONS but there is no website to convert on — use LEAD_GENERATION for an instant form');
    }
  }
  if (get(resolved, "campaign.status_on_create") && resolved.campaign.status_on_create !== "PAUSED") {
    E('campaign.status_on_create must be "PAUSED" — ads are always reviewed before going live');
  }

  return { errors, warnings };
}

// ── Gym profiles (schema 3) ──────────────────────────────────────────────────
// A gym's profile is filled in once and remembered: identity and premises, brand and photography,
// the defaults the Create screen opens with, the Meta ids for publishing later. Schema 3 only adds
// to 1 and 2 (creative_defaults, meta_assets.business_id / lead_form_id), so older profiles still load.

export const PROFILE_SCHEMA = 3;
const MAX_LOCATION_CALLOUTS = 4; // plan-offer-batch MAX_LOCATIONS: one version of every ad per location
/** What the Create screen opens with when a profile says nothing. The offer is never among them. */
export const CREATIVE_DEFAULTS = { locations: [], audiences: [], real_photos: [], generated: 10, looks_per_photo: 2, attempts: 2, max_calls: null, spread: true, palettes: "reference" };
/** Which colour pairings a gym's ads draw from: the reference catalogue (the loud pairings the
 *  high-performing ads use), the gym's own brand colours, or both in the same spread. */
export const PALETTE_MODES = ["reference", "brand", "both"];

// ── Brand palettes ───────────────────────────────────────────────────────────
// The gym's colours as text pairings the renderer can use, built the way the reference palettes
// are written (a fill and an outline per line, a pill, a band, a divider). Three of them, so a
// "brand only" batch still has enough different palettes for two looks per photo. The renderer's
// contrast guard judges every line on the photo as it does for the catalogue's pairings.
const HEX = /^#[0-9A-Fa-f]{6}$/;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lum = (hex) => { const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const sat = (hex) => { const c = rgb(hex), mx = Math.max(...c), mn = Math.min(...c); return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(mx + mn - 1)); };
/** WCAG contrast ratio between two colours. */
export const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

/** The three roles the brand colours play on an ad: the pop (its most saturated colour), a light
 *  and a dark. A gym with one colour gets white and near-black for the other two. */
export function brandRoles(colors = {}) {
  const given = ["primary", "secondary", "accent"].map((k) => colors?.[k]?.hex).filter((h) => typeof h === "string" && HEX.test(h)).map((h) => h.toUpperCase());
  if (!given.length) return null;
  const pop = [...given].sort((a, b) => sat(b) - sat(a) || lum(a) - lum(b))[0];
  const rest = given.filter((h) => h !== pop);
  const light = rest.filter((h) => lum(h) >= 0.6).sort((a, b) => lum(b) - lum(a))[0] || "#FFFFFF";
  const dark = rest.filter((h) => lum(h) <= 0.15).sort((a, b) => lum(a) - lum(b))[0] || "#111111";
  return { pop, light, dark };
}

export function brandPalettes(profile) {
  const roles = brandRoles(profile?.brand_lock?.colors);
  if (!roles) return {};
  const { pop, light, dark } = roles;
  const shadow = "rgba(0,0,0,0.55)";
  const outlineFor = (fill) => (contrast(fill, light) >= contrast(fill, dark) ? light : dark);
  const line = (fill, outline = outlineFor(fill)) => ({ fill, outline, shadow });
  const onLight = contrast(pop, light) >= 3 ? pop : dark; // a pop that reads on the light colour, else the dark
  const seen_in = [`${profile?.display_name || "the gym"}'s brand colours`];
  return {
    brand: { seen_in, brand: true, blocks: { location: line(pop), audience: line(light, onLight), duration: line(light, onLight), offer_name: line(pop) }, pill: dark, band: dark, scrim: "#000000", divider: pop },
    "brand-light": { seen_in, brand: true, blocks: { location: line(light, dark), audience: line(light, dark), duration: line(light, dark), offer_name: line(light, dark) }, pill: onLight === pop ? pop : dark, band: dark, scrim: "#000000", divider: pop },
    "brand-bold": { seen_in, brand: true, blocks: { location: line(pop), audience: line(pop), duration: line(pop), offer_name: line(pop) }, pill: light, band: dark, scrim: "#000000", divider: light },
  };
}

/** The catalogue a gym's batches use: the reference palettes, its brand palettes, or both, by
 *  creative_defaults.palettes. Layouts and styles are the catalogue's own. */
export function catalogueFor(profile, catalogue = loadCatalogue()) {
  const mode = profile?.creative_defaults?.palettes || CREATIVE_DEFAULTS.palettes;
  if (mode === "reference") return catalogue;
  const brand = brandPalettes(profile);
  if (!Object.keys(brand).length) throw new Error(`creative_defaults.palettes is "${mode}" but the profile has no brand colours (brand_lock.colors)`);
  const palettes = mode === "brand" ? brand : { ...catalogue.palettes.palettes, ...brand };
  return { ...catalogue, palettes: { ...catalogue.palettes, palettes } };
}
// Secret-bearing names (not an ad set's name_token) and what a Meta access token looks like.
const SECRET_KEY = /^(token|access_token|.*_access_token|.*_user_token|app_secret|client_secret|secret|password|api[_-]?key|apikey)$/i;
const SECRET_VALUE = /^(EAA[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})$/;
const META_ID = { ad_account_id: /^(act_)?\d{5,20}$/, page_id: /^\d{5,20}$/, instagram_actor_id: /^\d{5,20}$/, pixel_id: /^\d{5,20}$/, business_id: /^\d{5,20}$/, lead_form_id: /^\d{5,20}$/ };

/**
 * Format problems in a profile: what would make a saved profile wrong, not what leaves it unfinished
 * (profileCompleteness says what is missing). The panel refuses to save a profile with errors.
 */
export function validateProfile(profile, { gymDir = null } = {}) {
  const errors = [], warnings = [];
  if (!isObj(profile)) return { errors: ["the profile is not a JSON object"], warnings };
  // Access tokens live in .env or the keychain; a profile is shared and copied, so it holds ids only.
  const walk = (o, path) => {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!isObj(o)) return;
    for (const [k, v] of Object.entries(o)) {
      const at = path ? `${path}.${k}` : k;
      if ((SECRET_KEY.test(k) && v != null && v !== "") || (typeof v === "string" && SECRET_VALUE.test(v))) errors.push(`${at}: tokens, secrets and passwords never go in a profile — they live in .env`);
      walk(v, at);
    }
  };
  walk(profile, "");
  if (profile.gym_abbr && !/^[A-Z]{2,4}$/.test(profile.gym_abbr)) errors.push(`abbreviation "${profile.gym_abbr}" must be 2-4 capital letters (it goes into ad names)`);
  for (const [label, v] of [["display name", profile.display_name], ["legal entity", profile.legal_entity]]) if (hasEmDash(v)) errors.push(`${label} contains an em/en dash, which breaks the Ads Uploader import — use a plain hyphen`);
  const currency = profile.locale?.currency;
  if (currency && currency !== "SGD" && !profile.locale.non_sg_intentional) errors.push(`currency is "${currency}", not SGD — set locale.non_sg_intentional if that is deliberate`);
  if (profile.website && !/^https?:\/\/\S+\.\S+$/.test(profile.website)) errors.push(`website "${profile.website}" is not a web address (https://…)`);
  if (profile.locations != null && !Array.isArray(profile.locations)) errors.push("locations must be a list");
  (Array.isArray(profile.locations) ? profile.locations : []).forEach((l, i) => {
    const name = `location ${i + 1}${l?.label ? ` (${l.label})` : ""}`;
    if (l?.postal_code && !/^\d{6}$/.test(String(l.postal_code))) errors.push(`${name}: postal code "${l.postal_code}" must be 6 digits`);
    for (const k of ["lat", "lng"]) if (l?.[k] != null && l[k] !== "" && !Number.isFinite(l[k])) errors.push(`${name}: ${k} must be a number`);
    if (Number.isFinite(l?.lat) && (l.lat < 1.1 || l.lat > 1.5) && currency === "SGD") warnings.push(`${name}: latitude ${l.lat} is outside Singapore`);
  });
  for (const [k, v] of Object.entries(profile.brand_lock?.colors || {})) {
    if (isObj(v) && v.hex && !/^#[0-9A-Fa-f]{6}$/.test(v.hex)) errors.push(`colour ${k}: "${v.hex}" is not a 6-digit hex like #0A0A0A`);
  }
  const creative = profile.creative || {};
  const cat = loadCatalogue();
  for (const [k, known] of [["exclude_layouts", cat.treatments.treatments], ["exclude_styles", cat.styles.styles], ["exclude_palettes", cat.palettes.palettes]]) {
    if (creative[k] == null) continue;
    if (!Array.isArray(creative[k])) { errors.push(`creative.${k} must be a list`); continue; }
    for (const id of creative[k]) if (!known[id]) errors.push(`creative.${k} names "${id}", which is not in the catalogue`);
  }
  // The Create screen's defaults: the same rules the batch applies to the words and counts.
  const cd = profile.creative_defaults;
  if (cd != null) {
    if (!isObj(cd)) errors.push("creative_defaults must be an object");
    else {
      const list = (k) => (cd[k] == null ? [] : Array.isArray(cd[k]) ? cd[k] : (errors.push(`creative_defaults.${k} must be a list`), []));
      const locs = list("locations");
      if (locs.length > MAX_LOCATION_CALLOUTS) errors.push(`up to ${MAX_LOCATION_CALLOUTS} location callouts (one version of every ad per location)`);
      if (new Set(locs).size !== locs.length) errors.push("a location callout repeats");
      for (const l of locs) for (const e of validateInputs({ location: l, audience: null, offer: "x" })) if (e.startsWith("location")) errors.push(`location callout ${JSON.stringify(l)}: ${e.replace(/^location /, "")}`);
      for (const a of list("audiences")) for (const e of validateInputs({ location: "X", audience: a, offer: "x" })) if (e.startsWith("audience")) errors.push(`audience callout ${JSON.stringify(a)}: ${e.replace(/^audience /, "")}`);
      for (const p of list("real_photos")) if (typeof p !== "string" || p.includes("..") || (gymDir && !existsSync(join(gymDir, "brand-assets", p)))) errors.push(`real photo ${JSON.stringify(p)} is not in brand-assets`);
      const int = (k, lo, hi) => { if (cd[k] != null && !(Number.isInteger(cd[k]) && cd[k] >= lo && cd[k] <= hi)) errors.push(`creative_defaults.${k} must be a whole number from ${lo} to ${hi}`); };
      int("generated", 0, 12); int("looks_per_photo", 1, 6); int("attempts", 1, 5); int("max_calls", 0, 40);
      if (Number.isInteger(cd.max_calls) && Number.isInteger(cd.generated) && cd.max_calls < cd.generated) errors.push(`creative_defaults.max_calls (${cd.max_calls}) must cover one call per new photo (${cd.generated})`);
      if (cd.spread != null && typeof cd.spread !== "boolean") errors.push("creative_defaults.spread must be true or false");
      if (cd.palettes != null && !PALETTE_MODES.includes(cd.palettes)) errors.push(`creative_defaults.palettes must be one of ${PALETTE_MODES.join(", ")}`);
      if (["brand", "both"].includes(cd.palettes) && !brandRoles(profile.brand_lock?.colors)) errors.push(`creative_defaults.palettes is "${cd.palettes}", but the brand has no colours yet (Brand & photography)`);
    }
  }
  for (const [k, re] of Object.entries(META_ID)) {
    const v = profile.meta_assets?.[k];
    if (v != null && v !== "" && !re.test(String(v))) errors.push(`Meta ${k.replace(/_/g, " ")} "${v}" is not an id (digits${k === "ad_account_id" ? ", optionally after act_" : ""})`);
  }
  return { errors, warnings };
}

/**
 * How finished a profile is, section by section: done, partial or missing, with what each still
 * needs. Computed from the profile and what is on disk, never stored, so it cannot go stale.
 * `have` carries what the panel knows beyond the profile file: cleaned photos, the scene library's
 * status, the number of offer wordings.
 */
export function profileCompleteness(profile, { gymDir = null, cleanPhotos = 0, scenes = null, wordings = 0 } = {}) {
  const p = profile || {}, loc = (p.locations || [])[0] || {}, lock = p.brand_lock || {}, ph = lock.photography || {}, cd = p.creative_defaults || {};
  const logo = lock.logo?.files?.primary;
  const logoFound = !!logo && !!gymDir && ["brand-assets", "reference-images", "product-images", ""].some((r) => existsSync(join(gymDir, r, logo)));
  const audiences = (cd.audiences || []).map((a) => (/\b(men|man|guys|dads?|gents|males?)\b/i.test(a) ? "men" : /\b(ladies|women|woman|mums?|moms?|girls|females?)\b/i.test(a) ? "women" : "any"));
  const sceneFor = (aud) => !!scenes?.counts && ((scenes.counts[aud] || 0) + (scenes.counts.any || 0) > 0);
  const pin = p.targeting_defaults?.geo?.radius_pins?.[0] || {};
  const dem = p.targeting_defaults?.demographics || {};
  const m = p.meta_assets || {};
  const S = (id, label, page, needs, extra = {}) => {
    const missing = needs.filter(([, ok]) => !ok).map(([what]) => what);
    return { id, label, page, status: !missing.length ? "done" : missing.length === needs.length ? "missing" : "partial", missing, ...extra };
  };
  const sections = [
    S("identity", "Identity & locations", "identity", [["display name", !!p.display_name], ["abbreviation", /^[A-Z]{2,4}$/.test(p.gym_abbr || "")], ["website", !!p.website], ["a location's name", !!loc.label], ["its postal code", !!loc.postal_code]],
      { tips: loc.postal_code && (loc.lat == null || loc.lng == null) ? ["add the location's latitude and longitude for radius targeting"] : [] }),
    S("brand", "Brand & photography", "brand", [["a primary colour", !!lock.colors?.primary?.hex], ["what photos must show", (ph.must || []).length > 0], ["what photos must never show", (ph.never || []).length > 0], ["who is in the photos", !!ph.people]],
      { tips: logoFound ? [] : ["add the logo file (brand-assets/logo) — kept for later, not drawn on the ads"] }),
    S("photos", "Real photos", "photos", [["at least one cleaned photo of the premises", cleanPhotos > 0]]),
    S("scenes", "Scene library", "scenes", [["an approved scene library", !!scenes?.exists && !!scenes?.approved], ...audiences.filter((a, i, all) => all.indexOf(a) === i && a !== "any").map((a) => [`scenes for ${a}`, sceneFor(a)])]),
    S("offers", "Offer wording", "offer", [["at least one offer wording", wordings > 0]]),
    S("defaults", "Ad defaults", "defaults", [["at least one location callout", (cd.locations || []).length > 0]]),
    S("targeting", "Targeting & budget", "targeting", [["a radius pin", !!pin.postal_code], ["an age range", dem.age_min != null && dem.age_max != null], ["a budget", p.campaign_defaults?.budget?.amount > 0]], { for: "publishing" }),
    S("meta", "Meta link", "meta", [["ad account id", !!m.ad_account_id], ["Facebook page id", !!m.page_id], ["business portfolio id", !!m.business_id], ["pixel id", !!m.pixel_id], ["lead form id", !!m.lead_form_id]], { for: "publishing" }),
  ];
  const create = sections.filter((s) => s.for !== "publishing");
  return { sections, ready_to_create: create.every((s) => s.status === "done"), ready_to_publish: sections.every((s) => s.status === "done"), to_do: create.filter((s) => s.status !== "done").length };
}

// ── Public API ───────────────────────────────────────────────────────────────
export function loadClientConfig(gym, offerSlug, { root = REPO_ROOT } = {}) {
  const gymDir = join(root, "brands", gym);
  if (!existsSync(gymDir)) throw new Error(`No brand folder at ${gymDir}`);

  const profile = readJson(join(gymDir, "gym-profile.json"), "gym-profile.json");
  if (!profile) throw new Error(`No gym-profile.json in ${gymDir} — run with --init to scaffold one`);

  const offerPath = join(gymDir, "offers", `${offerSlug}.json`);
  const offer = readJson(offerPath, `offers/${offerSlug}.json`);
  if (!offer) {
    const avail = existsSync(join(gymDir, "offers"))
      ? readdirSync(join(gymDir, "offers")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
      : [];
    throw new Error(
      `No offer at ${offerPath}` + (avail.length ? `\nAvailable offers: ${avail.join(", ")}` : "")
    );
  }

  // Resolution order: profile defaults -> offer override -> (per-adset patch, applied later).
  const targeting = deepMerge(profile.targeting_defaults || {}, offer.targeting_override || {});
  const campaign = deepMerge(profile.campaign_defaults || {}, offer.campaign || {});

  const resolved = {
    schema_version: 1,
    resolved_at: new Date().toISOString(),
    gym: {
      gym_id: profile.gym_id,
      gym_abbr: profile.gym_abbr,
      display_name: profile.display_name,
      website: profile.website,
      locale: { timezone: "Asia/Singapore", ...(profile.locale || {}) },
      locations: profile.locations || [],
      business: profile.business || {},
      proof_assets: profile.proof_assets || {},
      meta_assets: profile.meta_assets || {},
    },
    brand_lock: profile.brand_lock || {},
    creative: profile.creative || {},
    offer,
    targeting,
    campaign,
  };

  const { errors, warnings } = validate(profile, offer, resolved, gymDir);
  return { resolved, errors, warnings, gymDir, offerPath };
}

/** Write the resolved brief so every later phase reads one artifact. */
export function writeResolved(gymDir, offerSlug, resolved) {
  const dir = join(gymDir, ".resolved");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${offerSlug}.json`);
  writeFileSync(out, JSON.stringify(resolved, null, 2) + "\n");
  return out;
}

// ── Scaffolding ──────────────────────────────────────────────────────────────
export const PROFILE_STARTER = (gym, displayName = "") => ({
  schema_version: PROFILE_SCHEMA,
  gym_id: gym,
  gym_abbr: gym.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase(),
  display_name: displayName,
  website: "",
  locale: { country: "SG", currency: "SGD", timezone: "Asia/Singapore", languages: ["en_SG"], spelling: "en-SG" },
  locations: [
    { label: "", address: "", postal_code: "", lat: null, lng: null, nearest_mrt: "", catchment: "", opening_hours: "" },
  ],
  business: {
    type: "boutique_strength",
    class_formats: [],
    member_count: null,
    years_operating: null,
    coaches: [{ name: "", credentials: "", usable_in_ads: true }],
    differentiators: [],
    known_objections: [],
  },
  meta_assets: { business_id: "", ad_account_id: "", page_id: "", instagram_actor_id: "", pixel_id: "", lead_form_id: "", primary_conversion_event: "Lead" },
  creative_defaults: { ...CREATIVE_DEFAULTS },
  brand_lock: {
    locked_by: "client",
    locked_at: new Date().toISOString().slice(0, 10),
    source_of_truth: "auto_detected",
    colors: {
      primary: { hex: "", name: "", locked: true, usage: "" },
      secondary: { hex: "", name: "", locked: true, usage: "" },
      accent: { hex: "", name: "", locked: true },
      forbidden: [],
    },
    logo: {
      files: { primary: "", mark_only: "" },
      always_include_as_reference: false,
      placement: "bottom-right, 8% frame width, min 5% clear space",
      never: ["recolour", "stretch", "outline", "regenerate or redraw"],
    },
    typography: {
      headline: { family: "", fallback_description: "heavy condensed all-caps grotesque", case: "UPPERCASE" },
      body: { family: "", fallback_description: "clean neutral geometric sans", case: "Sentence case" },
      never: [],
    },
    photography: {
      must: ["real facility", "real members and coaches", "natural light"],
      never: ["stock gym photos", "oiled fitness models", "body-part crops"],
      people: "Singaporean / SEA mix, real training clothes, ages 20-65",
    },
    voice: { adjectives: [], never: ["hype", "emoji in headlines", "American slang", "fitspo language"] },
    hard_overrides: { ignore_auto_detected: [], notes: "" },
  },
  targeting_defaults: {
    geo: { countries: ["SG"], mode: "radius", radius_pins: [], excluded_pins: [] },
    demographics: { age_min: 25, age_max: 45, genders: "all", locales: ["en_SG"] },
    detailed_targeting: {
      strategy: "broad_first",
      interests: [],
      note: "Meta removed most granular health/fitness detailed-targeting options in 2022. Prefer BROAD plus a strong pixel signal; treat interest labels as advisory until confirmed in Ads Manager.",
    },
    custom_audiences: { include: [], exclude: [] },
    lookalikes: [],
    placements: { mode: "automatic", manual: null },
    optimization: { goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS", conversion_event: "Lead", dynamic_creative: false },
    adsets: [
      { stage: "TOF", name_token: "Cold", audience_label: "Broad SG", targeting_patch: {} },
      { stage: "MOF", name_token: "Warm", audience_label: "Engagers 365d", targeting_patch: {} },
      { stage: "BOF", name_token: "Retargeting", audience_label: "Site visitors 30d", targeting_patch: {} },
    ],
  },
  campaign_defaults: {
    objective: "OUTCOME_LEADS",
    buying_type: "AUCTION",
    special_ad_categories: [],
    budget: { level: "campaign", type: "daily", amount: 40, currency: "SGD", bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cap: null },
    attribution: { click_window_days: 7, view_window_days: 1 },
    status_on_create: "PAUSED",
  },
  proof_assets: { google_rating: null, review_count: null, press: [], testimonials_file: "" },
});

export const OFFER_STARTER = (gym, slug) => ({
  schema_version: 1,
  offer_id: slug,
  gym_id: gym,
  offer_type: "challenge",
  name: "",
  duration: { value: 6, unit: "weeks" },
  price: {
    amount: null,
    currency: "SGD",
    display: "",
    qualifier: "one-time",
    billing: "single_payment",
    instalments: null,
    compare_at: { amount: null, basis: "", claim_defensible: true },
    gst_treatment: "inclusive",
    renewal: { auto_renews: false, renews_to: null, cancellation: "n/a" },
  },
  mechanics: {
    whats_included: [],
    sessions_total: null,
    capacity: { limited: false, spots: null, claim_verifiable: true },
    who_its_for: "",
    who_its_not_for: "",
    onboarding_steps: [],
  },
  scarcity: { type: "none", cohort_start_date: null, signup_deadline: null, countdown_usable: false, honest: true },
  guarantee: { posture: "none", text: "", outcome_guarantee: false },
  destination: { landing_url: "", booking_flow: "form", whatsapp_number: "", primary_cta: "BOOK_NOW", utm_base: "" },
  messaging: {
    primary_promise: "",
    must_say: [],
    must_not_say: ["guaranteed", "transform", "shred", "melt fat", "before and after"],
    tone_notes: "Direct, no hype. Singaporean English, no Americanisms.",
    results_vary_required: true,
  },
  targeting_override: {},
  campaign: {},
});

export function scaffold(gym, offerSlug, { brandsDir = join(REPO_ROOT, "brands"), displayName = "" } = {}) {
  const gymDir = join(brandsDir, gym);
  const written = [];
  for (const d of ["", "offers", "brand-assets/logo", "brand-assets/facility", "brand-assets/coaches", "brand-assets/members", "brand-assets/brand"]) {
    mkdirSync(join(gymDir, d), { recursive: true });
  }
  const pPath = join(gymDir, "gym-profile.json");
  if (existsSync(pPath)) {
    console.log(`  exists   gym-profile.json (left alone)`);
  } else {
    writeFileSync(pPath, JSON.stringify(PROFILE_STARTER(gym, displayName), null, 2) + "\n");
    written.push(pPath);
  }
  if (offerSlug) {
    const oPath = join(gymDir, "offers", `${offerSlug}.json`);
    if (existsSync(oPath)) {
      console.log(`  exists   offers/${offerSlug}.json (left alone)`);
    } else {
      writeFileSync(oPath, JSON.stringify(OFFER_STARTER(gym, offerSlug), null, 2) + "\n");
      written.push(oPath);
    }
  }
  for (const w of written) console.log(`  created  ${w.replace(REPO_ROOT + "/", "")}`);
  console.log(`\nDrop real photos into brands/${gym}/brand-assets/{logo,facility,coaches,members}/ then fill the JSON.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values } = parseArgs({
    options: {
      gym: { type: "string" },
      offer: { type: "string" },
      init: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "no-write": { type: "boolean", default: false },
    },
  });

  if (!values.gym) {
    console.error("Usage: node skills/references/client-config.mjs --gym <slug> [--offer <slug>] [--init] [--json]");
    process.exit(1);
  }

  if (values.init) {
    scaffold(values.gym, values.offer);
    process.exit(0);
  }

  if (!values.offer) {
    console.error("--offer <slug> is required (or use --init to scaffold)");
    process.exit(1);
  }

  let result;
  try {
    result = loadClientConfig(values.gym, values.offer);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const { resolved, errors, warnings, gymDir } = result;

  for (const w of warnings) console.log(`  warn   ${w}`);
  for (const e of errors) console.error(`  ERROR  ${e}`);

  if (errors.length) {
    console.error(`\n✗ ${errors.length} error(s) — config is not shippable. Nothing written.`);
    process.exit(1);
  }

  if (values.json) {
    console.log(JSON.stringify(resolved, null, 2));
  } else if (!values["no-write"]) {
    const out = writeResolved(gymDir, values.offer, resolved);
    console.log(`\n✓ ${values.gym} / ${values.offer} valid${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
    console.log(`  wrote ${out.replace(REPO_ROOT + "/", "")}`);
  }
}
