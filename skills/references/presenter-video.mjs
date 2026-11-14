#!/usr/bin/env node
/**
 * presenter-video.mjs — a presenter talking to the camera, made by AI (2026-11-12; the first video format built,
 * after the owner watched the test: "The presenter — it's REALLY good … this quality is perfect. Build presenter first").
 *
 * The shape is the gyms' own best videos (F45 Jurong West's "Intro", Sculpt Society's "Treadmill Intro"): someone
 * talks to a phone camera across a few spots in the gym's own room, with jump cuts and bold captions. Here:
 *
 *   · THE PRESENTER IS NOBODY IN PARTICULAR. An invented person who never claims to be staff or a member, so a script
 *     may not say I, we, our, my or us. Who presents (a woman or a man, about what age, any look) is the gym's own
 *     choice — `creative_defaults.presenter` — and nothing is made until it is set: Sculpt Society has no female
 *     coaches, so a woman presenting there would mislead.
 *   · THE WORDS ARE THE OWNER'S. A script is two to four lines of one breath each, typed by the owner or drafted by the
 *     text model and KEPT by him before a second of video is made — the words are baked into speech, so they cannot
 *     be changed afterwards the way copy can. The copy rules apply (no free trial, no price, no before and after, no
 *     result promised, the gym's never-list), it names the offer in its exact words, and `{AREA}` stands where the
 *     location is said, so one script serves every location of a batch.
 *   · TWO LAYERS, as for the stills. The model makes footage with no words in it; software sets every word on screen
 *     (captions a few words at a time, the word being said in a warm yellow), inside Meta's 9:16 live area.
 *   · EVERY SPOKEN LINE IS CHECKED. One call watches each clip: the words said must be the line's words, in order
 *     (a number may be said or written: "12 week" is "twelve week"); exactly one person is in it (the model walks
 *     people into empty space); no lettering appears. A clip that fails is made again (`takes`), then the video is
 *     refused and the reason said. The check's "looks real" score is NOT a gate — it scored a clip with an extra
 *     person 10 of 10 in the test — its faults are shown to the owner, whose pick is the final check.
 *   · NO END CARD (the owner, 2026-11-14: "Don't need the black screen … at the end"): the video ends on the
 *     presenter's last word, held a moment (`END_HOLD`). The offer and the area are said, and so shown in the captions.
 *   · A SCRIPT OPENS ON A PAIN POINT AND ENDS ON ONE CLOSING LINE (the owner, 2026-11-14: "'Keep putting off getting
 *     back into shape' … is not a pain point. We need to speak to the client's pain point"; "Don't say 'tap below'.
 *     CTA is always 'click the link below and we'll be in touch!'"). The pain points are the owner's, per gym and per
 *     offer when he gives some (typed, or suggested and kept); otherwise THE AGENT WORKS THEM OUT ITSELF from the gym's
 *     own best adverts and the copy library's pain-led ones, and every draft says the one it opens on. The agent
 *     proposes the scripts and he reviews and edits them — he is never asked what to say first (his word, the same day). The closing line is one sentence for every gym
 *     (`closingLine`), the last words of every script, and the one place a script may say "we".
 *   · GOOGLE MAY REFUSE A CLIP (2026-11-14: the closing line, asked for as a clip of its own, was refused under its
 *     content rules — twice more in a test, on two pictures — and passed with a few words before it in the same clip).
 *     So (1) THE CLOSING LINE IS NEVER A CLIP OF ITS OWN: where it is a script's whole last line it is filmed with the
 *     line before it, as one cut (`filmedLines`) — the words stay exactly as they are; (2) A REFUSAL IS A FAILED
 *     TAKE, NOT A CRASH: the clip is asked for once more, then on a fresh picture of the presenter, and only then is
 *     that video refused, in words; a refused request made nothing, so its seconds are not counted.
 *   · WHAT IS FILMED IS KEPT PER GYM AND SCRIPT, NOT PER BATCH (2026-11-14: Aether's second batch filmed lines 2 to 4
 *     again, word for word what its first batch had). The presenter's pictures and the clips of a script live in
 *     `brands/{gym}/video-clips/{script}/`, named for what made them, so any batch that films the script again makes
 *     only what is not there: a new location makes its one line, an edited line makes that line. A script filmed
 *     before this brings its newest batch's pictures and clips in the first time (one batch only: one presenter).
 *   · A SCRIPT THAT NEEDS AN EDIT IS EDITED BY THE AGENT FOR HIM TO APPROVE (`proposeEdit`, his word the same day:
 *     "have the agent propose any edits required for me to approve, but I can also manually edit it").
 *   · A WORD IS SAID THE WAY IT IS SAID HERE (the owner, 2026-11-14: "'Quay' is pronounced 'Kee' in Singapore"): a
 *     short list, shared by every gym and his to add to (`saidAs`), is told to the presenter with the line, and a
 *     clip is named for it too, so adding a word films again only the lines that say it.
 *   · THE ENDING IS TWO BEATS (the same day: "it's too abrupt when we transition into 'Click the link below…'", with
 *     the end of his own sample as the model): one sentence that turns to the viewer and names what they want — "If
 *     you're ready to …, now is your time." — and then the closing line. What they will feel or be able to do, never
 *     an ideal body. A script that goes straight into the closing line needs an edit.
 *   · THE PLACE IS ONLY EVER {AREA}, and never the whole country (the owner, 2026-11-14: "We can't say the full of
 *     Singapore no matter what").
 *   · A CLIP WITH A NOTED FAULT IS MADE ONCE MORE while takes are left (warped fingers, a hand that moves wrongly),
 *     and the cleaner take is kept: a fault is no refusal, but the owner's bar is that borderline-real fails.
 *   · EACH CLIP IS CUT TO ITS SPEECH, AND THE CAPTIONS FOLLOW THE VOICE (the owner on the first real video: "subtitles
 *     are late and not synced with his voice", "the delay between 'Keep watching' and the cut is too long"). A clip is
 *     asked for with a second to spare so the sentence finishes, and the model leaves silence at both ends: that
 *     video had 2.2 s of nothing after its first line and 2.7 s before its third. So where he actually speaks is
 *     measured from the sound (`speechOf`), the clip is cut a breath either side of it, and the captions are timed
 *     across the spoken time only, breaking where the sentence does.
 *   · A LINE WITHOUT THE AREA IS MADE ONCE and shared by every location's video; only the line that says the area is
 *     made per location.
 *   · SPEND IS COUNTED BEFORE EACH CALL, in seconds of video and image calls, against caps the run was given.
 *
 * Models (Google's pages, 2026-11-12): video is Gemini Omni Flash on the Interactions API (clips of 3 to 15 seconds
 * with sound, 9:16, a starting image as an image part; audio cannot be an input); the stills are the gym's image model.
 * Assembly is ffmpeg (installed once: `brew install ffmpeg`) and the text layer is headless Chrome, as for the stills.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, copyFileSync } from "fs";
import { join, resolve, extname, basename, dirname } from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";
import { loadGeminiKey, generateImage } from "./generate_ads_gemini.mjs";
import { whenGeminiFree, isRefusal } from "./gemini-busy.mjs";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";
import { imageModelFor, countryRules, profileCountry, titleCase, PRESENTER_GENDERS, presenterProblems } from "./client-config.mjs";
import { launchBrowser, isWholeCountry } from "./render-composites.mjs";
import { onAdProblems } from "./cards.mjs";
import { COPY_MODEL, plainDashes } from "./draft-copy.mjs";

export { PRESENTER_GENDERS, presenterProblems };
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const OMNI = "gemini-omni-1.2-flash", INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const SCRIPTS_FILE = "video-scripts.json";
/** A script is 2 to 4 lines; a line is one breath (6 to 26 words) and becomes one clip of 5 to 12 seconds. */
export const LINES = [2, 7], LINE_WORDS = [6, 26], CLIP_SECONDS = [5, 15], WORDS_PER_SECOND = 2.8;
/** What a second of 720p video costs (Google's pricing page, 2026-11-12) and an image call, for the estimate shown before a run. */
export const USD_PER_SECOND = 0.07, USD_PER_IMAGE = 0.15;
/** A presenter who is nobody in particular never speaks as the gym or as a member. */
export const FIRST_PERSON = /\b(i|i'm|im|i've|i'll|i'd|we|we're|we've|we'll|our|ours|my|mine|me|us|myself|ourselves)\b/i;
const W = 720, H = 1280, FPS = 24;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
const mimeOf = (p) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[extname(p).toLowerCase()] || "image/png";
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
const ff = (args) => sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
export const durationOf = (file) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
export const hasFfmpeg = () => { try { sh("ffmpeg", ["-version"]); sh("ffprobe", ["-version"]); return true; } catch { return false; } };

// ── words spoken against words written ───────────────────────────────────────
const NUMBER = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
/** A line as the words a listener hears: lower case, punctuation gone, a number as its figure; a possessive ending ("gym's", "Athletics'", "Athletics's") is the word itself, marked. */
const spoken = (s) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).map((raw) => {
  const poss = /[a-z0-9]'s?$/.test(raw), w = (poss ? raw.replace(/'s?$/, "") : raw).replace(/'/g, "");
  return { w: w in NUMBER ? String(NUMBER[w]) : w, poss };
}).filter((t) => t.w);
/** One letter added, dropped or changed at most. */
const near = (a, b) => {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
/**
 * The words said are the line's words, in order. Punctuation and case aside; a number may be said or written. Three
 * things a listener cannot hear are not a difference (2026-11-12: a good take of "Aether Athletics's 6 Week…" was
 * refused twice, heard as "Aether Athletics 6-week" and as "Ether Athletics'"): a possessive ("Athletics's" is said
 * "Athletics"), the spelling of a NAME (`names`: the gym's own name — a word of it may be one letter off, "Ether"
 * for "Aether"), and where a name's spaces fall ("F 45" for "F45"). Every other word must be the word.
 */
export function sameWords(said, line, { names = [], sounds = [] } = {}) {
  const a = spoken(said), b = spoken(line);
  const named = new Set(names.flatMap((n) => spoken(n).map((t) => t.w)).filter((w) => w.length >= 4));
  // `sounds`: words that are one word to the ear — a word and the way it is said here ("quay", "kee", "key").
  const same = (x, y) => x.w === y.w || ((x.poss || y.poss) && (x.w + "s" === y.w || y.w + "s" === x.w)) || (named.has(y.w) && near(x.w, y.w)) || sounds.some((grp) => grp.includes(x.w) && grp.includes(y.w));
  if (a.length === b.length && a.every((t, i) => same(t, b[i]))) return true;
  // The same letters with the spaces elsewhere (a name written as one word and heard as two) — only where a name is in the line.
  return named.size + names.length > 0 && names.some((n) => spoken(n).some((t) => b.some((y) => y.w === t.w))) && a.map((t) => t.w).join("") === b.map((t) => t.w).join("");
}
export const wordCount = (line) => norm(line).split(" ").filter(Boolean).length;
/** `{AREA}` filled the way the plan fills it in copy: "ANG MO KIO" → "Ang Mo Kio", "CBD" stays. */
export const fillLine = (line, area) => norm(line).replace(/\{AREA\}/g, titleCase(String(area || "")));
/** How long a line's clip is: its words at a talking pace and a second to finish, inside the model's limits (the test's lines of 22, 23 and 15 words were said in 8, 9 and 7 seconds). */
export const clipSeconds = (line) => Math.max(CLIP_SECONDS[0], Math.min(CLIP_SECONDS[1], Math.ceil(wordCount(line) / WORDS_PER_SECOND + 1)));

// ── who presents ─────────────────────────────────────────────────────────────
/** The gym's presenter, or null when it has not said who presents. */
export const presenterOf = (profile) => { const p = profile?.creative_defaults?.presenter; return p && PRESENTER_GENDERS.includes(p.gender) ? { gender: p.gender, age: Number.isInteger(p.age) ? p.age : 35, look: norm(p.look) } : null; };
/** The presenter in the words an image prompt takes. The owner's own look wins; a logo and jewellery are never asked for. */
export function presenterWords(p, profile = {}) {
  const who = `${countryRules(profileCountry(profile)).demonym || ""} ${p.gender}`.trim(), look = p.look || (p.gender === "man" ? "short black hair, a plain charcoal training tee and black training shorts" : "shoulder-length black hair tied back, a plain charcoal training tee and black leggings");
  return `a ${who} of about ${p.age}, ${look}, no jewellery, no logo or lettering on the clothes`;
}

// ── scripts: the owner's words, kept before anything is made ─────────────────
/**
 * The closing line (2026-11-14, the owner: "Don't say 'tap below'. CTA is always 'click the link below and we'll be in
 * touch!'"): the last words of every script, word for word, for every gym — kept in the shared library beside the
 * samples (`closing`), this sentence until he changes it. It is the one place a script says "we": the presenter is
 * nobody in particular everywhere else.
 */
export const CLOSING_LINE = "Click the link below and we'll be in touch!", CLOSING_WORDS = [4, 14];
const apos = (x) => String(x ?? "").replace(/[’‘]/g, "'");
const closingRe = (closing) => new RegExp("(?<![A-Za-z0-9'])" + apos(closing).split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "")).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9']+") + "[^A-Za-z0-9']*$", "i");
/** Does a line end with the closing line? Case, spacing and punctuation aside; every word must be there, in order. */
export const endsWithClosing = (line, closing = CLOSING_LINE) => closingRe(closing).test(apos(line).trim());
const withoutClosing = (line, closing) => apos(line).trim().replace(closingRe(closing), "");
/** Another call to action than the closing line: "tap below", "tap the button". */
const TAP = /\btap (?:below|the|on|here|now|this|that)\b/i;
/** The country's own names, for a line that says the whole country as the place. */
const COUNTRY_WORDS = { SG: ["Singapore", "新加坡"], TW: ["Taiwan", "台灣", "臺灣"], MY: ["Malaysia"] };
function countryNamed(line, { profile = {}, offer = null } = {}) {
  let t = String(line);
  for (const own of [profile.display_name, offer].filter(Boolean)) t = t.split(new RegExp(String(own).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).join(" ");
  return (COUNTRY_WORDS[profileCountry(profile)] || []).find((w) => (/^[A-Za-z]/.test(w) ? new RegExp(`\\b${w}\\b`, "i").test(t) : t.includes(w))) || null;
}
/**
 * The closing line as a script's whole last line. Google's video model refuses that sentence as a clip of its own
 * (2026-11-14, three times on two pictures) and films it after a few words in the same clip, so it is filmed with the
 * line before it: one cut for the two. `filmedLines` is the script as it is filmed — the words unchanged.
 */
export const closingAlone = (line, closing = CLOSING_LINE) => endsWithClosing(line, closing) && !/[A-Za-z0-9]/.test(withoutClosing(line, closing));
export const JOINED_WORDS = 36;
export function filmedLines(lines, closing = closingLine()) {
  const ls = (lines || []).map(norm), n = ls.length;
  return n >= 2 && closingAlone(ls[n - 1], closing) ? [...ls.slice(0, n - 2), `${ls[n - 2]} ${ls[n - 1]}`] : ls;
}
/**
 * The ending is two beats (2026-11-14, the owner on a video that went from "…your body feels stronger." straight into
 * the closing line: "it's too abrupt"; his model, the end of his own sample: "If you're ready to transform your life
 * …, now is your time. Sign up now …"). The sentence just before the closing line, in the cut it is filmed in, is the
 * BRIDGE: it turns to the viewer ("If you…", or it speaks of being ready), names what they want, and is a sentence of
 * its own — `BRIDGE_WORDS` or more — never a bare lead-in ("If that sounds like you, click…"). What they want is
 * what they will feel or be able to do, never an ideal body (`IDEAL_BODY`: his ruling the same day, his
 * no-promised-result rule, and Meta's rules on appearance).
 */
export const BRIDGE_WORDS = 8;
const IDEAL_BODY = /\b(?:dream|perfect|ideal|beach|bikini|summer) body\b|\bbody (?:that )?(?:you|they)(?:'ve| have)? always wanted\b/i;
export function bridgeOf(lines, closing = CLOSING_LINE) {
  const cuts = filmedLines(lines, closing), parts = withoutClosing(cuts[cuts.length - 1] || "", closing).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return (parts[parts.length - 1] || "").trim();
}
export const isBridge = (sentence) => wordCount(sentence) >= BRIDGE_WORDS && /\byou(?:'re|r)?\b/i.test(apos(sentence)) && (/^(?:so |and |but )?if\b/i.test(sentence) || /\bready\b/i.test(sentence));
export const BRIDGE_WHY = `the script goes straight into the closing line: just before it, in the same cut, one sentence turns to the viewer and names what they want — "If you're ready to …, now is your time." (${BRIDGE_WORDS} words or more)`;
/** What is wrong with a script's lines, in words; empty when it may be made. `offer`: the exact words it must name; `closing`: the sentence it must end on. */
export function scriptProblems(lines, { offer = null, profile = {}, closing = closingLine() } = {}) {
  const errs = [];
  if (!Array.isArray(lines) || lines.length < LINES[0] || lines.length > LINES[1]) return [`a script is ${LINES[0]} to ${LINES[1]} lines, one for each cut`];
  const ls = lines.map(norm), last = ls.length - 1;
  ls.forEach((l, i) => {
    const n = wordCount(fillLine(l, "Ang Mo Kio"));
    if (n < LINE_WORDS[0] || n > LINE_WORDS[1]) errs.push(`line ${i + 1} is ${n} words: a line is one breath, ${LINE_WORDS[0]} to ${LINE_WORDS[1]} words`);
    const odd = (l.match(/\{[^}]*\}/g) || []).filter((x) => x !== "{AREA}"); if (odd.length) errs.push(`line ${i + 1}: only {AREA} may stand in for a word (found ${odd.join(", ")})`);
    // The closing line is the owner's own sentence and the one place "we" is said.
    const own = (i === last ? withoutClosing(l, closing) : l).replace(/\{AREA\}/g, "");
    if (FIRST_PERSON.test(own)) errs.push(`line ${i + 1} speaks as the gym or a member ("${own.match(FIRST_PERSON)[0]}"): the presenter is nobody in particular, so no I, we, our, my or us`);
    if (TAP.test(l)) errs.push(`line ${i + 1} says "${l.match(TAP)[0]}": the only call to action is the closing line`);
    const ideal = apos(l).match(IDEAL_BODY); if (ideal) errs.push(`line ${i + 1} promises an ideal body ("${ideal[0]}"): say what the person will feel or be able to do`);
    const country = countryNamed(l, { profile, offer }); if (country) errs.push(`line ${i + 1} names the whole country ("${country}"): the place is only ever {AREA}, the area around the gym`);
    if (/[\n\r]/.test(String(lines[i]))) errs.push(`line ${i + 1} is two lines: one line is one cut`);
  });
  if (!endsWithClosing(ls[last], closing)) errs.push(`the last line ends with the closing line, word for word: "${closing}"`);
  else if (!isBridge(bridgeOf(ls, closing))) errs.push(BRIDGE_WHY);
  if (endsWithClosing(ls[last], closing) && closingAlone(ls[last], closing) && wordCount(fillLine(`${ls[last - 1]} ${ls[last]}`, "Ang Mo Kio")) > JOINED_WORDS) errs.push(`line ${last} and the closing line are filmed as one cut (the closing line cannot be a clip of its own) and together they are ${wordCount(fillLine(`${ls[last - 1]} ${ls[last]}`, "Ang Mo Kio"))} words: at most ${JOINED_WORDS}, so shorten line ${last}`);
  const all = ls.join(" ");
  if (offer && !all.toLowerCase().includes(norm(offer).toLowerCase())) errs.push(`the script must name the offer in its exact words: "${norm(offer)}"`);
  for (const e of onAdProblems(fillLine(all, "Bishan"), profile)) if (!errs.includes(e)) errs.push(e);
  return errs;
}
const objOf = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
export const readScripts = (gymDir) => { const j = readJson(join(gymDir, SCRIPTS_FILE)); return { schema: 1, scripts: Array.isArray(j?.scripts) ? j.scripts : [], samples: Array.isArray(j?.samples) ? j.samples : [], facts: objOf(j?.facts), pains: objOf(j?.pains) }; };
const writeScripts = (gymDir, data) => writeFileSync(join(gymDir, SCRIPTS_FILE), JSON.stringify({ schema: 1, scripts: data.scripts || [], samples: data.samples || [], facts: data.facts || {}, pains: data.pains || {} }, null, 2) + "\n");
const shape = (lines) => lines.map(norm).join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, "");
/** Add a script: the owner's own is kept at once, a drafted one waits for him. Never twice. */
export function addScript(gymDir, { lines, offer, source = "owner", pain = null }, { profile = {}, closing = closingLine() } = {}) {
  const ls = (lines || []).map((l) => plainDashes(norm(l))), errs = scriptProblems(ls, { offer, profile, closing });
  if (errs.length) throw new Error(errs.join("; "));
  const data = readScripts(gymDir), key = shape(ls);
  if (data.scripts.some((s) => shape(s.lines) === key)) throw Object.assign(new Error("this script is already here"), { duplicate: true });
  const row = { id: `v-${sha(key).slice(0, 10)}`, lines: ls, offer: norm(offer), status: source === "owner" ? "kept" : "draft", source, ...(pain ? { pain: norm(pain) } : {}), added: today() };
  data.scripts.push(row); writeScripts(gymDir, data); return row;
}
/** The owner keeps a draft, edits it (checked again), puts it back, or retires it with a reason — never deleted. A script that breaks today's rules is not kept until it is edited. */
export function decideScript(gymDir, id, { status, lines, reason } = {}, { profile = {}, closing = closingLine() } = {}) {
  const data = readScripts(gymDir), row = data.scripts.find((s) => s.id === id);
  if (!row) throw new Error(`no such script: ${id}`);
  if (lines != null) { const ls = lines.map((l) => plainDashes(norm(l))), errs = scriptProblems(ls, { offer: row.offer, profile, closing }); if (errs.length) throw new Error(errs.join("; ")); row.lines = ls; row.edited = today(); }
  if (status != null) {
    if (!["kept", "draft", "retired"].includes(status)) throw new Error("status must be kept, draft or retired");
    if (status === "retired") { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a script needs a reason"); row.reason = reason.trim(); row.retired_on = today(); }
    else { delete row.reason; delete row.retired_on; }
    if (status === "kept" && row.status !== "kept") { const errs = scriptProblems(row.lines, { offer: row.offer, profile, closing }); if (errs.length) throw new Error(`edit it first: ${errs.join("; ")}`); }
    row.status = status;
  }
  writeScripts(gymDir, data); return row;
}
const EDIT_SCHEMA = { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } }, note: { type: "STRING" } }, required: ["lines", "note"] };
export function buildEditPrompt({ profile = {}, script, problems, closing = CLOSING_LINE }) {
  const gym = profile.display_name || "the gym";
  return { schema: EDIT_SCHEMA, prompt: [
    `This is a short script for a talking-to-camera video advert for ${gym}'s programme "${script.offer}", one line for each cut. It breaks the rules below. Propose the SMALLEST edit that mends it, for the owner to approve.`,
    `THE SCRIPT:\n${script.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    `WHAT IS WRONG:\n${problems.map((x) => `- ${x}`).join("\n")}`,
    `THE RULES. Keep every line that breaks no rule exactly as it is, word for word and in its place; change only what a rule requires, and keep the owner's voice. The ending is two beats in the last line: first ONE sentence of its own that turns to the viewer and names what they want, in this shape — "If you're ready to [what they want], now is your time." (what they will feel or be able to do, never an ideal body, never a promised result) — and then exactly this sentence, word for word: "${closing}". That sentence is the only call to action, so a sentence that says "tap below", names a button or gives another instruction is taken out. When the script goes straight into the closing sentence, add the bridge sentence before it and change nothing else. The offer is named in its exact words: "${script.offer}". The place is only ever written {AREA}, never the country. The speaker is nobody in particular: no I, we, our, my or us, except inside the closing sentence. Each line is one breath, ${LINE_WORDS[0]} to ${LINE_WORDS[1]} words; a script is ${LINES[0]} to ${LINES[1]} lines. Never: a price, free, before and after, a guarantee, a promised result, a number of kilos, an em dash.`,
    `Answer with every line of the script after the edit, in order, and a note of one sentence saying what you changed.`,
  ].join("\n\n") };
}
/**
 * The edit a script needs, proposed by the agent for the owner to approve (2026-11-14: "have the agent propose any
 * edits required for me to approve, but I can also manually edit it"). One text call, a second only when the first
 * answer still breaks a rule; every proposal is checked in code and one that still breaks a rule is not offered.
 * Nothing is saved: { lines, changed (line numbers), note, problems (what was wrong) } — he approves it, edits it
 * first, or writes his own.
 */
