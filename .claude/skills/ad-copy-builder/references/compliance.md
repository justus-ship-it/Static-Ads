# Ad Copy Compliance Rules

> **CUSTOMIZE THIS FILE** for your brand's industry and compliance requirements.
> The example below shows how telehealth brands were configured as a reference.
> Replace with your own rules, or delete sections that don't apply.

---

## Universal Rules (All Brands)

### Platform Policy (Meta)
- Do not use "before and after" imagery implying dramatic body transformation as the sole focus
- Avoid targeting parameters that imply knowledge of health conditions
- Ensure the landing page copy matches the ad copy in tone and claims

### Outcomes & Claims
- **NO** guarantees of results: "guaranteed," "will [outcome]," "proven to," "eliminate," etc.
- **NO** exaggerated outcomes or unrealistic timelines
- Use softened language where appropriate: "may support," "many customers experience," "results vary"

---

## Gym / Fitness Rules (Phase 0 niche)

Fitness is a heavily restricted Meta category. Templates distilled from competitor gym ads
(numbers 51+, tagged `swipe-sourced` in template-hook-map.md) often carry a `compliance_flags`
marker — honor it in the copy.

- **No before/after body claims** as the core message. Frame around routine, community,
  consistency, energy, and showing up — not body-shape comparison. Add "results vary" /
  "individual results may vary" wherever a transformation is implied.
- **No weight-loss numbers or timelines**: never "lose 20 lbs in 30 days", "drop 2 sizes",
  "shred fat fast". Soften to "build a routine", "feel stronger", "in your first few weeks".
- **No health/medical outcome claims**: no "cure", "fix your metabolism", "boost immunity".
- **No second-person body targeting**: never "Are YOU overweight?" or "Your belly fat…".
  Speak to goals and identity ("For people who want to train consistently"), not the viewer's
  assumed body.
- **No guarantees**: no "guaranteed results", "you WILL get fit". Use trial/first-class framing.
- See also `.claude/skills/swipe-intel/references/gym-compliance.md` for the distillation-time
  guardrails that should have already abstracted these at the template level.

---

## Brand-Specific Rules

### [Your Brand Name]
- **Product**: [describe your product/service]
- **Pricing**: [how should pricing be presented in ads? Any qualifiers needed?]
- **Audiences**: [target demographics]
- **Allowed claims**: [what can you say?]
- **Avoid**: [what must you never say?]

---

## Copy Review Checklist

Before finalizing any ad, run through this list:

- [ ] No prohibited claims or language
- [ ] Pricing presented correctly with required qualifiers
- [ ] No outcome guarantees
- [ ] Required disclaimers included where applicable
- [ ] Primary text is appropriate in tone
- [ ] Landing page copy matches ad copy in claims and offers
