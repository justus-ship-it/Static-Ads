#!/usr/bin/env node
/**
 * paper-video.mjs — the white-paper video: the third kind of presenter video (2026-11-15).
 *
 * The owner's reference is one silent shot of 20 seconds: a coach holds a stack of hand-written sheets at her chest,
 * the viewer reads each one, she drops it to show the next. Here:
 *
 *   · SOFTWARE WRITES THE WORDS, NOT THE VIDEO MODEL. The image model makes ONE picture of the gym's invented presenter
 *     holding a stack of BLANK sheets; headless Chrome finds the paper in it and sets each sheet's words onto it in a
 *     marker hand (Permanent Marker, Apache licence), exact to the letter. The video model is then only asked to hold
 *     the sheet still and let it drop. Tested on his yes the same day (two sheets, US$0.86): the written words came
 *     back letter for letter on every frame read, and each sheet fell cleanly onto a blank one.
 *   · ONE CLIP FOR EACH SHEET, CUT ON THE DROP. Every clip starts from the same picture with its own words written
 *     on, so the cut hides in the drop. Where the sheet goes is measured, not guessed: the ink in the words' own
 *     patch of the frame is counted frame by frame (`inkSeries`), and the drop is where it falls away (`dropFrom`).
 *     The last sheet — the closing line — is held, not dropped.
 *   · A SHEET SCRIPT IS ITS OWN KIND OF SCRIPT (`video-scripts.json → sheets`): six to nine sheets of two to eight
 *     words, drafted by the agent for the owner to keep. The rules of a spoken script hold — the offer in its exact
 *     words, the closing line as the last sheet, no price, no free trial, no promised result, the gym as "we", never
 *     the whole country — and PLAIN WORDS (his ruling: "the plain words rule also applies to sheets").
 *   · SCARCITY ONLY FROM HIS FACTS. "10 people" or "limited spots" is on a sheet only when he has typed it as true
 *     of that gym's offer (What each challenge includes); the number must be the one he typed.
 *   · THE CHECK READS THE PAPER BACK. Two frames of every clip — early, and just before the drop — are read by the
 *     vision model and must say the sheet's words, letter for letter; the clip is watched once as well (nobody
 *     speaks, one person, no other lettering). A clip that fails is filmed again; one no take passed for goes into
 *     the cut flagged, for the owner on Pick Ads (the same parts, flags and takes as a spoken video, so Film this
 *     sheet again and Use this take anyway are the same code).
 *   · NO VOICE, NO MUSIC, NO CAPTIONS (his word: "silent is fine"): the room's own sound; the paper is the caption,
 *     and its words are kept inside Meta's 9:16 live area — where the paper hangs lower than that, the words are
 *     set in the part of it that is inside, and a picture that leaves too little of the paper there is made again.
 *   · WHAT THE TEST TAUGHT: the camera is told not to move (one clip pushed in, so the cut jumped back); the paper is
 *     asked for higher and larger; the marker font is one this repo may ship.
 *
 * What is filmed is kept per gym and script, as for a spoken script (`clipStore`): the picture, each sheet's written
 * still, the clips and their checks, every file named for what made it. A batch films only what is not there.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { join, resolve, basename } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { isRefusal } from "./gemini-busy.mjs";
import { callVision } from "./check-visual.mjs";
import { launchBrowser, isWholeCountry } from "./render-composites.mjs";
import { onAdProblems } from "./cards.mjs";
import { COPY_MODEL, plainDashes, gymLanguage } from "./draft-copy.mjs";
import { wordingRule, nameInAds } from "./client-config.mjs";
import { themeOf, themeRule, readScripts, writeScripts, coachStore, stillFault, stillWhy, presenterOf, presenterWords, realModels, closingLine, closingFor, endsWithClosing, closingAlone, plainWords, hardWords, PLAIN_RULE, FIRST_PERSON, FIRST_PERSON_ZH, isZh, units, zhForm, TAP, IDEAL_BODY, countryNamed, factsFor, painsFor, painSources, fillLine, wordCount, videoLibraryDir, clipStore, asideOf, ownerKeptClip, durationOf, hasFfmpeg, letteringOf, LIVE, USD_PER_SECOND, USD_PER_IMAGE } from "./presenter-video.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** A sheet script is 6 to 9 sheets; a sheet is 2 to 8 words (the closing line and the sheet with the offer's name may be longer). Each sheet is one clip of 4 seconds. */
export const SHEETS = [6, 9], SHEET_WORDS = [2, 8], SHEET_SECONDS = 4;
/** A Chinese sheet (2026-11-20, F45 Xinyi) is measured in characters, written in a pen hand that has Chinese (Iansui, OFL). */
export const SHEET_CHARS = [2, 14];
/** How long a sheet must stay readable; what is kept of a clip after its drop begins; how much of the last sheet is kept. */
export const MIN_HOLD = 1.6, LAST_KEEP = 3.2, DROP_FALL = 0.5;
/**
 * The cut between two sheets (2026-11-16, the owner on his first white-paper video: "the cut is so abrupt. it looks
 * super unnatural" — it cut the moment the words were gone, with the sheet still sliding in his hands; he picked the
 * second of two free re-cuts). A clip is kept `DROP_KEEP` seconds past its drop, so the sheet falls out of the frame
 * and the blank sheet behind shows; then the next clip — the same pose, its words on that sheet — fades in over
 * `SHEET_FADE` seconds, so the words come up on the blank paper instead of the picture jumping.
 */
export const DROP_KEEP = 0.5, SHEET_FADE = 0.25;
/** The paper in the picture: the least of the picture's width it may be, how blank it must be, how much of its height must be inside Meta's live area, the words' box on it, and the smallest the letters may be (of the picture's width). */
/** Pictures a white-paper video may make in one run: the first and two fresh ones (2026-11-21: it was two). */
export const BLANK_PER_RUN = 3;
export const PAPER = { min_w: 0.24, fill: 0.8, usable: 0.5, text_w: 0.78, pad: 0.08, min_letter: 0.034, skew: 0.12 };
export const PAPER_FONT = join(REPO_ROOT, "assets/fonts/permanentmarker/PermanentMarker-Regular.ttf");
export const PAPER_FONT_ZH = join(REPO_ROOT, "assets/fonts/iansui/Iansui-Regular.ttf");
const W = 720, H = 1280, FPS = 24, CHECK_V = 1;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const apos = (x) => String(x ?? "").replace(/[’‘]/g, "'");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
const ff = (args) => sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const round = (x, p = 100) => Math.round(x * p) / p;

