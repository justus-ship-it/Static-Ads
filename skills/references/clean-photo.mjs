#!/usr/bin/env node
/**
 * clean-photo.mjs — make a client's real photos usable as ad backgrounds and as references.
 *
 * Client photos carry things an ad must not: a previous owner's logo and neon slogan, brand
 * fittings, weight numbers, exit signs, and — when they are screenshots of a web gallery — the
 * page's own arrows, zoom buttons and share controls. Any of it in a reference photo gets copied
 * into every generated visual (Step 4), and in a background it puts words on the ad that software
 * did not set.
 *
 * For each photo:
 *   1. Survey (vision): list everything that must go — lettering, logos, signs, markings, screens,
 *      web controls, and the client's never-list — each as the object and where it is, never its
 *      words. People are counted.
 *   2. Frame: crop to the nearest shape the image model makes exactly (least area lost), sliding the
 *      crop to leave web controls at the edge outside it. The model edits at that shape, so the room
 *      is never reframed or extended.
 *   3. Edit (one Gemini call): remove only the surveyed items; keep everything else. The edit must
 *      line up with the photo it was given (pixel check), and is then pasted onto that photo inside
 *      the removal boxes only, feathered and tone-matched — every pixel outside them stays the
 *      original's, so edits cannot drift the room however many rounds it takes.
 *   4. Check the pasted result, all of it required:
 *      - no lettering, marks or web controls left, and nothing from the never-list — looked for in
 *        the whole photo and in full-resolution tiles, each flagged item confirmed by a second look
 *        (check-visual.mjs → checkTiled);
 *      - no people added;
 *      - still the same room from the same viewpoint, still a real photograph, and no other
 *        noticeable change (a vision comparison of before and after);
 *      - only the removal areas changed (a pixel comparison: at most MAX_UNINTENDED of the photo
 *        outside them may differ);
 *      - no resolution lost.
 *   5. A photo that passes is written to the clean folder. One that fails is kept with its reasons.
 *      With --attempts N it is edited again: when the room came through and only marks are left, the
 *      next edit finishes this one, asked about the leftovers alone; otherwise it starts again from
 *      the original with the leftovers added. Every result is judged against the original. Every paid
 *      image call counts against --max-calls, which is never exceeded.
 *
 * The originals are never modified.
 *
 * Usage:
 *   node skills/references/clean-photo.mjs --brand-dir brands/sculpt-society \
 *     --photo facility-01.png --photo facility-07.png [--out <dir>] [--clean-dir <dir>] \
 *     [--max-calls 2] [--attempts 1] [--size 2K]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "fs";
import { join, resolve, basename, extname, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { parseArgs } from "util";
import { callVision, askVision, confirmItems, checkTiled, confirmTiled, dedupeItems, imageSize, CHECK_MODEL } from "./check-visual.mjs";
import { generateImage, GEMINI_MODEL } from "./generate_ads_gemini.mjs";
import { launchBrowser, imageDataUrl } from "./render-composites.mjs";

/** Shapes the image model produces (imageConfig.aspectRatio), with the pixel size it actually makes
 *  for each at 1K ("2K" doubles it). "21:9" is really 1584 × 672, so the crop is cut to that, not to
 *  21:9 — otherwise the model quietly squeezes or trims the photo to fit (Step 5, run 1). */
export const EDIT_SIZES = { "21:9": [1584, 672], "16:9": [1376, 768], "3:2": [1264, 848], "4:3": [1200, 896], "5:4": [1152, 928], "1:1": [1024, 1024], "4:5": [928, 1152], "3:4": [896, 1200], "2:3": [848, 1264], "9:16": [768, 1376] };
export const EDIT_ASPECTS = Object.keys(EDIT_SIZES);
/** Colour difference (CIE76 ΔE, on the comparison grid) above which a spot counts as changed. */
export const PIXEL_TOLERANCE = 14;
/** Share of the photo outside the removal areas that may change. */
export const MAX_UNINTENDED = 0.08;
/** Removal areas grow by this much (0–1000 scale): a fill blends a little past the item it replaces. */
export const REMOVAL_MARGIN = 25;
export const COMPARE_GRID = 96;
/** Boxes under this share of the photo are pasted whole; larger ones only where the edit changed
 *  something (a colour step over CHANGE_THRESHOLD on any channel, after lining up and tone). */
export const SMALL_BOX = 0.015;
export const CHANGE_THRESHOLD = 28;
/** A large box is taken whole when the edit redrew its surroundings this well (mean colour error in
 *  a ring round it, after lining up and tone). Run 5: aligned edits fit at 3–10, misaligned at 18–39. */
export const WHOLE_BOX_FIT = 12;

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const inline = (p) => ({ inline_data: { mime_type: MIME[extname(p).toLowerCase()] || "image/png", data: readFileSync(p).toString("base64") } });
const valid = (b) => Array.isArray(b) && b.length === 4 && b[2] > b[0] && b[3] > b[1];
const ratioOf = (a) => EDIT_SIZES[a][0] / EDIT_SIZES[a][1];

// ── framing ───────────────────────────────────────────────────────────────

/**
 * The crop to edit at. `size` is [w, h] in pixels; `keepOut` are boxes (0–1000, [ymin, xmin, ymax,
 * xmax]) best left outside the crop — web controls at the edges. Returns { aspect, crop: [x, y, w, h],
 * loss } with the least area lost; the crop slides to leave out as much keep-out area as it can,
 * then sits as near the centre as it can.
 */
export function editFrame([w, h], keepOut = []) {
  let best = null;
  for (const aspect of EDIT_ASPECTS) {
    const r = ratioOf(aspect);
    const [cw, ch] = w / h > r ? [Math.round(h * r), h] : [w, Math.round(w / r)];
    const loss = 1 - (cw * ch) / (w * h);
    if (!best || loss < best.loss - 1e-9) best = { aspect, cw, ch, loss };
  }
  const roomX = w - best.cw, roomY = h - best.ch;
  const px = keepOut.filter(valid).map(([y0, x0, y1, x1]) => [(y0 / 1000) * h, (x0 / 1000) * w, (y1 / 1000) * h, (x1 / 1000) * w]);
  const kept = (x, y) => px.reduce((n, [y0, x0, y1, x1]) => n + Math.max(0, Math.min(y1, y + best.ch) - Math.max(y0, y)) * Math.max(0, Math.min(x1, x + best.cw) - Math.max(x0, x)), 0);
  const steps = (room) => (room > 0 ? Array.from({ length: 41 }, (_, i) => Math.round((room * i) / 40)) : [0]);
  let pick = null;
  for (const x of steps(roomX)) for (const y of steps(roomY)) {
    const s = kept(x, y), c = Math.abs(x - roomX / 2) + Math.abs(y - roomY / 2);
    if (!pick || s < pick.s - 1 || (Math.abs(s - pick.s) <= 1 && c < pick.c)) pick = { x, y, s, c };
  }
  return { aspect: best.aspect, crop: [pick.x, pick.y, best.cw, best.ch], loss: +best.loss.toFixed(3) };
}

