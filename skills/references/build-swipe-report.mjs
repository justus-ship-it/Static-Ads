#!/usr/bin/env node
/**
 * build-swipe-report.mjs — Phase 0 human review gallery
 *
 * Renders swipe/{niche}/swipe-report.html from:
 *   - swipe/{niche}/analysis/swipe-templates.json  (distilled templates, from the skill)
 *   - swipe/{niche}/ranked.json                     (for source-ad thumbnails + provenance)
 *
 * Each proposed template is shown with its prompt, hooks, compliance flags, and thumbnails
 * of the competitor ads it was distilled from, plus an Approve/Reject toggle. Saving
 * downloads approved-templates.json (move it into swipe/{niche}/ before promoting).
 *
 * SECURITY: competitor primary_text / page_name are UNTRUSTED third-party strings. All
 * scraped values are HTML-escaped before injection, and embedded JSON is escaped against
 * </script> breakout. The browser is opened with execFile (no shell) to avoid the command
 * injection present in the older ad-library.mjs / gallery-selector.mjs --open path.
 *
 * Usage:
 *   node skills/references/build-swipe-report.mjs --in swipe/gym [--open]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { execFile } from "child_process";

// ── escaping ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/** Safe to embed inside a <script> block: kills </script> + HTML-sniffing breakouts. */
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}

