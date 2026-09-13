#!/usr/bin/env node
/**
 * refresh-scenes.mjs — the agent drafts new scenes for a gym's library, for the owner to approve.
 *
 * Three ways to direct it:
 *   gaps       (default) the tags with the fewest live scenes for the audience — age, setting,
 *              equipment, muscles — and exercises the library does not have yet
 *   words      the owner's description: "older women doing walking lunges with a coach, cheerful"
 *   reference  a reference image the owner supplies. The vision model reads it ONCE into words — the
 *              activity, head count, ages, setting, equipment, framing, where the subject sits, light
 *              and energy — and every word on it is listed apart (`text_seen`) so no draft repeats it.
 *              That description directs the drafter exactly as words do. The image is never attached
 *              to an image-generation call and never named to the drafter; it stays in
 *              brands/{gym}/references/ (gitignored with the rest of brands/). Analysis, not copying.
 *
 * "Similar" to a reference means the same activity, head count, setting, framing, subject placement
 * and energy — in THIS gym: the photography lock supplies the premises, the people and the light.
 * Two carry-overs keep the reference's shape: its framing sets the scene's pose, and its empty space
 * sets the layout the scene prefers (subject left, words right → the right-column layout).
 *
 * The drafter is one text call (the check model, JSON schema, no image) carrying the gym's lock, the
 * tag and pose vocabularies, the candid and realism rules, the direction, and a one-line summary of
 * every live AND retired scene so nothing repeats. Drafts are validated in code (the library's own
 * rules, duplicate ids, near-duplicate wording, the audience, forbidden words) — bad ones are dropped
 * with the reason — and the survivors are appended as drafts (`draft: true`, `source`, `added`, and
 * what they were asked for). Nothing is generated from a draft until the owner approves it.
 *
 * Costs: text calls only — one per refresh, one more on a shortfall, one vision call per reference
 * read (cached beside the image). No image calls anywhere here.
 *
 * Usage:
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --audience women --count 6 [--dry-run]
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --audience women --count 4 --cover exercise:lunge,age:older
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --audience any --count 3 --words "…"
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --audience men --count 3 --reference references/ad.jpg
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --approve w-lunge-coach,w-row
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --reject w-row --reason "not our kind of session"
 *   node skills/references/refresh-scenes.mjs --brand-dir brands/x --list
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve, extname, relative } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";
import { POSES, scrubNames, isAboutText } from "./visual-prompts.mjs";
import { loadCatalogue } from "./render-composites.mjs";
import { SCENE_TAGS, MAX_SCENE_PEOPLE, AUDIENCES, sceneProblems, sceneWarnings, readLibrary, writeLibrary, isRetired, isDraft, sceneSummary, approveScenes, rejectScene, libraryStatus, today } from "./scene-library.mjs";

export const DRAFT_MODEL = process.env.DRAFT_MODEL || CHECK_MODEL;
export const READER_MODEL = process.env.READER_MODEL || CHECK_MODEL;
/** Calls a refresh may make: the draft, and one more for a shortfall after validation. */
export const MAX_DRAFT_CALLS = 2;
/** Two scenes sharing this share of their content words are the same scene twice. */
export const NEAR_DUPLICATE = 0.6;
export const MAX_WORDS = 600;
export const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
export const REFERENCES_DIR = "references";

// ── direction ─────────────────────────────────────────────────────────────

/** Where a reference image is: brands/{gym}/references/{name}, or a path. */
export function referencePath(ref, brandDir = null) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const tries = [brandDir && join(brandDir, REFERENCES_DIR, ref), brandDir && join(brandDir, ref), resolve(ref)].filter(Boolean);
  return tries.find(existsSync) || null;
}

/** Problems with a brief's or a refresh's direction. Empty = usable. */
export function validateDirection(d, { brandDir = null } = {}) {
  const errs = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["direction must be an object with words and/or a reference image"];
  if (d.words != null) {
    if (typeof d.words !== "string" || d.words.trim().length < 3) errs.push("words must describe the pictures wanted (a few words at least)");
    else if (d.words.length > MAX_WORDS) errs.push(`words is ${d.words.length} characters; the limit is ${MAX_WORDS}`);
  }
  if (d.reference != null) {
    if (typeof d.reference !== "string" || !d.reference.trim()) errs.push("reference must name an image file");
    else if (!IMAGE_EXT.includes(extname(d.reference).toLowerCase())) errs.push(`reference must be an image (${IMAGE_EXT.join(", ")})`);
    else if (!referencePath(d.reference, brandDir)) errs.push(`reference image not found: ${d.reference}`);
  }
  if (d.words == null && d.reference == null) errs.push("direction needs words, a reference image, or both");
  for (const k of Object.keys(d)) if (!["words", "reference"].includes(k)) errs.push(`unknown field "${k}" (direction takes words and reference)`);
  return errs;
}

