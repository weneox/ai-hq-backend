// src/routes/api/proposals.js (FINAL — include latest content for Draft UI + fixes)
//
// Key upgrades:
// ✅ GET /api/proposals?status=... now returns latestContent {id,status,updated_at} (and optionally content_pack)
//    Use: ?includeContent=1 and ?includePack=1
// ✅ Fix missing memGetLatestContentByProposal import usage
// ✅ Remove dynamic import in request-changes
// ✅ Keep approve => in_progress (Drafting). Final approve is content/:id/approve
// ✅ Auto mode hook removed (we’ll do later)

import express from "express";
import { cfg } from "../../config.js";

import { okJson, clamp, isDbReady, isUuid, normalizeDecision } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";

import {
  mem,
  memListProposals,
  memCreateNotification,
  memCreateJob,
  memAudit,
  memGetLatestContentByProposal,
} from "../../utils/memStore.js";

import { dbGetProposalById } from "../../db/helpers/proposals.js";
import { dbCreateJob } from "../../db/helpers/jobs.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import {
  dbGetLatestDraftLikeByProposal,
  dbGetLatestApprovedDraftByProposal,
} from "../../db/helpers/content.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";

function safeTitle(p) {
  const payload = p?.payload && typeof p.payload === "object" ? p.payload : {};
  const t = payload?.title || payload?.name || payload?.summary || payload?.goal || p?.title || "";
  return fixText(String(t || "").trim());
}

function normalizeStatus(x) {
  const s = fixText(String(x || "").trim()) || "pending";
  const allowed = new Set(["pending", "in_progress", "approved", "published", "rejected"]);
  return allowed.has(s) ? s : "pending";
}

