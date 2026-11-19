#!/usr/bin/env node
/**
 * The raw-footage editor, stage 1: a shoot's files are listened to and laid against the script (2026-11-19).
 *
 * The owner had four videos cut by hand from a coach's own phone clips, voice recordings and a members' montage, passed
 * all four, and approved the editor in three stages, each shown to him before the next: (1) listening and the cutting
 * sheet — this file; (2) the cut and the captions; (3) the swaps on Pick Ads. His rulings: **AI never fills a line that
 * has no take** (it is flagged); the captions follow what is SAID, and a difference from the script is listed, never
 * "fixed"; the shoot's folder is read where it is (a shoot is gigabytes: nothing is copied), and files can be dropped
 * in as well; long standing pauses are tightened by default (stage 2).
 *
 * A shoot — `brands/{gym}/footage/{id}/shoot.json`: the title, the script as pasted, its lines, the folder read in
 * place and/or files dropped in (`files/`), each file's reading, and the owner's choices on the cutting sheet.
 *
 * **The script's lines** (`scriptLines`): one per paragraph; a note in brackets — "(Voiceover)", "(Show video of
 * people working out)" — is a direction, never a word to say: it marks the line as a voice-over or as wanting other
 * footage, and a bracket on a line of its own belongs to the line after it.
 *
 * **Reading a file** (`readFile`, the owner's click; two small model calls a file, no image call): its length and size,
 * every spoken phrase with its time (`listen`: the sound alone — a take may hold a countdown, chatter, the line said
 * three times), where the sound is (`speechOf`), six frames on a sheet and what they show in a few words (`look`).
 * What a file is, by rule (`kindOf`): `voice` (sound only), `montage` (a video with music), `take` (a video with
 * spoken lines), `silent` (a video with none: footage to sit under a voice). Nobody is named or recognised.
 *
 * **Matching** (`matchLine`, pure, by rule — no model): every run of consecutive phrases in every file is held
 * against a script line word for word (`cover`: the longest in-order match, a number the same as its word, one
 * letter's slip forgiven); a run that says at least `MATCH.take` of the line with few words of its own is a TAKE of
 * it, `complete` from `MATCH.complete`. The pick is **the last complete take** (a retake is filmed because the one
 * before was wrong). A line said in two places — one sentence filmed as two clips — is two parts, each with its own
 * takes (`parts`), tried when no single take is complete. A line nobody said is `missing`.
 *
 * **The cutting sheet** (`buildSheet`, pure): for each line its takes and the pick, what was said where it differs
 * from the script (`differs`), whether it needs a picture (its take is sound only) with the silent clips and the
 * montage offered in order, and the files nothing uses. `decideSheet` records the owner's choices — another take, the
 * pictures for a voice-over, a line left out, the order — and nothing else changes them. Stage 2 cuts from this sheet.
 *
 * CLI: footage-editor.mjs --brand-dir brands/{gym} (--list | --new "Title" --script script.txt [--folder path]
 *        | --shoot id (--read [--max N] | --sheet))
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const FOOTAGE_DIR = "footage";
export const MEDIA = { video: [".mov", ".mp4", ".m4v"], sound: [".m4a", ".mp3", ".wav", ".aac"] };
export const SHOOT_LIMITS = { title: [3, 80], script: [20, 6000], lines: [1, 24], files: 120 };
export const MATCH = { take: 0.6, complete: 0.8, own: 0.6, part: 0.75, part_words: 3, run: 6, better: 0.15, instead: 0.3, instead_own: 0.15 };
export const USD_PER_FILE = 0.01;                     // two small calls a file: said before a reading, as an estimate

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const today = () => new Date().toISOString().slice(0, 10);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const isMedia = (name) => [...MEDIA.video, ...MEDIA.sound].includes(extname(name).toLowerCase()) && !basename(name).startsWith(".");

// ── the script ───────────────────────────────────────────────────────────────
const NOTE = /[(\[]([^()\[\]]{2,120})[)\]]/g;
const VOICE_NOTE = /voice\s*-?\s*over|\bv\.?o\.?\b/i, BROLL_NOTE = /\bshow\b|b-?\s?roll|footage of|video of|clips? of/i;
/** The script as pasted → its lines: [{ n, text, notes[], voiceover, broll }]. A note in brackets is a direction, never said. */
export function scriptLines(text) {
  const out = []; let carry = [];
  for (const raw of String(text || "").replace(/\r/g, "").split(/\n+/)) {
    const notes = [...raw.matchAll(NOTE)].map((m) => norm(m[1])), said = norm(raw.replace(NOTE, " "));
    if (!said) { carry.push(...notes); continue; }
    const all = [...carry, ...notes]; carry = [];
    out.push({ n: out.length + 1, text: said, notes: all, voiceover: all.some((x) => VOICE_NOTE.test(x)), broll: all.some((x) => BROLL_NOTE.test(x)) });
  }
  return out;
}
/** What is wrong with a shoot as typed, in words. */
export function shootProblems({ title, script, folder = null }) {
  const errs = [], t = norm(title), lines = scriptLines(script);
  if (t.length < SHOOT_LIMITS.title[0] || t.length > SHOOT_LIMITS.title[1]) errs.push(`give the shoot a name of ${SHOOT_LIMITS.title[0]} to ${SHOOT_LIMITS.title[1]} characters`);
  if (norm(script).length < SHOOT_LIMITS.script[0]) errs.push("paste the script: the lines the videos are cut to");
  else if (String(script).length > SHOOT_LIMITS.script[1]) errs.push(`the script is ${String(script).length} characters; ${SHOOT_LIMITS.script[1]} at most (one video's script a shoot)`);
  else if (lines.length > SHOOT_LIMITS.lines[1]) errs.push(`the script has ${lines.length} lines; a video takes ${SHOOT_LIMITS.lines[1]} at most`);
  if (folder != null && folder !== "") {
    if (typeof folder !== "string" || !folder.startsWith("/")) errs.push("the folder is its full path on this Mac, starting with / (drag the folder onto Terminal to see it)");
    else if (!existsSync(folder) || !statSync(folder).isDirectory()) errs.push(`there is no folder at ${folder} (is the drive plugged in?)`);
  }
  return errs;
}

