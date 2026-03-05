// src/routes/api/content.js (FINAL v2 — Draft -> Asset Generate -> Publish)
//
// Endpoints:
// - GET  /api/content?proposalId=uuid
// - POST /api/content/:id/feedback { feedbackText, tenantId? }
//      -> draft.regenerating + job + n8n content.revise
// - POST /api/content/:id/approve  { tenantId? }
//      -> asset.requested + job + n8n content.assets.generate
//      (NOTE: does NOT set proposal=approved anymore)
// - POST /api/content/:id/publish  { tenantId? }
//      -> publish.requested + job + n8n content.publish
//
// Notes:
// - Proposal moves to "approved" ONLY after assets are ready (callback side).
// - Reject stays in proposals route.

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

import { dbGetLatestContentByProposal, dbUpdateContentItem } from "../../db/helpers/content.js";
import { dbGetProposalById } from "../../db/helpers/proposals.js";
import { dbCreateJob } from "../../db/helpers/jobs.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";

/** ---------------- helpers ---------------- */
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

function packType(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(pack.post_type || pack.postType || pack.format || pack.type || "").toLowerCase();
}

function pickFirstAssetUrl(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return null;

  // prefer explicit
  const direct =
    contentPack.imageUrl ||
    contentPack.image_url ||
    contentPack.videoUrl ||
    contentPack.video_url ||
    contentPack.coverUrl ||
    contentPack.cover_url ||
    null;
  if (direct) return String(direct);

  // assets array
  const a = Array.isArray(contentPack.assets) ? contentPack.assets : [];
  const first = a[0] || null;
  if (!first) return null;

  const u = first.url || first.secure_url || first.publicUrl || null;
  return u ? String(u) : null;
}

function buildCaption(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return "";
  const captionText = fixText(String(contentPack.caption || contentPack.text || "").trim());
  const hashtagsText = fixText(String(contentPack.hashtags || "").trim());
  return [captionText, hashtagsText].filter(Boolean).join("\n\n");
}

function statusLc(x) {
  return String(x || "").trim().toLowerCase();
}

function isDraftReadyStatus(s) {
  const v = statusLc(s);
  return v === "draft.ready" || v === "draft" || v.startsWith("draft.");
}

function isAssetReadyStatus(s) {
  const v = statusLc(s);
  return v === "asset.ready" || v === "assets.ready" || v === "publish.ready";
}

function isPublishRequestedStatus(s) {
  const v = statusLc(s);
  return v === "publish.requested" || v === "publish.queued" || v === "publish.running";
}

