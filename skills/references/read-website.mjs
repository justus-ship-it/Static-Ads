/**
 * read-website.mjs — onboarding, part one: read a gym's own website into a proposal the owner accepts
 * item by item. Nothing here writes to the gym's profile or its brand assets: the reading lands in
 * brands/{gym}/onboarding/website/ (gitignored with the rest of brands/), and the panel's accept step
 * files what the owner ticks.
 *
 *   node skills/references/read-website.mjs --brand-dir brands/{gym} --url https://… [--pages 6]
 *
 * What it reads, with our own headless Chrome (render-composites' launcher, no dependency):
 *   - the home page and up to five more of the gym's pages (about, contact, locations, gallery, coaches…,
 *     chosen by their links' words; for a studio page on a franchise site, only pages under that studio)
 *   - identity: the name, the address and postal code (the site's schema.org data first, then the text),
 *     phone numbers, the Instagram and Facebook links (the Instagram handle is what the Instagram import
 *     will ask Meta for), opening hours when the site states them; the postal code is placed by OneMap
 *   - colours measured from the page's own styles (painted area, text, buttons), with the model picking
 *     primary / secondary / accent from those measured values while looking at the home page's
 *     screenshot (CLAUDE.md: the screenshot beats the CSS — the model only ever names a measured hex)
 *   - fonts: the headline and body families the page renders
 *   - logo candidates: header images and inline SVGs, anything named logo, the touch icon
 *   - every photo: the largest version the page offers (srcset), and where the site's image service keeps
 *     the original (Wix, Squarespace, WordPress, Shopify, Webflow, Next.js, Cloudinary, imgix,
 *     Contentful), that original — tried first, the page's own version if it fails
 * Photos are downloaded (png / jpg / webp by their first bytes; 25 MB cap), measured, made into
 * thumbnails in Chrome, told apart from each other (the same bytes, or the same picture at another size
 * by a perceptual hash — the larger kept) and from what the gym already has (by content hash), and
 * sorted by the vision model: premises · members · coaches · logo · graphic · screenshot · other, with
 * the people count, any lettering and whether it looks like a stock photo. A photo under MIN_PHOTO_PX on
 * its long side is marked low resolution: the accept step refuses it unless the owner overrides.
 *
 * Model calls: one per eight photos (the sort) and one for the colours — text answers only, no image
 * generation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from "fs";
import { join, resolve, extname, basename } from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { launchBrowser } from "./render-composites.mjs";
import { callVision, imageSize } from "./check-visual.mjs";
import { countryRules } from "./client-config.mjs";

/** A photo's long side must reach this to be filed without the owner's override: an ad is 1080 px square,
 *  and 1080 is also the widest Instagram serves, so a photo from either source can pass. */
export const MIN_PHOTO_PX = 1080;
/** Smaller than this on the long side is an icon or a thumbnail, never a photo: not downloaded twice, not shown. */
export const MIN_CANDIDATE_PX = 320;
export const PHOTO_KINDS = ["premises", "members", "coaches", "logo", "graphic", "screenshot", "other"];
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTOS = 60;
export const ONBOARDING_DIR = "onboarding/website";
const MAX_PAGES = 6, SORT_BATCH = 8, THUMB_PX = 640;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ONEMAP_URL = process.env.ONEMAP_URL || "https://www.onemap.gov.sg";

// ── addresses we will visit ─────────────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
/** A web address the reader may open: http(s), a public host. Returns the URL or throws with the reason. */
export function checkUrl(u, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(String(u || "").trim()); } catch { throw new Error(`"${u}" is not a web address (https://…)`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("only http and https addresses can be read");
  if (!allowLocal && PRIVATE_HOST.test(url.hostname)) throw new Error("that address is on this computer or a private network, not a public website");
  url.hash = "";
  return url;
}

/** Where a site's image service keeps the original of a resized picture, or null when there is no known way. */
export function originalUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  const h = url.hostname, p = url.pathname, img = /\.(jpe?g|png|webp)$/i;
  // Wix: /media/{id}.jpg/v1/fill/w_147,h_98,…/{name}.jpg → /media/{id}.jpg
  if (/(^|\.)wixstatic\.com$/.test(h)) { const m = p.match(/^(\/media\/[^/]+\.(?:jpe?g|png|webp))\/v1\//i); return m ? url.origin + m[1] : null; }
  // Squarespace: any ?format=… → the 2500w rendition (their largest).
  if (/(^|\.)(squarespace-cdn\.com|sqspcdn\.com)$/.test(h)) { if (url.searchParams.get("format") === "2500w") return null; url.search = "?format=2500w"; return url.href; }
  // WordPress: name-1024x683.jpg → name.jpg (the upload itself); a converter plugin's name-jpg.webp → name.jpg.
  if (/\/wp-content\/uploads\//.test(p)) { const q = p.replace(/-\d{2,5}x\d{2,5}(?=\.(jpe?g|png|webp)$)/i, "").replace(/-(jpe?g|png)\.webp$/i, ".$1"); if (q === p) return null; url.pathname = q; url.search = ""; return url.href; }
  // Shopify: name_600x.jpg, ?width=600 → name.jpg
  if (/(^|\.)cdn\.shopify\.com$/.test(h) || /\/cdn\/shop\//.test(p)) { const q = p.replace(/_(\d+x\d*|\d*x\d+)(@\dx)?(?=\.\w+$)/, ""); const had = url.searchParams.has("width") || url.searchParams.has("height"); if (q === p && !had) return null; url.pathname = q; url.searchParams.delete("width"); url.searchParams.delete("height"); return url.href; }
  // Webflow: name-p-500.jpeg → name.jpeg
  if (/(^|\.)(website-files\.com|webflow\.com)$/.test(h)) { const q = p.replace(/-p-\d+(?=\.\w+$)/, ""); if (q === p) return null; url.pathname = q; return url.href; }
  // Next.js's optimiser: /_next/image?url=…&w=640 → the url it was given.
  if (p.endsWith("/_next/image") && url.searchParams.get("url")) { try { return new URL(url.searchParams.get("url"), url.origin).href; } catch { return null; } }
  // Cloudinary: /image/upload/{transformations}/v123/x.jpg → /image/upload/v123/x.jpg
  if (/(^|\.)cloudinary\.com$/.test(h)) { const q = p.replace(/\/image\/upload\/((?:[a-z]{1,3}_[^/]+)\/)+/, "/image/upload/"); if (q === p) return null; url.pathname = q; return url.href; }
  // imgix and Contentful take the size in the query: without it, the original.
  if (/(^|\.)(imgix\.net|ctfassets\.net)$/.test(h) && img.test(p) && url.search) { url.search = ""; return url.href; }
  return null;
}

/** Every address worth trying for a picture's original, best first: originalUrl, and for a WordPress upload
 *  a converter plugin may have turned into .webp, the .jpg / .png it was made from. */
export function originalUrls(u) {
  const first = originalUrl(u), out = first ? [first] : [];
  const x = first || u;
  if (/\/wp-content\/uploads\/.+\.webp$/i.test(x)) for (const ext of ["jpg", "jpeg", "png"]) out.push(x.replace(/\.webp$/i, `.${ext}`));
  return [...new Set(out)].filter((x) => x !== u);
}

/** The largest candidate in a srcset (by its w or x descriptor). Commas inside URLs (Wix) are kept. */
export function largestInSrcset(srcset, base) {
  // The HTML rule: a URL runs to the next whitespace (commas inside it are its own, as Wix's are); a comma
  // ending it, or the descriptor after it, closes the candidate.
  const str = String(srcset || ""); let i = 0, best = null;
  while (i < str.length) {
    while (i < str.length && /[\s,]/.test(str[i])) i++;
    let j = i; while (j < str.length && !/\s/.test(str[j])) j++;
    let url = str.slice(i, j), desc = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else { let k = j; while (k < str.length && str[k] !== ",") k++; desc = str.slice(j, k).trim(); j = k + 1; }
    i = j;
    if (!url) continue;
    const m = desc.match(/^(\d+(?:\.\d+)?)([wx])$/), size = m ? Number(m[1]) * (m[2] === "x" ? 1000 : 1) : 0;
    let href; try { href = new URL(url, base).href; } catch { continue; }
    if (!best || size > best.size) best = { href, size };
  }
  return best?.href || null;
}

// ── what a page says about the gym (pure) ──────────────────────────────────

const SOCIAL_SKIP = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "share", "sharer", "sharer.php", "tr", "plugins", "dialog", "intent", "hashtag", "watch", "events", "groups"]);
/** The Instagram handle in a link to a profile (not a post), or null. */
export function instagramHandle(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
    const first = u.pathname.split("/").filter(Boolean)[0];
    if (!first || SOCIAL_SKIP.has(first.toLowerCase()) || !/^[A-Za-z0-9._]{1,30}$/.test(first)) return null;
    return first.toLowerCase();
  } catch { return null; }
}
export function facebookPage(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)(facebook|fb)\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length || SOCIAL_SKIP.has(parts[0].toLowerCase())) return null;
    if (parts[0] === "profile.php") return u.searchParams.get("id") ? `https://www.facebook.com/profile.php?id=${u.searchParams.get("id")}` : null;
    return `https://www.facebook.com/${parts[0]}`;
  } catch { return null; }
}