// ── the script: the words on the sheets ──────────────────────────────────────
const NUM = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty)";
const SPOT = "(?:spots?|places?|slots?|seats?|spaces?)", PEOPLE = "(?:people|persons?|members?|women|men|ladies|guys|locals|mums|moms|dads|beginners)";
/** Scarcity, the way an advert says it: limited places, a number of people or places, a deadline. */
export const SCARCE_ZH = /\d+\s*位|名額|限量|只剩|僅剩|最後機會|額滿/;
export const SCARCE = new RegExp(`\\b(?:limited|${NUM} (?:more )?(?:${SPOT}|${PEOPLE})|${SPOT} (?:left|are|is|fill|filling|going|remaining|open)|only ${NUM} left|last chance|last few|few ${SPOT}|filling (?:up|fast)|sell(?:s|ing)? out|sold out|closing soon|ends? (?:soon|today|tonight|this week)|hurry|don'?t miss|while ${SPOT} last)\\b`, "i");
/** The letters and digits of a text, lower-cased: what "letter for letter" compares. */
export const lettersOf = (s) => (isZh(s) ? zhForm(s).replace(/[^a-z0-9\u3400-\u9fff\uf900-\ufaff]/g, "") : apos(s).toLowerCase().replace(/[^a-z0-9]/g, ""));
export const sameWriting = (read, text) => lettersOf(read) === lettersOf(text);
/** A sheet's words as they are written on the paper: plain quotes and three dots, which every marker font has. */
export const inkText = (s) => norm(s).replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...");
const UNWRITABLE = /[^\x20-\x7E’‘“”…]/, UNWRITABLE_ZH = /[^\x20-\x7E’‘“”…\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const scarceOf = (s, offer) => { const key = norm(offer).toLowerCase(), t = norm(s), rest = apos(key && t.toLowerCase().includes(key) ? t.toLowerCase().split(key).join(" ") : t); return isZh(rest) ? rest.match(SCARCE_ZH) : rest.match(SCARCE); };
/** The sheets of a script that say places are limited (never the last one, the closing line): [{ sheet (1-based), text, phrase }]. */
export const scarceSheets = (sheets, offer = null) => (sheets || []).map((s, i, a) => { const m = i < a.length - 1 ? scarceOf(s, offer) : null; return m ? { sheet: i + 1, text: norm(s), phrase: m[0] } : null; }).filter(Boolean);
/**
 * Whose word a script's scarcity sheet stands on (2026-11-16, the owner: "always include one, and recommend one for
 * the user to approve and fix"): `fact` — he typed it as true of the offer; `you` — he wrote or changed the sheet
 * himself, or said yes to it when keeping the script; null — the agent's suggestion, still waiting for his yes.
 */
export function scarcityOf(script, facts = []) {
  const first = scarceSheets(script.sheets, script.offer)[0]; if (!first) return null;
  const byFact = (facts || []).some((f) => SCARCE.test(apos(f)) || SCARCE_ZH.test(f));
  return { sheet: first.sheet, text: first.text, by: byFact ? "fact" : (script.scarce_ok || []).includes(lettersOf(first.text)) ? "you" : null };
}
/**
 * What is wrong with a sheet script, in words; empty when it may be filmed. `offer`: the exact words one sheet must
 * carry; `closing`: the sentence the last sheet is; `facts`: what the owner typed as true of this offer — said as it
 * is. A sheet about limited places is a claim about the gym, so it stands on the owner's word: a fact he typed (then
 * with its number), or the sheet's own words in `approved` (the letters of the sheets he wrote or said yes to).
 * `ask`: a draft — a suggested scarcity sheet is not a fault, it waits for his yes at Keep.
 */
export function sheetProblems(sheets, { offer = null, profile = {}, closing = closingLine(), plain = plainWords(), facts = [], approved = [], ask = false } = {}) {
  if (!Array.isArray(sheets) || sheets.length < SHEETS[0] || sheets.length > SHEETS[1]) return [`a white-paper script is ${SHEETS[0]} to ${SHEETS[1]} sheets`];
  closing = closingFor(sheets, closing);
  const errs = [], ss = sheets.map(norm), last = ss.length - 1, key = norm(offer).toLowerCase(), asIs = [offer, profile.display_name, closing, ...(facts || [])].filter(Boolean), zh = isZh(ss);
  const scarceFacts = (facts || []).filter((f) => SCARCE.test(apos(f)) || SCARCE_ZH.test(f)), factNumbers = new Set(scarceFacts.join(" ").match(/\d+/g) || []);
  ss.forEach((s, i) => {
    const filled = fillLine(s, "Ang Mo Kio"), hasOffer = !!key && s.toLowerCase().includes(key);
    if (zh) { const n = units(filled), most = hasOffer ? Math.max(SHEET_CHARS[1], units(offer) + 6) : SHEET_CHARS[1]; if (i !== last && (n < SHEET_CHARS[0] || n > most)) errs.push(`sheet ${i + 1} is ${n} characters: a sheet is ${SHEET_CHARS[0]} to ${most} characters, read in two seconds`); }
    else { const n = wordCount(filled), most = hasOffer ? Math.max(SHEET_WORDS[1], wordCount(offer) + 3) : SHEET_WORDS[1]; if (i !== last && (n < SHEET_WORDS[0] || n > most)) errs.push(`sheet ${i + 1} is ${n} word${n === 1 ? "" : "s"}: a sheet is ${SHEET_WORDS[0]} to ${most} words, read in two seconds`); }
    const odd = (s.match(/\{[^}]*\}/g) || []).filter((x) => x !== "{AREA}"); if (odd.length) errs.push(`sheet ${i + 1}: only {AREA} may stand in for a word (found ${odd.join(", ")})`);
    if (/[\n\r]/.test(String(sheets[i]))) errs.push(`sheet ${i + 1} is two lines: one sheet is one clip`);
    const unw = zh ? UNWRITABLE_ZH : UNWRITABLE;
    if (unw.test(s.replace(/\{AREA\}/g, ""))) errs.push(`sheet ${i + 1} has a character the ${zh ? "pen" : "marker"} cannot write ("${s.match(unw)[0]}"): plain letters, numbers and punctuation only`);
    if (i === last) return;
    const own = s.replace(/\{AREA\}/g, "");
    if (zh && FIRST_PERSON_ZH.test(own)) errs.push(`sheet ${i + 1} speaks as one person ("我"): the gym speaks as 我們, never as a coach or a member with a story of their own`);
    if (FIRST_PERSON.test(own)) errs.push(`sheet ${i + 1} speaks as one person ("${own.match(FIRST_PERSON)[0]}"): the gym speaks as we, our and us, never as a coach or a member with a story of their own (I, my, me)`);
    if (TAP.test(s)) errs.push(`sheet ${i + 1} says "${s.match(TAP)[0]}": the only call to action is the closing line, on the last sheet`);
    const ideal = apos(s).match(IDEAL_BODY); if (ideal) errs.push(`sheet ${i + 1} promises an ideal body ("${ideal[0]}"): say what the person will feel or be able to do`);
    const country = countryNamed(s, { profile, offer }); if (country) errs.push(`sheet ${i + 1} names the whole country ("${country}"): the place is only ever {AREA}, the area around the gym`);
    for (const h of hardWords(s, { allow: asIs, plain })) errs.push(h.why === "listed" ? `sheet ${i + 1}: "${h.word}" is not a plain word — say "${h.say}"` : `sheet ${i + 1}: "${h.word}" is a long word — say it in small words`);
    // Scarcity is a claim about the gym: it stands on the owner's word — his typed fact (with its number), or this sheet's own words.
    const scarce = scarceOf(s, offer);
    if (scarce) {
      const num = String(scarce[0]).match(/\d+/)?.[0];
      if (scarceFacts.length) { if (num && factNumbers.size && !factNumbers.has(num)) errs.push(`sheet ${i + 1} says "${scarce[0]}": the number you typed for this offer is ${[...factNumbers].join(" or ")} (What each challenge includes)`); }
      else if (!ask && !approved.includes(lettersOf(s))) errs.push(`sheet ${i + 1} says places are limited ("${scarce[0]}"): that is a claim about this gym, so it stands on your word — say it is true when you keep the script, write the sheet yourself, or type it under What each challenge includes (e.g. "Only 10 places")`);
    }
  });
  if (!(endsWithClosing(ss[last], closing) && closingAlone(ss[last], closing))) errs.push(`the last sheet is the closing line, word for word, and nothing else: "${closing}"`);
  if (key && !ss.some((s) => s.toLowerCase().includes(key))) errs.push(`one sheet must name the offer in its exact words: "${norm(offer)}"`);
  for (const e of onAdProblems(fillLine(ss.join(" "), "Bishan"), profile)) if (!errs.includes(e)) errs.push(e);
  return errs;
}
const shapeOf = (sheets) => sheets.map(lettersOf).join("|");
const tidy = (sheets, closing) => (sheets || []).map((s) => plainDashes(norm(s))).filter(Boolean).map((s, i, a) => (i === a.length - 1 && endsWithClosing(s, closing) && closingAlone(s, closing) ? closing : s));
export const readSheetScripts = (gymDir) => readScripts(gymDir).sheets;
/** Add a sheet script: the owner's own is kept at once, a drafted one waits for him. Never twice. */
export function addSheetScript(gymDir, { sheets, offer, source = "owner", pain = null }, { profile = {}, closing = closingLine(), plain = plainWords() } = {}) {
  if (typeof offer !== "string" || norm(offer).length < 3) throw new Error("the offer's exact words are needed");
  // His own sheets are his word, scarcity included; a drafted script's scarcity sheet is a suggestion that waits for his yes.
  const ss = tidy(sheets, closing), own = source === "owner", ok = own ? scarceSheets(ss, offer).map((x) => lettersOf(x.text)) : [];
  const errs = sheetProblems(ss, { offer, profile, closing, plain, facts: factsFor(gymDir, offer), approved: ok, ask: !own });
  if (errs.length) throw new Error(errs.join("; "));
  const data = readScripts(gymDir), key = shapeOf(ss);
  if (data.sheets.some((s) => shapeOf(s.sheets) === key)) throw Object.assign(new Error("this script is already here"), { duplicate: true });
  const row = { id: `p-${sha(key).slice(0, 10)}`, sheets: ss, offer: norm(offer), status: own ? "kept" : "draft", source, added: today(), ...(pain ? { pain } : {}), ...(ok.length ? { scarce_ok: ok } : {}) };
  data.sheets.push(row); writeScripts(gymDir, data); return row;
}
/** The owner keeps a draft, edits it (checked again), puts it back, or retires it with a reason — never deleted. One that breaks today's rules is not kept until it is edited. */
export function decideSheetScript(gymDir, id, { status, sheets, reason, scarcity_ok = false } = {}, { profile = {}, closing = closingLine(), plain = plainWords() } = {}) {
  const data = readScripts(gymDir), row = data.sheets.find((s) => s.id === id);
  if (!row) throw new Error(`no such white-paper script: ${id}`);
  const facts = factsFor(gymDir, row.offer), check = (ss, approved, ask) => sheetProblems(ss, { offer: row.offer, profile, closing, plain, facts, approved, ask });
  const yes = (ss, had) => { const now = scarceSheets(ss, row.offer).map((x) => lettersOf(x.text)); return scarcity_ok === true ? now : now.filter((x) => had.includes(x)); };
  let ok = row.scarce_ok || [];
  if (sheets != null) {
    // A sheet he wrote or changed himself is his word; a suggested one he left alone still waits for his yes.
    const ss = tidy(sheets, closing), before = row.sheets.map(lettersOf), mine = scarceSheets(ss, row.offer).map((x) => lettersOf(x.text)).filter((x) => !before.includes(x));
    ok = yes(ss, [...ok, ...mine]);
    const errs = check(ss, ok, (status ?? row.status) !== "kept"); if (errs.length) throw new Error(errs.join("; "));
    row.sheets = ss; row.edited = today();
  } else ok = yes(row.sheets, ok);
  if (status != null) {
    if (!["kept", "draft", "retired"].includes(status)) throw new Error("status must be kept, draft or retired");
    if (status === "retired") { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a script needs a reason"); row.reason = reason.trim(); row.retired_on = today(); }
    else { delete row.reason; delete row.retired_on; }
    if (status === "kept" && row.status !== "kept") {
      const errs = check(row.sheets, ok, false), wait = scarcityOf({ ...row, scarce_ok: ok }, facts);
      if (errs.length && wait && wait.by == null && !check(row.sheets, ok, true).length) throw Object.assign(new Error(`sheet ${wait.sheet} says "${wait.text}": that is the agent's suggestion. Say it is true of this offer to keep the script, or change the sheet first`), { scarcity: wait });
      if (errs.length) throw new Error(`edit it first: ${errs.join("; ")}`);
    }
    row.status = status;
  }
  if (ok.length) row.scarce_ok = ok; else delete row.scarce_ok;
  writeScripts(gymDir, data); return row;
}
const sameOffer = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
export const keptSheetScripts = (gymDir, offer = null) => readSheetScripts(gymDir).filter((s) => s.status === "kept" && (!offer || sameOffer(s.offer, offer)));
/** What a sheet script on file breaks by today's rules: empty when it may be filmed. */
export const sheetIssues = (script, { profile = {}, closing = closingLine(), plain = plainWords(), gymDir = null } = {}) => sheetProblems(script.sheets, { offer: script.offer, profile, closing, plain, facts: gymDir ? factsFor(gymDir, script.offer) : [], approved: script.scarce_ok || [], ask: script.status === "draft" });
export const readySheetScripts = (gymDir, offer = null, opts = {}) => keptSheetScripts(gymDir, offer).filter((x) => !sheetIssues(x, { gymDir, ...opts }).length);
/**
 * The edit a white-paper script needs, proposed by the agent for the owner to approve (2026-11-19; the spoken
 * scripts have had it since 2026-11-14). One text call, a second only when the first answer still breaks a rule;
 * every proposal is checked in code and one that still breaks a rule is not offered. Nothing is saved:
 * { sheets, changed (sheet numbers), note, problems (what it mends), yours (what only the owner can settle) }.
 * **The sheet about limited places is never the agent's to change**: it is a claim about the gym that stands on the
 * owner's word, and a sheet saved through Edit counts as his — so a proposal that touches, adds or drops one is not
 * offered, and a script whose only fault is that sheet is said to be his to settle, with no call.
 */
const SHEET_EDIT_SCHEMA = { type: "OBJECT", properties: { sheets: { type: "ARRAY", items: { type: "STRING" } }, note: { type: "STRING" } }, required: ["sheets", "note"] };
const SCARCITY_PROBLEM = /says places are limited|the number you typed for this offer/;
export function buildSheetEditPrompt({ profile = {}, script, problems, closing = closingLine(), facts = [] }) {
  const gym = profile.display_name || "the gym", never = (profile.brand_lock?.voice?.never || profile.voice?.never || []).filter(Boolean), scarce = scarceSheets(script.sheets, script.offer).map((x) => x.sheet);
  return { schema: SHEET_EDIT_SCHEMA, prompt: [
    `This is the script of a silent video advert for ${gym}'s programme "${script.offer}". One person holds a stack of hand-written sheets of paper; the viewer reads the front sheet, it is dropped, and the next one shows. The script is the words on the sheets, in order:\n${script.sheets.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `WHAT IS WRONG WITH IT:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    `Make the SMALLEST edit that mends this. Keep every sheet that breaks no rule exactly as it is, word for word and in its place. A sheet with too many words is said in fewer words, or split over two sheets with "…" at the break; where a word is not a plain word, write the whole sheet again in small words so that it still reads as a sentence.${scarce.length ? ` Sheet ${scarce.join(" and ")} says places are limited: leave it exactly as it is, letter for letter.` : ""} Never add a sheet about limited places, a number, a date or any fact about the gym.`,
    `THE RULES every sheet is held to. ${SHEETS[0]} to ${SHEETS[1]} sheets. Each sheet is ${SHEET_WORDS[0]} to ${SHEET_WORDS[1]} words — the last sheet and the sheet with the programme's name may be longer. One sheet names the programme in its exact words, "${script.offer}". The last sheet is exactly this and nothing else: "${closing}". The gym speaks as "we" and "our"; never "I", "my" or "me". The place is only ever written {AREA}; never a country or a city. Never: a price, free, a trial, before and after, a guarantee, a promised result, a number of kilos or sizes, an ideal body, "tap", an emoji, a hashtag, an em dash.${never.length ? ` Never these words: ${never.join(", ")}.` : ""}`,
    PLAIN_RULE,
    facts.length ? `THE FACTS the owner has typed as true of this programme (said as they are; state no other):\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    `Answer with every sheet of the script after the edit, in order, and a note of one sentence saying what you changed.`,
  ].filter(Boolean).join("\n\n") };
}
export async function proposeSheetEdit({ brandDir, id, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL }) {
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, script = readScripts(brandDir).sheets.find((x) => x.id === id);
  if (!script) throw new Error(`no such white-paper script: ${id}`);
  const closing = closingLine(libraryDir), plain = plainWords(libraryDir), facts = factsFor(brandDir, script.offer);
  const rules = (ss) => sheetProblems(ss, { offer: script.offer, profile, closing, plain, facts, approved: script.scarce_ok || [], ask: script.status === "draft" });
  const all = rules(script.sheets), yours = all.filter((p) => SCARCITY_PROBLEM.test(p)), problems = all.filter((p) => !SCARCITY_PROBLEM.test(p));
  if (!all.length) throw new Error("this script breaks no rule: nothing to propose");
  if (!problems.length) throw new Error(`what this script needs is yours to say, not the agent's: ${yours[0]}`);
  const scarceWas = scarceSheets(script.sheets, script.offer).map((x) => lettersOf(x.text)).sort().join("|");
  let left = problems, calls = 0;
  for (let round = 0; round < 2; round++) {
    const { prompt, schema } = buildSheetEditPrompt({ profile, script, problems: left, closing, facts });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    const sheets = tidy(answer?.sheets, closing);
    left = scarceSheets(sheets, script.offer).map((x) => lettersOf(x.text)).sort().join("|") !== scarceWas ? ["the edit changed what the script says about limited places: that sheet is the owner's, leave it exactly as it is and add none"] : rules(sheets).filter((p) => !SCARCITY_PROBLEM.test(p));
    if (!left.length) { const was = script.sheets.map(norm); return { sheets, changed: sheets.map((s, i) => (s === (was[i] ?? "") ? 0 : i + 1)).filter(Boolean).concat(was.length > sheets.length ? [sheets.length] : []).filter((x, i, a) => a.indexOf(x) === i), note: norm(answer?.note), problems, yours, calls }; }
  }
  throw new Error(`the agent's edit still breaks a rule (${left[0]}): edit the script yourself`);
}
/** Why an offer has no white-paper script ready, and what to press. */
export function noSheetScriptWhy(gymDir, offer, { libraryDir = videoLibraryDir(), profile = readJson(join(gymDir, "gym-profile.json")) || {} } = {}) {
  const all = readSheetScripts(gymDir).filter((s) => s.status !== "retired"), opts = { profile, closing: closingLine(libraryDir), plain: plainWords(libraryDir), gymDir };
  const stale = all.filter((s) => s.status === "kept" && sameOffer(s.offer, offer)).map((s) => sheetIssues(s, opts)).filter((e) => e.length);
  if (stale.length) return { state: "needs_edit", scripts: stale.length, text: `${stale.length === 1 ? "the white-paper script kept for this offer needs" : `${stale.length} white-paper scripts kept for this offer need`} an edit first — ${stale[0][0]}: press Edit… there` };
  const drafts = all.filter((s) => s.status === "draft" && sameOffer(s.offer, offer)).length;
  if (drafts) return { state: "drafts", drafts, text: `${drafts} draft${drafts === 1 ? " for this offer is" : "s for this offer are"} waiting there: read ${drafts === 1 ? "it" : "them"} and press Keep` };
  const others = [...new Set(all.filter((s) => s.status === "kept").map((s) => s.offer))];
  if (others.length) return { state: "other_offer", offers: others, text: `the white-paper scripts kept there are for ${others.map((o) => `"${o}"`).join(", ")}: a script is written for one offer's exact words, so press Draft sheets… there for this one` };
  return { state: "none", text: "nothing is written for this offer yet: press Draft sheets… there, or write your own" };
}
/** The sheet scripts a batch makes: that many of the ones ready for its offer, in an order the seed fixes. Too few is refused by name. */
export function pickSheetScripts(gymDir, { count, offer, seed = "batch", libraryDir = videoLibraryDir(), reuse = 1, pin = null, fresh = null } = {}) {
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, ready = readySheetScripts(gymDir, offer, { profile, closing: closingLine(libraryDir), plain: plainWords(libraryDir) });
  // `pin`: the sheet script each white-paper video films, in order (the brief's `paper_scripts`); `fresh`: the ids already filmed — a new batch takes the others first (2026-11-22).
  if (pin) {
    const byId = new Map(ready.map((x) => [x.id, x])), missing = pin.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`the batch names white-paper script${missing.length === 1 ? "" : "s"} ${[...new Set(missing)].join(", ")}, which ${missing.length === 1 ? "is" : "are"} not kept and ready for "${norm(offer)}"`);
    return pin.slice(0, count).map((id) => byId.get(id));
  }
  if (ready.length * Math.max(1, reuse) < count) throw new Error(`${count} white-paper video${count === 1 ? "" : "s"} asked for, but ${ready.length ? `only ${ready.length} white-paper script${ready.length === 1 ? " is" : "s are"}` : "no white-paper script is"} ready for "${norm(offer)}": ${noSheetScriptWhy(gymDir, offer, { libraryDir, profile }).text} (Draft Scenes → Video scripts → White-paper scripts)`);
  const order = ready.map((s) => ({ s, k: sha(`${seed}|${s.id}`) })).sort((a, b) => (fresh ? Number(fresh.has(a.s.id)) - Number(fresh.has(b.s.id)) : 0) || a.k.localeCompare(b.k)).map((x) => x.s);
  return Array.from({ length: count }, (_, i) => order[i % order.length]);
}
/** What making a sheet script takes: one picture, one clip a sheet (a sheet that says the area: one for each location). */
export function sheetCost(script, areas = [""]) {
  const n = Math.max(1, areas.length), clips = script.sheets.map((s) => ({ sheet: s, per_area: /\{AREA\}/.test(s), seconds: SHEET_SECONDS }));
  const seconds = clips.reduce((t, c) => t + c.seconds * (c.per_area ? n : 1), 0);
  return { clips, seconds, images: 1, usd: round(seconds * USD_PER_SECOND + USD_PER_IMAGE), videos: n };
}

// ── drafting ─────────────────────────────────────────────────────────────────
const DRAFT_SCHEMA = { type: "OBJECT", properties: { scripts: { type: "ARRAY", items: { type: "OBJECT", properties: { sheets: { type: "ARRAY", items: { type: "STRING" } } }, required: ["sheets"] } } }, required: ["scripts"] };
/**
 * The sheet drafter's request for a gym whose ads are in Chinese (2026-11-22; F45 Xinyi's five sheet scripts were
 * written by hand). The English drafter's shape and rules, said for Chinese: sheets measured in characters, 我們 for
 * the gym, the Chinese closing sentence on the last sheet, the gym's own wording, and `models` — the sheet scripts the
 * owner has already approved here, as the standard.
 */
export function buildSheetPromptZh({ profile = {}, offer, audience = null, count = 3, facts = [], pains = [], ads = [], library = [], existing = [], closing = closingLine(), refused = [], theme = null, models = [] }) {
  const gym = nameInAds(profile), never = (profile.brand_lock?.voice?.never || []).filter(Boolean), end = closingFor(["中"], closing), scarce = facts.filter((f) => SCARCE_ZH.test(f) || SCARCE.test(apos(f))), house = wordingRule(profile);
  return { schema: DRAFT_SCHEMA, prompt: [
    `Write ${count} script${count === 1 ? "" : "s"} for a silent video advert for ${gym}'s programme 「${offer}」${audience ? `, for ${audience}` : ""}. In the video one coach stands in the gym holding a stack of hand-written sheets of paper. Nobody speaks. The viewer reads the front sheet, it is dropped, and the next one shows. A script is the words on the sheets, in order.`,
    `LANGUAGE: Traditional Chinese as written by hand in Taiwan (zh-TW): everyday words, never formal or mainland wording, never a simplified character, no English word except the gym's own name; digits for numbers (10位). Only characters a pen writes: no emoji, no hashtag.`,
    `THE SHAPE:
1. One or two sheets that call the right person out, or name ONE thing that bothers them in their day — a moment of their day, never a judgement of them (「忙完工作累到不想動？」).
2. One sheet that names the programme in its exact characters, 「${offer}」, with at most a few characters around it (「加入我們的${offer}」).
3. One to three sheets of what they get. ${facts.length ? "Each fact below may be its own sheet, in a few of its own words; say nothing else about how the programme works." : "Nothing about how the programme works was given, so say what the person will feel or be able to do, and state no fact about the gym."}
4. ALWAYS exactly one sheet of scarcity, just before the last sheet. ${scarce.length ? `Say it only as the facts state it (${scarce.map((f) => `「${f}」`).join("、")}): the same number, nothing added (「只找10位！」).` : "The owner has typed no number of places, so say that places are limited with NO number and no date (「名額有限！」) — for the owner to check. Never invent a number of people or places, and never a deadline."}
5. The last sheet is exactly this, and nothing else: 「${end}」`,
    `THE RULES. ${SHEETS[0]} to ${SHEETS[1]} sheets. Each sheet is ${SHEET_CHARS[0]} to ${SHEET_CHARS[1]} characters — the last sheet and the sheet with the programme's name may be longer — a phrase read in two seconds. A sentence may run over two sheets, with … at the break. The gym speaks as 我們; never 我 alone. At most one sheet may call people out by where they live, with the place written exactly {AREA} in Latin capitals and braces (「住在{AREA}附近？」): never a country or a city. Never: a price, 免費, a trial (試用, 體驗課), before and after, a guarantee (保證), a promised result, a number of kilos or sizes, an ideal body, a button's name, a dash.${never.length ? ` Never these words: ${never.join(", ")}.` : ""} Each script takes a different way in.`,
    house,
    facts.length ? `THE FACTS the owner has typed as true of this programme (the only ones that may be stated):\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    theme ? themeRule(theme, "script") + " The first one or two sheets name it; the sheets of what they get answer it." : pains.length ? `WHAT BOTHERS THESE PEOPLE, in the owner's words (open on one of these):\n${pains.map((p) => `- ${p}`).join("\n")}` : (ads.length || library.length) ? `READING MATERIAL for what bothers these people (never copy a sentence):\n${[...ads.map((a) => a.text), ...library].slice(0, 6).map((t) => `--- ${t}`).join("\n")}` : "",
    models.length ? `THE STANDARD — sheet scripts the owner has already approved for this gym. Write to this standard (how short the sheets are, how they open and build); never copy a script, and open differently from each of them:\n${models.map((m, i) => `--- APPROVED ${i + 1}\n${m.join(" / ")}`).join("\n")}` : "",
    existing.length ? `ALREADY WRITTEN (write something different):\n${existing.map((e) => `- ${e}`).join("\n")}` : "",
    refused.length ? `THESE WERE REFUSED — do not make the same mistake:\n${refused.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n") };
}
export function buildSheetPrompt({ profile = {}, offer, audience = null, count = 3, facts = [], pains = [], ads = [], library = [], existing = [], closing = closingLine(), refused = [], theme = null, models = [] }) {
  if (gymLanguage(profile) === "zh") return buildSheetPromptZh({ profile, offer, audience, count, facts, pains, ads, library, existing, closing, refused, theme, models });
  const gym = profile.display_name || "the gym", never = (profile.brand_lock?.voice?.never || profile.voice?.never || []).filter(Boolean), scarce = facts.filter((f) => SCARCE.test(apos(f)));
  return { schema: DRAFT_SCHEMA, prompt: [
    `Write ${count} script${count === 1 ? "" : "s"} for a silent video advert for ${gym}'s programme "${offer}"${audience ? `, for ${audience}` : ""}. In the video one person stands in the gym holding a stack of hand-written sheets of paper. Nobody speaks. The viewer reads the front sheet, it is dropped, and the next one shows. A script is the words on the sheets, in order.`,
    `THE SHAPE, as in the advert this is modelled on ("We're looking for 10 people…" / "who want to [what they want]…" / the programme / "You'll get…" / what is included / "But… we have limited spots!!" / the call to action):
1. One or two sheets that call the right person out, or name ONE thing that bothers them in their day — a moment of their day, never a judgement of them.
2. One sheet that names the programme in its exact words, "${offer}", with at most three small words around it ("Join our ${offer}").
3. One to three sheets of what they get. ${facts.length ? "Each fact below may be its own sheet, said in a few of its own words; say nothing else about how the programme works." : "Nothing about how the programme works was given, so say what the person will feel or be able to do, and state no fact about the gym."}
4. ALWAYS exactly one sheet of scarcity, just before the last sheet. ${scarce.length ? `Say it only as the facts state it (${scarce.map((f) => `"${f}"`).join("; ")}): the same number, nothing added.` : `The owner has typed no number of places, so say that places are limited with NO number and no date — "But we have limited spots!", "Places are limited." — for the owner to check and to put his own number in. Never invent a number of people or places, and never a deadline.`}
5. The last sheet is exactly this, and nothing else: "${closing}"`,
    `THE RULES. ${SHEETS[0]} to ${SHEETS[1]} sheets. Each sheet is ${SHEET_WORDS[0]} to ${SHEET_WORDS[1]} words — the last sheet and the sheet with the programme's name may be longer — a phrase read in two seconds. A sentence may run over two sheets, with "…" at the break. The gym speaks as "we" and "our"; never "I", "my" or "me". At most one sheet may call people out by where they live, with the place written exactly {AREA} ("Live near {AREA}?"): use it in about half the scripts, and never name a country or a city. Never: a price, free, a trial, before and after, a guarantee, a promised result, a number of kilos or sizes, an ideal body, "tap", an emoji, a hashtag, an em dash.${never.length ? ` Never these words: ${never.join(", ")}.` : ""} Each script takes a different way in.`,
    PLAIN_RULE,
    wordingRule(profile),
    facts.length ? `THE FACTS the owner has typed as true of this programme (the only ones that may be stated):\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    theme ? themeRule(theme, "script") + " The first one or two sheets name it; the sheets of what they get answer it." : pains.length ? `WHAT BOTHERS THESE PEOPLE, in the owner's words (open on one of these):\n${pains.map((p) => `- ${p}`).join("\n")}` : (ads.length || library.length) ? `READING MATERIAL for what bothers these people (never copy a sentence):\n${[...ads.map((a) => a.text), ...library].slice(0, 6).map((t) => `--- ${t}`).join("\n")}` : "",
    existing.length ? `ALREADY WRITTEN (write something different):\n${existing.map((e) => `- ${e}`).join("\n")}` : "",
    refused.length ? `THESE WERE REFUSED — do not make the same mistake:\n${refused.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n") };
}
/**
 * The agent proposes sheet scripts for the owner to read and keep: one text call, a second only for a shortfall
 * (told what was refused). Every draft is checked in code; one that breaks a rule is dropped with the reason.
 */
export async function draftSheetScripts({ brandDir, offer, audience = null, count = 3, pain = null, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL, log = () => {} }) {
  if (typeof offer !== "string" || offer.trim().length < 3) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("count must be 1 to 6");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, closing = closingLine(libraryDir), plain = plainWords(libraryDir), facts = factsFor(brandDir, offer), pains = painsFor(brandDir, offer), src = painSources(brandDir, libraryDir);
  // The pain point he typed for this round (2026-11-16): every script of it is about that one thing, and keeps it.
  const theme = themeOf(pain, profile);
  const added = [], dropped = []; let calls = 0;
  for (let roundNo = 0; roundNo < 2 && added.length < count; roundNo++) {
    // The standard for a Chinese gym: the sheet scripts he has already approved here (the newest four that still pass today's rules).
    const models = gymLanguage(profile) === "zh" ? readSheetScripts(brandDir).filter((x) => x.status === "kept" && isZh(x.sheets) && !sheetIssues(x, { profile, closing, plain, gymDir: brandDir }).length).slice(-4).map((x) => x.sheets) : [];
    const { prompt, schema } = buildSheetPrompt({ profile, offer: offer.trim(), audience, count: count - added.length, facts, pains, ...src, models, existing: readSheetScripts(brandDir).filter((s) => s.status !== "retired").map((s) => s.sheets.join(" / ")), closing, theme, refused: dropped.map((d) => `"${d.text}" — ${d.reason}`).slice(0, 6) });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    for (const d of (answer?.scripts || []).slice(0, count - added.length)) {
      try {
        // Every drafted script carries one scarcity sheet (the owner, 2026-11-16: "by default we should have it"): his to approve or change at Keep.
        if (!scarceSheets(tidy(d.sheets, closing), offer.trim()).length) throw new Error("no sheet says places are limited: every script has exactly one, just before the last sheet");
        added.push(addSheetScript(brandDir, { sheets: d.sheets, offer: offer.trim(), source: "drafted", pain: theme }, { profile, closing, plain }));
      }
      catch (e) { dropped.push({ text: (d.sheets || []).join(" / "), reason: e.message }); log(`  dropped: ${e.message}`); }
    }
  }
  return { added, dropped, calls, theme, sources: { facts: facts.length, pains: pains.length, ads: src.ads.length, library: src.library.length } };
}

// ── the prompts ──────────────────────────────────────────────────────────────
const G = (p) => (p.coach ? { He: "The coach", he: "the coach", his: "the coach's" } : p.gender === "man" ? { He: "He", he: "he", his: "his" } : { He: "She", he: "she", his: "her" });
const NO_WORDS = "There is no text of any kind anywhere in the picture: no captions, no titles, no logos, no watermark, no lettering on walls, screens or clothing.";
/**
 * The paper held HIGH (2026-11-21, F45 Xinyi): with the paper's top under the chest logo and its bottom at the hips, all 7
 * of Xinyi's coach pictures came back with 21–47% of the paper inside Meta's live area (half is needed), so the picture
 * after one that came back too low asks for the paper higher and a little smaller, and lets it cover the logo. The
 * first picture keeps the owner's choice (the logo above the paper), and its name, so nothing on file is made again.
 */
const HIGHER_PAPER = "The paper is held HIGH and is a little smaller: about 40% of the picture's width. Its top edge is just below the collarbones, so the coach's whole face and neck show above it, and its bottom edge is at the waist, no lower than the navel; it may cover the logo on the chest. The paper is in the middle of the picture, with the face above it and nothing of it below the waist.";
/** The one picture a white-paper video is made from: the presenter holding a stack of blank sheets, high and large. */
export function blankPrompt({ presenter, profile, higher = false }) {
  const g = G(presenter);
  // A real coach (2026-11-17): the same person as in two real pictures of them, in the gym's uniform, the paper a little LOWER than the invented presenter holds it so the logo on the chest shows above it (the owner's choice: the words under it are covered).
  if (presenter.coach) {
    const c = presenter.coach, wears = [c.wears?.top, c.wears?.bottom, c.wears?.glasses ? "glasses" : null].filter(Boolean).join(", ");
    return `A real photograph taken on a phone held upright, 9:16. The person is the SAME real person as in the first and second images: exactly the same face, hair, build and skin, wearing the same clothes${wears ? ` (${wears})` : ""}, with the same small microphone clipped at the collar if there is one. The coach stands facing the camera, close to it, framed from the waist up with the top of the head close to the top edge of the picture, and holds a small stack of plain white A4 paper sheets upright in front of the stomach with both hands. ${higher ? HIGHER_PAPER : "The paper is LARGE in the picture: about half the picture's width. Its top edge is just BELOW the logo on the chest of the top, so the coach's whole face, the collar and that logo show above the paper, and its bottom edge is at the hips."} The front sheet is flat and faces the lens squarely, with no tilt and no curl; the coach's fingers hold the stack only at its left and right edges, so the whole face of the paper is clear. The paper is COMPLETELY BLANK: pure white, nothing written, printed or drawn on it. The coach looks straight into the lens with a small, friendly closed-mouth smile. ${presenter.room === true ? "The room is the gym in the THIRD image — its walls, ceiling, lights, equipment and floor — matched for the room only: nobody in that image appears, the coach is alone in it, and no words, sign or logo is on any wall" : "The room is the room of the first image — its walls, ceiling, lights, equipment and floor — and the coach is alone in it. The picture is framed so that NO lettering on any wall is in view: the coach stands where the wall behind is plain or only equipment shows, and no words, sign or logo is on any wall in the picture"}. Natural indoor light, real skin texture, nothing glossy, not a studio portrait; the coach's hands look natural. Apart from the logo on the top there is no text anywhere: no captions, no titles, no watermark.`;
  }
  return `A real photograph taken on a phone held upright, 9:16. ${g.He} is ${presenterWords(presenter, profile)}. ${g.He} stands on the open gym floor facing the camera, close to it, framed from the hips up with ${g.his} head near the top of the picture, and holds a small stack of plain white A4 paper sheets upright in front of ${g.his} chest with both hands. The paper is LARGE in the picture: about half the picture's width. Its top edge is just below ${g.his} chin, so ${g.his} whole face shows, and its bottom edge is above ${g.his} waist: the whole sheet sits in the upper two thirds of the picture. The front sheet is flat and faces the lens squarely, with no tilt and no curl; ${g.his} fingers hold the stack only at its left and right edges, so the whole face of the paper is clear. The paper is COMPLETELY BLANK: pure white, nothing written, printed or drawn on it. ${g.He} looks straight into the lens with a small, friendly closed-mouth smile. The room is the gym in the image — its walls, ceiling, lights, equipment and floor — matched for the room only: nobody in that image appears, and ${g.he} is alone. Natural indoor light, real skin texture, nothing glossy, not a studio portrait; ${g.his} hands look natural. ${NO_WORDS}`;
}
/** One sheet's clip: hold it still, then let it drop (the last sheet is held to the end). The camera does not move. */
export function sheetClipPrompt({ presenter, seconds = SHEET_SECONDS, last = false }) {
  const g = G(presenter);
  const act = last
    ? `${g.He} holds the stack of paper perfectly still for the whole clip so the hand-written words on the front sheet can be read, and gives one small nod. The sheet is not dropped.`
    : `For the first two and a half seconds ${g.he} holds the stack of paper perfectly still so the hand-written words on the front sheet can be read. Then ${g.he} lets the front sheet go: it slips off the stack and falls straight down out of the picture, and the sheet behind it is completely blank white paper with nothing written on it.`;
  const kept = presenter.coach ? `The person in the photograph is a real coach at this gym: keep the coach's face, hair, build, clothes and the room exactly as they are in the photograph, so that the coach is recognisably the same person in every frame.` : `Keep ${g.his} face, hair, clothes and the room exactly as they are in the photograph.`;
  const written = presenter.coach ? "Apart from the hand-written words on the front sheet, the logo on the coach's top and the gym's own lettering on the walls — which all stay exactly as they are — nothing is written anywhere: no captions, no subtitles, no titles, no watermark." : "Apart from the hand-written words on the front sheet there is no text anywhere: no captions, no subtitles, no titles, no logos, no watermark.";
  return `Bring this photograph to life as ${seconds} seconds of video. Nobody speaks: ${g.his} mouth stays closed in a small friendly smile and ${g.he} keeps looking into the camera. ${act} While the sheet is held, the writing stays exactly as it is in the photograph: every letter unchanged, sharp, steady and in the same place on the paper. The camera is fixed in place: it does not move closer, does not zoom and does not drift, and the framing stays exactly as in the photograph from the first frame to the last. ${g.He} does not walk and does not turn. Exactly one person is in the room for the whole clip. ${kept} It looks like real footage shot on a phone: natural indoor light, real skin, nothing glossy or cinematic. One continuous shot with no scene cuts. ${written} Sound: the quiet of an empty gym and the soft rustle of paper. No voice. No music.`;
}

// ── the browser: find the paper, write on it ─────────────────────────────────
async function page(browser, html, { w, h, expr = null, shot = null }) {
  const { cdp, sessionId, work } = browser, file = join(work, `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`); writeFileSync(file, html);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `file://${file}` }, sessionId); await loaded;
  const r = expr ? await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId) : null;
  if (shot) { const s = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 93 }, sessionId); writeFileSync(shot, Buffer.from(s.data, "base64")); }
  return r ? JSON.parse(r.result.value || "null") : null;
}
const dataUrl = (f) => `data:image/${/\.png$/i.test(f) ? "png" : "jpeg"};base64,${readFileSync(f).toString("base64")}`;
/**
 * The paper: among the bright, colourless patches near the middle of the picture, the one that best fills the
 * quadrilateral of its own four EDGES. Answers its corners in picture pixels (top-left, top-right, bottom-right,
 * bottom-left) and how much of that quadrilateral is blank paper.
 *
 * Each edge is fitted from the middle of its side (2026-11-16). The first finder took the patch's four extreme points
 * as the corners; on Aether's second white-paper picture a few bright pixels beside the sheet joined its patch, the
 * top-left "corner" landed 85 px outside the paper, and so the words were set off-centre and the patch the drop is
 * timed from took in the presenter's shirt — no drop was timed, each sheet was read after it had fallen, and all six
 * were refused ("the paper was blank when it was read") though the clips were sound. `v: 2` marks a paper found this way.
 */
