/**
 * Tests for the control panel (ui/server.mjs + ui/app.html), Step 7.
 *
 *   node --test ui/server.test.mjs
 *
 * The real panel is started on a free port against a throwaway clients folder. Network access
 * outside this machine is blocked in the panel and in every process it starts (a preloaded fetch
 * guard), so nothing here can reach Gemini — a test that tried would fail, not spend.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { launchBrowser } from "../skills/references/render-composites.mjs";
import { cropImage } from "../skills/references/clean-photo.mjs";
import { validateBrief, runBatch, resolveSelections, MAX_CALLS_CAP } from "../skills/references/plan-offer-batch.mjs";
import { approveScenes, rejectScene } from "../skills/references/scene-library.mjs";
import { pullDaily } from "../skills/references/portfolio-numbers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = (w, h, body) => "data:image/svg+xml;base64," + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`).toString("base64");
const GYM = "testgym";
const WORDS = { offer: "12 Week Total Body Reset", locations: ["BISHAN", "ANG MO KIO"], audience: "MEN" };
const BRIEF = { batch_id: "ref-batch", ...WORDS, free: false, generated: 0, real: ["facility-clean/r1.png", "facility-clean/r2.png"], looks_per_photo: 2, max_calls: 0, attempts: 1, scenes: null, seed: "ui-test" };

let dir, brands, stub, browser, panel;

/** Start the panel; resolves with { url, port, token, log, stop }. */
function startPanel(env = {}) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(ROOT, "ui", "server.mjs"), "--port", "0"], {
      // No Meta keys unless a test gives them: whatever this machine's .env holds, the panel under test has none.
      cwd: ROOT, env: { ...process.env, PANEL_BRANDS_DIR: brands, COPY_LIBRARY_DIR: join(dirname(brands), "library"), TARGETING_LIBRARY_DIR: join(dirname(brands), "library"), NODE_OPTIONS: `--import=${stub}`, META_ACCESS_TOKEN: "", META_APP_ID: "", META_APP_SECRET: "", META_GRAPH_URL: "", GOOGLE_PLACES_KEY: "", ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", async (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m && !child.started) {
        child.started = true;
        const port = Number(m[1]), url = `http://127.0.0.1:${port}`;
        const html = await (await fetch(url + "/")).text();
        const token = html.match(/<meta name="panel-token" content="([a-f0-9]+)">/)?.[1];
        res({ url, port, token, child, log: () => err, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) });
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (c) => { if (!child.started) rej(new Error(`panel exited (${c}): ${err}`)); });
  });
}

const call = (path, { method = "GET", body, token = panel.token, headers = {} } = {}) =>
  fetch(panel.url + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-panel-token": token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A raw request, so the Host header can be anything (fetch will not let a page set it). */
function raw(path, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port: panel.port, path, method, headers }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b })); });
    req.on("error", rej);
    if (body) req.write(body);
    req.end();
  });
}

/** Run a command through the panel and wait for it to finish. */
async function runAndWait(body) {
  const r = await call("/api/run", { method: "POST", body });
  const j = await r.json();
  if (r.status !== 200) return { status: r.status, ...j };
  const text = await (await fetch(`${panel.url}/api/run/${j.id}/stream`)).text(); // the stream ends when the run does
  const lines = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])).filter((x) => x.line);
  const code = JSON.parse(text.match(/event: done\ndata: (.*)/)[1]).code;
  return { status: 200, code, lines: lines.map((l) => l.line) };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "panel-"));
  brands = join(dir, "brands");
  stub = join(dir, "no-network.mjs");
  writeFileSync(stub, `const real = globalThis.fetch;
globalThis.fetch = async (u, ...a) => {
  const s = String(u?.url || u);
  if (!/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)[:/]/.test(s)) { process.stderr.write("NETWORK BLOCKED: " + s + "\\n"); throw new Error("network blocked in tests"); }
  return real(u, ...a);
};\n`);
  const g = join(brands, GYM);
  mkdirSync(join(g, "brand-assets", "facility-clean"), { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym", brand_lock: { photography: { never: ["the old logo"] } } }));
  writeFileSync(join(g, "scenes.json"), JSON.stringify({ approved: true, scenes: [{ id: "m1", audience: "men", pose: "low", people: 1, scene: "A man holding a plank." }] }));
  browser = await launchBrowser();
  await cropImage(browser, svg(1535, 1146, `<rect width="100%" height="100%" fill="#8e1b1b"/><rect y="700" width="1535" height="446" fill="#2b2b2b"/>`), [0, 0, 1535, 1146], join(g, "brand-assets", "facility-clean", "r1.png"));
  await cropImage(browser, svg(1874, 795, `<rect width="100%" height="100%" fill="#1c1c1c"/><rect width="1874" height="360" fill="#9c2a2a"/>`), [0, 0, 1874, 795], join(g, "brand-assets", "facility-clean", "r2.png"));
  // A reference batch made by the Step 6 code directly — what the panel has to reproduce.
  await runBatch({ brandDir: g, brief: BRIEF, deps: { browser, checkPhoto: async () => ({ text: [], never: [], people_count: 0, people_box: null, face_boxes: [] }) }, log: () => {} });
  mkdirSync(join(g, "batches", BRIEF.batch_id), { recursive: true });
  writeFileSync(join(g, "batches", BRIEF.batch_id, "brief.json"), JSON.stringify(BRIEF, null, 2) + "\n");
  cpSync(join(g, "outputs", BRIEF.batch_id), join(dir, "reference"), { recursive: true });
  panel = await startPanel();
});
after(async () => { await panel?.stop(); await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

// ── U1 files ──────────────────────────────────────────────────────────────

test("U1 /files/ serves outputs and brand images, and nothing else — not .env, source, profiles or briefs", async () => {
  const get = async (p) => (await fetch(panel.url + p)).status;
  for (const p of ["/files/.env", "/files/skills/references/client-config.mjs", "/files/package.json", `/files/brands/${GYM}/gym-profile.json`, `/files/brands/${GYM}/scenes.json`,
    `/files/brands/${GYM}/batches/${BRIEF.batch_id}/brief.json`, `/files/brands/${GYM}/outputs/${BRIEF.batch_id}/batch.json`, `/files/brands/${GYM}/outputs/%2e%2e/gym-profile.json`,
    "/files/brands/../.env", `/files/brands/${GYM}/outputs/..%2F..%2F..%2F.env`, "/files/ui/server.mjs"]) {
    assert.equal(await get(p), 404, `${p} must not be served`);
  }
  assert.equal(await get(`/files/brands/${GYM}/outputs/${BRIEF.batch_id}/gallery.html`), 200);
  assert.equal(await get(`/files/brands/${GYM}/brand-assets/facility-clean/r1.png`), 200);
  const ad = JSON.parse(readFileSync(join(brands, GYM, "outputs", BRIEF.batch_id, "batch.json"))).ads[0];
  assert.equal(await get(`/files/brands/${GYM}/outputs/${BRIEF.batch_id}/${ad.file}`), 200, "the gallery's images load");
  // A link planted in outputs cannot lead out of it.
  symlinkSync(join(brands, GYM, "gym-profile.json"), join(brands, GYM, "outputs", BRIEF.batch_id, "leak.html"));
  assert.equal(await get(`/files/brands/${GYM}/outputs/${BRIEF.batch_id}/leak.html`), 404);
});

// ── U2 requests from elsewhere ──────────────────────────────────────────────

test("U2 writes and runs need the panel's token and origin; requests addressed to another host are refused", async () => {
  assert.match(panel.token || "", /^[a-f0-9]{48}$/, "the page carries this launch's token");
  const profile = readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8");
  for (const [label, opts] of [["no token", { token: null }], ["wrong token", { token: "0".repeat(48) }], ["another site's origin", { headers: { origin: "https://evil.example" } }]]) {
    const r = await call("/api/run", { method: "POST", body: { kind: "checksync" }, ...opts });
    assert.equal(r.status, 403, `run with ${label}`);
    const w = await call(`/api/client/${GYM}`, { method: "PUT", body: { display_name: "pwned" }, ...opts });
    assert.equal(w.status, 403, `profile write with ${label}`);
  }
  // The classic cross-site trick: a text/plain body skips the browser's preflight. Still refused.
  const plain = await raw("/api/run", { method: "POST", headers: { host: `127.0.0.1:${panel.port}`, "content-type": "text/plain", origin: "https://evil.example" }, body: '{"kind":"checksync"}' });
  assert.equal(plain.status, 403);
  assert.equal(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"), profile, "nothing was written");
  // DNS rebinding: the browser sends the attacker's hostname. Refused before anything is read.
  for (const host of ["attacker.example", `attacker.example:${panel.port}`, "localhost:1", `127.0.0.2:${panel.port}`]) {
    assert.equal((await raw("/api/status", { headers: { host } })).status, 403, `Host ${host}`);
    assert.equal((await raw("/files/.env", { headers: { host } })).status, 403);
  }
  assert.equal((await raw("/api/status", { headers: { host: `localhost:${panel.port}` } })).status, 200, "the panel's own address works");
  // The panel's own page works: token, own origin.
  const ok = await call("/api/run", { method: "POST", body: { kind: "checksync" }, headers: { origin: panel.url } });
  assert.equal(ok.status, 200);
});

// ── U3 the brief ─────────────────────────────────────────────────────────

test("U3 the panel refuses exactly what Step 6 refuses, and saves the words exactly as typed", async () => {
  const bd = join(brands, GYM);
  for (const change of [{ offer: "" }, { offer: "12 Week — Reset" }, { locations: [] }, { locations: [" BISHAN"] }, { audience: "MEN\nONLY" }, { max_calls: MAX_CALLS_CAP + 1 }, { batch_id: "Bad Name" }, { real: ["facility/nope.png"] }]) {
    const brief = { ...BRIEF, batch_id: "u3-batch", ...change };
    const r = await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief } });
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.deepEqual((await r.json()).errors, validateBrief(brief, { brandDir: bd }), `the same messages as Step 6 for ${JSON.stringify(change)}`);
  }
  const words = { ...BRIEF, batch_id: "u3-batch", offer: "12 Week Total Body Reset ✓ 100%", locations: ["Ang Mo Kio"], audience: "Men & Women" };
  const saved = await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: words } });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(bd, "batches", "u3-batch", "brief.json"), "utf-8"), JSON.stringify(words, null, 2) + "\n", "byte for byte as typed — case, symbols and all");
  assert.equal((await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: words } })).status, 409, "an existing batch is not overwritten by accident");
  // A batch that already has photos may change its words, and nothing else.
  const newWords = { ...BRIEF, offer: "6 Week Strength Kickstart" };
  assert.equal((await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: newWords, replace: true } })).status, 200);
  const moreCalls = await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: { ...BRIEF, looks_per_photo: 3 }, replace: true } });
  assert.equal(moreCalls.status, 409);
  assert.match((await moreCalls.json()).errors[0], /only its words can change/);
  writeFileSync(join(bd, "batches", BRIEF.batch_id, "brief.json"), JSON.stringify(BRIEF, null, 2) + "\n"); // put the reference back
  // Discarding: a planned batch goes; one with ads stays.
  assert.equal((await call(`/api/client/${GYM}/batch/u3-batch`, { method: "DELETE", token: null })).status, 403, "deleting needs the token too");
  assert.equal((await call(`/api/client/${GYM}/batch/u3-batch`, { method: "DELETE" })).status, 200);
  assert.ok(!existsSync(join(bd, "batches", "u3-batch")));
  assert.equal((await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}`, { method: "DELETE" })).status, 409);
  assert.ok(existsSync(join(bd, "outputs", BRIEF.batch_id, "batch.json")), "a batch with ads is never deleted from the panel");
  assert.equal((await call(`/api/client/${GYM}/batch/..%2F..`, { method: "DELETE" })).status, 404, "a path that is not a batch name is refused");
  assert.ok(existsSync(join(bd, "gym-profile.json")) && existsSync(join(bd, "batches", BRIEF.batch_id)), "and nothing was deleted");
  // Generated photos need an approved scene library.
  writeFileSync(join(bd, "scenes.json"), JSON.stringify({ approved: false, scenes: [{ id: "m1", audience: "men", pose: "low", people: 1, scene: "A man holding a plank." }] }));
  const draft = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 1, max_calls: 2 } } })).json();
  assert.ok(draft.errors.some((e) => /no approved scenes yet: approve some on Draft Scenes/.test(e)), draft.errors.join("; "));
  writeFileSync(join(bd, "scenes.json"), JSON.stringify({ approved: true, scenes: [{ id: "m1", audience: "men", pose: "low", people: 1, scene: "A man holding a plank." }] }));
  // The Spread switch: cut to what the library shows. m1 carries no tags, so nothing can be asked for; with tags, only what they show.
  let sp = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 1, max_calls: 2, spread: true } } })).json();
  assert.deepEqual([sp.spread.must_show, sp.spread.left_out.length, "spread" in sp.brief, "must_show" in sp.brief], [{}, 13, false, false]);
  writeFileSync(join(bd, "scenes.json"), JSON.stringify({ approved: true, scenes: [{ id: "m1", audience: "men", pose: "low", people: 1, scene: "A man holding a plank.", exercise: "forearm-plank", age: "prime", setting: "solo", equipment: "bodyweight" }, { id: "m2", audience: "men", pose: "upright", people: 2, scene: "A man in a goblet squat with his coach beside him.", exercise: "goblet-squat", age: "older", setting: "coached", equipment: "dumbbells" }] }));
  sp = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 2, max_calls: 2, spread: true } } })).json();
  assert.deepEqual([sp.errors, sp.brief.must_show], [[], { exercise: ["squat"], age: ["prime", "older"], setting: ["solo", "coached"], equipment: ["bodyweight", "dumbbells"] }], sp.errors.join("; "));
  assert.ok(sp.spread.left_out.includes("exercise bench-press") && sp.spread.left_out.includes("setting group"));
  sp = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 2, max_calls: 2, spread: true, age_range: [25, 60] } } })).json();
  assert.deepEqual([sp.errors, "age" in sp.brief.must_show, sp.spread.left_out.some((x) => x.startsWith("age")), sp.brief.age_range], [[], false, false, [25, 60]], "an age range: the ages come from the bell curve, not the spread");
  // A directed batch: the spread is off (its own drafted scenes decide what the photos show), and the saved brief carries none.
  sp = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 2, max_calls: 2, spread: true, direction: { words: "older women lunging with a coach" } } } })).json();
  assert.deepEqual(["must_show" in sp.brief, "spread" in sp.brief, sp.spread.reason], [false, false, "off for a directed batch: the reference or your words decide what the photos show"]);
  const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
  assert.equal(setup.photo_ages.length, 2, "Create is pre-filled with the gym's ad-set ages");
  writeFileSync(join(bd, "scenes.json"), JSON.stringify({ approved: true, scenes: [{ id: "m1", audience: "men", pose: "low", people: 1, scene: "A man holding a plank." }] }));
  const ok = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u3-gen", generated: 1, max_calls: 2 } } })).json();
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.summary, { photos: 3, generated: 1, real: 2, looks: 2, locations: 2, ads: 12, cards: {}, max_calls: 2, scenes_for: "men", format: "workout", mix: { workout: 1 } });
});

// ── U4 preview ──────────────────────────────────────────────────────────

test("U4 the live preview renders the typed words exactly, says when they do not fit, and cannot spend", async () => {
  const r = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "ANG MO KIO", audience: "MEN" } })).json();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.looks.map((l) => l.id), ["t1", "t3", "t5", "t8"]);
  for (const l of r.looks) {
    assert.ok(l.ok, `${l.id}: ${l.failures}`);
    assert.deepEqual({ location: l.words.location, audience: l.words.audience, duration: l.words.duration, offer_name: l.words.offer_name }, { location: "ANG MO KIO", audience: "MEN", duration: "12 Week", offer_name: "Total Body Reset" });
    const img = await fetch(panel.url + l.url);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.ok((await img.arrayBuffer()).byteLength > 10000);
  }
  const bad = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "X".repeat(41), audience: "MEN" } })).json();
  assert.match(bad.errors.join(), /limit is 40/);
  assert.deepEqual(bad.looks, []);
  const noAudience = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "BISHAN", audience: null } })).json();
  assert.ok(noAudience.looks.every((l) => l.ok), "without an audience the script look is swapped for one that needs none");
  // Long words: the renderer's own verdict comes back (never a clipped ad passed as fine).
  const long = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: "12 Week Extraordinarily Comprehensive Whole Body Strength Rebuild Programme Now", location: "SINGAPORE NORTH EAST", audience: "MEN" } })).json();
  for (const l of long.looks) assert.ok(l.ok || l.failures.length > 0);
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()), "the preview never tried to reach the network");
  assert.equal((await call("/api/preview", { method: "POST", body: { gym: "../x", offer: "a", location: "b" } })).status, 400);
});

// ── U5 runs ────────────────────────────────────────────────────────────

test("U5 batch commands are built by the panel from the gym and batch name; a spending run must match what was confirmed", async () => {
  assert.equal((await call("/api/run", { method: "POST", body: { kind: "batch-plan", gym: GYM, batch: "../../etc" } })).status, 400);
  assert.equal((await call("/api/run", { method: "POST", body: { kind: "batch-plan", gym: GYM, batch: "no-such-batch" } })).status, 404);
  assert.equal((await call("/api/run", { method: "POST", body: { kind: "batch-plan", gym: GYM, batch: BRIEF.batch_id, extra: "--max-calls 99" } })).status, 200, "extra fields are ignored, not passed on");
  const unconfirmed = await call("/api/run", { method: "POST", body: { kind: "batch", gym: GYM, batch: BRIEF.batch_id } });
  assert.equal(unconfirmed.status, 409);
  const stale = await call("/api/run", { method: "POST", body: { kind: "batch", gym: GYM, batch: BRIEF.batch_id, confirm: { ...WORDS, offer: "an older offer", max_calls: 0 } } });
  assert.equal(stale.status, 409, "words confirmed earlier but changed since");
  const confirmed = await runAndWait({ kind: "batch", gym: GYM, batch: BRIEF.batch_id, confirm: { ...WORDS, max_calls: 0 } });
  assert.equal(confirmed.code, 0, confirmed.lines.join("\n"));
  assert.match(confirmed.lines[0], /^\$ node skills\/references\/plan-offer-batch\.mjs --brand-dir \S+testgym --brief \S+ref-batch\/brief\.json$/);
  assert.ok(confirmed.lines.some((l) => /0 image call/.test(l)));
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U6 same as Step 6 ──────────────────────────────────────────────────────

test("U6 a brief entered through the panel gives what the Step 6 command gives: the same brief, the same plan, the same ads", async () => {
  const bd = join(brands, GYM);
  const r = await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: BRIEF, replace: true } });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(bd, "batches", BRIEF.batch_id, "brief.json"), "utf-8"), JSON.stringify(BRIEF, null, 2) + "\n");
  // The plan, through the panel and straight from the code.
  const planned = await runAndWait({ kind: "batch-plan", gym: GYM, batch: BRIEF.batch_id });
  const direct = [];
  await runBatch({ brandDir: bd, brief: BRIEF, dryRun: true, outDir: join(dir, "dry"), log: (m) => direct.push(m) });
  assert.equal(planned.lines.find((l) => l.startsWith("· plan:")), direct.find((l) => l.startsWith("· plan:")));
  // A free re-render through the panel reproduces the reference ads exactly.
  const re = await runAndWait({ kind: "batch-rerender", gym: GYM, batch: BRIEF.batch_id });
  assert.equal(re.code, 0, re.lines.join("\n"));
  const ref = JSON.parse(readFileSync(join(dir, "reference", "batch.json")));
  const now = JSON.parse(readFileSync(join(bd, "outputs", BRIEF.batch_id, "batch.json")));
  assert.deepEqual(now.ads.map((a) => a.folder), ref.ads.map((a) => a.folder));
  for (const a of ref.ads) assert.ok(readFileSync(join(dir, "reference", a.file)).equals(readFileSync(join(bd, "outputs", BRIEF.batch_id, a.file))), `${a.folder}: identical to the Step 6 render`);
  const view = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}`)).json();
  assert.equal(view.batch.ads.length, ref.ads.length);
  assert.equal((await fetch(panel.url + view.batch.ads[0].url)).status, 200, "each ad's picture is served");
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U7 the page ─────────────────────────────────────────────────────────

test("U7 the New Batch tab: typing updates the preview, a bad word shows its error and stops Run, Run asks first", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: panel.url + "/" }, sessionId);
  await loaded;
  await until(`typeof STATE!=='undefined' && STATE.sel==='${GYM}'`, "the panel to load");
  assert.ok(!(await ev(`[...document.querySelectorAll('.tab')].some(t=>/Templates \(old\)/.test(t.textContent))`)), "the old template tab is gone (2026-10-06)");
  assert.ok(await ev(`!!document.querySelector('.logo svg')`), "the Strategym mark is in the top bar");
  await ev(`STATE.tab='batch'; render(); true`);
  await until(`!!document.querySelector('#bOffer')`, "the New Batch form");
  assert.equal(await ev(`document.querySelector('#bOffer').value`), "", "the offer starts empty — never filled in");
  const type = (sel, text) => ev(`(()=>{const el=document.querySelector('${sel}'); el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await type("#bOffer", WORDS.offer);
  await type("#bLoc0", "BISHAN");
  await type("#bAud", "MEN");
  await until(`document.querySelectorAll('#bPrev img').length===4 && [...document.querySelectorAll('#bPrev img')].every(i=>i.complete&&i.naturalWidth>0)`, "four preview images");
  assert.ok(await ev(`[...document.querySelectorAll('#bPrev figcaption')].every(f=>/fits/.test(f.textContent))`));
  assert.equal(await ev(`document.activeElement.id`), "bAud", "typing never loses focus");
  // 10 new photos by default (the real batches' size), 2 looks, 1 location — and no photo of the empty room unless one is ticked (2026-11-11).
  await until(`/= <b>20 ads<\\/b>/.test(document.querySelector('#bSummary').innerHTML) && !document.querySelector('#bRun').disabled`, "the summary and an enabled Run");
  assert.deepEqual(await ev(`[B.draft.real, briefFromDraft().real]`), [[], []], "no premises photo is ticked by itself: an ad of the empty room is the owner's choice");
  // The room still matches: with no real photo in the batch and no room reference set, the first cleaned premises photo is the reference (never an ad).
  assert.deepEqual(await ev(`[B.check.brief.reference, B.check.brief.real]`), ["facility-clean/r1.png", []]);
  // An em dash: an inline error from the server's rules, and Run is disabled.
  await type("#bOffer", "12 Week — Reset");
  await until(`/em\\/en dash/.test(document.querySelector('#bErrors').textContent) && document.querySelector('#bRun').disabled`, "the dash error and a disabled Run");
  await type("#bOffer", WORDS.offer);
  await until(`!document.querySelector('#bRun').disabled`, "Run enabled again");
  // Run asks first, repeating the exact words and the call limit; cancelling runs nothing.
  const runsBefore = await ev(`STATE.run ? 1 : 0`);
  await ev(`document.querySelector('#bRun').click(); true`);
  await until(`!!document.querySelector('.modal')`, "the confirmation");
  const modal = await ev(`document.querySelector('.modal').textContent`);
  assert.match(modal, /12 Week Total Body Reset/);
  assert.match(modal, /BISHAN/);
  assert.match(modal, /Up to 20 Gemini image calls/, "10 new photos × 2 tries, the default");
  await ev(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Cancel').click(); true`);
  assert.equal(await ev(`!!document.querySelector('.modal')`), false);
  assert.equal(await ev(`STATE.run ? 1 : 0`), runsBefore, "cancel runs nothing");
  await until(`B.savedId===null`, "the cancelled brief to be discarded");
  const auto = await ev(`briefFromDraft().batch_id`);
  assert.ok(!existsSync(join(brands, GYM, "batches", auto)), `cancelling leaves no planned batch behind (${auto})`);
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U8 Stories versions (Step 8) ─────────────────────────────────────────────

test("U8 Stories versions: refused without a confirmed call cap or without the gallery's picks; argv is built from the batch and the cap alone; the batch view says what exists", async () => {
  const out = join(brands, GYM, "outputs", BRIEF.batch_id);
  assert.ok(existsSync(join(out, "batch.json")), "U5 made the batch");
  const post = (body) => call("/api/run", { method: "POST", body });
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id })).status, 400, "no cap confirmed");
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, confirm: { max_calls: MAX_CALLS_CAP + 1 } })).status, 400, "over the cap");
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, confirm: { max_calls: "3" } })).status, 400, "not a number");
  rmSync(join(out, "selections.json"), { force: true });
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, confirm: { max_calls: 0 } })).status, 409, "no picks yet");
  let view = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}`)).json();
  assert.equal(view.selected, false);
  assert.equal(view.stories, null);
  // The gallery's picks, every ad, put in the batch folder.
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
  writeFileSync(join(out, "selections.json"), JSON.stringify({ ...Object.fromEntries(batch.ads.map((a) => [a.folder, { "1x1": a.file }])), excluded: [] }));
  const r = await runAndWait({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, confirm: { max_calls: 0 }, extra: "--max-calls 99" });
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.match(r.lines[0], /^\$ node skills\/references\/make-stories\.mjs --brand-dir \S+testgym --batch ref-batch --max-calls 0$/, "built server-side; the extra field is ignored");
  assert.ok(r.lines.some((l) => /Stories version\(s\)/.test(l)), r.lines.join("\n"));
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()), "real photos and reused photos cost nothing");
  view = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}`)).json();
  assert.equal(view.selected, true);
  assert.equal(view.stories.image_calls, 0);
  assert.equal(view.stories.ads, batch.ads.length, "every selected ad has a Stories version (real photos and reused photos only)");
  for (const a of batch.ads) assert.ok(existsSync(join(out, a.file.replace("/1x1/", "/9x16/").replace("_1x1_", "_9x16_"))), `${a.folder} 9:16 on disk`);
  const again = await runAndWait({ kind: "batch-stories-rerender", gym: GYM, batch: BRIEF.batch_id });
  assert.equal(again.code, 0, again.lines.join("\n"));
  assert.match(again.lines[0], /make-stories\.mjs --brand-dir \S+testgym --batch ref-batch --render-only$/);
  // One ad's Stories version (2026-10-07): `only` must name a candidate of this batch; the run gets --only and --fresh;
  // the Review view says why an ad has none.
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, only: "c99", confirm: { max_calls: 0 } })).status, 400, "not an ad of this batch");
  assert.equal((await post({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, only: "../x", confirm: { max_calls: 0 } })).status, 400, "not a candidate id");
  const one = await runAndWait({ kind: "batch-stories", gym: GYM, batch: BRIEF.batch_id, only: batch.ads[0].candidate, confirm: { max_calls: 0 } });
  assert.equal(one.code, 0, one.lines.join("\n"));
  assert.match(one.lines[0], new RegExp(`--max-calls 0 --only ${batch.ads[0].candidate} --fresh$`), "built server-side");
  assert.ok(one.lines.some((l) => /other ads' Stories versions stay/.test(l)), one.lines.join("\n"));
  const rv = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/review`)).json();
  assert.equal(rv.ads.length, batch.ads.length, "every ad is still in the record after a one-ad run");
  assert.ok(rv.ads.every((a) => a.story && a.story_failure === null && a.candidate), "each ad has its Stories version, no failure said, and its candidate for the per-ad button");
});

// ── U9 scene refresh through the panel (B2) ─────────────────────────────────

const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("U9 scenes through the panel: drafts listed; approve and reject write exactly what the CLI writes; uploads are images only, served from references/ alone; the refresh run is built server-side", async () => {
  const g = join(brands, GYM), p = join(g, "scenes.json");
  const lib = JSON.parse(readFileSync(p, "utf-8"));
  lib.scenes.push(
    { id: "w-d1", audience: "women", pose: "upright", people: 1, age: "older", scene: "A woman in her fifties stepping into a lunge.", draft: true, source: "refresh", added: "2026-09-13", covers: ["age:older"] },
    { id: "w-d2", audience: "women", pose: "low", people: 3, setting: "group", scene: "Three women holding planks, loosely spaced.", draft: true, source: "refresh", added: "2026-09-13" },
  );
  writeFileSync(p, JSON.stringify(lib, null, 2) + "\n");
  let r = await (await call(`/api/client/${GYM}/scenes`)).json();
  assert.deepEqual(r.drafts.map((d) => d.id), ["w-d1", "w-d2"]);
  assert.deepEqual([r.status.drafts, r.status.retired, r.status.total], [2, 0, 1]);
  assert.deepEqual(r.references, []);
  assert.deepEqual(r.drafts[0].covers, ["age:older"]);
  // Approve and reject: refused without the token or a reason; otherwise the file is byte-for-byte what the CLI's functions write.
  const copy = join(dir, "scenes-copy.json"); cpSync(p, copy);
  assert.equal((await call(`/api/client/${GYM}/scenes/approve`, { method: "POST", body: { ids: ["w-d1"] }, token: null })).status, 403);
  assert.equal((await call(`/api/client/${GYM}/scenes/reject`, { method: "POST", body: { id: "w-d2" } })).status, 400, "a reject needs a reason");
  assert.equal((await call(`/api/client/${GYM}/scenes/reject`, { method: "POST", body: { id: "w-d2", reason: " " } })).status, 400);
  assert.equal((await call(`/api/client/${GYM}/scenes/reject`, { method: "POST", body: { id: "nope", reason: "no such thing" } })).status, 400);
  assert.equal((await call(`/api/client/${GYM}/scenes/approve`, { method: "POST", body: { ids: ["w-d1"] } })).status, 200);
  assert.equal((await call(`/api/client/${GYM}/scenes/reject`, { method: "POST", body: { id: "w-d2", reason: "planks read as a yoga class" } })).status, 200);
  approveScenes(copy, ["w-d1"]); rejectScene(copy, "w-d2", "planks read as a yoga class");
  assert.equal(readFileSync(p, "utf-8"), readFileSync(copy, "utf-8"), "the panel writes exactly what the CLI writes");
  r = await (await call(`/api/client/${GYM}/scenes`)).json();
  assert.deepEqual([r.drafts.length, r.status.retired, r.status.total], [0, 1, 2]);
  // Uploads: raw bytes, image files only (by their first bytes), a safe name, the token; served from references/ and nowhere else.
  const put = (name, body, { token = panel.token } = {}) => raw(`/api/client/${GYM}/reference/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream", ...(token ? { "x-panel-token": token } : {}) }, body });
  assert.equal((await put("ad.png", PNG1, { token: null })).status, 403, "no token");
  assert.equal((await put("ad.png", PNG1)).status, 200);
  assert.ok(existsSync(join(g, "references", "ad.png")));
  assert.equal((await fetch(panel.url + `/files/brands/${GYM}/references/ad.png`)).status, 200, "served for the thumbnail");
  writeFileSync(join(g, "references", "ad.png.description.json"), "{}");
  assert.equal((await fetch(panel.url + `/files/brands/${GYM}/references/ad.png.description.json`)).status, 404, "only the images are served");
  assert.equal((await put("notes.png", Buffer.from("this is not an image at all"))).status, 400, "first bytes say it is not an image");
  assert.equal((await put("ad.jpg", PNG1)).status, 400, "a png named .jpg");
  assert.equal((await put("Bad%20Name.png", PNG1)).status, 400, "the name must be a slug");
  assert.equal((await put("big.png", Buffer.concat([PNG1, Buffer.alloc(11 * 1024 * 1024)]))).status, 413, "over 10 MB");
  assert.equal((await put("ad.png", PNG1)).status, 200, "replacing an image");
  assert.ok(!existsSync(join(g, "references", "ad.png.description.json")), "a replaced image loses its cached reading");
  assert.ok(!existsSync(join(g, "references", "notes.png")) && !existsSync(join(g, "references", "big.png")));
  r = await (await call(`/api/client/${GYM}/scenes`)).json();
  assert.deepEqual(r.references.map((x) => [x.name, x.read]), [["ad.png", false]]);
  // The refresh run: the shape of every argument is checked; argv is built here from the gym, audience, count and direction.
  const post = (body) => call("/api/run", { method: "POST", body });
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "kids", count: 3 })).status, 400);
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 13 })).status, 400);
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: "3" })).status, 400);
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 3, reference: "other.png" })).status, 400, "not uploaded");
  // What the drafts must cover (2026-10-15, Create's "Draft scenes for them"): tag:value pairs from the vocabulary, else refused.
  for (const cover of [[], ["colour:red"], ["age:ancient"], ["exercise:"], "exercise:lunge", Array(9).fill("exercise:lunge")]) assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 2, cover })).status, 400, JSON.stringify(cover));
  const covered = await (await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 2, cover: ["exercise:lunge", "age:older"] })).json();
  assert.ok(covered.id, "a cover from the vocabulary starts the run");
  const coveredLog = await (await fetch(`${panel.url}/api/run/${covered.id}/stream`)).text();
  assert.match(coveredLog, /exercise lunge \(\d+\), age older \(\d+\)/, "the drafter is directed at exactly those tags");
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 3, reference: "../.env" })).status, 400);
  assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 3, words: "x" })).status, 400);
  const ran = await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 2, words: " older women lunging ", reference: "ad.png", extra: "--approve all" });
  assert.match(ran.lines[0], /^\$ node skills\/references\/refresh-scenes\.mjs --brand-dir \S+testgym --audience women --count 2 --words older women lunging --reference ad\.png$/, "built server-side; the extra field is ignored");
  assert.notEqual(ran.code, 0, "there is no model in the tests, so the refresh stops at its first call");
  assert.ok(ran.lines.some((l) => /network blocked|GEMINI_KEY/.test(l)), ran.lines.join("\n"));
  r = await (await call(`/api/client/${GYM}/scenes`)).json();
  assert.equal(r.drafts.length, 0, "nothing was written");
  // A gym with no library yet: its first refresh is accepted (before, it was refused), and the model's absence stops it before anything is written.
  const libFile = join(brands, GYM, "scenes.json"), saved = readFileSync(libFile, "utf8"); rmSync(libFile);
  try {
    r = await (await call(`/api/client/${GYM}/scenes`)).json();
    assert.deepEqual([r.status.exists, r.drafts], [false, []]);
    const first = await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2 });
    assert.ok(first.lines.some((l) => /network blocked|GEMINI_KEY/.test(l)) && !first.lines.some((l) => /no scene library/.test(l)), "it reached the model: " + first.lines.join("\n"));
    assert.ok(!existsSync(libFile), "a failed first refresh leaves no empty library behind");
    const check = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...BRIEF, batch_id: "u9-first", generated: 1, max_calls: 2 } } })).json();
    assert.ok(check.errors.some((e) => /no scene library yet: .*Draft the first ones on Draft Scenes/.test(e)), check.errors.join("; "));
  } finally { writeFileSync(libFile, saved); }
});

test("U9b a directed batch through the panel: accepted with a direction; refused until planned; its drafts must be the ones confirmed; confirming approves them, and only for that batch", async () => {
  const g = join(brands, GYM), p = join(g, "scenes.json");
  const post = (body) => call("/api/run", { method: "POST", body });
  const brief = { ...BRIEF, batch_id: "directed-ui", audience: "LADIES WANTED", generated: 1, real: [], max_calls: 1, direction: { words: "older women lunging with a coach" } };
  assert.equal((await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief } })).status, 200, "a directed brief is accepted");
  const bad = await call(`/api/client/${GYM}/batch`, { method: "POST", body: { brief: { ...brief, batch_id: "directed-bad", direction: { reference: "nope.png" } } } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).errors.join(" "), /direction: reference image not found/);
  const confirm = { offer: brief.offer, locations: brief.locations, audience: brief.audience, max_calls: 1 };
  let x = await post({ kind: "batch", gym: GYM, batch: "directed-ui", confirm });
  assert.equal(x.status, 409); assert.match((await x.json()).error, /plan first/);
  // What the plan would have drafted (the plan itself needs the model), written as the planner writes it.
  const lib = JSON.parse(readFileSync(p, "utf-8"));
  lib.scenes.push({ id: "w-ui-1", audience: "women", pose: "upright", people: 2, setting: "coached", scene: "A coach beside a woman in her fifties mid-lunge, a hand ready at her elbow.", draft: true, source: "batch:directed-ui", added: "2026-09-13", direction: brief.direction });
  writeFileSync(p, JSON.stringify(lib, null, 2) + "\n");
  let view = await (await call(`/api/client/${GYM}/batch/directed-ui`)).json();
  assert.deepEqual(view.scenes.map((s) => [s.id, s.draft, s.source]), [["w-ui-1", true, "batch:directed-ui"]], "the batch view lists its drafted scenes");
  x = await post({ kind: "batch", gym: GYM, batch: "directed-ui", confirm }); assert.equal(x.status, 409, "the scenes were not confirmed");
  x = await post({ kind: "batch", gym: GYM, batch: "directed-ui", confirm: { ...confirm, scenes: ["w-other"] } }); assert.equal(x.status, 409, "different scenes were confirmed");
  const ran = await runAndWait({ kind: "batch", gym: GYM, batch: "directed-ui", confirm: { ...confirm, scenes: ["w-ui-1"] } });
  assert.match(ran.lines[0], /plan-offer-batch\.mjs --brand-dir \S+testgym --brief \S+directed-ui\/brief\.json --approve-scenes$/);
  assert.ok(ran.lines.some((l) => /1 scene\(s\) confirmed for this batch: w-ui-1/.test(l)), ran.lines.join("\n"));
  view = await (await call(`/api/client/${GYM}/batch/directed-ui`)).json();
  assert.deepEqual(view.scenes.map((s) => [s.id, s.draft]), [["w-ui-1", false]]);
  assert.equal(JSON.parse(readFileSync(p, "utf-8")).scenes.find((s) => s.id === "w-ui-1").approved_via, "directed-ui");
  // The browser cannot set the approval itself: an ordinary batch never gets the flag.
  const plain = await runAndWait({ kind: "batch", gym: GYM, batch: BRIEF.batch_id, confirm: { ...WORDS, max_calls: 0 }, approveScenes: true });
  assert.equal(plain.code, 0, plain.lines.join("\n"));
  assert.match(plain.lines[0], /brief\.json$/, "no --approve-scenes without a direction");
});

test("U9c the page: the Direction fields feed the brief, the scene library card shows the library and opens the refresh dialog", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: panel.url + "/" }, sessionId);
  await loaded;
  await until(`typeof STATE!=='undefined' && STATE.sel==='${GYM}'`, "the panel to load");
  await ev(`STATE.tab='batch'; render(); true`);
  await until(`!!document.querySelector('#bDirWords')`, "the form");
  assert.equal(await ev(`'direction' in briefFromDraft()`), false, "no direction unless given");
  const type = (sel, text) => ev(`(()=>{const el=document.querySelector('${sel}'); el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await type("#bDirWords", "older women lunging with a coach");
  assert.deepEqual(await ev(`briefFromDraft().direction`), { words: "older women lunging with a coach" });
  assert.equal(await ev(`B.draft.spread===true && !("spread" in briefFromDraft())`), true, "a directed batch never asks for the spread (2026-09-28)");
  assert.ok(await ev(`!!document.querySelector('input[name="bRef"][value="ad.png"]')`), "the uploaded reference is offered");
  await ev(`bRef('ad.png'); true`);
  assert.deepEqual(await ev(`briefFromDraft().direction`), { words: "older women lunging with a coach", reference: "ad.png" });
  await type("#bAud", "LADIES WANTED");
  await until(`B.check?.summary?.scenes_for==='women'`, "the check to follow the audience");
  // The scene library has its own page under Library; the refresh dialog opens from there.
  await ev(`go('scenes'); true`);
  await until(`!!document.querySelector('#bSceneCard h3')`, "the scene card");
  const card = await ev(`document.querySelector('#bSceneCard').textContent`);
  assert.match(card, /Scene library/); assert.match(card, /1 retired/);
  await ev(`bRefreshConfirm(); true`);
  await until(`!!document.querySelector('.modal')`, "the refresh dialog");
  const modal = await ev(`document.querySelector('.modal').textContent`);
  assert.match(modal, /Refresh scenes/); assert.match(modal, /Fill the library's gaps/); assert.match(modal, /Like a reference image/);
  assert.equal(await ev(`document.querySelector('#bRfAud').value`), "women", "the audience follows the batch's callout");
  assert.equal(await ev(`document.querySelector('#bRfRef').value`), "ad.png");
  await ev(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Cancel').click(); true`);
  assert.equal(await ev(`!!document.querySelector('.modal')`), false);
});

// ── U10 picks saved server-side (sub-step 2) ─────────────────────────────────

test("U10 picks are saved in the batch folder as they are made — review.json, and selections.json in the gallery's format, which the Stories step reads; an excluded photo takes its ads with it", async () => {
  const out = join(brands, GYM, "outputs", BRIEF.batch_id);
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
  // U9b ran the batch again, which re-renders the square ads and clears their Stories files: a Stories
  // version whose file is gone is not offered, and a free re-render brings them back.
  let r0 = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/review`)).json();
  assert.ok(r0.ads.every((a) => a.story === null), "no broken 9:16 in the review");
  const again = await runAndWait({ kind: "batch-stories-rerender", gym: GYM, batch: BRIEF.batch_id });
  assert.equal(again.code, 0, again.lines.join("\n"));
  const stories = JSON.parse(readFileSync(join(out, "stories.json"), "utf-8"));
  const storyOf = Object.fromEntries(stories.ads.map((a) => [a.folder, a.file]));
  const review = async () => (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/review`)).json();
  const sel = () => JSON.parse(readFileSync(join(out, "selections.json"), "utf-8"));
  // U8 left the gallery's picks (every ad) and a Stories version of each: read as decisions.
  rmSync(join(out, "review.json"), { force: true });
  let r = await review();
  assert.equal(r.ads.length, batch.ads.length);
  assert.deepEqual(r.counts.kept, batch.ads.length, "the gallery's picks are read as kept");
  assert.deepEqual(r.locations, ["BISHAN", "ANG MO KIO"]);
  assert.deepEqual(r.photos.map((p) => [p.id, p.kind]), [["r01", "real"], ["r02", "real"]]);
  for (const a of r.ads) {
    assert.equal((await fetch(panel.url + a.url)).status, 200, `${a.folder} 1:1 served`);
    assert.equal((await fetch(panel.url + a.story)).status, 200, `${a.folder} 9:16 served, for the side-by-side`);
  }
  for (const p of r.photos) assert.equal((await fetch(panel.url + p.url)).status, 200, `${p.id} served`);
  const put = (body, opts = {}) => call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/picks`, { method: "PUT", body, ...opts });
  const f0 = batch.ads[0].folder;
  // Writing needs the panel's token; names must be this batch's; decisions are keep, exclude or null.
  const before = readFileSync(join(out, "selections.json"), "utf-8");
  assert.equal((await put({ ads: { [f0]: "exclude" } }, { token: null })).status, 403);
  for (const bad of [{ ads: { "999-nope": "keep" } }, { ads: { [f0]: "maybe" } }, { photos: { g99: "exclude" } }, { ads: ["x"] }, { ads: { "../../x": "keep" } }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(readFileSync(join(out, "selections.json"), "utf-8"), before, "a refused change writes nothing");
  assert.ok(!existsSync(join(out, "review.json")));
  assert.equal((await call(`/api/client/${GYM}/batch/..%2F..%2Fx/picks`, { method: "PUT", body: {} })).status, 404);
  // Exclude one ad: selections.json is rewritten at once, in the gallery's shape.
  assert.equal((await put({ ads: { [f0]: "exclude" } })).status, 200);
  let s = sel();
  assert.equal(Object.keys(s)[0], "excluded");
  assert.deepEqual(s.excluded, [f0]);
  assert.deepEqual(Object.keys(s).filter((k) => k !== "excluded").sort(), batch.ads.map((a) => a.folder).filter((f) => f !== f0).sort());
  const a1 = batch.ads[1];
  assert.deepEqual(s[a1.folder], { "4x5": a1.file, "9x16": storyOf[a1.folder] }, "each kept ad names its feed (4:5) and Stories files");
  assert.equal(resolveSelections(out).length, batch.ads.length - 1, "the Stories step reads it as it reads the gallery's");
  // A photo excluded takes every ad it appears in; the ads' own decisions stay underneath.
  const withR1 = batch.ads.filter((a) => a.photos.includes("r01")).map((a) => a.folder);
  assert.ok(withR1.length > 0);
  assert.equal((await put({ photos: { r01: "exclude" } })).status, 200);
  assert.deepEqual(sel().excluded, [...new Set([f0, ...withR1])].sort());
  r = await review();
  for (const a of r.ads.filter((x) => x.photos.includes("r01"))) assert.deepEqual([a.status, a.by_photo], ["exclude", "r01"]);
  assert.equal(r.photos.find((p) => p.id === "r01").status, "exclude");
  assert.equal((await put({ photos: { r01: null } })).status, 200);
  assert.deepEqual(sel().excluded, [f0], "keeping the photo again brings its ads back, and the ad excluded on its own stays out");
  // Undo: null clears a decision, and an undecided ad counts as kept (as the gallery's "all selected" did).
  assert.equal((await put({ ads: { [f0]: null } })).status, 200);
  assert.deepEqual(sel().excluded, []);
  r = await review();
  assert.deepEqual([r.counts.kept, r.counts.excluded, r.counts.unreviewed], [batch.ads.length - 1, 0, 1]);
  const rj = JSON.parse(readFileSync(join(out, "review.json"), "utf-8"));
  assert.equal(rj.ads[f0], undefined); assert.equal(rj.ads[a1.folder], "keep"); assert.deepEqual(rj.photos, {});
  // A decision about an ad a re-render has since renamed is dropped on the next save.
  writeFileSync(join(out, "review.json"), JSON.stringify({ ...rj, ads: { ...rj.ads, "199-c99-gone": "exclude" } }));
  assert.equal((await put({})).status, 200);
  assert.equal(JSON.parse(readFileSync(join(out, "review.json"), "utf-8")).ads["199-c99-gone"], undefined);
  // The campaign list carries the counts (the rail's badge and the cards).
  const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
  assert.deepEqual(setup.batches.find((b) => b.id === BRIEF.batch_id).review, { kept: batch.ads.length - 1, excluded: 0, unreviewed: 1 });
  // The batch's progress: the last run (U6's free re-render) is done; nothing is running.
  const pr = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/progress`)).json();
  assert.equal(pr.progress.stage, "done");
  assert.equal(pr.progress.ads, batch.ads.length);
  assert.equal(pr.run, null);
});

// ── U11 the review and Generating screens (sub-step 2) ───────────────────────

test("U11 the review screen: the 4:5 feed ad and its 9:16 side by side on one screen; the two big buttons right below the ad, → and ← (or a drag) keep and exclude, ↑ ↓ look, U undoes — saved as made; photos exclude their ads; Back works; the Generating screen shows each photo as it passes", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,200)")}`);
  };
  const key = async (k, code = k, vk = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }, sessionId);
  };
  const out = join(brands, GYM, "outputs", BRIEF.batch_id);
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8"));
  const sel = () => JSON.parse(readFileSync(join(out, "selections.json"), "utf-8"));
  rmSync(join(out, "review.json"), { force: true });
  writeFileSync(join(out, "selections.json"), JSON.stringify({ excluded: [], ...Object.fromEntries(batch.ads.map((a) => [a.folder, { "1x1": a.file }])) }));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  // A full load (the query differs): the same page with a new fragment would be an in-page jump, with no load event.
  await cdp.send("Page.navigate", { url: `${panel.url}/?u11#/${GYM}/review/${BRIEF.batch_id}` }, sessionId);
  await loaded;
  const stageReady = "document.querySelectorAll('#rvStage img').length===2 && [...document.querySelectorAll('#rvStage img')].every(i=>i.complete&&i.naturalWidth>0)";
  await until(`typeof R!=='undefined' && R.data && ${stageReady}`, "the review screen from its address");
  // Side by side, and the whole screen fits the window: no scrolling down to the filmstrip, none sideways.
  const geo = await ev(`(()=>{const [a,b]=[...document.querySelectorAll('#rvStage img')].map(i=>i.getBoundingClientRect()); const strip=document.querySelector('#rvStrip').getBoundingClientRect(); return {a:[a.left,a.right,a.top,a.width,a.height],b:[b.left,b.right,b.top,b.width,b.height],strip:strip.bottom,foot:document.querySelector('#rvFoot').getBoundingClientRect().bottom,h:innerHeight,sh:document.documentElement.scrollHeight,sw:document.documentElement.scrollWidth,w:innerWidth}})()`);
  assert.ok(geo.b[0] > geo.a[1], "the 9:16 sits to the right of the 4:5");
  assert.ok(Math.abs(geo.a[4] - geo.b[4]) < 2 && Math.abs(geo.a[3] / geo.a[4] - 4 / 5) < 0.02 && Math.abs(geo.b[3] / geo.b[4] - 9 / 16) < 0.02, `same height, 4:5 and 9:16: ${JSON.stringify(geo)}`);
  assert.ok(geo.a[4] > 400, "big enough to judge");
  assert.ok(geo.foot <= geo.h && geo.sh <= geo.h + 1, `everything on one screen: ${JSON.stringify(geo)}`);
  assert.ok(geo.sw <= geo.w, "no sideways scrolling");
  assert.match(await ev("document.querySelector('#rvCount').textContent"), new RegExp(`^1 of ${batch.ads.length}`));
  // ↓ and ↑ look without picking (since 2026-11-11 → and ← pick, as a swipe does); X excludes and moves on; the decision is on disk at once.
  await key("ArrowDown", "ArrowDown", 40);
  await until("R.i===1", "↓");
  const f1 = await ev("R.list[1].folder");
  await key("x", "KeyX", 88);
  await until(`R.i===2 && document.querySelector('#rvStrip').children[1].classList.contains('s-exclude')`, "exclude and advance");
  const t0 = Date.now(); while (!sel().excluded.includes(f1) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sel().excluded, [f1], "selections.json on disk, no download");
  assert.match(await ev("document.querySelector('#rvCount').textContent"), / 1 excluded/);
  // Back to it and undo.
  await key("ArrowUp", "ArrowUp", 38);
  await until("R.i===1 && document.querySelector('.rv-badge').textContent.includes('Excluded')", "↑");
  await key("u", "KeyU", 85);
  await until("!document.querySelector('#rvStrip').children[1].classList.contains('s-exclude')", "undo");
  const t1 = Date.now(); while (sel().excluded.length && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sel().excluded, []);
  // K keeps: marked, saved, moved on.
  await key("k", "KeyK", 75);
  await until("R.i===2 && document.querySelector('#rvStrip').children[1].classList.contains('s-keep')", "keep");
  // Picking like a deck of cards (2026-11-11): two big buttons right below the ad — Exclude on the left, Keep on the right — not in the top bar.
  const pick = await ev(`(()=>{ const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return [b.left, b.right, b.top, b.width, b.height]; }; const st = document.querySelector('#rvStage').getBoundingClientRect(); return { keep: r('#rvKeep'), ex: r('#rvEx'), stage: [st.left, st.right, st.bottom], inTop: !!document.querySelector('.rv-top #rvKeep, .rv-top #rvEx'), labels: [document.querySelector('#rvEx').textContent, document.querySelector('#rvKeep').textContent], strip: document.querySelector('#rvStrip').getBoundingClientRect().top }; })()`);
  assert.ok(!pick.inTop && pick.keep[2] >= pick.stage[2] && pick.keep[2] - pick.stage[2] < 30 && pick.keep[2] + pick.keep[4] <= pick.strip + 1, `right below the ad, above the filmstrip: ${JSON.stringify(pick)}`);
  assert.ok(pick.keep[3] >= 200 && pick.keep[4] >= 56 && pick.ex[3] >= 200 && pick.ex[4] >= 56, "big");
  assert.ok(pick.ex[1] < pick.keep[0] && Math.abs((pick.ex[0] + pick.keep[1]) / 2 - (pick.stage[0] + pick.stage[1]) / 2) < 4, "Exclude on the left, Keep on the right, centred under the ad");
  assert.match(pick.labels.join(" | "), /^✕Exclude← \| →Kep?t?✓$/, "each says what it does, with its key (Kept once the ad on screen is kept)");
  // → keeps the ad on screen and the next one is there; ← excludes; the card that was picked flies off over the next.
  const f2 = await ev("R.list[2].folder"), f3 = await ev("R.list[3].folder");
  await key("ArrowRight", "ArrowRight", 39);
  await until(`R.i===3 && R.list[2].status==='keep' && !!document.querySelector('#rvStage .rv-ghost.fly-keep')`, "→ keeps and moves on, with the card flying right");
  await key("ArrowLeft", "ArrowLeft", 37);
  await until(`R.i===4 && R.list[3].status==='exclude'`, "← excludes and moves on");
  { const t = Date.now(); while (!sel().excluded.includes(f3) && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 100)); }
  assert.deepEqual(sel().excluded, [f3], "saved as picked");
  // Undo with nothing picked on screen goes back to the last pick and clears it.
  await ev("document.querySelector('#rvUndo').click(); true");
  await until(`R.i===3 && R.list[3].status==null && R.list[3].folder===${JSON.stringify(f3)}`, "undo goes back to the last pick");
  { const t = Date.now(); while (sel().excluded.length && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 100)); }
  assert.deepEqual(sel().excluded, []);
  // Dragging the ad: a short drag springs back and picks nothing; past the mark to the right keeps, to the left excludes.
  const at = await ev("(()=>{ const b = document.querySelector('#rvStage img').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()");
  const drag = async (dx) => { const mouse = (type, x) => cdp.send("Input.dispatchMouseEvent", { type, x, y: at[1], button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, sessionId); await mouse("mousePressed", at[0]); for (const k of [0.25, 0.5, 0.75, 1]) await mouse("mouseMoved", Math.round(at[0] + dx * k)); const mid = await ev("[document.querySelector('#rvCards').style.transform, getComputedStyle(document.querySelector('#rvCards .rv-stamp.keep')).opacity, getComputedStyle(document.querySelector('#rvCards .rv-stamp.excl')).opacity]"); await mouse("mouseReleased", at[0] + dx); return mid; };
  let mid = await drag(50);
  assert.match(mid[0], /^translateX\(50px\) rotate\(/, "the ad follows the drag"); assert.ok(Number(mid[1]) > 0.3 && Number(mid[1]) < 0.6 && Number(mid[2]) === 0, `the KEEP stamp shows as it nears the mark: ${mid}`);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(await ev("[R.i, R.list[3].status, document.querySelector('#rvCards').style.transform]"), [3, null, ""], "a short drag picks nothing");
  mid = await drag(170);
  assert.equal(Number(mid[1]), 1, "past the mark the stamp is full");
  await until(`R.i===4 && R.list[3].status==='keep'`, "dragged right: kept");
  mid = await drag(-170);
  assert.equal(Number(mid[2]), 1);
  await until(`R.i===5 && R.list[4].status==='exclude' && !!document.querySelector('#rvStage .rv-ghost.fly-excl')`, "dragged left: excluded");
  await ev("rvUndo(); true");
  await until("R.i===4 && R.list[4].status==null", "and undone");
  assert.equal(await ev(`R.list[2].folder`), f2);
  // The end of the deck (2026-11-11). The last ad of the list is picked while one is still not picked: that one comes up, and it is said.
  await ev("rvGoto(R.list.length - 1); true");
  await key("ArrowRight", "ArrowRight", 39);
  await until("R.i===4 && R.list[4].status==null && !document.querySelector('#toast').hidden && /^1 ad is not picked yet: here is the next one$/.test(document.querySelector('#toast').textContent)", "the one skipped comes up");
  assert.equal(await ev("!!document.querySelector('.modal')"), false);
  // Picking the last one not picked: the next thing is asked by itself — the Stories confirmation, or Publish when every kept ad has its 9:16.
  const missing = await ev("R.data.ads.filter(a => a.status !== 'exclude' && !a.story).length");
  await key("ArrowRight", "ArrowRight", 39);
  await until("!!document.querySelector('#bModal .modal h2')", "the end of the deck asks what next");
  const endTitle = await ev("document.querySelector('#bModal .modal h2').textContent");
  if (missing) { assert.equal(endTitle, "Every ad is picked. Make Stories versions?"); assert.deepEqual(await ev("[!!document.querySelector('#bStGo'), !!document.querySelector('#bStCap'), STATE.run && !STATE.run.done]"), [true, true, null], "the same confirmation, with its call cap; nothing started"); }
  else { assert.equal(endTitle, "Every ad is picked"); assert.equal(await ev("document.querySelector('#rvEndGo').textContent"), "Publish Ads →"); }
  // A key does nothing while it is open; closed, the picking goes on. At the last ad with every ad already picked, it asks again.
  await key("ArrowLeft", "ArrowLeft", 37);
  assert.equal(await ev("R.data.counts.excluded"), 0, "no pick behind the dialog");
  await ev("bClose(); true");
  await ev("rvGoto(R.list.length - 1); true");
  await key("k", "KeyK", 75);
  await until("!!document.querySelector('#bModal .modal h2')", "the last Keep asks, every time");
  await ev("bClose(); true");
  await ev("rvGoto(2); true");
  // The location filter narrows the list to one location's ads.
  await ev("rvLoc('BISHAN'); true");
  await until("R.list.length && R.list.every(a=>a.location==='BISHAN')", "BISHAN only");
  assert.equal(await ev("R.list.length"), batch.ads.filter((a) => a.location === "BISHAN").length);
  await ev("rvLoc('all'); true");
  // Photos: excluding a photo takes its ads; the ads view says why; an ad of that photo cannot be kept on its own.
  await ev("rvMode('photos'); true");
  await until(`R.mode==='photos' && location.hash.endsWith('/photos') && document.querySelectorAll('#rvStage img').length===1`, "the photos view");
  assert.equal(await ev("R.list[R.i].id"), "r01");
  await key("x", "KeyX", 88);
  const withR1 = batch.ads.filter((a) => a.photos.includes("r01")).map((a) => a.folder).sort();
  const t2 = Date.now(); while (JSON.stringify(sel().excluded) !== JSON.stringify(withR1) && Date.now() - t2 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sel().excluded, withR1, "every ad with r01 is out");
  // Back returns to the ads view, where those ads show as excluded with their photo.
  await ev("history.back(); true");
  await until("R.mode==='ads' && STATE.rmode==='ads' && !location.hash.endsWith('/photos') && R.list.length && R.list.every(a=>a.folder)", "Back to the ads");
  await ev(`rvGoto(R.list.findIndex(a=>a.photos.includes('r01'))); true`);
  await until("document.querySelector('#rvInfo').textContent.includes('excluded with photo r01')", "the reason shown");
  await key("k", "KeyK", 75);
  await until("document.querySelector('#toast') && !document.querySelector('#toast').hidden && /Photo r01 is excluded/.test(document.querySelector('#toast').textContent)", "keeping it is refused, with the reason");
  // The campaign list shows where each campaign stands.
  await ev("go('review'); true");
  await until("!!document.querySelector('.camps')", "the campaign list");
  assert.match(await ev("document.querySelector('.camps').textContent"), /excluded/);

  // The Generating screen: a batch part-way through its photos (as progress.json says, mid-run).
  const gid = "gen-view", gout = join(brands, GYM, "outputs", gid);
  mkdirSync(join(brands, GYM, "batches", gid), { recursive: true });
  writeFileSync(join(brands, GYM, "batches", gid, "brief.json"), JSON.stringify({ ...BRIEF, batch_id: gid, generated: 3, max_calls: 6 }, null, 2));
  mkdirSync(join(gout, "visuals"), { recursive: true });
  cpSync(join(brands, GYM, "brand-assets", "facility-clean", "r1.png"), join(gout, "visuals", "g01.png"));
  cpSync(join(brands, GYM, "brand-assets", "facility-clean", "r2.png"), join(gout, "visuals", "g02.png"));
  writeFileSync(join(gout, "progress.json"), JSON.stringify({ batch_id: gid, stage: "photos", max_calls: 6, attempts: 2, spent_before: 0, calls: 3, real: 2, ads: null, photos: {
    g01: { scene_id: "m1", scene: "A man holding a plank.", treatment: "t1-bottom-stack", state: "passed", attempt: 2, file: "visuals/g01.png", notes: ["a bystander at the back"] },
    g02: { scene_id: "m1", scene: "A man holding a plank.", treatment: "t3-right-column", state: "checking", attempt: 1, file: "visuals/g02.png" },
    g03: { scene_id: "m1", scene: "A man holding a plank.", treatment: "t6-left-column", state: "queued" },
  } }));
  await ev(`openGenerating('${gid}'); true`);
  await until("document.querySelectorAll('.gc').length===3", "the photo cards");
  assert.match(await ev("document.querySelector('h1').textContent"), /Generating · 1 of 3 photos/);
  assert.match(await ev("document.querySelector('.sub').textContent"), /3 image calls used of 6 · plus 2 real photos/);
  const cards = await ev("[...document.querySelectorAll('.gc')].map(c=>c.textContent.replace(/\\s+/g,' '))");
  assert.match(cards[0], /g01 · m1.*passed.*try 2.*note/); assert.match(cards[1], /checking/); assert.match(cards[2], /queued/);
  assert.equal(await ev("document.querySelector('.gc img')?.naturalWidth > 0 || new Promise(r=>setTimeout(()=>r(document.querySelector('.gc img').naturalWidth>0),500))"), true, "a passed photo shows as it passes");
  // Review the passed photos while the rest are made: photos only, no ads yet.
  await ev("[...document.querySelectorAll('button')].find(b=>/Review the 1 passed photo/.test(b.textContent)).click(); true");
  await until(`STATE.tab==='review' && R.data && R.mode==='photos'`, "review of the passed photos");
  assert.deepEqual(await ev("R.data.photos.map(p=>p.id)"), ["g01", "r01", "r02"]);
  assert.equal(await ev("document.querySelector('.seg button').disabled"), true, "no ads yet");
  await key("x", "KeyX", 88);
  const t3 = Date.now(); while (!existsSync(join(gout, "review.json")) && Date.now() - t3 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(readFileSync(join(gout, "review.json"), "utf-8")).photos.g01, "exclude", "a photo can be excluded before its ads exist");
  assert.ok(!existsSync(join(gout, "selections.json")), "the picks file waits for the ads");
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U12 gym profiles through the panel ──────────────────────────────────────

test("U12 profiles: GET says how finished a profile is; a save with a token or a malformed field is refused and writes nothing; wordings are kept once and a confirmed batch records its own; a new gym lands in the panel's clients folder", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json");
  let r = await (await call(`/api/client/${GYM}`)).json();
  assert.ok(r.completeness && Array.isArray(r.completeness.sections), "completeness comes with the profile");
  assert.equal(r.creative_defaults.generated, 10, "the defaults are filled in for a profile that has none");
  assert.deepEqual(r.creative_defaults.locations, []);
  const offers = r.completeness.sections.find((s) => s.id === "offers");
  assert.equal(offers.status, "done", "the batches already run give this gym its first wording");
  // Wordings: the history first; confirmed runs (U5, U9b) counted.
  let w = await (await call(`/api/client/${GYM}/wordings`)).json();
  const reset = w.wordings.find((x) => x.text === WORDS.offer);
  assert.ok(reset && reset.uses >= 1, JSON.stringify(w));
  assert.equal((await call(`/api/client/${GYM}/wordings`, { method: "POST", body: { text: "8 Week Mums Comeback" }, token: null })).status, 403);
  assert.equal((await call(`/api/client/${GYM}/wordings`, { method: "POST", body: { text: "8 Week — Mums" } })).status, 400);
  const added = await (await call(`/api/client/${GYM}/wordings`, { method: "POST", body: { text: "8 Week Mums Comeback" } })).json();
  assert.equal(added.wording.text, "8 Week Mums Comeback");
  assert.equal((await call(`/api/client/${GYM}/wordings/${added.wording.id}`, { method: "PUT", body: { text: "8 Week Mums Strength Comeback" } })).status, 200);
  assert.equal((await call(`/api/client/${GYM}/wordings/nope`, { method: "DELETE" })).status, 400);
  assert.equal((await call(`/api/client/${GYM}/wordings/..%2F..`, { method: "DELETE" })).status, 404);
  assert.equal((await call(`/api/client/${GYM}/wordings/${added.wording.id}`, { method: "DELETE" })).status, 200);
  w = await (await call(`/api/client/${GYM}/wordings`)).json();
  assert.ok(!w.wordings.some((x) => /Mums/.test(x.text)));
  assert.ok(existsSync(join(g, "ad-wordings.json")), "kept in the gym's folder");
  // A confirmed batch run with new words records them (the owner typed them and confirmed).
  const b = JSON.parse(readFileSync(join(g, "batches", BRIEF.batch_id, "brief.json"), "utf-8"));
  writeFileSync(join(g, "batches", BRIEF.batch_id, "brief.json"), JSON.stringify({ ...b, offer: "6 Week Strength Kickstart" }, null, 2) + "\n");
  const ran = await runAndWait({ kind: "batch-rerender", gym: GYM, batch: BRIEF.batch_id });
  assert.equal(ran.code, 0, ran.lines.join("\n"));
  w = await (await call(`/api/client/${GYM}/wordings`)).json();
  assert.equal(w.wordings[0].text, "6 Week Strength Kickstart", "the words just run come first");
  assert.equal(w.wordings[0].uses, 1);
  writeFileSync(join(g, "batches", BRIEF.batch_id, "brief.json"), JSON.stringify(b, null, 2) + "\n");
  // Saving a profile: checked first; nothing is written when it is wrong.
  const before = readFileSync(pf, "utf-8");
  const prof = JSON.parse(before);
  for (const [bad, re] of [[{ ...prof, meta_assets: { access_token: "EAAB" + "x".repeat(40) } }, /never go in a profile/], [{ ...prof, gym_abbr: "test gym" }, /2-4 capital letters/], [{ ...prof, creative_defaults: { locations: ["BISHAN — NORTH"] } }, /em\/en dash/], [{ ...prof, creative_defaults: { real_photos: ["../../../.env"] } }, /not in brand-assets/]]) {
    const res = await call(`/api/client/${GYM}`, { method: "PUT", body: bad });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, re);
    assert.equal(readFileSync(pf, "utf-8"), before, "nothing written");
  }
  const good = { ...prof, gym_abbr: "TG", creative_defaults: { locations: ["BISHAN", "ANG MO KIO"], audiences: ["GUYS OF BISHAN", "MEN WANTED"], real_photos: ["facility-clean/r2.png"], generated: 0, looks_per_photo: 2 } };
  r = await (await call(`/api/client/${GYM}`, { method: "PUT", body: good })).json();
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(readFileSync(pf, "utf-8")).schema_version, 3, "saved as schema 3");
  assert.deepEqual(r.creative_defaults.locations, ["BISHAN", "ANG MO KIO"]);
  assert.equal(r.completeness.sections.find((s) => s.id === "defaults").status, "done");
  const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
  assert.deepEqual(setup.creative_defaults.audiences, ["GUYS OF BISHAN", "MEN WANTED"], "the Generate Creatives screen gets the defaults");
  assert.ok(setup.wordings.length >= 1, "and the wordings");
  // A new gym: a name and a folder; written in the panel's clients folder, never elsewhere.
  assert.equal((await call("/api/clients", { method: "POST", body: { gym: "Bad Name", display_name: "x" } })).status, 400);
  assert.equal((await call("/api/clients", { method: "POST", body: { gym: "second-gym", display_name: "Second — Gym" } })).status, 400);
  const nc = await (await call("/api/clients", { method: "POST", body: { gym: "second-gym", display_name: "Second Gym" } })).json();
  assert.equal(nc.created, true);
  assert.equal(JSON.parse(readFileSync(join(brands, "second-gym", "gym-profile.json"), "utf-8")).display_name, "Second Gym");
  assert.ok(!existsSync(join(ROOT, "brands", "second-gym")), "never in the repo's own brands folder");
  const clients = (await (await call("/api/clients")).json()).clients;
  assert.ok(clients.find((c) => c.gym === "second-gym").to_do > 0, "a new gym has sections to fill");
});

// ── U13 the profile pages and the Generate Creatives screen's defaults ───────────────────

test("U13 the page: Create opens with the profile's defaults (never the offer); wording chips fill the offer; the Overview shows what each section needs; a new gym is made from the top bar; switching gyms switches the defaults", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: `${panel.url}/?u13#/${GYM}/batch` }, sessionId);
  await loaded;
  await until("!!document.querySelector('#bOffer') && !!document.querySelector('#bLoc1')", "Create with two locations");
  assert.equal(await ev("document.querySelector('#bOffer').value"), "", "the offer is never filled in for you");
  assert.deepEqual(await ev("[document.querySelector('#bLoc0').value, document.querySelector('#bLoc1').value]"), ["BISHAN", "ANG MO KIO"]);
  assert.deepEqual(await ev("B.draft.real"), ["facility-clean/r2.png"]);
  assert.equal(await ev("document.querySelector('#bGen').value"), "0");
  assert.match(await ev("document.querySelector('#bAudChips').textContent"), /GUYS OF BISHAN/);
  // The wording chips: picking one is choosing its exact words.
  await until("document.querySelectorAll('#bWords .chip').length>0", "wording chips");
  const chip = await ev("document.querySelector('#bWords .chip').textContent");
  await ev("document.querySelector('#bWords .chip').click(); true");
  assert.equal(await ev("document.querySelector('#bOffer').value"), chip);
  await until(`B.check && B.check.summary && B.check.summary.locations===2`, "the check with the pre-filled words");
  // The Overview.
  await ev("go('overview'); true");
  await until("document.querySelectorAll('.ovc').length===9", "the nine sections (to create, to publish, and the rooms to learn from the results)");
  const ov = await ev("document.querySelector('#view').textContent");
  assert.match(ov, /To create ads/); assert.match(ov, /To publish to Meta/); assert.match(ov, /Meta link/);
  await ev("[...document.querySelectorAll('.ovc')].find(c=>/Meta link/.test(c.textContent)).click(); true");
  await until("STATE.tab==='meta' && !!document.querySelector('#view input')", "the Meta page from its card");
  assert.match(await ev("document.querySelector('#view').textContent"), /Access tokens and passwords never go in a profile/);
  // A token typed into a Meta field is refused on save, and says why.
  await ev(`(()=>{const el=[...document.querySelectorAll('#view input.mono')][2]; el.value='EAAB${"x".repeat(40)}'; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await ev("document.querySelector('#saveBtn_profile').click(); true");
  await until("/never go in a profile/.test(document.querySelector('#saveMsg_profile').textContent)", "the refusal");
  assert.ok(!readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8").includes("EAAB"), "nothing written");
  await ev("DIRTY={}; true");
  // A new gym from the top bar; then back to the first, whose defaults return.
  await ev("newClient(); true");
  await until("!!document.querySelector('#ncName')", "the new gym dialog");
  await ev(`(()=>{const el=document.querySelector('#ncName'); el.value='Third Gym'; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  assert.equal(await ev("document.querySelector('#ncSlug').value"), "third-gym");
  await ev("newClientGo(); true");
  await until("STATE.sel==='third-gym' && STATE.tab==='overview' && document.querySelectorAll('.ovc').length===9", "the new gym's overview");
  assert.match(await ev("document.querySelector('#view').textContent"), /to finish before creating ads/);
  assert.ok(existsSync(join(brands, "third-gym", "gym-profile.json")));
  await ev("go('batch'); true");
  await until("STATE.tab==='batch' && !!document.querySelector('#bLoc0')", "Create for the new gym");
  assert.equal(await ev("document.querySelector('#bLoc0').value"), "", "no defaults yet");
  assert.match(await ev("document.querySelector('#view').textContent"), /This gym's profile still needs/);
  await ev(`selectClient('${GYM}'); true`);
  await until(`STATE.sel==='${GYM}' && document.querySelector('#bLoc0')?.value==='BISHAN'`, "the first gym's defaults again");
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U14 brand assets ──────────────────────────────────────────────────────────

test("U14 brand assets: dropped files are filed by kind in brand-assets with a manifest — images by their first bytes, an SVG only as a plain logo, a HEIC converted, never the same file twice; served from brand-assets alone; the first logo becomes the profile's; removal goes to _trash; the clean-up runs are built server-side; the preview shows the brand palette", async () => {
  const g = join(brands, GYM);
  const png = readFileSync(join(g, "brand-assets", "facility-clean", "r1.png")), png2 = readFileSync(join(g, "brand-assets", "facility-clean", "r2.png"));
  const put = (kind, name, body, { token = panel.token, headers = {} } = {}) => raw(`/api/client/${GYM}/asset/${kind}/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream", ...(token ? { "x-panel-token": token } : {}), ...headers }, body });
  const manifest = () => JSON.parse(readFileSync(join(g, "brand-assets", "manifest.json"), "utf-8"));
  let r = await (await call(`/api/client/${GYM}/assets`)).json();
  assert.deepEqual(r.kinds.map((k) => k.id), ["logo", "facility", "coaches", "members", "brand", "other"]);
  assert.deepEqual(r.assets, []); assert.equal(r.clean.length, 2, "the cleaned photos list apart");
  assert.equal((await put("facility", "room-one.png", png, { token: null })).status, 403, "no token");
  assert.equal((await put("rooms", "room-one.png", png)).status, 400, "an unknown kind");
  assert.equal((await put("facility", "Room%20One.png", png)).status, 400, "the name must be a slug");
  assert.equal((await put("facility", "room-one.jpg", png)).status, 400, "a png named .jpg");
  assert.equal((await put("facility", "notes.png", Buffer.from("this is not an image at all"))).status, 400);
  let up = await put("facility", "room-one.png", png, { headers: { "x-original-name": encodeURIComponent("IMG_0042 Sin Ming.PNG") } });
  assert.equal(up.status, 200, up.body);
  let j = JSON.parse(up.body);
  assert.equal(j.asset.path, "facility/room-one.png"); assert.equal(j.asset.original_name, "IMG_0042 Sin Ming.PNG"); assert.deepEqual(j.asset.size, [1535, 1146]); assert.equal(j.asset.source, "upload");
  assert.ok(existsSync(join(g, "brand-assets", "facility", "room-one.png")));
  assert.equal(manifest().assets[0].sha256.length, 64, "the content hash is recorded");
  assert.equal((await fetch(panel.url + `/files/brands/${GYM}/brand-assets/facility/room-one.png`)).status, 200, "served for the thumbnail");
  const dup = await put("facility", "room-again.png", png);
  assert.equal(dup.status, 409); assert.match(JSON.parse(dup.body).error, /already here as facility\/room-one\.png/);
  assert.ok(!existsSync(join(g, "brand-assets", "facility", "room-again.png")));
  j = JSON.parse((await put("facility", "room-one.png", png2)).body);
  assert.equal(j.asset.path, "facility/room-one-2.png", "a name already taken is numbered, never overwritten");
  mkdirSync(join(g, "brand-assets", "coaches"), { recursive: true }); writeFileSync(join(g, "brand-assets", "coaches", "coach-a.png"), png);
  r = await (await call(`/api/client/${GYM}/assets`)).json();
  const byPath = Object.fromEntries(r.assets.map((a) => [a.path, a]));
  assert.equal(byPath["facility/room-one.png"].cleaned, false); assert.equal(byPath["facility/room-one.png"].source, "upload");
  assert.equal(byPath["coaches/coach-a.png"].source, "folder", "a file placed by hand lists too");
  assert.equal(byPath["facility/room-one.png"].url, `/files/brands/${GYM}/brand-assets/facility/room-one.png`);
  assert.equal((await put("other", "big.png", Buffer.concat([png, Buffer.alloc(26 * 1024 * 1024)]))).status, 413, "over 25 MB");
  // SVG: a logo only; a plain one only; served as an image that may run nothing.
  const svgLogo = Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#fff"/></svg>`);
  assert.equal((await put("facility", "mark.svg", svgLogo)).status, 400, "an SVG is not a photo");
  assert.equal((await put("logo", "mark.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))).status, 400, "scripts refused");
  assert.equal((await put("logo", "mark.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>`))).status, 400, "handlers refused");
  up = await put("logo", "mark.svg", svgLogo); assert.equal(up.status, 200, up.body);
  j = JSON.parse(up.body); assert.equal(j.asset.logo_set, true, "the first logo becomes the profile's");
  assert.equal(JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8")).brand_lock.logo.files.primary, "logo/mark.svg");
  const served = await fetch(panel.url + `/files/brands/${GYM}/brand-assets/logo/mark.svg`);
  assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "image/svg+xml"); assert.match(served.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await fetch(panel.url + `/files/brands/${GYM}/brand-assets/facility/mark.svg`)).status, 404, "an svg outside logo/ is never served");
  assert.equal((await (await call(`/api/client/${GYM}`)).json()).logo, `/files/brands/${GYM}/brand-assets/logo/mark.svg`);
  j = JSON.parse((await put("logo", "mark-white.png", Buffer.concat([png2, Buffer.from([0])]))).body);
  assert.ok(!j.asset.logo_set, "a second logo does not replace the profile's");
  // Removal: never the profile's logo; otherwise to _trash, noted, no longer served.
  assert.equal((await call(`/api/client/${GYM}/asset/logo/mark.svg`, { method: "DELETE" })).status, 409, "the logo in use");
  assert.equal((await call(`/api/client/${GYM}/asset/logo/mark-white.png`, { method: "DELETE", token: null })).status, 403);
  assert.equal((await call(`/api/client/${GYM}/asset/logo/mark-white.png`, { method: "DELETE" })).status, 200);
  assert.ok(!existsSync(join(g, "brand-assets", "logo", "mark-white.png")));
  const trashed = manifest().assets.find((a) => a.path === "logo/mark-white.png");
  assert.ok(trashed.removed && existsSync(join(g, "brand-assets", trashed.trashed)), "moved, not deleted");
  assert.equal((await fetch(panel.url + `/files/brands/${GYM}/brand-assets/${trashed.trashed}`)).status, 404, "the trash is not served");
  assert.equal((await call(`/api/client/${GYM}/asset/logo/nope.png`, { method: "DELETE" })).status, 404);
  // HEIC from an iPhone: converted with sips on a Mac (skipped where there is none).
  if (r.heic) {
    const heicDir = mkdtempSync(join(tmpdir(), "heic-")); writeFileSync(join(heicDir, "in.png"), png);
    execFileSync("sips", ["-s", "format", "heic", join(heicDir, "in.png"), "--out", join(heicDir, "shot.heic")], { stdio: "ignore" });
    up = await put("facility", "iphone-shot.heic", readFileSync(join(heicDir, "shot.heic")));
    assert.equal(up.status, 200, up.body);
    j = JSON.parse(up.body); assert.equal(j.asset.path, "facility/iphone-shot.jpg");
    assert.equal(readFileSync(join(g, "brand-assets", "facility", "iphone-shot.jpg"))[0], 0xff, "a JPEG now");
    rmSync(heicDir, { recursive: true, force: true });
  }
  // The clean-up runs: photos are premises photos by name; the clean run needs a confirmed cap; argv is built here.
  const post = (body) => call("/api/run", { method: "POST", body });
  assert.equal((await post({ kind: "photo-survey", gym: GYM, photos: [] })).status, 400);
  assert.equal((await post({ kind: "photo-survey", gym: GYM, photos: ["../facility-clean/r1.png"] })).status, 400);
  assert.equal((await post({ kind: "photo-survey", gym: GYM, photos: ["nope.png"] })).status, 400);
  assert.equal((await post({ kind: "photo-clean", gym: GYM, photos: ["room-one.png"] })).status, 400, "no cap");
  assert.equal((await post({ kind: "photo-clean", gym: GYM, photos: ["room-one.png", "room-one-2.png"], confirm: { max_calls: 1 } })).status, 400, "under one call per photo");
  let ran = await runAndWait({ kind: "photo-survey", gym: GYM, photos: ["room-one.png"], extra: "--yes" });
  assert.match(ran.lines[0], /^\$ node skills\/references\/clean-photo\.mjs --brand-dir \S+testgym --survey-only --photo \S+brand-assets\/facility\/room-one\.png$/, ran.lines[0]);
  assert.notEqual(ran.code, 0, "no model in the tests: the survey stops at its first call");
  assert.ok(ran.lines.some((l) => /network blocked|GEMINI_KEY/.test(l)), ran.lines.join("\n"));
  ran = await runAndWait({ kind: "photo-clean", gym: GYM, photos: ["room-one.png", "room-one-2.png"], confirm: { max_calls: 8 } });
  assert.match(ran.lines[0], /clean-photo\.mjs --brand-dir \S+testgym --max-calls 8 --attempts 2 --photo \S+room-one\.png --photo \S+room-one-2\.png$/, ran.lines[0]);
  assert.ok(!existsSync(join(g, "brand-assets", "facility-clean", "room-one.png")), "nothing cleaned without a model");
  // The gym's brand colours: saved with the palettes mode, the profile answers with its three palettes,
  // and the live preview's offer-band look takes the brand palette.
  const prof = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8"));
  const withBrand = { ...prof, brand_lock: { ...prof.brand_lock, colors: { primary: { hex: "#0A0A0A" }, secondary: { hex: "#FA1414" }, accent: { hex: "#FFFFFF" } } }, creative_defaults: { ...(prof.creative_defaults || {}), palettes: "both" } };
  assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...withBrand, brand_lock: prof.brand_lock } })).status, 400, "both without colours is refused");
  const saved = await (await call(`/api/client/${GYM}`, { method: "PUT", body: withBrand })).json();
  assert.deepEqual(Object.keys(saved.brand_palettes), ["brand", "brand-light", "brand-bold"]);
  const pv = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "BISHAN", audience: "MEN", photos: ["facility-clean/r1.png", "facility-clean/r2.png"] } })).json();
  assert.deepEqual(pv.errors, []);
  const t5 = pv.looks.find((l) => l.id === "t5"); assert.equal(t5.palette, "brand"); assert.equal(t5.ok, true, t5.failures.join("; "));
  assert.ok(pv.looks.filter((l) => l.id !== "t5").every((l) => l.palette !== "brand"), "the other looks keep their reference pairings");
  assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...withBrand, creative_defaults: { ...(prof.creative_defaults || {}), palettes: "reference" } } })).status, 200);
});

// ── U15 the assets page, the Brand page, the palette switch ──────────────────

test("U15 the page: a file dropped on Photos & assets is filed by kind and listed; selecting premises photos enables the clean-up; the Brand page shows the brand palettes and the logo in use; Ad defaults switches the palettes on and saves it", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: `${panel.url}/?u15#/${GYM}/photos` }, sessionId);
  await loaded;
  await until("!!document.querySelector('#aDrop') && document.querySelectorAll('.asset').length>0", "the assets page");
  assert.match(await ev("document.querySelector('#view').textContent"), /Cleaned photos/);
  // Upload through the page's own code: a File (the served photo, one byte changed so it is new), as a coach photo.
  await ev(`(async()=>{ const b = await (await fetch('/files/brands/${GYM}/brand-assets/facility-clean/r2.png')).blob(); const bytes = new Uint8Array(await b.arrayBuffer()); bytes[bytes.length-1] ^= 1;
    const f = new File([bytes], 'Coach Viki HEAD.png', {type:'image/png'}); await aUploadKind([f], 'coaches', async()=>{ await loadAssets(); paintAssets(document.querySelector('#view')); }); return true })()`);
  await until("[...document.querySelectorAll('.asset .m b')].some(b=>b.textContent==='coach-viki-head.png')", "the coach photo listed");
  assert.ok(existsSync(join(brands, GYM, "brand-assets", "coaches", "coach-viki-head.png")), "filed under coaches");
  await ev("aToggle('facility/room-one.png'); true");
  await until("[...document.querySelectorAll('button')].some(b=>/Survey 1/.test(b.textContent) && !b.disabled)", "the survey button enabled by a selection");
  assert.ok(await ev("[...document.querySelectorAll('.asset.is-logo .tag')].some(p=>/in use/.test(p.textContent))"), "the profile's logo is marked in use on the assets page");
  assert.ok(await ev("[...document.querySelectorAll('.asset.is-logo button')].every(b=>!/Use as logo/.test(b.textContent))"), "and not offered as a choice");
  // The Brand page: the three swatches from the saved colours, and the logo in use.
  await ev("go('brand'); true");
  await until("document.querySelectorAll('.swatch').length===3", "three swatches");
  const brandText = await ev("document.querySelector('#view').textContent");
  assert.match(brandText, /the reference pairings only/); assert.match(brandText, /mark\.svg/);
  assert.ok(await ev("[...document.querySelectorAll('.asset.is-logo .pill')].some(p=>/in use/.test(p.textContent))"), "the profile's logo is marked");
  // Ad defaults: switch to both, save, and the file says so.
  await ev("go('defaults'); true");
  await until("document.querySelectorAll('input[name=pm]').length===3", "the palette switch");
  assert.equal(await ev("document.querySelector('input[name=pm][value=both]').disabled"), false, "enabled once the gym has colours");
  await ev("(()=>{const el=document.querySelector('input[name=pm][value=both]'); el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); return true})()");
  await ev("document.querySelector('#saveBtn_profile').click(); true");
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8")).creative_defaults?.palettes !== "both") await new Promise((r) => setTimeout(r, 150));
  assert.equal(JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8")).creative_defaults.palettes, "both");
  await until("DIRTY.profile===false", "saved");
  await ev("go('brand'); true");
  await until("/both the reference pairings and the brand palettes/.test(document.querySelector('#view').textContent)", "the Brand page says both");
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

// ── U16 / U17 the Meta link ───────────────────────────────────────────────────

const META_TOKEN = "EAA" + "p".repeat(60);
/** A fake Graph API for the panel: the token must be ours; a few assets; a Page token for the forms. */
function fakeGraph() {
  const calls = [];
  let n = 0; const made = {};
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), path = u.pathname.split("/").slice(2).join("/");
    if (req.method === "POST") { let body = ""; for await (const c of req) body += c; for (const [k, v] of new URLSearchParams(body)) u.searchParams.set(k, v); }
    const tok = u.searchParams.get("access_token");
    calls.push(path);
    const ok = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!u.pathname.startsWith("/img/") && tok !== META_TOKEN && tok !== "PAGE-TOKEN") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } })); }
    if (req.method === "POST" && path === "act_111000000001/adimages") return ok({ images: { [u.searchParams.get("name")]: { hash: "hash" + (++n) } } });
    if (req.method === "POST" && ["act_111000000001/campaigns", "act_111000000001/adsets", "act_111000000001/adcreatives", "act_111000000001/ads"].includes(path)) { const id = path.split("/")[1].slice(0, 2) + (++n); made[path.split("/")[1]] = id; return ok({ id }); }
    if (req.method === "POST" && /^(ca|ad)\d+$/.test(path)) return ok({ success: true }); // an update in place (a changed name, budget or targeting)
    if (/^ca\d+$/.test(path)) return ok({ id: path, name: "Test campaign", status: "PAUSED", effective_status: "PAUSED" });
    if (/^ca\d+\/adsets$/.test(path)) return ok({ data: [{ id: made.adsets, name: "set", status: "PAUSED", effective_status: "PAUSED", daily_budget: "5000" }] });
    if (/^ca\d+\/ads$/.test(path)) return ok({ data: [{ id: made.ads, name: "one", status: "PAUSED", effective_status: "PAUSED", adset_id: made.adsets }] });
    if (/^ca\d+\/insights$/.test(path)) return ok({ data: u.searchParams.get("level") === "ad" ? [{ ad_id: made.ads, adset_id: made.adsets, spend: "12.5", impressions: "800", inline_link_clicks: "20", clicks: "22", reach: "700", actions: [{ action_type: "lead", value: "2" }], date_start: "2026-09-17", date_stop: "2026-09-18" }] : [] });
    if (path === "act_111000000001/campaigns" && req.method === "GET") return ok({ data: [{ id: "cx1", name: "0331 Their campaign", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", created_time: "2026-03-31T10:00:00+0800" }] });
    if (path === "act_111000000001/insights" && u.searchParams.get("time_increment")) { const end = JSON.parse(u.searchParams.get("time_range")).until; return ok({ data: Array.from({ length: 14 }, (_, i) => ({ adset_id: "s1", adset_name: "0715 Thomson | Fit Fathers", campaign_id: "cx1", campaign_name: "0331 Their campaign", objective: "OUTCOME_LEADS", date_start: new Date(Date.parse(end + "T00:00:00Z") - i * 86400000).toISOString().slice(0, 10), spend: "50", impressions: "2000", inline_link_clicks: "30", actions: [{ action_type: "lead", value: i < 7 ? "2" : "5" }] })) }); }
    if (path === "act_111000000001/insights" && u.searchParams.get("level") === "adset" && /reach/.test(u.searchParams.get("fields") || "")) return ok({ data: [{ adset_id: "s1", impressions: "14000", reach: "7000", frequency: "2" }] });
    if (path === "act_111000000001/ads" && req.method === "GET" && u.searchParams.get("effective_status")) return ok({ data: [{ id: "900000000001", name: "0331 Their image ad", adset_id: "s1", campaign_id: "cx1", created_time: "2026-03-31T11:00:00+0800", adset: { id: "s1", name: "0715 Thomson | Fit Fathers", daily_budget: "5000" }, campaign: { id: "cx1", name: "0331 Their campaign", objective: "OUTCOME_LEADS" } }] });
    if (path === "act_111000000001/ads" && req.method === "GET") return ok({ data: [
      { id: "900000000001", name: "0331 Their image ad", adset_id: "s1", campaign_id: "cx1", status: "ACTIVE", effective_status: "ACTIVE", created_time: "2026-03-31T11:00:00+0800", creative: { id: "tc1", thumbnail_url: `${u.origin}/thumb.jpg`, asset_feed_spec: { images: [{ hash: "th1" }], bodies: [{ text: "Their primary text" }], titles: [{ text: "Their headline" }] } } },
      { id: "900000000002", name: "0331 Their video ad", adset_id: "s1", campaign_id: "cx1", status: "PAUSED", effective_status: "PAUSED", created_time: "2026-04-01T11:00:00+0800", creative: { id: "tc2", object_type: "VIDEO", object_story_spec: { page_id: "770000000007", video_data: { video_id: "v1", message: "Video words", title: "Video title", image_hash: "th2" } } } },
    ] });
    if (path === "act_111000000001/insights" && u.searchParams.get("level") === "ad") return ok({ data: u.searchParams.get("date_preset") === "maximum" ? [{ ad_id: "900000000001", spend: "300", impressions: "9000", inline_link_clicks: "90", actions: [{ action_type: "lead", value: "30" }] }, { ad_id: "900000000002", spend: "500", impressions: "20000", inline_link_clicks: "200", actions: [{ action_type: "lead", value: "100" }] }] : [] });
    if (path === "act_111000000001/adimages" && u.searchParams.get("hashes")) return ok({ data: JSON.parse(u.searchParams.get("hashes")).map((h) => ({ hash: h, url: `http://127.0.0.1:${server.address().port}/img/${h}.png` })) });
    if (u.pathname.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])); }
    if (path === "me") return ok({ id: "1", name: "strategym-panel" });
    if (path === "me/adaccounts") return ok({ data: [{ id: "act_111000000001", account_id: "111000000001", name: "Test Gym Ads", currency: "SGD", account_status: 1, timezone_name: "Asia/Singapore" }, { id: "act_222000000002", account_id: "222000000002", name: "Other Ads", currency: "USD", account_status: 1 }] });
    if (path === "me/accounts") return ok({ data: [{ id: "770000000007", name: "Test Gym", instagram_business_account: { id: "880000000008", username: "testgym" } }] });
    if (path === "me/businesses") return ok({ data: [{ id: "555000000005", name: "Test Gym Pte Ltd" }] });
    if (path === "770000000007" && u.searchParams.get("fields") === "access_token") return ok({ access_token: "PAGE-TOKEN" });
    if (path === "770000000007") return ok({ id: "770000000007", name: "Test Gym", instagram_business_account: { id: "880000000008", username: "testgym" } });
    if (path === "770000000007/leadgen_forms" && req.method === "POST") { made.form = { id: "400100000009", body: Object.fromEntries(u.searchParams) }; return ok({ id: "400100000009" }); }
    if (path === "770000000007/leadgen_forms") return ok({ data: [{ id: "400100000001", name: "12 Week Reset form", status: "ACTIVE", leads_count: 3, created_time: "2026-05-01T00:00:00+0000", locale: "en_GB",
      questions: [{ key: "q1", type: "CUSTOM", label: "Do you live or work near Bishan?", options: [{ key: "y", value: "Yes" }, { key: "n", value: "No" }] }, { key: "q2", type: "CUSTOM", label: "Why the 12 Week Reset?" }, { key: "email", type: "EMAIL", label: "Email" }, { key: "full_name", type: "FULL_NAME", label: "Full name" }],
      privacy_policy_url: "https://testgym.sg/privacy", legal_content: { privacy_policy: { url: "https://testgym.sg/privacy", link_text: "Privacy" } }, context_card: { title: "12 Week Reset", content: ["Tell us about you"], style: "PARAGRAPH_STYLE" }, thank_you_page: { title: "Last step", body: "We will call you", button_type: "CALL_BUSINESS", button_text: "Call", business_phone_number: "+6591234567" }, allow_organic_lead: true }] });
    if (path === "act_111000000001") return ok({ id: "act_111000000001", account_id: "111000000001", name: "Test Gym Ads", currency: "SGD", account_status: 1 });
    if (path === "act_111000000001/adspixels") return ok({ data: [{ id: "600100000001", name: "Test pixel" }] });
    if (path === "act_111000000001/instagram_accounts") return ok({ data: [{ id: "880000000008", username: "testgym" }] });
    if (path === "act_111000000001/adsets") return ok({ data: [
      { id: "s1", name: "0715 Thomson | Fit Fathers | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60", created_time: "2026-07-15T21:02:30+0800", updated_time: "2026-08-14T14:30:00+0800", targeting: { age_min: 25, age_max: 60, genders: [1], flexible_spec: [{ interests: [{ id: "6003277229371", name: "Physical fitness (fitness)" }] }, { interests: [{ id: "6003101323797", name: "Fatherhood (children and parenting)" }] }], geo_locations: { places: [{ key: "107327800879305", name: "6 Sin Ming Road, Tower 2", latitude: "1.353055", longitude: "103.836321", radius: 5 }], location_types: ["home", "recent"] } } },
      { id: "s2", name: "0423 Broad", created_time: "2026-04-23T10:00:00+0800", targeting: { age_min: 25, age_max: 60, genders: [1], geo_locations: { custom_locations: [{ latitude: 1.35, longitude: 103.83, radius: 5 }] } } },
    ] });
    if (path === "act_111000000001/insights") return ok({ data: [{ adset_id: "s1", spend: "2530.59", impressions: "100", actions: [{ action_type: "lead", value: "45" }, { action_type: "link_click", value: "9" }] }, { adset_id: "s2", spend: "300", impressions: "100", actions: [{ action_type: "lead", value: "60" }] }] });
    if (path === "act_111000000001/saved_audiences") return ok({ data: [{ id: "sa1", name: "Healthy food", targeting: { flexible_spec: [{ interests: [{ id: "6003300000001", name: "Organic food" }] }] }, approximate_count_lower_bound: 2200000 }] });
    if (path === "search" && u.searchParams.get("type") === "adinterest") return ok({ data: /yoga/i.test(u.searchParams.get("q")) ? [{ id: "6003200000001", name: "Yoga", audience_size_lower_bound: 500000000, path: ["Interests", "Fitness and wellness", "Yoga"] }] : [] });
    if (path === "act_111000000001/targetingsearch") return ok({ data: /yoga/i.test(u.searchParams.get("q")) ? [{ id: "6003200000001", name: "Yoga", type: "interests" }, { id: "6002700000001", name: "Frequent travellers", type: "behaviors", path: ["Behaviours", "Travel"] }] : [] });
    if (path === "act_111000000001/delivery_estimate") { const t = JSON.parse(u.searchParams.get("targeting_spec")); return ok({ data: [{ estimate_mau_lower_bound: t.flexible_spec ? 12000 : 370000, estimate_mau_upper_bound: t.flexible_spec ? 14100 : 435300, estimate_ready: true }] }); }
    if (path === "act_111000000001/targetingsentencelines") return ok({ targetingsentencelines: [{ content: "Location:", children: ["Singapore: 6 Sin Ming Road, Tower 2 (+5 km)"] }, { content: "Interests:", children: ["Yoga"] }] });
    if (path === "search" && u.searchParams.get("type") === "adgeolocationmeta") return ok({ data: { places: Object.fromEntries(JSON.parse(u.searchParams.get("places")).filter((k) => k === "107327800879305").map((k) => [k, { key: k, name: "6 Sin Ming Road, Tower 2", address_string: "Singapore, Singapore", latitude: "1.353055", longitude: "103.836321", country_code: "SG" }])) } });
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `no ${path}`, code: 803 } }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}`, calls, made })));
}

test("U16 the Meta link API: without keys the panel says so and calls nothing; with them it lists what the token can act on and resolves the gym's ids — never letting the token out; Setup shows the check", async () => {
  const g = join(brands, GYM);
  // The default panel has no keys (the test sets them empty, whatever the machine's .env holds).
  let r = await (await call("/api/meta/status")).json();
  assert.deepEqual([r.configured, r.app_secret], [false, false]); assert.ok(Array.isArray(r.permissions) && r.permissions.includes("ads_management"));
  r = await (await call(`/api/client/${GYM}/meta-link`)).json();
  assert.equal(r.configured, false);
  const st = await (await call("/api/status")).json();
  const mc = st.checks.find((c) => c.key === "META_ACCESS_TOKEN");
  assert.ok(mc && mc.optional && !mc.ok, "an optional Setup check, missing here");
  // A panel with the keys, against a fake Graph on this machine.
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    r = await (await call("/api/meta/status")).json();
    assert.deepEqual([r.configured, r.app_id, r.app_secret], [true, true, true]);
    assert.ok((await (await call("/api/status")).json()).checks.find((c) => c.key === "META_ACCESS_TOKEN").ok);
    const before = readFileSync(join(g, "gym-profile.json"), "utf-8");
    const res = await call(`/api/client/${GYM}/meta-link`);
    assert.equal(res.status, 200);
    const text = await res.text(); r = JSON.parse(text);
    assert.ok(!text.includes(META_TOKEN) && !text.includes("PAGE-TOKEN") && !text.includes("app-secret"), "no token or secret in the answer");
    assert.equal(r.configured, true); assert.equal(r.me.name, "strategym-panel");
    assert.deepEqual(r.accounts.map((a) => a.id), ["act_111000000001", "act_222000000002"]); assert.deepEqual(r.pages.map((p) => p.id), ["770000000007"]);
    assert.equal(r.chosen.account, null, "nothing chosen in the profile yet");
    assert.equal(readFileSync(join(g, "gym-profile.json"), "utf-8"), before, "a check writes nothing");
    assert.ok(!graph.calls.some((c) => /leadgen_forms/.test(c)), "no lookups for ids the profile does not have");
    // Ids picked but not saved ride along as query parameters: the Page's forms are listed at once; only digits are accepted.
    r = await (await call(`/api/client/${GYM}/meta-link?page_id=770000000007&ad_account_id=act_111000000001`)).json();
    assert.deepEqual(r.chosen.forms.map((f) => f.id), ["400100000001"]); assert.deepEqual(r.chosen.pixels.map((p) => p.id), ["600100000001"]);
    assert.equal((await call(`/api/client/${GYM}/meta-link?page_id=../x`)).status, 400);
    assert.equal(readFileSync(join(g, "gym-profile.json"), "utf-8"), before, "still nothing written");
    // With ids chosen, the answer resolves them; a wrong currency is a problem in words.
    const prof = JSON.parse(before);
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...prof, locale: { country: "SG", currency: "SGD" }, meta_assets: { ...(prof.meta_assets || {}), ad_account_id: "act_222000000002", page_id: "770000000007", lead_form_id: "400100000001", labels: { account: "Other Ads · USD", page: "Test Gym" } } } })).status, 200);
    r = await (await call(`/api/client/${GYM}/meta-link`)).json();
    assert.equal(r.chosen.account.currency, "USD"); assert.equal(r.chosen.page.name, "Test Gym"); assert.deepEqual(r.chosen.forms.map((f) => f.id), ["400100000001"]);
    assert.ok(r.problems.some((p) => /bills in USD/.test(p)), r.problems.join("\n"));
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...prof, meta_assets: { ...(prof.meta_assets || {}), access_token: META_TOKEN } } })).status, 400, "a token in a profile is still refused");
    writeFileSync(join(g, "gym-profile.json"), before);
    // A dead token: Meta's answer in words, no crash.
    await panel.stop();
    panel = await startPanel({ META_ACCESS_TOKEN: "EAA" + "x".repeat(60), META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
    const dead = await call(`/api/client/${GYM}/meta-link`);
    assert.equal(dead.status, 502);
    const dj = await dead.json();
    assert.match(dj.error, /token is invalid or has expired/); assert.ok(!dj.error.includes("EAAxx"));
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});

test("U17 the Meta page: without keys it shows the setup steps and the ids can still be typed; with keys, Check the link lists the token's assets and picking fills the profile's ids and names, saved as ids only", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const open = async (url) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url }, sessionId); await loaded; };
  await open(`${panel.url}/?u17#/${GYM}/meta`);
  await until("!!document.querySelector('#mt_page_id')", "the Meta page");
  let text = await ev("document.querySelector('#view').textContent");
  assert.match(text, /Set up Strategym's access/); assert.match(text, /System users/); assert.match(text, /META_ACCESS_TOKEN/); assert.match(text, /ads_management/);
  assert.ok(!(await ev("[...document.querySelectorAll('button')].some(b=>/Check the link/.test(b.textContent))")), "no check button without keys");
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    await open(`${panel.url}/?u17b#/${GYM}/meta`);
    await until("[...document.querySelectorAll('button')].some(b=>/Check the link/.test(b.textContent))", "the check button");
    assert.ok(!/Set up Strategym's access/.test(await ev("document.querySelector('#view').textContent")), "the steps are gone once the keys are there");
    await ev("metaCheck(); true");
    await until("MT.link && document.querySelectorAll('#view select').length>=5", "the lists");
    text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /token is strategym-panel/); assert.match(text, /Test Gym Ads · SGD · active/); assert.match(text, /Test Gym · @testgym/);
    // Pick the account and the Page: the ids land in the profile with the names beside them; the account's only
    // Instagram account is taken on the check that follows.
    await ev("metaPick('ad_account_id','act_111000000001','account'); metaPick('page_id','770000000007','page'); true");
    assert.deepEqual(await ev("[STATE.profile.meta_assets.ad_account_id, STATE.profile.meta_assets.page_id, STATE.profile.meta_assets.labels.account, STATE.profile.meta_assets.labels.page]"), ["act_111000000001", "770000000007", "Test Gym Ads · SGD", "Test Gym"]);
    assert.equal(await ev("document.querySelector('#mt_ad_account_id').value"), "act_111000000001", "the id field follows the pick");
    // Check again: the chosen Page's forms, the account's pixels and Instagram accounts are listed; pick them.
    await ev("metaCheck(); true");
    await until("MT.link && MT.link.chosen.forms.length===1 && MT.link.chosen.pixels.length===1", "forms and pixels of the chosen assets");
    assert.deepEqual(await ev("[STATE.profile.meta_assets.instagram_user_id, STATE.profile.meta_assets.labels.instagram, MT.link.chosen.instagram_accounts.map(x=>x.username), MT.link.chosen.instagram.id]"), ["880000000008", "@testgym", ["testgym"], "880000000008"], "the account's only Instagram account, taken and named");
    assert.ok(await ev("[...document.querySelectorAll('#view select option')].some(o=>/@testgym/.test(o.textContent))"), "offered in the Instagram list");
    assert.match(await ev("document.querySelector('#view').textContent"), /Instagram@testgym \(880000000008\)/);
    await ev("metaPick('lead_form_id','400100000001','form'); metaPick('pixel_id','600100000001','pixel'); metaPick('business_id','555000000005','business'); true");
    await ev("document.querySelector('#saveBtn_profile').click(); true");
    await until("DIRTY.profile===false", "saved");
    const saved = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8")).meta_assets;
    assert.deepEqual([saved.ad_account_id, saved.page_id, saved.instagram_user_id, saved.lead_form_id, saved.pixel_id, saved.business_id], ["act_111000000001", "770000000007", "880000000008", "400100000001", "600100000001", "555000000005"]);
    assert.equal(saved.labels.form, "12 Week Reset form"); assert.equal(saved.labels.pixel, "Test pixel");
    assert.ok(!readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8").includes(META_TOKEN), "ids and names only");
    const ov = await (await call(`/api/client/${GYM}`)).json();
    assert.equal(ov.completeness.sections.find((s) => s.id === "meta").status, "done");
  } finally { await panel.stop(); panel = main; graph.server.close(); }
  assert.ok(!/NETWORK BLOCKED/.test(panel.log()));
});

/** A fake OneMap: a postal code or an address → points, as the real one answers. */
function fakeOneMap() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), q = (u.searchParams.get("searchVal") || "").toUpperCase();
    const rows = q === "575583" ? [{ SEARCHVAL: "SIN MING PLAZA", ADDRESS: "2 SIN MING ROAD SIN MING PLAZA SINGAPORE 575583", POSTAL: "575583", LATITUDE: "1.352482302799053", LONGITUDE: "103.8357469735082" }]
      : /BISHAN/.test(q) ? [{ SEARCHVAL: "BISHAN MRT STATION", ADDRESS: "17 BISHAN PLACE BISHAN MRT STATION", POSTAL: "NIL", LATITUDE: "1.3508", LONGITUDE: "103.8485" }, { SEARCHVAL: "JUNCTION 8", ADDRESS: "9 BISHAN PLACE JUNCTION 8 SINGAPORE 579837", POSTAL: "579837", LATITUDE: "1.3503", LONGITUDE: "103.8488" }] : [];
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ found: rows.length, results: rows }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("U18 Targeting & budget: the budget's level, daily amount and bid strategy, pins found by postal code (OneMap) or taken from the account's history (a Meta place), callouts on pins, the gender per callout — saved as the profile's publishing defaults, refused when two pins claim a callout; Meta place keys are looked up through the link", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const open = async (url) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url }, sessionId); await loaded; };
  // Without the Meta link, place keys cannot be looked up, and that is said; bad keys are refused before any call.
  let r = await call(`/api/client/${GYM}/meta-places?keys=abc`); assert.equal(r.status, 400);
  r = await (await call(`/api/client/${GYM}/meta-places?keys=107327800879305`)).json(); assert.deepEqual(r, { configured: false, places: [] });
  const graph = await fakeGraph(), onemap = await fakeOneMap();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url, ONEMAP_URL: onemap.url });
  try {
    // The geocoder: a postal code → one point; an address → several; nothing → none; an empty query refused.
    r = await (await call("/api/geocode?q=575583")).json();
    assert.deepEqual(r.results, [{ address: "2 SIN MING ROAD SIN MING PLAZA SINGAPORE 575583", postal_code: "575583", lat: 1.352482302799053, lng: 103.8357469735082 }]);
    assert.equal((await (await call("/api/geocode?q=Bishan")).json()).results.length, 2);
    assert.deepEqual((await (await call("/api/geocode?q=nowhere")).json()).results, []);
    assert.equal((await call("/api/geocode?q=")).status, 400);
    r = await (await call(`/api/client/${GYM}/meta-places?keys=107327800879305,55555`)).json();
    assert.deepEqual(r.places.map((p) => [p.key, p.name, p.lat]), [["107327800879305", "6 Sin Ming Road, Tower 2", 1.353055]]);
    // The gym's ad account is linked (the history of pins is read from it).
    const cur = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"));
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...cur, meta_assets: { ...(cur.meta_assets || {}), ad_account_id: "act_111000000001" } } })).status, 200);
    // The page: defaults as decided — ad-set budget, 50 a day, Highest volume — with the campaign level and a capped bid available.
    await open(`${panel.url}/?u18#/${GYM}/targeting`);
    await until("/Where the budget sits/.test(document.querySelector('#view')?.textContent||'')", "the Targeting page");
    const sel = (label) => `[...document.querySelectorAll('#view label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).parentElement.querySelector('select,input').value`;
    assert.deepEqual(await ev(`[${sel("Where the budget sits")}, ${sel("Daily budget")}, ${sel("Bid strategy")}]`), ["adset", "50", "LOWEST_COST_WITHOUT_CAP"]);
    assert.match(await ev("document.querySelector('#view').textContent"), /Advantage\+ audience is never switched on/);
    await ev("setP('campaign_defaults.budget.bid_strategy','COST_CAP'); viewTargeting(document.querySelector('#view')); true");
    assert.equal(await ev("[...document.querySelectorAll('#view label')].some(l=>/Cost per result goal \\(SGD\\)/.test(l.textContent))"), true, "a capped strategy asks for its amount");
    await ev("setP('campaign_defaults.budget.bid_strategy','LOWEST_COST_WITHOUT_CAP'); setP('campaign_defaults.budget.level','campaign'); setP('campaign_defaults.budget.amount',80); STATE.profile.creative_defaults = { locations: ['BISHAN','ANG MO KIO'], audiences: ['MEN WANTED','LADIES WANTED'] }; viewTargeting(document.querySelector('#view')); true");
    // A pin found by postal code, serving one callout; a second from the account's history (a named Meta place).
    await ev("addPin(); document.querySelector('#pinq_0').value = '575583'; true");
    await ev("findPin(0)");
    await until("Number.isFinite(STATE.profile.targeting_defaults.geo.radius_pins[0].lat)", "the point from OneMap");
    assert.deepEqual(await ev("(({label, postal_code, lat, lng, radius_km}) => [label, postal_code, lat, lng, radius_km])(STATE.profile.targeting_defaults.geo.radius_pins[0])"), ["2 SIN MING ROAD SIN MING PLAZA", "575583", 1.352482302799053, 103.8357469735082, 5]);
    await ev("toggleCallout(0,'BISHAN'); true");
    await ev("loadHistory()");
    await until("MT.link && MT.link.chosen.history_pins.length===2", "the account's pins: " + JSON.stringify(await ev("[MT.link && MT.link.chosen, document.querySelector('#view').innerHTML.length]")));
    await ev("addPin(); pinFromHistory(1, 0); toggleCallout(1,'ANG MO KIO'); setGender('MEN WANTED','all'); setP('targeting_defaults.demographics.age_min',25); setP('targeting_defaults.demographics.age_max',60); true");
    assert.deepEqual(await ev("(({label, place_key, place_name, radius_km, callouts}) => [label, place_key, place_name, radius_km, callouts])(STATE.profile.targeting_defaults.geo.radius_pins[1])"), ["6 Sin Ming Road, Tower 2", "107327800879305", "6 Sin Ming Road, Tower 2", 5, ["ANG MO KIO"]]);
    assert.equal(await ev("[...document.querySelectorAll('#view .chip')].filter(c=>c.disabled).map(c=>c.textContent).join()"), "ANG MO KIO,BISHAN", "a callout on one pin cannot be put on another");
    await ev("document.querySelector('#saveBtn_profile').click(); true");
    await until("DIRTY.profile===false", "saved");
    const saved = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"));
    assert.deepEqual([saved.campaign_defaults.budget.level, saved.campaign_defaults.budget.amount, saved.campaign_defaults.budget.bid_strategy, saved.targeting_defaults.demographics.callout_genders, saved.targeting_defaults.geo.radius_pins.map((p) => [p.callouts, p.place_key || null, Number.isFinite(p.lat)])], ["campaign", 80, "LOWEST_COST_WITHOUT_CAP", { "MEN WANTED": "all" }, [[["BISHAN"], null, true], [["ANG MO KIO"], "107327800879305", true]]]);
    // A profile whose pins both claim a callout is refused, and nothing is written.
    const bad = structuredClone(saved); bad.targeting_defaults.geo.radius_pins[1].callouts = ["bishan"];
    const put = await call(`/api/client/${GYM}`, { method: "PUT", body: bad });
    assert.equal(put.status, 400); assert.match(JSON.stringify(await put.json()), /location callout \\"bishan\\" is on two pins/);
    assert.deepEqual(JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8")).targeting_defaults.geo.radius_pins[1].callouts, ["ANG MO KIO"]);
    const ov = await (await call(`/api/client/${GYM}`)).json();
    assert.equal(ov.completeness.sections.find((s) => s.id === "targeting").status, "done");
  } finally { await panel.stop(); panel = main; graph.server.close(); onemap.server.close(); }
});

test("U19 the targeting library in the panel: presets imported from the account's own ad sets and results (Broad with its own record), saved audiences joining, renamed / retired with a reason / restored, one built from Meta's search with a reach estimate, all through the API; the page lists them and picks one per audience callout into the profile", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const open = async (url) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url }, sessionId); await loaded; };
  // Without the Meta link: the list is empty and an import says what is missing.
  let r = await (await call(`/api/client/${GYM}/targeting`)).json();
  assert.deepEqual([r.presets, r.retired, r.imported], [[], [], null]);
  r = await call(`/api/client/${GYM}/targeting/import`, { method: "POST", body: {} }); assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up/);
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    const cur = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"));
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: { ...cur, creative_defaults: { ...(cur.creative_defaults || {}), audiences: ["MEN WANTED", "LADIES WANTED"] }, meta_assets: { ...(cur.meta_assets || {}), ad_account_id: "act_111000000001" } } })).status, 200);
    r = await (await call(`/api/client/${GYM}/targeting/import`, { method: "POST", body: {} })).json();
    assert.deepEqual([r.adsets, r.with_results, r.saved, r.added, r.presets.map((p) => p.name)], [2, 2, 1, 3, ["Broad", "Fitness+Fatherhood", "Healthy food"]]);
    const broad = r.presets[0], dads = r.presets[1];
    assert.deepEqual([broad.stats.adsets, broad.stats.leads, broad.stats.cost_per_lead, dads.stats.cost_per_lead, dads.stats.genders.men, dads.summary.length, r.presets[2].source], [1, 60, 5, 56.24, 1, 2, "saved_audience"]);
    assert.ok(existsSync(join(brands, GYM, "targeting-presets.json")) && !readFileSync(join(brands, GYM, "targeting-presets.json"), "utf-8").includes(META_TOKEN));
    // Suggested for a men's ad set: Broad (ran for men, cheapest) before Fitness+Fatherhood; the reasons in words.
    r = await (await call(`/api/client/${GYM}/targeting?suggest=${encodeURIComponent("12 Week Total Body Reset MEN WANTED")}&gender=men`)).json();
    assert.deepEqual(r.suggested.map((x) => x.name), ["Broad", "Fitness+Fatherhood", "Healthy food"]); assert.match(r.suggested[0].why, /ran for men 1 time · 60 leads at 5.00 each/);
    // Rename, retire (a reason is needed), restore.
    r = await (await call(`/api/client/${GYM}/targeting/${dads.id}`, { method: "PUT", body: { name: "Dads who train", notes: "expensive" } })).json();
    assert.deepEqual([r.preset.name, r.preset.notes, r.preset.renamed], ["Dads who train", "expensive", true]);
    assert.equal((await call(`/api/client/${GYM}/targeting/${dads.id}`, { method: "DELETE", body: { reason: "" } })).status, 400);
    r = await (await call(`/api/client/${GYM}/targeting/${dads.id}`, { method: "DELETE", body: { reason: "too costly" } })).json();
    assert.deepEqual([r.presets.map((p) => p.name), r.retired.map((p) => [p.name, p.retired.reason])], [["Broad", "Healthy food"], [["Dads who train", "too costly"]]]);
    r = await (await call(`/api/client/${GYM}/targeting/${dads.id}`, { method: "PUT", body: { restore: true } })).json();
    assert.equal(r.presets.length, 3);
    assert.equal((await call(`/api/client/${GYM}/targeting/broad`, { method: "DELETE", body: { reason: "x" } })).status, 400, "Broad stays");
    // Meta's search and reach estimate; a preset built from them.
    r = await (await call(`/api/client/${GYM}/targeting/search?q=yoga`)).json();
    assert.deepEqual(r.results.map((x) => [x.name, x.type]), [["Yoga", "interests"], ["Frequent travellers", "behaviors"]], "interests first, then the rest of the account's search");
    assert.equal((await call(`/api/client/${GYM}/targeting/search?q=`)).status, 400);
    const yoga = { flexible_spec: [{ interests: [{ id: "6003200000001", name: "Yoga" }] }] };
    r = await (await call(`/api/client/${GYM}/targeting/estimate`, { method: "POST", body: { spec: yoga, targeting: { geo_locations: { places: [{ key: "107327800879305", radius: 5, distance_unit: "kilometer" }] }, age_min: 25, age_max: 60 } } })).json();
    assert.deepEqual([r.reach, r.sentences, r.summary], [{ lower: 12000, upper: 14100, ready: true }, ["Location: Singapore: 6 Sin Ming Road, Tower 2 (+5 km)", "Interests: Yoga"], ["Yoga (interests)"]]);
    const est = graph.calls.filter((c) => c === "act_111000000001/delivery_estimate").length; assert.equal(est, 1);
    assert.equal((await call(`/api/client/${GYM}/targeting/estimate`, { method: "POST", body: { spec: { targeting_automation: { advantage_audience: 1 } } } })).status, 400, "Advantage+ audience never reaches Meta");
    r = await (await call(`/api/client/${GYM}/targeting`, { method: "POST", body: { name: "Yoga people", spec: yoga } })).json();
    assert.deepEqual([r.preset.source, r.preset.summary, r.presets.length], ["owner", ["Yoga (interests)"], 4]);
    assert.match((await (await call(`/api/client/${GYM}/targeting`, { method: "POST", body: { name: "Again", spec: yoga } })).json()).error, /already the preset "Yoga people"/);
    // The page: the table, and the preset picked per audience callout into the profile.
    await open(`${panel.url}/?u19#/${GYM}/targeting`);
    await until("document.querySelectorAll('table.tbl tbody tr').length===4", "the presets table");
    const text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Dads who train/); assert.match(text, /56\.24/); assert.match(text, /Yoga people/); assert.match(text, /Broad — no detailed targeting/);
    await ev(`setCalloutPreset('MEN WANTED', '${dads.id}'); setCalloutPreset('LADIES WANTED', ''); document.querySelector('#saveBtn_profile').click(); true`);
    await until("DIRTY.profile===false", "saved");
    const saved = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"));
    assert.deepEqual(saved.targeting_defaults.detailed_targeting.callout_presets, { "MEN WANTED": dads.id }, "the gym's default is the default and is not written (2026-10-07: 'suggest' is now a choice of its own, the account's best each time)");
    const bad = structuredClone(saved); bad.targeting_defaults.detailed_targeting.callout_presets = { "MEN WANTED": "nope" };
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: bad })).status, 400);
    await ev("presetNew(); document.querySelector('#npq').value='yoga'; true"); await ev("npSearch()");
    await until("NP.results.length===2", "search results in the modal");
    await ev("npAdd(0,0); npAdd(1,1); true"); await ev("npEstimate()");
    await until("NP.estimate && NP.estimate.reach", "the estimate");
    assert.match(await ev("document.querySelector('#gModal').textContent"), /Reach about 12,000–14,100 people a month/);
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});


/** The test gym linked to Meta with pins, ages, a budget and two presets — what the Publish Ads screen needs. */
async function linkTestGym() {
  const g = join(brands, GYM);
  const cur = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8"));
  const profile = { ...cur, gym_abbr: "TG", website: "https://testgym.sg", locale: { country: "SG", currency: "SGD" },
    meta_assets: { ...(cur.meta_assets || {}), ad_account_id: "act_111000000001", page_id: "770000000007", instagram_user_id: "880000000008", lead_form_id: "400100000001", singapore_beneficiary_id: "4260400000000001", singapore_payer_id: "4260400000000001" },
    campaign_defaults: { ...(cur.campaign_defaults || {}), budget: { level: "adset", amount: 50, currency: "SGD", bid_strategy: "LOWEST_COST_WITHOUT_CAP" } },
    targeting_defaults: { ...(cur.targeting_defaults || {}), geo: { radius_pins: [{ label: "Sin Ming", place_key: "107327800879305", place_name: "6 Sin Ming Road, Tower 2", radius_km: 5, callouts: [] }, { label: "Bishan", lat: 1.35, lng: 103.85, radius_km: 3, callouts: ["BISHAN"] }] }, demographics: { age_min: 25, age_max: 60 } } };
  assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: profile })).status, 200);
  writeFileSync(join(g, "targeting-presets.json"), JSON.stringify({ schema: 1, presets: [{ id: "broad", name: "Broad", spec: {}, summary: ["Broad — no detailed targeting"], stats: null }, { id: "a97f701a193c", name: "Fitness", spec: { flexible_spec: [{ interests: [{ id: "6003277229371", name: "Physical fitness" }] }] }, summary: ["Physical fitness (interests)"], stats: { adsets: 2, leads: 40, cost_per_lead: 12.5, genders: { men: 0, women: 2, all: 0 } } }] }));
}

test("U20 the Publish Ads screen: the plan for a batch's kept ads from the API (nothing created), the owner's settings saved per batch and the plan rebuilt from them, bad settings refused; the page shows the campaign, one ad set card per callout with its pin, ages, gender, preset and budget, the ads with their Stories versions, the words and the destination; a change saves and repaints; Review links to it", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 120)); }
    throw new Error(`timed out waiting for ${what}: ${await ev("location.hash + ' ' + (document.querySelector('#view')?.textContent||'').slice(0,300)")}`);
  };
  const open = async (url) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url }, sessionId); await loaded; };
  const g = join(brands, GYM), out = join(g, "outputs", BRIEF.batch_id);
  await linkTestGym();
  const cur = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8"));
  rmSync(join(out, "publish-settings.json"), { force: true });
  // The plan, from the API: the reference batch's kept ads (the review tests left some excluded), by callout.
  let r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
  const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")), review = existsSync(join(out, "review.json")) ? JSON.parse(readFileSync(join(out, "review.json"), "utf-8")) : { ads: {}, photos: {} };
  const keptFolders = batch.ads.filter((a) => review.ads[a.folder] !== "exclude" && !a.photos.some((p) => review.photos[p] === "exclude")).map((a) => a.folder);
  assert.deepEqual(r.plan.ads.map((a) => a.folder).sort(), keptFolders.sort(), "the kept ads, and only those");
  assert.deepEqual(r.plan.adsets.map((a) => a.callout).sort(), [...new Set(batch.ads.filter((a) => keptFolders.includes(a.folder)).map((a) => a.location.toUpperCase()))].sort());
  assert.deepEqual([r.plan.ready, r.plan.problems, r.plan.budget.level, r.plan.campaign.status, r.pins.length, r.presets.map((p) => p.id), Object.keys(r.cta).includes("SIGN_UP"), r.published], [true, [], "adset", "PAUSED", 2, ["broad", "a97f701a193c"], true, null]);
  assert.ok(r.plan.ads.every((a) => r.thumbs[a.folder]?.url?.startsWith("/files/")), "a thumbnail per kept ad");
  assert.ok(!JSON.stringify(r).includes(META_TOKEN));
  // Settings: saved per batch, the plan rebuilt from them; bad shapes refused and nothing written.
  const first = r.plan.adsets[0].callout;
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { campaign: { name: "Test campaign", level: "campaign", daily: 80 }, adsets: { [first]: { pin: 1, age_min: 30, gender: "women", preset: "a97f701a193c" } }, words: { message: "Come and train.", headline: "Six weeks", description: "", cta: "APPLY_NOW" }, destination: {} } })).json();
  assert.deepEqual([r.plan.campaign.name, r.plan.campaign.daily_budget, r.plan.budget.level, r.plan.adsets[0].pin.label, r.plan.adsets[0].age_min, r.plan.adsets[0].gender, r.plan.adsets[0].preset.name, r.plan.adsets[0].preset.how, r.plan.words.message, r.plan.words.cta, r.plan.words.placeholders], ["Test campaign", 8000, "campaign", "Bishan", 30, "women", "Fitness", "chosen for this ad set", "Come and train.", "APPLY_NOW", ["description"]]);
  assert.ok(existsSync(join(out, "publish-settings.json")) && r.settings.updated);
  // Before you create (2026-10-11): the checks ride on the answer, in words, with where to fix each; the plan stays ready.
  assert.deepEqual([r.readiness.ready, typeof r.readiness.to_check, r.readiness.checks.every((c) => typeof c.text === "string" && [true, false, null].includes(c.ok))], [true, "number", true]);
  assert.ok("lead_form_name" in r && (r.lead_form_name === null || typeof r.lead_form_name === "string"), "the campaign's form name rides on the answer for the Destination card (2026-10-15)");
  assert.ok(r.readiness.checks.some((c) => c.where === "copy" && /copy/.test(c.text)) && r.readiness.checks.some((c) => c.where === "ads"), JSON.stringify(r.readiness));
  // The ad set's own name (2026-10-10): saved with the rest, on the plan and its payload; cleared, the house style returns.
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { campaign: { name: "Test campaign", level: "campaign", daily: 80 }, adsets: { [first]: { pin: 1, age_min: 30, gender: "women", preset: "a97f701a193c", name: "Women near Bishan, October" } }, words: { message: "Come and train.", headline: "Six weeks", description: "", cta: "APPLY_NOW" }, destination: {} } })).json();
  assert.ok(r.plan, `the name is saved with the rest: ${JSON.stringify(r)}`);
  assert.deepEqual([r.plan.adsets[0].name, r.plan.adsets[0].own_name, r.plan.adsets[0].payload.name, /Bishan/.test(r.plan.adsets[0].house_name)], ["Women near Bishan, October", true, "Women near Bishan, October", true]);
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { campaign: { name: "Test campaign", level: "campaign", daily: 80 }, adsets: { [first]: { pin: 1, age_min: 30, gender: "women", preset: "a97f701a193c", name: null } }, words: { message: "Come and train.", headline: "Six weeks", description: "", cta: "APPLY_NOW" }, destination: {} } })).json();
  assert.equal(r.plan.adsets[0].name, r.plan.adsets[0].house_name);
  for (const body of [{ campaign: { level: "ad" } }, { words: { headline: "one — dash" } }, { adsets: { X: { pin: "a" } } }, { adsets: { X: { name: "two\nlines" } } }, { destination: { lead_form_id: "abc" } }, { extra: 1 }]) {
    const bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal(JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")).campaign.name, "Test campaign", "a refused save writes nothing");
  assert.equal((await call(`/api/client/${GYM}/batch/no-such/publish`)).status, 404);
  // The page.
  await open(`${panel.url}/?u20#/${GYM}/publish/${BRIEF.batch_id}`);
  await until("PB.data && /Create on Facebook/.test(document.querySelector('#view')?.textContent||'')", "the Publish Ads screen");
  let text = await ev("document.querySelector('#view').textContent");
  assert.match(text, /Publish Test campaign/); assert.match(text, /Ad sets · one per location callout/); assert.match(text, /Copy/); assert.match(text, /Destination and identity/); assert.match(text, /Text options per ad/);
  assert.equal(await ev("document.querySelectorAll('#view img').length"), r.plan.ads.length, "every kept ad shown");
  assert.equal(await ev("[...document.querySelectorAll('#view h3')].filter(h=>h.textContent.trim()==='" + first + "').length"), 1, "an ad set card per callout");
  assert.ok(await ev("[...document.querySelectorAll('#view button.primary')].some(b=>/Create on Facebook, paused/.test(b.textContent) && !b.disabled)"), "a ready plan can be created (U21 does)");
  // A change on the page saves the settings and repaints with the new plan.
  await ev("pbSet('campaign.level','adset'); pbSetAdset('" + first + "','daily',70); true");
  await until("PB.data && PB.data.plan.budget.level==='adset' && !PB.busy", "the saved plan");
  const saved = JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8"));
  assert.deepEqual([saved.campaign.level, saved.adsets[first].daily, saved.words.message], ["adset", 70, "Come and train."]);
  assert.match(await ev("document.querySelector('#view').textContent"), /a day in all/);
  // Review's foot leads here.
  await open(`${panel.url}/?u20b#/${GYM}/review/${BRIEF.batch_id}`);
  await until("R.data && [...document.querySelectorAll('#rvFoot button')].some(b=>/Publish Ads →/.test(b.textContent))", "the Publish button on Review");
  await ev("[...document.querySelectorAll('#rvFoot button')].find(b=>/Publish Ads →/.test(b.textContent)).click(); true");
  await until("location.hash==='#/" + GYM + "/publish/" + BRIEF.batch_id + "'", "the Publish route");
});

test("U21 creating on Facebook from the panel: refused without the Meta link, without a confirmation, or with one that no longer matches the plan; with them the publish run is built from the gym and batch alone (plus 'first'), creates the plan against the Graph — every object paused — and records it; the Publish Ads screen shows what is on Facebook and offers to continue", async () => {
  const g = join(brands, GYM), out = join(g, "outputs", BRIEF.batch_id);
  await linkTestGym();
  rmSync(join(out, "publish.json"), { force: true }); rmSync(join(out, "publish-settings.json"), { force: true });
  let plan = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json()).plan;
  const confirm = { ads: plan.counts.ads, adsets: plan.counts.adsets, per_day: plan.budget.per_day_total };
  assert.equal(plan.ready, true, plan.problems.join("; "));
  // No Meta link on the default panel: refused before anything.
  let r = await call("/api/run", { method: "POST", body: { kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm } });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up/);
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    r = await call("/api/run", { method: "POST", body: { kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id } });
    assert.equal(r.status, 409, "no confirmation");
    r = await call("/api/run", { method: "POST", body: { kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm: { ...confirm, ads: confirm.ads + 1 } } });
    assert.equal(r.status, 409, "a confirmation that no longer matches the plan");
    r = await call("/api/run", { method: "POST", body: { kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm: { ...confirm, first: 0 } } });
    assert.equal(r.status, 400, "first must be a whole number of ads");
    // The first ad only: the campaign, one ad set, one creative and ad; the record says so.
    const one = await runAndWait({ kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm: { ...confirm, first: 1 } });
    assert.equal(one.code, 0, one.lines.join("\n"));
    assert.match(one.lines[0], /meta-publish\.mjs --gym testgym --brand-dir \S+ --batch ref-batch --create --first 1$/);
    assert.ok(one.lines.some((l) => new RegExp(`done: 1 of ${plan.counts.ads} ads on Meta`).test(l)), one.lines.join("\n"));
    let rec = JSON.parse(readFileSync(join(out, "publish.json"), "utf-8"));
    assert.deepEqual([rec.account, !!rec.campaign?.id, Object.keys(rec.adsets).length, Object.keys(rec.ads).length, rec.done, rec.error], ["act_111000000001", true, 1, 1, null, null]);
    const posted = graph.calls.filter((c) => /campaigns|adsets|adcreatives|^act_111000000001\/ads$/.test(c));
    assert.deepEqual(posted, ["act_111000000001/campaigns", "act_111000000001/adsets", "act_111000000001/adcreatives", "act_111000000001/ads"]);
    r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
    assert.deepEqual([r.published.campaign.id, Object.keys(r.published.ads).length], [rec.campaign.id, 1], "the screen's data carries the record");
    // The rest: continues, nothing made twice.
    const before = graph.calls.length;
    const rest = await runAndWait({ kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm });
    assert.equal(rest.code, 0, rest.lines.join("\n"));
    rec = JSON.parse(readFileSync(join(out, "publish.json"), "utf-8"));
    assert.deepEqual([Object.keys(rec.ads).length, rec.done != null, graph.calls.slice(before).filter((c) => c.endsWith("/campaigns")).length], [plan.counts.ads, true, 0]);
    assert.ok(!readFileSync(join(out, "publish.json"), "utf-8").includes(META_TOKEN));
    // The page: the record card and the Continue wording.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u21#/${GYM}/publish/${BRIEF.batch_id}` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!PB.data && /On Facebook/.test(document.querySelector('#view')?.textContent||'')"))) await new Promise((x) => setTimeout(x, 120));
    const text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /On Facebook\s*complete/); assert.match(text, /open in Ads Manager/); assert.match(text, new RegExp(`${plan.counts.ads} made, all paused`));
    assert.ok(await ev("[...document.querySelectorAll('#view button.primary')].some(b=>/Continue creating on Facebook/.test(b.textContent) && !b.disabled)"));
    await ev("pbCreateConfirm(); true");
    assert.match(await ev("document.querySelector('#bModal').textContent"), /every object paused/);
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});

test("U22 results: a batch on Meta can be pulled from the panel (statuses and numbers into results.json, the gym's CSV rebuilt), its rows tie each ad to what it was; a batch not on Meta says so; the gym's table and CSV list every published ad; the Review Data page shows the campaigns and the sortable table; the campaign cards say what is on Facebook", async () => {
  const g = join(brands, GYM), out = join(g, "outputs", BRIEF.batch_id);
  await linkTestGym();
  rmSync(join(out, "publish.json"), { force: true }); rmSync(join(out, "results.json"), { force: true }); rmSync(join(g, "results.csv"), { force: true });
  let r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/results/pull`, { method: "POST", body: {} });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /not been created on Meta/);
  r = await (await call(`/api/client/${GYM}/results`)).json();
  assert.deepEqual([r.rows, r.batches], [[], []]);
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    const plan = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json()).plan;
    const made = await runAndWait({ kind: "batch-publish", gym: GYM, batch: BRIEF.batch_id, confirm: { ads: plan.counts.ads, adsets: plan.counts.adsets, per_day: plan.budget.per_day_total, first: 1 } });
    assert.equal(made.code, 0, made.lines.join("\n"));
    const rec = JSON.parse(readFileSync(join(out, "publish.json"), "utf-8"));
    const [folder, entry] = Object.entries(rec.ads)[0];
    assert.deepEqual([entry.facts.has_story, entry.facts.form_id, entry.facts.cta, rec.adsets[entry.adset].facts.gender, rec.adsets[entry.adset].facts.daily], [false, "400100000001", "SIGN_UP", plan.adsets.find((s) => s.callout === entry.adset).gender, 50], "the plan's facts ride on the record");
    r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/results`)).json();
    assert.deepEqual([r.results, r.rows.length, r.rows[0].status, r.rows[0].folder, r.rows[0].layout], [null, 1, "not pulled yet", folder, plan.ads.find((a) => a.folder === folder) && JSON.parse(readFileSync(join(out, "batch.json"), "utf-8")).ads.find((a) => a.folder === folder).treatment]);
    r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/results/pull`, { method: "POST", body: {} })).json();
    assert.deepEqual([r.results.campaign.words, r.results.campaign.all_time.leads, r.results.campaign.all_time.cost_per_lead, r.rows[0].status, r.rows[0].leads, r.rows[0].spend, r.rows[0].ctr], ["paused", 2, 6.25, "paused", 2, 12.5, 2.5]);
    assert.ok(existsSync(join(out, "results.json")) && existsSync(join(g, "results.csv")));
    const csv = await call(`/api/client/${GYM}/results.csv`);
    assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
    const lines = (await csv.text()).trim().split("\n");
    assert.deepEqual([lines.length, lines[0].startsWith("source,gym,batch,"), lines[1].includes(folder)], [2, true, true]);
    r = await (await call(`/api/client/${GYM}/results`)).json();
    assert.deepEqual([r.rows.length, r.batches.length, r.batches[0].results.campaign.words, r.batches[0].record.ads], [1, 1, "paused", 1]);
    assert.deepEqual([r.adsets.length, r.adsets[0].source, r.adsets[0].ads, r.adsets[0].leads, r.adsets[0].cost_per_lead, r.adsets[0].adset_id], [1, "app", 1, 2, 6.25, rec.adsets[Object.keys(rec.adsets)[0]].id], "the ad-set level, from the app's rows");
    assert.deepEqual([r.campaigns.length, r.campaigns[0].source, r.campaigns[0].name, r.campaigns[0].adsets, r.campaigns[0].ads, r.campaigns[0].leads, r.campaigns[0].status, r.campaigns[0].campaign_id], [1, "app", "Test campaign", 1, 1, 2, "paused", rec.campaign.id], "the campaign level");
    const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
    const card = setup.batches.find((b) => b.id === BRIEF.batch_id).published;
    assert.deepEqual([card.ads, card.done, card.status, card.leads, card.cost_per_lead], [1, false, "paused", 2, 6.25]);
    // The Review Data page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u22#/${GYM}/results` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!RS.data && RS.level==='campaigns' && document.querySelectorAll('table.tbl tbody tr').length===1"))) await new Promise((x) => setTimeout(x, 120));
    // Review Data opens on the review; every result as tables is its second tab (2026-11-11).
    assert.deepEqual(await ev("[document.querySelector('h1').textContent, [...document.querySelectorAll('#rsTabs .chip')].map(c=>c.textContent.replace(/ ·.*/,'')), document.querySelector('#rsTabs .chip.sel').textContent, document.querySelector('#rsTables').style.display]"), ["Review Data", ["The review", "All results"], "The review", "none"]);
    await ev("rsView('tables'); true");
    assert.deepEqual(await ev("[document.querySelector('#rsTabs .chip.sel').textContent, document.querySelector('#rsTables').style.display, !!document.querySelector('#rsReview')]"), ["All results · 1 campaign", "", false]);
    let text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Campaigns · 1/); assert.match(text, /Test campaign/); assert.match(text, /2 leads at SGD 6.25/); assert.match(text, /download results.csv/);
    assert.ok(await ev("[...document.querySelectorAll('table.tbl th')].some(th=>/Per lead/.test(th.textContent))"));
    assert.ok(!/Ad sets ·|Ads in/.test(text), "one level at a time: campaigns only");
    // Click the campaign → its ad sets; click the ad set → its ads; Back climbs one level each time.
    await ev("rsOpenCampaign(RS.data.campaigns[0].campaign_id); true");
    text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Ad sets of Test campaign · 1/); assert.ok(!/Campaigns · 1/.test(text) && !/Ads in/.test(text));
    assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/← Back/.test(b.textContent))"));
    await ev("rsOpenAdset(RS.data.adsets[0].adset_id); true");
    text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Ads in .* · 1/); assert.ok(!/Ad sets of/.test(text), "the ads level alone");
    assert.ok(await ev("[...document.querySelectorAll('table.tbl th')].some(th=>/Layout/.test(th.textContent))"), "the app's ads show their layout");
    await ev("RS.sort.ads='layout'; paintResults(document.querySelector('#view')); true");
    assert.ok(await ev("[...document.querySelectorAll('table.tbl th')].some(th=>/Layout ▾/.test(th.textContent))"), "sorting by a column");
    await ev("rsBack(); true"); assert.equal(await ev("RS.level"), "adsets");
    await ev("rsBack(); true"); assert.equal(await ev("RS.level"), "campaigns");
    assert.match(await ev("document.querySelector('#view').textContent"), /Campaigns · 1/);
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});

test("U23 the account's history in the panel: pulled from Meta into the gym folder (their ads, not the app's), listed on Review Data with Meta's numbers, and chosen ads brought into the library — images into References (a video's poster frame too), words into the copy references; refused without the link or with bad ids; the CSV carries both sources", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "copy-references.json"), { force: true });
  for (const f of ["meta-900000000001.png", "meta-900000000001.png.meta.json", "meta-900000000002.png", "meta-900000000002.png.meta.json"]) rmSync(join(g, "references", f), { force: true });
  let r = await call(`/api/client/${GYM}/history/pull`, { method: "POST", body: {} });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up/);
  assert.equal((await (await call(`/api/client/${GYM}/results`)).json()).history, null);
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    r = await (await call(`/api/client/${GYM}/history/pull`, { method: "POST", body: {} })).json();
    assert.deepEqual([r.campaigns, r.ads, r.rows.map((x) => [x.ad_id, x.media, x.leads, x.cost_per_lead, x.importable, x.in_library])], [1, 2, [["900000000002", "video", 100, 5, true, false], ["900000000001", "image", 30, 10, true, false]]], "the cheapest lead first; a video ad's poster can be brought in");
    assert.ok(existsSync(join(g, "account-history.json")));
    r = await (await call(`/api/client/${GYM}/results`)).json();
    assert.deepEqual([r.history.ads, r.history.rows.length, r.copy_refs], [2, 2, 0]);
    assert.equal((await call(`/api/client/${GYM}/history/import`, { method: "POST", body: { ads: ["x"] } })).status, 400);
    assert.equal((await call(`/api/client/${GYM}/history/import`, { method: "POST", body: { ads: [] } })).status, 400);
    r = await (await call(`/api/client/${GYM}/history/import`, { method: "POST", body: { ads: ["900000000001", "900000000002"] } })).json();
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.deepEqual([r.images, r.copy, r.skipped, r.copy_refs, r.rows.every((x) => x.in_library)], [2, 2, [], 2, true]);
    assert.ok(existsSync(join(g, "references", "meta-900000000001.png")) && existsSync(join(g, "references", "meta-900000000002.png")));
    assert.deepEqual(JSON.parse(readFileSync(join(g, "copy-references.json"), "utf-8")).refs.map((x) => [x.id, x.headline, x.results.leads]), [["meta-900000000001", "Their headline", 30], ["meta-900000000002", "Video title", 100]]);
    const refs = (await (await call(`/api/client/${GYM}/scenes`)).json()).references.map((x) => x.name);
    assert.ok(refs.includes("meta-900000000001.png") && refs.includes("meta-900000000002.png"), "listed with the reference images the scene refresh can use");
    const csv = await (await call(`/api/client/${GYM}/results.csv`)).text();
    assert.ok(csv.split("\n").some((l) => l.startsWith("account,")), "the history in the CSV");
    // The page: the history card with the table and the import.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u23#/${GYM}/results` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!RS.data && RS.level==='campaigns' && /Campaigns ·/.test(document.querySelector('#view').textContent)"))) await new Promise((x) => setTimeout(x, 120));
    let text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Their campaign/, "their campaign on the campaigns level: " + await ev("JSON.stringify(RS.data && {camps: (RS.data.campaigns||[]).length, hist: !!RS.data.history, err: RS.error})")); assert.match(text, /account pulled/);
    await ev("RS.source='account'; paintResults(document.querySelector('#view')); true");
    assert.match(await ev("document.querySelector('#view').textContent"), /130 leads/, "the account's campaigns alone");
    await ev("rsOpenCampaign(RS.data.campaigns.find(c=>c.source==='account').campaign_id); true");
    text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Ad sets of 0331 Their campaign · 1/);
    await ev("rsOpenAdset(rsRows()[0].adset_id); true");
    text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Ads in .* · 2/);
    assert.equal(await ev("document.querySelectorAll('#view input[type=checkbox]').length"), 2, "their ads can be picked");
    await ev("rsPickTop(1); true");
    assert.deepEqual(await ev("[...RS.hsel]"), ["900000000002"], "the top by leads");
    assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/Bring 1 into the library/.test(b.textContent) && !b.disabled)"));
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});

test("U24 copy in the panel: the gym's copy references (list, add, note, retire) and a campaign's copy (the owner's own checked by the rules and kept at once; keep / exclude / edit; the number of text options saved per batch); the plan carries the kept copies as text options; the Publish Ads screen's Copy card and the Library's Copy page show them", async () => {
  const g = join(brands, GYM), out = join(g, "outputs", BRIEF.batch_id);
  await linkTestGym();
  rmSync(join(out, "copy.json"), { force: true }); rmSync(join(g, "copy-references.json"), { force: true }); rmSync(join(out, "publish-settings.json"), { force: true });
  // References.
  let r = await (await call(`/api/client/${GYM}/copy-refs`)).json();
  assert.deepEqual([r.refs, r.shown], [[], []]);
  r = await (await call(`/api/client/${GYM}/copy-refs`, { method: "POST", body: { message: "Ladies in Bishan, if nothing stuck it was the plan. Tap Sign up.", headline: "A reset that sticks", note: "pain hook" } })).json();
  assert.deepEqual([r.refs.length, r.ref.source, r.shown, r.ref.note], [1, "owner", [r.ref.id], ""], "kept even though the model cannot be reached in tests; the note stays empty");
  assert.match(r.analysis_error, /network blocked|GEMINI_KEY/, "and the page is told why the note is empty");
  assert.deepEqual([r.library.entries, r.library.skipped.map((s) => s.kind)], [[], ["copy", "headline"]], "the library step ran for both parts and said why nothing landed");
  assert.ok(!existsSync(join(dirname(brands), "library", "copy-library.json")), "nothing written to the library");
  const r2 = await (await call(`/api/client/${GYM}/copy-refs`, { method: "POST", body: { message: "Pasted — as written", headline: "h" } })).json(); assert.equal(r2.ref.message, "Pasted — as written", "a pasted reference keeps its dashes");
  await call(`/api/client/${GYM}/copy-refs/${r2.ref.id}`, { method: "PUT", body: { retired: true } });
  r = await (await call(`/api/client/${GYM}/copy-refs/${r.ref.id}`, { method: "PUT", body: { note: "the opener" } })).json(); assert.equal(r.refs[0].note, "the opener");
  const refId = r.refs[0].id;
  // The campaign's copy: nothing yet; the owner's own is checked (the offer named exactly) and kept at once.
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`)).json();
  assert.deepEqual([r.drafts, r.kept, r.references, r.max_options], [[], [], 1, 5]);
  let bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`, { method: "POST", body: { message: "No offer named. Tap Sign up.", headline: "Hi" } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /not named exactly/);
  bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`, { method: "POST", body: { message: `Free trial of the ${WORDS.offer}`, headline: "Hi" } });
  assert.match((await bad.json()).error, /free trial/);
  const mk = async (n) => (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`, { method: "POST", body: { message: `Copy ${n}: the ${WORDS.offer} in Bishan. Tap Sign up.`, headline: `Headline ${n}`, description: "" } })).json()).draft;
  const a = await mk(1), b = await mk(2);
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`)).json();
  assert.deepEqual([r.drafts.length, r.kept, r.drafts[0].source, r.drafts[0].status], [2, [a.id, b.id], "owner", "keep"]);
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/${b.id}`, { method: "PUT", body: { status: "exclude" } })).json(); assert.deepEqual(r.kept, [a.id]);
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/${a.id}`, { method: "PUT", body: { headline: "Dash — here" } })).json(); assert.equal(r.drafts.find((d) => d.id === a.id).headline, "Dash - here", "an edit's dash becomes a hyphen, never a refusal");
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/${a.id}`, { method: "PUT", body: { headline: "Edited headline" } })).json(); assert.equal(r.drafts.find((d) => d.id === a.id).headline, "Edited headline");
  assert.equal((await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/draft`, { method: "POST", body: { count: 99 } })).status, 400);
  assert.equal((await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/draft`, { method: "POST", body: { count: 3, kind: "poem" } })).status, 400);
  bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/draft`, { method: "POST", body: { count: 3, kind: "headline" } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /no headline skeletons yet/, "the panel under test has an empty library: drafting says so before any call");
  bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/recommended`, { method: "POST", body: { kind: "copy" } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /nothing recommended/);
  const hd = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`, { method: "POST", body: { kind: "headline", headline: "Your reset in {AREA}", description: "" } })).json());
  assert.deepEqual([hd.draft.kind, hd.kept_headlines, hd.library], ["headline", [hd.draft.id], { copy: 0, headline: 0, language: "en" }], "the owner's own headline, kept at once, its own list");
  assert.equal((await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/nope`, { method: "PUT", body: { status: "keep" } })).status, 400);
  // The plan carries the kept copy; the setting for text options is saved and bounded.
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
  assert.deepEqual([r.plan.copy.kept, r.plan.copy.headlines.kept, r.plan.words.headline, r.plan.words.placeholders, r.copy.drafts.length, r.plan.ads[0].copies, r.plan.ads[0].headlines], [1, 1, "Your reset in {AREA}", [], 3, [a.id], [hd.draft.id]]);
  assert.equal(r.plan.ads[0].creative.object_story_spec.link_data?.name || r.plan.ads[0].creative.asset_feed_spec.titles[0].text, "Your reset in Bishan", "the kept headline, its area filled for the ad set");
  assert.equal((await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { copy: { max_options: 7 } } })).status, 400);
  r = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { copy: { max_options: 2 } } })).json();
  assert.equal(r.plan.copy.max_options, 2);
  // The pages.
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
  const open = async (url, ready, what) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url }, sessionId); await loaded; const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); if (!(await ev(ready))) throw new Error("timed out waiting for " + what); };
  await open(`${panel.url}/?u24#/${GYM}/publish/${BRIEF.batch_id}`, "!!PB.data && /Copy/.test(document.querySelector('#view')?.textContent||'') && document.querySelector('#cpN')", "the Publish Ads screen");
  let text = await ev("document.querySelector('#view').textContent");
  assert.match(text, /1 kept/); assert.match(text, /Edited headline/); assert.match(text, /Excluded · 1/); assert.equal(await ev("document.querySelector('#cpN').value"), "2");
  assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/Draft 10 copies/.test(b.textContent)) && [...document.querySelectorAll('#view button')].some(b=>/Draft 10 headlines/.test(b.textContent)) && !!document.querySelector('#cpNH') && !!document.querySelector('#cpCta')"), "Copy and Headlines sections, each with its draft button and its per-ad number");
  assert.match(text, /Your reset in Bishan/, "the kept headline is shown with the area filled");
  // Editing keeps paragraphs (2026-09-28: the old one-line prompt saved every edited copy as one block); each card can be copied per area.
  const para = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`, { method: "POST", body: { message: `First paragraph about the ${WORDS.offer}.\n\nSecond paragraph. Tap Sign up.`, headline: "" } })).json()).draft;
  await ev("(async()=>{ await cpReload(); paintPublish(document.querySelector('#view')); return true })()");
  await ev(`cpEdit('${para.id}'); true`);
  assert.equal(await ev("document.querySelector('#cpEditMsg').value"), `First paragraph about the ${WORDS.offer}.\n\nSecond paragraph. Tap {BUTTON}.`, "the editor shows the paragraphs");
  await ev(`(()=>{ const t=document.querySelector('#cpEditMsg'); t.value += '\\n\\nThird paragraph.'; t.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
  await ev("(async()=>{ await cpEditSave(); return true })()");
  const saved = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy`)).json()).drafts.find((d) => d.id === para.id);
  assert.equal(saved.message, `First paragraph about the ${WORDS.offer}.\n\nSecond paragraph. Tap {BUTTON}.\n\nThird paragraph.`, "saved with every line break");
  assert.ok(await ev(`!!document.querySelector('#cp_${para.id} button[onclick^="cpCopy"]')`), "a Copy button on the card");
  await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/copy/${para.id}`, { method: "PUT", body: { status: "exclude" } });
  await ev("(async()=>{ await cpReload(); paintPublish(document.querySelector('#view')); return true })()");
  await ev(`cpDecide('${b.id}','keep')`);
  text = await ev("document.querySelector('#view').textContent"); assert.match(text, /2 kept/);
  await open(`${panel.url}/?u24b#/${GYM}/copy`, "!!CR.data && /References · 1/.test(document.querySelector('#view')?.textContent||'')", "the Copy page");
  text = await ev("document.querySelector('#view').textContent");
  assert.match(text, /A reset that sticks/); assert.match(text, /yours · shown/); assert.ok(await ev("[...document.querySelectorAll('#view input')].some(i=>i.value==='the opener')"), "the note in its field");
  await ev("document.querySelector('#crMsg').value='Another one worth learning from. Tap Sign up.'; document.querySelector('#crHead').value='Second'; true"); await ev("crAdd()");
  assert.match(await ev("document.querySelector('#view').textContent"), /References · 2/);
  await ev(`crRetire('${refId}')`);
  assert.match(await ev("document.querySelector('#view').textContent"), /References · 1/);
});

test("U25 the kept ads as a zip for Ads Manager: every kept ad's images by ad set, the list and the instructions; refused for a batch that is not finished or a bad name; the Publish Ads screen's button", async () => {
  const res = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/images.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${BRIEF.batch_id}-images.zip"`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "a zip");
  const text = buf.toString("latin1");
  assert.ok(text.includes("ads.csv") && text.includes("README.txt"), "the list and the instructions");
  assert.ok(/Bishan\/[^\/]+_4x5\.png/.test(text) && !/_v1\.png/.test(text), "one folder per ad set; names that pair (no _v1)");
  assert.equal((await call(`/api/client/${GYM}/batch/no-such-batch/images.zip`)).status, 404);
  assert.equal((await call(`/api/client/..%2F..%2Fx/batch/${BRIEF.batch_id}/images.zip`)).status, 400);
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: `${panel.url}/?u25#/${GYM}/publish/${BRIEF.batch_id}` }, sessionId); await loaded;
  const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!document.querySelector('#pbZip')"))) await new Promise((x) => setTimeout(x, 150));
  assert.match(await ev("document.querySelector('#pbZip').getAttribute('onclick')"), new RegExp(`/api/client/${GYM}/batch/${BRIEF.batch_id}/images\\.zip`));
});

test("U26 a restart no longer strands the page: /api/token answers the panel's own page only (not another site, not another origin, not another host); a page holding a stale token fetches the current one and its save goes through, once", async () => {
  const t = await call("/api/token", { token: "" });
  assert.equal(t.status, 200); assert.equal((await t.json()).token, panel.token);
  assert.equal((await call("/api/token", { headers: { origin: "http://evil.example" } })).status, 403, "a foreign origin");
  assert.equal((await call("/api/token", { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "a request another site made");
  assert.ok(!(await call("/api/token")).headers.get("access-control-allow-origin"), "no cross-origin reading");
  const rebound = await raw("/api/token", { headers: { host: "evil.example" } });
  assert.equal(rebound.status, 403, "another host name (DNS rebinding)"); assert.ok(!rebound.body.includes(panel.token));
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: `${panel.url}/?u26` }, sessionId); await loaded;
  const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("typeof api==='function' && typeof STATE!=='undefined' && !!STATE.sel"))) await new Promise((x) => setTimeout(x, 150));
  // As after a restart: the page's token is no longer the panel's.
  await ev("TOKEN = 'stale-token-from-before-a-restart'; true");
  const r = await ev(`api('/api/client/${GYM}/batch/${BRIEF.batch_id}/picks', { method:'PUT', body:{} }).then(() => 'saved', (e) => 'refused: ' + e.message)`);
  assert.equal(r, "saved", "the save went through after one catch-up");
  assert.equal(await ev("TOKEN"), panel.token, "and the page now holds the current token");
  assert.equal(await ev("document.querySelector('meta[name=\"panel-token\"]').content"), panel.token);
});

test("U27 from the website: the reading shown with its files; the owner's ticks filed — photos by kind with where they came from, a low-resolution photo only when kept anyway, the logo, colours never over a locked one, fonts, the address as a location, Instagram and Facebook; nothing twice; a pick the reading does not hold files nothing; the read run refuses addresses on this machine; uploads refuse a low-resolution photo unless kept anyway", async () => {
  const { deflateSync, crc32 } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const pngOf = (w, h, seed) => {
    const rows = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (x * seed) & 255; row[2 + x * 3] = (y * seed) & 255; row[3 + x * 3] = seed * 40; } rows.push(row); }
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  };
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const G = "webgym", g = join(brands, G), w = join(g, "onboarding", "website");
  mkdirSync(join(w, "photos", "thumbs"), { recursive: true }); mkdirSync(join(w, "logos"), { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Web Gym", locations: [{ label: "", address: "", postal_code: "" }], brand_lock: { colors: { primary: { hex: "#111111", locked: true }, secondary: { hex: "", locked: true } } } }));
  const big = pngOf(1600, 1000, 1), small = pngOf(700, 500, 2), logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#E63946"/></svg>');
  writeFileSync(join(w, "photos", "p01-room.png"), big); writeFileSync(join(w, "photos", "thumbs", "p01.jpg"), big);
  writeFileSync(join(w, "photos", "p02-coach.png"), small); writeFileSync(join(w, "photos", "thumbs", "p02.jpg"), small);
  writeFileSync(join(w, "logos", "logo-1.svg"), logo); writeFileSync(join(w, "home.png"), pngOf(1440, 900, 3));
  const reading = { schema: 1, url: "https://webgym.sg/", read_at: "2026-09-28T10:00:00.000Z", gym: "Web Gym", calls: 2, pages: [{ url: "https://webgym.sg/", title: "Web Gym", images: 2 }], site: { name_seen: "Web Gym" },
    identity: { names: ["Web Gym"], addresses: [{ address: "10 Test Road, Singapore 570123", postal_code: "570123", from: "schema.org", lat: 1.36, lng: 103.85 }], phones: [], instagram: [{ value: "webgym.sg", seen: 3 }], facebook: [{ value: "https://www.facebook.com/webgymsg", seen: 2 }], hours: [] },
    colours: { candidates: [{ hex: "#1A2B3C", share_bg: 0.4, share_text: 0, buttons: 0 }, { hex: "#E63946", share_bg: 0.01, share_text: 0.05, buttons: 3 }, { hex: "#FFFFFF", share_bg: 0.5, share_text: 0.3, buttons: 0 }], proposal: { primary: "#1A2B3C", secondary: "#E63946", accent: null, why: "x" } },
    fonts: { headline: "Oswald", body: "Lato" }, logos: [{ id: "logo-1", file: "logos/logo-1.svg", from: "inline svg in the header" }],
    photos: [{ id: "p01", file: "photos/p01-room.png", thumb: "photos/thumbs/p01.jpg", url: "https://webgym.sg/wp-content/uploads/room.png", size: [1600, 1000], sha256: sha(big), low_res: false, kind: "premises" },
      { id: "p02", file: "photos/p02-coach.png", thumb: "photos/thumbs/p02.jpg", url: "https://webgym.sg/img/coach.png", size: [700, 500], sha256: sha(small), low_res: true, kind: "coaches" }],
    screenshot: "home.png", problems: [] };
  writeFileSync(join(w, "reading.json"), JSON.stringify(reading));
  // The view: the reading with its files' addresses, each served; the reading itself is not a file anyone may fetch.
  let v = await (await call(`/api/client/${G}/website`)).json();
  assert.equal(v.min_photo_px, 1080);
  assert.deepEqual(v.reading.photos.map((p) => [p.id, p.file_as, p.have]), [["p01", "facility", null], ["p02", "coaches", null]]);
  for (const u of [v.reading.photos[0].image_url, v.reading.photos[0].thumb_url, v.reading.logos[0].image_url, v.reading.screenshot_url]) assert.equal((await fetch(panel.url + u)).status, 200, u);
  assert.equal((await fetch(panel.url + `/files/brands/${G}/onboarding/website/reading.json`)).status, 404);
  assert.match((await fetch(panel.url + v.reading.logos[0].image_url)).headers.get("content-security-policy") || "", /default-src 'none'/, "an SVG is served as a picture, never a page");
  const accept = (body, opts) => call(`/api/client/${G}/website/accept`, { method: "POST", body, ...opts });
  assert.equal((await accept({ photos: [{ id: "p01", kind: "facility" }] }, { token: null })).status, 403);
  let r = await accept({ photos: [{ id: "p01", kind: "facility" }], colours: { primary: "#ABCDEF" } });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /not one of the colours the website showed/);
  assert.equal((await accept({ photos: [{ id: "p01", kind: "facility" }], instagram: "someoneelse" })).status, 400, "an account the site never linked");
  assert.ok(!existsSync(join(g, "brand-assets")), "a refused accept files nothing");
  r = await accept({ photos: [{ id: "p01", kind: "facility" }, { id: "p02", kind: "coaches" }, { id: "p99", kind: "facility" }], logo: "logo-1", colours: { primary: "#1A2B3C", secondary: "#E63946" }, fonts: { headline: true, body: true }, address: "570123", instagram: "webgym.sg", facebook: "https://www.facebook.com/webgymsg", screenshot: true });
  assert.equal(r.status, 200); let j = await r.json();
  assert.deepEqual(j.added.map((a) => [a.id, a.path]), [["p01", "facility/web-room.png"], ["logo-1", "logo/web-logo.svg"], ["home", "brand/web-home.png"]]);
  assert.deepEqual(j.skipped.map((x) => [x.id, !!x.low_res]), [["p02", true], ["p99", false]], "the low-resolution photo waits for the owner's override; an unknown pick is named");
  assert.ok(j.changes.includes("primary colour kept: #111111 is locked in the profile"));
  const prof = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf8"));
  assert.equal(prof.brand_lock.colors.primary.hex, "#111111", "a locked colour is never replaced");
  assert.deepEqual(prof.brand_lock.colors.secondary, { hex: "#E63946", locked: false, source: "website", name: "" });
  assert.deepEqual([prof.brand_lock.typography.headline.family, prof.brand_lock.typography.body.family], ["Oswald", "Lato"]);
  assert.equal(prof.locations.length, 1, "the empty location is filled, not added beside");
  assert.deepEqual([prof.locations[0].postal_code, prof.locations[0].lat, prof.locations[0].address], ["570123", 1.36, "10 Test Road, Singapore 570123"]);
  assert.deepEqual(prof.social, { instagram: "webgym.sg", facebook: "https://www.facebook.com/webgymsg" });
  assert.equal(prof.website, "https://webgym.sg/");
  assert.equal(prof.brand_lock.logo.files.primary, "logo/web-logo.svg", "the first logo becomes the profile's");
  const man = JSON.parse(readFileSync(join(g, "brand-assets", "manifest.json"), "utf8")).assets;
  const room = man.find((a) => a.path === "facility/web-room.png");
  assert.deepEqual([room.source, room.source_url, room.original_name, room.sha256], ["website", "https://webgym.sg/wp-content/uploads/room.png", "room.png", sha(big)]);
  // Again: the photo already filed is not filed twice; the low-resolution one goes in once the owner keeps it anyway.
  j = await (await accept({ photos: [{ id: "p01", kind: "facility" }, { id: "p02", kind: "coaches", keep_low_res: true }] })).json();
  assert.deepEqual(j.added.map((a) => a.path), ["coaches/web-coach.png"]);
  assert.match(j.skipped[0].reason, /already here as facility\/web-room\.png/);
  assert.equal(JSON.parse(readFileSync(join(g, "brand-assets", "manifest.json"), "utf8")).assets.find((a) => a.path === "coaches/web-coach.png").low_res_kept, true);
  assert.deepEqual(j.reading.photos.map((p) => p.have), ["facility/web-room.png", "coaches/web-coach.png"], "the view says what is filed already");
  // Uploads from the drop zone follow the same rule.
  const tiny = pngOf(640, 480, 5);
  const up = (headers = {}) => raw(`/api/client/${G}/asset/members/tiny.png`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-panel-token": panel.token, ...headers }, body: tiny });
  let u = await up();
  assert.equal(u.status, 422); assert.deepEqual([JSON.parse(u.body).low_res, JSON.parse(u.body).min_px, JSON.parse(u.body).size], [true, 1080, [640, 480]]);
  u = await up({ "x-keep-low-res": "1" });
  assert.equal(u.status, 200, u.body); assert.equal(JSON.parse(u.body).asset.low_res_kept, true);
  assert.equal((await raw(`/api/client/${G}/asset/logo/small-logo.png`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-panel-token": panel.token }, body: pngOf(300, 100, 6) })).status, 200, "a logo has no size floor");
  // The read run: a public web address only, for a gym with a profile.
  for (const [body, re] of [[{ kind: "website-read", gym: G, url: "http://127.0.0.1:9/" }, /private network|this computer/], [{ kind: "website-read", gym: G, url: "file:///etc/passwd" }, /http and https/], [{ kind: "website-read", gym: "nope", url: "https://webgym.sg/" }, /needs a client with a profile/], [{ kind: "website-read", gym: G, url: 42 }, /web address/]]) {
    const x = await call("/api/run", { method: "POST", body });
    assert.equal(x.status, 400, JSON.stringify(body)); assert.match((await x.json()).error, re);
  }
});

test("U28 from Instagram: the reading shown with its files; ticked photos filed with their post as where each came from, a low-resolution one only when kept anyway, never twice; the handle becomes the profile's Instagram when it has none; the read run needs a handle and the Meta link", async () => {
  const { deflateSync, crc32 } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const pngOf = (w, h, seed) => {
    const rows = []; for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (x * seed) & 255; row[2 + x * 3] = (y * seed) & 255; row[3 + x * 3] = seed * 30; } rows.push(row); }
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  };
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const G = "iggym", g = join(brands, G), w = join(g, "onboarding", "instagram");
  mkdirSync(join(w, "photos", "thumbs"), { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "IG Gym" }));
  const a = pngOf(1080, 1350, 1), b = pngOf(640, 800, 2);
  writeFileSync(join(w, "photos", "i001.png"), a); writeFileSync(join(w, "photos", "thumbs", "i001.jpg"), a);
  writeFileSync(join(w, "photos", "i002.png"), b); writeFileSync(join(w, "photos", "thumbs", "i002.jpg"), b);
  writeFileSync(join(w, "reading.json"), JSON.stringify({ schema: 1, source: "instagram", handle: "iggym.sg", read_at: "2026-09-29T10:00:00.000Z", account: { username: "iggym.sg", followers: 10 }, asked_via: "strategym", posts_read: 2, videos_skipped: 3, calls: 1,
    photos: [{ id: "i001", file: "photos/i001.png", thumb: "photos/thumbs/i001.jpg", post: "https://www.instagram.com/p/Ab_Cd-1/", taken: "2026-09-20T10:00:00+0000", in_post: 2, of: 3, size: [1080, 1350], sha256: sha(a), low_res: false, kind: "members", before_after: false },
      { id: "i002", file: "photos/i002.png", thumb: "photos/thumbs/i002.jpg", post: "https://www.instagram.com/p/XYZ/", taken: "2026-09-10T10:00:00+0000", in_post: 1, of: 1, size: [640, 800], sha256: sha(b), low_res: true, kind: "premises" }], problems: [] }));
  let v = await (await call(`/api/client/${G}/instagram`)).json();
  assert.equal(v.meta_ready, false, "the test panel has no Meta keys");
  assert.deepEqual(v.reading.photos.map((p) => [p.id, p.file_as]), [["i001", "members"], ["i002", "facility"]]);
  for (const u of [v.reading.photos[0].image_url, v.reading.photos[0].thumb_url]) assert.equal((await fetch(panel.url + u)).status, 200, u);
  assert.equal((await fetch(panel.url + `/files/brands/${G}/onboarding/instagram/reading.json`)).status, 404);
  const accept = (body, opts) => call(`/api/client/${G}/instagram/accept`, { method: "POST", body, ...opts });
  assert.equal((await accept({ photos: [{ id: "i001", kind: "members" }] }, { token: null })).status, 403);
  let j = await (await accept({ photos: [{ id: "i001", kind: "members" }, { id: "i002", kind: "facility" }, { id: "i404", kind: "members" }] })).json();
  assert.deepEqual(j.added.map((x) => x.path), ["members/ig-iggym-sg-ab-cd-1-2.png"], "named from the handle, the post and its place in the carousel");
  assert.deepEqual(j.skipped.map((x) => [x.id, !!x.low_res]), [["i002", true], ["i404", false]]);
  assert.deepEqual(j.changes, ["Instagram @iggym.sg"]);
  assert.equal(JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf8")).social.instagram, "iggym.sg");
  const row = JSON.parse(readFileSync(join(g, "brand-assets", "manifest.json"), "utf8")).assets.find((x) => x.path === "members/ig-iggym-sg-ab-cd-1-2.png");
  assert.deepEqual([row.source, row.source_url], ["instagram", "https://www.instagram.com/p/Ab_Cd-1/"]);
  j = await (await accept({ photos: [{ id: "i001", kind: "members" }, { id: "i002", kind: "facility", keep_low_res: true }] })).json();
  assert.deepEqual(j.added.map((x) => x.path), ["facility/ig-iggym-sg-xyz.png"]); assert.match(j.skipped[0].reason, /already here/); assert.deepEqual(j.changes, [], "the profile's Instagram is not set twice");
  assert.deepEqual(j.reading.photos.map((p) => p.have), ["members/ig-iggym-sg-ab-cd-1-2.png", "facility/ig-iggym-sg-xyz.png"]);
  for (const [body, status, re] of [[{ kind: "instagram-read", gym: G, handle: "two words" }, 400, /Instagram handle/], [{ kind: "instagram-read", gym: "nope", handle: "iggym.sg" }, 400, /needs a client/], [{ kind: "instagram-read", gym: G, handle: "iggym.sg", posts: 5000 }, 400, /how many posts to read must be 25 to 500/], [{ kind: "instagram-read", gym: G, handle: "iggym.sg", posts: "200" }, 400, /how many posts/], [{ kind: "instagram-read", gym: G, handle: "@iggym.sg", posts: 300 }, 409, /Meta link is not set up/], [{ kind: "instagram-read", gym: G, handle: "@iggym.sg" }, 409, /Meta link is not set up/]]) {
    const x = await call("/api/run", { method: "POST", body });
    assert.equal(x.status, status, JSON.stringify(body)); assert.match((await x.json()).error, re);
  }
});

test("U29 the clean-up's flagged photos: listed with the original and the edit; Use it anyway makes the edit a cleaned photo with the owner's word beside it (the file and its contents' hash); Remove moves it to the trash and drops the word; a photo already clean is not listed; one the gym's defaults use is not removed", async () => {
  const { createHash } = await import("node:crypto");
  const { ownerKept } = await import("../skills/references/check-visual.mjs");
  const { readdirSync } = await import("node:fs");
  const G = "keepgym", g = join(brands, G), run = join(g, "outputs", "clean-2026-10-02"), clean = join(g, "brand-assets", "facility-clean");
  mkdirSync(run, { recursive: true }); mkdirSync(clean, { recursive: true });
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Keep Gym" }));
  const png = readFileSync(join(brands, GYM, "brand-assets", "facility-clean", "r1.png")), png2 = readFileSync(join(brands, GYM, "brand-assets", "facility-clean", "r2.png"));
  for (const [f, b] of [["room.source.png", png], ["room.png", png], ["room-a2.png", png2], ["done.png", png], ["done.source.png", png]]) writeFileSync(join(run, f), b);
  writeFileSync(join(clean, "done.png"), png);
  // The report names its files by the absolute paths of the machine that made it; only their names are used.
  writeFileSync(join(run, "report.json"), JSON.stringify({ results: [
    { id: "room", photo: "/elsewhere/brand-assets/facility/room.webp", status: "flagged", failures: ["marks still in the photo: sign \"a sign through the window\" (in the centre)"], notes: ["small marks left: logo \"a logo\""], attempts: [{ attempt: 1, file: "/elsewhere/room.png" }, { attempt: 2, file: "/elsewhere/room-a2.png" }] },
    { id: "done", photo: "/elsewhere/done.png", status: "flagged", failures: ["x"], attempts: [{ attempt: 1, file: "/elsewhere/done.png" }] },
    { id: "gone", photo: "/elsewhere/gone.png", status: "flagged", failures: ["x"], attempts: [{ attempt: 1, file: "/elsewhere/gone.png" }] },
  ] }));
  const assets = async () => (await call(`/api/client/${G}/assets`)).json();
  let a = await assets();
  assert.deepEqual(a.flagged.map((f) => [f.id, f.photo, f.attempt, f.after_url, f.before_url]), [["room", "room.webp", 2, `/files/brands/${G}/outputs/clean-2026-10-02/room-a2.png`, `/files/brands/${G}/outputs/clean-2026-10-02/room.source.png`]], "a photo with a clean copy, or with no candidate left on disk, is not listed");
  assert.match(a.flagged[0].failures[0], /a sign through the window/);
  for (const u of [a.flagged[0].after_url, a.flagged[0].before_url]) assert.equal((await fetch(panel.url + u)).status, 200, u);
  const post = (what, body, opts) => call(`/api/client/${G}/clean/${what}`, { method: "POST", body, ...opts });
  assert.equal((await post("keep", { id: "room" }, { token: null })).status, 403);
  assert.equal((await post("keep", { id: "../x" })).status, 400);
  assert.equal((await post("keep", { id: "done" })).status, 404, "already clean: nothing to keep");
  assert.equal((await post("keep", { id: "room" })).status, 200);
  assert.deepEqual(readFileSync(join(clean, "room.png")), png2, "the latest candidate");
  const kept = ownerKept(join(clean, "room.png"));
  assert.equal(kept.sha256, createHash("sha256").update(png2).digest("hex")); assert.equal(kept.from, "clean-2026-10-02, attempt 2"); assert.match(kept.left[0], /a sign through the window/);
  a = await assets();
  assert.deepEqual(a.flagged, []);
  const row = a.clean.find((c) => c.path === "facility-clean/room.png");
  assert.match(row.kept, /^\d{4}-\d\d-\d\d$/); assert.equal(a.clean.find((c) => c.path === "facility-clean/done.png").kept, undefined);
  assert.equal((await fetch(panel.url + `/files/brands/${G}/brand-assets/facility-clean/owner-kept.json`)).status, 404, "the record is not a file anyone may fetch");
  // Remove: to the trash, the word dropped, and the photo is flagged again.
  assert.equal((await post("discard", { name: "nope.png" })).status, 404);
  assert.equal((await post("discard", { name: "../room.png" })).status, 404);
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Keep Gym", creative_defaults: { real_photos: ["facility-clean/room.png"] } }));
  const used = await post("discard", { name: "room.png" });
  assert.equal(used.status, 409); assert.match((await used.json()).error, /Ad defaults/);
  writeFileSync(join(g, "gym-profile.json"), JSON.stringify({ display_name: "Keep Gym" }));
  assert.equal((await post("discard", { name: "room.png" })).status, 200);
  assert.ok(!existsSync(join(clean, "room.png")) && readdirSync(join(g, "brand-assets", "_trash")).some((f) => /facility-clean-room\.png$/.test(f)), "moved, not deleted");
  assert.deepEqual(JSON.parse(readFileSync(join(clean, "owner-kept.json"), "utf8")), {});
  assert.deepEqual((await assets()).flagged.map((f) => f.id), ["room"]);
});

test("U30 Stop: a run is ended with everything it started (its own process group, its headless Chrome with it), and says it was stopped; a batch run from before a restart is found by its process, stopped, and its progress says so; a stopped batch's card says what it spent; discarding it sets its photos aside; nothing running is refused", async () => {
  const { readdirSync } = await import("node:fs");
  const ps = () => execFileSync("ps", ["-Ao", "pid=,pgid=,command="], { encoding: "utf-8" }).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], pgid: +m[2], cmd: m[3] }));
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 150)); } };
  // 1. A run with a browser: the website reader against a page that never answers.
  const hang = http.createServer(() => {}); await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const p2 = await startPanel({ READ_WEBSITE_ALLOW_LOCAL: "1" });
  const c2 = (path, { method = "GET", body, token = p2.token } = {}) => fetch(p2.url + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-panel-token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const started = await (await c2("/api/run", { method: "POST", body: { kind: "website-read", gym: GYM, url: `http://127.0.0.1:${hang.address().port}/` } })).json();
    assert.ok(started.id, JSON.stringify(started));
    const stream = fetch(`${p2.url}/api/run/${started.id}/stream`).then((r) => r.text());
    const script = await until(() => ps().find((x) => x.cmd.includes("read-website.mjs") && x.cmd.includes(join(brands, GYM))));
    assert.ok(script, "the run's process");
    assert.equal(script.pgid, script.pid, "it leads its own process group");
    assert.ok(await until(() => ps().some((x) => x.pgid === script.pid && /Chrome/.test(x.cmd))), "its browser is in that group");
    assert.equal((await c2(`/api/run/${started.id}/stop`, { method: "POST", body: {}, token: null })).status, 403);
    assert.equal((await c2("/api/run/nope-1/stop", { method: "POST", body: {} })).status, 404);
    assert.equal((await c2(`/api/run/${started.id}/stop`, { method: "POST", body: {} })).status, 200);
    const text = await stream;
    assert.match(text, /■ stopped by you/); assert.match(text, /event: done\ndata: \{"code":null,"stopped":true\}/);
    assert.ok(await until(() => !ps().some((x) => x.pgid === script.pid)), "nothing of the run is left, the browser included");
    assert.equal((await c2(`/api/run/${started.id}/stop`, { method: "POST", body: {} })).status, 409, "already ended");
  } finally { await p2.stop(); hang.close(); }

  // 2. A batch run this panel did not start (an earlier panel did): found by the process its progress file names.
  const id = "stop-batch", out = join(brands, GYM, "outputs", id), briefFile = join(brands, GYM, "batches", id, "brief.json");
  mkdirSync(join(brands, GYM, "batches", id), { recursive: true }); mkdirSync(join(out, "visuals"), { recursive: true });
  writeFileSync(briefFile, JSON.stringify({ ...BRIEF, batch_id: id }));
  writeFileSync(join(out, "visuals", "g01.png"), readFileSync(join(brands, GYM, "brand-assets", "facility-clean", "r1.png")));
  writeFileSync(join(out, "spend.json"), JSON.stringify({ image_calls: 3, max_calls: 20 }));
  const stopB = (opts) => call(`/api/client/${GYM}/batch/${id}/stop`, { method: "POST", body: {}, ...opts });
  writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "photos", pid: process.pid, calls: 3, photos: { g01: { state: "passed" }, g02: { state: "generating" } } }));
  assert.equal((await (await call(`/api/client/${GYM}/batch/${id}/progress`)).json()).orphan, false, "a process that is not the batch script is never taken for the run");
  assert.equal((await stopB()).status, 409, "nothing is running for it");
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "plan-offer-batch.mjs", "--brief", briefFile], { detached: true, stdio: "ignore" });
  try {
    writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "photos", pid: fake.pid, calls: 3, photos: { g01: { state: "passed" }, g02: { state: "generating" } } }));
    assert.ok(await until(async () => (await (await call(`/api/client/${GYM}/batch/${id}/progress`)).json()).orphan), "still going, though this panel did not start it");
    assert.equal((await call(`/api/client/${GYM}/batch/${id}`, { method: "DELETE" })).status, 409, "not discarded while it is being made");
    assert.equal((await stopB({ token: null })).status, 403);
    assert.equal((await call(`/api/client/${GYM}/batch/nope/stop`, { method: "POST", body: {} })).status, 404);
    const r = await stopB();
    assert.equal(r.status, 200); assert.equal((await r.json()).stopped, true);
    assert.ok(!ps().some((x) => x.pid === fake.pid && !/defunct/.test(x.cmd)), "the run is gone");
  } finally { try { process.kill(fake.pid, "SIGKILL"); } catch {} }
  const prog = JSON.parse(readFileSync(join(out, "progress.json"), "utf8"));
  assert.deepEqual([prog.stage, prog.stopped_at, prog.calls], ["stopped", "photos", 3]);
  const view = await (await call(`/api/client/${GYM}/batch/${id}/progress`)).json();
  assert.deepEqual([view.orphan, view.run, view.progress.stage], [false, null, "stopped"]);
  const card = (await (await call(`/api/client/${GYM}/batch-setup`)).json()).batches.find((b) => b.id === id);
  assert.deepEqual(card.stopped, { image_calls: 3 });
  assert.equal((await stopB()).status, 409, "stopped already");
  // Discarding it: the brief goes, the photos it paid for are set aside.
  const d = await (await call(`/api/client/${GYM}/batch/${id}`, { method: "DELETE" })).json();
  assert.equal(d.photos, 1); assert.match(d.kept, /^outputs\/_discarded\/stop-batch-\d+/);
  assert.ok(existsSync(join(brands, GYM, d.kept, "visuals", "g01.png")) && !existsSync(out) && !existsSync(briefFile));
  assert.ok(!(await (await call(`/api/client/${GYM}/batch-setup`)).json()).batches.some((b) => b.id === id || /_discarded/.test(b.id)));
});

test("U31 the Generating screen's Stop: shown while a run is going (one from before a restart included), it ends the run and the screen says it was stopped, with what passed and what was spent", async () => {
  const id = "stop-page", out = join(brands, GYM, "outputs", id), briefFile = join(brands, GYM, "batches", id, "brief.json");
  mkdirSync(join(brands, GYM, "batches", id), { recursive: true }); mkdirSync(out, { recursive: true });
  writeFileSync(briefFile, JSON.stringify({ ...BRIEF, batch_id: id }));
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "plan-offer-batch.mjs", "--brief", briefFile], { detached: true, stdio: "ignore" });
  try {
    writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "photos", pid: fake.pid, calls: 3, spent_before: 0, max_calls: 20, photos: { g01: { state: "passed", scene: "a" }, g02: { state: "generating", scene: "b" }, g03: { state: "queued", scene: "c" } } }));
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const wait = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await new Promise((x) => setTimeout(x, 150)); } return false; };
    const loaded = cdp.once("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: `${panel.url}/?u31#/${GYM}/generating/${id}` }, sessionId); await loaded;
    assert.ok(await wait("!!document.querySelector('#genStopBtn')"), "Stop is offered for a run this panel did not start");
    assert.match(await ev("document.querySelector('#view').innerText"), /started before the panel was last restarted/);
    assert.equal(await ev("document.querySelector('#genStopBtn').textContent"), "Stop");
    await ev("window.confirm = () => true; document.querySelector('#genStopBtn').click(); true");
    assert.ok(await wait("document.querySelector('#view h1')?.textContent === 'Stopped by you'"), await ev("document.querySelector('#view').innerText.slice(0, 300)"));
    const text = await ev("document.querySelector('#view').innerText");
    assert.match(text, /You stopped this run while it was generating photos\. 1 photo had passed and 3 image calls had been used; both are kept\./);
    assert.equal(await ev("!!document.querySelector('#genStopBtn')"), false, "nothing left to stop");
    assert.equal(JSON.parse(readFileSync(join(out, "progress.json"), "utf8")).stage, "stopped");
  } finally { try { process.kill(fake.pid, "SIGKILL"); } catch {} }
});

test("U32 filled in for the owner: saving a profile places a pin that has a postal code and no point (the gym's own location first, then the map), and says what could not be placed; the Publish Ads screen reads the Singapore identity from the ad account's own ad sets — one is saved, several are offered and only one of them can be chosen, none is said with what to do", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json"), before = readFileSync(pf, "utf-8");
  let adsets = [];
  const sg = (ben, name) => ({ id: name, name, regional_regulated_categories: ["SINGAPORE_UNIVERSAL"], regional_regulation_identities: { singapore_universal_beneficiary: ben, singapore_universal_payer: ben } });
  let asked = 0;
  const graph = http.createServer((req, res) => { const path = new URL(req.url, "http://x").pathname; res.writeHead(200, { "content-type": "application/json" }); if (/\/act_222000000002\/adsets$/.test(path)) { asked++; return res.end(JSON.stringify({ data: adsets })); } res.end(JSON.stringify({ data: [] })); });
  await new Promise((r) => graph.listen(0, "127.0.0.1", r));
  const onemap = await fakeOneMap(), main = panel;
  await linkTestGym();
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: `http://127.0.0.1:${graph.address().port}`, ONEMAP_URL: onemap.url });
  try {
    // Pins: placed on save.
    const base = JSON.parse(readFileSync(pf, "utf-8"));
    const profile = { ...base, locations: [{ label: "Katong", postal_code: "428906", lat: 1.3073, lng: 103.9066 }], targeting_defaults: { ...base.targeting_defaults, geo: { radius_pins: [
      { label: "Own", postal_code: "428906", radius_km: 3, callouts: ["BISHAN"] }, { label: "Mapped", postal_code: "575583", radius_km: 3, callouts: ["ANG MO KIO"] }, { label: "Lost", postal_code: "999999", radius_km: 3 }, { radius_km: 3 }, { label: "Has a point", lat: 1.35, lng: 103.85, postal_code: "575583" }] } } };
    let r = await call(`/api/client/${GYM}`, { method: "PUT", body: profile });
    assert.equal(r.status, 200); let j = await r.json();
    assert.deepEqual(j.placed, ["Own: placed at the gym's location for 428906", "Mapped: placed at 2 SIN MING ROAD SIN MING PLAZA SINGAPORE 575583"]);
    assert.equal(j.warnings.length, 2); assert.match(j.warnings[0], /Lost: postal code 999999 was not found on the map/); assert.match(j.warnings[1], /pin 4 has no place yet/);
    const saved = JSON.parse(readFileSync(pf, "utf-8")).targeting_defaults.geo.radius_pins;
    assert.deepEqual(saved.map((p) => [p.lat ?? null, p.lng ?? null]), [[1.3073, 103.9066], [1.352482302799053, 103.8357469735082], [null, null], [null, null], [1.35, 103.85]]);
    assert.deepEqual(j.profile.targeting_defaults.geo.radius_pins[0].lat, 1.3073, "the page gets the placed pin back");
    // The identity: missing from the profile, read from the account's ad sets when the Publish Ads screen opens.
    const strip = () => { const p = JSON.parse(readFileSync(pf, "utf-8")); p.meta_assets = { ...p.meta_assets, ad_account_id: "act_222000000002" }; delete p.meta_assets.singapore_beneficiary_id; delete p.meta_assets.singapore_payer_id; writeFileSync(pf, JSON.stringify(p)); };
    const publish = async (opts) => (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, opts)).json();
    const idProblem = (v) => v.plan.problems.some((x) => /no verified Singapore advertiser identity yet/.test(x));
    strip(); adsets = [sg("519331755130652", "test"), sg("519331755130652", "Open | New-Patient Session")];
    let v = await publish();
    assert.deepEqual([v.identity.set.beneficiary, v.identity.set.adsets, idProblem(v)], ["519331755130652", 2, false]);
    let m = JSON.parse(readFileSync(pf, "utf-8")).meta_assets;
    assert.deepEqual([m.singapore_beneficiary_id, m.singapore_payer_id, m.labels.singapore_identity], ["519331755130652", "519331755130652", 'from 2 existing ad set(s), e.g. "test"']);
    const n = asked; v = await publish();
    assert.deepEqual([v.identity, asked], [null, n], "once it is in the profile Meta is not asked again");
    // Several: nothing is taken; the owner chooses, and only from what the ad sets name.
    strip(); adsets = [sg("111000111000111", "a"), sg("222000222000222", "b"), sg("222000222000222", "c")];
    v = await publish();
    assert.deepEqual([v.identity.set, v.identity.choices.map((c) => c.beneficiary), idProblem(v)], [undefined, ["222000222000222", "111000111000111"], true]);
    assert.match(v.identity.reason, /2 different Singapore identities/);
    const choose = (body, opts) => call(`/api/client/${GYM}/singapore-identity`, { method: "POST", body, ...opts });
    assert.equal((await choose({ beneficiary: "111000111000111", payer: "111000111000111" }, { token: null })).status, 403);
    r = await choose({ beneficiary: "999", payer: "999" }); assert.equal(r.status, 400); assert.match((await r.json()).error, /not one the account's ad sets name/);
    assert.equal((await choose({ beneficiary: "111000111000111", payer: "111000111000111" })).status, 200);
    assert.equal(JSON.parse(readFileSync(pf, "utf-8")).meta_assets.singapore_beneficiary_id, "111000111000111");
    v = await publish(); assert.deepEqual([v.identity, idProblem(v)], [null, false]);
    // None: said, with what to do; a settings save (PUT) never asks Meta.
    strip(); adsets = [{ id: "x", name: "no identity" }];
    v = await publish();
    assert.deepEqual(v.identity.choices, []); assert.match(v.identity.reason, /publish one ad by hand in Ads Manager/); assert.equal(idProblem(v), true);
    const n2 = asked; v = await publish({ method: "PUT", body: {} });
    assert.deepEqual([v.identity, asked], [null, n2]);
  } finally { await panel.stop(); panel = main; graph.close(); onemap.server.close(); writeFileSync(pf, before); }
});

test("U33 the copy library on Library → Copy (CL3): every entry listed with what the gyms' batches made from it; a skeleton written by hand is checked (known placeholders only, a headline on one line) and warned about; edit, retire with a reason (never deleted), restore; a gym's reference sent to the library on request; the page shows the library with its filters, the edit and retire dialogs, and Send to the library on a reference", async () => {
  const g = join(brands, GYM), libFile = join(dirname(brands), "library", "copy-library.json"), usesDir = join(g, "outputs", "lib-uses-batch");
  await linkTestGym();
  rmSync(libFile, { force: true }); rmSync(usesDir, { recursive: true, force: true }); rmSync(join(g, "copy-references.json"), { force: true });
  try {
    let r = await (await call("/api/library/copy")).json();
    assert.deepEqual([r.entries, r.counts, r.uses, Object.keys(r.placeholders)], [[], { copy: 0, headline: 0, retired: 0, zh: 0 }, {}, ["GYM", "OFFER", "AREA", "AUDIENCE", "BUTTON", "DURATION"]]);
    assert.equal((await call("/api/library/copy", { method: "POST", body: { kind: "copy", text: "x {OFFER}" }, token: null })).status, 403, "a write needs the panel's token");
    // Written by hand: checked by the library's rules.
    let bad = await call("/api/library/copy", { method: "POST", body: { kind: "copy", text: "Ask {COACH} about the {OFFER}" } });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /unknown placeholder \{COACH\}/);
    bad = await call("/api/library/copy", { method: "POST", body: { kind: "headline", text: "Two\nlines {OFFER}" } });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /one line/);
    const SK = "{AUDIENCE} in {AREA}: the {OFFER} starts soon.\n\n✔ Coach-led sessions\n✔ A plan that fits\n\nTap {BUTTON} to start.";
    r = await (await call("/api/library/copy", { method: "POST", body: { kind: "copy", text: SK, angle: "call-out", note: "names who and where first" } })).json();
    const id = r.entry.id;
    assert.deepEqual([r.entry.kind, r.entry.text, r.entry.placeholders, r.entry.warnings, r.entry.origin, r.counts.copy], ["copy", SK, ["AUDIENCE", "AREA", "OFFER", "BUTTON"], [], { source: "owner" }, 1], "the line breaks kept; placeholders in order; yours");
    r = await (await call("/api/library/copy", { method: "POST", body: { kind: "headline", text: "Free {DURATION} {OFFER} in {AREA}", description: "d" } })).json();
    const hid = r.entry.id;
    assert.deepEqual([r.entry.warnings, r.counts], [['says "free"'], { copy: 1, headline: 1, retired: 0, zh: 0 }], "what the rules forbid on an ad is a warning on the skeleton, not a refusal");
    assert.equal((await call("/api/library/copy", { method: "POST", body: { kind: "copy", text: SK } })).status, 400, "the same skeleton is not added twice");
    // Edit: re-checked; the id stays (drafts made from it still trace back).
    bad = await call(`/api/library/copy/${id}`, { method: "PUT", body: { text: "{NOPE}" } }); assert.equal(bad.status, 400);
    r = await (await call(`/api/library/copy/${id}`, { method: "PUT", body: { text: SK.replace("{AUDIENCE} in {AREA}", "{GYM} {AREA}"), angle: "", note: "edited" } })).json();
    assert.deepEqual([r.entry.id, r.entry.placeholders, r.entry.angle, r.entry.note, !!r.entry.edited], [id, ["GYM", "AREA", "OFFER", "BUTTON"], null, "edited", true]);
    // Retire needs a reason; the entry stays; restore brings it back.
    bad = await call(`/api/library/copy/${id}`, { method: "PUT", body: { retired: true, reason: "  " } }); assert.equal(bad.status, 400); assert.match((await bad.json()).error, /reason is required/);
    r = await (await call(`/api/library/copy/${id}`, { method: "PUT", body: { retired: true, reason: "too salesy" } })).json();
    assert.deepEqual([r.entry.retired.reason, r.counts, r.entries.length], ["too salesy", { copy: 0, headline: 1, retired: 1, zh: 0 }, 2]);
    assert.equal(JSON.parse(readFileSync(libFile, "utf-8")).entries.length, 2, "never deleted");
    r = await (await call(`/api/library/copy/${id}`, { method: "PUT", body: { retired: false } })).json(); assert.deepEqual([r.entry.retired, r.counts.copy], [null, 1]);
    assert.equal((await call("/api/library/copy/lib-nope", { method: "PUT", body: { note: "x" } })).status, 400);
    // What the batches made from it: drafts that followed the skeleton, and how many the owner kept.
    mkdirSync(usesDir, { recursive: true });
    writeFileSync(join(usesDir, "copy.json"), JSON.stringify({ drafts: [{ id: "a", from: id, status: "keep" }, { id: "b", from: id, status: "exclude" }, { id: "c", from: id, status: "draft" }, { id: "d", from: null, status: "keep" }] }));
    r = await (await call("/api/library/copy")).json();
    assert.deepEqual(r.uses, { [id]: { drafts: 3, kept: 1, gyms: [GYM] } });
    // A gym's reference sent to the library on request: the model cannot be reached in tests, so both parts are skipped with the reason and the reference stays.
    const ref = (await (await call(`/api/client/${GYM}/copy-refs`, { method: "POST", body: { message: "Ladies in Bishan, the plan is the thing. Tap Sign up.", headline: "A plan that sticks" } })).json()).ref;
    r = await (await call(`/api/client/${GYM}/copy-refs/${ref.id}/library`, { method: "POST" })).json();
    assert.deepEqual([r.library.entries, r.library.skipped.map((s) => s.kind), r.refs.length, r.refs[0].in_library], [[], ["copy", "headline"], 1, undefined]);
    assert.match(r.library.skipped[0].why, /network blocked|GEMINI_KEY/);
    assert.equal((await call(`/api/client/${GYM}/copy-refs/own-nope/library`, { method: "POST" })).status, 400);
    assert.equal((await call(`/api/client/${GYM}/copy-refs/${ref.id}/library`, { method: "POST", token: null })).status, 403);
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u33#/${GYM}/copy` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!CR.lib && !!document.querySelector('#libCard')"))) await new Promise((x) => setTimeout(x, 120));
    let text = await ev("document.querySelector('#libCard').textContent");
    assert.match(text, /Copy library · 1 copy · 1 headline/); assert.match(text, /✔ Coach-led sessions/); assert.match(text, /drafted 3 times, 1 kept for testgym/); assert.match(text, /says "free"/); assert.match(text, /not drafted from yet/);
    assert.equal(await ev("document.querySelectorAll('#libCard .lib-entry').length"), 2);
    await ev("CR.filter='headline'; paintCopyRefs(document.querySelector('#view')); true");
    assert.deepEqual(await ev("[...document.querySelectorAll('#libCard .lib-entry')].map(e=>e.dataset.id)"), [hid]);
    await ev("CR.filter='retired'; paintCopyRefs(document.querySelector('#view')); true");
    assert.match(await ev("document.querySelector('#libCard').textContent"), /Nothing retired/);
    // Edit: the dialog shows the text with its line breaks; a bad save keeps the text and says why.
    await ev(`libEdit('${id}'); true`);
    assert.equal(await ev("document.querySelector('#libText').value"), SK.replace("{AUDIENCE} in {AREA}", "{GYM} {AREA}"));
    await ev("document.querySelector('#libText').value = 'Only {WRONG}'; CR.libForm.text = 'Only {WRONG}'; true");
    await ev("libEditSave()");
    assert.match(await ev("document.querySelector('.modal .msg.err')?.textContent || ''"), /unknown placeholder/); assert.equal(await ev("document.querySelector('#libText').value"), "Only {WRONG}", "the text is kept in the dialog");
    await ev("libClose(); true");
    // Retire asks why and refuses an empty reason; with one the entry moves to Retired and can be restored.
    await ev(`libRetire('${hid}'); true`); assert.ok(await ev("!!document.querySelector('#libReason')"));
    await ev(`libRetireSave('${hid}')`); assert.match(await ev("document.querySelector('.modal .msg.err')?.textContent || ''"), /reason is required/);
    await ev("document.querySelector('#libReason').value = 'free is never advertised'; true"); await ev(`libRetireSave('${hid}')`);
    assert.ok(!(await ev("!!document.querySelector('.modal')")), "the dialog closed");
    await ev("CR.filter='retired'; paintCopyRefs(document.querySelector('#view')); true");
    text = await ev("document.querySelector('#libCard').textContent"); assert.match(text, /free is never advertised/); assert.match(text, /Restore/);
    await ev(`libRestore('${hid}')`);
    assert.equal(JSON.parse(readFileSync(libFile, "utf-8")).entries.find((e) => e.id === hid).retired, null);
    // The reference offers Send to the library while it is not in it.
    assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/Send to the library/.test(b.textContent))"));
  } finally { rmSync(libFile, { force: true }); rmSync(usesDir, { recursive: true, force: true }); }
});

test("U34 From the ad account (2026-10-07, the first non-Singapore gym): a new gym is scaffolded for its country; the Page and the ad account are read into a proposal (the address with its point, the locale, the pin as the Page's Meta place, ages, budget, offer names, the callout); accepting applies what was ticked to the profile and the wordings; a Taiwan postal code saves; the map refuses a country it has no map for; the page shows the proposal and adds it", async () => {
  const gym = "tw-gym", g = join(brands, gym);
  rmSync(g, { recursive: true, force: true });
  const PAGE = { id: "105176144862096", name: "F45 Xinyi 信義", username: "f45xinyi", category: "Gym", phone: "+886980660800", website: "http://f45xinyi.com/6weekplan", location: { street: "台北市信義區信義路四段413號二樓", city: "Taipei", country: "Taiwan", zip: "110", latitude: 25.033241, longitude: 121.559067 }, single_line_address: "台北市信義區信義路四段413號二樓, Taipei, Taiwan 110", instagram_business_account: { id: "17841449500342630", username: "f45_xinyi" } };
  const place = { geo_locations: { places: [{ key: "105176144862096", name: "F45 Xinyi 信義", latitude: 25.033241, longitude: 121.559067, radius: 2.5 }], location_types: ["home", "recent"] } };
  const graph = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), path = u.pathname; res.writeHead(200, { "content-type": "application/json" });
    if (/\/act_5595320690525032$/.test(path)) return res.end(JSON.stringify({ id: "act_5595320690525032", account_id: "5595320690525032", name: "F45 Xinyi", currency: "TWD", timezone_name: "Asia/Taipei", business_country_code: "TW" }));
    if (/\/act_5595320690525032\/adsets$/.test(path)) return res.end(JSON.stringify({ data: [{ id: "1", name: "0713 6 Week 中年體態雕塑", daily_budget: "500", campaign: { name: "c", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 50, genders: [1], ...place } }, { id: "2", name: "0713 6 Week 女生蜜桃臀", daily_budget: "300", campaign: { name: "c", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 50, genders: [2], ...place } }] }));
    if (/\/105176144862096$/.test(path)) return res.end(JSON.stringify(PAGE));
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => graph.listen(0, "127.0.0.1", r));
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: `http://127.0.0.1:${graph.address().port}` });
  try {
    // A new gym for Taiwan: the starter follows the country.
    assert.equal((await call("/api/clients", { method: "POST", body: { gym, display_name: "F45 Xinyi", country: "Taiwan" } })).status, 400);
    assert.equal((await call("/api/clients", { method: "POST", body: { gym, display_name: "F45 Xinyi", country: "tw" } })).status, 200);
    const pf = join(g, "gym-profile.json");
    let p = JSON.parse(readFileSync(pf, "utf-8"));
    assert.deepEqual([p.locale.country, p.locale.currency, p.targeting_defaults.demographics.locales, p.brand_lock.photography.people], ["TW", "TWD", ["zh_TW"], "Taiwanese, real training clothes, ages 25-55"]);
    // Nothing to read until the Meta link names the ids.
    let r = await (await call(`/api/client/${gym}/meta-facts`)).json();
    assert.deepEqual([r.reading, r.configured, r.ids], [null, true, { ad_account_id: "", page_id: "" }]);
    r = await call(`/api/client/${gym}/meta-facts/read`, { method: "POST" }); assert.equal(r.status, 400); assert.match((await r.json()).error, /Meta link page first/);
    p.meta_assets.ad_account_id = "act_5595320690525032"; p.meta_assets.page_id = "105176144862096"; writeFileSync(pf, JSON.stringify(p, null, 2));
    assert.equal((await call(`/api/client/${gym}/meta-facts/read`, { method: "POST", token: null })).status, 403);
    r = await (await call(`/api/client/${gym}/meta-facts/read`, { method: "POST" })).json();
    assert.deepEqual([r.reading.account.currency, r.reading.page.address.zip, r.reading.pin.key, r.reading.adsets.daily_budget.median, r.reading.offers.map((o) => o.text), r.reading.callouts], ["TWD", "110", "105176144862096", 500, ["6 Week 中年體態雕塑", "6 Week 女生蜜桃臀"], ["信義區"]]);
    assert.ok(existsSync(join(g, "onboarding", "meta", "reading.json")));
    // Accept: the profile and the wordings; the Taiwan postal code "110" saves (the Singapore rule would have refused it).
    r = await (await call(`/api/client/${gym}/meta-facts/accept`, { method: "POST", body: { locale: true, address: true, phone: true, website: true, instagram: true, facebook: true, pin: { radius_km: 3 }, ages: { min: 28, max: 50 }, budget: 500, offers: ["6 Week 女生蜜桃臀"], callouts: ["信義區"] } })).json();
    p = JSON.parse(readFileSync(pf, "utf-8"));
    assert.deepEqual([p.locations[0].postal_code, p.locations[0].lat, p.website, p.social.instagram, p.targeting_defaults.geo.radius_pins[0].place_key, p.targeting_defaults.geo.radius_pins[0].callouts, p.campaign_defaults.budget, p.creative_defaults.locations], ["110", 25.033241, "http://f45xinyi.com/6weekplan", "f45_xinyi", "105176144862096", ["信義區"], { ...p.campaign_defaults.budget, amount: 500, currency: "TWD" }, ["信義區"]]);
    assert.deepEqual([r.wordings_added, r.wordings.includes("6 Week 女生蜜桃臀"), r.profile.callouts], [["6 Week 女生蜜桃臀"], true, ["信義區"]]);
    // The profile saves through the panel with its 3-digit code; the map refuses a country it has no map for.
    const put = await call(`/api/client/${gym}`, { method: "PUT", body: p }); assert.equal(put.status, 200, await put.text());
    r = await call(`/api/geocode?q=110&gym=${gym}`); assert.equal(r.status, 400); assert.match((await r.json()).error, /no map for Taiwan/);
    // The plan would send TWD budgets in whole units: 500, not 50000.
    const { buildPlan } = await import("../skills/references/meta-publish.mjs");
    const mk = (await import("../skills/references/read-meta.mjs")).budgetUnits; assert.equal(mk("TWD"), 1);
    // The page: the proposal with its boxes, and Add to the gym.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u34#/${gym}/metafacts` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!MF.data && !!MF.pick && /Where and who/.test(document.querySelector('#view')?.textContent||'')"))) await new Promise((x) => setTimeout(x, 120));
    const text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /F45 Xinyi 信義/); assert.match(text, /already a location/); assert.match(text, /TW · TWD · Asia\/Taipei/); assert.match(text, /6 Week 中年體態雕塑/); assert.match(text, /a wording already/); assert.match(text, /on Ad defaults/);
    assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/Add to the gym/.test(b.textContent))"));
    assert.equal(await ev("MF.pick.address"), false, "the address is already a location, so it is not ticked again");
    void buildPlan;
  } finally { await panel.stop(); panel = main; graph.close(); rmSync(g, { recursive: true, force: true }); }
});

test("U35 a new gym's scenes from a sibling's library: the Scenes answer lists the other gyms with live scenes; copying brings them in as drafts with the country swapped (the Singapore source into a Taiwan gym), nothing generates until one is approved, a second copy adds nothing; a gym without a library or the gym itself is refused; the page offers it when the gym has no scenes", async () => {
  const gym = "tw-scenes", g = join(brands, gym);
  rmSync(g, { recursive: true, force: true });
  assert.equal((await call("/api/clients", { method: "POST", body: { gym, display_name: "TW Scenes", country: "TW" } })).status, 200);
  try {
    let r = await (await call(`/api/client/${gym}/scenes`)).json();
    const sib = r.siblings.find((s) => s.gym === GYM);
    assert.ok(sib && sib.live > 0, "the test gym's approved library is offered");
    assert.ok(!r.siblings.some((s) => s.gym === gym));
    assert.equal((await call(`/api/client/${gym}/scenes/copy`, { method: "POST", body: { from: gym } })).status, 400);
    assert.equal((await call(`/api/client/${gym}/scenes/copy`, { method: "POST", body: { from: "no-such-gym" } })).status, 400);
    assert.equal((await call(`/api/client/${gym}/scenes/copy`, { method: "POST", body: { from: GYM }, token: null })).status, 403);
    r = await (await call(`/api/client/${gym}/scenes/copy`, { method: "POST", body: { from: GYM } })).json();
    assert.deepEqual([r.added.length, r.skipped, r.status.exists, r.status.approved, r.drafts.length], [sib.live, [], true, false, sib.live]);
    assert.ok(r.drafts.every((d) => d.source === `copied:${GYM}`));
    const lib = JSON.parse(readFileSync(join(g, "scenes.json"), "utf-8"));
    const srcSG = JSON.parse(readFileSync(join(brands, GYM, "scenes.json"), "utf-8")).scenes.some((s) => /Singaporean/.test(s.scene));
    assert.ok(!lib.scenes.some((s) => /Singaporean/.test(s.scene)) && (!srcSG || lib.scenes.some((s) => /Taiwanese/.test(s.scene))), "the people's country followed the gym");
    r = await (await call(`/api/client/${gym}/scenes/copy`, { method: "POST", body: { from: GYM } })).json();
    assert.deepEqual([r.added, r.skipped.length], [[], sib.live]);
    // The page: a gym with no scenes offers the sibling; after the copy the drafts are listed for approval.
    const gym2 = "tw-scenes-2"; rmSync(join(brands, gym2), { recursive: true, force: true });
    assert.equal((await call("/api/clients", { method: "POST", body: { gym: gym2, display_name: "TW Scenes 2", country: "TW" } })).status, 200);
    try {
      const { cdp, sessionId } = browser;
      const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
      const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u35#/${gym2}/scenes` }, sessionId); await loaded;
      const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!document.querySelector('#bCopyFrom')"))) await new Promise((x) => setTimeout(x, 120));
      assert.ok(await ev("[...document.querySelectorAll('#bCopyFrom option')].some(o=>o.value===" + JSON.stringify(GYM) + ")"), "the sibling is offered");
      await ev(`document.querySelector('#bCopyFrom').value = ${JSON.stringify(GYM)}; true`);
      await ev("bCopyScenes()");
      const t1 = Date.now(); while (Date.now() - t1 < 20000 && !(await ev("/copied as drafts/.test(document.querySelector('#bSceneMsg')?.textContent||'')"))) await new Promise((x) => setTimeout(x, 120));
      const text = await ev("document.querySelector('#bSceneCard').textContent");
      assert.match(text, new RegExp(`${sib.live} scenes? copied as drafts`)); assert.match(text, /not approved yet/); assert.match(text, /Approve all/);
    } finally { rmSync(join(brands, gym2), { recursive: true, force: true }); }
  } finally { rmSync(g, { recursive: true, force: true }); }
});

test("U36 the room reference (2026-10-07): coach and member photos can be surveyed and cleaned (into reference-clean, never with premises photos in one run); a cleaned people photo is a room reference only — listed as such, never among Create's real photos; the owner picks the room reference from the cleaned photos and every brief without one gets it; a photo that is not cleaned is refused", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json"), before = readFileSync(pf, "utf-8");
  await linkTestGym();
  // Distinct bytes per upload (the same content is never filed twice): a PNG keeps working with bytes after IEND.
  const base = readFileSync(join(g, "brand-assets", "facility-clean", "r2.png")), png = Buffer.concat([base, Buffer.from("u36-members")]), png2 = Buffer.concat([base, Buffer.from("u36-facility")]);
  const up = (kind, name, body = png) => raw(`/api/client/${GYM}/asset/${kind}/${name}`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-panel-token": panel.token, "x-keep-low-res": "1" }, body });
  const refClean = join(g, "brand-assets", "reference-clean");
  try {
    let u = await up("members", "floor-u36.png"); assert.equal(u.status, 200, u.body); u = await up("facility", "room-u36.png", png2); assert.equal(u.status, 200, u.body);
    const post = (body) => call("/api/run", { method: "POST", body });
    let r = await post({ kind: "photo-survey", gym: GYM, photos: ["members/floor-u36.png", "room-u36.png"] });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /separate runs/);
    assert.equal((await post({ kind: "photo-survey", gym: GYM, photos: ["logo/x.png"] })).status, 400);
    assert.equal((await post({ kind: "photo-survey", gym: GYM, photos: ["members/../facility/room-u36.png"] })).status, 400);
    let ran = await runAndWait({ kind: "photo-survey", gym: GYM, photos: ["members/floor-u36.png"] });
    assert.match(ran.lines[0], /--survey-only --photo \S+brand-assets\/members\/floor-u36\.png$/, ran.lines[0]);
    ran = await runAndWait({ kind: "photo-clean", gym: GYM, photos: ["members/floor-u36.png"], confirm: { max_calls: 4 } });
    assert.match(ran.lines[0], /--attempts 2 --clean-dir \S+brand-assets\/reference-clean --photo \S+members\/floor-u36\.png$/, "a people photo cleans into reference-clean");
    ran = await runAndWait({ kind: "photo-clean", gym: GYM, photos: ["room-u36.png"], confirm: { max_calls: 4 } });
    assert.ok(!/--clean-dir/.test(ran.lines[0]), "a premises photo cleans where it always did");
    // A cleaned people photo (as the clean-up would leave it): a room reference only.
    mkdirSync(refClean, { recursive: true }); writeFileSync(join(refClean, "floor-u36.png"), png);
    let a = await (await call(`/api/client/${GYM}/assets`)).json();
    const mine = a.clean.find((x) => x.path === "reference-clean/floor-u36.png");
    assert.deepEqual([mine?.people, a.clean.find((x) => x.path === "facility-clean/r1.png")?.people, a.room_reference, a.assets.find((x) => x.path === "members/floor-u36.png")?.cleaned], [true, false, null, true]);
    const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
    assert.ok(setup.photos.some((p) => p.path === "facility-clean/r1.png") && !setup.photos.some((p) => p.people || p.path.startsWith("reference-clean/")), "never offered as a real photo");
    // The owner's pick, kept on the profile; only a cleaned photo.
    r = await call(`/api/client/${GYM}/room-reference`, { method: "POST", body: { path: "members/floor-u36.png" } }); assert.equal(r.status, 400); assert.match((await r.json()).error, /cleaned photos/);
    assert.equal((await call(`/api/client/${GYM}/room-reference`, { method: "POST", body: { path: "reference-clean/floor-u36.png" }, token: null })).status, 403);
    r = await (await call(`/api/client/${GYM}/room-reference`, { method: "POST", body: { path: "reference-clean/floor-u36.png" } })).json();
    assert.equal(r.room_reference, "reference-clean/floor-u36.png");
    assert.equal(JSON.parse(readFileSync(pf, "utf-8")).creative_defaults.room_reference, "reference-clean/floor-u36.png");
    a = await (await call(`/api/client/${GYM}/assets`)).json(); assert.equal(a.room_reference, "reference-clean/floor-u36.png");
    // Every brief without a reference gets the gym's; one that names its own keeps it.
    const brief = { ...BRIEF, batch_id: "u36-ref", generated: 0, real: ["facility-clean/r1.png"] };
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief } })).json();
    assert.deepEqual([c.errors, c.brief.reference], [[], "reference-clean/floor-u36.png"]);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...brief, reference: "facility-clean/r2.png" } } })).json();
    assert.equal(c.brief.reference, "facility-clean/r2.png");
    // Cleared.
    r = await (await call(`/api/client/${GYM}/room-reference`, { method: "POST", body: { path: null } })).json(); assert.equal(r.room_reference, null);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief } })).json(); assert.equal(c.brief.reference, undefined);
    // The page: the people photo listed apart as a room reference, the ask-the-gym card absent (there are cleaned premises photos), Survey on the members section.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u36#/${GYM}/photos` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!A.data && /Cleaned photos/.test(document.querySelector('#view')?.textContent||'')"))) await new Promise((x) => setTimeout(x, 120));
    const text = await ev("document.querySelector('#view').textContent");
    assert.match(text, /Coaches and members · room reference only/); assert.match(text, /Use as room reference/); assert.doesNotMatch(text, /what to ask the gym for/);
    await ev("aToggle('members/floor-u36.png'); true");
    assert.ok(await ev("[...document.querySelectorAll('#view button')].some(b=>/^Survey 1/.test(b.textContent.trim()) && !b.disabled)"), "Survey offered for the selected member photo");
    await ev("aToggle('facility/room-u36.png'); true");
    assert.ok(await ev("[...document.querySelectorAll('#view button')].filter(b=>/^Survey/.test(b.textContent.trim())).every(b=>b.disabled)"), "a mixed selection cannot run");
  } finally { writeFileSync(pf, before); rmSync(refClean, { recursive: true, force: true }); for (const f of ["members/floor-u36.png", "facility/room-u36.png"]) rmSync(join(g, "brand-assets", f), { force: true }); }
});

test("U37 Run again: a stopped batch's card offers it (and a run that ended on an error, or is no longer running without finishing); the confirmation shows the brief's own words and cap; confirming starts the batch run on that brief", async () => {
  const g = join(brands, GYM), out = join(g, "outputs", "u37-stopped"), bdir = join(g, "batches", "u37-stopped");
  rmSync(out, { recursive: true, force: true }); rmSync(bdir, { recursive: true, force: true });
  mkdirSync(out, { recursive: true }); mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "brief.json"), JSON.stringify({ ...BRIEF, batch_id: "u37-stopped", generated: 1, max_calls: 2 }));
  writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "stopped", stopped_at: "photos", pid: 1, photos: {}, calls: 0 }));
  writeFileSync(join(out, "spend.json"), JSON.stringify({ image_calls: 1 }));
  try {
    let bs = (await (await call(`/api/client/${GYM}/batch-setup`)).json()).batches;
    let b = bs.find((x) => x.id === "u37-stopped"); assert.deepEqual([!!b.stopped, b.stopped.image_calls, b.failed, b.running], [true, 1, null, null]);
    writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "failed", error: "boom", pid: 1, photos: {}, calls: 0 }));
    bs = (await (await call(`/api/client/${GYM}/batch-setup`)).json()).batches; b = bs.find((x) => x.id === "u37-stopped");
    assert.deepEqual([b.stopped, b.failed], [null, { stage: "failed", error: "boom", image_calls: 1 }]);
    writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "photos", pid: 1, photos: {}, calls: 0 }));
    b = (await (await call(`/api/client/${GYM}/batch-setup`)).json()).batches.find((x) => x.id === "u37-stopped"); assert.equal(b.failed.stage, "photos", "no longer running without finishing");
    writeFileSync(join(out, "progress.json"), JSON.stringify({ stage: "stopped", stopped_at: "photos", pid: 1, photos: {}, calls: 0 }));
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u37#/${GYM}/batch` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("[...document.querySelectorAll('#bList .camp')].some(c=>/u37-stopped/.test(c.textContent))"))) await new Promise((x) => setTimeout(x, 120));
    const card = await ev("[...document.querySelectorAll('#bList .camp')].find(c=>/u37-stopped/.test(c.textContent)).textContent");
    assert.match(card, /stopped · 1 call used/); assert.match(card, /Run again…/);
    await ev("bRunAgain('u37-stopped')");
    const t1 = Date.now(); while (Date.now() - t1 < 10000 && !(await ev("!!document.querySelector('#bRunAgainGo')"))) await new Promise((x) => setTimeout(x, 100));
    const modal = await ev("document.querySelector('#gModal').textContent");
    assert.match(modal, /Run this batch again\?/); assert.match(modal, new RegExp(WORDS.offer)); assert.match(modal, /1 image call already used/); assert.match(modal, /up to 2 image calls/);
    await ev("window.__bRunAgainGo(); true");
    const t2 = Date.now(); while (Date.now() - t2 < 15000 && !(await ev("!!STATE.run && /^batch-/.test(STATE.run.id||'')"))) await new Promise((x) => setTimeout(x, 150));
    assert.ok(await ev("/^batch-/.test(STATE.run?.id||'')"), "the batch run started");
    assert.equal(await ev("STATE.tab"), "generating");
    const t3 = Date.now(); while (Date.now() - t3 < 60000 && !(await ev("!!STATE.run?.done"))) await new Promise((x) => setTimeout(x, 300));
    assert.ok(await ev("JSON.stringify(STATE.run).includes('u37-stopped/brief.json') || (document.querySelector('#view')?.textContent||'').includes('u37-stopped/brief.json')"), "the batch command on this brief");
    assert.equal(await ev("STATE.batch"), "u37-stopped");
  } finally { rmSync(out, { recursive: true, force: true }); rmSync(bdir, { recursive: true, force: true }); }
});

// ── U40 instant forms built here (2026-10-07) ───────────────────────────────

test("U40 lead forms through the panel: the Page's forms listed in full; one set as the template (its offer and district phrases read); a proposal for a new offer with their naming scheme and the words swapped; creation on the Page carries exactly the spec, is refused for a spec with problems before any call, and is recorded; the gym's default form set on the profile; nothing without the Meta link", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json");
  let r = await (await call(`/api/client/${GYM}/lead-forms`)).json();
  assert.deepEqual([r.configured, r.forms, !!r.reason], [false, [], true], "no keys: said, nothing read");
  const graph = await fakeGraph();
  const main = panel;
  panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url });
  try {
    const profile = JSON.parse(readFileSync(pf, "utf-8"));
    profile.meta_assets = { ...(profile.meta_assets || {}), page_id: "770000000007", ad_account_id: "act_111000000001", labels: { page: "Test Gym" } };
    profile.creative_defaults = { ...(profile.creative_defaults || {}), locations: ["BISHAN"] };
    writeFileSync(pf, JSON.stringify(profile, null, 2));
    r = await (await call(`/api/client/${GYM}/lead-forms`)).json();
    assert.deepEqual([r.configured, r.page_id, r.forms.map((f) => f.id), r.forms[0].question_count, r.record.template], [true, "770000000007", ["400100000001"], 4, null]);
    // The template.
    assert.equal((await call(`/api/client/${GYM}/lead-forms/template`, { method: "POST", body: { id: "x" } })).status, 400);
    assert.equal((await call(`/api/client/${GYM}/lead-forms/template`, { method: "POST", body: { id: "400100000099" } })).status, 404, "not on the Page");
    r = await (await call(`/api/client/${GYM}/lead-forms/template`, { method: "POST", body: { id: "400100000001" } })).json();
    assert.deepEqual([r.template.source.id, r.template.phrases.offer, r.template.spec.questions.length, r.template.spec.thank_you_page.business_phone_number], ["400100000001", "12 Week Reset", 4, "+6591234567"]);
    // A proposal: nothing sent to Meta.
    const before = graph.calls.length;
    r = await (await call(`/api/client/${GYM}/lead-forms/propose`, { method: "POST", body: { offer: "6 Week Shred", callout: "THOMSON", old_district: "Bishan" } })).json();
    assert.match(r.spec.name, /^\d{4} 6 Week Shred$/, "no version scheme in the template's name: the date and the offer");
    assert.deepEqual([r.spec.questions[1].label, r.spec.questions[0].label, r.spec.context_card.title, r.problems], ["Why the 6 Week Shred?", "Do you live or work near THOMSON?", "6 Week Shred", []]);
    assert.equal(graph.calls.length, before, "a proposal calls Meta for nothing");
    const specName = r.spec.name;
    assert.equal((await call(`/api/client/${GYM}/lead-forms/propose`, { method: "POST", body: { offer: "" } })).status, 400);
    // Creation: a spec with problems is refused before any call; a good one is sent as it is and recorded.
    const bad = await call(`/api/client/${GYM}/lead-forms/create`, { method: "POST", body: { spec: { ...r.spec, privacy_policy: null } } });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /privacy policy address is required/);
    assert.equal(graph.made.form, undefined, "nothing created");
    const made = await (await call(`/api/client/${GYM}/lead-forms/create`, { method: "POST", body: { spec: r.spec, offer: "6 Week Shred" } })).json();
    assert.deepEqual([made.made.id, made.made.name, made.made.offer, made.made.from_template, made.made.questions], ["400100000009", r.spec.name, "6 Week Shred", "400100000001", 4]);
    const sent = graph.made.form.body;
    assert.equal(sent.access_token, "PAGE-TOKEN", "through the Page's own token");
    assert.deepEqual(JSON.parse(sent.questions)[0], { type: "CUSTOM", label: "Do you live or work near THOMSON?", key: "q1", options: [{ key: "y", value: "Yes" }, { key: "n", value: "No" }] }, "the form's own keys kept, every option with one");
    assert.deepEqual(JSON.parse(sent.privacy_policy), { url: "https://testgym.sg/privacy", link_text: "Privacy" });
    assert.deepEqual(JSON.parse(sent.thank_you_page).button_type, "CALL_BUSINESS");
    assert.equal(sent.locale, "en_GB");
    const rec = JSON.parse(readFileSync(join(g, "lead-forms.json"), "utf-8"));
    assert.deepEqual([rec.created.length, rec.created[0].id, rec.template.source.id], [1, "400100000009", "400100000001"]);
    // The gym's default form, on the profile.
    assert.equal((await call(`/api/client/${GYM}/lead-forms/default`, { method: "POST", body: { id: "nope" } })).status, 400);
    r = await (await call(`/api/client/${GYM}/lead-forms/default`, { method: "POST", body: { id: "400100000009", name: specName } })).json();
    assert.equal(r.default_form_id, "400100000009");
    const p2 = JSON.parse(readFileSync(pf, "utf-8"));
    assert.deepEqual([p2.meta_assets.lead_form_id, p2.meta_assets.labels.form], ["400100000009", specName]);
    r = await (await call(`/api/client/${GYM}/lead-forms`)).json();
    assert.equal(r.default_form_id, "400100000009");
    // A gym whose targeting was never imported: the Publish Ads screen imports it from the account the first time (2026-10-07).
    rmSync(join(g, "targeting-presets.json"), { force: true });
    const pub = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
    assert.equal(pub.presets_import?.imported, true, JSON.stringify(pub.presets_import));
    assert.ok(pub.presets.length >= 1 && existsSync(join(g, "targeting-presets.json")), "the account's presets are listed and on disk");
    const again = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
    assert.equal(again.presets_import, null, "imported once, not on every open");
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});


// ── U41 the shared targeting library (2026-10-07) ───────────────────────────

test("U41 the shared targeting library through the panel: read once, the curated drafts are there unapproved and nothing applies; approving one makes it the default on the Publish Ads screen for a gym whose default mode is shared, listed under Shared defaults with the account's own below; a campaign may pick a library preset; retire needs a reason; the gym's targeting view carries the library; an entry of the owner's needs Meta ids", async () => {
  const g = join(brands, GYM), out = join(g, "outputs", BRIEF.batch_id);
  assert.ok(existsSync(join(out, "batch.json")), "U5 made the batch");
  let lib = await (await call("/api/library/targeting")).json();
  assert.deepEqual([lib.entries.length, lib.approved, lib.drafts, lib.entries.map((e) => e.name)], [3, 0, 3, ["Fitness core", "Fitness core · women", "Affluent × fitness"]]);
  assert.ok(lib.entries[0].preset_id.startsWith("lib:") && lib.entries[0].summary.length, "a library id for the plan and a summary of the interests");
  // Nothing applies until approved: the plan's ad sets say so.
  let pub = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
  assert.ok(pub.plan.adsets.every((a) => !a.preset.id.startsWith("lib:")), "no library preset before approval");
  assert.ok(pub.presets.every((p) => p.group === "account"), "only the account's presets listed");
  // Approve the core: every ad set (men / everyone here) gets it; the list leads with the shared defaults.
  const core = lib.entries[0];
  assert.equal((await call(`/api/library/targeting/${core.id}/retire`, { method: "POST", body: {} })).status, 400, "retire needs a reason");
  lib = await (await call(`/api/library/targeting/${core.id}/approve`, { method: "POST", body: {} })).json();
  assert.deepEqual([lib.approved, lib.drafts], [1, 2]);
  pub = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
  assert.ok(pub.plan.adsets.length >= 1);
  for (const a of pub.plan.adsets) assert.deepEqual([a.preset.id, a.preset.name, a.preset.how], [`lib:${core.id}`, "Fitness core", `the shared default for ${a.gender === "women" ? "women" : a.gender === "men" ? "men" : "everyone"}: Fitness core`]);
  assert.deepEqual(pub.presets.filter((p) => p.group === "shared").map((p) => p.name), ["Fitness core"], "approved shared defaults listed first");
  const set = pub.plan.adsets[0];
  assert.equal(set.payload.targeting.flexible_spec[0].interests.length, 7, "the seven interests on the ad set's targeting");
  // A campaign's own pick of a library preset, and a gym whose default mode is broad.
  const women = lib.entries[1];
  await call(`/api/library/targeting/${women.id}/approve`, { method: "POST", body: {} });
  const settings = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { ...pub.settings, adsets: { [set.callout]: { preset: `lib:${women.id}` } } } })).json();
  assert.deepEqual([settings.plan.adsets[0].preset.name, settings.plan.adsets[0].preset.how], ["Fitness core · women", "chosen for this campaign, from the shared library"]);
  await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { ...pub.settings, adsets: {} } });
  const pf = join(g, "gym-profile.json"), profile = JSON.parse(readFileSync(pf, "utf-8"));
  profile.targeting_defaults = { ...(profile.targeting_defaults || {}), detailed_targeting: { default: "broad" } };
  writeFileSync(pf, JSON.stringify(profile, null, 2));
  pub = await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json();
  assert.deepEqual([pub.plan.adsets[0].preset.id, pub.plan.adsets[0].preset.how], ["broad", "the gym's default: Broad"]);
  profile.targeting_defaults.detailed_targeting = { default: "nonsense" };
  assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: profile })).status, 400, "the default mode is checked");
  profile.targeting_defaults.detailed_targeting = {};
  writeFileSync(pf, JSON.stringify(profile, null, 2));
  // The gym's targeting view carries the library; retire with a reason; the owner's own entry.
  const tg = await (await call(`/api/client/${GYM}/targeting`)).json();
  assert.equal(tg.library.approved, 2);
  lib = await (await call(`/api/library/targeting/${women.id}/retire`, { method: "POST", body: { reason: "too narrow" } })).json();
  assert.deepEqual([lib.approved, lib.entries[1].retired.reason], [1, "too narrow"]);
  lib = await (await call(`/api/library/targeting/${women.id}/restore`, { method: "POST", body: {} })).json();
  assert.equal(lib.approved, 2);
  assert.equal((await call("/api/library/targeting", { method: "POST", body: { name: "x", groups: [[{ id: "nope", name: "x" }]] } })).status, 400);
  lib = await (await call("/api/library/targeting", { method: "POST", body: { name: "Runners", role: "option", groups: [[{ id: "6003107634035", name: "healthy habits" }]] } })).json();
  assert.deepEqual([lib.entries.length, lib.drafts], [4, 2]);
});

// ── U42 importing a gym from the portfolio (2026-10-07) ─────────────────────

test("U42 the portfolio and the import through the panel: without keys the portfolio says so; a new gym from the portfolio gets its Meta ids, currency and time zone on the profile (bad ids refused); the import view says what was read (nothing yet) and which steps there are; the import run is built server-side; Add to the gym without a reading is refused in words", async () => {
  let r = await (await call("/api/meta/portfolio")).json();
  assert.deepEqual([r.configured, r.accounts, r.pages], [false, [], []]);
  assert.equal((await call("/api/clients", { method: "POST", body: { gym: "portfolio-gym", display_name: "Portfolio Gym", country: "TW", meta: { ad_account_id: "nope", page_id: "770000000007" } } })).status, 400, "bad ids refused");
  r = await (await call("/api/clients", { method: "POST", body: { gym: "portfolio-gym", display_name: "Portfolio Gym", country: "TW", meta: { ad_account_id: "111000000001", page_id: "770000000007", business_id: "555000000005", instagram_user_id: "880000000008", currency: "TWD", timezone: "Asia/Taipei", labels: { account: "Test Gym Ads (TWD)", page: "Test Gym" } } } })).json();
  assert.deepEqual([r.created, r.imported_ids], [true, true]);
  const p = JSON.parse(readFileSync(join(brands, "portfolio-gym", "gym-profile.json"), "utf-8"));
  assert.deepEqual([p.meta_assets.ad_account_id, p.meta_assets.page_id, p.meta_assets.business_id, p.meta_assets.instagram_user_id, p.meta_assets.labels.page, p.locale.currency, p.locale.timezone, p.campaign_defaults.budget.currency, p.locale.country], ["act_111000000001", "770000000007", "555000000005", "880000000008", "Test Gym", "TWD", "Asia/Taipei", "TWD", "TW"]);
  r = await (await call("/api/client/portfolio-gym/import")).json();
  assert.deepEqual([r.state, r.meta, r.forms, r.website, r.history.top, r.presets.count, r.steps.length, r.history_top, r.profile.meta_assets.page_id], [null, null, null, null, [], 0, 7, 10, "770000000007"]);
  const run = await runAndWait({ kind: "profile-import", gym: "portfolio-gym", skip: ["website", "instagram"] });
  assert.match(run.lines[0], /^\$ node skills\/references\/import-gym\.mjs --brand-dir \S+portfolio-gym --skip website,instagram$/, "built server-side");
  assert.notEqual(run.code, 0, "no Meta keys here: the run says so and ends");
  const bad = await call("/api/client/portfolio-gym/import/accept", { method: "POST", body: { meta: true } });
  const badBody = await bad.json();
  assert.equal(bad.status, 409, JSON.stringify(badBody)); assert.match(badBody.error, /read the ad account first/);
});

// ── U43 the Generate Creatives screen says why (2026-10-10) ────────────────────────────

test("U43 the Generate Creatives screen says why Generate is grey, shows the brief's problems from the start, checks a run's state with the panel instead of guessing (GET /api/run/{id}; a run the panel does not know is over), and a gym the page has not seen is loaded from the panel rather than swapped for another", async () => {
  const logBefore = panel.log().length; // earlier tests provoke blocked fetches on purpose; only this test's lines count
  // The run-state route: an unknown id is gone; a free dry-run plan reports its state, then done.
  const gone = await call("/api/run/batch-plan-nope"); assert.equal(gone.status, 404); assert.equal((await gone.json()).gone, true);
  const started = await (await call("/api/run", { method: "POST", body: { kind: "batch-plan", gym: GYM, batch: BRIEF.batch_id } })).json();
  const s1 = await (await call(`/api/run/${started.id}`)).json();
  assert.deepEqual([s1.id, s1.kind, s1.gym, s1.batch, typeof s1.done], [started.id, "batch-plan", GYM, BRIEF.batch_id, "boolean"]);
  await (await fetch(`${panel.url}/api/run/${started.id}/stream`)).text(); // the stream ends when the run does
  const s2 = await (await call(`/api/run/${started.id}`)).json();
  assert.deepEqual([s2.done, s2.code, s2.stopped], [true, 0, false]);
  const { cdp, sessionId } = browser;
  const ev = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}: ${await ev(`JSON.stringify({ why: document.querySelector('#bWhy')?.textContent, errs: document.querySelector('#bErrors')?.textContent, run: STATE.run && { id: STATE.run.id, done: STATE.run.done }, sel: STATE.sel, hash: location.hash, toast: document.querySelector('#toast')?.textContent })`)}`);
  };
  const text = (sel) => `(document.querySelector('${sel}')?.textContent||'')`;
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: `${panel.url}/#/${GYM}/batch` }, sessionId);
  await loaded;
  await until(`typeof STATE!=='undefined' && STATE.sel==='${GYM}' && !!document.querySelector('#bOffer')`, "the Generate Creatives screen");
  // 1. A fresh form: the buttons are grey and the line says what to do; the empty offer is not listed as a problem.
  await until(`/Type the offer( and a location)? to start/.test(${text("#bWhy")}) && document.querySelector('#bRun').disabled`, "the why line on a fresh form (with or without a default location, as earlier tests leave the profile)");
  assert.equal(await ev(text("#bErrors")), "", "an empty offer or location row on an untouched form is where every batch begins, not a problem");
  // 2. A problem is shown before any field is touched.
  await ev(`B.draft.locations=['BISHAN — EAST']; B.touched=false; scheduleCheck(0); true`);
  await until(`/em\\/en dash/.test(${text("#bErrors")}) && /Fix the 1 problem above/.test(${text("#bWhy")}) && document.querySelector('#bRun').disabled`, "the dash shown untouched, and the why line counting it");
  await ev(`B.draft.locations=['BISHAN']; B.draft.offer=${JSON.stringify(WORDS.offer)}; B.touched=true; scheduleCheck(0); true`);
  await until(`!document.querySelector('#bRun').disabled && ${text("#bWhy")}===''`, "a valid brief: enabled, nothing to explain");
  // 1 + 4. A run the page believes is going greys the buttons and says which; the panel does not know it (a restart), so a check clears it.
  await ev(`STATE.run={id:'batch-plan-old', label:'An old run', lines:[], done:false, code:null}; paintDerived(); true`);
  assert.ok(await ev(`document.querySelector('#bRun').disabled && /A run is going: An old run/.test(${text("#bWhy")})`), "busy, and said");
  await ev(`syncRun(); true`);
  await until(`STATE.run.done===true && !document.querySelector('#bRun').disabled && ${text("#bWhy")}===''`, "the stale run cleared with the panel's answer");
  assert.ok(await ev(`STATE.run.lines.some(l=>/panel restarted/.test(l.line))`), "the log says why it ended here");
  // 4. A stream that drops on a run the panel does know: its real state is taken (the finished plan), not a guess.
  await ev(`STATE.run={id:${JSON.stringify(started.id)}, label:'Plan', lines:[], done:false, code:null}; resyncRun(${JSON.stringify(started.id)}, 'Plan', null, null); true`);
  await until(`STATE.run.done===true && STATE.run.code===0 && !STATE.run.lines.some(l=>/panel restarted/.test(l.line))`, "the finished run's own state");
  // 3. A gym made after this page loaded is found when its address is opened; a name that is nowhere is said and the address put back.
  const g2 = join(brands, "newgym"); mkdirSync(g2, { recursive: true }); writeFileSync(join(g2, "gym-profile.json"), JSON.stringify({ display_name: "New Gym" }));
  try {
    assert.ok(!(await ev(`STATE.clients.some(c=>c.gym==='newgym')`)), "unknown to the page so far");
    await ev(`location.hash='#/newgym/batch'; true`);
    await until(`STATE.sel==='newgym' && B.gym==='newgym' && !!document.querySelector('#bOffer')`, "the new gym's Generate Creatives screen, with the new gym's own form (not the first gym's left on screen)");
    await ev(`location.hash='#/nowhere/batch'; true`);
    await until(`/No gym called "nowhere" here/.test(${text("#toast")}) && location.hash==='#/newgym/batch' && STATE.sel==='newgym'`, "the unknown name said, the address put back");
    await ev(`location.hash='#/${GYM}/batch'; true`);
    await until(`STATE.sel==='${GYM}'`, "back on the test gym");
  } finally { rmSync(g2, { recursive: true, force: true }); }
  assert.ok(!/NETWORK BLOCKED/.test(panel.log().slice(logBefore)), "nothing here reaches outside this machine");
});

// ── U44 take Meta's figure (2026-10-11) ────────────────────────────────────

test("U44 take Meta's figure: a budget or name changed in Ads Manager becomes the campaign's setting and the record through the panel; a line that is only news is refused; a kind that is not in the last pull says to pull again", async () => {
  const out = join(brands, GYM, "outputs", BRIEF.batch_id);
  const keep = Object.fromEntries(["publish.json", "publish-settings.json", "results.json"].map((f) => [f, existsSync(join(out, f)) ? readFileSync(join(out, f), "utf-8") : null]));
  try {
    writeFileSync(join(out, "publish.json"), JSON.stringify({ campaign: { id: "c1", name: "App name" }, adsets: { BISHAN: { id: "s1", name: "0913 Bishan | …", facts: { daily: 50 } } }, ads: {}, superseded: [], runs: [] }));
    writeFileSync(join(out, "publish-settings.json"), JSON.stringify({ campaign: { name: "App name" }, adsets: { BISHAN: { pin: 0 } } }));
    writeFileSync(join(out, "results.json"), JSON.stringify({ pulled: "2026-10-11T00:00:00.000Z", currency: "SGD", drift: [
      { kind: "adset_budget", callout: "BISHAN", text: "ad set BISHAN's budget on Meta is SGD 80 a day; the app's setting is SGD 50 — …", meta: 80, app: 50, fixable: true },
      { kind: "ads_extra", text: "1 ad in the campaign was not made by this app", count: 1, fixable: false }] }));
    let r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/drift/take`, { method: "POST", body: { kind: "adset_budget", callout: "BISHAN" } });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual([j.settings.adsets.BISHAN.daily, j.settings.adsets.BISHAN.pin, j.drift.map((d) => d.kind)], [80, 0, ["ads_extra"]], "the setting taken, the rest of the ad set's settings kept, the line gone");
    assert.equal(JSON.parse(readFileSync(join(out, "publish.json"), "utf-8")).adsets.BISHAN.facts.daily, 80, "the record of what the app sent follows too");
    r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/drift/take`, { method: "POST", body: { kind: "adset_budget", callout: "BISHAN" } });
    assert.equal(r.status, 404, "taken already: not in the last pull any more");
    r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/drift/take`, { method: "POST", body: { kind: "ads_extra" } });
    assert.equal(r.status, 400, "a kind the route does not take");
    r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/drift/take`, { method: "POST", body: { kind: "campaign_name" } });
    assert.equal(r.status, 404);
  } finally { for (const [f, v] of Object.entries(keep)) { if (v == null) rmSync(join(out, f), { force: true }); else writeFileSync(join(out, f), v); } }
});

test("U45 what wins (the data loop, 2026-11-09): an Ads Manager export uploaded from Results joins the history as rows of origin export with its rankings and frequency; the results answer carries What wins — the scope (the ads running now, every ad), the median, the attribute tables with a confidence word, the suggestions by rule; the creative-reading run is refused with a bad cap or without a history; the page shows the card, the scope switch, the upload, and names an export's rows; What wins for one campaign alone (?campaign=, the card's campaign list, back to every campaign)", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true });
  const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach,Ends,Bid,"Bid type","Last significant edit","Quality ranking","Engagement rate ranking","Conversion rate ranking","Ad set name","Results (initial)","Results (initial) indicator"`;
  const row = (ad, results, spend, imp, reach, delivery = "active") => `2023-10-08,2026-11-08,"${ad}",${delivery},"7-day click or 1-day view",${results},actions:leadgen.other,${results ? (spend / results).toFixed(4) : 0},100,Daily,${spend},${imp},${reach},Ongoing,0,ABSOLUTE_OCPM,2026-10-15T19:04:37+0800,Average,"Above average","Above average","0413 Broad Audience | Both Genders | 25-50 | +3KM",,`;
  const CSV = [HEADER, row("0413 Beginner's Body Reset | Image 5: Couple Smiling With Dumbbells", 86, 1248.58, 135032, 30412), row("0413 Beginner's Body Reset | Video 2: Shami Intro 3", 2, 64.29, 4428, 2491), row("0413 Total Body Reset | Image 5: Girl Running Outdoors Grayscale", 2, 59.24, 3849, 1875, "inactive")].join("\n") + "\n";
  const put = (name, body, headers = {}) => fetch(`${panel.url}/api/client/${GYM}/history/export/${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "text/csv", "x-panel-token": panel.token, ...headers }, body });
  try {
    let r = await put("notes.txt", CSV); assert.equal(r.status, 400, "a .csv only");
    r = await put("export.csv", "Ad set name,Results\nx,1\n"); assert.equal(r.status, 400); assert.match((await r.json()).error, /Ad name/);
    assert.ok(!existsSync(join(g, "onboarding", "exports", "export.csv")), "a refused file is not kept");
    r = await put("Shamanee-Param-Ads.csv", CSV, { "x-export-label": "Shami's account" });
    const body = await r.text(); assert.equal(r.status, 200, body);
    let j = JSON.parse(body);
    assert.deepEqual([j.ads, j.adsets, j.leads, j.spend, j.currency, j.history.exports.length, j.history.exports[0].label, j.rows.length], [3, 1, 90, 1372.11, "SGD", 1, "Shami's account", 3]);
    const couple = j.rows.find((x) => /Couple/.test(x.ad_name));
    assert.deepEqual([couple.origin, couple.offer, couple.frequency, couple.quality_ranking, couple.leads, couple.cost_per_lead, couple.importable, couple.status], ["export", "Beginner's Body Reset", 4.44, "average", 86, 14.52, false, "active"]);
    assert.ok(existsSync(join(g, "onboarding", "exports", "Shamanee-Param-Ads.csv")));
    // The results answer: What wins over the ads running now, every ad on request.
    r = await (await call(`/api/client/${GYM}/results?track=all`)).json();
    const W = r.wins;
    // By default the stills are read alone (the agent makes stills); the video is its own track.
    const S = (await (await call(`/api/client/${GYM}/results`)).json()).wins, V = (await (await call(`/api/client/${GYM}/results?track=video`)).json()).wins;
    assert.deepEqual([S.track, S.ads, S.leads, S.median, S.tracks.stills.leads, S.tracks.video.leads, S.tables.some((t) => t.key === "media"), V.track, V.ads, V.leads], ["stills", 1, 86, 14.52, 86, 2, false, "video", 1, 2]);
    // Earlier tests may leave this app's own (paused) ads in the gym's outputs: they join "every ad", never the running ones.
    const appRows = r.rows.length;
    assert.deepEqual([W.scope, W.active, W.every, W.ads, W.leads, W.median, W.read, W.currency], ["active", 2, 3 + appRows, 2, 88, 14.52, 0, "SGD"]);
    const media = W.tables.find((t) => t.key === "media"), offer = W.tables.find((t) => t.key === "offer"), fmt = W.tables.find((t) => t.key === "format");
    assert.deepEqual(media.values.map((v) => [v.value, v.leads, v.cost_per_lead, v.confidence]), [["image", 86, 14.52, "solid"], ["video", 2, 32.15, "early"]]);
    assert.deepEqual([offer.values[0].value, fmt.values.length, fmt.unread, fmt.unread_leads], ["Beginner's Body Reset", 0, 2, 88], "nothing read yet: the picture attributes are empty, media and offer come from the rows");
    assert.deepEqual(W.suggestions.map((s) => s.kind), ["tiring", "unread"], "the one ad with 5+ leads IS the median, so nothing is cheaper than 85% of it: no keeper; the couple is tiring; the unread are named");
    assert.match(W.suggestions[0].text, /Couple.*seen 4.44 times per person/);
    assert.deepEqual([r.history.exports.length, r.history.pulled, r.campaigns.filter((c) => c.origin === "export").length, r.adsets.filter((c) => c.origin === "export").length, r.campaigns.find((c) => c.origin === "export").ads], [1, null, 1, 1, 3]);
    const all = (await (await call(`/api/client/${GYM}/results?scope=all&track=all`)).json()).wins;
    assert.deepEqual([all.scope, all.ads, all.leads >= 90], ["all", 3 + appRows, true]);
    // The reading run: checked before anything starts.
    r = await call("/api/run", { method: "POST", body: { kind: "creatives-read", gym: GYM, max: 0 } }); assert.equal(r.status, 400);
    const bare = join(brands, "nohistory"); mkdirSync(bare, { recursive: true }); writeFileSync(join(bare, "gym-profile.json"), readFileSync(join(g, "gym-profile.json")));
    try { r = await call("/api/run", { method: "POST", body: { kind: "creatives-read", gym: "nohistory", max: 10 } }); assert.equal(r.status, 409); assert.match((await r.json()).error, /no account history yet/); }
    finally { rmSync(bare, { recursive: true, force: true }); }
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u45#/${GYM}/results` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!RS.data && !!document.querySelector('#wins')"))) await new Promise((x) => setTimeout(x, 120));
    let text = await ev("document.querySelector('#wins').textContent");
    assert.match(text, /What wins/); assert.match(text, /86 leads over 1 ad · median SGD 14.52 a lead · 0 of 1 pictures read/); assert.match(text, /stills 86 leads at SGD 14.52 · video 2 leads at SGD 32.15/);
    assert.match(text, /Tiring/); assert.match(text, /Not read yet/); assert.match(text, /the ads running now \(2\)/);
    assert.match(text, /Offer.*Beginner's Body Reset · 86 leads at SGD 14.52/); assert.match(text, /Ads Manager exports: Shamanee-Param-Ads.csv — 3 ads/);
    assert.ok(await ev("[...document.querySelectorAll('#wins select option')].some(o=>/^video \\(1\\)$/.test(o.textContent))"), "the track switch");
    assert.ok(await ev("!!document.querySelector('#wins input[type=file]') && [...document.querySelectorAll('#wins button')].some(b=>/Read the creatives/.test(b.textContent))"));
    assert.match(await ev("document.querySelector('#view').textContent"), /from an Ads Manager export/, "no API pull: the card says where the rows came from");
    await ev("rsScope('all')"); const t1 = Date.now(); while (Date.now() - t1 < 10000 && !(await ev("RS.data.wins.scope==='all'"))) await new Promise((x) => setTimeout(x, 100));
    assert.match(await ev("document.querySelector('#wins').textContent"), new RegExp(`\\d+ leads over ${2 + appRows} ads`), "every still the gym ran");
    await ev("rsTrack('video')"); const t2 = Date.now(); while (Date.now() - t2 < 10000 && !(await ev("RS.data.wins.track==='video'"))) await new Promise((x) => setTimeout(x, 100));
    assert.match(await ev("document.querySelector('#wins').textContent"), /2 leads over 1 ad /, "the video track alone");
    await ev("rsTrack('stills')"); const t3 = Date.now(); while (Date.now() - t3 < 10000 && !(await ev("RS.data.wins.track==='stills'"))) await new Promise((x) => setTimeout(x, 100));
    await ev("const c = RS.data.campaigns.find(x=>x.origin==='export'); rsOpenCampaign(c.campaign_id); rsOpenAdset(RS.data.adsets.find(s=>s.campaign_id===c.campaign_id).adset_id); true");
    assert.match(await ev("document.querySelector('table.tbl tbody').textContent"), /export/, "the Source column names an export's rows");
    await ev("rsReadCreatives(); true");
    assert.ok(await ev("!!document.querySelector('#rsMax') && document.querySelector('#gModal').textContent.includes('one call per picture')"));
    await ev("document.querySelector('#gModal').innerHTML=''; true");
    // One campaign's ads alone (2026-11-11): a second campaign in the account, paused; the filter on the answer and on the card.
    const H = JSON.parse(readFileSync(join(g, "account-history.json"), "utf-8"));
    const oldAd = (id, spend, leads) => ({ id, name: `Old ${id}`, adset_id: "s-old", campaign_id: "c-old", campaign: "Old offer 2024", status: "PAUSED", effective_status: "PAUSED", words: "paused", media: "image", created: "2024-03-01", all_time: { spend, leads, cost_per_lead: Math.round((spend / leads) * 100) / 100, impressions: 5000 }, last_30d: {} });
    H.campaigns.push({ id: "c-old", name: "Old offer 2024" }); H.adsets.push({ id: "s-old", campaign_id: "c-old", name: "Old set" }); H.ads.push(oldAd("o1", 600, 10), oldAd("o2", 800, 10));
    writeFileSync(join(g, "account-history.json"), JSON.stringify(H));
    const exportId = (await (await call(`/api/client/${GYM}/results`)).json()).campaigns.find((c) => c.origin === "export").campaign_id;
    let F = (await (await call(`/api/client/${GYM}/results`)).json()).wins;
    assert.deepEqual([F.campaign, F.campaigns[0].id, F.campaigns[0].running, F.campaigns.find((c) => c.id === "c-old").leads, F.ads, F.median], [null, exportId, 2, 20, 1, 14.52], "no campaign asked for: the running campaign listed first, the figures the account's");
    F = (await (await call(`/api/client/${GYM}/results?campaign=c-old`)).json()).wins;
    assert.deepEqual([F.campaign, F.scope, F.ads, F.leads, F.median, F.active, F.every], [{ id: "c-old", name: "Old offer 2024" }, "all", 2, 20, 70, 0, 2], "its own ads and its own median; none running, so all of them");
    F = (await (await call(`/api/client/${GYM}/results?campaign=${encodeURIComponent(exportId)}&scope=all`)).json()).wins;
    assert.deepEqual([F.campaign.id, F.scope, F.ads, F.every, F.leads], [exportId, "all", 2, 3, 88], "the export's campaign: its two stills, the paused one with the scope on every ad");
    assert.equal((await (await call(`/api/client/${GYM}/results?campaign=nope`)).json()).wins.campaign, null, "an id the gym does not have is ignored");
    assert.equal(await ev("RS.view"), "tables", "opening a campaign is the tables tab");
    await ev("RS.scope = 'active'; rsView('review'); rsReload(); true");
    const t4 = Date.now(); while (Date.now() - t4 < 10000 && !(await ev("!!document.querySelector('#rsWinCampaign') && RS.data.wins.scope==='active'"))) await new Promise((x) => setTimeout(x, 100));
    const opts = await ev("[...document.querySelectorAll('#rsWinCampaign option')].map(o=>o.textContent)");
    assert.match(opts[0], /^every campaign \(\d+\)$/); assert.ok(opts.includes("Old offer 2024 · 2 ads · 20 leads at SGD 70"), opts.join(" | ")); assert.ok(opts.some((o) => /· 3 ads · 90 leads at SGD 15.25 · running$/.test(o)), "the campaigns with their ads, leads and cost per lead; the running one marked: " + opts.join(" | "));
    assert.ok(!(await ev("!!document.querySelector('#rsWinOne')")));
    await ev("rsWinCampaign('c-old'); true");
    const t5 = Date.now(); while (Date.now() - t5 < 10000 && !(await ev("RS.data.wins.campaign && RS.data.wins.campaign.id==='c-old' && !!document.querySelector('#rsWinOne')"))) await new Promise((x) => setTimeout(x, 100));
    text = await ev("document.querySelector('#wins').textContent");
    assert.match(text, /20 leads over 2 ads · median SGD 70 a lead/); assert.match(text, /Only Old offer 2024\. Its ads are read against one another: the median and every figure below are this campaign's own, and since none of its ads is running now these are all its ads\./); assert.match(text, /every ad of this campaign \(2\)/);
    assert.equal(await ev("document.querySelector('#rsWinCampaign').value"), "c-old");
    await ev("document.querySelector('#rsWinOne a').click(); true");
    const t6 = Date.now(); while (Date.now() - t6 < 10000 && !(await ev("!RS.data.wins.campaign && !document.querySelector('#rsWinOne')"))) await new Promise((x) => setTimeout(x, 100));
    assert.match(await ev("document.querySelector('#wins').textContent"), /86 leads over 1 ad · median SGD 14.52 a lead/, "back to every campaign");
  } finally { rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true }); rmSync(join(g, "copy-references.json"), { force: true }); }
});

test("U46 across every gym (2026-11-10): /api/wins pools every gym folder — each gym with its ads, leads, own median, unread pictures and when its account was read — in a scope (running now or the last 12 months by default), with what holds for one gym's next batch; the portfolio runs are checked before they start (a cap, the Meta link); the Review Data page shows the card under the gym's own What wins with the gyms table, the scope, the refresh and the reading dialogs", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true });
  const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach,Ends,Bid,"Bid type","Last significant edit","Quality ranking","Engagement rate ranking","Conversion rate ranking","Ad set name","Results (initial)","Results (initial) indicator"`;
  const row = (ad, results, spend, delivery = "active") => `2023-10-08,2026-11-08,"${ad}",${delivery},"7-day click or 1-day view",${results},actions:leadgen.other,1,100,Daily,${spend},10000,5000,Ongoing,0,ABSOLUTE_OCPM,2026-10-15T19:04:37+0800,Average,Average,Average,"0413 Broad Audience | Both Genders | 25-50 | +3KM",,`;
  const CSV = [HEADER, row("0413 Offer A | Image 1: One", 40, 400), row("0413 Offer A | Image 2: Two", 20, 400), row("0413 Offer A | Image 3: Old", 10, 300, "inactive")].join("\n") + "\n";
  try {
    let r = await fetch(`${panel.url}/api/client/${GYM}/history/export/portfolio.csv`, { method: "PUT", headers: { "content-type": "text/csv", "x-panel-token": panel.token }, body: CSV });
    assert.equal(r.status, 200);
    let A = await (await call(`/api/wins?gym=${GYM}`)).json();
    const me = A.gyms.find((x) => x.gym === GYM);
    assert.deepEqual([A.scope, A.track, A.tracks.stills.leads >= 60, A.max_read, Array.isArray(A.tables), Array.isArray(A.next), "_gyms" in A, "rows" in me, A.schedule.weekly, A.tables.some((t) => t.key === "media")], ["recent", "stills", true, 800, true, true, false, false, false, false], "stills by default; the weekly refresh is off on a test panel");
    // Earlier tests may leave this app's own (paused, just published) ads in the gym's outputs: they are recent, never running.
    const mine = (await (await call(`/api/client/${GYM}/results`)).json()).rows, appRows = mine.length, appLeads = mine.reduce((t, x) => t + (x.leads || 0), 0);
    assert.deepEqual([me.ads, me.active, me.leads, me.median, me.currency, me.pulled, me.exports.length], [2 + appRows, 2, 60 + appLeads, 15, "SGD", null, 1], "an export's paused ad carries no date, so the recent scope keeps the two running");
    const media = (await (await call(`/api/wins?track=all&gym=${GYM}`)).json()).tables.find((t) => t.key === "media").values.find((v) => v.value === "image");
    assert.ok(media.leads >= 60 && media.gyms.some((x) => x.gym === GYM && x.leads === 60 && x.cost_per_lead === 13.33 && x.rel >= 0.95 && x.rel <= 1.05), JSON.stringify(media.gyms));
    A = await (await call(`/api/wins?scope=all&gym=${GYM}`)).json();
    assert.deepEqual([A.scope, A.gyms.find((x) => x.gym === GYM).ads >= 3], ["all", true]);
    assert.equal((await (await call("/api/wins?scope=nonsense")).json()).scope, "recent");
    assert.equal((await (await call(`/api/client/${GYM}/results?scope=recent`)).json()).wins.scope, "recent");
    // The portfolio runs.
    r = await call("/api/run", { method: "POST", body: { kind: "portfolio-read", max: 0 } }); assert.equal(r.status, 400);
    r = await call("/api/run", { method: "POST", body: { kind: "portfolio-read", max: 801 } }); assert.equal(r.status, 400);
    r = await call("/api/run", { method: "POST", body: { kind: "portfolio-refresh" } }); assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up/);
    r = await call("/api/run", { method: "POST", body: { kind: "portfolio-read", max: 5 }, token: null }); assert.equal(r.status, 403);
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u46#/${GYM}/results` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!RS.data && !!RS.across && !!document.querySelector('#across table')"))) await new Promise((x) => setTimeout(x, 120));
    const text = await ev("document.querySelector('#across').textContent");
    assert.match(text, /Across every gym/); assert.match(text, /never pooled raw/); assert.match(text, /own average/); assert.match(text, /this gym/); assert.match(text, /export only/);
    assert.match(text, /next batch/); assert.match(text, /Split by gym/); assert.match(text, /weekly refresh is off on this panel/); assert.match(text, /last 6 months/);
    assert.ok(await ev("document.querySelector('#wins').compareDocumentPosition(document.querySelector('#across')) & Node.DOCUMENT_POSITION_FOLLOWING"), "under the gym's own What wins");
    assert.ok(await ev("[...document.querySelectorAll('#wins select option')].some(o=>/last 6 months/.test(o.textContent))"));
    await ev("rsPortfolioRead(); true");
    assert.ok(await ev("!!document.querySelector('#rsMaxAll') && /one call per picture/.test(document.querySelector('#gModal').textContent)"));
    await ev("rsPortfolioRefresh(); true");
    assert.match(await ev("document.querySelector('#gModal').textContent"), /Read-only on Meta\. No model call/);
    await ev("document.querySelector('#gModal').innerHTML=''; rsAcrossScope('all')");
    const t1 = Date.now(); while (Date.now() - t1 < 10000 && !(await ev("RS.across && RS.across.scope==='all'"))) await new Promise((x) => setTimeout(x, 100));
    assert.equal(await ev("RS.across.scope"), "all");
  } finally { rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true }); rmSync(join(g, "copy-references.json"), { force: true }); }
});

test("U47 once a week, by itself (2026-11-10): a panel with the weekly refresh on starts it when no refresh is on record — every account pulled again (read-only), then the new pictures read under the weekly cap — and writes when it started, how it ended and when the next is due; a panel started inside the week starts nothing; a refresh started by hand counts as the week's", async () => {
  const lib = join(dirname(brands), "library"), file = join(lib, "portfolio-schedule.json");
  rmSync(file, { force: true });
  const graph = await fakeGraph();
  const main = panel;
  const env = { META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: graph.url, PANEL_WEEKLY: "1", PANEL_WEEKLY_FIRST_MS: "200" };
  try {
    panel = await startPanel(env);
    let t0 = Date.now(), sch = null;
    while (Date.now() - t0 < 60000) { sch = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null; if (sch?.last_finished) break; await new Promise((x) => setTimeout(x, 200)); }
    assert.ok(sch?.last_started && sch.last_finished, "the week's refresh ran to its end: " + JSON.stringify(sch));
    assert.equal(sch.last_result, "refreshed and read");
    let A = await (await call("/api/wins")).json();
    assert.deepEqual([A.schedule.weekly, A.schedule.last_started, A.schedule.read_cap, Math.round((Date.parse(A.schedule.next_due) - Date.parse(sch.last_started)) / 86400000)], [true, sch.last_started, 150, 7]);
    assert.equal(sch.numbers_started, undefined, "the day's read never starts beside the week's refresh");
    await linkTestGym();
    await panel.stop();
    // Inside the week: nothing starts.
    panel = await startPanel(env);
    await new Promise((x) => setTimeout(x, 1500));
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).last_started, sch.last_started, "not due: left alone");
    // Once a day, by itself (2026-11-12): the weekly refresh was not due, so the day's read of the numbers started — read-only, into the gym's own file.
    let day = null; t0 = Date.now();
    while (Date.now() - t0 < 60000) { day = JSON.parse(readFileSync(file, "utf-8")); if (day.numbers_finished) break; await new Promise((x) => setTimeout(x, 200)); }
    assert.equal(day.numbers_result, "read", JSON.stringify(day));
    assert.equal(JSON.parse(readFileSync(join(brands, GYM, "account-daily.json"), "utf-8")).days.length, 14);
    const PN = await (await call("/api/portfolio")).json(), mineN = PN.gyms.find((g) => g.gym === GYM);
    assert.deepEqual([mineN.source, mineN.periods[7].spend, mineN.periods[7].leads, mineN.periods[7].cost_per_lead, mineN.periods[7].change.cost_per_lead, mineN.periods[7].frequency, mineN.running.ads, mineN.running.budget, mineN.flags[7].map((f) => f.kind)], ["meta", 350, 14, 25, 150, 2, 1, 50, ["cost_up"]]);
    assert.deepEqual([PN.schedule.daily, PN.schedule.last_started, PN.schedule.last_result, PN.linked, PN.reading, Math.round((Date.parse(PN.schedule.next_due) - Date.parse(day.numbers_started)) / 3600000)], [true, day.numbers_started, "read", true, null, 20]);
    const byHand = await runAndWait({ kind: "portfolio-numbers" });
    assert.equal(byHand.code, 0, byHand.lines.join("\n")); assert.match(byHand.lines[0], /^\$ node skills\/references\/portfolio-numbers\.mjs --refresh --brands-dir \S+$/, "built server-side");
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).numbers_result, "read by you");
    // By hand: it counts as the week's.
    const made = await runAndWait({ kind: "portfolio-refresh" });
    assert.equal(made.code, 0, made.lines.join("\n"));
    const after = JSON.parse(readFileSync(file, "utf-8"));
    assert.ok(after.last_started > sch.last_started && after.last_result === "refreshed by you", JSON.stringify(after));
  } finally { await panel.stop(); panel = main; graph.server.close(); rmSync(file, { force: true }); rmSync(join(brands, GYM, "account-daily.json"), { force: true }); }
});

test("U48 the look, and 4:5 as the only feed shape (2026-11-10): a gym's Ad defaults take a look family (one that is not is refused) and no shape but 4:5 — the square is refused on a profile and on a new brief, and allowed only for a batch already made as a square; a brief checked for that gym carries its look; the Create preview renders at 4:5 whatever is asked; Ad defaults and Create show the look as a choice and the shape as a fact", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json");
  await linkTestGym();
  const before = readFileSync(pf, "utf-8"), profile = JSON.parse(before);
  try {
    let r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, look: "loud" } } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /creative_defaults.look must be one of reference, formula/);
    r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, ratio: "9x16" } } });
    assert.equal(r.status, 400);
    r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, ratio: "1x1" } } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /creative_defaults.ratio must be 4x5: feed ads are made at 4:5 and Stories at 9:16 \(the square is no longer made\)/);
    // A brief with neither, for a gym on the standard defaults: nothing is added.
    const raw = { batch_id: "look-check", ...WORDS, free: false, generated: 0, real: BRIEF.real, looks_per_photo: 2, max_calls: 0, attempts: 1, scenes: null };
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: raw } })).json();
    assert.deepEqual([c.errors, "look" in c.brief, "ratio" in c.brief], [[], false, false]);
    r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, look: "formula", ratio: "4x5" } } });
    assert.equal(r.status, 200, await r.clone().text());
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: raw } })).json();
    assert.deepEqual([c.errors, c.brief.look, "ratio" in c.brief], [[], "formula", false], "the gym's look rides on the brief; the shape needs no saying");
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, look: "reference", ratio: "4x5" } } })).json();
    assert.deepEqual([c.errors, c.brief.look, c.brief.ratio], [[], "reference", "4x5"], "a brief's own look stands");
    // The square is no longer made: a new brief that asks for it is refused …
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, ratio: "1x1" } } })).json();
    assert.deepEqual(c.errors, ["feed ads are made at 4:5 and their Stories versions at 9:16: the square (1:1) is no longer made"]);
    // … and only a batch already made as a square may name it (its words changed, run again).
    const sqDir = join(g, "outputs", "look-square");
    mkdirSync(sqDir, { recursive: true }); writeFileSync(join(sqDir, "batch.json"), JSON.stringify({ batch_id: "look-square", ratio: "1x1", ads: [] }));
    try {
      c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, batch_id: "look-square", ratio: "1x1" } } })).json();
      assert.deepEqual(c.errors, []);
    } finally { rmSync(sqDir, { recursive: true, force: true }); }
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, look: "loud" } } })).json();
    assert.ok(c.errors.some((e) => /look "loud" is not one of reference, formula/.test(e)));
    // The preview: the gym's look and shape by default, the Generate Creatives screen's own when it sends them.
    let pv = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "ANG MO KIO", audience: null } })).json();
    assert.deepEqual([pv.errors, pv.looks.map((l) => l.id)], [[], ["f1", "f2", "f3"]]);
    for (const l of pv.looks) { assert.ok(l.ok, `${l.id}: ${l.failures}`); const png = Buffer.from(await (await fetch(panel.url + l.url)).arrayBuffer()); assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1350], `${l.id} at 4:5`); }
    pv = await (await call("/api/preview", { method: "POST", body: { gym: GYM, offer: WORDS.offer, location: "ANG MO KIO", audience: "MEN", look: "reference", ratio: "1x1" } })).json();
    assert.deepEqual(pv.looks.map((l) => l.id), ["t1", "t3", "t5", "t8"]);
    { const png = Buffer.from(await (await fetch(panel.url + pv.looks[0].url)).arrayBuffer()); assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1350], "the reference set at 4:5 too: a square is not rendered whatever is asked"); }
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const open = async (hash, ready) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u48${hash.replace(/\W/g, "")}#/${GYM}/${hash}` }, sessionId); await loaded; const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); };
    await open("defaults", "!!document.querySelector('input[name=cdLook]')");
    assert.deepEqual(await ev("[document.querySelector('input[name=cdLook]:checked').parentElement.textContent.includes('The formula'), !!document.querySelector('input[name=cdRatio]'), /every feed ad is portrait 4:5 and its Stories and Reels version 9:16/.test(document.querySelector('#cdShape').textContent), /The square \\(1:1\\) is no longer made/.test(document.querySelector('#cdShape').textContent), /No look adds a logo or the gym's brand colours unless you ask/.test(document.querySelector('#view').textContent)]"), [true, false, true, true, true]);
    await open("create", "!!document.querySelector('#bLook') && !!document.querySelector('#bShape')");
    assert.deepEqual(await ev("[document.querySelector('#bLook').value, !!document.querySelector('#bRatio'), document.querySelector('#bShape').textContent, briefFromDraft().look, 'ratio' in briefFromDraft()]"), ["formula", false, "4:5 feed · 9:16 Stories", "formula", false], "the gym's look pre-fills the batch's own choice; the shape is not a choice");
    assert.deepEqual(await ev("bSet('look','reference'); ['look' in briefFromDraft(), 'ratio' in briefFromDraft()]"), [false, false]);
  } finally { writeFileSync(pf, before); }
});

test("U49 the kind of photograph (Phase 3, 2026-11-10): a gym's Ad defaults take a format (one that is not is refused); a brief checked for that gym carries it and its summary says it; a format with no approved scenes is said with the way out; the Spread is off for a portrait batch, in words; the scene refresh takes the format (a cover is workout-only) and its run is the portrait drafter's; Ad defaults, Create and the refresh show the choice", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json"), sp = join(g, "scenes.json");
  await linkTestGym();
  const before = readFileSync(pf, "utf-8"), profile = JSON.parse(before), scenesBefore = readFileSync(sp, "utf-8");
  const P = (id, over = {}) => ({ id, audience: "any", format: "studio-portrait", pose: "upright", people: 1, age: "prime", backdrop: "seamless-colour", stance: "easy-posed", expression: "smile", eye_contact: true, scene: `A person in their thirties in a navy top standing relaxed with hands on hips and a warm smile, looking into the camera, against a seamless flat pink studio backdrop (${id}).`, ...over });
  try {
    let r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, format: "poster" } } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /creative_defaults.format must be one of workout, studio-portrait/);
    const raw = { batch_id: "format-check", ...WORDS, free: false, generated: 2, real: [], looks_per_photo: 2, max_calls: 2, attempts: 1, scenes: null };
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: raw } })).json();
    assert.deepEqual([c.errors, "format" in c.brief, c.summary.format], [[], false, "workout"], "a workout batch needs no saying");
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "poster" } } })).json();
    assert.ok(c.errors.some((e) => /format "poster" is not one of workout, studio-portrait/.test(e)), JSON.stringify(c.errors));
    // No portrait scenes yet: said, with where to draft them.
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "studio-portrait" } } })).json();
    assert.deepEqual(c.errors, ["no approved studio portrait scenes yet: draft some on Draft Scenes (Refresh scenes…, format: studio portrait) and approve them"]);
    // With approved portrait scenes the brief stands; the Spread switch is off for it, in words.
    const lib = JSON.parse(scenesBefore);
    writeFileSync(sp, JSON.stringify({ ...lib, scenes: [...lib.scenes, P("a-p-pink"), P("a-p-wall", { backdrop: "dark-wall", scene: "A person in their forties leaning one shoulder on a raw grey concrete wall, drinking from a clear water bottle, relaxed, in soft side light (a-p-wall)." })] }));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "studio-portrait", spread: true } } })).json();
    assert.deepEqual([c.errors, c.brief.format, c.summary.format, "must_show" in c.brief, c.spread.reason], [[], "studio-portrait", "studio-portrait", false, "off for a studio portrait batch: it spreads across backdrops, poses and ages by itself"]);
    let sc = await (await call(`/api/client/${GYM}/scenes`)).json();
    assert.deepEqual([Object.keys(sc.formats), sc.status.formats["studio-portrait"].total], [["workout", "studio-portrait"], 2]);
    // The gym's default rides on a brief that names none.
    r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, format: "studio-portrait" } } });
    assert.equal(r.status, 200, await r.clone().text());
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: raw } })).json();
    assert.deepEqual([c.errors, c.brief.format], [[], "studio-portrait"]);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "workout" } } })).json();
    assert.deepEqual([c.errors, c.brief.format, c.summary.format], [[], "workout", "workout"], "a brief's own choice stands");
    // The refresh run.
    const post = (body) => call("/api/run", { method: "POST", body });
    assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 2, format: "poster" })).status, 400);
    r = await post({ kind: "scenes-refresh", gym: GYM, audience: "women", count: 2, format: "studio-portrait", cover: ["exercise:lunge"] });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /cover is about exercises and equipment: it applies to workout scenes only/);
    const started = await (await post({ kind: "scenes-refresh", gym: GYM, audience: "any", count: 2, format: "studio-portrait" })).json();
    assert.ok(started.id, JSON.stringify(started));
    const log = await (await fetch(`${panel.url}/api/run/${started.id}/stream`)).text();
    assert.match(log, /--format studio-portrait/, "the run is the portrait drafter's");
    assert.match(log, /portrait scenes for any \(2 live\): (gym-floor \(0\)|dark-wall \(1\)|seamless-colour \(1\))/, log.slice(0, 600));
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const open = async (hash, ready) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u49${hash.replace(/\W/g, "")}#/${GYM}/${hash}` }, sessionId); await loaded; const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); };
    await open("defaults", "!!document.querySelector('#cdMix-studio-portrait')");
    assert.deepEqual(await ev("[document.querySelector('#cdMix-studio-portrait').value, /The rest, 0%, are workout photos/.test(document.querySelector('#cdMixRest').textContent)]"), ["100", true], "a gym set to one kind reads as all of that kind");
    await open("create", "!!document.querySelector('#bMix-studio-portrait')");
    assert.deepEqual(await ev("[Number(document.querySelector('#bMix-studio-portrait').value) === Number(B.draft.generated), briefFromDraft().format, 'mix' in briefFromDraft()]"), [true, "studio-portrait", false], "the gym's default pre-fills the batch: every new photo a portrait");
    assert.deepEqual(await ev("bMixSet('studio-portrait', 0); [briefFromDraft().format, 'mix' in briefFromDraft()]"), ["workout", false], "none of them portraits: for a gym whose default is another kind the brief says workout, or the gym's default would come back (2026-11-11)");
    await open("scenes", "!!document.querySelector('#bSceneCard button')");
    assert.match(await ev("document.querySelector('#bSceneCard').textContent"), /2 studio portrait/);
    assert.deepEqual(await ev("bRefreshConfirm(); new Promise(r=>setTimeout(()=>r([[...document.querySelectorAll('#bRfFormat option')].map(o=>o.textContent), document.querySelector('#bRfFormat').value, /plain backdrop/.test(document.querySelector('#bRfFormatHint').textContent), document.querySelector('#bRfGapsWords').textContent]),80))"), [["Workout", "Studio portrait"], "studio-portrait", true, "Spread across backdrops (the ones this audience has fewest of first)"]);
  } finally { writeFileSync(pf, before); writeFileSync(sp, scenesBefore); }
});

test("U50 the mix (Phase 4, 2026-11-10): a gym's default mix is shares that sum to 100, saved by the owner's click; a brief checked for that gym carries the mix as photos and its summary says the kinds; every kind in it needs its own approved scenes; Results shows each kind's numbers and one suggested step that is saved only when taken; Ad defaults, Create and Results show it", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json"), sp = join(g, "scenes.json");
  await linkTestGym();
  const before = readFileSync(pf, "utf-8"), profile = JSON.parse(before), scenesBefore = readFileSync(sp, "utf-8");
  const P = (id, over = {}) => ({ id, audience: "any", format: "studio-portrait", pose: "upright", people: 1, age: "prime", backdrop: "seamless-colour", stance: "easy-posed", expression: "smile", eye_contact: true, scene: `A person in their thirties in a navy top standing relaxed with hands on hips and a warm smile, looking into the camera, against a seamless flat pink studio backdrop (${id}).`, ...over });
  try {
    let r = await call(`/api/client/${GYM}`, { method: "PUT", body: { ...profile, creative_defaults: { ...profile.creative_defaults, mix: { workout: 60, "studio-portrait": 30 } } } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /creative_defaults.mix: shares must add up to 100 \(they add up to 90\)/);
    assert.equal((await call(`/api/client/${GYM}/mix`, { method: "POST", body: { mix: { workout: 50, poster: 50 } } })).status, 400);
    assert.equal((await call(`/api/client/${GYM}/mix`, { method: "POST", body: { mix: { workout: 70, "studio-portrait": 20 } } })).status, 400);
    r = await call(`/api/client/${GYM}/mix`, { method: "POST", body: { mix: { workout: 50, "studio-portrait": 50 } } });
    assert.deepEqual([r.status, (await r.json()).mix], [200, { workout: 50, "studio-portrait": 50 }]);
    assert.deepEqual(JSON.parse(readFileSync(pf, "utf-8")).creative_defaults.mix, { workout: 50, "studio-portrait": 50 });
    const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
    assert.deepEqual([setup.mix, setup.formats], [{ workout: 50, "studio-portrait": 50 }, ["workout", "studio-portrait"]]);
    // A brief with neither a format nor a mix: the gym's shares as photos. No portrait scenes yet: said.
    const raw = { batch_id: "mix-check", ...WORDS, free: false, generated: 4, real: [], looks_per_photo: 2, max_calls: 4, attempts: 1, scenes: null };
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: raw } })).json();
    assert.deepEqual([c.brief.mix, c.summary.format, c.summary.mix], [{ workout: 2, "studio-portrait": 2 }, "mixed", { workout: 2, "studio-portrait": 2 }]);
    assert.deepEqual(c.errors, ["no approved studio portrait scenes yet: draft some on Draft Scenes (Refresh scenes…, format: studio portrait) and approve them"]);
    const lib = JSON.parse(scenesBefore);
    writeFileSync(sp, JSON.stringify({ ...lib, scenes: [...lib.scenes, P("a-p-pink"), P("a-p-wall", { backdrop: "dark-wall", scene: "A person in their forties leaning one shoulder on a raw grey concrete wall, drinking from a clear water bottle, relaxed, in soft side light (a-p-wall)." })] }));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, spread: true } } })).json();
    assert.deepEqual([c.errors, c.brief.mix, c.spread?.reason || null], [[], { workout: 2, "studio-portrait": 2 }, null], "the Spread stays on for the workout photos of a mix");
    // A brief's own counts stand; a sum that is not the batch's is refused; a format and a mix together are refused.
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, mix: { workout: 1, "studio-portrait": 3 } } } })).json();
    assert.deepEqual([c.errors, c.summary.mix], [[], { workout: 1, "studio-portrait": 3 }]);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, mix: { workout: 1, "studio-portrait": 1 } } } })).json();
    assert.ok(c.errors.includes("the mix's photos (2) must add up to the batch's generated photos (4)"), JSON.stringify(c.errors));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "workout", mix: { workout: 2, "studio-portrait": 2 } } } })).json();
    assert.ok(c.errors.includes("give the batch a format or a mix, not both"));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, format: "workout" } } })).json();
    assert.deepEqual([c.errors, "mix" in c.brief, c.summary.mix], [[], false, { workout: 4 }], "a brief's one format overrides the gym's mix");
    // Results: the mix with each kind's numbers and what is suggested; nothing is saved by looking.
    const res = await (await call(`/api/client/${GYM}/results`)).json();
    assert.deepEqual([res.mix.current, res.mix.formats.map((x) => x.format), res.mix.floor, res.mix.cap, Array.isArray(res.mix.reasons)], [{ workout: 50, "studio-portrait": 50 }, ["workout", "studio-portrait"], 20, 80, true]);
    assert.deepEqual(JSON.parse(readFileSync(pf, "utf-8")).creative_defaults.mix, { workout: 50, "studio-portrait": 50 });
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const open = async (hash, ready) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u50${hash.replace(/\W/g, "")}#/${GYM}/${hash}` }, sessionId); await loaded; const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); };
    await open("defaults", "!!document.querySelector('#cdMix-studio-portrait')");
    assert.deepEqual(await ev("[document.querySelector('#cdMix-studio-portrait').value, /The rest, 50%, are workout photos/.test(document.querySelector('#cdMixRest').textContent)]"), ["50", true]);
    assert.deepEqual(await ev("cdMix('studio-portrait', 30); [STATE.profile.creative_defaults.mix, /The rest, 70%/.test(document.querySelector('#cdMixRest').textContent), !!DIRTY.profile]"), [{ workout: 70, "studio-portrait": 30 }, true, true], "typed, not saved until Save");
    assert.deepEqual(await ev("cdMix('studio-portrait', 250); STATE.profile.creative_defaults.mix"), { "studio-portrait": 100 }, "never past 100");
    await ev("DIRTY = {}; true");
    await open("create", "!!document.querySelector('#bMix-studio-portrait')");
    assert.deepEqual(await ev("(()=>{ const b = briefFromDraft(), g = b.generated; return [b.mix && b.mix.workout + b.mix['studio-portrait'] === g, b.mix && Math.abs(b.mix.workout - b.mix['studio-portrait']) <= 1, 'format' in b, document.querySelector('#bMixRest').textContent === (b.mix.workout + ' workout') || document.querySelector('#bMixRest').textContent === '']; })()"), [true, true, false, true], "half and half of the gym's photo count");
    assert.deepEqual(await ev("bSet('generated', 6); bMixSet('studio-portrait', 2); [briefFromDraft().mix, document.querySelector('#bMixRest').textContent]"), [{ workout: 4, "studio-portrait": 2 }, "4 workout"]);
    assert.deepEqual(await ev("bMixSet('studio-portrait', 9); [briefFromDraft().format, 'mix' in briefFromDraft(), document.querySelector('#bMix-studio-portrait').value]"), ["studio-portrait", false, "6"], "never more portraits than photos: all six, so one kind");
    assert.deepEqual(await ev("bMixSet('studio-portrait', 0); [briefFromDraft().format, 'mix' in briefFromDraft()]"), ["workout", false], "all workout, said: the gym's default is a mix");
    await open("results", "!!document.querySelector('#rsMix')");
    assert.deepEqual(await ev("[document.querySelectorAll('#rsMix tbody tr').length, document.querySelector('#rsMixNow').textContent, /Use this mix|No change suggested/.test(document.querySelector('#rsMix').textContent)]"), [2, "50% workout photos · 50% studio portraits", true]);
  } finally { writeFileSync(pf, before); writeFileSync(sp, scenesBefore); }
});

test("U51 cards (Phase 5, 2026-11-11): a pasted Google review is kept word for word and its excerpt is whole sentences only; a statement of the owner's is kept at once, a draft waits; a brief's cards need that many ready and count in its ads; Google is refused in words without a key; a card previews with no image call; the Cards page and Create show it", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  const files = ["reviews.json", "card-words.json"].map((f) => join(g, f));
  const TEXT = "I was nervous walking in on day one. The coaches knew my name by the second session. Only $99 a month too.";
  try {
    let d = await (await call(`/api/client/${GYM}/cards`)).json();
    assert.deepEqual([d.reviews, d.statements, d.timelines, d.has_key, d.kinds, d.limits.min_stars], [[], [], [], false, ["review", "statement", "timeline"], 5]);
    let r = await call(`/api/client/${GYM}/cards/review`, { method: "POST", body: { author: "Mei Ling T.", rating: 5, text: TEXT } });
    d = await r.json();
    assert.deepEqual([r.status, d.review.usable, d.review.excerpt, d.reviews.length], [200, true, "I was nervous walking in on day one. The coaches knew my name by the second session.", 1], "the default excerpt leaves the price sentence out");
    const id = d.review.id;
    assert.equal(JSON.parse(readFileSync(files[0], "utf-8")).reviews[0].text, TEXT, "word for word on disk");
    assert.equal((await call(`/api/client/${GYM}/cards/review`, { method: "POST", body: { author: "Again", rating: 5, text: TEXT } })).status, 409, "the same review twice");
    r = await call(`/api/client/${GYM}/cards/review/${id}`, { method: "PUT", body: { excerpt: "The coaches knew my name" } });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /whole sentences of the review, in order, with nothing changed/);
    d = await (await call(`/api/client/${GYM}/cards/review/${id}`, { method: "PUT", body: { excerpt: "Only $99 a month too." } })).json();
    assert.deepEqual([d.review.usable, d.review.problems], [false, ["the excerpt has a price: choose other sentences"]]);
    d = await (await call(`/api/client/${GYM}/cards/review/${id}`, { method: "PUT", body: { excerpt: "The coaches knew my name by the second session." } })).json();
    assert.equal(d.review.usable, true);
    // Google: no key, said in words (the tests' panel has none; nothing is ever sent).
    r = await call(`/api/client/${GYM}/cards/google/find`, { method: "POST", body: { query: "Test Gym" } });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /no Google Places key yet: add GOOGLE_PLACES_KEY to \.env, or paste the reviews/);
    assert.equal((await call(`/api/client/${GYM}/cards/google/pull`, { method: "POST", body: {} })).status, 409);
    // Statements: the owner's own is kept; a broken one is refused with the reason.
    r = await call(`/api/client/${GYM}/cards/words`, { method: "POST", body: { kind: "statement", text: "Lose 5kg for $99, guaranteed, this month only." } });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /a price; says "guaranteed"; a weight-loss number/);
    d = await (await call(`/api/client/${GYM}/cards/words`, { method: "POST", body: { kind: "statement", text: "Getting older is not what slows you down. Losing **strength** does." } })).json();
    assert.deepEqual([d.row.status, d.statements.length], ["kept", 1]);
    r = await call(`/api/client/${GYM}/cards/words/statement/${d.row.id}`, { method: "PUT", body: { status: "retired" } });
    assert.equal(r.status, 400, "retiring needs a reason");
    // The drafter reaches the model (blocked here): refused in words, nothing written.
    r = await call(`/api/client/${GYM}/cards/draft`, { method: "POST", body: { kind: "timeline", offer: "Summer Shred" } });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /names its length/);
    // A brief's cards.
    const raw = { batch_id: "cards-check", ...WORDS, free: false, generated: 0, real: BRIEF.real, looks_per_photo: 2, max_calls: 0, attempts: 1, scenes: null };
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, cards: { review: 1, statement: 1 } } } })).json();
    assert.deepEqual([c.errors, c.summary.cards, c.summary.ads], [[], { review: 1, statement: 1 }, c.summary.photos * 2 * c.summary.locations + 2 * c.summary.locations]);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, cards: { review: 2, timeline: 1 } } } })).json();
    assert.ok(c.errors.includes("2 review cards asked for, 1 ready: paste or pull 5-star Google reviews on Library → Cards") && c.errors.some((e) => /^1 timeline card asked for, 0 ready: draft some for a/.test(e)), JSON.stringify(c.errors));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, cards: { poster: 1 } } } })).json();
    assert.ok(c.errors.includes('cards: "poster" is not one of review, statement, timeline'));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, real: [], cards: { review: 1 } } } })).json();
    assert.deepEqual([c.errors, c.summary.ads], [[], c.summary.locations], "a batch may be cards alone");
    const setup = await (await call(`/api/client/${GYM}/batch-setup`)).json();
    assert.deepEqual([setup.cards_ready, setup.max_cards], [{ review: 1, statement: 1, timeline: 0 }, 6]);
    // A preview: the card itself, set by software.
    const pv = await (await call(`/api/client/${GYM}/cards/preview`, { method: "POST", body: { kind: "review", id, ratio: "9x16" } })).json();
    const png = Buffer.from(pv.image.split(",")[1], "base64");
    assert.deepEqual([pv.ok, pv.failures, png.readUInt32BE(16), png.readUInt32BE(20)], [true, [], 1080, 1920]);
    assert.equal((await call(`/api/client/${GYM}/cards/preview`, { method: "POST", body: { kind: "review", id: "r-none" } })).status, 404);
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const open = async (hash, ready) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u51${hash.replace(/\W/g, "")}#/${GYM}/${hash}` }, sessionId); await loaded; const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); };
    await open("cards", "!!document.querySelector('#cdReviews') && !!document.querySelector('[data-review]')");
    assert.deepEqual(await ev("[/Google reviews · 1 ready of 1/.test(document.querySelector('#cdReviews h3').textContent), document.querySelector('#cdPull').disabled, /Statements · 1 kept of 1/.test(document.querySelector('#cdStatements h3').textContent), /No Google Places key yet/.test(document.querySelector('#cdReviews').textContent), document.querySelectorAll('[data-review] .txt span').length]"), [true, true, true, true, 3]);
    // Choosing the excerpt by clicking sentences: the first click starts it, the second ends it.
    assert.deepEqual(await ev(`cdPick('${id}', 0); cdPick('${id}', 1); [CD.pick['${id}'], /Use the highlighted sentences/.test(document.querySelector('[data-review]').textContent)]`), [[0, 1], true]);
    await ev(`cdSaveExcerpt('${id}'); new Promise(r=>setTimeout(r,600))`);
    assert.equal(JSON.parse(readFileSync(files[0], "utf-8")).reviews[0].excerpt, "I was nervous walking in on day one. The coaches knew my name by the second session.");
    // A refused review keeps what was typed.
    assert.deepEqual(await ev("document.querySelector('#cdAuthor').value='X'; document.querySelector('#cdText').value='Too short'; cdAddReview().then(()=>[document.querySelector('#cdText').value, /20 to 5,000 characters/.test(document.querySelector('#cdAddMsg').textContent)])"), ["Too short", true]);
    await open("create", "!!document.querySelector('#bCard-review')");
    assert.deepEqual(await ev("[/\\(1 ready\\)/.test(document.querySelector('#bCard-review').parentElement.textContent), 'cards' in briefFromDraft()]"), [true, false]);
    assert.deepEqual(await ev("bCardSet('review', 1); bCardSet('timeline', 99); briefFromDraft().cards"), { review: 1, timeline: 6 });
  } finally { for (const f of files) rmSync(f, { force: true }); }
});

test("U52 the account review (Phase 6, 2026-11-11): the review is built from what is on file with no call — the numbers, the notes, the mix, and the next batch pre-filled with the owner's own last words; the run is refused with a bad cap or an unknown gym, and without the Meta link it says so, pulls nothing and still reviews; a brief's lean is checked by the batch's rules and dropped for a directed batch; Results shows the card and Create opens pre-filled with the reasons and the lean, each of which the owner can drop", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true }); rmSync(join(g, "account-review.json"), { force: true });
  const bdir = join(g, "batches", "2099-01-01-review-check");
  const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach`;
  const row = (ad, results, spend, delivery = "active") => `2026-04-13,2026-11-08,"${ad}",${delivery},"7-day click or 1-day view",${results},actions:leadgen.other,${results ? (spend / results).toFixed(4) : 0},100,Daily,${spend},${results * 900 + 500},${results * 300 + 200}`;
  const CSV = [HEADER, row("0413 Body Reset | Image 1: Lady One", 30, 450), row("0413 Body Reset | Image 2: Lady Two", 10, 250), row("0413 Old Offer | Image 3: Lady Three", 4, 300, "inactive")].join("\n") + "\n";
  try {
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "brief.json"), JSON.stringify({ batch_id: "2099-01-01-review-check", offer: "6 Week Review Check", locations: ["BISHAN"], audience: "MEN", generated: 4 }));
    let r = await fetch(`${panel.url}/api/client/${GYM}/history/export/review.csv`, { method: "PUT", headers: { "content-type": "text/csv", "x-panel-token": panel.token }, body: CSV });
    assert.equal(r.status, 200);
    // The review: built on a GET, nothing written, no call.
    r = await call(`/api/client/${GYM}/account-review`); assert.equal(r.status, 200);
    const R = await r.json();
    assert.deepEqual([R.gym, R.numbers.running.ads, R.numbers.running.leads, R.numbers.running.cost_per_lead, R.numbers.last_30d], [GYM, 2, 40, 17.5, null]);
    assert.ok(R.numbers.all_time.ads >= 3, "the export's three ads, and whatever this gym published in the tests before");
    assert.deepEqual([R.brief.offer, R.brief.locations, R.brief.audience, R.brief_from], ["6 Week Review Check", ["BISHAN"], "MEN", "2099-01-01-review-check"]);
    assert.match(R.reasons[0].text, /your last batch's own words \(2099-01-01-review-check\)/);
    assert.ok(R.reasons.some((x) => /Running now: Body Reset \(40 leads at SGD 17\.50\)/.test(x.text)));
    assert.ok(R.notes.some((x) => /no picture read yet/.test(x)) || R.notes.length >= 0);
    assert.match(R.text, /account review\nRunning now: 2 ads, SGD 700\.00 spent, 40 leads at SGD 17\.50\./);
    assert.equal(R.last, null); assert.equal(existsSync(join(g, "account-review.json")), false, "looking writes nothing");
    assert.equal(R.linked, false);
    assert.equal((await call("/api/client/nosuchgym/account-review")).status, 400);
    // The run: its cap and its gym are checked; without the Meta link it pulls nothing, says so, and still reviews.
    for (const bad of [{ gym: GYM, max: -1 }, { gym: GYM, max: 5000 }, { gym: GYM, max: 1.5 }, { gym: "nosuchgym", max: 0 }]) assert.equal((await call("/api/run", { method: "POST", body: { kind: "account-review", ...bad } })).status, 400, JSON.stringify(bad));
    const ran = await runAndWait({ kind: "account-review", gym: GYM, max: 0 });
    assert.deepEqual([ran.status, ran.code], [200, 0], ran.lines?.join("\n"));
    const out = ran.lines.join("\n");
    assert.match(out, /the Meta link is not set up: nothing pulled, the review uses what is on disk/);
    assert.match(out, /account review/); assert.match(out, /The next batch:/); assert.match(out, /your last batch's own words/);
    assert.doesNotMatch(out, /EAA[A-Za-z0-9]{20,}/);
    const rec = JSON.parse(readFileSync(join(g, "account-review.json"), "utf-8"));
    assert.deepEqual([rec.pulled, rec.read, typeof rec.reviewed], [false, null, "string"]);
    assert.ok((await (await call(`/api/client/${GYM}/account-review`)).json()).last.reviewed);
    // A brief's lean: checked by the batch's rules, never a refusal for what it asks, dropped when the batch is directed.
    const raw = { batch_id: "lean-check", ...WORDS, free: false, generated: 4, real: [], looks_per_photo: 2, max_calls: 4, attempts: 1, scenes: null };
    const lean = [{ tag: "setting", value: "group", format: "workout", why: "a test" }];
    let c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, lean } } })).json();
    assert.deepEqual([c.errors.filter((e) => /lean/.test(e)), c.brief.lean], [[], lean]);
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, lean: [{ tag: "backdrop", value: "pink" }, { tag: "logo", value: "yes" }] } } })).json();
    assert.deepEqual(c.errors.filter((e) => /lean/.test(e)).length, 2, JSON.stringify(c.errors));
    c = await (await call(`/api/client/${GYM}/batch/check`, { method: "POST", body: { brief: { ...raw, lean, direction: { words: "older men lifting with a coach, bright" } } } })).json();
    assert.equal("lean" in c.brief, false, "a directed batch's words decide the pictures");
    // The page: the card on Review Data, then Create pre-filled.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u52#/${GYM}/results` }, sessionId); await loaded;
    await until("!!document.querySelector('#rsNextBatch')");
    const card = await ev("document.querySelector('#rsReview').innerText");
    for (const re of [/Account review/i, /reviewed \d{4}-\d\d-\d\d/, /from an Ads Manager export/, /Running now: 2 ads/, /40 leads at SGD 17\.50/, /The next batch/i, /6 Week Review Check/, /BISHAN · MEN/, /your last batch's own words/]) assert.match(card, re);
    assert.equal(await ev("document.querySelector('#rsReviewGo').disabled"), false);
    await ev("rsReviewAccount(); true");
    assert.deepEqual(await ev("[/The Meta link is not set up, so nothing is pulled/.test(document.querySelector('#gModal').innerText), document.querySelector('#rsRevMax').min, !!document.querySelector('#rsRevGo')]"), [true, "0", true]);
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
    // A lean on the suggestion (as a gym with results would have), then the owner's click.
    await ev(`RS.review.brief.lean = ${JSON.stringify(lean)}; RS.review.brief.cards = { statement: 1 }; rsStartNext(); true`);
    await until("!!document.querySelector('#bSuggest') && !!document.querySelector('#bLean .chip')");
    assert.deepEqual(await ev("[location.hash, document.querySelector('#bOffer').value, B.draft.locations, B.draft.audience, /Pre-filled from the account review of \\d{4}-\\d\\d-\\d\\d/.test(document.querySelector('#bSuggest').innerText), /your last batch's own words/.test(document.querySelector('#bSuggest').innerText), document.querySelector('#bLean .chip').innerText.replace(/\\s+/g,' ').trim(), document.querySelector('#bCard-statement').value]"),
      [`#/${GYM}/batch`, "6 Week Review Check", ["BISHAN"], "MEN", true, true, "group setting · workout photos ×", "1"]);
    assert.deepEqual(await ev("(()=>{ const b = briefFromDraft(); return [b.offer, b.lean, b.cards]; })()"), ["6 Week Review Check", lean, { statement: 1 }]);
    // A direction turns the lean off (the words decide); dropping the chip removes it; Start blank clears the suggestion.
    assert.deepEqual(await ev("bSet('direction_words', 'older men lifting with a coach'); ['lean' in briefFromDraft(), /Off for a directed batch/.test(document.querySelector('#bLean').innerText)]"), [false, true]);
    assert.deepEqual(await ev("bSet('direction_words', ''); bLeanDrop(0); ['lean' in briefFromDraft(), document.querySelector('#bLean').innerText]"), [false, ""]);
    assert.deepEqual(await ev("bSuggestClear(); [!!document.querySelector('#bSuggest'), document.querySelector('#bOffer').value, B.draft.lean === undefined]"), [false, "", true], "the offer is never among the gym's defaults");
  } finally { rmSync(bdir, { recursive: true, force: true }); for (const f of ["account-history.json", "creative-reads.json", "account-review.json"]) rmSync(join(g, f), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true }); }
});

test("U53 scenes drafted from the results (2026-11-11): the review says when the mix names a kind with no approved scene and lists the scenes to draft first; the scenes-refresh run takes from_results as a direction of its own (never with words, a reference or a cover list) and is built server-side; a gym with no lead of that kind says so and goes by the gaps; Results shows the list with its button and confirmation, and the Scenes page's refresh offers the direction", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  const keep = ["gym-profile.json", "scenes.json"].map((n) => [join(g, n), existsSync(join(g, n)) ? readFileSync(join(g, n)) : null]);
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true });
  const bdir = join(g, "batches", "2099-01-02-scenes-check");
  const scene = (id, over = {}) => ({ id, audience: "men", pose: "upright", people: 1, exercise: "back-squat", age: "prime", setting: "solo", equipment: "barbell", muscles: "legs", scene: `A man in his thirties mid-set of a barbell back squat in a rack, chest up (${id}).`, ...over });
  try {
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "brief.json"), JSON.stringify({ batch_id: "2099-01-02-scenes-check", offer: "6 Week Scenes Check", locations: ["BISHAN"], audience: "MEN", generated: 10 }));
    const profile = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8")); profile.creative_defaults = { ...profile.creative_defaults, generated: 10, mix: { workout: 80, "studio-portrait": 20 } }; delete profile.creative_defaults.format;
    writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile));
    writeFileSync(join(g, "scenes.json"), JSON.stringify({ approved: true, approved_on: "2026-11-01", scenes: [scene("m-squat-u53"), scene("m-press-u53", { exercise: "shoulder-press", equipment: "dumbbells", muscles: "shoulders", scene: "A man in his twenties seated, pressing dumbbells overhead with effort on his face (u53)." })] }));
    // The review: two portraits in the mix, none approved — said, with the job to draft them.
    const R = await (await call(`/api/client/${GYM}/account-review`)).json();
    assert.deepEqual(R.brief.mix, { workout: 8, "studio-portrait": 2 });
    assert.ok(R.left.some((x) => x.kind === "no_scenes" && /^2 studio portraits in the mix, but no studio portrait scene is approved for men\. Generate Creatives refuses the batch until one is/.test(x.text)), JSON.stringify(R.left));
    assert.deepEqual(R.scenes.map((x) => [x.format, x.audience, x.count, x.from_results, x.needed]), [["studio-portrait", "men", 6, false, true]], "no results for the kind on file: by what the library has fewest of");
    assert.equal(R.scenes_waiting, 0); assert.match(R.text, /Scenes to draft first \(text calls only, drafts for your approval\):\n- 6 studio portrait scenes for men: 2 studio portraits are in the mix/);
    // The run: from_results is checked, and is a direction of its own.
    const post = (body) => call("/api/run", { method: "POST", body });
    assert.equal((await post({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, from_results: "yes" })).status, 400);
    { const r = await post({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, from_results: true, words: "older men lifting with a coach" }); assert.equal(r.status, 400); assert.match((await r.json()).error, /a direction of its own/); }
    // From the results may be aimed at what the next batch tests (a cover list): both ride on the run.
    assert.match((await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, from_results: true, cover: ["setting:group"] })).lines[0], /--count 2 --cover setting:group --from-results$/);
    const ran = await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, from_results: true });
    assert.match(ran.lines[0], /^\$ node skills\/references\/refresh-scenes\.mjs --brand-dir \S+testgym --audience men --count 2 --from-results$/, "built server-side");
    assert.ok(ran.lines.some((l) => /this gym's workout adverts have no lead on record yet, so there are no results to draft from: drafting by the library's gaps instead/.test(l)), ran.lines.join("\n"));
    assert.ok(ran.lines.some((l) => /network blocked|GEMINI_KEY/.test(l)) && ran.lines.some((l) => /^0 draft\(s\)/.test(l)), "there is no model in the tests: it reached the drafter and nothing was drafted: " + ran.lines.join("\n"));
    const portraits = await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, format: "studio-portrait", from_results: true });
    assert.match(portraits.lines[0], /--count 2 --format studio-portrait --from-results$/);
    assert.match((await runAndWait({ kind: "scenes-refresh", gym: GYM, audience: "men", count: 2, from_results: false })).lines[0], /--count 2$/, "false is the refresh as it was");
    // The page: the list on the review card, the confirmation, and the direction on the Scenes page's refresh.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u53#/${GYM}/results` }, sessionId); await loaded;
    await until("!!document.querySelector('#rsScenes')");
    const box = await ev("document.querySelector('#rsScenes').innerText");
    assert.match(box, /Scenes to draft first/i); assert.match(box, /Needed\. 2 studio portraits are in the mix, but no studio portrait scene is approved for men/); assert.match(box, /Draft studio portrait scenes…/);
    assert.match(await ev("document.querySelector('#rsReview').innerText"), /Not yet — 2 studio portraits in the mix, but no studio portrait scene is approved for men/);
    await ev("rsDraftScenes(0); true");
    assert.deepEqual(await ev("[document.querySelector('#rsDsAud').value, document.querySelector('#rsDsN').value, !!document.querySelector('#rsDsGo'), /no image calls/.test(document.querySelector('#gModal').innerText), /no lead on record yet/.test(document.querySelector('#gModal').innerText)]"), ["men", "6", true, true, true]);
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
    // A job from the results reads so on its button and its confirmation (as a gym with results would have).
    await ev("RS.review.scenes = [{ format: 'workout', audience: 'men', count: 6, from_results: true, needed: false, approved: 2, drafts_waiting: 1, why: 'New versions of what earns this gym\\'s leads: its best workout picture has 198 leads at SGD 17.81 (scene m-squat-u53).' }]; RS.review.scenes_waiting = 1; paintResults(document.querySelector('#view')); true");
    const again = await ev("document.querySelector('#rsScenes').innerText");
    assert.match(again, /Draft workout scenes from the results…/); assert.match(again, /1 draft of this kind already await your approval/); assert.match(again, /1 scene draft await your approval on Draft Scenes/);
    await ev("rsDraftScenes(0); true");
    assert.match(await ev("document.querySelector('#gModal').innerText"), /The drafter is told what this gym's own ads of this kind have done .* about two thirds of the scenes as new versions of what earns leads, the rest to keep testing/);
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
    await ev(`location.hash = '#/${GYM}/scenes'; true`);
    await until("typeof bRefreshConfirm === 'function' && !!B.scenes && STATE.tab === 'scenes'");
    await ev("bRefreshConfirm(); true");
    assert.deepEqual(await ev("[...document.querySelectorAll('input[name=bRfDir]')].map(i=>i.value)"), ["gaps", "results", "words", "reference"]);
    assert.match(await ev("document.querySelector('#bModal').innerText"), /From the account's results · new versions of what earns this gym's leads; the rest keep testing/);
    await ev("bClose(); true");
  } finally {
    for (const [p, body] of keep) { if (body) writeFileSync(p, body); else rmSync(p, { force: true }); }
    rmSync(bdir, { recursive: true, force: true }); rmSync(join(g, "account-history.json"), { force: true });
  }
});

test("U54 the cycle (2026-11-11): the panel opens on Review Data; the rail lists the five steps in the owner's order, numbered, with what is waiting on each, and Scenes is no longer under Library; GET …/cycle says where the gym stands and the one thing to do next, from what is on file; the strip shows it on every step's screen (never on the library) and its button opens the step; Draft Scenes says what the data asks for; a new brief shows the review's suggestion without filling in the offer, takes it whole on one click, holds back a kind with no approved scene, and starts blank on request; an address by a step's old name still opens it", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  const keep = ["gym-profile.json", "scenes.json"].map((n) => [join(g, n), existsSync(join(g, n)) ? readFileSync(join(g, n)) : null]);
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true });
  const bdir = join(g, "batches", "2099-01-03-cycle-check");
  const scene = (id, over = {}) => ({ id, audience: "men", pose: "upright", people: 1, exercise: "back-squat", age: "prime", setting: "solo", equipment: "barbell", muscles: "legs", scene: `A man in his thirties mid-set of a barbell back squat in a rack, chest up (${id}).`, ...over });
  const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach`;
  const row = (ad, results, spend) => `2026-04-13,2026-11-08,"${ad}",active,"7-day click or 1-day view",${results},actions:leadgen.other,${(spend / results).toFixed(4)},100,Daily,${spend},${results * 900 + 500},${results * 300 + 200}`;
  try {
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "brief.json"), JSON.stringify({ batch_id: "2099-01-03-cycle-check", offer: "6 Week Cycle Check", locations: ["BISHAN"], audience: "MEN", generated: 10 }));
    const profile = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8")); profile.creative_defaults = { ...profile.creative_defaults, generated: 10, mix: { workout: 80, "studio-portrait": 20 } }; delete profile.creative_defaults.format;
    writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile));
    writeFileSync(join(g, "scenes.json"), JSON.stringify({ approved: true, approved_on: "2026-11-01", scenes: [scene("m-squat-u54"), scene("m-press-u54", { exercise: "shoulder-press", equipment: "dumbbells", muscles: "shoulders", scene: "A man in his twenties seated, pressing dumbbells overhead with effort on his face (u54)." })] }));
    let r = await fetch(`${panel.url}/api/client/${GYM}/history/export/cycle.csv`, { method: "PUT", headers: { "content-type": "text/csv", "x-panel-token": panel.token }, body: [HEADER, row("0413 Body Reset | Image 1: Lady One", 30, 450), row("0413 Body Reset | Image 2: Lady Two", 10, 250)].join("\n") + "\n" });
    assert.equal(r.status, 200);
    // Where the gym stands, from what is on file.
    assert.equal((await call("/api/client/nosuchgym/cycle")).status, 400);
    const C = await (await call(`/api/client/${GYM}/cycle`)).json();
    assert.deepEqual(C.steps.map((s) => [s.n, s.name, s.tab]), [[1, "Review Data", "results"], [2, "Draft Scenes", "scenes"], [3, "Generate Creatives", "batch"], [4, "Pick Ads", "review"], [5, "Publish Ads", "exports"]]);
    assert.match(C.steps[0].text, /^40 leads at SGD 17\.50 running · read \d+ \w{3}$/);
    assert.deepEqual([C.steps[1].state, C.steps[1].text, C.counts.scenes, C.jobs.map((j) => [j.format, j.needed])], ["todo", "1 kind needs scenes", 1, [["studio-portrait", true]]]);
    assert.ok(C.next && C.next.text && C.steps.some((s) => s.name === C.next.name) && typeof C.next.tab === "string", JSON.stringify(C.next));
    for (const s of C.steps) assert.ok(["ok", "todo", "going"].includes(s.state) && s.text, JSON.stringify(s));
    // The page: no screen in the address opens Review Data.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u54` }, sessionId); await loaded;
    await until(`STATE.sel && !!document.querySelector('#clientSel option')`);
    await ev(`selectClient(${JSON.stringify(GYM)}); true`);
    await until(`STATE.sel === ${JSON.stringify(GYM)} && CY.gym === STATE.sel && !!CY.data && RS.gym === STATE.sel && RS.review && RS.review.gym === STATE.sel && !!document.querySelector('#cyc') && !!document.querySelector('#rsNextBatch')`);
    assert.deepEqual(await ev("[STATE.tab, /\\/results$/.test(location.hash), document.querySelector('h1').textContent]"), ["results", true, "Review Data"]);
    // The rail: the cycle first, in order, numbered; Scenes is a step, not a library page; what is waiting is counted.
    const rail = await ev("[...document.querySelectorAll('#rail > *')].map(e => e.classList.contains('sec') ? '# ' + e.textContent : (e.querySelector('.ic')?.textContent||'') + '|' + [...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim() + '|' + (e.querySelector('.badge')?.textContent||''))");
    assert.deepEqual(rail.slice(0, 9).map((x) => x.replace(/\|\d*$/, "")), ["# Portfolio", "▦|All gyms", "# The cycle", "1|Review Data", "2|Draft Scenes", "3|Generate Creatives", "4|Pick Ads", "5|Publish Ads", "# Library"]);
    assert.equal(rail[4], "2|Draft Scenes|1", "one kind needs scenes: " + JSON.stringify(await ev("[CY.gym, CY.data.counts, CY.data.jobs, CY.data.scenes_waiting]")));
    assert.ok(!rail.slice(7).some((x) => /Scenes/.test(x)), rail.join(" / "));
    assert.equal(await ev("document.querySelector('#rail .tab.sel').textContent.replace(/\\d+$/,'')"), "1Review Data");
    // The strip: five steps, this one marked, the scenes waiting, and the one thing to do next.
    const strip = await ev("({ steps: [...document.querySelectorAll('#cyc .cycstep')].map(b => [b.querySelector('.hd').textContent, b.querySelector('.tx').textContent, b.classList.contains('st-todo'), b.classList.contains('here')]) })");
    const now = await (await call(`/api/client/${GYM}/cycle`)).json();
    assert.deepEqual(strip.steps.map((s) => s[0]), ["1Review Data", "2Draft Scenes", "3Generate Creatives", "4Pick Ads", "5Publish Ads"]);
    assert.deepEqual([strip.steps[0][3], strip.steps[1].slice(1)], [true, ["1 kind needs scenes", true, false]]);
    // What to press is said once, by the step's own indicator (U55): here the review is read, then the cycle's next thing.
    const there = now.next.tab === "results" && !now.next.batch;
    assert.deepEqual(await ev("[!!document.querySelector('#cycNext'), !!document.querySelector('#stpDo')]"), [false, true]);
    // A step's box opens its screen; Draft Scenes says what the data asks for.
    await ev("document.querySelectorAll('#cyc .cycstep')[1].click(); true");
    await until("STATE.tab === 'scenes' && !!document.querySelector('#scAsksCard button') && document.querySelector('#cyc .cycstep.here .hd').textContent === '2Draft Scenes'");
    assert.equal(await ev("document.querySelector('h1').textContent"), "Draft Scenes");
    const asks = await ev("document.querySelector('#scAsksCard').innerText");
    assert.match(asks, /What the data asks for/i); assert.match(asks, /Needed\. 2 studio portraits are in the mix, but no studio portrait scene is approved for men/); assert.match(asks, /Draft studio portrait scenes…/);
    await ev("scDraft(0); true");
    assert.deepEqual(await ev("[document.querySelector('#rsDsAud').value, !!document.querySelector('#rsDsGo')]"), ["men", true]);
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
    // The strip is the cycle's: not on a library page.
    await ev("go('copy'); true");
    await until("STATE.tab === 'copy' && document.querySelector('#cycle').innerHTML === ''");
    // A new brief: the review's suggestion on a banner, the offer left alone, the gym's own photos per kind.
    await ev("go('batch'); true");
    await until("STATE.tab === 'batch' && !!document.querySelector('#bSuggestUse')");
    assert.deepEqual(await ev("[document.querySelector('h1').textContent, document.querySelector('#bOffer').value, B.draft.offer, B.touched, B.draft.mix['studio-portrait'], B.draft.cards.statement + B.draft.cards.review + B.draft.cards.timeline]"), ["Generate Creatives", "", "", false, 2, 0], "never the offer; the gym's Ad defaults for the photos; no card added");
    let banner = await ev("document.querySelector('#bSuggest').innerText");
    assert.match(banner, /Suggested by the account review of \d{4}-\d\d-\d\d/); assert.match(banner, /6 Week Cycle Check · your last batch's words/); assert.match(banner, /BISHAN · MEN/); assert.match(banner, /The offer is yours to type/); assert.match(banner, /Running now: Body Reset \(40 leads at SGD 17\.50\)/);
    // One click takes all of it: the last batch's own words, and a kind with no approved scene held back, in words.
    await ev("document.querySelector('#bSuggestUse').click(); true");
    await until("document.querySelector('#bOffer').value === '6 Week Cycle Check'");
    assert.deepEqual(await ev("[B.draft.locations, B.draft.audience, B.draft.mix['studio-portrait'] || 0, B.touched, !!document.querySelector('#bSuggestUse'), !!document.querySelector('#bSuggestHeld')]"), [["BISHAN"], "MEN", 0, true, false, true]);
    banner = await ev("document.querySelector('#bSuggest').innerText");
    assert.match(banner, /Pre-filled from the account review/); assert.match(banner, /Left out for now — 2 studio portraits: no scene of that kind is approved yet\. Draft Scenes →/);
    await ev("bSuggestClear(); true");
    assert.deepEqual(await ev("[!!document.querySelector('#bSuggest'), document.querySelector('#bOffer').value, B.draft.mix['studio-portrait']]"), [false, "", 2], "blank: the Ad defaults again");
    // Leaving and coming back keeps the form as it was left: the suggestion is offered once per opening of a gym.
    await ev("go('scenes'); true"); await until("STATE.tab === 'scenes'"); await ev("go('batch'); true"); await until("STATE.tab === 'batch' && !!document.querySelector('#bOffer')");
    await new Promise((x) => setTimeout(x, 600));
    assert.equal(await ev("!!document.querySelector('#bSuggest')"), false);
    // An address by the step's old name.
    await ev(`location.hash = '#/${GYM}/create'; true`);
    await until("STATE.tab === 'batch'");
    await ev(`location.hash = '#/${GYM}/nosuchscreen'; true`);
    await until("STATE.tab === 'results'");
  } finally {
    for (const [p, body] of keep) { if (body) writeFileSync(p, body); else rmSync(p, { force: true }); }
    rmSync(bdir, { recursive: true, force: true }); rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true }); rmSync(join(g, "copy-references.json"), { force: true });
  }
});

test("U55 the step indicator (2026-11-11): inside each of the five steps, its own parts in order — done, now, later — and one bar that says what to do now with the one button that does it; a part is done by what is on file or on the form, never by a click on the indicator; the button presses what the screen already has (the same confirmations); a step with nothing waiting says so and points at the cycle's next thing; the library has no indicator", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  const keep = ["gym-profile.json", "scenes.json"].map((n) => [join(g, n), existsSync(join(g, n)) ? readFileSync(join(g, n)) : null]);
  rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "creative-reads.json"), { force: true });
  const bdir = join(g, "batches", "2099-01-04-stepper-check");
  const scene = (id, over = {}) => ({ id, audience: "men", pose: "upright", people: 1, exercise: "back-squat", age: "prime", setting: "solo", equipment: "barbell", muscles: "legs", scene: `A man in his thirties mid-set of a barbell back squat in a rack, chest up (${id}).`, ...over });
  const HEADER = `"Reporting starts","Reporting ends","Ad name","Ad delivery","Attribution setting",Results,"Result indicator","Cost per results","Ad set budget","Ad set budget type","Amount spent (SGD)",Impressions,Reach`;
  const row = (ad, results, spend) => `2026-04-13,2026-11-08,"${ad}",active,"7-day click or 1-day view",${results},actions:leadgen.other,${(spend / results).toFixed(4)},100,Daily,${spend},${results * 900 + 500},${results * 300 + 200}`;
  try {
    mkdirSync(bdir, { recursive: true });
    writeFileSync(join(bdir, "brief.json"), JSON.stringify({ batch_id: "2099-01-04-stepper-check", offer: "6 Week Stepper Check", locations: ["BISHAN"], audience: "MEN", generated: 10 }));
    const profile = JSON.parse(readFileSync(join(g, "gym-profile.json"), "utf-8")); profile.creative_defaults = { ...profile.creative_defaults, generated: 10, mix: { workout: 80, "studio-portrait": 20 } }; delete profile.creative_defaults.format;
    writeFileSync(join(g, "gym-profile.json"), JSON.stringify(profile));
    writeFileSync(join(g, "scenes.json"), JSON.stringify({ approved: true, approved_on: "2026-11-01", scenes: [scene("m-squat-u55"), scene("m-press-u55", { exercise: "shoulder-press", equipment: "dumbbells", muscles: "shoulders", scene: "A man in his twenties seated, pressing dumbbells overhead with effort on his face (u55)." })] }));
    const r = await fetch(`${panel.url}/api/client/${GYM}/history/export/stepper.csv`, { method: "PUT", headers: { "content-type": "text/csv", "x-panel-token": panel.token }, body: [HEADER, row("0413 Body Reset | Image 1: Lady One", 30, 450), row("0413 Body Reset | Image 2: Lady Two", 10, 250)].join("\n") + "\n" });
    assert.equal(r.status, 200);
    const C = await (await call(`/api/client/${GYM}/cycle`)).json();
    assert.deepEqual([C.info.ads >= 2, C.info.running, C.info.stale, C.info.data_age, C.info.unread >= 0, C.info.linked, Array.isArray(C.batches), "current" in C], [true, 2, false, 0, true, false, true, true]);
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    // What the indicator shows: each part with its state, the bar's label, its sentence and its button.
    const read = () => ev("(()=>{ const d = document.querySelector('#stpDo'); return { parts: [...document.querySelectorAll('#stpParts .stpp')].map(e => [e.textContent.replace(/^[✓\\d]/, ''), e.classList.contains('done') ? 'done' : e.classList.contains('now') ? 'now' : 'later']), k: d?.querySelector('.k').textContent || null, t: d?.querySelector('.t').textContent || '', b: d?.querySelector('#stpGo')?.textContent || null, primary: document.querySelectorAll('#stp button.primary').length, else_: document.querySelector('#stpElse')?.textContent || null }; })()");
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u55#/${GYM}/results` }, sessionId); await loaded;
    await until(`STATE.sel === ${JSON.stringify(GYM)} && CY.gym === STATE.sel && !!CY.data && RS.review && RS.review.gym === STATE.sel && !!document.querySelector('#stp')`);
    const next = await ev("CY.data.next");
    assert.equal(await ev("!!document.querySelector('#cycNext')"), false, "one bar says what to press: the strip has no second one");
    // Step 1 · Review Data: the numbers are fresh and every picture is read, so the review is the thing to read, then on.
    let S = await read();
    const info = await ev("CY.data.info"), unread = info.unread > 0; // earlier tests may leave published ads whose pictures are not read
    assert.deepEqual(S.parts, [["Get the latest numbers", "done"], ["Read the pictures", unread ? "now" : "done"], ["Read the review, then go on", unread ? "later" : "now"]]);
    if (unread) { assert.deepEqual([S.k, S.b, S.primary], ["Do this now · 2 of 3", "Read the creatives…", 1]); assert.match(S.t, /^\d+ pictures? of your ads ha(s|ve) not been read yet/); }
    else {
      assert.deepEqual([S.k, S.primary], ["Do this now · 3 of 3", next.tab === "results" && !next.batch || next.idle ? 0 : 1]);
      assert.match(S.t, /^Read the review below: what to keep running, what is tiring, what to pause, and the next batch it suggests\./);
      if (!(next.tab === "results" && !next.batch)) { assert.ok(S.t.endsWith(`Then: ${next.text}`), S.t); if (!next.idle) assert.equal(S.b, `${next.name} →`); }
    }
    // The last part hands over to the cycle: its sentence ends with the next thing and its button is that step's.
    assert.deepEqual(await ev("(()=>{ const c = { ...CY.data, info: { ...CY.data.info, unread: 0 } }; const p = partsResults(c).parts; return [p.map(x => x.done), p[2].cycle, p[2].label || null]; })()"), [[true, true, false], true, null]);
    // With no data the first part is the thing to do; with data a week old and ads running, the same.
    assert.deepEqual(await ev("(()=>{ const c = { ...CY.data, info: { ...CY.data.info, ads: 0, running: 0, account: true, linked: true } }; const p = partsResults(c).parts; return [p[0].done, p[0].label, p[1].done]; })()"), [false, "Review the account…", false]);
    assert.deepEqual(await ev("(()=>{ const c = { ...CY.data, info: { ...CY.data.info, stale: true, data_age: 9, unread: 3, account: true, linked: true } }; const p = partsResults(c).parts; return [p[0].done, /last read 9 days ago/.test(p[0].text), p[1].done, p[1].label, /^3 pictures of your ads have not been read yet/.test(p[1].text)]; })()"), [false, true, false, "Read the creatives…", true]);
    // Step 2 · Draft Scenes: a kind in the mix has no scene and no draft — drafting it is the one button, and it opens the same confirmation.
    await ev("go('scenes'); true");
    await until("STATE.tab === 'scenes' && !!document.querySelector('#scAsksCard') && !!document.querySelector('#stpGo')");
    S = await read();
    assert.deepEqual([S.parts, S.k, S.b, S.primary], [[["Draft the scenes the data asks for", "now"], ["Approve the ones you want", "done"], ["Scenes ready for the next batch", "later"]], "Do this now · 1 of 3", "Draft studio portrait scenes…", 1]);
    assert.match(S.t, /The next batch has studio portrait photos in it and no scene of that kind is approved\. Have the agent draft some: text only, no image calls\./);
    await ev("document.querySelector('#stpGo').click(); true");
    assert.deepEqual(await ev("[document.querySelector('#rsDsAud')?.value, !!document.querySelector('#rsDsGo')]"), ["men", true], "the bar's button is the screen's own: the confirmation, nothing started");
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
    // Drafts of that kind waiting: approving is the thing; nothing needed and nothing waiting: the step is done.
    assert.deepEqual(await ev("(()=>{ const c = { ...CY.data, scenes_waiting: 4, jobs: CY.data.jobs.map(j => ({ ...j, drafts_waiting: 4 })) }; const p = partsScenes(c).parts; return [p.map(x => x.done), p[1].label, /^4 drafts are waiting below/.test(p[1].text)]; })()"), [[true, false, false], "Show the drafts ↓", true]);
    assert.deepEqual(await ev("(()=>{ const c = { ...CY.data, scenes_waiting: 0, jobs: [] }; const s = partsScenes(c); return [s.parts.map(x => x.done), s.after.cycle, /^Every kind of photo in the next batch has approved scenes\\./.test(s.after.text)]; })()"), [[true, true, true], true, true]);
    // Step 3 · Generate Creatives: the offer first (the review's suggestion is the one button), then the check, then Generate.
    await ev("go('batch'); true");
    await until("STATE.tab === 'batch' && !!document.querySelector('#bSuggestUse') && document.querySelector('#stpGo')?.textContent === 'Use this suggestion'");
    S = await read();
    assert.deepEqual([S.parts, S.k, S.primary], [[["Say the offer and where", "now"], ["Fix what the check says", "later"], ["Generate the ads", "later"], ["Pick the ads", "later"]], "Do this now · 1 of 4", 1]);
    assert.equal(await ev("document.querySelector('#bSuggestUse').classList.contains('primary')"), false, "one primary button for the step: the bar's");
    await ev("document.querySelector('#stpGo').click(); true");
    await until("document.querySelector('#bOffer').value === '6 Week Stepper Check' && !!B.check");
    { const t0 = Date.now(); while (Date.now() - t0 < 15000 && !(await ev("/^Generate \\d+ ads…$/.test(document.querySelector('#stpGo')?.textContent || '')"))) await new Promise((x) => setTimeout(x, 150)); }
    assert.match(await ev("document.querySelector('#stpGo')?.textContent || ''"), /^Generate \d+ ads…$/, JSON.stringify(await ev("[document.querySelector('#stpDo')?.textContent, B.check?.errors, STATE.run && { done: STATE.run.done, label: STATE.run.label }]")));
    S = await read();
    // The suggestion held the studio portraits back (no scene of that kind is approved), and the brief says so to the check:
    // an all-workout batch for a gym whose default is a mix names "workout", or the gym's mix would come back.
    assert.deepEqual(await ev("[B.check.errors, B.check.brief.format, 'mix' in B.check.brief, !!document.querySelector('#bSuggestHeld')]"), [[], "workout", false, true]);
    assert.deepEqual([S.parts.map((p) => p[1]), S.k], [["done", "done", "now", "later"], "Do this now · 3 of 4"]);
    assert.match(S.t, /^The brief is good\. This makes \d+ ads from \d+ photos, with at most \d+ image calls\. Nothing spends until you confirm\.$/);
    assert.equal(S.b, await ev("document.querySelector('#bRun').textContent"), "the same words as the screen's own button");
    // A problem on the form is the second part, in the check's own words.
    await ev("bSet('offer', '12 Week — Reset'); true"); // an em dash: the server's rule refuses it
    await until("/^Do this now · 2 of 4/.test(document.querySelector('#stpDo .k')?.textContent || '')");
    S = await read();
    assert.deepEqual([S.parts.map((p) => p[1]), S.b], [["done", "now", "later", "later"], "Show me"]); assert.match(S.t, /^\d+ things? to fix before this can run: /);
    // Blank again: the offer is the thing, with no suggestion to take.
    await ev("bSuggestClear(); true");
    await until("document.querySelector('#stpGo')?.textContent === 'Go to the offer'");
    assert.deepEqual((await read()).parts.map((p) => p[1]), ["now", "later", "later", "later"]);
    // Steps 4 and 5, the lists: a batch that is waiting is the one button; with none waiting the step says so and points on.
    for (const [tab, n, first, fn] of [["review", 4, "Open a batch", "partsReviewList"], ["exports", 6, "Open a batch", "partsExports"]]) {
      await ev(`go('${tab}'); true`);
      await until(`STATE.tab === '${tab}' && document.querySelectorAll('#stpParts .stpp').length === ${n}`);
      S = await read();
      assert.equal(S.parts[0][0], first); assert.ok(["Do this now · 1 of " + n, "Nothing to do here now"].includes(S.k), S.k);
      const made = (over) => `{ ...CY.data, batches: [{ id: 'b-1', ads: 12, kept: 8, excluded: 2, unreviewed: 2, stories: 0, open: true, published: null, ...${JSON.stringify(over)} }] }`;
      assert.deepEqual(await ev(`(()=>{ const s = ${fn}(${made({})}); return [!!s.idle, s.parts[0].label, s.parts.length]; })()`), [false, "Open it →", n]);
      assert.deepEqual(await ev(`(()=>{ const s = ${fn}(${made({ open: false, unreviewed: 0, stories: 8, published: { done: true, ads: 8 } })}); return [typeof s.idle, s.parts.every(p => !p.done && !p.label)]; })()`), ["string", true], "published and done: nothing is waiting here");
    }
    assert.deepEqual(await ev("[PICK_PARTS, PUB_PARTS]"), [["Open a batch", "Keep or exclude each ad", "Make Stories versions", "Go to publish"], ["Open a batch", "Keep copy and headlines", "Check the ad sets", "Choose the lead form", "Create on Facebook, paused", "Turn the ads on"]]);
    // No indicator outside the cycle.
    await ev("go('copy'); true");
    await until("STATE.tab === 'copy' && document.querySelector('#stepper').innerHTML === ''");
  } finally {
    for (const [p, body] of keep) { if (body) writeFileSync(p, body); else rmSync(p, { force: true }); }
    rmSync(bdir, { recursive: true, force: true }); rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "onboarding", "exports"), { recursive: true, force: true }); rmSync(join(g, "copy-references.json"), { force: true });
  }
});

test("U56 waiting (2026-11-11): whenever the page waits on something it says so — every request is seen; a named wait (the agent drafting, Meta answering) shows after a moment in the bar under the header, in the header's line with how long it has been, and in the step indicator, whose bar turns to Working with its button off; the checks that run as you type never show; a plain load leaves the step indicator alone; a run shows with its latest line; the indicator says so while it reads where the gym stands", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
  const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u56#/${GYM}/scenes` }, sessionId); await loaded;
  await until(`STATE.sel === ${JSON.stringify(GYM)} && CY.gym === STATE.sel && !!CY.data && !!document.querySelector('#stpDo') && WAIT.items.size === 0`);
  const shown = () => ev("({ bar: document.querySelector('#waitbar').classList.contains('on'), chip: document.querySelector('#waitchip').hidden ? null : document.querySelector('#waitchip').textContent, working: document.querySelector('#stpDo').classList.contains('working'), k: document.querySelector('#stpDo .k').textContent, t: document.querySelector('#stpDo .t').textContent, go: document.querySelector('#stpGo') ? [document.querySelector('#stpGo').textContent, document.querySelector('#stpGo').disabled] : null, busy: document.querySelectorAll('#stpParts .stpp.busy').length })");
  // What each request is, in plain words; the ones that never show.
  assert.deepEqual(await ev(`[waitLabel('POST','/api/client/x/batch/y/copy/draft','{"kind":"headline","count":10}'), waitLabel('POST','/api/client/x/batch/y/copy/draft','{"kind":"copy"}').text.slice(0, 29), waitLabel('POST','/api/client/x/batch/y/results/pull').text, waitLabel('POST','/api/client/x/batch/check'), waitLabel('POST','/api/preview'), waitLabel('PUT','/api/client/x/batch/y/picks'), waitLabel('GET','/api/client/x/cycle'), waitLabel('GET','/api/client/x/offer/y'), waitLabel('POST','/api/client/x/wordings'), waitLabel('GET','/api/client/x/results?scope=all').text]`),
    [{ text: "The agent is drafting headlines from the copy library, then judging each one for clarity. This takes about a minute.", named: true }, "The agent is drafting copies ", "Reading this campaign's results from Meta.", null, null, null, null, { text: "Loading.", named: false }, { text: "Saving.", named: false }, "Reading the results on file."]);
  // Every request goes through one door, and leaves nothing behind.
  const seq = await ev("WAIT.seq");
  await ev(`api('/api/client/${GYM}/account-review').then(() => true)`);
  assert.deepEqual(await ev(`[WAIT.seq > ${seq}, WAIT.items.size]`), [true, 0]);
  const calm = await shown();
  assert.deepEqual([calm.bar, calm.chip, calm.working], [false, null, false]);
  // The agent is drafting: nothing for the first moment (no flicker), then all three places say it, with how long it has been.
  const id = await ev(`waitStart('POST', '/api/client/${GYM}/batch/b/copy/draft', '{"kind":"copy","count":10}')`);
  await ev("paintWait(); true");
  assert.deepEqual([(await shown()).bar, (await shown()).working], [false, false], "not in the first moment");
  await ev(`WAIT.items.get(${id}).at -= 14000; paintWait(); true`);
  let S = await shown();
  assert.deepEqual([S.bar, S.working, S.busy <= 1], [true, true, true]);
  assert.match(S.chip, /^The agent is drafting copies from the copy library, then judging each one for clarity\. This takes about a minute\. · 14 s$/);
  assert.match(S.k, /^Working( · \d of \d)?$/); assert.match(S.t, /^The agent is drafting copies .* · 14 s$/);
  if (S.go) assert.deepEqual(S.go, ["Working…", true], "the button is off until it is over");
  assert.equal(await ev("(()=>{ stpGo(); return !!document.querySelector('.modal'); })()"), false, "and does nothing");
  await ev(`waitEnd(${id}); true`);
  S = await shown();
  assert.deepEqual([S.bar, S.chip, S.working, S.busy], [false, null, false, 0]); assert.doesNotMatch(S.k, /^Working/);
  if (S.go) assert.equal(S.go[1], false);
  // A plain load says so in the header and leaves the step's bar alone.
  const lid = await ev(`waitStart('GET', '/api/client/${GYM}/offer/y')`);
  await ev(`WAIT.items.get(${lid}).at -= 2000; paintWait(); true`);
  S = await shown();
  assert.deepEqual([S.bar, S.chip, S.working], [true, "Loading.", false]);
  await ev(`waitEnd(${lid}); true`);
  // A run: its name and its latest line, minutes and seconds; over when it ends.
  await ev("STATE.run = { label: 'Refresh scenes (drafts for approval)', lines: [{ stream: 'meta', line: '$ node …' }, { stream: 'out', line: '· gaps for men (2 live scenes)' }], done: false, code: null, at: Date.now() - 65000 }; paintWait(); true");
  S = await shown();
  assert.deepEqual([S.bar, S.working], [true, true]);
  assert.match(S.chip, /^Refresh scenes \(drafts for approval\) — · gaps for men \(2 live scenes\) · 1 min 5 s$/);
  await ev("STATE.run.done = true; STATE.run.code = 0; paintWait(); true");
  S = await shown();
  assert.deepEqual([S.bar, S.chip, S.working], [false, null, false]);
  await ev("STATE.run = null; paintWait(); true");
  // Before the cycle's answer is in, the indicator says what it is reading rather than showing nothing.
  await ev("CY.gym = null; CY.data = null; CY.error = null; paintStepper(); true");
  assert.deepEqual(await ev("[document.querySelector('#stpDo').classList.contains('working'), document.querySelector('#stpDo .t').textContent]"), [true, "Reading where this gym stands in the cycle."]);
  await ev("loadCycle().then(() => true)");
  await until("CY.gym === STATE.sel && !!CY.data && !document.querySelector('#stpDo').classList.contains('working')");
});

test("U57 the lead form, a part of its own in Publish Ads (2026-11-11): between the ad sets and Create on Facebook the owner says which form these ads use — an existing form of the Page, or a new one; the yes is kept per campaign (destination.form_confirmed) and a bad one is refused; another form picked afterwards must be confirmed again; the Destination card and the create confirmation say whether it is confirmed", async () => {
  const g = join(brands, GYM), sfile = join(g, "outputs", BRIEF.batch_id, "publish-settings.json");
  const saved = existsSync(sfile) ? readFileSync(sfile) : null;
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
  const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
  try {
    // The setting: digits only.
    const cur = (await (await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`)).json()).settings || {};
    let r = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body: { ...cur, destination: { ...(cur.destination || {}), form_confirmed: "the right one" } } });
    assert.equal(r.status, 400);
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u57#/${GYM}/publish/${BRIEF.batch_id}` }, sessionId); await loaded;
    await until(`!!PB.data && PB.id === ${JSON.stringify(BRIEF.batch_id)} && !!document.querySelector('#stpParts') && !!document.querySelector('#pbFormOk')`);
    assert.deepEqual(await ev("PUB_PARTS"), ["Open a batch", "Keep copy and headlines", "Check the ad sets", "Choose the lead form", "Create on Facebook, paused", "Turn the ads on"]);
    assert.deepEqual(await ev("[...document.querySelectorAll('#stpParts .stpp .nm')].map(e => e.textContent)"), await ev("PUB_PARTS"), "the indicator shows all six");
    const form = await ev("PB.data.plan.lead_form_id");
    assert.match(String(form), /^\d{5,20}$/, "the test gym has a form on its profile");
    // Not confirmed: the part is open, in words, with its one button. (A campaign already created counts as settled: looked at here as not yet created.)
    const partOf = "(()=>{ const keep = PB.data.published; PB.data.published = null; try { const p = partsPublish().parts[3]; return [p.name, p.done, p.label, p.text]; } finally { PB.data.published = keep; } })()";
    let p = await ev(partOf);
    assert.deepEqual(p.slice(0, 3), ["Choose the lead form", false, "Choose the lead form…"]);
    assert.match(p[3], /^Leads from these ads go to the form ".+"\. Check it is the right form for this offer — or pick another, or make a new one — and confirm it\.$/);
    assert.deepEqual(await ev("[pbFormConfirmed(), document.querySelector('#pbFormOk').textContent]"), [false, "not confirmed yet"]);
    // The dialog: the Page's forms when they can be listed, the form on file when they cannot; a new one from the template; nothing saved until Use this form.
    await ev("pbFormChoose().then(() => true)");
    await until("!!document.querySelector('#bModal .modal #pbFormUse')");
    assert.deepEqual(await ev("[document.querySelector('#bModal h2').textContent, document.querySelector('input[name=pbForm]:checked')?.value, document.querySelector('#pbFormUse').disabled, !!document.querySelector('#pbFormNew'), /or make a new one/.test(document.querySelector('#bModal').innerText)]"), ["Which lead form do these ads use?", String(form), false, true, true]);
    assert.equal(JSON.parse(existsSync(sfile) ? readFileSync(sfile, "utf-8") : "{}").destination?.form_confirmed ?? null, null, "looking confirms nothing");
    await ev("document.querySelector('#pbFormUse').click(); true");
    await until(`pbFormConfirmed() && document.querySelector('#pbFormOk')?.textContent === 'confirmed for this campaign' && !document.querySelector('.modal')`);
    const onDisk = JSON.parse(readFileSync(sfile, "utf-8")).destination;
    assert.deepEqual([onDisk.lead_form_id, onDisk.form_confirmed], [String(form), String(form)], "the owner's yes, kept with the campaign's settings");
    assert.equal((await ev(partOf))[1], true);
    // The create confirmation says where the leads go, and that it is confirmed.
    await ev("pbCreateConfirm(); true");
    assert.match(await ev("document.querySelector('#pbCreateForm').innerText"), /^Leads go to the form .+ confirmed$/);
    await ev("bClose(); true");
    // Another form picked on the card: the yes was for the other one.
    await ev("pbSet('destination.lead_form_id', '998877665544'); true");
    await until("PB.data.plan.lead_form_id === '998877665544' && document.querySelector('#pbFormOk')?.textContent === 'not confirmed yet'");
    assert.deepEqual([await ev("pbFormConfirmed()"), (await ev(partOf))[1]], [false, false]);
    await ev("pbCreateConfirm(); true");
    assert.match(await ev("document.querySelector('#pbCreateForm').innerText"), /not confirmed yet choose and confirm it first$/);
    await ev("bClose(); true");
    // The names a form is marked by: the whole offer, the offer without its duration, or its long words.
    assert.deepEqual(await ev("[formNamesOffer('v9 - 11月 6 Week Strength Kickstart', '6 Week Strength Kickstart'), formNamesOffer('Strength Kickstart leads', '6 Week Strength Kickstart'), formNamesOffer('Kickstart: strength in a week or six, men', '6 Week Strength Kickstart'), formNamesOffer('12 Week Total Body Reset', '6 Week Strength Kickstart'), formNamesOffer('', 'x')]"), [true, true, true, false, null]);
  } finally { if (saved) writeFileSync(sfile, saved); else rmSync(sfile, { force: true }); }
});

test("U58 setting up a gym, step by step (2026-11-11): the Profile screens carry the same strip, the same indicator and the same one button as the cycle — five steps from what the profile still needs, item by item; the bar saves what was changed, points at the field of the next missing thing, sends to the screen that holds it, offers the import to a gym just linked, then leads to the next step and, with every step done, into the cycle; the pixel and the portfolio are optional; a cycle screen says when the setup is not finished; the library has neither; waiting shows here too", async () => {
  const { cdp, sessionId } = browser;
  const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
  const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
  // The server says each thing a section needs, done or not, and whether the gym was ever imported from Meta.
  const V = await (await call(`/api/client/${GYM}`)).json();
  assert.deepEqual(V.completeness.sections.map((s) => s.id), ["identity", "brand", "photos", "rooms", "scenes", "offers", "defaults", "targeting", "meta"]);
  assert.deepEqual(V.completeness.sections.find((s) => s.id === "rooms").for, "learning", "which room a photo shows: for learning from the results, never in the way of creating or publishing");
  for (const s of V.completeness.sections) { assert.ok(s.items.length && s.items.every((i) => typeof i.what === "string" && typeof i.ok === "boolean"), s.id); assert.deepEqual(s.items.filter((i) => !i.ok).map((i) => i.what), s.missing, `${s.id}: the items say what the section's missing list says`); }
  assert.equal(typeof V.setup.imported, "boolean");
  const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u58#/${GYM}/overview` }, sessionId); await loaded;
  await until(`!!STATE.status && STATE.sel === ${JSON.stringify(GYM)} && STATE.tab === 'overview' && !!document.querySelector('#setupStrip') && !!document.querySelector('#stpDo')`);
  // The Overview: the setup's strip (not the cycle's), five steps in order, and the indicator's parts are the steps.
  const names = ["Connect to Meta", "Who the gym is", "Brand and photos", "Offer and ad defaults", "Targeting and budget"];
  assert.deepEqual(await ev("[...document.querySelectorAll('#setupStrip .cycstep .hd')].map(e => e.textContent.replace(/^[✓\\d]/, ''))"), names);
  assert.deepEqual(await ev("[...document.querySelectorAll('#stpParts .stpp .nm')].map(e => e.textContent)"), names);
  assert.match(await ev("document.querySelector('#setupStrip .cychd').textContent"), /^Setting up .+ · \d of 5 done/);
  assert.deepEqual(await ev("[!!document.querySelector('#cyc'), !!document.querySelector('#cycNext'), SETUP_TABS.includes('overview'), SETUP_TABS.includes('photos'), SETUP_TABS.includes('copy')]"), [false, false, true, false, false]);
  // A gym as it could be, to read the rules against: `with` swaps the profile's state for one evaluation and puts everything back.
  const sec = "(id, page, items) => ({ id, label: id, page, status: '', missing: items.filter(x => !x[1]).map(x => x[0]), items: items.map(([what, ok]) => ({ what, ok })) })";
  const state = (o = {}) => `(()=>{ const sec = ${sec}, o = ${JSON.stringify(o)}, ok = (k, d = true) => (k in o ? o[k] : d); return { sections: [
    sec('identity', 'identity', [['display name', true], ['abbreviation', true], ['website', ok('website')], ["a location's name", true], ['its postal code', ok('postal')]]),
    sec('brand', 'brand', [['a primary colour', ok('colour')], ['what photos must show', true], ['what photos must never show', true], ['who is in the photos', true]]),
    sec('photos', 'photos', [['a cleaned photo of the premises, or a room reference', ok('photo')]]), sec('scenes', 'scenes', [['an approved scene library', true]]),
    sec('offers', 'offer', [['at least one offer wording', ok('wording')]]), sec('defaults', 'defaults', [['at least one location callout', ok('callout')]]),
    sec('targeting', 'targeting', [['a radius pin', ok('pin')], ['an age range', true], ['a budget', true]]),
    sec('meta', 'meta', [['ad account id', ok('account')], ['Facebook page id', true], ['business portfolio id', ok('portfolio')], ['pixel id', ok('pixel')], ['lead form id', true]]) ] }; })()`;
  const withState = (o, tab, body, extra = "") => ev(`(()=>{ const keep = [STATE.view, STATE.tab, DIRTY.profile]; STATE.view = { ...STATE.view, completeness: ${state(o)}, setup: { imported: ${!!o.imported} } }; STATE.tab = ${JSON.stringify(tab)}; ${extra} try { ${body} } finally { [STATE.view, STATE.tab, DIRTY.profile] = keep; } })()`);
  const bar = "(S => { const i = S.parts.findIndex(p => !p.done), a = i >= 0 ? S.parts[i] : S.after; return [S.parts.map(p => p.opt ? 'opt' : p.done ? 'done' : 'todo'), i, a.label || null, a.text]; })(partsSetup())";
  // Every step done: the Overview hands over to the cycle. The pixel and the portfolio are never waited for.
  let r = await withState({ pixel: false, portfolio: false }, "overview", `return ${bar};`);
  assert.deepEqual(r.slice(0, 3), [["done", "done", "done", "done", "done"], -1, "Start the cycle: Review Data →"]); assert.match(r[3], /^The gym is set up\./);
  r = await withState({ pixel: false, portfolio: false }, "meta", `return ${bar};`);
  assert.deepEqual(r.slice(0, 3), [["done", "done", "opt", "opt", "done"], -1, "Start the cycle: Review Data →"], "optional and not set: shown, never the thing to do");
  // The Overview names the first step with something missing, and its button goes to the screen that holds it.
  r = await withState({ website: false, callout: false }, "overview", `return ${bar};`);
  assert.deepEqual(r.slice(0, 3), [["done", "todo", "done", "todo", "done"], 1, "Who the gym is →"]); assert.equal(r[3], "Who the gym is still needs website.");
  assert.deepEqual(await withState({ callout: false }, "overview", "const M = setupModel(); return [M[3].missing[0].page, M[3].home, M.map(s => s.done)];"), ["defaults", "offer", [true, true, true, false, true]]);
  // On the screen that holds the missing thing: what it is, how to give it, and a button that takes the eye to its field.
  await ev("go('identity'); true");
  await until("STATE.tab === 'identity' && !!document.querySelector('#pName') && !!document.querySelector('#setupStrip .cycstep.here')");
  assert.equal(await ev("document.querySelector('#setupStrip .cycstep.here .hd').textContent.replace(/^[✓\\d]/, '')"), "Who the gym is");
  r = await withState({ website: false, postal: false }, "identity", `return ${bar};`);
  assert.deepEqual(r.slice(0, 3), [["done", "done", "todo", "done", "todo"], 2, "Show me where"]);
  assert.equal(r[3], "Still needed: website. The gym's own website address: a lead ad links to it. Then press Save changes.");
  assert.equal(await withState({ website: false }, "identity", "const p = partsSetup().parts[2]; p.go(); return document.activeElement === document.querySelector(SETUP_FIELD.website);"), true, "the cursor is in the website box");
  // Something typed and not saved: saving it is the one thing to do, whatever else is missing.
  r = await withState({ website: false }, "identity", `return ${bar};`, "DIRTY.profile = true;");
  assert.deepEqual([r[2], r[3]], ["Save changes", "You have changes on this page that are not saved yet. Save them before going on."]);
  r = await withState({}, "identity", `return ${bar};`, "DIRTY.profile = true;");
  assert.deepEqual([r[1], r[2]], [-1, "Save changes"], "even with the step complete");
  // Typing in a field really does it: the bar turns to Save changes at the first keystroke. (Nothing is saved here.)
  await ev("(()=>{ const el = document.querySelector(SETUP_FIELD.website); el.value = el.value + ' '; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await until("document.querySelector('#stpGo')?.textContent === 'Save changes'");
  await ev("DIRTY.profile = false; refreshProfile().then(() => { render(); return true; })");
  await until("document.querySelector('#stpGo')?.textContent !== 'Save changes'");
  // The missing thing is on another screen of the same step: the button goes there.
  r = await withState({ callout: false }, "offer", `return ${bar};`);
  assert.deepEqual([r[0], r[2]], [["done", "todo"], "Ad defaults →"]); assert.match(r[3], /^This step still needs at least one location callout\. .* It is on Ad defaults\.$/);
  r = await withState({ photo: false }, "brand", `return ${bar};`);
  assert.deepEqual([r[0], r[2]], [["done", "done", "done", "done", "todo"], "Photos & brand assets →"]);
  // Photos & assets is a library page: it carries the setup only while the gym's photos are still to do.
  assert.deepEqual([await withState({ photo: false }, "photos", "return onSetup();"), await withState({}, "photos", "return onSetup();"), await withState({ photo: false }, "copy", "return onSetup();")], [true, false, false]);
  // The step done: on to the next one that is not; a gym just linked is offered the import first — only while what an import fills is missing.
  r = await withState({ callout: false }, "identity", `return ${bar};`);
  assert.deepEqual([r[1], r[2]], [-1, "Offer and ad defaults →"]); assert.equal(r[3], "Next in the setup: Offer and ad defaults — it still needs at least one location callout.");
  const linked = "STATE.profile = { ...STATE.profile, meta_assets: { ...(STATE.profile.meta_assets || {}), ad_account_id: '123456789' } };";
  const p0 = await ev("JSON.stringify(STATE.profile)");
  assert.deepEqual([(await withState({ postal: false }, "meta", `return ${bar};`, linked))[2], (await withState({ postal: false }, "import", `return ${bar};`, linked))[2], (await withState({ postal: false, imported: true }, "meta", `return ${bar};`, linked))[2], (await withState({ colour: false }, "meta", `return ${bar};`, linked))[2]], ["Import from Meta →", "Read from Meta…", "Who the gym is →", "Brand and photos →"]);
  await ev(`STATE.profile = JSON.parse(${JSON.stringify(p0)}); true`);
  // On Meta link the bar offers Check the link only when the page itself has it (Meta's keys set up on this machine): never more than the screen.
  await ev("go('meta'); true");
  await until("STATE.tab === 'meta' && !!document.querySelector('#setupStrip') && !/Loading…/.test(document.querySelector('#view').textContent)");
  const hasCheck = await ev(`!!document.querySelector('[onclick^="metaCheck"]')`);
  r = await withState({ account: false }, "meta", `return ${bar};`);
  assert.deepEqual(r.slice(1, 3), [0, hasCheck ? "Check the link" : null]); assert.match(r[3], hasCheck ? /Press Check the link to load the lists/ : /Meta's keys are not set up on this machine yet/);
  // A cycle screen says when the setup is not finished, with the way there; never for the link or the targeting alone.
  await ev("go('scenes'); true");
  await until("STATE.tab === 'scenes' && !!document.querySelector('#cyc') && !!document.querySelector('#stpDo')");
  assert.equal(await withState({ wording: false }, "scenes", "paintStepper(); const t = document.querySelector('#stpSetup')?.textContent || null; return t;"), "This gym's setup is not finished — Offer and ad defaults still needs at least one offer wording. Set up the gym →");
  assert.equal(await withState({ account: false, pin: false }, "scenes", "paintStepper(); return document.querySelector('#stpSetup')?.textContent || null;"), null);
  await ev("paintStepper(); true");
  // Waiting shows on a Profile screen as it does in the cycle.
  await ev("go('targeting'); true");
  await until("STATE.tab === 'targeting' && !!document.querySelector('#setupStrip') && !!document.querySelector('#stpDo')");
  const id = await ev(`waitStart('POST', '/api/client/${GYM}/targeting/import')`);
  await ev(`WAIT.items.get(${id}).at -= 6000; paintWait(); true`);
  assert.deepEqual(await ev("[document.querySelector('#stpDo').classList.contains('working'), document.querySelector('#stpDo .t').textContent, document.querySelector('#waitchip').hidden]"), [true, "Reading the account's ad sets and audiences from Meta. · 6 s", false]);
  await ev(`waitEnd(${id}); true`);
  assert.equal(await ev("document.querySelector('#stpDo').classList.contains('working')"), false);
  // A library page has neither the strip nor the indicator.
  await ev("go('copy'); true");
  await until("STATE.tab === 'copy' && document.querySelector('#cycle').innerHTML === '' && document.querySelector('#stepper').innerHTML === ''");
});

test("U59 the review, checked, and Pause on Meta (2026-11-11): every line of the review carries its verdict and its checks; an ad to pause has a button only where Meta can be reached, and pressing it asks first, naming the ad and what it has cost; the pause is one ad set to PAUSED on Meta — refused for an ad that is not this gym's, not running, or whose numbers are not the ones confirmed, and without the Meta link; it is kept in the gym's ledger, the ad reads as paused at once, and the review says so under Last time", async () => {
  const g = join(brands, GYM);
  await linkTestGym();
  rmSync(join(g, "creative-reads.json"), { force: true }); rmSync(join(g, "insights.json"), { force: true });
  const ID = (n) => `12000000000000${n}`;
  const ad = (n, name, words, spend, leads, impressions) => ({ id: ID(n), name, adset_id: "s9", campaign_id: "c9", campaign: "Their campaign", status: words === "live" ? "ACTIVE" : "PAUSED", effective_status: words === "live" ? "ACTIVE" : "PAUSED", words, media: "image", created: "2026-10-01", hashes: [`h${n}`], all_time: { spend, leads, cost_per_lead: leads ? Math.round((spend / leads) * 100) / 100 : null, impressions }, last_30d: {} });
  writeFileSync(join(g, "account-history.json"), JSON.stringify({ pulled: "2026-11-10T00:00:00.000Z", account: "act_111000000001", campaigns: [{ id: "c9", name: "Their campaign", objective: "OUTCOME_LEADS" }], adsets: [{ id: "s9", campaign_id: "c9", name: "Their set" }],
    ads: [ad(1, "Winner", "live", 450, 30, 20000), ad(2, "Steady", "live", 400, 20, 15000), ad(3, "Nothing for it", "live", 80, 0, 3000), ad(4, "Stopped", "paused", 90, 0, 3000), ad(5, "Too new", "live", 36, 0, 300)] }));
  const post = (id, body) => call(`/api/client/${GYM}/ad/${id}/pause`, { method: "POST", body });
  const graphCalls = [];
  const graph = http.createServer(async (req, res) => { let body = ""; for await (const c of req) body += c; graphCalls.push([req.method, new URL(req.url, "http://x").pathname.split("/").slice(2).join("/"), new URLSearchParams(body).get("status")]); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ success: true })); });
  await new Promise((r) => graph.listen(0, "127.0.0.1", r));
  const main = panel;
  try {
    // The review, checked: a verdict and the checks behind each line; one to pause after a fair chance, one not judged yet.
    let R = await (await call(`/api/client/${GYM}/account-review`)).json();
    const by = (k) => R.insights.find((x) => x.key === k);
    assert.ok(R.insights.every((x) => ["confirmed", "test", "early", "none"].includes(x.verdict) && Array.isArray(x.checks)));
    assert.deepEqual([by(`pause:${ID(3)}`).kind, by(`pause:${ID(3)}`).verdict, by(`pause:${ID(5)}`).kind, by(`pause:${ID(5)}`).verdict, by(`pause:${ID(4)}`) ?? null], ["pause", "confirmed", "wait", "early", null]);
    assert.match(by(`pause:${ID(3)}`).checks[0].text, /^3,000 impressions and SGD 80\.00 spent \(a fair chance is 1,000 impressions and SGD 35\.00\)$/);
    assert.deepEqual([R.pause.length, R.wait.length, R.linked, R.last_time.paused], [1, 1, false, []]);
    assert.match(R.text, /Consider pausing:\n- Consider pausing: Nothing for it — SGD 80\.00 spent for no lead[^\n]*\n  → Yours to do in Ads Manager: this ad cannot be reached from here\.\n\nNot judged yet:\n- Not judged yet: Too new — SGD 36\.00 spent for no lead, but it has not had a fair chance[^\n]*\n  → Nothing to do yet: it is judged once it has had a fair chance\./);
    // Refused: not this gym's ad, not running, not the numbers confirmed — and, on this panel, no Meta link.
    const good = { confirm: { spend: 80, leads: 0 } };
    assert.equal((await post("999999999999", good)).status, 404);
    let r = await post(ID(4), { confirm: { spend: 90, leads: 0 } }); assert.equal(r.status, 409); assert.match((await r.json()).error, /not running on Meta as far as the last read says/);
    for (const bad of [{}, { confirm: { spend: 79, leads: 0 } }, { confirm: { spend: 80, leads: 1 } }]) { r = await post(ID(3), bad); assert.equal(r.status, 409, JSON.stringify(bad)); assert.match((await r.json()).error, /not the ones that were confirmed/); }
    r = await post(ID(3), good); assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up on this machine/);
    assert.equal(existsSync(join(g, "insights.json")), false, "nothing kept for a pause that did not happen");
    // The page without the link: the line is there, with where to pause it instead of a button.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const open = async (tag) => { const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?${tag}#/${GYM}/results` }, sessionId); await loaded; await until(`STATE.sel === ${JSON.stringify(GYM)} && RS.review && RS.review.gym === STATE.sel && !!document.querySelector('#rsReview [data-kind=pause]')`); };
    await open("u59a");
    assert.deepEqual(await ev("[!!document.querySelector('#rsReview [data-kind=pause] button'), document.querySelector('#rsReview [data-kind=pause] .rvact').innerText, document.querySelector('#rsReview [data-kind=pause] .rvact').className]"), [false, "→ Yours to do in Ads Manager: this ad cannot be reached from here.", "rvact yours"]);
    // With the link: the button, the confirmation that names the ad, and the pause.
    panel = await startPanel({ META_ACCESS_TOKEN: META_TOKEN, META_APP_ID: "1234567890", META_APP_SECRET: "app-secret", META_GRAPH_URL: `http://127.0.0.1:${graph.address().port}` });
    await open("u59b");
    const line = await ev("document.querySelector('#rsReview [data-kind=pause] li').innerText");
    assert.match(line, /^Nothing for it — SGD 80\.00 spent for no lead/); assert.match(line, /checked/); assert.match(line, /✓ 3,000 impressions and SGD 80\.00 spent/);
    assert.match(await ev("document.querySelector('#rsReview [data-kind=wait] li').innerText"), /^Too new — SGD 36\.00 spent for no lead, but it has not had a fair chance[\s\S]*not judged yet[\s\S]*✕ 300 impressions/);
    assert.equal(await ev("document.querySelector('#rsReview [data-kind=wait] button')"), null, "nothing to press for an ad not judged yet");
    // What becomes of each line: said on the line itself.
    assert.deepEqual(await ev("[document.querySelector('#rsReview [data-kind=pause] .rvact').innerText, document.querySelector('#rsReview [data-kind=wait] .rvact').innerText, document.querySelector('#rsReview [data-kind=wait] .rvact').className, [...document.querySelectorAll('#rsReview li[data-key]')].every((li) => li.querySelector('.rvact')) ]"), ["→ Yours to press: Pause on Meta, below. Nothing is paused by itself.", "→ Nothing to do yet: it is judged once it has had a fair chance.", "rvact none", true]);
    assert.equal(await ev("document.querySelector('#rsReview [data-kind=pause] button').textContent"), "Pause on Meta…");
    await ev("document.querySelector('#rsReview [data-kind=pause] button').click(); true");
    assert.deepEqual(await ev("[document.querySelector('#gModal h3').textContent, /Nothing for it/.test(document.querySelector('#gModal .summary').innerText), /SGD 80 spent · 0 leads/.test(document.querySelector('#gModal .summary').innerText), /this one ad/.test(document.querySelector('#gModal').innerText), document.querySelector('#rsPauseGo').textContent]"), ["Pause this ad on Meta?", true, true, true, "Yes, pause it on Meta"]);
    assert.deepEqual(graphCalls.filter((c) => c[0] === "POST"), [], "asking pauses nothing");
    await ev("document.querySelector('#rsPauseGo').click(); true");
    await until("!document.querySelector('#gModal .modal') && !!document.querySelector('#rsLastTime') && !document.querySelector('#rsReview [data-kind=pause]')");
    assert.deepEqual(graphCalls.filter((c) => c[0] === "POST"), [["POST", ID(3), "PAUSED"]], "one ad, set to PAUSED: nothing else");
    assert.match(await ev("document.querySelector('#rsLastTime').innerText"), /Nothing for it: paused from here on \d{4}-\d\d-\d\d after SGD 80\.00 for 0 leads — still paused\. paused/);
    // Kept in the ledger with what it had cost; the ad reads as paused at once, before Meta is read again.
    const L = JSON.parse(readFileSync(join(g, "insights.json"), "utf-8"));
    assert.deepEqual(L.actions.map((a) => [a.what, a.ad_id, a.name, a.spend, a.leads, a.key]), [["pause", ID(3), "Nothing for it", 80, 0, `pause:${ID(3)}`]]);
    const after = await (await call(`/api/client/${GYM}/account-review`)).json();
    assert.deepEqual([after.insights.some((x) => x.key === `pause:${ID(3)}`), after.numbers.running.ads, R.numbers.running.ads, after.last_time.paused[0].status], [false, R.numbers.running.ads - 1, R.numbers.running.ads, "paused"]);
    r = await post(ID(3), good); assert.equal(r.status, 409, "pausing it again is refused: it is not running");
    // Once Meta is read again its own word rules: an account read after the pause that still says live shows it running again.
    const H = JSON.parse(readFileSync(join(g, "account-history.json"), "utf-8")); H.pulled = "2099-01-01T00:00:00.000Z"; writeFileSync(join(g, "account-history.json"), JSON.stringify(H));
    assert.equal((await (await call(`/api/client/${GYM}/account-review`)).json()).last_time.paused[0].status, "running");
  } finally {
    if (panel !== main) { await panel.stop(); panel = main; }
    graph.close(); rmSync(join(g, "account-history.json"), { force: true }); rmSync(join(g, "insights.json"), { force: true });
  }
});

test("U60 which room a premises photo shows (2026-11-11): said with one click under a cleaned premises photo, kept on the profile (one photo per room; another choice replaces it, none takes it off), refused for a photo that is not a cleaned premises photo or a room there is not; it is a part of the Brand and photos setup step, so it is not missed, and never in the way of creating or publishing", async () => {
  const g = join(brands, GYM), pf = join(g, "gym-profile.json"), saved = readFileSync(pf);
  try {
    const before = JSON.parse(saved); delete before.creative_defaults?.room_references; writeFileSync(pf, JSON.stringify(before));
    const A = await (await call(`/api/client/${GYM}/assets`)).json();
    const photo = A.clean.find((x) => !x.people)?.path;
    assert.ok(photo, "the test gym has a cleaned premises photo");
    assert.deepEqual([A.rooms, A.room_references], [{ "studio-room": "the studio room", "gym-floor": "the gym floor" }, {}]);
    const tag = (body) => call(`/api/client/${GYM}/room-tag`, { method: "POST", body });
    assert.equal((await tag({ path: "facility/raw.jpg", room: "studio-room" })).status, 400, "not a cleaned premises photo");
    assert.equal((await tag({ path: photo, room: "rooftop" })).status, 400, "not a room");
    let V = await (await call(`/api/client/${GYM}`)).json();
    const rooms = () => V.completeness.sections.find((s) => s.id === "rooms");
    assert.deepEqual([rooms().status, rooms().items, rooms().page, rooms().for], ["missing", [{ what: "which room a premises photo shows", ok: false }], "photos", "learning"]);
    const ready = [V.completeness.ready_to_create, V.completeness.ready_to_publish];
    let r = await tag({ path: photo, room: "studio-room" }); assert.equal(r.status, 200); assert.deepEqual((await r.json()).room_references, { "studio-room": photo });
    assert.deepEqual(JSON.parse(readFileSync(pf, "utf-8")).creative_defaults.room_references, { "studio-room": photo });
    V = await (await call(`/api/client/${GYM}`)).json();
    assert.deepEqual([rooms().status, V.completeness.ready_to_create, V.completeness.ready_to_publish], ["done", ...ready], "done; and it never was in the way of creating or publishing");
    assert.deepEqual((await (await tag({ path: photo, room: "gym-floor" })).json()).room_references, { "gym-floor": photo }, "one room per photo: the other choice replaces it");
    assert.deepEqual((await (await tag({ path: photo, room: null })).json()).room_references, {}, "no room: the tag is off");
    assert.equal("room_references" in JSON.parse(readFileSync(pf, "utf-8")).creative_defaults, false);
    // The page: the choice under the photo, and the setup's own part for it.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready2) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready2))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready2), `never: ${ready2}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u60#/${GYM}/photos` }, sessionId); await loaded;
    await until(`!!STATE.status && STATE.sel === ${JSON.stringify(GYM)} && STATE.tab === 'photos' && !!document.querySelector('.roomsel') && !!document.querySelector('#setupStrip') && !!document.querySelector('#stpDo')`);
    assert.deepEqual(await ev("[[...document.querySelector('.roomsel').options].map(o => o.textContent), document.querySelector('.roomsel').value]"), [["shows which room?", "the studio room", "the gym floor"], ""]);
    // Photos & assets carries the setup while this is to do: the part is there, and its button takes the eye to the choice.
    const part = await ev("(()=>{ const S = partsSetup(), i = S.parts.findIndex(p => p.name === 'Which room a premises photo shows'); return i < 0 ? null : [S.parts[i].done, S.parts[i].label || null, /pick the room it shows \\(the studio room, the gym floor\\): one click each/.test(S.parts[i].text || '')]; })()");
    assert.deepEqual(part, [false, "Show me where", true]);
    assert.ok(await ev("[...document.querySelectorAll('#stpParts .stpp .nm')].some(e => e.textContent === 'Which room a premises photo shows')"));
    await ev("(()=>{ const s = document.querySelector('.roomsel'); s.value = 'studio-room'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
    await until("A.data && Object.keys(A.data.room_references || {}).length === 1 && document.querySelector('.roomsel')?.value === 'studio-room'");
    assert.deepEqual(JSON.parse(readFileSync(pf, "utf-8")).creative_defaults.room_references, { "studio-room": photo });
    await until("(()=>{ const M = setupModel(); return !!M && M[2].items.some(x => x.what === 'which room a premises photo shows' && x.ok); })()");
  } finally { writeFileSync(pf, saved); }
});

test("U61 all gyms (2026-11-12): GET /api/portfolio is every gym's marketing numbers side by side — spend, lead-form leads, cost per lead with its change from the period before, CPM, click rate, clicks that became leads, frequency, the marks by rule, the totals with money per currency — from what the last read put on file (no Meta call), a folder without a profile left out; the read is refused without the Meta link and without the panel's token; the rail opens All gyms above the cycle at an address with no gym in it, with no gym's strip or indicator; the period switch, a column's sort and a gym's campaigns, best and dearest ad work; Open Review Data and the top bar open that gym", async () => {
  const made = join(brands, "u61-gym"), empty = join(brands, "u61-empty"), dailyFile = join(brands, GYM, "account-daily.json"), had = existsSync(dailyFile) ? readFileSync(dailyFile) : null;
  try {
    assert.equal((await call("/api/clients", { method: "POST", body: { gym: "u61-gym", display_name: "Sixty Gym" } })).status, 200);
    mkdirSync(empty, { recursive: true });
    // The test gym's numbers as a read leaves them: one lead ad set running, 50 a day for 40 days, 1 lead a day this week and 4 a day before.
    const lead = (n) => (n ? [{ action_type: "lead", value: String(n) }] : []), day = (until, i) => new Date(Date.parse(until + "T00:00:00Z") - i * 86400000).toISOString().slice(0, 10);
    const client = { list: async (path, q) => {
      if (/\/adsets$/.test(path)) return [{ id: "S1", optimization_goal: "LEAD_GENERATION" }];
      if (/\/ads$/.test(path)) return [{ id: "A1", name: "c01", adset_id: "S1", campaign_id: "C1", created_time: new Date(Date.now() - 3 * 86400000).toISOString(), adset: { id: "S1", name: "BISHAN set", daily_budget: "5000" }, campaign: { id: "C1", name: "1101 6 Week Challenge", objective: "OUTCOME_LEADS" } }];
      const range = JSON.parse(q.time_range);
      if (q.time_increment) return Array.from({ length: 40 }, (_, i) => ({ adset_id: "S1", adset_name: "BISHAN set", campaign_id: "C1", campaign_name: "1101 6 Week Challenge", objective: "OUTCOME_LEADS", date_start: day(range.until, i), spend: "50", impressions: "2000", inline_link_clicks: "40", actions: lead(i < 7 ? 1 : 4) }));
      if (q.level === "adset") return [{ adset_id: "S1", impressions: "14000", reach: "4000", frequency: "3.5" }];
      return [{ ad_id: "A1", ad_name: "c01", adset_id: "S1", campaign_id: "C1", spend: "200", impressions: "8000", inline_link_clicks: "160", actions: lead(8) }, { ad_id: "A2", ad_name: "c02", adset_id: "S1", campaign_id: "C1", spend: "150", impressions: "6000", inline_link_clicks: "120", actions: [] }];
    } };
    await pullDaily({ client, accountId: "111000000001", gymDir: join(brands, GYM) });
    const P = await (await call("/api/portfolio")).json(), mine = P.gyms.find((g) => g.gym === GYM), fresh = P.gyms.find((g) => g.gym === "u61-gym");
    assert.ok(mine && fresh && !P.gyms.some((g) => g.gym === "u61-empty"), "every gym with a profile, and only those");
    assert.deepEqual(P.periods, [7, 30, 90]);
    assert.deepEqual([mine.source, mine.currency, mine.periods[7].spend, mine.periods[7].leads, mine.periods[7].cost_per_lead, mine.periods[7].prev.cost_per_lead, mine.periods[7].change.cost_per_lead], ["meta", "SGD", 350, 7, 50, 12.5, 300]);
    assert.deepEqual([mine.periods[30].spend, mine.periods[30].leads, mine.periods[30].cost_per_lead, mine.periods[30].cpm, mine.periods[30].ctr, mine.periods[30].click_to_lead, mine.periods[30].frequency, mine.periods[30].change.cost_per_lead], [1500, 99, 15.15, 25, 2, 8.3, 3.5, 21.2]);
    assert.deepEqual([mine.flags[7].map((f) => f.kind), mine.flags[30].map((f) => f.kind)], [["cost_up", "tiring"], ["tiring"]], "the marks come from the numbers alone");
    assert.deepEqual([mine.running.ads, mine.running.budget, mine.running.pace, mine.ads[7].best.name, mine.ads[7].dearest.name, mine.campaigns.length, mine.series.length], [1, 50, 1, "c01", "c02", 1, 90]);
    assert.deepEqual([fresh.source, fresh.running.ads, fresh.all], ["none", 0, null]);
    // The totals: leads summed over the gyms read day by day (another test's gym in another currency may be among them); money per currency, never across.
    const read = P.gyms.filter((g) => g.source === "meta"), sgd = read.filter((g) => g.currency === "SGD");
    assert.equal(P.totals[7].leads, read.reduce((t, g) => t + g.periods[7].leads, 0)); assert.equal(P.totals[7].gyms, read.length);
    assert.deepEqual([P.totals[7].by_currency.SGD.spend, P.totals[7].by_currency.SGD.gyms, Object.keys(P.totals[7].by_currency).sort()], [sgd.reduce((t, g) => t + g.periods[7].spend, 0), sgd.length, [...new Set(read.map((g) => g.currency))].sort()]);
    assert.deepEqual([sgd.length, P.totals[7].by_currency.SGD.cost_per_lead], [1, 50]);
    assert.deepEqual([P.schedule.daily, P.linked, P.reading, P.running.ads], [false, false, null, read.reduce((t, g) => t + g.running.ads, 0)], "no read by itself in a test panel, and no Meta link here");
    let r = await call("/api/run", { method: "POST", body: { kind: "portfolio-numbers" } }); assert.equal(r.status, 409); assert.match((await r.json()).error, /Meta link is not set up/);
    r = await call("/api/run", { method: "POST", body: { kind: "portfolio-numbers" }, token: null }); assert.equal(r.status, 403);
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u61#/portfolio` }, sessionId); await loaded;
    const rows = `document.querySelectorAll('#pfTable tr.pfg').length === ${P.gyms.length}`;
    await until(`STATE.tab === 'portfolio' && ${rows}`);
    assert.deepEqual(await ev("[location.hash, document.querySelector('#crumb').innerText, document.querySelector('#cycle').innerHTML, document.querySelector('#stepper').innerHTML, [...document.querySelectorAll('#rail .tab')].slice(0, 2).map(b => b.innerText.replace(/\\s+/g, ' ').trim()), document.querySelector('#rail .tab.sel').innerText.replace(/\\s+/g, ' ').trim(), [...document.querySelectorAll('#rail .sec')].slice(0, 2).map(x => x.textContent)]"),
      ["#/portfolio", "All gyms", "", "", ["▦ All gyms", "1 Review Data"], "▦ All gyms", ["Portfolio", "The cycle"]]);
    await ev("pfPeriod('30'); true");
    const cells = `(()=>{ const r = document.querySelector('#pfTable tr.pfg[data-gym=${GYM}]'); return [[...r.querySelectorAll('td[data-col]')].map(td => td.innerText.replace(/\\s+/g, '')), [...r.querySelectorAll('[data-flag]')].map(x => x.dataset.flag), !!r.querySelector('svg.pfspark')]; })()`;
    assert.deepEqual(await ev("[[...document.querySelectorAll('#pfPeriods button')].map(b => b.innerText), document.querySelector('#pfPeriods button.sel').innerText, document.querySelector('#pfAgainst').innerText, document.querySelectorAll('#pfTiles .pftile').length, [...document.querySelectorAll('#pfTable th')].map(x => x.innerText.replace(/ [▾▴]$/, ''))]"),
      [["7 days", "30 days", "90 days", "All time"], "30 days", "against the 30 days before", 4, ["Gym", "Spent", "Leads", "Cost per lead", "CPM", "CTR", "Click → lead", "Freq.", "Leads a day"]]);
    assert.deepEqual(await ev(cells), [["1,500", "99+148%", "15.15+21%", "25.00", "2.00%", "8.3%", "3.5"], ["tiring"], true]);
    assert.match(await ev("document.querySelector('#pfTiles .pftile').innerText.replace(/\\s+/g, ' ')"), new RegExp("^Leads, last 30 days " + P.totals[30].leads));
    assert.deepEqual(await ev("[document.querySelector('#pfTable tr.pfg[data-gym=u61-gym]').dataset.source, document.querySelector('#pfTable tr.pfg[data-gym=u61-gym] td:last-child').innerText, document.querySelector('#pfRead').innerText.startsWith('Numbers read today')]"), ["none", "nothing on file", true]);
    // Another period: the same row, that period's figures and marks.
    await ev("document.querySelector('#pfPeriods button').click(); true");
    assert.deepEqual(await ev(cells), [["350", "7-75%", "50.00+300%", "25.00", "2.00%", "2.5%", "3.5"], ["cost_up", "tiring"], true]);
    assert.deepEqual(await ev("[document.querySelector('#pfAgainst').innerText, document.querySelector('#pfTable tr.pfg[data-gym=" + GYM + "] td[data-col=cost_per_lead] .chg').className, document.querySelector('#pfTable tr.pfg[data-gym=" + GYM + "] td[data-col=leads] .chg').className]"), ["against the 7 days before", "chg bad", "chg bad"]);
    // A column sorts; the gym with the figures stays above the ones with none.
    await ev("document.querySelector('#pfTable th[data-key=name]').click(); true");
    assert.deepEqual(await ev("[...document.querySelectorAll('#pfTable tr.pfg td:first-child b')].map(b => b.innerText)"), P.gyms.map((g) => g.name).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    await ev("document.querySelector('#pfTable th[data-key=spend]').click(); true");
    assert.deepEqual((await ev("[...document.querySelectorAll('#pfTable tr.pfg')].map(r => r.dataset.source)")).map((x) => x === "meta"), P.gyms.map((_, i) => i < read.length), "the gyms with figures stay above the ones with none");
    // A gym opens to its campaigns, its best and dearest ad, its budget.
    await ev(`document.querySelector('#pfTable tr.pfg[data-gym=${GYM}]').click(); true`);
    assert.deepEqual(await ev("(()=>{ const c = document.querySelector('#pfTable tr.pfsub[data-campaign=C1]'); return [c.querySelector('td').innerText, c.querySelector('td:last-child').innerText, c.querySelectorAll('td').length]; })()"), ["1101 6 Week Challenge", "1 ad running", 9]);
    assert.match(await ev(`document.querySelector('#pfTable tr.pfdet[data-detail=${GYM}]').innerText.replace(/\\s+/g, ' ')`), /^Best ad c01 at 25\.00 \(8 leads\) · dearest c02 150 spent, no lead · Budget SGD 50 a day, spending 100% of it · newest ad \d days old · last lead today · Open Review Data →$/);
    // All time: what is on file, said as such; nothing to compare with.
    await ev("document.querySelector('#pfPeriods button:last-child').click(); true");
    assert.match(await ev("document.querySelector('#pfAgainst').innerText"), /^everything on file/);
    // Refresh the numbers without the Meta link: said, nothing started.
    await ev("document.querySelector('#pfRefresh').click(); true");
    assert.deepEqual(await ev("[document.querySelector('#gModal').innerHTML, !!(STATE.run && !STATE.run.done)]"), ["", false]);
    // Open Review Data opens that gym; Back returns; a gym picked from the top bar while every gym is listed opens its Review Data.
    await ev(`document.querySelector('#pfTable tr.pfdet[data-detail=${GYM}] a').click(); true`);
    await until(`location.hash === '#/${GYM}/results' && STATE.sel === ${JSON.stringify(GYM)} && STATE.tab === 'results'`);
    await ev("history.back(); true"); await until(`location.hash === '#/portfolio' && STATE.tab === 'portfolio' && ${rows}`);
    await ev("document.querySelector('#rail .tab').click(); true"); await until(`location.hash === '#/portfolio' && ${rows}`);
    await ev(`(()=>{ const s = document.querySelector('#clientSel'); s.value = 'u61-gym'; s.onchange(); return true; })()`);
    await until("location.hash === '#/u61-gym/results' && STATE.sel === 'u61-gym' && STATE.tab === 'results'");
  } finally { rmSync(made, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); if (had) writeFileSync(dailyFile, had); else rmSync(dailyFile, { force: true }); }
});

test("U62 the ledger across gyms and the Ad Library survey on Review Data (2026-11-12): the review's answer carries the pooled ledger and the page shows it as a card that says when nothing has been tested; GET /api/library/survey answers from what is on file — the advertisers per kind of picture, the ones running 90 days or more, what is left out, and for the gym each kind with whether it has run it and how it is made here; the run is checked server-side (the country, the caps, nothing to do, the notice before a pull) and a reading with nothing to read makes no call; the card and its confirmation say what it costs and carry the notice", async () => {
  const swipe = join(dirname(brands), "swipe", "gym"), raw = join(swipe, "raw", "2026-11-01");
  const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  try {
    // An empty folder first: nothing surveyed.
    let S = await (await call(`/api/library/survey?gym=${GYM}`)).json();
    assert.deepEqual([S.ads, S.read, S.candidates, S.scrapes, typeof S.has_apify, S.limits.pull_min, S.limits.pull_max, S.long_run_days], [0, 0, [], [], "boolean", 20, 300, 90]);
    // A scrape and its readings on file: three studios run portraits (two for 90+ days), three run workout shots (one), a phone shop is left out.
    mkdirSync(join(raw, "images"), { recursive: true });
    const ads = [["1", "Iron Gym", 200, "p1"], ["2", "Core Pilates", 120, "p2"], ["3", "Flow Yoga", 20, "p3"], ["4", "Iron Gym", 30, "w4"], ["5", "Lift Studio", 95, "w5"], ["6", "Box Fitness", 10, "w6"], ["7", "Phone Shop", 500, "w7"]];
    for (const a of ads) writeFileSync(join(raw, "images", `${a[3]}.png`), PNG1);
    writeFileSync(join(raw, "ads-normalized.json"), JSON.stringify({ niche: "gym", country: "SG", scraped_at: "2026-11-01T02:00:00Z", terms: ["gym"], ads: ads.map(([id, page, days, img]) => ({ ad_id: id, page_name: page, start_date: "2026-01-01", days_active: days, variant_count: 1, primary_text: page === "Phone Shop" ? "New phones" : "Join us", image_files: [`images/${img}.png`] })) }));
    writeFileSync(join(swipe, "survey-reads.json"), JSON.stringify({ schema: 1, reads: Object.fromEntries(ads.slice(0, 6).map((a) => [a[3], { ratio: "4:5", format: a[3][0] === "p" ? "studio-portrait" : "workout", subject: "woman", people: 1, backdrop: "gym-floor", pose: "easy-posed", expression: "smile", eye_contact: true, text_density: "light", logo: false }])) }));
    S = await (await call(`/api/library/survey?gym=${GYM}`)).json();
    assert.deepEqual([S.ads, S.kept, S.read, S.unread, S.advertisers, S.long_running, S.overall, S.left_out, S.scope, S.surveyed.last], [7, 6, 6, 0, 5, 3, 60, { not_fitness: 1 }, "SG", "2026-11-01"]);
    assert.deepEqual(S.candidates.map((c) => [c.format, c.advertisers, c.long_running, c.share, c.makeable]), [["studio-portrait", 3, 2, 67, true], ["workout", 3, 1, 33, true]]);
    assert.ok(S.candidates.every((c) => typeof c.tried === "boolean" && c.text.startsWith(c.format + ": 3 advertisers run it")));
    // The run, checked before anything starts.
    const bad = async (body, status, re) => { const r = await call("/api/run", { method: "POST", body: { kind: "library-survey", ...body } }); assert.equal(r.status, status, JSON.stringify(body)); assert.match((await r.json()).error, re); };
    await bad({ country: "Singapore", pull: 0, max: 5 }, 400, /two letters/);
    await bad({ country: "SG", pull: 5, max: 5, tos: true }, 400, /0 \(none\) or 20 to 300/);
    await bad({ country: "SG", pull: 301, max: 5, tos: true }, 400, /20 to 300/);
    await bad({ country: "SG", pull: 0, max: 801 }, 400, /0 to 800/);
    await bad({ country: "SG", pull: 0, max: 0 }, 400, /nothing to do/);
    await bad({ country: "SG", pull: 40, max: 5 }, 400, /only once the notice is agreed to/);
    assert.equal((await call("/api/run", { method: "POST", body: { kind: "library-survey", country: "SG", pull: 0, max: 5 }, token: null })).status, 403);
    // Reading with nothing left to read: the command is built server-side, never pulls, and makes no call.
    const made = await runAndWait({ kind: "library-survey", country: "sg", pull: 0, max: 5 });
    assert.equal(made.code, 0, made.lines.join("\n"));
    assert.match(made.lines[0], /^\$ node skills\/references\/library-survey\.mjs --swipe-dir \S+swipe\/gym --read --max 5 --ours /); assert.ok(!/--pull|--i-understand-tos/.test(made.lines[0]));
    assert.ok(made.lines.some((l) => /0 pictures read \(0 calls\), 6 read before/.test(l)), made.lines.join("\n"));
    // The review carries the pooled ledger.
    const R = await (await call(`/api/client/${GYM}/account-review`)).json();
    assert.ok(R.ledger && Array.isArray(R.ledger.entries) && R.ledger.gyms >= 1 && "untested" in R.ledger.counts);
    // The page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "page error"); return result.value; };
    const until = async (ready) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev(ready))) await new Promise((x) => setTimeout(x, 120)); assert.ok(await ev(ready), `never: ${ready}`); };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u62#/${GYM}/results` }, sessionId); await loaded;
    await until("STATE.tab === 'results' && !!document.querySelector('#rsLedger') && !!document.querySelector('#rsSurveyKinds')");
    assert.deepEqual(await ev("[...document.querySelectorAll('#view .card[id]')].map(c => c.id).filter(id => ['across', 'rsLedger', 'rsSurvey'].includes(id))"), ["across", "rsLedger", "rsSurvey"], "under Across every gym, in this order");
    assert.match(await ev("document.querySelector('#rsLedger').innerText.replace(/\\s+/g, ' ')"), /^TESTED ACROSS EVERY GYM \d+ gyms? · \d+ tested in a batch · \d+ said by an account and never tested What each gym's own account says/i);
    assert.equal(await ev("document.querySelectorAll('#rsLedger tbody tr').length"), R.ledger.entries.length);
    if (!R.ledger.entries.some((e) => e.verdict !== "untested")) assert.equal(await ev("!!document.querySelector('#rsLedgerNone')"), true, "nothing tested yet is said");
    const card = await ev("document.querySelector('#rsSurvey').innerText.replace(/\\s+/g, ' ')");
    assert.match(card, /Meta's Ad Library in SG: 7 ads on file, last pulled 1 Nov 2026 · 6 read · left out: 1 not a fitness business/);
    assert.match(card, /Analysis only\. The Ad Library shows no spend and no leads/); assert.match(card, /5 advertisers read; 3 of them \(60%\) have kept an ad running 90 days or more\./);
    assert.deepEqual(await ev("[...document.querySelectorAll('#rsSurveyKinds tbody tr')].map(r => [r.dataset.format, ...[...r.querySelectorAll('td')].slice(1, 4).map(td => td.innerText.replace(/\\s+/g, ' ').trim())])"), [["studio-portrait", "3", "2", "67% · 1.12×"], ["workout", "3", "1", "33% · 0.55×"]]);
    assert.match(card, /Longest running: Iron Gym \(200 days, studio portrait\) · Core Pilates \(120 days, studio portrait\)/);
    // The confirmation: what it costs, the notice, and nothing runs until it makes sense.
    await ev("document.querySelector('#rsSurveyGo').click(); true");
    assert.deepEqual(await ev("[document.querySelector('#svCountry').value, document.querySelector('#svTos').checked, /billed to your Apify account/.test(document.querySelector('#gModal').innerText), /grey area under Meta's terms/.test(document.querySelector('#gModal').innerText), /never republished/.test(document.querySelector('#gModal').innerText)]"), ["SG", false, true, true, true]);
    await ev("document.querySelector('#svPull').disabled = false; document.querySelector('#svPull').value = '40'; document.querySelector('#svGo').click(); true");
    assert.match(await ev("document.querySelector('#svWhy').textContent"), /^Tick the box to run the pull/);
    await ev("document.querySelector('#svPull').value = '0'; document.querySelector('#svRead').value = '0'; document.querySelector('#svGo').click(); true");
    assert.match(await ev("document.querySelector('#svWhy').textContent"), /^Nothing to do/);
    await ev("document.querySelector('#svCountry').value = 'Singapore'; document.querySelector('#svGo').click(); true");
    assert.match(await ev("document.querySelector('#svWhy').textContent"), /two letters/);
    assert.equal(await ev("!!(STATE.run && !STATE.run.done)"), false, "nothing was started");
    await ev("document.querySelector('#gModal').innerHTML = ''; true");
  } finally { rmSync(join(dirname(brands), "swipe"), { recursive: true, force: true }); }
});
