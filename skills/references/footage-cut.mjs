#!/usr/bin/env node
/**
 * The raw-footage editor, stage 2: the video is cut from the cutting sheet, with captions (2026-11-20).
 *
 * Stage 1 (footage-editor.mjs) lays every take against the script and keeps the owner's choices; this file cuts what
 * the sheet says, the way the four hand cuts he passed were made. **Nothing is generated**: no image call, no video
 * call, no model call at all — ffmpeg cuts, headless Chrome draws the captions, and the words are timed on this Mac.
 *
 * **Word timing** (`timeWords`, pure): captions spread evenly over a line drift on real speech (a pace that changes
 * mid-line ran them up to 0.9 s out on the first hand cut), so the words are timed pause by pause. Where the voice
 * sounds comes from the clip's own levels (`stretchesOf`: the voice band every 20 ms; a stretch is sound above the
 * line between the room and the voice, a pause 0.14 s or more of quiet). Which words fall in which stretch comes from
 * whisper.cpp on this Mac (`hearWords`: its word times are good to a few tenths of a second and it mishears a word
 * now and then — enough to sort words between pauses, not to time them; the caption's words are the sheet's, never
 * whisper's). Inside a stretch the words share its time by their syllables. A stretch no word falls in — a weight
 * set down, a ball slammed before the line — is not speech and is left out of the take. Without whisper on the Mac
 * the words are shared over the stretches by their length, and the cut says so.
 *
 * **What is kept of a take** (`keptRanges`): from just before its first word to just after its last (`CUT.lead`,
 * `CUT.tail`), and — the owner's ruling, on by default with a switch a shoot (`choices.tighten`) — a pause of
 * `CUT.long_pause` or more inside it is tightened to `CUT.pause_to` with a jump cut.
 *
 * **The pieces** (`planCut`, pure): the sheet's lines in their order, each part's take as its kept ranges; a line
 * that shows its take plays picture and sound together; a line that shows footage (a voice recording, or B-roll over
 * a line said to camera) plays the take's sound under its clips, shared out in shots of `CUT.min_shot` or more, each
 * from the middle of its clip, a clip used twice starting where it left off. Sound is levelled per source (a voice
 * recording is far louder than a phone's), faded only where the sound really changes, and normalised once.
 *
 * **Captions**: the gym's own caption look (white capitals, the word being said in the accent colour), three words
 * at most, a block ending at a clause or a real pause, held through a short pause so they do not blink, never held
 * across a change of take; every block inside Meta's 9:16 live area (a cut with one outside is refused in words).
 * Numbers read as the script writes them ("6 weeks", "week 1").
 *
 * The result — `brands/{gym}/footage/{shoot}/cuts/cut-{n}.mp4` and `.json` (the pieces, the captions, what differs
 * from the script) — is the owner's to watch; adding it to the gym's ads is his click (footage-video.mjs).
 *
 * CLI: footage-cut.mjs --brand-dir brands/{gym} --shoot id [--plan]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readShoot, syncFiles, buildSheet, shootDir, wordsOf, near } from "./footage-editor.mjs";

export const CUT = { lead: 0.12, tail: 0.25, long_pause: 0.9, pause_to: 0.4, min_shot: 1.2, W: 1080, H: 1920, fps: 30, hold: 0.6, after: 0.2, pause: 0.3, gap: 0.14, min_stretch: 0.1, line: 0.32, target_db: -20 };
const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const WHISPER = { bin: "whisper-cli", model: join(REPO, "library", "models", "ggml-small.en.bin"), dtw: "small.en" };
const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;

// ── where the voice sounds ───────────────────────────────────────────────────
/** The stretches of sound in a clip's levels between two moments, and the levels' floor, top and the line between them. Pure. */
export function stretchesOf(levels, from, to, step = 0.02) {
  if (!levels?.length) return { out: [], floor: null, top: null, line: null };
  const sorted = [...levels].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)], top = sorted[Math.floor(sorted.length * 0.95)], line = floor + CUT.line * (top - floor);
  const i0 = Math.max(0, Math.round(from / step)), i1 = Math.min(levels.length, Math.round(to / step)), out = []; let a = null, quiet = 0;
  for (let i = i0; i <= i1; i++) {
    const loud = i < i1 && levels[i] > line;
    if (loud) { if (a == null) a = i; quiet = 0; }
    else if (a != null) { quiet++; if (quiet * step >= CUT.gap || i >= i1) { const b = i - quiet + 1; if ((b - a) * step >= CUT.min_stretch) out.push([r2(a * step), r2(b * step)]); a = null; quiet = 0; } }
  }
  return { out, floor: Math.round(floor), top: Math.round(top), line: Math.round(line) };
}
export const hasWhisper = (w = WHISPER) => existsSync(w.model) && spawnSync(w.bin, ["--help"], { stdio: "ignore" }).status === 0;
/** The words whisper.cpp hears between two moments of a file, each with the second it starts (in the file's own time). Local: nothing leaves the Mac. */
export function hearWords(file, from, to, w = WHISPER) {
  const dir = mkdtempSync(join(tmpdir(), "hear-")), a = Math.max(0, from - 0.3);
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(a), "-t", String(to + 0.3 - a), "-i", file, "-vn", "-ac", "1", "-ar", "16000", join(dir, "a.wav")]);
    const r = spawnSync(w.bin, ["-m", w.model, "-f", join(dir, "a.wav"), "-ml", "1", "-sow", ...(w.dtw ? ["-dtw", w.dtw] : []), "-np", "-oj", "-of", join(dir, "a")], { stdio: "ignore" });
    if (r.status !== 0 || !existsSync(join(dir, "a.json"))) return [];
    return (JSON.parse(readFileSync(join(dir, "a.json"), "utf-8")).transcription || []).map((t) => ({ text: String(t.text || "").trim(), at: r2(a + (t.offsets?.from || 0) / 1000) })).filter((t) => wordsOf(t.text).length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const syl = (w) => { const s = String(w).toLowerCase().replace(/[^a-z0-9]/g, ""); if (/^\d+$/.test(s)) return Math.max(1, s.length); const m = s.replace(/e$/, "").match(/[aeiouy]+/g); return Math.max(1, m ? m.length : 1); };
/**
 * Which stretch of sound each word falls in: the words in order, the stretches in order, a stretch may hold none (a
 * weight set down, the next line's first words inside the window). Chosen so that every stretch is spoken at a
 * believable pace (`PACE.ideal` syllables a second: three syllables cannot sit in a fifth of a second) and the words
 * lie near where they were heard — loosely, since whisper puts a line's first words early, in the silence before the
 * voice. Pure. → the stretch index of each word.
 */
export const EDGE = { short: 0.4, syllables: 2, share: 0.15 };
export const PACE = { ideal: 5, rate: 1.5, empty: 0.25, empty_s: 0.6, heard: 0.4, slack: 0.15 };
export function assignWords(syls, at, S) {
  const n = syls.length, m = S.length, pre = [0]; for (const x of syls) pre.push(pre.at(-1) + x);
  const far = (i, k) => { if (at[i] == null) return 0; const [a, b] = S[k], d = at[i] < a - PACE.slack ? a - PACE.slack - at[i] : at[i] > b + PACE.slack ? at[i] - b - PACE.slack : 0; return PACE.heard * Math.min(1, d); };
  const cost = (k, i, j) => {                              // words i..j-1 in stretch k
    const dur = Math.max(0.05, S[k][1] - S[k][0]); if (i === j) return PACE.empty + PACE.empty_s * dur;
    const rate = (pre[j] - pre[i]) / dur; let c = PACE.rate * Math.log(rate / PACE.ideal) ** 2;
    for (let w = i; w < j; w++) c += far(w, k); return c;
  };
  // best[k][j]: the least cost of putting the first j words in the first k stretches
  const best = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity)), from = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0)); best[0][0] = 0;
  for (let k = 1; k <= m; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= j; i++) { if (best[k - 1][i] === Infinity) continue; const c = best[k - 1][i] + cost(k - 1, i, j); if (c < best[k][j]) { best[k][j] = c; from[k][j] = i; } }
  const idx = new Array(n).fill(0); for (let k = m, j = n; k >= 1; k--) { const i = from[k][j]; for (let w = i; w < j; w++) idx[w] = k - 1; j = i; }
  return idx;
}
/**
 * A take's words in time. `text`: the words as the captions show them; `stretches`: where the voice sounds
 * ([[from, to]] in the file's time); `heard`: whisper's words with their times (may be empty). Pure.
 * → { words[{ text, from, to }], used[[from, to]] (the stretches words fall in), by: "heard" | "pace" }
 */