const GYM_TYPES = /LocalBusiness|ExerciseGym|HealthClub|SportsActivityLocation|SportsClub|Organization|Place|HealthAndBeautyBusiness/i;
/** Every object in a page's JSON-LD blocks, @graph flattened. */
function ldObjects(blocks) {
  const out = [];
  const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (!o || typeof o !== "object") return; out.push(o); if (o["@graph"]) walk(o["@graph"]); for (const k of ["location", "department", "subOrganization"]) if (o[k]) walk(o[k]); };
  for (const b of blocks || []) { try { walk(JSON.parse(b)); } catch {} }
  return out;
}
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Identity from what the pages said: schema.org data first (address, phone, geo, hours, sameAs), then the
 * text (a Singapore postal code and the line it sits on, +65 numbers), then the links (Instagram, Facebook).
 * `pages` are the collector's answers: { url, title, site_name, jsonld[], text, links[{href,text}] }.
 */
export function identityFrom(pages, { country = "SG" } = {}) {
  const cr = countryRules(country), sg = String(country || "SG").toUpperCase() === "SG";
  const addresses = [], phones = new Set(), instagram = new Map(), facebook = new Map(), hours = new Set(), names = new Set();
  const addAddress = (a) => { if (!a.postal_code || !cr.postal.test(a.postal_code)) return; const had = addresses.find((x) => x.postal_code === a.postal_code); if (had) { if (!had.lat && a.lat) Object.assign(had, { lat: a.lat, lng: a.lng }); if (a.from === "schema.org" && had.from !== "schema.org") Object.assign(had, a); return; } addresses.push(a); };
  for (const pg of pages) {
    for (const o of ldObjects(pg.jsonld)) {
      const t = [o["@type"]].flat().join(" ");
      if (!GYM_TYPES.test(t)) continue;
      if (o.name && typeof o.name === "string") names.add(oneLine(o.name));
      for (const a of [o.address].flat().filter(Boolean)) {
        if (typeof a === "string") { const m = a.match(/\b(\d{3,6})\b/); if (m && cr.postal.test(m[1])) addAddress({ address: oneLine(a), postal_code: m[1], from: "schema.org", page: pg.url }); continue; }
        const pc = String(a.postalCode || "").trim().match(/^[A-Za-z0-9 -]{3,10}$/)?.[0];
        let line = "";
        for (const part of [a.streetAddress, a.addressLocality, a.postalCode].filter(Boolean).map(oneLine)) if (!line.toLowerCase().includes(part.toLowerCase())) line = line ? `${line}, ${part}` : part;
        const geo = o.geo && Number.isFinite(Number(o.geo.latitude)) ? { lat: Number(o.geo.latitude), lng: Number(o.geo.longitude) } : {};
        if (pc) addAddress({ address: line, postal_code: pc, from: "schema.org", page: pg.url, ...geo });
      }
      for (const p of [o.telephone].flat().filter(Boolean)) phones.add(oneLine(p));
      for (const h of [o.openingHours].flat().filter(Boolean)) hours.add(oneLine(h));
      for (const s of [o.sameAs].flat().filter(Boolean)) { const ig = instagramHandle(s); if (ig) instagram.set(ig, (instagram.get(ig) || 0) + 2); const fb = facebookPage(s); if (fb) facebook.set(fb, (facebook.get(fb) || 0) + 2); }
    }
    const lines = String(pg.text || "").split(/\n+/).map(oneLine).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      // The text's postal codes: Singapore's six digits after "Singapore" or "S"; elsewhere only schema.org data is trusted (a bare number is anything).
      for (const m of sg ? lines[i].matchAll(/(?:Singapore|S)\s*\(?(\d{6})\)?/g) : []) {
        // The address is the line with the postal code, and the line before it when that one is short.
        let line = lines[i].length > 160 ? lines[i].slice(Math.max(0, m.index - 110), m.index + 20) : lines[i];
        if (line.length < 30 && i > 0 && lines[i - 1].length < 90) line = `${lines[i - 1]}, ${line}`;
        addAddress({ address: oneLine(line), postal_code: m[1], from: "text", page: pg.url });
      }
      if (sg) { for (const m of lines[i].matchAll(/(?:\+65[\s-]?)?(?<![\d])([689]\d{3})[\s-]?(\d{4})(?![\d])/g)) if (/\+65|tel|call|phone|whatsapp|contact|hp|mobile/i.test(lines[i]) || m[0].startsWith("+65")) phones.add(`+65 ${m[1]} ${m[2]}`); }
      else if (cr.phone) { for (const m of lines[i].matchAll(new RegExp(`\\${cr.phone}[\\s-]?(\\d[\\d\\s-]{6,12}\\d)`, "g"))) phones.add(`${cr.phone} ${m[1].replace(/[\s-]+/g, " ").trim()}`); }
    }
    for (const l of pg.links || []) {
      const ig = instagramHandle(l.href); if (ig) instagram.set(ig, (instagram.get(ig) || 0) + 1);
      const fb = facebookPage(l.href); if (fb) facebook.set(fb, (facebook.get(fb) || 0) + 1);
      const tel = String(l.href || "").match(/^tel:(.+)$/i); if (tel) phones.add(oneLine(decodeURIComponent(tel[1])));
    }
    if (pg.site_name) names.add(oneLine(pg.site_name));
  }
  const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, seen: n }));
  const norm = (p) => p.replace(/[^\d+]/g, "").replace(/^(?!\+)(?=[689]\d{7}$)/, "+65");
  const seen = new Set(), phoneList = [];
  for (const p of phones) { const k = norm(p); if (seen.has(k)) continue; seen.add(k); phoneList.push(p); }
  return { names: [...names], addresses, phones: phoneList, instagram: byCount(instagram), facebook: byCount(facebook), hours: [...hours] };
}

