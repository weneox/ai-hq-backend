// src/routes/api.js (FINAL v2.5 — Notifications + Jobs + n8n callback + Audit)
// ✅ CEO-only in-app notifications (DB + memory fallback)
// ✅ Jobs tracking: approve -> create job -> send to n8n -> callback updates job
// ✅ Legacy-safe proposals.id TEXT/UUID decision endpoint (id::text)
// ✅ WS events: proposal.created / proposal.updated / thread.message / notification.* / job.updated
// ✅ n8n payload contract stabilized: {event, proposalId, threadId, jobId, callback{url,tokenHeader}, ...}
// ✅ Callback hardened: header-only token, uuid guard, status validation

import express from "express";
import crypto from "crypto";
import { cfg } from "../config.js";
import { runDebate, DEBATE_ENGINE_VERSION } from "../kernel/debateEngine.js";
import { kernelHandle, listAgents, debugOpenAI } from "../kernel/agentKernel.js";
import { postToN8n } from "../utils/n8n.js";

function okJson(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(payload);
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function requireDebugToken(req) {
  const expected = String(cfg.DEBUG_API_TOKEN || "").trim();
  if (!expected) return false;

  const token = String(req.headers["x-debug-token"] || req.query.token || req.body?.token || "").trim();
  return Boolean(token) && token === expected;
}

function isDbReady(db) {
  return Boolean(db && typeof db.query === "function");
}

function serializeError(err) {
  const e = err || {};
  const isAgg = e && (e.name === "AggregateError" || Array.isArray(e.errors));

  const base = {
    name: e.name || "Error",
    message: e.message || String(e),
    stack: e.stack || null,
  };

  if (isAgg) {
    base.errors = (e.errors || []).map((x) => ({
      name: x?.name || "Error",
      message: x?.message || String(x),
      stack: x?.stack || null,
    }));
  }

  if (e.cause) {
    base.cause = {
      name: e.cause?.name,
      message: e.cause?.message || String(e.cause),
      stack: e.cause?.stack || null,
    };
  }

  return base;
}

function normalizeDecision(d) {
  let decision = String(d || "").trim().toLowerCase();
  if (decision === "approve") decision = "approved";
  if (decision === "reject") decision = "rejected";
  return decision;
}

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "approved" || s === "rejected";
}

function nowIso() {
  return new Date().toISOString();
}

function isUuid(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function callbackTokenExpected() {
  return String(cfg.N8N_CALLBACK_TOKEN || cfg.N8N_WEBHOOK_TOKEN || "").trim();
}

function requireCallbackToken(req) {
  const expected = callbackTokenExpected();
  if (!expected) return true; // dev allow if not configured

  // header-only (most reliable + matches your n8n setup)
  const got = String(req.headers["x-webhook-token"] || req.headers["x-callback-token"] || "").trim();
  return Boolean(got) && got === expected;
}

/** ===========================
 *  In-memory fallback (DB off)
 * =========================== */
const mem = {
  threads: new Map(),
  messages: new Map(),
  proposals: new Map(),
  notifications: new Map(), // id -> row
  jobs: new Map(), // id -> row
  audit: [],
};

function memEnsureThread(threadId, title) {
  if (!mem.threads.has(threadId)) {
    mem.threads.set(threadId, {
      id: threadId,
      title: title || `Thread ${nowIso()}`,
      created_at: nowIso(),
    });
  }
  if (!mem.messages.has(threadId)) mem.messages.set(threadId, []);
  return mem.threads.get(threadId);
}

function memAddMessage(threadId, { role, agent, content, meta }) {
  memEnsureThread(threadId);
  const arr = mem.messages.get(threadId);
  const row = {
    id: crypto.randomUUID(),
    thread_id: threadId,
    role,
    agent: agent || null,
    content: content || "",
    meta: meta || {},
    created_at: nowIso(),
  };
  arr.push(row);
  return row;
}

function memCreateProposal(threadId, { agent, type, title, payload }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    thread_id: threadId,
    agent: agent || "orion",
    type: type || "generic",
    status: "pending",
    title: title || "",
    payload: payload || {},
    created_at: nowIso(),
    decided_at: null,
    decision_by: null,
  };
  mem.proposals.set(id, row);
  return row;
}

function memListProposals(status = "pending") {
  const out = [];
  for (const p of mem.proposals.values()) {
    if (String(p.status) === String(status)) out.push(p);
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, 100);
}

