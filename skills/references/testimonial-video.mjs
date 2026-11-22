/**
 * Testimonial videos with copy of their own (2026-11-22, the owner: "I have 7 testimonial videos that I want to
 * integrate into a batch of static creatives … I want the agent to be able to read and understand what's actually
 * going on in the testimonial videos, draft 5 copies and 5 headlines that are super relevant to the video, but also
 * fit with the offer that the ad set is offering. It should be uploaded with the rest of the batch").
 *
 *   node skills/references/testimonial-video.mjs --brand-dir brands/{gym} --batch id (--read | --draft [--only t-…] | --show)
 *
 * A testimonial is a finished video of a real member (or a coach about a member), added AS IT IS by footage-video.mjs
 * (`video.kind: "testimonial"`, `video.id`: "t-" + the file's content hash, so it is the same video wherever its ad
 * goes — into a merged batch, under another folder number).
 *
 * READING (`readTestimonials`, the owner's click; three small calls a video, nothing generated): the sound track heard
 * word for word; eight frames looked at (who is on screen, every word laid over the picture, whether before-and-after
 * pictures are shown); then one text call that says what the video IS — who speaks, what they struggled with, what
 * changed, what they liked, short quotes in their exact words, and any weight or size figure it states or shows. The
 * reading is kept in the batch (`testimonials.json`) and is the owner's to correct.
 *
 * WHAT HE DECIDES (`decideOf`): a video that states a weight figure or shows before-and-after is flagged on its ad
 * (`video.decide`) and counts as kept only once he presses Keep himself — his ruling: "Flag and let me decide". The
 * copy never repeats such a figure, whatever the video says.
 *
 * COPY OF ITS OWN (`draftTestimonialCopy`): five copies and five headlines for each video, drafted from that video's
 * reading and tied to the batch's offer in its exact words and its area. Checked in code before he sees one: the
 * copy's own rules (draft-copy.mjs: the offer named exactly, no price, no free trial, no guarantee, no before-and-after,
 * the gym's never-list and wording), NO weight or size figure at all, a quote only in the person's exact words (found
 * in what was heard), a name only when the video itself gives it; then one text call judges every draft against what
 * was said — a claim the person did not make drops the draft. The drafts sit in the batch's copy.json marked
 * `for: <video id>`; the ones he keeps are that ad's own text options on Meta (meta-publish.mjs), and an ad with none
 * kept takes the batch's shared copy.
 *
 * Consent: a testimonial shows a real person, so the owner's word that they agreed to appear in an advert is recorded
 * on the video when it is added (`video.consent`), as it is for a coach.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { callVision } from "./check-visual.mjs";
import { COPY_MODEL, readCopy, copyProblems, copyRules, plainDashes, gymLanguage, ctaLabel, buttonPlaceholder, areaPlaceholder, LIMITS, kindOf, needsLayout, relayoutCopies } from "./draft-copy.mjs";
import { nameInAds, wordingRule, titleCase, countryRules } from "./client-config.mjs";

export const TESTIMONIAL = "testimonial";             // ad.video.kind
export const TESTIMONIALS_FILE = "testimonials.json"; // in the batch's outputs folder
export const PER_VIDEO = 5;                           // copies, and headlines, drafted for each video
export const USD_PER_VIDEO = 0.03;                    // an estimate: three small calls to read one

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const today = () => new Date().toISOString().slice(0, 10);
/** A video's id: the same wherever its ad goes. */
export const videoId = (file) => `t-${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10)}`;

/** A weight or size figure, as a testimonial states it: "73KG", "8 kg", "16.2KG", "28 kilos", "12 lbs", "2 dress sizes", "10 cm", "5% body fat". */
export const FIGURE = /\d+(?:\.\d+)?\s?(?:kg|kgs|kilos?|kilograms?|lbs?|pounds?|stone|cm|inch(?:es)?|dress sizes?|sizes? (?:down|smaller)|% ?body ?fat|公斤|斤|公分|吋)\b|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:kg|kilos?|pounds?|dress sizes?)\b/i;
/** A swear word (a member says what they say; an advert's words do not repeat it), and a medical condition (Meta's rules on health; the copy's "no medical claim"). */
export const SWEAR = /\b(?:fuck\w*|shit\w*|damn|bloody hell|bitch\w*|ass(?:hole)?)\b/i;
export const MEDICAL = /\b(?:gastric|diastasis(?: recti)?|diabet\w+|cholesterol|blood pressure|hypertension|pcos|thyroid|arthritis|depress\w+|anxiety disorder)\b/i;
export const figuresIn = (text) => [...new Set((String(text ?? "").match(new RegExp(FIGURE.source, "gi")) || []).map(norm))];