/** "exercise:lunge,age:older" → [{ tag, value }], checked against the vocabularies. */
export function parseCover(str) {
  return String(str || "").split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [tag, value] = pair.split(":").map((x) => x.trim());
    if (!tag || !value) throw new Error(`cover: "${pair}" is not tag:value`);
    if (tag !== "exercise" && !SCENE_TAGS[tag]) throw new Error(`cover: unknown tag "${tag}" (use exercise, ${Object.keys(SCENE_TAGS).join(", ")})`);
    if (SCENE_TAGS[tag] && !SCENE_TAGS[tag].includes(value)) throw new Error(`cover: ${tag} "${value}" is not one of ${SCENE_TAGS[tag].join(", ")}`);
    return { tag, value };
  });
}

// ── gaps ──────────────────────────────────────────────────────────────────

/** The scenes a batch for this audience draws from: its own, or the mixed ones for an ungendered callout. */
const forAudience = (s, audience) => (audience === "any" ? !s.audience || s.audience === "any" : !s.audience || s.audience === audience);

/**
 * What the live library is thin on, for an audience: every tag value with its count (fewest first),
 * the exercises it already has, and any must_show value nothing shows.
 */
export function sceneGaps(scenes, { audience = "any", mustShow = {} } = {}) {
  const live = scenes.filter((s) => !isRetired(s) && !isDraft(s) && forAudience(s, audience));
  const tags = [];
  for (const [tag, values] of Object.entries(SCENE_TAGS)) for (const value of values) tags.push({ tag, value, count: live.filter((s) => s[tag] === value).length });
  tags.sort((a, b) => a.count - b.count);
  const exercises = [...new Set(live.map((s) => s.exercise).filter(Boolean))].sort();
  const wanted = Object.entries(mustShow || {}).flatMap(([tag, values]) => (values || []).filter((v) => !live.some((s) => s[tag] === v || (tag === "exercise" && String(s.exercise || "").includes(v)))).map((value) => ({ tag, value })));
  return { audience, live: live.length, tags, exercises, wanted };
}

/** The gaps a refresh of n scenes should cover: what was asked for first, then the thinnest tags, at most two per tag. */
export function coverFromGaps(gaps, n = 6) {
  const out = [...gaps.wanted.map((w) => ({ ...w, count: 0 }))];
  const perTag = {};
  for (const t of gaps.tags) {
    if (out.length >= n) break;
    if ((perTag[t.tag] || 0) >= 2 || out.some((o) => o.tag === t.tag && o.value === t.value)) continue;
    out.push(t); perTag[t.tag] = (perTag[t.tag] || 0) + 1;
  }
  return out.slice(0, Math.max(n, gaps.wanted.length));
}

// ── the reader: a reference image → words ─────────────────────────────────

export const FRAMINGS = { "full-length": "upright", "waist-up": "compact", seated: "compact", kneeling: "compact", crouching: "compact", floor: "low" };
export const POSITIONS = ["left", "centre", "right"];

const READER_QUESTION = `This is a reference image an advertiser supplied. Describe the PHOTOGRAPH in it — the people and what they are doing — so a photographer could shoot a similar picture somewhere else.
Ignore the graphic layer: do not describe, quote or repeat any words, headings, prices, logos or buttons on it; list every word you can read under text_seen instead, and any brand or gym name under brands_seen. Never name a brand, a gym, a person or a place anywhere else in your answer.

Answer:
- activity: what the people are doing, in one plain sentence (the exercise, the moment in it, the effort or mood on their faces)
- exercise: a short lower-case name for the exercise, e.g. back-squat, kettlebell-swing, plank, boxing-pads; "none" if there is no exercise
- people_count: how many people are in the photograph
- ages: the age bands you see, from young (20s), prime (30s–40s), older (50s–60s)
- setting: solo (one person), coached (a coach with a client), or group (a class)
- equipment: one of ${SCENE_TAGS.equipment.join(", ")}; "none" if nothing is used
- muscles: the muscle group the exercise works, one of ${SCENE_TAGS.muscles.join(", ")}
- framing: how the main person is framed — one of ${Object.keys(FRAMINGS).join(", ")}
- subject_position: where the people sit across the frame — left, centre or right
- subject_height: where they sit down the frame — high, middle or low
- lighting: the light in a few words (bright daylight, hard side light, dim and moody…)
- energy: the mood in a few words (calm and focused, cheerful, gritty effort…)
- text_seen: every word or phrase you can read on the image
- brands_seen: any brand, gym or product name you can see or infer`;

