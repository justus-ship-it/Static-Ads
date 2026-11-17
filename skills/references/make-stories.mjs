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
 *     [--max-calls 24] [--attempts 2] [--dry-run] [--render-only] [--only c11[,c12]] [--fresh]
 */

import { generateImage } from "./generate_ads_gemini.mjs";
import { readShotGuide } from "./visual-prompts.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, basename, dirname, extname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";
import { loadCatalogue, launchBrowser, layoutFor, imageDataUrl, renderComposite } from "./render-composites.mjs";
import { fitLayouts, imageSize, judgeVisual } from "./check-visual.mjs";
import { poseProblem } from "./visual-prompts.mjs";
import { checkSibling } from "./check-quality.mjs";
import { renderPlan } from "./assign-variants.mjs";
import { generateVisuals, assess, makeCompositor, checkPicture } from "./generate-visuals.mjs";
import { resolveSelections, loadRulings, withRulings, CHECKS_VERSION, exitWhenWritten } from "./plan-offer-batch.mjs";
import { catalogueFor, imageModelFor } from "./client-config.mjs";
import { inPage, LOAD } from "./clean-photo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RATIO = "9x16";
export const DEFAULT_MAX_CALLS = 24;
/** Which checks a passed 9:16 photo has been through (the batch's, plus the sibling check). */
export const STORIES_CHECKS = `${CHECKS_VERSION}-s1`;
const CHECK_LOOK = { style: "s1-heavy-sans", palette: "white-on-dark" };
/** The fitted band for a wide real photo: the copy behind it is blurred and darkened, as T8's 9:16 backdrop. */
export const BAND = { blur_pct: 4, darken: 0.45 };
/** The stacked band (the photo above the words): the layout's text must leave this much of the canvas height above it, less a gap. */
export const STACK_MIN_H = 0.3, STACK_GAP = 24;
const short = (id) => id.split("-")[0];

/**
 * Which 9:16 photos the selected ads need: one per photo that appears in a single-photo look, with
 * the layouts it must fit — its own primary layout first, so it is composed for the look it was made
 * for. Collage and panels ads need none. Pure.
 */
export function planStories(batch, chosen, { catalogue = loadCatalogue(), poseOf = () => null } = {}) {
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
  // The native 9:16 photo is composed for the first look its pose can hold. The 1:1 batch may have given a
  // photo a look by fit alone (its own layout failed, or the looser fit of 2026-09-27: an upright
  // kettlebell clean kept for T1), and a standing figure cannot be composed for T1. That look is served by
  // the band of its 1:1 crop instead; a photo whose pose holds none of its looks gets no new photo at all.
  for (const p of photos) {
    if (p.kind !== "generated") continue;
    const pose = poseOf(p.id), ok = p.layouts.find((la) => !poseProblem(la, pose, catalogue));
    if (ok && ok !== p.layouts[0]) p.layouts = [ok, ...p.layouts.filter((x) => x !== ok)];
    p.composable = !!ok;
  }
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
export async function bandImage(browser, src, out, { canvas = [1080, 1920], live = [0.14, 0.65], crop = null, blur_pct = BAND.blur_pct, darken = BAND.darken, window: win = null } = {}) {
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
const win = ${JSON.stringify(win)};
const y0 = win ? win[1] : ${live[0]} * H, y1 = win ? win[1] + win[3] : ${live[1]} * H, maxH = y1 - y0, maxW = win ? win[2] : W, x0 = win ? win[0] : 0;
let w = maxW, h = (maxW * sh) / sw;
if (h > maxH) { h = maxH; w = (h * sw) / sh; }
const x = x0 + (maxW - w) / 2, y = y0 + (maxH - h) / 2;
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

/** The 9:16 file beside an ad's feed image: the same folder and name, 9x16 for the feed ratio (1x1, or 4x5). */
export const storiesFile = (feedFile, feed = "1x1") => feedFile.replace(`/${feed}/`, `/${RATIO}/`).replace(`_${feed}_`, `_${RATIO}_`);

/**
 * Stories for one batch. `deps` (tests): generate, check, sibling, compositor, browser, gallery.
 * Returns { out, plan, stories, calls } (or { out, plan, dryRun: true }).
 */
/** `only`: the candidates (c11) or folders of the kept ads to make Stories versions for — the rest of the
 *  batch's record is kept as it is. `fresh`: try a photo again even where its earlier attempts failed
 *  (the attempts on disk no longer count), for a single ad the owner wants another go at. */
/**
 * Whether a feed ad's Stories version is one of the designs (stories_designs: a tall photo with the words on its own
 * top, else the feed photo with the words beside the model, else the feed photo with its top colour carried up) or goes
 * the photo way below. The designs are for a feed ad of the reference family made at 4:5 with one photo, its words set
 * on the photo or under it — and, in the run, for a generated photo only (a real photo's shape is its own).
 */
export function designed(ad, { feed, catalogue }) {
  const T = catalogue.treatments;
  if (feed !== "4x5" || catalogue.look === "formula" || !T.stories_designs || (ad.photos || []).length !== 1) return false;
  const tr = T.treatments[ad.treatment]; if (!tr) return false;
  const bg = layoutFor(tr, feed, T).background?.type || "single";
  return bg === "single" || bg === "split";
}
/** A box on the feed photo (0–1000) as it lands in the 9:16 frame when the photo sits full width from `py` px down. */
const inFrame = (box, py, ph, H) => (box ? [((py + (box[0] / 1000) * ph) / H) * 1000, box[1], ((py + (box[2] / 1000) * ph) / H) * 1000, box[3]] : null);
/** The feed photo in the tall frame, full width from `py` px down, its own edge colours carried above and below it and the joins feathered: a PNG. */
async function extendPhoto(browser, file, { py, W, H, feather = [220, 160] }) {
  const { cdp, sessionId, work } = browser, page = join(work, `extend-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><canvas id="c" width="${W}" height="${H}"></canvas><script>
    window.done = new Promise((res, rej) => { const im = new Image(); im.onerror = () => rej(new Error("photo did not load")); im.onload = () => {
      const c = document.getElementById("c"), x = c.getContext("2d"), ph = Math.round(${W} * im.naturalHeight / im.naturalWidth), py = ${py};
      const t = document.createElement("canvas"); t.width = ${W}; t.height = ph; const tx = t.getContext("2d"); tx.drawImage(im, 0, 0, ${W}, ph);
      const avg = (y0, y1) => { const d = tx.getImageData(0, y0, ${W}, y1 - y0).data; let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } return "rgb(" + Math.round(r / n) + "," + Math.round(g / n) + "," + Math.round(b / n) + ")"; };
      x.fillStyle = avg(0, 50); x.fillRect(0, 0, ${W}, py + ph / 2); x.fillStyle = avg(ph - 50, ph); x.fillRect(0, py + ph / 2, ${W}, ${H});
      const top = py > 0 ? ${feather[0]} : 0, bot = py + ph < ${H} ? ${feather[1]} : 0, gr = tx.createLinearGradient(0, 0, 0, ph);
      gr.addColorStop(0, top ? "rgba(0,0,0,0)" : "rgba(0,0,0,1)"); if (top) gr.addColorStop(top / ph, "rgba(0,0,0,1)"); if (bot) gr.addColorStop(1 - bot / ph, "rgba(0,0,0,1)"); gr.addColorStop(1, bot ? "rgba(0,0,0,0)" : "rgba(0,0,0,1)");
      tx.globalCompositeOperation = "destination-in"; tx.fillStyle = gr; tx.fillRect(0, 0, ${W}, ph);
      x.drawImage(t, 0, py); res(c.toDataURL("image/png"));
    }; im.src = ${JSON.stringify(imageDataUrl(file))}; });
  </script>`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `file://${page}` }, sessionId); await loaded;
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: "window.done", awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails || !result?.value) throw new Error("the photo could not be set in the tall frame");
  return Buffer.from(result.value.split(",")[1], "base64");
}

