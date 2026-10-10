#!/usr/bin/env node
/**
 * server.mjs — Local control panel for the gym ad pipeline.
 *
 * The pipeline is a set of Node scripts driven from the command line. That is the wrong
 * surface for filling in a gym's brand colours, offer details and targeting, so this puts a
 * form-based UI in front of the same scripts. It is deliberately local-only and zero-dependency.
 *
 * Everything it knows about validation comes from the pipeline's own modules (client-config.mjs for
 * profiles and offers, plan-offer-batch.mjs for batch briefs, render-composites.mjs for the words on
 * an ad) — the UI does not re-implement any rule, so the form and the CLI can never disagree.
 *
 * Safety (Step 7, 2026-09-11 — before it, any web page open while the panel ran could read .env and
 * start runs):
 *   - every request must be addressed to this panel (Host localhost/127.0.0.1 on its own port), which
 *     stops DNS rebinding from reading anything;
 *   - every request that writes or runs must carry the per-launch token the panel puts in its own
 *     page (other sites cannot read it) and, if the browser sends an Origin, the panel's own;
 *   - /files/ serves generated outputs and brand images only — never .env, source, profiles or briefs.
 *
 * Usage:  node ui/server.mjs [--port 4310]
 *   PANEL_BRANDS_DIR overrides the clients folder (tests).
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync, rmSync, renameSync, mkdtempSync } from "fs";
import { join, resolve, dirname, extname, basename, sep } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { spawn, execFileSync } from "child_process";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import {
  scaffold, validateProfile, profileCompleteness, PROFILE_SCHEMA, CREATIVE_DEFAULTS, PALETTE_MODES,
  catalogueFor, brandPalettes, META_ID, CTA_ENUM, OFFER_TYPES, PRICE_QUALIFIERS, pinUsable, withPoint, countryRules, postalOk, profileCountry, COUNTRIES, pinFor, titleCase } from "../skills/references/client-config.mjs";
import { imageSize, ownerKept, OWNER_KEPT } from "../skills/references/check-visual.mjs";
import { metaConfig, graphClient, checkLink, META_API_VERSION, META_PERMISSIONS, META_ENV_KEYS, scrubTokens } from "../skills/references/meta-api.mjs";
import { readWordings, addWording, editWording, deleteWording, recordUse, wordingProblems } from "../skills/references/ad-wordings.mjs";
import { buildPlan, keptAds, CTA_TYPES, findIdentity, setIdentity, regulatedFor, hasIdentity, findPin } from "../skills/references/meta-publish.mjs";
import { readForms, templateFrom, proposeForm, formProblems, createForm, readLeadForms, writeLeadForms } from "../skills/references/lead-forms.mjs";
import { runImport, importProposal, applyImport, readImport, STEPS as IMPORT_STEPS, HISTORY_TOP } from "../skills/references/import-gym.mjs";
import { TARGETING_LIBRARY_DIR, readLibrary as readTargetingLibrary, seedDrafts as seedTargetingDrafts, liveEntries as liveTargeting, approveEntry as approveTargeting, retireEntry as retireTargeting, restoreEntry as restoreTargeting, addEntry as addTargeting, asPreset as libraryPreset } from "../skills/references/targeting-library.mjs";
/** The shared targeting library, the curated drafts seeded the first time it is read. */
const targetingLibrary = () => seedTargetingDrafts(TARGETING_LIBRARY_DIR).data;
const targetingLibraryView = () => { const d = targetingLibrary(); return { entries: d.entries.map((e) => ({ ...e, preset_id: `lib:${e.id}`, summary: summarise(e.spec) })), approved: d.entries.filter((e) => e.approved_on && !e.retired).length, drafts: d.entries.filter((e) => !e.approved_on && !e.retired).length }; };
import { keptImagesZip } from "../skills/references/ad-images-zip.mjs";
import { pullResults, batchRows, gymRows, resultsCsv, writeGymCsv, pullAccountHistory, readHistory, historyRows, allRows, adsetRows, campaignRows, importFromAccount, readCopyRefs } from "../skills/references/meta-results.mjs";
import { relayoutCopies, flatCopies, draftCopy, readCopy, keptCopies, keepRecommended, addCopy, decideCopy, liveRefs, addCopyRef, editCopyRef, referencesFor, MAX_OPTIONS, ANGLES, KINDS as COPY_KINDS, analyseCopy, ctaLabel, gymLanguage, languageOf as copyLanguageOf } from "../skills/references/draft-copy.mjs";
import { liveEntries, sendToLibrary, LIBRARY_DIR as COPY_LIBRARY, readLibrary as readCopyLibrary, addEntry, editEntry, retireEntry, restoreEntry, usesIn, PLACEHOLDERS as LIBRARY_PLACEHOLDERS } from "../skills/references/copy-library.mjs";
import { readPresets, livePresets, importPresets, renamePreset, retirePreset, restorePreset, addPreset, rankPresets, specProblems, summarise, normaliseSpec } from "../skills/references/meta-targeting.mjs";
import { validateBrief, sceneAudience, spreadFor, SPREAD_WISH, MAX_LOCATIONS, MAX_CALLS_CAP } from "../skills/references/plan-offer-batch.mjs";
import { libraryStatus, readLibrary, loadScenes, approveScenes, rejectScene, copyScenesFrom, isDraft, isRetired, AUDIENCES } from "../skills/references/scene-library.mjs";
import { IMAGE_EXT as REFERENCE_EXT, MAX_WORDS, REFERENCES_DIR } from "../skills/references/refresh-scenes.mjs";
import { launchBrowser, renderComposite, validateInputs } from "../skills/references/render-composites.mjs";
import { readReading, checkUrl as checkSiteUrl, MIN_PHOTO_PX, ONBOARDING_DIR } from "../skills/references/read-website.mjs";
import { readInstagramReading, cleanHandle, INSTAGRAM_DIR, DEFAULT_POSTS, MAX_POSTS } from "../skills/references/read-instagram.mjs";
import { readMetaFacts, writeMetaReading, readMetaReading, acceptMetaFacts } from "../skills/references/read-meta.mjs";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "..");
const BRANDS = resolve(process.env.PANEL_BRANDS_DIR || join(REPO_ROOT, "brands"));
const SWIPE = join(REPO_ROOT, "swipe");
const BATCH_SCRIPT = join(REPO_ROOT, "skills", "references", "plan-offer-batch.mjs");
const IMPORT_SCRIPT = join(REPO_ROOT, "skills", "references", "import-gym.mjs");
const STORIES_SCRIPT = join(REPO_ROOT, "skills", "references", "make-stories.mjs");
const REFRESH_SCRIPT = join(REPO_ROOT, "skills", "references", "refresh-scenes.mjs");
const CLEAN_SCRIPT = join(REPO_ROOT, "skills", "references", "clean-photo.mjs");
const READ_SCRIPT = join(REPO_ROOT, "skills", "references", "read-website.mjs");
const IG_SCRIPT = join(REPO_ROOT, "skills", "references", "read-instagram.mjs");
// The tests serve a fake gym site from this machine; a real panel reads public websites only.
const ALLOW_LOCAL_SITES = process.env.READ_WEBSITE_ALLOW_LOCAL === "1";
const PUBLISH_SCRIPT = join(REPO_ROOT, "skills", "references", "meta-publish.mjs");
/** A reference image's file name: a slug and an image extension — it becomes a path segment. */
const REFERENCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpe?g|webp)$/;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_REFRESH_COUNT = 12;
// The gym's own assets (brand-assets/): what kind of thing each upload is, and the folder it goes to.
// The folders are the ones the pipeline already reads (facility → clean-photo, logo → the profile).
const ASSET_KINDS = [
  { id: "logo", label: "Logo", folder: "logo" }, { id: "facility", label: "Premises", folder: "facility" }, { id: "coaches", label: "Coaches", folder: "coaches" },
  { id: "members", label: "Members", folder: "members" }, { id: "brand", label: "Brand (screenshots, guidelines)", folder: "brand" }, { id: "other", label: "Other", folder: "other" },
];
const assetKind = (id) => ASSET_KINDS.find((k) => k.id === id) || null;
const ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpe?g|webp|svg|heic)$/;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_CLEAN_PHOTOS = 9;

const { values: argv } = parseArgs({ options: { port: { type: "string", default: "4310" } } });
let PORT = parseInt(argv.port, 10);

