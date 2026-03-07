// src/services/n8nNotify.js
// FINAL — Runway / Draft / Asset / Publish aware routing
// ✅ publish now routes to /aihq-publish
// ✅ approved/assets route to /aihq-approved
// ✅ supports full URL or base URL
// ✅ keeps original action while sending normalized event
// ✅ includes stable callback + prompt bundle + media/reel fields

import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
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

  if (clean(event) === "proposal.approved") {
    return "approved";
  }

  return "generic";
}

function pickWebhookUrl(event, extra = {}) {
  const override = clean(extra.webhookUrl);
  if (override) return override;

  const full = clean(cfg.N8N_WEBHOOK_URL);
  if (full) return stripTrailingSlashes(full);

  const perEvent = {
    "proposal.approved": clean(cfg.N8N_WEBHOOK_PROPOSAL_APPROVED_URL),
    "content.publish": clean(cfg.N8N_WEBHOOK_PUBLISH_URL),
  };

  if (perEvent[event]) return stripTrailingSlashes(perEvent[event]);

  const base = stripTrailingSlashes(cfg.N8N_WEBHOOK_BASE);
  if (!base) return "";

  if (looksLikeFullWebhookUrl(base)) return base;

  // Approved / asset / draft-auto flow
  if (event === "proposal.approved") return `${base}/aihq-approved`;

  // Publish flow
  if (event === "content.publish") return `${base}/aihq-publish`;

  // Fallback
  return `${base}/aihq-approved`;
}

function pickProposalId(proposal, extra = {}) {
  return clean(extra.proposalId || proposal?.id || proposal?.proposal_id || "") || null;
}

function pickThreadId(proposal, extra = {}) {
  return clean(extra.threadId || proposal?.thread_id || proposal?.threadId || "") || null;
}

function pickTenantId(extra = {}, proposal = null) {
  return clean(extra.tenantId || proposal?.tenant_id || cfg.DEFAULT_TENANT_KEY || "default") || "default";
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
      extra.aspectRatio || extra.aspect_ratio || contentPack?.aspectRatio || contentPack?.aspect_ratio,
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
  const prompts = buildPromptBundle(action || mappedEvent);
  const media = buildMediaPayload(proposal, extra);
  const workflowHint = pickWorkflowHint(event, { ...extra, action });

  const payload = deepFix({
    event: mappedEvent,
    action,
    workflowHint,

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
    media,

    title: pickTitle(extra, proposal),
    decision: pickDecision(extra, proposal),
    proposal: proposal || null,

    result: extra.result || null,
    meta: deepFix({
      source: "ai-hq-backend",
      provider: media?.video?.provider || extra.provider || null,
      format: media?.format || null,
      aspectRatio: media?.aspectRatio || null,
    }),

    ...extra,
  });

  postToN8n({
    url,
    token: clean(cfg.N8N_WEBHOOK_TOKEN),
    timeoutMs: Number(cfg.N8N_TIMEOUT_MS || 10_000),
    payload,
    retries: Number(cfg.N8N_RETRIES ?? 2),
    baseBackoffMs: Number(cfg.N8N_BACKOFF_MS ?? 500),
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