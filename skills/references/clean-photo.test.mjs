/**
 * Offline tests for the real-photo clean-up (clean-photo.mjs).
 *
 *   node --test skills/references/clean-photo.test.mjs
 *
 * No network and no Gemini spend: the survey, the after-check, the comparison and the image model are
 * faked. The pixel tools run for real, in the renderer's Chrome, on synthetic pictures. The live gate
 * is the Step 5 run itself (2 real facility photos), reported separately.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { launchBrowser } from "./render-composites.mjs";
import { imageSize } from "./check-visual.mjs";
import {
  editFrame, toCrop, where, plainWords, buildCleanPrompt, leftoverItems, judgeClean, cleanPhotos,
  cropImage, comparePixels, WHOLE_BOX_FIT, EDIT_ASPECTS, EDIT_SIZES, placeOf, mergeItems, markItem, KEEP_CLAUSE, ADD_NOTHING_CLAUSE, REAL_PHOTO_CLAUSE, MAX_UNINTENDED,
} from "./clean-photo.mjs";

const svg = (w, h, body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
// A busy synthetic "room": a grid of tiles in varied colours, so any shift, zoom or repaint shows.
const COLOURS = ["#8e1b1b", "#c62828", "#1c1c1c", "#efe8da", "#4a4a4a", "#2b3a55", "#b38b59", "#6d0f0f", "#dcdcdc", "#101010", "#9c2a2a", "#3d3d3d"];
const tiles = (w, h, { scale = 1, dx = 0, lighten = 0, patch = null, jitter = 0 } = {}) => {
  const cols = 16, rows = 8, tw = w / cols, th = h / rows;
  let body = `<g transform="translate(${w / 2 + dx} ${h / 2}) scale(${scale}) translate(${-w / 2} ${-h / 2})">`;
  // jitter: every sixth tile (even rows, every third column) drawn that many px off its place — a loose redraw.
  const moved = (r, c) => r % 2 === 0 && c % 3 === 0, jx = (r, c) => (moved(r, c) ? ((r + c) % 2 ? jitter : -jitter) : 0), jy = (r, c) => (moved(r, c) ? ((r * c) % 2 ? jitter : -jitter) : 0);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) body += `<rect x="${c * tw + jx(r, c)}" y="${r * th + jy(r, c)}" width="${tw + 0.5}" height="${th + 0.5}" fill="${COLOURS[(r * 5 + c * 7) % COLOURS.length]}"/>`;
  body += "</g>";
  if (lighten) body += `<rect width="100%" height="100%" fill="#fff" opacity="${lighten}"/>`;
  if (patch) body += `<rect x="${patch[0] * w}" y="${patch[1] * h}" width="${patch[2] * w}" height="${patch[3] * h}" fill="#00ff66"/>`;
  return svg(w, h, body);
};
const W = 1200, H = 600;
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
/** A PNG header only: enough for imageSize, the one thing the flow reads from a generated file. */
const pngHeader = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// ── framing (pure) ────────────────────────────────────────────────────────

test("P1 the edit frame is the supported shape that loses least, cropped exactly", () => {
  const cases = [[[1874, 890], "21:9"], [[1806, 904], "16:9"], [[1608, 1146], "4:3"], [[1596, 1110], "3:2"], [[988, 1294], "3:4"], [[1080, 1080], "1:1"], [[1080, 1920], "9:16"]];
  for (const [size, want] of cases) {
    const f = editFrame(size);
    assert.equal(f.aspect, want, `${size.join("×")}`);
    const [x, y, cw, ch] = f.crop, [a, b] = EDIT_SIZES[want];
    assert.ok(x >= 0 && y >= 0 && x + cw <= size[0] && y + ch <= size[1], "the crop stays inside the photo");
    assert.ok(Math.abs(cw / ch - a / b) / (a / b) < 0.003, `${want}: ${cw}×${ch} is the shape the model makes (${a}×${b})`);
    assert.ok(cw === size[0] || ch === size[1], "one side is kept whole");
    // No other supported shape would have kept more of the photo.
    for (const other of EDIT_ASPECTS) {
      const [p, q] = EDIT_SIZES[other], r = p / q;
      const area = size[0] / size[1] > r ? Math.round(size[1] * r) * size[1] : size[0] * Math.round(size[0] / r);
      assert.ok(area <= cw * ch + 1, `${other} would keep more of ${size.join("×")}`);
    }
  }
  // Without anything to leave out, the crop is centred.
  const c = editFrame([1874, 890]);
  assert.ok(Math.abs(c.crop[1] - (890 - c.crop[3]) / 2) <= 1);
});

