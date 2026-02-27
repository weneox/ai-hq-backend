// src/kernel/agentKernel.js
import OpenAI from "openai";
import { cfg } from "../config.js";

const AGENTS = {
  orion: {
    name: "Orion",
    role: "Strategist",
    system:
      "You are Orion, a business strategist. Give structured, concise guidance. If asked for a plan, give numbered steps. End with 1 clarifying question.",
  },
  nova: {
    name: "Nova",
    role: "Content & Instagram",
    system:
      "You are Nova, social/content specialist. Provide content ideas, hooks, formats, posting plan. Be concise. End with 1 question.",
  },
  atlas: {
    name: "Atlas",
    role: "Sales & WhatsApp",
    system:
      "You are Atlas, sales & funnel specialist. Provide sales funnel steps, messaging, WhatsApp automation. Be concise. End with 1 question.",
  },
  echo: {
    name: "Echo",
    role: "Analytics",
    system:
      "You are Echo, analytics specialist. Provide KPIs, tracking plan, measurement. Be concise. End with 1 question.",
  },
};

export function listAgents() {
  return Object.keys(AGENTS).map((k) => ({
    id: k,
    name: AGENTS[k].name,
    role: AGENTS[k].role,
  }));
}

const openai = cfg.OPENAI_API_KEY ? new OpenAI({ apiKey: cfg.OPENAI_API_KEY }) : null;

function pickString(x) {
  return typeof x === "string" ? x : "";
}

function extractFromOutputArray(output) {
  if (!Array.isArray(output)) return "";
  let out = "";

  for (const item of output) {
    const content = item?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        // prefer block.text (common)
        const t = pickString(block?.text);
        if (t) out += t;
      }
    } else if (typeof content === "string") {
      out += content;
    }

    const t2 = pickString(item?.text);
    if (t2) out += t2;
  }

  return out.trim();
}

function extractText(resp) {
  const direct = pickString(resp?.output_text).trim();
  if (direct) return direct;

  const fromOutput = extractFromOutputArray(resp?.output);
  if (fromOutput) return fromOutput;

  const msgContent = resp?.message?.content;
  if (typeof msgContent === "string" && msgContent.trim()) return msgContent.trim();

  const chatLike = resp?.choices?.[0]?.message?.content;
  if (typeof chatLike === "string" && chatLike.trim()) return chatLike.trim();

  const chatBlocks = resp?.choices?.[0]?.message?.content;
  if (Array.isArray(chatBlocks)) {
    const t = chatBlocks.map((b) => pickString(b?.text)).join("").trim();
    if (t) return t;
  }

  return "";
}

function clampModelName(model) {
  const m = String(model || "").trim();
  return m || "gpt-4.1-mini";
}

function normalizeUserMessage(message) {
  return String(message || "").trim();
}

export async function kernelHandle({ message, agentHint } = {}) {
  const text = normalizeUserMessage(message);
  const agentId = (String(agentHint || "orion").trim().toLowerCase() || "orion");
  const agent = AGENTS[agentId] ? agentId : "orion";

  if (!openai) {
    return { ok: false, agent, replyText: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.", proposal: null };
  }

  const model = clampModelName(cfg.OPENAI_MODEL);

  try {
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 450),
      input: [
        { role: "system", content: AGENTS[agent].system },
        { role: "user", content: text },
      ],
    });

    const replyText = extractText(resp);

    if (!replyText) {
      const status = resp?.status || null;
      return {
        ok: true,
        agent,
        replyText: `Cavab boş gəldi (model=${model}, status=${status}). Tövsiyə: /api/debug/openai ilə raw cavabı yoxla.`,
        proposal: null,
      };
    }

    return { ok: true, agent, replyText, proposal: null };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, agent, replyText: `OpenAI xətası: ${msg}`, proposal: null };
  }
}

export async function debugOpenAI({ agent = "orion", message = "ping" } = {}) {
  if (!openai) return { ok: false, status: null, agent, extractedText: "", raw: "OpenAI disabled" };

  const model = clampModelName(cfg.OPENAI_MODEL);
  const a = AGENTS[agent] ? agent : "orion";

  try {
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 450),
      input: [
        { role: "system", content: AGENTS[a].system },
        { role: "user", content: normalizeUserMessage(message) },
      ],
    });

    const extractedText = extractText(resp);
    return { ok: true, status: resp?.status || null, agent: a, extractedText, raw: JSON.stringify(resp, null, 2) };
  } catch (e) {
    return { ok: false, status: e?.status || null, agent: a, extractedText: "", raw: String(e?.message || e) };
  }
}