/** Boxes on the whole photo (0–1000) → boxes on the crop (0–1000). Items wholly outside are dropped. */
export function toCrop(items, [cx, cy, cw, ch], [w, h]) {
  return items.flatMap((it) => {
    if (!valid(it.box_2d)) return [it];
    const [y0, x0, y1, x1] = it.box_2d;
    const m = [((y0 / 1000) * h - cy) / ch, ((x0 / 1000) * w - cx) / cw, ((y1 / 1000) * h - cy) / ch, ((x1 / 1000) * w - cx) / cw].map((v) => Math.round(v * 1000));
    const c = [Math.max(0, m[0]), Math.max(0, m[1]), Math.min(1000, m[2]), Math.min(1000, m[3])];
    return c[2] > c[0] && c[3] > c[1] ? [{ ...it, box_2d: c }] : [];
  });
}

// ── describing what to remove — objects and places, never words ─────────────

/** Where a box sits, in words. */
export function where(b) {
  if (!valid(b)) return "somewhere in the photo";
  const [y0, x0, y1, x1] = b, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const v = cy < 333 ? "top" : cy < 667 ? "middle" : "bottom";
  const hz = cx < 333 ? "left" : cx < 667 ? "centre" : "right";
  if (y0 >= 900) return hz === "centre" ? "along the bottom edge" : `at the bottom ${hz} edge`;
  if (y1 <= 100 && x1 - x0 < 600) return hz === "centre" ? "along the top edge" : `at the top ${hz} edge`;
  if (x1 <= 100) return `at the left edge${v === "middle" ? "" : `, ${v === "top" ? "near the top" : "near the bottom"}`}`;
  if (x0 >= 900) return `at the right edge${v === "middle" ? "" : `, ${v === "top" ? "near the top" : "near the bottom"}`}`;
  if (x1 - x0 >= 600) return `across the ${v} of the photo`;
  if (y1 - y0 >= 600) return `down the ${hz} side`;
  if (v === "middle") return hz === "centre" ? "in the centre" : `on the ${hz}`;
  return `in the ${v === "top" ? "upper" : "lower"} ${hz}`;
}

/** Where, plus a position for anything small — "on the left" does not find a thumb-sized logo. */
export function placeOf(b) {
  const w = where(b);
  if (!valid(b) || (b[2] - b[0]) * (b[3] - b[1]) > 20000) return w;
  return `${w} (about ${Math.round((b[1] + b[3]) / 20)}% across and ${Math.round((b[0] + b[2]) / 20)}% down)`;
}