/** Which of the home page's links are worth reading too: the gym's own pages about itself, by their words. */
export function pagesToRead(home, links, max = MAX_PAGES - 1) {
  const start = new URL(home), dir = start.pathname.replace(/[^/]*$/, "");
  const WORDS = [[/about|our[- ]story|who[- ]we|discover/i, 5], [/contact|find[- ]us|visit|location|studio/i, 5], [/gallery|facilit|tour|space|photos?/i, 6], [/coach|trainer|team|staff/i, 5], [/class|program|timetable|schedule|service|training/i, 3], [/membership|pricing|price|join/i, 1]];
  const scored = new Map();
  for (const l of links) {
    let u; try { u = new URL(l.href, home); } catch { continue; }
    u.hash = ""; u.search = ""; if (!u.pathname.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(u.pathname)) u.pathname += "/";
    if (u.hostname !== start.hostname || u.href === start.href || /\.(pdf|jpe?g|png|webp|zip)$/i.test(u.pathname) || /\/www\./i.test(u.pathname)) continue;
    // A studio page on a franchise site: only the pages under that studio, never the whole brand's site.
    if (dir !== "/" && !u.pathname.startsWith(dir)) continue;
    const words = `${u.pathname} ${l.text || ""}`;
    // Any short page of the site counts a little, so a small site with plain page names is still read whole.
    const depth = u.pathname.split("/").filter(Boolean).length - dir.split("/").filter(Boolean).length;
    const score = WORDS.reduce((s, [re, w]) => s + (re.test(words) ? w : 0), 0) + (depth <= 1 && (l.text || "").trim() ? 0.5 : 0);
    if (score && (!scored.has(u.href) || scored.get(u.href) < score)) scored.set(u.href, score);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([href]) => href);
}

