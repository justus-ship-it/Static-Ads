/**
 * render-cards.mjs — text-led cards (Phase 5 of the formats plan, 2026-11-11).
 *
 * A card is an advert with no photograph: a real Google review, a statement or a timeline set by software on a plain
 * colour, with the area across the top and the duration and offer at the foot like every other ad of the gym. No image
 * call, no logo, no drawn button. Rendered at 4:5 for the feed and at 9:16 inside Meta's live area for Stories and Reels.
 *
 * The words are given, never made here: the offer, location and audience from the brief; a review word for word; a
 * statement or a timeline the owner kept (cards.mjs). Every render is verified — the words read back from the page are
 * the words given, every line sits inside the safe area, nothing is clipped, and the body type is no smaller than the floor.
 *
 *   node skills/references/render-cards.mjs --demo out-dir     (three sample cards at both shapes, for a look)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { launchBrowser, splitOffer, validateInputs } from "./render-composites.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CATALOGUE = join(REPO_ROOT, ".claude/skills/static-ads/references/offer-cards.json");
const STYLES = join(REPO_ROOT, ".claude/skills/static-ads/references/offer-styles.json");
const TEMPLATE = join(HERE, "card-template.html");

export const CARD_KINDS = ["review", "statement", "timeline"];
export const CARD_RATIOS = ["4x5", "9x16"];
export const CARD_FACES = ["anton", "montserrat"]; // the faces a card is set in (offer-styles.json → faces)
export const loadCards = () => JSON.parse(readFileSync(CATALOGUE, "utf-8"));

const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/** What is wrong with a card pairing: the type must read on its colour. */
export function paletteProblems(p) {
  const errs = [];
  for (const k of ["bg", "ink", "accent", "muted", "paper", "paper_ink", "star"]) if (!/^#[0-9A-Fa-f]{6}$/.test(p?.[k] || "")) errs.push(`${k} must be a #RRGGBB colour`);
  if (errs.length) return errs;
  if (contrast(p.ink, p.bg) < 4.5) errs.push(`ink on bg is ${contrast(p.ink, p.bg).toFixed(1)}:1 (4.5 needed)`);
  if (contrast(p.paper_ink, p.paper) < 4.5) errs.push(`paper_ink on paper is ${contrast(p.paper_ink, p.paper).toFixed(1)}:1 (4.5 needed)`);
  if (contrast(p.accent, p.bg) < 3) errs.push(`accent on bg is ${contrast(p.accent, p.bg).toFixed(1)}:1 (3 needed)`);
  if (contrast(p.muted, p.bg) < 3) errs.push(`muted on bg is ${contrast(p.muted, p.bg).toFixed(1)}:1 (3 needed)`);
  return errs;
}

/** A statement's "**bold**" marks as parts: [{ text, bold }]. The words themselves are untouched. */
export function boldParts(text) {
  const parts = []; let last = 0;
  for (const m of String(text).matchAll(/\*\*(.+?)\*\*/g)) { if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false }); parts.push({ text: m[1], bold: true }); last = m.index + m[0].length; }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts;
}
export const plainOf = (text) => String(text).replace(/\*\*/g, "");

/** What is wrong with a card's content, before any render. */
export function contentProblems(kind, c) {
  if (!CARD_KINDS.includes(kind)) return [`kind must be one of ${CARD_KINDS.join(", ")}`];
  const errs = [], str = (v) => typeof v === "string" && v.trim().length > 0;
  if (kind === "review") {
    if (!str(c?.excerpt)) errs.push("a review card needs the review's words");
    if (!str(c?.author)) errs.push("a review card names its reviewer");
    if (!Number.isInteger(c?.rating) || c.rating < 1 || c.rating > 5) errs.push("a review's rating is 1 to 5 stars");
  } else if (kind === "statement") {
    if (!str(c?.text)) errs.push("a statement card needs its statement");
    else if ((c.text.match(/\*\*/g) || []).length % 2) errs.push("a bold mark (**) is not closed");
  } else {
    if (!str(c?.title)) errs.push("a timeline needs its title");
    if (!Array.isArray(c?.steps) || c.steps.length < 3 || c.steps.length > 5) errs.push("a timeline has 3 to 5 steps");
    else c.steps.forEach((s, i) => { if (!str(s?.when) || !str(s?.head)) errs.push(`step ${i + 1} needs when it is and what happens`); });
  }
  return errs;
}

/** The render's instructions for one card at one shape. */
export function buildCardSpec({ kind, content, location, audience = null, offer, free = false, palette = "k-navy-cream", ratio = "4x5", catalogue = loadCards() }) {
  const errs = [...contentProblems(kind, content), ...(validateInputs({ location, audience, offer }) || [])];
  const pal = catalogue.palettes[palette];
  if (!pal) errs.push(`unknown card palette "${palette}"`); else errs.push(...paletteProblems(pal).map((e) => `${palette}: ${e}`));
  if (!catalogue.canvas[ratio]) errs.push(`ratio must be one of ${Object.keys(catalogue.canvas).join(", ")}`);
  if (errs.length) throw new Error(`the card cannot be set:\n- ${errs.join("\n- ")}`);
  const { duration, offer_name } = splitOffer(offer, free);
  const c = kind === "review" ? { excerpt: content.excerpt.trim(), author: content.author.trim(), rating: content.rating, source_label: content.source_label || "Google review" }
    : kind === "statement" ? { text: content.text.trim(), parts: boldParts(content.text.trim()) }
    : { title: content.title.trim(), steps: content.steps.map((s) => ({ when: s.when.trim(), head: s.head.trim(), ...(s.line ? { line: s.line.trim() } : {}) })) };
  return { kind, ratio, canvas: catalogue.canvas[ratio], safe: catalogue.safe_area[ratio], palette: pal, palette_id: palette, min_px: catalogue.min_px, max_px: catalogue.max_px,
    text: { location: location.trim(), audience: audience ? audience.trim() : null, duration: duration || null, offer_name }, content: c };
}

