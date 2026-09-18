/**
 * meta-publish.mjs — creating ads in a gym's Meta ad account (E3, first cut: one of everything).
 *
 * `--test-one` makes ONE campaign, ONE ad set and ONE ad from one finished ad of a batch, every object
 * PAUSED, the words as placeholders unless given, to prove the link can write. It is the seed of the
 * real publish (E2 plan → E3 create): the payload builders here are what the plan will show first.
 *
 *   node skills/references/meta-publish.mjs --gym sculpt-society --batch 2026-09-13-men-total-body-reset \
 *        --ad 101-c01-bishan-t3-green-white --test-one [--dry-run]
 *
 * What is created, in order, each step recorded in outputs/{batch}/publish-test.json as it happens:
 *   1 image      POST act_/adimages (the ad's 1:1 PNG as bytes) → image hash
 *   2 campaign   OUTCOME_LEADS · daily budget from the profile (cents) · lowest cost · PAUSED
 *   3 ad set     LEAD_GENERATION on the Page's instant form (destination ON_AD) · the profile's radius pin,
 *                ages, the callout's gender · Advantage+ audience off · 7-day click / 1-day view · PAUSED
 *   4 creative   the Page, the 1:1 image, placeholder primary text / headline / description, SIGN_UP → the
 *                lead form; Advantage+ enhancements opted out where Meta lets this version do so
 *   5 ad         the creative in the ad set · PAUSED
 * Nothing is ever created ACTIVE from here. A dry run prints the payloads and calls nothing.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { createHash } from "crypto";
import { join, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { metaConfig, graphClient, actId, scrubTokens, MetaError } from "./meta-api.mjs";
import { calloutGender, pinFor, pinUsable, BID_STRATEGIES, BUDGET_LEVELS, GENDER_CHOICES } from "./client-config.mjs";
import { presetFor, livePresets, specForAdset, summarise, BROAD } from "./meta-targeting.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const AD_STATUS = "PAUSED";
const DEFAULT_RADIUS_KM = 5;
const CTA = "SIGN_UP";
/** Meta's Advantage+ creative enhancements for a single-image link ad (v25 "Get started with Advantage+ creative");
 *  the blanket `standard_enhancements` switch was deprecated in v22, so each feature is opted out by name. */
export const ENHANCEMENTS = ["image_touchups", "image_brightness_and_contrast", "enhance_cta", "text_optimizations", "image_templates", "inline_comment", "image_uncrop", "adapt_to_placement", "product_extensions", "description_automation", "add_text_overlay", "image_background_gen", "image_animation", "text_translation"];
export const optOut = (features = ENHANCEMENTS) => ({ creative_features_spec: Object.fromEntries(features.map((k) => [k, { enroll_status: "OPT_OUT" }])) });
/** The gender Meta targets for an audience callout: men, women, or everyone. */
export const genderFor = (audience, profile = null) => { const g = calloutGender(audience, profile); return g === "men" ? [1] : g === "women" ? [2] : null; };
/** Never Advantage+ audience (the owner's rule): Meta may not widen the audience past what the ad set says. */
export const NEVER_ADVANTAGE = Object.freeze({ advantage_audience: 0 });
/** A pin as Meta's geo_locations: a named place by key, else a dropped point. */
export const geoFor = (pin) => ({
  ...(pin.place_key ? { places: [{ key: String(pin.place_key), radius: pin.radius_km || DEFAULT_RADIUS_KM, distance_unit: "kilometer" }] }
    : { custom_locations: [{ latitude: pin.lat, longitude: pin.lng, radius: pin.radius_km || DEFAULT_RADIUS_KM, distance_unit: "kilometer" }] }),
  location_types: pin.location_types || ["home", "recent"],
});
export const pinWords = (pin, fallback = false) => `${pin.place_name || pin.label || pin.postal_code || "pin"}${pin.place_key ? ` (Meta place ${pin.place_key})` : Number.isFinite(pin.lat) ? ` (${pin.lat}, ${pin.lng})` : ""} · ${pin.radius_km || DEFAULT_RADIUS_KM} km${fallback ? " · the gym's first pin, none names this callout" : ""}`;
const today = () => new Date().toISOString().slice(0, 10);
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };

/** The words on the ad and beside it. Placeholders say so, so nothing invented can pass for copy. */
export function placeholderWords(profile, ad) {
  const gym = profile.display_name || "the gym", w = ad.words || {};
  return {
    message: `[PLACEHOLDER primary text] ${w.offer || "the offer"} at ${gym}${w.location ? `, ${w.location[0] + w.location.slice(1).toLowerCase()}` : ""}. Tap Sign up to apply.`,
    headline: `[PLACEHOLDER headline] ${w.offer || "the offer"}`,
    description: "[PLACEHOLDER description]",
  };
}

