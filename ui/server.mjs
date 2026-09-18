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
  loadClientConfig, writeResolved, scaffold, validateProfile, profileCompleteness, PROFILE_SCHEMA, CREATIVE_DEFAULTS, PALETTE_MODES,
  catalogueFor, brandPalettes, META_ID, CTA_ENUM, OFFER_TYPES, PRICE_QUALIFIERS,
} from "../skills/references/client-config.mjs";
import { imageSize } from "../skills/references/check-visual.mjs";
import { metaConfig, graphClient, checkLink, META_API_VERSION, META_PERMISSIONS, META_ENV_KEYS, scrubTokens } from "../skills/references/meta-api.mjs";
import { readWordings, addWording, editWording, deleteWording, recordUse, wordingProblems } from "../skills/references/ad-wordings.mjs";
import { buildPlan, keptAds, CTA_TYPES } from "../skills/references/meta-publish.mjs";
import { readPresets, livePresets, importPresets, renamePreset, retirePreset, restorePreset, addPreset, rankPresets, specProblems, summarise, normaliseSpec } from "../skills/references/meta-targeting.mjs";
import { validateBrief, sceneAudience, MAX_LOCATIONS, MAX_CALLS_CAP } from "../skills/references/plan-offer-batch.mjs";
import { libraryStatus, readLibrary, approveScenes, rejectScene, isDraft, isRetired, AUDIENCES } from "../skills/references/scene-library.mjs";
import { IMAGE_EXT as REFERENCE_EXT, MAX_WORDS, REFERENCES_DIR } from "../skills/references/refresh-scenes.mjs";
import { launchBrowser, renderComposite, validateInputs } from "../skills/references/render-composites.mjs";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "..");
const BRANDS = resolve(process.env.PANEL_BRANDS_DIR || join(REPO_ROOT, "brands"));
const SWIPE = join(REPO_ROOT, "swipe");
const BATCH_SCRIPT = join(REPO_ROOT, "skills", "references", "plan-offer-batch.mjs");
const STORIES_SCRIPT = join(REPO_ROOT, "skills", "references", "make-stories.mjs");
const REFRESH_SCRIPT = join(REPO_ROOT, "skills", "references", "refresh-scenes.mjs");
const CLEAN_SCRIPT = join(REPO_ROOT, "skills", "references", "clean-photo.mjs");
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
  validate: {
    label: "Validate config",
    argv: ({ gym, offer }) => ["skills/references/client-config.mjs", "--gym", gym, "--offer", offer],
  },
  prompts: {
    label: "Generate prompts (Phase 2)",
    argv: ({ gym, offer }) => ["skills/references/client-config.mjs", "--gym", gym, "--offer", offer, "--json"],
    note: "Phase 2 prompt generation is still driven by the /static-ads skill; this resolves the brief it reads.",
  },
  images: {
    label: "Generate images (Phase 3)",
    argv: ({ gym, templates, numImages, ratios }) => {
      const a = ["skills/references/generate_ads_gemini.mjs", "--brand-dir", brandDir(gym)];
      if (templates) a.push("--templates", templates);
      if (numImages) a.push("--num-images", String(numImages));
      if (ratios) a.push("--ratios", ratios);
      return a;
    },
  },
  gallery: {
    label: "Rebuild gallery",
    argv: ({ gym, version }) => ["skills/references/gallery-selector.mjs", "--output-dir", join(brandDir(gym), "outputs", version)],
  },
  checksync: { label: "Check skill/command sync", argv: () => ["skills/references/check-sync.mjs"] },
  // Offer-first batches (Step 6). Built from the gym and batch id only; the brief is the file on disk.
  "batch-plan": { label: "Plan batch (free)", needsBrief: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), "--dry-run"] },
  // A directed batch's drafted scenes are approved by the Run confirmation (approveScenes is set by the
  // server once the confirmed ids match the drafts on disk — never taken from the browser).
  batch: { label: "Run batch", needsBrief: true, spends: true, argv: ({ gym, batch, approveScenes }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), ...(approveScenes === true ? ["--approve-scenes"] : [])] },
  "batch-rerender": { label: "Re-render batch with its words (free)", needsBrief: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), "--render-only"] },
  // Stories/Reels (9:16) versions of the selected ads (Step 8): the batch id and the confirmed call cap only.
  "batch-stories": { label: "Make Stories versions", needsBrief: true, spends: "stories", argv: ({ gym, batch, confirm }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--max-calls", String(confirm.max_calls)] },
  "batch-stories-rerender": { label: "Re-render Stories versions (free)", needsBrief: true, argv: ({ gym, batch }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--render-only"] },
  // A scene refresh (text calls only): the audience, the count and the direction — words and/or an
  // uploaded reference image — each checked for shape before it becomes an argument.
  "scenes-refresh": { label: "Refresh scenes (drafts for approval)", argv: ({ gym, audience, count, words, reference }) => [REFRESH_SCRIPT, "--brand-dir", brandDir(gym), "--audience", audience, "--count", String(count), ...(words ? ["--words", words] : []), ...(reference ? ["--reference", reference] : [])] },
  // The premises photos' clean-up (Step 5): a free survey of what an edit would remove, and the edit
  // itself under a confirmed call cap. Photos are names in brand-assets/facility, checked before they
  // become arguments; the clean copies land in brand-assets/facility-clean as the CLI's do.
  "photo-survey": { label: "Survey premises photos (free)", argv: ({ gym, photos }) => [CLEAN_SCRIPT, "--brand-dir", brandDir(gym), "--survey-only", ...photos.flatMap((p) => ["--photo", join(brandDir(gym), "brand-assets", "facility", p)])] },
  "photo-clean": { label: "Clean premises photos", spends: "clean", argv: ({ gym, photos, confirm }) => [CLEAN_SCRIPT, "--brand-dir", brandDir(gym), "--max-calls", String(confirm.max_calls), "--attempts", "2", ...photos.flatMap((p) => ["--photo", join(brandDir(gym), "brand-assets", "facility", p)])] },
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
        ...(k.id === "facility" ? { cleaned: cleanStems.has(stem(f)) } : {}), ...(k.id === "logo" ? { in_use: logo === path || logo === f } : {}) });
    }
  }
  return out;
}

