/**
 * copy-library.mjs — the central copy library, shared by every gym: the skeletons the drafter writes
 * from. Each entry is a proven copy or headline with the parts that change swapped for placeholders —
 * the gym, the offer, the area, the audience, the button, the duration — so only those change from gym
 * to gym while the structure, rhythm and voice stay.
 *
 *   library/copy-library.json   { schema: 1, entries: [{ id, kind: copy | headline, angle, text, description, note,
 *                                 placeholders, origin: { gym, ref, ad, results } | { source: "owner" }, dropped, warnings,
 *                                 added, retired: { on, reason } | null }] }
 *
 * A skeleton is made by the model from a pasted copy (`skeletonFrom`) and **verified in code**: every fragment
 * between placeholders must appear in the original, word for word and in order — the model may replace a span
 * with a placeholder or leave a line out (an award, a founder, a price), never rewrite or add. The library is
 * gitignored: the entries come from other operators' ads as well as our own, and are analysis material.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";
import { callVision } from "./check-visual.mjs";
import { ANGLES, COPY_MODEL, LIMITS, ALWAYS_NEVER, plainDashes, readCopyRefs, editCopyRef } from "./draft-copy.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** Where the library lives; `COPY_LIBRARY_DIR` points tests elsewhere. */
export const LIBRARY_DIR = resolve(process.env.COPY_LIBRARY_DIR || join(REPO_ROOT, "library"));
export const LIBRARY_FILE = "copy-library.json";
export const KINDS = ["copy", "headline"];
/** The parts that change from gym to gym, and nothing else. */
export const PLACEHOLDERS = Object.freeze({
  GYM: "the gym's name",
  OFFER: "the offer's exact words (the programme or challenge as named)",
  AREA: "the place: the town, area or neighbourhood the ad calls out",
  AUDIENCE: "who it is for, as the ad names them (women, men, ladies, mums, professionals, over-40s)",
  BUTTON: "the button's name in the call to action (Learn More, Sign up, Apply)",
  DURATION: "the offer's length in words when it stands apart from the offer's name (6 weeks, 12-week)",
});
const PH = /\{([A-Z_]+)\}/g;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "");
const idOf = (e) => "lib-" + createHash("sha256").update(`${e.kind}\n${e.text}\n${e.description || ""}`).digest("hex").slice(0, 10);

// ── the file ─────────────────────────────────────────────────────────────────
export const readLibrary = (dir = LIBRARY_DIR) => { const j = readJson(join(dir, LIBRARY_FILE)); return { schema: 1, entries: [], ...(j || {}), entries: Array.isArray(j?.entries) ? j.entries : [] }; };
const writeLibrary = (dir, data) => writeWhole(join(dir, LIBRARY_FILE), JSON.stringify(data, null, 2) + "\n");
/** The entries the drafter may use, optionally of one kind. */
export const liveEntries = (dir = LIBRARY_DIR, kind = null) => readLibrary(dir).entries.filter((e) => !e.retired && (!kind || e.kind === kind));
/** The placeholders a text uses, in order of first appearance. */
export const placeholdersIn = (text) => [...new Set([...String(text || "").matchAll(PH)].map((m) => m[1]))];

// ── validation ───────────────────────────────────────────────────────────────
const PRICE = /(\$|S\$|SGD|USD|AUD|£|€)\s?\d|\b\d+(\.\d+)?\s?(dollars|bucks)\b|\bper (week|month|session)\b/i;
/** Why an entry cannot go in the library. Empty = fine. */
export function entryProblems(e) {
  const p = [];
  if (!KINDS.includes(e.kind)) p.push(`kind is ${KINDS.join(" or ")}`);
  if (!e.text) p.push("no text");
  if (e.angle != null && !ANGLES.includes(e.angle)) p.push(`angle is one of ${ANGLES.join(", ")}`);
  for (const ph of placeholdersIn(e.text)) if (!PLACEHOLDERS[ph]) p.push(`unknown placeholder {${ph}} (${Object.keys(PLACEHOLDERS).map((k) => `{${k}}`).join(" ")})`);
  if (e.kind === "headline" && /\n/.test(e.text || "")) p.push("a headline is one line");
  if (e.kind === "headline" && (e.text || "").length > LIMITS.headline) p.push(`headline over ${LIMITS.headline} characters`);
  if (e.kind === "copy" && (e.text || "").length > LIMITS.message) p.push(`primary text over ${LIMITS.message} characters`);
  if ((e.description || "").length > LIMITS.description) p.push(`description over ${LIMITS.description} characters`);
  return p;
}
/** What the owner should know: a skeleton that still says something the standing rules forbid on an ad (it stays a skeleton; a draft from it is checked by the rules). */
export function entryWarnings(e) {
  const w = [], low = `${e.text} ${e.description || ""}`.toLowerCase();
  for (const n of ALWAYS_NEVER) if (new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(low)) w.push(`says "${n}"`);
  if (/\bfree\b/.test(low) && !w.some((x) => x.includes("free trial"))) w.push('says "free"');
  if (PRICE.test(low)) w.push("names a price");
  if (/\b(lose|drop|shed)\s+\d+\s?(kg|lbs?|pounds|kilos)\b/.test(low)) w.push("a weight-loss number");
  if (!placeholdersIn(e.text).length) w.push("no placeholders: nothing in it changes from gym to gym");
  return [...new Set(w)];
}

