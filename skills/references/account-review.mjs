/**
 * account-review.mjs — review the account, and suggest the next batch (Phase 6 of the formats plan, 2026-11-11).
 *
 * One owner-triggered action closes the loop: the gym's account is read again (read-only on Meta), its new pictures
 * are read under a cap, and everything the app already works out by rule is put on one page —
 *   · the numbers (running now, the last 30 days, all time),
 *   · what to keep, what is tiring, what to consider pausing (what-wins.mjs),
 *   · which copy wins (the text options' own numbers),
 *   · where Meta differs from what the app sent (the drift),
 *   · the mix suggestion,
 *   · and a SUGGESTED NEXT BRIEF: the owner's own last words (offer, locations, audience — never invented, never
 *     from an offer file), the photos shared between the kinds the results favour, a card of each kind that is
 *     ready and has never run, and a LEAN — the scene tags this gym's own leads say the photos should favour.
 * No model writes a conclusion: every line is a rule over numbers on disk. Nothing here writes to Meta, and the
 * suggested brief is only ever a starting point on Generate Creatives — the owner changes any of it and confirms the run.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parseArgs } from "util";
import { fileURLToPath } from "url";
import { whatWins, whatWinsAcross, nextWave, mixSuggestion, refreshGym, gymRowsRead, inScope, inTrack, isActive, valueOf, pictureKey, sceneKindOf, sceneGuideFrom, CHEAP } from "./what-wins.mjs";
import { gymTextRows } from "./meta-results.mjs";
import { readCreatives, unreadCount } from "./read-creatives.mjs";
import { ROOMS, SCENE_OPTIONAL_TAGS, SCENE_FORMATS, SCENE_TAGS, PORTRAIT_TAGS, allocateMix, formatOf, loadScenes, isDraft, isRetired } from "./scene-library.mjs";
import { mixOf } from "./client-config.mjs";
import { scenePool, shows, sceneAudience, leanName, MAX_LEANS, LEAN_SHARE } from "./plan-offer-batch.mjs";
export { readLedger as ledgerOf };
import { cardsAvailable } from "./cards.mjs";
import { readWordings } from "./ad-wordings.mjs";
import { metaConfig, graphClient, scrubTokens } from "./meta-api.mjs";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };
const round2 = (n) => Math.round(n * 100) / 100;
const money = (n, cur) => (n == null ? "—" : `${cur} ${Number(n).toFixed(2)}`);
const sum = (rows, k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
export const REVIEW_FILE = "account-review.json";

// ── the lean ─────────────────────────────────────────────────────────────────
/** The value leaned on needs solid leads (20), the one it is compared with enough to compare (10), and the first must be this much cheaper. */
export const LEAN_MIN_LEADS = 20, LEAN_COMPARE_LEADS = 10, LEAN_GAP = 0.85;
/** The value leaned on must stand on at least this many different PICTURES: one picture's leads are that picture's, not its
 *  backdrop's (Jurong West's couple shot alone would have named a pose, an expression and a head count; Sculpt Society's one
 *  kettlebell photo, run in two locations, a setting, a piece of equipment and an exercise). */
export const LEAN_MIN_PICTURES = 2;
/** How a picture's reading names a scene tag, per kind of photograph the agent makes. A value that maps to nothing is not something a scene can be asked for. */
const READ_TO_TAG = {
  "studio-portrait": {
    backdrop: (v) => (PORTRAIT_TAGS.backdrop.includes(v) ? ["backdrop", v] : null),
    pose: (v) => (PORTRAIT_TAGS.stance.includes(v) ? ["stance", v] : null),
    expression: (v) => (PORTRAIT_TAGS.expression.includes(v) ? ["expression", v] : null),
    eye_contact: (v) => (v === "yes" ? ["eye_contact", true] : v === "no" ? ["eye_contact", false] : null),
    subject: (v) => (v === "couple" ? ["people", 2] : v === "woman" || v === "man" ? ["people", 1] : null),
  },
  workout: {
    subject: (v) => (v === "group" ? ["setting", "group"] : null),
    backdrop: (v) => (ROOMS[v] ? ["room", v] : null), // the gym's own photo of that room is the reference (2026-11-11)
    expression: (v) => ({ effort: ["mood", "effort"], smile: ["mood", "smile"], neutral: ["mood", "calm"] }[v] || null),
  },
};
/** The scene tags this app's own published ads carry on their rows (one photo per ad: a joined value is skipped). */
const ROW_TAGS = [["setting", "setting"], ["equipment", "equipment"], ["exercise", "exercise"], ["age_tag", "age"]];

/** What a picture's reading says for an attribute; "none" (no face, nobody in the frame) says nothing to compare with. */
const said = (r, attr) => { const v = valueOf(r, attr); return v === "none" ? null : v; };
/** Values of one attribute among `rows`: leads, spend, cost per lead; the cheapest first. */
function byValue(rows, get) {
  const m = new Map();
  for (const r of rows) { const v = get(r); if (v == null || v === "" || String(v).includes("+")) continue; const x = m.get(v) || { value: v, ads: 0, spend: 0, leads: 0, pics: new Set() }; x.ads++; x.pics.add(pictureKey(r)); x.spend += r.spend || 0; x.leads += r.leads || 0; m.set(v, x); }
  return [...m.values()].map(({ pics, ...x }) => ({ ...x, pictures: pics.size, spend: round2(x.spend), cost_per_lead: x.leads ? round2(x.spend / x.leads) : null })).filter((x) => x.cost_per_lead != null).sort((a, b) => a.cost_per_lead - b.cost_per_lead);
}
/** The best value, when two or more have enough leads and the best is clearly cheaper than the dearest. */
function clearBest(values, { onePicture = false } = {}) {
  const enough = values.filter((v) => v.leads >= LEAN_COMPARE_LEADS);
  if (enough.length < 2) return null;
  const best = enough[0], worst = enough[enough.length - 1];
  return best.leads >= LEAN_MIN_LEADS && (onePicture ? best.pictures < LEAN_MIN_PICTURES : best.pictures >= LEAN_MIN_PICTURES) && best.cost_per_lead <= LEAN_GAP * worst.cost_per_lead ? { best, worst } : null;
}
/** How many photos of a batch are set aside to test what is not confirmed yet (the owner's ruling, 2026-11-11: 3 of 10, changeable on the brief), and how many things at once. */
export const TEST_PHOTOS = 3, MAX_TESTS = 2;
/**
 * What the next batch should TEST (pure): a lead that is clear but stands on one picture — the same rule as a lean, short of
 * the second picture — and the kind of a winner that is tiring or fading ("make new versions of the same kind"). One test per
 * picture, on the broadest thing a scene can be asked for (its setting before its equipment or its exercise), never on
 * something already leaned on. Each: { format, tag, value, test: true, source, why } — the photos are shared out by shareTests
 * among the ones the batch can run.
 */
