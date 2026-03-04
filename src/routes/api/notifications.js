import express from "express";
import { okJson, clamp, isDbReady } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { mem, memListNotifications, memMarkRead, memAudit } from "../../utils/memStore.js";
import { dbListNotifications, dbMarkNotificationRead } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

export function notificationsRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/notifications", async (req, res) => {
    const recipient = fixText(String(req.query.recipient || "ceo").trim()) || "ceo";
    const unreadOnly = String(req.query.unread || "").trim() === "1";
    const limit = clamp(req.query.limit ?? 50, 1, 200);

    try {
      if (!isDbReady(db)) {
        const rows = memListNotifications({ recipient, unreadOnly, limit });
        return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows, dbDisabled: true });
      }
      const rows = await dbListNotifications(db, { recipient, unreadOnly, limit });
      return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  r.post("/notifications/:id/read", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "notification id required" });

    try {
      if (!isDbReady(db)) {
        const row = memMarkRead(id);
        if (!row) return okJson(res, { ok: false, error: "not found", dbDisabled: true });
        wsHub?.broadcast?.({ type: "notification.read", notification: row });
        memAudit("ceo", "notification.read", "notification", id, {});
        return okJson(res, { ok: true, notification: row, dbDisabled: true });
      }

      const row = await dbMarkNotificationRead(db, id);
      if (!row) return okJson(res, { ok: false, error: "not found" });
      wsHub?.broadcast?.({ type: "notification.read", notification: row });
      await dbAudit(db, "ceo", "notification.read", "notification", String(row.id), {});
      return okJson(res, { ok: true, notification: row });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}