# Setup & Usage Guide

How to set the panel up on a Mac and take a gym from nothing to a paused campaign on Meta.

1. [Prerequisites](#prerequisites)
2. [Install](#install)
3. [Keys](#keys)
4. [The Meta app](#the-meta-app)
5. [Start the panel](#start-the-panel)
6. [A new gym](#a-new-gym)
7. [The first campaign](#the-first-campaign)
8. [Publishing](#publishing)
9. [Results](#results)
10. [Copy](#copy)
11. [Tests](#tests)
12. [Troubleshooting](#troubleshooting)
13. [What it costs](#what-it-costs)

---

## Prerequisites

| | |
|---|---|
| **macOS** | The text layer, the website reader and the panel tests drive the Mac's installed **Google Chrome** over the DevTools protocol; iPhone HEIC uploads are converted with the Mac's `sips`. |
| **Node.js 18+** | [nodejs.org](https://nodejs.org). Built-in `fetch`, `parseArgs` and `WebSocket` are used; nothing else is downloaded. |
| **Google Chrome** | Installed in `/Applications`. Never opened for you; it runs headless. |
| **Claude Code** (optional) | The agent that built this and maintains it; `CLAUDE.md` is its record. The panel runs without it. |

## Install

```bash
git clone https://github.com/justus-ship-it/Static-Ads.git
cd Static-Ads
npm install
cp .env.example .env
```

`npm install` brings one package (`xlsx`, kept for the old CSV export). Everything else is built in.

## Keys

Edit `.env` (it is gitignored; keys never go anywhere else — a gym's profile refuses to hold one).

| Key | Needed for | Where |
|---|---|---|
| `GEMINI_KEY` | every picture, check and draft | [aistudio.google.com](https://aistudio.google.com) — a key with the image models enabled |
| `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` | the Meta link, publishing, results, the targeting import, Instagram onboarding | see [The Meta app](#the-meta-app) |
| `APIFY_TOKEN` | the swipe-intel skill only | optional |
| `FAL_KEY` | the unused backup generator | optional |

Paste only the key itself after the `=` — no label in front of it.

## The Meta app

One Meta app for the agency, Live, under the agency's own business portfolio; a system user whose partner-shared access reaches each client's ad account and Page. The panel's **Meta link** page lists these steps too.

1. In the agency's Business Manager: **an app** of type Business with the Marketing API product, switched to **Live** (ad creatives cannot be made by an app in Development mode). The app's business must pass business verification.
2. **A system user** in that portfolio (admin). Generate a token with `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`, and `instagram_basic` for the Instagram onboarding. Put the token, the app id and the app secret in `.env` as the three shared `META_*` keys.
3. **Each client** shares their ad account and Facebook Page with the agency's portfolio (Partners → Share assets), and the agency **assigns** both to the system user. Shared but not assigned is the usual reason a gym "can't be found" on the Meta link page.
4. For Singapore delivery Meta needs a verified advertiser identity on every ad set; the panel reads it from the account's existing ad sets, so the client should have run at least one ad by hand.
5. A gym may carry its own keys instead (`META_ACCESS_TOKEN_{GYM}` and so on, the folder name upper-cased); they win over the shared ones.

`node --env-file=.env skills/references/meta-api.mjs --check` prints what the token can act on, without a token value in the output.

## Start the panel

```bash
npm run panel
```

or double-click **Start Panel.command** in Finder. The Terminal shows the address and the port (`http://localhost:4310`) and keeps the panel up until Ctrl+C; after a crash it starts it again. To load new code while it runs, `kill` the panel's process id shown in the banner — the keeper restarts it and running batches carry on.

`node ui/keep-panel.mjs --port 4311` for another port. If the port already answers, a panel is running elsewhere and nothing is started.

## A new gym

Top bar → **New client**: a name and a folder slug. That makes `brands/{gym}/` with a starter profile. Then, in the rail's **Profile** section:

1. **From the website** — type the address, Read. Our own Chrome reads the home page and a few of its own pages: address and postal code (placed on the map through OneMap), phone, Instagram and Facebook links, colours measured from the page, fonts, logo candidates, every photo at its original size, sorted by what it shows. Tick what to keep, **Add to the gym**. Nothing is filed without this step.
2. **From Instagram** — the handle (pre-filled when the website named one), the latest 100 to 500 posts, photos only (videos and their covers are skipped), **Add to the gym**. Needs the Meta keys.
3. **Identity & locations**, **Brand & photography** (the photography rules: must, never, the people), **Offer wording**, **Ad defaults** (photos per batch, image model, palettes: reference · brand · both), **Targeting & budget** (budget level, pins by postal code, ages, gender per callout, detailed-targeting presets imported from the account), **Meta link** (Check the link → pick the ad account, Page, Instagram, lead form, pixel).
4. **Library → Photos & assets** — drop more photos (logo, premises, coaches, members; 1080 px minimum for the ones ads use). Select premises photos → **Survey** (free) → **Clean** (a few image calls each) removes old-brand marks, signage and weight numbers; the cleaned copies are what batches use. A photo the check still flags can be kept with **Use it anyway**.
5. **Library → Scenes** — **Draft the first scenes…**: the agent writes scenes to the gym's photography rules; approve the good ones, reject the rest with a reason. The first approval approves the library. Batches only photograph approved scenes.

The **Overview** page says what each section still needs before the gym can create, and before it can publish.

## The first campaign

**Create**: the offer in its exact words (chips remember earlier wordings), one to four location callouts, the audience callout (MEN WANTED, LADIES WANTED, or none), how many generated photos and which real ones, looks per photo, the Spread switch (exercises, ages, settings, equipment spread across the batch), optional direction (words or a reference image → the batch drafts its own scenes for approval). The preview on the right renders your words live.

**Plan (free)** shows what will be made and the most it can cost. **Generate** asks you to confirm the words and the call cap, then the **Generating** screen shows each photo as it passes its checks. **Stop** ends a run; what it finished and spent is kept.

**Review**: one ad at a time, the 1:1 and the 9:16 side by side, Keep / Exclude (K, X, Space, arrows). Excluding a photo excludes every ad it is in. **Make Stories versions** makes the 9:16 photos for the kept ads within a cap. **Change the words** re-renders the batch for free.

## Publishing

Review → **Publish to Meta →** opens the Publish screen: the campaign (name, budget), one card per location callout (pin, radius, ages, gender, preset, Estimate reach), the ads with their 9:16, **Copy** and **Headlines** (below), the destination (lead form, Instagram identity). Every change saves. **Create on Facebook, paused** confirms the counts and the day's budget, then creates images, campaign, ad sets, creatives and ads — all PAUSED — recording each as it lands. A second run makes nothing twice; changed words remake only those ads.

Switching the ads on stays in Ads Manager. For a gym whose Page is not shared yet, **Download images (zip)** gives the kept ads by ad set for building by hand.

## Results

**Results**: campaigns → ad sets → ads, each row with its photo, layout, words, targeting and Meta's numbers (spend, leads, cost per lead, CTR). **Pull results from Meta** refreshes; the account history pull reads everything in the account (whoever made it) and lets you bring the best ads into the library as references.

## Copy

**Library → Copy** is the shared copy library: skeletons of proven copies and headlines with `{GYM}`, `{OFFER}`, `{AREA}`, `{AUDIENCE}`, `{BUTTON}` and `{DURATION}` as placeholders; edit, retire with a reason, restore, or write one. Paste a copy that worked under the gym's references and it is read into the library as a skeleton in the same step.

On a Publish screen, **Draft 10 copies** / **Draft 10 headlines** writes from the library for this gym and offer, judges the drafts for clarity and recommends five of distinct angles; keep, exclude, edit, or add your own. The kept ones ride on every ad as Meta text options.

## Tests

```bash
node --test --test-concurrency=1 skills/references/*.test.mjs ui/*.test.mjs
```

Offline (a fake Gemini, a fake Graph API, a fake map; real Chrome on synthetic photos), several minutes. Run them sequentially and not while a batch is generating: each file starts its own Chrome.

## Troubleshooting

| | |
|---|---|
| **"Cannot parse access token"** | A label was pasted in front of the key in `.env`; keep only the value after `=`. |
| **"could not reach Meta (fetch failed)"** | The machine is overloaded (a full test run alongside a batch) or offline; try again when quiet. |
| **A gym is missing from the ad accounts list** | Shared with the portfolio but not assigned to the system user. Assign it in Business Manager → Users → System users. |
| **"no verified Singapore advertiser identity"** | The account has no ad set carrying one yet; publish one ad by hand in Ads Manager, then open the Publish screen again. |
| **"no usable pin"** | A pin with a postal code and no point: open Targeting & budget and Save (it is placed), or press Find. |
| **A photo was refused as low resolution** | Ads are 1080 px; ask the gym for the shoot originals, or tick Keep it anyway. |
| **"timed out: DevTools connect"** | Chrome could not start in time on a busy machine; the start is retried once on its own. |
| **The panel stopped when the Claude app's Browser pane closed** | Start it from Terminal with `npm run panel` or Start Panel.command instead. |
| **Primary texts came as one block** | Older drafts; the Copy card offers **Add line breaks**. |

## What it costs

Only image calls cost real money; checks and drafts are text/vision calls at a fraction of that. A batch with 10 generated photos uses 10–20 image calls (retries included, capped by the brief's `max_calls`); Stories versions another 10–15; cleaning a real photo 2–4. Changing words, re-rendering, planning and publishing are free. Current Gemini prices: [ai.google.dev/pricing](https://ai.google.dev/pricing).
