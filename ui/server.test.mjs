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
      cwd: ROOT, env: { ...process.env, PANEL_BRANDS_DIR: brands, COPY_LIBRARY_DIR: join(dirname(brands), "library"), NODE_OPTIONS: `--import=${stub}`, META_ACCESS_TOKEN: "", META_APP_ID: "", META_APP_SECRET: "", META_GRAPH_URL: "", ...env },
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
  assert.ok(draft.errors.some((e) => /no approved scenes yet: approve some on Library → Scenes/.test(e)), draft.errors.join("; "));
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
  assert.deepEqual(ok.summary, { photos: 3, generated: 1, real: 2, looks: 2, locations: 2, ads: 12, max_calls: 2, scenes_for: "men" });
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
  // 10 new photos by default (the real batches' size) + 2 real, 2 looks, 1 location.
  await until(`/= <b>24 ads<\\/b>/.test(document.querySelector('#bSummary').innerHTML) && !document.querySelector('#bRun').disabled`, "the summary and an enabled Run");
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
    assert.ok(check.errors.some((e) => /no scene library yet: .*Draft the first ones on Library → Scenes/.test(e)), check.errors.join("; "));
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
  assert.deepEqual(s[a1.folder], { "1x1": a1.file, "9x16": storyOf[a1.folder] }, "each kept ad names its square and Stories files");
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