export function ownTests(rows, { formats = Object.keys(SCENE_FORMATS), currency = "SGD", insights = [], have = [] } = {}) {
  const stills = inTrack(rows, "stills"), out = [], seenPic = new Set();
  const taken = (f, tag) => [...have, ...out].some((l) => l.format === f && l.tag === tag);
  const add = (f, tag, value, pic, why) => { if (!formats.includes(f) || taken(f, tag) || (pic && seenPic.has(pic))) return false; if (pic) seenPic.add(pic); out.push({ format: f, tag, value, test: true, source: "own", why }); return true; };
  // A tiring or fading winner: new versions of its kind — the setting of the scene this app made it from, or what its reading maps to.
  for (const x of insights.filter((i) => i.kind === "tiring" && i.ads?.[0])) {
    const r = stills.find((y) => y.ad_id === x.ads[0]); if (!r) continue;
    const f = valueOf(r, "format") === "studio-portrait" ? "studio-portrait" : "workout", why = `${x.fading ? "Fading" : "Tiring"}: ${x.name} — new versions of the same kind before it stops paying.`;
    if (r.source === "app" && r.setting && !String(r.setting).includes("+")) { add(f, "setting", r.setting, pictureKey(r), why); continue; }
    for (const [attr, map] of Object.entries(READ_TO_TAG[f] || {})) { const tv = r.read && map(valueOf(r, attr)); if (tv && (add(f, tv[0], tv[1], pictureKey(r), why) || seenPic.has(pictureKey(r)))) break; } // the first thing a scene can be asked for that is not already leaned on
  }
  // A clear lead on one picture.
  const sole = (of, get, v) => { const x = of.find((r) => get(r) === v); return x ? pictureKey(x) : null; };
  const say = (attr, b, w) => `To test: ${attr === "eye_contact" ? (b.value === "yes" ? "looking into the camera" : "looking away") : b.value} earned ${b.leads} leads at ${money(b.cost_per_lead, currency)} on one picture, against ${w.value} with ${w.leads} at ${money(w.cost_per_lead, currency)}. One picture's leads are that picture's: this repeats it in new versions.`;
  for (const f of formats) {
    const of = stills.filter((r) => sceneKindOf(r) === f);
    for (const [attr, map] of Object.entries(READ_TO_TAG[f] || {})) {
      const get = (r) => said(r, attr), hit = clearBest(byValue(of.filter((r) => r.read), get), { onePicture: true }), tv = hit && map(hit.best.value);
      if (tv) add(f, tv[0], tv[1], sole(of.filter((r) => r.read), get, hit.best.value), say(attr, hit.best, hit.worst));
    }
    if (f === "workout") for (const [col, tag] of ROW_TAGS) {
      const app = of.filter((r) => r.source === "app"), hit = clearBest(byValue(app, (r) => r[col]), { onePicture: true });
      if (hit) add("workout", tag, hit.best.value, sole(app, (r) => r[col], hit.best.value), say(tag, hit.best, hit.worst));
    }
  }
  return out;
}
/** The batch's test share, split between the tests it can run (at most MAX_TESTS): three photos to one test, two and one to two. */
export const shareTests = (tests) => tests.slice(0, MAX_TESTS).map((t, i, all) => ({ ...t, photos: all.length === 1 ? TEST_PHOTOS : i === 0 ? TEST_PHOTOS - 1 : 1 }));
/**
 * What the next photos should lean on, from the gym's OWN stills (pure). `rows`: the gym's rows joined to their
 * readings; `formats`: the kinds in the batch. Each lean: { format, tag, value, source, why }.
 *   · per kind, from the pictures' readings: the backdrop, pose, expression, gaze or subject that earns leads clearly cheaper;
 *   · for workout scenes, from this app's own ads' scene tags: the setting, equipment, exercise or age that does.
 */
export function ownLeans(rows, { formats = Object.keys(SCENE_FORMATS), currency = "SGD" } = {}) {
  const stills = inTrack(rows, "stills"), out = [];
  const word = (attr, v) => (attr === "eye_contact" ? (v === "yes" ? "looking into the camera" : "looking away") : String(v));
  const say = (label, attr, b, w) => `${word(attr, b.value)} earns this gym's leads cheaper (${b.leads} over ${b.pictures} pictures at ${money(b.cost_per_lead, currency)}, against ${word(attr, w.value)} with ${w.leads} at ${money(w.cost_per_lead, currency)}).`;
  for (const f of formats) {
    const of = stills.filter((r) => sceneKindOf(r) === f);
    for (const [attr, map] of Object.entries(READ_TO_TAG[f] || {})) {
      const hit = clearBest(byValue(of.filter((r) => r.read), (r) => said(r, attr)));
      const tv = hit && map(hit.best.value); if (!tv) continue;
      out.push({ format: f, tag: tv[0], value: tv[1], source: "own", why: say(`${f.replace("-", " ")} ${attr.replace("_", " ")}`, attr, hit.best, hit.worst) });
    }
  }
  if (formats.includes("workout")) for (const [col, tag] of ROW_TAGS) {
    const hit = clearBest(byValue(stills.filter((r) => r.source === "app" && (r.format || "workout") === "workout"), (r) => r[col]));
    if (hit && !out.some((l) => l.format === "workout" && l.tag === tag)) out.push({ format: "workout", tag, value: hit.best.value, source: "own", why: say(`workout ${tag}`, tag, hit.best, hit.worst) });
  }
  return out;
}
/** What holds across the other gyms and a scene can be asked for: a group on the floor, a portrait's backdrop. Only where the gym's own account says nothing on that tag. */
export function portfolioLeans(next = [], { formats = Object.keys(SCENE_FORMATS), have = [] } = {}) {
  const out = [];
  for (const n of next) {
    if (n.source !== "portfolio") continue;
    const tv = (n.attribute === "format" && n.value === "class-group") || (n.attribute === "subject" && n.value === "group") ? ["workout", "setting", "group"]
      : n.attribute === "backdrop" && PORTRAIT_TAGS.backdrop.includes(n.value) && n.value !== "gym-floor" ? ["studio-portrait", "backdrop", n.value] : null;
    if (!tv || !formats.includes(tv[0]) || [...have, ...out].some((l) => l.format === tv[0] && l.tag === tv[1])) continue;
    out.push({ format: tv[0], tag: tv[1], value: tv[2], source: "portfolio", why: n.text });
  }
  return out;
}

