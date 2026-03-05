// src/routes/api/debate.js (FINAL — cron draft + formatHint wired to engine + proposal+content_items persist)

import express from "express";
import crypto from "crypto";

import { cfg } from "../../config.js";
import { okJson, clamp, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { runDebate } from "../../kernel/debateEngine.js";
import {
  memEnsureThread,
  memAddMessage,
  memCreateProposal,
} from "../../utils/memStore.js";

function normalizeMode(mode) {
  const m = String(mode || "answer").trim().toLowerCase();
  if (m === "content.draft" || m === "content_draft") return "draft";
  if (m === "content.revise" || m === "content_revise") return "revise";
  if (m === "content.publish" || m === "content_publish") return "publish";
  if (m === "trend.research" || m === "trend_research") return "trend";
  if (m === "meta.comment_reply" || m === "meta_comment_reply") return "meta_comment";
  return m;
}

// debateEngine returns:
// - for mode="proposal": proposal is proposal JSON
// - for mode="draft"/"trend"/"publish"/"revise": proposal is wrapper {type,title,payload} or payload (your engine)
// This unwrap tries to extract the "payload" object as content pack
function unwrapContentPackFromProposalPayload(p) {
  if (!p || typeof p !== "object") return null;
  if (p.payload && typeof p.payload === "object") return deepFix(p.payload);
  return deepFix(p);
}

function statusForMode(mode) {
  const m = normalizeMode(mode);
  if (m === "draft") return "in_progress";   // Drafting tab
  if (m === "revise") return "in_progress";  // regenerating loop
  if (m === "publish") return "approved";
  if (m === "trend") return "approved";
  if (m === "proposal") return "pending";
  return "pending";
}

export function debateRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/debate
  r.post("/debate", async (req, res) => {
    const tenantId =
      fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";

    let message = fixText(String(req.body?.message || "").trim());
    const mode = normalizeMode(req.body?.mode);
    const rounds = clamp(req.body?.rounds ?? 1, 1, 5);
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : null;

    // ✅ Accept from n8n: formatHint | FORMAT | format
    const formatHintRaw = req.body?.formatHint ?? req.body?.FORMAT ?? req.body?.format ?? "";
    const formatHint = fixText(String(formatHintRaw || "").trim());

    let threadId = String(req.body?.threadId || "").trim();
    if (!threadId) threadId = crypto.randomUUID();

    // ✅ CRON SUPPORT: message boş gələ bilər (draft/trend üçün)
    if (!message) {
      const today = new Date().toISOString().slice(0, 10);

      if (mode === "draft") {
        message = `
AUTO_DRAFT (${today})
Tenant=${tenantId}
${formatHint ? `Preferred format: ${formatHint}` : ""}

Generate today's Instagram content draft for this tenant.
Return STRICT JSON ONLY as usecase requires.
        `.trim();
      } else if (mode === "trend") {
        message = `
AUTO_TREND (${today})
Tenant=${tenantId}

Research and return trend brief.
Return STRICT JSON ONLY as usecase requires.
        `.trim();
      } else {
        return okJson(res, { ok: false, error: "message required" });
      }
    }

    try {
      // 1) Store user message
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
           values ($1::uuid, 'user', null, $2::text, $3::jsonb)`,
          [threadId, message, { mode, tenantId, formatHint: formatHint || null }]
        );
      }

      // 2) Run debate engine  ✅ formatHint + tenantId engine-ə gedir
      const out = await runDebate({
        message,
        mode,
        rounds,
        agents,
        tenantId,
        threadId,
        formatHint: formatHint || null,
      });

      const finalAnswer = fixText(String(out?.finalAnswer || "").trim());
      const agentNotes = deepFix(out?.agentNotes || []);

      // 3) Store assistant message
      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, {
          role: "assistant",
          agent: "debate",
          content: finalAnswer,
          meta: { agentNotes, mode, tenantId, formatHint: formatHint || null },
        });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', 'debate', $2::text, $3::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, finalAnswer, { agentNotes, mode, tenantId, formatHint: formatHint || null }]
        );
        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      // 4) Persist proposal + content_items (draft)
      let proposal = null;
      let content = null;

      if (out?.proposal && typeof out.proposal === "object") {
        const payload = deepFix(out.proposal);

        // title best-effort
        const title =
          fixText(payload.title || payload.name || payload.summary || payload.goal || payload.topic || "") ||
          `Draft ${new Date().toISOString()}`;

        const status = statusForMode(mode);
        const type = String(payload.type || mode || "draft");

        if (!isDbReady(db)) {
          proposal = memCreateProposal(threadId, { agent: "debate", type, title, payload });
          wsHub?.broadcast?.({ type: "proposal.created", proposal });
        } else {
          const q2 = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb)
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [threadId, "debate", type, status, title, payload]
          );

          proposal = q2.rows?.[0] || null;
          if (proposal) {
            proposal.title = fixText(proposal.title);
            proposal.payload = deepFix(proposal.payload);
            wsHub?.broadcast?.({ type: "proposal.created", proposal });
          }

          // ✅ If draft: create content_items row so UI shows Generated Draft
          if (proposal && mode === "draft") {
            const contentPack = unwrapContentPackFromProposalPayload(payload);

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
        mode,
        formatHint: formatHint || null,
        finalAnswer,
        agentNotes,
        proposal,
        content,
        dbDisabled: !isDbReady(db),
        debug: deepFix(out?.debug || {}),
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