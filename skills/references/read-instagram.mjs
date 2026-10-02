/**
 * read-instagram.mjs — onboarding, part two: a gym's Instagram photos, read through Meta's Business Discovery
 * into a proposal the owner ticks, the way the website's reading is (read-website.mjs). Nothing here files
 * anything: the reading lands in brands/{gym}/onboarding/instagram/ (gitignored with the rest of brands/),
 * and the panel's accept step files what the owner ticks.
 *
 *   node --env-file=.env skills/references/read-instagram.mjs --brand-dir brands/{gym} [--handle name] [--posts 100]
 *
 * Business Discovery reads another professional (business or creator) account's public posts through one of
 * our own: Strategym's Instagram account, connected to Strategym's Page and assigned to the system user
 * (`discoveryAccount` finds it among the Pages the token sees). Read-only; the token needs instagram_basic.
 * The latest `posts` posts (100 by default, 25 a call): a photo post's picture, every photo in a carousel;
 * videos and their cover frames are skipped (the owner's rule, 2026-09-29). Instagram serves photos at
 * 1080 px wide or a little more, so they clear MIN_PHOTO_PX. Then the website reader's own steps: downloaded
 * by first bytes, thumbnailed and hashed in Chrome, repeats marked (the same picture posted twice), what the
 * gym already has marked, and the vision model's sort (premises · members · coaches · logo · graphic ·
 * screenshot · other), eight thumbnails a call. Each photo keeps its post's address and date.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { join, resolve, basename } from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { launchBrowser } from "./render-composites.mjs";
import { callVision } from "./check-visual.mjs";
import { metaConfig, graphClient } from "./meta-api.mjs";
import { checkUrl, fileKind, sizeOf, knownHashes, thumbsAndHashes, markRepeats, sortPhotos, instagramHandle, MIN_PHOTO_PX, MAX_PHOTO_BYTES } from "./read-website.mjs";

export const INSTAGRAM_DIR = "onboarding/instagram";
export const DEFAULT_POSTS = 100;
export const MAX_POSTS = 500; // a video-heavy account keeps its photos further back (BFIT: 10 photos in its latest 100 posts)
const PAGE = 25;
export const HANDLE = /^[a-z0-9._]{1,30}$/;

/** A handle as Instagram writes it: lower case, no @, or null when it cannot be one. A profile link is accepted too. */
export function cleanHandle(h) {
  const s = String(h || "").trim();
  const fromLink = /instagram\.com\//i.test(s) ? instagramHandle(/^https?:/i.test(s) ? s : `https://${s}`) : null;
  const v = (fromLink || s.replace(/^@/, "")).toLowerCase();
  return HANDLE.test(v) ? v : null;
}

/** Our own Instagram account that asks: the first professional account connected to a Page the token sees. */
export async function discoveryAccount(client) {
  const pages = await client.list("me/accounts", { fields: "id,name,instagram_business_account{id,username}" });
  const hit = pages.find((p) => p.instagram_business_account?.id);
  if (!hit) throw new Error("the Meta token sees no Page with an Instagram account connected: connect Strategym's Instagram to Strategym's Page and assign both to the system user");
  return { id: hit.instagram_business_account.id, username: hit.instagram_business_account.username, page: hit.name };
}

