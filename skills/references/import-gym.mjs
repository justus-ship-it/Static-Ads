/**
 * Importing a gym from the Strategym portfolio (2026-10-07). A new gym whose Facebook Page and ad account are
 * assigned to Strategym's system user can be filled in from them in one run instead of six separate readings:
 *
 *   runImport({ brandDir, client, log })   — read-only on Meta, each step recorded in onboarding/import.json:
 *     meta      the Page and the account (read-meta: address, phone, hours, website, Instagram, pins, ages,
 *               budget, offer names, callout) → onboarding/meta/reading.json
 *     presets   the account's targeting with results (meta-targeting) → targeting-presets.json
 *     history   every campaign, ad set and ad with results (meta-results) → account-history.json
 *     forms     the Page's instant forms (lead-forms) → onboarding/meta/forms.json, with the template candidate
 *               (the latest version's form with the most leads); the default form is left to the owner
 *     identity  the Singapore advertiser identity, for a Singapore gym (meta-publish)
 *     website   read-website.mjs on the Page's website (its own process; Chrome and model calls)
 *     instagram read-instagram.mjs on the Page's Instagram account (its own process; Meta and model calls)
 *   A step that fails is recorded with its reason and the run goes on; nothing is written to the profile here
 *   except the identity (exactly one, as the Publish screen would).
 *
 *   importProposal(gymDir)                — what the import screen shows: each section's summary, pre-ticked
 *                                            except the offer names and the photos (the owner's choices)
 *   applyImport(gymDir, body, { accept }) — the ticked sections applied through the accept paths that already
 *                                            exist (read-meta's acceptMetaFacts, the panel's website accept, the
 *                                            history import into the library, the lead-form template)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readMetaFacts, writeMetaReading, readMetaReading, acceptMetaFacts } from "./read-meta.mjs";
import { importPresets, readPresets } from "./meta-targeting.mjs";
import { pullAccountHistory, historyRows } from "./meta-results.mjs";
import { readForms, templateFrom, readLeadForms, writeLeadForms } from "./lead-forms.mjs";
import { findIdentity, regulatedFor } from "./meta-publish.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const IMPORT_FILE = join("onboarding", "import.json");
export const FORMS_FILE = join("onboarding", "meta", "forms.json");
export const STEPS = ["meta", "presets", "history", "forms", "identity", "website", "instagram"];
/** How many of the account's best ads go into the library by default (the owner's choice, 2026-10-07). */
export const HISTORY_TOP = 10;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };
export const readImport = (gymDir) => readJson(join(gymDir, IMPORT_FILE));

/** The template candidate among a Page's forms: the latest version prefix (v8 over v7), then the most leads. */
export function templateCandidate(forms) {
  const live = (forms || []).filter((f) => f.status !== "ARCHIVED" && (f.questions || []).length >= 3);
  const version = (f) => Number((String(f.name || "").match(/^v(\d+)/i) || [])[1] || 0);
  return [...live].sort((a, b) => version(b) - version(a) || (b.leads_count || 0) - (a.leads_count || 0) || (b.created_time || "").localeCompare(a.created_time || ""))[0] || null;
}

/** A reader script in its own process, its lines passed to the log. */
function runScript(script, args, { log, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    const take = (buf) => { for (const line of buf.toString().split(/\r?\n/)) if (line) { lines.push(line); log(`  ${line}`); } };
    child.stdout.on("data", take); child.stderr.on("data", take);
    child.on("error", (e) => resolve({ code: -1, lines, error: e.message }));
    child.on("close", (code) => resolve({ code, lines, error: code === 0 ? null : lines.slice(-3).join(" | ") || `exited with ${code}` }));
  });
}

