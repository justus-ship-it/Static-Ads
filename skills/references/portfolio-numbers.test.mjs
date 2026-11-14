// portfolio-numbers.test.mjs — every gym's marketing numbers for a period (PN1–PN4). No network: the Meta client is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullDaily, gymNumbers, portfolioNumbers, refreshNumbers, readDaily, leftOut, figures, changeOf, addDays, DAILY_FILE, DAYS_KEPT, PERIODS, COST_UP, UNDER_PACE } from "./portfolio-numbers.mjs";

const NOW = new Date("2026-11-12T03:00:00Z"); // 12 Nov in Singapore and in Taipei
const UNTIL = "2026-11-12";
const lead = (n) => (n ? [{ action_type: "lead", value: String(n) }, { action_type: "link_click", value: "99" }] : []);
const gymDir = (root, gym, { currency = "SGD", country = "SG", timezone = "Asia/Singapore", account = "111", history = null } = {}) => {
  const dir = join(root, gym); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gym-profile.json"), JSON.stringify({ schema: 3, display_name: gym.toUpperCase(), locale: { currency, country, timezone }, meta_assets: account ? { ad_account_id: account } : {} }));
  if (history) writeFileSync(join(dir, "account-history.json"), JSON.stringify(history));
  return dir;
};
/** A fake account: S1 a lead ad set running (C1), S2 a hiring campaign, S3 an awareness campaign, S4 a lead ad set that reached abroad (known from the history on file). */
function fakeClient({ recentLeads = 2, budget = "12000", lastDaysSpend = 100, country = "SG", calls = [] } = {}) {
  const day = (i) => addDays(UNTIL, -i), rows = [];
  for (let i = 0; i < 60; i++) rows.push({ adset_id: "S1", adset_name: "1101 KATONG | 6 Week", campaign_id: "C1", campaign_name: "1101 6 Week Challenge | SS | Women", objective: "OUTCOME_LEADS", date_start: day(i),
    spend: String(i < 30 ? (i < 3 && i > 0 ? lastDaysSpend : 100) : 50), impressions: "1000", inline_link_clicks: "20", actions: lead(i < 7 ? recentLeads : i < 30 ? 4 : 2) });
  for (let i = 0; i < 10; i++) rows.push({ adset_id: "S2", adset_name: "Coaches", campaign_id: "C2", campaign_name: "HR | Hiring coaches", objective: "OUTCOME_LEADS", date_start: day(i), spend: "40", impressions: "500", inline_link_clicks: "5", actions: lead(3) });
  for (let i = 0; i < 10; i++) rows.push({ adset_id: "S3", adset_name: "Reach", campaign_id: "C3", campaign_name: "Brand", objective: "OUTCOME_AWARENESS", date_start: day(i), spend: "10", impressions: "5000", inline_link_clicks: "1", actions: [] });
  for (let i = 0; i < 3; i++) rows.push({ adset_id: "S5", adset_name: "Website", campaign_id: "C1", campaign_name: "1101 6 Week Challenge | SS | Women", objective: "OUTCOME_LEADS", date_start: day(i), spend: "20", impressions: "800", inline_link_clicks: "9", actions: [] });
  for (let i = 0; i < 2; i++) rows.push({ adset_id: "S6", adset_name: "WhatsApp", campaign_id: "C1", campaign_name: "1101 6 Week Challenge | SS | Women", objective: "OUTCOME_LEADS", date_start: day(i), spend: "8", impressions: "300", inline_link_clicks: "4", actions: [] });
  for (let i = 0; i < 5; i++) rows.push({ adset_id: "S4", adset_name: "Dhaka", campaign_id: "C4", campaign_name: "Leads abroad", objective: "OUTCOME_LEADS", date_start: day(i), spend: "5", impressions: "9000", inline_link_clicks: "90", actions: lead(30) });
  return { calls, list: async (path, params) => {
    calls.push({ path, ...params });
    if (/\/adsets$/.test(path)) return [{ id: "S1", optimization_goal: "LEAD_GENERATION" }, { id: "S2", optimization_goal: "QUALITY_LEAD" }, { id: "S5", optimization_goal: "OFFSITE_CONVERSIONS" }, { id: "S6", optimization_goal: "CONVERSATIONS" }, { id: "S7", optimization_goal: "OFFSITE_CONVERSIONS" }];
    if (/\/ads$/.test(path)) return [
      { id: "A1", name: "c01", adset_id: "S1", campaign_id: "C1", created_time: "2026-11-01T02:00:00+0800", adset: { id: "S1", name: "1101 KATONG | 6 Week", daily_budget: budget, targeting: { geo_locations: { custom_locations: [{ country }] } } }, campaign: { id: "C1", name: "1101 6 Week Challenge | SS | Women", objective: "OUTCOME_LEADS" } },
      { id: "A2", name: "c02", adset_id: "S1", campaign_id: "C1", created_time: "2026-11-08T02:00:00+0800", adset: { id: "S1", name: "1101 KATONG | 6 Week", daily_budget: budget, targeting: { geo_locations: { custom_locations: [{ country }] } } }, campaign: { id: "C1", name: "1101 6 Week Challenge | SS | Women", objective: "OUTCOME_LEADS" } },
      { id: "A9", name: "hr", adset_id: "S2", campaign_id: "C2", created_time: "2026-11-02T02:00:00+0800", adset: { id: "S2", name: "Coaches", daily_budget: "4000" }, campaign: { id: "C2", name: "HR | Hiring coaches", objective: "OUTCOME_LEADS" } },
    ];
    if (params.time_increment) return rows;
    const d = Math.round((Date.parse(JSON.parse(params.time_range).until) - Date.parse(JSON.parse(params.time_range).since)) / 86400000) + 1;
    if (params.level === "adset") return [{ adset_id: "S1", impressions: String(1000 * d), reach: String(d === 30 ? 9000 : 5000 * (d / 7)), frequency: d === 30 ? "3.3333" : "1.4" }, { adset_id: "S2", impressions: "5000", reach: "1000", frequency: "5" }];
    return [
      { ad_id: "A1", ad_name: "c01", adset_id: "S1", campaign_id: "C1", spend: "300", impressions: "3000", inline_link_clicks: "60", actions: lead(12) },
      { ad_id: "A2", ad_name: "c02", adset_id: "S1", campaign_id: "C1", spend: "250", impressions: "2500", inline_link_clicks: "50", actions: lead(2) },
      { ad_id: "A3", ad_name: "c03", adset_id: "S1", campaign_id: "C1", spend: "150", impressions: "1500", inline_link_clicks: "30", actions: [] },
      { ad_id: "A9", ad_name: "hr", adset_id: "S2", campaign_id: "C2", spend: "400", impressions: "5000", inline_link_clicks: "50", actions: lead(30) },
    ];
  } };
}
const HISTORY = { pulled: "2026-11-10T04:00:00.000Z", account: "act_111", currency: "SGD", campaigns: [], adsets: [{ id: "S4", abroad: true }], ads: [] };

