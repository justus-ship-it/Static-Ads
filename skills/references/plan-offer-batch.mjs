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
 *   2 pictures  generate-visuals.mjs (Step 4) with a clean real photo as the room reference. Every photo
 *               must pass the text/placement check and the quality check (looks real; groups candid).
 *               Photos on disk are reused if they pass today's checks. The only stage that spends
 *               image calls: at most max_calls for the batch.
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

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync, readdirSync, renameSync } from "fs";
import { join, resolve, basename, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { validateInputs, loadCatalogue, launchBrowser, layoutFor } from "./render-composites.mjs";
import { poseProblem, POSES } from "./visual-prompts.mjs";
import { fitLayouts, imageSize, checkTiled } from "./check-visual.mjs";
import { QUALITY_VERSION } from "./check-quality.mjs";
import { assignVariants, measurePhotos, renderPlan, excludeFromProfile } from "./assign-variants.mjs";
import { catalogueFor } from "./client-config.mjs";
import { generateVisuals, assess, makeCompositor, checkPicture } from "./generate-visuals.mjs";
import { makePixelTools } from "./clean-photo.mjs";
import { SCENE_TAGS, MAX_SCENE_PEOPLE, sceneProblems, sceneWarnings, loadScenes, readLibrary, isRetired, isDraft, approveScenes } from "./scene-library.mjs";
import { draftScenes, validateDirection } from "./refresh-scenes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Which checks a passed photo has been through. A photo passed under older checks (before the quality
 *  check, 2026-09-12) is re-checked on the next run — vision calls only — before it is used again. */
export const CHECKS_VERSION = `q${QUALITY_VERSION}`;
export const MAX_LOCATIONS = 4;
export const MAX_CALLS_CAP = 40;
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
  // The offer and audience are checked once, each location on its own — one problem, one message
  // (the panel showed an offer's dash once per location).
  if (typeof brief.offer === "string" && brief.offer.trim()) for (const e of validateInputs({ location: "X", audience: brief.audience ?? null, offer: brief.offer })) if (!e.startsWith("location")) errs.push(e);
  if (!Array.isArray(locations) || locations.length < 1 || locations.length > MAX_LOCATIONS) errs.push(`locations must list 1 to ${MAX_LOCATIONS} location callouts`);
  else {
    if (new Set(locations).size !== locations.length) errs.push("locations repeat");
    for (const loc of locations) for (const e of validateInputs({ location: loc, audience: null, offer: "x" })) if (e.startsWith("location")) errs.push(`${JSON.stringify(loc)}: ${e}`);
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
  // The budget is for the batch's whole life (re-runs replace failed photos from what is left), so a
  // 48-ad batch can legitimately grow past 30 — the owner raised one to 32 (2026-09-12).
  if (maxCalls > MAX_CALLS_CAP) errs.push(`max_calls over ${MAX_CALLS_CAP}: split the batch`);
  if (brief.scenes != null) {
    if (!Array.isArray(brief.scenes) || brief.scenes.length < g) errs.push(`scenes, when given, must list at least one per generated photo (${g})`);
    else for (const [i, s] of brief.scenes.entries()) for (const e of sceneProblems(s)) errs.push(`scenes[${i}]: ${e}`);
  }
  if (brief.must_show != null) {
    if (typeof brief.must_show !== "object" || Array.isArray(brief.must_show)) errs.push("must_show must map a tag to the values the batch must include");
    else for (const [tag, values] of Object.entries(brief.must_show)) {
      if (tag !== "exercise" && !SCENE_TAGS[tag]) errs.push(`must_show: unknown tag "${tag}" (use exercise, ${Object.keys(SCENE_TAGS).join(", ")})`);
      else if (!Array.isArray(values) || !values.every((v) => typeof v === "string" && v)) errs.push(`must_show.${tag} must be a list of values`);
      else if (SCENE_TAGS[tag]) for (const v of values) if (!SCENE_TAGS[tag].includes(v)) errs.push(`must_show.${tag}: "${v}" is not one of ${SCENE_TAGS[tag].join(", ")}`);
    }
  }
  if (brief.ratio && !T.canvas[brief.ratio]) errs.push(`ratio "${brief.ratio}" is not one of ${Object.keys(T.canvas).join(", ")}`);
  // The owner's direction for the batch's photos: words, or a reference image read into words.
  if (brief.direction != null) {
    for (const e of validateDirection(brief.direction, { brandDir })) errs.push(`direction: ${e}`);
    if (brief.scenes != null) errs.push("direction and scenes cannot both be given: the direction drafts the batch's scenes");
    if (!(g > 0)) errs.push("direction needs generated photos (generated is 0)");
  }
  return errs;
}

