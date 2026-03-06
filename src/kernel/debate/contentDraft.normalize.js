// src/kernel/debate/contentDraft.normalize.js

import { asArr, asObj, fixMojibake, truncate, uniqStrings } from "./utils.js";
import {
  buildFallbackImagePrompt,
  buildSlidesFromFrames,
  detectTopicFamily,
  normalizeAspectRatio,
  normalizeFormat,
  normalizeNeededAssets,
  normalizeFrame,
  pickVisualPresetFromTopicFamily,
  presetStyleBlock,
  ensureFrames,
} from "./contentDraft.visuals.js";

const ALLOWED_GOALS = ["lead", "awareness", "trust", "offer"];

export function normalizeGoal(goal) {
  const g = String(goal || "").trim().toLowerCase();
  return ALLOWED_GOALS.includes(g) ? g : "awareness";
}

export function ensureHashtagTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return "";
  return t.startsWith("#") ? t : `#${t}`;
}

export function normalizeHashtags(arr = []) {
  const tags = uniqStrings(asArr(arr).map(ensureHashtagTag)).slice(0, 18);
  if (!tags.some((x) => x.toLowerCase() === "#ai")) tags.push("#AI");
  if (!tags.some((x) => x.toLowerCase() === "#automation")) tags.push("#Automation");
  if (!tags.some((x) => x.toLowerCase() === "#neox")) tags.push("#Neox");
  return uniqStrings(tags).slice(0, 18);
}

export function normalizeTopic(src) {
  const candidate = truncate(
    fixMojibake(src.topic || src.title || "NEOX content draft"),
    180
  );
  return candidate || "NEOX content draft";
}

