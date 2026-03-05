// src/routes/api/content.js (FINAL — Draft review loop + publish bridge)
//
// Endpoints:
// - GET  /api/content?proposalId=uuid
// - POST /api/content/:id/feedback { feedbackText, tenantId? }   -> draft.regenerating + job + n8n content.revise
// - POST /api/content/:id/approve  { tenantId? }                -> draft.approved + proposal=approved
// - POST /api/content/:id/publish  { tenantId? }                -> publish.requested + job + n8n content.publish
//
// Notes:
// - "Reject" stays in proposals route (next file).
// - This file ensures n8n gets consistent payloads + UI always has content_items row.

import express from "express";
import crypto from "crypto";
import { cfg } from "../../config.js";

import { okJson, isDbReady, isUuid, nowIso } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";

import {
  mem,
  memGetLatestContentByProposal,
  memPatchContentItem,
  memCreateNotification,
  memAudit,
} from "../../utils/memStore.js";

import {
  dbGetLatestContentByProposal,
  dbUpdateContentItem,
} from "../../db/helpers/content.js";

import { dbGetProposalById, dbSetProposalStatus } from "../../db/helpers/proposals.js";
import { dbCreateJob } from "../../db/helpers/jobs.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";

function normalizeContentPack(x) {
  if (!x) return null;
  if (typeof x === "string") {
    try {
      const o = JSON.parse(x);
      return typeof o === "object" && o ? deepFix(o) : null;
    } catch {
      return null;
    }
  }
  if (typeof x === "object") return deepFix(x);
  return null;
}

