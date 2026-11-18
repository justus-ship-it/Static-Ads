/**
 * ads-export.mjs — an Ads Manager export brought into the gym's account history (2026-11-09).
 *
 * The API reads the ad account the system user is assigned to, and nothing else. F45 Jurong West's running
 * campaign (26 ads, 532 leads since April 2026) sits in an account the system user does not reach, so its
 * numbers came as a CSV exported from Ads Manager, its creatives as a folder of files and its words as one
 * file per offer. This module turns those three into rows of `brands/{gym}/account-history.json` in the shape
 * the API pull writes (origin "export"), files the creatives under `references/` with a record beside each,
 * and the copies into `copy-references.json` with the offer's results — so What wins, the creative reader
 * and the library read them like any other ad. What the export adds that the API does not: Meta's three
 * rankings, frequency, and the creative files themselves.
 *
 *   node skills/references/ads-export.mjs --brand-dir brands/{gym} --csv export.csv [--creatives dir] [--copy dir] [--label "Shami's account"]
 *
 * No Meta call, no model call. A re-import of the same export replaces its rows (an ad is known by its ad set's
 * and its own name, or by its id when the export carries ids); a later API pull keeps the export's rows.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from "fs";
import { join, resolve, extname, basename } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { readHistory, readCopyRefs } from "./meta-results.mjs";

const HISTORY = "account-history.json", COPY_REFS = "copy-references.json", REF_DIR = "references";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => { if (v == null) return null; const s = String(v).replace(/[^0-9.\-]/g, ""); if (s === "" || s === "-") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

// ── the CSV ──────────────────────────────────────────────────────────────────
/** A CSV with quoted fields (commas, line breaks and doubled quotes inside them), a BOM tolerated. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}

/** Ads Manager's column names → ours (the first header matching wins). */
const COLUMNS = {
  ad: /^ad name$/i, adset: /^ad set name$/i, campaign: /^campaign name$/i, ad_id: /^ad id$/i, adset_id: /^ad set id$/i, campaign_id: /^campaign id$/i,
  delivery: /^ad delivery$/i, results: /^results$/i, indicator: /^result indicator$/i, cost_per_result: /^cost per results?$/i,
  budget: /^ad set budget$/i, budget_type: /^ad set budget type$/i, spend: /^amount spent/i, impressions: /^impressions$/i, reach: /^reach$/i, frequency: /^frequency$/i,
  clicks: /^link clicks$/i, clicks_all: /^clicks \(all\)$/i, quality: /^quality ranking$/i, engagement: /^engagement rate ranking$/i, conversion: /^conversion rate ranking$/i,
  from: /^reporting starts$/i, to: /^reporting ends$/i, edited: /^last significant edit$/i, ends: /^ends$/i,
};
/** The export's rows as plain records, plus the currency from the "Amount spent (SGD)" header. */
export function parseExport(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) throw new Error("the CSV is empty");
  const at = {};
  for (const [k, re] of Object.entries(COLUMNS)) { const i = header.findIndex((h) => re.test(h.trim())); if (i >= 0) at[k] = i; }
  if (at.ad == null) throw new Error('not an Ads Manager export: no "Ad name" column');
  const spendHeader = header[at.spend] || "", currency = (spendHeader.match(/\(([A-Z]{3})\)/) || [])[1] || null;
  const get = (r, k) => (at[k] == null ? null : (r[at[k]] ?? "").trim() || null);
  const rows = lines.filter((r) => get(r, "ad")).map((r) => {
    const indicator = get(r, "indicator") || "", results = num(get(r, "results")) ?? 0;
    const isLead = /lead/i.test(indicator);
    const spend = num(get(r, "spend")) ?? 0, impressions = num(get(r, "impressions")) ?? 0, reach = num(get(r, "reach")) ?? 0;
    const clicks = num(get(r, "clicks")) ?? num(get(r, "clicks_all")) ?? null;
    return {
      ad: get(r, "ad"), adset: get(r, "adset"), campaign: get(r, "campaign"), ad_id: get(r, "ad_id"), adset_id: get(r, "adset_id"), campaign_id: get(r, "campaign_id"),
      delivery: (get(r, "delivery") || "unknown").toLowerCase(), results, indicator: indicator || null, leads: isLead ? results : 0, result_kind: isLead ? "lead" : (indicator || null),
      spend, impressions, reach, frequency: num(get(r, "frequency")) ?? (reach ? round2(impressions / reach) : null), clicks,
      budget: num(get(r, "budget")), budget_type: get(r, "budget_type"),
      quality_ranking: ranking(get(r, "quality")), engagement_ranking: ranking(get(r, "engagement")), conversion_ranking: ranking(get(r, "conversion")),
      from: get(r, "from"), to: get(r, "to"), edited: get(r, "edited"), ends: get(r, "ends"),
    };
  });
  return { currency, rows, columns: Object.keys(at) };
}
/** "Below average – bottom 35% of ads" → "below average (bottom 35%)"; "-" → null. */
const ranking = (s) => { if (!s || s === "-" || s === "—") return null; const m = s.match(/^(.*?)\s*[–-]\s*(bottom \d+%)/i); return m ? `${m[1].trim().toLowerCase()} (${m[2].toLowerCase()})` : s.toLowerCase(); };