// ── the suggested brief ──────────────────────────────────────────────────────
/** The gym's most recent brief on disk (the owner's own words): by the date its batch is named for — a batch named otherwise counts by its file's day — then the file's time. */
export function lastBrief(gymDir) {
  const dir = join(gymDir, "batches"); if (!existsSync(dir)) return null;
  const all = readdirSync(dir).map((id) => { const p = join(dir, id, "brief.json"), b = readJson(p); if (!b?.offer) return null; const at = statSync(p).mtimeMs; return { id, brief: b, at, day: /^\d{4}-\d\d-\d\d/.exec(id)?.[0] || new Date(at).toISOString().slice(0, 10) }; }).filter(Boolean);
  all.sort((a, b) => (b.day > a.day ? 1 : b.day < a.day ? -1 : b.at - a.at));
  return all[0] || null;
}
/**
 * The next batch, pre-filled: { brief, reasons[], left[] }. `brief` carries only what the review decides — offer,
 * locations, audience (the owner's last words), generated, mix (photos per kind), cards, lean — Create fills the rest
 * from the gym's Ad defaults as it always does. `reasons` say where each part comes from; `left` what could not be used.
 */
export function suggestBrief(gymDir, { rows = gymRowsRead(gymDir), every = rows, mix = null, next = [], insights = [], currency = "SGD", profile = readJson(join(gymDir, "gym-profile.json")) || {}, now = new Date() } = {}) {
  const cd = profile.creative_defaults || {}, reasons = [], left = [];
  const last = lastBrief(gymDir), wording = readWordings(gymDir)[0]?.text || null;
  const offer = last?.brief.offer || wording || "";
  if (last) reasons.push({ field: "offer", text: `The offer, locations and audience are your last batch's own words (${last.id}). Change them if the offer has changed.` });
  else if (wording) reasons.push({ field: "offer", text: `The offer is your most recent wording. Check it is still the offer.` });
  else reasons.push({ field: "offer", text: "No batch yet, so the offer is left for you to type." });
  const locations = (last?.brief.locations || cd.locations || []).filter(Boolean);
  const audience = last ? last.brief.audience ?? null : (cd.audiences || []).filter(Boolean)[0] ?? null;
  // The offers running now, as information: which the leads are coming from.
  const offers = byValue(rows.filter(isActive), (r) => r.offer).filter((o) => o.leads > 0).sort((a, b) => b.leads - a.leads).slice(0, 4);
  if (offers.length) reasons.push({ field: "offer", text: `Running now: ${offers.map((o) => `${o.value} (${o.leads} leads at ${money(o.cost_per_lead, currency)})`).join(", ")}.` });

  const generated = Math.max(0, Math.min(12, Number.isInteger(cd.generated) ? cd.generated : 10));
  const shares = mix?.changed ? mix.suggested : mix?.current || mixOf(profile);
  const photos = generated ? allocateMix(shares, generated) : {};
  if (generated) reasons.push({ field: "mix", text: `${Object.entries(photos).map(([f, n]) => `${n} ${f.replace("-", " ")}`).join(", ")} — ${mix?.changed ? `the suggested mix. ${(mix.reasons || []).join(" ")}` : "this gym's mix as it is."}` });

  // The lean: this gym's own account first, then what holds across the others — and only what an approved scene of this audience can show.
  const formats = Object.keys(photos);
  const own = ownLeans(rows, { formats, currency }), tests = ownTests(rows, { formats, currency, insights, have: own });
  const wanted = [...own, ...tests, ...portfolioLeans(next, { formats, have: [...own, ...tests] })];
  let scenes = []; try { scenes = loadScenes(join(gymDir, "scenes.json")); } catch { scenes = []; }
  const aud = sceneAudience(audience, last?.brief.scene_audience), lean = [];
  const runnable = [];
  for (const l of wanted) {
    const pool = scenePool(scenes.filter((s) => formatOf(s) === l.format), aud, photos[l.format] || 0);
    // A room is the planner's to give a photo, from the gym's own photo of it: it needs that photo tagged, not a scene.
    if (l.tag === "room") { if (!(profile.creative_defaults?.room_references || {})[l.value]) { left.push({ ...l, kind: "no_room", text: `${leanName(l)}: no premises photo is tagged as ${ROOMS[l.value]} yet, so a photo cannot be matched to it. Say which photo shows it on Photos & assets (one click). (${l.why})` }); continue; } }
    else if (!pool.some((s) => shows(s, l.tag, l.value))) { left.push({ ...l, text: `${leanName(l)}: no approved scene shows it yet. Draft some on Draft Scenes and the next batch can lean on it. (${l.why})` }); continue; }
    if (l.test) { runnable.push(l); continue; }
    if (lean.length < MAX_LEANS) { lean.push({ tag: l.tag, value: l.value, format: l.format, why: l.why.slice(0, 300) }); reasons.push({ field: "lean", source: l.source, text: `Lean on ${leanName(l)} — ${l.why}` }); }
  }
  // The tests the batch can run share its test photos; a kind with no photo in this batch tests nothing.
  for (const l of shareTests(runnable.filter((t) => (photos[t.format] || 0) > 0))) {
    if (lean.length >= MAX_LEANS) break;
    const n = Math.min(l.photos, photos[l.format]);
    lean.push({ tag: l.tag, value: l.value, format: l.format, test: true, photos: n, why: l.why.slice(0, 300) });
    reasons.push({ field: "test", source: l.source, text: `Test ${leanName(l)} on ${n} of the ${photos[l.format]} ${l.format.replace("-", " ")} photo${photos[l.format] === 1 ? "" : "s"} — ${l.why}` });
  }
  if (generated && !lean.length && !left.length) reasons.push({ field: "lean", text: "Nothing in the results is clear enough yet to lean the photos one way: the batch spreads across the approved scenes." });

  // Scenes to draft first (2026-11-11): the lean only steers among scenes already approved, so a kind in the mix with
  // no approved scene would be refused on Generate Creatives, and the best ads' kind is repeated only if scenes of it exist. One
  // job per kind of photograph: drafted from the gym's own results where it has any (the drafter is told what each
  // kind of shot cost and the best pictures), else by the library's gaps. Text calls only; the owner's click.
  const raw = readJson(join(gymDir, "scenes.json"))?.scenes || [], waiting = raw.filter((s) => isDraft(s) && !isRetired(s)), toDraft = [];
  for (const f of formats) {
    const name = f.replace("-", " "), n = photos[f], count = `${n} ${f === "workout" ? `workout photo${n === 1 ? "" : "s"}` : `${name}${n === 1 ? "" : "s"}`}`, approved = scenePool(scenes.filter((s) => formatOf(s) === f), aud, n).length;
    const drafts = waiting.filter((s) => formatOf(s) === f && (aud === "any" ? !s.audience || s.audience === "any" : !s.audience || s.audience === aud || s.audience === "any")).length;
    const guide = sceneGuideFrom(every, f, { currency, scenes: raw, now }), best = guide?.winners?.[0] || null, leftHere = left.filter((l) => l.format === f && l.kind !== "no_room");
    const why = [];
    if (!approved) why.push(`${count} ${n === 1 ? "is" : "are"} in the mix, but no ${name} scene is approved for ${aud === "any" ? "a mixed audience" : aud}: Generate Creatives refuses the batch until one is.`);
    if (best) why.push(`New versions of what earns this gym's leads: its best ${name} picture has ${best.leads} leads at ${money(best.cost_per_lead, currency)}${best.scene_id ? ` (scene ${best.scene_id})` : best.saw ? ` (${best.saw})` : ""}.`);
    else if (guide?.lines?.length && !approved) why.push(`The drafter is told what this gym's ${name} ads have done (${guide.leads} leads over ${guide.ads} ad${guide.ads === 1 ? "" : "s"}).`);
    if (leftHere.length) why.push(`No approved scene shows ${leftHere.map((l) => leanName(l)).join(", ")}, which the results favour.`);
    // A test repeats a lead in new versions: with fewer approved scenes that show it than photos set aside, more are drafted for exactly that.
    const short = lean.filter((l) => l.test && l.format === f).map((l) => ({ l, have: scenePool(scenes.filter((s) => formatOf(s) === f), aud, n).filter((s) => shows(s, l.tag, l.value)).length })).filter((x) => x.have < x.l.photos);
    const cover = f === "workout" ? short.filter((x) => x.l.tag === "exercise" || SCENE_TAGS[x.l.tag]).map((x) => `${x.l.tag}:${x.l.value}`) : [];
    if (short.length) why.push(`The batch tests ${short.map((x) => `${leanName(x.l)} on ${x.l.photos} photos with only ${x.have} approved scene${x.have === 1 ? "" : "s"} that show${x.have === 1 ? "s" : ""} it`).join("; ")}: new versions need new scenes.`);
    if (!why.length) continue;
    toDraft.push({ format: f, audience: aud, count: 6, ...(cover.length ? { cover } : {}), from_results: !!(guide?.lines?.length || guide?.winners?.length), needed: !approved, approved, drafts_waiting: drafts, why: why.join(" ") });
    if (!approved) left.push({ kind: "no_scenes", format: f, text: `${count} in the mix, but no ${name} scene is approved for ${aud === "any" ? "a mixed audience" : aud}${drafts ? ` (${drafts} draft${drafts === 1 ? "" : "s"} await your approval on Draft Scenes)` : ""}. Generate Creatives refuses the batch until one is: draft some first, or take them out of the mix on Generate Creatives.` });
  }

  // The words on the picture (2026-11-11): only a confirmed finding on the MEASURED cover of this app's own ads (two or more
  // pictures) weights the look — larger words when heavy wins, smaller when light does. It never changes the words.
  const td = insights.find((x) => x.kind === "matters" && x.attribute === "text_density"), wordsWeight = td?.best.value === "heavy" ? "bolder" : td?.best.value === "light" ? "quieter" : null;
  if (wordsWeight) reasons.push({ field: "words", text: `Set the words ${wordsWeight === "bolder" ? "larger" : "smaller"} — ads whose words cover ${td.best.value === "heavy" ? "more" : "less"} of the picture earn this gym's leads cheaper (${td.best.leads} leads over ${td.best.pictures} pictures at ${money(td.best.cost_per_lead, currency)}, against ${td.worst.value} with ${td.worst.leads} at ${money(td.worst.cost_per_lead, currency)}). The layouts with ${wordsWeight === "bolder" ? "more" : "less"} room for the words are preferred; the words stay yours.` });
  // A card of each kind that is ready and has never run here: it costs no image call to test.
  const ready = cardsAvailable(gymDir, { offer: offer || null, profile }), ran = new Set(rows.map((r) => r.format).filter(Boolean)), cards = {};
  for (const k of ["review", "statement", "timeline"]) if (ready[k] > 0 && !ran.has(k)) cards[k] = 1;
  if (Object.keys(cards).length) reasons.push({ field: "cards", text: `One ${Object.keys(cards).join(", one ")} card: ready and never run here, and a card costs no image call.` });

  return { brief: { offer, locations, audience, generated, ...(Object.keys(photos).length > 1 || (formats[0] && formats[0] !== "workout") ? { mix: photos } : {}), ...(Object.keys(cards).length ? { cards } : {}), ...(lean.length ? { lean } : {}), ...(wordsWeight ? { words_weight: wordsWeight } : {}) }, from: last?.id || null, reasons, left, scenes: toDraft, scenes_waiting: waiting.length };
}

