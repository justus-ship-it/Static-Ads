#!/usr/bin/env node
/**
 * A gym's real coaches in its AI videos (2026-11-17, the owner: "I will send you 3 actual videos of BFIT's coaches. We
 * need to change the current BFIT's videos to look as much like them as possible, as well as the voice … they will all
 * be wearing BFIT's uniform … We will be taking sample videos/stills of the gyms for the agent to analyze").
 *
 * This file is the intake and the gate — no model call, no image call:
 *   - the gym's sample videos, kept as they are in brands/{gym}/brand-assets/video-samples/ (never committed; never twice);
 *   - still frames pulled from them by ffmpeg, the raw material a cut starts from;
 *   - the coaches (brands/{gym}/coaches.json): who they are, in the owner's words — never read off a face — and
 *     **each coach's written consent**, for the face and for the voice. A coach without consent on file is never
 *     generated: `usable()` says so in words, and every maker asks it first. A coach can be switched off, never deleted.
 *
 * The reading of the samples (who appears, the uniform, the rooms, how it is shot, how the voice sounds) and the making
 * of the videos come after the owner's samples are in hand.
 *
 * Usage:
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --add-sample <video.mp4> [--frames]
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --coach "Name" [--note "the tall one in sample 2"]
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --consent <coach id> --face --voice --by "who gave it, how"
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --shows <coach id> --samples video-01.mp4,video-02.mp4
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --read [--max 40]     (two check calls a video; then the starting pictures)
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --starts             (the starting pictures again, no call)
 *   node skills/references/coach-look.mjs --brand-dir brands/bfit --list
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from "fs";
import { join, resolve, basename, extname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { createHash } from "crypto";
import { spawnSync, execFileSync } from "child_process";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";
import { whenGeminiFree } from "./gemini-busy.mjs";
import { loadGeminiKey } from "./generate_ads_gemini.mjs";

export const COACHES_FILE = "coaches.json", SAMPLES_DIR = join("brand-assets", "video-samples");
export const VIDEO_EXT = [".mp4", ".mov", ".m4v"], STILL_EXT = [".jpg", ".jpeg", ".png", ".heic", ".webp"];
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const slug = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };

// ── the coaches and their consent ────────────────────────────────────────────
export function readCoaches(gymDir) {
  const d = readJson(join(gymDir, COACHES_FILE));
  return { coaches: Array.isArray(d?.coaches) ? d.coaches : [], ...(d?.uniform ? { uniform: d.uniform } : {}) };
}
const write = (gymDir, d) => writeFileSync(join(gymDir, COACHES_FILE), JSON.stringify(d, null, 2) + "\n");

/** A coach as the owner names them. Who a person is is never read off a face: the owner says. */
export function addCoach(gymDir, { name, note = null } = {}) {
  const n = norm(name);
  if (n.length < 2 || n.length > 60) throw new Error("a coach needs a name, 2 to 60 characters, as the gym calls them");
  const d = readCoaches(gymDir), id = `coach-${slug(n)}`;
  if (d.coaches.some((c) => c.id === id)) throw new Error(`${n} is already on this gym's list`);
  const coach = { id, name: n, ...(norm(note) ? { note: norm(note) } : {}), status: "on", consent: null, frames: [], voice: null, added: today() };
  d.coaches.push(coach); write(gymDir, d);
  return coach;
}

/**
 * A coach's written consent, as the owner records it: for their face (the videos look like them) and, apart, for their
 * voice (the videos sound like them). `by` says who gave it and how ("signed form, 17 Nov", "WhatsApp to the owner"):
 * without it nothing is recorded. Taking consent back is recording it as false, with the date.
 */
export function setConsent(gymDir, id, { face, voice = false, by, note = null } = {}) {
  if (typeof face !== "boolean" || typeof voice !== "boolean") throw new Error("consent is said for the face and for the voice: true or false each");
  if (norm(by).length < 3) throw new Error("say who gave the consent and how (a signed form, a message): it is kept with the date");
  const d = readCoaches(gymDir), c = d.coaches.find((x) => x.id === id);
  if (!c) throw new Error(`this gym has no coach ${id}`);
  c.consent = { face, voice, by: norm(by), on: today(), ...(norm(note) ? { note: norm(note) } : {}) };
  write(gymDir, d);
  return c;
}

/** Switch a coach off (a reason is required; they stay on file) or back on. */
export function switchCoach(gymDir, id, { on, reason = null } = {}) {
  const d = readCoaches(gymDir), c = d.coaches.find((x) => x.id === id);
  if (!c) throw new Error(`this gym has no coach ${id}`);
  if (!on && norm(reason).length < 3) throw new Error("say why this coach is switched off: they are kept on file, never deleted");
  c.status = on ? "on" : "off";
  if (on) delete c.off; else c.off = { reason: norm(reason), on: today() };
  write(gymDir, d);
  return c;
}

