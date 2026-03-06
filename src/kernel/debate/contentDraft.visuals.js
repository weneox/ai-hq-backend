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
];

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
      /\b(poster|campaign|advertisement|advertising|commercial|editorial|branded|marketing|social cover|cover design|thumbnail design)\b/gi,
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
    /\b(chatbot|assistant|virtual assistant|voice assistant|customer support|support|receptionist|call handling|whatsapp|instagram dm|messenger|faq)\b/.test(
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
    /\b(logistics|routing|field operations|service routing|coordination|workflow|task routing|operations)\b/.test(
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
    motion: truncate(fixMojibake(f.motion || ""), 160),
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
}) {
  const presetPack = presetStyleBlock(preset);
  const topicEls = topicFamilyElements(topicFamily);

  const isCover = idx === 1;
  const isLast = idx === total;

  let headline = "NEOX ilə daha ağıllı sistem";
  let subline = "AI və avtomatlaşdırma ilə sürət, sistem və keyfiyyət qazanın";

  if (isCover) {
    headline = topic && topic.length > 4 ? truncate(topic, 110) : "AI biznesdə harada işləyir?";
    subline =
      "Praktik istifadə sahələri, sistemli axınlar və real avtomatlaşdırma imkanları";
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
      layout:
        idx === 1
          ? "clean premium composition with dominant subject on right side, calm refined left side, reduced left blur, elegant studio depth"
          : isLast
          ? "clean composition with strong focal device and clear premium balance, open left side without heavy fog"
          : "clean technology scene with one dominant object, right-biased focal subject, controlled atmosphere, minimal left-side haze",
      headline,
      subline,
      visualElements: uniqStrings([...presetPack.elements, ...topicEls]).slice(0, 6),
      motion: format === "reel" ? "subtle push-in camera movement" : "",
      durationSec: format === "reel" ? 2 : 0,
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
  topicFamily = ""
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
    first.layout ? `Frame arrangement mood: ${sanitizeVisualText(first.layout, 180)}.` : "",
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

export function buildSlideVisualPrompt({
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

export function buildSlidesFromFrames(payload) {
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
      ? truncate(p.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın", 80)
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
        [f.layout || "", asArr(f.visualElements).join(", "), f.motion ? `Motion mood: ${f.motion}` : ""]
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

  if (format === "reel") return ["video", "image", "icons", "mockups"];
  return ["image", "icons", "mockups"];
}