/**
 * draft-copy.mjs — the words beside an ad: primary text, headline, description. Drafted by the text
 * model from the owner's references (the gym's best past ads and anything pasted), the offer's exact
 * words, the audience and the locations; kept or excluded by the owner; the kept ones ride with the
 * creatives as Meta text options (up to five per ad).
 *
 *   brands/{gym}/copy-references.json     { refs: [{ id, source: account | owner, message, headline, note, results, retired }] }
 *   outputs/{batch}/copy.json             { drafted, drafts: [{ id, message, headline, description, source: agent | owner, status: draft | keep | exclude, edited }] }
 *
 * Rules in code, never left to the model: the offer's words appear exactly; nothing from the gym's
 * never-list or the offer's must-not-say; no free trial, no price, no before/after; no em or en dashes;
 * Meta's lengths. A draft that breaks one is dropped with the reason.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";
import { readCopyRefs } from "./meta-results.mjs";

export const COPY_MODEL = process.env.COPY_MODEL || CHECK_MODEL;
export const LIMITS = { message: 2000, headline: 255, description: 255, headline_ideal: 40, description_ideal: 30 };
export const MAX_OPTIONS = 5;
export const MIN_REF_LEADS = 5;
const COPY_FILE = "copy.json", REFS_FILE = "copy-references.json";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "");
/** An em or en dash pasted or written by the model becomes a plain hyphen (the ads' rule), never a refusal. */
export const plainDashes = (v) => (typeof v === "string" ? v.replace(/\s*—\s*/g, " - ").replace(/–/g, "-").replace(/[ \t]{2,}/g, " ") : v);
/**
 * Every way a copy names the button, made one placeholder — the owner's rule (2026-09-18): the words must match
 * the call to action chosen for the ad, so the copy says {BUTTON} and the plan fills it from that choice.
 */
const BUTTON_NAMES = ["learn more", "sign up", "signup", "apply now", "apply", "book now", "get offer", "contact us", "send message", "get started", "get quote", "subscribe"];
const NAME_RE = BUTTON_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|");
const BUTTON_RE = new RegExp(`(\\b(?:tap|click|hit|press|smash)\\s+(?:on\\s+)?(?:the\\s+)?)(?:["“”'‘’]\\s*)?(?:${NAME_RE})(?:\\s*["“”'‘’])?(\\s+button)?`, "gi");
const QUOTED_RE = new RegExp(`["“”]\\s*(?:${NAME_RE})\\s*["“”](\\s+button)?`, "gi");
export const buttonPlaceholder = (v) => (typeof v === "string" ? v.replace(/\{BUTTON\}/g, "{BUTTON}").replace(BUTTON_RE, (m, lead) => `${lead}{BUTTON}`).replace(QUOTED_RE, "{BUTTON}") : v);
/** {BUTTON} as the chosen call to action's name; any other placeholder stays as it is. */
export const fillButton = (v, label) => (typeof v === "string" && label ? v.replace(/\{BUTTON\}/g, label) : v);
const idOf = (d) => createHash("sha256").update(`${d.message}\n${d.headline}\n${d.description}`).digest("hex").slice(0, 10);