export async function proposeEdit({ brandDir, id, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL }) {
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, script = readScripts(brandDir).scripts.find((x) => x.id === id), closing = closingLine(libraryDir);
  if (!script) throw new Error(`no such script: ${id}`);
  const problems = scriptProblems(script.lines, { offer: script.offer, profile, closing });
  if (!problems.length) throw new Error("this script needs no edit");
  let left = problems, calls = 0;
  for (let round = 0; round < 2; round++) {
    const { prompt, schema } = buildEditPrompt({ profile, script, problems: left, closing });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    const lines = (answer?.lines || []).map((l) => plainDashes(norm(l))).filter(Boolean);
    left = scriptProblems(lines, { offer: script.offer, profile, closing });
    if (!left.length) return { lines, changed: lines.map((l, i) => (l === norm(script.lines[i] ?? "") ? 0 : i + 1)).filter(Boolean).concat(script.lines.length > lines.length ? [lines.length] : []).filter((x, i, a) => a.indexOf(x) === i), note: norm(answer?.note), problems, calls };
  }
  throw new Error(`the agent's edit still breaks a rule (${left[0]}): edit the script yourself`);
}
/** The scripts ready for an offer: kept, and written for these exact words. */
export const keptScripts = (gymDir, offer = null) => readScripts(gymDir).scripts.filter((s) => s.status === "kept" && (!offer || norm(s.offer).toLowerCase() === norm(offer).toLowerCase()));
/** What a script on file breaks by today's rules (the closing line came after some were kept): empty when it may be filmed. */
export const scriptIssues = (script, { profile = {}, closing = closingLine() } = {}) => scriptProblems(script.lines, { offer: script.offer, profile, closing });
/** The scripts that may be filmed for an offer: kept, and passing today's rules. */
export const readyScripts = (gymDir, offer = null, opts = {}) => keptScripts(gymDir, offer).filter((x) => !scriptIssues(x, opts).length);
/**
 * Samples (2026-11-12, the owner: "we talk about BENEFITS not features … we have many [scripts] for you to use"): scripts
 * of his that have worked, pasted as they are. They are reference, never made into a video and never changed: the
 * drafter is shown them to follow how they are built, how they sound and what they choose to talk about — never to
 * copy a sentence or carry over a fact. Retired with a reason, never deleted.
 */