const toHex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const sat = (hex) => { const [r, g, b] = rgbOf(hex).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
/** The measured colours worth offering: near-duplicates merged, ranked by where they appear. */
export function colourCandidates(measured, max = 12) {
  const list = Object.values(measured || {}).filter((c) => /^#[0-9A-F]{6}$/.test(c.hex));
  const total = { bg: list.reduce((s, c) => s + c.bg, 0) || 1, text: list.reduce((s, c) => s + c.text, 0) || 1 };
  const scored = list.map((c) => ({ hex: c.hex, share_bg: c.bg / total.bg, share_text: c.text / total.text, buttons: c.button || 0 }))
    .map((c) => ({ ...c, score: c.share_bg + c.share_text * 0.6 + Math.min(c.buttons, 6) * 0.08 + (sat(c.hex) > 0.35 ? 0.05 : 0) }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  const near = (a, b) => { const [x, y] = [rgbOf(a), rgbOf(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 18; };
  for (const c of scored) { const twin = out.find((o) => near(o.hex, c.hex)); if (twin) { twin.share_bg += c.share_bg; twin.share_text += c.share_text; twin.buttons += c.buttons; continue; } out.push(c); if (out.length >= max) break; }
  return out.map(({ hex, share_bg, share_text, buttons }) => ({ hex, share_bg: +share_bg.toFixed(3), share_text: +share_text.toFixed(3), buttons }));
}

const GENERIC_FONTS = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|segoe ui|helvetica( neue)?|arial|roboto|times( new roman)?|apple color emoji|segoe ui emoji|noto color emoji|inherit|initial)$/i;
/** The first real family in a CSS font-family list ("Montserrat", sans-serif → Montserrat). */
export function firstFamily(stack) {
  for (const f of String(stack || "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))) if (f && !GENERIC_FONTS.test(f)) return f;
  return null;
}

// ── the browser side ────────────────────────────────────────────────────────

// Runs inside the gym's page. Everything it returns is plain data; it never clicks, submits or accepts.
const COLLECT = String.raw`(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const hex = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); if ((v[3] ?? 1) < 0.6) return null; return '#' + v.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase(); };
  const shown = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return null; const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity < 0.15) return null; return r; };
  const colours = {}; const add = (h, w, kind) => { if (!h || !(w > 0)) return; const c = colours[h] || (colours[h] = { hex: h, bg: 0, text: 0, button: 0 }); c[kind] += w; };
  add(hex(getComputedStyle(document.body).backgroundColor) || hex(getComputedStyle(document.documentElement).backgroundColor) || '#FFFFFF', innerWidth * Math.min(document.documentElement.scrollHeight, 6000), 'bg');
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i]; const r = shown(el); if (!r) continue; const s = getComputedStyle(el);
    add(hex(s.backgroundColor), Math.min(r.width, innerWidth) * Math.min(r.height, 1500), 'bg');
    let own = 0; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent.trim().length;
    if (own) add(hex(s.color), own * parseFloat(s.fontSize || '16'), 'text');
    if (el.matches('button, [role=button], input[type=submit], a[class*=btn], a[class*=button], .btn, .button')) { add(hex(s.backgroundColor), 1, 'button'); }
  }
  const fam = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : null; };
  const fonts = { h1: fam('h1'), h2: fam('h2'), body: getComputedStyle(document.body).fontFamily, p: fam('p'), button: fam('button, .btn, a[class*=button]'), faces: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, '')))].slice(0, 20) };
  const images = [];
  const pushImg = (urls, info) => { const u = urls.map(abs).filter((x) => x && /^https?:/.test(x)); if (u.length) images.push({ urls: [...new Set(u)], ...info }); };
  // The header: a header or nav element, or anything near the top of the page inside a "header" block
  // (page builders put that word on every row's class).
  const inHead = (el) => { const top = el.getBoundingClientRect().top + scrollY; return top < 260 && !!el.closest('header, nav, [role=banner], [class*=header], [id*=header], [class*=navbar], [class*=Header]'); };
  for (const im of document.images) {
    const r = im.getBoundingClientRect();
    const urls = [];
    const sets = [im.getAttribute('srcset'), im.getAttribute('data-srcset'), ...[...(im.closest('picture')?.querySelectorAll('source') || [])].map((s) => s.getAttribute('srcset') || s.getAttribute('data-srcset'))].filter(Boolean);
    for (const s of sets) urls.push({ srcset: s });
    for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-full', 'data-hi-res-src']) if (im.getAttribute(a)) urls.push(im.getAttribute(a));
    if (im.currentSrc) urls.push(im.currentSrc); if (im.getAttribute('src')) urls.push(im.getAttribute('src'));
    images.push({ raw: urls, w: im.naturalWidth, h: im.naturalHeight, shown: [Math.round(r.width), Math.round(r.height)], alt: (im.alt || '').slice(0, 120), hint: ((typeof im.className === 'string' ? im.className : '').split(/\s+/).filter((t) => /^([a-z0-9]+[-_])*logo([-_](img|image|main|header|dark|light|white|black))?$/i.test(t)).join(' ') + ' ' + ((im.getAttribute('src') || '').split('?')[0].split('/').pop() || '')).slice(0, 200), header: inHead(im), top: Math.round(r.top + scrollY), home_link: !!im.closest('a[href="/"], a[href="./"], a[href="' + location.origin + '/"]') });
  }
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i]; const bi = getComputedStyle(el).backgroundImage; if (!bi || bi === 'none') continue;
    const r = el.getBoundingClientRect(); if (r.width * r.height < 40000 && !inHead(el)) continue;
    for (const m of bi.matchAll(/url\(["']?([^"')]+)["']?\)/g)) images.push({ raw: [m[1]], w: 0, h: 0, shown: [Math.round(r.width), Math.round(r.height)], alt: '', hint: (typeof el.className === 'string' ? el.className : '').slice(0, 120), header: inHead(el), top: Math.round(r.top + scrollY), background: true });
  }
  const svgs = [];
  for (const s of document.querySelectorAll('header svg, nav svg, [class*=header] svg, [class*=logo] svg, svg[class*=logo], a[href="/"] svg')) {
    const r = s.getBoundingClientRect(); if (r.width < 40 || r.height < 12) continue;
    const html = s.outerHTML; if (html.length > 200000) continue;
    const link = s.closest('a'); svgs.push({ svg: html.includes('xmlns=') ? html : html.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'), shown: [Math.round(r.width), Math.round(r.height)], hint: ((s.getAttribute('class') || '') + ' ' + (s.getAttribute('aria-label') || '') + ' ' + (link?.getAttribute('aria-label') || '')).slice(0, 200), color: getComputedStyle(s).color, top: Math.round(r.top + scrollY) });
  }
  const icons = [...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon], link[rel=apple-touch-icon-precomposed]')].map((l) => ({ href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || '', rel: l.getAttribute('rel') }));
  const meta = (n) => document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]')?.getAttribute('content') || null;
  return {
    url: location.href, title: document.title, description: meta('description') || meta('og:description'), site_name: meta('og:site_name'), og_image: abs(meta('og:image') || ''), theme_color: meta('theme-color'),
    jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).slice(0, 20),
    links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: abs(a.getAttribute('href')), text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) })).filter((l) => l.href).slice(0, 800),
    text: (document.body.innerText || '').slice(0, 40000),
    colours, fonts, images: images.slice(0, 400), svgs: svgs.slice(0, 8), icons,
    height: document.documentElement.scrollHeight,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); })]).finally(() => clearTimeout(t)); };

/** Open a page in the reader's tab and let it settle: the load event (or 25 s), then a slow scroll to the
 *  bottom so lazy images load, then back to the top. */
async function openPage(browser, url, { width = 1440, height = 900 } = {}) {
  const { cdp, sessionId } = browser;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  const nav = await cdp.send("Page.navigate", { url }, sessionId);
  if (nav.errorText) throw new Error(`the page could not be opened (${nav.errorText})`);
  await withTimeout(loaded, 25000, "page load").catch(() => {});
  await sleep(1500);
  const ev = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  await ev(`(async () => { const H = () => document.documentElement.scrollHeight; for (let y = 0, n = 0; y < H() && n < 40; y += Math.round(innerHeight * 0.8), n++) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 250)); } scrollTo(0, 0); await new Promise((r) => setTimeout(r, 600)); })()`).catch(() => {});
}
async function collect(browser) {
  const { result, exceptionDetails } = await browser.cdp.send("Runtime.evaluate", { expression: COLLECT, returnByValue: true }, browser.sessionId);
  if (exceptionDetails) throw new Error(`reading the page failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
}
async function screenshot(browser, { width = 1440, height = 900 } = {}) {
  const shot = await browser.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } }, browser.sessionId);
  return Buffer.from(shot.data, "base64");
}

// ── downloading ─────────────────────────────────────────────────────────────

