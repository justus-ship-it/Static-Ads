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
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { launchBrowser } from "../skills/references/render-composites.mjs";
import { cropImage } from "../skills/references/clean-photo.mjs";
import { validateBrief, runBatch, MAX_CALLS_CAP } from "../skills/references/plan-offer-batch.mjs";
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
      cwd: ROOT, env: { ...process.env, PANEL_BRANDS_DIR: brands, NODE_OPTIONS: `--import=${stub}`, ...env },
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
  assert.ok(draft.errors.some((e) => /not approved yet/.test(e)));
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
  assert.ok(await ev(`[...document.querySelectorAll('.tab')].some(t=>t.textContent==='Templates (old)')`), "the old tab is kept, relabelled");
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
  await until(`/= <b>8 ads<\\/b>/.test(document.querySelector('#bSummary').innerHTML) && !document.querySelector('#bRun').disabled`, "the summary and an enabled Run");
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
  assert.match(modal, /Up to 4 Gemini image calls/, "2 new photos × 2 tries, the default");
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
  await until(`!!document.querySelector('#bDirWords') && !!document.querySelector('#bSceneCard h3')`, "the form and the scene card");
  assert.equal(await ev(`'direction' in briefFromDraft()`), false, "no direction unless given");
  const type = (sel, text) => ev(`(()=>{const el=document.querySelector('${sel}'); el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await type("#bDirWords", "older women lunging with a coach");
  assert.deepEqual(await ev(`briefFromDraft().direction`), { words: "older women lunging with a coach" });
  assert.ok(await ev(`!!document.querySelector('input[name="bRef"][value="ad.png"]')`), "the uploaded reference is offered");
  await ev(`bRef('ad.png'); true`);
  assert.deepEqual(await ev(`briefFromDraft().direction`), { words: "older women lunging with a coach", reference: "ad.png" });
  const card = await ev(`document.querySelector('#bSceneCard').textContent`);
  assert.match(card, /Scene library/); assert.match(card, /1 retired/);
  await type("#bAud", "LADIES WANTED");
  await until(`B.check?.summary?.scenes_for==='women'`, "the check to follow the audience");
  await ev(`bRefreshConfirm(); true`);
  await until(`!!document.querySelector('.modal')`, "the refresh dialog");
  const modal = await ev(`document.querySelector('.modal').textContent`);
  assert.match(modal, /Refresh scenes/); assert.match(modal, /Fill the library's gaps/); assert.match(modal, /Like a reference image/);
  assert.equal(await ev(`document.querySelector('#bRfAud').value`), "women", "the audience follows the batch's callout");
  assert.equal(await ev(`document.querySelector('#bRfRef').value`), "ad.png");
  await ev(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Cancel').click(); true`);
  assert.equal(await ev(`!!document.querySelector('.modal')`), false);
});
