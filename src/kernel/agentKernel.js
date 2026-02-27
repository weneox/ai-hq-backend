import { cfg } from "../config.js";

const AGENTS = {
  orion: {
    name: "Orion",
    role: "Strategy & CEO assistant",
    system: `You are ORION, the NEOX AI HQ strategist.
Rules:
- Be concise: max 4-6 lines.
- If you propose a plan/content that needs approval, output a <proposal>{JSON}</proposal> block.
- The proposal JSON must include: {"type":"plan|content|task","title":"...","payload":{...}}.
- Always end with ONE question for clarification (unless user said "thanks/stop").`
  },
  nova: {
    name: "Nova",
    role: "Instagram content & growth",
    system: `You are NOVA, the NEOX AI HQ Instagram content lead.
Rules:
- Short answer + 1 question.
- If you propose posts/scripts/campaigns requiring approval, output <proposal>{JSON}</proposal>.
- Proposal payload should include: platform, assetsNeeded, captions, hashtags, schedule.`
  },
  atlas: {
    name: "Atlas",
    role: "Sales / WhatsApp automation",
    system: `You are ATLAS, the NEOX AI HQ sales & automation lead.
Rules:
- Short, actionable.
- If proposing a workflow/automation requiring approval, output <proposal>{JSON}</proposal>.
- Proposal payload should include: funnel, triggers, steps, tools, KPI.`
  },
  echo: {
    name: "Echo",
    role: "Analytics & reporting",
    system: `You are ECHO, the NEOX AI HQ analytics lead.
Rules:
- Use bullet points.
- If you propose a dashboard/report requiring approval, output <proposal>{JSON}</proposal>.
- Proposal payload should include: metrics, sources, frequency, owner.`
  }
};

function pickAgentFromText(text = "") {
  const t = String(text || "").toLowerCase();
  if (t.includes("instagram") || t.includes("reels") || t.includes("post") || t.includes("story")) return "nova";
  if (t.includes("satış") || t.includes("satis") || t.includes("whatsapp") || t.includes("lead") || t.includes("funnel")) return "atlas";
  if (t.includes("analitika") || t.includes("report") || t.includes("kpi") || t.includes("dashboard")) return "echo";
  return "orion";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractProposal(replyText) {
  const text = String(replyText || "");
  const m = text.match(/<proposal>\s*([\s\S]*?)\s*<\/proposal>/i);
  if (!m) return { cleaned: text.trim(), proposal: null };

  const raw = (m[1] || "").trim();
  const rawStripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  const proposal = safeJsonParse(rawStripped);
  const cleaned = text.replace(m[0], "").trim();
  return { cleaned, proposal };
}

function collectTextFromResponses(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const pieces = [];
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") pieces.push(c.text);
      if (c?.type === "text" && typeof c?.text === "string") pieces.push(c.text);

      if (typeof c?.content === "string") pieces.push(c.content);
      if (typeof c?.text?.value === "string") pieces.push(c.text.value);
    }
  }

  return pieces.join("\n").trim();
}

async function rawOpenAIResponsesCall({ system, user }) {
  const body = {
    model: cfg.OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    // Force text output (helps a lot)
    text: { format: { type: "text" } },
    max_output_tokens: cfg.OPENAI_MAX_OUTPUT_TOKENS
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const raw = await r.text().catch(() => "");
  let data = null;
  if (raw) data = safeJsonParse(raw);

  return {
    ok: r.ok,
    status: r.status,
    raw,
    data
  };
}

async function callOpenAI({ system, user }) {
  if (!cfg.OPENAI_API_KEY) {
    return `OpenAI API key yoxdur. Railway Variables-a OPENAI_API_KEY əlavə et.`;
  }

  const resp = await rawOpenAIResponsesCall({ system, user });

  if (!resp.ok) {
    throw new Error(`OpenAI error ${resp.status}: ${String(resp.raw || "").slice(0, 400)}`);
  }

  const out = collectTextFromResponses(resp.data);
  return out && out.trim() ? out.trim() : "(no text)";
}

export async function kernelHandle({ message, agentHint }) {
  const agentKey = (agentHint && AGENTS[agentHint]) ? agentHint : pickAgentFromText(message);
  const agent = AGENTS[agentKey];

  let replyRaw = "";
  try {
    replyRaw = await callOpenAI({ system: agent.system, user: message });
  } catch (e) {
    return {
      agent: agentKey,
      agentName: agent.name,
      replyText: `OpenAI xətası: ${String(e?.message || e)}`,
      proposal: null
    };
  }

  if (!replyRaw || !String(replyRaw).trim() || String(replyRaw).trim() === "(no text)") {
    return {
      agent: agentKey,
      agentName: agent.name,
      replyText:
        `Cavab boş gəldi. Tövsiyə: Railway-də OPENAI_MODEL-i müvəqqəti "gpt-4.1-mini" et və yenidən yoxla.`,
      proposal: null
    };
  }

  const { cleaned, proposal } = extractProposal(replyRaw);

  return {
    agent: agentKey,
    agentName: agent.name,
    replyText: cleaned || replyRaw,
    proposal
  };
}

export function listAgents() {
  return Object.keys(AGENTS).map((k) => ({ key: k, name: AGENTS[k].name, role: AGENTS[k].role }));
}

/**
 * ✅ Debug export: raw OpenAI response + extracted text
 * This is used by /api/debug/openai (token-protected).
 */
export async function debugOpenAI({ agent = "orion", message = "ping" }) {
  const agentKey = AGENTS[agent] ? agent : "orion";
  const system = AGENTS[agentKey].system;

  if (!cfg.OPENAI_API_KEY) {
    return {
      ok: false,
      error: "OPENAI_API_KEY missing",
      agent: agentKey
    };
  }

  const resp = await rawOpenAIResponsesCall({ system, user: message });
  const extracted = resp.ok ? collectTextFromResponses(resp.data) : "";

  return {
    ok: resp.ok,
    status: resp.status,
    agent: agentKey,
    extractedText: extracted || "",
    raw: resp.raw || ""
  };
}