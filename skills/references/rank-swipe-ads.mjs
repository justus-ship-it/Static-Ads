#!/usr/bin/env node
/**
 * rank-swipe-ads.mjs — Phase 0 ranking (longevity + volume proxy)
 *
 * Reads the most recent ads-normalized.json under swipe/{niche}/raw/{date}/ and
 * scores each ad by a SURVIVORSHIP proxy, then writes swipe/{niche}/ranked.json
 * with a diversified top-N flagged for analysis.
 *
 *   ⚠ Meta exposes NO spend / impression / CTR data for commercial (gym) ads.
 *     This ranks how long an ad has SURVIVED (kept running) and how many variants
 *     an advertiser is iterating — a swipe-file heuristic for "probably working",
 *     NOT measured performance. Treat it as a shortlist, not a leaderboard.
 *
 * Score:
 *   days_norm    = min(days_active / 365, 1)
 *   variant_norm = min(variant_count / 6, 1)
 *   score        = 0.65 * days_norm + 0.35 * variant_norm
 *
 * Usage:
 *   node skills/references/rank-swipe-ads.mjs --in swipe/gym --top 20
 *   node skills/references/rank-swipe-ads.mjs --in swipe/gym --top 20 --per-page 3 --date 2026-06-20
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";

const DAYS_CAP = 365; // gym ads run for years; a 1-year evergreen is the strong-longevity mark
const VARIANT_CAP = 6;
const W_DAYS = 0.65;
const W_VARIANTS = 0.35;

function scoreAd(ad) {
  const daysNorm = Math.min((ad.days_active || 0) / DAYS_CAP, 1);
  const variantNorm = Math.min((ad.variant_count || 1) / VARIANT_CAP, 1);
  const score = W_DAYS * daysNorm + W_VARIANTS * variantNorm;
  return {
    score: Number(score.toFixed(4)),
    score_breakdown: {
      days_active: ad.days_active || 0,
      days_norm: Number(daysNorm.toFixed(4)),
      variant_count: ad.variant_count || 1,
      variant_norm: Number(variantNorm.toFixed(4)),
      weights: { days: W_DAYS, variants: W_VARIANTS },
    },
  };
}

/** Find the newest raw/{date}/ads-normalized.json (or a specific --date). */
function findNormalized(inRoot, dateOverride) {
  const rawDir = join(inRoot, "raw");
  if (!existsSync(rawDir)) throw new Error(`No raw/ folder under ${inRoot}. Run scrape-meta-ads.mjs first.`);
  const dates = readdirSync(rawDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(rawDir, name, "ads-normalized.json")))
    .sort();
  if (dates.length === 0) throw new Error(`No ads-normalized.json found under ${rawDir}.`);
  const chosen = dateOverride || dates[dates.length - 1];
  if (!dates.includes(chosen)) throw new Error(`No scrape for date ${chosen}. Available: ${dates.join(", ")}`);
  return { date: chosen, path: join(rawDir, chosen, "ads-normalized.json") };
}

function main() {
  const { values } = parseArgs({
    options: {
      in: { type: "string", default: "swipe/gym" },
      top: { type: "string", default: "20" },
      "per-page": { type: "string", default: "3" },
      date: { type: "string", default: "" },
    },
    strict: false,
  });

  const inRoot = resolve(values.in);
  const topN = parseInt(values.top, 10) || 20;
  const perPage = parseInt(values["per-page"], 10) || 3;

  const { date, path } = findNormalized(inRoot, values.date || null);
  const data = JSON.parse(readFileSync(path, "utf-8"));
  const ads = data.ads || [];
  if (ads.length === 0) throw new Error(`No ads in ${path}.`);

  // Score every ad.
  const scored = ads.map((ad) => ({ ...ad, ...scoreAd(ad) }));
  // Prefer ads that actually have downloaded creatives (analysis needs images).
  scored.sort((a, b) => {
    const ai = (a.image_files?.length || 0) > 0 ? 1 : 0;
    const bi = (b.image_files?.length || 0) > 0 ? 1 : 0;
    if (ai !== bi) return bi - ai;
    return b.score - a.score;
  });

  // Diversify: cap ads per advertiser so one prolific page can't fill the shortlist.
  const perPageCount = new Map();
  const top = [];
  for (const ad of scored) {
    if (top.length >= topN) break;
    if ((ad.image_files?.length || 0) === 0) continue; // analysis needs an image
    const key = (ad.page_name || "unknown").toLowerCase();
    const n = perPageCount.get(key) || 0;
    if (n >= perPage) continue;
    perPageCount.set(key, n + 1);
    top.push(ad.ad_id);
  }

  const topSet = new Set(top);
  const ranked = scored.map((ad, i) => ({
    rank: i + 1,
    top: topSet.has(ad.ad_id),
    ...ad,
  }));

  const outPath = join(inRoot, "ranked.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        niche: data.niche,
        country: data.country,
        source_scrape_date: date,
        ranked_at: data.scraped_at,
        methodology: {
          type: "survivorship-proxy",
          warning: "No real performance data exists for commercial ads. Longevity + variant count only.",
          formula: "0.65*min(days_active/365,1) + 0.35*min(variant_count/6,1)",
          per_page_cap: perPage,
          top_n: topN,
        },
        top_ad_ids: top,
        ads: ranked,
      },
      null,
      2
    )
  );

  const sep = "=".repeat(60);
  console.log(sep);
  console.log("  ⚠ SURVIVORSHIP PROXY — not measured performance (no spend/CTR exists).");
  console.log(sep);
  console.log(`  Scored:     ${ranked.length} ads from ${date}`);
  console.log(`  Shortlist:  ${top.length} (top ${topN}, max ${perPage}/advertiser)`);
  console.log(`  Output:     ${outPath}`);
  console.log("\n  Top shortlist:");
  for (const ad of ranked.filter((a) => a.top).slice(0, topN)) {
    const name = (ad.page_name || "unknown").slice(0, 28).padEnd(28);
    console.log(
      `    ${String(ad.rank).padStart(3)}. ${name} score=${ad.score.toFixed(3)}  ` +
      `${ad.days_active}d active · ${ad.variant_count} variants`
    );
  }
  console.log(`\n  Next:  run the /swipe-intel skill to analyze the shortlist into templates.`);
  console.log(sep);
}

try {
  main();
} catch (e) {
  console.error("Fatal error:", e.message);
  process.exit(1);
}
