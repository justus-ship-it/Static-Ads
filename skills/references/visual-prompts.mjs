/**
 * visual-prompts.mjs — Layer 1 of the offer-first creative: prompts for PICTURES ONLY.
 *
 * The image model never draws a letter: every ad's words are set afterwards by
 * render-composites.mjs. So a visual prompt carries no copy at all, forbids text of every kind,
 * and is composed around the layout the text will use: the areas where text will sit are
 * described as calm, plain space the subject stays out of, measured from the same geometry the
 * renderer uses (offer-treatments.json), for the ratio being generated.
 *
 * The client's photography lock (gym-profile.json → brand_lock.photography) supplies what the
 * picture must show, must never show, and who is in it. The logo is never attached: it would
 * invite the model to draw it.
 */

import { loadCatalogue, layoutFor } from "./render-composites.mjs";

// The share of the people's box that may sit under text areas (check-visual.mjs enforces it; the
// prompt's size limit is derived from it, so the two can never disagree).
export const MAX_SUBJECT_UNDER_TEXT = 0.4;

// Gemini took "keep this area darker" literally and painted dark or mirrored strips across the
// frame (Step 4, runs 1–3). The renderer darkens what the words need, so the photo is asked to be
// plain, never darker, and to be one untouched scene.
export const ONE_PHOTO_CLAUSE =
  "It is one continuous, natural photograph: no added bars, strips, borders, frames, split screens, mirrored " +
  "reflections, vignettes or darkened bands. Any darkening the words need is added later by software.";

export const NO_TEXT_CLAUSE =
  "PHOTOGRAPH ONLY. There must be no text of any kind anywhere in the image: no letters, words, numbers, " +
  "signage, neon signs, logos, brand marks, watermarks, captions, labels, price tags, user-interface elements " +
  "(buttons, arrows, cursors), borders or graphic overlays. Clothing is plain and unbranded; equipment shows no " +
  "numbers, weight markings or brand names; treadmills, bikes and any machine with a console are out of the frame or turned so their consoles face away from the camera. The advert's words are added later " +
  "by software, so any lettering in the photo ruins it.";

const pct = (v) => `${Math.round(v)}%`;
export const POSES = {
  upright: "standing, full-length",
  compact: "seated, kneeling, crouching, or framed from the waist up",
  low: "horizontal or on the floor — plank, push-up, floor work",
};

/** Can this layout's photo hold this pose? Returns null when it can, else the reason. */
export function poseProblem(treatment, pose, catalogue = loadCatalogue()) {
  const tr = catalogue.treatments.treatments[treatment];
  if (!pose) return null; // undeclared: the prompt's framing still applies
  if (!POSES[pose]) return `unknown pose "${pose}" — use one of ${Object.keys(POSES).join(", ")}`;
  const fit = tr.pose_fit || Object.keys(POSES);
  return fit.includes(pose) ? null : `${treatment} cannot hold ${/^[aeiou]/.test(pose) ? "an" : "a"} ${pose} pose (${POSES[pose]}); it needs ${fit.map((f) => `${f} (${POSES[f]})`).join(" or ")}. Pair this scene with another layout, or change the pose.`;
}
const ASPECT_WORDS = { "1:1": "square (1:1)", "3:4": "portrait 3:4 (taller than wide)", "4:3": "landscape 4:3 (wider than tall)", "9:16": "vertical 9:16 (portrait, taller than wide)" };

/** Plain-language description of where text will sit, from the layout's group regions. */
export function describeTextAreas(layout) {
  return layout.groups.map((g) => {
    const [x, y, w, h] = g.region;
    const across = x <= 8 && x + w >= 92 ? "across the full width" : x + w / 2 < 50 ? `on the left side (${pct(x)}–${pct(x + w)} of the width)` : `on the right side (${pct(x)}–${pct(x + w)} of the width)`;
    return `the area from ${pct(y)} to ${pct(y + h)} of the height, ${across}`;
  });
}

/** Spans (% of height) where a face would be covered: in 9:16, the top and bottom the app covers
 *  (offer-treatments.json → safe_area). 1:1 has no covered zone — its 5% margin is just a margin. */
export function coveredSpans(ratio, T = loadCatalogue().treatments) {
  if (ratio === "1x1") return [];
  const [, y, , h] = T.safe_area[ratio];
  return [[0, y], [y + h, 100]];
}

// The largest stretch of the frame no text area (or covered zone) takes, along one axis, in %.
function largestGap(spans) {
  const gaps = []; let at = 0;
  for (const [a, b] of [...spans].sort((m, n) => m[0] - n[0])) { if (a > at) gaps.push([at, a]); at = Math.max(at, b); }
  if (at < 100) gaps.push([at, 100]);
  return gaps.sort((m, n) => (n[1] - n[0]) - (m[1] - m[0]))[0] || null;
}
const MIN_GAP_PX = 140; // a stretch narrower than this is no place for a face
const fullWidth = (layout) => layout.groups.every(({ region: [x, , w] }) => x <= 8 && x + w >= 92);

