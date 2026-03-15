// src/services/commentBrain.js
// FINAL v4.0 — tenant-aware public comment classifier + public reply + private reply + handoff strategy

import OpenAI from "openai";
import { cfg } from "../config.js";
import { getDefaultTenantKey, resolveTenantKey } from "../tenancy/index.js";

function s(v) {
  return String(v ?? "").trim();
}

function lower(v) {
  return s(v).toLowerCase();
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

function cleanReason(v) {
  const raw = lower(v || "ai_classified")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return raw || "ai_classified";
}

function cleanText(v, max = 500) {
  return fixMojibake(s(v || "")).slice(0, max);
}

function normalizeCategory(v) {
  const x = lower(v);
  return ["sales", "support", "spam", "toxic", "normal", "unknown"].includes(x)
    ? x
    : "unknown";
}

function normalizePriority(v) {
  const x = lower(v);
  return ["low", "medium", "high", "urgent"].includes(x) ? x : "low";
}

function normalizeSentiment(v) {
  const x = lower(v);
  return ["positive", "neutral", "negative", "mixed"].includes(x)
    ? x
    : "neutral";
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function getResolvedTenantKey(tenantKey) {
  return resolveTenantKey(tenantKey, getDefaultTenantKey());
}

function getTenantBrandName(tenant, tenantKey) {
  const brandName =
    tenant?.brand?.displayName ||
    tenant?.brand?.name ||
    tenant?.profile?.displayName ||
    tenant?.profile?.companyName ||
    tenant?.company_name ||
    tenant?.name ||
    getResolvedTenantKey(tenantKey);

  return s(brandName || "Brand");
}

function getTenantBusinessContext(tenant) {
  return s(
    tenant?.ai_policy?.businessContext ||
      tenant?.profile?.businessContext ||
      tenant?.meta?.businessSummary ||
      tenant?.profile?.brand_summary ||
      tenant?.profile?.value_proposition ||
      tenant?.businessContext ||
      ""
  ).slice(0, 1400);
}

function getTenantTone(tenant) {
  return s(
    tenant?.profile?.tone_of_voice ||
      tenant?.brand?.tone ||
      tenant?.meta?.tone ||
      "professional"
  );
}

function getTenantPreferredCta(tenant) {
  return s(
    tenant?.profile?.preferred_cta ||
      tenant?.meta?.preferredCta ||
      ""
  );
}

function getTenantBannedPhrases(tenant) {
  return arr(
    tenant?.profile?.banned_phrases ||
      tenant?.meta?.bannedPhrases ||
      []
  )
    .map((x) => lower(x))
    .filter(Boolean);
}

function getCommentPolicy(tenant) {
  return tenant?.comment_policy || tenant?.ai_policy?.comment_policy || {};
}

function applyBannedPhraseGuard(text, tenant) {
  const banned = getTenantBannedPhrases(tenant);
  let out = cleanText(text, 500);
  if (!out) return "";

  for (const phrase of banned) {
    if (!phrase) continue;
    const re = new RegExp(
      phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "ig"
    );
    out = out.replace(re, "").replace(/\s{2,}/g, " ").trim();
  }

  return out.slice(0, 500);
}

let openaiSingleton = null;

function ensureOpenAI() {
  const key =
    s(cfg?.openai?.apiKey) ||
    s(cfg?.OPENAI_API_KEY) ||
    "";

  if (!key) return null;

  if (!openaiSingleton) {
    openaiSingleton = new OpenAI({ apiKey: key });
  }

  return openaiSingleton;
}

function makePublicReply({ kind, tenant }) {
  const preferredCta = getTenantPreferredCta(tenant);
  const tone = lower(getTenantTone(tenant));

  if (kind === "sales") {
    if (tone.includes("premium") || tone.includes("modern") || tone.includes("confident")) {
      return applyBannedPhraseGuard(
        `Təşəkkür edirik. İstəsəniz detalları sizə DM-də qısa şəkildə paylaşaq.`,
        tenant
      );
    }

    return applyBannedPhraseGuard(
      preferredCta
        ? `Təşəkkür edirik. ${preferredCta} üçün sizə DM-də yazaq.`
        : `Təşəkkür edirik. Detalları sizə DM-də paylaşaq.`,
      tenant
    );
  }

  if (kind === "support") {
    return applyBannedPhraseGuard(
      `Yazdığınız üçün təşəkkür edirik. Məsələni daha rahat yoxlamaq üçün sizə DM-də yazaq.`,
      tenant
    );
  }

  if (kind === "positive") {
    return applyBannedPhraseGuard(
      `Təşəkkür edirik. Bəyənməyiniz bizi sevindirdi.`,
      tenant
    );
  }

  return "";
}

function makePrivateReply({ kind, tenant }) {
  const preferredCta = getTenantPreferredCta(tenant);

  if (kind === "sales") {
    return applyBannedPhraseGuard(
      preferredCta
        ? `Salam. Şərhinizə görə yazırıq. ${preferredCta} ilə bağlı sizə uyğun variantı paylaşa bilərik. Hansı xidmətlə maraqlanırsınız?`
        : `Salam. Şərhinizə görə yazırıq. Sizə uyğun variantı qısa şəkildə paylaşa bilərik. Hansı xidmətlə maraqlanırsınız?`,
      tenant
    );
  }

  if (kind === "support") {
    return applyBannedPhraseGuard(
      `Salam. Şərhinizə görə yazırıq. Problemi yoxlamaq üçün qısa şəkildə detalları bizimlə paylaşa bilərsiniz.`,
      tenant
    );
  }

  return "";
}

function fallbackClassification(text, { tenantKey, tenant } = {}) {
  const incoming = lower(text);
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);
  const brandName = getTenantBrandName(tenant, resolvedTenantKey);
  const commentPolicy = getCommentPolicy(tenant);
  const autoReplyEnabled =
    typeof tenant?.ai_policy?.auto_reply_enabled === "boolean"
      ? tenant.ai_policy.auto_reply_enabled
      : true;
  const createLeadEnabled =
    typeof tenant?.ai_policy?.create_lead_enabled === "boolean"
      ? tenant.ai_policy.create_lead_enabled
      : true;
  const escalateToxic =
    commentPolicy?.escalateToxic !== false;

  let category = "normal";
  let priority = "low";
  let sentiment = "neutral";
  let requiresHuman = false;
  let shouldCreateLead = false;
  let shouldReply = false;
  let replySuggestion = "";
  let shouldPrivateReply = false;
  let privateReplySuggestion = "";
  let shouldHandoff = false;
  let reason = "generic_comment";

  const salesPatterns = [
    "qiymət",
    "qiymet",
    "price",
    "cost",
    "neçəyə",
    "neceye",
    "paket",
    "tarif",
    "cəmi neçəyə",
    "nece olur",
    "how much",
    "quote",
    "offer",
    "proposal",
    "xidmət",
    "xidmet",
    "service",
    "website",
    "web site",
    "sayt",
    "chatbot",
    "bot",
    "automation",
    "avtomat",
    "crm",
    "smm",
    "əlaqə",
    "elaqe",
    "contact",
    "number",
    "nomre",
    "nömrə",
    "zəng",
    "zeng",
    "write me",
    "dm me",
    "maraqlıdır",
    "maraqlidir",
    "isteyirem",
    "istəyirəm",
    "bizə də lazımdır",
    "bize de lazimdir",
    "want this",
    "ətraflı",
    "etraflı",
    "details",
    "info",
    "melumat",
    "məlumat",
    "demo",
    "meeting",
    "consultation",
  ];

  const supportPatterns = [
    "kömək",
    "komek",
    "problem",
    "işləmir",
    "islemir",
    "support",
    "help",
    "bug",
    "xəta",
    "xeta",
    "error",
    "issue",
    "alınmır",
    "alinmir",
    "açılmır",
    "acilmir",
    "girilmir",
    "login olmur",
    "niyə işləmir",
    "niye islemir",
    "işləmir?",
  ];

  const spamPatterns = [
    "spam",
    "crypto",
    "bitcoin",
    "forex",
    "casino",
    "bet",
    "1xbet",
    "loan",
    "earn money fast",
    "make money fast",
    "promo page",
    "follow for follow",
    "f4f",
  ];

  const toxicPatterns = [
    "axmaq",
    "stupid",
    "idiot",
    "fuck",
    "sik",
    "dumb",
    "moron",
    "aptal",
    "gerizekalı",
    "gerizekali",
    "loser",
  ];

  const positivePatterns = [
    "əla",
    "ela",
    "super",
    "əhsən",
    "ehsen",
    "great",
    "nice",
    "cool",
    "gözəl",
    "gozel",
    "mükəmməl",
    "mukemmel",
    "perfect",
    "bravo",
  ];

  const negativePatterns = [
    "pis",
    "bad",
    "terrible",
    "awful",
    "problem",
    "işləmir",
    "islemir",
    "xəta",
    "xeta",
    "narazı",
    "narazi",
  ];

  const hasAny = (patterns) => patterns.some((p) => incoming.includes(p));

  if (hasAny(spamPatterns)) {
    category = "spam";
    priority = "low";
    sentiment = "negative";
    reason = "spam_like";
  } else if (hasAny(toxicPatterns)) {
    category = "toxic";
    priority = "medium";
    sentiment = "negative";
    requiresHuman = true;
    shouldHandoff = Boolean(escalateToxic);
    reason = "toxic_language";
  } else if (hasAny(supportPatterns)) {
    category = "support";
    priority = "medium";
    sentiment = "negative";
    requiresHuman = true;
    shouldHandoff = true;
    shouldReply = autoReplyEnabled;
    shouldPrivateReply = autoReplyEnabled;
    replySuggestion = shouldReply ? makePublicReply({ kind: "support", tenant }) : "";
    privateReplySuggestion = shouldPrivateReply
      ? makePrivateReply({ kind: "support", tenant })
      : "";
    reason = "support_request";
  } else if (hasAny(salesPatterns)) {
    category = "sales";
    priority =
      incoming.includes("qiymət") ||
      incoming.includes("qiymet") ||
      incoming.includes("price") ||
      incoming.includes("how much") ||
      incoming.includes("contact") ||
      incoming.includes("əlaqə") ||
      incoming.includes("elaqe")
        ? "high"
        : "medium";
    shouldCreateLead = Boolean(createLeadEnabled);
    shouldReply = autoReplyEnabled;
    shouldPrivateReply = autoReplyEnabled;
    replySuggestion = shouldReply ? makePublicReply({ kind: "sales", tenant }) : "";
    privateReplySuggestion = shouldPrivateReply
      ? makePrivateReply({ kind: "sales", tenant })
      : "";
    reason =
      priority === "high" ? "pricing_or_contact_interest" : "service_interest";
  } else if (hasAny(positivePatterns)) {
    category = "normal";
    priority = "low";
    sentiment = "positive";
    shouldReply = false;
    shouldPrivateReply = false;
    reason = "positive_reaction";
  }

  if (hasAny(negativePatterns) && sentiment === "neutral") {
    sentiment = "negative";
  }

  return {
    category,
    priority,
    sentiment,
    requiresHuman,
    shouldCreateLead,
    shouldReply,
    replySuggestion: cleanText(replySuggestion, 500),
    shouldPrivateReply,
    privateReplySuggestion: cleanText(privateReplySuggestion, 500),
    shouldHandoff,
    reason,
    engine: "fallback",
    meta: {
      tenantKey: resolvedTenantKey,
      brandName,
    },
  };
}

function normalizeOutput(parsed, { tenantKey, tenant } = {}) {
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);
  const brandName = getTenantBrandName(tenant, resolvedTenantKey);

  let category = normalizeCategory(parsed?.category);
  let priority = normalizePriority(parsed?.priority);
  let sentiment = normalizeSentiment(parsed?.sentiment);
  let requiresHuman = Boolean(parsed?.requiresHuman);
  let shouldCreateLead = Boolean(parsed?.shouldCreateLead);
  let shouldReply = Boolean(parsed?.shouldReply);
  let replySuggestion = cleanText(parsed?.replySuggestion || "", 500);
  let shouldPrivateReply = Boolean(parsed?.shouldPrivateReply);
  let privateReplySuggestion = cleanText(parsed?.privateReplySuggestion || "", 500);
  let shouldHandoff = Boolean(parsed?.shouldHandoff);
  let reason = cleanReason(parsed?.reason || "ai_classified");

  const autoReplyEnabled =
    typeof tenant?.ai_policy?.auto_reply_enabled === "boolean"
      ? tenant.ai_policy.auto_reply_enabled
      : true;
  const createLeadEnabled =
    typeof tenant?.ai_policy?.create_lead_enabled === "boolean"
      ? tenant.ai_policy.create_lead_enabled
      : true;
  const commentPolicy = getCommentPolicy(tenant);
  const escalateToxic =
    commentPolicy?.escalateToxic !== false;

  if ((category === "sales" || category === "support") && autoReplyEnabled && !shouldReply) {
    shouldReply = true;
  }

  if ((category === "sales" || category === "support") && autoReplyEnabled && !shouldPrivateReply) {
    shouldPrivateReply = true;
  }

  if (category === "sales" && createLeadEnabled) {
    shouldCreateLead = true;
  }

  if (category === "sales" && !replySuggestion) {
    replySuggestion = makePublicReply({ kind: "sales", tenant });
  }

  if (category === "sales" && !privateReplySuggestion) {
    privateReplySuggestion = makePrivateReply({ kind: "sales", tenant });
  }

  if (category === "support" && !replySuggestion) {
    replySuggestion = makePublicReply({ kind: "support", tenant });
  }

  if (category === "support" && !privateReplySuggestion) {
    privateReplySuggestion = makePrivateReply({ kind: "support", tenant });
  }

  if (category === "support") {
    requiresHuman = true;
    shouldHandoff = true;
  }

  if (category === "toxic") {
    requiresHuman = true;
    shouldReply = false;
    shouldPrivateReply = false;
    replySuggestion = "";
    privateReplySuggestion = "";
    shouldHandoff = Boolean(escalateToxic);
  }

  if (category === "spam") {
    shouldReply = false;
    shouldPrivateReply = false;
    replySuggestion = "";
    privateReplySuggestion = "";
    shouldCreateLead = false;
    shouldHandoff = false;
  }

  replySuggestion = applyBannedPhraseGuard(replySuggestion, tenant);
  privateReplySuggestion = applyBannedPhraseGuard(privateReplySuggestion, tenant);

  return {
    category,
    priority,
    sentiment,
    requiresHuman,
    shouldCreateLead,
    shouldReply: autoReplyEnabled ? shouldReply : false,
    replySuggestion: autoReplyEnabled ? replySuggestion : "",
    shouldPrivateReply: autoReplyEnabled ? shouldPrivateReply : false,
    privateReplySuggestion: autoReplyEnabled ? privateReplySuggestion : "",
    shouldHandoff,
    reason,
    engine: "ai",
    meta: {
      tenantKey: resolvedTenantKey,
      brandName,
    },
  };
}

