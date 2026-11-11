/**
 * Tests for the cycle's status (2026-11-11) — pure: no files, no Meta, no Gemini.
 *
 *   node --test skills/references/cycle.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleFrom, STEPS, OPEN_DAYS, WAIT_DAYS, STALE_DAYS } from "./cycle.mjs";

const NOW = new Date("2026-11-11T08:00:00Z");
const review = (over = {}) => ({ currency: "SGD", numbers: { running: { ads: 10, leads: 266, spend: 5242.11, cost_per_lead: 19.71 }, all_time: { ads: 151, leads: 1407 } }, data: { pulled: "2026-11-10T03:00:00Z", exports: [] }, last: { reviewed: "2026-11-10T03:05:00Z" }, scenes: [], scenes_waiting: 0, ...over });
const batch = (id, over = {}) => ({ id, made: `${id.slice(0, 10)}T05:00:00Z`, ads: 20, running: null, stopped: null, failed: null, published: null, review: { kept: 20, excluded: 0, unreviewed: 0 }, ...over });
const onMeta = (at, over = {}) => ({ ads: 20, done: true, at, status: "live", leads: 12, ...over });
const states = (c) => c.steps.map((s) => s.state);

test("CY1 the five steps in the owner's order, each on its own screen; a gym with nothing waiting is sent to generate the next batch, filled in from the review", () => {
  assert.deepEqual(STEPS.map((s) => [s.name, s.tab]), [["Review Data", "results"], ["Draft Scenes", "scenes"], ["Generate Creatives", "batch"], ["Pick Ads", "review"], ["Publish Ads", "exports"]]);
  const c = cycleFrom({ review: review(), batches: [batch("2026-09-24-offer", { published: onMeta("2026-09-25T02:00:00Z", { leads: 266 }) })], now: NOW });
  assert.deepEqual(c.steps.map((s) => [s.n, s.name, s.tab]), STEPS.map((s, i) => [i + 1, s.name, s.tab]));
  assert.deepEqual(states(c), ["ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(c.steps.map((s) => s.text), ["266 leads at SGD 19.71 running · read 10 Nov", "Nothing waiting", "Last batch made 24 Sep", "Nothing to pick", "Last published 25 Sep · 266 leads"]);
  assert.deepEqual([c.next.step, c.next.name, c.next.tab, c.next.text], [3, "Generate Creatives", "batch", "Generate the next batch: it opens filled in from the review."]);
  assert.deepEqual(c.counts, { scenes: 0, pick: 0, publish: 0 });
});

test("CY2 scenes: a kind in the mix with no approved scene, or drafts awaiting approval, is the next thing once no batch is in hand; a suggestion to draft new versions of the winners is said and never nags", () => {
  const jobs = [{ format: "workout", needed: false, from_results: true }, { format: "studio-portrait", needed: true, from_results: true }];
  let c = cycleFrom({ review: review({ scenes: jobs }), batches: [], now: NOW });
  assert.deepEqual([c.steps[1].state, c.steps[1].text, c.next.step, c.next.tab, c.next.text, c.counts.scenes], ["todo", "1 kind needs scenes", 2, "scenes", "Draft studio portrait scenes, then approve them: the next batch needs them.", 1]);
  c = cycleFrom({ review: review({ scenes: jobs, scenes_waiting: 6 }), batches: [], now: NOW });
  assert.deepEqual([c.steps[1].text, c.counts.scenes, c.next.text], ["1 kind needs scenes · 6 drafts to approve", 7, "Draft studio portrait scenes, then approve them: the next batch needs them."], "the drafts waiting are of another kind");
  // Drafts of the kind it needs are already waiting: deciding them is the next thing, not drafting more.
  c = cycleFrom({ review: review({ scenes: [jobs[0], { ...jobs[1], drafts_waiting: 6 }], scenes_waiting: 10 }), batches: [], now: NOW });
  assert.deepEqual([c.steps[1].state, c.next.step, c.next.text], ["todo", 2, "Approve the studio portrait scenes you want (6 drafts waiting): the next batch needs that kind."]);
  c = cycleFrom({ review: review({ scenes: [jobs[0]], scenes_waiting: 1 }), batches: [], now: NOW });
  assert.deepEqual([c.steps[1].state, c.steps[1].text, c.next.text], ["todo", "1 draft to approve", "Approve or reject 1 scene draft."]);
  c = cycleFrom({ review: review({ scenes: [jobs[0]] }), batches: [], now: NOW });
  assert.deepEqual([c.steps[1].state, c.steps[1].text, c.next.step], ["ok", "New versions of the winners suggested", 3], "a suggestion is not a to-do");
});

test("CY3 a batch in hand is finished before the next is prepared: generating, then its ads picked, then published — whatever the scenes or the data ask for; an old unpublished batch stops nudging", () => {
  const needs = review({ scenes: [{ format: "studio-portrait", needed: true }] });
  let c = cycleFrom({ review: needs, batches: [batch("2026-11-11-offer", { made: null, ads: 0, running: { id: "r1", kind: "batch" }, review: null })], now: NOW });
  assert.deepEqual([c.steps[2].state, c.steps[2].text, c.next.step, c.next.tab, c.next.batch], ["going", "Generating 2026-11-11-offer", 3, "generating", "2026-11-11-offer"]);
  c = cycleFrom({ review: needs, batches: [batch("2026-11-10-offer", { review: { kept: 14, excluded: 2, unreviewed: 4 } })], now: NOW });
  assert.deepEqual([states(c).slice(3), c.steps[3].text, c.next.step, c.next.tab, c.next.batch, c.next.text, c.counts.pick], [["todo", "ok"], "4 ads to look at", 4, "review", "2026-11-10-offer", "Pick the ads of 2026-11-10-offer: 4 ads not looked at yet.", 1]);
  c = cycleFrom({ review: needs, batches: [batch("2026-11-10-offer", { review: { kept: 16, excluded: 4, unreviewed: 0 } })], now: NOW });
  assert.deepEqual([states(c).slice(3), c.steps[3].text, c.steps[4].text, c.next.step, c.next.tab, c.next.batch, c.next.text, c.counts.publish], [["ok", "todo"], "16 ads kept", "1 batch ready", 5, "publish", "2026-11-10-offer", "Publish 2026-11-10-offer: 16 ads kept.", 1]);
  c = cycleFrom({ review: review(), batches: [batch("2026-11-10-offer", { published: onMeta("2026-11-10T09:00:00Z", { done: false }) })], now: NOW });
  assert.deepEqual([c.steps[4].state, c.steps[4].text, c.next.tab, c.next.text], ["todo", "2026-11-10-offer: creating not finished", "publish", "Creating 2026-11-10-offer on Meta did not finish: continue it."]);
  // An abandoned test from two months back is nobody's to-do.
  const old = cycleFrom({ review: needs, batches: [batch("2026-09-01-offer", { review: { kept: 0, excluded: 0, unreviewed: 20 } })], now: NOW });
  assert.deepEqual([states(old).slice(3), old.next.step], [["ok", "ok"], 2]); assert.ok(OPEN_DAYS < 71);
  // A stopped or unfinished run nudges only while it is the newest batch.
  const stopped = batch("2026-11-11-offer", { made: null, ads: 0, review: null, stopped: { image_calls: 3 } });
  c = cycleFrom({ review: review(), batches: [stopped, batch("2026-09-24-offer", { published: onMeta("2026-09-25T02:00:00Z") })], now: NOW });
  assert.deepEqual([c.steps[2].state, c.steps[2].text, c.next.text], ["todo", "2026-11-11-offer was stopped", "2026-11-11-offer was stopped: run it again or discard it."]);
  c = cycleFrom({ review: review(), batches: [batch("2026-11-11-offer-2", { published: onMeta("2026-11-01T02:00:00Z") }), { ...stopped, id: "2026-11-11-offer" }], now: NOW });
  assert.equal(c.steps[2].state, "ok");
});

test("CY4 back to the data: just published, the results are worth reading in a few days; then the account is read again before the next batch; data a week old with ads running is read again; a gym with nothing on file is told where to start", () => {
  let c = cycleFrom({ review: review({ data: { pulled: "2026-11-09T03:00:00Z", exports: [] } }), batches: [batch("2026-11-09-offer", { published: onMeta("2026-11-10T02:00:00Z") })], now: NOW });
  assert.deepEqual([c.next.step, c.next.tab, c.next.idle, c.next.text], [1, "results", true, "Published 10 Nov: the results are worth reading from 13 Nov."]); assert.equal(WAIT_DAYS, 3);
  c = cycleFrom({ review: review({ data: { pulled: "2026-11-01T03:00:00Z", exports: [] } }), batches: [batch("2026-10-30-offer", { published: onMeta("2026-11-05T02:00:00Z") })], now: NOW });
  assert.deepEqual([c.steps[0].state, c.next.step, c.next.text], ["todo", 1, "The account was last read 10 days ago: review it again before the next batch."]); assert.equal(STALE_DAYS, 7);
  c = cycleFrom({ review: review({ data: { pulled: "2026-11-06T03:00:00Z", exports: [] } }), batches: [batch("2026-10-30-offer", { published: onMeta("2026-11-07T02:00:00Z") })], now: NOW });
  assert.deepEqual([c.steps[0].state, c.next.step, c.next.text], ["ok", 1, "The account has not been read since 2026-10-30-offer was published: review it."]);
  // An account that comes by export: its latest import is when its data was read.
  c = cycleFrom({ review: review({ data: { pulled: null, exports: [{ label: "a", imported: "2026-11-09T01:00:00Z" }] } }), batches: [], now: NOW });
  assert.deepEqual([c.data_at, c.steps[0].text], ["2026-11-09T01:00:00Z", "266 leads at SGD 19.71 running · read 9 Nov"]);
  // Nothing running: old data is no to-do; nothing at all: the start.
  c = cycleFrom({ review: review({ numbers: { running: { ads: 0, leads: 0 }, all_time: { ads: 30, leads: 80 } }, data: { pulled: "2026-09-01T03:00:00Z", exports: [] } }), batches: [], now: NOW });
  assert.deepEqual([c.steps[0].state, c.steps[0].text, c.next.step], ["ok", "Nothing running now · read 1 Sep", 3]);
  c = cycleFrom({ review: review({ numbers: { running: { ads: 0, leads: 0 }, all_time: { ads: 0, leads: 0 } }, data: { pulled: null, exports: [] }, last: null }), batches: [], now: NOW });
  assert.deepEqual([c.steps[0].state, c.steps[0].text, c.steps[2].text, c.steps[4].text, c.next.step, c.next.text], ["todo", "No results on file yet", "No batch yet", "Nothing on Meta from this app", 1, "No results on file yet: review the account, or go straight to a first batch."]);
  assert.doesNotThrow(() => cycleFrom({}), "nothing given is a gym with nothing");
});
