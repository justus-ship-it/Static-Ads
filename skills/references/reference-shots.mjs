/**
 * reference-shots.mjs — what the high-performing reference ads' PHOTOS have in common, in words, for every gym.
 *
 * The reference ads (Reference-Sep-10/, other operators' finished ads) are analysis material only: the
 * owner's rule (2026-09-10, reaffirmed 2026-09-27) is that they are never attached to an image-generation
 * call and never republished. This module reads each one ONCE with the vision model into a structured
 * description of the photograph beneath the words — camera distance and height, how much of the frame the
 * person fills, the moment of the movement, expression, light, colour, background, blur, where the ad's words
 * sit against the person — and turns those readings into a shared SHOT GUIDE: rules a photographer could
 * follow, each backed by a count in code ("14 of 19 …"), and a few shot recipes. Every word seen on an ad is
 * listed apart and kept out of the guide (a leaking line is dropped with the reason).
 *
 *   library/reference-shots.json   { schema: 1, model, readings: { [sha16]: { file, reading, read_at } } }
 *   library/shot-guide.json        { schema: 1, model, made, refs, counts, rules, recipes, avoid, dropped }
 *   library/shot-guide.md          the same, for the owner to read
 *
 * CLI: --read (reads what is not cached) · --guide (writes the guide from the readings) · --show
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "fs";
import { join, resolve, extname, basename } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";
import { callVision } from "./check-visual.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const REFERENCE_ADS_DIR = resolve(process.env.REFERENCE_ADS_DIR || join(REPO_ROOT, "Reference-Sep-10"));
export const LIBRARY_DIR = resolve(process.env.COPY_LIBRARY_DIR || join(REPO_ROOT, "library"));
/** The strongest text/vision model the key has: the reading is done once, so clarity beats speed. */
export const SHOT_MODEL = process.env.SHOT_MODEL || "gemini-3.1-pro-preview";
const IMAGE = /\.(jpe?g|png|webp)$/i;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const clean = (v, max = 400) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// ── the reading ──────────────────────────────────────────────────────────────
export const ENUMS = Object.freeze({
  audience: ["women", "men", "mixed", "none"],
  ages: ["20s", "30s", "40s", "50s", "60s+"],
  moment: ["peak-effort", "lockout-or-hold", "mid-rep", "rest-or-recovery", "celebration", "coaching-cue", "posed-portrait", "other"],
  expression: ["strain-grimace", "determined-focus", "smile-laugh", "shout-roar", "calm", "not-visible"],
  gaze: ["into-lens", "at-the-work", "at-partner-or-coach", "away", "not-visible"],
  camera_distance: ["extreme-close-up", "close-up", "medium-close", "medium", "full-body", "wide"],
  camera_height: ["low", "eye-level", "high", "overhead"],
  camera_angle: ["front", "three-quarter", "side", "behind"],
  subject_position: ["left", "centre", "right"],
  lens_feel: ["wide-angle-close", "normal", "telephoto-compressed"],
  depth_of_field: ["shallow", "moderate", "deep"],
  motion: ["motion-blur", "sweat", "chalk", "flying-hair", "none"],
  light_direction: ["window-side", "overhead", "front-flash", "backlit-rim", "mixed"],
  light_quality: ["hard-contrast", "soft", "flat"],
  colour_temperature: ["warm", "neutral", "cool", "mixed"],
  saturation: ["vivid", "natural", "muted"],
  clutter: ["clean", "some", "busy"],
  photo_feel: ["phone-snapshot", "prosumer", "professional-editorial", "broadcast-sports"],
  words_over: ["background", "body-not-face", "face", "beside-subject", "none"],
});
const E = (k) => ({ type: "STRING", enum: ENUMS[k] });
const EA = (k) => ({ type: "ARRAY", items: { type: "STRING", enum: ENUMS[k] } });
export const READING_SCHEMA = { type: "OBJECT", properties: {
  people: { type: "INTEGER" }, audience: E("audience"), apparent_ages: EA("ages"),
  activity: { type: "STRING" }, moment: E("moment"), expression: E("expression"), gaze: E("gaze"),
  camera_distance: E("camera_distance"), camera_height: E("camera_height"), camera_angle: E("camera_angle"),
  subject_fill_pct: { type: "INTEGER" }, subject_position: E("subject_position"), crop: { type: "STRING" },
  lens_feel: E("lens_feel"), depth_of_field: E("depth_of_field"), motion: EA("motion"),
  light_direction: E("light_direction"), light_quality: E("light_quality"), colour_temperature: E("colour_temperature"),
  dominant_colours: { type: "ARRAY", items: { type: "STRING" } }, saturation: E("saturation"),
  background: { type: "STRING" }, clutter: E("clutter"), photo_feel: E("photo_feel"), words_over: E("words_over"),
  scroll_stopper: { type: "STRING" }, words_seen: { type: "ARRAY", items: { type: "STRING" } },
}, required: ["people", "audience", "activity", "moment", "expression", "camera_distance", "camera_height", "subject_fill_pct", "depth_of_field", "light_direction", "light_quality", "colour_temperature", "saturation", "photo_feel", "words_over", "scroll_stopper", "words_seen"] };
export const READING_PROMPT = [
  "This is a finished gym advert: a photograph with words laid over it. Describe THE PHOTOGRAPH beneath the words, as a photographer would brief another photographer to take a shot like it. Ignore the words' meaning, colours and fonts.",
  "Be concrete and measurable: camera_distance (extreme-close-up = face or a hand; close-up = head and shoulders; medium-close = waist up; medium = knees up; full-body = the whole person; wide = the room), camera height and angle, subject_fill_pct = the share of the frame's HEIGHT the main person fills (0-100), where the frame cuts the body, lens feel, how blurred the background is, the moment of the movement and the expression, where the light comes from and how hard it is, its colour temperature, the dominant colours, how busy the background is, and whether the ad's words sit over the background, over the body but not the face, over the face, or beside the person.",
  "activity: the exercise and the exact moment, in one sentence. background: what is behind the person, in one sentence. scroll_stopper: one sentence on what makes this photo grab attention in a feed.",
  "Name no brand, no person, no place and no business. List every word or number printed on the image in words_seen, apart from everything else, and never use those words anywhere else in your answer.",
].join("\n\n");
const shaOf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
/** The distinct reference images in the folder, by content (a file saved twice counts once). */
export function referenceFiles(dir = REFERENCE_ADS_DIR) {
  if (!existsSync(dir)) return [];
  const seen = new Map();
  for (const f of readdirSync(dir).filter((x) => IMAGE.test(x)).sort()) { const sha = shaOf(readFileSync(join(dir, f))); if (!seen.has(sha)) seen.set(sha, { sha, file: f, path: join(dir, f) }); }
  return [...seen.values()];
}
/** The readings kept so far. */
export const readShots = (lib = LIBRARY_DIR) => { const j = readJson(join(lib, "reference-shots.json")); return { schema: 1, readings: {}, ...(j || {}), readings: j?.readings || {} }; };
function tidy(r) {
  const out = {};
  for (const [k, spec] of Object.entries(READING_SCHEMA.properties)) {
    const v = r?.[k];
    if (spec.enum) out[k] = spec.enum.includes(v) ? v : null;
    else if (spec.type === "ARRAY") out[k] = (Array.isArray(v) ? v : []).map((x) => clean(String(x), 80)).filter((x) => !spec.items.enum || spec.items.enum.includes(x)).slice(0, 12);
    else if (spec.type === "INTEGER") out[k] = Number.isFinite(+v) ? Math.max(0, Math.min(k === "subject_fill_pct" ? 100 : 20, Math.round(+v))) : null;
    else out[k] = clean(v);
  }
  return out;
}
/**
 * Read every reference not yet read (one vision call each) into library/reference-shots.json. The image goes
 * to the reader only — this is the one place it is ever sent — and never to an image-generation call.
 */
