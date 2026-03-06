// src/kernel/debateEngine.js
//
// FINAL v6.1 — premium campaign-safe draft normalization
//
// Goals:
// - Keep existing debate flow
// - Normalize content drafts for premium render pipeline
// - Guarantee:
//   - payload.assetBrief.imagePrompt
//   - payload.slides[]
//   - each slides[].visualPrompt
// - Strongly prevent website / dashboard / fake text visual prompts
// - Support n8n asset generation + separate render engine
// - Add better layout-family guidance for renderer / asset generation
//
// Supported modes:
// - answer
// - proposal
// - draft
// - revise
// - publish
// - trend
// - meta_comment

import OpenAI from "openai";
import { cfg } from "../config.js";
import { getGlobalPolicy, getUsecasePrompt } from "../prompts/index.js";

export const DEBATE_ENGINE_VERSION = "final-v6.1";
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
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), t)),
  ]);
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

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function asArr(x) {
  return Array.isArray(x) ? x : [];
}

function uniqStrings(arr = []) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function truncate(s0, n) {
  const t = String(s0 || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)).trim() + "…";
}

function fixMojibake(input) {
  const t = String(input || "");
  if (!t) return t;
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
      if (
        node.text &&
        typeof node.text === "object" &&
        typeof node.text.value === "string"
      ) {
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
    console.log("[debate] EMPTY", {
      kind,
      agentId,
      status: resp?.status,
      model: resp?.model,
      id: resp?.id,
    });
    const raw = JSON.stringify(resp, null, 2);
    console.log(`[debate] RAW(${kind}) first 1600:\n${raw.slice(0, 1600)}`);
  } catch {}
}

async function askAgent({
  openai,
  agentId,
  message,
  round,
  notesSoFar,
  timeoutMs,
}) {
  const prompt = agentPrompt(agentId, message, round, notesSoFar);
  const maxOut = Number(cfg.OPENAI_DEBATE_AGENT_TOKENS || 900);

  const req = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: maxOut,
    input: [
      {
        role: "system",
        content: `You are agent "${agentId}". Follow the user's rules strictly.`,
      },
      { role: "user", content: prompt },
    ],
  };

  const resp = await withTimeout(
    openai.responses.create(req),
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

  return fixMojibake(text);
}

function stripLeadingJunkToJsonCandidate(t) {
  const s0 = String(t || "").trim();
  if (!s0) return "";
  const fence = s0.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return String(fence[1] || "").trim();
  const start = s0.indexOf("{");
  const end = s0.lastIndexOf("}");
  if (start >= 0 && end > start) return s0.slice(start, end + 1).trim();
  return s0;
}