const totals = (rows) => { const spend = round2(sum(rows, "spend")), leads = sum(rows, "leads"); return { ads: rows.length, spend, leads, cost_per_lead: leads ? round2(spend / leads) : null }; };
// ── the ledger: what the reviews said, what was done about it, and what happened (2026-11-11) ──
// brands/{gym}/insights.json. A review built on a look writes nothing; the ledger is written at the owner's moments only:
// Review the account… (a snapshot of every checked line and its verdict) and Pause on Meta (the pause, with the ad's numbers
// then). What a batch tested is read from the batch itself (batch.json → lean), and what came of it from Meta's numbers,
// so nothing here can drift from the files. This is how each review can open with what was acted on last time.
export const LEDGER_FILE = "insights.json";
const LEDGER_HISTORY = 12;
export function readLedger(gymDir) { const j = readJson(join(gymDir, LEDGER_FILE)); return { schema: 1, insights: {}, actions: [], ...(j || {}), insights: j?.insights && typeof j.insights === "object" ? j.insights : {}, actions: Array.isArray(j?.actions) ? j.actions : [] }; }
function writeLedger(gymDir, L) { const p = join(gymDir, LEDGER_FILE); writeFileSync(p + ".tmp", JSON.stringify(L, null, 2) + "\n"); renameSync(p + ".tmp", p); }
const snapshotOf = (x) => ({ kind: x.kind, verdict: x.verdict, ...(x.numbers ? { leads: x.numbers.leads, cost_per_lead: x.numbers.cost_per_lead, recent: x.numbers.recent ? { days: x.numbers.recent.days, leads: x.numbers.recent.leads, cost_per_lead: x.numbers.recent.cost_per_lead } : null } : {}), ...(x.best ? { best: x.best, worst: x.worst } : {}) });
/** The owner reviewed the account: every checked line is kept with its verdict then; a line no longer said is marked gone. */
export function recordReview(gymDir, review, { now = new Date() } = {}) {
  const L = readLedger(gymDir), at = now.toISOString(), seen = new Set();
  for (const x of review.insights || []) {
    seen.add(x.key);
    const e = L.insights[x.key] || { key: x.key, first_seen: at, history: [] };
    Object.assign(e, { kind: x.kind, verdict: x.verdict, text: x.text, name: x.name || x.label || null, last_seen: at, gone: null });
    e.history = [...e.history, { at, ...snapshotOf(x) }].slice(-LEDGER_HISTORY);
    L.insights[x.key] = e;
  }
  for (const e of Object.values(L.insights)) if (!seen.has(e.key) && !e.gone) e.gone = at;
  L.reviewed = at;
  writeLedger(gymDir, L);
  return L;
}
/** Something the owner did about an insight (a pause on Meta), kept with what the ad had done by then. */
export function recordAction(gymDir, action, { now = new Date() } = {}) {
  const L = readLedger(gymDir); L.actions.push({ at: now.toISOString(), ...action }); writeLedger(gymDir, L); return L;
}
/** How a lean or a test of a batch came out, from that batch's own ads: the ones that show it against the rest. */
export const TEST_MIN_LEADS = 10;
function leanOutcome(l, rows, scenes, currency) {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const showing = (r) => { if (l.format && (r.format || "workout") !== l.format) return false; if (l.tag === "room") return r.room === l.value; const sc = r.scenes && !String(r.scenes).includes("+") ? byId.get(r.scenes) : null; return !!sc && shows(sc, l.tag, l.value); };
  const of = rows.filter((r) => !l.format || (r.format || "workout") === l.format), T = of.filter(showing), O = of.filter((r) => !showing(r));
  const t = totals(T), o = totals(O), pics = new Set(T.map(pictureKey)).size;
  const verdict = !T.length ? "not_made" : t.leads < TEST_MIN_LEADS ? "early" : o.cost_per_lead == null || t.cost_per_lead <= o.cost_per_lead ? "held" : "not_held";
  const text = !T.length ? `no ad of the batch shows ${leanName(l)}`
    : verdict === "early" ? `too early: ${t.leads} lead${t.leads === 1 ? "" : "s"} so far from ${pics} picture${pics === 1 ? "" : "s"} (it takes ${TEST_MIN_LEADS} to say)`
    : `${verdict === "held" ? "it held" : "it did not hold"}: ${t.leads} leads at ${money(t.cost_per_lead, currency)} over ${pics} picture${pics === 1 ? "" : "s"}${o.cost_per_lead != null ? `, against ${money(o.cost_per_lead, currency)} for the rest of the batch (${o.leads} leads)` : ""}`;
  return { tag: l.tag, value: l.value, format: l.format || null, test: !!l.test, name: leanName(l), verdict, pictures: pics, tested: t, rest: o, text };
}
/**
 * What was acted on last time, and what happened — for the top of the review. From the files alone:
 *   · the most recent batch on Meta that leaned on or tested something (batch.json → lean): how each came out
 *   · the ads paused from here (the ledger's actions): what they had cost, and whether they have stayed paused
 *   · what changed since the last review (the ledger's snapshots): a keeper now fading, a lead now confirmed
 */
