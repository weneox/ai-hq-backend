import express from "express";
import crypto from "crypto";

import { cfg } from "../../config.js";
import { okJson, clamp, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { runDebate } from "../../kernel/debateEngine.js";
import { memEnsureThread, memAddMessage, memCreateProposal } from "../../utils/memStore.js";

export function debateRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/debate { message?, mode:"proposal"|"answer"|"draft"|"revise"|"publish"|"trend"|"meta_comment", rounds?, agents?, tenantId?, threadId? }
  r.post("/debate", async (req, res) => {
    const tenantId = fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";

    let message = fixText(String(req.body?.message || "").trim());
    const mode = String(req.body?.mode || "answer").trim().toLowerCase();
    const rounds = clamp(req.body?.rounds ?? 1, 1, 5);
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : null;

    let threadId = String(req.body?.threadId || "").trim();
    if (!threadId) threadId = crypto.randomUUID();

    // ✅ CRON SUPPORT:
    // mode=draft/trend/publish/revise -> message boş gələ bilər, default mesaj qururuq.
    // (revise/publish üçün normalda message-də previousDraft lazımdır; cron üçün əsasən draft istifadə edəcəksən)
    if (!message) {
      if (mode === "draft") {
        const today = new Date().toISOString().slice(0, 10);
        message =
          `AUTO_DRAFT (${today})\n` +
          `Tenant=${tenantId}\n` +
          `Generate today's Instagram content draft for this tenant. ` +
          `Rotate format (video/carousel/image) if policy says so. ` +
          `Return STRICT JSON as usecase requires.`;
      } else if (mode === "trend") {
        const today = new Date().toISOString().slice(0, 10);
        message =
          `AUTO_TREND (${today})\nTenant=${tenantId}\n` +
          `Research and return trend brief STRICT JSON per usecase.`;
      } else {
        return okJson(res, { ok: false, error: "message required" });
      }
    }

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

      // IMPORTANT: debateEngine səndə mode=draft üçün usecase seçir
      const out = await runDebate({
        message,
        mode,
        rounds,
        agents,
      });

      const finalAnswer = fixText(String(out?.finalAnswer || "").trim());
      const agentNotes = deepFix(out?.agentNotes || []);

      // save assistant message
      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, {
          role: "assistant",
          agent: "debate",
          content: finalAnswer,
          meta: { agentNotes, mode },
        });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', 'debate', $2::text, $3::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, finalAnswer, { agentNotes, mode }]
        );
        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      // ✅ NEW: mode=draft (və digər JSON mode-lar) üçün də proposal + content yaradırıq
      let proposal = null;
      let content = null;

      if (out?.proposal && typeof out.proposal === "object") {
        const payload = deepFix(out.proposal);
        const title =
          fixText(payload.title || payload.name || payload.summary || payload.goal || "") ||
          `Draft ${new Date().toISOString()}`;

        const status =
          mode === "draft" ? "in_progress" :
          mode === "publish" ? "approved" :
          mode === "revise" ? "in_progress" :
          mode === "trend" ? "approved" :
          "pending";

        if (!isDbReady(db)) {
          proposal = memCreateProposal(threadId, { agent: "debate", type: payload.type || mode, title, payload });
          // content_items mem store səndə varsa sonra əlavə edərik; hələlik proposal payload-da draft var.
          wsHub?.broadcast?.({ type: "proposal.created", proposal });
        } else {
          const q2 = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb)
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [threadId, "debate", String(payload.type || mode), status, title, payload]
          );
          proposal = q2.rows?.[0] || null;
          if (proposal) {
            proposal.title = fixText(proposal.title);
            proposal.payload = deepFix(proposal.payload);
            wsHub?.broadcast?.({ type: "proposal.created", proposal });
          }

          // ✅ If draft: create content_items row so UI can show Generated Draft (GET /api/content?proposalId=...)
          if (proposal && mode === "draft") {
            // NOTE: relies on your schema having: content_items(proposal_id,status,content_pack,last_feedback,job_id)
            const contentPack =
              payload?.payload ? payload.payload : payload; // debateEngine returns wrapper {type,title,payload}
            const q3 = await db.query(
              `insert into content_items (proposal_id, status, content_pack, last_feedback)
               values ($1::uuid, $2::text, $3::jsonb, null)
               returning id, proposal_id, status, content_pack, last_feedback, job_id, created_at, updated_at`,
              [proposal.id, "draft.ready", contentPack]
            );
            content = q3.rows?.[0] || null;
            if (content) {
              content.content_pack = deepFix(content.content_pack);
              wsHub?.broadcast?.({ type: "content.updated", content });
            }
          }
        }
      }

      return okJson(res, {
        ok: true,
        tenantId,
        threadId,
        finalAnswer,
        agentNotes,
        proposal,
        content,
        dbDisabled: !isDbReady(db),
        debug: deepFix(out?.debug || {}),
      });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}