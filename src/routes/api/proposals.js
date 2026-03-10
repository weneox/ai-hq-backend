import express from "express";
import { resolveTenantKeyFromReq } from "../../tenancy/index.js";

import {
  okJson,
  clamp,
  isDbReady,
  isUuid,
  normalizeDecision,
} from "../../utils/http.js";
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

import {
  safePayload,
  safeTitle,
  safeTopic,
  safeFormat,
  safeAspectRatio,
  safeVisualPreset,
  safeImagePrompt,
  safeVideoPrompt,
  safeVoiceoverText,
  safeNeededAssets,
  safeReelMeta,
  normalizeRequestedStatus,
} from "./proposals.shared.js";

import {
  deriveUiStatusFromProposalAndContent,
  matchesRequestedUiStatus,
  mapProposalRow,
} from "./proposals.status.js";

import { buildN8nExtra } from "./proposals.notify.js";

function clean(v) {
  return String(v || "").trim();
}

function normalizeAutomationMode(v, fallback = "manual") {
  const x = clean(v || fallback).toLowerCase();
  if (x === "full_auto") return "full_auto";
  return "manual";
}

function pickDecisionActor(req, fallback = "ceo") {
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

export function proposalsRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/proposals", async (req, res) => {
    const rawStatus = normalizeRequestedStatus(req.query.status);
    const uiStatus =
      rawStatus === "pending" || rawStatus === "in_progress" ? "draft" : rawStatus;

    const limit = clamp(req.query.limit ?? 50, 1, 200);
    const includeContent = String(req.query.includeContent || "1") === "1";
    const includePack = String(req.query.includePack || "0") === "1";

    try {
      if (!isDbReady(db)) {
        const all = memListProposals()
          .map((p) => {
            const out = {
              ...p,
              title: fixText(p.title),
              payload: deepFix(p.payload),
            };

            let latestContent = null;
            if (includeContent) {
              const c = memGetLatestContentByProposal(p.id);
              latestContent = c
                ? {
                    id: c.id,
                    status: c.status,
                    updated_at: c.updated_at || c.created_at || null,
                    last_feedback: c.last_feedback || null,
                    publish: deepFix(c.publish || null),
                    ...(includePack ? { content_pack: deepFix(c.content_pack) } : {}),
                  }
                : null;

              out.latestContent = latestContent;
            }

            out.uiStatus = deriveUiStatusFromProposalAndContent(out, latestContent);
            return out;
          })
          .filter((p) => matchesRequestedUiStatus(uiStatus, p, p.latestContent))
          .sort((a, b) => {
            const am = Date.parse(a?.created_at || 0) || 0;
            const bm = Date.parse(b?.created_at || 0) || 0;
            return bm - am;
          })
          .slice(0, limit);

        return okJson(res, {
          ok: true,
          status: uiStatus,
          proposals: all,
          dbDisabled: true,
        });
      }

      const q = await db.query(
        `
        select
          p.id,
          p.thread_id,
          p.agent,
          p.type,
          p.status,
          p.title,
          p.payload,
          p.created_at,
          p.decided_at,
          p.decision_by,
          c.id as content_id,
          c.status as content_status,
          c.updated_at as content_updated_at,
          c.last_feedback as content_last_feedback,
          c.publish as content_publish,
          ${includePack ? "c.content_pack as content_pack," : ""}
          1 as _dummy
        from proposals p
        left join lateral (
          select
            id,
            status,
            content_pack,
            publish,
            last_feedback,
            updated_at,
            created_at
          from content_items
          where proposal_id = p.id
          order by updated_at desc nulls last, created_at desc
          limit 1
        ) c on true
        order by p.created_at desc
        limit ${Number(Math.max(limit * 6, 200))}
        `
      );

      const rows = (q.rows || [])
        .map((row) => mapProposalRow(row, includeContent, includePack))
        .filter((p) => matchesRequestedUiStatus(uiStatus, p, p.latestContent))
        .slice(0, limit);

      return okJson(res, {
        ok: true,
        status: uiStatus,
        proposals: rows,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = normalizeDecision(req.body?.decision);
    const by = pickDecisionActor(req, "ceo");
    const reason = fixText(String(req.body?.reason || "").trim());
    const tenantId = resolveTenantKeyFromReq(req);
    const automation = pickAutomationMeta(req);

    if (!id) {
      return okJson(res, { ok: false, error: "proposalId required" });
    }

    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, {
        ok: false,
        error: "decision must be approved|rejected",
      });
    }

    try {
      if (!isDbReady(db)) {
        const p = mem.proposals.get(id);
        if (!p) {
          return okJson(res, {
            ok: false,
            error: "proposal not found",
            dbDisabled: true,
          });
        }

        if (decision === "rejected") {
          p.status = "rejected";
          p.decision_by = by;
          p.decided_at = new Date().toISOString();
          p.payload = deepFix({
            ...safePayload(p),
            decision: "rejected",
            reason,
            automationMode: automation.mode,
          });

          const notif = memCreateNotification({
            recipient: "ceo",
            type: "info",
            title: "Proposal rejected",
            body: reason || safeTitle(p),
            payload: {
              proposalId: p.id,
              decision,
              reason,
              automationMode: automation.mode,
            },
          });

          wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          wsHub?.broadcast?.({ type: "notification.created", notification: notif });

          memAudit(by, "proposal.reject", "proposal", p.id, {
            reason,
            automationMode: automation.mode,
          });

          try {
            notifyN8n("proposal.rejected", p, {
              tenantId,
              proposalId: String(p.id),
              reason,
              topic: safeTopic(p),
              payload: deepFix(p.payload),
              automationMode: automation.mode,
              autoPublish: automation.autoPublish,
            });
          } catch {}

          return okJson(res, { ok: true, proposal: p, dbDisabled: true });
        }

        p.status = "in_progress";
        p.decision_by = by;
        p.decided_at = new Date().toISOString();
        p.payload = deepFix({
          ...safePayload(p),
          decision: "approved",
          reason,
          automationMode: automation.mode,
        });

        const job = memCreateJob({
          proposalId: p.id,
          type: "draft.generate",
          status: "queued",
          input: {
            proposalId: p.id,
            threadId: p.thread_id,
            title: safeTitle(p),
            topic: safeTopic(p),
            format: safeFormat(p),
            aspectRatio: safeAspectRatio(p),
            visualPreset: safeVisualPreset(p),
            imagePrompt: safeImagePrompt(p),
            videoPrompt: safeVideoPrompt(p),
            voiceoverText: safeVoiceoverText(p),
            neededAssets: safeNeededAssets(p),
            reelMeta: safeReelMeta(p),
            payload: deepFix(p.payload),
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
          },
        });

        const notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Drafting started",
          body:
            automation.mode === "full_auto"
              ? "Auto content draft hazırlanır…"
              : "n8n draft hazırlayır…",
          payload: {
            proposalId: p.id,
            jobId: job.id,
            automationMode: automation.mode,
          },
        });

        wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
        wsHub?.broadcast?.({ type: "execution.updated", execution: job });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        memAudit(by, "proposal.approve", "proposal", p.id, {
          reason,
          automationMode: automation.mode,
        });

        try {
          notifyN8n(
            "proposal.approved",
            p,
            buildN8nExtra({
              tenantId,
              proposal: p,
              jobId: job.id,
              reason,
              automationMode: automation.mode,
              autoPublish: automation.autoPublish,
            })
          );
        } catch {}

        return okJson(res, {
          ok: true,
          proposal: p,
          jobId: job.id,
          dbDisabled: true,
        });
      }

      const proposal = await dbGetProposalById(db, id);
      if (!proposal) {
        return okJson(res, { ok: false, error: "proposal not found" });
      }

      if (decision === "rejected") {
        const updated = await db.query(
          `update proposals
           set status = 'rejected',
               decided_at = now(),
               decision_by = $2::text,
               payload = (coalesce(payload,'{}'::jsonb) || $3::jsonb)
           where id::text = $1::text
           returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
          [id, by, deepFix({ decision: "rejected", reason, automationMode: automation.mode })]
        );

        const p2 = updated.rows?.[0] || null;
        if (!p2) {
          return okJson(res, { ok: false, error: "update failed" });
        }

        p2.title = fixText(p2.title);
        p2.payload = deepFix(p2.payload);

        const notif = await dbCreateNotification(db, {
          recipient: "ceo",
          type: "info",
          title: "Proposal rejected",
          body: reason || safeTitle(p2),
          payload: {
            proposalId: p2.id,
            decision: "rejected",
            reason,
            automationMode: automation.mode,
          },
        });

        wsHub?.broadcast?.({ type: "proposal.updated", proposal: p2 });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        await pushBroadcastToCeo({
          db,
          title: "Rejected",
          body: safeTitle(p2) || "Proposal rejected",
          data: {
            type: "proposal.rejected",
            proposalId: p2.id,
            automationMode: automation.mode,
          },
        });

        await dbAudit(db, by, "proposal.reject", "proposal", String(p2.id), {
          reason,
          automationMode: automation.mode,
        });

        try {
          notifyN8n("proposal.rejected", p2, {
            tenantId,
            proposalId: String(p2.id),
            reason,
            topic: safeTopic(p2),
            payload: deepFix(p2.payload),
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
          });
        } catch {}

        return okJson(res, { ok: true, proposal: p2 });
      }

      const updatedQ = await db.query(
        `update proposals
         set status = 'in_progress',
             decided_at = now(),
             decision_by = $2::text,
             payload = (coalesce(payload,'{}'::jsonb) || $3::jsonb)
         where id::text = $1::text
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [id, by, deepFix({ decision: "approved", reason, automationMode: automation.mode })]
      );

      const p2 = updatedQ.rows?.[0] || null;
      if (!p2) {
        return okJson(res, { ok: false, error: "update failed" });
      }

      p2.title = fixText(p2.title);
      p2.payload = deepFix(p2.payload);

      const job = await dbCreateJob(db, {
        proposalId: p2.id,
        type: "draft.generate",
        status: "queued",
        input: {
          proposalId: p2.id,
          threadId: p2.thread_id,
          title: safeTitle(p2),
          topic: safeTopic(p2),
          format: safeFormat(p2),
          aspectRatio: safeAspectRatio(p2),
          visualPreset: safeVisualPreset(p2),
          imagePrompt: safeImagePrompt(p2),
          videoPrompt: safeVideoPrompt(p2),
          voiceoverText: safeVoiceoverText(p2),
          neededAssets: safeNeededAssets(p2),
          reelMeta: safeReelMeta(p2),
          payload: deepFix(p2.payload),
          automationMode: automation.mode,
          autoPublish: automation.autoPublish,
        },
      });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Drafting started",
        body:
          automation.mode === "full_auto"
            ? "Auto content draft hazırlanır…"
            : "n8n draft hazırlayır…",
        payload: {
          proposalId: p2.id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      wsHub?.broadcast?.({ type: "proposal.updated", proposal: p2 });
      wsHub?.broadcast?.({ type: "execution.updated", execution: job });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: automation.mode === "full_auto" ? "Auto drafting başladı" : "Drafting başladı",
        body: safeTitle(p2) || "Draft hazırlanır…",
        data: {
          type: "proposal.in_progress",
          proposalId: p2.id,
          jobId: job?.id || null,
          automationMode: automation.mode,
        },
      });

      await dbAudit(db, by, "proposal.approve", "proposal", String(p2.id), {
        reason,
        automationMode: automation.mode,
      });

      try {
        notifyN8n(
          "proposal.approved",
          p2,
          buildN8nExtra({
            tenantId,
            proposal: p2,
            jobId: job?.id || null,
            reason,
            automationMode: automation.mode,
            autoPublish: automation.autoPublish,
          })
        );
      } catch {}

      return okJson(res, {
        ok: true,
        proposal: p2,
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

  r.post("/proposals/:id/request-changes", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();
    const feedbackText = fixText(String(req.body?.feedbackText || "").trim());

    if (!proposalId) {
      return okJson(res, { ok: false, error: "proposalId required" });
    }
    if (!feedbackText) {
      return okJson(res, { ok: false, error: "feedbackText required" });
    }
    if (!isUuid(proposalId)) {
      return okJson(res, { ok: false, error: "proposalId must be uuid" });
    }

    try {
      if (!isDbReady(db)) {
        const content = memGetLatestContentByProposal(proposalId);
        if (!content) {
          return okJson(res, {
            ok: false,
            error: "no content for proposal",
            dbDisabled: true,
          });
        }

        return okJson(res, {
          ok: true,
          contentId: content.id,
          dbDisabled: true,
        });
      }

      const content = await dbGetLatestDraftLikeByProposal(db, proposalId);
      if (!content) {
        return okJson(res, { ok: false, error: "no content for proposal" });
      }

      return okJson(res, { ok: true, contentId: content.id });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/proposals/:id/publish", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();

    if (!proposalId) {
      return okJson(res, { ok: false, error: "proposalId required" });
    }
    if (!isUuid(proposalId)) {
      return okJson(res, { ok: false, error: "proposalId must be uuid" });
    }

    try {
      if (!isDbReady(db)) {
        const c = memGetLatestContentByProposal(proposalId);
        if (!c) {
          return okJson(res, {
            ok: false,
            error: "no content for proposal",
            dbDisabled: true,
          });
        }

        return okJson(res, {
          ok: true,
          contentId: c.id,
          dbDisabled: true,
        });
      }

      const c = await dbGetLatestApprovedDraftByProposal(db, proposalId);
      if (!c) {
        return okJson(res, {
          ok: false,
          error: "no draft.approved content found",
        });
      }

      return okJson(res, { ok: true, contentId: c.id });
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