test("PN1 the read: nine read-only calls, one file, and what is left out of the numbers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pn1-")), dir = gymDir(root, "one", { history: HISTORY }), calls = [];
  const file = await pullDaily({ client: fakeClient({ calls }), accountId: "111", gymDir: dir, now: NOW });
  assert.equal(calls.length, 9, "one day-by-day read, reach and ads for three periods, the running ads, what each ad set was after");
  assert.deepEqual([calls[8].path, calls[8].fields], ["act_111/adsets", "id,optimization_goal"]);
  assert.ok(calls.every((c) => c.path.startsWith("act_111/")), "the account's own edges only");
  const daily = calls[0]; assert.equal(daily.level, "adset"); assert.equal(daily.time_increment, 1);
  assert.deepEqual(JSON.parse(daily.time_range), { since: addDays(UNTIL, -(DAYS_KEPT - 1)), until: UNTIL }, "the last 180 days up to today in the account's time zone");
  assert.deepEqual(calls.filter((c) => !c.time_increment && c.level === "adset").map((c) => JSON.parse(c.time_range).since), PERIODS.map((d) => addDays(UNTIL, -(d - 1))));
  assert.equal(calls[7].effective_status, '["ACTIVE"]', "only the ads delivering now");
  assert.ok(existsSync(join(dir, DAILY_FILE)));
  const onDisk = readDaily(dir); assert.deepEqual(onDisk.span, file.span); assert.equal(onDisk.currency, "SGD");
  assert.equal(onDisk.adsets.S1.left_out, null); assert.equal(onDisk.adsets.S1.running, true); assert.equal(onDisk.adsets.S1.daily_budget, 120, "cents become dollars");
  assert.equal(onDisk.adsets.S2.left_out, "recruitment"); assert.equal(onDisk.adsets.S3.left_out, "objective");
  assert.equal(onDisk.adsets.S4.left_out, "abroad", "an ad set no longer running is known to reach abroad from the history on file");
  assert.deepEqual([onDisk.adsets.S5.left_out, onDisk.adsets.S6.left_out, onDisk.adsets.S1.goal], ["website", "chat", "LEAD_GENERATION"], "after website conversions or chats inside a leads campaign: left out by the ad set's own goal");
  assert.deepEqual(onDisk.not_leads, { S5: "website", S6: "chat", S7: "website" }, "every ad set of the account, for the review's older rows");
  assert.equal(onDisk.days.length, 90); assert.deepEqual(onDisk.days[0], { d: UNTIL, s: "S1", spend: 100, impressions: 1000, clicks: 20, leads: 2 });
  assert.equal(onDisk.ads[7].length, 4); assert.equal(onDisk.live.length, 3); assert.deepEqual(onDisk.errors, []);
  assert.ok(!/token|EAA/i.test(readFileSync(join(dir, DAILY_FILE), "utf-8")), "no token is ever written");
  // A step that fails is said and the rest is kept; the day-by-day read failing fails the read.
  const c2 = fakeClient(), inner = c2.list; c2.list = async (p, q) => { if (q.level === "ad") throw new Error("Meta said no access_token=EAAsecretsecretsecretsecret"); return inner(p, q); };
  const f2 = await pullDaily({ client: c2, accountId: "act_111", gymDir: dir, now: NOW });
  assert.equal(f2.errors.length, 3); assert.ok(f2.errors.every((e) => !/EAAsecret/.test(e)), "the token is scrubbed"); assert.equal(f2.days.length, 90);
  const c3 = fakeClient(); c3.list = async () => { throw new Error("down"); };
  await assert.rejects(pullDaily({ client: c3, accountId: "111", gymDir: dir, now: NOW }), /down/);
  assert.equal(leftOut({ objective: "OUTCOME_TRAFFIC" }), "objective"); assert.equal(leftOut({ name: "招募教練" }), "recruitment"); assert.equal(leftOut({ objective: "OUTCOME_LEADS", campaign: "6 Week" }), null);
});