// ── Safety ───────────────────────────────────────────────────────────────────
// Slugs become path segments, so they are constrained rather than sanitised.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const okSlug = (s) => typeof s === "string" && SLUG.test(s);
const ONEMAP_URL = process.env.ONEMAP_URL || "https://www.onemap.gov.sg";
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
/** A new random token every launch. The panel's page carries it; nothing else can read it. */
const TOKEN = randomBytes(24).toString("hex");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const hostOk = (req) => [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(String(req.headers.host || "").toLowerCase());
const originOk = (req) => !req.headers.origin || [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(req.headers.origin);
function tokenOk(req) {
  const got = Buffer.from(String(req.headers["x-panel-token"] || ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Commands the UI is allowed to run. Nothing is ever passed through a shell, and the
 *  argument shapes are fixed here rather than accepted from the browser. */
const brandDir = (gym) => join(BRANDS, gym);
const briefPath = (gym, batch) => join(BRANDS, gym, "batches", batch, "brief.json");
const RUNNABLE = {
  checksync: { label: "Check skill/command sync", argv: () => ["skills/references/check-sync.mjs"] },
  // Offer-first batches (Step 6). Built from the gym and batch id only; the brief is the file on disk.
  "batch-plan": { label: "Plan batch (free)", needsBrief: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), "--dry-run"] },
  // A directed batch's drafted scenes are approved by the Run confirmation (approveScenes is set by the
  // server once the confirmed ids match the drafts on disk — never taken from the browser).
  batch: { label: "Run batch", needsBrief: true, spends: true, argv: ({ gym, batch, approveScenes }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), ...(approveScenes === true ? ["--approve-scenes"] : [])] },
  "batch-rerender": { label: "Re-render batch with its words (free)", needsBrief: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), "--render-only"] },
  // Stories/Reels (9:16) versions of the selected ads (Step 8): the batch id and the confirmed call cap only.
  "batch-stories": { label: "Make Stories versions", needsBrief: true, spends: "stories", argv: ({ gym, batch, confirm, only }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--max-calls", String(confirm.max_calls), ...(only ? ["--only", only, "--fresh"] : [])] },
  // Publishing (E3): the plan on disk is created on Meta, every object paused. The confirmation names what
  // the plan holds now (ad sets, ads, the day's budget) so what is created is what was read; `first` limits a run.
  "batch-publish": { label: "Create on Facebook (paused)", needsBrief: true, spends: "publish", argv: ({ gym, batch, confirm }) => [PUBLISH_SCRIPT, "--gym", gym, "--brand-dir", brandDir(gym), "--batch", batch, "--create", ...(confirm.first ? ["--first", String(confirm.first)] : [])] },
  "batch-stories-rerender": { label: "Re-render Stories versions (free)", needsBrief: true, argv: ({ gym, batch }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--render-only"] },
  // A scene refresh (text calls only): the audience, the count and the direction — words and/or an
  // uploaded reference image — each checked for shape before it becomes an argument.
  "scenes-refresh": { label: "Refresh scenes (drafts for approval)", argv: ({ gym, audience, count, words, reference }) => [REFRESH_SCRIPT, "--brand-dir", brandDir(gym), "--audience", audience, "--count", String(count), ...(words ? ["--words", words] : []), ...(reference ? ["--reference", reference] : [])] },
  // The premises photos' clean-up (Step 5): a free survey of what an edit would remove, and the edit
  // itself under a confirmed call cap. Photos are names in brand-assets/facility, checked before they
  // become arguments; the clean copies land in brand-assets/facility-clean as the CLI's do.
  // Photos are "kind/name" under brand-assets (facility, coaches or members; a bare name is a premises photo). Coach and
  // member photos are cleaned into reference-clean/ — a room reference only, never an ad — so one run takes one kind of folder.
  "photo-survey": { label: "Survey photos (free)", argv: ({ gym, photos }) => [CLEAN_SCRIPT, "--brand-dir", brandDir(gym), "--survey-only", ...photos.flatMap((p) => ["--photo", join(brandDir(gym), "brand-assets", p.includes("/") ? p : `facility/${p}`)])] },
  // Onboarding, part one: read the gym's website into a proposal (model calls for the sort and the colours;
  // no image generation). The address is checked for shape before it becomes an argument.
  "website-read": { label: "Read the website", argv: ({ gym, url }) => [READ_SCRIPT, "--brand-dir", brandDir(gym), "--url", url] },
  "profile-import": { label: "Import from Meta", argv: ({ gym, skip }) => [IMPORT_SCRIPT, "--brand-dir", brandDir(gym), ...(skip?.length ? ["--skip", skip.join(",")] : [])] },
  // Onboarding, part two: a gym's Instagram photos through Meta's Business Discovery (read-only; model calls
  // for the sort). The handle is checked for shape before it becomes an argument.
  "instagram-read": { label: "Read Instagram", argv: ({ gym, handle, posts }) => [IG_SCRIPT, "--brand-dir", brandDir(gym), "--handle", handle, "--posts", String(posts)] },
  "photo-clean": { label: "Clean photos", spends: "clean", argv: ({ gym, photos, confirm }) => [CLEAN_SCRIPT, "--brand-dir", brandDir(gym), "--max-calls", String(confirm.max_calls), "--attempts", "2", ...(photos.some((p) => p.includes("/") && !p.startsWith("facility/")) ? ["--clean-dir", join(brandDir(gym), "brand-assets", "reference-clean")] : []), ...photos.flatMap((p) => ["--photo", join(brandDir(gym), "brand-assets", p.includes("/") ? p : `facility/${p}`)])] },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
};
const readJsonFile = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null);

const readBody = (req) =>
  new Promise((res, rej) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 2e6) { rej(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
/** The raw bytes of an upload, refused past `max` — the rest is drained, not reset, so the refusal is read. */
const readRaw = (req, max) =>
  new Promise((res, rej) => {
    const tooBig = () => Object.assign(new Error(`the file is over ${Math.round(max / 1048576)} MB`), { status: 413 });
    if (Number(req.headers["content-length"]) > max) { req.resume(); return rej(tooBig()); }
    const chunks = []; let size = 0, failed = false;
    req.on("data", (c) => { if (failed) return; size += c.length; if (size > max) { failed = true; chunks.length = 0; rej(tooBig()); } else chunks.push(c); });
    req.on("end", () => { if (!failed) res(Buffer.concat(chunks)); });
    req.on("error", rej);
  });
/** What an image file starts with — the extension alone is not trusted. */
function imageKind(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}
const isHeic = (buf) => buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(buf.subarray(8, 12).toString("ascii"));
const isSvg = (buf) => /^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 2048).toString("utf8"));
let sipsOk = null;
/** Whether this Mac can turn an iPhone's HEIC into a JPEG (sips ships with macOS). */
function hasSips() { if (sipsOk === null) { try { execFileSync("sips", ["--help"], { stdio: "ignore" }); sipsOk = true; } catch { sipsOk = false; } } return sipsOk; }
function heicToJpeg(buf) {
  const d = mkdtempSync(join(tmpdir(), "heic-"));
  try {
    writeFileSync(join(d, "in.heic"), buf);
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "92", join(d, "in.heic"), "--out", join(d, "out.jpg")], { stdio: "ignore" });
    return readFileSync(join(d, "out.jpg"));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── Brand assets (the gym's own files, uploaded from the panel) ──────────────
// brand-assets/{kind folder}/{name}, with a manifest.json beside them recording where each came
// from (an upload, later a web address), when, and its content hash — so a file is never uploaded
// twice under two names, and a file that arrived by hand still lists (source "folder").
const assetsDir = (gym) => join(brandDir(gym), "brand-assets");
const manifestPath = (gym) => join(assetsDir(gym), "manifest.json");
const readManifest = (gym) => { const m = readJsonFile(manifestPath(gym)); return { assets: Array.isArray(m?.assets) ? m.assets : [] }; };
const writeManifest = (gym, m) => { mkdirSync(assetsDir(gym), { recursive: true }); writeWhole(manifestPath(gym), JSON.stringify({ ...m, updated: new Date().toISOString() }, null, 2) + "\n"); };
const ASSET_FILE = /\.(png|jpe?g|webp)$/i, LOGO_FILE = /\.(png|jpe?g|webp|svg)$/i;
const sizeOf = (buf) => { try { const s = imageSize(buf); return Array.isArray(s) && s.every(Number.isFinite) ? s : null; } catch { return null; } };
const stem = (f) => f.replace(/\.[^.]+$/, "");

/** Every asset the gym has, by kind, with its manifest row where there is one. */
function listAssets(gym) {
  const base = assetsDir(gym), rows = readManifest(gym).assets;
  const cleanStems = new Set(cleanPhotos(gym).map((p) => stem(basename(p.path))));
  const logo = readJsonFile(join(brandDir(gym), "gym-profile.json"))?.brand_lock?.logo?.files?.primary || null;
  const out = [];
  for (const k of ASSET_KINDS) {
    const dir = join(base, k.folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => (k.id === "logo" ? LOGO_FILE : ASSET_FILE).test(f) && !f.startsWith(".")).sort()) {
      const path = `${k.folder}/${f}`, row = rows.find((r) => r.path === path && !r.removed) || {};
      const st = statSync(join(dir, f));
      out.push({ path, name: f, kind: k.id, url: `/files/brands/${gym}/brand-assets/${path}`, bytes: st.size, size: row.size || null, source: row.source || "folder", original_name: row.original_name || null, added: row.added || st.mtime.toISOString().slice(0, 10),
        ...(PHOTO_KIND_IDS.has(k.id) ? { cleaned: cleanStems.has(stem(f)) } : {}), ...(k.id === "logo" ? { in_use: logo === path || logo === f } : {}) });
    }
  }
  return out;
}

const fail = (status, message) => Object.assign(new Error(message), { status });
/** Keep an uploaded file as one of the gym's assets: an image by its first bytes (an iPhone's HEIC
 *  is converted here; an SVG only as a logo, and only a plain one), named as asked, never twice. */
// Photos of the gym (premises, coaches, members) are refused under MIN_PHOTO_PX on the long side unless the
// owner keeps one anyway: a soft photo makes a soft ad, and the room reference passes its softness on.
const PHOTO_KIND_IDS = new Set(["facility", "coaches", "members"]);
function saveAsset(gym, kindId, name, buf, originalName = null, { source = "upload", sourceUrl = null, keepLowRes = false } = {}) {
  const kind = assetKind(kindId);
  if (!kind) throw fail(400, `the kind must be one of ${ASSET_KINDS.map((k) => k.id).join(", ")}`);
  if (!ASSET_NAME.test(name)) throw fail(400, "the file name must be lower-case letters, digits and hyphens, ending in .png, .jpg, .webp, .heic or (for a logo) .svg");
  let found = imageKind(buf) || (isHeic(buf) ? "heic" : null) || (isSvg(buf) ? "svg" : null);
  if (!found) throw fail(400, "not an image file (png, jpg, webp or heic; svg for a logo)");
  if (found === "svg" && kind.id !== "logo") throw fail(400, "an SVG can only be a logo; photos are png, jpg, webp or heic");
  if (found === "svg" && /<script|\bon[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i.test(buf.toString("utf8"))) throw fail(400, "this SVG carries scripts or embedded content; export a plain one");
  const ext = extname(name).toLowerCase();
  if (!(found === "jpg" ? [".jpg", ".jpeg"] : [`.${found}`]).includes(ext)) throw fail(400, `this is a ${found} file; name it .${found}`);
  if (found === "heic") {
    if (!hasSips()) throw fail(400, "HEIC photos are converted with sips, which this machine does not have — export the photo as JPEG first");
    buf = heicToJpeg(buf); name = name.replace(/\.heic$/i, ".jpg"); found = "jpg";
  }
  const size = found === "svg" ? null : sizeOf(buf);
  const lowRes = PHOTO_KIND_IDS.has(kind.id) && size && Math.max(...size) < MIN_PHOTO_PX;
  if (lowRes && !keepLowRes) throw Object.assign(fail(422, `this photo is ${size[0]}×${size[1]}: under ${MIN_PHOTO_PX} px on its long side it looks soft on a 1080 px ad. Keep it only if there is no larger copy`), { low_res: true, size });
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const manifest = readManifest(gym);
  const dup = manifest.assets.find((a) => a.sha256 === sha256 && !a.removed && existsSync(join(assetsDir(gym), a.path)));
  if (dup) throw fail(409, `this file is already here as ${dup.path}`);
  const dir = join(assetsDir(gym), kind.folder);
  mkdirSync(dir, { recursive: true });
  let final = name, n = 2;
  while (existsSync(join(dir, final))) final = `${stem(name)}-${n++}${extname(name)}`;
  writeFileSync(join(dir, final), buf);
  const row = { path: `${kind.folder}/${final}`, kind: kind.id, original_name: originalName || name, sha256, bytes: buf.length, size, source, ...(sourceUrl ? { source_url: sourceUrl } : {}), ...(lowRes ? { low_res_kept: true } : {}), added: new Date().toISOString().slice(0, 10) };
  manifest.assets = manifest.assets.filter((a) => a.path !== row.path).concat(row);
  writeManifest(gym, manifest);
  // The first logo uploaded becomes the profile's logo file, unless one is already named.
  if (kind.id === "logo") {
    const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf);
    if (profile && !profile.brand_lock?.logo?.files?.primary) {
      const lock = (profile.brand_lock ||= {}); const logo = (lock.logo ||= {}); (logo.files ||= {}).primary = row.path;
      writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
      row.logo_set = true;
    }
  }
  return row;
}

/** An asset the owner no longer wants: moved to brand-assets/_trash (never deleted), noted in the manifest. */
function removeAsset(gym, kindId, name) {
  const kind = assetKind(kindId);
  if (!kind || !ASSET_NAME.test(name)) throw fail(404, "no such asset");
  const path = `${kind.folder}/${name}`, abs = join(assetsDir(gym), path);
  if (!existsSync(abs)) throw fail(404, "no such asset");
  const profile = readJsonFile(join(brandDir(gym), "gym-profile.json"));
  const logo = profile?.brand_lock?.logo?.files?.primary;
  if (kind.id === "logo" && (logo === path || logo === name)) throw fail(409, "this is the profile's logo file — choose another logo first (Brand & photography)");
  const trash = join(assetsDir(gym), "_trash");
  mkdirSync(trash, { recursive: true });
  const to = join(trash, `${new Date().toISOString().slice(0, 10)}-${kind.folder}-${name}`);
  renameSync(abs, existsSync(to) ? to.replace(/(\.[^.]+)$/, `-${Date.now().toString(36)}$1`) : to);
  const manifest = readManifest(gym);
  const row = manifest.assets.find((a) => a.path === path && !a.removed);
  if (row) { row.removed = new Date().toISOString().slice(0, 10); row.trashed = `_trash/${basename(to)}`; }
  else manifest.assets.push({ path, kind: kind.id, source: "folder", removed: new Date().toISOString().slice(0, 10), trashed: `_trash/${basename(to)}` });
  writeManifest(gym, manifest);
  return { ok: true, trashed: `_trash/${basename(to)}` };
}

// ── The website's reading (onboarding, part one) ─────────────────────────────
// read-website.mjs writes brands/{gym}/onboarding/website/reading.json; the owner ticks what to keep and
// acceptWebsite files it: photos and the logo into brand-assets through saveAsset (source "website", with
// the address it came from), the colours, fonts, address and Instagram into the profile — never over a
// locked colour, and only after the profile with them passes validateProfile.
const FILE_AS = ["facility", "coaches", "members", "brand", "other"];
const KIND_TO_FOLDER = { premises: "facility", coaches: "coaches", members: "members", graphic: "brand", screenshot: "brand", logo: "logo", other: "other" };
const HEX6 = /^#[0-9A-F]{6}$/i;
function websiteView(gym) {
  const r = readReading(brandDir(gym)), profile = readJsonFile(join(brandDir(gym), "gym-profile.json")) || {};
  const have = new Map(readManifest(gym).assets.filter((a) => a.sha256 && !a.removed && existsSync(join(assetsDir(gym), a.path))).map((a) => [a.sha256, a.path]));
  const base = `/files/brands/${gym}/${ONBOARDING_DIR}`;
  const lock = profile.brand_lock || {};
  return {
    min_photo_px: MIN_PHOTO_PX, file_as: FILE_AS, kind_to_folder: KIND_TO_FOLDER,
    profile: { website: profile.website || "", colors: lock.colors || {}, typography: lock.typography || {}, locations: profile.locations || [], social: profile.social || {}, logo: lock.logo?.files?.primary || "" },
    reading: r && {
      ...r,
      screenshot_url: `${base}/${r.screenshot}`,
      photos: (r.photos || []).map((p) => ({ ...p, image_url: `${base}/${p.file}`, thumb_url: `${base}/${p.thumb || p.file}`, have: have.get(p.sha256) || null, file_as: KIND_TO_FOLDER[p.kind] || "other" })),
      logos: (r.logos || []).map((l) => ({ ...l, image_url: `${base}/${l.file}`, have: (l.sha256 && have.get(l.sha256)) || null })),
    },
  };
}
/** A filing name for a file from the website: web-{its name}, a slug the asset rules accept. */
const webName = (file, ext, fallback = "image") => `web-${basename(file).replace(/^(p\d+|logo-\d+)-?/, "").replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || fallback}.${ext}`;
function acceptWebsite(gym, body) {
  const r = readReading(brandDir(gym));
  if (!r) throw fail(409, "read the website first");
  const dir = join(brandDir(gym), ONBOARDING_DIR), pf = join(brandDir(gym), "gym-profile.json");
  const changes = [];
  // The profile's part first, on a copy: nothing is filed when the profile it leads to would be refused.
  const edit = (profile, say) => {
    const lock = (profile.brand_lock ||= {}), colors = (lock.colors ||= {});
    for (const role of ["primary", "secondary", "accent"]) {
      const hex = body.colours?.[role];
      if (hex == null || hex === "") continue;
      if (!HEX6.test(hex) || !(r.colours?.candidates || []).some((c) => c.hex === hex.toUpperCase())) throw fail(400, `${role}: ${hex} is not one of the colours the website showed`);
      const had = colors[role];
      if (had?.hex && had.locked) { say(`${role} colour kept: ${had.hex} is locked in the profile`); continue; }
      colors[role] = { ...(had || {}), hex: hex.toUpperCase(), name: had?.name || "", locked: false, source: "website" };
      say(`${role} colour ${hex.toUpperCase()}`);
    }
    const typo = (lock.typography ||= {});
    for (const role of ["headline", "body"]) {
      if (!body.fonts?.[role]) continue;
      const fam = r.fonts?.[role];
      if (!fam) continue;
      if (typo[role]?.family) { say(`${role} font kept: ${typo[role].family}`); continue; }
      typo[role] = { ...(typo[role] || {}), family: fam };
      say(`${role} font ${fam}`);
    }
    if (body.address) {
      const a = (r.identity?.addresses || []).find((x) => x.postal_code === String(body.address));
      if (!a) throw fail(400, "that address is not one the website showed");
      const locs = (profile.locations ||= []);
      if (locs.some((l) => String(l.postal_code) === a.postal_code)) say(`address ${a.postal_code} is already a location`);
      else {
        const row = { label: "", address: a.address, postal_code: a.postal_code, ...(Number.isFinite(a.lat) ? { lat: a.lat, lng: a.lng } : {}), nearest_mrt: "", catchment: "", opening_hours: "" };
        const empty = locs.findIndex((l) => !l.address && !l.postal_code);
        if (empty >= 0) locs[empty] = { ...locs[empty], ...row, label: locs[empty].label || "" }; else locs.push(row);
        say(`location added: ${a.address}`);
      }
    }
    const social = { ...(profile.social || {}) };
    if (body.instagram) { const h = String(body.instagram).replace(/^@/, "").toLowerCase(); if (!(r.identity?.instagram || []).some((x) => x.value === h)) throw fail(400, "that Instagram account is not one the website linked"); social.instagram = h; say(`Instagram @${h}`); }
    if (body.facebook) { if (!(r.identity?.facebook || []).some((x) => x.value === body.facebook)) throw fail(400, "that Facebook Page is not one the website linked"); social.facebook = body.facebook; say(`Facebook ${body.facebook}`); }
    if (Object.keys(social).length) profile.social = social;
    if (!profile.website) { profile.website = r.url; say(`website ${r.url}`); }
    return profile;
  };
  const trial = edit(JSON.parse(JSON.stringify(readJsonFile(pf) || {})), () => {});
  const { errors } = validateProfile(trial, { gymDir: brandDir(gym) });
  if (errors.length) throw Object.assign(fail(400, errors[0]), { errors });

  const added = [], skipped = [];
  const file = (id, rel, kind, url, keepLowRes) => {
    const abs = join(dir, rel);
    if (!rel || rel.includes("..") || !existsSync(abs)) { skipped.push({ id, reason: "the file from the reading is gone; read the website again" }); return null; }
    try { const row = saveAsset(gym, kind, webName(rel, extname(rel).slice(1).toLowerCase(), kind === "logo" ? "logo" : "photo"), readFileSync(abs), url ? basename(new URL(url).pathname) : basename(rel), { source: "website", sourceUrl: url || r.url, keepLowRes }); added.push({ id, path: row.path, kind, ...(row.logo_set ? { logo_set: true } : {}) }); return row; }
    catch (e) { skipped.push({ id, reason: e.message, ...(e.low_res ? { low_res: true } : {}) }); return null; }
  };
  for (const pick of Array.isArray(body.photos) ? body.photos : []) {
    const ph = (r.photos || []).find((x) => x.id === pick?.id);
    if (!ph) { skipped.push({ id: pick?.id, reason: "not a photo from the reading" }); continue; }
    if (!FILE_AS.includes(pick.kind)) { skipped.push({ id: ph.id, reason: `file it as one of ${FILE_AS.join(", ")}` }); continue; }
    file(ph.id, ph.file, pick.kind, ph.url, pick.keep_low_res === true);
  }
  if (body.logo) {
    const l = (r.logos || []).find((x) => x.id === body.logo);
    if (!l) skipped.push({ id: body.logo, reason: "not a logo from the reading" });
    else file(l.id, l.file, "logo", l.url, false);
  }
  if (body.screenshot === true) file("home", r.screenshot, "brand", r.url, false);
  const profile = edit(readJsonFile(pf) || {}, (t) => changes.push(t));
  writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
  return { ok: true, added, skipped, changes };
}

// The Instagram reading (read-instagram.mjs): photos only, filed the website's way with the post's address as
// where each came from; the handle read becomes the profile's Instagram when it has none.
function instagramView(gym) {
  const r = readInstagramReading(brandDir(gym)), profile = readJsonFile(join(brandDir(gym), "gym-profile.json")) || {};
  const have = new Map(readManifest(gym).assets.filter((a) => a.sha256 && !a.removed && existsSync(join(assetsDir(gym), a.path))).map((a) => [a.sha256, a.path]));
  const base = `/files/brands/${gym}/${INSTAGRAM_DIR}`;
  return {
    min_photo_px: MIN_PHOTO_PX, file_as: FILE_AS, meta_ready: !!metaConfig({ gym }).token, default_posts: DEFAULT_POSTS, max_posts: MAX_POSTS,
    profile: { instagram: profile.social?.instagram || "", website_instagram: readReading(brandDir(gym))?.identity?.instagram?.[0]?.value || "", website_handles: (readReading(brandDir(gym))?.identity?.instagram || []).map((x) => x.value) },
    reading: r && { ...r, photos: (r.photos || []).map((p) => ({ ...p, image_url: `${base}/${p.file}`, thumb_url: `${base}/${p.thumb || p.file}`, have: have.get(p.sha256) || null, file_as: KIND_TO_FOLDER[p.kind] || "other" })) },
  };
}
function acceptInstagram(gym, body) {
  const r = readInstagramReading(brandDir(gym));
  if (!r) throw fail(409, "read Instagram first");
  const dir = join(brandDir(gym), INSTAGRAM_DIR), added = [], skipped = [], changes = [];
  for (const pick of Array.isArray(body.photos) ? body.photos : []) {
    const ph = (r.photos || []).find((x) => x.id === pick?.id);
    if (!ph) { skipped.push({ id: pick?.id, reason: "not a photo from the reading" }); continue; }
    if (!FILE_AS.includes(pick.kind)) { skipped.push({ id: ph.id, reason: `file it as one of ${FILE_AS.join(", ")}` }); continue; }
    const abs = join(dir, ph.file);
    if (!existsSync(abs)) { skipped.push({ id: ph.id, reason: "the file from the reading is gone; read Instagram again" }); continue; }
    const post = String(ph.post || "").match(/\/(p|reel)\/([A-Za-z0-9_-]+)/)?.[2];
    const name = `ig-${r.handle.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24)}-${(post || ph.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20)}${ph.of > 1 ? `-${ph.in_post}` : ""}${extname(ph.file).toLowerCase()}`;
    try { const row = saveAsset(gym, pick.kind, name, readFileSync(abs), basename(ph.file), { source: "instagram", sourceUrl: ph.post || `https://www.instagram.com/${r.handle}/`, keepLowRes: pick.keep_low_res === true }); added.push({ id: ph.id, path: row.path, kind: pick.kind }); }
    catch (e) { skipped.push({ id: ph.id, reason: e.message, ...(e.low_res ? { low_res: true } : {}) }); }
  }
  const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
  if (added.length && !profile.social?.instagram) { profile.social = { ...(profile.social || {}), instagram: r.handle }; writeWhole(pf, JSON.stringify(profile, null, 2) + "\n"); changes.push(`Instagram @${r.handle}`); }
  return { ok: true, added, skipped, changes };
}

const referencesDir = (gym) => join(brandDir(gym), REFERENCES_DIR);
function listReferences(gym) {
  const dir = referencesDir(gym);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => REFERENCE_NAME.test(f)).sort().map((name) => ({ name, url: `/files/brands/${gym}/${REFERENCES_DIR}/${name}`, read: existsSync(join(dir, `${name}.description.json`)) }));
}
/** The library's drafts and the scenes drafted for a batch, for the panel. */
const sceneCard = (s) => ({ id: s.id, scene: s.scene, audience: s.audience || "any", pose: s.pose, people: s.people, exercise: s.exercise || null, age: s.age || null, setting: s.setting || null, equipment: s.equipment || null, muscles: s.muscles || null, draft: isDraft(s), source: s.source || null, added: s.added || null, covers: s.covers || null, direction: s.direction || null, prefer_layout: s.prefer_layout || null });
function sceneDrafts(gym) {
  const p = join(brandDir(gym), "scenes.json");
  if (!existsSync(p)) return [];
  return readLibrary(p).scenes.filter(isDraft).map(sceneCard);
}
function batchScenes(gym, batch) {
  const p = join(brandDir(gym), "scenes.json");
  if (!existsSync(p)) return [];
  return readLibrary(p).scenes.filter((s) => s.source === `batch:${batch}` && !isRetired(s)).map(sceneCard);
}

function listClients() {
  if (!existsSync(BRANDS)) return [];
  return readdirSync(BRANDS)
    .filter((n) => !n.startsWith(".") && okSlug(n) && statSync(join(BRANDS, n)).isDirectory())
    .map((gym) => {
      const dir = join(BRANDS, gym);
      const profile = readJsonFile(join(dir, "gym-profile.json"));
      const offersDir = join(dir, "offers");
      const offers = existsSync(offersDir)
        ? readdirSync(offersDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
        : [];
      const outDir = join(dir, "outputs");
      const outputs = existsSync(outDir)
        ? readdirSync(outDir).filter((n) => statSync(join(outDir, n)).isDirectory())
        : [];
      return {
        gym,
        display_name: profile?.display_name || "",
        gym_abbr: profile?.gym_abbr || "",
        has_profile: !!profile,
        to_do: profile ? profileCompleteness(profile, { gymDir: dir, cleanPhotos: cleanPhotos(gym).filter((x) => !x.people).length, roomReference: !!profile?.creative_defaults?.room_reference, scenes: sceneStatus(gym), wordings: readWordings(dir).length }).to_do : null,
        offers,
        outputs,
        asset_counts: countAssets(dir),
      };
    });
}

/** A profile as the panel shows it: the file, how finished it is, and its Create defaults filled in. */
function profileView(gym) {
  const dir = brandDir(gym), profile = readJsonFile(join(dir, "gym-profile.json"));
  const completeness = profileCompleteness(profile, { gymDir: dir, cleanPhotos: cleanPhotos(gym).filter((x) => !x.people).length, roomReference: !!profile?.creative_defaults?.room_reference, scenes: sceneStatus(gym), wordings: readWordings(dir).length });
  return { profile, assets: countAssets(dir), completeness, creative_defaults: { ...CREATIVE_DEFAULTS, ...(profile?.creative_defaults || {}) }, logo: logoUrl(gym, profile), brand_palettes: brandPalettes(profile), palette_modes: PALETTE_MODES };
}
function logoUrl(gym, profile) {
  const f = profile?.brand_lock?.logo?.files?.primary;
  if (!f || f.includes("..")) return null;
  const rel = f.startsWith("brand-assets/") ? f.slice("brand-assets/".length) : f;
  return existsSync(join(brandDir(gym), "brand-assets", rel)) && (IMAGE_EXT.has(extname(rel).toLowerCase()) || extname(rel).toLowerCase() === ".svg") ? `/files/brands/${gym}/brand-assets/${rel}` : null;
}

function countAssets(dir) {
  const out = {};
  for (const sub of ["logo", "facility", "coaches", "members"]) {
    const p = join(dir, "brand-assets", sub);
    out[sub] = existsSync(p) ? readdirSync(p).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length : 0;
  }
  return out;
}

/** Setup status — this is the question that kept coming up: what is actually configured? */
function setupStatus() {
  const env = {};
  const envPath = join(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  const isSet = (k) => !!env[k] && !/^your-/.test(env[k]);
  let firecrawl = false;
  try { execFileSync("command", ["-v", "firecrawl"], { shell: "/bin/sh", stdio: "ignore" }); firecrawl = true; } catch {}
  return {
    checks: [
      { key: "GEMINI_KEY", label: "Gemini API key", ok: isSet("GEMINI_KEY"), blocks: "Image generation (Phase 3)",
        fix: "Add GEMINI_KEY=... to .env — get one at aistudio.google.com" },
      { key: "APIFY_TOKEN", label: "Apify token", ok: isSet("APIFY_TOKEN"), blocks: "Competitor swipe (Phase 0)",
        fix: "Add APIFY_TOKEN=... to .env" },
      { key: "FIRECRAWL", label: "Firecrawl CLI", ok: firecrawl, blocks: "Brand research (Phase 1)",
        fix: "npm install -g firecrawl-cli && firecrawl auth" },
      { key: "FAL_KEY", label: "FAL key (backup generator)", ok: isSet("FAL_KEY"), optional: true, blocks: "Backup image generator only",
        fix: "Optional. Add FAL_KEY=... to .env" },
      { key: "META_ACCESS_TOKEN", label: "Meta link (a system-user token, app id and secret per gym)", ok: listClients().some((c) => { const m = metaConfig({ gym: c.gym }); return !!m.token && !!m.appSecret; }), optional: true, blocks: "Publishing to Meta (the Meta link page)",
        fix: "Add META_ACCESS_TOKEN_{GYM}, META_APP_ID_{GYM} and META_APP_SECRET_{GYM} to .env for each gym — the Meta link page says how to get them" },
    ],
    node: process.version,
  };
}

// ── Offer-first batches (Step 7) ─────────────────────────────────────────────

/** Clean real photos a batch may use: whatever sits in a brand-assets/*-clean folder (clean-photo.mjs). */
function cleanPhotos(gym) {
  const base = join(brandDir(gym), "brand-assets");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => d.endsWith("-clean") && statSync(join(base, d)).isDirectory())
    .flatMap((d) => readdirSync(join(base, d)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).map((f) => `${d}/${f}`))
    // reference-clean/ holds cleaned coach and member photos: a room reference only, never an ad (people photos are references only).
    .map((path) => { const kept = ownerKept(join(base, path)); return { path, url: `/files/brands/${gym}/brand-assets/${path}`, people: path.startsWith(`${REFERENCE_CLEAN}/`), ...(kept ? { kept: kept.kept_on, kept_with: kept.left || [] } : {}) }; });
}

// ── The clean-up's flagged photos, and the owner's word on them ──────────────
// A clean-up run that flags a photo keeps its last candidate in outputs/clean-{date}/. The owner may look at
// it beside the original and keep it anyway: it is copied to facility-clean with a line in owner-kept.json
// (the file's name and its contents' hash), which the batch's checks honour (ownerKept in check-visual.mjs).
const CLEAN_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const cleanDirOf = (gym) => join(brandDir(gym), "brand-assets", "facility-clean");
/** Cleaned coach and member photos land here: the room reference a gym without premises photos can still have (2026-10-07, F45 Xinyi). */
const REFERENCE_CLEAN = "reference-clean";
const CLEAN_KINDS = new Set(["facility", "coaches", "members"]);
function cleanRuns(gym) {
  const out = join(brandDir(gym), "outputs");
  if (!existsSync(out)) return [];
  return readdirSync(out).filter((d) => /^clean-\d{4}-\d\d-\d\d$/.test(d) && existsSync(join(out, d, "report.json"))).sort().reverse()
    .map((d) => ({ run: d, dir: join(out, d), report: readJsonFile(join(out, d, "report.json")) }));
}
/** The photos the latest run that tried them flagged, each with its last candidate — unless a clean copy exists. */
function flaggedCleans(gym) {
  const seen = new Set(), out = [];
  for (const { run, dir, report } of cleanRuns(gym)) for (const r of report?.results || []) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const people = /\/(coaches|members)\//.test(String(r.photo || "")), cleanDir = people ? join(brandDir(gym), "brand-assets", REFERENCE_CLEAN) : cleanDirOf(gym);
    if (r.status !== "flagged" || existsSync(join(cleanDir, `${r.id}.png`))) continue;
    const a = [...(r.attempts || [])].reverse().find((x) => x.file && existsSync(join(dir, basename(x.file))));
    if (!a) continue;
    const base = `/files/brands/${gym}/outputs/${run}`;
    out.push({ people, id: r.id, photo: basename(r.photo || ""), run, attempt: a.attempt, failures: r.failures || [], notes: r.notes || [], after_url: `${base}/${basename(a.file)}`, before_url: existsSync(join(dir, `${r.id}.source.png`)) ? `${base}/${r.id}.source.png` : null });
  }
  return out;
}
function keepFlagged(gym, id) {
  if (!CLEAN_ID.test(String(id || ""))) throw fail(400, "name the flagged photo");
  const f = flaggedCleans(gym).find((x) => x.id === id);
  if (!f) throw fail(404, "no flagged photo of that name is waiting (it may be clean already, or was never edited)");
  const { dir } = cleanRuns(gym).find((r) => r.run === f.run);
  const buf = readFileSync(join(dir, basename(f.after_url)));
  // A cleaned people photo is kept as a room reference only (reference-clean), never where the real-photo ads come from.
  const cleanDir = f.people ? join(brandDir(gym), "brand-assets", REFERENCE_CLEAN) : cleanDirOf(gym);
  mkdirSync(cleanDir, { recursive: true });
  const name = `${id}.png`, recPath = join(cleanDir, OWNER_KEPT), rec = readJsonFile(recPath) || {};
  writeFileSync(join(cleanDir, name), buf);
  rec[name] = { sha256: createHash("sha256").update(buf).digest("hex"), kept_on: new Date().toISOString().slice(0, 10), from: `${f.run}, attempt ${f.attempt}`, left: f.failures };
  writeWhole(recPath, JSON.stringify(rec, null, 2) + "\n");
  return { ok: true, kept: `${basename(cleanDir)}/${name}` };
}
/** A cleaned copy the owner no longer wants: moved to _trash (never deleted), its kept line dropped. */
function discardClean(gym, name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,80}\.(png|jpe?g|webp)$/.test(name) || !existsSync(join(cleanDirOf(gym), name))) throw fail(404, "no such cleaned photo");
  const rel = `facility-clean/${name}`, profile = readJsonFile(join(brandDir(gym), "gym-profile.json"));
  if ((profile?.creative_defaults?.real_photos || []).includes(rel)) throw fail(409, "this is one of the gym's real photos on Ad defaults: untick it there first");
  const trash = join(brandDir(gym), "brand-assets", "_trash");
  mkdirSync(trash, { recursive: true });
  const to = join(trash, `${new Date().toISOString().slice(0, 10)}-facility-clean-${name}`);
  renameSync(join(cleanDirOf(gym), name), existsSync(to) ? to.replace(/(\.[^.]+)$/, `-${Date.now().toString(36)}$1`) : to);
  const recPath = join(cleanDirOf(gym), OWNER_KEPT), rec = readJsonFile(recPath);
  if (rec?.[name]) { delete rec[name]; writeWhole(recPath, JSON.stringify(rec, null, 2) + "\n"); }
  return { ok: true, trashed: `_trash/${basename(to)}` };
}

