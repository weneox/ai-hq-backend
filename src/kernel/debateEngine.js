// src/kernel/debateEngine.js
import OpenAI from "openai";
import { cfg } from "../config.js";

const openai = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });

const DEFAULT_AGENTS = ["orion", "nova", "atlas", "echo"];

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function withTimeout(promise, ms, label = "timeout") {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), t)),
  ]);
}

// simple concurrency limiter (no deps)
async function mapLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  let i = 0;

  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await worker(arr[idx], idx);
    }
  });

  await Promise.all(runners);
  return out;
}

// ✅ More robust extraction for Responses API
function extractText(resp) {
  if (!resp) return "";

  const direct = typeof resp.output_text === "string" ? resp.output_text.trim() : "";
  if (direct) return direct;

  const out = resp.output;
  if (Array.isArray(out)) {
    let s = "";
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          // Common block shapes:
          // {type:"output_text", text:"..."}
          // {type:"text", text:"..."}
          // {transcript:"..."} (audio related)
          if (typeof c?.text === "string") s += c.text;
          if (typeof c?.transcript === "string") s += c.transcript;
        }
      }
      if (typeof item?.text === "string") s += item.text;
      if (typeof item?.content === "string") s += item.content;
    }
    if (s.trim()) return s.trim();
  }

  // fallback: some SDKs
  const chatLike = resp?.choices?.[0]?.message?.content;
  if (typeof chatLike === "string" && chatLike.trim()) return chatLike.trim();

  return "";
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
- Round ${round}.

İSTİFADƏÇİ MESAJI:
${message}

ƏVVƏLKİ QEYDLƏR (varsa):
${notesSoFar || "(yoxdur)"}

ÇIXIŞ:
- Sənin töhfən (bəndlərlə)
`.trim();
}

async function askAgent({ agentId, message, round, notesSoFar, timeoutMs }) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);

  const resp = await withTimeout(
    openai.responses.create({
      model: cfg.OPENAI_MODEL || "gpt-5",
      input: prompt,
      text: { format: { type: "text" } },
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 450),
    }),
    timeoutMs,
    `OpenAI timeout (${agentId})`
  );

  return extractText(resp);
}

function extractJsonFromText(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  // Prefer fenced ```json ... ```
  const fence = s.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  // Try last {...} block
  const m = s.match(/\{[\s\S]*\}\s*$/);
  if (m?.[0]) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }

  return null;
}

function extractJsonAfterDelimiter(text, delimiter) {
  const s = String(text || "");
  const idx = s.lastIndexOf(delimiter);
  if (idx < 0) return null;
  const tail = s.slice(idx + delimiter.length).trim();
  return extractJsonFromText(tail);
}

async function synthesizeFinal({ message, agentNotes, mode, timeoutMs }) {
  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${n.text}`)
    .join("\n\n");

  const DELIM = "\n\n---PROPOSAL_JSON---\n\n";

  const sys = `
Sən AI HQ “Kernel”sən. 4 agentin töhfələrini birləşdirib yekun çıxar.

QAYDALAR:
- Qısa + konkret ol.
- Format:
  1) Final Plan (bəndlərlə)
  2) KPI-lar (bəndlərlə)
  3) Risklər (bəndlərlə)
  4) Next Actions (icra taskları)
- Heç vaxt uzun esse yazma.

Əgər mode=proposal:
- Yuxarıdakı 4 bölməni yenə yaz.
- Sonda bu delimiteri DƏQİQ yaz: ---PROPOSAL_JSON---
- Delimiterdən sonra təkcə JSON ver (əlavə mətn yox).
JSON formatı:
{
  "type":"plan",
  "title":"...",
  "payload": { "summary":"...", "steps":[...], "kpis":[...], "ownerMap":{...} }
}
`.trim();

  const user = `
MODE: ${mode}
İSTİFADƏÇİ MESAJI:
${message}

AGENT NOTLARI:
${notesText}
`.trim();

  const resp = await withTimeout(
    openai.responses.create({
      model: cfg.OPENAI_MODEL || "gpt-5",
      input: `${sys}\n\n${user}`,
      text: { format: { type: "text" } },
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 700),
    }),
    timeoutMs,
    "OpenAI timeout (synthesis)"
  );

  const text = extractText(resp);

  let proposal = null;
  if (mode === "proposal") {
    proposal = extractJsonAfterDelimiter(text, "---PROPOSAL_JSON---");
    // fallback
    if (!proposal) proposal = extractJsonFromText(text);
  }

  return { finalAnswer: text, proposal };
}

export async function runDebate({
  message,
  agents = DEFAULT_AGENTS,
  rounds = 2,
  mode = "answer", // "answer" | "proposal"
}) {
  const agentIdsRaw = Array.isArray(agents) ? agents : DEFAULT_AGENTS;
  const agentIds = agentIdsRaw.map((x) => String(x || "").trim()).filter(Boolean);
  const rCount = clamp(Number(rounds || 2), 1, 3);

  const timeoutMs = Number(cfg.OPENAI_TIMEOUT_MS || 25_000);
  const concurrency = clamp(Number(cfg.OPENAI_DEBATE_CONCURRENCY || 2), 1, 4);

  const agentNotes = [];
  let notesSoFar = "";

  for (let round = 1; round <= rCount; round++) {
    const roundNotes = await mapLimit(agentIds, concurrency, async (agentId) => {
      try {
        const text = await askAgent({ agentId, message, round, notesSoFar, timeoutMs });
        return { agentId, text: text || "" };
      } catch (e) {
        return { agentId, text: `⚠️ failed: ${String(e?.message || e)}` };
      }
    });

    agentNotes.push(...roundNotes);
    notesSoFar = agentNotes.map((n) => `[${n.agentId}] ${n.text}`).join("\n\n");
  }

  const synth = await synthesizeFinal({ message, agentNotes, mode, timeoutMs });

  return {
    finalAnswer: synth.finalAnswer,
    agentNotes,
    proposal: synth.proposal, // may be null if not parsed
  };
}