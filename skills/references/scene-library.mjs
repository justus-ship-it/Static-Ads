/**
 * scene-library.mjs — the client's scene library: brands/{gym}/scenes.json.
 *
 * A scene is one photograph described in words (who, what, where in the movement, expression), tagged
 * so a batch can spread its photos across exercises, ages, settings, equipment and muscle groups. The
 * library is the owner's: nothing is generated from it until it is approved, a scene added since
 * (`draft: true`) is left out until the owner approves it, and a scene the owner rejects is retired
 * (`status: "retired"`, with the reason and date) — never deleted, so old batches still trace to it
 * and a refresh never proposes it again.
 *
 * Shared by plan-offer-batch.mjs (which re-exports the vocabulary for its callers), refresh-scenes.mjs
 * (which drafts new scenes) and the panel.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { POSES } from "./visual-prompts.mjs";

/** What a scene may be tagged with, so a batch can spread its photos across them (planVisuals). */
export const SCENE_TAGS = {
  age: ["young", "prime", "older"], // 20s · 30s–40s · 50s–60s
  setting: ["solo", "coached", "group"],
  equipment: ["bodyweight", "dumbbells", "barbell", "kettlebell", "machine", "cable"],
  muscles: ["legs", "back", "chest", "shoulders", "arms", "core", "full-body"],
};
export const MAX_SCENE_PEOPLE = 6;
export const AUDIENCES = ["men", "women", "any"];

