// src/kernel/agentKernel.js (FINAL v2.1 — FIX: remove unsupported reasoning.effort)
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

function extractText(resp) {
  if (!resp) return "";

  const direct = pickString(resp.output_text).trim();
  if (direct) return direct;

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
    if (joined) return joined;
  }

  // legacy fallback
  const choices = resp?.choices;
  if (Array.isArray(choices)) {
    const parts = [];
    for (const c of choices) {
      const t = pickString(c?.message?.content);
      if (t) parts.push(t);
    }
    const joined = parts.join("\n").trim();
    if (joined) return joined;
  }

  return "";
}

function clampModelName(model) {
  const m = String(model || "").trim();
  return m || "gpt-5";
}

function normalizeUserMessage(message) {
  return String(message || "").trim();
}

function ensureOpenAI() {
  const key = String(cfg.OPENAI_API_KEY || "").trim();
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function makeEmptyHelp(resp, model) {
  const status = resp?.status || null;
  const id = resp?.id || null;
  const usage = resp?.usage || {};
  const outTok = usage?.output_tokens ?? null;
  const reasonTok = usage?.output_tokens_details?.reasoning_tokens ?? null;

  const hint =
    status === "incomplete"
      ? "Model cavabı yarımçıq bağladı (çox vaxt token limiti). OPENAI_MAX_OUTPUT_TOKENS artır."
      : "Raw cavabı /api/debug/openai ilə yoxla.";

  return `Cavab boş gəldi (model=${model}, status=${status}, id=${id}, outTok=${outTok}, reasoningTok=${reasonTok}). ${hint}`;
}

export async function kernelHandle({ message, agentHint } = {}) {
  const text = normalizeUserMessage(message);
  const agentId = (String(agentHint || "orion").trim().toLowerCase() || "orion");
  const agent = AGENTS[agentId] ? agentId : "orion";

  const openai = ensureOpenAI();
  if (!openai) {
    return { ok: false, agent, replyText: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.", proposal: null };
  }

  const model = clampModelName(cfg.OPENAI_MODEL);

  try {
    const maxTok = Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 800);

    // ✅ FIX: remove reasoning.effort (some models reject it with 400)
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: maxTok,
      input: [
        { role: "system", content: AGENTS[agent].system },
        { role: "user", content: text },
      ],
    });

    const replyText = extractText(resp);

    if (!String(replyText || "").trim()) {
      return { ok: true, agent, replyText: makeEmptyHelp(resp, model), proposal: null };
    }

    return { ok: true, agent, replyText, proposal: null };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, agent, replyText: `OpenAI xətası: ${msg}`, proposal: null };
  }
}

export async function debugOpenAI({ agent = "orion", message = "ping" } = {}) {
  const openai = ensureOpenAI();
  if (!openai) return { ok: false, status: null, agent, extractedText: "", raw: "OpenAI disabled" };

  const model = clampModelName(cfg.OPENAI_MODEL);
  const a = AGENTS[agent] ? agent : "orion";

  try {
    const maxTok = Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 800);

    // ✅ FIX: remove reasoning.effort
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
      max_output_tokens: maxTok,
      input: [
        { role: "system", content: AGENTS[a].system },
        { role: "user", content: normalizeUserMessage(message) },
      ],
    });

    const extractedText = extractText(resp);

    return {
      ok: true,
      status: resp?.status || null,
      agent: a,
      extractedText,
      raw: JSON.stringify(resp, null, 2),
    };
  } catch (e) {
    return {
      ok: false,
      status: e?.status || null,
      agent: a,
      extractedText: "",
      raw: String(e?.message || e),
    };
  }
}