// ── the readings ─────────────────────────────────────────────────────────────
export const readReadings = (batchDir) => { const j = readJson(join(batchDir, TESTIMONIALS_FILE)); return { videos: j?.videos && typeof j.videos === "object" ? j.videos : {} }; };
const writeReadings = (batchDir, data) => writeWhole(join(batchDir, TESTIMONIALS_FILE), JSON.stringify(data, null, 2) + "\n");
/** The testimonial ads of a batch: [{ id, folder, file (absolute), title, seconds }], one for each video (its first location's ad). */
export function testimonialAds(batchDir) {
  const batch = readJson(join(batchDir, "batch.json")), seen = new Set(), out = [];
  for (const a of batch?.ads || []) if (a.video?.kind === TESTIMONIAL && a.video.id && !seen.has(a.video.id)) { seen.add(a.video.id); out.push({ id: a.video.id, folder: a.folder, file: join(batchDir, a.video_file), title: a.video.title || null, seconds: a.video.seconds ?? null }); }
  return out;
}

const LOOK_SCHEMA = { type: "OBJECT", properties: { people: { type: "INTEGER" }, who: { type: "STRING" }, setting: { type: "STRING" }, on_screen_text: { type: "ARRAY", items: { type: "STRING" } }, before_after: { type: "BOOLEAN" }, before_after_what: { type: "STRING" }, shows: { type: "STRING" } }, required: ["people", "who", "setting", "on_screen_text", "before_after", "shows"] };
const LOOK_Q = "These are frames of one short video, in order, laid side by side on one sheet. It is a testimonial for a gym: a member, or a coach with a member, talking about the member's time there. Do not name or guess who anyone is. people: how many different people appear in all. who: who is on screen in plain words (\"a woman in her thirties talking to the camera, seated\"; \"a coach and a member standing side by side\"). setting: where it is filmed, in a few words. on_screen_text: every piece of text laid over the picture — captions, titles, numbers, labels — each exactly as written, in order, one entry for each; an empty list when there is none. before_after: true only when the video shows before-and-after pictures of a body — two photos or clips of the same person at different times, side by side or one after the other, as a comparison; false for someone simply talking. before_after_what: when true, what is shown, in a few words; else an empty string. shows: one sentence on what the video shows overall.";
const UNDERSTAND_SCHEMA = { type: "OBJECT", properties: {
  speaker: { type: "STRING" }, name: { type: "STRING" }, summary: { type: "STRING" },
  struggle: { type: "ARRAY", items: { type: "STRING" } }, change: { type: "ARRAY", items: { type: "STRING" } }, liked: { type: "ARRAY", items: { type: "STRING" } },
  quotes: { type: "ARRAY", items: { type: "STRING" } }, figures: { type: "ARRAY", items: { type: "STRING" } }, language: { type: "STRING" } },
  required: ["speaker", "name", "summary", "struggle", "change", "liked", "quotes", "figures", "language"] };
export function buildUnderstandPrompt({ transcript, look, title }) {
  return { schema: UNDERSTAND_SCHEMA, prompt: [
    "Below is everything said in a short testimonial video for a gym, word for word, with what is seen in it. Say what the video IS, from what is said and shown and from nothing else. Do not add, soften or improve anything; where something is not said, leave it out.",
    `WHAT IS SAID, in order:\n${transcript || "(nobody speaks)"}`,
    `WHAT IS SEEN: ${norm(look?.who)}. ${norm(look?.shows)}${(look?.on_screen_text || []).length ? `\nTEXT ON THE PICTURE: ${look.on_screen_text.map((t) => `"${norm(t)}"`).join(" · ")}` : ""}`,
    title ? `THE GYM'S OWN CAPTION for this video when it was posted (it may be cut short): "${norm(title)}"` : "",
    "Answer — speaker: who is talking, in plain words and without a name (\"a member, a mother, speaking for herself\"; \"a coach talking about a member\"). name: the member's first name only when it is said in the video, written on the picture or in the gym's caption; else an empty string. summary: two sentences on the story the video tells. struggle: what the person was dealing with before, each a short phrase close to their own words (2 to 5). change: what is different now — what they feel, can do or have learnt — each a short phrase close to their own words (2 to 5), with NO weight, size or percentage figure in any of them. liked: what they say they liked about training here (the coaches, the plan, the people), each a short phrase (0 to 4). quotes: 3 to 6 short quotes, each 4 to 18 words, copied EXACTLY from what is said — the lines that carry the story; never one with a weight or size figure in it. figures: every weight, size or percentage figure the video states or shows, each exactly as given (\"73KG → 65KG\", \"28KG down\"); an empty list when there is none. language: the language spoken, as a word (\"English\").",
  ].filter(Boolean).join("\n\n") };
}