// ── add · edit · retire ──────────────────────────────────────────────────────
export function addEntry(dir, { kind, text, description = "", angle = null, note = "", origin = null, dropped = [], replaced = [] }) {
  const e = { kind, text: clean(text, LIMITS.message + 200), description: clean(description, LIMITS.description), angle: angle || null, note: clean(note, 300) };
  const problems = entryProblems(e); if (problems.length) throw new Error(problems.join("; "));
  const data = readLibrary(dir), id = idOf(e);
  if (data.entries.some((x) => x.id === id)) throw new Error("that skeleton is already in the library");
  const entry = { id, ...e, placeholders: placeholdersIn(e.text), warnings: entryWarnings(e), origin: origin || { source: "owner" }, dropped, replaced, added: today(), retired: null };
  data.entries.push(entry); writeLibrary(dir, data); return entry;
}
export function editEntry(dir, id, { text, description, angle, note } = {}) {
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id}`);
  const next = { ...e, text: text != null ? clean(text, LIMITS.message + 200) : e.text, description: description != null ? clean(description, LIMITS.description) : e.description, angle: angle !== undefined ? angle || null : e.angle, note: note != null ? clean(note, 300) : e.note };
  const problems = entryProblems(next); if (problems.length) throw new Error(problems.join("; "));
  Object.assign(e, next, { placeholders: placeholdersIn(next.text), warnings: entryWarnings(next), edited: new Date().toISOString() });
  writeLibrary(dir, data); return e;
}
/** Retired, never deleted: the reason is required; a draft made from it before still traces back. */
export function retireEntry(dir, id, reason) {
  if (!reason || !String(reason).trim()) throw new Error("a reason is required to retire a library entry");
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id}`);
  e.retired = { on: today(), reason: clean(reason, 300) }; writeLibrary(dir, data); return e;
}
export function restoreEntry(dir, id) {
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id}`);
  e.retired = null; writeLibrary(dir, data); return e;
}

// ── fill ─────────────────────────────────────────────────────────────────────
/**
 * A skeleton with its placeholders filled: `values` by placeholder name (GYM, OFFER, AREA, AUDIENCE, BUTTON,
 * DURATION). A placeholder with no value is an error naming it, unless listed in `leave` (an {AREA} filled per
 * ad set later). Dashes come out plain, as every ad's text does.
 */
export function fill(text, values = {}, { leave = [] } = {}) {
  const missing = placeholdersIn(text).filter((k) => !values[k] && !leave.includes(k));
  if (missing.length) throw new Error(`no value for ${missing.map((k) => `{${k}}`).join(", ")}`);
  return plainDashes(String(text).replace(PH, (m, k) => (values[k] ? String(values[k]) : m)));
}

// ── the skeleton, by the model, verified in code ─────────────────────────────
const norm = (s) => String(s || "").replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
/**
 * Does the skeleton keep to the original? Every fragment between placeholders must appear in the original,
 * word for word (quotes and spacing aside) and in order — so the model may only replace spans with placeholders
 * or leave lines out. Returns { ok, why, dropped }: what the original had that the skeleton left out, by line.
 */
export function verifySkeleton(original, skeleton) {
  const o = norm(original), s = norm(skeleton);
  if (!placeholdersIn(s).length && s !== o) return { ok: false, why: "no placeholders and the text was changed", dropped: [] };
  // The original's lines with their spans; a line no fragment lands on was left out.
  const lines = []; let pos = 0;
  for (const line of o.split("\n")) { lines.push({ text: line.trim(), from: pos, to: pos + line.length, hit: false }); pos += line.length + 1; }
  let at = 0;
  for (const frag of s.split(/\{[A-Z_]+\}/).map((f) => f.trim()).filter(Boolean)) {
    // A fragment may span lines; match it piece by piece so a dropped line inside it still counts as a drop, not a rewrite.
    for (const piece of frag.split("\n").map((x) => x.trim()).filter(Boolean)) {
      const i = o.indexOf(piece, at);
      if (i < 0) return { ok: false, why: `rewritten: "${piece.slice(0, 80)}" is not in the original after what came before it`, dropped: [] };
      for (const l of lines) if (l.from < i + piece.length && l.to > i) l.hit = true;
      at = i + piece.length;
    }
  }
  return { ok: true, why: null, dropped: lines.filter((l) => l.text && !l.hit).map((l) => l.text) };
}
const SKELETON_SCHEMA = { type: "OBJECT", properties: { skeleton: { type: "STRING" }, angle: { type: "STRING", enum: ANGLES }, note: { type: "STRING" }, replaced: { type: "ARRAY", items: { type: "OBJECT", properties: { placeholder: { type: "STRING" }, was: { type: "STRING" } }, required: ["placeholder", "was"] } } }, required: ["skeleton", "angle", "note", "replaced"] };
export function buildSkeletonPrompt({ text, kind }) {
  return [
    `Turn this gym ad ${kind === "headline" ? "headline" : "primary text"} into a reusable skeleton for other gyms. The words stay; only the parts that belong to this one gym become placeholders.`,
    `TEXT:\n${text}`,
    `REPLACE ONLY THESE SPANS, with exactly these placeholders:\n${Object.entries(PLACEHOLDERS).map(([k, v]) => `{${k}} = ${v}`).join("\n")}`,
    `LEAVE OUT a line that only this gym can claim: an award, a founder or a person's name, a press mention, a price, a number of spots, a specific weight or number of kilos or pounds. Leave the line out whole; do not reword it.`,
    `EVERYTHING ELSE STAYS WORD FOR WORD: the same lines in the same order, the same punctuation, emoji and line breaks. Never rewrite a sentence, never add one, never change a word that is not inside a placeholder.`,
    `Also give the angle (one of ${ANGLES.join(", ")}) the opening leans on, a note of at most two short sentences on why the copy works (the hook, how it is built, the promise, how it asks for the click; name no brand or person), and the list of what each placeholder replaced.`,
  ].join("\n\n");
}
/** The model's skeleton of a pasted text, verified; refused with the reason when it rewrote anything. One text call. */
export async function skeletonFrom({ text, kind = "copy", ask = callVision, model = COPY_MODEL }) {
  if (!text || !String(text).trim()) throw new Error("nothing to make a skeleton from");
  const a = await ask(null, buildSkeletonPrompt({ text, kind }), SKELETON_SCHEMA, { model });
  const skeleton = clean(a?.skeleton, LIMITS.message + 400);
  const v = verifySkeleton(text, skeleton);
  if (!v.ok) throw new Error(`the model's skeleton was not the copy with placeholders (${v.why})`);
  const bad = placeholdersIn(skeleton).filter((k) => !PLACEHOLDERS[k]);
  if (bad.length) throw new Error(`the model used a placeholder that does not exist: ${bad.map((k) => `{${k}}`).join(", ")}`);
  const replaced = (Array.isArray(a?.replaced) ? a.replaced : []).map((r) => ({ placeholder: String(r.placeholder || "").replace(/[{}]/g, ""), was: clean(r.was, 120) })).filter((r) => PLACEHOLDERS[r.placeholder] && r.was);
  return { text: skeleton, angle: ANGLES.includes(a?.angle) ? a.angle : null, note: clean(plainDashes(a?.note), 300), dropped: v.dropped, replaced };
}
/**
 * A gym's reference (its copy-references.json) into the library: its primary text as a copy skeleton and its
 * headline as a headline skeleton (one call each), with where it came from; the reference remembers its
 * library ids. A part already in the library is not added twice.
 */
