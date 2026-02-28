// src/utils/push.js (FINAL v1.0)
import webpush from "web-push";
import { cfg } from "../config.js";

let _configured = false;

function ensureConfigured() {
  if (_configured) return true;
  if (!cfg.PUSH_ENABLED) return false;

  const pub = String(cfg.VAPID_PUBLIC_KEY || "").trim();
  const priv = String(cfg.VAPID_PRIVATE_KEY || "").trim();
  const subj = String(cfg.VAPID_SUBJECT || "").trim() || "mailto:info@weneox.com";

  if (!pub || !priv) return false;

  webpush.setVapidDetails(subj, pub, priv);
  _configured = true;
  return true;
}

// subscription: { endpoint, keys:{p256dh,auth} }
export async function pushSendOne(subscription, payloadObj) {
  if (!cfg.PUSH_ENABLED) return { ok: true, skipped: "PUSH_ENABLED=0" };
  if (!ensureConfigured()) return { ok: false, error: "missing VAPID keys" };

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payloadObj || {}));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}