const fail = (status, message) => Object.assign(new Error(message), { status });
/** Keep an uploaded file as one of the gym's assets: an image by its first bytes (an iPhone's HEIC
 *  is converted here; an SVG only as a logo, and only a plain one), named as asked, never twice. */
function saveAsset(gym, kindId, name, buf, originalName = null) {
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
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const manifest = readManifest(gym);
  const dup = manifest.assets.find((a) => a.sha256 === sha256 && !a.removed && existsSync(join(assetsDir(gym), a.path)));
  if (dup) throw fail(409, `this file is already here as ${dup.path}`);
  const dir = join(assetsDir(gym), kind.folder);
  mkdirSync(dir, { recursive: true });
  let final = name, n = 2;
  while (existsSync(join(dir, final))) final = `${stem(name)}-${n++}${extname(name)}`;
  writeFileSync(join(dir, final), buf);
  const row = { path: `${kind.folder}/${final}`, kind: kind.id, original_name: originalName || name, sha256, bytes: buf.length, size: found === "svg" ? null : sizeOf(buf), source: "upload", added: new Date().toISOString().slice(0, 10) };
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
        to_do: profile ? profileCompleteness(profile, { gymDir: dir, cleanPhotos: cleanPhotos(gym).length, scenes: sceneStatus(gym), wordings: readWordings(dir).length }).to_do : null,
        offers,
        outputs,
        asset_counts: countAssets(dir),
      };
    });
}

/** A profile as the panel shows it: the file, how finished it is, and its Create defaults filled in. */
function profileView(gym) {
  const dir = brandDir(gym), profile = readJsonFile(join(dir, "gym-profile.json"));
  const completeness = profileCompleteness(profile, { gymDir: dir, cleanPhotos: cleanPhotos(gym).length, scenes: sceneStatus(gym), wordings: readWordings(dir).length });
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
    .map((path) => ({ path, url: `/files/brands/${gym}/brand-assets/${path}` }));
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
      review: batch ? (() => { const c = reviewState(gym, id).counts; return { kept: c.kept, excluded: c.excluded, unreviewed: c.unreviewed }; })() : null,
      running: activeRun(gym, id),
    };
  });
}

