#!/usr/bin/env node
/**
 * make-stories.mjs — Stories/Reels (9:16) versions of the ads the owner selected (Step 8).
 *
 * Input: a finished batch (plan-offer-batch.mjs) and the gallery's selections.json in its folder.
 * Every selected ad gets a 9:16 sibling with the same photo subject, look and words, inside Meta's
 * safe zone, saved beside its 1:1 so the pair uploads together.
 *
 *   1 plan      which photos need a 9:16 photo — one per photo, not per ad. Only single-photo layouts
 *               (T1–T6) do: a collage (T7) tiles and panels (T8) circle the existing photos in 9:16.
 *   2 pictures  a generated photo gets a native 9:16 sibling: the chosen 1:1 goes first as the anchor
 *               (the scene itself), the room reference second, the prompt built for the 9:16 layout of
 *               its first look. The batch's checks, plus a sibling check (same people, same clothes).
 *               Fitted against each of the photo's looks at 9:16; a look it does not fit gets its own
 *               photo. A real photo (a wide room shot) gets a fitted band instead — the photo across
 *               the live band, a blurred, darkened copy of itself filling the frame — no image call.
 *   3 render    every selected ad's 9:16 with its own look and words, per location, into
 *               {folder}/9x16/…_9x16_v1.png. The safe-area verifier fails any leak; a look that cannot
 *               verify in 9:16 is recorded and left out — never swapped, a Stories version must match
 *               its 1:1.
 *   4 record    stories.json (each ad → its 9:16 photo, crop, faces); the gallery rebuilt with both
 *               ratios.
 *
 * --dry-run says what would be made and what it may cost. --render-only re-renders from the 9:16
 * photos on disk (new words in the brief): zero image calls. The call cap is for this batch's stories
 * across runs (spend.json → stories_image_calls); every attempt is kept on disk, never overwritten.
 *
 * Usage:
 *   node skills/references/make-stories.mjs --brand-dir brands/sculpt-society --batch 2026-09-11-men-variety \
 *     [--max-calls 24] [--attempts 2] [--dry-run] [--render-only]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, basename, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { loadCatalogue, launchBrowser, layoutFor, imageDataUrl } from "./render-composites.mjs";
import { fitLayouts, imageSize } from "./check-visual.mjs";
import { poseProblem } from "./visual-prompts.mjs";
import { checkSibling } from "./check-quality.mjs";
import { renderPlan } from "./assign-variants.mjs";
import { generateVisuals, assess, makeCompositor, checkPicture } from "./generate-visuals.mjs";
import { resolveSelections, loadRulings, withRulings, CHECKS_VERSION } from "./plan-offer-batch.mjs";
import { inPage, LOAD } from "./clean-photo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RATIO = "9x16";
export const DEFAULT_MAX_CALLS = 24;
/** Which checks a passed 9:16 photo has been through (the batch's, plus the sibling check). */
export const STORIES_CHECKS = `${CHECKS_VERSION}-s1`;
const CHECK_LOOK = { style: "s1-heavy-sans", palette: "white-on-dark" };
/** The fitted band for a wide real photo: the copy behind it is blurred and darkened, as T8's 9:16 backdrop. */
export const BAND = { blur_pct: 4, darken: 0.45 };
const short = (id) => id.split("-")[0];

/**
 * Which 9:16 photos the selected ads need: one per photo that appears in a single-photo look, with
 * the layouts it must fit — its own primary layout first, so it is composed for the look it was made
 * for. Collage and panels ads need none. Pure.
 */
export function planStories(batch, chosen, { catalogue = loadCatalogue() } = {}) {
  const T = catalogue.treatments;
  const photoOf = Object.fromEntries(batch.photos.map((p) => [p.id, p]));
  const needs = {};
  const ads = chosen.map((ad) => {
    const background = layoutFor(T.treatments[ad.treatment], RATIO, T).background?.type || "single";
    if (background === "single") {
      const p = photoOf[ad.photos[0]];
      if (!p) throw new Error(`${ad.folder}: photo ${ad.photos[0]} is not in batch.json`);
      const n = (needs[p.id] ||= { id: p.id, kind: p.kind, file: p.file, scene_id: p.scene_id || null, primary: p.primary || null, layouts: [] });
      if (!n.layouts.includes(ad.treatment)) n.layouts.push(ad.treatment);
    }
    return { ...ad, background };
  });
  const photos = Object.values(needs).sort((a, b) => a.id.localeCompare(b.id));
  for (const p of photos) p.layouts.sort((a, b) => (a === p.primary ? -1 : b === p.primary ? 1 : 0));
  return { photos, ads, generated: photos.filter((p) => p.kind === "generated").length, real: photos.filter((p) => p.kind !== "generated").length };
}

