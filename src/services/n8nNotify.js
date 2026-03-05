// src/services/n8nNotify.js
// FINAL — FIXED (NO double /aihq-approved) + COMPAT mapping for existing flow

import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
import { postToN8n } from "../utils/n8n.js";

function clean(u) {
  return String(u || "").trim();
}
function stripTrailingSlashes(u) {
  return clean(u).replace(/\/+$/, "");
}
function looksLikeFullWebhookUrl(u) {
  // if user already provided a full webhook endpoint like .../webhook/aihq-approved
  return /\/webhook\/[^/]+$/i.test(stripTrailingSlashes(u));
}

function pickWebhookUrl(_event, extra = {}) {
  // 1) per-call override
  const override = clean(extra.webhookUrl);
  if (override) return override;

  // 2) explicit full URL wins (most stable)
  const full = clean(cfg.N8N_WEBHOOK_URL);
  if (full) return stripTrailingSlashes(full);

  // 3) base routing fallback
  // expected: https://neoxcompany.app.n8n.cloud/webhook
  // but sometimes people paste full endpoint here -> handle both
  const base = stripTrailingSlashes(cfg.N8N_WEBHOOK_BASE);
  if (!base) return "";

  // if BASE already ends with /webhook/<name> treat it as full endpoint
  if (looksLikeFullWebhookUrl(base)) return base;

  // otherwise append our single prod flow path
  return `${base}/aihq-approved`;
}

export function notifyN8n(event, proposal, extra = {}) {
  // ✅ COMPAT LAYER:
  // existing prod workflow listens to "proposal.approved"
  // Draft approve emits "content.assets.generate" -> map to "proposal.approved"
  const mappedEvent = event === "content.assets.generate" ? "proposal.approved" : event;

  const url = pickWebhookUrl(mappedEvent, extra);
  if (!url) return;

  const callbackRel = extra?.callback?.url || "/api/executions/callback";
  const callbackAbs = absoluteCallbackUrl(callbackRel);

  const prompts = buildPromptBundle(mappedEvent);

  const payload = deepFix({
    event: mappedEvent,
    action: extra.action || event, // keep original intent
    tenantId: extra.tenantId || "default",
    proposalId: extra.proposalId || proposal?.id || null,
    threadId: extra.threadId || proposal?.thread_id || null,

    by: extra.by || proposal?.decision_by || "unknown",
    decidedAt: extra.decidedAt || proposal?.decided_at || null,
    jobId: extra.jobId || null,

    callback: {
      ...(extra.callback || { url: callbackRel, tokenHeader: "x-webhook-token" }),
      url: callbackAbs || callbackRel,
    },

    prompts,
    title: proposal?.title || extra.title || null,
    decision: extra.decision || proposal?.status || null,
    proposal: proposal || null,

    // keep extra fields (contentPack, assetUrl, caption, etc.)
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
          ? r.data.slice(0, 160)
          : JSON.stringify(r?.data || {}).slice(0, 160);
      console.log(`[n8n] ${mappedEvent} → ${info} ${preview}`);
    })
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}