/**
 * ad-images-zip.mjs — a batch's kept ads as one zip, for building the ads by hand in Ads Manager when the app
 * cannot publish them (a gym whose Facebook Page is not yet shared with Strategym).
 *
 *   {Location}/{ad}_1x1.png     the feed image
 *   {Location}/{ad}_9x16.png    its Stories and Reels version, when it has one
 *   ads.csv                     ad set · ad · the 1:1 file · the 9:16 file
 *   README.txt                  how the files pair in Ads Manager
 *
 * One folder per location callout, which is one ad set (the app's own rule). The version suffix (_v1) is
 * never in a name, so each ad's two files pair by name (CLAUDE.md: the Ad-uploads naming rule). The kept ads
 * are keptAds' (the review's excluded ads and excluded photos out). Stored, not compressed: the images are
 * already compressed, and the zip format is written here with Node's own CRC32 — no dependency.
 */

import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { crc32 } from "zlib";
import { keptAds } from "./meta-publish.mjs";

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
/** A name safe in a zip on every system: no path separators, no control characters. */
const safe = (s) => String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim() || "untitled";

/** A zip of `entries` [{ name, data: Buffer, date? }], stored (method 0), names in UTF-8. */
export function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), when = e.date || new Date();
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime(when), 10); lh.writeUInt16LE(dosDate(when), 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime(when), 12); ch.writeUInt16LE(dosDate(when), 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** What goes in a batch's zip: every kept ad's 1:1 and 9:16, by ad set, with the list and the instructions. */
export function keptImagesZip(batchDir, { batchId = "batch" } = {}) {
  const kept = keptAds(batchDir), entries = [], rows = [["ad set", "ad", "1x1 (feeds)", "9x16 (Stories and Reels)"]], missing = [];
  for (const a of kept) {
    const set = safe(titleCase(a.location || "All")), base = safe(a.folder);
    const one = join(batchDir, a.file);
    if (!existsSync(one)) { missing.push(a.file); continue; }
    const f1 = `${set}/${base}_1x1${extname(a.file).toLowerCase() || ".png"}`;
    entries.push({ name: f1, data: readFileSync(one) });
    let f9 = "";
    if (a.story && existsSync(join(batchDir, a.story))) { f9 = `${set}/${base}_9x16${extname(a.story).toLowerCase() || ".png"}`; entries.push({ name: f9, data: readFileSync(join(batchDir, a.story)) }); }
    rows.push([set, base, f1, f9]);
  }
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
  const sets = [...new Set(rows.slice(1).map((r) => r[0]))];
  const readme = [
    `${batchId}: ${rows.length - 1} kept ad(s) in ${sets.length} ad set(s): ${sets.join(", ")}.`,
    "",
    "One folder per ad set (one ad set per location). In each, every ad has two images that pair by name:",
    "  ..._1x1   the feed image (Facebook and Instagram feeds, and everything else)",
    "  ..._9x16  the Stories and Reels version (where there is one)",
    "",
    "In Ads Manager, for each ad: choose Single image, add the 1:1, then Customise by placement (or",
    "\"Edit\" on the Stories and Reels placements) and give those placements the 9:16. Keep the ad paused",
    "until you have checked it. ads.csv lists every ad with its ad set and files.",
    ...(missing.length ? ["", `Not included, the file was missing: ${missing.join(", ")}`] : []),
  ].join("\n") + "\n";
  entries.push({ name: "ads.csv", data: Buffer.from(csv, "utf8") }, { name: "README.txt", data: Buffer.from(readme, "utf8") });
  return { buffer: zipStore(entries), ads: rows.length - 1, images: entries.length - 2, sets, missing };
}
