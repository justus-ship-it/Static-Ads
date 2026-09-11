#!/usr/bin/env node
/**
 * plan-offer-batch.mjs — one brief in, a gallery of finished, verified offer-first ads out.
 *
 * The brief (brands/{gym}/batches/{id}/brief.json) is written by the user. Every word on every ad —
 * offer, locations, audience — comes from it exactly; nothing is read from the offer file or made up.
 *
 *   1 plan      validate the brief; for each photo to generate, pick the layout it is made for (its
 *               primary — spread across layouts) and a scene from the client's approved library that
 *               suits the audience and that layout's pose. Real photos are checked for marks.
 *   2 pictures  generate-visuals.mjs (Step 4) with a clean real photo as the room reference. Photos
 *               already passed on disk are reused. The only stage that spends: at most max_calls.
 *   3 fit       every photo against every layout (check-visual.mjs → fitLayouts): which layouts it can
 *               carry and the crop each would use. A photo made for T1 is not given T3's column.
 *   4 looks     assign-variants.mjs, from the layouts each photo can carry, with photo colour and the
 *               client's exclusions; a generated photo's primary layout is its first look.
 *   5 render    every look, for every location together: a look is kept only if it verifies for all
 *               of them, so the ads for each location differ only in the location line.
 *   6 gallery   one numbered folder per ad (gallery-selector.mjs finds them unchanged), batch.json
 *               mapping each folder to its photos, look, crop and exact words, and gallery.html.
 *
 * --dry-run stops after stage 1 and says what would be generated and what it may cost.
 * --render-only re-renders from the photos on disk (change the offer, a location or the audience in
 * the brief): zero image calls.
 *
 * Usage:
 *   node skills/references/plan-offer-batch.mjs --brand-dir brands/sculpt-society \
 *     --brief batches/2026-09-12-test/brief.json [--dry-run] [--render-only]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { validateInputs, loadCatalogue, launchBrowser, layoutFor } from "./render-composites.mjs";
import { poseProblem, POSES } from "./visual-prompts.mjs";
import { fitLayouts, imageSize, checkTiled } from "./check-visual.mjs";
import { assignVariants, measurePhotos, renderPlan, excludeFromProfile } from "./assign-variants.mjs";
import { generateVisuals } from "./generate-visuals.mjs";
import { makePixelTools } from "./clean-photo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_LOCATIONS = 4;
/** The look a generated photo's own finished-ad check is rendered with (Step 4). */
const CHECK_LOOK = { style: "s1-heavy-sans", palette: "white-on-dark" };

// ── the brief ─────────────────────────────────────────────────────────────

/** Which scenes suit an audience callout. The brief can say so outright (scene_audience). */
export function sceneAudience(audience, override = null) {
  if (override) return override;
  const a = String(audience || "");
  if (/\b(men|man|guys|dads?|gents|gentlemen|males?|brothers)\b/i.test(a)) return "men";
  if (/\b(ladies|women|woman|mums?|moms?|girls|females?|sisters)\b/i.test(a)) return "women";
  return "any";
}

