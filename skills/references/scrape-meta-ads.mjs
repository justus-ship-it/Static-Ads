#!/usr/bin/env node
/**
 * scrape-meta-ads.mjs — Phase 0 competitor ingestion (Apify → Meta Ad Library)
 *
 * Pulls gym/fitness ads from the Meta (Facebook) Ad Library via an Apify actor,
 * normalizes them to a stable schema, and downloads + de-duplicates the creatives
 * to disk. Output feeds rank-swipe-ads.mjs → the swipe-intel analysis skill.
 *
 * IMPORTANT — legal / ToS posture:
 *   The official Meta Ad Library API does NOT return commercial ads (only ads about
 *   social issues, elections, or politics), so gym ads are only reachable by scraping
 *   the Ad Library website. That is a grey area under Meta's Terms. The creatives are
 *   third-party copyrighted works. This tool uses them for PATTERN ANALYSIS ONLY — they
 *   are never republished and never used as generation reference images. The `swipe/`
 *   tree is git-ignored. You must pass --i-understand-tos to run.
 *
 * Usage:
 *   node skills/references/scrape-meta-ads.mjs --niche gym --country SG \
 *     --terms "gym,fitness studio,personal training" --limit 300 --active active --i-understand-tos
 *
 *   # Bring your own Apify actor input (schemas vary between actors):
 *   node skills/references/scrape-meta-ads.mjs --niche gym --input-file my-input.json --i-understand-tos
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_ACTOR = "curious_coder~facebook-ads-library-scraper";
const APIFY_BASE = "https://api.apify.com/v2";
const DOWNLOAD_CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// .env loader (mirrors loadGeminiKey in generate_ads_gemini.mjs)
// ---------------------------------------------------------------------------

function loadEnvVar(key) {
  if (process.env[key]) return process.env[key];
  const envPaths = [
    resolve(__dirname, "..", "..", ".env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** First non-empty value found by walking a list of dot-paths into obj. */
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of path.split(".")) {
      if (cur == null || typeof cur !== "object") { ok = false; break; }
      cur = cur[seg];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return undefined;
}

/** Collect image URLs from the many shapes Ad Library actors emit. */
function collectImageUrls(raw) {
  const urls = new Set();
  const add = (v) => { if (typeof v === "string" && /^https?:\/\//.test(v)) urls.add(v); };

  // Flat fields
  for (const v of [].concat(raw.images || [], raw.imageUrls || [], raw.image_urls || [])) add(v);
  add(raw.imageUrl);
  add(raw.original_image_url);

  // snapshot.images[] / snapshot.cards[] (curious_coder + apify/facebook-ads shapes)
  const snap = raw.snapshot || {};
  for (const arrKey of ["images", "cards"]) {
    for (const item of snap[arrKey] || []) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        add(item.original_image_url);
        add(item.resized_image_url);
        add(item.image_url);
        add(item.video_preview_image_url);
      }
    }
  }
  // Video thumbnails are still useful reference frames for pattern analysis
  for (const vid of snap.videos || []) {
    if (vid && typeof vid === "object") add(vid.video_preview_image_url);
  }
  return [...urls];
}

/** Parse a Meta start date (unix seconds OR ISO string) into YYYY-MM-DD. */
function toISODate(value) {
  if (value == null) return null;
  let ms;
  if (typeof value === "number") {
    ms = value < 1e12 ? value * 1000 : value; // seconds vs ms
  } else {
    const n = Number(value);
    if (!Number.isNaN(n) && /^\d+$/.test(String(value).trim())) {
      ms = n < 1e12 ? n * 1000 : n;
    } else {
      ms = Date.parse(value);
    }
  }
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(isoDate, nowMs) {
  if (!isoDate) return 0;
  const start = Date.parse(isoDate);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((nowMs - start) / 86400000));
}

/** Normalize one raw Apify item into the stable swipe schema. */
function normalizeAd(raw, nowMs) {
  const ad_id = String(
    pick(raw, ["ad_archive_id", "adArchiveID", "ad_archive_ID", "adArchiveId", "id", "adId", "snapshot.ad_archive_id"]) ?? ""
  );
  const page_name = pick(raw, ["page_name", "pageName", "snapshot.page_name", "snapshot.page_profile_name"]) || "";

  const startRaw = pick(raw, [
    "start_date", "startDate", "ad_delivery_start_time", "startDateFormatted", "snapshot.start_date",
  ]);
  const start_date = toISODate(startRaw);

  // Variant / iteration signal: how many ads collate under this entry. Use the larger of
  // collation_count and ads_count; deliberately NOT "total" (that's the search-result count,
  // not a per-ad figure) or reach/active-time (not variant counts).
  const variant_count = Math.max(
    Number(pick(raw, ["collation_count", "collationCount", "uniqueAdsCount"]) ?? 1) || 1,
    Number(pick(raw, ["ads_count", "adsCount"]) ?? 1) || 1
  );

  let primary_text = pick(raw, [
    "snapshot.body.text", "snapshot.body", "body.text", "body",
    "ad_creative_body", "adCreativeBody", "snapshot.link_description",
  ]);
  if (Array.isArray(primary_text)) primary_text = primary_text[0];
  if (primary_text && typeof primary_text === "object") primary_text = primary_text.text || "";
  primary_text = (primary_text || "").toString().trim();

  const cta = (pick(raw, ["snapshot.cta_text", "cta_text", "snapshot.cta_type", "ctaText", "callToActionType"]) || "")
    .toString().trim();

  const landing_url = (pick(raw, ["snapshot.link_url", "link_url", "linkUrl", "snapshot.caption"]) || "")
    .toString().trim();

  return {
    ad_id,
    page_name: page_name.toString().trim(),
    start_date,
    days_active: daysBetween(start_date, nowMs),
    variant_count,
    primary_text,
    cta,
    image_urls: collectImageUrls(raw),
    landing_url,
    image_files: [], // filled after download
  };
}