export const SAMPLE_LIMIT = [40, 1500];
/**
 * One library for every gym (2026-11-12, the owner: share samples across every gym, like the copy library — "area and
 * challenge name, as well as gym name must be custom"): `library/video-samples.json` (gitignored with the other
 * libraries; `VIDEO_LIBRARY_DIR`, else `COPY_LIBRARY_DIR`, points tests elsewhere). A sample marks what changes from
 * gym to gym in braces — {AREA}, {CHALLENGE NAME}, {GYM NAME} — and the drafter is told what each becomes.
 */
export const videoLibraryDir = () => resolve(process.env.VIDEO_LIBRARY_DIR || process.env.COPY_LIBRARY_DIR || join(REPO_ROOT, "library"));
export const VIDEO_LIBRARY_DIR = videoLibraryDir();
export const SAMPLES_FILE = "video-samples.json";
export const readSamples = (libDir = videoLibraryDir()) => { const j = readJson(join(libDir, SAMPLES_FILE)); return { schema: 1, samples: Array.isArray(j?.samples) ? j.samples : [], closing: j?.closing && typeof j.closing.text === "string" ? j.closing : null, said: Array.isArray(j?.said) ? j.said : [] }; };
const writeSamples = (libDir, data) => { mkdirSync(libDir, { recursive: true }); writeFileSync(join(libDir, SAMPLES_FILE), JSON.stringify({ schema: 1, samples: data.samples, ...(data.closing ? { closing: data.closing } : {}), ...(data.said?.length ? { said: data.said } : {}) }, null, 2) + "\n"); };
/**
 * How a word is said (2026-11-14, the owner: "'Quay' is pronounced 'Kee' in Singapore. Edge case but let's account for
 * it too"). A short list for every gym — the standing entries here, and the owner's own in the shared library
 * (`said`), which win and may take a standing one out. The presenter is told it with a line that has the word; the
 * check takes the word as said for the word as written ("key" for "Quay"), and is asked how it sounded: said another
 * way is a noted fault (the clip is made once more while takes are left), never a refusal — his ear is the last check.
 */