// ── a shoot on file ──────────────────────────────────────────────────────────
export const shootDir = (gymDir, id) => join(gymDir, FOOTAGE_DIR, id);
const shootPath = (gymDir, id) => join(shootDir(gymDir, id), "shoot.json");
const okId = (id) => /^[a-z0-9][a-z0-9-]{2,60}$/.test(String(id || ""));
export function readShoot(gymDir, id) { if (!okId(id)) throw new Error("no such shoot"); const s = readJson(shootPath(gymDir, id)); if (!s) throw new Error(`no such shoot: ${id}`); return s; }
const writeShoot = (gymDir, s) => { mkdirSync(shootDir(gymDir, s.id), { recursive: true }); writeFileSync(shootPath(gymDir, s.id), JSON.stringify(s, null, 2) + "\n"); return s; };
export function listShoots(gymDir) {
  const dir = join(gymDir, FOOTAGE_DIR); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => okId(id) && existsSync(shootPath(gymDir, id))).map((id) => readShoot(gymDir, id)).sort((a, b) => String(b.created).localeCompare(String(a.created)) || b.id.localeCompare(a.id));
}
/** A new shoot: the name, the script as pasted, and optionally the folder its files are in (read in place). */
export function addShoot(gymDir, { title, script, folder = null }, { now = new Date() } = {}) {
  const errs = shootProblems({ title, script, folder }); if (errs.length) throw new Error(errs.join("; "));
  const slug = norm(title).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "shoot";
  const day = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);   // the day on this Mac's clock, as a batch is named
  let id = `${day}-${slug}`, k = 2; while (existsSync(shootPath(gymDir, id))) id = `${day}-${slug}-${k++}`;
  return writeShoot(gymDir, syncFiles(gymDir, { id, title: norm(title), created: now.toISOString(), script: String(script).replace(/\r/g, "").trim(), folder: folder || null, files: [], choices: {} }));
}
/** The shoot's files as they are on disk now: the folder's (read in place) and the ones dropped in. A reading is kept while the file is as it was. */
export function syncFiles(gymDir, shoot) {
  const had = new Map((shoot.files || []).map((f) => [f.path, f])), found = [], seen = new Set(), cache = readJson(readingsPath(gymDir)) || {};
  const take = (dir, source) => { if (!dir || !existsSync(dir)) return; for (const name of readdirSync(dir).sort()) { const p = join(dir, name); let st; try { st = statSync(p); } catch { continue; } const id = `${st.dev}:${st.ino}`; if (st.isFile() && isMedia(name) && !seen.has(id)) { seen.add(id); found.push({ name, path: p, source, bytes: st.size, mtime: Math.round(st.mtimeMs) }); } } };
  take(shoot.folder, "folder"); for (const sub of ["", "Recordings", "recordings", "Audio", "audio"]) if (sub && shoot.folder) take(join(shoot.folder, sub), "folder");
  take(join(shootDir(gymDir, shoot.id), "files"), "dropped");
  const names = new Map();
  shoot.files = found.slice(0, SHOOT_LIMITS.files).map((f) => {
    const old = had.get(f.path), same = old && old.bytes === f.bytes && old.mtime === f.mtime, kept = same && old.read ? old.read : cache[readingKey(f)] || null;
    const n = names.get(f.name) || 0; names.set(f.name, n + 1);
    return { ...f, key: n ? `${f.name} (${n + 1})` : f.name, ...(kept ? { read: kept } : {}) };
  });
  shoot.missing_folder = !!shoot.folder && !existsSync(shoot.folder);
  return shoot;
}
/** A file is read once for a gym: its reading is kept by its name, size and date (`footage/readings.json`), so a second shoot from the same folder costs nothing for it. */
const readingsPath = (gymDir) => join(gymDir, FOOTAGE_DIR, "readings.json");
const readingKey = (f) => `${f.name}|${f.bytes}|${f.mtime}`;
function keepReading(gymDir, f, read) { const p = readingsPath(gymDir), all = readJson(p) || {}; all[readingKey(f)] = read; mkdirSync(join(gymDir, FOOTAGE_DIR), { recursive: true }); writeFileSync(p, JSON.stringify(all, null, 1) + "\n"); }
/** A file dropped onto a shoot: kept as it is in the shoot's own files folder. Never the same name twice. */
export function dropFile(gymDir, id, name, bytes) {
  const shoot = readShoot(gymDir, id), clean = basename(String(name || "")).replace(/[^\w.\- ()]/g, "_");
  if (!isMedia(clean)) throw new Error(`"${name}" is not a video or a sound file (${[...MEDIA.video, ...MEDIA.sound].join(" ")})`);
  const dir = join(shootDir(gymDir, id), "files"); mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, clean))) throw Object.assign(new Error(`a file called ${clean} is already in this shoot`), { duplicate: true });
  writeFileSync(join(dir, clean), bytes);
  return writeShoot(gymDir, syncFiles(gymDir, shoot));
}
/** The folder or the script changed by the owner (the readings are kept; the sheet is built fresh from them). */
export function editShoot(gymDir, id, { title, script, folder }) {
  const shoot = readShoot(gymDir, id), next = { title: title ?? shoot.title, script: script ?? shoot.script, folder: folder === undefined ? shoot.folder : folder || null };
  const errs = shootProblems(next); if (errs.length) throw new Error(errs.join("; "));
  Object.assign(shoot, { title: norm(next.title), script: String(next.script).replace(/\r/g, "").trim(), folder: next.folder });
  if (script != null) shoot.choices = {};            // other lines: the choices made for the old ones no longer mean anything
  return writeShoot(gymDir, syncFiles(gymDir, shoot));
}