function memCreateNotification({ recipient = "ceo", type = "info", title = "", body = "", payload = {} }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    recipient,
    type,
    title,
    body,
    payload,
    read_at: null,
    created_at: nowIso(),
  };
  mem.notifications.set(id, row);
  return row;
}

function memListNotifications({ recipient = "ceo", unreadOnly = false, limit = 50 }) {
  const rows = [];
  for (const n of mem.notifications.values()) {
    if (n.recipient !== recipient) continue;
    if (unreadOnly && n.read_at) continue;
    rows.push(n);
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

function memMarkRead(id) {
  const row = mem.notifications.get(id);
  if (!row) return null;
  if (!row.read_at) row.read_at = nowIso();
  return row;
}

function memCreateJob({ proposalId = null, type = "generic", status = "queued", input = {} }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    proposal_id: proposalId,
    type,
    status,
    input,
    output: {},
    error: null,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
  };
  mem.jobs.set(id, row);
  return row;
}

function memUpdateJob(id, patch) {
  const row = mem.jobs.get(id);
  if (!row) return null;
  Object.assign(row, patch || {});
  return row;
}

function memAudit(actor, action, objectType, objectId, meta = {}) {
  mem.audit.push({
    id: crypto.randomUUID(),
    actor: actor || "system",
    action,
    object_type: objectType || "unknown",
    object_id: objectId || null,
    meta,
    created_at: nowIso(),
  });
}

/** ===========================
 *  n8n notify helper (stable contract)
 * =========================== */
function notifyN8n(event, proposal, extra = {}) {
  const url = String(cfg.N8N_WEBHOOK_URL || "").trim();
  if (!url) return;

  const payload = {
    event,

    // stable ids
    proposalId: extra.proposalId || proposal?.id || null,
    threadId: extra.threadId || proposal?.thread_id || null,

    // who/when
    by: extra.by || proposal?.decision_by || "unknown",
    decidedAt: extra.decidedAt || proposal?.decided_at || null,

    // execution tracking
    jobId: extra.jobId || null,

    // callback contract for n8n
    callback: extra.callback || {
      url: "/api/executions/callback",
      tokenHeader: "x-webhook-token",
    },

    // optional structured fields (if you include them in proposal payload)
    title: proposal?.title || extra.title || null,
    summary: extra.summary || null,
    tasks: extra.tasks || null,
    ownerMap: extra.ownerMap || null,
    decision: extra.decision || proposal?.status || null,

    // full context
    proposal: proposal || null,

    // allow extension
    ...extra,
  };

  postToN8n({
    url,
    token: String(cfg.N8N_WEBHOOK_TOKEN || "").trim(),
    timeoutMs: Number(cfg.N8N_TIMEOUT_MS || 10_000),
    payload,
  })
    .then((r) => console.log(`[n8n] ${event} →`, r.ok, r.status || r.error, (r.text || "").slice(0, 160)))
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}

function fallbackSynthesisFromNotes(out) {
  const notes = Array.isArray(out?.agentNotes) ? out.agentNotes : [];
  const parts = [];
  for (const n of notes) {
    const t = String(n?.text || "").trim();
    if (!t) continue;
    parts.push(`### ${n.agentId}\n${t}`);
  }
  return parts.join("\n\n").trim();
}

/** ===========================
 *  DB helpers: notifications/jobs/audit
 * =========================== */
async function dbAudit(db, actor, action, objectType, objectId, meta) {
  if (!isDbReady(db)) return;
  try {
    await db.query(
      `insert into audit_log (actor, action, object_type, object_id, meta)
       values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)`,
      [actor || "system", action, objectType || "unknown", objectId || null, meta || {}]
    );
  } catch {}
}

async function dbCreateNotification(db, { recipient = "ceo", type = "info", title = "", body = "", payload = {} }) {
  const q = await db.query(
    `insert into notifications (recipient, type, title, body, payload)
     values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [recipient, type, title, body, payload]
  );
  return q.rows?.[0] || null;
}

async function dbListNotifications(db, { recipient = "ceo", unreadOnly = false, limit = 50 }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  if (unreadOnly) {
    const q = await db.query(
      `select id, recipient, type, title, body, payload, read_at, created_at
       from notifications
       where recipient = $1::text and read_at is null
       order by created_at desc
       limit ${lim}`,
      [recipient]
    );
    return q.rows || [];
  }

  const q = await db.query(
    `select id, recipient, type, title, body, payload, read_at, created_at
     from notifications
     where recipient = $1::text
     order by created_at desc
     limit ${lim}`,
    [recipient]
  );
  return q.rows || [];
}

async function dbMarkNotificationRead(db, id) {
  const q = await db.query(
    `update notifications
     set read_at = coalesce(read_at, now())
     where id = $1::uuid
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [id]
  );
  return q.rows?.[0] || null;
}

async function dbCreateJob(db, { proposalId = null, type = "generic", status = "queued", input = {} }) {
  const q = await db.query(
    `insert into jobs (proposal_id, type, status, input)
     values ($1::uuid, $2::text, $3::text, $4::jsonb)
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [proposalId, type, status, input]
  );
  return q.rows?.[0] || null;
}

async function dbUpdateJob(db, id, patch) {
  const status = patch?.status ?? null;
  const output = patch?.output ?? null;
  const error = patch?.error ?? null;
  const started = patch?.started_at ?? null;
  const finished = patch?.finished_at ?? null;

  const q = await db.query(
    `update jobs
     set status = coalesce($2::text, status),
         output = case when $3::jsonb is null then output else (coalesce(output,'{}'::jsonb) || $3::jsonb) end,
         error = coalesce($4::text, error),
         started_at = coalesce($5::timestamptz, started_at),
         finished_at = coalesce($6::timestamptz, finished_at)
     where id = $1::uuid
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [id, status, output, error, started, finished]
  );
  return q.rows?.[0] || null;
}

/** ===========================
 *  Router
 * =========================== */
export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  r.get("/", (_req, res) =>
    okJson(res, {
      ok: true,
      service: "ai-hq-backend",
      db: { enabled: isDbReady(db) },
      debateEngine: DEBATE_ENGINE_VERSION,
      endpoints: [
        "GET /api",
        "GET /api/agents",
        "POST /api/chat",
        "POST /api/debate",
        "GET /api/threads/:id/messages",
        "GET /api/proposals?status=pending",
        "POST /api/proposals/:id/decision",
        "GET /api/notifications?recipient=ceo&unread=1",
        "POST /api/notifications/:id/read",
        "POST /api/executions/callback (token)",
        "POST /api/debug/openai (token)",
      ],
    })
  );

  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));

  /** ===========================
   * Notifications (CEO-only)
   * =========================== */
  r.get("/notifications", async (req, res) => {
    const recipient = String(req.query.recipient || "ceo").trim() || "ceo";
    const unreadOnly = String(req.query.unread || "").trim() === "1";
    const limit = clamp(req.query.limit ?? 50, 1, 200);

    try {
      if (!isDbReady(db)) {
        const rows = memListNotifications({ recipient, unreadOnly, limit });
        return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows, dbDisabled: true });
      }

      const rows = await dbListNotifications(db, { recipient, unreadOnly, limit });
      return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/notifications] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  r.post("/notifications/:id/read", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "notification id required" });

    try {
      if (!isDbReady(db)) {
        const row = memMarkRead(id);
        if (!row) return okJson(res, { ok: false, error: "not found", dbDisabled: true });
        try {
          wsHub?.broadcast?.({ type: "notification.read", notification: row });
        } catch {}
        memAudit("ceo", "notification.read", "notification", id, {});
        return okJson(res, { ok: true, notification: row, dbDisabled: true });
      }

      const row = await dbMarkNotificationRead(db, id);
      if (!row) return okJson(res, { ok: false, error: "not found" });

      try {
        wsHub?.broadcast?.({ type: "notification.read", notification: row });
      } catch {}
      await dbAudit(db, "ceo", "notification.read", "notification", String(row.id), {});
      return okJson(res, { ok: true, notification: row });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/notifications/:id/read] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * n8n -> HQ callback (job updates)
   * =========================== */
  r.post("/executions/callback", async (req, res) => {
    if (!requireCallbackToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (missing/invalid token)" });
    }

    const jobId = String(req.body?.jobId || req.body?.id || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();
    const result = req.body?.result && typeof req.body.result === "object" ? req.body.result : {};
    const error = String(req.body?.error || "").trim();

    if (!jobId) return okJson(res, { ok: false, error: "jobId required" });
    if (!isUuid(jobId)) return okJson(res, { ok: false, error: "jobId must be uuid" });
    if (!["running", "completed", "failed"].includes(status)) {
      return okJson(res, { ok: false, error: 'status must be "running"|"completed"|"failed"' });
    }

    try {
      // MEMORY mode
      if (!isDbReady(db)) {
        const patch = {
          status,
          output: result || {},
          error: error || null,
          started_at: status === "running" ? nowIso() : null,
          finished_at: status === "completed" || status === "failed" ? nowIso() : null,
        };
        const row = memUpdateJob(jobId, patch);
        if (!row) return okJson(res, { ok: false, error: "job not found", dbDisabled: true });

        try {
          wsHub?.broadcast?.({ type: "job.updated", job: row });
        } catch {}
        memAudit("n8n", "job.update", "job", jobId, { status });

        const n = memCreateNotification({
          recipient: "ceo",
          type: status === "completed" ? "success" : status === "failed" ? "danger" : "info",
          title: `Execution ${status.toUpperCase()}`,
          body: status === "failed" ? error || "Execution failed" : "Execution update received",
          payload: { jobId, status, result },
        });
        try {
          wsHub?.broadcast?.({ type: "notification.created", notification: n });
        } catch {}

        return okJson(res, { ok: true, job: row, notification: n, dbDisabled: true });
      }

      // DB mode
      const patch = {
        status,
        output: result || {},
        error: error || null,
        started_at: status === "running" ? nowIso() : null,
        finished_at: status === "completed" || status === "failed" ? nowIso() : null,
      };

      const row = await dbUpdateJob(db, jobId, patch);
      if (!row) return okJson(res, { ok: false, error: "job not found" });

      try {
        wsHub?.broadcast?.({ type: "job.updated", job: row });
      } catch {}
      await dbAudit(db, "n8n", "job.update", "job", String(jobId), { status });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: status === "completed" ? "success" : status === "failed" ? "danger" : "info",
        title: `Execution ${status.toUpperCase()}`,
        body: status === "failed" ? error || "Execution failed" : "Execution update received",
        payload: { jobId, status, result },
      });
      try {
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      } catch {}

      return okJson(res, { ok: true, job: row, notification: notif });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/executions/callback] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Threads/messages
   * =========================== */
  r.get("/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "thread id required" });

    try {
      if (!isDbReady(db)) {
        const messages = mem.messages.get(threadId) || [];
        return okJson(res, { ok: true, threadId, messages, dbDisabled: true });
      }

      const q = await db.query(
        `select id, thread_id, role, agent, content, meta, created_at
         from messages
         where thread_id = $1::uuid
         order by created_at asc`,
        [threadId]
      );

      return okJson(res, { ok: true, threadId, messages: q.rows || [] });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/threads/:id/messages] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Proposals list
   * =========================== */
  r.get("/proposals", async (req, res) => {
    const status = String(req.query.status || "pending").trim();

    try {
      if (!isDbReady(db)) {
        const proposals = memListProposals(status);
        return okJson(res, { ok: true, status, proposals, dbDisabled: true });
      }

      const q = await db.query(
        `select id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by
         from proposals
         where status = $1::text
         order by created_at desc
         limit 100`,
        [status]
      );

      return okJson(res, { ok: true, status, proposals: q.rows || [] });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/proposals] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Decision endpoint (ONE-SHOT) + Job + n8n + notify
   * =========================== */
  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = normalizeDecision(req.body?.decision);
    const by = String(req.body?.by || "ceo").trim();
    const reason = String(req.body?.reason || req.body?.note || "").trim();

    if (!id) return okJson(res, { ok: false, error: "proposal id required" });
    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, { ok: false, error: 'decision must be "approved" or "rejected" (or approve/reject)' });
    }

    try {
      // MEMORY mode
      if (!isDbReady(db)) {
        const row = mem.proposals.get(id);
        if (!row) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        if (isFinalStatus(row.status)) {
          return okJson(res, { ok: false, error: "proposal already decided", proposal: row, dbDisabled: true });
        }

        row.status = decision;
        row.decided_at = nowIso();
        row.decision_by = by;

        row.payload = row.payload && typeof row.payload === "object" ? row.payload : {};
        row.payload.decision = {
          by,
          decision,
          reason: decision === "rejected" ? reason : "",
          at: row.decided_at,
        };

        try {
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
        } catch {}
        memAudit(by, "proposal.decision", "proposal", id, { decision });

        const notif = memCreateNotification({
          recipient: "ceo",
          type: decision === "approved" ? "success" : "warning",
          title: decision === "approved" ? "Proposal Approved" : "Proposal Rejected",
          body: row.title || "",
          payload: { proposalId: row.id, threadId: row.thread_id, decision, reason },
        });
        try {
          wsHub?.broadcast?.({ type: "notification.created", notification: notif });
        } catch {}

        let job = null;
        if (decision === "approved") {
          job = memCreateJob({
            proposalId: row.id,
            type: String(row.type || "generic"),
            status: "queued",
            input: { proposal: row },
          });

          try {
            wsHub?.broadcast?.({ type: "job.updated", job });
          } catch {}
          memAudit("system", "job.create", "job", job.id, { proposalId: row.id });

          notifyN8n("proposal.approved", row, {
            by,
            decision: "approved",
            jobId: job.id,
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
            dbDisabled: true,
          });
        } else {
          notifyN8n("proposal.rejected", row, { by, decision: "rejected", reason, dbDisabled: true });
        }

        return okJson(res, { ok: true, proposal: row, notification: notif, job, dbDisabled: true });
      }

      // DB mode — atomic update ONLY if pending
      const q = await db.query(
        `update proposals
         set status = $1::text,
             decided_at = now(),
             decision_by = $2::text,
             payload = (coalesce(payload, '{}'::jsonb) ||
                      jsonb_build_object(
                        'decision',
                        jsonb_build_object(
                          'by', $2::text,
                          'decision', $1::text,
                          'reason', $4::text,
                          'at', now()
                        )
                      ))
         where id::text = $3::text
           and status = 'pending'
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [decision, by, id, decision === "rejected" ? reason : ""]
      );

      const row = q.rows?.[0];
      if (!row) {
        const cur = await db.query(
          `select id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by
           from proposals
           where id::text = $1::text`,
          [id]
        );
        const existing = cur.rows?.[0] || null;
        if (!existing) return okJson(res, { ok: false, error: "proposal not found" });
        return okJson(res, { ok: false, error: "proposal already decided", proposal: existing });
      }

      try {
        wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
      } catch {}
      await dbAudit(db, by, "proposal.decision", "proposal", String(row.id), { decision });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: decision === "approved" ? "success" : "warning",
        title: decision === "approved" ? "Proposal Approved" : "Proposal Rejected",
        body: row.title || "",
        payload: { proposalId: row.id, threadId: row.thread_id, decision, reason: decision === "rejected" ? reason : "" },
      });
      try {
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      } catch {}

      let job = null;
      if (decision === "approved") {
        job = await dbCreateJob(db, {
          proposalId: row.id,
          type: String(row.type || "generic"),
          status: "queued",
          input: { proposal: row },
        });

        try {
          wsHub?.broadcast?.({ type: "job.updated", job });
        } catch {}
        await dbAudit(db, "system", "job.create", "job", String(job.id), { proposalId: String(row.id) });

        notifyN8n("proposal.approved", row, {
          by,
          decision: "approved",
          jobId: job.id,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: false,
        });
      } else {
        notifyN8n("proposal.rejected", row, { by, decision: "rejected", reason, dbDisabled: false });
      }

      return okJson(res, { ok: true, proposal: row, notification: notif, job });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/proposals/:id/decision] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Chat (single agent)
   * =========================== */
  r.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || req.body?.agentId || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: {} });

        const out = await kernelHandle({ message, agentHint: agent || undefined });

        memAddMessage(threadId, { role: "assistant", agent: out.agent || null, content: out.replyText || "", meta: {} });

        try {
          wsHub?.broadcast?.({
            type: "thread.message",
            threadId,
            message: { role: "assistant", agent: out.agent, content: out.replyText, at: nowIso() },
          });
        } catch {}

        return okJson(res, { ok: true, threadId, agent: out.agent, replyText: out.replyText || "(no text)", proposal: null, dbDisabled: true });
      }

      if (!threadIdIn) {
        const t = await db.query(`insert into threads (title) values ($1::text) returning id`, [`Thread ${nowIso()}`]);
        threadId = t.rows?.[0]?.id || threadId;
      }

      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1::uuid, 'user', $2::text, $3::text, $4::jsonb)`,
        [threadId, agent || null, message, {}]
      );

      const out = await kernelHandle({ message, agentHint: agent || undefined });

      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)`,
        [threadId, out.agent || null, out.replyText || "", {}]
      );

      try {
        wsHub?.broadcast?.({
          type: "thread.message",
          threadId,
          message: { role: "assistant", agent: out.agent, content: out.replyText, at: nowIso() },
        });
      } catch {}

      return okJson(res, { ok: true, threadId, agent: out.agent, replyText: out.replyText || "(no text)", proposal: null });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/chat] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Debate (multi-agent -> proposal)
   * =========================== */
  r.post("/debate", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();
    const rounds = clamp(req.body?.rounds ?? 2, 1, 3);

    let mode = String(req.body?.mode || "proposal").trim().toLowerCase();
    if (mode !== "proposal" && mode !== "answer") mode = "proposal";

    let agents = Array.isArray(req.body?.agents) ? req.body.agents : ["orion", "nova", "atlas", "echo"];
    agents = agents.map((x) => String(x || "").trim()).filter(Boolean);
    if (agents.length === 0) agents = ["orion", "nova", "atlas", "echo"];

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      console.log("[api/debate] start", { engine: DEBATE_ENGINE_VERSION, mode, rounds, agents });

      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: { kind: "debate" } });
      } else {
        if (!threadIdIn) {
          const t = await db.query(`insert into threads (title) values ($1::text) returning id`, [`Thread ${nowIso()}`]);
          threadId = t.rows?.[0]?.id || threadId;
        }

        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1::uuid, 'user', $2::text, $3::text, $4::jsonb)`,
          [threadId, agent || null, message, { kind: "debate" }]
        );
      }

      const out = await runDebate({ message, agents, rounds, mode });

      let synthesisText = String(out.finalAnswer || "").trim();
      if (!synthesisText) synthesisText = fallbackSynthesisFromNotes(out);

      if (!isDbReady(db)) {
        memAddMessage(threadId, { role: "assistant", agent: "kernel", content: synthesisText, meta: { kind: "debate.synthesis" } });
      } else {
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)`,
          [threadId, "kernel", synthesisText, { kind: "debate.synthesis" }]
        );
      }

      let savedProposal = null;
      if (out.proposal && typeof out.proposal === "object") {
        const p = out.proposal || {};
        const type = String(p.type || "plan");
        const title = String(p.title || "Debate Proposal");
        const payload = p.payload || p || {};

        if (!isDbReady(db)) {
          savedProposal = memCreateProposal(threadId, { agent: "kernel", type, title, payload });
        } else {
          const ins = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1::uuid, $2::text, $3::text, 'pending', $4::text, $5::jsonb)
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [threadId, "kernel", type, title, payload]
          );
          savedProposal = ins.rows?.[0] || null;
        }

        try {
          wsHub?.broadcast?.({ type: "proposal.created", proposal: savedProposal });
        } catch {}

        if (!isDbReady(db)) {
          const notif = memCreateNotification({
            recipient: "ceo",
            type: "info",
            title: "New Proposal Needs Review",
            body: savedProposal?.title || "",
            payload: { proposalId: savedProposal?.id, threadId },
          });
          try {
            wsHub?.broadcast?.({ type: "notification.created", notification: notif });
          } catch {}
        } else {
          const notif = await dbCreateNotification(db, {
            recipient: "ceo",
            type: "info",
            title: "New Proposal Needs Review",
            body: savedProposal?.title || "",
            payload: { proposalId: savedProposal?.id, threadId },
          });
          try {
            wsHub?.broadcast?.({ type: "notification.created", notification: notif });
          } catch {}
          await dbAudit(db, "kernel", "proposal.create", "proposal", String(savedProposal?.id || ""), { type });
        }
      }

      const debug = {
        engineVersion: DEBATE_ENGINE_VERSION,
        mode,
        rounds,
        agents,
        synthesisLen: synthesisText.length,
        hasProposal: Boolean(savedProposal),
        agentLens: (out.agentNotes || []).map((x) => ({ agentId: x.agentId, len: String(x.text || "").length })),
      };

      console.log("[api/debate] done", debug);

      return okJson(res, {
        ok: true,
        threadId,
        finalAnswer: synthesisText,
        agentNotes: out.agentNotes || [],
        proposal: savedProposal,
        dbDisabled: !isDbReady(db),
        debug,
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/debate] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Debug OpenAI
   * =========================== */
  r.post("/debug/openai", async (req, res) => {
    if (!requireDebugToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (missing/invalid token)" });
    }

    try {
      const agent = String(req.body?.agent || "orion").trim();
      const message = String(req.body?.message || "ping").trim();

      const out = await debugOpenAI({ agent, message });
      const raw = String(out.raw || "");

      return okJson(res, {
        ok: Boolean(out.ok),
        status: out.status || null,
        agent: out.agent,
        extractedText: out.extractedText || "",
        raw: raw.slice(0, 4000),
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/debug/openai] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  return r;
}