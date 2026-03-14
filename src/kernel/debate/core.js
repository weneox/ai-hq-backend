// src/kernel/debate/core.js

import OpenAI from "openai";
import { cfg } from "../../config.js";
import { normalizePromptInput } from "../../services/promptInput.js";
import { buildPromptBundle } from "../../services/promptBundle.js";
import { normalizeIndustryKey } from "../../prompts/industries/index.js";
import {
  clamp,
  extractJsonFromText,
  extractText,
  fixMojibake,
  mapLimit,
  withTimeout,
} from "./utils.js";
import { normalizeDraftProposalObject } from "./contentDraft.normalize.js";

export const DEBATE_ENGINE_VERSION = "final-v10.0-multitenant-industry-aware";
console.log(`[debateEngine] LOADED ${DEBATE_ENGINE_VERSION}`);

const DEFAULT_AGENTS = ["orion", "nova", "atlas", "echo"];

function ensureOpenAI() {
  const key = String(cfg.OPENAI_API_KEY || "").trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function s(v) {
  return String(v ?? "").trim();
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function uniqStrings(input = []) {
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const val = s(item);
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(val);
  }
  return out;
}

function joinText(arrInput = [], fallback = "") {
  const out = arr(arrInput)
    .map((x) => {
      if (typeof x === "string") return s(x);
      if (x && typeof x === "object") {
        return s(x.name || x.title || x.label || x.value || "");
      }
      return "";
    })
    .filter(Boolean);

  return out.length ? out.join(", ") : fallback;
}

function todayInBaku() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Baku",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    const map = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = p.value;
    }

    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeMode(mode) {
  const m0 = String(mode || "").trim().toLowerCase();

  if (
    m0 === "content_publish" ||
    m0 === "publish_pack" ||
    m0 === "content.publish"
  ) return "publish";

  if (m0 === "content_revise" || m0 === "content.revise") return "revise";
  if (m0 === "content_draft" || m0 === "content.draft") return "draft";
  if (m0 === "trend_research" || m0 === "trend.research") return "trend";

  if (
    m0 === "comment" ||
    m0 === "meta_comment_reply" ||
    m0 === "meta.comment_reply"
  ) return "meta_comment";

  return m0;
}

function pickUsecaseFromMode(mode) {
  const m = normalizeMode(mode);
  if (m === "draft") return "content.draft";
  if (m === "revise") return "content.revise";
  if (m === "publish") return "content.publish";
  if (m === "trend") return "trend.research";
  if (m === "meta_comment") return "meta.comment_reply";
  return null;
}

function modeExpectsJson(mode) {
  const m0 = normalizeMode(mode);
  if (m0 === "meta_comment") return false;
  return ["proposal", "draft", "trend", "publish", "revise"].includes(m0);
}

function normalizeHashtagTag(tag) {
  const t = s(tag);
  if (!t) return "";
  return t.startsWith("#") ? t : `#${t}`;
}