function pickTenantId(req) {
  return (
    fixText(String(req.body?.tenantId || req.query?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) ||
    "default"
  );
}

export function contentRoutes({ db, wsHub }) {
  const r = express.Router();

  // GET /api/content?proposalId=...
  r.get("/content", async (req, res) => {
    const proposalId = String(req.query.proposalId || "").trim();
    if (!proposalId) return okJson(res, { ok: false, error: "proposalId required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposalId must be uuid" });

    try {
      if (!isDbReady(db)) {
        const row = memGetLatestContentByProposal(proposalId);
        return okJson(res, { ok: true, proposalId, content: row, dbDisabled: true });
      }

      const row = await dbGetLatestContentByProposal(db, proposalId);
      return okJson(res, { ok: true, proposalId, content: row });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  // POST /api/content/:id/feedback  { feedbackText, tenantId? }
  // sets content.status=draft.regenerating and notifies n8n "content.revise"
  r.post("/content/:id/feedback", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantId = pickTenantId(req);
    const feedbackText = fixText(String(req.body?.feedbackText || req.body?.feedback || "").trim());

    if (!id) return okJson(res, { ok: false, error: "contentId required" });
    if (!feedbackText) return okJson(res, { ok: false, error: "feedbackText required" });

    try {
      if (!isDbReady(db)) {
        const row = memPatchContentItem(id, { last_feedback: feedbackText, status: "draft.regenerating" });
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Changes requested",
          body: "Draft yenidən hazırlanır…",
          payload: { contentId: id, proposalId: row.proposal_id },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: row });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.feedback", "content", id, { proposalId: row.proposal_id });

        // (Optional) if you want mem-mode to also hit n8n, you can enable it later.
        return okJson(res, { ok: true, content: row, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const updated = await dbUpdateContentItem(db, id, {
        status: "draft.regenerating",
        last_feedback: feedbackText,
      });
      if (!updated) return okJson(res, { ok: false, error: "content not found" });

      const proposal = await dbGetProposalById(db, String(updated.proposal_id));
      if (proposal) {
        // create job for revision
        const job = await dbCreateJob(db, {
          proposalId: proposal.id,
          type: "draft.regen",
          status: "queued",
          input: { contentId: updated.id, feedbackText },
        });

        await dbUpdateContentItem(db, updated.id, { job_id: job?.id || updated.job_id });

        notifyN8n("content.revise", proposal, {
          tenantId,
          proposalId: String(proposal.id),
          threadId: String(proposal.thread_id),
          jobId: job?.id || null,
          contentId: String(updated.id),
          feedbackText,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      }

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Changes requested",
        body: "Draft yenidən hazırlanır…",
        payload: { contentId: id, proposalId: updated.proposal_id },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft yenilənir",
        body: "Rəy göndərildi — n8n draftı yenidən hazırlayır.",
        data: { type: "draft.regen", contentId: id, proposalId: updated.proposal_id },
      });

      await dbAudit(db, "ceo", "content.feedback", "content", id, { proposalId: updated.proposal_id });

      return okJson(res, { ok: true, content: updated });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/content/:id/approve
  // sets content.status=draft.approved and proposal.status=approved
  r.post("/content/:id/approve", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        memPatchContentItem(id, { status: "draft.approved" });

        const p = mem.proposals.get(row.proposal_id);
        if (p) p.status = "approved";

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "success",
          title: "Draft approved",
          body: "İndi Publish edə bilərsən.",
          payload: { contentId: id, proposalId: row.proposal_id },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) });
        wsHub?.broadcast?.({ type: "proposal.updated", proposal: p || null });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.approve", "content", id, { proposalId: row.proposal_id });

        return okJson(res, { ok: true, content: mem.contentItems.get(id), proposal: p || null, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const updated = await dbUpdateContentItem(db, id, { status: "draft.approved" });
      if (!updated) return okJson(res, { ok: false, error: "content not found" });

      const proposal = await dbSetProposalStatus(db, String(updated.proposal_id), "approved", {});
      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "success",
        title: "Draft approved",
        body: "İndi Publish edə bilərsən.",
        payload: { contentId: id, proposalId: updated.proposal_id },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      if (proposal) wsHub?.broadcast?.({ type: "proposal.updated", proposal });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft təsdiqləndi",
        body: "Publish etməyə hazırdır.",
        data: { type: "draft.approved", contentId: id, proposalId: updated.proposal_id },
      });

      await dbAudit(db, "ceo", "content.approve", "content", id, { proposalId: updated.proposal_id });

      return okJson(res, { ok: true, content: updated, proposal });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/content/:id/publish
  // requires content.status=draft.approved, creates job, notifies n8n "content.publish"
  r.post("/content/:id/publish", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantId = pickTenantId(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        if (String(row.status) !== "draft.approved") {
          return okJson(res, {
            ok: false,
            error: "content must be draft.approved before publish",
            status: row.status,
            dbDisabled: true,
          });
        }

        // create job (mem)
        const jobId = crypto.randomUUID();
        const contentPack = normalizeContentPack(row.content_pack);

        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: "publish",
          status: "queued",
          input: { contentId: id, contentPack },
          output: {},
          error: null,
          created_at: nowIso(),
          started_at: null,
          finished_at: null,
        });

        // ✅ ALSO notify n8n in mem-mode (so local tests can publish too)
        const p = mem.proposals.get(row.proposal_id) || null;
        if (p) {
          notifyN8n("content.publish", p, {
            tenantId,
            proposalId: String(p.id),
            threadId: String(p.thread_id || p.threadId || ""),
            jobId,
            contentId: String(id),
            contentPack,
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          });
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Publish started",
          body: "n8n paylaşımı edir…",
          payload: { contentId: id, proposalId: row.proposal_id, jobId },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.publish", "content", id, { proposalId: row.proposal_id, jobId });

        return okJson(res, { ok: true, jobId, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      // fetch row (noop update)
      const row = await dbUpdateContentItem(db, id, {});
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      if (String(row.status) !== "draft.approved") {
        return okJson(res, { ok: false, error: "content must be draft.approved before publish", status: row.status });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found for content" });

      const contentPack = normalizeContentPack(row.content_pack);

      const job = await dbCreateJob(db, {
        proposalId: proposal.id,
        type: "publish",
        status: "queued",
        input: { contentId: row.id, contentPack },
      });

      await dbUpdateContentItem(db, row.id, { status: "publish.requested", job_id: job?.id || row.job_id });

      notifyN8n("content.publish", proposal, {
        tenantId,
        proposalId: String(proposal.id),
        threadId: String(proposal.thread_id),
        jobId: job?.id || null,
        contentId: String(row.id),
        contentPack,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
      });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Publish started",
        body: "n8n paylaşımı edir…",
        payload: { contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Publish başladı",
        body: "Instagram paylaşımı hazırlanır…",
        data: { type: "publish.requested", contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      await dbAudit(db, "ceo", "content.publish", "content", row.id, { proposalId: proposal.id, jobId: job?.id || null });

      return okJson(res, { ok: true, jobId: job?.id || null, contentId: row.id });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}