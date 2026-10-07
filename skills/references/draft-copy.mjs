/**
 * draft-copy.mjs — the words beside an ad: primary texts (copy) and headlines, two lists. Drafted by the
 * text model from the central copy library's skeletons (never a gym's own past ads), the offer's exact
 * words, the audience and the areas; judged for clarity and the top five recommended (one per angle
 * first); kept or excluded by the owner; the kept ones ride with the creatives as Meta text options
 * (up to five bodies and five titles per ad; {AREA} filled per ad set, {BUTTON} from the call to action).
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
import { countryRules } from "./client-config.mjs";
import { readCopyRefs } from "./meta-results.mjs";

export const COPY_MODEL = process.env.COPY_MODEL || CHECK_MODEL;
export const LIMITS = { message: 2000, headline: 255, description: 255, headline_ideal: 40, description_ideal: 30 };
export const MAX_OPTIONS = 5;
export const MIN_REF_LEADS = 5;
const COPY_FILE = "copy.json", REFS_FILE = "copy-references.json";
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const today = () => new Date().toISOString().slice(0, 10);
const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max) : "");
/** An em or en dash pasted or written by the model becomes a plain hyphen (the ads' rule), never a refusal. */
// ── language ─────────────────────────────────────────────────────────────────
/** A Chinese, Japanese or Korean character (the renderer's hasCJK; kept here so this module never imports the renderer). */
export const isCJK = (s) => /[\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(String(s ?? ""));
/** The language a text is written in, for the library: "zh" when it carries CJK characters, else "en". */
export const languageOf = (text) => (isCJK(text) ? "zh" : "en");
/** The language a gym's ads are written in: its Meta locale (zh_TW → "zh"), else its country's (TW → zh), else English. F45 Xinyi, 2026-10-07. */
export function gymLanguage(profile) {
  const l = String(profile?.locale?.languages?.[0] || "").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l) return "en";
  return (countryRules(profile?.locale?.country).languages[0] || "en").startsWith("zh") ? "zh" : "en";
}
export const LANGUAGE_NAMES = { en: "English", zh: "Traditional Chinese (Taiwan)" };
/** The button's name as the copy of each language says it; Meta shows the button in the viewer's language, the copy must match. */
export const CTA_LABELS = { en: { SIGN_UP: "Sign up", APPLY_NOW: "Apply now", LEARN_MORE: "Learn more", GET_OFFER: "Get offer", BOOK_NOW: "Book now", CONTACT_US: "Contact us" }, zh: { SIGN_UP: "立即報名", APPLY_NOW: "立即申請", LEARN_MORE: "了解更多", GET_OFFER: "取得優惠", BOOK_NOW: "立即預約", CONTACT_US: "聯絡我們" } };
export const ctaLabel = (key, language = "en") => CTA_LABELS[language]?.[key] || CTA_LABELS.en[key] || CTA_LABELS.en.SIGN_UP;
/** An em dash inside Chinese becomes a Chinese comma (their copies write "——" as a pause); elsewhere a hyphen, as before. */
export const plainDashes = (v) => (typeof v === "string" ? v.replace(/([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])\s*[—–]+\s*(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef（「『])/g, "$1，").replace(/\s*—+\s*/g, " - ").replace(/–/g, "-").replace(/[ \t]{2,}/g, " ") : v);
/**
 * Every way a copy names the button, made one placeholder — the owner's rule (2026-09-18): the words must match
 * the call to action chosen for the ad, so the copy says {BUTTON} and the plan fills it from that choice.
 */
