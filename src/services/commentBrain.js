// src/services/commentBrain.js
// FINAL v3.1 — tenant-aware public comment classifier with professional DM redirect strategy

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

function cleanReplySuggestion(v) {
  return fixMojibake(s(v || "")).slice(0, 500);
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

function getResolvedTenantKey(tenantKey) {
  return resolveTenantKey(tenantKey, getDefaultTenantKey());
}

function getTenantBrandName(tenant, tenantKey) {
  const brandName =
    tenant?.brand?.displayName ||
    tenant?.brand?.name ||
    tenant?.profile?.displayName ||
    tenant?.profile?.companyName ||
    tenant?.name ||
    getResolvedTenantKey(tenantKey);

  return s(brandName || "Brand");
}

function getTenantBusinessContext(tenant) {
  return s(
    tenant?.ai_policy?.businessContext ||
      tenant?.profile?.businessContext ||
      tenant?.businessContext ||
      ""
  ).slice(0, 1200);
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

function makeDmReply(brandName, kind) {
  if (kind === "sales") {
    return `Təşəkkür edirik. Daha dəqiq məlumat üçün zəhmət olmasa bizə DM yazın. Sizə uyğun şəkildə məlumat paylaşa bilərik.`;
  }

  if (kind === "support") {
    return `Yazdığınız üçün təşəkkür edirik. Məsələni daha rahat yoxlamaq üçün zəhmət olmasa bizə DM yazın. Sizə dəstək göstərilə bilər.`;
  }

  return "";
}

function fallbackClassification(text, { tenantKey, tenant } = {}) {
  const incoming = lower(text);
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);
  const brandName = getTenantBrandName(tenant, resolvedTenantKey);

  let category = "normal";
  let priority = "low";
  let sentiment = "neutral";
  let requiresHuman = false;
  let shouldCreateLead = false;
  let shouldReply = false;
  let replySuggestion = "";
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
    "işləmir?",
    "niyə işləmir",
    "niye islemir",
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
    reason = "toxic_language";
  } else if (hasAny(supportPatterns)) {
    category = "support";
    priority = "medium";
    sentiment = "negative";
    requiresHuman = true;
    shouldReply = true;
    replySuggestion = makeDmReply(brandName, "support");
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
    shouldCreateLead = true;
    shouldReply = true;
    replySuggestion = makeDmReply(brandName, "sales");
    reason =
      priority === "high" ? "pricing_or_contact_interest" : "service_interest";
  }

  if (hasAny(positivePatterns) && sentiment === "neutral") {
    sentiment = "positive";
  } else if (hasAny(negativePatterns) && sentiment === "neutral") {
    sentiment = "negative";
  }

  return {
    category,
    priority,
    sentiment,
    requiresHuman,
    shouldCreateLead,
    shouldReply,
    replySuggestion,
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
  let replySuggestion = cleanReplySuggestion(parsed?.replySuggestion || "");
  let reason = cleanReason(parsed?.reason || "ai_classified");

  if ((category === "sales" || category === "support") && !shouldReply) {
    shouldReply = true;
  }

  if ((category === "sales" || category === "support") && !replySuggestion) {
    replySuggestion = makeDmReply(brandName, category);
  }

  if (category === "sales") {
    shouldCreateLead = true;
  }

  if (category === "spam" || category === "toxic") {
    shouldReply = false;
    replySuggestion = "";
  }

  if (category === "toxic" && !requiresHuman) {
    requiresHuman = true;
  }

  return {
    category,
    priority,
    sentiment,
    requiresHuman,
    shouldCreateLead,
    shouldReply,
    replySuggestion,
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

  if (!commentText) {
    return {
      category: "unknown",
      priority: "low",
      sentiment: "neutral",
      requiresHuman: false,
      shouldCreateLead: false,
      shouldReply: false,
      replySuggestion: "",
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
    500;

  const prompt = `
You are a strict JSON classifier for PUBLIC social media comments for a tenant brand.

Important:
- This is PUBLIC COMMENT classification, not DM classification.
- Be tenant-aware and avoid assuming a specific company or industry unless clearly supported by context.
- Use the provided business context if available.
- Be conservative with lead creation.
- For clear sales or support intent in public comments, prefer a short, polite, professional public reply that redirects the person to DM.
- Never suggest public discussion of sensitive details.
- Do not over-classify praise, emojis, or generic reactions as leads.
- Do not use employee names, operator names, manager names, or internal team identities.
- Do not repeatedly mention the brand name unless contextually useful.
- Keep replySuggestion professional, concise, and brand-safe.

Return ONLY valid JSON with this exact shape:
{
  "category": "normal",
  "priority": "low",
  "sentiment": "neutral",
  "requiresHuman": false,
  "shouldCreateLead": false,
  "shouldReply": false,
  "replySuggestion": "",
  "reason": ""
}

Allowed category:
["sales","support","spam","toxic","normal","unknown"]

Allowed priority:
["low","medium","high","urgent"]

Allowed sentiment:
["positive","neutral","negative","mixed"]

Classification rules:
- sales => clear commercial intent, asks about service, pricing, package, demo, contact, order, availability, quote, proposal
- support => issue/problem/help request needing follow-up or operational support
- spam => irrelevant promotion, scam, garbage, obvious bot-like promotion
- toxic => abusive, insulting, profane, hostile
- normal => praise, reaction, generic engagement, non-actionable comment
- unknown => not enough signal

Action rules:
- shouldCreateLead=true only when there is reasonably clear sales/commercial intent
- shouldReply=true mainly for sales/support comments when a polite public DM redirect is appropriate
- for sales/support public comments, replySuggestion should usually be a short polite DM redirect
- for spam/toxic, shouldReply=false and replySuggestion=""
- reason must be short snake_case

Tenant context:
brandName=${JSON.stringify(brandName)}
tenantKey=${JSON.stringify(resolvedTenantKey)}
businessContext=${JSON.stringify(businessContext)}
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
