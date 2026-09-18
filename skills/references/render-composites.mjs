#!/usr/bin/env node
/**
 * render-composites.mjs — Layer 2 of the offer-first creative: set the text over a picture.
 *
 * The image model makes pictures only. This script puts the user's exact words on them —
 * location callout, audience callout, offer — inside fixed boxes, in real fonts, using the
 * installed Google Chrome as the typesetter. Nothing here invents text: the only strings it
 * accepts are the ones passed in.
 *
 * Zero npm dependencies: Chrome is driven over its DevTools protocol with Node's built-in
 * WebSocket (Node 22+).
 *
 * A layout is one or more text groups (offer-treatments.json), each with its own region,
 * alignment, scrim direction, optional band and dividers, plus clear zones kept free for the
 * subject. Bad layout geometry is refused before anything renders (validateLayout).
 *
 * Every render is verified after the fact, independently of what the page claims: exact
 * strings, lines within limits, every line inside its group's region and the canvas margin,
 * nothing in a clear zone, contrast met (or a recorded fallback), dividers at 3:1, fonts
 * genuinely loaded, hierarchy held. A render that fails any check writes no image and exits
 * non-zero.
 *
 * Usage:
 *   node skills/references/render-composites.mjs --image <photo> \
 *     [--image <photo2> …  (T7 collage: 4+ photos, T8 panels: 2)] \
 *     --location "BISHAN" --audience "LADIES WANTED" \
 *     --offer "12 Week Confidence Comeback Challenge" [--free] \
 *     [--treatment t1-bottom-stack] [--style s1-heavy-sans] [--palette cyan-pink] [--ratio 1x1] \
 *     --out <file.png> [--report <file.json>]
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname, extname } from "path";
import { tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import { parseArgs } from "util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REF_DIR = join(REPO_ROOT, ".claude", "skills", "static-ads", "references");
const TEMPLATE = join(REPO_ROOT, "skills", "references", "composite-template.html");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
const LIMITS = { location: 40, audience: 40, offer: 90 };
const EDGE_MARGIN = 0.05; // every line stays at least 5% inside the canvas edges
const TOL = 1; // px of layout rounding tolerance
const DIVIDER_CONTRAST = 3; // a divider is a mark, not text: WCAG's non-text contrast level

// ── Inputs ────────────────────────────────────────────────────────────────

/** Reject anything that would break the ad or the Ads Uploader import. Mirrors hasEmDash in
 *  client-config.mjs: em/en dashes corrupt the importer, so they are refused, not replaced. */
export function validateInputs({ location, audience, offer }) {
  const errors = [];
  const check = (label, v, required) => {
    if (v == null || v === "") { if (required) errors.push(`${label} is required`); return; }
    if (typeof v !== "string") { errors.push(`${label} must be text`); return; }
    if (/[\r\n]/.test(v)) errors.push(`${label} contains a line break — layout decides where lines break`);
    if (/[—–]/.test(v)) errors.push(`${label} contains an em/en dash, which breaks the Ads Uploader import — use a plain hyphen`);
    if (v.trim() !== v) errors.push(`${label} has leading or trailing spaces`);
    if (v.length > LIMITS[label]) errors.push(`${label} is ${v.length} characters; the limit is ${LIMITS[label]}`);
  };
  check("location", location, true);
  check("audience", audience, false);
  check("offer", offer, true);
  return errors;
}

/** Split "12 Week Confidence Comeback Challenge" into a duration line ("12 Week") and a name
 *  line ("Confidence Comeback Challenge"), the way every reference ad stacks it. Only splits —
 *  never rewords — and proves the two halves rejoin to exactly the user's string. */
export function splitOffer(offer, freePrefix = false) {
  const m = offer.match(/^(\d+[- ]?(?:weeks?|days?|months?))\s+(.+)$/i);
  let duration = m ? m[1] : null;
  const offer_name = m ? m[2] : offer;
  if (m && `${duration} ${offer_name}` !== offer) throw new Error(`offer split did not round-trip: "${offer}"`);
  if (freePrefix) duration = duration ? `FREE ${duration}` : null;
  const name = !duration && freePrefix ? `FREE ${offer_name}` : offer_name;
  return { duration, offer_name: name };
}

// ── Spec ──────────────────────────────────────────────────────────────────

const loadJson = (p) => JSON.parse(readFileSync(p, "utf-8"));