/** "0413 Toned Tummy Challenge | Image 2: Red Lady Drinking Water Lean Wall" → its parts. */
export function adNameParts(name) {
  const s = String(name || "").trim();
  const m = s.match(/^(?:(\d{4})\s+)?(.+?)\s*\|\s*(Image|Video|Carousel|Photo|Reel)?\s*(\d+)?\s*[:\-–]?\s*(.*)$/i);
  if (!m) return { prefix: null, offer: null, media: null, n: null, description: s };
  const [, prefix, offer, media, n, description] = m;
  return { prefix: prefix || null, offer: offer.trim() || null, media: media ? (/video|reel/i.test(media) ? "video" : "image") : null, n: n ? Number(n) : null, description: (description || "").trim() || null };
}
/** "0413 Broad Audience | Both Genders | 25-50 | +3KM" → gender, ages, radius. */
export function adsetNameFacts(name) {
  const s = String(name || "");
  const gender = /both genders|all genders|everyone/i.test(s) ? "all" : /\b(women|female|ladies)\b/i.test(s) ? "women" : /\b(men|male)\b/i.test(s) ? "men" : "all";
  const ages = s.match(/\b(\d{2})\s*[-–]\s*(\d{2})\+?\b/), radius = s.match(/\+\s*(\d+(?:\.\d+)?)\s*km/i);
  return { gender, age_min: ages ? Number(ages[1]) : null, age_max: ages ? Number(ages[2]) : null, radius_km: radius ? Number(radius[1]) : null, prefix: (s.match(/^(\d{4})\s/) || [])[1] || null };
}

// ── the creatives folder ─────────────────────────────────────────────────────
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]), VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
/** A name without its "Video 2 -" / "Image 3:" lead, lower-case letters and digits only. Version marks (V2) stay: they tell edits apart. */
const norm = (s) => String(s || "").toLowerCase().replace(/^\s*(image|video|photo|reel|carousel)\s*\d*\s*[-:–—]\s*/, "").replace(/[^a-z0-9]+/g, "");
const digits = (s) => s.replace(/[^0-9]/g, "");
const bigrams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; };
/** Dice's coefficient over character pairs: 1 is the same text, a typo costs a little ("Womawn" still matches "Woman").
 *  Digits must agree exactly — "Shami Intro 3" is not "Shami Intro 2", and not "Shami Intro 3 V2" either. */
