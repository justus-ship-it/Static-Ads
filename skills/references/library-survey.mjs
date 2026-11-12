/**
 * library-survey.mjs — what other fitness businesses run in Meta's Ad Library, and how long each kind survives (2026-11-12).
 *
 * ANALYSIS ONLY (the standing rule on reference ads): another operator's ad is never republished, never attached to
 * an image call, never named to a drafter, and the words printed on it are not kept. Everything here lives under
 * `swipe/` (gitignored: the repo is public). The owner reads the survey; nothing in the app acts on it by itself.
 *
 * Three parts:
 *   · the pull   — the owner's click: `scrape-meta-ads.mjs` reads the Ad Library through Apify (billed to the Apify
 *                  account; a grey area under Meta's terms, so the scraper's own notice is shown and agreed to first)
 *                  → swipe/{niche}/raw/{date}/ads-normalized.json + images
 *   · the reading — one vision call per ad not read yet (its first picture), with the SAME schema this app reads its
 *                  own creatives with (read-creatives.mjs), so a survey value and What wins' value are named alike;
 *                  kept by the picture's content hash in swipe/{niche}/survey-reads.json. An advertiser that is not a
 *                  fitness business (a keyword search returns them) and an ad with no picture are left out, uncalled.
 *   · the survey — by rule, no model: for each kind of picture, how many ADVERTISERS run it (one advertiser's ten
 *                  ads are one voice) and how many of them have kept one running LONG_RUN_DAYS or more. An ad still
 *                  paid for after three months is presumably paying: a survivorship proxy, never a result — the Ad
 *                  Library shows no spend and no leads, and that is said wherever the survey is shown.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { callVision, imageSize, CHECK_MODEL } from "./check-visual.mjs";
import { READ_SCHEMA, READ_QUESTION, FORMATS, ratioOf } from "./read-creatives.mjs";

export const SURVEY_READS = "survey-reads.json";
/** An ad kept running this long is counted as a survivor; a value is said from this many advertisers, and is solid from the second figure. */
export const LONG_RUN_DAYS = 90, MIN_ADVERTISERS = 3, SOLID_ADVERTISERS = 8;
/** The pull's and the reading's caps (the panel's confirmation is checked against them server-side). */
export const PULL_MIN = 20, PULL_MAX = 300, PULL_DEFAULT = 80, READ_DEFAULT = 60;
/** A fitness business, by its name, its words or its link: a keyword search of the Ad Library also returns advertisers that are not. */
export const FITNESS = /gym|fitness|fit\b|training|trainer|pilates|reformer|lagree|yoga|bootcamp|boot camp|crossfit|hyrox|hiit|workout|strength|coach|f45|barre|boxing|muay|kickbox|spin|cycle|studio|athlet|wellness|sculpt|toned|transformation|challenge|membership|classes|kettlebell|dumbbell|weights|lifting|cardio|fat loss|weight loss|健身|瑜伽|瑜珈|皮拉提斯|教練|體態|重訓|塑身|瘦身/i;
export const ATTRS = [["format", "Kind of picture"], ["subject", "Subject"], ["backdrop", "Backdrop"], ["pose", "Pose"], ["expression", "Expression"], ["eye_contact", "Eye contact"], ["text_density", "Words on the picture"], ["logo", "Logo"], ["ratio", "Shape"]];
/** How this app makes each kind of picture — or why it does not. */
export const MAKE = {
  workout: { how: "a workout scene" }, "class-group": { how: "a workout scene with a group setting" }, "studio-portrait": { how: "a studio portrait scene" },
  review: { how: "a review card" }, "offer-card": { how: "the formula look's offer card" }, premises: { how: "a real premises photo, ticked on Generate Creatives" },
  testimonial: { how: null, why: "not made here yet (a statement card comes closest)" }, lifestyle: { how: null, why: "not made here" },
  "person-talking": { how: null, why: "a video: this app makes stills" }, "before-after": { how: null, why: "never used here: before-and-after photos are a standing rule" }, other: { how: null, why: "not one kind" },
};
const SURVEY_QUESTION = READ_QUESTION.replace("from a gym's own ad account, to record HOW it was made so the account's results can be compared by kind", "that another fitness business is running, to record HOW it was made so kinds of advert can be compared");

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)) : null; };
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

