#!/usr/bin/env node
/**
 * promote-swipe-templates.mjs — Phase 0 promotion into the shared library
 *
 * Appends human-APPROVED distilled templates into the reusable library so they flow
 * through the existing Phase 2 → 3 → 4 pipeline for every client in the niche:
 *   - .claude/skills/static-ads/SKILL.md                         (### N. blocks)
 *   - .claude/skills/ad-copy-builder/references/template-hook-map.md (slug → hook rows)
 *   - hook-bank.md                                               (new hooks, if any)
 *   - swipe/{niche}/PROMOTED.md                                  (audit log)
 *
 * SAFETY GUARDS:
 *   - Reads swipe/{niche}/approved-templates.json (the human-approved subset only).
 *   - LEAKAGE ASSERTION: refuses any template whose prompt references a swipe/ path,
 *     an absolute path, or a scraped competitor page_name (from ranked.json). Competitor
 *     branding must never reach a client's generated ad.
 *   - Idempotent: skips templates whose slug already exists in the library.
 *   - --dry-run prints the planned changes without writing.
 *
 * Usage:
 *   node skills/references/promote-swipe-templates.mjs --in swipe/gym
 *   node skills/references/promote-swipe-templates.mjs --in swipe/gym --dry-run
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..");

const SKILL_MD = join(REPO_ROOT, ".claude", "skills", "static-ads", "SKILL.md");
// Slash-command copy of the skill. Must stay byte-identical to SKILL_MD — a promotion that
// writes only one of the pair silently drifts the two (this is how template 51 went missing).
const SKILL_CMD = join(REPO_ROOT, ".claude", "commands", "static-ads.md");
const HOOK_MAP = join(REPO_ROOT, ".claude", "skills", "ad-copy-builder", "references", "template-hook-map.md");
const HOOK_BANK = join(REPO_ROOT, "hook-bank.md");
const TIPS_HEADING = "## Tips for Best Results";
const MAP_SECTION = "## Swipe-Sourced Templates";
const BANK_SECTION = "## Swipe-Sourced Hooks";

const titleCase = (slug) =>
  slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Leakage / safety check ──────────────────────────────────────────────────
function checkLeakage(template, pageNames) {
  const errs = [];
  const prompt = template.template_prompt || "";
  if (/swipe\//i.test(prompt)) errs.push("prompt references a swipe/ path");
  if (/(^|[\s"'(])\/[A-Za-z0-9._-]+\//.test(prompt)) errs.push("prompt contains an absolute filesystem path");
  if (!/use the attached images as brand reference/i.test(prompt)) {
    errs.push('prompt must begin with "Use the attached images as brand reference..." so CLIENT images are the reference');
  }
  for (const name of pageNames) {
    if (!name || name.length < 3) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(prompt)) errs.push(`prompt contains competitor page name "${name}"`);
  }
  return errs;
}

function main() {
  const { values } = parseArgs({
    options: {
      in: { type: "string", default: "swipe/gym" },
      from: { type: "string", default: "" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: false,
  });

  const inRoot = resolve(values.in);
  const niche = inRoot.split(/[\\/]/).pop();
  const approvedPath = values.from ? resolve(values.from) : join(inRoot, "approved-templates.json");
  const dryRun = values["dry-run"];

  if (!existsSync(approvedPath)) {
    console.error(
      `Not found: ${approvedPath}\n` +
      `Build the report, click 'Save Approved →', and move approved-templates.json into ${inRoot}.`
    );
    process.exit(1);
  }
  const approved = JSON.parse(readFileSync(approvedPath, "utf-8"));
  const templates = approved.templates || [];
  if (templates.length === 0) {
    console.error("No approved templates to promote.");
    process.exit(1);
  }

  // Competitor page names for the leakage assertion (best effort).
  const pageNames = new Set();
  const rankedPath = join(inRoot, "ranked.json");
  if (existsSync(rankedPath)) {
    const r = JSON.parse(readFileSync(rankedPath, "utf-8"));
    for (const ad of r.ads || []) if (ad.page_name) pageNames.add(ad.page_name);
  }

  // ── Leakage assertion (fail the whole run on any violation) ──
  const violations = [];
  for (const t of templates) {
    const errs = checkLeakage(t, pageNames);
    if (errs.length) violations.push({ name: t.template_name, errs });
  }
  if (violations.length) {
    console.error("✗ Promotion blocked — competitor-leakage / safety violations:\n");
    for (const v of violations) {
      console.error(`  • ${v.name}`);
      for (const e of v.errs) console.error(`      - ${e}`);
    }
    console.error("\nFix the offending template_prompt(s) (placeholders only, no competitor specifics) and re-run.");
    process.exit(1);
  }

  // ── Read library files; determine next free template number + existing slugs ──
  let skill = readFileSync(SKILL_MD, "utf-8");
  const existingNums = [...skill.matchAll(/^### (\d+)\.\s/gm)].map((m) => parseInt(m[1], 10));
  const existingSlugs = new Set(
    [...skill.matchAll(/^### \d+\.\s+(.+)$/gm)].map((m) =>
      m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    )
  );
  let nextNum = (existingNums.length ? Math.max(...existingNums) : 50) + 1;

  const planned = [];
  const skipped = [];
  for (const t of templates) {
    const slug = (t.template_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) { skipped.push({ name: t.template_name, why: "empty slug" }); continue; }
    // Idempotency: skip if a matching slug already exists in the library.
    if ([...existingSlugs].some((s) => s.includes(slug) || slug.includes(s))) {
      skipped.push({ name: slug, why: "already in library" });
      continue;
    }
    planned.push({ ...t, finalNum: nextNum, slug, mapSlug: `${nextNum}-${slug}` });
    existingSlugs.add(slug);
    nextNum++;
  }

  if (planned.length === 0) {
    console.log("Nothing to promote (all approved templates already present).");
    if (skipped.length) skipped.forEach((s) => console.log(`  skipped ${s.name}: ${s.why}`));
    process.exit(0);
  }

  // ── Build the appended blocks ──
  const skillBlocks = planned.map((t) => {
    const desc = (t.one_line_description || "").trim();
    return `### ${t.finalNum}. ${titleCase(t.slug)}\n${desc}${desc ? "\n" : ""}\n` +
           `Template: ${t.template_prompt.trim()}\n`;
  }).join("\n");

  const mapRows = planned.map((t) => {
    const hooks = (t.suggested_hook_types || []).join(", ") || "—";
    const flags = (t.compliance_flags || []).length ? ` (flags: ${t.compliance_flags.join(", ")})` : "";
    return `| \`${t.mapSlug}\` | ${hooks} | swipe-sourced (${niche})${flags} |`;
  }).join("\n");

  // New hooks (optional)
  const hooksFile = join(inRoot, "analysis", "swipe-hooks.json");
  let newHooks = [];
  if (existsSync(hooksFile)) {
    try { newHooks = (JSON.parse(readFileSync(hooksFile, "utf-8")).hooks) || []; } catch { /* ignore */ }
  }
  const existingHookNames = new Set(
    [...readFileSync(HOOK_BANK, "utf-8").matchAll(/^### (.+)$/gm)].map((m) => m[1].trim().toLowerCase())
  );
  newHooks = newHooks.filter((h) => h.name && !existingHookNames.has(h.name.trim().toLowerCase()));
  const hookBlocks = newHooks.map((h) =>
    `### ${h.name}\n\n> *${(h.framework || "").trim()}*\n\n` +
    `**Category:** ${h.category || "—"}  \n**Awareness:** ${h.awareness || "—"}  \n` +
    `**Format:** ${h.format || "Static"}  \n**Use when:** ${h.use_when || "—"}  \n` +
    `**Source:** swipe-sourced (${niche})\n\n---\n`
  ).join("\n");

  // ── Report plan ──
  const sep = "=".repeat(60);
  console.log(sep);
  console.log(`  Promoting ${planned.length} template(s)${dryRun ? " [DRY RUN]" : ""}:`);
  for (const t of planned) console.log(`    #${t.finalNum} ${t.slug}  [${(t.suggested_hook_types || []).join(", ")}]`);
  if (skipped.length) { console.log("  Skipped:"); skipped.forEach((s) => console.log(`    - ${s.name}: ${s.why}`)); }
  if (newHooks.length) console.log(`  + ${newHooks.length} new hook(s)`);
  console.log(sep);

  if (dryRun) {
    console.log("\n--- SKILL.md additions (preview) ---\n" + skillBlocks);
    console.log("\n--- template-hook-map.md rows (preview) ---\n" + mapRows);
    if (hookBlocks) console.log("\n--- hook-bank.md additions (preview) ---\n" + hookBlocks);
    console.log("\n[dry-run] No files written.");
    return;
  }

  // ── Write: SKILL.md (insert before Tips heading) ──
  const tipsIdx = skill.indexOf(TIPS_HEADING);
  const insertBlock = `${skillBlocks}\n`;
  skill = tipsIdx >= 0
    ? skill.slice(0, tipsIdx) + insertBlock + "\n" + skill.slice(tipsIdx)
    : skill.replace(/\s*$/, "\n\n") + insertBlock;
  writeFileSync(SKILL_MD, skill);
  writeFileSync(SKILL_CMD, skill);

  // ── Write: template-hook-map.md (append section) ──
  let map = readFileSync(HOOK_MAP, "utf-8");
  if (!map.includes(MAP_SECTION)) {
    map = map.replace(/\s*$/, "\n\n") +
      `${MAP_SECTION}\n\nTemplates distilled from competitor ad-library patterns (Phase 0).\n\n` +
      `| Template | Best Hook Types | Notes |\n|----------|----------------|-------|\n`;
  }
  map = map.replace(/\s*$/, "\n") + mapRows + "\n";
  writeFileSync(HOOK_MAP, map);

  // ── Write: hook-bank.md (append section) ──
  if (hookBlocks) {
    let bank = readFileSync(HOOK_BANK, "utf-8");
    if (!bank.includes(BANK_SECTION)) {
      bank = bank.replace(/\s*$/, "\n\n") + `${BANK_SECTION}\n\nHooks distilled from competitor ads (Phase 0).\n\n`;
    }
    bank = bank.replace(/\s*$/, "\n") + hookBlocks + "\n";
    writeFileSync(HOOK_BANK, bank);
  }

  // ── Audit log ──
  const logPath = join(inRoot, "PROMOTED.md");
  const stamp = new Date().toISOString();
  if (!existsSync(logPath)) writeFileSync(logPath, `# Promotion log — ${niche}\n\n`);
  appendFileSync(
    logPath,
    `## ${stamp}\n` +
    planned.map((t) =>
      `- #${t.finalNum} \`${t.mapSlug}\` — hooks: ${(t.suggested_hook_types || []).join(", ") || "—"}` +
      ` — from ads: ${(t.source_ad_ids || []).join(", ") || "—"}` +
      ((t.compliance_flags || []).length ? ` — flags: ${t.compliance_flags.join(", ")}` : "")
    ).join("\n") +
    (newHooks.length ? `\n- hooks added: ${newHooks.map((h) => h.name).join(", ")}` : "") +
    "\n\n"
  );

  console.log(`✓ Promoted into library. Templates #${planned[0].finalNum}–#${planned[planned.length - 1].finalNum}.`);
  console.log(`  Logged: ${logPath}`);
  console.log(`\n  Use per client:`);
  console.log(`    node skills/references/generate_ads_gemini.mjs --brand-dir brands/{client} --templates ${planned.map((t) => t.finalNum).join(",")} --num-images 2`);
}

main();