export function timeWords(text, stretches, heard = []) {
  const written = String(text || "").split(/\s+/).filter(Boolean), n = written.length, S = [...(stretches || [])];
  if (!n || !S.length) return { words: [], used: [], by: "none" };
  const W = written.map((w) => wordsOf(w).join("")), H = heard.flatMap((h) => wordsOf(h.text).map((k) => ({ k, at: h.at })));
  // The moment each written word was heard: the longest in-order match with what whisper heard (a word it missed has none).
  const at = new Array(n).fill(null);
  if (H.length) {
    const m = H.length, t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) t[i][j] = W[i - 1] && near(W[i - 1], H[j - 1].k) ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
    for (let i = n, j = m; i > 0 && j > 0; ) { if (W[i - 1] && near(W[i - 1], H[j - 1].k)) { at[i - 1] = H[j - 1].at; i--; j--; } else if (t[i][j - 1] >= t[i - 1][j]) j--; else i--; }
  }
  const by = at.filter((x) => x != null).length >= Math.max(1, Math.ceil(n * 0.4)) ? "heard" : "pace";
  const syls = written.map(syl), when = by === "heard" ? at : new Array(n).fill(null), all = syls.reduce((t, x) => t + x, 0), words = [];
  // A short sound alone at the edge of the take, a long pause away from the rest and holding next to none of the line, is a
  // noise (the end of someone's "okay" before the line, a weight set down after it): it is left out and the words are placed again.
  let Sx = S, idx = assignWords(syls, when, Sx);
  for (let pass = 0; pass < 4 && Sx.length > 1; pass++) {
    const usedK = [...new Set(idx)].sort((x, y) => x - y), edge = (k, other) => { const mine = syls.filter((_, i) => idx[i] === k).reduce((t, x) => t + x, 0), gap = other > k ? Sx[other][0] - Sx[k][1] : Sx[k][0] - Sx[other][1]; return Sx[k][1] - Sx[k][0] < EDGE.short && mine <= Math.max(EDGE.syllables, all * EDGE.share) && gap >= CUT.long_pause; };
    if (usedK.length < 2) break;
    const drop = edge(usedK[0], usedK[1]) ? usedK[0] : edge(usedK.at(-1), usedK.at(-2)) ? usedK.at(-1) : -1; if (drop < 0) break;
    Sx = Sx.filter((_, k) => k !== drop); idx = assignWords(syls, when, Sx);
  }
  const keep = [...Sx]; S.length = 0; S.push(...keep);
  for (let k = 0; k < S.length; k++) {
    const mine = []; for (let i = 0; i < n; i++) if (idx[i] === k) mine.push(i); if (!mine.length) continue;
    const [a, b] = S[k], sum = mine.reduce((s, i) => s + syls[i], 0); let x = a;
    for (const i of mine) { const d = ((b - a) * syls[i]) / sum; words.push({ text: written[i], from: r2(x), to: r2(x + d) }); x += d; }
  }
  return { words, used: S.filter((_, k) => idx.includes(k)), by };
}
/** What is kept of a take: from just before its first word to just after its last, a long pause inside it tightened (a jump cut). Pure. */
export function keptRanges(used, { tighten = true, duration = Infinity, floor = 0 } = {}) {
  if (!used.length) return [];
  const out = []; let a = Math.max(floor, used[0][0] - CUT.lead);
  for (let k = 0; k < used.length - 1; k++) {
    const gap = used[k + 1][0] - used[k][1];
    if (tighten && gap >= CUT.long_pause) { out.push([r3(a), r3(used[k][1] + CUT.pause_to / 2)]); a = used[k + 1][0] - CUT.pause_to / 2; }
  }
  out.push([r3(a), r3(Math.min(duration, used.at(-1)[1] + CUT.tail))]);
  return out;
}
const NUMBER = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12" };
/** Numbers as the script writes them: a number word beside "week(s)", or counting people or places, is its digit ("6 weeks", "week 1", "10 individuals"). */
export function digitsIn(text) {
  const joined = new RegExp(`\\b(${Object.keys(NUMBER).join("|")})-(weeks?|days?|months?)\\b`, "gi");      // "six-weeks" as it is often heard written
  const w = String(text || "").replace(joined, (m, a, b) => `${NUMBER[a.toLowerCase()]} ${b}`).split(/\s+/), bare = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return w.map((x, i) => { const b = bare(x), prev = bare(w[i - 1]), next = bare(w[i + 1]); return NUMBER[b] && (prev === "week" || /^weeks?$/.test(next) || /^(individuals|people|spots|places|days)$/.test(next)) ? x.replace(new RegExp(b, "i"), NUMBER[b]) : x; }).join(" ").replace(/(\d)-(weeks?)\b/gi, "$1 $2");
}

