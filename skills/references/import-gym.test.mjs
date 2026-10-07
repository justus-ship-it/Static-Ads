/**
 * Tests for importing a gym from the portfolio (import-gym.mjs): the run's steps recorded one by one with a failure
 * kept and the run going on, the readers started as their own processes, the template candidate, the proposal's
 * ticks, and Add to the gym through the existing accept paths. Offline: a fake Graph client, a fake spawn.
 *
 *   node --test skills/references/import-gym.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { runImport, importProposal, applyImport, templateCandidate, readImport, IMPORT_FILE, FORMS_FILE } from "./import-gym.mjs";
import { PROFILE_STARTER } from "./client-config.mjs";
import { readLeadForms } from "./lead-forms.mjs";

const PAGE = { id: "105176144862096", name: "F45 Xinyi 信義", username: "f45xinyi", phone: "+886980660800", website: "http://f45xinyi.com/6weekplan", hours: { mon_1_open: "06:00", mon_1_close: "21:00" }, location: { street: "台北市信義區信義路四段413號二樓", city: "Taipei", country: "Taiwan", zip: "110", latitude: 25.033241, longitude: 121.559067 }, instagram_business_account: { id: "17841449500342630", username: "f45_xinyi" } };
const ACCOUNT = { id: "act_5595320690525032", account_id: "5595320690525032", name: "F45 Xinyi", currency: "TWD", timezone_name: "Asia/Taipei", business_country_code: "TW" };
const place = { geo_locations: { places: [{ key: "105176144862096", name: "F45 Xinyi 信義", latitude: 25.033241, longitude: 121.559067, radius: 2.5, distance_unit: "kilometer" }], location_types: ["home", "recent"] } };
const SETS = [{ id: "1", name: "0713 6 Week 中年體態雕塑", daily_budget: "500", created_time: "2026-07-13T21:50:08+0800", campaign: { name: "c", objective: "OUTCOME_LEADS" }, targeting: { age_min: 28, age_max: 50, genders: [2], ...place } }];
const FORMS = [
  { id: "7001", name: "v8 -7月 2026 六週中年體態雕塑計畫", status: "ACTIVE", created_time: "2026-07-09T09:58:47+0000", leads_count: 118, locale: "zh_TW", questions: [{ type: "CUSTOM", label: "你在信義區附近工作或居住嗎？", options: [{ key: "是", value: "是" }, { key: "否", value: "否" }] }, { type: "CUSTOM", label: "爲什麽想要參加六週中年體態雕塑計畫?" }, { type: "EMAIL" }, { type: "FULL_NAME" }], privacy_policy_url: "https://f45training.com/privacy", legal_content: { privacy_policy: { url: "https://f45training.com/privacy", link_text: "隱私" } }, context_card: { title: "六週中年體態雕塑計畫", content: ["幫助我們多認識你！"], style: "PARAGRAPH_STYLE" }, thank_you_page: { title: "最後一步", body: "LINE @f45xinyi", button_type: "CALL_BUSINESS", button_text: "聯絡我們", business_phone_number: "+886980660800" } },
  { id: "7002", name: "v8 -7月 2026 六週男性線條挑戰", status: "ACTIVE", created_time: "2026-07-09T09:52:24+0000", leads_count: 87, questions: [{ type: "EMAIL" }, { type: "FULL_NAME" }, { type: "PHONE" }] },
  { id: "7003", name: "v7 - April 2026 six week", status: "ACTIVE", created_time: "2026-04-27T00:00:00+0000", leads_count: 300, questions: [{ type: "EMAIL" }, { type: "FULL_NAME" }, { type: "PHONE" }] },
  { id: "6000", name: "Automated chat", status: "ACTIVE", created_time: "2025-03-19T00:00:00+0000", leads_count: 0, questions: [{ type: "EMAIL" }] },
  { id: "5000", name: "v9 archived", status: "ARCHIVED", created_time: "2026-09-01T00:00:00+0000", leads_count: 999, questions: [{ type: "EMAIL" }, { type: "FULL_NAME" }, { type: "PHONE" }] },
];
const client = () => ({
  accountFacts: async () => ACCOUNT, pageFacts: async () => PAGE, adsetHistory: async () => SETS,
  historyPins: async () => [{ kind: "place", key: "105176144862096", name: "F45 Xinyi 信義", lat: 25.033241, lng: 121.559067, radius_km: 2.5, location_types: ["home", "recent"], adsets: 1, example: "0713 6 Week 中年體態雕塑" }],
  adsetInsights: async () => [{ adset_id: "1", spend: 1000, leads: 10, impressions: 100, clicks: 5 }], savedAudiences: async () => [], customAudiences: async () => [],
  leadFormDetails: async () => FORMS,
  // pullAccountHistory is not stubbed: that step fails and the run goes on.
});
/** A fake spawn: records the command, prints a line, exits with the code the test wants. */
const fakeSpawn = (calls, codeFor = () => 0) => (cmd, args) => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  calls.push(args);
  setImmediate(() => { child.stdout.emit("data", Buffer.from(`fake ${args[0].split("/").pop()} ran\n`)); child.emit("close", codeFor(args)); });
  return child;
};
const gymDir = () => { const d = mkdtempSync(join(tmpdir(), "import-")); const p = PROFILE_STARTER("f45-xinyi", "F45 Xinyi", "TW"); p.meta_assets = { ...(p.meta_assets || {}), ad_account_id: "act_5595320690525032", page_id: "105176144862096" }; writeFileSync(join(d, "gym-profile.json"), JSON.stringify(p, null, 2)); return d; };

