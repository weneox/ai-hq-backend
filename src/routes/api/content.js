import express from "express";
import crypto from "crypto";

import { okJson, isDbReady, isUuid, nowIso } from "../../utils/http.js";

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

import { kernelHandle } from "../../kernel/agentKernel.js";

import {
  normalizeContentPack,
  pickTenantId,
  packType,
  pickAspectRatio,
  pickVisualPreset,
  pickImagePrompt,
  pickVideoPrompt,
  pickVoiceoverText,
  pickNeededAssets,
  pickReelMeta,
  statusLc,
  isDraftReadyStatus,
  isAssetReadyStatus,
  isPublishRequestedStatus,
  isReelPack,
  pickAssetGenerationEvent,
  pickAssetGenerationJobType,
} from "./content.shared.js";

import {
  pickFirstAssetUrl,
  pickThumbnailUrl,
  buildCaption,
  canPublishRow,
} from "./content.assets.js";

import {
  buildAssetNotifyExtra,
  buildPublishNotifyExtra,
} from "./content.notify.js";

import { dbGetContentById } from "./content.db.js";

function cleanLower(v) {
  return String(v || "").trim().toLowerCase();
}

function clean(v) {
  return String(v || "").trim();
}

function normalizeAutomationMode(v, fallback = "manual") {
  const x = clean(v || fallback).toLowerCase();
  if (x === "full_auto") return "full_auto";
  return "manual";
}

function getAuthTenantKey(req) {
  return cleanLower(
    req?.auth?.tenantKey ||
      req?.auth?.tenant_key ||
      req?.user?.tenantKey ||
      req?.user?.tenant_key ||
      req?.tenant?.key ||
      req?.tenantKey ||
      ""
  );
}

function pickRuntimeTenantId(...items) {
  for (const x of items) {
    const v = String(
      x?.tenant_id ||
        x?.tenantId ||
        ""
    ).trim();
    if (v) return v;
  }
  return "";
}

function pickActionActor(req, fallback = "ceo") {
  return (
    clean(
      req.body?.by ||
        req.body?.actor ||
        req.headers["x-actor"] ||
        req.headers["x-user-email"] ||
        req.auth?.email ||
        fallback
    ) || fallback
  );
}

function pickAutomationMeta(req) {
  const mode = normalizeAutomationMode(
    req.body?.automationMode ||
      req.body?.mode ||
      req.headers["x-automation-mode"] ||
      "manual",
    "manual"
  );

  const autoPublish =
    mode === "full_auto" ||
    req.body?.autoPublish === true ||
    String(req.headers["x-auto-publish"] || "").trim() === "1";

  return {
    mode,
    autoPublish,
  };
}

function collectAssetUrls(contentPack = {}, row = null) {
  const urls = [];
  const push = (v) => {
    const x = String(v || "").trim();
    if (!x) return;
    if (!urls.includes(x)) urls.push(x);
  };

  const assets = Array.isArray(contentPack?.assets) ? contentPack.assets : [];
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    push(a.url);
    push(a.secure_url);
    push(a.assetUrl);
  }

  push(contentPack?.imageUrl);
  push(contentPack?.videoUrl);
  push(contentPack?.renderUrl);
  push(contentPack?.voiceoverUrl);
  push(contentPack?.thumbnailUrl);
  push(contentPack?.coverUrl);
  push(contentPack?.render?.url);
  push(contentPack?.video?.videoUrl);
  push(contentPack?.voiceover?.url);

  if (row) {
    push(row.asset_url);
    push(row.thumbnail_url);
    push(row.image_url);
    push(row.video_url);
  }

  return urls;
}

function canAnalyzeRow(row) {
  const st = statusLc(row?.status);
  return (
    st === "approved" ||
    st === "published" ||
    st === "publish.requested" ||
    isAssetReadyStatus(st)
  );
}