/**
 * Stories for one batch (2026-11-17, the owner's order: "D as first choice, if the new tall photo doesn't look good or it
 * blocks the model, we go with C, then last resort B"). For each kept ad that takes a design (`designed`), in the
 * catalogue's order: **tall** — a new 9:16 photo of the same people, made once per photo (one image call, one try, under
 * the run's cap), checked like any photo and against the feed photo, used where its model keeps clear of the words' place;
 * **side** — the feed photo in the middle of the frame with the words beside the model; **top** — the feed photo at the
 * foot with its top colour carried up and the words on that. Every one is verified with the words off the model. The
 * other ads (a collage, circles, a real photo, a square batch from before, the formula family) go the photo way
 * (runStoriesPhotos) as they always did; `designs: false` sends every ad that way.
 */
export async function runStories(opts) {
  const { brandDir, batchId, batchDir = null, maxCalls = DEFAULT_MAX_CALLS, dryRun = false, renderOnly = false, only = null, fresh = false, designs = true, deps = {}, log = console.log } = opts;
  const out = batchDir || join(brandDir, "outputs", batchId);
  if (designs === false || !existsSync(join(out, "batch.json")) || !existsSync(join(out, "selections.json"))) return runStoriesPhotos(opts);
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")), profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const catalogue = catalogueFor(profile, null, { look: batch.look }), T = catalogue.treatments, feed = batch.ratio || "1x1", D = T.stories_designs;
  const photoOf = Object.fromEntries(batch.photos.map((p) => [p.id, p]));
  let chosen = resolveSelections(out).filter((a) => !a.card && !a.video_file);
  if (only) { const want = new Set(only); chosen = chosen.filter((ad) => want.has(ad.candidate) || want.has(ad.folder)); }
  if (only && chosen.length) log(`· only ${chosen.map((x) => x.folder).join(", ")}${fresh ? " — its tall photo is tried again" : ""}; the other ads' Stories versions stay as they are`);
  const mine = (ad) => designed(ad, { feed, catalogue }) && photoOf[ad.photos[0]]?.kind === "generated";
  const ads = chosen.filter(mine), rest = chosen.filter((ad) => !mine(ad));
  if (!ads.length) return runStoriesPhotos(opts);
  const order = D.order || ["tall", "side", "top"], pids = [...new Set(ads.map((a) => a.photos[0]))];
  const storiesPath = join(out, "stories.json"), spendPath = join(out, "spend.json"), visualsDir = join(out, "visuals");
  const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null);
  const tallId = (pid) => `${pid}-${RATIO}-tall`;
  const before = readJson(storiesPath)?.photos || {};
  const settled = (pid) => { const r = before[tallId(pid)]; return !!r && !!r.file && existsSync(r.file) && (!fresh || r.status === "passed"); };
  const toMake = order.includes("tall") && !renderOnly ? pids.filter((pid) => !settled(pid)) : [];
  log(`· stories: ${ads.length} ad(s) on ${pids.length} photo(s) take a design — a tall photo first (${toMake.length} to make, one image call each${pids.length - toMake.length ? `, ${pids.length - toMake.length} on file` : ""}), else the words beside the model, else the photo's own colour carried up${rest.length ? `; ${rest.length} other ad(s) go the usual way` : ""}`);
  const base = rest.length ? await runStoriesPhotos({ ...opts, only: rest.map((a) => a.folder) }) : null;
  const plan = { ...(base?.plan || { photos: [], ads: [], generated: 0, real: 0 }), designed: ads.length, tall: toMake.length };
  if (dryRun) return { out, plan, dryRun: true };

  mkdirSync(visualsDir, { recursive: true });
  const existing = readJson(storiesPath), prior = existing?.photos || {}, spend = readJson(spendPath) || {};
  const spentBefore = spend.stories_image_calls ?? existing?.image_calls ?? 0;
  const pictures = readJson(join(out, "pictures.json")) || {}, visualsById = Object.fromEntries((readJson(join(out, "visuals.json"))?.visuals || []).map((v) => [v.id, v]));
  const brief = readJson(join(out, "brief.json")) || {};
  const at = (p) => (existsSync(p) ? p : existsSync(join(brandDir, "brand-assets", p)) ? join(brandDir, "brand-assets", p) : resolve(p));
  const photography = profile.brand_lock?.photography || {}, brandNames = [profile.display_name].filter(Boolean);
  const [W, H] = T.canvas[RATIO];
  let calls = 0;
  const saveSpend = () => writeFileSync(spendPath, JSON.stringify({ ...spend, stories_image_calls: spentBefore + calls, stories_max_calls: maxCalls }, null, 2) + "\n");

  // ── the tall photos: one try each, under the cap ──
  const left = Math.max(0, maxCalls - spentBefore);
  if (toMake.length && !left) log(`- the stories budget of ${maxCalls} image calls is spent: no tall photo is made; the ads take the feed photo`);
  const making = toMake.slice(0, left);
  if (toMake.length > making.length && left) log(`- the cap leaves ${left} image call(s): ${toMake.length - making.length} photo(s) get no tall photo and take the feed photo`);
  if (making.length) {
    const baseCheck = deps.check || checkPicture, sibling = deps.sibling || checkSibling, rulings = deps.rulings || loadRulings(brandDir);
    // The batch's own checks, then — only when they pass — the same people as the feed photo.
    const check = withRulings(async (file, o) => {
      const pic = await baseCheck(file, o);
      if (!pic.ok || !o.anchor) return pic;
      let sb; try { sb = await sibling(o.anchor, file); } catch (e) { sb = { ok: false, failures: [`sibling check could not run: ${e.message}`], notes: [] }; }
      return { ...pic, ok: sb.ok, failures: [...(pic.failures || []), ...sb.failures], notes: [...(pic.notes || []), ...(sb.notes || [])] };
    }, rulings);
    const reference = brief.reference || brief.real?.[0] || null;
    const visuals = making.map((pid) => { const v = visualsById[pid] || {}; return { id: tallId(pid), for: pid, treatment: "st-tall", scene: v.scene, scene_id: v.scene_id, pose: v.pose, people: v.people, ...(v.format ? { format: v.format } : {}), tags: v.tags, ...(Number.isInteger(v.age) ? { age: v.age } : {}), anchor: at(photoOf[pid].file) }; }).filter((v) => v.scene);
    const rep = await generateVisuals({
      visuals, photography, brandNames, outDir: visualsDir, ratio: RATIO, shotGuide: deps.shotGuide !== undefined ? deps.shotGuide : readShotGuide(), refs: reference && existsSync(at(reference)) ? [at(reference)] : [], anchorFor: (v) => v.anchor,
      maxCalls: left, attempts: 1, layoutRetry: false, generate: deps.generate || ((p, parts, o) => generateImage(p, parts, { ...o, model: imageModelFor(profile) })), check, ...(deps.checkRef ? { checkRef: deps.checkRef } : {}), compositor: null, log,
      onProgress: (e) => { if (e.event === "generating") { calls = Math.max(calls, e.calls || 0); saveSpend(); } },
    });
    calls = Math.max(calls, rep.image_calls || 0); saveSpend();
    for (const r of rep.results) {
      const c = r.check;
      prior[r.id] = { status: r.status === "passed" ? "passed" : "flagged", kind: "tall", for: r.for, treatment: "st-tall", file: r.file || null, checks: STORIES_CHECKS, answer: c?.placement ? { people_box: c.placement.people_box, face_boxes: c.faces || [], people_count: c.placement.people_count } : null, notes: c?.notes || [], failures: r.status === "passed" ? [] : c?.failures || (r.reason ? [r.reason] : []) };
    }
  }

  // ── each ad: the first design that keeps its words off the model and verifies ──
  const made = [], failed = [], used = { tall: 0, side: 0, top: 0 }, ext = new Map();
  const browser = deps.browser || await launchBrowser();
  try {
    const extended = async (pid, which, py) => {
      const key = `${pid}|${which}`; if (ext.has(key)) return ext.get(key);
      const file = join(visualsDir, `${pid}-${RATIO}-ext-${which}.png`);
      writeFileSync(file, await extendPhoto(browser, at(photoOf[pid].file), { py, W, H, feather: D.feather_px }));
      ext.set(key, file); return file;
    };
    for (const ad of ads) {
      const pid = ad.photos[0], feedFile = at(photoOf[pid].file), chk = pictures[pid]?.check, [iw, ih] = imageSize(readFileSync(feedFile)), ph = Math.round((W * ih) / iw);
      const words = { location: ad.words.location, audience: ad.words.audience ?? null, offer: ad.words.offer, free: ad.words.free === true }, look = { palette: ad.palette, style: ad.style, ratio: RATIO, catalogue };
      const feedTr = T.treatments[ad.treatment], feedL = layoutFor(feedTr, feed, T);
      // The side columns of the feed shape, the ad's own first, set inside the Stories frame's live band.
      const own = feedL.groups.find((g) => g.avoid), columns = [...(own ? [own] : []), ...["t3-right-column", "t6-left-column"].map((id) => layoutFor(T.treatments[id], feed, T).groups.find((g) => g.avoid)).filter((g) => g && (!own || g.region[0] !== own.region[0]))];
      const sideLayout = (g0) => ({ no_touch: true, tall_type: true, contrast: { rim: true }, groups: [{ ...structuredClone(g0), region: [g0.region[0], D.side.column_y[0], g0.region[2], D.side.column_y[1]], avoid: D.side.avoid }], clear_zones: [] });
      let done = null; const why = [];
      for (const design of order) {
        if (design === "tall") {
          const rec = prior[tallId(pid)];
          if (!rec || rec.status !== "passed" || !rec.file || !existsSync(rec.file) || !rec.answer) { why.push(rec ? `the tall photo did not pass its checks${rec.failures?.length ? ` (${rec.failures.join("; ")})` : ""}` : "no tall photo was made"); continue; }
          // The words across the top of the tall photo where its top is free; else beside the model, in a column fitted to
          // the side the model leaves free (the image model keeps the heads higher than it is asked to: 3 of the first 4).
          const fit = judgeVisual({ ...rec.answer, text_items: [], excluded_items: [] }, { treatment: "st-tall", ratio: RATIO, imageSize: imageSize(readFileSync(rec.file)), bodyMax: T.body_cover?.max ?? null, expectPeople: true, catalogue });
          const onTall = { image: rec.file, faces: [rec.answer.face_boxes || []], people: [rec.answer.people_box], ...words, ...look };
          let r = fit.ok ? await renderComposite(browser, { ...onTall, focus: [fit.focus], treatment: "st-tall" }) : null, where = "top";
          if (!r?.ok) for (const g0 of columns) {
            const rs = await renderComposite(browser, { ...onTall, treatment: ad.treatment, treatmentSpec: { ...feedTr, family: "stories", layouts: { [RATIO]: sideLayout(g0) } } });
            if (rs.ok) { r = rs; where = "side"; break; }
          }
          if (r?.ok) { done = { design, r, image: tallId(pid), file: rec.file, where }; break; }
          why.push(`in the tall photo the model leaves no room for the words, above or beside (${fit.ok ? r.failures.join("; ") : fit.failures.join("; ")})`);
        } else if (design === "side") {
          if (ph > H * 0.72) { why.push("the feed photo is too tall to stand in the middle of the frame"); continue; }
          const py = Math.round((D.side.photo_y_pct / 100) * H), image = await extended(pid, "mid", py);
          let r = null;
          for (const g0 of own ? [own] : columns) {
            r = await renderComposite(browser, { image, faces: [(chk?.faces || []).map((b) => inFrame(b, py, ph, H))], people: [inFrame(chk?.placement?.people_box || null, py, ph, H)], ...words, treatment: ad.treatment, treatmentSpec: { ...feedTr, family: "stories", layouts: { [RATIO]: sideLayout(g0) } }, ...look });
            if (r.ok) break;
          }
          if (r?.ok) { done = { design, r, image: basename(image, ".png"), file: image }; break; }
          why.push(`beside the model: ${r ? r.failures.join("; ") : "no column to set the words in"}`);
        } else if (design === "top") {
          const py = Math.min(Math.round((D.top.photo_y_pct / 100) * H), H - ph), image = await extended(pid, "foot", py);
          const g = { id: "main", region: D.top.region, anchor: "center", align: "center", gap_pct: 0.6, scrim: { direction: "none", fade_pct: 0 }, stack: D.stack };
          const r = await renderComposite(browser, { image, faces: [(chk?.faces || []).map((b) => inFrame(b, py, ph, H))], people: [inFrame(chk?.placement?.people_box || null, py, ph, H)], ...words, treatment: ad.treatment, treatmentSpec: { ...feedTr, family: "stories", layouts: { [RATIO]: { no_touch: true, contrast: { rim: true }, groups: [g], clear_zones: [] } } }, ...look });
          if (r.ok) { done = { design, r, image: basename(image, ".png"), file: image }; break; }
          why.push(`the colour carried up: ${r.failures.join("; ")}`);
        }
      }
      if (!done) { failed.push({ candidate: ad.candidate, folders: [ad.folder], failures: why }); log(`⚑ ${ad.folder}: no Stories design verified (${why.join(" · ")})`); continue; }
      const sf = storiesFile(ad.file, feed);
      mkdirSync(dirname(join(out, sf)), { recursive: true }); writeFileSync(join(out, sf), done.r.png);
      used[done.design]++;
      made.push({ folder: ad.folder, file: sf, file_1x1: ad.file, candidate: ad.candidate, location: ad.location, photos: [done.image], photo_files: [basename(done.file)], treatment: ad.treatment, style: ad.style, palette: ad.palette, ratio: RATIO, crop: [[0.5, 0.5]], words: ad.words, design: done.design, ...(done.where ? { placed: done.where } : {}), ...(why.length ? { passed_over: why } : {}) });
      if (why.length) log(`· ${ad.folder}: ${done.design === "side" ? "the words beside the model" : done.design === "top" ? "the photo's colour carried up" : "the tall photo"} — ${why.join(" · ")}`);
    }
  } finally { if (!deps.browser) await browser.close(); }

  // The record: these ads' entries replaced, everything else as it stands (the photo way's own ads, failures and photos).
  const now = readJson(storiesPath), folders = new Set(ads.map((a) => a.folder)), keep = (list) => (now?.[list] || []).filter((x) => !(x.folders || [x.folder]).some((f) => folders.has(f)));
  const stories = { batch_id: batch.batch_id, made: new Date().toISOString(), ratio: RATIO, image_calls: spentBefore + calls, image_calls_this_run: calls + (base?.calls || 0), max_calls: maxCalls, photos: { ...(now?.photos || {}), ...Object.fromEntries(Object.entries(prior).filter(([, r]) => r.kind === "tall")) }, ads: [...keep("ads"), ...made], failed: [...keep("failed"), ...failed], left_out: keep("left_out") };
  writeFileSync(storiesPath, JSON.stringify(stories, null, 2) + "\n");
  (deps.gallery || ((dir) => execFileSync(process.execPath, [join(HERE, "gallery-selector.mjs"), "--output-dir", dir], { stdio: "ignore" })))(out);
  log(`· ${made.length} Stories version(s): ${used.tall} on a tall photo, ${used.side} with the words beside the model, ${used.top} with the photo's colour carried up${failed.length ? `; ${failed.length} did not verify and are left out` : ""}; ${calls} image call(s) for tall photos this run`);
  return { out, plan, stories, calls: calls + (base?.calls || 0), results: base?.results || [], used };
}

