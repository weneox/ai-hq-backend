import express from "express";
import crypto from "crypto";

import {
  okJson,
  clamp,
  isDbReady,
  isUuid,
  serializeError,
  nowIso,
} from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { requireCallbackToken } from "../../utils/auth.js";

import {
  mem,
  memCreateNotification,
  memUpdateJob,
  memUpsertContentItem,
  memPatchContentItem,
  memGetLatestContentByProposal,
  memAudit,
} from "../../utils/memStore.js";

import { dbUpdateJob, dbCreateJob } from "../../db/helpers/jobs.js";
import {
  dbGetProposalById,
  dbSetProposalStatus,
} from "../../db/helpers/proposals.js";
import {
  dbUpsertDraftFromCallback,
  dbGetLatestContentByProposal,
  dbUpdateContentItem,
} from "../../db/helpers/content.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";
import { runMediaJobNow } from "../../services/media/mediaExecutionRunner.js";

import {
  pickJobId,
  normalizeStatus,
  pickTenantIdFromResult,
  pickThreadId,
  pickContentId,
  jobTypeLc,
  isDraftJobType,
  isAssetJobType,
  isPublishJobType,
  isVoiceJobType,
  isSceneJobType,
  isRenderJobType,
  isQaJobType,
  buildNotificationCopy,
  pickNextJobTypeAfter,
  buildNextJobInput,
} from "./executions.shared.js";

import {
  mergePackAssets,
  pickPublishInfo,
  pickVideoInfo,
  pickImageInfo,
  mergeContentPack,
} from "./executions.assets.js";

import {
  dbFindContentItemById,
  resolveDbContentRowForUpdate,
} from "./executions.db.js";

function clean(v) {
  return String(v || "").trim();
}

function lower(v) {
  return clean(v).toLowerCase();
}

function normalizeAutomationMode(v, fallback = "manual") {
  const x = lower(v || fallback);
  if (x === "full_auto") return "full_auto";
  return "manual";
}

function pickAutomationMeta(result = {}, jobInput = {}, contentRow = null) {
  const mode = normalizeAutomationMode(
    result?.automationMode ||
      result?.automation_mode ||
      jobInput?.automationMode ||
      jobInput?.automation_mode ||
      contentRow?.automationMode ||
      contentRow?.content_pack?.automationMode ||
      "manual",
    "manual"
  );

  const autoPublish =
    result?.autoPublish === true ||
    result?.auto_publish === true ||
    jobInput?.autoPublish === true ||
    jobInput?.auto_publish === true ||
    contentRow?.content_pack?.autoPublish === true ||
    mode === "full_auto";

  return {
    mode,
    autoPublish,
  };
}

function pickAssetUrl(result = {}, contentPack = {}) {
  return (
    clean(
      result?.assetUrl ||
        result?.imageUrl ||
        result?.videoUrl ||
        result?.url ||
        contentPack?.imageUrl ||
        contentPack?.videoUrl ||
        contentPack?.coverUrl
    ) || null
  );
}

function pickCaption(contentPack = {}, result = {}) {
  return (
    clean(
      result?.caption ||
        contentPack?.caption ||
        contentPack?.copy?.caption ||
        contentPack?.post?.caption
    ) || ""
  );
}

function isCompleted(status) {
  return lower(status) === "completed";
}

function patchStatusForJobType(jt, status) {
  const completed = status === "completed";
  if (isDraftJobType(jt)) return completed ? "draft.ready" : "draft.failed";
  if (isVoiceJobType(jt)) return completed ? "voice.ready" : "voice.failed";
  if (isSceneJobType(jt)) return completed ? "scene.ready" : "scene.failed";
  if (isRenderJobType(jt)) return completed ? "render.ready" : "render.failed";
  if (isQaJobType(jt)) return completed ? "qa.ready" : "qa.failed";
  if (isPublishJobType(jt)) return completed ? "published" : "publish.failed";
  return completed ? "asset.ready" : "asset.failed";
}