/** Every payload for one campaign / ad set / ad from one finished ad, built from the profile and the batch. */
export function buildTestOne({ profile, batch, ad, words = null, storyFile = null, tag = today() }) {
  const m = profile.meta_assets || {};
  const singapore = (profile.locale?.country || "SG") === "SG";
  const missing = ["ad_account_id", "page_id", "lead_form_id", ...(singapore ? ["singapore_beneficiary_id", "singapore_payer_id"] : [])].filter((k) => !m[k]);
  if (missing.length) throw new Error(`the profile's Meta link is missing ${missing.join(", ")} — pick them on the Meta link page first${missing.some((k) => k.startsWith("singapore")) ? " (the verified advertiser identity: read from the account's existing ad sets)" : ""}`);
  const account = actId(m.ad_account_id);
  const abbr = profile.gym_abbr || "GYM", w = ad.words || {}, loc = (w.location || "").toUpperCase();
  const cd = profile.campaign_defaults || {}, budget = cd.budget || {};
  const currency = profile.locale?.currency || "SGD";
  if (budget.currency && budget.currency !== currency) throw new Error(`the budget is in ${budget.currency} but the profile's currency is ${currency}`);
  // The budget sits on the campaign or on each ad set (the owner's choice; ad set by default); the bid strategy with it.
  const level = budget.level === "campaign" ? "campaign" : "adset";
  const strategy = budget.bid_strategy || "LOWEST_COST_WITHOUT_CAP";
  if (!BID_STRATEGIES[strategy]) throw new Error(`bid strategy "${strategy}" is not one Meta knows (Targeting & budget)`);
  const cents = Math.round((budget.amount || 50) * 100);
  const capCents = strategy === "LOWEST_COST_WITHOUT_CAP" ? null : Math.round((budget.bid_cap || 0) * 100);
  if (strategy !== "LOWEST_COST_WITHOUT_CAP" && !(capCents > 0)) throw new Error(`${BID_STRATEGIES[strategy]} needs an amount (Targeting & budget)`);
  const tg = profile.targeting_defaults || {}, dem = tg.demographics || {};
  const { pin, fallback } = pinFor(profile, w.location);
  if (!pinUsable(pin)) throw new Error(`the profile has no usable radius pin${w.location ? ` for ${w.location}` : ""} — a Meta place, or a point with latitude and longitude (Targeting & budget)`);
  // Meta: "Lead Generation ads should always link to external content" — the Page's own address is refused.
  if (!/^https?:\/\/\S+\.\S+$/.test(profile.website || "")) throw new Error("a lead ad must link to an external website and the profile has none — fill in the website on Identity & locations");
  const genders = genderFor(w.audience, profile);
  const attribution = cd.attribution || {};
  const text = words || placeholderWords(profile, ad);
  const campaignName = `${abbr} | TEST | Leads | ${w.offer || batch.batch_id} | ${tag}`;
  return {
    account, page_id: m.page_id, instagram_user_id: m.instagram_user_id || null, lead_form_id: m.lead_form_id, pixel_id: m.pixel_id || null,
    budget: { level, daily: cents / 100, currency, bid_strategy: strategy, bid_cap: capCents ? capCents / 100 : null },
    pin: { ...pin, fallback, words: pinWords(pin, fallback) },
    image: { file: ad.file, name: `${batch.batch_id}__${basename(ad.file)}` },
    story: storyFile ? { file: storyFile, name: `${batch.batch_id}__${basename(storyFile)}` } : null,
    campaign: {
      name: campaignName, objective: cd.objective || "OUTCOME_LEADS", status: AD_STATUS, special_ad_categories: cd.special_ad_categories || [],
      buying_type: cd.buying_type || "AUCTION", ...(level === "campaign" ? { daily_budget: cents, bid_strategy: strategy } : {}),
    },
    adset: {
      name: `${abbr}_${loc || "ALL"}_TEST_${tag}`, status: AD_STATUS,
      optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", destination_type: "ON_AD",
      ...(level === "adset" ? { daily_budget: cents, bid_strategy: strategy } : {}), ...(capCents ? { bid_amount: capCents } : {}),
      promoted_object: { page_id: m.page_id },
      // Meta: ads that include locations in Singapore must carry the regulated category SINGAPORE_UNIVERSAL and
      // name a verified advertiser as beneficiary and payer (Online Criminal Harms Act, enforced since May 2025).
      ...(singapore ? { regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: m.singapore_beneficiary_id, singapore_universal_payer: m.singapore_payer_id } } : {}),
      targeting: {
        geo_locations: geoFor(pin),
        age_min: dem.age_min ?? 25, age_max: dem.age_max ?? 45, ...(genders ? { genders } : {}),
        targeting_automation: { ...NEVER_ADVANTAGE },
      },
      // Lead-generation optimisation only takes a 1-day click window (Meta: "supported combination … (1, 0)");
      // the profile's 7-day click / 1-day view is for conversion campaigns.
      attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
    },
    creative: {
      name: `${abbr}_TEST_${ad.folder}`,
      object_story_spec: {
        page_id: m.page_id, ...(m.instagram_user_id ? { instagram_user_id: m.instagram_user_id } : {}),
        link_data: {
          image_hash: "(the uploaded image's hash)", link: profile.website,
          message: text.message, name: text.headline, description: text.description,
          call_to_action: { type: CTA, value: { lead_gen_form_id: m.lead_form_id } },
        },
      },
      // Meta's Advantage+ creative enhancements rewrite text on images; every one we can name is opted out.
      degrees_of_freedom_spec: optOut(),
    },
    ad: { name: `${abbr}_TEST_${ad.folder}`, status: AD_STATUS },
    words: text,
  };
}


