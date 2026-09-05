#!/usr/bin/env node
/**
 * plan-candidates.mjs — Decide WHICH templates to generate for a browse batch.
 *
 * The browse stage shows the user a spread of creative angles (Location, Model, Workout,
 * Offer, Process) rather than a march through the template library. This works out how many
 * candidates each angle gets, which templates can express it, and which are actually
 * generatable given the photos on disk.
 *
 * Usage:
 *   node skills/references/plan-candidates.mjs --gym sculpt-society --total 25
 *   node skills/references/plan-candidates.mjs --gym sculpt-society \
 *     --angles "facility-proof:10,trainer-authority:6,class-energy:6,offer-promo:3"
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(REPO_ROOT, ".claude", "skills", "static-ads", "references", "template-index.json");

// The angles a user actually thinks in, mapped onto the manifest's gym_format values.
export const ANGLES = {
  Location: ["facility-proof", "local-proximity"],
  Model:    ["trainer-authority", "testimonial"],
  Workout:  ["class-energy", "program-explainer"],
  Offer:    ["offer-promo", "urgency"],
  Proof:    ["social-proof", "objection-handling"],
  Hook:     ["curiosity-hook", "native-organic"],
};

const { values } = parseArgs({
  options: {
    gym: { type: "string" },
    total: { type: "string", default: "25" },
    angles: { type: "string", default: "" },
    set: { type: "string", default: "gym" },
    json: { type: "boolean", default: false },
  },
});

if (!values.gym) {
  console.error("Usage: node skills/references/plan-candidates.mjs --gym <slug> [--total 25] [--angles \"fmt:n,...\"]");
  process.exit(1);
}

const gymDir = join(REPO_ROOT, "brands", values.gym);
if (!existsSync(gymDir)) { console.error(`No brand folder at ${gymDir}`); process.exit(1); }

// ── What photos actually exist? A template whose assets are missing cannot be filled. ──
const refRoot = ["brand-assets", "reference-images", "product-images"]
  .map((d) => join(gymDir, d)).find((d) => existsSync(d));
const available = new Set();
if (refRoot) {
  // Only these count as generatable assets. brand/ holds research screenshots and _unsorted/
  // is a holding pen for images nobody has vetted — neither belongs in an ad.
  const ASSET_DIRS = new Set(["logo", "facility", "coaches", "members"]);
  for (const e of readdirSync(refRoot, { withFileTypes: true })) {
    if (e.isDirectory() && ASSET_DIRS.has(e.name)) {
      const n = readdirSync(join(refRoot, e.name)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length;
      if (n > 0) available.add(e.name);
    }
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
const usable = manifest.templates.filter((t) =>
  t.status === "active" &&
  (t.sets || []).includes(values.set) &&
  (t.asset_needs || []).every((a) => available.has(a))
);

// ── Work out the per-format quota ──
const byFormat = new Map();
for (const t of usable) {
  if (!t.gym_format) continue;
  if (!byFormat.has(t.gym_format)) byFormat.set(t.gym_format, []);
  byFormat.get(t.gym_format).push(t);
}

let quota = new Map();
if (values.angles) {
  for (const part of values.angles.split(",")) {
    const [fmt, n] = part.split(":");
    const k = fmt.trim(), v = parseInt(n, 10);
    if (!k || !Number.isFinite(v) || v < 0) { console.error(`Bad --angles entry: "${part}"`); process.exit(1); }
    if (!byFormat.has(k)) { console.error(`No usable template has gym_format "${k}". Available: ${[...byFormat.keys()].join(", ")}`); process.exit(1); }
    quota.set(k, v);
  }
} else {
  const total = parseInt(values.total, 10);
  // Angles the user thinks in that we can actually produce something for.
  const liveAngles = Object.entries(ANGLES)
    .map(([angle, fmts]) => [angle, fmts.filter((f) => byFormat.has(f))])
    .filter(([, fmts]) => fmts.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  const base = Math.floor(total / liveAngles.length);
  let left = total - base * liveAngles.length;
  for (const [, fmts] of liveAngles) {
    const share = base + (left-- > 0 ? 1 : 0);
    // Split this angle's share across its formats, remainder to the earlier format.
    const per = Math.floor(share / fmts.length);
    let rem = share - per * fmts.length;
    for (const f of fmts) quota.set(f, (quota.get(f) || 0) + per + (rem-- > 0 ? 1 : 0));
  }
}

// ── Spread each format's quota round-robin across its templates ──
const plan = [];
for (const [fmt, n] of quota) {
  const ts = byFormat.get(fmt) || [];
  if (!ts.length || n === 0) continue;
  const counts = new Map(ts.map((t) => [t.number, 0]));
  for (let i = 0; i < n; i++) counts.set(ts[i % ts.length].number, counts.get(ts[i % ts.length].number) + 1);
  for (const t of ts) {
    const c = counts.get(t.number);
    if (c > 0) plan.push({
      template_number: t.number, slug: t.slug, name: t.name,
      gym_format: fmt, angle: Object.entries(ANGLES).find(([, v]) => v.includes(fmt))?.[0] || "Other",
      executions: c, asset_needs: t.asset_needs || [],
      compliance_flags: t.compliance_flags || [], gym_adaptation: t.gym_adaptation || null,
    });
  }
}
plan.sort((a, b) => a.angle.localeCompare(b.angle) || a.template_number - b.template_number);
const totalCandidates = plan.reduce((n, p) => n + p.executions, 0);

if (values.json) {
  console.log(JSON.stringify({ gym: values.gym, set: values.set, total: totalCandidates, available_assets: [...available], plan }, null, 2));
} else {
  console.log(`\nAssets on disk: ${[...available].join(", ") || "none"}`);
  console.log(`Usable templates in set "${values.set}": ${usable.length} of ${manifest.templates.length}\n`);
  let angle = "";
  for (const p of plan) {
    if (p.angle !== angle) { angle = p.angle; console.log(`  ${angle}`); }
    console.log(`    ${String(p.executions)}x  #${String(p.template_number).padStart(2)} ${p.slug.padEnd(34)} ${p.gym_format}`);
  }
  const skipped = manifest.templates.filter((t) => t.status === "active" && (t.sets || []).includes(values.set) && !(t.asset_needs || []).every((a) => available.has(a)));
  if (skipped.length) {
    console.log(`\n  Not generatable — missing photos:`);
    for (const t of skipped) console.log(`    #${String(t.number).padStart(2)} ${t.slug.padEnd(34)} needs ${(t.asset_needs || []).filter((a) => !available.has(a)).join(", ")}`);
  }
  console.log(`\n  ${totalCandidates} candidates across ${new Set(plan.map((p) => p.angle)).size} angles\n`);
}
