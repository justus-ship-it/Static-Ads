#!/usr/bin/env node
/**
 * Videos cut from a gym's own raw footage, added to the gym as ads (2026-11-19).
 *
 * The owner had four videos cut by hand from a coach's own phone clips and voice recordings (the samples for the
 * raw-footage editor, which is not built yet) and passed all four: "Let's add them to Aether's ads in the agent as
 * created." A finished video file is all this takes: nothing is generated, filmed, cut or captioned here, and no
 * model is called.
 *
 * `addFootageBatch` makes ONE new batch that holds the videos as its ads — one ad per video and location, each in a
 * numbered folder with the video and a poster frame (ffmpeg pulls the frame), in the shape a batch's own videos have,
 * so Pick Ads plays them, Publish Ads plans them (the same campaign, copies, headlines, button and lead form as any
 * ad) and the results rows read them. What tells them apart: `video.kind: "real"` (the results say "real footage",
 * beside talking · with exercises · white paper) and `imported: "real-footage"` on the brief and on batch.json.
 *
 * Such a batch has nothing to make: a run of it is refused in words (`runBatch`, and the panel's batch runs), since a
 * run would plan nothing and write an empty batch over the videos. The offer, locations and audience are the owner's
 * words, as on any brief; a location is never the whole country (the one location rule). A batch id that exists is
 * never written over.
 *
 * CLI: footage-video.mjs --brand-dir brands/{gym} --batch {id} --offer "…" --locations "A,B" [--audience x] --videos list.json
 *      footage-video.mjs --brand-dir brands/{gym} --batch {id} --set-words --offer "…" [--audience x]
 *      list.json: [{ "file": "/abs/video.mp4", "title": "…", "words": ["line", …], "poster_at": 1.5 }]
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateInputs } from "./render-composites.mjs";

export const FOOTAGE = "real-footage";                // brief.imported / batch.imported
export const FOOTAGE_KIND = "real";                   // ad.video.kind
export const FOOTAGE_LIMITS = { videos: 12, seconds: [3, 240], long_side: 1080, testimonial_long_side: 720 };
/** The kinds of finished video that are added as they are: the gym's own cut ("real"), or a member's testimonial (testimonial-video.mjs). */
export const FOOTAGE_KINDS = ["real", "testimonial"];

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
const okId = (id) => /^[a-z0-9][a-z0-9-]{2,79}$/.test(String(id || ""));

/** A video file's length and size as it is shown (an upright phone video says its rotation apart). */
export function probeVideo(file) {
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height:stream_side_data=rotation", "-of", "json", file]).toString());
  const v = (pr.streams || []).find((s) => s.codec_type === "video"), a = (pr.streams || []).find((s) => s.codec_type === "audio");
  if (!v) return { seconds: Number(pr.format?.duration) || 0, video: false, sound: !!a };
  const rot = Math.abs(Number((v.side_data_list || []).map((s) => s.rotation).find((x) => x != null) || 0)) % 180 === 90;
  return { seconds: Math.round(Number(pr.format.duration) * 10) / 10, video: true, sound: !!a, w: rot ? v.height : v.width, h: rot ? v.width : v.height, bytes: Number(pr.format.size) || statSync(file).size };
}

/** What stops a list of videos from being added, in words. `facts` are each file's probe, in order (null: no file). */
export function footageProblems({ batchId, offer, locations, audience = null, videos, facts = [], kind = FOOTAGE_KIND }) {
  const errs = [];
  if (!FOOTAGE_KINDS.includes(kind)) errs.push(`a video added as it is is one of: ${FOOTAGE_KINDS.join(", ")}`);
  // A testimonial is often all there is of it — a download of the gym's own post, at 720 wide — so it is taken at that size; a cut made here is 1080.
  const least = kind === "testimonial" ? FOOTAGE_LIMITS.testimonial_long_side : FOOTAGE_LIMITS.long_side;
  if (!okId(batchId)) errs.push("the batch needs an id of small letters, digits and hyphens");
  if (!Array.isArray(locations) || !locations.length) errs.push("name at least one location: the area around the gym, never the whole country");
  for (const location of locations || []) for (const e of validateInputs({ location, audience, offer })) if (!errs.includes(e)) errs.push(e);
  if (!Array.isArray(videos) || !videos.length) errs.push("no video to add");
  else if (videos.length > FOOTAGE_LIMITS.videos) errs.push(`${videos.length} videos: a batch takes ${FOOTAGE_LIMITS.videos} at most`);
  (videos || []).forEach((v, i) => {
    const n = `video ${i + 1}`, f = facts[i];
    if (!f) return errs.push(`${n}: the file is not there (${v.file})`);
    for (const e of fileProblems(f, kind)) errs.push(`${n}: ${e}`);
    if (v.words != null && (!Array.isArray(v.words) || v.words.some((w) => typeof w !== "string"))) errs.push(`${n}: its words are a list of lines`);
  });
  return errs;
}

