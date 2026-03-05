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
  dbGetLatestDraftLikeByProposal,
} from "../../db/helpers/content.js";
import { dbCreateNotification } from "../../db/helpers/notifications.js";
import { dbAudit } from "../../db/helpers/audit.js";

import { pushBroadcastToCeo } from "../../services/pushBroadcast.js";
import { notifyN8n } from "../../services/n8nNotify.js";
import { getTenantMode } from "./mode.js";

function pickJobId(req) {
  return String(req.body?.jobId || req.body?.job_id || req.body?.id || "").trim();
}

function normalizeStatus(x) {
  const s = String(x || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "complete") return "completed";
  if (s === "done") return "completed";
  return s;
}

function pickTenantIdFromResult(result) {
  return (
    fixText(
      String(result?.tenantId || result?.tenant_id || cfg.DEFAULT_TENANT_KEY || "default").trim()
    ) || "default"
  );
}

// Merge assets into pack (prevents missing assets bug)
function mergePackAssets(result) {
  const rawPack = result?.contentPack || result?.content_pack || result?.draft || result?.pack || null;
  const assets = Array.isArray(result?.assets) ? result.assets : [];

  if (rawPack && typeof rawPack === "object") {
    const rpAssets = Array.isArray(rawPack.assets) ? rawPack.assets : [];
    return deepFix({
      ...rawPack,
      assets: rpAssets.length ? rpAssets : assets,
    });
  }

  // If pack is missing but assets exist, still return a pack
  if (assets.length) return deepFix({ assets });

  return null;
}

// publish info normalize
function pickPublishInfo(result) {
  const pub =
    (result?.publish && typeof result.publish === "object" ? result.publish : null) ||
    (result?.published && typeof result.published === "object" ? result.published : null) ||
    null;

  const publishedMediaId =
    result?.publishedMediaId ||
    result?.published_media_id ||
    pub?.publishedMediaId ||
    pub?.published_media_id ||
    pub?.mediaId ||
    pub?.id ||
    null;

  const permalink =
    result?.permalink ||
    result?.postUrl ||
    result?.post_url ||
    pub?.permalink ||
    pub?.url ||
    null;

  const platform = result?.platform || pub?.platform || "instagram";

  return deepFix({
    platform,
    publishedMediaId: publishedMediaId ? String(publishedMediaId) : null,
    permalink: permalink ? String(permalink) : null,
    raw: pub ? deepFix(pub) : null,
  });
}

// Try to find contentId from result/job.input
function pickContentId(result, jobInput) {
  const cid =
    result?.contentId ||
    result?.content_id ||
    result?.draftId ||
    result?.draft_id ||
    (jobInput && typeof jobInput === "object"
      ? (jobInput.contentId || jobInput.content_id || jobInput.draftId || jobInput.draft_id)
      : null) ||
    null;

  return cid ? String(cid) : null;
}

function jobTypeLc(x) {
  return String(x || "").trim().toLowerCase();
}

