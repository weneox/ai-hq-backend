import { cfg } from "../config.js";
import { sendOutboundViaMetaGateway } from "../services/metaGatewayClient.js";
import {
  getMessageById,
  getThreadById,
  listRetryableOutboundAttempts,
  markOutboundAttemptFailed,
  markOutboundAttemptSending,
  markOutboundAttemptSent,
  updateOutboundMessageProviderId,
} from "../routes/api/inbox.db.js";
import { writeAudit } from "../utils/auditLog.js";

function s(v) {
  return String(v ?? "").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processAttempt({ db, wsHub, attempt }) {
  if (!attempt?.id) return;

  const message = await getMessageById(db, attempt.message_id);
  if (!message) {
    await markOutboundAttemptFailed({
      db,
      attemptId: attempt.id,
      error: "message not found",
      errorCode: "message_missing",
      providerResponse: {},
      retryDelaySeconds: 300,
    });
    return;
  }

  const thread = await getThreadById(db, attempt.thread_id);
  if (!thread) {
    await markOutboundAttemptFailed({
      db,
      attemptId: attempt.id,
      error: "thread not found",
      errorCode: "thread_missing",
      providerResponse: {},
      retryDelaySeconds: 300,
    });
    return;
  }

  const sending = await markOutboundAttemptSending(db, attempt.id);

  try {
    wsHub?.broadcast?.("inbox.outbound.attempt.updated", {
      type: "inbox.outbound.attempt.updated",
      attempt: sending,
    });
  } catch {}

  const payload = {
    tenantKey: attempt.tenant_key || message.tenant_key || cfg.DEFAULT_TENANT_KEY,
    channel: attempt.channel || thread.channel || "instagram",
    threadId: attempt.thread_id,
    recipientId:
      attempt.recipient_id ||
      message?.meta?.recipientId ||
      thread.external_user_id ||
      "",
    text: message.text || "",
    senderType: message.sender_type || "ai",
    messageType: message.message_type || "text",
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    meta: {
      ...(message?.meta && typeof message.meta === "object" ? message.meta : {}),
      skipOutboundAck: true,
      internalOutbound: true,
      alreadyTrackedInAiHq: true,
      resendAttemptId: attempt.id,
      threadId: attempt.thread_id,
      tenantKey: attempt.tenant_key,
      worker: "outbound_retry",
    },
  };

  const gateway = await sendOutboundViaMetaGateway(payload);

  if (!gateway.ok) {
    const failed = await markOutboundAttemptFailed({
      db,
      attemptId: attempt.id,
      error: gateway.error || "gateway send failed",
      errorCode: String(gateway.status || ""),
      providerResponse: gateway.json || {},
      retryDelaySeconds: 120,
    });

    try {
      await writeAudit(db, {
        actor: "system",
        action: "inbox.outbound.worker_failed",
        objectType: "inbox_outbound_attempt",
        objectId: String(attempt.id),
        meta: {
          threadId: String(attempt.thread_id || ""),
          messageId: String(attempt.message_id || ""),
          status: String(failed?.status || ""),
          gatewayStatus: Number(gateway?.status || 0),
          error: String(gateway?.error || ""),
        },
      });
    } catch {}

    try {
      wsHub?.broadcast?.("inbox.outbound.attempt.updated", {
        type: "inbox.outbound.attempt.updated",
        attempt: failed,
      });
    } catch {}

    return;
  }

  const providerResult = gateway?.json?.result || gateway?.json || {};
  const providerResponse =
    providerResult?.response || providerResult?.json || providerResult || {};

  const providerMessageId = s(
    providerResponse?.message_id ||
      providerResponse?.messageId ||
      providerResponse?.id ||
      ""
  ) || null;

  const sent = await markOutboundAttemptSent({
    db,
    attemptId: attempt.id,
    providerMessageId,
    providerResponse,
  });

  const updatedMessage = await updateOutboundMessageProviderId({
    db,
    messageId: message.id,
    providerMessageId,
    providerResponse,
  });

  try {
    await writeAudit(db, {
      actor: "system",
      action: "inbox.outbound.worker_sent",
      objectType: "inbox_outbound_attempt",
      objectId: String(attempt.id),
      meta: {
        threadId: String(attempt.thread_id || ""),
        messageId: String(attempt.message_id || ""),
        providerMessageId: String(providerMessageId || ""),
        gatewayStatus: Number(gateway?.status || 0),
      },
    });
  } catch {}

  try {
    wsHub?.broadcast?.("inbox.outbound.attempt.updated", {
      type: "inbox.outbound.attempt.updated",
      attempt: sent,
    });
  } catch {}

  try {
    wsHub?.broadcast?.("inbox.message.updated", {
      type: "inbox.message.updated",
      threadId: String(updatedMessage?.thread_id || message.thread_id || ""),
      message: updatedMessage || message,
    });
  } catch {}
}

export function startOutboundRetryWorker({ db, wsHub }) {
  if (!cfg.OUTBOUND_RETRY_ENABLED) {
    console.log("[ai-hq] outbound retry worker: disabled");
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;

    try {
      const attempts = await listRetryableOutboundAttempts(
        db,
        cfg.OUTBOUND_RETRY_BATCH_SIZE
      );

      for (const attempt of attempts) {
        if (stopped) break;
        try {
          await processAttempt({ db, wsHub, attempt });
          await sleep(150);
        } catch (e) {
          try {
            console.error("[ai-hq] outbound retry attempt error:", String(e?.message || e));
          } catch {}
        }
      }
    } catch (e) {
      try {
        console.error("[ai-hq] outbound retry worker error:", String(e?.message || e));
      } catch {}
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, cfg.OUTBOUND_RETRY_INTERVAL_MS);
      }
    }
  };

  timer = setTimeout(tick, cfg.OUTBOUND_RETRY_INTERVAL_MS);

  console.log(
    `[ai-hq] outbound retry worker: ON interval=${cfg.OUTBOUND_RETRY_INTERVAL_MS}ms batch=${cfg.OUTBOUND_RETRY_BATCH_SIZE}`
  );

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}