// src/services/n8nNotify.js (FIXED — compat: Draft Approve triggers the existing /aihq-approved flow)

import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
import { postToN8n } from "../utils/n8n.js";

function cleanBase(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

function pickWebhookUrl(event, extra = {}) {
  const override = String(extra.webhookUrl || "").trim();
  if (override) return override;

  const base = cleanBase(cfg.N8N_WEBHOOK_BASE);
  if (base) {
    // single flow in prod
    return `${base}/aihq-approved`;
  }

  return String(cfg.N8N_WEBHOOK_URL || "").trim();
}

export function notifyN8n(event, proposal, extra = {}) {
  // ✅ COMPAT LAYER:
  // Your existing production n8n workflow listens to "proposal.approved".
  // Draft Approve emits "content.assets.generate" -> we map it to proposal.approved
  // while keeping the original intent in `action`.
  const mappedEvent = event === "content.assets.generate" ? "proposal.approved" : event;

  const url = pickWebhookUrl(mappedEvent, extra);
  if (!url) return;

  const callbackRel = extra?.callback?.url || "/api/executions/callback";
  const callbackAbs = absoluteCallbackUrl(callbackRel);

  const prompts = buildPromptBundle(mappedEvent);

  const payload = deepFix({
    event: mappedEvent,
    action: extra.action || event, // keeps original event name
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

    ...extra,
  });

  postToN8n({
    url,
    token: String(cfg.N8N_WEBHOOK_TOKEN || "").trim(),
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