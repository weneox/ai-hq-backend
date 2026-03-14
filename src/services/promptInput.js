// src/services/promptInput.js
// FINAL v2.0 — normalize runtime prompt inputs for all AI HQ prompt usecases
//
// ✅ stable event/usecase-based prompt input normalization
// ✅ draft / revise / publish / comment / trend / analyze / fix_plan support
// ✅ safe defaults
// ✅ language / format normalization
// ✅ keeps prompt payload predictable for LLM calls
// ✅ publish flow also accepts contentPack as approved draft source
// ✅ profile/brand/root-aware tenant language fallback
// ✅ safer structured normalization

import { deepFix, fixText } from "../utils/textFix.js";
import { normalizeIndustryKey } from "../prompts/industries/index.js";

function s(v) {
  return String(v ?? "").trim();
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function uniqStrings(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const val = s(item);
    if (!val) continue;
    const key = val.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(val);
  }
  return out;
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

function normalizeGoal(v, fallback = "") {
  const x = s(v).toLowerCase();
  if (["lead", "awareness", "trust", "offer"].includes(x)) return x;
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
  return uniqStrings(
    arr(input)
      .map((x) => s(x))
      .filter(Boolean)
  );
}

function normalizeHashtags(input) {
  return uniqStrings(
    arr(input)
      .map((x) => s(x))
      .filter(Boolean)
      .map((x) => (x.startsWith("#") ? x : `#${x}`))
  );
}

function normalizeNeededAssets(input) {
  return uniqStrings(
    arr(input)
      .map((x) => s(x).toLowerCase())
      .filter(Boolean)
  );
}

function getTenantDefaults(tenant = null) {
  const t = obj(tenant);
  const profile = obj(t.profile);
  const brand = obj(t.brand);

  const defaultLanguage = normalizeLang(
    brand.defaultLanguage ||
      brand.outputLanguage ||
      profile.defaultLanguage ||
      profile.outputLanguage ||
      t.defaultLanguage ||
      t.outputLanguage ||
      t.language ||
      "az"
  );

  return {
    tenantKey: s(t.tenantKey || t.tenantId || t.id || "default") || "default",
    companyName:
      s(
        brand.displayName ||
          brand.name ||
          profile.displayName ||
          profile.companyName ||
          t.companyName ||
          t.brandName ||
          t.name
      ) || "This company",
    industryKey: normalizeIndustryKey(
      t.industryKey ||
        profile.industryKey ||
        brand.industryKey ||
        "generic_business"
    ),
    defaultLanguage,
  };
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
    tenantKey: s(d.tenantKey || d.tenantId || ""),
    language,
    format,
    topic: s(d.topic),
    goal: normalizeGoal(d.goal),
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
    neededAssets: normalizeNeededAssets(d.neededAssets),
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
      s(x.platform || x.channel).toLowerCase() ||
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
    competitors: uniqStrings(arr(x.competitors).map((v) => s(v)).filter(Boolean)),
    sourceNotes: s(x.sourceNotes),
    timeWindow: s(x.timeWindow),
    goals: uniqStrings(arr(x.goals).map((v) => s(v)).filter(Boolean)),
    raw: x,
    rawJson: safeJsonString(x),
  });
}

function normalizeAnalyzeContext(raw = {}, fallbackLang = "az") {
  const x = obj(raw);

  return deepFix({
    language: normalizeLang(x.language || x.lang, fallbackLang),
    approvedDraft: normalizeDraftLike(
      x.approvedDraft || x.draft || x.content || x.contentPack,
      "image",
      fallbackLang
    ),
    notes: s(x.notes),
    raw: x,
    rawJson: safeJsonString(x),
  });
}

function normalizeFixPlanContext(raw = {}, fallbackLang = "az") {
  const x = obj(raw);

  return deepFix({
    language: normalizeLang(x.language || x.lang, fallbackLang),
    analyzedDraft: normalizeDraftLike(
      x.analyzedDraft || x.draft || x.content || x.contentPack,
      "image",
      fallbackLang
    ),
    analysis: obj(x.analysis),
    qa: obj(x.qa),
    notes: s(x.notes),
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
  const tenantDefaults = getTenantDefaults(tenantObj);

  const defaultLanguage = tenantDefaults.defaultLanguage;

  const normalizedFormat = normalizeFormat(
    format || x.format || x.postType,
    e === "content.publish" || e === "content.approved" ? "image" : "image"
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

  if (e === "proposal.approved" || e === "content.draft" || e === "draft") {
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
        goalHint: normalizeGoal(x.goalHint || x.goal),
        campaignNote: s(x.campaignNote),
        approvedProposal: obj(x.approvedProposal || x.proposal),
        approvedProposalJson: safeJsonString(x.approvedProposal || x.proposal),
      },
    });
  }

  if (e === "content.revise" || e === "revise") {
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

  if (e === "content.publish" || e === "content.approved" || e === "publish") {
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

  if (e === "meta.comment_reply" || e === "comment") {
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

  if (e === "trend.research" || e === "trend") {
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

  if (e === "content.analyze" || e === "analyze") {
    const analyze = normalizeAnalyzeContext(x, defaultLanguage);

    return deepFix({
      ...base,
      language: analyze.language || base.language,
      extra: {
        ...x,
        ...analyze,
      },
    });
  }

  if (e === "content.fix_plan" || e === "fix_plan") {
    const fixPlan = normalizeFixPlanContext(x, defaultLanguage);

    return deepFix({
      ...base,
      language: fixPlan.language || base.language,
      extra: {
        ...x,
        ...fixPlan,
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