export function imageDataUrl(pathOrUrl) {
  if (pathOrUrl.startsWith("data:")) return pathOrUrl;
  const p = resolve(pathOrUrl);
  const mime = MIME[extname(p).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type: ${p}`);
  if (!existsSync(p)) throw new Error(`image not found: ${p}`);
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}

const EFFECTS = ["fill", "outline-bold", "hollow", "band"];
const STROKE_ALLOWANCE = 0.04; // em per side: the widest outline (0.075em stroke) reaches half its width outside
// A hollow line's outline is centred on the letter edge and Chrome joins it with sharp mitres, so
// pointed corners reach further: measured up to 0.081em past the box (the "K" of Montserrat Black,
// Step 3). Reserved per side instead of STROKE_ALLOWANCE for hollow lines.
const HOLLOW_ALLOWANCE = 0.07;
const BAND_PAD = 0.24;         // em per side reserved for a style band's padding

/** The three catalogues: layouts, palettes, styles. */
export function loadCatalogue() {
  return {
    treatments: loadJson(join(REF_DIR, "offer-treatments.json")),
    palettes: loadJson(join(REF_DIR, "offer-palettes.json")),
    styles: loadJson(join(REF_DIR, "offer-styles.json")),
  };
}

const TEXT_BLOCKS = ["location", "audience", "duration", "offer_name"];
const ANCHORS = ["top", "center", "bottom"];
const ALIGNS = ["left", "center", "right"];
const SCRIMS = ["none", "top", "bottom", "left", "right", "even"];
const BACKGROUNDS = ["single", "collage", "panels"];

/** Geometry rules every layout must meet before anything renders. Returns a list of problems.
 *  Regions are in % of the canvas, so these hold at any canvas size. `safe` is the ratio's safe
 *  area [x, y, w, h] in % (offer-treatments.json → safe_area): 1:1 keeps a 5% margin; 9:16 is
 *  Meta's Stories/Reels safe zone. */
export function validateLayout(layout, id = "layout", canvas = [1, 1], safe = [5, 5, 90, 90]) {
  const e = [];
  const sa = { x0: safe[0], y0: safe[1], x1: safe[0] + safe[2], y1: safe[1] + safe[3] };
  const saText = safe.join() === "5,5,90,90" ? "the 5% canvas margin" : `the safe area (x ${+sa.x0.toFixed(2)}–${+sa.x1.toFixed(2)}%, y ${+sa.y0.toFixed(2)}–${+sa.y1.toFixed(2)}%)`;
  const box = ([x, y, w, h]) => ({ x0: x, y0: y, x1: x + w, y1: y + h });
  const meets = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const groups = layout?.groups;
  if (!Array.isArray(groups) || !groups.length) return [`${id}: needs at least one text group`];
  const count = Object.fromEntries(TEXT_BLOCKS.map((k) => [k, 0]));
  const ids = new Set();
  for (const g of groups) {
    const gid = `${id} group "${g.id}"`;
    if (!g.id || ids.has(g.id)) e.push(`${gid}: every group needs its own id`);
    ids.add(g.id);
    if (!Array.isArray(g.region) || g.region.length !== 4 || g.region.some((v) => typeof v !== "number")) { e.push(`${gid}: region must be [x, y, w, h]`); continue; }
    const r = box(g.region);
    if (r.x0 < sa.x0 - 1e-9 || r.y0 < sa.y0 - 1e-9 || r.x1 > sa.x1 + 1e-9 || r.y1 > sa.y1 + 1e-9) e.push(`${gid}: region crosses ${saText}`);
    if (!ANCHORS.includes(g.anchor)) e.push(`${gid}: anchor must be one of ${ANCHORS.join(", ")}`);
    if (!ALIGNS.includes(g.align)) e.push(`${gid}: align must be one of ${ALIGNS.join(", ")}`);
    if (!SCRIMS.includes(g.scrim?.direction)) e.push(`${gid}: scrim.direction must be one of ${SCRIMS.join(", ")}`);
    const st = g.stack || [];
    if (!st.length) e.push(`${gid}: empty stack`);
    st.forEach((it, i) => {
      if (it.block === "divider") {
        if (i === 0 || i === st.length - 1) e.push(`${gid}: a divider must sit between two lines`);
        if (st[i - 1]?.block === "divider") e.push(`${gid}: two dividers in a row`);
        if (!(it.width_pct > 0 && it.width_pct <= 100) || !(it.thickness_pct > 0)) e.push(`${gid}: divider needs width_pct and thickness_pct`);
      } else if (!TEXT_BLOCKS.includes(it.block)) {
        e.push(`${gid}: unknown line "${it.block}"`);
      } else {
        count[it.block]++;
        if (!(it.share > 0) || !(it.max_lines >= 1) || !(it.min_px > 0)) e.push(`${gid}: "${it.block}" needs share, max_lines and min_px`);
      }
    });
    if (g.band) {
      const b = g.band;
      if (!["full", "line"].includes(b.mode)) e.push(`${gid}: band.mode must be full or line`);
      if (!["pill", "bar"].includes(b.shape)) e.push(`${gid}: band.shape must be pill or bar`);
      const lines = st.filter((it) => it.block !== "divider").map((it) => it.block);
      if (!b.blocks?.length || b.blocks.some((k) => !lines.includes(k))) e.push(`${gid}: band.blocks must name lines in this group`);
      const pos = st.map((it) => it.block);
      const idx = (b.blocks || []).map((k) => pos.indexOf(k)).sort((a, c) => a - c);
      if (idx.length && idx[idx.length - 1] - idx[0] !== idx.length - 1) e.push(`${gid}: banded lines must be next to each other, with no divider between`);
    }
  }
  if (count.location !== 1) e.push(`${id}: the location line must appear exactly once (found ${count.location})`);
  if (count.duration !== 1) e.push(`${id}: the duration line must appear exactly once (found ${count.duration})`);
  if (count.offer_name !== 1) e.push(`${id}: the offer name must appear exactly once (found ${count.offer_name})`);
  if (count.audience > 1) e.push(`${id}: the audience line may appear at most once`);

  const valid = groups.filter((g) => Array.isArray(g.region) && g.region.length === 4);
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    if (meets(box(valid[i].region), box(valid[j].region))) e.push(`${id}: groups "${valid[i].id}" and "${valid[j].id}" overlap`);
  }
  // A scrim covers everything on its side of the text, full width (or full height). It must not
  // reach another group, or that group's contrast would be judged on the wrong background.
  for (const g of valid) {
    const d = g.scrim?.direction, f = g.scrim?.fade_pct || 0, r = box(g.region);
    if (d === "even" && valid.length > 1) e.push(`${id}: an even scrim covers the whole canvas, so it needs a single-group layout`);
    for (const o of valid) {
      if (o === g) continue;
      const q = box(o.region);
      const hit = d === "bottom" ? q.y1 > r.y0 - f : d === "top" ? q.y0 < r.y1 + f : d === "right" ? q.x1 > r.x0 - f : d === "left" ? q.x0 < r.x1 + f : false;
      if (hit) e.push(`${id}: group "${g.id}"'s ${d} scrim would reach group "${o.id}"`);
    }
  }
  for (const z of layout.clear_zones || []) {
    if (!z.name || !Array.isArray(z.rect) || z.rect.length !== 4) { e.push(`${id}: clear zones need a name and rect`); continue; }
    for (const g of valid) if (meets(box(z.rect), box(g.region))) e.push(`${id}: group "${g.id}" touches the clear zone "${z.name}"`);
  }
  const bg = layout.background;
  if (bg) {
    if (!BACKGROUNDS.includes(bg.type)) e.push(`${id}: background.type must be one of ${BACKGROUNDS.join(", ")}`);
    if (bg.type === "collage") {
      if (!(Number.isInteger(bg.cols) && bg.cols >= 1 && Number.isInteger(bg.rows) && bg.rows >= 1)) e.push(`${id}: a collage needs whole-number cols and rows`);
      // Tiles take the photos in order, repeating. With more photos than columns, no tile ever
      // has the same photo beside or above it.
      if (!(bg.min_images > bg.cols)) e.push(`${id}: a ${bg.cols}-column collage needs min_images of at least ${bg.cols + 1}, or a photo would repeat next to itself`);
    }
    if (bg.type === "panels") {
      if (!/^#[0-9A-Fa-f]{6}$/.test(bg.backdrop || "")) e.push(`${id}: panels need a backdrop colour`);
      if (!bg.panels?.length) e.push(`${id}: panels need at least one panel`);
      if (bg.min_images !== bg.panels?.length) e.push(`${id}: panels need one photo each (min_images = ${bg.panels?.length})`);
      const bp = bg.backdrop_photo;
      if (bp && !(Number.isInteger(bp.image) && bp.image >= 0 && bp.image < (bg.panels?.length || 0) && bp.blur_pct >= 0 && bp.darken >= 0 && bp.darken <= 1)) {
        e.push(`${id}: backdrop_photo needs image (one of the panels' photos), blur_pct and darken (0–1)`);
      }
      (bg.panels || []).forEach((pn, i) => {
        const ry = (pn.r * canvas[0]) / canvas[1]; // r is a % of the width; the circle is round on any canvas
        const pb = { x0: pn.cx - pn.r, y0: pn.cy - ry, x1: pn.cx + pn.r, y1: pn.cy + ry };
        if (pn.shape !== "circle") e.push(`${id}: panel ${i + 1} shape must be circle`);
        if (pb.x0 < 0 || pb.y0 < 0 || pb.x1 > 100 || pb.y1 > 100) e.push(`${id}: panel ${i + 1} leaves the canvas`);
        for (const g of valid) if (meets(pb, box(g.region))) e.push(`${id}: panel ${i + 1} touches group "${g.id}"`);
      });
    }
  }
  return e;
}

