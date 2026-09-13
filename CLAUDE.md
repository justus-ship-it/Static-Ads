# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Automated static ad generator: Claude Code + Google Gemini (primary) / FAL.ai Nano Banana 2 (backup). Takes brand name + URL, researches the brand, generates 50 ad prompts, fires them to the image generation API, downloads images, and builds an HTML gallery. Based on Alex Cooper's framework.

## Key Files

- `.claude/skills/static-ads/SKILL.md` — Canonical skill definition (3-phase pipeline + 50 prompt templates)
- `.claude/commands/static-ads.md` — Synced copy of SKILL.md for slash command invocation
- `skills/references/generate_ads_gemini.mjs` — **Primary** Node.js generation script (Google Gemini API)
- `skills/references/generate_ads.mjs` — **Backup** Node.js generation script (FAL.ai API)
- `skills/references/gallery-selector.mjs` — Standalone script: scans output folder → builds gallery.html with radio-button image selection UI → exports `selections.json`
- `.claude/skills/ad-copy-builder/SKILL.md` — Ad copy skill: reads selections.json + brand-dna.md + hook-bank.md → writes Ads Uploader CSV
- `.claude/commands/ad-copy-builder.md` — Slash command copy of ad-copy-builder skill
- `hook-bank.md` — 100 hook frameworks from Hook Bank (D-Double-U Media), tagged by type/awareness/goal
- `brands/{name}/` — Per-brand workspace: `product-images/`, `brand-images/`, `brand-dna.md`, `prompts.json`, `outputs/`

### Offer-first creative (two layers — being built step by step)

Gemini makes **pictures only**; software sets every word. The offer, location and audience are always user-supplied.

