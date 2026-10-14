# Static-Ads

Offer-first Meta lead ads for gyms, made in a local panel: the owner types the offer, the locations and the audience; Gemini makes the pictures; software sets every word; the kept ads go to the gym's Meta ad account paused, and the results come back per ad.

Built by [Strategym](https://strategym.sg) for its Singapore gym clients, with [Claude Code](https://claude.ai/code).

---

## What it does

```
the gym's profile ──┐
(brand, photos,     │     a batch brief                   kept ads
 scenes, targeting) │     offer · locations · audience        │
                    ▼            │                            ▼
              ┌──────────────────▼─────────────┐    ┌──────────────────────┐
              │  pictures: Gemini, no words     │    │  publish: one campaign│
              │  checked (text, people, realism)│ →  │  one ad set a location│
              │  words: rendered by software    │    │  two images a creative│
              │  1:1 feed · 9:16 Stories/Reels  │    │  everything PAUSED    │
              └─────────────────────────────────┘    └──────────┬───────────┘
                           review: keep / exclude               ▼
                                                        results per ad, copy that won
```

- **The words are never the model's.** The offer, the location callout and the audience callout are typed by the owner; the text layer sets them in eight reference layouts, nine type styles and a palette catalogue, auto-fitted inside hard boxes with a contrast guard, faces as keep-outs and Meta's 9:16 safe zone enforced. Changing the words re-renders a whole batch for free.
- **The pictures are made for the layout.** Each photo is generated for one layout's empty space from the gym's approved scene library, with the gym's own premises as the room reference, then checked: no stray lettering, nothing on the gym's never-list, the subject where the layout needs it, a real-looking body, a candid group. The gym's real photos are cleaned of old marks and used too.
- **Stories/Reels versions** of the kept ads, native 9:16 where the photo allows it, the 1:1 crop as a band where not.
- **Onboarding reads the gym's website and Instagram:** address, phone, colours measured from the page, fonts, logo, the usable photos sorted by what they show — proposed, never filed without the owner's accept.
- **Publishing through the Meta Marketing API:** one ad set per location callout with its pin, ages, gender and a detailed-targeting preset learnt from the account's own history; placement-customised creatives (1:1 everywhere, 9:16 on Stories and Reels); every Advantage+ feature opted out; up to five primary texts and five headlines per ad as Meta text options; every object paused; a resumable record so nothing is created twice.
- **Copy from a shared library:** skeletons of proven copies and headlines with the gym, offer, area, audience, button and duration as placeholders; drafts per campaign, judged for clarity, the top five recommended; the owner keeps, edits or writes their own; rules in code (the offer named exactly, no free trial, no price, no guarantee, Meta's lengths).
- **Results:** campaigns → ad sets → ads as Ads Manager shows them, with each ad's photo, layout, words and targeting beside Meta's numbers; the account's history imported, its best ads brought into the library.

## Tech

| | |
|---|---|
| Panel | One HTML page and one Node server (`ui/`), no framework, no build step. Every rule lives server-side. |
| Pictures | Google Gemini image models (`gemini-3-pro-image-preview` by default) |
| Checks, drafting | Gemini vision/text (`gemini-3.6-flash`), JSON-schema answers, verified in code |
| Text layer | HTML/CSS rendered by the Mac's installed Chrome over the DevTools protocol |
| Meta | Marketing API v25 through a Live app and a system user with partner-shared access |
| Geocoding | OneMap (Singapore, no key) |
| Runtime | macOS, Node 18+, one npm dependency (`xlsx`, legacy) |

## Quick start

```bash
git clone https://github.com/justus-ship-it/Static-Ads.git
cd Static-Ads
npm install
cp .env.example .env     # add GEMINI_KEY; the Meta keys when you publish
npm run panel            # http://localhost:4310, kept running until Ctrl+C
```

Or double-click **Start Panel.command** in Finder. [SETUP-GUIDE.md](SETUP-GUIDE.md) walks through the keys, the Meta app and the first campaign.

## Project structure

```
Static-Ads/
├── ui/
│   ├── server.mjs              # the panel's server: routes, runs, every rule
│   ├── app.html                # the panel: one page, hash-routed
│   ├── keep-panel.mjs          # keeps the panel running from Terminal
│   └── server.test.mjs
├── skills/references/          # the pipeline, one module per step, tests beside them
│   ├── render-composites.mjs   # the text layer (layouts × styles × palettes)
│   ├── visual-prompts.mjs      # pictures-only prompts composed around a layout
│   ├── generate-visuals.mjs    # generate → check, hard call budget
│   ├── check-visual.mjs        # stray text, never-list, placement, people
│   ├── check-quality.mjs       # realism and candid groups
│   ├── clean-photo.mjs         # the gym's real photos, old marks removed
│   ├── plan-offer-batch.mjs    # a batch end to end
│   ├── make-stories.mjs        # 9:16 versions of the kept ads
│   ├── scene-library.mjs, refresh-scenes.mjs
│   ├── read-website.mjs, read-instagram.mjs
│   ├── client-config.mjs       # gym profiles, brand palettes, pins
│   ├── meta-api.mjs, meta-targeting.mjs, meta-publish.mjs, meta-results.mjs
│   ├── draft-copy.mjs, copy-library.mjs
│   ├── reference-shots.mjs     # the shot guide read from reference ads
│   └── generate_ads_gemini.mjs # the Gemini image call (from the original generator)
├── .claude/skills/static-ads/references/
│   └── offer-{treatments,styles,palettes}.json   # the catalogues
├── assets/fonts/               # open-licence fonts for the text layer
├── brands/{gym}/               # one folder per gym — gitignored
├── library/                    # the shared copy library, the shot guide — gitignored
├── CLAUDE.md                   # the full record of how it works, for Claude Code
└── SETUP-GUIDE.md
```

`brands/`, `library/`, `swipe/` and `Reference-Sep-10/` hold client data and other operators' ads for analysis; none of it is committed.

## Tests

```bash
node --test --test-concurrency=1 skills/references/*.test.mjs ui/*.test.mjs
```

Offline: a fake Gemini, a fake Graph API and a fake map; real Chrome on synthetic photos. Run sequentially — each file drives its own Chrome.

## Where it came from

The repo began as [keith-wohnv's](https://github.com/keith-wohnv/Static-Ads) template-library generator (50 ad templates, Gemini drawing text into the picture, an Ads Uploader CSV). That path is kept under `.claude/skills/static-ads` and `ad-copy-builder` but no longer runs from the panel; the Gemini image call and the gallery builder survive from it.

## License

[MIT](LICENSE).