export function sceneProblems(s) {
  const errs = [];
  if (!s || typeof s.scene !== "string" || !s.scene.trim()) return ["a scene needs its description"];
  if (/["“”]/.test(s.scene)) errs.push("contains quotation marks — scenes describe the picture, never words to show");
  if (!POSES[s.pose]) errs.push(`pose must be one of ${Object.keys(POSES).join(", ")}`);
  if (!Number.isInteger(s.people) || s.people < 1 || s.people > MAX_SCENE_PEOPLE) errs.push(`people must be 1 to ${MAX_SCENE_PEOPLE}`);
  if (s.audience && !AUDIENCES.includes(s.audience)) errs.push('audience must be "men", "women" or "any"');
  for (const [tag, allowed] of Object.entries(SCENE_TAGS)) if (s[tag] != null && !allowed.includes(s[tag])) errs.push(`${tag} must be one of ${allowed.join(", ")}`);
  if (s.exercise != null && !/^[a-z][a-z-]{1,40}$/.test(s.exercise)) errs.push("exercise must be a short lower-case name, e.g. back-squat");
  // The setting has to agree with the head count, or the people check fails every photo.
  if (s.setting === "solo" && s.people !== 1) errs.push("a solo scene has 1 person");
  if (s.setting === "coached" && s.people < 2) errs.push("a coached scene has at least 2 people");
  if (s.setting === "group" && s.people < 3) errs.push("a group scene has at least 3 people");
  return errs;
}

// Wording that asks a class to move as one. The 48-ad batch's group scenes said "side by side" and
// "in time with each other" and came back as line-ups in identical poses (2026-09-12).
export const UNIFORM_WORDS = /\b(side by side|in time|in unison|in sync|synchroni[sz]ed|identical(ly)?|in a (neat )?(row|line)|each (holding|doing|performing)|all (holding|doing|performing))\b/i;

/** Not refusals: wording that makes a scene with several people come out posed. */
export function sceneWarnings(s) {
  if (!s || typeof s.scene !== "string" || !(s.people >= 2 || ["group", "coached"].includes(s.setting))) return [];
  const m = s.scene.match(UNIFORM_WORDS);
  return m ? [`"${m[0]}" asks the people to move as one — photos come out posed; describe each person at their own point of the movement`] : [];
}

export const isRetired = (s) => s?.status === "retired";
export const isDraft = (s) => s?.draft === true && !isRetired(s);
export const today = () => new Date().toISOString().slice(0, 10);

/** A gym's library before its first scene: written by the first refresh, approved by the owner's first approval. */
export const newLibrary = () => ({ schema_version: 1, approved: false, note: "Scenes for generated photos, drafted by the agent and approved by the owner (Library → Scenes). Each describes the people and what they are doing, never words to show; the layout decides where they sit.", scenes: [] });
/**
 * The library file as written: every scene, drafts and retired ones included. `create` — a gym with no
 * library yet reads as an empty one (the first refresh writes it); without it a missing library is refused.
 */
export function readLibrary(path, { create = false } = {}) {
  if (!existsSync(path)) { if (create) return newLibrary(); throw new Error(`no scene library yet (${path}): draft the first scenes on Library → Scenes and approve them`); }
  const lib = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(lib.scenes)) lib.scenes = [];
  return lib;
}
export function writeLibrary(path, lib) {
  writeFileSync(path, JSON.stringify(lib, null, 2) + "\n");
}

/**
 * The scenes a batch may generate from. Refused unless the library is approved. A scene marked
 * `"draft": true` has been added since — it is left out until the owner approves it (`allowDraft` lets
 * a dry run plan with drafts so they can be reviewed before any image is made). A retired scene is
 * never loaded.
 */
export function loadScenes(path, { allowDraft = false } = {}) {
  const lib = readLibrary(path);
  const bad = lib.scenes.flatMap((s, i) => sceneProblems(s).map((e) => `${s.id || i}: ${e}`));
  if (bad.length) throw new Error(`scene library problems:\n${bad.join("\n")}`);
  if (lib.approved !== true && !allowDraft) throw new Error(`the scene library ${path} is not approved yet — nothing is generated from it until the owner approves a scene on Library → Scenes`);
  const ids = lib.scenes.map((x) => x.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("scene library: two scenes share an id");
  return lib.scenes.filter((x) => !isRetired(x) && (allowDraft || x.draft !== true));
}

/**
 * A new gym's first scenes from another gym's library (2026-10-07: F45 Xinyi, the same format as F45 Lower Peirce,
 * had none): every live scene of the source — never a draft, never a retired one — becomes a draft in the target,
 * `source: "copied:{gym}"` with `copied_from`, for the owner to approve or reject as usual. The people's country is
 * swapped in the words (`people: { from: { name, demonym }, to: { name, demonym } }`: "Singaporean" → "Taiwanese",
 * "Singapore" → "Taiwan"); nothing else is rewritten. A scene whose id the target already has is skipped. Returns
 * { added, skipped, problems } — a copied scene that fails the library's rules is left out with the reason.
 */
export function copyScenesFrom(targetPath, sourcePath, { fromGym = null, people = null, date = today() } = {}) {
  const src = readLibrary(sourcePath);
  const live = src.scenes.filter((x) => !isRetired(x) && x.draft !== true);
  if (!live.length) throw new Error(`${fromGym || sourcePath} has no live scenes to copy`);
  const lib = readLibrary(targetPath, { create: true });
  const have = new Set(lib.scenes.map((x) => x.id));
  const swap = (text) => {
    if (!people?.from || !people?.to) return text;
    let t = String(text || "");
    if (people.from.demonym && people.to.demonym) t = t.replace(new RegExp(`\\b${people.from.demonym}\\b`, "g"), people.to.demonym);
    if (people.from.name && people.to.name) t = t.replace(new RegExp(`\\b${people.from.name}\\b`, "g"), people.to.name);
    return t;
  };
  const added = [], skipped = [], problems = [];
  for (const x of live) {
    if (have.has(x.id)) { skipped.push(x.id); continue; }
    const { approved_on, approved_via, approved_note, history, ...rest } = x;
    const s = { ...rest, scene: swap(x.scene), draft: true, source: `copied:${fromGym || "another gym"}`, copied_from: { gym: fromGym || null, id: x.id, source: x.source || null }, added: date };
    const bad = sceneProblems(s);
    if (bad.length) { problems.push(`${x.id}: ${bad.join("; ")}`); continue; }
    lib.scenes.push(s); have.add(s.id); added.push(s.id);
  }
  writeLibrary(targetPath, lib);
  return { added, skipped, problems };
}

/** One line per scene, for the drafter's "do not repeat" list and the panel. */
export function sceneSummary(s) {
  const tags = [s.audience || "any", s.setting, s.people != null ? `${s.people} ${s.people === 1 ? "person" : "people"}` : null, s.exercise, s.age, s.equipment].filter(Boolean).join(", ");
  return `${s.id} [${tags}]${isRetired(s) ? ` (retired${s.reason ? `: ${s.reason}` : ""})` : isDraft(s) ? " (draft)" : ""}: ${s.scene}`;
}

/**
 * The owner approves drafts: the draft flag goes, `approved_on` is set (and `approved_via` when the
 * approval came through a batch's run confirmation). Unknown ids are refused; an already-live scene
 * is left as it is. Returns what changed.
 */
export function approveScenes(path, ids, { via = null, date = today() } = {}) {
  const lib = readLibrary(path);
  const wanted = [ids].flat().map((s) => String(s).trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !lib.scenes.some((s) => s.id === id));
  if (unknown.length) throw new Error(`no such scene: ${unknown.join(", ")}`);
  const approved = [], already = [];
  for (const s of lib.scenes) {
    if (!wanted.includes(s.id)) continue;
    if (isRetired(s)) throw new Error(`${s.id} is retired${s.reason ? ` (${s.reason})` : ""} — a retired scene is not approved again; draft a new one`);
    if (!isDraft(s)) { already.push(s.id); continue; }
    delete s.draft;
    s.approved_on = date;
    if (via) s.approved_via = via;
    approved.push(s.id);
  }
  // The owner's first approval of a scene approves the library itself: a gym started from the panel has no
  // other way to set it (Sculpt Society's was set by hand). Nothing is generated from a draft either way.
  if (approved.length && lib.approved !== true) { lib.approved = true; lib.approved_on = date; lib.approved_note = `approved with its first scenes (${approved.join(", ")})`; }
  writeLibrary(path, lib);
  return { approved, already };
}

/**
 * The owner rejects a scene — a draft or a live one: it is retired with the reason and date and kept
 * in the file. A reason is required (the owner's rule, 2026-09-13): it is what the drafter is told
 * not to repeat, and what a later reader of the library sees.
 */
export function rejectScene(path, id, reason, { date = today() } = {}) {
  if (typeof reason !== "string" || reason.trim().length < 3) throw new Error(`rejecting ${id} needs a reason (what was wrong with it)`);
  const lib = readLibrary(path);
  const s = lib.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`no such scene: ${id}`);
  if (isRetired(s)) throw new Error(`${id} is already retired${s.reason ? ` (${s.reason})` : ""}`);
  delete s.draft;
  s.status = "retired";
  s.reason = reason.trim();
  s.retired_on = date;
  writeLibrary(path, lib);
  return { retired: id, reason: s.reason };
}

/** Counts for the panel and the CLI: live, drafts and retired, and live per audience. */
export function libraryStatus(lib) {
  const scenes = lib.scenes.filter((s) => !sceneProblems(s).length);
  const live = scenes.filter((s) => !isRetired(s) && !isDraft(s)), counts = {};
  for (const s of live) counts[s.audience || "any"] = (counts[s.audience || "any"] || 0) + 1;
  return { approved: lib.approved === true, counts, total: live.length, drafts: scenes.filter(isDraft).length, retired: scenes.filter(isRetired).length };
}