export function similarity(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return 0; if (x === y) return 1;
  if (digits(x) !== digits(y)) return 0;
  const bx = bigrams(x), by = bigrams(y); let hit = 0;
  for (const [k, n] of bx) hit += Math.min(n, by.get(k) || 0);
  return (2 * hit) / (Math.max(x.length - 1, 1) + Math.max(y.length - 1, 1));
}
export const MATCH_FLOOR = 0.8;
/** Every creative in the folder: a sub-folder's first image or video (named for the folder), or a loose file (named for itself). */
export function listCreatives(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const files = (d) => readdirSync(d).filter((f) => !f.startsWith(".")).map((f) => join(d, f));
  for (const p of files(dir)) {
    const st = statSync(p);
    if (st.isDirectory()) {
      const inside = files(p).filter((f) => statSync(f).isFile() && (IMAGE_EXT.has(extname(f).toLowerCase()) || VIDEO_EXT.has(extname(f).toLowerCase())));
      const img = inside.find((f) => IMAGE_EXT.has(extname(f).toLowerCase())), vid = inside.find((f) => VIDEO_EXT.has(extname(f).toLowerCase()));
      if (img || vid) out.push({ name: basename(p), file: img || vid, media: img ? "image" : "video" });
    } else if (IMAGE_EXT.has(extname(p).toLowerCase()) || VIDEO_EXT.has(extname(p).toLowerCase())) out.push({ name: basename(p, extname(p)), file: p, media: IMAGE_EXT.has(extname(p).toLowerCase()) ? "image" : "video" });
  }
  return out;
}
/** The creative each row's description names best (one file may serve several ads: the same video under three offers). */
export function matchCreatives(rows, creatives) {
  return rows.map((r) => {
    const { description } = adNameParts(r.ad);
    if (!description || !creatives.length) return null;
    const scored = creatives.map((c) => ({ ...c, score: similarity(description, c.name) })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    return best && best.score >= MATCH_FLOOR ? { ...best, score: round2(best.score) } : null;
  });
}

// ── the copy files ───────────────────────────────────────────────────────────
/** An .rtf through the Mac's textutil, else a plain reading of its control words; .txt as it is. */
export function readTextFile(p) {
  if (extname(p).toLowerCase() !== ".rtf") return readFileSync(p, "utf-8");
  const r = spawnSync("textutil", ["-convert", "txt", "-stdout", p], { encoding: "utf-8" });
  if (r.status === 0 && r.stdout) return r.stdout;
  return rtfToText(readFileSync(p, "latin1"));
}
/** A small RTF reader: paragraphs, hex and unicode escapes, control words dropped. Enough for a copy file. */
export function rtfToText(rtf) {
  let out = "", depth = 0, skip = 0;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; if (skip && depth < skip) skip = 0; continue; }
    if (c === "\\") {
      const m = rtf.slice(i, i + 32).match(/^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i);
      if (!m) continue;
      i += m[0].length - 1;
      if (m[3]) { if (!skip) out += String.fromCharCode(parseInt(m[3], 16)); continue; }
      if (m[4] != null) { if (!skip) out += m[4] === "\n" || m[4] === "\r" ? "\n" : m[4] === "*" ? "" : m[4]; if (m[4] === "*") skip = depth; continue; }
      const w = m[1], n = m[2];
      if (/^(fonttbl|colortbl|stylesheet|info|pict|themedata|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|expandedcolortbl)$/.test(w)) { skip = depth; continue; }
      if (skip) continue;
      if (w === "par" || w === "line") out += "\n";
      else if (w === "tab") out += "\t";
      else if (w === "u" && n != null) { out += String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)); if (rtf[i + 1] === "?") i++; }
      continue;
    }
    if (!skip && c !== "\r" && c !== "\n") out += c;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