test("P2 the crop slides to leave web controls at the edge out of the edit", () => {
  const controls = [[920, 420, 1000, 580]]; // arrows along the bottom edge, 8% tall (y 819–890 px)
  assert.ok(editFrame([1874, 890]).crop[1] + editFrame([1874, 890]).crop[3] > 819, "a centred crop would keep part of them");
  const f = editFrame([1874, 890], controls);
  assert.ok(f.crop[1] + f.crop[3] <= 819, `the crop moves up, so the strip with the arrows is trimmed (${f.crop})`);
  assert.ok(f.crop[1] > 0, "and no further than it needs to");
  assert.equal(toCrop([{ category: "web_control", object: "arrows", box_2d: controls[0] }], f.crop, [1874, 890]).length, 0, "the arrows are wholly outside the crop, so they are not sent to the edit");
  // An item inside is mapped onto the crop's own 0–1000 scale.
  const [m] = toCrop([{ category: "logo", object: "a logo", box_2d: [100, 500, 200, 600] }], f.crop, [1874, 890]);
  const y = (v) => Math.round(((v / 1000) * 890 - f.crop[1]) / f.crop[3] * 1000);
  assert.deepEqual(m.box_2d, [y(100), 500, y(200), 600]);
  assert.deepEqual(toCrop([{ box_2d: [0, 0, 1000, 1000] }], [0, 0, 1000, 500], [1000, 1000])[0].box_2d, [0, 0, 1000, 1000], "a box running off the crop is clipped to it");
});

// ── describing the edit ───────────────────────────────────────────────────

test("P3 places are described in words", () => {
  assert.equal(where([50, 50, 250, 250]), "in the upper left");
  assert.equal(where([400, 400, 600, 600]), "in the centre");
  assert.equal(where([700, 700, 850, 850]), "in the lower right");
  assert.equal(where([400, 700, 600, 850]), "on the right");
  assert.equal(where([940, 400, 1000, 600]), "along the bottom edge");
  assert.equal(where([940, 900, 1000, 990]), "at the bottom right edge");
  assert.equal(where([700, 0, 950, 40]), "at the left edge, near the bottom");
  assert.equal(where([100, 100, 300, 900]), "across the top of the photo");
  assert.equal(where([100, 700, 900, 900]), "down the right side");
  assert.equal(where(null), "somewhere in the photo");
  // Anything small also gets a position: "on the right" does not find a thumb-sized logo.
  assert.equal(placeOf([400, 820, 440, 850]), "on the right (about 84% across and 42% down)");
  assert.equal(placeOf([100, 550, 300, 950]), "in the upper right", "a large item needs no position");
});

test("P4 descriptions lose every quoted word, 'reading …' phrase and brand name", () => {
  const names = ["Sculpt Society", "FirenGym"];
  assert.equal(plainWords('neon lettering reading "You\'re one workout away from a good mood" on the wall', names), "neon lettering");
  assert.equal(plainWords("a 'FirenGym' logo plate on the chest press", names), "a logo plate on the chest press");
  assert.equal(plainWords("the FirenGym wordmark on the machine top", names), "the wordmark on the machine top");
  assert.equal(plainWords("a green sign that says EXIT above the door", names), "a green sign");
  assert.equal(plainWords("“20 KG” numbers on the weight plates", names), "numbers on the weight plates");
  assert.equal(plainWords("glowing neon lettering on the upper wall", names), "glowing neon lettering on the upper wall");
  assert.equal(plainWords("the machine's logo plate", names), "the machine's logo plate", "an apostrophe is not a quote");
});

test("P5 the edit prompt names objects and places, never words, and asks to keep and add nothing", () => {
  const items = [
    { category: "wall_lettering", object: 'neon lettering reading "You\'re one workout away"', box_2d: [100, 550, 300, 950] },
    { category: "never_item", object: "a row of flame-shaped wall lights along the left wall", box_2d: [300, 0, 450, 400] },
    { category: "equipment_marking", object: "a FirenGym logo plate on the machine top", box_2d: [350, 880, 420, 1000] },
    { category: "web_control", object: "page arrows", box_2d: [950, 400, 1000, 600] },
    { category: "made_up", object: "", box_2d: [500, 500, 520, 520] },
  ];
  const p = buildCleanPrompt({ items, brandNames: ["Sculpt Society", "FirenGym"] });
  for (const bad of ["You're", "workout", "FirenGym", "Sculpt Society", '"']) assert.ok(!p.includes(bad), `the prompt must not carry "${bad}"`);
  assert.match(p, /- neon lettering, in the upper right: remove it completely, leaving plain wall/);
  assert.match(p, /- a row of flame-shaped wall lights along the left wall, on the left: remove it completely/);
  assert.match(p, /- a logo plate on the machine top, on the right \(about 94% across and 39% down\): remove only the numbers or markings themselves; the equipment keeps its own colours/);
  assert.match(p, /- page arrows, along the bottom edge \(about 50% across and 98% down\): remove it and continue the photo/);
  assert.match(p, /- a mark, in the centre \(about 51% across and 51% down\): remove it, leaving the surface plain/, "an unknown category falls back to a plain removal");
  for (const clause of [KEEP_CLAUSE, ADD_NOTHING_CLAUSE, REAL_PHOTO_CLAUSE]) assert.ok(p.includes(clause));
  assert.match(p, /mirror or reflection/);
  const twice = buildCleanPrompt({ items: [items[1], items[1]] });
  assert.equal(twice.split("flame-shaped").length - 1, 1, "identical lines are listed once");
  assert.throws(() => buildCleanPrompt({ items: [] }), /nothing to remove/);
});

