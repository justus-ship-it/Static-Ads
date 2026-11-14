# Gym / Fitness Compliance — Phase 0 Distillation Guardrails

Meta heavily restricts fitness, weight-loss, and health-outcome advertising. A non-compliant
ad can get the **client's** ad account flagged or disabled — so non-compliance must be
removed at the moment competitor patterns are distilled into templates, BEFORE they ever
reach a client's `prompts.json`.

When analyzing a competitor gym ad, if it uses any device below, **abstract it into the
compliant form** in `template_prompt` and add the matching `compliance_flags` entry so the
human review gallery surfaces it.

| Competitor device (risky) | Flag | Compliant abstraction to use instead |
|---|---|---|
| Raw before/after body shots as the whole ad | `before-after-body-claim` | Journey/lifestyle framing: member active, confident, in the community. No body-shape comparison as the sole focus. Pair with "results vary" at copy stage. |
| "Lose 20 lbs in 30 days", scale numbers | `weight-loss-claim` | Outcome-neutral: energy, strength, habit, showing up. Talk about the *routine and feeling*, not a number. |
| "Cure", "fix your metabolism", medical claims | `health-outcome-claim` | Wellness/experience language: "support", "feel stronger", "build a habit". |
| "Are YOU overweight?", "Your belly fat…" | `second-person-body-targeting` | Speak to goals/identity, not the viewer's assumed body: "For people who want to train consistently." |
| "Guaranteed results", "you WILL…" | `guarantee` | Remove the guarantee; offer a trial/first-class framing instead. |
| "Instant", "effortless", "overnight" | `unrealistic-timeline` | Honest framing: "in your first few weeks", "with a consistent routine". |

## Hard rules baked into the distillation prompt
1. The distilled `template_prompt` describes **form only** — never a competitor brand name,
   logo, slogan, colour, product, or a real identifiable person.
2. Any placeholder that would invite a body-transformation claim must be worded to steer the
   client toward experience/community/identity framing (see the "compliant abstraction"
   column), not a body-metric claim.
3. Every template carrying a flag keeps that flag all the way through review → promotion →
   copy, so the downstream `ad-copy-builder` compliance pass (and `compliance.md`) can
   enforce disclaimers ("results vary", "individual results may vary") and soften language.

## Downstream enforcement (already in the pipeline)
- **Phase 2** (`static-ads/SKILL.md`): before/after disclaimer + no-guarantee rules.
- **Phase 4** (`ad-copy-builder/references/compliance.md`): gym section — no guaranteed
  weight loss, no second-person body claims, "results vary", soften timelines.
- **Always publish ads PAUSED** for human review before they go live.
