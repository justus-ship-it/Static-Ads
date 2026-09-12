/**
 * check-quality.mjs — does a generated photo look like a real photo of a real gym session?
 *
 * check-visual.mjs settles text, placement and head count. This check asks what those cannot: is the
 * picture believable? Two failures found by the owner in the 48-ad batch (2026-09-12):
 *   1. AI slop — a "cable row" with no row machine: the man sat on nothing, a bench where the machine
 *      should be. Also ruled out: dumbbells that are oversized discs with no handle, a bench-press bar
 *      over the face instead of the chest. Borderline realism fails.
 *   2. Posed groups — every person in a class in the identical pose at the same instant, in a row,
 *      looking into the camera. A class should look caught mid-session, with some interaction.
 *
 * One vision call, told the scene the photo was meant to show. It answers; the rules are applied here,
 * in code (judgeQuality). Serious problems get a second, targeted look before they can fail a photo —
 * the checker sometimes reports what it expects rather than what is there. Minor problems are recorded,
 * never failed. The answer is data, never instructions.
 *
 * Usage (vision calls only — no image is generated):
 *   node skills/references/check-quality.mjs --image photo.jpg --scene "…" [--setting group] [--people 3]
 *   node skills/references/check-quality.mjs --calibrate brands/{gym}/quality-calibration.json [--runs 3]
 *     calibration file: { "photos": [ { "file": "…", "scene": "…", "setting": "solo", "people": 1,
 *                                        "expect": "pass" | "fail", "why": "…" } ] }  (paths relative to it)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { callVision, CHECK_MODEL } from "./check-visual.mjs";

/** Bumped whenever the rules or the question change, so photos passed under older checks are re-checked. */
export const QUALITY_VERSION = 2;
/**
 * Calibration, 2026-09-12 (12 photos the owner judged, 3 runs each — `--calibrate`):
 *   first look         second look        bad photos caught   good photos wrongly failed
 *   gemini-3.6-flash   gemini-3.6-flash   12 / 18 (never the two borderline rulings)   0 / 18
 *   gemini-3.8-flash   gemini-3.8-flash   14 / 18                                       2 / 18
 *   gemini-3.1-pro     gemini-3.1-pro     18 / 18                                      13 / 18 (confirms its own misreadings)
 *   gemini-3.1-pro     gemini-3.6-flash   17 / 18                                       7 / 18
 * The owner's bar, settled the same day after a live run with the pro model cut a 44-ad batch to 28:
 * "basic checks so a majority of the images come out looking good; occasional mistakes are fine —
 * the selection step is an additional check." Flash never wrongly failed a good photo; the borderline
 * cases it misses (a handle-less dumbbell, a bar over the face) are left to selection. So: flash for
 * both looks, and only gross faults fail (see failsPhoto). Everything else is a note for the gallery.
 */
export const QUALITY_MODEL = process.env.QUALITY_MODEL || CHECK_MODEL;
export const CONFIRM_MODEL = process.env.CONFIRM_MODEL || CHECK_MODEL;
/** More than half the people looking into the lens is a posed shot (g06: four planks, four stares). */
export const POSED_LOOKING_SHARE = 0.5;
export const PROBLEM_KINDS = ["body", "equipment", "form", "hands", "face", "reflection", "other"];

