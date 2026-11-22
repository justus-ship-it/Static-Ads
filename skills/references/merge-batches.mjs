/**
 * Two or more finished batches merged into one (2026-11-22, the owner on Aether Athletics: "I have a batch of ads
 * (static images) on Nov 22 and another one created on Nov 19. I would like to merge these two into one so I can
 * publish it as one ad set").
 *
 *   node skills/references/merge-batches.mjs --brand-dir brands/{gym} --sources a,b [--batch id] [--dry-run]
 *
 * The merged batch is a NEW batch, and its ads are the sources' ads AS THEY ARE: every ad that is not excluded is
 * copied with its feed image, its Stories version and its video, renumbered in the sources' order, with the owner's
 * Keep carried over. Nothing is generated, rendered or re-encoded, and no model is called. The sources are left
 * exactly as they were (nothing is deleted or moved); each is marked `merged_into`, so the panel stops asking for it
 * to be published by itself.
 *
 * ONE AD SET needs one area. An image or a card has its area, offer and audience printed on it, so those are never
 * changed here: the merged batch takes them from its images. A video has no words in the picture — its area, offer
 * and audience are only how the campaign and the ad set are named — so a video takes the images' words. Images that
 * name two areas make two ad sets, and that is said; images with two different offers are refused (a campaign is one
 * offer).
 *
 * Like a batch of added videos, a merged batch is never run (`MERGED_NO_RUN`): to change an ad, change it in the
 * batch it came from and merge again. `brief.imported` and `batch.imported` say "merged".
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const MERGED = "merged";                       // brief.imported / batch.imported
export const MERGED_NO_RUN = "this batch is other batches merged into one, as they are: there is nothing to make or run again. To change an ad, change it in the batch it came from and merge again";
export const ADSET_ADS = 50;                          // Meta's limit of ads in an ad set, paused ones included

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "batch";
const okId = (id) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(String(id || ""));
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
/** An ad whose words are printed in the picture (an image or a card): they cannot be changed by a merge. A video's are only names. */
const printed = (ad) => !ad.video_file;

/** A source batch as the merge reads it: its ads that are not excluded, each with its Stories file and the scene facts of its photos. */
function readSource(dir, id) {
  const out = join(dir, "outputs", id), batch = readJson(join(out, "batch.json")), brief = readJson(join(dir, "batches", id, "brief.json"));
  if (!batch || !Array.isArray(batch.ads) || !brief) return { id, why: `${id} has no finished ads to merge` };
  const review = readJson(join(out, "review.json")) || { ads: {}, photos: {} }, stories = readJson(join(out, "stories.json")), record = readJson(join(out, "publish.json"));
  const storyOf = new Map((stories?.ads || []).filter((s) => existsSync(join(out, s.file))).map((s) => [s.folder, s.file]));
  const visuals = Object.fromEntries((readJson(join(out, "visuals.json"))?.visuals || []).map((v) => [v.id, v])), photoOf = Object.fromEntries((batch.photos || []).map((p) => [p.id, p]));
  const gone = new Set(Object.entries(review.photos || {}).filter(([, v]) => v === "exclude").map(([k]) => k));
  const ads = [], left = { excluded: 0, flagged: 0, missing: 0 };
  for (const a of batch.ads) {
    if (review.ads?.[a.folder] === "exclude" || (a.photos || []).some((p) => gone.has(p))) { left.excluded++; continue; }
    if (a.video?.flags?.length) { left.flagged++; continue; }              // a video with a line waiting for the owner's decision is decided where it was made
    if (!existsSync(join(out, a.file)) || (a.video_file && !existsSync(join(out, a.video_file)))) { left.missing++; continue; }
    const story = storyOf.get(a.folder) || (a.story_file && existsSync(join(out, a.story_file)) ? a.story_file : null);
    ads.push({ ad: a, story, kept: review.ads?.[a.folder] === "keep", visuals: (a.photos || []).map((p) => (visuals[p] ? { id: p, scene_id: visuals[p].scene_id || null, tags: visuals[p].tags || null, room: visuals[p].room || null } : photoOf[p]?.kind === "real" ? { id: p, scene_id: "real photo", tags: null, room: null } : null)).filter(Boolean) });
  }
  return { id, out, brief, batch, ads, left, on_meta: Object.keys(record?.ads || {}).length, merged_into: brief.merged_into || null, imported: brief.imported || null };
}