/** The brief's problems (Step 6 rules, plus the scene library) and what it would make. */
function checkBrief(gym, brief) {
  const errors = validateBrief(brief, { brandDir: brandDir(gym) });
  const g = brief?.generated ?? 0, real = Array.isArray(brief?.real) ? brief.real : [];
  const scenes = sceneStatus(gym);
  const audienceFor = sceneAudience(brief?.audience, brief?.scene_audience);
  if (g > 0 && !brief?.scenes) {
    if (!scenes.exists) errors.push("no scene library for this client: generated photos need one (brands/{gym}/scenes.json)");
    else if (!scenes.approved) errors.push("the scene library is not approved yet — nothing is generated from it until the owner approves it");
    else if (audienceFor !== "any" && !(scenes.counts[audienceFor] || scenes.counts.any)) errors.push(`the scene library has no scenes for a "${audienceFor}" audience`);
  }
  const photos = g + real.length, looks = brief?.looks_per_photo ?? 2, locs = Array.isArray(brief?.locations) ? brief.locations.length : 0;
  return { errors, summary: { photos, generated: g, real: real.length, looks, locations: locs, ads: photos * looks * locs, max_calls: brief?.max_calls ?? g, scenes_for: audienceFor } };
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
  const d = readDecisions(gym, id);
  const ads = (batch?.ads || []).map((a) => {
    const s = storyOf.get(a.folder);
    return {
      folder: a.folder, number: Number(a.folder.split("-")[0]), candidate: a.candidate, location: a.location, treatment: a.treatment, style: a.style, palette: a.palette,
      photos: a.photos, url: fileUrl(gym, join(out, a.file)), story: s ? fileUrl(gym, join(out, s.file)) : null, notes: notes[a.folder] || null, own: d.ads[a.folder] || null, ...standing(a, d),
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
  for (const k of Object.keys(b)) if (!["campaign", "adsets", "words", "destination", "updated"].includes(k)) return `unknown setting "${k}"`;
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
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env });
  child.stdout.on("data", (d) => push(d, "out"));
  child.stderr.on("data", (d) => push(d, "err"));
  child.on("error", (e) => push(`spawn failed: ${e.message}`, "err"));
  child.on("close", (code) => {
    if (code === 0 && ["batch", "batch-rerender", "batch-stories", "batch-stories-rerender"].includes(kind) && run.gym && run.batch) {
      const out = outDirOf(run.gym, run.batch);
      try { if (existsSync(join(out, "review.json")) || existsSync(join(out, "selections.json"))) savePicks(run.gym, run.batch, {}); } catch (e) { push(`picks not refreshed: ${e.message}`, "err"); }
    }
    run.done = true;
    run.code = code;
    push(code === 0 ? "✓ finished" : `✗ exited with code ${code}`, "meta");
    for (const res of run.clients) { res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); }
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
  else if (parts[0] === "swipe" && parts.length >= 3 && (ext === ".html" || IMAGE_EXT.has(ext))) base = SWIPE;
  if (!base) return null;
  const abs = parts[0] === "brands" ? join(base, ...parts.slice(3)) : join(SWIPE, ...parts.slice(1));
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
      const q = (url.searchParams.get("q") || "").trim();
      if (!q || q.length > 120 || /[\r\n]/.test(q)) return json(res, 400, { error: "give an address or a 6-digit postal code" });
      try {
        const r = await fetch(`${ONEMAP_URL}/api/common/elastic/search?${new URLSearchParams({ searchVal: q, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" })}`, { headers: { accept: "application/json" } });
        const b = await r.json();
        const results = (Array.isArray(b.results) ? b.results : []).map((x) => ({ address: String(x.ADDRESS || x.SEARCHVAL || ""), postal_code: /^\d{6}$/.test(String(x.POSTAL || "")) ? String(x.POSTAL) : null, lat: Number(x.LATITUDE), lng: Number(x.LONGITUDE) })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 8);
        return json(res, 200, { results });
      } catch (e) { return json(res, 502, { error: `OneMap could not be reached (${e.message})` }); }
    }
    // /api/client/{gym}/targeting[/{id}] — the detailed-targeting presets: imported from the account's own ad sets
    // (with what they cost and brought), its saved audiences, or built by the owner from Meta's search.
    const tg = p.match(/^\/api\/client\/([^/]+)\/targeting(?:\/([^/]+))?$/);
    if (tg) {
      const gym = tg[1], id = tg[2] ? decodeURIComponent(tg[2]) : null;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const dir = brandDir(gym);
      const view = (extra = {}) => { const d = readPresets(dir); return { account: d.account, imported: d.imported, presets: livePresets(d), retired: d.presets.filter((x) => x.retired), ...extra }; };
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
      const { gym, offer, display_name = "" } = await readBody(req);
      if (!okSlug(gym)) return json(res, 400, { error: "the folder name must be lowercase letters, numbers and hyphens" });
      if (offer && !okSlug(offer)) return json(res, 400, { error: "offer slug must be lowercase letters, numbers and hyphens" });
      if (typeof display_name !== "string" || display_name.length > 80 || /[—–\r\n]/.test(display_name)) return json(res, 400, { error: "the gym's name must be one line, without em/en dashes" });
      const fresh = !existsSync(join(brandDir(gym), "gym-profile.json"));
      scaffold(gym, offer || null, { brandsDir: BRANDS, displayName: display_name.trim() });
      return json(res, 200, { ok: true, gym, offer: offer || null, created: fresh });
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

    // /api/client/{gym}/assets · /asset/{kind}/{name} — the gym's own files, from the panel's drop zone.
    const am = p.match(/^\/api\/client\/([^/]+)\/(assets|asset\/([a-z]+)\/([^/]+))$/);
    if (am) {
      const [, gym, what, kind, name] = am;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (what === "assets" && req.method === "GET") return json(res, 200, { kinds: ASSET_KINDS, assets: listAssets(gym), clean: cleanPhotos(gym), heic: hasSips(), max_bytes: MAX_ASSET_BYTES, max_clean: MAX_CLEAN_PHOTOS });
      if (kind && req.method === "PUT") {
        let buf;
        try { buf = await readRaw(req, MAX_ASSET_BYTES); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
        try {
          const original = req.headers["x-original-name"] ? decodeURIComponent(String(req.headers["x-original-name"])).slice(0, 200) : null;
          const row = saveAsset(gym, kind, name, buf, original);
          return json(res, 200, { ok: true, asset: { ...row, url: `/files/brands/${gym}/brand-assets/${row.path}` } });
        } catch (e) { return json(res, e.status || 400, { error: e.message }); }
      }
      if (kind && req.method === "DELETE") {
        try { return json(res, 200, removeAsset(gym, kind, name)); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
      }
    }

    // /api/client/{gym}/scenes · /scenes/approve · /scenes/reject · /reference/{name}
    const sm = p.match(/^\/api\/client\/([^/]+)\/(scenes|scenes\/approve|scenes\/reject|reference\/([^/]+))$/);
    if (sm) {
      const [, gym, what, name] = sm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      const scenesPath = join(brandDir(gym), "scenes.json");
      if (what === "scenes" && req.method === "GET") return json(res, 200, { status: sceneStatus(gym), drafts: sceneDrafts(gym), references: listReferences(gym), audiences: AUDIENCES, maxCount: MAX_REFRESH_COUNT, maxWords: MAX_WORDS });
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
    const rv = p.match(/^\/api\/client\/([^/]+)\/batch\/([^/]+)\/(progress|review|picks|publish)$/);
    if (rv) {
      const [, gym, id, what] = rv;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (!okSlug(id) || !existsSync(briefPath(gym, id))) return json(res, 404, { error: "no such batch" });
      const out = outDirOf(gym, id), dir = brandDir(gym);
      if (what === "progress" && req.method === "GET") {
        const prog = readJsonFile(join(out, "progress.json"));
        if (prog) for (const x of Object.values(prog.photos || {})) x.url = x.file ? fileUrl(gym, resolve(out, x.file)) : null;
        const brief = readJsonFile(briefPath(gym, id));
        return json(res, 200, { progress: prog, run: activeRun(gym, id), words: { offer: brief.offer, locations: brief.locations, audience: brief.audience ?? null }, made: existsSync(join(out, "batch.json")) });
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
        const profile = readJsonFile(join(dir, "gym-profile.json")) || {};
        const batch = readJsonFile(join(out, "batch.json")), presets = readPresets(dir);
        const kept = keptAds(out);
        let plan;
        try { plan = buildPlan({ profile, batch, kept, presets, settings }); } catch (e) { return json(res, 400, { error: e.message }); }
        const thumbs = Object.fromEntries(kept.map((a) => [a.folder, { url: fileUrl(gym, join(out, a.file)), story: a.story ? fileUrl(gym, join(out, a.story)) : null }]));
        return json(res, 200, { plan, settings, thumbs, pins: profile.targeting_defaults?.geo?.radius_pins || [], presets: livePresets(presets).map((p) => ({ id: p.id, name: p.name, summary: p.summary, cost_per_lead: p.stats?.cost_per_lead ?? null })), cta: CTA_TYPES, words: { offer: batch.ads?.[0]?.words?.offer || null, locations: [...new Set(batch.ads.map((a) => a.location))] }, published: readJsonFile(join(out, "publish.json")) });
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
      if (what === "batch-setup" && req.method === "GET") return json(res, 200, { photos: cleanPhotos(gym), scenes: sceneStatus(gym), batches: listBatches(gym), maxLocations: MAX_LOCATIONS, wordings: readWordings(brandDir(gym)), creative_defaults: profileView(gym).creative_defaults });
      if (what === "batch/check" && req.method === "POST") { const { brief } = await readBody(req); return json(res, 200, checkBrief(gym, brief)); }
      if (what === "batch" && req.method === "POST") {
        const { brief, replace = false } = await readBody(req);
        const { errors, summary } = checkBrief(gym, brief);
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
        rmSync(join(brandDir(gym), "batches", id), { recursive: true, force: true });
        rmSync(join(brandDir(gym), "outputs", id), { recursive: true, force: true }); // a plan's notes, if any
        return json(res, 200, { ok: true });
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
          writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ ...body, schema_version: Math.max(PROFILE_SCHEMA, Number(body.schema_version) || 0) }, null, 2) + "\n");
          return json(res, 200, { ok: true, warnings, ...profileView(gym) });
        }
        return json(res, 200, { ok: true });
      }
    }

    if (p === "/api/validate" && req.method === "POST") {
      const { gym, offer } = await readBody(req);
      if (!okSlug(gym) || !okSlug(offer)) return json(res, 400, { error: "bad slug" });
      try {
        const { resolved, errors, warnings, gymDir } = loadClientConfig(gym, offer);
        if (!errors.length) writeResolved(gymDir, offer, resolved);
        return json(res, 200, { errors, warnings, resolved: errors.length ? null : resolved });
      } catch (e) {
        return json(res, 200, { errors: [e.message], warnings: [] });
      }
    }

    if (p === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      const { kind } = body;
      if (!RUNNABLE[kind]) return json(res, 400, { error: `unknown command "${kind}"` });
      for (const k of ["gym", "offer", "version", "batch"]) if (body[k] && !okSlug(body[k])) return json(res, 400, { error: `bad ${k}` });
      // Free-form generator args are constrained to their expected shapes.
      if (body.templates && !/^[0-9]+(,[0-9]+)*$/.test(body.templates)) return json(res, 400, { error: "templates must be comma-separated numbers" });
      if (body.ratios && !/^(1x1|9x16)(,(1x1|9x16))*$/.test(body.ratios)) return json(res, 400, { error: "ratios must be 1x1 and/or 9x16" });
      if (body.numImages && !/^[1-9][0-9]?$/.test(String(body.numImages))) return json(res, 400, { error: "numImages must be 1-99" });
      const spec = RUNNABLE[kind];
      if (kind === "scenes-refresh") {
        if (!okSlug(body.gym) || !existsSync(join(brandDir(body.gym), "scenes.json"))) return json(res, 400, { error: "a refresh needs a client with a scene library" });
        if (!AUDIENCES.includes(body.audience)) return json(res, 400, { error: `audience must be one of ${AUDIENCES.join(", ")}` });
        if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_REFRESH_COUNT) return json(res, 400, { error: `count must be 1 to ${MAX_REFRESH_COUNT}` });
        if (body.words != null && (typeof body.words !== "string" || body.words.trim().length < 3 || body.words.length > MAX_WORDS)) return json(res, 400, { error: `words must describe the pictures wanted, up to ${MAX_WORDS} characters` });
        if (body.reference != null && (!REFERENCE_NAME.test(String(body.reference)) || !existsSync(join(referencesDir(body.gym), body.reference)))) return json(res, 400, { error: "reference must name an uploaded reference image" });
        const run = startRun(kind, { gym: body.gym, audience: body.audience, count: body.count, words: body.words?.trim() || null, reference: body.reference || null });
        return json(res, 200, { id: run.id, label: run.label });
      }
      if (kind === "photo-survey" || kind === "photo-clean") {
        if (!okSlug(body.gym) || !existsSync(brandDir(body.gym))) return json(res, 400, { error: "bad gym" });
        const photos = Array.isArray(body.photos) ? body.photos : [];
        if (!photos.length || photos.length > MAX_CLEAN_PHOTOS) return json(res, 400, { error: `choose 1 to ${MAX_CLEAN_PHOTOS} premises photos` });
        for (const ph of photos) if (typeof ph !== "string" || !ASSET_FILE.test(ph) || !ASSET_NAME.test(ph) || !existsSync(join(assetsDir(body.gym), "facility", ph))) return json(res, 400, { error: `${JSON.stringify(ph)} is not one of the premises photos` });
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
