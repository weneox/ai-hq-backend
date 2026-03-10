// src/services/promptInput.js
// FINAL v1.1 — normalize runtime prompt inputs for all AI HQ prompt usecases
//
// ✅ stable event-based prompt input normalization
// ✅ draft / revise / publish / comment / trend support
// ✅ safe defaults
// ✅ language / format normalization
// ✅ keeps prompt payload predictable for LLM calls
// ✅ publish flow now also accepts contentPack as approved draft source

import { deepFix, fixText } from "../utils/textFix.js";

function s(v) {
  return String(v ?? "").trim();
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
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

function normalizeFormat(v, fallback = "image") {
  const x = s(v).toLowerCase();
  if (x === "image") return "image";
  if (x === "carousel") return "carousel";
  if (x === "reel") return "reel";
  return fallback;
}

function safeJsonString(value) {
  try {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function normalizeAssetUrls(input) {
  return arr(input)
    .map((x) => s(x))
    .filter(Boolean);
}

function normalizeHashtags(input) {
  return arr(input)
    .map((x) => s(x))
    .filter(Boolean)
    .map((x) => (x.startsWith("#") ? x : `#${x}`));
}

function normalizeDraftLike(raw = {}, fallbackFormat = "image", fallbackLang = "az") {
  const d = obj(raw);

  const language = normalizeLang(
    d.language || d.lang || d.outputLanguage,
    fallbackLang
  );

  const format = normalizeFormat(
    d.format || d.postType || d.type,
    fallbackFormat
  );

  return deepFix({
    type: s(d.type || "content_draft"),
    language,
    format,
    topic: s(d.topic),
    goal: s(d.goal),
    targetAudience: s(d.targetAudience),
    hook: s(d.hook),
    caption: s(d.caption),
    cta: s(d.cta),
    hashtags: normalizeHashtags(d.hashtags),
    slides: arr(d.slides),
    visualPlan: obj(d.visualPlan),
    assetBrief: obj(d.assetBrief),
    imagePrompt: s(d.imagePrompt),
    videoPrompt: s(d.videoPrompt),
    voiceoverText: s(d.voiceoverText),
    aspectRatio: s(d.aspectRatio),
    neededAssets: arr(d.neededAssets),
    reelMeta: obj(d.reelMeta),
    complianceNotes: arr(d.complianceNotes),
    reviewQuestionsForCEO: arr(d.reviewQuestionsForCEO),
    assetUrls: normalizeAssetUrls(
      d.assetUrls ||
        d.assets ||
        d.mediaUrls ||
        d.generatedAssetUrls
    ),
    raw: d,
    rawJson: safeJsonString(d),
  });
}

function normalizeCommentContext(raw = {}) {
  const x = obj(raw);

  return deepFix({
    commentText:
      s(x.commentText) ||
      s(x.comment) ||
      s(x.text) ||
      "",
    authorName:
      s(x.authorName) ||
      s(x.username) ||
      s(x.author) ||
      "",
    platform:
      s(x.platform).toLowerCase() ||
      "instagram",
    postTopic:
      s(x.postTopic) ||
      s(x.topic) ||
      "",
    requestedLanguage: normalizeLang(
      x.language || x.lang,
      ""
    ),
    raw: x,
    rawJson: safeJsonString(x),
  });
}

function normalizeTrendContext(raw = {}, fallbackLang = "az") {
  const x = obj(raw);

  return deepFix({
    language: normalizeLang(
      x.language || x.lang,
      fallbackLang
    ),
    market: s(x.market),
    region: s(x.region),
    audienceFocus: s(x.audienceFocus),
    categoryFocus: s(x.categoryFocus),
    competitors: arr(x.competitors).map((v) => s(v)).filter(Boolean),
    sourceNotes: s(x.sourceNotes),
    timeWindow: s(x.timeWindow),
    goals: arr(x.goals).map((v) => s(v)).filter(Boolean),
    raw: x,
    rawJson: safeJsonString(x),
  });
}

export function normalizePromptInput(
  event,
  {
    tenant = null,
    today = "",
    format = "",
    extra = {},
  } = {}
) {
  const e = s(event).toLowerCase();
  const x = obj(extra);

  const tenantObj = obj(tenant);
  const defaultLanguage = normalizeLang(
    tenantObj?.brand?.defaultLanguage ||
      tenantObj?.brand?.outputLanguage ||
      tenantObj?.defaultLanguage ||
      tenantObj?.language ||
      "az"
  );

  const normalizedFormat = normalizeFormat(
    format || x.format || x.postType,
    "image"
  );

  const base = {
    event: e,
    today: s(today),
    format: normalizedFormat,
    language: normalizeLang(
      x.language || x.lang,
      defaultLanguage
    ),
    tenant: tenantObj,
  };

  if (e === "proposal.approved") {
    return deepFix({
      ...base,
      extra: {
        ...x,
        language: normalizeLang(
          x.language || x.lang,
          defaultLanguage
        ),
        format: normalizedFormat,
        topicHint: s(x.topicHint || x.topic),
        goalHint: s(x.goalHint || x.goal),
        campaignNote: s(x.campaignNote),
        approvedProposal: obj(x.approvedProposal || x.proposal),
        approvedProposalJson: safeJsonString(x.approvedProposal || x.proposal),
      },
    });
  }

  if (e === "content.revise") {
    const previousDraft = normalizeDraftLike(
      x.previousDraft || x.draft,
      normalizedFormat,
      defaultLanguage
    );

    return deepFix({
      ...base,
      format: previousDraft.format || normalizedFormat,
      language: previousDraft.language || base.language,
      extra: {
        ...x,
        format: previousDraft.format || normalizedFormat,
        language: previousDraft.language || base.language,
        previousDraft,
        previousDraftJson: previousDraft.rawJson,
        feedback: fixText(s(x.feedback)),
      },
    });
  }

  if (e === "content.publish" || e === "content.approved") {
    const approvedDraft = normalizeDraftLike(
      x.approvedDraft || x.draft || x.content || x.contentPack,
      normalizedFormat,
      defaultLanguage
    );

    return deepFix({
      ...base,
      format: approvedDraft.format || normalizedFormat,
      language: approvedDraft.language || base.language,
      extra: {
        ...x,
        format: approvedDraft.format || normalizedFormat,
        language: approvedDraft.language || base.language,
        approvedDraft,
        approvedDraftJson: approvedDraft.rawJson,
        assetUrls: normalizeAssetUrls(
          x.assetUrls ||
            approvedDraft.assetUrls ||
            x.generatedAssetUrls
        ),
        platform: s(x.platform || "instagram").toLowerCase() || "instagram",
      },
    });
  }

  if (e === "meta.comment_reply") {
    const comment = normalizeCommentContext(x);

    return deepFix({
      ...base,
      language: comment.requestedLanguage || base.language,
      extra: {
        ...x,
        ...comment,
      },
    });
  }

  if (e === "trend.research") {
    const trend = normalizeTrendContext(x, defaultLanguage);

    return deepFix({
      ...base,
      language: trend.language || base.language,
      extra: {
        ...x,
        ...trend,
      },
    });
  }

  return deepFix({
    ...base,
    extra: {
      ...x,
      language: base.language,
      format: base.format,
    },
  });
}