function sceneStatus(gym) {
  const p = join(brandDir(gym), "scenes.json");
  const lib = readJsonFile(p);
  if (!lib) return { exists: false, approved: false, counts: {} };
  return { exists: true, ...libraryStatus({ ...lib, scenes: lib.scenes || [] }) };
}

function listBatches(gym) {
  const dir = join(brandDir(gym), "batches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => okSlug(id) && existsSync(briefPath(gym, id))).sort().reverse().map((id) => {
    const brief = readJsonFile(briefPath(gym, id));
    const out = join(brandDir(gym), "outputs", id);
    const batch = readJsonFile(join(out, "batch.json"));
    return {
      id, words: { offer: brief.offer, locations: brief.locations, audience: brief.audience ?? null },
      made: batch?.made || null, ads: batch?.ads?.length || 0, image_calls: batch?.image_calls ?? null,
      gallery: existsSync(join(out, "gallery.html")) ? `/files/brands/${gym}/outputs/${id}/gallery.html` : null,
      // For the campaign cards: the first ad as a thumbnail, whether picks and Stories exist.
      thumb: batch?.ads?.[0] ? `/files/brands/${gym}/outputs/${id}/${batch.ads[0].file}` : null,
      selected: existsSync(join(out, "selections.json")),
      stories: (() => { const s = readJsonFile(join(out, "stories.json")); return s ? s.ads.length : 0; })(),
      directed: !!brief.direction,
      published: (() => { const r = readJsonFile(join(out, "publish.json")), x = readJsonFile(join(out, "results.json")); return r?.campaign?.id ? { ads: Object.keys(r.ads || {}).length, done: !!r.done, status: x?.campaign?.words || "paused", leads: x?.campaign?.all_time?.leads ?? null, spend: x?.campaign?.all_time?.spend ?? null, cost_per_lead: x?.campaign?.all_time?.cost_per_lead ?? null, pulled: x?.pulled || null } : null; })(),
      review: batch ? (() => { const c = reviewState(gym, id).counts; return { kept: c.kept, excluded: c.excluded, unreviewed: c.unreviewed }; })() : null,
      running: activeRun(gym, id),
      // A run the owner stopped before the batch was made: said on its card, with what it had spent.
      stopped: !batch && readJsonFile(join(out, "progress.json"))?.stage === "stopped" ? { image_calls: readJsonFile(join(out, "spend.json"))?.image_calls ?? 0 } : null,
      // A run that ended on an error, or that is no longer running without finishing (a crash, a panel restart that
      // took it with it): the card offers Run again, as it does for a stopped one.
      failed: !batch && !activeRun(gym, id) && !orphanBatch(gym, id) && ["failed", "photos", "fit", "looks", "render", "gallery"].includes(readJsonFile(join(out, "progress.json"))?.stage) ? { stage: readJsonFile(join(out, "progress.json")).stage, error: readJsonFile(join(out, "progress.json")).error || null, image_calls: readJsonFile(join(out, "spend.json"))?.image_calls ?? 0 } : null,
    };
  });
}

/** The brief's problems (Step 6 rules, plus the scene library) and what it would make. */
/**
 * The Create screen's Spread switch arrives as `spread: true`; it becomes the brief's `must_show` here, cut to
 * what the gym's approved scenes can show for the batch's audience (`spreadFor`), with what was left out said.
 * A library that cannot load yet gives no spread (the check says why the batch cannot run).
 */
function resolveSpread(gym, brief) {
  if (!brief || typeof brief !== "object" || !("spread" in brief)) return { brief, spread: null };
  const { spread, ...rest } = brief;
  // A directed batch photographs what its reference or words show, from the scenes it drafts for itself;
  // a spread worked out from the whole library would ask those scenes for what they cannot show (2026-09-28).
  if (spread === true && rest.direction && (rest.direction.words || rest.direction.reference)) return { brief: rest, spread: { must_show: {}, left_out: [], reason: "off for a directed batch: the reference or your words decide what the photos show" } };
  if (spread !== true || !(rest.generated > 0) || rest.must_show) return { brief: rest, spread: null };
  let scenes = [];
  try { scenes = loadScenes(join(brandDir(gym), "scenes.json")); } catch { return { brief: rest, spread: { must_show: {}, left_out: [], reason: "no approved scenes yet" } }; }
  // With an age range the ages come from the bell curve (plan-offer-batch → ageTargets), so the spread leaves them out.
  const wish = Array.isArray(rest.age_range) ? Object.fromEntries(Object.entries(SPREAD_WISH).filter(([k]) => k !== "age")) : SPREAD_WISH;
  const s = spreadFor({ scenes, audience: sceneAudience(rest.audience, rest.scene_audience), count: rest.generated, wish });
  return { brief: Object.keys(s.must_show).length ? { ...rest, must_show: s.must_show } : rest, spread: s };
}
function checkBrief(gym, raw) {
  const { brief, spread } = resolveSpread(gym, raw);
  // The room reference: the brief's own, else the gym's (Ad defaults → Room reference: a cleaned premises photo, or a
  // cleaned coach/member photo that is only ever a reference). Without one, a gym without premises photos generated
  // rooms from nothing (F45 Xinyi, 2026-10-07). A real photo in the batch still stands in when the gym names none.
  if (brief && typeof brief === "object" && brief.reference == null) { const rr = (readJsonFile(join(brandDir(gym), "gym-profile.json")) || {}).creative_defaults?.room_reference; if (typeof rr === "string" && rr && !rr.includes("..") && existsSync(join(brandDir(gym), "brand-assets", rr))) brief.reference = rr; }
  const errors = validateBrief(brief, { brandDir: brandDir(gym) });
  const g = brief?.generated ?? 0, real = Array.isArray(brief?.real) ? brief.real : [];
  const scenes = sceneStatus(gym);
  const audienceFor = sceneAudience(brief?.audience, brief?.scene_audience);
  if (g > 0 && !brief?.scenes) {
    if (!scenes.exists) errors.push("no scene library yet: generated photos need approved scenes. Draft the first ones on Library → Scenes, or set generated photos to 0 and use real photos only");
    else if (!scenes.approved) errors.push("no approved scenes yet: approve some on Library → Scenes (nothing is generated from a draft)");
    else if (audienceFor !== "any" && !(scenes.counts[audienceFor] || scenes.counts.any)) errors.push(`the scene library has no scenes for a "${audienceFor}" audience`);
  }
  const photos = g + real.length, looks = brief?.looks_per_photo ?? 2, locs = Array.isArray(brief?.locations) ? brief.locations.length : 0;
  return { errors, brief, spread, summary: { photos, generated: g, real: real.length, looks, locations: locs, ads: photos * looks * locs, max_calls: brief?.max_calls ?? g, scenes_for: audienceFor } };
}

// ── Review and picks (sub-step 2) ────────────────────────────────────────────
// The owner's decisions live in the batch folder as review.json: { ads: {folder: keep|exclude},
// photos: {id: keep|exclude} }. selections.json — the file the Stories step and the copy builder read,
// in the gallery's exact format — is written from it on every change, so there is no Downloads step.
// An ad no one has decided on counts as kept, as the gallery's "all selected" did; an excluded photo
// takes every ad it appears in with it.

const outDirOf = (gym, id) => join(brandDir(gym), "outputs", id);
const fileUrl = (gym, abs) => {
  const base = join(brandDir(gym), "outputs");
  const rel = abs.startsWith(base + sep) ? abs.slice(base.length + 1).split(sep).join("/") : null;
  return rel ? `/files/brands/${gym}/outputs/${rel}` : null;
};

/** The photos a batch has so far: from batch.json once it is made, from progress.json while it is being made. */
function batchPhotos(gym, id) {
  const out = outDirOf(gym, id), batch = readJsonFile(join(out, "batch.json")), brief = readJsonFile(briefPath(gym, id)) || {};
  const plan = readJsonFile(join(out, "visuals.json"))?.visuals || [];
  const sceneOf = (pid) => plan.find((v) => v.id === pid);
  const realUrl = (src) => `/files/brands/${gym}/brand-assets/${src}`;
  if (batch) {
    return batch.photos.map((p) => ({
      id: p.id, kind: p.kind, scene_id: p.scene_id || null, scene: sceneOf(p.id)?.scene || null, primary: p.primary || null, allowed: p.allowed || [], notes: p.notes || [],
      url: p.kind === "real" ? realUrl(p.file) : fileUrl(gym, resolve(out, p.file)),
    }));
  }
  const prog = readJsonFile(join(out, "progress.json"));
  const gen = Object.entries(prog?.photos || {}).filter(([, x]) => x.state === "passed" && x.file)
    .map(([pid, x]) => ({ id: pid, kind: "generated", scene_id: x.scene_id || null, scene: x.scene || null, primary: x.own_layout_failed ? null : x.treatment || null, allowed: [], notes: x.notes || [], url: fileUrl(gym, resolve(out, x.file)) }));
  const real = (brief.real || []).map((src, i) => ({ id: `r${String(i + 1).padStart(2, "0")}`, kind: "real", scene_id: null, scene: null, primary: null, allowed: [], notes: [], url: realUrl(src) }));
  return [...gen, ...real];
}

/** The owner's decisions: review.json, or — for a batch picked in the gallery before — its selections.json. */
function readDecisions(gym, id) {
  const out = outDirOf(gym, id);
  const r = readJsonFile(join(out, "review.json"));
  if (r) return { ads: r.ads || {}, photos: r.photos || {} };
  const sel = readJsonFile(join(out, "selections.json"));
  if (!sel) return { ads: {}, photos: {} };
  const ads = {};
  for (const f of sel.excluded || []) ads[f] = "exclude";
  for (const f of Object.keys(sel)) if (f !== "excluded") ads[f] = "keep";
  return { ads, photos: {} };
}

/** Each ad's standing: its own decision, unless one of its photos is excluded. */
function standing(ad, d) {
  const byPhoto = (ad.photos || []).find((p) => d.photos[p] === "exclude");
  if (byPhoto) return { status: "exclude", by_photo: byPhoto };
  return { status: d.ads[ad.folder] || null, by_photo: null };
}

function reviewState(gym, id) {
  const out = outDirOf(gym, id), batch = readJsonFile(join(out, "batch.json"));
  const stories = readJsonFile(join(out, "stories.json"));
  const notes = readJsonFile(join(out, "gallery-notes.json")) || {};
  const storyOf = new Map((stories?.ads || []).filter((a) => existsSync(join(out, a.file))).map((a) => [a.folder, a]));
  // Why an ad has no Stories version, from the last run: its 9:16 failed to verify, or no 9:16 photo fits its look.
  const storyFail = new Map();
  for (const f of [...(stories?.failed || []), ...(stories?.left_out || [])]) for (const folder of f.folders || []) storyFail.set(folder, (f.failures || [f.reason]).filter(Boolean).join("; "));
  const d = readDecisions(gym, id);
  const ads = (batch?.ads || []).map((a) => {
    const s = storyOf.get(a.folder);
    return {
      folder: a.folder, number: Number(a.folder.split("-")[0]), candidate: a.candidate, location: a.location, treatment: a.treatment, style: a.style, palette: a.palette,
      photos: a.photos, url: fileUrl(gym, join(out, a.file)), story: s ? fileUrl(gym, join(out, s.file)) : null, story_failure: s ? null : storyFail.get(a.folder) || null, notes: notes[a.folder] || null, own: d.ads[a.folder] || null, ...standing(a, d),
    };
  });
  const photos = batchPhotos(gym, id).map((p) => ({ ...p, status: d.photos[p.id] || null, ads: ads.filter((a) => a.photos.includes(p.id)).length }));
  const count = (s) => ads.filter((a) => a.status === s).length;
  return {
    batch_id: id, made: !!batch, locations: [...new Set(ads.map((a) => a.location))], ads, photos,
    counts: { ads: ads.length, kept: count("keep"), excluded: count("exclude"), unreviewed: count(null), photos: photos.length, photos_excluded: photos.filter((p) => p.status === "exclude").length },
    saved: existsSync(join(out, "selections.json")),
    stories: stories ? { ads: stories.ads.length, image_calls: stories.image_calls, max_calls: stories.max_calls, left_out: (stories.failed?.length || 0) + (stories.left_out?.length || 0) } : null,
  };
}