const stripLead = (s) => s.replace(/^[\s\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}\u{200D}•·\-–—*]+/u, "").trim();
/** "Copy 1 … Copy 5 … Headlines (5 Total): one per line" → { copies, headlines }. A "Headline N" block is one headline each. */
export function parseCopyText(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const copies = [], headlines = []; let mode = null, buf = [];
  const flush = () => { const t = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim(); if (mode === "copy" && t) copies.push(t); if (mode === "headline" && t) headlines.push(stripLead(t)); buf = []; };
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^(copy|primary text|body)\s*(\d+)?\s*:?$/i))) { flush(); mode = "copy"; continue; }
    if ((m = l.match(/^headline\s*(\d+)\s*:?$/i))) { flush(); mode = "headline"; continue; }
    if ((m = l.match(/^headlines?\s*(\([^)]*\))?\s*:?$/i))) { flush(); mode = "headlines"; continue; }
    if (mode === "headlines") { if (l) headlines.push(stripLead(l)); continue; }
    if (mode) buf.push(raw.replace(/\s+$/, ""));
  }
  flush();
  return { copies, headlines: headlines.filter(Boolean) };
}
/** The copy files of a folder, each named for its offer ("Beginner's Body Reset - Copy & Headlines.rtf"). */
export function readCopyFolder(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.startsWith(".") && /\.(rtf|txt|md)$/i.test(f)).sort().map((f) => {
    const offer = basename(f, extname(f)).replace(/\s*[-–—]?\s*copy\s*(&|and)\s*headlines?\s*$/i, "").trim();
    return { file: f, offer, ...parseCopyText(readTextFile(join(dir, f))) };
  });
}

// ── the import ───────────────────────────────────────────────────────────────
const slug = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ad";
const words = (d) => ({ active: "active", inactive: "paused", not_delivering: "not delivering", completed: "completed", rejected: "rejected", pending_review: "in review", scheduled: "scheduled", archived: "archived", deleted: "deleted", unknown: "unknown" })[d] || d.replace(/_/g, " ");
const EMPTY = () => ({ spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, cost_per_lead: null, ctr: null, cpm: null, frequency: null, from: null, to: null });
const emptyHistory = () => ({ pulled: null, account: null, currency: null, timezone: null, campaigns: [], adsets: [], ads: [], exports: [] });

/**
 * Bring an Ads Manager export into the gym's history. `csv` is the export; `creatives` a folder of the ads' files
 * (sub-folders named as the ads describe them, or loose files); `copy` a folder with one copy file per offer.
 */
