#!/usr/bin/env node
/**
 * generate-visuals.mjs — Layer 1 of the offer-first creative: make the pictures, check them.
 *
 * For each planned visual: build a pictures-only prompt (visual-prompts.mjs) composed around its
 * layout, generate it with Gemini (one call), then check it in two halves:
 *   1. the picture (check-visual.mjs): no stray text anywhere; the subject placed as the layout
 *      needs it; then (check-quality.mjs) it looks real — the scene's exercise with its equipment,
 *      nothing physically impossible, and groups candid rather than posed;
 *   2. the finished ad: the brief's words set on it (render-composites.mjs) with every face the
 *      check found as a keep-out area — it must verify, so no letter covers a face.
 * A visual that fails either half is kept and flagged, never silently used. With --attempts N a
 * flagged visual is generated again, up to N tries in all; every attempt is kept on disk and every
 * paid call counts against --max-calls, which is never exceeded.
 *
 * Usage:
 *   node skills/references/generate-visuals.mjs --brand-dir brands/sculpt-society \
 *     --plan visuals.json --out brands/sculpt-society/outputs/step4-visuals \
 *     [--ratio 1x1] [--ref brand-assets/facility/facility-04.png] [--max-calls 3] [--attempts 1]
 *
 *   visuals.json: { "text": { "location": "…", "audience": "…", "offer": "…" },
 *                   "visuals": [ { "id": "v01", "treatment": "t1-bottom-stack", "scene": "…", "pose": "compact", "people": 1,
 *                                  "look": { "style": "s1-heavy-sans", "palette": "white-on-dark" } } ] }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve, extname, basename } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { buildVisualPrompt, poseProblem } from "./visual-prompts.mjs";
import { checkVisual, checkTiled } from "./check-visual.mjs";
import { checkQuality } from "./check-quality.mjs";
import { makePixelTools } from "./clean-photo.mjs";
import { generateImage, GEMINI_MODEL } from "./generate_ads_gemini.mjs";
import { launchBrowser, renderComposite, layoutFor, loadCatalogue } from "./render-composites.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const inline = (p) => ({ inline_data: { mime_type: MIME[extname(p).toLowerCase()] || "image/png", data: readFileSync(p).toString("base64") } });

/** Set the brief's words on a visual, with its faces as keep-out areas. Single-photo layouts only:
 *  a collage or panels needs the batch's other photos, so those are composed in the batch step. */
export function makeCompositor(catalogue = loadCatalogue()) {
  let browser = null;
  const T = catalogue.treatments;
  return {
    async compose(file, faces, v, text, ratio, out, focus) {
      const bg = layoutFor(T.treatments[v.treatment], ratio, T).background?.type || "single";
      if (bg !== "single") return { ok: true, skipped: "needs the batch's other photos" };
      browser ||= await launchBrowser();
      const r = await renderComposite(browser, { image: file, faces: [faces || []], focus, ...text, treatment: v.treatment, style: v.look?.style, palette: v.look?.palette, ratio, catalogue });
      if (r.png) writeFileSync(out, r.png);
      return { ok: r.ok, failures: r.failures, ad: r.png ? out : null, face_zones: r.report?.face_zones?.length ?? 0 };
    },
    async close() { if (browser) await browser.close(); },
  };
}

/**
 * The picture check: text, placement and head count (check-visual), then — only if those pass, so
 * nothing is spent judging a photo already refused — whether it looks real (check-quality). The
 * quality verdict rides along as `quality`. `base` and `quality` are injectable for tests.
 */
