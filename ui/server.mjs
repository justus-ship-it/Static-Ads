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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync, rmSync } from "fs";
import { join, resolve, dirname, extname, sep } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { spawn, execFileSync } from "child_process";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  loadClientConfig, writeResolved, scaffold,
  CTA_ENUM, OFFER_TYPES, PRICE_QUALIFIERS,
} from "../skills/references/client-config.mjs";
import { validateBrief, sceneAudience, MAX_LOCATIONS, MAX_CALLS_CAP } from "../skills/references/plan-offer-batch.mjs";
import { libraryStatus } from "../skills/references/scene-library.mjs";
import { launchBrowser, renderComposite, validateInputs } from "../skills/references/render-composites.mjs";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "..");
const BRANDS = resolve(process.env.PANEL_BRANDS_DIR || join(REPO_ROOT, "brands"));
const SWIPE = join(REPO_ROOT, "swipe");
const BATCH_SCRIPT = join(REPO_ROOT, "skills", "references", "plan-offer-batch.mjs");
const STORIES_SCRIPT = join(REPO_ROOT, "skills", "references", "make-stories.mjs");

const { values: argv } = parseArgs({ options: { port: { type: "string", default: "4310" } } });
let PORT = parseInt(argv.port, 10);

// ── Safety ───────────────────────────────────────────────────────────────────
// Slugs become path segments, so they are constrained rather than sanitised.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const okSlug = (s) => typeof s === "string" && SLUG.test(s);
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
  batch: { label: "Run batch", needsBrief: true, spends: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch)] },
  "batch-rerender": { label: "Re-render batch with its words (free)", needsBrief: true, argv: ({ gym, batch }) => [BATCH_SCRIPT, "--brand-dir", brandDir(gym), "--brief", briefPath(gym, batch), "--render-only"] },
  // Stories/Reels (9:16) versions of the selected ads (Step 8): the batch id and the confirmed call cap only.
  "batch-stories": { label: "Make Stories versions", needsBrief: true, spends: "stories", argv: ({ gym, batch, confirm }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--max-calls", String(confirm.max_calls)] },
  "batch-stories-rerender": { label: "Re-render Stories versions (free)", needsBrief: true, argv: ({ gym, batch }) => [STORIES_SCRIPT, "--brand-dir", brandDir(gym), "--batch", batch, "--render-only"] },
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
        offers,
        outputs,
        asset_counts: countAssets(dir),
      };
    });
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
  for (const L of PREVIEW_LOOKS) {
    const ims = L.photos.map((i) => files[Math.min(i, files.length - 1)]);
    const style = !audience && L.noAudienceStyle ? L.noAudienceStyle : L.style;
    const r = await renderComposite(browser, { images: ims, location, audience: audience || null, offer, treatment: L.treatment, style, palette: L.palette, ratio: "1x1" });
    let url = null;
    if (r.png) {
      const id = randomBytes(9).toString("hex");
      previews.set(id, r.png);
      while (previews.size > 32) previews.delete(previews.keys().next().value);
      url = `/api/preview-img/${id}.png`;
    }
    looks.push({ id: L.id, label: L.label, treatment: L.treatment, style, palette: L.palette, ok: r.ok, failures: r.failures || [], url, words: r.report?.blocks ? Object.fromEntries(r.report.blocks.map((b) => [b.block, b.text])) : null });
  }
  return looks;
}

// ── Run streaming ────────────────────────────────────────────────────────────
const runs = new Map(); // id -> { lines:[], done:bool, code:null, clients:Set }

function startRun(kind, params) {
  const spec = RUNNABLE[kind];
  if (!spec) throw new Error(`unknown command "${kind}"`);
  const args = spec.argv(params);
  const id = `${kind}-${Date.now().toString(36)}`;
  const run = { id, kind, label: spec.label, lines: [], done: false, code: null, clients: new Set() };
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
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

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
  else if (parts[0] === "brands" && okSlug(parts[1]) && parts[2] === "brand-assets" && IMAGE_EXT.has(ext)) base = join(BRANDS, parts[1], "brand-assets");
  else if (parts[0] === "swipe" && parts.length >= 3 && (ext === ".html" || IMAGE_EXT.has(ext))) base = SWIPE;
  if (!base) return null;
  const abs = parts[0] === "brands" ? join(base, ...parts.slice(3)) : join(SWIPE, ...parts.slice(1));
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
  // Symlinks may not lead out of the allowed folder.
  const real = realpathSync(abs), realBase = realpathSync(base);
  return real.startsWith(realBase + sep) ? real : null;
}