export async function readReferences({ dir = REFERENCE_ADS_DIR, lib = LIBRARY_DIR, ask = callVision, model = SHOT_MODEL, log = () => {} } = {}) {
  const data = readShots(lib), files = referenceFiles(dir);
  let calls = 0;
  for (const f of files) {
    if (data.readings[f.sha]) continue;
    const a = await ask(f.path, READING_PROMPT, READING_SCHEMA, { model }); calls++;
    data.readings[f.sha] = { file: f.file, reading: tidy(a), read_at: new Date().toISOString() };
    data.model = model;
    writeWhole(join(lib, "reference-shots.json"), JSON.stringify(data, null, 2) + "\n");
    log(`  read ${f.file.slice(0, 40)}: ${data.readings[f.sha].reading.camera_distance}, ${data.readings[f.sha].reading.moment}, fills ${data.readings[f.sha].reading.subject_fill_pct}%`);
  }
  return { files: files.length, read: calls, total: Object.keys(data.readings).length };
}

// ── the counts, in code ──────────────────────────────────────────────────────
const COUNTED = ["audience", "moment", "expression", "gaze", "camera_distance", "camera_height", "camera_angle", "subject_position", "lens_feel", "depth_of_field", "light_direction", "light_quality", "colour_temperature", "saturation", "clutter", "photo_feel", "words_over"];
/** How many references show each value — the facts the guide's rules must stand on. */
export function countShots(readings) {
  const rs = readings.map((x) => x.reading || x), n = rs.length, counts = { n };
  for (const k of COUNTED) { const c = {}; for (const r of rs) if (r[k]) c[r[k]] = (c[r[k]] || 0) + 1; counts[k] = Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1])); }
  for (const k of ["motion", "apparent_ages"]) { const c = {}; for (const r of rs) for (const v of r[k] || []) c[v] = (c[v] || 0) + 1; counts[k] = Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1])); }
  const fills = rs.map((r) => r.subject_fill_pct).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  counts.subject_fill_pct = fills.length ? { min: fills[0], median: fills[Math.floor(fills.length / 2)], max: fills.at(-1), at_least_60: fills.filter((v) => v >= 60).length } : null;
  const people = rs.map((r) => r.people).filter(Number.isFinite);
  counts.people = { one: people.filter((p) => p === 1).length, two: people.filter((p) => p === 2).length, more: people.filter((p) => p > 2).length, none: people.filter((p) => p === 0).length };
  return counts;
}

