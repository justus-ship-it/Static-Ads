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
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { validateInputs } from "./render-composites.mjs";

export const FOOTAGE = "real-footage";                // brief.imported / batch.imported
export const FOOTAGE_KIND = "real";                   // ad.video.kind
export const FOOTAGE_LIMITS = { videos: 12, seconds: [3, 240], long_side: 1080 };

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
export function footageProblems({ batchId, offer, locations, audience = null, videos, facts = [] }) {
  const errs = [];
  if (!okId(batchId)) errs.push("the batch needs an id of small letters, digits and hyphens");
  if (!Array.isArray(locations) || !locations.length) errs.push("name at least one location: the area around the gym, never the whole country");
  for (const location of locations || []) for (const e of validateInputs({ location, audience, offer })) if (!errs.includes(e)) errs.push(e);
  if (!Array.isArray(videos) || !videos.length) errs.push("no video to add");
  else if (videos.length > FOOTAGE_LIMITS.videos) errs.push(`${videos.length} videos: a batch takes ${FOOTAGE_LIMITS.videos} at most`);
  (videos || []).forEach((v, i) => {
    const n = `video ${i + 1}`, f = facts[i];
    if (!f) return errs.push(`${n}: the file is not there (${v.file})`);
    if (!f.video) return errs.push(`${n}: the file has no picture`);
    if (!f.sound) errs.push(`${n}: the file has no sound track`);
    if (f.h * 9 !== f.w * 16) errs.push(`${n}: it is ${f.w}×${f.h}; a video ad here is 9:16 (1080×1920)`);
    else if (f.h < FOOTAGE_LIMITS.long_side) errs.push(`${n}: it is ${f.w}×${f.h}, smaller than 1080×1920`);
    if (f.seconds < FOOTAGE_LIMITS.seconds[0] || f.seconds > FOOTAGE_LIMITS.seconds[1]) errs.push(`${n}: it runs ${f.seconds} s; between ${FOOTAGE_LIMITS.seconds[0]} and ${FOOTAGE_LIMITS.seconds[1]} s is taken`);
    if (v.words != null && (!Array.isArray(v.words) || v.words.some((w) => typeof w !== "string"))) errs.push(`${n}: its words are a list of lines`);
  });
  return errs;
}

/**
 * Add finished videos to a gym as a new batch of ads. Nothing that exists is touched: an id with a brief or outputs
 * on disk is refused. Returns { batch_id, ads, dir }.
 */
export function addFootageBatch({ brandDir, batchId, offer, locations, audience = null, videos, now = new Date(), log = () => {} }) {
  const dir = resolve(brandDir), briefDir = join(dir, "batches", String(batchId)), out = join(dir, "outputs", String(batchId));
  if (!existsSync(join(dir, "gym-profile.json"))) throw new Error(`no gym at ${dir}`);
  const facts = (videos || []).map((v) => (v?.file && existsSync(v.file) ? probeVideo(v.file) : null));
  const errs = footageProblems({ batchId, offer, locations, audience, videos, facts });
  if (errs.length) throw new Error(`these videos cannot be added:\n- ${errs.join("\n- ")}`);
  if (existsSync(briefDir) || existsSync(out)) throw new Error(`a batch called ${batchId} is already there: nothing is written over it`);
  mkdirSync(briefDir, { recursive: true }); mkdirSync(out, { recursive: true });
  const ads = []; let no = 101;
  videos.forEach((v, i) => locations.forEach((location, li) => {
    const id = `v${String(i + 1).padStart(2, "0")}`, name = `${id}-${slug(location)}`, folder = `${no++}-${name}-real-video`, base = `${folder}/9x16/${name}_9x16_v1`;
    mkdirSync(join(out, folder, "9x16"), { recursive: true });
    copyFileSync(v.file, join(out, `${base}.mp4`));
    const at = Math.min(Math.max(0, Number(v.poster_at) || 1), Math.max(0, facts[i].seconds - 0.2));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", v.file, "-frames:v", "1", "-q:v", "2", join(out, `${base}.jpg`)]);
    ads.push({ folder, file: `${base}.jpg`, video_file: `${base}.mp4`, candidate: id, location, location_index: li, photos: [], photo_files: [], treatment: "video-real", style: "video", palette: null, ratio: "9x16", format: "presenter-video",
      video: { kind: FOOTAGE_KIND, script_id: null, style: null, pain: null, title: v.title || null, seconds: facts[i].seconds, words: v.words || [], notes: [], source: v.source || null },
      crop: [], words: { location, audience, offer, free: false }, replaced: null });
    log(`${folder} · ${facts[i].seconds} s`);
  }));
  const made = now.toISOString(), seconds = Math.round(facts.reduce((t, f) => t + f.seconds, 0));
  writeFileSync(join(briefDir, "brief.json"), JSON.stringify({ batch_id: batchId, offer, locations, audience, free: false, generated: 0, real: [], imported: FOOTAGE }, null, 2) + "\n");
  writeFileSync(join(out, "batch.json"), JSON.stringify({ batch_id: batchId, made, imported: FOOTAGE, ratio: "4x5", image_calls: 0, image_calls_this_run: 0, photos: [], videos: { real: videos.length }, video_seconds: seconds, failed: [], ads }, null, 2) + "\n");
  writeFileSync(join(out, "progress.json"), JSON.stringify({ batch_id: batchId, run: "import", started: made, stage: "done", calls: 0, ads: ads.length, failed: 0, error: null, photos: {}, updated: made, image_calls: 0 }, null, 2) + "\n");
  return { batch_id: batchId, ads: ads.length, dir: out };
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
