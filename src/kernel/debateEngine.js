// src/kernel/debateEngine.js (FINAL v3.6 — prompts/usecases + UTF fix + safer JSON parse)
import OpenAI from "openai";
import { cfg } from "../config.js";
import { getGlobalPolicy, getUsecasePrompt } from "../prompts/index.js";

export const DEBATE_ENGINE_VERSION = "final-v3.6";
console.log(`[debateEngine] LOADED ${DEBATE_ENGINE_VERSION}`);

const DEFAULT_AGENTS = ["orion", "nova", "atlas", "echo"];

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function withTimeout(promise, ms, label = "timeout") {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return promise;
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(label)), t))]);
}

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
    if (typeof x.value === "string") return x.value;
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

// ✅ Mojibake repair (UTF-8 stored/decoded as latin1 -> "gÃ¼nlÃ¼k")
function fixMojibake(input) {
  const t = String(input || "");
  if (!t) return t;

  // only attempt if typical broken markers appear
  if (!/[ÃÂ]|â€™|â€œ|â€�|â€“|â€”|â€¦/.test(t)) return t;

  try {
    const fixed = Buffer.from(t, "latin1").toString("utf8");
    if (/[�]/.test(fixed) && !/[�]/.test(t)) return t;
    return fixed;
  } catch {
    return t;
  }
}

function extractText(resp) {
  if (!resp) return "";

  const direct = s(resp.output_text).trim();
  if (direct) return fixMojibake(direct);

  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];

    for (const item of out) {
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
    if (joined) return fixMojibake(joined);
  }

  // last resort deep scan
  try {
    const seen = new Set();
    const parts = [];

    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (typeof node.output_text === "string") parts.push(node.output_text);

      if (node.type === "output_text") {
        const t = sDeep(node.text);
        if (t) parts.push(t);
      }

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
    if (joined) return fixMojibake(joined);
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
- Heç bir halda JSON, kod bloku, {...} yazma.
- Round ${round}.

İSTİFADƏÇİ MESAJI:
${message}

ƏVVƏLKİ QEYDLƏR (varsa):
${notesSoFar || "(yoxdur)"}

ÇIXIŞ:
- Sənin töhfən (bəndlərlə)
`.trim();
}

function visibleEmptyMarker(kind, agentId, resp) {
  const usage = resp?.usage || {};
  const outTok = usage?.output_tokens ?? null;
  const rTok = usage?.output_tokens_details?.reasoning_tokens ?? null;

  const id = resp?.id || null;
  const status = resp?.status || null;
  const model = resp?.model || null;

  return `⚠️ ${String(kind || "resp").toUpperCase()} EMPTY_TEXT (agent=${agentId || "-"} status=${status} model=${model} id=${id} outTok=${outTok} reasoningTok=${rTok})`;
}

function logRawIfEmpty(kind, agentId, resp, text) {
  if (String(text || "").trim()) return;
  if (!cfg.DEBUG_DEBATE_RAW) return;
  try {
    console.log("[debate] EMPTY", { kind, agentId, status: resp?.status, model: resp?.model, id: resp?.id });
    const raw = JSON.stringify(resp, null, 2);
    console.log(`[debate] RAW(${kind}) first 1600:\n${raw.slice(0, 1600)}`);
  } catch {}
}

async function askAgent({ openai, agentId, message, round, notesSoFar, timeoutMs }) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);
  const maxOut = Number(cfg.OPENAI_DEBATE_AGENT_TOKENS || 900);

  const req = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: maxOut,
    input: [
      { role: "system", content: `You are agent "${agentId}". Follow the user's rules strictly.` },
      { role: "user", content: prompt },
    ],
  };

  const resp = await withTimeout(openai.responses.create(req), timeoutMs, `OpenAI timeout (${agentId})`);

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

  return fixMojibake(text);
}

function extractJsonFromText(text) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  // direct parse
  try {
    return JSON.parse(s0);
  } catch {}

  // slice first {...} block
  const start = s0.indexOf("{");
  const end = s0.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = s0.slice(start, end + 1).trim();
    try {
      return JSON.parse(slice);
    } catch {}
  }

  // code fence
  const fence = s0.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  return null;
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

function pickUsecaseFromMode(mode) {
  const m = String(mode || "").trim().toLowerCase();
  if (m === "draft") return "content.draft";
  if (m === "revise") return "content.revise";
  if (m === "publish") return "content.publish";
  if (m === "trend") return "trend.research";
  if (m === "meta_comment") return "meta.comment_reply";
  return null;
}