const READER_SCHEMA = {
  type: "OBJECT",
  properties: {
    activity: { type: "STRING" }, exercise: { type: "STRING" }, people_count: { type: "INTEGER" },
    ages: { type: "ARRAY", items: { type: "STRING" } }, setting: { type: "STRING" }, equipment: { type: "STRING" }, muscles: { type: "STRING" },
    framing: { type: "STRING" }, subject_position: { type: "STRING" }, subject_height: { type: "STRING" },
    lighting: { type: "STRING" }, energy: { type: "STRING" },
    text_seen: { type: "ARRAY", items: { type: "STRING" } }, brands_seen: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["activity", "exercise", "people_count", "ages", "setting", "equipment", "muscles", "framing", "subject_position", "subject_height", "lighting", "energy", "text_seen", "brands_seen"],
};

/** The layout a reference's empty space suggests: the words go where the people are not. */
export function layoutFromPosition(position, pose, catalogue = loadCatalogue()) {
  const want = position === "left" ? "t3-right-column" : position === "right" ? "t6-left-column" : pose === "low" ? "t5-offer-band" : pose === "compact" ? "t1-bottom-stack" : "t4-centred-stack";
  const tr = catalogue.treatments.treatments[want];
  return tr && (!tr.pose_fit || tr.pose_fit.includes(pose)) ? want : null;
}

/** A reader's answer, tidied to the vocabularies, with the pose and preferred layout worked out. */
export function normaliseDescription(a, { catalogue = loadCatalogue() } = {}) {
  const low = (x) => String(x || "").trim().toLowerCase();
  const people = Number.isInteger(a.people_count) && a.people_count > 0 ? Math.min(a.people_count, MAX_SCENE_PEOPLE) : 1;
  let setting = low(a.setting);
  if (!SCENE_TAGS.setting.includes(setting)) setting = people === 1 ? "solo" : people === 2 ? "coached" : "group";
  if (setting === "solo" && people !== 1) setting = people === 2 ? "coached" : "group";
  if (setting === "coached" && people < 2) setting = "solo";
  if (setting === "group" && people < 3) setting = people === 2 ? "coached" : "solo";
  const framing = Object.keys(FRAMINGS).includes(low(a.framing)) ? low(a.framing) : "full-length";
  const pose = FRAMINGS[framing];
  const position = POSITIONS.includes(low(a.subject_position)) ? low(a.subject_position) : low(a.subject_position) === "center" ? "centre" : "centre";
  const equipment = SCENE_TAGS.equipment.includes(low(a.equipment)) ? low(a.equipment) : null;
  const muscles = SCENE_TAGS.muscles.includes(low(a.muscles)) ? low(a.muscles) : null;
  const ages = [...new Set((a.ages || []).map(low).filter((x) => SCENE_TAGS.age.includes(x)))];
  const exercise = /^[a-z][a-z-]{1,40}$/.test(low(a.exercise).replace(/\s+/g, "-")) && low(a.exercise) !== "none" ? low(a.exercise).replace(/\s+/g, "-") : null;
  const strings = (xs) => [xs].flat().filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  return {
    activity: String(a.activity || "").trim(), exercise, people, ages, setting, equipment, muscles, framing, pose,
    subject_position: position, subject_height: ["high", "middle", "low"].includes(low(a.subject_height)) ? low(a.subject_height) : "middle",
    lighting: String(a.lighting || "").trim(), energy: String(a.energy || "").trim(),
    prefer_layout: layoutFromPosition(position, pose, catalogue),
    text_seen: strings(a.text_seen), brands_seen: strings(a.brands_seen),
  };
}

/** Read a reference image into words — one vision call, cached beside the image. */
export async function readReference(path, { ask = callVision, model = READER_MODEL, cache = true, catalogue = loadCatalogue(), log = () => {} } = {}) {
  const side = `${path}.description.json`;
  if (cache && existsSync(side)) { log(`· reference: ${relative(process.cwd(), path)} read before — using its description`); return { description: JSON.parse(readFileSync(side, "utf-8")), calls: 0 }; }
  const answer = await ask(path, READER_QUESTION, READER_SCHEMA, { model });
  const description = normaliseDescription(answer, { catalogue });
  if (cache) writeFileSync(side, JSON.stringify(description, null, 2) + "\n");
  return { description, calls: 1 };
}

/** The reference, in words the drafter can follow. Its words and brands are never in here. */
export function describeReference(d) {
  const who = `${d.people} ${d.people === 1 ? "person" : "people"}${d.ages.length ? ` (${d.ages.join(" and ")})` : ""}, ${d.setting === "solo" ? "training alone" : d.setting === "coached" ? "a coach with a client" : "a class"}`;
  return [
    `The owner supplied a reference photograph. It shows: ${d.activity || "a training moment"}`,
    `${who}; equipment: ${d.equipment || "none"}; framed ${d.framing}, the people on the ${d.subject_position} of the frame, ${d.subject_height} in it; light: ${d.lighting || "natural"}; mood: ${d.energy || "focused"}.`,
    `Write scenes that would photograph like it, in this gym, with this gym's people and light: the same activity, head count (${d.people}), setting (${d.setting}), framing (${d.framing}) and energy. Do not copy its people, its room or anything written on it.`,
  ].join(" ");
}

// ── the drafter ───────────────────────────────────────────────────────────

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: {
    scenes: { type: "ARRAY", items: { type: "OBJECT", properties: {
      id: { type: "STRING" }, audience: { type: "STRING" }, pose: { type: "STRING" }, people: { type: "INTEGER" }, exercise: { type: "STRING" },
      age: { type: "STRING" }, setting: { type: "STRING" }, equipment: { type: "STRING" }, muscles: { type: "STRING" }, scene: { type: "STRING" },
    }, required: ["id", "audience", "pose", "people", "exercise", "age", "setting", "equipment", "muscles", "scene"] } },
  },
  required: ["scenes"],
};