function buildTenantRuntime(tenantInput, tenantId) {
  const t = obj(tenantInput);
  const profile = obj(t.profile);
  const brand = obj(t.brand);
  const meta = obj(t.meta);
  const aiPolicy = obj(t.ai_policy || t.aiPolicy);

  const resolvedTenantId =
    s(tenantId || t.tenantId || t.tenantKey || t.tenant_key || t.id) || "default";

  const companyName =
    s(
      brand.displayName ||
        brand.name ||
        profile.displayName ||
        profile.companyName ||
        t.companyName ||
        t.brandName ||
        t.name ||
        meta.companyName
    ) || resolvedTenantId;

  const industryKey = normalizeIndustryKey(
    t.industryKey ||
      t.industry ||
      profile.industryKey ||
      profile.industry ||
      brand.industryKey ||
      brand.industry ||
      meta.industryKey ||
      "generic_business"
  );

  const defaultLanguage = s(
    t.defaultLanguage ||
      t.language ||
      profile.defaultLanguage ||
      profile.language ||
      brand.defaultLanguage ||
      brand.language ||
      "az"
  ) || "az";

  const outputLanguage =
    s(
      t.outputLanguage ||
        profile.outputLanguage ||
        brand.outputLanguage ||
        t.language ||
        profile.language ||
        brand.language
    ) || defaultLanguage;

  const requiredHashtags = uniqStrings(
    arr(
      t.requiredHashtags ||
        brand.requiredHashtags ||
        profile.requiredHashtags ||
        []
    )
      .map(normalizeHashtagTag)
      .filter(Boolean)
  ).slice(0, 18);

  const preferredPresets = uniqStrings(
    arr(
      t.preferredPresets ||
        brand.preferredPresets ||
        profile.preferredPresets ||
        []
    )
      .map((x) => {
        if (typeof x === "string") return s(x);
        if (x && typeof x === "object") {
          return s(x.name || x.key || x.value || x.label);
        }
        return "";
      })
      .filter(Boolean)
  ).slice(0, 12);

  const audiences = uniqStrings(
    arr(t.audiences || brand.audiences || profile.audiences || [])
      .map((x) => {
        if (typeof x === "string") return s(x);
        if (x && typeof x === "object") {
          return s(x.name || x.title || x.label || x.value);
        }
        return "";
      })
      .filter(Boolean)
  ).slice(0, 12);

  const services = uniqStrings(
    arr(t.services || brand.services || profile.services || [])
      .map((x) => {
        if (typeof x === "string") return s(x);
        if (x && typeof x === "object") {
          return s(x.name || x.title || x.label || x.value);
        }
        return "";
      })
      .filter(Boolean)
  ).slice(0, 24);

  const tone = uniqStrings(
    arr(t.tone || brand.tone || profile.tone || [])
      .map((x) => {
        if (typeof x === "string") return s(x);
        if (x && typeof x === "object") {
          return s(x.name || x.title || x.label || x.value);
        }
        return "";
      })
      .filter(Boolean)
  ).slice(0, 16);

  const servicesText =
    s(
      t.servicesText ||
        profile.servicesText ||
        brand.servicesText ||
        aiPolicy.servicesText ||
        meta.servicesText
    ) || joinText(services);

  const audiencesText =
    s(
      t.audiencesText ||
        profile.audiencesText ||
        brand.audiencesText ||
        meta.audiencesText
    ) || joinText(audiences);

  const toneText =
    s(
      t.toneText ||
        profile.toneText ||
        brand.toneText ||
        aiPolicy.toneText ||
        meta.toneText
    ) || joinText(tone);

  const preferredPresetsText =
    s(
      t.preferredPresetsText ||
        profile.preferredPresetsText ||
        brand.preferredPresetsText ||
        meta.preferredPresetsText
    ) || joinText(preferredPresets);

  const requiredHashtagsText =
    s(
      t.requiredHashtagsText ||
        profile.requiredHashtagsText ||
        brand.requiredHashtagsText ||
        meta.requiredHashtagsText
    ) || joinText(requiredHashtags);

  const visualTheme =
    s(
      t.visualTheme ||
        profile.visualTheme ||
        brand.visualTheme ||
        meta.visualTheme
    ) || "premium_modern";

  const ctaStyle =
    s(
      t.ctaStyle ||
        profile.ctaStyle ||
        brand.ctaStyle ||
        meta.ctaStyle
    ) || "contact";

  const businessContext =
    s(
      t.businessContext ||
        profile.businessContext ||
        aiPolicy.businessContext ||
        meta.businessContext
    ) || "";

  const runtime = {
    tenantId: resolvedTenantId,
    tenantKey: resolvedTenantId,
    companyName,
    brandName: companyName,
    industryKey,
    defaultLanguage,
    outputLanguage,
    ctaStyle,
    visualTheme,
    businessContext,

    tone,
    services,
    audiences,
    requiredHashtags,
    preferredPresets,

    toneText,
    servicesText,
    audiencesText,
    requiredHashtagsText,
    preferredPresetsText,

    profile: {
      displayName: s(profile.displayName),
      companyName: s(profile.companyName),
      industryKey: normalizeIndustryKey(profile.industryKey || profile.industry || industryKey),
      defaultLanguage: s(profile.defaultLanguage || profile.language || defaultLanguage),
      outputLanguage: s(profile.outputLanguage || profile.language || outputLanguage),
      visualTheme: s(profile.visualTheme || visualTheme),
      businessContext: s(profile.businessContext),
      servicesText: s(profile.servicesText),
      audiencesText: s(profile.audiencesText),
      toneText: s(profile.toneText),
      preferredPresetsText: s(profile.preferredPresetsText),
      requiredHashtagsText: s(profile.requiredHashtagsText),
    },

    brand: {
      displayName: s(brand.displayName),
      name: s(brand.name),
      companyName: s(brand.companyName),
      industryKey: normalizeIndustryKey(brand.industryKey || brand.industry || industryKey),
      defaultLanguage: s(brand.defaultLanguage || brand.language || defaultLanguage),
      outputLanguage: s(brand.outputLanguage || brand.language || outputLanguage),
      ctaStyle: s(brand.ctaStyle || ctaStyle),
      visualTheme: s(brand.visualTheme || visualTheme),
      tone: tone,
      services: services,
      audiences: audiences,
      requiredHashtags: requiredHashtags,
      preferredPresets: preferredPresets,
      toneText: s(brand.toneText || toneText),
      servicesText: s(brand.servicesText || servicesText),
      audiencesText: s(brand.audiencesText || audiencesText),
      requiredHashtagsText: s(brand.requiredHashtagsText || requiredHashtagsText),
      preferredPresetsText: s(brand.preferredPresetsText || preferredPresetsText),
      visualStyle: obj(brand.visualStyle),
    },

    ai_policy: {
      toneText: s(aiPolicy.toneText),
      servicesText: s(aiPolicy.servicesText),
      businessContext: s(aiPolicy.businessContext),
    },

    meta,
  };

  return runtime;
}