/** Derive a layout for another canvas ratio from an approved one: the source's safe area is mapped
 *  onto the target's, and every length in % of the canvas is scaled with it. The 9:16 safe area
 *  (950 × 979 px) is nearly the 1:1 text area (972 × 972 px), so text comes out about as large. */
export function deriveLayout(layout, from, to, T = loadCatalogue().treatments) {
  const [fx, fy, fw, fh] = T.safe_area[from], [tx, ty, tw, th] = T.safe_area[to];
  const sx = tw / fw, sy = th / fh;
  const X = (x) => tx + (x - fx) * sx, Y = (y) => ty + (y - fy) * sy;
  const rect = ([x, y, w, h]) => [X(x), Y(y), w * sx, h * sy];
  const [W0, H0] = T.canvas[from], [W1, H1] = T.canvas[to];
  const fade = (sc) => (!sc?.fade_pct ? sc : { ...sc, fade_pct: sc.fade_pct * (["left", "right"].includes(sc.direction) ? sx : sy) });
  const bg = layout.background;
  return {
    ...structuredClone(layout),
    derived_from: from,
    groups: layout.groups.map((g) => ({
      ...structuredClone(g),
      region: rect(g.region),
      gap_pct: g.gap_pct * sy,
      scrim: fade(g.scrim),
      ...(g.band ? { band: { ...g.band, ...(g.band.pad_pct != null ? { pad_pct: g.band.pad_pct * sy } : {}), ...(g.band.radius_pct != null ? { radius_pct: g.band.radius_pct * sy } : {}) } } : {}),
      stack: g.stack.map((it) => (it.block !== "divider" ? { ...it } : { ...it, thickness_pct: it.thickness_pct * sy, ...(it.space_pct != null ? { space_pct: it.space_pct * sy } : {}) })),
    })),
    clear_zones: (layout.clear_zones || []).map((z) => ({ ...z, rect: rect(z.rect) })),
    ...(bg?.type === "collage" ? { background: { ...bg, rows: Math.round((bg.rows * (H1 / W1)) / (H0 / W0)) } } : {}),
    ...(bg?.type === "panels" ? { background: { ...bg, panels: bg.panels.map((pn) => ({ ...pn, cx: X(pn.cx), cy: Y(pn.cy), r: pn.r * sx })) } } : {}),
  };
}