test("P6 leftovers from a failed attempt are described by kind and place only", () => {
  const left = { text: [{ kind: "neon text", what: "workout away from", box_2d: [100, 600, 200, 900] }, { kind: "UI element", what: "zoom button +", box_2d: [930, 950, 990, 990] }], never: [{ what: "flame-shaped wall sconce reading FirenGym", box_2d: [300, 100, 360, 140] }] };
  const items = leftoverItems(left);
  assert.equal(items.length, 3);
  assert.equal(items[1].category, "web_control");
  assert.equal(items[2].category, "never_item");
  const p = buildCleanPrompt({ items, brandNames: ["FirenGym"] });
  for (const bad of ["workout", "zoom button +", "FirenGym", "sconce reading"]) assert.ok(!p.includes(bad), `"${bad}" leaked into the retry prompt`);
  assert.match(p, /a remaining neon text, in the upper right/);
  assert.deepEqual(markItem({ kind: "number", what: "20", box_2d: [400, 0, 450, 30] }), { category: "other", object: "a remaining number", box_2d: [400, 0, 450, 30] }, "a number's value is never carried over");
  assert.equal(markItem({ kind: "logo", what: "Life Fitness", box_2d: [1, 1, 2, 2] }).object, "a remaining logo", "nor a logo's name");
  assert.equal(markItem({ what: 'neon wall text reading "good mood"', box_2d: [1, 1, 2, 2] }, "never").object, "neon wall text");
});

test("P6b a second source adds only what the first did not already cover", () => {
  const items = [{ category: "logo", object: "a logo", box_2d: [100, 100, 300, 300] }];
  const extra = [{ category: "other", object: "a mark", box_2d: [150, 150, 250, 250] }, { category: "other", object: "a notice", box_2d: [500, 500, 600, 600] }, { category: "other", object: "half in", box_2d: [200, 200, 400, 400] }];
  assert.deepEqual(mergeItems(items, extra).map((i) => i.object), ["a logo", "a notice", "half in"], "inside an existing box: dropped; elsewhere, or mostly outside: added");
});

// ── the rules (pure) ──────────────────────────────────────────────────────

test("P7 every rule fails the photo on its own, and a clean edit passes", () => {
  const good = { left: { text: [], never: [] }, peopleBefore: 0, peopleAfter: 0, compare: { same_room: true, same_viewpoint: true, real_photo: true, differences: [{ what: "a cable is shorter", kind: "changed", noticeable: false }] }, pixels: { changed_outside_share: 0.03 }, sourceSize: [1874, 803], editedSize: [3168, 1344] };
  assert.deepEqual(judgeClean(good), { ok: true, failures: [], marks_only: false }, "an unnoticeable difference does not fail");
  const cases = [
    [{ left: { text: [{ kind: "neon", what: "mood", box_2d: [100, 600, 200, 900] }], never: [] } }, /marks still in the photo/],
    [{ left: { text: [], never: [{ what: "flame sconce", box_2d: [300, 0, 360, 40] }] } }, /never allows: flame sconce/],
    [{ peopleAfter: 1 }, /people were added \(0 before, 1 after\)/],
    [{ compare: { ...good.compare, same_room: false } }, /same room/],
    [{ compare: { ...good.compare, same_viewpoint: false } }, /viewpoint/],
    [{ compare: { ...good.compare, real_photo: false } }, /real photograph/],
    [{ compare: { ...good.compare, differences: [{ what: "the leg press is gone", kind: "removed", noticeable: true }] } }, /changed more than the marks: removed: the leg press is gone/],
    [{ compare: null }, /comparison did not run/],
    [{ pixels: { changed_outside_share: MAX_UNINTENDED + 0.01 } }, /outside the removal areas changed/],
    [{ pixels: null }, /pixel comparison did not run/],
    [{ editedSize: [1584, 672] }, /lower resolution than the source/],
  ];
  for (const [change, why] of cases) {
    const r = judgeClean({ ...good, ...change });
    assert.equal(r.ok, false, `${why} should fail`);
    assert.equal(r.failures.length, 1, `only its own rule fails: ${r.failures}`);
    assert.match(r.failures[0], why);
    assert.equal(r.marks_only, /marks still|never allows/.test(why.source), "only leftover marks let the next edit start from this one");
  }
  assert.equal(judgeClean({ ...good, left: { text: [{ kind: "logo", what: "x" }], never: [] }, pixels: { changed_outside_share: 0.5 } }).marks_only, false, "marks plus a damaged room is not marks only");
});

// ── pixels (Chrome, synthetic pictures) ────────────────────────────────────

