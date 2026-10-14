/**
 * The shared targeting library (2026-10-07): detailed-targeting presets curated across every gym's results,
 * approved by the owner, applied as the default for all gyms. Fitness ads target much the same people, and
 * three accounts' records said so: the same seven fitness interests sat in every ad set that brought leads
 * cheaply — on their own in Singapore (Sculpt Society: 1,096 leads at SGD 26.62; BFIT: 9 at 21.38), as the
 * AND layer of every F45 Xinyi targeting under NT$ 262 a lead — while Xinyi's two targetings without that
 * layer cost two to three times more.
 *
 *   library/targeting-library.json   (gitignored with the other libraries; TARGETING_LIBRARY_DIR for tests)
 *   { schema: 1, entries: [{ id, name, audience: all | women | men, role: default | option, note, evidence[],
 *                            spec: { flexible_spec }, added, approved_on, retired, reason }] }
 *
 * A new library starts with the curated drafts (`seedDrafts`); nothing is applied until the owner approves an
 * entry. `defaultFor(library, gender)` is the approved default for a callout's gender: the variant for that
 * gender when there is one, else the one for everyone. An `option` entry is never a default: it is offered on
 * the Publish screen like the account's own presets.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO_ROOT = resolve(HERE, "..", "..");
export const TARGETING_LIBRARY_DIR = resolve(process.env.TARGETING_LIBRARY_DIR || join(REPO_ROOT, "library"));
export const FILE = "targeting-library.json";
export const AUDIENCES = ["all", "women", "men"];
export const ROLES = ["default", "option"];
/** Library preset ids on a plan or in a setting: never collide with the account's 12-hex ids. */
export const LIB_PREFIX = "lib:";

const interest = (id, name) => ({ id: String(id), name });
/** The seven interests every cheap lead-producing ad set carried (the same Meta ids in every account). */
export const FITNESS_CORE = [
  interest("6003258544357", "Health and wellness"), interest("6003277229371", "Physical fitness"), interest("6003384248805", "Fitness and wellness"),
  interest("6003420915231", "Health club"), interest("6003473077165", "Weight training"), interest("6004115167424", "Physical exercise"), interest("6003713973153", "Strength training"),
];
/** Sculpt Society's women's set: the core with Beauty and health and beauty (1,096 leads at SGD 26.62). */
export const BEAUTY = [interest("6002867432822", "Beauty"), interest("6003393295343", "health and beauty")];
/** F45 Xinyi's affluence layer: the luxury and finance interests of their best targetings. */
export const AFFLUENT = [
  interest("6002893385022", "luxury watches"), interest("6003011087019", "luxury travel"), interest("6003132627317", "luxury"), interest("6003150149836", "luxury bags"),
  interest("6003383552337", "Luxury resorts"), interest("6003392552125", "Luxury Lifestyle"), interest("6003715005316", "Luxury yacht"), interest("6004048615096", "Luxury vehicle"), interest("6007828099136", "Luxury goods"),
  interest("6003484864669", "Wealth management"), interest("6003388314512", "Investment"), interest("6003304537260", "private equity"), interest("6003297396138", "Banking"), interest("6003512040864", "Wealth"),
];

/** The curated drafts a new library starts with — the owner approves them on Targeting & budget. */
export function curatedDrafts(now = new Date().toISOString()) {
  const d = (entry) => ({ ...entry, id: idOf(entry.spec), added: now, approved_on: null, retired: null, reason: null });
  return [
    d({ name: "Fitness core", audience: "all", role: "default", note: "The seven fitness interests every cheap lead-producing ad set carried, in all three accounts. The default for every gym and every callout that is not for women.",
      evidence: [{ gym: "sculpt-society", preset: "Fitness · Beauty, Health and wellness (minus Beauty)", leads: 1096, cost_per_lead: 26.62, currency: "SGD" }, { gym: "bfit", preset: "Broad · Beauty, Health and wellness", leads: 9, cost_per_lead: 21.38, currency: "SGD" }, { gym: "f45-xinyi", preset: "the AND layer of every targeting under NT$ 262 a lead", leads: 919, cost_per_lead: 250, currency: "TWD" }],
      spec: { flexible_spec: [{ interests: FITNESS_CORE }] } }),
    d({ name: "Fitness core · women", audience: "women", role: "default", note: "Sculpt Society's exact women's set: the core with Beauty and health and beauty. The default for a women's callout.",
      evidence: [{ gym: "sculpt-society", preset: "Fitness · Beauty, Health and wellness", leads: 1096, cost_per_lead: 26.62, currency: "SGD" }, { gym: "bfit", preset: "Broad · Beauty, Health and wellness", leads: 9, cost_per_lead: 21.38, currency: "SGD" }],
      spec: { flexible_spec: [{ interests: [...BEAUTY, ...FITNESS_CORE] }] } }),
    d({ name: "Affluent × fitness", audience: "all", role: "option", note: "For a premium-priced gym: F45 Xinyi's luxury and finance interests AND the fitness core. Their targetings with this shape cost NT$ 216–262 a lead; the two without the fitness layer cost 380 and 833. Offered on the Publish screen, never the default.",
      evidence: [{ gym: "f45-xinyi", preset: "luxury watches / luxury travel + Health and wellness / Physical fitness", leads: 13, cost_per_lead: 215.69, currency: "TWD" }, { gym: "f45-xinyi", preset: "Finance / luxury watches + bodybuilding and fitness / healthy habits", leads: 50, cost_per_lead: 250.7, currency: "TWD" }, { gym: "f45-xinyi", preset: "Banking & Finance / Finance + Health and wellness / Physical fitness", leads: 366, cost_per_lead: 261.78, currency: "TWD" }],
      spec: { flexible_spec: [{ interests: AFFLUENT }, { interests: FITNESS_CORE }] } }),
  ];
}
const idOf = (spec) => createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 12);