export function proposalsRoutes({ db, wsHub }) {
  const r = express.Router();

  // GET /api/proposals?status=pending|in_progress|approved|published|rejected
  // Optional:
  // - includeContent=1  => adds latestContent {id,status,updated_at,last_feedback?}
  // - includePack=1     => includes latestContent.content_pack (heavier payload)
  r.get("/proposals", async (req, res) => {
    const status = normalizeStatus(req.query.status);
    const limit = clamp(req.query.limit ?? 50, 1, 200);

    const includeContent = String(req.query.includeContent || "1") === "1"; // default ON for your UI
    const includePack = String(req.query.includePack || "0") === "1";

    try {
      // =============== MEMORY ===============
      if (!isDbReady(db)) {
        const rows = memListProposals(status).slice(0, limit).map((p) => {
          const out = { ...p };
          if (includeContent) {
            const c = memGetLatestContentByProposal(p.id);
            out.latestContent = c
              ? {
                  id: c.id,
                  status: c.status,
                  updated_at: c.updated_at || c.created_at || null,
                  last_feedback: c.last_feedback || null,
                  ...(includePack ? { content_pack: deepFix(c.content_pack) } : {}),
                }
              : null;
          }
          return out;
        });

        return okJson(res, { ok: true, status, proposals: rows, dbDisabled: true });
      }

      // =============== DB ===============
      // LATERAL join: pick latest content_item per proposal
      const q = await db.query(
        `
        select
          p.id, p.thread_id, p.agent, p.type, p.status, p.title, p.payload,
          p.created_at, p.decided_at, p.decision_by,
          ${
            includeContent
              ? `
          c.id as content_id,
          c.status as content_status,
          c.updated_at as content_updated_at,
          c.last_feedback as content_last_feedback,
          ${includePack ? "c.content_pack as content_pack," : ""}
          `
              : ""
          }
          1 as _dummy
        from proposals p
        ${
          includeContent
            ? `
        left join lateral (
          select id, status, content_pack, last_feedback, updated_at, created_at
          from content_items
          where proposal_id = p.id
          order by updated_at desc nulls last, created_at desc
          limit 1
        ) c on true
        `
            : ""
        }
        where p.status = $1::text
        order by p.created_at desc
        limit ${Number(limit)}
        `,
        [status]
      );

      const rows = (q.rows || []).map((row) => {
        const p = {
          id: row.id,
          thread_id: row.thread_id,
          agent: row.agent,
          type: row.type,
          status: row.status,
          title: fixText(row.title),
          payload: deepFix(row.payload),
          created_at: row.created_at,
          decided_at: row.decided_at,
          decision_by: row.decision_by,
        };

        if (includeContent) {
          p.latestContent = row.content_id
            ? {
                id: row.content_id,
                status: row.content_status,
                updated_at: row.content_updated_at,
                last_feedback: row.content_last_feedback || null,
                ...(includePack ? { content_pack: deepFix(row.content_pack) } : {}),
              }
            : null;
        }

        return p;
      });

      return okJson(res, { ok: true, status, proposals: rows });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/proposals/:id/decision  { decision:"approved"|"rejected", by?, reason?, tenantId? }
  // IMPORTANT FLOW:
  // - approved => proposal.status becomes in_progress (Drafting) + job + notify n8n proposal.approved
  // - rejected => proposal.status becomes rejected
  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = normalizeDecision(req.body?.decision);
    const by = fixText(String(req.body?.by || "ceo").trim()) || "ceo";
    const reason = fixText(String(req.body?.reason || "").trim());
    const tenantId = fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";

    if (!id) return okJson(res, { ok: false, error: "proposalId required" });
    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, { ok: false, error: "decision must be approved|rejected" });
    }

    try {
      // ================= MEMORY =================
      if (!isDbReady(db)) {
        const p = mem.proposals.get(id);
        if (!p) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        if (decision === "rejected") {
          p.status = "rejected";
          p.decision_by = by;
          p.decided_at = new Date().toISOString();

          const notif = memCreateNotification({
            recipient: "ceo",
            type: "info",
            title: "Proposal rejected",
            body: reason || safeTitle(p),
            payload: { proposalId: p.id, decision, reason },
          });

          wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          wsHub?.broadcast?.({ type: "notification.created", notification: notif });
          memAudit(by, "proposal.reject", "proposal", p.id, { reason });

          return okJson(res, { ok: true, proposal: p, dbDisabled: true });
        }

        // APPROVE => in_progress + job + notify n8n
        p.status = "in_progress";
        p.decision_by = by;
        p.decided_at = new Date().toISOString();

        const job = memCreateJob({
          proposalId: p.id,
          type: "draft.generate",
          status: "queued",
          input: { proposalId: p.id, threadId: p.thread_id, title: safeTitle(p), payload: p.payload },
        });

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Drafting started",
          body: "n8n draft hazırlayır…",
          payload: { proposalId: p.id, jobId: job.id },
        });

        wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
        wsHub?.broadcast?.({ type: "execution.updated", execution: job });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(by, "proposal.approve", "proposal", p.id, { reason });

        notifyN8n("proposal.approved", p, {
          tenantId,
          proposalId: p.id,
          threadId: p.thread_id,
          jobId: job.id,
          reason,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        });

        return okJson(res, { ok: true, proposal: p, jobId: job.id, dbDisabled: true });
      }

      // ================= DB =================
      const proposal = await dbGetProposalById(db, id);
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found" });

      // reject
      if (decision === "rejected") {
        const updated = await db.query(
          `update proposals
           set status = 'rejected',
               decided_at = now(),
               decision_by = $2::text,
               payload = (coalesce(payload,'{}'::jsonb) || $3::jsonb)
           where id::text = $1::text
           returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
          [id, by, deepFix({ decision: "rejected", reason })]
        );

        const p2 = updated.rows?.[0] || null;
        if (!p2) return okJson(res, { ok: false, error: "update failed" });

        p2.title = fixText(p2.title);
        p2.payload = deepFix(p2.payload);

        const notif = await dbCreateNotification(db, {
          recipient: "ceo",
          type: "info",
          title: "Proposal rejected",
          body: reason || safeTitle(p2),
          payload: { proposalId: p2.id, decision: "rejected", reason },
        });

        wsHub?.broadcast?.({ type: "proposal.updated", proposal: p2 });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        await pushBroadcastToCeo({
          db,
          title: "Rejected",
          body: safeTitle(p2) || "Proposal rejected",
          data: { type: "proposal.rejected", proposalId: p2.id },
        });

        await dbAudit(db, by, "proposal.reject", "proposal", String(p2.id), { reason });

        notifyN8n("proposal.rejected", p2, { tenantId, proposalId: String(p2.id), reason });

        return okJson(res, { ok: true, proposal: p2 });
      }

      // approve => in_progress (Drafting)
      const updatedQ = await db.query(
        `update proposals
         set status = 'in_progress',
             decided_at = now(),
             decision_by = $2::text,
             payload = (coalesce(payload,'{}'::jsonb) || $3::jsonb)
         where id::text = $1::text
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [id, by, deepFix({ decision: "approved", reason })]
      );

      const p2 = updatedQ.rows?.[0] || null;
      if (!p2) return okJson(res, { ok: false, error: "update failed" });

      p2.title = fixText(p2.title);
      p2.payload = deepFix(p2.payload);

      const job = await dbCreateJob(db, {
        proposalId: p2.id,
        type: "draft.generate",
        status: "queued",
        input: { proposalId: p2.id, threadId: p2.thread_id, title: safeTitle(p2), payload: p2.payload },
      });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Drafting started",
        body: "n8n draft hazırlayır…",
        payload: { proposalId: p2.id, jobId: job?.id || null },
      });

      wsHub?.broadcast?.({ type: "proposal.updated", proposal: p2 });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Drafting başladı",
        body: safeTitle(p2) || "Draft hazırlanır…",
        data: { type: "proposal.in_progress", proposalId: p2.id, jobId: job?.id || null },
      });

      await dbAudit(db, by, "proposal.approve", "proposal", String(p2.id), { reason });

      notifyN8n("proposal.approved", p2, {
        tenantId,
        proposalId: String(p2.id),
        threadId: String(p2.thread_id),
        jobId: job?.id || null,
        reason,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
      });

      return okJson(res, { ok: true, proposal: p2, jobId: job?.id || null });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/proposals/:id/request-changes  { feedbackText }
  // convenience: returns latest contentId for proposal (frontend will call /content/:id/feedback)
  r.post("/proposals/:id/request-changes", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();
    const feedbackText = fixText(String(req.body?.feedbackText || "").trim());

    if (!proposalId) return okJson(res, { ok: false, error: "proposalId required" });
    if (!feedbackText) return okJson(res, { ok: false, error: "feedbackText required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposalId must be uuid" });

    try {
      if (!isDbReady(db)) {
        const content = memGetLatestContentByProposal(proposalId);
        if (!content) return okJson(res, { ok: false, error: "no content for proposal", dbDisabled: true });
        return okJson(res, { ok: true, contentId: content.id, dbDisabled: true });
      }

      const content = await dbGetLatestDraftLikeByProposal(db, proposalId);
      if (!content) return okJson(res, { ok: false, error: "no content for proposal" });

      return okJson(res, { ok: true, contentId: content.id });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/proposals/:id/publish
  // convenience: returns latest approved draft contentId for proposal
  r.post("/proposals/:id/publish", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();
    if (!proposalId) return okJson(res, { ok: false, error: "proposalId required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposalId must be uuid" });

    try {
      if (!isDbReady(db)) {
        const c = memGetLatestContentByProposal(proposalId);
        if (!c) return okJson(res, { ok: false, error: "no content for proposal", dbDisabled: true });
        return okJson(res, { ok: true, contentId: c.id, dbDisabled: true });
      }

      const c = await dbGetLatestApprovedDraftByProposal(db, proposalId);
      if (!c) return okJson(res, { ok: false, error: "no draft.approved content found" });

      return okJson(res, { ok: true, contentId: c.id });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}