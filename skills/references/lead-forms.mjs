/**
 * Instant (lead) forms built in the agent (2026-10-07). A gym's Page already carries the forms its ads
 * ran on — F45 Xinyi's three live forms are fourteen questions each, identical in shape, with the offer
 * in exactly three places (the form's name, the intro card's title, one question) and the district in one.
 * So a new form for a new offer is the template with those words swapped:
 *
 *   readForms   — the Page's forms in full (through the Page's own token), newest first
 *   templateFrom — a form read back → the spec a new one is created from (questions, intro card, thank-you
 *                  page, privacy link, headline, locale), with the offer and district phrases it carries
 *   proposeForm — the template with the old offer → the new offer everywhere, the old district → the new
 *                  one, named by their own scheme ("v8 -7月 2026 {offer}" → "v9 - 10月 2026 {offer}");
 *                  the owner edits every part before anything is sent
 *   formProblems — what Meta would refuse or the rules forbid, checked in code
 *   createForm  — POST {page}/leadgen_forms (the owner's click); recorded in brands/{gym}/lead-forms.json
 *
 * The gym's record (`lead-forms.json`): the template's id and read-back, every form created here. The gym's
 * default form stays `meta_assets.lead_form_id` on the profile (the Lead forms page sets it); a batch's own
 * choice is its publish settings' `destination.lead_form_id`. Meta forms cannot be edited once created
 * (only archived), which is why the version number stays in the name.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export const LEAD_FORMS_FILE = "lead-forms.json";
/** Meta's limits on an instant form (Ads Manager's own): questions in all, options on a multiple-choice question, the lengths. */
export const FORM_LIMITS = { questions: 15, options: 50, name: 100, label: 200, option: 100, title: 60, body: 400, headline: 300 };
/** The question types a form may carry (Meta's LeadGenQuestion types this builder knows). A CUSTOM question is the owner's own. */
export const QUESTION_TYPES = ["CUSTOM", "FULL_NAME", "FIRST_NAME", "LAST_NAME", "EMAIL", "PHONE", "DATE_TIME", "COUNTRY", "DOB", "GENDER", "CITY", "STATE", "ZIP", "STREET_ADDRESS", "POST_CODE", "PROVINCE", "JOB_TITLE", "COMPANY_NAME", "WORK_EMAIL", "WORK_PHONE_NUMBER", "MILITARY_STATUS", "MARITIAL_STATUS", "RELATIONSHIP_STATUS"];
export const BUTTON_TYPES = ["VIEW_WEBSITE", "CALL_BUSINESS", "MESSAGE_BUSINESS", "NONE", "DOWNLOAD", "SCHEDULE_APPOINTMENT", "VIEW_ON_FACEBOOK", "WHATSAPP", "BOOK_ON_WEBSITE"];

export const readLeadForms = (gymDir) => { const p = join(gymDir, LEAD_FORMS_FILE); return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { schema: 1, template: null, created: [] }; };
export function writeLeadForms(gymDir, data) { const p = join(gymDir, LEAD_FORMS_FILE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(data, null, 2) + "\n"); return data; }

/** The Page's forms in full, newest first. One call (paged). */
export async function readForms(client, pageId) {
  const forms = await client.leadFormDetails(pageId);
  return forms.map(summarise).sort((a, b) => (b.created_time || "").localeCompare(a.created_time || ""));
}
const summarise = (f) => ({ ...f, question_count: (f.questions || []).length });

/** The question as the create call takes it: a standard type alone, a CUSTOM one with its label and options. */
export function questionSpec(q) {
  const type = String(q.type || "CUSTOM").toUpperCase();
  const out = { type };
  if (type === "CUSTOM" || type === "DATE_TIME" || q.label) out.label = String(q.label || "").trim();
  if (Array.isArray(q.options) && q.options.length) out.options = q.options.map((o) => ({ value: String(typeof o === "string" ? o : o.value ?? o.key ?? "").trim() })).filter((o) => o.value);
  return out;
}

/**
 * A form read back → the spec a new one is created from. The offer phrase is the intro card's title when
 * it has one (their forms title the card with the offer), else nothing; the district phrase is the first
 * question's "…區" / "…附近" word when the Page's address has one.
 */