// ── the guide ────────────────────────────────────────────────────────────────
export const GUIDE_SCHEMA = { type: "OBJECT", properties: {
  rules: { type: "ARRAY", items: { type: "OBJECT", properties: { rule: { type: "STRING" }, evidence: { type: "STRING" } }, required: ["rule", "evidence"] } },
  recipes: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, when: { type: "STRING" }, camera: { type: "STRING" }, moment: { type: "STRING" }, light: { type: "STRING" }, colour: { type: "STRING" }, background: { type: "STRING" }, words: { type: "STRING" }, refs: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["name", "camera", "moment", "light", "background", "words", "refs"] } },
  avoid: { type: "ARRAY", items: { type: "STRING" } },
}, required: ["rules", "recipes", "avoid"] };
export function buildGuidePrompt(readings, counts) {
  const strip = ({ words_seen, ...r }) => r;
  return [
    `You are writing the photography brief for a gym-ad studio. Below are structured readings of ${counts.n} high-performing gym ads' PHOTOGRAPHS (the words laid over them are ignored), and the counts of each value across them. Write the rules our photographer (an image model) must follow so new photos for any gym look like these.`,
    `RULES: 8 to 12. Each is one concrete instruction a photographer can follow and a checker can see: camera distance and height, how much of the frame the person fills (a number), the moment of the movement, expression, light direction and hardness, colour, background blur and clutter, where the ad's words go against the person. Give each its evidence as a count from the COUNTS ("14 of ${counts.n}"). Only rules the counts support; say "most" only above half.`,
    `RECIPES: 3 to 5 named shot types that recur (always at least 3), each with when to use it, the camera, the moment, the light, the colour, the background, where the words go, and the numbers (1-based) of the readings that show it.`,
    `AVOID: what none or almost none of them do (for example a small figure in a big empty room), as short instructions.`,
    `Write for photographers in plain words. Name no brand, no person, no place, no business, and quote no words from the ads.`,
    `COUNTS:\n${JSON.stringify(counts)}`,
    `READINGS:\n${readings.map((r, i) => `${i + 1}. ${JSON.stringify(strip(r.reading || r))}`).join("\n")}`,
  ].join("\n\n");
}
/** A line that repeats a word printed on any reference (a place, a gym, an offer) is dropped: the guide carries shots, never their words. */
export function leaks(text, words) {
  const low = ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  return words.filter((w) => w.length >= 4 && low.includes(` ${w} `));
}
const COMMON = new Set(["week", "weeks", "with", "your", "this", "that", "from", "body", "full", "free", "only", "gym", "join", "more", "area", "ladies", "women", "men", "wanted", "strong", "strength", "fitness", "training", "challenge", "program", "programme", "transformation", "confidence", "comeback"]);
export function seenWords(readings) {
  const ws = new Set();
  for (const r of readings) for (const phrase of (r.reading || r).words_seen || []) for (const w of String(phrase).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)) if (w.length >= 4 && !COMMON.has(w) && !/^\d+$/.test(w)) ws.add(w);
  return [...ws];
}
const NAMES_SCHEMA = { type: "OBJECT", properties: { names: { type: "ARRAY", items: { type: "STRING" } } }, required: ["names"] };
/**
 * Which of the words printed on the references are NAMES — a place, a gym or business, a brand, a person —
 * the only words the guide may not carry. Ordinary words ("high", "strong") are fine in a photographer's brief.
 * One text call, cached with the readings.
 */
