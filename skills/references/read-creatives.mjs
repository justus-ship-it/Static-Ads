/**
 * read-creatives.mjs — what each ad in a gym's history looks like, read once by the vision model (2026-11-09).
 *
 * Results say which ad won; this says what the ad WAS, in the same words for every ad: its format (a studio
 * portrait, a workout shot, a class, the owner talking…), who is in it, the backdrop, the pose, the expression,
 * the mood, the ratio, how many words sit on the picture, whether a logo is on it, the colours. What wins
 * (what-wins.mjs) joins these to Meta's numbers so the gym's leads can be read per attribute.
 *
 *   brands/{gym}/creative-reads.json   — one reading per picture, by its content hash (a picture is read once)
 *
 * The gym's own ads only (the history's pictures under references/: meta-{id}.* from the API, export-*.* from an
 * Ads Manager export). A video is read through its poster frame when the import fetched one; a video file alone
 * is skipped and said so. One vision call per unread picture, under `--max`. No image generation.
 *
 *   node skills/references/read-creatives.mjs --brand-dir brands/{gym} [--max 60] [--show]
 */

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { callVision, imageSize, CHECK_MODEL } from "./check-visual.mjs";
import { readHistory, appAdIds, PICTURES_DIR } from "./meta-results.mjs";

export const READS_FILE = "creative-reads.json";
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeWhole = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };

/** The formats an ad can be read as. The catalogue of recipes (Phase 3+) will carry the same names. */
export const FORMATS = {
  "studio-portrait": "one or two people posed on a plain studio backdrop (a seamless colour or a dark wall), an easy pose or a smile, not mid-exercise",
  workout: "a person mid-exercise or holding equipment on a gym floor or in a studio room",
  "class-group": "three or more people training or gathered in a gym",
  premises: "the gym itself with nobody, or people too small to be the subject",
  lifestyle: "a person outdoors, at home or in everyday clothes, not training",
  "person-talking": "a person facing the camera as if speaking (a video's frame, a coach or owner introducing something)",
  testimonial: "a quote attributed to a member, with or without their photo",
  review: "a review card: stars, a reviewer's name, the words of a review",
  "offer-card": "mostly words: the programme or the offer laid out in type on a colour, no person as the subject",
  "before-after": "two states of a body compared side by side or over time",
  other: "none of the above",
};
export const SUBJECTS = ["woman", "man", "couple", "group", "none"];
export const BACKDROPS = ["seamless-colour", "dark-wall", "gym-floor", "studio-room", "outdoors", "home", "graphic", "other"];
export const POSES = ["easy-posed", "mid-exercise", "stretch", "holding-equipment", "walking", "talking", "lying", "none"];
export const EXPRESSIONS = ["smile", "neutral", "effort", "none"];
export const DENSITIES = ["none", "light", "heavy"];

export const READ_SCHEMA = {
  type: "OBJECT",
  properties: {
    format: { type: "STRING", enum: Object.keys(FORMATS) },
    subject: { type: "STRING", enum: SUBJECTS },
    people: { type: "INTEGER" },
    backdrop: { type: "STRING", enum: BACKDROPS },
    backdrop_colour: { type: "STRING" },
    pose: { type: "STRING", enum: POSES },
    expression: { type: "STRING", enum: EXPRESSIONS },
    eye_contact: { type: "BOOLEAN" },
    mood: { type: "STRING" },
    text_density: { type: "STRING", enum: DENSITIES },
    words: { type: "ARRAY", items: { type: "STRING" } },
    logo: { type: "BOOLEAN" },
    colours: { type: "ARRAY", items: { type: "STRING" } },
    clothing_colour: { type: "STRING" },
    notes: { type: "STRING" },
  },
  required: ["format", "subject", "people", "backdrop", "pose", "expression", "eye_contact", "mood", "text_density", "words", "logo", "colours"],
};
export const READ_QUESTION = `You are reading a finished advertisement image from a gym's own ad account, to record HOW it was made so the account's results can be compared by kind. Answer every field from what is visible; do not guess what is not shown.

format — exactly one of:
${Object.entries(FORMATS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
subject — who the picture is about: woman, man, couple (two people), group (three or more), none.
people — how many people are visible.
backdrop — seamless-colour (a plain studio colour with no floor line or a soft one), dark-wall, gym-floor (equipment, racks, rigs), studio-room (a class room, mirrors), outdoors, home, graphic (an illustration or flat design), other.
backdrop_colour — the backdrop's colour in one or two plain words ("pale pink", "charcoal").
pose — easy-posed (standing or sitting at ease, a hand on a hip, holding a bottle), mid-exercise, stretch, holding-equipment (at rest), walking, talking (to the camera), lying, none.
expression — smile, neutral, effort (straining), none (no face shown).
eye_contact — true when the main person looks into the lens.
mood — three words at most.
text_density — none (no words on the picture), light (one short block or a few words), heavy (several blocks, a list, a paragraph).
words — every printed word group as it reads, one entry each, in order from the top; empty when there are none.
logo — true when a brand's logo or mark is on the picture.
colours — the two or three dominant colours in plain words.
clothing_colour — the main person's clothing colour, or an empty string.
notes — anything else that would help someone remake this kind of picture, in one sentence.`;