// ── scenes ────────────────────────────────────────────────────────────────
// The library itself lives in scene-library.mjs (vocabulary, validation, approve / reject / retire);
// re-exported here for the callers that always found it on the planner.
export { SCENE_TAGS, MAX_SCENE_PEOPLE, sceneProblems, sceneWarnings, loadScenes };

/**
 * A directed batch (brief.direction: the owner's words, or a reference image read into words) draws
 * its scenes from what was drafted for it — `source: "batch:{id}"` in the library — not from the
 * library at large. The dry run drafts what is missing (text calls only); a real run needs those
 * drafts confirmed (the panel's Run confirmation, or --approve-scenes), since nothing is generated
 * from a draft. Rejecting one (refresh-scenes.mjs --reject) retires it, and the next dry run drafts a
 * replacement.
 */
export async function directedScenes({ brandDir, brief, scenesPath, audience, dryRun, renderOnly, draft = draftScenes, log = console.log }) {
  const lib = readLibrary(scenesPath);
  const g = brief.generated ?? 0, source = `batch:${brief.batch_id}`;
  const mine = () => lib.scenes.filter((s) => s.source === source && !isRetired(s));
  const have = mine();
  if (have.length < g && !renderOnly) {
    const r = await draft({ brandDir, scenesPath, audience, count: g - have.length, direction: brief.direction, source, log });
    lib.scenes = readLibrary(scenesPath).scenes; // what the drafter wrote
    log(`· direction: ${r.drafts.length} scene(s) drafted for this batch${r.dropped.length ? ` (${r.dropped.length} dropped: ${r.dropped.map((d) => d.reason).join("; ")})` : ""}`);
  }
  const scenes = mine();
  const bad = scenes.flatMap((s) => sceneProblems(s).map((e) => `${s.id}: ${e}`));
  if (bad.length) throw new Error(`this batch's scenes have problems:\n${bad.join("\n")}`);
  if (!scenes.length) throw new Error("no scene could be drafted for this batch's direction — change the words, or give scenes in the brief");
  const pending = scenes.filter(isDraft);
  if (pending.length && !dryRun) throw new Error(`this batch's ${pending.length} drafted scene(s) await confirmation: ${pending.map((s) => s.id).join(", ")} — read them in the plan, then confirm (the panel's Run confirmation, or --approve-scenes) or reject one with a reason (refresh-scenes.mjs --reject)`);
  return scenes;
}

/**
 * The owner's rulings on photos: `brands/{gym}/quality-calibration.json`, the entries marked
 * `"by": "owner"` (the same file check-quality.mjs --calibrate measures the check against). A photo
 * ruled "fail" is never used, whatever the checks say (2026-09-12: the owner failed two photos the
 * checker passes); one ruled "pass" skips the quality check but still goes through the text and
 * placement check, which the render needs. Paths are relative to the file.
 */
