/**
 * cards.mjs — what goes on a text-led card, and the rules for it (Phase 5 of the formats plan, 2026-11-11).
 *
 * Three kinds of card (render-cards.mjs sets them): a Google REVIEW, a STATEMENT, a TIMELINE. The words are never the
 * renderer's:
 *   · a review is a real one, word for word — pasted by the owner or pulled from Google (the Places API returns at most
 *     five per place). What shows on the card is an EXCERPT: whole sentences of the review, in order, nothing rewritten
 *     (`isExcerptOf`). The reviewer's name is as Google shows it and the stars are the review's own. The owner's ruling
 *     (2026-11-11): a public Google review needs no consent record. Only 5-star reviews go on an ad (the owner's rule, 2026-11-11).
 *   · a statement or a timeline is drafted by the text model under the copy rules, or typed by the owner, and is used only
 *     once the owner has KEPT it (the owner's ruling: "I approve").
 * The standing rules hold on a card as in copy: no price, no free trial, no before-and-after, no weight-loss number.
 * Retire, never delete (a reason is required).
 *
 * Files, per gym: brands/{gym}/reviews.json and brands/{gym}/card-words.json.
 *
 *   node skills/references/cards.mjs --brand-dir brands/x --list
 *   node skills/references/cards.mjs --brand-dir brands/x --pull-google ["name and address to search"]   (needs GOOGLE_PLACES_KEY in .env)
 *   node skills/references/cards.mjs --brand-dir brands/x --draft statement|timeline --offer "6 Week …" [--audience "…"] [--count 6]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { callVision } from "./check-visual.mjs";
import { splitOffer } from "./render-composites.mjs";
import { CARD_KINDS, contentProblems, plainOf } from "./render-cards.mjs";
import { copyRules, copyProblems, plainDashes, COPY_MODEL } from "./draft-copy.mjs";

export { CARD_KINDS };
export const REVIEWS_FILE = "reviews.json", WORDS_FILE = "card-words.json";
export const MIN_STARS = 5;              // only a 5-star review is an advert (the owner's rule, 2026-11-11)
export const EXCERPT_MAX = 240;          // the excerpt picked by default: whole sentences up to this
export const EXCERPT_LIMIT = 420;        // the longest an excerpt may be at all (the renderer still has to fit it)
export const STATEMENT_LIMIT = [20, 170], TITLE_LIMIT = 44, WHEN_LIMIT = 14, HEAD_LIMIT = 34, LINE_LIMIT = 64;
export const MAX_CARDS = 6;              // of one kind in one batch
export const today = () => new Date().toISOString().slice(0, 10);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ── excerpts ──────────────────────────────────────────────────────────────
/** A review's sentences, as written (a line break ends one too). */
export function sentencesOf(text) {
  return String(text || "").split(/\n+/).flatMap((line) => norm(line).match(/[^.!?。！？]+[.!?。！？]+["”’)]*|[^.!?。！？]+$/g) || []).map(norm).filter(Boolean);
}
/** Is `excerpt` whole sentences of `text`, in order, with nothing changed (spacing aside)? */
export function isExcerptOf(text, excerpt) {
  const s = sentencesOf(text), want = norm(excerpt);
  if (!want) return false;
  for (let i = 0; i < s.length; i++) for (let j = i; j < s.length; j++) { const run = s.slice(i, j + 1).join(" "); if (run === want) return true; if (run.length > want.length) break; }
  return false;
}
/** The excerpt taken by default: the first run of whole sentences an ad may carry (`ok`), as many as fit `max` — the
 *  review's opening when all of it is fine; its first sentence when no sentence passes (the owner then sees why). */
export function autoExcerpt(text, max = EXCERPT_MAX, ok = () => true) {
  const s = sentencesOf(text);
  for (let i = 0; i < s.length; i++) {
    if (!ok(s[i]) || s[i].length > max) continue;
    let out = s[i];
    for (let j = i + 1; j < s.length && ok(s[j]) && `${out} ${s[j]}`.length <= max; j++) out = `${out} ${s[j]}`;
    if (out.length >= 30 || i === s.length - 1) return out;
  }
  return s[0] || "";
}
// A result with a number on it, the way a review says it: "lost 8kg", "down 5 kilos", "dropped two dress sizes", "12% body fat".
// (The copy rule catches "lose 5kg"; reviews speak in the past tense.)
const RESULT_NUMBER = /\b(lost|lose|losing|shed|dropped?|down|off|lighter)\b[^.!?]{0,24}?\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s?(kg|kgs|kilos?|kilograms?|lbs?|pounds?|stone|cm|inch(?:es)?|dress sizes?|sizes?|%)|\b\d+(?:\.\d+)?\s?(kg|kgs|kilos?|lbs?|pounds?)\s+(lighter|down|gone|off)\b|\b\d+(?:\.\d+)?\s?%\s*body\s*fat/i;
/** What the standing rules forbid in words that go on an ad. A quote keeps its own punctuation, so a dash is no fault there. */
export function onAdProblems(text, profile = {}, { quote = false } = {}) {
  const plain = norm(plainOf(text));
  const errs = copyProblems({ message: plain, headline: "", description: "" }, { offer: null, rules: copyRules(profile), kind: "copy" }).filter((e) => !(quote && /dash/.test(e)));
  if (RESULT_NUMBER.test(plain) && !errs.includes("a weight-loss number")) errs.push("a weight-loss number");
  return errs;
}

// ── reviews ───────────────────────────────────────────────────────────────
export const readReviews = (gymDir) => { const j = readJson(join(gymDir, REVIEWS_FILE)); return { place: null, pulled: null, ...(j || {}), reviews: Array.isArray(j?.reviews) ? j.reviews : [] }; };
const writeReviews = (gymDir, data) => writeFileSync(join(gymDir, REVIEWS_FILE), JSON.stringify(data, null, 2) + "\n");
/** Why a review cannot go on an ad as it stands — an empty list means it can. */
export function reviewProblems(r, profile = {}) {
  const errs = [];
  if (r.retired) errs.push(`retired${r.reason ? `: ${r.reason}` : ""}`);
  if (!(r.rating >= MIN_STARS)) errs.push(`${r.rating} star${r.rating === 1 ? "" : "s"}: only 5-star reviews go on an ad`);
  if (!isExcerptOf(r.text, r.excerpt)) errs.push("the excerpt must be whole sentences of the review, in order, with nothing changed");
  else { if (norm(r.excerpt).length > EXCERPT_LIMIT) errs.push(`the excerpt is over ${EXCERPT_LIMIT} characters`); errs.push(...onAdProblems(r.excerpt, profile, { quote: true }).map((e) => `the excerpt has ${e}: choose other sentences`)); }
  return errs;
}
export const reviewView = (r, profile = {}) => { const problems = reviewProblems(r, profile); return { ...r, sentences: sentencesOf(r.text), usable: problems.length === 0, problems }; };
/** Add a review word for word. A review already here (the same words) is refused; the excerpt defaults to its opening sentences. */
export function addReview(gymDir, { author, rating, text, excerpt = null, url = null, date = null, source = "pasted" }, { profile = {} } = {}) {
  const t = String(text || "").trim(), a = norm(author), stars = Number(rating);
  if (a.length < 1 || a.length > 80) throw new Error("the reviewer's name is needed, as Google shows it (up to 80 characters)");
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error("the review's rating is 1 to 5 stars");
  if (norm(t).length < 20 || t.length > 5000) throw new Error("paste the review's words: 20 to 5,000 characters");
  if (!["pasted", "google"].includes(source)) throw new Error("a review is pasted or from Google");
  if (url != null && url !== "" && !/^https:\/\/[^\s]+$/.test(String(url))) throw new Error("the review's link must be an https address");
  const data = readReviews(gymDir), id = `r-${sha(norm(t).toLowerCase()).slice(0, 10)}`;
  if (data.reviews.some((r) => r.id === id)) throw Object.assign(new Error("this review is already here"), { duplicate: id });
  const ex = excerpt != null && norm(excerpt) ? norm(excerpt) : autoExcerpt(t, EXCERPT_MAX, (sentence) => onAdProblems(sentence, profile, { quote: true }).length === 0);
  if (!isExcerptOf(t, ex)) throw new Error("the excerpt must be whole sentences of the review, in order, with nothing changed");
  const review = { id, source, author: a, rating: stars, text: t, excerpt: ex, ...(url ? { url: String(url) } : {}), ...(date ? { date: String(date).slice(0, 10) } : {}), added: today() };
  data.reviews.push(review); writeReviews(gymDir, data);
  return reviewView(review, profile);
}
/** Change which sentences show (word for word still), retire with a reason, or restore. */
export function editReview(gymDir, id, { excerpt, retired, reason } = {}, { profile = {} } = {}) {
  const data = readReviews(gymDir), r = data.reviews.find((x) => x.id === id);
  if (!r) throw new Error(`no such review: ${id}`);
  if (excerpt != null) { if (!isExcerptOf(r.text, excerpt)) throw new Error("the excerpt must be whole sentences of the review, in order, with nothing changed"); r.excerpt = norm(excerpt); }
  if (retired === true) { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a review needs a reason"); r.retired = true; r.reason = reason.trim(); r.retired_on = today(); }
  if (retired === false) { delete r.retired; delete r.reason; delete r.retired_on; }
  writeReviews(gymDir, data);
  return reviewView(r, profile);
}
export const usableReviews = (gymDir, profile = {}) => readReviews(gymDir).reviews.map((r) => reviewView(r, profile)).filter((r) => r.usable);

// ── reviews from Google (the Places API, New) ─────────────────────────────
export const PLACES_URL = () => process.env.GOOGLE_PLACES_URL || "https://places.googleapis.com/v1";
/** The key from the environment or .env — never from a profile, never printed. */
export function placesKey(envPath = join(resolve(fileURLToPath(new URL("../..", import.meta.url))), ".env")) {
  if (process.env.GOOGLE_PLACES_KEY != null) return process.env.GOOGLE_PLACES_KEY || null;
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, "utf-8").match(/^GOOGLE_PLACES_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") || null : null;
}
const scrub = (msg, key) => String(msg || "").split(key).join("…");
async function places(path, { key, method = "GET", body = null, fields, fetchFn = fetch }) {
  const res = await fetchFn(`${PLACES_URL()}${path}`, { method, headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(scrub(`Google answered ${res.status}: ${j?.error?.message || "no reason given"}`, key));
  return j;
}
/** Find the gym's place on Google by name and address. Returns candidates [{ id, name, address }]. */
export async function findPlace(query, { key = placesKey(), fetchFn = fetch } = {}) {
  if (!key) throw new Error("no Google Places key yet: add GOOGLE_PLACES_KEY to .env");
  const j = await places("/places:searchText", { key, method: "POST", body: { textQuery: String(query).slice(0, 200) }, fields: "places.id,places.displayName,places.formattedAddress", fetchFn });
  return (j.places || []).map((p) => ({ id: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "" }));
}
/**
 * Pull the place's reviews (Google returns at most five) and add the new ones, word for word. The place is remembered
 * on the gym's reviews file. Returns { place, found, added[], already, skipped[] }.
 */
export async function pullGoogleReviews(gymDir, { placeId = null, key = placesKey(), profile = {}, fetchFn = fetch } = {}) {
  if (!key) throw new Error("no Google Places key yet: add GOOGLE_PLACES_KEY to .env");
  const id = placeId || readReviews(gymDir).place?.id;
  if (!id || !/^[\w-]{10,200}$/.test(id)) throw new Error("which place? Search for the gym first, then pull its reviews");
  const j = await places(`/places/${id}`, { key, fields: "id,displayName,formattedAddress,rating,userRatingCount,reviews", fetchFn });
  const added = [], skipped = []; let already = 0;
  for (const g of j.reviews || []) {
    const text = g.originalText?.text || g.text?.text || "";
    try { added.push(addReview(gymDir, { author: g.authorAttribution?.displayName || "", rating: g.rating, text, url: g.googleMapsUri || null, date: g.publishTime || null, source: "google" }, { profile }).id); }
    catch (e) { if (e.duplicate) already++; else skipped.push({ author: g.authorAttribution?.displayName || null, reason: e.message }); }
  }
  const data = readReviews(gymDir);
  data.place = { id: j.id || id, name: j.displayName?.text || null, address: j.formattedAddress || null, rating: j.rating ?? null, ratings: j.userRatingCount ?? null };
  data.pulled = new Date().toISOString();
  writeReviews(gymDir, data);
  return { place: data.place, found: (j.reviews || []).length, added, already, skipped };
}

// ── statements and timelines ──────────────────────────────────────────────
export const readWords = (gymDir) => { const j = readJson(join(gymDir, WORDS_FILE)); return { statements: Array.isArray(j?.statements) ? j.statements : [], timelines: Array.isArray(j?.timelines) ? j.timelines : [] }; };
const writeWords = (gymDir, data) => writeFileSync(join(gymDir, WORDS_FILE), JSON.stringify(data, null, 2) + "\n");
/** "6 Week Strength Challenge" → "6 week": what a timeline is for. Null when the offer names no duration. */
export const durationOf = (offer) => { const d = splitOffer(String(offer || "")).duration; return d ? norm(d).toLowerCase().replace(/-/g, " ") : null; };
export function statementProblems(text, profile = {}) {
  const t = String(text || "").trim(), errs = contentProblems("statement", { text: t });
  if (errs.length) return errs;
  const plain = plainOf(t);
  if (plain.length < STATEMENT_LIMIT[0] || plain.length > STATEMENT_LIMIT[1]) errs.push(`a statement is ${STATEMENT_LIMIT[0]} to ${STATEMENT_LIMIT[1]} characters (this is ${plain.length})`);
  if (/\n/.test(t)) errs.push("a statement is one paragraph");
  errs.push(...onAdProblems(t, profile));
  return errs;
}
export function timelineProblems(t, profile = {}) {
  const errs = contentProblems("timeline", t);
  if (errs.length) return errs;
  if (!t.duration || !/^\d+ (week|day|month)s?$/.test(t.duration)) errs.push('a timeline says the duration it is for, e.g. "6 week"');
  if (t.title.trim().length > TITLE_LIMIT) errs.push(`the title is over ${TITLE_LIMIT} characters`);
  t.steps.forEach((s, i) => {
    if (s.when.trim().length > WHEN_LIMIT) errs.push(`step ${i + 1}: "when" is over ${WHEN_LIMIT} characters`);
    if (s.head.trim().length > HEAD_LIMIT) errs.push(`step ${i + 1}: its heading is over ${HEAD_LIMIT} characters`);
    if (s.line && s.line.trim().length > LINE_LIMIT) errs.push(`step ${i + 1}: its line is over ${LINE_LIMIT} characters`);
  });
  errs.push(...onAdProblems([t.title, ...t.steps.flatMap((s) => [s.when, s.head, s.line || ""])].join(". "), profile));
  return errs;
}
const cleanTimeline = (t) => ({ duration: norm(t.duration).toLowerCase(), title: plainDashes(norm(t.title)), steps: (t.steps || []).map((s) => ({ when: plainDashes(norm(s.when)), head: plainDashes(norm(s.head)), ...(norm(s.line) ? { line: plainDashes(norm(s.line)) } : {}) })) });
const shape = (s) => norm(s).toLowerCase().replace(/[^a-z0-9 \p{Script=Han}]/gu, "");
/** Add a statement: the owner's own is kept at once, a drafted one waits for the owner. */
export function addStatement(gymDir, text, { source = "owner", profile = {}, offer = null } = {}) {
  const t = plainDashes(norm(text)), errs = statementProblems(t, profile);
  if (errs.length) throw new Error(errs.join("; "));
  const data = readWords(gymDir);
  if (data.statements.some((s) => shape(plainOf(s.text)) === shape(plainOf(t)))) throw Object.assign(new Error("this statement is already here"), { duplicate: true });
  const s = { id: `s-${sha(shape(plainOf(t))).slice(0, 10)}`, text: t, status: source === "owner" ? "kept" : "draft", source, ...(offer ? { drafted_for: offer } : {}), added: today() };
  data.statements.push(s); writeWords(gymDir, data); return s;
}
export function addTimeline(gymDir, timeline, { source = "owner", profile = {}, offer = null } = {}) {
  const t = cleanTimeline(timeline), errs = timelineProblems(t, profile);
  if (errs.length) throw new Error(errs.join("; "));
  const data = readWords(gymDir), key = shape([t.duration, t.title, ...t.steps.map((s) => s.head)].join(" "));
  if (data.timelines.some((x) => shape([x.duration, x.title, ...x.steps.map((s) => s.head)].join(" ")) === key)) throw Object.assign(new Error("this timeline is already here"), { duplicate: true });
  const row = { id: `t-${sha(key).slice(0, 10)}`, ...t, status: source === "owner" ? "kept" : "draft", source, ...(offer ? { drafted_for: offer } : {}), added: today() };
  data.timelines.push(row); writeWords(gymDir, data); return row;
}
/** The owner keeps a draft, edits it (checked again), puts it back, or retires it with a reason. */
export function decideWords(gymDir, kind, id, { status, text, timeline, reason } = {}, { profile = {} } = {}) {
  if (!["statement", "timeline"].includes(kind)) throw new Error("kind must be statement or timeline");
  const data = readWords(gymDir), list = kind === "statement" ? data.statements : data.timelines, row = list.find((x) => x.id === id);
  if (!row) throw new Error(`no such ${kind}: ${id}`);
  if (kind === "statement" && text != null) { const t = plainDashes(norm(text)), errs = statementProblems(t, profile); if (errs.length) throw new Error(errs.join("; ")); row.text = t; row.edited = today(); }
  if (kind === "timeline" && timeline != null) { const t = cleanTimeline({ duration: row.duration, ...timeline }), errs = timelineProblems(t, profile); if (errs.length) throw new Error(errs.join("; ")); Object.assign(row, t); row.edited = today(); }
  if (status != null) {
    if (!["kept", "draft", "retired"].includes(status)) throw new Error("status must be kept, draft or retired");
    if (status === "retired") { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error(`retiring a ${kind} needs a reason`); row.reason = reason.trim(); row.retired_on = today(); }
    else { delete row.reason; delete row.retired_on; }
    row.status = status;
  }
  writeWords(gymDir, data); return row;
}
export const keptStatements = (gymDir) => readWords(gymDir).statements.filter((s) => s.status === "kept");
export const keptTimelines = (gymDir, duration = null) => readWords(gymDir).timelines.filter((t) => t.status === "kept" && (!duration || t.duration === duration));

// ── drafting (one text call; drafts for the owner to keep) ────────────────
const DRAFT_SCHEMA = {
  statement: { type: "OBJECT", properties: { statements: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] } } }, required: ["statements"] },
  timeline: { type: "OBJECT", properties: { timelines: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, steps: { type: "ARRAY", items: { type: "OBJECT", properties: { when: { type: "STRING" }, head: { type: "STRING" }, line: { type: "STRING" } }, required: ["when", "head", "line"] } } }, required: ["title", "steps"] } } }, required: ["timelines"] },
};
export function buildWordsPrompt({ kind, profile = {}, offer, audience = null, count = 6, existing = [] }) {
  const rules = copyRules(profile), who = audience ? `The advert is for: ${audience}.` : "The advert is for adults near the gym who are not training yet.";
  const never = `NEVER: a price or any money; a free trial; before and after; a guarantee; a number of kilos, pounds or percent to lose; a medical claim; an exclamation mark; an em dash; the gym's name; a date${rules.never?.length ? `; any of: ${rules.never.join(", ")}` : ""}.`;
  const lines = kind === "statement" ? [
    `You write the single statement on a text-only advert for a gym's programme: "${offer}". ${who}`,
    `A statement is one or two short sentences, ${STATEMENT_LIMIT[0]} to ${STATEMENT_LIMIT[1]} characters, that names a truth this person already feels and turns it toward acting now. Plain words, said the way a good coach would say it across a table. It does not name the programme (the advert shows it below) and it does not tell the reader to click anything.`,
    "Mark the two to four words that carry the point with **double asterisks** so they are set bold.",
    never,
    `Write ${count} statements, each from a different angle (what they are putting off, what they fear, what they want to be able to do, who they are doing it for, how little time it takes).`,
  ] : [
    `You write a short timeline for a text-only advert for a gym's programme: "${offer}". ${who}`,
    `The programme lasts ${durationOf(offer)}s. A timeline is a title (up to ${TITLE_LIMIT} characters) and 3 to 5 steps in order. Each step: "when" (up to ${WHEN_LIMIT} characters, counted in the programme's own units from its start: Day 1, Week 2, Week 6 — never a calendar date), a heading (up to ${HEAD_LIMIT} characters) and one line (up to ${LINE_LIMIT} characters) saying what happens or how it feels at that point. The last step is the final ${durationOf(offer).split(" ")[1]} of the programme.`,
    "It is honest about effort and specific about what a member does and feels: sessions, coaching, habits, strength, energy, confidence. It promises no result.",
    never,
    `Write ${count} timelines, each with a different title and a different way through the programme.`,
  ];
  if (existing.length) lines.push(`Already written — do not repeat or closely rephrase:\n${existing.map((e) => `- ${e}`).join("\n")}`);
  return { prompt: lines.join("\n\n"), schema: DRAFT_SCHEMA[kind] };
}
/** Draft statements or timelines for an offer. One text call. Returns { added[], dropped[], calls }. */
export async function draftCardWords({ brandDir, kind, offer, audience = null, count = 6, ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (!["statement", "timeline"].includes(kind)) throw new Error("kind must be statement or timeline");
  if (typeof offer !== "string" || offer.trim().length < 3) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("count must be 1 to 10");
  if (kind === "timeline" && !durationOf(offer)) throw new Error(`a timeline needs an offer that names its length (e.g. "6 Week …"); "${offer}" names none`);
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, words = readWords(brandDir);
  const existing = kind === "statement" ? words.statements.map((s) => plainOf(s.text)) : words.timelines.map((t) => `${t.title}: ${t.steps.map((s) => s.head).join(" / ")}`);
  const { prompt, schema } = buildWordsPrompt({ kind, profile, offer: offer.trim(), audience, count, existing });
  const answer = await ask(null, prompt, schema, { model });
  const added = [], dropped = [];
  for (const d of (kind === "statement" ? answer?.statements : answer?.timelines) || []) {
    try { added.push(kind === "statement" ? addStatement(brandDir, d.text, { source: "drafted", profile, offer: offer.trim() }) : addTimeline(brandDir, { ...d, duration: durationOf(offer) }, { source: "drafted", profile, offer: offer.trim() })); }
    catch (e) { dropped.push({ text: kind === "statement" ? d.text : d.title, reason: e.message }); log(`  dropped: ${e.message}`); }
  }
  return { added, dropped, calls: 1 };
}

// ── a batch's cards ───────────────────────────────────────────────────────
/** What is wrong with a brief's `cards` (how many of each kind): { review?, statement?, timeline? }. */
export function cardsProblems(cards) {
  if (cards == null) return [];
  if (typeof cards !== "object" || Array.isArray(cards)) return ["cards maps each kind of card to how many the batch has"];
  const errs = [];
  for (const [k, n] of Object.entries(cards)) {
    if (!CARD_KINDS.includes(k)) errs.push(`cards: "${k}" is not one of ${CARD_KINDS.join(", ")}`);
    else if (!Number.isInteger(n) || n < 0 || n > MAX_CARDS) errs.push(`cards.${k} must be 0 to ${MAX_CARDS}`);
  }
  return errs;
}
export const cardCount = (cards) => Object.values(cards || {}).reduce((a, n) => a + (Number.isInteger(n) ? n : 0), 0);
/** How many of each kind the gym can make now, for this offer. */
export function cardsAvailable(gymDir, { offer = null, profile = {} } = {}) {
  return { review: usableReviews(gymDir, profile).length, statement: keptStatements(gymDir).length, timeline: keptTimelines(gymDir, offer ? durationOf(offer) : null).length };
}
const seeded = (seed) => { let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; }; };
/**
 * The cards a batch makes: for each kind asked, that many of the gym's usable ones, in a seeded order so a re-run picks
 * the same. Refused, by name, when a kind has fewer than asked. Returns [{ id, kind, source_id, content }].
 */
