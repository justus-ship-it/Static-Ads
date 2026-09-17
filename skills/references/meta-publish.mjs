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
import { join, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { metaConfig, graphClient, actId, scrubTokens, MetaError } from "./meta-api.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const AD_STATUS = "PAUSED";
const DEFAULT_RADIUS_KM = 5;
const CTA = "SIGN_UP";
/** Meta's Advantage+ creative enhancements for a single-image link ad (v25 "Get started with Advantage+ creative");
 *  the blanket `standard_enhancements` switch was deprecated in v22, so each feature is opted out by name. */
export const ENHANCEMENTS = ["image_touchups", "image_brightness_and_contrast", "enhance_cta", "text_optimizations", "image_templates", "inline_comment", "image_uncrop", "adapt_to_placement", "product_extensions", "description_automation", "add_text_overlay", "image_background_gen", "image_animation", "text_translation"];
export const optOut = (features = ENHANCEMENTS) => ({ creative_features_spec: Object.fromEntries(features.map((k) => [k, { enroll_status: "OPT_OUT" }])) });
/** The gender Meta targets for an audience callout: men, women, or everyone. */
export const genderFor = (audience) => (/\b(men|man|guys|dads?|fathers?|gents|males?)\b/i.test(audience || "") ? [1] : /\b(ladies|women|woman|mums?|moms?|mothers?|girls|females?)\b/i.test(audience || "") ? [2] : null);
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
  const cents = Math.round((budget.amount || 40) * 100);
  const tg = profile.targeting_defaults || {}, pin = tg.geo?.radius_pins?.[0], dem = tg.demographics || {};
  if (!pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) throw new Error("the profile has no radius pin with latitude and longitude (Targeting & budget)");
  // Meta: "Lead Generation ads should always link to external content" — the Page's own address is refused.
  if (!/^https?:\/\/\S+\.\S+$/.test(profile.website || "")) throw new Error("a lead ad must link to an external website and the profile has none — fill in the website on Identity & locations");
  const genders = genderFor(w.audience);
  const attribution = cd.attribution || {};
  const text = words || placeholderWords(profile, ad);
  const campaignName = `${abbr} | TEST | Leads | ${w.offer || batch.batch_id} | ${tag}`;
  return {
    account, page_id: m.page_id, lead_form_id: m.lead_form_id, pixel_id: m.pixel_id || null,
    image: { file: ad.file, name: `${batch.batch_id}__${basename(ad.file)}` },
    story: storyFile ? { file: storyFile, name: `${batch.batch_id}__${basename(storyFile)}` } : null,
    campaign: {
      name: campaignName, objective: cd.objective || "OUTCOME_LEADS", status: AD_STATUS, special_ad_categories: cd.special_ad_categories || [],
      buying_type: cd.buying_type || "AUCTION", daily_budget: cents, bid_strategy: budget.bid_strategy || "LOWEST_COST_WITHOUT_CAP",
    },
    adset: {
      name: `${abbr}_${loc || "ALL"}_TEST_${tag}`, status: AD_STATUS,
      optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", destination_type: "ON_AD",
      promoted_object: { page_id: m.page_id },
      // Meta: ads that include locations in Singapore must carry the regulated category SINGAPORE_UNIVERSAL and
      // name a verified advertiser as beneficiary and payer (Online Criminal Harms Act, enforced since May 2025).
      ...(singapore ? { regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: m.singapore_beneficiary_id, singapore_universal_payer: m.singapore_payer_id } } : {}),
      targeting: {
        geo_locations: { custom_locations: [{ latitude: pin.lat, longitude: pin.lng, radius: pin.radius_km || DEFAULT_RADIUS_KM, distance_unit: "kilometer" }], location_types: pin.location_types || ["home", "recent"] },
        age_min: dem.age_min ?? 25, age_max: dem.age_max ?? 45, ...(genders ? { genders } : {}),
        targeting_automation: { advantage_audience: 0 },
      },
      // Lead-generation optimisation only takes a 1-day click window (Meta: "supported combination … (1, 0)");
      // the profile's 7-day click / 1-day view is for conversion campaigns.
      attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
    },
    creative: {
      name: `${abbr}_TEST_${ad.folder}`,
      object_story_spec: {
        page_id: m.page_id,
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
    const dropped = [];
    for (;;) {
      try {
        const r = await client.post(`${plan.account}/adcreatives`, spec);
        const kept = Object.keys(spec.degrees_of_freedom_spec?.creative_features_spec || {});
        return { ...r, link, enhancements: kept.length ? "opted out" : "not opted out — switch Advantage+ creative enhancements off in Ads Manager", opted_out: kept, ...(dropped.length ? { opt_out_refused: dropped } : {}) };
      } catch (e) {
        if (!(e instanceof MetaError) || e.code !== 100 || !spec.degrees_of_freedom_spec) throw e;
        // A feature this version does not know for this ad shape is named in the error: drop that one and retry.
        const named = Object.keys(spec.degrees_of_freedom_spec.creative_features_spec).find((k) => e.message.includes(k));
        if (named) { log(`  note: Meta refused the "${named}" opt-out (${e.message}); retrying without it`); dropped.push(named); delete spec.degrees_of_freedom_spec.creative_features_spec[named]; continue; }
        if (!/degrees_of_freedom|creative_features|enhancement/i.test(e.message)) throw e;
        // The opt-out as a whole is refused: make the creative without it and say so,
        // so the owner knows to switch the enhancements off in Ads Manager.
        log(`  note: Meta did not accept the enhancements opt-out (${e.message}); creating the creative without it`);
        dropped.push(...Object.keys(spec.degrees_of_freedom_spec.creative_features_spec)); delete spec.degrees_of_freedom_spec;
      }
    }
  }, (had) => (had.link !== link ? `its link was ${had.link || "the Page"}, the plan's is ${link}` : had.enhancements !== "opted out" ? "its enhancements were not opted out" : false));
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
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, batch: { type: "string" }, ad: { type: "string" }, "test-one": { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } } });
  if (!v.gym || !v.batch || !v.ad || !v["test-one"]) { console.error("Usage: meta-publish.mjs --gym <slug> --batch <id> --ad <folder> --test-one [--dry-run]"); process.exit(1); }
  try {
    const brandDir = join(REPO_ROOT, "brands", v.gym), out = join(brandDir, "outputs", v.batch);
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
    console.log(`plan: ${plan.campaign.name}\n  ad set ${plan.adset.name} · ${plan.adset.targeting.geo_locations.custom_locations[0].radius} km round ${plan.adset.targeting.geo_locations.custom_locations[0].latitude},${plan.adset.targeting.geo_locations.custom_locations[0].longitude} · ages ${plan.adset.targeting.age_min}-${plan.adset.targeting.age_max}${plan.adset.targeting.genders ? ` · genders ${plan.adset.targeting.genders.join(",")}` : ""} · ${plan.campaign.daily_budget / 100} ${profile.locale?.currency || "SGD"}/day\n  ad ${plan.ad.name} · image ${plan.image.file}${plan.story ? ` (9:16 on disk: ${plan.story.file}, not used by the test)` : ""}\n  lead form ${plan.lead_form_id} on Page ${plan.page_id} · every object ${AD_STATUS}`);
    if (v["dry-run"]) { console.log(JSON.stringify({ campaign: plan.campaign, adset: plan.adset, creative: plan.creative, ad: plan.ad }, null, 2)); process.exit(0); }
    const path = join(out, "publish-test.json");
    const record = existsSync(path) ? { ...JSON.parse(readFileSync(path, "utf-8")), path } : { path, test: true, gym: v.gym, batch_id: v.batch, ad: ad.folder, account: plan.account, started: new Date().toISOString(), plan: { campaign: plan.campaign, adset: plan.adset, creative: plan.creative, ad: plan.ad, image: plan.image }, created: {}, error: null };
    record.error = null;
    const r = await createTestOne(plan, { client, brandDir, record });
    console.log(`\ndone: campaign ${r.campaign.id} · ad set ${r.adset.id} · creative ${r.creative.id} (${r.creative.enhancements}) · ad ${r.ad.id} — all ${AD_STATUS}\n${adsManagerUrl(plan.account, r.campaign.id)}\nrecord: ${path}`);
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