/**
 * The window a 1:1 ad shows of its photo: the renderer's cover-fit at the ad's focus, in photo pixels
 * ([x, y, w, h]). A portrait photo gives a full-width square slid up or down by fy; a landscape one a
 * full-height square slid by fx. What the 1:1 check judged is exactly this window.
 */
export function cropWindow([iw, ih], [fx, fy] = [0.5, 0.5], [W, H] = [1080, 1080]) {
  const sc = Math.max(W / iw, H / ih), dw = iw * sc, dh = ih * sc;
  const ox = (W - dw) * fx, oy = (H - dh) * fy;
  return [-ox / sc, -oy / sc, W / sc, H / sc].map((v) => Math.round(v * 100) / 100 + 0); // + 0: never -0
}

/**
 * A 9:16 photo made with no image call: a blurred, darkened copy fills the frame and the photo (or
 * the window `crop` of it, in photo pixels) sits across the live band (y 14–65%), fitted to its width
 * or height and centred. Returns where it landed, [x, y, w, h] in pixels.
 */
export async function bandImage(browser, src, out, { canvas = [1080, 1920], live = [0.14, 0.65], crop = null, blur_pct = BAND.blur_pct, darken = BAND.darken } = {}) {
  const [W, H] = canvas;
  const r = await inPage(browser, `${LOAD}
const im = await load(${JSON.stringify(imageDataUrl(src))});
const [sx, sy, sw, sh] = ${JSON.stringify(crop)} || [0, 0, im.naturalWidth, im.naturalHeight];
const W = ${W}, H = ${H}, c = document.createElement("canvas"); c.width = W; c.height = H;
const ctx = c.getContext("2d");
const blur = ${blur_pct / 100} * W, m = blur * 3;
const sc = Math.max((W + 2 * m) / sw, (H + 2 * m) / sh), dw = sw * sc, dh = sh * sc;
ctx.save(); ctx.filter = "blur(" + blur + "px)";
ctx.drawImage(im, sx, sy, sw, sh, -m + (W + 2 * m - dw) / 2, -m + (H + 2 * m - dh) / 2, dw, dh);
ctx.restore();
ctx.fillStyle = "rgba(0,0,0,${darken})"; ctx.fillRect(0, 0, W, H);
const y0 = ${live[0]} * H, y1 = ${live[1]} * H, maxH = y1 - y0;
let w = W, h = (W * sh) / sw;
if (h > maxH) { h = maxH; w = (h * sw) / sh; }
const x = (W - w) / 2, y = y0 + (maxH - h) / 2;
ctx.drawImage(im, sx, sy, sw, sh, x, y, w, h);
return { png: c.toDataURL("image/png").split(",")[1], band: [x, y, w, h] };`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(r.png, "base64"));
  return r.band.map(Math.round);
}

/**
 * A photo's check answer (boxes per mille of the whole photo) moved onto the 9:16 canvas the band drew
 * it on — through the crop window when the band shows one. A box that falls outside the window is
 * clipped to it.
 */
export function inBand(answer, [bx, by, bw, bh], { crop = null, size = null, canvas = [1080, 1920] } = {}) {
  const [W, H] = canvas;
  const [iw, ih] = size || [1000, 1000];
  const [cx, cy, cw, ch] = crop || [0, 0, iw, ih];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const box = ([y0, x0, y1, x1]) => {
    const X = (v) => Math.round(((bx + (clamp((v / 1000) * iw, cx, cx + cw) - cx) / cw * bw) / W) * 1000);
    const Y = (v) => Math.round(((by + (clamp((v / 1000) * ih, cy, cy + ch) - cy) / ch * bh) / H) * 1000);
    return [Y(y0), X(x0), Y(y1), X(x1)];
  };
  return { people_box: answer?.people_box ? box(answer.people_box) : null, face_boxes: (answer?.face_boxes || []).map(box).filter(([y0, x0, y1, x1]) => y1 > y0 && x1 > x0), people_count: answer?.people_count ?? 0 };
}