export async function checkPicture(file, opts, { base = checkVisual, quality = checkQuality } = {}) {
  const pic = await base(file, opts);
  // A photo that fails only its own layout's placement is still judged for realism: the batch may keep
  // it for the layouts it fits, and that must never skip the quality check.
  const onlyPlacement = !pic.ok && (pic.failures || []).length > 0 && (pic.failures || []).every((f) => (pic.placement_failures || []).includes(f));
  if (!pic.ok && !onlyPlacement) return pic;
  // A photo the owner has looked at and passed (plan-offer-batch → withRulings) is not judged again.
  if (opts.skipQuality) return { ...pic, notes: pic.notes || [], quality: { ok: true, failures: [], minor: [], dismissed: [], ruling: "passed by the owner" } };
  let q;
  try { q = await quality(file, { scene: opts.scene, people: opts.maxPeople, setting: opts.setting }); } catch (e) { q = { ok: false, failures: [`quality check could not run: ${e.message}`], minor: [], dismissed: [] }; }
  // Notes never fail a photo; they ride with it to the gallery, so selection is informed.
  return { ...pic, ok: pic.ok && q.ok, failures: [...(pic.failures || []), ...q.failures], notes: [...(pic.notes || []), ...(q.minor || [])], quality: q };
}

/** Both halves of the check for a visual on disk. */
async function assess(file, v, { ratio, text, check, compositor, outDir, never = [] }) {
  let pic;
  try { pic = await check(file, { treatment: v.treatment, ratio, expectPeople: v.people !== false, maxPeople: typeof v.people === "number" ? v.people : null, never, scene: v.scene, setting: v.tags?.setting ?? v.setting ?? null, anchor: v.anchor ?? null }); } catch (e) { pic = { ok: false, failures: [`check could not run: ${e.message}`] }; }
  let ad = null;
  if (pic.ok && text && compositor) {
    try { ad = await compositor.compose(file, pic.faces, v, text, ratio, join(outDir, `${v.id}-ad.png`), pic.focus); } catch (e) { ad = { ok: false, failures: [`ad could not render: ${e.message}`] }; }
  }
  const failures = [...(pic.failures || []), ...(ad && !ad.ok ? ad.failures.map((f) => `finished ad: ${f}`) : [])];
  // Faces and the judged crop are kept: the batch planner renders every look with them.
  // picture_ok: text, never-list, people and realism all fine — only its own layout's placement or ad failed, if anything.
  const onlyPlacement = (pic.failures || []).length > 0 && (pic.failures || []).every((f) => (pic.placement_failures || []).includes(f));
  return { ok: failures.length === 0, picture_ok: !!pic.ok || onlyPlacement, failures, stray_text: pic.stray_text, excluded: pic.excluded || [], dismissed: pic.dismissed || [], placement: pic.placement, faces: pic.faces || [], focus: pic.focus || [0.5, 0.5], notes: pic.notes || [], quality: pic.quality || null, ad };
}

/** A reference photo's lettering and never-list items, looked for in full-resolution tiles as well as
 *  whole (Step 5: the whole-image look missed thumb-sized marks). Returns what it found (empty = clean). */
export async function checkRefTiled(path, { never = [] } = {}) {
  const px = makePixelTools();
  try {
    const c = await checkTiled(path, { never, crop: px.crop });
    return [...c.text, ...c.never.map((n) => ({ ...n, kind: "never-list item" }))];
  } finally { await px.close(); }
}

/** `generate`, `check` and `compositor` are injectable, so the flow and the call budget can be tested offline.
 *  `onProgress(event)` hears each photo as it goes — { id, event: "generating" | "checking" | "tried" | "done",
 *  attempt, file, status, failures, notes, calls } — for the panel's Generating screen; it can never stop a run. */