const MEDIA_FIELDS = "id,media_type,media_url,permalink,timestamp,children{id,media_type,media_url}";
/** The latest `posts` posts of @handle, 25 a call, as Business Discovery pages them. */
export async function discoverPosts(client, asker, handle, { posts = DEFAULT_POSTS } = {}) {
  const out = [];
  let after = null, account = null, calls = 0;
  while (out.length < posts) {
    const n = Math.min(PAGE, posts - out.length);
    const media = `media${after ? `.after(${after})` : ""}.limit(${n}){${MEDIA_FIELDS}}`;
    let r;
    try { r = await client.get(asker.id, { fields: `business_discovery.username(${handle}){username,name,followers_count,media_count,${media}}` }); }
    catch (e) {
      if (!calls && /(\(#?110\)|\(#?100\)|Invalid user id|Cannot find User|does not exist)/i.test(e.message)) throw new Error(`Instagram has no business or creator account @${handle} that other accounts may read (a personal account cannot be read; check the handle)`);
      throw e;
    }
    calls++;
    const b = r.business_discovery || {};
    account ||= { username: b.username, name: b.name || null, followers: b.followers_count ?? null, posts: b.media_count ?? null };
    out.push(...(b.media?.data || []));
    after = b.media?.paging?.cursors?.after;
    if (!after || !(b.media?.data || []).length) break;
  }
  return { account, posts: out.slice(0, posts), calls };
}

/** The photos in a list of posts: a photo post's picture, each photo of a carousel; videos skipped and counted. */
export function photosOf(posts) {
  const photos = [];
  let videos = 0;
  for (const m of posts) {
    const base = { post_id: m.id, post: m.permalink || null, taken: m.timestamp || null };
    if (m.media_type === "IMAGE" && m.media_url) photos.push({ ...base, url: m.media_url, in_post: 1, of: 1 });
    else if (m.media_type === "CAROUSEL_ALBUM") {
      const kids = m.children?.data || [];
      kids.forEach((c, i) => { if (c.media_type === "IMAGE" && c.media_url) photos.push({ ...base, url: c.media_url, in_post: i + 1, of: kids.length }); else if (c.media_type === "VIDEO") videos++; });
    } else if (m.media_type === "VIDEO") videos++;
  }
  return { photos, videos };
}

/**
 * Read @handle's latest posts into brands/{gym}/onboarding/instagram/reading.json with the photos, their
 * thumbnails and the sort. Replaces an earlier reading, only once complete. `client`, `vision` and
 * `fetchImpl` are injectable; `allowLocal` lets the tests serve the pictures from this machine.
 */
export async function readInstagram({ handle, gymDir, posts = DEFAULT_POSTS, client = null, vision = callVision, fetchImpl = fetch, allowLocal = false, log = console.log, browser: given = null } = {}) {
  const h = cleanHandle(handle);
  if (!h) throw new Error(`"${handle}" is not an Instagram handle`);
  const n = Math.max(1, Math.min(MAX_POSTS, posts | 0 || DEFAULT_POSTS));
  const profile = existsSync(join(gymDir, "gym-profile.json")) ? JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf8")) : {};
  const gym = profile.display_name || basename(gymDir);
  const c = client || graphClient(metaConfig({ gym: basename(gymDir) }));
  const asker = await discoveryAccount(c);
  log(`Reading @${h}'s latest ${n} posts through @${asker.username}`);
  const { account, posts: list, calls: metaCalls } = await discoverPosts(c, asker, h, { posts: n });
  const { photos: found, videos } = photosOf(list);
  log(`  ${list.length} post${list.length === 1 ? "" : "s"}: ${found.length} photo${found.length === 1 ? "" : "s"}, ${videos} video${videos === 1 ? "" : "s"} skipped`);

  const out = join(gymDir, INSTAGRAM_DIR), tmp = `${out}.reading-${Date.now()}`;
  mkdirSync(join(tmp, "photos", "thumbs"), { recursive: true });
  const browser = given || (await launchBrowser());
  const problems = [];
  let calls = 0;
  try {
    const known = knownHashes(gymDir), shas = new Map(), photos = [];
    let failed = 0, i = 0;
    const take = async (f) => {
      try {
        checkUrl(f.url, { allowLocal });
        const r = await fetchImpl(f.url, { redirect: "follow" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_PHOTO_BYTES) throw new Error("over 25 MB");
        const kind = fileKind(buf), size = sizeOf(buf);
        if (!["png", "jpg", "webp"].includes(kind) || !size) throw new Error(`not a picture we read (${kind || "unknown"})`);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        if (shas.has(sha256)) { shas.get(sha256).also_in.push(f.post); return; }
        const id = `i${String(++i).padStart(3, "0")}`, file = `photos/${id}.${kind}`;
        writeFileSync(join(tmp, file), buf);
        const row = { id, file, post: f.post, post_id: f.post_id, taken: f.taken, in_post: f.in_post, of: f.of, also_in: [], size, bytes: buf.length, sha256, low_res: Math.max(...size) < MIN_PHOTO_PX, already_have: known.get(sha256) || null };
        shas.set(sha256, row); photos.push(row);
      } catch { failed++; }
    };
    for (let k = 0; k < found.length; k += 6) await Promise.all(found.slice(k, k + 6).map(take));
    if (failed) { problems.push(`${failed} photo${failed === 1 ? "" : "s"} could not be fetched`); log(`  ${failed} could not be fetched`); }
    // Newest first, as the account shows them.
    photos.sort((a, b) => String(b.taken).localeCompare(String(a.taken)) || a.in_post - b.in_post);
    await thumbsAndHashes(browser, tmp, photos);
    markRepeats(photos);
    const distinct = photos.filter((p) => !p.duplicate_of);
    log(`  ${photos.length} fetched, ${photos.length - distinct.length} the same picture as another, ${distinct.filter((p) => p.low_res).length} under ${MIN_PHOTO_PX} px, ${distinct.filter((p) => p.already_have).length} already in the gym's files`);
    log(`  sorting ${distinct.length} photo${distinct.length === 1 ? "" : "s"}…`);
    calls += await sortPhotos(distinct, { gym, vision, log });
    for (const p of photos) delete p.thumb_abs;
    const reading = { schema: 1, source: "instagram", handle: h, read_at: new Date().toISOString(), gym, account, asked_via: asker.username, posts_read: list.length, videos_skipped: videos, meta_calls: metaCalls, calls, min_photo_px: MIN_PHOTO_PX, photos, problems };
    writeFileSync(join(tmp, "reading.json"), JSON.stringify(reading, null, 2) + "\n");
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, ".."), { recursive: true });
    renameSync(tmp, out);
    const k = (kd) => distinct.filter((p) => p.kind === kd).length;
    log(`Done: ${distinct.length} photos (${k("premises")} premises, ${k("coaches")} coaches, ${k("members")} members, ${k("graphic")} graphics, ${k("other") + k("screenshot") + k("logo")} other) from ${list.length} posts; ${metaCalls} Meta call${metaCalls === 1 ? "" : "s"}, ${calls} model call${calls === 1 ? "" : "s"}.`);
    return reading;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    if (!given) await browser.close();
  }
}

/** The Instagram reading on disk, or null. */
export function readInstagramReading(gymDir) {
  try { return JSON.parse(readFileSync(join(gymDir, INSTAGRAM_DIR, "reading.json"), "utf8")); } catch { return null; }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "brand-dir": { type: "string" }, handle: { type: "string" }, posts: { type: "string", default: String(DEFAULT_POSTS) }, show: { type: "boolean", default: false } } });
  const gymDir = resolve(values["brand-dir"] || "");
  if (!values["brand-dir"] || !existsSync(gymDir)) { console.error("--brand-dir brands/{gym} is required"); process.exit(2); }
  if (values.show) { const r = readInstagramReading(gymDir); console.log(r ? JSON.stringify(r, null, 2) : "no reading yet"); process.exit(0); }
  const profile = existsSync(join(gymDir, "gym-profile.json")) ? JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf8")) : {};
  const handle = values.handle || profile.social?.instagram;
  if (!handle) { console.error("no --handle and the profile has no Instagram account (social.instagram)"); process.exit(2); }
  readInstagram({ handle, gymDir, posts: parseInt(values.posts, 10) || DEFAULT_POSTS })
    .then(() => process.exit(0))
    .catch((e) => { console.error(`Could not read Instagram: ${e.message}`); process.exit(1); });
}