// ── the pieces ───────────────────────────────────────────────────────────────
const takeKey = (t) => `${t.file}@${t.from}`;
/**
 * The cut as pieces, from the sheet and each take's timing (`timings[takeKey] { words, used, top }`). Pure.
 * → { pieces[{ line, v: [file, from, to], a: [file, from, to], take, footage? }], words[{ text, from, to, line, take }]
 *     (on the video's clock), seconds, notes[] }
 * Two takes that follow one another in the same file (one clip holding several lines) are joined where they meet:
 * the sound is never played twice, and the picture runs on without a jump unless there is a long pause to tighten.
 */
export function planCut(sheet, timings, { files = {}, tighten = true } = {}) {
  const notes = [], lenOf = (key) => files[key]?.seconds ?? Infinity;
  // 1. every line's sound, range by range, with where its voice starts and ends
  const segs = [];
  for (const row of sheet.lines) {
    if (row.drop || row.missing) continue;
    for (const p of row.parts) {
      const t = p.takes[p.pick], tm = timings[takeKey(t)];
      if (!tm?.used?.length) { notes.push(`line ${row.n}: no voice was found in ${t.file} between ${t.from} and ${t.to} s, so it is left out`); continue; }
      if (row.show !== "footage" && files[t.file]?.video === false) { notes.push(`line ${row.n}: its take is sound only and it has no footage, so it is left out`); continue; }
      const ranges = keptRanges(tm.used, { tighten, duration: lenOf(t.file) });
      ranges.forEach(([a, b], i) => segs.push({ row, take: takeKey(t), file: t.file, a, b, voiceA: i === 0 ? tm.used[0][0] : a + CUT.pause_to / 2, voiceB: i === ranges.length - 1 ? tm.used.at(-1)[1] : b - CUT.pause_to / 2, words: tm.words }));
    }
  }
  // 2. takes that follow one another in one file meet half-way between the two voices
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], s = segs[i];
    if (p.file !== s.file || s.voiceA < p.voiceB) continue;
    const pause = s.voiceA - p.voiceB;
    if (s.a < p.b || (pause < CUT.long_pause && s.a - p.b < CUT.long_pause)) { const mid = r3((p.voiceB + s.voiceA) / 2); p.b = mid; s.a = mid; }
  }
  // 3. the pieces and the words on the video's clock
  const pieces = [], words = [], played = new Map(); let at = 0;
  const rows = [...new Set(segs.map((s) => s.row))];
  for (const row of rows) {
    const sound = segs.filter((s) => s.row === row), total = sound.reduce((s, x) => s + (x.b - x.a), 0); let off = at;
    for (const x of sound) { for (const w of x.words) if (w.from >= x.a - 0.02 && w.from < x.b) words.push({ text: w.text, from: r2(off + Math.max(0, w.from - x.a)), to: r2(off + Math.min(w.to, x.b) - x.a), line: row.n, take: x.take }); off += x.b - x.a; }
    if (row.show !== "footage" || !(row.pictures || []).length) { for (const x of sound) pieces.push({ line: row.n, v: [x.file, x.a, x.b], a: [x.file, x.a, x.b], take: x.take }); at += total; continue; }
    // Footage under the sound: shots of an even length, each from the middle of its clip; a clip used again goes on from where it stopped.
    const clips = row.pictures, n = Math.max(1, Math.min(clips.length, Math.floor(total / CUT.min_shot) || 1)), shots = [];
    for (let i = 0; i < n; i++) {
      const key = clips[i], d = total / n, L = lenOf(key), from0 = played.has(key) ? played.get(key) : Math.min(Math.max(0.3, 0.15 * L), Math.max(0, L - d - 0.1));
      const from = Number.isFinite(L) && from0 + d > L ? Math.max(0, L - d) : from0;
      shots.push({ key, from: r3(from), d }); played.set(key, from + d);
      if (Number.isFinite(L) && d > L) notes.push(`line ${row.n}: ${key} is ${r2(L)} s, shorter than the ${r2(d)} s it has to cover: its last frame holds`);
    }
    // sound ranges and shots walked together, so every piece has one picture and one stretch of sound of the same length
    let si = 0, sLeft = shots[0].d, sAt = shots[0].from;
    for (const x of sound) {
      let a = x.a;
      while (x.b - a > 1e-6) {
        const d = Math.min(x.b - a, sLeft > 1e-6 ? sLeft : x.b - a);
        pieces.push({ line: row.n, v: [shots[si].key, r3(sAt), r3(sAt + d)], a: [x.file, r3(a), r3(a + d)], take: x.take, footage: true });
        a += d; sAt += d; sLeft -= d;
        if (sLeft <= 1e-6 && si < shots.length - 1) { si++; sLeft = shots[si].d; sAt = shots[si].from; }
      }
    }
    at += total;
  }
  return { pieces, words, seconds: r2(at), notes };
}
/** The caption blocks from the words on the video's clock: three words at most, a block ends at a clause or a real pause, is held through a short one, and never past its own take. Pure. */
export function captionBlocks(words, takeEnds = {}, seconds = Infinity) {
  const blocks = []; let phrase = [];
  const flush = () => { if (!phrase.length) return; const k = Math.ceil(phrase.length / 3); let x = 0; for (let b = 0; b < k; b++) { const size = Math.ceil((phrase.length - x) / (k - b)); blocks.push({ take: phrase[0].take, line: phrase[0].line, words: phrase.slice(x, x + size) }); x += size; } phrase = []; };
  words.forEach((w, i) => { const next = words[i + 1]; phrase.push(w); const gap = next ? next.from - w.to : Infinity, clause = /[.,;:!?]$/.test(w.text); if (clause || !next || next.take !== w.take || gap >= CUT.hold || (gap >= CUT.pause && phrase.length >= 2)) flush(); });
  const shots = [];
  blocks.forEach((b, bi) => {
    const text = b.words.map((w) => w.text).join(" ").replace(/[.,;:]+$/, ""), nb = blocks[bi + 1]; b.text = text; b.from = b.words[0].from;
    b.words.forEach((w, i) => {
      const next = b.words[i + 1]; let to;
      if (next) to = next.from; else { const start = nb ? nb.words[0].from : Infinity, same = nb && nb.take === b.take; to = same && start - w.to <= CUT.hold ? start : Math.min(w.to + CUT.after, start, same ? Infinity : takeEnds[b.take] ?? Infinity); }
      to = r2(Math.min(to, seconds)); if (to > w.from) shots.push({ bi, i, text, from: w.from, to }); b.to = to;
    });
  });
  return { blocks, shots };
}