// ── E2: the publish plan for a whole batch ───────────────────────────────────
/** Meta's cap on ads in one ad set, and the point past which spreading budget gets thin. */
export const ADS_PER_ADSET_CAP = 50, ADS_PER_ADSET_MANY = 6;
export const CTA_TYPES = { SIGN_UP: "Sign up", APPLY_NOW: "Apply now", LEARN_MORE: "Learn more", GET_OFFER: "Get offer", BOOK_NOW: "Book now", CONTACT_US: "Contact us" };
const clean1 = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const mmdd = (id) => { const m = String(id || "").match(/^\d{4}-(\d{2})-(\d{2})/); return m ? m[1] + m[2] : today().slice(5).replace("-", ""); };
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
/** The words on the ad and beside it, for the whole campaign: the owner's, or placeholders that say so. */
export function campaignWords(profile, batch, words = {}) {
  const w = { message: clean1(words.message, 2000), headline: clean1(words.headline, 255), description: clean1(words.description, 255), cta: CTA_TYPES[words.cta] ? words.cta : CTA };
  const ph = placeholderWords(profile, { words: { offer: batch.offer || batch.ads?.[0]?.words?.offer || "" } });
  const placeholders = [];
  if (!w.message) { w.message = ph.message; placeholders.push("primary text"); }
  if (!w.headline) { w.headline = ph.headline; placeholders.push("headline"); }
  if (!w.description) { w.description = ph.description; placeholders.push("description"); }
  return { ...w, placeholders };
}
/** The placement rules for one creative: the 9:16 on Stories and Reels, the 1:1 everywhere else (their own ads' shape). */
export const PLACEMENT_RULES = (squareLabel, storyLabel) => [
  { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] }, image_label: { name: storyLabel }, priority: 1 },
  { customization_spec: { age_min: 13, age_max: 65 }, image_label: { name: squareLabel }, priority: 2 },
];
/** One ad's creative: two images by placement when the ad has a Stories version, else the 1:1 alone. Hashes are filled in when the images are uploaded. */
/** Multi-advertiser ads (the ad shown beside other advertisers' ads): never — the owner's rule (2026-09-18). */
export const NO_MULTI_ADVERTISER = Object.freeze({ enroll_status: "OPT_OUT" });
export function creativeFor({ name, page_id, instagram_user_id, website, form_id, words, story }) {
  const identity = { page_id, ...(instagram_user_id ? { instagram_user_id } : {}) };
  const cta = words.cta || CTA;
  if (story) {
    return {
      name, object_story_spec: identity, contextual_multi_ads: { ...NO_MULTI_ADVERTISER },
      asset_feed_spec: {
        images: [{ hash: "(1:1 hash)", adlabels: [{ name: "square" }] }, { hash: "(9:16 hash)", adlabels: [{ name: "story" }] }],
        bodies: [{ text: words.message }], titles: [{ text: words.headline }], descriptions: [{ text: words.description }],
        link_urls: [{ website_url: website }], call_to_action_types: [cta], call_to_actions: [{ type: cta, value: { lead_gen_form_id: form_id } }],
        ad_formats: ["SINGLE_IMAGE"], optimization_type: "PLACEMENT", asset_customization_rules: PLACEMENT_RULES("square", "story"),
      },
      degrees_of_freedom_spec: optOut(),
    };
  }
  return {
    name, object_story_spec: { ...identity, link_data: { image_hash: "(1:1 hash)", link: website, message: words.message, name: words.headline, description: words.description, call_to_action: { type: cta, value: { lead_gen_form_id: form_id } } } },
    contextual_multi_ads: { ...NO_MULTI_ADVERTISER }, degrees_of_freedom_spec: optOut(),
  };
}
/**
 * The whole plan for a batch, before anything is created: one campaign; one ad set per location callout
 * among the kept ads (its pin, ages, gender, detailed-targeting preset and budget — the profile's defaults
 * under the owner's `settings` for this batch); one ad per kept ad with its 1:1 for feed and its 9:16 for
 * Stories and Reels. Problems stop it; warnings are said. Nothing here calls Meta.
 *   kept:    [{ folder, file, location, words, story: file|null }]
 *   settings: { campaign: { name, level, daily, bid_strategy, bid_cap }, adsets: { [CALLOUT]: { pin, radius_km, age_min, age_max, gender, preset, daily } }, words: { message, headline, description, cta }, destination: { lead_form_id, instagram_user_id } }
 */
