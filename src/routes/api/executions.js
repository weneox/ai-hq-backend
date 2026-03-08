import express from "express";
import { cfg } from "../../config.js";

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

import { dbUpdateJob } from "../../db/helpers/jobs.js";
import { dbGetProposalById, dbSetProposalStatus } from "../../db/helpers/proposals.js";
import {
  dbUpsertDraftFromCallback,
  dbGetLatestContentByProposal,
  dbUpdateContentItem,
} from "../../db/helpers/content.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";
import { getTenantMode } from "./mode.js";

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
  buildNotificationCopy,
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
        return okJson(res, { ok: true, executions: rows.slice(0, limit), dbDisabled: true });
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
        `select id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
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
        if (!row) return okJson(res, { ok: false, error: "not found", dbDisabled: true });
        return okJson(res, { ok: true, execution: row, dbDisabled: true });
      }

      const q = await db.query(
        `select id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
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
      return okJson(res, { ok: false, error: "forbidden (invalid callback token)" });
    }

    const jobId = pickJobId(req);
    const status = normalizeStatus(req.body?.status);
    const result = deepFix(req.body?.result || req.body?.output || {});
    const errorText = req.body?.error ? fixText(String(req.body.error)) : null;

    if (!jobId) return okJson(res, { ok: false, error: "jobId required" });
    if (!isUuid(jobId)) return okJson(res, { ok: false, error: "jobId must be uuid" });
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
        if (!job) return okJson(res, { ok: false, error: "job not found", dbDisabled: true });

        memUpdateJob(jobId, patch);

        const jt = jobTypeLc(job.type);
        const proposalId =
          String(job.proposal_id || result?.proposalId || result?.proposal_id || "").trim() || null;
        const jobInput = deepFix(job.input || {});
        const contentIdFromInput = pickContentId(result, jobInput);

        const incomingPack = mergePackAssets(result);
        const publishInfo = pickPublishInfo(result);

        let contentRow = null;

        if (proposalId && incomingPack && isDraftJobType(jt)) {
          contentRow = memUpsertContentItem({
            proposalId,
            threadId: pickThreadId(result, jobInput),
            jobId,
            status: status === "completed" ? "draft.ready" : "draft.failed",
            contentPack: incomingPack,
          });

          wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
        }

        if (proposalId && isAssetJobType(jt)) {
          const target =
            contentIdFromInput
              ? (mem.contentItems.get(contentIdFromInput) || null)
              : memGetLatestContentByProposal(proposalId);

          if (target) {
            const nextStatus = status === "completed" ? "asset.ready" : "asset.failed";
            const merged = mergeContentPack(target.content_pack, incomingPack, result, jt);

            memPatchContentItem(target.id, {
              status: nextStatus,
              content_pack: merged,
              assets: Array.isArray(merged.assets) ? merged.assets : [],
            });

            contentRow = mem.contentItems.get(target.id) || null;

            const p = mem.proposals.get(proposalId) || null;
            if (p && status === "completed") p.status = "approved";

            wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
            wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          }
        }

        if (proposalId && isPublishJobType(jt)) {
          const latest =
            contentIdFromInput
              ? (mem.contentItems.get(contentIdFromInput) || null)
              : memGetLatestContentByProposal(proposalId);

          if (latest) {
            const nextStatus = status === "completed" ? "published" : "publish.failed";

            memPatchContentItem(latest.id, {
              status: nextStatus,
              publish: deepFix({ ...publishInfo, status, finished_at }),
            });

            contentRow = mem.contentItems.get(latest.id) || null;

            const p = mem.proposals.get(proposalId);
            if (p && status === "completed") p.status = "published";

            wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
            wsHub?.broadcast?.({ type: "proposal.updated", proposal: p || null });
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
          },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("n8n", "execution.callback", "job", jobId, { status, jobType: jt });

        return okJson(res, { ok: true, jobId, status, dbDisabled: true });
      }

      const jobRow = await dbUpdateJob(db, jobId, patch);
      if (!jobRow) return okJson(res, { ok: false, error: "job not found" });

      const jt = jobTypeLc(jobRow.type);
      const tenantId = pickTenantIdFromResult(result);
      const jobInput = deepFix(jobRow.input || {});
      const proposalId =
        String(jobRow.proposal_id || result?.proposalId || result?.proposal_id || "").trim() || null;

      const incomingPack = mergePackAssets(result);
      const publishInfo = pickPublishInfo(result);

      let contentRow = null;

      if (proposalId && incomingPack && isDraftJobType(jt)) {
        contentRow = await dbUpsertDraftFromCallback(db, {
          proposalId,
          threadId: pickThreadId(result, jobInput),
          jobId,
          status: status === "completed" ? "draft.ready" : "draft.failed",
          contentPack: incomingPack,
        });
      }

      if (proposalId && isAssetJobType(jt)) {
        const contentId = pickContentId(result, jobInput);
        const rowToUpdate = await resolveDbContentRowForUpdate(db, proposalId, contentId);

        if (rowToUpdate) {
          const nextStatus = status === "completed" ? "asset.ready" : "asset.failed";
          const merged = mergeContentPack(rowToUpdate.content_pack, incomingPack, result, jt);

          contentRow = await dbUpdateContentItem(db, rowToUpdate.id, {
            status: nextStatus,
            content_pack: merged,
          });

          if (status === "completed") {
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
              })
            );
          }
        }
      }

      if (proposalId && isPublishJobType(jt)) {
        const contentId = pickContentId(result, jobInput);
        const rowToUpdate =
          (contentId && isUuid(contentId) ? await dbFindContentItemById(db, contentId) : null) ||
          (await dbGetLatestContentByProposal(db, proposalId));

        if (rowToUpdate) {
          const nextStatus = status === "completed" ? "published" : "publish.failed";

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
        }),
      });

      wsHub?.broadcast?.({ type: "execution.updated", execution: jobRow });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      if (contentRow) wsHub?.broadcast?.({ type: "content.updated", content: contentRow });

      await pushBroadcastToCeo({
        db,
        title:
          status === "completed"
            ? isPublishJobType(jt)
              ? "Published"
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
              : isAssetJobType(jt)
              ? "Vizual/video hazır oldu — Approved tab-a keçdi."
              : "AI draft yaratdı — baxıb təsdiqlə."
            : status === "running"
            ? "n8n hazırda işləyir…"
            : (errorText || "n8n error"),
        data: { type: "execution", jobId, proposalId, jobType: jt },
      });

      await dbAudit(db, "n8n", "execution.callback", "job", jobId, { status, jobType: jt });

      try {
        if (proposalId && contentRow?.status === "draft.ready") {
          const mode = await getTenantMode({ db, tenantId });
          if (mode === "auto") {
            const proposal = await dbGetProposalById(db, String(proposalId));
            if (proposal) {
              notifyN8n("draft.ready.auto", proposal, {
                tenantId,
                proposalId: String(proposalId),
                jobId,
                contentId: String(contentRow.id),
                callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
                result,
              });
            }
          }
        }
      } catch {}

      return okJson(res, {
        ok: true,
        jobId,
        status,
        jobType: jt,
        proposalId,
        contentId: contentRow?.id || null,
      });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: serializeError(e) });
    }
  });

  return r;
}