/** The real calls: a video's sound heard, its frames looked at, the text call. The tests pass their own. */
export async function testimonialModels() {
  const { editorModels } = await import("./footage-editor.mjs"), E = await editorModels();
  return { listen: E.listen, look: (sheet) => callVision(sheet, LOOK_Q, LOOK_SCHEMA), ask: (prompt, schema) => callVision(null, prompt, schema, { model: COPY_MODEL }) };
}
/** Eight frames of a video on one sheet (ffmpeg), for the look. */
export function frameSheet(file, out, seconds) {
  mkdirSync(join(out, ".."), { recursive: true });
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `fps=${8 / Math.max(1, seconds || 1)},scale=-2:480,tile=8x1`, "-frames:v", "1", "-q:v", "4", out]);
  return existsSync(out) ? out : null;
}
/** What the owner decides before a video is kept: [{ kind: "figure" | "before_after", text }]. */
export function decideOf(reading) {
  const out = [], figs = [...new Set([...(reading?.figures || []), ...figuresIn((reading?.on_screen_text || []).join(" · ")), ...figuresIn(reading?.transcript)].map(norm).filter(Boolean))];
  if (figs.length) out.push({ kind: "figure", text: `it states a weight or size figure (${figs.slice(0, 4).join(", ")}). Meta restricts adverts that promise or imply a weight-loss result; the copy beside it never repeats the figure` });
  const sw = String(reading?.transcript || "").match(SWEAR);
  if (sw) out.push({ kind: "swear", text: `someone swears in it ("${sw[0]}"). Meta does not allow profanity in adverts` });
  if (reading?.before_after) out.push({ kind: "before_after", text: `it shows before-and-after pictures${reading.before_after_what ? ` (${norm(reading.before_after_what)})` : ""}. Meta does not allow before-and-after pictures in adverts, and your own rule has been none` });
  return out;
}
/** One video read. Returns its reading; throws in words when it has no sound or the calls give nothing. */
export async function readOne(file, { models, title = null, sheetDir = tmpdir() }) {
  const heard = await models.listen(file);
  const phrases = (heard?.phrases || []).filter((p) => norm(p.text)).map((p) => ({ text: norm(p.text), start: Number(p.start) || 0 }));
  const transcript = phrases.map((p) => p.text).join(" ");
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim()) || 0;
  const sheet = frameSheet(file, join(sheetDir, `testimonial-${createHash("sha1").update(file).digest("hex").slice(0, 10)}.jpg`), seconds);
  const look = sheet ? await models.look(sheet) : {};
  const u = buildUnderstandPrompt({ transcript, look, title }), said = await models.ask(u.prompt, u.schema);
  const list = (xs, max) => (Array.isArray(xs) ? xs.map(norm).filter(Boolean).slice(0, max) : []);
  // A quote is the person's own words: one that is not found in what was heard is dropped here, in code.
  const quotes = list(said?.quotes, 6).filter((q) => saidIn(q, transcript) && !FIGURE.test(q));
  const reading = { read_on: today(), seconds: Math.round(seconds * 10) / 10, transcript, music: heard?.music === true,
    people: Number.isInteger(look?.people) ? look.people : null, who: norm(look?.who), setting: norm(look?.setting), shows: norm(look?.shows), on_screen_text: list(look?.on_screen_text, 40), before_after: look?.before_after === true, before_after_what: norm(look?.before_after_what),
    speaker: norm(said?.speaker), name: norm(said?.name).split(" ")[0] || "", summary: norm(said?.summary), struggle: list(said?.struggle, 5), change: list(said?.change, 5).filter((c) => !FIGURE.test(c)), liked: list(said?.liked, 4), quotes, figures: list(said?.figures, 8), language: norm(said?.language) || "English" };
  if (!reading.transcript && !reading.on_screen_text.length) throw new Error("nothing is said or written in this video: there is nothing to draft copy from");
  return reading;
}
/** Words as they compare: letters and digits, case aside. */
const bare = (t) => String(t ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9'㐀-鿿]+/g, " ").trim();
export const saidIn = (quote, transcript) => { const q = bare(quote); return q.length >= 8 && bare(transcript).includes(q); };

/**
 * Read every testimonial of a batch that has no reading yet (`again`: all of them). Saved video by video, so a stop
 * keeps what is read. Each ad of a read video gets `video.decide` (what the owner decides before it is kept) and
 * `video.summary`. Returns { read[], left, calls }.
 */
export async function readTestimonials({ batchDir, models = null, again = false, only = null, log = () => {} }) {
  const dir = resolve(batchDir), M = models || (await testimonialModels()), data = readReadings(dir), ads = testimonialAds(dir).filter((a) => !only || only.includes(a.id));
  const done = []; let calls = 0;
  for (const a of ads) {
    if (data.videos[a.id]?.reading && !again) continue;
    log(`${a.folder}: listening and looking (${a.seconds ?? "?"} s) …`);
    try {
      const reading = await readOne(a.file, { models: M, title: a.title, sheetDir: join(dir, ".testimonial-frames") }); calls += 3;
      data.videos[a.id] = { id: a.id, title: a.title, ...(data.videos[a.id]?.corrected ? { corrected: data.videos[a.id].corrected } : {}), reading };
      writeReadings(dir, data); done.push(a.id);
      const d = decideOf(reading);
      log(`  ${reading.speaker || "someone"}${reading.name ? ` (${reading.name})` : ""}: ${reading.summary}${d.length ? ` · for you to decide: ${d.map((x) => x.kind === "figure" ? "a weight figure" : "before-and-after").join(", ")}` : ""}`);
    } catch (e) { data.videos[a.id] = { id: a.id, title: a.title, error: String(e.message).slice(0, 300) }; writeReadings(dir, data); log(`  could not be read: ${e.message}`); }
  }
  stampAds(dir);
  return { read: done, left: testimonialAds(dir).filter((a) => !readReadings(dir).videos[a.id]?.reading).length, calls };
}
/** What each testimonial ad says of its video, from the readings: the summary, and what the owner decides. */
export function stampAds(batchDir) {
  const p = join(batchDir, "batch.json"), batch = readJson(p), data = readReadings(batchDir); if (!batch) return 0;
  let n = 0;
  for (const a of batch.ads) { const r = a.video?.kind === TESTIMONIAL ? data.videos[a.video.id]?.reading : null; if (!r) continue; a.video.summary = r.summary; a.video.decide = decideOf(r); a.video.words = r.transcript ? [r.transcript] : a.video.words || []; n++; }
  if (n) writeWhole(p, JSON.stringify(batch, null, 2) + "\n");
  return n;
}

// ── the copy ─────────────────────────────────────────────────────────────────
const DRAFT_SCHEMA = { type: "OBJECT", properties: {
  copies: { type: "ARRAY", items: { type: "OBJECT", properties: { message: { type: "STRING" }, angle: { type: "STRING" } }, required: ["message", "angle"] } },
  headlines: { type: "ARRAY", items: { type: "OBJECT", properties: { headline: { type: "STRING" }, description: { type: "STRING" } }, required: ["headline", "description"] } } }, required: ["copies", "headlines"] };
export function buildCopyPrompt({ profile = {}, reading, offer, area, audience = null, button = "Sign up", count = PER_VIDEO, refused = [], existing = [] }) {
  const gym = nameInAds(profile), rules = copyRules(profile), zh = gymLanguage(profile) === "zh", house = wordingRule(profile);
  const R = reading, name = R.name ? `"${R.name}" (the video itself gives it: it may be used)` : "not given in the video: write \"one of our members\", \"she\" or \"he\" as the video shows, never a made-up name";
  return { schema: DRAFT_SCHEMA, prompt: [
    `You write the words beside ONE video advert for ${gym} on Facebook and Instagram. The video is a testimonial: a real member's story, told in the video. The advert is for the gym's programme "${offer}"${audience ? `, for ${audience}` : ""}, and the person reading lives or works near ${titleCase(area)}.`,
    `THE JOB: ${count} primary texts and ${count} headlines that are about THIS video — its story, its person, their words — and that lead the reader from that story to the programme. Someone who reads the words and then watches the video must feel they belong together. Each of the ${count} takes a different way in (the struggle they came with; a line they say; what changed for them; who this is for; a question the reader is asking themselves).`,
    `WHAT THE VIDEO IS — use this and nothing else about the person:\nWho speaks: ${R.speaker || "a member"}. Name: ${name}.\nThe story: ${R.summary}\nWhat they struggled with: ${R.struggle.join("; ") || "(not said)"}\nWhat changed: ${R.change.join("; ") || "(not said)"}\nWhat they liked here: ${R.liked.join("; ") || "(not said)"}\nTheir exact words (the only quotes allowed, written in double quotation marks exactly as here):\n${R.quotes.filter((q) => !SWEAR.test(q) && !MEDICAL.test(q)).map((q) => `- "${q}"`).join("\n") || "- (none)"}`,
    `EVERYTHING SAID IN THE VIDEO, for you to check yourself against:\n${R.transcript}`,
    `THE RULES.
- Every primary text names the programme in these exact words: "${offer}". It is what the reader can join; say so plainly near the end, and where the call to action names the button write the placeholder {BUTTON} (the button says "${button}").
- Where the place is named, write the placeholder {AREA}, never the area's name and never the country.
- TRUE TO THE VIDEO: state nothing about the person that the video does not say. No detail added (never "busy", "for years", "every day", "after long days" unless it is said), no feeling or reason they did not give, no result made bigger. A quote is in double quotation marks and is copied exactly from the list above; outside quotation marks, say it in your own plain words.
- KEEP THE PERSON'S PART SMALL AND EXACT: two or three statements about the person at most, each one taken from the lists above. Everything else in the text is about the reader's own situation, the programme and the invitation — those need nothing from the video. When the video says little, write a shorter text rather than fill it out.
- NO FIGURES: never a weight, a size, a percentage or a number of kilos, whatever the video says or shows. Say what changed in the person's life instead (their energy, their confidence, what they can do, what they have learnt).
- NO PROMISE to the reader: never say or suggest they will get the same result, never "you will", "guaranteed", "results in N weeks". The story is this person's; the offer is a way to start.
- Never speak about the reader's body, weight or health as if you knew it ("are you overweight", "your belly"): speak about the situation ("a messy work schedule", "not knowing where to start").
- Never name a coach: say "the coach" or "our coach".
- NEVER: a price or any money; free or a trial; before and after; a guarantee; a medical claim or the name of any medical condition, even one the video mentions (say "her worries as a mother", never the condition); a swear word; an em dash or en dash (use a plain hyphen); an emoji in a headline; any of: ${rules.never.join("; ")}.
- LAYOUT of a primary text: ${zh ? "60 to 260 characters" : "35 to 130 words"}, short paragraphs with an empty line between them, the first line a hook that stops the scroll. ${countryRules(profile?.locale?.country).tone || "Plain English."}
- A headline is one line, under ${LIMITS.headline_ideal} characters; its description is under ${LIMITS.description_ideal} characters or empty.`,
    zh ? "LANGUAGE: Traditional Chinese as written in Taiwan (zh-TW), full-width punctuation, never simplified characters; the placeholders {AREA} and {BUTTON} stay exactly as written." : "",
    house,
    existing.length ? `ALREADY WRITTEN for this video (write something different):\n${existing.map((e) => `- ${e}`).join("\n")}` : "",
    refused.length ? `THESE WERE REFUSED — do not make the same mistake:\n${refused.map((r) => `- ${r}`).join("\n")}` : "",
    `Answer with ${count} copies (message, and its angle in a word or two) and ${count} headlines (headline, description).`,
  ].filter(Boolean).join("\n\n") };
}
/** What a draft for a testimonial breaks beyond the copy's own rules: a figure, a quote the person did not say, a name the video does not give. */
export function testimonialProblems(d, reading) {
  const all = `${d.message || ""} ${d.headline || ""} ${d.description || ""}`, errs = [];
  const fig = all.match(FIGURE); if (fig) errs.push(`a weight or size figure ("${norm(fig[0])}"): the copy never repeats one`);
  for (const m of all.matchAll(/[“"]([^“”"]{8,200})[”"]/g)) if (!saidIn(m[1], reading.transcript)) errs.push(`a quote the person does not say in the video ("${norm(m[1]).slice(0, 60)}")`);
  if (/\b(you will|you'll) (lose|drop|shed|get|see|look|have)\b|\bguarantee|\bresults? in \d+/i.test(all)) errs.push("a promise to the reader of the same result");
  const coach = all.match(/\b[Cc]oach\s+(?!Society\b)[A-Z][a-z]{2,}/); if (coach) errs.push(`a coach's name ("${coach[0]}"): it is only ever heard, so it may be misspelt — say "the coach"`);
  const sw = all.match(SWEAR); if (sw) errs.push(`a swear word ("${sw[0]}")`);
  const med = all.match(MEDICAL); if (med) errs.push(`a medical condition ("${med[0]}"): the copy makes no health claim`);
  return errs;
}
const SUPPORT_SCHEMA = { type: "OBJECT", properties: { drafts: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, supported: { type: "BOOLEAN" }, unsupported: { type: "STRING" } }, required: ["id", "supported", "unsupported"] } } }, required: ["drafts"] };
export const buildSupportPrompt = ({ reading, drafts, title = null }) => ({ schema: SUPPORT_SCHEMA, prompt: [
  "Each numbered text below is written to run beside a testimonial video. Check each one against what is actually said and shown in the video. A text is supported when everything it states about THE PERSON in the video — who they are, what they struggled with, what changed, what they said — is said or shown in the video. General statements about the gym's programme, an invitation to join, and plain words for something the person did say are fine. A text is NOT supported when it adds a fact about the person, makes their result bigger or more certain than they say, or puts words in their mouth.",
  `WHAT IS SAID IN THE VIDEO:\n${reading.transcript}`,
  (reading.on_screen_text || []).length ? `TEXT ON THE PICTURE: ${reading.on_screen_text.map((t) => `"${t}"`).join(" · ")}` : "",
  // The gym's own caption is the gym's word about the person: what it says of them is supported too (2026-11-22: "not one excuse" is the caption's, and drafts that said so were dropped).
  title ? `THE GYM'S OWN CAPTION for this video (the gym's word about the person: what it states counts as shown): "${norm(title)}"` : "",
  `THE TEXTS:\n${drafts.map((d, i) => `${i + 1}. ${d.message || d.headline}${d.description ? ` — ${d.description}` : ""}`).join("\n\n")}`,
  'Answer for every text: its id as its number ("3"), supported true or false, and for one that is not, the unsupported statement quoted in a few words (an empty string otherwise).',
].filter(Boolean).join("\n\n") });

const idOf = (d, key) => createHash("sha1").update(`${key}|${d.message}|${d.headline}|${d.description}`).digest("hex").slice(0, 10);
const cleanText = (t, max, locations) => areaPlaceholder(buttonPlaceholder(plainDashes(String(t ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())), locations).slice(0, max);
/** A video's own drafts in the batch's copy file. */
export const draftsFor = (batchDir, key) => readCopy(batchDir).drafts.filter((d) => d.for === key);

/**
 * Draft copy for a batch's testimonial videos: `count` copies and `count` headlines for each video that is read and
 * has fewer open drafts than that (`only`: these video ids). One text call a round (two rounds at most) and one
 * support check a video. Drafts are appended to copy.json as `status: "draft"`, `for: <video id>`. Returns
 * { videos: [{ id, added, dropped[] }], calls }.
 */
export async function draftTestimonialCopy({ brandDir, batchDir, only = null, count = PER_VIDEO, ask = null, log = () => {} }) {
  const dir = resolve(batchDir), profile = readJson(join(resolve(brandDir), "gym-profile.json")) || {}, brief = readJson(join(resolve(brandDir), "batches", basename(dir), "brief.json")) || {}, batch = readJson(join(dir, "batch.json"));
  const offer = norm(brief.offer || batch?.ads?.[0]?.words?.offer), locations = brief.locations?.length ? brief.locations : [...new Set((batch?.ads || []).map((a) => a.location))];
  if (!offer) throw new Error("the batch names no offer: the copy is written for an offer's exact words");
  const A = ask || ((prompt, schema) => callVision(null, prompt, schema, { model: COPY_MODEL })), readings = readReadings(dir).videos, rules = copyRules(profile);
  const cta = (readJson(join(dir, "publish-settings.json")) || {}).words?.cta, button = ctaLabel(cta || "SIGN_UP", gymLanguage(profile));
  const out = []; let calls = 0;
  for (const v of testimonialAds(dir).filter((a) => !only || only.includes(a.id))) {
    const reading = readings[v.id]?.reading; if (!reading) { out.push({ id: v.id, added: 0, dropped: [], why: "not read yet" }); continue; }
    const open = (kind) => draftsFor(dir, v.id).filter((d) => kindOf(d) === kind && d.status !== "exclude");
    const added = [], dropped = [];
    for (let round = 0; round < 2; round++) {
      const need = { copy: count - open("copy").length, headline: count - open("headline").length };
      if (need.copy <= 0 && need.headline <= 0) break;
      const { prompt, schema } = buildCopyPrompt({ profile, reading, offer, area: locations[0] || "", audience: brief.audience || null, button, count: Math.max(need.copy, need.headline, 1), existing: draftsFor(dir, v.id).map((d) => (d.message || d.headline).split("\n")[0].slice(0, 90)), refused: dropped.map((d) => `"${d.text.slice(0, 80)}" — ${d.reason}`).slice(0, 6) });
      const answer = await A(prompt, schema); calls++;
      const fresh = [
        ...(answer?.copies || []).slice(0, Math.max(0, need.copy)).map((c) => ({ kind: "copy", message: cleanText(c.message, LIMITS.message, locations), headline: "", description: "", angle: norm(c.angle).slice(0, 40) })),
        ...(answer?.headlines || []).slice(0, Math.max(0, need.headline)).map((h) => ({ kind: "headline", message: "", headline: cleanText(h.headline, LIMITS.headline, locations).replace(/\n+/g, " "), description: cleanText(h.description, LIMITS.description, locations).replace(/\n+/g, " ") })),
      ];
      const pass = [];
      for (const d of fresh) {
        const errs = [...copyProblems(d, { offer, rules, kind: d.kind }), ...testimonialProblems(d, reading)];
        if (errs.length) { dropped.push({ text: d.message || d.headline, reason: errs.join("; ") }); continue; }
        pass.push(d);
      }
      // Every draft against what was said: a claim the person did not make drops it.
      if (pass.length) {
        const s = buildSupportPrompt({ reading, drafts: pass, title: v.title }), judged = await A(s.prompt, s.schema); calls++;
        const bad = new Map((judged?.drafts || []).filter((x) => x.supported === false).map((x) => [String(x.id), norm(x.unsupported)]));
        const data = readCopy(dir), now = new Date().toISOString();
        pass.forEach((d, i) => {
          if (bad.has(String(i + 1))) { dropped.push({ text: d.message || d.headline, reason: `says something the video does not: ${bad.get(String(i + 1)) || "an unsupported statement"}` }); return; }
          const id = idOf(d, v.id); if (data.drafts.some((x) => x.id === id)) return;
          const row = { id, kind: d.kind, message: d.message, headline: d.headline, description: d.description, status: "draft", source: "testimonial", for: v.id, ...(d.angle ? { angle: d.angle } : {}), drafted: now };
          data.drafts.push(row); added.push(row);
        });
        writeWhole(join(dir, "copy.json"), JSON.stringify(data, null, 2) + "\n");
      }
    }
    // A primary text that came as one block gets its line breaks, as the batch's own copies do (draft-copy.mjs): only the spacing changes, never a word.
    if (added.some((d) => d.kind === "copy" && needsLayout(d.message))) { const L = await relayoutCopies(dir, { ask: async (_img, prompt, schema) => A(prompt, schema) }); calls += L.calls; }
    for (const d of dropped) log(`  ${v.id} dropped: ${d.reason}`);
    log(`${v.id}${reading.name ? ` (${reading.name})` : ""}: ${added.filter((d) => d.kind === "copy").length} copies and ${added.filter((d) => d.kind === "headline").length} headlines drafted${dropped.length ? `, ${dropped.length} dropped` : ""}`);
    out.push({ id: v.id, added: added.length, dropped });
  }
  return { videos: out, calls };
}

/**
 * The member's name as the owner spells it: a name is heard, and captions on the picture may spell it another way. The
 * reading, its quotes and every draft of that video take the new spelling (a kept draft stays kept). An empty name
 * takes the name out of the reading; the drafts that use it are then the owner's to edit. Returns { changed }.
 */
export function correctName(batchDir, id, name) {
  const data = readReadings(batchDir), r = data.videos[id]?.reading, to = norm(name);
  if (!r) throw new Error("that video has not been read");
  if (to && !/^[A-Za-z\u00c0-\u024f\u3400-\u9fff][A-Za-z\u00c0-\u024f\u3400-\u9fff' -]{0,39}$/.test(to)) throw new Error("a first name, up to 40 letters");
  const was = r.name; let changed = 0;
  if (was && to && was !== to) {
    const re = new RegExp(`(?<![A-Za-z])${was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "g"), sw = (t) => String(t ?? "").replace(re, to);
    for (const k of ["transcript", "summary", "speaker"]) r[k] = sw(r[k]);
    for (const k of ["quotes", "struggle", "change", "liked"]) r[k] = (r[k] || []).map(sw);
    const copy = readCopy(batchDir);
    for (const d of copy.drafts) if (d.for === id) { const next = { message: sw(d.message), headline: sw(d.headline), description: sw(d.description) }; if (next.message !== d.message || next.headline !== d.headline || next.description !== d.description) { Object.assign(d, next); changed++; } }
    if (changed) writeWhole(join(batchDir, "copy.json"), JSON.stringify(copy, null, 2) + "\n");
  }
  r.name = to; data.videos[id].corrected = { name: to, was, on: today() };
  writeReadings(batchDir, data); stampAds(batchDir);
  return { changed };
}

/** What Publish Ads shows for a batch's testimonials: each video with its reading, what is for the owner to decide, and its own drafts. */
export function testimonialsView(batchDir) {
  const readings = readReadings(batchDir).videos, drafts = readCopy(batchDir).drafts;
  return testimonialAds(batchDir).map((a) => { const r = readings[a.id]?.reading || null, mine = drafts.filter((d) => d.for === a.id);
    return { id: a.id, folder: a.folder, title: a.title, seconds: a.seconds, read: !!r, error: readings[a.id]?.error || null,
      reading: r ? { speaker: r.speaker, name: r.name, summary: r.summary, struggle: r.struggle, change: r.change, liked: r.liked, quotes: r.quotes, figures: r.figures, before_after: r.before_after, transcript: r.transcript } : null,
      decide: r ? decideOf(r) : [], drafts: mine.length, kept: { copy: mine.filter((d) => d.status === "keep" && kindOf(d) === "copy").length, headline: mine.filter((d) => d.status === "keep" && kindOf(d) === "headline").length } }; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, batch: { type: "string" }, read: { type: "boolean" }, again: { type: "boolean" }, draft: { type: "boolean" }, only: { type: "string" }, name: { type: "string" }, show: { type: "boolean" } } });
  if (!v["brand-dir"] || !v.batch) { console.error("usage: testimonial-video.mjs --brand-dir brands/{gym} --batch id (--read [--again] | --draft [--only t-…] | --show)"); process.exit(2); }
  const brandDir = resolve(v["brand-dir"]), batchDir = join(brandDir, "outputs", v.batch), only = v.only ? v.only.split(",") : null, log = (m) => console.log(m);
  try {
    if (v.read) { const r = await readTestimonials({ batchDir, again: !!v.again, only, log }); console.log(`read ${r.read.length} video(s), ${r.left} left · ${r.calls} calls`); }
    if (v.name) { const [id, ...n] = v.name.split("="); const r = correctName(batchDir, id, n.join("=")); console.log(`name set; ${r.changed} draft(s) changed`); }
    if (v.draft) { const r = await draftTestimonialCopy({ brandDir, batchDir, only, log }); console.log(`drafted for ${r.videos.filter((x) => x.added).length} video(s) · ${r.calls} text calls`); }
    if (v.show || (!v.read && !v.draft)) for (const t of testimonialsView(batchDir)) console.log(`${t.id} ${t.folder} · ${t.read ? `${t.reading.speaker}${t.reading.name ? ` (${t.reading.name})` : ""}: ${t.reading.summary}` : t.error || "not read"}${t.decide.length ? `\n   to decide: ${t.decide.map((d) => d.text).join(" | ")}` : ""}\n   drafts ${t.drafts}, kept ${t.kept.copy} copies / ${t.kept.headline} headlines`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