const FIND = `(async () => { const im = document.querySelector('img'); await im.decode(); const W = im.naturalWidth, H = im.naturalHeight, s = 360 / W, w = 360, h = Math.round(H * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) { const r = d[i*4], g = d[i*4+1], b = d[i*4+2]; m[i] = Math.min(r, g, b) > 178 && Math.max(r, g, b) - Math.min(r, g, b) < 42 ? 1 : 0; }
  // Thin bridges to a wall, a window or a sleeve are cut before the patches are told apart (a 5 px erosion), so the paper is its own patch.
  const R = 2, t1 = new Uint8Array(w * h), er = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) { let ok = 1; for (let k = -R; k <= R && ok; k++) { const nx = px + k; if (nx < 0 || nx >= w || !m[y * w + nx]) ok = 0; } t1[y * w + px] = ok; }
  for (let y = 0; y < h; y++) for (let px = 0; px < w; px++) { let ok = 1; for (let k = -R; k <= R && ok; k++) { const ny = y + k; if (ny < 0 || ny >= h || !t1[ny * w + px]) ok = 0; } er[y * w + px] = ok; }
  const seen = new Int32Array(w * h), cands = []; let id = 0;
  for (let i = 0; i < w * h; i++) { if (!er[i] || seen[i]) continue; id++; const q = [i]; seen[i] = id; let n = 0, sx = 0, sy = 0;
    while (q.length) { const k = q.pop(), px = k % w, py = (k / w) | 0; n++; sx += px; sy += py;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (er[j] && !seen[j]) { seen[j] = id; q.push(j); } } }
    const cx = sx / n / w, cy = sy / n / h, share = n / (w * h); if (cx > 0.2 && cx < 0.8 && cy > 0.15 && cy < 0.85 && share > 0.012 && share < 0.5) cands.push({ n, cx: Math.round(sx / n), cy: Math.round(sy / n), share }); }
  // The paper's four edges, each from the middle of its side: where the blank run through the patch's centre ends, row by row and column by column.
  // The median over a band near each end of a side gives two points on that edge, so fingers on an edge, a bridge to the wall or a ragged corner do not move it.
  const runRow = (y, x0) => { if (y < 0 || y >= h || !m[y * w + x0]) return null; let a = x0, b = x0; while (a > 0 && m[y * w + a - 1]) a--; while (b < w - 1 && m[y * w + b + 1]) b++; return [a, b + 1]; };
  const runCol = (x0, y) => { if (x0 < 0 || x0 >= w || !m[y * w + x0]) return null; let a = y, b = y; while (a > 0 && m[(a - 1) * w + x0]) a--; while (b < h - 1 && m[(b + 1) * w + x0]) b++; return [a, b + 1]; };
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const band = (from, to, at) => { const v = []; for (let t = Math.round(from); t <= Math.round(to); t++) { const r = at(t); if (r != null) v.push(r); } return v.length >= 3 ? med(v) : null; };
  let best = null;
  for (const cnd of cands.sort((a, b) => b.n - a.n).slice(0, 4)) {
    const rc = runCol(cnd.cx, cnd.cy), rr = runRow(cnd.cy, cnd.cx); if (!rc || !rr) continue;
    const top0 = rc[0], hh = rc[1] - rc[0], left0 = rr[0], ww = rr[1] - rr[0]; if (hh < 20 || ww < 20) continue;
    const yU = [top0 + 0.08 * hh, top0 + 0.26 * hh], yL = [top0 + 0.74 * hh, top0 + 0.92 * hh], xL = [left0 + 0.12 * ww, left0 + 0.32 * ww], xR = [left0 + 0.68 * ww, left0 + 0.88 * ww], mid = (p) => (p[0] + p[1]) / 2;
    const lU = band(yU[0], yU[1], (y) => runRow(y, cnd.cx)?.[0]), lL = band(yL[0], yL[1], (y) => runRow(y, cnd.cx)?.[0]), rU = band(yU[0], yU[1], (y) => runRow(y, cnd.cx)?.[1]), rL = band(yL[0], yL[1], (y) => runRow(y, cnd.cx)?.[1]);
    const tL = band(xL[0], xL[1], (px) => runCol(px, cnd.cy)?.[0]), tR = band(xR[0], xR[1], (px) => runCol(px, cnd.cy)?.[0]), bL = band(xL[0], xL[1], (px) => runCol(px, cnd.cy)?.[1]), bR = band(xR[0], xR[1], (px) => runCol(px, cnd.cy)?.[1]);
    if ([lU, lL, rU, rL, tL, tR, bL, bR].some((v) => v == null)) continue;
    // A side edge is x = a + k·y, a top or bottom edge y = b + j·x; a corner is where two meet.
    const V = (xa, ya, xb, yb) => { const k = (xb - xa) / (yb - ya); return { a: xa - k * ya, k }; }, Hz = (xa, ya, xb, yb) => { const j = (yb - ya) / (xb - xa); return { b: ya - j * xa, j }; };
    const meet = (v, z) => { const px = (v.a + v.k * z.b) / (1 - v.k * z.j); return [px, z.b + z.j * px]; };
    const left = V(lU, mid(yU), lL, mid(yL)), right = V(rU, mid(yU), rL, mid(yL)), top = Hz(mid(xL), tL, mid(xR), tR), bot = Hz(mid(xL), bL, mid(xR), bR);
    const P = [meet(left, top), meet(right, top), meet(right, bot), meet(left, bot)];
    let area = 0; for (let k = 0; k < 4; k++) { const [x1, y1] = P[k], [x2, y2] = P[(k + 1) % 4]; area += x1 * y2 - x2 * y1; } area = Math.abs(area) / 2 + 1;
    const inside = (px, py) => { for (let k = 0; k < 4; k++) { const [x1, y1] = P[k], [x2, y2] = P[(k + 1) % 4]; if ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1) < 0) return false; } return true; };
    let n = 0; const x0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p[0])))), x1 = Math.min(w - 1, Math.ceil(Math.max(...P.map((p) => p[0])))), y0 = Math.max(0, Math.floor(Math.min(...P.map((p) => p[1])))), y1 = Math.min(h - 1, Math.ceil(Math.max(...P.map((p) => p[1]))));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) if (m[py * w + px] && inside(px + 0.5, py + 0.5)) n++;
    const fill = Math.min(1, n / area), score = n * fill * fill; if (!best || score > best.score) best = { score, share: cnd.share, fill, quad: P.map((p) => p.map((v) => v / s)) }; }
  return JSON.stringify(best ? { ...best, W, H, v: 2 } : { W, H, v: 2 }); })()`;