export async function nameWords({ lib = LIBRARY_DIR, ask = callVision, model = SHOT_MODEL } = {}) {
  const data = readShots(lib), readings = Object.values(data.readings), cands = seenWords(readings);
  if (data.names && data.names_from?.join(" ") === cands.join(" ")) return data.names;
  if (!cands.length) return [];
  const a = await ask(null, `These words were printed on gym adverts. Which of them are names: of a place (town, area, street, country), a gym, business or brand, or a person? Return those only, lower-case, exactly as given. Ordinary words (for example strong, high, ladies, reset) are not names.\n\n${cands.join(", ")}`, NAMES_SCHEMA, { model });
  const names = (a?.names || []).map((w) => String(w).toLowerCase().trim()).filter((w) => cands.includes(w));
  data.names = names; data.names_from = cands; writeWhole(join(lib, "reference-shots.json"), JSON.stringify(data, null, 2) + "\n");
  return names;
}
/** A reference in plain words, composed in code from its reading — what to re-create, with no name and no printed word. */
export function shotBrief(r) {
  const x = r.reading || r, who = x.people === 1 ? "one person" : x.people === 2 ? "two people" : x.people > 2 ? `${x.people} people` : "no people";
  const bits = [
    `${who}${x.apparent_ages?.length ? ` (${x.apparent_ages.join(", ")})` : ""}: ${x.activity}`,
    `${x.camera_distance || "?"} shot, ${x.camera_height || "?"} camera, ${x.camera_angle || "?"} angle, ${x.lens_feel || "normal"} lens; the person fills ${x.subject_fill_pct ?? "?"}% of the height, ${x.subject_position || "?"}; ${x.crop || ""}`.replace(/; $/, ""),
    `moment: ${x.moment}; expression: ${x.expression}; looking ${x.gaze || "?"}${(x.motion || []).filter((m) => m !== "none").length ? `; ${x.motion.filter((m) => m !== "none").join(", ")}` : ""}`,
    `light: ${x.light_quality} ${x.light_direction}, ${x.colour_temperature}; colour: ${(x.dominant_colours || []).join(", ")} (${x.saturation}); background: ${x.background} (${x.depth_of_field} depth of field, ${x.clutter})`,
    `words sit ${String(x.words_over || "").replace(/-/g, " ")}; ${x.photo_feel} feel. Why it stops the scroll: ${x.scroll_stopper}`,
  ];
  return bits.join(". ").replace(/\.\./g, ".");
}
/** One text call: the guide, checked in code (no leaked names; recipes point at real readings). */
export async function buildGuide({ lib = LIBRARY_DIR, ask = callVision, model = SHOT_MODEL } = {}) {
  const data = readShots(lib), readings = Object.values(data.readings);
  if (!readings.length) throw new Error("no readings yet: run --read first");
  const counts = countShots(readings), words = await nameWords({ lib, ask, model });
  const a = await ask(null, buildGuidePrompt(readings, counts), GUIDE_SCHEMA, { model });
  const dropped = [];
  const keep = (label, text) => { const l = leaks(text, words); if (l.length) { dropped.push({ what: label, why: `repeats names from the ads: ${l.join(", ")}` }); return false; } return true; };
  const rules = (a?.rules || []).map((r) => ({ rule: clean(r.rule, 300), evidence: clean(r.evidence, 120) })).filter((r) => r.rule && keep(`rule "${r.rule.slice(0, 50)}"`, `${r.rule} ${r.evidence}`));
  const recipes = (a?.recipes || []).map((r) => ({ name: clean(r.name, 60), when: clean(r.when, 200), camera: clean(r.camera, 240), moment: clean(r.moment, 240), light: clean(r.light, 240), colour: clean(r.colour, 200), background: clean(r.background, 240), words: clean(r.words, 200), refs: (r.refs || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= readings.length) })).filter((r) => r.name && keep(`recipe "${r.name}"`, Object.values(r).join(" ")));
  const avoid = (a?.avoid || []).map((x) => clean(x, 200)).filter((x) => x && keep(`avoid "${x.slice(0, 50)}"`, x));
  const briefs = readings.map((r, i) => ({ n: i + 1, file: r.file, brief: shotBrief(r) })).filter((b) => !leaks(b.brief, words).length || (dropped.push({ what: `brief ${b.n}`, why: `repeats names from the ads: ${leaks(b.brief, words).join(", ")}` }), false));
  const guide = { schema: 1, model, made: new Date().toISOString(), refs: readings.map((r) => r.file), counts, rules, recipes, avoid, briefs, dropped };
  writeWhole(join(lib, "shot-guide.json"), JSON.stringify(guide, null, 2) + "\n");
  writeWhole(join(lib, "shot-guide.md"), guideMarkdown(guide));
  return guide;
}
const pct = (c, n) => Object.entries(c || {}).map(([k, v]) => `${k} ${v}`).join(", ") + ` (of ${n})`;
export function guideMarkdown(g) {
  const c = g.counts, n = c.n;
  return [
    `# Shot guide`,
    `From ${n} high-performing gym ads (their photographs; the words over them ignored). Read once by ${g.model}; never sent to an image model. Made ${g.made.slice(0, 10)}.`,
    `## Rules`, ...g.rules.map((r, i) => `${i + 1}. ${r.rule} *(${r.evidence})*`),
    `## Shot recipes`, ...g.recipes.map((r) => `**${r.name}**${r.when ? ` — ${r.when}` : ""}\n- Camera: ${r.camera}\n- Moment: ${r.moment}\n- Light: ${r.light}${r.colour ? `\n- Colour: ${r.colour}` : ""}\n- Background: ${r.background}\n- Words: ${r.words}\n- Seen in references ${r.refs.join(", ")}`),
    `## Avoid`, ...g.avoid.map((x) => `- ${x}`),
    `## The counts`,
    `- Camera distance: ${pct(c.camera_distance, n)}`, `- Person fills (share of frame height): ${c.subject_fill_pct ? `median ${c.subject_fill_pct.median}%, range ${c.subject_fill_pct.min}–${c.subject_fill_pct.max}%, ${c.subject_fill_pct.at_least_60} of ${n} at 60% or more` : "–"}`,
    `- Moment: ${pct(c.moment, n)}`, `- Expression: ${pct(c.expression, n)}`, `- Gaze: ${pct(c.gaze, n)}`,
    `- Camera height: ${pct(c.camera_height, n)}`, `- Angle: ${pct(c.camera_angle, n)}`, `- Lens: ${pct(c.lens_feel, n)}`, `- Background blur: ${pct(c.depth_of_field, n)}`,
    `- Light: ${pct(c.light_direction, n)}; ${pct(c.light_quality, n)}`, `- Colour temperature: ${pct(c.colour_temperature, n)}; saturation ${pct(c.saturation, n)}`,
    `- Clutter: ${pct(c.clutter, n)}`, `- Feel: ${pct(c.photo_feel, n)}`, `- Words sit: ${pct(c.words_over, n)}`,
    `- People: one ${c.people.one}, two ${c.people.two}, more ${c.people.more}, none ${c.people.none}`, `- Audience: ${pct(c.audience, n)}`, `- Ages seen: ${pct(c.apparent_ages, n)}`,
    `## Each reference in words`, ...(g.briefs || []).map((b) => `${b.n}. ${b.brief}`),
    g.dropped.length ? `\n*Dropped from the model's draft:* ${g.dropped.map((d) => `${d.what} (${d.why})`).join("; ")}` : "",
  ].filter(Boolean).join("\n\n") + "\n";
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { read: { type: "boolean", default: false }, guide: { type: "boolean", default: false }, show: { type: "boolean", default: false } } });
  try {
    if (v.read) { const r = await readReferences({ log: console.log }); console.log(`${r.files} distinct references; ${r.read} read now; ${r.total} readings kept (${SHOT_MODEL})`); }
    if (v.guide) { const g = await buildGuide(); console.log(`shot guide: ${g.rules.length} rules, ${g.recipes.length} recipes, ${g.avoid.length} to avoid${g.dropped.length ? `, ${g.dropped.length} dropped` : ""} → ${join(LIBRARY_DIR, "shot-guide.md")}`); }
    if (v.show) { const p = join(LIBRARY_DIR, "shot-guide.md"); console.log(existsSync(p) ? readFileSync(p, "utf-8") : "no guide yet: run --read then --guide"); }
    if (!v.read && !v.guide && !v.show) { console.error("Usage: reference-shots.mjs [--read] [--guide] [--show]"); process.exit(1); }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