/**
 * Which samples show this coach — the owner's word, never read off a face (2026-11-17: thirteen videos of two coaches
 * came in together; the agent grouped them by what the people wore and the owner named each group). The list replaces
 * the coach's own; a sample shows one coach, so one named here leaves any other coach's list. `note` replaces the note.
 */
export function setSamples(gymDir, id, names, { note } = {}) {
  const d = readCoaches(gymDir), c = d.coaches.find((x) => x.id === id);
  if (!c) throw new Error(`this gym has no coach ${id}`);
  const have = new Set(samples(gymDir).map((s) => s.name)), list = [...new Set((names || []).map(norm).filter(Boolean))];
  const missing = list.filter((n) => !have.has(n));
  if (missing.length) throw new Error(`no sample ${missing.join(", ")} in this gym's folder`);
  for (const o of d.coaches) if (o !== c && Array.isArray(o.samples)) o.samples = o.samples.filter((n) => !list.includes(n));
  c.samples = list.sort();
  if (note !== undefined) { if (norm(note)) c.note = norm(note); else delete c.note; }
  write(gymDir, d);
  return c;
}

/**
 * May this coach be generated? `{ ok, why }` — the one gate every maker asks first. A video in a real person's likeness
 * needs their consent for the face; one that is also made to sound like them needs it for the voice too (`voice: true`).
 */
export function usable(coach, { voice = false } = {}) {
  if (!coach) return { ok: false, why: "no such coach on this gym's list" };
  if (coach.status === "off") return { ok: false, why: `${coach.name} is switched off${coach.off?.reason ? ` (${coach.off.reason})` : ""}` };
  if (!coach.consent) return { ok: false, why: `${coach.name}'s written consent is not on file: a video in a real person's likeness is not made without it` };
  if (coach.consent.face !== true) return { ok: false, why: `${coach.name} has not consented to videos in their likeness` };
  if (voice && coach.consent.voice !== true) return { ok: false, why: `${coach.name} has consented to their likeness but not to their voice: the video may look like them, with a voice that is not theirs` };
  return { ok: true, why: null };
}

// ── the samples ──────────────────────────────────────────────────────────────
export const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
/** A video's length and size, by ffprobe: `{ seconds, width, height, audio }`. */
export function probe(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", file], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`this file could not be read as a video: ${basename(file)}`);
  const j = JSON.parse(r.stdout), v = (j.streams || []).find((x) => x.codec_type === "video");
  if (!v) throw new Error(`${basename(file)} has no picture: a sample is a video or a still`);
  // A phone films upright by turning the picture: the size is the one it is shown at.
  const turn = Math.abs(Number((v.side_data_list || []).find((x) => x.rotation != null)?.rotation ?? v.tags?.rotate ?? 0)) % 180 === 90;
  return { seconds: Math.round(Number(j.format?.duration || 0) * 100) / 100, width: turn ? v.height : v.width, height: turn ? v.width : v.height, audio: (j.streams || []).some((x) => x.codec_type === "audio") };
}

/** Take a sample video or still into the gym's folder as it is (by its content: never twice). Returns its record. */
export function addSample(gymDir, file) {
  const src = resolve(file), ext = extname(src).toLowerCase();
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`no such file: ${file}`);
  if (![...VIDEO_EXT, ...STILL_EXT].includes(ext)) throw new Error(`a sample is a video (${VIDEO_EXT.join(", ")}) or a still (${STILL_EXT.join(", ")}): ${basename(src)} is neither`);
  const dir = join(gymDir, SAMPLES_DIR), index = join(dir, "samples.json"), list = readJson(index)?.samples || [], hash = sha(src);
  const had = list.find((x) => x.sha256 === hash);
  if (had) return { ...had, already: true };
  mkdirSync(dir, { recursive: true });
  const kind = VIDEO_EXT.includes(ext) ? "video" : "still", n = list.filter((x) => x.kind === kind).length + 1, name = `${kind}-${String(n).padStart(2, "0")}${ext}`;
  copyFileSync(src, join(dir, name));
  const rec = { name, kind, original: basename(src), sha256: hash, added: today(), ...(kind === "video" ? probe(join(dir, name)) : {}) };
  writeFileSync(index, JSON.stringify({ samples: [...list, rec] }, null, 2) + "\n");
  return rec;
}
export function samples(gymDir) { return readJson(join(gymDir, SAMPLES_DIR, "samples.json"))?.samples || []; }

/**
 * Still frames from a sample video, evenly through it (ffmpeg; no model): `every` seconds apart, `max` at most, at the
 * video's own size. Kept beside the sample in frames/{sample}/ and named for their second, so a frame is never pulled
 * twice. Returns [{ file, at }].
 */