function buildAnalyzeTenant({ tenantKey, tenantId, contentPack }) {
  const language =
    clean(contentPack?.language) ||
    clean(contentPack?.outputLanguage) ||
    "az";

  return {
    tenantKey: tenantKey || "default",
    tenantId: tenantId || tenantKey || "default",
    companyName: tenantKey || "This company",
    brand: {
      name: tenantKey || "This company",
      defaultLanguage: language,
      outputLanguage: language,
      industryKey: clean(contentPack?.industryKey) || "generic_business",
      visualTheme: clean(contentPack?.visualTheme) || "premium_modern",
      tone: Array.isArray(contentPack?.tone) ? contentPack.tone : [],
      services: Array.isArray(contentPack?.services) ? contentPack.services : [],
      audiences: Array.isArray(contentPack?.audiences) ? contentPack.audiences : [],
      requiredHashtags: Array.isArray(contentPack?.hashtags) ? contentPack.hashtags : [],
    },
  };
}

function buildAnalyzeExtra({ row, proposal, contentPack, assetUrls }) {
  return {
    approvedDraft: contentPack,
    contentPack,
    assetUrls,
    proposal: proposal || null,
    contentId: row?.id || null,
    proposalId: row?.proposal_id || null,
    caption:
      clean(contentPack?.caption) ||
      clean(contentPack?.copy?.caption) ||
      "",
    cta: clean(contentPack?.cta) || "",
    hook: clean(contentPack?.hook) || "",
    slides: Array.isArray(contentPack?.slides) ? contentPack.slides : [],
    visualPlan:
      contentPack?.visualPlan && typeof contentPack.visualPlan === "object"
        ? contentPack.visualPlan
        : {},
    voiceoverText:
      clean(contentPack?.voiceoverText) ||
      clean(contentPack?.assetBrief?.voiceoverText) ||
      "",
    format: packType(contentPack),
  };
}

function buildAnalyzeBody(analysis = {}) {
  const score =
    typeof analysis?.score === "number" ? analysis.score : null;
  const verdict = clean(analysis?.verdict);
  const publishReady = analysis?.publishReady === true;

  if (publishReady && score !== null) {
    return `Analyze tamamlandı. Score: ${score}/10. Verdict: ${verdict || "publish_ready"}.`;
  }

  if (score !== null) {
    return `Analyze tamamlandı. Score: ${score}/10. Revision tövsiyə olunur.`;
  }

  return "Analyze tamamlandı.";
}

function buildAnalyzeTitle(analysis = {}) {
  const verdict = clean(analysis?.verdict);

  if (verdict === "publish_ready") return "Analyze: publish ready";
  if (verdict === "strong_with_minor_improvements") return "Analyze: strong";
  if (verdict === "needs_targeted_fixes") return "Analyze: fixes needed";
  if (verdict === "needs_major_revision") return "Analyze: major revision";
  return "Analyze completed";
}