export function templateFrom(form, { district = null } = {}) {
  const questions = (form.questions || []).map(questionSpec);
  const ty = form.thank_you_page || {};
  const spec = {
    name: form.name || "",
    locale: form.locale || null,
    questions,
    context_card: form.context_card ? { title: form.context_card.title || "", content: [].concat(form.context_card.content || []).filter(Boolean), style: form.context_card.style || "PARAGRAPH_STYLE", ...(form.context_card.button_text ? { button_text: form.context_card.button_text } : {}) } : null,
    thank_you_page: ty.title || ty.body ? { title: ty.title || "", body: ty.body || "", button_type: ty.button_type || "NONE", ...(ty.button_text ? { button_text: ty.button_text } : {}), ...(ty.website_url ? { website_url: ty.website_url } : {}), ...(ty.business_phone_number ? { business_phone_number: ty.business_phone_number } : {}) } : null,
    privacy_policy: form.legal_content?.privacy_policy?.url || form.privacy_policy_url ? { url: form.legal_content?.privacy_policy?.url || form.privacy_policy_url, ...(form.legal_content?.privacy_policy?.link_text ? { link_text: form.legal_content.privacy_policy.link_text } : {}) } : null,
    follow_up_action_url: form.follow_up_action_url || null,
    question_page_custom_headline: form.question_page_custom_headline || null,
    block_display_for_non_targeted_viewer: form.block_display_for_non_targeted_viewer ?? null,
    is_optimized_for_quality: form.is_optimized_for_quality ?? null,
    allow_organic_lead: form.allow_organic_lead ?? null,
  };
  const offer = (form.context_card?.title || "").trim() || null;
  const q0 = (form.questions || []).map((q) => q.label || "").find((l) => /區|附近|near|around/i.test(l)) || "";
  const dm = district && q0.includes(district) ? district : (q0.match(/([一-鿿]{2}區)/) || [])[1] || null;
  return { spec, phrases: { offer, district: dm }, source: { id: form.id, name: form.name, created_time: form.created_time || null, leads_count: form.leads_count ?? null } };
}

/** Their naming scheme: "v8 -7月 2026 六週…" → "v9 - 10月 2026 {offer}"; anything else → "{MMDD} {offer}". */
export function nextName(templateName, offer, now = new Date()) {
  const m = String(templateName || "").match(/^v(\d+)\s*-\s*\d{1,2}月\s*\d{4}\s*/i);
  const month = now.getMonth() + 1, year = now.getFullYear();
  if (m) return `v${Number(m[1]) + 1} - ${month}月 ${year} ${offer}`.trim();
  const mmdd = `${String(month).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `${mmdd} ${offer}`.trim();
}

const swap = (text, pairs) => pairs.reduce((t, [from, to]) => (from && to != null && from !== to ? t.split(from).join(to) : t), String(text ?? ""));

/**
 * The template with the words swapped: the old offer → the new offer wherever it appears (the name, the
 * intro card, the questions, the thank-you page, the headline), the old district → the new callout.
 * Nothing else is rewritten. `name` overrides the scheme.
 */
export function proposeForm(template, { offer, oldOffer = null, callout = null, oldDistrict = null, name = null, now = new Date() } = {}) {
  if (!offer || !String(offer).trim()) throw new Error("the offer's exact words are needed to propose a form");
  const t = template.spec || template, ph = template.phrases || {};
  const pairs = [[oldOffer ?? ph.offer, String(offer).trim()], [oldDistrict ?? ph.district, callout ? String(callout).trim() : null]];
  const s = (x) => swap(x, pairs);
  const spec = {
    ...t,
    name: name ? String(name).trim() : nextName(t.name, String(offer).trim(), now),
    questions: (t.questions || []).map((q) => ({ ...q, ...(q.label != null ? { label: s(q.label) } : {}), ...(q.options ? { options: q.options.map((o) => ({ ...o, value: s(o.value) })) } : {}) })),
    context_card: t.context_card ? { ...t.context_card, title: s(t.context_card.title), content: (t.context_card.content || []).map(s) } : null,
    thank_you_page: t.thank_you_page ? { ...t.thank_you_page, title: s(t.thank_you_page.title), body: s(t.thank_you_page.body) } : null,
    question_page_custom_headline: t.question_page_custom_headline ? s(t.question_page_custom_headline) : null,
  };
  const changed = [];
  const diff = (label, a, b) => { if (String(a ?? "") !== String(b ?? "")) changed.push(label); };
  diff("name", t.name, spec.name);
  (t.questions || []).forEach((q, i) => diff(`question ${i + 1}`, q.label, spec.questions[i]?.label));
  diff("intro card", JSON.stringify(t.context_card), JSON.stringify(spec.context_card));
  diff("thank-you page", JSON.stringify(t.thank_you_page), JSON.stringify(spec.thank_you_page));
  diff("headline", t.question_page_custom_headline, spec.question_page_custom_headline);
  return { spec, changed, swapped: pairs.filter(([a, b]) => a && b != null && a !== b).map(([from, to]) => ({ from, to })) };
}

/** What Meta would refuse or the rules forbid — checked before the owner's click, so a refusal names the part. */
export function formProblems(spec) {
  const p = [], L = FORM_LIMITS;
  const name = String(spec?.name || "").trim();
  if (!name) p.push("the form needs a name"); else if (name.length > L.name) p.push(`the name is ${name.length} characters; Meta takes ${L.name}`);
  const qs = Array.isArray(spec?.questions) ? spec.questions : [];
  if (!qs.length) p.push("the form needs at least one question");
  if (qs.length > L.questions) p.push(`${qs.length} questions; Meta takes ${L.questions}`);
  const seen = new Set();
  qs.forEach((q, i) => {
    const n = `question ${i + 1}`, type = String(q?.type || "").toUpperCase();
    if (!QUESTION_TYPES.includes(type)) { p.push(`${n}: "${q?.type}" is not a question type this builder knows`); return; }
    const label = String(q.label || "").trim();
    if ((type === "CUSTOM" || type === "DATE_TIME") && !label) p.push(`${n}: a ${type === "CUSTOM" ? "custom" : "date and time"} question needs its wording`);
    if (label.length > L.label) p.push(`${n}: the wording is ${label.length} characters; Meta takes ${L.label}`);
    if (type !== "CUSTOM" && seen.has(type)) p.push(`${n}: ${type} is asked twice`); seen.add(type);
    if (q.options != null) {
      if (!Array.isArray(q.options)) p.push(`${n}: options must be a list`);
      else {
        const vals = q.options.map((o) => String(o?.value ?? "").trim());
        if (vals.length === 1) p.push(`${n}: a multiple-choice question needs at least two options`);
        if (vals.length > L.options) p.push(`${n}: ${vals.length} options; Meta takes ${L.options}`);
        if (vals.some((v) => !v)) p.push(`${n}: an option is empty`);
        if (new Set(vals).size !== vals.length) p.push(`${n}: two options read the same`);
        if (vals.some((v) => v.length > L.option)) p.push(`${n}: an option is over ${L.option} characters`);
        if (type !== "CUSTOM" && vals.length) p.push(`${n}: only a custom question carries options`);
      }
    }
  });
  if (!spec?.privacy_policy?.url || !/^https?:\/\/\S+$/i.test(String(spec.privacy_policy.url))) p.push("a privacy policy address is required (Meta refuses a form without one)");
  if (spec?.context_card) {
    if (String(spec.context_card.title || "").length > L.title) p.push(`the intro card's title is over ${L.title} characters`);
    if (!Array.isArray(spec.context_card.content)) p.push("the intro card's text must be a list of lines");
  }
  const ty = spec?.thank_you_page;
  if (ty) {
    if (!String(ty.title || "").trim()) p.push("the thank-you page needs a title");
    if (String(ty.title || "").length > L.title) p.push(`the thank-you title is over ${L.title} characters`);
    if (String(ty.body || "").length > L.body) p.push(`the thank-you text is over ${L.body} characters`);
    const bt = String(ty.button_type || "NONE").toUpperCase();
    if (!BUTTON_TYPES.includes(bt)) p.push(`the thank-you button "${ty.button_type}" is not one Meta offers`);
    if (["VIEW_WEBSITE", "BOOK_ON_WEBSITE"].includes(bt) && !/^https?:\/\/\S+$/i.test(String(ty.website_url || ""))) p.push("a website button needs the address it opens");
    if (bt === "CALL_BUSINESS" && !/^\+?[\d\s()-]{6,}$/.test(String(ty.business_phone_number || ""))) p.push("a call button needs the business's phone number (with its country code)");
  }
  if (spec?.question_page_custom_headline && String(spec.question_page_custom_headline).length > L.headline) p.push(`the headline is over ${L.headline} characters`);
  if (spec?.follow_up_action_url && !/^https?:\/\/\S+$/i.test(String(spec.follow_up_action_url))) p.push("the follow-up address must be a web address");
  return p;
}