/** The 9:16 file beside an ad's 1:1: the same folder and name, 9x16 for 1x1. */
export const storiesFile = (file1x1) => file1x1.replace("/1x1/", `/${RATIO}/`).replace("_1x1_", `_${RATIO}_`);

/**
 * Stories for one batch. `deps` (tests): generate, check, sibling, compositor, browser, gallery.
 * Returns { out, plan, stories, calls } (or { out, plan, dryRun: true }).
 */
export async function runStories({ brandDir, batchId, batchDir = null, maxCalls = DEFAULT_MAX_CALLS, attempts = 2, dryRun = false, renderOnly = false, deps = {}, log = console.log }) {
  const catalogue = loadCatalogue();
  const T = catalogue.treatments;
  const out = batchDir || join(brandDir, "outputs", batchId);
  if (!existsSync(join(out, "batch.json"))) throw new Error(`no finished batch at ${out}`);
  if (!existsSync(join(out, "selections.json"))) throw new Error(`no selections.json in ${out}: open the gallery, pick, Save Selections, and put the file in the batch folder`);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("max-calls must be a whole number");
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
  const brief = JSON.parse(readFileSync(join(out, "brief.json"), "utf-8"));
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const photography = profile.brand_lock?.photography || {}, brandNames = [profile.display_name].filter(Boolean);
  const visualsById = Object.fromEntries((existsSync(join(out, "visuals.json")) ? JSON.parse(readFileSync(join(out, "visuals.json"), "utf-8")).visuals : []).map((v) => [v.id, v]));
  const pictures = existsSync(join(out, "pictures.json")) ? JSON.parse(readFileSync(join(out, "pictures.json"), "utf-8")) : {};
  const at = (p) => (existsSync(p) ? p : existsSync(join(brandDir, "brand-assets", p)) ? join(brandDir, "brand-assets", p) : resolve(p));

  // ── 1 plan ──
  const chosen = resolveSelections(out);
  if (!chosen.length) throw new Error("selections.json chooses no ads");
  const plan = planStories(batch, chosen, { catalogue });
  const gen = plan.photos.filter((p) => p.kind === "generated"), real = plan.photos.filter((p) => p.kind !== "generated");
  const singles = plan.ads.filter((a) => a.background === "single").length;
  log(`· stories: ${chosen.length} selected ad(s); ${singles} need a 9:16 photo — ${gen.length} generated (${gen.map((p) => `${p.id} for ${p.layouts.map(short).join("/")}`).join(", ") || "none"})${real.length ? `, ${real.length} real as a fitted band (${real.map((p) => p.id).join(", ")})` : ""}; ${plan.ads.length - singles} collage/panels ad(s) reuse their photos; at most ${maxCalls} image call(s) for this batch's stories in all`);
  if (dryRun) return { out, plan, dryRun: true };

  // ── 2 pictures ──
  const visualsDir = join(out, "visuals"), storiesPath = join(out, "stories.json"), spendPath = join(out, "spend.json");
  mkdirSync(visualsDir, { recursive: true });
  const existing = existsSync(storiesPath) ? JSON.parse(readFileSync(storiesPath, "utf-8")) : {};
  const prior = existing.photos || {};
  const spend = existsSync(spendPath) ? JSON.parse(readFileSync(spendPath, "utf-8")) : {};
  const spentBefore = spend.stories_image_calls ?? existing.image_calls ?? 0;
  // The words, one set per location, from the batch's own ads — never re-typed here.
  const texts = [...new Map(batch.ads.map((a) => [a.location, a.words])).values()];
  const rulings = deps.rulings || loadRulings(brandDir);
  const baseCheck = deps.check || checkPicture, sibling = deps.sibling || checkSibling;
  // The batch's checks, then — only when they pass — the sibling check against the chosen photo.
  const check = withRulings(async (file, opts) => {
    const pic = await baseCheck(file, opts);
    if (!pic.ok || opts.skipQuality || !opts.anchor) return pic;
    let s;
    try { s = await sibling(opts.anchor, file); } catch (e) { s = { ok: false, failures: [`sibling check could not run: ${e.message}`], notes: [] }; }
    return { ...pic, ok: s.ok, failures: [...(pic.failures || []), ...s.failures], notes: [...(pic.notes || []), ...(s.notes || [])], sibling: { ok: s.ok, failures: s.failures, notes: s.notes || [] } };
  }, rulings);
  const passedFor = (a, v) => a && a.status === "passed" && a.treatment === v.treatment && existsSync(a.file) && rulings[resolve(a.file)]?.expect !== "fail";
  const same = (a, v) => passedFor(a, v) && (renderOnly || a.checks === STORIES_CHECKS);
  const record = (r, file, c) => ({ status: r.status, kind: "generated", for: r.for, treatment: r.treatment, file, ...(r.status === "passed" ? { checks: STORIES_CHECKS } : {}), answer: c?.placement ? { people_box: c.placement.people_box, face_boxes: c.faces, people_count: c.placement.people_count } : null, notes: c?.notes || [], failures: c?.failures || (r.reason ? [r.reason] : []) });
  const visualFor = (p, la, id) => {
    const v = visualsById[p.id];
    if (!v) throw new Error(`${p.id}: no scene in visuals.json — the batch must have generated it`);
    return { id, for: p.id, treatment: la, scene: v.scene, scene_id: v.scene_id, pose: v.pose, people: v.people, tags: v.tags, look: CHECK_LOOK, anchor: at(p.file) };
  };
  let calls = 0;
  // The count is written after every generation, so a run that stops half-way never loses what it
  // spent (the first live run crashed after 15 calls and recorded none).
  const checkpoint = () => {
    writeFileSync(spendPath, JSON.stringify({ ...spend, stories_image_calls: spentBefore + calls, stories_max_calls: maxCalls }, null, 2) + "\n");
    writeFileSync(storiesPath, JSON.stringify({ ...existing, batch_id: batch.batch_id, ratio: RATIO, photos: prior, image_calls: spentBefore + calls, max_calls: maxCalls, partial: true }, null, 2) + "\n");
  };
  const compositor = deps.compositor !== undefined ? deps.compositor : makeCompositor();
  const reference = brief.reference || brief.real?.[0] || null;
  const earlier = (v) => (existsSync(visualsDir) ? readdirSync(visualsDir).filter((n) => new RegExp(`^${v.id}(-a\\d+)?\\.(png|jpe?g|webp)$`).test(n)).map((n) => join(visualsDir, n)).sort().reverse() : []);
  // Photos already on disk are looked at first — free of image calls; the one in use first.
  const settle = async (wanted) => {
    let todo = renderOnly ? [] : wanted.filter((v) => !same(prior[v.id], v));
    for (const v of todo) {
      const files = earlier(v), inUse = prior[v.id]?.status === "passed" ? prior[v.id].file : null;
      let last = null;
      for (const file of inUse && files.includes(inUse) ? [inUse, ...files.filter((f) => f !== inUse)] : files) {
        const c = await assess(file, v, { ratio: RATIO, text: texts[0], check, compositor, outDir: visualsDir, never: photography.never || [] });
        if (c.ok) { prior[v.id] = record({ ...v, status: "passed" }, file, c); log(`✓ ${v.id}: ${basename(file)} on disk passes today's checks — no new image needed`); last = null; break; }
        last = { file, c };
        log(`⚑ ${v.id}: ${basename(file)} fails today's checks: ${c.failures.join(" | ")}`);
      }
      if (last) prior[v.id] = record({ ...v, status: "flagged" }, last.file, last.c);
    }
    todo = todo.filter((v) => !same(prior[v.id], v));
    // Attempts already on disk count: a re-run does not try a systematic failure (T1's 9:16 placement)
    // `attempts` more times — the first live run spent 8 calls that way before the band stood in.
    const spent9 = todo.filter((v) => earlier(v).length >= attempts);
    for (const v of spent9) log(`- ${v.id}: ${earlier(v).length} attempt(s) on disk already, none passing — no more tries`);
    todo = todo.filter((v) => !spent9.includes(v));
    const left = Math.max(0, maxCalls - spentBefore - calls);
    if (todo.length && !left) log(`- the stories budget of ${maxCalls} image calls is spent: ${todo.map((v) => v.id).join(", ")} not generated`);
    if (todo.length && left) {
      const rep = await generateVisuals({
        visuals: todo, text: texts[0], photography, brandNames, outDir: visualsDir, ratio: RATIO,
        refs: reference ? [at(reference)] : [], anchorFor: (v) => v.anchor, maxCalls: left, attempts,
        // The room reference was text-checked when the batch was made; not again here.
        checkRef: deps.checkRef || (async () => []),
        ...(deps.generate ? { generate: deps.generate } : {}), check, ...(deps.compositor !== undefined ? { compositor: deps.compositor } : {}), log,
      });
      calls += rep.image_calls;
      for (const r of rep.results) prior[r.id] = record(r, r.file, r.check);
      checkpoint();
    }
  };
  const fitOf = (rec, maxPeople, expectPeople = true) => fitLayouts(rec.answer, { ratio: RATIO, imageSize: imageSize(readFileSync(rec.file)), expectPeople, maxPeople, catalogue });
  const allowed = {}, focus = {}, faces = {};
  const admit = (id, rec, maxPeople, expectPeople = true) => {
    const fit = fitOf(rec, maxPeople, expectPeople);
    allowed[id] = Object.keys(fit).filter((la) => fit[la].ok);
    focus[id] = Object.fromEntries(Object.entries(fit).map(([la, f]) => [la, f.focus]));
    faces[id] = rec.answer?.face_boxes || [];
    return fit;
  };
  try {
    // First: one 9:16 photo per generated photo, composed for its first look.
    await settle(gen.map((p) => visualFor(p, p.layouts[0], `${p.id}-${RATIO}`)));
    for (const p of gen) if (same(prior[`${p.id}-${RATIO}`], { treatment: p.layouts[0] })) admit(`${p.id}-${RATIO}`, prior[`${p.id}-${RATIO}`], visualsById[p.id]?.people ?? null);
    // Then: a look the photo does not fit at 9:16 gets its own photo, composed for that look.
    const extras = [];
    for (const p of gen) for (const la of p.layouts.slice(1)) {
      if ((allowed[`${p.id}-${RATIO}`] || []).includes(la)) continue;
      // A second look the 1:1 batch gave this photo by fit, not by composition: its pose may forbid
      // composing for it (a compact cable row for T2). Then the band below stands in.
      const pp = poseProblem(la, visualsById[p.id]?.pose, catalogue);
      if (pp) { log(`- ${p.id}: no 9:16 photo is composed for ${short(la)} (${pp.split(" (")[0]}) — the chosen photo as a band instead`); continue; }
      extras.push(visualFor(p, la, `${p.id}-${RATIO}-${short(la)}`));
    }
    if (extras.length) { log(`· ${extras.length} look(s) not fitted by the first 9:16 photo: ${extras.map((v) => v.id).join(", ")} — composed for that layout`); await settle(extras); }
    for (const v of extras) if (same(prior[v.id], v)) admit(v.id, prior[v.id], v.people);
  } finally { if (deps.compositor === undefined) await compositor?.close(); }

  // Which 9:16 photo serves a look: the native one, one composed for that layout, else the band of the
  // 1:1 ad's own crop of the photo.
  const bandId = (pid, la) => `${pid}-${RATIO}-band-${short(la)}`;
  const photo9For = (pid, la) => [`${pid}-${RATIO}`, `${pid}-${RATIO}-${short(la)}`, bandId(pid, la)].find((id) => prior[id]?.status === "passed" && existsSync(prior[id].file) && (allowed[id] || []).includes(la)) || null;
  // Real photos: a fitted band, no image call. Nothing to check — the photo was checked clean for the batch.
  const browser = deps.browser || await launchBrowser();
  try {
    // A generated photo with no passing native 9:16 for a look: the 1:1 ad's own crop of the photo as
    // a band, no image call. The 9:16 layouts are derived from the 1:1 ones inside the live area, so
    // the crop's proven placement carries over (its check boxes move with it) — placement is inherited
    // rather than fought for: the model centres a 9:16 subject whatever the prompt says, and T1/T5's
    // 9:16 need it high (the first live run: 3 of 10 photos, 2 tries each).
    const bandFor = async (p, la, why) => {
      const id = bandId(p.id, la);
      if (!(prior[id]?.status === "passed" && existsSync(prior[id].file))) {
        const src = at(p.file), size = imageSize(readFileSync(src));
        const ad = batch.ads.find((a) => a.photos[0] === p.id && a.photos.length === 1 && a.treatment === la);
        const crop = cropWindow(size, ad?.crop?.[0] || [0.5, 0.5]);
        const file = join(visualsDir, `${id}.png`), band = await bandImage(browser, src, file, { crop }), pic = pictures[p.id]?.check;
        const answer = inBand(pic?.placement ? { people_box: pic.placement.people_box, face_boxes: pic.faces, people_count: pic.placement.people_count } : null, band, { crop, size });
        prior[id] = { status: "passed", kind: "band", for: p.id, treatment: la, file, band, crop, checks: STORIES_CHECKS, answer, notes: [`the 1:1 ad's crop of the chosen photo as a band: ${why}`], failures: [] };
        log(`· ${p.id}: ${short(la)} from the chosen photo's 1:1 crop as a band (no image call)`);
      }
      const fit = admit(id, prior[id], visualsById[p.id]?.people ?? null);
      // The 9:16 layouts are derived from the 1:1 ones with different horizontal and vertical scales,
      // so the band's own fit can differ a little from the crop's fit in 1:1 — a subject hugging the
      // frame's edge sat 38% under text in 1:1 and 51% in 9:16 (the women's batch, 2026-09-13). The 1:1
      // ad with this very crop verified, so the band keeps that layout; the finished ad is still verified
      // letter by letter against the faces, and inside the safe area.
      if (!allowed[id].includes(la)) {
        const own = fit[la]?.failures?.join("; ") || "not judged";
        allowed[id].push(la); focus[id][la] = fit[la]?.focus || [0.5, 0.5];
        if (!prior[id].notes.some((n) => n.startsWith("placement inherited"))) prior[id].notes.push(`placement inherited from the 1:1 ad, which verified with this crop (the band's own fit for ${short(la)}: ${own})`);
        log(`· ${p.id}: the ${short(la)} band keeps the 1:1 ad's placement (its own fit: ${own})`);
      }
      return id;
    };
    for (const p of gen) for (const la of p.layouts) if (!photo9For(p.id, la)) await bandFor(p, la, prior[`${p.id}-${RATIO}`]?.failures?.join("; ") || "no native 9:16 photo passed");
    // Real photos: the whole photo as a fitted band, no image call. Nothing to check — it was checked
    // clean for the batch and has no people.
    for (const p of real) {
      const id = `${p.id}-${RATIO}`, file = join(visualsDir, `${id}.png`);
      const band = existsSync(file) && prior[id]?.band ? prior[id].band : await bandImage(browser, at(p.file), file);
      prior[id] = { status: "passed", kind: "band", for: p.id, file, band, checks: STORIES_CHECKS, answer: { people_box: null, face_boxes: [], people_count: 0 }, notes: [], failures: [] };
      admit(id, prior[id], null, false);
    }
    // The batch's own photos at 9:16, for the collage and panels ads (their tiles and circles).
    const orig = {};
    for (const p of batch.photos) {
      const pic = pictures[p.id];
      const rec = { file: at(p.file), answer: p.kind === "generated" && pic?.check?.placement ? { people_box: pic.check.placement.people_box, face_boxes: pic.check.faces, people_count: pic.check.placement.people_count } : { people_box: null, face_boxes: [], people_count: 0 } };
      orig[p.id] = rec;
      admit(p.id, rec, visualsById[p.id]?.people ?? null, p.kind === "generated");
    }
    const spent = spentBefore + calls;
    checkpoint();

    // ── 3 render ──
    const fileOf = (id) => prior[id]?.file || orig[id]?.file;
    const groups = new Map(); // candidate → its selected ads
    for (const ad of plan.ads) (groups.get(ad.candidate) || groups.set(ad.candidate, []).get(ad.candidate)).push(ad);
    const leftOut = [], byLocations = new Map();
    for (const [candidate, ads] of groups) {
      const a0 = ads[0];
      let images;
      if (a0.background === "single") {
        const id9 = photo9For(a0.photos[0], a0.treatment);
        if (!id9) { leftOut.push({ candidate, folders: ads.map((a) => a.folder), reason: `no 9:16 photo of ${a0.photos[0]} fits ${a0.treatment}: ${prior[`${a0.photos[0]}-${RATIO}`]?.failures?.join("; ") || "not generated"}` }); continue; }
        images = [id9];
      } else images = a0.photos;
      const key = ads.map((a) => a.location).sort().join("|");
      (byLocations.get(key) || byLocations.set(key, []).get(key)).push({ id: candidate, visual: images[0], images, treatment: a0.treatment, style: a0.style, palette: a0.palette, ads });
    }
    const results = [];
    const renderGroups = async (groups) => {
      for (const [, candidates] of groups) {
        const locs = new Set(candidates[0].ads.map((a) => a.location));
        const r = await renderPlan(browser, { ratio: RATIO, pools: { layouts: [], styles: [], palettes: [] }, allowed, candidates }, {
          texts: texts.filter((t) => locs.has(t.location)), imageFor: fileOf, facesFor: (id) => faces[id] || [], focusFor: (id, la) => focus[id]?.[la] || null, catalogue,
        });
        results.push(...r.map((x, i) => ({ ...x, ads: candidates[i].ads })));
      }
    };
    await renderGroups(byLocations);
    // A native 9:16 that verifies for one location's words but not another's (a longer location sets
    // "12 WEEK" lower, onto a face): the band of the 1:1 crop for that look, which verified in 1:1.
    const retry = new Map();
    for (const [i, r] of results.entries()) {
      const a0 = r.ads[0];
      if (!r.failed || a0.background !== "single" || r.images[0] === bandId(a0.photos[0], a0.treatment)) continue;
      const p = gen.find((x) => x.id === a0.photos[0]); if (!p) continue;
      const id = await bandFor(p, a0.treatment, `the native 9:16 did not verify: ${r.failed.join("; ")}`);
      if (!(allowed[id] || []).includes(a0.treatment)) continue;
      const key = r.ads.map((a) => a.location).sort().join("|");
      (retry.get(key) || retry.set(key, []).get(key)).push({ id: r.id, visual: id, images: [id], treatment: a0.treatment, style: a0.style, palette: a0.palette, ads: r.ads, _at: i });
    }
    if (retry.size) {
      const before = results.length;
      await renderGroups(retry);
      for (const x of results.splice(before)) { results[[...retry.values()].flat().find((c) => c.id === x.id)._at] = x; }
    }
    const ads = [], failed = [];
    for (const r of results) {
      if (r.failed) { failed.push({ candidate: r.id, folders: r.ads.map((a) => a.folder), failures: r.failed }); continue; }
      for (const ad of r.ads) {
        const render = r.renders.find((x) => x.text.location === ad.location);
        if (!render) continue;
        const file = storiesFile(ad.file);
        mkdirSync(dirname(join(out, file)), { recursive: true });
        writeFileSync(join(out, file), render.r.png);
        ads.push({ folder: ad.folder, file, file_1x1: ad.file, candidate: r.id, location: ad.location, photos: r.images, photo_files: r.images.map((id) => basename(fileOf(id))), treatment: r.treatment, style: r.style, palette: r.palette, ratio: RATIO, crop: r.images.map((id) => focus[id]?.[r.treatment] || [0.5, 0.5]), words: ad.words });
      }
    }
    const stories = { batch_id: batch.batch_id, made: new Date().toISOString(), ratio: RATIO, image_calls: spent, image_calls_this_run: calls, max_calls: maxCalls, photos: prior, ads, failed, left_out: leftOut };
    writeFileSync(storiesPath, JSON.stringify(stories, null, 2) + "\n");
    const gallery = deps.gallery || ((dir) => execFileSync(process.execPath, [join(HERE, "gallery-selector.mjs"), "--output-dir", dir], { stdio: "ignore" }));
    gallery(out);
    log(`· ${ads.length} Stories version(s) in ${out}${failed.length ? `; ${failed.length} look(s) failed to verify at 9:16 and are left out` : ""}${leftOut.length ? `; ${leftOut.length} look(s) have no fitting 9:16 photo` : ""}; ${calls} image call(s) this run, ${spent} for this batch's stories in all`);
    return { out, plan, stories, calls, results };
  } finally { if (!deps.browser) await browser.close(); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, batch: { type: "string" }, "max-calls": { type: "string" }, attempts: { type: "string", default: "2" },
    "dry-run": { type: "boolean", default: false }, "render-only": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.batch) {
    console.error("Usage: make-stories.mjs --brand-dir <brands/x> --batch <batch id> [--max-calls 24] [--attempts 2] [--dry-run] [--render-only]");
    process.exit(1);
  }
  try {
    const r = await runStories({ brandDir: resolve(v["brand-dir"]), batchId: v.batch, maxCalls: v["max-calls"] ? parseInt(v["max-calls"], 10) : DEFAULT_MAX_CALLS, attempts: parseInt(v.attempts, 10), dryRun: v["dry-run"], renderOnly: v["render-only"] });
    if (!r.dryRun) console.log(`gallery: ${join(r.out, "gallery.html")}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