/** What stops ONE video file from being an ad, from its probe: upright 9:16, large enough for its kind, with sound, of a length Meta's placements take. */
export function fileProblems(f, kind = FOOTAGE_KIND) {
  const least = kind === "testimonial" ? FOOTAGE_LIMITS.testimonial_long_side : FOOTAGE_LIMITS.long_side, errs = [];
  if (!f?.video) return ["the file has no picture"];
  if (!f.sound) errs.push("the file has no sound track");
  if (f.h * 9 !== f.w * 16) errs.push(`it is ${f.w}×${f.h}; a video ad here is 9:16 (1080×1920)`);
  else if (f.w < least) errs.push(`it is ${f.w}×${f.h}, smaller than ${least}×${Math.round(least * 16 / 9)}`);
  if (f.seconds < FOOTAGE_LIMITS.seconds[0] || f.seconds > FOOTAGE_LIMITS.seconds[1]) errs.push(`it runs ${f.seconds} s; between ${FOOTAGE_LIMITS.seconds[0]} and ${FOOTAGE_LIMITS.seconds[1]} s is taken`);
  return errs;
}

/**
 * Add finished videos to a gym as a new batch of ads. Nothing that exists is touched: an id with a brief or outputs
 * on disk is refused. Returns { batch_id, ads, dir }.
 */
export function addFootageBatch({ brandDir, batchId, offer, locations, audience = null, videos, kind = FOOTAGE_KIND, consent = null, now = new Date(), log = () => {} }) {
  const dir = resolve(brandDir), briefDir = join(dir, "batches", String(batchId)), out = join(dir, "outputs", String(batchId));
  if (!existsSync(join(dir, "gym-profile.json"))) throw new Error(`no gym at ${dir}`);
  const facts = (videos || []).map((v) => (v?.file && existsSync(v.file) ? probeVideo(v.file) : null));
  const errs = footageProblems({ batchId, offer, locations, audience, videos, facts, kind });
  // A testimonial shows a real member: the owner's word that they agreed to appear in an advert is recorded on the video.
  if (kind === "testimonial" && !(consent && typeof consent.by === "string" && consent.by.trim().length >= 3)) errs.push("a testimonial shows a real person: say who confirmed that each person agreed to appear in an advert, and how");
  const what = kind === "testimonial" ? "testimonial" : "real", idOf = (file) => `t-${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10)}`;
  if (errs.length) throw new Error(`these videos cannot be added:\n- ${errs.join("\n- ")}`);
  if (existsSync(briefDir) || existsSync(out)) throw new Error(`a batch called ${batchId} is already there: nothing is written over it`);
  mkdirSync(briefDir, { recursive: true }); mkdirSync(out, { recursive: true });
  const ads = []; let no = 101;
  videos.forEach((v, i) => locations.forEach((location, li) => {
    const id = `v${String(i + 1).padStart(2, "0")}`, name = `${id}-${slug(location)}`, folder = `${no++}-${name}-${what}-video`, base = `${folder}/9x16/${name}_9x16_v1`;
    mkdirSync(join(out, folder, "9x16"), { recursive: true });
    copyFileSync(v.file, join(out, `${base}.mp4`));
    const at = Math.min(Math.max(0, Number(v.poster_at) || 1), Math.max(0, facts[i].seconds - 0.2));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", v.file, "-frames:v", "1", "-q:v", "2", join(out, `${base}.jpg`)]);
    ads.push({ folder, file: `${base}.jpg`, video_file: `${base}.mp4`, candidate: id, location, location_index: li, photos: [], photo_files: [], treatment: `video-${what}`, style: "video", palette: null, ratio: "9x16", format: "presenter-video",
      video: { kind, ...(kind === "testimonial" ? { id: idOf(v.file), consent: { by: consent.by.trim(), on: now.toISOString().slice(0, 10) }, small: facts[i].w < FOOTAGE_LIMITS.long_side } : {}), script_id: null, style: null, pain: null, title: v.title || null, seconds: facts[i].seconds, words: v.words || [], notes: [], source: v.source || null },
      crop: [], words: { location, audience, offer, free: false }, replaced: null });
    log(`${folder} · ${facts[i].seconds} s`);
  }));
  const made = now.toISOString(), seconds = Math.round(facts.reduce((t, f) => t + f.seconds, 0));
  writeFileSync(join(briefDir, "brief.json"), JSON.stringify({ batch_id: batchId, offer, locations, audience, free: false, generated: 0, real: [], imported: FOOTAGE }, null, 2) + "\n");
  writeFileSync(join(out, "batch.json"), JSON.stringify({ batch_id: batchId, made, imported: FOOTAGE, ratio: "4x5", image_calls: 0, image_calls_this_run: 0, photos: [], videos: { [what]: videos.length }, video_seconds: seconds, failed: [], ads }, null, 2) + "\n");
  writeFileSync(join(out, "progress.json"), JSON.stringify({ batch_id: batchId, run: "import", started: made, stage: "done", calls: 0, ads: ads.length, failed: 0, error: null, photos: {}, updated: made, image_calls: 0 }, null, 2) + "\n");
  return { batch_id: batchId, ads: ads.length, dir: out };
}