function buildDebateExtra({
  mode,
  formatHint,
  threadId,
  extra,
}) {
  const x = obj(extra);
  const normMode = normalizeMode(mode);

  const out = {
    ...x,
    threadId: s(threadId),
    format: s(x.format || formatHint),
    mode: normMode,
  };

  if (normMode === "draft") {
    out.format = s(x.format || formatHint || "image");
  }

  if (normMode === "revise") {
    out.previousDraft = x.previousDraft || x.draft || x.content || null;
    out.feedback = s(x.feedback);
  }

  if (normMode === "publish") {
    out.approvedDraft = x.approvedDraft || x.draft || x.content || x.contentPack || null;
    out.assetUrls = x.assetUrls || x.generatedAssetUrls || [];
    out.platform = s(x.platform || "instagram").toLowerCase() || "instagram";
  }

  if (normMode === "meta_comment") {
    out.commentText = s(x.commentText || x.comment || x.text);
    out.authorName = s(x.authorName || x.username || x.author);
    out.postTopic = s(x.postTopic || x.topic);
    out.platform = s(x.platform || "instagram").toLowerCase() || "instagram";
  }

  return out;
}

function agentPrompt(agentId, message, round, notesSoFar, mode) {
  const roles = {
    orion: "Strategist: məhsul strategiyası, roadmap, KPI, risklər.",
    nova: "Creative: marketinq, kontent, offer, CTA, funnel.",
    atlas: "Sales/Ops: satış axını, CRM, WhatsApp/IG prosesləri, skript.",
    echo: "Analyst: ölçmə, data, reporting, eksperiment dizaynı.",
  };

  const role = roles[agentId] || "General expert.";

  return `
Sən AI HQ agentisən. Rolun: ${role}

QAYDALAR:
- 8-12 maddədən çox yazma.
- Konkret, icra edilə bilən yaz.
- Lazımsız uzun izah vermə.
- Heç bir halda JSON, kod bloku, {...} yazma.
- Round ${round}.
- Mode: ${normalizeMode(mode) || "answer"}.

İSTİFADƏÇİ MESAJI:
${message}

ƏVVƏLKİ QEYDLƏR (varsa):
${notesSoFar || "(yoxdur)"}

ÇIXIŞ:
- Sənin töhfən (bəndlərlə)
`.trim();
}

function visibleEmptyMarker(kind, agentId, resp) {
  const usage = resp?.usage || {};
  const outTok = usage?.output_tokens ?? null;
  const rTok = usage?.output_tokens_details?.reasoning_tokens ?? null;
  const id = resp?.id || null;
  const status = resp?.status || null;
  const model = resp?.model || null;

  return `⚠️ ${String(kind || "resp").toUpperCase()} EMPTY_TEXT (agent=${
    agentId || "-"
  } status=${status} model=${model} id=${id} outTok=${outTok} reasoningTok=${rTok})`;
}

function logRawIfEmpty(kind, agentId, resp, text) {
  if (String(text || "").trim()) return;
  if (!cfg.DEBUG_DEBATE_RAW) return;
  try {
    console.log("[debate] EMPTY", {
      kind,
      agentId,
      status: resp?.status,
      model: resp?.model,
      id: resp?.id,
    });
    const raw = JSON.stringify(resp, null, 2);
    console.log(`[debate] RAW(${kind}) first 1600:\n${raw.slice(0, 1600)}`);
  } catch {}
}

