// src/kernel/agentKernel.js
//
// FINAL v4.0 — professional structured kernel
//
// Goals:
// ✅ keep tenant / industry / usecase prompt bundle pipeline
// ✅ keep mojibake repair
// ✅ support agent registry
// ✅ support usecase registry
// ✅ support text + json output modes
// ✅ standard result envelope
// ✅ safe JSON parsing with 1 repair attempt
// ✅ keep debug path
// ✅ future-ready for content.analyze + content.fix_plan

import OpenAI from "openai";
import { cfg } from "../config.js";
import { normalizePromptInput } from "../services/promptInput.js";
import { buildPromptBundle } from "../services/promptBundle.js";
import {
  getAgent,
  getAgentSystem,
  getAgentOutputMode,
  getAgentDefaultModel,
  getAgentMaxOutputTokens,
  listAgents,
} from "./agentRegistry.js";
import {
  getUsecase,
  getUsecaseDefaultAgent,
  getUsecaseOutputMode,
  getUsecaseSchemaKey,
  getUsecaseRetryLimit,
} from "./usecaseRegistry.js";

export { listAgents };

function s(v, d = "") {
  return String(v ?? d).trim();
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

// ✅ Mojibake repair
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

  const choices = resp?.choices;
  if (Array.isArray(choices)) {
    const parts = [];
    for (const c of choices) {
      const t = pickString(c?.message?.content);
      if (t) parts.push(t);
    }
    const joined = parts.join("\n").trim();
    if (joined) return fixMojibake(joined);
  }

  return "";
}

function clampModelName(model) {
  const m = s(model);
  return m || s(cfg.OPENAI_MODEL, "gpt-5");
}

function normalizeUserMessage(message) {
  return s(message);
}

function ensureOpenAI() {
  const key = s(cfg.OPENAI_API_KEY);
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function buildAgentSystemBlock(agentId) {
  const agent = getAgent(agentId);
  return [
    `AGENT_ID: ${agent.id}`,
    `AGENT_NAME: ${agent.name}`,
    `AGENT_ROLE: ${agent.role}`,
    "",
    "AGENT SYSTEM:",
    getAgentSystem(agentId),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSystem({
  agentId,
  usecase,
  tenant = null,
  today = "",
  format = "",
  extra = {},
}) {
  const normalized = normalizePromptInput(usecase || "", {
    tenant,
    today,
    format,
    extra,
  });

  const bundle = buildPromptBundle(usecase || "", {
    tenant: normalized.tenant,
    today: normalized.today,
    format: normalized.format,
    extra: normalized.extra,
  });

  const usecaseDef = getUsecase(usecase || "general.chat");

  const parts = [
    buildAgentSystemBlock(agentId),
    "",
    "USECASE:",
    s(usecaseDef.key || usecase || "general.chat"),
  ];

  if (bundle?.fullPrompt) {
    parts.push("", "PROMPT BUNDLE:", bundle.fullPrompt);
  }

  return {
    systemText: parts.filter(Boolean).join("\n"),
    normalized,
    bundle,
    usecaseDef,
  };
}

function buildEmptyResult({
  ok = false,
  status = "failed",
  agent = "orion",
  usecase = "general.chat",
  model = "",
  mode = "text",
  replyText = "",
  structured = null,
  warnings = [],
  usage = null,
  raw = null,
} = {}) {
  return {
    ok,
    status,
    agent,
    usecase,
    model,
    mode,
    replyText,
    structured,
    warnings: Array.isArray(warnings) ? warnings : [],
    usage: usage || null,
    raw: raw ?? null,
    proposal: null,
  };
}

function usageFromResp(resp) {
  if (!resp || typeof resp !== "object") return null;
  const usage = resp.usage || {};
  return {
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    total_tokens:
      typeof usage?.total_tokens === "number"
        ? usage.total_tokens
        : null,
  };
}

function makeEmptyHelp(resp, model, mode) {
  const status = resp?.status || null;
  const id = resp?.id || null;
  const usage = resp?.usage || {};
  const outTok = usage?.output_tokens ?? null;
  const reasonTok = usage?.output_tokens_details?.reasoning_tokens ?? null;

  const hint =
    status === "incomplete"
      ? "Model cavabı yarımçıq bağladı. Token limitini artırmaq lazım ola bilər."
      : mode === "json"
      ? "Structured cavab alınmadı. JSON parse / repair lazımdır."
      : "Raw cavabı debug ilə yoxlamaq lazımdır.";

  return `Cavab boş gəldi (model=${model}, status=${status}, id=${id}, outTok=${outTok}, reasoningTok=${reasonTok}). ${hint}`;
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: s(e?.message || e) };
  }
}

function extractJsonObjectString(text) {
  const src = s(text);
  if (!src) return "";

  const first = src.indexOf("{");
  const last = src.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return src.slice(first, last + 1).trim();
  }

  const arrFirst = src.indexOf("[");
  const arrLast = src.lastIndexOf("]");
  if (arrFirst >= 0 && arrLast > arrFirst) {
    return src.slice(arrFirst, arrLast + 1).trim();
  }

  return src;
}