// ── reading a file ───────────────────────────────────────────────────────────
const LISTEN_SCHEMA = { type: "OBJECT", properties: { phrases: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, start: { type: "NUMBER" }, end: { type: "NUMBER" }, kind: { type: "STRING", enum: ["line", "countdown", "chatter", "lyrics"] } }, required: ["text", "start", "end", "kind"] } }, music: { type: "BOOLEAN" }, sounds: { type: "STRING" } }, required: ["phrases", "music", "sounds"] };
export const LISTEN_Q = "This is the sound of a raw file from a shoot for a short advert. It may be a take filmed on a phone (someone may count down, then a presenter says a scripted line to the camera, with chatter before or after, or the line said more than once), a voice recording (one voice reading several lines, perhaps with retakes), a clip with no speech (only the room, weights, steps), or a video with a music track. List EVERY spoken phrase in order, each a few words to one sentence long, with the second it starts and the second it ends (decimals), and its kind: line (a scripted line said for the advert), countdown, chatter, or lyrics (sung words of a song). Write the words exactly as spoken, repeats and slips included; do not tidy the grammar. Say whether there is music, and in a few words what other sounds there are.";
const LOOK_SCHEMA = { type: "OBJECT", properties: { shows: { type: "STRING" }, to_camera: { type: "BOOLEAN" }, people: { type: "INTEGER" } }, required: ["shows", "to_camera", "people"] };
export const LOOK_Q = "These are six frames of one raw video clip from a gym's shoot, in order, left to right. Do not name or guess who anybody is. shows: in eight words or fewer, what happens in the clip (\"curls a dumbbell by the rack\", \"stands at a mirror, seen from behind\", \"members rowing in a class\"). to_camera: someone faces the camera and talks to it for most of the clip. people: how many people are clearly in it.";
/** A media file's facts (ffprobe): seconds, whether it has a picture and sound, and its size as it is shown. */
export function probeMedia(file) {
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height:stream_side_data=rotation", "-of", "json", file]).toString());
  const v = (pr.streams || []).find((s) => s.codec_type === "video"), a = (pr.streams || []).find((s) => s.codec_type === "audio");
  const turned = v && Math.abs(Number((v.side_data_list || []).map((s) => s.rotation).find((x) => x != null) || 0)) % 180 === 90;
  return { seconds: Math.round(Number(pr.format?.duration || 0) * 100) / 100, video: v ? { w: turned ? v.height : v.width, h: turned ? v.width : v.height } : null, sound: !!a };
}
/** The real calls; the tests pass their own. */
export async function editorModels() {
  const [{ callVision, CHECK_MODEL }, { whenGeminiFree }, { loadGeminiKey }, PV] = await Promise.all([import("./check-visual.mjs"), import("./gemini-busy.mjs"), import("./generate_ads_gemini.mjs"), import("./presenter-video.mjs")]);
  return {
    async listen(file) {
      const wav = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { maxBuffer: 512 * 1024 * 1024 });
      const out = await whenGeminiFree(async () => {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": loadGeminiKey() }, signal: AbortSignal.timeout(180000),
          body: JSON.stringify({ contents: [{ parts: [{ text: LISTEN_Q }, { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: LISTEN_SCHEMA } }) });
        if (!res.ok) throw new Error(`the file could not be listened to (${res.status}): ${(await res.text()).slice(0, 300)}`);
        return res.json();
      }, { label: "listening to a clip" });
      return JSON.parse(out.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}");
    },
    look: (sheet) => callVision(sheet, LOOK_Q, LOOK_SCHEMA),
    spans: (file) => { try { return PV.speechOf(file).spans.map((s) => s.map((x) => Math.round(x * 100) / 100)); } catch { return []; } },
  };
}
/** One file read: its facts, its phrases, where its sound is, and (a video) six frames on a sheet and what they show. */
export async function readFile(file, { models, framesDir = null, key = basename(file) } = {}) {
  const facts = probeMedia(file), read = { ...facts, phrases: [], music: false, sounds: "", spans: [], read_on: today() };
  if (facts.sound) {
    const heard = await models.listen(file);
    read.phrases = (heard.phrases || []).filter((p) => norm(p.text) && Number.isFinite(p.start) && Number.isFinite(p.end)).map((p) => ({ text: norm(p.text), start: Math.max(0, Math.round(p.start * 100) / 100), end: Math.min(facts.seconds || p.end, Math.round(p.end * 100) / 100), kind: p.kind || "line" })).sort((a, b) => a.start - b.start);
    read.music = heard.music === true; read.sounds = norm(heard.sounds); read.spans = models.spans ? await models.spans(file) : [];
  }
  if (facts.video && framesDir) {
    mkdirSync(framesDir, { recursive: true });
    const sheet = join(framesDir, `${createHash("sha1").update(key).digest("hex").slice(0, 10)}.jpg`);
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `fps=${6 / Math.max(1, facts.seconds)},scale=-2:320,tile=6x1`, "-frames:v", "1", "-q:v", "4", sheet]);
    if (existsSync(sheet)) { read.frames = basename(sheet); if (models.look) { try { const l = await models.look(sheet); read.shows = norm(l.shows).slice(0, 120); read.to_camera = l.to_camera === true; read.people = Number.isInteger(l.people) ? l.people : null; } catch (e) { read.look_error = String(e.message).slice(0, 200); } } }
  }
  return read;
}
/** Every file of a shoot not read yet (the owner's click): saved after each, so a stop keeps what is read. */
export async function readShootFiles({ gymDir, id, models = null, max = Infinity, log = () => {} }) {
  const m = models || (await editorModels());
  let shoot = writeShoot(gymDir, syncFiles(gymDir, readShoot(gymDir, id))), done = 0;
  const todo = shoot.files.filter((f) => !f.read).slice(0, max);
  log(`${shoot.files.length} file(s), ${todo.length} to read`);
  for (const f of todo) {
    log(`reading ${f.key} …`);
    try { const read = await readFile(f.path, { models: m, framesDir: join(shootDir(gymDir, id), "frames"), key: f.key }); shoot = readShoot(gymDir, id); const row = shoot.files.find((x) => x.path === f.path); if (row) { row.read = read; delete row.error; } keepReading(gymDir, f, read); done++; log(`  ${read.seconds} s · ${kindWord(kindOf(read))}${read.phrases.length ? ` · ${read.phrases.length} phrase(s)` : ""}${read.shows ? ` · ${read.shows}` : ""}`); }
    catch (e) { shoot = readShoot(gymDir, id); const row = shoot.files.find((x) => x.path === f.path); if (row) row.error = String(e.message).slice(0, 300); log(`  could not be read: ${String(e.message).slice(0, 200)}`); }
    writeShoot(gymDir, shoot);
  }
  return { read: done, left: shoot.files.filter((f) => !f.read).length, shoot };
}
/** What a file is, by rule, from its reading. */
export function kindOf(read) {
  if (!read) return null;
  const said = (read.phrases || []).filter((p) => p.kind !== "lyrics" && p.kind !== "countdown");
  if (!read.video) return "voice";
  if (read.music) return "montage";
  return said.some((p) => p.kind === "line") || said.length >= 2 ? "take" : "silent";
}
const kindWord = (k) => ({ voice: "a voice recording", montage: "a video with music", take: "takes to camera", silent: "a clip with no line" })[k] || "not read";