// ── Finished videos dropped on the page (2026-11-24) ─────────────────────────────────────────────────────────────────
// Aether's real-footage videos and Sculpt Society's testimonials both went in by hand; now the owner drops the files on
// Generate Creatives. A dropped file waits in the gym's holding folder (brands/{gym}/video-uploads/, never committed)
// until he says what the videos are and whose words they carry; then `addHeld` makes the batch with `addFootageBatch`,
// as the CLI always did. A file is told by its first bytes, kept once by its content, and never re-encoded: a MOV (what
// an iPhone exports) is re-wrapped as an MP4 — the same picture and sound in another container — and one that cannot be
// is refused in words. The holding copy is a staging copy: once its batch has the video it is removed; a video taken off
// the list by hand goes to `_trash`. No model is called and nothing is spent.
export const HELD_DIR = "video-uploads";
export const HELD_LIMITS = { bytes: 600 * 1024 * 1024, waiting: 24 };
const heldDir = (gymDir) => join(resolve(gymDir), HELD_DIR), heldIndex = (gymDir) => join(heldDir(gymDir), "index.json");
const readHeld = (gymDir) => { try { const j = JSON.parse(readFileSync(heldIndex(gymDir), "utf-8")); return Array.isArray(j.videos) ? j : { videos: [] }; } catch { return { videos: [] }; } };
const writeHeld = (gymDir, data) => { mkdirSync(heldDir(gymDir), { recursive: true }); writeFileSync(heldIndex(gymDir), JSON.stringify(data, null, 2) + "\n"); };

/** What a file is by its first bytes: "mp4", "mov", or null. The name's ending is not trusted. */
export function videoContainer(buf) {
  if (!buf || buf.length < 12) return null;
  const box = buf.subarray(4, 8).toString("latin1"), brand = buf.subarray(8, 12).toString("latin1");
  if (box === "ftyp") return brand === "qt  " ? "mov" : "mp4";
  return ["moov", "mdat", "wide", "free", "skip"].includes(box) ? "mov" : null; // a QuickTime file from before the ftyp box
}

/** The videos waiting in a gym's holding folder: each with its probe and, per kind, what stops it from being an ad (nothing: it can be added). */
export function heldVideos(gymDir) {
  return readHeld(gymDir).videos.filter((v) => !v.added_to && !v.removed && existsSync(join(heldDir(gymDir), `${v.id}.mp4`))).map((v) => ({
    id: v.id, name: v.name, file: join(heldDir(gymDir), `${v.id}.mp4`), poster: existsSync(join(heldDir(gymDir), `${v.id}.jpg`)) ? `${v.id}.jpg` : null,
    seconds: v.facts.seconds, w: v.facts.w, h: v.facts.h, bytes: v.bytes, sound: v.facts.sound, rewrapped: !!v.rewrapped, added: v.added, was_in: v.was_in || [],
    problems: Object.fromEntries(FOOTAGE_KINDS.map((k) => [k, fileProblems(v.facts, k)])),
  }));
}

/**
 * Keep a dropped video in the gym's holding folder. `bytes` are the file as it came; `name` what it was called.
 * Returns { video, already } — `already` when the same content is waiting there. Throws in words for a file that is
 * not a video, one with no picture, or a MOV whose picture or sound an MP4 cannot hold without re-encoding.
 */
