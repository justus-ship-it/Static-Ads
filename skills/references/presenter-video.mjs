#!/usr/bin/env node
/**
 * presenter-video.mjs — a presenter talking to the camera, made by AI (2026-11-12; the first video format built,
 * after the owner watched the test: "The presenter — it's REALLY good … this quality is perfect. Build presenter first").
 *
 * The shape is the gyms' own best videos (F45 Jurong West's "Intro", Sculpt Society's "Treadmill Intro"): someone
 * talks to a phone camera across a few spots in the gym's own room, with jump cuts and bold captions. Here:
 *
 *   · THE PRESENTER SPEAKS FOR THE GYM, AS NOBODY IN PARTICULAR. An invented person: "we", "our" and "us" are the
 *     gym's voice and may be said (the owner, 2026-11-14, on "line 4 speaks as the gym or a member (\"We\")": "Remove
 *     this - allow the presenter to say 'we' representing the gym" — until then no first person was allowed at all).
 *     What stays out is one person's own voice — I, my, me — because the presenter is not a real coach or member and
 *     has no story of their own to tell. Who presents (a woman or a man, about what age, any look) is the gym's own
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
 *     people into empty space); no lettering appears but the room's own (a maker's name on a machine is a note).
 *     What a listener cannot hear is no difference (a spelling, a contraction, where the spaces fall). A clip that
 *     fails is made again (`takes`); a clip that passes with a small note is made once more, never twice. The
 *     check's "looks real" score is NOT a gate — it scored a clip with an extra person 10 of 10 in the test — its
 *     faults are shown to the owner, whose pick is the final check.
 *   · THE OWNER ALWAYS SEES THE VIDEO (2026-11-15: two of three videos were refused over a spelling and a maker's
 *     logo, and "I don't even see the final output"). A line no take passed for goes into the cut all the same,
 *     FLAGGED with why (`flags`, `parts`): on Pick Ads he films it again (the takes on file are set aside:
 *     `setAside`), uses the take anyway (his word, recorded: `keepTake`) or edits the line. A flagged video is never
 *     kept or published until then. Only a line with no take at all (refused by Google, the cap) leaves no video.
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
 *     short list, shared by every gym and his to add to (`saidAs`). The presenter is GIVEN the word written the way
 *     it sounds ("Boat Key" — told "Quay is pronounced kee" the video model still said "kway", 2026-11-15); the
 *     captions keep the spelling; a clip is named for it too, so adding a word films again only the lines that say it.
 *   · THE ENDING IS TWO BEATS (the same day: "it's too abrupt when we transition into 'Click the link below…'", with
 *     the end of his own sample as the model): one sentence that turns to the viewer and names what they want — "If
 *     you're ready to …, now is your time." — and then the closing line. What they will feel or be able to do, never
 *     an ideal body. A script that goes straight into the closing line needs an edit.
 *   · EACH SAMPLE IS A STYLE, AND A DRAFT FOLLOWS ONE (the owner, 2026-11-14, with seven scripts that have worked: "I
 *     need more variation for the video scripts … more variation on style"). Shown every sample at once and held to
 *     one skeleton, the drafter blended them into one shape. Now each sample is read once into how it is BUILT (a
 *     name, its kind of opening, its parts in order), a round of drafts is spread across the styles — the least used
 *     first — and each script says the style it follows. The area is said only where the style calls people out by
 *     place (a script without it is filmed once for every location); the pain point comes within the first two lines.
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
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";
import { loadGeminiKey, generateImage } from "./generate_ads_gemini.mjs";
import { whenGeminiFree, isRefusal } from "./gemini-busy.mjs";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";
import { imageModelFor, countryRules, profileCountry, titleCase, PRESENTER_GENDERS, presenterProblems, captionAccentOf, wordingHits, wordingWhy, wordingRule, nameInAds, sayInstead } from "./client-config.mjs";
import { launchBrowser, isWholeCountry, hasCJK } from "./render-composites.mjs";
import { onAdProblems } from "./cards.mjs";
import { COPY_MODEL, plainDashes, gymLanguage } from "./draft-copy.mjs";

export { PRESENTER_GENDERS, presenterProblems };
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const OMNI = "gemini-omni-1.2-flash", INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const SCRIPTS_FILE = "video-scripts.json";
/** A script is 2 to 4 lines; a line is one breath (6 to 26 words) and becomes one clip of 5 to 12 seconds. */
export const LINES = [2, 7], LINE_WORDS = [6, 26], CLIP_SECONDS = [5, 15], WORDS_PER_SECOND = 2.8;
/**
 * What a first take needs to be said as written (2026-11-16, measured on the 81 takes on file: 19 of 19 for lines of 17
 * words or fewer, 85% for longer ones; the failures were a word or phrase said twice, and extra words spoken into the
 * time left over). A DRAFTED line is at most `DRAFT_WORDS.line` words, the last line (the turn to the viewer and the
 * closing sentence) `DRAFT_WORDS.last`; the owner's own writing keeps `LINE_WORDS`, and nothing kept before is refused.
 * `CLIP_PAD`: the seconds a clip is given beyond its words (it was a full second; 20 words were said in 7.5 s of an 8 s clip).
 * `READ_MIN`: the least a line may score when it is read aloud (see `readAloud`).
 */
export const DRAFT_WORDS = { line: 17, last: 22 }, CLIP_PAD = 0.8, READ_MIN = 8;
/** What a second of 720p video costs (Google's pricing page, 2026-11-12) and an image call, for the estimate shown before a run. */
export const USD_PER_SECOND = 0.07, USD_PER_IMAGE = 0.15;
/**
 * One person's own voice. The presenter may speak for the gym — we, our, us (the owner, 2026-11-14) — and never as a
 * person with a story of their own: an invented presenter is not a real coach or member, so "I joined" or "my clients"
 * would be a made-up testimony.
 */
export const FIRST_PERSON = /\b(i|i'm|im|i've|i'll|i'd|my|mine|me|myself)\b/i;
/**
 * Chinese scripts (2026-11-20, F45 Xinyi: every video in Taiwanese Mandarin). A Chinese line has no spaces, so it is
 * measured in characters (`units`: a Han character is one, a run of Latin letters or digits — "F45", "InBody", "10" —
 * is one), spoken at about `CHARS_PER_SECOND`; one breath is `LINE_CHARS`, and a cut that carries the closing line
 * may run to `JOINED_CHARS`. One person's own voice in Chinese is 我 alone (我們 is the gym's). The closing line is the
 * language's own (`CLOSING_ZH`, or the library's `closing_zh`).
 */
export const CHARS_PER_SECOND = 4.2, LINE_CHARS = [4, 40], JOINED_CHARS = 60;
export const FIRST_PERSON_ZH = /我(?!們|们)/;
/**
 * Words the video model says wrongly in Chinese, never written into a spoken script (2026-11-22; the owner on Xinyi's
 * videos, 2026-11-21: 班 in 上班 came in the fourth tone whatever the prompt said and however it was spelt — "use other
 * words"). A wrong tone cannot be fixed by the prompt, so the word is not used: a script that says one needs an edit,
 * and the drafter is told. Speech only: a white-paper sheet and written copy may carry them.
 */
export const SPOKEN_AVOID_ZH = [{ word: "上班", say: "工作" }, { word: "下班", say: "忙完工作" }];
/** A drafted Chinese line by the length a first take carries (the owner's approved Xinyi scripts: 10 to 28 characters a line, the last 25 to 35). */
export const DRAFT_CHARS = { line: 28, last: 36 };
// The Chinese closing line (2026-11-21): 「點擊下方連結，我們會跟你聯絡！」 was refused by Google's video model on every
// one of 13 scripts (each 3 times, on two pictures), even after a bridge sentence; 「想了解更多，就留下資料…」 was
// refused too (a call to click a link or leave details is what it blocks); 「現在就報名…」 was filmed and said as written.
export const CLOSING_ZH = "點進連結吧～讓我們更認識你！";
/**
 * The Chinese closings a script may end on (2026-11-21, the owner on Xinyi's videos: "no need to say 現在就報名 … replace
 * it with 點進連結吧～讓我們更認識你", and for some videos 「點進連結，…」 or 「快點進連結，…」 after a bridge he wrote;
 * v05 and v13 keep 「現在就報名，我們會跟你聯絡！」). A Chinese script is held to whichever of these its last line ends on
 * (the first that matches, so 「快點進連結」 is not read as 「點進連結」 with a stray 快); `CLOSING_ZH` is the one drafted.
 */
export const CLOSINGS_ZH = ["快點進連結，讓我們更認識你！", "點進連結吧～讓我們更認識你！", "點進連結，讓我們更認識你！", "現在就報名，我們會跟你聯絡！"];
const ZH_PUNCT = /[\s，。！？、；：「」『』（）…,.!?;:()"'～~—-]/g;
/** A line or text is Chinese when it carries a Han character. */
export const isZh = (x) => hasCJK(Array.isArray(x) ? x.join("") : x);
/** How long a line is: words, or — for a Chinese line — characters (a run of Latin letters or digits counts as one). */
export const units = (line) => (isZh(line) ? (String(line).replace(ZH_PUNCT, "").match(/[A-Za-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]/g) || []).length : wordCount(line));
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
/**
 * A contraction written out, so "you're" and "you are" are the same words (2026-11-15). It also keeps "we're" from
 * reading as "were" and "we'll" as "well" once the apostrophe is gone.
 */
const expand = (s) => s.replace(/\bcannot\b/g, "can not").replace(/\bwon't\b/g, "will not").replace(/\bcan't\b/g, "can not").replace(/\bshan't\b/g, "shall not").replace(/\b([a-z]+)n't\b/g, "$1 not")
  .replace(/\bi'm\b/g, "i am").replace(/\b([a-z]+)'re\b/g, "$1 are").replace(/\b([a-z]+)'ll\b/g, "$1 will").replace(/\b([a-z]+)'ve\b/g, "$1 have").replace(/\b([a-z]+)'d\b/g, "$1 would")
  .replace(/\blet's\b/g, "let us").replace(/\b(it|that|there|here|what|who|he|she|where|how)'s\b/g, "$1 is");
/**
 * One spelling for a word that has two (2026-11-15: both takes of a line were refused because the script said
 * "energised" and the check wrote "energized"). British and American endings by rule (-ise/-ize, -yse/-yze, -our/-or,
 * -tre/-ter), the rest by name; and the pairs a listener takes for one word ("toward", "towards").
 */
const SPELT = { programme: "program", programmes: "programs", practise: "practice", practised: "practiced", practising: "practicing", defence: "defense", licence: "license", offence: "offense", fulfil: "fulfill", fulfilment: "fulfillment", enrol: "enroll", enrolment: "enrollment", skilful: "skillful", grey: "gray", cosy: "cozy", ageing: "aging", judgement: "judgment", focussed: "focused", focussing: "focusing", fuelled: "fueled", fuelling: "fueling", travelled: "traveled", travelling: "traveling", traveller: "traveler", modelled: "modeled", modelling: "modeling", cancelled: "canceled", cancelling: "canceling", labelled: "labeled", levelled: "leveled", totalled: "totaled", counsellor: "counselor", jewellery: "jewelry", tyre: "tire", tyres: "tires", mould: "mold", catalogue: "catalog", dialogue: "dialog", okay: "ok",
  towards: "toward", forwards: "forward", afterwards: "afterward", backwards: "backward", upwards: "upward", downwards: "downward", onwards: "onward", inwards: "inward", outwards: "outward" };
const ear = (w) => SPELT[w] || w.replace(/is(e|es|ed|ing|er|ers|ation|ations)$/, "iz$1").replace(/ys(e|es|ed|ing)$/, "yz$1").replace(/^([a-z]{2,})our(s|ed|ing|ite|ites|ful|able|hood|hoods|ly|less)?$/, (m, a, b = "") => `${a}or${b}`).replace(/([bt])re(s?)$/, "$1er$2");
/** A line as the words a listener hears: lower case, punctuation gone, a contraction written out, a number as its figure, one spelling for a word that has two; a possessive ending ("gym's", "Athletics'", "Athletics's") is the word itself, marked. */
const spoken = (s) => expand(String(s).toLowerCase().replace(/[’‘]/g, "'")).replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).map((raw) => {
  const poss = /[a-z0-9]'s?$/.test(raw), w = (poss ? raw.replace(/'s?$/, "") : raw).replace(/'/g, "");
  return { w: w in NUMBER ? String(NUMBER[w]) : ear(w), poss };
}).filter((t) => t.w);
/** One letter added, dropped or changed at most. */
const near = (a, b) => {
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};
/**
 * The words said are the line's words, in order. Punctuation and case aside; a number may be said or written. What a
 * listener cannot hear is not a difference (2026-11-12: a good take of "Aether Athletics's 6 Week…" was refused twice,
 * heard as "Aether Athletics 6-week" and as "Ether Athletics'"; 2026-11-15: "energised" written "energized"): a
 * possessive ("Athletics's" is said "Athletics"), the spelling of a NAME (`names`: the gym's own name — a word of
 * it may be one letter off, "Ether" for "Aether"), a word with two spellings, a contraction and its two words, and
 * where the spaces fall ("every day" for "everyday", "F 45" for "F45"). Every other word must be the word: one
 * added, dropped or changed is a difference.
 */
export function sameWords(said, line, { names = [], sounds = [] } = {}) {
  if (isZh(line)) return sameChinese(said, line, { names });
  const a = spoken(said), b = spoken(line);
  const named = new Set(names.flatMap((n) => spoken(n).map((t) => t.w)).filter((w) => w.length >= 4));
  // `sounds`: words that are one word to the ear — a word and the way it is said here ("quay", "key", "kee"). A word said
  // as two ("BFIT" is said "Bee Fit": the group holds "bfit" and "beefit") is matched where the spaces are tried, and
  // there the check's spelling of that sound may have one letter more or fewer ("Be Fit"); a changed letter is another word ("Bee Fat").
  const sound = (A, B) => sounds.some((grp) => grp.includes(B) && grp.some((g) => g === A || (g.length >= 5 && g.length !== A.length && near(A, g))));
  const same = (x, y) => x.w === y.w || ((x.poss || y.poss) && (x.w + "s" === y.w || y.w + "s" === x.w)) || (named.has(y.w) && near(x.w, y.w)) || sounds.some((grp) => grp.includes(x.w) && grp.includes(y.w));
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) { i++; j++; continue; }
    // The same letters with the spaces elsewhere: up to three words on a side.
    let hit = null;
    for (let p = 1; p <= 3 && !hit; p++) for (let q = 1; q <= 3 && !hit; q++) { if ((p === 1 && q === 1) || i + p > a.length || j + q > b.length) continue; const A = a.slice(i, i + p).map((t) => t.w).join(""), B = b.slice(j, j + q).map((t) => t.w).join(""); if (A === B || sound(A, B)) hit = [p, q]; }
    if (!hit) return false; i += hit[0]; j += hit[1];
  }
  return i === a.length && j === b.length;
}
export const wordCount = (line) => norm(line).split(" ").filter(Boolean).length;
const ZH_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** Chinese numerals up to 99 as digits ("十" 10, "四十五" 45, "十五" 15), so "10位" and "十位" are the same said. Only a numeral before a measure word or another number is touched where it could be a word ("一起", "一步" stay). */
const zhNumbers = (t) => t.replace(/([一二兩两三四五六七八九]?)十([一二三四五六七八九]?)/g, (m, a, b) => String((a ? ZH_DIGIT[a] : 1) * 10 + (b ? ZH_DIGIT[b] : 0)))
  .replace(/[零〇一二兩两三四五六七八九](?=[0-9]|位|週|周|天|個|堂|分鐘|分|次|號|樓)/g, (m) => String(ZH_DIGIT[m]));
/** The same characters to a listener: one form for the variants a transcript may pick (simplified forms, 劃/畫, 着/著, 台/臺). */
const ZH_SAME = {们: "們", 计: "計", 划: "畫", 劃: "畫", 练: "練", 课: "課", 运: "運", 动: "動", 体: "體", 态: "態", 饮: "飲", 会: "會", 联: "聯", 络: "絡", 连: "連", 结: "結", 点: "點", 击: "擊", 这: "這", 时: "時", 间: "間", 后: "後", 么: "麼", 样: "樣", 还: "還", 没: "沒", 关: "關", 系: "係", 给: "給", 让: "讓", 帮: "幫", 对: "對", 个: "個", 着: "著", 臺: "台", 裏: "裡", 里: "裡", 为: "為", 过: "過", 开: "開", 门: "門", 进: "進", 气: "氣", 觉: "覺", 现: "現", 发: "發", 变: "變", 数: "數", 据: "據", 专: "專", 属: "屬", 规: "規", 准: "準", 备: "備", 话: "話", 说: "說", 听: "聽", 来: "來", 机: "機", 义: "義", 区: "區", 周: "週"};
export const zhForm = (t) => zhNumbers(String(t || "").toLowerCase().replace(ZH_PUNCT, "")).replace(/./gu, (c) => ZH_SAME[c] || c);
/** Particles a speaker may add or drop without changing what is said. */
const ZH_SOFT = new Set([..."的啊囉喔呀吧了嗎呢耶哦欸啦嘛唷哈"]);
/**
 * Said as written, for a Chinese line (2026-11-20). What a listener cannot hear is not a difference: punctuation, a
 * numeral said or written as a digit, a variant form of a character, a particle added or dropped — and a character
 * that sounds the same but was transcribed another way (the check writes what it hears in characters, and Mandarin has
 * many homophones: 在/再, 的/得), up to about one in eight. A character added or dropped (a word said twice, words
 * spoken into the time left over) is a difference.
 */
export function sameChinese(said, line, { names = [] } = {}) {
  // The gym's name in Latin letters (2026-11-21, F45 Xinyi): the check is told to write the business's name the way the
  // profile spells it, so a coach saying 「F45信義店」 came back as "F45 Xinyi店" and good takes failed. A Latin word of the
  // name (3 letters or more) that the line does not carry stands for 1–3 characters of the line where it falls.
  const NAME = "\u0001", l = zhForm(line);
  let s = zhForm(said);
  for (const w of new Set(names.flatMap((n) => String(n).toLowerCase().match(/[a-z]{3,}/g) || []))) if (!l.includes(w)) s = s.split(w).join(NAME);
  const a = [...s].filter((c) => !ZH_SOFT.has(c)), b = [...l].filter((c) => !ZH_SOFT.has(c));
  if (!a.length || !b.length) return false;
  const budget = Math.floor(b.length / 8);
  if (!a.includes(NAME)) {
    if (a.length !== b.length) return false;
    return a.reduce((n, c, i) => n + (c === b[i] ? 0 : 1), 0) <= budget;
  }
  const fit = (i, j, d) => {
    if (d > budget) return false;
    if (i === a.length) return j === b.length;
    if (j >= b.length) return false;
    if (a[i] === NAME) { for (let k = 1; k <= 3 && j + k <= b.length; k++) if (fit(i + 1, j + k, d)) return true; return false; }
    return fit(i + 1, j + 1, d + (a[i] === b[j] ? 0 : 1));
  };
  return fit(0, 0, 0);
}
/** `{AREA}` filled the way the plan fills it in copy: "ANG MO KIO" → "Ang Mo Kio", "CBD" stays. */
export const fillLine = (line, area) => norm(line).replace(/\{AREA\}/g, titleCase(String(area || "")));
/** How long a line's clip is: its words at a talking pace and a second to finish, inside the model's limits (the test's lines of 22, 23 and 15 words were said in 8, 9 and 7 seconds). */
export const clipSeconds = (line) => Math.max(CLIP_SECONDS[0], Math.min(CLIP_SECONDS[1], Math.ceil(isZh(line) ? units(line) / CHARS_PER_SECOND + CLIP_PAD : wordCount(line) / WORDS_PER_SECOND + CLIP_PAD)));

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
 * samples (`closing`), this sentence until he changes it.
 */