function main() {
  const { values } = parseArgs({
    options: { in: { type: "string", default: "swipe/gym" }, open: { type: "boolean", default: false } },
    strict: false,
  });

  const inRoot = resolve(values.in);
  const templatesPath = join(inRoot, "analysis", "swipe-templates.json");
  const rankedPath = join(inRoot, "ranked.json");

  if (!existsSync(templatesPath)) {
    console.error(`Not found: ${templatesPath}\nRun the /swipe-intel analysis step first.`);
    process.exit(1);
  }
  const tdata = JSON.parse(readFileSync(templatesPath, "utf-8"));
  const templates = tdata.templates || [];
  if (templates.length === 0) {
    console.error("No templates in swipe-templates.json.");
    process.exit(1);
  }

  // Build ad_id → provenance map from ranked.json (thumbnails relative to swipe/{niche}/).
  const adMap = new Map();
  let scrapeDate = tdata.source_scrape_date || "";
  if (existsSync(rankedPath)) {
    const rdata = JSON.parse(readFileSync(rankedPath, "utf-8"));
    scrapeDate = rdata.source_scrape_date || scrapeDate;
    for (const ad of rdata.ads || []) {
      adMap.set(ad.ad_id, {
        page_name: ad.page_name || "",
        primary_text: ad.primary_text || "",
        days_active: ad.days_active || 0,
        variant_count: ad.variant_count || 1,
        images: (ad.image_files || []).map((f) => `raw/${scrapeDate}/${f}`),
      });
    }
  }

  const niche = tdata.niche || "swipe";

  // ── server-side rendered, fully escaped cards ──
  const cards = templates.map((t, i) => {
    const num = escHtml(t.proposed_number ?? i + 51);
    const name = escHtml(t.template_name || "");
    const desc = escHtml(t.one_line_description || "");
    const prompt = escHtml(t.template_prompt || "");
    const hooks = (t.suggested_hook_types || []).map((h) => `<span class="tag hook">${escHtml(h)}</span>`).join("");
    const flags = (t.compliance_flags || []).length
      ? (t.compliance_flags).map((f) => `<span class="tag flag">${escHtml(f)}</span>`).join("")
      : `<span class="tag ok">no compliance flags</span>`;
    const occ = escHtml(t.occurrence_count ?? (t.source_ad_ids || []).length);

    const thumbs = (t.source_ad_ids || []).map((id) => {
      const ad = adMap.get(id);
      if (!ad) return `<div class="thumb missing" title="${escHtml(id)}">no preview</div>`;
      const img = ad.images[0];
      const cap = `${escHtml(ad.page_name)} · ${escHtml(ad.days_active)}d · ${escHtml(ad.variant_count)}v`;
      const inner = img
        ? `<img src="${escHtml(img)}" alt="source ad" loading="lazy">`
        : `<div class="thumb missing">no image</div>`;
      return `<figure class="thumb">${inner}<figcaption>${cap}</figcaption></figure>`;
    }).join("");

    return `
    <div class="card" data-idx="${i}" id="card-${i}">
      <div class="card-head">
        <label class="approve">
          <input type="checkbox" class="approve-box" data-idx="${i}" checked>
          <span class="approve-label">Approved</span>
        </label>
        <h2>#${num} ${name} <span class="occ">${occ}× in shortlist</span></h2>
      </div>
      <p class="desc">${desc}</p>
      <div class="tags">${hooks} ${flags}</div>
      <details><summary>Template prompt</summary><pre>${prompt}</pre></details>
      ${thumbs ? `<div class="prov"><div class="prov-label">Distilled from these competitor ads (analysis only):</div><div class="thumbs">${thumbs}</div></div>` : ""}
    </div>`;
  }).join("\n");

  // Minimal data for save (full template objects, escaped against breakout).
  const dataForSave = safeJson(templates);

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Swipe Review — ${escHtml(niche)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a0a0a; color:#eee; }
  #bar { position:sticky; top:0; z-index:10; background:#111; border-bottom:1px solid #222;
         padding:.85rem 2rem; display:flex; align-items:center; justify-content:space-between; gap:1rem; }
  #bar h1 { font-size:1.05rem; }
  #bar .sub { color:#888; font-size:.8rem; }
  #count { color:#4ade80; font-size:.85rem; }
  #save { background:#16a34a; color:#fff; border:none; border-radius:6px; padding:.55rem 1.3rem;
          font-weight:600; cursor:pointer; }
  #save:hover { background:#15803d; }
  .warn { background:#3b2410; color:#fcd34d; font-size:.78rem; padding:.5rem 2rem; border-bottom:1px solid #5a370f; }
  .content { padding:1.5rem 2rem; max-width:1100px; margin:0 auto; }
  .card { background:#151515; border:1px solid #242424; border-radius:10px; padding:1.1rem 1.25rem; margin-bottom:1.25rem; }
  .card.rejected { opacity:.45; border-color:#5a1212; }
  .card-head { display:flex; align-items:center; gap:1rem; }
  .card-head h2 { font-size:1.1rem; font-weight:650; }
  .occ { color:#666; font-size:.78rem; font-weight:400; margin-left:.4rem; }
  .approve { display:flex; align-items:center; gap:.4rem; cursor:pointer; user-select:none; white-space:nowrap; }
  .approve-label { font-size:.8rem; color:#4ade80; }
  .card.rejected .approve-label { color:#ef6262; }
  .desc { color:#bbb; margin:.6rem 0; font-size:.92rem; }
  .tags { display:flex; flex-wrap:wrap; gap:.4rem; margin-bottom:.5rem; }
  .tag { font-size:.72rem; padding:.18rem .55rem; border-radius:4px; font-weight:600; }
  .tag.hook { background:#1e293b; color:#93c5fd; }
  .tag.flag { background:#3b1212; color:#fca5a5; }
  .tag.ok { background:#13241a; color:#4ade80; }
  details { margin:.4rem 0; } summary { cursor:pointer; color:#888; font-size:.85rem; }
  pre { white-space:pre-wrap; background:#0d0d0d; border:1px solid #222; border-radius:6px;
        padding:.75rem; margin-top:.5rem; font-size:.82rem; color:#cfcfcf; line-height:1.45; }
  .prov { margin-top:.75rem; }
  .prov-label { color:#777; font-size:.78rem; margin-bottom:.45rem; }
  .thumbs { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:.6rem; }
  .thumb { background:#0d0d0d; border:1px solid #222; border-radius:6px; overflow:hidden; font-size:.7rem; color:#666; }
  .thumb img { width:100%; display:block; }
  .thumb figcaption { padding:.35rem .45rem; color:#777; }
  .thumb.missing { display:flex; align-items:center; justify-content:center; min-height:80px; }
  #saved { display:none; color:#4ade80; font-size:.8rem; }
</style></head><body>
  <div id="bar">
    <div><h1>Swipe Review — ${escHtml(niche)}</h1>
      <div class="sub">${templates.length} proposed templates · scrape ${escHtml(scrapeDate || "n/a")}</div></div>
    <div style="display:flex;align-items:center;gap:1rem;">
      <span id="count"></span><span id="saved">✓ approved-templates.json downloaded</span>
      <button id="save">Save Approved →</button></div>
  </div>
  <div class="warn">⚠ Competitor ads shown for pattern analysis only — never republished or used as generation references.
     Rankings are a survivorship proxy (longevity + variants), not measured performance.</div>
  <div class="content">${cards}</div>
<script>
  const TEMPLATES = ${dataForSave};
  const state = TEMPLATES.map(() => true);
  function refresh() {
    document.querySelectorAll('.approve-box').forEach(b => {
      const i = +b.dataset.idx;
      document.getElementById('card-' + i).classList.toggle('rejected', !state[i]);
    });
    const n = state.filter(Boolean).length;
    document.getElementById('count').textContent = n + ' / ' + state.length + ' approved';
  }
  document.querySelectorAll('.approve-box').forEach(b => {
    b.addEventListener('change', () => { state[+b.dataset.idx] = b.checked; refresh(); });
  });
  document.getElementById('save').addEventListener('click', () => {
    const approved = TEMPLATES.filter((_, i) => state[i]);
    const blob = new Blob([JSON.stringify({ approved_at: new Date().toISOString(), count: approved.length, templates: approved }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'approved-templates.json'; a.click();
    URL.revokeObjectURL(a.href);
    document.getElementById('saved').style.display = 'inline';
  });
  refresh();
</script></body></html>`;

  const outPath = join(inRoot, "swipe-report.html");
  writeFileSync(outPath, html, "utf-8");
  console.log(`Wrote: ${outPath}`);
  console.log(`  → Review, toggle Approve/Reject, click 'Save Approved →'`);
  console.log(`  → Move approved-templates.json into ${inRoot}, then run promote-swipe-templates.mjs`);

  if (values.open) {
    // execFile (no shell) — path passed as an argument, never interpolated into a command.
    const [cmd, args] =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", outPath]]
      : process.platform === "darwin" ? ["open", [outPath]]
      : ["xdg-open", [outPath]];
    execFile(cmd, args, (err) => { if (err) console.error("Could not open browser:", err.message); });
  }
}

main();