function extractJsonFromText(text) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  try {
    return JSON.parse(s0);
  } catch {}

  const cand = stripLeadingJunkToJsonCandidate(s0);
  if (cand && cand !== s0) {
    try {
      return JSON.parse(cand);
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
  const m0 = String(mode || "").trim().toLowerCase();

  const m =
    m0 === "content_publish" ||
    m0 === "publish_pack" ||
    m0 === "content.publish"
      ? "publish"
      : m0 === "content_revise" || m0 === "content.revise"
      ? "revise"
      : m0 === "content_draft" || m0 === "content.draft"
      ? "draft"
      : m0 === "trend_research" || m0 === "trend.research"
      ? "trend"
      : m0 === "comment" ||
        m0 === "meta_comment_reply" ||
        m0 === "meta.comment_reply"
      ? "meta_comment"
      : m0;

  if (m === "draft") return "content.draft";
  if (m === "revise") return "content.revise";
  if (m === "publish") return "content.publish";
  if (m === "trend") return "trend.research";
  if (m === "meta_comment") return "meta.comment_reply";

  return null;
}

function normalizeMode(mode) {
  const m0 = String(mode || "").trim().toLowerCase();
  if (
    m0 === "content_publish" ||
    m0 === "publish_pack" ||
    m0 === "content.publish"
  )
    return "publish";
  if (m0 === "content_revise" || m0 === "content.revise") return "revise";
  if (m0 === "content_draft" || m0 === "content.draft") return "draft";
  if (m0 === "trend_research" || m0 === "trend.research") return "trend";
  if (
    m0 === "comment" ||
    m0 === "meta_comment_reply" ||
    m0 === "meta.comment_reply"
  )
    return "meta_comment";
  return m0;
}

function modeExpectsJson(mode) {
  const m0 = String(mode || "").trim().toLowerCase();
  if (m0 === "meta_comment") return false;
  return ["proposal", "draft", "trend", "publish", "revise"].includes(m0);
}

function buildSynthesisSystem({ mode, vars }) {
  const global = getGlobalPolicy(vars);
  const usecase = pickUsecaseFromMode(mode);
  const ucText = usecase ? getUsecasePrompt(usecase, vars) : "";

  const base = `
You are AI HQ Kernel.
Follow GLOBAL POLICY and USECASE instructions strictly.
Return clean outputs.
If USECASE requires STRICT JSON: output ONLY valid JSON (no markdown, no extra text).
If USECASE requires plain text: output ONLY plain text.
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

async function strictJsonRepair({ openai, badText, timeoutMs }) {
  const repairSys = `You will be given text that MUST be valid JSON but may be invalid.
Return ONLY corrected valid JSON.
Rules:
- No markdown.
- No extra text.
- Keep the same structure/keys.
- If the text contains multiple JSON objects, return the best single final object.`;

  const repairReq = {
    model: cfg.OPENAI_MODEL || "gpt-5",
    text: { format: { type: "text" } },
    max_output_tokens: 1400,
    input: [
      { role: "system", content: repairSys },
      { role: "user", content: String(badText || "") },
    ],
  };

  const respFix = await withTimeout(
    openai.responses.create(repairReq),
    timeoutMs,
    "OpenAI timeout (json-repair)"
  );
  const fixed = fixMojibake(extractText(respFix));
  return extractJsonFromText(fixed);
}

function pickAspectRatio(format) {
  const f = String(format || "").trim().toLowerCase();
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

function sanitizeVisualText(x, max = 260) {
  let t = fixMojibake(String(x || "").trim());
  if (!t) return "";

  t = t
    .replace(/\b(navbar|navigation|menu|header|footer|button|cta button)\b/gi, "")
    .replace(/\b(website|landing page|web page|homepage|site hero|hero section)\b/gi, "")
    .replace(/\b(dashboard|admin panel|analytics panel|saas ui|ui screen|app screen|app ui|browser window)\b/gi, "")
    .replace(/\b(mockup of a website|interface mockup|ui mockup|screen mockup)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return truncate(t, max);
}

function sanitizeVisualElements(arr = []) {
  const bad = [
    "website",
    "landing page",
    "dashboard",
    "ui",
    "screen",
    "browser",
    "navbar",
    "menu",
    "button",
    "interface",
    "app screen",
    "admin panel",
  ];

  const out = [];
  for (const item of asArr(arr)) {
    const v = sanitizeVisualText(item, 120);
    if (!v) continue;
    const low = v.toLowerCase();
    if (bad.some((b) => low.includes(b))) continue;
    out.push(v);
  }
  return uniqStrings(out).slice(0, 10);
}

function normalizeFrame(frame, idx, format) {
  const f = asObj(frame);
  const typeByFormat = format === "reel" ? "scene" : idx === 1 ? "cover" : "slide";

  return {
    index: Number(f.index || idx),
    frameType: String(f.frameType || typeByFormat),
    headline: truncate(fixMojibake(f.headline || ""), 140),
    subline: truncate(fixMojibake(f.subline || ""), 240),
    layout: sanitizeVisualText(f.layout || "", 260),
    visualElements: sanitizeVisualElements(asArr(f.visualElements)),
    motion: truncate(fixMojibake(f.motion || ""), 160),
    durationSec: Number.isFinite(Number(f.durationSec)) ? Number(f.durationSec) : 0,
  };
}

function ensureFrames(frames, format, cta = "") {
  let out = asArr(frames)
    .map((f, i) => normalizeFrame(f, i + 1, format))
    .filter(
      (x) => x.headline || x.subline || x.layout || x.visualElements.length
    );

  if (format === "image") {
    if (!out.length) {
      out = [
        {
          index: 1,
          frameType: "cover",
          headline: "AI ilə biznesinizi gücləndirin",
          subline:
            "NEOX avtomatlaşdırma həlləri ilə sürət və səmərəlilik qazanın",
          layout:
            "Editorial composition with clean negative space on left, main visual subject offset to right, premium poster balance",
          visualElements: [
            "premium futuristic subject",
            "subtle data glow",
            "dark gradient atmosphere",
            "elegant tech mood",
          ],
          motion: "",
          durationSec: 0,
        },
      ];
    }
    return [out[0]];
  }

  if (format === "carousel") {
    if (out.length < 5) {
      const base = [...out];
      while (base.length < 5) {
        const idx = base.length + 1;
        base.push(
          normalizeFrame(
            {
              index: idx,
              frameType: idx === 1 ? "cover" : "slide",
              headline:
                idx === 1
                  ? "NEOX ilə gələcəyi qurun"
                  : idx === 5
                  ? "İndi əlaqə saxlayın"
                  : `Əsas üstünlük ${idx - 1}`,
              subline:
                idx === 5
                  ? cta || "Daha çox məlumat üçün NEOX komandası ilə əlaqə saxlayın"
                  : "AI və avtomatlaşdırma ilə daha sürətli və ağıllı işləyin",
              layout:
                "Premium campaign composition with clear negative space, focal subject offset, elegant ad-like balance",
              visualElements: [
                "cinematic tech glow",
                "premium abstract automation forms",
                "futuristic brand atmosphere",
              ],
              motion: "",
              durationSec: 0,
            },
            idx,
            format
          )
        );
      }
      out = base;
    }

    if (out.length > 8) out = out.slice(0, 8);

    return out.map((x, i) => ({
      ...x,
      index: i + 1,
      frameType: i === 0 ? "cover" : "slide",
    }));
  }

  if (format === "reel") {
    if (out.length < 3) {
      const base = [...out];
      while (base.length < 3) {
        const idx = base.length + 1;
        base.push(
          normalizeFrame(
            {
              index: idx,
              frameType: "scene",
              headline: idx === 1 ? "NEOX" : `Scene ${idx}`,
              subline:
                idx === 3
                  ? cta || "Bizimlə əlaqə saxlayın"
                  : "AI ilə daha ağıllı iş axınları",
              layout:
                "Vertical cinematic composition with strong focal subject and clean negative space for later typography",
              visualElements: [
                "vertical motion energy",
                "premium tech subject",
                "cinematic glow",
              ],
              motion: "subtle push-in camera movement",
              durationSec: 2,
            },
            idx,
            format
          )
        );
      }
      out = base;
    }

    if (out.length > 6) out = out.slice(0, 6);

    return out.map((x, i) => ({
      ...x,
      index: i + 1,
      frameType: "scene",
      durationSec:
        Number.isFinite(Number(x.durationSec)) && Number(x.durationSec) > 0
          ? Number(x.durationSec)
          : 2,
    }));
  }

  return out;
}

function pickLayoutFamily({ format, idx, totalSlides, layoutText }) {
  const lt = String(layoutText || "").toLowerCase();

  if (format === "reel") {
    if (lt.includes("center")) return "cinematic_center";
    if (lt.includes("top-left")) return "luxury_top_left";
    if (lt.includes("bottom-left")) return "dramatic_bottom_left";
    return idx === 1 ? "cinematic_center" : "editorial_left";
  }

  if (format === "carousel") {
    if (idx === 1) return "editorial_left";
    if (idx === totalSlides) return "dramatic_bottom_left";
    if (lt.includes("center")) return "cinematic_center";
    if (lt.includes("top-left")) return "luxury_top_left";
    if (lt.includes("bottom-left")) return "dramatic_bottom_left";
    return idx % 2 === 0 ? "luxury_top_left" : "editorial_left";
  }

  if (lt.includes("center")) return "cinematic_center";
  if (lt.includes("top-left")) return "luxury_top_left";
  if (lt.includes("bottom-left")) return "dramatic_bottom_left";
  return "editorial_left";
}

function buildFallbackImagePrompt(payload) {
  const p = asObj(payload);
  const format = String(p.format || "image").trim().toLowerCase();
  const visualPlan = asObj(p.visualPlan);
  const frames = asArr(visualPlan.frames);
  const first = asObj(frames[0]);

  const lines = [
    format === "carousel"
      ? "Create a premium square campaign artwork background for the cover slide of a NEOX carousel."
      : format === "reel"
      ? "Create a premium vertical campaign artwork background for the opening frame of a NEOX reel."
      : "Create a premium campaign artwork background for a NEOX social post.",
    "NEOX is an AI automation and digital technology brand.",
    p.topic ? `Campaign topic: ${p.topic}.` : "",
    p.hook ? `Core message direction: ${p.hook}.` : "",
    "This image must be completely TEXT-FREE.",
    "Absolutely do not render readable text, letters, words, numbers, logos, monograms, UI labels, fake buttons, fake menus, dashboards, browser windows, websites, landing pages, app screens, or navigation bars.",
    "Do not create a website hero section.",
    "Do not create a SaaS dashboard screenshot aesthetic.",
    "Do not create an application interface shot.",
    "Do not create a mobile app UI mockup.",
    first.headline
      ? `Visually support this message theme: ${first.headline}.`
      : "",
    first.subline ? `Secondary message direction: ${first.subline}.` : "",
    visualPlan.style
      ? `Style: ${visualPlan.style}, expressed as premium advertising artwork rather than interface design.`
      : "Style: premium, modern, cinematic, futuristic brand advertising artwork.",
    visualPlan.colorNotes
      ? `Color palette: ${visualPlan.colorNotes}.`
      : "Color palette: deep blue, cyan glow, graphite, subtle silver, premium contrast.",
    visualPlan.composition
      ? `Composition: ${visualPlan.composition}.`
      : "Composition: strong focal subject, elegant negative space, polished premium ad direction.",
    first.layout
      ? `Layout guidance: ${first.layout}.`
      : "Layout guidance: maintain a clean typography-safe negative space area, but do not render any text.",
    asArr(first.visualElements).length
      ? `Visual elements: ${asArr(first.visualElements).join(", ")}.`
      : "",
    format === "reel"
      ? "Aspect ratio intent: 9:16 vertical."
      : format === "carousel"
      ? "Aspect ratio intent: 1:1 square."
      : "Aspect ratio intent: 4:5 vertical social post.",
    "Feel like a polished commercial key visual, editorial campaign artwork, cinematic tech ad, or luxury brand poster background.",
    "The image should feel attractive, modern, premium, warm, and customer-friendly.",
    "Avoid generic stock-photo aesthetics.",
    "Avoid literal UI visualization.",
    "Avoid anything that resembles a screenshot.",
    "Use cinematic lighting, premium materials, depth, atmosphere, subtle glow, and elegant visual hierarchy.",
    "No readable text. No symbols that look like text. No logo marks.",
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

function buildSlideVisualPrompt({ payload, frame, totalSlides, format }) {
  const p = asObj(payload);
  const f = asObj(frame);
  const visualPlan = asObj(p.visualPlan);

  const lines = [
    format === "carousel"
      ? `Create a premium square text-free campaign artwork background for carousel slide ${f.index} of ${totalSlides} for NEOX.`
      : format === "reel"
      ? `Create a premium vertical text-free campaign artwork background for reel scene ${f.index} of ${totalSlides} for NEOX.`
      : "Create a premium text-free campaign artwork background for a NEOX social post.",
    "NEOX is an AI automation and digital technology brand.",
    p.topic ? `Campaign topic: ${p.topic}.` : "",
    f.headline
      ? `The visual should emotionally support this message: ${f.headline}.`
      : "",
    f.subline ? `Secondary message direction: ${f.subline}.` : "",
    "This image is background artwork only.",
    "All final readable text will be added later by a separate render engine.",
    "Absolutely do not render readable text, letters, words, numbers, icons that resemble letters, labels, logos, monograms, menu items, navigation bars, buttons, dashboards, browser windows, website sections, application screens, or interface mockups.",
    "Do not make it look like a website hero section.",
    "Do not make it look like a SaaS dashboard screen.",
    "Do not make it look like a UI concept shot.",
    "Do not make it look like an app promo screenshot.",
    visualPlan.style
      ? `Style: ${visualPlan.style}, interpreted as premium advertising artwork, not interface design.`
      : "Style: premium futuristic brand advertising, cinematic, polished, elegant, visually rich.",
    visualPlan.colorNotes
      ? `Color palette: ${visualPlan.colorNotes}.`
      : "Color palette: deep blue, electric cyan, graphite, soft silver, controlled neon accents.",
    f.layout
      ? `Composition guidance: ${f.layout}.`
      : "Composition: strong focal subject, clear negative space for later typography, premium poster-like structure.",
    asArr(f.visualElements).length
      ? `Visual elements: ${asArr(f.visualElements).join(", ")}.`
      : "",
    format === "reel"
      ? "Aspect ratio intent: 9:16 vertical."
      : format === "carousel"
      ? "Aspect ratio intent: 1:1 square."
      : "Aspect ratio intent: 4:5 vertical social post.",
    "Feel like premium ad campaign artwork, cinematic editorial tech key art, or polished commercial poster background.",
    "The image should feel welcoming, premium, modern, visually memorable, and commercially usable.",
    "Avoid dry corporate visuals.",
    "Avoid screenshots.",
    "Avoid product UI demos.",
    "Use elegant lighting, premium materials, atmosphere, depth, and negative space.",
    "No readable text. No fake text. No logo glyphs.",
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

function buildRenderHints(frame, format, idx, totalSlides) {
  const f = asObj(frame);
  const layoutText = String(f.layout || "").toLowerCase();

  const layoutFamily = pickLayoutFamily({
    format,
    idx,
    totalSlides,
    layoutText,
  });

  let textPosition = "left";
  if (layoutFamily === "cinematic_center") textPosition = "center";
  if (layoutFamily === "luxury_top_left") textPosition = "top-left";
  if (layoutFamily === "dramatic_bottom_left") textPosition = "bottom-left";

  let safeArea = "left-heavy";
  if (layoutFamily === "cinematic_center") safeArea = "centered";
  if (layoutFamily === "luxury_top_left") safeArea = "top-left";
  if (layoutFamily === "dramatic_bottom_left") safeArea = "bottom-left";

  let overlayStrength = "medium";
  if (idx === 1) overlayStrength = "strong";
  if (format === "reel") overlayStrength = "strong";

  let focalBias = "right";
  if (layoutFamily === "cinematic_center") focalBias = "center";
  if (layoutFamily === "luxury_top_left") focalBias = "lower-right";
  if (layoutFamily === "dramatic_bottom_left") focalBias = "upper-right";

  return {
    layoutFamily,
    textPosition,
    safeArea,
    overlayStrength,
    focalBias,
  };
}

function buildSlidesFromFrames(payload) {
  const p = asObj(payload);
  const format = String(p.format || "image").trim().toLowerCase();
  const frames = asArr(asObj(p.visualPlan).frames);
  const totalSlides = frames.length;

  return frames.map((frame, i) => {
    const idx = i + 1;
    const f = asObj(frame);
    const isLast = idx === totalSlides;

    const badge =
      format === "carousel"
        ? idx === 1
          ? "NEOX"
          : isLast
          ? "CTA"
          : "AI HQ"
        : format === "reel"
        ? "REEL"
        : "NEOX";

    const cta = isLast
      ? truncate(
          p.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın",
          80
        )
      : "";

    return {
      id: `slide_${idx}`,
      index: idx,
      frameType: String(
        f.frameType || (format === "reel" ? "scene" : idx === 1 ? "cover" : "slide")
      ),
      title: truncate(f.headline || p.topic || "NEOX", 120),
      subtitle: truncate(f.subline || p.hook || "", 180),
      cta,
      badge,
      align: "left",
      theme: "neox_dark",
      slideNumber: idx,
      totalSlides,
      renderHints: buildRenderHints(f, format, idx, totalSlides),
      visualDirection: truncate(
        [
          f.layout || "",
          asArr(f.visualElements).join(", "),
          f.motion ? `Motion mood: ${f.motion}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        400
      ),
      visualPrompt: buildSlideVisualPrompt({
        payload: p,
        frame: f,
        totalSlides,
        format,
      }),
    };
  });
}

