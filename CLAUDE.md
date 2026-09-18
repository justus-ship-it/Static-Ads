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
- `skills/references/gemini-busy.mjs` — **one rule for every Gemini call (2026-09-17):** a busy answer (503 "high demand", 429, 5xx, a dropped connection — `isBusy`) is waited out, 10 → 20 → 40 s (`whenGeminiFree`), each wait logged with Google's own sentence so a waiting run is seen alive; any other fault stops at once; after the last wait the busy answer is the error. Wired inside `callVision` (every vision/text call; `retry` option for tests) and inside `generateImage` (every image call, so the batch runner, Stories and the clean-up edit get it). Busy tries never count against `max_calls` or a photo's attempts. Test V19
- **A finished run ends itself:** `exitWhenWritten(code)` (plan-offer-batch, used by make-stories too) exits once the last line is written — a finished batch had lingered for minutes (the panel then shows "running" over a done batch) because Chrome's helper processes keep its stdio pipes open; `launchBrowser().close()` now destroys our pipe ends and unrefs the child as well. `BATCH_DEBUG_HANDLES=1` names what was still open. The run panel has **Copy log** (command line first, exit last) for bug reports
- `skills/references/scene-library.mjs` — the client's scene library (`brands/{gym}/scenes.json`): vocabulary and validation, `loadScenes` (never a draft unless a dry run, never a retired scene), `approveScenes`, `rejectScene` (a reason is required; the scene is retired with reason and date, never deleted), `libraryStatus`
- `skills/references/refresh-scenes.mjs` — the agent drafts scenes for the owner to approve. Directed by **gaps** (the thinnest tags for the audience), **words** (`--words`), or a **reference image** (`--reference`): the vision model reads the image once into words (activity, head count, setting, framing, where the people sit, light, mood; every word on it listed apart and kept out of the drafts), cached beside the image; the image is never attached to an image-generation call, never named to the drafter, and stays in the gitignored `brands/{gym}/references/`. One text call to the check model (JSON schema) with the gym's lock, the vocabularies, the candid and realism rules, the direction and every live and retired scene; drafts validated in code (library rules, duplicate ids, near-duplicate wording, the audience, forbidden words) and appended as drafts. A reference's framing sets the scene's pose and its empty space sets `prefer_layout`, which the planner uses as that scene's primary layout. No image calls
- **Directed batches:** `brief.direction: { words?, reference? }` — the batch drafts one scene per generated photo from it (`source: "batch:{id}"`), the dry run shows them, and a real run is refused until they are confirmed: `--approve-scenes` (the panel's Run confirmation) approves them into the library with `approved_via`; `refresh-scenes.mjs --reject id --reason` retires one and the next dry run drafts a replacement
- **Panel (ui/), Strategym-branded (navy #041131 on white, logo inline from `ui/assets/strategym-logo-vertical-navy.svg`):** a left rail — Work (Create, Review, Exports) · Library (Scenes, Photos, References) · Client (Brand, Offers, Targeting, Setup, Templates (old)) — and the client switcher in the top bar. Create is one screen: offer, location chips, audience presets, photo steppers, spread, real photos, direction, advanced; live preview, the batch summary and Plan / Generate on the right; campaign cards below. The Create screen has a Direction section (words, uploaded reference images — `PUT /api/client/{gym}/reference/{name}`, raw bytes, image by first bytes, kept in `brands/{gym}/references/`); the Scenes page holds the Scene library card (status, Refresh scenes… → the `scenes-refresh` run, every draft with Approve / Reject with a reason). **Review** (`#/{gym}/review/{batch}`): one ad at a time, the 1:1 and its 9:16 side by side, ← → to move, Keep / Exclude at the top (K, X, U to undo; Space keeps), a filmstrip, location and status filters, all on one screen; a Photos view where excluding a photo excludes every ad it appears in. Decisions save as they are made (`PUT /api/client/{gym}/batch/{id}/picks`, a patch) into `outputs/{batch}/review.json`, and `selections.json` is rewritten from it in the gallery's exact format — no Downloads step; an undecided ad counts as kept; a gallery-era `selections.json` is read as decisions; after any batch or Stories run the picks file is refreshed (renamed ads drop out, new ones count as kept). A Stories version is shown only while its file exists; "Change the words" re-renders the Stories versions too (free). **Generating** (`#/{gym}/generating/{batch}`): the run writes `outputs/{batch}/progress.json` photo by photo (`progressWriter` in plan-offer-batch; `onProgress` in generateVisuals — queued, generating, checking, retrying, passed, flagged, skipped, error; stages photos → fit → looks → render → gallery → done | failed), the page polls it, shows each photo as it passes and the calls used, re-attaches to the run's log after a reload, and passed photos can be reviewed while the rest are made. The address bar follows the screen, so Back and Forward work. Async views carry a render sequence so a late answer never paints over a newer screen. A directed batch's Run confirmation lists its drafted scenes; the server adds `--approve-scenes` only when the confirmed ids equal the drafts on disk
- **Gym profiles (schema 3):** `brands/{gym}/gym-profile.json` is filled in once and remembered; one folder per gym is the unit (switching gym in the panel switches everything). `client-config.mjs` → `validateProfile` (format only: abbreviation, dashes, website, 6-digit postal codes, hex colours, catalogue ids, `creative_defaults` by the batch's own rules, Meta ids as digits; any token, secret or password — by name or by what a Meta/Google key looks like — is refused: tokens live in .env) and `profileCompleteness` (computed, never stored: identity, brand, photos, scenes, offer wording, ad defaults → `ready_to_create`; targeting and Meta link → `ready_to_publish`, for later). `creative_defaults { locations, audiences, real_photos, generated, looks_per_photo, attempts, max_calls, spread }` pre-fill the Create screen — never the offer. `meta_assets` adds `business_id`, `lead_form_id` (ids only). The panel refuses to save a profile with format errors; `scaffold(gym, offer, { brandsDir, displayName })` writes a schema-3 starter
- `skills/references/ad-wordings.mjs` — the offer wordings a gym's ads use, in `brands/{gym}/ad-wordings.json` (its own file, so a profile save can never drop one): read from the batch history until first edited; add / edit / delete by the renderer's offer-line rules; a confirmed batch run (or new words on one) records its wording (`recordUse`). Offered as chips on Create — picking one is the owner choosing its exact words
- **Brand assets from the panel** (Library → Photos & assets, and the Brand page's logo card): files dropped on the page are filed by kind under `brands/{gym}/brand-assets/{logo,facility,coaches,members,brand,other}/` with `manifest.json` beside them (kind, original name, sha256, size, source upload | folder, date); `PUT /api/client/{gym}/asset/{kind}/{name}` takes raw bytes — an image by its first bytes (an iPhone HEIC is converted with `sips` on the Mac; an SVG only as a logo and only a plain one, served with a no-script CSP), never the same content twice (409), a taken name numbered, 25 MB cap; the first logo uploaded becomes `brand_lock.logo.files.primary`; `DELETE` moves a file to `brand-assets/_trash/` (never deleted, never served). Premises photos are surveyed (`photo-survey`, free) and cleaned (`photo-clean`, a confirmed call cap) from the page through clean-photo.mjs; the cleaned copies are what batches use
- **Brand palettes:** `client-config.mjs → brandPalettes(profile)` builds three pairings (`brand`, `brand-light`, `brand-bold`) from `brand_lock.colors` the way the reference palettes are written (the most saturated colour is the pop; a light and a dark beside it; the outline is whichever reads against the fill); `catalogueFor(profile)` gives a batch its catalogue by `creative_defaults.palettes` — `reference` (default) · `brand` · `both` (the reference set plus the three). The batch runner, Stories and the panel preview render with that catalogue (`renderComposite({ catalogue })`); the contrast guard judges brand pairings like any other. A brand mode without colours is refused at save and at run
- `skills/references/meta-api.mjs` — **the Meta link (E1, read-only).** Marketing API pinned at `META_API_VERSION` (v25.0); keys from `.env` only: the shared `META_ACCESS_TOKEN` / `META_APP_ID` / `META_APP_SECRET` are **Strategym's own Live app** ("Strategym Ads - Main", under Strategym's business portfolio, whose system user reaches every client's ad account and Page through partner sharing — one app for all gyms, the way that got past Meta's business verification); a gym may still carry its own keys, `META_ACCESS_TOKEN_SCULPT_SOCIETY`, `META_APP_ID_…`, `META_APP_SECRET_…` (the gym's slug upper-cased, `metaKeyNames`), which win over the shared ones (`metaConfig({ gym })`, `used` says which names answered; the environment wins for a name, `""` there means none; `META_GRAPH_URL` points tests at a fake); every call carries `appsecret_proof`; paging followed; Meta's errors explained in words (`explainError`) and tokens scrubbed from every message. `graphClient()` lists what the token can act on (`me`, ad accounts, Pages with their Instagram account, business portfolios) and, per gym, resolves the profile's ids (`checkLink`: account currency vs the profile's, status, the Page's lead forms — through the Page's own token, never stored — the account's pixels; problems and warnings in words). `--check [--gym x]` from the CLI. Panel: `GET /api/meta/status`, `GET /api/client/{gym}/meta-link`; the Meta page shows the setup steps until the keys exist, then Check the link and lists to pick the gym's ad account, Page (its Instagram follows), lead form, pixel and portfolio — ids and names (`meta_assets.labels`) into the profile, never a token. Nothing here writes to Meta; publishing is E2/E3
- `skills/references/meta-publish.mjs` — **one of everything (E3, first cut):** `--test-one --gym --batch --ad [--dry-run]` makes ONE campaign, ad set, creative and ad from one finished ad, every object PAUSED, placeholder words that say so, each step recorded in `outputs/{batch}/publish-test.json` as it lands (a re-run reuses what exists). `buildTestOne` is the seed of the E2 plan. **Rules Meta enforced on the first live run (2026-09-13):** lead-generation ad sets take only a 1-day click attribution window; ads delivering in Singapore need `regional_regulated_categories: ["SINGAPORE_UNIVERSAL"]` **and** `regional_regulation_identities` naming a verified advertiser as beneficiary and payer (kept in the profile as `meta_assets.singapore_beneficiary_id` / `singapore_payer_id`; `client.regulationIdentities(account)` reads them from the account's existing ad sets, since Meta has no listing edge a system user can read); ad creatives can only be made by an app in **Live** mode (Development mode is refused); a lead ad's link must be an external site (the profile's website — the Page's own address is refused); the blanket `standard_enhancements` opt-out is deprecated, so every Advantage+ feature is opted out by name (`ENHANCEMENTS`, `optOut()`; a feature Meta refuses by name is dropped and retried, recorded as `opt_out_refused`). **First full pass 2026-09-17** with the Live app: campaign, ad set, creative (every feature opted out) and ad, all PAUSED, in Sculpt Society's account. A recorded creative whose link, opt-out or Instagram identity no longer matches the plan is remade, and its ad with it, the old ids kept under `superseded`. Test M5
- **Publishing defaults (E2a, 2026-09-17)** in the profile, pre-filling the Publish screen (every one changeable there): `campaign_defaults.budget { level: adset | campaign, amount (daily, SGD 50 by default), bid_strategy (LOWEST_COST_WITHOUT_CAP = "Highest volume" | COST_CAP | LOWEST_COST_WITH_BID_CAP, with bid_cap), … }` — an ad-set budget puts `daily_budget` + `bid_strategy` on each ad set and none on the campaign (their house style), a campaign budget the other way round; `targeting_defaults.geo.radius_pins[]` each a **named Meta place** (`place_key`, `place_name` — Meta has no place search for third parties, so keys come from the account's own ad sets, `client.historyPins`, or are pasted and looked up with `client.places`) **or a point** (`lat`/`lng`, found from a postal code or address through OneMap, `GET /api/geocode?q=`, `ONEMAP_URL` in tests) with `radius_km` 1–80, `location_types` and `callouts` (the location callouts it serves — **one ad set per location callout**, `pinFor(profile, callout)`, the first pin for a callout with none of its own, said so); `targeting_defaults.demographics` ages (25–60 by default) and `callout_genders` (the owner's map over the words, `calloutGender`); `meta_assets.instagram_user_id` — the Instagram account **connected to the ad account** (`act/instagram_accounts`, what their creatives carry as `object_story_spec.instagram_user_id`), not the Page's; picked on the Meta link page, the account's only one taken automatically. **Never Advantage+ audience** (`NEVER_ADVANTAGE`). Tests P6, M2/M4, U17/U18. Panel: Targeting & budget (Budget · Pins · Audience cards), Meta link (Instagram list)
- `skills/references/meta-targeting.mjs` — **the targeting library (E2b, 2026-09-17):** `brands/{gym}/targeting-presets.json`, a gym's detailed-targeting presets (what an ad set names beyond the pin, ages and gender: `flexible_spec` groups AND-ed, `exclusions`, custom audiences in and out — `SPEC_KEYS`, never `targeting_automation`). Sources in order: **the account's own ad sets** (`importPresets`: every distinct targeting they ran — `fingerprint` ignores names and order — with Meta's own numbers from insights, all time: ad sets, spend, leads (`lead`), cost per lead, genders, ages, first/last used; named from their ad sets' "Audience: …" label, `nameFor`; two with the same label told apart by their first items; **Broad** always there with its own record), the account's **saved audiences** (joining an existing preset when the targeting is the same), and **the owner** from Meta's search (`addPreset`, `specProblems`). Re-imports keep names, notes and retirements (`renamePreset`, `retirePreset` with a reason, never deleted, `restorePreset`). `rankPresets({ gender, words })` suggests: ran for this gender first, then words matching the offer/callout, then the cheapest lead (≥ 5 leads), each with its reasons in words; `presetFor(data, profile, { audience, offer })` = the profile's `targeting_defaults.detailed_targeting.callout_presets[callout]` (`suggest` | `broad` | id) else the top suggestion else Broad; `specForAdset`. Meta client: `adsetHistory`, `adsetInsights`, `savedAudiences`, `customAudiences`, `targetingSearch` (interests from `search?type=adinterest` first — the account's `targetingsearch` matches loosely — then its behaviours/demographics), `deliveryEstimate`, `targetingSentences`. Server: `/api/client/{gym}/targeting` (GET with `?suggest=&gender=`, POST add, `/import` POST, `/search?q=`, `/estimate` POST — refuses Advantage+ before any call, `/{id}` PUT rename/notes/restore, DELETE retire). Panel: the presets card on Targeting & budget (Import from the account, table with the record, Rename / Retire…, New preset… modal with Meta's search, groups 1 / 2 (AND) / exclude, Estimate reach with Meta's sentence lines) and, per audience callout, the preset to start from. CLI `--gym x --import | --list | --search words | --suggest words --gender men`. Tests T1–T4, U19. Sculpt Society imported: 35 ad sets → 10 presets; Broad 14 ad sets at SGD 5.43/lead, the interest presets 27–57
- **The publish plan (E2c, 2026-09-18)** — `meta-publish.mjs → buildPlan({ profile, batch, kept, presets, settings })`, nothing created, no Meta call: `keptAds(batchDir)` (batch.json minus the review's excluded ads and excluded photos' ads; a Stories version only while its file exists) → one campaign (name `MMDD offer | ABBR | Audience`, the budget on it only at campaign level), **one ad set per location callout** (pin: the owner's pick for this batch, else the pin naming the callout, else the gym's first — said so; radius, ages, gender; the detailed-targeting preset: the owner's pick, else `presetFor` — the profile's per-callout choice or the suggestion with its reasons; an ad-set budget; the house name `MMDD Callout | offer | Audience: pin + 5KM, Male, preset, 25-60` so the reports read it; the spec beside the payload for the reach estimate), one ad per kept ad: **two images by placement when it has a 9:16** (`creativeFor`: `asset_feed_spec` with images labelled square / story, `PLACEMENT_RULES` — the 9:16 on facebook story + facebook_reels and instagram story + reels, the 1:1 on a default rule — bodies/titles/descriptions, `link_urls` the website, `call_to_action_types` + `call_to_actions` with the lead form, `ad_formats SINGLE_IMAGE`, `optimization_type PLACEMENT`; the shape 89 of their own 143 ads carry), the 1:1 alone via `link_data` when not; `object_story_spec { page_id, instagram_user_id }`; every enhancement opted out; `campaignWords` = the owner's words or placeholders that say so, `CTA_TYPES`. Problems (no account/Page/form, no website, no kept ads, an unusable pin, a cap without an amount, > 50 ads in an ad set) stop it; warnings (placeholders, no Stories version, the first-pin fallback, no Instagram, > 6 ads sharing a budget) are said. Settings per batch in `outputs/{batch}/publish-settings.json` (`campaign { name, level, daily, bid_strategy, bid_cap }`, `adsets[CALLOUT] { pin, radius_km, age_min, age_max, gender, preset, daily }`, `words { message, headline, description, cta }`, `destination { lead_form_id, instagram_user_id }` — an empty Instagram id means none). Server `GET/PUT /api/client/{gym}/batch/{id}/publish` (the plan, the settings, thumbnails, pins, presets, CTAs; PUT checks shapes, saves, answers the new plan). Panel: the rail's **Publish** page lists the campaigns with ads; `#/{gym}/publish/{batch}` is the Publish screen (Campaign · one card per ad set with Estimate reach · Ads with their 9:16 · Campaign words · Destination and identity with the Page's forms and Instagram accounts loaded on demand · the summary; every change saves and repaints; "Create on Facebook, paused" waits for E3); Review's foot has Publish to Meta →. Tests M6, U20
- **Panel profile pages** (rail → Profile): Overview (each section done / partly done / not started, with what it still needs), Identity & locations (several locations), Brand & photography (colours, logo preview, photo rules, words never used), Offer wording (the chips, plus the offer files as "Offer details" for copy and campaigns later), Ad defaults, Targeting & budget, Meta link (ids only). New gym: a name and folder from the top bar (`POST /api/clients {gym, display_name}`), written in the panel's clients folder
- `.claude/skills/static-ads/references/offer-{treatments,styles,palettes}.json` — the catalogues
- Tests: `node --test skills/references/render-composites.test.mjs skills/references/assign-variants.test.mjs skills/references/visual-pipeline.test.mjs skills/references/clean-photo.test.mjs skills/references/plan-offer-batch.test.mjs skills/references/check-quality.test.mjs skills/references/make-stories.test.mjs skills/references/refresh-scenes.test.mjs skills/references/client-config.test.mjs skills/references/meta-api.test.mjs skills/references/meta-targeting.test.mjs ui/server.test.mjs`

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