/** Every problem with a brief, as messages. Empty = runnable. */
export function validateBrief(brief, { brandDir = null, catalogue = loadCatalogue() } = {}) {
  const errs = [];
  const T = catalogue.treatments;
  if (!brief || typeof brief !== "object") return ["the brief is not a JSON object"];
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(brief.batch_id || "")) errs.push("batch_id is required: lower-case letters, digits and dashes (it names the output folder)");
  if (typeof brief.offer !== "string" || !brief.offer.trim()) errs.push("offer is required, written exactly as it should appear — it is never taken from the offer file or made up");
  const locations = brief.locations;
  if (!Array.isArray(locations) || locations.length < 1 || locations.length > MAX_LOCATIONS) errs.push(`locations must list 1 to ${MAX_LOCATIONS} location callouts`);
  else {
    if (new Set(locations).size !== locations.length) errs.push("locations repeat");
    for (const loc of locations) for (const e of validateInputs({ location: loc, audience: brief.audience ?? null, offer: brief.offer || "x" })) errs.push(`${JSON.stringify(loc)}: ${e}`);
  }
  if (brief.free !== undefined && typeof brief.free !== "boolean") errs.push("free must be true or false");
  if (brief.scene_audience != null && !["men", "women", "any"].includes(brief.scene_audience)) errs.push('scene_audience must be "men", "women" or "any"');
  const g = brief.generated ?? 0, real = brief.real || [];
  if (!Number.isInteger(g) || g < 0 || g > 12) errs.push("generated must be a whole number from 0 to 12");
  if (!Array.isArray(real)) errs.push("real must be a list of photo paths");
  else if (g + real.length < 1) errs.push("the batch has no photos: set generated, list real photos, or both");
  if (brandDir && Array.isArray(real)) for (const p of real) if (!existsSync(join(brandDir, "brand-assets", p)) && !existsSync(resolve(p))) errs.push(`real photo not found: ${p}`);
  if (brief.reference && brandDir && !existsSync(join(brandDir, "brand-assets", brief.reference)) && !existsSync(resolve(brief.reference))) errs.push(`reference photo not found: ${brief.reference}`);
  const looks = brief.looks_per_photo ?? 2;
  if (!Number.isInteger(looks) || looks < 1 || looks > 6) errs.push("looks_per_photo must be 1 to 6");
  const maxCalls = brief.max_calls ?? g, attempts = brief.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) errs.push("attempts must be 1 to 5");
  if (!Number.isInteger(maxCalls) || maxCalls < g) errs.push(`max_calls (${maxCalls}) must cover at least one call per generated photo (${g})`);
  if (maxCalls > 30) errs.push("max_calls over 30: split the batch");
  if (brief.scenes != null) {
    if (!Array.isArray(brief.scenes) || brief.scenes.length < g) errs.push(`scenes, when given, must list at least one per generated photo (${g})`);
    else for (const [i, s] of brief.scenes.entries()) for (const e of sceneProblems(s)) errs.push(`scenes[${i}]: ${e}`);
  }
  if (brief.ratio && !T.canvas[brief.ratio]) errs.push(`ratio "${brief.ratio}" is not one of ${Object.keys(T.canvas).join(", ")}`);
  return errs;
}

// ── scenes ────────────────────────────────────────────────────────────────