/** The layout a treatment uses at a ratio: its own, or one derived from its 1:1 layout. */
export function layoutFor(tr, ratio, T = loadCatalogue().treatments) {
  if (tr.layouts[ratio]) return tr.layouts[ratio];
  if (tr.layouts["1x1"] && T.safe_area?.[ratio]) return deriveLayout(tr.layouts["1x1"], "1x1", ratio, T);
  return null;
}

function validFocus(focus) {
  if (focus == null) return [];
  const one = (f) => Array.isArray(f) && f.length === 2 && f.every((v) => typeof v === "number" && v >= 0 && v <= 1);
  const list = one(focus) ? [focus] : focus;
  if (!Array.isArray(list) || !list.every((f) => f == null || one(f))) throw new Error("focus must be [fx, fy] in 0–1, or one such pair (or null) per photo");
  return list;
}

function validFaces(faces) {
  if (faces == null) return [];
  const ok = Array.isArray(faces) && faces.every((perPhoto) => Array.isArray(perPhoto) && perPhoto.every((b) =>
    Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && v >= 0 && v <= 1000) && b[2] > b[0] && b[3] > b[1]));
  if (!ok) throw new Error("faces must be a list per photo of [ymin, xmin, ymax, xmax] boxes on a 0–1000 scale");
  return faces;
}

/** How many photos a layout needs: one for a single photo, more for a collage or panels. */
export function imagesNeeded(layout) {
  const bg = layout?.background;
  return !bg || bg.type === "single" ? 1 : bg.min_images;
}

/** Merge layout × style × palette into one render spec. Everything that can be rejected before
 *  opening a browser is rejected here, with a message saying what to change. `styleSpec` and
 *  `treatmentSpec` let a caller pass a style or layout object directly instead of an id (used by
 *  the UI preview and the tests). */