test("PN2 the numbers: each period against the one before, the marks, the best and dearest ad, the campaigns", async () => {
  const root = mkdtempSync(join(tmpdir(), "pn2-")), dir = gymDir(root, "one", { history: HISTORY });
  assert.equal(gymNumbers(dir, { now: NOW }).source, "none", "nothing on file yet");
  await pullDaily({ client: fakeClient(), accountId: "111", gymDir: dir, now: NOW });
  const n = gymNumbers(dir, { now: NOW });
  assert.equal(n.source, "meta"); assert.equal(n.currency, "SGD"); assert.equal(n.until, UNTIL); assert.equal(n.stale, false);
  // 7 days: 700 spent for 14 leads (50 a lead) against 700 for 28 (25): the hiring, awareness and abroad ad sets are not in it.
  const w = n.periods[7];
  assert.deepEqual([w.spend, w.leads, w.cost_per_lead, w.cpm, w.ctr, w.click_to_lead, w.frequency], [700, 14, 50, 100, 2, 10, 1.4]);
  assert.deepEqual([w.from, w.to, w.prev.from, w.prev.to], [addDays(UNTIL, -6), UNTIL, addDays(UNTIL, -13), addDays(UNTIL, -7)]);
  assert.deepEqual([w.prev.spend, w.prev.leads, w.prev.cost_per_lead], [700, 28, 25]);
  assert.deepEqual(w.change, { spend: 0, leads: -50, cost_per_lead: 100 });
  assert.ok(n.flags[7].some((f) => f.kind === "cost_up"), `cost per lead doubled: past ${COST_UP}×`);
  // 30 days: 3,000 for 106 leads against 1,500 for 60: up 13%, no mark.
  const m = n.periods[30];
  assert.deepEqual([m.spend, m.leads, m.cost_per_lead, m.prev.leads, m.prev.cost_per_lead, m.frequency], [3000, 106, 28.3, 60, 25, 3.33]);
  assert.equal(m.change.cost_per_lead, 13.2); assert.ok(!n.flags[30].some((f) => f.kind === "cost_up"));
  assert.ok(n.flags[30].some((f) => f.kind === "tiring" && /3\.33/.test(f.text)), "an ad set seen 3+ times in 30 days");
  // 90 days: only 60 days of delivery, and the 90 days before are on file (180 kept).
  assert.equal(n.periods[90].spend, 4500); assert.equal(n.periods[90].prev.spend, 0); assert.equal(n.periods[90].change.cost_per_lead, null);
  // What is left out is said beside the row, never added: the hiring and awareness campaigns and the ad set abroad.
  assert.equal(n.other[7], 7 * 40 + 7 * 10 + 5 * 5 + 3 * 20 + 2 * 8); assert.deepEqual(n.left_out, { recruitment: 1, objective: 1, website: 1, chat: 1, abroad: 1 });
  // The best ad has 3+ leads; the dearest is the one that spent two leads' worth for nothing.
  assert.deepEqual(n.ads[7].best, { ad_id: "A1", name: "c01", spend: 300, leads: 12, cost_per_lead: 25 });
  assert.deepEqual(n.ads[7].dearest, { ad_id: "A3", name: "c03", spend: 150, leads: 0, cost_per_lead: null });
  // Running: the hiring ad is not counted; the budget is the ad set's; the newest ad is 4 days old.
  assert.deepEqual(n.running, { ads: 2, adsets: 1, campaigns: 1, budget: 120, pace: 0.83 });
  assert.equal(n.newest_ad, "2026-11-08"); assert.equal(n.newest_ad_days, 4); assert.equal(n.last_lead, UNTIL); assert.equal(n.days_since_lead, 0);
  assert.ok(!n.flags[7].some((f) => ["nothing_running", "no_leads", "under_budget"].includes(f.kind)));
  assert.equal(n.series.length, 90); assert.deepEqual(n.series[89], { date: UNTIL, spend: 100, leads: 2 }); assert.deepEqual(n.series[0], { date: addDays(UNTIL, -89), spend: 0, leads: 0 });
  assert.equal(n.campaigns.length, 1, "only campaigns that count");
  const c = n.campaigns[0]; assert.equal(c.id, "C1"); assert.equal(c.running, true); assert.equal(c.ads_running, 2); assert.equal(c.budget, 120); assert.equal(c.periods[7].cost_per_lead, 50); assert.equal(c.ads[7].best.ad_id, "A1"); assert.equal(c.frequency_30d, 3.33);
  // No lead in the last days, and spending well under the budget.
  await pullDaily({ client: fakeClient({ recentLeads: 0, lastDaysSpend: 30 }), accountId: "111", gymDir: dir, now: NOW });
  const dry = gymNumbers(dir, { now: NOW });
  assert.ok(dry.flags[7].some((f) => f.kind === "no_leads" && /no lead in 7 days/.test(f.text)), JSON.stringify(dry.flags[7]));
  assert.equal(dry.running.pace, round(((30 + 30 + 100) / 3) / 120)); assert.ok(dry.running.pace < UNDER_PACE); assert.ok(dry.flags[7].some((f) => f.kind === "under_budget" && /44%/.test(f.text)));
  assert.equal(dry.periods[7].cost_per_lead, null); assert.equal(dry.periods[7].change.cost_per_lead, null);
  // A cost per lead is compared only with 5+ leads on each side.
  await pullDaily({ client: fakeClient({ recentLeads: 0.5 }), accountId: "111", gymDir: dir, now: NOW });
  const thin = gymNumbers(dir, { now: NOW }).periods[7];
  assert.deepEqual([thin.leads, thin.cost_per_lead, thin.prev.leads, thin.change.cost_per_lead, thin.change.leads], [3.5, 200, 28, null, -87.5]);
  // Numbers read long ago are said to be old.
  assert.equal(gymNumbers(dir, { now: new Date("2026-11-14T03:00:00Z") }).stale, true);
  assert.deepEqual(figures({ spend: 10, impressions: 0, clicks: 0, leads: 0 }), { spend: 10, leads: 0, impressions: 0, clicks: 0, cost_per_lead: null, cpm: null, ctr: null, click_to_lead: null, frequency: null });
  assert.equal(changeOf(30, 0), null); assert.equal(changeOf(null, 20), null); assert.equal(changeOf(30, 20), 50);
});
const round = (v) => Math.round(v * 100) / 100;