// ---------------------------------------------------------------------------
// Apify
// ---------------------------------------------------------------------------

function buildAdLibrarySearchUrls(terms, country, active) {
  const activeStatus = active === "all" ? "all" : active === "inactive" ? "inactive" : "active";
  return terms.map((term) => {
    const params = new URLSearchParams({
      active_status: activeStatus,
      ad_type: "all",
      country,
      q: term,
      search_type: "keyword_unordered",
      media_type: "all",
    });
    return `https://www.facebook.com/ads/library/?${params.toString()}`;
  });
}

/** Default actor input. Includes several key aliases so it works across actor flavors. */
function buildDefaultInput(searchUrls, limit, country, active) {
  return {
    urls: searchUrls.map((url) => ({ url, method: "GET" })),
    startUrls: searchUrls.map((url) => ({ url })),
    count: limit,
    maxItems: limit,
    "scrapePageAds.activeStatus": active,
    activeStatus: active,
    country,
  };
}

async function runApifyActor(actorId, token, input) {
  const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&clean=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify run failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error(`Unexpected Apify response (expected array): ${JSON.stringify(items).slice(0, 200)}`);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Image download + dedupe (semaphore pattern, cf. generate_ads_gemini.mjs:254-281)
// ---------------------------------------------------------------------------

const EXT_BY_CT = {
  "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/gif": ".gif",
};

async function downloadImages(ads, imagesDir, seenHashes) {
  // Flatten to a work list of { ad, url } so we can pool downloads.
  const jobs = [];
  for (const ad of ads) for (const url of ad.image_urls) jobs.push({ ad, url });

  let idx = 0;
  let downloaded = 0;
  let deduped = 0;

  async function worker() {
    while (idx < jobs.length) {
      const { ad, url } = jobs[idx++];
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) continue;
        const hash = createHash("sha1").update(buf).digest("hex");
        const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext = EXT_BY_CT[ct] || extname(new URL(url).pathname).toLowerCase() || ".jpg";
        const rel = join("images", `${hash}${ext}`);
        if (!ad.image_files.includes(rel)) ad.image_files.push(rel);
        if (seenHashes.has(hash)) { deduped++; continue; }
        seenHashes.add(hash);
        writeFileSync(join(imagesDir, `${hash}${ext}`), buf);
        downloaded++;
      } catch {
        /* skip unreachable creative */
      }
    }
  }

  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
  return { downloaded, deduped };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function todayStamp(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const { values } = parseArgs({
    options: {
      niche: { type: "string", default: "gym" },
      country: { type: "string", default: "US" },
      terms: { type: "string", default: "gym,fitness studio,personal training" },
      limit: { type: "string", default: "300" },
      active: { type: "string", default: "active" },
      out: { type: "string", default: "" },
      actor: { type: "string", default: "" },
      "input-file": { type: "string", default: "" },
      "i-understand-tos": { type: "boolean", default: false },
    },
    strict: false,
  });

  const nowMs = Date.now();

  // ── ToS gate ──
  console.log(
    "\n⚠  LEGAL NOTICE — Meta Ad Library scraping\n" +
    "   The official Ad Library API does not return commercial (gym) ads, so this\n" +
    "   pulls them by scraping, which is a grey area under Meta's Terms. Creatives are\n" +
    "   third-party copyrighted works used for PATTERN ANALYSIS ONLY — never republished\n" +
    "   and never used as generation reference images. The swipe/ tree is git-ignored.\n"
  );
  if (!values["i-understand-tos"]) {
    console.error("Refusing to run without --i-understand-tos. Re-run with that flag to proceed.");
    process.exit(1);
  }

  const token = loadEnvVar("APIFY_TOKEN");
  if (!token) {
    console.error("Error: APIFY_TOKEN not found. Add it to .env (see .env.example).");
    process.exit(1);
  }
  const actorId = values.actor || loadEnvVar("APIFY_ADLIB_ACTOR") || DEFAULT_ACTOR;
  const niche = values.niche;
  const country = values.country.toUpperCase();
  const limit = parseInt(values.limit, 10) || 300;
  const active = values.active;
  const terms = values.terms.split(",").map((t) => t.trim()).filter(Boolean);

  const outRoot = values.out ? resolve(values.out) : resolve(process.cwd(), "swipe", niche);
  const dateDir = join(outRoot, "raw", todayStamp(nowMs));
  const imagesDir = join(dateDir, "images");
  mkdirSync(imagesDir, { recursive: true });

  // ── Build actor input ──
  let input;
  if (values["input-file"]) {
    input = JSON.parse(readFileSync(resolve(values["input-file"]), "utf-8"));
    console.log(`Using raw actor input from ${values["input-file"]}`);
  } else {
    const searchUrls = buildAdLibrarySearchUrls(terms, country, active);
    input = buildDefaultInput(searchUrls, limit, country, active);
  }
  writeFileSync(join(dateDir, "scrape-input.json"), JSON.stringify({ actorId, input }, null, 2));

  const sep = "=".repeat(60);
  console.log(sep);
  console.log(`  Niche:    ${niche}`);
  console.log(`  Actor:    ${actorId}`);
  console.log(`  Country:  ${country}`);
  console.log(`  Terms:    ${terms.join(", ")}`);
  console.log(`  Active:   ${active}`);
  console.log(`  Limit:    ${limit}`);
  console.log(`  Output:   ${dateDir}`);
  console.log(sep);

  // ── Run actor ──
  console.log("\nRunning Apify actor (this can take a few minutes)...");
  const rawItems = await runApifyActor(actorId, token, input);
  console.log(`  Actor returned ${rawItems.length} raw items.`);
  writeFileSync(join(dateDir, "ads-raw.json"), JSON.stringify(rawItems, null, 2));

  // ── Normalize + dedupe by ad_id ──
  const byId = new Map();
  let noId = 0;
  for (const raw of rawItems) {
    const ad = normalizeAd(raw, nowMs);
    if (!ad.ad_id) { noId++; continue; }
    if (!byId.has(ad.ad_id)) byId.set(ad.ad_id, ad);
  }
  const ads = [...byId.values()];
  console.log(`  Normalized ${ads.length} unique ads (${noId} skipped: no ad_id, ${rawItems.length - ads.length - noId} duplicate ids).`);

  // ── Skip ad_ids already captured in prior scrape dates ──
  const priorIds = collectPriorAdIds(outRoot, dateDir);
  const fresh = ads.filter((a) => !priorIds.has(a.ad_id));
  if (priorIds.size) {
    console.log(`  ${ads.length - fresh.length} ads already seen in earlier scrapes — keeping for this snapshot, flagged below.`);
  }

  // ── Download creatives (content-hash dedupe, shared across this scrape) ──
  console.log(`\nDownloading creatives (${DOWNLOAD_CONCURRENCY} concurrent)...`);
  const seenHashes = new Set();
  const { downloaded, deduped } = await downloadImages(ads, imagesDir, seenHashes);
  console.log(`  ${downloaded} images saved, ${deduped} duplicate creatives collapsed.`);

  const withImages = ads.filter((a) => a.image_files.length > 0).length;

  // ── Write normalized output ──
  const normalizedPath = join(dateDir, "ads-normalized.json");
  writeFileSync(
    normalizedPath,
    JSON.stringify(
      {
        niche,
        country,
        scraped_at: new Date(nowMs).toISOString(),
        actor: actorId,
        terms,
        active_status: active,
        note: "Longevity/volume proxy only — Meta exposes NO spend/impression/CTR data for commercial ads.",
        total_ads: ads.length,
        new_since_last_scrape: fresh.length,
        ads,
      },
      null,
      2
    )
  );

  console.log(`\n${sep}`);
  console.log(`  DONE`);
  console.log(`  Unique ads:       ${ads.length} (${withImages} with downloaded creatives)`);
  console.log(`  New vs prior:     ${fresh.length}`);
  console.log(`  Normalized file:  ${normalizedPath}`);
  console.log(`\n  Next:  node skills/references/rank-swipe-ads.mjs --in ${outRoot} --top 20`);
  console.log(sep);
}

/** Gather ad_ids from ads-normalized.json files in earlier scrape-date folders. */
function collectPriorAdIds(outRoot, currentDateDir) {
  const ids = new Set();
  const rawDir = join(outRoot, "raw");
  if (!existsSync(rawDir)) return ids;
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(rawDir, entry.name);
    if (dir === currentDateDir) continue;
    const f = join(dir, "ads-normalized.json");
    if (!existsSync(f)) continue;
    try {
      const data = JSON.parse(readFileSync(f, "utf-8"));
      for (const ad of data.ads || []) if (ad.ad_id) ids.add(ad.ad_id);
    } catch { /* ignore corrupt prior file */ }
  }
  return ids;
}

// Pure helpers exported for testing; main() runs only when invoked directly.
export { normalizeAd, collectImageUrls, toISODate, daysBetween, pick };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Fatal error:", e.message);
    process.exit(1);
  });
}