export function extractFrames(gymDir, name, { every = 1, max = 60 } = {}) {
  const dir = join(gymDir, SAMPLES_DIR), src = join(dir, name);
  if (!existsSync(src)) throw new Error(`no sample ${name} in this gym's folder`);
  const { seconds } = probe(src), out = join(dir, "frames", basename(name, extname(name)));
  mkdirSync(out, { recursive: true });
  const step = Math.max(every, seconds / max), frames = [];
  for (let at = Math.min(0.2, seconds / 2); at < seconds && frames.length < max; at += step) {
    const file = join(out, `at-${at.toFixed(2).padStart(7, "0")}.jpg`);
    if (!existsSync(file)) {
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", src, "-frames:v", "1", "-q:v", "2", file]);
      if (r.status !== 0 || !existsSync(file)) continue;
    }
    frames.push({ file, at: Math.round(at * 100) / 100 });
  }
  return frames;
}

// ── reading the samples ──────────────────────────────────────────────────────
/**
 * What a sample shows and how it sounds, read once (2026-11-17, built after the owner judged the paid test: likeness
 * yes, voice close enough, uniform yes). Two calls to the check model a video — the sound track alone (the words, the
 * voice described for a video model to imitate), and up to LOOK_FRAMES of its frames (which are fit to start a clip
 * from, where the head and the shirt's print are, what the person wears, where it was filmed, what the shirt and the
 * walls say). Nobody is named or recognised by a model: who a sample shows stays the owner's click. Kept on the
 * sample's record (`read`), so a sample is never read twice.
 */
export const LOOK_FRAMES = 8;
const BOX = { type: "ARRAY", items: { type: "INTEGER" } };
const HEAR_SCHEMA = { type: "OBJECT", properties: { transcript: { type: "STRING" }, speakers: { type: "INTEGER" }, pitch: { type: "STRING" }, pace: { type: "STRING" }, accent: { type: "STRING" }, energy: { type: "STRING" }, voice: { type: "STRING" } }, required: ["transcript", "speakers", "pitch", "pace", "accent", "energy", "voice"] };
const HEAR_Q = "This is the sound track of a short video a fitness coach recorded on a phone. transcript: every word spoken, exactly as said, in order, keeping repeats, fillers and false starts. speakers: how many different people speak. pitch: the main speaker's pitch: low, medium-low, medium, medium-high or high. pace: slow, measured, conversational, quick or very quick. accent: the accent in plain words as heard, and how strong it is: light, moderate or strong. energy: calm, warm, upbeat, intense or flat, with a few words on how they come across. voice: one sentence describing the sound of the voice (its depth, timbre, breathiness, nasality) so that a voice actor could imitate it; do not name or guess who the person is.";
const LOOK_SCHEMA = { type: "OBJECT", properties: {
  frames: { type: "ARRAY", items: { type: "OBJECT", properties: { index: { type: "INTEGER" }, people: { type: "INTEGER" }, looks_at_lens: { type: "BOOLEAN" }, eyes_open: { type: "BOOLEAN" }, mouth_closed: { type: "BOOLEAN" }, sharp: { type: "BOOLEAN" }, hands_low: { type: "BOOLEAN" }, ready: { type: "BOOLEAN" }, print_readable: { type: "BOOLEAN" }, head_box: BOX, print_box: BOX }, required: ["index", "people", "looks_at_lens", "eyes_open", "mouth_closed", "sharp", "ready", "print_readable", "head_box"] } },
  top: { type: "STRING" }, bottom: { type: "STRING" }, glasses: { type: "BOOLEAN" }, seated: { type: "BOOLEAN" }, spot: { type: "STRING" }, shirt_words: { type: "STRING" }, shirt_logo: { type: "STRING" }, wall_words: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["frames", "top", "glasses", "seated", "spot", "shirt_words"] };
const LOOK_Q = (n) => `These ${n} images are frames of one phone video of a person talking to the camera in a gym, in order (index 0 to ${n - 1}). Do not name or guess who the person is. For EACH frame — people: how many people are visible; looks_at_lens: the person looks straight into the camera; eyes_open: both eyes are open; mouth_closed: the lips are together (not mid-word); sharp: the face is in focus with no motion blur; hands_low: the hands are at or below the waist, or out of the picture; ready: the person is settled and facing the camera, as someone is just before or while speaking to it — NOT touching their face, hair or clothes, not laughing, not looking down or aside, not turning or moving into place, nothing in front of their face or chest; print_readable: everything printed on the front of their top can be read in full in this frame — the cloth flat, not creased or folded over the words (as it is when someone sits leaning forward), not covered by a hand or an arm, not cut off by the edge of the picture (true when nothing is printed on it); head_box: the box around the head, from the top of the hair to the chin, as [ymin, xmin, ymax, xmax] on a 0-1000 scale; print_box: the box around everything printed on the front of the top they wear (logos and words together), same scale, or an empty list when nothing is printed or it cannot be seen. For the video as a whole — top: the top they wear, as colour and kind (for example "black T-shirt"); bottom: what they wear below it, or "" if never seen; glasses: they wear glasses; seated: they are sitting down for most of the video (on a bench, a bed, a box, the floor) rather than standing; spot: where in the gym this is filmed, as a few plain words a person who knows the gym would recognise (for example "on the turf lane, the grey wall with the logo behind"); shirt_words: the words printed on the front of the top, exactly as they read, letter for letter, or "" if none; shirt_logo: any logo on the top described in a few words, or ""; wall_words: every piece of lettering on the walls, mirrors or signs behind, each exactly as it reads where it can be read in full.`;
/** The two real calls; the tests pass their own. */
export function lookModels() {
  return {
    async hear(file) {
      const wav = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { maxBuffer: 256 * 1024 * 1024 });
      const out = await whenGeminiFree(async () => {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": loadGeminiKey() }, signal: AbortSignal.timeout(180000),
          body: JSON.stringify({ contents: [{ parts: [{ text: HEAR_Q }, { inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: HEAR_SCHEMA } }) });
        if (!res.ok) throw new Error(`the sample could not be listened to (${res.status}): ${(await res.text()).slice(0, 300)}`);
        return res.json();
      }, { label: "listening to a sample" });
      return JSON.parse(out.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}");
    },
    look: (frames) => callVision(frames, LOOK_Q(frames.length), LOOK_SCHEMA),
  };
}
const index = (gymDir) => join(gymDir, SAMPLES_DIR, "samples.json");
const writeSamples = (gymDir, list) => writeFileSync(index(gymDir), JSON.stringify({ samples: list }, null, 2) + "\n");
const evenly = (xs, n) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]));
// A Chinese transcript has no spaces: there a character is a word (a run of Latin letters or digits is one).
const wordsIn = (t) => { const x = String(t || ""); return /[\u3400-\u9fff]/.test(x) ? (x.match(/[A-Za-z0-9]+|[\u3400-\u9fff]/g) || []).length : x.split(/\s+/).filter(Boolean).length; };