export function contentRoutes({ db, wsHub }) {
  const r = express.Router();

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

  r.post("/content/:id/feedback", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantKey = getAuthTenantKey(req) || cleanLower(pickTenantId(req));
    const feedbackText = String(req.body?.feedbackText || req.body?.feedback || "").trim();
    const actor = pickActionActor(req, "ceo");
    const automation = pickAutomationMeta(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });
    if (!feedbackText) return okJson(res, { ok: false, error: "feedbackText required" });

    try {
      if (!isDbReady(db)) {
        const row = memPatchContentItem(id, {
          last_feedback: feedbackText,
          status: "draft.regenerating",
        });

        if (!row) {
          return okJson(res, { ok: false, error: "content not found", dbDisabled: true });
        }

        const proposal = mem.proposals.get(row.proposal_id) || null;
        const tenantId = pickRuntimeTenantId(row, proposal);

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
            tenantKey,
            tenantId,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
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
            tenantKey,
            tenantId,
            proposalId: String(proposal.id),
            threadId: String(proposal.thread_id || proposal.threadId || ""),
            jobId,
            contentId: String(row.id),
            feedbackText,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
            contentPack: normalizeContentPack(row.content_pack) || {},
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          });
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Changes requested",
          body: "Draft yenidən hazırlanır…",
          payload: {
            contentId: id,
            proposalId: row.proposal_id,
            jobId,
            automationMode: automation.mode,
          },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) || row });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(actor, "content.feedback", "content", id, {
          proposalId: row.proposal_id,
          jobId,
          automationMode: automation.mode,
        });

        return okJson(res, {
          ok: true,
          content: mem.contentItems.get(id) || row,
          jobId,
          dbDisabled: true,
        });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const current = await dbGetContentById(db, id);
      if (!current) return okJson(res, { ok: false, error: "content not found" });

      const updated = await dbUpdateContentItem(db, id, {
        status: "draft.regenerating",
        last_feedback: feedbackText,
      });

      const proposal = await dbGetProposalById(db, String(current.proposal_id));
      const tenantId = pickRuntimeTenantId(updated, current, proposal);
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
            tenantKey,
            tenantId,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
          },
        });

        await dbUpdateContentItem(db, updated.id, { job_id: job?.id || updated.job_id });

        notifyN8n("content.revise", proposal, {
          tenantKey,
          tenantId,
          proposalId: String(proposal.id),
          threadId: String(proposal.thread_id),
          jobId: job?.id || null,
          contentId: String(updated.id),
          feedbackText,
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
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
        payload: {
          contentId: id,
          proposalId: updated.proposal_id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      wsHub?.broadcast?.({
        type: "content.updated",
        content: await dbGetContentById(db, updated.id),
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft yenilənir",
        body: "Rəy göndərildi — n8n draftı yenidən hazırlayır.",
        data: {
          type: "draft.regen",
          contentId: id,
          proposalId: updated.proposal_id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      await dbAudit(db, actor, "content.feedback", "content", id, {
        proposalId: updated.proposal_id,
        jobId: job?.id || null,
        automationMode: automation.mode,
      });

      return okJson(res, {
        ok: true,
        content: await dbGetContentById(db, updated.id),
        jobId: job?.id || null,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/content/:id/approve", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantKey = getAuthTenantKey(req) || cleanLower(pickTenantId(req));
    const actor = pickActionActor(req, "ceo");
    const automation = pickAutomationMeta(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const st = statusLc(row.status);

        if (isPublishRequestedStatus(st)) {
          return okJson(res, {
            ok: false,
            error: "publish already requested",
            status: row.status,
            dbDisabled: true,
          });
        }

        if (isAssetReadyStatus(st) && pickFirstAssetUrl(normalizeContentPack(row.content_pack) || {}, row)) {
          return okJson(res, {
            ok: true,
            content: row,
            note: "asset already ready",
            dbDisabled: true,
          });
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
        const tenantId = pickRuntimeTenantId(row);
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
            tenantKey,
            tenantId,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
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
          notifyN8n(
            eventName,
            p,
            buildAssetNotifyExtra({
              tenantKey,
              tenantId,
              proposal: p,
              row: updated || row,
              jobId,
              contentPack,
              automationMode: automation.mode,
              autoPublish: automation.autoPublish,
            })
          );
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: isReelPack(contentPack) ? "Video generating" : "Assets generating",
          body: isReelPack(contentPack)
            ? "Reel/video hazırlanır…"
            : "Şəkil/video/karusel hazırlanır…",
          payload: {
            contentId: id,
            proposalId: row.proposal_id,
            jobId,
            jobType,
            automationMode: automation.mode,
          },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: updated });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(actor, "content.approve.assets", "content", id, {
          proposalId: row.proposal_id,
          jobId,
          jobType,
          automationMode: automation.mode,
        });

        return okJson(res, { ok: true, content: updated, jobId, jobType, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbGetContentById(db, id);
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const st = statusLc(row.status);

      if (isPublishRequestedStatus(st)) {
        return okJson(res, { ok: false, error: "publish already requested", status: row.status });
      }

      if (isAssetReadyStatus(st) && pickFirstAssetUrl(normalizeContentPack(row.content_pack) || {}, row)) {
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
      const tenantId = pickRuntimeTenantId(row, proposal);

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
          tenantKey,
          tenantId,
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
        },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "asset.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n(
        eventName,
        proposal,
        buildAssetNotifyExtra({
          tenantKey,
          tenantId,
          proposal,
          row: updated || row,
          jobId: job?.id || null,
          contentPack,
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
        })
      );

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: isReelPack(contentPack) ? "Video generating" : "Assets generating",
        body: isReelPack(contentPack)
          ? "Reel/video hazırlanır…"
          : "Şəkil/video/karusel hazırlanır…",
        payload: {
          contentId: row.id,
          proposalId: proposal.id,
          jobId: job?.id || null,
          jobType,
          automationMode: automation.mode,
        },
      });

      wsHub?.broadcast?.({
        type: "content.updated",
        content: await dbGetContentById(db, row.id),
      });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: isReelPack(contentPack) ? "Video hazırlanır" : "Asset hazırlanır",
        body: isReelPack(contentPack)
          ? "Approve edildi — reel/video hazırlanır."
          : "Approve edildi — vizual hazırlanır.",
        data: {
          type: "asset.requested",
          contentId: row.id,
          proposalId: proposal.id,
          jobId: job?.id || null,
          jobType,
          automationMode: automation.mode,
        },
      });

      await dbAudit(db, actor, "content.approve.assets", "content", row.id, {
        proposalId: proposal.id,
        jobId: job?.id || null,
        jobType,
        automationMode: automation.mode,
      });

      return okJson(res, {
        ok: true,
        content: await dbGetContentById(db, row.id),
        jobId: job?.id || null,
        jobType,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/content/:id/analyze", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantKey = getAuthTenantKey(req) || cleanLower(pickTenantId(req));
    const actor = pickActionActor(req, "ceo");

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) {
          return okJson(res, { ok: false, error: "content not found", dbDisabled: true });
        }

        if (!canAnalyzeRow(row)) {
          return okJson(res, {
            ok: false,
            error: "content must be approved/asset.ready/published before analyze",
            status: row.status,
            dbDisabled: true,
          });
        }

        const proposal = mem.proposals.get(row.proposal_id) || null;
        const contentPack = normalizeContentPack(row.content_pack) || {};
        const assetUrls = collectAssetUrls(contentPack, row);
        const tenantId = pickRuntimeTenantId(row, proposal);
        const tenant = buildAnalyzeTenant({ tenantKey, tenantId, contentPack });

        const analysisRun = await kernelHandle({
          agentHint: "critic",
          usecase: "content.analyze",
          message:
            "Analyze this approved content for premium quality, business usefulness, and publish readiness. Return strict JSON only.",
          tenant,
          today: String(nowIso()).slice(0, 10),
          format: packType(contentPack),
          extra: buildAnalyzeExtra({
            row,
            proposal,
            contentPack,
            assetUrls,
          }),
        });

        if (!analysisRun?.ok || !analysisRun?.structured) {
          return okJson(res, {
            ok: false,
            error: "analyze_failed",
            details: {
              status: analysisRun?.status || null,
              warnings: analysisRun?.warnings || [],
              replyText: analysisRun?.replyText || "",
            },
            dbDisabled: true,
          });
        }

        const analysis = analysisRun.structured;
        const updatedPack = {
          ...contentPack,
          analysis,
          qa: analysis,
          analyzeMeta: {
            analyzedAt: nowIso(),
            analyzedBy: actor,
            agent: analysisRun.agent || "critic",
            usecase: analysisRun.usecase || "content.analyze",
            model: analysisRun.model || "",
            warnings: Array.isArray(analysisRun.warnings) ? analysisRun.warnings : [],
          },
        };

        const updated = memPatchContentItem(id, {
          content_pack: updatedPack,
        });

        const notif = memCreateNotification({
          recipient: "ceo",
          type:
            analysis?.publishReady === true
              ? "success"
              : analysis?.verdict === "needs_major_revision"
              ? "error"
              : "info",
          title: buildAnalyzeTitle(analysis),
          body: buildAnalyzeBody(analysis),
          payload: {
            contentId: id,
            proposalId: row.proposal_id,
            analysis,
          },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: updated || mem.contentItems.get(id) || row });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(actor, "content.analyze", "content", id, {
          proposalId: row.proposal_id,
          score: analysis?.score ?? null,
          verdict: analysis?.verdict || null,
          publishReady: analysis?.publishReady === true,
        });

        return okJson(res, {
          ok: true,
          content: updated || mem.contentItems.get(id) || row,
          analysis,
          dbDisabled: true,
        });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbGetContentById(db, id);
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      if (!canAnalyzeRow(row)) {
        return okJson(res, {
          ok: false,
          error: "content must be approved/asset.ready/published before analyze",
          status: row.status,
        });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      const contentPack = normalizeContentPack(row.content_pack) || {};
      const assetUrls = collectAssetUrls(contentPack, row);
      const tenantId = pickRuntimeTenantId(row, proposal);
      const tenant = buildAnalyzeTenant({ tenantKey, tenantId, contentPack });

      const analysisRun = await kernelHandle({
        agentHint: "critic",
        usecase: "content.analyze",
        message:
          "Analyze this approved content for premium quality, business usefulness, and publish readiness. Return strict JSON only.",
        tenant,
        today: String(nowIso()).slice(0, 10),
        format: packType(contentPack),
        extra: buildAnalyzeExtra({
          row,
          proposal,
          contentPack,
          assetUrls,
        }),
      });

      if (!analysisRun?.ok || !analysisRun?.structured) {
        return okJson(res, {
          ok: false,
          error: "analyze_failed",
          details: {
            status: analysisRun?.status || null,
            warnings: analysisRun?.warnings || [],
            replyText: analysisRun?.replyText || "",
          },
        });
      }

      const analysis = analysisRun.structured;
      const updatedPack = {
        ...contentPack,
        analysis,
        qa: analysis,
        analyzeMeta: {
          analyzedAt: nowIso(),
          analyzedBy: actor,
          agent: analysisRun.agent || "critic",
          usecase: analysisRun.usecase || "content.analyze",
          model: analysisRun.model || "",
          warnings: Array.isArray(analysisRun.warnings) ? analysisRun.warnings : [],
        },
      };

      await dbUpdateContentItem(db, row.id, {
        content_pack: updatedPack,
      });

      const refreshed = await dbGetContentById(db, row.id);

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type:
          analysis?.publishReady === true
            ? "success"
            : analysis?.verdict === "needs_major_revision"
            ? "error"
            : "info",
        title: buildAnalyzeTitle(analysis),
        body: buildAnalyzeBody(analysis),
        payload: {
          contentId: row.id,
          proposalId: row.proposal_id,
          analysis,
        },
      });

      wsHub?.broadcast?.({
        type: "content.updated",
        content: refreshed,
      });
      wsHub?.broadcast?.({
        type: "notification.created",
        notification: notif,
      });

      await pushBroadcastToCeo({
        db,
        title: buildAnalyzeTitle(analysis),
        body: buildAnalyzeBody(analysis),
        data: {
          type: "content.analyze",
          contentId: row.id,
          proposalId: row.proposal_id,
          score: analysis?.score ?? null,
          verdict: analysis?.verdict || null,
          publishReady: analysis?.publishReady === true,
        },
      });

      await dbAudit(db, actor, "content.analyze", "content", row.id, {
        proposalId: row.proposal_id,
        score: analysis?.score ?? null,
        verdict: analysis?.verdict || null,
        publishReady: analysis?.publishReady === true,
      });

      return okJson(res, {
        ok: true,
        content: refreshed,
        analysis,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/content/:id/publish", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const tenantKey = getAuthTenantKey(req) || cleanLower(pickTenantId(req));
    const actor = pickActionActor(req, "ceo");
    const automation = pickAutomationMeta(req);

    if (!id) return okJson(res, { ok: false, error: "contentId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id) || null;
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const contentPack = normalizeContentPack(row.content_pack) || {};
        const st = statusLc(row.status);

        if (isPublishRequestedStatus(st)) {
          return okJson(res, {
            ok: true,
            alreadyRequested: true,
            note: "publish already requested",
            status: row.status,
            contentId: id,
            dbDisabled: true,
          });
        }

        if (!canPublishRow(row)) {
          return okJson(res, {
            ok: false,
            error: "content must be asset.ready before publish",
            status: row.status,
            hasAssetUrl: !!pickFirstAssetUrl(contentPack, row),
            dbDisabled: true,
          });
        }

        const assetUrl = pickFirstAssetUrl(contentPack, row);
        const caption = buildCaption(contentPack);
        const tenantId = pickRuntimeTenantId(row);

        if (!assetUrl) {
          return okJson(res, {
            ok: false,
            error: "publish requires assetUrl (missing assets/url)",
            dbDisabled: true,
          });
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
            thumbnailUrl: pickThumbnailUrl(contentPack, row),
            caption,
            format: packType(contentPack),
            aspectRatio: pickAspectRatio(contentPack),
            tenantKey,
            tenantId,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
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
          notifyN8n(
            "content.publish",
            p,
            buildPublishNotifyExtra({
              tenantKey,
              tenantId,
              proposal: p,
              row,
              jobId,
              contentPack,
              assetUrl,
              caption,
              automationMode: automation.mode,
              autoPublish: automation.autoPublish,
            })
          );
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Publish started",
          body: "n8n paylaşımı edir…",
          payload: {
            contentId: id,
            proposalId: row.proposal_id,
            jobId,
            automationMode: automation.mode,
          },
        });

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) });
        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(actor, "content.publish", "content", id, {
          proposalId: row.proposal_id,
          jobId,
          status: st,
          automationMode: automation.mode,
        });

        return okJson(res, { ok: true, jobId, contentId: id, dbDisabled: true });
      }

      if (!isUuid(id)) return okJson(res, { ok: false, error: "contentId must be uuid" });

      const row = await dbGetContentById(db, id);
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const contentPack = normalizeContentPack(row.content_pack) || {};
      const st = statusLc(row.status);

      if (isPublishRequestedStatus(st)) {
        return okJson(res, {
          ok: true,
          alreadyRequested: true,
          note: "publish already requested",
          status: row.status,
          contentId: row.id,
        });
      }

      if (!canPublishRow(row)) {
        return okJson(res, {
          ok: false,
          error: "content must be asset.ready before publish",
          status: row.status,
          hasAssetUrl: !!pickFirstAssetUrl(contentPack, row),
        });
      }

      const proposal = await dbGetProposalById(db, String(row.proposal_id));
      if (!proposal) return okJson(res, { ok: false, error: "proposal not found for content" });

      const assetUrl = pickFirstAssetUrl(contentPack, row);
      const caption = buildCaption(contentPack);
      const tenantId = pickRuntimeTenantId(row, proposal);

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
          thumbnailUrl: pickThumbnailUrl(contentPack, row),
          caption,
          format: packType(contentPack),
          aspectRatio: pickAspectRatio(contentPack),
          tenantKey,
          tenantId,
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
        },
      });

      const updated = await dbUpdateContentItem(db, row.id, {
        status: "publish.requested",
        job_id: job?.id || row.job_id,
      });

      notifyN8n(
        "content.publish",
        proposal,
        buildPublishNotifyExtra({
          tenantKey,
          tenantId,
          proposal,
          row: updated || row,
          jobId: job?.id || null,
          contentPack,
          assetUrl,
          caption,
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
        })
      );

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Publish started",
        body: "n8n paylaşımı edir…",
        payload: {
          contentId: row.id,
          proposalId: proposal.id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      wsHub?.broadcast?.({
        type: "content.updated",
        content: await dbGetContentById(db, row.id),
      });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Publish başladı",
        body: "Instagram paylaşımı hazırlanır…",
        data: {
          type: "publish.requested",
          contentId: row.id,
          proposalId: proposal.id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      await dbAudit(db, actor, "content.publish", "content", row.id, {
        proposalId: proposal.id,
        jobId: job?.id || null,
        status: row.status,
        automationMode: automation.mode,
      });

      return okJson(res, { ok: true, jobId: job?.id || null, contentId: row.id });
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