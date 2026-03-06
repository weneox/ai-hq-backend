// src/kernel/debateEngine.js
//
// FINAL v8.0 — premium tech-scene-first draft normalization
//
// Goals:
// ✅ Keep existing debate flow
// ✅ Normalize content drafts for render pipeline
// ✅ Guarantee payload.assetBrief.imagePrompt
// ✅ Guarantee payload.slides[]
// ✅ Guarantee slides[].visualPrompt
// ✅ Guarantee payload.visualPlan.visualPreset
// ✅ Greatly widen business topic coverage
// ✅ Push image generation toward clean text-free technology scenes
// ✅ Reduce poster / UI / website / baked-text associations
// ✅ Reduce left blur / muddy overlay direction in visual composition
// ✅ Keep renderHints deterministic for later renderer

import OpenAI from "openai";
import { cfg } from "../config.js";
import { getGlobalPolicy, getUsecasePrompt } from "../prompts/index.js";

export const DEBATE_ENGINE_VERSION = "final-v8.0";
console.log(`[debateEngine] LOADED ${DEBATE_ENGINE_VERSION}`);

const DEFAULT_AGENTS = ["orion", "nova", "atlas", "echo"];

const ALLOWED_GOALS = ["lead", "awareness", "trust", "offer"];
const ALLOWED_FORMATS = ["image", "carousel", "reel"];
const ALLOWED_VISUAL_PRESETS = [
  "robotic_unit",
  "ai_core",
  "automation_device",
  "abstract_tech_scene",
];

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