export function normalizeVisualPlan({
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
    style: truncate(fixMojibake(visualPlanSrc.style || presetPack.style), 220),
    aspectRatio: normalizeAspectRatio(visualPlanSrc.aspectRatio, format),
    composition: truncate(
      fixMojibake(visualPlanSrc.composition || presetPack.composition),
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

function buildFallbackVideoPrompt({
  topic,
  hook,
  visualPreset,
  visualPlan,
  slides,
  caption,
}) {
  const first = asObj(slides[0]);
  const second = asObj(slides[1]);
  const third = asObj(slides[2]);

  const lines = [
    "Create a premium cinematic AI-generated vertical commercial video for NEOX, an AI automation and digital technology brand.",
    "Format: short-form vertical 9:16 video.",
    topic ? `Topic: ${topic}.` : "",
    hook ? `Opening hook mood: ${hook}.` : "",
    `Visual preset: ${visualPreset}.`,
    visualPlan?.style ? `Style: ${visualPlan.style}.` : "",
    visualPlan?.composition ? `Composition: ${visualPlan.composition}.` : "",
    first?.visualPrompt ? `Opening scene: ${first.visualPrompt}` : "",
    second?.visualPrompt ? `Middle scene: ${second.visualPrompt}` : "",
    third?.visualPrompt ? `Closing scene: ${third.visualPrompt}` : "",
    caption ? `Overall message direction: ${caption}.` : "",
    "The video must feel like a premium business-tech micro film.",
    "Use realistic camera motion, refined lighting, elegant futuristic atmosphere, believable motion, and clean cinematic composition.",
    "Do not generate readable text, subtitles, title cards, logos, UI screens, dashboards, browser windows, or poster-like layouts.",
    "Avoid slideshow feeling. Avoid template feeling. Avoid social media graphic aesthetics.",
    "Focus on a coherent commercial story with premium technology visuals and believable scene motion.",
  ];

  return truncate(lines.filter(Boolean).join(" "), 2400);
}

function buildFallbackVoiceoverText({ hook, caption, cta, topic }) {
  const parts = [];
  if (hook) parts.push(hook);
  if (caption) parts.push(caption);
  if (!caption && topic) {
    parts.push(`${topic} üçün NEOX ilə daha ağıllı və daha sürətli həll qurmaq mümkündür.`);
  }
  if (cta) parts.push(cta);
  return truncate(
    parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() ||
      "NEOX ilə biznesiniz üçün daha ağıllı, daha sürətli və daha sistemli AI avtomatlaşdırma həlləri qurun.",
    900
  );
}

function normalizeReelFramesAndSlides(payload) {
  if (payload.format !== "reel") return payload;

  let frames = asArr(asObj(payload.visualPlan).frames)
    .map((f, i) => normalizeFrame({ ...asObj(f), frameType: "scene" }, i + 1, "reel"))
    .slice(0, 4);

  if (frames.length < 3) {
    frames = ensureFrames(
      frames,
      "reel",
      payload.cta,
      payload.topic,
      payload.visualPlan.visualPreset,
      detectTopicFamily(payload.topic, payload.hook, payload.caption)
    ).slice(0, 3);
  }

  frames = frames.map((f, i) => ({
    ...f,
    index: i + 1,
    frameType: "scene",
    durationSec:
      Number.isFinite(Number(f.durationSec)) && Number(f.durationSec) > 0
        ? Math.max(2, Math.min(5, Number(f.durationSec)))
        : i === 0
        ? 4
        : i === frames.length - 1
        ? 3
        : 3,
  }));

  payload.visualPlan.aspectRatio = "9:16";
  payload.visualPlan.textOnVisual = [];
  payload.visualPlan.frames = frames;

  payload.slides = buildSlidesFromFrames(payload).slice(0, 4).map((slide, i) => ({
    ...slide,
    index: i + 1,
    frameType: "scene",
    slideNumber: i + 1,
    totalSlides: frames.length,
    badge: "REEL",
    cta: i === frames.length - 1 ? truncate(payload.cta || "", 80) : "",
  }));

  return payload;
}

export function normalizeContentDraftPayload(rawPayload, vars = {}) {
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
    assetBrief: {
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
      videoPrompt:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.videoPrompt || "").trim(), 2400)
          : "",
      voiceoverText:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.voiceoverText || "").trim(), 900)
          : "",
      brollIdeas: uniqStrings(assetBriefSrc.brollIdeas).slice(0, 10),
    },
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
        frameType: format === "reel" ? "scene" : "cover",
        title: payload.topic || "NEOX",
        subtitle: payload.hook || "",
        cta: payload.cta || "",
        badge: format === "reel" ? "REEL" : "NEOX",
        align: "left",
        theme: "neox_dark",
        slideNumber: 1,
        totalSlides: 1,
        renderHints: {
          layoutFamily: format === "reel" ? "cinematic_center" : "editorial_left",
          textPosition: format === "reel" ? "center" : "left",
          safeArea: format === "reel" ? "centered" : "left-heavy",
          overlayStrength: "medium",
          focalBias: format === "reel" ? "center" : "right",
        },
        visualDirection:
          "Clean premium technology scene with one dominant subject, calmer left side, refined studio depth, reduced blur mass",
        visualPrompt: payload.assetBrief.imagePrompt,
      },
    ];
  }

  if (payload.format === "reel") {
    normalizeReelFramesAndSlides(payload);

    if (!payload.assetBrief.videoPrompt) {
      payload.assetBrief.videoPrompt = buildFallbackVideoPrompt({
        topic: payload.topic,
        hook: payload.hook,
        visualPreset: payload.visualPlan.visualPreset,
        visualPlan: payload.visualPlan,
        slides: payload.slides,
        caption: payload.caption,
      });
    }

    if (!payload.assetBrief.voiceoverText) {
      payload.assetBrief.voiceoverText = buildFallbackVoiceoverText({
        hook: payload.hook,
        caption: payload.caption,
        cta: payload.cta,
        topic: payload.topic,
      });
    }

    if (!payload.assetBrief.neededAssets.includes("video")) {
      payload.assetBrief.neededAssets = uniqStrings([
        "video",
        ...payload.assetBrief.neededAssets,
      ]).slice(0, 10);
    }
  }

  return payload;
}

export function normalizeDraftProposalObject(obj, vars = {}) {
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