export function executionsRoutes({ db, wsHub }) {
  const r = express.Router();

  // GET /api/executions?status=&limit=&executionId=
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
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // GET /api/executions/:id
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
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // POST /api/executions/callback  (n8n -> HQ)
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

      // ========== MEMORY ==========
      if (!isDbReady(db)) {
        const job = mem.jobs.get(jobId);
        if (!job) return okJson(res, { ok: false, error: "job not found", dbDisabled: true });

        memUpdateJob(jobId, patch);

        const jt = jobTypeLc(job.type);
        const proposalId =
          String(job.proposal_id || result?.proposalId || result?.proposal_id || "").trim() || null;
        const tenantId = pickTenantIdFromResult(result);
        const jobInput = deepFix(job.input || {});
        const contentIdFromInput = pickContentId(result, jobInput);

        const contentPack = mergePackAssets(result);
        const publishInfo = pickPublishInfo(result);

        let contentRow = null;

        // ✅ DRAFT callbacks
        if (
          proposalId &&
          contentPack &&
          (jt.startsWith("draft") || jt === "content.draft" || jt === "draft.generate" || jt === "draft.regen")
        ) {
          contentRow = memUpsertContentItem({
            proposalId,
            threadId:
              result?.threadId || result?.thread_id || jobInput?.threadId || jobInput?.thread_id || null,
            jobId,
            status: status === "completed" ? "draft.ready" : "draft.failed",
            contentPack,
          });
          wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
        }

        // ✅ ASSET GENERATE callbacks (THIS WAS MISSING)
        if (proposalId && (jt === "asset.generate" || jt === "content.assets.generate")) {
          const target =
            contentIdFromInput ? (mem.contentItems.get(contentIdFromInput) || null) : memGetLatestContentByProposal(proposalId);

          if (target) {
            const nextStatus = status === "completed" ? "asset.ready" : "asset.failed";
            // merge assets into existing pack
            const prevPack = deepFix(target.content_pack || {});
            const merged = deepFix({ ...prevPack, ...(contentPack || {}) });

            memPatchContentItem(target.id, {
              status: nextStatus,
              content_pack: merged,
              assets: Array.isArray(merged.assets) ? merged.assets : (Array.isArray(result?.assets) ? result.assets : []),
            });

            contentRow = mem.contentItems.get(target.id) || null;

            // proposal becomes APPROVED only after assets ready
            const p = mem.proposals.get(proposalId) || null;
            if (p && status === "completed") p.status = "approved";

            wsHub?.broadcast?.({ type: "content.updated", content: contentRow });
            wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          }
        }

        // ✅ PUBLISH callbacks
        if (proposalId && (jt === "publish" || jt === "content.publish")) {
          const latest =
            contentIdFromInput ? (mem.contentItems.get(contentIdFromInput) || null) : memGetLatestContentByProposal(proposalId);

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

        const notif = memCreateNotification({
          recipient: "ceo",
          type: status === "completed" ? "success" : status === "running" ? "info" : "error",
          title:
            status === "completed"
              ? (jt === "publish" || jt === "content.publish"
                  ? "Published"
                  : jt === "asset.generate" || jt === "content.assets.generate"
                  ? "Assets ready"
                  : "Draft ready")
              : status === "running"
              ? "Execution running"
              : "Execution failed",
          body:
            status === "completed"
              ? (jt === "publish" || jt === "content.publish"
                  ? "Instagram paylaşımı edildi."
                  : jt === "asset.generate" || jt === "content.assets.generate"
                  ? "Assets hazır oldu."
                  : "Draft hazır oldu.")
              : status === "running"
              ? "İcra gedir…"
              : (errorText || "n8n failed"),
          payload: { jobId, status, proposalId, contentId: contentRow?.id || null, publish: publishInfo },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit("n8n", "execution.callback", "job", jobId, { status, jobType: jt });

        return okJson(res, { ok: true, jobId, status, dbDisabled: true });
      }

      // ========== DB ==========
      const jobRow = await dbUpdateJob(db, jobId, patch);
      if (!jobRow) return okJson(res, { ok: false, error: "job not found" });

      const jt = jobTypeLc(jobRow.type);
      const tenantId = pickTenantIdFromResult(result);
      const jobInput = deepFix(jobRow.input || {});
      const proposalId =
        String(jobRow.proposal_id || result?.proposalId || result?.proposal_id || "").trim() || null;

      const contentPack = mergePackAssets(result);
      const publishInfo = pickPublishInfo(result);

      let contentRow = null;

      // ✅ DRAFT callback
      if (
        proposalId &&
        contentPack &&
        (jt.startsWith("draft") || jt === "content.draft" || jt === "draft.generate" || jt === "draft.regen")
      ) {
        contentRow = await dbUpsertDraftFromCallback(db, {
          proposalId,
          threadId: result?.threadId || result?.thread_id || jobInput?.threadId || jobInput?.thread_id || null,
          jobId,
          status: status === "completed" ? "draft.ready" : "draft.failed",
          contentPack,
        });
      }

      // ✅ ASSET GENERATE callback (THIS WAS MISSING)
      if (proposalId && (jt === "asset.generate" || jt === "content.assets.generate")) {
        const contentId = pickContentId(result, jobInput);

        // choose which content row to update
        let rowToUpdate = null;

        if (contentId && isUuid(contentId)) {
          rowToUpdate = await dbUpdateContentItem(db, contentId, {}); // fetch row
        }
        if (!rowToUpdate) {
          rowToUpdate = await dbGetLatestDraftLikeByProposal(db, proposalId);
          if (!rowToUpdate) rowToUpdate = await dbGetLatestContentByProposal(db, proposalId);
        }

        if (rowToUpdate) {
          const nextStatus = status === "completed" ? "asset.ready" : "asset.failed";

          const prevPack = deepFix(rowToUpdate.content_pack || {});
          const merged = deepFix({ ...prevPack, ...(contentPack || {}) });

          contentRow = await dbUpdateContentItem(db, rowToUpdate.id, {
            status: nextStatus,
            content_pack: merged,
          });

          // proposal becomes APPROVED only after assets ready
          if (status === "completed") {
            await dbSetProposalStatus(db, String(proposalId), "approved", deepFix({ assets: merged.assets || [] }));
          }
        }
      }

      // ✅ PUBLISH callback
      if (proposalId && (jt === "publish" || jt === "content.publish")) {
        const contentId = pickContentId(result, jobInput);

        let rowToUpdate = null;

        if (contentId && isUuid(contentId)) {
          rowToUpdate = await dbUpdateContentItem(db, contentId, {});
        }

        if (!rowToUpdate) {
          rowToUpdate = await dbGetLatestContentByProposal(db, proposalId);
        }

        if (rowToUpdate) {
          const nextStatus = status === "completed" ? "published" : "publish.failed";

          contentRow = await dbUpdateContentItem(db, rowToUpdate.id, {
            status: nextStatus,
            publish: deepFix({ ...publishInfo, status, finished_at }),
          });

          if (status === "completed") {
            await dbSetProposalStatus(db, String(proposalId), "published", deepFix({ publish: publishInfo }));
          }
        }
      }

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: status === "completed" ? "success" : status === "running" ? "info" : "error",
        title:
          status === "completed"
            ? (jt === "publish" || jt === "content.publish"
                ? "Published"
                : jt === "asset.generate" || jt === "content.assets.generate"
                ? "Assets ready"
                : "Draft ready")
            : status === "running"
            ? "Execution running"
            : "Execution failed",
        body:
          status === "completed"
            ? (jt === "publish" || jt === "content.publish"
                ? "Instagram paylaşımı edildi."
                : jt === "asset.generate" || jt === "content.assets.generate"
                ? "Assets hazır oldu."
                : "Draft hazır oldu.")
            : status === "running"
            ? "İcra gedir…"
            : (errorText || "n8n failed"),
        payload: deepFix({
          jobId,
          status,
          proposalId,
          contentId: contentRow?.id || null,
          publish: publishInfo,
        }),
      });

      wsHub?.broadcast?.({ type: "execution.updated", execution: jobRow });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      if (contentRow) wsHub?.broadcast?.({ type: "content.updated", content: contentRow });

      await pushBroadcastToCeo({
        db,
        title:
          status === "completed"
            ? (jt === "publish" || jt === "content.publish"
                ? "Published"
                : jt === "asset.generate" || jt === "content.assets.generate"
                ? "Assets hazırdır"
                : "Draft hazırdır")
            : status === "running"
            ? "İcra gedir"
            : "Execution failed",
        body:
          status === "completed"
            ? (jt === "publish" || jt === "content.publish"
                ? "Post paylaşıldı."
                : jt === "asset.generate" || jt === "content.assets.generate"
                ? "Vizual hazır oldu — Approved tab-a keçdi."
                : "AI draft yaratdı — baxıb təsdiqlə.")
            : status === "running"
            ? "n8n hazırda işləyir…"
            : (errorText || "n8n error"),
        data: { type: "execution", jobId, proposalId, jobType: jt },
      });

      await dbAudit(db, "n8n", "execution.callback", "job", jobId, { status, jobType: jt });

      // AUTO mode hook (safe) — only for drafts
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