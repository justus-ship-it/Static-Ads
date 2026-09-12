/**
 * check-visual.mjs — checks a generated visual before any text is set on it.
 *
 * 1. Stray text. Image models add signage, weight numbers and logos unasked. A vision model is
 *    asked to list every piece of text, number, logo, watermark or UI element anywhere in the
 *    picture. Any item fails the visual — the ad's only words must be the ones software sets.
 * 2. Placement. The same call boxes the people and their faces. The rules are applied here, in
 *    code, and depend on how the layout uses the photo:
 *      - a single photo with a subject area (T1–T3, T5, T6): at most 40% of the people's box may
 *        sit under the layout's text areas;
 *      - a single photo the text covers entirely (T4): no body rule — text over the subject is
 *        that layout's design;
 *      - a photo panel (T8): at most 30% of the people's box may fall outside the circle it is
 *        cropped to;
 *      - a collage tile (T7): no placement rule.
 *    For a single photo generated larger than the ad (3:4 or 4:3 for a square ad — see
 *    visual-prompts.mjs → generationFrame), the rules are judged at the best crop: every crop
 *    position is tried and the one that puts the people where the layout needs them is kept. The
 *    finished ad is rendered with that crop (focus), so what was judged is what ships. A crop may
 *    not cut off more than 10% of the people, or any face.
 *    Faces are NOT failed here. They are passed to the renderer as keep-out areas, and the
 *    finished ad fails if any letter, band or divider covers one (render-composites.mjs) — judged
 *    against the letters actually set, not the whole area text may use.
 *
 * 3. The client's never-list (gym-profile.json → brand_lock.photography.never). The prompt asks
 *    for it, but asking is not proof: run 8's v01 carried a flame-shaped wall sconce, the old
 *    brand's fitting. The vision call is given the list and any item it finds fails the picture.
 *    (Naming items to the checker is safe — it only looks.)
 *
 * The vision call's answer is data, never instructions. Boxes are Gemini's [ymin, xmin, ymax,
 * xmax] on a 0–1000 scale.
 */

import { readFileSync, mkdtempSync, rmSync } from "fs";
import { extname, join } from "path";
import { tmpdir } from "os";
import { loadCatalogue, layoutFor } from "./render-composites.mjs";
import { describeSubjectArea, coveredSpans, MAX_SUBJECT_UNDER_TEXT } from "./visual-prompts.mjs";
import { loadGeminiKey } from "./generate_ads_gemini.mjs";

