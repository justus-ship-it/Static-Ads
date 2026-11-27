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

/** The question as the create call takes it: a standard type alone — Meta refuses a label on a non-custom
 *  question ("無法為非自訂問題指定參數標籤", F45 Xinyi's first create, 2026-10-07) — a CUSTOM or DATE_TIME one
 *  with its wording, a multiple-choice one with its options. */
export const LABELLED_TYPES = ["CUSTOM", "DATE_TIME"];
/** A question's key as Meta makes one from its wording (the lead export's column): spaces to underscores. */
export const keyFor = (label) => String(label || "").trim().replace(/\s+/g, "_").slice(0, 100);
export function questionSpec(q) {
  const type = String(q.type || "CUSTOM").toUpperCase();
  const out = { type };
  if (LABELLED_TYPES.includes(type)) { out.label = String(q.label || "").trim(); out.key = String(q.key || "").trim() || keyFor(out.label); }
  // Every option carries a key — an option without one made Meta's server fail ("An unknown error has occurred",
  // code 1; found with each element tried alone, 2026-10-07): the value, as their own forms have it.
  if (Array.isArray(q.options) && q.options.length) {
    const seen = new Set();
    out.options = q.options.map((o, i) => { const value = String(typeof o === "string" ? o : o.value ?? o.key ?? "").trim(); let key = String((typeof o === "object" && o.key) || value).trim() || `option_${i + 1}`; while (seen.has(key)) key = `${key}_${i + 1}`; seen.add(key); return { key, value }; }).filter((o) => o.value);
  }
  return out;
}
/** The country code a call button needs beside its number (Meta: "Business phone number or country code is missing"): from the number's prefix, else the gym's country. */
export const COUNTRY_PREFIXES = { "+886": "TW", "+65": "SG", "+60": "MY", "+852": "HK", "+81": "JP", "+82": "KR", "+61": "AU", "+44": "GB", "+1": "US" };
export function countryCodeFor(phone, fallback = null) {
  const p = String(phone || "").replace(/[\s()-]/g, "");
  for (const [prefix, code] of Object.entries(COUNTRY_PREFIXES).sort((a, b) => b[0].length - a[0].length)) if (p.startsWith(prefix)) return code;
  return fallback || null;
}

/**
 * A form read back → the spec a new one is created from. The offer phrase is the intro card's title when
 * it has one (their forms title the card with the offer), else nothing; the district phrase is the first
 * question's "…區" / "…附近" word when the Page's address has one.
 */