export function sceneProblems(s) {
  const errs = [];
  if (!s || typeof s.scene !== "string" || !s.scene.trim()) return ["a scene needs its description"];
  if (/["“”]/.test(s.scene)) errs.push("contains quotation marks — scenes describe the picture, never words to show");
  if (!POSES[s.pose]) errs.push(`pose must be one of ${Object.keys(POSES).join(", ")}`);
  if (!Number.isInteger(s.people) || s.people < 1 || s.people > 3) errs.push("people must be 1 to 3");
  if (s.audience && !["men", "women", "any"].includes(s.audience)) errs.push('audience must be "men", "women" or "any"');
  return errs;
}

/** The client's scene library. Refused unless approved, unless `allowDraft` (planning only). */
export function loadScenes(path, { allowDraft = false } = {}) {
  if (!existsSync(path)) throw new Error(`no scene library at ${path}: write one, or give scenes in the brief`);
  const lib = JSON.parse(readFileSync(path, "utf-8"));
  const bad = (lib.scenes || []).flatMap((s, i) => sceneProblems(s).map((e) => `${s.id || i}: ${e}`));
  if (bad.length) throw new Error(`scene library problems:\n${bad.join("\n")}`);
  if (lib.approved !== true && !allowDraft) throw new Error(`the scene library ${path} is not approved yet — nothing is generated from it until the owner sets "approved": true`);
  return lib.scenes;
}

/** Layouts a generated photo can be made for: single-photo layouts with a subject area. */
export function primaryLayouts(catalogue = loadCatalogue(), ratio = "1x1", exclude = {}) {
  const rules = fitLayouts({ people_box: null, face_boxes: [], people_count: 0 }, { ratio, expectPeople: false, catalogue });
  return Object.entries(rules).filter(([id, f]) => f.rule === "subject-area" && !(exclude.layouts || []).includes(id)).map(([id]) => id);
}

function rngFrom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h |= 0; h = (h + 0x6d2b79f5) | 0; let t = Math.imul(h ^ (h >>> 15), 1 | h); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * For each photo to generate: the layout it is made for and a scene that suits the audience and that
 * layout's pose. Layouts and scenes are spread (no repeats until every one is used), seeded.
 */
export function planVisuals({ count, scenes, audience, seed = "batch", catalogue = loadCatalogue(), ratio = "1x1", exclude = {} }) {
  if (!count) return [];
  const rand = rngFrom(`${seed}|visuals`);
  const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const suits = scenes.filter((s) => audience === "any" || !s.audience || s.audience === audience || s.audience === "any");
  if (!suits.length) throw new Error(`no scene in the library suits a "${audience}" audience`);
  const layouts = shuffle(primaryLayouts(catalogue, ratio, exclude));
  const usedL = new Map(layouts.map((l) => [l, 0])), usedS = new Map(suits.map((s) => [s, 0]));
  const out = [];
  for (let i = 0; i < count; i++) {
    let pick = null;
    // Least-used layout first; for it, the least-used scene whose pose it can hold.
    for (const la of [...layouts].sort((a, b) => usedL.get(a) - usedL.get(b))) {
      const ok = shuffle(suits).filter((s) => !poseProblem(la, s.pose, catalogue)).sort((a, b) => usedS.get(a) - usedS.get(b));
      if (ok.length) { pick = { la, s: ok[0] }; break; }
    }
    if (!pick) throw new Error("no scene in the library fits any layout the batch can use");
    usedL.set(pick.la, usedL.get(pick.la) + 1); usedS.set(pick.s, usedS.get(pick.s) + 1);
    out.push({ id: `g${String(i + 1).padStart(2, "0")}`, treatment: pick.la, scene: pick.s.scene, scene_id: pick.s.id || null, pose: pick.s.pose, people: pick.s.people, look: CHECK_LOOK });
  }
  return out;
}

// ── output ────────────────────────────────────────────────────────────────

export const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const shortLayout = (id) => id.split("-")[0];

/** One numbered folder per ad (candidate × location), numbered from 101 in candidate order. */
export function adFolders(results, locations, ratio = "1x1") {
  const ads = [];
  let n = 101;
  for (const c of results) {
    if (c.failed) continue;
    for (const [li, loc] of locations.entries()) {
      const folder = `${n++}-${c.id}-${slug(loc)}-${shortLayout(c.treatment)}-${c.palette}`;
      ads.push({ folder, file: join(folder, ratio, `${c.id}-${slug(loc)}_${ratio}_v1.png`), candidate: c.id, location: loc, location_index: li });
    }
  }
  return ads;
}

/** selections.json (from the gallery) → each chosen ad's full record from batch.json. */
export function resolveSelections(batchDir, selections = JSON.parse(readFileSync(join(batchDir, "selections.json"), "utf-8"))) {
  const batch = JSON.parse(readFileSync(join(batchDir, "batch.json"), "utf-8"));
  const byFolder = new Map(batch.ads.map((a) => [a.folder, a]));
  const excluded = new Set(selections.excluded || []);
  const chosen = [], unknown = [];
  for (const [folder, ratios] of Object.entries(selections)) {
    if (folder === "excluded" || excluded.has(folder)) continue;
    const ad = byFolder.get(folder);
    if (!ad) { unknown.push(folder); continue; }
    chosen.push({ ...ad, picked: ratios });
  }
  if (unknown.length) throw new Error(`selections.json names folders this batch did not make: ${unknown.join(", ")}`);
  return chosen;
}

const hashFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

// ── the run ───────────────────────────────────────────────────────────────

/**
 * Run a batch. Injectable for tests: generate, check (a generated photo's check), checkPhoto (a real
 * photo's tiled check), checkRef, compositor, gallery (builds gallery.html), log.
 */
export async function runBatch({ brandDir, brief, outDir = null, dryRun = false, renderOnly = false, scenesPath = null, deps = {}, log = console.log }) {
  const catalogue = loadCatalogue();
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const errs = validateBrief(brief, { brandDir, catalogue });
  if (errs.length) throw new Error(`the brief cannot run:\n- ${errs.join("\n- ")}`);
  const ratio = brief.ratio || "1x1", looks = brief.looks_per_photo ?? 2, seed = brief.seed || brief.batch_id;
  const exclude = excludeFromProfile(profile.creative);
  const audience = brief.audience ?? null;
  const texts = brief.locations.map((location) => ({ location, audience, offer: brief.offer, free: brief.free === true }));
  const photography = profile.brand_lock?.photography || {};
  const brandNames = [profile.display_name, profile.formerly?.split(/\s[—–-]\s|[;,(]/)[0].trim()].filter(Boolean);
  const out = resolve(outDir || join(brandDir, "outputs", brief.batch_id));
  mkdirSync(out, { recursive: true });
  const at = (p) => (existsSync(join(brandDir, "brand-assets", p)) ? join(brandDir, "brand-assets", p) : resolve(p));

  // ── 1 plan ──
  const g = brief.generated ?? 0;
  const scenes = brief.scenes || (g ? loadScenes(scenesPath || join(brandDir, "scenes.json"), { allowDraft: dryRun }) : []);
  const plannedPath = join(out, "visuals.json");
  let visuals;
  if (renderOnly && existsSync(plannedPath)) visuals = JSON.parse(readFileSync(plannedPath, "utf-8")).visuals;
  else visuals = planVisuals({ count: g, scenes, audience: sceneAudience(audience, brief.scene_audience), seed, catalogue, ratio, exclude });
  for (const v of visuals) { const p = poseProblem(v.treatment, v.pose, catalogue); if (p) throw new Error(`${v.id}: ${p}`); }
  const reference = brief.reference || brief.real?.[0] || null;
  const plan = { batch_id: brief.batch_id, audience_for_scenes: sceneAudience(audience, brief.scene_audience), reference, visuals, max_calls: brief.max_calls ?? g, attempts: brief.attempts ?? 1 };
  writeFileSync(plannedPath, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(out, "brief.json"), JSON.stringify(brief, null, 2) + "\n"); // the brief as run
  log(`· plan: ${visuals.length} photo(s) to generate (${visuals.map((v) => `${v.id} for ${shortLayout(v.treatment)}: ${v.scene_id || "brief scene"}`).join("; ") || "none"}), ${(brief.real || []).length} real; ${looks} look(s) each × ${brief.locations.length} location(s); at most ${plan.max_calls} image call(s)`);
  if (dryRun) return { dryRun: true, plan, out };

  // Real photos: their marks and their people, from the tiled check — cached by file contents.
  const photosPath = join(out, "photos.json");
  const cache = existsSync(photosPath) ? JSON.parse(readFileSync(photosPath, "utf-8")) : {};
  const pixels = deps.pixels || makePixelTools();
  const checkPhoto = deps.checkPhoto || ((p) => checkTiled(p, { never: photography.never || [], crop: pixels.crop }));
  const photos = [];
  try {
    for (const [i, rel] of (brief.real || []).entries()) {
      const file = at(rel), key = hashFile(file);
      let c = cache[key];
      if (!c) { c = await checkPhoto(file); cache[key] = { text: c.text, never: c.never, people_count: c.people_count, people_box: c.people_box || null, face_boxes: c.face_boxes || [] }; c = cache[key]; }
      const marks = [...(c.text || []), ...(c.never || [])];
      if (marks.length) throw new Error(`real photo ${rel} is not clean: ${marks.map((m) => `${m.kind || "never-list"} "${m.what}"`).join("; ")} — clean it first (clean-photo.mjs)`);
      photos.push({ id: `r${String(i + 1).padStart(2, "0")}`, kind: "real", file, source: rel, answer: { people_box: c.people_box, face_boxes: c.face_boxes, people_count: c.people_count }, expectPeople: false, maxPeople: null });
    }
  } finally { if (!deps.pixels) await pixels.close(); }
  writeFileSync(photosPath, JSON.stringify(cache, null, 2) + "\n");

  // ── 2 pictures ──
  const picsPath = join(out, "pictures.json");
  const prior = existsSync(picsPath) ? JSON.parse(readFileSync(picsPath, "utf-8")) : {};
  const same = (a, v) => a && a.status === "passed" && a.scene === v.scene && a.treatment === v.treatment && existsSync(a.file);
  const todo = renderOnly ? [] : visuals.filter((v) => !same(prior[v.id], v));
  if (renderOnly) { const missing = visuals.filter((v) => !same(prior[v.id], v)); if (missing.length) log(`· render-only: ${missing.map((v) => v.id).join(", ")} have no passed photo on disk and are left out`); }
  let calls = 0;
  if (todo.length) {
    const rep = await generateVisuals({
      visuals: todo, text: texts[0], photography, brandNames, outDir: join(out, "visuals"), ratio,
      refs: reference ? [at(reference)] : [], maxCalls: plan.max_calls, attempts: plan.attempts,
      ...(deps.generate ? { generate: deps.generate } : {}), ...(deps.check ? { check: deps.check } : {}), ...(deps.checkRef ? { checkRef: deps.checkRef } : {}), ...(deps.compositor !== undefined ? { compositor: deps.compositor } : {}), log,
    });
    calls = rep.image_calls;
    for (const r of rep.results) prior[r.id] = { status: r.status, scene: r.scene, treatment: r.treatment, file: r.file, check: r.check ? { faces: r.check.faces, focus: r.check.focus, placement: r.check.placement } : null, failures: r.check?.failures || (r.reason ? [r.reason] : []) };
    writeFileSync(picsPath, JSON.stringify(prior, null, 2) + "\n");
  }
  for (const v of visuals) {
    const a = prior[v.id];
    if (!same(a, v)) { log(`- ${v.id}: no passing photo (${a?.failures?.join("; ") || "not generated"}) — left out of the batch`); continue; }
    photos.unshift({ id: v.id, kind: "generated", file: a.file, primary: v.treatment, scene_id: v.scene_id, answer: { people_box: a.check.placement.people_box, face_boxes: a.check.faces, people_count: a.check.placement.people_count }, expectPeople: true, maxPeople: v.people });
  }
  photos.sort((a, b) => a.id.localeCompare(b.id));
  if (!photos.length) throw new Error("no photos passed: nothing to render");

  // ── 3 fit ──
  const allowed = {}, focus = {}, faces = {};
  for (const p of photos) {
    const fit = fitLayouts(p.answer, { ratio, imageSize: imageSize(readFileSync(p.file)), expectPeople: p.expectPeople, maxPeople: p.maxPeople, catalogue });
    allowed[p.id] = Object.keys(fit).filter((id) => fit[id].ok && !(exclude.layouts || []).includes(id));
    focus[p.id] = Object.fromEntries(Object.entries(fit).map(([id, f]) => [id, f.focus]));
    faces[p.id] = p.answer.face_boxes || [];
    p.fit = Object.fromEntries(Object.entries(fit).map(([id, f]) => [id, f.ok ? "ok" : f.failures.join("; ")]));
  }
  for (const p of photos) if (p.primary && !allowed[p.id].includes(p.primary)) log(`  ${p.id}: passed its own check but not its layout's fit at the batch ratio`);
  log(`· fit: ${photos.map((p) => `${p.id} → ${allowed[p.id].map(shortLayout).join(" ")}`).join("; ")}`);

  // ── 4 looks ──
  const browser = deps.browser || await launchBrowser();
  let results;
  try {
    const stats = await measurePhotos(browser, photos.map((p) => p.file), { ratio });
    const planned = assignVariants({ visuals: photos.map((p) => ({ id: p.id })), perVisual: looks, text: { location: brief.locations[0], audience }, seed, exclude, photoStats: stats, allowed, prefer: Object.fromEntries(photos.filter((p) => p.primary).map((p) => [p.id, p.primary])), catalogue, ratio });
    for (const n of planned.notes) log(`  note: ${n}`);

    // ── 5 render ──
    const fileOf = Object.fromEntries(photos.map((p) => [p.id, p.file]));
    results = await renderPlan(browser, planned, { texts, imageFor: (id) => fileOf[id], facesFor: (id) => faces[id], focusFor: (id, la) => focus[id]?.[la] || null, catalogue });
  } finally { if (!deps.browser) await browser.close(); }

  // ── 6 gallery ──
  const old = existsSync(join(out, "batch.json")) ? JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")) : null;
  for (const a of old?.ads || []) rmSync(join(out, a.folder), { recursive: true, force: true }); // only folders this batch made before
  const ads = adFolders(results, brief.locations, ratio).map((a) => {
    const c = results.find((r) => r.id === a.candidate);
    const png = c.renders[a.location_index].r.png;
    mkdirSync(dirname(join(out, a.file)), { recursive: true });
    writeFileSync(join(out, a.file), png);
    return {
      ...a, photos: c.images, photo_files: c.images.map((id) => photos.find((p) => p.id === id).source || basename(photos.find((p) => p.id === id).file)),
      treatment: c.treatment, style: c.style, palette: c.palette, ratio,
      crop: c.images.map((id) => focus[id]?.[c.treatment] || [0.5, 0.5]),
      words: { location: a.location, audience, offer: brief.offer, free: brief.free === true },
      replaced: c.replaced || null,
    };
  });
  const failed = results.filter((r) => r.failed).map((r) => ({ candidate: r.id, photo: r.visual, failures: r.failed }));
  const batch = {
    batch_id: brief.batch_id, made: new Date().toISOString(), ratio, image_calls: calls,
    photos: photos.map((p) => ({ id: p.id, kind: p.kind, file: p.source || p.file, primary: p.primary || null, scene_id: p.scene_id || null, allowed: allowed[p.id], fit: p.fit })),
    ads, failed,
  };
  writeFileSync(join(out, "batch.json"), JSON.stringify(batch, null, 2) + "\n");
  const gallery = deps.gallery || ((dir) => execFileSync(process.execPath, [join(HERE, "gallery-selector.mjs"), "--output-dir", dir], { stdio: "ignore" }));
  gallery(out);
  log(`· ${ads.length} ad(s) in ${out} (${results.filter((r) => !r.failed).length} looks × ${brief.locations.length} location(s))${failed.length ? `; ${failed.length} look(s) failed to verify and are left out` : ""}; ${calls} image call(s)`);
  return { out, batch, calls, results };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, brief: { type: "string" }, out: { type: "string" },
    "dry-run": { type: "boolean", default: false }, "render-only": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.brief) {
    console.error("Usage: plan-offer-batch.mjs --brand-dir <brands/x> --brief <batches/id/brief.json> [--dry-run] [--render-only] [--out <dir>]");
    process.exit(1);
  }
  const brandDir = resolve(v["brand-dir"]);
  const briefPath = [resolve(v.brief), join(brandDir, v.brief)].find(existsSync);
  if (!briefPath) { console.error(`brief not found: ${v.brief}`); process.exit(1); }
  try {
    const r = await runBatch({ brandDir, brief: JSON.parse(readFileSync(briefPath, "utf-8")), outDir: v.out, dryRun: v["dry-run"], renderOnly: v["render-only"] });
    if (!r.dryRun) console.log(`gallery: ${join(r.out, "gallery.html")}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