// ── the rules ────────────────────────────────────────────────────────────────
/** Always, whatever the profile says: the owner's standing rules for every gym. */
export const ALWAYS_NEVER = ["free trial", "trial", "before and after", "before & after", "before/after", "guaranteed", "guarantee"];
/** What copy may not say for this gym and this offer: the voice's never-list, the offer's must-not-say, the standing rules. */
export function copyRules(profile, offerDoc = null) {
  const never = [...new Set([...ALWAYS_NEVER, ...(profile?.brand_lock?.voice?.never || []), ...(offerDoc?.messaging?.must_not_say || [])].map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  return { never, adjectives: profile?.brand_lock?.voice?.adjectives || [], must_say: offerDoc?.messaging?.must_say || [] };
}
const PRICE = /(\$|S\$|SGD|USD)\s?\d|\b\d+(\.\d+)?\s?(dollars|bucks)\b|\bper (week|month|session)\b/i;
/** Why a draft cannot go on an ad. Empty = fine. */
export function copyProblems(d, { offer, rules }) {
  const e = [], all = `${d.message} ${d.headline} ${d.description}`;
  if (!d.message) e.push("no primary text"); if (!d.headline) e.push("no headline");
  if (d.message.length > LIMITS.message) e.push(`primary text over ${LIMITS.message} characters`);
  if (d.headline.length > LIMITS.headline) e.push(`headline over ${LIMITS.headline} characters`);
  if (d.description.length > LIMITS.description) e.push(`description over ${LIMITS.description} characters`);
  if (/[–—]/.test(all)) e.push("an em or en dash (use a plain hyphen)");
  if (offer && !all.toLowerCase().includes(String(offer).toLowerCase())) e.push(`the offer "${offer}" is not named exactly`);
  if (PRICE.test(all)) e.push("a price");
  const low = all.toLowerCase();
  for (const n of rules.never) { const re = new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i"); if (re.test(low)) e.push(`says "${n}"`); }
  if (/\b(lose|drop|shed)\s+\d+\s?(kg|lbs?|pounds|kilos)\b/i.test(all)) e.push("a weight-loss number");
  return e;
}
/** Two drafts that read the same (after case and punctuation) count once. */
const shape = (d) => `${d.headline} ${d.message}`.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

// ── the references ───────────────────────────────────────────────────────────
export { readCopyRefs };
export const liveRefs = (gymDir) => readCopyRefs(gymDir).refs.filter((r) => !r.retired);
/** The references worth showing the model: the owner's, then the account's best by cost per lead (home country only), up to `max`. */
export function referencesFor(gymDir, { max = 10 } = {}) {
  const refs = liveRefs(gymDir).filter((r) => r.message || r.headline);
  const owner = refs.filter((r) => r.source === "owner");
  // The account's: home country only, with leads, and with a primary text worth learning from (a headline alone teaches little).
  // The account's: home country only, at least ${MIN_REF_LEADS} leads, a primary text worth learning from (a headline alone
  // teaches little), and nothing the rules forbid (a "free trial" reference would contradict the never-list the model is given).
  const banned = (r) => ALWAYS_NEVER.some((n) => `${r.headline || ""} ${r.message || ""}`.toLowerCase().includes(n));
  const account = refs.filter((r) => r.source !== "owner" && !r.results?.abroad && (r.results?.leads || 0) >= MIN_REF_LEADS && (r.message || "").trim().length >= 40 && !banned(r)).sort((a, b) => (a.results.cost_per_lead ?? Infinity) - (b.results.cost_per_lead ?? Infinity));
  // Two references with the same primary text are one (their headlines often differ only by area).
  const seen = new Set(), out = [];
  for (const r of [...owner, ...account]) { const k = shape(r.message ? { headline: "", message: r.message } : { headline: r.headline || "", message: "" }); if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= max) break; }
  return out;
}
export function addCopyRef(gymDir, { message, headline, description = "", note = "", angle = null }) {
  const d = { message: clean(message, LIMITS.message), headline: clean(headline, LIMITS.headline), description: clean(description, LIMITS.description) };
  if (!d.message && !d.headline) throw new Error("a reference needs a primary text or a headline");
  const data = readCopyRefs(gymDir);
  const ref = { id: `own-${idOf(d)}`, source: "owner", ...d, angle: ANGLES.includes(angle) ? angle : null, note: clean(note, 300), added: today(), retired: null };
  if (data.refs.some((r) => r.id === ref.id)) throw new Error("that reference is already here");
  data.refs.push(ref); writeWhole(join(gymDir, REFS_FILE), JSON.stringify(data, null, 2) + "\n"); return ref;
}
export function editCopyRef(gymDir, id, { note, retired, angle, in_library }) {
  const data = readCopyRefs(gymDir), r = data.refs.find((x) => x.id === id);
  if (!r) throw new Error(`no reference ${id}`);
  if (note != null) r.note = clean(note, 300);
  if (angle !== undefined) r.angle = ANGLES.includes(angle) ? angle : null;
  if (Array.isArray(in_library)) r.in_library = in_library.map(String);
  if (retired != null) r.retired = retired ? { on: today() } : null;
  writeWhole(join(gymDir, REFS_FILE), JSON.stringify(data, null, 2) + "\n"); return r;
}

// ── what a copy does: the model's reading of a pasted reference ──────────────
/** The angles a copy can take (the owner's vocabulary, 2026-09-18); a draft and a library entry carry one. */
export const ANGLES = ["call-out", "pain", "benefits", "structure", "identity", "community", "time-poor", "beginner", "curiosity", "coach-led"];
const ANALYSIS_SCHEMA = { type: "OBJECT", properties: { angle: { type: "STRING", enum: ANGLES }, note: { type: "STRING" } }, required: ["angle", "note"] };
/**
 * Read a copy the owner pasted and say why it works: its angle (one of ANGLES) and a note on the hook, the
 * structure, the promise and the call to action, in at most two sentences. One text call. The note is the
 * owner's to edit afterwards.
 */
export async function analyseCopy({ message = "", headline = "", ask = callVision, model = COPY_MODEL } = {}) {
  if (!message && !headline) throw new Error("nothing to analyse");
  const prompt = [
    "You analyse Meta lead ads for gyms. Read this ad copy and say what makes it work, for someone who will reuse its structure for other gyms.",
    `HEADLINE: ${headline || "(none)"}`, `PRIMARY TEXT: ${message || "(none)"}`,
    `ANGLE: pick one of ${ANGLES.join(", ")} - the one the opening leans on most (call-out = it names who it is for or where they are; pain = what is not working; benefits = what they get; structure = the plan and its steps; identity = who they want to be; community = training with others; time-poor = fits a busy life; beginner = new to training; curiosity = a question or a gap; coach-led = the coach's guidance).`,
    "NOTE: at most two short sentences, plain words: the hook, how the text is built (lines, lists, contrasts), the promise, and how it asks for the click. Name no brand, no person and no price. No em or en dashes.",
  ].join("\n\n");
  const a = await ask(null, prompt, ANALYSIS_SCHEMA, { model });
  return { angle: ANGLES.includes(a?.angle) ? a.angle : null, note: clean(plainDashes(a?.note), 300) };
}

// ── the drafter ──────────────────────────────────────────────────────────────
const SCHEMA = { type: "OBJECT", properties: { drafts: { type: "ARRAY", items: { type: "OBJECT", properties: { message: { type: "STRING" }, headline: { type: "STRING" }, description: { type: "STRING" }, angle: { type: "STRING" } }, required: ["message", "headline", "description"] } } }, required: ["drafts"] };
/** The request: the gym, the offer's exact words, the audience and locations, the rules, the references, the shape wanted. */
export function buildCopyPrompt({ profile, offer, audience, locations, rules, refs, count, avoid = [], button = "Sign up" }) {
  const gym = profile.display_name || "the gym";
  const lines = [
    `You write Meta lead ads for ${gym}, a gym in Singapore. Write ${count} different primary text + headline + description sets for one campaign.`,
    `THE OFFER: "${offer}". Name it exactly like that, in the headline or the primary text of every set. Never invent what it includes, its price, its length beyond the name, or any guarantee.`,
    audience ? `WHO IT IS FOR: the ad says "${audience}". Speak to them.` : `WHO IT IS FOR: everyone near the gym.`,
    locations?.length ? `WHERE: ${locations.join(", ")} (the ads name these areas; you may address the reader by area, as in "Ladies in Bishan").` : "",
    `VOICE: ${rules.adjectives.length ? rules.adjectives.join(", ") : "direct, warm, confident"}. Plain Singapore English. Short lines. No hype.`,
    `NEVER write any of these words or ideas: ${rules.never.join("; ")}. No prices. No before-and-after claims. No weight-loss numbers. No em dashes or en dashes; use a plain hyphen. No emoji in headlines.`,
    rules.must_say.length ? `ALWAYS work in: ${rules.must_say.join("; ")}.` : "",
    refs.length ? `REFERENCES - copy that worked for this gym before (its structure, rhythm and angles are the model; do not copy sentences):\n${refs.map((r, i) => `${i + 1}. HEADLINE: ${r.headline || "(none)"}\n   PRIMARY TEXT: ${(r.message || "(none)").replace(/\n+/g, " / ").slice(0, 700)}${r.results?.cost_per_lead != null ? `\n   (${r.results.leads} leads at ${r.results.cost_per_lead} each)` : ""}${r.note ? `\n   NOTE: ${r.note}` : ""}`).join("\n")}` : "",
    avoid.length ? `ALREADY WRITTEN (do not repeat these angles): ${avoid.map((a) => a.headline).join(" | ")}` : "",
    `SHAPE: primary text 60-160 words, opening with a hook (a question, a pain, an identity call-out) before the offer; a call to action that tells the reader to tap the button, written as the placeholder {BUTTON} (the ad's button is "${button}": phrase the call to action to fit it, never write another button's name). Headline under ${LIMITS.headline_ideal} characters, the offer or the promise. Description under ${LIMITS.description_ideal} characters, or empty. Vary the angle across the ${count} sets (pain, curiosity, identity, structure, coach-led, community, time-poor, beginner) and say the angle in one word.`,
  ].filter(Boolean);
  return { prompt: lines.join("\n\n"), schema: SCHEMA };
}
// Drafts written before the placeholder rule name a button literally: read as {BUTTON} (ids unchanged, the file untouched).
export const readCopy = (batchDir) => { const j = readJson(join(batchDir, COPY_FILE)); return { drafted: null, drafts: [], ...(j || {}), drafts: (Array.isArray(j?.drafts) ? j.drafts : []).map((d) => ({ ...d, message: buttonPlaceholder(d.message), headline: buttonPlaceholder(d.headline), description: buttonPlaceholder(d.description) })) }; };
const writeCopy = (batchDir, data) => writeWhole(join(batchDir, COPY_FILE), JSON.stringify(data, null, 2) + "\n");
/** The kept copies, in the order they were kept (the owner's order of choice). */
export const keptCopies = (batchDir) => readCopy(batchDir).drafts.filter((d) => d.status === "keep").sort((a, b) => (a.kept_at || "").localeCompare(b.kept_at || ""));
/**
 * Draft `count` copies for a batch and append them to its copy.json as drafts. One text call (a second
 * for a shortfall). Drafts that break a rule are dropped and the reason returned; duplicates of what is
 * already there are dropped too. `ask` is the model call (callVision's shape).
 */
export async function draftCopy({ brandDir, batchDir, offer, audience = null, locations = [], count = 10, button = "Sign up", ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (!offer) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("count must be 1 to 20");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {};
  const offerDoc = offerDocFor(brandDir, offer);
  const rules = copyRules(profile, offerDoc), refs = referencesFor(brandDir);
  const data = readCopy(batchDir);
  const have = new Set(data.drafts.map(shape)), dropped = [], added = [];
  let calls = 0;
  for (let round = 0; round < 2 && added.length < count; round++) {
    const want = count - added.length;
    const { prompt, schema } = buildCopyPrompt({ profile, offer, audience, locations, rules, refs, count: want, avoid: [...data.drafts, ...added], button });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    for (const raw of answer?.drafts || []) {
      const d = { message: clean(buttonPlaceholder(plainDashes(raw.message)), LIMITS.message + 200), headline: clean(buttonPlaceholder(plainDashes(raw.headline)), LIMITS.headline + 50), description: clean(buttonPlaceholder(plainDashes(raw.description)), LIMITS.description + 50) };
      const problems = copyProblems(d, { offer, rules });
      if (problems.length) { dropped.push({ headline: d.headline.slice(0, 60), why: problems.join("; ") }); continue; }
      const k = shape(d); if (have.has(k)) { dropped.push({ headline: d.headline.slice(0, 60), why: "reads like one already here" }); continue; }
      have.add(k);
      const draft = { id: `c-${idOf(d)}`, ...d, angle: clean(raw.angle, 30) || null, source: "agent", status: "draft", drafted: new Date().toISOString(), edited: null };
      added.push(draft); data.drafts.push(draft);
      if (added.length >= count) break;
    }
    log(`  copy: ${added.length} kept of the model's ${answer?.drafts?.length || 0}${dropped.length ? `, ${dropped.length} dropped` : ""} (round ${round + 1})`);
  }
  data.drafted = new Date().toISOString(); data.offer = offer; data.audience = audience; data.locations = locations;
  writeCopy(batchDir, data);
  return { added, dropped, calls, refs: refs.length, total: data.drafts.length };
}
/** The offer file whose name is the offer's exact words, if the gym has one (its must-not-say joins the rules). */
export function offerDocFor(brandDir, offer) {
  const dir = join(brandDir, "offers"); if (!existsSync(dir) || !offer) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) { const o = readJson(join(dir, f)); if (o?.name && String(o.name).toLowerCase() === String(offer).toLowerCase()) return o; }
  return null;
}
/** The owner's own copy for a batch: checked by the same rules (the offer named exactly), kept at once. */
export function addCopy(batchDir, { message, headline, description = "" }, { offer, profile = {}, offerDoc = null } = {}) {
  const d = { message: clean(buttonPlaceholder(plainDashes(message)), LIMITS.message), headline: clean(buttonPlaceholder(plainDashes(headline)), LIMITS.headline), description: clean(buttonPlaceholder(plainDashes(description)), LIMITS.description) };
  const problems = copyProblems(d, { offer, rules: copyRules(profile, offerDoc) });
  if (problems.length) throw new Error(problems.join("; "));
  const data = readCopy(batchDir);
  const k = shape(d); if (data.drafts.some((x) => shape(x) === k)) throw new Error("that copy is already here");
  const draft = { id: `c-${idOf(d)}`, ...d, angle: null, source: "owner", status: "keep", kept_at: new Date().toISOString(), drafted: new Date().toISOString(), edited: null };
  data.drafts.push(draft); writeCopy(batchDir, data); return draft;
}
/** Keep, exclude or put back to draft; edits go through the same rules. */
export function decideCopy(batchDir, id, { status, message, headline, description } = {}, { offer, profile = {}, offerDoc = null } = {}) {
  const data = readCopy(batchDir), d = data.drafts.find((x) => x.id === id);
  if (!d) throw new Error(`no copy ${id}`);
  if (message != null || headline != null || description != null) {
    const next = { message: message != null ? clean(buttonPlaceholder(plainDashes(message)), LIMITS.message) : d.message, headline: headline != null ? clean(buttonPlaceholder(plainDashes(headline)), LIMITS.headline) : d.headline, description: description != null ? clean(buttonPlaceholder(plainDashes(description)), LIMITS.description) : d.description };
    const problems = copyProblems(next, { offer, rules: copyRules(profile, offerDoc) });
    if (problems.length) throw new Error(problems.join("; "));
    Object.assign(d, next, { edited: new Date().toISOString() });
  }
  if (status != null) {
    if (!["draft", "keep", "exclude"].includes(status)) throw new Error("a decision is keep, exclude or draft");
    if (status === "keep" && data.drafts.filter((x) => x.status === "keep" && x.id !== id).length >= 20) throw new Error("no more than 20 kept copies for one campaign");
    d.status = status; d.kept_at = status === "keep" ? d.kept_at || new Date().toISOString() : null;
  }
  writeCopy(batchDir, data); return d;
}
/** The text options each ad carries: the kept copies, `n` per ad; more kept than `n` → they rotate across the ads so every copy runs. */
export function textOptionsFor(kept, n, adIndex) {
  const count = Math.max(1, Math.min(MAX_OPTIONS, n | 0));
  if (!kept.length) return [];
  if (kept.length <= count) return kept;
  const start = (adIndex * count) % kept.length;
  return Array.from({ length: count }, (_, i) => kept[(start + i) % kept.length]);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, "brand-dir": { type: "string" }, batch: { type: "string" }, count: { type: "string", default: "10" }, list: { type: "boolean", default: false } } });
  if (!v.gym || !v.batch) { console.error("Usage: draft-copy.mjs --gym <slug> --batch <id> [--count 10] [--list] [--brand-dir <dir>]"); process.exit(1); }
  try {
    const brandDir = v["brand-dir"] ? resolve(v["brand-dir"]) : join(REPO_ROOT, "brands", v.gym), batchDir = join(brandDir, "outputs", v.batch);
    const brief = readJson(join(brandDir, "batches", v.batch, "brief.json")) || readJson(join(batchDir, "brief.json"));
    if (!brief) throw new Error(`no brief for batch ${v.batch}`);
    if (!v.list) {
      const r = await draftCopy({ brandDir, batchDir, offer: brief.offer, audience: brief.audience || null, locations: brief.locations || [], count: parseInt(v.count, 10), log: console.log });
      console.log(`drafted ${r.added.length} (${r.calls} call${r.calls === 1 ? "" : "s"}, ${r.refs} references shown); ${r.total} in copy.json${r.dropped.length ? `\ndropped: ${r.dropped.map((d) => `"${d.headline}" (${d.why})`).join("; ")}` : ""}`);
    }
    for (const d of readCopy(batchDir).drafts) console.log(`\n[${d.status}${d.angle ? ` · ${d.angle}` : ""}] ${d.id}\n  HEADLINE: ${d.headline}\n  ${d.message.replace(/\n/g, "\n  ")}${d.description ? `\n  DESCRIPTION: ${d.description}` : ""}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