function enrichContentPackForJobType(merged, jt, result = {}) {
  const pack = deepFix(merged || {});

  if (isVoiceJobType(jt)) {
    const voiceUrl =
      result?.voiceUrl ||
      result?.voice_url ||
      result?.audioUrl ||
      result?.audio_url ||
      result?.url ||
      result?.voiceover?.url ||
      null;

    const subtitleUrl =
      result?.subtitleUrl ||
      result?.subtitle_url ||
      result?.srtUrl ||
      result?.srt_url ||
      null;

    pack.voiceover = deepFix({
      ...(pack.voiceover && typeof pack.voiceover === "object"
        ? pack.voiceover
        : {}),
      provider:
        result?.provider || result?.voiceover?.provider || "elevenlabs",
      url: voiceUrl || pack.voiceover?.url || null,
      durationSec:
        result?.durationSec ??
        result?.duration_sec ??
        pack.voiceover?.durationSec ??
        null,
      language: result?.language || pack.voiceover?.language || null,
    });

    if (voiceUrl) pack.voiceoverUrl = voiceUrl;
    if (subtitleUrl) pack.subtitleUrl = subtitleUrl;
  }

  if (isSceneJobType(jt)) {
    pack.mediaType = pack.mediaType || "video";
    pack.format = pack.format || "reel";
  }

  if (isRenderJobType(jt)) {
    const renderUrl =
      result?.renderUrl ||
      result?.render_url ||
      result?.videoUrl ||
      result?.video_url ||
      result?.url ||
      null;

    if (renderUrl) pack.renderUrl = renderUrl;
    pack.render = deepFix({
      ...(pack.render && typeof pack.render === "object" ? pack.render : {}),
      provider: result?.provider || result?.render?.provider || "creatomate",
      url: renderUrl || pack.render?.url || null,
    });
  }

  if (isQaJobType(jt)) {
    pack.qa = deepFix({
      ...(pack.qa && typeof pack.qa === "object" ? pack.qa : {}),
      provider: result?.provider || "ai_hq",
      status: result?.qaStatus || result?.status || "completed",
      score: result?.score ?? result?.qaScore ?? pack.qa?.score ?? null,
      checks: deepFix(result?.checks || result?.qaChecks || {}),
      summary: fixText(
        result?.summary || result?.qaSummary || pack.qa?.summary || ""
      ),
    });
  }

  return deepFix(pack);
}

function buildWorkflowEventByJobType(jobType) {
  const jt = jobTypeLc(jobType);
  if (jt === "voice.generate") return "content.voice.generate";
  if (jt === "video.generate") return "content.video.generate";
  if (jt === "assembly.render") return "content.render";
  if (jt === "qa.check") return "content.qa.check";
  if (jt === "publish") return "content.publish";
  return "proposal.approved";
}