// ── the run ──────────────────────────────────────────────────────────────────
const ff = (args) => { const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`ffmpeg could not do this step: ${String(r.stderr || r.error?.message || "").trim().split("\n").slice(-3).join(" · ").slice(0, 400)}`); };
/**
 * The captions laid over a video as ONE track: the pictures in their order with an empty frame between them, read as
 * a single input. (One input a picture, as the short generated videos do, runs out of open files on a long cut: a
 * 72-second cut has some 250 caption pictures and a Mac opens 256 files at most.)
 */
export function layCaptions(base, shots, final, dir, { W = CUT.W, H = CUT.H, fps = CUT.fps, seconds = null } = {}) {
  const blank = join(dir, "blank.png"), list = join(dir, "captions.txt"), q = (p) => `file '${resolve(String(p)).replace(/'/g, "'\\''")}'`;      // full paths: a list's own entries are read from the list's folder otherwise
  ff(["-f", "lavfi", "-i", `color=c=black@0.0:s=${W}x${H},format=rgba`, "-frames:v", "1", blank]);
  const lines = ["ffconcat version 1.0"]; let at = 0;
  const add = (file, d) => { if (d > 0.0005) lines.push(q(file), `duration ${d.toFixed(3)}`); };
  for (const o of [...shots].sort((a, b) => a.from - b.from)) { add(blank, o.from - at); add(o.png, o.to - Math.max(o.from, at)); at = Math.max(at, o.to); }
  add(blank, Math.max(0.2, (seconds ?? at) - at)); lines.push(q(blank));                 // (the last entry is named twice: a list's last duration is not kept otherwise)
  writeFileSync(list, lines.join("\n") + "\n");
  ff(["-i", base, "-f", "concat", "-safe", "0", "-i", list, "-filter_complex", `[1:v]fps=${fps},format=rgba[c];[0:v][c]overlay=0:0:eof_action=pass[v]`, "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-preset", "medium", "-c:a", "copy", "-movflags", "+faststart", final]);
}
/** Every take the sheet picked, timed (the levels, the stretches, whisper's hearing where it is installed). */
export async function timeTakes(shoot, sheet, { hear = null, levelsOf = null, log = () => {} } = {}) {
  const PV = await import("./presenter-video.mjs"), levels = levelsOf || PV.levelsOf, canHear = hear ? true : hasWhisper(), listen = hear || ((file, a, b) => hearWords(file, a, b));
  const pathOf = Object.fromEntries(shoot.files.map((f) => [f.key, f.path])), cache = new Map(), out = {};
  for (const row of sheet.lines) {
    if (row.drop || row.missing) continue;
    for (const p of row.parts) {
      const t = p.takes[p.pick], key = takeKey(t); if (out[key]) continue;
      const file = pathOf[t.file]; if (!file || !existsSync(file)) { log(`  ${t.file} is not on this Mac now (is the drive plugged in?)`); continue; }
      if (!cache.has(t.file)) cache.set(t.file, levels(file));
      // The take's window: a little either side of where the listening put it (its times are rough), never past half-way to the phrase before or after it in the clip.
      const ph = (shoot.files.find((f) => f.key === t.file)?.read?.phrases || []), before = ph.filter((x) => x.end <= t.from + 0.05).map((x) => x.end), after = ph.filter((x) => x.start >= t.to - 0.05).map((x) => x.start);
      const lo = Math.max(0, t.from - 0.6, before.length ? (Math.max(...before) + t.from) / 2 : 0), hi = Math.min(t.to + 0.6, after.length ? (t.to + Math.min(...after)) / 2 : Infinity);
      const lv = cache.get(t.file), st = stretchesOf(lv, lo, hi, PV.VOICE.step);
      const heard = canHear ? listen(file, lo, hi) : [];
      const timed = timeWords(digitsIn(t.spoken), st.out, heard);
      out[key] = { ...timed, top: st.top, floor: st.floor, stretches: st.out };
      log(`  line ${row.n} · ${t.file} ${t.from}–${t.to} s: ${timed.words.length} words in ${timed.used.length} stretch(es)${timed.by === "pace" ? " (timed by pace alone: the words could not be heard apart)" : ""}`);
    }
  }
  return out;
}
/**
 * Cut the shoot's video from its sheet. Free: no model is called. → { file, json, seconds, pieces, blocks, outside, notes }
 */