export function buildPlan({ profile, batch, kept, presets = { presets: [] }, settings = {}, tag = today() }) {
  const problems = [], warnings = [];
  const m = profile.meta_assets || {}, dest = settings.destination || {};
  const singapore = (profile.locale?.country || "SG") === "SG";
  const account = m.ad_account_id ? actId(m.ad_account_id) : null;
  // An empty Instagram id in the settings is a choice (none); an absent one takes the profile's.
  const page_id = m.page_id || null, instagram_user_id = dest.instagram_user_id != null ? (dest.instagram_user_id || null) : (m.instagram_user_id || null), lead_form_id = dest.lead_form_id || m.lead_form_id || null;
  for (const [k, v] of [["ad account", account], ["Page", page_id], ["lead form", lead_form_id]]) if (!v) problems.push(`no ${k} chosen (Meta link page)`);
  if (singapore && (!m.singapore_beneficiary_id || !m.singapore_payer_id)) problems.push("no verified Singapore advertiser identity in the profile (read from the account's existing ad sets on the first publish test)");
  if (!/^https?:\/\/\S+\.\S+$/.test(profile.website || "")) problems.push("a lead ad must link to an external website and the profile has none (Identity & locations)");
  if (!instagram_user_id) warnings.push("no Instagram account chosen: Meta will run the ads under a Page-backed Instagram identity (Meta link page)");
  const abbr = profile.gym_abbr || "GYM", currency = profile.locale?.currency || "SGD";
  const cd = profile.campaign_defaults || {}, bd = cd.budget || {}, sc = settings.campaign || {};
  if (bd.currency && bd.currency !== currency) problems.push(`the budget is in ${bd.currency} but the profile's currency is ${currency}`);
  const level = BUDGET_LEVELS[sc.level] ? sc.level : bd.level === "campaign" ? "campaign" : "adset";
  const strategy = BID_STRATEGIES[sc.bid_strategy] ? sc.bid_strategy : BID_STRATEGIES[bd.bid_strategy] ? bd.bid_strategy : "LOWEST_COST_WITHOUT_CAP";
  const daily = num(sc.daily, 1, 100000) ?? num(bd.amount, 1, 100000) ?? 50;
  const cap = strategy === "LOWEST_COST_WITHOUT_CAP" ? null : num(sc.bid_cap, 0.01, 100000) ?? num(bd.bid_cap, 0.01, 100000);
  if (strategy !== "LOWEST_COST_WITHOUT_CAP" && !cap) problems.push(`${BID_STRATEGIES[strategy]} needs an amount`);
  const offer = kept[0]?.words?.offer || batch.offer || batch.batch_id;
  const words = campaignWords(profile, { offer, batch_id: batch.batch_id }, settings.words || {});
  if (words.placeholders.length) warnings.push(`placeholder words for the ${words.placeholders.join(", ")}: type the campaign's words before the ads go live`);
  const date = mmdd(batch.batch_id);
  const campaign = {
    name: clean1(sc.name, 120) || `${date} ${offer} | ${abbr} | ${kept[0]?.words?.audience ? titleCase(kept[0].words.audience) : "Leads"}`,
    objective: cd.objective || "OUTCOME_LEADS", status: AD_STATUS, special_ad_categories: cd.special_ad_categories || [], buying_type: cd.buying_type || "AUCTION",
    // Meta (2026-09-18): a campaign whose ad sets carry their own budgets must say whether they may share it; never (their house style).
    ...(level === "campaign" ? { daily_budget: Math.round(daily * 100), bid_strategy: strategy } : { is_adset_budget_sharing_enabled: false }),
  };
  if (!kept.length) problems.push("no ads kept: keep at least one on the Review screen");
  // One ad set per location callout, in the order the callouts appear.
  const tg = profile.targeting_defaults || {}, dem = tg.demographics || {}, pins = tg.geo?.radius_pins || [];
  const callouts = [...new Set(kept.map((a) => String(a.location || a.words?.location || "ALL").toUpperCase()))];
  const adsets = callouts.map((callout) => {
    const own = (settings.adsets || {})[callout] || {};
    const ads = kept.filter((a) => String(a.location || a.words?.location || "ALL").toUpperCase() === callout);
    const audience = ads[0]?.words?.audience || null;
    // The pin: the owner's pick for this ad set, else the pin naming the callout, else the gym's first.
    let pin, fallback = false;
    const pickedPin = own.pin != null ? pins[own.pin] : null;
    if (pickedPin) pin = pickedPin; else ({ pin, fallback } = pinFor(profile, callout));
    if (!pinUsable(pin)) problems.push(`${callout}: no usable pin — a Meta place, or a point on the map (Targeting & budget)`);
    else if (fallback && pins.length > 1) warnings.push(`${callout}: no pin names this callout, so the first pin (${pin.label || pin.place_name || "unnamed"}) is used`);
    const radius_km = num(own.radius_km, 1, 80) ?? pin?.radius_km ?? DEFAULT_RADIUS_KM;
    const age_min = num(own.age_min, 18, 65) ?? dem.age_min ?? 25, age_max = num(own.age_max, 18, 65) ?? dem.age_max ?? 60;
    if (age_min > age_max) problems.push(`${callout}: age ${age_min} is above ${age_max}`);
    const gender = GENDER_CHOICES.includes(own.gender) ? own.gender : calloutGender(audience, profile);
    const genders = gender === "men" ? [1] : gender === "women" ? [2] : null;
    // Detailed targeting: the owner's pick for this ad set, else the profile's per-callout choice, else the suggestion.
    let preset, how;
    const live = livePresets(presets);
    if (own.preset && (own.preset === BROAD || live.some((p) => p.id === own.preset))) { preset = live.find((p) => p.id === own.preset) || { id: BROAD, name: "Broad", spec: {}, summary: summarise({}) }; how = "chosen for this ad set"; }
    else ({ preset, how } = presetFor(presets, profile, { audience, offer }));
    const spec = specForAdset(preset);
    const setDaily = num(own.daily, 1, 100000) ?? daily;
    if (ads.length > ADS_PER_ADSET_CAP) problems.push(`${callout}: ${ads.length} ads in one ad set; Meta allows ${ADS_PER_ADSET_CAP} — exclude some, or split the callout`);
    else if (ads.length > ADS_PER_ADSET_MANY) warnings.push(`${callout}: ${ads.length} ads share one budget; past ${ADS_PER_ADSET_MANY} each gets little`);
    const pinName = pin?.label || pin?.place_name || pin?.postal_code || "pin";
    const name = `${date} ${titleCase(callout)} | ${offer} | Audience: ${pinName} + ${radius_km}KM, ${gender === "men" ? "Male" : gender === "women" ? "Female" : "All"}, ${preset.name}, ${age_min}-${age_max}`;
    return {
      callout, name, audience, ads: ads.map((a) => a.folder),
      pin: pin ? { ...pin, index: pins.indexOf(pin), radius_km, fallback, words: pinWords({ ...pin, radius_km }, fallback) } : null,
      age_min, age_max, gender, preset: { id: preset.id, name: preset.name, how, summary: preset.summary || summarise(preset.spec || {}) }, spec,
      budget: level === "adset" ? { daily: setDaily, currency, bid_strategy: strategy, bid_cap: cap } : null,
      payload: {
        name: name.slice(0, 400), status: AD_STATUS, optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", destination_type: "ON_AD",
        ...(level === "adset" ? { daily_budget: Math.round(setDaily * 100), bid_strategy: strategy } : {}), ...(cap ? { bid_amount: Math.round(cap * 100) } : {}),
        promoted_object: { page_id },
        ...(singapore ? { regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: m.singapore_beneficiary_id, singapore_universal_payer: m.singapore_payer_id } } : {}),
        targeting: { ...(pin && pinUsable(pin) ? { geo_locations: geoFor({ ...pin, radius_km }) } : {}), age_min, age_max, ...(genders ? { genders } : {}), ...spec, targeting_automation: { ...NEVER_ADVANTAGE } },
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
      },
    };
  });
  const noStory = kept.filter((a) => !a.story);
  if (noStory.length) warnings.push(`${noStory.length} of ${kept.length} ads have no Stories version: on Stories and Reels Meta will show the 1:1 (Make Stories versions on the Review screen first)`);
  const ads = kept.map((a) => {
    const callout = String(a.location || a.words?.location || "ALL").toUpperCase();
    const name = `${date} ${titleCase(callout)} | ${offer} | Image: ${a.folder}`;
    return {
      folder: a.folder, adset: callout, name,
      image: { file: a.file, name: `${batch.batch_id}__${basename(a.file)}` },
      story: a.story ? { file: a.story, name: `${batch.batch_id}__${basename(a.story)}` } : null,
      creative: creativeFor({ name: name.slice(0, 400), page_id, instagram_user_id, website: profile.website, form_id: lead_form_id, words, story: !!a.story }),
      payload: { name: name.slice(0, 400), status: AD_STATUS },
    };
  });
  return {
    account, page_id, instagram_user_id, lead_form_id, website: profile.website || null, currency,
    budget: { level, daily, bid_strategy: strategy, bid_cap: cap, per_day_total: level === "campaign" ? daily : adsets.reduce((t, s) => t + (s.budget?.daily || 0), 0) },
    campaign, adsets, ads, words, counts: { adsets: adsets.length, ads: ads.length, with_story: kept.length - noStory.length },
    problems, warnings, ready: problems.length === 0,
  };
}
/** The kept ads of a batch from its folder: batch.json, the picks, the Stories versions on disk. */
export function keptAds(batchDir) {
  const batch = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf-8"));
  const review = existsSync(join(batchDir, "review.json")) ? JSON.parse(readFileSync(join(batchDir, "review.json"), "utf-8")) : { ads: {}, photos: {} };
  const stories = existsSync(join(batchDir, "stories.json")) ? JSON.parse(readFileSync(join(batchDir, "stories.json"), "utf-8")) : null;
  const storyOf = new Map((stories?.ads || []).filter((s) => existsSync(join(batchDir, s.file))).map((s) => [s.folder, s.file]));
  const excludedPhotos = new Set(Object.entries(review.photos || {}).filter(([, v]) => v === "exclude").map(([k]) => k));
  return batch.ads.filter((a) => review.ads?.[a.folder] !== "exclude" && !a.photos.some((p) => excludedPhotos.has(p)))
    .map((a) => ({ folder: a.folder, file: a.file, location: a.location, words: a.words, story: storyOf.get(a.folder) || null }));
}