/**
 * What merging these batches comes to, with nothing written:
 *   { ready, problems[], notes[], batch_id, offer, audience, locations[], sources[{ id, ads, kept, left }], ads, images, videos, cards, by_location }
 */
export function mergePlan({ brandDir, sources, batchId = null, now = new Date() }) {
  const dir = resolve(brandDir), problems = [], notes = [];
  if (!existsSync(join(dir, "gym-profile.json"))) throw new Error(`no gym at ${dir}`);
  const ids = [...new Set((sources || []).map(String))];
  if (ids.length < 2) problems.push("choose two batches or more to merge");
  if (ids.length > 6) problems.push("at most six batches are merged at once");
  const read = ids.filter(okId).map((id) => readSource(dir, id));
  for (const id of ids) if (!okId(id)) problems.push(`"${id}" is not a batch`);
  for (const s of read) {
    if (s.why) { problems.push(s.why); continue; }
    if (s.on_meta) problems.push(`${s.id} is on Facebook already (${s.on_meta} ad${s.on_meta === 1 ? "" : "s"}): merging it would make those ads a second time`);
    if (s.imported === MERGED) problems.push(`${s.id} is itself a merged batch: merge the batches it came from`);
    if (!s.ads.length) problems.push(`${s.id} has no ad left to merge: every one is excluded`);
  }
  const good = read.filter((s) => !s.why), all = good.flatMap((s) => s.ads.map((x) => ({ ...x, from: s.id })));
  const fixed = all.filter((x) => printed(x.ad)), free = all.filter((x) => !printed(x.ad));
  // The words: the images' own (they are printed on them). Videos take them.
  const offers = [...new Map(fixed.map((x) => [norm(x.ad.words?.offer).toLowerCase(), norm(x.ad.words?.offer)])).values()].filter(Boolean);
  if (offers.length > 1) problems.push(`the images name ${offers.length} different offers (${offers.map((o) => `"${o}"`).join(", ")}): a campaign is one offer, so change the words in one batch first (Change words re-renders it at no cost)`);
  const offer = offers[0] || norm(free[0]?.ad.words?.offer) || norm(good[0]?.brief?.offer);
  if (!offer) problems.push("the batches name no offer");
  const auds = [...new Map(fixed.map((x) => [norm(x.ad.words?.audience).toLowerCase(), x.ad.words?.audience ?? null])).values()];
  if (auds.length > 1) notes.push(`the images call out ${auds.length} different audiences (${auds.map((a) => (a ? `"${a}"` : "nobody in particular")).join(", ")}): each ad keeps its own, and the campaign is named for the first`);
  const audience = fixed.length ? (auds[0] ?? null) : (free[0]?.ad.words?.audience ?? good[0]?.brief?.audience ?? null);
  const areas = [...new Map(fixed.map((x) => [norm(x.ad.location).toUpperCase(), x.ad.location])).values()];
  // A video goes to the images' area when they have one; with two areas it keeps its own when that is one of them, else the first.
  const areaFor = (x) => (printed(x.ad) ? x.ad.location : !areas.length ? x.ad.location : areas.find((l) => same(l, x.ad.location)) || areas[0]);
  const moved = free.filter((x) => areas.length && !same(areaFor(x), x.ad.location));
  if (moved.length) notes.push(`${moved.length} video${moved.length === 1 ? "" : "s"} made for ${[...new Set(moved.map((x) => x.ad.location))].join(", ")} ${moved.length === 1 ? "goes" : "go"} to the area ${areas[0]} with the images, so they are one ad set. Nothing is printed on a video: its area is only the ad set's name`);
  const by_location = {}; for (const x of all) { const l = areaFor(x); by_location[l] = (by_location[l] || 0) + 1; }
  const locations = Object.keys(by_location);
  if (locations.length > 1) notes.push(`the ads name ${locations.length} areas (${locations.join(", ")}): that is ${locations.length} ad sets, one for each. For one ad set, re-render one batch with the other's area first (Change words, at no cost)`);
  for (const [l, n] of Object.entries(by_location)) if (n > ADSET_ADS) notes.push(`${l} would hold ${n} ads: Facebook allows ${ADSET_ADS} in an ad set, so exclude ${n - ADSET_ADS} on Pick Ads before publishing`);
  for (const s of good) {
    if (s.left.flagged) notes.push(`${s.id}: ${s.left.flagged} video${s.left.flagged === 1 ? "" : "s"} with a line waiting for your decision ${s.left.flagged === 1 ? "is" : "are"} left out: decide on Pick Ads there, then merge again`);
    if (s.left.missing) notes.push(`${s.id}: ${s.left.missing} ad${s.left.missing === 1 ? "" : "s"} whose file is no longer on disk ${s.left.missing === 1 ? "is" : "are"} left out`);
    if (s.merged_into && existsSync(join(dir, "outputs", s.merged_into, "batch.json"))) notes.push(`${s.id} is already in the merged batch ${s.merged_into}: its ads will be in both`);
  }
  const noStory = all.filter((x) => printed(x.ad) && !x.story).length;
  if (noStory) notes.push(`${noStory} image${noStory === 1 ? " has" : "s have"} no Stories version: make them in the batch they came from first (Pick Ads → Make Stories versions), or they run on the feed image alone`);
  let id = batchId;
  if (id == null) { const base = `${now.toISOString().slice(0, 10)}-${slug(offer || "batch").slice(0, 44)}-merged`; id = base; for (let n = 2; existsSync(join(dir, "batches", id)) || existsSync(join(dir, "outputs", id)); n++) id = `${base}-${n}`; }
  else if (!okId(id)) problems.push("the new batch's name is lower-case letters, digits and dashes");
  else if (existsSync(join(dir, "batches", id)) || existsSync(join(dir, "outputs", id))) problems.push(`a batch called ${id} is already there: nothing is written over it`);
  return { ready: !problems.length, problems, notes, batch_id: id, offer: offer || null, audience, locations, by_location,
    sources: good.map((s) => ({ id: s.id, ads: s.ads.length, kept: s.ads.filter((x) => x.kept).length, left: s.left, of: s.batch.ads.length })),
    ads: all.length, images: all.filter((x) => !x.ad.video_file && !x.ad.card).length, videos: free.length, cards: all.filter((x) => x.ad.card).length,
    _all: all, _areaFor: areaFor, _dir: dir, _good: good };
}

