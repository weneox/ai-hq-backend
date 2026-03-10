// src/services/inboxBrain.js
// FINAL v5.0 — tenant-safe inbox reliability layer + AI/fallback decisioning

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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
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

function getTenantBrandName(tenant, tenantKey) {
  const brandName =
    tenant?.brand?.displayName ||
    tenant?.brand?.name ||
    tenant?.name ||
    getResolvedTenantKey(tenantKey);

  return s(brandName || "Brand");
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
      meta: m?.meta && typeof m.meta === "object" ? m.meta : {},
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
      "thanks",
      "thank you",
      "təşəkkür",
      "tesekkur",
      "sağ ol",
      "sag ol",
    ]) &&
    incoming.length <= 20
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
      return `${who}: ${s(m.text).slice(0, 300)}`;
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
  const brandName = getTenantBrandName(tenant, tenantKey);
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);

  const prompt = `
You are an AI inbox copilot for ${brandName}.

Your task:
Analyze the incoming customer message and return ONLY valid JSON.

Business context:
- This brand provides digital services such as website development, AI automation, chatbot systems, Instagram/WhatsApp/Messenger automation, and related business automation solutions.
- The goal is to be helpful, short, sales-aware, and professional.
- Keep replies concise, natural, and human-like.
- Default language should match the user's message.
- Do not invent prices.
- If user asks pricing, encourage them to briefly describe the needed service.
- If user wants a human/operator, set handoff=true.
- If message looks like clear service interest, createLead should usually be true.
- If message is only short acknowledgement like "ok", "thanks", "👍", then noReply=true.
- If operator recently replied, prefer noReply=true unless the user is clearly asking something new and urgent.
- Avoid repeating the same reply again.
- If quiet hours are active, still analyze normally but noReply can be true if needed.
- Never output anything except JSON.

Allowed intents:
["general","greeting","pricing","website","automation","handoff_request","service_interest","ack","support","other"]

Return JSON exactly with this shape:
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
- replyText must be short, max 2 sentences
- if noReply=true then replyText should be ""
- if handoff=true then handoffReason should be filled

Context:
brandName=${JSON.stringify(brandName)}
tenantKey=${JSON.stringify(resolvedTenantKey)}
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
            "You are a strict JSON generator for inbox decisioning. Return only JSON.",
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
    };
  } catch {
    return null;
  }
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
  const incoming = lower(text);
  const actions = [];
  const brandName = getTenantBrandName(tenant, tenantKey);

  let intent = "general";
  let replyText =
    `Salam. ${brandName}-a yazdığınız üçün təşəkkür edirik. Sizə məmnuniyyətlə kömək edəcəyik. Xidmət, qiymət və ya layihə detalları yazın.`;
  let leadScore = 10;
  let shouldCreateLead = false;
  let shouldHandoff = false;
  let shouldReply = Boolean(policy.autoReplyEnabled);
  let shouldMarkSeen = Boolean(policy.markSeenEnabled);
  let shouldTyping = Boolean(policy.typingIndicatorEnabled);
  let handoffReason = "";
  let handoffPriority = "normal";

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

  if (
    includesAny(incoming, [
      "qiymət",
      "qiymet",
      "price",
      "cost",
      "paket",
      "tarif",
      "neçəyə",
      "neceye",
    ])
  ) {
    intent = "pricing";
    leadScore = 85;
    shouldCreateLead = true;
    replyText =
      "Qiymət görüləcək işin həcminə görə dəyişir. İstədiyiniz xidməti qısa yazın, sizə uyğun həll və yönləndirmə edək.";
  } else if (
    includesAny(incoming, [
      "salam",
      "hello",
      "hi",
      "sabahınız",
      "sabahiniz",
      "axşamınız",
      "axsaminiz",
    ])
  ) {
    intent = "greeting";
    leadScore = 20;
    replyText =
      `${brandName}-a xoş gəlmisiniz. Website, AI avtomatlaşdırma, SMM və chatbot həlləri üzrə kömək edə bilərik. Hansı xidmətlə maraqlanırsınız?`;
  } else if (
    includesAny(incoming, [
      "sayt",
      "website",
      "web",
      "landing",
      "e-commerce",
      "shop",
      "mağaza",
      "magaza",
    ])
  ) {
    intent = "website";
    leadScore = 75;
    shouldCreateLead = true;
    replyText =
      "Website xidməti üçün kömək edə bilərik. İstədiyiniz sayt növünü yazın: şirkət saytı, satış saytı, landing page və ya fərqli bir şey.";
  } else if (
    includesAny(incoming, [
      "chatbot",
      "bot",
      "instagram",
      "whatsapp",
      "messenger",
      "dm",
      "avtomatlaşdırma",
      "avtomatlasdirma",
      "automation",
    ])
  ) {
    intent = "automation";
    leadScore = 80;
    shouldCreateLead = true;
    replyText =
      "Chatbot və DM avtomatlaşdırması üzrə həllərimiz var. Hansı platforma ilə başlamaq istəyirsiniz: Instagram, WhatsApp, Messenger, yoxsa website?";
  } else if (includesAny(incoming, policy.humanKeywords || [])) {
    intent = "handoff_request";
    leadScore = 90;
    shouldCreateLead = true;
    shouldHandoff = Boolean(policy.handoffEnabled);
    handoffReason = "user_requested_human";
    handoffPriority = "high";
    replyText =
      "Qeyd etdik. Komandamız sizinlə əlaqə üçün müraciətinizi nəzərə alacaq. Zəhmət olmasa qısa olaraq ehtiyacınızı yazın.";
  } else if (
    includesAny(incoming, [
      "təklif",
      "teklif",
      "proposal",
      "brief",
      "lazımdır",
      "lazimdir",
      "lazımdı",
      "kömək",
      "komek",
      "hazırlayın",
      "hazirlayin",
      "edə bilərsiniz",
      "ede bilersiniz",
    ])
  ) {
    intent = "service_interest";
    leadScore = 65;
    shouldCreateLead = true;
    replyText =
      "Əlbəttə. Sizə uyğun həlli yönləndirə bilməyimiz üçün istədiyiniz xidməti və qısa tələbinizi yazın.";
  }

  if (
    includesAny(incoming, [
      "təcili",
      "tecili",
      "urgent",
      "asap",
      "indi",
      "today",
      "bu gün",
      "bu gun",
    ])
  ) {
    leadScore = Math.max(leadScore, 92);
    shouldCreateLead = true;
    shouldHandoff = Boolean(policy.handoffEnabled);
    if (!handoffReason) handoffReason = "urgent_request";
    if (!handoffPriority || handoffPriority === "normal") handoffPriority = "high";
  }

  if (
    includesAny(incoming, [
      "nömrə",
      "nomre",
      "telefon",
      "phone",
      "whatsapp number",
      "əlaqə nömrəsi",
      "elaqe nomresi",
    ])
  ) {
    leadScore = Math.max(leadScore, 88);
    shouldCreateLead = true;
    replyText =
      "Maraq göstərdiyiniz üçün təşəkkür edirik. İstədiyiniz xidməti yazın, komandamız sizə uyğun şəkildə yönləndirsin.";
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
      brandName,
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

  const brandName = getTenantBrandName(tenant, resolvedTenantKey);

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
    brandName,
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
        brandName,
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