async function repairJsonOnce(openai, { model, badText }) {
  const repairPrompt = [
    "Repair the following into valid strict JSON.",
    "Return JSON only.",
    "Do not add markdown.",
    "Do not explain.",
    "",
    badText,
  ].join("\n");

  const resp = await openai.responses.create({
    model,
    text: { format: { type: "text" } },
    max_output_tokens: 1200,
    input: [{ role: "user", content: repairPrompt }],
  });

  return fixMojibake(extractText(resp));
}

async function parseStructuredOutput(openai, {
  replyText,
  model,
  retryLimit = 1,
}) {
  const warnings = [];
  const direct = s(replyText);

  if (!direct) {
    return {
      ok: false,
      structured: null,
      warnings: ["empty_structured_response"],
    };
  }

  const firstTry = safeJsonParse(direct);
  if (firstTry.ok) {
    return {
      ok: true,
      structured: firstTry.value,
      warnings,
    };
  }

  const extracted = extractJsonObjectString(direct);
  if (extracted && extracted !== direct) {
    const secondTry = safeJsonParse(extracted);
    if (secondTry.ok) {
      warnings.push("json_extracted_from_text");
      return {
        ok: true,
        structured: secondTry.value,
        warnings,
      };
    }
  }

  if (retryLimit > 0) {
    try {
      const repaired = await repairJsonOnce(openai, {
        model,
        badText: direct,
      });

      const repairedTry = safeJsonParse(extractJsonObjectString(repaired));
      if (repairedTry.ok) {
        warnings.push("json_repaired_once");
        return {
          ok: true,
          structured: repairedTry.value,
          warnings,
        };
      }

      warnings.push("json_repair_failed");
      return {
        ok: false,
        structured: null,
        warnings,
      };
    } catch (e) {
      warnings.push(`json_repair_error:${s(e?.message || e)}`);
      return {
        ok: false,
        structured: null,
        warnings,
      };
    }
  }

  warnings.push(`json_parse_failed:${firstTry.error || "unknown"}`);
  return {
    ok: false,
    structured: null,
    warnings,
  };
}

function inferAgent(agentHint, usecase) {
  const hinted = s(agentHint).toLowerCase();
  if (hinted) return hinted;
  return getUsecaseDefaultAgent(usecase || "general.chat");
}

function inferMode(agentId, usecase) {
  return (
    getUsecaseOutputMode(usecase || "general.chat") ||
    getAgentOutputMode(agentId || "orion") ||
    "text"
  );
}

function inferModel(agentId) {
  return clampModelName(
    getAgentDefaultModel(agentId) ||
      s(cfg.OPENAI_MODEL)
  );
}

function inferMaxTokens(agentId) {
  return (
    getAgentMaxOutputTokens(agentId) ||
    Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 800)
  );
}

function getSchemaNote(usecase) {
  const schemaKey = s(getUsecaseSchemaKey(usecase));
  if (!schemaKey) return "";
  return `Expected structured schema: ${schemaKey}`;
}

