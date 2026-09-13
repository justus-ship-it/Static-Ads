/**
 * Tests for gym profiles (schema 3): format checks, completeness, and the offer wordings.
 *
 *   node --test skills/references/client-config.test.mjs
 *
 * No browser, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfile, profileCompleteness, PROFILE_STARTER, PROFILE_SCHEMA, CREATIVE_DEFAULTS, scaffold } from "./client-config.mjs";
import { readWordings, addWording, editWording, deleteWording, recordUse, wordingProblems, MAX_WORDINGS } from "./ad-wordings.mjs";

const gymDir = () => {
  const d = mkdtempSync(join(tmpdir(), "profile-"));
  mkdirSync(join(d, "brand-assets", "facility-clean"), { recursive: true });
  mkdirSync(join(d, "brand-assets", "logo"), { recursive: true });
  writeFileSync(join(d, "brand-assets", "facility-clean", "r1.png"), "x");
  writeFileSync(join(d, "brand-assets", "logo", "logo.png"), "x");
  return d;
};
const complete = () => ({
  ...PROFILE_STARTER("iron-haus", "IronHaus Strength"),
  website: "https://ironhaus.sg",
  locations: [{ label: "Tai Seng", address: "1 Tai Seng Ave", postal_code: "534407", lat: 1.335, lng: 103.887 }],
  creative_defaults: { ...CREATIVE_DEFAULTS, locations: ["TAI SENG", "PAYA LEBAR"], audiences: ["MEN WANTED", "LADIES WANTED"], real_photos: ["facility-clean/r1.png"] },
});

test("P1 a profile's format is checked before it is saved: bad ids, colours, callouts and counts are refused; a token never goes in; unfinished is not wrong", () => {
  const d = gymDir();
  try {
    const p = complete();
    p.brand_lock.colors.primary.hex = "#0A0A0A";
    assert.deepEqual(validateProfile(p, { gymDir: d }).errors, [], "a complete profile");
    assert.deepEqual(validateProfile(PROFILE_STARTER("new-gym"), { gymDir: d }).errors, [], "an empty starter is unfinished, not wrong — onboarding saves as it goes");
    assert.equal(PROFILE_STARTER("new-gym").schema_version, PROFILE_SCHEMA);
    const bad = (change, re) => {
      const errs = validateProfile(change(structuredClone(p)), { gymDir: d }).errors;
      assert.ok(errs.some((e) => re.test(e)), `${re}: ${JSON.stringify(errs)}`);
    };
    bad((x) => ({ ...x, gym_abbr: "Iron" }), /2-4 capital letters/);
    bad((x) => ({ ...x, display_name: "IronHaus — Strength" }), /display name contains an em\/en dash/);
    bad((x) => ({ ...x, website: "ironhaus" }), /not a web address/);
    bad((x) => { x.locations[0].postal_code = "5344"; return x; }, /postal code "5344" must be 6 digits/);
    bad((x) => { x.locations[0].lat = "north"; return x; }, /lat must be a number/);
    bad((x) => { x.brand_lock.colors.secondary.hex = "red"; return x; }, /not a 6-digit hex/);
    bad((x) => { x.creative_defaults.locations = ["A", "B", "C", "D", "E"]; return x; }, /up to 4 location callouts/);
    bad((x) => { x.creative_defaults.locations = ["TAI SENG", "TAI SENG"]; return x; }, /repeats/);
    bad((x) => { x.creative_defaults.locations = ["TAI SENG — EAST"]; return x; }, /em\/en dash/);
    bad((x) => { x.creative_defaults.audiences = ["X".repeat(60)]; return x; }, /audience callout .*limit/);
    bad((x) => { x.creative_defaults.real_photos = ["facility-clean/nope.png"]; return x; }, /not in brand-assets/);
    bad((x) => { x.creative_defaults.real_photos = ["../../gym-profile.json"]; return x; }, /not in brand-assets/);
    bad((x) => { x.creative_defaults.generated = 13; return x; }, /generated must be a whole number from 0 to 12/);
    bad((x) => { x.creative_defaults.max_calls = 4; x.creative_defaults.generated = 10; return x; }, /must cover one call per new photo/);
    bad((x) => { x.creative_defaults.spread = "yes"; return x; }, /spread must be true or false/);
    bad((x) => { x.meta_assets.page_id = "my page"; return x; }, /page id "my page" is not an id/);
    bad((x) => { x.meta_assets.ad_account_id = "act_12x"; return x; }, /ad account id/);
    // Tokens never: by name, or by what a Meta or Google key looks like, anywhere in the file.
    bad((x) => { x.meta_assets.access_token = "abc"; return x; }, /meta_assets\.access_token: tokens, secrets and passwords never go in a profile/);
    bad((x) => { x.meta_assets.system_user_access_token = "abc"; return x; }, /never go in a profile/);
    bad((x) => { x.notes = "EAAB" + "a".repeat(40); return x; }, /notes: tokens/);
    bad((x) => { x.integrations = [{ gemini: "AIza" + "b".repeat(35) }]; return x; }, /integrations\[0\]\.gemini: tokens/);
    assert.deepEqual(validateProfile({ ...p, meta_assets: { ...p.meta_assets, ad_account_id: "act_1234567890", business_id: "1234567890" } }, { gymDir: d }).errors, []);
    assert.deepEqual(validateProfile(p).errors.filter((e) => /token/.test(e)), [], "an ad set's name_token is a naming token, not a secret");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("P2 completeness is worked out from the profile and what is on disk: each section done, partly done or not started, with what it still needs", () => {
  const d = gymDir();
  try {
    const empty = profileCompleteness(PROFILE_STARTER("new-gym"), { gymDir: d });
    assert.equal(empty.ready_to_create, false);
    const by = (c) => Object.fromEntries(c.sections.map((s) => [s.id, s.status]));
    assert.deepEqual(by(empty), { identity: "partial", brand: "partial", photos: "missing", scenes: "missing", offers: "missing", defaults: "missing", targeting: "partial", meta: "missing" });
    assert.deepEqual(empty.sections.find((s) => s.id === "identity").missing, ["display name", "website", "a location's name", "its postal code"]);
    const p = complete();
    p.brand_lock.colors.primary.hex = "#0A0A0A";
    const have = { gymDir: d, cleanPhotos: 1, scenes: { exists: true, approved: true, counts: { men: 3, women: 0, any: 0 } }, wordings: 1 };
    let c = profileCompleteness(p, have);
    assert.equal(by(c).scenes, "partial", "LADIES WANTED is a default audience and the library has no women's scenes");
    assert.deepEqual(c.sections.find((s) => s.id === "scenes").missing, ["scenes for women"]);
    c = profileCompleteness(p, { ...have, scenes: { exists: true, approved: true, counts: { men: 3, women: 2 } } });
    assert.equal(c.ready_to_create, true);
    assert.equal(c.to_do, 0);
    assert.equal(c.ready_to_publish, false, "the Meta ids are for publishing, later");
    assert.equal(by(c).meta, "missing");
    assert.ok(c.sections.find((s) => s.id === "brand").tips.some((t) => /logo/.test(t)), "no logo is a tip, not a blocker");
    p.brand_lock.logo.files.primary = "logo/logo.png";
    assert.deepEqual(profileCompleteness(p, { ...have, scenes: { exists: true, approved: true, counts: { men: 3, women: 2 } } }).sections.find((s) => s.id === "brand").tips, []);
    Object.assign(p.meta_assets, { ad_account_id: "act_1", page_id: "2", business_id: "3", pixel_id: "4", lead_form_id: "5" });
    assert.deepEqual(profileCompleteness(p, { ...have, scenes: { exists: true, approved: true, counts: { men: 3, women: 2 } } }).sections.find((s) => s.id === "targeting").missing, ["a radius pin"]);
    p.targeting_defaults.geo.radius_pins = [{ label: "Tai Seng", postal_code: "534407", radius_km: 5 }];
    assert.equal(profileCompleteness(p, { ...have, scenes: { exists: true, approved: true, counts: { men: 3, women: 2 } } }).ready_to_publish, true);
    assert.equal(profileCompleteness(p, { ...have, wordings: 0 }).ready_to_create, false, "no offer wording yet");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("P3 offer wordings: read from the batch history until the owner edits them; add, edit and delete by the renderer's rules; a confirmed run records its wording", () => {
  const d = gymDir();
  try {
    const brief = (id, offer, made) => {
      mkdirSync(join(d, "batches", id), { recursive: true });
      writeFileSync(join(d, "batches", id, "brief.json"), JSON.stringify({ batch_id: id, offer }));
      if (made) { mkdirSync(join(d, "outputs", id), { recursive: true }); writeFileSync(join(d, "outputs", id, "batch.json"), JSON.stringify({ made: `${made}T10:00:00Z` })); }
    };
    brief("2026-09-01-a", "6 Week Strength Kickstart", "2026-09-01");
    brief("2026-09-10-b", "12 Week Total Body Reset", "2026-09-10");
    brief("2026-09-12-c", "12 Week Total Body Reset", "2026-09-12");
    brief("2026-09-13-planned", "12 Week Summer Shred", null);
    brief("2026-09-13-bad", "12 Week — Reset", null);
    let ws = readWordings(d);
    assert.deepEqual(ws.map((w) => [w.text, w.uses, w.last_used]), [["12 Week Summer Shred", 0, null], ["12 Week Total Body Reset", 2, "2026-09-12"], ["6 Week Strength Kickstart", 1, "2026-09-01"]], "most recent first — typed on the 13th, used on the 12th, used on the 1st; a wording that breaks the rules is not offered");
    assert.ok(!existsSync(join(d, "ad-wordings.json")), "reading writes nothing");
    // The owner's changes: checked as the offer line is checked.
    assert.throws(() => addWording(d, "12 Week — Reset"), /em\/en dash/);
    assert.throws(() => addWording(d, " 12 Week Reset"), /leading or trailing spaces/);
    assert.throws(() => addWording(d, ""), /needs words/);
    assert.throws(() => addWording(d, "X".repeat(200)), /limit/);
    const { wording } = addWording(d, "8 Week Mums Comeback");
    assert.equal(wording.uses, 0);
    ws = readWordings(d);
    assert.equal(ws.length, 4);
    assert.equal(addWording(d, "8 Week Mums Comeback").wordings.length, 4, "adding the same words again adds nothing");
    assert.throws(() => editWording(d, wording.id, "12 Week Total Body Reset"), /already in the list/);
    editWording(d, wording.id, "8 Week Mums Strength Comeback");
    assert.ok(readWordings(d).some((w) => w.id === wording.id && w.text === "8 Week Mums Strength Comeback"));
    deleteWording(d, readWordings(d).find((w) => w.text === "12 Week Summer Shred").id);
    assert.ok(!readWordings(d).some((w) => w.text === "12 Week Summer Shred"));
    assert.throws(() => deleteWording(d, "nope"), /no wording nope/);
    // A confirmed run with a wording: uses and date move; a new one joins the list.
    const before = readWordings(d).find((w) => w.text === "6 Week Strength Kickstart").uses;
    recordUse(d, "6 Week Strength Kickstart");
    const k = readWordings(d).find((w) => w.text === "6 Week Strength Kickstart");
    assert.equal(k.uses, before + 1);
    assert.equal(k.last_used, new Date().toISOString().slice(0, 10));
    assert.equal(readWordings(d)[0].text, "6 Week Strength Kickstart", "the one just used comes first");
    recordUse(d, "10 Week Back To Basics");
    assert.equal(readWordings(d).find((w) => w.text === "10 Week Back To Basics").uses, 1);
    assert.equal(recordUse(d, "bad — words"), null, "a wording the renderer refuses is never recorded");
    // Deleted means deleted, even though a batch in the history still uses it.
    assert.ok(!readWordings(d).some((w) => w.text === "12 Week Summer Shred"));
    // Full list: the owner decides what goes.
    for (let i = readWordings(d).length; i < MAX_WORDINGS; i++) addWording(d, `${i} Week Test`);
    assert.throws(() => addWording(d, "One More Week"), /up to/);
    assert.equal(recordUse(d, "One More Week"), null);
    assert.deepEqual(wordingProblems("12 Week Total Body Reset"), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("P4 a new gym is scaffolded in the clients folder it is given, with its name and schema 3, and an existing profile is never overwritten", () => {
  const d = mkdtempSync(join(tmpdir(), "brands-"));
  try {
    scaffold("iron-haus", null, { brandsDir: d, displayName: "IronHaus Strength" });
    const p = JSON.parse(readFileSync(join(d, "iron-haus", "gym-profile.json"), "utf-8"));
    assert.equal(p.display_name, "IronHaus Strength");
    assert.equal(p.gym_abbr, "IRO");
    assert.equal(p.schema_version, 3);
    assert.deepEqual(p.creative_defaults, CREATIVE_DEFAULTS);
    assert.equal(p.brand_lock.logo.always_include_as_reference, false, "the starter no longer forces a logo that is not there into image calls");
    writeFileSync(join(d, "iron-haus", "gym-profile.json"), JSON.stringify({ ...p, website: "https://ironhaus.sg" }));
    scaffold("iron-haus", null, { brandsDir: d, displayName: "Something Else" });
    assert.equal(JSON.parse(readFileSync(join(d, "iron-haus", "gym-profile.json"), "utf-8")).website, "https://ironhaus.sg");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
