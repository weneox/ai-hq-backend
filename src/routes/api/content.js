// src/routes/api/content.js
// FINAL v3.0 — Draft -> Asset/Video Generate -> Publish
//
// Endpoints:
// - GET  /api/content?proposalId=uuid
// - POST /api/content/:id/feedback { feedbackText, tenantId? }
//      -> draft.regenerating + job + n8n content.revise
// - POST /api/content/:id/approve  { tenantId? }
//      -> asset.requested + job + n8n content.assets.generate OR content.video.generate
//      (NOTE: does NOT set proposal=approved anymore)
// - POST /api/content/:id/publish  { tenantId? }
//      -> publish.requested + job + n8n content.publish
//
// Notes:
// - Proposal moves to "approved" ONLY after assets/video are ready (callback side).
// - Reject stays in proposals route.
// - Reel/video flows are routed through content.video.generate.

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

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function asArr(x) {
  return Array.isArray(x) ? x : [];
}

function safeLower(x) {
  return String(x || "").trim().toLowerCase();
}

function packType(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(
    pack.post_type ||
      pack.postType ||
      pack.format ||
      pack.type ||
      ""
  ).toLowerCase();
}

function pickAspectRatio(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(
    pack.aspectRatio ||
      pack.aspect_ratio ||
      pack?.visualPlan?.aspectRatio ||
      ""
  ).trim();
}

function pickVisualPreset(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(
    pack?.visualPlan?.visualPreset ||
      pack?.visualPreset ||
      ""
  ).trim();
}

function pickImagePrompt(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(
    String(pack.imagePrompt || pack?.assetBrief?.imagePrompt || "").trim()
  );
}

function pickVideoPrompt(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(
    String(pack.videoPrompt || pack?.assetBrief?.videoPrompt || "").trim()
  );
}

function pickVoiceoverText(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(
    String(pack.voiceoverText || pack?.assetBrief?.voiceoverText || "").trim()
  );
}

function pickNeededAssets(pack) {
  if (!pack || typeof pack !== "object") return [];
  const a = pack.neededAssets || pack?.assetBrief?.neededAssets || [];
  return Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
}

function pickReelMeta(pack) {
  if (!pack || typeof pack !== "object") return null;
  const rm = asObj(pack.reelMeta);
  return Object.keys(rm).length ? deepFix(rm) : null;
}

function isReelPack(contentPack) {
  return packType(contentPack) === "reel";
}

function pickAssetGenerationEvent(contentPack) {
  return isReelPack(contentPack) ? "content.video.generate" : "content.assets.generate";
}

function pickAssetGenerationJobType(contentPack) {
  return isReelPack(contentPack) ? "video.generate" : "asset.generate";
}

function pickFirstAssetUrl(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return null;

  const direct =
    contentPack.videoUrl ||
    contentPack.video_url ||
    contentPack.imageUrl ||
    contentPack.image_url ||
    contentPack.coverUrl ||
    contentPack.cover_url ||
    contentPack.thumbnailUrl ||
    contentPack.thumbnail_url ||
    null;

  if (direct) return String(direct);

  const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
  if (!assets.length) return null;

  const preferredVideo = assets.find((a) => {
    const kind = safeLower(a?.kind || a?.type || a?.mime || "");
    return kind.includes("video");
  });

  const preferredImage = assets.find((a) => {
    const kind = safeLower(a?.kind || a?.type || a?.mime || "");
    const role = safeLower(a?.role || "");
    return kind.includes("image") || role === "thumbnail" || role === "cover";
  });

  const chosen = preferredVideo || preferredImage || assets[0] || null;
  if (!chosen) return null;

  const u = chosen.url || chosen.secure_url || chosen.publicUrl || chosen.public_url || null;
  return u ? String(u) : null;
}

function pickThumbnailUrl(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return null;

  const direct =
    contentPack.thumbnailUrl ||
    contentPack.thumbnail_url ||
    contentPack.coverUrl ||
    contentPack.cover_url ||
    null;

  if (direct) return String(direct);

  const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
  const chosen =
    assets.find((a) => safeLower(a?.role || "") === "thumbnail") ||
    assets.find((a) => safeLower(a?.role || "") === "cover") ||
    assets.find((a) => safeLower(a?.kind || a?.type || "") === "image") ||
    null;

  const u = chosen?.url || chosen?.secure_url || chosen?.publicUrl || null;
  return u ? String(u) : null;
}

