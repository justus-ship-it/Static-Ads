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
import { copyRules, copyProblems, referencesFor, addCopyRef, editCopyRef, buildCopyPrompt, draftCopy, readCopy, keptCopies, addCopy, decideCopy, textOptionsFor, ALWAYS_NEVER, MAX_OPTIONS, offerDocFor, analyseCopy, ANGLES } from "./draft-copy.mjs";

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
  bad({ message: "" }, /no primary text/); bad({ headline: "" }, /no headline/);
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
    const p = buildCopyPrompt({ profile, offer: OFFER, audience: "LADIES WANTED", locations: ["BISHAN", "ANG MO KIO"], rules: copyRules(profile, offerDocFor(d, OFFER)), refs: referencesFor(d), count: 8, avoid: [{ headline: "Done already" }] });
    for (const re of [/"12 Week Total Body Reset"\. Name it exactly/, /the ad says "LADIES WANTED"/, /BISHAN, ANG MO KIO/, /direct, coach-led/, /melt fat/, /free trial/, /REFERENCES/, /Reference number 0/, /ALREADY WRITTEN.*Done already/, /Write 8 different/]) assert.match(p.prompt, re);
    assert.equal(p.schema.properties.drafts.items.required.join(","), "message,headline,description");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("C3 drafting: one text call (a second for a shortfall); drafts that break a rule or repeat one are dropped with the reason; the rest land in copy.json as drafts; keep / exclude / edit / undo; the owner's own copy is checked and kept at once; kept copies come back in the order they were kept", async () => {
  const d = gym(), out = join(d, "outputs", "b1");
  try {
    let calls = 0, prompts = [];
    const ask = async (img, text, schema) => { calls++; prompts.push(text); assert.equal(img, null); assert.ok(schema.properties.drafts);
      return { drafts: calls === 1 ? [ok({ headline: `${OFFER}: start again`, angle: "pain" }), ok({ headline: `${OFFER}: start again`, message: ok().message, angle: "pain" }), ok({ message: `Free trial of the ${OFFER}` }), ok({ headline: `Your coach, your ${OFFER}`, message: `Ladies in Ang Mo Kio, the ${OFFER} is coach-led. Tap Sign up.` })] : [ok({ headline: `Structure beats motivation: ${OFFER}`, message: `A plan you can keep. The ${OFFER}. Tap Sign up.` })] }; };
    const r = await draftCopy({ brandDir: d, batchDir: out, offer: OFFER, audience: "LADIES WANTED", locations: ["BISHAN"], count: 3, ask });
    assert.deepEqual([r.added.length, r.calls, r.refs, r.total, r.dropped.map((x) => x.why.split("; ")[0])], [3, 2, 1, 3, ["reads like one already here", 'says "free trial"']]);
    assert.match(prompts[1], /ALREADY WRITTEN.*start again/, "the second call is told what exists");
    const c = readCopy(out);
    assert.deepEqual([c.offer, c.audience, c.drafts.map((x) => [x.status, x.source, x.angle])], [OFFER, "LADIES WANTED", [["draft", "agent", "pain"], ["draft", "agent", null], ["draft", "agent", null]]]);
    assert.deepEqual(keptCopies(out), []);
    const [a, b, e] = c.drafts;
    decideCopy(out, b.id, { status: "keep" }); await new Promise((x) => setTimeout(x, 5)); decideCopy(out, a.id, { status: "keep" }); decideCopy(out, e.id, { status: "exclude" });
    assert.deepEqual(keptCopies(out).map((x) => x.id), [b.id, a.id], "in the order kept");
    assert.throws(() => decideCopy(out, a.id, { message: `Free trial ${OFFER}` }, { offer: OFFER, profile }), /free trial/);
    decideCopy(out, a.id, { headline: `${OFFER} for Bishan ladies` }, { offer: OFFER, profile });
    assert.ok(readCopy(out).drafts.find((x) => x.id === a.id).edited && readCopy(out).drafts.find((x) => x.id === a.id).headline.endsWith("ladies"));
    decideCopy(out, e.id, { status: "draft" }); assert.equal(readCopy(out).drafts.find((x) => x.id === e.id).status, "draft");
    assert.throws(() => decideCopy(out, "nope", { status: "keep" }), /no copy nope/);
    assert.throws(() => decideCopy(out, a.id, { status: "maybe" }), /keep, exclude or draft/);
    const own = addCopy(out, { message: `Typed by hand — the ${OFFER}. Tap Sign up.`, headline: "Own words – yours" }, { offer: OFFER, profile });
    assert.deepEqual([own.message, own.headline], [`Typed by hand - the ${OFFER}. Tap Sign up.`, "Own words - yours"], "the owner's dashes become hyphens, never a refusal");
    assert.deepEqual([own.source, own.status, keptCopies(out).length], ["owner", "keep", 3]);
    assert.throws(() => addCopy(out, { message: "no offer here", headline: "h" }, { offer: OFFER, profile }), /not named exactly/);
    await assert.rejects(draftCopy({ brandDir: d, batchDir: out, offer: "", count: 3, ask }), /offer's exact words/);
    await assert.rejects(draftCopy({ brandDir: d, batchDir: out, offer: OFFER, count: 0, ask }), /count must be 1 to 20/);
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
