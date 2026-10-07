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
import { readForms, templateFrom, nextName, proposeForm, formProblems, createPayload, createForm, readLeadForms, questionSpec, FORM_LIMITS } from "./lead-forms.mjs";

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
  assert.deepEqual(t.spec.questions[0], { type: "CUSTOM", label: "你在信義區附近工作或居住嗎？", options: [{ value: "是" }, { value: "否" }] });
  assert.deepEqual(t.spec.questions[3], { type: "DATE_TIME", label: "請預約時間與我們見面以開始！" });
  assert.deepEqual(t.spec.questions[4], { type: "EMAIL" }, "a standard question goes up by type alone: Meta refuses a label on it");
  assert.deepEqual(t.spec.context_card, { title: "六週中年體態雕塑計畫", content: ["幫助我們多認識你！"], style: "PARAGRAPH_STYLE" });
  assert.deepEqual(t.spec.thank_you_page, { title: "最後一步", body: XINYI.thank_you_page.body, button_type: "CALL_BUSINESS", button_text: "聯絡我們", business_phone_number: "+886980660800" });
  assert.deepEqual(t.spec.privacy_policy, { url: "https://f45training.com/privacy", link_text: "瀏覽 F45 Xinyi 信義的隱私政策。" });
  assert.deepEqual([t.spec.locale, t.spec.question_page_custom_headline, t.spec.allow_organic_lead, t.source.id, t.source.leads_count], ["zh_TW", XINYI.question_page_custom_headline, true, "7001", 118]);
  assert.deepEqual(questionSpec({ type: "custom", label: " x ", options: ["a", { value: "b" }, ""] }), { type: "CUSTOM", label: "x", options: [{ value: "a" }, { value: "b" }] });
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
  assert.match(p({ thank_you_page: { title: "t", body: "b", button_type: "VIEW_WEBSITE" } }).join(), /website button needs the address/);
  assert.match(p({ thank_you_page: { title: "", body: "b", button_type: "NONE" } }).join(), /thank-you page needs a title/);
  const body = createPayload(ok);
  assert.deepEqual(Object.keys(body).sort(), ["allow_organic_lead", "block_display_for_non_targeted_viewer", "context_card", "is_optimized_for_quality", "locale", "name", "privacy_policy", "question_page_custom_headline", "questions", "thank_you_page"]);
  assert.deepEqual(body.questions[4], { type: "EMAIL" });
  assert.deepEqual(questionSpec({ type: "PHONE", label: "Phone number" }), { type: "PHONE" });
  const dir = mkdtempSync(join(tmpdir(), "leadforms-")), c = client();
  try {
    await assert.rejects(createForm(c, "105", { ...ok, name: "" }, { gymDir: dir }), /not ready: the form needs a name/);
    assert.equal(c.posts.length, 0, "nothing sent for a spec with problems");
    const made = await createForm(c, "105", ok, { gymDir: dir, offer: "X", templateId: "7001", now: new Date("2026-10-07T12:00:00Z") });
    assert.deepEqual([c.posts[0].page, c.posts[0].body.name, c.posts[0].body.questions.length, c.posts[0].body.privacy_policy.url], ["105", ok.name, 7, "https://f45training.com/privacy"]);
    assert.deepEqual(made, { id: "7777", name: ok.name, created: "2026-10-07T12:00:00.000Z", page_id: "105", offer: "X", from_template: "7001", questions: 7 });
    assert.deepEqual(readLeadForms(dir).created, [made]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "lead-forms.json"), "utf-8")).created[0].id, "7777");
    await assert.rejects(createForm(client({ create: () => ({}) }), "105", ok), /without a form id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
