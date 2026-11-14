---
name: swipe-intel
description: >
  Phase 0 — Competitor Swipe Intelligence. Pulls top gym/fitness ads from the Meta Ad
  Library (via Apify), ranks the likely winners by a longevity + volume survivorship proxy,
  then uses Claude's vision to distill RECURRING PATTERNS into new reusable ad templates
  (numbered 51+) and hook entries that feed the existing static-ads → ad-copy-builder
  pipeline — generated with each CLIENT's own brand assets, never competitor creative.

  TRIGGER when the user says anything like:
  - "swipe the top gym ads" / "find winning gym ads in the ad library"
  - "analyze competitor ads for [niche]"
  - "build templates from the meta ad library"
  - "/swipe-intel gym"
user-invocable: true
argument-hint: "<niche> (e.g. gym)"
---

# Swipe Intelligence (Phase 0)

Turn the best-surviving competitor ads in the Meta Ad Library into reusable templates for
your clients. This is a **front-end stage** that produces new templates (51+); everything
downstream (image generation, gallery, copy, Meta CSV) is the existing pipeline, unchanged.

## Critical rules (read first)
1. **Analysis only.** Competitor creatives are third-party copyrighted works. They are used
   to extract *structure* and are NEVER republished and NEVER used as generation reference
   images. The `swipe/` tree is git-ignored.
2. **No competitor branding leaks.** Distilled templates describe *form only* —
   `[BRACKETED PLACEHOLDERS]`, never a competitor brand name, logo, slogan, colour, or person.
   Client ads are generated from the **client's** `product-images/` only.
3. **No real performance data exists** for commercial ads. Ranking is a *survivorship proxy*
   (how long an ad ran + how many variants), not measured spend/CTR. Say so to the user.
4. **Gym/fitness is compliance-heavy.** Apply `references/gym-compliance.md` at distillation.

---

## Workflow

### Step 1 — Scrape (mechanical, run once per niche)
A shared `swipe/{niche}/` library is reused across ALL clients in that niche (gym competitors
are the same for every gym client), so scrape once, not per brand.

```bash
node skills/references/scrape-meta-ads.mjs --niche {niche} --country {CC} \
  --terms "gym,fitness studio,personal training,bootcamp" --limit 300 --active active --i-understand-tos
```
Requires `APIFY_TOKEN` in `.env`. Writes `swipe/{niche}/raw/{date}/ads-normalized.json`.

### Step 2 — Rank (mechanical)
```bash
node skills/references/rank-swipe-ads.mjs --in swipe/{niche} --top 20
```
Writes `swipe/{niche}/ranked.json` with `top_ad_ids` (diversified, max ~3 per advertiser).

### Step 3 — Analyze (THIS skill — Claude vision)
This is the only step that needs you (Claude). Do the following:

1. Read `swipe/{niche}/ranked.json`. Take the ads where `top === true`.
   **Discard off-niche ads first.** The Ad Library keyword match is loose and pulls in
   unrelated advertisers (e.g. for "gym": business/marketing coaches, language-learning apps,
   hotels, music labels). Look at each ad's `page_name` + creative + copy and DROP anything
   that is not actually a gym / fitness / training brand before distilling. Note in the run
   how many you dropped, so the shortlist size is honest.
2. For each shortlisted ad, **read its creative image(s)** from disk — the paths in
   `image_files` are relative to `swipe/{niche}/raw/{date}/` (e.g.
   `swipe/gym/raw/2026-06-20/images/<hash>.jpg`). Also read its `primary_text` and `cta`.
   Inspect the images the same way Phase 1 inspects brand screenshots — vision is the source
   of truth for layout and visual motifs.
3. For each ad, note: layout pattern, hook type (map onto the 12 categories in
   `references/analysis-schema.md`), copy structure, visual motifs.
4. **Cluster** the shortlist into a small number (typically 4–8) of ABSTRACT templates that
   capture the *recurring* structure. Do NOT make one template per ad.
5. For each cluster, write a template that is isomorphic to the existing 50 — a
   `template_prompt` that starts "Use the attached images as brand reference…", contains only
   `[BRACKETED PLACEHOLDERS]`, and embeds NO competitor specifics.
6. Apply `references/gym-compliance.md`: abstract any risky device (before/after body,
   weight-loss numbers, second-person body targeting, guarantees, unrealistic timelines) into
   the compliant form and record `compliance_flags`.
7. Number templates starting at (current library max + 1). Check the highest `### N.` in
   `.claude/skills/static-ads/SKILL.md` — currently 50, so start at **51**.

Write two files following `references/analysis-schema.md` exactly:
- `swipe/{niche}/analysis/swipe-templates.json`
- `swipe/{niche}/analysis/swipe-hooks.json` (or `{ "hooks": [] }` if none)

**Self-check before writing:** grep your `template_prompt`s for every `page_name` in
`ranked.json` — none may appear. Every brand-specific slot must be a `[PLACEHOLDER]`.

### Step 4 — Human review (mechanical + human)
```bash
node skills/references/build-swipe-report.mjs --in swipe/{niche} --open
```
Opens `swipe-report.html`: each proposed template with its prompt, hooks, compliance flags,
and thumbnails of the source ads it was distilled from, with Approve/Reject toggles. The
human approves, which downloads `approved-templates.json` (move it into `swipe/{niche}/`).

### Step 5 — Promote into the shared library (mechanical)
```bash
node skills/references/promote-swipe-templates.mjs --in swipe/{niche}
```
Appends approved templates as `### 51.`+ blocks into `static-ads/SKILL.md`, rows into
`template-hook-map.md`, new hooks into `hook-bank.md`, and logs `swipe/{niche}/PROMOTED.md`.
It refuses to promote any template whose generation would reference a `swipe/` path.

### Step 6 — Use per client (existing pipeline, unchanged)
Run the normal flow for each gym client; Phase 2 now sees templates 51+ and fills them with
the **client's** brand DNA and product images:
```bash
# /static-ads "ClientGym" "https://clientgym.com"   → brand-dna.md, prompts.json (incl. 51+)
node skills/references/generate_ads_gemini.mjs --brand-dir brands/clientgym --templates 51,52,53 --num-images 2
# open gallery.html → select → selections.json → /ad-copy-builder ...
```

---

## What you (Claude) output in Step 3 — quick reference
See `references/analysis-schema.md` for the full schema. Minimum per template:
`proposed_number`, `template_name` (kebab-case, no brand), `one_line_description`,
`template_prompt` (form-only, `[PLACEHOLDERS]`), `placeholders`, `suggested_hook_types`
(from the 12 categories), `source_ad_ids`, `occurrence_count`, `compliance_flags`.
