/**
 * assign-variants.mjs — decides which look each ad in a batch gets.
 *
 * A look is layout × style × palette (offer-treatments.json × offer-styles.json ×
 * offer-palettes.json). Given the batch's photos and how many looks each photo carries, the
 * planner assigns looks so that:
 *   1. no two ads share the same layout + style + palette;
 *   2. ads on the same photo never repeat a layout, a style or a palette (copy tests look different);
 *   3. layouts, styles and palettes are each used about equally (±1) across the batch;
 *   4. the same seed gives the same batch, a new seed a different one;
 *   5. a client's excluded layouts, styles and palettes are never used;
 *   6. only renderable picks are made: no script without a short audience line, no collage or
 *      photo panels without enough photos;
 *   7. colours suit the photo: a palette whose colours clash with the photo's colour UNDER THAT
 *      LAYOUT'S TEXT is skipped for that photo (no red text on a red wall). This changes which
 *      palettes are picked, never how one renders.
 *
 * It never writes or changes any text — it only chooses among catalogue looks.
 */

import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { loadCatalogue, imagesNeeded, imageDataUrl, renderComposite, layoutFor } from "./render-composites.mjs";

// ── colour ────────────────────────────────────────────────────────────────

/** Hue in degrees, and HSV saturation and value, of a #RRGGBB colour. */
export function hsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** A palette's strongly coloured text colours — the ones that can vanish into a photo of the same
 *  hue. White, black and greys carry no hue. Pale tints (cyan-pink's light pink, saturation 0.35)
 *  still read against a deep wall of a similar hue — Step 1's approved renders put exactly that on
 *  the red Sin Ming walls — so only saturation 0.5 and up counts. */
export function paletteAccents(palette) {
  const fills = [...new Set(Object.values(palette.blocks).map((b) => b.fill.toUpperCase()))];
  return fills.map((hex) => ({ hex, ...hsv(hex) })).filter((c) => c.s >= 0.5 && c.v >= 0.35);
}

// A photo patch counts as coloured when its hue-weighted colourfulness passes this; below it the
// patch is near-neutral and any palette suits it. Measured under the layouts' text on the Sin Ming
// photos: red-walled rooms 0.25-0.48, the mostly grey/white room (facility-02) 0.03-0.21; a plain
// cream background 0.08, a dark one 0.
export const COLOURED = 0.15;
// Hue gap (degrees) under which a text colour reads as the same colour as the photo behind it.
export const CLASH_DEGREES = 40;
// Share of the text area that may sit on a same-hue colour before the palette is skipped. The text
// area is measured as a grid of patches, not averaged: a red wall behind one line of text is a
// clash even when the floor under the other lines dilutes the average (Sheet D, first draft).
export const CLASH_SHARE = 0.2;

/** Score every palette against the photo under the text: 1 = no clash; lower = more of the text
 *  area is close in hue to the palette's colours. `clash` marks palettes to skip on that photo.
 *  `stat` is { hue, strength, cells? } — with cells (from measurePhotos) each patch is judged. */
export function rankPalettes(stat, palettes) {
  const cells = stat.cells?.length ? stat.cells : [stat];
  const coloured = cells.filter((c) => c.strength >= COLOURED);
  return Object.entries(palettes).map(([id, p]) => {
    const acc = paletteAccents(p);
    if (!acc.length || !coloured.length) return { id, score: 1, gap: 180, share: 0, clash: false };
    const per = acc.map((a) => ({
      share: coloured.filter((c) => hueGap(a.h, c.hue) < CLASH_DEGREES).length / cells.length,
      penalty: coloured.reduce((n, c) => n + Math.max(0, 1 - hueGap(a.h, c.hue) / 90), 0) / cells.length,
      gap: Math.min(...coloured.map((c) => hueGap(a.h, c.hue))),
    }));
    const share = Math.max(...per.map((x) => x.share));
    return { id, score: +(1 - Math.max(...per.map((x) => x.penalty))).toFixed(3), gap: Math.round(Math.min(...per.map((x) => x.gap))), share: +share.toFixed(2), clash: share >= CLASH_SHARE };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Measure each photo's colour under every single-photo layout's text regions, plus overall.
 *  Uses the same Chrome as the renderer, and the same cover-fit, so it sees what the text sees.
 *  Returns [{ overall: {hue, strength}, layouts: { id: {hue, strength} } }] per photo. */
export async function measurePhotos(browser, images, { ratio = "1x1" } = {}) {
  const { treatments: T } = loadCatalogue();
  const [W, H] = T.canvas[ratio];
  const areas = Object.fromEntries(Object.entries(T.treatments)
    .filter(([, t]) => imagesNeeded(layoutFor(t, ratio, T)) === 1)
    .map(([id, t]) => [id, layoutFor(t, ratio, T).groups.map((g) => g.region)]));
  const out = [];
  for (const image of images) {
    const page = join(browser.work, `measure-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    writeFileSync(page, `<!doctype html><canvas id="c" width="${W}" height="${H}"></canvas><script>
window.__stats = (async () => {
  const im = new Image(); im.src = ${JSON.stringify(imageDataUrl(image))}; await im.decode();
  const c = document.getElementById("c").getContext("2d", { willReadFrequently: true });
  const sc = Math.max(${W} / im.naturalWidth, ${H} / im.naturalHeight), dw = im.naturalWidth * sc, dh = im.naturalHeight * sc;
  c.drawImage(im, (${W} - dw) / 2, (${H} - dh) / 2, dw, dh);
  const px = c.getImageData(0, 0, ${W}, ${H}).data;
  // Colourfulness (saturation x value) weighted circular mean of hue, times how consistent it is.
  const stat = (rects) => {
    let sx = 0, sy = 0, sw = 0, n = 0;
    for (const [x, y, w, h] of rects) {
      const x0 = Math.floor(x / 100 * ${W}), x1 = Math.ceil((x + w) / 100 * ${W}), y0 = Math.floor(y / 100 * ${H}), y1 = Math.ceil((y + h) / 100 * ${H});
      for (let yy = y0; yy < y1; yy += 3) for (let xx = x0; xx < x1; xx += 3) {
        const i = (yy * ${W} + xx) * 4, r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let hh = 0;
        if (d) hh = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
        const wgt = (mx ? d / mx : 0) * mx, a = (hh * Math.PI) / 180;
        sx += wgt * Math.cos(a); sy += wgt * Math.sin(a); sw += wgt; n++;
      }
    }
    const R = sw ? Math.hypot(sx, sy) / sw : 0;
    return { hue: +(((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360).toFixed(1), strength: +((sw / n) * R).toFixed(3) };
  };
  const areas = ${JSON.stringify(areas)};
  // Each text region is also judged as a 4 x 4 grid of patches, so colour behind part of the text counts.
  const cells = (rs) => rs.flatMap(([x, y, w, h]) => Array.from({ length: 16 }, (_, k) => stat([[x + (k % 4) * w / 4, y + Math.floor(k / 4) * h / 4, w / 4, h / 4]])));
  return { overall: stat([[0, 0, 100, 100]]), layouts: Object.fromEntries(Object.entries(areas).map(([id, rs]) => [id, { ...stat(rs), cells: cells(rs) }])) };
})();
</script>`);
    const loaded = browser.cdp.once("Page.loadEventFired", browser.sessionId);
    await browser.cdp.send("Page.navigate", { url: pathToFileURL(page).href }, browser.sessionId);
    await loaded;
    const { result, exceptionDetails } = await browser.cdp.send("Runtime.evaluate", { expression: "window.__stats", awaitPromise: true, returnByValue: true }, browser.sessionId);
    rmSync(page, { force: true });
    if (exceptionDetails) throw new Error(`measuring ${image}: ${exceptionDetails.text}`);
    out.push(result.value);
  }
  return out;
}

/** A client's switched-off looks, from gym-profile.json → creative (validated by client-config.mjs). */
export function excludeFromProfile(creative = {}) {
  return { layouts: creative.exclude_layouts || [], styles: creative.exclude_styles || [], palettes: creative.exclude_palettes || [] };
}

// ── seeded randomness ─────────────────────────────────────────────────────

function rngFrom(seed) {
  let h = 2166136261; // FNV-1a over the seed's text, then mulberry32
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── the planner ───────────────────────────────────────────────────────────

/**
 * visuals:    [{ id }]  (the batch's photos, in order)
 * perVisual:  looks per photo
 * text:       { location, audience } — only used to decide whether script can be picked
 * seed:       any string or number
 * exclude:    { layouts, styles, palettes } — a client's switched-off looks
 * photoStats: optional, from measurePhotos, one per visual; without it colour is not considered
 *
 * Returns { candidates: [{ id, visual, images, treatment, style, palette, palette_fit }], pools, notes }.
 */
export function assignVariants({ visuals, perVisual, text = {}, seed = "batch", exclude = {}, photoStats = null, catalogue = loadCatalogue(), ratio = "1x1" }) {
  const { treatments: T, styles: S, palettes: P } = catalogue;
  const notes = [];
  if (!visuals?.length) throw new Error("the batch has no photos");
  if (!(perVisual >= 1)) throw new Error("looks per photo must be at least 1");
  for (const [kind, ids, known] of [["layouts", exclude.layouts, T.treatments], ["styles", exclude.styles, S.styles], ["palettes", exclude.palettes, P.palettes]]) {
    for (const id of ids || []) if (!known[id]) throw new Error(`exclude.${kind} names "${id}", which is not in the catalogue`);
  }

  // Pools: what this batch may use at all.
  const layouts = Object.keys(T.treatments).filter((id) => {
    if ((exclude.layouts || []).includes(id)) return false;
    const need = imagesNeeded(layoutFor(T.treatments[id], ratio, T));
    if (need > visuals.length) { notes.push(`${id} left out: it needs ${need} photos and the batch has ${visuals.length}`); return false; }
    return true;
  });
  const usesScript = (st) => Object.values(st.blocks).some((b) => S.faces[b.face || "montserrat"]?.script);
  const audience = text.audience || "";
  const styles = Object.keys(S.styles).filter((id) => {
    if ((exclude.styles || []).includes(id)) return false;
    if (usesScript(S.styles[id])) {
      if (!audience) { notes.push(`${id} left out: its script line is the audience callout, and there is none`); return false; }
      if (audience.length > S.script_rules.max_chars) { notes.push(`${id} left out: the audience callout is over ${S.script_rules.max_chars} characters, too long for script`); return false; }
    }
    return true;
  });
  const palettes = Object.keys(P.palettes).filter((id) => !(exclude.palettes || []).includes(id));
  for (const [kind, pool] of [["layouts", layouts], ["styles", styles], ["palettes", palettes]]) {
    if (pool.length < perVisual) throw new Error(`${perVisual} looks per photo need ${perVisual} different ${kind}, but only ${pool.length} are available after exclusions`);
  }

  const rand = rngFrom(seed);
  const shuffled = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const count = { L: Object.fromEntries(layouts.map((k) => [k, 0])), S: Object.fromEntries(styles.map((k) => [k, 0])), P: Object.fromEntries(palettes.map((k) => [k, 0])) };
  // Least-used first; ties in seeded random order. Stable sort keeps the shuffle within a tie.
  const byUse = (pool, c, avoid) => shuffled(pool.filter((k) => !avoid.has(k))).sort((a, b) => c[a] - c[b]);

  // The colour of the photo under a layout's text. Photo panels sit on a plain backdrop, so no
  // photo is under the text — unless the backdrop is a dimmed photo (T8 in 9:16), whose colour is
  // that photo's, weakened by the dimming. A collage is judged on all its tiles' photos together: their colour
  // vectors are averaged, so four red rooms read as red and a mix of hues reads as weak.
  const statFor = (vi, layout) => {
    if (!photoStats?.[vi]) return null;
    const L = layoutFor(T.treatments[layout], ratio, T);
    if (L.background?.type === "panels") {
      const bp = L.background.backdrop_photo;
      if (!bp) return null;
      const st = photoStats[(vi + bp.image) % visuals.length].overall;
      return { hue: st.hue, strength: st.strength * (1 - bp.darken) };
    }
    if (L.background?.type === "collage") {
      const need = imagesNeeded(L);
      const st = Array.from({ length: need }, (_, k) => photoStats[(vi + k) % visuals.length].overall);
      const x = st.reduce((a, s) => a + s.strength * Math.cos((s.hue * Math.PI) / 180), 0) / need;
      const y = st.reduce((a, s) => a + s.strength * Math.sin((s.hue * Math.PI) / 180), 0) / need;
      return { hue: (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360, strength: Math.hypot(x, y) };
    }
    return photoStats[vi].layouts?.[layout] || photoStats[vi].overall;
  };

  // Photos with the strongest colour choose first, while every palette is still unused, so they
  // are the likeliest to get colours that suit them. The output keeps the batch's order.
  const order = visuals.map((v, i) => i).sort((a, b) => (photoStats?.[b]?.overall.strength || 0) - (photoStats?.[a]?.overall.strength || 0) || a - b);
  const used = new Set();
  const slots = [];
  for (const vi of order) {
    const on = { L: new Set(), S: new Set(), P: new Set() };
    for (let j = 0; j < perVisual; j++) {
      let pick = null;
      for (const layout of byUse(layouts, count.L, on.L)) {
        const stat = statFor(vi, layout);
        const fit = stat ? Object.fromEntries(rankPalettes(stat, Object.fromEntries(palettes.map((k) => [k, P.palettes[k]]))).map((r) => [r.id, r])) : null;
        for (const style of byUse(styles, count.S, on.S)) {
          // Least-used palettes first; within the same use, ones that suit the photo best.
          const suits = byUse(palettes, count.P, on.P).sort((a, b) => count.P[a] - count.P[b] || (fit ? fit[b].score - fit[a].score : 0));
          const clean = suits.filter((p) => !fit?.[p].clash);
          // Skip clashing palettes for this photo; only if every remaining one clashes, take the best.
          for (const palette of clean.length ? clean : suits) {
            if (used.has(`${layout}|${style}|${palette}`)) continue;
            pick = { layout, style, palette, fit: fit?.[palette] || null };
            break;
          }
          if (pick) break;
        }
        if (pick) break;
      }
      if (!pick) throw new Error(`could not find an unused look for photo ${visuals[vi].id}`);
      used.add(`${pick.layout}|${pick.style}|${pick.palette}`);
      on.L.add(pick.layout); on.S.add(pick.style); on.P.add(pick.palette);
      count.L[pick.layout]++; count.S[pick.style]++; count.P[pick.palette]++;
      slots.push({ vi, j, ...pick });
    }
  }

  slots.sort((a, b) => a.vi - b.vi || a.j - b.j);
  const candidates = slots.map((s, i) => {
    const need = imagesNeeded(layoutFor(T.treatments[s.layout], ratio, T));
    // Extra photos for a collage or panels: the next photos in the batch, in order.
    const images = Array.from({ length: need }, (_, k) => visuals[(s.vi + k) % visuals.length].id);
    return {
      id: `c${String(i + 1).padStart(2, "0")}`, visual: visuals[s.vi].id, images,
      treatment: s.layout, style: s.style, palette: s.palette,
      palette_fit: s.fit ? { score: s.fit.score, hue_gap: s.fit.gap, share: s.fit.share, clash: s.fit.clash } : null,
    };
  });
  // Colour fit outranks even spread: a palette that clashes with most photos is used less, and says so.
  const even = Math.floor(slots.length / palettes.length);
  const unusedPalettes = palettes.filter((p) => count.P[p] === 0);
  const underused = palettes.filter((p) => count.P[p] > 0 && count.P[p] < even);
  if (photoStats && unusedPalettes.length) notes.push(`not used, because their colours clash with the photos under the text: ${unusedPalettes.join(", ")}`);
  if (photoStats && underused.length) notes.push(`used less than an even share (${even}), because their colours clash with most photos under the text: ${underused.map((p) => `${p} ×${count.P[p]}`).join(", ")}`);
  return { candidates, ratio, pools: { layouts, styles, palettes }, counts: count, notes };
}

/**
 * Render every planned candidate. The planner's picks are static; a few combinations can only be
 * proven by rendering (e.g. a long location in a narrow column pulls a script audience under its
 * size floor, or its letters would cover a face found in the photo). A candidate that fails is replaced by the next look that is unused in the batch
 * and new to its photo — keeping its layout, then its palette, where possible — and the
 * replacement is recorded. Nothing is ever shipped unverified.
 */
export async function renderPlan(browser, plan, { text, imageFor, facesFor = () => [], catalogue = loadCatalogue() }) {
  const { treatments: T } = catalogue;
  const need = (la) => imagesNeeded(layoutFor(T.treatments[la], plan.ratio || "1x1", T));
  const results = [];
  const taken = new Set(plan.candidates.map((c) => `${c.treatment}|${c.style}|${c.palette}`));
  for (const c of plan.candidates) {
    const onPhoto = plan.candidates.filter((o) => o.visual === c.visual && o !== c);
    const tries = [[c.treatment, c.style, c.palette]];
    for (const st of plan.pools.styles) for (const pa of [c.palette, ...plan.pools.palettes]) for (const la of [c.treatment, ...plan.pools.layouts]) {
      if (onPhoto.some((o) => o.treatment === la || o.style === st || o.palette === pa)) continue;
      if (need(la) > c.images.length) continue; // a replacement may not need more photos than the ad has
      if (!taken.has(`${la}|${st}|${pa}`)) tries.push([la, st, pa]);
    }
    let done = null;
    const failures = [];
    for (const [treatment, style, palette] of tries.slice(0, 12)) {
      const ims = c.images.slice(0, need(treatment));
      // Faces from each photo's visual check are keep-out areas: a look whose letters would cover one fails and is swapped.
      const r = await renderComposite(browser, { images: ims.map(imageFor), faces: ims.map(facesFor), ...text, treatment, style, palette, ratio: plan.ratio || "1x1" });
      if (r.ok) {
        done = { ...c, treatment, style, palette, images: c.images.slice(0, need(treatment)), r };
        if (treatment !== c.treatment || style !== c.style || palette !== c.palette) {
          taken.add(`${treatment}|${style}|${palette}`);
          done.replaced = { from: { treatment: c.treatment, style: c.style, palette: c.palette }, reason: failures[0] };
        }
        break;
      }
      failures.push(r.failures.join("; "));
    }
    results.push(done || { ...c, failed: failures });
  }
  return results;
}

