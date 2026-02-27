// src/kernel/debateEngine.js
import OpenAI from "openai";
import { cfg } from "../config.js";

const openai = cfg.OPENAI_API_KEY ? new OpenAI({ apiKey: cfg.OPENAI_API_KEY }) : null;

const AGENT_PROMPTS = {
  orion:
    "You are Orion (Strategist). Give a tight plan, priorities, risks. Keep it concise. No fluff.",
  nova:
    "You are Nova (Content/Instagram). Give content angles, hooks, posting plan, ad creatives. Keep concise.",
  atlas:
    "You are Atlas (Sales/WhatsApp). Give WA funnel, scripts, qualification questions, automation. Keep concise.",
  echo:
    "You are Echo (Analytics). Give KPI dashboard, tracking, UTMs, experiments, reporting cadence. Keep concise.",
};

function clampModelName(model) {
  const m = String(model || "").trim();
  return m || "gpt-4.1-mini";
}

function extractText(resp) {
  const direct = typeof resp?.output_text === "string" ? resp.output_text.trim() : "";
  if (direct) return direct;

  const out = resp?.output;
  if (Array.isArray(out)) {
    let s = "";
    for (const item of out) {
      if (Array.isArray(item?.content)) {
        for (const b of item.content) if (typeof b?.text === "string") s += b.text;
      }
      if (typeof item?.content === "string") s += item.content;
      if (typeof item?.text === "string") s += item.text;
    }
    s = s.trim();
    if (s) return s;
  }

  const chatLike = resp?.choices?.[0]?.message?.content;
  if (typeof chatLike === "string" && chatLike.trim()) return chatLike.trim();

  return "";
}

async function askAgent({ agentId, brief, round, notesSoFar }) {
  if (!openai) throw new Error("OpenAI disabled (missing OPENAI_API_KEY)");

  const model = clampModelName(cfg.OPENAI_MODEL);
  const system = AGENT_PROMPTS[agentId] || AGENT_PROMPTS.orion;

  const user =
    round === 1
      ? `BRIEF:\n${brief}\n\nReturn your best suggestions in 6-10 bullet points.`
      : `BRIEF:\n${brief}\n\nOTHER AGENTS NOTES:\n${notesSoFar}\n\nImprove or challenge the plan. Add missing risks. 6-10 bullets.`;

  const resp = await openai.responses.create({
    model,
    text: { format: { type: "text" } },
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = extractText(resp);
  return text || "(no text)";
}

async function synthesize({ brief, agentNotes, mode }) {
  if (!openai) throw new Error("OpenAI disabled (missing OPENAI_API_KEY)");

  const model = clampModelName(cfg.OPENAI_MODEL);

  const notes = agentNotes
    .map((x) => `# ${x.agentId.toUpperCase()}\n${x.text}`)
    .join("\n\n");

  const sys =
    "You are the Kernel (moderator). Synthesize multiple agents into one final output. " +
    "Be decisive, structured, short. Produce: Final Plan (numbered), Risks, Next Actions. " +
    "If mode=proposal, also output a compact PROPOSAL object in JSON at the end.";

  const user =
    `MODE: ${mode}\n\nBRIEF:\n${brief}\n\nAGENT NOTES:\n${notes}\n\n` +
    `Rules:\n- Keep final plan 5-8 bullets.\n- Risks max 5 bullets.\n- Next actions max 5 bullets.\n` +
    (mode === "proposal"
      ? `- At the end include JSON only in one block like:\n` +
        `{"type":"plan","title":"...","payload":{"summary":"...","steps":[...],"kpis":[...],"ownerMap":{...}}}\n`
      : "");

  const resp = await openai.responses.create({
    model,
    text: { format: { type: "text" } },
    input: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const text = extractText(resp);

  let proposal = null;
  if (mode === "proposal") {
    // Try to parse last JSON object if present
    const m = text.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        proposal = JSON.parse(m[0]);
      } catch {}
    }
  }

  return { finalAnswer: text || "(no text)", proposal };
}

export async function runDebate({ message, agents = ["orion","nova","atlas","echo"], rounds = 2, mode = "answer" }) {
  const brief = String(message || "").trim();
  const agentIds = agents.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean);

  // Round 1: parallel
  const agentNotes = [];
  const r1 = await Promise.all(
    agentIds.map(async (agentId) => {
      const text = await askAgent({ agentId, brief, round: 1, notesSoFar: "" });
      return { agentId, text };
    })
  );
  agentNotes.push(...r1);

  // Round 2..N: parallel with context
  for (let r = 2; r <= rounds; r++) {
    const notesSoFar = agentNotes.map((x) => `${x.agentId}: ${x.text}`).join("\n\n");
    const next = await Promise.all(
      agentIds.map(async (agentId) => {
        const text = await askAgent({ agentId, brief, round: r, notesSoFar });
        return { agentId, text };
      })
    );
    agentNotes.push(...next);
  }

  // Synthesis
  const syn = await synthesize({ brief, agentNotes, mode });
  return { ...syn, agentNotes };
}