function buildSynthesisSystem({ mode }) {
  const global = getGlobalPolicy();
  const usecase = pickUsecaseFromMode(mode);
  const ucText = usecase ? getUsecasePrompt(usecase) : "";

  const base = `
You are AI HQ Kernel.
Follow GLOBAL POLICY and USECASE instructions strictly.
Return clean outputs. If USECASE requires JSON: output ONLY valid JSON.
`.trim();

  return [
    base,
    "",
    "GLOBAL POLICY:",
    global || "(missing policy.global.txt)",
    "",
    usecase ? `USECASE: ${usecase}` : "",
    usecase ? ucText : "",
  ]
    .filter((x) => String(x || "").trim())
    .join("\n");
}

async function synthesizeFinal({ openai, message, agentNotes, mode, timeoutMs }) {
  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 1400);

  // If mode is draft/trend/etc, use the usecase prompt to demand JSON.
  const sysText = buildSynthesisSystem({ mode });

  const userText = `
USER_REQUEST:
${message}

AGENT_NOTES:
${notesText || "(empty)"}
`.trim();

  const reqText = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: maxOut,
    input: [
      { role: "system", content: sysText },
      { role: "user", content: userText },
    ],
  };

  const respText = await withTimeout(openai.responses.create(reqText), timeoutMs, "OpenAI timeout (synthesis)");
  let outText = extractText(respText);

  if (!String(outText || "").trim()) {
    logRawIfEmpty("synth", "kernel", respText, outText);
    outText = visibleEmptyMarker("synth", "kernel", respText);
  }

  outText = fixMojibake(String(outText || "").trim());
  if (!outText) outText = fallbackSynthesis(agentNotes);

  // Try parse JSON if mode expects JSON (draft/trend/publish/revise/meta_comment/proposal)
  const expectsJson = ["proposal", "draft", "trend", "publish", "revise", "meta_comment"].includes(
    String(mode || "").toLowerCase()
  );

  if (!expectsJson) {
    return { finalAnswer: outText, proposal: null };
  }

  let obj = extractJsonFromText(outText);

  if (!obj) {
    // repair pass
    const repairSys = `You will be given text that should be JSON but may be invalid. Return ONLY corrected valid JSON. No extra text.`;
    const repairReq = {
      model: cfg.OPENAI_MODEL || "gpt-5",
      text: { format: { type: "text" } },
      max_output_tokens: 1200,
      input: [
        { role: "system", content: repairSys },
        { role: "user", content: String(outText || "") },
      ],
    };

    try {
      const respFix = await withTimeout(openai.responses.create(repairReq), timeoutMs, "OpenAI timeout (json-repair)");
      const fixed = fixMojibake(extractText(respFix));
      obj = extractJsonFromText(fixed);
    } catch {}
  }

  // For backward compatibility: we always return {finalAnswer, proposal}
  // - if mode=proposal => proposal=obj
  // - else => proposal={type: mode, title:..., payload: obj} OR if obj already has type/title/payload keep it.
  if (mode === "proposal") {
    if (!obj || typeof obj !== "object") obj = null;
    return { finalAnswer: outText, proposal: obj };
  }

  if (obj && typeof obj === "object") {
    if (obj.type && obj.payload) {
      return { finalAnswer: outText, proposal: obj };
    }
    return {
      finalAnswer: outText,
      proposal: {
        type: String(mode),
        title: String(obj.title || obj.summary || obj.topic || "Draft").slice(0, 120),
        payload: obj,
      },
    };
  }

  // absolute fallback
  return {
    finalAnswer: outText,
    proposal: {
      type: String(mode),
      title: "Draft",
      payload: { raw: outText },
    },
  };
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
        return { agentId, text: fixMojibake(text || "") };
      } catch (e) {
        return { agentId, text: `⚠️ failed: ${String(e?.message || e)}` };
      }
    });

    agentNotes.push(...roundNotes);
    notesSoFar = agentNotes.map((n) => `[${n.agentId}] ${n.text}`).join("\n\n");
  }

  const synth = await synthesizeFinal({ openai, message, agentNotes, mode, timeoutMs });

  return {
    finalAnswer: fixMojibake(synth.finalAnswer),
    agentNotes: agentNotes.map((n) => ({ agentId: n.agentId, text: fixMojibake(n.text) })),
    proposal: synth.proposal,
  };
}