export function executionsRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/executions", async (req, res) => {
    const status = String(req.query.status || "").trim();
    const limit = clamp(req.query.limit ?? 50, 1, 200);
    const executionId = String(req.query.executionId || "").trim();

    try {
      if (!isDbReady(db)) {
        let rows = Array.from(mem.jobs.values());
        if (executionId) rows = rows.filter((x) => x.id === executionId);
        if (status) rows = rows.filter((x) => String(x.status) === status);
        rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return okJson(res, {
          ok: true,
          executions: rows.slice(0, limit),
          dbDisabled: true,
        });
      }

      const where = [];
      const args = [];

      if (executionId) {
        args.push(executionId);
        where.push(`id = $${args.length}::uuid`);
      }
      if (status) {
        args.push(status);
        where.push(`status = $${args.length}::text`);
      }

      const sqlWhere = where.length ? `where ${where.join(" and ")}` : "";
      const q = await db.query(
        `select id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
         from jobs
         ${sqlWhere}
         order by created_at desc
         limit ${limit}`,
        args
      );

      const rows = (q.rows || []).map((x) => ({
        ...x,
        input: deepFix(x.input),
        output: deepFix(x.output),
        error: x.error ? fixText(String(x.error)) : null,
      }));

      return okJson(res, { ok: true, executions: rows });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/executions/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "executionId required" });

    try {
      if (!isDbReady(db)) {
        const row = mem.jobs.get(id) || null;
        if (!row) {
          return okJson(res, {
            ok: false,
            error: "not found",
            dbDisabled: true,
          });
        }
        return okJson(res, { ok: true, execution: row, dbDisabled: true });
      }

      const q = await db.query(
        `select id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
         from jobs
         where id = $1::uuid
         limit 1`,
        [id]
      );

      const row = q.rows?.[0] || null;
      if (!row) return okJson(res, { ok: false, error: "not found" });

      row.input = deepFix(row.input);
      row.output = deepFix(row.output);
      row.error = row.error ? fixText(String(row.error)) : null;

      return okJson(res, { ok: true, execution: row });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/executions/callback", async (req, res) => {
    if (!requireCallbackToken(req)) {
      return okJson(res, {
        ok: false,
        error: "forbidden (invalid callback token)",
      });
    }

    const jobId = pickJobId(req);
    const status = normalizeStatus(req.body?.status);
    const result = deepFix(req.body?.result || req.body?.output || {});
    const errorText = req.body?.error ? fixText(String(req.body.error)) : null;

    if (!jobId) return okJson(res, { ok: false, error: "jobId required" });
    if (!isUuid(jobId))
      return okJson(res, { ok: false, error: "jobId must be uuid" });
    if (!status) return okJson(res, { ok: false, error: "status required" });

    try {
      const finished_at = nowIso();
      const patch = {
        status,
        output: deepFix({ result }),
        error: errorText,
        finished_at,
      };

      if (!isDbReady(db)) {
        const job = mem.jobs.get(jobId);
        if (!job) {
          return okJson(res, {
            ok: false,
            error: "job not found",
            dbDisabled: true,
          });
        }

        memUpdateJob(jobId, patch);

        const jt = jobTypeLc(job.type);
        const proposalId =
          String(
            job.proposal_id || result?.proposalId || result?.proposal_id || ""
          ).trim() || null;
        const jobInput = deepFix(job.input || {});
        const contentIdFromInput = pickContentId(result, jobInput);
        const automation = pickAutomationMeta(result, jobInput);

        const incomingPack = mergePackAssets(result);
        const publishInfo = pickPublishInfo(result);

        let contentRow = null;
        let proposalRow = proposalId ? mem.proposals.get(proposalId) || null : null;
        let nextJob = null;

        if (proposalId && incomingPack && isDraftJobType(jt)) {
          contentRow = memUpsertContentItem({
            proposalId,
            threadId: pickThreadId(result, jobInput),
            jobId,
            status: patchStatusForJobType(jt, status),
            contentPack: enrichContentPackForJobType(incomingPack, jt, result),
          });

          wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
        }

        if (proposalId && isAssetJobType(jt) && !isPublishJobType(jt)) {
          const target = contentIdFromInput
            ? mem.contentItems.get(contentIdFromInput) || null
            : memGetLatestContentByProposal(proposalId);

          if (target) {
            const merged = enrichContentPackForJobType(
              mergeContentPack(target.content_pack, incomingPack, result, jt),
              jt,
              result
            );

            memPatchContentItem(target.id, {
              status: patchStatusForJobType(jt, status),
              content_pack: merged,
              assets: Array.isArray(merged.assets) ? merged.assets : [],
            });

            contentRow = mem.contentItems.get(target.id) || null;

            if (proposalRow && status === "completed" && !isQaJobType(jt)) {
              proposalRow.status = "approved";
            }

            wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
            wsHub?.broadcast?.({
              type: "proposal.updated",
              proposal: proposalRow,
            });

            if (proposalRow && contentRow && isCompleted(status)) {
              const nextJobType = pickNextJobTypeAfter(jt, merged, automation);

              if (nextJobType && !isPublishJobType(jt)) {
                const nextJobId = crypto.randomUUID();

                mem.jobs.set(nextJobId, {
                  id: nextJobId,
                  proposal_id: proposalId,
                  type: nextJobType,
                  status: "queued",
                  input: buildNextJobInput({
                    proposalId,
                    threadId: contentRow.thread_id || proposalRow?.thread_id || null,
                    tenantId: result?.tenantId || null,
                    contentId: contentRow.id,
                    contentPack: merged,
                    currentResult: result,
                    nextJobType,
                    automation,
                  }),
                  output: {},
                  error: null,
                  created_at: nowIso(),
                  started_at: null,
                  finished_at: null,
                });

                nextJob = mem.jobs.get(nextJobId);

                memPatchContentItem(contentRow.id, {
                  status:
                    nextJobType === "voice.generate"
                      ? "voice.queued"
                      : nextJobType === "video.generate"
                      ? "scene.queued"
                      : nextJobType === "assembly.render"
                      ? "render.queued"
                      : nextJobType === "qa.check"
                      ? "qa.queued"
                      : "publish.requested",
                  job_id: nextJobId,
                });

                notifyN8n(buildWorkflowEventByJobType(nextJobType), proposalRow, {
                  tenantId: result?.tenantId || null,
                  proposalId: String(proposalId),
                  threadId: String(proposalRow?.thread_id || ""),
                  contentId: String(contentRow.id),
                  jobId: nextJobId,
                  contentPack: merged,
                  automationMode: automation.mode,
                  autoPublish: automation.autoPublish,
                  callback: {
                    url: "/api/executions/callback",
                    tokenHeader: "x-webhook-token",
                  },
                });

                wsHub?.broadcast?.({
                  type: "execution.updated",
                  execution: nextJob,
                });
                wsHub?.broadcast?.({
                  type: "content.updated",
                  content: mem.contentItems.get(contentRow.id),
                });
              } else if (
                proposalRow &&
                contentRow &&
                automation.mode === "full_auto" &&
                automation.autoPublish
              ) {
                const publishJobId = crypto.randomUUID();
                const assetUrl = pickAssetUrl(result, merged);
                const caption = pickCaption(merged, result);

                mem.jobs.set(publishJobId, {
                  id: publishJobId,
                  proposal_id: proposalId,
                  type: "publish",
                  status: "queued",
                  input: {
                    contentId: contentRow.id,
                    contentPack: merged,
                    assetUrl,
                    caption,
                    tenantId: result?.tenantId || null,
                    automationMode: "full_auto",
                    autoPublish: true,
                  },
                  output: {},
                  error: null,
                  created_at: nowIso(),
                  started_at: null,
                  finished_at: null,
                });

                memPatchContentItem(contentRow.id, {
                  status: "publish.requested",
                  job_id: publishJobId,
                });

                notifyN8n("content.publish", proposalRow, {
                  tenantId: result?.tenantId || null,
                  proposalId: String(proposalId),
                  threadId: String(proposalRow?.thread_id || ""),
                  contentId: String(contentRow.id),
                  jobId: publishJobId,
                  contentPack: merged,
                  assetUrl,
                  caption,
                  automationMode: "full_auto",
                  autoPublish: true,
                  callback: {
                    url: "/api/executions/callback",
                    tokenHeader: "x-webhook-token",
                  },
                });

                nextJob = mem.jobs.get(publishJobId);

                wsHub?.broadcast?.({
                  type: "execution.updated",
                  execution: nextJob,
                });
                wsHub?.broadcast?.({
                  type: "content.updated",
                  content: mem.contentItems.get(contentRow.id),
                });
              }
            }
          }
        }

        if (proposalId && isPublishJobType(jt)) {
          const latest = contentIdFromInput
            ? mem.contentItems.get(contentIdFromInput) || null
            : memGetLatestContentByProposal(proposalId);

          if (latest) {
            const nextStatus =
              status === "completed" ? "published" : "publish.failed";

            memPatchContentItem(latest.id, {
              status: nextStatus,
              publish: deepFix({ ...publishInfo, status, finished_at }),
            });

            contentRow = mem.contentItems.get(latest.id) || null;

            if (proposalRow && status === "completed") {
              proposalRow.status = "published";
            }

            wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
            wsHub?.broadcast?.({
              type: "proposal.updated",
              proposal: proposalRow || null,
            });
          }
        }

        const notifCopy = buildNotificationCopy(status, jt, errorText);
        const notif = memCreateNotification({
          recipient: "ceo",
          type: notifCopy.type,
          title: notifCopy.title,
          body: notifCopy.body,
          payload: {
            jobId,
            status,
            proposalId,
            contentId: contentRow?.id || null,
            publish: publishInfo,
            video: pickVideoInfo(result),
            image: pickImageInfo(result),
            automationMode: automation.mode,
            nextJobId: nextJob?.id || null,
            nextJobType: nextJob?.type || null,
          },
        });

        wsHub?.broadcast?.({
          type: "execution.updated",
          execution: mem.jobs.get(jobId),
        });
        wsHub?.broadcast?.({
          type: "notification.created",
          notification: notif,
        });

        memAudit("n8n", "execution.callback", "job", jobId, {
          status,
          jobType: jt,
          automationMode: automation.mode,
          nextJobType: nextJob?.type || null,
        });

        return okJson(res, { ok: true, jobId, status, dbDisabled: true });
      }

      const jobRow = await dbUpdateJob(db, jobId, patch);
      if (!jobRow) return okJson(res, { ok: false, error: "job not found" });

      const jt = jobTypeLc(jobRow.type);
      const tenantId = pickTenantIdFromResult(result);
      const tenantKey =
        clean(jobRow.tenant_key || result?.tenantKey || result?.tenant_key || "") ||
        null;
      const jobInput = deepFix(jobRow.input || {});
      const proposalId =
        String(
          jobRow.proposal_id || result?.proposalId || result?.proposal_id || ""
        ).trim() || null;
      const automation = pickAutomationMeta(result, jobInput);

      const incomingPack = mergePackAssets(result);
      const publishInfo = pickPublishInfo(result);

      let contentRow = null;
      let proposalRow = null;
      let nextJob = null;

      if (proposalId && incomingPack && isDraftJobType(jt)) {
        contentRow = await dbUpsertDraftFromCallback(db, {
          proposalId,
          threadId: pickThreadId(result, jobInput),
          jobId,
          status: patchStatusForJobType(jt, status),
          contentPack: enrichContentPackForJobType(incomingPack, jt, result),
        });
      }

      if (proposalId && isAssetJobType(jt) && !isPublishJobType(jt)) {
        const contentId = pickContentId(result, jobInput);
        const rowToUpdate = await resolveDbContentRowForUpdate(
          db,
          proposalId,
          contentId
        );

        if (rowToUpdate) {
          const merged = enrichContentPackForJobType(
            mergeContentPack(rowToUpdate.content_pack, incomingPack, result, jt),
            jt,
            result
          );

          contentRow = await dbUpdateContentItem(db, rowToUpdate.id, {
            status: patchStatusForJobType(jt, status),
            content_pack: merged,
          });

          if (status === "completed" && !isQaJobType(jt)) {
            await dbSetProposalStatus(
              db,
              String(proposalId),
              "approved",
              deepFix({
                assets: merged.assets || [],
                video: merged.video || null,
                imageUrl: merged.imageUrl || null,
                videoUrl: merged.videoUrl || null,
                thumbnailUrl: merged.thumbnailUrl || null,
                coverUrl: merged.coverUrl || null,
                voiceover: merged.voiceover || null,
                voiceoverUrl: merged.voiceoverUrl || null,
                renderUrl: merged.renderUrl || null,
                qa: merged.qa || null,
              })
            );
          }

          proposalRow = await dbGetProposalById(db, String(proposalId));

          if (proposalRow && contentRow && isCompleted(status)) {
            const nextJobType = pickNextJobTypeAfter(jt, merged, automation);

            if (nextJobType && !isPublishJobType(jt)) {
              nextJob = await dbCreateJob(db, {
                tenantId: tenantId || null,
                tenantKey: tenantKey || null,
                proposalId: proposalRow.id,
                type: nextJobType,
                status: "queued",
                input: buildNextJobInput({
                  proposalId,
                  threadId: contentRow.thread_id || proposalRow.thread_id || null,
                  tenantId: tenantId || null,
                  contentId: contentRow.id,
                  contentPack: merged,
                  currentResult: result,
                  nextJobType,
                  automation,
                }),
              });

              await dbUpdateContentItem(db, contentRow.id, {
                status:
                  nextJobType === "voice.generate"
                    ? "voice.queued"
                    : nextJobType === "video.generate"
                    ? "scene.queued"
                    : nextJobType === "assembly.render"
                    ? "render.queued"
                    : nextJobType === "qa.check"
                    ? "qa.queued"
                    : "publish.requested",
                job_id: nextJob?.id || contentRow.job_id,
              });

              contentRow = await dbFindContentItemById(db, contentRow.id);

              notifyN8n(buildWorkflowEventByJobType(nextJobType), proposalRow, {
                tenantId: tenantId || null,
                tenantKey: tenantKey || null,
                proposalId: String(proposalId),
                threadId: String(proposalRow.thread_id || ""),
                contentId: String(contentRow?.id || rowToUpdate.id),
                jobId: nextJob?.id || null,
                contentPack: merged,
                automationMode: automation.mode,
                autoPublish: automation.autoPublish,
                callback: {
                  url: "/api/executions/callback",
                  tokenHeader: "x-webhook-token",
                },
              });

              if (
                nextJob &&
                ["voice.generate", "video.generate", "assembly.render", "qa.check"].includes(
                  String(nextJob.type || "").trim().toLowerCase()
                )
              ) {
                runMediaJobNow({ db, jobId: nextJob.id }).catch((e) => {
                  console.error(
                    "[media-runner] start failed:",
                    String(e?.message || e)
                  );
                });
              }

              wsHub?.broadcast?.({
                type: "execution.updated",
                execution: nextJob,
              });
            } else if (
              proposalRow &&
              contentRow &&
              automation.mode === "full_auto" &&
              automation.autoPublish
            ) {
              const assetUrl = pickAssetUrl(result, merged);
              const caption = pickCaption(merged, result);

              const publishJob = await dbCreateJob(db, {
                tenantId: tenantId || null,
                tenantKey: tenantKey || null,
                proposalId: proposalRow.id,
                type: "publish",
                status: "queued",
                input: {
                  contentId: contentRow.id,
                  contentPack: merged,
                  assetUrl,
                  caption,
                  format: merged?.format || result?.format || null,
                  aspectRatio:
                    merged?.aspectRatio || result?.aspectRatio || null,
                  tenantId: tenantId || null,
                  automationMode: "full_auto",
                  autoPublish: true,
                },
              });

              nextJob = publishJob;

              await dbUpdateContentItem(db, contentRow.id, {
                status: "publish.requested",
                job_id: publishJob?.id || contentRow.job_id,
              });

              contentRow = await dbFindContentItemById(db, contentRow.id);

              notifyN8n("content.publish", proposalRow, {
                tenantId: tenantId || null,
                tenantKey: tenantKey || null,
                proposalId: String(proposalId),
                threadId: String(proposalRow.thread_id || ""),
                contentId: String(contentRow?.id || rowToUpdate.id),
                jobId: publishJob?.id || null,
                contentPack: merged,
                assetUrl,
                caption,
                automationMode: "full_auto",
                autoPublish: true,
                callback: {
                  url: "/api/executions/callback",
                  tokenHeader: "x-webhook-token",
                },
              });

              wsHub?.broadcast?.({
                type: "execution.updated",
                execution: publishJob,
              });
            }
          }
        }
      }

      if (proposalId && isPublishJobType(jt)) {
        const contentId = pickContentId(result, jobInput);
        const rowToUpdate =
          (contentId && isUuid(contentId)
            ? await dbFindContentItemById(db, contentId)
            : null) || (await dbGetLatestContentByProposal(db, proposalId));

        if (rowToUpdate) {
          const nextStatus =
            status === "completed" ? "published" : "publish.failed";

          contentRow = await dbUpdateContentItem(db, rowToUpdate.id, {
            status: nextStatus,
            publish: deepFix({ ...publishInfo, status, finished_at }),
          });

          if (status === "completed") {
            await dbSetProposalStatus(
              db,
              String(proposalId),
              "published",
              deepFix({ publish: publishInfo })
            );
          }
        }
      }

      const notifCopy = buildNotificationCopy(status, jt, errorText);
      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: notifCopy.type,
        title: notifCopy.title,
        body: notifCopy.body,
        payload: deepFix({
          jobId,
          status,
          proposalId,
          contentId: contentRow?.id || null,
          publish: publishInfo,
          video: pickVideoInfo(result),
          image: pickImageInfo(result),
          automationMode: automation.mode,
          nextJobId: nextJob?.id || null,
          nextJobType: nextJob?.type || null,
        }),
      });

      wsHub?.broadcast?.({ type: "execution.updated", execution: jobRow });
      wsHub?.broadcast?.({
        type: "notification.created",
        notification: notif,
      });
      if (contentRow) {
        wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
      }

      await pushBroadcastToCeo({
        db,
        title:
          status === "completed"
            ? isPublishJobType(jt)
              ? "Published"
              : isRenderJobType(jt)
              ? "Render hazırdır"
              : isSceneJobType(jt)
              ? "Scene hazırdır"
              : isVoiceJobType(jt)
              ? "Voice hazırdır"
              : isQaJobType(jt)
              ? "QA tamamlandı"
              : isAssetJobType(jt)
              ? "Assets hazırdır"
              : "Draft hazırdır"
            : status === "running"
            ? "İcra gedir"
            : "Execution failed",
        body:
          status === "completed"
            ? isPublishJobType(jt)
              ? "Post paylaşıldı."
              : isRenderJobType(jt)
              ? "Final render hazır oldu."
              : isSceneJobType(jt)
              ? "Scene/video asset hazır oldu."
              : isVoiceJobType(jt)
              ? "Voiceover hazır oldu."
              : isQaJobType(jt)
              ? "Media QA tamamlandı."
              : isAssetJobType(jt)
              ? "Vizual/video hazır oldu."
              : "AI draft yaratdı — baxıb təsdiqlə."
            : status === "running"
            ? "n8n hazırda işləyir…"
            : errorText || "n8n error",
        data: {
          type: "execution",
          jobId,
          proposalId,
          jobType: jt,
          nextJobId: nextJob?.id || null,
          nextJobType: nextJob?.type || null,
        },
      });

      await dbAudit(db, "n8n", "execution.callback", "job", jobId, {
        status,
        jobType: jt,
        automationMode: automation.mode,
        nextJobType: nextJob?.type || null,
      });

      return okJson(res, {
        ok: true,
        jobId,
        status,
        jobType: jt,
        proposalId,
        contentId: contentRow?.id || null,
        nextJobId: nextJob?.id || null,
        nextJobType: nextJob?.type || null,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: serializeError(e),
      });
    }
  });

  return r;
}