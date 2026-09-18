/**
 * gemini-busy.mjs — one rule for every Gemini call: when Google answers "busy" (429, 5xx,
 * "high demand", "overloaded", a dropped connection), wait and try again — 10, 20, then 40 s —
 * and only after the last wait give up with the reason. A busy answer costs nothing, so these
 * tries never count against an image budget or a photo's attempts. Every wait is logged, so a
 * run that is waiting is seen to be alive rather than frozen.
 */

export const BUSY_WAITS_MS = [10000, 20000, 40000];
const BUSY = /\b(429|500|502|503|504)\b|overloaded|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network timeout/i;

/** Is this an answer worth waiting out, rather than a fault in what was asked? */
export const isBusy = (err) => BUSY.test(String(err?.message || err || ""));

/** Google's own sentence when the error carries its JSON body, else the first words of the message. */
export function shortReason(err) {
  const text = String(err?.message || err || "");
  const json = text.slice(text.indexOf("{"));
  try { const m = JSON.parse(json)?.error?.message; if (m) return String(m).replace(/\s+/g, " ").slice(0, 120); } catch {}
  return text.replace(/\s+/g, " ").slice(0, 90);
}
/** Run `fn` until it answers, waiting out busy answers; any other error is thrown at once. */
export async function whenGeminiFree(fn, { label = "Gemini", log = (m) => console.warn(m), waits = BUSY_WAITS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!isBusy(e) || i >= waits.length) throw e;
      const why = shortReason(e);
      log(`  ${label}: Gemini is busy (${why}) — trying again in ${waits[i] / 1000} s (${i + 1} of ${waits.length})`);
      await sleep(waits[i]);
    }
  }
}