function sendFile(res, abs) {
  res.writeHead(200, { "content-type": MIME[extname(abs).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
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
    if (p === "/api/enums") return json(res, 200, { cta: CTA_ENUM, offerTypes: OFFER_TYPES, priceQualifiers: PRICE_QUALIFIERS, maxLocations: MAX_LOCATIONS });
    if (p === "/api/clients" && req.method === "GET") return json(res, 200, { clients: listClients() });

    if (p === "/api/clients" && req.method === "POST") {
      const { gym, offer } = await readBody(req);
      if (!okSlug(gym)) return json(res, 400, { error: "gym must be lowercase letters, numbers and hyphens" });
      if (offer && !okSlug(offer)) return json(res, 400, { error: "offer slug must be lowercase letters, numbers and hyphens" });
      scaffold(gym, offer || null);
      return json(res, 200, { ok: true, gym, offer: offer || null });
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

    // /api/client/{gym}/batch-setup · /batch/check · /batch · /batch/{id}
    const bm = p.match(/^\/api\/client\/([^/]+)\/(batch-setup|batch|batch\/check|batch\/([^/]+))$/);
    if (bm) {
      const [, gym, what, id] = bm;
      if (!okSlug(gym) || !existsSync(brandDir(gym))) return json(res, 400, { error: "bad gym" });
      if (what === "batch-setup" && req.method === "GET") return json(res, 200, { photos: cleanPhotos(gym), scenes: sceneStatus(gym), batches: listBatches(gym), maxLocations: MAX_LOCATIONS });
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
        return json(res, 200, { profile: readJsonFile(join(dir, "gym-profile.json")), assets: countAssets(dir) });
      }

      if (req.method === "PUT") {
        const body = await readBody(req);
        if (offerSlug) {
          mkdirSync(join(dir, "offers"), { recursive: true });
          writeFileSync(join(dir, "offers", `${offerSlug}.json`), JSON.stringify(body, null, 2) + "\n");
        } else {
          writeFileSync(join(dir, "gym-profile.json"), JSON.stringify(body, null, 2) + "\n");
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
      if (spec.needsBrief) {
        if (!okSlug(body.gym) || !okSlug(body.batch)) return json(res, 400, { error: "a batch run needs gym and batch" });
        const brief = readJsonFile(briefPath(body.gym, body.batch));
        if (!brief) return json(res, 404, { error: `no brief for batch ${body.batch}` });
        // A run that spends must have been confirmed against the brief as it is on disk now: the words
        // and the call cap the person agreed to are exactly what will run.
        if (spec.spends === "stories") {
          // The cap is the one number the person confirms; the words are the batch's own. Nothing runs
          // until the gallery's picks are in the batch folder.
          const cap = body.confirm?.max_calls;
          if (!Number.isInteger(cap) || cap < 0 || cap > MAX_CALLS_CAP) return json(res, 400, { error: `confirm the call cap for the Stories versions (0–${MAX_CALLS_CAP})` });
          if (!existsSync(join(brandDir(body.gym), "outputs", body.batch, "selections.json"))) return json(res, 409, { error: "no selections yet: open the gallery, pick, Save Selections, and put selections.json in the batch folder" });
        } else if (spec.spends) {
          const c = body.confirm || {};
          const agreed = c.offer === brief.offer && JSON.stringify(c.locations) === JSON.stringify(brief.locations) && (c.audience ?? null) === (brief.audience ?? null) && c.max_calls === (brief.max_calls ?? brief.generated ?? 0);
          if (!agreed) return json(res, 409, { error: "the brief on disk differs from what was confirmed — review it and confirm again" });
        }
      }
      const run = startRun(kind, body);
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