function normalizeContentDraftPayload(rawPayload, vars = {}) {
  const src = asObj(rawPayload);
  const format = String(src.format || vars.format || "image")
    .trim()
    .toLowerCase();
  const language = String(src.language || "az").trim().toLowerCase() || "az";
  const tenantKey =
    String(src.tenantKey || vars.tenantId || "default").trim() || "default";

  const visualPlanSrc = asObj(src.visualPlan);
  const normalizedFrames = ensureFrames(
    visualPlanSrc.frames,
    format,
    src.cta || ""
  );

  const visualPlan = {
    style: truncate(
      fixMojibake(
        visualPlanSrc.style ||
          "premium, cinematic, modern, futuristic, high-end brand advertising"
      ),
      200
    ),
    aspectRatio: String(visualPlanSrc.aspectRatio || pickAspectRatio(format)),
    composition: truncate(
      fixMojibake(
        visualPlanSrc.composition ||
          "clean premium composition, strong hierarchy, clear negative space, polished campaign balance, premium poster-like visual direction"
      ),
      260
    ),
    colorNotes: truncate(
      fixMojibake(
        visualPlanSrc.colorNotes ||
          "deep blue, neon cyan, graphite, subtle silver highlights, premium high-tech contrast"
      ),
      240
    ),
    textOnVisual: [],
    frames: normalizedFrames,
  };

  const assetBriefSrc = asObj(src.assetBrief);
  const neededAssets = uniqStrings(
    assetBriefSrc.neededAssets ||
      (format === "reel"
        ? ["video", "image", "icons", "mockups"]
        : ["image", "icons", "mockups"])
  );
  const brollIdeas = uniqStrings(assetBriefSrc.brollIdeas).slice(0, 10);

  const assetBrief = {
    neededAssets,
    imagePrompt: truncate(
      fixMojibake(assetBriefSrc.imagePrompt || "").trim() ||
        buildFallbackImagePrompt({ ...src, visualPlan, format }),
      2400
    ),
    brollIdeas,
  };

  const payload = {
    type: "content_draft",
    tenantKey,
    language,
    format,
    topic: truncate(
      fixMojibake(src.topic || src.title || "NEOX content draft"),
      180
    ),
    goal: ["lead", "awareness", "trust", "offer"].includes(
      String(src.goal || "").trim()
    )
      ? String(src.goal).trim()
      : "awareness",
    targetAudience: truncate(
      fixMojibake(
        src.targetAudience ||
          "startup founders, SMEs, tech founders, entrepreneurs, business owners interested in automation"
      ),
      220
    ),
    hook: truncate(fixMojibake(src.hook || ""), 220),
    caption: truncate(fixMojibake(src.caption || ""), 1200),
    cta: truncate(
      fixMojibake(src.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın"),
      180
    ),
    hashtags: uniqStrings(asArr(src.hashtags)).slice(0, 18),
    visualPlan,
    slides: [],
    assetBrief,
    complianceNotes: uniqStrings(asArr(src.complianceNotes)).slice(0, 10),
    reviewQuestionsForCEO: uniqStrings(asArr(src.reviewQuestionsForCEO)).slice(
      0,
      8
    ),
  };

  if (!payload.hashtags.some((x) => x.toLowerCase() === "#ai"))
    payload.hashtags.push("#AI");
  if (!payload.hashtags.some((x) => x.toLowerCase() === "#automation"))
    payload.hashtags.push("#Automation");
  if (!payload.hashtags.some((x) => x.toLowerCase() === "#neox"))
    payload.hashtags.push("#Neox");
  payload.hashtags = uniqStrings(payload.hashtags).slice(0, 18);

  if (!payload.reviewQuestionsForCEO.length) {
    payload.reviewQuestionsForCEO = [
      "Bu mövzu bu günkü prioritetə uyğundurmu?",
      "Vizual istiqamət premium NEOX brendinə uyğundurmu?",
      "CTA daha sərt olmalıdır, yoxsa daha yumşaq?",
    ];
  }

  if (!payload.complianceNotes.length) {
    payload.complianceNotes = [
      "Brend tonu premium və peşəkar qalmalıdır.",
      "Həddindən artıq şişirdilmiş nəticə vəd edilməməlidir.",
      "Oxunaqlı və aydın mətn hierarchy qorunmalıdır.",
    ];
  }

  payload.slides = buildSlidesFromFrames(payload);

  if (!payload.slides.length) {
    payload.slides = [
      {
        id: "slide_1",
        index: 1,
        frameType: "cover",
        title: payload.topic || "NEOX",
        subtitle: payload.hook || "",
        cta: payload.cta || "",
        badge: "NEOX",
        align: "left",
        theme: "neox_dark",
        slideNumber: 1,
        totalSlides: 1,
        renderHints: {
          layoutFamily: "editorial_left",
          textPosition: "left",
          safeArea: "left-heavy",
          overlayStrength: "strong",
          focalBias: "right",
        },
        visualDirection:
          "Editorial premium composition with strong focal subject offset to right and clean negative space",
        visualPrompt: assetBrief.imagePrompt,
      },
    ];
  }

  return payload;
}

function normalizeDraftProposalObject(obj, vars = {}) {
  const src = asObj(obj);

  if (
    src.type === "content_draft" ||
    src.format ||
    src.visualPlan ||
    src.assetBrief ||
    src.slides
  ) {
    const payload = normalizeContentDraftPayload(src, vars);
    return {
      type: "draft",
      title: truncate(payload.topic || "Draft", 120),
      payload,
    };
  }

  if (src.type && src.payload && typeof src.payload === "object") {
    const t = String(src.type || "").trim().toLowerCase();
    if (t === "draft") {
      const payload = normalizeContentDraftPayload(src.payload, vars);
      return {
        type: "draft",
        title: truncate(src.title || payload.topic || "Draft", 120),
        payload,
      };
    }
  }

  const payload = normalizeContentDraftPayload(src.payload || src, vars);
  return {
    type: "draft",
    title: truncate(src.title || payload.topic || "Draft", 120),
    payload,
  };
}

async function synthesizeFinal({
  openai,
  message,
  agentNotes,
  mode,
  timeoutMs,
  vars,
}) {
  const normMode = normalizeMode(mode);

  const notesText = (agentNotes || [])
    .map((n) => `### ${n.agentId}\n${String(n.text || "").trim()}`)
    .join("\n\n");

  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 2200);
  const sysText = buildSynthesisSystem({ mode: normMode, vars });

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

  const respText = await withTimeout(
    openai.responses.create(reqText),
    timeoutMs,
    "OpenAI timeout (synthesis)"
  );
  let outText = extractText(respText);

  if (!String(outText || "").trim()) {
    logRawIfEmpty("synth", "kernel", respText, outText);
    outText = visibleEmptyMarker("synth", "kernel", respText);
  }

  outText = fixMojibake(String(outText || "").trim());
  if (!outText) outText = fallbackSynthesis(agentNotes);

  const expectsJson = modeExpectsJson(normMode);

  if (!expectsJson) {
    return { finalAnswer: outText, proposal: null };
  }

  let obj = extractJsonFromText(outText);

  if (!obj) {
    try {
      obj = await strictJsonRepair({ openai, badText: outText, timeoutMs });
    } catch {}
  }

  if (normMode === "proposal") {
    if (!obj || typeof obj !== "object") obj = null;
    return { finalAnswer: outText, proposal: obj };
  }

  if (normMode === "draft") {
    const proposal = normalizeDraftProposalObject(obj || { raw: outText }, vars);
    return { finalAnswer: outText, proposal };
  }

  if (obj && typeof obj === "object") {
    if (obj.type && obj.payload) {
      return { finalAnswer: outText, proposal: obj };
    }
    return {
      finalAnswer: outText,
      proposal: {
        type: String(normMode),
        title: String(
          obj.title || obj.summary || obj.topic || obj.name || "Draft"
        ).slice(0, 120),
        payload: obj,
      },
    };
  }

  return {
    finalAnswer: outText,
    proposal: {
      type: String(normMode),
      title: "Draft",
      payload: { raw: outText },
    },
  };
}