/** The CSS matrix3d that carries the rectangle (0,0)-(w,h) onto four points. */
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]], A = [], B = [];
  for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = q[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v); }
  for (let i = 0; i < 8; i++) { let p = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r; [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
    for (let r = 0; r < 8; r++) if (r !== i) { const k = A[r][i] / A[i][i]; for (let c = i; c < 8; c++) A[r][c] -= k * A[i][c]; B[r] -= k * B[i]; } }
  const k = B.map((b, i) => b / A[i][i]);
  return `matrix3d(${[k[0], k[3], 0, k[6], k[1], k[4], 0, k[7], 0, 0, 1, 0, k[2], k[5], 0, 1].join(",")})`;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/**
 * What the paper found in a picture allows, by rule (pure): { width (of the picture's), fill, usable [from, to] — the
 * part of the paper's height that is inside Meta's live area, where the words go — problem }. A picture with a
 * problem is not written on: another is made.
 */
/** A sheet held square to the lens has opposite sides of about the same length (within `PAPER.skew`): a quadrilateral that does not is a paper found wrongly. Pure. */
export function quadSound(found) {
  if (!found?.quad) return false;
  const [tl, tr, br, bl] = found.quad, top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br), off = (a, b) => Math.abs(a - b) / Math.max(a, b, 1);
  return off(top, bottom) <= PAPER.skew && off(left, right) <= PAPER.skew;
}
/**
 * The mark a picture's sheets and clips carry in their names when its paper had to be found again: "" for a paper
 * found once and soundly (every file on disk stands), "r2" for one the first finder got wrong — its sheets are written
 * again and its clips filmed again, under new names, and the old files are left where they are. Pure, so the plan
 * (paperNeeds) and the run agree before the browser is opened.
 */