/** POST a creative; a feature Meta refuses by name is dropped and the post retried; the opt-out as a whole refused → made without it, said so. */
export async function postCreative(client, account, spec, log = console.log) {
  const dropped = [];
  for (;;) {
    try {
      const r = await client.post(`${account}/adcreatives`, spec);
      const kept = Object.keys(spec.degrees_of_freedom_spec?.creative_features_spec || {});
      return { ...r, enhancements: kept.length ? "opted out" : "not opted out — switch Advantage+ creative enhancements off in Ads Manager", opted_out: kept, ...(dropped.length ? { opt_out_refused: dropped } : {}) };
    } catch (e) {
      if (!(e instanceof MetaError) || e.code !== 100 || !spec.degrees_of_freedom_spec) throw e;
      const named = Object.keys(spec.degrees_of_freedom_spec.creative_features_spec).find((k) => e.message.includes(k));
      if (named) { log(`  note: Meta refused the "${named}" opt-out (${e.message}); retrying without it`); dropped.push(named); delete spec.degrees_of_freedom_spec.creative_features_spec[named]; continue; }
      if (!/degrees_of_freedom|creative_features|enhancement/i.test(e.message)) throw e;
      log(`  note: Meta did not accept the enhancements opt-out (${e.message}); creating the creative without it`);
      dropped.push(...Object.keys(spec.degrees_of_freedom_spec.creative_features_spec)); delete spec.degrees_of_freedom_spec;
    }
  }
}

/** A fresh record for a batch's publishing: every Meta id lands here as it is made. */
export const freshRecord = (path, { batch_id, account }) => ({ path, batch_id, account, started: new Date().toISOString(), images: {}, campaign: null, adsets: {}, ads: {}, superseded: [], error: null, done: null, runs: [] });
const sha16 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
/** What makes a creative the creative it is: its images, words, form, identity and link. A change → a new creative and ad. */
export const creativeKey = (creative, hashes) => sha16(JSON.stringify({ hashes, afs: creative.asset_feed_spec ? { b: creative.asset_feed_spec.bodies, t: creative.asset_feed_spec.titles, d: creative.asset_feed_spec.descriptions, l: creative.asset_feed_spec.link_urls, c: creative.asset_feed_spec.call_to_actions, r: creative.asset_feed_spec.asset_customization_rules } : creative.object_story_spec.link_data, oss: { page_id: creative.object_story_spec.page_id, instagram_user_id: creative.object_story_spec.instagram_user_id || null }, multi: creative.contextual_multi_ads || null }));
const adsetKey = (payload) => sha16(JSON.stringify({ t: payload.targeting, b: payload.daily_budget ?? null, s: payload.bid_strategy ?? null, a: payload.bid_amount ?? null, n: payload.name }));
/**
 * Create what the plan says, in order — images (once per file, by content), the campaign, the ad sets, then
 * each ad's creative and ad — recording every id in `record` as it lands (`outputs/{batch}/publish.json`).
 * A re-run continues: what exists is reused, never made twice; an ad set whose targeting or budget changed
 * is updated in place; an ad whose creative changed (new words, images, form, identity) gets a new creative
 * and a new ad, the old ones kept under `superseded` (still PAUSED on Meta, never deleted here).
 * `first` limits this run to the first N ads of the plan (the live proof), the rest another run.
 */