const PREFIX = { men: "m-", women: "w-", any: "a-" };
const WHO = { men: "men", women: "women", any: "a mix of men and women (or either)" };

/** The drafting request: everything the model needs to write scenes for this gym that repeat nothing. */
export function buildRefreshRequest({ audience = "any", count = 6, direction = { kind: "gaps", cover: [], exercises: [] }, scenes = [], photography = {}, brandNames = [] }) {
  if (!AUDIENCES.includes(audience)) throw new Error(`audience must be one of ${AUDIENCES.join(", ")}`);
  const must = (photography.must || []).map((t) => scrubNames(t, brandNames));
  const never = (photography.never || []).filter((t) => !isAboutText(t)).map((t) => scrubNames(t, brandNames));
  const lines = [
    "You write scene descriptions for a gym's advert photographs. Each scene is one photograph, described in one or two sentences: who is in it, what they are doing and where they are in the movement, and the expression on their faces. The photographs are made by an image model from your words, so write what a camera would see.",
    "PHOTOGRAPHS ONLY: the advert's words are added later by software. A scene never mentions text, signs, screens, logos, numbers or words of any kind, and never uses quotation marks.",
    `THE GYM: ${must.length ? must.join("; ") : "a real gym"}.${never.length ? ` Never: ${never.join("; ")}.` : ""}${photography.people ? ` PEOPLE: ${photography.people}.` : ""}`,
    `AUDIENCE: ${audience} — every scene shows ${WHO[audience]}; set each scene's audience to "${audience}".`,
    "CANDID: when a scene has more than one person, each is at their own point of the movement, loosely spaced at different angles, with some interaction — a glance, a word, a coach's cue or hand. Nobody looks into the camera. Never ask people to move together: no side by side, in unison, in time, identical, in a row, each holding, all doing.",
    "REAL: real equipment, complete and used the way it is meant to be — bodies rest on what holds them, hands grip real handles, the load sits where it does in the real exercise.",
    `FIELDS for each scene: id (a new lower-case slug starting with "${PREFIX[audience]}", e.g. ${PREFIX[audience]}lunge-coach); audience ("${audience}"); pose — one of ${Object.entries(POSES).map(([k, v]) => `${k} (${v})`).join("; ")}; people (1 to ${MAX_SCENE_PEOPLE}: solo = 1, coached = 2 or more, group = 3 or more); exercise (a short lower-case name, e.g. back-squat); age — ${SCENE_TAGS.age.join(", ")} (20s; 30s–40s; 50s–60s); setting — ${SCENE_TAGS.setting.join(", ")}; equipment — ${SCENE_TAGS.equipment.join(", ")}; muscles — ${SCENE_TAGS.muscles.join(", ")}; scene (the description).`,
  ];
  if (direction.kind === "words") lines.push(`DIRECTION from the owner: ${direction.words.trim()} — every scene follows this, in this gym.`);
  else if (direction.kind === "reference") {
    lines.push(`DIRECTION: ${describeReference(direction.description)}`);
    lines.push(`Every scene: people = ${direction.description.people}, setting = ${direction.description.setting}, pose = ${direction.description.pose}.`);
  } else {
    const cover = direction.cover || [];
    lines.push(`DIRECTION: the library is thin on ${cover.length ? cover.map((c) => `${c.tag} ${c.value} (${c.count ?? 0} scene${c.count === 1 ? "" : "s"})`).join(", ") : "variety"}. Spread the new scenes across these so each is covered at least once${direction.exercises?.length ? `, and prefer exercises the library does not have yet (it has: ${direction.exercises.join(", ")})` : ""}.`);
  }
  const existing = scenes.filter((s) => s && s.id);
  lines.push(`EXISTING SCENES — do not repeat any of these or write a near-copy of one, and every id must be new:\n${existing.length ? existing.map((s) => `- ${sceneSummary(s)}`).join("\n") : "- (none yet)"}`);
  lines.push(`Write exactly ${count} scene${count === 1 ? "" : "s"}, each different from the others in exercise, age or setting.`);
  return { prompt: lines.join("\n\n"), schema: DRAFT_SCHEMA };
}