export const paperKey = (p) => (p?.key ? p.key : p?.quad && p.v !== 2 && !quadSound(p) ? "r2" : "");
export function paperFacts(found) {
  if (!found?.quad) return { problem: "no blank sheet of paper was found in the picture" };
  const { quad: [tl, tr, br, bl], W: w, H: h, fill } = found, width = dist(tl, tr) / w, top = (tl[1] + tr[1]) / 2, bottom = (bl[1] + br[1]) / 2, tall = bottom - top;
  const from = Math.max(PAPER.pad, (LIVE.top * h - top) / tall + 0.02), to = Math.min(1 - PAPER.pad, (LIVE.bottom * h - top) / tall - 0.02), usable = [round(from, 1000), round(to, 1000)];
  const facts = { width: round(width, 1000), fill: round(fill, 1000), usable };
  if (!(tall > 0) || Math.min(tl[0], bl[0]) < LIVE.left * w * 0.5 || Math.max(tr[0], br[0]) > w * (1 - LIVE.left * 0.5)) return { ...facts, problem: "the paper runs off the side of the picture" };
  if (!quadSound(found)) return { ...facts, problem: "the paper's edges could not be found cleanly" };
  if (width < PAPER.min_w) return { ...facts, problem: `the paper is too small in the picture (${Math.round(width * 100)}% of its width; at least ${Math.round(PAPER.min_w * 100)}%)` };
  if (fill < PAPER.fill) return { ...facts, problem: "the paper is not blank, or hands cover too much of it" };
  if (to - from < PAPER.usable) return { ...facts, problem: `the paper is held too ${top < LIVE.top * h ? "high" : "low"}: only ${Math.round(Math.max(0, to - from) * 100)}% of it is where words may sit on a Story or Reel` };
  return facts;
}
/** Find the paper in a picture (headless Chrome), with what it allows. */
export async function findPaper(browser, picture) {
  const found = await page(browser, `<!doctype html><img src="${dataUrl(picture)}">`, { w: 400, h: 400, expr: FIND });
  return { ...found, ...paperFacts(found) };
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
/**
 * Write a sheet's words onto the paper of a picture, as a new picture: a marker hand, multiplied onto the paper so
 * its own shading shows through, as large as fits the part of the paper inside Meta's live area. Answers { px (the
 * letters' size in the picture), letter (of the picture's width), box (the words' box, as shares of the picture),
 * problem } — the words too small to read, or outside the live area, are a problem and the picture is not used.
 */
export async function writeSheet(browser, { picture, paper, text, out }) {
  const { quad, W: w, H: h, usable: [from, to] } = paper, bw = 1000, bh = Math.round(bw * (dist(quad[0], quad[3]) / dist(quad[0], quad[1]))), mw = Math.round(bw * PAPER.text_w), mh = Math.round(bh * (to - from));
  const zh = isZh(text), fam = zh ? "ZhHand" : "Marker";
  const html = `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:Marker;src:url("file://${PAPER_FONT}")}@font-face{font-family:ZhHand;src:url("file://${PAPER_FONT_ZH}")}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000}img{position:absolute;left:0;top:0;width:${w}px;height:${h}px}
    #b{position:absolute;left:0;top:0;width:${bw}px;height:${bh}px;transform-origin:0 0;transform:${homography(bw, bh, quad)};mix-blend-mode:multiply}
    #a{position:absolute;left:${Math.round((bw - mw) / 2)}px;top:${Math.round(bh * from)}px;width:${mw}px;height:${mh}px;display:flex;align-items:center;justify-content:center}
    #t{font-family:${fam};font-weight:400;color:#16161c;text-align:center;line-height:1.12;width:${mw}px;transform:rotate(-1.2deg);filter:blur(.7px);opacity:.93;overflow-wrap:normal}</style>
    <img src="${dataUrl(picture)}"><div id="b"><div id="a"><div id="t">${esc(inkText(text))}</div></div></div>`;
  const fit = `(async () => { await document.fonts.load('40px ${fam}', ${JSON.stringify(inkText(text).slice(0, 8))}); await document.fonts.ready; await document.querySelector('img').decode(); const t = document.getElementById('t'); let s = 400; t.style.fontSize = s + 'px';
    const over = () => t.scrollWidth > ${mw} + 1 || t.scrollHeight > ${mh}; while (s > 24 && over()) { s -= 4; t.style.fontSize = s + 'px'; }
    const r = t.getBoundingClientRect(); return JSON.stringify({ css: s, fits: !over(), font: document.fonts.check('40px ${fam}', ${JSON.stringify(inkText(text).slice(0, 8))}), box: { x: r.left / ${w}, y: r.top / ${h}, w: r.width / ${w}, h: r.height / ${h} } }); })()`;
  const r = await page(browser, html, { w, h, expr: fit, shot: out });
  const px = r.css * (dist(quad[0], quad[1]) / bw), letter = px / w, box = Object.fromEntries(Object.entries(r.box).map(([k, v]) => [k, round(v, 1000)]));
  const inside = box.x >= LIVE.left - 0.005 && box.x + box.w <= LIVE.right + 0.005 && box.y >= LIVE.top - 0.005 && box.y + box.h <= LIVE.bottom + 0.005;
  const problem = !r.font ? "the marker font did not load" : !r.fits || letter < PAPER.min_letter ? "has too many words to be read on the paper: use fewer" : !inside ? "its words do not fit where words may sit on a Story or Reel" : null;
  return { px: round(px, 10), letter: round(letter, 1000), box, ...(problem ? { problem } : {}) };
}

// ── the drop, measured ───────────────────────────────────────────────────────
/** How much ink is in a patch of each frame: [{ t, ink }] — ink is the share of dark pixels there, 0 to 255. `box`: shares of the frame. */
export function inkSeries(file, box) {
  const pad = 0.012, x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad), w = Math.min(1 - x, box.w + 2 * pad), h = Math.min(1 - y, box.h + 2 * pad);
  const vf = `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)},lutyuv=y='if(lt(val,95),255,0)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`;
  const out = sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", vf, "-an", "-f", "null", "-"]), series = []; let t = null;
  for (const line of out.split("\n")) { const a = line.match(/pts_time:([\d.]+)/); if (a) t = Number(a[1]); const b = line.match(/YAVG=([\d.]+)/); if (b && t != null) { series.push({ t, ink: Number(b[1]) }); t = null; } }
  return series;
}
/**
 * When the sheet goes, from the ink (pure): { duration, base (the ink while it is held), leave (when the words start
 * to go: the ink stays under 70% of what it was — up to here the sheet can be read), drop (when they are gone: under
 * 15% — the cut) }. Both null when the sheet is never dropped; both 0 when the words were never there. In the test
 * one sheet slid for half a second before it fell (ink 35 → 26 → 18 → 13 → 0), so the two are told apart.
 */
