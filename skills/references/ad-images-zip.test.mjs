/**
 * Tests for the kept-ads zip (ad-images-zip.mjs): a valid zip, what goes in it, how the files pair.
 *
 *   node --test skills/references/ad-images-zip.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { zipStore, keptImagesZip } from "./ad-images-zip.mjs";

const hasUnzip = (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();
/** The names in a zip, read from its central directory. */
const namesIn = (buf) => {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), n = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16); const out = [];
  for (let i = 0; i < n; i++) { const len = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), com = buf.readUInt16LE(at + 32); out.push(buf.slice(at + 46, at + 46 + len).toString("utf8")); at += 46 + len + extra + com; }
  return out;
};

test("Z1 the zip is a valid, stored zip: names in UTF-8, every entry's bytes and CRC intact (checked by the system's unzip when it has one)", () => {
  const d = mkdtempSync(join(tmpdir(), "zip-"));
  const a = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), b = Buffer.from("héllo, Ang Mo Kio\n", "utf8");
  const z = zipStore([{ name: "Ang Mo Kio/101-c01_1x1.png", data: a }, { name: "notes/ümlaut.txt", data: b }]);
  assert.deepEqual(namesIn(z), ["Ang Mo Kio/101-c01_1x1.png", "notes/ümlaut.txt"]);
  const f = join(d, "t.zip"); writeFileSync(f, z);
  if (hasUnzip) {
    execFileSync("unzip", ["-t", "-q", f]); // throws on a bad CRC or structure
    execFileSync("unzip", ["-q", f, "-d", join(d, "x")]);
    assert.deepEqual(readFileSync(join(d, "x", "Ang Mo Kio", "101-c01_1x1.png")), a);
    // (The command-line unzip on macOS ignores the UTF-8 flag, so the non-ASCII name is checked in the directory above, not on disk; Finder honours it.)
  }
  assert.equal(zipStore([]).length, 22, "an empty zip is just its end record");
});

test("Z2 a batch's zip: every kept ad's 1:1 and its 9:16 when it has one, one folder per ad set, names that pair (no _v1), excluded ads and excluded photos' ads left out, the list and the instructions", () => {
  const d = mkdtempSync(join(tmpdir(), "batch-"));
  const ad = (folder, location, photos) => ({ folder, file: `${folder}/1x1/${folder}_1x1_v1.png`, location, photos, words: { location } });
  const ads = [ad("101-c01-bishan-t3", "BISHAN", ["g01"]), ad("102-c01-ang-mo-kio-t3", "ANG MO KIO", ["g01"]), ad("103-c02-bishan-t1", "BISHAN", ["g02"]), ad("104-c03-bishan-t2", "BISHAN", ["g03"])];
  for (const a of ads) { mkdirSync(join(d, a.folder, "1x1"), { recursive: true }); writeFileSync(join(d, a.file), Buffer.from(`png ${a.folder}`)); }
  mkdirSync(join(d, "101-c01-bishan-t3", "9x16"), { recursive: true }); writeFileSync(join(d, "101-c01-bishan-t3/9x16/story_9x16_v1.png"), Buffer.from("story 101"));
  writeFileSync(join(d, "batch.json"), JSON.stringify({ ads }));
  writeFileSync(join(d, "review.json"), JSON.stringify({ ads: { "103-c02-bishan-t1": "exclude" }, photos: { g03: "exclude" } }));
  writeFileSync(join(d, "stories.json"), JSON.stringify({ ads: [{ folder: "101-c01-bishan-t3", file: "101-c01-bishan-t3/9x16/story_9x16_v1.png" }, { folder: "102-c01-ang-mo-kio-t3", file: "102-c01-ang-mo-kio-t3/9x16/gone.png" }] }));
  const z = keptImagesZip(d, { batchId: "b1" });
  assert.deepEqual([z.ads, z.images, z.sets, z.missing], [2, 3, ["Bishan", "Ang Mo Kio"], []], "103 excluded by the review, 104 by its excluded photo; 102's Stories file is gone, so only its 1:1");
  assert.deepEqual(namesIn(z.buffer), ["Bishan/101-c01-bishan-t3_1x1.png", "Bishan/101-c01-bishan-t3_9x16.png", "Ang Mo Kio/102-c01-ang-mo-kio-t3_1x1.png", "ads.csv", "README.txt"]);
  const f = join(d, "b.zip"); writeFileSync(f, z.buffer);
  if (hasUnzip) {
    execFileSync("unzip", ["-q", f, "-d", join(d, "x")]);
    assert.equal(readFileSync(join(d, "x", "Bishan", "101-c01-bishan-t3_9x16.png"), "utf8"), "story 101");
    assert.equal(readFileSync(join(d, "x", "ads.csv"), "utf8"), "ad set,ad,1x1 (feeds),9x16 (Stories and Reels)\nBishan,101-c01-bishan-t3,Bishan/101-c01-bishan-t3_1x1.png,Bishan/101-c01-bishan-t3_9x16.png\nAng Mo Kio,102-c01-ang-mo-kio-t3,Ang Mo Kio/102-c01-ang-mo-kio-t3_1x1.png,\n");
    assert.match(readFileSync(join(d, "x", "README.txt"), "utf8"), /^b1: 2 kept ad\(s\) in 2 ad set\(s\): Bishan, Ang Mo Kio\.[^]*Customise by placement/);
  }
  assert.ok(!existsSync(join(d, "images.zip")), "nothing is written into the batch folder");
});
