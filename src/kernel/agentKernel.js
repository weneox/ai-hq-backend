// src/kernel/agentKernel.js  (FINAL — FIXED output_text extraction)
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

// Handles: "string", {value:"..."}, {text:"..."}
function pickStringDeep(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    if (typeof x.value === "string") return x.value;
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

/**
 * ✅ FINAL extractor (matches your raw Response shape):
 * output: [
 *   { type:"message", content:[ { type:"output_text", text:"..." } ] }
 * ]
 */
function extractText(resp) {
  if (!resp) return "";

  // Top-level convenience
  const direct = pickString(resp.output_text).trim();
  if (direct) return direct;

  // Some SDK wrappers (rare)
  const direct2 = pickString(resp?.outputText).trim();
  if (direct2) return direct2;

  // Standard output parse
  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];

    for (const item of out) {
      const content = item?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          // ✅ critical: output_text block
          if (block?.type === "output_text") {
            const t = pickStringDeep(block?.text);
            if (t) parts.push(t);
            continue;
          }

          // fallbacks
          const t1 = pickStringDeep(block?.text);
          if (t1) parts.push(t1);

          const t2 = pickStringDeep(block?.transcript);
          if (t2) parts.push(t2);

          const t3 = pickStringDeep(block?.output_text);
          if (t3) parts.push(t3);
        }
      } else if (typeof content === "string") {
        parts.push(content);
      }

      const tItem = pickStringDeep(item?.text);
      if (tItem) parts.push(tItem);
    }

    const joined = parts.join("").trim();
    if (joined) return joined;
  }

  // Legacy chat-completions fallback (rare)
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

  // Deep scan fallback (last resort)
  try {
    const seen = new Set();
    const parts = [];

    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (typeof node.output_text === "string") parts.push(node.output_text);

      if (node.type === "output_text") {
        const t = pickStringDeep(node.text);
        if (t) parts.push(t);
      }

      const t2 = pickStringDeep(node.text);
      if (t2) parts.push(t2);

      const tr = pickStringDeep(node.transcript);
      if (tr) parts.push(tr);

      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };

    walk(resp);
    const joined = parts.join("").trim();
    if (joined) return joined;
  } catch {}

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

export async function kernelHandle({ message, agentHint } = {}) {
  const text = normalizeUserMessage(message);
  const agentId = (String(agentHint || "orion").trim().toLowerCase() || "orion");
  const agent = AGENTS[agentId] ? agentId : "orion";

  const openai = ensureOpenAI();
  if (!openai) {
    return {
      ok: false,
      agent,
      replyText: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.",
      proposal: null,
    };
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
      const id = resp?.id || null;
      return {
        ok: true,
        agent,
        replyText: `Cavab boş gəldi (model=${model}, status=${status}, id=${id}). /api/debug/openai ilə raw cavabı yoxla.`,
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
  const openai = ensureOpenAI();
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