export async function generateVisuals({ visuals, text = null, photography = {}, brandNames = [], outDir, ratio = "1x1", refs = [], anchorFor = null, maxCalls = visuals.length, attempts = 1, generate = generateImage, check = checkPicture, checkRef = (p) => checkRefTiled(p, { never: photography.never || [] }), compositor = text ? makeCompositor() : null, log = console.log, onProgress = null }) {
  const tell = (e) => { try { onProgress?.(e); } catch {} };
  mkdirSync(outDir, { recursive: true });
  // A reference photo carrying lettering gets it copied into every visual, so it is refused first.
  for (const r of refs) {
    const found = await checkRef(r);
    if (found.length) throw new Error(`reference photo ${r} contains text the model would copy: ${found.map((t) => `${t.kind} "${t.what}"`).join("; ")}. Crop it out or clean the photo (Step 5) first.`);
  }
  // A scene whose pose its layout cannot hold is refused before a single call is spent.
  const misfits = visuals.map((v) => [v.id, poseProblem(v.treatment, v.pose)]).filter(([, e]) => e);
  if (misfits.length) throw new Error(misfits.map(([id, e]) => `${id}: ${e}`).join("\n"));
  const refParts = refs.map(inline);
  let calls = 0;
  const results = [];
  for (const v of visuals) {
    // A sibling of a chosen photo (Step 8, 9:16): that photo goes first, as the scene itself.
    const anchor = anchorFor ? anchorFor(v) : null;
    const parts = anchor ? [inline(anchor), ...refParts] : refParts;
    const { prompt, aspect } = buildVisualPrompt({ treatment: v.treatment, scene: v.scene, ratio, photography, brandNames, hasReference: refParts.length > 0, anchor: !!anchor, people: typeof v.people === "number" ? v.people : null, setting: v.tags?.setting ?? v.setting ?? null });
    writeFileSync(join(outDir, `${v.id}.prompt.txt`), prompt + "\n");
    const tries = [];
    let final = null;
    for (let attempt = 1; attempt <= attempts && !(final && final.status === "passed"); attempt++) {
      if (calls >= maxCalls) {
        if (!tries.length) log(`- ${v.id}: skipped (budget of ${maxCalls} calls reached)`);
        final ||= { ...v, status: "skipped", reason: `call budget of ${maxCalls} reached` };
        break;
      }
      calls++;
      tell({ id: v.id, event: "generating", attempt, calls });
      let img;
      try {
        img = await generate(prompt, parts, { aspectRatio: aspect });
      } catch (e) {
        final = { ...v, status: "error", reason: e.message };
        tries.push({ attempt, status: "error", reason: e.message });
        log(`✗ ${v.id}: generation failed: ${e.message.slice(0, 200)}`);
        tell({ id: v.id, event: "tried", attempt, status: "error", failures: [e.message], calls });
        continue;
      }
      // Never overwrite an earlier photo (a re-run of a batch once replaced the first run's rejected
      // attempts): the next free name in the folder, whatever run made the others.
      let n = attempt, file;
      do { file = join(outDir, `${v.id}${n > 1 ? `-a${n}` : ""}.${img.ext || "png"}`); n++; } while (existsSync(file));
      writeFileSync(file, img.buffer);
      tell({ id: v.id, event: "checking", attempt, file, calls });
      const verdict = await assess(file, { ...v, id: basename(file, extname(file)) }, { ratio, text, check, compositor, outDir, never: photography.never || [] });
      final = { ...v, status: verdict.ok ? "passed" : "flagged", file, attempt, check: verdict };
      tries.push({ attempt, file, status: final.status, failures: verdict.failures, picture_ok: verdict.picture_ok, check: verdict });
      log(`${verdict.ok ? "✓" : "⚑"} ${v.id}${attempt > 1 ? ` (attempt ${attempt})` : ""} ${v.treatment}: ${verdict.ok ? "no stray marks; subject placed; looks real; the finished ad verifies with no letter on a face" : verdict.failures.join(" | ")}`);
      tell({ id: v.id, event: "tried", attempt, file, status: final.status, failures: verdict.failures, notes: verdict.notes, calls });
    }
    // A photo that passes every picture check but not its own layout — its placement rule, or a face
    // where that layout's words land — is still a good photo: kept, with no primary layout, for the
    // layouts the batch's fit stage finds it can carry (2026-09-12: two good women's scenes were dropped).
    if (final?.status === "flagged") {
      const good = [...tries].reverse().find((t) => t.picture_ok);
      if (good) {
        final = { ...v, status: "passed", file: good.file, attempt: good.attempt, check: good.check, own_layout_failed: good.failures };
        log(`✓ ${v.id}: ${basename(good.file)} passes the picture checks; its own layout did not work out (${good.failures.join("; ")}) — kept for the layouts it fits`);
      }
    }
    tell({ id: v.id, event: "done", status: final?.status || "skipped", attempt: final?.attempt || tries.length, file: final?.file || null, own_layout_failed: final?.own_layout_failed || null, failures: final?.check?.failures || (final?.reason ? [final.reason] : []), notes: final?.check?.notes || [], calls });
    results.push({ ...final, attempts: tries.map(({ check, ...t }) => t) });
  }
  await compositor?.close();
  const report = { model: GEMINI_MODEL, ratio, image_calls: calls, max_calls: maxCalls, refs, results };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export { assess };

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, plan: { type: "string" }, out: { type: "string" },
    ratio: { type: "string", default: "1x1" }, ref: { type: "string", multiple: true }, "max-calls": { type: "string" }, attempts: { type: "string", default: "1" },
    "check-only": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"] || !v.plan || !v.out) {
    console.error("Usage: generate-visuals.mjs --brand-dir <brands/x> --plan <visuals.json> --out <dir> [--ratio 1x1] [--ref <photo>] [--max-calls N] [--attempts N]");
    process.exit(1);
  }
  const brandDir = resolve(v["brand-dir"]);
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const { visuals, text = null } = JSON.parse(readFileSync(resolve(v.plan), "utf-8"));
  const refs = (v.ref || []).map((r) => (existsSync(resolve(r)) ? resolve(r) : join(brandDir, r)));
  for (const r of refs) if (!existsSync(r)) { console.error(`reference photo not found: ${r}`); process.exit(1); }
  if (v["check-only"]) {
    // Re-check visuals already on disk. No image is generated, so nothing is spent on images.
    const out = resolve(v.out), prior = existsSync(join(out, "report.json")) ? JSON.parse(readFileSync(join(out, "report.json"), "utf-8")) : {};
    const results = [], compositor = text ? makeCompositor() : null;
    for (const vis of visuals) {
      const file = ["png", "jpg", "jpeg", "webp"].map((e) => join(out, `${vis.id}.${e}`)).find(existsSync);
      if (!file) { results.push({ ...vis, status: "missing" }); console.log(`- ${vis.id}: no image on disk`); continue; }
      const c = await assess(file, vis, { ratio: v.ratio, text, check: checkPicture, compositor, outDir: out, never: profile.brand_lock?.photography?.never || [] });
      results.push({ ...vis, status: c.ok ? "passed" : "flagged", file, check: c });
      console.log(`${c.ok ? "✓" : "⚑"} ${vis.id} ${vis.treatment}: ${c.ok ? "no stray marks; subject placed; looks real; the finished ad verifies with no letter on a face" : c.failures.join(" | ")}`);
    }
    await compositor?.close();
    writeFileSync(join(out, "report.json"), JSON.stringify({ ...prior, checked_with: (await import("./check-visual.mjs")).CHECK_MODEL, results }, null, 2) + "\n");
    process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
  }
  const maxCalls = v["max-calls"] ? parseInt(v["max-calls"], 10) : visuals.length;
  console.log(`Generating ${visuals.length} visual(s) with ${GEMINI_MODEL}, at most ${maxCalls} image call(s)…`);
  const report = await generateVisuals({ visuals, text, photography: profile.brand_lock?.photography || {}, brandNames: [profile.display_name], outDir: resolve(v.out), ratio: v.ratio, refs, maxCalls, attempts: parseInt(v.attempts, 10) });
  const flagged = report.results.filter((r) => r.status !== "passed").length;
  console.log(`${report.image_calls} image call(s) made · ${report.results.length - flagged} passed · ${flagged} flagged/failed · report: ${join(v.out, "report.json")}`);
  process.exit(flagged ? 1 : 0);
}
