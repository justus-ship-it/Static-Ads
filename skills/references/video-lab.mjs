#!/usr/bin/env node
/**
 * video-lab.mjs — Phase 0 of the AI video plan (plans/2026-11-12-ai-video-creatives.md): three sample videos for one
 * gym, made by a script, so the owner can judge whether today's models pass his realism bar before anything is built
 * into the panel. NOT part of the cycle, and nothing here publishes anything.
 *
 *   A  moving still   — an approved photo of the gym's last batch, given 8 seconds of motion; the words set by software
 *   B  voice-over     — four short clips of workout footage, one text-to-speech voice reading the script, captions
 *   C  presenter      — an invented presenter (nobody in particular; never claims to be staff or a member) talking to
 *                       the camera at three spots in the gym's own room, cut together, captions
 *
 * The rules of the stills carry over: the model makes footage with no words in it; software sets every word on screen
 * (captions, the area callout, the offer); a spoken line is checked against the script by transcription, word for word.
 *
 * Spend is capped: every second of video asked for is counted before the call (`--max-seconds`), and so are image
 * calls. Everything made is kept under brands/{gym}/outputs/video-lab-{date}/ (gitignored) with the prompts, the
 * transcripts and what was spent; a file already there is not made again.
 *
 * Checked against Google's pages on 2026-11-12: video is Gemini Omni Flash on the Interactions API (3–15 s clips with
 * sound, 9:16, reference images as image parts; audio cannot be an input); speech is Gemini 3.8 Flash TTS on the same API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve, extname, basename } from "path";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { loadGeminiKey, generateImage } from "./generate_ads_gemini.mjs";
import { whenGeminiFree } from "./gemini-busy.mjs";
import { CHECK_MODEL } from "./check-visual.mjs";
import { IMAGE_MODELS } from "./client-config.mjs";
import { launchBrowser } from "./render-composites.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const OMNI = "gemini-omni-1.2-flash", TTS = "gemini-3.8-flash-tts", INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";
/** What a second of 720p video costs (Google's pricing page, 2026-11-12), for the spend record. An image call is an estimate. */
export const USD_PER_SECOND = 0.07, USD_PER_IMAGE = 0.15;
const W = 720, H = 1280, FPS = 24;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString();
const ff = (args) => sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const durationOf = (file) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
const mimeOf = (p) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[extname(p).toLowerCase()] || "image/png";
const NUMBER = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const words = (s) => String(s).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).map((w) => (w in NUMBER ? String(NUMBER[w]) : w));
/** A spoken line against its script: the same words in the same order (spelling of numbers aside is not forgiven: the script writes them as said). */
export function sameWords(said, line) { const a = words(said), b = words(line); return a.length === b.length && a.every((w, i) => w === b[i]); }

// ── the lab's state: spend, and what was made ────────────────────────────────
function lab(dir, caps) {
  const file = join(dir, "lab.json"), S = readJson(file) || { started: new Date().toISOString(), seconds: 0, images: 0, tts: 0, checks: 0, calls: [], notes: [] };
  const save = () => writeFileSync(file, JSON.stringify({ ...S, usd_estimate: Math.round((S.seconds * USD_PER_SECOND + S.images * USD_PER_IMAGE) * 100) / 100, caps }, null, 2) + "\n");
  return {
    S, save,
    seconds(n, what) { if (S.seconds + n > caps.seconds) throw new Error(`the cap of ${caps.seconds} seconds of video would be passed (${S.seconds} used, ${n} asked for ${what})`); S.seconds += n; S.calls.push({ at: new Date().toISOString(), what, seconds: n }); save(); },
    image(what) { if (S.images + 1 > caps.images) throw new Error(`the cap of ${caps.images} image calls would be passed (${what})`); S.images += 1; S.calls.push({ at: new Date().toISOString(), what, image: 1 }); save(); },
    note(text) { S.notes.push(text); save(); console.log(`  · ${text}`); },
  };
}

