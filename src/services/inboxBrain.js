// src/services/inboxBrain.js
// FINAL v6.1 — fully multi-tenant + schema-aware + niche-aware + product-grade inbox decisioning

import OpenAI from "openai";
import { cfg } from "../config.js";
import { getDefaultTenantKey, resolveTenantKey } from "../tenancy/index.js";
import { getInboxPolicy, isPolicyQuietHours } from "./inboxPolicy.js";

function s(v) {
  return String(v ?? "").trim();
}

function lower(v) {
  return s(v).toLowerCase();
}

function includesAny(text, words = []) {
  return words.some((w) => text.includes(lower(w)));
}

function pickString(x) {
  return typeof x === "string" ? x : "";
}

function pickStringDeep(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    if (typeof x.value === "string") return x.value;
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

function nowMs() {
  return Date.now();
}

function toMs(v) {
  if (!v) return 0;

  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;

  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function uniqStrings(list = []) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(list) ? list : []) {
    const x = s(item);
    if (!x) continue;
    const k = lower(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }

  return out;
}

function safeObj(v, fallback = {}) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
}

function safeArr(v, fallback = []) {
  return Array.isArray(v) ? v : fallback;
}

function fixMojibake(input) {
  const t = String(input || "");
  if (!t) return t;

  if (!/[ÃÂ]|â€™|â€œ|â€�|â€“|â€”|â€¦/.test(t)) return t;

  try {
    const fixed = Buffer.from(t, "latin1").toString("utf8");
    if (/[�]/.test(fixed) && !/[�]/.test(t)) return t;
    return fixed;
  } catch {
    return t;
  }
}

