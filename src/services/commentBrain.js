// src/services/commentBrain.js
// FINAL v2.0 — tenant-safe public comment classifier

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
    tenant?.name ||
    getResolvedTenantKey(tenantKey);

  return s(brandName || "Brand");
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
    "instagram automation",
    "whatsapp automation",
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

  return {
    category: normalizeCategory(parsed?.category),
    priority: normalizePriority(parsed?.priority),
    sentiment: normalizeSentiment(parsed?.sentiment),
    requiresHuman: Boolean(parsed?.requiresHuman),
    shouldCreateLead: Boolean(parsed?.shouldCreateLead),
    shouldReply: false,
    replySuggestion: cleanReplySuggestion(parsed?.replySuggestion || ""),
    reason: cleanReason(parsed?.reason || "ai_classified"),
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
  const cleanText = fixMojibake(s(text || ""));
  const resolvedTenantKey = getResolvedTenantKey(tenantKey);
  const brandName = getTenantBrandName(tenant, resolvedTenantKey);

  if (!cleanText) {
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
    return fallbackClassification(cleanText, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  }

  const model = s(cfg.OPENAI_MODEL || "gpt-5") || "gpt-5";
  const max_output_tokens = Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 500);

  const prompt = `
You are a strict JSON classifier for PUBLIC social media comments for ${brandName}.

Business context:
- This brand provides digital services such as website development, AI automation, chatbot systems, WhatsApp/Instagram/Messenger automation, and related business automation solutions.
- This input is a PUBLIC COMMENT, not a DM.
- Be conservative and avoid aggressive lead tagging.
- We are only classifying, not executing actions.

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

Rules:
- sales => asks about service, pricing, order, contact, demo, offer, package, automation, chatbot, website, etc.
- support => has issue/problem/question needing human follow-up
- spam => obvious irrelevant promo/scam/garbage
- toxic => abusive/insulting/profane
- normal => generic engagement, praise, neutral reaction
- shouldCreateLead=true only for reasonably clear sales/commercial intent
- shouldReply=false by default because this is public-comment phase
- replySuggestion may be empty
- reason must be short snake_case

Context:
brandName=${JSON.stringify(brandName)}
tenantKey=${JSON.stringify(resolvedTenantKey)}
channel=${JSON.stringify(s(channel || "instagram"))}
externalUserId=${JSON.stringify(s(externalUserId || ""))}
externalUsername=${JSON.stringify(s(externalUsername || ""))}
customerName=${JSON.stringify(s(customerName || ""))}

Comment:
${JSON.stringify(cleanText)}
  `.trim();

  try {
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens,
      input: [
        {
          role: "system",
          content: "Return only valid JSON. No markdown. No explanations.",
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
      return fallbackClassification(cleanText, {
        tenantKey: resolvedTenantKey,
        tenant,
      });
    }

    return normalizeOutput(parsed, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  } catch {
    return fallbackClassification(cleanText, {
      tenantKey: resolvedTenantKey,
      tenant,
    });
  }
}