test("PN3 every gym side by side: money per currency only, an export's own period, a gym not read yet", async () => {
  const root = mkdtempSync(join(tmpdir(), "pn3-"));
  const sg = gymDir(root, "alpha", { history: HISTORY }), tw = gymDir(root, "beta", { currency: "TWD", country: "TW", timezone: "Asia/Taipei", account: "222", history: HISTORY });
  await pullDaily({ client: fakeClient(), accountId: "111", gymDir: sg, now: NOW });
  await pullDaily({ client: fakeClient({ budget: "2000", country: "TW" }), accountId: "222", gymDir: tw, now: NOW });
  assert.equal(readDaily(tw).adsets.S1.daily_budget, 2000, "a TWD budget is in whole units");
  // A gym whose running ads came as an Ads Manager export, and one with only its history on file.
  const ad = (id, over = {}) => ({ id, name: id, adset_id: "x1", campaign_id: "xc", campaign: "Toned Tummy", adset: "JW set", words: "active", effective_status: "ACTIVE", origin: "export", media: "image", created: "2026-04-13", all_time: { spend: 100, impressions: 10000, reach: 2500, clicks: 0, leads: 5, cost_per_lead: 20, ctr: 0, cpm: 10, frequency: 4 }, ...over });
  gymDir(root, "gamma", { history: { pulled: "2026-11-11T10:00:00.000Z", currency: "SGD", campaigns: [{ id: "xc", name: "Toned Tummy", objective: null, words: "active" }], adsets: [{ id: "x1", name: "JW set" }], ads: [ad("export:1"), ad("export:2", { all_time: { spend: 60, impressions: 5000, reach: 5000, clicks: 0, leads: 1, cost_per_lead: 60, ctr: 0, cpm: 12, frequency: 1 } })], exports: [{ file: "jw.csv", label: "the live account", imported: "2026-11-09T16:00:00.000Z", reporting: { from: "2023-10-08", to: "2026-11-08" } }] } });
  gymDir(root, "delta", { account: "444", history: { pulled: "2026-11-10T04:00:00.000Z", currency: "SGD", campaigns: [{ id: "oc", name: "Old", objective: "OUTCOME_LEADS", words: "paused" }], adsets: [{ id: "o1" }], ads: [{ id: "o-1", name: "old", adset_id: "o1", campaign_id: "oc", campaign: "Old", adset: "o", words: "paused", media: "image", all_time: { spend: 500, impressions: 20000, reach: 9000, clicks: 200, leads: 25, cost_per_lead: 20, ctr: 1, cpm: 25, frequency: 2.2 } }] } });
  // The account that can be read comes first: a gym with an export on file whose linked account was read shows that account's periods, the export beside them.
  const ep = gymDir(root, "epsilon", { account: "555", history: { pulled: "2026-11-11T10:00:00.000Z", currency: "SGD", campaigns: [{ id: "xc", name: "Toned Tummy", objective: null, words: "active" }], adsets: [{ id: "x1", name: "JW set" }, { id: "S4", abroad: true }], ads: [ad("export:8"), ad("export:9")], exports: [{ file: "jw.csv", label: "the live account", reporting: { to: "2026-11-08" } }] } });
  const quiet = fakeClient(), list = quiet.list; quiet.list = async (p, q) => (/\/ads$/.test(p) ? [] : list(p, q));
  await pullDaily({ client: quiet, accountId: "555", gymDir: ep, now: NOW });
  const e = gymNumbers(ep, { now: NOW });
  assert.equal(e.source, "meta"); assert.equal(e.periods[7].spend, 700); assert.equal(e.running.ads, 0); assert.equal(e.fixed, undefined);
  assert.deepEqual(e.export_also, { file: "jw.csv", label: "the live account", to: "2026-11-08", ads: 2, spend: 200, leads: 10, cost_per_lead: 20, tiring: 2 });
  assert.deepEqual(e.flags[7].map((f) => f.kind).filter((k) => /running/.test(k)), ["export_running"], "nothing running is not said over an export's running ads");
  assert.match(e.flags[7].find((f) => f.kind === "export_running").text, /^2 ads in an account not linked$/);
  mkdirSync(join(root, "_trash")); mkdirSync(join(root, "empty-folder"));
  const P = portfolioNumbers(root, { now: NOW });
  assert.deepEqual(P.gyms.map((g) => [g.gym, g.source]), [["alpha", "meta"], ["beta", "meta"], ["delta", "file"], ["epsilon", "meta"], ["gamma", "export"]], "a folder without a profile is no gym");
  // The export: its own period, the ads running in it, no period figures and no trend.
  const g = P.gyms[4]; assert.deepEqual(P.elsewhere, [{ gym: "epsilon", name: "EPSILON", ads: 2, to: "2026-11-08" }]);
  assert.equal(g.periods, undefined); assert.equal(g.series, undefined); assert.deepEqual(g.export, { file: "jw.csv", label: "the live account", to: "2026-11-08" });
  assert.deepEqual([g.fixed.spend, g.fixed.leads, g.fixed.cost_per_lead, g.fixed.cpm, g.fixed.ctr, g.fixed.click_to_lead, g.fixed.frequency], [160, 6, 26.67, 10.67, null, null, 3], "an export without clicks says no click rate, never 0%");
  assert.deepEqual(g.flags, [{ kind: "tiring", tone: "warn", text: "1 ad tiring" }]); assert.equal(g.running.ads, 2); assert.equal(g.fixed.ads.best.ad_id, "export:1"); assert.equal(g.fixed.campaigns[0].name, "Toned Tummy");
  // Not read yet: all time from the history, and it is named as not read.
  const d = P.gyms[2]; assert.equal(d.all.spend, 500); assert.equal(d.all.cost_per_lead, 20); assert.equal(d.all.as_of, "2026-11-10T04:00:00.000Z"); assert.deepEqual(P.unread, ["DELTA"]); assert.deepEqual(P.outside, ["GAMMA"]);
  // The totals: leads summed over the gyms read day by day; money per currency, never across.
  const t = P.totals[7];
  assert.equal(t.gyms, 3); assert.equal(t.leads, 42); assert.equal(t.leads_prev, 84); assert.equal(t.leads_change, -50);
  assert.deepEqual(Object.keys(t.by_currency).sort(), ["SGD", "TWD"]);
  assert.deepEqual([t.by_currency.SGD.spend, t.by_currency.SGD.cost_per_lead, t.by_currency.SGD.change, t.by_currency.SGD.gyms], [1400, 50, 100, 2]);
  assert.equal(t.by_currency.TWD.spend, 700);
  assert.deepEqual(P.running, { ads: 2 + 2 + 2, gyms: 3, of: 5 }, "an export's ads beside an account that was read are named, not counted");
  assert.equal(P.totals.all.by_currency.SGD.spend, 160 + 500 + 200, "all time: every gym with rows on file"); assert.equal(P.totals.all.leads, 6 + 25 + 10);
  assert.equal(P.read.oldest, NOW.toISOString());
});

