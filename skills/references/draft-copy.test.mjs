/**
 * Tests for the copy drafter (draft-copy.mjs): the rules in code, the references shown, the file
 * lifecycle, the text options per ad — offline, with a fake model.
 *
 *   node --test skills/references/draft-copy.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsLayout, breakBySentence, layoutTexts, relayoutCopies, flatCopies, buildLayoutPrompt, buttonPlaceholder, areaPlaceholder, fillButton, copyRules, copyProblems, referencesFor, addCopyRef, editCopyRef, buildDraftPrompt, draftCopy, readCopy, keptCopies, keepRecommended, recommend, judgeDrafts, addCopy, decideCopy, textOptionsFor, ALWAYS_NEVER, MAX_OPTIONS, offerDocFor, analyseCopy, ANGLES } from "./draft-copy.mjs";

const OFFER = "12 Week Total Body Reset";
const profile = { display_name: "Sculpt Society", brand_lock: { voice: { adjectives: ["direct", "coach-led"], never: ["hype", "fitspo language", "complimentary session"] } } };
const gym = () => {
  const d = mkdtempSync(join(tmpdir(), "copy-"));
  writeFileSync(join(d, "gym-profile.json"), JSON.stringify(profile));
  mkdirSync(join(d, "offers")); writeFileSync(join(d, "offers", "tbr.json"), JSON.stringify({ name: OFFER, messaging: { must_not_say: ["melt fat", "shred"], must_say: [] } }));
  writeFileSync(join(d, "copy-references.json"), JSON.stringify({ refs: [
    { id: "meta-1", source: "account", headline: "Katong Ladies - your reset", message: "Ladies in Katong. If nothing worked, it is not you.", results: { leads: 155, cost_per_lead: 20.49 } },
    { id: "meta-2", source: "account", headline: "Same words again", message: "Ladies in Katong. If nothing worked, it is not you.", results: { leads: 126, cost_per_lead: 24.06 } },
    { id: "meta-3", source: "account", headline: "Stars", message: "", results: { leads: 510, cost_per_lead: 5, abroad: "BD" } },
    { id: "meta-4", source: "account", headline: "No leads", message: "words", results: { leads: 0, cost_per_lead: null } },
    { id: "meta-5", source: "account", headline: "Headline only, many leads", message: "", results: { leads: 200, cost_per_lead: 8 } },
    { id: "meta-6", source: "account", headline: "Book your free trial now", message: "A free trial that worked once, but the rules forbid it now. Tap Sign up.", results: { leads: 40, cost_per_lead: 6 } },
    { id: "meta-7", source: "account", headline: "Too few leads", message: "Three leads is not a record worth learning from, whatever the cost.", results: { leads: 3, cost_per_lead: 4 } },
  ] }));
  mkdirSync(join(d, "outputs", "b1"), { recursive: true });
  return d;
};
const ok = (over = {}) => ({ message: `Ladies in Bishan, if the gym never stuck, it was the plan. The ${OFFER} gives you a coach and a structure. Tap Sign up.`, headline: `${OFFER} in Bishan`, description: "Coach-led, 12 weeks", ...over });

test("C1 the rules are in code: the offer named exactly, nothing from the never-lists (the gym's voice, the offer's must-not-say, the standing rules), no price, no weight number, no dashes, Meta's lengths", () => {
  const rules = copyRules(profile, { messaging: { must_not_say: ["melt fat"] } });
  assert.ok(ALWAYS_NEVER.every((n) => rules.never.includes(n)) && rules.never.includes("hype") && rules.never.includes("melt fat"));
  assert.deepEqual(copyProblems(ok(), { offer: OFFER, rules }), []);
  const bad = (over, re) => assert.ok(copyProblems(ok(over), { offer: OFFER, rules }).some((p) => re.test(p)), `${JSON.stringify(over)} → ${copyProblems(ok(over), { offer: OFFER, rules }).join(" | ")}`);
  bad({ headline: "Reset in Bishan", message: "Twelve week reset. Tap sign up." }, /not named exactly/);
  bad({ message: `Free trial this week for the ${OFFER}.` }, /says "free trial"/);
  bad({ message: `Melt fat with the ${OFFER}.` }, /says "melt fat"/);
  bad({ message: `The ${OFFER} for $99.` }, /a price/);
  bad({ message: `The ${OFFER} - just SGD 199 a month.` }, /a price/);
  bad({ message: `Lose 10 kg with the ${OFFER}.` }, /weight-loss number/);
  bad({ message: `Before and after photos - the ${OFFER}.` }, /says "before and after"/);
  bad({ headline: `${OFFER} — Bishan` }, /em or en dash/);
  bad({ message: "" }, /no primary text/); bad({ kind: "headline", message: "", headline: "" }, /no headline/); assert.deepEqual(copyProblems({ kind: "headline", message: "", headline: "Start today", description: "" }, { offer: OFFER, rules: copyRules(profile) }), [], "a headline need not name the offer");
  bad({ message: `Coach {COACH} runs the ${OFFER} in {AREA}. Tap {BUTTON}.` }, /unknown placeholder \{COACH\}/); assert.deepEqual(copyProblems(ok({ message: `Ladies in {AREA}: the ${OFFER}. Tap {BUTTON}.` }), { offer: OFFER, rules: copyRules(profile) }), []);
  bad({ headline: "x".repeat(300) + OFFER }, /headline over 255/);
  assert.deepEqual(copyProblems(ok({ message: `Trials are over. The ${OFFER}.` }), { offer: OFFER, rules }).filter((p) => /trial/.test(p)), [], "a word inside another word is not the word");
});

test("C2 the references shown to the model: the owner's first, then the account's by cost per lead, home country only, with leads, no duplicates, at most ten; the owner adds, notes and retires references", () => {
  const d = gym();
  try {
    assert.deepEqual(referencesFor(d).map((r) => r.id), ["meta-1"], "the duplicate wording, the Bangladesh one, the one with no leads, the headline-only one, the free-trial one and the three-lead one are left out");
    const own = addCopyRef(d, { message: "My own winner. Tap the button.", headline: "Own headline", note: "pain hook" });
    assert.deepEqual(referencesFor(d).map((r) => r.id), [own.id, "meta-1"], "the owner's first");
    assert.throws(() => addCopyRef(d, { message: "My own winner. Tap the button.", headline: "Own headline" }), /already here/);
    const pasted = addCopyRef(d, { message: "Pasted as written — dashes and all", headline: "h" }); assert.equal(pasted.message, "Pasted as written — dashes and all", "a reference is stored as pasted (analysis only)"); editCopyRef(d, pasted.id, { retired: true });
    assert.throws(() => addCopyRef(d, { message: "", headline: "" }), /needs a primary text or a headline/);
    editCopyRef(d, own.id, { note: "changed" }); assert.equal(referencesFor(d)[0].note, "changed");
    editCopyRef(d, own.id, { retired: true }); assert.deepEqual(referencesFor(d).map((r) => r.id), ["meta-1"]);
    for (let i = 0; i < 12; i++) addCopyRef(d, { message: `Reference number ${i} with its own words.`, headline: `H${i}` });
    assert.equal(referencesFor(d).length, 10);
    assert.equal(offerDocFor(d, OFFER).name, OFFER); assert.equal(offerDocFor(d, "nope"), null);
    // The references are analysis material now: the drafter's prompt is built from the library's skeletons, never from them (C3).
    assert.equal(typeof buildDraftPrompt, "function");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C3 drafting from the library: the prompt carries the skeletons of the kind, the offer, the audience, the areas as {AREA}, the button as {BUTTON} — never a gym's own past ads; one text call (a second for a shortfall); drafts that break a rule, carry an unknown placeholder or repeat one are dropped with the reason; each draft names the skeleton it follows; a judge call rates them and five are recommended, one per angle first; keep the recommended in one click; keep / exclude / edit / undo; the owner's own copy is checked and kept at once; headlines are their own list; kept ones come back in the order kept", async () => {
  const d = gym(), out = join(d, "outputs", "b1");
  const skeletons = [
    { id: "lib-1", kind: "copy", angle: "call-out", text: "{AUDIENCE} in {AREA}, if nothing stuck it was the plan.\n\nOur {OFFER} gives you:\n✔ A coach\n\nTap {BUTTON}." },
    { id: "lib-2", kind: "copy", angle: "pain", text: "Starting over every Monday? The problem is structure. {OFFER} fixes that. Tap {BUTTON}." },
    { id: "lib-3", kind: "copy", angle: "benefits", text: "Stronger, leaner, steadier: {DURATION} with {GYM}." },
  ];
  const heads = [{ id: "lib-h1", kind: "headline", angle: "call-out", text: "{AUDIENCE} in {AREA}: {OFFER}" }, { id: "lib-h2", kind: "headline", angle: "structure", text: "{DURATION} of Real Progress" }];
  const m = (s) => `Ladies in {AREA}, ${s} The ${OFFER} gives you a coach. Tap {BUTTON}.`;
  try {
    let calls = 0; const prompts = [], schemas = [];
    const ask = async (img, text, schema) => { calls++; prompts.push(text); schemas.push(schema); assert.equal(img, null);
      if (schema.properties.ratings) return { ratings: [...text.matchAll(/^ID (c-[0-9a-f]+)$/gm)].map((x, i) => ({ id: x[1], clarity: [9, 7, 8, 6, 5, 9, 4][i] ?? 5, why: `reason ${i} — plain` })) };
      if (calls === 1) return { drafts: [
        { message: m("if the plan never stuck, it was the plan."), angle: "pain", from: 2 },
        { message: m("if the plan never stuck, it was the plan."), angle: "pain", from: 2 },                       // a repeat
        { message: `Free trial of the ${OFFER}. Tap {BUTTON}.`, angle: "pain", from: 1 },                        // the rules
        { message: `Coach {COACH} runs the ${OFFER}. Tap {BUTTON}.`, angle: "coach-led", from: 1 },              // an unknown placeholder
        { message: m("your coach knows your name."), angle: "coach-led", from: 1 },
        { message: m("three sessions a week, planned for you."), angle: "structure", from: 9 },                     // no such skeleton
      ] };
      if (calls === 2) return { drafts: [{ message: m("Tap Learn More and start."), angle: "pain", from: 3 }, { message: m("you are not starting from zero."), angle: "identity", from: 3 }, { message: m("busy weeks are the point."), angle: "time-poor", from: 2 }] };
      if (calls === 4) return { drafts: [{ headline: `Ladies in {AREA}: ${OFFER}`, description: "", angle: "call-out", from: 1 }, { headline: "12 weeks of real progress — coached", description: "Coach-led", angle: "structure", from: 2 }, { headline: "Free trial this week", description: "", angle: "pain", from: 2 }] };
      return { drafts: [] }; };
    const r = await draftCopy({ brandDir: d, batchDir: out, offer: OFFER, audience: "LADIES WANTED", locations: ["BISHAN", "ANG MO KIO"], count: 6, skeletons, ask });
    assert.deepEqual([r.added.length, r.calls, r.skeletons, r.total, r.dropped.map((x) => x.why.split("; ")[0])], [6, 3, 3, 6, ["reads like one already here", 'says "free trial"', "unknown placeholder {COACH} (a draft may carry {AREA} and {BUTTON} only)"]], "two draft calls and one judge call");
    assert.match(prompts[0], /SKELETONS[^]*--- SKELETON 1 \[call-out\]\n\{AUDIENCE\} in \{AREA\}[^]*--- SKELETON 3 \[benefits\]/); assert.match(prompts[0], /BISHAN, ANG MO KIO[^]*\{AREA\}/); assert.match(prompts[0], /\{BUTTON\}[^]*"Sign up"/); assert.match(prompts[0], /Sculpt Society/);
    assert.doesNotMatch(prompts[0], /Katong/, "the gym's own past ads are not in the prompt"); assert.doesNotMatch(prompts[0], /REFERENCES/);
    assert.match(prompts[1], /ALREADY WRITTEN.*if the plan never stuck/, "the second call is told what exists");
    assert.deepEqual(schemas[0].properties.drafts.items.properties.angle.enum, ANGLES); assert.ok(schemas[2].properties.ratings, "the third call is the judge");
    const c = readCopy(out);
    assert.deepEqual(c.drafts.map((x) => [x.kind, x.status, x.source, x.angle, x.from]), [["copy", "draft", "agent", "pain", "lib-2"], ["copy", "draft", "agent", "coach-led", "lib-1"], ["copy", "draft", "agent", "structure", null], ["copy", "draft", "agent", "pain", "lib-3"], ["copy", "draft", "agent", "identity", "lib-3"], ["copy", "draft", "agent", "time-poor", "lib-2"]]);
    assert.equal(c.drafts[3].message, m("Tap {BUTTON} and start."), "a button named literally becomes {BUTTON}");
    // Recommended: one per angle first (pain 9, structure 8, coach-led 7, identity 5 … time-poor 9 outranks), then the rest.
    const recs = c.drafts.filter((x) => x.recommended).sort((p, q) => p.recommended.rank - q.recommended.rank);
    assert.deepEqual(recs.map((x) => [x.recommended.rank, x.angle, x.clarity]), [[1, "pain", 9], [2, "time-poor", 9], [3, "structure", 8], [4, "coach-led", 7], [5, "identity", 5]], "five distinct angles; the second pain draft (6) is left out for the identity one (5)");
    assert.equal(recs[0].recommended.why, "reason 0 - plain"); assert.equal(c.drafts.filter((x) => x.clarity != null).length, 6);
    assert.deepEqual(keptCopies(out), []);
    // One click keeps the five, in rank order.
    const kept = keepRecommended(out, "copy"); assert.deepEqual(kept.map((x) => x.recommended.rank), [1, 2, 3, 4, 5]);
    assert.deepEqual(keptCopies(out).map((x) => x.recommended.rank), [1, 2, 3, 4, 5]); assert.throws(() => keepRecommended(out, "headline"), /nothing recommended among the headlines/);
    // Headlines: their own list, their own rules (a headline need not name the offer; free trial still out).
    const h = await draftCopy({ brandDir: d, batchDir: out, kind: "headline", offer: OFFER, audience: "LADIES WANTED", locations: ["BISHAN"], count: 3, skeletons: heads, ask });
    assert.deepEqual([h.added.length, h.dropped.map((x) => x.why.split("; ")[0]), h.recommended.length], [2, ['says "free trial"'], 2]);
    assert.match(prompts[3], /headlines[^]*1\. \[call-out\] \{AUDIENCE\} in \{AREA\}: \{OFFER\}/); assert.ok(schemas[3].properties.drafts.items.properties.headline && !schemas[3].properties.drafts.items.properties.message);
    assert.deepEqual(readCopy(out).drafts.filter((x) => x.kind === "headline").map((x) => [x.headline, x.description, x.message]), [[`Ladies in {AREA}: ${OFFER}`, "", ""], ["12 weeks of real progress - coached", "Coach-led", ""]]);
    assert.deepEqual(keptCopies(out, "headline"), []); assert.equal(keptCopies(out).length, 5, "kept copies are not touched by the headlines");
    // Decisions and edits.
    const [a, b] = c.drafts;
    decideCopy(out, a.id, { status: "exclude" }); assert.deepEqual(keptCopies(out).map((x) => x.recommended.rank), [2, 3, 4, 5]);
    assert.throws(() => decideCopy(out, b.id, { message: `Free trial ${OFFER}` }, { offer: OFFER, profile }), /free trial/);
    assert.throws(() => decideCopy(out, b.id, { message: `The ${OFFER} for {COACH}` }, { offer: OFFER, profile }), /unknown placeholder/);
    decideCopy(out, b.id, { message: `Edited: the ${OFFER} in {AREA}. Tap Sign Up now.` }, { offer: OFFER, profile });
    assert.equal(readCopy(out).drafts.find((x) => x.id === b.id).message, `Edited: the ${OFFER} in {AREA}. Tap {BUTTON} now.`);
    decideCopy(out, a.id, { status: "draft" }); assert.equal(readCopy(out).drafts.find((x) => x.id === a.id).status, "draft");
    assert.throws(() => decideCopy(out, "nope", { status: "keep" }), /no copy nope/);
    assert.throws(() => decideCopy(out, a.id, { status: "maybe" }), /keep, exclude or draft/);
    const own = addCopy(out, { message: `Typed by hand — the ${OFFER}. Tap Sign up.`, headline: "" }, { offer: OFFER, profile });
    assert.deepEqual([own.kind, own.message, own.source, own.status, keptCopies(out).length], ["copy", `Typed by hand - the ${OFFER}. Tap {BUTTON}.`, "owner", "keep", 5], "the owner's dashes become hyphens; the button named becomes {BUTTON}");
    const ownH = addCopy(out, { kind: "headline", headline: "Your reset starts in {AREA}" }, { offer: OFFER, profile });
    assert.deepEqual([ownH.kind, ownH.headline, keptCopies(out, "headline").map((x) => x.id)], ["headline", "Your reset starts in {AREA}", [ownH.id]]);
    assert.throws(() => addCopy(out, { message: "no offer here" }, { offer: OFFER, profile }), /not named exactly/);
    assert.throws(() => addCopy(out, { kind: "poem", message: "x" }, { offer: OFFER, profile }), /kind is copy or headline/);
    await assert.rejects(draftCopy({ brandDir: d, batchDir: out, offer: "", count: 3, skeletons, ask }), /offer's exact words/);
    await assert.rejects(draftCopy({ brandDir: d, batchDir: out, offer: OFFER, count: 0, skeletons, ask }), /count must be 1 to 20/);
    await assert.rejects(draftCopy({ brandDir: d, batchDir: out, offer: OFFER, count: 3, skeletons: [], ask }), /no copy skeletons yet/);
    assert.ok(!existsSync(join(out, "copy.json.tmp")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C4 text options per ad: up to five of the kept copies each; more kept than the number rotates across the ads so every copy runs; one option per ad rotates one at a time", () => {
  const kept = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
  assert.deepEqual(textOptionsFor(kept.slice(0, 3), 5, 0).map((x) => x.id), ["a", "b", "c"], "fewer kept than options: all of them on every ad");
  assert.deepEqual(textOptionsFor(kept.slice(0, 3), 5, 7).map((x) => x.id), ["a", "b", "c"]);
  assert.deepEqual([0, 1, 2].map((i) => textOptionsFor(kept, 5, i).map((x) => x.id).join("")), ["abcde", "fgabc", "defga"], "seven kept, five per ad: rotating");
  assert.deepEqual([0, 1, 2, 7].map((i) => textOptionsFor(kept, 1, i).map((x) => x.id).join("")), ["a", "b", "c", "a"], "one per ad, each copy in turn");
  assert.deepEqual(textOptionsFor(kept, 9, 0).length, MAX_OPTIONS, "never more than five");
  assert.deepEqual(textOptionsFor([], 5, 0), []);
});

test("C5 a pasted reference is read by the model: its angle from the fixed list and a note on why it works (dashes made plain, capped); an angle outside the list is no angle; nothing to read is refused", async () => {
  const asked = [];
  const ask = async (img, prompt, schema) => { asked.push({ img, prompt, schema }); return { angle: "pain", note: "Opens on what is not working — then lists the fix.  Ends on the button." }; };
  const r = await analyseCopy({ message: "If nothing stuck, it was the plan.", headline: "A reset", ask });
  assert.deepEqual(r, { angle: "pain", note: "Opens on what is not working - then lists the fix. Ends on the button." });
  assert.equal(asked[0].img, null, "a text call"); assert.match(asked[0].prompt, /If nothing stuck/); assert.deepEqual(asked[0].schema.properties.angle.enum, ANGLES);
  assert.equal((await analyseCopy({ message: "x", ask: async () => ({ angle: "hype", note: "n" }) })).angle, null);
  await assert.rejects(analyseCopy({ ask }), /nothing to analyse/);
});

test("C6 the button in the copy is a placeholder: every way of naming it (tap Learn More, click the \"Sign Up\" button, a quoted name) becomes {BUTTON}; the plan fills it with the chosen call to action's name; what a draft wrote before the rule reads as {BUTTON} too", () => {
  assert.equal(buttonPlaceholder("Tap Learn More to start. Click the \"Sign Up\" button. Hit “Apply Now” now. Press the Book now button today."), "Tap {BUTTON} to start. Click the {BUTTON}. Hit {BUTTON} now. Press the {BUTTON} today.");
  assert.equal(buttonPlaceholder("Learn more about us in the studio"), "Learn more about us in the studio", "the words alone, not a button, stay");
  assert.equal(buttonPlaceholder("tap {BUTTON} to start"), "tap {BUTTON} to start");
  assert.equal(fillButton("Tap {BUTTON} now, then {BUTTON} again in {AREA}", "Apply now"), "Tap Apply now now, then Apply now again in {AREA}", "only the button is filled here");
  assert.equal(areaPlaceholder("LADIES WANTED in Ang Mo Kio. Join us in ANG MO KIO today.", ["BISHAN", "ANG MO KIO"]), "LADIES WANTED in {AREA}. Join us in {AREA} today.", "one of the batch's areas named, whatever the case, becomes {AREA}");
  assert.equal(areaPlaceholder("Ladies in Ang Mo Kio and Bishan", ["BISHAN", "ANG MO KIO"]), "Ladies in Ang Mo Kio and Bishan", "several areas named: the copy addresses the whole campaign and is left alone");
  assert.equal(areaPlaceholder("Bishanites unite", ["BISHAN"]), "Bishanites unite", "a word that only starts with the area is not the area");
  assert.equal(areaPlaceholder("Ladies in Bishan", []), "Ladies in Bishan");
  const d = gym(), out = join(d, "outputs", "b1");
  writeFileSync(join(out, "copy.json"), JSON.stringify({ drafts: [{ id: "c-old", message: "Old draft. Tap Learn More to begin.", headline: "H", description: "", status: "keep" }] }));
  assert.equal(readCopy(out).drafts[0].message, "Old draft. Tap {BUTTON} to begin.");
  assert.match(readFileSync(join(out, "copy.json"), "utf8"), /Tap Learn More/, "the file itself is untouched");
});

test("C7 the recommendation is diversity first, then clarity: the clearest of each distinct angle, then the clearest of the rest; unrated drafts are never recommended; fewer drafts than five gives fewer", () => {
  const ds = [["a", "pain"], ["b", "pain"], ["c", "benefits"], ["d", "benefits"], ["e", null], ["f", "call-out"], ["g", "call-out"]].map(([id, angle], i) => ({ id, angle, drafted: String(i) }));
  const ratings = { a: { clarity: 6, why: "" }, b: { clarity: 9, why: "" }, c: { clarity: 8, why: "" }, d: { clarity: 8, why: "" }, e: { clarity: 7, why: "" }, f: { clarity: 3, why: "" } };
  assert.deepEqual(recommend(ds, ratings, 5).map((p) => [p.rank, p.id]), [[1, "b"], [2, "c"], [3, "e"], [4, "f"], [5, "d"]], "one per angle (b, c, e, f) before the second benefits one; g unrated is out; a (6) loses to d (8)");
  assert.deepEqual(recommend(ds.slice(0, 2), ratings, 5).map((p) => p.id), ["b", "a"]);
  assert.deepEqual(recommend(ds, {}, 5), []);
});

test("C8 line breaks: the prompt shows each skeleton laid out as it is and asks for that layout; a primary text that still comes as one block gets its line breaks from one more call, used only when nothing but the spacing changed (else by rule, sentence by sentence); a batch's existing one-block texts are repaired the same way, ids and status kept; an area name with a dot or brackets becomes {AREA}", async () => {
  const d = gym(), out = join(d, "outputs", "b8");
  const skeletons = [{ id: "lib-1", kind: "copy", angle: "call-out", text: "{AUDIENCE} in {AREA}, read this.\n\nOur {OFFER} gives you:\n✔ A coach\n✔ A plan\n\n\n\nTap {BUTTON}." }];
  try {
    // The prompt: the skeleton with its own line breaks (never " / "), and the layout asked for; headlines stay one line each.
    const { prompt } = buildDraftPrompt({ profile: { display_name: "Test Gym" }, kind: "copy", offer: OFFER, audience: "LADIES", locations: ["BISHAN"], rules: copyRules({}, null), skeletons, count: 2 });
    assert.ok(prompt.includes("--- SKELETON 1 [call-out]\n{AUDIENCE} in {AREA}, read this.\n\nOur {OFFER} gives you:\n✔ A coach\n✔ A plan\n\nTap {BUTTON}."), prompt);
    assert.match(prompt, /LAYOUT: set each primary text out the way its skeleton is set out above/);
    assert.ok(!buildDraftPrompt({ profile: {}, kind: "headline", offer: OFFER, audience: null, locations: [], rules: copyRules({}, null), skeletons: [{ id: "h", kind: "headline", angle: "pain", text: "A\nB" }], count: 2 }).prompt.includes("LAYOUT:"));
    // What counts as one block, and the rule's own breaks.
    const flat = `LADIES in {AREA}, your time is now. Our ${OFFER} at Test Gym helps you build strength and feel confident without crazy diets. ✅ Get leaner and stronger. ✅ Eat better with no guilt. ✅ Stay consistent with a coach beside you. Tap {BUTTON} to get started.`;
    assert.deepEqual([needsLayout(flat), needsLayout("Short one. Tap {BUTTON}."), needsLayout(flat.replace(". ✅", ".\n✅")), needsLayout(null)], [true, false, false, false]);
    const byRule = breakBySentence(flat);
    assert.equal(byRule.replace(/\s+/g, ""), flat.replace(/\s+/g, ""), "only spacing changes");
    assert.ok(byRule.startsWith("LADIES in {AREA}, your time is now.\n\nOur ") && byRule.split("\n\n").length >= 3);
    // The model's breaks are taken when the words are untouched; an answer that changes a word is not.
    const good = flat.replace("now. Our", "now.\n\nOur").replace(/ ✅/g, "\n✅").replace(" Tap", "\n\nTap");
    let asked = [];
    let r = await layoutTexts([flat, flat], { ask: async (img, text, schema) => { asked.push(text); assert.equal(img, null); return { texts: [{ index: 0, text: good }, { index: 1, text: good.replace("confident", "amazing") }] }; } });
    assert.deepEqual(r.map((x) => x.how), ["model", "rule"]); assert.equal(r[0].text, good); assert.equal(r[1].text, byRule);
    assert.ok(asked[0].includes("TEXT 0\n" + flat) && /You may only turn spaces into line breaks/.test(asked[0]));
    assert.deepEqual((await layoutTexts([flat], { ask: async () => { throw new Error("busy"); } })).map((x) => x.how), ["rule"], "a model that cannot be reached still leaves it readable");
    assert.deepEqual((await layoutTexts([flat], { ask: async () => ({ texts: [{ index: 0, text: flat }] }) })).map((x) => x.how), ["rule"], "the same block back is no layout");
    // Drafting: the block is laid out before it is stored and judged (one extra call, only when needed).
    const kinds = [];
    const ask = async (img, text, schema) => {
      if (schema.properties.ratings) { kinds.push("judge"); assert.ok(text.includes("now.\n\nOur"), "the judge reads the laid-out text"); return { ratings: [...text.matchAll(/^ID (c-[0-9a-f]+)$/gm)].map((x) => ({ id: x[1], clarity: 8, why: "plain" })) }; }
      if (schema.properties.texts) { kinds.push("layout"); return { texts: [{ index: 0, text: good }] }; }
      kinds.push("draft"); return { drafts: [{ message: flat, angle: "call-out", from: 1 }, { message: `Ladies in {AREA}, start small.\n\nThe ${OFFER} gives you a coach.\n\nTap {BUTTON}.`, angle: "beginner", from: 1 }] };
    };
    mkdirSync(out, { recursive: true });
    const res = await draftCopy({ brandDir: d, batchDir: out, kind: "copy", offer: OFFER, audience: "LADIES", locations: ["BISHAN"], count: 2, skeletons, ask });
    assert.deepEqual([kinds, res.calls, res.added.length], [["draft", "layout", "judge"], 3, 2]);
    let stored = readCopy(out).drafts;
    assert.equal(stored[0].message, good); assert.ok(stored.every((x) => x.message.includes("\n")));
    assert.deepEqual(flatCopies(out), []);
    // Repairing a batch drafted before: drafts and kept ones, never an excluded one; nothing else about them changes.
    const out2 = join(d, "outputs", "b9"); mkdirSync(out2, { recursive: true });
    const old = (id, status, message) => ({ id, kind: "copy", message, headline: "", description: "", angle: "pain", from: "lib-1", source: "agent", status, drafted: "2026-10-04T00:00:00.000Z", edited: null, recommended: id === "c-1" ? { rank: 1, why: "x", clarity: 9 } : null, ...(status === "keep" ? { kept_at: "2026-10-04T01:00:00.000Z" } : {}) });
    writeFileSync(join(out2, "copy.json"), JSON.stringify({ drafts: [old("c-1", "keep", flat), old("c-2", "draft", flat + " Again."), old("c-3", "exclude", flat + " No."), old("c-4", "draft", good), { id: "h-1", kind: "headline", message: "", headline: "x".repeat(40), description: "", status: "draft" }] }));
    assert.deepEqual(flatCopies(out2).map((x) => x.id), ["c-1", "c-2"]);
    let calls = 0;
    const fix = await relayoutCopies(out2, { ask: async (img, text) => { calls++; assert.ok(!text.includes(" No.") && !text.includes("x".repeat(40))); return { texts: [{ index: 0, text: good }] }; } });
    assert.deepEqual([fix, calls], [{ fixed: 2, by_model: 1, by_rule: 1, calls: 1 }, 1]);
    stored = readCopy(out2).drafts;
    assert.deepEqual(stored.map((x) => [x.id, x.status, x.message.includes("\n")]), [["c-1", "keep", true], ["c-2", "draft", true], ["c-3", "exclude", false], ["c-4", "draft", true], ["h-1", "draft", false]]);
    assert.deepEqual([stored[0].recommended.rank, stored[0].kept_at, stored[0].message], [1, "2026-10-04T01:00:00.000Z", good]);
    assert.deepEqual(await relayoutCopies(out2, { ask: async () => { throw new Error("no call when nothing is left to do"); } }), { fixed: 0, by_model: 0, by_rule: 0, calls: 0 });
    // The area's name is matched literally, whatever characters it holds (the escape was once corrupted in this file).
    assert.equal(areaPlaceholder("Hello ST. GEORGE (EAST) ladies", ["ST. GEORGE (EAST)"]), "Hello {AREA} ladies");
    assert.equal(areaPlaceholder("Hello STX GEORGE ladies", ["ST. GEORGE"]), "Hello STX GEORGE ladies", "a dot is a dot, not any character");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C9 Chinese copy (2026-10-07, F45 Xinyi): the standing rules in Chinese (免費, 試用, 保證…), NT$ and 元 prices, weight and body-fat numbers; an em dash inside Chinese becomes a Chinese comma; a one-block Chinese text is broken on 。！？; the button named in Chinese becomes {BUTTON} and is filled in the gym's language; the gym's language from its locale; the prompts say zh-TW and the skeletons come from the library's Chinese entries only", async () => {
  const m = await import("./draft-copy.mjs");
  const rules = m.copyRules({ brand_lock: { voice: { never: [] } } });
  const probs = (message) => m.copyProblems({ message, headline: "", description: "" }, { offer: "六週中年體態雕塑計畫", rules, kind: "copy" });
  assert.deepEqual(probs("信義區的你，六週中年體態雕塑計畫現在開始。點擊 {BUTTON}。"), []);
  assert.deepEqual([probs("獲得免費的六週中年體態雕塑計畫。"), probs("六週中年體態雕塑計畫，先試用一週。"), probs("六週中年體態雕塑計畫，保證有效。")], [['says "免費"'], ['says "試用"'], ['says "保證"']]);
  assert.deepEqual([probs("六週中年體態雕塑計畫只要 NT$1,990。"), probs("六週中年體態雕塑計畫 3,000元起"), probs("六週中年體態雕塑計畫，瘦5公斤。"), probs("六週中年體態雕塑計畫，體脂降5%。"), probs("六週中年體態雕塑計畫，減掉3公斤")], [["a price"], ["a price"], ["a weight-loss number"], ["a weight-loss number"], ["a weight-loss number"]]);
  assert.equal(m.plainDashes("有些人的精緻——是手錶、車子。目標很簡單——腰線更緊實。"), "有些人的精緻，是手錶、車子。目標很簡單，腰線更緊實。");
  assert.equal(m.plainDashes("Bishan — the plan"), "Bishan - the plan", "English keeps the hyphen");
  const block = "準備好終於看到你應得的效果了嗎？我們正在尋找12位來自信義區的男生。如果你想在6週內改變體態，這就是你的機會。名額有限。點擊{BUTTON}。現在就開始。";
  assert.ok(m.needsLayout(block) && !m.needsLayout("短句。") && !m.needsLayout("A".repeat(200)));
  assert.equal(m.breakBySentence(block), "準備好終於看到你應得的效果了嗎？\n\n我們正在尋找12位來自信義區的男生。如果你想在6週內改變體態，這就是你的機會。\n\n名額有限。點擊{BUTTON}。\n\n現在就開始。");
  assert.equal(m.buttonPlaceholder("想參加？點擊「立即報名」。或按下了解更多按鈕。『馬上報名』"), "想參加？點擊{BUTTON}。或按下{BUTTON}。{BUTTON}");
  assert.deepEqual([m.ctaLabel("SIGN_UP", "zh"), m.ctaLabel("LEARN_MORE", "zh"), m.ctaLabel("SIGN_UP", "en"), m.ctaLabel("NOPE", "zh")], ["立即報名", "了解更多", "Sign up", "Sign up"]);
  assert.equal(m.fillButton("點擊{BUTTON}", m.ctaLabel("SIGN_UP", "zh")), "點擊立即報名");
  assert.deepEqual([m.gymLanguage({ locale: { country: "TW", languages: ["zh_TW"] } }), m.gymLanguage({ locale: { country: "TW", languages: [] } }), m.gymLanguage({ locale: { country: "SG", languages: ["en_SG"] } }), m.gymLanguage({})], ["zh", "zh", "en", "en"]);
  assert.deepEqual([m.languageOf("六週"), m.languageOf("12 Week")], ["zh", "en"]);
  const zhProfile = { display_name: "F45 Xinyi", locale: { country: "TW", languages: ["zh_TW"] }, brand_lock: { voice: { never: [] } } };
  const { prompt } = m.buildDraftPrompt({ profile: zhProfile, kind: "copy", offer: "六週中年體態雕塑計畫", audience: "女生限定", locations: ["信義區"], rules, skeletons: [{ id: "lib-zh", angle: "call-out", text: "{AREA}的{AUDIENCE}，{OFFER}開始了。點擊{BUTTON}。" }], count: 3, button: "立即報名" });
  assert.match(prompt, /LANGUAGE: Traditional Chinese as written in Taiwan/); assert.match(prompt, /a gym in Taiwan/); assert.match(prompt, /80-260 characters/);
  assert.match(m.buildJudgePrompt({ drafts: [{ id: "a", message: "信義區的你" }], kind: "copy", offer: "x", audience: null }), /Traditional Chinese/);
  // The library by language: a Chinese gym drafts from Chinese skeletons only, and is told so when there are none.
  const lib = mkdtempSync(join(tmpdir(), "copylib-zh-"));
  writeFileSync(join(lib, "copy-library.json"), JSON.stringify({ schema: 1, entries: [{ id: "en1", kind: "copy", text: "{AUDIENCE} in {AREA}: the {OFFER}. Tap {BUTTON}." }, { id: "zh1", kind: "copy", language: "zh", text: "{AREA}的{AUDIENCE}，{OFFER}開始了。點擊{BUTTON}。" }, { id: "zh2", kind: "copy", text: "六週{OFFER}，{AREA}限定。" }] }));
  assert.deepEqual(m.librarySkeletons(lib, "copy", { language: "zh" }).map((e) => e.id), ["zh1", "zh2"], "an entry without a language is read by its text");
  assert.deepEqual(m.librarySkeletons(lib, "copy", { language: "en" }).map((e) => e.id), ["en1"]);
  assert.deepEqual(m.librarySkeletons(lib, "copy").map((e) => e.id), ["en1", "zh1", "zh2"]);
  const d = gym(); const pf = join(d, "gym-profile.json"); writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf-8")), locale: { country: "TW", languages: ["zh_TW"] } }));
  const bd = join(d, "outputs", "b"); mkdirSync(bd, { recursive: true });
  await assert.rejects(m.draftCopy({ brandDir: d, batchDir: bd, kind: "headline", offer: "x", libraryDir: lib, ask: async () => ({ drafts: [] }) }), /no headline skeletons yet in Traditional Chinese.*send this gym's own references/);
});

test("C10 Chinese drafts are told apart (2026-10-07): the duplicate rule shaped an all-Chinese draft to nothing, so every headline after the first was dropped as one already here (F45 Xinyi: 3 kept of 17); now distinct Chinese headlines are all kept and a real repeat is still dropped", async () => {
  const m = await import("./draft-copy.mjs");
  const lib = mkdtempSync(join(tmpdir(), "copylib-zh10-"));
  writeFileSync(join(lib, "copy-library.json"), JSON.stringify({ schema: 1, entries: [{ id: "zh-h", kind: "headline", language: "zh", text: "{AREA}女性 - {OFFER}，現在開始" }] }));
  const d = gym(); const pf = join(d, "gym-profile.json"); writeFileSync(pf, JSON.stringify({ ...JSON.parse(readFileSync(pf, "utf-8")), locale: { country: "TW", languages: ["zh_TW"] } }));
  const bd = join(d, "outputs", "b"); mkdirSync(bd, { recursive: true });
  const headlines = ["信義區女性 - 六週全身體態改造計畫，現在開始報名", "六週後成功達成體態目標，報名開始", "每次都想打造好線條，這六週全身體態改造計畫讓妳真的開始", "信義區女性 - 六週全身體態改造計畫，現在開始報名"];
  let n = 0;
  const ask = async (_i, prompt) => {
    if (/clarity/i.test(prompt) && !/drafts?\b.*headline/i.test(prompt.slice(0, 200))) return { ratings: [] };
    if (n++ === 0) return { drafts: headlines.map((h) => ({ headline: h, description: "專為女性打造", angle: "call-out", from: 1 })) };
    return { drafts: [] };
  };
  const r = await m.draftCopy({ brandDir: d, batchDir: bd, kind: "headline", offer: "六週全身體態改造計畫", audience: "女性", locations: ["信義區"], count: 4, libraryDir: lib, ask });
  assert.equal(r.added.length, 3, `three distinct Chinese headlines kept (dropped: ${r.dropped.map((x) => x.why).join("; ")})`);
  assert.deepEqual(r.dropped.map((x) => x.why), ["reads like one already here"], "the one real repeat is dropped");
});
