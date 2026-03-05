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
  memGetLatestContentByProposal,
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

function pickJobId(req) {
  return String(req.body?.jobId || req.body?.job_id || req.body?.id || "").trim();
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
  // body: { jobId, status:"completed"|"failed"|"running", result:{...} }
  r.post("/executions/callback", async (req, res) => {
    if (!requireCallbackToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (invalid callback token)" });
    }

    const jobId = pickJobId(req);
    const status = String(req.body?.status || "").trim().toLowerCase();
    const result = deepFix(req.body?.result || req.body?.output || {});
    const errorText = req.body?.error ? fixText(String(req.body.error)) : null;

    if (!jobId) return okJson(res, { ok: false, error: "jobId required" });
    if (!isUuid(jobId)) return okJson(res, { ok: false, error: "jobId must be uuid" });
    if (!status) return okJson(res, { ok: false, error: "status required" });

    try {
      const finished_at = nowIso();
      const patch = {
        status,
        output: result ? deepFix({ result }) : deepFix({}),
        error: errorText,
        finished_at,
      };

      // Helper: merge assets into contentPack (FIX)
      function pickContentPackWithAssets(jobProposalId) {
        const rawPack = result?.contentPack || result?.content_pack || result?.draft || null;
        const assets = Array.isArray(result?.assets) ? result.assets : [];
        const merged =
          rawPack && typeof rawPack === "object"
            ? deepFix({
                ...rawPack,
                assets: Array.isArray(rawPack.assets) ? rawPack.assets : assets,
              })
            : null;

        const proposalId = jobProposalId || result?.proposalId || result?.proposal_id || null;
        return { proposalId, contentPack: merged };
      }

      // ========== MEMORY ==========
      if (!isDbReady(db)) {
        const job = mem.jobs.get(jobId);
        if (!job) return okJson(res, { ok: false, error: "job not found", dbDisabled: true });

        memUpdateJob(jobId, patch);

        const { proposalId, contentPack } = pickContentPackWithAssets(job.proposal_id);

        let contentRow = null;
        if (proposalId && contentPack && typeof contentPack === "object") {
          contentRow = memUpsertContentItem({
            proposalId,
            threadId: result?.threadId || result?.thread_id || null,
            jobId,
            status: status === "completed" ? "draft.ready" : "draft.failed",
            contentPack,
          });
        }

        const notif = memCreateNotification({
          recipient: "ceo",
          type: status === "completed" ? "success" : status === "running" ? "info" : "error",
          title:
            status === "completed"
              ? "Execution completed"
              : status === "running"
              ? "Execution running"
              : "Execution failed",
          body:
            status === "completed"
              ? "Draft hazır oldu."
              : status === "running"
              ? "İcra gedir…"
              : (errorText || "n8n failed"),
          payload: { jobId, status, proposalId, content: contentRow },
        });

        wsHub?.broadcast?.({ type: "execution.updated", execution: mem.jobs.get(jobId) });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });
        if (contentRow) wsHub?.broadcast?.({ type: "content.updated", content: contentRow });

        return okJson(res, { ok: true, jobId, status, dbDisabled: true });
      }

      // ========== DB ==========
      const jobRow = await dbUpdateJob(db, jobId, patch);
      if (!jobRow) return okJson(res, { ok: false, error: "job not found" });

      const { proposalId, contentPack } = pickContentPackWithAssets(jobRow.proposal_id);

      let contentRow = null;
      if (proposalId && contentPack && typeof contentPack === "object") {
        contentRow = await dbUpsertDraftFromCallback(db, {
          proposalId,
          threadId: result?.threadId || result?.thread_id || jobRow?.thread_id || null,
          jobId,
          status: status === "completed" ? "draft.ready" : "draft.failed",
          contentPack,
        });
      }

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: status === "completed" ? "success" : status === "running" ? "info" : "error",
        title:
          status === "completed"
            ? "Execution completed"
            : status === "running"
            ? "Execution running"
            : "Execution failed",
        body:
          status === "completed"
            ? "Draft hazır oldu."
            : status === "running"
            ? "İcra gedir…"
            : (errorText || "n8n failed"),
        payload: { jobId, status, proposalId, contentId: contentRow?.id || null },
      });

      wsHub?.broadcast?.({ type: "execution.updated", execution: jobRow });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      if (contentRow) wsHub?.broadcast?.({ type: "content.updated", content: contentRow });

      await pushBroadcastToCeo({
        db,
        title: status === "completed" ? "Draft hazırdır" : status === "running" ? "İcra gedir" : "Execution failed",
        body:
          status === "completed"
            ? "AI draft yaratdı — baxıb təsdiqlə."
            : status === "running"
            ? "n8n hazırda işləyir…"
            : (errorText || "n8n error"),
        data: { type: "execution", jobId, proposalId },
      });

      await dbAudit(db, "n8n", "execution.callback", "job", jobId, { status });

      // AUTO mode hook (safe)
      try {
        if (proposalId && contentRow?.status === "draft.ready") {
          const tenantId = result?.tenantId || cfg.DEFAULT_TENANT_KEY || "default";
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

      return okJson(res, { ok: true, jobId, status });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: serializeError(e) });
    }
  });

  return r;
}