// ── matching, by rule ────────────────────────────────────────────────────────
const NUMBER = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", twenty: "20", thirty: "30" };
/** The words of a line as they are compared: small letters, no punctuation, a number as its digit, "a/b" as both words. */
export const wordsOf = (s) => String(s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[\/–—-]/g, " ").replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).map((w) => NUMBER[w] || w.replace(/^'+|'+$/g, "")).filter(Boolean);
const near = (a, b) => { if (a === b) return true; if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false; let i = 0, j = 0, d = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else { if (++d > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } } } return d + (a.length - i) + (b.length - j) <= 1; };
/** How a spoken run covers a script line: the longest in-order match. { hit, said (share of the line said), own (share of the run that is the line's), score } */
export function cover(lineWords, runWords) {
  const n = lineWords.length, m = runWords.length; if (!n || !m) return { hit: 0, said: 0, own: 0, score: 0 };
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) t[i][j] = near(lineWords[i - 1], runWords[j - 1]) ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  const hit = t[n][m], said = hit / n, own = hit / m;
  return { hit, said, own, score: said + own ? (2 * said * own) / (said + own) : 0 };
}
/** Every take of some words in the files: the best run of phrases in each stretch of each file, the stretches told apart. */
function takesOf(lineWords, files, { need = MATCH.take, own = MATCH.own, skip = null } = {}) {
  const out = [];
  for (const f of files) {
    const ps = (f.read?.phrases || []).map((p, i) => ({ ...p, i })).filter((p) => p.kind !== "countdown" && p.kind !== "lyrics" && !(skip && skip(f.key, p)));
    const used = new Set();
    for (;;) {
      let best = null;
      for (let a = 0; a < ps.length; a++) for (let b = a; b < Math.min(ps.length, a + MATCH.run); b++) {
        if (ps.slice(a, b + 1).some((p) => used.has(p.i))) break;
        const c = cover(lineWords, wordsOf(ps.slice(a, b + 1).map((p) => p.text).join(" ")));
        if (c.said >= need && c.own >= own && (!best || c.score > best.c.score + 1e-9)) best = { a, b, c };
      }
      if (!best) break;
      const run = ps.slice(best.a, best.b + 1); run.forEach((p) => used.add(p.i));
      out.push({ file: f.key, from: run[0].start, to: run.at(-1).end, spoken: run.map((p) => p.text).join(" "), said: Math.round(best.c.said * 100) / 100, own: Math.round(best.c.own * 100) / 100, complete: best.c.said >= MATCH.complete, sound_only: !f.read.video });
    }
  }
  const order = new Map(files.map((f, i) => [f.key, i]));
  return out.sort((x, y) => order.get(x.file) - order.get(y.file) || x.from - y.from);
}
/** The pick among takes: the last complete one; with none complete, the one that says the most (the later of equals). */
export const pickTake = (takes) => { if (!takes.length) return -1; let k = -1; takes.forEach((t, i) => { if (t.complete) k = i; }); if (k >= 0) return k; takes.forEach((t, i) => { if (k < 0 || t.said >= takes[k].said) k = i; }); return k; };
/**
 * A script line against the files: { takes, pick } when it was said in one go; { parts: [{ words, takes, pick }, …] }
 * when one sentence was filmed as two clips (tried when no single take is complete, taken when the two say clearly
 * more of it); { takes: [], missing: true } when nobody said it.
 */