async function askAgent({
  openai,
  agentId,
  message,
  round,
  notesSoFar,
  timeoutMs,
  mode,
}) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar, mode);
  const maxOut = Number(cfg.OPENAI_DEBATE_AGENT_TOKENS || 900);

  const req = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: maxOut,
    input: [
      {
        role: "system",
        content: `You are agent "${agentId}". Follow the user's rules strictly.`,
      },
      { role: "user", content: prompt },
    ],
  };

  const resp = await withTimeout(
    openai.responses.create(req),
    timeoutMs,
    `OpenAI timeout (${agentId})`
  );

  let text = extractText(resp);

  console.log(
    "[debate] agent",
    agentId,
    "status=",
    resp?.status || null,
    "id=",
    resp?.id || null,
    "len=",
    (text || "").length
  );

  if (!String(text || "").trim()) {
    logRawIfEmpty("agent", agentId, resp, text);
    text = visibleEmptyMarker("agent", agentId, resp);
  }

  return fixMojibake(text);
}

function fallbackSynthesis(agentNotes = []) {
  const parts = [];
  for (const n of agentNotes) {
    const t = String(n?.text || "").trim();
    if (!t) continue;
    parts.push(`### ${n.agentId}\n${t}`);
  }
  return parts.join("\n\n").trim();
}

function buildSynthesisSystem({ mode, normalizedPromptInput, bundle }) {
  const usecase = pickUsecaseFromMode(mode);

  const base = `
You are AI HQ Kernel.
Follow PROMPT BUNDLE instructions strictly.
Return clean outputs.
If the usecase requires STRICT JSON: output ONLY valid JSON with no markdown and no extra text.
If the usecase requires plain text: output ONLY plain text.
`.trim();

  return [
    base,
    "",
    `MODE: ${normalizeMode(mode)}`,
    usecase ? `USECASE: ${usecase}` : "",
    "",
    "PROMPT INPUT:",
    JSON.stringify(normalizedPromptInput || {}, null, 2),
    "",
    "PROMPT BUNDLE:",
    bundle?.fullPrompt || "",
  ]
    .filter((x) => String(x || "").trim())
    .join("\n");
}

async function strictJsonRepair({ openai, badText, timeoutMs }) {
  const repairSys = `You will be given text that MUST be valid JSON but may be invalid.
Return ONLY corrected valid JSON.
Rules:
- No markdown.
- No extra text.
- Keep the same structure/keys.
- If the text contains multiple JSON objects, return the best single final object.`;

  const repairReq = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: 1800,
    input: [
      { role: "system", content: repairSys },
      { role: "user", content: String(badText || "") },
    ],
  };

  const respFix = await withTimeout(
    openai.responses.create(repairReq),
    timeoutMs,
    "OpenAI timeout (json-repair)"
  );

  const fixed = fixMojibake(extractText(respFix));
  return extractJsonFromText(fixed);
}