/** The photo way: a native 9:16 photo for each single-photo look (or a band of the feed ad's crop), collage and panels from the batch's photos. */
export async function runStoriesPhotos({ brandDir, batchId, batchDir = null, maxCalls = DEFAULT_MAX_CALLS, attempts = 2, dryRun = false, renderOnly = false, only = null, fresh = false, deps = {}, log = console.log }) {
  const out = batchDir || join(brandDir, "outputs", batchId);
  if (!existsSync(join(out, "batch.json"))) throw new Error(`no finished batch at ${out}`);
  if (!existsSync(join(out, "selections.json"))) throw new Error(`no selections.json in ${out}: open the gallery, pick, Save Selections, and put the file in the batch folder`);
  if (!Number.isInteger(maxCalls) || maxCalls < 0) throw new Error("max-calls must be a whole number");
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
  const brief = JSON.parse(readFileSync(join(out, "brief.json"), "utf-8"));
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const catalogue = catalogueFor(profile, null, { look: batch.look }); // the feed ads' look family and palettes, brand ones included
  const T = catalogue.treatments;
  // A card is set at 9:16 with its feed ad (plan-offer-batch): it needs no Stories photo and is left alone here.
  batch.ads = batch.ads.filter((a) => !a.card && !a.video_file); // and a video is 9:16 already
  const feed = batch.ratio || "1x1", feedName = feed.replace("x", ":"), feedCanvas = T.canvas[feed] || [1080, 1080]; // the feed ad's shape: its crop window is that shape, not always a square
  const photography = profile.brand_lock?.photography || {}, brandNames = [profile.display_name].filter(Boolean);
  const visualsById = Object.fromEntries((existsSync(join(out, "visuals.json")) ? JSON.parse(readFileSync(join(out, "visuals.json"), "utf-8")).visuals : []).map((v) => [v.id, v]));
  const pictures = existsSync(join(out, "pictures.json")) ? JSON.parse(readFileSync(join(out, "pictures.json"), "utf-8")) : {};
  const at = (p) => (existsSync(p) ? p : existsSync(join(brandDir, "brand-assets", p)) ? join(brandDir, "brand-assets", p) : resolve(p));

  // ── 1 plan ──
  let chosen = resolveSelections(out).filter((a) => !a.card && !a.video_file); // a card has its own 9:16 already, and so has a video
  if (!chosen.length) throw new Error("selections.json chooses no ads");
  if (only) {
    const want = new Set(only);
    chosen = chosen.filter((ad) => want.has(ad.candidate) || want.has(ad.folder));
    if (!chosen.length) throw new Error(`none of the kept ads is ${only.join(", ")}: a Stories version is made for a kept ad of this batch (its candidate, c01, or its folder)`);
    log(`· only ${chosen.map((a) => a.folder).join(", ")}${fresh ? " — earlier attempts do not count; the photo is tried again" : ""}; the other ads' Stories versions stay as they are`);
  }
  const plan = planStories(batch, chosen, { catalogue, poseOf: (id) => visualsById[id]?.pose ?? null });
  const gen = plan.photos.filter((p) => p.kind === "generated" && p.composable !== false), real = plan.photos.filter((p) => p.kind !== "generated");
  for (const p of plan.photos.filter((x) => x.kind === "generated" && x.composable === false)) log(`- ${p.id}: its pose (${visualsById[p.id]?.pose}) holds none of its looks (${p.layouts.map(short).join("/")}) — no 9:16 photo is made; each look uses the band of its 1:1 crop`);
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
    return { id, for: p.id, treatment: la, scene: v.scene, scene_id: v.scene_id, pose: v.pose, people: v.people, ...(v.format ? { format: v.format } : {}), tags: v.tags, look: CHECK_LOOK, anchor: at(p.file) };
  };
  let calls = 0;
  // The count is written after every generation, so a run that stops half-way never loses what it
  // spent (the first live run crashed after 15 calls and recorded none).
  const checkpoint = () => {
    writeFileSync(spendPath, JSON.stringify({ ...spend, stories_image_calls: spentBefore + calls, stories_max_calls: maxCalls }, null, 2) + "\n");
    writeFileSync(storiesPath, JSON.stringify({ ...existing, batch_id: batch.batch_id, ratio: RATIO, photos: prior, image_calls: spentBefore + calls, max_calls: maxCalls, partial: true }, null, 2) + "\n");
  };
  const compositor = deps.compositor !== undefined ? deps.compositor : makeCompositor(catalogue);
  const reference = brief.reference || brief.real?.[0] || null;
  const earlier = (v) => (existsSync(visualsDir) ? readdirSync(visualsDir).filter((n) => new RegExp(`^${v.id}(-a\\d+)?\\.(png|jpe?g|webp)$`).test(n)).map((n) => join(visualsDir, n)).sort().reverse() : []);
  // Photos already on disk are looked at first — free of image calls; the one in use first.
  // A photo kept for the layouts it fits (its own layout failed) counts as settled — unless the run is a
  // fresh go at it and its own layout is what is wanted.
  const fitsOwn = (v) => { const rec = prior[v.id]; try { return !!fitOf(rec, typeof v.people === "number" ? v.people : null)[v.treatment]?.ok; } catch { return false; } };
  const settle = async (wanted) => {
    let todo = renderOnly ? [] : wanted.filter((v) => !same(prior[v.id], v) || (fresh && !fitsOwn(v)));
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
    const spent9 = fresh ? [] : todo.filter((v) => earlier(v).length >= attempts);
    for (const v of spent9) log(`- ${v.id}: ${earlier(v).length} attempt(s) on disk already, none passing — no more tries`);
    todo = todo.filter((v) => !spent9.includes(v));
    const left = Math.max(0, maxCalls - spentBefore - calls);
    if (todo.length && !left) log(`- the stories budget of ${maxCalls} image calls is spent: ${todo.map((v) => v.id).join(", ")} not generated`);
    if (todo.length && left) {
      const callsBefore = calls;
      const rep = await generateVisuals({
        visuals: todo, text: texts[0], photography, brandNames, outDir: visualsDir, ratio: RATIO, shotGuide: deps.shotGuide !== undefined ? deps.shotGuide : readShotGuide(),
        refs: reference ? [at(reference)] : [], anchorFor: (v) => v.anchor, maxCalls: left, attempts,
        // The room reference was text-checked when the batch was made; not again here.
        checkRef: deps.checkRef || (async () => []),
        generate: deps.generate || ((p, parts, o) => generateImage(p, parts, { ...o, model: imageModelFor(profile) })), check, ...(deps.compositor !== undefined ? { compositor: deps.compositor } : {}), log,
        // Written after every image call and every finished photo, as the batch runner does: a run stopped
        // part-way keeps what it cost (F45 Xinyi's stopped Stories run, 2026-10-07, had made 4 calls and
        // recorded none — the checkpoint ran only once the whole group was done).
        onProgress: (e) => {
          if (e.calls != null) calls = callsBefore + e.calls;
          if (e.event === "done" && e.result) prior[e.id] = record(e.result, e.result.file, e.result.check);
          if (e.calls != null || e.event === "done") checkpoint();
        },
      });
      calls = callsBefore + rep.image_calls;
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
        const crop = cropWindow(size, ad?.crop?.[0] || [0.5, 0.5], feedCanvas);
        const file = join(visualsDir, `${id}.png`), band = await bandImage(browser, src, file, { crop }), pic = pictures[p.id]?.check;
        const answer = inBand(pic?.placement ? { people_box: pic.placement.people_box, face_boxes: pic.faces, people_count: pic.placement.people_count } : null, band, { crop, size });
        prior[id] = { status: "passed", kind: "band", for: p.id, treatment: la, file, band, crop, checks: STORIES_CHECKS, answer, notes: [`the ${feedName} ad's crop of the chosen photo as a band: ${why}`], failures: [] };
        log(`· ${p.id}: ${short(la)} from the chosen photo's ${feedName} crop as a band (no image call)`);
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
        if (!prior[id].notes.some((n) => n.startsWith("placement inherited"))) prior[id].notes.push(`placement inherited from the ${feedName} ad, which verified with this crop (the band's own fit for ${short(la)}: ${own})`);
        log(`· ${p.id}: the ${short(la)} band keeps the ${feedName} ad's placement (its own fit: ${own})`);
      }
      return id;
    };
    // Every generated photo, the ones given no new photo (their pose holds none of their looks) included.
    for (const p of plan.photos.filter((x) => x.kind === "generated")) for (const la of p.layouts) if (!photo9For(p.id, la)) await bandFor(p, la, p.composable === false ? `its pose holds none of its looks (${p.layouts.map(short).join("/")})` : prior[`${p.id}-${RATIO}`]?.failures?.join("; ") || "no native 9:16 photo passed");
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
    // ── a look the 9:16 photo fits (2026-10-07) ──
    // An ad whose own look will not work at 9:16 — the native photo and the band both put a word on a
    // face (F45 Xinyi's c11: a floor push-up group of three under the bottom stack's words, five tries) —
    // takes the first single-photo layout one of its 9:16 photos verifies with, in the same style and
    // palette with the same words; the feed ad keeps its own look. No image call.
    const singleLayouts = Object.keys(T.treatments).filter((la) => (layoutFor(T.treatments[la], RATIO, T).background?.type || "single") === "single");
    const photoAny = (pid, la) => [`${pid}-${RATIO}`, `${pid}-${RATIO}-${short(la)}`, ...Object.keys(prior).filter((id) => prior[id]?.kind === "band" && prior[id].for === pid)].find((id) => prior[id]?.status === "passed" && existsSync(prior[id].file) && (allowed[id] || []).includes(la)) || null;
    for (const [i, r] of [...results.entries()]) {
      const a0 = r.ads[0];
      if (!r.failed || a0.background !== "single") continue;
      const own = a0.treatment, pid = a0.photos[0], ownWhy = r.failed.join("; ");
      for (const la of singleLayouts.filter((x) => x !== own)) {
        const id = photoAny(pid, la); if (!id) continue;
        const key = r.ads.map((a) => a.location).sort().join("|"), before = results.length;
        await renderGroups(new Map([[key, [{ id: r.id, visual: id, images: [id], treatment: la, style: a0.style, palette: a0.palette, ads: r.ads }]]]));
        const [x] = results.splice(before);
        if (x.failed) { log(`- ${r.id}: ${short(la)} does not verify at 9:16 either (${x.failed.join("; ")})`); continue; }
        results[i] = { ...x, look_changed: { from: own, to: la, why: ownWhy } };
        log(`· ${r.id}: its own look ${short(own)} does not work at 9:16 (${ownWhy}) — the Stories version takes ${short(la)}, which its 9:16 photo fits, in the same style and palette with the same words; the feed ad keeps its look`);
        break;
      }
    }
    // ── the photo above the words (2026-10-07) ──
    // An ad no layout can carry at 9:16 with the photo under the words (c11 again: three faces across the
    // frame at mid height, so every layout's duration or offer line lands on one) gets the stacked band:
    // the 1:1 crop of the chosen photo fitted into the space above the layout's text, on the blurred
    // backdrop, the words below it where no face can be. The own layout first, then any whose text leaves
    // room above it (`STACK_MIN_H` of the canvas height). No image call.
    const stackWindow = (la) => {
      const top = Math.min(...layoutFor(T.treatments[la], RATIO, T).groups.map((g) => (g.region[1] / 100) * 1920));
      return top >= STACK_MIN_H * 1920 ? [0, 0, 1080, Math.round(top - STACK_GAP)] : null;
    };
    const stackId = (pid, la) => `${pid}-${RATIO}-stack-${short(la)}`;
    const stackFor = async (p, la, why) => {
      const id = stackId(p.id, la), win = stackWindow(la);
      if (!win) return null;
      if (!(prior[id]?.status === "passed" && existsSync(prior[id].file))) {
        const src = at(p.file), size = imageSize(readFileSync(src));
        const ad = batch.ads.find((a) => a.photos[0] === p.id && a.photos.length === 1 && a.treatment === p.layouts?.[0]) || batch.ads.find((a) => a.photos[0] === p.id && a.photos.length === 1);
        const crop = cropWindow(size, ad?.crop?.[0] || [0.5, 0.5], feedCanvas);
        const file = join(visualsDir, `${id}.png`), band = await bandImage(browser, src, file, { crop, window: win }), pic = pictures[p.id]?.check;
        const answer = inBand(pic?.placement ? { people_box: pic.placement.people_box, face_boxes: pic.faces, people_count: pic.placement.people_count } : null, band, { crop, size });
        prior[id] = { status: "passed", kind: "band", stacked: true, for: p.id, treatment: la, file, band, crop, checks: STORIES_CHECKS, answer, notes: [`the ${feedName} ad's crop of the chosen photo above the words, on the blurred backdrop: ${why}`], failures: [] };
        log(`· ${p.id}: ${short(la)} with the chosen photo's ${feedName} crop above the words (no image call)`);
      }
      admit(id, prior[id], visualsById[p.id]?.people ?? null);
      // The words sit below the photo by construction, so the layout is allowed whatever its placement rule says of the photo above.
      if (!allowed[id].includes(la)) { allowed[id].push(la); focus[id][la] = [0.5, 0.5]; }
      return id;
    };
    for (const [i, r] of [...results.entries()]) {
      const a0 = r.ads[0];
      if (!r.failed || a0.background !== "single") continue;
      const own = a0.treatment, pid = a0.photos[0], ownWhy = r.failed.join("; ");
      const p = plan.photos.find((x) => x.id === pid); if (!p) continue;
      for (const la of [own, ...singleLayouts.filter((x) => x !== own)]) {
        const id = await stackFor(p, la, ownWhy); if (!id) continue;
        const key = r.ads.map((a) => a.location).sort().join("|"), before = results.length;
        await renderGroups(new Map([[key, [{ id: r.id, visual: id, images: [id], treatment: la, style: a0.style, palette: a0.palette, ads: r.ads }]]]));
        const [x] = results.splice(before);
        if (x.failed) { log(`- ${r.id}: ${short(la)} with the photo above the words does not verify either (${x.failed.join("; ")})`); continue; }
        results[i] = { ...x, stacked: true, ...(la !== own ? { look_changed: { from: own, to: la, why: ownWhy } } : {}) };
        log(`· ${r.id}: no layout carries the words over this photo at 9:16 (${ownWhy}) — the Stories version puts the photo above the words${la !== own ? ` in ${short(la)}` : ""}, same style, palette and words; the feed ad keeps its look`);
        break;
      }
    }
    const ads = [], failed = [];
    for (const r of results) {
      if (r.failed) { failed.push({ candidate: r.id, folders: r.ads.map((a) => a.folder), failures: r.failed }); continue; }
      for (const ad of r.ads) {
        const render = r.renders.find((x) => x.text.location === ad.location);
        if (!render) continue;
        const file = storiesFile(ad.file, feed);
        mkdirSync(dirname(join(out, file)), { recursive: true });
        writeFileSync(join(out, file), render.r.png);
        ads.push({ folder: ad.folder, file, file_1x1: ad.file, candidate: r.id, location: ad.location, photos: r.images, photo_files: r.images.map((id) => basename(fileOf(id))), treatment: r.treatment, style: r.style, palette: r.palette, ratio: RATIO, crop: r.images.map((id) => focus[id]?.[r.treatment] || [0.5, 0.5]), words: ad.words, ...(r.look_changed ? { look_changed: r.look_changed } : {}), ...(r.stacked ? { stacked: true } : {}) });
      }
    }
    // A run for some ads only keeps the rest of the record: the other ads' versions, failures and left-outs.
    const mine = new Set(plan.ads.map((a) => a.folder));
    const rest = (list) => (only ? (existing[list] || []).filter((x) => !(x.folders || [x.folder]).some((f) => mine.has(f))) : []);
    const stories = { batch_id: batch.batch_id, made: new Date().toISOString(), ratio: RATIO, image_calls: spent, image_calls_this_run: calls, max_calls: maxCalls, photos: prior, ads: [...rest("ads"), ...ads], failed: [...rest("failed"), ...failed], left_out: [...rest("left_out"), ...leftOut] };
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
    "brand-dir": { type: "string" }, batch: { type: "string" }, "max-calls": { type: "string" }, attempts: { type: "string", default: "2" }, only: { type: "string" }, fresh: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }, "render-only": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.batch) {
    console.error("Usage: make-stories.mjs --brand-dir <brands/x> --batch <batch id> [--max-calls 24] [--attempts 2] [--dry-run] [--render-only] [--only c11[,c12]] [--fresh]");
    process.exit(1);
  }
  try {
    const r = await runStories({ brandDir: resolve(v["brand-dir"]), batchId: v.batch, maxCalls: v["max-calls"] ? parseInt(v["max-calls"], 10) : DEFAULT_MAX_CALLS, attempts: parseInt(v.attempts, 10), dryRun: v["dry-run"], renderOnly: v["render-only"], only: v.only ? v.only.split(",").map((x) => x.trim()).filter(Boolean) : null, fresh: v.fresh });
    if (!r.dryRun) console.log(`gallery: ${join(r.out, "gallery.html")}`);
    exitWhenWritten(0);
  } catch (e) {
    console.error(e.message);
    exitWhenWritten(1);
  }
}
