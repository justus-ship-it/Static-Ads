# Swipe Analysis Schema

This file defines the exact output structure the `swipe-intel` skill must produce when
distilling ranked competitor ads into reusable templates. The output is **structurally
isomorphic to the existing 50 templates** in `.claude/skills/static-ads/SKILL.md` so it
drops straight into the Phase 2 → 3 → 4 pipeline with no code changes.

---

## The 12 hook categories (map onto these ONLY)

Every distilled template's `suggested_hook_types` must use names drawn from the real
categories in `hook-bank.md`. Do not invent new category names.

`Curiosity` · `Pain` · `Proof` · `Authority` · `Contrast` · `Story` · `Urgency` ·
`Pattern` · `Identity` · `Mechanism` · `Confession` · `Myth`

(The `tof` / `bof` / `trust` style tags in hook-bank.md are *goal filters*, not categories.)

---

## Output file 1 — `swipe/{niche}/analysis/swipe-templates.json`

```jsonc
{
  "niche": "gym",
  "source_scrape_date": "2026-06-20",
  "analyzed_count": 18,            // how many shortlisted ads were inspected
  "distilled_count": 6,           // number of templates produced (cluster, don't 1:1)
  "templates": [
    {
      "proposed_number": 51,                    // continue from the current library max
      "template_name": "split-transformation-testimonial",  // kebab-case → folder + slug
      "one_line_description": "Side-by-side member journey with an overlaid quote; recurring gym swipe pattern.",
      "template_prompt": "Use the attached images as brand reference. Match exact brand colors and typography. Create: a vertical split composition. LEFT: [STARTING STATE — neutral, no body-shape claim]. RIGHT: [CURRENT STATE showing the member active and confident]. Lower third: a quote band reading \"[MEMBER QUOTE about how they FEEL / their routine — not a weight number]\". [BRAND] logo bottom right. Bright, natural gym lighting, shot 35mm f/2.8.",
      "placeholders": ["[STARTING STATE]", "[CURRENT STATE]", "[MEMBER QUOTE]", "[BRAND]"],
      "suggested_hook_types": ["Proof", "Story"],
      "layout_notes": "vertical 50/50 split, quote band lower third, logo bottom-right",
      "visual_motifs": ["gym interior", "branded apparel", "natural light"],
      "source_ad_ids": ["A1", "A4", "B1"],     // provenance for the review gallery
      "occurrence_count": 5,                     // how many shortlisted ads showed this pattern
      "compliance_flags": ["before-after-body-claim"]  // see gym-compliance.md; [] if none
    }
  ]
}
```

### Field rules
- **`proposed_number`** — start at (current library max + 1). The current library ends at
  template 50, so the first distilled template is `51`. Keep them sequential and unique.
- **`template_name`** — kebab-case, no brand names. Becomes the output folder name and the
  `template-hook-map.md` slug, e.g. `51-split-transformation-testimonial`.
- **`template_prompt`** — the heart of the schema. It MUST:
  - Begin with "Use the attached images as brand reference…" exactly like templates 1–50,
    so the client's product images flow in as references.
  - Contain only `[BRACKETED PLACEHOLDERS]` for anything brand-specific.
  - Describe **form only** (layout, composition, motif, lighting, lens) — never embed a
    competitor brand name, logo, slogan, colour value, product, or a real person.
  - Pre-soften any compliance-risky device (see `gym-compliance.md`) and record the issue
    in `compliance_flags`.
- **`suggested_hook_types`** — 1–3 entries from the 12 categories above.
- **`source_ad_ids`** — the `ad_id`s from `ranked.json` this pattern was distilled from.
  Used by the review gallery to show the human which competitor ads inspired the template.
- **`compliance_flags`** — any of: `before-after-body-claim`, `weight-loss-claim`,
  `health-outcome-claim`, `second-person-body-targeting`, `guarantee`, `unrealistic-timeline`.

### Clustering rule
Distill **recurring structure**, not one template per ad. If five shortlisted ads all use a
"coach-to-camera warning + offer burst" layout, that is ONE template with
`occurrence_count: 5` and five `source_ad_ids` — not five near-duplicates.

---

## Output file 2 — `swipe/{niche}/analysis/swipe-hooks.json`

Only for genuinely NEW hook frameworks not already in `hook-bank.md`. Same field shape as a
hook-bank entry so it can be appended under the right `## Category`.

```jsonc
{
  "hooks": [
    {
      "category": "Proof",                       // one of the 12 categories
      "name": "The Member Count Flex",
      "framework": "[N] locals already train here. [Outcome they share]. Spots open [timeframe].",
      "awareness": "Solution-aware",
      "format": "social proof, count-led",
      "use_when": "MOF — warm audience that knows the brand exists",
      "source_ad_ids": ["B1"]
    }
  ]
}
```

If no new hooks are found, write `{ "hooks": [] }`.