export function templateFrom(form, { district = null, country = null } = {}) {
  const questions = (form.questions || []).map(questionSpec);
  const ty = form.thank_you_page || {};
  const spec = {
    name: form.name || "",
    locale: form.locale || null,
    questions,
    context_card: form.context_card ? { title: form.context_card.title || "", content: [].concat(form.context_card.content || []).filter(Boolean), style: form.context_card.style || "PARAGRAPH_STYLE", ...(form.context_card.button_text ? { button_text: form.context_card.button_text } : {}) } : null,
    thank_you_page: ty.title || ty.body ? { title: ty.title || "", body: ty.body || "", button_type: ty.button_type || "NONE", ...(ty.button_text ? { button_text: ty.button_text } : {}), ...(ty.website_url ? { website_url: ty.website_url } : {}), ...(ty.business_phone_number ? { business_phone_number: ty.business_phone_number, country_code: ty.country_code || countryCodeFor(ty.business_phone_number, country) } : {}) } : null,
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

// ── The number behind a WhatsApp button (2026-11-27) ─────────────────────────────────────────────────────────────────
// Aether's leads tapped "Complete Registration" and WhatsApp opened to the wrong number. The app had copied a template
// whose button is WHATSAPP and sent no number with it — the API does not return the number of a form made in Ads Manager,
// so the template never carried one — and Meta filled in one of its own (the phone on the Page). Now a gym has ONE
// WhatsApp number for its lead forms (the profile's `meta_assets.lead_form_whatsapp`); a form with a WhatsApp button is
// not made without it, it is sent with the button (`business_phone_number` + `country_code`: tested on Aether's Page,
// Meta took them and gave them back), and a number named in the thank-you text must be that number. What Meta gives
// back is only what it was sent — a form whose number was picked by hand reads back nothing — so which number the
// button really opens is the owner's to look at in Ads Manager, and his tick (`whatsapp_checked`) is kept on the form.
/** A phone number as "+6580001234" (digits after a plus), or null when it is not one. */
export const normPhone = (s) => { const t = String(s ?? "").trim(), d = t.replace(/\D/g, ""); return /^\+?[\d\s()-]+$/.test(t) && d.length >= 8 && d.length <= 15 ? `+${d}` : null; };
/** The gym's WhatsApp number for its lead forms, normalised, or null. */
export const whatsappFor = (profile) => normPhone(profile?.meta_assets?.lead_form_whatsapp);
/** Every phone number a text names, as digits (7 or more, spaces and dashes aside). */
export const numbersIn = (text) => [...String(text ?? "").matchAll(/\+?\d[\d\s-]{5,}\d/g)].map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 7);
const isWhatsapp = (spec) => String(spec?.thank_you_page?.button_type || "").toUpperCase() === "WHATSAPP";
/** The form with its WhatsApp button tied to the gym's number (a form with another button is left as it is). */
export function withWhatsapp(spec, number) {
  if (!isWhatsapp(spec) || !normPhone(number)) return spec;
  const n = normPhone(number);
  return { ...spec, thank_you_page: { ...spec.thank_you_page, business_phone_number: n, country_code: spec.thank_you_page.country_code || countryCodeFor(n) || undefined } };
}
/** What is wrong with a form's WhatsApp button for a gym whose number is `number` (null: none set). Nothing for another button. */
export function whatsappProblems(spec, number) {
  if (!isWhatsapp(spec)) return [];
  const n = normPhone(number), ty = spec.thank_you_page, p = [];
  if (!n) return ["this form's button opens WhatsApp, and Meta picks the number itself when none is sent with it (Aether's forms opened the wrong number that way): set this gym's WhatsApp number for lead forms first, on Library → Lead forms"];
  if (normPhone(ty.business_phone_number) !== n) p.push(`the WhatsApp button must be tied to this gym's number for lead forms (${n})${ty.business_phone_number ? `: it says ${ty.business_phone_number}` : ""}`);
  if (!countryCodeFor(n) && !/^[A-Z]{2}$/.test(String(ty.country_code || ""))) p.push("the WhatsApp number needs its country (a two-letter country code)");
  for (const d of numbersIn(`${ty.title || ""} ${ty.body || ""}`)) if (!n.slice(1).endsWith(d)) p.push(`the thank-you text names the number ${d}, but this gym's WhatsApp number for lead forms is ${n}: the text and the button must be the same number`);
  return p;
}
/** What is known of a form's WhatsApp button from the gym's own file: was it made here, with which number, and has the owner checked it. */
export function whatsappOf(data, id) {
  const made = (data?.created || []).find((f) => String(f.id) === String(id)) || null, seen = data?.seen?.[String(id)] || null;
  const button = made?.button || seen?.button || (made && String(made.from_template || "") === String(data?.template?.source?.id || "-") ? data.template?.spec?.thank_you_page?.button_type : null) || null;
  if (String(button || "").toUpperCase() !== "WHATSAPP") return { whatsapp: false, made_here: !!made };
  return { whatsapp: true, made_here: !!made, sent: normPhone(made?.whatsapp) || normPhone(seen?.number) || null, checked: made?.whatsapp_checked || null };
}
/** The owner's word that he looked at the form in Ads Manager and its WhatsApp button opens `number` (ok: false takes it back). Only a form made here. */
export function markWhatsappChecked(gymDir, id, { number, ok = true, now = new Date() } = {}) {
  const data = readLeadForms(gymDir), made = (data.created || []).find((f) => String(f.id) === String(id));
  if (!made) throw new Error("only a form this app made is ticked here: a form made in Ads Manager is yours already");
  if (ok && !normPhone(number)) throw new Error("say which number the form's WhatsApp button shows in Ads Manager");
  if (ok) made.whatsapp_checked = { number: normPhone(number), on: now.toISOString() }; else delete made.whatsapp_checked;
  writeLeadForms(gymDir, data);
  return whatsappOf(data, id);
}

/** What Meta would refuse or the rules forbid — checked before the owner's click, so a refusal names the part.
 *  `whatsapp` (when given, even as null) is the gym's WhatsApp number for lead forms: a form with a WhatsApp button is held to it. */
export function formProblems(spec, opts = {}) {
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
    else if (bt === "CALL_BUSINESS" && !/^[A-Z]{2}$/.test(String(ty.country_code || countryCodeFor(ty.business_phone_number) || ""))) p.push("a call button needs the number's country (a two-letter country code: Meta refuses the page without one)");
  }
  if ("whatsapp" in opts) p.push(...whatsappProblems(spec, opts.whatsapp));
  if (spec?.question_page_custom_headline && String(spec.question_page_custom_headline).length > L.headline) p.push(`the headline is over ${L.headline} characters`);
  if (spec?.follow_up_action_url && !/^https?:\/\/\S+$/i.test(String(spec.follow_up_action_url))) p.push("the follow-up address must be a web address");
  return p;
}