const empty = () => ({ schema: 1, entries: [] });
export function readLibrary(dir = TARGETING_LIBRARY_DIR) {
  const p = join(dir, FILE);
  if (!existsSync(p)) return empty();
  try { const j = JSON.parse(readFileSync(p, "utf-8")); return { ...empty(), ...j, entries: Array.isArray(j.entries) ? j.entries : [] }; } catch { return empty(); }
}
export function writeLibrary(data, dir = TARGETING_LIBRARY_DIR) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, FILE), JSON.stringify(data, null, 2) + "\n"); return data; }
/** A library with no entries gets the curated drafts; one that has any is left alone. */
export function seedDrafts(dir = TARGETING_LIBRARY_DIR, now = new Date().toISOString()) {
  const data = readLibrary(dir);
  if (data.entries.length) return { data, seeded: 0 };
  data.entries = curatedDrafts(now);
  writeLibrary(data, dir);
  return { data, seeded: data.entries.length };
}

export const liveEntries = (data) => data.entries.filter((e) => !e.retired);
export const approvedEntries = (data) => liveEntries(data).filter((e) => e.approved_on);
/** The approved default for a callout's gender: its own variant first, else the one for everyone. */
export function defaultFor(data, gender = "all") {
  const live = approvedEntries(data).filter((e) => e.role === "default");
  return live.find((e) => e.audience === gender) || live.find((e) => e.audience === "all") || null;
}
/** A library entry as the plan takes a preset: the id prefixed so it never collides with the account's. */
export const asPreset = (e) => ({ id: `${LIB_PREFIX}${e.id}`, name: e.name, spec: e.spec, source: "library", audience: e.audience, role: e.role, note: e.note, evidence: e.evidence || [] });
export const isLibraryId = (id) => typeof id === "string" && id.startsWith(LIB_PREFIX);
export const libraryEntry = (data, id) => (isLibraryId(id) ? liveEntries(data).find((e) => `${LIB_PREFIX}${e.id}` === id) || null : null);

export function approveEntry(dir, id, now = new Date().toISOString()) {
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id} in the targeting library`);
  if (e.retired) throw new Error(`"${e.name}" is retired (${e.retired.reason}); restore it first`);
  e.approved_on = now; writeLibrary(data, dir); return e;
}
export function retireEntry(dir, id, reason, now = new Date().toISOString()) {
  if (!reason || !String(reason).trim()) throw new Error("a reason is needed to retire a targeting");
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id} in the targeting library`);
  e.retired = { on: now, reason: String(reason).trim() }; writeLibrary(data, dir); return e;
}
export function restoreEntry(dir, id) {
  const data = readLibrary(dir), e = data.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id} in the targeting library`);
  e.retired = null; writeLibrary(data, dir); return e;
}
/** The owner's own entry: interests with Meta ids and names, in one or two AND-ed groups. */
export function addEntry(dir, { name, audience = "all", role = "default", note = "", groups, evidence = [] }, now = new Date().toISOString()) {
  if (!name || !String(name).trim()) throw new Error("the targeting needs a name");
  if (!AUDIENCES.includes(audience)) throw new Error(`audience must be one of ${AUDIENCES.join(", ")}`);
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  const gs = Array.isArray(groups) ? groups.filter((g) => Array.isArray(g) && g.length) : [];
  if (!gs.length || gs.length > 3) throw new Error("one to three groups of interests, each with at least one");
  for (const g of gs) for (const i of g) if (!/^\d{5,20}$/.test(String(i?.id || "")) || !String(i?.name || "").trim()) throw new Error("every interest needs Meta's id (digits) and its name");
  const spec = { flexible_spec: gs.map((g) => ({ interests: g.map((i) => interest(i.id, String(i.name).trim())) })) };
  const data = readLibrary(dir), id = idOf(spec);
  if (data.entries.some((e) => e.id === id)) throw new Error("that targeting is in the library already");
  const e = { id, name: String(name).trim(), audience, role, note: String(note || "").trim(), evidence, spec, added: now, approved_on: null, retired: null, reason: null };
  data.entries.push(e); writeLibrary(data, dir); return e;
}
