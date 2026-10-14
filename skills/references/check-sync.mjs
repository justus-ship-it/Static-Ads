#!/usr/bin/env node
/**
 * check-sync.mjs — Verify each skill's slash-command twin is identical.
 *
 * Every skill in .claude/skills/{name}/SKILL.md has a copy at .claude/commands/{name}.md
 * that must stay byte-identical. Nothing enforced that, so a promotion that wrote only
 * SKILL.md silently dropped template 51 from the command copy.
 *
 * Usage:
 *   node skills/references/check-sync.mjs          # report, exit 1 on drift
 *   node skills/references/check-sync.mjs --fix    # copy SKILL.md over the twin
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");
const CMDS_DIR = join(REPO_ROOT, ".claude", "commands");

const { values } = parseArgs({ options: { fix: { type: "boolean", default: false } } });

if (!existsSync(SKILLS_DIR)) {
  console.error(`No skills directory at ${SKILLS_DIR}`);
  process.exit(1);
}

const skills = readdirSync(SKILLS_DIR)
  .filter((n) => statSync(join(SKILLS_DIR, n)).isDirectory())
  .filter((n) => existsSync(join(SKILLS_DIR, n, "SKILL.md")));

let drifted = 0;
let fixed = 0;

for (const name of skills) {
  const skillPath = join(SKILLS_DIR, name, "SKILL.md");
  const cmdPath = join(CMDS_DIR, `${name}.md`);
  const skill = readFileSync(skillPath, "utf-8");

  if (!existsSync(cmdPath)) {
    // Not every skill is exposed as a slash command; only flag it if one was expected.
    console.log(`  skip     ${name}  (no command twin at .claude/commands/${name}.md)`);
    continue;
  }

  if (readFileSync(cmdPath, "utf-8") === skill) {
    console.log(`  ok       ${name}`);
    continue;
  }

  drifted++;
  if (values.fix) {
    writeFileSync(cmdPath, skill);
    fixed++;
    console.log(`  FIXED    ${name}  (copied SKILL.md -> commands/${name}.md)`);
  } else {
    console.log(`  DRIFTED  ${name}  (.claude/commands/${name}.md differs from SKILL.md)`);
  }
}

if (drifted === 0) {
  console.log(`\nAll ${skills.length} skill/command pairs in sync.`);
  process.exit(0);
}

if (values.fix) {
  console.log(`\nRepaired ${fixed} pair(s).`);
  process.exit(0);
}

console.log(`\n${drifted} pair(s) out of sync. Re-run with --fix, or edit both copies.`);
process.exit(1);
