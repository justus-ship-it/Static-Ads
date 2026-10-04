#!/usr/bin/env node
/**
 * keep-panel.mjs — the panel, kept running on its own.
 *
 *   node ui/keep-panel.mjs [--port 4310] [--open]        (or: npm run panel, or double-click "Start Panel.command")
 *
 * Started from the Claude app's Browser pane the panel is stopped whenever that pane closes (five times in one
 * week, 2026-10). Run from Terminal with this script it stays up: the panel is started, and started again
 * whenever it ends — a crash, or a deliberate `kill` of the panel's process, which is how a new version of the
 * code is loaded (the keeper prints that process id). Ctrl+C here stops both.
 *
 * - If the port already answers, a panel is running somewhere else (the Claude app, another Terminal): nothing
 *   is started, the address is said, and with --open the browser is opened on it.
 * - A panel that ends within 10 s of starting, five times in a row, is not started a sixth time: the reason is
 *   in its last lines above.
 * - Batches the panel started keep running through a restart (each is its own process group); the Generating
 *   screen finds them again and can stop them.
 *
 * `KEEP_PANEL_SERVER` names another script to keep (the tests' stand-in).
 */

import { spawn } from "child_process";
import { connect } from "net";
import { parseArgs } from "util";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: argv } = parseArgs({ options: { port: { type: "string", default: "4310" }, open: { type: "boolean", default: false } } });
const PORT = parseInt(argv.port, 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { console.error("--port must be a port number"); process.exit(2); }
const SERVER = process.env.KEEP_PANEL_SERVER || join(ROOT, "ui", "server.mjs");
const URL_ = `http://localhost:${PORT}`;
const QUICK_MS = Number(process.env.KEEP_PANEL_QUICK_MS) || 10000, MAX_QUICK = 5;

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (line) => console.log(`[keeper ${stamp()}] ${line}`);
const portAnswers = () => new Promise((res) => { const s = connect({ port: PORT, host: "127.0.0.1" }); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); s.setTimeout(1500, () => { s.destroy(); res(false); }); });
const openBrowser = () => { if (process.platform === "darwin") spawn("open", [URL_], { stdio: "ignore", detached: true }).unref(); else say(`open ${URL_} in your browser`); };

let child = null, stopping = false, quick = 0, opened = false;

function start() {
  const began = Date.now();
  child = spawn(process.execPath, [SERVER, "--port", String(PORT)], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  say(`panel started (process ${child.pid}) → ${URL_}   ·   to load new code: kill ${child.pid}   ·   to stop: Ctrl+C`);
  child.stdout.on("data", (d) => {
    process.stdout.write(d);
    if (argv.open && !opened && /http:\/\/localhost:\d+/.test(String(d))) { opened = true; openBrowser(); }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) { say("stopped"); process.exit(0); }
    const lived = Date.now() - began;
    quick = lived < QUICK_MS ? quick + 1 : 0;
    const how = signal ? `ended by ${signal}` : `exited with code ${code}`;
    if (quick >= MAX_QUICK) { say(`the panel ${how} within ${Math.round(QUICK_MS / 1000)} s of starting, ${MAX_QUICK} times in a row: not started again. The reason is in its last lines above.`); process.exit(1); }
    const wait = quick ? Math.min(8000, 500 * 2 ** (quick - 1)) : 300;
    say(`the panel ${how} after ${Math.round(lived / 1000)} s; starting it again${wait > 300 ? ` in ${wait / 1000} s` : ""}`);
    setTimeout(() => { if (!stopping) start(); }, wait);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) { say("stopped"); process.exit(0); }
  say("stopping the panel…");
  child.kill("SIGTERM");
  setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 4000).unref();
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, stop);

if (await portAnswers()) {
  say(`something already answers on ${URL_}: a panel is running elsewhere (the Claude app's Browser pane, or another Terminal). Nothing started here. Stop that one first if you want this keeper to own it.`);
  if (argv.open) openBrowser();
  process.exit(0);
}
start();