export function lastTime(gymDir, { rows = gymRowsRead(gymDir), insights = [], currency = "SGD" } = {}) {
  const out = { batch: null, tested: [], paused: [], changed: [], since: null };
  const L = readLedger(gymDir), scenes = readJson(join(gymDir, "scenes.json"))?.scenes || [];
  // The newest batch with ads on Meta whose record says it leaned on or tested something.
  const outDir = join(gymDir, "outputs");
  const batches = existsSync(outDir) ? readdirSync(outDir).map((id) => ({ id, b: readJson(join(outDir, id, "batch.json")) })).filter((x) => x.b?.lean?.length && rows.some((r) => r.batch === x.id)).sort((a, b) => String(b.b.made || b.id).localeCompare(String(a.b.made || a.id))) : [];
  if (batches.length) { const { id, b } = batches[0], mine = rows.filter((r) => r.batch === id && !r.superseded); out.batch = { id, made: b.made || null, ads: mine.length, ...totals(mine) }; out.tested = b.lean.map((l) => leanOutcome(l, mine, scenes, currency)); }
  for (const a of L.actions.filter((x) => x.what === "pause")) {
    const r = rows.find((x) => x.ad_id === a.ad_id), back = r && isActive(r) && !r.paused_here;
    out.paused.push({ at: a.at, ad_id: a.ad_id, name: a.name || a.ad_id, spent_then: a.spend ?? null, leads_then: a.leads ?? null, status: !r ? "gone" : back ? "running" : "paused",
      text: `${a.name || a.ad_id}: paused from here on ${a.at.slice(0, 10)} after ${money(a.spend ?? 0, currency)} for ${a.leads ?? 0} lead${a.leads === 1 ? "" : "s"}${back ? ` — it is running again on Meta (${money(r.spend, currency)} spent now)` : r ? " — still paused" : ""}` });
  }
  if (L.reviewed) {
    out.since = L.reviewed;
    const now = new Map(insights.map((x) => [x.key, x])), word = { keep: "a keeper", tiring: "tiring", pause: "one to pause", wait: "not judged yet", matters: "a finding", lead: "a lead to test", fact: "for the record" };
    for (const e of Object.values(L.insights)) {
      const before = e.history[e.history.length - 1], x = now.get(e.key); if (!before || before.at !== L.reviewed) continue; // only what the last review itself said
      // The same ad or the same pattern, said differently now: a keeper that is fading, a lead that is confirmed.
      const twin = !x && /^(keep|tiring|pause):/.test(e.key) ? insights.find((y) => y.ads && y.ads[0] === e.key.split(":")[1]) : null, cur = x || twin;
      if (cur && (cur.kind !== before.kind || cur.verdict !== before.verdict)) out.changed.push({ key: e.key, from: before.kind, to: cur.kind, text: `${e.name || e.key} was ${word[before.kind] || before.kind} on ${before.at.slice(0, 10)}; it is ${cur.fading ? "fading" : word[cur.kind] || cur.kind} now.` });
    }
  }
  return out;
}