function cleanText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function lower(input) {
  return cleanText(input).toLowerCase();
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
    max_output_tokens: 1800,
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

function normalizeFormat(format) {
  const f = String(format || "").trim().toLowerCase();
  if (ALLOWED_FORMATS.includes(f)) return f;
  return "image";
}

function pickAspectRatio(format) {
  const f = normalizeFormat(format);
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

function normalizeAspectRatio(aspectRatio, format) {
  const a = String(aspectRatio || "").trim();
  if (a === "1:1" || a === "4:5" || a === "9:16") return a;
  return pickAspectRatio(format);
}

function sanitizeVisualText(x, max = 260) {
  let t = fixMojibake(String(x || "").trim());
  if (!t) return "";

  t = t
    .replace(/\b(navbar|navigation|menu|header|footer|button|cta button)\b/gi, "")
    .replace(/\b(website|landing page|web page|homepage|site hero|hero section|hero banner)\b/gi, "")
    .replace(/\b(dashboard|admin panel|analytics panel|saas ui|ui screen|app screen|app ui|browser window|software screen)\b/gi, "")
    .replace(/\b(mockup of a website|interface mockup|ui mockup|screen mockup|figma mockup|dribbble shot)\b/gi, "")
    .replace(/\b(poster|campaign|advertisement|advertising|commercial|editorial|branded|marketing|social cover|cover design|thumbnail design)\b/gi, "")
    .replace(/\b(copy-safe|copy safe|text-safe|text safe|headline area|title area|copy area|negative space|text area)\b/gi, "")
    .replace(/\b(readable text|letters|words|numbers|logo|label|branding|symbols)\b/gi, "")
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
    "screen ui",
    "browser",
    "navbar",
    "menu",
    "button",
    "interface",
    "app screen",
    "admin panel",
    "poster",
    "campaign",
    "advertising",
    "marketing layout",
    "copy-safe",
    "headline area",
    "title area",
    "logo",
    "label",
    "readable text",
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

function normalizeGoal(goal) {
  const g = String(goal || "").trim().toLowerCase();
  return ALLOWED_GOALS.includes(g) ? g : "awareness";
}

function ensureHashtagTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return "";
  return t.startsWith("#") ? t : `#${t}`;
}

function normalizeHashtags(arr = []) {
  const tags = uniqStrings(asArr(arr).map(ensureHashtagTag)).slice(0, 18);
  if (!tags.some((x) => x.toLowerCase() === "#ai")) tags.push("#AI");
  if (!tags.some((x) => x.toLowerCase() === "#automation")) tags.push("#Automation");
  if (!tags.some((x) => x.toLowerCase() === "#neox")) tags.push("#Neox");
  return uniqStrings(tags).slice(0, 18);
}

function detectTopicFamily(topic, hook, caption) {
  const t = lower([topic, hook, caption].filter(Boolean).join(" "));

  if (/\b(chatbot|assistant|virtual assistant|voice assistant|customer support|support|receptionist|call handling|whatsapp|instagram dm|messenger|faq)\b/.test(t)) {
    return "conversational_ai";
  }
  if (/\b(lead|qualification|sales|crm|pipeline|follow-up|conversion|missed lead|lead capture|upsell|cross-sell)\b/.test(t)) {
    return "sales_automation";
  }
  if (/\b(hr|recruitment|screening|employee onboarding|onboarding|hiring)\b/.test(t)) {
    return "hr_automation";
  }
  if (/\b(reporting|analytics|insight|brief|summary|dashboard insight|ceo brief)\b/.test(t)) {
    return "insight_automation";
  }
  if (/\b(content|caption|comment reply|publishing|social media|content approval|creative|post generation)\b/.test(t)) {
    return "content_automation";
  }
  if (/\b(appointment|booking|clinic|healthcare|consultation|reservation)\b/.test(t)) {
    return "booking_automation";
  }
  if (/\b(e-commerce|cart|retention|reactivation|order tracking|customer journey)\b/.test(t)) {
    return "commerce_automation";
  }
  if (/\b(logistics|routing|field operations|service routing|coordination|workflow|task routing|operations)\b/.test(t)) {
    return "ops_automation";
  }
  if (/\b(education|enrollment|course|student|learning)\b/.test(t)) {
    return "education_automation";
  }
  if (/\b(real estate|property|inquiry routing)\b/.test(t)) {
    return "real_estate_automation";
  }
  if (/\b(transformation|innovation|future|ai infrastructure|intelligence|automation systems)\b/.test(t)) {
    return "future_ai";
  }

  return "general_automation";
}

function pickVisualPresetFromTopicFamily(topicFamily, currentPreset) {
  const p = String(currentPreset || "").trim();
  if (ALLOWED_VISUAL_PRESETS.includes(p)) return p;

  if (topicFamily === "conversational_ai") return "robotic_unit";
  if (topicFamily === "sales_automation") return "automation_device";
  if (topicFamily === "hr_automation") return "automation_device";
  if (topicFamily === "insight_automation") return "ai_core";
  if (topicFamily === "content_automation") return "automation_device";
  if (topicFamily === "booking_automation") return "automation_device";
  if (topicFamily === "commerce_automation") return "automation_device";
  if (topicFamily === "ops_automation") return "automation_device";
  if (topicFamily === "education_automation") return "abstract_tech_scene";
  if (topicFamily === "real_estate_automation") return "automation_device";
  if (topicFamily === "future_ai") return "ai_core";

  return "abstract_tech_scene";
}

function presetStyleBlock(preset) {
  if (preset === "robotic_unit") {
    return {
      style:
        "Premium robotic object render, dark studio environment, sculptural service-machine design, elegant industrial surfaces, controlled cyan-blue glow, believable premium engineering",
      composition:
        "One dominant robotic or semi-robotic hero subject, strong right-side or center-right focal bias, clean left side, balanced premium depth, no heavy blur wall",
      elements: [
        "premium robotic unit",
        "service-machine silhouette",
        "engineered metal surfaces",
        "subtle communication light arcs",
      ],
    };
  }

  if (preset === "ai_core") {
    return {
      style:
        "Abstract intelligent AI core visual, layered futuristic nucleus, controlled light emission, refined glow, premium dark atmosphere, elegant technological depth",
      composition:
        "One iconic central or slightly offset AI core subject, high-end depth separation, refined atmosphere, calm left side, reduced fog mass, premium futuristic balance",
      elements: [
        "AI core",
        "energy nucleus",
        "layered luminous structure",
        "refined light depth",
      ],
    };
  }

  if (preset === "automation_device") {
    return {
      style:
        "Premium automation hardware visual, product-grade engineered system object, dark studio scene, graphite and glass materials, precision industrial detailing, controlled cyan light",
      composition:
        "One dominant automation device or smart module, right-side or lower-right focal object, cleaner left side for render, strong material readability, no muddy overlays",
      elements: [
        "automation device",
        "smart control module",
        "engineered hardware",
        "precision signal rails",
      ],
    };
  }

  return {
    style:
      "Premium abstract technology scene, elegant futuristic spatial composition, engineered structures, high-end atmosphere, controlled glow, cinematic depth, clean dark environment",
    composition:
      "One dominant spatial technology structure or atmospheric focal area, balanced open composition, cleaner left side, refined light layering, no poster layout feel",
    elements: [
      "abstract technology environment",
      "engineered light structure",
      "premium spatial depth",
      "futuristic architectural form",
    ],
  };
}

function topicFamilyElements(topicFamily) {
  const map = {
    conversational_ai: [
      "communication signal arcs",
      "intelligent service presence",
      "assistant-like machine behavior",
    ],
    sales_automation: [
      "routing channels",
      "structured data capsules",
      "sequenced automation flow",
    ],
    hr_automation: [
      "qualification channels",
      "sorted intelligence pathways",
      "structured decision modules",
    ],
    insight_automation: [
      "condensed intelligence core",
      "signal synthesis layers",
      "executive clarity motif",
    ],
    content_automation: [
      "creative production engine",
      "orchestrated system flow",
      "premium generation module",
    ],
    booking_automation: [
      "scheduling routes",
      "service coordination signals",
      "precision intake pathways",
    ],
    commerce_automation: [
      "retention flow channels",
      "commerce signal movement",
      "lifecycle automation modules",
    ],
    ops_automation: [
      "process orchestration rails",
      "timing control paths",
      "operations coordination structure",
    ],
    education_automation: [
      "guided progression channels",
      "knowledge pathways",
      "supportive system layers",
    ],
    real_estate_automation: [
      "inquiry intake structure",
      "matching signal routes",
      "premium lead routing motif",
    ],
    future_ai: [
      "visionary intelligence glow",
      "futuristic system energy",
      "next-generation infrastructure forms",
    ],
    general_automation: [
      "automation pathways",
      "intelligent system channels",
      "premium operational flow",
    ],
  };

  return map[topicFamily] || map.general_automation;
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

function buildFallbackFrame({
  idx,
  format,
  total,
  cta,
  topic,
  preset,
  topicFamily,
}) {
  const presetPack = presetStyleBlock(preset);
  const topicEls = topicFamilyElements(topicFamily);

  const isCover = idx === 1;
  const isLast = idx === total;

  let headline = "NEOX ilə daha ağıllı sistem";
  let subline = "AI və avtomatlaşdırma ilə sürət, sistem və keyfiyyət qazanın";

  if (isCover) {
    headline =
      topic && topic.length > 4 ? truncate(topic, 110) : "AI biznesdə harada işləyir?";
    subline = "Praktik istifadə sahələri, sistemli axınlar və real avtomatlaşdırma imkanları";
  } else if (isLast) {
    headline = "Sistemi biznesinizə uyğun quraq";
    subline = truncate(
      cta || "NEOX ilə uyğun AI avtomatlaşdırma həllərini qurmaq üçün əlaqə saxlayın",
      180
    );
  } else {
    headline = `İstifadə sahəsi ${idx - 1}`;
    subline = "Manual işi azaldan və prosesi sürətləndirən ağıllı avtomatlaşdırma axını";
  }

  return normalizeFrame(
    {
      index: idx,
      frameType: format === "reel" ? "scene" : isCover ? "cover" : "slide",
      headline,
      subline,
      layout:
        idx === 1
          ? "clean premium composition with dominant subject on right side, calm refined left side, reduced left blur, elegant studio depth"
          : isLast
          ? "clean composition with strong focal device and clear premium balance, open left side without heavy fog"
          : "clean technology scene with one dominant object, right-biased focal subject, controlled atmosphere, minimal left-side haze",
      visualElements: uniqStrings([
        ...presetPack.elements,
        ...topicEls,
      ]).slice(0, 6),
      motion: format === "reel" ? "subtle push-in camera movement" : "",
      durationSec: format === "reel" ? 2 : 0,
    },
    idx,
    format
  );
}

function ensureFrames(frames, format, cta = "", topic = "", preset = "", topicFamily = "") {
  let out = asArr(frames)
    .map((f, i) => normalizeFrame(f, i + 1, format))
    .filter((x) => x.headline || x.subline || x.layout || x.visualElements.length);

  if (format === "image") {
    if (!out.length) {
      out = [
        buildFallbackFrame({
          idx: 1,
          format,
          total: 1,
          cta,
          topic,
          preset,
          topicFamily,
        }),
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
          buildFallbackFrame({
            idx,
            format,
            total: 5,
            cta,
            topic,
            preset,
            topicFamily,
          })
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
          buildFallbackFrame({
            idx,
            format,
            total: 3,
            cta,
            topic,
            preset,
            topicFamily,
          })
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

  let overlayStrength = "soft";
  if (idx === 1) overlayStrength = "medium";
  if (format === "reel") overlayStrength = "medium";

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

function buildFallbackImagePrompt(payload) {
  const p = asObj(payload);
  const format = normalizeFormat(p.format || "image");
  const visualPlan = asObj(p.visualPlan);
  const frames = asArr(visualPlan.frames);
  const first = asObj(frames[0]);
  const preset = pickVisualPresetFromTopicFamily(
    detectTopicFamily(p.topic, p.hook, p.caption),
    visualPlan.visualPreset
  );

  const aspectLine =
    format === "reel"
      ? "Vertical 9:16 framing."
      : format === "carousel"
      ? "Square 1:1 framing."
      : "Vertical 4:5 framing.";

  const presetBlock = presetStyleBlock(preset);

  const lines = [
    "Create a premium text-free futuristic technology scene for NEOX, an AI automation and digital technology brand.",
    p.topic ? `Topic context: ${p.topic}.` : "",
    p.hook ? `Message mood reference: ${p.hook}.` : "",
    first.headline ? `Primary frame emotion: ${first.headline}.` : "",
    first.subline ? `Secondary frame mood: ${first.subline}.` : "",
    `Visual preset: ${preset}.`,
    visualPlan.style
      ? `Style direction: ${sanitizeVisualText(visualPlan.style, 220)}.`
      : `Style direction: ${presetBlock.style}.`,
    visualPlan.colorNotes
      ? `Color palette: ${sanitizeVisualText(visualPlan.colorNotes, 180)}.`
      : "Color palette: deep graphite, cyan highlights, cool blue glow, premium dark contrast, subtle silver reflections.",
    visualPlan.composition
      ? `Composition: ${sanitizeVisualText(visualPlan.composition, 240)}.`
      : `Composition: ${presetBlock.composition}.`,
    first.layout
      ? `Frame arrangement mood: ${sanitizeVisualText(first.layout, 180)}.`
      : "",
    asArr(first.visualElements).length
      ? `Elements: ${asArr(first.visualElements).join(", ")}.`
      : `Elements: ${presetBlock.elements.join(", ")}.`,
    "Prefer one dominant focal subject, not many competing objects.",
    "Use premium industrial materials, engineered surfaces, controlled reflections, refined atmosphere, and cinematic depth.",
    "Keep the left side cleaner and calmer, but do not bury it under fog, blur mass, or muddy black overlays.",
    "Avoid poster layout, website hero look, dashboard look, app UI, floating interface cards, or software screen aesthetics.",
    "If a device appears, its display must remain abstract and unreadable, using only ambient gradients or non-readable luminous surfaces.",
    "No readable text, no letters, no words, no numbers, no labels, no logos, no symbols, no fake branding, no interface details.",
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

function buildSlideVisualPrompt({
  payload,
  frame,
  totalSlides,
  format,
  visualPreset,
}) {
  const p = asObj(payload);
  const f = asObj(frame);
  const visualPlan = asObj(p.visualPlan);
  const preset = String(visualPreset || visualPlan.visualPreset || "abstract_tech_scene");
  const aspectLine =
    format === "reel"
      ? "Vertical 9:16 framing."
      : format === "carousel"
      ? "Square 1:1 framing."
      : "Vertical 4:5 framing.";

  const presetBlock = presetStyleBlock(preset);

  const lines = [
    format === "carousel"
      ? `Create a premium text-free futuristic technology scene for NEOX carousel slide ${f.index} of ${totalSlides}.`
      : format === "reel"
      ? `Create a premium text-free futuristic technology scene for NEOX reel scene ${f.index} of ${totalSlides}.`
      : "Create a premium text-free futuristic technology scene for a NEOX social post.",
    p.topic ? `Topic context: ${p.topic}.` : "",
    `Visual preset: ${preset}.`,
    f.headline ? `Message mood reference: ${f.headline}.` : "",
    f.subline ? `Secondary message mood: ${f.subline}.` : "",
    visualPlan.style
      ? `Style direction: ${sanitizeVisualText(visualPlan.style, 220)}.`
      : `Style direction: ${presetBlock.style}.`,
    visualPlan.colorNotes
      ? `Color palette: ${sanitizeVisualText(visualPlan.colorNotes, 180)}.`
      : "Color palette: deep graphite, cyan-blue lighting, premium dark contrast, subtle metallic reflections.",
    f.layout
      ? `Composition feel: ${sanitizeVisualText(f.layout, 200)}.`
      : `Composition feel: ${presetBlock.composition}.`,
    asArr(f.visualElements).length
      ? `Elements: ${asArr(f.visualElements).join(", ")}.`
      : `Elements: ${presetBlock.elements.join(", ")}.`,
    "Scene only. Final readable text will be placed later by a separate render engine.",
    "Prefer one dominant focal subject and a minimal number of supporting elements.",
    "Use premium industrial materials, refined depth separation, controlled glow, and elegant studio or high-tech atmosphere.",
    "Keep the left side calmer and more open without heavy blur wall, oversized fog, or muddy dark overlay.",
    "Avoid website sections, landing pages, dashboard scenes, app screens, social template layout, poster composition, or interface details.",
    "If a screen or device appears, keep it abstract and unreadable with ambient light only.",
    "No readable text, no letters, no words, no numbers, no labels, no logos, no symbols, no fake branding, no UI.",
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

function buildSlidesFromFrames(payload) {
  const p = asObj(payload);
  const format = normalizeFormat(p.format || "image");
  const frames = asArr(asObj(p.visualPlan).frames);
  const totalSlides = frames.length;
  const visualPreset = String(asObj(p.visualPlan).visualPreset || "abstract_tech_scene");

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
        visualPreset,
      }),
    };
  });
}

function normalizeNeededAssets(srcAssets, format) {
  const incoming = uniqStrings(asArr(srcAssets));
  if (incoming.length) return incoming.slice(0, 10);

  if (format === "reel") return ["video", "image", "icons", "mockups"];
  return ["image", "icons", "mockups"];
}

function normalizeTopic(src) {
  const candidate = truncate(
    fixMojibake(src.topic || src.title || "NEOX content draft"),
    180
  );

  return candidate || "NEOX content draft";
}

function normalizeVisualPlan({
  visualPlanSrc,
  format,
  topic,
  cta,
  topicFamily,
  visualPreset,
}) {
  const presetPack = presetStyleBlock(visualPreset);

  const frames = ensureFrames(
    visualPlanSrc.frames,
    format,
    cta,
    topic,
    visualPreset,
    topicFamily
  );

  return {
    visualPreset,
    style: truncate(
      fixMojibake(
        visualPlanSrc.style ||
          presetPack.style
      ),
      220
    ),
    aspectRatio: normalizeAspectRatio(visualPlanSrc.aspectRatio, format),
    composition: truncate(
      fixMojibake(
        visualPlanSrc.composition ||
          presetPack.composition
      ),
      280
    ),
    colorNotes: truncate(
      fixMojibake(
        visualPlanSrc.colorNotes ||
          "Deep graphite, electric cyan, cool blue highlights, subtle silver reflections, premium dark contrast, controlled luminous accents"
      ),
      240
    ),
    textOnVisual: [],
    frames,
  };
}

function normalizeContentDraftPayload(rawPayload, vars = {}) {
  const src = asObj(rawPayload);
  const format = normalizeFormat(src.format || vars.format || "image");
  const language = String(src.language || "az").trim().toLowerCase() || "az";
  const tenantKey =
    String(src.tenantKey || vars.tenantId || "default").trim() || "default";

  const topic = normalizeTopic(src);
  const hook = truncate(fixMojibake(src.hook || ""), 220);
  const caption = truncate(fixMojibake(src.caption || ""), 1200);
  const cta = truncate(
    fixMojibake(src.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın"),
    180
  );

  const topicFamily = detectTopicFamily(topic, hook, caption);
  const visualPlanSrc = asObj(src.visualPlan);
  const visualPreset = pickVisualPresetFromTopicFamily(
    topicFamily,
    visualPlanSrc.visualPreset
  );

  const visualPlan = normalizeVisualPlan({
    visualPlanSrc,
    format,
    topic,
    cta,
    topicFamily,
    visualPreset,
  });

  const assetBriefSrc = asObj(src.assetBrief);
  const assetBrief = {
    neededAssets: normalizeNeededAssets(assetBriefSrc.neededAssets, format),
    imagePrompt: truncate(
      fixMojibake(assetBriefSrc.imagePrompt || "").trim() ||
        buildFallbackImagePrompt({
          ...src,
          topic,
          hook,
          caption,
          cta,
          visualPlan,
          format,
        }),
      2400
    ),
    brollIdeas: uniqStrings(assetBriefSrc.brollIdeas).slice(0, 10),
  };

  const payload = {
    type: "content_draft",
    tenantKey,
    language,
    format,
    topic,
    goal: normalizeGoal(src.goal),
    targetAudience: truncate(
      fixMojibake(
        src.targetAudience ||
          "startup founders, SMEs, tech founders, entrepreneurs, business owners interested in automation"
      ),
      220
    ),
    hook,
    caption,
    cta,
    hashtags: normalizeHashtags(src.hashtags),
    visualPlan,
    slides: [],
    assetBrief,
    complianceNotes: uniqStrings(asArr(src.complianceNotes)).slice(0, 10),
    reviewQuestionsForCEO: uniqStrings(asArr(src.reviewQuestionsForCEO)).slice(0, 8),
  };

  if (!payload.reviewQuestionsForCEO.length) {
    payload.reviewQuestionsForCEO = [
      "Bu mövzu bu gün üçün kifayət qədər aktual və dəyərlidirmi?",
      "Seçilmiş vizual preset NEOX-un premium texnologiya dilinə uyğundurmu?",
      "CTA daha direkt olmalıdır, yoxsa daha yumşaq satış yanaşması saxlanmalıdır?",
    ];
  }

  if (!payload.complianceNotes.length) {
    payload.complianceNotes = [
      "Brend tonu premium, peşəkar və inandırıcı qalmalıdır.",
      "Şişirdilmiş və sübutsuz nəticə vədlərindən qaçılmalıdır.",
      "Final render zamanı oxunaqlılıq və təmiz hierarchy qorunmalıdır.",
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
          overlayStrength: "medium",
          focalBias: "right",
        },
        visualDirection:
          "Clean premium technology scene with one dominant subject, calmer left side, refined studio depth, reduced blur mass",
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

  const maxOut = Number(cfg.OPENAI_DEBATE_SYNTH_TOKENS || 2600);
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