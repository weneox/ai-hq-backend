import express from "express";
import crypto from "crypto";
import { okJson, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { kernelHandle } from "../../kernel/agentKernel.js";
import { memEnsureThread, memAddMessage } from "../../utils/memStore.js";

export function chatRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/chat { threadId?, message, agentId? }
  r.post("/chat", async (req, res) => {
    const agentId = String(req.body?.agentId || "orion").trim() || "orion";
    const message = fixText(String(req.body?.message || "").trim());
    let threadId = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    try {
      // in-memory thread if not provided
      if (!threadId) threadId = crypto.randomUUID?.() || String(Date.now());
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: null, content: message });
      } else {
        // best effort: if thread doesn't exist, create it
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
        agentId,
        input: message,
        threadId,
      });

      const answer = fixText(String(out?.text || out?.output_text || out?.answer || "").trim());

      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, { role: "assistant", agent: agentId, content: answer });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, agentId, answer, deepFix(out?.meta || {})]
        );
        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      return okJson(res, { ok: true, threadId, agentId, answer, meta: deepFix(out?.meta || {}) });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}