import webpush from "web-push";
import { cfg } from "../config.js";

let _configured = false;

function ensureConfigured() {
  if (_configured) return true;
  if (!cfg.PUSH_ENABLED) return false;

  const pub = String(cfg.VAPID_PUBLIC_KEY || "").trim();
  const priv = String(cfg.VAPID_PRIVATE_KEY || "").trim();
  const subj =
    String(cfg.VAPID_SUBJECT || "").trim() || "mailto:notifications@local.invalid";

  if (!pub || !priv) return false;

  webpush.setVapidDetails(subj, pub, priv);
  _configured = true;
  return true;
}

function safeStringify(x) {
  try {
    return JSON.stringify(x ?? {});
  } catch {
    return JSON.stringify({ title: "AI HQ", body: "Notification", data: {} });
  }
}

// subscription: { endpoint, keys:{p256dh,auth} }
// payloadObj: { title, body, data }
export async function pushSendOne(subscription, payloadObj, options = {}) {
  if (!cfg.PUSH_ENABLED) return { ok: true, skipped: "PUSH_ENABLED=0" };
  if (!ensureConfigured()) return { ok: false, error: "missing VAPID keys" };

  const ttl = Number.isFinite(Number(options.ttl)) ? Number(options.ttl) : 60;
  const payload = safeStringify(payloadObj || {});

  try {
    await webpush.sendNotification(subscription, payload, { TTL: ttl });
    return { ok: true };
  } catch (e) {
    const statusCode = e?.statusCode || e?.status || null;
    const body = e?.body || null;
    const expired = statusCode === 410 || statusCode === 404;

    return {
      ok: false,
      error: String(e?.message || e),
      statusCode,
      expired,
      body: typeof body === "string" ? body.slice(0, 500) : body,
    };
  }
}