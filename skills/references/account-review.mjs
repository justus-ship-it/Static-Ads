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
import { whatWins, whatWinsAcross, nextWave, mixSuggestion, refreshGym, gymRowsRead, inScope, inTrack, isActive, valueOf, pictureKey, sceneGuideFrom, CHEAP } from "./what-wins.mjs";
import { gymTextRows } from "./meta-results.mjs";
import { readCreatives, unreadCount } from "./read-creatives.mjs";
import { SCENE_FORMATS, PORTRAIT_TAGS, allocateMix, formatOf, loadScenes, isDraft, isRetired } from "./scene-library.mjs";
import { mixOf } from "./client-config.mjs";
import { scenePool, shows, sceneAudience, leanName, MAX_LEANS } from "./plan-offer-batch.mjs";
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
  workout: { subject: (v) => (v === "group" ? ["setting", "group"] : null) },
};
/** The scene tags this app's own published ads carry on their rows (one photo per ad: a joined value is skipped). */
const ROW_TAGS = [["setting", "setting"], ["equipment", "equipment"], ["exercise", "exercise"], ["age_tag", "age"]];

/** Values of one attribute among `rows`: leads, spend, cost per lead; the cheapest first. */
function byValue(rows, get) {
  const m = new Map();
  for (const r of rows) { const v = get(r); if (v == null || v === "" || String(v).includes("+")) continue; const x = m.get(v) || { value: v, ads: 0, spend: 0, leads: 0, pics: new Set() }; x.ads++; x.pics.add(pictureKey(r)); x.spend += r.spend || 0; x.leads += r.leads || 0; m.set(v, x); }
  return [...m.values()].map(({ pics, ...x }) => ({ ...x, pictures: pics.size, spend: round2(x.spend), cost_per_lead: x.leads ? round2(x.spend / x.leads) : null })).filter((x) => x.cost_per_lead != null).sort((a, b) => a.cost_per_lead - b.cost_per_lead);
}
/** The best value, when two or more have enough leads and the best is clearly cheaper than the dearest. */
function clearBest(values) {
  const enough = values.filter((v) => v.leads >= LEAN_COMPARE_LEADS);
  if (enough.length < 2) return null;
  const best = enough[0], worst = enough[enough.length - 1];
  return best.leads >= LEAN_MIN_LEADS && best.pictures >= LEAN_MIN_PICTURES && best.cost_per_lead <= LEAN_GAP * worst.cost_per_lead ? { best, worst } : null;
}
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
    const of = stills.filter((r) => valueOf(r, "format") === f);
    for (const [attr, map] of Object.entries(READ_TO_TAG[f] || {})) {
      const hit = clearBest(byValue(of.filter((r) => r.read), (r) => valueOf(r, attr)));
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
export function suggestBrief(gymDir, { rows = gymRowsRead(gymDir), every = rows, mix = null, next = [], currency = "SGD", profile = readJson(join(gymDir, "gym-profile.json")) || {}, now = new Date() } = {}) {
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
  const own = ownLeans(rows, { formats, currency }), wanted = [...own, ...portfolioLeans(next, { formats, have: own })];
  let scenes = []; try { scenes = loadScenes(join(gymDir, "scenes.json")); } catch { scenes = []; }
  const aud = sceneAudience(audience, last?.brief.scene_audience), lean = [];
  for (const l of wanted) {
    const pool = scenePool(scenes.filter((s) => formatOf(s) === l.format), aud, photos[l.format] || 0);
    if (!pool.some((s) => shows(s, l.tag, l.value))) { left.push({ ...l, text: `${leanName(l)}: no approved scene shows it yet. Draft some on Draft Scenes and the next batch can lean on it. (${l.why})` }); continue; }
    if (lean.length < MAX_LEANS) { lean.push({ tag: l.tag, value: l.value, format: l.format, why: l.why.slice(0, 300) }); reasons.push({ field: "lean", source: l.source, text: `Lean on ${leanName(l)} — ${l.why}` }); }
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
    const guide = sceneGuideFrom(every, f, { currency, scenes: raw, now }), best = guide?.winners?.[0] || null, leftHere = left.filter((l) => l.format === f);
    const why = [];
    if (!approved) why.push(`${count} ${n === 1 ? "is" : "are"} in the mix, but no ${name} scene is approved for ${aud === "any" ? "a mixed audience" : aud}: Generate Creatives refuses the batch until one is.`);
    if (best) why.push(`New versions of what earns this gym's leads: its best ${name} picture has ${best.leads} leads at ${money(best.cost_per_lead, currency)}${best.scene_id ? ` (scene ${best.scene_id})` : best.saw ? ` (${best.saw})` : ""}.`);
    else if (guide?.lines?.length && !approved) why.push(`The drafter is told what this gym's ${name} ads have done (${guide.leads} leads over ${guide.ads} ad${guide.ads === 1 ? "" : "s"}).`);
    if (leftHere.length) why.push(`No approved scene shows ${leftHere.map((l) => leanName(l)).join(", ")}, which the results favour.`);
    if (!why.length) continue;
    toDraft.push({ format: f, audience: aud, count: 6, from_results: !!(guide?.lines?.length || guide?.winners?.length), needed: !approved, approved, drafts_waiting: drafts, why: why.join(" ") });
    if (!approved) left.push({ kind: "no_scenes", format: f, text: `${count} in the mix, but no ${name} scene is approved for ${aud === "any" ? "a mixed audience" : aud}${drafts ? ` (${drafts} draft${drafts === 1 ? "" : "s"} await your approval on Draft Scenes)` : ""}. Generate Creatives refuses the batch until one is: draft some first, or take them out of the mix on Generate Creatives.` });
  }

  // A card of each kind that is ready and has never run here: it costs no image call to test.
  const ready = cardsAvailable(gymDir, { offer: offer || null, profile }), ran = new Set(rows.map((r) => r.format).filter(Boolean)), cards = {};
  for (const k of ["review", "statement", "timeline"]) if (ready[k] > 0 && !ran.has(k)) cards[k] = 1;
  if (Object.keys(cards).length) reasons.push({ field: "cards", text: `One ${Object.keys(cards).join(", one ")} card: ready and never run here, and a card costs no image call.` });

  return { brief: { offer, locations, audience, generated, ...(Object.keys(photos).length > 1 || (formats[0] && formats[0] !== "workout") ? { mix: photos } : {}), ...(Object.keys(cards).length ? { cards } : {}), ...(lean.length ? { lean } : {}) }, from: last?.id || null, reasons, left, scenes: toDraft, scenes_waiting: waiting.length };
}

// ── the review ───────────────────────────────────────────────────────────────
const totals = (rows) => { const spend = round2(sum(rows, "spend")), leads = sum(rows, "leads"); return { ads: rows.length, spend, leads, cost_per_lead: leads ? round2(spend / leads) : null }; };
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
  const suggested = suggestBrief(gymDir, { rows: inScope(rows, "recent", { now }).length ? inScope(rows, "recent", { now }) : rows, every: rows, mix, next, currency, profile, now });
  const pick = (kind) => wins.suggestions.filter((s) => s.kind === kind).map((s) => s.text);
  return {
    gym, name: profile.display_name || gym, currency, built: now.toISOString(), last: readJson(join(gymDir, REVIEW_FILE)),
    data: { account: profile.meta_assets?.ad_account_id || null, pulled: history?.pulled || null, exports: (history?.exports || []).map((e) => ({ label: e.label || e.name || null, imported: e.imported || null })), pictures: u.pictures, unread: u.unread, ads: rows.length },
    numbers: { running: totals(running), last_30d: d30.length ? { spend: s30, leads: l30, cost_per_lead: l30 ? round2(s30 / l30) : null } : null, all_time: totals(rows), median: wins.median, scope: wins.scope },
    keep: pick("keep"), tiring: pick("tiring"), pause: pick("pause"), matters: pick("matters"), notes: [...pick("thin"), ...pick("test"), ...pick("unread")],
    copy: { copies: copyOf("copy"), headlines: copyOf("headline"), never_led: dead },
    drift, mix: { current: mix.current, suggested: mix.suggested, changed: mix.changed, reasons: mix.reasons, formats: mix.formats },
    next, across, brief: suggested.brief, brief_from: suggested.from, reasons: suggested.reasons, left: suggested.left, scenes: suggested.scenes, scenes_waiting: suggested.scenes_waiting,
  };
}
/** The review in plain lines: for the run's log, and for copying into a message. */
export function reviewText(r) {
  const c = r.currency, L = [], n = r.numbers, t = (x) => `${x.ads} ad${x.ads === 1 ? "" : "s"}, ${money(x.spend, c)} spent, ${x.leads} lead${x.leads === 1 ? "" : "s"}${x.cost_per_lead != null ? ` at ${money(x.cost_per_lead, c)}` : ""}`;
  L.push(`${r.name} — account review`);
  L.push(`Running now: ${t(n.running)}.${n.last_30d ? ` Last 30 days: ${money(n.last_30d.spend, c)} spent, ${n.last_30d.leads} leads${n.last_30d.cost_per_lead != null ? ` at ${money(n.last_30d.cost_per_lead, c)}` : ""}.` : ""} All time: ${t(n.all_time)}.`);
  for (const [title, items] of [["Keep", r.keep], ["Tiring", r.tiring], ["Consider pausing", r.pause], ["What matters", r.matters], ["Notes", r.notes]]) if (items.length) { L.push("", `${title}:`); for (const x of items) L.push(`- ${x}`); }
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
