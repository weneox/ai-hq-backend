import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
import { postToN8n } from "../utils/n8n.js";

function pickWebhookUrl(event, extra = {}) {
  // 1) per-call override
  const override = String(extra.webhookUrl || "").trim();
  if (override) return override;

  // 2) event-based routing (ideal)
  // Set in Railway:
  // N8N_WEBHOOK_BASE=https://neoxcompany.app.n8n.cloud/webhook
  const base = String(cfg.N8N_WEBHOOK_BASE || "").trim();
  if (base) {
    // ✅ Adjust paths to your real n8n webhook paths:
    // - publish flow screenshot: /webhook/aihq-publish
    // - approve flow: whatever your approve webhook path is (example: /webhook/approve)
    if (event === "content.publish") return `${base}/aihq-publish`;
    if (event === "proposal.approved") return `${base}/approve`;
    if (event === "proposal.rejected") return `${base}/approve`;
    if (event === "content.revise") return `${base}/aihq-content-pack`; // optional if you have it
    return `${base}/approve`;
  }

  // 3) legacy single URL fallback
  return String(cfg.N8N_WEBHOOK_URL || "").trim();
}

export function notifyN8n(event, proposal, extra = {}) {
  const url = pickWebhookUrl(event, extra);
  if (!url) return;

  const callbackRel = extra?.callback?.url || "/api/executions/callback";
  const callbackAbs = absoluteCallbackUrl(callbackRel);

  const prompts = buildPromptBundle(event);

  const payload = deepFix({
    event,
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
    summary: extra.summary || null,
    tasks: extra.tasks || null,
    ownerMap: extra.ownerMap || null,
    decision: extra.decision || proposal?.status || null,
    proposal: proposal || null,

    // keep extra fields (imageUrl/caption/contentPack/etc)
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
      console.log(`[n8n] ${event} → ${info} ${preview}`);
    })
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}