export function matchLine(text, files) {
  const w = wordsOf(text), read = files.filter((f) => f.read), whole = takesOf(w, read), best = whole.length ? Math.max(...whole.map((t) => t.said)) : 0;
  if (best < MATCH.complete && w.length >= MATCH.part_words * 2) {
    let split = null;
    for (let k = MATCH.part_words; k <= w.length - MATCH.part_words; k++) {
      const a = takesOf(w.slice(0, k), read, { need: MATCH.part }), b = takesOf(w.slice(k), read, { need: MATCH.part });
      if (!a.length || !b.length) continue;
      const pa = a[pickTake(a)], pb = b[pickTake(b)]; if (pa.file === pb.file && pb.from < pa.to) continue;
      const said = (pa.said * k + pb.said * (w.length - k)) / w.length;
      if (!split || said > split.said + 1e-9) split = { k, a, b, said };
    }
    if (split && split.said >= best + MATCH.better) {
      const tw = norm(text).split(" "), cut = wordIndex(tw, split.k);
      return { parts: [{ text: tw.slice(0, cut).join(" "), takes: split.a, pick: pickTake(split.a) }, { text: tw.slice(cut).join(" "), takes: split.b, pick: pickTake(split.b) }], said: Math.round(split.said * 100) / 100 };
    }
  }
  return whole.length ? { takes: whole, pick: pickTake(whole) } : { takes: [], pick: -1, missing: true };
}
/**
 * A line nobody said as written: the nearest thing that WAS said and that no other line uses (video 3's script ended
 * "Click the link now, let's get started!" and the coach said "Click on the link below, see if you're a good fit for
 * our challenge"). It shares at least `MATCH.instead` of the line's words in order. Offered, flagged "said
 * differently": the captions follow what is said, and the owner may leave the line out.
 */