export function holdVideo(gymDir, name, bytes, { now = new Date() } = {}) {
  if (!existsSync(join(resolve(gymDir), "gym-profile.json"))) throw new Error(`no gym at ${gymDir}`);
  const kind = videoContainer(bytes);
  if (!kind) throw new Error("a video here is an MP4 or a MOV file: this file is neither");
  if (bytes.length > HELD_LIMITS.bytes) throw new Error(`the file is over ${Math.round(HELD_LIMITS.bytes / 1048576)} MB`);
  const dir = heldDir(gymDir), sha = createHash("sha256").update(bytes).digest("hex"), id = `u-${sha.slice(0, 10)}`, data = readHeld(gymDir);
  const said = String(name || "video").replace(/[\\/\u0000-\u001f]/g, " ").trim().slice(0, 160) || "video";
  const waiting = () => heldVideos(gymDir).find((v) => v.id === id);
  if (waiting()) return { video: waiting(), already: true };
  if (heldVideos(gymDir).length >= HELD_LIMITS.waiting) throw new Error(`${HELD_LIMITS.waiting} videos are waiting here already: add them as ads or remove some first`);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, `${id}.src.${kind}`), out = join(dir, `${id}.mp4`), poster = join(dir, `${id}.jpg`), clean = () => { for (const f of [src, out, poster]) rmSync(f, { force: true }); };
  writeFileSync(src, bytes);
  try {
    let facts;
    try { facts = probeVideo(src); } catch { throw new Error("the file could not be read as a video"); }
    if (!facts.video) throw new Error("the file has no picture");
    if (kind === "mov") {
      // The same picture and sound in an MP4 container: nothing is re-encoded. HEVC is tagged the way players expect it.
      try { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-tag:v:0", "hvc1", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] }); }
      catch { try { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] }); } catch { throw new Error("this MOV's picture or sound cannot be kept in an MP4 without re-encoding it: export it as an MP4 (H.264) and drop that file"); } }
      const after = probeVideo(out);
      if (!after.video || after.w !== facts.w || after.h !== facts.h || (facts.sound && !after.sound)) throw new Error("this MOV did not come through as an MP4 unchanged: export it as an MP4 (H.264) and drop that file");
      facts = { ...after, bytes: undefined }; rmSync(src, { force: true });
    } else renameSync(src, out);
    const at = Math.min(1, Math.max(0, facts.seconds / 2));
    try { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", poster]); } catch {}
    const was = data.videos.find((v) => v.id === id), rest = data.videos.filter((v) => v.id !== id);
    const entry = { id, name: said, sha, bytes: statSync(out).size, rewrapped: kind === "mov", added: now.toISOString(), facts: { seconds: facts.seconds, video: true, sound: facts.sound, w: facts.w, h: facts.h }, ...(was?.added_to ? { was_in: [...(was.was_in || []), was.added_to] } : was?.was_in ? { was_in: was.was_in } : {}) };
    writeHeld(gymDir, { videos: [...rest, entry] });
    return { video: waiting(), already: false };
  } catch (e) { clean(); throw e; }
}

/** Take a waiting video off the list: the file goes to the holding folder's `_trash`, never deleted. */
export function dropHeld(gymDir, id, { now = new Date() } = {}) {
  const data = readHeld(gymDir), v = data.videos.find((x) => x.id === id && !x.added_to && !x.removed);
  if (!v) throw new Error("that video is not waiting here");
  const dir = heldDir(gymDir), trash = join(dir, "_trash"); mkdirSync(trash, { recursive: true });
  for (const ext of ["mp4", "jpg"]) if (existsSync(join(dir, `${id}.${ext}`))) renameSync(join(dir, `${id}.${ext}`), join(trash, `${id}-${now.getTime()}.${ext}`));
  v.removed = now.toISOString(); writeHeld(gymDir, data);
  return heldVideos(gymDir);
}

const titleOf = (name) => String(name).replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Video";

/**
 * The waiting videos the owner ticked, added as ads: ONE new batch (addFootageBatch), named for the day and the offer.
 * `ids` in the order they go in; `titles` { id: title } (else the file's own name); `kind` real | testimonial (a
 * testimonial needs `consent.by`). Every refusal is addFootageBatch's own, with nothing written. Once the batch has
 * them the holding copies are removed. Returns { batch_id, ads, dir, videos }.
 */