/** The POST body: only what Meta takes, nothing empty. */
export function createPayload(spec) {
  const body = { name: String(spec.name).trim(), questions: spec.questions.map(questionSpec), privacy_policy: spec.privacy_policy };
  if (spec.locale) body.locale = spec.locale;
  if (spec.context_card) body.context_card = spec.context_card;
  if (spec.thank_you_page) body.thank_you_page = { ...spec.thank_you_page, ...(["CALL_BUSINESS", "WHATSAPP"].includes(spec.thank_you_page.button_type) && spec.thank_you_page.business_phone_number ? { country_code: spec.thank_you_page.country_code || countryCodeFor(spec.thank_you_page.business_phone_number) } : {}) };
  if (spec.follow_up_action_url) body.follow_up_action_url = spec.follow_up_action_url;
  if (spec.question_page_custom_headline) body.question_page_custom_headline = spec.question_page_custom_headline;
  if (spec.block_display_for_non_targeted_viewer != null) body.block_display_for_non_targeted_viewer = !!spec.block_display_for_non_targeted_viewer;
  if (spec.is_optimized_for_quality != null) body.is_optimized_for_quality = !!spec.is_optimized_for_quality;
  if (spec.allow_organic_lead != null) body.allow_organic_lead = !!spec.allow_organic_lead;
  return body;
}

/** Create the form on the Page (the owner's action) and record it. Refuses a spec with problems before any call. */
export async function createForm(client, pageId, spec, { gymDir = null, offer = null, templateId = null, now = new Date(), ...opts } = {}) {
  const problems = formProblems(spec, "whatsapp" in opts ? { whatsapp: opts.whatsapp } : {});
  if (problems.length) throw new Error(`the form is not ready: ${problems.join("; ")}`);
  const r = await client.createLeadForm(pageId, createPayload(spec));
  if (!r?.id) throw new Error("Meta answered without a form id");
  const made = { id: String(r.id), name: spec.name, created: now.toISOString(), page_id: String(pageId), offer: offer || null, from_template: templateId || null, questions: spec.questions.length,
    // What the thank-you button is, and for a WhatsApp button the number sent with it (the owner's check of it in Ads Manager is kept beside it later).
    button: spec.thank_you_page?.button_type || null, ...(isWhatsapp(spec) ? { whatsapp: normPhone(spec.thank_you_page.business_phone_number) } : {}) };
  if (gymDir) { const data = readLeadForms(gymDir); data.created = [made, ...(data.created || [])]; writeLeadForms(gymDir, data); }
  return made;
}