export const CLOSING_LINE = "Click the link below and we'll be in touch!", CLOSING_WORDS = [4, 14];
const apos = (x) => String(x ?? "").replace(/[’‘]/g, "'");
const closingRe = (closing) => new RegExp("(?<![A-Za-z0-9'])" + apos(closing).split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "")).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9']+") + "[^A-Za-z0-9']*$", "i");
/** Does a line end with the closing line? Case, spacing and punctuation aside; every word must be there, in order. */
/** The closing line in the script's own language: a Chinese script ends on the Chinese closing line whatever the shared English one says. */
export function closingFor(lines, closing = CLOSING_LINE) {
  if (!isZh(lines) || isZh(closing)) return closing;
  const ls = Array.isArray(lines) ? lines : [lines], last = zhBare(ls[ls.length - 1] || "");
  return CLOSINGS_ZH.find((c) => last.endsWith(zhBare(c))) || CLOSING_ZH;
}
const zhBare = (t) => String(t || "").replace(ZH_PUNCT, "");
export const endsWithClosing = (line, closing = CLOSING_LINE) => (isZh(closing) ? zhBare(line).endsWith(zhBare(closing)) : closingRe(closing).test(apos(line).trim()));
const withoutClosing = (line, closing) => {
  if (!isZh(closing)) return apos(line).trim().replace(closingRe(closing), "");
  // Walk back from the end until the closing line's characters are used up; what is left before them is the rest.
  const t = String(line).trim(), want = [...zhBare(closing)]; let k = want.length, i = t.length;
  while (i > 0 && k > 0) { const c = t[i - 1]; i--; if (c.replace(ZH_PUNCT, "") === "") continue; if (c === want[k - 1]) k--; else return t; }
  return k === 0 ? t.slice(0, i) : t;
};
/** Another call to action than the closing line: "tap below", "tap the button". */
export const TAP = /\btap (?:below|the|on|here|now|this|that)\b/i;
/** The country's own names, for a line that says the whole country as the place. */
const COUNTRY_WORDS = { SG: ["Singapore", "新加坡"], TW: ["Taiwan", "台灣", "臺灣"], MY: ["Malaysia"] };
export function countryNamed(line, { profile = {}, offer = null } = {}) {
  let t = String(line);
  for (const own of [profile.display_name, offer].filter(Boolean)) t = t.split(new RegExp(String(own).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).join(" ");
  return (COUNTRY_WORDS[profileCountry(profile)] || []).find((w) => (/^[A-Za-z]/.test(w) ? new RegExp(`\\b${w}\\b`, "i").test(t) : t.includes(w))) || null;
}
/**
 * The closing line as a script's whole last line. Google's video model refuses that sentence as a clip of its own
 * (2026-11-14, three times on two pictures) and films it after a few words in the same clip, so it is filmed with the
 * line before it: one cut for the two. `filmedLines` is the script as it is filmed — the words unchanged.
 */
export const closingAlone = (line, closing = CLOSING_LINE) => endsWithClosing(line, closing) && !/[A-Za-z0-9\u3400-\u9fff]/.test(withoutClosing(line, closing));
/**
 * The link shown, not said (2026-11-21, the owner's choice when Google's video model refuses 「點進連結」 — it refused
 * 「…，點進連結，讓我們更認識你！」 on v02 and v03 on two pictures each): a script marked `link_on_screen` is filmed with
 * the link phrase left out of its last line («如果你想給自己一個好的開始，讓我們更認識你！»), and once the voice ends the
 * words 「點進連結」 are shown where the captions were, for `LINK_HOLD` seconds. The script's own words are unchanged.
 */
export const LINK_ZH = /快?點進連結吧?[～~]?[，,、]?/, LINK_TEXT_ZH = "點進連結", LINK_HOLD = 1.5, LINK_EXTRA = 2;
/**
 * Is the link shown, not said? The script's own word when it has one (`link_on_screen` true or false); else — since
 * 2026-11-22 — every Chinese script whose last line asks for a click on the link: Google's video model refused that
 * phrase on 13 scripts running, so it is never asked to say it unless the owner says so for that script.
 */
export const linkOnScreen = (script) => (typeof script?.link_on_screen === "boolean" ? script.link_on_screen : isZh(script?.lines || []) && LINK_ZH.test(norm((script?.lines || []).slice(-1)[0] || "")));
export function spokenLines(script, closing = closingLine()) {
  const said = filmedLines(script.lines, closing);
  if (!linkOnScreen(script)) return said;
  const n = said.length - 1; return said.map((l, i) => (i === n ? l.replace(LINK_ZH, "") : l));
}
export const JOINED_WORDS = 36;
export function filmedLines(lines, closing = closingLine()) {
  const ls = (lines || []).map(norm), n = ls.length; closing = closingFor(ls, closing);
  return n >= 2 && closingAlone(ls[n - 1], closing) ? [...ls.slice(0, n - 2), `${ls[n - 2]}${isZh(ls) ? "" : " "}${ls[n - 1]}`] : ls;
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
export const IDEAL_BODY = /\b(?:dream|perfect|ideal|beach|bikini|summer) body\b|\bbody (?:that )?(?:you|they)(?:'ve| have)? always wanted\b|(?:完美|理想|夢想|夢幻|比基尼|夏日)(?:身材|體態|曲線)/i;
export function bridgeOf(lines, closing = CLOSING_LINE) {
  closing = closingFor(lines, closing);
  const cuts = filmedLines(lines, closing), parts = withoutClosing(cuts[cuts.length - 1] || "", closing).trim().split(/(?<=[.!?])\s+|(?<=[。！？])/).filter((x) => x.replace(ZH_PUNCT, ""));
  return (parts[parts.length - 1] || "").trim();
}
/** A Chinese bridge: a clause of its own that turns to the viewer (你) and speaks of what they want or being ready (如果…, 準備好, 想…). */
export const isBridge = (sentence) => (isZh(sentence) ? units(sentence) >= BRIDGE_WORDS && /你/.test(sentence) && /如果|準備|想/.test(sentence) : wordCount(sentence) >= BRIDGE_WORDS && /\byou(?:'re|r)?\b/i.test(apos(sentence)) && (/^(?:so |and |but )?if\b/i.test(sentence) || /\bready\b/i.test(sentence)));
export const BRIDGE_WHY = `the script goes straight into the closing line: just before it, in the same cut, one sentence turns to the viewer and names what they want — "If you're ready to …, now is your time." (${BRIDGE_WORDS} words or more)`;
/** What is wrong with a script's lines, in words; empty when it may be made. `offer`: the exact words it must name; `closing`: the sentence it must end on. */
export function scriptProblems(lines, { offer = null, profile = {}, closing = closingLine(), plain = plainWords(), allow = [] } = {}) {
  const errs = [], asIs = [offer, profile.display_name, closing, ...(allow || [])].filter(Boolean);
  if (!Array.isArray(lines) || lines.length < LINES[0] || lines.length > LINES[1]) return [`a script is ${LINES[0]} to ${LINES[1]} lines, one for each cut`];
  const ls = lines.map(norm), last = ls.length - 1, zh = isZh(ls); closing = closingFor(ls, closing); asIs.push(closing);
  ls.forEach((l, i) => {
    const n = units(fillLine(l, "Ang Mo Kio"));
    if (zh) { if (n < LINE_CHARS[0] || n > LINE_CHARS[1]) errs.push(`line ${i + 1} is ${n} characters: a line is one breath, ${LINE_CHARS[0]} to ${LINE_CHARS[1]} characters`); }
    else if (n < LINE_WORDS[0] || n > LINE_WORDS[1]) errs.push(`line ${i + 1} is ${n} words: a line is one breath, ${LINE_WORDS[0]} to ${LINE_WORDS[1]} words`);
    const odd = (l.match(/\{[^}]*\}/g) || []).filter((x) => x !== "{AREA}"); if (odd.length) errs.push(`line ${i + 1}: only {AREA} may stand in for a word (found ${odd.join(", ")})`);
    // "We", "our" and "us" are the gym's voice; one person's own (I, my, me) is not the presenter's to use. The closing line is the owner's own sentence, as it is.
    const own = (i === last ? withoutClosing(l, closing) : l).replace(/\{AREA\}/g, "");
    if (zh && FIRST_PERSON_ZH.test(own)) errs.push(`line ${i + 1} speaks as one person ("我"): the presenter may speak for the gym (我們), never as a coach or a member with a story of their own (我)`);
    if (FIRST_PERSON.test(own)) errs.push(`line ${i + 1} speaks as one person ("${own.match(FIRST_PERSON)[0]}"): the presenter may speak for the gym (we, our, us), never as a coach or a member with a story of their own (I, my, me)`);
    if (TAP.test(l)) errs.push(`line ${i + 1} says "${l.match(TAP)[0]}": the only call to action is the closing line`);
    const ideal = apos(l).match(IDEAL_BODY); if (ideal) errs.push(`line ${i + 1} promises an ideal body ("${ideal[0]}"): say what the person will feel or be able to do`);
    const country = countryNamed(l, { profile, offer }); if (country) errs.push(`line ${i + 1} names the whole country ("${country}"): the place is only ever {AREA}, the area around the gym`);
    if (/[\n\r]/.test(String(lines[i]))) errs.push(`line ${i + 1} is two lines: one line is one cut`);
    for (const h of hardWordsIn(l, plain, asIs)) errs.push(plainWhy(i, h));
    // The gym's own wording (what it never says, and what it says in its place), and the words the video model says wrongly.
    for (const r of wordingHits(l, profile, { spoken: true })) errs.push(`line ${i + 1} ${wordingWhy(r)}`);
    if (zh) for (const a of SPOKEN_AVOID_ZH) if (l.includes(a.word)) errs.push(`line ${i + 1} says "${a.word}": the video model says it in the wrong tone — say "${a.say}"`);
  });
  if (!endsWithClosing(ls[last], closing)) errs.push(`the last line ends with the closing line, word for word: "${closing}"`);
  else if (!isBridge(bridgeOf(ls, closing))) errs.push(BRIDGE_WHY);
  if (zh && endsWithClosing(ls[last], closing) && closingAlone(ls[last], closing) && units(`${ls[last - 1]}${ls[last]}`) > JOINED_CHARS) errs.push(`line ${last} and the closing line are filmed as one cut and together they are ${units(`${ls[last - 1]}${ls[last]}`)} characters: at most ${JOINED_CHARS}, so shorten line ${last}`);
  if (!zh && endsWithClosing(ls[last], closing) && closingAlone(ls[last], closing) && wordCount(fillLine(`${ls[last - 1]} ${ls[last]}`, "Ang Mo Kio")) > JOINED_WORDS) errs.push(`line ${last} and the closing line are filmed as one cut (the closing line cannot be a clip of its own) and together they are ${wordCount(fillLine(`${ls[last - 1]} ${ls[last]}`, "Ang Mo Kio"))} words: at most ${JOINED_WORDS}, so shorten line ${last}`);
  const all = ls.join(" ");
  if (offer && !all.toLowerCase().includes(norm(offer).toLowerCase())) errs.push(`the script must name the offer in its exact words: "${norm(offer)}"`);
  for (const e of onAdProblems(fillLine(all, "Bishan"), profile)) if (!errs.includes(e) && !WORDING_WHY.test(e)) errs.push(e);
  return errs;
}
const WORDING_WHY = /^says ".*": at this gym it is "/;          // said above with its line
const objOf = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
// `sheets`: the white-paper videos' scripts (paper-video.mjs) — their own list, kept through every write of this file.
export const readScripts = (gymDir) => { const j = readJson(join(gymDir, SCRIPTS_FILE)); return { schema: 1, scripts: Array.isArray(j?.scripts) ? j.scripts : [], sheets: Array.isArray(j?.sheets) ? j.sheets : [], samples: Array.isArray(j?.samples) ? j.samples : [], facts: objOf(j?.facts), pains: objOf(j?.pains) }; };
export const writeScripts = (gymDir, data) => writeFileSync(join(gymDir, SCRIPTS_FILE), JSON.stringify({ schema: 1, scripts: data.scripts || [], ...((data.sheets || []).length ? { sheets: data.sheets } : {}), samples: data.samples || [], facts: data.facts || {}, pains: data.pains || {} }, null, 2) + "\n");
const shape = (lines) => lines.map(norm).join(" ").toLowerCase().replace(/[^a-z0-9 \u3400-\u9fff\uf900-\ufaff]/g, "");
/** Add a script: the owner's own is kept at once, a drafted one waits for him. Never twice. */
export function addScript(gymDir, { lines, offer, source = "owner", pain = null, style = null }, { profile = {}, closing = closingLine(), plain = plainWords() } = {}) {
  const ls = (lines || []).map((l) => plainDashes(norm(l))), errs = scriptProblems(ls, { offer, profile, closing, plain, allow: factsFor(gymDir, offer) });
  if (errs.length) throw new Error(errs.join("; "));
  const data = readScripts(gymDir), key = shape(ls);
  if (data.scripts.some((s) => shape(s.lines) === key)) throw Object.assign(new Error("this script is already here"), { duplicate: true });
  const row = { id: `v-${sha(key).slice(0, 10)}`, lines: ls, offer: norm(offer), status: source === "owner" ? "kept" : "draft", source, ...(pain ? { pain: norm(pain) } : {}), ...(style?.id ? { style: { id: style.id, name: norm(style.name) } } : {}), added: today() };
  data.scripts.push(row); writeScripts(gymDir, data); return row;
}
/** The owner keeps a draft, edits it (checked again), puts it back, or retires it with a reason — never deleted. A script that breaks today's rules is not kept until it is edited. */
export function decideScript(gymDir, id, { status, lines, reason } = {}, { profile = {}, closing = closingLine() } = {}) {
  const data = readScripts(gymDir), row = data.scripts.find((s) => s.id === id);
  if (!row) throw new Error(`no such script: ${id}`);
  if (lines != null) { const ls = lines.map((l) => plainDashes(norm(l))), errs = scriptProblems(ls, { offer: row.offer, profile, closing, allow: factsFor(gymDir, row.offer) }); if (errs.length) throw new Error(errs.join("; ")); row.lines = ls; row.edited = today(); }
  if (status != null) {
    if (!["kept", "draft", "retired"].includes(status)) throw new Error("status must be kept, draft or retired");
    if (status === "retired") { if (typeof reason !== "string" || reason.trim().length < 3) throw new Error("retiring a script needs a reason"); row.reason = reason.trim(); row.retired_on = today(); }
    else { delete row.reason; delete row.retired_on; }
    if (status === "kept" && row.status !== "kept") { const errs = scriptProblems(row.lines, { offer: row.offer, profile, closing, allow: factsFor(gymDir, row.offer) }); if (errs.length) throw new Error(`edit it first: ${errs.join("; ")}`); }
    row.status = status;
  }
  writeScripts(gymDir, data); return row;
}
/** How a line must read: it is heard once, said by a person. Told to the drafter and the editor, and scored by `readAloud`. */
export const READ_RULE = `READ IT ALOUD: every line is something a person would really say to a friend, in correct, natural spoken English. No clumsy or stitched-together phrase, no word (or a close form of it: "energised … energy", "everyday … every day") used twice in one line, nothing that reads like writing rather than speech.`;
const READ_SCHEMA = { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, score: { type: "INTEGER" }, why: { type: "STRING" } }, required: ["id", "score", "why"] } } }, required: ["lines"] };
export function buildReadPrompt({ scripts, offer, profile = {}, closing = CLOSING_LINE, fixed = [], models = [] }) {
  const gym = profile.display_name || "the gym";
  // The owner's own wording is not the check's to mark down (2026-11-22: it scored his required phrase 「我們會先初步了解你的目標」 under 8 as "redundant", and a draft was dropped for it): the phrases his rules put in, and the facts as he typed them.
  const own = [...new Set([...sayInstead(profile).map((r) => r.say), ...(fixed || [])].map(norm).filter(Boolean))];
  return { schema: READ_SCHEMA, prompt: [
    `Each numbered line below is spoken aloud to the camera by one person in a short video advert for ${gym}. Read each line aloud in your head and score it 1 to 10 for how natural it is as something a person would SAY: 10 = a native speaker would say exactly this; 8 = fine; under 8 when the grammar is wrong, a phrase is clumsy or stitched together ("plenty of energy that lasts left for your own evenings", "we are here to help you every step"), a word or a close form of it is used twice in the line ("energised … energy"), it reads like writing rather than speech, or it is a mouthful that would be hard to say cleanly in one breath.`,
    ...(isZh(scripts.flat()) ? [`The lines are in Taiwanese Mandarin: judge them as Mandarin SPOKEN in Taipei. Under 8 as well for a written or formal word where a spoken one is natural (書面語), a mainland-Chinese wording, a phrase that reads as translated from English, or a simplified character.`] : []),
    `Do NOT judge what the line claims, how long it is in words, or these fixed parts, which stay as they are: the programme's name "${offer}", the gym's name "${gym}", the placeholder {AREA} (a place name goes there), and the sentence "${closing}".${own.length ? ` These phrases are the owner's own wording for this gym and stay as they are too — never mark a line down for one of them: ${own.map((x) => `"${x}"`).join("; ")}.` : ""}`,
    ...(models.length ? [`THE STANDARD of what is natural for this gym — scripts the owner has approved and filmed. A line that reads as naturally as these is 8 or more; judge against them, not against a stricter ideal:\n${models.map((m) => m.join("\n")).join("\n")}`] : []),
    `THE LINES:\n${scripts.flatMap((ls, s) => ls.map((l, i) => `${s + 1}.${i + 1} ${l}`)).join("\n")}`,
    `Answer with every line: its id as written ("1.2"), its score, and why — for a line under 8 the fault in a few words, quoting the clumsy part; an empty string otherwise.`,
  ].join("\n\n") };
}
/**
 * Every line read aloud (2026-11-16, the owner on "help you every step" and "plenty of energy that lasts left": "this
 * is horrible grammar from the script drafting … no wonder the video can't generate a good one"): one text call scores
 * each line of each script for how it is SAID; a line under `READ_MIN` is a fault, in words. Returns, for each script,
 * its faults: [{ line (1-based), score, why }]. An answer that cannot be read judges nothing (`unread`), and says so.
 */