// ── the model calls ──────────────────────────────────────────────────────────
async function interact(body, { label, timeoutMs = 600000 } = {}) {
  const key = loadGeminiKey(); if (!key) throw new Error("GEMINI_KEY not found (.env or environment)");
  return whenGeminiFree(async () => {
    const res = await fetch(INTERACTIONS, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${label} failed (${res.status}): ${(await res.text()).slice(0, 600)}`);
    return res.json();
  }, { label });
}
const outputOf = (r, type) => { for (const s of [...(r.steps || [])].reverse()) for (const c of s.content || []) if (c.type === type) return c; return null; };
/** One clip from Omni: reference or starting images first, then the prompt. Counted against the cap before the call. Kept if already made. */
async function omniClip(L, { out, images = [], prompt, seconds }) {
  writeFileSync(out.replace(/\.mp4$/, ".prompt.txt"), prompt + "\n");
  if (existsSync(out) && statSync(out).size > 10000) { console.log(`  kept ${basename(out)}`); return out; }
  L.seconds(seconds, basename(out));
  console.log(`  making ${basename(out)} (${seconds} s)…`);
  const r = await interact({ model: OMNI, input: [...images.map((p) => ({ type: "image", data: readFileSync(p).toString("base64"), mime_type: mimeOf(p) })), { type: "text", text: prompt }],
    response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", duration: `${seconds}s` } }, { label: `video ${basename(out)}` });
  const v = outputOf(r, "video");
  if (!v) throw new Error(`no video came back for ${basename(out)}: ${JSON.stringify(r).slice(0, 500)}`);
  if (v.data) writeFileSync(out, Buffer.from(v.data, "base64"));
  else if (v.uri) { const key = loadGeminiKey(), res = await fetch(v.uri.includes("alt=media") ? v.uri : `${v.uri}${v.uri.includes("?") ? "&" : "?"}alt=media`, { headers: { "x-goog-api-key": key } }); if (!res.ok) throw new Error(`the video could not be downloaded (${res.status})`); writeFileSync(out, Buffer.from(await res.arrayBuffer())); }
  else throw new Error("the video part carried neither data nor a uri");
  return out;
}
/** The script read by one voice (WAV, 24 kHz mono). */
async function speak(L, { out, text, style, voice = "Sulafat" }) {
  if (existsSync(out) && statSync(out).size > 2000) { console.log(`  kept ${basename(out)}`); return out; }
  const body = (withStyle) => ({ model: TTS, input: [{ type: "user_input", content: [{ type: "text", text }] }], ...(withStyle ? { annotations: [{ type: "speech_metadata", style }] } : {}), response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] } });
  let r; try { r = await interact(body(true), { label: "speech", timeoutMs: 180000 }); } catch (e) { L.note(`speech with a style note was refused (${String(e.message).slice(0, 160)}); asked again without it`); r = await interact(body(false), { label: "speech", timeoutMs: 180000 }); }
  const a = outputOf(r, "audio"); if (!a?.data) throw new Error(`no audio came back: ${JSON.stringify(r).slice(0, 400)}`);
  writeFileSync(out, Buffer.from(a.data, "base64")); L.S.tts += 1; L.save();
  return out;
}
/** What a clip says and shows, by the check model: the words spoken, any words on screen, how many people, and what looks wrong. */
async function watch(L, file) {
  const key = loadGeminiKey();
  const schema = { type: "OBJECT", properties: { spoken: { type: "STRING" }, on_screen_text: { type: "ARRAY", items: { type: "STRING" } }, people: { type: "INTEGER" }, lips_match_speech: { type: "BOOLEAN" }, faults: { type: "ARRAY", items: { type: "STRING" } }, looks_real: { type: "INTEGER" } }, required: ["spoken", "on_screen_text", "people", "lips_match_speech", "faults", "looks_real"] };
  const text = "Watch and listen to this short video. spoken: transcribe exactly every word spoken, in order, with nothing added; an empty string if nobody speaks. on_screen_text: every word or letter visible anywhere in the picture (signs, clothing, captions, watermarks), one entry each; empty if none. people: how many people are visible. lips_match_speech: true only if a visible person's mouth moves in time with the spoken words (true if nobody speaks). faults: every visible fault that would make a viewer think this is not real footage — warped hands or faces, objects that melt or pass through each other, impossible movement, a face that changes — each as a short phrase; empty if none. looks_real: 1 to 10, how convincingly this passes as phone footage shot in a real gym.";
  const out = await whenGeminiFree(async () => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CHECK_MODEL}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ contents: [{ parts: [{ text }, { inline_data: { mime_type: "video/mp4", data: readFileSync(file).toString("base64") } }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 } }) });
    if (!res.ok) throw new Error(`the video check failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }, { label: "video check" });
  L.S.checks += 1; L.save();
  return JSON.parse(out.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}");
}

// ── the text layer: every word on screen is set here, never by the model ─────
const FONTS = `@font-face{font-family:Anton;src:url("file://${join(REPO_ROOT, "assets/fonts/anton/Anton-Regular.ttf")}")}@font-face{font-family:Mont;src:url("file://${join(REPO_ROOT, "assets/fonts/montserrat/Montserrat[wght].ttf")}");font-weight:100 900}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A transparent 720 × 1280 PNG of some HTML. Meta's 9:16 live area is x 6–94%, y 14–65%: every block sits inside it. */
async function overlay(browser, out, inner) {
  const html = `<!doctype html><meta charset="utf-8"><style>${FONTS}html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    .callout{position:absolute;left:6%;right:6%;top:15%;text-align:center;font:400 54px/1.05 Anton;color:#fff;letter-spacing:1px;text-shadow:0 2px 14px rgba(0,0,0,.65)}
    .callout small{display:block;font:800 26px/1.2 Mont;letter-spacing:5px;margin-bottom:8px}
    .offer{position:absolute;left:6%;right:6%;top:25.5%;text-align:center;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.7)}
    .offer .d{font:400 88px/1 Anton;letter-spacing:1px}.offer .o{font:800 32px/1.15 Mont;letter-spacing:3px;margin-top:6px}
    .cap{position:absolute;left:8%;right:8%;top:54%;text-align:center;font:400 58px/1.12 Anton;color:#fff;letter-spacing:.5px;-webkit-text-stroke:7px #000;paint-order:stroke fill}
    .cap b{color:#7CFF4F;font-weight:400}</style>${inner}`;
  const page = join(browser.work, `${basename(out)}.html`); writeFileSync(page, html);
  const { cdp, sessionId } = browser;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `file://${page}` }, sessionId); await loaded;
  await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true }, sessionId);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  return out;
}
const lockup = (W_) => `<div class="callout"><small>${esc(W_.audience || "")}</small>${esc(W_.location)}</div><div class="offer"><div class="d">${esc(W_.duration)}</div><div class="o">${esc(W_.rest)}</div></div>`;
/** Caption chunks of a script, a few words at a time, timed across `from`…`to` by their share of the letters (no word timings exist: a test's approximation). */
export function captions(text, from, to, per = 3) {
  const ws = String(text).replace(/\s+/g, " ").trim().split(" "), chunks = []; for (let i = 0; i < ws.length; i += per) chunks.push(ws.slice(i, i + per).join(" "));
  const total = chunks.reduce((t, c) => t + c.length + 2, 0); let at = from;
  return chunks.map((c) => { const d = ((c.length + 2) / total) * (to - from), x = { text: c, from: Math.round(at * 100) / 100, to: Math.round((at + d) * 100) / 100 }; at += d; return x; });
}
/** Lay timed overlays over a video (each { png, from, to }), keeping or replacing the sound. */
function compose({ video, overlays, out, audio = null, ambience = 1 }) {
  const inputs = ["-i", video, ...overlays.flatMap((o) => ["-i", o.png]), ...(audio ? ["-i", audio] : [])];
  let last = "[0:v]", chain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}[v0];`; last = "[v0]";
  overlays.forEach((o, i) => { const next = `[v${i + 1}]`; chain += `${last}[${i + 1}:v]overlay=0:0:enable='between(t,${o.from},${o.to})'${next};`; last = next; });
  const a = audio ? `[0:a]volume=${ambience}[amb];[${overlays.length + 1}:a]volume=1.0[vo];[amb][vo]amix=inputs=2:duration=first:normalize=0[a]` : `[0:a]volume=${ambience}[a]`;
  ff([...inputs, "-filter_complex", chain + a, "-map", last, "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  return out;
}
/** Cut clips together at one size and rate (each { file, seconds? }). */
function concat(parts, out) {
  const inputs = parts.flatMap((p) => ["-i", p.file]), n = parts.length;
  const chain = parts.map((p, i) => `[${i}:v]${p.seconds ? `trim=0:${p.seconds},setpts=PTS-STARTPTS,` : ""}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1[v${i}];[${i}:a]${p.seconds ? `atrim=0:${p.seconds},asetpts=PTS-STARTPTS,` : ""}aresample=48000,aformat=channel_layouts=stereo[a${i}]`).join(";")
    + ";" + parts.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${n}:v=1:a=1[v][a]`;
  ff([...inputs, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-b:a", "128k", out]);
  return out;
}
/** A strip of frames, to look at a video without playing it. */
function sheet(video, out, n = 6) { const d = durationOf(video); ff(["-i", video, "-vf", `fps=${n}/${d},scale=240:-2,tile=${n}x1`, "-frames:v", "1", "-q:v", "4", out]); return out; }

/** A clip made, watched, and made again when it shows the wrong number of people or (for a spoken line) other words. The last take is kept either way, with what was seen. */
async function checkedClip(L, C, { name, images, prompt, seconds, people = null, line = null }) {
  let take = 0, file = null, seen = null, ok = false;
  while (take < C.takes && !ok) {
    take++; file = join(C.dir, "clips", `${name}${take > 1 ? `-take${take}` : ""}.mp4`);
    await omniClip(L, { out: file, images, prompt, seconds });
    const cached = file.replace(/\.mp4$/, ".check.json"); seen = readJson(cached) || await watch(L, file); writeFileSync(cached, JSON.stringify(seen, null, 2) + "\n");
    const said = line == null ? !words(seen.spoken).length : sameWords(seen.spoken, line), count = people == null || seen.people === people;
    ok = said && count && !seen.on_screen_text.length;
    console.log(`  ${basename(file)}: ${line == null ? (said ? "nobody speaks" : `someone says "${seen.spoken}"`) : said ? "said as written" : `said "${seen.spoken}"`}${people == null ? "" : ` · ${seen.people} ${seen.people === 1 ? "person" : "people"}${count ? "" : ` (the photo has ${people})`}`}${line == null ? "" : ` · lips ${seen.lips_match_speech ? "match" : "do not match"}`} · real ${seen.looks_real}/10${seen.faults.length ? ` · ${seen.faults.join("; ")}` : ""}${seen.on_screen_text.length ? ` · words on screen: ${seen.on_screen_text.join(" | ")}` : ""}`);
  }
  return { file, takes: take, passed: ok, check: seen, line };
}
const STAY = (n) => `Exactly ${n === 1 ? "one person is" : `${n} people are`} in the room for the whole clip: nobody walks in, nobody leaves, nobody appears in a doorway or a mirror.`;

// ── the three samples ────────────────────────────────────────────────────────
const NO_WORDS = "There is no text of any kind anywhere in the picture: no captions, no subtitles, no titles, no logos, no watermark, no lettering on walls, screens or clothing.";
const PHONE = "It looks like real footage shot on a phone held upright by a friend: natural indoor light, slight handheld sway, real skin, nothing glossy or cinematic. One continuous shot with no scene cuts.";

async function sampleA(L, C, browser) {
  console.log("A · a moving still");
  const r = await checkedClip(L, C, { name: "a-swing", images: [C.photo("g06")], seconds: 8, people: 3,
    prompt: `Bring this photograph to life as 8 seconds of video. The three women keep doing kettlebell swings at an unhurried, natural pace, each in her own rhythm; one glances at another and smiles. ${STAY(3)} The pale floor on the left of the frame is empty and stays empty from the first frame to the last. The camera is locked off on a tripod and does not move. Keep the room, the people, their faces, their clothes and the framing exactly as they are in the photograph. ${PHONE} ${NO_WORDS} Sound: the quiet of a small gym, the soft thud of kettlebells, breathing. No music. No dialogue.` });
  const png = await overlay(browser, join(C.dir, "overlays", "lockup.png"), lockup(C.words));
  const out = compose({ video: r.file, overlays: [{ png, from: 0, to: 60 }], out: join(C.dir, "A-moving-still.mp4"), ambience: 0.6 });
  return { file: out, clip: r };
}

async function sampleB(L, C, browser) {
  console.log("B · voice-over on gym footage");
  const shots = [
    ["g01", "b-lunge", 1, "The woman keeps doing slow reverse lunges, one side then the other, steady and controlled."],
    ["g02", "b-bench", 2, "The woman on the bench presses the bar up and lowers it under control while the coach stands behind her, hands ready under the bar, and nods."],
    ["g07", "b-row", 1, "The woman pulls the seated row handles to her ribs and lets them out again, smooth and unhurried."],
  ];
  const checked = [], clips = [];
  for (const [photo, name, people, action] of shots) { const r = await checkedClip(L, C, { name, images: [C.photo(photo)], seconds: 5, people,
    prompt: `Bring this photograph to life as 5 seconds of video. ${action} ${STAY(people)} The camera barely moves. Keep the room, the people, their faces, their clothes and the framing exactly as they are in the photograph. ${PHONE} ${NO_WORDS} Sound: the quiet of a small gym and the equipment in use. No music. No dialogue.` }); checked.push(r); clips.push(r.file); }
  const swing = (readJson(join(C.dir, "results.json")) || {}).a?.clip?.file; if (swing && existsSync(swing)) clips.push(swing);
  const voice = await speak(L, { out: join(C.dir, "clips", "b-voice.wav"), text: C.script.voiceover, style: "A warm, unhurried Singaporean woman speaking to a friend, plainly, with a smile in her voice; not an announcer." });
  const vd = durationOf(voice), each = Math.max(3.5, Math.min(5, (vd + 2.6) / clips.length));
  const base = concat(clips.map((file) => ({ file, seconds: each })), join(C.dir, "clips", "b-base.mp4")), total = durationOf(base);
  const caps = captions(C.script.voiceover, 0.15, Math.min(vd + 0.15, total - 0.3)), overlays = [];
  for (const [i, c] of caps.entries()) overlays.push({ png: await overlay(browser, join(C.dir, "overlays", `b-cap-${String(i).padStart(2, "0")}.png`), `<div class="cap">${esc(c.text.toUpperCase())}</div>`), from: c.from, to: c.to });
  if (total - vd > 1.2) overlays.push({ png: await overlay(browser, join(C.dir, "overlays", "lockup.png"), lockup(C.words)), from: vd + 0.35, to: total });
  const voiced = join(C.dir, "clips", "b-voice-padded.wav"); ff(["-i", voice, "-af", `adelay=150|150,apad=whole_dur=${total}`, "-ar", "48000", "-ac", "2", voiced]);
  const out = compose({ video: base, overlays, out: join(C.dir, "B-voice-over.mp4"), audio: voiced, ambience: 0.18 });
  return { file: out, clips: checked, voice, voice_seconds: vd };
}

async function sampleC(L, C, browser) {
  console.log("C · a presenter talking to the camera");
  const who = "a Singaporean Chinese woman of about thirty-four with shoulder-length black hair tied back, a plain charcoal training tee and black leggings, no jewellery, no logo on her clothes";
  const still = async (name, refs, where) => {
    const out = join(C.dir, "clips", `${name}.jpg`); if (existsSync(out)) { console.log(`  kept ${basename(out)}`); return out; }
    L.image(basename(out)); console.log(`  making ${basename(out)}…`);
    const prompt = `A real photograph taken on a phone held upright, 9:16. ${refs.length > 1 ? "The woman is the SAME woman as in the first image: the same face, hair and clothes. " : ""}${where} She is ${who}. She stands facing the camera, framed from the waist up, mid-sentence with one hand slightly raised as if explaining something to a friend, looking straight into the lens, relaxed and friendly. The room is the gym in the ${refs.length > 1 ? "second" : "first"} image: its red walls, black ceiling with small warm lights, the same equipment and floor — matched for the room only. Natural indoor light, real skin texture, nothing glossy, not a studio portrait. ${NO_WORDS}`;
    writeFileSync(out.replace(/\.jpg$/, ".prompt.txt"), prompt + "\n");
    const r = await generateImage(prompt, refs.map((p) => ({ inline_data: { mime_type: mimeOf(p), data: readFileSync(p).toString("base64") } })), { aspectRatio: "9:16", model: IMAGE_MODELS.pro });
    writeFileSync(out, r.buffer); return out;
  };
  const s1 = await still("c-still-1", [C.room], "She stands beside the dumbbell rack.");
  const s2 = await still("c-still-2", [s1, C.room], "She has walked to the squat rack and stands in front of it.");
  const s3 = await still("c-still-3", [s1, C.room], "She stands on the open floor with the cable machines behind her.");
  const results = [], spots = [[s1, 8], [s2, 9], [s3, 7]];
  for (const [i, line] of C.script.presenter.entries()) {
    const [img, seconds] = spots[i];
    results.push(await checkedClip(L, C, { name: `c-line-${i + 1}`, images: [img], seconds, people: 1, line,
      prompt: `Bring this photograph to life as ${seconds} seconds of video. The woman keeps looking into the camera and says, in a warm, natural Singaporean English voice, at an easy conversational pace: "${line}" Her mouth forms exactly these words, in time with her voice, and she says nothing else; she finishes the sentence before the clip ends. Small natural gestures with her hands; she does not walk. ${STAY(1)} Keep her face, hair, clothes and the room exactly as they are in the photograph. ${PHONE} ${NO_WORDS} Sound: her voice, close and clear, over the quiet of an empty gym. No music.` }));
  }
  const base = concat(results.map((r) => ({ file: r.file })), join(C.dir, "clips", "c-base.mp4")), overlays = []; let at = 0;
  for (const [i, r] of results.entries()) { const d = durationOf(r.file); for (const [k, c] of captions(r.line, at + 0.2, at + d - 0.5).entries()) overlays.push({ png: await overlay(browser, join(C.dir, "overlays", `c-cap-${i}-${String(k).padStart(2, "0")}.png`), `<div class="cap">${esc(c.text.toUpperCase())}</div>`), from: c.from, to: c.to }); at += d; }
  const out = compose({ video: base, overlays, out: join(C.dir, "C-presenter.mp4"), ambience: 1 });
  return { file: out, stills: [s1, s2, s3], lines: results };
}

// ── the run ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, batch: { type: "string" }, only: { type: "string", default: "a,b,c" }, "max-seconds": { type: "string", default: "200" }, "max-images": { type: "string", default: "5" }, takes: { type: "string", default: "2" }, name: { type: "string" } } });
  if (!v["brand-dir"] || !v.batch) { console.error("Usage: video-lab.mjs --brand-dir brands/<gym> --batch <batch id> [--only a,b,c] [--max-seconds 200] [--max-images 5] [--takes 2]"); process.exit(1); }
  const gymDir = resolve(v["brand-dir"]), batchDir = join(gymDir, "outputs", v.batch), brief = readJson(join(batchDir, "brief.json")) || readJson(join(gymDir, "batches", v.batch, "brief.json"));
  if (!brief) { console.error(`no brief for ${v.batch}`); process.exit(1); }
  const dir = join(gymDir, "outputs", v.name || `video-lab-${new Date().toISOString().slice(0, 10)}`); mkdirSync(join(dir, "clips"), { recursive: true }); mkdirSync(join(dir, "overlays"), { recursive: true });
  const offer = String(brief.offer), m = offer.match(/^(\d+\s*(?:week|day)s?)\s+(.*)$/i), location = String(brief.locations[0]), area = location.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const profile = readJson(join(gymDir, "gym-profile.json")) || {}, gym = profile.display_name || basename(gymDir);
  const spokenOffer = offer.replace(/^12\b/, "twelve").replace(/^6\b/, "six").toLowerCase();
  // Test words, written for the test and checked by hand against the standing rules (no free trial, no price, no result promised, no before and after).
  // The offer, the area and the audience are the brief's own. The presenter never says "I", "we" or "our": she is nobody in particular.
  const script = {
    voiceover: `Ladies in ${area}. If you have been meaning to get stronger, and never knew where to start, this is for you. ${gym}'s ${spokenOffer}. A coach beside you, a plan that fits your week, and women training alongside you. Tap below to find out more.`,
    presenter: [
      `Ladies in ${area}, this one is for you. If you have wanted to get stronger and never knew where to start, keep watching.`,
      `${gym}'s ${spokenOffer} is built for exactly that. A coach beside you, and a plan that fits your week.`,
      `You train in small groups, with women just like you. Tap below to find out more.`,
    ],
  };
  const C = { dir, script, takes: Math.max(1, parseInt(v.takes, 10) || 2), words: { audience: brief.audience || "", location, duration: m ? m[1].toUpperCase() : "", rest: (m ? m[2] : offer).toUpperCase() },
    photo: (id) => { const p = join(batchDir, "visuals", `${id}-9x16.jpg`); if (!existsSync(p)) throw new Error(`no 9:16 photo ${id} in ${v.batch}`); return p; },
    room: join(gymDir, "brand-assets", brief.reference || "facility-clean/facility-01.png") };
  const L = lab(dir, { seconds: parseInt(v["max-seconds"], 10) || 200, images: parseInt(v["max-images"], 10) || 5 });
  writeFileSync(join(dir, "script.json"), JSON.stringify({ gym, batch: v.batch, words: C.words, script }, null, 2) + "\n");
  const only = v.only.split(",").map((x) => x.trim().toLowerCase()), browser = await launchBrowser(), made = {};
  try {
    for (const [k, fn] of [["a", sampleA], ["b", sampleB], ["c", sampleC]]) if (only.includes(k)) {
      try { made[k] = await fn(L, C, browser); sheet(made[k].file, made[k].file.replace(/\.mp4$/, ".frames.jpg")); writeFileSync(join(dir, "results.json"), JSON.stringify({ ...(readJson(join(dir, "results.json")) || {}), ...made }, null, 2) + "\n"); console.log(`  → ${made[k].file} (${durationOf(made[k].file).toFixed(1)} s)`); }
      catch (e) { L.note(`${k.toUpperCase()} stopped: ${String(e.message).slice(0, 700)}`); }
    }
  } finally { await browser.close(); }
  const prev = readJson(join(dir, "results.json")) || {}; writeFileSync(join(dir, "results.json"), JSON.stringify({ ...prev, ...made }, null, 2) + "\n");
  console.log(`spent so far: ${L.S.seconds} s of video (about US$${(L.S.seconds * USD_PER_SECOND).toFixed(2)}), ${L.S.images} image call(s), ${L.S.tts} speech call(s), ${L.S.checks} check(s)`);
  process.exit(0);
}
