// src/services/n8nNotify.js (FINAL v2.2 — Correct event routing)
// ✅ FIX: content.assets.generate was NOT mapped => was going to wrong webhook
// ✅ Works with either N8N_WEBHOOK_BASE or single N8N_WEBHOOK_URL
// ✅ Uses cfg.N8N_RETRIES / cfg.N8N_BACKOFF_MS from config

import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { absoluteCallbackUrl } from "../utils/url.js";
import { buildPromptBundle } from "./promptBundle.js";
import { postToN8n } from "../utils/n8n.js";

function joinBase(base, path) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  const p = String(path || "").trim().replace(/^\/+/, "");
  if (!b || !p) return "";
  return `${b}/${p}`;
}

function pickWebhookUrl(event, extra = {}) {
  // 1) per-call override
  const override = String(extra.webhookUrl || "").trim();
  if (override) return override;

  // 2) base routing (recommended)
  // Set in Railway:
  // N8N_WEBHOOK_BASE=https://neoxcompany.app.n8n.cloud/webhook
  const base = String(cfg.N8N_WEBHOOK_BASE || "").trim();
  if (base) {
    // ✅ IMPORTANT:
    // Your provided production webhook is: /webhook/aihq-approved
    // We'll route ALL approval / asset-generation events there unless you create separate endpoints.

    // Approve pipeline (draft generate)
    if (event === "proposal.approved") return joinBase(base, "aihq-approved");
    if (event === "proposal.rejected") return joinBase(base, "aihq-approved");

    // Draft revise loop
    if (event === "content.revise") return joinBase(base, "aihq-approved");

    // ✅ THE FIX: Asset generation trigger MUST go to the same flow you showed
    if (event === "content.assets.generate") return joinBase(base, "aihq-approved");

    // Publish flow (if you have separate webhook later)
    if (event === "content.publish") return joinBase(base, "aihq-publish");

    // default
    return joinBase(base, "aihq-approved");
  }

  // 3) single URL fallback (works if you set N8N_WEBHOOK_URL directly)
  return String(cfg.N8N_WEBHOOK_URL || "").trim();
}

export function notifyN8n(event, proposal, extra = {}) {
  const url = pickWebhookUrl(event, extra);
  if (!url) {
    console.log(`[n8n] skip (no url) event=${event}`);
    return;
  }

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
          ? r.data.slice(0, 200)
          : JSON.stringify(r?.data || {}).slice(0, 200);
      console.log(`[n8n] ${event} → ${info} url=${url} ${preview}`);
    })
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}