export async function readAloud(scripts, { offer, profile = {}, closing = CLOSING_LINE, ask = callVision, model = COPY_MODEL, fixed = [], models = [] } = {}) {
  if (!scripts.length) return { faults: [], unread: false };
  const { prompt, schema } = buildReadPrompt({ scripts, offer, profile, closing, fixed, models }), answer = await ask(null, prompt, schema, { model });
  const rows = Array.isArray(answer?.lines) ? answer.lines.filter((r) => /^\d+\.\d+$/.test(String(r?.id)) && Number.isFinite(Number(r.score))) : [];
  const faults = scripts.map(() => []);
  for (const r of rows) { const [s, i] = String(r.id).split(".").map(Number); if (faults[s - 1] && scripts[s - 1][i - 1] != null && Number(r.score) < READ_MIN) faults[s - 1].push({ line: i, score: Number(r.score), why: norm(r.why) || "it does not read as something a person would say" }); }
  return { faults, unread: !rows.length };
}
const readProblem = (f) => `line ${f.line} does not read as something a person would say out loud (${f.why})`;
/** A drafted script's lines by the lengths a first take can carry: empty when they fit. */
export const lastWords = (closing = CLOSING_LINE, words = DRAFT_WORDS) => words.last + Math.max(0, wordCount(closing) - wordCount(CLOSING_LINE));
export function draftLengths(lines, closing = CLOSING_LINE, words = DRAFT_WORDS) {
  if (isZh(lines)) { const ls = (lines || []).map(norm), n = ls.length - 1; return ls.map((l, i) => { const c = units(fillLine(l, "信義區")), most = i === n ? DRAFT_CHARS.last : DRAFT_CHARS.line; return c > most ? `line ${i + 1} is ${c} characters: a drafted line is at most ${most}, so that it is said cleanly in one take — say it shorter, or split it in two lines` : null; }).filter(Boolean); }
  const cuts = filmedLines(lines, closing), last = cuts.length - 1;
  return cuts.map((l, i) => { const n = wordCount(fillLine(l, "Ang Mo Kio")), most = i === last ? lastWords(closing, words) : words.line; return n > most ? `line ${i + 1} is ${n} words: a drafted line is at most ${most}, so that it is said cleanly in one take — say it shorter, or split it in two lines` : null; }).filter(Boolean);
}
const LONG_LINE = /a drafted line is at most/;
const EDIT_SCHEMA = { type: "OBJECT", properties: { lines: { type: "ARRAY", items: { type: "STRING" } }, note: { type: "STRING" } }, required: ["lines", "note"] };
export function buildEditPrompt({ profile = {}, script, problems, closing = CLOSING_LINE }) {
  const gym = profile.display_name || "the gym";
  if (isZh(script.lines)) {
    const end = closingFor(script.lines, closing), house = wordingRule(profile, { spoken: true });
    return { schema: EDIT_SCHEMA, prompt: [
      `This is a short script, in Taiwanese Mandarin, for a talking-to-camera video advert for ${gym}'s programme 「${script.offer}」, one line for each cut. It breaks the rules below. Propose the SMALLEST edit that mends it, for the owner to approve.`,
      `THE SCRIPT:\n${script.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
      `WHAT IS WRONG:\n${problems.map((x) => `- ${x}`).join("\n")}`,
      `THE RULES. Keep every line that breaks no rule exactly as it is, character for character and in its place; change only what a rule requires, and keep the owner's voice. ${ZH_LANGUAGE} The last line is two beats: a clause that turns to the viewer and names what they want, beginning 如果你… (what they will feel or be able to do, never an ideal body, never a promised result), then exactly these characters, the only call to action: 「${end}」. The offer is named in its exact characters: 「${script.offer}」. The speaker speaks for the gym: 我們 is fine; never 我 alone, never a personal story. Each line is one breath, at most ${DRAFT_CHARS.line} characters (the last line ${DRAFT_CHARS.last}); a script is ${LINES[0]} to ${LINES[1]} lines. Where a word or phrase is named above as not used, REWRITE THE WHOLE SENTENCE so that it reads as something a person would say out loud — never swap the word and leave the rest standing. ${ZH_AVOID}`,
      house,
      `Answer with every line of the script after the edit, in order, and a note of one sentence (in English) saying what you changed.`,
    ].filter(Boolean).join("\n\n") };
  }
  return { schema: EDIT_SCHEMA, prompt: [
    `This is a short script for a talking-to-camera video advert for ${gym}'s programme "${script.offer}", one line for each cut. It breaks the rules below. Propose the SMALLEST edit that mends it, for the owner to approve.`,
    `THE SCRIPT:\n${script.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    `WHAT IS WRONG:\n${problems.map((x) => `- ${x}`).join("\n")}`,
    `THE RULES. Keep every line that breaks no rule exactly as it is, word for word and in its place; change only what a rule requires, and keep the owner's voice. The ending is two beats in the last line: first ONE sentence of its own that turns to the viewer and names what they want, in this shape — "If you're ready to [what they want], now is your time." (what they will feel or be able to do, never an ideal body, never a promised result) — and then exactly this sentence, word for word: "${closing}". That sentence is the only call to action, so a sentence that says "tap below", names a button or gives another instruction is taken out. When the script goes straight into the closing sentence, add the bridge sentence before it and change nothing else. The offer is named in its exact words: "${script.offer}". The place is only ever written {AREA}, never the country. The speaker speaks for the gym: "we", "our" and "us" are fine; never "I", "my" or "me", and never a personal story. Each line is one breath, ${LINE_WORDS[0]} to ${LINE_WORDS[1]} words; a script is ${LINES[0]} to ${LINES[1]} lines. Never: a price, free, before and after, a guarantee, a promised result, a number of kilos, an em dash.`,
    `${PLAIN_RULE} Where a word is named above as not plain, REWRITE THE WHOLE SENTENCE it is in, so that it says the same thing in small words and reads as something a person would say out loud. Never swap the word and leave the rest standing: "plenty of stamina left for your evenings" becomes "lots of energy left for your evenings", never "plenty of energy that lasts left for your evenings". The programme's name, the gym's name and the closing sentence stay as they are.`,
    `${READ_RULE} A line you change is at most ${DRAFT_WORDS.line} words (the last line ${DRAFT_WORDS.last}).`,
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
  const allow = factsFor(brandDir, script.offer), plain = plainWords(libraryDir), rules = (ls) => scriptProblems(ls, { offer: script.offer, profile, closing, plain, allow });
  const heard = async (ls) => (await readAloud([ls], { offer: script.offer, profile, closing, ask, model, fixed: allow })).faults[0].map(readProblem);
  let calls = 0, problems = rules(script.lines);
  // A script that breaks no rule may still not read as speech (a word swapped into a sentence that no longer holds): read it aloud, and propose for what that finds.
  if (!problems.length) { problems = await heard(script.lines); calls++; if (!problems.length) throw new Error("this script breaks no rule and reads well aloud: nothing to propose"); }
  let left = problems, kind = "rule";
  for (let round = 0; round < 2; round++) {
    const { prompt, schema } = buildEditPrompt({ profile, script, problems: left, closing });
    const answer = await ask(null, prompt, schema, { model }); calls++;
    const lines = (answer?.lines || []).map((l) => plainDashes(norm(l))).filter(Boolean);
    left = rules(lines); kind = "rule";
    // The edit itself is read aloud before it is offered: a swap that mends the rule and breaks the sentence is asked for again.
    if (!left.length) { left = await heard(lines); calls++; kind = "read"; }
    if (!left.length) return { lines, changed: lines.map((l, i) => (l === norm(script.lines[i] ?? "") ? 0 : i + 1)).filter(Boolean).concat(script.lines.length > lines.length ? [lines.length] : []).filter((x, i, a) => a.indexOf(x) === i), note: norm(answer?.note), problems, calls };
  }
  throw new Error(kind === "read" ? `the agent's edit does not read well aloud (${left[0]}): edit the script yourself` : `the agent's edit still breaks a rule (${left[0]}): edit the script yourself`);
}
/** The scripts ready for an offer: kept, and written for these exact words. */
export const keptScripts = (gymDir, offer = null) => readScripts(gymDir).scripts.filter((s) => s.status === "kept" && (!offer || norm(s.offer).toLowerCase() === norm(offer).toLowerCase()));
/** What a script on file breaks by today's rules (the closing line came after some were kept): empty when it may be filmed. */
export const scriptIssues = (script, { profile = {}, closing = closingLine(), gymDir = null } = {}) => scriptProblems(script.lines, { offer: script.offer, profile, closing, allow: gymDir ? factsFor(gymDir, script.offer) : [] });
/** The scripts that may be filmed for an offer: kept, and passing today's rules. */
export const readyScripts = (gymDir, offer = null, opts = {}) => keptScripts(gymDir, offer).filter((x) => !scriptIssues(x, { gymDir, ...opts }).length);
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
export const readSamples = (libDir = videoLibraryDir()) => { const j = readJson(join(libDir, SAMPLES_FILE)); return { schema: 1, samples: Array.isArray(j?.samples) ? j.samples : [], closing: j?.closing && typeof j.closing.text === "string" ? j.closing : null, said: Array.isArray(j?.said) ? j.said : [], plain: Array.isArray(j?.plain) ? j.plain : [] }; };
const writeSamples = (libDir, data) => { mkdirSync(libDir, { recursive: true }); writeFileSync(join(libDir, SAMPLES_FILE), JSON.stringify({ schema: 1, samples: data.samples, ...(data.closing ? { closing: data.closing } : {}), ...(data.said?.length ? { said: data.said } : {}), ...(data.plain?.length ? { plain: data.plain } : {}) }, null, 2) + "\n"); };
/**
 * How a word is said (2026-11-14, the owner: "'Quay' is pronounced 'Kee' in Singapore. Edge case but let's account for
 * it too"). A short list for every gym — the standing entries here, and the owner's own in the shared library
 * (`said`), which win and may take a standing one out. **The presenter is given the word written the way it sounds**
 * (2026-11-15: told "Quay is pronounced kee", the video model still said "kway"; given "Boat Key" to read it said
 * "kee" — the owner's ear on a test clip), so `say` is a real word with that sound where there is one. The check
 * takes either spelling for the word; how it sounded is the owner's to judge — the check's ear called "kway" "kee" —
 * so Pick Ads names the word to listen for, with Film this line again beside it.
 */
/**
 * A Chinese word's tones (2026-11-20, the owner on a coach's test clip: "when she says 上班 she uses the fourth tone for
 * 班 but it's supposed to be the first tone"). A Chinese entry gives the word's pinyin (`pinyin: true`): the line is
 * not rewritten — the video model is told how the word is said, tone by tone — and the owner is told to listen for it.
 */
export const SAID_AS = [{ word: "Quay", say: "Key", heard: ["kee"] }, { word: "F45", say: "F四十五", zh: true }, { word: "上班", say: "shàng bān", pinyin: true, note: "班 in the first tone, bān (flat and high), never the fourth tone" }, { word: "下班", say: "xià bān", pinyin: true, note: "班 in the first tone, bān (flat and high), never the fourth tone" }];
const letters = (w) => String(w).normalize("NFD").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, "");
export function saidAs(libDir = videoLibraryDir()) {
  const out = new Map(SAID_AS.map((x) => [letters(x.word), { ...x }]));
  for (const x of readSamples(libDir).said) { const k = letters(x.word); if (x.removed) out.delete(k); else if (x.word && x.say) out.set(k, { word: x.word, say: x.say, ...(isZh(x.word) ? { pinyin: true, ...(x.note ? { note: x.note } : {}) } : {}), heard: out.get(k)?.say === x.say ? out.get(k).heard || [] : [] }); }
  return [...out.values()];
}
export function saidProblems(word, say) {
  const errs = [];
  if (isZh(word)) { if (!/^[\u3400-\u9fff]{1,6}$/.test(String(word).trim())) errs.push("the word is 1 to 6 Chinese characters, as written (\"上班\")"); if (!/^[a-zA-Z\u00C0-\u024F\u0300-\u036F ]{2,60}$/.test(String(say || "").trim())) errs.push("how it is said is its pinyin, with tone marks (\"shàng bān\")"); return errs; }
  if (!/^[A-Za-z][A-Za-z'-]{1,29}$/.test(String(word || "").trim())) errs.push("the word is one word as it is written, 2 to 30 letters (\"Quay\")");
  if (!/^[A-Za-z][A-Za-z '-]{0,39}$/.test(String(say || "").trim())) errs.push("how it is said is written the way it sounds, in letters, as a real word where there is one (\"Key\"): the presenter reads exactly this");
  return errs;
}
/** Add or change how a word is said, for every gym; an empty `say` takes the word off the list. */
export function setSaid(libDir, word, say) {
  const w = norm(word), how = norm(say), data = readSamples(libDir), rest = data.said.filter((x) => letters(x.word) !== letters(w));
  if (!how) { if (!/^[A-Za-z][A-Za-z'-]{1,29}$/.test(w) && !/^[\u3400-\u9fff]{1,6}$/.test(w)) throw new Error("which word?"); data.said = [...rest, ...(SAID_AS.some((x) => letters(x.word) === letters(w)) ? [{ word: w, removed: true, updated: today() }] : [])]; }
  else { const errs = saidProblems(w, how); if (errs.length) throw new Error(errs.join("; ")); data.said = [...rest, { word: w, say: how, updated: today() }]; }
  writeSamples(libDir, data); return saidAs(libDir);
}
/** The entries whose word is in a line, as a whole word. */
// An entry marked `zh` is for Chinese lines only (2026-11-21: in Chinese "F45" is said 「F四十五」, the owner's word; in English it is "F forty-five" as it is).
export const saidIn = (line, list = []) => list.filter((x) => !x.zh || isZh(line)).filter((x) => (isZh(x.word) ? String(line).includes(x.word) : false) || new RegExp(`(?<![A-Za-z])${x.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i").test(String(line)));
/** What names a clip beside its words and its picture: a changed way of saying a word films that line again, and no other. */
const saidNote = (entries) => entries.map((x) => `${letters(x.word)}=${letters(x.say)}`).sort().join("|");
/** Words that are one word to the ear: the word, the way it is written for the presenter, and other ways the check may spell that sound. */
const soundsOf = (entries) => entries.map((x) => [x.word, x.say, ...(x.heard || [])].map(letters));
/**
 * Plain words (2026-11-15, the owner: "the vocabulary in the video … must be third grade reading and below. Right now,
 * 'mid-afternoon slumps', 'vitality', 'functional muscle', 'baseline', 'oversized jackets' should be 'jackets that are
 * too big', etc. should not be used when drafting the scripts"). A script is spoken, once, to someone scrolling: every
 * word is one a nine-year-old knows. Two rules in code, for every gym:
 *   · words never used — the standing list here (gym, science and office words, each with the plain way to say it)
 *     and the owner's own in the shared library (`plain`), which may also take a standing one off;
 *   · a long word — `LONG_SYLLABLES` or more by `syllables` — unless it is an everyday one (`EASY_LONG`) or the
 *     owner has said it is fine.
 * The programme's name, the gym's name, the closing line and the facts the owner typed for the offer are said as they
 * are (`allow`). The syllable count is a rule of thumb, which is why a long word can be marked fine.
 */
export const LONG_SYLLABLES = 4;
export const HARD_WORDS = [
  { word: "vitality", say: "energy" }, { word: "functional", say: "for everyday things", re: "functional(?:ly|ity)?" }, { word: "baseline", say: "where you are now" },
  { word: "slump", say: "feeling tired" }, { word: "oversized", say: "too big", re: "oversized?" }, { word: "mid-afternoon", say: "after lunch", re: "mid[\\s-]?(?:afternoon|morning)s?" },
  { word: "sluggish", say: "slow and tired", re: "sluggish(?:ness|ly)?" }, { word: "lethargic", say: "tired", re: "letharg(?:ic|y)" }, { word: "fatigue", say: "tired" },
  { word: "stamina", say: "energy that lasts" }, { word: "endurance", say: "keeping going for longer" }, { word: "metabolism", say: "how your body uses food", re: "metabol(?:ism|ic)" },
  { word: "sustainable", say: "that you can keep up", re: "sustainabl[ey]|sustain(?:s|ed|ing)?" }, { word: "accountability", say: "someone to keep you going", re: "accountab(?:le|ility)" },
  { word: "optimise", say: "make better", re: "optimi[sz](?:e[sd]?|ing|ation)|optimal(?:ly)?|optimum" }, { word: "maximise", say: "get the most from", re: "maximi[sz](?:e[sd]?|ing)" },
  { word: "holistic", say: "whole", re: "holistic(?:ally)?" }, { word: "mobility", say: "moving easily" }, { word: "flexibility", say: "bending and moving easily" },
  { word: "posture", say: "how you stand and sit" }, { word: "physique", say: "body" }, { word: "composition", say: "your body" }, { word: "conditioning", say: "getting fit" },
  { word: "cardiovascular", say: "heart" }, { word: "sedentary", say: "sitting all day" }, { word: "plateau", say: "stuck" }, { word: "momentum", say: "keeping going" },
  { word: "regimen", say: "plan", re: "regimen?s?" }, { word: "revitalise", say: "feel fresh again", re: "revitali[sz]\\w*|rejuvenat\\w*|invigorat\\w*" },
  { word: "empower", say: "help", re: "empower\\w*" }, { word: "elevate", say: "lift" }, { word: "tailored", say: "made for you", re: "tailor(?:ed|ing|s)?|bespoke|personali[sz]ed|customi[sz]ed" },
  { word: "comprehensive", say: "full", re: "comprehensive(?:ly)?" }, { word: "fundamentals", say: "the basics", re: "fundamentals?|foundational" }, { word: "utilise", say: "use", re: "utili[sz]\\w*" },
  { word: "enhance", say: "make better" }, { word: "achieve", say: "reach", re: "achiev(?:e[sd]?|ing|ements?)|attain\\w*" }, { word: "resilient", say: "strong", re: "resilien(?:t|ce)" },
  { word: "discipline", say: "sticking with it" }, { word: "consistent", say: "sticking with it", re: "consisten(?:t|tly|cy)" }, { word: "lifestyle", say: "the way you live" },
  { word: "wellness", say: "feeling well", re: "wellness|well[\\s-]?being" }, { word: "sculpt", say: "shape" }, { word: "abdominal", say: "tummy", re: "abdominals?|abdomen|midsection" },
  { word: "glutes", say: "legs", re: "glutes?|quads|hamstrings?|posterior" }, { word: "calories", say: "food", re: "calori\\w*|macros?|macronutrients?" },
  { word: "hormones", say: "your body", re: "hormon\\w*|cortisol|insulin|inflammation" }, { word: "intimidating", say: "scary", re: "intimidat\\w*" }, { word: "guidance", say: "help" },
  { word: "effortless", say: "easy", re: "effortless(?:ly)?|seamless(?:ly)?" }, { word: "navigate", say: "find your way" }, { word: "genuine", say: "real", re: "genuine(?:ly)?" },
  { word: "thrive", say: "do well" }, { word: "vibrant", say: "full of life" }, { word: "robust", say: "strong" }, { word: "agility", say: "quick on your feet", re: "agil(?:e|ity)" },
  { word: "winded", say: "out of breath" }, { word: "depleted", say: "worn out", re: "deplet\\w*" }, { word: "wardrobe", say: "clothes", re: "wardrobes?|attire|garments?|apparel" },
  { word: "reclaim", say: "get back", re: "reclaim\\w*|regain\\w*|restor(?:e[sd]?|ing)|reignit\\w*|rekindl\\w*" }, { word: "embark", say: "start", re: "embark\\w*|commenc\\w*|initiat\\w*|kick[\\s-]?start\\w*|jump[\\s-]?start\\w*" },
  { word: "self-conscious", say: "shy about how you look", re: "self[\\s-]?conscious" }, { word: "self-esteem", say: "how you feel about yourself", re: "self[\\s-]?esteem" }, { word: "mindset", say: "how you think" },
  { word: "clarity", say: "a clear head" }, { word: "productive", say: "getting more done", re: "productiv\\w*" }, { word: "efficient", say: "quick", re: "efficien\\w*" }, { word: "effective", say: "that works", re: "effective(?:ly|ness)?" },
  { word: "structured", say: "planned" }, { word: "framework", say: "plan", re: "frameworks?|methodolog\\w*|protocols?" }, { word: "gradually", say: "bit by bit", re: "gradual(?:ly)?|incremental(?:ly)?" },
  { word: "substantial", say: "big", re: "substantial(?:ly)?|significant(?:ly)?" }, { word: "numerous", say: "many", re: "numerous|various|multiple" },
  { word: "therefore", say: "so", re: "therefore|furthermore|moreover|nevertheless|whereas" }, { word: "however", say: "but" }, { word: "ensure", say: "make sure" },
  { word: "assist", say: "help", re: "assist(?:s|ed|ing|ance)?" }, { word: "require", say: "need", re: "requir(?:e[sd]?|ing|ements?)" }, { word: "obtain", say: "get", re: "obtain\\w*" }, { word: "purchase", say: "buy" },
  { word: "individuals", say: "people", re: "individuals?" }, { word: "hectic", say: "busy" }, { word: "exhausted", say: "very tired", re: "exhaust(?:ed|ing|ion)" }, { word: "discomfort", say: "aches" },
  { word: "chronic", say: "that will not go away" }, { word: "alleviate", say: "ease", re: "alleviat\\w*" },
];
/** Everyday words the syllable count calls long: a child of nine knows them. */
const EASY_LONG = new Set("everybody anybody everyday everything everywhere usually actually especially definitely absolutely exercising exercises comfortable comfortably uncomfortable interesting interested vegetables vegetable television community impossible january february supermarket understanding understand watermelon caterpillar alligator helicopter motorcycle elevator escalator kindergarten dictionary ordinary necessary congratulations eventually anywhere somebody anything immediately complicated celebrating celebration elementary information invitation conversation american beautiful beautifully differently activity activities confidently literally basically obviously".split(" "));
const rx = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A listed word with its plain endings: "slump" finds slumps and slumped, "achieve" achieving, "mobility" mobilities; a space or a hyphen in it may be either, or neither. */
function hardRe(word, re = null) {
  if (re) return new RegExp(`(?<![A-Za-z])(?:${re})(?![A-Za-z])`, "gi");
  const e = rx(apos(word).toLowerCase().trim()).replace(/[\s-]+/g, "[\\s-]?");
  const body = /[a-z]e$/.test(e) ? `${e.slice(0, -1)}(?:e[sd]?|ing)` : /[^aeiou]y$/.test(e) ? `${e.slice(0, -1)}(?:y|ies|ied|ily)` : `${e}(?:s|es|ed|ing|ly)?`;
  return new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, "gi");
}
/** Syllables in a word, by the usual rule of thumb (vowel groups, a silent ending dropped). Good enough to tell a long word; `EASY_LONG` and the owner's own list mend its misses. */
export function syllables(word) {
  let w = String(word || "").toLowerCase().replace(/[^a-z]/g, ""); if (!w) return 0; if (w.length <= 3) return 1;
  // A silent e before an ending ("completely", "movement") is no syllable; nor is the one that ends a word ("stairs" aside, "clothes", "tired").
  w = w.replace(/^every/, "evry").replace(/([^aeiouy])e(ly|ment|ments|ness|ful|less)$/, "$1$2").replace(/(?:[^laeiouy]es|[^aeiouytd]ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return (w.match(/[aeiouy]{1,2}/g) || [""]).length;
}
const plainKey = (w) => apos(w).toLowerCase().replace(/[^a-z' -]/g, "").replace(/\s+/g, " ").trim();
/** The plain-word lists in force: { never[{ word, say, standing, re }], fine[word] } — the standing list, then the owner's own (which win, and may take a standing word off). */
export function plainWords(libDir = videoLibraryDir()) {
  const never = new Map(HARD_WORDS.map((x) => [plainKey(x.word), { word: x.word, say: x.say, standing: true, re: hardRe(x.word, x.re) }])), fine = new Set();
  for (const x of readSamples(libDir).plain) { const k = plainKey(x.word); if (!k) continue; if (x.fine) fine.add(k); else if (x.removed) never.delete(k); else if (x.say) never.set(k, { word: x.word, say: x.say, standing: false, re: hardRe(x.word) }); }
  return { never: [...never.values()], fine: [...fine] };
}
export function plainProblems(word, { say = null, fine = false } = {}) {
  const errs = [];
  if (!/^[A-Za-z][A-Za-z' -]{1,39}$/.test(String(word || "").trim())) errs.push("the word (or short phrase) as it is written, 2 to 40 letters (\"vitality\", \"mid-afternoon\")");
  if (fine && /[\s-]/.test(String(word || "").trim())) errs.push("a word that is fine is one word");
  if (!fine && !/^[A-Za-z][A-Za-z' -]{1,59}$/.test(String(say || "").trim())) errs.push("say what to use in its place, in small words (\"energy\", \"too big\")");
  if (!fine && say && hardWordsIn(say, { never: HARD_WORDS.map((x) => ({ ...x, re: hardRe(x.word, x.re) })), fine: [] }).length) errs.push("what to say in its place is itself not a plain word");
  return errs;
}
/**
 * The owner's word on a word, for every gym: `{ say }` — never used, with what to say in its place; `{ fine: true }` —
 * a long word a nine-year-old knows; `{ remove: true }` — off the list (a standing one stays off).
 */
export function setPlain(libDir, word, { say = null, fine = false, remove = false } = {}) {
  const w = norm(word), k = plainKey(w), data = readSamples(libDir), rest = data.plain.filter((x) => plainKey(x.word) !== k);
  if (remove) { if (!k) throw new Error("which word?"); data.plain = [...rest, ...(HARD_WORDS.some((x) => plainKey(x.word) === k) ? [{ word: w, removed: true, updated: today() }] : [])]; }
  else { const errs = plainProblems(w, { say, fine }); if (errs.length) throw new Error(errs.join("; ")); data.plain = [...rest, fine ? { word: w.toLowerCase(), fine: true, updated: today() } : { word: w, say: norm(say), updated: today() }]; }
  writeSamples(libDir, data); return plainWords(libDir);
}
function hardWordsIn(text, plain, allow = []) {
  const t = apos(String(text ?? "")).replace(/\{[^}]*\}/g, " "), ok = new Set(allow.flatMap((x) => apos(String(x ?? "")).toLowerCase().match(/[a-z]+/g) || [])), out = [], seen = new Set();
  const wordsOf = (x) => x.toLowerCase().match(/[a-z]+/g) || [];
  for (const h of plain.never) { h.re.lastIndex = 0; for (const m of t.matchAll(h.re)) { const k = m[0].toLowerCase(); if (seen.has(k) || wordsOf(k).every((w) => ok.has(w))) continue; seen.add(k); for (const w of wordsOf(k)) seen.add(w); out.push({ word: m[0], say: h.say, why: "listed" }); } }
  const fine = new Set(plain.fine);
  for (const w of t.match(/[A-Za-z]+/g) || []) { const k = w.toLowerCase(); if (seen.has(k) || ok.has(k) || fine.has(k) || EASY_LONG.has(k) || syllables(k) < LONG_SYLLABLES) continue; seen.add(k); out.push({ word: w, say: null, why: "long" }); }
  return out;
}
/** The words in a text a nine-year-old would not know: [{ word, say (the plain way, for a listed word), why: listed | long }]. `allow`: words said as they are (the offer, the gym's name, the owner's facts). */
export const hardWords = (text, { allow = [], plain = plainWords() } = {}) => hardWordsIn(text, plain, allow);
/** A problem that is only about a hard word (the drafter mends those itself before a draft is dropped). */
export const PLAIN_PROBLEM = /is not a plain word|is a long word/;
const plainWhy = (i, h) => h.why === "listed" ? `line ${i + 1}: "${h.word}" is not a plain word — say "${h.say}"` : `line ${i + 1}: "${h.word}" is a long word — say it in small words`;
/** What the drafter, the editor and the pain points are told about words. */
export const PLAIN_RULE = `PLAIN WORDS: the reading level of a nine-year-old (third grade), and no higher. Every word is one a child of nine knows and says: short everyday words, mostly one or two syllables. Say a thing the long way in small words, never the short way in a big word: "jackets that are too big", not "oversized jackets"; "tired after lunch", not "mid-afternoon slumps"; "energy", not "vitality"; "strong for everyday things", not "functional muscle"; "where you are now", not "baseline". No gym words, no science words and no office words (metabolism, mobility, posture, stamina, lifestyle, sustainable, accountability, optimise, achieve, consistent, wellness and the like). Short sentences, one idea in each.`;

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
/**
 * A sample's STYLE (2026-11-14): how it is built — a name that tells it from the others, how it opens, its parts in
 * order (what each part DOES, never its words), and whether it calls people out by where they are. Read once by the
 * text model (`readStyle`), checked in code, kept on the sample; the owner may rename it. A sample not read yet is
 * still a style of its own ("Sample 3"): it is followed from its text alone.
 */
export const HOOKS = ["question", "call-out", "promise", "interrupt", "reassurance", "myth", "announcement", "other"];
const STYLE_SCHEMA = { type: "OBJECT", properties: { name: { type: "STRING" }, hook: { type: "STRING", enum: HOOKS }, beats: { type: "ARRAY", items: { type: "STRING" } }, says_area: { type: "BOOLEAN" } }, required: ["name", "hook", "beats", "says_area"] };
export const buildStylePrompt = (text, taken = []) => ({ schema: STYLE_SCHEMA, prompt: [
  "This is a script for a talking-to-camera gym advert that has worked. Say how it is BUILT, so that other scripts can be written the same way for other gyms and other programmes.",
  `name: 2 to 4 plain words that tell this way of building an advert from others ("Week by week", "Question, then the cycle", "It is not your fault")${taken.length ? `; not one of these, which are taken: ${taken.map((t) => `"${t}"`).join(", ")}` : ""}. hook: how it opens — a question, a call-out to people by who or where they are, a promise, an interrupt that stops the scroll, reassurance, a myth put right, an announcement, or other. beats: its parts in order, 3 to 8, each a short phrase saying what that part DOES and never its words ("a question that names the frustration", "what happens in week 1", "who it is for and who it is not for", "the ask"); leave out stage directions such as (Voiceover) and slides. says_area: true only if it calls people out by where they live or work.`,
  `THE SCRIPT:\n${text}`,
].join("\n\n") });
export function styleProblems(st) {
  const errs = [], name = norm(st?.name);
  if (name.length < 3 || name.length > 40) errs.push("a style's name is 3 to 40 characters");
  if (!HOOKS.includes(st?.hook)) errs.push(`how it opens is one of: ${HOOKS.join(", ")}`);
  const beats = Array.isArray(st?.beats) ? st.beats.map(norm).filter(Boolean) : [];
  if (beats.length < 3 || beats.length > 9) errs.push("a style has 3 to 9 parts"); else if (beats.some((b) => b.length < 3 || b.length > 110)) errs.push("each part is a short phrase");
  return errs;
}
/** Read one sample's style (one text call) and keep it on the sample. */
export async function readStyle({ libDir = videoLibraryDir(), id, ask = callVision, model = COPY_MODEL }) {
  const data = readSamples(libDir), row = data.samples.find((x) => x.id === id); if (!row) throw new Error(`no such sample: ${id}`);
  const taken = data.samples.filter((x) => x !== row && !x.retired && x.style?.name).map((x) => x.style.name), { prompt, schema } = buildStylePrompt(row.text, taken);
  const st = await ask(null, prompt, schema, { model }), errs = styleProblems(st); if (errs.length) throw new Error(`the style could not be read (${errs[0]})`);
  let name = norm(st.name); for (let k = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); k++) name = `${norm(st.name)} ${k}`;
  row.style = { name, hook: st.hook, beats: st.beats.map(norm).filter(Boolean), says_area: st.says_area === true, read: today() };
  writeSamples(libDir, data); return row;
}
/** Read every live sample that has no style yet: { read, failed[{ id, reason }] }. One text call each. */
export async function readStyles({ libDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL } = {}) {
  const out = { read: 0, failed: [] };
  for (const x of liveSamples(libDir).filter((s) => !s.style)) { try { await readStyle({ libDir, id: x.id, ask, model }); out.read++; } catch (e) { out.failed.push({ id: x.id, reason: e.message }); } }
  return out;
}
/** The owner's own name for a style. */
export function nameStyle(libDir, id, name) {
  const data = readSamples(libDir), row = data.samples.find((x) => x.id === id), n = norm(name); if (!row) throw new Error(`no such sample: ${id}`);
  if (n.length < 3 || n.length > 40) throw new Error("a style's name is 3 to 40 characters");
  if (data.samples.some((x) => x !== row && !x.retired && (x.style?.name || "").toLowerCase() === n.toLowerCase())) throw Object.assign(new Error("another style has this name"), { duplicate: true });
  row.style = { hook: "other", beats: [], says_area: /\{AREA\}/i.test(row.text), ...(row.style || {}), name: n, named: today() };
  writeSamples(libDir, data); return row;
}
/** The styles a draft may follow: every live sample, read or not. */
export const liveStyles = (libDir = videoLibraryDir()) => liveSamples(libDir).map((x, i) => ({ id: x.id, name: x.style?.name || `Sample ${i + 1}`, hook: x.style?.hook || null, beats: x.style?.beats || [], says_area: x.style ? x.style.says_area === true : /\{AREA\}/i.test(x.text), read: !!x.style?.read, text: x.text }));
/** One style for each script of a round: the styles this gym has used least first (then the library's order), round again when there are more scripts than styles. */
export function pickStyles(styles, count, { used = {} } = {}) {
  if (!styles.length) return [];
  const order = styles.map((st, i) => ({ st, i, n: used[st.id] || 0 })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.st);
  return Array.from({ length: count }, (_, k) => order[k % order.length]);
}
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
const FACTS_SCHEMA = { type: "OBJECT", properties: { facts: { type: "ARRAY", items: { type: "STRING" } } }, required: ["facts"] };
export const buildFactsPrompt = (samples) => ({ schema: FACTS_SCHEMA, prompt: [
  "These are scripts for gym adverts. List every FACT they state about how a programme or a gym works: what is included, how it starts, how many places there are, who coaches, how many people have been helped.",
  "Each fact is one short, plain statement of 3 to 12 words, with no gym's name, no place and no programme's name, so the owner of another gym can tick the ones that are true there (\"A full body scan at the start\", \"Only 10 places\"). The same fact said in two scripts is listed once. Leave out anything that is a promise of results, a price, a weight or a number of kilos.",
  samples.map((x, i) => `--- SCRIPT ${i + 1}\n${x}`).join("\n"),
].join("\n\n") });
/**
 * Facts for an offer, PROPOSED from the samples for the owner to tick (2026-11-14: several styles lean on facts — the
 * body scan, the places, the people helped — and a fact may only be said for a gym when its owner says it is true
 * there). One text call; each suggestion is held to the facts' own rules; one already on the offer's list is left out.
 * Nothing is saved: the ticked ones go through `setFacts`.
 */
export async function suggestFacts({ brandDir, offer, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL }) {
  if (typeof offer !== "string" || norm(offer).length < 3) throw new Error("the offer's exact words are needed");
  const samples = liveSamples(libraryDir).map((x) => x.text); if (!samples.length) throw new Error("there is no sample script to read facts from: paste one first");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, have = new Set(factsFor(brandDir, offer).map((x) => x.toLowerCase())), { prompt, schema } = buildFactsPrompt(samples);
  const answer = await ask(null, prompt, schema, { model }), out = [], dropped = [];
  for (const raw of answer?.facts || []) {
    const t = plainDashes(norm(raw)).replace(/[.;]+$/, ""), errs = factsProblems([t], profile);
    if (errs.length) dropped.push({ text: t, reason: errs[0] }); else if (!have.has(t.toLowerCase()) && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return { suggestions: out.slice(0, 16), dropped, calls: 1 };
}

/**
 * Pain points (2026-11-14, the owner on the first video's opening, "keep putting off getting back into shape": "This is
 * not a pain point. We need to speak to the client's pain point"). What the person an offer is for is living with and
 * wants gone, in the owner's words, per gym and per offer — typed by him (kept at once), or suggested from the gym's
 * own best adverts and the copy library's pain-led skeletons (a draft until he keeps it). A drafted script opens on
 * one and says which; nothing is drafted until one is kept. A pain point is a situation ("work clothes fitting
 * tighter"), never a judgement of the viewer's body or health: Meta refuses adverts that assert a personal attribute
 * or set out to make someone feel bad about themselves, and `BODY_JUDGEMENT` holds the plainest of those words out.
 */
export const PAIN_LIMITS = { kept: 8, chars: [8, 120], zh_min: 4 };
const BODY_JUDGEMENT = /\b(overweight|obese|obesity|fat|fatter|flabby|chubby|ugly|disgusting|ashamed|embarrass(?:ed|ing)|hate (?:your|their)|depress(?:ed|ion)|lazy)\b/i;
const painKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
export function painProblems(text, profile = {}) {
  const t = norm(text), errs = [];
  // A Chinese phrase says in four characters what English says in eight letters ("沒時間運動"): its floor is `PAIN_LIMITS.zh_min`.
  const least = isZh(t) ? PAIN_LIMITS.zh_min : PAIN_LIMITS.chars[0];
  if (t.length < least || t.length > PAIN_LIMITS.chars[1]) errs.push(`a pain point is one short phrase, ${least} to ${PAIN_LIMITS.chars[1]} characters (this is ${t.length})`);
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
    `Each is ONE short phrase of 5 to 14 words, with no full stop, written so it can follow "If you live in the area and …" — for example: "your work clothes have been fitting tighter lately", "you are out of breath after two flights of stairs", "you feel tired every day after lunch", "you keep starting to exercise and stopping after two weeks". Concrete and specific: never vague ("getting back into shape", "wanting to be healthier", "putting off fitness" are NOT pain points).`,
    `Say what HAPPENS to the person, never what they ARE: nothing that judges or labels their body, weight, looks or health, nothing that shames, no medical condition, no number of kilos or sizes. NEVER: a price, free, before and after, a guarantee${never.length ? `, any of: ${never.join(", ")}` : ""}.`,
    `Give ${count}, each a different part of life (clothes, energy, strength for everyday things, sticking with it, time, confidence in a room).`,
    PLAIN_RULE,
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

/**
 * How many presenter videos a batch may ask for, all kinds together (each is one script, made once for every location).
 * Nine since 2026-11-16 — it was three, a cap set while video was unproven, and the count fields stopped at it without
 * a word ("figure out why I can't type more than 3 … Fix it"). What bounds a batch now is the scripts ready for its
 * offer (one for each video) and what the run says it will cost before it is confirmed.
 */
export const MAX_VIDEOS = 20;
const kindCount = (videos, k) => (Number.isInteger(videos?.[k]) && videos[k] > 0 ? videos[k] : 0);
/** The videos made from a spoken script: talking, and with exercises. */
export const spokenCount = (videos) => kindCount(videos, "presenter") + kindCount(videos, "active");
/** White-paper videos (paper-video.mjs): nobody speaks, the words are on sheets of paper. Their scripts are their own. */
export const paperCount = (videos) => kindCount(videos, "paper");
export const videoCount = (videos) => spokenCount(videos) + paperCount(videos);
/** The kind of each video of a batch, in the order its scripts are picked: the talking ones, the ones with exercises, then the white-paper ones. */
export const videoKinds = (videos) => [...Array(kindCount(videos, "presenter")).fill("presenter"), ...Array(kindCount(videos, "active")).fill("active"), ...Array(kindCount(videos, "paper")).fill("paper")];
/** What a brief may ask for: the two ways a spoken script is filmed, and the white-paper kind. */
export const BRIEF_VIDEOS = ["presenter", "active", "paper"];
/** What is wrong with a brief's `videos`: { presenter: talking to camera, active: with exercises, paper: white paper } — `MAX_VIDEOS` between them. */
export function videosProblems(videos) {
  if (videos == null) return [];
  if (typeof videos !== "object" || Array.isArray(videos)) return ["videos must say how many of each kind: { presenter: 1 }"];
  const errs = [];
  for (const k of Object.keys(videos)) if (!BRIEF_VIDEOS.includes(k)) errs.push(`videos: "${k}" is not a kind of video (${BRIEF_VIDEOS.join(", ")})`);
  for (const k of BRIEF_VIDEOS) if (videos[k] != null && !(Number.isInteger(videos[k]) && videos[k] >= 0 && videos[k] <= MAX_VIDEOS)) errs.push(`videos.${k} must be a whole number from 0 to ${MAX_VIDEOS}`);
  if (!errs.length && videoCount(videos) > MAX_VIDEOS) errs.push(`a batch makes at most ${MAX_VIDEOS} presenter videos in all, talking, with exercises and white paper together`);
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
  const stale = all.filter((s) => s.status === "kept" && norm(s.offer).toLowerCase() === key).map((s) => scriptIssues(s, { profile, closing: closingLine(libraryDir), gymDir })).filter((e) => e.length).map((e) => [e.find((x) => /closing line/.test(x)) || e[0], ...e]);
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
/** The scripts of a gym that have been filmed already: the ids with a folder of clips (their own, or a coach's). */
export function filmedScripts(gymDir) {
  const dir = join(gymDir, CLIPS_DIR);
  try { return new Set(readdirSync(dir).filter((x) => /^[vp]-[0-9a-f]+/.test(x) && statSync(join(dir, x)).isDirectory()).map((x) => x.split("--")[0])); } catch { return new Set(); }
}
/**
 * `fresh` (2026-11-22): the ids already filmed — a NEW batch takes the scripts not filmed yet first (the seed's order
 * within each), so that new scripts become new videos; without it a gym's second batch for the same offer picked
 * among every ready script and could film nothing new. A batch keeps what it was given (`pin`).
 */
export function pickScripts(gymDir, { count, offer, seed = "batch", libraryDir = videoLibraryDir(), reuse = 1, pin = null, fresh = null } = {}) {
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, all = keptScripts(gymDir, offer), kept0 = readyScripts(gymDir, offer, { profile, closing: closingLine(libraryDir) });
  // `pin`: the script each video films, in order (the brief's `video_scripts`); each must be kept and ready for this offer.
  if (pin) {
    const byId = new Map(kept0.map((x) => [x.id, x])), missing = pin.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`the batch names script${missing.length === 1 ? "" : "s"} ${[...new Set(missing)].join(", ")}, which ${missing.length === 1 ? "is" : "are"} not kept and ready for "${offer}"`);
    return pin.slice(0, count).map((id) => byId.get(id));
  }
  // `reuse` (a batch whose videos are shared between the gym's coaches): a script may be filmed that many times, each by another coach — two coaches saying the same words are two adverts.
  const kept = reuse > 1 && kept0.length && kept0.length < count ? Array.from({ length: Math.min(count, kept0.length * reuse) }, (_, i) => kept0[i % kept0.length]) : kept0;
  if (kept.length < count && all.length > kept.length) throw new Error(`${count} presenter video${count === 1 ? "" : "s"} asked for, but ${kept.length ? `only ${kept.length} script${kept.length === 1 ? " is" : "s are"}` : "no script is"} ready for "${norm(offer)}": ${noScriptWhy(gymDir, offer, { libraryDir, profile }).text} (Draft Scenes → Video scripts)`);
  if (kept.length < count) throw new Error(`${count} presenter video${count === 1 ? "" : "s"} asked for, but ${kept.length ? `only ${kept.length} script${kept.length === 1 ? " is" : "s are"}` : "no script is"} kept for "${norm(offer)}": keep ${count - kept.length} more on Draft Scenes → Video scripts${kept.length ? "" : ` (${noScriptWhy(gymDir, offer, { libraryDir }).text})`}`);
  const order = kept0.map((s2) => ({ s: s2, k: sha(`${seed}|${s2.id}`) })).sort((a, b) => (fresh ? Number(fresh.has(a.s.id)) - Number(fresh.has(b.s.id)) : 0) || a.k.localeCompare(b.k)).map((x) => x.s);
  return Array.from({ length: Math.min(count, kept.length) }, (_, i) => order[i % order.length]);
}
/** A script with what making it would take: its lines, each clip's length, and the seconds and image calls for a set of locations. */
export function scriptCost(script, areas = [""], { closing = closingLine() } = {}) {
  const n = Math.max(1, areas.length), said = filmedLines(script.lines, closing), clips = said.map((l) => ({ line: l, per_area: /\{AREA\}/.test(l), seconds: clipSeconds(fillLine(l, areas[0] || "Ang Mo Kio")) }));
  const seconds = clips.reduce((t, c) => t + c.seconds * (c.per_area ? n : 1), 0);
  return { clips, seconds, images: said.length, usd: Math.round((seconds * USD_PER_SECOND + said.length * USD_PER_IMAGE) * 100) / 100, videos: n };
}

const draftSchema = (letters = []) => ({ type: "OBJECT", properties: { scripts: { type: "ARRAY", items: { type: "OBJECT", properties: { ...(letters.length ? { style: { type: "STRING", enum: letters } } : {}), pain: { type: "STRING" }, lines: { type: "ARRAY", items: { type: "STRING" } } }, required: [...(letters.length ? ["style"] : []), "pain", "lines"] } } }, required: ["scripts"] });
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The styles of a round, lettered by the order they first appear: [{ letter, style, scripts (1-based numbers) }]. */
export function letteredStyles(assigned = []) {
  const out = [];
  assigned.forEach((st, k) => { let row = out.find((r) => r.style.id === st.id); if (!row) out.push((row = { letter: LETTERS[out.length], style: st, scripts: [] })); row.scripts.push(k + 1); });
  return out;
}
/**
 * The drafter's request. `pains`: the owner's own pain points for this offer, used first when he has kept some;
 * `ads` and `library` (`painSources`): what the drafter works the pain points out from when he has not — it is the
 * agent that proposes, and he reviews. Every script says the pain point it opens on.
 */
/**
 * The pain point the owner gives for a round of drafts (2026-11-16: "an option for the user to indicate the pain point,
 * which should drive the entire flow of the video … 'Weight gain' or 'Not being happy with the way you look in the
 * mirror', then the sheets … or the scripts … should be drafted to follow"). His words, held to the pain points' own
 * rule (never a judgement of the person). Told to both drafters; every script of the round is about it and keeps it.
 */
export function themeOf(pain, profile = {}) {
  if (pain == null || !norm(pain)) return null;
  const theme = plainDashes(norm(pain)).replace(/[.;,]+$/, ""), bad = painProblems(theme, profile);
  if (bad.length) throw new Error(`the pain point: ${bad[0]}`);
  return theme;
}
export const themeRule = (theme, what = "script") => `THE PAIN POINT OF THIS ROUND, in the owner's own words: "${theme}". It drives every ${what} from start to finish: it opens on it — as one moment of the person's day where it shows, in small words they would use themselves — everything in the middle speaks to it (what changes about it, what the person gets), and the ending names what they want instead of it. Nothing in a ${what} is about any other worry. Each ${what} takes a DIFFERENT moment or side of this same pain point, so that no two are alike. Say it as something that happens to the person, never a judgement or a label of them, and never promise a result or a number.`;
/** How a Chinese script is written, told to the drafter and the editor. */
const ZH_LANGUAGE = "LANGUAGE: Traditional Chinese as SPOKEN in Taiwan (zh-TW) — the everyday words a person in Taipei says out loud to a friend. Never written or formal Chinese (書面語), never mainland wording, never a simplified character, no English word except the gym's own name. Full-width punctuation ，。？！ and digits for numbers (10位, 45分鐘). Short sentences; every line is something a person would really say.";
const ZH_AVOID = `Never use these words — the video model says them in the wrong tone: ${SPOKEN_AVOID_ZH.map((a) => `${a.word} (say ${a.say})`).join(", ")}.`;
/**
 * The drafter's request for a gym whose ads are in Chinese (2026-11-22). Until now every Chinese script was written by
 * hand: F45 Xinyi's 12 spoken scripts. The same rules as the English drafter's, said for Chinese — lines measured in
 * characters, 我們 for the gym, the Chinese closing sentence (the link itself is shown on screen: `linkOnScreen`), the
 * words the video model says wrongly left out, the gym's own wording — and `models`: the scripts the owner has
 * already approved for this gym, as the standard for how a script sounds here (never a sentence copied).
 */
export function buildScriptPromptZh({ profile = {}, offer, audience = null, count = 3, existing = [], facts = [], styles = [], pains = [], ads = [], library = [], closing = CLOSING_LINE, theme = null, models = [] }) {
  const gym = nameInAds(profile), never = (profile.brand_lock?.voice?.never || []).filter(Boolean), end = closingFor(["中"], closing), lettered = letteredStyles(styles), house = wordingRule(profile, { spoken: true });
  const lines = [
    `You write short scripts for a talking-to-camera video advert for ${gym}'s programme 「${offer}」. ${audience ? `The advert is for: ${audience}.` : "The advert is for adults near the gym who are not training yet."} A coach stands in the gym, talks to a phone camera the way a friend would, and the video cuts to a new spot for each line.`,
    ZH_LANGUAGE,
    `A script is 4 to ${LINES[1]} lines, one for each cut: as many as there is something true and worth saying, and no more — shorter is better. Each line is ONE breath: 10 to ${DRAFT_CHARS.line} characters and never more (a longer line is not said cleanly in one take: split it in two lines); the last line may run to ${DRAFT_CHARS.last}.`,
    `Within its first two lines a script speaks to ONE pain point — what this person is living with and wants gone, said as a moment of their day they will recognise at once. It names the programme once, in these exact characters: 「${offer}」 (as 「${gym}的${offer}」 or 「我們的${offer}」). Where it says where people live or work, the place is written {AREA} in Latin capitals and braces, exactly so (it is filled in for each location: 「如果你在{AREA}工作，或是住在{AREA}，」); it never names the country and never speaks to a whole city or island.${lettered.length ? " Each script follows ONE style — the one it is given under STYLES below: its kind of opening, its parts in their order and its rhythm; a part that needs a fact you were NOT given is left out, never invented." : ""}`,
    `THE ENDING is the last line, two beats. First a clause that turns to the viewer and names what they want, tied to the pain the script opened on, beginning 如果你… — what they will FEEL or be able to DO (「如果你想更有精神，」 「如果你想穿上喜歡的衣服，更有自信，」 「如果你想忙完工作後還有力氣做喜歡的事，」), never an ideal body and never a promised result. Then exactly these characters, the ONLY call to action in the script: 「${end}」 The shape: 「如果你想給自己一個好的開始，${end}」 Never another instruction, never a button's name.`,
    `Speak about BENEFITS: what changes for the person. Say nothing about how the gym or the programme works except these facts, in the owner's words${facts.length ? `: ${facts.map((x) => `「${x}」`).join("、")}. Say each one the way a person says it out loud — the fact itself unchanged (the same number, place and thing), never its label or its brackets (「地點：信義路和基隆路口」 is said 「我們就在信義路和基隆路口」; 「名額10位」 is said 「我們在找10位」 or 「這次只找10位」) — and nothing else about how the programme works; a fact may be left out, never changed` : " — and none was given, so a script states no fact about how training is organised (no class size, session length, timetable, equipment, assessment or number of places)"}. A benefit is what the programme is built to help with, never a promised result.`,
    `The speaker speaks for the gym, as nobody in particular: 我們 means ${gym} and its coaches. Never 我 alone (no 我的, no 我自己), never a named coach, a member or the owner, never a personal story.`,
    ZH_AVOID,
    house,
    `NEVER: a price or any money; 免費 or a trial (試用, 體驗課); before and after (前後對比); a guarantee (保證); a result promised; a number of kilos, centimetres or percent; a medical claim; a date; an ideal body (完美身材, 理想體態); a dash${never.length ? `; any of: ${never.join(", ")}` : ""}.`,
    `Write ${count} script${count === 1 ? "" : "s"}, ${theme ? "each on a different moment or side of the one pain point above" : "each opening on a different pain point"}, each built differently from the others (a question, a call-out to people nearby, a reassurance, a "this time is different"), and say for each the pain point it opens on (pain: a short phrase in Chinese, as it would stand in a list — 「忙完工作累到不想動」)${lettered.length ? " and the style it follows (style: its letter)" : ""}.`,
    `PAIN POINTS. A pain point is something that HAPPENS to this person — clothes fitting tighter, out of breath on the stairs, too tired to move after work, starting to exercise and stopping after two weeks — said the way they would say it to a friend. Never a judgement or a label of their body, weight, looks or health, nothing that shames, no medical condition; and never softened into something vague.${theme ? ` ${themeRule(theme)} For "pain", answer with exactly these words: "${theme}".` : pains.length
      ? ` The owner's own list comes first — open on these, close to his words, one for each script${pains.length < count ? "; for the scripts beyond the list, work out further ones yourself the same way" : ""}:\n${pains.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
      : ` Work them out yourself before you write: who this advert is for, and what they are living with${ads.length || library.length ? ", drawing on the adverts below" : ""}.`}`,
  ].filter(Boolean);
  if (models.length) lines.push(`THE STANDARD — scripts the owner has already approved for this gym, after correcting them line by line. Write to this standard: how they sound, how long their lines are, how they open and how they end. Never copy a sentence, and never open two scripts the same way as one of these:\n${models.map((m, i) => `--- APPROVED ${i + 1}\n${m.join("\n")}`).join("\n")}`);
  if (ads.length) lines.push(`This gym's own adverts that earned the most leads. Find the pain each one speaks to and say it plainly in your own words; never copy a sentence, a price or an offer from them:\n${ads.map((a, i) => `--- ADVERT ${i + 1} (${a.leads} leads)\n${a.text}`).join("\n")}`);
  if (library.length) lines.push(`Pain-led adverts that have worked for other gyms. The same: the pain they speak to, in your own words:\n${library.map((x, i) => `--- LIBRARY ${i + 1}\n${x}`).join("\n")}`);
  if (lettered.length) lines.push(`STYLES — scripts that have worked, each one a way of building an advert (they are in English: take HOW each is built, never its sentences, facts, names, places, numbers, promises or its call to action; write in Chinese as told above).\n${lettered.map((r) => `SCRIPT${r.scripts.length === 1 ? "" : "S"} ${r.scripts.join(" and ")} follow${r.scripts.length === 1 ? "s" : ""} STYLE ${r.letter}.`).join(" ")}\n${lettered.map((r) => `--- STYLE ${r.letter} — "${r.style.name}"${r.style.beats?.length ? `\nIts parts, in order: ${r.style.beats.map((b, i) => `${i + 1}) ${b}`).join("; ")}` : `\n${r.style.text}`}`).join("\n")}`);
  if (existing.length) lines.push(`Already written — do not repeat or closely rephrase:\n${existing.map((e) => `- ${e}`).join("\n")}`);
  return { prompt: lines.join("\n\n"), schema: draftSchema(lettered.map((r) => r.letter)) };
}
export function buildScriptPrompt({ profile = {}, offer, audience = null, count = 3, existing = [], facts = [], samples = [], styles = [], pains = [], ads = [], library = [], closing = CLOSING_LINE, theme = null, models = [] }) {
  if (gymLanguage(profile) === "zh") return buildScriptPromptZh({ profile, offer, audience, count, existing, facts, styles, pains, ads, library, closing, theme, models });
  const gym = profile.display_name || "the gym", never = (profile.brand_lock?.voice?.never || profile.voice?.never || []).filter(Boolean);
  // "Aether Athletics' 6 Week…", never "Athletics's": the possessive as it is said and as the captions show it.
  const gyms = /s$/i.test(gym) ? `${gym}'` : `${gym}'s`;
  // With the owner's samples or his facts for this offer a script may run longer: it follows the sample's beats, cut to what is relevant and true here.
  const long = samples.length > 0 || facts.length > 0 || styles.length > 0;
  // `styles`: one for each script of the round (2026-11-14). A script follows the one it is given and no other.
  const lettered = letteredStyles(styles);
  const open = "says where — the place written as {AREA} (it is filled in for each location) — and opens on ONE pain point: what this person is living with and wants gone, said as a moment of their day they will recognise at once";
  const close = `THE ENDING is two beats, both in the last line. First ONE sentence that turns to the viewer and names what they want, tied to the pain the script opened on, in this shape: "If you're ready to [what they want], now is your time." Then exactly this sentence, word for word; it is the ONLY call to action in the script: "${closing}" Never go straight from a benefit into the call to action, and never use a bare lead-in ("If that sounds like you, …"). What they want is what they will FEEL or be able to DO (feel strong and at ease in their clothes again, have energy left for the evening), never an ideal body and never a promised result ("the body you've always wanted" is out). The last line is at most ${lastWords(closing)} words in all, so keep the first sentence short. Never write "tap", never name a button, never add another instruction.`;
  const lines = [
    `You write short scripts for a talking-to-camera video advert for ${gym}'s programme: "${offer}". ${audience ? `The advert is for: ${audience}.` : "The advert is for adults near the gym who are not training yet."} Someone stands in the gym, talks to a phone camera the way a friend would, and the video cuts to a new spot for each line.`,
    long
      ? `A script is 3 to ${LINES[1]} lines, one for each cut: as many as there is something true and worth saying, and no more — shorter is better. Each line is one breath, ${LINE_WORDS[0] + 4} to ${DRAFT_WORDS.line} words and never more (a longer line is not said cleanly in one take: split it in two lines), in plain spoken English: short sentences, no lists. ${READ_RULE}`
      : `A script is exactly 3 lines. Each line is one breath, ${LINE_WORDS[0] + 4} to ${DRAFT_WORDS.line} words and never more, in plain spoken English: short sentences, no lists. ${READ_RULE}`,
    lettered.length
      ? `Each script follows ONE style — the one it is given under STYLES below — and no other: its kind of opening, its parts in their order, its rhythm and its tone, so that two scripts in two styles read as two different adverts. A style with more parts than a script has lines is cut to the parts that matter most; a part that needs a fact you were NOT given (an assessment, a number of places, how many people were helped) is left out, never invented. Whatever the style: within its first two lines the script speaks to ONE pain point — what this person is living with and wants gone, said as a moment of their day they will recognise at once; it names the programme once, in these exact words: "${offer}" (as "${gyms} ${offer}" or "our ${offer}"); and where its style calls people out by where they live or work, the place is written {AREA} (it is filled in for each location) — a style that does not, names no place at all. ${close}`
      : long
      ? `The first line ${open}. One of the first two lines names the programme in these exact words — "${gyms} ${offer}" — and says what it is FOR in this person's life. The lines between are the beats worth keeping${samples.length ? " from the sample you follow" : ""}: each fact you were given gets its own short line, said plainly; a beat that needs a fact you were NOT given (an assessment, a number of places, how many people were helped) is left out, never invented. ${close}`
      : `Line 1 ${open}. Line 2 names the programme in these exact words — "${gyms} ${offer}" — and says what it is FOR in this person's life. Line 3 is the ending. ${close}`,
    `Speak about BENEFITS, never features. A benefit is what changes for the person: feeling stronger, more energy for the day, clothes fitting better, confidence, keeping up with the children, a body that does what is asked of it. A feature is how the gym runs, and the script says NONE: nothing about how training is organised (no small groups, classes, one-to-one, personal training, session length, timetable, equipment, class size), because a wrong one is a false claim about this gym.${facts.length ? ` The only facts about the gym or the programme that may be stated are these, in the owner's words: ${facts.map((x) => `"${x}"`).join("; ")}. Say them as given, and nothing else about how the programme works.` : ""} A benefit is what the programme is built to help with, never a promised result.`,
    `The speaker speaks for the gym, as nobody in particular: "we", "our" and "us" mean ${gym} and its coaches, and are said the way a gym speaks ("we'll guide you through every step"). The speaker is NOT a named coach, NOT a member and NOT the owner: the script never says I, my or me, and never tells a personal story ("I joined", "my clients", "when I started"). The closing sentence is said word for word as given.`,
    `${PLAIN_RULE} The only longer words allowed are the programme's name, the gym's name${facts.length ? ", the facts given above" : ""} and the closing sentence, said as they are.${long ? " A style's or a sample's own big words are NOT carried over: take how it is built and say it in small words." : ""}`,
    `The place is only ever {AREA}, the area around the gym: the script never names the country, and never speaks to a whole city or island.`,
    `NEVER: a price or any money; free or a free trial; before and after; a guarantee; a result promised; a number of kilos, pounds or percent; a medical claim; a date; an exclamation mark (the closing sentence keeps its own); an em dash${never.length ? `; any of: ${never.join(", ")}` : ""}.`,
    ...(wordingRule(profile, { spoken: true }) ? [wordingRule(profile, { spoken: true })] : []),
    `Write ${count} script${count === 1 ? "" : "s"}, ${theme ? "each on a different moment or side of the one pain point above" : "each opening on a different pain point"}, and say for each the pain point it opens on (pain: a short phrase, as it would stand in a list — "work clothes fitting tighter lately")${lettered.length ? " and the style it follows (style: its letter)" : ""}.`,
    `PAIN POINTS. A pain point is something that HAPPENS to this person — work clothes fitting tighter, out of breath on the stairs, tired every day after lunch, starting to exercise and stopping after two weeks — said the way they would say it to a friend, in small words. Never a judgement or a label of their body, weight, looks or health, nothing that shames, no medical condition; and never softened into something vague: "getting back into shape", "putting off fitness", "starting a fitness journey" are NOT pain points.${theme ? ` ${themeRule(theme)} For "pain", answer with exactly these words: "${theme}".` : pains.length
      ? ` The owner's own list comes first — open on these, close to his words, one for each script${pains.length < count ? "; for the scripts beyond the list, work out further ones yourself the same way" : ""}:\n${pains.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
      : ` Work them out yourself before you write: who this advert is for, and what they are living with${ads.length || library.length ? ", drawing on the adverts below" : ""}.`}`,
  ];
  if (ads.length) lines.push(`This gym's own adverts that earned the most leads. Find the pain each one speaks to and say it plainly in your own words; never copy a sentence, a price or an offer from them:\n${ads.map((a, i) => `--- ADVERT ${i + 1} (${a.leads} leads)\n${a.text}`).join("\n")}`);
  if (library.length) lines.push(`Pain-led adverts that have worked for other gyms. The same: the pain they speak to, in your own words:\n${library.map((x, i) => `--- LIBRARY ${i + 1}\n${x}`).join("\n")}`);
  // The owner's own proven scripts, when he has given some: their structure, rhythm and voice are followed; their sentences and their facts are not copied.
  if (samples.length) lines.push(`These scripts have worked for this owner. Follow how they are built, how they sound and what they choose to talk about — never copy a sentence, and never carry over a fact (a place, a programme name, a number, how a gym runs) or their call to action. A sample may mark in braces what changes from gym to gym ({AREA}, {CHALLENGE NAME}, {GYM NAME} and the like): where it marks the place, write {AREA}; where it marks the programme, write its exact words, "${offer}"; where it marks the gym, write "${gym}"; where the sample says we or our, it may stay — the speaker speaks for the gym. No other braces may appear in a script:\n${samples.map((x, i) => `--- SAMPLE ${i + 1}\n${x}`).join("\n")}`);
  // The styles: the owner's own scripts that have worked, each a way of building an advert — how it is built is taken, nothing it says.
  if (lettered.length) lines.push(`STYLES — the owner's own scripts that have worked, each one a way of building an advert. Take from a style HOW it is built, never its sentences, and never its facts, names, places, numbers, promises of results, stage directions ("(Voiceover)", slides) or its call to action. Where a style has someone introduce themselves by name, the script speaks as "we" for the gym instead. Where a style marks in braces what changes from gym to gym ({AREA}, {CHALLENGE NAME}, {GYM NAME}), the place is {AREA}, the programme is "${offer}" and the gym is "${gym}"; no other braces may appear in a script.\n${lettered.map((r) => `SCRIPT${r.scripts.length === 1 ? "" : "S"} ${r.scripts.join(" and ")} follow${r.scripts.length === 1 ? "s" : ""} STYLE ${r.letter}.`).join(" ")}\n${lettered.map((r) => `--- STYLE ${r.letter} — "${r.style.name}"${r.style.hook && r.style.hook !== "other" ? ` (it opens with ${/^[aeiou]/.test(r.style.hook) ? "an" : "a"} ${r.style.hook})` : ""}${r.style.beats?.length ? `\nIts parts, in order: ${r.style.beats.map((b, i) => `${i + 1}) ${b}`).join("; ")}` : ""}\nThe owner's script in this style:\n${r.style.text}`).join("\n")}`);
  if (existing.length) lines.push(`Already written — do not repeat or closely rephrase:\n${existing.map((e) => `- ${e}`).join("\n")}`);
  return { prompt: lines.join("\n\n"), schema: draftSchema(lettered.map((r) => r.letter)) };
}
/**
 * Draft scripts for an offer: one text call, every draft checked in code, a broken or repeated one dropped with the
 * reason. Drafts wait for the owner. THE AGENT PROPOSES (2026-11-14, the owner: "the agent proposes the scripts for me
 * to review and edit (if necessary), not I tell the agent what to say"): nothing has to be typed first — the drafter
 * works the pain points out from the gym's own best adverts and the library's pain-led ones, his own kept ones first
 * when he has given some, and each draft carries the pain point it opens on, held to the pain points' own rules.
 */
export async function draftScripts({ brandDir, offer, audience = null, count = 3, style = null, pain = null, libraryDir = videoLibraryDir(), ask = callVision, model = COPY_MODEL, words = DRAFT_WORDS, log = () => {} }) {
  if (typeof offer !== "string" || offer.trim().length < 3) throw new Error("the offer's exact words are needed");
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("count must be 1 to 6");
  const profile = readJson(join(brandDir, "gym-profile.json")) || {}, pains = painsFor(brandDir, offer), closing = closingLine(libraryDir), src = painSources(brandDir, libraryDir);
  // The pain point he typed for this round (refused in words when it judges the person): every draft is about it, and keeps it as its pain point.
  const theme = themeOf(pain, profile);
  // One style for each script: the one asked for, else spread across the styles, the ones this gym has used least first.
  const all = liveStyles(libraryDir), mine = readScripts(brandDir).scripts, used = {}; for (const x of mine) if (x.status !== "retired" && x.style?.id) used[x.style.id] = (used[x.style.id] || 0) + 1;
  const one = style ? all.find((x) => x.id === style) : null; if (style && !one) throw new Error("no such style: pick one of the sample scripts on file");
  const assigned = one ? Array.from({ length: count }, () => one) : pickStyles(all, count, { used }), lettered = letteredStyles(assigned);
  // The standard for a Chinese gym: the scripts he has already approved here (the newest six that still pass today's rules).
  const zhGym = gymLanguage(profile) === "zh", models = zhGym ? mine.filter((x) => x.status === "kept" && isZh(x.lines) && !scriptIssues(x, { profile, closing, gymDir: brandDir }).length).slice(-6).map((x) => x.lines) : [];
  const { prompt, schema } = buildScriptPrompt({ profile, offer: offer.trim(), audience, count, existing: mine.map((x) => x.lines.join(" / ")), styles: assigned, facts: factsFor(brandDir, offer), pains, ...src, closing, theme, models });
  const answer = await ask(null, prompt, schema, { model }), added = [], dropped = [], allow = factsFor(brandDir, offer);
  let calls = 1, mended = 0; const plain = plainWords(libraryDir), ready = [];
  const rules = (ls) => [...scriptProblems(ls, { offer: offer.trim(), profile, closing, plain, allow }), ...draftLengths(ls, closing, words)];
  const sayAgain = async (ls, problems) => { const fix = buildEditPrompt({ profile, script: { lines: ls, offer: offer.trim() }, problems, closing }), said = await ask(null, fix.prompt, fix.schema, { model }); calls++; return (said?.lines || []).map((l) => plainDashes(norm(l))).filter(Boolean); };
  for (const [k, d] of (answer?.scripts || []).entries()) {
    // The style a draft says it follows; one that says none is taken to be the one its place in the round was given.
    const st = lettered.find((r) => r.letter === String(d.style || "").trim().toUpperCase())?.style || assigned[k] || null;
    try {
      const pain = theme || plainDashes(norm(d.pain)).replace(/[.;,]+$/, "");
      if (!pain) throw new Error("it does not say which pain point it opens on");
      const bad = painProblems(pain, profile); if (bad.length) throw new Error(`the pain point it opens on ("${pain}"): ${bad[0]}`);
      let ls = (d.lines || []).map((l) => plainDashes(norm(l))), again = false, errs = rules(ls);
      // A draft that breaks a rule is said again once (one text call for that draft: the smallest edit that mends it), then dropped with the reason if it still does.
      // (2026-11-22: it was only for big words or a long line, and a sound Chinese draft was lost over one 保證.)
      if (errs.length) { const next = await sayAgain(ls, errs); if (next.length) { ls = next; again = true; errs = rules(ls); } }
      if (errs.length) throw new Error(errs.join("; "));
      ready.push({ ls, pain, st, again, text: (d.lines || []).join(" / ") });
    } catch (e) { dropped.push({ text: (d.lines || []).join(" / "), reason: e.message }); log(`  dropped: ${e.message}`); }
  }
  // Every line read aloud before he sees it (one text call for the round): a draft with a line that does not read as
  // speech is said again once, read once more, and dropped with the reason if it still does not.
  let reads = 0, unread = false;
  if (ready.length) {
    const heardAs = { offer: offer.trim(), profile, closing, ask, model, fixed: allow, models };
    const first = await readAloud(ready.map((r) => r.ls), heardAs); reads++; unread = first.unread;
    const redo = [];
    for (const [i, r] of ready.entries()) if (first.faults[i].length) {
      const next = await sayAgain(r.ls, first.faults[i].map(readProblem)), errs = next.length ? rules(next) : ["the drafter gave no lines"];
      if (errs.length) { r.drop = `${readProblem(first.faults[i][0])}; said again, it broke a rule: ${errs[0]}`; continue; }
      r.ls = next; r.again = true; redo.push(r);
    }
    if (redo.length) { const second = await readAloud(redo.map((r) => r.ls), heardAs); reads++; for (const [i, r] of redo.entries()) if (second.faults[i].length) r.drop = `${readProblem(second.faults[i][0])}, after one rewrite`; }
    if (unread) log("  the read-aloud check gave no answer: the drafts were not scored for how they are said");
  }
  for (const r of ready) {
    if (r.drop) { dropped.push({ text: r.text, reason: r.drop }); log(`  dropped: ${r.drop}`); continue; }
    try { added.push(addScript(brandDir, { lines: r.ls, offer: offer.trim(), source: "drafted", pain: r.pain, style: r.st }, { profile, closing, plain })); if (r.again) { mended++; log("  one draft said again"); } }
    catch (e) { dropped.push({ text: r.text, reason: e.message }); log(`  dropped: ${e.message}`); }
  }
  return { added, dropped, calls, reads, unread, mended, theme, styles: lettered.map((r) => r.style.name), sources: { pains: pains.length, ads: src.ads.length, library: src.library.length } };
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
/**
 * Lettering in a clip, by what it is on (2026-11-15: a clip was refused twice for "Life Fitness", the maker's name on
 * the gym's own cross-trainer, which was in the presenter's picture before a second was filmed). One rule with the
 * photos' (a small mark on equipment is a note): a maker's name on a machine or a machine's display is the room's own
 * and is noted; a caption or watermark laid over the picture, writing on clothes, a sign — and anything the check
 * cannot place — still fails the take.
 */
export const LETTERING_ON = ["equipment", "screen", "clothing", "sign", "overlay", "other"];
const LETTER_NOTED = new Set(["equipment", "screen"]), LETTER_WHERE = { clothing: "on clothing", sign: "a sign or writing in the room", overlay: "a caption or watermark over the picture" };
export function letteringOf(seen) {
  const all = Array.isArray(seen?.lettering) ? seen.lettering.filter((x) => norm(x?.text)).map((x) => ({ text: norm(x.text), on: LETTERING_ON.includes(x.on) ? x.on : "other" })) : (seen?.on_screen_text || []).filter((t) => norm(t)).map((t) => ({ text: norm(t), on: "other" }));
  return { fails: all.filter((x) => !LETTER_NOTED.has(x.on)), notes: all.filter((x) => LETTER_NOTED.has(x.on)) };
}
/** A check as it is kept: the lettering always listed with what it is on (a check that only listed words reads as "cannot place"). */
const normalSeen = (seen) => { const L = letteringOf(seen), lettering = [...L.fails, ...L.notes]; return { ...seen, lettering, on_screen_text: lettering.map((x) => x.text) }; };
/** A check from before lettering said what it is on, that saw some: watched again once (a check call, no filming). */
const staleCheck = (seen) => !Array.isArray(seen?.lettering) && (seen?.on_screen_text || []).length > 0;
/**
 * One clip judged from its check: { passed, why, kind: words | people | lettering | null, faults (what the check noticed
 * that a viewer might: a note, and the reason for the one retake), marks (lettering that is the room's own: a note,
 * never a retake), lettering }. Pure: the same check is judged again by today's rules on every run.
 */
export function judgeClip(seen, line, { profile = {}, say = [], move = null } = {}) {
  // The words as the watching pass wrote them, or — when that pass refused them and the take was listened to again by its sound alone — as that heard them.
  const same = (t) => sameWords(t || "", line, { names: [profile.display_name].filter(Boolean), sounds: soundsOf(say) });
  // A real coach's clip (stamped `coach` when it is checked): the uniform's print and the gym's own lettering are the room's own — notes — and what must hold is that they are unchanged and the person is the same (`seen.same`, from `models.same`).
  // (2026-11-17: the lane numbers painted on BFIT's turf — "5", "6" — were placed as "other" on some takes and failed two good ones: a coach's clip starts from a real frame of the real room, so whatever is written in the room is the room's own, and only words laid OVER the picture fail it.)
  const isCoach = seen?.coach === true, L0 = letteringOf(seen), own = (x) => x.on !== "overlay";
  const heard = same(seen?.spoken) || (norm(seen?.heard) ? same(seen.heard) : false), alone = seen?.people === 1, L = isCoach ? { fails: L0.fails.filter((x) => !own(x)), notes: [...L0.notes, ...L0.fails.filter(own)] } : L0, drift = isCoach ? sameFails(seen.same) : null;
  // With exercises: the move is done before the line (asked of the check only for a move cut; a check that does not say is not held against the take).
  const moved = !(move?.m.kind === "move" && seen?.did_move === false);
  const kind = !heard ? "words" : !alone ? "people" : !moved ? "move" : L.fails.length ? "lettering" : drift;
  const why = drift && kind === drift ? sameWhy(seen.same, drift, seen.coach_name) : kind === "move" ? `the move (${moveLabel(move)}) was not done before the line` : kind === "words" ? `it said "${norm(seen?.spoken)}"` : kind === "people" ? `${seen?.people} people are in it` : kind === "lettering" ? `words appear in the picture: ${L.fails.map((x) => `${x.text}${LETTER_WHERE[x.on] ? ` (${LETTER_WHERE[x.on]})` : ""}`).join(", ")}` : null;
  return { passed: !kind, why, kind, faults: (seen?.faults || []).filter(Boolean), marks: (isCoach ? [] : L.notes).map((x) => `${x.on === "screen" ? "on a screen in the room" : "the maker's name on the equipment"}: ${x.text}`), lettering: L };
}
const WATCH_SCHEMA = { type: "OBJECT", properties: { spoken: { type: "STRING" }, lettering: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, on: { type: "STRING", enum: LETTERING_ON } }, required: ["text", "on"] } }, people: { type: "INTEGER" }, lips_match_speech: { type: "BOOLEAN" }, faults: { type: "ARRAY", items: { type: "STRING" } }, looks_real: { type: "INTEGER" }, did_move: { type: "BOOLEAN" } }, required: ["spoken", "lettering", "people", "lips_match_speech", "faults", "looks_real"] };
const WATCH_QUESTION = "Watch and listen to this short video. spoken: transcribe exactly every word spoken, in order, with nothing added; an empty string if nobody speaks. lettering: every word, name, logo, number or letter visible anywhere in the picture at any point, one entry each, empty if none — text: what it says; on: what it is on: \"equipment\" (a maker's name, model or number printed on a machine, rack, weight, bench or mat), \"screen\" (the display of a machine, or a television or clock in the room), \"clothing\" (anything a person is wearing), \"sign\" (a sign, poster, board, or writing on a wall, door, window or mirror), \"overlay\" (a caption, subtitle, title, watermark or logo laid over the picture rather than part of the room), \"other\" (none of these, or you cannot tell). people: how many people are visible at any point. lips_match_speech: true only if the visible person's mouth moves in time with the spoken words. faults: every visible fault that would make a viewer think this is not real footage — warped hands or faces, objects that melt or pass through each other, impossible movement, a face that changes — each as a short phrase; empty if none. looks_real: 1 to 10, how convincingly this passes as phone footage shot in a real gym. If the speech is Chinese, write spoken in Traditional Chinese characters as used in Taiwan, numbers as Arabic digits, still exactly as said — keep every repeated or extra word.";
const HEAR_QUESTION = "Listen to this recording of one person speaking. Write down exactly every word that is spoken, in order. Keep every repeated word, stutter, false start and any extra words at the end exactly as they are said: do not tidy, correct or complete anything. If the speech is Chinese, write it in Traditional Chinese characters as used in Taiwan, numbers as Arabic digits.";
/** The real models: a still from the gym's image model, a clip from Omni, a watching pass by the check model, a second listen by sound alone. */
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
    /**
     * A take's words by its sound alone (2026-11-16): the sound track only, to a listener told to keep every repeat and
     * extra word. Measured on 20 takes: it agreed with all 10 that passed, confirmed 8 of 10 refusals, and heard 2 as
     * written that the watching pass had tidied into better English than was said.
     */
    async hear(file) {
      const wav = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
      const named = profile.display_name ? ` The business is called "${profile.display_name}": where that name is spoken, write it exactly that way.` : "";
      const out = await whenGeminiFree(async () => {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": loadGeminiKey() }, signal: AbortSignal.timeout(120000),
          body: JSON.stringify({ contents: [{ parts: [{ text: HEAR_QUESTION + named + " Answer with the spoken words only." }, { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }] }], generationConfig: { temperature: 0 } }) });
        if (!res.ok) throw new Error(`the second listen failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
        return res.json();
      }, { label: "second listen" });
      return norm((out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" "));
    },
    /**
     * A coach's clip (or re-made picture) against the real picture it was made from: the same person, the uniform's
     * print unchanged, the gym's own lettering unchanged. Three frames of a clip — near its start, its middle, its end.
     */
    async same(start, target) {
      let frames = [target];
      if (/\.mp4$/i.test(target)) { const d = durationOf(target), base = join(tmpdir(), `same-${sha(target + statSync(target).size).slice(0, 12)}`); frames = [0.4, d / 2, Math.max(0.5, d - 0.4)].map((t, i) => { const f = `${base}-${i}.jpg`; ff(["-ss", String(Math.max(0, t)), "-i", target, "-frames:v", "1", "-q:v", "3", f]); return f; }); }
      return callVision([start, ...frames], SAME_QUESTION, SAME_SCHEMA);
    },
    /** The kit one photo of the room shows (a vision call). */
    async kit(photo) { const r = await callVision(photo, KIT_QUESTION, KIT_SCHEMA); return KIT.filter((k) => r?.[k] === true); },
    async watch(file, { move = null, paper = false } = {}) {
      // With exercises: was the move done before the line? Asked only of a move cut.
      // (2026-11-17: asked whether the move was done "before the person speaks", the check said no of a silent clip in which a deadlift is plainly done, twice: one repetition counts, and it need not be deep.)
      // The movement is described, not only named: a single shallow kettlebell deadlift was called "not done" four times running when it was asked for by name.
      const moveQ = moveQuestion(move);
      // A name is spelt the gym's way when it is heard ("Aether", not "Ether"; "F45", not "F forty-five"): nothing else about the line is told.
      // How a listed word sounded is not asked (2026-11-15): the check wrote "kee" for a clip the owner heard as "kway", so its ear is no judge of that.
      // White paper: the sheet's own hand-written words are read back apart (paper-video.mjs), so they are not lettering here.
      const paperQ = paper ? " The person holds a sheet of paper with hand-written words on it: leave the writing on that paper out of lettering, and list only other lettering. The front sheet is let go and falls or slides away during the clip, showing a blank sheet behind it: that is meant, so never list the sheet leaving, or its writing going with it, as a fault." : "";
      const named = profile.display_name ? ` The business is called "${profile.display_name}": where that name is spoken, write it exactly that way.` : "";
      const out = await whenGeminiFree(async () => {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": loadGeminiKey() }, signal: AbortSignal.timeout(240000),
          body: JSON.stringify({ contents: [{ parts: [{ text: WATCH_QUESTION + moveQ + paperQ + named }, { inline_data: { mime_type: "video/mp4", data: readFileSync(file).toString("base64") } }] }], generationConfig: { responseMimeType: "application/json", responseSchema: WATCH_SCHEMA, temperature: 0 } }) });
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
/**
 * The words the presenter is given to read: a word on the said-as list is written the way it sounds ("Boat Key" for
 * "Boat Quay"), capitalised as the line has it. The captions keep the word as written — software sets them from the script.
 */
/** How the listed Chinese words of a line are said, for the video model: "上班" is said shàng bān — 班 in the first tone… */
/**
 * How a Chinese line is spoken (2026-11-21, the owner on Xinyi's videos: 飲食, 衣服, 加油 and 了解你的目標 "in a weird
 * English accent … it needs to sound local"). "A natural Taiwanese accent" beside a voice described as having "a light
 * accent" let the model put a foreign accent on some words; the presenter is now a native speaker from Taipei.
 */
export const NATIVE_ZH = "Mandarin Chinese as a native speaker from Taipei speaks it — every word pronounced the way people in Taipei say it, with no foreign or American accent and no English sounds";
export const pronounce = (said = []) => said.filter((x) => x.pinyin).map((x) => `"${x.word}" is pronounced ${x.say}${x.note ? ` — ${x.note}` : ""}.`).join(" ");
export const spokenLine = (line, said = []) => said.filter((x) => !x.pinyin).reduce((s, x) => s.replace(new RegExp(`(?<![A-Za-z])${x.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gi"), (m) => (/^[A-Z]/.test(m) ? x.say.charAt(0).toUpperCase() + x.say.slice(1) : x.say.toLowerCase())), String(line));
/**
 * What happens after the line (2026-11-16): two takes filled the time left over with speech nobody wrote ("So contribute
 * to me to test human self"), and four said a word or phrase twice. The presenter is told to stop and stay silent.
 */
export const silentAfter = (presenter) => { const he = presenter.gender === "man" ? "he" : "she", his = presenter.gender === "man" ? "his" : "her"; return `When the sentence is finished ${he} stops talking: ${he} closes ${his} mouth, keeps looking into the lens with a small smile and stays silent until the clip ends — no more words, nothing said twice.`; };
export function clipPrompt({ presenter, profile, line, seconds, said = [] }) {
  if (presenter.coach) return coachClipPrompt({ coach: presenter.coach, profile, line, seconds, said });
  const she = presenter.gender === "man" ? "The man" : "The woman", pron = presenter.gender === "man" ? "His" : "Her", their = presenter.gender === "man" ? "his" : "her", voice = `${countryRules(profileCountry(profile)).demonym || "natural"} English`;
  const voiceZh = isZh(line) ? NATIVE_ZH : voice;
  const tones = pronounce(said);
  return `Bring this photograph to life as ${seconds} seconds of video. ${she} keeps looking into the camera and says, in a warm, natural ${voiceZh} voice, at an easy conversational pace: "${spokenLine(line, said)}" ${pron} mouth forms exactly these words, once, in time with ${their} voice.${tones ? ` Pronunciation: ${tones}` : ""} ${silentAfter(presenter)} ${pron} hands stay low and relaxed, with at most one small, slow gesture: no pointing, no counting on fingers, no hands near the face. No walking. Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. Keep ${their} face, hair, clothes and the room exactly as they are in the photograph. ${PHONE} ${NO_WORDS} Sound: ${their} voice, close and clear, over the quiet of an empty gym. No music.`;
}

// ── a real coach (2026-11-17) ────────────────────────────────────────────────
/**
 * A gym's real coach in place of the invented presenter (coach-look.mjs: named by the owner, consent for face and voice
 * on file, the pictures cut from real frames of the gym's own sample videos). Tested on the owner's yes the same day
 * (US$3.80, `plans/coach-test-2026-11-17/`; his verdict: likeness yes, voice close enough, uniform yes): Google's video
 * model animates a real frame and keeps the shirt's print; the lessons are in these prompts — the clip is timed at the
 * app's own speaking speed (given the coach's slower one, the model filled the spare seconds by saying the line
 * again), the camera is told to stay where it is (it pushed in), nothing is held in front of the shirt's print (a
 * dumbbell at the chest hid it), and the gym's own lettering must stay as it is (a wall's words turned to nonsense in
 * one clip: that is checked, see `models.same`). A coach is written as "the coach": nothing here says he or she.
 */
const COACH_SAME = "The person in the photograph is a real coach at this gym: keep the coach's face, hair, build, clothes and the room exactly as they are in the photograph, so that the coach is recognisably the same person in every frame.";
const COACH_QUIET = "When the sentence is finished the coach stops talking: mouth closed, still looking into the lens with a small smile, silent until the clip ends — no more words, nothing said twice.";
const STILL_CAMERA = "The camera is fixed on a tripod for the whole clip: it does not move closer, pull back, sway or turn, and the framing of the last frame is exactly the framing of the first.";
/** A coach's clip is not told of a hand-held sway (2026-11-17: told of one, the model pushed the camera in on both coaches, and the face drifted with it). */
const COACH_PHONE = "It looks like real footage shot on a phone standing on a tripod: natural indoor light, real skin, nothing glossy or cinematic. One continuous shot with no scene cuts.";
const coachUniform = (coach) => {
  const w = norm(coach?.uniform?.words);
  return `${w ? `The print on the coach's top stays exactly as it is in the photograph for the whole clip — ${norm(coach.uniform.logo) ? "the logo and " : ""}the words ${w}, sharp and readable, never warped, never changed` : "Anything printed on the coach's clothes stays exactly as it is in the photograph"} — and so do any lettering on the walls behind and the small microphone clipped at the collar if there is one. Nothing else is written anywhere: no captions, no subtitles, no titles, no watermark.`;
};
/** A talking clip of a coach, from a real frame (or from a re-made picture, or a move clip's last frame: `holding` says what the hands do). */
export function coachClipPrompt({ coach, profile, line, seconds, said = [], holding = null, before = "" }) {
  const lang = isZh(line) ? `in ${NATIVE_ZH}, ` : "";
  const voice = coach.voice ? `${lang}in this voice — ${norm(coach.voice).replace(/[.\s]+$/, "")} — at an easy, natural pace` : `${lang || `in a warm, natural ${countryRules(profileCountry(profile)).demonym || "natural"} English voice, `}at an easy conversational pace`;
  const tones = pronounce(said);
  return `Bring this photograph to life as ${seconds} seconds of video. ${COACH_SAME} ${before ? `${before} ` : ""}The coach looks into the camera and says, ${voice}: "${spokenLine(line, said)}" The coach's mouth forms exactly these words, once, in time with the voice.${tones ? ` Pronunciation: ${tones}` : ""} ${COACH_QUIET} ${holding || "The coach's hands stay low and relaxed, with at most one small, slow gesture: no pointing, no hands near the face, nothing in front of the print on the coach's top."} No walking. ${STILL_CAMERA} Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. ${coachUniform(coach)} ${COACH_PHONE} Sound: the coach's voice, close and clear, over the quiet of an empty gym. No music.`;
}
/** A re-made picture of a coach in a pose the samples do not have: from two real pictures of them (the first also gives the room). */
export function coachStillPrompt({ coach, pose, room = false }) {
  const w = norm(coach?.uniform?.words), wears = [coach.wears?.top, coach.wears?.bottom, coach.wears?.glasses ? "glasses" : null].filter(Boolean).join(", ");
  return `A real photograph taken on a phone held upright, 9:16. The person is the SAME real person as in the first and second images: exactly the same face, hair, build and skin, wearing the same clothes${wears ? ` (${wears})` : ""}${w ? ` — the print on the top exactly as it is in those images: ${norm(coach.uniform.logo) ? "the logo and " : ""}the words ${w}, sharp and readable` : ""}, with the same small microphone clipped at the collar if there is one. ${pose} Nothing the coach holds is in front of the print on the top: the print is in full view. ${room ? "The room is the gym in the THIRD image — its walls, ceiling, lights, equipment and floor — matched for the room only: nobody in that image appears, the coach is alone in it, and no words, sign or logo is on any wall" : "The room is the room of the first image — its walls, ceiling, lights, equipment and floor — and the coach is alone in it. The picture is framed so that NO lettering on any wall is in view: the coach stands where the wall behind is plain or only equipment shows, and no words, sign or logo is on any wall in the picture"}. Natural indoor light, real skin texture, nothing glossy, not a studio portrait; the coach's hands and anything held look natural and solid. No other text anywhere: no captions, no titles, no watermark.`;
}
/** What the uniform-and-likeness check is asked: the real picture first, then frames of the clip (or the re-made picture). */
const SAME_SCHEMA = { type: "OBJECT", properties: { same_person: { type: "BOOLEAN" }, differences: { type: "ARRAY", items: { type: "STRING" } }, shirt_reads: { type: "STRING" }, shirt_changed: { type: "BOOLEAN" }, wall_changed: { type: "BOOLEAN" }, wall_reads: { type: "STRING" }, wall_lettering: { type: "ARRAY", items: { type: "STRING" } } }, required: ["same_person", "differences", "shirt_reads", "shirt_changed", "wall_changed", "wall_lettering"] };
const SAME_QUESTION = "The FIRST image is a real photograph of a person. The other images were made from it and must show the SAME person, in the same clothes. same_person: true only if someone who knows the person in the first image would take the person in every other image for them without a second look. differences: every difference in the face, hair, glasses, build or clothes between the first image and the others, each as a short phrase; empty if none. shirt_reads: the words printed on the front of their top in the other images, as they read there; \"\" if none can be seen. shirt_changed: true only if, in any other image, the print on the top shows letters or a logo that DIFFER from the first image — misspelt, warped into other letters, replaced, or missing from a part of the top that is in plain view. Letters hidden behind a hand, an arm or an object, turned away, or outside the picture are NOT a change. wall_changed: true only if lettering on the walls, mirrors or signs that can be read in the first image reads DIFFERENTLY in any other image — other letters or other words where the same wall is in view. Lettering hidden behind the person, out of focus or outside the picture is NOT a change, and a different room or a different part of the room is NOT a change. wall_reads: where wall_changed is true, what the changed lettering reads; else \"\". wall_lettering: every piece of lettering that can be seen on a wall, a mirror or a sign in the LAST image — not on equipment, clothing, paper or the floor — each as it reads there, garbled or not; empty if there is none.";
/**
 * A RE-MADE picture of a coach (a move's start position, the blank paper), held against a real one: not the same
 * person, the uniform's print changed — or **words on a wall** (2026-11-18: one exercise cut of BFIT's re-make showed
 * "BE S…NG, BANEY" at the frame's edge; the image model carries a wall's slogan over from the coach's real pictures and
 * cannot spell it, though the room photo it is given has none). Any of these and the picture is made once more.
 */
export const stillFault = (same) => { const k = sameFails(same); return k && k !== "wall" ? k : (same?.wall_lettering || []).some((t) => norm(t)) ? "wallwords" : null; };
export const stillWhy = (same, name) => (stillFault(same) === "wallwords" ? `it shows words on a wall (${same.wall_lettering.map(norm).filter(Boolean).slice(0, 3).join(", ")}), which the image model cannot spell` : sameWhy(same, stillFault(same), name));
const sameFails = (same) => (!same ? null : same.same_person === false ? "likeness" : same.shirt_changed === true ? "uniform" : same.wall_changed === true ? "wall" : null);
const sameWhy = (same, kind, name) => (kind === "likeness" ? `it does not look like ${name || "the coach"}${(same.differences || []).length ? ` (${same.differences.slice(0, 3).join("; ")})` : ""}` : kind === "uniform" ? `the print on the uniform changed${norm(same.shirt_reads) ? ` (it reads "${norm(same.shirt_reads)}")` : ""}` : kind === "wall" ? `the gym's lettering on the wall changed${norm(same.wall_reads) ? ` (it reads "${norm(same.wall_reads)}")` : ""}` : null);
/** A talking cut's picture is a real frame: the "prompt" that names it is the frame itself. */
const coachFrame = (coach, i) => coach.starts[i % coach.starts.length];
const coachFrameKey = (coach, i) => { const f = coachFrame(coach, i); return `a real frame of ${coach.id}: ${basename(f)} ${existsSync(f) ? statSync(f).size : 0}`; };
/** What the watching pass is asked of a move cut: the movement described, not only named, and once is enough ("" for a hold or a talking cut). */
export const moveQuestion = (move) => (move?.m.kind === "move" ? ` did_move: at any point in the clip, does the person do this movement at least ONCE — ${move.m.does({ He: "The person", he: "the person", his: "their" }, move.k).replace(/^does (two|three) [^:]*: /, "")}? Once is enough even though the movement may be repeated, it need not be deep or perfect, and it does not matter whether anyone speaks. true or false.` : "");
/** The mark, in a coach's store, that a cut is filmed standing from a real frame because its line was refused after its move. */
const standingMark = (i) => `cut-${i + 1}-standing.json`;
/** Where a coach's pictures and clips of a script are kept: beside the invented presenter's, never mixed with them. */
export const coachStore = (gymDir, scriptId, coach) => join(gymDir, CLIPS_DIR, `${scriptId}--${coach.key}`);

// ── with exercises: a move, then the line ────────────────────────────────────
/**
 * The second kind of presenter video (2026-11-15, the owner, with a coach's video — two medicine-ball twists in
 * silence, then she stops and talks holding the ball; a cut sitting on a bike; two standing; a burst of skipping, then
 * the ending holding the rope: "it's like the Aether ones … but the coach is doing associated exercises too"; tested
 * the same day on three clips he approved). The same scripts, filmed another way: MOVE, STOP, TALK — nobody talks
 * while lifting. Each cut is one of three things: a **move** (a rep or two in silence, then the line said in place,
 * still holding the kit), a **hold** (sitting or standing with the kit, talking), or standing as in the first kind.
 *
 * **The agent picks the moves** (his ruling: "agent must pick the moves … exercises that are common in most gyms and
 * look simple for the user to do. A clean and jerk is too hard … a bench press is not suitable since functional
 * training gyms don't really do bench press … Russian twists with a plate or kettlebell squats would be highly
 * adaptable") from `MOVES`, the list he pre-approved: only what a beginner looks at and thinks "I could do that",
 * with kit most gyms have, done in one spot with the face in view. Only kit the gym's own room photos show is used
 * (`readKit`: each cleaned premises photo read once), the same move with another weight where the first is not there
 * (a goblet squat with a dumbbell where the room has no kettlebell). Left out for good: barbell lifts, Olympic lifts,
 * kettlebell swings, burpees, box jumps, pull-ups, push-ups, planks, ropes, machines.
 */
export const VIDEO_KINDS = ["presenter", "active"];
/** Seconds added to a move cut's clip for the move itself (asked for two, the model takes three to four), and how much of the move the cut keeps before the first word. */
export const MOVE_LEAD = 4, MOVE_KEEP = 1.6;
export const KIT = ["dumbbell", "kettlebell", "plate", "box", "bench"];
const G = (presenter) => (presenter.coach ? { He: "The coach", he: "the coach", his: "the coach's" } : presenter.gender === "man" ? { He: "He", he: "he", his: "his" } : { He: "She", he: "she", his: "her" });
const CLOSE = (g) => `The camera is close: ${g.he} fills most of the frame.`;
const FULL = (g) => `The camera is a few steps back, close enough that ${g.his} whole body, from head to feet, fills the height of the frame.`;
const ITEM = { plate: "one round black weight plate", kettlebell: "one kettlebell", dumbbell: "one dumbbell, held by its two ends" };
/**
 * The moves (kind `move`) and the holds (kind `hold`). `kit`: any one of these, the first the room has (empty: none
 * needed). `pose`: the picture a clip starts from; `does`: the reps, in silence; `rest`: how the move ends before the
 * line; `stays`: what holds for the rest of the clip; `label`: how it reads on the owner's screen.
 */
export const MOVES = [
  { id: "russian-twist", covers: true, name: "Russian twists", kind: "move", kit: ["plate", "kettlebell", "dumbbell"], label: (k) => `Russian twists with a ${k}`,
    pose: (g, k) => `${g.He} sits on the gym floor, side-on to the camera, knees bent with ${g.his} heels on the floor, leaning back a little with a straight back, holding ${ITEM[k]} in both hands in front of ${g.his} chest, ${g.his} shoulders turned toward one hip, eyes on the ${k}, mid-exercise. The camera is low, at the height of ${g.his} chest, and close: ${g.his} whole body is in the picture and fills the width of the frame.`,
    does: (g, k) => `does two smooth Russian twists: ${g.he} turns ${g.his} shoulders and carries the ${k} to one side of ${g.his} hips, then to the other side`,
    rest: (g, k) => `holds the ${k} still against ${g.his} chest, turns ${g.his} face to the camera`, stays: (g) => `${g.He} stays seated on the floor.` },
  { id: "goblet-squat", covers: true, name: "goblet squats", kind: "move", kit: ["kettlebell", "dumbbell"], label: (k) => `goblet squats with a ${k}`,
    pose: (g, k) => `${g.He} stands on the open floor facing the camera, feet a little wider than ${g.his} shoulders, holding ONE ${k} against ${g.his} chest with both hands${k === "dumbbell" ? ", upright, cupped under its top end" : ", by the sides of its handle"}, elbows down — the start of a goblet squat — looking ahead with easy focus. ${FULL(g)}`,
    does: (g, k) => `does two slow, easy goblet squats: ${g.he} bends ${g.his} knees and sits back until ${g.his} thighs are level with the floor, then stands up tall, the ${k} staying against ${g.his} chest the whole time`,
    rest: () => "stands still", stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "shoulder-press", name: "shoulder presses", kind: "move", kit: ["dumbbell"], label: () => "shoulder presses with two dumbbells",
    pose: (g) => `${g.He} stands on the open floor facing the camera, feet under ${g.his} hips, holding a dumbbell in each hand at shoulder height, palms forward, elbows bent — the start of a shoulder press — looking ahead with easy focus. Framed from head to thighs, with room above ${g.his} head for the dumbbells to go up. ${CLOSE(g)}`,
    does: (g) => `does two slow shoulder presses: ${g.he} presses both dumbbells straight up over ${g.his} head and lowers them back to ${g.his} shoulders`,
    rest: (g) => `lowers the dumbbells to ${g.his} sides and stands still`, stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "bicep-curl", name: "bicep curls", kind: "move", kit: ["dumbbell"], label: () => "bicep curls with two dumbbells",
    pose: (g) => `${g.He} stands on the open floor facing the camera, feet under ${g.his} hips, a dumbbell in each hand at ${g.his} sides, arms straight, palms forward — the start of a bicep curl — looking ahead with easy focus. Framed from head to thighs. ${CLOSE(g)}`,
    does: (g) => `does two slow bicep curls: ${g.he} curls both dumbbells up to ${g.his} shoulders and lowers them again, ${g.his} elbows staying at ${g.his} sides`,
    rest: (g) => `holds the dumbbells still at ${g.his} sides`, stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "deadlift", name: "deadlifts", kind: "move", kit: ["kettlebell", "dumbbell"], label: (k) => (k === "kettlebell" ? "deadlifts with a kettlebell" : "deadlifts with two dumbbells"),
    pose: (g, k) => `${g.He} stands on the open floor, turned a little to one side of the camera, feet under ${g.his} hips, standing tall and holding ${k === "kettlebell" ? "one kettlebell with both hands in front of" : "a dumbbell in each hand in front of"} ${g.his} thighs, arms straight — the top of a deadlift — looking ahead with easy focus. ${FULL(g)}`,
    does: (g, k) => `does two slow, easy deadlifts: with a flat back ${g.he} pushes ${g.his} hips back and lowers the ${k === "kettlebell" ? "kettlebell" : "dumbbells"} down past ${g.his} knees, then stands up tall again`,
    rest: () => "stands tall and still", stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "reverse-lunge", name: "reverse lunges", kind: "move", kit: ["dumbbell"], label: () => "reverse lunges with two dumbbells",
    pose: (g) => `${g.He} stands on the open floor facing the camera, feet together, a dumbbell in each hand at ${g.his} sides, arms straight — the start of a reverse lunge — looking ahead with easy focus. ${FULL(g)}`,
    does: (g) => `does two slow reverse lunges: ${g.he} steps one foot back and bends both knees, then steps back up to standing, and does the same with the other leg`,
    rest: () => "stands still with both feet together", stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "step-up", name: "step-ups", kind: "move", kit: ["box", "bench"], label: (k) => `step-ups onto a ${k}`,
    pose: (g, k) => `${g.He} stands side-on to the camera in front of a low ${k === "box" ? "black wooden box" : "flat training bench"}, one foot flat on top of it and the other on the floor, arms relaxed — the start of a step-up — eyes on the ${k}. ${FULL(g)}`,
    does: (g, k) => `does two easy step-ups: ${g.he} steps up to stand tall on the ${k}, then steps back down to the floor`,
    rest: (g, k) => `stands on the floor beside the ${k}, turns to face the camera`, stays: (g) => `${g.He} stays beside it: no walking away, and the camera does not move closer.` },
  { id: "squat", name: "squats", kind: "move", kit: [], label: () => "bodyweight squats",
    pose: (g) => `${g.He} stands on the open floor facing the camera, feet a little wider than ${g.his} shoulders, both arms held straight out in front of ${g.his} chest — the start of a squat — looking ahead with easy focus. ${FULL(g)}`,
    does: (g) => `does two slow, easy squats: ${g.he} bends ${g.his} knees and sits back until ${g.his} thighs are level with the floor, arms out in front, then stands up tall`,
    rest: (g) => `stands still and lets ${g.his} arms rest at ${g.his} sides`, stays: (g) => `${g.He} stays where ${g.he} is: no walking, and the camera does not move closer.` },
  { id: "seated", name: "seated", kind: "hold", kit: ["box", "bench"], label: (k) => `sitting on a ${k}`,
    pose: (g, k, has) => `${g.He} sits on a ${k === "box" ? "black wooden box" : "flat training bench"} on the gym floor, facing the camera, leaning forward a little with ${g.his} forearms resting on ${g.his} thighs, ${has("dumbbell") ? `one dumbbell held loosely in one hand between ${g.his} knees` : `${g.his} hands loosely together`}, as if resting between sets, looking straight into the lens, relaxed and friendly, mid-sentence. Framed from the knees up. ${CLOSE(g)}`,
    stays: (g) => `${g.He} stays seated and keeps ${g.his} hands low and still; at most one small nod.` },
  { id: "chest-hold", covers: true, name: "holding a weight", kind: "hold", kit: ["kettlebell", "dumbbell"], label: (k) => `standing with a ${k} held at the chest`,
    pose: (g, k) => `${g.He} stands on the open floor facing the camera, holding one ${k} against ${g.his} chest with both hands, as if between sets, looking straight into the lens, relaxed and friendly, mid-sentence. Framed from the waist up. ${CLOSE(g)}`,
    stays: (g, k) => `${g.He} holds the ${k} still against ${g.his} chest the whole time: no walking.` },
  { id: "foot-up", name: "one foot up", kind: "hold", kit: ["box", "bench"], label: (k) => `one foot up on a ${k}`,
    pose: (g, k) => `${g.He} stands with one foot up on a low ${k === "box" ? "black wooden box" : "flat training bench"}, leaning forward a little with one forearm resting on that knee, as if between sets, looking straight into the lens, relaxed and friendly, mid-sentence. Framed from the knees up. ${CLOSE(g)}`,
    stays: (g) => `${g.He} stays as ${g.he} is, ${g.his} foot on it and ${g.his} arm resting on ${g.his} knee: no walking.` },
];
/** The kit a move uses in a room: the first of its own the room has; "" when it needs none; null when the room has none of it. */
export const kitFor = (move, kit = KIT) => (move.kit.length ? move.kit.find((k) => kit.includes(k)) ?? null : "");
/** How a picked move reads: "Russian twists with a plate", "sitting on a box". */
export const moveLabel = (mv) => (mv ? mv.m.label(mv.k) : null);
/** Seconds of video a cut is asked for: its words, and — for a move — the move before them; never past the model's limit. */
const cutSeconds = (line, mv) => Math.min(CLIP_SECONDS[1], clipSeconds(line) + (mv?.m.kind === "move" ? MOVE_LEAD : 0));
/**
 * The agent's pick for each cut of a script filmed with exercises: [{ m (the move), k (its kit) } | null (standing)].
 * As in the owner's reference: the first cut and the last open on a move, the second is a hold, the rest stand. By
 * the script's id, so every run picks the same (what is filmed is reused); two cuts never show the same move; a cut
 * whose words leave no room for a move inside the model's longest clip is a hold instead.
 */
export function movesFor(script, { kit = KIT, closing = closingLine(), clear = false } = {}) {
  // `clear` (a real coach in the gym's uniform): never a move or a hold that puts the kit in front of the shirt's print (`covers`).
  const cuts = filmedLines(script.lines, closing), n = cuts.length, order = (kind) => MOVES.filter((m) => m.kind === kind && kitFor(m, kit) != null && !(clear && m.covers)).map((m) => ({ m, k: kitFor(m, kit), key: sha(`${script.id}|${m.id}`) })).sort((a, b) => a.key.localeCompare(b.key)).map(({ m, k }) => ({ m, k }));
  const moves = order("move"), holds = order("hold"), fits = (i) => clipSeconds(fillLine(cuts[i], "Ang Mo Kio")) + MOVE_LEAD <= CLIP_SECONDS[1];
  const out = cuts.map(() => null), hold = (i) => { if (holds.length) out[i] = holds.shift(); };
  const move = (i) => { if (moves.length && fits(i)) out[i] = moves.shift(); else hold(i); };
  move(0);
  if (n >= 3) { move(n - 1); hold(1); } else if (n === 2) hold(1);
  return out;
}
/** The picture a move's clip starts from: the same invented presenter, in the start position, in the gym's own room. */
export function moveStillPrompt({ presenter, profile, move, kit = KIT }) {
  const g = G(presenter), has = (k) => kit.includes(k);
  if (presenter.coach) return coachStillPrompt({ coach: presenter.coach, pose: move.m.pose(g, move.k, has), room: presenter.room === true });
  return `A real photograph taken on a phone held upright, 9:16. The person is the SAME person as in the first image: the same face, hair and clothes. ${g.He} is ${presenterWords(presenter, profile)}. ${move.m.pose(g, move.k, has)} The room is the gym in the second image — its walls, ceiling, lights, equipment and floor — matched for the room only: nobody in that image appears, and ${g.he} is alone. Natural indoor light, real skin texture, nothing glossy, not a studio portrait; ${g.his} hands and what ${g.he} holds look natural and solid. ${NO_WORDS}`;
}
/** The clip of a move or a hold: the move in silence, then the line said in place; a hold is said as it is held. */
export function moveClipPrompt({ presenter, profile, line, seconds, said = [], move }) {
  if (presenter.coach) { const c = G(presenter), mm = move.m, kk = move.k; return coachClipPrompt({ coach: presenter.coach, profile, line, seconds, said, before: mm.kind === "move" ? `For the first two seconds the coach says nothing and ${mm.does(c, kk)}. Then the coach stops, ${mm.rest(c, kk)}, and only then speaks.` : "", holding: `${mm.stays(c, kk)} What the coach holds stays one solid object, and never in front of the print on the coach's top.` }); }
  const g = G(presenter), she = presenter.gender === "man" ? "The man" : "The woman", voice = `${countryRules(profileCountry(profile)).demonym || "natural"} English`, m = move.m, k = move.k;
  const says = `says, in a warm, natural ${voice} voice, at an easy conversational pace: "${spokenLine(line, said)}" ${g.He === "He" ? "His" : "Her"} mouth forms exactly these words, once, in time with ${g.his} voice. ${silentAfter(presenter)}`;
  const body = m.kind === "move"
    ? `For the first two seconds ${g.he} says nothing and ${m.does(g, k)}. Then ${g.he} stops, ${m.rest(g, k)}, looks into the lens and ${says} ${m.stays(g, k)}`
    : `${she} keeps looking into the camera and ${says} ${m.stays(g, k)}`;
  return `Bring this photograph to life as ${seconds} seconds of video. ${body} Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. Keep ${g.his} face, hair, clothes and the room exactly as they are in the photograph; what ${g.he} holds stays one solid object. ${PHONE} ${NO_WORDS} Sound: ${g.his} voice, close and clear, over the quiet of an empty gym. No music.`;
}
/**
 * A move cut is TWO clips (2026-11-16, tested on the owner's yes and approved on the clip: "Build 3"). Filmed as one —
 * the move, then the line, 13 to 14 seconds — a move cut was said as written one time in four: the line was scrambled
 * after the move, or the time left over was filled with words nobody wrote, and every failed take paid for the move
 * again. Now the MOVE is its own silent clip of `MOVE_SECONDS` (no words to get wrong), and the LINE is an ordinary
 * talking clip that starts from the move clip's LAST FRAME, so the two read as one shot. A line that fails is filmed
 * again alone. A cut whose one-clip take already passed keeps it: nothing on file is filmed again for this.
 */
export const MOVE_SECONDS = 4;
const SAME = (g) => `Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. Keep ${g.his} face, hair, clothes and the room exactly as they are in the photograph; what ${g.he} holds stays one solid object.`;
/** The move alone, in silence: the reps, then still, facing the lens — the frame the line's clip starts from. */
export function moveOnlyPrompt({ presenter, move }) {
  const g = G(presenter), m = move.m, k = move.k;
  if (presenter.coach) return `Bring this photograph to life as ${MOVE_SECONDS} seconds of video. ${COACH_SAME} Nobody speaks at any point: the coach's mouth stays closed and there is no voice. ${g.He} ${m.does(g, k)}. Then ${g.he} ${m.rest(g, k)}, turns to face the camera and looks into the lens with an easy, friendly expression, mouth closed, and holds still. ${m.stays(g, k)} What ${g.he} holds stays one solid object. ${STILL_CAMERA} Exactly one person is in the room for the whole clip: nobody walks in, nobody appears in a doorway or a mirror. ${coachUniform(presenter.coach)} ${COACH_PHONE} Sound: only the quiet of an empty gym and the small sounds of the movement. No voice, no music.`;
  return `Bring this photograph to life as ${MOVE_SECONDS} seconds of video. Nobody speaks at any point: ${g.his} mouth stays closed and there is no voice. ${g.He} ${m.does(g, k)}. Then ${g.he} ${m.rest(g, k)}, turns ${g.his} face to the camera and looks into the lens with an easy, friendly expression, ${g.his} mouth closed, and holds still. ${m.stays(g, k)} ${SAME(g)} ${PHONE} ${NO_WORDS} Sound: only the quiet of an empty gym and the small sounds of the movement. No voice, no music.`;
}
/** The line after a move: an ordinary talking clip from the move clip's last frame, still holding the kit. */
export function afterMovePrompt({ presenter, profile, line, seconds, said = [], move }) {
  if (presenter.coach) { const c = G(presenter); return coachClipPrompt({ coach: presenter.coach, profile, line, seconds, said, holding: `${move.k ? "The coach keeps what the coach holds still where it is the whole time, never in front of the print on the coach's top. " : ""}${move.m.stays(c, move.k)}` }); }
  const g = G(presenter), she = presenter.gender === "man" ? "The man" : "The woman", voice = `${countryRules(profileCountry(profile)).demonym || "natural"} English`, m = move.m, k = move.k;
  return `Bring this photograph to life as ${seconds} seconds of video. ${she} keeps looking into the camera and says, in a warm, natural ${voice} voice, at an easy conversational pace: "${spokenLine(line, said)}" ${g.He === "He" ? "His" : "Her"} mouth forms exactly these words, once, in time with ${g.his} voice. ${silentAfter(presenter)} ${k ? `${g.He} keeps what ${g.he} holds still where it is the whole time. ` : ""}${m.stays(g, k)} ${SAME(g)} ${PHONE} ${NO_WORDS} Sound: ${g.his} voice, close and clear, over the quiet of an empty gym. No music.`;
}
/** The move clip judged from its check (pure): the move was done, nobody speaks, one person, no lettering laid over it. */
export function judgeMove(seen, move) {
  // A coach's move clip (stamped `coach`): the uniform's print and whatever is written in the room are its own; only words laid over the picture fail it.
  const L0 = letteringOf(seen), L = seen?.coach === true ? { ...L0, fails: L0.fails.filter((x) => x.on === "overlay") } : L0, kind = seen?.did_move === false ? "move" : norm(seen?.spoken) ? "voice" : seen?.people !== 1 ? "people" : L.fails.length ? "lettering" : null;
  const why = kind === "move" ? `the move (${moveLabel(move)}) was not done` : kind === "voice" ? `someone speaks in the move's clip ("${norm(seen.spoken)}")` : kind === "people" ? `${seen?.people} people are in it` : kind === "lettering" ? `words appear in the picture: ${L.fails.map((x) => x.text).join(", ")}` : null;
  return { passed: !kind, why, kind, faults: (seen?.faults || []).filter(Boolean) };
}
const moveBase = (i, mv, still) => `line-${i + 1}-move-${sha(`${mv.m.id}|${mv.k}|${basename(still)}`).slice(0, 6)}`;
const frameOf = (clip) => clip.replace(/\.mp4$/, ".last.png");
/**
 * The kit a gym's room shows, read from its own photos (the room reference and its cleaned premises photos, six at
 * most): one vision call a photo, once, kept by the photo's content in `video-clips/room-kit.json`. `knownKit` is
 * what is on file (null before any photo was read: a plan then counts on every kit, and the run reads the photos).
 */
const KIT_FILE = "room-kit.json", KIT_PHOTOS = 6;
const KIT_SCHEMA = { type: "OBJECT", properties: Object.fromEntries(KIT.map((k) => [k, { type: "BOOLEAN" }])), required: KIT };
const KIT_QUESTION = "This is a photo of a gym. For each kind of equipment say whether at least one is clearly visible in the room: dumbbell (dumbbells, on a rack or the floor), kettlebell (kettlebells: a ball of iron with a handle on top), plate (loose round weight plates, stacked or on a peg, not only those on a barbell), box (a wooden or foam box for stepping or jumping on), bench (a flat or adjustable training bench). true only when you can see it.";
export function kitPhotos(gymDir, room = null) {
  const d = join(gymDir, "brand-assets", "facility-clean"), rest = existsSync(d) ? readdirSync(d).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().map((f) => join(d, f)) : [];
  return [...new Set([room, ...rest].filter((p) => p && existsSync(p)))].slice(0, KIT_PHOTOS);
}
const kitShaOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
export function knownKit(gymDir, room = null) {
  const data = readJson(join(gymDir, CLIPS_DIR, KIT_FILE))?.photos || {}, read = kitPhotos(gymDir, room).map((p) => data[kitShaOf(p)]).filter(Boolean);
  return read.length ? KIT.filter((k) => read.some((r) => r.kit.includes(k))) : null;
}
export async function readKit({ gymDir, room = null, models, spent = null, log = () => {} }) {
  if (!models?.kit) return knownKit(gymDir, room) || [...KIT]; // stand-in models (the tests): every kit, unless some is on file
  const file = join(gymDir, CLIPS_DIR, KIT_FILE), data = readJson(file) || { photos: {} };
  for (const p of kitPhotos(gymDir, room)) {
    const key = kitShaOf(p); if (data.photos[key]) continue;
    if (spent) spent.checks++;
    const seen = await models.kit(p); data.photos[key] = { file: basename(p), kit: KIT.filter((k) => (seen || []).includes(k)), on: today() };
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); log(`the room's kit, from ${basename(p)}: ${data.photos[key].kit.join(", ") || "none seen"}`);
  }
  return knownKit(gymDir, room) || [];
}

// ── the text layer and the cut (software: no model) ──────────────────────────
/**
 * The captions' look (2026-11-14, the owner: "I like the classic simple look. But propose some variation either in
 * color or style, slightly" — he picked the third of five): white capitals with a thin outline and a soft shadow,
 * and the word being said in a warm yellow — the same on every gym's videos, unless the gym has a caption colour of
 * its own (`creative_defaults.caption_accent`, 2026-11-17: BFIT's corporate orange): then that word is in it.
 */
export const CAPTION_ACCENT = "#FFD84A";
const FONTS = `@font-face{font-family:NotoTC;src:url("file://${join(REPO_ROOT, "assets/fonts/notosanstc/NotoSansTC[wght].ttf")}");font-weight:100 900}@font-face{font-family:Anton;src:url("file://${join(REPO_ROOT, "assets/fonts/anton/Anton-Regular.ttf")}")}@font-face{font-family:Mont;src:url("file://${join(REPO_ROOT, "assets/fonts/montserrat/Montserrat[wght].ttf")}");font-weight:100 900}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A transparent 720 × 1280 PNG of the words. Meta's 9:16 live area is x 6–94%, y 14–65%: every block is laid inside it, and the page reports where each landed. */
/** `low` (a coach's video): the block's BOTTOM sits on the edge of Meta's live area and it grows upward, so it never reaches the shirt's print, which a coach's pictures keep above 53% of the height. */
export async function overlay(browser, out, inner, accent = CAPTION_ACCENT, low = false, scale = 1) {
  const html = `<!doctype html><meta charset="utf-8"><style>${FONTS}html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    .cap{position:absolute;left:8%;right:8%;${low ? `bottom:${Math.round((1 - LIVE.bottom) * 1000) / 10 + 0.4}%` : "top:54%"};text-align:center;font:400 58px/1.12 Anton;color:#fff;letter-spacing:1px;-webkit-text-stroke:3px rgba(0,0,0,.85);paint-order:stroke fill;text-shadow:0 4px 16px rgba(0,0,0,.55)}
    .cap b{font-weight:400;color:${accent || CAPTION_ACCENT}}.cap.zh{font-family:NotoTC;font-weight:900;font-size:52px;letter-spacing:2px}.cap.zh b{font-weight:900}</style>${inner}`;
  const page = join(browser.work, `${basename(out)}.html`); writeFileSync(page, html);
  const { cdp, sessionId } = browser;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: scale, mobile: false }, sessionId);
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
/** After a Chinese line's last word (2026-11-21, the owner on Xinyi's v10: "the 做 is cut off too early"): a Mandarin syllable's tail is soft and falls under the silence line sooner. */
export const TAIL_ZH = 0.5;
/** From ffmpeg's silence report and the file's length: where there is sound — `spans` [[a, b], …], each MIN_VOICED or longer — and the first and last of it. No sound found reads as the whole file. */
export function speechFrom(report, duration) {
  const starts = [...String(report).matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])), ends = [...String(report).matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const quiet = starts.map((a, i) => [a, ends[i] ?? duration]).sort((x, y) => x[0] - y[0]), spans = []; let at = 0;
  for (const [a, b] of quiet) { if (a - at >= MIN_VOICED) spans.push([at, a]); at = Math.max(at, b); }
  if (duration - at >= MIN_VOICED) spans.push([at, duration]);
  const r2 = (x) => Math.round(x * 100) / 100;
  return spans.length ? { start: r2(spans[0][0]), end: r2(spans[spans.length - 1][1]), spans: spans.map(([a, b]) => [r2(a), r2(b)]), duration } : { start: 0, end: duration, spans: [[0, duration]], duration };
}
/**
 * A clip with a room hum (2026-11-16, BFIT's first video: "the subtitles are way off"). The video model lays "the
 * quiet of an empty gym" under the voice, and in some clips that hum peaks above `SILENCE_DB`: the whole clip then
 * read as speech — nothing was trimmed (2.3 s of the presenter standing silent after the line) and the captions were
 * spread over all 7 s of a line said in 4, so each ran further behind the voice. Four of BFIT's 25 clips. In such a
 * clip the voice is told from the room by the clip's own levels: how loud it is in the band a voice sits in
 * (`band`), every `step` seconds; the room is the quiet tenth (`floor`), the voice the loud twentieth (`top`); sound
 * is speech from `above` dB over the room, and never nearer the voice than `below`. A quiet room (the floor `clean`
 * dB or more under the voice) keeps the plain measure, which is right there and keeps a soft last syllable.
 */
export const VOICE = { step: 0.02, band: [200, 3500], above: 8, below: 12, range: 10, clean: 30 };
/** How loud a clip is where a voice sits, every `VOICE.step` seconds, in dB (ffmpeg measures; no model call). */
export function levelsOf(file, V = VOICE) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `aresample=16000,highpass=f=${V.band[0]},lowpass=f=${V.band[1]},asetnsamples=${Math.round(16000 * V.step)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, "-f", "null", "-"], { encoding: "utf-8", maxBuffer: 1e8 });
  return [...String(r.stdout || "").matchAll(/RMS_level=(\S+)/g)].map((m) => (Number.isFinite(Number(m[1])) ? Math.max(-90, Number(m[1])) : -90));
}
/**
 * Where someone speaks in a clip with a room hum, from its levels — the shape `speechFrom` answers, with `floor`,
 * `top` and `level` (the line between room and voice). Null for a quiet room, a clip with nothing to tell apart, or
 * no sound read: the plain measure is used.
 */
export function speechFromLevels(levels, duration, V = VOICE) {
  if (!Array.isArray(levels) || levels.length < 10) return null;
  const sorted = [...levels].sort((a, b) => a - b), pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))], floor = pct(0.1), top = pct(0.95);
  if (top - floor < V.range || floor <= top - V.clean) return null;
  const level = Math.min(floor + V.above, top - V.below), r2 = (x) => Math.round(x * 100) / 100, quiet = []; let q = -1;
  for (let i = 0; i <= levels.length; i++) {
    const low = i < levels.length && levels[i] < level;
    if (low && q < 0) q = i;
    if (!low && q >= 0) { if ((i - q) * V.step >= SILENCE_MIN - 1e-9) quiet.push([q * V.step, i === levels.length ? duration : i * V.step]); q = -1; }
  }
  const spans = []; let at = 0;
  for (const [a, b] of quiet) { if (a - at >= MIN_VOICED) spans.push([at, a]); at = Math.max(at, b); }
  if (duration - at >= MIN_VOICED) spans.push([at, duration]);
  return spans.length ? { start: r2(spans[0][0]), end: r2(spans[spans.length - 1][1]), spans: spans.map(([a, b]) => [r2(a), r2(b)]), duration, floor, top, level } : null;
}
/** Where someone speaks in a clip, measured from its sound (ffmpeg does the listening; no model call): by its own levels where the room hums, else by its pauses. */
export function speechOf(file) {
  const duration = durationOf(file), hum = speechFromLevels(levelsOf(file), duration);
  if (hum) return hum;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN}`, "-f", "null", "-"], { encoding: "utf-8" });
  return speechFrom(r.stderr || "", duration);
}
/** A line in caption chunks: up to `per` words, and never across the end of a sentence or a clause. Each { text (trailing commas and stops not shown), ends: it closes a clause }. */
/**
 * A caption's words: split on spaces, or — for Chinese — one Han character each, a run of Latin letters or digits as
 * one, punctuation kept with the character before it. A Chinese block is up to `ZH_PER` characters and its words are
 * joined with no space.
 */
export const ZH_PER = 11;
/** Two-character words a caption block should not be cut through, and characters a block should not start with. */
const ZH_WORDS = new Set("身體 自己 計畫 體態 雕塑 一點 準備 精神 重新 開始 飲食 運動 教練 課程 規劃 聯絡 連結 下方 現在 信義 健身 家庭 時間 生活 喜歡 力氣 沙發 努力 流汗 偷懶 目標 專屬 諮詢 節奏 重量 動作 變化 衣服 自信 改變 夥伴 朋友 上班 下班 開會 忙碌 我們 你們 一起 一堂 課表 一對 一聊 聊聊 沒關 關係 完全 從來 健身 房運 點擊 會跟 跟你 方連 雕塑 塑體 態計 大家 加油 有力 氣做 今天 從今 天開 這次 這一 不用 再等 一直 下個 個月 一步 第一 每個 每一 一路 陪著 陪你 看過 過來 參加 加入 留一 一點 給自 規劃 好的 開心 義路 基隆 路口 得更 更有 也有 後也 班後 報名 就報 工作 忙完 初步 了解 交叉 叉口 認識 點進 進連 變好 獨一 無二 美味 有效 進步 看得 得見 目標 達到".split(" "));
const ZH_NO_START = new Set([..."的了著過們子得地嗎呢吧啊囉喔"]);
/** Where to cut a run of caption words near `want`: the nearest point (up to three either way) that cuts no listed word and does not start on a particle. */
function zhSplit(toks, want) {
  const ok = (i) => i > 0 && i < toks.length && !ZH_NO_START.has(toks[i][0]) && !ZH_WORDS.has(toks[i - 1].slice(-1) + toks[i][0]);
  for (let d = 0; d <= 3; d++) for (const i of [want - d, want + d]) if (i >= 2 && i <= toks.length - 2 && i <= ZH_PER && ok(i)) return i;
  return Math.min(want, ZH_PER);
}
/** Chinese blocks: one clause each (to its comma or stop); a clause longer than `ZH_PER` is split into near-equal parts, so a block never ends on a single character. */
function zhChunks(text) {
  const toks = capTokens(text), clauses = []; let cur = [];
  for (const w of toks) { cur.push(w); if (/[，。！？；：,.!?;:]$/.test(w)) { clauses.push(cur); cur = []; } }
  if (cur.length) clauses.push(cur);
  const out = [];
  for (const c of clauses) {
    let rest = c;
    while (rest.length > ZH_PER) { const k = Math.ceil(rest.length / ZH_PER), at = zhSplit(rest, Math.ceil(rest.length / k)); out.push(rest.slice(0, at).join("")); rest = rest.slice(at); }
    if (rest.length) out.push(rest.join(""));
  }
  return out.map((c) => ({ text: c.replace(/[.,;:，。、；：…]+$/, ""), ends: /[.,;:!?，。！？；：]$/.test(c) }));
}
export const capTokens = (text) => (isZh(text) ? String(text).replace(/\s+/g, "").match(/(?:[A-Za-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]|[^\sA-Za-z0-9\u3400-\u9fff\uf900-\ufaff，。！？、；：,.!?;:]+)[，。！？、；：,.!?;:…]*/g) || [] : norm(text).split(" ").filter(Boolean));
const capJoin = (ws, zh) => ws.join(zh ? "" : " ");
export function captionChunks(text, per = 3) {
  if (isZh(text)) return zhChunks(text);
  const zh = false, most = per, out = []; let cur = [];
  for (const w of capTokens(text)) { cur.push(w); if (cur.length >= most || /[.,;:!?，。！？；：]$/.test(w)) { out.push(capJoin(cur, zh)); cur = []; } }
  if (cur.length) out.push(capJoin(cur, zh));
  return out.map((c) => ({ text: c.replace(/[.,;:，。、；：…]+$/, ""), ends: /[.,;:!?，。！？；：]$/.test(c) }));
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
  const ws = capTokens(c.text), total = ws.reduce((t, w) => t + w.length + 1, 0), r2 = (x) => Math.round(x * 100) / 100; let at = c.from;
  return ws.map((w, i) => { const d = ((w.length + 1) / total) * (c.to - c.from), o = { i, word: w, from: r2(at), to: i === ws.length - 1 ? c.to : r2(at + d) }; at += d; return o; });
}
/** A caption block in capitals, the word at `lit` marked as the one being said. */
export const capHtml = (text, lit) => { const zh = isZh(text); return `<div class="cap${zh ? " zh" : ""}">${capTokens(String(text).toUpperCase()).map((w, i) => (i === lit ? `<b>${esc(w)}</b>` : esc(w))).join(zh ? "" : " ")}</div>`; };
/** How long the last clip is held after its last word, so the video does not end on a clipped syllable (there is no end card). */
export const END_HOLD = 0.45;
/** Cut the clips together — each { file, from, to }, its spoken part — at one size and rate, and lay the timed words over it all. The video ends on the last clip. */
export function assemble({ clips, overlays, out }) {
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
/** A clip's saved check passes by today's rules. */
const passedCheck = (seen, line, profile, say = [], move = null) => !!seen && judgeClip(seen, line, { profile, say, move }).passed;
/** The prompt of a cut's picture: the move's start position, or the standing presenter. */
const cutStillPrompt = (i, presenter, profile, mv, kit) => (mv ? moveStillPrompt({ presenter, profile, move: mv, kit }) : presenter.coach ? coachFrameKey(presenter.coach, i) : stillPromptFor(i, presenter, profile));
/**
 * What a script still needs filmed for these locations, by what is on file: { clips[{ line, area, seconds, on_file,
 * flagged }], seconds (to film, one clean pass), reused (seconds already filmed), flagged (lines whose takes are used
 * up without one passing: they wait for the owner on Pick Ads, and a run films nothing for them), images (pictures
 * still to make) }. No call, and nothing is written: before a script's first use of the store it looks where
 * `adoptClips` would bring files from. A take set aside is not on file; one kept on the owner's word is.
 */
export function videoNeeds({ gymDir, script, areas = [""], room = null, profile = readJson(join(gymDir, "gym-profile.json")) || {}, closing = closingLine(), coach = null, store = coach ? coachStore(gymDir, script.id, coach) : clipStore(gymDir, script.id), legacy = [], saidList = saidAs(), takes = 2, kind = "presenter" }) {
  // A coach's pictures are real frames (no image call for a talking cut) and their clips are their own: nothing of the invented presenter's is brought in.
  // A re-made picture of a coach takes its room from the gym's own room photo when the batch has one (its words-free, cleaned photo): asked to keep the room of a coach's frame, the image model garbled the wall's slogan, and asked for no wall words it left the gym.
  const coachRoom = !!(coach && room && existsSync(room));
  if (coach) room = `coach:${coach.key}`;
  const presenter = coach ? { gender: null, coach, room: coachRoom } : presenterOf(profile), said = spokenLines(script, closing), where = existsSync(store) ? store : (coach ? null : legacy.find(hasStills)) || store;
  const files = existsSync(where) ? readdirSync(where) : [], aside = asideOf(where), clips = []; let images = 0;
  // With exercises: the agent's pick for each cut, by the kit on file for the room (every kit until its photos are read).
  const kit = kind === "active" ? knownKit(gymDir, coach ? null : room) || [...KIT] : null, moves = kind === "active" ? movesFor(script, { kit, closing, clear: !!coach }) : said.map(() => null);
  // The presenter's own picture, which every other picture is made from: a cut that opens on a move still needs it.
  // A coach's cut whose line Google refused after its move is filmed standing from a real frame (see `standingMark`): it is no move cut any more.
  if (coach) for (const i of moves.keys()) if (files.includes(standingMark(i))) moves[i] = null;
  if (!coach && moves[0] && !(presenter && room && files.includes(stillName(0, stillPromptFor(0, presenter, profile), room)))) images++;
  const chk = (f) => readJson(join(where, f.replace(/\.mp4$/, ".check.json"))), keptOn = (f) => !!ownerKeptClip(where, join(where, f)), takesOf = (nm) => files.filter((f) => /\.mp4$/.test(f) && (f === `${nm}.mp4` || f.startsWith(`${nm}-take`)));
  const usedUp = (all, live) => live.length > 0 && all.length >= takes + (all.length - live.length), moveCounted = new Set();
  for (const [i, raw] of said.entries()) {
    const mv = moves[i], still = presenter && room ? stillName(i, cutStillPrompt(i, presenter, profile, mv, kit), room) : null, perArea = /\{AREA\}/.test(raw);
    if ((!still || !files.includes(still)) && !(coach && !mv)) images++;
    for (const area of perArea ? (areas.length ? areas : [""]) : [null]) {
      const line = fillLine(raw, area || ""), say = saidIn(line, saidList), note = saidNote(say), names = still ? [clipName(i, line, still, area, perArea, note), clipName(i, line, altOf(still), area, perArea, note)] : [];
      const mine = files.filter((f) => /\.mp4$/.test(f) && names.some((nm) => f === `${nm}.mp4` || f.startsWith(`${nm}-take`))), live = mine.filter((f) => !aside.has(f));
      const on_file = live.some((f) => passedCheck(readJson(join(where, f.replace(/\.mp4$/, ".check.json"))), line, profile, say, mv) || !!ownerKeptClip(where, join(where, f)));
      // A move cut is two clips (the move, then the line from its last frame) unless a one-clip take of it already passed: the move's clip is shared by every location.
      if (mv?.m.kind === "move" && !on_file) {
        const mAll = still ? takesOf(moveBase(i, mv, still)) : [], mLive = mAll.filter((f) => !aside.has(f)).sort(), mOk = mLive.find((f) => { const c = chk(f); return (!!c && judgeMove(c, mv).passed) || keptOn(f); }) || null, mUse = mOk || mLive[0] || null;
        const lAll = mUse ? takesOf(clipName(i, line, frameOf(mUse), area, perArea, note)) : [], lLive = lAll.filter((f) => !aside.has(f)), lOk = lLive.some((f) => passedCheck(chk(f), line, profile, say, null) || keptOn(f)), lKept = lLive.some(keptOn);
        const on = lOk && (!!mOk || lKept), flagged = !on && ((lOk && !mOk && usedUp(mAll, mLive)) || (!lOk && usedUp(lAll, lLive)));
        const again = !mUse || (!mOk && !usedUp(mAll, mLive)), first = !moveCounted.has(i); moveCounted.add(i);
        clips.push({ line, area, seconds: on ? (first ? MOVE_SECONDS : 0) + clipSeconds(line) : (again && first ? MOVE_SECONDS : 0) + (again || !lOk ? clipSeconds(line) : 0), move: moveLabel(mv), on_file: on, flagged });
        continue;
      }
      clips.push({ line, area, seconds: cutSeconds(line, mv), ...(mv ? { move: moveLabel(mv) } : {}), on_file, flagged: !on_file && live.length > 0 && mine.length >= takes + (mine.length - live.length) });
    }
  }
  const sum = (xs) => xs.reduce((t, c) => t + c.seconds, 0);
  return { clips, seconds: sum(clips.filter((c) => !c.on_file && !c.flagged)), reused: sum(clips.filter((c) => c.on_file)), flagged: clips.filter((c) => c.flagged).length, images };
}

// ── the owner's word on a take ───────────────────────────────────────────────
/**
 * Two small files beside a script's clips (2026-11-15). `set-aside.json`: takes the owner asked to be filmed again
 * (Film this line again) — kept on disk, never used, and each makes room for a fresh take. `owner-kept.json`: a
 * take that failed its check and that he kept anyway (Use this take anyway) — that file, unchanged since, passes on
 * his word, as a flagged premises photo does.
 */
const ASIDE_FILE = "set-aside.json", KEPT_FILE = "owner-kept.json";
export const asideOf = (store) => new Set(Object.keys(readJson(join(store, ASIDE_FILE))?.clips || {}));
const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
export const ownerKeptClip = (store, file) => { const e = readJson(join(store, KEPT_FILE))?.clips?.[basename(file)]; return e && existsSync(file) && e.sha256 === fileSha(file) ? e : null; };
const clipNames = (names) => { const out = [...new Set([].concat(names || []).map((n) => String(n)))]; if (!out.length || out.some((n) => !/^line-[a-z0-9-]+\.mp4$/.test(n))) throw new Error("which take? (a clip of this script, by its file name)"); return out; };
/** Set takes aside, so the next run films the line fresh. Returns how many were newly set aside. */
export function setAside(store, names, why = "") {
  const list = clipNames(names), data = readJson(join(store, ASIDE_FILE)) || { clips: {} }; let n = 0;
  for (const name of list) { if (!existsSync(join(store, name))) throw new Error(`no such take on file: ${name}`); if (!data.clips[name]) { data.clips[name] = { on: today(), ...(norm(why) ? { why: norm(why) } : {}) }; n++; } }
  writeFileSync(join(store, ASIDE_FILE), JSON.stringify(data, null, 2) + "\n"); return n;
}
/** Keep a take that failed its check, on the owner's word. */
export function keepTake(store, name, why = "") {
  const [clip] = clipNames([name]), file = join(store, clip); if (!existsSync(file)) throw new Error(`no such take on file: ${clip}`);
  const data = readJson(join(store, KEPT_FILE)) || { clips: {} };
  data.clips[clip] = { sha256: fileSha(file), on: today(), ...(norm(why) ? { left: norm(why) } : {}) };
  writeFileSync(join(store, KEPT_FILE), JSON.stringify(data, null, 2) + "\n"); return data.clips[clip];
}

// ── making the videos of one script ──────────────────────────────────────────
/**
 * One script → one video for each location. Returns { videos[{ area, file, poster, seconds, lines[], notes[], failed? }], spent{ seconds, images, checks } }.
 * `spent` may be passed in (a batch's running count) and is added to; `caps { seconds, images }` are never passed:
 * a call that would pass one is not made, and the videos that needed it are refused with that as the reason.
 */
export async function makePresenterVideos({ gymDir, outDir, script, areas, offer, audience = null, room, profile = readJson(join(gymDir, "gym-profile.json")) || {}, caps = { seconds: 120, images: 6 }, spent = { seconds: 0, images: 0, checks: 0 }, takes = 2, models = realModels(profile), browser = null, closing = closingLine(), coach = null, store = coach ? coachStore(gymDir, script.id, coach) : clipStore(gymDir, script.id), legacy = [join(outDir, script.id)], saidList = saidAs(), kind = "presenter", log = () => {}, onProgress = () => {} }) {
  // A real coach (coach-look.mjs → coachForVideo: consent on file, pictures cut from real frames) in place of the invented presenter.
  if (coach && !coach.starts?.length) throw new Error(`${coach.name} has no starting picture: nothing is filmed`);
  const roomPhoto = coach && room && existsSync(room) ? room : null;
  if (coach) { room = `coach:${coach.key}`; legacy = []; }
  const presenter = coach ? { gender: null, coach, room: !!roomPhoto } : presenterOf(profile);
  if (!VIDEO_KINDS.includes(kind)) throw new Error(`no such kind of presenter video: ${kind}`);
  if (!presenter) throw new Error("say who presents first (Ad defaults → Presenter): a woman or a man. Nothing is made until then");
  const errs = scriptProblems(script.lines, { offer, profile, closing, allow: factsFor(gymDir, offer) }); if (errs.length) throw new Error(`this script cannot be made: ${errs.join("; ")}`);
  if (!areas?.length) throw new Error("a video needs a location");
  const whole = areas.find((a) => isWholeCountry(a)); if (whole) throw new Error(`"${whole}" is the whole country: a video says the area around the gym, never the country`);
  if (!coach && (!room || !existsSync(room))) throw new Error("a photo of the gym's room is needed, so the video is in the gym's own room (Photos & assets → a cleaned premises photo)");
  if (!hasFfmpeg()) throw new Error("ffmpeg is not installed on this machine: run `brew install ffmpeg` once");
  // The captions are this batch's; the pictures and clips are the script's own, whatever batch films it.
  const dir = join(outDir, coach ? `${script.id}--${coach.key}` : script.id); mkdirSync(dir, { recursive: true });
  const adopted = adoptClips(store, legacy); if (adopted) log(`what was already filmed for this script is reused (from ${basename(dirname(dirname(adopted)))})`);
  mkdirSync(store, { recursive: true });
  const own = !browser; if (own) browser = await launchBrowser();
  const within = (kind, n) => spent[kind] + n <= caps[kind];
  // The script as it is filmed: the closing line, when it is the whole last line, shares a cut with the line before it.
  const said = spokenLines(script, closing), joined = said.length < script.lines.length;
  const label = (i) => (joined && i === said.length - 1 ? `lines ${i + 1} and ${i + 2} (one cut)` : `line ${i + 1}`);
  if (joined) log(`the closing line is filmed with line ${said.length} as one cut: Google's video model refuses it as a clip of its own`);
  const who = coach ? { coach: { id: coach.id, name: coach.name } } : {};
  const refusedAll = (why) => ({ videos: areas.map((area) => ({ area, script_id: script.id, kind, ...who, failed: why })), spent });
  try {
    // With exercises: the kit the room shows (its photos read once), then the agent's pick for each cut.
    const kit = kind === "active" ? await readKit({ gymDir, room: coach ? null : room, models, spent, log }) : null, moves = kind === "active" ? movesFor(script, { kit, closing, clear: !!coach }) : said.map(() => null);
    if (coach) log(`${coach.name} presents: ${Math.min(coach.starts.length, said.length)} real picture(s) to start from${coach.voice ? "" : " (no voice description on file: a plain one is asked for)"}`);
    if (coach) for (const i of moves.keys()) if (moves[i] && existsSync(join(store, standingMark(i)))) { log(`${label(i)}: filmed standing, from a real picture (its line was refused after the move)`); moves[i] = null; }
    if (kind === "active") log(`with exercises — ${moves.map((mv, i) => `${label(i)}: ${mv ? `${moveLabel(mv)}${mv.m.kind === "move" ? ", then the line" : ""}` : "standing"}`).join(" · ")}`);
    // A still for each line: the first from the room, the rest from the first (the same person) and the room. A cut
    // that opens on a move is pictured in its start position; the presenter's own picture is made first all the same.
    const stills = []; let anchor = coach ? coach.refs[0] : null;
    const refsFor = () => (coach ? [...coach.refs, ...(roomPhoto ? [roomPhoto] : [])] : anchor ? [anchor, room] : [room]);
    for (const { i, prompt, only } of [...(moves[0] && !coach ? [{ i: 0, prompt: stillPromptFor(0, presenter, profile), only: true }] : []), ...said.map((_, k) => ({ i: k, prompt: cutStillPrompt(k, presenter, profile, moves[k], kit) }))]) {
      const out = join(store, stillName(i, prompt, room));
      // A coach's talking cut starts from a real frame: it is copied in, and no picture is made.
      if (coach && !moves[i] && !existsSync(out)) copyFileSync(coachFrame(coach, i), out);
      if (!existsSync(out)) {
        if (!within("images", 1)) return { videos: areas.map((area) => ({ area, script_id: script.id, failed: `the cap of ${caps.images} image calls was reached before the presenter's stills were made` })), spent };
        spent.images++; onProgress({ stage: "still", line: i + 1 }); log(`still ${i + 1} of ${said.length}`);
        writeFileSync(out.replace(/\.jpg$/, ".prompt.txt"), prompt + "\n");
        // A picture Google refuses is asked for once more; refused again, nothing is filmed and that is said.
        try { await models.image({ out, prompt, refs: refsFor() }); }
        catch (e) {
          if (!isRefusal(e)) throw e; log(`  still ${i + 1}: refused by Google's image model — asked once more`);
          try { await models.image({ out, prompt, refs: refsFor() }); }
          catch (e2) { if (!isRefusal(e2)) throw e2; return refusedAll(`Google's image model refused the presenter's picture for ${label(i)} twice, under its content rules. Nothing else is lost: Run again asks once more; if it is refused again, change the presenter's look on Ad defaults`); }
        }
      }
      // A re-made picture of a coach is held against the real one: not the same person, or the print changed, and it is made once more (then kept, and the cut's own check and the owner's eye decide).
      if (coach && moves[i] && models.same) {
        const sf = out.replace(/\.jpg$/, ".same.json"); let same = readJson(sf);
        if (!same) { spent.checks++; same = await models.same(coach.refs[0], out); writeFileSync(sf, JSON.stringify(same, null, 2) + "\n"); }
        if (stillFault(same) && !same.again && within("images", 1)) {
          log(`  still ${i + 1}: ${stillWhy(same, coach.name)} — made once more`); spent.images++;
          try { await models.image({ out, prompt, refs: refsFor() }); spent.checks++; same = { ...(await models.same(coach.refs[0], out)), again: true }; } catch (e) { if (!isRefusal(e)) throw e; same = { ...same, again: true }; }
          writeFileSync(sf, JSON.stringify(same, null, 2) + "\n");
        }
        if (stillFault(same)) log(`  still ${i + 1}: ${stillWhy(same, coach.name)} — kept: watch this cut on Pick Ads`);
      }
      anchor ||= out; if (!only) stills.push(out);
    }
    // A clip for each line — once, or once per location when the line says the area.
    const made = new Map(); // "i|area" or "i|" → { file, takes, passed, flagged?, check, line, why, all[] }
    const aside = asideOf(store), filmedNow = new Map(); // what this call filmed: file → seconds
    const takesOn = (name) => readdirSync(store).filter((f) => (f === `${name}.mp4` || (f.startsWith(`${name}-take`) && f.endsWith(".mp4"))) && !aside.has(f)).sort();
    const moveMade = new Map(); // cut → { file, frame, passed, why, kind, all[], judged[] } | null (none could be filmed)
    const moveFor = async (i) => {
      if (moveMade.has(i)) return moveMade.get(i);
      const mv = moves[i], base = moveBase(i, mv, stills[i]), mineM = (f) => f === `${base}.mp4` || f.startsWith(`${base}-take`), limit = takes + [...aside].filter(mineM).length;
      let take = 0, refused = 0; const judged = [];
      while (take < limit && !judged.some((x) => x.passed)) {
        take++; const file = join(store, `${base}${take > 1 ? `-take${take}` : ""}.mp4`), checkFile = file.replace(/\.mp4$/, ".check.json");
        if (aside.has(basename(file))) continue;
        if (!(existsSync(file) && statSync(file).size > 1000)) {
          if (!within("seconds", MOVE_SECONDS)) { take--; break; }
          spent.seconds += MOVE_SECONDS; onProgress({ stage: "clip", line: i + 1, take, move: true }); log(`${label(i)}, the move, take ${take}: ${MOVE_SECONDS} s`);
          const prompt = moveOnlyPrompt({ presenter, move: mv }); writeFileSync(file.replace(/\.mp4$/, ".prompt.txt"), prompt + "\n");
          try { await models.clip({ out: file, image: stills[i], prompt, seconds: MOVE_SECONDS }); filmedNow.set(file, MOVE_SECONDS); }
          catch (e) { if (!isRefusal(e)) throw e; spent.seconds -= MOVE_SECONDS; take--; refused++; log(`  ${basename(file)}: refused by Google's video model under its content rules`); if (refused >= 2) break; continue; }
        }
        let seen = readJson(checkFile); if (!seen) { spent.checks++; seen = normalSeen(await models.watch(file, { move: mv })); writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); }
        if (coach && seen.coach !== true) { seen.coach = true; writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); }
        let j = judgeMove(seen, mv); if (!j.passed && ownerKeptClip(store, file)) j = { ...j, passed: true };
        judged.push({ file, ...j }); log(`  ${basename(file)}: ${j.passed ? `${moveLabel(mv)}, done in silence` : j.why}`);
      }
      const best = judged.find((x) => x.passed) || judged[0] || null; let r = null;
      if (best) { const frame = frameOf(best.file); if (!existsSync(frame)) ff(["-sseof", "-0.25", "-i", best.file, "-update", "1", frame]);
        r = { file: best.file, frame, passed: best.passed, why: best.passed ? null : best.why, kind: best.passed ? null : best.kind, all: judged.map((x) => basename(x.file)), judged: judged.map((x) => ({ file: x.file, passed: x.passed })) }; }
      else log(`  ${label(i)}: the move could not be filmed on its own: the cut is filmed the old way, the move and the line in one clip`);
      moveMade.set(i, r); return r;
    };
    // `early`: the closing cut asked for ahead of the others, only to learn whether Google refuses it — its failed takes
    // are made again, its one optional retake for a small note is not (that waits for its turn, when the cap is known
    // to cover every other line first). An early answer is not kept: the line is judged again, from disk, in its turn.
    const clipFor = async (i, area, early = false) => {
      const perArea = /\{AREA\}/.test(said[i]), key = `${i}|${perArea ? area : ""}`; if (!early && made.has(key)) return made.get(key);
      const mv = moves[i], line = fillLine(said[i], area);
      const say = saidIn(line, saidList), nameFor = (pic) => clipName(i, line, pic, area, perArea, saidNote(say));
      // A move cut is two clips — the move in silence, then the line from the move's last frame — unless a one-clip take of it already passed (that take stands: nothing on file is filmed again).
      const isMove = mv?.m.kind === "move", oneClip = isMove && [stills[i], altOf(stills[i])].some((pic) => takesOn(nameFor(pic)).some((f) => passedCheck(readJson(join(store, f.replace(/\.mp4$/, ".check.json"))), line, profile, say, mv) || !!ownerKeptClip(store, join(store, f))));
      const split = isMove && !oneClip ? await moveFor(i) : null, two = !!split?.file, pic0 = two ? split.frame : stills[i], mvJ = two ? null : mv, seconds = (two ? clipSeconds(line) : cutSeconds(line, mv)) + (linkOnScreen(script) && i === said.length - 1 ? LINK_EXTRA : 0);
      // Takes the owner set aside (Film this line again) are counted and never used: each makes room for a fresh one.
      const mine = (f) => [pic0, altOf(pic0)].some((pic) => f === `${nameFor(pic)}.mp4` || f.startsWith(`${nameFor(pic)}-take`));
      const limit = takes + [...aside].filter(mine).length;
      // The picture this line is filmed from: its own, or — once a clip was refused on that one — the second picture made for it.
      let still = !existsSync(join(store, `${nameFor(pic0)}.mp4`)) && existsSync(altOf(pic0)) ? altOf(pic0) : pic0;
      let take = 0, refused = 0, noteRetake = false, stopped = null; const judged = [];
      // A second picture of the presenter for this line: after two refusals, or when lettering in the picture failed a take.
      const freshPicture = async () => {
        if (two) return "none"; // the line's picture is the move's last frame: another picture would break the shot
        const alt = altOf(pic0);
        // A coach's talking cut: another real frame, where there is one (no picture is made).
        if (coach && !mv) { const other = coach.starts.find((f) => f !== coachFrame(coach, i)); if (!other) return "none"; if (!existsSync(alt)) copyFileSync(other, alt); still = alt; return "ok"; }
        if (!existsSync(alt)) {
          if (!within("images", 1)) return "cap";
          spent.images++; onProgress({ stage: "still", line: i + 1 }); log(`  a fresh picture of the presenter for ${label(i)}`);
          const again = mv ? cutStillPrompt(i, presenter, profile, mv, kit) : stillPrompt({ presenter, profile, spot: SPOTS[i % SPOTS.length], framing: FRAMINGS[(i + 1) % FRAMINGS.length], first: false });
          try { await models.image({ out: alt, prompt: again, refs: coach ? refsFor() : [anchor, room] }); }
          catch (e2) { if (!isRefusal(e2)) throw e2; return "refused"; }
        }
        still = alt; return "ok";
      };
      while (take < limit) {
        // Enough: a clean take; or a take with small notes that has had its one retake (2026-11-15: one automatic
        // retake for notes, the owner's choice — never two). A take kept on the owner's word is not filmed again.
        const ok = judged.filter((t) => t.passed);
        if (ok.some((t) => !t.faults.length || t.kept)) break;
        // A move cut is long (the move, then the line): it is never filmed again for a small note (2026-11-16: 14 s to mend "slight facial distortion", and the retake failed).
        if (ok.length) { if (noteRetake || early || mv?.m.kind === "move") break; noteRetake = true; }
        take++; const name = nameFor(still), file = join(store, `${name}${take > 1 ? `-take${take}` : ""}.mp4`), checkFile = file.replace(/\.mp4$/, ".check.json");
        if (aside.has(basename(file))) continue;
        if (!(existsSync(file) && statSync(file).size > 1000)) {
          if (!within("seconds", seconds)) { stopped = { why: `the cap of ${caps.seconds} seconds of video was reached` }; take--; break; }
          spent.seconds += seconds; onProgress({ stage: "clip", line: i + 1, area: perArea ? area : null, take }); log(`${label(i)}${perArea ? ` (${area})` : ""}, take ${take}: ${seconds} s`);
          const prompt = two ? afterMovePrompt({ presenter, profile, line, seconds, said: say, move: mv }) : mv ? moveClipPrompt({ presenter, profile, line, seconds, said: say, move: mv }) : clipPrompt({ presenter, profile, line, seconds, said: say }); writeFileSync(file.replace(/\.mp4$/, ".prompt.txt"), prompt + "\n");
          try { await models.clip({ out: file, image: still, prompt, seconds }); filmedNow.set(file, seconds); }
          catch (e) {
            // Google refused the request (its content rules): nothing was made, so nothing is counted and it is no take.
            // Asked once more as it is; then on a fresh picture of the presenter; then this video is refused, in words.
            if (!isRefusal(e)) throw e;
            spent.seconds -= seconds; take--; refused++;
            log(`  ${basename(file)}: refused by Google's video model under its content rules${refused === 1 && !ok.length ? " — asked once more" : ""}`);
            if (ok.length) break; // a take already passed: it is kept
            if (refused === 1) continue;
            if (refused === 2 && still === pic0) {
              const got = await freshPicture(); if (got === "ok") continue;
              // A coach's line that Google refuses twice from the frame its move ended on (2026-11-17: a coach's last line after bicep curls, four times running, while the same closing words passed from every real frame): the cut is filmed standing instead, from a real picture of the coach — no picture is made — and stays so on every later run.
              if (got === "none" && two && coach) {
                writeFileSync(join(store, standingMark(i)), JSON.stringify({ on: today(), why: "the line was refused by Google's video model twice from the frame its move ended on", move: moveLabel(mv) }, null, 2) + "\n");
                moves[i] = null; const pic = join(store, stillName(i, cutStillPrompt(i, presenter, profile, null, kit), room)); if (!existsSync(pic)) copyFileSync(coachFrame(coach, i), pic); stills[i] = pic;
                log(`  ${label(i)}: refused twice after the move — filmed standing instead, from a real picture of ${coach.name}`);
                return clipFor(i, area);
              }
              stopped = { refused: true, why: got === "none" ? "refused by Google's video model under its content rules, twice" : got === "cap" ? `refused by Google's video model under its content rules (twice), and the cap of ${caps.images} image calls leaves none for a fresh picture to try it on` : "refused by Google's video model under its content rules (twice), and its image model refused a fresh picture to try it on" }; break;
            }
            stopped = { refused: true, why: `refused by Google's video model under its content rules, ${refused} times and on two pictures of the presenter` }; break;
          }
        }
        // The check on file is judged again by today's rules; one made before lettering said what it is on is watched again (a check call, no filming).
        let seen = readJson(checkFile); if (!seen || staleCheck(seen)) { spent.checks++; seen = normalSeen(await models.watch(file, { said: say, move: mvJ })); if (coach) { seen.coach = true; seen.coach_name = coach.name; } writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); }
        let j = judgeClip(seen, line, { profile, say, move: mvJ });
        // A coach's take that is otherwise right is held against the picture it started from: the same person, the uniform's print and the gym's lettering unchanged.
        if (coach && j.passed && seen.same == null && models.same) { spent.checks++; seen.same = await models.same(still, file); writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); j = judgeClip(seen, line, { profile, say, move: mvJ }); }
        // Refused for its words: listened to once more by its sound alone, before a second is filmed again (a check call against a retake).
        if (!j.passed && j.kind === "words" && seen.heard == null && models.hear) { spent.checks++; seen.heard = await models.hear(file); writeFileSync(checkFile, JSON.stringify(seen, null, 2) + "\n"); j = judgeClip(seen, line, { profile, say, move: mvJ }); if (j.kind !== "words") log(`  ${basename(file)}: heard again by its sound alone, the words are as written`); }
        // The owner's "Use this take anyway": that file, unchanged since, passes on his word.
        if (!j.passed && ownerKeptClip(store, file)) j = { ...j, passed: true, kept: j.why, why: null, kind: null };
        judged.push({ file, take, ...j, check: seen });
        log(`  ${basename(file)}: ${j.kept ? `kept on your word (${j.kept})` : j.passed ? (coach ? `said as written, one person, ${coach.name} and the uniform as they are` : "said as written, one person, no lettering") : j.why}${j.marks.length ? ` · in the room: ${j.marks.join("; ")}` : ""}${j.faults.length ? ` · noted: ${j.faults.join("; ")}${j.passed && !j.kept && !noteRetake && mv?.m.kind !== "move" && take < limit ? " — made once more" : ""}` : ""}`);
        // Lettering that is in the picture itself (a sign, clothing) would be in every take from it: the next take is filmed from a fresh picture. A caption the video model laid over the picture is not the picture's fault.
        if (!j.passed && j.kind === "lettering" && j.lettering.fails.some((x) => x.on !== "overlay") && still === pic0 && take < limit) await freshPicture();
      }
      const ok = judged.filter((t) => t.passed), all = judged.map((t) => basename(t.file));
      let r;
      // Of the takes that passed, the one with the fewest noted faults (the later on a tie).
      if (ok.length) { const best = ok.reduce((b, x) => (x.faults.length <= b.faults.length ? x : b)); r = { file: best.file, takes: take, passed: true, line, check: best.check, marks: best.marks, ...(best.kept ? { kept: best.kept } : {}), all }; }
      // None passed, but there is a take: the one nearest right (the words said as written before anything else) goes
      // into the cut, flagged, for the owner to watch and decide (2026-11-15: "I don't even see the final output").
      else if (judged.length) { const rank = (t) => ({ wall: 0, lettering: 0, uniform: 1, people: 1, move: 2, likeness: 2, words: 3 })[t.kind] ?? 4, best = judged.reduce((b, x) => (rank(x) < rank(b) || (rank(x) === rank(b) && x.faults.length <= b.faults.length) ? x : b)); r = { file: best.file, takes: take, passed: false, flagged: true, kind: best.kind, why: best.why, line, check: best.check, marks: best.marks, all }; }
      else r = { file: null, takes: take, passed: false, line, why: stopped?.why || "no take was made", ...(stopped?.refused ? { refused: true } : {}), all };
      r.seconds = seconds; r.per_area = perArea; r.move = mv; r.judged = judged.map((t) => ({ file: t.file, passed: t.passed }));
      // Two clips: the move's clip rides with the line's; its takes are the cut's takes too (Film this line again sets both aside); a move that was
      // not done flags the cut for the owner, unless he has kept the line's take on his word.
      if (two) { r.moveClip = split; r.seconds = MOVE_SECONDS + seconds; r.all = [...split.all, ...r.all]; r.judged = [...split.judged, ...r.judged];
        if (!split.passed && r.passed && !r.kept) { r.passed = false; r.flagged = true; r.kind = split.kind; r.why = split.why; } }
      if (!early) made.set(key, r); return r;
    };
    const videos = [];
    for (const area of areas) {
      // The closing cut is filmed FIRST (2026-11-22): it is the cut Google's video model refuses (13 of Xinyi's closings,
      // one after another, each after the rest of its video had been filmed). Refused outright, the rest of this video
      // is not filmed now — nothing is spent on a video that cannot be finished until its closing words change.
      const lastCut = said.length - 1, lines = new Array(said.length).fill(null);
      const first = said.length > 1 ? await clipFor(lastCut, area, true) : null;
      if (first && !first.file && first.refused) {
        lines[lastCut] = first;
        const unfilmed = said.slice(0, lastCut).filter((x, i) => !made.has(`${i}|${/\{AREA\}/.test(x) ? area : ""}`)).length;
        videos.push({ area, script_id: script.id, ...who, lines: [lines[lastCut]], refused: true, closing_refused: true, failed: `${label(lastCut)}: ${lines[lastCut].why}. ${unfilmed ? `The other ${unfilmed === 1 ? "cut was" : `${unfilmed} cuts were`} not filmed, so nothing was spent on ${unfilmed === 1 ? "it" : "them"}` : "Nothing else is lost"}: change the closing words (in Chinese, a link to click is shown on screen, not said), then Run again` }); continue;
      }
      for (let i = 0; i <= lastCut; i++) lines[i] = await clipFor(i, area);
      // A line with no take at all (refused by Google, or the cap) leaves nothing to cut: said as what it is, with what to do.
      const none = lines.findIndex((l) => !l.file);
      if (none >= 0) {
        const l = lines[none];
        videos.push({ area, script_id: script.id, ...who, lines, ...(l.refused ? { refused: true } : {}), failed: l.refused ? `${label(none)}: ${l.why}. Nothing else is lost: Run again tries only this cut; if it is refused again, change its words` : `${label(none)}: ${l.why}` }); continue;
      }
      onProgress({ stage: "cut", area });
      const overlays = [], blocks = []; let at = 0;
      const cuts = [], starts = [], seq = [];
      for (const [i, l] of lines.entries()) {
        // A move filmed as its own clip plays first, whole; the line's clip follows from the frame the move ended on.
        const startAt = at; if (l.moveClip) { const md = Math.round(durationOf(l.moveClip.file) * 100) / 100; seq.push({ file: l.moveClip.file, from: 0, to: md }); at += md; }
        // Where he speaks, measured from the sound; the clip is kept from a breath before to a breath after, and the captions follow the voice inside it.
        const sp = speechOf(l.file), from = Math.max(0, sp.start - (l.move?.m.kind === "move" && !l.moveClip ? MOVE_KEEP : LEAD)), to = Math.min(sp.duration, sp.end + (i === lines.length - 1 ? (linkOnScreen(script) ? LINK_HOLD : Math.max(END_HOLD, isZh(l.line || "") ? TAIL_ZH : 0)) : isZh(l.line || "") ? TAIL_ZH : TAIL)); cuts.push({ file: l.file, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 }); seq.push(cuts[i]); l.speech = { start: sp.start, end: sp.end, kept: [cuts[i].from, cuts[i].to] };
        // One picture of the block for each of its words, that word lit while it is said.
        for (const [k, c] of captions(l.line, sp.spans.map(([a, b]) => [at + a - from, at + b - from])).entries()) for (const w of captionWords(c)) {
          if (!(w.to > w.from)) continue;
          const o = await overlay(browser, join(dir, `cap-${slug(area)}-${i + 1}-${String(k).padStart(2, "0")}-${w.i}.png`), capHtml(c.text, w.i), captionAccentOf(profile) || CAPTION_ACCENT, !!coach); overlays.push({ png: o.png, from: w.from, to: w.to }); if (w.i === 0) blocks.push(...o.blocks);
        }
        // The link shown once the voice ends (fallback A, `link_on_screen`), in the captions' place.
        if (linkOnScreen(script) && i === lines.length - 1) { const o = await overlay(browser, join(dir, `cap-${slug(area)}-${i + 1}-link.png`), `<div class="cap zh"><b>${esc(LINK_TEXT_ZH)}</b></div>`, captionAccentOf(profile) || CAPTION_ACCENT, !!coach); overlays.push({ png: o.png, from: Math.round((at + sp.end - cuts[i].from + 0.1) * 100) / 100, to: Math.round((at + cuts[i].to - cuts[i].from) * 100) / 100 }); blocks.push(...o.blocks); }
        starts.push(Math.round(startAt * 100) / 100); at += cuts[i].to - cuts[i].from;
      }
      const outside = blocks.filter((b) => !inLive(b));
      if (outside.length) { videos.push({ area, script_id: script.id, ...who, lines, failed: `the words do not fit Meta's live area: "${outside[0].text}"` }); continue; }
      const file = assemble({ clips: seq, overlays, out: join(outDir, `${script.id}${coach ? `--${coach.key}` : ""}-${slug(area)}.mp4`) });
      const poster = file.replace(/\.mp4$/, ".jpg"); ff(["-ss", "0.8", "-i", file, "-frames:v", "1", "-q:v", "3", poster]);
      // Every line of the cut, for the owner's screen: where it starts, the take in it, the takes on file, what a fresh take costs, a word to listen for, and — where no take passed — why.
      const parts = lines.map((l, i) => ({ line: i + 1, label: label(i), text: l.line, clip: basename(l.file), takes: l.all, seconds: l.seconds, at: starts[i], ...(l.move ? { move: moveLabel(l.move) } : {}), ...(l.per_area ? { per_area: true } : {}), ...(saidIn(l.line, saidList).length ? { listen: saidIn(l.line, saidList).map((x) => ({ word: x.word, say: x.say })) } : {}), ...(l.kept ? { kept: l.kept } : {}), ...(l.passed ? {} : { flag: { why: l.why, kind: l.kind } }) }));
      const flags = parts.filter((p) => p.flag).map((p) => ({ line: p.line, label: p.label, why: p.flag.why, kind: p.flag.kind }));
      videos.push({ area, script_id: script.id, kind, ...who, ...(kind === "active" ? { moves: parts.filter((p) => p.move).map((p) => ({ line: p.line, move: p.move })) } : {}), style: script.style?.name || null, pain: script.pain || null, file, poster, seconds: Math.round(durationOf(file) * 10) / 10, lines, words: lines.map((l) => l.line), parts, ...(flags.length ? { flags } : {}),
        notes: [...new Set([...lines.flatMap((l) => l.check?.faults || []), ...lines.flatMap((l) => l.marks || []), ...parts.filter((p) => p.kept).map((p) => `${p.label} kept on your word (${p.kept})`)])] });
    }
    // What this call filmed, and what became of it: in a video, replaced by a retake, failed its check, or waiting on a video that could not be cut.
    const inCut = new Set(videos.filter((v) => v.file).flatMap((v) => v.lines.flatMap((l) => [l.file, l.moveClip?.file]))), state = new Map([...made.values()].flatMap((r) => r.judged.map((t) => [t.file, t.passed]))), chosen = new Set([...made.values()].flatMap((r) => [r.file, r.moveClip?.file]));
    const tally = { filmed: 0, in_videos: 0, replaced: 0, failed: 0, waiting: 0 };
    for (const [f, s] of filmedNow) { tally.filmed += s; tally[inCut.has(f) ? "in_videos" : chosen.has(f) ? "waiting" : state.get(f) ? "replaced" : "failed"] += s; }
    return { videos, spent, tally };
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