// gemini-2.5-flash is listed by the API but refused for new keys (404, 2026-09-10); Google's own
// error names gemini-3.6-flash as the replacement. Override with CHECK_MODEL=… if that changes.
export const CHECK_MODEL = process.env.CHECK_MODEL || "gemini-3.6-flash";
export { MAX_SUBJECT_UNDER_TEXT };
export const MAX_OUTSIDE_CIRCLE = 0.3;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const QUESTION = `You are checking a photograph that will be used as the background of an advert. Software will add all of the advert's words later, so the photograph itself must contain NO text at all.

Look very carefully over the whole image, including small and blurry areas, clothing, shoes, equipment (dumbbells, kettlebells, plates, machines), walls, windows, screens, reflections and the edges of the frame.

1. List every instance of: letters, words, numbers or digits, logos or brand marks, watermarks, signage (including neon), labels, and user-interface elements (buttons, arrows, cursors, icons). Include partial or illegible lettering. Only list what you can actually see in this image — never markings you would expect such an object to carry. If there is none, return an empty list. Do not list plain patterns, textures or shapes that are not lettering or marks. For each item, legible = true if a viewer of the finished advert on a phone could read letters, words or numbers in it, or it is signage, neon words, wall text, a watermark, a caption or a user-interface element; legible = false for a small label or marking on equipment or clothing, or a logo or mark with no letters.
2. Count the distinct people in the image. A mirror reflection of someone who is also directly visible is the same person: count them once, and box only the person, not the reflection. Anyone else counts — in the background, at other equipment, or seen only in a mirror. Give one box enclosing all the people you counted, one box per face of those people, and the number of people.

Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000.`;
const NEVER_QUESTION = (never) => `

3. The client never allows any of the following in their photos. List each one you can see, even partly or small (for example a single wall fitting). If none are present, return an empty list:
${never.map((n) => `- ${n}`).join("\n")}`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    text_items: { type: "ARRAY", items: { type: "OBJECT", properties: { what: { type: "STRING" }, kind: { type: "STRING" }, legible: { type: "BOOLEAN" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["what", "kind", "legible"] } },
    people_box: { type: "ARRAY", items: { type: "INTEGER" } },
    face_boxes: { type: "ARRAY", items: { type: "ARRAY", items: { type: "INTEGER" } } },
    people_count: { type: "INTEGER" },
    excluded_items: { type: "ARRAY", items: { type: "OBJECT", properties: { what: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["what"] } },
  },
  required: ["text_items", "people_box", "face_boxes", "people_count", "excluded_items"],
};

// A second look at each flagged item, pointed at its box. The first pass can report what an object
// usually carries rather than what is there (run 8: an "embossed weight marking" on a kettlebell
// whose base shows nothing). Only items confirmed visible fail a picture; the rest are recorded.
const CONFIRM_QUESTION = (items) => `A first check of this image reported the items below. Look again at each one, at the place given (boxes are [ymin, xmin, ymax, xmax] on a 0-1000 scale). For each, answer visible = true only if you can actually see it in this image. Do not count what such an object would normally have, and do not count blur, texture or reflections as lettering.

${items.map((t, i) => `${i}. ${t.what}${t.kind ? ` (${t.kind})` : ""}${t.box_2d ? ` at ${JSON.stringify(t.box_2d)}` : ""}`).join("\n")}`;
const CONFIRM_SCHEMA = { type: "OBJECT", properties: { findings: { type: "ARRAY", items: { type: "OBJECT", properties: { index: { type: "INTEGER" }, visible: { type: "BOOLEAN" }, seen: { type: "STRING" } }, required: ["index", "visible"] } } }, required: ["findings"] };

/** One vision call. `imagePath` may be a list: the images follow the question in that order. */
export async function callVision(imagePath, text, schema, { model = CHECK_MODEL, fetchImpl = fetch, key = loadGeminiKey() } = {}) {
  if (!key) throw new Error("GEMINI_KEY not found (.env or environment)");
  const images = [imagePath].flat().map((p) => ({ inline_data: { mime_type: MIME[extname(p).toLowerCase()] || "image/png", data: readFileSync(p).toString("base64") } }));
  const body = {
    contents: [{ parts: [{ text }, ...images] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
  };
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`vision check failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  const txt = out.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!txt) throw new Error("vision check returned no answer");
  return JSON.parse(txt);
}

/** Confirm flagged items one by one. Returns { kept, dismissed }. */
export async function confirmItems(imagePath, items, opts = {}) {
  if (!items.length) return { kept: [], dismissed: [] };
  const { findings = [] } = await callVision(imagePath, CONFIRM_QUESTION(items), CONFIRM_SCHEMA, opts);
  const visible = new Set(findings.filter((f) => f.visible).map((f) => f.index));
  return { kept: items.filter((_, i) => visible.has(i)), dismissed: items.filter((_, i) => !visible.has(i)) };
}

/** Ask the vision model. `fetchImpl` is injectable so the rules can be tested offline. */
export async function askVision(imagePath, { never = [], ...opts } = {}) {
  return callVision(imagePath, QUESTION + (never.length ? NEVER_QUESTION(never) : ""), SCHEMA, opts);
}

// ── the rules (pure) ──────────────────────────────────────────────────────

/** A layout's text areas as boxes on Gemini's 0–1000 scale, [ymin, xmin, ymax, xmax]. */
export function textAreaBoxes(treatment, ratio = "1x1", catalogue = loadCatalogue()) {
  const L = layoutFor(catalogue.treatments.treatments[treatment], ratio, catalogue.treatments);
  return L.groups.map(({ region: [x, y, w, h] }) => [y * 10, x * 10, (y + h) * 10, (x + w) * 10]);
}
const valid = (b) => Array.isArray(b) && b.length === 4 && b[2] > b[0] && b[3] > b[1];
const area = ([y0, x0, y1, x1]) => Math.max(0, y1 - y0) * Math.max(0, x1 - x0);
const overlap = (a, b) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

/** Pixel size of a PNG, JPEG or WebP, read from its header (no image library needed). */
export function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const t = buf.toString("ascii", 12, 16);
    if (t === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
    if (t === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (t === "VP8L") { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  }
  throw new Error("unrecognised image format");
}

const clip1000 = ([y0, x0, y1, x1]) => [Math.max(0, y0), Math.max(0, x0), Math.min(1000, y1), Math.min(1000, x1)];

/**
 * The crop of a photo (focus [fx, fy], as the renderer's cover-fit uses it) that best places its
 * people for a layout. Boxes are on the photo's 0–1000 scale; the result maps them onto the ad's.
 * Prefers, in order: no face cut off, little of the people cut off, the layout's placement rule
 * met, no face under a text area, the crop nearest the centre.
 */
export function bestCrop({ imageSize: [iw, ih], canvas: [W, H], people, faces = [], areas, rule }) {
  const s = Math.max(W / iw, H / ih), visW = W / s, visH = H / s, roomX = iw - visW, roomY = ih - visH;
  const steps = (room) => (room > 1 ? Array.from({ length: 41 }, (_, i) => i / 40) : [0.5]);
  const onAd = (fx, fy) => ([y0, x0, y1, x1]) => [((y0 / 1000) * ih - fy * roomY) / visH * 1000, ((x0 / 1000) * iw - fx * roomX) / visW * 1000, ((y1 / 1000) * ih - fy * roomY) / visH * 1000, ((x1 / 1000) * iw - fx * roomX) / visW * 1000];
  let best = null;
  for (const fx of steps(roomX)) for (const fy of steps(roomY)) {
    const m = onAd(fx, fy), P = people && m(people), F = faces.map(m);
    const cut = P ? 1 - area(clip1000(P)) / area(P) : 0;
    const facesCut = F.filter((f) => area(clip1000(f)) < 0.95 * area(f)).length;
    const seen = P && clip1000(P);
    const under = seen && area(seen) ? areas.reduce((n, a) => n + overlap(seen, a), 0) / area(seen) : 0;
    const facesUnder = F.filter((f) => areas.some((a) => overlap(f, a) > 0.02 * area(f))).length;
    const score = facesCut * 100 + Math.max(0, cut - 0.1) * 50 + (rule === "subject-area" ? Math.max(0, under - MAX_SUBJECT_UNDER_TEXT) * 20 + under : 0)
      + facesUnder * 2 + (Math.abs(fx - 0.5) + Math.abs(fy - 0.5)) * 0.05;
    if (!best || score < best.score) best = { score, focus: [fx, fy], people: P, faces: F, cut, facesCut, under, facesUnder };
  }
  return best;
}

/** Share of a box (0–1000 scale) outside the circle inscribed in the frame — a panel's crop. */
function outsideCircle(b) {
  let out = 0, n = 0;
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
    const y = b[0] + ((i + 0.5) / 40) * (b[2] - b[0]), x = b[1] + ((j + 0.5) / 40) * (b[3] - b[1]);
    n++; if ((x - 500) ** 2 + (y - 500) ** 2 > 500 ** 2) out++;
  }
  return out / n;
}

/** Apply the rules to a vision answer. Returns { ok, stray_text, placement, failures }. */
export function judgeVisual(answer, { treatment, ratio = "1x1", expectPeople = true, maxPeople = null, imageSize: size = null, catalogue = loadCatalogue() }) {
  const failures = [], notes = [];
  // Only lettering a viewer could read fails (2026-09-12: a warning label on a machine is fine, as is a
  // mark with no letters); those are noted for the gallery. An answer without the field fails, as before.
  const items = (answer.text_items || []).filter((t) => t.legible !== false);
  const small = (answer.text_items || []).filter((t) => t.legible === false);
  if (items.length) failures.push(`stray text in the picture: ${items.map((t) => `${t.kind} "${t.what}"`).join("; ")}`);
  if (small.length) notes.push(`small marks: ${small.map((t) => `${t.kind} "${t.what}"`).join("; ")}`);
  const banned = answer.excluded_items || [];
  if (banned.length) failures.push(`shows what the client never allows: ${banned.map((t) => t.what).join("; ")}`);
  const layout = layoutFor(catalogue.treatments.treatments[treatment], ratio, catalogue.treatments);
  const kind = layout.background?.type || "single";
  const areas = textAreaBoxes(treatment, ratio, catalogue);
  const faces = (answer.face_boxes || []).filter(valid);
  const people = valid(answer.people_box) ? answer.people_box : null;
  const rule = kind === "panels" ? "circle" : kind === "collage" ? "none" : describeSubjectArea(layout, { canvas: catalogue.treatments.canvas[ratio], covered: coveredSpans(ratio, catalogue.treatments) }) ? "subject-area" : "none";
  // A single photo is judged at its best crop (a square photo in a square ad has only one).
  const crop = kind === "single" ? bestCrop({ imageSize: size || catalogue.treatments.canvas[ratio], canvas: catalogue.treatments.canvas[ratio], people, faces, areas, rule }) : null;
  const under = crop ? crop.under : 0;
  const facesUnderArea = crop ? crop.facesUnder : 0;
  if (crop && crop.facesCut) failures.push(`every crop cuts off ${crop.facesCut} face(s)`);
  if (crop && crop.cut > 0.1) failures.push(`the best crop still cuts off ${Math.round(crop.cut * 100)}% of the people`);
  if (rule === "subject-area" && people && under > MAX_SUBJECT_UNDER_TEXT) failures.push(`${Math.round(under * 100)}% of the people sit under text areas (max ${MAX_SUBJECT_UNDER_TEXT * 100}%)`);
  const outside = people && rule === "circle" ? outsideCircle(people) : 0;
  if (rule === "circle" && outside > MAX_OUTSIDE_CIRCLE) failures.push(`${Math.round(outside * 100)}% of the people fall outside the circular crop (max ${MAX_OUTSIDE_CIRCLE * 100}%)`);
  if (expectPeople && !people && (answer.people_count || 0) === 0) failures.push("no people found — the scene asked for people");
  // Bystanders drift in even when the prompt asks for an exact count. Noted, not failed (2026-09-12: the
  // owner is fine with a second person in a solo scene); faces under text are caught above regardless.
  if (maxPeople != null && (answer.people_count || 0) > maxPeople) notes.push(`${answer.people_count} people in the picture; the scene has ${maxPeople}`);
  return {
    ok: failures.length === 0,
    stray_text: items,
    notes,
    excluded: banned,
    faces,
    focus: crop ? crop.focus : [0.5, 0.5],
    placement: { rule, focus: crop ? crop.focus : [0.5, 0.5], people_on_ad: crop?.people ? crop.people.map(Math.round) : null, people_box: people, people_count: answer.people_count ?? null, faces: faces.length, faces_under_text_area: facesUnderArea, share_under_text: +under.toFixed(3), share_outside_circle: +outside.toFixed(3), text_areas: areas },
    failures,
  };
}

// ── tiled checking, for photos larger than the vision model looks at ──────

/** Overlapping tiles ([x, y, w, h] px) no longer than `maxSide` on either side. The vision model
 *  looks at a whole image shrunk down: on a 2400 × 1792 photo a logo plate or a wall sconce the size
 *  of a thumbnail vanishes (Step 5, run 2: three marks passed the whole-image check, all three found
 *  in tiles). */
export function tileGrid([w, h], maxSide = 1100, overlap = 0.12) {
  const cols = Math.max(1, Math.ceil(w / maxSide)), rows = Math.max(1, Math.ceil(h / maxSide));
  if (cols === 1 && rows === 1) return [];
  const tw = Math.min(w, Math.round((w / cols) * (1 + overlap))), th = Math.min(h, Math.round((h / rows) * (1 + overlap)));
  const at = (i, n, full, t) => Math.min(full - t, Math.max(0, Math.round((i * full) / n - (t - full / n) / 2)));
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([at(c, cols, w, tw), at(r, rows, h, th), tw, th]);
  return out;
}

/** A box on a tile (0–1000) → the same box on the whole image (0–1000). */
export function fromTile([y0, x0, y1, x1], [tx, ty, tw, th], [w, h]) {
  const X = (v) => Math.round(((tx + (v / 1000) * tw) / w) * 1000), Y = (v) => Math.round(((ty + (v / 1000) * th) / h) * 1000);
  return [Y(y0), X(x0), Y(y1), X(x1)];
}

/** Items found in several tiles are one item: keep the first of any pair that mostly overlap. */
export function dedupeItems(items) {
  const out = [];
  for (const it of items) {
    const b = it.box_2d;
    if (valid(b) && out.some((o) => o.list === it.list && valid(o.box_2d) && overlap(o.box_2d, b) >= 0.5 * Math.min(area(o.box_2d), area(b)))) continue;
    out.push(it);
  }
  return out;
}

/**
 * The text and never-list check, run on the whole image and on each full-resolution tile. Every
 * flagged item is confirmed by a second look at the image it was found in. People are counted on the
 * whole image. `crop(src, [x, y, w, h], out)` cuts a tile (clean-photo.mjs → pixel tools).
 * Returns { text, never, people_count, people_box, face_boxes, dismissed }, boxes on the whole image.
 */
export async function checkTiled(imagePath, { never = [], crop, maxSide = 1100, ask = askVision, confirm = confirmItems, ...opts } = {}) {
  const size = imageSize(readFileSync(imagePath));
  const views = [{ file: imagePath, rect: null }];
  const dir = crop && tileGrid(size, maxSide).length ? mkdtempSync(join(tmpdir(), "check-tiles-")) : null;
  try {
    if (dir) for (const [i, rect] of tileGrid(size, maxSide).entries()) views.push({ file: await crop(imagePath, rect, join(dir, `t${i}.png`)), rect });
    const kept = [], dismissed = [];
    let people = 0, peopleBox = null, faceBoxes = [];
    for (const v of views) {
      const a = await ask(v.file, { never, ...opts });
      if (!v.rect) { people = a.people_count || 0; peopleBox = valid(a.people_box) ? a.people_box : null; faceBoxes = (a.face_boxes || []).filter(valid); }
      const flagged = [...(a.text_items || []).map((t) => ({ ...t, list: "text" })), ...(a.excluded_items || []).map((t) => ({ ...t, list: "never" }))];
      const r = await confirm(v.file, flagged, opts);
      const place = (t) => (v.rect && valid(t.box_2d) ? { ...t, box_2d: fromTile(t.box_2d, v.rect, size) } : t);
      kept.push(...r.kept.map(place));
      dismissed.push(...r.dismissed.map(place));
    }
    const all = dedupeItems(kept);
    return { text: all.filter((t) => t.list === "text"), never: all.filter((t) => t.list === "never"), people_count: people, people_box: peopleBox, face_boxes: faceBoxes, dismissed, tiles: views.length - 1 };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Is each of these items still there? A targeted look at each known item, in the full-resolution
 * tile that holds it, rather than an open search. An open search can find an item one round and
 * miss it the next while it is still there (Step 5, run 4: a sconce in a mirror was found, then
 * passed). Items are { what, kind?, box_2d, list } with boxes on the whole image. Returns the ones
 * still visible, boxes on the whole image.
 */
export async function confirmTiled(imagePath, items, { crop, maxSide = 1100, confirm = confirmItems, ...opts } = {}) {
  const todo = items.filter((t) => valid(t.box_2d));
  if (!todo.length) return [];
  const size = imageSize(readFileSync(imagePath));
  const tiles = crop ? tileGrid(size, maxSide) : [];
  if (!tiles.length) return (await confirm(imagePath, todo, opts)).kept;
  const px = ([y0, x0, y1, x1]) => [(x0 / 1000) * size[0], (y0 / 1000) * size[1], (x1 / 1000) * size[0], (y1 / 1000) * size[1]];
  const holds = ([x, y, w, h], b) => { const [bx0, by0, bx1, by1] = px(b); return bx0 >= x && by0 >= y && bx1 <= x + w && by1 <= y + h; };
  const centre = ([x, y, w, h], b) => { const [bx0, by0, bx1, by1] = px(b), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2; return cx >= x && cx < x + w && cy >= y && cy < y + h; };
  const groups = new Map();
  for (const t of todo) {
    const i = Math.max(0, tiles.findIndex((r) => holds(r, t.box_2d)) >= 0 ? tiles.findIndex((r) => holds(r, t.box_2d)) : tiles.findIndex((r) => centre(r, t.box_2d)));
    groups.set(i, [...(groups.get(i) || []), t]);
  }
  const dir = mkdtempSync(join(tmpdir(), "confirm-tiles-"));
  try {
    const still = [];
    for (const [i, group] of groups) {
      const [tx, ty, tw, th] = tiles[i], file = await crop(imagePath, tiles[i], join(dir, `t${i}.png`));
      const toTile = ([y0, x0, y1, x1]) => [((y0 / 1000) * size[1] - ty) / th, ((x0 / 1000) * size[0] - tx) / tw, ((y1 / 1000) * size[1] - ty) / th, ((x1 / 1000) * size[0] - tx) / tw].map((v) => Math.max(0, Math.min(1000, Math.round(v * 1000))));
      const { kept } = await confirm(file, group.map((t) => ({ ...t, box_2d: toTile(t.box_2d), original: t })), opts);
      still.push(...kept.map((k) => k.original));
    }
    return still;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Which layouts a checked photo can carry, each with the crop it would use. A photo is generated for
 * one layout, but where its people and faces are does not depend on the layout, so one vision answer
 * judges it against every layout at once (placement only — stray text and the never-list were settled
 * when it was checked). `answer`: { people_box, face_boxes, people_count }.
 * Returns { layoutId: { ok, focus, rule, failures } }.
 */
export function fitLayouts(answer, { ratio = "1x1", imageSize: size = null, expectPeople = true, maxPeople = null, catalogue = loadCatalogue() } = {}) {
  const placementOnly = { ...answer, text_items: [], excluded_items: [] };
  return Object.fromEntries(Object.keys(catalogue.treatments.treatments).map((id) => {
    const j = judgeVisual(placementOnly, { treatment: id, ratio, expectPeople, maxPeople, imageSize: size, catalogue });
    return [id, { ok: j.ok, focus: j.focus, rule: j.placement.rule, failures: j.failures }];
  }));
}

/** A reference photo is a source of stray text: whatever lettering it carries, the model reproduces
 *  (Step 4, runs 1–6: facility-04's treadmill consoles read "SET", "15"…). References get the same
 *  text check before they are used. Returns the text items found (empty = clean). */
export async function checkReference(imagePath, opts = {}) {
  const answer = await askVision(imagePath, opts);
  return (await confirmItems(imagePath, answer.text_items || [], opts)).kept;
}

export async function checkVisual(imagePath, { treatment, ratio = "1x1", expectPeople = true, maxPeople = null, never = [], ...opts }) {
  const answer = await askVision(imagePath, { ...opts, never });
  // Anything flagged gets a second, targeted look before it can fail the picture.
  // Small marks never fail, so they skip the second look and go straight through as notes.
  const small = (answer.text_items || []).filter((t) => t.legible === false);
  const flagged = [...(answer.text_items || []).filter((t) => t.legible !== false).map((t) => ({ ...t, list: "text" })), ...(answer.excluded_items || []).map((t) => ({ ...t, list: "never" }))];
  const { kept, dismissed } = await confirmItems(imagePath, flagged, opts);
  const confirmed = { ...answer, text_items: [...kept.filter((t) => t.list === "text"), ...small], excluded_items: kept.filter((t) => t.list === "never") };
  return { ...judgeVisual(confirmed, { treatment, ratio, expectPeople, maxPeople, imageSize: imageSize(readFileSync(imagePath)) }), dismissed, answer };
}
