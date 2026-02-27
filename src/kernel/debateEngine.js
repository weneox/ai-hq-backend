// src/kernel/debateEngine.js (FINAL v3)
import OpenAI from "openai";
import { cfg } from "../config.js";

export const DEBATE_ENGINE_VERSION = "final-v3";
console.log(`[debateEngine] LOADED ${DEBATE_ENGINE_VERSION}`);

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
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await worker(arr[idx], idx);
    }
  });

  await Promise.all(runners);
  return out;
}

function s(x) {
  return typeof x === "string" ? x : "";
}

function sDeep(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    if (typeof x.value === "string") return x.value; // some SDK variants
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

/**
 * ✅ Bulletproof text extractor for Responses API
 * Supports:
 * - resp.output_text
 * - resp.output[].type === "message" -> content[].type === "output_text" -> .text
 * - resp.output[].content[] where block has .text / .transcript
 * - deep scan fallback
 */
function extractText(resp) {
  if (!resp) return "";

  // 1) convenience field (often present)
  const direct = s(resp.output_text).trim();
  if (direct) return direct;

  // 2) output blocks
  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];

    for (const item of out) {
      // Most reliable: type=message
      if (item?.type === "message" && Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (block?.type === "output_text") {
            const t = sDeep(block?.text).trim();
            if (t) parts.push(t);
          } else {
            const t1 = sDeep(block?.text).trim();
            if (t1) parts.push(t1);
            const tr = sDeep(block?.transcript).trim();
            if (tr) parts.push(tr);
          }
        }
        continue;
      }

      // generic fallback for any output item
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "output_text") {
            const t = sDeep(block?.text).trim();
            if (t) parts.push(t);
            continue;
          }
          const t1 = sDeep(block?.text).trim();
          if (t1) parts.push(t1);
          const tr = sDeep(block?.transcript).trim();
          if (tr) parts.push(tr);
        }
      } else if (typeof content === "string") {
        const t = content.trim();
        if (t) parts.push(t);
      }

      const tItem = sDeep(item?.text).trim();
      if (tItem) parts.push(tItem);
    }

    const joined = parts.join("\n").trim();
    if (joined) return joined;
  }

  // 3) last resort: deep scan for likely "output_text" blocks
  try {
    const seen = new Set();
    const parts = [];

    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      // direct strings
      if (typeof node.output_text === "string") parts.push(node.output_text);

      if (node.type === "output_text") {
        const t = sDeep(node.text);
        if (t) parts.push(t);
      }

      // sometimes content blocks just have "text"
      if (typeof node.text === "string") parts.push(node.text);
      if (node.text && typeof node.text === "object" && typeof node.text.value === "string") {
        parts.push(node.text.value);
      }

      if (typeof node.transcript === "string") parts.push(node.transcript);

      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };

    walk(resp);
    const joined = parts.join("\n").trim();
    if (joined) return joined;
  } catch {}

  return "";
}

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
- Round ${round}.

İSTİFADƏÇİ MESAJI:
${message}

ƏVVƏLKİ QEYDLƏR (varsa):
${notesSoFar || "(yoxdur)"}

ÇIXIŞ:
- Sənin töhfən (bəndlərlə)
`.trim();
}

// If OpenAI returns empty visible text, log minimal debug and return a visible marker
function visibleEmptyMarker(kind, agentId, resp) {
  const usage = resp?.usage || {};
  const outTok = usage?.output_tokens ?? null;
  const rTok = usage?.output_tokens_details?.reasoning_tokens ?? null;

  const id = resp?.id || null;
  const status = resp?.status || null;
  const model = resp?.model || null;

  return `⚠️ ${kind.toUpperCase()} EMPTY_TEXT (agent=${agentId || "-"} status=${status} model=${model} id=${id} outTok=${outTok} reasoningTok=${rTok})`;
}

function logRawIfEmpty(kind, agentId, resp, text) {
  if (String(text || "").trim()) return;
  try {
    console.log("[debate] EMPTY", { kind, agentId, status: resp?.status, model: resp?.model, id: resp?.id });
    // first part only
    const raw = JSON.stringify(resp, null, 2);
    console.log(`[debate] RAW(${kind}) first 1400:\n${raw.slice(0, 1400)}`);
  } catch {}
}

async function askAgent({ openai, agentId, message, round, notesSoFar, timeoutMs }) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);

  const maxOut = Number(cfg.OPENAI_DEBATE_AGENT_TOKENS || 900);

  const resp = await withTimeout(
    openai.responses.create({
      model: cfg.OPENAI_MODEL || "gpt-5",
      text: { format: { type: "text" } },
      reasoning: { effort: "low" }, // keep visible text priority
      temperature: Number(cfg.OPENAI_DEBATE_TEMPERATURE || 0.6) || 0.6,
      max_output_tokens: maxOut,
      input: [
        { role: "system", content: `You are agent "${agentId}". Follow the user's rules strictly.` },
        { role: "user", content: prompt },
      ],
    }),
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

  return text;
}