/**
 * What becomes of one checked line (2026-11-11): { state, text } — so no line of the review is advice with nowhere to go.
 *   acting — the next batch does something about it (a lean, a test, the words' size)        yours — a press that is the owner's (Pause on Meta)
 *   waiting — it would, but something is missing first (a tagged room, an approved scene)      none — nothing to do, and why
 */
export function actionFor(x, suggested, { linked = false } = {}) {
  const lean = suggested.brief.lean || [], left = suggested.left || [], kinds = Object.keys(suggested.brief.mix || { workout: 1 });
  const share = (l) => (l.test ? `${l.photos} photo${l.photos === 1 ? " tests" : "s test"} it, in new versions` : `about ${Math.round(LEAN_SHARE * 100)}% of the ${(l.format || "workout").replace("-", " ")} photos lean on it`);
  // A left-out line without the reason it repeats (the insight's own line already says it).
  const bare = (l) => `${l.text.replace(` (${l.why})`, "").replace(/\.$/, "")}.`;
  if (x.kind === "keep") return { state: "none", text: "Nothing to do: leave it running." };
  if (x.kind === "wait") return { state: "none", text: "Nothing to do yet: it is judged once it has had a fair chance." };
  if (x.kind === "fact") return { state: "none", text: "Not acted on: nothing in the app changes this." };
  if (x.kind === "pause" && x.verdict && x.verdict !== "confirmed") return { state: "none", text: "Nothing to do yet: it has not passed its checks." };
  if (x.kind === "pause") return /^\d{5,25}$/.test(x.ads?.[0] || "") && linked ? { state: "yours", text: "Yours to press: Pause on Meta, below. Nothing is paused by itself." } : { state: "yours", text: "Yours to do in Ads Manager: this ad cannot be reached from here." };
  if (x.kind === "tiring") {
    const l = lean.find((y) => y.test && (y.why || "").includes(x.name));
    if (l) return { state: "acting", text: `In the next batch: ${share(l)} (${leanName(l)}).` };
    const w = left.find((y) => y.test && (y.why || "").includes(x.name));
    return w ? { state: "waiting", text: `Not yet — ${bare(w)}` } : { state: "none", text: "Not in the next batch: its kind maps to nothing a scene can be asked for that is not already leaned on or tested. Draft new versions of it on Draft Scenes." };
  }
  // A finding or a lead about the pictures: what a scene, a photo or the look can be asked for.
  if (x.attribute === "text_density") return suggested.brief.words_weight ? { state: "acting", text: `In the next batch: the words are set ${suggested.brief.words_weight === "bolder" ? "larger" : "smaller"} where a photo allows. The words themselves stay yours.` } : { state: "none", text: "Not acted on: the size of the words is weighted only on a confirmed finding from measured ads." };
  const wants = [];
  for (const f of kinds) {
    const tv = x.attribute === "format" && x.best.value === "class-group" && f === "workout" ? ["setting", "group"] : READ_TO_TAG[f]?.[x.attribute]?.(x.best.value);
    if (tv) wants.push({ format: f, tag: tv[0], value: tv[1] });
  }
  const same = (l, w) => l.tag === w.tag && l.value === w.value && (!l.format || l.format === w.format);
  for (const w of wants) { const l = lean.find((y) => same(y, w)); if (l) return { state: "acting", text: `In the next batch: ${share(l)} (${leanName(l)}).` }; }
  for (const w of wants) { const l = left.find((y) => same(y, w)); if (l) return { state: "waiting", text: `Not yet — ${bare(l)}` }; }
  if (x.attribute === "format" && suggested.brief.mix && kinds.includes(x.best.value)) return { state: "acting", text: `In the next batch through the mix: ${Object.entries(suggested.brief.mix).map(([f, n]) => `${n} ${f.replace("-", " ")}`).join(", ")}.` };
  return { state: "none", text: wants.length ? "Not in the next batch: it is already leaned on or tested through another line, or the batch has no photo of that kind." : "Not acted on: nothing a scene or a photo can be asked for expresses this yet." };
}