export function dropFrom(series) {
  if (!series.length) return { duration: 0, base: 0, leave: 0, drop: 0 };
  const step = series.length > 1 ? (series[series.length - 1].t - series[0].t) / (series.length - 1) : 1 / FPS, duration = round(series[series.length - 1].t + step);
  const early = series.filter((s) => s.t <= 0.5).map((s) => s.ink).sort((a, b) => a - b), base = early[Math.floor(early.length / 2)] ?? 0;
  if (base < 2) return { duration, base: round(base), leave: 0, drop: 0 };
  // The fall is measured from where the ink ends up, not from nought: when something dark stays in the patch after the
  // sheet has gone (a sleeve at its edge) the ink settles above nought, and a drop to 40% of what it was is still a drop.
  // A real drop takes at least `DROP_FALL` of the ink away; less than that is a sheet that was never let go.
  const floor = Math.min(...series.map((s) => s.ink)), fall = base - floor;
  if (fall < base * DROP_FALL) return { duration, base: round(base), leave: null, drop: null };
  const under = (share) => { const lim = floor + fall * share; for (let i = 0; i < series.length; i++) if (series[i].ink < lim && series.slice(i, i + 4).every((s) => s.ink < lim)) return round(series[i].t); return null; };
  const drop = under(0.15), leave = drop == null ? null : under(0.7) ?? drop;
  return { duration, base: round(base), leave, drop };
}

// ── the check ────────────────────────────────────────────────────────────────
const READ_SCHEMA = { type: "OBJECT", properties: { written: { type: "STRING" }, clean: { type: "BOOLEAN" } }, required: ["written", "clean"] };
const READ_QUESTION = "A person holds a sheet of paper towards the camera. written: every word written on the front sheet of paper, exactly as written, letter for letter, in reading order, as one line; an empty string if that sheet is blank. clean: true only if every letter is sharp and correctly formed, with no warped, melted, doubled or invented letters. If the writing is Chinese, write it in the Traditional Chinese characters as written, numbers as digits.";
/** The models a white-paper video uses: the presenter's image and video models and the watching pass, plus reading a sheet back from one frame. */
export function paperModels(profile = {}) { return { ...realModels(profile), async read(frame) { return callVision(frame, READ_QUESTION, READ_SCHEMA); } }; }
/**
 * One sheet's clip judged from its check (pure; the same check is judged again by today's rules on every run):
 * { passed, why, kind: words | voice | people | drop | lettering | null, faults, marks }. The words on the paper come
 * first: they are what the video is.
 */