function extractJsonFromText(text) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  // Prefer fenced ```json ... ```
  const fence = s0.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  // Try last {...} block
  const m = s0.match(/\{[\s\S]*\}\s*$/);
  if (m?.[0]) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }

  return null;
}

function extractJsonAfterDelimiter(text, delimiter) {
  const s0 = String(text || "");
  const idx = s0.lastIndexOf(delimiter);
  if (idx < 0) return null;
  const tail = s0.slice(idx + delimiter.length).trim();
  return extractJsonFromText(tail);
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

async function synthesizeFinal({ openai, message, agentNotes, mode, timeoutMs }) {
  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const DELIM = "---PROPOSAL_JSON---";
  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 1200);

  const sys = `
Sən AI HQ “Kernel”sən. 4 agentin töhfələrini birləşdirib yekun çıxar.

QAYDALAR:
- Qısa + konkret ol.
- Format:
  1) Final Plan (bəndlərlə)
  2) KPI-lar (bəndlərlə)
  3) Risklər (bəndlərlə)
  4) Next Actions (icra taskları)

Əgər mode=proposal:
- Sonda delimiteri DƏQİQ yaz: ${DELIM}
- Delimiterdən sonra təkcə JSON ver (əlavə mətn yox).
JSON formatı:
{"type":"plan","title":"...","payload":{"summary":"...","steps":[...],"kpis":[...],"ownerMap":{...}}}

ÇOX VACİB: BOŞ CAVAB QADAĞANDIR.
`.trim();

  const user = `
MODE: ${mode}
İSTİFADƏÇİ MESAJI:
${message}

AGENT NOTLARI:
${notesText || "(agent notları boşdur)"}
`.trim();

  const resp = await withTimeout(
    openai.responses.create({
      model: cfg.OPENAI_MODEL || "gpt-5",
      text: { format: { type: "text" } },
      reasoning: { effort: "low" },
      temperature: 0.6,
      max_output_tokens: maxOut,
      input: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
    timeoutMs,
    "OpenAI timeout (synthesis)"
  );

  let text = extractText(resp);

  console.log("[debate] synthesis", "status=", resp?.status || null, "id=", resp?.id || null, "len=", (text || "").length);

  if (!String(text || "").trim()) {
    logRawIfEmpty("synth", "kernel", resp, text);
    text = visibleEmptyMarker("synth", "kernel", resp);
  }

  let finalAnswer = String(text || "").trim();
  if (!finalAnswer) finalAnswer = fallbackSynthesis(agentNotes);

  let proposal = null;
  if (mode === "proposal" && finalAnswer) {
    proposal = extractJsonAfterDelimiter(finalAnswer, DELIM) || extractJsonFromText(finalAnswer);
  }

  return { finalAnswer: finalAnswer || "", proposal };
}

export async function runDebate({ message, agents = DEFAULT_AGENTS, rounds = 2, mode = "answer" }) {
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
    const roundNotes = await mapLimit(agentIds, concurrency, async (agentId) => {
      try {
        const text = await askAgent({ openai, agentId, message, round, notesSoFar, timeoutMs });
        return { agentId, text: text || "" };
      } catch (e) {
        return { agentId, text: `⚠️ failed: ${String(e?.message || e)}` };
      }
    });

    agentNotes.push(...roundNotes);
    notesSoFar = agentNotes.map((n) => `[${n.agentId}] ${n.text}`).join("\n\n");
  }

  const synth = await synthesizeFinal({ openai, message, agentNotes, mode, timeoutMs });

  return {
    finalAnswer: synth.finalAnswer,
    agentNotes,
    proposal: synth.proposal,
  };
}