function extractText(resp) {
  if (!resp) return "";

  const direct = pickString(resp.output_text).trim();
  if (direct) return fixMojibake(direct);

  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];

    for (const item of out) {
      const content = item?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "output_text") {
            const t = pickStringDeep(block?.text);
            if (t) parts.push(t);
            continue;
          }

          const t1 = pickStringDeep(block?.text);
          if (t1) parts.push(t1);

          const t2 = pickStringDeep(block?.transcript);
          if (t2) parts.push(t2);
        }
      } else if (typeof content === "string") {
        parts.push(content);
      }

      const tItem = pickStringDeep(item?.text);
      if (tItem) parts.push(tItem);
    }

    const joined = parts.join("\n").trim();
    if (joined) return fixMojibake(joined);
  }

  return "";
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const fenced =
    raw.match(/```json\s*([\s\S]*?)```/i) ||
    raw.match(/```\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}

function getResolvedTenantKey(tenantKey) {
  return resolveTenantKey(tenantKey, getDefaultTenantKey());
}

function getThreadHandoffState(thread) {
  const metaHandoff =
    thread?.meta && typeof thread.meta === "object" && thread.meta.handoff
      ? thread.meta.handoff
      : null;

  const active = Boolean(thread?.handoff_active) || Boolean(metaHandoff?.active);

  return {
    active,
    reason: s(thread?.handoff_reason || metaHandoff?.reason || ""),
    priority: s(thread?.handoff_priority || metaHandoff?.priority || "normal") || "normal",
  };
}

function normalizeRecentMessages(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((m) => ({
      id: s(m?.id),
      direction: lower(m?.direction),
      sender_type: lower(m?.sender_type),
      text: fixMojibake(s(m?.text)),
      sent_at: m?.sent_at || null,
      created_at: m?.created_at || null,
      meta: safeObj(m?.meta),
    }))
    .filter((m) => m.id || m.text)
    .sort((a, b) => toMs(a.sent_at || a.created_at) - toMs(b.sent_at || b.created_at));
}

function getLatestOutbound(messages) {
  const list = normalizeRecentMessages(messages);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.direction === "outbound") return m;
  }
  return null;
}

function getLatestOperatorOutbound(messages) {
  const list = normalizeRecentMessages(messages);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.direction === "outbound" && (m.sender_type === "agent" || m.sender_type === "operator")) {
      return m;
    }
  }
  return null;
}

function getLastAiOutbound(messages) {
  const list = normalizeRecentMessages(messages);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.direction === "outbound" && (m.sender_type === "ai" || m.sender_type === "assistant")) {
      return m;
    }
  }
  return null;
}

function isAckOnlyText(text) {
  const incoming = lower(text);
  if (!incoming) return false;

  return (
    includesAny(incoming, [
      "👍",
      "👌",
      "ok",
      "oks",
      "okay",
      "thanks",
      "thank you",
      "təşəkkür",
      "tesekkur",
      "sağ ol",
      "sag ol",
      "super",
      "əla",
      "ela",
      "got it",
      "anladım",
      "anladim",
    ]) &&
    incoming.length <= 24
  );
}

function buildHistorySnippet(messages = [], limit = 6) {
  const list = normalizeRecentMessages(messages).slice(-limit);

  return list
    .map((m) => {
      const who =
        m.direction === "inbound"
          ? "customer"
          : m.sender_type === "agent" || m.sender_type === "operator"
            ? "operator"
            : "ai";
      return `${who}: ${s(m.text).slice(0, 320)}`;
    })
    .join("\n");
}

function buildMeta({ tenantKey, thread, message, intent, score = 0, extra = {} }) {
  return {
    tenantKey: getResolvedTenantKey(tenantKey),
    threadId: s(thread?.id),
    messageId: s(message?.id),
    intent: s(intent || "general"),
    score: Number(score || 0),
    handoffActive: Boolean(thread?.handoff_active),
    ...extra,
  };
}

function sendMessageAction({ channel, recipientId, text, meta }) {
  return {
    type: "send_message",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    recipientId: s(recipientId),
    text: s(text),
    meta: meta || {},
  };
}

function createLeadAction({ channel, externalUserId, thread, text, intent, meta }) {
  return {
    type: "create_lead",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    externalUserId: s(externalUserId),
    threadId: s(thread?.id),
    lead: {
      source: "meta",
      channel: s(channel || "instagram").toLowerCase() || "instagram",
      externalUserId: s(externalUserId),
      threadId: s(thread?.id),
      summary: s(text).slice(0, 500),
      intent: s(intent || "general"),
    },
    meta: meta || {},
  };
}

function handoffAction({ channel, externalUserId, thread, reason, priority = "normal", meta }) {
  return {
    type: "handoff",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    externalUserId: s(externalUserId),
    threadId: s(thread?.id),
    reason: s(reason || "manual_review"),
    priority: s(priority || "normal"),
    meta: meta || {},
  };
}

function noReplyAction({ reason, meta }) {
  return {
    type: "no_reply",
    reason: s(reason || "rule_suppressed"),
    meta: meta || {},
  };
}

function markSeenAction({ channel, recipientId, meta }) {
  return {
    type: "mark_seen",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    recipientId: s(recipientId),
    meta: meta || {},
  };
}

function typingOnAction({ channel, recipientId, meta }) {
  return {
    type: "typing_on",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    recipientId: s(recipientId),
    meta: meta || {},
  };
}

function typingOffAction({ channel, recipientId, meta }) {
  return {
    type: "typing_off",
    channel: s(channel || "instagram").toLowerCase() || "instagram",
    recipientId: s(recipientId),
    meta: meta || {},
  };
}

let openaiSingleton = null;

function ensureOpenAI() {
  const key = s(cfg.OPENAI_API_KEY || "");
  if (!key) return null;

  if (!openaiSingleton) {
    openaiSingleton = new OpenAI({ apiKey: key });
  }

  return openaiSingleton;
}

function getReliabilityFlags({ text, thread, recentMessages = [], quietHoursApplied, policy }) {
  const list = normalizeRecentMessages(recentMessages);
  const latestOutbound = getLatestOutbound(list);
  const lastOperatorOutbound = getLatestOperatorOutbound(list);
  const lastAiOutbound = getLastAiOutbound(list);

  const now = nowMs();
  const cooldownMs = Math.max(0, Number(cfg.INBOX_REPLY_COOLDOWN_MS || 45000));
  const operatorCooldownMs = Math.max(0, Number(cfg.INBOX_OPERATOR_REPLY_SUPPRESS_MS || 300000));

  const latestOutboundAgeMs = latestOutbound
    ? Math.max(0, now - toMs(latestOutbound.sent_at || latestOutbound.created_at))
    : null;

  const operatorOutboundAgeMs = lastOperatorOutbound
    ? Math.max(0, now - toMs(lastOperatorOutbound.sent_at || lastOperatorOutbound.created_at))
    : null;

  const duplicateOfLastAiReply =
    Boolean(lastAiOutbound?.text) &&
    lower(lastAiOutbound.text) === lower(text);

  const recentOutboundCooldownActive =
    latestOutboundAgeMs !== null && latestOutboundAgeMs < cooldownMs;

  const operatorRecentlyReplied =
    operatorOutboundAgeMs !== null && operatorOutboundAgeMs < operatorCooldownMs;

  const closedLike = thread?.status === "closed" || thread?.status === "spam";

  return {
    recentOutboundCooldownActive,
    latestOutboundAgeMs,
    operatorRecentlyReplied,
    operatorOutboundAgeMs,
    duplicateOfLastAiReply,
    quietHoursApplied: Boolean(quietHoursApplied),
    channelAllowed: Boolean(policy?.channelAllowed),
    closedLike,
  };
}

/* ============================================================
 * tenant business profile
 * ============================================================ */

function normalizeIndustry(v) {
  const x = lower(v);
  if (!x) return "generic_business";

  const aliases = {
    clinic: "clinic",
    dental: "clinic",
    dentist: "clinic",
    hospital: "clinic",
    health: "clinic",
    healthcare: "clinic",

    hotel: "hospitality",
    hospitality: "hospitality",
    travel: "hospitality",

    restaurant: "restaurant",
    cafe: "restaurant",
    coffee: "restaurant",
    food: "restaurant",

    retail: "retail",
    store: "retail",
    shop: "retail",

    ecommerce: "ecommerce",
    "e-commerce": "ecommerce",

    legal: "legal",
    law: "legal",

    finance: "finance",
    fintech: "finance",
    insurance: "finance",

    education: "education",
    school: "education",
    academy: "education",
    course: "education",

    technology: "technology",
    tech: "technology",
    saas: "technology",
    software: "technology",
    ai: "technology",

    automotive: "automotive",
    auto: "automotive",
    car: "automotive",

    logistics: "logistics",
    transport: "logistics",
    cargo: "logistics",

    real_estate: "real_estate",
    realestate: "real_estate",
    property: "real_estate",

    beauty: "beauty",
    salon: "beauty",
    spa: "beauty",
    cosmetics: "beauty",

    creative_agency: "creative_agency",
    agency: "creative_agency",
    marketing: "creative_agency",
    branding: "creative_agency",

    generic: "generic_business",
    generic_business: "generic_business",
  };

  return aliases[x] || x || "generic_business";
}

function getTenantBrandName(tenant, tenantKey) {
  const profile = safeObj(tenant?.profile);
  const brand = safeObj(tenant?.brand);

  return (
    s(profile?.brand_name) ||
    s(profile?.brandName) ||
    s(brand?.displayName) ||
    s(brand?.name) ||
    s(tenant?.company_name) ||
    s(tenant?.name) ||
    getResolvedTenantKey(tenantKey)
  );
}

function getTenantBusinessProfile(tenant, tenantKey) {
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);

  const profile = safeObj(tenant?.profile);
  const brand = safeObj(tenant?.brand);
  const meta = safeObj(tenant?.meta);
  const aiPolicy = safeObj(tenant?.ai_policy);
  const inboxPolicy = safeObj(tenant?.inbox_policy);
  const features = safeObj(tenant?.features);

  const displayName =
    s(profile?.brand_name) ||
    s(profile?.brandName) ||
    s(brand?.displayName) ||
    s(brand?.name) ||
    s(tenant?.company_name) ||
    s(tenant?.name) ||
    resolvedTenantKey;

  const industry =
    normalizeIndustry(
      profile?.industry_key ||
        tenant?.industry_key ||
        meta?.industry ||
        brand?.industry ||
        features?.industry ||
        "generic_business"
    );

  const businessSummary =
    s(profile?.brand_summary) ||
    s(profile?.services_summary) ||
    s(profile?.value_proposition) ||
    s(meta?.businessSummary) ||
    s(meta?.business_description) ||
    s(meta?.about) ||
    s(brand?.tagline) ||
    "";

  const services = uniqStrings(
    safeArr(profile?.services).length
      ? profile.services
      : safeArr(meta?.services).length
        ? meta.services
        : safeArr(meta?.products).length
          ? meta.products
          : safeArr(meta?.categories).length
            ? meta.categories
            : []
  );

  const languages = uniqStrings(
    safeArr(tenant?.supported_languages).length
      ? tenant.supported_languages
      : safeArr(tenant?.enabled_languages).length
        ? tenant.enabled_languages
        : safeArr(profile?.languages).length
          ? profile.languages
          : safeArr(meta?.languages).length
            ? meta.languages
            : safeArr(brand?.languages).length
              ? brand.languages
              : [s(tenant?.default_language || "en"), "en"]
  );

  const communicationRules = safeObj(profile?.communication_rules);
  const tone =
    s(profile?.tone_of_voice) ||
    s(communicationRules?.tone) ||
    s(meta?.tone) ||
    s(brand?.tone) ||
    "professional, warm, concise";

  const maxSentences = Math.max(
    1,
    Math.min(
      3,
      Number(
        communicationRules?.maxSentences ||
          meta?.replyMaxSentences ||
          2
      )
    )
  );

  const leadPrompts = uniqStrings(
    safeArr(meta?.leadPrompts).length
      ? meta.leadPrompts
      : [
          "Qısa olaraq sizə hansı xidmət və ya məhsul lazım olduğunu yazın.",
          "Uyğun yönləndirmə üçün ehtiyacınızı qısa qeyd edin.",
        ]
  );

  const forbiddenClaims = uniqStrings(
    safeArr(profile?.banned_phrases).length
      ? profile.banned_phrases
      : safeArr(meta?.forbiddenClaims).length
        ? meta.forbiddenClaims
        : [
            "Do not invent prices.",
            "Do not promise unavailable features.",
            "Do not guarantee timelines unless known.",
          ]
  );

  const urgentKeywords = uniqStrings(
    safeArr(inboxPolicy?.urgentKeywords).length
      ? inboxPolicy.urgentKeywords
      : safeArr(meta?.urgentKeywords).length
        ? meta.urgentKeywords
        : ["urgent", "təcili", "tecili", "asap", "today", "indi", "hemen"]
  );

  const pricingKeywords = uniqStrings(
    safeArr(inboxPolicy?.pricingKeywords).length
      ? inboxPolicy.pricingKeywords
      : safeArr(meta?.pricingKeywords).length
        ? meta.pricingKeywords
        : ["qiymət", "qiymet", "price", "cost", "tarif", "paket", "neçəyə", "neceye"]
  );

  const humanKeywords = uniqStrings(
    safeArr(inboxPolicy?.humanKeywords).length
      ? inboxPolicy.humanKeywords
      : safeArr(meta?.humanKeywords).length
        ? meta.humanKeywords
        : []
  );

  const supportKeywords = uniqStrings(
    safeArr(inboxPolicy?.supportKeywords).length
      ? inboxPolicy.supportKeywords
      : safeArr(meta?.supportKeywords).length
        ? meta.supportKeywords
        : ["problem", "issue", "dəstək", "destek", "support", "help", "kömək", "komek"]
  );

  return {
    tenantKey: resolvedTenantKey,
    displayName,
    industry,
    businessSummary,
    services,
    languages,
    tone,
    maxSentences,
    leadPrompts,
    forbiddenClaims,
    urgentKeywords,
    pricingKeywords,
    humanKeywords,
    supportKeywords,
    aiPolicy,
    profile,
  };
}

function buildServiceLine(profile) {
  const services = uniqStrings(profile?.services || []);
  if (!services.length) return "";
  return services.slice(0, 12).join(", ");
}

function pickLeadPrompt(profile) {
  const list = safeArr(profile?.leadPrompts);
  return s(list[0] || "Qısa olaraq ehtiyacınızı yazın.");
}

function getIndustryHints(industry) {
  const x = normalizeIndustry(industry);

  const map = {
    clinic: {
      keywords: ["müayinə", "muayine", "implant", "ortodont", "dental", "clinic", "appointment", "randevu"],
      pricingHint: "Qiymət xidmət növü və vəziyyətə görə dəyişə bilər.",
    },
    hospitality: {
      keywords: ["reservation", "booking", "otaq", "room", "hotel", "stay"],
      pricingHint: "Qiymət tarix və xidmət paketinə görə dəyişə bilər.",
    },
    restaurant: {
      keywords: ["menu", "booking", "masa", "rezerv", "delivery", "restaurant"],
      pricingHint: "Qiymət məhsul və sifariş tərkibinə görə dəyişə bilər.",
    },
    legal: {
      keywords: ["məsləhət", "meslehet", "consultation", "law", "legal", "müqavilə", "muqavile", "court"],
      pricingHint: "Qiymət işin növü və mürəkkəbliyinə görə dəyişə bilər.",
    },
    finance: {
      keywords: ["loan", "credit", "investment", "insurance", "finance"],
      pricingHint: "Qiymət və komissiya xidmət növündən asılıdır.",
    },
    education: {
      keywords: ["course", "dərs", "ders", "training", "education", "program"],
      pricingHint: "Qiymət proqram və formatdan asılıdır.",
    },
    ecommerce: {
      keywords: ["product", "məhsul", "mehsul", "shipping", "çatdırılma", "catdirilma", "order"],
      pricingHint: "Qiymət məhsul və çatdırılma şərtlərinə görə dəyişə bilər.",
    },
    technology: {
      keywords: ["software", "saas", "app", "integration", "automation", "website"],
      pricingHint: "Qiymət scope və funksionallığa görə dəyişə bilər.",
    },
    creative_agency: {
      keywords: ["branding", "design", "creative", "smm", "content", "campaign"],
      pricingHint: "Qiymət görüləcək işin həcminə görə dəyişə bilər.",
    },
    generic_business: {
      keywords: [],
      pricingHint: "Qiymət xidmət və ya məhsulun növünə görə dəyişə bilər.",
    },
  };

  return map[x] || map.generic_business;
}

function classifyTenantAwareIntent(text, profile, policy) {
  const incoming = lower(text);
  const servicesLine = lower(buildServiceLine(profile));
  const industryHints = getIndustryHints(profile?.industry);

  if (includesAny(incoming, policy?.humanKeywords || [])) {
    return { intent: "handoff_request", score: 92 };
  }

  if (includesAny(incoming, profile?.humanKeywords || [])) {
    return { intent: "handoff_request", score: 92 };
  }

  if (includesAny(incoming, profile?.urgentKeywords || [])) {
    return { intent: "urgent_interest", score: 94 };
  }

  if (includesAny(incoming, profile?.pricingKeywords || [])) {
    return { intent: "pricing", score: 84 };
  }

  if (
    includesAny(incoming, [
      "salam",
      "sabahınız",
      "sabahiniz",
      "hello",
      "hi",
      "good morning",
      "good evening",
      "selam",
      "salamlar",
    ])
  ) {
    return { intent: "greeting", score: 18 };
  }

  if (includesAny(incoming, profile?.supportKeywords || [])) {
    return { intent: "support", score: 58 };
  }

  if (
    servicesLine &&
    includesAny(
      incoming,
      servicesLine
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ) {
    return { intent: "service_interest", score: 74 };
  }

  if (includesAny(incoming, industryHints.keywords || [])) {
    return { intent: "service_interest", score: 70 };
  }

  if (
    includesAny(incoming, [
      "istəyirəm",
      "isteyirem",
      "lazımdır",
      "lazimdir",
      "lazımdı",
      "proposal",
      "brief",
      "təklif",
      "teklif",
      "maraqlanıram",
      "maraqlaniram",
      "need",
      "want",
      "interested",
    ])
  ) {
    return { intent: "service_interest", score: 66 };
  }

  return { intent: "general", score: 28 };
}

async function aiDecideInbox({
  text,
  channel,
  externalUserId,
  tenantKey,
  thread,
  message,
  tenant = null,
  policy,
  quietHoursApplied,
  recentMessages = [],
  reliability = {},
}) {
  const openai = ensureOpenAI();
  if (!openai) return null;

  const model = s(cfg.OPENAI_MODEL || "gpt-5") || "gpt-5";
  const max_output_tokens = Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 800);
  const historySnippet = buildHistorySnippet(recentMessages, 6);

  const profile = getTenantBusinessProfile(tenant, tenantKey);
  const servicesLine = buildServiceLine(profile);
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);

  const prompt = `
You are an AI inbox copilot for a business.

Return ONLY valid JSON.

Business profile:
- brandName: ${JSON.stringify(profile.displayName)}
- tenantKey: ${JSON.stringify(resolvedTenantKey)}
- industry: ${JSON.stringify(profile.industry)}
- businessSummary: ${JSON.stringify(profile.businessSummary || "")}
- services: ${JSON.stringify(profile.services)}
- languages: ${JSON.stringify(profile.languages)}
- tone: ${JSON.stringify(profile.tone)}
- maxSentences: ${profile.maxSentences}
- leadPrompts: ${JSON.stringify(profile.leadPrompts)}
- forbiddenClaims: ${JSON.stringify(profile.forbiddenClaims)}

Operational rules:
- Match the customer's language when possible.
- Be concise, natural, and human-like.
- Never invent prices, availability, timelines, medical/legal/financial guarantees, or unsupported claims.
- If user asks pricing, ask for the needed service/product details briefly.
- If user explicitly wants a human/operator, set handoff=true.
- If user clearly shows business intent, createLead should usually be true.
- If message is only acknowledgment like "ok", "thanks", "👍", then noReply=true.
- If operator recently replied, prefer noReply=true unless customer is clearly asking something new and urgent.
- Avoid repeating the same reply again.
- If quiet hours are active, noReply may be true.
- replyText must stay short, max ${profile.maxSentences} sentences.
- Return only JSON.

Allowed intents:
["general","greeting","pricing","service_interest","handoff_request","support","ack","urgent_interest","other"]

Return JSON exactly:
{
  "intent": "general",
  "replyText": "",
  "leadScore": 0,
  "createLead": false,
  "handoff": false,
  "handoffReason": "",
  "handoffPriority": "normal",
  "noReply": false
}

Rules:
- leadScore must be integer 0-100
- handoffPriority must be one of: "low", "normal", "high", "urgent"
- if noReply=true then replyText should be ""
- if handoff=true then handoffReason must be filled

Context:
channel=${JSON.stringify(s(channel || "instagram"))}
externalUserId=${JSON.stringify(s(externalUserId || ""))}
threadId=${JSON.stringify(s(thread?.id || ""))}
messageId=${JSON.stringify(s(message?.id || ""))}
threadStatus=${JSON.stringify(s(thread?.status || "open"))}
quietHoursApplied=${quietHoursApplied ? "true" : "false"}
policy.autoReplyEnabled=${Boolean(policy?.autoReplyEnabled)}
policy.createLeadEnabled=${Boolean(policy?.createLeadEnabled)}
policy.handoffEnabled=${Boolean(policy?.handoffEnabled)}
recentOutboundCooldownActive=${Boolean(reliability?.recentOutboundCooldownActive)}
operatorRecentlyReplied=${Boolean(reliability?.operatorRecentlyReplied)}
duplicateOfLastAiReply=${Boolean(reliability?.duplicateOfLastAiReply)}
servicesLine=${JSON.stringify(servicesLine)}

Recent thread history:
${historySnippet || "(empty)"}

Incoming message:
${JSON.stringify(String(text || ""))}
  `.trim();

  try {
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens,
      input: [
        {
          role: "system",
          content:
            "You are a strict JSON generator for business inbox decisioning. Return only valid JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const raw = extractText(resp);
    const parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const intent = s(parsed.intent || "general") || "general";
    const replyText = fixMojibake(s(parsed.replyText || ""));
    const leadScore = Math.max(0, Math.min(100, Math.round(Number(parsed.leadScore || 0))));
    const createLead = Boolean(parsed.createLead);
    const handoff = Boolean(parsed.handoff);
    const handoffReason = s(parsed.handoffReason || "");
    const hp = s(parsed.handoffPriority || "normal").toLowerCase();
    const handoffPriority = ["low", "normal", "high", "urgent"].includes(hp) ? hp : "normal";
    const noReply = Boolean(parsed.noReply);

    return {
      intent,
      replyText,
      leadScore,
      createLead,
      handoff,
      handoffReason,
      handoffPriority,
      noReply,
      raw,
      profile,
    };
  } catch {
    return null;
  }
}

function buildFallbackReply({ intent, profile }) {
  const brandName = s(profile?.displayName || "Brand");
  const leadPrompt = pickLeadPrompt(profile);
  const serviceLine = buildServiceLine(profile);
  const industryHints = getIndustryHints(profile?.industry);

  if (intent === "greeting") {
    if (serviceLine) {
      return `${brandName}-a xoş gəlmisiniz. ${serviceLine} üzrə kömək edə bilərik. ${leadPrompt}`;
    }
    return `${brandName}-a xoş gəlmisiniz. Sizə məmnuniyyətlə kömək edəcəyik. ${leadPrompt}`;
  }

  if (intent === "pricing") {
    return `${industryHints.pricingHint} ${leadPrompt}`;
  }

  if (intent === "service_interest") {
    if (serviceLine) {
      return `${brandName} bu istiqamətdə kömək edə bilər. ${leadPrompt}`;
    }
    return `${brandName} bu mövzuda kömək edə bilər. ${leadPrompt}`;
  }

  if (intent === "support") {
    return "Məmnuniyyətlə kömək edək. Problemi və ya ehtiyacınızı qısa şəkildə yazın.";
  }

  if (intent === "handoff_request") {
    return "Qeyd etdik. Komandamızın daha uyğun yönləndirməsi üçün ehtiyacınızı qısa yazın.";
  }

  if (intent === "urgent_interest") {
    return "Qeyd etdik. Müraciətinizi daha düzgün yönləndirmək üçün ehtiyacınızı qısa yazın.";
  }

  return `${brandName} sizə kömək etməyə hazırdır. ${leadPrompt}`;
}

function buildInboxActionsFallback({
  text,
  channel,
  externalUserId,
  tenantKey,
  thread,
  message,
  tenant = null,
  policy,
  quietHoursApplied,
  recentMessages = [],
  reliability = {},
}) {
  const actions = [];
  const profile = getTenantBusinessProfile(tenant, tenantKey);
  const classified = classifyTenantAwareIntent(text, profile, policy);

  let intent = classified.intent;
  let leadScore = classified.score;
  let replyText = buildFallbackReply({ intent, profile });

  let shouldCreateLead = ["pricing", "service_interest", "handoff_request", "urgent_interest"].includes(intent);
  let shouldHandoff = intent === "handoff_request" || intent === "urgent_interest";
  let shouldReply = Boolean(policy.autoReplyEnabled);
  let shouldMarkSeen = Boolean(policy.markSeenEnabled);
  let shouldTyping = Boolean(policy.typingIndicatorEnabled);

  let handoffReason = "";
  let handoffPriority = "normal";

  if (intent === "handoff_request") {
    handoffReason = "user_requested_human";
    handoffPriority = "high";
  }

  if (intent === "urgent_interest") {
    handoffReason = "urgent_request";
    handoffPriority = "high";
    leadScore = Math.max(leadScore, 92);
  }

  if (quietHoursApplied) {
    shouldReply = false;
    shouldTyping = false;
  }

  if (reliability?.recentOutboundCooldownActive) {
    shouldReply = false;
    shouldTyping = false;
  }

  if (reliability?.operatorRecentlyReplied) {
    shouldReply = false;
    shouldTyping = false;
  }

  if (reliability?.duplicateOfLastAiReply) {
    shouldReply = false;
    shouldTyping = false;
  }

  if (!policy.createLeadEnabled) shouldCreateLead = false;
  if (!policy.handoffEnabled) shouldHandoff = false;

  const commonMeta = buildMeta({
    tenantKey,
    thread,
    message,
    intent,
    score: leadScore,
    extra: {
      quietHoursApplied,
      recentMessageCount: normalizeRecentMessages(recentMessages).length,
      policyAutoReplyEnabled: Boolean(policy.autoReplyEnabled),
      policyCreateLeadEnabled: Boolean(policy.createLeadEnabled),
      policyHandoffEnabled: Boolean(policy.handoffEnabled),
      policyMarkSeenEnabled: Boolean(policy.markSeenEnabled),
      policyTypingIndicatorEnabled: Boolean(policy.typingIndicatorEnabled),
      policySuppressAiDuringHandoff: Boolean(policy.suppressAiDuringHandoff),
      timezone: s(policy.timezone || "Asia/Baku"),
      engine: "fallback",
      brandName: profile.displayName,
      industry: profile.industry,
      services: profile.services,
      recentOutboundCooldownActive: Boolean(reliability?.recentOutboundCooldownActive),
      operatorRecentlyReplied: Boolean(reliability?.operatorRecentlyReplied),
      duplicateOfLastAiReply: Boolean(reliability?.duplicateOfLastAiReply),
    },
  });

  if (shouldMarkSeen) {
    actions.push(markSeenAction({ channel, recipientId: externalUserId, meta: commonMeta }));
  }

  if (shouldCreateLead) {
    actions.push(
      createLeadAction({
        channel,
        externalUserId,
        thread,
        text,
        intent,
        meta: commonMeta,
      })
    );
  }

  if (shouldHandoff) {
    actions.push(
      handoffAction({
        channel,
        externalUserId,
        thread,
        reason: handoffReason || "manual_review",
        priority: handoffPriority,
        meta: commonMeta,
      })
    );
  }

  if (shouldReply && shouldTyping) {
    actions.push(typingOnAction({ channel, recipientId: externalUserId, meta: commonMeta }));
  }

  if (shouldReply) {
    actions.push(
      sendMessageAction({
        channel,
        recipientId: externalUserId,
        text: replyText,
        meta: commonMeta,
      })
    );
  } else {
    actions.push(
      noReplyAction({
        reason: quietHoursApplied
          ? "quiet_hours"
          : reliability?.operatorRecentlyReplied
            ? "operator_recently_replied"
            : reliability?.recentOutboundCooldownActive
              ? "recent_outbound_cooldown"
              : reliability?.duplicateOfLastAiReply
                ? "duplicate_ai_reply_guard"
                : "reply_suppressed",
        meta: commonMeta,
      })
    );
  }

  if (shouldReply && shouldTyping) {
    actions.push(typingOffAction({ channel, recipientId: externalUserId, meta: commonMeta }));
  }

  return {
    intent,
    leadScore,
    policy,
    actions,
  };
}

export async function buildInboxActions({
  text,
  channel,
  externalUserId,
  tenantKey,
  thread,
  message,
  tenant = null,
  recentMessages = [],
}) {
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);

  const policy = getInboxPolicy({
    tenantKey: resolvedTenantKey,
    channel,
    tenant,
  });

  const incoming = lower(text);
  const actions = [];
  const handoff = getThreadHandoffState(thread);
  const quietHoursApplied = isPolicyQuietHours(policy);
  const reliability = getReliabilityFlags({
    text,
    thread,
    recentMessages,
    quietHoursApplied,
    policy,
  });

  const profile = getTenantBusinessProfile(tenant, resolvedTenantKey);

  const metaBase = {
    tenantKey: resolvedTenantKey,
    threadId: s(thread?.id),
    messageId: s(message?.id),
    channelAllowed: Boolean(policy.channelAllowed),
    quietHoursApplied,
    handoffActive: Boolean(handoff.active),
    recentOutboundCooldownActive: Boolean(reliability.recentOutboundCooldownActive),
    operatorRecentlyReplied: Boolean(reliability.operatorRecentlyReplied),
    duplicateOfLastAiReply: Boolean(reliability.duplicateOfLastAiReply),
    recentMessageCount: normalizeRecentMessages(recentMessages).length,
    brandName: profile.displayName,
    industry: profile.industry,
    services: profile.services,
  };

  if (!policy.channelAllowed) {
    return {
      intent: "channel_blocked",
      leadScore: 0,
      policy,
      actions: [
        noReplyAction({
          reason: "channel_not_allowed",
          meta: metaBase,
        }),
      ],
    };
  }

  if (!incoming) {
    return {
      intent: "empty",
      leadScore: 0,
      policy,
      actions: [
        noReplyAction({
          reason: "empty_text",
          meta: metaBase,
        }),
      ],
    };
  }

  if (thread?.status === "closed" || thread?.status === "spam") {
    return {
      intent: "thread_blocked",
      leadScore: 0,
      policy,
      actions: [
        noReplyAction({
          reason: "thread_status_blocked",
          meta: {
            ...metaBase,
            threadStatus: s(thread?.status),
          },
        }),
      ],
    };
  }

  if (handoff.active && policy.suppressAiDuringHandoff) {
    if (policy.markSeenEnabled) {
      actions.push(
        markSeenAction({
          channel,
          recipientId: externalUserId,
          meta: buildMeta({
            tenantKey: resolvedTenantKey,
            thread,
            message,
            intent: "handoff_active",
            score: 0,
            extra: {
              ...metaBase,
              handoffReason: handoff.reason,
              handoffPriority: handoff.priority,
            },
          }),
        })
      );
    }

    actions.push(
      noReplyAction({
        reason: "handoff_active",
        meta: buildMeta({
          tenantKey: resolvedTenantKey,
          thread,
          message,
          intent: "handoff_active",
          score: 0,
          extra: {
            ...metaBase,
            handoffReason: handoff.reason,
            handoffPriority: handoff.priority,
          },
        }),
      })
    );

    return {
      intent: "handoff_active",
      leadScore: 0,
      policy,
      actions,
    };
  }

  if (isAckOnlyText(incoming)) {
    if (policy.markSeenEnabled) {
      actions.push(
        markSeenAction({
          channel,
          recipientId: externalUserId,
          meta: buildMeta({
            tenantKey: resolvedTenantKey,
            thread,
            message,
            intent: "ack",
            score: 0,
            extra: { ...metaBase, engine: "rule_ack" },
          }),
        })
      );
    }

    actions.push(
      noReplyAction({
        reason: "ack_only",
        meta: buildMeta({
          tenantKey: resolvedTenantKey,
          thread,
          message,
          intent: "ack",
          score: 0,
          extra: { ...metaBase, engine: "rule_ack" },
        }),
      })
    );

    return {
      intent: "ack",
      leadScore: 0,
      policy,
      actions,
    };
  }

  if (reliability.operatorRecentlyReplied) {
    if (policy.markSeenEnabled) {
      actions.push(
        markSeenAction({
          channel,
          recipientId: externalUserId,
          meta: buildMeta({
            tenantKey: resolvedTenantKey,
            thread,
            message,
            intent: "operator_recently_replied",
            score: 0,
            extra: metaBase,
          }),
        })
      );
    }

    actions.push(
      noReplyAction({
        reason: "operator_recently_replied",
        meta: buildMeta({
          tenantKey: resolvedTenantKey,
          thread,
          message,
          intent: "operator_recently_replied",
          score: 0,
          extra: metaBase,
        }),
      })
    );

    return {
      intent: "operator_recently_replied",
      leadScore: 0,
      policy,
      actions,
    };
  }

  const ai = await aiDecideInbox({
    text,
    channel,
    externalUserId,
    tenantKey: resolvedTenantKey,
    thread,
    message,
    tenant,
    policy,
    quietHoursApplied,
    recentMessages,
    reliability,
  });

  if (ai) {
    const aiProfile = ai.profile || profile;

    let intent = s(ai.intent || "general") || "general";
    let replyText = s(ai.replyText || "");
    let leadScore = Math.max(0, Math.min(100, Number(ai.leadScore || 0)));
    let shouldCreateLead = Boolean(ai.createLead);
    let shouldHandoff = Boolean(ai.handoff);
    let shouldReply = Boolean(policy.autoReplyEnabled) && !Boolean(ai.noReply);
    let shouldMarkSeen = Boolean(policy.markSeenEnabled);
    let shouldTyping = Boolean(policy.typingIndicatorEnabled);
    let handoffReason = s(ai.handoffReason || "");
    let handoffPriority = s(ai.handoffPriority || "normal").toLowerCase() || "normal";

    if (quietHoursApplied) {
      shouldReply = false;
      shouldTyping = false;
    }

    if (reliability.recentOutboundCooldownActive) {
      shouldReply = false;
      shouldTyping = false;
    }

    if (reliability.duplicateOfLastAiReply) {
      shouldReply = false;
      shouldTyping = false;
    }

    if (!policy.createLeadEnabled) shouldCreateLead = false;
    if (!policy.handoffEnabled) shouldHandoff = false;

    if (!replyText && shouldReply) {
      shouldReply = false;
    }

    const commonMeta = buildMeta({
      tenantKey: resolvedTenantKey,
      thread,
      message,
      intent,
      score: leadScore,
      extra: {
        quietHoursApplied,
        recentMessageCount: normalizeRecentMessages(recentMessages).length,
        policyAutoReplyEnabled: Boolean(policy.autoReplyEnabled),
        policyCreateLeadEnabled: Boolean(policy.createLeadEnabled),
        policyHandoffEnabled: Boolean(policy.handoffEnabled),
        policyMarkSeenEnabled: Boolean(policy.markSeenEnabled),
        policyTypingIndicatorEnabled: Boolean(policy.typingIndicatorEnabled),
        policySuppressAiDuringHandoff: Boolean(policy.suppressAiDuringHandoff),
        timezone: s(policy.timezone || "Asia/Baku"),
        engine: "ai",
        brandName: aiProfile.displayName,
        industry: aiProfile.industry,
        services: aiProfile.services,
        recentOutboundCooldownActive: Boolean(reliability.recentOutboundCooldownActive),
        operatorRecentlyReplied: Boolean(reliability.operatorRecentlyReplied),
        duplicateOfLastAiReply: Boolean(reliability.duplicateOfLastAiReply),
      },
    });

    if (shouldMarkSeen) {
      actions.push(markSeenAction({ channel, recipientId: externalUserId, meta: commonMeta }));
    }

    if (shouldCreateLead) {
      actions.push(
        createLeadAction({
          channel,
          externalUserId,
          thread,
          text,
          intent,
          meta: commonMeta,
        })
      );
    }

    if (shouldHandoff) {
      actions.push(
        handoffAction({
          channel,
          externalUserId,
          thread,
          reason: handoffReason || "manual_review",
          priority: handoffPriority || "normal",
          meta: commonMeta,
        })
      );
    }

    if (shouldReply && shouldTyping) {
      actions.push(typingOnAction({ channel, recipientId: externalUserId, meta: commonMeta }));
    }

    if (shouldReply) {
      actions.push(
        sendMessageAction({
          channel,
          recipientId: externalUserId,
          text: replyText,
          meta: commonMeta,
        })
      );
    } else {
      actions.push(
        noReplyAction({
          reason: quietHoursApplied
            ? "quiet_hours"
            : reliability.recentOutboundCooldownActive
              ? "recent_outbound_cooldown"
              : reliability.duplicateOfLastAiReply
                ? "duplicate_ai_reply_guard"
                : "reply_suppressed",
          meta: commonMeta,
        })
      );
    }

    if (shouldReply && shouldTyping) {
      actions.push(typingOffAction({ channel, recipientId: externalUserId, meta: commonMeta }));
    }

    return {
      intent,
      leadScore,
      policy,
      actions,
    };
  }

  return buildInboxActionsFallback({
    text,
    channel,
    externalUserId,
    tenantKey: resolvedTenantKey,
    thread,
    message,
    tenant,
    policy,
    quietHoursApplied,
    recentMessages,
    reliability,
  });
}