export async function createPlan(plan, { client, batchDir, record, log = console.log, first = null }) {
  if (!plan.ready) throw new Error(`the plan has problems: ${plan.problems.join("; ")}`);
  const rec = record, account = plan.account;
  const save = () => writeWhole(rec.path, JSON.stringify({ ...rec, path: undefined }, null, 2) + "\n");
  const run = { started: new Date().toISOString(), made: { images: 0, campaign: 0, adsets: 0, creatives: 0, ads: 0 }, reused: { images: 0, campaign: 0, adsets: 0, ads: 0 }, updated: { campaign: 0, adsets: 0 }, superseded: 0, first: first ?? null };
  rec.runs.push(run); rec.error = null; rec.done = null; save();
  const fail = (step, what, e) => { rec.error = { step, what, message: scrubTokens(e.message), code: e.code ?? null, trace: e.trace ?? null, at: new Date().toISOString() }; save(); throw e; };
  const image = async (img) => {
    const bytes = readFileSync(join(batchDir, img.file));
    const key = sha16(bytes);
    if (rec.images[key]?.hash) { run.reused.images++; return rec.images[key].hash; }
    try {
      const r = await client.post(`${account}/adimages`, { bytes: bytes.toString("base64"), name: img.name });
      const first = Object.values(r.images || {})[0];
      if (!first?.hash) throw new Error(`the image upload answered without a hash: ${JSON.stringify(r).slice(0, 200)}`);
      rec.images[key] = { hash: first.hash, file: img.file, name: img.name, at: new Date().toISOString() }; run.made.images++; save();
      log(`· image ${img.file}: ${first.hash}`);
      return first.hash;
    } catch (e) { fail("image", img.file, e); }
  };
  // The campaign: made once; a changed name or budget is updated in place.
  try {
    if (rec.campaign?.id) {
      const want = { name: plan.campaign.name, ...(plan.campaign.daily_budget != null ? { daily_budget: plan.campaign.daily_budget, bid_strategy: plan.campaign.bid_strategy } : {}) };
      const changed = Object.entries(want).filter(([k, v]) => rec.campaign[k] !== v);
      if (changed.length) { await client.post(rec.campaign.id, Object.fromEntries(changed)); Object.assign(rec.campaign, Object.fromEntries(changed), { updated: new Date().toISOString() }); run.updated.campaign++; save(); log(`· campaign ${rec.campaign.id}: updated ${changed.map(([k]) => k).join(", ")}`); }
      else { run.reused.campaign++; log(`· campaign: already made (${rec.campaign.id}) — reused`); }
    } else {
      const r = await client.post(`${account}/campaigns`, plan.campaign);
      rec.campaign = { id: r.id, name: plan.campaign.name, daily_budget: plan.campaign.daily_budget ?? null, bid_strategy: plan.campaign.bid_strategy ?? null, at: new Date().toISOString() }; run.made.campaign++; save();
      log(`· campaign: ${r.id} "${plan.campaign.name}"`);
    }
  } catch (e) { fail("campaign", plan.campaign.name, e); }
  // The ad sets this run needs (those with an ad to make): made once per callout; changed targeting or budget updated.
  const adsToMake = first ? plan.ads.slice(0, first) : plan.ads;
  const callouts = [...new Set(adsToMake.map((a) => a.adset))];
  for (const callout of callouts) {
    const set = plan.adsets.find((x) => x.callout === callout);
    const key = adsetKey(set.payload), had = rec.adsets[callout];
    try {
      if (had?.id) {
        if (had.key === key) { run.reused.adsets++; log(`· ad set ${callout}: already made (${had.id}) — reused`); continue; }
        const { name, targeting, daily_budget, bid_strategy, bid_amount } = set.payload;
        await client.post(had.id, { name, targeting, ...(daily_budget != null ? { daily_budget, bid_strategy } : {}), ...(bid_amount != null ? { bid_amount } : {}) });
        Object.assign(had, { key, name, updated: new Date().toISOString() }); run.updated.adsets++; save(); log(`· ad set ${callout}: ${had.id} updated (targeting or budget changed)`);
      } else {
        const r = await client.post(`${account}/adsets`, { ...set.payload, campaign_id: rec.campaign.id });
        rec.adsets[callout] = { id: r.id, key, name: set.payload.name, at: new Date().toISOString() }; run.made.adsets++; save();
        log(`· ad set ${callout}: ${r.id}`);
      }
    } catch (e) { fail("adset", callout, e); }
  }
  // Each ad: its images, its creative, the ad. A creative that changed means a new creative and ad.
  for (const ad of adsToMake) {
    const hashes = { square: await image(ad.image), story: ad.story ? await image(ad.story) : null };
    const key = creativeKey(ad.creative, hashes), had = rec.ads[ad.folder];
    if (had?.id && had.key === key) { run.reused.ads++; continue; }
    if (had?.id) { rec.superseded.push({ folder: ad.folder, ...had, why: "the creative changed (words, images, form or identity)", at: new Date().toISOString() }); delete rec.ads[ad.folder]; run.superseded++; save(); log(`· ad ${ad.folder}: ${had.id} no longer matches the plan — making a new creative and ad`); }
    const spec = structuredClone(ad.creative);
    if (spec.asset_feed_spec) { spec.asset_feed_spec.images[0].hash = hashes.square; spec.asset_feed_spec.images[1].hash = hashes.story; }
    else spec.object_story_spec.link_data.image_hash = hashes.square;
    let creative;
    try { creative = await postCreative(client, account, spec, log); run.made.creatives++; } catch (e) { fail("creative", ad.folder, e); }
    try {
      const r = await client.post(`${account}/ads`, { ...ad.payload, adset_id: rec.adsets[ad.adset].id, creative: { creative_id: creative.id } });
      rec.ads[ad.folder] = { id: r.id, creative_id: creative.id, adset: ad.adset, key, hashes, enhancements: creative.enhancements, ...(creative.opt_out_refused ? { opt_out_refused: creative.opt_out_refused } : {}), at: new Date().toISOString() };
      run.made.ads++; save();
      log(`· ad ${ad.folder}: ${r.id} (creative ${creative.id}, ${creative.enhancements})`);
    } catch (e) { rec.orphan_creatives = [...(rec.orphan_creatives || []), { folder: ad.folder, creative_id: creative.id }]; fail("ad", ad.folder, e); }
  }
  run.finished = new Date().toISOString();
  rec.done = Object.keys(rec.ads).length >= plan.ads.length ? run.finished : null;
  save();
  return { run, campaign: rec.campaign, adsets: rec.adsets, ads: Object.keys(rec.ads).length, of: plan.ads.length, url: adsManagerUrl(account, rec.campaign.id) };
}