const QUESTION = (scene) => `You are checking whether a generated photograph looks like a real photo of a real gym session. It will be used in an advert for a real gym, so anything a viewer would read as fake, impossible or wrong ruins it.

The photo was meant to show: ${scene}

Look closely at the people, their hands and feet, the equipment and where it touches the body, the floor and any mirrors.

1. exercise_shown: does the photo show that exercise, at any point of its movement, done with the equipment it needs? (A lifter part-way through a lift is still doing the lift.) In exercise_seen, say what the photo actually shows.
2. problems: list everything that could not happen in a real photo, or that is not how real equipment or the real exercise looks. Give each one what it is, its kind, its severity and a box.
   Kinds:
   - body: a person unsupported (sitting or leaning on nothing); limbs merged with each other or with equipment; extra or missing limbs, hands, fingers or feet; a body bent in a way a body cannot bend.
   - equipment: equipment missing parts the exercise needs (a machine exercise with no machine or no seat; a cable with nothing at one end; a dumbbell with no handle); equipment of a size or shape real equipment does not have; pieces merged or passing through each other or through people.
   - form: the exercise not done the way it is really done — the body or the load in the wrong place for that movement.
   - hands: hands not really gripping what they hold.
   - face: distorted faces; the same face repeated on different people.
   - reflection: a mirror showing something that does not match the room or the people in it.
   - other: anything else a real camera could not have captured.
   Severity "fatal": a viewer would notice it on a phone screen, or it makes the photo impossible or the exercise wrong. Severity "minor": only visible when zoomed in, small and in the background.
   on_subject: true if the problem is on the people in the scene or on the equipment they are using; false if it is elsewhere in the room.
   Only list what you can actually see. If everything looks real, return an empty list.
3. held: for every piece of equipment a person is holding, lifting, pushing or sitting on, give:
   - item: what it is, and who is using it.
   - grip_real: true if the hands (or body, for a seat or bench) visibly hold or rest on it the way they would on the real thing — fingers around a real handle or bar, a body on a real seat. False if the grip or support is missing, hidden where it could not be, or impossible.
   - size_real: true if its size and shape match real gym equipment of that kind, judged against the person's body. False if it is oversized, undersized, missing parts (a handle, a seat, plates) or misshapen.
   - position_real: true if it is where it would really be at this point of the exercise, relative to the body. False if the body or the load is in the wrong place for that movement.
   - note: what you see.
   If nobody is using any equipment, return an empty list.
4. About the people (count only people directly visible, not their reflections):
   - people_count: how many there are.
   - poses_near_identical: true if two or more people are near-copies of each other — the same pose, at the same moment of the movement, at the same angle to the camera — like a line-up rather than people each training at their own pace. False for one person.
   - interaction: true if any person is visibly engaging with another — a glance, talking, laughing, a coach cueing, watching closely or with a hand ready to help. In interaction_seen, say what it is. False for one person.
   - coach_attending: if one of them is a coach, true if the coach is watching or helping the person training. True when there is no coach.
   - looking_at_camera: how many people look straight into the camera lens.
   - duplicate_faces: true if two or more people have the same face. False for one person.

Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    exercise_shown: { type: "BOOLEAN" },
    exercise_seen: { type: "STRING" },
    problems: { type: "ARRAY", items: { type: "OBJECT", properties: {
      what: { type: "STRING" }, kind: { type: "STRING", enum: PROBLEM_KINDS }, severity: { type: "STRING", enum: ["fatal", "minor"] }, on_subject: { type: "BOOLEAN" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
    }, required: ["what", "kind", "severity", "on_subject"] } },
    held: { type: "ARRAY", items: { type: "OBJECT", properties: {
      item: { type: "STRING" }, grip_real: { type: "BOOLEAN" }, size_real: { type: "BOOLEAN" }, position_real: { type: "BOOLEAN" }, note: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
    }, required: ["item", "grip_real", "size_real", "position_real"] } },
    people_count: { type: "INTEGER" },
    poses_near_identical: { type: "BOOLEAN" },
    interaction: { type: "BOOLEAN" },
    interaction_seen: { type: "STRING" },
    coach_attending: { type: "BOOLEAN" },
    looking_at_camera: { type: "INTEGER" },
    duplicate_faces: { type: "BOOLEAN" },
  },
  required: ["exercise_shown", "exercise_seen", "problems", "held", "people_count", "poses_near_identical", "interaction", "coach_attending", "looking_at_camera", "duplicate_faces"],
};

// The second look: each serious finding, pointed at its place. Only findings confirmed real fail a photo.
const CONFIRM_QUESTION = (scene, items) => `This photograph was meant to show: ${scene}

A first check reported the problems below (boxes are [ymin, xmin, ymax, xmax] on a 0-1000 scale). Look again, carefully, at each one at its place. For each, answer real = true only if you can clearly see the problem in this image and a viewer of a phone-sized advert would notice it. Answer real = false if it was a misreading — ordinary equipment seen at an angle, a shadow, motion, or something that is actually there and correct. In seen, say what you see.

