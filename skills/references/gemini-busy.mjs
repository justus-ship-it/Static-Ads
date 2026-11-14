/**
 * gemini-busy.mjs — one rule for every Gemini call: when Google answers "busy" (429, 5xx,
 * "high demand", "overloaded", a dropped connection), wait and try again — 10, 20, then 40 s —
 * and only after the last wait give up with the reason. A busy answer costs nothing, so these
 * tries never count against an image budget or a photo's attempts. Every wait is logged, so a
 * run that is waiting is seen to be alive rather than frozen.
 */

export const BUSY_WAITS_MS = [10000, 20000, 40000];
const BUSY = /\b(429|500|502|503|504)\b|overloaded|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network timeout|no answer in|TimeoutError|aborted/i;

/**
 * How long one call may take before it counts as no answer (2026-10-07: F45 Xinyi's batch sat 13 minutes on a
 * vision call whose connection, attempted during a network blip, never answered and never failed — Node's fetch
 * has no deadline of its own). A timed-out call is a busy answer: waited out and tried again, then the error.
 */
export const GEMINI_TIMEOUT_MS = { vision: 120000, image: 300000 };
/** A deadline for one fetch, as its `signal`; `ms` 0 or less means none (tests). */
export const callDeadline = (ms) => (ms > 0 ? AbortSignal.timeout(ms) : undefined);

/** Is this an answer worth waiting out, rather than a fault in what was asked? */
export const isBusy = (err) => err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError" || BUSY.test(String(err?.message || err || ""));

/** Google's own sentence when the error carries its JSON body, else the first words of the message. */
export function shortReason(err) {
  if (err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError") return "no answer in time";
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

/**
 * Google refused what was asked under its content rules (2026-11-14: Aether Athletics' closing line, filmed as a clip
 * of its own, came back "Request blocked due to prohibited content guidelines" — and the run died on the raw JSON).
 * It is no fault to wait out: asking again as it is may or may not pass, and nothing was made.
 */
export const isRefusal = (err) => err?.refused === true || /prohibited[_ ]content|blocked due to|Blocked by safety filter|\bSAFETY\b|content polic|RAI filter|responsible ai/i.test(String(err?.message || err || ""));

/**
 * A Google error in plain words (as explainError does for Meta's): { kind, text } — what happened and what to do —
 * or null when the error is not one of Google's. `kind`: refused · quota · key · access · model · timeout · busy ·
 * network. The text never carries a key; Google's own sentence is `shortReason(err)`.
 */
export function explainGemini(err) {
  const m = String(err?.message || err || "");
  if (isRefusal(err)) return { kind: "refused", text: "Google's model refused this request under its content rules. Nothing else is lost: run again to try it once more, and if it is refused again change the words or the picture it was asked for" };
  if (err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError" || /no answer in|TimeoutError|DEADLINE_EXCEEDED|ETIMEDOUT|network timeout/i.test(m)) return { kind: "timeout", text: "Google did not answer in time. Nothing is lost: run again" };
  if (/GEMINI_KEY not found|API key not valid|API_KEY_INVALID|\b401\b|UNAUTHENTICATED/i.test(m)) return { kind: "key", text: "The Gemini key is missing or not valid: check GEMINI_KEY in the .env file" };
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate limit/i.test(m)) return { kind: "quota", text: "Google's limit for this key is used up for now. Wait a few minutes and run again; if it keeps happening, the limit on the Google account needs raising" };
  if (/PERMISSION_DENIED|\b403\b|billing/i.test(m)) return { kind: "access", text: "This Gemini key is not allowed to use the model this step asks for (billing or access on the Google account)" };
  if (/\b404\b|NOT_FOUND|is not found for API version|is not supported for/i.test(m)) return { kind: "model", text: "Google does not offer the model this step asks for to this key (it may have been retired)" };
  if (/\b(500|502|503|504)\b|overloaded|high demand|UNAVAILABLE|INTERNAL/i.test(m) && /Gemini|vision|video|image|check|generativelanguage/i.test(m)) return { kind: "busy", text: "Google's service was busy or had a fault. Nothing is lost: run again in a few minutes" };
  if (/fetch failed|ECONNRESET|ENOTFOUND|socket hang up/i.test(m)) return { kind: "network", text: "There was no connection to Google. Check the internet connection and run again" };
  return null;
}
/** The error as one sentence for the owner: what happened, what to do, and Google's own words after it — or the message as it is. */
export function plainGemini(err) { const g = explainGemini(err); return g ? `${g.text}. (Google said: ${shortReason(err)})` : String(err?.message || err || ""); }