/** The nearest standard ratio: 1:1, 4:5, 9:16, 16:9, 1.91:1 — within 3% — else "other". */
export function ratioOf([w, h]) {
  if (!w || !h) return "other";
  const r = w / h, known = [["1:1", 1], ["4:5", 0.8], ["9:16", 9 / 16], ["16:9", 16 / 9], ["1.91:1", 1.91], ["3:4", 0.75], ["2:3", 2 / 3]];
  const hit = known.find(([, v]) => Math.abs(r - v) / v <= 0.03);
  return hit ? hit[0] : "other";
}

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
/** The local picture that stands for an ad: the export's file when it is an image, else the API import's meta-{id}.* (a video's poster frame counts). */
export function pictureOf(gymDir, ad) {
  if (ad.creative_file && IMAGE_RE.test(ad.creative_file) && existsSync(join(gymDir, ad.creative_file))) return join(gymDir, ad.creative_file);
  for (const ext of ["jpg", "png", "webp"]) { const p = join(gymDir, "references", `meta-${ad.id}.${ext}`); if (existsSync(p)) return p; }
  const hash = ad.hashes?.[0] || ad.poster;
  if (hash) for (const ext of ["jpg", "png", "webp"]) { const p = join(gymDir, PICTURES_DIR, `${hash}.${ext}`); if (existsSync(p)) return p; }
  return null;
}
/**
 * Every ad the gym has run with the picture that stands for it: the account's and an export's ads through pictureOf;
 * the app's own published ads through their finished 1:1 in outputs/ — one representative file per photo of a batch
 * (the same photo under another location or look is the same picture to read), so a batch costs a call per photo.
 */
export function pictures(gymDir) {
  const out = [], h = readHistory(gymDir), ours = appAdIds(gymDir);
  for (const ad of h?.ads || []) { if (ours.has(ad.id)) continue; out.push({ ad_id: ad.id, name: ad.name, media: ad.media, leads: ad.all_time?.leads || 0, spend: ad.all_time?.spend || 0, file: pictureOf(gymDir, ad) }); }
  const outDir = join(gymDir, "outputs");
  if (existsSync(outDir)) for (const b of readdirSync(outDir).sort()) {
    const rec = readJson(join(outDir, b, "publish.json")), batch = readJson(join(outDir, b, "batch.json"));
    if (!rec?.ads || !Array.isArray(batch?.ads)) continue;
    const byFolder = Object.fromEntries(batch.ads.map((a) => [a.folder, a])), rep = new Map(), key = (a) => (a.photos || []).join("+");
    for (const a of [...batch.ads].sort((x, y) => String(x.folder).localeCompare(String(y.folder)))) { const f = a.file ? join(outDir, b, a.file) : null; if (f && !rep.has(key(a)) && existsSync(f)) rep.set(key(a), f); }
    const add = (folder, id) => { const a = byFolder[folder]; if (a && id) out.push({ ad_id: id, name: `${b}/${folder}`, media: "image", app: true, leads: 0, spend: 0, file: rep.get(key(a)) || null }); };
    for (const [folder, e] of Object.entries(rec.ads)) add(folder, e.id);
    for (const o of rec.superseded || []) add(o.folder, o.id);
  }
  return out;
}
export const readReads = (gymDir) => { const j = readJson(join(gymDir, READS_FILE)); return { schema: 1, model: CHECK_MODEL, reads: {}, ...(j || {}), reads: j?.reads && typeof j.reads === "object" ? j.reads : {} }; };
// A picture's content hash, remembered while the file is unchanged (its size and time): the panel's Results page asks for
// every gym's pictures several times a look, and hashing a few hundred images each time took seconds (2026-11-11).
const HASHES = new Map();
const hashOf = (p) => {
  const st = statSync(p), key = `${st.size}:${st.mtimeMs}`, hit = HASHES.get(p);
  if (hit && hit.key === key) return hit.sha;
  const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
  HASHES.set(p, { key, sha }); return sha;
};