export function buildSpec({ image, images, faces, text, treatment = "t1-bottom-stack", treatmentSpec, palette = "cyan-pink", style = "s1-heavy-sans", styleSpec, ratio = "1x1", focus, debug = false, catalogue = loadCatalogue() }) {
  const { treatments: T, palettes: P, styles: S } = catalogue;
  const tr = treatmentSpec || T.treatments[treatment];
  if (!tr) throw new Error(`unknown treatment "${treatment}". Known: ${Object.keys(T.treatments).join(", ")}`);
  if (!T.canvas[ratio]) throw new Error(`unknown ratio "${ratio}". Known: ${Object.keys(T.canvas).join(", ")}`);
  const layout = layoutFor(tr, ratio, T);
  if (!layout) throw new Error(`treatment "${treatment}" has no ${ratio} layout yet`);
  const safe = T.safe_area?.[ratio] || [5, 5, 90, 90];
  const layoutErrors = validateLayout(layout, treatmentSpec ? "custom layout" : treatment, T.canvas[ratio], safe);
  if (layoutErrors.length) throw new Error(layoutErrors.join("; "));
  const photos = images?.length ? images : image ? [image] : [];
  const need = imagesNeeded(layout);
  if (photos.length < need) {
    const what = layout.background?.type === "collage" ? "for its photo collage" : layout.background?.type === "panels" ? "for its photo panels" : "";
    throw new Error(`${treatmentSpec ? "this layout" : `"${treatment}"`} needs ${need} photo${need > 1 ? "s" : ""} ${what}; ${photos.length} supplied`.replace(/ ;/, ";"));
  }
  const pal = P.palettes[palette];
  if (!pal) throw new Error(`unknown palette "${palette}". Known: ${Object.keys(P.palettes).join(", ")}`);
  const st = styleSpec || S.styles[style];
  if (!st) throw new Error(`unknown style "${style}". Known: ${Object.keys(S.styles).join(", ")}`);

  const used = new Map();
  const line = (g, banded) => {
    const sb = st.blocks[g.block] || {};
    const faceId = sb.face || "montserrat";
    const face = S.faces[faceId];
    if (!face) throw new Error(`style "${style}" line "${g.block}" uses unknown face "${faceId}". Known: ${Object.keys(S.faces).join(", ")}`);
    const weight = sb.weight ?? 800;
    const [w0, w1] = face.weights;
    if (weight < w0 || weight > w1) {
      throw new Error(`style "${style}" asks ${face.family} ${face.style} at weight ${weight}, but that face only has ${w0 === w1 ? w0 : `${w0}-${w1}`}. The browser would fake it, so it is refused.`);
    }
    const effect = sb.effect || "fill";
    if (!EFFECTS.includes(effect)) throw new Error(`style "${style}" line "${g.block}" has unknown effect "${effect}". Known: ${EFFECTS.join(", ")}`);
    if (face.script && !S.script_rules.blocks.includes(g.block)) {
      throw new Error(`style "${style}" puts script (${face.family}) on "${g.block}". Script is only allowed on: ${S.script_rules.blocks.join(", ")} — it stops being readable on longer lines.`);
    }
    const t = text[g.block];
    if (face.script && t && t.length > S.script_rules.max_chars) {
      throw new Error(`"${g.block}" is ${t.length} characters; the script style allows ${S.script_rules.max_chars}. Use a shorter callout or a non-script style.`);
    }
    used.set(faceId, face);
    const tracking = sb.tracking || "0";
    return {
      ...g,
      share: sb.share ?? g.share, // a style may give a line a bigger slice, e.g. taller script letters
      face: { id: faceId, family: face.family, style: face.style, weight },
      case: sb.case || "upper",
      tracking,
      tracking_em: parseFloat(tracking) || 0,
      effect,
      line_height: face.line_height,
      // A line on a band (its style's own, or the layout's) keeps its letters clear of the band's ends.
      pad_em: face.overhang + (effect === "hollow" ? HOLLOW_ALLOWANCE : STROKE_ALLOWANCE) + (effect === "band" || banded ? BAND_PAD : 0),
      layout_band: banded,
      min_px: face.script ? Math.max(g.min_px, S.script_rules.min_px) : g.min_px,
      script: !!face.script,
    };
  };
  const groups = layout.groups.map((g) => ({
    ...g,
    band: g.band || null,
    stack: g.stack.map((it) => (it.block === "divider" ? { ...it, divider: true } : line(it, !!g.band?.blocks.includes(it.block)))),
  }));
  // Every text line in order, across groups — a flat view for callers that don't care about groups.
  const stack = groups.flatMap((g) => g.stack.filter((it) => !it.divider).map((it) => ({ ...it, group: g.id })));

  return {
    treatment: treatmentSpec ? "(custom)" : treatment, palette, style: styleSpec ? "(custom)" : style, ratio,
    canvas: T.canvas[ratio],
    layout: { groups, stack, clear_zones: layout.clear_zones || [] },
    contrast: tr.contrast,
    palette_spec: pal,
    fonts: [...used.values()],
    script_min_px: S.script_rules.min_px,
    safe_area: safe,
    divider_contrast: DIVIDER_CONTRAST,
    // Faces per photo, from the visual check: [[ymin, xmin, ymax, xmax] …] on a 0–1000 scale. No letter may cover one.
    faces: validFaces(faces),
    background: layout.background || { type: "single" },
    images: photos.slice(0, layout.background?.type === "panels" ? need : undefined).map(imageDataUrl),
    // Where each photo is cropped: one [fx, fy] for a single photo, or one per photo for a collage or
    // panels ad (each photo's own crop from its visual check). Unset photos crop at the centre.
    focus: validFocus(focus)[0] || [0.5, 0.5],
    focus_images: validFocus(focus),
    text,
    debug, // review overlay only; drawn after measurement, never affects layout or checks
  };
}