/** The publish settings a screen may save: shapes only; the plan builder applies its own rules on the values. */
function settingsProblem(b) {
  if (!isPlainObject(b)) return "settings must be an object";
  for (const k of Object.keys(b)) if (!["campaign", "adsets", "words", "destination", "copy", "updated"].includes(k)) return `unknown setting "${k}"`;
  if (b.copy != null && (!isPlainObject(b.copy) || (b.copy.max_options != null && !(Number.isInteger(b.copy.max_options) && b.copy.max_options >= 1 && b.copy.max_options <= MAX_OPTIONS)))) return `copy: text options per ad is a whole number, 1 to ${MAX_OPTIONS}`;
  if (b.copy != null && b.copy.max_headlines != null && !(Number.isInteger(b.copy.max_headlines) && b.copy.max_headlines >= 1 && b.copy.max_headlines <= MAX_OPTIONS)) return `copy: headlines per ad is a whole number, 1 to ${MAX_OPTIONS}`;
  const str = (v, max) => v == null || (typeof v === "string" && v.length <= max && !/[\r\n]/.test(v));
  const numOr = (v) => v == null || (typeof v === "number" && Number.isFinite(v));
  const c = b.campaign || {};
  if (!isPlainObject(c) || !str(c.name, 160) || !numOr(c.daily) || !numOr(c.bid_cap) || (c.level != null && !["adset", "campaign"].includes(c.level)) || (c.bid_strategy != null && typeof c.bid_strategy !== "string")) return "campaign settings: a one-line name, a level of adset or campaign, numbers for the budget";
  if (b.adsets != null && !isPlainObject(b.adsets)) return "adsets must map callouts to settings";
  for (const [k, v] of Object.entries(b.adsets || {})) {
    if (!isPlainObject(v) || !numOr(v.pin) || !numOr(v.radius_km) || !numOr(v.age_min) || !numOr(v.age_max) || !numOr(v.daily) || !str(v.gender, 8) || !str(v.preset, 40)) return `ad set ${k}: numbers for pin, radius, ages and budget; a gender and a preset id`;
  }
  const w = b.words || {};
  if (!isPlainObject(w) || (w.message != null && (typeof w.message !== "string" || w.message.length > 2000)) || !str(w.headline, 255) || !str(w.description, 255) || !str(w.cta, 20)) return "words: primary text up to 2000 characters, a one-line headline and description, a call-to-action type";
  if (/[\u2013\u2014]/.test(`${w.message || ""}${w.headline || ""}${w.description || ""}`)) return "words: no em or en dashes (they break the Ads Uploader import); use a plain hyphen";
  const d = b.destination || {};
  if (!isPlainObject(d) || (d.lead_form_id != null && !/^\d{5,20}$/.test(String(d.lead_form_id))) || (d.instagram_user_id != null && d.instagram_user_id !== "" && !/^\d{5,20}$/.test(String(d.instagram_user_id)))) return "destination: the lead form and Instagram account are ids";
  return null;
}
const DECISIONS = new Set(["keep", "exclude", null]);
/** Replace a file whole: another process (the Stories step) reading it never sees half of one. */
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
/** Merge a change into review.json and write selections.json from it. Returns an error message, or null. */
function savePicks(gym, id, change) {
  const out = outDirOf(gym, id), batch = readJsonFile(join(out, "batch.json"));
  const folders = new Set((batch?.ads || []).map((a) => a.folder)), photoIds = new Set(batchPhotos(gym, id).map((p) => p.id));
  const { ads = {}, photos = {} } = change || {};
  if (typeof ads !== "object" || typeof photos !== "object" || Array.isArray(ads) || Array.isArray(photos)) return "ads and photos must map names to keep, exclude or null";
  for (const [f, v] of Object.entries(ads)) { if (!folders.has(f)) return `this batch has no ad ${f}`; if (!DECISIONS.has(v)) return `${f}: a decision is keep, exclude or null`; }
  for (const [p, v] of Object.entries(photos)) { if (!photoIds.has(p)) return `this batch has no photo ${p}`; if (!DECISIONS.has(v)) return `${p}: a decision is keep, exclude or null`; }
  const d = readDecisions(gym, id);
  for (const [f, v] of Object.entries(ads)) { if (v === null) delete d.ads[f]; else d.ads[f] = v; }
  for (const [p, v] of Object.entries(photos)) { if (v === null) delete d.photos[p]; else d.photos[p] = v; }
  // Decisions about ads a re-render has since renamed are dropped: they no longer name anything.
  for (const f of Object.keys(d.ads)) if (batch && !folders.has(f)) delete d.ads[f];
  writeWhole(join(out, "review.json"), JSON.stringify({ ads: d.ads, photos: d.photos, updated: new Date().toISOString() }, null, 2) + "\n");
  if (batch) {
    const stories = new Map((readJsonFile(join(out, "stories.json"))?.ads || []).filter((a) => existsSync(join(out, a.file))).map((a) => [a.folder, a.file]));
    const excluded = batch.ads.filter((a) => standing(a, d).status === "exclude").map((a) => a.folder).sort();
    const sel = { excluded };
    for (const a of batch.ads) if (!excluded.includes(a.folder)) sel[a.folder] = { "1x1": a.file, ...(stories.has(a.folder) ? { "9x16": stories.get(a.folder) } : {}) };
    writeWhole(join(out, "selections.json"), JSON.stringify(sel, null, 2) + "\n");
  }
  return null;
}

const WORD_FIELDS = ["offer", "locations", "audience", "free"];
const sameExceptWords = (a, b) => JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !WORD_FIELDS.includes(k)).sort()))
  === JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => !WORD_FIELDS.includes(k)).sort()));

// Live preview: four sample looks with the typed words, over the client's clean photos, on one warm
// Chrome. Renders are queued one at a time; the page ignores answers to superseded requests.
const PREVIEW_LOOKS = [
  { id: "t1", label: "Bottom stack", treatment: "t1-bottom-stack", style: "s1-heavy-sans", palette: "white-on-dark", photos: [0] },
  { id: "t3", label: "Right column", treatment: "t3-right-column", style: "s6-serif-display", palette: "cyan-white", photos: [1] },
  { id: "t5", label: "Offer band", treatment: "t5-offer-band", style: "s2-heavy-outlined", palette: "blue-white", photos: [0] },
  { id: "t8", label: "Panels + band", treatment: "t8-panels-band", style: "s8-script-accent", palette: "white-on-dark", photos: [0, 1], noAudienceStyle: "s4-wide-tracked" },
];
let browserP = null, queue = Promise.resolve();
const previews = new Map();
async function renderPreview(gym, { offer, location, audience, photos }) {
  browserP ||= launchBrowser();
  const browser = await browserP;
  const files = photos.map((p) => join(brandDir(gym), "brand-assets", p));
  const looks = [];
  // A gym whose ads use its brand colours sees them in the preview: the offer-band look takes the brand palette.
  const profile = readJsonFile(join(brandDir(gym), "gym-profile.json"));
  let catalogue = null;
  try { catalogue = catalogueFor(profile); } catch {}
  const brand = catalogue?.palettes.palettes.brand ? "brand" : null;
  for (const L of PREVIEW_LOOKS) {
    const ims = L.photos.map((i) => files[Math.min(i, files.length - 1)]);
    const style = !audience && L.noAudienceStyle ? L.noAudienceStyle : L.style;
    const palette = brand && L.id === "t5" ? brand : L.palette;
    const r = await renderComposite(browser, { images: ims, location, audience: audience || null, offer, treatment: L.treatment, style, palette, ratio: "1x1", ...(catalogue ? { catalogue } : {}) });
    let url = null;
    if (r.png) {
      const id = randomBytes(9).toString("hex");
      previews.set(id, r.png);
      while (previews.size > 32) previews.delete(previews.keys().next().value);
      url = `/api/preview-img/${id}.png`;
    }
    looks.push({ id: L.id, label: L.label, treatment: L.treatment, style, palette, ok: r.ok, failures: r.failures || [], url, words: r.report?.blocks ? Object.fromEntries(r.report.blocks.map((b) => [b.block, b.text])) : null });
  }
  return looks;
}

// ── Run streaming ────────────────────────────────────────────────────────────
const runs = new Map(); // id -> { lines:[], done:bool, code:null, clients:Set, gym, batch }
/** The run working on a batch right now, if any. */
function activeRun(gym, batch) {
  for (const r of runs.values()) if (!r.done && r.gym === gym && r.batch === batch) return { id: r.id, kind: r.kind, label: r.label };
  return null;
}

// ── Pins and the Singapore identity, filled in for the owner ─────────────────
/** A Singapore postal code's point, from OneMap: { lat, lng, address } or null. */
async function geocodePostal(postal) {
  const r = await fetch(`${ONEMAP_URL}/api/common/elastic/search?${new URLSearchParams({ searchVal: postal, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" })}`, { headers: { accept: "application/json" } });
  const hit = ((await r.json())?.results || []).find((x) => String(x.POSTAL) === String(postal) && Number.isFinite(Number(x.LATITUDE)) && Number.isFinite(Number(x.LONGITUDE)));
  return hit ? { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE), address: String(hit.ADDRESS || "") } : null;
}
/**
 * Every pin saved with a postal code and no place gets its point: the gym's own location at that postal code,
 * else OneMap's. BFIT's pin was saved with its postal code alone (Find was never pressed) and its first publish
 * was refused for "no usable pin" (2026-10-04). Changes `profile`; returns what was placed and what could not be.
 */
async function fillPinPoints(profile, { geocode = geocodePostal } = {}) {
  const placed = [], warnings = [], cr = countryRules(profileCountry(profile));
  for (const [i, pin] of (profile?.targeting_defaults?.geo?.radius_pins || []).entries()) {
    if (!pin || typeof pin !== "object" || pinUsable(pin)) continue;
    const name = pin.label || `pin ${i + 1}`;
    if (!pin.postal_code || !postalOk(profileCountry(profile), pin.postal_code)) { warnings.push(`${name} has no place yet: give it a postal code, or pick a Meta place`); continue; }
    const own = withPoint(profile, pin);
    if (pinUsable(own)) { pin.lat = own.lat; pin.lng = own.lng; placed.push(`${name}: placed at the gym's location for ${pin.postal_code}`); continue; }
    // Only Singapore has a free map here (OneMap); elsewhere the point comes from the gym's location or a Meta place.
    if (cr.geocoder !== "onemap") { warnings.push(`${name}: no map places a ${cr.name || "foreign"} postal code; give the gym's location its point (From the ad account fills it from the Facebook Page), or pick a Meta place`); continue; }
    try {
      const g = await geocode(String(pin.postal_code));
      if (g) { pin.lat = g.lat; pin.lng = g.lng; placed.push(`${name}: placed at ${g.address || pin.postal_code}`); }
      else warnings.push(`${name}: postal code ${pin.postal_code} was not found on the map, so it cannot be targeted yet. Check the code, or press Find`);
    } catch (e) { warnings.push(`${name}: the map could not be reached to place postal code ${pin.postal_code} (${e.message}). Save again, or press Find`); }
  }
  return { placed, warnings };
}
// The identity lookup is one Meta call; an account with none or several is not asked again for a minute.
const identityMemo = new Map();
/** A gym whose targeting presets were never imported (2026-10-07): the Publish screen's Detailed targeting list
 *  showed nothing but Broad for F45 Xinyi while its account had run 31 distinct targetings. Imported once from the
 *  account when the Publish screen opens (a few read-only calls); a failure is not tried again for a minute. */
const importMemo = new Map();
async function presetsAutoImport(gym) {
  const dir = brandDir(gym), profile = readJsonFile(join(dir, "gym-profile.json")) || {};
  if (readPresets(dir).imported || !profile.meta_assets?.ad_account_id) return null;
  const cfg = metaConfig({ gym });
  if (!cfg.token) return null;
  const memo = importMemo.get(gym);
  if (memo && Date.now() - memo.at < 60000) return memo.value;
  let value;
  try { const r = await importPresets({ client: graphClient({ config: cfg }), accountId: profile.meta_assets.ad_account_id, gymDir: dir }); value = { imported: true, added: r.added, adsets: r.adsets }; importMemo.delete(gym); return value; }
  catch (e) { value = { imported: false, reason: `the account's targeting could not be imported: ${scrubTokens(e.message)}` }; }
  importMemo.set(gym, { at: Date.now(), value });
  return value;
}
/** A callout with no pin, filled from the ad account's most-used pin (GET only; the owner's rule, 2026-10-07). */
const pinMemo = new Map();
async function pinFillFor(gym, callouts) {
  const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
  if (!callouts.length || callouts.every((c) => pinUsable(pinFor(profile, c).pin))) return null;
  const reading = readJsonFile(join(brandDir(gym), "onboarding", "meta", "reading.json"));
  const cfg = metaConfig({ gym });
  if (!reading?.pins && !cfg.token) return { filled: [], reason: "the Meta link is not set up yet (Meta link page)" };
  const key = `${gym}|${callouts.join("|")}`, memo = pinMemo.get(key);
  if (memo && Date.now() - memo.at < 60000) return memo.value;
  let value;
  try {
    const r = await findPin(profile, cfg.token ? graphClient({ config: cfg }) : null, { callouts, reading });
    if (r.filled.length) {
      const problems = validateProfile(profile).errors || [];
      if (problems.length) value = { filled: [], reason: `the pin from the account does not fit the profile: ${problems.join("; ")}` };
      else { writeWhole(pf, JSON.stringify(profile, null, 2) + "\n"); pinMemo.delete(key); return { filled: r.filled }; }
    } else value = { filled: [], reason: r.reason || null };
  } catch (e) { value = { filled: [], reason: `the ad account's pins could not be read: ${scrubTokens(e.message)}` }; }
  pinMemo.set(key, { at: Date.now(), value });
  return value;
}
/** The country's verified advertiser identity (Singapore, Taiwan — REGULATED), read from the account's own ad sets when the profile has none (GET only). */
async function singaporeIdentityFor(gym) {
  const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
  const m = profile.meta_assets || {}, reg = regulatedFor(profile);
  if (!reg || hasIdentity(profile, reg)) return null;
  const cfg = metaConfig({ gym });
  if (!cfg.token) return { choices: [], reason: "the Meta link is not set up yet (Meta link page)" };
  const key = `${gym}|${m.ad_account_id || ""}`, memo = identityMemo.get(key);
  if (memo && Date.now() - memo.at < 60000) return memo.value;
  let value;
  try {
    const r = await findIdentity(profile, graphClient({ config: cfg }));
    if (r.set) { writeWhole(pf, JSON.stringify(profile, null, 2) + "\n"); identityMemo.delete(key); return { set: r.set, choices: r.choices, country: reg.name }; }
    value = { choices: r.choices, reason: r.reason, country: reg.name };
  } catch (e) { value = { choices: [], reason: `the ad account's ad sets could not be read: ${scrubTokens(e.message)}` }; }
  identityMemo.set(key, { at: Date.now(), value });
  return value;
}

// ── Stopping a run ───────────────────────────────────────────────────────────
// Every run is started as the leader of its own process group, so Stop ends the run and everything it started
// (its headless Chrome and that browser's helpers) with one signal; a run that ignores it is killed after 4 s.
// Creating on Meta is never stopped part-way: an object made between a call and its record would be made twice.
const UNSTOPPABLE = new Set(["batch-publish"]);
const TERMINAL_STAGES = new Set(["done", "failed", "stopped"]);
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch {}
  try { process.kill(pid, signal); return true; } catch { return false; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A batch's progress file says it was stopped (the run is gone, so nothing else writes it now). */
function markStopped(gym, batch) {
  const path = join(outDirOf(gym, batch), "progress.json"), prog = readJsonFile(path);
  if (!prog || TERMINAL_STAGES.has(prog.stage)) return;
  writeWhole(path, JSON.stringify({ ...prog, stopped_at: prog.stage, stage: "stopped", updated: new Date().toISOString() }, null, 2) + "\n");
}
function stopRun(run) {
  if (!run || run.done) throw fail(409, "that run has already ended");
  if (UNSTOPPABLE.has(run.kind)) throw fail(409, "creating on Facebook is not stopped part-way: it finishes the object it is making, and everything it makes is paused");
  if (run.stopping) return { ok: true, stopping: true };
  run.stopping = true;
  run.push("■ stopping…", "meta");
  const pid = run.child?.pid;
  if (!pid || !killGroup(pid, "SIGTERM")) throw fail(500, "the run's process could not be reached");
  setTimeout(() => { if (!run.done) killGroup(pid, "SIGKILL"); }, 4000).unref();
  return { ok: true, stopping: true };
}
/** A batch run this panel did not start (it was restarted since) but that is still going: its process id from
 *  progress.json, only when that process really is the batch script working on this batch's brief. */
function orphanBatch(gym, batch) {
  const prog = readJsonFile(join(outDirOf(gym, batch), "progress.json"));
  if (!prog || TERMINAL_STAGES.has(prog.stage) || !Number.isInteger(prog.pid) || prog.pid <= 1 || prog.pid === process.pid || !pidAlive(prog.pid)) return null;
  let cmd = "";
  try { cmd = execFileSync("ps", ["-o", "command=", "-p", String(prog.pid)], { encoding: "utf-8" }); } catch { return null; }
  return cmd.includes("plan-offer-batch.mjs") && cmd.includes(briefPath(gym, batch)) ? prog.pid : null;
}
async function stopBatch(gym, batch) {
  const mine = [...runs.values()].find((r) => !r.done && r.gym === gym && r.batch === batch);
  if (mine) return stopRun(mine);
  const pid = orphanBatch(gym, batch);
  if (!pid) throw fail(409, "nothing is running for this batch");
  killGroup(pid, "SIGTERM");
  for (let i = 0; i < 40 && pidAlive(pid); i++) { if (i === 30) killGroup(pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 100)); }
  if (pidAlive(pid)) throw fail(500, "the run did not stop");
  markStopped(gym, batch);
  return { ok: true, stopped: true };
}