/** What a file is, by its first bytes. */
export function fileKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "gif";
  if (buf.subarray(4, 12).toString("ascii").startsWith("ftypavi")) return "avif";
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 2048).toString("utf8"))) return "svg";
  return null;
}
async function fetchBytes(url, { referer, fetchImpl = fetch, max = MAX_PHOTO_BYTES, allowLocal = false } = {}) {
  checkUrl(url, { allowLocal });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    // No AVIF in what we accept: the pipeline reads png, jpg and webp.
    const r = await fetchImpl(url, { headers: { "user-agent": UA, accept: "image/webp,image/png,image/jpeg;q=0.9,image/svg+xml;q=0.8,*/*;q=0.3", ...(referer ? { referer } : {}) }, redirect: "follow", signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get("content-length")) > max) throw new Error("over 25 MB");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new Error("over 25 MB");
    return buf;
  } finally { clearTimeout(t); }
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
/** A name for a downloaded file from its address: the last meaningful path segment, slugged. */
export function nameFromUrl(u, fallback = "photo") {
  try {
    const segs = new URL(u).pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s).replace(/\.[a-z0-9]{2,5}$/i, ""));
    const pick = segs.reverse().find((s) => /[a-z]{3}/i.test(s) && !/^(v1|fill|fit|crop|media|image|images|upload|uploads|files|w_\d+.*)$/i.test(s));
    return slug(pick) || fallback;
  } catch { return fallback; }
}

// ── the model's two readings ────────────────────────────────────────────────

const SORT_SCHEMA = { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: {
  index: { type: "INTEGER" }, kind: { type: "STRING", enum: PHOTO_KINDS }, people: { type: "INTEGER" }, lettering: { type: "STRING", enum: ["none", "small", "prominent"] }, stock: { type: "BOOLEAN" }, before_after: { type: "BOOLEAN" }, what: { type: "STRING" },
}, required: ["index", "kind", "people", "lettering", "stock", "before_after", "what"] } } }, required: ["items"] };
export const sortQuestion = (n, gym) => `These ${n} images were taken from ${gym ? `the website of ${gym}, a gym` : "a gym's website"}. For each image, in order (index 0 is the first), say what it is.
- kind: premises (the gym's rooms, floor or equipment, where people are small or absent), members (people training who are not clearly the gym's staff), coaches (a trainer: a staff portrait, a team photo, or a trainer coaching as the clear subject), logo (a logo or wordmark on its own), graphic (a designed image: a poster, banner, flyer, promotion, an illustration or mostly words), screenshot (of an app, a web page or a phone), other (anything else: food, a map, a product, a scene not at a gym)
- people: how many people are visible
- lettering: none, small (a small mark, a label, a logo on clothing or a wall), or prominent (words set over the picture, a banner, a big sign)
- stock: true when it looks like a generic stock photo rather than this gym's own premises or people (a studio backdrop, a model shoot unrelated to this room, a watermark)
- before_after: true when it compares a body before and after (a transformation, side by side or in two frames)
- what: what the image shows, in 3 to 10 plain words`;

/** Sort photos by the vision model, eight thumbnails a call. `vision` is callVision (injectable for tests). */
export async function sortPhotos(photos, { gym, vision = callVision, log = () => {} } = {}) {
  let calls = 0;
  for (let i = 0; i < photos.length; i += SORT_BATCH) {
    const group = photos.slice(i, i + SORT_BATCH);
    try {
      const { items = [] } = await vision(group.map((p) => p.thumb_abs), sortQuestion(group.length, gym), SORT_SCHEMA);
      calls++;
      for (const it of items) { const p = group[it.index]; if (!p) continue; Object.assign(p, { kind: PHOTO_KINDS.includes(it.kind) ? it.kind : "other", people: Math.max(0, it.people | 0), lettering: it.lettering, stock: !!it.stock, before_after: !!it.before_after, what: String(it.what || "").slice(0, 120) }); }
    } catch (e) { calls++; log(`  the sort could not read photos ${i + 1}-${i + group.length}: ${e.message.slice(0, 160)} (they are listed as "other")`); }
    for (const p of group) if (!p.kind) Object.assign(p, { kind: "other", people: null, lettering: null, stock: null, what: "" });
  }
  return calls;
}

const BRAND_SCHEMA = { type: "OBJECT", properties: {
  primary: { type: "STRING" }, secondary: { type: "STRING" }, accent: { type: "STRING" }, why: { type: "STRING" }, name: { type: "STRING" }, headline_look: { type: "STRING" }, logo_index: { type: "INTEGER" },
}, required: ["primary", "why", "name"] };
export const brandQuestion = (candidates, url, logos) => `This is the top of the home page of ${url}, a gym's website. The colours below were measured from the page's styles: each hex with its share of the painted background, its share of the text, and how many buttons use it.
${candidates.map((c) => `- ${c.hex}: background ${(c.share_bg * 100).toFixed(1)}%, text ${(c.share_text * 100).toFixed(1)}%, buttons ${c.buttons}`).join("\n")}

Pick the gym's brand colours as they look on this page: primary (the colour that most identifies the brand), secondary (the next), accent (a highlight such as the buttons). Use hex values from the list only, exactly as written; leave secondary or accent empty when the page has no such colour. Plain white, black and greys count only when the brand is clearly built on them. In why, say in one sentence where each colour appears.
Also give: name, the gym's name as the site shows it; headline_look, the headline typeface's look in a few words (e.g. heavy condensed all-caps sans).${logos ? `\nAfter the screenshot come ${logos} logo candidates, in order: logo_index is the one that is this gym's own logo (0 is the first), or -1 when none is.` : ""}`;

// ── the reading ─────────────────────────────────────────────────────────────

/**
 * Read a gym's website into brands/{gym}/onboarding/website/reading.json (+ the downloaded photos, their
 * thumbnails, the logo candidates and the home page's screenshot). Replaces any earlier reading.
 * `vision`, `fetchImpl` and `geocode` are injectable; `allowLocal` lets the tests serve a site from this machine.
 */