export function judgeSheet(check, text, { last = false } = {}) {
  const t = check?.timing || {}, seen = check?.seen || {}, reads = check?.reads || [], held = t.leave ?? t.duration ?? 0;
  const wrong = reads.find((r) => !sameWriting(r.written, inkText(text))), spoken = norm(seen.spoken);
  // The sheet's own words are no lettering: an entry mostly made of them is the paper.
  // A real coach's clip (stamped `coach`): the uniform's own print and the gym's own lettering on the walls are the room's own, as they are in a coach's spoken clip.
  const mine = new Set(inkText(text).toLowerCase().match(/[a-z0-9']+/g) || []), other = (Array.isArray(seen.lettering) ? seen.lettering : []).filter((x) => { const ws = String(x?.text || "").toLowerCase().match(/[a-z0-9']+/g) || []; return ws.length && ws.filter((w) => mine.has(w)).length / ws.length < 0.6; }).filter((x) => !(check?.coach === true && x.on !== "overlay"));
  const L = letteringOf({ lettering: other });
  const kind = !reads.length || wrong ? "words" : spoken ? "voice" : seen.people !== 1 ? "people" : held < MIN_HOLD ? "drop" : !last && t.drop == null ? "drop" : L.fails.length ? "lettering" : null;
  const why = kind === "words" ? (wrong ? (norm(wrong.written) ? `the paper read "${norm(wrong.written)}"` : "the paper was blank when it was read") : "the paper could not be read back")
    : kind === "voice" ? `a voice says "${spoken}"` : kind === "people" ? `${seen.people} people are in it`
    : kind === "drop" ? (held < MIN_HOLD ? `the sheet goes after ${round(held, 10)} s, too soon to read` : "the sheet is not dropped") : kind === "lettering" ? `other words appear in the picture: ${L.fails.map((x) => x.text).join(", ")}` : null;
  const faults = [...(seen.faults || []).filter(Boolean), ...(reads.some((r) => r.clean === false) && !wrong ? ["the writing looks warped"] : [])];
  return { passed: !kind, why, kind, faults, marks: L.notes.map((x) => `${x.on === "screen" ? "on a screen in the room" : "the maker's name on the equipment"}: ${x.text}`) };
}

// ── the files of one script ──────────────────────────────────────────────────
const blankName = (prompt, room) => `blank-${sha(prompt + basename(room)).slice(0, 6)}.jpg`;
const LETTERS = "bcdefgh";
/** The pictures a script may be filmed from, in order: its first, then the ones made after it was refused (-b, -c …). */
const blankFiles = (main) => [main, ...[...LETTERS].map((c) => main.replace(/\.jpg$/, `-${c}.jpg`))];
const paperFile = (pic) => pic.replace(/\.jpg$/, ".paper.json");
const sheetName = (i, text, blank, area, perArea, key = "") => `sheet-${i + 1}${perArea ? `-${slug(area)}` : ""}-${sha(inkText(text) + basename(blank) + key).slice(0, 6)}.jpg`;
const clipName = (i, text, blank, area, perArea, last, key = "") => `line-${i + 1}${perArea ? `-${slug(area)}` : ""}-${sha(`${inkText(text)}|${basename(blank)}|${last ? "last" : "drop"}${key ? `|${key}` : ""}`).slice(0, 6)}`;
const passed = (check, text, last) => !!check && check.v === CHECK_V && judgeSheet(check, text, { last }).passed;
/**
 * What a sheet script still needs filmed for these locations, by what is on file — the shape `videoNeeds` gives for a
 * spoken script: { clips[{ line, area, seconds, on_file, flagged }], seconds (to film, one clean pass), reused,
 * flagged, images }. No call, nothing written.
 */
