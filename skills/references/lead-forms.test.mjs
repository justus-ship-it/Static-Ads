/**
 * Tests for the form builder (lead-forms.mjs): a Page's form read back into a template, the proposal with the
 * offer and district swapped and their naming scheme, the rules in code, creation through a fake client and
 * the gym's record. Offline.
 *
 *   node --test skills/references/lead-forms.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readForms, templateFrom, nextName, proposeForm, formProblems, createPayload, createForm, readLeadForms, writeLeadForms, questionSpec, FORM_LIMITS, normPhone, whatsappFor, numbersIn, withWhatsapp, whatsappProblems, whatsappOf, markWhatsappChecked } from "./lead-forms.mjs";
import { validateProfile } from "./client-config.mjs";
import { publishReadiness } from "./meta-publish.mjs";

// F45 Xinyi's July form, as the Page answers it (read 2026-10-07; ids shortened).
const XINYI = {
  id: "7001", name: "v8 -7月 2026 六週中年體態雕塑計畫", status: "ACTIVE", created_time: "2026-07-09T09:58:47+0000", leads_count: 118, locale: "zh_TW",
  questions: [
    { key: "q1", type: "CUSTOM", label: "你在信義區附近工作或居住嗎？", options: [{ key: "是", value: "是" }, { key: "否", value: "否" }] },
    { key: "q2", type: "CUSTOM", label: "您實現健身目標的動力有多大？（1 - 最小，5 - 最大）", options: ["1", "2", "3", "4", "5"].map((v) => ({ key: v, value: v })) },
    { key: "q3", type: "CUSTOM", label: "爲什麽想要參加六週中年體態雕塑計畫?" },
    { key: "q4", type: "DATE_TIME", label: "請預約時間與我們見面以開始！" },
    { key: "email", type: "EMAIL", label: "Email" }, { key: "full_name", type: "FULL_NAME", label: "Full name" }, { key: "phone", type: "PHONE", label: "Phone number" },
  ],
  privacy_policy_url: "https://f45training.com/privacy", legal_content: { id: "l1", privacy_policy: { url: "https://f45training.com/privacy", link_text: "瀏覽 F45 Xinyi 信義的隱私政策。" } },
  context_card: { title: "六週中年體態雕塑計畫", content: ["幫助我們多認識你！"], style: "PARAGRAPH_STYLE", id: "c1" },
  thank_you_page: { title: "最後一步", body: "請加入我們的 LINE \n通知我們你已完成報名\nID：@f45xinyi", button_type: "CALL_BUSINESS", button_text: "聯絡我們", business_phone_number: "+886980660800", id: "t1" },
  question_page_custom_headline: "我們將使用您的信息就我們的活動與您聯繫。", block_display_for_non_targeted_viewer: false, is_optimized_for_quality: false, allow_organic_lead: true,
};
const client = (answers = {}) => ({ posts: [], leadFormDetails: async () => [{ ...XINYI, id: "7000", name: "older", created_time: "2026-04-01T00:00:00+0000" }, XINYI], createLeadForm: async function (page, body) { this.posts.push({ page, body }); return answers.create ? answers.create(body) : { id: "7777" }; } });

test("LF1 a form read back becomes a template: every question as the create call takes it (a custom one with its wording and options, a standard one by type), the intro card, the thank-you page with its call button and number, the privacy link with its text, the headline, the locale; the offer phrase is the intro card's title and the district the first question's 區 word; the Page's forms come newest first", async () => {
  const forms = await readForms(client(), "105");
  assert.deepEqual(forms.map((f) => f.id), ["7001", "7000"]); assert.equal(forms[0].question_count, 7);
  const t = templateFrom(XINYI);
  assert.deepEqual(t.phrases, { offer: "六週中年體態雕塑計畫", district: "信義區" });
  assert.deepEqual(t.spec.questions[0], { type: "CUSTOM", label: "你在信義區附近工作或居住嗎？", key: "q1", options: [{ key: "是", value: "是" }, { key: "否", value: "否" }] }, "the form's own keys kept; every option carries one (an option without a key made Meta's server fail)");
  assert.deepEqual(t.spec.questions[3], { type: "DATE_TIME", label: "請預約時間與我們見面以開始！", key: "q4" });
  assert.deepEqual(t.spec.questions[4], { type: "EMAIL" }, "a standard question goes up by type alone: Meta refuses a label on it");
  assert.deepEqual(t.spec.context_card, { title: "六週中年體態雕塑計畫", content: ["幫助我們多認識你！"], style: "PARAGRAPH_STYLE" });
  assert.deepEqual(t.spec.thank_you_page, { title: "最後一步", body: XINYI.thank_you_page.body, button_type: "CALL_BUSINESS", button_text: "聯絡我們", business_phone_number: "+886980660800", country_code: "TW" }, "the call button's country from the number's prefix");
  assert.deepEqual(t.spec.privacy_policy, { url: "https://f45training.com/privacy", link_text: "瀏覽 F45 Xinyi 信義的隱私政策。" });
  assert.deepEqual([t.spec.locale, t.spec.question_page_custom_headline, t.spec.allow_organic_lead, t.source.id, t.source.leads_count], ["zh_TW", XINYI.question_page_custom_headline, true, "7001", 118]);
  assert.deepEqual(questionSpec({ type: "custom", label: " x y ", options: ["a", { value: "b" }, "", { key: "a", value: "c" }] }), { type: "CUSTOM", label: "x y", key: "x_y", options: [{ key: "a", value: "a" }, { key: "b", value: "b" }, { key: "a_4", value: "c" }] }, "keys from the values, a repeat told apart");
  assert.equal(formProblems(t.spec).length, 0, "their own form passes the rules as read");
});

test("LF2 the proposal: their naming scheme carried on (v8 → v9, this month and year), the old offer → the new one in the name, the intro card and the question that names it, the district → the batch's callout in the question that names it, nothing else rewritten; a name of the owner's wins; what changed is listed; no offer is refused", () => {
  const t = templateFrom(XINYI), now = new Date("2026-10-07T12:00:00Z");
  assert.equal(nextName("v8 -7月 2026 六週中年體態雕塑計畫", "六週全身體態改造計畫", now), "v9 - 10月 2026 六週全身體態改造計畫");
  assert.equal(nextName("Jan 5 - Males Lead Gen", "12 Week Reset", now), "1007 12 Week Reset");
  const r = proposeForm(t, { offer: "六週全身體態改造計畫", callout: "大安區", now });
  assert.equal(r.spec.name, "v9 - 10月 2026 六週全身體態改造計畫");
  assert.equal(r.spec.context_card.title, "六週全身體態改造計畫");
  assert.equal(r.spec.questions[2].label, "爲什麽想要參加六週全身體態改造計畫?");
  assert.equal(r.spec.questions[0].label, "你在大安區附近工作或居住嗎？");
  assert.equal(r.spec.questions[1].label, XINYI.questions[1].label, "a question naming neither is untouched");
  assert.deepEqual(r.spec.thank_you_page, t.spec.thank_you_page, "the thank-you page is untouched");
  assert.deepEqual(r.changed, ["name", "question 1", "question 3", "intro card"]);
  assert.deepEqual(r.swapped, [{ from: "六週中年體態雕塑計畫", to: "六週全身體態改造計畫" }, { from: "信義區", to: "大安區" }]);
  const same = proposeForm(t, { offer: "六週全身體態改造計畫", callout: "信義區", name: "My own name", now });
  assert.deepEqual([same.spec.name, same.spec.questions[0].label, same.swapped.length], ["My own name", XINYI.questions[0].label, 1], "the same district swaps nothing; the owner's name wins");
  assert.throws(() => proposeForm(t, { offer: "  " }), /offer's exact words/);
  assert.equal(formProblems(r.spec).length, 0);
});

test("LF3 the rules in code and creation: no name, no questions, too many, an unknown type, a custom question without wording, one option, a repeated option, a standard question with options, no privacy policy, a call button without a number, a website button without an address — each named; the create call carries exactly what Meta takes, through the Page; the gym's record keeps every form made here; a spec with problems is refused before any call", async () => {
  const t = templateFrom(XINYI), ok = proposeForm(t, { offer: "X" }).spec;
  const p = (over) => formProblems({ ...ok, ...over });
  assert.match(p({ name: "" }).join(), /needs a name/);
  assert.match(p({ questions: [] }).join(), /at least one question/);
  assert.match(p({ questions: Array(FORM_LIMITS.questions + 1).fill({ type: "CUSTOM", label: "q" }) }).join(), /16 questions; Meta takes 15/);
  assert.match(p({ questions: [{ type: "RIDDLE", label: "?" }] }).join(), /not a question type/);
  assert.match(p({ questions: [{ type: "CUSTOM", label: " " }] }).join(), /custom question needs its wording/);
  assert.match(p({ questions: [{ type: "CUSTOM", label: "a", options: [{ value: "x" }] }] }).join(), /at least two options/);
  assert.match(p({ questions: [{ type: "CUSTOM", label: "a", options: [{ value: "x" }, { value: "x" }] }] }).join(), /two options read the same/);
  assert.match(p({ questions: [{ type: "EMAIL", options: [{ value: "x" }, { value: "y" }] }] }).join(), /only a custom question carries options/);
  assert.match(p({ questions: [{ type: "EMAIL" }, { type: "EMAIL" }] }).join(), /EMAIL is asked twice/);
  assert.match(p({ privacy_policy: null }).join(), /privacy policy address is required/);
  assert.match(p({ thank_you_page: { title: "t", body: "b", button_type: "CALL_BUSINESS" } }).join(), /call button needs the business's phone number/);
  assert.match(p({ thank_you_page: { title: "t", body: "b", button_type: "CALL_BUSINESS", business_phone_number: "980660800" } }).join(), /needs the number's country/);
  assert.equal(p({ thank_you_page: { title: "t", body: "b", button_type: "CALL_BUSINESS", business_phone_number: "980660800", country_code: "TW" } }).length, 0);
  assert.match(p({ thank_you_page: { title: "t", body: "b", button_type: "VIEW_WEBSITE" } }).join(), /website button needs the address/);
  assert.match(p({ thank_you_page: { title: "", body: "b", button_type: "NONE" } }).join(), /thank-you page needs a title/);
  const body = createPayload(ok);
  assert.deepEqual(Object.keys(body).sort(), ["allow_organic_lead", "block_display_for_non_targeted_viewer", "context_card", "is_optimized_for_quality", "locale", "name", "privacy_policy", "question_page_custom_headline", "questions", "thank_you_page"]);
  assert.deepEqual(body.questions[4], { type: "EMAIL" });
  assert.equal(body.thank_you_page.country_code, "TW", "the call button goes up with its country");
  assert.deepEqual(questionSpec({ type: "PHONE", label: "Phone number" }), { type: "PHONE" });
  const dir = mkdtempSync(join(tmpdir(), "leadforms-")), c = client();
  try {
    await assert.rejects(createForm(c, "105", { ...ok, name: "" }, { gymDir: dir }), /not ready: the form needs a name/);
    assert.equal(c.posts.length, 0, "nothing sent for a spec with problems");
    const made = await createForm(c, "105", ok, { gymDir: dir, offer: "X", templateId: "7001", now: new Date("2026-10-07T12:00:00Z") });
    assert.deepEqual([c.posts[0].page, c.posts[0].body.name, c.posts[0].body.questions.length, c.posts[0].body.privacy_policy.url], ["105", ok.name, 7, "https://f45training.com/privacy"]);
    assert.deepEqual(made, { id: "7777", name: ok.name, created: "2026-10-07T12:00:00.000Z", page_id: "105", offer: "X", from_template: "7001", questions: 7, button: "CALL_BUSINESS" });
    assert.deepEqual(readLeadForms(dir).created, [made]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "lead-forms.json"), "utf-8")).created[0].id, "7777");
    await assert.rejects(createForm(client({ create: () => ({}) }), "105", ok), /without a form id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("LF4 the number behind a WhatsApp button (2026-11-27, Aether: the app made the form with a WhatsApp button and no number, Meta chose one, and leads opened the wrong chat): a gym has one WhatsApp number for its lead forms; a form with such a button is not made without it, carries it with its country, and its thank-you text may name no other number; what the app made is recorded with the number it sent; Meta never shows which number a button opens, so a form made here stays unchecked until the owner ticks it — only for the gym's own number — and the create's checks say so", async () => {
  // The number itself.
  assert.deepEqual([normPhone("+65 8000 1234"), normPhone("6580001234"), normPhone("+65-8000-1234"), normPhone("call us"), normPhone("12345"), normPhone("")], ["+6580001234", "+6580001234", "+6580001234", null, null, null]);
  assert.deepEqual([whatsappFor({ meta_assets: { lead_form_whatsapp: "+65 8000 1234" } }), whatsappFor({ meta_assets: {} }), whatsappFor(null)], ["+6580001234", null, null]);
  assert.deepEqual(numbersIn("Send us a message on WhatsApp (+65 8000 1234), or call 6580 0056 78. Room 12."), ["6580001234", "6580005678"]);
  const profile = (w) => ({ schema_version: 3, gym: "aether", display_name: "Aether", meta_assets: { lead_form_whatsapp: w } });
  assert.deepEqual(validateProfile(profile("+65 8000 1234")).errors.filter((e) => /WhatsApp/.test(e)), []);
  for (const bad of ["8000 1234 maybe", "80001234", "+65 12"]) assert.match(validateProfile(profile(bad)).errors.join("; "), /WhatsApp number for lead forms .* must be a phone number with its country code/, bad);
  // A form with a WhatsApp button, as the template gives it: no number.
  const base = { name: "1127 6 Week Full Body Transformation", questions: [{ type: "FULL_NAME" }, { type: "PHONE" }], privacy_policy: { url: "https://example.sg/privacy" },
    thank_you_page: { title: "ONE LAST STEP!", body: "Send us a message on WhatsApp for us to complete your registration (+65 8000 1234)", button_type: "WHATSAPP", button_text: "Complete Registration" } };
  assert.deepEqual(formProblems(base), [], "with no gym number in the question, the form is as it always was");
  assert.match(formProblems(base, { whatsapp: null }).join("; "), /Meta picks the number itself when none is sent .* set this gym's WhatsApp number for lead forms first/);
  assert.match(formProblems(base, { whatsapp: "+6580001234" }).join("; "), /the WhatsApp button must be tied to this gym's number for lead forms \(\+6580001234\)/);
  const tied = withWhatsapp(base, "+65 8000 1234");
  assert.deepEqual([tied.thank_you_page.business_phone_number, tied.thank_you_page.country_code, formProblems(tied, { whatsapp: "+6580001234" })], ["+6580001234", "SG", []]);
  assert.deepEqual(createPayload(tied).thank_you_page, { ...base.thank_you_page, business_phone_number: "+6580001234", country_code: "SG" });
  // The text and the button must be the same number.
  const other = withWhatsapp({ ...base, thank_you_page: { ...base.thank_you_page, body: "Message us on WhatsApp (+65 8000 5678)" } }, "+6580001234");
  assert.match(whatsappProblems(other, "+6580001234").join("; "), /the thank-you text names the number 6580005678, but this gym's WhatsApp number for lead forms is \+6580001234/);
  assert.deepEqual(whatsappProblems(withWhatsapp({ ...base, thank_you_page: { ...base.thank_you_page, body: "WhatsApp us on 8000 1234" } }, "+6580001234"), "+6580001234"), [], "the number without its country code is the same number");
  // Another button is not this rule's business.
  const call = { ...base, thank_you_page: { title: "Thanks", body: "", button_type: "CALL_BUSINESS", business_phone_number: "+6561234567" } };
  assert.deepEqual([withWhatsapp(call, "+6580001234"), whatsappProblems(call, null)], [call, []]);
  // Made through the client: refused without the gym's number, recorded with it.
  const dir = mkdtempSync(join(tmpdir(), "leadforms-wa-")), sent = [], c = { createLeadForm: async (page, body) => { sent.push(body); return { id: "9100" + sent.length }; } };
  try {
    await assert.rejects(createForm(c, "105", base, { gymDir: dir, whatsapp: null }), /set this gym's WhatsApp number for lead forms first/);
    assert.equal(sent.length, 0, "nothing was sent");
    const made = await createForm(c, "105", tied, { gymDir: dir, whatsapp: "+6580001234", templateId: "7001" });
    assert.deepEqual([made.button, made.whatsapp, sent[0].thank_you_page.business_phone_number, sent[0].thank_you_page.country_code], ["WHATSAPP", "+6580001234", "+6580001234", "SG"]);
    // What is known of each form's button. One made before today carries no button on its record: its template says it.
    const data = readLeadForms(dir); data.template = { source: { id: "7001" }, spec: { thank_you_page: { button_type: "WHATSAPP" } } };
    data.created.push({ id: "8000", name: "1122 old form", from_template: "7001", questions: 14 }); data.seen = { "7700": { name: "V2 by hand", button: "WHATSAPP", number: null }, "7800": { name: "A call form", button: "CALL_BUSINESS", number: "+6561234567" } };
    writeLeadForms(dir, data);
    assert.deepEqual(whatsappOf(data, made.id), { whatsapp: true, made_here: true, sent: "+6580001234", checked: null });
    assert.deepEqual(whatsappOf(data, "8000"), { whatsapp: true, made_here: true, sent: null, checked: null }, "made here before the number was sent");
    assert.deepEqual([whatsappOf(data, "7700"), whatsappOf(data, "7800"), whatsappOf(data, "0000")], [{ whatsapp: true, made_here: false, sent: null, checked: null }, { whatsapp: false, made_here: false }, { whatsapp: false, made_here: false }]);
    // The create's checks: open until he ticks it; a form made in Ads Manager is his already.
    const plan = { ready: true, problems: [], lead_form_id: made.id, offer: "6 Week Full Body Transformation", adsets: [], ads: [], copy: {} }, lines = (w) => publishReadiness(plan, { formName: "1127 6 Week Full Body Transformation", formWhatsapp: w }).checks.filter((x) => /WhatsApp/.test(x.text));
    assert.deepEqual(lines(whatsappOf(data, made.id)).map((x) => [x.ok, /was set to \+6580001234 through the API, and Meta does not show which number it really opens/.test(x.text), x.where]), [[false, true, "destination"]]);
    assert.deepEqual(lines(whatsappOf(data, "8000")).map((x) => [x.ok, /made here before a WhatsApp number was sent with it/.test(x.text)]), [[false, true]]);
    assert.deepEqual([lines(whatsappOf(data, "7700")), lines(null)], [[], []]);
    // His tick.
    assert.throws(() => markWhatsappChecked(dir, "7700", { number: "+6580001234" }), /only a form this app made is ticked here/);
    assert.throws(() => markWhatsappChecked(dir, made.id, { number: "soon" }), /say which number/);
    const ticked = markWhatsappChecked(dir, made.id, { number: "+65 8000 1234", now: new Date("2026-11-27T10:00:00Z") });
    assert.deepEqual(ticked.checked, { number: "+6580001234", on: "2026-11-27T10:00:00.000Z" });
    assert.deepEqual(lines(ticked).map((x) => [x.ok, x.text]), [[true, "you checked the form's WhatsApp button in Ads Manager: +6580001234"]]);
    assert.equal(markWhatsappChecked(dir, made.id, { ok: false }).checked, null, "and taken back");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