test("PN4 refreshing every gym: a gym without an account or a link is said, one failure does not stop the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "pn4-"));
  gymDir(root, "alpha", { history: HISTORY }); gymDir(root, "beta", { account: "222" }); gymDir(root, "gamma", { account: null }); gymDir(root, "delta", { account: "444" });
  const log = [];
  const done = await refreshNumbers({ brandsDir: root, now: NOW, log: (m) => log.push(m), clientFor: (gym) => (gym === "delta" ? null : gym === "beta" ? { list: async () => { throw new Error("(#17) too many calls, access_token=EAAxxxxxxxxxxxxxxxxxxxxxxx"); } } : fakeClient()) });
  assert.deepEqual(done.map((d) => [d.gym, d.skipped || (d.error ? "error" : "ok")]), [["alpha", "ok"], ["beta", "error"], ["delta", "no Meta link"], ["gamma", "no ad account"]]);
  assert.ok(existsSync(join(root, "alpha", DAILY_FILE))); assert.ok(!existsSync(join(root, "beta", DAILY_FILE)));
  assert.match(log[0], /ALPHA: 90 ad-set days, 3 ads running · last 30 days SGD 3000 spent, 106 leads at 28.3/);
  assert.ok(log.every((l) => !/EAAx/.test(l)), "no token in the log");
});
