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

function getTenantRuntime(vars = {}) {
  const tenant = asObj(vars?.tenant);
  const tenantId = s(vars?.tenantId || tenant?.tenantId || tenant?.tenantKey || "default") || "default";
  const companyName =
    s(tenant?.companyName || tenant?.brandName || tenant?.name) || tenantId;
  const outputLanguage = normalizeLang(
    tenant?.outputLanguage || tenant?.language || vars?.language || "az",
    "az"
  );
  const industryKey = s(tenant?.industryKey || "generic_business") || "generic_business";
  const requiredHashtags = asArr(
    tenant?.requiredHashtags ||
      tenant?.brand?.requiredHashtags ||
      []
  )
    .map((x) => {
      const t = String(x || "").trim();
      if (!t) return "";
      return t.startsWith("#") ? t : `#${t}`;
    })
    .filter(Boolean);

  const audiences = asArr(
    tenant?.audiences ||
      tenant?.brand?.audiences ||
      []
  ).filter(Boolean);

  return {
    tenantId,
    companyName,
    outputLanguage,
    industryKey,
    requiredHashtags,
    audiences,
  };
}

export function normalizeGoal(goal) {
  const g = String(goal || "").trim().toLowerCase();
  return ALLOWED_GOALS.includes(g) ? g : "awareness";
}

export function ensureHashtagTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return "";
  return t.startsWith("#") ? t : `#${t}`;
}

export function normalizeHashtags(arr = [], vars = {}) {
  const tenant = getTenantRuntime(vars);

  let tags = uniqStrings(asArr(arr).map(ensureHashtagTag)).slice(0, 18);

  if (!tags.some((x) => x.toLowerCase() === "#ai")) tags.push("#AI");
  if (!tags.some((x) => x.toLowerCase() === "#automation")) tags.push("#Automation");

  for (const tag of tenant.requiredHashtags) {
    if (!tags.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }

  if (!tenant.requiredHashtags.length) {
    const brandTag = `#${tenant.companyName.replace(/[^\p{L}\p{N}]+/gu, "")}`.trim();
    if (
      brandTag.length > 1 &&
      !tags.some((x) => x.toLowerCase() === brandTag.toLowerCase())
    ) {
      tags.push(brandTag);
    }
  }

  return uniqStrings(tags).slice(0, 18);
}

export function normalizeTopic(src, vars = {}) {
  const tenant = getTenantRuntime(vars);
  const fallbackTitle =
    tenant.companyName && tenant.companyName !== "default"
      ? `${tenant.companyName} content draft`
      : "Content draft";

  const candidate = truncate(
    fixMojibake(src.topic || src.title || fallbackTitle),
    180
  );
  return candidate || fallbackTitle;
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
  cta,
  vars = {},
}) {
  const tenant = getTenantRuntime(vars);
  const first = asObj(slides[0]);
  const second = asObj(slides[1]);
  const third = asObj(slides[2]);

  const lines = [
    `Create a premium cinematic AI-generated vertical brand video for ${tenant.companyName}.`,
    "Output format: 9:16 vertical short-form commercial video.",
    topic ? `Core topic: ${topic}.` : "",
    hook ? `Opening emotional direction: ${hook}.` : "",
    caption ? `Narrative direction: ${caption}.` : "",
    cta ? `Ending intent: ${cta}.` : "",
    `Visual preset: ${visualPreset}.`,
    tenant.industryKey ? `Industry context: ${tenant.industryKey}.` : "",
    visualPlan?.style ? `Overall visual style: ${visualPlan.style}.` : "",
    visualPlan?.composition ? `Composition direction: ${visualPlan.composition}.` : "",
    visualPlan?.colorNotes ? `Color direction: ${visualPlan.colorNotes}.` : "",
    first?.visualPrompt ? `Scene 1: ${first.visualPrompt}` : "",
    second?.visualPrompt ? `Scene 2: ${second.visualPrompt}` : "",
    third?.visualPrompt ? `Scene 3: ${third.visualPrompt}` : "",
    "The result must feel like a premium commercial micro-film, not a slideshow and not a template.",
    "Use coherent scene-to-scene continuity, elegant motion, controlled lighting, cinematic camera movement, believable depth, premium material rendering, and commercially usable visual storytelling.",
    "No readable text inside the video.",
    "No subtitles, no title cards, no fake UI, no dashboards, no app screens, no browser windows, no website sections, no posters, no infographic layouts.",
    "Avoid social media graphic look. Avoid flat marketing poster look. Avoid fake interface elements.",
    "Focus on one strong story arc with premium, brand-appropriate business visuals.",
  ];

  return truncate(lines.filter(Boolean).join(" "), 2600);
}

function buildFallbackVoiceoverText({ hook, caption, cta, topic, vars = {} }) {
  const tenant = getTenantRuntime(vars);
  const lang = tenant.outputLanguage;
  const parts = [];

  if (hook) parts.push(hook);
  if (caption) parts.push(caption);

  if (!caption && topic) {
    if (lang === "az") {
      parts.push(`${topic} üçün ${tenant.companyName} ilə daha ağıllı və daha sistemli həll qurmaq mümkündür.`);
    } else {
      parts.push(`${tenant.companyName} helps build a smarter and more structured solution around ${topic}.`);
    }
  }

  if (cta) parts.push(cta);

  const fallback =
    lang === "az"
      ? `${tenant.companyName} ilə biznesiniz üçün daha ağıllı, daha sürətli və daha sistemli həllər qurun.`
      : `Build smarter, faster, and more structured business systems with ${tenant.companyName}.`;

  return truncate(
    parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || fallback,
    900
  );
}

