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
  ensureFrames,
} from "./contentDraft.visuals.js";
import { normalizeIndustryKey } from "../../prompts/industries/index.js";

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

function ensureHashtagTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return "";
  return t.startsWith("#") ? t : `#${t}`;
}

function joinText(arr = [], fallback = "") {
  const out = asArr(arr)
    .map((x) => {
      if (typeof x === "string") return s(x);
      if (x && typeof x === "object") {
        return s(x.name || x.title || x.label || x.value || "");
      }
      return "";
    })
    .filter(Boolean);

  return out.length ? out.join(", ") : fallback;
}

function buildBrandHashtag(companyName = "") {
  const raw = String(companyName || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\p{L}\p{N}]+/gu, "");
  if (!cleaned) return "";
  return `#${cleaned}`;
}

function getTenantRuntime(vars = {}) {
  const src = asObj(vars);
  const tenant = asObj(src.tenant);
  const tenantProfile = asObj(tenant.profile);
  const tenantBrand = asObj(tenant.brand);
  const tenantAiPolicy = asObj(tenant.ai_policy || tenant.aiPolicy);

  const tenantId =
    s(src.tenantId || tenant.tenantId || tenant.tenantKey || tenant.id || "default") ||
    "default";

  const companyName =
    s(
      tenantBrand.displayName ||
        tenantBrand.name ||
        tenantProfile.displayName ||
        tenantProfile.companyName ||
        tenant.companyName ||
        tenant.brandName ||
        tenant.name
    ) || tenantId;

  const outputLanguage = normalizeLang(
    tenant.outputLanguage ||
      tenant.language ||
      tenant.defaultLanguage ||
      tenantProfile.outputLanguage ||
      tenantProfile.language ||
      tenantProfile.defaultLanguage ||
      src.language ||
      "az",
    "az"
  );

  const industryKey = normalizeIndustryKey(
    tenant.industryKey ||
      tenantProfile.industryKey ||
      tenant.industry ||
      tenantProfile.industry ||
      src.industryKey ||
      "generic_business"
  );

  const requiredHashtags = uniqStrings(
    asArr(
      tenant.requiredHashtags ||
        tenantBrand.requiredHashtags ||
        tenantProfile.requiredHashtags ||
        src.requiredHashtags ||
        []
    )
      .map(ensureHashtagTag)
      .filter(Boolean)
  ).slice(0, 18);

  const audiences = uniqStrings(
    asArr(
      tenant.audiences ||
        tenantBrand.audiences ||
        tenantProfile.audiences ||
        src.audiences ||
        []
    )
      .map((x) => (typeof x === "string" ? s(x) : s(x?.name || x?.title || x?.label)))
      .filter(Boolean)
  ).slice(0, 10);

  const servicesText =
    s(
      tenant.servicesText ||
        tenantProfile.servicesText ||
        tenantBrand.servicesText ||
        tenantAiPolicy.servicesText ||
        src.servicesText
    ) || joinText(tenant.services);

  const audiencesText =
    s(
      tenant.audiencesText ||
        tenantProfile.audiencesText ||
        tenantBrand.audiencesText ||
        src.audiencesText
    ) || joinText(audiences);

  const brandHashtag =
    ensureHashtagTag(
      tenant.brandHashtag ||
        tenantBrand.hashtag ||
        tenantProfile.brandHashtag ||
        buildBrandHashtag(companyName)
    ) || "";

  return {
    tenantId,
    companyName,
    outputLanguage,
    industryKey,
    requiredHashtags,
    audiences,
    servicesText,
    audiencesText,
    brandHashtag,
  };
}

function isTechnologyIndustry(industryKey = "") {
  return normalizeIndustryKey(industryKey) === "technology";
}

export function normalizeGoal(goal) {
  const g = String(goal || "").trim().toLowerCase();
  return ALLOWED_GOALS.includes(g) ? g : "awareness";
}