export async function readWebsite({ url, gymDir, maxPages = MAX_PAGES, vision = callVision, fetchImpl = fetch, geocode = onemapPlace, allowLocal = false, log = console.log, browser: given = null } = {}) {
  const start = checkUrl(url, { allowLocal });
  const profile = existsSync(join(gymDir, "gym-profile.json")) ? JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf8")) : {};
  const gym = profile.display_name || basename(gymDir);
  const out = join(gymDir, ONBOARDING_DIR), tmp = `${out}.reading-${Date.now()}`;
  clearStaleWork(out);
  mkdirSync(join(tmp, "photos", "thumbs"), { recursive: true });
  mkdirSync(join(tmp, "logos"), { recursive: true });
  const browser = given || (await launchBrowser());
  const problems = [];
  let calls = 0;
  try {
    await browser.cdp.send("Network.enable", {}, browser.sessionId).catch(() => {});
    await browser.cdp.send("Network.setUserAgentOverride", { userAgent: UA }, browser.sessionId).catch(() => {});
    log(`Reading ${start.href}`);
    await openPage(browser, start.href);
    const home = await collect(browser);
    writeFileSync(join(tmp, "home.png"), await screenshot(browser));
    const pages = [home];
    for (const href of pagesToRead(home.url || start.href, home.links, Math.max(0, maxPages - 1))) {
      try { await openPage(browser, href); const pg = await collect(browser); if (pages.some((x) => x.url === pg.url)) continue; pages.push(pg); log(`  read ${pg.url} (${pg.images.length} images)`); }
      catch (e) { problems.push(`${href}: ${e.message}`); log(`  could not read ${href}: ${e.message}`); }
    }
    log(`  ${pages.length} page${pages.length === 1 ? "" : "s"} read`);

    // Identity, with the postal code placed on the map when the site gave no coordinates.
    const identity = identityFrom(pages, { country: profile?.locale?.country || "SG" });
    for (const a of identity.addresses) if (!Number.isFinite(a.lat) && geocode && countryRules(profile?.locale?.country).geocoder === "onemap") { try { const g = await geocode(a.postal_code, { fetchImpl }); if (g) Object.assign(a, g); } catch {} }

    // Photos: every candidate URL of every image, the original tried first; downloaded once each. Images in
    // the header, linking home or named logo are logo candidates, never photos.
    const seenUrls = new Set(), seenSvg = new Set(), wanted = [], svgLogos = [];
    // A link straight to an image file is a gallery's full-size picture (a lightbox): a candidate like any image.
    for (const pg of pages) for (const l of pg.links || []) if (/\.(jpe?g|png|webp)(\?|$)/i.test(l.href || "")) pg.images.push({ raw: [l.href], w: 0, h: 0, shown: [0, 0], alt: l.text || "", hint: "linked image", top: 99999, linked: true });
    for (const pg of pages) for (const im of pg.images) {
      const urls = [];
      for (const r of im.raw || []) { const u = typeof r === "string" ? r : largestInSrcset(r.srcset, pg.url); if (u) { try { urls.push(new URL(u, pg.url).href); } catch {} } }
      // A logo: in the header, linking home, or named logo in its file or class — its alt text alone only when it
      // is logo-sized (a franchise labels member photos "F45 - Logo Home").
      const bigPx = Math.max(im.w || 0, im.h || 0, im.shown?.[0] || 0, im.shown?.[1] || 0);
      const logoish = !im.background && !im.linked && (im.header || im.home_link || /logo/i.test(im.hint || "") || (/logo/i.test(im.alt || "") && bigPx < 700));
      if (logoish) for (const u of urls.filter((u) => /\.svg(\?|$)/i.test(u))) if (!seenSvg.has(u)) { seenSvg.add(u); svgLogos.push({ url: u, hint: `${im.alt} ${im.hint}`.trim(), top: im.top }); }
      const good = [...new Set(urls.filter((u) => /^https?:/.test(u) && !/\.(svg|gif|avif)(\?|$)/i.test(u)))];
      if (!good.length || seenUrls.has(good[0])) continue;
      good.forEach((u) => seenUrls.add(u));
      const origs = originalUrls(good[0]);
      // Small on the page is no reason to skip a picture whose original the site keeps (a 200 px thumbnail of
      // a 2000 px upload); without one, an icon stays an icon. A logo is kept at any size.
      const shownPx = Math.max(im.shown?.[0] || 0, im.shown?.[1] || 0), natural = Math.max(im.w || 0, im.h || 0);
      if (!logoish && !im.background && !origs.length && natural && natural < MIN_CANDIDATE_PX && shownPx < MIN_CANDIDATE_PX) continue;
      wanted.push({ page: pg.url, origs, urls: good, alt: im.alt, hint: im.hint, top: im.top, logoish });
    }
    log(`  ${wanted.length} image${wanted.length === 1 ? "" : "s"} to fetch`);
    const photos = [], logos = [], shas = new Map(), errors = [];
    let n = 0, li = 0;
    const known = knownHashes(gymDir);
    const take = async (w) => {
      // The original where the site's image service keeps one, else the largest the page offers; the next
      // candidate only when those fail.
      let buf = null, from = null, kind = null;
      for (const u of [...w.origs, ...w.urls]) {
        try { const b = await fetchBytes(u, { referer: w.page, fetchImpl, allowLocal }); const k = fileKind(b); if (!["png", "jpg", "webp"].includes(k)) continue; buf = b; from = u; kind = k; break; } catch {}
      }
      if (!buf) { errors.push(w.urls[0]); return; }
      const size = sizeOf(buf);
      if (!size) return;
      const sha256 = createHash("sha256").update(buf).digest("hex");
      if (shas.has(sha256)) { shas.get(sha256).also_on?.push(w.page); return; }
      if (w.logoish) {
        if (Math.max(...size) < 40) return;
        const id = `logo-${++li}`, file = `logos/${id}-${nameFromUrl(from, "logo")}.${kind}`;
        writeFileSync(join(tmp, file), buf);
        const row = { id, file, url: from, from: w.top < 260 ? "image in the header" : "image named logo", size, sha256, hint: `${w.alt || ""}`.trim(), score: (/logo/i.test(`${from} ${w.alt} ${w.hint}`) ? 3 : 0) + (w.top < 260 ? 2 : 0), already_have: known.get(sha256) || null };
        shas.set(sha256, row); logos.push(row);
        return;
      }
      if (Math.max(...size) < MIN_CANDIDATE_PX) return;
      const id = `p${String(++n).padStart(2, "0")}`, file = `photos/${id}-${nameFromUrl(from, "photo")}.${kind}`;
      writeFileSync(join(tmp, file), buf);
      const row = { id, file, url: from, original: w.origs.includes(from), page_url: w.page, also_on: [], alt: w.alt || "", size, bytes: buf.length, sha256, low_res: Math.max(...size) < MIN_PHOTO_PX, already_have: known.get(sha256) || null };
      shas.set(sha256, row);
      photos.push(row);
    };
    for (let i = 0; i < wanted.length && photos.length < MAX_PHOTOS * 2; i += 4) await Promise.all(wanted.slice(i, i + 4).map(take));
    if (errors.length) log(`  ${errors.length} image${errors.length === 1 ? "" : "s"} could not be fetched`);
    const originals = photos.filter((p) => p.original).length;
    if (originals) log(`  ${originals} of them as the site's original upload rather than the page's smaller copy`);

    // Thumbnails and a perceptual hash in Chrome: the same picture at two sizes is one photo (the larger kept).
    await thumbsAndHashes(browser, tmp, photos);
    markRepeats(photos);
    const distinct = photos.filter((p) => !p.duplicate_of);
    // The largest first, up to MAX_PHOTOS: a site with hundreds of thumbnails still gives a card one can read.
    const keep = distinct.sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1]).slice(0, MAX_PHOTOS);
    for (const p of distinct.slice(MAX_PHOTOS)) p.dropped = "more than the card shows";
    log(`  ${photos.length} photo${photos.length === 1 ? "" : "s"} fetched, ${photos.length - distinct.length} the same picture as another, ${keep.filter((p) => p.low_res).length} under ${MIN_PHOTO_PX} px`);

    // Logo candidates: the header's images (above), its inline SVGs and SVG files, the touch icon last.
    const plainSvg = (t) => !/<script|\bon[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i.test(t);
    for (const s of pages[0].svgs || []) {
      if (!plainSvg(s.svg)) continue;
      const svg = s.color && /currentColor/.test(s.svg) ? s.svg.replace(/currentColor/g, s.color) : s.svg;
      const id = `logo-${++li}`, file = `logos/${id}.svg`; writeFileSync(join(tmp, file), svg);
      logos.push({ id, file, from: "inline svg in the header", shown: s.shown, hint: s.hint.trim(), score: (/logo/i.test(s.hint) ? 3 : 0) + (s.top < 260 ? 2 : 0) });
    }
    for (const s of svgLogos.slice(0, 4)) {
      try { const b = await fetchBytes(s.url, { fetchImpl, allowLocal }); if (fileKind(b) !== "svg" || !plainSvg(b.toString("utf8"))) continue; const id = `logo-${++li}`, file = `logos/${id}-${nameFromUrl(s.url, "logo")}.svg`; writeFileSync(join(tmp, file), b); logos.push({ id, file, url: s.url, from: "svg file in the header", hint: s.hint, score: (/logo/i.test(`${s.url} ${s.hint}`) ? 3 : 0) + (s.top < 260 ? 2 : 0) + 1 }); } catch {}
    }
    const icon = [...(home.icons || [])].sort((a, b) => (parseInt(b.sizes) || (/apple/.test(b.rel) ? 180 : 0)) - (parseInt(a.sizes) || (/apple/.test(a.rel) ? 180 : 0)))[0];
    if (icon?.href && !logos.some((l) => l.url === icon.href)) { try { const b = await fetchBytes(icon.href, { fetchImpl, allowLocal }); const k = fileKind(b); if (["png", "jpg", "webp", "svg"].includes(k)) { const id = `logo-${++li}`, file = `logos/${id}-icon.${k}`; writeFileSync(join(tmp, file), b); logos.push({ id, file, url: icon.href, from: "the site's icon", size: k === "svg" ? null : sizeOf(b), score: -1 }); } } catch {} }
    logos.sort((a, b) => b.score - a.score);

    // Colours and the logo, read by the model off the screenshot, from the measured values.
    const candidates = colourCandidates(home.colours);
    if (home.theme_color && /^#[0-9a-f]{6}$/i.test(home.theme_color) && !candidates.some((c) => c.hex === home.theme_color.toUpperCase())) candidates.push({ hex: home.theme_color.toUpperCase(), share_bg: 0, share_text: 0, buttons: 0, theme_color: true });
    const logoPngs = logos.filter((l) => /\.(png|jpe?g|webp)$/.test(l.file)).slice(0, 4);
    let brand = null;
    try {
      brand = await vision([join(tmp, "home.png"), ...logoPngs.map((l) => join(tmp, l.file))], brandQuestion(candidates, start.href, logoPngs.length), BRAND_SCHEMA);
      calls++;
    } catch (e) { calls++; problems.push(`the colours could not be read by the model: ${e.message.slice(0, 160)}`); log(`  the colour reading failed: ${e.message.slice(0, 160)}`); }
    const pick = (h) => { const x = String(h || "").trim().toUpperCase(); return candidates.some((c) => c.hex === x) ? x : null; };
    const proposal = brand ? { primary: pick(brand.primary), secondary: pick(brand.secondary), accent: pick(brand.accent), why: String(brand.why || "").slice(0, 400) } : { primary: candidates.find((c) => sat(c.hex) > 0.35)?.hex || candidates[0]?.hex || null, secondary: null, accent: null, why: "the model could not be asked; the most-used saturated colour" };
    if (brand && Number.isInteger(brand.logo_index) && logoPngs[brand.logo_index]) { const l = logoPngs[brand.logo_index]; l.model_pick = true; logos.splice(logos.indexOf(l), 1); logos.unshift(l); }

    // The sort, on what the card will show.
    log(`  sorting ${keep.length} photo${keep.length === 1 ? "" : "s"}…`);
    calls += await sortPhotos(keep, { gym, vision, log });
    for (const p of photos) delete p.thumb_abs;

    const fonts = { headline: firstFamily(home.fonts?.h1) || firstFamily(home.fonts?.h2), body: firstFamily(home.fonts?.p) || firstFamily(home.fonts?.body), loaded: home.fonts?.faces || [], headline_look: brand?.headline_look || null };
    const reading = {
      schema: 1, url: start.href, read_at: new Date().toISOString(), gym, calls, min_photo_px: MIN_PHOTO_PX,
      pages: pages.map((p) => ({ url: p.url, title: p.title, images: p.images.length })),
      site: { title: home.title, description: home.description, site_name: home.site_name, theme_color: home.theme_color, name_seen: brand?.name || null },
      identity, colours: { candidates, proposal }, fonts, logos, photos, screenshot: "home.png", problems,
    };
    writeFileSync(join(tmp, "reading.json"), JSON.stringify(reading, null, 2) + "\n");
    // The new reading replaces the old one whole, only once it is complete.
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, ".."), { recursive: true });
    renameSync(tmp, out);
    const k = (kind) => keep.filter((p) => p.kind === kind).length;
    log(`Done: ${keep.length} photos (${k("premises")} premises, ${k("coaches")} coaches, ${k("members")} members, ${k("graphic")} graphics, ${k("other") + k("screenshot") + k("logo")} other), ${logos.length} logo candidate${logos.length === 1 ? "" : "s"}, ${identity.addresses.length} address${identity.addresses.length === 1 ? "" : "es"}, Instagram ${identity.instagram[0]?.value ? "@" + identity.instagram[0].value : "not linked"}; ${calls} model call${calls === 1 ? "" : "s"}.`);
    return reading;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    if (!given) await browser.close();
  }
}

