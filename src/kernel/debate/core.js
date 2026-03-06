// src/kernel/debate/core.js

import OpenAI from "openai";
import { cfg } from "../../config.js";
import { getGlobalPolicy, getUsecasePrompt } from "../../prompts/index.js";
import {
  clamp,
  extractJsonFromText,
  extractText,
  fixMojibake,
  mapLimit,
  withTimeout,
} from "./utils.js";
import { normalizeDraftProposalObject } from "./contentDraft.normalize.js";

export const DEBATE_ENGINE_VERSION = "final-v8.1-modular";
console.log(`[debateEngine] LOADED ${DEBATE_ENGINE_VERSION}`);

const DEFAULT_AGENTS = ["orion", "nova", "atlas", "echo"];

function ensureOpenAI() {
  const key = String(cfg.OPENAI_API_KEY || "").trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function agentPrompt(agentId, message, round, notesSoFar) {
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
}) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);
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

function pickUsecaseFromMode(mode) {
  const m0 = String(mode || "").trim().toLowerCase();

  const m =
    m0 === "content_publish" ||
    m0 === "publish_pack" ||
    m0 === "content.publish"
      ? "publish"
      : m0 === "content_revise" || m0 === "content.revise"
      ? "revise"
      : m0 === "content_draft" || m0 === "content.draft"
      ? "draft"
      : m0 === "trend_research" || m0 === "trend.research"
      ? "trend"
      : m0 === "comment" ||
        m0 === "meta_comment_reply" ||
        m0 === "meta.comment_reply"
      ? "meta_comment"
      : m0;

  if (m === "draft") return "content.draft";
  if (m === "revise") return "content.revise";
  if (m === "publish") return "content.publish";
  if (m === "trend") return "trend.research";
  if (m === "meta_comment") return "meta.comment_reply";

  return null;
}

function normalizeMode(mode) {
  const m0 = String(mode || "").trim().toLowerCase();
  if (
    m0 === "content_publish" ||
    m0 === "publish_pack" ||
    m0 === "content.publish"
  )
    return "publish";
  if (m0 === "content_revise" || m0 === "content.revise") return "revise";
  if (m0 === "content_draft" || m0 === "content.draft") return "draft";
  if (m0 === "trend_research" || m0 === "trend.research") return "trend";
  if (
    m0 === "comment" ||
    m0 === "meta_comment_reply" ||
    m0 === "meta.comment_reply"
  )
    return "meta_comment";
  return m0;
}

function modeExpectsJson(mode) {
  const m0 = String(mode || "").trim().toLowerCase();
  if (m0 === "meta_comment") return false;
  return ["proposal", "draft", "trend", "publish", "revise"].includes(m0);
}

function buildSynthesisSystem({ mode, vars }) {
  const global = getGlobalPolicy(vars);
  const usecase = pickUsecaseFromMode(mode);
  const ucText = usecase ? getUsecasePrompt(usecase, vars) : "";

  const base = `
You are AI HQ Kernel.
Follow GLOBAL POLICY and USECASE instructions strictly.
Return clean outputs.
If USECASE requires STRICT JSON: output ONLY valid JSON (no markdown, no extra text).
If USECASE requires plain text: output ONLY plain text.
`.trim();

  return [
    base,
    "",
    "GLOBAL POLICY:",
    global || "(missing policy.global.txt)",
    "",
    usecase ? `USECASE: ${usecase}` : "",
    usecase ? ucText : "",
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

  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 2600);
  const sysText = buildSynthesisSystem({ mode: normMode, vars });

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
    return { finalAnswer: outText, proposal: null };
  }

  let obj = extractJsonFromText(outText);

  if (!obj) {
    try {
      obj = await strictJsonRepair({ openai, badText: outText, timeoutMs });
    } catch {}
  }

  if (normMode === "proposal") {
    if (!obj || typeof obj !== "object") obj = null;
    return { finalAnswer: outText, proposal: obj };
  }

  if (normMode === "draft") {
    const proposal = normalizeDraftProposalObject(obj || { raw: outText }, vars);
    return { finalAnswer: outText, proposal };
  }

  if (obj && typeof obj === "object") {
    if (obj.type && obj.payload) {
      return { finalAnswer: outText, proposal: obj };
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
    };
  }

  return {
    finalAnswer: outText,
    proposal: {
      type: String(normMode),
      title: "Draft",
      payload: { raw: outText },
    },
  };
}

export async function runDebate({
  message,
  agents = DEFAULT_AGENTS,
  rounds = 2,
  mode = "answer",
  tenantId = "default",
  threadId = "",
  formatHint = null,
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

  const vars = {
    tenantId: String(tenantId || "default"),
    threadId: String(threadId || ""),
    format: String(formatHint || "").trim() || "auto",
    today: new Date().toISOString().slice(0, 10),
    mode: normalizeMode(mode),
  };

  const synth = await synthesizeFinal({
    openai,
    message,
    agentNotes,
    mode: normalizeMode(mode),
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
  };
}