/** Every scrape on disk, oldest first: [{ date, dir, country, scraped_at, terms, ads }]. */
export function scrapes(swipeDir) {
  const raw = join(swipeDir, "raw"); if (!existsSync(raw)) return [];
  return readdirSync(raw).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && statSync(join(raw, d)).isDirectory()).sort().map((date) => {
    const j = readJson(join(raw, date, "ads-normalized.json")); if (!j || !Array.isArray(j.ads)) return null;
    return { date, dir: join(raw, date), country: (j.country || "").toUpperCase() || null, scraped_at: j.scraped_at || date, terms: j.terms || [], ads: j.ads };
  }).filter(Boolean);
}
/**
 * Every ad of every scrape, once (the latest scrape of an ad wins: it has run longer), each with its first picture
 * on disk and why it is left out, if it is: { ad_id, advertiser, country, scraped, days, start, variants, file, sha, left_out }.
 * `ours`: the names of this app's own gyms — their ads are theirs, not another operator's.
 */
export function surveyAds(swipeDir, { country = null, ours = [] } = {}) {
  const mine = ours.map((n) => String(n || "").toLowerCase().trim()).filter((n) => n.length >= 4), by = new Map();
  for (const s of scrapes(swipeDir)) for (const a of s.ads) {
    const rel = (a.image_files || []).find((f) => existsSync(join(s.dir, f))) || null, name = String(a.page_name || "").trim();
    const words = [name, a.primary_text, a.landing_url].filter(Boolean).join(" ");
    const left_out = !name ? "no_advertiser" : mine.some((n) => name.toLowerCase().includes(n)) ? "ours" : !FITNESS.test(words) ? "not_fitness" : !rel ? "no_picture" : null;
    by.set(String(a.ad_id || `${name}|${a.start_date}`), { ad_id: String(a.ad_id || ""), advertiser: name, country: s.country, scraped: s.date, days: Number(a.days_active) || 0, start: a.start_date || null, variants: Number(a.variant_count) || 1,
      file: rel ? join(s.dir, rel) : null, sha: rel ? basename(rel).replace(/\.[a-z0-9]+$/i, "") : null, left_out });
  }
  return [...by.values()].filter((a) => !country || a.country === String(country).toUpperCase());
}
export const readSurveyReads = (swipeDir) => { const j = readJson(join(swipeDir, SURVEY_READS)); return { schema: 1, model: CHECK_MODEL, reads: {}, ...(j || {}), reads: j?.reads && typeof j.reads === "object" ? j.reads : {} }; };
/** How many pictures a reading would cost: one per ad kept and not read yet (the same picture under two ads is read once). */
export function unreadSurvey(swipeDir, opts = {}) { const store = readSurveyReads(swipeDir), ids = new Set(); for (const a of surveyAds(swipeDir, opts)) if (!a.left_out && !store.reads[a.sha]?.format) ids.add(a.sha); return ids.size; }

/** Read the pictures not read yet, one vision call each, under `max`. The attributes are kept; the words printed on another operator's ad are not. */
export async function readSurvey({ swipeDir, ask = callVision, max = READ_DEFAULT, ours = [], log = () => {}, now = () => new Date().toISOString() }) {
  const store = readSurveyReads(swipeDir), done = { read: 0, cached: 0, calls: 0, left: 0, failed: [] }, seen = new Set();
  for (const a of surveyAds(swipeDir, { ours })) {
    if (a.left_out || seen.has(a.sha)) continue; seen.add(a.sha);
    if (store.reads[a.sha]?.format) { done.cached++; continue; }
    if (done.calls >= max) { done.left++; continue; }
    done.calls++; log(`reading ${a.advertiser.slice(0, 50)} (${a.days} days)`);
    let size = null; try { size = imageSize(readFileSync(a.file)); } catch { size = null; }
    try {
      const r = await ask(a.file, SURVEY_QUESTION, READ_SCHEMA);
      store.reads[a.sha] = { ratio: size ? ratioOf(size) : "other", read_on: now(), model: store.model || CHECK_MODEL, format: r.format, subject: r.subject, people: r.people, backdrop: r.backdrop, pose: r.pose, expression: r.expression, eye_contact: !!r.eye_contact, text_density: r.text_density, logo: !!r.logo };
      done.read++; writeWhole(join(swipeDir, SURVEY_READS), JSON.stringify(store, null, 2) + "\n");
    } catch (e) { done.failed.push(`${a.advertiser}: ${e.message}`); }
  }
  return done;
}

