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

  // Allow the model to sometimes wrap JSON in ```json ... ```
  const rawStripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  const proposal = safeJsonParse(rawStripped);

  const cleaned = text.replace(m[0], "").trim();
  return { cleaned, proposal };
}

function collectTextFromResponses(data) {
  // 1) direct
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // 2) walk output -> content
  const pieces = [];
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      // Most common
      if (c?.type === "output_text" && typeof c?.text === "string") pieces.push(c.text);
      if (c?.type === "text" && typeof c?.text === "string") pieces.push(c.text);

      // Some variants
      if (typeof c?.content === "string") pieces.push(c.content);
      if (typeof c?.text?.value === "string") pieces.push(c.text.value);
    }
  }

  const joined = pieces.join("\n").trim();
  return joined;
}

async function callOpenAI({ system, user }) {
  if (!cfg.OPENAI_API_KEY) {
    return `OpenAI API key yoxdur. Mən hələlik lokal cavab verə bilərəm.\n\nSualını daha qısa yaz, hansı agent cavablasın? (orion/nova/atlas/echo)`;
  }

  const body = {
    model: cfg.OPENAI_MODEL,
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],

    // ✅ Force text output for Responses API (prevents "(no text)" in many cases)
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

  if (!r.ok) {
    // keep message small to avoid log spam
    throw new Error(`OpenAI error ${r.status}: ${raw.slice(0, 400)}`);
  }

  const data = raw ? safeJsonParse(raw) : null;

  const text = collectTextFromResponses(data);
  if (text && text.trim()) return text.trim();

  // Final fallback: if API returned JSON but no text
  return "(no text)";
}

export async function kernelHandle({ message, agentHint }) {
  const agentKey = (agentHint && AGENTS[agentHint]) ? agentHint : pickAgentFromText(message);
  const agent = AGENTS[agentKey];

  let replyRaw = "";
  try {
    replyRaw = await callOpenAI({ system: agent.system, user: message });
  } catch (e) {
    // ✅ Don't crash the route; return a readable error
    return {
      agent: agentKey,
      agentName: agent.name,
      replyText: `OpenAI xətası: ${String(e?.message || e)}`,
      proposal: null
    };
  }

  // If still empty, return an actionable hint
  if (!replyRaw || !String(replyRaw).trim() || String(replyRaw).trim() === "(no text)") {
    const hint =
      `Cavab boş gəldi. Bu adətən model/format uyğunsuzluğudur.\n` +
      `Tövsiyə: Railway-də OPENAI_MODEL-i müvəqqəti "gpt-4.1-mini" et və yenidən yoxla.\n` +
      `Sən istəsən mən də serverdə debug endpoint əlavə edib OpenAI raw cavabı gizli log edərəm.`;

    return {
      agent: agentKey,
      agentName: agent.name,
      replyText: hint,
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