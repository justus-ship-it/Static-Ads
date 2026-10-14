/**
 * ad-wordings.mjs — the offer wordings a gym's ads have used, kept with its profile and offered as
 * chips on the Create screen.
 *
 * The words on an ad are always the owner's: typed, or picked from the ones they typed before. The
 * owner adds, edits and deletes them; the only wording the software records on its own is one the
 * owner has just confirmed a batch with.
 *
 *   brands/{gym}/ad-wordings.json   { wordings: [{ id, text, added, last_used, uses }] }
 *
 * A gym with no file yet reads its list from its batch history (every offer it has run), so an
 * existing client starts with the wordings it already uses. It is a file of its own, not a field of
 * gym-profile.json, so saving the profile page can never drop a wording recorded meanwhile.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { validateInputs } from "./render-composites.mjs";

export const MAX_WORDINGS = 40;
const FILE = "ad-wordings.json";
const today = () => new Date().toISOString().slice(0, 10);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };

/** Why a wording cannot go on an ad — the renderer's own rules for the offer line. Empty = fine. */
export function wordingProblems(text) {
  if (typeof text !== "string" || !text.trim()) return ["a wording needs words"];
  return validateInputs({ location: "X", audience: null, offer: text }).filter((e) => e.startsWith("offer")).map((e) => e.replace(/^offer/, "the wording"));
}

/** Every offer this gym's batches have run, most recent first. */
function fromBatches(gymDir) {
  const dir = join(gymDir, "batches");
  if (!existsSync(dir)) return [];
  const seen = new Map();
  for (const id of readdirSync(dir).sort()) {
    const brief = readJson(join(dir, id, "brief.json"));
    if (!brief || typeof brief.offer !== "string" || wordingProblems(brief.offer).length) continue;
    const made = readJson(join(gymDir, "outputs", id, "batch.json"))?.made?.slice(0, 10) || null;
    const date = made || id.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
    const w = seen.get(brief.offer) || { text: brief.offer, added: date, last_used: null, uses: 0 };
    if (made) { w.uses++; if (!w.last_used || made > w.last_used) w.last_used = made; }
    if (date && (!w.added || date < w.added)) w.added = date;
    seen.set(brief.offer, w);
  }
  const taken = new Set();
  return [...seen.values()].map((w) => ({ id: idFor(w.text, taken), ...w }));
}

function idFor(text, taken) {
  const base = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "wording";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

// Most recent first: used_at / added_at are the moments (last_used / added are their days, for people to read).
const order = (list) => [...list].sort((a, b) => (b.used_at || b.added_at || b.last_used || b.added || "").localeCompare(a.used_at || a.added_at || a.last_used || a.added || "") || a.text.localeCompare(b.text));

/** The gym's wordings, most recently used first. */
export function readWordings(gymDir) {
  const f = readJson(join(gymDir, FILE));
  return order(f?.wordings || (existsSync(join(gymDir, FILE)) ? [] : fromBatches(gymDir)));
}

function write(gymDir, list) {
  const p = join(gymDir, FILE);
  writeFileSync(p + ".tmp", JSON.stringify({ wordings: order(list) }, null, 2) + "\n");
  renameSync(p + ".tmp", p);
  return order(list);
}

export function addWording(gymDir, text) {
  const bad = wordingProblems(text);
  if (bad.length) throw new Error(bad.join("; "));
  const list = readWordings(gymDir);
  const same = list.find((w) => w.text === text);
  if (same) return { wording: same, wordings: list };
  if (list.length >= MAX_WORDINGS) throw new Error(`a profile keeps up to ${MAX_WORDINGS} wordings: delete one first`);
  const wording = { id: idFor(text, new Set(list.map((w) => w.id))), text, added: today(), added_at: new Date().toISOString(), last_used: null, uses: 0 };
  return { wording, wordings: write(gymDir, [...list, wording]) };
}

export function editWording(gymDir, id, text) {
  const bad = wordingProblems(text);
  if (bad.length) throw new Error(bad.join("; "));
  const list = readWordings(gymDir);
  const w = list.find((x) => x.id === id);
  if (!w) throw new Error(`no wording ${id}`);
  if (list.some((x) => x.id !== id && x.text === text)) throw new Error("that wording is already in the list");
  w.text = text;
  return { wording: w, wordings: write(gymDir, list) };
}

export function deleteWording(gymDir, id) {
  const list = readWordings(gymDir);
  if (!list.some((w) => w.id === id)) throw new Error(`no wording ${id}`);
  return { wordings: write(gymDir, list.filter((w) => w.id !== id)) };
}

/** A batch the owner confirmed ran with this wording: it joins the list (or moves to the front). */
export function recordUse(gymDir, text) {
  if (wordingProblems(text).length) return null;
  const list = readWordings(gymDir);
  let w = list.find((x) => x.text === text);
  if (!w) {
    if (list.length >= MAX_WORDINGS) return null; // the list is full: the owner decides what goes
    w = { id: idFor(text, new Set(list.map((x) => x.id))), text, added: today(), last_used: null, uses: 0 };
    list.push(w);
  }
  w.uses = (w.uses || 0) + 1;
  w.last_used = today();
  w.used_at = new Date().toISOString();
  write(gymDir, list);
  return w;
}
