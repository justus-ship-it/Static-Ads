/**
 * Tests for the website reader (read-website.mjs): the pure rules, then a whole reading of a fake gym site
 * served from this machine, read by our real Chrome, with the model and the geocoder faked.
 *
 *   node --test skills/references/read-website.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { deflateSync, crc32 } from "node:zlib";
import { originalUrl, originalUrls, largestInSrcset, instagramHandle, facebookPage, identityFrom, pagesToRead, checkUrl, colourCandidates, firstFamily, nameFromUrl, readWebsite, readReading, MIN_PHOTO_PX } from "./read-website.mjs";

/** A PNG of w×h drawing the same picture at any size (a pattern in the frame's own proportions), so the
 *  same picture at two sizes has near-equal perceptual hashes and different pictures do not. */
function png(w, h, seed = 1) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h, t = Math.sin((u * (3 + seed) + v * (2 + seed * 1.7)) * Math.PI) * 0.5 + 0.5, q = Math.cos((u * seed * 2.3 - v * 3.1) * Math.PI) * 0.5 + 0.5;
      row[1 + x * 3] = Math.round(255 * t); row[2 + x * 3] = Math.round(255 * q); row[3 + x * 3] = Math.round(255 * (1 - t) * q);
    }
    rows.push(row);
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("W1 the rules: originals behind each image service, srcsets with commas, social links, pages to read, addresses refused", () => {
  assert.equal(originalUrl("https://static.wixstatic.com/media/ab12_cd~mv2.jpg/v1/fill/w_147,h_98,al_c,q_80/ab12_cd~mv2.jpg"), "https://static.wixstatic.com/media/ab12_cd~mv2.jpg");
  assert.equal(originalUrl("https://images.squarespace-cdn.com/content/v1/abc/room.jpg?format=500w"), "https://images.squarespace-cdn.com/content/v1/abc/room.jpg?format=2500w");
  assert.equal(originalUrl("https://gym.sg/wp-content/uploads/2023/04/room-300x200.jpg"), "https://gym.sg/wp-content/uploads/2023/04/room.jpg");
  assert.equal(originalUrl("https://gym.sg/wp-content/uploads/2023/04/room-jpg.webp"), "https://gym.sg/wp-content/uploads/2023/04/room.jpg", "a converter plugin's webp → the upload it was made from");
  assert.deepEqual(originalUrls("https://gym.sg/wp-content/uploads/2023/04/room-200x300.webp"), ["https://gym.sg/wp-content/uploads/2023/04/room.webp", "https://gym.sg/wp-content/uploads/2023/04/room.jpg", "https://gym.sg/wp-content/uploads/2023/04/room.jpeg", "https://gym.sg/wp-content/uploads/2023/04/room.png"]);
  assert.equal(originalUrl("https://cdn.shopify.com/s/files/1/room_600x.jpg?v=1&width=600"), "https://cdn.shopify.com/s/files/1/room.jpg?v=1");
  assert.equal(originalUrl("https://cdn.prod.website-files.com/abc/room-p-500.jpeg"), "https://cdn.prod.website-files.com/abc/room.jpeg");
  assert.equal(originalUrl("https://gym.sg/_next/image?url=%2Fimg%2Froom.jpg&w=640&q=75"), "https://gym.sg/img/room.jpg");
  assert.equal(originalUrl("https://res.cloudinary.com/gym/image/upload/w_400,c_fill/q_auto/v1690/room.jpg"), "https://res.cloudinary.com/gym/image/upload/v1690/room.jpg");
  assert.equal(originalUrl("https://images.ctfassets.net/x/y/room.jpg?w=400&fm=webp"), "https://images.ctfassets.net/x/y/room.jpg");
  assert.equal(originalUrl("https://gym.sg/img/room.jpg"), null, "no known image service: no guess");
  assert.equal(largestInSrcset("https://static.wixstatic.com/media/a.jpg/v1/fill/w_300,h_200/a.jpg 1x, https://static.wixstatic.com/media/a.jpg/v1/fill/w_600,h_400/a.jpg 2x", "https://gym.sg/"), "https://static.wixstatic.com/media/a.jpg/v1/fill/w_600,h_400/a.jpg", "commas inside Wix's addresses do not split the list");
  assert.equal(largestInSrcset("/a-300.jpg 300w, /a-1200.jpg 1200w, /a-768.jpg 768w", "https://gym.sg/x/"), "https://gym.sg/a-1200.jpg");
  assert.equal(instagramHandle("https://www.instagram.com/F45_LowerPeirce/"), "f45_lowerpeirce");
  assert.equal(instagramHandle("https://www.instagram.com/p/Cxyz/"), null, "a post is not an account");
  assert.equal(instagramHandle("https://instagram.com/reel/abc"), null);
  assert.equal(facebookPage("https://www.facebook.com/sculptsocietysg/photos/?ref=x"), "https://www.facebook.com/sculptsocietysg");
  assert.equal(facebookPage("https://www.facebook.com/sharer/sharer.php?u=x"), null, "a share button is not a Page");
  assert.equal(nameFromUrl("https://static.wixstatic.com/media/ab12~mv2.jpg/v1/fill/w_147,h_98/Studio%20Floor.jpg"), "studio-floor");

  const id = identityFrom([
    { url: "https://gym.sg/", site_name: "Test Gym", jsonld: [JSON.stringify({ "@graph": [{ "@type": "WebSite" }, { "@type": ["LocalBusiness", "ExerciseGym"], name: "Test Gym Bishan", telephone: "+65 6123 4567", address: { "@type": "PostalAddress", streetAddress: "10 Test Road, #02-01", addressLocality: "Singapore", postalCode: "570123" }, geo: { latitude: 1.35, longitude: 103.84 }, sameAs: ["https://www.instagram.com/testgym.sg/"] }] })], text: "Visit us\n22 Other Street\nSingapore 570999\nCall us: 9123 4567\nOrder 12345678 shipped", links: [{ href: "https://www.instagram.com/testgym.sg/" }, { href: "https://www.instagram.com/p/abc/" }, { href: "https://www.instagram.com/brandglobal/" }, { href: "tel:+6561234567" }, { href: "https://www.facebook.com/testgymsg" }] },
  ]);
  assert.deepEqual(id.addresses.map((a) => [a.postal_code, a.from, a.lat ?? null]), [["570123", "schema.org", 1.35], ["570999", "text", null]]);
  assert.equal(id.addresses[0].address, "10 Test Road, #02-01, Singapore, 570123");
  assert.equal(id.addresses[1].address, "22 Other Street, Singapore 570999", "a short postal-code line takes the line above it");
  assert.deepEqual(id.phones, ["+65 6123 4567", "+65 9123 4567"], "one number counted once; a number with no phone words around it is not a phone");
  assert.deepEqual(id.instagram.map((x) => x.value), ["testgym.sg", "brandglobal"], "the account the site names most comes first; a post link is no account");
  assert.deepEqual(id.names, ["Test Gym Bishan", "Test Gym"]);

  const links = [{ href: "https://f45training.com/sg/studio/lp/find-this-studio", text: "Find this studio" }, { href: "https://f45training.com/sg/studio/lp/find-this-studio/", text: "Find" }, { href: "https://f45training.com/about/", text: "About F45" }, { href: "https://f45training.com/sg/studio/lp/coaches/", text: "Our coaches" }, { href: "https://other.com/about", text: "About" }, { href: "https://f45training.com/sg/studio/lp/brochure.pdf", text: "About (pdf)" }];
  assert.deepEqual(pagesToRead("https://f45training.com/sg/studio/lp/", links).sort(), ["https://f45training.com/sg/studio/lp/coaches/", "https://f45training.com/sg/studio/lp/find-this-studio/"], "a studio page on a franchise site: its own pages only, each once, no files, no other sites");
  for (const bad of ["file:///etc/passwd", "http://localhost:4310/", "http://127.0.0.1/", "http://192.168.1.10/", "http://169.254.169.254/latest", "ftp://gym.sg/", "not a url"]) assert.throws(() => checkUrl(bad), undefined, bad);
  assert.equal(checkUrl("https://gym.sg/#top").href, "https://gym.sg/");
  assert.equal(firstFamily('"Gotham Condensed", Helvetica, Arial, sans-serif'), "Gotham Condensed");
  assert.equal(firstFamily("-apple-system, BlinkMacSystemFont, sans-serif"), null, "system fonts are not the brand's");
  const cands = colourCandidates({ "#FFFFFF": { hex: "#FFFFFF", bg: 900, text: 10, button: 0 }, "#FEFEFE": { hex: "#FEFEFE", bg: 100, text: 0, button: 0 }, "#E63946": { hex: "#E63946", bg: 20, text: 5, button: 4 }, "#111111": { hex: "#111111", bg: 50, text: 80, button: 0 } });
  assert.deepEqual(cands.map((c) => c.hex), ["#FFFFFF", "#111111", "#E63946"], "near-white merged into white; ranked by where each appears");
});