const valueOf = (read, key) => (key === "eye_contact" ? (read.eye_contact ? "yes" : "no") : key === "logo" ? (read.logo ? "yes" : "no") : read[key] ?? null);
/**
 * The survey, by rule (pure). Counted per ADVERTISER: for each value, the advertisers that run a picture of it and
 * the ones that have kept one running LONG_RUN_DAYS or more; `share` is the second over the first, `index` that share
 * over the survey's own; a value is said from MIN_ADVERTISERS advertisers ("enough"), solid from SOLID_ADVERTISERS.
 */
export function surveyFrom(ads, reads = {}) {
  const left_out = {}, kept = [];
  for (const a of ads) { if (a.left_out) { left_out[a.left_out] = (left_out[a.left_out] || 0) + 1; continue; } kept.push({ ...a, read: reads[a.sha]?.format ? reads[a.sha] : null }); }
  const read = kept.filter((a) => a.read), firms = (xs) => new Set(xs.map((a) => a.advertiser)), longOf = (xs) => firms(xs.filter((a) => a.days >= LONG_RUN_DAYS));
  const all = firms(read), allLong = longOf(read), overall = pct(allLong.size, all.size);
  const tables = ATTRS.map(([key, label]) => {
    const by = new Map(); for (const a of read) { const v = valueOf(a.read, key); if (v == null || v === "") continue; (by.get(v) || by.set(v, []).get(v)).push(a); }
    const values = [...by.entries()].map(([value, xs]) => { const f = firms(xs).size, l = longOf(xs).size, share = pct(l, f);
      return { value: String(value), ads: xs.length, advertisers: f, long_running: l, share, index: overall ? Math.round((share / overall) * 100) / 100 : null, median_days: median(xs.map((a) => a.days)), confidence: f >= SOLID_ADVERTISERS ? "solid" : f >= MIN_ADVERTISERS ? "enough" : "early" }; })
      .sort((a, b) => (b.confidence !== "early") - (a.confidence !== "early") || b.share - a.share || b.advertisers - a.advertisers);
    return { key, label, values };
  });
  // The longest-running advertisers, one line each: their longest ad that was read, and what kind it is.
  const longest = new Map(); for (const a of read) { const had = longest.get(a.advertiser); if (!had || a.days > had.days) longest.set(a.advertiser, a); }
  const long_runners = [...longest.values()].sort((a, b) => b.days - a.days).slice(0, 10).map((a) => ({ advertiser: a.advertiser, days: a.days, country: a.country, format: a.read.format, subject: a.read.subject, backdrop: a.read.backdrop }));
  const dates = ads.map((a) => a.scraped).filter(Boolean).sort();
  return { long_run_days: LONG_RUN_DAYS, ads: ads.length, kept: kept.length, read: read.length, unread: new Set(kept.filter((a) => !a.read).map((a) => a.sha)).size, advertisers: all.size, long_running: allLong.size, overall, left_out,
    countries: [...new Set(ads.map((a) => a.country).filter(Boolean))].sort(), surveyed: { first: dates[0] || null, last: dates[dates.length - 1] || null }, tables, long_runners };
}
/**
 * The kinds of picture for one gym: each kind enough advertisers run, the most survivors first, with whether this
 * gym has ever run it (`ran`: the kinds its own ads were read as) and how this app makes it — or why it does not.
 */