function normalizeHashtagsValue(v) {
  if (!v) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(" ");
  if (typeof v === "string") return fixText(v.trim());
  try {
    return fixText(JSON.stringify(v));
  } catch {
    return "";
  }
}

function buildCaption(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return "";

  const captionText = fixText(String(contentPack.caption || contentPack.text || "").trim());
  const hashtagsText = normalizeHashtagsValue(contentPack.hashtags);

  return [captionText, hashtagsText].filter(Boolean).join("\n\n");
}

function statusLc(x) {
  return String(x || "").trim().toLowerCase();
}

function isDraftReadyStatus(s) {
  const v = statusLc(s);
  return (
    v === "draft.ready" ||
    v === "draft" ||
    v === "in_progress" ||
    v.startsWith("draft.")
  );
}

function isAssetReadyStatus(s) {
  const v = statusLc(s);
  return v === "asset.ready" || v === "assets.ready" || v === "publish.ready";
}

function isPublishRequestedStatus(s) {
  const v = statusLc(s);
  return v === "publish.requested" || v === "publish.queued" || v === "publish.running";
}

async function dbGetContentById(db, id) {
  if (!isUuid(id)) return null;
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, content_pack, publish, last_feedback, created_at, updated_at
     from content_items
     where id = $1::uuid
     limit 1`,
    [id]
  );
  return q.rows?.[0] || null;
}

function buildAssetNotifyExtra({
  tenantId,
  proposal,
  row,
  jobId,
  contentPack,
}) {
  return deepFix({
    tenantId,
    proposalId: String(proposal?.id || row?.proposal_id || ""),
    threadId: String(proposal?.thread_id || row?.thread_id || ""),
    jobId: jobId || null,
    contentId: String(row?.id || ""),
    postType: packType(contentPack),
    format: packType(contentPack),
    aspectRatio: pickAspectRatio(contentPack),
    visualPreset: pickVisualPreset(contentPack),
    imagePrompt: pickImagePrompt(contentPack),
    videoPrompt: pickVideoPrompt(contentPack),
    voiceoverText: pickVoiceoverText(contentPack),
    neededAssets: pickNeededAssets(contentPack),
    reelMeta: pickReelMeta(contentPack),
    contentPack,
    callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
  });
}

function buildPublishNotifyExtra({
  tenantId,
  proposal,
  row,
  jobId,
  contentPack,
  assetUrl,
  caption,
}) {
  return deepFix({
    tenantId,
    proposalId: String(proposal?.id || row?.proposal_id || ""),
    threadId: String(proposal?.thread_id || row?.thread_id || ""),
    jobId: jobId || null,
    contentId: String(row?.id || ""),
    postType: packType(contentPack),
    format: packType(contentPack),
    aspectRatio: pickAspectRatio(contentPack),
    visualPreset: pickVisualPreset(contentPack),
    assetUrl,
    thumbnailUrl: pickThumbnailUrl(contentPack),
    caption,
    contentPack,
    callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
  });
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

  // POST /api/content/:id/feedback
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

        const proposal = mem.proposals.get(row.proposal_id) || null;

        const jobId = crypto.randomUUID();
        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: "draft.regen",
          status: "queued",
          input: {
            contentId: row.id,
            proposalId: row.proposal_id,
            feedbackText,
            tenantId,
          },
          output: {},
          error: null,
          created_at: nowIso(),
          started_at: null,
          finished_at: null,
        });

        memPatchContentItem(id, { job_id: jobId });

        if (proposal) {
          notifyN8n("content.revise", proposal, {
            tenantId,
            proposalId: String(proposal.id),
            threadId: String(proposal.thread_id || proposal.threadId || ""),
            jobId,
            contentId: String(row.id),
            feedbackText,
            contentPack: normalizeContentPack(row.content_pack) || {},
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          });
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Changes requested",
          body: "Draft yenidən hazırlanır…",
          payload: { contentId: id, proposalId: row.proposal_id, jobId },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) || row });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.feedback", "content", id, { proposalId: row.proposal_id, jobId });

        return okJson(res, { ok: true, content: mem.contentItems.get(id) || row, jobId, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const current = await dbGetContentById(db, id);
      if (!current) return okJson(res, { ok: false, error: "content not found" });

      const updated = await dbUpdateContentItem(db, id, {
        status: "draft.regenerating",
        last_feedback: feedbackText,
      });

      const proposal = await dbGetProposalById(db, String(current.proposal_id));
      let job = null;

      if (proposal) {
        job = await dbCreateJob(db, {
          proposalId: proposal.id,
          type: "draft.regen",
          status: "queued",
          input: {
            contentId: updated.id,
            proposalId: proposal.id,
            feedbackText,
            tenantId,
          },
        });

        await dbUpdateContentItem(db, updated.id, { job_id: job?.id || updated.job_id });

        notifyN8n("content.revise", proposal, {
          tenantId,
          proposalId: String(proposal.id),
          threadId: String(proposal.thread_id),
          jobId: job?.id || null,
          contentId: String(updated.id),
          feedbackText,
          contentPack: normalizeContentPack(updated.content_pack) || {},
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      }

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Changes requested",
        body: "Draft yenidən hazırlanır…",
        payload: { contentId: id, proposalId: updated.proposal_id, jobId: job?.id || null },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: await dbGetContentById(db, updated.id) });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft yenilənir",
        body: "Rəy göndərildi — n8n draftı yenidən hazırlayır.",
        data: { type: "draft.regen", contentId: id, proposalId: updated.proposal_id, jobId: job?.id || null },
      });

      await dbAudit(db, "ceo", "content.feedback", "content", id, { proposalId: updated.proposal_id, jobId: job?.id || null });

      return okJson(res, { ok: true, content: await dbGetContentById(db, updated.id), jobId: job?.id || null });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/content/:id/approve  -> starts ASSET/VIDEO generation (NOT proposal approved)
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

        if (isAssetReadyStatus(st)) {
          return okJson(res, { ok: true, content: row, note: "asset already ready", dbDisabled: true });
        }

        if (!isDraftReadyStatus(st)) {
          return okJson(res, {
            ok: false,
            error: "content must be draft.ready before approve",
            status: row.status,
            dbDisabled: true,
          });
        }

        const contentPack = normalizeContentPack(row.content_pack) || {};
        const eventName = pickAssetGenerationEvent(contentPack);
        const jobType = pickAssetGenerationJobType(contentPack);
        const jobId = crypto.randomUUID();

        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: jobType,
          status: "queued",
          input: {
            contentId: id,
            contentPack,
            postType: packType(contentPack),
            format: packType(contentPack),
            aspectRatio: pickAspectRatio(contentPack),
            visualPreset: pickVisualPreset(contentPack),
            imagePrompt: pickImagePrompt(contentPack),
            videoPrompt: pickVideoPrompt(contentPack),
            voiceoverText: pickVoiceoverText(contentPack),
            neededAssets: pickNeededAssets(contentPack),
            reelMeta: pickReelMeta(contentPack),
          },
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
          notifyN8n(eventName, p, buildAssetNotifyExtra({
            tenantId,
            proposal: p,
            row: updated || row,
            jobId,
            contentPack,
          }));
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: isReelPack(contentPack) ? "Video generating" : "Assets generating",
          body: isReelPack(contentPack) ? "Reel/video hazırlanır…" : "Şəkil/video/karusel hazırlanır…",
          payload: { contentId: id, proposalId: row.proposal_id, jobId, jobType },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: updated });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("ceo", "content.approve.assets", "content", id, { proposalId: row.proposal_id, jobId, jobType });

        return okJson(res, { ok: true, content: updated, jobId, jobType, dbDisabled: true });
      }

      // ========== DB ==========
      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbGetContentById(db, id);
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const st = statusLc(row.status);

      if (isPublishRequestedStatus(st)) {
        return okJson(res, { ok: false, error: "publish already requested", status: row.status });
      }

      if (isAssetReadyStatus(st)) {
        return okJson(res, { ok: true, content: row, note: "asset already ready" });
      }

      if (!isDraftReadyStatus(st)) {
        return okJson(res, {
          ok: false,
          error: "content must be draft.ready before approve",
          status: row.status,
        });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found for content" });

      const contentPack = normalizeContentPack(row.content_pack) || {};
      const eventName = pickAssetGenerationEvent(contentPack);
      const jobType = pickAssetGenerationJobType(contentPack);

      const job = await dbCreateJob(db, {
        proposalId: proposal.id,
        type: jobType,
        status: "queued",
        input: {
          contentId: row.id,
          contentPack,
          postType: packType(contentPack),
          format: packType(contentPack),
          aspectRatio: pickAspectRatio(contentPack),
          visualPreset: pickVisualPreset(contentPack),
          imagePrompt: pickImagePrompt(contentPack),
          videoPrompt: pickVideoPrompt(contentPack),
          voiceoverText: pickVoiceoverText(contentPack),
          neededAssets: pickNeededAssets(contentPack),
          reelMeta: pickReelMeta(contentPack),
        },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "asset.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n(eventName, proposal, buildAssetNotifyExtra({
        tenantId,
        proposal,
        row: updated || row,
        jobId: job?.id || null,
        contentPack,
      }));

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: isReelPack(contentPack) ? "Video generating" : "Assets generating",
        body: isReelPack(contentPack) ? "Reel/video hazırlanır…" : "Şəkil/video/karusel hazırlanır…",
        payload: { contentId: row.id, proposalId: proposal.id, jobId: job?.id || null, jobType },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: await dbGetContentById(db, row.id) });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: isReelPack(contentPack) ? "Video hazırlanır" : "Asset hazırlanır",
        body: isReelPack(contentPack)
          ? "Approve edildi — reel/video hazırlanır."
          : "Approve edildi — vizual hazırlanır.",
        data: { type: "asset.requested", contentId: row.id, proposalId: proposal.id, jobId: job?.id || null, jobType },
      });

      await dbAudit(db, "ceo", "content.approve.assets", "content", row.id, {
        proposalId: proposal.id,
        jobId: job?.id || null,
        jobType,
      });

      return okJson(res, { ok: true, content: await dbGetContentById(db, row.id), jobId: job?.id || null, jobType });
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

        const contentPack = normalizeContentPack(row.content_pack) || {};
        const assetUrl = pickFirstAssetUrl(contentPack);
        const caption = buildCaption(contentPack);

        if (!assetUrl) {
          return okJson(res, { ok: false, error: "publish requires assetUrl (missing assets/url)", dbDisabled: true });
        }

        const jobId = crypto.randomUUID();
        mem.jobs.set(jobId, {
          id: jobId,
          proposal_id: row.proposal_id,
          type: "publish",
          status: "queued",
          input: {
            contentId: id,
            contentPack,
            assetUrl,
            thumbnailUrl: pickThumbnailUrl(contentPack),
            caption,
            format: packType(contentPack),
            aspectRatio: pickAspectRatio(contentPack),
          },
          output: {},
          error: null,
          created_at: nowIso(),
          started_at: null,
          finished_at: null,
        });

        memPatchContentItem(id, { status: "publish.requested", job_id: jobId });

        const p = mem.proposals.get(row.proposal_id) || null;
        if (p) {
          notifyN8n("content.publish", p, buildPublishNotifyExtra({
            tenantId,
            proposal: p,
            row,
            jobId,
            contentPack,
            assetUrl,
            caption,
          }));
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

      const row = await dbGetContentById(db, id);
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
        input: {
          contentId: row.id,
          contentPack,
          assetUrl,
          thumbnailUrl: pickThumbnailUrl(contentPack),
          caption,
          format: packType(contentPack),
          aspectRatio: pickAspectRatio(contentPack),
        },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "publish.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n("content.publish", proposal, buildPublishNotifyExtra({
        tenantId,
        proposal,
        row: updated || row,
        jobId: job?.id || null,
        contentPack,
        assetUrl,
        caption,
      }));

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Publish started",
        body: "n8n paylaşımı edir…",
        payload: { contentId: row.id, proposalId: proposal.id, jobId: job?.id || null },
      });

      wsHub?.broadcast?.({ type: "content.updated", content: await dbGetContentById(db, row.id) });
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