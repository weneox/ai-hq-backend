import { cfg } from "../config.js";
import { getDefaultTenantKey, resolveTenantKey } from "../tenancy/index.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
import { normalizePromptInput } from "./promptInput.js";
import { postToN8n } from "../utils/n8n.js";

function clean(x) {
  return String(x || "").trim();
}

function stripTrailingSlashes(u) {
  return clean(u).replace(/\/+$/, "");
}

function looksLikeFullWebhookUrl(u) {
  return /\/webhook\/[^/]+$/i.test(stripTrailingSlashes(u));
}

function isObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function normalizeFormat(x) {
  const s = clean(x).toLowerCase();
  if (!s) return "";
  if (s === "video") return "reel";
  if (s === "short") return "reel";
  return s;
}

function normalizeAspectRatio(x, fallbackFormat = "") {
  const s = clean(x);
  if (s) return s;

  const f = normalizeFormat(fallbackFormat);
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  if (f === "carousel") return "1:1";
  return "";
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAutomationMode(v, fallback = "manual") {
  const x = clean(v || fallback).toLowerCase();
  if (x === "full_auto") return "full_auto";
  return "manual";
}

function normalizeEventForTransport(event, extra = {}) {
  const raw = clean(event);

  switch (raw) {
    case "content.assets.generate":
    case "asset.generate":
    case "content.video.generate":
    case "video.generate":
    case "reel.generate":
    case "reel.render":
    case "video.render":
      return "proposal.approved";

    case "draft.ready.auto":
    case "content.publish":
    case "publish":
      return "content.publish";

    case "tenant.draft.schedule.trigger":
    case "scheduled.content":
    case "scheduled.draft":
      return "tenant.draft.schedule.trigger";

    default:
      return raw;
  }
}

function pickWorkflowHint(event, extra = {}) {
  const action = clean(extra.action || event);

  if (
    action === "content.video.generate" ||
    action === "video.generate" ||
    action === "reel.generate" ||
    action === "reel.render" ||
    action === "video.render"
  ) {
    return "runway_reel";
  }

  if (
    action === "content.assets.generate" ||
    action === "asset.generate"
  ) {
    return "asset_generate";
  }

  if (
    action === "content.publish" ||
    action === "publish"
  ) {
    return "publish";
  }

  if (action === "draft.ready.auto") {
    return "draft_auto";
  }

  if (
    action === "tenant.draft.schedule.trigger" ||
    action === "scheduled.content" ||
    action === "scheduled.draft"
  ) {
    return "scheduled_content";
  }

  if (clean(event) === "proposal.approved") {
    return "approved";
  }

  return "generic";
}

function pickWebhookUrl(event, extra = {}) {
  const override = clean(extra.webhookUrl);
  if (override) return stripTrailingSlashes(override);

  const perEvent = {
    "proposal.approved": clean(cfg.n8n.webhookProposalApprovedUrl),
    "content.publish": clean(cfg.n8n.webhookPublishUrl),
    "tenant.draft.schedule.trigger": clean(cfg.n8n.scheduleDraftUrl),
  };

  if (perEvent[event]) {
    return stripTrailingSlashes(perEvent[event]);
  }

  const full = clean(cfg.n8n.webhookUrl);
  if (full) {
    return stripTrailingSlashes(full);
  }

  const base = stripTrailingSlashes(cfg.n8n.webhookBase);
  if (!base) return "";

  if (looksLikeFullWebhookUrl(base)) {
    return base;
  }

  if (event === "proposal.approved") {
    return `${base}/aihq-approved`;
  }

  if (event === "content.publish") {
    return `${base}/aihq-publish`;
  }

  if (event === "tenant.draft.schedule.trigger") {
    return `${base}/aihq-scheduled-draft`;
  }

  return `${base}/aihq-approved`;
}

function pickProposalId(proposal, extra = {}) {
  return clean(extra.proposalId || proposal?.id || proposal?.proposal_id || "") || null;
}

function pickThreadId(proposal, extra = {}) {
  return clean(extra.threadId || proposal?.thread_id || proposal?.threadId || "") || null;
}

function pickTenantKey(extra = {}, proposal = null) {
  return resolveTenantKey(
    extra.tenantKey ||
      extra.tenant_key ||
      proposal?.tenant_key ||
      proposal?.tenantKey,
    getDefaultTenantKey()
  );
}

function pickTenantId(extra = {}, proposal = null) {
  return clean(
    extra.tenantId ||
      extra.tenant_id ||
      proposal?.tenant_id ||
      proposal?.tenantId ||
      ""
  ) || null;
}

function pickDecision(extra = {}, proposal = null) {
  return clean(extra.decision || proposal?.status || "") || null;
}

function pickBy(extra = {}, proposal = null) {
  return clean(extra.by || proposal?.decision_by || "unknown") || "unknown";
}

function pickDecidedAt(extra = {}, proposal = null) {
  return extra.decidedAt || proposal?.decided_at || null;
}

function pickTitle(extra = {}, proposal = null) {
  return proposal?.title || extra.title || null;
}

function pickLanguage(extra = {}, proposal = null) {
  return (
    clean(extra.language || extra.lang || proposal?.language || proposal?.lang) ||
    "az"
  );
}

function buildTenantRuntime(proposal, extra = {}) {
  const tenantKey = pickTenantKey(extra, proposal);
  const tenantId = pickTenantId(extra, proposal);

  const brand = isObject(extra.brand) ? extra.brand : {};
  const tenant = isObject(extra.tenant) ? extra.tenant : {};
  const proposalObj = isObject(proposal) ? proposal : {};
  const proposalMeta = isObject(proposalObj.meta) ? proposalObj.meta : {};

  return deepFix({
    tenantKey,
    tenantId,
    companyName:
      clean(
        tenant.companyName ||
          tenant.name ||
          brand.companyName ||
          brand.name ||
          proposalObj.companyName ||
          proposalMeta.companyName ||
          extra.companyName
      ) || tenantKey,
    industryKey:
      clean(
        tenant.industryKey ||
          tenant.industry ||
          brand.industryKey ||
          brand.industry ||
          extra.industryKey ||
          extra.industry ||
          proposalObj.industryKey ||
          proposalMeta.industryKey
      ) || "generic_business",
    defaultLanguage:
      clean(
        tenant.defaultLanguage ||
          tenant.language ||
          brand.defaultLanguage ||
          brand.language ||
          extra.language ||
          proposalObj.language
      ) || "az",
    outputLanguage:
      clean(
        tenant.outputLanguage ||
          brand.outputLanguage ||
          extra.language ||
          proposalObj.language
      ) || "",
    ctaStyle:
      clean(
        tenant.ctaStyle ||
          brand.ctaStyle ||
          extra.ctaStyle
      ) || "contact",
    visualTheme:
      clean(
        tenant.visualTheme ||
          brand.visualTheme ||
          extra.visualTheme
      ) || "premium_modern",
    brand: {
      name:
        clean(brand.name || tenant.brandName || tenant.companyName || extra.companyName) ||
        undefined,
      companyName:
        clean(brand.companyName || tenant.companyName || extra.companyName) || undefined,
      industryKey:
        clean(brand.industryKey || tenant.industryKey || extra.industryKey) || undefined,
      defaultLanguage:
        clean(brand.defaultLanguage || tenant.defaultLanguage || extra.language) || undefined,
      outputLanguage:
        clean(brand.outputLanguage || tenant.outputLanguage || extra.language) || undefined,
      ctaStyle:
        clean(brand.ctaStyle || tenant.ctaStyle || extra.ctaStyle) || undefined,
      visualTheme:
        clean(brand.visualTheme || tenant.visualTheme || extra.visualTheme) || undefined,
      tone: Array.isArray(brand.tone) ? brand.tone : Array.isArray(tenant.tone) ? tenant.tone : [],
      services: Array.isArray(brand.services)
        ? brand.services
        : Array.isArray(tenant.services)
        ? tenant.services
        : [],
      audiences: Array.isArray(brand.audiences)
        ? brand.audiences
        : Array.isArray(tenant.audiences)
        ? tenant.audiences
        : [],
      requiredHashtags:
        Array.isArray(brand.requiredHashtags)
          ? brand.requiredHashtags
          : Array.isArray(tenant.requiredHashtags)
          ? tenant.requiredHashtags
          : [],
      preferredPresets:
        Array.isArray(brand.preferredPresets)
          ? brand.preferredPresets
          : Array.isArray(tenant.preferredPresets)
          ? tenant.preferredPresets
          : [],
      visualStyle: isObject(brand.visualStyle)
        ? brand.visualStyle
        : isObject(tenant.visualStyle)
        ? tenant.visualStyle
        : {},
    },
    meta: {
      companyName:
        clean(extra.companyName || proposalObj.companyName || proposalMeta.companyName) || undefined,
      industryKey:
        clean(extra.industryKey || proposalObj.industryKey || proposalMeta.industryKey) ||
        undefined,
      defaultLanguage:
        clean(extra.language || proposalObj.language) || undefined,
      ctaStyle:
        clean(extra.ctaStyle) || undefined,
    },
  });
}

function buildMediaPayload(proposal, extra = {}) {
  const contentPack =
    extra.contentPack ||
    extra.content_pack ||
    extra.pack ||
    proposal?.content_pack ||
    null;

  const video =
    extra.video ||
    (isObject(contentPack) && isObject(contentPack.video) ? contentPack.video : null) ||
    null;

  const visualPlan =
    extra.visualPlan ||
    (isObject(contentPack) ? contentPack.visualPlan || contentPack.visual_plan || null : null) ||
    null;

  const slides =
    extra.slides ||
    (Array.isArray(contentPack?.slides) ? contentPack.slides : []) ||
    [];

  const format =
    normalizeFormat(
      extra.format ||
      contentPack?.format ||
      proposal?.format ||
      extra.postType ||
      extra.post_type
    ) || null;

  const aspectRatio =
    normalizeAspectRatio(
      extra.aspectRatio ||
        extra.aspect_ratio ||
        contentPack?.aspectRatio ||
        contentPack?.aspect_ratio,
      format || ""
    ) || null;

  const voiceoverText =
    extra.voiceoverText ||
    extra.voiceover_text ||
    contentPack?.voiceoverText ||
    contentPack?.voiceover_text ||
    null;

  const videoPrompt =
    extra.videoPrompt ||
    extra.video_prompt ||
    contentPack?.videoPrompt ||
    contentPack?.video_prompt ||
    null;

  return deepFix({
    format,
    aspectRatio,
    contentId: extra.contentId || extra.content_id || null,
    assetId: extra.assetId || extra.asset_id || null,
    visualPlan: isObject(visualPlan) ? visualPlan : null,
    slides,
    voiceoverText: voiceoverText ? String(voiceoverText) : null,
    videoPrompt: videoPrompt ? String(videoPrompt) : null,
    video: isObject(video) ? video : null,
    contentPack: isObject(contentPack) ? contentPack : null,
  });
}

function buildPromptExtra({
  proposal,
  extra,
  media,
  workflowHint,
  mappedEvent,
}) {
  const format =
    normalizeFormat(
      extra.format ||
        media?.format ||
        proposal?.format ||
        extra.postType ||
        extra.post_type
    ) || "image";

  const automationMode = normalizeAutomationMode(
    extra.automationMode,
    extra.autoPublish ? "full_auto" : "manual"
  );

  const base = deepFix({
    ...extra,
    format,
    language: pickLanguage(extra, proposal),
    workflowHint,
    mappedEvent,
    proposalId: pickProposalId(proposal, extra),
    threadId: pickThreadId(proposal, extra),
    tenantKey: pickTenantKey(extra, proposal),
    tenantId: pickTenantId(extra, proposal),
    title: pickTitle(extra, proposal),
    decision: pickDecision(extra, proposal),
    automationMode,
    autoPublish: automationMode === "full_auto",
    scheduledTime: clean(extra.scheduledTime || ""),
    scheduleTimezone: clean(extra.timezone || extra.scheduleTimezone || ""),
    dateKey: clean(extra.dateKey || ""),
    contentPack:
      extra.contentPack ||
      extra.content_pack ||
      proposal?.content_pack ||
      null,
    visualPlan: media?.visualPlan || extra.visualPlan || null,
    slides: media?.slides || extra.slides || [],
    voiceoverText: media?.voiceoverText || extra.voiceoverText || null,
    videoPrompt: media?.videoPrompt || extra.videoPrompt || null,
    aspectRatio: media?.aspectRatio || extra.aspectRatio || null,
    assetUrls:
      extra.assetUrls ||
      extra.generatedAssetUrls ||
      extra.assets ||
      [],
  });

  if (mappedEvent === "content.publish") {
    base.approvedDraft =
      extra.approvedDraft ||
      extra.draft ||
      extra.content ||
      extra.contentPack ||
      proposal?.content_pack ||
      null;
  }

  if (mappedEvent === "proposal.approved") {
    base.approvedProposal =
      extra.approvedProposal ||
      extra.proposal ||
      proposal ||
      null;
    base.topicHint =
      clean(extra.topicHint || extra.topic || proposal?.title) || "";
    base.goalHint =
      clean(extra.goalHint || extra.goal) || "";
  }

  if (mappedEvent === "content.revise") {
    base.previousDraft =
      extra.previousDraft ||
      extra.draft ||
      extra.content ||
      proposal?.content_pack ||
      null;
    base.feedback = clean(extra.feedback || "");
  }

  if (mappedEvent === "tenant.draft.schedule.trigger") {
    base.scheduleTrigger = {
      dateKey: clean(extra.dateKey || ""),
      timezone: clean(extra.timezone || extra.scheduleTimezone || ""),
      scheduledTime: clean(extra.scheduledTime || ""),
      automationMode,
      autoPublish: automationMode === "full_auto",
    };
  }

  return base;
}

export function notifyN8n(event, proposal, extra = {}) {
  const action = clean(extra.action || event);
  const mappedEvent = normalizeEventForTransport(event, extra);
  const url = pickWebhookUrl(mappedEvent, extra);

  if (!url) {
    console.log(`[n8n] skipped: no webhook url for ${mappedEvent}`);
    return;
  }

  const callbackRel = extra?.callback?.url || "/api/executions/callback";
  const callbackAbs = absoluteCallbackUrl(callbackRel);
  const media = buildMediaPayload(proposal, extra);
  const workflowHint = pickWorkflowHint(event, { ...extra, action });

  const tenantRuntime = buildTenantRuntime(proposal, extra);
  const promptExtra = buildPromptExtra({
    proposal,
    extra,
    media,
    workflowHint,
    mappedEvent,
  });

  const normalizedPromptInput = normalizePromptInput(action || mappedEvent, {
    tenant: tenantRuntime,
    today: extra.today || nowIso(),
    format: promptExtra.format || media?.format || proposal?.format || "image",
    extra: promptExtra,
  });

  const prompts = buildPromptBundle(action || mappedEvent, {
    tenant: normalizedPromptInput.tenant,
    today: normalizedPromptInput.today,
    format: normalizedPromptInput.format,
    extra: normalizedPromptInput.extra,
  });

  const automationMode = normalizeAutomationMode(
    extra.automationMode,
    extra.autoPublish ? "full_auto" : "manual"
  );

  const payload = deepFix({
    event: mappedEvent,
    action,
    workflowHint,

    tenantKey: pickTenantKey(extra, proposal),
    tenantId: pickTenantId(extra, proposal),
    proposalId: pickProposalId(proposal, extra),
    threadId: pickThreadId(proposal, extra),
    contentId: extra.contentId || extra.content_id || null,
    jobId: extra.jobId || null,
    executionId: extra.executionId || null,
    requestId: extra.requestId || null,

    by: pickBy(extra, proposal),
    decidedAt: pickDecidedAt(extra, proposal),

    callback: {
      tokenHeader: "x-webhook-token",
      ...(isObject(extra.callback) ? extra.callback : {}),
      url: callbackAbs || callbackRel,
    },

    prompts,
    promptInput: normalizedPromptInput,
    media,

    automation: {
      mode: automationMode,
      enabled: automationMode === "full_auto",
      autoPublish: automationMode === "full_auto",
    },

    schedule: {
      dateKey: clean(extra.dateKey || ""),
      timezone: clean(extra.timezone || extra.scheduleTimezone || ""),
      scheduledTime: clean(extra.scheduledTime || ""),
      scheduledHour: extra.scheduledHour ?? null,
      scheduledMinute: extra.scheduledMinute ?? null,
      triggerType: clean(extra.triggerType || ""),
    },

    title: pickTitle(extra, proposal),
    decision: pickDecision(extra, proposal),
    proposal: proposal || null,

    result: extra.result || null,
    meta: deepFix({
      source: "ai-hq-backend",
      provider: media?.video?.provider || extra.provider || null,
      format: media?.format || null,
      aspectRatio: media?.aspectRatio || null,
      language: normalizedPromptInput?.language || null,
      automationMode,
      autoPublish: automationMode === "full_auto",
    }),

    ...extra,
  });

  postToN8n({
    url,
    token: clean(cfg.n8n.webhookToken),
    timeoutMs: Number(cfg.n8n.timeoutMs || 10_000),
    payload,
    retries: Number(cfg.n8n.retries ?? 2),
    baseBackoffMs: Number(cfg.n8n.backoffMs ?? 500),
    requestId: extra.requestId,
    executionId: extra.executionId,
  })
    .then((r) => {
      const info = r?.ok ? `ok ${r.status || ""}` : `fail ${r.status || r.error || ""}`;
      const preview =
        typeof r?.data === "string"
          ? r.data.slice(0, 220)
          : JSON.stringify(r?.data || {}).slice(0, 220);

      console.log(
        `[n8n] event=${mappedEvent} action=${action || "-"} workflow=${workflowHint} url=${url} -> ${info} ${preview}`
      );
    })
    .catch((e) => {
      console.log("[n8n] error", String(e?.message || e));
    });
}