export function candidatesFor(survey, { ran = [] } = {}) {
  const have = new Set(ran), t = survey.tables.find((x) => x.key === "format");
  return (t?.values || []).filter((v) => v.confidence !== "early" && v.value !== "other").map((v) => {
    const m = MAKE[v.value] || { how: null, why: "not made here" }, tried = have.has(v.value);
    return { format: v.value, what: FORMATS[v.value] || v.value, advertisers: v.advertisers, long_running: v.long_running, share: v.share, index: v.index, median_days: v.median_days, confidence: v.confidence, tried, makeable: !!m.how, how: m.how, why_not: m.how ? null : m.why,
      candidate: !tried && !!m.how && survey.overall != null && v.share >= survey.overall,
      text: `${v.value}: ${v.advertisers} advertisers run it, ${v.long_running} of them for ${LONG_RUN_DAYS} days or more (${v.share}%, against ${survey.overall}% of all).${tried ? " This gym has run it." : m.how ? ` Never run in this account: made here as ${m.how}.` : ` Never run in this account, and ${m.why}.`}` };
  });
}
/** Everything the page shows, from the files (no call): the survey and, for a gym, its candidates. */
export function buildSurvey(swipeDir, { country = null, ours = [], ran = null } = {}) {
  const every = surveyAds(swipeDir, { ours }), here = country ? every.filter((a) => a.country === String(country).toUpperCase()) : every;
  // A gym's own country when it has been surveyed; else every country on file, and that is said.
  const scoped = country && here.length ? here : every, s = surveyFrom(scoped, readSurveyReads(swipeDir).reads);
  return { ...s, scope: country && here.length ? String(country).toUpperCase() : null, asked: country ? String(country).toUpperCase() : null, scrapes: scrapes(swipeDir).map((x) => ({ date: x.date, country: x.country, ads: x.ads.length, terms: x.terms })), candidates: ran ? candidatesFor(s, { ran }) : [] };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "swipe-dir": { type: "string" }, niche: { type: "string", default: "gym" }, pull: { type: "string" }, country: { type: "string", default: "SG" }, terms: { type: "string" }, read: { type: "boolean", default: false }, max: { type: "string", default: String(READ_DEFAULT) }, show: { type: "boolean", default: false }, "i-understand-tos": { type: "boolean", default: false }, ours: { type: "string", default: "" } } });
  if (!(v.pull || v.read || v.show)) { console.error("Usage: library-survey.mjs [--pull <ads> --country SG [--terms a,b] --i-understand-tos] [--read --max 60] [--show]   [--swipe-dir swipe/gym]\n  --pull reads the Ad Library through Apify (billed to the Apify account). --read makes one vision call per unread picture. --show prints the survey from what is on disk (no call)."); process.exit(1); }
  const swipeDir = v["swipe-dir"] ? resolve(v["swipe-dir"]) : join(REPO_ROOT, "swipe", v.niche), ours = v.ours.split("|").map((x) => x.trim()).filter(Boolean);
  try {
    if (v.pull) {
      const n = Math.max(PULL_MIN, Math.min(PULL_MAX, parseInt(v.pull, 10) || PULL_DEFAULT));
      if (!v["i-understand-tos"]) { console.error("The pull scrapes Meta's Ad Library through Apify, a grey area under Meta's terms; the creatives are other operators' and are used for analysis only. Run it again with --i-understand-tos to go on."); process.exit(1); }
      console.log(`· pulling up to ${n} ads from the Ad Library for ${v.country.toUpperCase()} through Apify`);
      execFileSync(process.execPath, [join(REPO_ROOT, "skills", "references", "scrape-meta-ads.mjs"), "--niche", v.niche, "--country", v.country.toUpperCase(), "--limit", String(n), "--out", swipeDir, "--i-understand-tos", ...(v.terms ? ["--terms", v.terms] : [])], { stdio: "inherit", cwd: REPO_ROOT });
    }
    if (v.read) {
      const d = await readSurvey({ swipeDir, max: Math.max(0, parseInt(v.max, 10) || 0), ours, log: (m) => console.log(`  ${m}`) });
      console.log(`· ${d.read} picture${d.read === 1 ? "" : "s"} read (${d.calls} call${d.calls === 1 ? "" : "s"}), ${d.cached} read before${d.left ? `, ${d.left} left for another run (the cap)` : ""}${d.failed.length ? `, ${d.failed.length} failed` : ""}`);
      for (const f of d.failed.slice(0, 5)) console.log(`  ! ${f}`);
    }
    const S = buildSurvey(swipeDir, { ours });
    console.log(`${S.ads} ads on file from ${S.scrapes.length} pull${S.scrapes.length === 1 ? "" : "s"} (${S.countries.join(", ") || "no country"}): ${S.kept} kept, ${S.read} read, ${S.unread} not read yet${Object.keys(S.left_out).length ? ` · left out: ${Object.entries(S.left_out).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")}` : ""}`);
    if (S.read) { console.log(`${S.advertisers} advertisers; ${S.long_running} of them (${S.overall}%) have kept an ad running ${LONG_RUN_DAYS} days or more.`);
      for (const t of S.tables) console.log(`${t.label}: ${t.values.map((x) => `${x.value} ${x.long_running}/${x.advertisers} (${x.share}%${x.confidence === "early" ? ", early" : ""})`).join(" | ")}`); }
  } catch (e) { console.error(String(e.message || e).replace(/apify_api_[A-Za-z0-9]+/g, "[token]")); process.exit(1); }
}