export async function kernelHandle({
  message,
  agentHint,
  usecase = "general.chat",
  tenant = null,
  today = "",
  format = "",
  extra = {},
} = {}) {
  const text = normalizeUserMessage(message);
  const normalizedUsecase = s(usecase, "general.chat");
  const agent = inferAgent(agentHint, normalizedUsecase);
  const mode = inferMode(agent, normalizedUsecase);

  const openai = ensureOpenAI();
  if (!openai) {
    return buildEmptyResult({
      ok: false,
      status: "failed",
      agent,
      usecase: normalizedUsecase,
      model: "",
      mode,
      replyText: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.",
      structured: null,
    });
  }

  const model = inferModel(agent);
  const maxTok = inferMaxTokens(agent);

  try {
    const built = buildSystem({
      agentId: agent,
      usecase: normalizedUsecase,
      tenant,
      today,
      format,
      extra,
    });

    const systemText = [
      built.systemText,
      mode === "json" ? "" : "",
      mode === "json" ? "OUTPUT MODE: STRICT JSON" : "OUTPUT MODE: TEXT",
      mode === "json" ? getSchemaNote(normalizedUsecase) : "",
    ]
      .filter(Boolean)
      .join("\n");

    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: maxTok,
      input: [
        {
          role: "system",
          content: systemText,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const replyText = fixMojibake(extractText(resp));
    const usage = usageFromResp(resp);

    if (!s(replyText)) {
      return buildEmptyResult({
        ok: false,
        status: "empty",
        agent,
        usecase: normalizedUsecase,
        model,
        mode,
        replyText: makeEmptyHelp(resp, model, mode),
        structured: null,
        usage,
        raw: null,
      });
    }

    if (mode === "json") {
      const parsed = await parseStructuredOutput(openai, {
        replyText,
        model,
        retryLimit: getUsecaseRetryLimit(normalizedUsecase),
      });

      if (!parsed.ok) {
        return buildEmptyResult({
          ok: false,
          status: "invalid",
          agent,
          usecase: normalizedUsecase,
          model,
          mode,
          replyText,
          structured: null,
          warnings: parsed.warnings,
          usage,
          raw: s(cfg.DEBUG_DEBATE_RAW) === "true" ? resp : null,
        });
      }

      return buildEmptyResult({
        ok: true,
        status: "completed",
        agent,
        usecase: normalizedUsecase,
        model,
        mode,
        replyText,
        structured: parsed.structured,
        warnings: parsed.warnings,
        usage,
        raw: null,
      });
    }

    return buildEmptyResult({
      ok: true,
      status: "completed",
      agent,
      usecase: normalizedUsecase,
      model,
      mode,
      replyText,
      structured: null,
      warnings: [],
      usage,
      raw: null,
    });
  } catch (e) {
    const msg = fixMojibake(s(e?.message || e));
    return buildEmptyResult({
      ok: false,
      status: "failed",
      agent,
      usecase: normalizedUsecase,
      model,
      mode,
      replyText: `OpenAI xətası: ${msg}`,
      structured: null,
      warnings: [],
      usage: null,
      raw: null,
    });
  }
}

export async function debugOpenAI({
  agent = "",
  message = "ping",
  usecase = "general.chat",
  tenant = null,
  today = "",
  format = "",
  extra = {},
} = {}) {
  const openai = ensureOpenAI();
  const normalizedUsecase = s(usecase, "general.chat");
  const chosenAgent = inferAgent(agent, normalizedUsecase);
  const mode = inferMode(chosenAgent, normalizedUsecase);
  const model = inferModel(chosenAgent);

  if (!openai) {
    return {
      ok: false,
      status: null,
      agent: chosenAgent,
      usecase: normalizedUsecase,
      mode,
      extractedText: "",
      structured: null,
      raw: "OpenAI disabled",
    };
  }

  try {
    const maxTok = inferMaxTokens(chosenAgent);

    const built = buildSystem({
      agentId: chosenAgent,
      usecase: normalizedUsecase,
      tenant,
      today,
      format,
      extra,
    });

    const systemText = [
      built.systemText,
      mode === "json" ? "OUTPUT MODE: STRICT JSON" : "OUTPUT MODE: TEXT",
      mode === "json" ? getSchemaNote(normalizedUsecase) : "",
    ]
      .filter(Boolean)
      .join("\n");

    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: maxTok,
      input: [
        { role: "system", content: systemText },
        { role: "user", content: normalizeUserMessage(message) },
      ],
    });

    const extractedText = fixMojibake(extractText(resp));
    let structured = null;
    let parseWarnings = [];

    if (mode === "json" && extractedText) {
      const parsed = await parseStructuredOutput(openai, {
        replyText: extractedText,
        model,
        retryLimit: getUsecaseRetryLimit(normalizedUsecase),
      });
      structured = parsed.structured;
      parseWarnings = parsed.warnings || [];
    }

    return {
      ok: true,
      status: resp?.status || null,
      agent: chosenAgent,
      usecase: normalizedUsecase,
      mode,
      model,
      extractedText,
      structured,
      parseWarnings,
      promptBundle: built.bundle,
      normalizedPromptInput: built.normalized,
      raw: JSON.stringify(resp, null, 2),
    };
  } catch (e) {
    return {
      ok: false,
      status: e?.status || null,
      agent: chosenAgent,
      usecase: normalizedUsecase,
      mode,
      model,
      extractedText: "",
      structured: null,
      raw: fixMojibake(s(e?.message || e)),
    };
  }
}