function startRun(kind, params) {
  const spec = RUNNABLE[kind];
  if (!spec) throw new Error(`unknown command "${kind}"`);
  const args = spec.argv(params);
  const id = `${kind}-${Date.now().toString(36)}`;
  const run = { id, kind, label: spec.label, lines: [], done: false, code: null, clients: new Set(), gym: params.gym || null, batch: params.batch || null };
  runs.set(id, run);

  const push = (text, stream) => {
    for (const line of text.toString().split(/\r?\n/)) {
      if (!line) continue;
      const entry = { stream, line };
      run.lines.push(entry);
      for (const res of run.clients) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  };

  push(`$ node ${args.map((a) => a.replace(REPO_ROOT + sep, "")).join(" ")}`, "meta");
  // spawn with an argv array and no shell — nothing from the browser reaches a shell.
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, detached: true }); // its own process group: see stopRun
  run.child = child; run.push = push;
  child.stdout.on("data", (d) => push(d, "out"));
  child.stderr.on("data", (d) => push(d, "err"));
  child.on("error", (e) => push(`spawn failed: ${e.message}`, "err"));
  child.on("close", (code) => {
    if (code === 0 && ["batch", "batch-rerender", "batch-stories", "batch-stories-rerender"].includes(kind) && run.gym && run.batch) {
      const out = outDirOf(run.gym, run.batch);
      try { if (existsSync(join(out, "review.json")) || existsSync(join(out, "selections.json"))) savePicks(run.gym, run.batch, {}); } catch (e) { push(`picks not refreshed: ${e.message}`, "err"); }
    }
    const stopped = !!run.stopping && code !== 0;
    if (stopped && run.gym && run.batch && ["batch", "batch-rerender"].includes(kind)) { try { markStopped(run.gym, run.batch); } catch (e) { push(`the batch was not marked stopped: ${e.message}`, "err"); } }
    run.done = true;
    run.code = code;
    run.stopped = stopped;
    push(code === 0 ? "✓ finished" : stopped ? "■ stopped by you" : `✗ exited with code ${code}`, "meta");
    for (const res of run.clients) { res.write(`event: done\ndata: ${JSON.stringify({ code, stopped })}\n\n`); res.end(); }
    run.clients.clear();
  });
  return run;
}

// ── Static files ─────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

/**
 * The only files /files/ will serve: generated outputs (galleries and their images), brand images,
 * and swipe reviews. Everything else — .env, source, profiles, briefs — is refused. Returns the
 * absolute path, or null.
 */
function allowedFile(rel) {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "." || p.startsWith("."))) return null;
  const ext = extname(rel).toLowerCase();
  let base = null;
  if (parts[0] === "brands" && okSlug(parts[1]) && parts[2] === "outputs" && (ext === ".html" || IMAGE_EXT.has(ext))) base = join(BRANDS, parts[1], "outputs");
  else if (parts[0] === "brands" && okSlug(parts[1]) && parts[2] === "brand-assets" && (IMAGE_EXT.has(ext) || (ext === ".svg" && parts[3] === "logo")) && parts[3] !== "_trash") base = join(BRANDS, parts[1], "brand-assets");
  else if (parts[0] === "brands" && okSlug(parts[1]) && parts[2] === REFERENCES_DIR && parts.length === 4 && REFERENCE_NAME.test(parts[3])) base = join(BRANDS, parts[1], REFERENCES_DIR);
  else if (parts[0] === "brands" && okSlug(parts[1]) && parts[2] === "onboarding" && ["website", "instagram"].includes(parts[3]) && (IMAGE_EXT.has(ext) || (ext === ".svg" && parts[3] === "website" && parts[4] === "logos"))) base = join(BRANDS, parts[1], "onboarding", parts[3]);
  else if (parts[0] === "swipe" && parts.length >= 3 && (ext === ".html" || IMAGE_EXT.has(ext))) base = SWIPE;
  if (!base) return null;
  const abs = parts[0] === "brands" ? join(base, ...parts.slice(parts[2] === "onboarding" ? 4 : 3)) : join(SWIPE, ...parts.slice(1));
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  // Symlinks may not lead out of the allowed folder.
  const real = realpathSync(abs), realBase = realpathSync(base);
  return real.startsWith(realBase + sep) ? real : null;
}

function sendFile(res, abs) {
  const ext = extname(abs).toLowerCase();
  // An SVG logo is a picture here, never a page: no scripts, no fetches, even if one slipped through.
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store", ...(ext === ".svg" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" } : {}) });
  res.end(readFileSync(abs));
}

