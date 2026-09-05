#!/usr/bin/env node
/**
 * server.mjs — Local control panel for the gym ad pipeline.
 *
 * The pipeline is a set of Node scripts driven from the command line. That is the wrong
 * surface for filling in a gym's brand colours, offer details and targeting, so this puts a
 * form-based UI in front of the same scripts. It is deliberately local-only and zero-dependency.
 *
 * Everything it knows about validation comes from skills/references/client-config.mjs — the UI
 * does not re-implement any rule, so the form and the CLI can never disagree.
 *
 * Usage:  node ui/server.mjs [--port 4310]
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, dirname, extname, normalize } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { spawn, execFileSync } from "child_process";
import {
  loadClientConfig, writeResolved, scaffold,
  CTA_ENUM, OFFER_TYPES, PRICE_QUALIFIERS,
} from "../skills/references/client-config.mjs";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "..");
const BRANDS = join(REPO_ROOT, "brands");

const { values: argv } = parseArgs({ options: { port: { type: "string", default: "4310" } } });
const PORT = parseInt(argv.port, 10);

// ── Safety ───────────────────────────────────────────────────────────────────
// Slugs become path segments, so they are constrained rather than sanitised.
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const okSlug = (s) => typeof s === "string" && SLUG.test(s);

/** Commands the UI is allowed to run. Nothing is ever passed through a shell, and the
 *  argument shapes are fixed here rather than accepted from the browser. */
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
      const a = ["skills/references/generate_ads_gemini.mjs", "--brand-dir", `brands/${gym}`];
      if (templates) a.push("--templates", templates);
      if (numImages) a.push("--num-images", String(numImages));
      if (ratios) a.push("--ratios", ratios);
      return a;
    },
  },
  gallery: {
    label: "Rebuild gallery",
    argv: ({ gym, version }) => ["skills/references/gallery-selector.mjs", "--output-dir", `brands/${gym}/outputs/${version}`],
  },
  checksync: { label: "Check skill/command sync", argv: () => ["skills/references/check-sync.mjs"] },
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
    .filter((n) => !n.startsWith(".") && statSync(join(BRANDS, n)).isDirectory())
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

  push(`$ node ${args.join(" ")}`, "meta");
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

/** Serve a file from inside the repo, refusing anything that escapes it. */
function serveFile(res, absPath) {
  const rel = normalize(absPath);
  if (!rel.startsWith(REPO_ROOT)) { json(res, 403, { error: "forbidden" }); return true; }
  if (!existsSync(rel) || statSync(rel).isDirectory()) return false;
  res.writeHead(200, { "content-type": MIME[extname(rel).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(rel));
  return true;
}

// ── Routes ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === "/" || p === "/index.html") return serveFile(res, join(UI_DIR, "app.html")) || json(res, 404, { error: "app.html missing" });

    if (p === "/api/status") return json(res, 200, setupStatus());
    if (p === "/api/enums") return json(res, 200, { cta: CTA_ENUM, offerTypes: OFFER_TYPES, priceQualifiers: PRICE_QUALIFIERS });
    if (p === "/api/clients" && req.method === "GET") return json(res, 200, { clients: listClients() });

    if (p === "/api/clients" && req.method === "POST") {
      const { gym, offer } = await readBody(req);
      if (!okSlug(gym)) return json(res, 400, { error: "gym must be lowercase letters, numbers and hyphens" });
      if (offer && !okSlug(offer)) return json(res, 400, { error: "offer slug must be lowercase letters, numbers and hyphens" });
      scaffold(gym, offer || null);
      return json(res, 200, { ok: true, gym, offer: offer || null });
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
      for (const k of ["gym", "offer", "version"]) if (body[k] && !okSlug(body[k])) return json(res, 400, { error: `bad ${k}` });
      // Free-form generator args are constrained to their expected shapes.
      if (body.templates && !/^[0-9]+(,[0-9]+)*$/.test(body.templates)) return json(res, 400, { error: "templates must be comma-separated numbers" });
      if (body.ratios && !/^(1x1|9x16)(,(1x1|9x16))*$/.test(body.ratios)) return json(res, 400, { error: "ratios must be 1x1 and/or 9x16" });
      if (body.numImages && !/^[1-9][0-9]?$/.test(String(body.numImages))) return json(res, 400, { error: "numImages must be 1-99" });
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

    // Generated artefacts (gallery.html, swipe-report.html, images) served straight from disk.
    if (p.startsWith("/files/")) {
      const rel = decodeURIComponent(p.slice("/files/".length));
      if (rel.includes("..")) return json(res, 403, { error: "forbidden" });
      if (serveFile(res, join(REPO_ROOT, rel))) return;
      return json(res, 404, { error: "not found" });
    }

    if (p === "/api/artifacts") {
      const out = [];
      for (const c of listClients()) {
        for (const v of c.outputs) {
          const g = join(BRANDS, c.gym, "outputs", v, "gallery.html");
          if (existsSync(g)) out.push({ gym: c.gym, version: v, url: `/files/brands/${c.gym}/outputs/${v}/gallery.html` });
        }
      }
      for (const niche of existsSync(join(REPO_ROOT, "swipe")) ? readdirSync(join(REPO_ROOT, "swipe")) : []) {
        const r = join(REPO_ROOT, "swipe", niche, "swipe-report.html");
        if (existsSync(r)) out.push({ gym: `swipe/${niche}`, version: "review", url: `/files/swipe/${niche}/swipe-report.html` });
      }
      return json(res, 200, { artifacts: out });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// Local only. This exposes the filesystem and can spawn processes — it must never bind publicly.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Gym Ads control panel → http://localhost:${PORT}`);
});