${items.map((t, i) => `${i}. ${t.what}${t.box_2d ? ` at ${JSON.stringify(t.box_2d)}` : ""}`).join("\n")}`;
const CONFIRM_SCHEMA = { type: "OBJECT", properties: { findings: { type: "ARRAY", items: { type: "OBJECT", properties: { index: { type: "INTEGER" }, real: { type: "BOOLEAN" }, seen: { type: "STRING" } }, required: ["index", "real"] } } }, required: ["findings"] };

export async function askQuality(imagePath, { scene, ...opts }) {
  return callVision(imagePath, QUESTION(scene), SCHEMA, { model: QUALITY_MODEL, ...opts });
}

/** Returns { kept, dismissed } — `dismissed` carries what the second look saw instead. */
export async function confirmProblems(imagePath, items, { scene, ...opts }) {
  if (!items.length) return { kept: [], dismissed: [] };
  const { findings = [] } = await callVision(imagePath, CONFIRM_QUESTION(scene, items), CONFIRM_SCHEMA, { model: CONFIRM_MODEL, ...opts });
  const byIndex = new Map(findings.map((f) => [f.index, f]));
  const seen = items.map((t, i) => ({ ...t, seen: byIndex.get(i)?.seen || null, real: !!byIndex.get(i)?.real }));
  return { kept: seen.filter((t) => t.real), dismissed: seen.filter((t) => !t.real) };
}

/**
 * Which findings can fail a photo: a gross fault on the people themselves — a body on nothing, a
 * missing, extra or merged limb, a distorted or duplicated face. Everything else is noted, never
 * failed, by the owner's rulings (2026-09-12): equipment nuance (a bench with no visible rear leg, a
 * bar a little high, "the bar passes through the rack"), hands the checker calls "merged", anything
 * in the background, and mirror claims (its mirror geometry is unreliable).
 */
export const GROSS_KINDS = ["body", "face"];
export const failsPhoto = (p) => p.severity === "fatal" && p.on_subject !== false && GROSS_KINDS.includes(p.kind);

/** The serious findings in an answer — the missing exercise included — for the second look. */
export function seriousFindings(answer) {
  const out = (answer.problems || []).filter(failsPhoto).map((p) => ({ ...p }));
  if (answer.exercise_shown === false) out.unshift({ what: `the photo does not show the scene's exercise; it shows ${answer.exercise_seen || "something else"}`, kind: "scene", severity: "fatal" });
  return out;
}

/** Equipment in use that the checker says is not held, sized or placed as the real thing — as notes. */
export function heldNotes(answer) {
  return (answer.held || []).flatMap((h) => {
    const wrong = [!h.grip_real && "not really held or supported", !h.size_real && "not the size or shape of the real thing", !h.position_real && "not where it is in the real exercise"].filter(Boolean);
    return wrong.length ? [`${h.item}: ${wrong.join("; ")}${h.note ? ` (${h.note})` : ""}`] : [];
  });
}

/**
 * The rules (pure). `answer` has its serious findings already confirmed: `confirmed` lists the ones
 * that stand. `people` is the scene's head count, `setting` its tag (solo · coached · group).
 */
export function judgeQuality(answer, { confirmed = seriousFindings(answer), dismissed = [], people = null, setting = null } = {}) {
  const failures = [], minor = [];
  for (const p of confirmed) failures.push(p.kind === "scene" ? `not the scene: ${p.what.replace(/^the photo /, "")}` : `looks fake (${p.kind}): ${p.what}`);
  // The scene's own head count decides whether the class rules apply: a bystander behind a solo lifter
  // does not make a class (extra people are the base check's note).
  const n = people ?? answer.people_count ?? 0;
  const looking = answer.looking_at_camera || 0;
  if (n >= 2) {
    if (answer.poses_near_identical) failures.push(`posed, not candid: the ${n} people are near-copies of each other's pose`);
    if (answer.duplicate_faces) failures.push("the same face on more than one person");
    if (setting === "group" && !answer.interaction) failures.push("a group class with no interaction between the people");
    if (looking > n * POSED_LOOKING_SHARE) failures.push(`${looking} of the ${n} people look into the camera — posed`);
    if (setting === "coached" && answer.coach_attending === false) minor.push("the coach is not watching or helping the client");
  }
  const label = (p) => (p.kind === "reflection" ? "mirror (not judged)" : p.on_subject === false ? "background" : p.kind);
  minor.push(...(answer.problems || []).filter((p) => !failsPhoto(p)).map((p) => `${label(p)}: ${p.what}`), ...heldNotes(answer));
  return {
    ok: failures.length === 0,
    version: QUALITY_VERSION,
    failures,
    minor,
    dismissed: dismissed.map((d) => `${d.what}${d.seen ? ` (second look: ${d.seen})` : ""}`),
    exercise_seen: answer.exercise_seen || null,
    interaction_seen: n >= 2 ? answer.interaction_seen || null : null,
    looking_at_camera: looking,
  };
}

