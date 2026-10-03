/**
 * Tests for the Instagram reader (read-instagram.mjs): the handle, the posts' photos, Business Discovery's
 * paging and refusals, then a whole reading with Meta faked, the pictures served from this machine and our
 * real Chrome making the thumbnails.
 *
 *   node --test skills/references/read-instagram.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { deflateSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { cleanHandle, photosOf, discoverPosts, discoveryAccount, readInstagram, readInstagramReading } from "./read-instagram.mjs";
import { markRepeats } from "./read-website.mjs";

/** A PNG: a pattern in the frame's own proportions (the same picture at any size), and optionally a block of
 *  its own over the middle — a template slide: the same background, a different person. */
function png(w, h, seed = 1, block = null) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h, inBlock = block != null && u > 0.15 && u < 0.85 && v > 0.3 && v < 0.9;
      const t = inBlock ? Math.sin((u * (5 + block * 3.1) - v * (4 + block)) * Math.PI) * 0.5 + 0.5 : Math.sin((u * (3 + seed) + v * (2 + seed * 1.7)) * Math.PI) * 0.5 + 0.5;
      const q = inBlock ? Math.cos((u * block * 1.9 + v * 2.7) * Math.PI) * 0.5 + 0.5 : Math.cos((u * seed * 2.3 - v * 3.1) * Math.PI) * 0.5 + 0.5;
      row[1 + x * 3] = Math.round(255 * t); row[2 + x * 3] = Math.round(255 * q); row[3 + x * 3] = Math.round(255 * (1 - t) * q);
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A fake Graph client: me/accounts, and Business Discovery paging over `media` (25 a page, or the limit asked). */
function fakeClient({ media = [], pages = [{ id: "1", name: "Strategym", instagram_business_account: { id: "999", username: "strategym" } }], refuse = null } = {}) {
  const asked = [];
  return {
    asked,
    list: async (path) => { asked.push(path); return pages; },
    get: async (id, params) => {
      asked.push(`${id} ${params.fields}`);
      if (refuse) throw new Error(refuse);
      const f = params.fields;
      const limit = Number(f.match(/\.limit\((\d+)\)/)?.[1] || 25), after = Number(f.match(/\.after\((\d+)\)/)?.[1] || 0);
      const data = media.slice(after, after + limit);
      return { business_discovery: { username: f.match(/username\(([^)]+)\)/)[1], name: "Test Gym SG", followers_count: 1234, media_count: media.length, media: { data, ...(after + limit < media.length ? { paging: { cursors: { after: String(after + limit) } } } : {}) } } };
    },
  };
}

test("I1 the handle, the photos in the posts (carousels opened, videos skipped), Business Discovery's paging, our asking account, and the refusals in words", async () => {
  assert.equal(cleanHandle("@Sculpt.Society_SG"), "sculpt.society_sg");
  assert.equal(cleanHandle("https://www.instagram.com/f45_lowerpeirce/"), "f45_lowerpeirce");
  assert.equal(cleanHandle("instagram.com/testgym"), "testgym");
  for (const bad of ["", "two words", "a".repeat(31), "semi;colon", "https://www.instagram.com/p/abc/"]) assert.equal(cleanHandle(bad), null, bad);
  const { photos, videos } = photosOf([
    { id: "1", media_type: "IMAGE", media_url: "u1", permalink: "https://www.instagram.com/p/A/", timestamp: "2026-09-01T00:00:00+0000" },
    { id: "2", media_type: "VIDEO", media_url: "v2", thumbnail_url: "t2" },
    { id: "3", media_type: "CAROUSEL_ALBUM", permalink: "https://www.instagram.com/p/C/", children: { data: [{ media_type: "IMAGE", media_url: "c1" }, { media_type: "VIDEO", media_url: "cv" }, { media_type: "IMAGE", media_url: "c3" }] } },
  ]);
  assert.deepEqual(photos.map((p) => [p.url, p.in_post, p.of]), [["u1", 1, 1], ["c1", 1, 3], ["c3", 3, 3]], "a video's cover frame is never taken");
  assert.equal(videos, 2);
  const media = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, media_type: "IMAGE", media_url: `u${i}` }));
  const c = fakeClient({ media });
  const asker = await discoveryAccount(c);
  assert.deepEqual(asker, { id: "999", username: "strategym", page: "Strategym" });
  const r = await discoverPosts(c, asker, "testgym", { posts: 55 });
  assert.equal(r.posts.length, 55); assert.equal(r.calls, 3, "25 + 25 + 5");
  assert.match(c.asked.at(-1), /media\.after\(50\)\.limit\(5\)/);
  assert.deepEqual(r.account, { username: "testgym", name: "Test Gym SG", followers: 1234, posts: 60 });
  assert.equal((await discoverPosts(fakeClient({ media: media.slice(0, 7) }), asker, "testgym", { posts: 100 })).posts.length, 7, "an account with fewer posts ends at its last");
  // Repeats: the same small fingerprint is not enough; the pixels on a 32×32 grid must match too.
  const grey = (v) => v.toString(16).padStart(2, "0").repeat(1024), half = "80".repeat(512) + "20".repeat(512);
  const ph = (id, g, size = [1080, 1350]) => ({ id, size, dhash: "a5a5a5a5a5a5a5a5", grey: g });
  const [t1, t2, again] = markRepeats([ph("t1", grey(0x80)), ph("t2", half), ph("again", grey(0x82), [900, 1125])]);
  assert.equal(t2.duplicate_of, undefined, "one template, a different person: the grids differ, so two photos");
  assert.equal(again.duplicate_of, "t1", "the same picture smaller: the grids match");
  assert.ok(!("grey" in t1), "the grid is not kept in the reading");
  await assert.rejects(discoveryAccount(fakeClient({ pages: [{ id: "2", name: "A client Page" }] })), /no Page with an Instagram account connected/);
  await assert.rejects(discoverPosts(fakeClient({ refuse: "(#110) Invalid user id" }), asker, "someone"), /no business or creator account @someone/);
});