export function importExport({ gymDir, csv, creatives = null, copy = null, label = null, now = new Date().toISOString() }) {
  const text = readFileSync(csv, "utf-8"), { currency, rows, columns } = parseExport(text);
  if (!rows.length) throw new Error("the export has no ad rows");
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, home = profile.locale?.country || "SG";
  const exportId = sha1(basename(csv)).slice(0, 12);
  const h = { ...emptyHistory(), ...(readHistory(gymDir) || {}) }; h.exports = Array.isArray(h.exports) ? h.exports : [];
  h.currency = h.currency || currency || profile.locale?.currency || "SGD";
  // The rows of an earlier import of this file go; the API's rows and other exports' rows stay.
  for (const k of ["campaigns", "adsets", "ads"]) h[k] = (h[k] || []).filter((x) => x.export_id !== exportId);
  const files = listCreatives(creatives), matches = matchCreatives(rows, files), copyFiles = readCopyFolder(copy);
  const refDir = join(gymDir, REF_DIR); mkdirSync(refDir, { recursive: true });
  const campaigns = new Map(), adsets = new Map(), ads = [], unmatched = [], filed = [], offers = new Map();
  const copyFor = (offer) => { if (!offer) return null; const exact = copyFiles.find((c) => norm(c.offer) === norm(offer)); if (exact) return exact; const best = copyFiles.map((c) => ({ c, s: similarity(c.offer, offer) })).sort((a, b) => b.s - a.s)[0]; return best && best.s >= 0.8 ? best.c : null; };
  rows.forEach((r, i) => {
    const parts = adNameParts(r.ad), setFacts = adsetNameFacts(r.adset);
    const campaignName = r.campaign || `${setFacts.prefix || parts.prefix || "Export"} · ${label || basename(csv, extname(csv))}`;
    const campaignId = r.campaign_id || `export:${sha1(campaignName).slice(0, 16)}`;
    const adsetId = r.adset_id || `export:${sha1(`${campaignName}|${r.adset || ""}`).slice(0, 16)}`;
    const adId = r.ad_id || `export:${sha1(`${r.adset || ""}|${r.ad}`).slice(0, 16)}`;
    const status = r.delivery === "active" ? "ACTIVE" : r.delivery === "inactive" ? "PAUSED" : r.delivery.toUpperCase();
    if (!campaigns.has(campaignId)) campaigns.set(campaignId, { id: campaignId, name: campaignName, status, effective_status: status, words: words(r.delivery), objective: r.result_kind === "lead" ? "OUTCOME_LEADS" : null, created: null, daily_budget: null, origin: "export", export_id: exportId });
    if (!adsets.has(adsetId)) adsets.set(adsetId, { id: adsetId, campaign_id: campaignId, name: r.adset || "(no ad set name)", status, effective_status: status, words: words(r.delivery), created: null,
      daily_budget: r.budget_type && /daily/i.test(r.budget_type) ? r.budget : null, gender: setFacts.gender, age_min: setFacts.age_min, age_max: setFacts.age_max, geo: setFacts.radius_km ? `+${setFacts.radius_km}km (from the ad set's name)` : null, countries: [home], abroad: false, audience: null, targeting: null, origin: "export", export_id: exportId });
    const cp = copyFor(parts.offer);
    const match = matches[i];
    let creativeFile = null;
    if (match) {
      const buf = readFileSync(match.file), ext = extname(match.file).toLowerCase().replace("jpeg", "jpg");
      const name = `export-${slug(parts.description || r.ad)}${ext}`;
      const dest = join(refDir, name);
      const same = existsSync(dest) && sha256(readFileSync(dest)) === sha256(buf);
      if (!same) writeFileSync(dest, buf);
      writeFileSync(`${dest}.meta.json`, JSON.stringify({ ad: r.ad, ad_id: adId, campaign: campaignName, adset: r.adset, offer: parts.offer, kind: match.media === "video" ? "the video itself" : "the ad's image", source: "ads-manager-export", export: basename(csv), matched_from: match.name, match_score: match.score,
        leads: r.leads, spend: r.spend, cost_per_lead: r.leads ? round2(r.spend / r.leads) : null, body: cp?.copies?.[0] || null, title: cp?.headlines?.[0] || null, imported: now }, null, 2) + "\n");
      creativeFile = name; filed.push(name);
    } else if (parts.description) unmatched.push(r.ad);
    const media = match?.media || parts.media || "other";
    ads.push({ id: adId, name: r.ad, adset_id: adsetId, campaign_id: campaignId, campaign: campaignName, adset: r.adset, status, effective_status: status, words: words(r.delivery), created: null,
      media, hashes: [], poster: null, importable: false, thumbnail: creativeFile && media === "image" ? `references/${creativeFile}` : null, creative_id: null,
      body: cp?.copies?.[0] || null, title: cp?.headlines?.[0] || null, form_id: null, offer: parts.offer, description: parts.description, creative_file: creativeFile ? `${REF_DIR}/${creativeFile}` : null,
      copies: cp ? cp.copies.length : 0, headlines: cp ? cp.headlines.length : 0,
      all_time: { ...EMPTY(), spend: round2(r.spend), impressions: r.impressions, reach: r.reach, clicks: r.clicks ?? 0, leads: r.leads, cost_per_lead: r.leads ? round2(r.spend / r.leads) : null, ctr: r.clicks != null && r.impressions ? round2((r.clicks / r.impressions) * 100) : null, cpm: r.impressions ? round2((r.spend / r.impressions) * 1000) : null, frequency: r.frequency, from: r.from, to: r.to },
      last_30d: EMPTY(), origin: "export", export_id: exportId,
      export: { file: basename(csv), delivery: r.delivery, result_kind: r.result_kind, results: r.results, quality_ranking: r.quality_ranking, engagement_ranking: r.engagement_ranking, conversion_ranking: r.conversion_ranking, last_edit: r.edited, budget: r.budget, budget_type: r.budget_type, reporting: { from: r.from, to: r.to } } });
    if (parts.offer) { const o = offers.get(parts.offer) || { offer: parts.offer, ads: 0, leads: 0, spend: 0, campaign: campaignName, copy: cp || null }; o.ads++; o.leads += r.leads; o.spend = round2(o.spend + r.spend); offers.set(parts.offer, o); }
  });
  h.campaigns.push(...campaigns.values()); h.adsets.push(...adsets.values()); h.ads.push(...ads);
  h.exports = h.exports.filter((e) => e.id !== exportId);
  const reporting = { from: rows.map((r) => r.from).filter(Boolean).sort()[0] || null, to: rows.map((r) => r.to).filter(Boolean).sort().slice(-1)[0] || null };
  h.exports.push({ id: exportId, file: basename(csv), label: label || null, imported: now, reporting, currency: currency || h.currency, columns, campaigns: campaigns.size, adsets: adsets.size, ads: ads.length, creatives: filed.length, unmatched, copy_files: copyFiles.map((c) => ({ file: c.file, offer: c.offer, copies: c.copies.length, headlines: c.headlines.length })) });
  writeWhole(join(gymDir, HISTORY), JSON.stringify(h, null, 2) + "\n");
  // The words: one copy reference per copy of each offer, with the offer's results (the copies are shared across its ads).
  const refs = readCopyRefs(gymDir); let copyAdded = 0, copyUpdated = 0;
  for (const o of offers.values()) {
    if (!o.copy) continue;
    o.copy.copies.forEach((message, i) => {
      const id = `export-${slug(o.offer)}-c${i + 1}`;
      const entry = { id, source: "export", ad_id: null, ad: `${o.offer} (every ad of the offer, ${o.ads} ad${o.ads === 1 ? "" : "s"})`, campaign: o.campaign, offer: o.offer, message, headline: o.copy.headlines[i] || o.copy.headlines[0] || null, headlines: o.copy.headlines,
        results: { leads: o.leads, spend: o.spend, cost_per_lead: o.leads ? round2(o.spend / o.leads) : null, ctr: null, shared_across: o.ads }, pulled: now, added: now.slice(0, 10), note: "" };
      const at = refs.refs.find((x) => x.id === id);
      if (at) { Object.assign(at, { ...entry, note: at.note || "", added: at.added || entry.added }); copyUpdated++; } else { refs.refs.push(entry); copyAdded++; }
    });
  }
  if (copyAdded || copyUpdated) writeWhole(join(gymDir, COPY_REFS), JSON.stringify(refs, null, 2) + "\n");
  return { export_id: exportId, file: basename(csv), currency: currency || h.currency, campaigns: campaigns.size, adsets: adsets.size, ads: ads.length, leads: ads.reduce((t, a) => t + a.all_time.leads, 0), spend: round2(ads.reduce((t, a) => t + a.all_time.spend, 0)), creatives: filed.length, unmatched, offers: [...offers.values()].map(({ copy: c, ...o }) => ({ ...o, copies: c ? c.copies.length : 0, headlines: c ? c.headlines.length : 0 })), copy_refs: { added: copyAdded, updated: copyUpdated }, reporting };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, csv: { type: "string" }, creatives: { type: "string" }, copy: { type: "string" }, label: { type: "string" } } });
  if (!v["brand-dir"] || !v.csv) { console.error("Usage: ads-export.mjs --brand-dir brands/{gym} --csv export.csv [--creatives dir] [--copy dir] [--label words]"); process.exit(1); }
  try {
    const d = importExport({ gymDir: resolve(v["brand-dir"]), csv: resolve(v.csv), creatives: v.creatives ? resolve(v.creatives) : null, copy: v.copy ? resolve(v.copy) : null, label: v.label || null });
    console.log(`imported ${d.file}: ${d.campaigns} campaign(s), ${d.adsets} ad set(s), ${d.ads} ads · ${d.spend} ${d.currency} spent, ${d.leads} leads · reporting ${d.reporting.from || "?"} → ${d.reporting.to || "?"}`);
    console.log(`creatives filed: ${d.creatives}${d.unmatched.length ? ` · no file matched: ${d.unmatched.join("; ")}` : ""}`);
    for (const o of d.offers) console.log(`  ${o.offer}: ${o.ads} ads, ${o.leads} leads at ${o.leads ? round2(o.spend / o.leads) : "—"} · ${o.copies} copies, ${o.headlines} headlines`);
    console.log(`copy references: ${d.copy_refs.added} added, ${d.copy_refs.updated} updated`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