/** The free stretch faces and upper bodies can use: [from, to] in % along the axis, or null. */
function freeStretch(layout, { canvas = [1080, 1080], covered = [] } = {}) {
  const wide = fullWidth(layout);
  const spans = layout.groups.map(({ region: [x, y, w, h] }) => (wide ? [y, y + h] : [x, x + w]));
  const g = largestGap(wide ? [...spans, ...covered] : spans);
  const size = wide ? canvas[1] : canvas[0];
  return g && ((g[1] - g[0]) / 100) * size >= MIN_GAP_PX ? { wide, from: g[0], to: g[1] } : null;
}

/** For layouts whose text spans the width: the tallest a person can be and still keep at least
 *  (1 − MAX_SUBJECT_UNDER_TEXT) of their box in the free stretch, as a % of the frame's height.
 *  A stretch at the frame's edge leaves ~8% headroom. Rounded down to 5%. Null for columns. */
export function maxFigureHeight(layout, opts = {}) {
  const f = freeStretch(layout, opts);
  if (!f || !f.wide) return null;
  const free = f.from === 0 || f.to === 100 ? f.to - f.from - 8 : f.to - f.from;
  return free < 5 ? null : Math.min(95, Math.floor(free / (1 - MAX_SUBJECT_UNDER_TEXT) / 5) * 5);
}

/** Where faces and the subject's upper body can go without falling under text or under the app's
 *  covered zones: the biggest free stretch — a band of height when the text spans the width, a side
 *  when the text is a column. Null when there is none (text over the whole live area). */
export function describeSubjectArea(layout, opts = {}) {
  const f = freeStretch(layout, opts);
  if (!f) return null;
  const { wide, from: a, to: b } = f;
  if (wide) return a === 0 ? `the top ${pct(b)} of the frame` : b === 100 ? `the bottom ${pct(100 - a)} of the frame` : `the band between ${pct(a)} and ${pct(b)} of the height`;
  return a === 0 ? `the left ${pct(b)} of the frame` : b === 100 ? `the right ${pct(100 - a)} of the frame` : `the strip between ${pct(a)} and ${pct(b)} of the width`;
}

/**
 * The frame Gemini is asked for. Gemini centres its subject whatever the prompt says (Step 4, runs
 * 1–5), so a square ad is generated from a larger photo — 3:4 when the text spans the width, 4:3
 * for a column — and the checker then crops the square with the people exactly where the layout
 * needs them (check-visual.mjs → bestCrop). visW/visH: the share of the photo the ad shows.
 * Panels and collage tiles are cropped to their own shapes, so they stay square; 9:16 is native.
 */
export function generationFrame(layout, ratio = "1x1") {
  if (ratio !== "1x1") return { aspect: ratio.replace("x", ":"), visW: 1, visH: 1 };
  const bg = layout.background?.type;
  if (bg === "panels" || bg === "collage") return { aspect: "1:1", visW: 1, visH: 1 };
  if (fullWidth(layout)) return freeStretch(layout) ? { aspect: "3:4", visW: 1, visH: 0.75 } : { aspect: "1:1", visW: 1, visH: 1 };
  return { aspect: "4:3", visW: 0.75, visH: 1 };
}

/** The layout's geometry in the generated photo's coordinates, assuming the centred crop. */
export function toGenFrame(layout, f) {
  if (f.visW === 1 && f.visH === 1) return layout;
  const mx = ((1 - f.visW) / 2) * 100, my = ((1 - f.visH) / 2) * 100;
  const map = ([x, y, w, h]) => [mx + x * f.visW, my + y * f.visH, w * f.visW, h * f.visH];
  return { ...layout, groups: layout.groups.map((g) => ({ ...g, region: map(g.region) })), clear_zones: (layout.clear_zones || []).map((z) => ({ ...z, rect: map(z.rect) })) };
}

/**
 * Build the prompt for one visual.
 *   treatment: layout id (its visual_hint and text areas shape the composition)
 *   scene:     what the photo shows — people, activity (from the batch brief; never ad copy)
 *   photography: gym-profile.json → brand_lock.photography
 *   hasReference: whether a photo of the real premises is attached
 *   brandNames:  names to keep out of the prompt (the client's own name included)
 *
 * Words are never named, not even to forbid them: naming "FirenGym" or a neon slogan to an image
 * model invites it to draw them. Never-list items that are about text are covered by the no-text
 * clause and dropped; the client's own name is removed from the rest.
 */
/** How a real session with more than one person looks, by the scene's setting tag. */
export const CANDID = {
  group: "CANDID: a real class caught mid-session. The people are loosely spaced at different angles to the camera, each at a slightly different point of the movement and training at their own pace, and there is some interaction between them — a glance, a word, a grin, a coach's cue.",
  coached: "CANDID: the coach is working with the client — watching closely, cueing, or with a hand ready to help — and the client is focused on the movement.",
};
/** Every photo: real equipment, used as it is meant to be (48-ad batch: a cable row with no machine). */
export const REAL_CLAUSE = "REAL: everything could be photographed in a real gym. The equipment is complete and true to size, and it is used the way it is meant to be: each body rests on the seat, bench or floor that holds it, hands grip real handles, and the load sits where it does in the real exercise.";