/** How far apart two 32×32 grey copies are: the mean difference per pixel, 0–255. */
export function greyDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let d = 0; for (let i = 0; i < a.length; i += 2) d += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
  return d / (a.length / 2);
}
/** The same picture at another size is `duplicate_of` the larger: a close perceptual hash, the same shape, and the
 *  same pixels on a 32×32 grid — the hash alone took different people's posts on one template for one picture
 *  (Sculpt Society's before-and-after series, 2026-09-29). */
export function markRepeats(photos) {
  const byArea = [...photos].sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1]);
  for (let i = 0; i < byArea.length; i++) for (let j = 0; j < i; j++) {
    const a = byArea[i], b = byArea[j];
    if (b.duplicate_of || !a.dhash || !b.dhash) continue;
    if (hamming(a.dhash, b.dhash) <= 6 && Math.abs(a.size[0] / a.size[1] - b.size[0] / b.size[1]) < 0.08 && (!a.grey || !b.grey || greyDistance(a.grey, b.grey) <= 6)) { a.duplicate_of = b.id; break; }
  }
  for (const p of photos) delete p.grey;
  return photos;
}
export const sizeOf = (buf) => { try { const s = imageSize(buf); return Array.isArray(s) && s.every((v) => Number.isFinite(v) && v > 0) ? s : null; } catch { return null; } };
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; };