/** ---------------- routes ---------------- */
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
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/content/:id/feedback  { feedbackText, tenantId? }
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

  // POST /api/content/:id/approve  -> starts ASSET generation (NOT proposal approved)
  r.post("/content/:id/approve", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantId = pickTenantId(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      // ========== MEMORY ==========
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const st = statusLc(row.status);
        if (isPublishRequestedStatus(st)) {
          return okJson(res, { ok: false, error: "publish already requested", status: row.status, dbDisabled: true });
        }

        // allow approve when draft is ready; if asset already ready, do nothing
        if (isAssetReadyStatus(st)) {
          return okJson(res, { ok: true, content: row, note: "asset already ready", dbDisabled: true });
        }
        if (!isDraftReadyStatus(st)) {
          return okJson(res, { ok: false, error: "content must be draft.ready before approve", status: row.status, dbDisabled: true });
        }

        const jobId = crypto.randomUUID();
        const contentPack = normalizeContentPack(row.content_pack) || {};

        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: "asset.generate",
          status: "queued",
          input: { contentId: id, contentPack, postType: packType(contentPack) },
          output: {},
          error: null,
          created_at: nowIso(),
          started_at: null,
          finished_at: null,
        });

        const updated = memPatchContentItem(id, {
          status: "asset.requested",
          job_id: jobId,
        });

        const p = mem.proposals.get(row.proposal_id) || null;
        if (p) {
          notifyN8n("content.assets.generate", p, {
            tenantId,
            proposalId: String(p.id),
            threadId: String(p.thread_id || p.threadId || ""),
            jobId,
            contentId: String(id),
            postType: packType(contentPack),
            contentPack,
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          });
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Assets generating",
          body: "Şəkil/video/karusel hazırlanır…",
          payload: { contentId: id, proposalId: row.proposal_id, jobId },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: updated });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.approve.assets", "content", id, { proposalId: row.proposal_id, jobId });

        return okJson(res, { ok: true, content: updated, jobId, dbDisabled: true });
      }

      // ========== DB ==========
      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbUpdateContentItem(db, id, {});
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const st = statusLc(row.status);
      if (isPublishRequestedStatus(st)) {
        return okJson(res, { ok: false, error: "publish already requested", status: row.status });
      }
      if (isAssetReadyStatus(st)) {
        return okJson(res, { ok: true, content: row, note: "asset already ready" });
      }
      if (!isDraftReadyStatus(st)) {
        return okJson(res, { ok: false, error: "content must be draft.ready before approve", status: row.status });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found for content" });

      const contentPack = normalizeContentPack(row.content_pack) || {};
      const job = await dbCreateJob(db, {
        proposalId: proposal.id,
        type: "asset.generate",
        status: "queued",
        input: { contentId: row.id, contentPack, postType: packType(contentPack) },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "asset.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n("content.assets.generate", proposal, {
        tenantId,
        proposalId: String(proposal.id),
        threadId: String(proposal.thread_id),
        jobId: job?.id || null,
        contentId: String(row.id),
        postType: packType(contentPack),
        contentPack,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
      });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Assets generating",
        body: "Şəkil/video/karusel hazırlanır…",
        payload: { contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Asset hazırlanır",
        body: "Approve edildi — vizual hazırlanır (n8n).",
        data: { type: "asset.requested", contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      await dbAudit(db, "ceo", "content.approve.assets", "content", row.id, { proposalId: proposal.id, jobId: job?.id || null });

      return okJson(res, { ok: true, content: updated, jobId: job?.id || null });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/content/:id/publish  -> requires ASSET ready
  r.post("/content/:id/publish", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantId = pickTenantId(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const st = statusLc(row.status);
        if (!isAssetReadyStatus(st)) {
          return okJson(res, {
            ok: false,
            error: "content must be asset.ready before publish",
            status: row.status,
            dbDisabled: true,
          });
        }

        const jobId = crypto.randomUUID();
        const contentPack = normalizeContentPack(row.content_pack) || {};
        const assetUrl = pickFirstAssetUrl(contentPack);
        const caption = buildCaption(contentPack);

        if (!assetUrl) {
          return okJson(res, { ok: false, error: "publish requires assetUrl (missing assets/url)", dbDisabled: true });
        }

        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: "publish",
          status: "queued",
          input: { contentId: id, contentPack, assetUrl, caption },
          output: {},
          error: null,
          created_at: nowIso(),
          started_at: null,
          finished_at: null,
        });

        memPatchContentItem(id, { status: "publish.requested", job_id: jobId });

        const p = mem.proposals.get(row.proposal_id) || null;
        if (p) {
          notifyN8n("content.publish", p, {
            tenantId,
            proposalId: String(p.id),
            threadId: String(p.thread_id || p.threadId || ""),
            jobId,
            contentId: String(id),
            assetUrl,
            caption,
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

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.publish", "content", id, { proposalId: row.proposal_id, jobId });

        return okJson(res, { ok: true, jobId, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbUpdateContentItem(db, id, {});
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const st = statusLc(row.status);
      if (!isAssetReadyStatus(st)) {
        return okJson(res, { ok: false, error: "content must be asset.ready before publish", status: row.status });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found for content" });

      const contentPack = normalizeContentPack(row.content_pack) || {};
      const assetUrl = pickFirstAssetUrl(contentPack);
      const caption = buildCaption(contentPack);

      if (!assetUrl) {
        return okJson(res, { ok: false, error: "publish requires assetUrl (missing assets/url)" });
      }

      const job = await dbCreateJob(db, {
        proposalId: proposal.id,
        type: "publish",
        status: "queued",
        input: { contentId: row.id, contentPack, assetUrl, caption },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "publish.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n("content.publish", proposal, {
        tenantId,
        proposalId: String(proposal.id),
        threadId: String(proposal.thread_id),
        jobId: job?.id || null,
        contentId: String(row.id),
        assetUrl,
        caption,
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

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Publish başladı",
        body: "Instagram paylaşımı hazırlanır…",
        data: { type: "publish.requested", contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      await dbAudit(db, "ceo", "content.publish", "content", row.id, {
        proposalId: proposal.id,
        jobId: job?.id || null,
      });

      return okJson(res, { ok: true, jobId: job?.id || null, contentId: row.id });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}