export const SAID_AS = [{ word: "Quay", say: "kee", heard: ["key"] }];
const letters = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, "");
export function saidAs(libDir = videoLibraryDir()) {
  const out = new Map(SAID_AS.map((x) => [letters(x.word), { ...x }]));
  for (const x of readSamples(libDir).said) { const k = letters(x.word); if (x.removed) out.delete(k); else if (x.word && x.say) out.set(k, { word: x.word, say: x.say, heard: out.get(k)?.say === x.say ? out.get(k).heard || [] : [] }); }
  return [...out.values()];
}
export function saidProblems(word, say) {
  const errs = [];
  if (!/^[A-Za-z][A-Za-z'-]{1,29}$/.test(String(word || "").trim())) errs.push("the word is one word as it is written, 2 to 30 letters (\"Quay\")");
  if (!/^[A-Za-z][A-Za-z '-]{0,39}$/.test(String(say || "").trim())) errs.push("how it is said is written the way it sounds, in letters (\"kee\")");
  return errs;
}
/** Add or change how a word is said, for every gym; an empty `say` takes the word off the list. */
export function setSaid(libDir, word, say) {
  const w = norm(word), how = norm(say), data = readSamples(libDir), rest = data.said.filter((x) => letters(x.word) !== letters(w));
  if (!how) { if (!/^[A-Za-z][A-Za-z'-]{1,29}$/.test(w)) throw new Error("which word?"); data.said = [...rest, ...(SAID_AS.some((x) => letters(x.word) === letters(w)) ? [{ word: w, removed: true, updated: today() }] : [])]; }
  else { const errs = saidProblems(w, how); if (errs.length) throw new Error(errs.join("; ")); data.said = [...rest, { word: w, say: how, updated: today() }]; }
  writeSamples(libDir, data); return saidAs(libDir);
}
/** The entries whose word is in a line, as a whole word. */
export const saidIn = (line, list = []) => list.filter((x) => new RegExp(`(?<![A-Za-z])${x.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i").test(String(line)));
/** What names a clip beside its words and its picture: a changed way of saying a word films that line again, and no other. */
const saidNote = (entries) => entries.map((x) => `${letters(x.word)}=${letters(x.say)}`).sort().join("|");
const soundsOf = (entries) => entries.map((x) => [x.word, x.say, ...(x.heard || [])].map(letters));
/** From a clip's check: the listed words that were heard said another way, each as a noted fault. */
function saidWrong(seen, entries) {
  const out = [];
  for (const x of entries) { const p = (seen?.pronounced || []).find((q) => letters(q.word) === letters(x.word)), how = letters(p?.sounded_like || ""); if (how && how !== letters(x.word) && !soundsOf([x])[0].includes(how)) out.push(`"${x.word}" sounded like "${norm(p.sounded_like)}" (it is said "${x.say}")`); }
  return out;
}
/** The closing line every script ends on: the owner's own when he has changed it, else the standing sentence. */
export function closingLine(libDir = videoLibraryDir()) { return norm(readSamples(libDir).closing?.text) || CLOSING_LINE; }
export function closingProblems(text, profile = {}) {
  const t = norm(text), n = wordCount(t), errs = [];
  if (n < CLOSING_WORDS[0] || n > CLOSING_WORDS[1]) errs.push(`the closing line is one short sentence, ${CLOSING_WORDS[0]} to ${CLOSING_WORDS[1]} words (this is ${n})`);
  if (/[{}]/.test(t)) errs.push("the closing line is said as it is for every gym: no braces");
  if (TAP.test(t)) errs.push('the closing line does not say "tap"');
  for (const e of onAdProblems(t, profile)) errs.push(e);
  return errs;
}
/** Change the closing line, for every gym. Scripts kept with the old one need an edit before they are filmed again. */
export function setClosing(libDir, text) {
  const t = plainDashes(norm(text)), errs = closingProblems(t); if (errs.length) throw new Error(errs.join("; "));
  const data = readSamples(libDir); data.closing = { text: t, updated: today() }; writeSamples(libDir, data); return t;
}
const sampleKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, "");
/** Add a sample to the shared library, exactly as pasted. `gym`: where it was pasted (for the record only). Never twice. */
export function addSample(libDir, text, { note = null, gym = null } = {}) {
  const t = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length < SAMPLE_LIMIT[0] || t.length > SAMPLE_LIMIT[1]) throw new Error(`a sample script is ${SAMPLE_LIMIT[0]} to ${SAMPLE_LIMIT[1]} characters: paste one script at a time`);
  const data = readSamples(libDir), key = sampleKey(t);
  if (data.samples.some((x) => sampleKey(x.text) === key)) throw Object.assign(new Error("this sample is already here"), { duplicate: true });
  const row = { id: `vs-${sha(key).slice(0, 10)}`, text: t, ...(note ? { note: norm(note) } : {}), ...(gym ? { from: gym } : {}), added: today() };
  data.samples.push(row); writeSamples(libDir, data); return row;
}
export function decideSample(libDir, id, { retired, reason } = {}) {
  const data = readSamples(libDir), row = data.samples.find((x) => x.id === id);
  if (!row) throw new Error(`no such sample: ${id}`);
  if (retired === true) { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a sample needs a reason"); row.retired = today(); row.reason = reason.trim(); }
  else if (retired === false) { delete row.retired; delete row.reason; }
  writeSamples(libDir, data); return row;
}
export const liveSamples = (libDir = videoLibraryDir()) => readSamples(libDir).samples.filter((x) => !x.retired);
/** Samples pasted before the library was shared sit in a gym's own file: each joins the library once, as it is (its id,
 *  its date, retired or not), with the gym it came from. The gym's file is left as it was. Returns how many joined. */
export function adoptSamples(libDir, gymDirs = []) {
  const data = readSamples(libDir); let n = 0;
  for (const g of gymDirs) for (const x of readScripts(g).samples) {
    if (!x?.text || data.samples.some((y) => y.id === x.id || sampleKey(y.text) === sampleKey(x.text))) continue;
    data.samples.push({ ...x, from: x.from || basename(g) }); n++;
  }
  if (n) writeSamples(libDir, data);
  return n;
}
/**
 * What a programme includes (2026-11-12): the facts a script may state about one offer — its inclusions, how many
 * places — typed by the owner, per gym. The drafter may say these and nothing else about how the programme works;
 * a sample's own facts are never carried over. Kept beside the gym's scripts, keyed by the offer's words.
 */
export const FACT_LIMITS = { items: 8, chars: [3, 140] };
const offerKey = (offer) => norm(offer).toLowerCase();
export function factsProblems(items, profile = {}) {
  if (!Array.isArray(items)) return ["the facts are a list, one to a line"];
  const errs = [];
  if (items.length > FACT_LIMITS.items) errs.push(`at most ${FACT_LIMITS.items} facts: keep the ones worth saying out loud`);
  items.forEach((x, i) => {
    const t = norm(x);
    if (t.length < FACT_LIMITS.chars[0] || t.length > FACT_LIMITS.chars[1]) errs.push(`fact ${i + 1} is ${t.length} characters: ${FACT_LIMITS.chars[0]} to ${FACT_LIMITS.chars[1]}`);
    for (const e of onAdProblems(t, profile)) errs.push(`fact ${i + 1}: ${e}`);
  });
  return errs;
}
export function setFacts(gymDir, offer, items, { profile = {} } = {}) {
  if (typeof offer !== "string" || norm(offer).length < 3) throw new Error("the offer's exact words are needed");
  const list = [...new Set((items || []).map((x) => plainDashes(norm(x))).filter(Boolean))], errs = factsProblems(list, profile);
  if (errs.length) throw new Error(errs.join("; "));
  const data = readScripts(gymDir);
  if (list.length) data.facts[offerKey(offer)] = { offer: norm(offer), items: list, updated: today() }; else delete data.facts[offerKey(offer)];
  writeScripts(gymDir, data); return list;
}
export const factsFor = (gymDir, offer) => readScripts(gymDir).facts[offerKey(offer)]?.items || [];

/**
 * Pain points (2026-11-14, the owner on the first video's opening, "keep putting off getting back into shape": "This is
 * not a pain point. We need to speak to the client's pain point"). What the person an offer is for is living with and
 * wants gone, in the owner's words, per gym and per offer — typed by him (kept at once), or suggested from the gym's
 * own best adverts and the copy library's pain-led skeletons (a draft until he keeps it). A drafted script opens on
 * one and says which; nothing is drafted until one is kept. A pain point is a situation ("work clothes fitting
 * tighter"), never a judgement of the viewer's body or health: Meta refuses adverts that assert a personal attribute
 * or set out to make someone feel bad about themselves, and `BODY_JUDGEMENT` holds the plainest of those words out.
 */
export const PAIN_LIMITS = { kept: 8, chars: [8, 120] };
const BODY_JUDGEMENT = /\b(overweight|obese|obesity|fat|fatter|flabby|chubby|ugly|disgusting|ashamed|embarrass(?:ed|ing)|hate (?:your|their)|depress(?:ed|ion)|lazy)\b/i;
const painKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
export function painProblems(text, profile = {}) {
  const t = norm(text), errs = [];
  if (t.length < PAIN_LIMITS.chars[0] || t.length > PAIN_LIMITS.chars[1]) errs.push(`a pain point is one short phrase, ${PAIN_LIMITS.chars[0]} to ${PAIN_LIMITS.chars[1]} characters (this is ${t.length})`);
  const j = t.match(BODY_JUDGEMENT); if (j) errs.push(`"${j[0]}" judges the person: say it as something that happens to them ("work clothes fitting tighter"), which is also what Meta allows`);
  if (/[{}]/.test(t)) errs.push("no braces in a pain point");
  for (const e of onAdProblems(t, profile)) errs.push(e);
  return errs;
}
/** Every offer's pain points on file: [{ offer, items[{ id, text, status: kept | draft | retired, source, from?, added, reason? }] }]. */
export const readPains = (gymDir) => Object.values(readScripts(gymDir).pains).filter((x) => x && Array.isArray(x.items));
/** The pain points a script for this offer may open on: the kept ones, in the order they were kept. */
export const painsFor = (gymDir, offer) => (readScripts(gymDir).pains[offerKey(offer)]?.items || []).filter((x) => x.status === "kept").map((x) => x.text);
/** Add a pain point for an offer: the owner's own is kept at once, a suggested one waits for him. Never twice. */
export function addPain(gymDir, offer, text, { profile = {}, source = "owner", from = null } = {}) {
  if (typeof offer !== "string" || norm(offer).length < 3) throw new Error("the offer's exact words are needed");
  const t = plainDashes(norm(text)).replace(/[.;,]+$/, ""), errs = painProblems(t, profile); if (errs.length) throw new Error(errs.join("; "));
  const data = readScripts(gymDir), slot = (data.pains[offerKey(offer)] ||= { offer: norm(offer), items: [] });
  if (slot.items.some((x) => painKey(x.text) === painKey(t))) throw Object.assign(new Error("this pain point is already here"), { duplicate: true });
  if (source === "owner" && slot.items.filter((x) => x.status === "kept").length >= PAIN_LIMITS.kept) throw new Error(`at most ${PAIN_LIMITS.kept} pain points are kept for one offer: retire one first`);
  const row = { id: `p-${sha(offerKey(offer) + "|" + painKey(t)).slice(0, 10)}`, text: t, status: source === "owner" ? "kept" : "draft", source, ...(from ? { from: norm(from).slice(0, 60) } : {}), added: today() };
  slot.items.push(row); slot.updated = today(); writeScripts(gymDir, data); return row;
}
/** The owner keeps a suggestion, edits one (checked again), puts it back, or retires it with a reason — never deleted. */
export function decidePain(gymDir, offer, id, { status, text, reason } = {}, { profile = {} } = {}) {
  const data = readScripts(gymDir), slot = data.pains[offerKey(offer)], row = slot?.items.find((x) => x.id === id);
  if (!row) throw new Error(`no such pain point: ${id}`);
  if (text != null) { const t = plainDashes(norm(text)).replace(/[.;,]+$/, ""), errs = painProblems(t, profile); if (errs.length) throw new Error(errs.join("; ")); if (slot.items.some((x) => x !== row && painKey(x.text) === painKey(t))) throw Object.assign(new Error("this pain point is already here"), { duplicate: true }); row.text = t; row.edited = today(); }
  if (status != null) {
    if (!["kept", "draft", "retired"].includes(status)) throw new Error("status must be kept, draft or retired");
    if (status === "retired") { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a pain point needs a reason"); row.reason = reason.trim(); row.retired_on = today(); }
    else { delete row.reason; delete row.retired_on; }
    if (status === "kept" && row.status !== "kept" && slot.items.filter((x) => x.status === "kept").length >= PAIN_LIMITS.kept) throw new Error(`at most ${PAIN_LIMITS.kept} pain points are kept for one offer: retire one first`);
    row.status = status;
  }
  slot.updated = today(); writeScripts(gymDir, data); return row;
}
const PAINS_SCHEMA = { type: "OBJECT", properties: { pains: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, from: { type: "STRING", enum: ["this gym's adverts", "the library", "the audience"] } }, required: ["text", "from"] } } }, required: ["pains"] };
/** What the suggestion is drawn from: the gym's own adverts that earned the most leads, and the copy library's pain-led skeletons. Read straight from the files: reading material only. */
export function painSources(gymDir, libDir = videoLibraryDir()) {
  const refs = (readJson(join(gymDir, "copy-references.json"))?.refs || []).filter((r) => !r.retired && typeof r.message === "string" && r.message.trim().length >= 40)
    .sort((a, b) => (b.results?.leads || 0) - (a.results?.leads || 0)).slice(0, 5).map((r) => ({ leads: r.results?.leads || 0, text: r.message.trim().slice(0, 700) }));
  const lib = (readJson(join(libDir, "copy-library.json"))?.entries || []).filter((e) => !e.retired && e.kind === "copy" && e.angle === "pain" && typeof e.text === "string").slice(0, 5).map((e) => e.text.trim().slice(0, 600));
  return { ads: refs, library: lib };
}
export function buildPainsPrompt({ profile = {}, offer, audience = null, count = 6, ads = [], library = [], existing = [] }) {
  const gym = profile.display_name || "the gym", never = (profile.brand_lock?.voice?.never || profile.voice?.never || []).filter(Boolean);
  const lines = [
    `List pain points for a talking-to-camera advert for ${gym}'s programme: "${offer}". ${audience ? `It is for: ${audience}.` : "It is for adults near the gym who are not training yet."} A pain point is what this person is living with now and wants gone: a moment of their ordinary day they would recognise at once and wince at.`,
    `Each is ONE short phrase of 5 to 14 words, with no full stop, written so it can follow "If you live in the area and …" — for example: "your work clothes have been fitting tighter lately", "you are out of breath after two flights of stairs", "your energy is gone by mid-afternoon", "you keep starting a routine and dropping it after two weeks". Concrete and specific: never vague ("getting back into shape", "wanting to be healthier", "putting off fitness" are NOT pain points).`,
    `Say what HAPPENS to the person, never what they ARE: nothing that judges or labels their body, weight, looks or health, nothing that shames, no medical condition, no number of kilos or sizes. NEVER: a price, free, before and after, a guarantee${never.length ? `, any of: ${never.join(", ")}` : ""}.`,
    `Give ${count}, each a different part of life (clothes, energy, strength for everyday things, sticking with it, time, confidence in a room).`,
  ];
  if (ads.length) lines.push(`This gym's own adverts that earned the most leads. Find the pain each one speaks to and say it plainly in your own words; never copy a sentence, a price or an offer from them:\n${ads.map((a, i) => `--- ADVERT ${i + 1} (${a.leads} leads)\n${a.text}`).join("\n")}`);
  if (library.length) lines.push(`Pain-led adverts that have worked for other gyms. The same: the pain they speak to, in your own words:\n${library.map((x, i) => `--- LIBRARY ${i + 1}\n${x}`).join("\n")}`);
  lines.push(`For each, say where it came from: "this gym's adverts", "the library", or "the audience" when it is from neither.`);
  if (existing.length) lines.push(`Already on the list — do not repeat or closely rephrase:\n${existing.map((e) => `- ${e}`).join("\n")}`);
  return { prompt: lines.join("\n\n"), schema: PAINS_SCHEMA };
}
/** Suggest pain points for an offer: one text call, every suggestion checked in code, each a draft until the owner keeps it. */
export async function suggestPains({ brandDir, offer, audience = null, count = 6, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (typeof offer !== "string" || offer.trim().length < 3) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("count must be 1 to 8");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, src = painSources(brandDir, libraryDir);
  const existing = (readScripts(brandDir).pains[offerKey(offer)]?.items || []).map((x) => x.text);
  const { prompt, schema } = buildPainsPrompt({ profile, offer: offer.trim(), audience, count, ...src, existing });
  const answer = await ask(null, prompt, schema, { model }), added = [], dropped = [];
  for (const d of answer?.pains || []) {
    try { added.push(addPain(brandDir, offer.trim(), d.text, { profile, source: "suggested", from: d.from })); }
    catch (e) { dropped.push({ text: norm(d.text), reason: e.message }); log(`  dropped: ${e.message}`); }
  }
  return { added, dropped, calls: 1, sources: { ads: src.ads.length, library: src.library.length } };
}

/** How many presenter videos a batch may ask for (each is one script, made once for every location). */
export const MAX_VIDEOS = 3;
export const videoCount = (videos) => (Number.isInteger(videos?.presenter) ? videos.presenter : 0);
/** What is wrong with a brief's `videos`: { presenter: 0…MAX_VIDEOS }. */
export function videosProblems(videos) {
  if (videos == null) return [];
  if (typeof videos !== "object" || Array.isArray(videos)) return ["videos must say how many of each kind: { presenter: 1 }"];
  const errs = [];
  for (const k of Object.keys(videos)) if (k !== "presenter") errs.push(`videos: "${k}" is not a kind of video (presenter)`);
  if (videos.presenter != null && !(Number.isInteger(videos.presenter) && videos.presenter >= 0 && videos.presenter <= MAX_VIDEOS)) errs.push(`videos.presenter must be a whole number from 0 to ${MAX_VIDEOS}`);
  return errs;
}
/**
 * Why an offer has no kept script, and what to press (2026-11-12: the owner pasted a sample, saw it on the screen and
 * was told "no script is kept" — a sample is a template, not a script). `state`: `drafts` (drafts for this offer wait
 * to be kept) · `other_offer` (scripts are kept, for other words) · `sample_only` (only a template is on file) · `none`.
 */
export function noScriptWhy(gymDir, offer, { libraryDir = videoLibraryDir(), profile = readJson(join(gymDir, "gym-profile.json")) || {} } = {}) {
  const all = readScripts(gymDir).scripts.filter((s) => s.status !== "retired"), key = norm(offer).toLowerCase();
  // Kept for this offer, but written before a rule it now breaks (the closing line): one edit, then it is filmed.
  const stale = all.filter((s) => s.status === "kept" && norm(s.offer).toLowerCase() === key).map((s) => scriptIssues(s, { profile, closing: closingLine(libraryDir) })).filter((e) => e.length).map((e) => [e.find((x) => /closing line/.test(x)) || e[0], ...e]);
  if (stale.length) return { state: "needs_edit", scripts: stale.length, issues: stale[0], text: `${stale.length === 1 ? "the script kept for this offer needs" : `${stale.length} scripts kept for this offer need`} an edit first — ${stale[0][0]}: press Edit… there` };
  const drafts = all.filter((s) => s.status === "draft" && norm(s.offer).toLowerCase() === key).length;
  if (drafts) return { state: "drafts", drafts, text: `${drafts} draft${drafts === 1 ? " for this offer is" : "s for this offer are"} waiting there: read ${drafts === 1 ? "it" : "them"} and press Keep` };
  const others = [...new Set(all.filter((s) => s.status === "kept").map((s) => s.offer))];
  if (others.length) return { state: "other_offer", offers: others, text: `the scripts kept there are for ${others.map((o) => `"${o}"`).join(", ")}: a script is written for one offer's exact words, so press Draft scripts… there for this one` };
  const samples = liveSamples(libraryDir).length;
  if (samples) return { state: "sample_only", samples, text: `nothing is written for this offer yet. The sample script there is a template, not a script to film: press Draft scripts…, read the drafts and keep one` };
  return { state: "none", text: "nothing is written for this offer yet: press Draft scripts… there, or write your own" };
}
/** The scripts a batch makes: that many of the ones kept for its offer, in an order the seed fixes (a re-run picks the same). Too few is refused by name. */
export function pickScripts(gymDir, { count, offer, seed = "batch", libraryDir = videoLibraryDir() } = {}) {
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, all = keptScripts(gymDir, offer), kept = readyScripts(gymDir, offer, { profile, closing: closingLine(libraryDir) });
  if (kept.length < count && all.length > kept.length) throw new Error(`${count} presenter video${count === 1 ? "" : "s"} asked for, but ${kept.length ? `only ${kept.length} script${kept.length === 1 ? " is" : "s are"}` : "no script is"} ready for "${norm(offer)}": ${noScriptWhy(gymDir, offer, { libraryDir, profile }).text} (Draft Scenes → Video scripts)`);
  if (kept.length < count) throw new Error(`${count} presenter video${count === 1 ? "" : "s"} asked for, but ${kept.length ? `only ${kept.length} script${kept.length === 1 ? " is" : "s are"}` : "no script is"} kept for "${norm(offer)}": keep ${count - kept.length} more on Draft Scenes → Video scripts${kept.length ? "" : ` (${noScriptWhy(gymDir, offer, { libraryDir }).text})`}`);
  return kept.map((s2) => ({ s: s2, k: sha(`${seed}|${s2.id}`) })).sort((a, b) => a.k.localeCompare(b.k)).slice(0, count).map((x) => x.s);
}
/** A script with what making it would take: its lines, each clip's length, and the seconds and image calls for a set of locations. */
export function scriptCost(script, areas = [""], { closing = closingLine() } = {}) {
  const n = Math.max(1, areas.length), said = filmedLines(script.lines, closing), clips = said.map((l) => ({ line: l, per_area: /\{AREA\}/.test(l), seconds: clipSeconds(fillLine(l, areas[0] || "Ang Mo Kio")) }));
  const seconds = clips.reduce((t, c) => t + c.seconds * (c.per_area ? n : 1), 0);
  return { clips, seconds, images: said.length, usd: Math.round((seconds * USD_PER_SECOND + said.length * USD_PER_IMAGE) * 100) / 100, videos: n };
}

const DRAFT_SCHEMA = { type: "OBJECT", properties: { scripts: { type: "ARRAY", items: { type: "OBJECT", properties: { pain: { type: "STRING" }, lines: { type: "ARRAY", items: { type: "STRING" } } }, required: ["pain", "lines"] } } }, required: ["scripts"] };
/**
 * The drafter's request. `pains`: the owner's own pain points for this offer, used first when he has kept some;
 * `ads` and `library` (`painSources`): what the drafter works the pain points out from when he has not — it is the
 * agent that proposes, and he reviews. Every script says the pain point it opens on.
 */
export function buildScriptPrompt({ profile = {}, offer, audience = null, count = 3, existing = [], facts = [], samples = [], pains = [], ads = [], library = [], closing = CLOSING_LINE }) {
  const gym = profile.display_name || "the gym", never = (profile.brand_lock?.voice?.never || profile.voice?.never || []).filter(Boolean);
  // "Aether Athletics' 6 Week…", never "Athletics's": the possessive as it is said and as the captions show it.
  const gyms = /s$/i.test(gym) ? `${gym}'` : `${gym}'s`;
  // With the owner's samples or his facts for this offer a script may run longer: it follows the sample's beats, cut to what is relevant and true here.
  const long = samples.length > 0 || facts.length > 0;
  const open = "says where — the place written as {AREA} (it is filled in for each location) — and opens on ONE pain point: what this person is living with and wants gone, said as a moment of their day they will recognise at once";
  const close = `THE ENDING is two beats, both in the last line. First ONE sentence that turns to the viewer and names what they want, tied to the pain the script opened on, in this shape: "If you're ready to [what they want], now is your time." Then exactly this sentence, word for word; it is the ONLY call to action in the script: "${closing}" Never go straight from a benefit into the call to action, and never use a bare lead-in ("If that sounds like you, …"). What they want is what they will FEEL or be able to DO (feel strong and at ease in their clothes again, have energy left for the evening), never an ideal body and never a promised result ("the body you've always wanted" is out). The last line may run to ${LINE_WORDS[1]} words. Never write "tap", never name a button, never add another instruction.`;
  const lines = [
    `You write short scripts for a talking-to-camera video advert for ${gym}'s programme: "${offer}". ${audience ? `The advert is for: ${audience}.` : "The advert is for adults near the gym who are not training yet."} Someone stands in the gym, talks to a phone camera the way a friend would, and the video cuts to a new spot for each line.`,
    long
      ? `A script is 3 to ${LINES[1]} lines, one for each cut: as many as there is something true and worth saying, and no more — shorter is better. Each line is one breath, ${LINE_WORDS[0] + 4} to ${LINE_WORDS[1] - 4} words, in plain spoken English: short sentences, no lists, nothing a person would not say out loud.`
      : `A script is exactly 3 lines. Each line is one breath, ${LINE_WORDS[0] + 4} to ${LINE_WORDS[1] - 4} words, in plain spoken English: short sentences, no lists, nothing a person would not say out loud.`,
    long
      ? `The first line ${open}. One of the first two lines names the programme in these exact words — "${gyms} ${offer}" — and says what it is FOR in this person's life. The lines between are the beats worth keeping${samples.length ? " from the sample you follow" : ""}: each fact you were given gets its own short line, said plainly; a beat that needs a fact you were NOT given (an assessment, a number of places, how many people were helped) is left out, never invented. ${close}`
      : `Line 1 ${open}. Line 2 names the programme in these exact words — "${gyms} ${offer}" — and says what it is FOR in this person's life. Line 3 is the ending. ${close}`,
    `Speak about BENEFITS, never features. A benefit is what changes for the person: feeling stronger, more energy for the day, clothes fitting better, confidence, keeping up with the children, a body that does what is asked of it. A feature is how the gym runs, and the script says NONE: nothing about how training is organised (no small groups, classes, one-to-one, personal training, session length, timetable, equipment, class size), because a wrong one is a false claim about this gym.${facts.length ? ` The only facts about the gym or the programme that may be stated are these, in the owner's words: ${facts.map((x) => `"${x}"`).join("; ")}. Say them as given, and nothing else about how the programme works.` : ""} A benefit is what the programme is built to help with, never a promised result.`,
    `The speaker is nobody in particular: NOT a coach, NOT a member, NOT the owner. So the script never says I, we, our, my or us, and never claims an experience ("I joined", "we built"): where a gym would say we, the script says "${gym}", "the coaches" or "the team". The closing sentence is the one exception: it is said word for word as given.`,
    `The place is only ever {AREA}, the area around the gym: the script never names the country, and never speaks to a whole city or island.`,
    `NEVER: a price or any money; free or a free trial; before and after; a guarantee; a result promised; a number of kilos, pounds or percent; a medical claim; a date; an exclamation mark (the closing sentence keeps its own); an em dash${never.length ? `; any of: ${never.join(", ")}` : ""}.`,
    `Write ${count} script${count === 1 ? "" : "s"}, each opening on a different pain point, and say for each the pain point it opens on (pain: a short phrase, as it would stand in a list — "work clothes fitting tighter lately").`,
    `PAIN POINTS. A pain point is something that HAPPENS to this person — work clothes fitting tighter, out of breath on the stairs, no energy left by mid-afternoon, starting a routine and dropping it within weeks — said the way they would say it to a friend. Never a judgement or a label of their body, weight, looks or health, nothing that shames, no medical condition; and never softened into something vague: "getting back into shape", "putting off fitness", "starting a fitness journey" are NOT pain points.${pains.length
      ? ` The owner's own list comes first — open on these, close to his words, one for each script${pains.length < count ? "; for the scripts beyond the list, work out further ones yourself the same way" : ""}:\n${pains.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
      : ` Work them out yourself before you write: who this advert is for, and what they are living with${ads.length || library.length ? ", drawing on the adverts below" : ""}.`}`,
  ];
  if (ads.length) lines.push(`This gym's own adverts that earned the most leads. Find the pain each one speaks to and say it plainly in your own words; never copy a sentence, a price or an offer from them:\n${ads.map((a, i) => `--- ADVERT ${i + 1} (${a.leads} leads)\n${a.text}`).join("\n")}`);
  if (library.length) lines.push(`Pain-led adverts that have worked for other gyms. The same: the pain they speak to, in your own words:\n${library.map((x, i) => `--- LIBRARY ${i + 1}\n${x}`).join("\n")}`);
  // The owner's own proven scripts, when he has given some: their structure, rhythm and voice are followed; their sentences and their facts are not copied.
  if (samples.length) lines.push(`These scripts have worked for this owner. Follow how they are built, how they sound and what they choose to talk about — never copy a sentence, and never carry over a fact (a place, a programme name, a number, how a gym runs) or their call to action. A sample may mark in braces what changes from gym to gym ({AREA}, {CHALLENGE NAME}, {GYM NAME} and the like): where it marks the place, write {AREA}; where it marks the programme, write its exact words, "${offer}"; where it marks the gym, or where the sample says we or our, write "${gym}". No other braces may appear in a script:\n${samples.map((x, i) => `--- SAMPLE ${i + 1}\n${x}`).join("\n")}`);
  if (existing.length) lines.push(`Already written — do not repeat or closely rephrase:\n${existing.map((e) => `- ${e}`).join("\n")}`);
  return { prompt: lines.join("\n\n"), schema: DRAFT_SCHEMA };
}
/**
 * Draft scripts for an offer: one text call, every draft checked in code, a broken or repeated one dropped with the
 * reason. Drafts wait for the owner. THE AGENT PROPOSES (2026-11-14, the owner: "the agent proposes the scripts for me
 * to review and edit (if necessary), not I tell the agent what to say"): nothing has to be typed first — the drafter
 * works the pain points out from the gym's own best adverts and the library's pain-led ones, his own kept ones first
 * when he has given some, and each draft carries the pain point it opens on, held to the pain points' own rules.
 */
export async function draftScripts({ brandDir, offer, audience = null, count = 3, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (typeof offer !== "string" || offer.trim().length < 3) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("count must be 1 to 6");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, pains = painsFor(brandDir, offer), closing = closingLine(libraryDir), src = painSources(brandDir, libraryDir);
  const { prompt, schema } = buildScriptPrompt({ profile, offer: offer.trim(), audience, count, existing: readScripts(brandDir).scripts.map((x) => x.lines.join(" / ")), samples: liveSamples(libraryDir).map((x) => x.text), facts: factsFor(brandDir, offer), pains, ...src, closing });
  const answer = await ask(null, prompt, schema, { model }), added = [], dropped = [];
  for (const d of answer?.scripts || []) {
    try {
      const pain = plainDashes(norm(d.pain)).replace(/[.;,]+$/, "");
      if (!pain) throw new Error("it does not say which pain point it opens on");
      const bad = painProblems(pain, profile); if (bad.length) throw new Error(`the pain point it opens on ("${pain}"): ${bad[0]}`);
      added.push(addScript(brandDir, { lines: d.lines, offer: offer.trim(), source: "drafted", pain }, { profile, closing }));
    } catch (e) { dropped.push({ text: (d.lines || []).join(" / "), reason: e.message }); log(`  dropped: ${e.message}`); }
  }
  return { added, dropped, calls: 1, sources: { pains: pains.length, ads: src.ads.length, library: src.library.length } };
}

// ── the model calls (each can be replaced: the tests make no call) ───────────
async function interact(body, { label, timeoutMs = 600000 } = {}) {
  const key = loadGeminiKey(); if (!key) throw new Error("GEMINI_KEY not found (.env or environment)");
  return whenGeminiFree(async () => {
    const res = await fetch(INTERACTIONS, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${label} failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
    return res.json();
  }, { label });
}
const WATCH_SCHEMA = { type: "OBJECT", properties: { spoken: { type: "STRING" }, on_screen_text: { type: "ARRAY", items: { type: "STRING" } }, people: { type: "INTEGER" }, lips_match_speech: { type: "BOOLEAN" }, faults: { type: "ARRAY", items: { type: "STRING" } }, looks_real: { type: "INTEGER" } }, required: ["spoken", "on_screen_text", "people", "lips_match_speech", "faults", "looks_real"] };
const WATCH_QUESTION = "Watch and listen to this short video. spoken: transcribe exactly every word spoken, in order, with nothing added; an empty string if nobody speaks. on_screen_text: every word or letter visible anywhere in the picture (signs, clothing, captions, watermarks), one entry each; empty if none. people: how many people are visible at any point. lips_match_speech: true only if the visible person's mouth moves in time with the spoken words. faults: every visible fault that would make a viewer think this is not real footage — warped hands or faces, objects that melt or pass through each other, impossible movement, a face that changes — each as a short phrase; empty if none. looks_real: 1 to 10, how convincingly this passes as phone footage shot in a real gym.";
/** The real models: a still from the gym's image model, a clip from Omni, a watching pass by the check model. */
export function realModels(profile = {}) {
  return {
    async image({ out, prompt, refs }) { const r = await generateImage(prompt, refs.map((p) => ({ inline_data: { mime_type: mimeOf(p), data: readFileSync(p).toString("base64") } })), { aspectRatio: "9:16", model: imageModelFor(profile) }); writeFileSync(out, r.buffer); },
    async clip({ out, image, prompt, seconds }) {
      const r = await interact({ model: OMNI, input: [{ type: "image", data: readFileSync(image).toString("base64"), mime_type: mimeOf(image) }, { type: "text", text: prompt }], response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", duration: `${seconds}s` } }, { label: `video ${basename(out)}` });
      let v = null; for (const s of [...(r.steps || [])].reverse()) for (const c of s.content || []) if (!v && c.type === "video") v = c;
      if (!v) throw Object.assign(new Error(`no video came back for ${basename(out)}`), { refused: true });
      if (v.data) writeFileSync(out, Buffer.from(v.data, "base64"));
      else if (v.uri) { const res = await fetch(v.uri.includes("alt=media") ? v.uri : `${v.uri}${v.uri.includes("?") ? "&" : "?"}alt=media`, { headers: { "x-goog-api-key": loadGeminiKey() } }); if (!res.ok) throw new Error(`the video could not be downloaded (${res.status})`); writeFileSync(out, Buffer.from(await res.arrayBuffer())); }
      else throw new Error("the video part carried neither data nor a uri");
    },
    async watch(file, { said = [] } = {}) {
      // A name is spelt the gym's way when it is heard ("Aether", not "Ether"; "F45", not "F forty-five"), and so is a word on the said-as list ("Quay", however it sounds): nothing else about the line is told.
      const named = profile.display_name ? ` The business is called "${profile.display_name}": where that name is spoken, write it exactly that way.` : "";
      const words = said.length ? ` ${said.map((x) => `"${x.word}"`).join(", ")} ${said.length === 1 ? "is a word" : "are words"} in what is spoken: write ${said.length === 1 ? "it" : "each"} as spelt here, however it sounds. pronounced: for ${said.length === 1 ? "that word" : "each of them"}, how the speaker said it, written the way it sounded (for example "kee" or "kway").` : "";
      const question = WATCH_QUESTION + named + words, schema = said.length ? { ...WATCH_SCHEMA, properties: { ...WATCH_SCHEMA.properties, pronounced: { type: "ARRAY", items: { type: "OBJECT", properties: { word: { type: "STRING" }, sounded_like: { type: "STRING" } }, required: ["word", "sounded_like"] } } } } : WATCH_SCHEMA;
      const out = await whenGeminiFree(async () => {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": loadGeminiKey() }, signal: AbortSignal.timeout(240000),
          body: JSON.stringify({ contents: [{ parts: [{ text: question }, { inline_data: { mime_type: "video/mp4", data: readFileSync(file).toString("base64") } }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 } }) });
        if (!res.ok) throw new Error(`the video check failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        return res.json();
      }, { label: "video check" });
      return JSON.parse(out.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}");
    },
  };
}

// ── the prompts ──────────────────────────────────────────────────────────────
const NO_WORDS = "There is no text of any kind anywhere in the picture: no captions, no subtitles, no titles, no logos, no watermark, no lettering on walls, screens or clothing.";
const PHONE = "It looks like real footage shot on a phone held upright by a friend: natural indoor light, slight handheld sway, real skin, nothing glossy or cinematic. One continuous shot with no scene cuts.";
/** Where the presenter stands for each line, in order: a new spot a line, the way the reference videos cut. */
export const SPOTS = ["beside the dumbbell rack", "in front of a rack or rig", "on the open floor with the machines behind", "next to a bench", "beside the cardio machines", "in front of a plain stretch of wall, the gym floor to one side", "at the edge of the open floor, the room stretching out behind"];
/** How each line is framed: the first real video's three stills were one spot at one distance, so its cuts hardly read. A different part of the room and a different distance for each. */
export const FRAMINGS = ["framed from the waist up", "a step closer, framed from the chest up, the camera a little to one side", "a few steps back, framed from the thighs up, more of the room showing", "framed from the waist up, from the other side of the room"];
export function stillPrompt({ presenter, profile, spot, first, framing = FRAMINGS[0] }) {
  const she = presenter.gender === "man" ? "He" : "She", pron = presenter.gender === "man" ? "his" : "her";
  return `A real photograph taken on a phone held upright, 9:16. ${first ? "" : `The person is the SAME person as in the first image: the same face, hair and clothes. `}${she} is ${presenterWords(presenter, profile)}, standing ${spot}${first ? "" : " — a different part of the room from the first image, with a different background behind"}. ${she} faces the camera, ${framing}, mid-sentence with one hand slightly raised as if explaining something to a friend, looking straight into the lens, relaxed and friendly. The room is the gym in the ${first ? "first" : "second"} image — its walls, ceiling, lights, equipment and floor — matched for the room only: nobody in that image appears, and ${she.toLowerCase()} is alone. Natural indoor light, real skin texture, nothing glossy, not a studio portrait; ${pron} hands are relaxed and natural. ${NO_WORDS}`;
}
export function clipPrompt({ presenter, profile, line, seconds, said = [] }) {
  const how = said.length ? ` ${said.map((x) => `"${x.word}" is pronounced "${x.say}"`).join("; ")}: ${presenter.gender === "man" ? "he" : "she"} says it that way.` : "";
  const she = presenter.gender === "man" ? "The man" : "The woman", pron = presenter.gender === "man" ? "His" : "Her", their = presenter.gender === "man" ? "his" : "her", voice = `${countryRules(profileCountry(profile)).demonym || "natural"} English`;
  return `Bring this photograph to life as ${seconds} seconds of video. ${she} keeps looking into the camera and says, in a warm, natural ${voice} voice, at an easy conversational pace: "${line}"${how} ${pron} mouth forms exactly these words, in time with ${their} voice, and says nothing else; the sentence is finished before the clip ends. ${pron} hands stay low and relaxed, with at most one small, slow gesture: no pointing, no counting on fingers, no hands near the face. No walking. Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. Keep ${their} face, hair, clothes and the room exactly as they are in the photograph. ${PHONE} ${NO_WORDS} Sound: ${their} voice, close and clear, over the quiet of an empty gym. No music.`;
}

// ── the text layer and the cut (software: no model) ──────────────────────────
/**
 * The captions' look (2026-11-14, the owner: "I like the classic simple look. But propose some variation either in
 * color or style, slightly" — he picked the third of five): white capitals with a thin outline and a soft shadow,
 * and the word being said in a warm yellow. No brand colour: it is the same on every gym's videos.
 */
export const CAPTION_ACCENT = "#FFD84A";
const FONTS = `@font-face{font-family:Anton;src:url("file://${join(REPO_ROOT, "assets/fonts/anton/Anton-Regular.ttf")}")}@font-face{font-family:Mont;src:url("file://${join(REPO_ROOT, "assets/fonts/montserrat/Montserrat[wght].ttf")}");font-weight:100 900}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A transparent 720 × 1280 PNG of the words. Meta's 9:16 live area is x 6–94%, y 14–65%: every block is laid inside it, and the page reports where each landed. */
async function overlay(browser, out, inner) {
  const html = `<!doctype html><meta charset="utf-8"><style>${FONTS}html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    .cap{position:absolute;left:8%;right:8%;top:54%;text-align:center;font:400 58px/1.12 Anton;color:#fff;letter-spacing:1px;-webkit-text-stroke:3px rgba(0,0,0,.85);paint-order:stroke fill;text-shadow:0 4px 16px rgba(0,0,0,.55)}
    .cap b{font-weight:400;color:${CAPTION_ACCENT}}</style>${inner}`;
  const page = join(browser.work, `${basename(out)}.html`); writeFileSync(page, html);
  const { cdp, sessionId } = browser;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `file://${page}` }, sessionId); await loaded;
  const box = await cdp.send("Runtime.evaluate", { expression: `document.fonts.ready.then(() => JSON.stringify([...document.querySelectorAll('.cap')].map(e => { const r = e.getBoundingClientRect(); return { text: e.innerText.replace(/\\s+/g, ' ').trim(), top: r.top / ${H}, bottom: r.bottom / ${H}, left: r.left / ${W}, right: r.right / ${W} }; })))`, awaitPromise: true, returnByValue: true }, sessionId);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  return { png: out, blocks: JSON.parse(box.result.value || "[]") };
}
/** The live area for words on a 9:16 video (Meta's Stories and Reels zone). */
export const LIVE = { left: 0.06, right: 0.94, top: 0.14, bottom: 0.65 };
const inLive = (b) => b.left >= LIVE.left - 0.001 && b.right <= LIVE.right + 0.001 && b.top >= LIVE.top - 0.001 && b.bottom <= LIVE.bottom + 0.001;
/** Quieter than this for this long is a pause; a sound shorter than MIN_VOICED is a click, not speech; a clip is cut this far before the first word and after the last. */
export const SILENCE_DB = -30, SILENCE_MIN = 0.2, MIN_VOICED = 0.25, LEAD = 0.12, TAIL = 0.25;
/** From ffmpeg's silence report and the file's length: where there is sound — `spans` [[a, b], …], each MIN_VOICED or longer — and the first and last of it. No sound found reads as the whole file. */
export function speechFrom(report, duration) {
  const starts = [...String(report).matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])), ends = [...String(report).matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const quiet = starts.map((a, i) => [a, ends[i] ?? duration]).sort((x, y) => x[0] - y[0]), spans = []; let at = 0;
  for (const [a, b] of quiet) { if (a - at >= MIN_VOICED) spans.push([at, a]); at = Math.max(at, b); }
  if (duration - at >= MIN_VOICED) spans.push([at, duration]);
  const r2 = (x) => Math.round(x * 100) / 100;
  return spans.length ? { start: r2(spans[0][0]), end: r2(spans[spans.length - 1][1]), spans: spans.map(([a, b]) => [r2(a), r2(b)]), duration } : { start: 0, end: duration, spans: [[0, duration]], duration };
}
/** Where someone speaks in a clip, measured from its sound (ffmpeg does the listening; no model call). */
export function speechOf(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN}`, "-f", "null", "-"], { encoding: "utf-8" });
  return speechFrom(r.stderr || "", durationOf(file));
}
/** A line in caption chunks: up to `per` words, and never across the end of a sentence or a clause. Each { text (trailing commas and stops not shown), ends: it closes a clause }. */
export function captionChunks(text, per = 3) {
  const out = []; let cur = [];
  for (const w of norm(text).split(" ").filter(Boolean)) { cur.push(w); if (cur.length >= per || /[.,;:!?]$/.test(w)) { out.push(cur.join(" ")); cur = []; } }
  if (cur.length) out.push(cur.join(" "));
  return out.map((c) => ({ text: c.replace(/[.,;:]+$/, ""), ends: /[.,;:!?]$/.test(c) }));
}
/** A clause's end is tied to a pause when the two fall within this share of the line of each other. */
export const SNAP = 0.15;
/**
 * Captions timed to the voice. The chunks share the SPOKEN time by their letters and the clock skips every pause, so
 * no caption sits through a silence waiting for its words; and where a clause ends near a pause, the caption changes
 * AT that pause — the next one starts with the next word spoken. `spans`: where there is speech, in the timeline
 * the captions are for. Each { text, from, to }.
 */
export function captions(text, spans, per = 3) {
  const chunks = captionChunks(text, per), n = chunks.length, r2 = (x) => Math.round(x * 100) / 100;
  const len = chunks.map((c) => c.text.length + 1), letters = len.reduce((t, x) => t + x, 0), dur = spans.map(([a, b]) => b - a), voiced = dur.reduce((t, x) => t + x, 0);
  // Voiced time → the clock: at a pause, the end of the span before it or (next) the start of the one after.
  const clock = (v, next) => { let left = v; for (const [i, [a, b]] of spans.entries()) { const d = b - a; if (left < d - 1e-6 || (!next && left <= d + 1e-6) || i === spans.length - 1) return a + Math.min(left, d); left -= d; } return spans[spans.length - 1][1]; };
  // Anchors (chunks done, voiced time used): the start, the end, and every clause end that falls near a pause.
  const anchors = [[0, 0]]; let cl = 0, gap = 0, used = 0;
  const gaps = []; for (const d of dur.slice(0, -1)) { used += d; gaps.push(used); }
  for (let k = 0; k < n - 1; k++) {
    cl += len[k]; if (!chunks[k].ends) continue;
    const f = cl / letters; let best = -1;
    for (let j = gap; j < gaps.length; j++) if (Math.abs(gaps[j] / voiced - f) < SNAP && (best < 0 || Math.abs(gaps[j] / voiced - f) < Math.abs(gaps[best] / voiced - f))) best = j;
    if (best >= 0) { anchors.push([k + 1, gaps[best]]); gap = best + 1; }
  }
  anchors.push([n, voiced]);
  const out = [];
  for (let s = 0; s < anchors.length - 1; s++) {
    const [i0, v0] = anchors[s], [i1, v1] = anchors[s + 1], share = len.slice(i0, i1).reduce((t, x) => t + x, 0); let v = v0;
    for (let i = i0; i < i1; i++) { const d = (len[i] / share) * (v1 - v0); out.push({ text: chunks[i].text, from: r2(clock(v, true)), to: r2(clock(v + d, false)) }); v += d; }
  }
  return out;
}
/**
 * The words of one caption block with when each is said: the block's time shared between its words by their letters
 * (an estimate — the voice is measured by its pauses, not word by word). Each { i, word, from, to }.
 */
export function captionWords(c) {
  const ws = String(c.text).split(" ").filter(Boolean), total = ws.reduce((t, w) => t + w.length + 1, 0), r2 = (x) => Math.round(x * 100) / 100; let at = c.from;
  return ws.map((w, i) => { const d = ((w.length + 1) / total) * (c.to - c.from), o = { i, word: w, from: r2(at), to: i === ws.length - 1 ? c.to : r2(at + d) }; at += d; return o; });
}
/** A caption block in capitals, the word at `lit` marked as the one being said. */
const capHtml = (text, lit) => `<div class="cap">${String(text).toUpperCase().split(" ").filter(Boolean).map((w, i) => (i === lit ? `<b>${esc(w)}</b>` : esc(w))).join(" ")}</div>`;
/** How long the last clip is held after its last word, so the video does not end on a clipped syllable (there is no end card). */
export const END_HOLD = 0.45;
/** Cut the clips together — each { file, from, to }, its spoken part — at one size and rate, and lay the timed words over it all. The video ends on the last clip. */
function assemble({ clips, overlays, out }) {
  const inputs = clips.flatMap((c) => ["-i", c.file]), n = clips.length;
  let chain = clips.map((c, i) => `[${i}:v]trim=${c.from}:${c.to},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1[c${i}];[${i}:a]atrim=${c.from}:${c.to},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(";")
    + ";" + clips.map((_, i) => `[c${i}][a${i}]`).join("") + `concat=n=${n}:v=1:a=1[v0][a]`;
  let last = "[v0]";
  // From its start up to, not including, its end: two words are never lit in one frame.
  overlays.forEach((o, i) => { const next = `[v${i + 1}]`; chain += `;${last}[${n + i}:v]overlay=0:0:enable='gte(t,${o.from})*lt(t,${o.to})'${next}`; last = next; });
  ff([...inputs, ...overlays.flatMap((o) => ["-i", o.png]), "-filter_complex", chain, "-map", last, "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  return out;
}

// ── where a script's pictures and clips are kept ─────────────────────────────
/**
 * Per gym and per script, not per batch (2026-11-14): `brands/{gym}/video-clips/{script id}/` holds the presenter's
 * pictures, the clips, each clip's check and the prompts. Every file is named for what made it (the picture: its
 * prompt and the room; the clip: its words and its picture), so a batch that films the script again finds what is
 * there and makes only the rest. The captions and the finished video stay with the batch.
 */
export const CLIPS_DIR = "video-clips";
export const clipStore = (gymDir, scriptId) => join(gymDir, CLIPS_DIR, scriptId);
const hasStills = (d) => existsSync(d) && readdirSync(d).some((f) => /^still-.*\.jpg$/.test(f));
/**
 * A script filmed before clips were kept per gym has them in its batches' folders: the first time, the pictures and
 * clips of ONE such folder are brought in — the first of `legacy` that has any (this batch's own, then the newest
 * other) — never a mix of two, since each batch invented its own presenter. Returns the folder taken from, or null.
 */
export function adoptClips(store, legacy = []) {
  if (existsSync(store)) return null;
  const from = legacy.find(hasStills); if (!from) return null;
  mkdirSync(store, { recursive: true }); let n = 0;
  for (const f of readdirSync(from)) if (/^(still|line)-/.test(f)) { copyFileSync(join(from, f), join(store, f)); n++; }
  writeFileSync(join(store, "adopted.json"), JSON.stringify({ from, files: n, on: today() }, null, 2) + "\n");
  return from;
}
const stillPromptFor = (i, presenter, profile) => stillPrompt({ presenter, profile, spot: SPOTS[i % SPOTS.length], framing: FRAMINGS[i % FRAMINGS.length], first: i === 0 });
const stillName = (i, prompt, room) => `still-${i + 1}-${sha(prompt + basename(room)).slice(0, 6)}.jpg`;
const altOf = (still) => still.replace(/\.jpg$/, "-b.jpg");
const clipName = (i, line, still, area, perArea, note = "") => `line-${i + 1}${perArea ? `-${slug(area)}` : ""}-${sha(line + basename(still) + (note ? `|said:${note}` : "")).slice(0, 6)}`;
const passedCheck = (seen, line, profile, sounds = []) => !!seen && sameWords(seen.spoken, line, { names: [profile.display_name].filter(Boolean), sounds }) && seen.people === 1 && !(seen.on_screen_text || []).length;
/**
 * What a script still needs filmed for these locations, by what is on file: { clips[{ line, area, seconds, on_file }],
 * seconds (to film, one clean pass), reused (seconds already filmed), images (pictures still to make) }. No call, and
 * nothing is written: before a script's first use of the store it looks where `adoptClips` would bring files from.
 */
export function videoNeeds({ gymDir, script, areas = [""], room = null, profile = readJson(join(gymDir, "gym-profile.json")) || {}, closing = closingLine(), store = clipStore(gymDir, script.id), legacy = [], saidList = saidAs() }) {
  const presenter = presenterOf(profile), said = filmedLines(script.lines, closing), where = existsSync(store) ? store : legacy.find(hasStills) || store;
  const files = existsSync(where) ? readdirSync(where) : [], clips = []; let images = 0;
  for (const [i, raw] of said.entries()) {
    const still = presenter && room ? stillName(i, stillPromptFor(i, presenter, profile), room) : null, perArea = /\{AREA\}/.test(raw);
    if (!still || !files.includes(still)) images++;
    for (const area of perArea ? (areas.length ? areas : [""]) : [null]) {
      const line = fillLine(raw, area || ""), say = saidIn(line, saidList), note = saidNote(say), names = still ? [clipName(i, line, still, area, perArea, note), clipName(i, line, altOf(still), area, perArea, note)] : [];
      const on_file = files.some((f) => /\.mp4$/.test(f) && names.some((nm) => f === `${nm}.mp4` || (f.startsWith(`${nm}-take`))) && passedCheck(readJson(join(where, f.replace(/\.mp4$/, ".check.json"))), line, profile, soundsOf(say)));
      clips.push({ line, area, seconds: clipSeconds(line), on_file });
    }
  }
  const sum = (xs) => xs.reduce((t, c) => t + c.seconds, 0);
  return { clips, seconds: sum(clips.filter((c) => !c.on_file)), reused: sum(clips.filter((c) => c.on_file)), images };
}

// ── making the videos of one script ──────────────────────────────────────────
/**
 * One script → one video for each location. Returns { videos[{ area, file, poster, seconds, lines[], notes[], failed? }], spent{ seconds, images, checks } }.
 * `spent` may be passed in (a batch's running count) and is added to; `caps { seconds, images }` are never passed:
 * a call that would pass one is not made, and the videos that needed it are refused with that as the reason.
 */
export async function makePresenterVideos({ gymDir, outDir, script, areas, offer, audience = null, room, profile = readJson(join(gymDir, "gym-profile.json")) || {}, caps = { seconds: 120, images: 6 }, spent = { seconds: 0, images: 0, checks: 0 }, takes = 2, models = realModels(profile), browser = null, closing = closingLine(), store = clipStore(gymDir, script.id), legacy = [join(outDir, script.id)], saidList = saidAs(), log = () => {}, onProgress = () => {} }) {
  const presenter = presenterOf(profile);
  if (!presenter) throw new Error("say who presents first (Ad defaults → Presenter): a woman or a man. Nothing is made until then");
  const errs = scriptProblems(script.lines, { offer, profile, closing }); if (errs.length) throw new Error(`this script cannot be made: ${errs.join("; ")}`);
  if (!areas?.length) throw new Error("a video needs a location");
  const whole = areas.find((a) => isWholeCountry(a)); if (whole) throw new Error(`"${whole}" is the whole country: a video says the area around the gym, never the country`);
  if (!room || !existsSync(room)) throw new Error("a photo of the gym's room is needed, so the video is in the gym's own room (Photos & assets → a cleaned premises photo)");
  if (!hasFfmpeg()) throw new Error("ffmpeg is not installed on this machine: run `brew install ffmpeg` once");
  // The captions are this batch's; the pictures and clips are the script's own, whatever batch films it.
  const dir = join(outDir, script.id); mkdirSync(dir, { recursive: true });
  const adopted = adoptClips(store, legacy); if (adopted) log(`what was already filmed for this script is reused (from ${basename(dirname(dirname(adopted)))})`);
  mkdirSync(store, { recursive: true });
  const own = !browser; if (own) browser = await launchBrowser();
  const within = (kind, n) => spent[kind] + n <= caps[kind];
  // The script as it is filmed: the closing line, when it is the whole last line, shares a cut with the line before it.
  const said = filmedLines(script.lines, closing), joined = said.length < script.lines.length;
  const label = (i) => (joined && i === said.length - 1 ? `lines ${i + 1} and ${i + 2} (one cut)` : `line ${i + 1}`);
  if (joined) log(`the closing line is filmed with line ${said.length} as one cut: Google's video model refuses it as a clip of its own`);
  const refusedAll = (why) => ({ videos: areas.map((area) => ({ area, script_id: script.id, failed: why })), spent });
  try {
    // A still for each line: the first from the room, the rest from the first (the same person) and the room.
    const stills = [];
    for (const [i] of said.entries()) {
      const prompt = stillPromptFor(i, presenter, profile);
      const out = join(store, stillName(i, prompt, room));
      if (!existsSync(out)) {
        if (!within("images", 1)) return { videos: areas.map((area) => ({ area, script_id: script.id, failed: `the cap of ${caps.images} image calls was reached before the presenter's stills were made` })), spent };
        spent.images++; onProgress({ stage: "still", line: i + 1 }); log(`still ${i + 1} of ${said.length}`);
        writeFileSync(out.replace(/\.jpg$/, ".prompt.txt"), prompt + "\n");
        // A picture Google refuses is asked for once more; refused again, nothing is filmed and that is said.
        try { await models.image({ out, prompt, refs: i === 0 ? [room] : [stills[0], room] }); }
        catch (e) {
          if (!isRefusal(e)) throw e; log(`  still ${i + 1}: refused by Google's image model — asked once more`);
          try { await models.image({ out, prompt, refs: i === 0 ? [room] : [stills[0], room] }); }
          catch (e2) { if (!isRefusal(e2)) throw e2; return refusedAll(`Google's image model refused the presenter's picture for ${label(i)} twice, under its content rules. Nothing else is lost: Run again asks once more; if it is refused again, change the presenter's look on Ad defaults`); }
        }
      }
      stills.push(out);
    }
    // A clip for each line — once, or once per location when the line says the area.
    const made = new Map(); // "i|area" or "i|" → { file, takes, passed, check, line, why }
    const clipFor = async (i, area) => {
      const perArea = /\{AREA\}/.test(said[i]), key = `${i}|${perArea ? area : ""}`; if (made.has(key)) return made.get(key);
      const line = fillLine(said[i], area), seconds = clipSeconds(line);
      const say = saidIn(line, saidList), nameFor = (pic) => clipName(i, line, pic, area, perArea, saidNote(say));
      // The picture this line is filmed from: its own, or — once a clip was refused on that one — the second picture made for it.
      let still = !existsSync(join(store, `${nameFor(stills[i])}.mp4`)) && existsSync(altOf(stills[i])) ? altOf(stills[i]) : stills[i];
      let take = 0, r = null, refused = 0; const passedTakes = [];
      const gaveUp = (why) => { r = { file: null, takes: take, passed: false, refused: true, line, why }; };
      while (take < takes && !(r && r.passed && !(r.check?.faults || []).length)) {
        take++; const name = nameFor(still), file = join(store, `${name}${take > 1 ? `-take${take}` : ""}.mp4`), checkFile = file.replace(/\.mp4$/, ".check.json");
        if (!(existsSync(file) && statSync(file).size > 1000)) {
          if (!within("seconds", seconds)) { if (!passedTakes.length) r = { file: null, takes: take - 1, passed: false, line, why: `the cap of ${caps.seconds} seconds of video was reached` }; take--; break; }
          spent.seconds += seconds; onProgress({ stage: "clip", line: i + 1, area: perArea ? area : null, take }); log(`${label(i)}${perArea ? ` (${area})` : ""}, take ${take}: ${seconds} s`);
          const prompt = clipPrompt({ presenter, profile, line, seconds, said: say }); writeFileSync(file.replace(/\.mp4$/, ".prompt.txt"), prompt + "\n");
          try { await models.clip({ out: file, image: still, prompt, seconds }); }
          catch (e) {
            // Google refused the request (its content rules): nothing was made, so nothing is counted and it is no take.
            // Asked once more as it is; then on a fresh picture of the presenter; then this video is refused, in words.
            if (!isRefusal(e)) throw e;
            spent.seconds -= seconds; take--; refused++;
            log(`  ${basename(file)}: refused by Google's video model under its content rules${refused === 1 && !passedTakes.length ? " — asked once more" : ""}`);
            if (passedTakes.length) break; // a take already passed: it is kept
            if (refused === 1) continue;
            if (refused === 2 && still === stills[i]) {
              const alt = altOf(stills[i]);
              if (!existsSync(alt)) {
                if (!within("images", 1)) { gaveUp(`refused by Google's video model under its content rules (twice), and the cap of ${caps.images} image calls leaves none for a fresh picture to try it on`); break; }
                spent.images++; onProgress({ stage: "still", line: i + 1 }); log(`  a fresh picture of the presenter for ${label(i)}`);
                const again = stillPrompt({ presenter, profile, spot: SPOTS[i % SPOTS.length], framing: FRAMINGS[(i + 1) % FRAMINGS.length], first: false });
                try { await models.image({ out: alt, prompt: again, refs: [stills[0], room] }); }
                catch (e2) { if (!isRefusal(e2)) throw e2; gaveUp("refused by Google's video model under its content rules (twice), and its image model refused a fresh picture to try it on"); break; }
              }
              still = alt; continue;
            }
            gaveUp(`refused by Google's video model under its content rules, ${refused} times and on two pictures of the presenter`); break;
          }
        }
        let seen = readJson(checkFile); if (!seen) { spent.checks++; seen = await models.watch(file, { said: say }); writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); }
        // A listed word heard said another way is a noted fault: the clip is made once more while takes are left, and it is never a refusal.
        const wrong = saidWrong(seen, say); if (wrong.length) seen = { ...seen, faults: [...(seen.faults || []), ...wrong] };
        const heard = sameWords(seen.spoken, line, { names: [profile.display_name].filter(Boolean), sounds: soundsOf(say) }), alone = seen.people === 1, clean = !(seen.on_screen_text || []).length;
        r = { file, takes: take, passed: heard && alone && clean, line, check: seen, why: !heard ? `it said "${norm(seen.spoken)}"` : !alone ? `${seen.people} people are in it` : !clean ? `words appear in the picture: ${seen.on_screen_text.join(", ")}` : null };
        if (r.passed) passedTakes.push(r);
        log(`  ${basename(file)}: ${r.passed ? "said as written, one person, no lettering" : r.why}${(seen.faults || []).length ? ` · noted: ${seen.faults.join("; ")}${r.passed && take < takes ? " — made once more" : ""}` : ""}`);
      }
      // Of the takes that passed, the one with the fewest noted faults (the later on a tie).
      if (passedTakes.length) r = { ...passedTakes.reduce((best, x) => ((x.check?.faults || []).length <= (best.check?.faults || []).length ? x : best)), takes: take };
      made.set(key, r); return r;
    };
    const videos = [];
    for (const area of areas) {
      const lines = []; for (const [i] of said.entries()) lines.push(await clipFor(i, area));
      const bad = lines.findIndex((l) => !l.passed);
      if (bad >= 0) {
        const l = lines[bad];
        // A refusal is said as what it is, with what to do; anything else as before.
        videos.push({ area, script_id: script.id, lines, ...(l.refused ? { refused: true } : {}), failed: l.refused ? `${label(bad)}: ${l.why}. Nothing else is lost: Run again tries only this cut; if it is refused again, change its words` : `line ${bad + 1} did not pass after ${l.takes} take${l.takes === 1 ? "" : "s"}: ${l.why}` }); continue;
      }
      onProgress({ stage: "cut", area });
      const overlays = [], blocks = []; let at = 0;
      const cuts = [];
      for (const [i, l] of lines.entries()) {
        // Where he speaks, measured from the sound; the clip is kept from a breath before to a breath after, and the captions follow the voice inside it.
        const sp = speechOf(l.file), from = Math.max(0, sp.start - LEAD), to = Math.min(sp.duration, sp.end + (i === lines.length - 1 ? END_HOLD : TAIL)); cuts.push({ file: l.file, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 }); l.speech = { start: sp.start, end: sp.end, kept: [cuts[i].from, cuts[i].to] };
        // One picture of the block for each of its words, that word lit while it is said.
        for (const [k, c] of captions(l.line, sp.spans.map(([a, b]) => [at + a - from, at + b - from])).entries()) for (const w of captionWords(c)) {
          if (!(w.to > w.from)) continue;
          const o = await overlay(browser, join(dir, `cap-${slug(area)}-${i + 1}-${String(k).padStart(2, "0")}-${w.i}.png`), capHtml(c.text, w.i)); overlays.push({ png: o.png, from: w.from, to: w.to }); if (w.i === 0) blocks.push(...o.blocks);
        }
        at += cuts[i].to - cuts[i].from;
      }
      const outside = blocks.filter((b) => !inLive(b));
      if (outside.length) { videos.push({ area, script_id: script.id, lines, failed: `the words do not fit Meta's live area: "${outside[0].text}"` }); continue; }
      const file = assemble({ clips: cuts, overlays, out: join(outDir, `${script.id}-${slug(area)}.mp4`) });
      const poster = file.replace(/\.mp4$/, ".jpg"); ff(["-ss", "0.8", "-i", file, "-frames:v", "1", "-q:v", "3", poster]);
      videos.push({ area, script_id: script.id, file, poster, seconds: Math.round(durationOf(file) * 10) / 10, lines, words: lines.map((l) => l.line), notes: [...new Set(lines.flatMap((l) => l.check?.faults || []))] });
    }
    return { videos, spent };
  } finally { if (own) await browser.close(); }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, list: { type: "boolean", default: false }, draft: { type: "boolean", default: false }, offer: { type: "string" }, audience: { type: "string" }, count: { type: "string", default: "3" }, keep: { type: "string" }, make: { type: "string" }, areas: { type: "string" }, out: { type: "string" }, room: { type: "string" }, "max-seconds": { type: "string", default: "90" }, "max-images": { type: "string", default: "5" }, takes: { type: "string", default: "2" } } });
  if (!v["brand-dir"] || !(v.list || v.draft || v.keep || v.make)) { console.error("Usage: presenter-video.mjs --brand-dir brands/<gym> (--list | --draft --offer \"…\" [--audience \"…\"] [--count 3] | --keep <id> | --make <id> --areas \"BISHAN,ANG MO KIO\" [--out <folder>] [--room <photo>] [--max-seconds 90] [--max-images 5] [--takes 2])"); process.exit(1); }
  const gymDir = resolve(v["brand-dir"]), profile = readJson(join(gymDir, "gym-profile.json")) || {};
  try {
    if (v.draft) { const d = await draftScripts({ brandDir: gymDir, offer: v.offer, audience: v.audience || null, count: parseInt(v.count, 10) || 3, log: console.log }); console.log(`${d.added.length} draft(s) added, ${d.dropped.length} dropped`); }
    if (v.keep) console.log(`kept ${decideScript(gymDir, v.keep, { status: "kept" }, { profile }).id}`);
    if (v.make) {
      const script = readScripts(gymDir).scripts.find((s) => s.id === v.make); if (!script) throw new Error(`no such script: ${v.make}`);
      if (script.status !== "kept") throw new Error("only a script you have kept is made into a video");
      const areas = String(v.areas || "").split(",").map((x) => x.trim()).filter(Boolean), cd = profile.creative_defaults || {};
      const room = v.room ? resolve(v.room) : join(gymDir, "brand-assets", cd.room_reference || "facility-clean/facility-01.png");
      const r = await makePresenterVideos({ gymDir, outDir: v.out ? resolve(v.out) : join(gymDir, "outputs", `videos-${today()}`), script, areas, offer: script.offer, room, profile, caps: { seconds: parseInt(v["max-seconds"], 10) || 90, images: parseInt(v["max-images"], 10) || 5 }, takes: parseInt(v.takes, 10) || 2, log: (m) => console.log(m) });
      for (const x of r.videos) console.log(x.failed ? `✕ ${x.area}: ${x.failed}` : `✓ ${x.area}: ${x.file} (${x.seconds} s)`);
      console.log(`spent: ${r.spent.seconds} s of video (about US$${(r.spent.seconds * USD_PER_SECOND).toFixed(2)}), ${r.spent.images} image call(s), ${r.spent.checks} check(s)`);
    }
    if (v.list || v.draft) for (const s of readScripts(gymDir).scripts) { const c = scriptCost(s, ["BISHAN"]); console.log(`\n${s.id} [${s.status}] for "${s.offer}" · ${c.seconds} s a location, about US$${c.usd}`); s.lines.forEach((l, i) => console.log(`  ${i + 1}. ${l}`)); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  process.exit(0);
}