test("P8 the pixel comparison sees only real changes, and only outside the removal areas counts", async () => {
  const base = tiles(W, H);
  const same = await comparePixels(browser, base, base);
  assert.equal(same.changed_share, 0);
  const bigger = await comparePixels(browser, base, tiles(W * 2, H * 2));
  assert.ok(bigger.changed_outside_share < 0.01, `the same picture at twice the size is unchanged (${bigger.changed_outside_share})`);
  const grain = await comparePixels(browser, base, tiles(W, H, { lighten: 0.03 }));
  assert.ok(grain.changed_outside_share < 0.01, `a slight tone shift is not a change (${grain.changed_outside_share})`);
  const nudged = await comparePixels(browser, base, tiles(W, H, { dx: 6 }));
  assert.ok(nudged.changed_outside_share < 0.01, `a half-percent nudge is not a change (${nudged.changed_outside_share})`);
  // A repaint inside a removal area is allowed; the same repaint elsewhere is counted.
  const patch = [0.5, 0.2, 0.2, 0.2];
  const inside = await comparePixels(browser, base, tiles(W, H, { patch }), { boxes: [[200, 500, 400, 700]] });
  assert.ok(inside.changed_share > 0.02, "the repaint is seen");
  assert.equal(inside.changed_outside_share, 0, "but it is inside the removal area");
  const outside = await comparePixels(browser, base, tiles(W, H, { patch }), { boxes: [[600, 0, 900, 200]] });
  assert.ok(Math.abs(outside.changed_outside_share - 0.04 / (1 - outside.removal_share)) < 0.015, `the repaint is ~4% of what is outside (${outside.changed_outside_share})`);
  // A zoomed or shifted room is a different picture.
  const zoomed = await comparePixels(browser, base, tiles(W, H, { scale: 1.1 }));
  assert.ok(zoomed.changed_outside_share > MAX_UNINTENDED, `a 10% zoom fails (${zoomed.changed_outside_share})`);
  const shifted = await comparePixels(browser, base, tiles(W, H, { dx: 40 }));
  assert.ok(shifted.changed_outside_share > MAX_UNINTENDED, `a 3% shift fails (${shifted.changed_outside_share})`);
});

test("P9 the crop takes exactly the pixels asked for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clean-crop-"));
  try {
    const half = svg(1000, 400, `<rect width="500" height="400" fill="#c62828"/><rect x="500" width="500" height="400" fill="#2b3a55"/>`);
    const out = await cropImage(browser, half, [500, 50, 400, 300], join(dir, "c.png"));
    assert.deepEqual(imageSize(readFileSync(out)), [400, 300]);
    const r = await comparePixels(browser, out, svg(400, 300, `<rect width="100%" height="100%" fill="#2b3a55"/>`));
    assert.equal(r.changed_share, 0, "only the right half's colour is in the crop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the flow (fakes; no spend) ────────────────────────────────────────────

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "clean-flow-"));
  const photos = join(dir, "facility");
  mkdirSync(photos);
  const a = join(photos, "a.png"), b = join(photos, "b.png");
  writeFileSync(a, pngHeader(1874, 890));
  writeFileSync(b, pngHeader(1200, 900));
  return { dir, a, b, out: join(dir, "out"), clean: join(dir, "facility-clean") };
}
const fakePixels = (share = 0.02) => ({
  crop: async (src, crop, out) => { writeFileSync(out, pngHeader(crop[2], crop[3])); return out; },
  compare: async () => ({ grid: [96, 41], changed_share: share, changed_outside_share: share, removal_share: 0.1, changed: [], masked: [] }),
  // The candidate is written at the input's size; a marker says which raw edit it came from.
  paste: async (input, raw, boxes, out) => { writeFileSync(out, Buffer.concat([readFileSync(input).subarray(0, 33), Buffer.from(`pasted:${raw.split("/").pop()}`)])); return out; },
  draw: async () => {}, close: async () => {},
});
const SURVEYS = {
  "a.png": { people_count: 0, items: [{ category: "wall_lettering", object: 'neon lettering reading "good mood"', box_2d: [100, 550, 300, 950] }, { category: "web_control", object: "arrows", box_2d: [950, 420, 1000, 580] }] },
  "b.png": { people_count: 0, items: [] },
};
const survey = async (p) => SURVEYS[p.split("/").pop()];
const NONE = async () => [];
const SAME = async () => ({ same_room: true, same_viewpoint: true, real_photo: true, differences: [] });

