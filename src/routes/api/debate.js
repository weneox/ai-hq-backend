import express from "express";
import crypto from "crypto";

import { cfg } from "../../config.js";
import { okJson, clamp, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { runDebate } from "../../kernel/debateEngine.js";
import { memEnsureThread, memAddMessage, memCreateProposal } from "../../utils/memStore.js";

import { getTenantMode } from "./mode.js"; // helper exported earlier

export function debateRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/debate { message, mode:"proposal"|"answer", rounds?, agents?, tenantId? }
  r.post("/debate", async (req, res) => {
    const tenantId = fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";
    const message = fixText(String(req.body?.message || "").trim());
    const mode = String(req.body?.mode || "answer").trim().toLowerCase();
    const rounds = clamp(req.body?.rounds ?? 1, 1, 5);
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : null;

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = String(req.body?.threadId || "").trim();
    if (!threadId) threadId = crypto.randomUUID();

    try {
      // store user message (db or mem)
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: null, content: message });
      } else {
        await db.query(
          `insert into threads (id, title) values ($1::uuid, $2::text)
           on conflict (id) do nothing`,
          [threadId, "Debate"]
        );
        await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'user', null, $2::text, '{}'::jsonb)`,
          [threadId, message]
        );
      }

      const out = await runDebate({
        message,
        mode,
        rounds,
        agents,
        tenantId,
        threadId,
      });

      const finalAnswer = fixText(String(out?.finalAnswer || "").trim());
      const agentNotes = deepFix(out?.agentNotes || []);

      // save assistant message
      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, { role: "assistant", agent: "debate", content: finalAnswer, meta: { agentNotes } });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', 'debate', $2::text, $3::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, finalAnswer, { agentNotes }]
        );
        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      // if mode=proposal, persist proposal row (pending) and broadcast
      let proposal = null;
      if (mode === "proposal" && out?.proposal && typeof out.proposal === "object") {
        const payload = deepFix(out.proposal);
        const title =
          fixText(payload.title || payload.name || payload.summary || payload.goal || "") ||
          `Proposal ${new Date().toISOString()}`;

        if (!isDbReady(db)) {
          proposal = memCreateProposal(threadId, { agent: "debate", type: payload.type || "content", title, payload });
          wsHub?.broadcast?.({ type: "proposal.created", proposal });
        } else {
          const q2 = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1::uuid, $2::text, $3::text, 'pending', $4::text, $5::jsonb)
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [threadId, "debate", String(payload.type || "content"), title, payload]
          );
          proposal = q2.rows?.[0] || null;
          if (proposal) {
            proposal.title = fixText(proposal.title);
            proposal.payload = deepFix(proposal.payload);
            wsHub?.broadcast?.({ type: "proposal.created", proposal });
          }
        }

        // AUTO mode: if tenant mode=auto => immediately approve => in_progress job+n8n (handled in proposals.js decision endpoint)
        // Burda sadəcə create edirik, auto-approve logic proposals decision route içindədir.
      }

      // return
      return okJson(res, {
        ok: true,
        tenantId,
        threadId,
        finalAnswer,
        agentNotes,
        proposal,
        dbDisabled: !isDbReady(db),
        debug: deepFix(out?.debug || {}),
      });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}