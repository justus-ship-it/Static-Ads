/**
 * The cycle (2026-11-11, the owner's process): Review Data → Draft Scenes → Generate Creatives → Pick Ads →
 * Publish Ads → Review Data. One pure function says where a gym stands on each step and what to do next, from what is
 * on file: the account review (account-review.mjs → buildReview) and the gym's batches (the panel's listBatches).
 * No Meta call, no model call, nothing written. The steps never lock: this only ever nudges.
 *
 *   cycleFrom({ review, batches, now }) → { steps[5], next, counts }
 *
 * A step: { id, tab, n, name, state, text }.
 *   state  "todo"  — something here is waiting for the owner
 *          "going" — a run is working on it now
 *          "ok"    — nothing waiting
 *   text   one short line: the number that matters on that step
 * next: { text, tab, batch?, step } — the one thing to do now, in the cycle's own order: a batch in hand is finished
 * (picked, published) before the next one is prepared (data read, scenes drafted, creatives generated).
 */

/** The five steps, in order; `tab` is the panel's screen for it. */
export const STEPS = [
  { id: "review-data", tab: "results", name: "Review Data" },
  { id: "draft-scenes", tab: "scenes", name: "Draft Scenes" },
  { id: "generate-creatives", tab: "batch", name: "Generate Creatives" },
  { id: "pick-ads", tab: "review", name: "Pick Ads" },
  { id: "publish-ads", tab: "exports", name: "Publish Ads" },
];
/** A finished batch that was never published stops nudging after this many days (an abandoned test is not a to-do). */
export const OPEN_DAYS = 30;
/** After publishing, the results are worth reading from this many days on; account data older than STALE_DAYS is read again first. */
export const WAIT_DAYS = 3, STALE_DAYS = 7;

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kindName = (f) => String(f).replace(/-/g, " ");
const money = (n, cur) => `${cur} ${Number(n).toFixed(2)}`;
const shortDate = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`; };

/**
 * `review`: buildReview's answer (numbers, data, last, scenes, scenes_waiting, currency). `batches`: the panel's
 * list — { id, made, ads, running, stopped, failed, review { kept, excluded, unreviewed }, published { ads, done, at, status, leads } }.
 */
export function cycleFrom({ review, batches = [], now = new Date() } = {}) {
  const R = review || {}, cur = R.currency || "SGD", today = now.toISOString();
  const n = R.numbers || {}, running = n.running || { ads: 0, leads: 0 }, all = n.all_time || { ads: 0, leads: 0 };
  // When the account's data was last brought in: a pull from Meta, else the latest Ads Manager export.
  const dataAt = R.data?.pulled || (R.data?.exports || []).map((e) => e.imported).filter(Boolean).sort().pop() || null;
  const dataAge = dataAt ? daysBetween(dataAt, today) : null, reviewedAt = R.last?.reviewed || null;

  const jobs = R.scenes || [], needed = jobs.filter((j) => j.needed), suggested = jobs.filter((j) => !j.needed), waiting = R.scenes_waiting || 0;
  const fresh = (b) => b.made && daysBetween(b.made, today) <= OPEN_DAYS;
  // A stopped or unfinished run nudges only while it is the gym's newest batch (the list is newest first).
  const going = batches.find((b) => b.running), broken = batches[0] && (batches[0].stopped || batches[0].failed) && !batches[0].running ? batches[0] : null;
  const open = batches.filter((b) => b.made && !b.published && fresh(b) && (b.ads || 0) > 0); // made, not on Meta, recent
  const toPick = open.find((b) => (b.review?.unreviewed || 0) > 0), ready = open.find((b) => !(b.review?.unreviewed > 0) && (b.review?.kept ?? b.ads) > 0);
  const partly = batches.find((b) => b.published && !b.published.done);
  const published = batches.filter((b) => b.published).sort((a, b) => String(b.published.at || b.made || "").localeCompare(String(a.published.at || a.made || "")));
  const lastPub = published[0] || null, pubAge = lastPub?.published.at ? daysBetween(lastPub.published.at, today) : null;
  const lastMade = batches.filter((b) => b.made).sort((a, b) => String(b.made).localeCompare(String(a.made)))[0] || null;

  const steps = [
    { state: !all.ads || (dataAge != null && dataAge > STALE_DAYS && running.ads > 0) ? "todo" : "ok",
      text: !all.ads ? "No results on file yet" : `${running.ads ? `${plural(running.leads, "lead")}${running.cost_per_lead != null ? ` at ${money(running.cost_per_lead, cur)}` : ""} running` : "Nothing running now"}${dataAt ? ` · read ${shortDate(dataAt)}` : ""}` },
    { state: needed.length || waiting ? "todo" : "ok",
      text: needed.length ? `${plural(needed.length, "kind")} ${needed.length === 1 ? "needs" : "need"} scenes${waiting ? ` · ${plural(waiting, "draft")} to approve` : ""}` : waiting ? `${plural(waiting, "draft")} to approve` : suggested.length ? "New versions of the winners suggested" : "Nothing waiting" },
    { state: going ? "going" : broken ? "todo" : "ok",
      text: going ? `Generating ${going.id}` : broken ? `${broken.id} ${broken.stopped ? "was stopped" : "did not finish"}` : lastMade ? `Last batch made ${shortDate(lastMade.made)}` : "No batch yet" },
    { state: toPick ? "todo" : "ok",
      text: toPick ? `${plural(toPick.review.unreviewed, "ad")} to look at` : ready ? `${plural(ready.review?.kept ?? ready.ads, "ad")} kept` : "Nothing to pick" },
    { state: ready || partly ? "todo" : "ok",
      text: partly ? `${partly.id}: creating not finished` : ready ? "1 batch ready" : lastPub ? `Last published ${shortDate(lastPub.published.at || lastPub.made)}${lastPub.published.leads != null ? ` · ${plural(lastPub.published.leads, "lead")}` : ""}` : "Nothing on Meta from this app" },
  ].map((s, i) => ({ ...STEPS[i], n: i + 1, ...s }));

  // The one thing to do now. A batch in hand first (it is the current turn of the cycle), then the next turn in order.
  const step = (i) => STEPS[i].name;
  let next;
  if (going) next = { step: 3, tab: "generating", batch: going.id, text: `A batch is generating (${going.id}): watch it, then pick its ads.` };
  else if (toPick) next = { step: 4, tab: "review", batch: toPick.id, text: `Pick the ads of ${toPick.id}: ${plural(toPick.review.unreviewed, "ad")} not looked at yet.` };
  else if (partly) next = { step: 5, tab: "publish", batch: partly.id, text: `Creating ${partly.id} on Meta did not finish: continue it.` };
  else if (ready) next = { step: 5, tab: "publish", batch: ready.id, text: `Publish ${ready.id}: ${plural(ready.review?.kept ?? ready.ads, "ad")} kept.` };
  else if (broken) next = { step: 3, tab: "batch", text: `${broken.id} ${broken.stopped ? "was stopped" : "did not finish"}: run it again or discard it.` };
  else if (pubAge != null && pubAge < WAIT_DAYS && (!dataAt || dataAt < lastPub.published.at)) next = { step: 1, tab: "results", idle: true, text: `Published ${shortDate(lastPub.published.at)}: the results are worth reading from ${shortDate(new Date(new Date(lastPub.published.at).getTime() + WAIT_DAYS * 86400000).toISOString())}.` };
  else if (!all.ads && !batches.length) next = { step: 1, tab: "results", text: "No results on file yet: review the account, or go straight to a first batch." };
  else if (all.ads && running.ads > 0 && dataAge != null && dataAge > STALE_DAYS) next = { step: 1, tab: "results", text: `The account was last read ${plural(dataAge, "day")} ago: review it again before the next batch.` };
  else if (lastPub?.published.at && dataAt && dataAt < lastPub.published.at) next = { step: 1, tab: "results", text: `The account has not been read since ${lastPub.id} was published: review it.` };
  // A kind the mix needs: drafted first when no draft of it is waiting, else the drafts are the thing to decide.
  else if (needed.some((j) => !(j.drafts_waiting > 0))) next = { step: 2, tab: "scenes", text: `Draft ${needed.filter((j) => !(j.drafts_waiting > 0)).map((j) => kindName(j.format)).join(" and ")} scenes, then approve them: the next batch needs them.` };
  else if (needed.length) next = { step: 2, tab: "scenes", text: `Approve the ${needed.map((j) => kindName(j.format)).join(" and ")} scenes you want (${plural(needed.reduce((t, j) => t + j.drafts_waiting, 0), "draft")} waiting): the next batch needs that kind.` };
  else if (waiting) next = { step: 2, tab: "scenes", text: `Approve or reject ${plural(waiting, "scene draft")}.` };
  else next = { step: 3, tab: "batch", text: all.ads ? "Generate the next batch: it opens filled in from the review." : "Generate a first batch." };
  next.name = step(next.step - 1);

  return { steps, next, data_at: dataAt, reviewed_at: reviewedAt, counts: { scenes: needed.length + waiting, pick: open.filter((b) => (b.review?.unreviewed || 0) > 0).length, publish: (ready ? 1 : 0) + (partly ? 1 : 0) }, jobs, scenes_waiting: waiting, day: day(today) };
}