/**
 * Merge the batches: a new batch with the sources' ads as they are. Returns the plan with `dir`. Throws in words
 * when the plan has problems. The sources are only marked (`merged_into` on their briefs).
 */
export function mergeBatches({ brandDir, sources, batchId = null, now = new Date(), log = () => {} }) {
  const plan = mergePlan({ brandDir, sources, batchId, now });
  if (!plan.ready) throw new Error(`these batches cannot be merged:\n- ${plan.problems.join("\n- ")}`);
  const dir = plan._dir, id = plan.batch_id, out = join(dir, "outputs", id), briefDir = join(dir, "batches", id);
  mkdirSync(briefDir, { recursive: true }); mkdirSync(out, { recursive: true });
  const ads = [], picks = {}; let no = 101;
  for (const x of plan._all) {
    const a = x.ad, src = join(dir, "outputs", x.from), rest = a.folder.replace(/^\d+-/, ""), folder = `${no++}-${rest}`;
    cpSync(join(src, a.folder), join(out, folder), { recursive: true });
    const re = (p) => (p ? p.replace(a.folder, folder) : p), location = plan._areaFor(x);
    const words = printed(a) ? a.words : { ...a.words, location, audience: plan.audience ?? null, offer: plan.offer };
    ads.push({ ...a, folder, file: re(a.file), ...(a.video_file ? { video_file: re(a.video_file) } : {}), ...(x.story ? { story_file: re(x.story) } : {}), location, words,
      // Its photos belong to the batch it came from: here the ad stands by itself, with what its photos were on record.
      photos: [], photo_files: [], replaced: null,
      merged: { batch: x.from, folder: a.folder, candidate: a.candidate ?? null, photos: a.photos || [], visuals: x.visuals } });
    if (x.kept) picks[folder] = "keep";
    log(`${folder} ← ${x.from}/${a.folder}`);
  }
  const made = now.toISOString(), first = plan._good[0], seconds = Math.round(ads.reduce((t, a) => t + (a.video?.seconds || 0), 0));
  const kinds = {}; for (const a of ads) if (a.video_file) { const k = a.video?.kind || "presenter"; kinds[k] = (kinds[k] || 0) + 1; }
  writeFileSync(join(briefDir, "brief.json"), JSON.stringify({ batch_id: id, offer: plan.offer, locations: plan.locations, audience: plan.audience ?? null, free: false, generated: 0, real: [], imported: MERGED, merged_from: plan.sources.map((s) => s.id) }, null, 2) + "\n");
  writeFileSync(join(out, "batch.json"), JSON.stringify({ batch_id: id, made, imported: MERGED, merged_from: plan.sources.map((s) => ({ batch: s.id, ads: s.ads })), ratio: ads.find((a) => !a.video_file)?.ratio || first.batch.ratio || "4x5", ...(first.batch.look ? { look: first.batch.look } : {}),
    image_calls: 0, image_calls_this_run: 0, photos: [], ...(Object.keys(kinds).length ? { videos: kinds, video_seconds: seconds } : {}), failed: [], ads }, null, 2) + "\n");
  writeFileSync(join(out, "progress.json"), JSON.stringify({ batch_id: id, run: "merge", started: made, stage: "done", calls: 0, ads: ads.length, failed: 0, error: null, photos: {}, updated: made, image_calls: 0 }, null, 2) + "\n");
  writeFileSync(join(out, "review.json"), JSON.stringify({ ads: picks, photos: {}, updated: made }, null, 2) + "\n");
  // The copy and the publish settings come along from the first source that has them: the owner's work, not to be done twice.
  for (const f of ["copy.json", "publish-settings.json"]) { const from = plan._good.find((s) => existsSync(join(s.out, f))); if (from) { cpSync(join(from.out, f), join(out, f)); log(`${f} ← ${from.id}`); } }
  // A video's own copy (drafts marked `for` its id: testimonial-video.mjs) and what was read of it come along from every source.
  const base = readJson(join(out, "copy.json")) || { drafted: null, drafts: [] }, have = new Set((base.drafts || []).map((d) => d.id)), readings = {};
  for (const s of plan._good) {
    for (const d of readJson(join(s.out, "copy.json"))?.drafts || []) if (d.for && !have.has(d.id)) { base.drafts.push(d); have.add(d.id); }
    Object.assign(readings, readJson(join(s.out, "testimonials.json"))?.videos || {});
  }
  if (base.drafts.length) writeFileSync(join(out, "copy.json"), JSON.stringify(base, null, 2) + "\n");
  if (Object.keys(readings).length) writeFileSync(join(out, "testimonials.json"), JSON.stringify({ videos: readings }, null, 2) + "\n");
  for (const s of plan._good) { const p = join(dir, "batches", s.id, "brief.json"), b = readJson(p); if (b) { b.merged_into = id; writeFileSync(p, JSON.stringify(b, null, 2) + "\n"); } }
  const { _all, _areaFor, _dir, _good, ...said } = plan;
  return { ...said, dir: out };
}

