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
  if (!price.display) E('offer: missing "price.display" — the exact price string ad copy must use');
  if (price.currency && currency && price.currency !== currency) {
    E(`offer: price.currency "${price.currency}" disagrees with gym locale.currency "${currency}"`);
  }
  if (price.qualifier && !PRICE_QUALIFIERS.includes(price.qualifier)) {
    E(`offer: price.qualifier "${price.qualifier}" is not one of ${PRICE_QUALIFIERS.join(", ")}`);
  }
  // SG advertisers must be unambiguous about GST in a displayed price.
  if (!price.gst_treatment) W('offer: no "price.gst_treatment" — SG ads should state whether the price includes GST');
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
  if (!dest.landing_url) E('offer: missing "destination.landing_url"');
  else {
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
    const p = join(gymDir, logo.files.primary);
    if (!existsSync(p)) E(`gym-profile.json: brand_lock.logo.files.primary not found on disk: ${p}`);
  }

  // --- reference images: the pipeline cannot generate without them ---
  const refDirs = ["brand-assets", "reference-images", "product-images"].map((d) => join(gymDir, d));
  const found = refDirs.find((d) => existsSync(d));
  if (!found) {
    W(`no reference-image folder yet (looked for brand-assets/, reference-images/, product-images/ in ${gymDir}) — image generation will fail until real photos are added`);
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
  if (get(resolved, "campaign.status_on_create") && resolved.campaign.status_on_create !== "PAUSED") {
    E('campaign.status_on_create must be "PAUSED" — ads are always reviewed before going live');
  }

  return { errors, warnings };
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
export const PROFILE_STARTER = (gym) => ({
  schema_version: 1,
  gym_id: gym,
  gym_abbr: gym.slice(0, 3).toUpperCase(),
  display_name: "",
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
  meta_assets: { ad_account_id: "", page_id: "", instagram_actor_id: "", pixel_id: "", primary_conversion_event: "Lead" },
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
      files: { primary: "brand-assets/logo/logo-primary.png", mark_only: "" },
      always_include_as_reference: true,
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
      people: "Singaporean/SEA mix, real training clothes",
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

export function scaffold(gym, offerSlug) {
  const gymDir = join(REPO_ROOT, "brands", gym);
  const written = [];
  for (const d of ["", "offers", "brand-assets/logo", "brand-assets/facility", "brand-assets/coaches", "brand-assets/members", "brand-assets/brand"]) {
    mkdirSync(join(gymDir, d), { recursive: true });
  }
  const pPath = join(gymDir, "gym-profile.json");
  if (existsSync(pPath)) {
    console.log(`  exists   gym-profile.json (left alone)`);
  } else {
    writeFileSync(pPath, JSON.stringify(PROFILE_STARTER(gym), null, 2) + "\n");
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
