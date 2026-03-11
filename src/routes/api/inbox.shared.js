import { deepFix, fixText } from "../../utils/textFix.js";

export function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function s(v) {
  return String(v ?? "").trim();
}

export function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

function toMs(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function asObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? deepFix(x) : {};
}

function asStringArray(x) {
  return Array.isArray(x)
    ? x.map((v) => fixText(String(v))).filter(Boolean)
    : [];
}

function splitSummaryToList(text) {
  return fixText(text || "")
    .split(/[,;\n]/g)
    .map((x) => fixText(x))
    .filter(Boolean);
}

export function sortMessagesChronologically(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort(
    (a, b) => toMs(a?.sent_at || a?.created_at) - toMs(b?.sent_at || b?.created_at)
  );
}

export function normalizeThread(row) {
  if (!row) return row;

  const meta = asObject(row.meta);
  const handoffMeta = asObject(meta.handoff);

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    channel: fixText(row.channel || ""),
    external_thread_id: fixText(row.external_thread_id || ""),
    external_user_id: fixText(row.external_user_id || ""),
    external_username: fixText(row.external_username || ""),
    customer_name: fixText(row.customer_name || ""),
    status: fixText(row.status || ""),
    assigned_to: fixText(row.assigned_to || ""),
    labels: Array.isArray(row.labels)
      ? row.labels.map((x) => fixText(String(x))).filter(Boolean)
      : [],
    meta,

    handoff_active:
      typeof row.handoff_active === "boolean"
        ? row.handoff_active
        : Boolean(handoffMeta.active),

    handoff_reason: fixText(row.handoff_reason || handoffMeta.reason || ""),
    handoff_priority: fixText(row.handoff_priority || handoffMeta.priority || "normal"),
    handoff_at: row.handoff_at || handoffMeta.at || null,
    handoff_by: fixText(row.handoff_by || handoffMeta.by || ""),
  };
}

export function normalizeMessage(row) {
  if (!row) return row;

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    direction: fixText(row.direction || ""),
    sender_type: fixText(row.sender_type || ""),
    external_message_id: fixText(row.external_message_id || ""),
    message_type: fixText(row.message_type || ""),
    text: fixText(row.text || ""),
    attachments: Array.isArray(row.attachments) ? deepFix(row.attachments) : [],
    meta: asObject(row.meta),
  };
}

export function normalizeLead(row) {
  if (!row) return row;

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    source: fixText(row.source || ""),
    source_ref: fixText(row.source_ref || ""),
    full_name: fixText(row.full_name || ""),
    username: fixText(row.username || ""),
    company: fixText(row.company || ""),
    phone: fixText(row.phone || ""),
    email: fixText(row.email || ""),
    interest: fixText(row.interest || ""),
    notes: fixText(row.notes || ""),
    stage: fixText(row.stage || ""),
    status: fixText(row.status || ""),
    owner: fixText(row.owner || ""),
    priority: fixText(row.priority || ""),
    next_action: fixText(row.next_action || ""),
    won_reason: fixText(row.won_reason || ""),
    lost_reason: fixText(row.lost_reason || ""),
    extra: asObject(row.extra),
  };
}