test("W2 a whole reading of a fake gym site: pages, identity, colours, fonts, the logo apart from the photos, originals fetched, icons dropped, low resolution marked, repeats told apart, what the gym has already known, the model asked only with measured colours", async () => {
  const room = png(1600, 1067, 1), roomSmall = png(800, 533, 1), coach = png(700, 1000, 2), gallery = png(1400, 1400, 3), logo = png(300, 100, 4), icon = png(64, 64, 5), have = png(1200, 900, 6);
  const files = { "/wp-content/uploads/2026/01/room.jpg": room, "/wp-content/uploads/2026/01/room-300x200.jpg": png(300, 200, 1), "/img/room-small.png": roomSmall, "/img/coach.png": coach, "/img/gallery-full.png": gallery, "/img/logo.png": logo, "/img/icon.png": icon, "/img/have.png": have };
  const page = (body, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>Test Gym</title><meta property="og:site_name" content="Test Gym">${extra}
    <style>body{margin:0;font-family:Lato,sans-serif;background:#fff;color:#222} h1{font-family:"Oswald",sans-serif} .hero{background:#1A2B3C;color:#fff;height:600px} .btn{background:#E63946;color:#fff;padding:10px;display:inline-block}</style></head><body>${body}</body></html>`;
  const home = page(`<header><a href="/"><img class="site-logo" src="/img/logo.png" alt="Test Gym logo" width="150" height="50"></a><nav><a href="/about/">About us</a> <a href="/pricing/">Pricing</a> <a href="https://www.instagram.com/testgym.sg/">Instagram</a> <a href="https://www.instagram.com/p/abc/">a post</a> <a href="https://www.facebook.com/testgymsg">Facebook</a></nav></header>
    <section class="hero"><h1>Train with us</h1><a class="btn" href="#">Join</a><a class="btn" href="#">Book</a></section>
    <img src="/wp-content/uploads/2026/01/room-300x200.jpg" width="300" height="200" alt="the gym floor">
    <img src="/img/coach.png" width="350" height="500"> <img src="/img/icon.png" width="32" height="32"> <img src="/img/have.png" width="400" height="300">
    <a href="/img/gallery-full.png">see the gallery</a><p>Call us at 6123 4567</p>`,
    `<script type="application/ld+json">${JSON.stringify({ "@type": "ExerciseGym", name: "Test Gym", address: { streetAddress: "10 Test Road", postalCode: "570123" }, telephone: "+65 6123 4567" })}</script>`);
  const about = page(`<h1>About</h1><img src="/img/room-small.png" width="800" height="533"><img src="/wp-content/uploads/2026/01/room.jpg" width="400" height="267">`);
  const server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (files[u]) { res.writeHead(200, { "content-type": "image/png" }); return res.end(files[u]); }
    if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(home); }
    if (u === "/about/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(about); }
    if (u === "/pricing/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page("<h1>Pricing</h1>")); }
    res.writeHead(404); res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${server.address().port}/`;
  const gymDir = mkdtempSync(join(tmpdir(), "rw-gym-"));
  mkdirSync(join(gymDir, "brand-assets"), { recursive: true });
  writeFileSync(join(gymDir, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym" }));
  const { createHash } = await import("node:crypto");
  writeFileSync(join(gymDir, "brand-assets", "manifest.json"), JSON.stringify({ assets: [{ path: "facility/have.png", sha256: createHash("sha256").update(have).digest("hex") }] }));
  const asked = [];
  const vision = async (images, question) => {
    asked.push({ images: [images].flat(), question });
    if (question.startsWith("This is the top of the home page")) return { primary: "#1A2B3C", secondary: "#123456", accent: "#E63946", why: "navy hero, red buttons", name: "Test Gym", headline_look: "condensed", logo_index: 0 };
    return { items: [images].flat().map((_, index) => ({ index, kind: "premises", people: 0, lettering: "none", stock: false, what: "a gym floor" })) };
  };
  let geocoded = 0;
  try {
    const r = await readWebsite({ url: site, gymDir, vision, geocode: async (pc) => { geocoded++; return { lat: 1.36, lng: 103.85, onemap_address: `10 TEST ROAD SINGAPORE ${pc}` }; }, allowLocal: true, log: () => {} });
    assert.deepEqual(r.pages.map((p) => p.url), [site, `${site}about/`, `${site}pricing/`]);
    assert.deepEqual(r.identity.addresses.map((a) => [a.postal_code, a.lat]), [["570123", 1.36]]);
    assert.equal(geocoded, 1);
    assert.deepEqual(r.identity.phones, ["+65 6123 4567"]);
    assert.deepEqual(r.identity.instagram.map((x) => x.value), ["testgym.sg"]);
    assert.deepEqual(r.identity.facebook.map((x) => x.value), ["https://www.facebook.com/testgymsg"]);
    assert.deepEqual(r.colours.proposal, { primary: "#1A2B3C", secondary: null, accent: "#E63946", why: "navy hero, red buttons" }, "a colour the page never showed is dropped, whatever the model says");
    assert.deepEqual([r.fonts.headline, r.fonts.body], ["Oswald", "Lato"]);
    assert.ok(r.logos.some((l) => /logo\.png$/.test(l.url || "")), "the header image is a logo candidate");
    assert.ok(!r.photos.some((p) => /logo\.png$/.test(p.url)), "and never a photo");
    const by = (re) => r.photos.find((p) => re.test(p.url));
    const big = by(/room\.jpg$/);
    assert.ok(big, "the room is fetched as the site's original upload");
    assert.deepEqual([big.size, big.original, big.low_res], [[1600, 1067], true, false]);
    assert.deepEqual(big.also_on, [`${site}about/`], "the same bytes on another page are one photo");
    assert.equal(by(/room-small/).duplicate_of, big.id, "the same picture at a smaller size is a repeat of the larger");
    assert.deepEqual([by(/coach/).size, by(/coach/).low_res], [[700, 1000], true], `under ${MIN_PHOTO_PX} px on the long side is marked`);
    assert.ok(by(/gallery-full/), "a link straight to an image is a candidate");
    assert.ok(!by(/icon/), "an icon is no photo");
    assert.equal(by(/have\.png/).already_have, "facility/have.png");
    // The model: the colour question lists only measured values and comes with the screenshot first.
    const colourQ = asked.find((a) => a.question.startsWith("This is the top of the home page"));
    assert.match(colourQ.images[0], /home\.png$/);
    assert.match(colourQ.question, /#1A2B3C/); assert.match(colourQ.question, /#E63946/);
    const sortCalls = asked.filter((a) => !a.question.startsWith("This is the top"));
    assert.equal(sortCalls.reduce((s, a) => s + a.images.length, 0), r.photos.filter((p) => !p.duplicate_of).length, "every distinct photo is sorted once, as its thumbnail");
    assert.ok(sortCalls.every((a) => a.images.every((f) => /\/photos\/thumbs\/p\d+\.jpg$/.test(f))));
    assert.equal(r.calls, sortCalls.length + 1);
    // On disk: the reading, the files it names, and nothing left from the work in progress.
    assert.deepEqual(readReading(gymDir).read_at, r.read_at);
    for (const p of r.photos) { assert.ok(existsSync(join(gymDir, "onboarding/website", p.file)), p.file); if (!p.duplicate_of) assert.ok(existsSync(join(gymDir, "onboarding/website", p.thumb))); }
    assert.ok(existsSync(join(gymDir, "onboarding/website/home.png")));
    assert.deepEqual(readdirSync(join(gymDir, "onboarding")), ["website"]);
    assert.deepEqual(readdirSync(join(gymDir, "brand-assets")), ["manifest.json"], "a reading files nothing: that is the owner's accept step");
    const again = await readWebsite({ url: site, gymDir, vision, geocode: null, allowLocal: true, log: () => {} });
    assert.notEqual(again.read_at, r.read_at); assert.deepEqual(readdirSync(join(gymDir, "onboarding")), ["website"], "a new reading replaces the old one whole");
    await assert.rejects(readWebsite({ url: "http://127.0.0.1:1/", gymDir, vision, log: () => {} }), /private network|this computer/, "without the tests' allowance, a local address is refused");
  } finally { server.close(); }
});