test("P10 the flow: survey, frame, edit, check; a retry carries the leftovers; the budget holds", async () => {
  const { dir, a, b, out, clean } = setup();
  try {
    const before = [sha(a), sha(b)];
    const calls = [];
    let n = 0;
    const generate = async (prompt, refs, opts) => { calls.push({ prompt, refs, opts }); return { buffer: pngHeader(3168, 1344 + calls.length), ext: "png" }; };
    // The first edit leaves lettering behind; the second is clean.
    const check = async () => (++n === 1 ? { text: [{ kind: "neon text", what: "good mood", box_2d: [120, 600, 200, 900] }], never: [], people_count: 0 } : { text: [], never: [], people_count: 0 });
    const r = await cleanPhotos({ photos: [a, b], never: ["the flame logo"], brandNames: ["FirenGym"], outDir: out, cleanDir: clean, maxCalls: 5, attempts: 3, generate, survey, check, compare: SAME, recheck: NONE, pixels: fakePixels(), log: () => {} });
    assert.equal(r.image_calls, 2, "two edits for a, none for b");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].opts, { aspectRatio: "21:9", imageSize: "2K" }, "the edit is made at the frame's shape and full resolution");
    assert.equal(calls[0].refs.length, 1, "the cropped original is the only image sent");
    assert.ok(!calls[0].prompt.includes("page arrows") && !/arrows/.test(calls[0].prompt), "the arrows were cropped away, so the edit is not asked about them");
    assert.ok(!calls[1].prompt.includes("good mood") && calls[1].prompt.includes("a remaining neon text"), "the retry names what was left, by kind and place");
    assert.ok(!calls[1].prompt.includes("neon lettering"), "and only what was left: the room came through, so the retry finishes the first edit");
    assert.equal(Buffer.from(calls[1].refs[0].inline_data.data, "base64").toString().slice(33), "pasted:a.raw.png", "the retry edits the first candidate: the original with the first edit pasted into its boxes");
    assert.equal(calls[0].refs[0].inline_data.data, readFileSync(join(out, "a.source.png")).toString("base64"), "the first edit is of the cropped original");
    const [ra, rb] = r.results;
    assert.equal(ra.status, "passed");
    assert.equal(ra.attempt, 2);
    assert.equal(ra.attempts[0].status, "flagged");
    assert.deepEqual(ra.attempts.map((t) => t.from), ["original", "a.png"]);
    assert.ok(existsSync(join(clean, "a.png")), "the passing candidate is the clean copy");
    assert.equal(readFileSync(join(clean, "a.png")).subarray(33).toString(), "pasted:a-a2.raw.png", "the clean copy is the pasted candidate, never a raw edit");
    assert.deepEqual(imageSize(readFileSync(join(clean, "a.png"))), [ra.frame.crop[2], ra.frame.crop[3]], "at the original crop's size");
    assert.equal(rb.status, "already clean");
    assert.ok(existsSync(join(clean, "b.png")), "a photo with nothing to remove is copied through (cropped)");
    assert.ok(existsSync(join(out, "report.json")) && existsSync(join(out, "a.survey.json")) && existsSync(join(out, "a-a2.prompt.txt")));
    assert.deepEqual([sha(a), sha(b)], before, "the originals are never modified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P11 a failing edit is never used, the call budget is never exceeded, and originals cannot be overwritten", async () => {
  const { dir, a, out, clean } = setup();
  try {
    let calls = 0;
    const generate = async () => { calls++; return { buffer: pngHeader(3168, 1344), ext: "png" }; };
    const dirty = async () => ({ text: [], never: [{ what: "flame sconce", box_2d: [300, 0, 360, 40] }], people_count: 0 });
    const r = await cleanPhotos({ photos: [a], outDir: out, cleanDir: clean, maxCalls: 1, attempts: 3, generate, survey, check: dirty, compare: SAME, recheck: NONE, pixels: fakePixels(), log: () => {} });
    assert.equal(calls, 1, "one call allowed, one made");
    assert.equal(r.results[0].status, "flagged");
    assert.ok(!existsSync(join(clean, "a.png")), "a flagged edit is not written as the clean copy");
    // Too much changed outside the removal areas, even though every mark is gone.
    const moved = await cleanPhotos({ photos: [a], outDir: join(dir, "o2"), cleanDir: join(dir, "c2"), generate, survey, check: async () => ({ text: [], never: [], people_count: 0 }), compare: SAME, recheck: NONE, pixels: fakePixels(0.2), log: () => {} });
    assert.equal(moved.results[0].status, "flagged");
    assert.match(moved.results[0].failures.join(), /does not line up with the photo: 20\.0% of the photo outside the removal areas changed/);
    assert.ok(!moved.results[0].attempts[0].file, "nothing is pasted from a misaligned edit");
    // Marks left AND the room damaged: the retry starts again from the original, with the leftovers added.
    let k = 0;
    const seen = [];
    const gen2 = async (prompt, refs) => { seen.push({ prompt, ref: refs[0].inline_data.data }); return { buffer: pngHeader(3168, 1344), ext: "png" }; };
    const leaves = async () => (++k === 1 ? { text: [{ kind: "logo", what: "x", box_2d: [500, 500, 520, 520] }], never: [], people_count: 0 } : { text: [], never: [], people_count: 0 });
    let q = 0;
    const damaged = async () => (++q === 1 ? { same_room: true, same_viewpoint: true, real_photo: true, differences: [{ what: "the dumbbells turned solid red", kind: "changed", noticeable: true }] } : { same_room: true, same_viewpoint: true, real_photo: true, differences: [] });
    const r3 = await cleanPhotos({ photos: [a], outDir: join(dir, "o3"), cleanDir: join(dir, "c3"), attempts: 2, maxCalls: 2, generate: gen2, survey, check: leaves, compare: damaged, recheck: NONE, pixels: fakePixels(), log: () => {} });
    assert.deepEqual(r3.results[0].attempts.map((t) => t.from), ["original", "original"]);
    assert.equal(seen[1].ref, seen[0].ref, "both edits start from the cropped original");
    assert.ok(seen[1].prompt.includes("neon lettering") && seen[1].prompt.includes("a remaining logo"), "the full list plus the leftover");
    const before = calls;
    await assert.rejects(cleanPhotos({ photos: [a], outDir: out, cleanDir: join(dir, "facility"), generate, survey, check: dirty, compare: SAME, recheck: NONE, pixels: fakePixels(), log: () => {} }), /would be overwritten/);
    assert.equal(calls, before, "refused before any call");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── tiled checking (check-visual.mjs) ──────────────────────────────────────

test("P12 large photos are also checked in full-resolution tiles that cover every pixel", async () => {
  const { tileGrid, fromTile, dedupeItems, checkTiled } = await import("./check-visual.mjs");
  assert.deepEqual(tileGrid([1024, 1024]), [], "a photo the model sees whole needs no tiles");
  for (const size of [[3168, 1344], [2400, 1792], [1874, 890], [1080, 1920]]) {
    const t = tileGrid(size);
    assert.ok(t.length >= 2, `${size}: tiled`);
    for (const [x, y, w, h] of t) assert.ok(x >= 0 && y >= 0 && x + w <= size[0] && y + h <= size[1] && w <= 1100 * 1.13 && h <= 1100 * 1.13, `${size}: tile ${[x, y, w, h]} inside and small`);
    // Every pixel column and row falls inside some tile, with overlap between neighbours.
    for (let px = 0; px < size[0]; px += 7) for (let py = 0; py < size[1]; py += 7) assert.ok(t.some(([x, y, w, h]) => px >= x && px < x + w && py >= y && py < y + h), `${size}: pixel ${px},${py} is in no tile`);
  }
  assert.deepEqual(fromTile([0, 0, 1000, 1000], [1200, 0, 1200, 896], [2400, 1792]), [0, 500, 500, 1000], "a tile's box maps onto the whole photo");
  assert.equal(dedupeItems([{ list: "text", box_2d: [100, 100, 200, 200] }, { list: "text", box_2d: [110, 110, 190, 190] }, { list: "never", box_2d: [110, 110, 190, 190] }]).length, 2, "the same mark seen in two tiles counts once");
  // The flow: whole image first (people counted there), then each tile; boxes come back on the whole photo.
  const dir = mkdtempSync(join(tmpdir(), "tiles-"));
  try {
    const big = join(dir, "big.png");
    writeFileSync(big, pngHeader(2400, 1792));
    const asked = [];
    const crop = async (src, rect, out) => { writeFileSync(out, pngHeader(rect[2], rect[3])); asked.push(rect); return out; };
    const ask = async (file) => (file === big ? { text_items: [], excluded_items: [], people_count: 0 } : asked.length && file.endsWith("t0.png") ? { text_items: [{ kind: "logo", what: "plate", box_2d: [500, 500, 520, 520] }], excluded_items: [{ what: "flame-shaped wall sconce", box_2d: [600, 500, 640, 530] }], people_count: 3 } : { text_items: [], excluded_items: [], people_count: 0 });
    const confirm = async (file, items) => ({ kept: items, dismissed: [] });
    const r = await checkTiled(big, { crop, ask, confirm });
    assert.equal(r.tiles, tileGrid([2400, 1792]).length);
    assert.equal(r.people_count, 0, "people are counted on the whole photo, not summed over tiles");
    const [t0] = tileGrid([2400, 1792]);
    assert.deepEqual(r.text[0].box_2d, fromTile([500, 500, 520, 520], t0, [2400, 1792]));
    assert.equal(r.never[0].what, "flame-shaped wall sconce");
    assert.ok(!existsSync(join(tmpdir(), "check-tiles-")), "tiles are cleaned up");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P13 the paste keeps the original everywhere outside the boxes, and matches the edit's tone inside", async () => {
  const { pasteEdit } = await import("./clean-photo.mjs");
  const dir = mkdtempSync(join(tmpdir(), "paste-"));
  try {
    const orig = join(dir, "o.png"), edit = join(dir, "e.png"), out = join(dir, "c.png");
    await cropImage(browser, tiles(W, H), [0, 0, W, H], orig);
    // The "edit": twice the size, 12% lighter all over (the model's tone drift), a repaint inside the box, and one outside it.
    await cropImage(browser, tiles(W * 2, H * 2, { lighten: 0.12, patch: [0.5, 0.2, 0.1, 0.1] }), [0, 0, W * 2, H * 2], join(dir, "e1.png"));
    await cropImage(browser, svg(W * 2, H * 2, `<image href="${"data:image/png;base64," + readFileSync(join(dir, "e1.png")).toString("base64")}" width="${W * 2}" height="${H * 2}"/><rect x="${0.1 * W * 2}" y="${0.7 * H * 2}" width="${0.1 * W * 2}" height="${0.1 * H * 2}" fill="#00ff66"/>`), [0, 0, W * 2, H * 2], edit);
    const box = [180, 480, 320, 620];
    await pasteEdit(browser, orig, edit, [box], out, { margin: 0 });
    assert.deepEqual(imageSize(readFileSync(out)), [W, H], "written at the original's size");
    const strict = await comparePixels(browser, orig, out, { boxes: [box], margin: 40, tolerance: 3 });
    assert.equal(strict.changed_outside_share, 0, "outside the box (and its feather) the original's pixels are untouched: the repaint there and the tone drift are gone");
    const inside = await comparePixels(browser, orig, out, { tolerance: 3 });
    assert.ok(inside.changed_share > 0.005, "the repaint inside the box is kept");
    // The tone drift is taken out inside the boxes too. A large box with the repaint small in its middle:
    // of the box's own area (repaint excepted), almost nothing may differ from the original.
    const bigBox = [100, 250, 550, 850], patchBox = [200, 500, 300, 600];
    await pasteEdit(browser, orig, edit, [bigBox], out, { margin: 0 });
    const t = await comparePixels(browser, orig, out, { boxes: [patchBox], margin: 15, tolerance: 8 });
    const boxShare = 0.45 * 0.6, inBox = (t.changed_outside_share * (1 - t.removal_share)) / (boxShare - t.removal_share);
    assert.ok(inBox < 0.05, `no seam: the pasted area's tone matches the original (${(inBox * 100).toFixed(1)}% of the box differs)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Exact pixels (the comparison grid tolerates small shifts by design, so it cannot see doubling).
import zlib from "node:zlib";
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === "IDAT") idat.push(d); else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const A = i >= ch ? cur[i - ch] : 0, B = prev[i], C = i >= ch ? prev[i - ch] : 0, x = line[i], p = A + B - C, pa = Math.abs(p - A), pb = Math.abs(p - B), pc = Math.abs(p - C);
      cur[i] = (ft === 0 ? x : ft === 1 ? x + A : ft === 2 ? x + B : ft === 3 ? x + ((A + B) >> 1) : x + (pa <= pb && pa <= pc ? A : pb <= pc ? B : C)) & 255;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w, h, ch, px: out };
}
/** Share of pixels inside `rect` (0–1 of the image, [x, y, w, h]), outside `skip`, differing by more than `t` on any channel. */
function exactDiff(pa, pb, rect, skip, t = 12) {
  const A = decodePNG(readFileSync(pa)), B = decodePNG(readFileSync(pb));
  let n = 0, d = 0;
  for (let y = Math.floor(rect[1] * A.h); y < (rect[1] + rect[3]) * A.h; y++) for (let x = Math.floor(rect[0] * A.w); x < (rect[0] + rect[2]) * A.w; x++) {
    if (skip && x >= skip[0] * A.w && x < (skip[0] + skip[2]) * A.w && y >= skip[1] * A.h && y < (skip[1] + skip[3]) * A.h) continue;
    const i = (y * A.w + x) * A.ch, j = (y * B.w + x) * B.ch; n++;
    if (Math.max(Math.abs(A.px[i] - B.px[j]), Math.abs(A.px[i + 1] - B.px[j + 1]), Math.abs(A.px[i + 2] - B.px[j + 2])) > t) d++;
  }
  return d / n;
}

test("P14 the paste lines each edit up; a faithfully redrawn box is taken whole, a loosely redrawn one only where it changed; a small box always whole", async () => {
  const { pasteEdit } = await import("./clean-photo.mjs");
  const dir = mkdtempSync(join(tmpdir(), "paste2-"));
  try {
    const clean = join(dir, "clean.png"), orig = join(dir, "o.png"), out = join(dir, "c.png");
    const patch = [0.5, 0.25, 0.08, 0.08], box = [[100, 250, 550, 850]];
    await cropImage(browser, tiles(W, H), [0, 0, W, H], clean);
    await cropImage(browser, tiles(W, H, { patch }), [0, 0, W, H], orig);
    // 1. Faithful: the patch removed, everything redrawn 12 px to the right (at the original's scale), with a smooth tone drift.
    await cropImage(browser, tiles(W * 2, H * 2, { dx: 24, lighten: 0.06 }), [0, 0, W * 2, H * 2], join(dir, "e1.png"));
    await pasteEdit(browser, orig, join(dir, "e1.png"), box, out, { margin: 0 });
    assert.deepEqual(pasteEdit.lastGlobal, [12, 0], "the edit's overall shift is found, beyond a box's own search");
    assert.equal(pasteEdit.last[0].whole, true, `a faithful redraw is taken whole (fit ${pasteEdit.last[0].fit})`);
    assert.ok(exactDiff(clean, out, patch, null, 25) < 0.01, "the patch is gone");
    assert.ok(exactDiff(clean, out, [0.25, 0.1, 0.6, 0.45], null, 14) < 0.01, "and the whole box matches the clean room: lined up, tone matched, no doubling");
    const faithfulFit = pasteEdit.last[0].fit;
    // 2. Loose: some tiles redrawn 20 px off their place, the rest in place. The fit score says so ...
    await cropImage(browser, tiles(W * 2, H * 2, { jitter: 40 }), [0, 0, W * 2, H * 2], join(dir, "e2.png"));
    await pasteEdit(browser, orig, join(dir, "e2.png"), box, out, { margin: 0 });
    assert.ok(pasteEdit.last[0].fit > 2 * faithfulFit && pasteEdit.last[0].fit > WHOLE_BOX_FIT, `a loose redraw scores a poor fit (${pasteEdit.last[0].fit} vs ${faithfulFit} faithful)`);
    assert.equal(pasteEdit.last[0].whole, false, "so it is not taken whole");
    // ... and then only what changed is taken: tiles drawn in place keep the original's exact pixels.
    const P = decodePNG(readFileSync(out));
    let green = 0;
    for (let i = 0; i < P.w * P.h; i++) { const r = P.px[i * P.ch], g = P.px[i * P.ch + 1], bl = P.px[i * P.ch + 2]; if (g > 150 && r < 100 && g - bl > 60) green++; }
    assert.equal(green, 0, "no trace of the removed patch is left");
    const calm = [];
    for (let r = 1; r <= 3; r += 2) for (let c = 4; c <= 12; c++) if (c % 3 && !(r === 2 && c >= 7 && c <= 9)) calm.push([c, r]);
    for (const [c, r] of calm) {
      // The centre 9 px: beyond a diagonal neighbour's 20 px overlap plus the mask's growth.
      const interior = [(c * 75 + 33) / W, (r * 75 + 33) / H, 9 / W, 9 / H];
      assert.equal(exactDiff(orig, out, interior, null, 2), 0, `tile ${c},${r}: the original's own pixels, not the loose redraw`);
    }
    // The same edit taken whole would have carried the moved tiles in: the fallback is what keeps them out.
    await pasteEdit(browser, orig, join(dir, "e2.png"), box, join(dir, "w.png"), { margin: 0, wholeFit: 1000 });
    assert.ok(exactDiff(orig, join(dir, "w.png"), [0.25, 0.1, 0.6, 0.45], [0.47, 0.22, 0.14, 0.14], 25) > 0.03, "taken whole, the moved tiles come in");
    // 3. A small box is taken whole, so a low-contrast mark (dark on dark) that barely registers as a change still goes.
    const faint = svg(W, H, `<rect width="100%" height="100%" fill="#1c1c1c"/><rect x="${0.5 * W}" y="${0.5 * H}" width="${0.05 * W}" height="${0.04 * H}" fill="#2a2a2a"/>`);
    await cropImage(browser, faint, [0, 0, W, H], join(dir, "f.png"));
    await cropImage(browser, svg(W * 2, H * 2, `<rect width="100%" height="100%" fill="#1c1c1c"/>`), [0, 0, W * 2, H * 2], join(dir, "fe.png"));
    await pasteEdit(browser, join(dir, "f.png"), join(dir, "fe.png"), [[490, 490, 550, 560]], out, { margin: 5 });
    await cropImage(browser, svg(W, H, `<rect width="100%" height="100%" fill="#1c1c1c"/>`), [0, 0, W, H], join(dir, "plain.png"));
    assert.equal(exactDiff(join(dir, "plain.png"), out, [0, 0, 1, 1], null, 3), 0, "the faint mark is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P15 every item found stays on a checklist: a candidate the open search passes still fails while a known item is there", async () => {
  const { dir, a, out, clean } = setup();
  try {
    const prompts = [];
    const generate = async (prompt) => { prompts.push(prompt); return { buffer: pngHeader(3168, 1344), ext: "png" }; };
    const openSearchMisses = async () => ({ text: [], never: [], people_count: 0 });
    // The checklist still sees the survey's neon lettering after the first edit, and nothing after the second.
    const lists = [];
    let k = 0;
    const recheck = async (file, items) => { lists.push(items.map((i) => i.what)); return ++k === 1 ? items.filter((i) => /neon/.test(i.what)) : []; };
    const r = await cleanPhotos({ photos: [a], outDir: out, cleanDir: clean, attempts: 3, maxCalls: 3, generate, survey, check: openSearchMisses, recheck, compare: SAME, pixels: fakePixels(), log: () => {} });
    assert.equal(r.results[0].status, "passed");
    assert.equal(r.results[0].attempt, 2, "the first candidate failed on the checklist alone");
    assert.match(r.results[0].attempts[0].failures.join(), /marks still in the photo: wall lettering "neon lettering"/);
    assert.deepEqual(lists[0], ["neon lettering"], "the checklist starts as the survey's items (the cropped-away arrows are not on it), described without their words");
    assert.match(prompts[1], /a remaining wall lettering, in the upper right/, "the retry is aimed at the item still there");
    assert.ok(!prompts[1].includes("good mood"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P16 the checklist looks for each item in the full-resolution tile that holds it", async () => {
  const { confirmTiled, tileGrid, fromTile } = await import("./check-visual.mjs");
  const dir = mkdtempSync(join(tmpdir(), "confirm-"));
  try {
    const big = join(dir, "big.png");
    writeFileSync(big, pngHeader(2400, 1792));
    const tiles = tileGrid([2400, 1792]);
    const crop = async (src, rect, o) => { writeFileSync(o, pngHeader(rect[2], rect[3])); return o; };
    const asked = [];
    const confirm = async (file, items) => { asked.push({ file, items }); return { kept: items.filter((i) => /sconce/.test(i.what)), dismissed: [] }; };
    const sconce = { what: "flame-shaped wall sconce", box_2d: [300, 150, 330, 170], list: "never" }, plate = { what: "a logo plate", kind: "logo", box_2d: [700, 800, 720, 830], list: "text" };
    const still = await confirmTiled(big, [sconce, plate], { crop, confirm });
    assert.deepEqual(still, [sconce], "what is still there comes back as it was given, on the whole photo's scale");
    assert.equal(asked.length, 2, "one look per tile that holds an item");
    for (const { items } of asked) for (const it of items) assert.ok(it.box_2d.every((v) => v >= 0 && v <= 1000), "boxes are given on the tile's own scale");
    // Mapping a tile box back gives the original box (to rounding).
    const [t0] = tiles, sc = asked.find((q) => q.items[0].what.includes("sconce")).items[0];
    assert.ok(fromTile(sc.box_2d, t0, [2400, 1792]).every((v, i) => Math.abs(v - sconce.box_2d[i]) <= 2));
    assert.deepEqual(await confirmTiled(big, [], { crop, confirm }), [], "nothing to confirm, no call");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