test("IG1 the import run: the Page and account read, the targeting imported, the forms read with the template candidate (the latest version first, then the most leads; archived and chat forms never), a step that fails is recorded and the run goes on, the identity step says it is not a Singapore gym, the readers run as their own processes on the Page's website and Instagram, a skipped step is said; nothing without the Meta ids", async () => {
  const d = gymDir(), spawned = [], logs = [];
  try {
    await assert.rejects(runImport({ brandDir: mkdtempSync(join(tmpdir(), "empty-")), client: client(), log: () => {} }), /no gym profile/);
    const state = await runImport({ brandDir: d, client: client(), log: (m) => logs.push(m), spawnImpl: fakeSpawn(spawned), skip: ["instagram"], now: () => "2026-10-07T10:00:00.000Z" });
    assert.deepEqual(Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.ok === true ? "ok" : v.skipped ? "skipped" : "failed"])), { meta: "ok", presets: "ok", history: "failed", forms: "ok", identity: "ok", website: "ok", instagram: "skipped" });
    assert.match(state.steps.meta.note, /F45 Xinyi 信義 · 1 ad sets · 1 offer name/);
    assert.match(state.steps.history.error, /adsetHistory|not a function|campaigns/i, "the unstubbed step's error is kept");
    assert.equal(state.steps.identity.note, "not a Singapore gym");
    assert.deepEqual(spawned.map((a) => [a[0].split("/").pop(), a[a.indexOf("--url") + 1] || null]), [["read-website.mjs", "http://f45xinyi.com/6weekplan"]], "the website read on the Page's website; Instagram skipped");
    assert.ok(logs.some((l) => /fake read-website.mjs ran/.test(l)), "the reader's lines reach the log");
    assert.ok(existsSync(join(d, "onboarding", "meta", "reading.json")) && existsSync(join(d, "targeting-presets.json")) && existsSync(join(d, IMPORT_FILE)));
    const forms = JSON.parse(readFileSync(join(d, FORMS_FILE), "utf-8"));
    assert.deepEqual([forms.forms.length, forms.candidate.id, forms.candidate.name, forms.candidate.template.phrases], [5, "7001", "v8 -7月 2026 六週中年體態雕塑計畫", { offer: "六週中年體態雕塑計畫", district: "信義區" }], "v8 over v7 whatever the leads, the most leads within v8, never an archived or a chat form");
    assert.equal(templateCandidate([]), null);
    assert.equal(readImport(d).done, "2026-10-07T10:00:00.000Z");
    // The run a second time with Instagram: its own process on the Page's handle.
    const again = await runImport({ brandDir: d, client: client(), log: () => {}, spawnImpl: fakeSpawn(spawned, (a) => (a[0].endsWith("read-instagram.mjs") ? 3 : 0)), skip: ["website"] });
    const ig = spawned.find((a) => a[0].endsWith("read-instagram.mjs"));
    assert.deepEqual([ig[ig.indexOf("--handle") + 1], ig[ig.indexOf("--posts") + 1], again.steps.instagram.ok], ["f45_xinyi", "100", false], "a reader that exits with an error fails its step");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("IG2 the proposal and Add to the gym: Meta facts pre-ticked with the offer names unticked, the forms candidate ticked, the history's top ads; applying puts the Page's address, phone, hours, website, Instagram, pin, ages, budget and callout on the profile — never an offer name unless ticked — and sets the lead-form template; the website and history parts go through the hooks the panel gives; unticked sections are said to be skipped", async () => {
  const d = gymDir();
  try {
    await runImport({ brandDir: d, client: client(), log: () => {}, spawnImpl: fakeSpawn([]), skip: ["website", "instagram"] });
    const prop = importProposal(d);
    assert.deepEqual([prop.meta.ticked, prop.meta.offers.map((o) => o.ticked), prop.meta.pin.kind, prop.meta.callouts, prop.presets.ticked, prop.presets.count >= 1, prop.forms.ticked, prop.forms.candidate.id, prop.history.top], [true, [false], "place", ["信義區"], true, true, true, "7001", []]);
    assert.equal(prop.website, null, "no website reading: nothing to show");
    const hooks = { website: [], history: [] };
    const r = await applyImport(d, { meta: { pin: { radius_km: 3 }, offers: ["6 Week 中年體態雕塑"] }, forms: true, history: true, website: { colours: { primary: "#211551" } } }, { accept: { website: async (p) => { hooks.website.push(p); return { changes: ["primary #211551"] }; }, history: async (ids) => { hooks.history.push(ids); return { imported: 0 }; } } });
    const p = JSON.parse(readFileSync(join(d, "gym-profile.json"), "utf-8"));
    assert.deepEqual([p.locations[0].postal_code, p.locations[0].phone, p.social.instagram, p.website, p.targeting_defaults.geo.radius_pins[0].radius_km, p.targeting_defaults.geo.radius_pins[0].callouts, p.targeting_defaults.demographics.age_min, p.campaign_defaults.budget.amount, p.creative_defaults.locations], ["110", "+886980660800", "f45_xinyi", "http://f45xinyi.com/6weekplan", 3, ["信義區"], 28, 500, ["信義區"]]);
    assert.ok(r.changes.some((c) => /offer wordings: 6 Week 中年體態雕塑/.test(c)), "an offer name only as ticked");
    assert.equal(readLeadForms(d).template.source.id, "7001", "the lead-form template set from the candidate");
    assert.deepEqual([hooks.website, hooks.history], [[{ colours: { primary: "#211551" } }], [null]], "the panel's hooks called with the picks; history with no ids means the top ads");
    assert.deepEqual(r.skipped, []);
    const r2 = await applyImport(d, { forms: false }, {});
    assert.deepEqual(r2.skipped, ["meta", "forms", "history", "website"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