// ── validation ────────────────────────────────────────────────────────────

const STOP = new Set(["with", "their", "there", "that", "this", "from", "into", "onto", "over", "under", "while", "then", "than", "them", "they", "your", "just", "each", "about", "after", "before", "between", "being", "have", "some", "more", "other", "against", "through", "toward", "towards", "where", "which", "what", "when"]);
/** The words that carry a scene's meaning: lower-case, four letters or more, no stop words. */
export const wordsOf = (text) => new Set(String(text || "").toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

/** Are two scene descriptions the same scene twice? Shared content words over their union. */
export function nearDuplicate(a, b, threshold = NEAR_DUPLICATE) {
  const A = wordsOf(a), B = wordsOf(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared) >= threshold;
}

const hasWord = (text, word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}([^a-z0-9]|$)`, "i").test(text);

/**
 * Which drafts may enter the library, and why the others may not. `expect` is what a reference fixed
 * (people, setting — a draft that strays is dropped; pose and prefer_layout are set on every draft,
 * since framing is a matter of the crop).
 */
export function validateDrafts(drafts, { scenes = [], audience = "any", forbidden = [], expect = null } = {}) {
  const kept = [], dropped = [];
  const ids = new Set(scenes.map((s) => s.id).filter(Boolean));
  for (const raw of Array.isArray(drafts) ? drafts : []) {
    const d = { ...raw };
    for (const k of ["exercise", "age", "setting", "equipment", "muscles"]) if (d[k] === "" || d[k] === "none") delete d[k];
    if (typeof d.exercise === "string") d.exercise = d.exercise.trim().toLowerCase().replace(/\s+/g, "-");
    if (typeof d.id === "string") d.id = d.id.trim().toLowerCase();
    if (expect) { d.pose = expect.pose; if (expect.prefer_layout) d.prefer_layout = expect.prefer_layout; }
    const why = [];
    const problems = sceneProblems(d);
    if (problems.length) why.push(...problems);
    else {
      if (!/^[a-z][a-z0-9-]{2,50}$/.test(d.id || "")) why.push("id must be a lower-case slug");
      else if (ids.has(d.id)) why.push(`id "${d.id}" is taken`);
      if (d.audience !== audience) why.push(`audience is "${d.audience}"; this refresh is for ${audience}`);
      why.push(...sceneWarnings(d));
      const twin = scenes.find((s) => s.scene && nearDuplicate(s.scene, d.scene));
      if (twin) why.push(`near-copy of ${twin.id}${isRetired(twin) ? " (retired)" : ""}`);
      const bad = forbidden.filter((w) => w && hasWord(d.scene, w));
      if (bad.length) why.push(`names ${bad.map((w) => `"${w}"`).join(", ")}`);
      if (expect?.people != null && d.people !== expect.people) why.push(`${d.people} people; the reference has ${expect.people}`);
      if (expect?.setting && d.setting !== expect.setting) why.push(`setting ${d.setting}; the reference is ${expect.setting}`);
    }
    if (why.length) { dropped.push({ id: d.id || null, scene: d.scene || null, reason: why.join("; ") }); continue; }
    ids.add(d.id); kept.push(d); scenes = [...scenes, d]; // later drafts are judged against earlier ones too
  }
  return { kept, dropped };
}

// ── a refresh ─────────────────────────────────────────────────────────────

const brandNamesOf = (profile) => [profile.display_name, profile.formerly?.split(/\s[—–-]\s|[;,(]/)[0].trim()].filter(Boolean);
const forbiddenFrom = (photography, brandNames, description = null) => [...brandNames, ...(description?.text_seen || []), ...(description?.brands_seen || []),
  // the words a never-list item says are written somewhere: "...text reading You are one workout away..."
  ...(photography.never || []).filter(isAboutText).map((t) => t.match(/\breading\s+(.+)$/i)?.[1]).filter(Boolean)];

/**
 * Draft scenes for a gym and append them to its library as drafts. Returns what was drafted, what
 * was dropped and why, and the calls made. `ask` is the model call (callVision's shape: image or
 * null, question, schema, options) — injectable for tests.
 */
export async function draftScenes({ brandDir, scenesPath = join(brandDir, "scenes.json"), audience = "any", count = 6, direction = null, cover = null, source = "refresh", ask = callVision, catalogue = loadCatalogue(), dryRun = false, date = today(), log = console.log }) {
  if (!AUDIENCES.includes(audience)) throw new Error(`audience must be one of ${AUDIENCES.join(", ")}`);
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("count must be 1 to 12");
  if (direction) { const errs = validateDirection(direction, { brandDir }); if (errs.length) throw new Error(`direction: ${errs.join("; ")}`); }
  const profile = JSON.parse(readFileSync(join(brandDir, "gym-profile.json"), "utf-8"));
  const photography = profile.brand_lock?.photography || {}, brandNames = brandNamesOf(profile);
  const lib = readLibrary(scenesPath);
  let text_calls = 0, vision_calls = 0, dir, expect = null, description = null, stamp;
  if (direction?.reference) {
    const path = referencePath(direction.reference, brandDir);
    const r = await readReference(path, { ask, catalogue, log });
    vision_calls += r.calls; description = r.description;
    // The owner's words, when given with a reference, are folded into the activity line.
    if (direction.words) description = { ...description, activity: `${description.activity} ${direction.words.trim()}`.trim() };
    dir = { kind: "reference", description };
    expect = { pose: description.pose, prefer_layout: description.prefer_layout, people: description.people, setting: description.setting };
    stamp = { direction: { reference: relative(brandDir, path), ...(direction.words ? { words: direction.words } : {}), summary: `${description.activity} (${description.people} ${description.setting}, ${description.framing}, ${description.subject_position})` } };
    log(`· reference: ${description.activity} — ${description.people} ${description.setting}, ${description.framing}, people on the ${description.subject_position}${description.prefer_layout ? ` → ${description.prefer_layout}` : ""}${description.text_seen.length ? `; words on it kept out: ${description.text_seen.join(" / ")}` : ""}`);
  } else if (direction?.words) {
    dir = { kind: "words", words: direction.words };
    stamp = { direction: { words: direction.words } };
  } else {
    const gaps = sceneGaps(lib.scenes, { audience });
    const c = cover ? cover.map((x) => ({ ...x, count: gaps.tags.find((t) => t.tag === x.tag && t.value === x.value)?.count ?? 0 })) : coverFromGaps(gaps, count);
    dir = { kind: "gaps", cover: c, exercises: gaps.exercises };
    // Each draft records the gaps it actually fills, so the library says why a scene was written.
    stamp = (d) => ({ covers: c.filter((x) => (x.tag === "exercise" ? String(d.exercise || "").includes(x.value) : d[x.tag] === x.value)).map((x) => `${x.tag}:${x.value}`) });
    log(`· gaps for ${audience} (${gaps.live} live scene${gaps.live === 1 ? "" : "s"}): ${c.map((x) => `${x.tag} ${x.value} (${x.count})`).join(", ") || "none"}`);
  }
  const forbidden = forbiddenFrom(photography, brandNames, description);
  const kept = [], dropped = [];
  for (let call = 0; call < MAX_DRAFT_CALLS && kept.length < count; call++) {
    const need = count - kept.length;
    const { prompt, schema } = buildRefreshRequest({ audience, count: need, direction: dir, scenes: [...lib.scenes, ...kept], photography, brandNames });
    let answer;
    try { answer = await ask(null, prompt, schema, { model: DRAFT_MODEL }); text_calls++; }
    catch (e) { text_calls++; log(`⚑ the drafter's answer could not be used: ${e.message}`); continue; }
    const v = validateDrafts(answer?.scenes, { scenes: [...lib.scenes, ...kept], audience, forbidden, expect });
    for (const d of v.kept) kept.push({ ...d, draft: true, source, added: date, ...(typeof stamp === "function" ? stamp(d) : stamp) });
    dropped.push(...v.dropped);
    for (const d of v.dropped) log(`  dropped ${d.id || "(no id)"}: ${d.reason}`);
  }
  for (const d of kept) log(`  draft ${d.id}: ${d.scene}`);
  if (kept.length < count) log(`- ${kept.length} of ${count} drafted (${text_calls} text call${text_calls === 1 ? "" : "s"})`);
  if (!dryRun && kept.length) { lib.scenes.push(...kept); writeLibrary(scenesPath, lib); }
  return { drafts: kept, dropped, text_calls, vision_calls, direction: dir };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, audience: { type: "string", default: "any" }, count: { type: "string", default: "6" },
    cover: { type: "string" }, words: { type: "string" }, reference: { type: "string" },
    approve: { type: "string" }, reject: { type: "string" }, reason: { type: "string" }, list: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  } });
  if (!v["brand-dir"]) {
    console.error("Usage: refresh-scenes.mjs --brand-dir <brands/x> [--audience men|women|any] [--count N] [--cover tag:value,…] [--words \"…\"] [--reference <image>] [--dry-run]\n       refresh-scenes.mjs --brand-dir <brands/x> --approve id,id | --reject id --reason \"…\" | --list");
    process.exit(1);
  }
  const brandDir = resolve(v["brand-dir"]), scenesPath = join(brandDir, "scenes.json");
  try {
    if (v.list) {
      const lib = readLibrary(scenesPath), st = libraryStatus(lib);
      console.log(`${st.total} live (${Object.entries(st.counts).map(([k, n]) => `${n} ${k}`).join(", ")}), ${st.drafts} draft(s), ${st.retired} retired${st.approved ? "" : " — library not approved"}`);
      for (const s of lib.scenes) if (isDraft(s) || isRetired(s)) console.log(`  ${sceneSummary(s)}`);
    } else if (v.approve) {
      const r = approveScenes(scenesPath, v.approve.split(","));
      console.log(`approved: ${r.approved.join(", ") || "none"}${r.already.length ? ` (already live: ${r.already.join(", ")})` : ""}`);
    } else if (v.reject) {
      const r = rejectScene(scenesPath, v.reject, v.reason);
      console.log(`retired ${r.retired}: ${r.reason}`);
    } else {
      const direction = v.words || v.reference ? { ...(v.words ? { words: v.words } : {}), ...(v.reference ? { reference: v.reference } : {}) } : null;
      const r = await draftScenes({ brandDir, audience: v.audience, count: Number(v.count), direction, cover: v.cover ? parseCover(v.cover) : null, dryRun: v["dry-run"] });
      console.log(`${r.drafts.length} draft(s)${v["dry-run"] ? " (dry run — not written)" : ` written to ${scenesPath}`}; ${r.dropped.length} dropped; ${r.text_calls} text call(s), ${r.vision_calls} vision call(s)`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
