import express from "express";
import { okJson, isDbReady, isUuid } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { mem, memEnsureThread, memAddMessage } from "../../utils/memStore.js";

export function threadsRoutes({ db }) {
  const r = express.Router();

  // GET /api/threads/:id/messages
  r.get("/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        const arr = mem.messages.get(threadId) || [];
        return okJson(res, { ok: true, threadId, messages: arr, dbDisabled: true });
      }

      const q = await db.query(
        `select id, thread_id, role, agent_key, content, meta, created_at
         from messages
         where thread_id = $1::uuid
         order by created_at asc
         limit 500`,
        [threadId]
      );
      const rows = (q.rows || []).map((m) => ({
        ...m,
        content: fixText(m.content),
        meta: deepFix(m.meta),
      }));
      return okJson(res, { ok: true, threadId, messages: rows });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // optional helper: create thread + message (mostly for dev)
  r.post("/threads/:id/message", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    const role = String(req.body?.role || "user").trim();
    const agent = String(req.body?.agent || "").trim() || null;
    const content = fixText(String(req.body?.content || "").trim());

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });
    if (!content) return okJson(res, { ok: false, error: "content required" });

    try {
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        const row = memAddMessage(threadId, { role, agent, content, meta: {} });
        return okJson(res, { ok: true, message: row, dbDisabled: true });
      }

      if (!isUuid(threadId)) return okJson(res, { ok: false, error: "threadId must be uuid" });

      const q = await db.query(
        `insert into messages (thread_id, role, agent_key, content, meta)
         values ($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)
         returning id, thread_id, role, agent_key, content, meta, created_at`,
        [threadId, role, agent, content, {}]
      );
      const row = q.rows?.[0] || null;
      if (!row) return okJson(res, { ok: false, error: "insert failed" });
      row.content = fixText(row.content);
      row.meta = deepFix(row.meta);
      return okJson(res, { ok: true, message: row });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}