- `skills/references/visual-prompts.mjs` — pictures-only prompts composed around a layout (no text of any kind; never names words, even to forbid them)
- `skills/references/generate-visuals.mjs` — generate → check → finished-ad check, hard `--max-calls` budget, `--attempts`, `--check-only`. A photo that passes the picture checks (text, never-list, people, realism) but fails only its own layout — that layout's placement rule or its finished ad — is retried once, then kept with `own_layout_failed`; the batch gives it no primary look and places it where the fit stage says it fits
- `skills/references/check-visual.mjs` — vision check: stray text, the client's never-list, people count, placement at the best crop; flagged items confirmed by a second look; references text-checked; `checkTiled` for photos larger than the model looks at (full-resolution tiles)
- `skills/references/check-quality.mjs` — does a generated photo look real enough: the scene's exercise is shown; no gross fault on the people (a body on nothing, a missing or merged limb, a broken or duplicated face — confirmed by a second look); classes candid (not identical poses, some interaction, not most faces into the lens). Everything else the checker notices (equipment nuance, hands, extra people, background, mirrors) is a **note**, never a failure — the owner's bar is "raise the average; selection is the final check". Notes reach `batch.json` and `gallery-notes.json`, shown under each ad in the gallery. Runs after `check-visual` passes (`checkPicture` in generate-visuals); photos passed under older rules are re-checked on the next run at zero image cost. The owner's rulings in `brands/{gym}/quality-calibration.json` (`"by": "owner"`) override the checker both ways; `--calibrate <that file> --runs 3` measures the check against them
- `skills/references/clean-photo.mjs` — cleans a client's real photos (old-brand marks, signage, weight numbers, web-page controls): survey → crop to the model's exact shape → Gemini edit → tiled mark check, before/after vision comparison, pixel check that only the removal areas changed. Retries finish the previous edit when only marks are left. `--survey-only` previews for free. Originals are never modified; passing copies go to `brand-assets/facility-clean/`
- `skills/references/render-composites.mjs` + `composite-template.html` — the text layer (layouts × styles × palettes, contrast guard, safe areas, faces as keep-outs); verifies every render
- `skills/references/assign-variants.mjs` — which look each ad in a batch gets (only layouts each photo can carry; every location rendered together so each location's ad keeps the identical look)
- `skills/references/plan-offer-batch.mjs` — a batch end to end: `brands/{gym}/batches/{id}/brief.json` (offer, locations, audience — the user's exact words, never read from the offer file) → photos generated for their own layout, with scenes from the client's approved `brands/{gym}/scenes.json` → fit of every photo against every layout → looks → render per location → numbered folders + `batch.json` + `gallery.html`. `--dry-run` plans for free; `--render-only` re-renders with new words at zero image cost; `resolveSelections()` maps `selections.json` back to each ad's photos, look and words
- `skills/references/make-stories.mjs` — Stories/Reels (9:16) versions of the ads picked in the gallery (`selections.json` in the batch folder): one native 9:16 photo per photo in a single-photo look, anchored to the chosen 1:1 (the same people, clothes and moment — a sibling check gates it), composed for its look and fitted against its others (a look it misses gets its own photo, unless its pose forbids that layout); collage and panels ads reuse the batch's photos; a wide real photo becomes a fitted band (no call). A generated photo whose native 9:16 never passes, or cannot carry a location's words, falls back to **its 1:1 ad's own crop as a band** (the 9:16 layouts are derived from the 1:1 ones inside the live area, so the crop's proven placement carries over; its check boxes move with it) — no call. The derivation scales x and y differently, so a band's own 40% fit can miss the layout its 1:1 ad verified with (38% in 1:1, 51% in 9:16 for a subject at the frame's edge): the band keeps that layout with a "placement inherited" note, and the finished ad is still verified letter by letter against the faces and inside the safe area. Attempts already on disk count toward a run's tries. Rendered with each ad's own look and words into `{folder}/9x16/…_9x16_v1.png`, inside Meta's safe zone; `stories.json`; the gallery shows both ratios. `--dry-run` plans free; `--render-only` re-renders at zero cost; the cap (`--max-calls`, default 24) is for the batch's stories across runs
- `skills/references/scene-library.mjs` — the client's scene library (`brands/{gym}/scenes.json`): vocabulary and validation, `loadScenes` (never a draft unless a dry run, never a retired scene), `approveScenes`, `rejectScene` (a reason is required; the scene is retired with reason and date, never deleted), `libraryStatus`
- `skills/references/refresh-scenes.mjs` — the agent drafts scenes for the owner to approve. Directed by **gaps** (the thinnest tags for the audience), **words** (`--words`), or a **reference image** (`--reference`): the vision model reads the image once into words (activity, head count, setting, framing, where the people sit, light, mood; every word on it listed apart and kept out of the drafts), cached beside the image; the image is never attached to an image-generation call, never named to the drafter, and stays in the gitignored `brands/{gym}/references/`. One text call to the check model (JSON schema) with the gym's lock, the vocabularies, the candid and realism rules, the direction and every live and retired scene; drafts validated in code (library rules, duplicate ids, near-duplicate wording, the audience, forbidden words) and appended as drafts. A reference's framing sets the scene's pose and its empty space sets `prefer_layout`, which the planner uses as that scene's primary layout. No image calls
- **Directed batches:** `brief.direction: { words?, reference? }` — the batch drafts one scene per generated photo from it (`source: "batch:{id}"`), the dry run shows them, and a real run is refused until they are confirmed: `--approve-scenes` (the panel's Run confirmation) approves them into the library with `approved_via`; `refresh-scenes.mjs --reject id --reason` retires one and the next dry run drafts a replacement
- **Panel (ui/), Strategym-branded (navy #041131 on white, logo inline from `ui/assets/strategym-logo-vertical-navy.svg`):** a left rail — Work (Create, Review, Exports) · Library (Scenes, Photos, References) · Client (Brand, Offers, Targeting, Setup, Templates (old)) — and the client switcher in the top bar. Create is one screen: offer, location chips, audience presets, photo steppers, spread, real photos, direction, advanced; live preview, the batch summary and Plan / Generate on the right; campaign cards below. The Create screen has a Direction section (words, uploaded reference images — `PUT /api/client/{gym}/reference/{name}`, raw bytes, image by first bytes, kept in `brands/{gym}/references/`); the Scenes page holds the Scene library card (status, Refresh scenes… → the `scenes-refresh` run, every draft with Approve / Reject with a reason). **Review** (`#/{gym}/review/{batch}`): one ad at a time, the 1:1 and its 9:16 side by side, ← → to move, Keep / Exclude at the top (K, X, U to undo; Space keeps), a filmstrip, location and status filters, all on one screen; a Photos view where excluding a photo excludes every ad it appears in. Decisions save as they are made (`PUT /api/client/{gym}/batch/{id}/picks`, a patch) into `outputs/{batch}/review.json`, and `selections.json` is rewritten from it in the gallery's exact format — no Downloads step; an undecided ad counts as kept; a gallery-era `selections.json` is read as decisions; after any batch or Stories run the picks file is refreshed (renamed ads drop out, new ones count as kept). A Stories version is shown only while its file exists; "Change the words" re-renders the Stories versions too (free). **Generating** (`#/{gym}/generating/{batch}`): the run writes `outputs/{batch}/progress.json` photo by photo (`progressWriter` in plan-offer-batch; `onProgress` in generateVisuals — queued, generating, checking, retrying, passed, flagged, skipped, error; stages photos → fit → looks → render → gallery → done | failed), the page polls it, shows each photo as it passes and the calls used, re-attaches to the run's log after a reload, and passed photos can be reviewed while the rest are made. The address bar follows the screen, so Back and Forward work. Async views carry a render sequence so a late answer never paints over a newer screen. A directed batch's Run confirmation lists its drafted scenes; the server adds `--approve-scenes` only when the confirmed ids equal the drafts on disk
- **Gym profiles (schema 3):** `brands/{gym}/gym-profile.json` is filled in once and remembered; one folder per gym is the unit (switching gym in the panel switches everything). `client-config.mjs` → `validateProfile` (format only: abbreviation, dashes, website, 6-digit postal codes, hex colours, catalogue ids, `creative_defaults` by the batch's own rules, Meta ids as digits; any token, secret or password — by name or by what a Meta/Google key looks like — is refused: tokens live in .env) and `profileCompleteness` (computed, never stored: identity, brand, photos, scenes, offer wording, ad defaults → `ready_to_create`; targeting and Meta link → `ready_to_publish`, for later). `creative_defaults { locations, audiences, real_photos, generated, looks_per_photo, attempts, max_calls, spread }` pre-fill the Create screen — never the offer. `meta_assets` adds `business_id`, `lead_form_id` (ids only). The panel refuses to save a profile with format errors; `scaffold(gym, offer, { brandsDir, displayName })` writes a schema-3 starter
- `skills/references/ad-wordings.mjs` — the offer wordings a gym's ads use, in `brands/{gym}/ad-wordings.json` (its own file, so a profile save can never drop one): read from the batch history until first edited; add / edit / delete by the renderer's offer-line rules; a confirmed batch run (or new words on one) records its wording (`recordUse`). Offered as chips on Create — picking one is the owner choosing its exact words
- **Panel profile pages** (rail → Profile): Overview (each section done / partly done / not started, with what it still needs), Identity & locations (several locations), Brand & photography (colours, logo preview, photo rules, words never used), Offer wording (the chips, plus the offer files as "Offer details" for copy and campaigns later), Ad defaults, Targeting & budget, Meta link (ids only). New gym: a name and folder from the top bar (`POST /api/clients {gym, display_name}`), written in the panel's clients folder
- `.claude/skills/static-ads/references/offer-{treatments,styles,palettes}.json` — the catalogues
- Tests: `node --test skills/references/render-composites.test.mjs skills/references/assign-variants.test.mjs skills/references/visual-pipeline.test.mjs skills/references/clean-photo.test.mjs skills/references/plan-offer-batch.test.mjs skills/references/check-quality.test.mjs skills/references/make-stories.test.mjs skills/references/refresh-scenes.test.mjs skills/references/client-config.test.mjs ui/server.test.mjs`

```bash
# Offer-first batch: plan for free, then run (spends at most the brief's max_calls)
node skills/references/plan-offer-batch.mjs --brand-dir brands/{name} --brief batches/{id}/brief.json --dry-run
node skills/references/plan-offer-batch.mjs --brand-dir brands/{name} --brief batches/{id}/brief.json
# New offer name / location / audience in the brief: re-render the same photos, zero image calls
node skills/references/plan-offer-batch.mjs --brand-dir brands/{name} --brief batches/{id}/brief.json --render-only
# Stories/Reels (9:16) versions of the ads picked in the gallery (selections.json in the batch folder)
node skills/references/make-stories.mjs --brand-dir brands/{name} --batch {id} --dry-run
node skills/references/make-stories.mjs --brand-dir brands/{name} --batch {id} --max-calls 24
# Scene refresh (text calls only): drafts for approval — by gaps, by words, or from a reference image
node skills/references/refresh-scenes.mjs --brand-dir brands/{name} --audience women --count 6
node skills/references/refresh-scenes.mjs --brand-dir brands/{name} --audience any --count 3 --words "older couples training together"
node skills/references/refresh-scenes.mjs --brand-dir brands/{name} --audience men --count 3 --reference references/{image}
node skills/references/refresh-scenes.mjs --brand-dir brands/{name} --approve id,id
node skills/references/refresh-scenes.mjs --brand-dir brands/{name} --reject id --reason "…"
# A directed batch: brief.direction {words, reference} → dry run drafts its scenes → confirm → run
node skills/references/plan-offer-batch.mjs --brand-dir brands/{name} --brief batches/{id}/brief.json --dry-run
node skills/references/plan-offer-batch.mjs --brand-dir brands/{name} --brief batches/{id}/brief.json --approve-scenes
```

## 4-Phase Pipeline

1. **Phase 1 (Brand DNA)**: Firecrawl scrapes brand site + screenshots → Claude visually inspects screenshots (primary color source) → web research → `brand-dna.md` + `brand-images/`
2. **Phase 2 (Prompts)**: Fill 50 templates from SKILL.md with brand details → `prompts.json`
3. **Phase 3 (Images)**: `node generate_ads_gemini.mjs` → Gemini API → `outputs/{date}-V{n}/` + `gallery.html` (with image selection UI)
4. **Phase 4 (Ad Copy)**: Open `gallery.html` → pick best image per group → Save Selections → drop `selections.json` in output folder → `create copy for [brand] [version]` → `upload.csv` + `upload-2.xlsx` + `copy-summary.md` → upload to Ads Uploader → publish paused

## Commands

```bash
# === PRIMARY: Google Gemini ===

# Full run (all 50 templates, 4 images each, both aspect ratios)
node skills/references/generate_ads_gemini.mjs --brand-dir brands/{name}

# Cheap test run
node skills/references/generate_ads_gemini.mjs --brand-dir brands/{name} --templates 1,7,13 --num-images 1 --ratios 1x1

# Specific templates
node skills/references/generate_ads_gemini.mjs --brand-dir brands/{name} --templates 1,4,7,9,13 --num-images 4

# Control parallelism (default: 2, recommended: 5)
node skills/references/generate_ads_gemini.mjs --brand-dir brands/{name} --max-concurrent 5

# === BACKUP: FAL.ai (if Gemini is down) ===

# Full run (~$48.00)
node skills/references/generate_ads.mjs --brand-dir brands/{name}

# Cheap test run
node skills/references/generate_ads.mjs --brand-dir brands/{name} --templates 1,7,13 --num-images 1 --resolution 1K
```

## Google Gemini API (Primary)

- **Model**: `gemini-3.1-flash-image-preview` — image editing model, accepts reference images as base64 inline
- **Endpoint**: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`
- **Auth**: `x-goog-api-key` query param or header — GEMINI_KEY stored in `.env`
- **Input**: prompt as text part + reference images as `inline_data` (base64) parts, `responseModalities: ["TEXT", "IMAGE"]`
- **Output**: Response `candidates[0].content.parts` — look for `inlineData` with base64 image
- Reference images from `product-images/` are loaded as base64 at startup (no CDN upload needed)
- Per-prompt `reference_images` array in prompts.json selects specific files; if empty, all images sent
- Aspect ratio controlled via prompt text (no explicit API parameter)
- One image per API call — script loops for `num-images`

## FAL API (Backup)

- **Model**: `fal-ai/nano-banana-2/edit` — always use `/edit` so reference images are passed
- **Queue URL**: `POST https://queue.fal.run/fal-ai/nano-banana-2/edit`
- **Auth**: `Authorization: Key {FAL_KEY}` — FAL_KEY stored in `.env`
- Product images uploaded to FAL CDN at startup, URLs passed with every request
- Cost: ~$0.08/img at 1K, ~$0.12 at 2K, ~$0.16 at 4K (doubled for dual aspect ratios)

## Script Behavior (both scripts)

- Generates **both 1:1 and 9:16** aspect ratios for every prompt automatically
- **9:16 Meta safe zones**: Meta's unified Stories/Reels safe zone (March 2026) — the top 14%, the bottom 35% and 6% each side stay clear of text and logos, because the app covers them. The live area is x 6–94%, y 14–65%. The Gemini script appends this to every 9:16 prompt; the offer-first text layer (`render-composites.mjs`) enforces it and fails any 9:16 render that leaves it. One source: `offer-treatments.json → safe_area`.
- Parallel job execution with semaphore-based concurrency limiter (`--max-concurrent`)
- Outputs organized as `outputs/{date}-V{n}/{num}-{template-name}/{1x1,9x16}/`
- Builds `gallery.html` with dark-theme image selection UI (radio buttons, expand icon, Save Selections button → `selections.json`)
- `prompts.json` supports per-prompt `reference_images` array (filenames from `product-images/`)

## Gallery Selector (Rebuild / Fix Empty Gallery)

If `gallery.html` is missing or empty for an existing output folder, rebuild it:

```bash
node skills/references/gallery-selector.mjs --output-dir brands/{name}/outputs/{version} --open
```

## Ad Copy Commands

```bash
# Rebuild gallery.html for an existing output folder
node skills/references/gallery-selector.mjs --output-dir brands/{name}/outputs/{version} --open

# After saving selections.json into the output folder:
# "create copy for {brand} {version}"
# Outputs: brands/{name}/outputs/{version}/upload.csv + copy-summary.md
```

## Ad-uploads Image Naming Rule

**Always strip `_v#` from image filenames** when copying to `Ad-uploads/`. The version suffix from image generation (e.g., `_v2`, `_v3`) causes 1x1 and 9x16 variants to have mismatched names, which prevents Meta/Ads Uploader from pairing them as placement variants on the same ad.

- `headline_1x1_v2.jpg` → `headline_1x1.jpg`
- `headline_9x16_v3.jpg` → `headline_9x16.jpg`

Strip with: `filename.replace(/_v\d+(?=\.\w+$)/, '')`

Also: `rebuild-upload-csv.mjs` expects the old dual-row CSV format — do NOT use it with the current funnel CSV (3 rows per template with both image columns). Build `Ad-uploads/`, `upload-3.csv`, and `upload-2.xlsx` inline instead. See ad-copy-builder SKILL.md Phase 5 for the correct workflow.

## ~~Telehealth Compliance (All Brands)~~ — EXAMPLE: modify or remove for your brand

~~All brands are telehealth businesses with licensed medical providers. Ad copy must:~~
~~- Never reference brand-name medications (Wegovy, Ozempic, Mounjaro, etc.)~~
~~- Use "compounded medication" language + "compounded in the USA at FDA-regulated facilities"~~
~~- Never guarantee outcomes or use "rapid/effortless" weight loss language~~
~~- Matrix Reformed pricing: always "starting at $99/mo" — never flat monthly (annual plan, $1,188/year upfront)~~
~~- Full rules: `.claude/skills/ad-copy-builder/references/compliance.md`~~

> **How to customize:** Replace the section above with your own brand's compliance rules, pricing disclaimers, and ad copy constraints. The compliance.md reference file should also be updated. If your brand has no special compliance requirements, delete this section entirely.

## Environment Constraints

- Node.js 18+ required (uses built-in `fetch`, `parseArgs`)
- ~~**Python is NOT installed** — always use Node.js for scripts~~ — modify based on your environment
- ~~No npm packages — script is zero-dependency~~ — one dependency: `xlsx` (install with `npm install`)
- ~~Windows 11, running inside VS Code with Claude Code~~ — modify based on your environment

## Brand Research Rules

- **Source-of-truth precedence** (highest wins): `gym_profile.brand_lock` (client-declared, `locked: true` is final) → client-supplied brand guidelines → screenshots → scraped CSS → web research.
- **Screenshots beat scraped CSS** for anything *not* locked — rendered colours often differ from CSS.
- Anything in `brand_lock.hard_overrides.ignore_auto_detected` is off-limits to detection entirely.
- Use Firecrawl for site scraping and screenshots
- Always visually inspect downloaded screenshots with Claude's multimodal capability before writing brand-dna.md