/** Make them, one after another, recording each answer as it lands. `client` is a graphClient. */
export async function createTestOne(plan, { client, brandDir, record, log = console.log }) {
  const rec = record;
  const save = () => writeWhole(rec.path, JSON.stringify({ ...rec, path: undefined }, null, 2) + "\n");
  const step = async (name, fn, stale = () => false) => {
    const had = rec.created[name];
    if (had && !stale(had)) { log(`· ${name}: already made (${had.id}) — reused`); return had; }
    if (had) { (rec.superseded ||= []).push({ step: name, ...had, why: stale(had) }); delete rec.created[name]; log(`· ${name}: ${had.id} no longer matches the plan (${stale(had)}) — making a new one`); }
    try {
      const r = await fn();
      rec.created[name] = { ...r, at: new Date().toISOString() }; save();
      log(`· ${name}: ${r.id}`);
      return r;
    } catch (e) { rec.error = { step: name, message: scrubTokens(e.message), code: e.code ?? null, trace: e.trace ?? null, at: new Date().toISOString() }; save(); throw e; }
  };
  const img = await step("image", async () => {
    const bytes = readFileSync(join(brandDir, "outputs", rec.batch_id, plan.image.file)).toString("base64");
    const r = await client.post(`${plan.account}/adimages`, { bytes, name: plan.image.name });
    const first = Object.values(r.images || {})[0];
    if (!first?.hash) throw new Error(`the image upload answered without a hash: ${JSON.stringify(r).slice(0, 200)}`);
    return { id: first.hash, hash: first.hash, url: first.url || null, name: plan.image.name };
  });
  const campaign = await step("campaign", () => client.post(`${plan.account}/campaigns`, plan.campaign));
  const adset = await step("adset", () => client.post(`${plan.account}/adsets`, { ...plan.adset, campaign_id: campaign.id }));
  const link = plan.creative.object_story_spec.link_data.link;
  const creative = await step("creative", async () => {
    const spec = structuredClone(plan.creative);
    spec.object_story_spec.link_data.image_hash = img.hash;
    return { ...(await postCreative(client, plan.account, spec, log)), link, instagram: plan.instagram_user_id || null };
  }, (had) => (had.link !== link ? `its link was ${had.link || "the Page"}, the plan's is ${link}` : had.enhancements !== "opted out" ? "its enhancements were not opted out" : (had.instagram || null) !== (plan.instagram_user_id || null) ? `its Instagram identity was ${had.instagram || "the Page's"}, the plan's is ${plan.instagram_user_id || "the Page's"}` : false));
  // An ad carries its creative: a remade creative means a remade ad (the old one stays PAUSED in the account, recorded as superseded).
  const ad = await step("ad", async () => ({ ...(await client.post(`${plan.account}/ads`, { ...plan.ad, adset_id: adset.id, creative: { creative_id: creative.id } })), creative_id: creative.id }),
    (had) => (had.creative_id !== creative.id ? `it used creative ${had.creative_id || "(unrecorded)"}, the plan's is ${creative.id}` : false));
  rec.done = new Date().toISOString(); save();
  return { image: img, campaign, adset, creative, ad };
}