const BUTTON_NAMES = ["learn more", "sign up", "signup", "apply now", "apply", "book now", "get offer", "contact us", "send message", "get started", "get quote", "subscribe"];
const NAME_RE = BUTTON_NAMES.map((n) => n.replace(/ /g, "\\s+")).join("|");
const BUTTON_RE = new RegExp(`(\\b(?:tap|click|hit|press|smash)\\s+(?:on\\s+)?(?:the\\s+)?)(?:["“”'‘’]\\s*)?(?:${NAME_RE})(?:\\s*["“”'‘’])?(\\s+button)?`, "gi");
const QUOTED_RE = new RegExp(`["“”]\\s*(?:${NAME_RE})\\s*["“”](\\s+button)?`, "gi");
// Chinese: 點擊「立即報名」 / 按下立即報名按鈕 / 「了解更多」 alone — every way of naming Meta's buttons in zh-TW.
const BUTTON_NAMES_ZH = ["立即報名", "馬上報名", "立即申請", "了解更多", "取得優惠", "立即預約", "聯絡我們", "立即開始", "免費報名", "報名"];
const NAME_RE_ZH = BUTTON_NAMES_ZH.join("|");
const BUTTON_RE_ZH = new RegExp(`((?:點擊|點選|按下|按一下|點一下|點)\\s*)(?:[「『"“]\\s*)?(?:${NAME_RE_ZH})(?:\\s*[」』"”])?(?:\\s*(?:按鈕|鍵))?`, "g");
const QUOTED_RE_ZH = new RegExp(`[「『]\\s*(?:${NAME_RE_ZH})\\s*[」』](?:\\s*(?:按鈕|鍵))?`, "g");
export const buttonPlaceholder = (v) => (typeof v === "string" ? v.replace(/\{BUTTON\}/g, "{BUTTON}").replace(BUTTON_RE, (m, lead) => `${lead}{BUTTON}`).replace(QUOTED_RE, "{BUTTON}").replace(BUTTON_RE_ZH, (m, lead) => `${lead}{BUTTON}`).replace(QUOTED_RE_ZH, "{BUTTON}") : v);
/**
 * A draft that names exactly one of the batch's areas (whatever the prompt said) gets {AREA} in its place, so the
 * plan can fill each ad set's own area; a draft naming several areas addresses the whole campaign and is left alone.
 */
