// src/kernel/debate/contentDraft.visuals.js

import {
  asArr,
  asObj,
  fixMojibake,
  lower,
  truncate,
  uniqStrings,
} from "./utils.js";

const ALLOWED_FORMATS = ["image", "carousel", "reel"];
const ALLOWED_VISUAL_PRESETS = [
  "robotic_unit",
  "ai_core",
  "automation_device",
  "abstract_tech_scene",
  "chatbot_operator",
  "sales_flow_machine",
  "support_ai_hub",
  "workflow_engine",
];

function s(v) {
  return String(v ?? "").trim();
}

function normalizeLang(v, fallback = "az") {
  const x = s(v).toLowerCase();
  if (!x) return fallback;
  if (["az", "aze", "azerbaijani"].includes(x)) return "az";
  if (["en", "eng", "english"].includes(x)) return "en";
  if (["ru", "rus", "russian"].includes(x)) return "ru";
  if (["tr", "tur", "turkish"].includes(x)) return "tr";
  return x;
}

function getTenantRuntime(payloadOrVars = {}) {
  const src = asObj(payloadOrVars);
  const tenant = asObj(src.tenant || src.vars?.tenant || {});
  const tenantId = s(src.tenantId || src.vars?.tenantId || tenant.tenantId || tenant.tenantKey || "default") || "default";
  const companyName =
    s(tenant.companyName || tenant.brandName || tenant.name) || tenantId;
  const outputLanguage = normalizeLang(
    tenant.outputLanguage || tenant.language || src.language || src.vars?.language || "az",
    "az"
  );
  const visualTheme = s(tenant.visualTheme || "premium_modern") || "premium_modern";

  return {
    tenantId,
    companyName,
    outputLanguage,
    visualTheme,
  };
}

function defaultBrandBadge(companyName = "") {
  const clean = s(companyName).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!clean) return "BRAND";
  return truncate(clean.toUpperCase(), 18);
}

export function normalizeFormat(format) {
  const f = String(format || "").trim().toLowerCase();
  if (ALLOWED_FORMATS.includes(f)) return f;
  return "image";
}