/** The POST body: only what Meta takes, nothing empty. */
export function createPayload(spec) {
  const body = { name: String(spec.name).trim(), questions: spec.questions.map(questionSpec), privacy_policy: spec.privacy_policy };
  if (spec.locale) body.locale = spec.locale;
  if (spec.context_card) body.context_card = spec.context_card;
  if (spec.thank_you_page) body.thank_you_page = spec.thank_you_page;
  if (spec.follow_up_action_url) body.follow_up_action_url = spec.follow_up_action_url;
  if (spec.question_page_custom_headline) body.question_page_custom_headline = spec.question_page_custom_headline;
  if (spec.block_display_for_non_targeted_viewer != null) body.block_display_for_non_targeted_viewer = !!spec.block_display_for_non_targeted_viewer;
  if (spec.is_optimized_for_quality != null) body.is_optimized_for_quality = !!spec.is_optimized_for_quality;
  if (spec.allow_organic_lead != null) body.allow_organic_lead = !!spec.allow_organic_lead;
  return body;
}

/** Create the form on the Page (the owner's action) and record it. Refuses a spec with problems before any call. */
export async function createForm(client, pageId, spec, { gymDir = null, offer = null, templateId = null, now = new Date() } = {}) {
  const problems = formProblems(spec);
  if (problems.length) throw new Error(`the form is not ready: ${problems.join("; ")}`);
  const r = await client.createLeadForm(pageId, createPayload(spec));
  if (!r?.id) throw new Error("Meta answered without a form id");
  const made = { id: String(r.id), name: spec.name, created: now.toISOString(), page_id: String(pageId), offer: offer || null, from_template: templateId || null, questions: spec.questions.length };
  if (gymDir) { const data = readLeadForms(gymDir); data.created = [made, ...(data.created || [])]; writeLeadForms(gymDir, data); }
  return made;
}