/** The whole check for one photo. `ask` and `confirm` are injectable so the flow is testable offline. */
export async function checkQuality(imagePath, { scene, people = null, setting = null, ask = askQuality, confirm = confirmProblems, ...opts } = {}) {
  if (!scene) throw new Error("the quality check needs the scene the photo was meant to show");
  const answer = await ask(imagePath, { scene, ...opts });
  const { kept, dismissed } = await confirm(imagePath, seriousFindings(answer), { scene, ...opts });
  return { ...judgeQuality(answer, { confirmed: kept, dismissed, people, setting }), answer };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values: v } = parseArgs({ options: {
    image: { type: "string" }, scene: { type: "string" }, setting: { type: "string" }, people: { type: "string" },
    calibrate: { type: "string" }, runs: { type: "string", default: "1" },
  } });
  const show = (q) => (q.ok ? "real" : q.failures.join(" | ")) + (q.minor.length ? `  · minor: ${q.minor.join("; ")}` : "") + (q.dismissed.length ? `  · dismissed: ${q.dismissed.join("; ")}` : "");
  if (v.calibrate) {
    const path = resolve(v.calibrate), base = dirname(path);
    const { photos } = JSON.parse(readFileSync(path, "utf-8"));
    const runs = Math.max(1, parseInt(v.runs, 10) || 1);
    console.log(`Calibrating ${photos.length} photo(s) × ${runs} run(s) with ${QUALITY_MODEL}${CONFIRM_MODEL !== QUALITY_MODEL ? `, second look ${CONFIRM_MODEL}` : ""} (vision calls only)…`);
    let right = 0, total = 0;
    for (const p of photos) {
      const file = isAbsolute(p.file) ? p.file : join(base, p.file);
      if (!existsSync(file)) { console.log(`- ${p.file}: not found`); continue; }
      const got = [];
      for (let r = 0; r < runs; r++) {
        try { got.push(await checkQuality(file, { scene: p.scene, people: p.people ?? null, setting: p.setting ?? null })); }
        catch (e) { got.push({ ok: null, failures: [`check could not run: ${e.message.slice(0, 120)}`], minor: [], dismissed: [] }); }
      }
      const hits = got.filter((q) => q.ok !== null && (q.ok ? "pass" : "fail") === p.expect).length;
      right += hits; total += runs;
      console.log(`${hits === runs ? "✓" : "✗"} ${p.file} — expected ${p.expect} (${p.why || ""}), right ${hits}/${runs}`);
      got.forEach((q, i) => console.log(`    run ${i + 1}: ${show(q)}`));
    }
    console.log(`\n${right}/${total} verdicts as expected.`);
    process.exit(right === total ? 0 : 1);
  }
  if (!v.image || !v.scene) {
    console.error('Usage: check-quality.mjs --image <photo> --scene "…" [--setting solo|coached|group] [--people N]\n       check-quality.mjs --calibrate <calibration.json> [--runs N]');
    process.exit(1);
  }
  const q = await checkQuality(resolve(v.image), { scene: v.scene, setting: v.setting || null, people: v.people ? parseInt(v.people, 10) : null });
  console.log(`${q.ok ? "✓" : "⚑"} ${show(q)}`);
  process.exit(q.ok ? 0 : 1);
}