export const adsManagerUrl = (account, campaignId) => `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account.replace(/^act_/, "")}${campaignId ? `&selected_campaign_ids=${campaignId}` : ""}`;

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, "brand-dir": { type: "string" }, batch: { type: "string" }, ad: { type: "string" }, "test-one": { type: "boolean", default: false }, create: { type: "boolean", default: false }, first: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  if (!v.gym || !v.batch || !(v["test-one"] ? v.ad : v.create)) { console.error("Usage: meta-publish.mjs --gym <slug> --batch <id> (--create [--first N] | --ad <folder> --test-one) [--dry-run] [--brand-dir <dir>]"); process.exit(1); }
  if (v.create) {
    try {
      const brandDir = v["brand-dir"] ? resolve(v["brand-dir"]) : join(REPO_ROOT, "brands", v.gym), out = join(brandDir, "outputs", v.batch);
      const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
      const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
      const { readPresets } = await import("./meta-targeting.mjs");
      const settings = existsSync(join(out, "publish-settings.json")) ? JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")) : {};
      const plan = buildPlan({ profile, batch, kept: keptAds(out), presets: readPresets(brandDir), settings });
      const first = v.first ? parseInt(v.first, 10) : null;
      if (v.first && !(Number.isInteger(first) && first >= 1)) throw new Error("--first takes a whole number of ads");
      console.log(`plan: ${plan.campaign.name} · ${plan.counts.adsets} ad set(s) · ${plan.counts.ads} ad(s), ${plan.counts.with_story} with a Stories version · ${plan.budget.per_day_total} ${plan.currency}/day in all · every object ${AD_STATUS}${first ? ` · this run: the first ${first} ad(s)` : ""}`);
      for (const w of plan.warnings) console.log(`  warning: ${w}`);
      for (const x of plan.problems) console.log(`  problem: ${x}`);
      if (!plan.ready) throw new Error("the plan has problems — fix them on the Publish screen first");
      if (v["dry-run"]) { console.log(JSON.stringify({ campaign: plan.campaign, adsets: plan.adsets.map((s) => ({ callout: s.callout, payload: s.payload })), ads: plan.ads.slice(0, first || 3).map((a) => ({ folder: a.folder, creative: a.creative, payload: a.payload })) }, null, 2)); process.exit(0); }
      const config = metaConfig({ gym: v.gym });
      if (!config.token) throw new Error(`no ${config.names.META_ACCESS_TOKEN} in .env`);
      const client = graphClient({ config });
      const path = join(out, "publish.json");
      const record = existsSync(path) ? { ...JSON.parse(readFileSync(path, "utf-8")), path } : freshRecord(path, { batch_id: v.batch, account: plan.account });
      if (record.account !== plan.account) throw new Error(`this batch was published to ${record.account}; the profile now says ${plan.account}`);
      const r = await createPlan(plan, { client, batchDir: out, record, first });
      const m = r.run.made, u = r.run.reused;
      console.log(`\ndone: ${r.ads} of ${r.of} ads on Meta (this run made ${m.ads} ad(s), ${m.creatives} creative(s), ${m.adsets} ad set(s), ${m.campaign} campaign, ${m.images} image(s); reused ${u.ads} ad(s), ${u.images} image(s)${r.run.superseded ? `; ${r.run.superseded} remade` : ""}) — all ${AD_STATUS}\n${r.url}\nrecord: ${path}`);
      process.exit(0);
    } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
  }
  try {
    const brandDir = v["brand-dir"] ? resolve(v["brand-dir"]) : join(REPO_ROOT, "brands", v.gym), out = join(brandDir, "outputs", v.batch);
    const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
    const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
    const ad = batch.ads.find((a) => a.folder === v.ad);
    if (!ad) throw new Error(`batch ${v.batch} has no ad ${v.ad}`);
    const stories = existsSync(join(out, "stories.json")) ? JSON.parse(readFileSync(join(out, "stories.json"), "utf-8")) : null;
    const storyFile = stories?.ads?.find((s) => s.folder === ad.folder)?.file || null;
    const config = metaConfig({ gym: v.gym });
    if (!config.token && !v["dry-run"]) throw new Error(`no ${config.names.META_ACCESS_TOKEN} in .env`);
    const client = config.token ? graphClient({ config }) : null;
    // Singapore's verified advertiser identity: the one the account's own ad sets already carry, kept in the profile.
    const m = (profile.meta_assets ||= {});
    if ((profile.locale?.country || "SG") === "SG" && (!m.singapore_beneficiary_id || !m.singapore_payer_id) && client && m.ad_account_id) {
      const found = await client.regulationIdentities(m.ad_account_id);
      const sg = found.filter((x) => x.category === "SINGAPORE_UNIVERSAL");
      if (sg.length !== 1) throw new Error(sg.length ? `the account's ad sets carry ${sg.length} different Singapore identities — choose one and put it in the profile (singapore_beneficiary_id, singapore_payer_id)` : "no ad set in this account names a Singapore beneficiary and payer yet — verify the advertiser in Business settings and put the identity id in the profile");
      m.singapore_beneficiary_id = sg[0].beneficiary; m.singapore_payer_id = sg[0].payer;
      (m.labels ||= {}).singapore_identity = `from ${sg[0].adsets} existing ad set(s), e.g. "${sg[0].example}"`;
      writeWhole(join(brandDir, "gym-profile.json"), JSON.stringify(profile, null, 2) + "\n");
      console.log(`· Singapore identity: beneficiary ${m.singapore_beneficiary_id}, payer ${m.singapore_payer_id} (${m.labels.singapore_identity}) — kept in the profile`);
    }
    const plan = buildTestOne({ profile, batch, ad, storyFile });
    console.log(`plan: ${plan.campaign.name}\n  ad set ${plan.adset.name} · ${plan.pin.words} · ages ${plan.adset.targeting.age_min}-${plan.adset.targeting.age_max}${plan.adset.targeting.genders ? ` · genders ${plan.adset.targeting.genders.join(",")}` : " · everyone"} · ${plan.budget.daily} ${plan.budget.currency}/day on the ${plan.budget.level === "adset" ? "ad set" : "campaign"} · ${BID_STRATEGIES[plan.budget.bid_strategy]}${plan.budget.bid_cap ? ` ${plan.budget.bid_cap}` : ""}\n  ad ${plan.ad.name} · image ${plan.image.file}${plan.story ? ` (9:16 on disk: ${plan.story.file}, not used by the test)` : ""}\n  lead form ${plan.lead_form_id} on Page ${plan.page_id}${plan.instagram_user_id ? ` · Instagram ${plan.instagram_user_id}` : " · no Instagram account chosen (Meta will use a Page-backed one)"} · every object ${AD_STATUS}`);
    if (v["dry-run"]) { console.log(JSON.stringify({ campaign: plan.campaign, adset: plan.adset, creative: plan.creative, ad: plan.ad }, null, 2)); process.exit(0); }
    const path = join(out, "publish-test.json");
    const record = existsSync(path) ? { ...JSON.parse(readFileSync(path, "utf-8")), path } : { path, test: true, gym: v.gym, batch_id: v.batch, ad: ad.folder, account: plan.account, started: new Date().toISOString(), plan: { campaign: plan.campaign, adset: plan.adset, creative: plan.creative, ad: plan.ad, image: plan.image }, created: {}, error: null };
    record.error = null;
    const r = await createTestOne(plan, { client, brandDir, record });
    console.log(`\ndone: campaign ${r.campaign.id} · ad set ${r.adset.id} · creative ${r.creative.id} (${r.creative.enhancements}) · ad ${r.ad.id} — all ${AD_STATUS}\n${adsManagerUrl(plan.account, r.campaign.id)}\nrecord: ${path}`);
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