export async function classifyComment({
  tenantKey,
  tenant = null,
  channel,
  externalUserId,
  externalUsername,
  customerName,
  text,
}) {
  const commentText = fixMojibake(s(text || ""));
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);
  const brandName = getTenantBrandName(tenant, resolvedTenantKey);
  const businessContext = getTenantBusinessContext(tenant);
  const tone = getTenantTone(tenant);
  const preferredCta = getTenantPreferredCta(tenant);
  const bannedPhrases = getTenantBannedPhrases(tenant);
  const commentPolicy = getCommentPolicy(tenant);

  if (!commentText) {
    return {
      category: "unknown",
      priority: "low",
      sentiment: "neutral",
      requiresHuman: false,
      shouldCreateLead: false,
      shouldReply: false,
      replySuggestion: "",
      shouldPrivateReply: false,
      privateReplySuggestion: "",
      shouldHandoff: false,
      reason: "empty_text",
      engine: "rule",
      meta: {
        tenantKey: resolvedTenantKey,
        brandName,
      },
    };
  }

  const openai = ensureOpenAI();
  if (!openai) {
    return fallbackClassification(commentText, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  }

  const model =
    s(cfg?.openai?.model) ||
    s(cfg?.OPENAI_MODEL, "gpt-5") ||
    "gpt-5";

  const max_output_tokens =
    Number(cfg?.openai?.maxOutputTokens) ||
    Number(cfg?.OPENAI_MAX_OUTPUT_TOKENS) ||
    700;

  const prompt = `
You are a strict JSON classifier for PUBLIC social media comments for a tenant brand.

Important:
- This is PUBLIC COMMENT classification, not ongoing DM conversation classification.
- Be tenant-aware and avoid assuming a specific company or industry unless clearly supported by context.
- Use the provided business context, tone, CTA preference, and banned phrases if available.
- Be conservative with lead creation.
- For clear sales or support intent in public comments, prefer:
  1) a short professional PUBLIC reply
  2) a short professional PRIVATE reply for DM handoff
- Never expose sensitive details publicly.
- Never use staff names, operator names, internal teams, or fake urgency.
- Do not over-classify praise, emojis, or generic reactions as leads.
- Public reply must be short.
- Private reply must be natural and useful.
- Spam/toxic should not get public or private replies.

Return ONLY valid JSON with this exact shape:
{
  "category": "normal",
  "priority": "low",
  "sentiment": "neutral",
  "requiresHuman": false,
  "shouldCreateLead": false,
  "shouldReply": false,
  "replySuggestion": "",
  "shouldPrivateReply": false,
  "privateReplySuggestion": "",
  "shouldHandoff": false,
  "reason": ""
}

Allowed category:
["sales","support","spam","toxic","normal","unknown"]

Allowed priority:
["low","medium","high","urgent"]

Allowed sentiment:
["positive","neutral","negative","mixed"]

Classification rules:
- sales => clear commercial intent, asks about service, pricing, package, demo, contact, availability, quote, proposal
- support => issue/problem/help request needing follow-up or human support
- spam => irrelevant promotion, scam, garbage, obvious bot-like promotion
- toxic => abusive, insulting, profane, hostile
- normal => praise, reaction, generic engagement, non-actionable comment
- unknown => not enough signal

Action rules:
- shouldCreateLead=true only when there is reasonably clear commercial intent
- shouldReply=true mainly for sales/support when a short public reply is appropriate
- shouldPrivateReply=true mainly for sales/support when DM handoff is appropriate
- shouldHandoff=true for support needing human review, or toxic/risky situations
- for spam/toxic => shouldReply=false, shouldPrivateReply=false
- reason must be short snake_case

Style rules:
- public reply max about 140 chars
- private reply max about 280 chars
- avoid banned phrases
- keep tone aligned with tenant
- do not repeat the brand name unless it adds value
- avoid robotic language

Tenant context:
brandName=${JSON.stringify(brandName)}
tenantKey=${JSON.stringify(resolvedTenantKey)}
businessContext=${JSON.stringify(businessContext)}
tone=${JSON.stringify(tone)}
preferredCta=${JSON.stringify(preferredCta)}
bannedPhrases=${JSON.stringify(bannedPhrases)}
commentPolicy=${JSON.stringify(commentPolicy)}
channel=${JSON.stringify(s(channel || "instagram"))}
externalUserId=${JSON.stringify(s(externalUserId || ""))}
externalUsername=${JSON.stringify(s(externalUsername || ""))}
customerName=${JSON.stringify(s(customerName || ""))}

Comment:
${JSON.stringify(commentText)}
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
            "Return only valid JSON. No markdown. No explanations. No extra text.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const raw = extractText(resp);
    const parsed = parseJsonLoose(raw);

    if (!parsed || typeof parsed !== "object") {
      return fallbackClassification(commentText, {
        tenantKey: resolvedTenantKey,
        tenant,
      });
    }

    return normalizeOutput(parsed, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  } catch {
    return fallbackClassification(commentText, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  }
}