function buildHtml(spec) {
  // Only the faces this style actually uses are embedded, which keeps every page light.
  const faces = spec.fonts.map((f) => {
    const path = join(REPO_ROOT, f.file);
    if (!existsSync(path)) throw new Error(`font file missing: ${f.file}`);
    const b64 = readFileSync(path).toString("base64");
    return `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weights[0]} ${f.weights[1]}; src: url(data:font/ttf;base64,${b64}) format("truetype"); font-display: block; }`;
  }).join("\n");
  const pageSpec = { ...spec, palette: spec.palette_spec };
  // Escape "<" so no string can close the <script> it is embedded in.
  const json = JSON.stringify(pageSpec).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE, "utf-8").replace("/*__FONTFACES__*/", faces).replace("/*__SPEC__*/", json);
}

// ── Chrome over the DevTools protocol ─────────────────────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = [];
    // Chrome drops the socket as it shuts down, so a call can lose its reply. Fail pending calls
    // on close instead of leaving them waiting on a connection that no longer exists.
    ws.addEventListener("close", () => {
      for (const { rej } of this.pending.values()) rej(new Error("DevTools connection closed"));
      this.pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
      } else if (msg.method) {
        this.waiters = this.waiters.filter((w) => {
          if (w.method === msg.method && w.sessionId === msg.sessionId) { w.res(msg.params); return false; }
          return true;
        });
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method, sessionId) { return new Promise((res) => this.waiters.push({ method, sessionId, res })); }
}

// The timer is cleared once the work settles. Left running, each one held the process open for
// its full duration after a render had already finished.
const withTimeout = (p, ms, what) => {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
};