export function loadRulings(brandDir) {
  const p = join(brandDir, "quality-calibration.json");
  if (!existsSync(p)) return {};
  const { photos = [] } = JSON.parse(readFileSync(p, "utf-8"));
  return Object.fromEntries(photos.filter((x) => x.by === "owner" && ["pass", "fail"].includes(x.expect) && x.file).map((x) => [resolve(brandDir, x.file), { expect: x.expect, why: x.why || "" }]));
}
export function withRulings(check, rulings = {}) {
  return async (file, opts) => {
    const r = rulings[resolve(file)];
    if (r?.expect === "fail") return { ok: false, failures: [`ruled out by the owner${r.why ? `: ${r.why}` : ""}`], faces: [], focus: [0.5, 0.5], placement: null };
    return check(file, r?.expect === "pass" ? { ...opts, skipQuality: true } : opts);
  };
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

/** How much a scene adds by bringing something new on each tag — the exercise most. */
export const VARIETY_WEIGHTS = { exercise: 3, age: 3, setting: 2, equipment: 2, muscles: 1 };

/**
 * For each photo to generate: the layout it is made for and a scene that suits the audience and that
 * layout's pose. Each photo takes the scene that adds the most the batch does not have yet — a new
 * exercise, age, setting, piece of equipment or muscle group — so ten photos are not six squats.
 * No scene repeats until every suitable one is used; layouts are spread; seeded.
 */
/** Does a scene show a must_show value? An exercise matches by name part: "squat" is any squat. */
export const shows = (scene, tag, value) => scene[tag] != null && (scene[tag] === value || (tag === "exercise" && String(scene[tag]).split("-").includes(value)) || (tag === "exercise" && String(scene[tag]).includes(value)));

/** must_show values no suitable scene can show — refused before planning. */
export function unshowable(mustShow = {}, scenes = []) {
  return Object.entries(mustShow || {}).flatMap(([tag, values]) => (values || []).filter((v) => !scenes.some((sc) => shows(sc, tag, v))).map((v) => `${tag} "${v}"`));
}

export function planVisuals({ count, scenes, audience, seed = "batch", mustShow = {}, catalogue = loadCatalogue(), ratio = "1x1", exclude = {} }) {
  if (!count) return [];
  const rand = rngFrom(`${seed}|visuals`);
  const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // A gendered callout ("LADIES WANTED") draws from its own scenes; the mixed ("any") scenes serve
  // ungendered callouts, and fill in only when the gendered scenes are fewer than the photos wanted
  // (2026-09-12: a women's batch had planned three mixed scenes with a man in frame).
  const own = scenes.filter((s) => !s.audience || s.audience === audience), mixed = scenes.filter((s) => s.audience === "any");
  const suits = shuffle(audience === "any" ? scenes.filter((s) => !s.audience || s.audience === "any") : own.length >= count ? own : [...own, ...mixed]);
  if (!suits.length) throw new Error(`no scene in the library suits a "${audience}" audience`);
  const layouts = shuffle(primaryLayouts(catalogue, ratio, exclude));
  const usedL = new Map(layouts.map((l) => [l, 0])), usedS = new Map(suits.map((s) => [s, 0]));
  const seen = Object.fromEntries(Object.keys(VARIETY_WEIGHTS).map((k) => [k, new Set()]));
  const uses = Object.fromEntries(Object.keys(VARIETY_WEIGHTS).map((k) => [k, new Map()]));
  // What the brief asked to see, still missing. Covering one outranks any amount of general variety.
  const wanted = Object.entries(mustShow || {}).flatMap(([tag, values]) => (values || []).map((value) => ({ tag, value })));
  const missing = unshowable(mustShow, suits);
  if (missing.length) throw new Error(`must_show asks for ${missing.join(", ")}, which no ${audience === "any" ? "" : audience + "'s "}scene in the library shows`);
  const out = [];
  // What was asked for stays even: adding to a must_show value that is already ahead of the others
  // on its tag costs a scene more than any general variety is worth, so young and older men (or solo,
  // coached and group) come out close to level — without making every tag level at once, which ten
  // photos cannot do.
  const shownCount = (tag, v) => out.filter((o) => shows(o.src, tag, v)).length;
  const ahead = (sc) => Object.entries(mustShow || {}).reduce((n, [tag, vals]) => {
    const low = Math.min(...(vals || []).map((v) => shownCount(tag, v)));
    return n + (vals || []).filter((v) => shows(sc, tag, v)).reduce((m, v) => m + (shownCount(tag, v) - low), 0);
  }, 0);
  for (let i = 0; i < count; i++) {
    let pick = null;
    for (const s of suits) {
      const asked = wanted.filter((w) => !w.done && shows(s, w.tag, w.value)).length;
      const novelty = Object.entries(VARIETY_WEIGHTS).reduce((n, [k, w]) => n + (s[k] != null && !seen[k].has(s[k]) ? w : 0), 0)
        // Once every value has appeared, keep them even: a fourth older man counts against a scene.
        - Object.entries(VARIETY_WEIGHTS).reduce((n, [k, w]) => n + (s[k] != null ? w * (uses[k].get(s[k]) || 0) * 0.6 : 0), 0);
      const tilt = ahead(s);
      // The layout this scene would be made for: the one it prefers (a scene drafted from a reference
      // image keeps the reference's framing), if its pose fits; else the least-used one that fits.
      const fits = layouts.filter((la) => !poseProblem(la, s.pose, catalogue));
      const la = fits.includes(s.prefer_layout) ? s.prefer_layout : fits.reduce((best, x) => (best === null || usedL.get(x) < usedL.get(best) ? x : best), null);
      if (la === null) continue;
      // A repeated scene is worst; then less new; then a busier layout. Ties keep the seeded order.
      const score = -usedS.get(s) * 100000 + asked * 1000 - tilt * 200 + novelty * 10 - usedL.get(la) * 4;
      if (!pick || score > pick.score) pick = { la, s, score };
    }
    if (!pick) throw new Error("no scene in the library fits any layout the batch can use");
    usedL.set(pick.la, usedL.get(pick.la) + 1); usedS.set(pick.s, usedS.get(pick.s) + 1);
    for (const k of Object.keys(VARIETY_WEIGHTS)) if (pick.s[k] != null) { seen[k].add(pick.s[k]); uses[k].set(pick.s[k], (uses[k].get(pick.s[k]) || 0) + 1); }
    for (const w of wanted) if (shows(pick.s, w.tag, w.value)) w.done = true;
    const tags = Object.fromEntries(["exercise", ...Object.keys(SCENE_TAGS)].filter((k) => pick.s[k] != null).map((k) => [k, pick.s[k]]));
    out.push({ id: `g${String(i + 1).padStart(2, "0")}`, treatment: pick.la, scene: pick.s.scene, scene_id: pick.s.id || null, pose: pick.s.pose, people: pick.s.people, tags, look: CHECK_LOOK });
    Object.defineProperty(out.at(-1), "src", { value: pick.s, enumerable: false }); // for the even-spread rule; not written out
  }
  const notShown = wanted.filter((w) => !w.done).map((w) => `${w.tag} "${w.value}"`);
  if (notShown.length) out.notShown = notShown; // too few photos for everything asked
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

// ── progress ──────────────────────────────────────────────────────────────

/**
 * `progress.json` in the batch folder: what a run is doing, photo by photo, for the panel's Generating
 * screen (and for anyone who reopens it mid-run). Replaced whole on every change, so a reader never
 * sees half a file; a failure to write it never stops the run.
 *   stage: photos → fit → looks → render → gallery → done | failed
 *   photos[id].state: queued · checking · generating · retrying · passed · flagged · skipped · error
 */
export function progressWriter(out, base) {
  const path = join(out, "progress.json");
  const state = { ...base, photos: { ...(base.photos || {}) } };
  const flush = () => {
    try {
      state.updated = new Date().toISOString();
      writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n");
      renameSync(path + ".tmp", path);
    } catch {}
  };
  flush();
  return {
    state,
    set(patch) { Object.assign(state, patch); flush(); },
    photo(id, patch) {
      const p = { ...(state.photos[id] || {}), ...patch };
      if (p.file) p.file = relative(out, resolve(out, p.file)); // kept relative to the batch folder
      state.photos[id] = p; flush();
    },
  };
}

// ── the run ───────────────────────────────────────────────────────────────

/**
 * Run a batch. Injectable for tests: generate, check (a generated photo's check), checkPhoto (a real
 * photo's tiled check), checkRef, compositor, gallery (builds gallery.html), log.
 */
export async function runBatch({ brandDir, brief, outDir = null, dryRun = false, renderOnly = false, approveScenes: confirmScenes = false, scenesPath = null, deps = {}, log = console.log }) {
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  // The reference palettes, the gym's brand palettes, or both (creative_defaults.palettes).
  const catalogue = catalogueFor(profile);
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
  const libraryPath = scenesPath || join(brandDir, "scenes.json");
  let scenes;
  if (brief.scenes) scenes = brief.scenes;
  else if (!g) scenes = [];
  else if (brief.direction) {
    // The owner confirmed this batch's drafted scenes (the panel's Run confirmation, or --approve-scenes).
    if (confirmScenes && !dryRun) {
      const ids = readLibrary(libraryPath).scenes.filter((s) => s.source === `batch:${brief.batch_id}` && isDraft(s)).map((s) => s.id);
      if (ids.length) { approveScenes(libraryPath, ids, { via: brief.batch_id }); log(`· direction: ${ids.length} scene(s) confirmed for this batch: ${ids.join(", ")}`); }
    }
    scenes = await directedScenes({ brandDir, brief, scenesPath: libraryPath, audience: sceneAudience(audience, brief.scene_audience), dryRun, renderOnly, ...(deps.draft ? { draft: deps.draft } : {}), log });
  } else scenes = loadScenes(libraryPath, { allowDraft: dryRun });
  const plannedPath = join(out, "visuals.json");
  let visuals;
  if (renderOnly && existsSync(plannedPath)) visuals = JSON.parse(readFileSync(plannedPath, "utf-8")).visuals;
  else visuals = planVisuals({ count: g, scenes, audience: sceneAudience(audience, brief.scene_audience), seed, mustShow: brief.must_show, catalogue, ratio, exclude });
  if (visuals.notShown) log(`  note: too few photos to show everything asked — not shown: ${visuals.notShown.join(", ")}`);
  for (const v of visuals) for (const w of sceneWarnings({ scene: v.scene, people: v.people, setting: v.tags?.setting })) log(`  warning: ${v.id} (${v.scene_id || "brief scene"}): ${w}`);
  for (const v of visuals) { const p = poseProblem(v.treatment, v.pose, catalogue); if (p) throw new Error(`${v.id}: ${p}`); }
  const reference = brief.reference || brief.real?.[0] || null;
  const plan = { batch_id: brief.batch_id, audience_for_scenes: sceneAudience(audience, brief.scene_audience), reference, visuals, max_calls: brief.max_calls ?? g, attempts: brief.attempts ?? 1 };
  writeFileSync(plannedPath, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(out, "brief.json"), JSON.stringify(brief, null, 2) + "\n"); // the brief as run
  log(`· plan: ${visuals.length} photo(s) to generate (${visuals.map((v) => `${v.id} for ${shortLayout(v.treatment)}: ${v.scene_id || "brief scene"}`).join("; ") || "none"}), ${(brief.real || []).length} real; ${looks} look(s) each × ${brief.locations.length} location(s); at most ${plan.max_calls} image call(s)`);
  if (dryRun) return { dryRun: true, plan, out };
  // What this run is doing, photo by photo: the panel's Generating screen reads it (progress.json).
  const prog = progressWriter(out, { batch_id: brief.batch_id, run: renderOnly ? "render-only" : "run", started: new Date().toISOString(), stage: "photos", max_calls: plan.max_calls, attempts: plan.attempts, spent_before: 0, calls: 0, real: (brief.real || []).length, ads: null, failed: 0, error: null,
    photos: Object.fromEntries(visuals.map((v) => [v.id, { scene_id: v.scene_id || null, scene: v.scene, treatment: v.treatment, state: "queued" }])) });
  try {

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
    const picsPath = join(out, "pictures.json"), spendPath = join(out, "spend.json"), visualsDir = join(out, "visuals");
    const prior = existsSync(picsPath) ? JSON.parse(readFileSync(picsPath, "utf-8")) : {};
    // A photo is reused only if it passed today's checks. A free re-render (words only) keeps photos
    // passed under older checks and says so — re-checking them would be a run, not a re-render.
    const rulings = deps.rulings || loadRulings(brandDir);
    const passedFor = (a, v) => a && a.status === "passed" && a.scene === v.scene && a.treatment === v.treatment && existsSync(a.file) && rulings[resolve(a.file)]?.expect !== "fail";
    const same = (a, v) => passedFor(a, v) && (renderOnly || a.checks === CHECKS_VERSION);
    let todo = renderOnly ? [] : visuals.filter((v) => !same(prior[v.id], v));
    if (renderOnly) {
      const missing = visuals.filter((v) => !same(prior[v.id], v)); if (missing.length) log(`· render-only: ${missing.map((v) => v.id).join(", ")} have no passed photo on disk and are left out`);
      const older = visuals.filter((v) => same(prior[v.id], v) && prior[v.id].checks !== CHECKS_VERSION); if (older.length) log(`· render-only: ${older.map((v) => v.id).join(", ")} passed before today's checks — a full run re-checks them (no image calls)`);
    }
    // max_calls is the budget for the batch, not for each run: a re-run spends only what is left
    // (the 48-ad batch showed a re-run would otherwise have had its full allowance again).
    const oldBatch = existsSync(join(out, "batch.json")) ? JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")) : null;
    const spentBefore = existsSync(spendPath) ? JSON.parse(readFileSync(spendPath, "utf-8")).image_calls : (oldBatch?.image_calls ?? 0);
    prog.set({ spent_before: spentBefore });
    for (const v of visuals) {
      const a = prior[v.id];
      if (same(a, v)) prog.photo(v.id, { state: "passed", file: a.file, reused: true, notes: a.notes || [], own_layout_failed: a.own_layout_failed || null });
      else if (renderOnly) prog.photo(v.id, { state: "skipped", failures: ["no passed photo on disk"] });
    }
    const record = (r, file, c) => ({ status: r.status, scene: r.scene, treatment: r.treatment, file, ...(r.status === "passed" ? { checks: CHECKS_VERSION } : {}), ...(r.own_layout_failed ? { own_layout_failed: r.own_layout_failed } : {}), check: c ? { faces: c.faces, focus: c.focus, placement: c.placement } : null, notes: c?.notes || [], quality: c?.quality ? { failures: c.quality.failures, minor: c.quality.minor, dismissed: c.quality.dismissed, exercise_seen: c.quality.exercise_seen, interaction_seen: c.quality.interaction_seen } : null, failures: c?.failures || (r.reason ? [r.reason] : []) });
    // Photos already on disk get a look with today's checks before anything new is made — free of
    // image calls. That covers photos an earlier run rejected (the 48-ad batch: good photos had been
    // rejected for their own mirror reflections) and photos passed before today's checks existed. The
    // photo in use is looked at first, so a batch keeps its photos when they still pass.
    const check = withRulings(deps.check || checkPicture, rulings);
    if (todo.length) {
      const compositor = deps.compositor !== undefined ? deps.compositor : makeCompositor(catalogue);
      const earlier = (v) => {
        if (!(prior[v.id]?.scene === v.scene && prior[v.id]?.treatment === v.treatment && existsSync(visualsDir))) return [];
        const files = readdirSync(visualsDir).filter((n) => new RegExp(`^${v.id}(-a\\d+)?\\.(png|jpe?g|webp)$`).test(n)).map((n) => join(visualsDir, n)).reverse();
        const inUse = prior[v.id].status === "passed" ? prior[v.id].file : null;
        return inUse && files.includes(inUse) ? [inUse, ...files.filter((f) => f !== inUse)] : files;
      };
      try {
        for (const v of todo) {
          let last = null, pictureGood = null;
          if (earlier(v).length) prog.photo(v.id, { state: "checking", attempt: null });
          for (const file of earlier(v)) {
            const c = await assess(file, v, { ratio, text: texts[0], check, compositor, outDir: visualsDir, never: photography.never || [] });
            if (c.ok) { prior[v.id] = record({ ...v, status: "passed" }, file, c); log(`✓ ${v.id}: ${basename(file)} on disk passes today's checks — no new image needed`); last = null; break; }
            if (c.picture_ok) pictureGood = { file, c };
            last = { file, c };
            log(`⚑ ${v.id}: ${basename(file)} fails today's checks: ${c.failures.join(" | ")}`);
          }
          // Passes the picture checks, not its own layout: kept for the layouts it fits (as generateVisuals does).
          if (last && pictureGood) { prior[v.id] = record({ ...v, status: "passed", own_layout_failed: pictureGood.c.failures }, pictureGood.file, pictureGood.c); log(`✓ ${v.id}: ${basename(pictureGood.file)} passes the picture checks; its own layout did not work out — kept for the layouts it fits`); }
          else if (last) prior[v.id] = record({ ...v, status: "flagged" }, last.file, last.c);
          const a = prior[v.id];
          prog.photo(v.id, same(a, v) ? { state: "passed", file: a.file, reused: true, notes: a.notes || [], own_layout_failed: a.own_layout_failed || null } : { state: "queued" });
        }
      } finally { if (deps.compositor === undefined) await compositor?.close(); }
      todo = todo.filter((v) => !same(prior[v.id], v));
    }
    let calls = 0;
    const left = Math.max(0, plan.max_calls - spentBefore);
    if (todo.length && !left) log(`- the batch's budget of ${plan.max_calls} image calls is spent: ${todo.map((v) => v.id).join(", ")} not generated`);
    if (todo.length && !left) for (const v of todo) prog.photo(v.id, { state: "skipped", failures: [`the batch's budget of ${plan.max_calls} image calls is spent`] });
    if (todo.length && left) {
      const rep = await generateVisuals({
        visuals: todo, text: texts[0], photography, brandNames, outDir: visualsDir, ratio,
        refs: reference ? [at(reference)] : [], maxCalls: left, attempts: plan.attempts,
        ...(deps.generate ? { generate: deps.generate } : {}), check, ...(deps.checkRef ? { checkRef: deps.checkRef } : {}), ...(deps.compositor !== undefined ? { compositor: deps.compositor } : {}), log,
        onProgress: (e) => {
          if (e.event === "generating") prog.photo(e.id, { state: "generating", attempt: e.attempt });
          else if (e.event === "checking") prog.photo(e.id, { state: "checking", attempt: e.attempt, file: e.file });
          else if (e.event === "tried" && e.status !== "passed" && e.attempt < plan.attempts) prog.photo(e.id, { state: "retrying", attempt: e.attempt, failures: e.failures });
          else if (e.event === "done") prog.photo(e.id, { state: e.status, attempt: e.attempt, file: e.file, failures: e.failures, notes: e.notes, own_layout_failed: e.own_layout_failed });
          if (e.calls != null) prog.set({ calls: e.calls });
        },
      });
      calls = rep.image_calls;
      for (const r of rep.results) prior[r.id] = record(r, r.file, r.check);
    }
    const spent = spentBefore + calls;
    writeFileSync(spendPath, JSON.stringify({ image_calls: spent, max_calls: plan.max_calls }, null, 2) + "\n");
    writeFileSync(picsPath, JSON.stringify(prior, null, 2) + "\n");
    for (const v of visuals) {
      const a = prior[v.id];
      if (!same(a, v)) { if (!["flagged", "error", "skipped"].includes(prog.state.photos[v.id]?.state)) prog.photo(v.id, { state: a?.status === "flagged" ? "flagged" : "skipped", failures: a?.failures || [] }); log(`- ${v.id}: no passing photo (${a?.failures?.join("; ") || "not generated"}) — left out of the batch`); continue; }
      // A photo whose own layout did not work out has no primary look: the planner places it where it fits.
      photos.unshift({ id: v.id, kind: "generated", file: a.file, primary: a.own_layout_failed ? null : v.treatment, scene_id: v.scene_id, notes: [...(a.notes || []), ...(a.own_layout_failed ? [`not used in its own layout: ${a.own_layout_failed.join("; ")}`] : [])], answer: { people_box: a.check.placement.people_box, face_boxes: a.check.faces, people_count: a.check.placement.people_count }, expectPeople: true, maxPeople: v.people });
    }
    photos.sort((a, b) => a.id.localeCompare(b.id));
    if (!photos.length) throw new Error("no photos passed: nothing to render");

    // ── 3 fit ──
    prog.set({ stage: "fit", calls });
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
    prog.set({ stage: "looks" });
    const browser = deps.browser || await launchBrowser();
    let results;
    try {
      const stats = await measurePhotos(browser, photos.map((p) => p.file), { ratio });
      const planned = assignVariants({ visuals: photos.map((p) => ({ id: p.id })), perVisual: looks, text: { location: brief.locations[0], audience }, seed, exclude, photoStats: stats, allowed, prefer: Object.fromEntries(photos.filter((p) => p.primary).map((p) => [p.id, p.primary])), catalogue, ratio });
      for (const n of planned.notes) log(`  note: ${n}`);

      // ── 5 render ──
      prog.set({ stage: "render" });
      const fileOf = Object.fromEntries(photos.map((p) => [p.id, p.file]));
      results = await renderPlan(browser, planned, { texts, imageFor: (id) => fileOf[id], facesFor: (id) => faces[id], focusFor: (id, la) => focus[id]?.[la] || null, catalogue });
    } finally { if (!deps.browser) await browser.close(); }

    // ── 6 gallery ──
    prog.set({ stage: "gallery" });
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
    // image_calls is what the batch has cost in all, across runs: a free re-render must not wipe out the
    // record of the calls that made its photos (the panel showed "0 image calls" after one).
    const batch = {
      batch_id: brief.batch_id, made: new Date().toISOString(), ratio, image_calls: spent, image_calls_this_run: calls,
      photos: photos.map((p) => ({ id: p.id, kind: p.kind, file: p.source || p.file, primary: p.primary || null, scene_id: p.scene_id || null, ...(p.notes?.length ? { notes: p.notes } : {}), allowed: allowed[p.id], fit: p.fit })),
      ads, failed,
    };
    writeFileSync(join(out, "batch.json"), JSON.stringify(batch, null, 2) + "\n");
    // What the checks noticed about each ad's photos but did not reject, for the gallery's headings —
    // the owner picks with the notes in view (2026-09-12: "the selection step is an additional check").
    const noteOf = (id) => (photos.find((p) => p.id === id)?.notes || []).map((n) => `${id}: ${n}`);
    const galleryNotes = Object.fromEntries(ads.map((a) => [a.folder, a.photos.flatMap(noteOf).join(" · ")]).filter(([, n]) => n));
    writeFileSync(join(out, "gallery-notes.json"), JSON.stringify(galleryNotes, null, 2) + "\n");
    const gallery = deps.gallery || ((dir) => execFileSync(process.execPath, [join(HERE, "gallery-selector.mjs"), "--output-dir", dir], { stdio: "ignore" }));
    gallery(out);
    prog.set({ stage: "done", ads: ads.length, failed: failed.length, image_calls: spent });
    log(`· ${ads.length} ad(s) in ${out} (${results.filter((r) => !r.failed).length} looks × ${brief.locations.length} location(s))${failed.length ? `; ${failed.length} look(s) failed to verify and are left out` : ""}; ${calls} image call(s) this run, ${batch.image_calls} for the batch in all`);
    return { out, batch, calls, results };
  } catch (e) { prog.set({ stage: "failed", error: e.message }); throw e; }
}


/** The run is over: say so and leave. Something (a socket, a timer) has kept a finished run alive for minutes
 *  before — the panel then shows "running" over a batch that is done — so the CLI ends the process itself,
 *  after its last line has been written. BATCH_DEBUG_HANDLES=1 names what was still open. */
export function exitWhenWritten(code = 0) {
  if (process.env.BATCH_DEBUG_HANDLES) console.error(`still open at exit: ${process.getActiveResourcesInfo().join(", ") || "nothing"}`);
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, brief: { type: "string" }, out: { type: "string" },
    "dry-run": { type: "boolean", default: false }, "render-only": { type: "boolean", default: false },
    "approve-scenes": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.brief) {
    console.error("Usage: plan-offer-batch.mjs --brand-dir <brands/x> --brief <batches/id/brief.json> [--dry-run] [--render-only] [--approve-scenes] [--out <dir>]");
    process.exit(1);
  }
  const brandDir = resolve(v["brand-dir"]);
  const briefPath = [resolve(v.brief), join(brandDir, v.brief)].find(existsSync);
  if (!briefPath) { console.error(`brief not found: ${v.brief}`); process.exit(1); }
  try {
    const r = await runBatch({ brandDir, brief: JSON.parse(readFileSync(briefPath, "utf-8")), outDir: v.out, dryRun: v["dry-run"], renderOnly: v["render-only"], approveScenes: v["approve-scenes"] });
    if (!r.dryRun) console.log(`gallery: ${join(r.out, "gallery.html")}`);
    exitWhenWritten(0);
  } catch (e) {
    console.error(e.message);
    exitWhenWritten(1);
  }
}