/** What the gym already has, by content hash: its manifest's rows. */
export function knownHashes(gymDir) {
  const m = join(gymDir, "brand-assets", "manifest.json"), out = new Map();
  try { for (const a of JSON.parse(readFileSync(m, "utf8")).assets || []) if (a.sha256 && !a.removed) out.set(a.sha256, a.path); } catch {}
  return out;
}

/** A 640 px JPEG thumbnail and a 64-bit difference hash for every photo, drawn in Chrome (webp included). */
export async function thumbsAndHashes(browser, dir, photos) {
  const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
  for (const p of photos) {
    const src = `data:${MIME[extname(p.file)]};base64,${readFileSync(join(dir, p.file)).toString("base64")}`;
    const { result, exceptionDetails } = await browser.cdp.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const i = new Image(); i.src = ${JSON.stringify(src)}; await i.decode();
      const s = Math.min(1, ${THUMB_PX} / Math.max(i.naturalWidth, i.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(i.naturalWidth * s)); c.height = Math.max(1, Math.round(i.naturalHeight * s));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(i, 0, 0, c.width, c.height);
      const h = document.createElement('canvas'); h.width = 9; h.height = 8; const hg = h.getContext('2d'); hg.drawImage(i, 0, 0, 9, 8);
      const d = hg.getImageData(0, 0, 9, 8).data, L = (x, y) => { const k = (y * 9 + x) * 4; return d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114; };
      let bits = ''; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += L(x, y) > L(x + 1, y) ? '1' : '0';
      let hex = ''; for (let k = 0; k < 64; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
      const t = document.createElement('canvas'); t.width = 32; t.height = 32; const tg = t.getContext('2d'); tg.drawImage(i, 0, 0, 32, 32);
      const td = tg.getImageData(0, 0, 32, 32).data; let grey = ''; for (let k = 0; k < 1024; k++) grey += Math.round(td[k * 4] * 0.299 + td[k * 4 + 1] * 0.587 + td[k * 4 + 2] * 0.114).toString(16).padStart(2, '0');
      return { thumb: c.toDataURL('image/jpeg', 0.85).split(',')[1], dhash: hex, grey };
    })()` }, browser.sessionId);
    if (exceptionDetails || !result?.value) continue;
    const thumb = `photos/thumbs/${p.id}.jpg`;
    writeFileSync(join(dir, thumb), Buffer.from(result.value.thumb, "base64"));
    Object.assign(p, { thumb, dhash: result.value.dhash, grey: result.value.grey, thumb_abs: join(dir, thumb) });
  }
}

/** A Singapore postal code placed by OneMap (the government's geocoder, no key): { lat, lng, onemap_address } or null. */
export async function onemapPlace(postal, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${ONEMAP_URL}/api/common/elastic/search?${new URLSearchParams({ searchVal: postal, returnGeom: "Y", getAddrDetails: "Y", pageNum: "1" })}`, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const hit = (await r.json())?.results?.find((x) => x.POSTAL === postal) || null;
  return hit ? { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE), onemap_address: oneLine(hit.ADDRESS) } : null;
}

/** A reading stopped part-way (the panel's Stop) leaves its work folder beside the reading: cleared by the next one. */
export function clearStaleWork(out) {
  try { for (const f of readdirSync(join(out, ".."))) if (f.startsWith(`${basename(out)}.reading-`)) rmSync(join(out, "..", f), { recursive: true, force: true }); } catch {}
}

/** The reading on disk, or null. */
export function readReading(gymDir) {
  const p = join(gymDir, ONBOARDING_DIR, "reading.json");
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "brand-dir": { type: "string" }, url: { type: "string" }, pages: { type: "string", default: String(MAX_PAGES) }, show: { type: "boolean", default: false } } });
  const gymDir = resolve(values["brand-dir"] || "");
  if (!values["brand-dir"] || !existsSync(gymDir)) { console.error("--brand-dir brands/{gym} is required"); process.exit(2); }
  if (values.show) { const r = readReading(gymDir); console.log(r ? JSON.stringify(r, null, 2) : "no reading yet"); process.exit(0); }
  const profile = existsSync(join(gymDir, "gym-profile.json")) ? JSON.parse(readFileSync(join(gymDir, "gym-profile.json"), "utf8")) : {};
  const url = values.url || profile.website;
  if (!url) { console.error("no --url and the profile has no website"); process.exit(2); }
  readWebsite({ url, gymDir, allowLocal: process.env.READ_WEBSITE_ALLOW_LOCAL === "1", maxPages: Math.max(1, Math.min(MAX_PAGES, parseInt(values.pages, 10) || MAX_PAGES)) })
    .then(() => process.exit(0))
    .catch((e) => { console.error(`Could not read the website: ${e.message}`); process.exit(1); });
}