export function addHeld({ brandDir, ids, kind = FOOTAGE_KIND, offer, locations, audience = null, titles = {}, consent = null, batchId = null, now = new Date(), log = () => {} }) {
  const dir = resolve(brandDir), waiting = heldVideos(dir);
  if (!Array.isArray(ids) || !ids.length) throw new Error("tick at least one video to add");
  if (new Set(ids).size !== ids.length) throw new Error("a video is ticked twice");
  const picked = ids.map((id) => waiting.find((v) => v.id === id));
  if (picked.some((v) => !v)) throw new Error("a ticked video is not waiting here any more: look at the list again");
  const day = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10), word = kind === "testimonial" ? "testimonials" : "videos";
  let id = batchId;
  if (!id) { const base = `${day}-${word}-${slug(offer || "").slice(0, 40).replace(/-$/, "") || "ads"}`; id = base; for (let k = 2; existsSync(join(dir, "batches", id)) || existsSync(join(dir, "outputs", id)); k++) id = `${base}-${k}`; }
  const r = addFootageBatch({ brandDir: dir, batchId: id, offer, locations, audience, kind, consent, now, log,
    videos: picked.map((v) => ({ file: v.file, title: (typeof titles?.[v.id] === "string" && titles[v.id].trim().slice(0, 80)) || titleOf(v.name), poster_at: Math.min(1.5, v.seconds / 2), source: `upload:${v.name}` })) });
  const data = readHeld(dir);
  for (const v of picked) { const e = data.videos.find((x) => x.id === v.id); if (e) { e.added_to = id; e.added_on = now.toISOString(); } for (const ext of ["mp4", "jpg"]) rmSync(join(heldDir(dir), `${v.id}.${ext}`), { force: true }); }
  writeHeld(dir, data);
  return { ...r, videos: picked.length };
}

/**
 * The owner's new words for a batch of added videos (2026-11-19: "Change offer name to …"). The words are not in the
 * pictures, so nothing is rendered: the brief and every ad's words are rewritten, and the next publish plan names the
 * campaign by them. Only a batch added here is touched; the words pass the rules any brief's do.
 */
export function setFootageWords({ brandDir, batchId, offer, audience }) {
  const dir = resolve(brandDir), bp = join(dir, "batches", String(batchId), "brief.json"), op = join(dir, "outputs", String(batchId), "batch.json");
  if (!existsSync(bp) || !existsSync(op)) throw new Error(`no batch called ${batchId}`);
  const brief = JSON.parse(readFileSync(bp, "utf-8")), batch = JSON.parse(readFileSync(op, "utf-8"));
  if (brief.imported !== FOOTAGE) throw new Error("only a batch of added videos has its words changed this way: use Change words on any other batch");
  const next = { offer: offer ?? brief.offer, audience: audience === undefined ? brief.audience ?? null : audience || null };
  const errs = []; for (const location of brief.locations) for (const e of validateInputs({ location, audience: next.audience, offer: next.offer })) if (!errs.includes(e)) errs.push(e);
  if (errs.length) throw new Error(`these words cannot be used:\n- ${errs.join("\n- ")}`);
  const was = { offer: brief.offer, audience: brief.audience ?? null };
  Object.assign(brief, next); for (const ad of batch.ads || []) ad.words = { ...ad.words, offer: next.offer, audience: next.audience };
  writeFileSync(bp, JSON.stringify(brief, null, 2) + "\n"); writeFileSync(op, JSON.stringify(batch, null, 2) + "\n");
  return { batch_id: batchId, was, now: next, ads: (batch.ads || []).length };
}

/** Why a batch of added videos cannot be run, for every place that starts a run. */
export const FOOTAGE_NO_RUN = "this batch holds videos cut from the gym's own footage, added as they are: there is nothing to make or run again. Pick them on Pick Ads and publish them on Publish Ads";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({ options: { "brand-dir": { type: "string" }, batch: { type: "string" }, offer: { type: "string" }, locations: { type: "string" }, audience: { type: "string" }, videos: { type: "string" }, "set-words": { type: "boolean" } } });
  if (a["set-words"]) { try { const r = setFootageWords({ brandDir: a["brand-dir"], batchId: a.batch, offer: a.offer, audience: a.audience }); console.log(`${r.batch_id}: "${r.was.offer}" → "${r.now.offer}" on ${r.ads} ads`); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } }
  if (!a["brand-dir"] || !a.batch || !a.offer || !a.locations || !a.videos) { console.error('usage: footage-video.mjs --brand-dir brands/{gym} --batch {id} --offer "…" --locations "A,B" [--audience x] --videos list.json'); process.exit(2); }
  try {
    const r = addFootageBatch({ brandDir: a["brand-dir"], batchId: a.batch, offer: a.offer, locations: a.locations.split(",").map((s) => s.trim()).filter(Boolean), audience: a.audience || null, videos: JSON.parse(readFileSync(a.videos, "utf-8")), log: (m) => console.log(m) });
    console.log(`added ${r.ads} video ad${r.ads === 1 ? "" : "s"} as batch ${r.batch_id}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