export async function sendToLibrary(gymDir, refId, { dir = LIBRARY_DIR, ask = callVision, model = COPY_MODEL, gym = null, log = () => {} } = {}) {
  const ref = readCopyRefs(gymDir).refs.find((r) => r.id === refId);
  if (!ref) throw new Error(`no reference ${refId}`);
  const origin = { gym, ref: ref.id, ad: ref.ad || null, source: ref.source, results: ref.results || null };
  const out = { entries: [], skipped: [] };
  for (const [kind, text] of [["copy", ref.message], ["headline", ref.headline]]) {
    if (!text || !String(text).trim()) continue;
    try {
      const sk = await skeletonFrom({ text, kind, ask, model });
      const angle = kind === "copy" && ref.angle ? ref.angle : sk.angle, note = kind === "copy" && ref.note ? ref.note : sk.note;
      out.entries.push(addEntry(dir, { kind, text: sk.text, angle, note, origin, dropped: sk.dropped, replaced: sk.replaced }));
      log(`  ${kind}: ${sk.text.split("\n")[0].slice(0, 70)}${sk.dropped.length ? ` (${sk.dropped.length} line(s) left out)` : ""}`);
    } catch (e) { out.skipped.push({ kind, why: e.message }); log(`  ${kind}: skipped (${e.message})`); }
  }
  if (out.entries.length) editCopyRef(gymDir, ref.id, { in_library: [...new Set([...(ref.in_library || []), ...out.entries.map((e) => e.id)])] });
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: {
    list: { type: "boolean", default: false }, kind: { type: "string" }, gym: { type: "string" }, "brand-dir": { type: "string" }, ref: { type: "string" }, "all-owner": { type: "boolean", default: false },
    retire: { type: "string" }, restore: { type: "string" }, reason: { type: "string" },
    fill: { type: "string" }, offer: { type: "string" }, area: { type: "string" }, audience: { type: "string" }, button: { type: "string", default: "Sign up" }, duration: { type: "string" },
  } });
  const gymDir = v["brand-dir"] || (v.gym ? join(REPO_ROOT, "brands", v.gym) : null);
  try {
    if (v.list) {
      const es = liveEntries(LIBRARY_DIR, v.kind || null);
      console.log(`${es.length} live ${v.kind || "entries"} in ${join(LIBRARY_DIR, LIBRARY_FILE)} (${readLibrary().entries.filter((e) => e.retired).length} retired)`);
      for (const e of es) console.log(`\n[${e.id}] ${e.kind} · ${e.angle || "no angle"} · {${e.placeholders.join("} {")}}${e.warnings.length ? ` · ⚠ ${e.warnings.join("; ")}` : ""}\n  ${e.text.split("\n").join("\n  ")}\n  note: ${e.note}`);
    } else if (v.ref || v["all-owner"]) {
      if (!gymDir) throw new Error("--gym or --brand-dir is needed");
      const ids = v.ref ? [v.ref] : readCopyRefs(gymDir).refs.filter((r) => r.source === "owner" && !r.retired && !(r.in_library || []).length).map((r) => r.id);
      let made = 0, skipped = 0;
      for (const id of ids) { console.log(`reference ${id}`); const r = await sendToLibrary(gymDir, id, { gym: v.gym || null, log: console.log }); made += r.entries.length; skipped += r.skipped.length; }
      console.log(`\n${made} entries added, ${skipped} skipped, from ${ids.length} reference(s)`);
    } else if (v.retire) { const e = retireEntry(LIBRARY_DIR, v.retire, v.reason); console.log(`retired ${e.id}: ${e.retired.reason}`); }
    else if (v.restore) { const e = restoreEntry(LIBRARY_DIR, v.restore); console.log(`restored ${e.id}`); }
    else if (v.fill) {
      const e = readLibrary().entries.find((x) => x.id === v.fill); if (!e) throw new Error(`no entry ${v.fill}`);
      const profile = gymDir ? readJson(join(gymDir, "gym-profile.json")) : null;
      console.log(fill(e.text, { GYM: profile?.display_name || v.gym, OFFER: v.offer, AREA: v.area, AUDIENCE: v.audience, BUTTON: v.button, DURATION: v.duration }));
    } else { console.error("Usage: copy-library.mjs --list [--kind copy|headline] | --gym x (--ref id | --all-owner) | --retire id --reason '…' | --restore id | --fill id --gym x --offer '…' [--area X --audience Y --button Z --duration '12 weeks']"); process.exit(1); }
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
}