// ── the review ───────────────────────────────────────────────────────────────
/** Everything the review shows, from what is on disk (pure: no Meta call, no model call). */
export function buildReview(gymDir, { brandsDir = resolve(gymDir, ".."), now = new Date() } = {}) {
  const gym = gymDir.split("/").filter(Boolean).pop(), profile = readJson(join(gymDir, "gym-profile.json")) || {};
  const currency = profile.locale?.currency || "SGD";
  const rows = gymRowsRead(gymDir), running = rows.filter(isActive);
  const has30 = (r) => r.leads_30d != null || r.spend_30d != null, d30all = rows.filter(has30), s30 = round2(sum(d30all, "spend_30d")), l30 = sum(d30all, "leads_30d"), d30 = !s30 && !l30 && sum(running, "spend") > 0 ? [] : d30all; // an export's rows carry no 30-day figure: say nothing rather than nought
  const wins = whatWins(gymDir, { currency, scope: "active", track: "stills", now });
  const mix = mixSuggestion(gymDir, { formats: Object.keys(SCENE_FORMATS), current: mixOf(profile), currency, now });
  let next = [], across = null;
  try { const A = whatWinsAcross(brandsDir, { scope: "recent", track: "stills", now }); next = nextWave(gym, A, { currency }); across = { gyms: A.gyms.length, leads: A.leads }; } catch { next = []; }
  // Which copy wins: the text options' own numbers, the best lead-getter first.
  const texts = gymTextRows(gymDir), copyOf = (kind) => texts.filter((t) => t.kind === kind && t.leads > 0).slice(0, 3).map((t) => ({ text: t.text, leads: t.leads, cost_per_lead: t.cost_per_lead, ctr: t.ctr, batch: t.batch, angle: t.angle, from: t.from }));
  const dead = texts.filter((t) => !t.leads && (t.impressions || 0) >= 1000).length;
  // Where Meta differs from what the app sent, per campaign of this app's.
  const drift = [], outDir = join(gymDir, "outputs");
  if (existsSync(outDir)) for (const id of readdirSync(outDir).sort()) for (const d of readJson(join(outDir, id, "results.json"))?.drift || []) drift.push({ batch: id, kind: d.kind, text: d.text, fixable: !!d.fixable });
  const history = readJson(join(gymDir, "account-history.json")), u = (() => { try { return unreadCount(gymDir); } catch { return { pictures: 0, unread: 0 }; } })();
  const suggested = suggestBrief(gymDir, { rows: inScope(rows, "recent", { now }).length ? inScope(rows, "recent", { now }) : rows, every: rows, mix, next, insights: wins.suggestions.filter((s) => s.key), currency, profile, now });
  const pick = (kind) => wins.suggestions.filter((s) => s.kind === kind).map((s) => s.text);
  return {
    gym, name: profile.display_name || gym, currency, built: now.toISOString(), last: readJson(join(gymDir, REVIEW_FILE)),
    data: { account: profile.meta_assets?.ad_account_id || null, pulled: history?.pulled || null, exports: (history?.exports || []).map((e) => ({ label: e.label || e.name || null, imported: e.imported || null })), pictures: u.pictures, unread: u.unread, ads: rows.length },
    numbers: { running: totals(running), last_30d: d30.length ? { spend: s30, leads: l30, cost_per_lead: l30 ? round2(s30 / l30) : null } : null, all_time: totals(rows), median: wins.median, scope: wins.scope },
    keep: pick("keep"), tiring: pick("tiring"), pause: pick("pause"), matters: pick("matters"), notes: [...pick("thin"), ...pick("test"), ...pick("unread")],
    // Checked before it is said (2026-11-11): what is only a lead to test, what is not judged yet, what nothing here changes —
    // and every checked line with its verdict and the checks behind it, for the page and the ledger.
    to_test: pick("lead"), wait: pick("wait"), facts: pick("fact"),
    insights: wins.suggestions.filter((s) => s.key).map(({ key, kind, verdict, text, ads, name, what, attribute, label, best, worst, gap, numbers, checks, fading }) => ({ key, kind, verdict, text, action: actionFor({ key, kind, verdict, ads, name, attribute, best }, suggested, { linked: !!metaConfig({ gym }).token }), ...(ads ? { ads, name, what, numbers } : {}), ...(attribute ? { attribute, label, best, worst, gap } : {}), ...(fading ? { fading } : {}), checks })),
    copy: { copies: copyOf("copy"), headlines: copyOf("headline"), never_led: dead },
    drift, mix: { current: mix.current, suggested: mix.suggested, changed: mix.changed, reasons: mix.reasons, formats: mix.formats },
    last_time: lastTime(gymDir, { rows, insights: wins.suggestions.filter((s) => s.key), currency }),
    next, across, brief: suggested.brief, brief_from: suggested.from, reasons: suggested.reasons, left: suggested.left, scenes: suggested.scenes, scenes_waiting: suggested.scenes_waiting,
  };
}
/** The review in plain lines: for the run's log, and for copying into a message. */
export function reviewText(r) {
  const c = r.currency, L = [], n = r.numbers, t = (x) => `${x.ads} ad${x.ads === 1 ? "" : "s"}, ${money(x.spend, c)} spent, ${x.leads} lead${x.leads === 1 ? "" : "s"}${x.cost_per_lead != null ? ` at ${money(x.cost_per_lead, c)}` : ""}`;
  L.push(`${r.name} — account review`);
  L.push(`Running now: ${t(n.running)}.${n.last_30d ? ` Last 30 days: ${money(n.last_30d.spend, c)} spent, ${n.last_30d.leads} leads${n.last_30d.cost_per_lead != null ? ` at ${money(n.last_30d.cost_per_lead, c)}` : ""}.` : ""} All time: ${t(n.all_time)}.`);
  const lt = r.last_time;
  if (lt && (lt.tested.length || lt.paused.length || lt.changed.length)) {
    L.push("", "Last time, and what happened:");
    if (lt.batch) for (const t of lt.tested) L.push(`- ${lt.batch.id} ${t.test ? "tested" : "leaned on"} ${t.name}: ${t.text}.`);
    for (const p of lt.paused) L.push(`- ${p.text}.`);
    for (const c of lt.changed) L.push(`- ${c.text}`);
  }
  const act = new Map((r.insights || []).map((x) => [x.text, x.action?.text]));
  for (const [title, items] of [["Keep", r.keep], ["Tiring", r.tiring], ["Consider pausing", r.pause], ["Not judged yet", r.wait || []], ["What matters", r.matters], ["To test", r.to_test || []], ["For the record", r.facts || []]]) if (items.length) { L.push("", `${title}:`); for (const x of items) { L.push(`- ${x}`); if (act.get(x)) L.push(`  → ${act.get(x)}`); } }
  for (const [title, items] of [["Notes", r.notes]]) if (items.length) { L.push("", `${title}:`); for (const x of items) L.push(`- ${x}`); }
  if (r.copy.copies.length || r.copy.headlines.length) { L.push("", "Which copy wins:"); for (const [k, xs] of [["copy", r.copy.copies], ["headline", r.copy.headlines]]) for (const x of xs) L.push(`- ${k}: ${x.leads} leads${x.cost_per_lead != null ? ` at ${money(x.cost_per_lead, c)}` : ""} — ${x.text.split("\n")[0].slice(0, 90)}`); }
  if (r.drift.length) { L.push("", "Meta differs from what the app sent:"); for (const d of r.drift) L.push(`- ${d.batch}: ${d.text}`); }
  L.push("", "The mix:"); for (const x of r.mix.reasons) L.push(`- ${x}`);
  L.push("", "The next batch:"); for (const x of r.reasons) L.push(`- ${x.text}`); for (const x of r.left) L.push(`- Not yet: ${x.text}`);
  if (r.scenes?.length) { L.push("", "Scenes to draft first (text calls only, drafts for your approval):"); for (const x of r.scenes) L.push(`- ${x.count} ${x.format.replace("-", " ")} scenes for ${x.audience === "any" ? "a mixed audience" : x.audience}${x.from_results ? ", from the results" : ""}: ${x.why}`); }
  if (r.scenes_waiting) L.push(`- ${r.scenes_waiting} scene draft${r.scenes_waiting === 1 ? "" : "s"} await your approval on Draft Scenes.`);
  return L.join("\n");
}