// ── Routes ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // Addressed to this panel, or nothing: a page on another site that re-points its own hostname at
  // 127.0.0.1 (DNS rebinding) sends its own Host and is refused before anything is read.
  if (!hostOk(req)) return json(res, 403, { error: "this panel only answers requests addressed to localhost" });
  // The current token, for the panel's own page after a restart (a page loaded before it holds the old one,
  // and every save was refused until a reload). Only the panel's own page can read it: the Host check above
  // stops another name; a request another site makes says so (Sec-Fetch-Site, Origin) and is refused; and the
  // answer carries no cross-origin headers, so no other page can read it. Exactly what the page itself is.
  if (req.url === "/api/token" && req.method === "GET") {
    const site = req.headers["sec-fetch-site"];
    if ((site && site !== "same-origin") || !originOk(req)) return json(res, 403, { error: "the token is only for the panel's own page" });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ token: TOKEN }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const writes = !["GET", "HEAD"].includes(req.method);
  if (writes && (!originOk(req) || !tokenOk(req))) return json(res, 403, { error: "refused: this request did not come from the panel's own page" });

  try {
    if (p === "/" || p === "/index.html") {
      // The page carries this launch's token; the panel's own requests send it back.
      const html = readFileSync(join(UI_DIR, "app.html"), "utf-8").replace('<meta name="panel-token" content="">', `<meta name="panel-token" content="${TOKEN}">`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }

    if (p === "/api/status") return json(res, 200, setupStatus());
    // The Meta link (E1, read-only): whether .env holds the keys, and — for a gym — who the token is,
    // what it can act on, and the gym's chosen assets resolved into names, currency, status, forms and
    // pixels. Tokens never leave the server: answers carry ids and names only.
    // Keys are per gym (one Meta app per business portfolio): META_ACCESS_TOKEN_{GYM} and so on, the shared
    // names as a fallback. `used` says which names answered, so the page can show them; never their values.
    if (p === "/api/meta/status") {
      const gym = url.searchParams.get("gym");
      if (gym && !okSlug(gym)) return json(res, 400, { error: "bad gym" });
      const c = metaConfig({ gym: gym || null });
      return json(res, 200, { configured: !!c.token, app_id: !!c.appId, app_secret: !!c.appSecret, version: META_API_VERSION, permissions: META_PERMISSIONS, keys: META_ENV_KEYS, names: c.names, used: c.used });
    }
    // ── The Strategym portfolio (2026-10-07): what the system user can act on, and which gym each is linked to ──
    if (p === "/api/meta/portfolio" && req.method === "GET") {
      const cfg = metaConfig();
      if (!cfg.token) return json(res, 200, { configured: false, accounts: [], pages: [] });
      try {
        const c = graphClient({ config: cfg });
        const [accounts, pages] = await Promise.all([c.adAccounts(), c.pages()]);
        const gyms = listClients().map((g) => ({ gym: g.gym, name: g.display_name || g.gym, m: (readJsonFile(join(brandDir(g.gym), "gym-profile.json")) || {}).meta_assets || {} }));
        const linked = (k, id) => gyms.find((g) => String(g.m[k] || "").replace(/^act_/, "") === String(id).replace(/^act_/, ""))?.gym || null;
        return json(res, 200, { configured: true, accounts: accounts.map((a) => ({ id: a.id, account_id: a.account_id, name: a.name, currency: a.currency, timezone: a.timezone_name, status: a.account_status, business: a.business || null, linked_to: linked("ad_account_id", a.id) })), pages: pages.map((pg) => ({ id: pg.id, name: pg.name, category: pg.category || null, instagram: pg.instagram_business_account || null, linked_to: linked("page_id", pg.id) })) });
      } catch (e) { return json(res, 502, { error: scrubTokens(e.message) }); }
    }
    // ── Importing a gym from the portfolio (2026-10-07): the run's state and proposal, and Add to the gym ──
    const im = p.match(/^\/api\/client\/([^/]+)\/import(?:\/(accept))?$/);
    if (im) {
      const gym = im[1], action = im[2] || null;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym);
      const summary = () => {
        const w = websiteView(gym), ig = instagramView(gym);
        const website = w.reading ? { url: w.reading.url, pages: w.reading.pages?.length ?? null, colours: w.reading.colours || null, fonts: w.reading.fonts || null, logos: (w.reading.logos || []).length, logo_id: w.reading.logos?.[0]?.id || null, logo_url: w.reading.logos?.[0]?.image_url || null, photos: (w.reading.photos || []).length, identity: w.reading.identity || null, address_postal: w.reading.identity?.addresses?.[0]?.postal_code || null } : null;
        const instagram = ig.reading ? { handle: ig.reading.handle, posts: ig.reading.posts ?? null, photos: (ig.reading.photos || []).length } : null;
        return { ...importProposal(dir, { websiteReading: website, instagramReading: instagram }), running: activeRun(gym, null), steps: IMPORT_STEPS, history_top: HISTORY_TOP, profile: { display_name: (readJsonFile(join(dir, "gym-profile.json")) || {}).display_name || gym, meta_assets: (readJsonFile(join(dir, "gym-profile.json")) || {}).meta_assets || {} } };
      };
      if (!action && req.method === "GET") return json(res, 200, summary());
      if (action === "accept" && req.method === "POST") {
        const body = await readBody(req);
        const profile = readJsonFile(join(dir, "gym-profile.json")) || {}, cfg = metaConfig({ gym });
        try {
          const r = await applyImport(dir, body, { accept: {
            writeProfile: (pf) => writeWhole(join(dir, "gym-profile.json"), JSON.stringify({ ...pf, schema_version: Math.max(PROFILE_SCHEMA, Number(pf.schema_version) || 0) }, null, 2) + "\n"),
            website: (picks) => acceptWebsite(gym, picks),
            history: async (ids) => {
              if (!cfg.token || !profile.meta_assets?.ad_account_id) throw fail(409, "the Meta link is needed to bring ads into the library");
              const top = ids || importProposal(dir).history.top.map((t) => t.ad_id);
              if (!top.length) return { imported: 0 };
              const done = await importFromAccount({ client: graphClient({ config: cfg }), accountId: profile.meta_assets.ad_account_id, gymDir: dir, adIds: top.map(String) });
              // Each imported ad's copy to the shared library as skeletons, as Xinyi's were (two text calls each).
              let sent = 0;
              for (const ref of readCopyRefs(dir).refs.filter((x) => top.includes(String(x.ad_id)) && !x.in_library)) { try { await sendToLibrary(dir, ref.id, { gym }); sent++; } catch {} }
              return { imported: done.imported?.length ?? done.added ?? top.length, sent };
            },
          } });
          return json(res, 200, { ...r, ...summary() });
        } catch (e) { return json(res, e.status || (e.code === 190 || e.trace ? 502 : 400), { error: scrubTokens(e.message) }); }
      }
      return json(res, 405, { error: "method not allowed" });
    }
    // ── Instant forms built here (2026-10-07): the Page's forms, the gym's template, a proposal for an offer, creation
    //    on the Page (the owner's click), the gym's default form. Nothing is sent to Meta but the create.
    const lf = p.match(/^\/api\/client\/([^/]+)\/lead-forms(?:\/(template|propose|create|default))?$/);
    if (lf) {
      const gym = lf[1], action = lf[2] || null;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym), pf = join(dir, "gym-profile.json"), profile = readJsonFile(pf) || {};
      const pageId = profile.meta_assets?.page_id || null, cfg = metaConfig({ gym });
      const data = readLeadForms(dir), base = { page_id: pageId, page_name: profile.meta_assets?.labels?.page || null, record: data, default_form_id: profile.meta_assets?.lead_form_id || null, district: profile.creative_defaults?.locations?.[0] || null };
      const client = () => graphClient({ config: cfg });
      if (!action && req.method === "GET") {
        if (!cfg.token) return json(res, 200, { ...base, configured: false, forms: [], reason: "the Meta link is not set up yet (Meta link page)" });
        if (!pageId) return json(res, 200, { ...base, configured: true, forms: [], reason: "pick the gym's Facebook Page on the Meta link page first" });
        try { return json(res, 200, { ...base, configured: true, forms: await readForms(client(), pageId) }); }
        catch (e) { return json(res, 502, { error: `the Page's forms could not be read: ${scrubTokens(e.message)}` }); }
      }
      if (action === "template" && req.method === "POST") {
        const body = await readBody(req);
        if (!/^\d{5,20}$/.test(String(body.id || ""))) return json(res, 400, { error: "id must be one of the Page's forms" });
        if (!cfg.token || !pageId) return json(res, 409, { error: "the Meta link and the gym's Page are needed first (Meta link page)" });
        let forms;
        try { forms = await readForms(client(), pageId); } catch (e) { return json(res, 502, { error: `the Page's forms could not be read: ${scrubTokens(e.message)}` }); }
        const form = forms.find((f) => String(f.id) === String(body.id));
        if (!form) return json(res, 404, { error: "that form is not on the gym's Page" });
        data.template = { ...templateFrom(form, { district: base.district }), set: new Date().toISOString() };
        writeLeadForms(dir, data);
        return json(res, 200, { template: data.template });
      }
      if (action === "propose" && req.method === "POST") {
        const body = await readBody(req);
        if (!data.template) return json(res, 409, { error: "choose one of the Page's forms as the template first" });
        const str = (k, max = 300) => (body[k] == null || body[k] === "" ? null : typeof body[k] === "string" && body[k].length <= max ? body[k] : undefined);
        for (const k of ["offer", "old_offer", "callout", "old_district", "name"]) if (str(k) === undefined) return json(res, 400, { error: `${k} must be text (up to 300 characters)` });
        try {
          const r = proposeForm(data.template, { offer: str("offer"), oldOffer: str("old_offer"), callout: str("callout"), oldDistrict: str("old_district"), name: str("name") });
          return json(res, 200, { ...r, problems: formProblems(r.spec) });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === "create" && req.method === "POST") {
        const body = await readBody(req);
        if (!isPlainObject(body.spec)) return json(res, 400, { error: "spec must be the form as proposed" });
        const problems = formProblems(body.spec);
        if (problems.length) return json(res, 400, { error: `the form is not ready: ${problems.join("; ")}`, problems });
        if (!cfg.token || !pageId) return json(res, 409, { error: "the Meta link and the gym's Page are needed first (Meta link page)" });
        try {
          const made = await createForm(client(), pageId, body.spec, { gymDir: dir, offer: typeof body.offer === "string" ? body.offer.slice(0, 300) : null, templateId: data.template?.source?.id || null });
          return json(res, 200, { made });
        } catch (e) { return json(res, 502, { error: `the form was not created: ${scrubTokens(e.message)}` }); }
      }
      if (action === "default" && req.method === "POST") {
        const body = await readBody(req);
        if (!/^\d{5,20}$/.test(String(body.id || ""))) return json(res, 400, { error: "id must be a form id" });
        (profile.meta_assets ||= {}).lead_form_id = String(body.id);
        if (typeof body.name === "string" && body.name) (profile.meta_assets.labels ||= {}).form = body.name.slice(0, 200);
        const errors = validateProfile(profile).errors || [];
        if (errors.length) return json(res, 400, { error: errors.join("; ") });
        writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
        return json(res, 200, { default_form_id: profile.meta_assets.lead_form_id });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    const ml = p.match(/^\/api\/client\/([^/]+)\/meta-link$/);
    if (ml && req.method === "GET") {
      const gym = ml[1];
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const c = metaConfig({ gym });
      if (!c.token) return json(res, 200, { configured: false, version: META_API_VERSION, names: c.names });
      // Ids picked on the page but not saved yet ride along as query parameters (digits only), so the
      // Page's forms and the account's pixels are listed as soon as they are chosen.
      const profile = readJsonFile(join(brandDir(gym), "gym-profile.json")) || {};
      const picked = {};
      for (const [k, re] of Object.entries(META_ID)) { const v = url.searchParams.get(k); if (v != null) { if (v !== "" && !re.test(v)) return json(res, 400, { error: `${k} must be digits` }); picked[k] = v; } }
      try {
        const r = await checkLink({ ...profile, meta_assets: { ...(profile.meta_assets || {}), ...picked } }, { client: graphClient({ config: c }) });
        return json(res, 200, { configured: true, app_secret: !!c.appSecret, used: c.used, ...r });
      } catch (e) { return json(res, 502, { configured: true, error: scrubTokens(e.message), code: e.code ?? null }); }
    }
    // A Singapore address or postal code → points on the map, from OneMap (the government's geocoder; no key needed).
    if (p === "/api/geocode") {
      const q = (url.searchParams.get("q") || "").trim(), gq = url.searchParams.get("gym");
      if (!q || q.length > 120 || /[\r\n]/.test(q)) return json(res, 400, { error: "give an address or a postal code" });
      if (gq) {
        if (!okSlug(gq)) return json(res, 400, { error: "bad gym" });
        const cr = countryRules(profileCountry(readJsonFile(join(brandDir(gq), "gym-profile.json")) || {}));
        if (cr.geocoder !== "onemap") return json(res, 400, { error: `no map for ${cr.name || "this country"} here: the gym's point comes from its Facebook Page (From the ad account) or a Meta place key` });
      }
      try {
        const r = await fetch(`${ONEMAP_URL}/api/common/elastic/search?${new URLSearchParams({ searchVal: q, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" })}`, { headers: { accept: "application/json" } });
        const b = await r.json();
        const results = (Array.isArray(b.results) ? b.results : []).map((x) => ({ address: String(x.ADDRESS || x.SEARCHVAL || ""), postal_code: /^\d{6}$/.test(String(x.POSTAL || "")) ? String(x.POSTAL) : null, lat: Number(x.LATITUDE), lng: Number(x.LONGITUDE) })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 8);
        return json(res, 200, { results });
      } catch (e) { return json(res, 502, { error: `OneMap could not be reached (${e.message})` }); }
    }
    // /api/client/{gym}/targeting[/{id}] — the detailed-targeting presets: imported from the account's own ad sets
    // (with what they cost and brought), its saved audiences, or built by the owner from Meta's search.
    // ── The shared targeting library (2026-10-07): curated across every gym's results, the owner's to approve ──
    const tl = p.match(/^\/api\/library\/targeting(?:\/([0-9a-f]{12})\/(approve|retire|restore))?$/);
    if (tl) {
      const id = tl[1] || null, action = tl[2] || null;
      try {
        if (!id && req.method === "GET") return json(res, 200, targetingLibraryView());
        if (!id && req.method === "POST") { const body = await readBody(req); const e = addTargeting(TARGETING_LIBRARY_DIR, { name: body.name, audience: body.audience || "all", role: body.role || "default", note: body.note || "", groups: body.groups, evidence: [] }); return json(res, 200, { ...targetingLibraryView(), added: e.id }); }
        if (id && req.method === "POST") {
          const body = action === "retire" ? await readBody(req) : {};
          if (action === "approve") approveTargeting(TARGETING_LIBRARY_DIR, id);
          else if (action === "retire") retireTargeting(TARGETING_LIBRARY_DIR, id, body.reason);
          else restoreTargeting(TARGETING_LIBRARY_DIR, id);
          return json(res, 200, targetingLibraryView());
        }
      } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 405, { error: "method not allowed" });
    }
    const tg = p.match(/^\/api\/client\/([^/]+)\/targeting(?:\/([^/]+))?$/);
    if (tg) {
      const gym = tg[1], id = tg[2] ? decodeURIComponent(tg[2]) : null;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym);
      const view = (extra = {}) => { const d = readPresets(dir); return { account: d.account, imported: d.imported, presets: livePresets(d), retired: d.presets.filter((x) => x.retired), library: targetingLibraryView(), ...extra }; };
      try {
        if (!id && req.method === "GET") {
          const q = url.searchParams;
          return json(res, 200, view(q.get("suggest") != null ? { suggested: rankPresets(readPresets(dir), { gender: q.get("gender") || "all", words: q.get("suggest") || "" }) } : {}));
        }
        if (id === "import" && req.method === "POST") {
          const profile = readJsonFile(join(dir, "gym-profile.json")) || {};
          const c = metaConfig({ gym });
          if (!c.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
          if (!profile.meta_assets?.ad_account_id) return json(res, 409, { error: "pick the gym's ad account on the Meta link page first" });
          const r = await importPresets({ client: graphClient({ config: c }), accountId: profile.meta_assets.ad_account_id, gymDir: dir });
          return json(res, 200, view({ added: r.added, adsets: r.adsets, with_results: r.with_results, saved: r.saved }));
        }
        if (!id && req.method === "POST") { const { name, spec, notes } = await readBody(req); return json(res, 200, view({ preset: addPreset(dir, { name, spec, notes }) })); }
        if (id === "search" && req.method === "GET") {
          const q = (url.searchParams.get("q") || "").trim();
          if (!q || q.length > 80 || /[\r\n]/.test(q)) return json(res, 400, { error: "give a word or two to search Meta's targeting for" });
          const profile = readJsonFile(join(dir, "gym-profile.json")) || {}, c = metaConfig({ gym });
          if (!c.token || !profile.meta_assets?.ad_account_id) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
          return json(res, 200, { results: await graphClient({ config: c }).targetingSearch(profile.meta_assets.ad_account_id, q) });
        }
        if (id === "estimate" && req.method === "POST") {
          // Meta's reach for a spec with a pin, ages and gender — its own words for it beside the number.
          const { spec = {}, targeting = {} } = await readBody(req);
          const problems = specProblems(spec); if (problems.length) return json(res, 400, { error: problems.join("; ") });
          const profile = readJsonFile(join(dir, "gym-profile.json")) || {}, c = metaConfig({ gym });
          if (!c.token || !profile.meta_assets?.ad_account_id) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
          const full = { ...(isPlainObject(targeting) ? targeting : {}), ...normaliseSpec(spec), targeting_automation: { advantage_audience: 0 } };
          const client = graphClient({ config: c }), acct = profile.meta_assets.ad_account_id;
          const [reach, sentences] = await Promise.all([client.deliveryEstimate(acct, full), client.targetingSentences(acct, full).catch(() => [])]);
          return json(res, 200, { reach, sentences, summary: summarise(spec) });
        }
        if (id && req.method === "PUT") { const { name, notes, restore } = await readBody(req); return json(res, 200, view({ preset: restore ? restorePreset(dir, id) : renamePreset(dir, id, { name, notes }) })); }
        if (id && req.method === "DELETE") { const { reason } = await readBody(req); return json(res, 200, view({ preset: retirePreset(dir, id, reason) })); }
      } catch (e) { return json(res, e.code === 190 || e.trace ? 502 : 400, { error: scrubTokens(e.message) }); }
    }
    // /api/client/{gym}/results[.csv] — every published ad of every batch, with what it was and what it did.
    const rs = p.match(/^\/api\/client\/([^/]+)\/results(\.csv)?$/);
    if (rs && req.method === "GET") {
      const gym = rs[1];
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const rows = gymRows(brandDir(gym));
      if (rs[2]) { res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${gym}-results.csv"` }); return res.end(resultsCsv(allRows(brandDir(gym)))); }
      const batches = [...new Set(rows.map((r) => r.batch))].map((id) => ({ id, results: readJsonFile(join(brandDir(gym), "outputs", id, "results.json")), record: (({ campaign, adsets, ads, done }) => ({ campaign, adsets: Object.keys(adsets || {}).length, ads: Object.keys(ads || {}).length, done }))(readJsonFile(join(brandDir(gym), "outputs", id, "publish.json")) || {}) }));
      const h = readHistory(brandDir(gym));
      const hrows = h ? historyRows(brandDir(gym)) : [];
      return json(res, 200, { rows, adsets: adsetRows([...rows, ...hrows]), campaigns: campaignRows([...rows, ...hrows]), batches, history: h ? { pulled: h.pulled, campaigns: h.campaigns.length, adsets: h.adsets.length, ads: h.ads.length, rows: hrows, campaign_list: h.campaigns } : null, copy_refs: readCopyRefs(brandDir(gym)).refs.length });
    }
    // The account's history: pulled from Meta (read-only), and chosen ads brought into the library.
    const hs = p.match(/^\/api\/client\/([^/]+)\/history\/(pull|import)$/);
    if (hs && req.method === "POST") {
      const gym = hs[1];
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const profile = readJsonFile(join(brandDir(gym), "gym-profile.json")) || {}, c = metaConfig({ gym });
      if (!c.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
      if (!profile.meta_assets?.ad_account_id) return json(res, 409, { error: "pick the gym's ad account on the Meta link page first" });
      const client = graphClient({ config: c }), accountId = profile.meta_assets.ad_account_id;
      try {
        if (hs[2] === "pull") { const h = await pullAccountHistory({ client, accountId, gymDir: brandDir(gym) }); const hrows = historyRows(brandDir(gym)); return json(res, 200, { pulled: h.pulled, campaigns: h.campaigns.length, adsets: h.adsets.length, ads: h.ads.length, rows: hrows, campaign_list: h.campaigns, adsets_rows: adsetRows([...gymRows(brandDir(gym)), ...hrows]), campaign_rows: campaignRows([...gymRows(brandDir(gym)), ...hrows]) }); }
        const { ads } = await readBody(req);
        if (!Array.isArray(ads) || !ads.length || ads.length > 50 || ads.some((id) => !/^\d{5,20}$/.test(String(id)))) return json(res, 400, { error: "choose 1 to 50 ads by id" });
        const done = await importFromAccount({ client, accountId, gymDir: brandDir(gym), adIds: ads.map(String) });
        return json(res, 200, { ...done, rows: historyRows(brandDir(gym)), copy_refs: readCopyRefs(brandDir(gym)).refs.length });
      } catch (e) { return json(res, e.code === 190 || e.trace ? 502 : 400, { error: scrubTokens(e.message) }); }
    }
    // Meta place keys (pasted, or from the account's history) → their names and points.
    const mpl = p.match(/^\/api\/client\/([^/]+)\/meta-places$/);
    if (mpl && req.method === "GET") {
      const gym = mpl[1];
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const keys = (url.searchParams.get("keys") || "").split(",").map((k) => k.trim()).filter(Boolean);
      if (!keys.length || keys.length > 20 || keys.some((k) => !/^\d{5,20}$/.test(k))) return json(res, 400, { error: "place keys are digits, up to 20 of them" });
      const c = metaConfig({ gym });
      if (!c.token) return json(res, 200, { configured: false, places: [] });
      try { return json(res, 200, { configured: true, places: await graphClient({ config: c }).places(keys) }); }
      catch (e) { return json(res, 502, { configured: true, error: scrubTokens(e.message) }); }
    }
    if (p === "/api/enums") return json(res, 200, { cta: CTA_ENUM, offerTypes: OFFER_TYPES, priceQualifiers: PRICE_QUALIFIERS, maxLocations: MAX_LOCATIONS });
    if (p === "/api/clients" && req.method === "GET") return json(res, 200, { clients: listClients() });

    if (p === "/api/clients" && req.method === "POST") {
      const { gym, offer, display_name = "", country = "SG", meta = null } = await readBody(req);
      if (!okSlug(gym)) return json(res, 400, { error: "the folder name must be lowercase letters, numbers and hyphens" });
      if (meta != null && (!isPlainObject(meta) || !/^(act_)?\d{5,20}$/.test(String(meta.ad_account_id || "")) || !/^\d{5,20}$/.test(String(meta.page_id || "")))) return json(res, 400, { error: "meta must carry the ad account id and the Page id from the portfolio" });
      if (!/^[A-Za-z]{2}$/.test(String(country))) return json(res, 400, { error: "the country is a two-letter code (SG, TW, MY…)" });
      if (offer && !okSlug(offer)) return json(res, 400, { error: "offer slug must be lowercase letters, numbers and hyphens" });
      if (typeof display_name !== "string" || display_name.length > 80 || /[—–\r\n]/.test(display_name)) return json(res, 400, { error: "the gym's name must be one line, without em/en dashes" });
      const fresh = !existsSync(join(brandDir(gym), "gym-profile.json"));
      scaffold(gym, offer || null, { brandsDir: BRANDS, displayName: display_name.trim(), country: String(country).toUpperCase() });
      // From the portfolio (2026-10-07): the Meta ids and the account's currency and time zone go straight onto the new profile.
      if (meta) {
        const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
        const m = (profile.meta_assets ||= {}), labels = (m.labels ||= {});
        m.ad_account_id = String(meta.ad_account_id).startsWith("act_") ? String(meta.ad_account_id) : `act_${meta.ad_account_id}`; m.page_id = String(meta.page_id);
        for (const k of ["business_id", "instagram_user_id", "pixel_id"]) if (/^\d{5,20}$/.test(String(meta[k] || ""))) m[k] = String(meta[k]);
        for (const k of ["account", "page", "business", "instagram"]) if (typeof meta.labels?.[k] === "string") labels[k] = meta.labels[k].slice(0, 120);
        if (typeof meta.currency === "string" && /^[A-Z]{3}$/.test(meta.currency)) { (profile.locale ||= {}).currency = meta.currency; ((profile.campaign_defaults ||= {}).budget ||= {}).currency = meta.currency; }
        if (typeof meta.timezone === "string" && meta.timezone.length <= 64) (profile.locale ||= {}).timezone = meta.timezone;
        const errors = validateProfile(profile).errors || [];
        if (errors.length) return json(res, 400, { error: `the portfolio's ids do not fit the profile: ${errors.join("; ")}` });
        writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
      }
      return json(res, 200, { ok: true, gym, offer: offer || null, created: fresh, imported_ids: !!meta });
    }

    // /api/client/{gym}/wordings[/{id}] — the offer wordings, kept once, offered as chips.
    const wm = p.match(/^\/api\/client\/([^/]+)\/wordings(?:\/([^/]+))?$/);
    if (wm) {
      const [, gym, id] = wm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (id && !okSlug(id)) return json(res, 404, { error: "no such wording" });
      const dir = brandDir(gym);
      try {
        if (!id && req.method === "GET") return json(res, 200, { wordings: readWordings(dir) });
        if (!id && req.method === "POST") { const { text } = await readBody(req); return json(res, 200, addWording(dir, text)); }
        if (id && req.method === "PUT") { const { text } = await readBody(req); return json(res, 200, editWording(dir, id, text)); }
        if (id && req.method === "DELETE") return json(res, 200, deleteWording(dir, id));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    const pi = p.match(/^\/api\/preview-img\/([a-f0-9]{18})\.png$/);
    if (pi) {
      const png = previews.get(pi[1]);
      if (!png) return json(res, 404, { error: "preview expired" });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(png);
    }

    if (p === "/api/preview" && req.method === "POST") {
      const { gym, offer, location, audience = null, photos } = await readBody(req);
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const errors = validateInputs({ location, audience, offer });
      if (errors.length) return json(res, 200, { errors, looks: [] });
      const clean = cleanPhotos(gym).map((x) => x.path);
      const use = (Array.isArray(photos) && photos.length ? photos : clean).filter((x) => clean.includes(x)).slice(0, 2);
      if (!use.length) return json(res, 200, { errors: ["no clean photo to preview on: clean one first (clean-photo.mjs)"], looks: [] });
      const job = queue.then(() => renderPreview(gym, { offer, location, audience, photos: use }));
      queue = job.catch(() => {});
      return json(res, 200, { errors: [], looks: await job });
    }

    // /api/client/{gym}/website · /website/accept — the website's reading, and filing what the owner ticked.
    // /api/client/{gym}/meta-facts — onboarding from the gym's own Facebook Page and ad account (read-meta.mjs):
    // GET the last reading with the profile's state; POST /read reads Meta now (a few calls, seconds); POST /accept
    // applies what the owner ticked to the profile (on a copy, validated first) and the offer names to the wordings.
    const mf = p.match(/^\/api\/client\/([^/]+)\/meta-facts(\/read|\/accept)?$/);
    if (mf) {
      const [, gym, what] = mf;
      if (!okSlug(gym) || !existsSync(join(brandDir(gym), "gym-profile.json"))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym), pf = join(dir, "gym-profile.json");
      const view = (extra = {}) => { const profile = readJsonFile(pf) || {}, cfg = metaConfig({ gym }); return json(res, 200, { reading: readMetaReading(dir), configured: !!cfg.token, ids: { ad_account_id: profile.meta_assets?.ad_account_id || "", page_id: profile.meta_assets?.page_id || "" }, profile: { locale: profile.locale || {}, locations: profile.locations || [], website: profile.website || "", social: profile.social || {}, pins: profile.targeting_defaults?.geo?.radius_pins || [], ages: { min: profile.targeting_defaults?.demographics?.age_min ?? null, max: profile.targeting_defaults?.demographics?.age_max ?? null }, budget: profile.campaign_defaults?.budget || {}, callouts: profile.creative_defaults?.locations || [], people: profile.brand_lock?.photography?.people || "" }, wordings: readWordings(dir).map((w) => w.text), ...extra }); };
      try {
        if (!what && req.method === "GET") return view();
        if (what === "/read" && req.method === "POST") {
          const cfg = metaConfig({ gym });
          if (!cfg.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
          const profile = readJsonFile(pf) || {};
          const reading = await readMetaFacts({ client: graphClient({ config: cfg }), profile });
          writeMetaReading(dir, reading);
          return view();
        }
        if (what === "/accept" && req.method === "POST") {
          const r = acceptMetaFacts(dir, await readBody(req));
          writeWhole(pf, JSON.stringify({ ...r.profile, schema_version: Math.max(PROFILE_SCHEMA, Number(r.profile.schema_version) || 0) }, null, 2) + "\n");
          return view({ changes: r.changes, wordings_added: r.wordings.added, wordings_skipped: r.wordings.skipped });
        }
      } catch (e) { return json(res, e.status || (e.code === 190 || e.trace ? 502 : 400), { error: scrubTokens(String(e.message || e)), ...(e.errors ? { errors: e.errors } : {}) }); }
    }
    const webm = p.match(/^\/api\/client\/([^/]+)\/website(\/accept)?$/);
    if (webm) {
      const [, gym, accept] = webm;
      if (!okSlug(gym) || !existsSync(join(brandDir(gym), "gym-profile.json"))) return json(res, 400, { error: "bad gym" });
      if (!accept && req.method === "GET") return json(res, 200, websiteView(gym));
      if (accept && req.method === "POST") {
        try { return json(res, 200, { ...acceptWebsite(gym, await readBody(req)), ...websiteView(gym) }); }
        catch (e) { return json(res, e.status || 400, { error: e.message, ...(e.errors ? { errors: e.errors } : {}) }); }
      }
    }

    // /api/client/{gym}/singapore-identity { beneficiary, payer } — the owner's pick when the account's ad sets
    // carry more than one: only an identity those ad sets really name is taken.
    const sgm = p.match(/^\/api\/client\/([^/]+)\/(?:singapore-)?identity$/);
    if (sgm && req.method === "POST") {
      const gym = sgm[1];
      if (!okSlug(gym) || !existsSync(join(brandDir(gym), "gym-profile.json"))) return json(res, 400, { error: "bad gym" });
      const body = await readBody(req), cfg = metaConfig({ gym });
      if (!cfg.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
      const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
      if (!profile.meta_assets?.ad_account_id) return json(res, 409, { error: "pick the gym's ad account on the Meta link page first" });
      try {
        const reg = regulatedFor(profile);
        if (!reg) return json(res, 409, { error: "this gym's country needs no advertiser identity on Meta" });
        const found = (await graphClient({ config: cfg }).regulationIdentities(profile.meta_assets.ad_account_id)).filter((x) => x.category === reg.category);
        const pick = found.find((x) => String(x.beneficiary) === String(body.beneficiary) && String(x.payer) === String(body.payer));
        if (!pick) return json(res, 400, { error: "that identity is not one the account's ad sets name" });
        setIdentity(profile, pick);
        writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
        identityMemo.clear();
        return json(res, 200, { ok: true, beneficiary: pick.beneficiary, payer: pick.payer });
      } catch (e) { return json(res, 502, { error: scrubTokens(e.message) }); }
    }

    // /api/client/{gym}/clean/keep {id} · /clean/discard {name} — the owner's word on the clean-up's photos.
    // /api/client/{gym}/room-reference { path | null } — the photo every generated picture matches its room to: one of the
    // cleaned photos (premises, or a coach/member photo from reference-clean, which is never an ad). Kept on the profile.
    const rrm = p.match(/^\/api\/client\/([^/]+)\/room-reference$/);
    if (rrm && req.method === "POST") {
      const gym = rrm[1];
      if (!okSlug(gym) || !existsSync(join(brandDir(gym), "gym-profile.json"))) return json(res, 400, { error: "bad gym" });
      const { path: want } = await readBody(req);
      if (want != null && !cleanPhotos(gym).some((x) => x.path === want)) return json(res, 400, { error: "the room reference must be one of the cleaned photos" });
      const pf = join(brandDir(gym), "gym-profile.json"), profile = readJsonFile(pf) || {};
      (profile.creative_defaults ||= {}).room_reference = want || null;
      const { errors } = validateProfile(profile, { gymDir: brandDir(gym) });
      if (errors.length) return json(res, 400, { error: errors[0] });
      writeWhole(pf, JSON.stringify(profile, null, 2) + "\n");
      return json(res, 200, { ok: true, room_reference: profile.creative_defaults.room_reference });
    }
    const ckm = p.match(/^\/api\/client\/([^/]+)\/clean\/(keep|discard)$/);
    if (ckm && req.method === "POST") {
      const [, gym, act] = ckm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      try { const body = await readBody(req); return json(res, 200, act === "keep" ? keepFlagged(gym, body.id) : discardClean(gym, body.name)); }
      catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }

    // /api/client/{gym}/instagram · /instagram/accept — the Instagram reading, and filing the ticked photos.
    const igm = p.match(/^\/api\/client\/([^/]+)\/instagram(\/accept)?$/);
    if (igm) {
      const [, gym, accept] = igm;
      if (!okSlug(gym) || !existsSync(join(brandDir(gym), "gym-profile.json"))) return json(res, 400, { error: "bad gym" });
      if (!accept && req.method === "GET") return json(res, 200, instagramView(gym));
      if (accept && req.method === "POST") {
        try { return json(res, 200, { ...acceptInstagram(gym, await readBody(req)), ...instagramView(gym) }); }
        catch (e) { return json(res, e.status || 400, { error: e.message }); }
      }
    }

    // /api/client/{gym}/assets · /asset/{kind}/{name} — the gym's own files, from the panel's drop zone.
    const am = p.match(/^\/api\/client\/([^/]+)\/(assets|asset\/([a-z]+)\/([^/]+))$/);
    if (am) {
      const [, gym, what, kind, name] = am;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (what === "assets" && req.method === "GET") return json(res, 200, { kinds: ASSET_KINDS, assets: listAssets(gym), clean: cleanPhotos(gym), flagged: flaggedCleans(gym), room_reference: (readJsonFile(join(brandDir(gym), "gym-profile.json")) || {}).creative_defaults?.room_reference || null, heic: hasSips(), max_bytes: MAX_ASSET_BYTES, max_clean: MAX_CLEAN_PHOTOS });
      if (kind && req.method === "PUT") {
        let buf;
        try { buf = await readRaw(req, MAX_ASSET_BYTES); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
        try {
          const original = req.headers["x-original-name"] ? decodeURIComponent(String(req.headers["x-original-name"])).slice(0, 200) : null;
          const row = saveAsset(gym, kind, name, buf, original, { keepLowRes: req.headers["x-keep-low-res"] === "1" });
          return json(res, 200, { ok: true, asset: { ...row, url: `/files/brands/${gym}/brand-assets/${row.path}` } });
        } catch (e) { return json(res, e.status || 400, { error: e.message, ...(e.low_res ? { low_res: true, size: e.size, min_px: MIN_PHOTO_PX } : {}) }); }
      }
      if (kind && req.method === "DELETE") {
        try { return json(res, 200, removeAsset(gym, kind, name)); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
      }
    }

    // /api/client/{gym}/scenes · /scenes/approve · /scenes/reject · /reference/{name}
    const sm = p.match(/^\/api\/client\/([^/]+)\/(scenes|scenes\/approve|scenes\/reject|scenes\/copy|reference\/([^/]+))$/);
    if (sm) {
      const [, gym, what, name] = sm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const scenesPath = join(brandDir(gym), "scenes.json");
      // The other gyms' libraries a new gym may start from: each with its live count (its own left out).
      const siblings = () => listClients().filter((c) => c.gym !== gym).map((c) => { const st = sceneStatus(c.gym); return { gym: c.gym, name: c.display_name || c.gym, live: st.exists ? st.total : 0 }; }).filter((c) => c.live > 0);
      if (what === "scenes" && req.method === "GET") return json(res, 200, { status: sceneStatus(gym), drafts: sceneDrafts(gym), references: listReferences(gym), audiences: AUDIENCES, maxCount: MAX_REFRESH_COUNT, maxWords: MAX_WORDS, siblings: siblings() });
      // A new gym's first scenes from another gym's library, as drafts for approval; the people's country swapped in the words.
      if (what === "scenes/copy" && req.method === "POST") {
        const { from } = await readBody(req);
        if (!okSlug(from) || from === gym || !existsSync(join(brandDir(from), "scenes.json"))) return json(res, 400, { error: "pick another gym that has a scene library" });
        const me = readJsonFile(join(brandDir(gym), "gym-profile.json")) || {}, them = readJsonFile(join(brandDir(from), "gym-profile.json")) || {};
        const cf = countryRules(profileCountry(them)), ct = countryRules(profileCountry(me));
        try { return json(res, 200, { ok: true, ...copyScenesFrom(scenesPath, join(brandDir(from), "scenes.json"), { fromGym: from, people: { from: { name: cf.name, demonym: cf.demonym }, to: { name: ct.name, demonym: ct.demonym } } }), status: sceneStatus(gym), drafts: sceneDrafts(gym) }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (!existsSync(scenesPath) && what.startsWith("scenes/")) return json(res, 404, { error: "no scene library for this client" });
      if (what === "scenes/approve" && req.method === "POST") {
        const { ids } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length || !ids.every(okSlug)) return json(res, 400, { error: "ids must list the scenes to approve" });
        try { return json(res, 200, { ok: true, ...approveScenes(scenesPath, ids) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (what === "scenes/reject" && req.method === "POST") {
        const { id, reason } = await readBody(req);
        if (!okSlug(id)) return json(res, 400, { error: "id must name the scene to reject" });
        if (typeof reason !== "string" || reason.trim().length < 3) return json(res, 400, { error: "rejecting a scene needs a reason (what was wrong with it)" });
        try { return json(res, 200, { ok: true, ...rejectScene(scenesPath, id, reason) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      // A reference image, uploaded as raw bytes. Image files only, by their first bytes; kept in the
      // client's gitignored references folder; a replaced image loses its cached reading.
      if (name && req.method === "PUT") {
        if (!REFERENCE_NAME.test(name)) return json(res, 400, { error: "the file name must be lower-case letters, digits and hyphens, ending in .png, .jpg or .webp" });
        let buf;
        try { buf = await readRaw(req, MAX_REFERENCE_BYTES); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
        const kind = imageKind(buf);
        const ext = extname(name).toLowerCase().replace(".jpeg", ".jpg");
        if (!kind || `.${kind}` !== ext) return json(res, 400, { error: kind ? `this is a ${kind} file; name it .${kind}` : "not an image file (png, jpg or webp)" });
        mkdirSync(referencesDir(gym), { recursive: true });
        writeFileSync(join(referencesDir(gym), name), buf);
        rmSync(join(referencesDir(gym), `${name}.description.json`), { force: true });
        return json(res, 200, { ok: true, name, url: `/files/brands/${gym}/${REFERENCES_DIR}/${name}` });
      }
    }

    // /api/client/{gym}/batch/{id}/progress · /review · /picks · /publish
    // /api/client/{gym}/batch/{id}/copy — the campaign's copy: drafts (the model, one call), the owner's own, keep / exclude / edit.
    // /api/client/{gym}/batch/{id}/images.zip — every kept ad's 1:1 and 9:16 by ad set, for building the ads by hand in Ads Manager.
    const zp = p.match(/^\/api\/client\/([^/]+)\/batch\/([^/]+)\/images\.zip$/);
    if (zp && req.method === "GET") {
      const [, gym, id] = zp;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (!okSlug(id) || !existsSync(join(outDirOf(gym, id), "batch.json"))) return json(res, 404, { error: "no finished batch of that name" });
      const z = keptImagesZip(outDirOf(gym, id), { batchId: id });
      if (!z.ads) return json(res, 409, { error: "no kept ads in this batch" });
      res.writeHead(200, { "content-type": "application/zip", "content-length": z.buffer.length, "content-disposition": `attachment; filename="${id}-images.zip"`, "cache-control": "no-store" });
      return res.end(z.buffer);
    }
    const cp = p.match(/^\/api\/client\/([^/]+)\/batch\/([^/]+)\/copy(?:\/([^/]+))?$/);
    if (cp) {
      const [, gym, id, cid] = cp;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (!okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
      const out = outDirOf(gym, id), dir = brandDir(gym), brief = readJsonFile(briefPath(gym, id)) || {};
      const profile = readJsonFile(join(dir, "gym-profile.json")) || {};
      const offerDoc = (() => { const od = join(dir, "offers"); if (!existsSync(od)) return null; for (const f of readdirSync(od).filter((x) => x.endsWith(".json"))) { const o = readJsonFile(join(od, f)); if (o?.name && String(o.name).toLowerCase() === String(brief.offer || "").toLowerCase()) return o; } return null; })();
      const view = (extra = {}) => json(res, 200, { ...readCopy(out), flat: flatCopies(out).map((d) => d.id), kept: keptCopies(out).map((d) => d.id), kept_headlines: keptCopies(out, "headline").map((d) => d.id), references: referencesFor(dir).length, library: { copy: liveEntries(undefined, "copy", { language: gymLanguage(profile) }).length, headline: liveEntries(undefined, "headline", { language: gymLanguage(profile) }).length, language: gymLanguage(profile) }, angles: ANGLES, max_options: MAX_OPTIONS, ...extra });
      const kindOk = (k) => COPY_KINDS.includes(k);
      try {
        if (!cid && req.method === "GET") return view();
        if (cid === "draft" && req.method === "POST") {
          const { count = 10, kind = "copy" } = await readBody(req);
          if (!Number.isInteger(count) || count < 1 || count > 20) return json(res, 400, { error: "count must be 1 to 20" });
          if (!kindOk(kind)) return json(res, 400, { error: "kind is copy or headline" });
          mkdirSync(out, { recursive: true });
          const cta = (readJsonFile(join(out, "publish-settings.json")) || {}).words?.cta, button = ctaLabel(CTA_TYPES[cta] ? cta : "SIGN_UP", gymLanguage(profile));
          const r = await draftCopy({ brandDir: dir, batchDir: out, kind, offer: brief.offer, audience: brief.audience || null, locations: brief.locations || [], count, button });
          return view({ added: r.added.length, dropped: r.dropped, calls: r.calls, recommended: r.recommended.length, skeletons: r.skeletons });
        }
        // Line breaks for the primary texts that came as one block (one text call; the words are not touched).
        if (cid === "layout" && req.method === "POST") { const r = await relayoutCopies(out); return view({ layout: r }); }
        // The owner's one click: keep the recommended drafts of a kind.
        if (cid === "recommended" && req.method === "POST") { const { kind = "copy" } = await readBody(req); if (!kindOk(kind)) return json(res, 400, { error: "kind is copy or headline" }); const recs = keepRecommended(out, kind); return view({ kept_now: recs.map((d) => d.id) }); }
        if (!cid && req.method === "POST") { const { kind = "copy", message, headline, description } = await readBody(req); if (!kindOk(kind)) return json(res, 400, { error: "kind is copy or headline" }); mkdirSync(out, { recursive: true }); const d = addCopy(out, { kind, message, headline, description }, { offer: brief.offer, profile, offerDoc, locations: brief.locations || [] }); return view({ added: 1, draft: d }); }
        if (cid && req.method === "PUT") { const b = await readBody(req); const d = decideCopy(out, cid, { status: b.status, message: b.message, headline: b.headline, description: b.description }, { offer: brief.offer, profile, offerDoc, locations: brief.locations || [] }); return view({ draft: d }); }
      } catch (e) { return json(res, e.code === 190 || e.trace ? 502 : 400, { error: scrubTokens(e.message) }); }
    }
    // The central copy library (CL3): one file for every gym, read and changed from Library → Copy. GET lists every
    // entry, live and retired, with what the gyms' batches made from each (`uses`); POST adds a skeleton the owner
    // writes themselves (checked by the library's own rules: known placeholders only, Meta's lengths); PUT edits one,
    // retires it with a reason (never deleted) or restores it. The answer is always the whole listing.
    const lib = p.match(/^\/api\/library\/copy(?:\/([^/]+))?$/);
    if (lib) {
      const id = lib[1] ? decodeURIComponent(lib[1]) : null;
      const view = (extra = {}) => { const L = readCopyLibrary(); return json(res, 200, { entries: L.entries, counts: { copy: L.entries.filter((e) => !e.retired && e.kind === "copy").length, headline: L.entries.filter((e) => !e.retired && e.kind === "headline").length, retired: L.entries.filter((e) => e.retired).length, zh: L.entries.filter((e) => !e.retired && (e.language || copyLanguageOf(e.text)) === "zh").length }, uses: usesIn(BRANDS), angles: ANGLES, placeholders: LIBRARY_PLACEHOLDERS, ...extra }); };
      try {
        if (!id && req.method === "GET") return view();
        if (!id && req.method === "POST") { const { kind, text, description, angle, note } = await readBody(req); const e = addEntry(COPY_LIBRARY, { kind, text, description, angle, note }); return view({ entry: e }); }
        if (id && req.method === "PUT") {
          const b = await readBody(req);
          if (b.retired === true) return view({ entry: retireEntry(COPY_LIBRARY, id, b.reason) });
          if (b.retired === false) return view({ entry: restoreEntry(COPY_LIBRARY, id) });
          return view({ entry: editEntry(COPY_LIBRARY, id, { text: b.text, description: b.description, angle: b.angle, note: b.note }) });
        }
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // A gym's reference into the library on request: the account's imported ads are never sent on their own (only a
    // paste is), and a paste whose reading failed can be sent again. Two text calls at most; the reference remembers its ids.
    const crl = p.match(/^\/api\/client\/([^/]+)\/copy-refs\/([^/]+)\/library$/);
    if (crl && req.method === "POST") {
      const [, gym, rid] = crl;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym);
      try {
        const library = await sendToLibrary(dir, decodeURIComponent(rid), { gym });
        return json(res, 200, { refs: liveRefs(dir), retired: readCopyRefs(dir).refs.filter((r) => r.retired).length, shown: referencesFor(dir).map((r) => r.id), library });
      } catch (e) { return json(res, 400, { error: scrubTokens(String(e.message || e)).replace(/key=[^&\s]+/g, "key=…").slice(0, 300) }); }
    }
    const cr = p.match(/^\/api\/client\/([^/]+)\/copy-refs(?:\/([^/]+))?$/);
    if (cr) {
      const [, gym, rid] = cr;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym);
      const view = (extra = {}) => json(res, 200, { refs: liveRefs(dir), retired: readCopyRefs(dir).refs.filter((r) => r.retired).length, shown: referencesFor(dir).map((r) => r.id), ...extra });
      try {
        if (!rid && req.method === "GET") return view();
        if (!rid && req.method === "POST") {
          // A pasted copy is a reference for this gym AND goes to the central library as skeletons (its primary text
          // and its headline, the parts that change swapped for placeholders, verified in code) in the same step —
          // the owner's rule (2026-09-18): every upload is reusable at once. The reference's angle and note come
          // from that reading (or from a plain reading when no skeleton could be made); a model that cannot be
          // reached leaves the note empty and says so, the reference is kept either way.
          const { message, headline, description } = await readBody(req);
          let ref = addCopyRef(dir, { message, headline, description });
          const scrub = (e) => String(e?.message || e).replace(/key=[^&\s]+/g, "key=…").slice(0, 200);
          let library = { entries: [], skipped: [] };
          try { library = await sendToLibrary(dir, ref.id, { gym }); } catch (e) { library.skipped.push({ kind: "copy", why: scrub(e) }); }
          const read = library.entries.find((e) => e.kind === "copy") || library.entries[0];
          if (read) return view({ ref: editCopyRef(dir, ref.id, { note: read.note, angle: read.angle }), library });
          try { const a = await analyseCopy({ message: ref.message, headline: ref.headline }); return view({ ref: editCopyRef(dir, ref.id, { note: a.note, angle: a.angle }), library }); }
          catch (e) { return view({ ref, library, analysis_error: scrub(e) }); }
        }
        if (rid && req.method === "PUT") { const { note, retired } = await readBody(req); return view({ ref: editCopyRef(dir, decodeURIComponent(rid), { note, retired }) }); }
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const rv = p.match(/^\/api\/client\/([^/]+)\/batch\/([^/]+)\/(progress|review|picks|publish|results|results\/pull)$/);
    if (rv) {
      const [, gym, id, what] = rv;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (!okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
      const out = outDirOf(gym, id), dir = brandDir(gym);
      if (what === "progress" && req.method === "GET") {
        const prog = readJsonFile(join(out, "progress.json"));
        if (prog) for (const x of Object.values(prog.photos || {})) x.url = x.file ? fileUrl(gym, resolve(out, x.file)) : null;
        const brief = readJsonFile(briefPath(gym, id));
        return json(res, 200, { progress: prog, run: activeRun(gym, id), orphan: !activeRun(gym, id) && !!orphanBatch(gym, id), words: { offer: brief.offer, locations: brief.locations, audience: brief.audience ?? null }, made: existsSync(join(out, "batch.json")) });
      }
      // /publish — the plan for the kept ads (nothing created), the owner's settings for this batch, and what the
      // screen needs to change them: the profile's pins, the presets, the words. PUT saves settings, answers the new plan.
      if (what === "publish" && (req.method === "GET" || req.method === "PUT")) {
        if (!existsSync(join(out, "batch.json"))) return json(res, 409, { error: "the batch has no ads yet" });
        const settingsPath = join(out, "publish-settings.json");
        let settings = readJsonFile(settingsPath) || {};
        if (req.method === "PUT") {
          const body = await readBody(req);
          const err = settingsProblem(body);
          if (err) return json(res, 400, { error: err });
          settings = { ...body, updated: new Date().toISOString() };
          writeWhole(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        }
        // The Singapore identity: read from the account's own ad sets when the profile has none (GET only).
        const identity = req.method === "GET" ? await singaporeIdentityFor(gym) : null;
        const presets_import = req.method === "GET" ? await presetsAutoImport(gym) : null;
        const batch = readJsonFile(join(out, "batch.json")), presets = readPresets(dir);
        const kept = keptAds(out);
        // A callout with no pin: filled from the ad account's most-used pin before the plan is built (GET only).
        const pin_fill = req.method === "GET" ? await pinFillFor(gym, [...new Set(kept.map((a) => a.location).filter(Boolean))]) : null;
        const profile = readJsonFile(join(dir, "gym-profile.json")) || {};
        let plan;
        const library = targetingLibrary();
        try { plan = buildPlan({ profile, batch, kept, presets, settings, copies: keptCopies(out), headlines: keptCopies(out, "headline"), library }); } catch (e) { return json(res, 400, { error: e.message }); }
        const thumbs = Object.fromEntries(kept.map((a) => [a.folder, { url: fileUrl(gym, join(out, a.file)), story: a.story ? fileUrl(gym, join(out, a.story)) : null }]));
        return json(res, 200, { plan, settings, thumbs, identity, pin_fill, presets_import, offer: batch?.offer || batch?.ads?.[0]?.words?.offer || null, pins: profile.targeting_defaults?.geo?.radius_pins || [], presets: [...liveTargeting(library).filter((e) => e.approved_on).map((e) => ({ id: `lib:${e.id}`, name: e.name, summary: summarise(e.spec), cost_per_lead: null, group: "shared", audience: e.audience, role: e.role })), ...livePresets(presets).map((p) => ({ id: p.id, name: p.name, summary: p.summary, cost_per_lead: p.stats?.cost_per_lead ?? null, group: "account" }))], cta: Object.fromEntries(Object.keys(CTA_TYPES).map((k) => [k, ctaLabel(k, gymLanguage(profile))])), words: { offer: batch.ads?.[0]?.words?.offer || null, audience: batch.ads?.[0]?.words?.audience || null, locations: [...new Set(batch.ads.map((a) => a.location))], areas: [...new Set(batch.ads.map((a) => a.location))].map(titleCase) }, copy: { drafts: readCopy(out).drafts, flat: flatCopies(out).map((d) => d.id), references: referencesFor(dir).length, library: { copy: liveEntries(undefined, "copy").length, headline: liveEntries(undefined, "headline").length }, max_options: MAX_OPTIONS }, published: readJsonFile(join(out, "publish.json")) });
      }
      if (what === "results" && req.method === "GET") return json(res, 200, { results: readJsonFile(join(out, "results.json")), rows: batchRows(dir, id), record: readJsonFile(join(out, "publish.json")) });
      if (what === "results/pull" && req.method === "POST") {
        const rec = readJsonFile(join(out, "publish.json"));
        if (!rec?.campaign?.id) return json(res, 409, { error: "this batch has not been created on Meta yet" });
        const c = metaConfig({ gym });
        if (!c.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
        try {
          const r = await pullResults({ client: graphClient({ config: c }), record: rec, batchDir: out });
          writeGymCsv(dir);
          const every = allRows(dir);
          return json(res, 200, { results: r, rows: batchRows(dir, id), record: rec, campaigns: campaignRows(every), adsets: adsetRows(every) });
        } catch (e) { return json(res, 502, { error: scrubTokens(e.message) }); }
      }
      if (what === "review" && req.method === "GET") return json(res, 200, { ...reviewState(gym, id), words: (({ offer, locations, audience }) => ({ offer, locations, audience: audience ?? null }))(readJsonFile(briefPath(gym, id))), run: activeRun(gym, id) });
      if (what === "picks" && req.method === "PUT") {
        const change = await readBody(req);
        const err = savePicks(gym, id, change);
        if (err) return json(res, 400, { error: err });
        return json(res, 200, { ok: true, counts: reviewState(gym, id).counts });
      }
    }

    // /api/client/{gym}/batch-setup · /batch/check · /batch · /batch/{id}
    const bm = p.match(/^\/api\/client\/([^/]+)\/(batch-setup|batch|batch\/check|batch\/([^/]+))$/);
    if (bm) {
      const [, gym, what, id] = bm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (what === "batch-setup" && req.method === "GET") { const dm = (readJsonFile(join(brandDir(gym), "gym-profile.json")) || {}).targeting_defaults?.demographics || {}; return json(res, 200, { photos: cleanPhotos(gym).filter((x) => !x.people), scenes: sceneStatus(gym), batches: listBatches(gym), maxLocations: MAX_LOCATIONS, wordings: readWordings(brandDir(gym)), creative_defaults: profileView(gym).creative_defaults, photo_ages: [Number.isInteger(dm.age_min) ? dm.age_min : 25, Number.isInteger(dm.age_max) ? dm.age_max : 60] }); }
      if (what === "batch/check" && req.method === "POST") { const { brief } = await readBody(req); return json(res, 200, checkBrief(gym, brief)); }
      if (what === "batch" && req.method === "POST") {
        const { brief: raw, replace = false } = await readBody(req);
        const { errors, summary, brief } = checkBrief(gym, raw); // the brief as saved: the spread resolved to must_show
        if (errors.length) return json(res, 400, { errors });
        const path = briefPath(gym, brief.batch_id);
        const prior = readJsonFile(path);
        if (prior && !replace) return json(res, 409, { errors: [`a batch called ${brief.batch_id} already exists`] });
        // A batch that already has photos may only change its words (a free re-render); anything else
        // needs a new batch, so photos are never silently regenerated or orphaned.
        if (prior && existsSync(join(brandDir(gym), "outputs", brief.batch_id, "batch.json")) && !sameExceptWords(prior, brief)) {
          return json(res, 409, { errors: ["this batch already has photos, so only its words can change — start a new batch to change photos or counts"] });
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(brief, null, 2) + "\n");
        return json(res, 200, { ok: true, batch_id: brief.batch_id, summary });
      }
      // A planned batch (a brief with no ads yet) can be discarded; one with ads never can, from here.
      if (id && req.method === "DELETE") {
        if (!okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
        if (existsSync(join(brandDir(gym), "outputs", id, "batch.json"))) return json(res, 409, { error: "this batch has ads; it is not deleted from the panel" });
        if (activeRun(gym, id) || orphanBatch(gym, id)) return json(res, 409, { error: "this batch is being made right now: stop it first" });
        // A stopped run's photos were paid for: they are set aside, never deleted. A plan's notes alone are removed.
        const outs = join(brandDir(gym), "outputs", id), vis = join(outs, "visuals");
        const photos = existsSync(vis) ? readdirSync(vis).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).length : 0;
        let kept = null;
        if (photos) {
          kept = join("outputs", "_discarded", `${id}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`);
          mkdirSync(join(brandDir(gym), "outputs", "_discarded"), { recursive: true });
          renameSync(outs, join(brandDir(gym), kept));
        } else rmSync(outs, { recursive: true, force: true });
        rmSync(join(brandDir(gym), "batches", id), { recursive: true, force: true });
        return json(res, 200, { ok: true, photos, kept });
      }
      if (id && req.method === "GET") {
        if (!okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
        const out = join(brandDir(gym), "outputs", id);
        const batch = readJsonFile(join(out, "batch.json"));
        return json(res, 200, {
          brief: readJsonFile(briefPath(gym, id)),
          batch: batch && { ...batch, ads: batch.ads.map((a) => ({ ...a, url: `/files/brands/${gym}/outputs/${id}/${a.file}` })) },
          gallery: existsSync(join(out, "gallery.html")) ? `/files/brands/${gym}/outputs/${id}/gallery.html` : null,
          selected: existsSync(join(out, "selections.json")),
          stories: (() => { const s = readJsonFile(join(out, "stories.json")); return s ? { ads: s.ads.length, image_calls: s.image_calls, max_calls: s.max_calls, left_out: (s.failed?.length || 0) + (s.left_out?.length || 0) } : null; })(),
          scenes: batchScenes(gym, id), // what the direction drafted for this batch (drafts until the run is confirmed)
        });
      }
    }

    // /api/client/{gym}[/offer/{slug}]
    const m = p.match(/^\/api\/client\/([^/]+)(?:\/offer\/([^/]+))?$/);
    if (m) {
      const [, gym, offerSlug] = m;
      if (!okSlug(gym) || (offerSlug && !okSlug(offerSlug))) return json(res, 400, { error: "bad slug" });
      const dir = join(BRANDS, gym);
      if (!existsSync(dir)) return json(res, 404, { error: `no client "${gym}"` });

      if (req.method === "GET") {
        if (offerSlug) {
          const o = readJsonFile(join(dir, "offers", `${offerSlug}.json`));
          return o ? json(res, 200, o) : json(res, 404, { error: "offer not found" });
        }
        return json(res, 200, profileView(gym));
      }

      if (req.method === "PUT") {
        const body = await readBody(req);
        if (offerSlug) {
          mkdirSync(join(dir, "offers"), { recursive: true });
          writeFileSync(join(dir, "offers", `${offerSlug}.json`), JSON.stringify(body, null, 2) + "\n");
        } else {
          const { errors, warnings } = validateProfile(body, { gymDir: dir });
          if (errors.length) return json(res, 400, { error: errors[0], errors, warnings });
          // A pin with a postal code and no point is placed here, so it can be targeted (said back to the page).
          const pins = await fillPinPoints(body);
          writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ ...body, schema_version: Math.max(PROFILE_SCHEMA, Number(body.schema_version) || 0) }, null, 2) + "\n");
          return json(res, 200, { ok: true, warnings: [...warnings, ...pins.warnings], placed: pins.placed, ...profileView(gym) });
        }
        return json(res, 200, { ok: true });
      }
    }

    if (p === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      const { kind } = body;
      if (!RUNNABLE[kind]) return json(res, 400, { error: `unknown command "${kind}"` });
      for (const k of ["gym", "offer", "version", "batch"]) if (body[k] && !okSlug(body[k])) return json(res, 400, { error: `bad ${k}` });
      const spec = RUNNABLE[kind];
      if (kind === "scenes-refresh") {
        // A gym without a library yet: the first refresh starts it (the owner's first approval approves it).
        if (!okSlug(body.gym) || !existsSync(join(brandDir(body.gym), "gym-profile.json"))) return json(res, 400, { error: "a refresh needs a client with a profile" });
        if (!AUDIENCES.includes(body.audience)) return json(res, 400, { error: `audience must be one of ${AUDIENCES.join(", ")}` });
        if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_REFRESH_COUNT) return json(res, 400, { error: `count must be 1 to ${MAX_REFRESH_COUNT}` });
        if (body.words != null && (typeof body.words !== "string" || body.words.trim().length < 3 || body.words.length > MAX_WORDS)) return json(res, 400, { error: `words must describe the pictures wanted, up to ${MAX_WORDS} characters` });
        if (body.reference != null && (!REFERENCE_NAME.test(String(body.reference)) || !existsSync(join(referencesDir(body.gym), body.reference)))) return json(res, 400, { error: "reference must name an uploaded reference image" });
        const run = startRun(kind, { gym: body.gym, audience: body.audience, count: body.count, words: body.words?.trim() || null, reference: body.reference || null });
        return json(res, 200, { id: run.id, label: run.label });
      }
      if (kind === "website-read") {
        if (!okSlug(body.gym) || !existsSync(join(brandDir(body.gym), "gym-profile.json"))) return json(res, 400, { error: "reading a website needs a client with a profile" });
        let url;
        try { if (typeof body.url !== "string" || body.url.length > 300) throw new Error("give the gym's web address (up to 300 characters)"); url = checkSiteUrl(body.url, { allowLocal: ALLOW_LOCAL_SITES }).href; }
        catch (e) { return json(res, 400, { error: e.message }); }
        const run = startRun(kind, { gym: body.gym, url });
        return json(res, 200, { id: run.id, label: run.label });
      }
      if (kind === "instagram-read") {
        if (!okSlug(body.gym) || !existsSync(join(brandDir(body.gym), "gym-profile.json"))) return json(res, 400, { error: "reading Instagram needs a client with a profile" });
        const handle = cleanHandle(body.handle);
        if (!handle) return json(res, 400, { error: "give the gym's Instagram handle (letters, digits, dots and underscores)" });
        const posts = body.posts == null ? DEFAULT_POSTS : body.posts;
        if (!Number.isInteger(posts) || posts < 25 || posts > MAX_POSTS) return json(res, 400, { error: `how many posts to read must be 25 to ${MAX_POSTS}` });
        if (!metaConfig({ gym: body.gym }).token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page): Instagram is read through it" });
        const run = startRun(kind, { gym: body.gym, handle, posts });
        return json(res, 200, { id: run.id, label: run.label });
      }
      if (kind === "photo-survey" || kind === "photo-clean") {
        if (!okSlug(body.gym) || !existsSync(brandDir(body.gym))) return json(res, 400, { error: "bad gym" });
        const photos = Array.isArray(body.photos) ? body.photos : [];
        if (!photos.length || photos.length > MAX_CLEAN_PHOTOS) return json(res, 400, { error: `choose 1 to ${MAX_CLEAN_PHOTOS} photos` });
        const kinds = new Set();
        for (const ph of photos) {
          const [kind, name] = typeof ph === "string" && ph.includes("/") ? ph.split("/") : ["facility", ph];
          if (typeof name !== "string" || !CLEAN_KINDS.has(kind) || !ASSET_FILE.test(name) || !ASSET_NAME.test(name) || ph.split("/").length > 2 || !existsSync(join(assetsDir(body.gym), kind, name))) return json(res, 400, { error: `${JSON.stringify(ph)} is not one of the premises, coach or member photos` });
          kinds.add(kind === "facility" ? "premises" : "people");
        }
        if (kinds.size > 1) return json(res, 400, { error: "clean premises photos and people photos in separate runs: cleaned premises photos become real-photo ads, cleaned people photos only a room reference" });
        const params = { gym: body.gym, photos };
        if (kind === "photo-clean") {
          const cap = body.confirm?.max_calls;
          if (!Number.isInteger(cap) || cap < photos.length || cap > MAX_CALLS_CAP) return json(res, 400, { error: `confirm the call cap for the clean-up (${photos.length}–${MAX_CALLS_CAP}: at least one call per photo)` });
          params.confirm = { max_calls: cap };
        }
        const run = startRun(kind, params);
        return json(res, 200, { id: run.id, label: run.label });
      }
      if (spec.needsBrief) {
        if (!okSlug(body.gym) || !okSlug(body.batch)) return json(res, 400, { error: "a batch run needs gym and batch" });
        const brief = readJsonFile(briefPath(body.gym, body.batch));
        if (!brief) return json(res, 404, { error: `no brief for batch ${body.batch}` });
        // A directed batch: the scenes its plan drafted are approved by this confirmation — only when
        // the ids confirmed are exactly the drafts on disk now, so what runs is what was read.
        delete body.approveScenes;
        if (kind === "batch" && brief.direction) {
          const mine = batchScenes(body.gym, body.batch), pending = mine.filter((s) => s.draft).map((s) => s.id).sort();
          if (!mine.length) return json(res, 409, { error: "plan first: the plan drafts this batch's scenes for you to read before anything is generated" });
          if (pending.length) {
            const agreed = [body.confirm?.scenes].flat().filter(Boolean).map(String).sort();
            if (JSON.stringify(agreed) !== JSON.stringify(pending)) return json(res, 409, { error: "the batch's drafted scenes differ from what was confirmed — plan again, read them, and confirm" });
            body.approveScenes = true;
          }
        }
        // A run that spends must have been confirmed against the brief as it is on disk now: the words
        // and the call cap the person agreed to are exactly what will run.
        if (spec.spends === "stories") {
          // The cap is the one number the person confirms; the words are the batch's own. Nothing runs
          // until the gallery's picks are in the batch folder.
          const cap = body.confirm?.max_calls;
          if (!Number.isInteger(cap) || cap < 0 || cap > MAX_CALLS_CAP) return json(res, 400, { error: `confirm the call cap for the Stories versions (0–${MAX_CALLS_CAP})` });
          if (!existsSync(join(brandDir(body.gym), "outputs", body.batch, "selections.json"))) return json(res, 409, { error: "no picks yet: review the batch and keep or exclude its ads first" });
          // One ad's Stories version (2026-10-07): `only` names a candidate of this batch; its photo is tried again
          // even where earlier attempts failed, and the other ads' versions are left as they are.
          if (body.only != null) {
            const b = readJsonFile(join(brandDir(body.gym), "outputs", body.batch, "batch.json"));
            if (typeof body.only !== "string" || !/^c\d{2,3}$/.test(body.only) || !(b?.ads || []).some((a) => a.candidate === body.only)) return json(res, 400, { error: "only must name one of this batch's ads (its candidate, such as c11)" });
          }
        } else if (spec.spends === "publish") {
          const c = body.confirm || {}, out = join(brandDir(body.gym), "outputs", body.batch);
          if (!existsSync(join(out, "batch.json"))) return json(res, 409, { error: "the batch has no ads yet" });
          const cfg = metaConfig({ gym: body.gym });
          if (!cfg.token) return json(res, 409, { error: "the Meta link is not set up yet (Meta link page)" });
          let plan;
          try { plan = buildPlan({ library: targetingLibrary(), profile: readJsonFile(join(brandDir(body.gym), "gym-profile.json")) || {}, batch: readJsonFile(join(out, "batch.json")), kept: keptAds(out), presets: readPresets(brandDir(body.gym)), settings: readJsonFile(join(out, "publish-settings.json")) || {}, copies: keptCopies(out), headlines: keptCopies(out, "headline") }); }
          catch (e) { return json(res, 400, { error: e.message }); }
          if (!plan.ready) return json(res, 409, { error: `the plan has problems: ${plan.problems.join("; ")}` });
          const agreed = c.ads === plan.counts.ads && c.adsets === plan.counts.adsets && c.per_day === plan.budget.per_day_total;
          if (!agreed) return json(res, 409, { error: "the plan differs from what was confirmed (ads, ad sets or the day's budget) — read the Publish screen again and confirm" });
          if (c.first != null && !(Number.isInteger(c.first) && c.first >= 1 && c.first <= plan.counts.ads)) return json(res, 400, { error: `"first" is a whole number of ads, 1 to ${plan.counts.ads}` });
          body.confirm = { first: c.first ?? null };
        } else if (spec.spends) {
          const c = body.confirm || {};
          const agreed = c.offer === brief.offer && JSON.stringify(c.locations) === JSON.stringify(brief.locations) && (c.audience ?? null) === (brief.audience ?? null) && c.max_calls === (brief.max_calls ?? brief.generated ?? 0);
          if (!agreed) return json(res, 409, { error: "the brief on disk differs from what was confirmed — review it and confirm again" });
        }
      }
      const run = startRun(kind, body);
      if ((kind === "batch" || kind === "batch-rerender") && body.gym && body.batch) {
        try { const b = readJsonFile(briefPath(body.gym, body.batch)); if (b?.offer) recordUse(brandDir(body.gym), b.offer); } catch {}
      }
      return json(res, 200, { id: run.id, label: run.label });
    }

    // Stop a run by its id (the log's Stop), or whatever is working on a batch (the Generating screen's).
    const stopM = p.match(/^\/api\/run\/([A-Za-z0-9-]+)\/stop$/);
    if (stopM && req.method === "POST") {
      const run = runs.get(stopM[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      try { return json(res, 200, stopRun(run)); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }
    const stopB = p.match(/^\/api\/client\/([^/]+)\/batch\/([^/]+)\/stop$/);
    if (stopB && req.method === "POST") {
      const [, gym, id] = stopB;
      if (!okSlug(gym) || !okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
      try { return json(res, 200, await stopBatch(gym, id)); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }

    // A run's state by id (2026-10-10): a page whose stream dropped asks this instead of guessing. A run the panel does
    // not know (it restarted since) is `gone` — over as far as the page is concerned; what it finished is on disk.
    const rstate = p.match(/^\/api\/run\/([A-Za-z0-9-]+)$/);
    if (rstate && req.method === "GET") {
      const run = runs.get(rstate[1]);
      if (!run) return json(res, 404, { error: "no such run: the panel has restarted since it was started, or it never existed", gone: true });
      return json(res, 200, { id: run.id, kind: run.kind, label: run.label, gym: run.gym, batch: run.batch, done: run.done, code: run.code, stopped: !!run.stopped, lines: run.lines.length });
    }
    const rm = p.match(/^\/api\/run\/([A-Za-z0-9-]+)\/stream$/);
    if (rm) {
      const run = runs.get(rm[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const entry of run.lines) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      if (run.done) { res.write(`event: done\ndata: ${JSON.stringify({ code: run.code })}\n\n`); return res.end(); }
      run.clients.add(res);
      req.on("close", () => run.clients.delete(res));
      return;
    }

    // Generated artefacts (galleries, swipe reviews, their images) and brand images — nothing else.
    if (p.startsWith("/files/")) {
      let rel;
      try { rel = decodeURIComponent(p.slice("/files/".length)); } catch { return json(res, 400, { error: "bad path" }); }
      const abs = allowedFile(rel);
      if (!abs) return json(res, 404, { error: "not found" });
      return sendFile(res, abs);
    }

    if (p === "/api/artifacts") {
      const out = [];
      for (const c of listClients()) {
        for (const v of c.outputs) {
          const g = join(BRANDS, c.gym, "outputs", v, "gallery.html");
          if (existsSync(g)) out.push({ gym: c.gym, version: v, url: `/files/brands/${c.gym}/outputs/${v}/gallery.html` });
        }
      }
      for (const niche of existsSync(SWIPE) ? readdirSync(SWIPE) : []) {
        const r = join(SWIPE, niche, "swipe-report.html");
        if (existsSync(r)) out.push({ gym: `swipe/${niche}`, version: "review", url: `/files/swipe/${niche}/swipe-report.html` });
      }
      return json(res, 200, { artifacts: out });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

const shutdown = async () => { try { if (browserP) await (await browserP).close(); } catch {} process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Local only. This exposes the filesystem and can spawn processes — it must never bind publicly.
server.listen(PORT, "127.0.0.1", () => {
  PORT = server.address().port; // --port 0 picks a free port (tests); the Host and Origin checks use the real one
  console.log(`Gym Ads control panel → http://localhost:${PORT}`);
});