export function saidInstead(text, files, taken = []) {
  const skip = (key, p) => taken.some((t) => t.file === key && p.start < t.to - 0.05 && p.end > t.from + 0.05);
  const found = takesOf(wordsOf(text), files.filter((f) => f.read), { need: MATCH.instead, own: MATCH.instead_own, skip });
  return found.length ? found.map((t) => ({ ...t, instead: true, complete: false })) : [];
}
/** Where the k-th compared word falls among a line's written words (a written "a/b" is two compared words). */
const wordIndex = (written, k) => { let seen = 0; for (let i = 0; i < written.length; i++) { if (seen >= k) return i; seen += wordsOf(written[i]).length; } return written.length; };
/** What was said where it is not the script's words: the script's words nobody said, and the words said that are not in it. */
export function differs(scriptText, spoken) {
  const a = wordsOf(scriptText), b = wordsOf(spoken), n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) t[i][j] = near(a[i - 1], b[j - 1]) ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  const unsaid = [], added = []; let i = n, j = m;
  while (i > 0 || j > 0) { if (i > 0 && j > 0 && near(a[i - 1], b[j - 1])) { i--; j--; } else if (j > 0 && (i === 0 || t[i][j - 1] >= t[i - 1][j])) added.unshift(b[--j]); else unsaid.unshift(a[--i]); }
  return { unsaid, added, same: !unsaid.length && !added.length };
}

// ── the cutting sheet ────────────────────────────────────────────────────────
/**
 * The sheet a video is cut from, built fresh from the readings and the owner's choices (`shoot.choices[line]`:
 * `{ take: n | [n, n], pictures: [file keys], drop: true }`, and `shoot.choices.order`). Pure: no call, nothing written.
 */