/**
 * The owner's click: read the gym's account again (read-only on Meta), read up to `readMax` new pictures (one vision
 * call each), build the review and record the run in account-review.json. A gym with no reachable account — its ads
 * come as an Ads Manager export — is reviewed from what is on disk, and that is said.
 */
export async function reviewAccount({ gymDir, brandsDir = resolve(gymDir, ".."), client = null, readMax = 0, log = console.log, ask, now = () => new Date() }) {
  const profile = readJson(join(gymDir, "gym-profile.json")); if (!profile) throw new Error("no gym profile here");
  const account = profile.meta_assets?.ad_account_id || null, record = { reviewed: now().toISOString(), steps: {}, pulled: false, read: null };
  if (!account) log("· no ad account on the profile: nothing to pull from Meta (an Ads Manager export on file still counts)");
  else if (!client) log("· the Meta link is not set up: nothing pulled, the review uses what is on disk");
  else { record.steps = await refreshGym({ gymDir, account, client }); record.pulled = true; log(`· the account, read again: ${Object.entries(record.steps).map(([k, v]) => `${k} ${v}`).join(" · ")}`); }
  let u = { pictures: 0, unread: 0 }; try { u = unreadCount(gymDir); } catch { /* no ads yet */ }
  if (readMax > 0 && u.unread) {
    try { const d = await readCreatives({ gymDir, max: readMax, log: (m) => log(`  ${m}`), ...(ask ? { ask } : {}) }); record.read = { calls: d.calls, read: d.read, left: d.left }; log(`· pictures read: ${d.read}${d.left ? `, ${d.left} left for another run` : ""} (${d.calls} call${d.calls === 1 ? "" : "s"})`); }
    catch (e) { record.read = { error: scrubTokens(e.message) }; log(`· the pictures were not read: ${scrubTokens(e.message)}`); }
  } else if (u.unread) log(`· ${u.unread} picture${u.unread === 1 ? "" : "s"} not read yet (no reading asked for this time)`);
  const review = buildReview(gymDir, { brandsDir, now: now() });
  recordReview(gymDir, review, { now: now() }); // after the review is built: "what changed since last time" is against the review before this one
  const p = join(gymDir, REVIEW_FILE); writeFileSync(p + ".tmp", JSON.stringify(record, null, 2) + "\n"); renameSync(p + ".tmp", p);
  log(""); for (const line of reviewText(review).split("\n")) log(line);
  return { record, review };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { values: v } = parseArgs({ options: { "brand-dir": { type: "string" }, "read-max": { type: "string", default: "0" }, show: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
  if (!v["brand-dir"]) { console.error("Usage: account-review.mjs --brand-dir brands/<gym> [--read-max N] | --show [--json]\n  --show prints the review from what is on disk (no call). Without it the account is read again (read-only) and up to N new pictures are read."); process.exit(1); }
  const gymDir = resolve(v["brand-dir"]);
  try {
    if (v.show) { const r = buildReview(gymDir); console.log(v.json ? JSON.stringify(r, null, 2) : reviewText(r)); }
    else {
      const gym = gymDir.split("/").pop(), config = metaConfig({ gym });
      await reviewAccount({ gymDir, client: config.token ? graphClient({ config }) : null, readMax: Math.max(0, parseInt(v["read-max"], 10) || 0) });
    }
  } catch (e) { console.error(scrubTokens(e.message)); process.exit(1); }
}