export function areaPlaceholder(v, locations = []) {
  if (typeof v !== "string" || !v || !locations?.length) return v;
  const named = locations.filter((l) => l && new RegExp(`(^|[^a-z])${String(l).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(v));
  if (named.length !== 1) return v;
  return v.replace(new RegExp(`(^|[^a-z])(${String(named[0]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([^a-z]|$)`, "gi"), "$1{AREA}$3");
}
// ── line breaks ───────────────────────────────────────────────────────────────
/** A primary text that came as one block: long, and not a single line break in it. */
export const needsLayout = (message) => typeof message === "string" && message.length >= (isCJK(message) ? 60 : 220) && !message.includes("\n");
const squash = (t) => String(t || "").replace(/\s+/g, "");
/** Line breaks by rule, when the model's cannot be used: the opening sentence alone, then two sentences a
 *  paragraph. Only the spaces between sentences change. */
export function breakBySentence(text) {
  // Chinese sentences end in 。！？ with no space after them, so they split there too and rejoin without one.
  const cjk = isCJK(text), joiner = cjk ? "" : " ";
  const parts = String(text || "").trim().split(cjk ? /(?<=[.!?…。！？])\s*(?=[^\s.!?…。！？])/ : /(?<=[.!?…])\s+(?=\S)/).filter(Boolean);
  if (parts.length < 3) return String(text || "").trim();
  const paras = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) paras.push(parts.slice(i, i + 2).join(joiner));
  return paras.join("\n\n");
}
const LAYOUT_SCHEMA = { type: "OBJECT", properties: { texts: { type: "ARRAY", items: { type: "OBJECT", properties: { index: { type: "INTEGER" }, text: { type: "STRING" } }, required: ["index", "text"] } } }, required: ["texts"] };
export const buildLayoutPrompt = (texts) => [
  `Each advert text below was written as one block. Give each one back with line breaks put in, so it reads well on a phone: short paragraphs with an empty line between them, and each item of a list (a line starting with a tick, a bullet, an emoji or a number) on a line of its own.`,
  `Change NOTHING else: every word, emoji, punctuation mark and placeholder in braces stays exactly as it is, in the same order. You may only turn spaces into line breaks.`,
  texts.map((t, i) => `TEXT ${i}\n${t}`).join("\n\n"),
].join("\n\n");
/**
 * Line breaks for texts that came as one block. One text call for them all; an answer is used only when it is
 * the same text with nothing but the spacing changed (checked here, character by character with all spacing
 * removed) — otherwise that text is broken by rule (breakBySentence). Returns the texts in order, each with
 * `how`: "model" | "rule".
 */
export async function layoutTexts(texts, { ask = callVision, model = COPY_MODEL } = {}) {
  let answer = null;
  try { answer = await ask(null, buildLayoutPrompt(texts), LAYOUT_SCHEMA, { model }); } catch {}
  return texts.map((t, i) => {
    const got = (answer?.texts || []).find((x) => x.index === i)?.text;
    const laid = typeof got === "string" ? got.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
    return laid.includes("\n") && squash(laid) === squash(t) ? { text: laid, how: "model" } : { text: breakBySentence(t), how: "rule" };
  });
}

/** {BUTTON} as the chosen call to action's name; any other placeholder stays as it is. */
export const fillButton = (v, label) => (typeof v === "string" && label ? v.replace(/\{BUTTON\}/g, label) : v);
const idOf = (d) => createHash("sha256").update(`${d.message}\n${d.headline}\n${d.description}`).digest("hex").slice(0, 10);

// ── the rules ────────────────────────────────────────────────────────────────
/** Always, whatever the profile says: the owner's standing rules for every gym. */
export const ALWAYS_NEVER = ["free trial", "trial", "before and after", "before & after", "before/after", "guaranteed", "guarantee",
  // the same rules in Chinese (2026-10-07): free, a trial, a trial class, before-and-after, a guarantee
  "免費", "試用", "體驗課", "前後對比", "對比照", "保證"];
/** What copy may not say for this gym and this offer: the voice's never-list, the offer's must-not-say, the standing rules. */
export function copyRules(profile, offerDoc = null) {
  const never = [...new Set([...ALWAYS_NEVER, ...(profile?.brand_lock?.voice?.never || []), ...(offerDoc?.messaging?.must_not_say || [])].map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  return { never, adjectives: profile?.brand_lock?.voice?.adjectives || [], must_say: offerDoc?.messaging?.must_say || [] };
}
const PRICE = /(\$|S\$|SGD|USD|NT\$|NTD|TWD|新台幣)\s?\d|\b\d+(\.\d+)?\s?(dollars|bucks)\b|\bper (week|month|session)\b|\d+(,\d{3})*(\.\d+)?\s?(元|塊)(?![a-z])/i;
/** A weight-loss number, in English or Chinese: lose 5 kg; 瘦5公斤, 減掉3公斤, 瘦了2吋, 體脂降5%, 5%體脂. */
const WEIGHT = /\b(lose|drop|shed)\s+\d+\s?(kg|lbs?|pounds|kilos)\b|(瘦|減|掉|甩|少)\s?(了|掉|下)?\s?\d+(\.\d+)?\s?(公斤|kg|斤|公分|吋|寸)|\d+(\.\d+)?\s?%\s?(的)?體脂|體脂[^。！？\n]{0,4}\d+(\.\d+)?\s?%/i;
/** Why a draft cannot go on an ad. Empty = fine. */
export function copyProblems(d, { offer, rules, kind = null }) {
  const k = kind || kindOf(d), e = [], all = `${d.message} ${d.headline} ${d.description}`;
  if (k === "copy" && !d.message) e.push("no primary text"); if (k === "headline" && !d.headline) e.push("no headline");
  if (d.message.length > LIMITS.message) e.push(`primary text over ${LIMITS.message} characters`);
  if (d.headline.length > LIMITS.headline) e.push(`headline over ${LIMITS.headline} characters`);
  if (d.description.length > LIMITS.description) e.push(`description over ${LIMITS.description} characters`);
  if (/[–—]/.test(all)) e.push("an em or en dash (use a plain hyphen)");
  if (k === "copy" && offer && !all.toLowerCase().includes(String(offer).toLowerCase())) e.push(`the offer "${offer}" is not named exactly`);
  if (PRICE.test(all)) e.push("a price");
  const low = all.toLowerCase();
  for (const n of rules.never) { const re = new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i"); if (re.test(low)) e.push(`says "${n}"`); }
  if (WEIGHT.test(all)) e.push("a weight-loss number");
  for (const ph of new Set([...all.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]))) if (!DRAFT_PLACEHOLDERS.includes(ph)) e.push(`unknown placeholder {${ph}} (a draft may carry {AREA} and {BUTTON} only)`);
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
/** What is drafted: primary texts (copy) and headlines, each its own list, kept apart, combined by Meta on the ad. */
export const KINDS = ["copy", "headline"];
/** The placeholders a draft may carry: the area (filled per ad set on the plan) and the button (filled from the chosen call to action). */
export const DRAFT_PLACEHOLDERS = ["AREA", "BUTTON"];
export const kindOf = (d) => (d?.kind === "headline" ? "headline" : "copy");
/** The library's live skeletons of a kind, read straight from its file (copy-library.mjs imports this module, so it is not imported back). */
export function librarySkeletons(dir = process.env.COPY_LIBRARY_DIR || join(REPO_ROOT, "library"), kind = "copy", { language = null } = {}) {
  const j = readJson(join(dir, "copy-library.json"));
  // An entry without a language is English (every entry before 2026-10-07 was).
  return (Array.isArray(j?.entries) ? j.entries : []).filter((e) => !e.retired && e.kind === kind && (!language || (e.language || languageOf(e.text)) === language));
}
const schemaFor = (kind) => ({ type: "OBJECT", properties: { drafts: { type: "ARRAY", items: { type: "OBJECT",
  properties: kind === "headline" ? { headline: { type: "STRING" }, description: { type: "STRING" }, angle: { type: "STRING", enum: ANGLES }, from: { type: "INTEGER" } } : { message: { type: "STRING" }, angle: { type: "STRING", enum: ANGLES }, from: { type: "INTEGER" } },
  required: kind === "headline" ? ["headline", "angle", "from"] : ["message", "angle", "from"] } } }, required: ["drafts"] });
/**
 * The request: the gym, the offer's exact words, the audience and the areas, the rules, the library's skeletons of
 * this kind (the structure, rhythm and voice to follow — never a gym's own past ads), the shape wanted, the angles.
 */
export function buildDraftPrompt({ profile, kind = "copy", offer, audience, locations, rules, skeletons, count, avoid = [], button = "Sign up" }) {
  const gym = profile.display_name || "the gym", what = kind === "headline" ? "headlines" : "primary texts", zh = gymLanguage(profile) === "zh";
  const lines = [
    `You write Meta lead ads for ${gym}, a gym in ${countryRules(profile?.locale?.country).name || "its city"}. Write ${count} different ${what} for one campaign.`,
    `THE OFFER: "${offer}". ${kind === "headline" ? "Where a headline names the offer, name it exactly like that; a headline may instead carry the promise." : "Name it exactly like that in every primary text."} Never invent what it includes, its price, its length beyond the name, or any guarantee. Where the gym is named, name it "${gym}".`,
    audience ? `WHO IT IS FOR: the ad says "${audience}". Speak to them.` : `WHO IT IS FOR: everyone near the gym.`,
    locations?.length ? `WHERE: the ads run in ${locations.join(", ")}, one ad set per area. Where you address the reader by area, write the placeholder {AREA} (it becomes each ad set's own area), as in "Ladies in {AREA}". Never write an area's name yourself.` : "",
    `SKELETONS - ${what} that have worked, with the parts that change as placeholders in braces. Each one you write follows ONE skeleton: its opening move, its line pattern and list style, its contrasts, its rhythm and the way it closes - with new words for this gym, this offer and this audience. Never copy a skeleton's sentences, never blend two, and say which skeleton (its number) each one follows:\n${skeletons.map((s, i) => (kind === "headline" ? `${i + 1}. [${s.angle || "-"}] ${String(s.text).replace(/\n+/g, " / ").slice(0, 200)}` : `--- SKELETON ${i + 1} [${s.angle || "-"}]\n${String(s.text).replace(/\n{3,}/g, "\n\n").slice(0, 900)}`)).join(kind === "headline" ? "\n" : "\n\n")}`,
    // The layout is part of what worked: shown flattened (" / " for every line break) and never asked for, the model
    // wrote one block a draft (F45 Lower Peirce 2026-09-28, BFIT 2026-10-04).
    kind === "headline" ? "" : `LAYOUT: set each primary text out the way its skeleton is set out above - short paragraphs with an empty line between them, and each list item on a line of its own. Put real line breaks in the text. Never write a primary text as one block.`,
    zh ? `LANGUAGE: Traditional Chinese as written in Taiwan (zh-TW): Taiwanese wording, full-width punctuation 。，！？, never simplified characters, digits for numbers. The placeholders {AREA} and {BUTTON} stay exactly as written, in braces. The skeletons below are in the same language: follow their structure, never translate them word for word.` : "",
    `VOICE: ${rules.adjectives.length ? rules.adjectives.join(", ") : "direct, warm, confident"}. ${countryRules(profile?.locale?.country).tone || "Plain English."} Short lines. No hype.`,
    `NEVER write any of these words or ideas: ${rules.never.join("; ")}. No prices. No before-and-after claims. No weight-loss numbers. No em dashes or en dashes; use a plain hyphen. No emoji in headlines. No other placeholder than {AREA} and {BUTTON}.`,
    rules.must_say.length ? `ALWAYS work in: ${rules.must_say.join("; ")}.` : "",
    avoid.length ? `ALREADY WRITTEN (do not repeat these): ${avoid.map((a) => (kindOf(a) === "headline" ? a.headline : a.message.split("\n")[0].slice(0, 80))).join(" | ")}` : "",
    kind === "headline"
      ? `SHAPE: one line, under ${LIMITS.headline_ideal} characters ideally and never over ${LIMITS.headline}, plus a description under ${LIMITS.description_ideal} characters or empty. Spread the ${count} across these angles and name each one's angle: ${ANGLES.join(", ")}.`
      : `SHAPE: ${zh ? "80-260 characters" : "60-160 words"}, opening with a hook before the offer; where the call to action names the button, write the placeholder {BUTTON} (the ad's button is "${button}": phrase the ask to fit it, never another button's name). Spread the ${count} across these angles and name each one's angle: ${ANGLES.join(", ")}.`,
  ].filter(Boolean);
  return { prompt: lines.join("\n\n"), schema: schemaFor(kind) };
}
// Drafts written before the placeholder rule name a button literally: read as {BUTTON} (ids unchanged, the file untouched); older drafts are copies.
const asDraft = (d) => ({ ...d, kind: kindOf(d), message: buttonPlaceholder(d.message || ""), headline: buttonPlaceholder(d.headline || ""), description: buttonPlaceholder(d.description || ""), recommended: d.recommended ?? null });
export const readCopy = (batchDir) => { const j = readJson(join(batchDir, COPY_FILE)); return { drafted: null, drafts: [], ...(j || {}), drafts: (Array.isArray(j?.drafts) ? j.drafts : []).map(asDraft) }; };
const writeCopy = (batchDir, data) => writeWhole(join(batchDir, COPY_FILE), JSON.stringify(data, null, 2) + "\n");
/** The kept drafts of a kind, in the order they were kept (the owner's order of choice). */
export const keptCopies = (batchDir, kind = "copy") => readCopy(batchDir).drafts.filter((d) => d.status === "keep" && kindOf(d) === kind).sort((a, b) => (a.kept_at || "").localeCompare(b.kept_at || ""));
/**
 * Draft `count` copies or headlines for a batch from the library's skeletons and append them to its copy.json as
 * drafts. One text call (a second for a shortfall); drafts that break a rule are dropped with the reason, duplicates
 * too; then one judge call rates the open drafts of that kind and the top five are recommended. `ask` is the model
 * call (callVision's shape); `skeletons` overrides the library (tests).
 */
export async function draftCopy({ brandDir, batchDir, kind = "copy", offer, audience = null, locations = [], count = 10, button = "Sign up", libraryDir = undefined, skeletons = null, judge = true, ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (!KINDS.includes(kind)) throw new Error("kind is copy or headline");
  if (!offer) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("count must be 1 to 20");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {};
  const offerDoc = offerDocFor(brandDir, offer);
  const rules = copyRules(profile, offerDoc);
  const language = gymLanguage(profile);
  const skel = skeletons || librarySkeletons(libraryDir, kind, { language });
  if (!skel.length) throw new Error(`the copy library has no ${kind === "headline" ? "headline" : "copy"} skeletons yet in ${LANGUAGE_NAMES[language] || language}: paste a few on Library → Copy first${language === "zh" ? ", or send this gym's own references to the library" : ""}`);
  const data = readCopy(batchDir);
  const have = new Set(data.drafts.map(shape)), dropped = [], added = [];
  let calls = 0;
  for (let round = 0; round < 2 && added.length < count; round++) {
    const want = count - added.length;
    const { prompt, schema } = buildDraftPrompt({ profile, kind, offer, audience, locations, rules, skeletons: skel, count: want, avoid: [...data.drafts.filter((d) => kindOf(d) === kind), ...added], button });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    for (const raw of answer?.drafts || []) {
      const norm = (t, max) => clean(areaPlaceholder(buttonPlaceholder(plainDashes(t)), locations), max);
      const d = kind === "headline"
        ? { message: "", headline: norm(raw.headline, LIMITS.headline + 50), description: norm(raw.description, LIMITS.description + 50) }
        : { message: norm(raw.message, LIMITS.message + 200), headline: "", description: "" };
      const problems = copyProblems(d, { offer, rules, kind });
      const label = (kind === "headline" ? d.headline : d.message.split("\n")[0]).slice(0, 60);
      if (problems.length) { dropped.push({ headline: label, why: problems.join("; ") }); continue; }
      const k = shape(d); if (have.has(k)) { dropped.push({ headline: label, why: "reads like one already here" }); continue; }
      have.add(k);
      const from = Number.isInteger(raw.from) && skel[raw.from - 1] ? skel[raw.from - 1].id : null;
      const draft = { id: `c-${idOf(d)}`, kind, ...d, angle: ANGLES.includes(raw.angle) ? raw.angle : null, from, source: "agent", status: "draft", drafted: new Date().toISOString(), edited: null, recommended: null };
      added.push(draft); data.drafts.push(draft);
      if (added.length >= count) break;
    }
    log(`  ${kind}: ${added.length} kept of the model's ${answer?.drafts?.length || 0}${dropped.length ? `, ${dropped.length} dropped` : ""} (round ${round + 1})`);
  }
  // A primary text that still came as one block gets its line breaks here (one call for them all, words untouched).
  const flat = kind === "copy" ? added.filter((d) => needsLayout(d.message)) : [];
  if (flat.length) {
    const laid = await layoutTexts(flat.map((d) => d.message), { ask, model }); calls++;
    flat.forEach((d, i) => { d.message = laid[i].text; });
    log(`  ${kind}: ${flat.length} came as one block; line breaks put in (${laid.filter((x) => x.how === "model").length} by the model, ${laid.filter((x) => x.how === "rule").length} by rule)`);
  }
  data.drafted = new Date().toISOString(); data.offer = offer; data.audience = audience; data.locations = locations;
  writeCopy(batchDir, data);
  let recommended = [];
  if (judge && added.length) {
    try { recommended = await judgeAndRecommend({ batchDir, kind, offer, audience, ask, model }); calls++; log(`  ${kind}: ${recommended.length} recommended`); }
    catch (e) { log(`  ${kind}: the drafts could not be judged (${e.message})`); }
  }
  return { added, dropped, calls, skeletons: skel.length, total: data.drafts.length, recommended };
}

/** How many of a batch's primary texts (not excluded) came as one block. */
export const flatCopies = (batchDir) => readCopy(batchDir).drafts.filter((d) => kindOf(d) === "copy" && d.status !== "exclude" && needsLayout(d.message));
/**
 * Put line breaks into a batch's primary texts that came as one block (drafts and kept ones; never an excluded
 * one). Words untouched (layoutTexts verifies it); ids, status, the judge's rating and the order kept all stay.
 * One text call, none when there is nothing to do.
 */
export async function relayoutCopies(batchDir, { ask = callVision, model = COPY_MODEL } = {}) {
  const data = readCopy(batchDir), flat = data.drafts.filter((d) => kindOf(d) === "copy" && d.status !== "exclude" && needsLayout(d.message));
  if (!flat.length) return { fixed: 0, by_model: 0, by_rule: 0, calls: 0 };
  const laid = await layoutTexts(flat.map((d) => d.message), { ask, model });
  flat.forEach((d, i) => { d.message = laid[i].text; d.laid_out = new Date().toISOString(); });
  writeCopy(batchDir, data);
  return { fixed: flat.length, by_model: laid.filter((x) => x.how === "model").length, by_rule: laid.filter((x) => x.how === "rule").length, calls: 1 };
}

// ── the judge and the recommendation ─────────────────────────────────────────
const JUDGE_SCHEMA = { type: "OBJECT", properties: { ratings: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, clarity: { type: "INTEGER" }, why: { type: "STRING" } }, required: ["id", "clarity", "why"] } } }, required: ["ratings"] };
export function buildJudgePrompt({ drafts, kind = "copy", offer, audience }) {
  const zh = drafts.some((d) => isCJK(kind === "headline" ? d.headline : d.message));
  return [
    zh ? "The drafts are in Traditional Chinese: judge them as a reader in Taipei would, on a phone." : "",
    `You judge Meta lead-ad ${kind === "headline" ? "headlines" : "primary texts"} for CLARITY as read on a phone by ${audience ? `the people the ad calls "${audience}"` : "people near the gym"}, for the offer "${offer}".`,
    `For each draft give clarity from 1 to 10 (10 = reads in one breath; what is offered and what to do next are plain by the second line; nothing to puzzle over; no clutter) and one short sentence why, at most 15 words. Judge the reading only, not the angle or the idea. Placeholders in braces stand for the area and the button; read them as filled.`,
    drafts.map((d) => `ID ${d.id}\n${kind === "headline" ? `${d.headline}${d.description ? ` / ${d.description}` : ""}` : d.message}`).join("\n\n"),
  ].join("\n\n");
}
/** One text call: clarity 1–10 and a reason per draft, by id. */
export async function judgeDrafts({ drafts, kind = "copy", offer, audience = null, ask = callVision, model = COPY_MODEL }) {
  const a = await ask(null, buildJudgePrompt({ drafts, kind, offer, audience }), JUDGE_SCHEMA, { model });
  const out = {};
  for (const r of a?.ratings || []) if (drafts.some((d) => d.id === r.id)) out[r.id] = { clarity: Math.max(1, Math.min(10, r.clarity | 0)), why: clean(plainDashes(r.why), 160) };
  return out;
}
/** The `n` to recommend: diversity first — the clearest of each distinct angle — then the clearest of the rest. */
export function recommend(drafts, ratings, n = 5) {
  const rated = drafts.filter((d) => ratings[d.id]).sort((a, b) => ratings[b.id].clarity - ratings[a.id].clarity || (a.drafted || "").localeCompare(b.drafted || ""));
  const picks = [], angles = new Set();
  for (const d of rated) { if (picks.length >= n) break; const ang = d.angle || "none"; if (angles.has(ang)) continue; angles.add(ang); picks.push(d); }
  for (const d of rated) { if (picks.length >= n) break; if (!picks.includes(d)) picks.push(d); }
  return picks.map((d, i) => ({ id: d.id, rank: i + 1, clarity: ratings[d.id].clarity, why: ratings[d.id].why, angle: d.angle || null }));
}
/** Judge every open draft of a kind (drafts and kept ones, not excluded) and mark the recommended five; written on the drafts. */
export async function judgeAndRecommend({ batchDir, kind = "copy", offer, audience = null, n = 5, ask = callVision, model = COPY_MODEL }) {
  const data = readCopy(batchDir), open = data.drafts.filter((d) => kindOf(d) === kind && d.status !== "exclude");
  if (!open.length) return [];
  const ratings = await judgeDrafts({ drafts: open, kind, offer, audience, ask, model });
  const picks = recommend(open, ratings, n);
  for (const d of data.drafts) {
    if (kindOf(d) !== kind) continue;
    const p = picks.find((x) => x.id === d.id), r = ratings[d.id];
    if (r) { d.clarity = r.clarity; d.clarity_why = r.why; }
    d.recommended = p ? { rank: p.rank, why: p.why } : null;
  }
  writeCopy(batchDir, data); return picks;
}
/** Keep the recommended drafts of a kind in their rank order (the owner's one click). */
export function keepRecommended(batchDir, kind = "copy") {
  const data = readCopy(batchDir), recs = data.drafts.filter((d) => kindOf(d) === kind && d.recommended).sort((a, b) => a.recommended.rank - b.recommended.rank);
  if (!recs.length) throw new Error(`nothing recommended among the ${kind === "headline" ? "headlines" : "copies"} yet: draft first`);
  const t0 = Date.now(); recs.forEach((d, i) => { d.status = "keep"; d.kept_at = d.kept_at || new Date(t0 + i).toISOString(); });
  writeCopy(batchDir, data); return recs;
}
/** The offer file whose name is the offer's exact words, if the gym has one (its must-not-say joins the rules). */
export function offerDocFor(brandDir, offer) {
  const dir = join(brandDir, "offers"); if (!existsSync(dir) || !offer) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) { const o = readJson(join(dir, f)); if (o?.name && String(o.name).toLowerCase() === String(offer).toLowerCase()) return o; }
  return null;
}
/** The owner's own copy or headline for a batch: checked by the same rules, kept at once. */
export function addCopy(batchDir, { kind = "copy", message = "", headline = "", description = "" }, { offer, profile = {}, offerDoc = null, locations = [] } = {}) {
  if (!KINDS.includes(kind)) throw new Error("kind is copy or headline");
  const norm = (t, max) => clean(areaPlaceholder(buttonPlaceholder(plainDashes(t)), locations), max);
  const d = { message: norm(message, LIMITS.message), headline: norm(headline, LIMITS.headline), description: norm(description, LIMITS.description) };
  const problems = copyProblems(d, { offer, rules: copyRules(profile, offerDoc), kind });
  if (problems.length) throw new Error(problems.join("; "));
  const data = readCopy(batchDir);
  const k = shape(d); if (data.drafts.some((x) => shape(x) === k)) throw new Error("that one is already here");
  const draft = { id: `c-${idOf(d)}`, kind, ...d, angle: null, from: null, source: "owner", status: "keep", kept_at: new Date().toISOString(), drafted: new Date().toISOString(), edited: null, recommended: null };
  data.drafts.push(draft); writeCopy(batchDir, data); return draft;
}
/** Keep, exclude or put back to draft; edits go through the same rules. */
export function decideCopy(batchDir, id, { status, message, headline, description } = {}, { offer, profile = {}, offerDoc = null, locations = [] } = {}) {
  const data = readCopy(batchDir), d = data.drafts.find((x) => x.id === id);
  if (!d) throw new Error(`no copy ${id}`);
  if (message != null || headline != null || description != null) {
    const norm = (t, max) => clean(areaPlaceholder(buttonPlaceholder(plainDashes(t)), locations), max);
    const next = { message: message != null ? norm(message, LIMITS.message) : d.message, headline: headline != null ? norm(headline, LIMITS.headline) : d.headline, description: description != null ? norm(description, LIMITS.description) : d.description };
    const problems = copyProblems(next, { offer, rules: copyRules(profile, offerDoc), kind: kindOf(d) });
    if (problems.length) throw new Error(problems.join("; "));
    Object.assign(d, next, { edited: new Date().toISOString() });
  }
  if (status != null) {
    if (!["draft", "keep", "exclude"].includes(status)) throw new Error("a decision is keep, exclude or draft");
    if (status === "keep" && data.drafts.filter((x) => x.status === "keep" && kindOf(x) === kindOf(d) && x.id !== id).length >= 20) throw new Error("no more than 20 kept for one campaign");
    d.status = status; d.kept_at = status === "keep" ? d.kept_at || new Date().toISOString() : null;
  }
  writeCopy(batchDir, data); return d;
}
/** The text options each ad carries: the kept drafts, `n` per ad; more kept than `n` → they rotate across the ads so every one runs. */
export function textOptionsFor(kept, n, adIndex) {
  const count = Math.max(1, Math.min(MAX_OPTIONS, n | 0));
  if (!kept.length) return [];
  if (kept.length <= count) return kept;
  const start = (adIndex * count) % kept.length;
  return Array.from({ length: count }, (_, i) => kept[(start + i) % kept.length]);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { gym: { type: "string" }, "brand-dir": { type: "string" }, batch: { type: "string" }, count: { type: "string", default: "10" }, kind: { type: "string", default: "copy" }, list: { type: "boolean", default: false } } });
  if (!v.gym || !v.batch) { console.error("Usage: draft-copy.mjs --gym <slug> --batch <id> [--kind copy|headline] [--count 10] [--list] [--brand-dir <dir>]"); process.exit(1); }
  try {
    const brandDir = v["brand-dir"] ? resolve(v["brand-dir"]) : join(REPO_ROOT, "brands", v.gym), batchDir = join(brandDir, "outputs", v.batch);
    const brief = readJson(join(brandDir, "batches", v.batch, "brief.json")) || readJson(join(batchDir, "brief.json"));
    if (!brief) throw new Error(`no brief for batch ${v.batch}`);
    if (!v.list) {
      const r = await draftCopy({ brandDir, batchDir, kind: v.kind, offer: brief.offer, audience: brief.audience || null, locations: brief.locations || [], count: parseInt(v.count, 10), log: console.log });
      console.log(`drafted ${r.added.length} ${v.kind === "headline" ? "headlines" : "copies"} (${r.calls} call${r.calls === 1 ? "" : "s"}, ${r.skeletons} skeletons shown), ${r.recommended.length} recommended; ${r.total} in copy.json${r.dropped.length ? `\ndropped: ${r.dropped.map((d) => `"${d.headline}" (${d.why})`).join("; ")}` : ""}`);
    }
    for (const d of readCopy(batchDir).drafts) console.log(`\n[${d.kind} · ${d.status}${d.angle ? ` · ${d.angle}` : ""}${d.recommended ? ` · #${d.recommended.rank} recommended` : ""}${d.clarity != null ? ` · clarity ${d.clarity}` : ""}] ${d.id}${d.headline ? `\n  HEADLINE: ${d.headline}` : ""}${d.message ? `\n  ${d.message.replace(/\n/g, "\n  ")}` : ""}${d.description ? `\n  DESCRIPTION: ${d.description}` : ""}${d.recommended ? `\n  WHY: ${d.recommended.why}` : ""}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
