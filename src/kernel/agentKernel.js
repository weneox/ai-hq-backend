// src/kernel/agentKernel.js
import OpenAI from "openai";
import { cfg } from "../config.js";

// ---------------------------
// Agents registry (phase 1)
// ---------------------------
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

// ---------------------------
// OpenAI client
// ---------------------------
const openai = cfg.OPENAI_API_KEY
  ? new OpenAI({ apiKey: cfg.OPENAI_API_KEY })
  : null;

// ---------------------------
// Robust text extraction
// ---------------------------
function pickString(x) {
  if (typeof x === "string") return x;
  return "";
}

function extractFromOutputArray(output) {
  // Responses API often returns: output: [{ type: "message", content: [{type:"output_text", text:"..."}]}]
  if (!Array.isArray(output)) return "";
  let out = "";

  for (const item of output) {
    // 1) Some SDKs provide item.content as array of blocks
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        // Common block types: output_text, text, input_text, etc.
        out += pickString(block?.text);
        if (block?.type === "output_text" && typeof block?.text === "string") out += block.text;
      }
    }

    // 2) Sometimes item has "text" directly
    out += pickString(item?.text);

    // 3) Sometimes item is message with "role" and "content" string
    if (typeof item?.content === "string") out += item.content;
  }

  return out.trim();
}

function extractText(resp) {
  // Try the most reliable places first.
  // 1) SDK convenience: resp.output_text
  const direct = pickString(resp?.output_text).trim();
  if (direct) return direct;

  // 2) output array parse
  const fromOutput = extractFromOutputArray(resp?.output);
  if (fromOutput) return fromOutput;

  // 3) Some variants include resp.message.content
  const msgContent = resp?.message?.content;
  if (typeof msgContent === "string" && msgContent.trim()) return msgContent.trim();

  // 4) Some include choices[0].message.content (chat-style)
  const chatLike = resp?.choices?.[0]?.message?.content;
  if (typeof chatLike === "string" && chatLike.trim()) return chatLike.trim();

  // 5) Some include content blocks in resp?.choices?.[0]?.message?.content (array)
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

// ---------------------------
// Core: single-agent kernelHandle
// ---------------------------
export async function kernelHandle({ message, agentHint } = {}) {
  const text = normalizeUserMessage(message);
  const agentId = (String(agentHint || "orion").trim().toLowerCase() || "orion");
  const agent = AGENTS[agentId] ? agentId : "orion";

  if (!openai) {
    return {
      ok: false,
      agent,
      replyText: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.",
      proposal: null,
    };
  }

  const model = clampModelName(cfg.OPENAI_MODEL);

  // Responses API call (robust)
  try {
    const resp = await openai.responses.create({
      model,
      // Force text output format
      text: { format: { type: "text" } },
      input: [
        { role: "system", content: AGENTS[agent].system },
        { role: "user", content: text },
      ],
    });

    const replyText = extractText(resp);

    if (!replyText) {
      // Give actionable debug hint + keep raw minimal
      const status = resp?.status || null;
      return {
        ok: true,
        agent,
        replyText:
          `Cavab boş gəldi (model=${model}, status=${status}). ` +
          `Tövsiyə: /api/debug/openai ilə raw cavabı yoxla.`,
        proposal: null,
      };
    }

    return { ok: true, agent, replyText, proposal: null };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, agent, replyText: `OpenAI xətası: ${msg}`, proposal: null };
  }
}

// ---------------------------
// Debug OpenAI (raw response)
// ---------------------------
export async function debugOpenAI({ agent = "orion", message = "ping" } = {}) {
  if (!openai) return { ok: false, status: null, agent, extractedText: "", raw: "OpenAI disabled" };

  const model = clampModelName(cfg.OPENAI_MODEL);
  const a = AGENTS[agent] ? agent : "orion";

  try {
    const resp = await openai.responses.create({
      model,
      text: { format: { type: "text" } },
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