test("U11 the review screen: 1:1 and 9:16 side by side on one screen; arrows move; K/X/U keep, exclude, undo — saved as made; photos exclude their ads; Back works; the Generating screen shows each photo as it passes", async () => {
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
  assert.ok(geo.b[0] > geo.a[1], "the 9:16 sits to the right of the 1:1");
  assert.ok(Math.abs(geo.a[4] - geo.b[4]) < 2 && Math.abs(geo.a[3] - geo.a[4]) < 2 && Math.abs(geo.b[3] / geo.b[4] - 9 / 16) < 0.02, `same height, square and 9:16: ${JSON.stringify(geo)}`);
  assert.ok(geo.a[4] > 400, "big enough to judge");
  assert.ok(geo.foot <= geo.h && geo.sh <= geo.h + 1, `everything on one screen: ${JSON.stringify(geo)}`);
  assert.ok(geo.sw <= geo.w, "no sideways scrolling");
  assert.match(await ev("document.querySelector('#rvCount').textContent"), new RegExp(`^1 of ${batch.ads.length}`));
  // Arrows move; X excludes and moves on; the decision is on disk at once.
  await key("ArrowRight", "ArrowRight", 39);
  await until("R.i===1", "→");
  const f1 = await ev("R.list[1].folder");
  await key("x", "KeyX", 88);
  await until(`R.i===2 && document.querySelector('#rvStrip').children[1].classList.contains('s-exclude')`, "exclude and advance");
  const t0 = Date.now(); while (!sel().excluded.includes(f1) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sel().excluded, [f1], "selections.json on disk, no download");
  assert.match(await ev("document.querySelector('#rvCount').textContent"), / 1 excluded/);
  // Back to it and undo.
  await key("ArrowLeft", "ArrowLeft", 37);
  await until("R.i===1 && document.querySelector('.rv-badge').textContent.includes('Excluded')", "←");
  await key("u", "KeyU", 85);
  await until("!document.querySelector('#rvStrip').children[1].classList.contains('s-exclude')", "undo");
  const t1 = Date.now(); while (sel().excluded.length && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sel().excluded, []);
  // K keeps: marked, saved, moved on.
  await key("k", "KeyK", 75);
  await until("R.i===2 && document.querySelector('#rvStrip').children[1].classList.contains('s-keep')", "keep");
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
  assert.deepEqual(setup.creative_defaults.audiences, ["GUYS OF BISHAN", "MEN WANTED"], "the Create screen gets the defaults");
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

// ── U13 the profile pages and the Create screen's defaults ───────────────────

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
  await until("document.querySelectorAll('.ovc').length===8", "the eight sections");
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
  await until("STATE.sel==='third-gym' && STATE.tab==='overview' && document.querySelectorAll('.ovc').length===8", "the new gym's overview");
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
    if (/^ca\d+$/.test(path)) return ok({ id: path, name: "Test campaign", status: "PAUSED", effective_status: "PAUSED" });
    if (/^ca\d+\/adsets$/.test(path)) return ok({ data: [{ id: made.adsets, name: "set", status: "PAUSED", effective_status: "PAUSED", daily_budget: "5000" }] });
    if (/^ca\d+\/ads$/.test(path)) return ok({ data: [{ id: made.ads, name: "one", status: "PAUSED", effective_status: "PAUSED", adset_id: made.adsets }] });
    if (/^ca\d+\/insights$/.test(path)) return ok({ data: u.searchParams.get("level") === "ad" ? [{ ad_id: made.ads, adset_id: made.adsets, spend: "12.5", impressions: "800", inline_link_clicks: "20", clicks: "22", reach: "700", actions: [{ action_type: "lead", value: "2" }], date_start: "2026-09-17", date_stop: "2026-09-18" }] : [] });
    if (path === "act_111000000001/campaigns" && req.method === "GET") return ok({ data: [{ id: "cx1", name: "0331 Their campaign", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS", created_time: "2026-03-31T10:00:00+0800" }] });
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
    if (path === "770000000007/leadgen_forms") return ok({ data: [{ id: "400100000001", name: "12 Week Reset form", status: "ACTIVE", leads_count: 3 }] });
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
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}`, calls })));
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
    await ev(`setCalloutPreset('MEN WANTED', '${dads.id}'); setCalloutPreset('LADIES WANTED', 'suggest'); document.querySelector('#saveBtn_profile').click(); true`);
    await until("DIRTY.profile===false", "saved");
    const saved = JSON.parse(readFileSync(join(brands, GYM, "gym-profile.json"), "utf-8"));
    assert.deepEqual(saved.targeting_defaults.detailed_targeting.callout_presets, { "MEN WANTED": dads.id }, "'suggest' is the default and is not written");
    const bad = structuredClone(saved); bad.targeting_defaults.detailed_targeting.callout_presets = { "MEN WANTED": "nope" };
    assert.equal((await call(`/api/client/${GYM}`, { method: "PUT", body: bad })).status, 400);
    await ev("presetNew(); document.querySelector('#npq').value='yoga'; true"); await ev("npSearch()");
    await until("NP.results.length===2", "search results in the modal");
    await ev("npAdd(0,0); npAdd(1,1); true"); await ev("npEstimate()");
    await until("NP.estimate && NP.estimate.reach", "the estimate");
    assert.match(await ev("document.querySelector('#gModal').textContent"), /Reach about 12,000–14,100 people a month/);
  } finally { await panel.stop(); panel = main; graph.server.close(); }
});


/** The test gym linked to Meta with pins, ages, a budget and two presets — what the Publish screen needs. */
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

test("U20 the Publish screen: the plan for a batch's kept ads from the API (nothing created), the owner's settings saved per batch and the plan rebuilt from them, bad settings refused; the page shows the campaign, one ad set card per callout with its pin, ages, gender, preset and budget, the ads with their Stories versions, the words and the destination; a change saves and repaints; Review links to it", async () => {
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
  for (const body of [{ campaign: { level: "ad" } }, { words: { headline: "one — dash" } }, { adsets: { X: { pin: "a" } } }, { destination: { lead_form_id: "abc" } }, { extra: 1 }]) {
    const bad = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/publish`, { method: "PUT", body });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal(JSON.parse(readFileSync(join(out, "publish-settings.json"), "utf-8")).campaign.name, "Test campaign", "a refused save writes nothing");
  assert.equal((await call(`/api/client/${GYM}/batch/no-such/publish`)).status, 404);
  // The page.
  await open(`${panel.url}/?u20#/${GYM}/publish/${BRIEF.batch_id}`);
  await until("PB.data && /Create on Facebook/.test(document.querySelector('#view')?.textContent||'')", "the Publish screen");
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
  await until("R.data && [...document.querySelectorAll('#rvFoot button')].some(b=>/Publish to Meta/.test(b.textContent))", "the Publish button on Review");
  await ev("[...document.querySelectorAll('#rvFoot button')].find(b=>/Publish to Meta/.test(b.textContent)).click(); true");
  await until("location.hash==='#/" + GYM + "/publish/" + BRIEF.batch_id + "'", "the Publish route");
});

test("U21 creating on Facebook from the panel: refused without the Meta link, without a confirmation, or with one that no longer matches the plan; with them the publish run is built from the gym and batch alone (plus 'first'), creates the plan against the Graph — every object paused — and records it; the Publish screen shows what is on Facebook and offers to continue", async () => {
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

test("U22 results: a batch on Meta can be pulled from the panel (statuses and numbers into results.json, the gym's CSV rebuilt), its rows tie each ad to what it was; a batch not on Meta says so; the gym's table and CSV list every published ad; the Results page shows the campaigns and the sortable table; the campaign cards say what is on Facebook", async () => {
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
    // The Results page.
    const { cdp, sessionId } = browser;
    const ev = async (expression) => { const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text); return result.value; };
    const loaded = cdp.once("Page.loadEventFired", sessionId); await cdp.send("Page.navigate", { url: `${panel.url}/?u22#/${GYM}/results` }, sessionId); await loaded;
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await ev("!!RS.data && RS.level==='campaigns' && document.querySelectorAll('table.tbl tbody tr').length===1"))) await new Promise((x) => setTimeout(x, 120));
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

test("U23 the account's history in the panel: pulled from Meta into the gym folder (their ads, not the app's), listed on Results with Meta's numbers, and chosen ads brought into the library — images into References (a video's poster frame too), words into the copy references; refused without the link or with bad ids; the CSV carries both sources", async () => {
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

test("U24 copy in the panel: the gym's copy references (list, add, note, retire) and a campaign's copy (the owner's own checked by the rules and kept at once; keep / exclude / edit; the number of text options saved per batch); the plan carries the kept copies as text options; the Publish screen's Copy card and the Library's Copy page show them", async () => {
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
  await open(`${panel.url}/?u24#/${GYM}/publish/${BRIEF.batch_id}`, "!!PB.data && /Copy/.test(document.querySelector('#view')?.textContent||'') && document.querySelector('#cpN')", "the Publish screen");
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

test("U25 the kept ads as a zip for Ads Manager: every kept ad's images by ad set, the list and the instructions; refused for a batch that is not finished or a bad name; the Publish screen's button", async () => {
  const res = await call(`/api/client/${GYM}/batch/${BRIEF.batch_id}/images.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${BRIEF.batch_id}-images.zip"`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "a zip");
  const text = buf.toString("latin1");
  assert.ok(text.includes("ads.csv") && text.includes("README.txt"), "the list and the instructions");
  assert.ok(/Bishan\/[^\/]+_1x1\.png/.test(text) && !/_v1\.png/.test(text), "one folder per ad set; names that pair (no _v1)");
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

test("U32 filled in for the owner: saving a profile places a pin that has a postal code and no point (the gym's own location first, then the map), and says what could not be placed; the Publish screen reads the Singapore identity from the ad account's own ad sets — one is saved, several are offered and only one of them can be chosen, none is said with what to do", async () => {
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
    // The identity: missing from the profile, read from the account's ad sets when the Publish screen opens.
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