export function normalizeHashtags(arr = [], vars = {}) {
  const tenant = getTenantRuntime(vars);

  let tags = uniqStrings(asArr(arr).map(ensureHashtagTag).filter(Boolean)).slice(0, 18);

  if (isTechnologyIndustry(tenant.industryKey)) {
    if (!tags.some((x) => x.toLowerCase() === "#ai")) tags.push("#AI");
    if (!tags.some((x) => x.toLowerCase() === "#automation")) tags.push("#Automation");
  }

  for (const tag of tenant.requiredHashtags) {
    if (!tags.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag);
    }
  }

  if (tenant.brandHashtag) {
    if (!tags.some((x) => x.toLowerCase() === tenant.brandHashtag.toLowerCase())) {
      tags.push(tenant.brandHashtag);
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
  vars = {},
}) {
  const src = asObj(visualPlanSrc);

  const frames = ensureFrames(
    src.frames,
    format,
    cta,
    topic,
    visualPreset,
    topicFamily,
    vars
  );

  const defaultColorNotes = isTechnologyIndustry(getTenantRuntime(vars).industryKey)
    ? "Deep graphite, refined cyan-blue highlights, subtle metallic reflections, premium dark contrast, controlled luminous accents"
    : "Premium industry-appropriate tones, refined contrast, believable materials, calm commercial atmosphere";

  return {
    visualPreset,
    style: truncate(fixMojibake(src.style || ""), 220),
    aspectRatio: normalizeAspectRatio(src.aspectRatio, format),
    composition: truncate(fixMojibake(src.composition || ""), 280),
    colorNotes: truncate(
      fixMojibake(src.colorNotes || defaultColorNotes),
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
  const fourth = asObj(slides[3]);

  const lines = [
    `Create a premium cinematic AI-generated vertical brand video for ${tenant.companyName}.`,
    `Industry context: ${tenant.industryKey}.`,
    "Output format: 9:16 vertical short-form commercial video.",
    topic ? `Core topic: ${topic}.` : "",
    hook ? `Opening emotional direction: ${hook}.` : "",
    caption ? `Narrative direction: ${caption}.` : "",
    cta ? `Ending intent: ${cta}.` : "",
    `Visual preset: ${visualPreset}. Keep the visuals natural for the tenant’s actual industry.`,
    tenant.servicesText
      ? `Business context: ${tenant.servicesText}.`
      : "",
    visualPlan?.style ? `Overall visual style: ${visualPlan.style}.` : "",
    visualPlan?.composition ? `Composition direction: ${visualPlan.composition}.` : "",
    visualPlan?.colorNotes ? `Color direction: ${visualPlan.colorNotes}.` : "",
    first?.visualPrompt ? `Scene 1: ${first.visualPrompt}` : "",
    second?.visualPrompt ? `Scene 2: ${second.visualPrompt}` : "",
    third?.visualPrompt ? `Scene 3: ${third.visualPrompt}` : "",
    fourth?.visualPrompt ? `Scene 4: ${fourth.visualPrompt}` : "",
    "The result must feel like a premium commercial micro-film, not a slideshow and not a template.",
    "Use coherent scene-to-scene continuity, elegant motion, controlled lighting, cinematic camera movement, believable depth, premium material rendering, and commercially usable visual storytelling.",
    "No readable text inside the video.",
    "No subtitles, no title cards, no fake UI, no dashboards, no app screens, no browser windows, no website sections, no posters, no infographic layouts.",
    "Avoid social media graphic look. Avoid flat marketing poster look. Avoid fake interface elements.",
    "If the tenant is not a technology business, keep scenes industry-correct and do not force robotic or futuristic business-tech imagery.",
    "Focus on one strong story arc with premium, brand-appropriate, business-relevant visuals.",
  ];

  return truncate(lines.filter(Boolean).join(" "), 2800);
}

function buildFallbackVoiceoverText({ hook, caption, cta, topic, vars = {} }) {
  const tenant = getTenantRuntime(vars);
  const lang = tenant.outputLanguage;
  const parts = [];

  if (hook) parts.push(hook);
  if (caption) parts.push(caption);

  if (!caption && topic) {
    if (lang === "az") {
      parts.push(
        `${topic} mövzusunda ${tenant.companyName} ilə daha aydın, daha peşəkar və daha güclü yanaşma qurmaq mümkündür.`
      );
    } else {
      parts.push(
        `${tenant.companyName} helps build a clearer, more professional, and stronger approach around ${topic}.`
      );
    }
  }

  if (cta) parts.push(cta);

  const fallback =
    lang === "az"
      ? `${tenant.companyName} ilə daha aydın, daha güclü və daha sistemli biznes təcrübəsi qurun.`
      : `Build a clearer, stronger, and more structured business experience with ${tenant.companyName}.`;

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

function buildReelMeta(payload, vars = {}) {
  const tenant = getTenantRuntime(vars);
  const frames = asArr(payload?.visualPlan?.frames);
  const durationSec = pickDefaultReelDuration(frames);

  return {
    sceneCount: frames.length || 3,
    durationSec,
    motionIntensity: "medium",
    cameraStyle: isTechnologyIndustry(tenant.industryKey)
      ? "cinematic_commercial"
      : "cinematic_brand_story",
    deliveryStyle: isTechnologyIndustry(tenant.industryKey)
      ? "premium_business_tech"
      : "premium_industry_brand",
    videoModelHint: "runway",
  };
}

function normalizeReelFramesAndSlides(payload, vars = {}) {
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
      detectTopicFamily(payload.topic, payload.hook, payload.caption),
      vars
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

function buildDefaultAudience(vars = {}) {
  const tenant = getTenantRuntime(vars);

  if (tenant.audiences.length) return tenant.audiences.join(", ");
  if (tenant.audiencesText) return tenant.audiencesText;

  const byIndustry = {
    clinic: "patients, families, clinic management, front-desk coordinators",
    restaurant: "customers, families, diners, restaurant management",
    hospitality: "guests, families, travelers, hospitality management",
    beauty: "clients, beauty customers, repeat visitors, studio management",
    legal: "individual clients, business clients, law firm management",
    finance: "small business owners, clients, managers, finance decision-makers",
    education: "students, parents, learners, education management",
    retail: "shoppers, buyers, repeat customers, store management",
    ecommerce: "online shoppers, repeat buyers, ecommerce management",
    real_estate: "buyers, renters, investors, sales management",
    logistics: "clients, shippers, operations teams, management",
    creative_agency: "brand founders, marketing teams, premium brands, agency management",
    automotive: "drivers, service customers, buyers, automotive management",
    technology: "founders, managers, operators, decision-makers, teams",
    generic_business: "business owners, decision-makers, operators, customers",
  };

  return byIndustry[tenant.industryKey] || byIndustry.generic_business;
}

function buildDefaultComplianceNotes(language = "az", vars = {}) {
  const tenant = getTenantRuntime(vars);
  const isTech = isTechnologyIndustry(tenant.industryKey);

  if (language === "az") {
    const notes = [
      "Brend tonu premium, peşəkar və inandırıcı qalmalıdır.",
      "Şişirdilmiş və sübutsuz nəticə vədlərindən qaçılmalıdır.",
      "Final render zamanı oxunaqlılıq və təmiz hierarchy qorunmalıdır.",
    ];

    if (!isTech) {
      notes.push(
        "Vizual istiqamət tenantın real sənayesinə uyğun qalmalı, lazımsız robotik və ya futuristik elementlərdən qaçılmalıdır."
      );
    }

    return notes;
  }

  const notes = [
    "The brand tone should remain premium, professional, and credible.",
    "Avoid exaggerated or unsupported outcome promises.",
    "Preserve readability and clean hierarchy during final rendering.",
  ];

  if (!isTech) {
    notes.push(
      "The visual direction should remain natural to the tenant’s real industry and avoid unnecessary robotic or futuristic elements."
    );
  }

  return notes;
}

function buildDefaultReviewQuestions(language = "az", vars = {}) {
  const tenant = getTenantRuntime(vars);

  if (language === "az") {
    return [
      "Bu mövzu bu tenant üçün kifayət qədər aktual və dəyərlidirmi?",
      "Seçilmiş vizual dil və preset brendin real sənayesinə və premium görünüşünə uyğundurmu?",
      "CTA daha direkt olmalıdır, yoxsa daha yumşaq satış yanaşması saxlanmalıdır?",
    ];
  }

  return [
    "Is this topic relevant and valuable enough for this tenant right now?",
    "Does the selected visual language and preset fit the brand’s real industry and premium look?",
    "Should the CTA be more direct, or should the softer sales approach remain?",
  ];
}

export function normalizeContentDraftPayload(rawPayload, vars = {}) {
  const src = asObj(rawPayload);
  const tenant = getTenantRuntime(vars);

  const format = normalizeFormat(src.format || vars.format || "image");
  const language =
    String(src.language || tenant.outputLanguage || "az").trim().toLowerCase() || "az";
  const tenantKey =
    String(src.tenantKey || vars.tenantId || tenant.tenantId || "default").trim() ||
    "default";

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
    visualPlanSrc.visualPreset,
    tenant.industryKey
  );

  const visualPlan = normalizeVisualPlan({
    visualPlanSrc,
    format,
    topic,
    cta,
    topicFamily,
    visualPreset,
    vars,
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
      fixMojibake(src.targetAudience || buildDefaultAudience(vars)),
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
            tenant: vars.tenant,
            tenantId: tenant.tenantId,
          }),
        2800
      ),
      videoPrompt:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.videoPrompt || "").trim(), 2800)
          : "",
      voiceoverText:
        format === "reel"
          ? truncate(fixMojibake(assetBriefSrc.voiceoverText || "").trim(), 900)
          : "",
      brollIdeas: uniqStrings(asArr(assetBriefSrc.brollIdeas)).slice(0, 10),
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
    payload.reviewQuestionsForCEO = buildDefaultReviewQuestions(language, vars);
  }

  if (!payload.complianceNotes.length) {
    payload.complianceNotes = buildDefaultComplianceNotes(language, vars);
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
        badge:
          format === "reel" ? "REEL" : (tenant.companyName || "BRAND").toUpperCase(),
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
          "Clean premium industry-appropriate scene with one dominant subject, calmer left side, refined depth, reduced blur mass",
        visualPrompt: payload.assetBrief.imagePrompt,
      },
    ];
  }

  if (payload.format === "reel") {
    normalizeReelFramesAndSlides(payload, vars);

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
    payload.reelMeta = buildReelMeta(payload, vars);
    payload.aspectRatio = "9:16";
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