function pickDefaultReelDuration(frames = []) {
  const total = asArr(frames).reduce((sum, f) => {
    const d = Number(f?.durationSec || 0);
    return sum + (Number.isFinite(d) && d > 0 ? d : 0);
  }, 0);

  if (total >= 6 && total <= 20) return total;
  return 10;
}

function buildReelMeta(payload) {
  const frames = asArr(payload?.visualPlan?.frames);
  const durationSec = pickDefaultReelDuration(frames);

  return {
    sceneCount: frames.length || 3,
    durationSec,
    motionIntensity: "medium",
    cameraStyle: "cinematic_commercial",
    deliveryStyle: "premium_business_tech",
    videoModelHint: "runway",
  };
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
  const tenant = getTenantRuntime(vars);
  const format = normalizeFormat(src.format || vars.format || "image");
  const language = String(src.language || tenant.outputLanguage || "az").trim().toLowerCase() || "az";
  const tenantKey =
    String(src.tenantKey || vars.tenantId || tenant.tenantId || "default").trim() || "default";

  const topic = normalizeTopic(src, vars);
  const hook = truncate(fixMojibake(src.hook || ""), 220);
  const caption = truncate(fixMojibake(src.caption || ""), 1200);
  const cta = truncate(
    fixMojibake(
      src.cta ||
        (language === "az"
          ? "Daha çox məlumat üçün bizimlə əlaqə saxlayın"
          : "Contact us to learn more")
    ),
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

  const defaultAudience =
    tenant.audiences.length
      ? tenant.audiences.join(", ")
      : "business owners, decision makers, operators, customers";

  const payload = {
    type: "content_draft",
    tenantKey,
    language,
    format,
    topic,
    goal: normalizeGoal(src.goal),
    targetAudience: truncate(
      fixMojibake(src.targetAudience || defaultAudience),
      220
    ),
    hook,
    caption,
    cta,
    hashtags: normalizeHashtags(src.hashtags, vars),
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
            vars,
          }),
        2400
      ),
      videoPrompt:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.videoPrompt || "").trim(), 2600)
          : "",
      voiceoverText:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.voiceoverText || "").trim(), 900)
          : "",
      brollIdeas: uniqStrings(assetBriefSrc.brollIdeas).slice(0, 10),
    },
    complianceNotes: uniqStrings(asArr(src.complianceNotes)).slice(0, 10),
    reviewQuestionsForCEO: uniqStrings(asArr(src.reviewQuestionsForCEO)).slice(0, 8),

    imagePrompt: "",
    videoPrompt: "",
    voiceoverText: "",
    aspectRatio: normalizeAspectRatio(src.aspectRatio || visualPlan.aspectRatio, format),
    neededAssets: [],
    reelMeta: null,
  };

  if (!payload.reviewQuestionsForCEO.length) {
    payload.reviewQuestionsForCEO =
      language === "az"
        ? [
            "Bu mövzu bu tenant üçün kifayət qədər aktual və dəyərlidirmi?",
            "Seçilmiş vizual preset brendin premium vizual dilinə uyğundurmu?",
            "CTA daha direkt olmalıdır, yoxsa daha yumşaq satış yanaşması saxlanmalıdır?",
          ]
        : [
            "Is this topic relevant and valuable enough for this tenant right now?",
            "Does the selected visual preset fit the brand’s premium visual language?",
            "Should the CTA be more direct, or should the softer sales approach remain?",
          ];
  }

  if (!payload.complianceNotes.length) {
    payload.complianceNotes =
      language === "az"
        ? [
            "Brend tonu premium, peşəkar və inandırıcı qalmalıdır.",
            "Şişirdilmiş və sübutsuz nəticə vədlərindən qaçılmalıdır.",
            "Final render zamanı oxunaqlılıq və təmiz hierarchy qorunmalıdır.",
          ]
        : [
            "The brand tone should remain premium, professional, and credible.",
            "Avoid exaggerated or unsupported outcome promises.",
            "Preserve readability and clean hierarchy during final rendering.",
          ];
  }

  payload.slides = buildSlidesFromFrames(payload);

  if (!payload.slides.length) {
    payload.slides = [
      {
        id: "slide_1",
        index: 1,
        frameType: format === "reel" ? "scene" : "cover",
        title: payload.topic || tenant.companyName || "Draft",
        subtitle: payload.hook || "",
        cta: payload.cta || "",
        badge: format === "reel" ? "REEL" : (tenant.companyName || "BRAND").toUpperCase(),
        align: "left",
        theme: "premium_dark",
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
          "Clean premium branded scene with one dominant subject, calmer left side, refined depth, reduced blur mass",
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
        cta: payload.cta,
        vars,
      });
    }

    if (!payload.assetBrief.voiceoverText) {
      payload.assetBrief.voiceoverText = buildFallbackVoiceoverText({
        hook: payload.hook,
        caption: payload.caption,
        cta: payload.cta,
        topic: payload.topic,
        vars,
      });
    }

    if (!payload.assetBrief.neededAssets.includes("video")) {
      payload.assetBrief.neededAssets = uniqStrings([
        "video",
        ...payload.assetBrief.neededAssets,
      ]).slice(0, 10);
    }
  }

  payload.imagePrompt = payload.assetBrief.imagePrompt || "";
  payload.videoPrompt = payload.assetBrief.videoPrompt || "";
  payload.voiceoverText = payload.assetBrief.voiceoverText || "";
  payload.neededAssets = uniqStrings(payload.assetBrief.neededAssets || []).slice(0, 10);
  payload.aspectRatio = normalizeAspectRatio(payload.aspectRatio, payload.format);

  if (payload.format === "reel") {
    payload.reelMeta = buildReelMeta(payload);
    if (!payload.aspectRatio) payload.aspectRatio = "9:16";
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