export async function runDebate({
  message,
  agents = DEFAULT_AGENTS,
  rounds = 2,
  mode = "answer",
  tenantId = "default",
  threadId = "",
  formatHint = null,
}) {
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
    const roundNotes = await mapLimit(
      agentIds,
      concurrency,
      async (agentId) => {
        try {
          const text = await askAgent({
            openai,
            agentId,
            message,
            round,
            notesSoFar,
            timeoutMs,
          });
          return { agentId, text: fixMojibake(text || "") };
        } catch (e) {
          return { agentId, text: `⚠️ failed: ${String(e?.message || e)}` };
        }
      }
    );

    agentNotes.push(...roundNotes);
    notesSoFar = agentNotes.map((n) => `[${n.agentId}] ${n.text}`).join("\n\n");
  }

  const vars = {
    tenantId: String(tenantId || "default"),
    threadId: String(threadId || ""),
    format: String(formatHint || "").trim() || "auto",
    today: new Date().toISOString().slice(0, 10),
    mode: normalizeMode(mode),
  };

  const synth = await synthesizeFinal({
    openai,
    message,
    agentNotes,
    mode: normalizeMode(mode),
    timeoutMs,
    vars,
  });

  return {
    finalAnswer: fixMojibake(synth.finalAnswer),
    agentNotes: agentNotes.map((n) => ({
      agentId: n.agentId,
      text: fixMojibake(n.text),
    })),
    proposal: synth.proposal,
  };
}