export function normalizeTenant(row) {
  if (!row) return null;

  const communicationRules = asObject(row.communication_rules);
  const visualStyle = asObject(row.visual_style);
  const extraContext = asObject(row.extra_context);

  const quietHours = asObject(row.quiet_hours);
  const inboxPolicy = asObject(row.inbox_policy);
  const commentPolicy = asObject(row.comment_policy);
  const contentPolicy = asObject(row.content_policy);
  const escalationRules = asObject(row.escalation_rules);
  const riskRules = asObject(row.risk_rules);
  const leadScoringRules = asObject(row.lead_scoring_rules);
  const publishPolicy = asObject(row.publish_policy);

  const supportedLanguages = asStringArray(row.supported_languages);
  const bannedPhrases = asStringArray(row.banned_phrases);

  const brandName = fixText(row.brand_name || row.company_name || "");
  const servicesList = splitSummaryToList(row.services_summary);
  const audienceSummary = fixText(row.audience_summary || "");
  const servicesSummary = fixText(row.services_summary || "");
  const valueProposition = fixText(row.value_proposition || "");
  const brandSummary = fixText(row.brand_summary || "");
  const toneOfVoice = fixText(row.tone_of_voice || "professional");
  const preferredCta = fixText(row.preferred_cta || "");
  const timezone = fixText(row.timezone || "Asia/Baku");
  const defaultLanguage = fixText(row.default_language || "en");
  const industryKey = fixText(row.industry_key || "generic_business");

  return {
    id: row.id || null,
    tenant_id: row.id || null,
    tenant_key: fixText(row.tenant_key || ""),

    company_name: fixText(row.company_name || ""),
    legal_name: fixText(row.legal_name || ""),
    industry_key: industryKey,
    country_code: fixText(row.country_code || ""),
    timezone,
    default_language: defaultLanguage,
    supported_languages: supportedLanguages,
    market_region: fixText(row.market_region || ""),
    plan_key: fixText(row.plan_key || ""),
    status: fixText(row.status || ""),
    active: row.active !== false,
    onboarding_completed_at: row.onboarding_completed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,

    profile: {
      brand_name: brandName,
      website_url: fixText(row.website_url || ""),
      public_email: fixText(row.public_email || ""),
      public_phone: fixText(row.public_phone || ""),
      audience_summary: audienceSummary,
      services_summary: servicesSummary,
      value_proposition: valueProposition,
      brand_summary: brandSummary,
      tone_of_voice: toneOfVoice,
      preferred_cta: preferredCta,
      banned_phrases: bannedPhrases,
      communication_rules: communicationRules,
      visual_style: visualStyle,
      extra_context: extraContext,
    },

    ai_policy: {
      auto_reply_enabled:
        typeof row.auto_reply_enabled === "boolean" ? row.auto_reply_enabled : true,
      suppress_ai_during_handoff:
        typeof row.suppress_ai_during_handoff === "boolean"
          ? row.suppress_ai_during_handoff
          : true,
      mark_seen_enabled:
        typeof row.mark_seen_enabled === "boolean" ? row.mark_seen_enabled : true,
      typing_indicator_enabled:
        typeof row.typing_indicator_enabled === "boolean"
          ? row.typing_indicator_enabled
          : true,
      create_lead_enabled:
        typeof row.create_lead_enabled === "boolean" ? row.create_lead_enabled : true,
      approval_required_content:
        typeof row.approval_required_content === "boolean"
          ? row.approval_required_content
          : true,
      approval_required_publish:
        typeof row.approval_required_publish === "boolean"
          ? row.approval_required_publish
          : true,
      quiet_hours_enabled:
        typeof row.quiet_hours_enabled === "boolean" ? row.quiet_hours_enabled : false,
      quiet_hours: quietHours,
      inbox_policy: inboxPolicy,
      comment_policy: commentPolicy,
      content_policy: contentPolicy,
      escalation_rules: escalationRules,
      risk_rules: riskRules,
      lead_scoring_rules: leadScoringRules,
      publish_policy: publishPolicy,
    },

    brand: {
      displayName: brandName,
      name: brandName,
      email: fixText(row.public_email || ""),
      phone: fixText(row.public_phone || ""),
      website: fixText(row.website_url || ""),
      tone: toneOfVoice,
    },

    meta: {
      industry: industryKey,
      businessSummary: brandSummary || valueProposition,
      audienceSummary,
      servicesSummary,
      services: servicesList,
      valueProposition,
      tone: toneOfVoice,
      preferredCta,
      bannedPhrases,
      communicationRules,
      visualStyle,
      extraContext,
      languages: supportedLanguages.length ? supportedLanguages : [defaultLanguage],
    },

    inbox_policy: inboxPolicy,
    comment_policy: commentPolicy,
    content_policy: contentPolicy,
    quiet_hours: quietHours,
    escalation_rules: escalationRules,
    risk_rules: riskRules,
    lead_scoring_rules: leadScoringRules,
    publish_policy: publishPolicy,
  };
}