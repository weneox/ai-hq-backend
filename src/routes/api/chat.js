import express from "express";
import crypto from "crypto";
import { okJson, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { kernelHandle } from "../../kernel/agentKernel.js";
import { memEnsureThread, memAddMessage } from "../../utils/memStore.js";

export function chatRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/chat { threadId?, message, agentId?, usecase?, tenant?, today?, format?, extra? }
  r.post("/chat", async (req, res) => {
    const agentId = String(req.body?.agentId || "orion").trim().toLowerCase() || "orion";
    const message = fixText(String(req.body?.message || "").trim());
    const usecase = String(req.body?.usecase || "").trim() || undefined;
    const tenant =
      req.body?.tenant && typeof req.body.tenant === "object" && !Array.isArray(req.body.tenant)
        ? req.body.tenant
        : null;
    const today = String(req.body?.today || "").trim() || "";
    const format = String(req.body?.format || "").trim() || "";
    const extra =
      req.body?.extra && typeof req.body.extra === "object" && !Array.isArray(req.body.extra)
        ? req.body.extra
        : {};

    let threadId = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    try {
      if (!threadId) threadId = crypto.randomUUID?.() || String(Date.now());

      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: null, content: message });
      } else {
        await db.query(
          `insert into threads (id, title) values ($1::uuid, $2::text)
           on conflict (id) do nothing`,
          [threadId, "Chat"]
        );

        await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'user', null, $2::text, '{}'::jsonb)`,
          [threadId, message]
        );
      }

      const out = await kernelHandle({
        message,
        agentHint: agentId,
        usecase,
        tenant,
        today,
        format,
        extra,
      });

      const answer = fixText(String(out?.replyText || "").trim());
      const meta = deepFix(out?.meta || {});

      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, {
          role: "assistant",
          agent: agentId,
          content: answer,
        });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, agentId, answer, meta]
        );

        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      return okJson(res, {
        ok: Boolean(out?.ok),
        threadId,
        agentId,
        answer,
        meta,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  return r;
}