/** The merged batch a source went into, while that batch is still there (a discarded one frees the source again). */
export function mergedInto(brandDir, brief) {
  const id = brief?.merged_into;
  return id && okId(id) && existsSync(join(resolve(brandDir), "outputs", id, "batch.json")) && existsSync(join(resolve(brandDir), "batches", id, "brief.json")) ? id : null;
}

/** The plan without what only the merge itself uses. */
export const planView = (plan) => { const { _all, _areaFor, _dir, _good, ...said } = plan; return said; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, sources: { type: "string" }, batch: { type: "string" }, "dry-run": { type: "boolean" } } });
  if (!v["brand-dir"] || !v.sources) { console.error("usage: merge-batches.mjs --brand-dir brands/{gym} --sources batch-a,batch-b [--batch new-id] [--dry-run]"); process.exit(2); }
  const args = { brandDir: v["brand-dir"], sources: v.sources.split(",").map((x) => x.trim()).filter(Boolean), batchId: v.batch || null };
  try {
    const p = v["dry-run"] ? planView(mergePlan(args)) : mergeBatches({ ...args, log: (m) => console.log(`  ${m}`) });
    console.log(`${v["dry-run"] ? "would make" : "made"} ${p.batch_id}: ${p.ads} ads (${p.images} image${p.images === 1 ? "" : "s"}, ${p.videos} video${p.videos === 1 ? "" : "s"}${p.cards ? `, ${p.cards} card${p.cards === 1 ? "" : "s"}` : ""}) · ${p.offer} · ${Object.entries(p.by_location).map(([l, n]) => `${l}: ${n}`).join(" · ")}`);
    for (const s of p.sources) console.log(`  from ${s.id}: ${s.ads} of ${s.of} ads (${s.kept} kept by you${s.left.excluded ? `, ${s.left.excluded} excluded left behind` : ""})`);
    for (const n of p.notes) console.log(`  note: ${n}`);
    for (const e of p.problems) console.log(`  PROBLEM: ${e}`);
    if (!p.ready) process.exit(1);
  } catch (e) { console.error(e.message); process.exit(1); }
}