export function paperNeeds({ gymDir, script, areas = [""], room = null, profile = readJson(join(gymDir, "gym-profile.json")) || {}, coach = null, store = coach ? coachStore(gymDir, script.id, coach) : clipStore(gymDir, script.id), takes = 2 }) {
  const coachRoom = !!(coach && room && existsSync(room));
  if (coach) room = `coach:${coach.key}`;
  const presenter = coach ? { gender: null, coach, room: coachRoom } : presenterOf(profile), files = existsSync(store) ? readdirSync(store) : [], aside = asideOf(store), clips = [], last = script.sheets.length - 1;
  const main = presenter && room ? blankName(blankPrompt({ presenter, profile }), room) : null;
  // The picture in use: the first on file whose paper passed (one not looked at yet counts as usable).
  const blank = main ? blankFiles(main).find((b) => files.includes(b) && !readJson(join(store, paperFile(b)))?.problem) || null : null, key = blank ? paperKey(readJson(join(store, paperFile(blank)))) : "";
  for (const [i, raw] of script.sheets.entries()) {
    const perArea = /\{AREA\}/.test(raw);
    for (const area of perArea ? (areas.length ? areas : [""]) : [null]) {
      const text = fillLine(raw, area || ""), name = blank ? clipName(i, text, blank, area, perArea, i === last, key) : null;
      const mine = name ? files.filter((f) => /\.mp4$/.test(f) && (f === `${name}.mp4` || f.startsWith(`${name}-take`))) : [], live = mine.filter((f) => !aside.has(f));
      const on_file = live.some((f) => passed(readJson(join(store, f.replace(/\.mp4$/, ".check.json"))), text, i === last) || !!ownerKeptClip(store, join(store, f)));
      clips.push({ line: text, area, seconds: SHEET_SECONDS, on_file, flagged: !on_file && live.length > 0 && mine.length >= takes + (mine.length - live.length) });
    }
  }
  const sum = (xs) => xs.reduce((t, c) => t + c.seconds, 0);
  return { clips, seconds: sum(clips.filter((c) => !c.on_file && !c.flagged)), reused: sum(clips.filter((c) => c.on_file)), flagged: clips.filter((c) => c.flagged).length, images: blank ? 0 : 1 };
}
/** Join the sheets' clips, each cut to [0, to], at one size and rate, each fading into the next over `fade` seconds; a clip without sound gets silence. */
function joinSheets({ clips, out, fade = SHEET_FADE }) {
  const sound = clips.map((c) => { try { return sh("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", c.file]).trim().length > 0; } catch { return false; } });
  const inputs = clips.flatMap((c) => ["-i", c.file]), n = clips.length;
  const chain = clips.map((c, i) => `[${i}:v]trim=0:${c.to},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1[c${i}];${sound[i] ? `[${i}:a]atrim=0:${c.to},asetpts=PTS-STARTPTS` : `anullsrc=r=48000:cl=stereo,atrim=0:${c.to}`},aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(";")
    + ";" + (n < 2 || !(fade > 0) ? clips.map((_, i) => `[c${i}][a${i}]`).join("") + `concat=n=${n}:v=1:a=1[v][a]` : (() => {
      let s = "", at = 0, pv = "c0", pa = "a0";
      for (let i = 1; i < n; i++) { at += clips[i - 1].to - fade; s += `${i > 1 ? ";" : ""}[${pv}][c${i}]xfade=transition=fade:duration=${fade}:offset=${at.toFixed(3)}[x${i}];[${pa}][a${i}]acrossfade=d=${fade}[y${i}]`; pv = `x${i}`; pa = `y${i}`; }
      return `${s};[${pv}]format=yuv420p[v];[${pa}]anull[a]`; })());
  ff([...inputs, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  return out;
}

// ── making the videos of one sheet script ────────────────────────────────────
/**
 * One sheet script → one video for each location, in the shape `makePresenterVideos` answers: { videos[{ area,
 * script_id, kind: "paper", file, poster, seconds, words, parts, flags?, notes } | { area, failed }], spent, tally }.
 * `caps { seconds, images }` are never passed: a call that would pass one is not made.
 */
export async function makePaperVideos({ gymDir, outDir, script, areas, offer, room, profile = readJson(join(gymDir, "gym-profile.json")) || {}, caps = { seconds: 80, images: 2 }, spent = { seconds: 0, images: 0, checks: 0 }, takes = 2, models = paperModels(profile), browser = null, closing = closingLine(), coach = null, store = coach ? coachStore(gymDir, script.id, coach) : clipStore(gymDir, script.id), log = () => {}, onProgress = () => {} }) {
  // A real coach (coach-look.mjs → coachForVideo) in place of the invented presenter: the one picture is re-made from two real pictures of them.
  if (coach && !coach.refs?.length) throw new Error(`${coach.name} has no starting picture: nothing is filmed`);
  // The room of a coach's re-made picture is the gym's own room photo when the batch has one (cleaned of words), with the coach's two real pictures for the person.
  const roomPhoto = coach && room && existsSync(room) ? room : null;
  if (coach) room = `coach:${coach.key}`;
  const presenter = coach ? { gender: null, coach, room: !!roomPhoto } : presenterOf(profile), who = coach ? { coach: { id: coach.id, name: coach.name } } : {};
  if (!presenter) throw new Error("say who presents first (Ad defaults → Presenter): a woman or a man. Nothing is made until then");
  // The script's own rules, as they stand for a kept script: a scarcity sheet he said yes to (`scarce_ok`) is his word here too.
  // (2026-11-16: this check left his yes out, so a script he had kept and approved stopped a batch after two videos were filmed.)
  const errs = sheetProblems(script.sheets, { offer, profile, closing, facts: factsFor(gymDir, offer), approved: script.scarce_ok || [] }); if (errs.length) throw new Error(`this script cannot be made: ${errs.join("; ")}`);
  if (!areas?.length) throw new Error("a video needs a location");
  const whole = areas.find((a) => isWholeCountry(a)); if (whole) throw new Error(`"${whole}" is the whole country: a video says the area around the gym, never the country`);
  if (!coach && (!room || !existsSync(room))) throw new Error("a photo of the gym's room is needed, so the video is in the gym's own room (Photos & assets → a cleaned premises photo)");
  if (!hasFfmpeg()) throw new Error("ffmpeg is not installed on this machine: run `brew install ffmpeg` once");
  mkdirSync(store, { recursive: true }); mkdirSync(outDir, { recursive: true });
  const own = !browser; if (own) browser = await launchBrowser();
  const within = (kind, n) => spent[kind] + n <= caps[kind], tally = { filmed: 0, in_videos: 0, replaced: 0, failed: 0, waiting: 0 };
  const failAll = (why) => ({ videos: areas.map((area) => ({ area, script_id: script.id, kind: "paper", ...who, failed: why })), spent, tally });
  const last = script.sheets.length - 1, label = (i) => `sheet ${i + 1}`;
  try {
    // ── the one picture: the presenter holding blank sheets. One whose paper cannot be written on is made again (a fresh one each run, at most).
    const base = blankPrompt({ presenter, profile }), main = join(store, blankName(base, room));
    let blank = null, paper = null, why = null, madeNow = 0, low = false;
    for (const pic of blankFiles(main)) {
      const prompt = low && presenter.coach ? blankPrompt({ presenter, profile, higher: true }) : base;
      if (!existsSync(pic)) {
        if (madeNow >= BLANK_PER_RUN) break;
        if (!within("images", 1)) { why = why ? `${why}, and the cap of ${caps.images} image call${caps.images === 1 ? "" : "s"} leaves none for another` : `the cap of ${caps.images} image call${caps.images === 1 ? "" : "s"} was reached before the presenter's picture was made`; break; }
        spent.images++; madeNow++; onProgress({ stage: "still", line: 1, paper: true }); log(pic === main ? "the presenter's picture, holding the blank sheets" : "a fresh picture of the presenter");
        writeFileSync(pic.replace(/\.jpg$/, ".prompt.txt"), prompt + "\n");
        try { await models.image({ out: pic, prompt, refs: coach ? [...coach.refs, ...(roomPhoto ? [roomPhoto] : [])] : [room] }); }
        catch (e) { if (!isRefusal(e)) throw e; why = "Google's image model refused the presenter's picture under its content rules"; log(`  ${why}`); continue; }
      }
      let p = readJson(paperFile(pic)); if (!p) { p = await findPaper(browser, pic); writeFileSync(paperFile(pic), JSON.stringify(p, null, 2) + "\n"); }
      // A paper the first finder got wrong (its sides do not agree) is found again; its sheets and clips are made afresh under new names.
      else if (!p.problem && paperKey(p) && !p.key) { p = { ...(await findPaper(browser, pic)), key: "r2" }; writeFileSync(paperFile(pic), JSON.stringify(p, null, 2) + "\n"); log("  the paper in the picture on file had been found wrongly: it is found again, and its sheets are written and filmed afresh"); }
      // A coach's picture is held against a real one of them: a picture that is not the same person is not used, and another is made.
      if (coach && !p.problem && models.same && p.same === undefined) { spent.checks++; p.same = await models.same(coach.refs[0], pic); if (p.same?.same_person === false) p.problem = `it does not look like ${coach.name}${(p.same.differences || []).length ? ` (${p.same.differences.slice(0, 3).join("; ")})` : ""}`; else if (stillFault(p.same) === "wallwords") p.problem = stillWhy(p.same, coach.name); writeFileSync(paperFile(pic), JSON.stringify(p, null, 2) + "\n"); }
      if (!p.problem) { blank = pic; paper = p; break; }
      why = p.problem; low = low || /held too low/.test(p.problem); log(`  ${basename(pic)}: ${p.problem}`);
    }
    if (!blank) return failAll(`the presenter's picture could not be used: ${why}. Nothing was filmed. Run again asks for a fresh picture`);
    log(`the paper is ${Math.round(paper.width * 100)}% of the picture's width; the words go on it by software`);
    // ── each sheet: its words written on the picture (free), then its clip — once, or once for each location when it says the area.
    const stills = new Map(), made = new Map(), aside = asideOf(store), filmedNow = new Map();
    const stillFor = async (i, area) => {
      const perArea = /\{AREA\}/.test(script.sheets[i]), key = `${i}|${perArea ? area : ""}`; if (stills.has(key)) return stills.get(key);
      const text = fillLine(script.sheets[i], area), file = join(store, sheetName(i, text, blank, area, perArea, paper.key || "")), meta = file.replace(/\.jpg$/, ".sheet.json");
      let r = existsSync(file) ? readJson(meta) : null; if (!r) { r = await writeSheet(browser, { picture: blank, paper, text, out: file }); writeFileSync(meta, JSON.stringify(r, null, 2) + "\n"); }
      const s = { file, text, perArea, ...r }; stills.set(key, s); return s;
    };
    const checkOf = async (file, still, isLast) => {
      // Read back inside the part of the clip that is kept: up to where the words start to go (the last sheet: up to where it is cut).
      const timing = dropFrom(inkSeries(file, still.box)), held = Math.min(timing.leave ?? timing.duration, isLast ? LAST_KEEP : Infinity), reads = [];
      for (const [k, at] of [Math.max(0.2, held * 0.35), Math.max(0.3, held - 0.3)].entries()) {
        const frame = file.replace(/\.mp4$/, `.frame-${k}.jpg`); ff(["-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-q:v", "2", frame]);
        spent.checks++; reads.push({ at: round(at), ...(await models.read(frame)) }); rmSync(frame, { force: true });
      }
      spent.checks++; const seen = await models.watch(file, { paper: true });
      return { v: CHECK_V, timing, reads, seen, ...(coach ? { coach: true } : {}) };
    };
    const clipFor = async (i, area) => {
      const still = await stillFor(i, area), key = `${i}|${still.perArea ? area : ""}`; if (made.has(key)) return made.get(key);
      const isLast = i === last, name = clipName(i, still.text, blank, area, still.perArea, isLast, paper.key || ""), seconds = SHEET_SECONDS;
      let r;
      if (still.problem) r = { file: null, takes: 0, passed: false, text: still.text, why: `${still.problem} ("${still.text}")`, all: [], words: true };
      else {
        const mine = (f) => f === `${name}.mp4` || f.startsWith(`${name}-take`), limit = takes + [...aside].filter(mine).length;
        let take = 0, refused = 0, stopped = null; const judged = [];
        while (take < limit) {
          // Enough: a take that passed, or one kept on the owner's word.
          const ok = judged.filter((t) => t.passed);
          // A sheet is never filmed again for a small note (2026-11-16): the paper is read back letter for letter, and two sheets were filmed again because the check noted the drop itself.
          if (ok.length) break;
          take++; const file = join(store, `${name}${take > 1 ? `-take${take}` : ""}.mp4`), checkFile = file.replace(/\.mp4$/, ".check.json");
          if (aside.has(basename(file))) continue;
          if (!(existsSync(file) && statSync(file).size > 1000)) {
            if (!within("seconds", seconds)) { stopped = { why: `the cap of ${caps.seconds} seconds of video was reached` }; take--; break; }
            spent.seconds += seconds; onProgress({ stage: "clip", line: i + 1, area: still.perArea ? area : null, take, paper: true }); log(`${label(i)}${still.perArea ? ` (${area})` : ""}, take ${take}: ${seconds} s`);
            const clipPrompt = sheetClipPrompt({ presenter, seconds, last: isLast }); writeFileSync(file.replace(/\.mp4$/, ".prompt.txt"), clipPrompt + "\n");
            try { await models.clip({ out: file, image: still.file, prompt: clipPrompt, seconds }); filmedNow.set(file, seconds); }
            catch (e) {
              // Google refused the request: nothing was made, so nothing is counted and it is no take. Asked once more, then this sheet is refused in words.
              if (!isRefusal(e)) throw e;
              spent.seconds -= seconds; take--; refused++; log(`  ${basename(file)}: refused by Google's video model under its content rules${refused === 1 ? " — asked once more" : ""}`);
              if (ok.length || refused === 1) { if (ok.length) break; continue; }
              stopped = { refused: true, why: "refused by Google's video model under its content rules, twice" }; break;
            }
          }
          let check = readJson(checkFile); if (!check || check.v !== CHECK_V) { check = await checkOf(file, still, isLast); writeFileSync(checkFile, JSON.stringify(check, null, 2) + "\n"); }
          let j = judgeSheet(check, still.text, { last: isLast });
          if (!j.passed && ownerKeptClip(store, file)) j = { ...j, passed: true, kept: j.why, why: null, kind: null };
          judged.push({ file, take, ...j, check });
          log(`  ${basename(file)}: ${j.kept ? `kept on your word (${j.kept})` : j.passed ? `the paper reads as written${isLast ? ", held" : `, dropped at ${check.timing.drop} s`}` : j.why}${j.faults.length ? ` · noted: ${j.faults.join("; ")}` : ""}`);
        }
        const ok = judged.filter((t) => t.passed), all = judged.map((t) => basename(t.file));
        if (ok.length) { const best = ok.reduce((b, x) => (x.faults.length <= b.faults.length ? x : b)); r = { file: best.file, takes: take, passed: true, check: best.check, marks: best.marks, faults: best.faults, ...(best.kept ? { kept: best.kept } : {}), all }; }
        // None passed, but there is a take: the one nearest right (the words on the paper before anything else) goes into the cut, flagged.
        else if (judged.length) { const rank = (t) => ({ lettering: 0, drop: 1, people: 2, voice: 3, words: 4 })[t.kind] ?? 5, best = judged.reduce((b, x) => (rank(x) < rank(b) || (rank(x) === rank(b) && x.faults.length <= b.faults.length) ? x : b)); r = { file: best.file, takes: take, passed: false, flagged: true, kind: best.kind, why: best.why, check: best.check, marks: best.marks, faults: best.faults, all }; }
        else r = { file: null, takes: take, passed: false, why: stopped?.why || "no take was made", ...(stopped?.refused ? { refused: true } : {}), all };
        r.judged = judged.map((t) => ({ file: t.file, passed: t.passed }));
      }
      r.text = still.text; r.seconds = seconds; r.per_area = still.perArea; r.judged ||= [];
      made.set(key, r); return r;
    };
    const videos = [];
    for (const area of areas) {
      const sheets = []; for (const [i] of script.sheets.entries()) sheets.push(await clipFor(i, area));
      const none = sheets.findIndex((s) => !s.file);
      if (none >= 0) { const s = sheets[none]; videos.push({ area, script_id: script.id, kind: "paper", ...who, ...(s.refused ? { refused: true } : {}), failed: s.words ? `${label(none)} ${s.why}` : s.refused ? `${label(none)}: ${s.why}. Nothing else is lost: Run again tries only this sheet; if it is refused again, change its words` : `${label(none)}: ${s.why}` }); continue; }
      onProgress({ stage: "cut", area, paper: true });
      // Each clip is kept until its sheet has fallen out of the frame (the last one: while the sheet is held), and fades into the next; a sheet that is never dropped is cut at its end.
      const cuts = [], starts = []; let at = 0;
      for (const [i, s] of sheets.entries()) {
        const t = s.check.timing, to = i === last ? Math.min(LAST_KEEP, t.leave != null ? Math.max(0.5, t.leave - 0.1) : t.duration) : t.drop != null && t.drop > 0 ? Math.min(t.duration - 0.04, t.drop + DROP_KEEP) : t.duration;
        cuts.push({ file: s.file, to: round(to) }); starts.push(round(at)); at += cuts[i].to - (sheets.length > 1 ? SHEET_FADE : 0);
      }
      const file = joinSheets({ clips: cuts, out: join(outDir, `${script.id}${coach ? `--${coach.key}` : ""}-${slug(area)}.mp4`) });
      const poster = file.replace(/\.mp4$/, ".jpg"); ff(["-ss", "0.8", "-i", file, "-frames:v", "1", "-q:v", "3", poster]);
      const parts = sheets.map((s, i) => ({ line: i + 1, label: label(i), text: s.text, clip: basename(s.file), takes: s.all, seconds: s.seconds, at: starts[i], ...(s.per_area ? { per_area: true } : {}), ...(s.kept ? { kept: s.kept } : {}), ...(s.passed ? {} : { flag: { why: s.why, kind: s.kind } }) }));
      const flags = parts.filter((p) => p.flag).map((p) => ({ line: p.line, label: p.label, why: p.flag.why, kind: p.flag.kind }));
      videos.push({ area, script_id: script.id, kind: "paper", ...who, style: null, pain: null, file, poster, seconds: round(durationOf(file), 10), lines: sheets, words: sheets.map((s) => s.text), parts, ...(flags.length ? { flags } : {}),
        notes: [...new Set([...sheets.flatMap((s) => s.faults || []), ...sheets.flatMap((s) => s.marks || []), ...parts.filter((p) => p.kept).map((p) => `${p.label} kept on your word (${p.kept})`)])] });
    }
    // What this call filmed, and what became of it: in a video, replaced by a retake, failed its check, or waiting on a video that could not be cut.
    const inCut = new Set(videos.filter((v) => v.file).flatMap((v) => v.lines.map((l) => l.file))), state = new Map([...made.values()].flatMap((r) => r.judged.map((t) => [t.file, t.passed]))), chosen = new Set([...made.values()].map((r) => r.file));
    for (const [f, s] of filmedNow) { tally.filmed += s; tally[inCut.has(f) ? "in_videos" : chosen.has(f) ? "waiting" : state.get(f) ? "replaced" : "failed"] += s; }
    return { videos, spent, tally };
  } finally { if (own) await browser.close(); }
}
