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

import { readFileSync } from "fs";
import { extname } from "path";
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

1. List every instance of: letters, words, numbers or digits, logos or brand marks, watermarks, signage (including neon), labels, and user-interface elements (buttons, arrows, cursors, icons). Include partial or illegible lettering. Only list what you can actually see in this image — never markings you would expect such an object to carry. If there is none, return an empty list. Do not list plain patterns, textures or shapes that are not lettering or marks.
2. Give one box enclosing all the people in the image, one box per visible face, and the number of people (including anyone in the background or in a mirror).

Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000.`;
const NEVER_QUESTION = (never) => `

3. The client never allows any of the following in their photos. List each one you can see, even partly or small (for example a single wall fitting). If none are present, return an empty list:
${never.map((n) => `- ${n}`).join("\n")}`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    text_items: { type: "ARRAY", items: { type: "OBJECT", properties: { what: { type: "STRING" }, kind: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["what", "kind"] } },
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

async function callVision(imagePath, text, schema, { model = CHECK_MODEL, fetchImpl = fetch, key = loadGeminiKey() } = {}) {
  if (!key) throw new Error("GEMINI_KEY not found (.env or environment)");
  const data = readFileSync(imagePath).toString("base64");
  const body = {
    contents: [{ parts: [{ text }, { inline_data: { mime_type: MIME[extname(imagePath).toLowerCase()] || "image/png", data } }] }],
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
  const failures = [];
  const items = answer.text_items || [];
  if (items.length) failures.push(`stray text in the picture: ${items.map((t) => `${t.kind} "${t.what}"`).join("; ")}`);
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
  // Bystanders drift in even when the prompt forbids them; a scene that says how many people it has is held to it.
  if (maxPeople != null && (answer.people_count || 0) > maxPeople) failures.push(`${answer.people_count} people in the picture; the scene has ${maxPeople}`);
  return {
    ok: failures.length === 0,
    stray_text: items,
    excluded: banned,
    faces,
    focus: crop ? crop.focus : [0.5, 0.5],
    placement: { rule, focus: crop ? crop.focus : [0.5, 0.5], people_on_ad: crop?.people ? crop.people.map(Math.round) : null, people_box: people, people_count: answer.people_count ?? null, faces: faces.length, faces_under_text_area: facesUnderArea, share_under_text: +under.toFixed(3), share_outside_circle: +outside.toFixed(3), text_areas: areas },
    failures,
  };
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
  const flagged = [...(answer.text_items || []).map((t) => ({ ...t, list: "text" })), ...(answer.excluded_items || []).map((t) => ({ ...t, list: "never" }))];
  const { kept, dismissed } = await confirmItems(imagePath, flagged, opts);
  const confirmed = { ...answer, text_items: kept.filter((t) => t.list === "text"), excluded_items: kept.filter((t) => t.list === "never") };
  return { ...judgeVisual(confirmed, { treatment, ratio, expectPeople, maxPeople, imageSize: imageSize(readFileSync(imagePath)) }), dismissed, answer };
}
