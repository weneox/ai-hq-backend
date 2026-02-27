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
  const t = text.toLowerCase();
  if (t.includes("instagram") || t.includes("reels") || t.includes("post") || t.includes("story")) return "nova";
  if (t.includes("satış") || t.includes("satis") || t.includes("whatsapp") || t.includes("lead") || t.includes("funnel")) return "atlas";
  if (t.includes("analitika") || t.includes("report") || t.includes("kpi") || t.includes("dashboard")) return "echo";
  return "orion";
}

function extractProposal(replyText) {
  // looks for <proposal>{...}</proposal>
  const m = replyText.match(/<proposal>\s*([\s\S]*?)\s*<\/proposal>/i);
  if (!m) return { cleaned: replyText.trim(), proposal: null };

  const raw = m[1].trim();
  let proposal = null;
  try {
    proposal = JSON.parse(raw);
  } catch {
    proposal = null;
  }

  const cleaned = replyText.replace(m[0], "").trim();
  return { cleaned, proposal };
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
    max_output_tokens: cfg.OPENAI_MAX_OUTPUT_TOKENS
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI error ${r.status}: ${txt.slice(0, 400)}`);
  }

  const data = await r.json();

  // robust extract
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  // fallback walk
  const out = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (c.type === "output_text" && typeof c.text === "string") out.push(c.text);
      if (c.type === "text" && typeof c.text === "string") out.push(c.text);
    }
  }
  return out.join("\n").trim() || "(no text)";
}

export async function kernelHandle({ message, agentHint }) {
  const agentKey = (agentHint && AGENTS[agentHint]) ? agentHint : pickAgentFromText(message);
  const agent = AGENTS[agentKey];

  const replyRaw = await callOpenAI({ system: agent.system, user: message });
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