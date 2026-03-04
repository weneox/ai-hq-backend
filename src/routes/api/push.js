import express from "express";
import { cfg } from "../../config.js";
import { okJson } from "../../utils/http.js";
import { fixText, deepFix } from "../../utils/textFix.js";
import { requireDebugToken } from "../../utils/auth.js";
import { mem, memCreateNotification, memAudit } from "../../utils/memStore.js";
import { isDbReady } from "../../utils/http.js";
import { dbUpsertPushSub } from "../../db/helpers/push.js";
import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

export function pushRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/push/vapid", (_req, res) => {
    if (!cfg.PUSH_ENABLED) return okJson(res, { ok: false, error: "push disabled" });
    const publicKey = String(cfg.VAPID_PUBLIC_KEY || "").trim();
    if (!publicKey) return okJson(res, { ok: false, error: "VAPID_PUBLIC_KEY not set" });
    return okJson(res, { ok: true, publicKey });
  });

  r.get("/push/subscribe", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST /api/push/subscribe" });
  });

  r.post("/push/subscribe", async (req, res) => {
    const recipient = fixText(String(req.body?.recipient || "ceo").trim()) || "ceo";
    const sub = req.body?.subscription || req.body?.sub || null;
    const endpoint = String(sub?.endpoint || "").trim();
    const p256dh = String(sub?.keys?.p256dh || "").trim();
    const auth = String(sub?.keys?.auth || "").trim();
    const ua = String(req.headers["user-agent"] || "").trim();

    if (!endpoint || !p256dh || !auth) {
      return okJson(res, { ok: false, error: "subscription {endpoint, keys.p256dh, keys.auth} required" });
    }

    try {
      if (!isDbReady(db)) {
        mem.pushSubs.set(endpoint, { recipient, endpoint, p256dh, auth, user_agent: ua, created_at: new Date().toISOString() });
        return okJson(res, { ok: true, dbDisabled: true });
      }

      await dbUpsertPushSub(db, { recipient, endpoint, p256dh, auth, userAgent: ua });
      return okJson(res, { ok: true });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  r.post("/push/test", async (req, res) => {
    if (!requireDebugToken(req)) return okJson(res, { ok: false, error: "forbidden (missing/invalid debug token)" });
    if (!cfg.PUSH_ENABLED) return okJson(res, { ok: false, error: "push disabled" });

    const title = fixText(String(req.body?.title || "AI HQ Test").trim());
    const body = fixText(String(req.body?.body || "Push is working ✅").trim());
    const data = req.body?.data && typeof req.body.data === "object" ? deepFix(req.body.data) : { type: "push.test" };

    try {
      await pushBroadcastToCeo({ db, title, body, data });

      if (!isDbReady(db)) {
        const notif = memCreateNotification({ recipient: "ceo", type: "info", title: "Push Test Sent", body, payload: { title, body, data } });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });
        memAudit("system", "push.test", "push", null, { title });
        return okJson(res, { ok: true, sent: true, notification: notif, dbDisabled: true });
      }

      const notif = await dbCreateNotification(db, { recipient: "ceo", type: "info", title: "Push Test Sent", body, payload: { title, body, data } });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      await dbAudit(db, "system", "push.test", "push", null, { title });

      return okJson(res, { ok: true, sent: true, notification: notif });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}