export function buildVisualPrompt({ treatment, scene, ratio = "1x1", photography = {}, hasReference = false, brandNames = [], people = null, setting = null, catalogue = loadCatalogue() }) {
  const T = catalogue.treatments;
  const tr = T.treatments[treatment];
  if (!tr) throw new Error(`unknown treatment "${treatment}"`);
  if (!scene || typeof scene !== "string") throw new Error("a visual needs a scene: what the photo shows");
  if (/["“”]/.test(scene)) throw new Error("the scene contains quotation marks — scenes describe the picture, never words to show in it");
  const layout = layoutFor(tr, ratio, T);
  const names = brandNames.filter(Boolean);
  const escape = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  // "the real Sculpt Society premises" → "the real premises": the name goes, the meaning stays.
  const scrub = (t) => names.reduce((a, n) => a.replace(new RegExp(`\\s*${escape(n)}('s)?`, "gi"), ""), t).replace(/\s{2,}/g, " ").trim();
  const isAboutText = (t) => /\b(text|wordmark|reading|words?|lettering|slogan)\b/i.test(t);
  const never = (photography.never || []).filter((t) => !isAboutText(t)).map(scrub);
  const must = (photography.must || []).map(scrub);
  const hint = tr.visual_hint.replace(/\s*No text, letters, signage, logos or watermarks anywhere\.\s*$/, "");
  const frame = generationFrame(layout, ratio);
  const gl = toGenFrame(layout, frame);
  const [cw, ch] = T.canvas[ratio];
  const where = { canvas: [cw / frame.visW, ch / frame.visH], covered: frame.visH === 1 ? coveredSpans(ratio, T) : [] };
  const areas = describeTextAreas(gl);
  const subjectArea = describeSubjectArea(gl, where);
  const maxH = layout.background?.type ? null : maxFigureHeight(gl, where);
  const lines = [
    `A realistic, natural-light photograph for a gym's social media advert, ${ASPECT_WORDS[frame.aspect] || frame.aspect}.`,
    "",
    NO_TEXT_CLAUSE,
    ONE_PHOTO_CLAUSE,
    "",
    `SCENE: ${scene}`,
  ];
  // The head count is stated outright: "apart from the people in the scene" still let the model add
  // gym-goers in the background of wide shots (48-ad batch, 2026-09-11).
  const count = Number.isInteger(people) ? `Exactly ${people} ${people === 1 ? "person" : "people"} in the whole photo, and nobody else: no one in the background, at other equipment, or reflected in the mirrors.` : "Apart from the people in the scene, the gym is empty — nobody else in the room or reflected in the mirrors.";
  if (photography.people) lines.push(`PEOPLE: ${photography.people}. Real people, candid and mid-movement, not posed models; nobody looks into the camera. It is a private session. ${count}`);
  // Group classes came back as line-ups — identical poses at the same instant (48-ad batch, 2026-09-12).
  // Said as what a real class looks like; the faults are never named, since naming invites them.
  if (CANDID[setting]) lines.push(CANDID[setting]);
  lines.push(REAL_CLAUSE);
  if (must.length) lines.push(`SETTING (must show): ${must.join("; ")}.`);
  if (hasReference) {
    lines.push("The attached reference photo is the real gym. Match its room: wall colour, ceiling, lighting, floor and equipment. " +
      "Do NOT copy any sign, lettering or neon words from it — none may appear in your image.");
  }
  lines.push(
    "",
    `COMPOSITION: ${hint}`,
    ...(tr.visual_framing ? [`FRAMING: ${tr.visual_framing} If the scene's pose would not fit this framing, show a variant of the same exercise that does (for example a seated, kneeling or floor version).`] : []),
    `Text will be laid over ${areas.join(" and over ")}. Keep ${areas.length > 1 ? "those areas" : "that area"} calm, plain and free of ` +
      "faces and the main action, so the words stay readable. No face may fall inside them.",
  );
  if (subjectArea && layout.background?.type !== "panels") {
    lines.push(`Place every face, and the subject's head and upper body, within ${subjectArea}. Frame the shot so the people are small enough to fit — ` +
      "only arms, legs or equipment may run into the text area, and only a little.");
    // Gemini overshoots a size limit slightly (run 6: 31% when asked for 30%), so it is asked for 85% of the maximum.
    const target = Math.floor((maxH * 0.85) / 5) * 5;
    if (maxH) lines.push(`SIZE: each person's whole figure, head to feet, is at most ${target}% of the frame's height — shoot from further back or use a lower pose.`);
  }
  if (frame.visW < 1 || frame.visH < 1) lines.push("The advert is a square cut from this photo, so keep the people whole and well inside the frame, with plain floor, wall or ceiling around them.");
  if (layout.background?.type === "panels") lines.push("This photo will be cropped to a circle: keep the subject centred with space around it.");
  if (layout.background?.type === "collage") lines.push("This photo will be one tile of a collage: a tight, single-subject crop.");
  if (never.length) lines.push("", `NEVER SHOW: ${never.join("; ")}.`);
  return { prompt: lines.join("\n"), treatment, ratio, aspect: frame.aspect, text_areas: layout.groups.map((g) => g.region) };
}