export async function cutShoot({ gymDir: givenDir, id, log = () => {}, deps = {} }) {
  const gymDir = resolve(givenDir);
  const shoot = syncFiles(gymDir, readShoot(gymDir, id)), sheet = buildSheet(shoot);
  if (!sheet.can_cut) throw new Error(sheet.unread ? "listen to every file first: the sheet is not complete" : "the sheet is not ready to cut: every line needs a take (or to be left out), and a voice-only take needs footage under it");
  const [PV, { launchBrowser }, { captionAccentOf }] = await Promise.all([import("./presenter-video.mjs"), import("./render-composites.mjs"), import("./client-config.mjs")]);
  const profile = JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf-8")), tighten = shoot.choices?.tighten !== false;
  log(`timing the words of ${sheet.lines.filter((r) => !r.drop && !r.missing).length} lines${hasWhisper() || deps.hear ? "" : " (whisper is not installed: timed by pace alone)"} …`);
  const timings = await timeTakes(shoot, sheet, { hear: deps.hear, levelsOf: deps.levelsOf, log });
  const files = Object.fromEntries(shoot.files.map((f) => [f.key, { seconds: f.read?.seconds, path: f.path, video: !!f.read?.video }]));
  const plan = planCut(sheet, timings, { files, tighten });
  if (!plan.pieces.length) throw new Error("nothing could be cut: no voice was found in the takes the sheet picked");
  const dir = join(shootDir(gymDir, id), "cuts"); mkdirSync(dir, { recursive: true });
  const n = Math.max(0, ...readdirSync(dir).map((x) => Number((x.match(/^cut-(\d+)\.json$/) || [])[1] || 0))) + 1, name = `cut-${n}`, base = join(dir, `${name}-base.mp4`), final = join(dir, `${name}.mp4`);
  const { W, H, fps } = CUT, inputs = [], chain = [];
  // the cut, no captions: every piece its picture and its sound, levelled per source, faded only where the sound changes
  const on = (x, y) => x && y && x.a[0] === y.a[0] && Math.abs(x.a[2] - y.a[1]) < 0.005, topOf = (p) => timings[p.take]?.top;
  plan.pieces.forEach((p, i) => {
    const d = r3(p.v[2] - p.v[1]); inputs.push("-i", files[p.v[0]].path); const vi = inputs.length / 2 - 1;
    chain.push(`[${vi}:v]trim=${p.v[1]}:${p.v[2]},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},setsar=1,tpad=stop_mode=clone:stop_duration=${d},trim=0:${d},setpts=PTS-STARTPTS[v${i}]`);
    inputs.push("-i", files[p.a[0]].path); const ai = inputs.length / 2 - 1, prev = plan.pieces[i - 1], next = plan.pieces[i + 1], top = topOf(p), gain = top == null ? 0 : Math.max(-12, Math.min(14, CUT.target_db - top));
    chain.push(`[${ai}:a]atrim=${p.a[1]}:${p.a[2]},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${gain}dB${on(prev, p) ? "" : ",afade=t=in:d=0.04"}${on(p, next) ? "" : `,afade=t=out:st=${Math.max(0, r3(p.a[2] - p.a[1]) - 0.04)}:d=0.04`},apad=whole_dur=${d},atrim=0:${d}[a${i}]`);
  });
  chain.push(plan.pieces.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${plan.pieces.length}:v=1:a=1[v][araw]`, `[araw]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`);
  log(`cutting ${plan.pieces.length} pieces, ${plan.seconds} s …`);
  ff([...inputs, "-filter_complex", chain.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", base]);
  // captions
  const takeEnds = {}; let at = 0; for (const p of plan.pieces) { at += p.a[2] - p.a[1]; takeEnds[p.take] = r2(at); }
  const { blocks, shots } = captionBlocks(plan.words, takeEnds, plan.seconds), caps = join(dir, `${name}-caps`); rmSync(caps, { recursive: true, force: true }); mkdirSync(caps, { recursive: true });
  log(`drawing ${shots.length} caption pictures for ${blocks.length} blocks …`);
  const browser = deps.browser || (await launchBrowser()), accent = captionAccentOf(profile) || PV.CAPTION_ACCENT, boxes = [];
  try { for (const s of shots) { const o = await PV.overlay(browser, join(caps, `cap-${String(s.bi).padStart(3, "0")}-${s.i}.png`), PV.capHtml(s.text, s.i), accent, false, W / 720); s.png = o.png; if (s.i === 0) boxes.push(...o.blocks); } }
  finally { if (!deps.browser) await browser.close(); }
  const L = PV.LIVE, outside = boxes.filter((b) => b.left < L.left - 0.001 || b.right > L.right + 0.001 || b.top < L.top - 0.001 || b.bottom > L.bottom + 0.001).map((b) => b.text);
  if (outside.length) { rmSync(base, { force: true }); rmSync(caps, { recursive: true, force: true }); throw new Error(`a caption would sit outside Meta's live area (${outside.slice(0, 3).join(" | ")}): the cut was not made`); }
  try { layCaptions(base, shots, final, caps, { seconds: plan.seconds }); } catch (e) { rmSync(final, { force: true }); rmSync(base, { force: true }); rmSync(caps, { recursive: true, force: true }); throw e; }
  rmSync(base, { force: true }); rmSync(caps, { recursive: true, force: true });
  ff(["-ss", String(Math.min(1.5, plan.seconds / 2)), "-i", final, "-frames:v", "1", "-q:v", "3", join(dir, `${name}.jpg`)]);
  const lines = sheet.lines.filter((r) => !r.drop && !r.missing).map((r) => ({ n: r.n, script: r.text, said: r.parts.map((p) => digitsIn(p.takes[p.pick].spoken)).join(" "), show: r.show, footage: r.show === "footage" ? r.pictures : null, takes: r.parts.map((p) => p.takes[p.pick].file), differs: !r.said_as_written, at: plan.pieces.some((p) => p.line === r.n) ? r2(plan.pieces.slice(0, plan.pieces.findIndex((p) => p.line === r.n)).reduce((s, p) => s + (p.a[2] - p.a[1]), 0)) : null }));
  const record = { name, made: new Date().toISOString(), seconds: plan.seconds, tightened: tighten, timed_by: Object.values(timings).some((t) => t.by === "pace") ? "pace" : "heard", lines, pieces: plan.pieces.map((p) => ({ line: p.line, video: `${p.v[0]} ${p.v[1]}–${p.v[2]}`, sound: `${p.a[0]} ${p.a[1]}–${p.a[2]}` })), captions: blocks.map((b) => ({ text: b.text, from: b.from, to: b.to })), notes: plan.notes };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
  log(`done: ${name}.mp4 · ${plan.seconds} s · ${plan.pieces.length} pieces · ${blocks.length} caption blocks${plan.notes.length ? ` · ${plan.notes.length} note(s)` : ""}`);
  return { file: final, json: join(dir, `${name}.json`), name, seconds: plan.seconds, pieces: plan.pieces.length, blocks: blocks.length, notes: plan.notes, record };
}
/** The cuts made of a shoot, the newest first. */
export function listCuts(gymDir, id) {
  const dir = join(shootDir(gymDir, id), "cuts"); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((x) => /^cut-\d+\.json$/.test(x)).map((x) => { try { return JSON.parse(readFileSync(join(dir, x), "utf-8")); } catch { return null; } }).filter((x) => x && existsSync(join(dir, `${x.name}.mp4`))).sort((a, b) => Number(b.name.slice(4)) - Number(a.name.slice(4)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { "brand-dir": { type: "string" }, shoot: { type: "string" }, plan: { type: "boolean" } } });
  try {
    if (!a["brand-dir"] || !a.shoot) throw new Error("usage: footage-cut.mjs --brand-dir brands/{gym} --shoot id [--plan]");
    if (a.plan) { const shoot = syncFiles(a["brand-dir"], readShoot(a["brand-dir"], a.shoot)), sheet = buildSheet(shoot), t = await timeTakes(shoot, sheet, { log: (m) => console.log(m) }); const p = planCut(sheet, t, { files: Object.fromEntries(shoot.files.map((f) => [f.key, { seconds: f.read?.seconds }])), tighten: shoot.choices?.tighten !== false }); console.log(`${p.seconds} s in ${p.pieces.length} pieces`); for (const x of p.pieces) console.log(`  line ${x.line}: ${x.v[0]} ${x.v[1]}–${x.v[2]}${x.footage ? ` under ${x.a[0]} ${x.a[1]}–${x.a[2]}` : ""}`); for (const n of p.notes) console.log("  note:", n); }
    else { const r = await cutShoot({ gymDir: a["brand-dir"], id: a.shoot, log: (m) => console.log(m) }); console.log(r.file); }
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(1); }
}