/** A description the edit prompt may carry: quoted words, "reading …" phrases and names removed. */
export function plainWords(s, names = []) {
  let t = String(s || "")
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/(^|\s)['‘’][^'‘’]+['‘’](?=\s|[,.;:]|$)/g, " ")
    .replace(/\b(reading|that reads|which reads|saying|that says|spelling|spelled|with the words?|with the text|showing the words?)\b.*$/i, " ");
  for (const n of names.filter(Boolean)) t = t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`), "gi"), " ");
  return t.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,.;:-]+|[\s,;:-]+$/g, "").trim();
}

export const CATEGORIES = ["wall_lettering", "logo", "sign", "equipment_marking", "screen", "web_control", "watermark", "never_item", "other"];
const DEFAULT_OBJECT = {
  wall_lettering: "lettering on the wall", logo: "a logo", sign: "a sign", equipment_marking: "markings on the equipment",
  screen: "a screen showing an image", web_control: "a web-page control", watermark: "a watermark", never_item: "a fitting the client does not allow", other: "a mark",
};
// "Make the surface plain, the colour of the equipment" turned red-trimmed dumbbells solid red
// (run 1). A marking is removed on its own; what it was printed on keeps its colours.
const FILL = {
  wall_lettering: "remove it completely, leaving plain wall in the same colour and texture",
  logo: "remove only the logo itself; the object it was on keeps its own colours, trim and shape",
  sign: "remove it, leaving plain wall",
  equipment_marking: "remove only the numbers or markings themselves; the equipment keeps its own colours, trim and shape",
  screen: "make the screen plain, dark and blank",
  web_control: "remove it and continue the photo naturally behind it",
  watermark: "remove it and continue the photo naturally behind it",
  never_item: "remove it completely, leaving the wall or surface plain",
  other: "remove it, leaving the surface plain",
};

export const KEEP_CLAUSE = "KEEP EVERYTHING ELSE EXACTLY AS IT IS: the framing and perspective; every machine, bench, rack and weight, in the same place and the same shape; the walls, ceiling, lights, mirrors, windows and floor; the colours, lighting and shadows.";
export const ADD_NOTHING_CLAUSE = "ADD NOTHING: no people, no equipment, no signs, no lettering, no numbers, no logos, no decorations.";
export const REAL_PHOTO_CLAUSE = "It must still look like an ordinary, unretouched photograph: do not restyle, sharpen, brighten, recolour or add effects. When you are done, no surface anywhere in the photo carries lettering, numbers or a logo.";

/** The edit prompt. `items` are survey items ({ category, object, box_2d }) on the crop. */
export function buildCleanPrompt({ items, brandNames = [] }) {
  if (!items?.length) throw new Error("nothing to remove: a clean-up edit needs at least one item");
  const lines = items.map((it) => {
    const cat = CATEGORIES.includes(it.category) ? it.category : "other";
    const obj = plainWords(it.object, brandNames) || DEFAULT_OBJECT[cat];
    return `- ${obj}, ${placeOf(it.box_2d)}: ${FILL[cat]}`;
  });
  return [
    "Edit this photograph. It is a real photo of the client's own gym, and after the edit it must still be recognisably the same room, from the same camera position.",
    "",
    "REMOVE ONLY THESE, filling each area with what would naturally be behind it, matching the surrounding colour, texture and lighting:",
    ...[...new Set(lines)],
    "If any of these also shows in a mirror or reflection, remove it there too.",
    "",
    KEEP_CLAUSE,
    "",
    ADD_NOTHING_CLAUSE,
    "",
    REAL_PHOTO_CLAUSE,
  ].join("\n");
}

/** A mark the text check found (check-visual.mjs), as an item to remove. The check's `what` is the
 *  mark's own words, so only its kind and place are carried over; never-list items keep their
 *  description, which comes from the client's list with any "reading …" phrase removed. */
export function markItem(t, list = "text") {
  if (list === "never") return { category: "never_item", object: plainWords(t.what), box_2d: t.box_2d };
  const all = `${t.kind || ""} ${t.what || ""}`, kind = `${t.kind || ""}`.replace(/_/g, " ");
  const category = /web|interface|\bui\b|button|arrow|zoom|cursor/i.test(all) ? "web_control" : /watermark/i.test(all) ? "watermark" : /logo|brand/i.test(kind) ? "logo" : /\bsign/i.test(kind) ? "sign" : "other";
  return { category, object: `a remaining ${plainWords(kind).toLowerCase() || "mark"}`, box_2d: t.box_2d };
}

/** A survey item as a checklist entry: what to look for (no words), where, and which list it fails. */
export function asKnown(it) {
  const cat = CATEGORIES.includes(it.category) ? it.category : "other";
  return { what: plainWords(it.object) || DEFAULT_OBJECT[cat], kind: cat.replace(/_/g, " "), box_2d: it.box_2d, list: cat === "never_item" ? "never" : "text" };
}

/** The open search's findings plus the checklist's, each kept once. */
export function joinFindings(left, again = []) {
  const text = dedupeItems([...(left.text || []).map((t) => ({ ...t, list: "text" })), ...again.filter((t) => t.list !== "never").map((t) => ({ ...t, list: "text" }))]);
  const never = dedupeItems([...(left.never || []).map((t) => ({ ...t, list: "never" })), ...again.filter((t) => t.list === "never")]);
  return { ...left, text, never };
}

/** Leftovers from a failed attempt, as items for the next one. */
export function leftoverItems(left) {
  return [...(left.text || []).map((x) => markItem(x, "text")), ...(left.never || []).map((x) => markItem(x, "never"))];
}

const boxArea = ([y0, x0, y1, x1]) => Math.max(0, y1 - y0) * Math.max(0, x1 - x0);
/** Items from a second source that no item already covers (half or more of the new box inside one). */
export function mergeItems(items, extra) {
  const covered = (e) => valid(e.box_2d) && items.some((i) => valid(i.box_2d) && boxArea([Math.max(i.box_2d[0], e.box_2d[0]), Math.max(i.box_2d[1], e.box_2d[1]), Math.min(i.box_2d[2], e.box_2d[2]), Math.min(i.box_2d[3], e.box_2d[3])]) >= 0.5 * boxArea(e.box_2d));
  return [...items, ...extra.filter((e) => !covered(e))];
}

// ── vision: the survey, the after-check and the before/after comparison ─────

const SURVEY_QUESTION = (never) => `You are preparing a photograph of a gym to be used as the background of an advert. The advert's words are added later by software, so the photograph must end up with no lettering, numbers, logos or signs of any kind.

List everything in this photo that will have to be removed. Look over the whole image, including small and blurry areas, equipment, weight plates, dumbbells, walls, windows, screens, mirrors and reflections, and the edges of the frame:
- lettering, words, numbers or digits of any kind, including neon and illuminated lettering
- logos, brand marks and name plates
- signs and notices, including exit signs
- screens that show anything
- web-page or app controls (buttons, arrows, zoom controls, cursors, bits of another page) and watermarks
- anything on the client's never-list below${never.length ? `:\n${never.map((n) => `  - ${n}`).join("\n")}` : " (none given)"}

For each item give its category, and "object": a short description of the object and where it is, WITHOUT quoting or spelling out any of its words or numbers (for example "glowing neon lettering on the upper wall", "numbers on the weight plates", "a logo plate on top of the chest press"). Group many identical small items (every dumbbell's number) into one item with one box around them all. Only list what you can actually see.

Also count the people, including any in mirrors. Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000.`;
const SURVEY_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: { type: "ARRAY", items: { type: "OBJECT", properties: { category: { type: "STRING", enum: CATEGORIES }, object: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["category", "object", "box_2d"] } },
    people_count: { type: "INTEGER" },
  },
  required: ["items", "people_count"],
};

/** What must go from a photo. Returns { items, people_count }. The survey is joined by the same text
 *  check the result will face — tiled when `crop` is given, each item confirmed by a second look: in
 *  run 1 the survey missed an air-con logo, a notice and rack stickers that the after-check then
 *  found, a retry each. */
export async function surveyPhoto(imagePath, { never = [], crop = null, ...opts } = {}) {
  const a = await callVision(imagePath, SURVEY_QUESTION(never), SURVEY_SCHEMA, opts);
  const items = (a.items || []).filter((i) => valid(i.box_2d));
  const found = crop ? await checkTiled(imagePath, { never, crop, ...opts }) : await checkClean(imagePath, { never, ...opts });
  const extra = leftoverItems(found).filter((i) => valid(i.box_2d)).map((i) => ({ ...i, object: i.object.replace(/^a remaining /, "a ") }));
  return { items: mergeItems(items, extra), people_count: Math.max(a.people_count || 0, found.people_count || 0) };
}

/** What is left on an edited photo: text marks and never-list items, each confirmed by a second look. */
export async function checkClean(imagePath, { never = [], ...opts } = {}) {
  const a = await askVision(imagePath, { never, ...opts });
  const flagged = [...(a.text_items || []).map((t) => ({ ...t, list: "text" })), ...(a.excluded_items || []).map((t) => ({ ...t, list: "never" }))];
  const { kept, dismissed } = await confirmItems(imagePath, flagged, opts);
  return { text: kept.filter((t) => t.list === "text"), never: kept.filter((t) => t.list === "never"), people_count: a.people_count || 0, dismissed };
}

const COMPARE_QUESTION = `The first image is an original photograph of a gym. The second is an edited copy. The edit was meant to remove only lettering, numbers, logos, signs, what screens show, web-page controls and some wall light fittings, and to change nothing else.

1. same_room: is the second image recognisably the same room as the first, with the same walls, ceiling, floor and equipment in the same places?
2. same_viewpoint: is it seen from the same camera position with the same framing (not zoomed, shifted, mirrored or re-cropped)?
3. real_photo: does the second image still look like an ordinary, unretouched photograph (not a painting, render or illustration)?
4. List every OTHER difference: objects added, removed, moved or reshaped, and changes to colours, lighting, walls or floor. Do not list the removal of lettering, numbers, logos, signs, screen contents, web-page controls or wall light fittings: those were intended. For each difference say whether someone who trains at this gym would notice it at a glance (noticeable).

Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000, on the second image.`;
const COMPARE_SCHEMA = {
  type: "OBJECT",
  properties: {
    same_room: { type: "BOOLEAN" }, same_viewpoint: { type: "BOOLEAN" }, real_photo: { type: "BOOLEAN" },
    differences: { type: "ARRAY", items: { type: "OBJECT", properties: { what: { type: "STRING" }, kind: { type: "STRING", enum: ["added", "removed", "moved", "changed"] }, noticeable: { type: "BOOLEAN" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["what", "kind", "noticeable"] } },
  },
  required: ["same_room", "same_viewpoint", "real_photo", "differences"],
};

/** Before and after, side by side, judged by the vision model. */
export async function compareRooms(original, edited, opts = {}) {
  return callVision([original, edited], COMPARE_QUESTION, COMPARE_SCHEMA, opts);
}

// ── pixels: crop, compare, and a picture of what changed (the renderer's Chrome) ─

async function inPage(browser, body) {
  const page = join(browser.work, `clean-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(page, `<!doctype html><body><script>window.__out = (async () => {\n${body}\n})();</script>`);
  const loaded = browser.cdp.once("Page.loadEventFired", browser.sessionId);
  await browser.cdp.send("Page.navigate", { url: pathToFileURL(page).href }, browser.sessionId);
  await loaded;
  const { result, exceptionDetails } = await browser.cdp.send("Runtime.evaluate", { expression: "window.__out", awaitPromise: true, returnByValue: true }, browser.sessionId);
  rmSync(page, { force: true });
  if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
}
const LOAD = `const load = async (s) => { const i = new Image(); i.src = s; await i.decode(); return i; };`;

/** Crop [x, y, w, h] (pixels) out of an image into a PNG. */
export async function cropImage(browser, src, [x, y, w, h], out) {
  const b64 = await inPage(browser, `${LOAD}
const im = await load(${JSON.stringify(imageDataUrl(src))});
const c = document.createElement("canvas"); c.width = ${w}; c.height = ${h};
c.getContext("2d").drawImage(im, ${x}, ${y}, ${w}, ${h}, 0, 0, ${w}, ${h});
return c.toDataURL("image/png").split(",")[1];`);
  writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

/**
 * How much of the edited photo differs from the original outside the removal areas. Both are shrunk
 * to a COMPARE_GRID-wide grid (halving step by step, so every pixel counts); a spot is changed when
 * its colour lies more than `tolerance` ΔE outside the range of colours within one step of it in the
 * original — so a shift of a pixel or two, or the model's own grain, is not a change. Small objects
 * (about two steps or less) can vanish without showing here; the vision comparison covers those.
 */
export async function comparePixels(browser, original, edited, { boxes = [], margin = REMOVAL_MARGIN, tolerance = PIXEL_TOLERANCE, grid = COMPARE_GRID } = {}) {
  return inPage(browser, `${LOAD}
const A = await load(${JSON.stringify(imageDataUrl(original))}), B = await load(${JSON.stringify(imageDataUrl(edited))});
const gw = ${grid}, gh = Math.max(1, Math.round(gw * A.naturalHeight / A.naturalWidth));
const shrink = (im) => {
  let src = im, w = im.naturalWidth, h = im.naturalHeight;
  while (w / 2 >= gw * 2) {
    const c = document.createElement("canvas"); c.width = Math.round(w / 2); c.height = Math.round(h / 2);
    const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height);
    src = c; w = c.width; h = c.height;
  }
  const c = document.createElement("canvas"); c.width = gw; c.height = gh;
  const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, gw, gh);
  const d = x.getImageData(0, 0, gw, gh).data, lab = new Float32Array(gw * gh * 3);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < gw * gh; i++) {
    const r = lin(d[i * 4]), g = lin(d[i * 4 + 1]), b = lin(d[i * 4 + 2]);
    const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    lab[i * 3] = 116 * f(Y) - 16; lab[i * 3 + 1] = 500 * (f(X) - f(Y)); lab[i * 3 + 2] = 200 * (f(Y) - f(Z));
  }
  return lab;
};
const a = shrink(A), b = shrink(B);
const boxes = ${JSON.stringify(boxes.filter(valid))}, m = ${margin};
const inMask = (x, y) => { const X = (x + 0.5) / gw * 1000, Y = (y + 0.5) / gh * 1000; return boxes.some(([y0, x0, y1, x1]) => Y >= y0 - m && Y <= y1 + m && X >= x0 - m && X <= x1 + m); };
const changed = [], masked = [];
let out = 0, outChanged = 0, all = 0, sumDe = 0;
for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
  const i = y * gw + x, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
    const j = (yy * gw + xx) * 3;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[j + k]); hi[k] = Math.max(hi[k], a[j + k]); }
  }
  // How far the spot's colour lies outside the range its neighbourhood had in the original: a spot
  // shifted by part of a step is a blend of its neighbours, so it stays inside and is not a change.
  const best = Math.hypot(...[0, 1, 2].map((k) => Math.max(0, lo[k] - b[i * 3 + k], b[i * 3 + k] - hi[k])));
  const ch = best > ${tolerance}, mk = inMask(x, y);
  changed.push(ch ? 1 : 0); masked.push(mk ? 1 : 0);
  all += ch; if (!mk) { out++; outChanged += ch; sumDe += best; }
}
return { grid: [gw, gh], changed_share: +(all / (gw * gh)).toFixed(4), changed_outside_share: +(out ? outChanged / out : 0).toFixed(4), removal_share: +(1 - out / (gw * gh)).toFixed(4), mean_de_outside: +(out ? sumDe / out : 0).toFixed(2), changed, masked };`);
}

/** The edited photo with what changed painted on: red = changed outside the removal areas, amber = inside. */
export async function drawChanges(browser, edited, pix, out, width = 1200) {
  const b64 = await inPage(browser, `${LOAD}
const im = await load(${JSON.stringify(imageDataUrl(edited))});
const W = ${width}, H = Math.round(W * im.naturalHeight / im.naturalWidth);
const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
x.drawImage(im, 0, 0, W, H); x.fillStyle = "rgba(0,0,0,0.35)"; x.fillRect(0, 0, W, H);
const [gw, gh] = ${JSON.stringify(pix.grid)}, ch = ${JSON.stringify(pix.changed)}, mk = ${JSON.stringify(pix.masked)};
for (let i = 0; i < gw * gh; i++) {
  const cx = (i % gw) * W / gw, cy = Math.floor(i / gw) * H / gh;
  if (mk[i]) { x.strokeStyle = "rgba(255,255,255,0.18)"; x.strokeRect(cx, cy, W / gw, H / gh); }
  if (ch[i]) { x.fillStyle = mk[i] ? "rgba(255,190,0,0.55)" : "rgba(255,30,30,0.75)"; x.fillRect(cx, cy, W / gw, H / gh); }
}
return c.toDataURL("image/png").split(",")[1];`);
  writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

/**
 * Take the edit only where it was asked for. The result is the original, with the edited pixels laid
 * in over each removal box (grown by `margin`, 0–1000 scale), feathered over `feather` of the width,
 * lined up with the original (its overall shift, up to 48 px, then ±4 px per box) and matched to its tone, measured in a ring
 * round the box. Small boxes are taken whole; large ones only where the edit changed something (run 4:
 * pasting the whole of a large box doubled the racks seen in a mirror and left a tone seam on a wall).
 * Everything outside the boxes stays the original's own pixels, so repeated edits cannot drift the
 * room: four chained whole-image edits over-sharpened facility-07 and pushed its red walls to magenta
 * (run 3). Written at the original's size.
 */
export async function pasteEdit(browser, original, edited, boxes, out, { margin = REMOVAL_MARGIN, feather = 0.012, wholeFit = WHOLE_BOX_FIT } = {}) {
  const b64 = await inPage(browser, `${LOAD}
const O = await load(${JSON.stringify(imageDataUrl(original))}), E = await load(${JSON.stringify(imageDataUrl(edited))});
const W = O.naturalWidth, H = O.naturalHeight;
const cv = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const oc = cv(W, H), ox = oc.getContext("2d", { willReadFrequently: true }); ox.drawImage(O, 0, 0);
let src = E, w = E.naturalWidth, h = E.naturalHeight;
while (w / 2 >= W) { const c = cv(Math.round(w / 2), Math.round(h / 2)), x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height); src = c; w = c.width; h = c.height; }
const ec = cv(W, H), ex = ec.getContext("2d", { willReadFrequently: true }); ex.imageSmoothingQuality = "high"; ex.drawImage(src, 0, 0, W, H);
const img = ox.getImageData(0, 0, W, H), o = img.data, e = ex.getImageData(0, 0, W, H).data, orig = new Uint8ClampedArray(o);
const f = Math.max(2, ${feather} * W), m = ${margin}, S = ${SMALL_BOX}, T0 = ${CHANGE_THRESHOLD}, FIT = ${wholeFit};
const stats = []; let pasteGlobal = [0, 0];
const ev = (x, y, k) => e[((Math.max(0, Math.min(H - 1, y)) * W) + Math.max(0, Math.min(W - 1, x))) * 4 + k];
const BOXES = ${JSON.stringify(boxes.filter(valid))};
// The whole edit can sit off by more than a box's search reaches (run 5: 16 px and more, under the
// comparison grid's notice). Find its overall shift first, away from the boxes, tone-invariant:
// coarse steps of 3 px up to ±48 px, then single pixels.
const inBox = (x, y) => BOXES.some(([y0, x0, y1, x1]) => y >= (y0 - m) / 1000 * H && y <= (y1 + m) / 1000 * H && x >= (x0 - m) / 1000 * W && x <= (x1 + m) / 1000 * W);
const pts = [];
for (let y = 50; y < H - 50; y += 6) for (let x = 50; x < W - 50; x += 6) if (!inBox(x, y)) pts.push((y * W + x));
const score = (dx, dy) => {
  const mu = [0, 0, 0];
  for (const p of pts) { const x = p % W, y = (p - x) / W; for (let k = 0; k < 3; k++) mu[k] += orig[p * 4 + k] - ev(x + dx, y + dy, k); }
  let err = 0;
  for (const p of pts) { const x = p % W, y = (p - x) / W; for (let k = 0; k < 3; k++) err += Math.abs(orig[p * 4 + k] - ev(x + dx, y + dy, k) - mu[k] / pts.length); }
  return err;
};
let g = [0, 0], gErr = pts.length ? score(0, 0) : 0;
if (pts.length) {
  for (let dy = -48; dy <= 48; dy += 3) for (let dx = -48; dx <= 48; dx += 3) { const e2 = score(dx, dy); if (e2 < gErr - 1e-6) { gErr = e2; g = [dx, dy]; } }
  const c = g.slice();
  for (let dy = c[1] - 2; dy <= c[1] + 2; dy++) for (let dx = c[0] - 2; dx <= c[0] + 2; dx++) { const e2 = score(dx, dy); if (e2 < gErr - 1e-6) { gErr = e2; g = [dx, dy]; } }
}
pasteGlobal = g;
for (const [y0, x0, y1, x1] of BOXES) {
  const L = (x0 - m) / 1000 * W, T = (y0 - m) / 1000 * H, R = (x1 + m) / 1000 * W, B = (y1 + m) / 1000 * H;
  const rx0 = Math.max(0, Math.floor(L - 3 * f)), rx1 = Math.min(W, Math.ceil(R + 3 * f)), ry0 = Math.max(0, Math.floor(T - 3 * f)), ry1 = Math.min(H, Math.ceil(B + 3 * f));
  const ring = [];
  for (let y = ry0; y < ry1; y += 3) for (let x = rx0; x < rx1; x += 3) if (!(x > L - f && x < R + f && y > T - f && y < B + f)) ring.push([x, y]);
  // Line the edit up with the original round this box: the model redraws a few pixels off.
  let best = g.slice(), bestErr = Infinity;
  for (let dy = g[1] - 4; dy <= g[1] + 4; dy++) for (let dx = g[0] - 4; dx <= g[0] + 4; dx++) {
    // Scored after taking out the mean colour difference, so the model's tone drift cannot pull the fit.
    const mu = [0, 0, 0]; let c = 0;
    for (let j = 0; j < ring.length; j += 2) { const [x, y] = ring[j], i = (y * W + x) * 4; for (let k = 0; k < 3; k++) mu[k] += orig[i + k] - ev(x + dx, y + dy, k); c++; }
    let err = 0;
    for (let j = 0; j < ring.length; j += 2) { const [x, y] = ring[j], i = (y * W + x) * 4; for (let k = 0; k < 3; k++) err += Math.abs(orig[i + k] - ev(x + dx, y + dy, k) - mu[k] / c); }
    if (err < bestErr - 1e-6 || (Math.abs(err - bestErr) < 1e-6 && Math.abs(dx - g[0]) + Math.abs(dy - g[1]) < Math.abs(best[0] - g[0]) + Math.abs(best[1] - g[1]))) { bestErr = err; best = [dx, dy]; }
  }
  const [sx, sy] = best;
  // Tone: the mean colour of the ring in the original and in the (aligned) edit.
  const so = [0, 0, 0], se = [0, 0, 0];
  for (const [x, y] of ring) { const i = (y * W + x) * 4; for (let k = 0; k < 3; k++) { so[k] += orig[i + k]; se[k] += ev(x + sx, y + sy, k); } }
  const shift = [0, 1, 2].map((k) => (ring.length ? Math.max(-40, Math.min(40, (so[k] - se[k]) / ring.length)) : 0));
  // How faithfully the edit redrew the box's surroundings (mean colour error in the ring, after lining up and tone).
  let fit = 0;
  for (const [x, y] of ring) { const i = (y * W + x) * 4; for (let k = 0; k < 3; k++) fit += Math.abs(orig[i + k] - ev(x + sx, y + sy, k) - shift[k]) / 3; }
  fit = ring.length ? fit / ring.length : 0;
  const X0 = Math.max(0, Math.floor(L - f)), X1 = Math.min(W, Math.ceil(R + f)), Y0 = Math.max(0, Math.floor(T - f)), Y1 = Math.min(H, Math.ceil(B + f)), bw = X1 - X0, bh = Y1 - Y0;
  const rectA = (x, y) => Math.max(0, Math.min(1, 0.5 + Math.min(x - L, R - x, y - T, B - y) / (2 * f)));
  let alpha;
  const small = (y1 - y0) * (x1 - x0) / 1e6 < S;
  if (small || fit <= FIT) {
    // Taken whole: a small box because a low-contrast mark (an embossed logo) may not show as a
    // change; a large one the edit redrew faithfully because a removed light's glow goes with it
    // (run 5: taking only the changed pixels left the neon's glow as blotches round the letters).
    alpha = (x, y) => rectA(x, y);
  } else {
    // A large box whose surroundings the edit redrew loosely keeps the original wherever the edit
    // only redrew what was there, so detail it covers (racks in a mirror) is not doubled and its tone
    // cannot seam: only the pixels the edit really changed are taken, grown a little and feathered.
    let mk = new Float32Array(bw * bh);
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = (y * W + x) * 4; let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(orig[i + k] - (ev(x + sx, y + sy, k) + shift[k])));
      mk[(y - Y0) * bw + (x - X0)] = d > T0 ? 1 : 0;
    }
    const pass = (a, r, op) => { // separable max/min (r px), rows then columns
      let b = new Float32Array(a.length);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let v = op === "max" ? 0 : 1; for (let t = Math.max(0, x - r); t <= Math.min(bw - 1, x + r); t++) v = op === "max" ? Math.max(v, a[y * bw + t]) : Math.min(v, a[y * bw + t]); b[y * bw + x] = v; }
      const c = new Float32Array(a.length);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let v = op === "max" ? 0 : 1; for (let t = Math.max(0, y - r); t <= Math.min(bh - 1, y + r); t++) v = op === "max" ? Math.max(v, b[t * bw + x]) : Math.min(v, b[t * bw + x]); c[y * bw + x] = v; }
      return c;
    };
    const blur = (a, r) => { // two box blurs ≈ a soft edge
      for (let n = 0; n < 2; n++) {
        const b = new Float32Array(a.length);
        for (let y = 0; y < bh; y++) { let s = 0, c = 0; for (let x = -r; x < bw; x++) { if (x + r < bw) { s += a[y * bw + x + r]; c++; } if (x - r - 1 >= 0) { s -= a[y * bw + x - r - 1]; c--; } if (x >= 0) b[y * bw + x] = s / c; } }
        for (let x = 0; x < bw; x++) { let s = 0, c = 0; for (let y = -r; y < bh; y++) { if (y + r < bh) { s += b[(y + r) * bw + x]; c++; } if (y - r - 1 >= 0) { s -= b[(y - r - 1) * bw + x]; c--; } if (y >= 0) a[y * bw + x] = s / c; } }
      }
      return a;
    };
    // Grown further than the feather spreads (two box blurs of r reach 2r), so every changed pixel —
    // a mark's anti-aliased edge and glow included — is taken whole.
    const grow = Math.max(4, Math.round(0.005 * W)), r = Math.max(1, Math.floor(grow / 3));
    mk = blur(pass(pass(mk, 1, "min"), grow, "max"), r);
    alpha = (x, y) => Math.min(rectA(x, y), mk[(y - Y0) * bw + (x - X0)]);
  }
  stats.push({ box: [y0, x0, y1, x1], shift: [sx, sy], tone: shift.map((v) => +v.toFixed(1)), fit: +fit.toFixed(2), small, whole: small || fit <= FIT });
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const a = alpha(x, y); if (!a) continue;
    const i = (y * W + x) * 4; for (let k = 0; k < 3; k++) o[i + k] = a * (ev(x + sx, y + sy, k) + shift[k]) + (1 - a) * o[i + k];
  }
}
ox.putImageData(img, 0, 0);
return { png: oc.toDataURL("image/png").split(",")[1], stats, global: pasteGlobal };`);
  writeFileSync(out, Buffer.from(b64.png, "base64"));
  pasteEdit.last = b64.stats;
  pasteEdit.lastGlobal = b64.global;
  return out;
}

/** Pixel tools on one shared Chrome, started on first use. */
export function makePixelTools() {
  let browser = null;
  const b = async () => (browser ||= await launchBrowser());
  return {
    crop: async (...a) => cropImage(await b(), ...a),
    compare: async (...a) => comparePixels(await b(), ...a),
    draw: async (...a) => drawChanges(await b(), ...a),
    paste: async (...a) => pasteEdit(await b(), ...a),
    async close() { if (browser) await browser.close(); browser = null; },
  };
}

// ── the rules (pure) ──────────────────────────────────────────────────────

/** Apply every rule to what the checks found. Returns { ok, failures, marks_only } — marks_only when
 *  the room came through intact and only marks are left, so the next edit can start from this one. */
export function judgeClean({ left = {}, peopleBefore = 0, peopleAfter = 0, compare = null, pixels = null, sourceSize = null, editedSize = null, maxUnintended = MAX_UNINTENDED }) {
  const failures = [];
  const text = left.text || [], never = left.never || [];
  if (text.length) failures.push(`marks still in the photo: ${text.map((t) => `${t.kind} "${t.what}" (${where(t.box_2d)})`).join("; ")}`);
  if (never.length) failures.push(`still shows what the client never allows: ${never.map((t) => `${t.what} (${where(t.box_2d)})`).join("; ")}`);
  const marks = failures.length;
  if (peopleAfter > peopleBefore) failures.push(`people were added (${peopleBefore} before, ${peopleAfter} after)`);
  if (compare) {
    if (!compare.same_room) failures.push("no longer recognisably the same room");
    if (!compare.same_viewpoint) failures.push("the viewpoint or framing changed");
    if (!compare.real_photo) failures.push("no longer looks like a real photograph");
    const big = (compare.differences || []).filter((d) => d.noticeable);
    if (big.length) failures.push(`changed more than the marks: ${big.map((d) => `${d.kind}: ${d.what}`).join("; ")}`);
  } else failures.push("the before/after comparison did not run");
  if (pixels) {
    if (pixels.changed_outside_share > maxUnintended) failures.push(`${(pixels.changed_outside_share * 100).toFixed(1)}% of the photo outside the removal areas changed (max ${maxUnintended * 100}%)`);
  } else failures.push("the pixel comparison did not run");
  if (sourceSize && editedSize && Math.min(...editedSize) < 0.95 * Math.min(...sourceSize)) failures.push(`lower resolution than the source (${editedSize.join("×")} from ${sourceSize.join("×")})`);
  return { ok: failures.length === 0, failures, marks_only: marks > 0 && failures.length === marks };
}

// ── the flow ──────────────────────────────────────────────────────────────

/** `generate`, `survey`, `check`, `compare` and `pixels` are injectable, so the flow and the budget can be tested offline. */
export async function cleanPhotos({ photos, never = [], brandNames = [], outDir, cleanDir, maxCalls = photos.length, attempts = 1, size = "2K", generate = generateImage, survey = null, check = null, recheck = null, compare = compareRooms, pixels = makePixelTools(), log = console.log }) {
  // By default both the survey and the after-check look at full-resolution tiles as well as the whole
  // photo: the whole-image look missed a logo plate, a wall sconce and rack lettering (run 2).
  survey ||= (p, o) => surveyPhoto(p, { ...o, crop: pixels.crop });
  check ||= (p, o) => checkTiled(p, { ...o, crop: pixels.crop });
  // Every item found in any round stays on a checklist, and each candidate must be confirmed clear of
  // each one by a targeted look: an open search found a mirrored sconce, then missed it (run 4).
  recheck ||= (p, items) => confirmTiled(p, items, { crop: pixels.crop });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cleanDir, { recursive: true });
  for (const p of photos) if (resolve(join(cleanDir, basename(p))) === resolve(p)) throw new Error(`the clean folder is the originals' folder: ${p} would be overwritten`);
  let calls = 0;
  const results = [];
  try {
    for (const photo of photos) {
      const id = basename(photo, extname(photo));
      const srcSize = imageSize(readFileSync(photo));
      const found = await survey(photo, { never });
      const ui = found.items.filter((i) => ["web_control", "watermark"].includes(i.category)).map((i) => i.box_2d);
      const frame = editFrame(srcSize, ui);
      const src = join(outDir, `${id}.source.png`);
      await pixels.crop(photo, frame.crop, src);
      const base = toCrop(found.items, frame.crop, srcSize);
      writeFileSync(join(outDir, `${id}.survey.json`), JSON.stringify({ photo, size: srcSize, frame, people_count: found.people_count, items: found.items, on_crop: base }, null, 2) + "\n");
      log(`· ${id}: ${found.items.length} item(s) to remove; editing at ${frame.aspect}, crop ${frame.crop.join(",")} (${Math.round(frame.loss * 100)}% trimmed)`);
      if (!base.length) {
        copyFileSync(src, join(cleanDir, `${id}.png`));
        results.push({ photo, id, status: "already clean", frame, attempts: [] });
        log(`✓ ${id}: nothing to remove; the crop is the clean copy`);
        continue;
      }
      // `input` is what the next edit starts from; `removed` is every area asked for so far. Each edit
      // must line up with its input (the pixel check), and is then pasted onto it inside this round's
      // boxes only — the candidate. Candidates are always judged against the original crop.
      let items = base, input = src, removed = base, final = null;
      let known = base.map(asKnown);
      const tries = [];
      for (let attempt = 1; attempt <= attempts && final?.status !== "passed"; attempt++) {
        if (calls >= maxCalls) {
          if (!tries.length) log(`- ${id}: skipped (budget of ${maxCalls} calls reached)`);
          final ||= { photo, id, status: "skipped", reason: `call budget of ${maxCalls} reached` };
          break;
        }
        const tag = attempt > 1 ? `${id}-a${attempt}` : id;
        const prompt = buildCleanPrompt({ items, brandNames });
        writeFileSync(join(outDir, `${tag}.prompt.txt`), prompt + "\n");
        calls++;
        let img;
        try { img = await generate(prompt, [inline(input)], { aspectRatio: frame.aspect, imageSize: size }); } catch (e) {
          final = { photo, id, status: "error", reason: e.message };
          tries.push({ attempt, status: "error", reason: e.message });
          log(`✗ ${id}: edit failed: ${e.message.slice(0, 200)}`);
          continue;
        }
        const raw = join(outDir, `${tag}.raw.${img.ext || "png"}`);
        writeFileSync(raw, img.buffer);
        const editedSize = imageSize(img.buffer);
        const from = input === src ? "original" : basename(input);
        // 1. The edit must line up with what it was given: outside this round's boxes, almost nothing
        //    may differ (run 1: an edit zoomed a few percent and the vision comparison missed it).
        let reg = null;
        try { reg = await pixels.compare(input, raw, { boxes: items.map((i) => i.box_2d) }); } catch (e) { log(`  pixel comparison could not run: ${e.message.slice(0, 160)}`); }
        if (!reg || reg.changed_outside_share > MAX_UNINTENDED) {
          const failures = judgeClean({ left: {}, compare: { same_room: true, same_viewpoint: true, real_photo: true }, pixels: reg }).failures.map((f) => `the edit does not line up with the photo: ${f}`);
          final = { photo, id, status: "flagged", attempt, frame, failures };
          tries.push({ attempt, from, raw, status: "flagged", failures, size: editedSize, registration: reg && { ...reg, changed: undefined, masked: undefined } });
          log(`⚑ ${id}${attempt > 1 ? ` (attempt ${attempt}, from ${from})` : ""}: ${failures.join(" | ")}`);
          continue; // nothing is pasted from a misaligned edit; the next try starts from the same input
        }
        // 2. Keep the edit only inside this round's boxes.
        const file = join(outDir, `${tag}.png`);
        await pixels.paste(input, raw, items.map((i) => i.box_2d), file);
        // 3. Judge the candidate: marks, people, the room, against the original.
        let left, cmp = null, after = null;
        try { left = await check(file, { never }); } catch (e) { left = { text: [{ kind: "check", what: `could not run: ${e.message}` }], never: [], people_count: 0 }; }
        let again = [];
        try { again = await recheck(file, known); } catch (e) { again = [{ kind: "check", what: `the checklist could not run: ${e.message}`, list: "text" }]; }
        left = joinFindings(left, again);
        known = dedupeItems([...known, ...left.text, ...left.never]);
        try { cmp = await compare(src, file); } catch (e) { log(`  comparison could not run: ${e.message.slice(0, 160)}`); }
        try { after = await pixels.compare(src, file, { boxes: removed.map((i) => i.box_2d) }); await pixels.draw(file, after, join(outDir, `${tag}.changes.png`)); } catch (e) { log(`  pixel comparison could not run: ${e.message.slice(0, 160)}`); }
        const verdict = judgeClean({ left, peopleBefore: found.people_count, peopleAfter: left.people_count, compare: cmp, pixels: reg, sourceSize: [frame.crop[2], frame.crop[3]], editedSize });
        final = { photo, id, status: verdict.ok ? "passed" : "flagged", file, attempt, frame, failures: verdict.failures };
        tries.push({ attempt, from, raw, file, status: final.status, failures: verdict.failures, size: editedSize, left, dismissed: left.dismissed || [], compare: cmp, registration: { ...reg, changed: undefined, masked: undefined }, after: after && { ...after, changed: undefined, masked: undefined } });
        log(`${verdict.ok ? "✓" : "⚑"} ${id}${attempt > 1 ? ` (attempt ${attempt}, from ${from})` : ""}: ${verdict.ok ? `clean; same room; the edit changed ${(reg.changed_outside_share * 100).toFixed(1)}% outside its boxes, and none of that is kept` : verdict.failures.join(" | ")}`);
        if (verdict.ok) { final.clean = join(cleanDir, `${id}.png`); copyFileSync(file, final.clean); continue; }
        const more = leftoverItems(left);
        removed = [...removed, ...more];
        // Only marks left and the room intact: the next edit finishes this candidate, asked about the
        // leftovers alone (run 1: small logos survived two fresh edits of an 8-item list). Anything
        // else wrong: start again from the original, the leftovers added to the list.
        if (verdict.marks_only && more.length) { input = file; items = more; }
        else { input = src; items = mergeItems(base, more); }
      }
      results.push({ ...final, attempts: tries });
    }
  } finally {
    await pixels.close?.();
  }
  const report = { model: GEMINI_MODEL, checked_with: CHECK_MODEL, image_calls: calls, max_calls: maxCalls, size, results };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, photo: { type: "string", multiple: true }, out: { type: "string" }, "clean-dir": { type: "string" },
    "max-calls": { type: "string" }, attempts: { type: "string", default: "1" }, size: { type: "string", default: "2K" },
    "survey-only": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.photo?.length) {
    console.error("Usage: clean-photo.mjs --brand-dir <brands/x> --photo <file> [--photo <file>] [--out <dir>] [--clean-dir <dir>] [--max-calls N] [--attempts N] [--size 2K]");
    process.exit(1);
  }
  const brandDir = resolve(v["brand-dir"]);
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const photos = v.photo.map((p) => [resolve(p), join(brandDir, p), join(brandDir, "brand-assets", "facility", p)].find(existsSync) || p);
  for (const p of photos) if (!existsSync(p)) { console.error(`photo not found: ${p}`); process.exit(1); }
  const outDir = resolve(v.out || join(brandDir, "outputs", `clean-${new Date().toISOString().slice(0, 10)}`));
  const cleanDir = resolve(v["clean-dir"] || join(dirname(photos[0]), "..", `${basename(dirname(photos[0]))}-clean`));
  const never = profile.brand_lock?.photography?.never || [];
  if (v["survey-only"]) {
    // What an edit would be asked to remove, and how each photo would be framed. No image is made.
    for (const p of photos) {
      const size = imageSize(readFileSync(p)), found = await surveyPhoto(p, { never });
      const frame = editFrame(size, found.items.filter((i) => ["web_control", "watermark"].includes(i.category)).map((i) => i.box_2d));
      const onCrop = toCrop(found.items, frame.crop, size);
      console.log(`\n${basename(p)} ${size.join("×")} → ${frame.aspect}, crop ${frame.crop.join(",")}; ${found.people_count} people`);
      for (const it of found.items) console.log(`  ${onCrop.some((c) => c.object === it.object) ? "remove" : "cropped"}  [${it.category}] ${it.object} ${JSON.stringify(it.box_2d)}`);
      if (onCrop.length) console.log(`\n${buildCleanPrompt({ items: onCrop, brandNames: [profile.display_name, profile.formerly?.split(/\s[—–-]\s|[;,(]/)[0].trim()] })}`);
    }
    process.exit(0);
  }
  const maxCalls = v["max-calls"] ? parseInt(v["max-calls"], 10) : photos.length;
  console.log(`Cleaning ${photos.length} photo(s) with ${GEMINI_MODEL}, at most ${maxCalls} image call(s)…`);
  const report = await cleanPhotos({ photos, never, brandNames: [profile.display_name, profile.formerly?.split(/\s[—–-]\s|[;,(]/)[0].trim()], outDir, cleanDir, maxCalls, attempts: parseInt(v.attempts, 10), size: v.size });
  const bad = report.results.filter((r) => !["passed", "already clean"].includes(r.status)).length;
  console.log(`${report.image_calls} image call(s) · ${report.results.length - bad} clean · ${bad} flagged/failed · report: ${join(outDir, "report.json")} · clean copies: ${cleanDir}`);
  process.exit(bad ? 1 : 0);
}