export function buildSheet(shoot) {
  const files = shoot.files || [], read = files.filter((f) => f.read), lines = scriptLines(shoot.script), choices = shoot.choices || {};
  const kinds = Object.fromEntries(read.map((f) => [f.key, kindOf(f.read)]));
  const chosen = (list, own) => (Number.isInteger(own) && own >= 0 && own < list.length ? own : pickTake(list));
  const rows = lines.map((l) => {
    const c = choices[l.n] || {}, m = matchLine(l.text, files);
    const parts = (m.parts || [{ text: l.text, takes: m.takes, pick: m.pick }]).map((p, i) => {
      const pick = chosen(p.takes, Array.isArray(c.take) ? c.take[i] : i === 0 ? c.take : undefined), t = p.takes[pick] || null;
      return { text: p.text, takes: p.takes, pick, auto: pickTake(p.takes), ...(t ? { differs: differs(p.text, t.spoken) } : {}) };
    });
    return { n: l.n, text: l.text, notes: l.notes, voiceover: l.voiceover, broll: l.broll, parts, split: parts.length > 1, drop: c.drop === true, choice: c };
  });
  // A line nobody said as written takes the nearest thing that was said and that no other line uses, flagged.
  const picked = () => rows.flatMap((r) => (r.drop ? [] : r.parts.map((p) => p.takes[p.pick]))).filter(Boolean);
  for (const r of rows) for (const [i, p] of r.parts.entries()) {
    if (p.takes.length) continue;
    p.takes = saidInstead(p.text, files, picked()); if (!p.takes.length) continue;
    const own = Array.isArray(r.choice.take) ? r.choice.take[i] : i === 0 ? r.choice.take : undefined;
    p.auto = pickTake(p.takes); p.pick = chosen(p.takes, own); p.differs = differs(p.text, p.takes[p.pick].spoken);
  }
  for (const r of rows) {
    const took = r.parts.map((p) => p.takes[p.pick]).filter(Boolean);
    r.missing = r.parts.some((p) => !p.takes.length); r.partial = !r.missing && took.some((t) => !t.complete);
    r.needs_picture = took.some((t) => t.sound_only); r.seconds = Math.round(took.reduce((t, x) => t + (x.to - x.from), 0) * 10) / 10;
    r.said_as_written = !r.missing && r.parts.every((p) => p.differs?.same);
    r.state = r.drop ? "left out" : r.missing ? "no take" : r.partial ? "said differently" : "ready"; delete r.choice;
  }
  // Footage for the voice-over lines: the clips no line's take is in — silent clips first, in their order, then a montage — unless the owner chose.
  const usedBy = new Set(rows.flatMap((r) => (r.drop ? [] : r.parts.map((p) => p.takes[p.pick]?.file))).filter(Boolean));
  const spare = read.filter((f) => f.read.video && !usedBy.has(f.key)), silent = spare.filter((f) => kinds[f.key] === "silent").map((f) => f.key), montage = spare.filter((f) => kinds[f.key] === "montage").map((f) => f.key);
  const wanting = rows.filter((r) => r.needs_picture && !r.drop);
  // His own choices first: a clip he put under one line is not handed to another by the rule.
  for (const r of wanting) { const own = (choices[r.n]?.pictures || []).filter((k) => read.some((f) => f.key === k && f.read.video)); if (own.length) { r.pictures = own; r.pictures_by = "you"; } }
  const his = new Set(wanting.flatMap((r) => r.pictures || [])), pool = silent.filter((k) => !his.has(k));
  for (const r of wanting) {
    if (r.pictures) continue;
    // A line that asks for other footage ("Show video of people working out") takes the montage; the rest share the silent clips in order.
    if (r.broll && montage.length) { r.pictures = [montage[0]]; r.pictures_by = "rule"; continue; }
    // The silent clips are shared in their order, a longer line taking more of them (a start: the owner swaps what goes under what).
    const rest = wanting.filter((x) => !x.pictures && !(x.broll && montage.length)), total = rest.reduce((t, x) => t + Math.max(1, x.seconds), 0);
    const share = rest.length === 1 ? pool.length : Math.max(1, Math.round((pool.length * Math.max(1, r.seconds)) / Math.max(1, total)));
    r.pictures = pool.splice(0, share); if (!r.pictures.length && montage.length) r.pictures = [montage[0]];
    r.pictures_by = "rule"; if (!r.pictures.length) r.state = r.state === "ready" ? "needs footage" : r.state;
  }
  const order = Array.isArray(choices.order) && choices.order.length === rows.length && [...choices.order].sort((a, b) => a - b).every((n, i) => n === i + 1) ? choices.order : rows.map((r) => r.n);
  const inUse = new Set([...usedBy, ...rows.flatMap((r) => r.pictures || [])]);
  const live = rows.filter((r) => !r.drop);
  return {
    lines: order.map((n) => rows.find((r) => r.n === n)), order,
    files: files.map((f) => ({ key: f.key, name: f.name, source: f.source, read: !!f.read, kind: kinds[f.key] || null, seconds: f.read?.seconds ?? null, shows: f.read?.shows || null, frames: f.read?.frames || null, phrases: (f.read?.phrases || []).length, used: inUse.has(f.key), ...(f.error ? { error: f.error } : {}) })),
    unread: files.filter((f) => !f.read).length,
    counts: { lines: rows.length, ready: live.filter((r) => r.state === "ready").length, no_take: live.filter((r) => r.missing).length, differently: live.filter((r) => r.state === "said differently").length, needs_footage: live.filter((r) => r.state === "needs footage").length, left_out: rows.length - live.length, differ: live.filter((r) => !r.missing && !r.said_as_written).length },
    can_cut: !files.some((f) => !f.read) && live.length > 0 && live.every((r) => r.state === "ready" || r.state === "said differently"),
  };
}
/** The owner's choice on one line (another take, the footage under a voice-over, left out or put back), or the order of the lines. */
export function decideSheet(gymDir, id, { line = null, take, pictures, drop, order } = {}) {
  const shoot = readShoot(gymDir, id), sheet = buildSheet(shoot), choices = (shoot.choices = shoot.choices || {});
  if (order != null) {
    if (!Array.isArray(order) || order.length !== sheet.lines.length || [...order].sort((a, b) => a - b).some((n, i) => n !== i + 1)) throw new Error("the order names every line once");
    choices.order = order;
  }
  if (line != null) {
    const row = sheet.lines.find((r) => r.n === line); if (!row) throw new Error(`the script has no line ${line}`);
    const c = (choices[line] = choices[line] || {});
    if (take !== undefined) {
      const picks = [].concat(take);
      if (picks.length !== row.parts.length || picks.some((k, i) => !Number.isInteger(k) || k < 0 || k >= row.parts[i].takes.length)) throw new Error("that take is not one of this line's takes");
      c.take = row.parts.length > 1 ? picks : picks[0];
    }
    if (pictures !== undefined) {
      if (!Array.isArray(pictures) || pictures.length > 8 || pictures.some((k) => !shoot.files.some((f) => f.key === k && f.read?.video))) throw new Error("the footage for a line is clips of this shoot that have a picture, eight at most");
      if (pictures.length) c.pictures = pictures; else delete c.pictures;
    }
    if (drop !== undefined) { if (drop === true) c.drop = true; else delete c.drop; }
    if (!Object.keys(c).length) delete choices[line];
  }
  writeShoot(gymDir, shoot);
  return buildSheet(shoot);
}
/** The sheet in plain lines (the CLI, a log). */
export function sheetText(shoot) {
  const s = buildSheet(shoot), out = [`${shoot.title} · ${s.counts.lines} lines · ${s.files.length} files${s.unread ? ` (${s.unread} not read yet)` : ""}`];
  for (const r of s.lines) {
    out.push(`\n${r.n}. ${r.text}${r.voiceover ? "  [voice-over]" : ""}${r.broll ? "  [other footage]" : ""}  — ${r.state}`);
    for (const p of r.parts) {
      if (r.split) out.push(`   part: "${p.text}"`);
      p.takes.forEach((t, i) => out.push(`   ${i === p.pick ? "▶" : " "} ${t.file} ${t.from.toFixed(1)}–${t.to.toFixed(1)} s · ${t.complete ? "complete" : t.instead ? "said instead" : `says ${Math.round(t.said * 100)}%`}${t.sound_only ? " · sound only" : ""} · "${t.spoken}"`));
      if (p.differs && !p.differs.same) out.push(`     differs: ${p.differs.unsaid.length ? `not said: ${p.differs.unsaid.join(" ")}` : ""}${p.differs.unsaid.length && p.differs.added.length ? " · " : ""}${p.differs.added.length ? `said as well: ${p.differs.added.join(" ")}` : ""}`);
    }
    if (r.needs_picture) out.push(`   footage: ${r.pictures?.length ? r.pictures.join(", ") : "none to put under it"}`);
  }
  const spare = s.files.filter((f) => f.read && !f.used);
  if (spare.length) out.push(`\nnot used: ${spare.map((f) => `${f.key} (${kindWord(f.kind)})`).join(", ")}`);
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { "brand-dir": { type: "string" }, list: { type: "boolean" }, new: { type: "string" }, script: { type: "string" }, folder: { type: "string" }, shoot: { type: "string" }, read: { type: "boolean" }, max: { type: "string" }, sheet: { type: "boolean" } } });
  const dir = a["brand-dir"];
  try {
    if (!dir) throw new Error('usage: footage-editor.mjs --brand-dir brands/{gym} (--list | --new "Title" --script script.txt [--folder path] | --shoot id (--read [--max N] | --sheet))');
    if (a.list) for (const s of listShoots(dir)) console.log(`${s.id} · ${s.title} · ${s.files.length} files, ${s.files.filter((f) => f.read).length} read`);
    else if (a.new) { const s = addShoot(dir, { title: a.new, script: readFileSync(a.script, "utf-8"), folder: a.folder || null }); console.log(`${s.id}: ${scriptLines(s.script).length} lines, ${s.files.length} files`); }
    else if (a.shoot && a.read) { const r = await readShootFiles({ gymDir: dir, id: a.shoot, max: a.max ? Number(a.max) : Infinity, log: (m) => console.log(m) }); console.log(`read ${r.read}, ${r.left} left`); console.log(sheetText(r.shoot)); process.exit(0); }
    else if (a.shoot) console.log(sheetText(writeShoot(dir, syncFiles(dir, readShoot(dir, a.shoot)))));
  } catch (e) { console.error(e.message); process.exit(1); }
}