export async function runImport({ brandDir, client, log = console.log, skip = [], now = () => new Date().toISOString(), scripts = { website: join(HERE, "read-website.mjs"), instagram: join(HERE, "read-instagram.mjs") }, spawnImpl = spawn, posts = 100 }) {
  const gymDir = resolve(brandDir), pf = join(gymDir, "gym-profile.json");
  const profile = readJson(pf);
  if (!profile) throw new Error(`no gym profile at ${pf}`);
  const m = profile.meta_assets || {};
  if (!m.ad_account_id || !m.page_id) throw new Error("the gym's ad account and Facebook Page are needed first (the Meta link page, or New gym → from the portfolio)");
  const state = { schema: 1, started: now(), done: null, gym: profile.gym_id || null, steps: {} };
  const save = () => writeJson(join(gymDir, IMPORT_FILE), state);
  const step = async (name, fn) => {
    if (skip.includes(name)) { state.steps[name] = { ok: null, skipped: true, note: "skipped" }; save(); log(`- ${name}: skipped`); return; }
    state.steps[name] = { ok: null, started: now() }; save();
    log(`· ${name}…`);
    try { const note = await fn(); state.steps[name] = { ok: true, note: note || "", finished: now() }; log(`✓ ${name}: ${note || "done"}`); }
    catch (e) { state.steps[name] = { ok: false, error: String(e.message || e), finished: now() }; log(`✗ ${name}: ${e.message}`); }
    save();
  };
  let reading = null;
  await step("meta", async () => { reading = await readMetaFacts({ client, profile }); writeMetaReading(gymDir, reading); return `${reading.page?.name || "the Page"} · ${reading.adsets?.count ?? 0} ad sets · ${reading.offers?.length ?? 0} offer name(s)${reading.problems?.length ? ` · ${reading.problems.length} part(s) could not be read` : ""}`; });
  await step("presets", async () => { const r = await importPresets({ client, accountId: m.ad_account_id, gymDir }); return `${r.added} preset(s) from ${r.adsets} ad set(s)`; });
  await step("history", async () => { const h = await pullAccountHistory({ client, accountId: m.ad_account_id, gymDir }); return `${h.campaigns.length} campaign(s), ${h.adsets.length} ad set(s), ${h.ads.length} ad(s)`; });
  await step("forms", async () => {
    const forms = await readForms(client, m.page_id), candidate = templateCandidate(forms);
    writeJson(join(gymDir, FORMS_FILE), { read_at: now(), forms: forms.map((f) => ({ id: f.id, name: f.name, status: f.status, created_time: f.created_time, leads_count: f.leads_count, question_count: f.question_count })), candidate: candidate ? { id: candidate.id, name: candidate.name, leads_count: candidate.leads_count, template: templateFrom(candidate, { district: reading?.callouts?.[0] || null, country: profile.locale?.country || null }) } : null });
    return `${forms.length} form(s)${candidate ? `; template candidate "${candidate.name}"` : ""}`;
  });
  await step("identity", async () => {
    const reg = regulatedFor(profile);
    if (!reg) return "no advertiser identity needed in this country";
    const copy = JSON.parse(readFileSync(pf, "utf-8")), r = await findIdentity(copy, client);
    if (r.set) { writeJson(pf, copy); return `beneficiary ${r.set.beneficiary}, from ${r.set.adsets} ad set(s)`; }
    return r.have ? "already on the profile" : r.reason || "nothing found";
  });
  await step("website", async () => {
    const url = reading?.page?.website || profile.website;
    if (!url) throw new Error("the Page names no website");
    const r = await runScript(scripts.website, ["--brand-dir", gymDir, "--url", url], { log, spawnImpl });
    if (r.code !== 0) throw new Error(r.error);
    return url;
  });
  await step("instagram", async () => {
    const handle = reading?.page?.instagram?.username || profile.social?.instagram;
    if (!handle) throw new Error("the Page has no Instagram account");
    const r = await runScript(scripts.instagram, ["--brand-dir", gymDir, "--handle", handle, "--posts", String(posts)], { log, spawnImpl });
    if (r.code !== 0) throw new Error(r.error);
    return `@${handle}, the latest ${posts} posts`;
  });
  state.done = now(); save();
  const ok = Object.values(state.steps).filter((s) => s.ok === true).length, failed = Object.entries(state.steps).filter(([, s]) => s.ok === false).map(([k]) => k);
  log(`· import done: ${ok} step(s) read${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  return state;
}

/**
 * What the import screen shows, from the files the run wrote: each section's summary and its default tick —
 * everything pre-ticked except the offer names and the photos, which stay the owner's choices.
 */
export function importProposal(gymDir, { websiteReading = null, instagramReading = null } = {}) {
  const state = readImport(gymDir), meta = readMetaReading(gymDir), forms = readJson(join(gymDir, FORMS_FILE)), presets = readPresets(gymDir);
  const profile = readJson(join(gymDir, "gym-profile.json")) || {};
  const rows = existsSync(join(gymDir, "account-history.json")) ? historyRows(gymDir) : [];
  const top = rows.filter((r) => r.leads > 0 && !r.in_library).sort((a, b) => b.leads - a.leads).slice(0, HISTORY_TOP);
  return {
    state,
    meta: meta ? { ticked: true, page: meta.page, account: meta.account, pin: meta.pin, adsets: meta.adsets, callouts: meta.callouts, offers: (meta.offers || []).map((o) => ({ ...o, ticked: false })), problems: meta.problems || [] } : null,
    presets: { ticked: true, count: presets.presets.filter((p) => !p.retired).length, imported: presets.imported },
    history: { ticked: true, top: top.map((r) => ({ ad_id: r.ad_id, ad_name: r.ad_name, leads: r.leads, cost_per_lead: r.cost_per_lead, spend: r.spend, thumbnail: r.thumbnail || null })), ads: rows.length },
    forms: forms ? { ticked: !!forms.candidate, count: forms.forms.length, candidate: forms.candidate ? { id: forms.candidate.id, name: forms.candidate.name, leads_count: forms.candidate.leads_count, questions: forms.candidate.template?.spec?.questions?.length ?? null, phrases: forms.candidate.template?.phrases || null } : null, default_form_id: profile.meta_assets?.lead_form_id || null } : null,
    website: websiteReading ? { ticked: true, ...websiteReading, photos_note: "photos stay your choice: pick them on From the website" } : null,
    instagram: instagramReading ? { ticked: false, ...instagramReading, photos_note: "photos stay your choice: pick them on From Instagram" } : null,
  };
}

/**
 * The ticked sections applied: Meta facts through acceptMetaFacts (the offer names only as ticked), the
 * lead-form template, the top ads into the library (through `accept.history`, the panel's import, which needs
 * Meta), the website's colours, fonts and logo (through `accept.website`, the panel's). Answers what changed.
 */
export async function applyImport(gymDir, body = {}, { accept = {} } = {}) {
  const out = { changes: [], skipped: [] };
  if (body.meta) {
    const m = body.meta === true ? {} : body.meta, reading = readMetaReading(gymDir) || {};
    // The reading's own numbers where the owner changed nothing: the pin's radius, the ages and the budget their
    // ad sets run most, the callout the Page's district gave (acceptMetaFacts takes values, not ticks).
    const ages0 = reading.adsets?.ages?.[0], budget0 = reading.adsets?.daily_budget?.median;
    const r = acceptMetaFacts(gymDir, {
      locale: true, address: true, phone: true, hours: true, website: true, instagram: true, facebook: true,
      pin: m.pin === false ? false : { radius_km: m.pin?.radius_km ?? reading.pin?.radius_km ?? undefined },
      ages: m.ages === false ? false : (m.ages && typeof m.ages === "object") ? m.ages : ages0 ? { min: ages0.min, max: ages0.max } : false,
      budget: m.budget === false ? false : Number.isFinite(m.budget) ? m.budget : Number.isFinite(budget0) ? budget0 : false,
      callouts: m.callouts === false ? [] : Array.isArray(m.callouts) ? m.callouts : reading.callouts || [],
      offers: Array.isArray(m.offers) ? m.offers : [],
    });
    if (accept.writeProfile) accept.writeProfile(r.profile); else writeJson(join(gymDir, "gym-profile.json"), r.profile);
    out.changes.push(...(r.changes || []).map((c) => `Meta: ${c}`));
    if (r.wordings?.added?.length) out.changes.push(`offer wordings: ${r.wordings.added.join(", ")}`);
  } else out.skipped.push("meta");
  if (body.forms) {
    const forms = readJson(join(gymDir, FORMS_FILE));
    if (forms?.candidate?.template) { const data = readLeadForms(gymDir); data.template = { ...forms.candidate.template, set: new Date().toISOString() }; writeLeadForms(gymDir, data); out.changes.push(`lead-form template: "${forms.candidate.name}"`); }
    else out.skipped.push("forms (no candidate)");
  } else out.skipped.push("forms");
  if (body.history && accept.history) { const ids = Array.isArray(body.history) ? body.history : null; const r = await accept.history(ids); out.changes.push(`library: ${r.imported ?? r.added ?? 0} ad(s) from the account`); }
  else out.skipped.push("history");
  if (body.website && accept.website) { const r = await accept.website(body.website === true ? {} : body.website); out.changes.push(...(r.changes || []).map((c) => `website: ${c}`)); }
  else out.skipped.push("website");
  return out;
}

// ── CLI: the panel's `profile-import` run ─────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { parseArgs } = await import("node:util");
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, skip: { type: "string" }, posts: { type: "string", default: "100" } } });
  if (!v["brand-dir"]) { console.error("Usage: import-gym.mjs --brand-dir brands/{gym} [--skip website,instagram] [--posts 100]"); process.exit(1); }
  try {
    const { metaConfig, graphClient } = await import("./meta-api.mjs");
    const gym = resolve(v["brand-dir"]).split("/").pop();
    const cfg = metaConfig({ gym });
    if (!cfg.token) throw new Error("no META_ACCESS_TOKEN in .env — the Meta link is not set up yet");
    const state = await runImport({ brandDir: v["brand-dir"], client: graphClient({ config: cfg }), skip: (v.skip || "").split(",").map((x) => x.trim()).filter(Boolean), posts: Math.max(25, Math.min(500, parseInt(v.posts, 10) || 100)) });
    process.exit(Object.values(state.steps).some((s) => s.ok === false) ? 2 : 0);
  } catch (e) { console.error(e.message); process.exit(1); }
}