async function synthesizeFinal({
  openai,
  message,
  agentNotes,
  mode,
  timeoutMs,
  vars,
}) {
  const normMode = normalizeMode(mode);
  const usecase = pickUsecaseFromMode(normMode);

  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const normalizedPromptInput = normalizePromptInput(usecase || normMode, {
    tenant: vars.tenant,
    today: vars.today,
    format: vars.format,
    extra: vars.extra,
  });

  const bundle = buildPromptBundle(usecase || normMode, {
    tenant: normalizedPromptInput.tenant,
    today: normalizedPromptInput.today,
    format: normalizedPromptInput.format,
    extra: normalizedPromptInput.extra,
  });

  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 2600);
  const sysText = buildSynthesisSystem({
    mode: normMode,
    normalizedPromptInput,
    bundle,
  });

  const userText = `
USER_REQUEST:
${message}

AGENT_NOTES:
${notesText || "(empty)"}
`.trim();

  const reqText = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: maxOut,
    input: [
      { role: "system", content: sysText },
      { role: "user", content: userText },
    ],
  };

  const respText = await withTimeout(
    openai.responses.create(reqText),
    timeoutMs,
    "OpenAI timeout (synthesis)"
  );

  let outText = extractText(respText);

  if (!String(outText || "").trim()) {
    logRawIfEmpty("synth", "kernel", respText, outText);
    outText = visibleEmptyMarker("synth", "kernel", respText);
  }

  outText = fixMojibake(String(outText || "").trim());
  if (!outText) outText = fallbackSynthesis(agentNotes);

  const expectsJson = modeExpectsJson(normMode);

  if (!expectsJson) {
    return {
      finalAnswer: outText,
      proposal: null,
      promptBundle: bundle,
      normalizedPromptInput,
    };
  }

  let obj = extractJsonFromText(outText);

  if (!obj) {
    try {
      obj = await strictJsonRepair({ openai, badText: outText, timeoutMs });
    } catch {}
  }

  if (normMode === "proposal") {
    if (!obj || typeof obj !== "object") obj = null;
    return {
      finalAnswer: outText,
      proposal: obj,
      promptBundle: bundle,
      normalizedPromptInput,
    };
  }

  if (normMode === "draft") {
    const proposal = normalizeDraftProposalObject(obj || { raw: outText }, normalizedPromptInput);
    return {
      finalAnswer: outText,
      proposal,
      promptBundle: bundle,
      normalizedPromptInput,
    };
  }

  if (obj && typeof obj === "object") {
    if (obj.type && obj.payload) {
      return {
        finalAnswer: outText,
        proposal: obj,
        promptBundle: bundle,
        normalizedPromptInput,
      };
    }

    return {
      finalAnswer: outText,
      proposal: {
        type: String(normMode),
        title: String(
          obj.title || obj.summary || obj.topic || obj.name || "Draft"
        ).slice(0, 120),
        payload: obj,
      },
      promptBundle: bundle,
      normalizedPromptInput,
    };
  }

  return {
    finalAnswer: outText,
    proposal: {
      type: String(normMode),
      title: "Draft",
      payload: { raw: outText },
    },
    promptBundle: bundle,
    normalizedPromptInput,
  };
}

export async function runDebate({
  message,
  agents = DEFAULT_AGENTS,
  rounds = 2,
  mode = "answer",
  tenantId = "default",
  tenant = null,
  threadId = "",
  formatHint = null,
  extra = {},
}) {
  const openai = ensureOpenAI();
  if (!openai) {
    return {
      finalAnswer: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.",
      agentNotes: DEFAULT_AGENTS.map((a) => ({ agentId: a, text: "" })),
      proposal: null,
    };
  }

  const agentIds = (Array.isArray(agents) ? agents : DEFAULT_AGENTS)
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const rCount = clamp(Number(rounds || 2), 1, 3);
  const timeoutMs = Number(cfg.OPENAI_TIMEOUT_MS || 25_000);
  const concurrency = clamp(Number(cfg.OPENAI_DEBATE_CONCURRENCY || 2), 1, 4);

  const agentNotes = [];
  let notesSoFar = "";

  for (let round = 1; round <= rCount; round++) {
    const roundNotes = await mapLimit(
      agentIds,
      concurrency,
      async (agentId) => {
        try {
          const text = await askAgent({
            openai,
            agentId,
            message,
            round,
            notesSoFar,
            timeoutMs,
            mode,
          });
          return { agentId, text: fixMojibake(text || "") };
        } catch (e) {
          return { agentId, text: `⚠️ failed: ${String(e?.message || e)}` };
        }
      }
    );

    agentNotes.push(...roundNotes);
    notesSoFar = agentNotes.map((n) => `[${n.agentId}] ${n.text}`).join("\n\n");
  }

  const tenantRuntime = buildTenantRuntime(tenant, tenantId);
  const debateExtra = buildDebateExtra({
    mode,
    formatHint,
    threadId,
    extra,
  });

  const normalizedMode = normalizeMode(mode);
  const resolvedFormat =
    s(formatHint || debateExtra.format) || (normalizedMode === "draft" ? "image" : "auto");

  const vars = {
    tenantId: tenantRuntime.tenantId,
    tenant: tenantRuntime,
    threadId: s(threadId),
    format: resolvedFormat,
    today: todayInBaku(),
    mode: normalizedMode,
    extra: debateExtra,
  };

  const synth = await synthesizeFinal({
    openai,
    message,
    agentNotes,
    mode: normalizedMode,
    timeoutMs,
    vars,
  });

  return {
    finalAnswer: fixMojibake(synth.finalAnswer),
    agentNotes: agentNotes.map((n) => ({
      agentId: n.agentId,
      text: fixMojibake(n.text),
    })),
    proposal: synth.proposal,
    promptBundle: synth.promptBundle || null,
    normalizedPromptInput: synth.normalizedPromptInput || null,
  };
}