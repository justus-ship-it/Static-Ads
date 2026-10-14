/**
 * Tests for the shared targeting library (targeting-library.mjs): the curated drafts, approval, the default for a
 * gender, retire and restore, the owner's own entry, library ids on a plan. Offline.
 *
 *   node --test skills/references/targeting-library.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDrafts, readLibrary, curatedDrafts, defaultFor, approveEntry, retireEntry, restoreEntry, addEntry, asPreset, isLibraryId, libraryEntry, FITNESS_CORE, BEAUTY, AFFLUENT, FILE } from "./targeting-library.mjs";

test("TL1 the curated drafts: three entries seeded once into an empty library, none approved, so nothing applies; the core's seven interests by Meta id, the women's variant the core plus Beauty, the affluent option two AND-ed groups; approval makes a default — the gender's own variant first, else the one for everyone, never an option; retire needs a reason and keeps the entry; the owner's own entry needs ids and names; library ids never collide with the account's", () => {
  const dir = mkdtempSync(join(tmpdir(), "tlib-"));
  try {
    const { data, seeded } = seedDrafts(dir, "2026-10-07T00:00:00.000Z");
    assert.equal(seeded, 3); assert.ok(existsSync(join(dir, FILE)));
    assert.equal(seedDrafts(dir).seeded, 0, "seeded once");
    assert.deepEqual(data.entries.map((e) => [e.name, e.audience, e.role, e.approved_on]), [["Fitness core", "all", "default", null], ["Fitness core · women", "women", "default", null], ["Affluent × fitness", "all", "option", null]]);
    const [core, women, affluent] = data.entries;
    assert.equal(core.spec.flexible_spec[0].interests.length, 7);
    assert.ok(core.spec.flexible_spec[0].interests.every((i) => /^\d{5,20}$/.test(i.id) && i.name), "Meta ids and names");
    assert.deepEqual(women.spec.flexible_spec[0].interests.map((i) => i.name), [...BEAUTY, ...FITNESS_CORE].map((i) => i.name));
    assert.deepEqual(affluent.spec.flexible_spec.map((g) => g.interests.length), [AFFLUENT.length, FITNESS_CORE.length], "two AND-ed groups");
    assert.ok(curatedDrafts().every((e) => e.evidence.length >= 2 && e.note), "each with its evidence and note");
    assert.equal(defaultFor(data, "women"), null, "nothing applies before approval");
    // Approval: the women's variant for a women's callout, the core for men and everyone; the option never.
    approveEntry(dir, affluent.id);
    assert.equal(defaultFor(readLibrary(dir), "all"), null, "an approved option is no default");
    approveEntry(dir, core.id);
    let lib = readLibrary(dir);
    assert.deepEqual([defaultFor(lib, "all")?.name, defaultFor(lib, "men")?.name, defaultFor(lib, "women")?.name], ["Fitness core", "Fitness core", "Fitness core"], "the core for every gender until the women's variant is approved");
    approveEntry(dir, women.id);
    lib = readLibrary(dir);
    assert.deepEqual([defaultFor(lib, "women")?.name, defaultFor(lib, "men")?.name], ["Fitness core · women", "Fitness core"]);
    // As a plan preset.
    const p = asPreset(core);
    assert.deepEqual([p.id, p.name, p.source, isLibraryId(p.id), isLibraryId("abcdef012345")], [`lib:${core.id}`, "Fitness core", "library", true, false]);
    assert.equal(libraryEntry(lib, p.id)?.name, "Fitness core"); assert.equal(libraryEntry(lib, "lib:000000000000"), null);
    // Retire needs a reason, keeps the entry, takes it out of the defaults; restore brings it back.
    assert.throws(() => retireEntry(dir, women.id, ""), /reason/);
    retireEntry(dir, women.id, "too narrow");
    lib = readLibrary(dir);
    assert.deepEqual([lib.entries.length, defaultFor(lib, "women")?.name, lib.entries[1].retired.reason], [3, "Fitness core", "too narrow"]);
    assert.throws(() => approveEntry(dir, women.id), /retired/);
    restoreEntry(dir, women.id);
    assert.equal(defaultFor(readLibrary(dir), "women")?.name, "Fitness core · women");
    assert.throws(() => approveEntry(dir, "000000000000"), /no entry/);
    // The owner's own entry.
    assert.throws(() => addEntry(dir, { name: "", groups: [[{ id: "6003258544357", name: "x" }]] }), /needs a name/);
    assert.throws(() => addEntry(dir, { name: "x", groups: [[{ id: "nope", name: "x" }]] }), /Meta's id/);
    assert.throws(() => addEntry(dir, { name: "x", audience: "kids", groups: [[{ id: "6003258544357", name: "x" }]] }), /audience/);
    const mine = addEntry(dir, { name: "Runners", audience: "all", role: "option", groups: [[{ id: "6003107634035", name: "healthy habits" }], [{ id: "6003258544357", name: "Health and wellness" }]] });
    assert.deepEqual([mine.approved_on, mine.spec.flexible_spec.length, readLibrary(dir).entries.length], [null, 2, 4]);
    assert.throws(() => addEntry(dir, { name: "Runners again", groups: [[{ id: "6003107634035", name: "healthy habits" }], [{ id: "6003258544357", name: "Health and wellness" }]] }), /already/);
    assert.equal(JSON.parse(readFileSync(join(dir, FILE), "utf-8")).schema, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