/**
 * Read every video sample not read yet (`max` at most; `only`: these names). Returns { read[], left, calls }. A
 * sample that cannot be read is said and the rest go on; nothing about who a person is is asked or kept.
 */
export async function readSamples({ gymDir, models = lookModels(), max = 40, only = null, again = false, log = () => {} }) {
  // `again`: true reads everything once more; "look" looks at the frames once more and keeps what was heard.
  const list = samples(gymDir), todo = list.filter((s) => s.kind === "video" && (again || !s.read) && (!only || only.includes(s.name))), read = [], failed = []; let calls = 0;
  for (const s of todo.slice(0, max)) {
    try {
      const frames = evenly(extractFrames(gymDir, s.name, { every: 2 }), LOOK_FRAMES);
      // The frames are looked at half-size (the boxes are shares of the picture, and eight full frames are slow to send); the pictures are cut from the full ones.
      const small = frames.map((f) => { const o = f.file.replace(/\.jpg$/, ".look.jpg"); if (!existsSync(o)) spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", f.file, "-vf", "scale=540:-2", "-q:v", "4", o]); return existsSync(o) ? o : f.file; });
      const keep = again === "look" && s.read?.heard ? s.read.heard : null, heardNow = !keep && s.audio ? await models.hear(join(gymDir, SAMPLES_DIR, s.name)) : null; if (heardNow) calls++;
      const look = await models.look(small); calls++;
      const heard = keep || heardNow, spoken = keep ? keep.words : heard ? wordsIn(heard.transcript) : 0;
      s.read = { on: today(), heard: heard ? { ...heard, words: spoken, per_second: s.seconds ? Math.round((spoken / s.seconds) * 10) / 10 : null } : null,
        frames: (look.frames || []).filter((x) => frames[x.index]).map((x) => ({ ...x, at: frames[x.index].at })), top: norm(look.top), bottom: norm(look.bottom), glasses: !!look.glasses, seated: look.seated === true, spot: norm(look.spot), shirt_words: norm(look.shirt_words), shirt_logo: norm(look.shirt_logo), wall_words: (look.wall_words || []).map(norm).filter(Boolean) };
      writeSamples(gymDir, list); read.push(s.name);
      log(`${s.name}: ${s.read.top}${s.read.glasses ? ", glasses" : ""} · ${s.read.spot}${spoken ? ` · ${spoken} words` : ""}`);
    } catch (e) { failed.push({ name: s.name, why: String(e.message || e).slice(0, 200) }); log(`${s.name}: could not be read — ${failed.at(-1).why}`); }
  }
  return { read, failed, left: Math.max(0, todo.length - max), calls };
}

/**
 * The samples in groups by what the person wears (the top and whether they wear glasses) — a help for the owner's
 * click, never a name: [{ key, label, samples[], coach (the coach every sample of the group is named for, else null) }].
 */
export function groupsOf(gymDir) {
  const coaches = readCoaches(gymDir).coaches, whose = (name) => coaches.find((c) => (c.samples || []).includes(name))?.id || null, by = new Map();
  for (const s of samples(gymDir)) {
    const key = s.read ? `${s.read.top.toLowerCase()}|${s.read.glasses ? "glasses" : "no glasses"}` : "unread";
    if (!by.has(key)) by.set(key, { key, label: s.read ? `${s.read.top}, ${s.read.glasses ? "glasses" : "no glasses"}` : "not read yet", samples: [] });
    by.get(key).samples.push({ name: s.name, coach: whose(s.name) });
  }
  return [...by.values()].map((g) => { const ids = new Set(g.samples.map((x) => x.coach)); return { ...g, coach: ids.size === 1 ? [...ids][0] : null }; });
}

// ── the starting pictures ────────────────────────────────────────────────────
/**
 * Where a start picture is cut from a frame (pure). The captions of a coach's video sit low (their bottom on the edge
 * of Meta's live area), so the shirt's print must end above them: the head's top at one of `head_tops` of the height (the
 * first that works) and the print's bottom no lower than `print_bottom`. `span` is how much of the height lies between the two — the framing:
 * a larger span is a closer shot. Never an enlargement past MIN_CROP_W px of the frame's own width (it would be soft).
 * Returns { x, y, w, h, clear (the print ends above the captions), head_top, print_bottom } in the frame's pixels, or
 * null when the frame cannot be cut that way.
 */
export const START = { head_tops: [0.1, 0.07, 0.05, 0.04], print_bottom: 0.54, min_crop_w: 470, out: [720, 1280] };
export const FRAMINGS = [{ id: "close", span: 0.41 }, { id: "wide", span: 0.33 }];
export function startCrop({ width, height, head, print, span = FRAMINGS[0].span }) {
  if (!Array.isArray(head) || head.length !== 4) return null;
  const hy = head[0] / 1000, cx = (head[1] + head[3]) / 2000, chin = head[2] / 1000, has = Array.isArray(print) && print.length === 4;
  // Without a print to keep clear, the shirt's chest is taken as 1.6 heads below the chin.
  const pb = has ? print[2] / 1000 : Math.min(1, chin + (chin - hy) * 1.6);
  if (!(pb > hy) || hy >= 1) return null;
  const soft = width / START.min_crop_w, want = span / (pb - hy);
  // The head a little higher when that is what keeps the print above the captions; else the first placing, print or not.
  let pick = null;
  for (const ht of START.head_tops) {
    const lo = Math.max(1, (1 - ht) / (1 - hy), hy > 0 ? ht / hy : Infinity), hi = Math.min(soft, (START.print_bottom - ht) / (pb - hy));
    if (lo <= hi) { pick = { ht, s: Math.max(lo, Math.min(hi, want)), clear: true }; break; }
  }
  if (!pick) { const ht = START.head_tops[0], lo = Math.max(1, (1 - ht) / (1 - hy), hy > 0 ? ht / hy : Infinity); if (lo > soft) return null; pick = { ht, s: Math.max(lo, Math.min(soft, want)), clear: !has }; }
  const h = Math.min(height, Math.round(height / pick.s)), w = Math.min(width, Math.round((h * 9) / 16));
  const y = Math.max(0, Math.min(height - h, Math.round(hy * height - pick.ht * h))), x = Math.max(0, Math.min(width - w, Math.round(cx * width - w / 2)));
  const head_top = (hy * height - y) / h, print_bottom = (pb * height - y) / h;
  if (head_top < 0.03 || (chin * height - y) / h > 0.6) return null;
  return { x, y, w, h, clear: !has || print_bottom <= START.print_bottom + 0.004, head_top: Math.round(head_top * 1000) / 1000, print_bottom: Math.round(print_bottom * 1000) / 1000 };
}
const goodFrame = (x) => x.people === 1 && x.looks_at_lens && x.eyes_open && x.sharp !== false && x.ready !== false;
const coachKey = (id) => String(id).replace(/^coach-/, "");
const most = (xs) => { const n = new Map(); for (const x of xs.filter(Boolean)) n.set(x, (n.get(x) || 0) + 1); return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };

/**
 * Each coach's starting pictures, cut from the real frames of the samples the owner named for them (ffmpeg; no model
 * call): for each sample the best frame a clip can start from — looking into the lens, eyes open, sharp, the mouth
 * closed where one is — in each framing it can be cut to. Kept in video-samples/starts/{coach}/ and listed on the
 * coach (`starts`), with what the samples say they wear, how they sound (unless the owner wrote that) and the gym's
 * uniform. One the owner took off stays off. Returns [{ id, starts, refs }].
 */
export function buildStarts(gymDir) {
  const d = readCoaches(gymDir), all = samples(gymDir), dir = join(gymDir, SAMPLES_DIR), out = [];
  for (const c of d.coaches) {
    const mine = all.filter((s) => (c.samples || []).includes(s.name) && s.read), key = coachKey(c.id), folder = join(dir, "starts", key), was = new Map((c.starts || []).map((x) => [x.file, x])), starts = [], refs = [];
    for (const s of mine) {
      // The mouth closed before anything; then the hands low; then not the video's very first or last frame (someone stepping in, or reaching for the phone); then the earliest.
      const edge = (x) => Number(x.index === 0 || x.index === s.read.frames.length - 1);
      // (2026-11-17: BFIT's first re-make started a coach from a frame of him seated and leaning, the shirt's words creased: every take failed the uniform check. A frame whose print reads in full comes before anything else, and only such a picture is "clear".)
      const flat = (x) => Number(x.print_readable !== false);
      const good = s.read.frames.filter(goodFrame).sort((a, b) => flat(b) - flat(a) || Number(!!b.mouth_closed) - Number(!!a.mouth_closed) || Number(!!b.hands_low) - Number(!!a.hands_low) || edge(a) - edge(b) || a.at - b.at), best = good[0];
      if (!best) continue;
      const src = join(dir, "frames", basename(s.name, extname(s.name)), `at-${best.at.toFixed(2).padStart(7, "0")}.jpg`);
      if (!existsSync(src)) continue;
      for (const fr of FRAMINGS) {
        const crop = startCrop({ width: s.width, height: s.height, head: best.head_box, print: best.print_box, span: fr.span });
        if (!crop || starts.some((x) => x.sample === s.name && x.w === crop.w)) continue;   // a frame filmed close has one framing
        const file = join("starts", key, `${basename(s.name, extname(s.name))}-${best.at.toFixed(1)}-${fr.id}.jpg`);
        if (!existsSync(join(dir, file))) {
          mkdirSync(folder, { recursive: true });
          const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${START.out[0]}:${START.out[1]}:flags=lanczos`, "-q:v", "2", join(dir, file)]);
          if (r.status !== 0) continue;
        }
        // A picture of someone sitting is used only when there is none of them standing: seated and leaning, the shirt's words crease, and the reader does not see that (it called BFIT's creased print readable in every frame).
        starts.push({ file, sample: s.name, at: best.at, framing: fr.id, spot: s.read.spot, w: crop.w, clear: crop.clear && best.print_readable !== false && !s.read.seated, ...(best.print_readable === false ? { creased: true } : {}), ...(s.read.seated ? { seated: true } : {}), ...(was.get(file)?.off ? { off: was.get(file).off } : {}) });
      }
      if (good[1]) refs.push({ sample: s.name, at: good[1].at });
    }
    // The clearest and sharpest first; then one spot after another, so two cuts in a row are not the same place.
    starts.sort((a, b) => Number(b.clear) - Number(a.clear) || b.w - a.w || a.file.localeCompare(b.file));
    c.starts = starts; c.wears = { top: most(mine.map((s) => s.read.top)), bottom: most(mine.map((s) => s.read.bottom)), glasses: mine.filter((s) => s.read.glasses).length * 2 > mine.length };
    if (c.voice?.by !== "owner") { const v = voiceFrom(mine); if (v) c.voice = v; }
    out.push({ id: c.id, starts: starts.length, refs: refs.length });
  }
  const words = most(all.filter((s) => s.read).map((s) => s.read.shirt_words.toUpperCase()));
  if (d.uniform?.by !== "owner" && words) d.uniform = { words, logo: most(all.filter((s) => s.read && s.read.shirt_words.toUpperCase() === words).map((s) => s.read.shirt_logo)) || "", by: "read" };
  write(gymDir, d);
  return out;
}
/** A coach's voice as a video model is told it: from the sample where one person says the most, with how fast they speak there. */
function voiceFrom(mine) {
  // A sample with music over it (a white-paper video's soundtrack) is no sample of the coach's voice: the reader describes the singer (2026-11-20, F45 Xinyi).
  const music = (h) => /\b(music|sing|singer|singing|vocals?|lyrics?|song)\b/i.test(`${h.voice} ${h.energy} ${h.accent}`);
  const best = mine.filter((s) => s.read.heard?.voice && !music(s.read.heard)).sort((a, b) => Number(a.read.heard.speakers !== 1) - Number(b.read.heard.speakers !== 1) || b.read.heard.words - a.read.heard.words)[0];
  if (!best) return null;
  const h = best.read.heard, strip = (t) => norm(t).replace(/[.\s]+$/, "");
  return { description: `${strip(h.voice)}; ${strip(h.pitch)} pitch; ${strip(h.accent)} accent; ${strip(h.energy)}`.replace(/^([A-Z])/, (m) => m.toLowerCase()), from: best.name, per_second: h.per_second, by: "read" };
}
/** The owner's own words for how a coach sounds (they replace the reading and are never overwritten by one); empty goes back to the reading. */
export function setVoice(gymDir, id, text) {
  const d = readCoaches(gymDir), c = d.coaches.find((x) => x.id === id);
  if (!c) throw new Error(`this gym has no coach ${id}`);
  const t = norm(text);
  if (t && (t.length < 12 || t.length > 400)) throw new Error("describe the voice in 12 to 400 characters: its depth, accent and manner");
  if (t) c.voice = { description: t, by: "owner", on: today() }; else { c.voice = null; }
  write(gymDir, d); if (!t) buildStarts(gymDir);
  return readCoaches(gymDir).coaches.find((x) => x.id === id);
}
/** Take a starting picture off (a reason is required; the file stays) or put it back. */
export function switchStart(gymDir, id, file, { on, reason = null } = {}) {
  const d = readCoaches(gymDir), c = d.coaches.find((x) => x.id === id), s = c?.starts?.find((x) => x.file === file);
  if (!c) throw new Error(`this gym has no coach ${id}`);
  if (!s) throw new Error("no such starting picture for this coach");
  if (!on && norm(reason).length < 3) throw new Error("say why this picture is taken off: it is kept on file, never deleted");
  if (on) delete s.off; else s.off = { reason: norm(reason), on: today() };
  write(gymDir, d);
  return c;
}
/** The gym's uniform as the owner states it: the words printed on the shirt, exactly, and its logo in a few words. */
export function setUniform(gymDir, { words, logo = "" } = {}) {
  const d = readCoaches(gymDir), w = norm(words).toUpperCase();
  if (w.length > 80) throw new Error("the words on the shirt are at most 80 characters");
  d.uniform = { words: w, logo: norm(logo), by: "owner", on: today() };
  write(gymDir, d);
  return d.uniform;
}

// ── a coach as the makers take one ───────────────────────────────────────────
const liveStarts = (c) => (c.starts || []).filter((s) => !s.off);
/**
 * Why this coach cannot be filmed, or null: consent for the face and the voice (the videos speak), switched on, and
 * a starting picture to film from.
 */
export function coachWhy(coach) {
  const u = usable(coach, { voice: true }); if (!u.ok) return u.why;
  if (!liveStarts(coach).length) return `${coach.name} has no starting picture yet: add sample videos of them, say who they show and read the samples (Photos & assets → Coach videos)`;
  return null;
}
export const readyCoaches = (gymDir) => readCoaches(gymDir).coaches.filter((c) => !coachWhy(c));
/**
 * Why this coach cannot front a white-paper video, or null (2026-11-17, tested on BFIT: about US$0.60). The words are
 * written by software on white paper the app finds in the picture, and white paper held against a white top cannot
 * be told from it — both pictures of the coach in the white uniform were refused for it.
 */
export function paperWhy(coach) {
  const top = norm(coach?.wears?.top).toLowerCase();
  return /\b(white|cream|ivory|off-white)\b/.test(top) ? `${coach.name} wears a white top in their samples: white paper cannot be told from it, so a white-paper video of them is not made (a talking video or one with exercises is)` : null;
}
/**
 * The coach for each of `count` videos, shared evenly between the coaches who can be filmed (`only`: this one for
 * all of them) — in the list's own order, starting where the seed says, so a re-run picks the same. Throws in words
 * when nobody can be filmed.
 */
export function pickCoaches(gymDir, count, { only = null, seed = "", paper = false } = {}) {
  // `paper`: for white-paper videos — never a coach whose top the paper cannot be told from.
  // A spoken video needs the coach's voice described (2026-11-20, F45 Xinyi: one coach's only samples were silent white-paper videos with music, so no voice could be read): such a coach fronts white-paper videos only.
  const all = readCoaches(gymDir).coaches, whyNot = (c) => coachWhy(c) || (paper ? paperWhy(c) : !norm(c.voice?.description) ? `${c.name}'s voice is not on file yet (add a sample of them talking, or describe it): they front white-paper videos only` : null);
  if (!count) return [];
  if (only) { const c = all.find((x) => x.id === only); if (!c) throw new Error(`this gym has no coach ${only}`); const why = whyNot(c); if (why) throw new Error(why); return Array.from({ length: count }, () => c); }
  const ready = all.filter((c) => !whyNot(c));
  if (!ready.length) throw new Error(all.length ? `no coach can be filmed${paper ? " for a white-paper video" : ""} yet — ${all.map(whyNot).filter(Boolean).join("; ")}` : "this gym has no coach on its list yet: add one on Ad defaults → Presenter · videos");
  const start = seed ? parseInt(createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16) % ready.length : 0;
  return Array.from({ length: count }, (_, i) => ready[(start + i) % ready.length]);
}
/**
 * A coach as a maker takes one: { id, key, name, voice, starts[] (files, a different place or framing from one cut to
 * the next where there is one), refs[] (two real pictures a re-made one is made from), wears, uniform { words, logo } }.
 */
export function coachForVideo(gymDir, coach) {
  const why = coachWhy(coach); if (why) throw new Error(why);
  const dir = join(gymDir, SAMPLES_DIR), live = liveStarts(coach), clear = live.filter((s) => s.clear), pool = clear.length ? clear : live;
  // One from each sample in turn, then the second framings: neighbours differ in place where the samples allow it.
  const bySample = new Map(); for (const s of pool) bySample.set(s.sample, [...(bySample.get(s.sample) || []), s]);
  const order = []; for (let k = 0; order.length < pool.length; k++) for (const xs of bySample.values()) if (xs[k]) order.push(xs[k]);
  const files = order.map((s) => join(dir, s.file));
  return { id: coach.id, key: coachKey(coach.id), name: coach.name, voice: coach.voice?.description || null, starts: files, spots: order.map((s) => s.spot), refs: [files[0], files.find((f, i) => order[i].sample !== order[0].sample) || files[1] || files[0]], wears: coach.wears || null, uniform: readCoaches(gymDir).uniform || null };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    "brand-dir": { type: "string" }, "add-sample": { type: "string", multiple: true }, frames: { type: "boolean", default: false }, every: { type: "string" },
    coach: { type: "string" }, note: { type: "string" }, consent: { type: "string" }, face: { type: "boolean", default: false }, voice: { type: "boolean", default: false }, by: { type: "string" }, shows: { type: "string" }, samples: { type: "string" }, list: { type: "boolean", default: false }, read: { type: "boolean", default: false }, again: { type: "string" }, max: { type: "string" }, starts: { type: "boolean", default: false },
  } });
  if (!v["brand-dir"]) { console.error("Usage: coach-look.mjs --brand-dir <brands/x> (--add-sample <file> [--frames] | --coach <name> | --consent <id> --face [--voice] --by <who, how> | --list)"); process.exit(1); }
  const gymDir = resolve(v["brand-dir"]);
  try {
    for (const f of v["add-sample"] || []) {
      const s = addSample(gymDir, f);
      console.log(`${s.already ? "already on file" : "added"}: ${s.name} (${s.original})${s.kind === "video" ? ` · ${s.seconds} s · ${s.width}×${s.height}${s.audio ? "" : " · no sound"}` : ""}`);
      if (v.frames && s.kind === "video") console.log(`  ${extractFrames(gymDir, s.name, { every: v.every ? Number(v.every) : 1 }).length} frames in ${join(SAMPLES_DIR, "frames", basename(s.name, extname(s.name)))}`);
    }
    if (v.coach) { const c = addCoach(gymDir, { name: v.coach, note: v.note }); console.log(`coach added: ${c.name} (${c.id}) — no consent on file yet: nothing is made in their likeness until there is`); }
    if (v.consent) { const c = setConsent(gymDir, v.consent, { face: v.face, voice: v.voice, by: v.by, note: v.note }); console.log(`${c.name}: consent recorded — face ${c.consent.face ? "yes" : "no"}, voice ${c.consent.voice ? "yes" : "no"} (${c.consent.by}, ${c.consent.on})`); }
    if (v.shows) { const c = setSamples(gymDir, v.shows, String(v.samples || "").split(","), v.note !== undefined && !v.coach && !v.consent ? { note: v.note } : {}); console.log(`${c.name}: shown in ${c.samples.length ? c.samples.join(", ") : "no sample"}`); }
    if (v.read) { const r = await readSamples({ gymDir, max: v.max ? Number(v.max) : 40, again: v.again === "look" ? "look" : v.again === "all", log: console.log }); console.log(`read ${r.read.length} sample(s), ${r.calls} call(s)${r.left ? `, ${r.left} left` : ""}${r.failed.length ? `, ${r.failed.length} could not be read` : ""}`); }
    if (v.read || v.starts) for (const x of buildStarts(gymDir)) console.log(`${x.id}: ${x.starts} starting picture(s)`);
    if (v.list) {
      for (const s of samples(gymDir)) console.log(`sample ${s.name} · ${s.original}${s.kind === "video" ? ` · ${s.seconds} s` : ""}`);
      for (const c of readCoaches(gymDir).coaches) { const u = usable(c); console.log(`coach ${c.name} (${c.id}) · ${(c.samples || []).length} samples · ${u.ok ? `may be generated${usable(c, { voice: true }).ok ? ", voice too" : " (not their voice)"}` : u.why}`); }
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
