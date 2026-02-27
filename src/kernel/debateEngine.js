// src/kernel/debateEngine.js
import OpenAI from "openai";
import { cfg } from "../config.js";

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

function pickString(x) {
  return typeof x === "string" ? x : "";
}

function pickStringDeep(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    if (typeof x.value === "string") return x.value; // common SDK shape
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

/**
 * ✅ Robust text extractor for Responses API (covers more shapes)
 * Supports:
 * - resp.output_text
 * - resp.output[].content[].text (string or {value})
 * - resp.output[].content[].transcript
 * - legacy resp.choices[].message.content (if any)
 */
function extractText(resp) {
  if (!resp) return "";

  const direct = pickString(resp.output_text).trim();
  if (direct) return direct;

  // Some SDK versions expose convenience getter differently
  const direct2 = pickString(resp?.outputText).trim();
  if (direct2) return direct2;

  // Standard "output" blocks
  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      const content = item?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          // output_text block
          const t1 = pickStringDeep(block?.text);
          if (t1) parts.push(t1);

          // transcript block (audio)
          const t2 = pickStringDeep(block?.transcript);
          if (t2) parts.push(t2);

          // sometimes nested
          const t3 = pickStringDeep(block?.output_text);
          if (t3) parts.push(t3);
        }
      } else if (typeof content === "string") {
        parts.push(content);
      }

      // sometimes item itself has "text"
      const tItem = pickStringDeep(item?.text);
      if (tItem) parts.push(tItem);
    }

    const joined = parts.join("").trim();
    if (joined) return joined;
  }

  // Legacy chat-completions shape (just in case)
  const choices = resp?.choices;
  if (Array.isArray(choices)) {
    const parts = [];
    for (const c of choices) {
      const msg = c?.message;
      const t = pickString(msg?.content);
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
      if (typeof node.text === "string") parts.push(node.text);
      if (node.text && typeof node.text === "object" && typeof node.text.value === "string") parts.push(node.text.value);
      if (typeof node.transcript === "string") parts.push(node.transcript);

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

async function askAgent({ openai, agentId, message, round, notesSoFar, timeoutMs }) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);

  const resp = await withTimeout(
    openai.responses.create({
      model: cfg.OPENAI_MODEL || "gpt-5",
      text: { format: { type: "text" } },
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 450),
      input: [
        { role: "system", content: `You are agent "${agentId}". Follow the user's rules strictly.` },
        { role: "user", content: prompt },
      ],
    }),
    timeoutMs,
    `OpenAI timeout (${agentId})`
  );

  const text = extractText(resp);

  // ✅ debug
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

  return text || "";
}

function extractJsonFromText(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const fence = s.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

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

function fallbackSynthesis(agentNotes = []) {
  const lines = [];
  for (const n of agentNotes) {
    const t = String(n?.text || "").trim();
    if (!t) continue;
    lines.push(`### ${n.agentId}\n${t}`);
  }
  return lines.join("\n\n").trim();
}

async function synthesizeFinal({ openai, message, agentNotes, mode, timeoutMs }) {
  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const DELIM = "---PROPOSAL_JSON---";

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
{
  "type":"plan",
  "title":"...",
  "payload": { "summary":"...", "steps":[...], "kpis":[...], "ownerMap":{...} }
}

ÇOX VACİB:
- SƏN HƏR HALDA MƏTN YAZMALISAN (boş cavab qadağandır).
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
      max_output_tokens: Number(cfg.OPENAI_MAX_OUTPUT_TOKENS || 750),
      input: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
    timeoutMs,
    "OpenAI timeout (synthesis)"
  );

  const text = extractText(resp);
  console.log("[debate] synthesis status=", resp?.status || null, "id=", resp?.id || null, "len=", (text || "").length);

  let finalAnswer = String(text || "").trim();

  // ✅ If synthesis empty (rare SDK shape issues), fallback to aggregated agent notes
  if (!finalAnswer) {
    finalAnswer = fallbackSynthesis(agentNotes);
    if (finalAnswer) {
      finalAnswer =
        `Final Plan (fallback)\n\n${finalAnswer}\n\n` +
        `KPI-lar:\n- (fallback — agent notlarından çıxar)\n\nRisklər:\n- (fallback)\n\nNext Actions:\n- (fallback)`;
    }
  }

  let proposal = null;
  if (mode === "proposal" && finalAnswer) {
    proposal = extractJsonAfterDelimiter(finalAnswer, "---PROPOSAL_JSON---") || extractJsonFromText(finalAnswer);
  }

  return { finalAnswer: finalAnswer || "", proposal };
}

export async function runDebate({
  message,
  agents = DEFAULT_AGENTS,
  rounds = 2,
  mode = "answer", // "answer" | "proposal"
}) {
  const openai = ensureOpenAI();
  if (!openai) {
    return {
      finalAnswer: "OpenAI aktiv deyil. OPENAI_API_KEY yoxdur.",
      agentNotes: DEFAULT_AGENTS.map((a) => ({ agentId: a, text: "" })),
      proposal: null,
    };
  }

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