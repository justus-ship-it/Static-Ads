/**
 * cards.test.mjs — text-led cards (Phase 5 of the formats plan, 2026-11-11): a Google review, a statement, a timeline.
 *
 * The rules (a review word for word, an excerpt of whole sentences; nothing the standing rules forbid; a statement or a
 * timeline only once the owner has kept it), the stores, the Google pull against a stand-in for the Places API, the
 * drafter with a stub for the model, and the renderer in real Chrome. No model call, no image call, no Google call.
 *
 *   node --test skills/references/cards.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sentencesOf, isExcerptOf, autoExcerpt, onAdProblems, addReview, editReview, readReviews, reviewProblems, usableReviews, findPlace, pullGoogleReviews, placesKey,
  statementProblems, timelineProblems, addStatement, addTimeline, decideWords, keptStatements, keptTimelines, readWords, durationOf, buildWordsPrompt, draftCardWords,
  cardsProblems, cardCount, cardsAvailable, pickCards, MIN_STARS, MAX_CARDS } from "./cards.mjs";
import { renderCard, buildCardSpec, verifyCard, expectedTexts, loadCards, paletteProblems, contrast, boldParts, contentProblems, CARD_KINDS, CARD_RATIOS } from "./render-cards.mjs";
import { launchBrowser } from "./render-composites.mjs";

const REVIEW = "Best decision I made this year! I was nervous walking in on day one. The coaches knew my name by the second session.\nLost 8kg in 6 weeks and paid only $99. Would recommend to anyone.";
const gym = () => { const d = mkdtempSync(join(tmpdir(), "cards-")); writeFileSync(join(d, "gym-profile.json"), JSON.stringify({ display_name: "Test Gym", brand_lock: { voice: { never: ["hustle"] } } })); return d; };
const TIMELINE = { duration: "6 week", title: "Your six weeks, planned.", steps: [{ when: "Week 1", head: "Start where you are", line: "A coach sets your starting weights." }, { when: "Week 3", head: "It is a habit now" }, { when: "Week 6", head: "Stronger than day one", line: "You lift more than you thought you could." }] };
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

test("CD1 a review is used word for word: what shows is whole sentences of it, in order, nothing changed; nothing the standing rules forbid, a weight-loss number in the past tense included; only 5-star reviews; retired with a reason, never deleted", () => {
  assert.deepEqual(sentencesOf(REVIEW), ["Best decision I made this year!", "I was nervous walking in on day one.", "The coaches knew my name by the second session.", "Lost 8kg in 6 weeks and paid only $99.", "Would recommend to anyone."]);
  assert.equal(isExcerptOf(REVIEW, "I was nervous walking in on day one. The coaches knew my name by the second session."), true);
  assert.equal(isExcerptOf(REVIEW, "I was nervous walking in on day one.   The coaches knew my name by the second session."), true, "spacing aside");
  assert.equal(isExcerptOf(REVIEW, "The coaches knew my name"), false, "not a whole sentence");
  assert.equal(isExcerptOf(REVIEW, "I was nervous walking in. The coaches knew my name by the second session."), false, "a word left out");
  assert.equal(isExcerptOf(REVIEW, "Best decision I made this year! The coaches knew my name by the second session."), false, "a sentence skipped");
  assert.equal(isExcerptOf(REVIEW, "The coaches were amazing."), false, "not in the review");
  assert.deepEqual(onAdProblems("Lost 8kg in 6 weeks and paid only $99.", {}, { quote: true }), ["a price", "a weight-loss number"]);
  for (const t of ["I am down 5 kilos since March.", "Dropped two dress sizes!", "12% body fat now.", "I lost 10 lbs."]) assert.deepEqual(onAdProblems(t, {}, { quote: true }), ["a weight-loss number"], t);
  assert.deepEqual(onAdProblems("The coaches knew my name — by the second session.", {}, { quote: true }), [], "a quote keeps its own dash");
  assert.deepEqual(onAdProblems("They offer a free trial.", {}, { quote: true }).includes('says "free trial"'), true);
  const dir = gym();
  try {
    const r = addReview(dir, { author: "  Mei Ling T. ", rating: 5, text: REVIEW, url: "https://maps.app.goo.gl/x" });
    assert.deepEqual([r.id.startsWith("r-"), r.author, r.source, r.usable, r.excerpt], [true, "Mei Ling T.", "pasted", true, "Best decision I made this year! I was nervous walking in on day one. The coaches knew my name by the second session."], "the default excerpt stops before the sentence an ad may not carry");
    assert.equal(readReviews(dir).reviews[0].text, REVIEW, "stored exactly as pasted");
    assert.throws(() => addReview(dir, { author: "Someone Else", rating: 4, text: REVIEW.replace(/\n/, " ") }), /already here/);
    assert.throws(() => addReview(dir, { author: "", rating: 5, text: REVIEW + " More." }), /reviewer's name/);
    assert.throws(() => addReview(dir, { author: "A", rating: 6, text: REVIEW + " More." }), /1 to 5 stars/);
    assert.throws(() => addReview(dir, { author: "A", rating: 5, text: "Great." }), /20 to 5,000 characters/);
    assert.throws(() => addReview(dir, { author: "A", rating: 5, text: REVIEW + " More.", url: "javascript:alert(1)" }), /https address/);
    // The excerpt is the owner's to choose, by the same rule.
    assert.throws(() => editReview(dir, r.id, { excerpt: "The coaches knew my name" }), /whole sentences of the review/);
    let e = editReview(dir, r.id, { excerpt: "Lost 8kg in 6 weeks and paid only $99." });
    assert.deepEqual([e.usable, e.problems], [false, ["the excerpt has a price: choose other sentences", "the excerpt has a weight-loss number: choose other sentences"]]);
    e = editReview(dir, r.id, { excerpt: "The coaches knew my name by the second session." });
    assert.deepEqual([e.usable, e.excerpt], [true, "The coaches knew my name by the second session."]);
    // Three stars is never an advert; a review whose every sentence breaks a rule is kept, not usable.
    const low = addReview(dir, { author: "Low", rating: 3, text: "It was fine for me. The room was a little warm on most days." });
    assert.deepEqual([MIN_STARS, low.usable, low.problems], [5, false, ["3 stars: only 5-star reviews go on an ad"]]);
    const priced = addReview(dir, { author: "Priced", rating: 5, text: "Only $99 for six weeks, what a deal for anyone." });
    assert.equal(priced.usable, false);
    assert.deepEqual(usableReviews(dir).map((x) => x.id), [r.id]);
    assert.throws(() => editReview(dir, r.id, { retired: true }), /needs a reason/);
    assert.deepEqual([editReview(dir, r.id, { retired: true, reason: "she left the gym" }).usable, usableReviews(dir).length, readReviews(dir).reviews.length], [false, 0, 3], "retired, still on file");
    assert.equal(editReview(dir, r.id, { retired: false }).usable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CD2 statements and timelines: checked by the copy's rules, a draft is never used until the owner keeps it, the owner's own is kept at once, edits are checked again, retiring needs a reason; a timeline is for one length of offer", () => {
  assert.deepEqual(statementProblems("Getting older is not what slows you down. Losing **strength** and **balance** does."), []);
  assert.deepEqual(statementProblems("Too short."), ["a statement is 20 to 170 characters (this is 10)"]);
  assert.deepEqual(statementProblems("Lose 5kg for $99 with our free trial, guaranteed."), ["a price", 'says "free trial"', 'says "trial"', 'says "guaranteed"', "a weight-loss number"]);
  assert.deepEqual(statementProblems("A statement with a **bold mark left open and no end to it."), ["a bold mark (**) is not closed"]);
  assert.deepEqual(statementProblems("The hustle never stops for people like you and me.", { brand_lock: { voice: { never: ["hustle"] } } }), ['says "hustle"']);
  assert.deepEqual(timelineProblems(TIMELINE), []);
  assert.deepEqual(timelineProblems({ ...TIMELINE, steps: TIMELINE.steps.slice(0, 2) }), ["a timeline has 3 to 5 steps"]);
  assert.deepEqual(timelineProblems({ ...TIMELINE, duration: "soon" }), ['a timeline says the duration it is for, e.g. "6 week"']);
  assert.deepEqual(timelineProblems({ ...TIMELINE, steps: [...TIMELINE.steps.slice(0, 2), { when: "Week 6", head: "You have lost 5 kg" }] }), ["a weight-loss number"]);
  assert.deepEqual(timelineProblems({ ...TIMELINE, title: "A title that runs on far too long for the top of a card to hold" }), ["the title is over 44 characters"]);
  assert.deepEqual([durationOf("6 Week Strength & Confidence Challenge"), durationOf("42 Day Beginner's Body Reset"), durationOf("6-week Reset"), durationOf("Summer Shred")], ["6 week", "42 day", "6 week", null]);
  const dir = gym();
  try {
    const mine = addStatement(dir, "Getting older is not what slows you down — losing **strength** does.");
    assert.deepEqual([mine.status, mine.source, mine.text], ["kept", "owner", "Getting older is not what slows you down - losing **strength** does."], "the owner's own is kept; a long dash becomes a hyphen");
    const d = addStatement(dir, "You do not need more time. You need **forty five minutes** you will not cancel.", { source: "drafted", offer: "6 Week Reset" });
    assert.deepEqual([d.status, d.drafted_for, keptStatements(dir).map((s) => s.id)], ["draft", "6 Week Reset", [mine.id]], "a draft is not used");
    assert.throws(() => addStatement(dir, "Getting older is not what slows you down - losing strength does."), /already here/);
    assert.equal(decideWords(dir, "statement", d.id, { status: "kept" }).status, "kept");
    assert.throws(() => decideWords(dir, "statement", d.id, { text: "Only $50 this week for the first ten people." }), /a price/);
    assert.equal(decideWords(dir, "statement", d.id, { text: "You do not need more time. You need **an hour** you will not cancel." }).text.includes("an hour"), true);
    assert.throws(() => decideWords(dir, "statement", d.id, { status: "retired" }), /needs a reason/);
    assert.deepEqual([decideWords(dir, "statement", d.id, { status: "retired", reason: "too blunt" }).status, keptStatements(dir).length, readWords(dir).statements.length], ["retired", 1, 2]);
    const t = addTimeline(dir, TIMELINE, { source: "drafted" });
    assert.deepEqual([t.status, keptTimelines(dir, "6 week").length], ["draft", 0]);
    decideWords(dir, "timeline", t.id, { status: "kept" });
    assert.deepEqual([keptTimelines(dir, "6 week").length, keptTimelines(dir, "12 week").length, keptTimelines(dir).length], [1, 0, 1], "a 6 week timeline is for a 6 week offer");
    assert.throws(() => decideWords(dir, "timeline", t.id, { timeline: { title: "Short", steps: [] } }), /3 to 5 steps/);
    assert.deepEqual(cardsAvailable(dir, { offer: "6 Week Reset" }), { review: 0, statement: 1, timeline: 1 });
    assert.deepEqual(cardsAvailable(dir, { offer: "12 Week Reset" }), { review: 0, statement: 1, timeline: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CD3 the drafter: one text call, the offer's own words and the rules in the request, every draft checked in code — a broken one dropped with the reason, a kept one never duplicated — and all of them drafts for the owner", async () => {
  const p = buildWordsPrompt({ kind: "statement", offer: "6 Week Strength & Confidence Challenge", audience: "women over 40", count: 4, existing: ["An old one."] });
  assert.match(p.prompt, /"6 Week Strength & Confidence Challenge"\. The advert is for: women over 40\./);
  assert.match(p.prompt, /NEVER: a price or any money; a free trial; before and after; a guarantee; a number of kilos/);
  assert.match(p.prompt, /Write 4 statements/); assert.match(p.prompt, /Already written[\s\S]*- An old one\./);
  const tp = buildWordsPrompt({ kind: "timeline", offer: "42 Day Beginner's Body Reset", count: 2 });
  assert.match(tp.prompt, /The programme lasts 42 days\./); assert.match(tp.prompt, /never a calendar date/); assert.match(tp.prompt, /promises no result/);
  const dir = gym();
  try {
    const asked = [];
    const ask = async (image, prompt, schema) => { asked.push([image, !!schema.properties.statements]); return { statements: [{ text: "You do not need more time. You need **forty five minutes** you will not cancel." }, { text: "Lose **5kg** in six weeks or your money back." }, { text: "Strong is not a look. It is **carrying your own shopping** at seventy." }] }; };
    const r = await draftCardWords({ brandDir: dir, kind: "statement", offer: "6 Week Reset", count: 3, ask });
    assert.deepEqual([r.calls, asked, r.added.length, r.added.every((a) => a.status === "draft" && a.source === "drafted"), r.dropped.length], [1, [[null, true]], 2, true, 1]);
    assert.match(r.dropped[0].reason, /a weight-loss number/);
    assert.equal(keptStatements(dir).length, 0, "nothing is used until the owner keeps it");
    const again = await draftCardWords({ brandDir: dir, kind: "statement", offer: "6 Week Reset", count: 3, ask });
    assert.deepEqual([again.added.length, again.dropped.filter((d) => /already here/.test(d.reason)).length], [0, 2]);
    const tl = await draftCardWords({ brandDir: dir, kind: "timeline", offer: "6 Week Reset", count: 1, ask: async () => ({ timelines: [{ title: TIMELINE.title, steps: TIMELINE.steps.map((s) => ({ line: "", ...s })) }] }) });
    assert.deepEqual([tl.added.length, tl.added[0].duration, tl.added[0].status], [1, "6 week", "draft"]);
    await assert.rejects(draftCardWords({ brandDir: dir, kind: "timeline", offer: "Summer Shred", ask }), /names its length/);
    await assert.rejects(draftCardWords({ brandDir: dir, kind: "poster", offer: "6 Week Reset", ask }), /statement or timeline/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CD4 reviews from Google (the Places API): the key rides in a header and never in a message; the place is found by name, its reviews — five at most — are added word for word with the reviewer's name and stars, the ones already here counted, and the place remembered; no key is said in words", async () => {
  const dir = gym(), seen = [];
  const reviews = [
    { rating: 5, text: { text: "Translated text" }, originalText: { text: "I was nervous walking in on day one. The coaches knew my name by the second session." }, authorAttribution: { displayName: "Mei Ling T." }, publishTime: "2026-09-01T10:00:00Z", googleMapsUri: "https://www.google.com/maps/reviews/abc" },
    { rating: 4, text: { text: "Good classes and friendly people. The 6am session is always full." }, authorAttribution: { displayName: "Arjun P." } },
    { rating: 5, text: { text: "ok" }, authorAttribution: { displayName: "Short" } },
  ];
  const fetchFn = async (url, opts) => {
    seen.push({ url, key: opts.headers["X-Goog-Api-Key"], mask: opts.headers["X-Goog-FieldMask"], method: opts.method, body: opts.body || null });
    if (url.endsWith("/places:searchText")) return { ok: true, status: 200, json: async () => ({ places: [{ id: "ChIJ_place_0001", displayName: { text: "Test Gym" }, formattedAddress: "1 Test Road, Singapore" }] }) };
    if (url.includes("/places/ChIJ_denied_0001")) return { ok: false, status: 403, json: async () => ({ error: { message: "API key SECRET-KEY-123 is not authorised for this API" } }) };
    return { ok: true, status: 200, json: async () => ({ id: "ChIJ_place_0001", displayName: { text: "Test Gym" }, formattedAddress: "1 Test Road, Singapore", rating: 4.8, userRatingCount: 212, reviews }) };
  };
  try {
    await assert.rejects(findPlace("Test Gym", { key: null, fetchFn }), /no Google Places key yet: add GOOGLE_PLACES_KEY to \.env/);
    const found = await findPlace("Test Gym, 1 Test Road", { key: "SECRET-KEY-123", fetchFn });
    assert.deepEqual(found, [{ id: "ChIJ_place_0001", name: "Test Gym", address: "1 Test Road, Singapore" }]);
    assert.deepEqual([seen[0].method, seen[0].key, seen[0].mask, JSON.parse(seen[0].body)], ["POST", "SECRET-KEY-123", "places.id,places.displayName,places.formattedAddress", { textQuery: "Test Gym, 1 Test Road" }]);
    assert.ok(!seen[0].url.includes("SECRET"), "the key is never in the address");
    const r = await pullGoogleReviews(dir, { placeId: "ChIJ_place_0001", key: "SECRET-KEY-123", fetchFn });
    assert.deepEqual([r.found, r.added.length, r.already, r.skipped.map((s) => s.author), r.place], [3, 2, 0, ["Short"], { id: "ChIJ_place_0001", name: "Test Gym", address: "1 Test Road, Singapore", rating: 4.8, ratings: 212 }]);
    assert.match(seen[1].mask, /^id,displayName,formattedAddress,rating,userRatingCount,reviews$/);
    const stored = readReviews(dir);
    assert.deepEqual(stored.reviews.map((x) => [x.source, x.author, x.rating, x.text.slice(0, 20), x.date || null, x.url || null]), [["google", "Mei Ling T.", 5, "I was nervous walkin", "2026-09-01", "https://www.google.com/maps/reviews/abc"], ["google", "Arjun P.", 4, "Good classes and fri", null, null]], "the reviewer's own words, not the translation");
    // Only a 5-star review is an advert (the owner's rule): the 4-star one is kept on file and never used.
    assert.deepEqual([usableReviews(dir).map((x) => x.author), reviewProblems(stored.reviews[1])], [["Mei Ling T."], ["4 stars: only 5-star reviews go on an ad"]]);
    const again = await pullGoogleReviews(dir, { key: "SECRET-KEY-123", fetchFn });
    assert.deepEqual([again.added.length, again.already], [0, 2], "the place is remembered; nothing twice");
    await assert.rejects(pullGoogleReviews(dir, { placeId: "ChIJ_denied_0001", key: "SECRET-KEY-123", fetchFn }), (e) => /Google answered 403/.test(e.message) && !e.message.includes("SECRET-KEY-123"));
    await assert.rejects(pullGoogleReviews(gymless(), { key: "SECRET-KEY-123", fetchFn }), /which place\?/);
    const was = process.env.GOOGLE_PLACES_KEY; process.env.GOOGLE_PLACES_KEY = "";
    try { assert.equal(placesKey(), null, "an empty key in the environment means none"); } finally { if (was === undefined) delete process.env.GOOGLE_PLACES_KEY; else process.env.GOOGLE_PLACES_KEY = was; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const made = [];
function gymless() { const d = mkdtempSync(join(tmpdir(), "cards-none-")); made.push(d); return d; }
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("CD5 a batch's cards: that many of each kind from what is ready, the same on a re-run, refused by name when a kind has too few", () => {
  assert.deepEqual(cardsProblems({ review: 2, statement: 0 }), []);
  assert.deepEqual(cardsProblems({ poster: 1, review: 7, timeline: 1.5 }), ['cards: "poster" is not one of review, statement, timeline', `cards.review must be 0 to ${MAX_CARDS}`, `cards.timeline must be 0 to ${MAX_CARDS}`]);
  assert.deepEqual(cardsProblems([1]), ["cards maps each kind of card to how many the batch has"]);
  assert.deepEqual([cardCount({ review: 2, timeline: 1 }), cardCount(null), cardCount({})], [3, 0, 0]);
  const dir = gym();
  try {
    for (const [a, t] of [["One A.", "The coaches are patient and kind. I look forward to every session now."], ["Two B.", "Clean studio and a friendly crowd. The 6am class sets up my whole day."], ["Three C.", "I have never stuck with a gym before. This one I have, for eight months."]]) addReview(dir, { author: a, rating: 5, text: t });
    addStatement(dir, "Getting older is not what slows you down. Losing **strength** does.");
    addTimeline(dir, TIMELINE);
    const a = pickCards(dir, { cards: { review: 2, statement: 1, timeline: 1 }, offer: "6 Week Reset", seed: "batch-a" });
    assert.deepEqual(a.map((c) => [c.id, c.kind]), [["k01", "review"], ["k02", "review"], ["k03", "statement"], ["k04", "timeline"]]);
    assert.deepEqual(Object.keys(a[0].content).sort(), ["author", "excerpt", "rating", "source_label"]);
    assert.equal(a[0].content.source_label, "Google review");
    assert.deepEqual(pickCards(dir, { cards: { review: 2, statement: 1, timeline: 1 }, offer: "6 Week Reset", seed: "batch-a" }), a, "the same batch picks the same cards");
    assert.equal(new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => pickCards(dir, { cards: { review: 1 }, offer: "6 Week Reset", seed: `s${n}` })[0].source_id)).size > 1, true, "another batch may pick another review");
    assert.throws(() => pickCards(dir, { cards: { review: 4 }, offer: "6 Week Reset" }), /4 review cards asked for, 3 ready: paste or pull 5-star Google reviews on Library → Cards/);
    assert.throws(() => pickCards(dir, { cards: { timeline: 1 }, offer: "12 Week Reset" }), /1 timeline card asked for, 0 ready: draft some for a 12 week offer/);
    assert.deepEqual(pickCards(dir, { cards: {}, offer: "6 Week Reset" }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CD6 the card renderer: every pairing reads on its colour; each kind is set at 4:5 and at 9:16 inside Meta's live area with the words given and nothing else, verified; words too long for the card are refused in words; a statement's bold marks are spans, not words", async () => {
  const cat = loadCards();
  for (const [id, p] of Object.entries(cat.palettes)) assert.deepEqual(paletteProblems(p), [], id);
  assert.deepEqual(paletteProblems({ ...cat.palettes["k-navy-cream"], ink: "#22305A" }).length > 0, true);
  assert.ok(contrast("#000000", "#FFFFFF") > 20.9 && contrast("#777777", "#777777") === 1);
  assert.deepEqual([CARD_KINDS, CARD_RATIOS, cat.safe_area["9x16"]], [["review", "statement", "timeline"], ["4x5", "9x16"], [6, 14, 88, 51]]);
  assert.deepEqual(boldParts("Losing **strength, balance** and **mobility** does."), [{ text: "Losing ", bold: false }, { text: "strength, balance", bold: true }, { text: " and ", bold: false }, { text: "mobility", bold: true }, { text: " does.", bold: false }]);
  assert.deepEqual(contentProblems("review", { excerpt: "", author: "A", rating: 9 }), ["a review card needs the review's words", "a review's rating is 1 to 5 stars"]);
  assert.throws(() => buildCardSpec({ kind: "poster", content: {}, location: "BISHAN", offer: "6 Week Reset" }), /kind must be one of review, statement, timeline/);
  assert.throws(() => buildCardSpec({ kind: "statement", content: { text: "Fine words for a card to carry." }, location: "BISHAN", offer: "6 Week Reset", palette: "k-none" }), /unknown card palette/);
  const words = { location: "JURONG WEST", audience: "LADIES WANTED", offer: "6 Week Strength & Confidence Challenge" };
  const contents = {
    review: { excerpt: "I was nervous walking in on day one. The coaches knew my name by the second session.", author: "Mei Ling T.", rating: 4 },
    statement: { text: "Getting older is not what slows you down. Losing **strength, balance** and **mobility** does." },
    timeline: { title: TIMELINE.title, steps: TIMELINE.steps },
  };
  for (const kind of CARD_KINDS) for (const ratio of CARD_RATIOS) {
    const r = await renderCard(browser, { kind, content: contents[kind], ratio, palette: Object.keys(cat.palettes)[CARD_KINDS.indexOf(kind)], ...words });
    assert.deepEqual([r.ok, r.failures], [true, []], `${kind} ${ratio}`);
    assert.deepEqual([r.png.readUInt32BE(16), r.png.readUInt32BE(20)], cat.canvas[ratio]);
    const S = r.report.safe;
    assert.deepEqual(r.report.blocks.map((b) => [b.block, b.text]).sort(), expectedTexts(r.spec).sort(), "the page set the words given, all of them and nothing else");
    for (const b of r.report.blocks) assert.ok(b.rect.x >= S.x - 1 && b.rect.y >= S.y - 1 && b.rect.x + b.rect.w <= S.x + S.w + 1 && b.rect.y + b.rect.h <= S.y + S.h + 1, `${kind} ${ratio}: "${b.block}" inside the safe area`);
    assert.ok(r.report.sizes.body >= cat.min_px.body && r.report.sizes.location >= cat.min_px.callout);
    if (ratio === "9x16") assert.ok(S.y >= 1920 * 0.14 - 1 && S.y + S.h <= 1920 * 0.65 + 1, "Meta's live area");
    if (kind === "review") { assert.equal(r.report.blocks.find((b) => b.block === "author").text, "Mei Ling T. · Google review"); assert.equal(r.report.blocks.find((b) => b.block === "review").text, `“${contents.review.excerpt}”`); }
    if (kind === "statement") assert.equal(r.report.blocks.find((b) => b.block === "statement").text, "Getting older is not what slows you down. Losing strength, balance and mobility does.", "the marks are not words");
  }
  // Too long for the card: refused, with the way out.
  const long = await renderCard(browser, { kind: "review", content: { excerpt: Array(14).fill("The coaches knew my name by the second session and I have not missed a week since.").join(" "), author: "A", rating: 5 }, ratio: "9x16", ...words });
  assert.equal(long.ok, false);
  assert.match(long.failures.join(" | "), /the words are too long for this card at 9:16: at the smallest type \(34 px\) they still do not fit — use a shorter excerpt/);
  // The verifier does not trust the page: a block that reads otherwise, or sits outside, is a failure.
  const good = await renderCard(browser, { kind: "statement", content: contents.statement, ratio: "4x5", ...words });
  const forged = structuredClone(good.report); forged.blocks.find((b) => b.block === "statement").text = "Something else entirely."; forged.blocks.find((b) => b.block === "location").rect.x = -40;
  assert.deepEqual(verifyCard(good.spec, forged), ['"location" leaves the safe area', '"statement" reads "Something else entirely.", not the words given']);
});
