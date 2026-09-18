/**
 * Tests for the targeting library (meta-targeting.mjs): presets read from an account's own ad sets
 * and results, saved audiences and the owner's search picks — offline, with a fake client.
 *
 *   node --test skills/references/meta-targeting.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseSpec, fingerprint, summarise, audienceLabel, nameFor, specProblems, readPresets, importPresets, renamePreset, retirePreset, restorePreset, addPreset, rankPresets, presetFor, specForAdset, livePresets, BROAD, FILE } from "./meta-targeting.mjs";

const FIT = [{ id: "6003277229371", name: "Physical fitness (fitness)" }, { id: "6003420915231", name: "Health club (fitness)" }];
const DADS = [{ id: "6003101323797", name: "Fatherhood (children and parenting)" }, { id: "6003232518610", name: "Parenting (children and parenting)" }];
const MEMBERS = { id: "120217860033920309", name: "Members-List_Nov'24" };
const spec = (a, b, excl) => ({ flexible_spec: [{ interests: a }, ...(b ? [{ interests: b }] : [])], ...(excl ? { excluded_custom_audiences: [excl] } : {}) });
const adset = (id, name, targeting, created, updated = created) => ({ id, name, status: "ACTIVE", created_time: `${created}T10:00:00+0800`, updated_time: `${updated}T10:00:00+0800`, targeting });
const fakeClient = ({ adsets, insights, saved = [] }) => ({ adsetHistory: async () => adsets, adsetInsights: async () => insights, savedAudiences: async () => saved });

test("T1 a spec reads the same whatever order Meta sent it in: the fingerprint ignores names and order; broad is broad; the summary and the derived name say what it is in words", () => {
  const a = spec(FIT, DADS, MEMBERS), b = { excluded_custom_audiences: [{ id: MEMBERS.id }], flexible_spec: [{ interests: [...DADS].reverse() }, { interests: [...FIT].reverse().map((x) => ({ id: x.id })) }] };
  assert.equal(fingerprint(a), fingerprint(b), "the same targeting, listed differently");
  assert.notEqual(fingerprint(a), fingerprint(spec(FIT, DADS)), "the exclusion matters");
  assert.notEqual(fingerprint(spec(FIT, DADS)), fingerprint(spec([...FIT, ...DADS])), "one OR-group is not two AND-ed groups");
  assert.equal(fingerprint({}), BROAD); assert.equal(fingerprint({ age_min: 25, genders: [1], targeting_automation: { advantage_audience: 0 } }), BROAD, "the pin, ages and gender are not a preset");
  assert.deepEqual(Object.keys(normaliseSpec({ age_min: 25, flexible_spec: [{ interests: FIT }], geo_locations: {} })), ["flexible_spec"], "only the preset keys survive");
  assert.deepEqual(normaliseSpec({ flexible_spec: [{ interests: [] }, {}] }), {}, "empty groups fall away");
  assert.deepEqual(summarise(a), ["Fatherhood (children and parenting), Parenting (children and parenting) (interests)", "AND Physical fitness (fitness), Health club (fitness) (interests)", "not Members-List_Nov'24"], "items in id order, groups in id order");
  assert.deepEqual(summarise({}), ["Broad — no detailed targeting"]);
  assert.equal(audienceLabel("0715 Thomson | 12-Week Fit Fathers Challenge | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60"), "Fitness+Fatherhood");
  assert.equal(audienceLabel("0331 Thomson | Abs | Audience: Thomson + 4KM, Female, Fitness, 25-55 – Copy 2"), "Fitness");
  assert.equal(audienceLabel("SCS_BISHAN_TEST"), null);
  assert.equal(nameFor(a, ["x | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60", "y | Audience: Bishan + 3KM, Male, Dads, 25-60", "z | Audience: Bishan + 3KM, Male, Fitness+Fatherhood, 25-60"]), "Fitness+Fatherhood", "the label most of its ad sets carry");
  assert.equal(nameFor(a, ["SCS_BISHAN_TEST"]), "Fatherhood / Parenting + Physical fitness / Health club", "else its first interests");
  assert.equal(nameFor({ custom_audiences: [MEMBERS] }, []), "Audience: Members-List_Nov'24");
  // What a preset may carry.
  assert.deepEqual(specProblems(spec(FIT)), []);
  assert.ok(specProblems({ flexible_spec: [{ interests: [{ id: "abc" }] }] }).some((e) => /without a Meta id/.test(e)));
  assert.ok(specProblems({ flexible_spec: [{ hobbies: FIT }] }).some((e) => /"hobbies" is not a kind/.test(e)));
  assert.ok(specProblems({ flexible_spec: [{}] }).some((e) => /empty group/.test(e)));
  assert.ok(specProblems({ targeting_automation: { advantage_audience: 1 } }).some((e) => /Advantage\+ audience never/.test(e)));
  assert.ok(specProblems({ geo_locations: {} }).some((e) => /set per ad set/.test(e)));
});

test("T2 importing from the account: every distinct targeting its ad sets ran becomes a preset with its record (ad sets, spend, leads, cost per lead, genders, ages, first and last used); Broad has one too; saved audiences join; a re-import keeps the owner's names, notes and retirements and refreshes the numbers; two presets with the same label are told apart", async () => {
  const d = mkdtempSync(join(tmpdir(), "targeting-"));
  try {
    const adsets = [
      adset("1", "0715 Thomson | Fit Fathers | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60", { age_min: 25, age_max: 60, genders: [1], ...spec(FIT, DADS) }, "2026-07-15", "2026-08-14"),
      adset("2", "0331 Thomson | Abs | Audience: Thomson + 4KM, Female, Fitness, 25-55", { age_min: 25, age_max: 55, genders: [2], ...spec(FIT) }, "2026-03-31"),
      adset("3", "0331 Katong | Abs | Audience: Katong + 4KM, Female, Fitness, 25-55", { age_min: 25, age_max: 55, genders: [2], flexible_spec: [{ interests: [...FIT].reverse() }] }, "2026-04-02", "2026-09-11"),
      adset("4", "0423 Broad men", { age_min: 25, age_max: 60, genders: [1], targeting_automation: { advantage_audience: 0 } }, "2026-04-23"),
      adset("5", "0423 Broad women", { age_min: 25, age_max: 60, genders: [2] }, "2026-04-24"),
      adset("6", "Mums | Audience: Thomson + 5KM, Female, Fitness, 25-60", { age_min: 25, age_max: 60, genders: [2], ...spec(FIT, [{ id: "6003210", name: "Motherhood (children and parenting)" }]) }, "2026-07-15"),
    ];
    const insights = [
      { adset_id: "1", spend: 2530.59, leads: 45, impressions: 100 }, { adset_id: "2", spend: 1000, leads: 40, impressions: 100 }, { adset_id: "3", spend: 500, leads: 10, impressions: 100 },
      { adset_id: "4", spend: 300, leads: 60, impressions: 100 }, { adset_id: "5", spend: 200, leads: 40, impressions: 100 }, { adset_id: "6", spend: 100, leads: 0, impressions: 100 },
    ];
    const saved = [{ id: "s1", name: "FPD_Prospecting_Interest_Healthy-Food", targeting: { age_min: 25, flexible_spec: [{ interests: [{ id: "6003300", name: "Organic food" }] }] }, approximate_count_lower_bound: 2200000 }, { id: "s2", name: "Same as Fitness", targeting: spec(FIT) }];
    const r = await importPresets({ client: fakeClient({ adsets, insights, saved }), accountId: "111", gymDir: d, now: "2026-09-17T08:00:00.000Z" });
    assert.deepEqual([r.adsets, r.with_results, r.saved, r.added], [6, 6, 2, 5]);
    const data = readPresets(d);
    assert.deepEqual([data.account, data.imported, existsSync(join(d, FILE))], ["act_111", "2026-09-17T08:00:00.000Z", true]);
    const byName = Object.fromEntries(data.presets.map((p) => [p.name, p]));
    assert.deepEqual(data.presets.map((p) => p.name), ["Broad", "Fitness+Fatherhood", "Fitness · Physical fitness, Health club", "Fitness · Motherhood, Physical fitness", "FPD_Prospecting_Interest_Healthy-Food"], "two presets whose ad sets carry the label Fitness are told apart by their first items");
    const broad = byName.Broad, fit = byName["Fitness · Physical fitness, Health club"], dads = byName["Fitness+Fatherhood"];
    assert.deepEqual(broad.stats, { adsets: 2, spend: 500, leads: 100, impressions: 200, cost_per_lead: 5, genders: { men: 1, women: 1, all: 0 }, ages: ["25-60"], first_used: "2026-04-23", last_used: "2026-04-24" });
    assert.deepEqual([fit.stats.adsets, fit.stats.spend, fit.stats.leads, fit.stats.cost_per_lead, fit.stats.genders, fit.stats.first_used, fit.stats.last_used, fit.examples.length, fit.source, fit.saved_audience], [2, 1500, 50, 30, { men: 0, women: 2, all: 0 }, "2026-03-31", "2026-09-11", 2, "account", { id: "s2", name: "Same as Fitness" }], "the two Fitness ad sets are one preset, listed in either order, and the saved audience with the same targeting joins it");
    assert.deepEqual([dads.stats.cost_per_lead, dads.stats.genders.men, dads.summary.length], [56.24, 1, 2]);
    assert.deepEqual([byName["FPD_Prospecting_Interest_Healthy-Food"].source, byName["FPD_Prospecting_Interest_Healthy-Food"].stats, byName["FPD_Prospecting_Interest_Healthy-Food"].size], ["saved_audience", null, 2200000]);
    assert.ok(!JSON.stringify(data).includes("advantage_audience"), "no preset carries Advantage+ audience");
    // The owner renames one, notes another, retires a third; a re-import with more spend keeps all of that.
    renamePreset(d, fit.id, { name: "Fitness (women)", notes: "our workhorse" });
    retirePreset(d, dads.id, "too expensive");
    assert.throws(() => retirePreset(d, dads.id, ""), /reason/); assert.throws(() => retirePreset(d, BROAD, "x"), /Broad cannot be retired/); assert.throws(() => renamePreset(d, BROAD, { name: "Wide" }), /Broad keeps its name/);
    insights[1].spend = 1200;
    const r2 = await importPresets({ client: fakeClient({ adsets, insights, saved }), accountId: "111", gymDir: d, now: "2026-09-18T08:00:00.000Z" });
    const again = readPresets(d), fit2 = again.presets.find((p) => p.id === fit.id), dads2 = again.presets.find((p) => p.id === dads.id);
    assert.deepEqual([r2.added, fit2.name, fit2.notes, fit2.renamed, fit2.stats.spend, dads2.retired.reason, again.imported], [0, "Fitness (women)", "our workhorse", true, 1700, "too expensive", "2026-09-18T08:00:00.000Z"]);
    assert.ok(!livePresets(again).some((p) => p.id === dads.id), "a retired preset is not offered"); assert.equal(livePresets(again)[0].id, BROAD, "Broad first");
    restorePreset(d, dads.id); assert.ok(livePresets(readPresets(d)).some((p) => p.id === dads.id));
    assert.deepEqual(specForAdset(fit2), { flexible_spec: [{ interests: [...FIT].sort((a, b) => a.id.localeCompare(b.id)) }] }, "what goes into the ad set: ids and names only");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("T3 suggesting one: the presets that ran for this gender come first, then the ones whose words match the offer or callout, then the cheapest lead — each with its reasons; the profile's own choice per callout wins over the suggestion; Broad when there is nothing", async () => {
  const d = mkdtempSync(join(tmpdir(), "targeting-"));
  try {
    const adsets = [
      adset("1", "Fit Fathers | Audience: Thomson + 5KM, Male, Fitness+Fatherhood, 25-60", { genders: [1], ...spec(FIT, DADS) }, "2026-07-15"),
      adset("2", "Abs | Audience: Thomson + 4KM, Female, Fitness, 25-55", { genders: [2], ...spec(FIT) }, "2026-03-31"),
      adset("3", "Total Body Reset broad", { genders: [1] }, "2026-04-23"),
      adset("4", "Toned Tummy | Audience: Female, Beauty, 25-60", { genders: [2], ...spec([{ id: "6003400", name: "Beauty (social concept)" }]) }, "2026-07-15"),
    ];
    const insights = [{ adset_id: "1", spend: 2530, leads: 45, impressions: 1 }, { adset_id: "2", spend: 1000, leads: 40, impressions: 1 }, { adset_id: "3", spend: 300, leads: 60, impressions: 1 }, { adset_id: "4", spend: 90, leads: 3, impressions: 1 }];
    await importPresets({ client: fakeClient({ adsets, insights }), accountId: "111", gymDir: d });
    const data = readPresets(d);
    const men = rankPresets(data, { gender: "men", words: "12 Week Total Body Reset MEN WANTED" });
    assert.deepEqual(men.map((r) => r.name), ["Broad", "Fitness+Fatherhood", "Fitness", "Beauty"], men.map((r) => `${r.name}: ${r.why}`).join("\n"));
    assert.match(men[0].why, /^ran for men 1 time · matches total, body, reset · 60 leads at 5.00 each over 1 ad set$/);
    assert.match(men[1].why, /ran for men 1 time · 45 leads at 56.22 each/);
    assert.match(men[3].why, /1 ad set, 3 leads/, "too few leads for a cost per lead to count");
    const women = rankPresets(data, { gender: "women", words: "Toned Tummy LADIES WANTED" });
    assert.deepEqual(women.map((r) => r.name), ["Beauty", "Fitness", "Broad", "Fitness+Fatherhood"], "ran for women and matches the words first; then ran for women; then the rest by cost");
    // The profile's choice per callout wins; "suggest" (or nothing) takes the top suggestion; a vanished choice falls back.
    const fit = data.presets.find((p) => p.name === "Fitness");
    const profile = { targeting_defaults: { detailed_targeting: { callout_presets: { "MEN WANTED": fit.id, "LADIES WANTED": "suggest", "EVERYONE": "broad" } } } };
    assert.deepEqual([presetFor(data, profile, { audience: "MEN WANTED", offer: "x" }).preset.id, presetFor(data, profile, { audience: "MEN WANTED" }).how], [fit.id, "the profile's choice"]);
    assert.deepEqual([presetFor(data, profile, { audience: "LADIES WANTED", offer: "Toned Tummy" }).preset.name, presetFor(data, profile, { audience: "LADIES WANTED", offer: "Toned Tummy" }).how.startsWith("suggested: ran for women")], ["Beauty", true]);
    assert.equal(presetFor(data, profile, { audience: "EVERYONE" }).preset.id, BROAD);
    assert.equal(presetFor(data, { targeting_defaults: { detailed_targeting: { callout_presets: { "MEN WANTED": "0000deadbeef" } } } }, { audience: "MEN WANTED" }).how, "the profile's choice is gone; suggested instead");
    assert.deepEqual(presetFor(readPresets(join(d, "nowhere")), {}, { audience: "MEN WANTED" }).preset.id, BROAD);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("T4 the owner's own preset: built from search picks, checked before it is kept; the same targeting twice is refused (or revived, if retired); Broad cannot be added; the cap holds", () => {
  const d = mkdtempSync(join(tmpdir(), "targeting-"));
  try {
    const p = addPreset(d, { name: "Gym goers", spec: { flexible_spec: [{ interests: FIT, behaviors: [{ id: "6002714895372", name: "Frequent travellers" }] }], excluded_custom_audiences: [MEMBERS] }, notes: "from search" });
    assert.deepEqual([p.source, p.renamed, p.summary, p.stats, readPresets(d).presets[0].id], ["owner", true, ["Frequent travellers (behaviours); Physical fitness (fitness), Health club (fitness) (interests)", "not Members-List_Nov'24"], null, BROAD]);
    assert.throws(() => addPreset(d, { name: "Again", spec: { excluded_custom_audiences: [{ id: MEMBERS.id }], flexible_spec: [{ behaviors: [{ id: "6002714895372" }], interests: [...FIT].reverse() }] } }), /already the preset "Gym goers"/);
    assert.throws(() => addPreset(d, { name: "Wide", spec: {} }), /that is Broad/);
    assert.throws(() => addPreset(d, { name: "", spec: spec(FIT) }), /one-line name/);
    assert.throws(() => addPreset(d, { name: "Bad", spec: { flexible_spec: [{ interests: [{ id: "x" }] }] } }), /without a Meta id/);
    retirePreset(d, p.id, "not now");
    const back = addPreset(d, { name: "Gym goers again", spec: p.spec });
    assert.deepEqual([back.id, back.retired, back.name], [p.id, null, "Gym goers again"], "adding a retired preset's targeting revives it under the new name");
    for (let i = 0; i < 58; i++) addPreset(d, { name: `P${i}`, spec: spec([{ id: String(10000 + i) }]) });
    assert.throws(() => addPreset(d, { name: "one more", spec: spec([{ id: "99999" }]) }), /no more than 60 presets/);
    assert.ok(!readFileSync(join(d, FILE), "utf-8").includes("advantage"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