test("I2 a whole reading: the latest posts' photos fetched and kept with their post, newest first, a video skipped, the same picture twice a repeat, template slides with different people not, what the gym has already known, the sort on thumbnails, nothing filed", async () => {
  const pics = {
    "/a.png": png(1080, 1350, 1), "/a-again.png": png(900, 1125, 1), // the same picture posted again, smaller
    "/slide1.png": png(1080, 1350, 2, 1), "/slide2.png": png(1080, 1350, 2, 2), // one template, two people
    "/small.png": png(640, 800, 3), "/have.png": png(1080, 1080, 4),
  };
  const server = http.createServer((req, res) => { const b = pics[req.url]; if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "image/png" }); res.end(b); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const u = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const media = [
    { id: "p1", media_type: "IMAGE", media_url: u("/a.png"), permalink: "https://www.instagram.com/p/AAA/", timestamp: "2026-09-20T10:00:00+0000" },
    { id: "p2", media_type: "VIDEO", media_url: u("/video.mp4"), thumbnail_url: u("/a.png"), permalink: "https://www.instagram.com/reel/VVV/", timestamp: "2026-09-19T10:00:00+0000" },
    { id: "p3", media_type: "CAROUSEL_ALBUM", permalink: "https://www.instagram.com/p/CCC/", timestamp: "2026-09-18T10:00:00+0000", children: { data: [{ media_type: "IMAGE", media_url: u("/slide1.png") }, { media_type: "IMAGE", media_url: u("/slide2.png") }] } },
    { id: "p4", media_type: "IMAGE", media_url: u("/a-again.png"), permalink: "https://www.instagram.com/p/DDD/", timestamp: "2026-09-10T10:00:00+0000" },
    { id: "p5", media_type: "IMAGE", media_url: u("/small.png"), permalink: "https://www.instagram.com/p/EEE/", timestamp: "2026-09-05T10:00:00+0000" },
    { id: "p6", media_type: "IMAGE", media_url: u("/have.png"), permalink: "https://www.instagram.com/p/FFF/", timestamp: "2026-09-01T10:00:00+0000" },
    { id: "p7", media_type: "IMAGE", media_url: u("/gone.png"), permalink: "https://www.instagram.com/p/GGG/", timestamp: "2026-08-01T10:00:00+0000" },
  ];
  const gymDir = mkdtempSync(join(tmpdir(), "ig-gym-"));
  mkdirSync(join(gymDir, "brand-assets"), { recursive: true });
  writeFileSync(join(gymDir, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym" }));
  writeFileSync(join(gymDir, "brand-assets", "manifest.json"), JSON.stringify({ assets: [{ path: "facility/have.png", sha256: createHash("sha256").update(pics["/have.png"]).digest("hex") }] }));
  const sorted = [];
  const vision = async (images) => { sorted.push(...[images].flat()); return { items: [images].flat().map((_, index) => ({ index, kind: "members", people: 1, lettering: "none", stock: false, before_after: index === 0, what: "a member training" })) }; };
  try {
    const r = await readInstagram({ handle: "@TestGym", gymDir, client: fakeClient({ media }), vision, allowLocal: true, log: () => {} });
    assert.deepEqual([r.handle, r.asked_via, r.posts_read, r.videos_skipped, r.account.followers], ["testgym", "strategym", 7, 1, 1234]);
    const by = (post) => r.photos.filter((p) => p.post === `https://www.instagram.com/p/${post}/`);
    assert.deepEqual(r.photos.map((p) => p.post.split("/")[4]), ["AAA", "CCC", "CCC", "DDD", "EEE", "FFF"], "newest first; the video and the photo that would not load are not there");
    assert.equal(by("DDD")[0].duplicate_of, by("AAA")[0].id, "the same picture posted again is a repeat of the larger");
    assert.ok(!by("CCC").some((p) => p.duplicate_of), "two slides of one template with different people are two photos");
    assert.deepEqual(by("CCC").map((p) => [p.in_post, p.of]), [[1, 2], [2, 2]]);
    assert.deepEqual([by("EEE")[0].low_res, by("AAA")[0].low_res], [true, false]);
    assert.equal(by("FFF")[0].already_have, "facility/have.png");
    assert.equal(sorted.length, 5, "every distinct photo sorted once");
    assert.ok(sorted.every((f) => /\/photos\/thumbs\/i\d+\.jpg$/.test(f)), "as its thumbnail");
    assert.equal(r.photos.find((p) => p.before_after)?.kind, "members", "the sort's before-and-after flag is kept");
    assert.match(r.problems.join(" "), /1 photo could not be fetched/);
    assert.equal(readInstagramReading(gymDir).read_at, r.read_at);
    for (const p of r.photos) assert.ok(existsSync(join(gymDir, "onboarding/instagram", p.file)));
    assert.deepEqual(readdirSync(join(gymDir, "brand-assets")), ["manifest.json"], "a reading files nothing");
    await assert.rejects(readInstagram({ handle: "two words", gymDir, client: fakeClient({ media }), vision, log: () => {} }), /not an Instagram handle/);
  } finally { server.close(); }
});