export function pickAspectRatio(format) {
  const f = normalizeFormat(format);
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

export function normalizeAspectRatio(aspectRatio, format) {
  const a = String(aspectRatio || "").trim();
  if (a === "1:1" || a === "4:5" || a === "9:16") return a;
  return pickAspectRatio(format);
}

export function sanitizeVisualText(x, max = 260) {
  let t = fixMojibake(String(x || "").trim());
  if (!t) return "";

  t = t
    .replace(/\b(navbar|navigation|menu|header|footer|button|cta button)\b/gi, "")
    .replace(
      /\b(website|landing page|web page|homepage|site hero|hero section|hero banner)\b/gi,
      ""
    )
    .replace(
      /\b(dashboard|admin panel|analytics panel|saas ui|ui screen|app screen|app ui|browser window|software screen)\b/gi,
      ""
    )
    .replace(
      /\b(mockup of a website|interface mockup|ui mockup|screen mockup|figma mockup|dribbble shot)\b/gi,
      ""
    )
    .replace(
      /\b(poster|campaign|advertisement|advertising|commercial layout|editorial layout|branded layout|marketing layout|social cover|cover design|thumbnail design)\b/gi,
      ""
    )
    .replace(
      /\b(copy-safe|copy safe|text-safe|text safe|headline area|title area|copy area|negative space|text area)\b/gi,
      ""
    )
    .replace(/\b(readable text|letters|words|numbers|logo|label|branding|symbols)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return truncate(t, max);
}

export function sanitizeVisualElements(arr = []) {
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

export function detectTopicFamily(topic, hook, caption) {
  const t = lower([topic, hook, caption].filter(Boolean).join(" "));

  if (
    /\b(chatbot|assistant|virtual assistant|voice assistant|customer support|support|receptionist|call handling|whatsapp|instagram dm|messenger|faq|conversation|reply)\b/.test(
      t
    )
  ) {
    return "conversational_ai";
  }
  if (
    /\b(lead|qualification|sales|crm|pipeline|follow-up|conversion|missed lead|lead capture|upsell|cross-sell)\b/.test(
      t
    )
  ) {
    return "sales_automation";
  }
  if (/\b(hr|recruitment|screening|employee onboarding|onboarding|hiring)\b/.test(t)) {
    return "hr_automation";
  }
  if (
    /\b(reporting|analytics|insight|brief|summary|dashboard insight|ceo brief)\b/.test(t)
  ) {
    return "insight_automation";
  }
  if (
    /\b(content|caption|comment reply|publishing|social media|content approval|creative|post generation)\b/.test(
      t
    )
  ) {
    return "content_automation";
  }
  if (/\b(appointment|booking|clinic|healthcare|consultation|reservation)\b/.test(t)) {
    return "booking_automation";
  }
  if (
    /\b(e-commerce|cart|retention|reactivation|order tracking|customer journey)\b/.test(t)
  ) {
    return "commerce_automation";
  }
  if (
    /\b(logistics|routing|field operations|service routing|coordination|workflow|task routing|operations|process)\b/.test(
      t
    )
  ) {
    return "ops_automation";
  }
  if (/\b(education|enrollment|course|student|learning)\b/.test(t)) {
    return "education_automation";
  }
  if (/\b(real estate|property|inquiry routing)\b/.test(t)) {
    return "real_estate_automation";
  }
  if (
    /\b(transformation|innovation|future|ai infrastructure|intelligence|automation systems)\b/.test(
      t
    )
  ) {
    return "future_ai";
  }

  return "general_automation";
}

export function pickVisualPresetFromTopicFamily(topicFamily, currentPreset) {
  const p = String(currentPreset || "").trim();
  if (ALLOWED_VISUAL_PRESETS.includes(p)) return p;

  if (topicFamily === "conversational_ai") return "chatbot_operator";
  if (topicFamily === "sales_automation") return "sales_flow_machine";
  if (topicFamily === "hr_automation") return "workflow_engine";
  if (topicFamily === "insight_automation") return "ai_core";
  if (topicFamily === "content_automation") return "automation_device";
  if (topicFamily === "booking_automation") return "support_ai_hub";
  if (topicFamily === "commerce_automation") return "sales_flow_machine";
  if (topicFamily === "ops_automation") return "workflow_engine";
  if (topicFamily === "education_automation") return "abstract_tech_scene";
  if (topicFamily === "real_estate_automation") return "support_ai_hub";
  if (topicFamily === "future_ai") return "ai_core";

  return "abstract_tech_scene";
}

export function presetStyleBlock(preset) {
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

  if (preset === "chatbot_operator") {
    return {
      style:
        "Premium conversational AI visual, elegant humanoid or device-like assistant presence, dark studio atmosphere, refined cyan edge light, premium industrial design, believable futuristic service aesthetic",
      composition:
        "One dominant assistant-like subject, premium center-right or right focal bias, calm open surrounding space, cinematic depth, no interface clutter",
      elements: [
        "assistant-like machine presence",
        "communication light arcs",
        "subtle signal particles",
        "premium service intelligence motif",
      ],
    };
  }

  if (preset === "support_ai_hub") {
    return {
      style:
        "Premium service orchestration hub visual, dark graphite environment, elegant communication energy routes, refined AI support atmosphere, believable futuristic business-tech realism",
      composition:
        "One dominant central support hub or communication core, clean surrounding negative space, premium depth layering, controlled glow and signal rhythm",
      elements: [
        "support hub",
        "communication signal routes",
        "service coordination energy",
        "refined intelligent control center",
      ],
    };
  }

  if (preset === "sales_flow_machine") {
    return {
      style:
        "Premium sales automation machine visual, engineered funnel-like technology object, dark studio environment, glass-metal precision detailing, refined luminous data movement",
      composition:
        "One dominant funnel or routing machine object, lower-right or center-right subject placement, premium spacious composition, controlled depth and material clarity",
      elements: [
        "sales routing machine",
        "structured data capsules",
        "conversion flow channels",
        "precision automation rails",
      ],
    };
  }

  if (preset === "workflow_engine") {
    return {
      style:
        "Premium workflow engine visual, industrial-grade orchestration module, deep graphite space, cyan-blue signal lines, elegant moving energy channels, believable system logic made physical",
      composition:
        "One dominant engine-like subject, right-side or central focal mass, clean calm support space, premium cinematic depth, no UI fragments",
      elements: [
        "workflow engine",
        "orchestration rails",
        "signal routes",
        "precision system chambers",
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

export function topicFamilyElements(topicFamily) {
  const map = {
    conversational_ai: [
      "communication signal arcs",
      "assistant-like intelligence presence",
      "service response energy",
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

export function normalizeFrame(frame, idx, format) {
  const f = asObj(frame);
  const typeByFormat = format === "reel" ? "scene" : idx === 1 ? "cover" : "slide";

  return {
    index: Number(f.index || idx),
    frameType: String(f.frameType || typeByFormat),
    headline: truncate(fixMojibake(f.headline || ""), 140),
    subline: truncate(fixMojibake(f.subline || ""), 240),
    layout: sanitizeVisualText(f.layout || "", 260),
    visualElements: sanitizeVisualElements(asArr(f.visualElements)),
    motion: truncate(fixMojibake(f.motion || ""), 180),
    durationSec: Number.isFinite(Number(f.durationSec)) ? Number(f.durationSec) : 0,
  };
}

export function buildFallbackFrame({
  idx,
  format,
  total,
  cta,
  topic,
  preset,
  topicFamily,
  vars = {},
}) {
  const tenant = getTenantRuntime(vars);
  const lang = tenant.outputLanguage;
  const presetPack = presetStyleBlock(preset);
  const topicEls = topicFamilyElements(topicFamily);

  const isCover = idx === 1;
  const isLast = idx === total;

  let headline =
    lang === "az"
      ? "Daha ağıllı sistem qurun"
      : "Build a smarter system";

  let subline =
    lang === "az"
      ? "Daha sürətli, daha sistemli və daha keyfiyyətli iş axını qurun"
      : "Create a faster, more structured, and higher-quality workflow";

  if (isCover) {
    headline = topic && topic.length > 4
      ? truncate(topic, 110)
      : lang === "az"
      ? "Bu proses daha ağıllı ola bilər"
      : "This process can be smarter";

    subline =
      lang === "az"
        ? "Praktik istifadə sahələri, sistemli axınlar və real avtomatlaşdırma imkanları"
        : "Practical use cases, structured flows, and real automation opportunities";
  } else if (isLast) {
    headline =
      lang === "az"
        ? "Sistemi biznesinizə uyğun quraq"
        : "Let’s shape the right system for your business";

    subline = truncate(
      cta ||
        (lang === "az"
          ? `Daha uyğun həll üçün ${tenant.companyName} ilə əlaqə saxlayın`
          : `Contact ${tenant.companyName} to explore the right solution`),
      180
    );
  } else {
    headline =
      lang === "az"
        ? `İstifadə sahəsi ${idx - 1}`
        : `Use case ${idx - 1}`;

    subline =
      lang === "az"
        ? "Manual işi azaldan və prosesi sürətləndirən ağıllı avtomatlaşdırma axını"
        : "A smart automation flow that reduces manual work and speeds up the process";
  }

  return normalizeFrame(
    {
      index: idx,
      frameType: format === "reel" ? "scene" : isCover ? "cover" : "slide",
      layout:
        idx === 1
          ? "clean premium composition with dominant subject on right side, calm refined left side, reduced left blur, elegant studio depth"
          : isLast
          ? "clean composition with strong focal device and clear premium balance, open left side without heavy fog"
          : "clean technology or branded scene with one dominant object, right-biased focal subject, controlled atmosphere, minimal left-side haze",
      headline,
      subline,
      visualElements: uniqStrings([...presetPack.elements, ...topicEls]).slice(0, 6),
      motion:
        format === "reel"
          ? idx === 1
            ? "slow cinematic push-in"
            : idx === total
            ? "controlled resolving camera drift"
            : "subtle orbital or parallax movement"
          : "",
      durationSec: format === "reel" ? (idx === 1 ? 4 : idx === total ? 3 : 3) : 0,
    },
    idx,
    format
  );
}

export function ensureFrames(
  frames,
  format,
  cta = "",
  topic = "",
  preset = "",
  topicFamily = "",
  vars = {}
) {
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
          vars,
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
            vars,
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
            vars,
          })
        );
      }
      out = base;
    }

    if (out.length > 4) out = out.slice(0, 4);

    return out.map((x, i) => ({
      ...x,
      index: i + 1,
      frameType: "scene",
      durationSec:
        Number.isFinite(Number(x.durationSec)) && Number(x.durationSec) > 0
          ? Math.max(2, Math.min(5, Number(x.durationSec)))
          : i === 0
          ? 4
          : i === out.length - 1
          ? 3
          : 3,
    }));
  }

  return out;
}

export function pickLayoutFamily({ format, idx, totalSlides, layoutText }) {
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

export function buildRenderHints(frame, format, idx, totalSlides) {
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

export function buildFallbackImagePrompt(payload) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
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
    `Create a premium text-free futuristic or brand-appropriate commercial scene for ${tenant.companyName}.`,
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
      : "Color palette: deep graphite, cyan highlights, cool blue glow, premium dark contrast, subtle metallic reflections.",
    visualPlan.composition
      ? `Composition: ${sanitizeVisualText(visualPlan.composition, 240)}.`
      : `Composition: ${presetBlock.composition}.`,
    first.layout ? `Frame arrangement mood: ${sanitizeVisualText(first.layout, 180)}.` : "",
    asArr(first.visualElements).length
      ? `Elements: ${asArr(first.visualElements).join(", ")}.`
      : `Elements: ${presetBlock.elements.join(", ")}.`,
    "Prefer one dominant focal subject, not many competing objects.",
    "Use premium materials, engineered or refined surfaces, controlled reflections, elegant atmosphere, and cinematic depth.",
    "Keep the left side cleaner and calmer, but do not bury it under fog, blur mass, or muddy black overlays.",
    "Avoid poster layout, website hero look, dashboard look, app UI, floating interface cards, software screens, or UX mockup aesthetics.",
    "If a device appears, its display must remain abstract and unreadable, using only ambient gradients or non-readable luminous surfaces.",
    "No readable text, no letters, no words, no numbers, no labels, no logos, no symbols, no fake branding, no interface details.",
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

export function buildSlideVisualPrompt({
  payload,
  frame,
  totalSlides,
  format,
  visualPreset,
}) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
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
      ? `Create a premium text-free branded scene for ${tenant.companyName} carousel slide ${f.index} of ${totalSlides}.`
      : format === "reel"
      ? `Create a premium text-free cinematic branded scene for ${tenant.companyName} reel scene ${f.index} of ${totalSlides}.`
      : `Create a premium text-free branded scene for ${tenant.companyName}.`,
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
    f.motion ? `Camera / motion direction: ${sanitizeVisualText(f.motion, 160)}.` : "",
    format === "reel"
      ? "This must feel like one scene from a coherent premium commercial video with believable continuity and cinematic motion."
      : "Scene only. Final readable text will be placed later by a separate render engine.",
    "Prefer one dominant focal subject and a minimal number of supporting elements.",
    "Use premium materials, refined depth separation, controlled glow, elegant studio or high-end atmosphere, and realistic cinematic lighting.",
    "Keep the left side calmer and more open without heavy blur wall, oversized fog, or muddy dark overlay.",
    "Avoid website sections, landing pages, dashboard scenes, app screens, social template layout, poster composition, UX shots, or interface details.",
    "If a screen or device appears, keep it abstract and unreadable with ambient light only.",
    "No readable text, no letters, no words, no numbers, no labels, no logos, no symbols, no fake branding, no UI.",
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

export function buildSlidesFromFrames(payload) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
  const format = normalizeFormat(p.format || "image");
  const frames = asArr(asObj(p.visualPlan).frames);
  const totalSlides = frames.length;
  const visualPreset = String(asObj(p.visualPlan).visualPreset || "abstract_tech_scene");
  const brandBadge = defaultBrandBadge(tenant.companyName);
  const defaultCta =
    tenant.outputLanguage === "az"
      ? "Daha çox məlumat üçün bizimlə əlaqə saxlayın"
      : "Contact us to learn more";

  return frames.map((frame, i) => {
    const idx = i + 1;
    const f = asObj(frame);
    const isLast = idx === totalSlides;

    const badge =
      format === "carousel"
        ? idx === 1
          ? brandBadge
          : isLast
          ? "CTA"
          : "CONTENT"
        : format === "reel"
        ? "REEL"
        : brandBadge;

    const cta = isLast
      ? truncate(p.cta || defaultCta, 80)
      : "";

    return {
      id: `slide_${idx}`,
      index: idx,
      frameType: String(
        f.frameType || (format === "reel" ? "scene" : idx === 1 ? "cover" : "slide")
      ),
      title: truncate(f.headline || p.topic || tenant.companyName || "Draft", 120),
      subtitle: truncate(f.subline || p.hook || "", 180),
      cta,
      badge,
      align: "left",
      theme: s(p.theme || tenant.visualTheme || "premium_modern"),
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
        frame,
        totalSlides,
        format,
        visualPreset,
      }),
    };
  });
}

export function normalizeNeededAssets(srcAssets, format) {
  const incoming = uniqStrings(asArr(srcAssets));
  if (incoming.length) return incoming.slice(0, 10);

  if (format === "reel") return ["video", "image", "thumbnail", "icons", "mockups"];
  return ["image", "icons", "mockups"];
}