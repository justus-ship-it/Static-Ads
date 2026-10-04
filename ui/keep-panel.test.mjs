/**
 * Tests for the panel's keeper (ui/keep-panel.mjs), with a stand-in for the panel.
 *
 *   node --test ui/keep-panel.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const KEEPER = join(resolve(dirname(fileURLToPath(import.meta.url))), "keep-panel.mjs");
const freePort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 100)); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Start the keeper over a stand-in script; collects its output. */
function keep(script, port, env = {}) {
  const child = spawn(process.execPath, [KEEPER, "--port", String(port)], { env: { ...process.env, KEEP_PANEL_SERVER: script, ...env } });
  const k = { child, out: "", exit: new Promise((res) => child.on("exit", (code) => res(code))) };
  child.stdout.on("data", (d) => { k.out += d; }); child.stderr.on("data", (d) => { k.out += d; });
  return k;
}

test("K1 the panel is started, started again when it ends (a crash, or a kill that loads new code), and stopped with the keeper", async () => {
  const d = mkdtempSync(join(tmpdir(), "keeper-")), port = await freePort();
  // The stand-in: listens on the port, writes its pid, and says it is up, as the panel does.
  const script = join(d, "panel.mjs");
  writeFileSync(script, `import http from "http"; import { writeFileSync, appendFileSync } from "fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
appendFileSync(${JSON.stringify(join(d, "starts.txt"))}, process.pid + "\\n");
http.createServer((q, s) => s.end("ok")).listen(port, "127.0.0.1", () => console.log("Gym Ads control panel → http://localhost:" + port));
process.on("SIGTERM", () => process.exit(0));`);
  const starts = () => (existsSync(join(d, "starts.txt")) ? readFileSync(join(d, "starts.txt"), "utf8").trim().split("\n").map(Number) : []);
  const k = keep(script, port);
  try {
    assert.ok(await until(() => /control panel → http:\/\/localhost/.test(k.out)), k.out);
    const first = starts()[0];
    assert.match(k.out, new RegExp(`panel started \\(process ${first}\\) → http://localhost:${port}   ·   to load new code: kill ${first}`));
    // A deliberate kill (how new code is loaded): a new panel, on the same port.
    process.kill(first, "SIGTERM");
    assert.ok(await until(() => starts().length === 2), "started again");
    assert.match(k.out, /the panel exited with code 0 after \d+ s; starting it again/);
    const second = starts()[1];
    assert.ok(await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }), "the new one answers");
    // A crash: the same.
    process.kill(second, "SIGKILL");
    assert.ok(await until(() => starts().length === 3));
    assert.match(k.out, /the panel ended by SIGKILL/);
    // Stopping the keeper stops the panel too.
    const third = starts()[2];
    k.child.kill("SIGINT");
    assert.equal(await k.exit, 0);
    assert.ok(await until(() => !alive(third)), "no panel left behind");
    assert.match(k.out, /stopping the panel…[^]*stopped/);
    assert.equal(starts().length, 3, "nothing is started after the stop");
  } finally { try { k.child.kill("SIGKILL"); } catch {} for (const p of starts()) { try { process.kill(p, "SIGKILL"); } catch {} } rmSync(d, { recursive: true, force: true }); }
});

test("K2 a panel that keeps ending at once is not started for ever; a port that already answers is left to whoever has it", async () => {
  const d = mkdtempSync(join(tmpdir(), "keeper-")), port = await freePort();
  const bad = join(d, "bad.mjs");
  writeFileSync(bad, `import { appendFileSync } from "fs"; appendFileSync(${JSON.stringify(join(d, "tries.txt"))}, "x"); console.error("Error: something is wrong with the panel"); process.exit(1);`);
  try {
    const k = keep(bad, port, { KEEP_PANEL_QUICK_MS: "10000" });
    assert.equal(await k.exit, 1);
    assert.equal(readFileSync(join(d, "tries.txt"), "utf8").length, 5, "five tries, then it gives up");
    assert.match(k.out, /something is wrong with the panel/);
    assert.match(k.out, /within 10 s of starting, 5 times in a row: not started again\. The reason is in its last lines above\./);
    // Somebody else has the port (the Claude app's own panel): nothing is started.
    const other = http.createServer((q, s) => s.end("ok")); await new Promise((r) => other.listen(port, "127.0.0.1", r));
    try {
      rmSync(join(d, "tries.txt"));
      const k2 = keep(bad, port);
      assert.equal(await k2.exit, 0);
      assert.match(k2.out, new RegExp(`something already answers on http://localhost:${port}: a panel is running elsewhere`));
      assert.ok(!existsSync(join(d, "tries.txt")), "the panel was never started");
    } finally { other.close(); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