let fontCss = null;
function fonts() {
  if (fontCss) return fontCss;
  const faces = JSON.parse(readFileSync(STYLES, "utf-8")).faces;
  fontCss = CARD_FACES.map((id) => { const f = faces[id]; return `@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weights[0]} ${f.weights[1]}; src: url(data:font/ttf;base64,${readFileSync(join(REPO_ROOT, f.file)).toString("base64")}) format("truetype"); }`; }).join("\n");
  return fontCss;
}
const buildHtml = (spec) => readFileSync(TEMPLATE, "utf-8").replace("/*__FONTS__*/", () => fonts()).replace("/*__SPEC__*/null", () => JSON.stringify(spec).replace(/</g, "\\u003c"));

/** What the page must have set, as [block, text] pairs — the words given, nothing else. */
export function expectedTexts(spec) {
  const t = spec.text, c = spec.content, out = [["location", t.location], ...(t.audience ? [["audience", t.audience]] : []), ...(t.duration ? [["duration", t.duration]] : []), ["offer_name", t.offer_name]];
  if (spec.kind === "review") out.push(["review", `“${c.excerpt}”`], ["author", `${c.author} · ${c.source_label}`]);
  else if (spec.kind === "statement") out.push(["statement", plainOf(c.text)]);
  else { out.push(["title", c.title]); c.steps.forEach((s, i) => { out.push([`step ${i + 1}`, s.head]); if (s.line) out.push([`step ${i + 1} line`, s.line]); out.push([`step ${i + 1} when`, s.when]); }); }
  return out;
}

/** The render's own report judged against what was asked: an empty list means the card may ship. */
export function verifyCard(spec, report) {
  const fails = [];
  if (!report || !Array.isArray(report.blocks)) return ["the page gave no report"];
  const got = new Map(report.blocks.map((b) => [b.block, b]));
  for (const [block, text] of expectedTexts(spec)) {
    const b = got.get(block);
    if (!b) { fails.push(`"${block}" was not set`); continue; }
    if (b.text !== text) fails.push(`"${block}" reads ${JSON.stringify(b.text.slice(0, 60))}, not the words given`);
    const S = report.safe, r = b.rect;
    if (r.x < S.x - 1 || r.y < S.y - 1 || r.x + r.w > S.x + S.w + 1 || r.y + r.h > S.y + S.h + 1) fails.push(`"${block}" leaves the safe area`);
    if (b.clipped && ["location", "duration", "offer_name"].includes(block)) fails.push(`"${block}" does not fit its line`);
  }
  if (report.blocks.length !== expectedTexts(spec).length) fails.push("the page set words that were not given");
  if (report.overflow) fails.push(`the words are too long for this card at ${spec.ratio.replace("x", ":")}: at the smallest type (${spec.min_px.body} px) they still do not fit — use a shorter ${spec.kind === "review" ? "excerpt" : spec.kind}`);
  if ((report.sizes?.body ?? 0) < spec.min_px.body) fails.push(`the body type is under ${spec.min_px.body} px`);
  return fails;
}

/** Render one card. Returns { ok, failures, png, report, spec }. */
export async function renderCard(browser, opts) {
  const spec = buildCardSpec(opts);
  const { cdp, sessionId, work } = browser, [W, H] = spec.canvas;
  const file = join(work, `card-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, buildHtml(spec));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.send("Page.navigate", { url: pathToFileURL(file).href }, sessionId);
  await loaded;
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression: `new Promise((r) => { const c = () => window.__renderPromise ? window.__renderPromise.then(r) : setTimeout(c, 20); c(); })`, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(`card page error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  const report = result.value;
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } }, sessionId);
  rmSync(file, { force: true });
  const failures = verifyCard(spec, report);
  return { ok: failures.length === 0, failures, png: Buffer.from(shot.data, "base64"), report, spec };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === "--demo") {
  const out = resolve(process.argv[3] || "card-demo"); mkdirSync(out, { recursive: true });
  const words = { location: "JURONG WEST", offer: "6 Week Strength & Confidence Challenge" };
  const demos = [
    ["review", "k-navy-cream", { excerpt: "I was nervous walking in on day one. The coaches knew my name by the second session and I have not missed a week since.", author: "Sample Reviewer", rating: 5 }],
    ["statement", "k-cream-navy", { text: "Aging isn't what takes your independence. Losing **strength, balance** and **mobility** does." }],
    ["timeline", "k-forest-cream", { title: "Your six weeks, planned.", steps: [{ when: "Week 1", head: "Start where you are", line: "A coach sets your starting weights." }, { when: "Week 3", head: "It gets easier to show up", line: "Three sessions a week, the same faces." }, { when: "Week 6", head: "Stronger than day one", line: "You lift more than you thought you could." }] }],
  ];
  const browser = await launchBrowser();
  try {
    for (const [kind, palette, content] of demos) for (const ratio of CARD_RATIOS) {
      const r = await renderCard(browser, { kind, content, palette, ratio, ...words });
      writeFileSync(join(out, `${kind}-${ratio}.png`), r.png);
      console.log(kind, ratio, r.ok ? "ok" : `FAIL ${r.failures.join("; ")}`, JSON.stringify(r.report.sizes));
    }
  } finally { await browser.close(); }
}