export function pickCards(gymDir, { cards = {}, offer, profile = {}, seed = "batch" } = {}) {
  const errs = cardsProblems(cards); if (errs.length) throw new Error(errs.join("; "));
  const rand = seeded(`${seed}|cards`), shuffle = (xs) => xs.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const pools = {
    review: () => usableReviews(gymDir, profile).map((r) => ({ source_id: r.id, content: { excerpt: r.excerpt, author: r.author, rating: r.rating, source_label: "Google review" } })),
    statement: () => keptStatements(gymDir).map((s) => ({ source_id: s.id, content: { text: s.text } })),
    timeline: () => keptTimelines(gymDir, durationOf(offer)).map((t) => ({ source_id: t.id, content: { title: t.title, steps: t.steps } })),
  };
  const need = { review: "paste or pull 5-star Google reviews on Library → Cards", statement: "draft some and keep the ones you want on Library → Cards", timeline: `draft some for a ${durationOf(offer) || "?"} offer and keep the ones you want on Library → Cards` };
  const out = []; let n = 0;
  for (const kind of CARD_KINDS) {
    const want = cards[kind] || 0; if (!want) continue;
    const pool = shuffle(pools[kind]());
    if (pool.length < want) throw new Error(`${want} ${kind} card${want === 1 ? "" : "s"} asked for, ${pool.length} ready: ${need[kind]}`);
    for (const p of pool.slice(0, want)) out.push({ id: `k${String(++n).padStart(2, "0")}`, kind, ...p });
  }
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { "brand-dir": { type: "string" }, list: { type: "boolean", default: false }, "pull-google": { type: "boolean", default: false }, draft: { type: "string" }, offer: { type: "string" }, audience: { type: "string" }, count: { type: "string", default: "6" } } });
  if (!v["brand-dir"]) { console.error("Usage: cards.mjs --brand-dir <brands/x> --list | --pull-google [\"name and address\"] | --draft statement|timeline --offer \"…\" [--audience \"…\"] [--count 6]"); process.exit(1); }
  const dir = resolve(v["brand-dir"]), profile = readJson(join(dir, "gym-profile.json")) || {};
  try {
    if (v["pull-google"]) {
      let placeId = readReviews(dir).place?.id || null;
      if (!placeId || positionals[0]) { const found = await findPlace(positionals[0] || `${profile.display_name} ${profile.locations?.[0]?.address || ""}`); if (!found.length) throw new Error("Google found no such place"); console.log(`place: ${found[0].name} — ${found[0].address}`); placeId = found[0].id; }
      const r = await pullGoogleReviews(dir, { placeId, profile });
      console.log(`${r.found} review(s) from Google (it returns five at most): ${r.added.length} added, ${r.already} already here${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.map((s) => s.reason).join("; ")})` : ""}`);
    } else if (v.draft) {
      const r = await draftCardWords({ brandDir: dir, kind: v.draft, offer: v.offer, audience: v.audience || null, count: Number(v.count), log: console.log });
      console.log(`${r.added.length} ${v.draft} draft(s) for your approval, ${r.dropped.length} dropped by the rules; ${r.calls} text call`);
      for (const a of r.added) console.log(`  ${a.id}: ${a.text || `${a.title} — ${a.steps.map((s) => `${s.when}: ${s.head}`).join(" · ")}`}`);
    } else {
      const rv = readReviews(dir).reviews.map((r) => reviewView(r, profile)), w = readWords(dir);
      console.log(`${rv.length} review(s), ${rv.filter((r) => r.usable).length} usable · ${w.statements.length} statement(s), ${w.statements.filter((s) => s.status === "kept").length} kept · ${w.timelines.length} timeline(s), ${w.timelines.filter((t) => t.status === "kept").length} kept`);
      for (const r of rv) console.log(`  ${r.id} ${"★".repeat(r.rating)} ${r.author}: ${r.excerpt.slice(0, 90)}${r.usable ? "" : `  [not usable: ${r.problems.join("; ")}]`}`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