/** Read every unread picture the gym's ads have, under `max` calls. Returns what was read, what was cached, what was skipped and why. */
export async function readCreatives({ gymDir, ask = callVision, max = 60, log = () => {}, now = () => new Date().toISOString() }) {
  const list = pictures(gymDir);
  if (!list.length) throw new Error("no ads yet: pull the account, import an Ads Manager export or publish a batch first");
  const store = readReads(gymDir);
  const done = { read: 0, cached: 0, skipped: [], calls: 0, ads: 0, left: 0 };
  const shaOf = new Map(), sha = (f) => shaOf.get(f) || shaOf.set(f, hashOf(f)).get(f);
  const seen = new Set(), capped = new Set();
  for (const ad of list) {
    if (!ad.file) { if (ad.leads > 0 || ad.spend > 0) done.skipped.push(`${ad.name}: ${ad.media === "video" ? "a video with no poster frame" : "no picture on this machine"}`); continue; }
    const id = sha(ad.file);
    done.ads++;
    if (seen.has(id)) continue; seen.add(id);
    const had = store.reads[id];
    if (had && had.format) { done.cached++; continue; }
    if (done.calls >= max) { capped.add(id); done.skipped.push(`${ad.name}: the cap of ${max} calls was reached`); continue; }
    done.calls++;
    log(`reading ${ad.file.split("/").pop()} (${ad.name.slice(0, 60)})`);
    let size = null; try { size = imageSize(readFileSync(ad.file)); } catch {}
    try {
      const a = await ask(ad.file, READ_QUESTION, READ_SCHEMA);
      store.reads[id] = { file: ad.file.replace(gymDir + "/", ""), size, ratio: size ? ratioOf(size) : "other", read_on: now(), model: store.model || CHECK_MODEL, ad_ids: [],
        format: a.format, subject: a.subject, people: a.people, backdrop: a.backdrop, backdrop_colour: a.backdrop_colour || null, pose: a.pose, expression: a.expression, eye_contact: !!a.eye_contact, mood: a.mood || null,
        text_density: a.text_density, words: Array.isArray(a.words) ? a.words.filter(Boolean) : [], logo: !!a.logo, colours: Array.isArray(a.colours) ? a.colours.filter(Boolean) : [], clothing_colour: a.clothing_colour || null, notes: a.notes || null };
      done.read++;
      writeWhole(join(gymDir, READS_FILE), JSON.stringify(store, null, 2) + "\n");
    } catch (e) { done.skipped.push(`${ad.name}: the reading failed — ${e.message}`); }
  }
  done.left = capped.size;
  // Every ad that shares a picture is noted on the reading (the same video under three offers, a photo under four locations).
  for (const ad of list) { if (!ad.file) continue; const r = store.reads[sha(ad.file)]; if (r && !r.ad_ids?.includes(ad.ad_id)) r.ad_ids = [...(r.ad_ids || []), ad.ad_id]; }
  writeWhole(join(gymDir, READS_FILE), JSON.stringify(store, null, 2) + "\n");
  return done;
}
/** How many distinct pictures the gym has on this machine, and how many of them are not read yet (what a reading run would cost). */
export function unreadCount(gymDir) {
  const store = readReads(gymDir), ids = new Set();
  for (const ad of pictures(gymDir)) if (ad.file) ids.add(hashOf(ad.file));
  return { pictures: ids.size, unread: [...ids].filter((id) => !store.reads[id]?.format).length };
}

/** The reading for each ad id (ads sharing a picture share a reading). */
export function readsFor(gymDir) {
  const store = readReads(gymDir), byAd = new Map(), shaOf = new Map();
  for (const ad of pictures(gymDir)) { if (!ad.file) continue; const id = shaOf.get(ad.file) || shaOf.set(ad.file, hashOf(ad.file)).get(ad.file); const r = store.reads[id]; if (r?.format) byAd.set(ad.ad_id, r); }
  return { byAd, reads: store.reads, total: Object.keys(store.reads).length };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, max: { type: "string", default: "60" }, show: { type: "boolean", default: false } } });
  if (!v["brand-dir"]) { console.error("Usage: read-creatives.mjs --brand-dir brands/{gym} [--max 60] [--show]"); process.exit(1); }
  const gymDir = resolve(v["brand-dir"]);
  try {
    if (v.show) {
      const { byAd } = readsFor(gymDir), h = readHistory(gymDir);
      const u = unreadCount(gymDir); console.log(`${u.pictures} distinct pictures on this machine, ${u.unread} not read yet`);
      for (const ad of h?.ads || []) { const r = byAd.get(ad.id); if (r) console.log(`${String(ad.all_time?.leads ?? 0).padStart(4)} leads  ${(ad.all_time?.cost_per_lead ?? "—").toString().padStart(7)}  ${r.ratio.padEnd(6)} ${r.format.padEnd(16)} ${r.subject.padEnd(7)} ${r.backdrop.padEnd(16)} ${r.pose.padEnd(18)} ${r.expression.padEnd(8)} ${r.text_density.padEnd(6)} logo:${r.logo ? "y" : "n"}  ${ad.name.slice(0, 60)}`); }
    } else {
      const d = await readCreatives({ gymDir, max: parseInt(v.max, 10) || 60, log: (m) => console.log("  " + m) });
      console.log(`read ${d.read} picture(s) (${d.cached} already read) for ${d.ads} ads · ${d.calls} call(s)${d.left ? ` · ${d.left} left for another run` : ""}${d.skipped.length ? `\nskipped:\n  ${d.skipped.join("\n  ")}` : ""}`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