export async function launchBrowser() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  const profile = mkdtempSync(join(tmpdir(), "rc-chrome-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--mute-audio", "--disable-extensions", "--disable-background-networking",
    "--force-color-profile=srgb", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await withTimeout(new Promise((res, rej) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) res(m[1]);
    });
    proc.on("exit", (c) => rej(new Error(`Chrome exited early (code ${c})`)));
  }), 20000, "Chrome startup");

  const ws = new WebSocket(wsUrl);
  await withTimeout(new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); }), 10000, "DevTools connect");
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  const work = mkdtempSync(join(tmpdir(), "rc-pages-"));

  return {
    cdp, sessionId, work,
    async close() {
      const exited = new Promise((res) => (proc.exitCode !== null ? res() : proc.once("exit", res)));
      // Safety timers are unref'd so they bound the wait without keeping the process alive.
      const grace = (ms) => new Promise((r) => setTimeout(r, ms).unref());
      await Promise.race([cdp.send("Browser.close").catch(() => {}), grace(1500)]);
      try { ws.close(); } catch {}
      proc.kill();
      await Promise.race([exited, grace(2000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      // Chrome's helper processes inherit its stdio pipes and can outlive it: let go of our ends and of the
      // child itself, or Node waits on those pipes and a finished run lingers for minutes (seen 2026-09-17).
      for (const st of [proc.stdin, proc.stdout, proc.stderr]) { try { st?.destroy(); } catch {} }
      proc.unref();
      rmSync(profile, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Render one spec to PNG. Returns { png, report } — does not verify; see verifyReport. */
export async function renderSpec(browser, spec) {
  const { cdp, sessionId, work } = browser;
  const [W, H] = spec.canvas;
  const file = join(work, `page-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, buildHtml(spec));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: pathToFileURL(file).href }, sessionId);
  await withTimeout(loaded, 30000, "page load");
  const { result, exceptionDetails } = await withTimeout(cdp.send("Runtime.evaluate", {
    expression: `new Promise((r) => { const c = () => window.__renderPromise ? window.__renderPromise.then(r) : setTimeout(c, 20); c(); })`,
    awaitPromise: true, returnByValue: true,
  }, sessionId), 30000, "render");
  if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.text}`);
  const report = result.value;
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
  }, sessionId);
  rmSync(file, { force: true });
  return { png: Buffer.from(shot.data, "base64"), report };
}

// ── Independent verification ──────────────────────────────────────────────

/** Check the page's report against what we asked for. Returns a list of failures — empty
 *  means the render is shippable. Deliberately does not trust the page's own ok flag. */
export function verifyReport(spec, report) {
  const f = [];
  if (!report || !report.ok) return [...(report?.failures || ["render reported failure"])];
  if (!report.fontsLoaded) f.push("font did not load");
  // Every face the spec asked for must have genuinely loaded — family and style (italic included).
  for (const want of spec.fonts || []) {
    const got = (report.faces || []).find((x) => x.family === want.family && x.style === want.style);
    if (got && !got.loaded) f.push(`font face did not load: ${want.family} ${want.style}`);
  }
  const [W, H] = spec.canvas;
  // The ratio's safe area: a 5% margin in 1:1; in 9:16 what Meta's Stories/Reels UI leaves uncovered.
  const [s0, s1, s2, s3] = spec.safe_area || [EDGE_MARGIN * 100, EDGE_MARGIN * 100, 100 - 200 * EDGE_MARGIN, 100 - 200 * EDGE_MARGIN];
  const SAFE = { x: (s0 / 100) * W, y: (s1 / 100) * H, w: (s2 / 100) * W, h: (s3 / 100) * H };
  const safeMsg = (what) => (s0 === 5 && s1 === 5 && s2 === 90 && s3 === 90
    ? `${what} crosses the ${EDGE_MARGIN * 100}% canvas margin`
    : `${what} leaves the ${spec.ratio} safe area (x ${s0}–${s0 + s2}%, y ${s1}–${s1 + s3}%): the app covers the rest`);
  const expected = Object.fromEntries(Object.entries(spec.text).filter(([, v]) => v != null && v !== ""));

  const rendered = new Set(report.blocks.map((b) => b.block));
  for (const k of Object.keys(expected)) if (!rendered.has(k)) f.push(`"${k}" was supplied but not rendered`);

  const inside = (k, R) => k.x >= R.x - TOL && k.y >= R.y - TOL && k.x + k.w <= R.x + R.w + TOL && k.y + k.h <= R.y + R.h + TOL;
  const meets = (a, z) => a.x < z.x + z.w - TOL && z.x < a.x + a.w - TOL && a.y < z.y + z.h - TOL && z.y < a.y + a.h - TOL;
  const zones = report.clear_zones || [];
  // Photo panels (T8) are keep-out areas too: nothing may be set over a panel.
  const panels = (report.background?.panels || []).map((p, i) => ({ name: `photo panel ${i + 1}`, x: p.cx - p.r, y: p.cy - p.r, w: 2 * p.r, h: 2 * p.r }));
  const faceZones = report.face_zones || [];
  const clear = (k, what, ink = [k]) => {
    for (const z of zones) if (meets(k, z)) f.push(`${what} enters the clear zone "${z.name}"`);
    // Faces are judged against the letters themselves (ink_lines) where the page reports them;
    // bands and dividers are solid, so their whole box counts.
    for (const z of faceZones) if (ink.some((l) => meets(l, z))) f.push(`${what} covers a face (${z.name})`);
    for (const z of panels) if (meets(k, z)) f.push(`${what} overlaps ${z.name}`);
  };
  // Which group each line belongs to, according to the layout that was asked for.
  const wantGroup = {};
  for (const g of spec.layout?.groups || []) for (const it of g.stack) if (!it.divider) wantGroup[it.block] = g.id;

  for (const b of report.blocks) {
    const tag = `"${b.block}"`;
    const R = b.region || report.region;
    if (b.text !== expected[b.block]) f.push(`${tag} text mismatch: rendered "${b.text}", expected "${expected[b.block]}"`);
    if (b.lines > b.max_lines) f.push(`${tag} wraps to ${b.lines} lines; max is ${b.max_lines}`);
    if (wantGroup[b.block] && b.group !== wantGroup[b.block]) f.push(`${tag} rendered in group "${b.group}", the layout puts it in "${wantGroup[b.block]}"`);
    const r = b.rect;
    if (!inside(r, R)) f.push(`${tag} leaves its region`);
    if (!inside(r, SAFE)) f.push(safeMsg(tag));
    clear(r, tag, b.ink_lines?.length ? b.ink_lines : [r]);
    if (b.band) {
      if (!inside(b.band, R)) f.push(`${tag} band leaves the text region`);
      if (!inside(b.band, SAFE)) f.push(safeMsg(`${tag} band`));
      clear(b.band, `${tag} band`);
    }
    if (b.script) {
      if (!["audience"].includes(b.block)) f.push(`${tag} is set in script, which is only allowed on the audience line`);
      if (spec.script_min_px && b.size < spec.script_min_px) f.push(`${tag} script is ${b.size}px, below the ${spec.script_min_px}px legibility floor`);
    }
    const C = spec.contrast;
    const ok = b.contrast.after >= C.target || (b.steps.includes("stroke") && b.contrast.after >= C.stroke_min);
    if (!ok) f.push(`${tag} contrast ${b.contrast.after}:1 is below target with no valid fallback`);
  }

  for (const g of report.groups || []) {
    for (const k of g.band?.rects || []) {
      if (!inside(k, g.region)) f.push(`group "${g.id}" band leaves its region`);
      if (!inside(k, SAFE)) f.push(safeMsg(`group "${g.id}" band`));
      clear(k, `group "${g.id}" band`);
    }
    for (const d of g.dividers || []) {
      if (!inside(d, g.region)) f.push(`group "${g.id}" divider leaves its region`);
      if (!inside(d, SAFE)) f.push(safeMsg(`group "${g.id}" divider`));
      clear(d, `group "${g.id}" divider`);
      if (!(d.contrast >= DIVIDER_CONTRAST)) f.push(`group "${g.id}" divider contrast ${d.contrast}:1 is below ${DIVIDER_CONTRAST}:1`);
    }
  }

  const size = (id) => report.blocks.find((b) => b.block === id)?.size;
  const lead = size("duration") ?? size("offer_name");
  for (const b of report.blocks) if (lead != null && b.size > lead) f.push(`hierarchy: "${b.block}" (${b.size}px) is larger than the lead line (${lead}px)`);
  if (size("audience") != null && size("location") != null && size("audience") > size("location")) f.push("hierarchy: audience is larger than location");
  return f;
}

// ── High-level: inputs → verified PNG ─────────────────────────────────────

export async function renderComposite(browser, { image, images, faces, location, audience = null, offer, free = false, treatment, treatmentSpec, palette, style, styleSpec, ratio, focus, debug = false, catalogue }) {
  const inputErrors = validateInputs({ location, audience, offer });
  if (inputErrors.length) return { ok: false, failures: inputErrors };
  const { duration, offer_name } = splitOffer(offer, free);
  const text = { location, audience, duration, offer_name };
  let spec;
  try {
    // A gym's own brand palettes ride in its catalogue (client-config catalogueFor); the default is the reference set.
    spec = buildSpec({ image, images, faces, text, treatment, treatmentSpec, palette, style, styleSpec, ratio, focus, debug, ...(catalogue ? { catalogue } : {}) });
  } catch (e) {
    return { ok: false, failures: [e.message] }; // rejected before any browser work
  }
  const { png, report } = await renderSpec(browser, spec);
  const failures = verifyReport(spec, report);
  return { ok: failures.length === 0, failures, png, report, spec: { ...spec, images: spec.images.map(() => "(data url omitted)") } };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({
    options: {
      image: { type: "string", multiple: true }, location: { type: "string" }, audience: { type: "string" },
      offer: { type: "string" }, free: { type: "boolean", default: false },
      treatment: { type: "string", default: "t1-bottom-stack" }, palette: { type: "string", default: "cyan-pink" },
      style: { type: "string", default: "s1-heavy-sans" },
      ratio: { type: "string", default: "1x1" }, out: { type: "string" }, report: { type: "string" },
      debug: { type: "boolean", default: false },
    },
  });
  if (!v.image?.length || !v.out) {
    console.error("Usage: render-composites.mjs --image <photo> [--image <photo> …] --location <text> [--audience <text>] --offer <text> [--free] --out <file.png>\n  (T7 collage needs 4+ photos, T8 panels needs 2: repeat --image)");
    process.exit(1);
  }
  const browser = await launchBrowser();
  let code = 0;
  try {
    const r = await renderComposite(browser, {
      images: v.image, location: v.location, audience: v.audience ?? null, offer: v.offer,
      free: v.free, treatment: v.treatment, palette: v.palette, style: v.style, ratio: v.ratio, debug: v.debug,
    });
    if (v.report) writeFileSync(resolve(v.report), JSON.stringify({ ok: r.ok, failures: r.failures, report: r.report }, null, 2) + "\n");
    if (!r.ok) {
      console.error(`✗ render failed — no image written:\n${r.failures.map((x) => "  - " + x).join("\n")}`);
      code = 1;
    } else {
      mkdirSync(dirname(resolve(v.out)), { recursive: true });
      writeFileSync(resolve(v.out), r.png);
      console.log(`✓ ${v.out}`);
      for (const b of r.report.blocks) {
        console.log(`  ${b.block.padEnd(10)} ${String(b.size).padStart(3)}px  ${b.lines}/${b.max_lines} line  ${b.face.padEnd(26)} ${b.effect.padEnd(12)} contrast ${b.contrast.before ?? "—"}→${b.contrast.after}  ${b.steps.join("+") || "—"}  "${b.text}"`);
      }
      if (r.report.scrim.alpha) console.log(`  scrim alpha ${r.report.scrim.alpha}`);
    }
  } finally {
    await browser.close();
  }
  process.exit(code);
}
