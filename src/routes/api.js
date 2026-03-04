// src/routes/api.js (FINAL v2.10.0 — Manual + Loop + Publish + Auto-ready)
//
// ✅ Manual mode lifecycle (CEO-controlled):
//   Pending -> (approve) Drafting(in_progress) -> (draft ready) -> Approve Draft -> Approved -> Publish -> Published
//
// ✅ Loop (revisions) works from BOTH:
//   - Drafting (in_progress)  -> Request changes -> regenerates draft
//   - Approved                -> Request changes -> goes back to in_progress + regenerates draft
//
// ✅ Publish is wired as:
//   - POST /api/content/:id/publish  (publishes a specific approved draft content item)
//   - POST /api/proposals/:id/publish (publishes latest approved draft for a proposal)
//   - Callback can mark proposal as published when permalink is provided
//
// ✅ Keeps: mojibake auto-fix, push test, executions callback auto-draft save, n8n callback absolute url
// ✅ Auto-ready: we include tenant mode fields in events (tenantId) but scheduling is typically done in n8n.

import express from "express";
import crypto from "crypto";
import { cfg } from "../config.js";
import { runDebate, DEBATE_ENGINE_VERSION } from "../kernel/debateEngine.js";
import { kernelHandle, listAgents, debugOpenAI } from "../kernel/agentKernel.js";
import { postToN8n } from "../utils/n8n.js";
import { sendTelegram } from "../utils/telegram.js";
import { pushSendOne } from "../utils/push.js";

/** ===========================
 * UTF-8 / Mojibake fix helpers
 * =========================== */

// Common mojibake markers when UTF-8 bytes were wrongly read as latin1
const MOJIBAKE_RE = /Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦|Ð.|Ñ.|Ø.|Þ.|Ý.|ý|þ|ð/;

function scoreTextQuality(s) {
  if (typeof s !== "string") return 0;
  const str = s;

  const moj = (str.match(MOJIBAKE_RE) || []).length;
  const repl = (str.match(/\uFFFD/g) || []).length;
  const good = (str.match(/[əğıöüşçƏĞİÖÜŞÇ]/g) || []).length;
  const letters = (str.match(/[A-Za-z0-9\u00C0-\u024F\u0400-\u04FFəğıöüşçƏĞİÖÜŞÇ]/g) || []).length;
  const total = Math.max(1, str.length);

  return good * 3 + (letters / total) * 10 - moj * 4 - repl * 20;
}

function tryFixMojibake(s) {
  if (typeof s !== "string") return s;
  const str = s;
  if (!MOJIBAKE_RE.test(str)) return str;

  let candidate = str;
  try {
    candidate = Buffer.from(str, "latin1").toString("utf8");
  } catch {
    return str;
  }

  const a = scoreTextQuality(str);
  const b = scoreTextQuality(candidate);
  return b > a ? candidate : str;
}

function fixText(x) {
  if (typeof x !== "string") return x;
  return tryFixMojibake(x);
}

function deepFix(obj) {
  if (obj == null) return obj;
  if (typeof obj === "string") return fixText(obj);
  if (Array.isArray(obj)) return obj.map(deepFix);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepFix(v);
    return out;
  }
  return obj;
}

/** ===========================
 * Common helpers
 * =========================== */

function okJson(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(payload);
}

function clamp(nv, a, b) {
  const x = Number(nv);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

// ✅ If DEBUG_API_TOKEN is set => require it. If not set => allow (dev-friendly)
function requireDebugToken(req) {
  const expected = String(cfg.DEBUG_API_TOKEN || "").trim();
  if (!expected) return true;
  const token = String(req.headers["x-debug-token"] || req.query.token || req.body?.token || "").trim();
  return Boolean(token) && token === expected;
}

function isDbReady(db) {
  return Boolean(db && typeof db.query === "function");
}

function serializeError(err) {
  const e = err || {};
  const isAgg = e && (e.name === "AggregateError" || Array.isArray(e.errors));
  const base = { name: e.name || "Error", message: e.message || String(e), stack: e.stack || null };
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
  return s === "approved" || s === "rejected" || s === "published";
}

function nowIso() {
  return new Date().toISOString();
}

function isUuid(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function isDigits(v) {
  const s = String(v || "").trim();
  return /^[0-9]{1,12}$/.test(s);
}

function callbackTokenExpected() {
  return String(cfg.N8N_CALLBACK_TOKEN || cfg.N8N_WEBHOOK_TOKEN || "").trim();
}

function requireCallbackToken(req) {
  const expected = callbackTokenExpected();
  if (!expected) return true; // dev allow
  const got = String(
    req.headers["x-webhook-token"] ||
      req.headers["x-callback-token"] ||
      req.body?.token || // allow body token for easy n8n testing
      ""
  ).trim();
  return Boolean(got) && got === expected;
}

function baseUrl() {
  const b = String(cfg.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return b || "";
}

function absoluteCallbackUrl(pathname) {
  const b = baseUrl();
  const p = String(pathname || "").trim();
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;
  if (!b) return p; // keep relative if base not configured
  return `${b}${p.startsWith("/") ? "" : "/"}${p}`;
}

function normalizeStatus(s) {
  const x = String(s || "").trim().toLowerCase();
  if (!x) return "";
  return x;
}

// ✅ Telegram hard toggle: OFF by default
async function maybeTelegram(text) {
  if (!cfg.TELEGRAM_ENABLED) return;
  try {
    await sendTelegram({ text: fixText(text) });
  } catch {}
}

/** ===========================
 * In-memory fallback (DB off)
 * =========================== */
const mem = {
  threads: new Map(),
  messages: new Map(),
  proposals: new Map(),
  notifications: new Map(),
  jobs: new Map(),
  pushSubs: new Map(), // endpoint -> {recipient, endpoint, p256dh, auth, user_agent}
  contentItems: new Map(), // id -> content_item
  contentByProposal: new Map(), // proposalId -> contentItemId (latest)
  audit: [],
};

function memEnsureThread(threadId, title) {
  if (!mem.threads.has(threadId)) {
    mem.threads.set(threadId, { id: threadId, title: fixText(title || `Thread ${nowIso()}`), created_at: nowIso() });
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
    content: fixText(content || ""),
    meta: deepFix(meta || {}),
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
    title: fixText(title || ""),
    payload: deepFix(payload || {}),
    created_at: nowIso(),
    decided_at: null,
    decision_by: null,
  };
  mem.proposals.set(id, row);
  return row;
}

function memListProposals(status = "pending") {
  const out = [];
  for (const p of mem.proposals.values()) if (String(p.status) === String(status)) out.push(p);
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, 100);
}

function memCreateNotification({ recipient = "ceo", type = "info", title = "", body = "", payload = {} }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    recipient,
    type,
    title: fixText(title),
    body: fixText(body),
    payload: deepFix(payload),
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
    input: deepFix(input),
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
  row.input = deepFix(row.input || {});
  row.output = deepFix(row.output || {});
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}

function memAudit(actor, action, objectType, objectId, meta = {}) {
  mem.audit.push({
    id: crypto.randomUUID(),
    actor: actor || "system",
    action,
    object_type: objectType || "unknown",
    object_id: objectId || null,
    meta: deepFix(meta),
    created_at: nowIso(),
  });
}

/** ===========================
 * Content draft helpers (MEM)
 * =========================== */
function memGetLatestContentByProposal(proposalId) {
  const id = mem.contentByProposal.get(String(proposalId));
  if (!id) return null;
  return mem.contentItems.get(id) || null;
}

function memUpsertContentItem({
  proposalId,
  threadId = null,
  jobId = null,
  status = "draft.ready",
  contentPack = null,
  feedbackText = "",
}) {
  const existing = memGetLatestContentByProposal(proposalId);
  const nextVersion = (existing?.version || 0) + 1;

  const id = existing?.id || crypto.randomUUID();

  const row = {
    id,
    proposal_id: String(proposalId),
    thread_id: threadId ? String(threadId) : existing?.thread_id || null,
    job_id: jobId ? String(jobId) : existing?.job_id || null,
    status: fixText(status || "draft.ready"),
    version: nextVersion,
    content_pack: deepFix(contentPack || existing?.content_pack || {}),
    last_feedback: fixText(String(feedbackText || existing?.last_feedback || "")),
    publish: deepFix(existing?.publish || {}), // e.g. { permalink, platform, publishedAt, assetUrls }
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };

  mem.contentItems.set(id, row);
  mem.contentByProposal.set(String(proposalId), id);
  return row;
}

function memPatchContentItem(id, patch = {}) {
  const row = mem.contentItems.get(String(id));
  if (!row) return null;
  Object.assign(row, deepFix(patch));
  row.updated_at = nowIso();
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  return row;
}

/** ===========================
 * Best-effort cleanup (expired rows)
 * =========================== */
let lastCleanupMs = 0;

async function maybeCleanupExpired({ db }) {
  const now = Date.now();
  if (now - lastCleanupMs < 10 * 60 * 1000) return; // at most every 10 minutes
  lastCleanupMs = now;

  const JOB_TTL_DAYS = clamp(cfg.JOB_TTL_DAYS ?? 30, 7, 180);
  const NOTIF_TTL_DAYS = clamp(cfg.NOTIF_TTL_DAYS ?? 90, 14, 365);

  // Memory cleanup
  if (!isDbReady(db)) {
    const cutoffJobs = Date.now() - JOB_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, j] of mem.jobs.entries()) {
      const t = Date.parse(String(j.created_at || "")) || 0;
      const final = ["completed", "failed"].includes(String(j.status || "").toLowerCase());
      if (final && t && t < cutoffJobs) mem.jobs.delete(id);
    }
    const cutoffNotif = Date.now() - NOTIF_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, n] of mem.notifications.entries()) {
      const t = Date.parse(String(n.created_at || "")) || 0;
      if (t && t < cutoffNotif) mem.notifications.delete(id);
    }
    return;
  }

  // DB cleanup (safe; no drops)
  try {
    await db.query(
      `delete from jobs
       where status in ('completed','failed')
         and created_at < now() - ($1::int * interval '1 day')`,
      [JOB_TTL_DAYS]
    );
  } catch {}

  try {
    await db.query(
      `delete from notifications
       where created_at < now() - ($1::int * interval '1 day')`,
      [NOTIF_TTL_DAYS]
    );
  } catch {}
}

/** ===========================
 * Push helpers (DB)
 * =========================== */
async function dbUpsertPushSub(db, { recipient = "ceo", endpoint, p256dh, auth, userAgent }) {
  const q = await db.query(
    `insert into push_subscriptions (recipient, endpoint, p256dh, auth, user_agent, last_seen_at)
     values ($1::text, $2::text, $3::text, $4::text, $5::text, now())
     on conflict (endpoint) do update
       set recipient = excluded.recipient,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           last_seen_at = now()
     returning id, recipient, endpoint, p256dh, auth, user_agent, created_at, last_seen_at`,
    [recipient, endpoint, p256dh, auth, userAgent || null]
  );
  return q.rows?.[0] || null;
}

async function dbListPushSubs(db, recipient = "ceo") {
  const q = await db.query(
    `select recipient, endpoint, p256dh, auth
     from push_subscriptions
     where recipient = $1::text
     order by created_at desc
     limit 30`,
    [recipient]
  );
  return q.rows || [];
}

async function dbDeletePushSub(db, endpoint) {
  if (!isDbReady(db)) return;
  try {
    await db.query(`delete from push_subscriptions where endpoint = $1::text`, [endpoint]);
  } catch {}
}

async function pushBroadcastToCeo({ db, title, body, data }) {
  if (!cfg.PUSH_ENABLED) return;

  const payload = {
    title: fixText(title || "AI HQ"),
    body: fixText(body || ""),
    data: deepFix(data || {}),
  };

  if (isDbReady(db)) {
    const subs = await dbListPushSubs(db, "ceo");
    for (const s of subs) {
      try {
        const r = await pushSendOne({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (!r.ok && r.expired) await dbDeletePushSub(db, s.endpoint);
      } catch {}
    }
    return;
  }

  for (const s of mem.pushSubs.values()) {
    if (s.recipient !== "ceo") continue;
    try {
      const r = await pushSendOne({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      if (!r.ok && r.expired) mem.pushSubs.delete(s.endpoint);
    } catch {}
  }
}

/** ===========================
 * n8n notify helper
 * =========================== */
function notifyN8n(event, proposal, extra = {}) {
  const url = String(cfg.N8N_WEBHOOK_URL || "").trim();
  if (!url) return;

  const callbackRel = extra?.callback?.url || "/api/executions/callback";
  const callbackAbs = absoluteCallbackUrl(callbackRel);

  const payload = deepFix({
    event,
    tenantId: extra.tenantId || "default",
    proposalId: extra.proposalId || proposal?.id || null,
    threadId: extra.threadId || proposal?.thread_id || null,
    by: extra.by || proposal?.decision_by || "unknown",
    decidedAt: extra.decidedAt || proposal?.decided_at || null,
    jobId: extra.jobId || null,
    callback: {
      ...(extra.callback || { url: callbackRel, tokenHeader: "x-webhook-token" }),
      url: callbackAbs || callbackRel,
    },
    title: proposal?.title || extra.title || null,
    summary: extra.summary || null,
    tasks: extra.tasks || null,
    ownerMap: extra.ownerMap || null,
    decision: extra.decision || proposal?.status || null,
    proposal: proposal || null,
    ...extra,
  });

  postToN8n({
    url,
    token: String(cfg.N8N_WEBHOOK_TOKEN || "").trim(),
    timeoutMs: Number(cfg.N8N_TIMEOUT_MS || 10_000),
    payload,
    retries: Number(cfg.N8N_RETRIES ?? 2),
    baseBackoffMs: Number(cfg.N8N_BACKOFF_MS ?? 500),
    requestId: extra.requestId,
    executionId: extra.executionId,
  })
    .then((r) => {
      const info = r?.ok ? `ok ${r.status || ""}` : `fail ${r.status || r.error || ""}`;
      const preview =
        typeof r?.data === "string" ? r.data.slice(0, 160) : JSON.stringify(r?.data || {}).slice(0, 160);
      console.log(`[n8n] ${event} → ${info} ${preview}`);
    })
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}

function fallbackSynthesisFromNotes(out) {
  const notes = Array.isArray(out?.agentNotes) ? out.agentNotes : [];
  const parts = [];
  for (const n of notes) {
    const t = fixText(String(n?.text || "")).trim();
    if (!t) continue;
    parts.push(`### ${n.agentId}\n${t}`);
  }
  return parts.join("\n\n").trim();
}

/** ===========================
 * DB helpers: notifications/jobs/audit
 * =========================== */
async function dbAudit(db, actor, action, objectType, objectId, meta) {
  if (!isDbReady(db)) return;
  try {
    await db.query(
      `insert into audit_log (actor, action, object_type, object_id, meta)
       values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)`,
      [fixText(actor || "system"), action, objectType || "unknown", objectId || null, deepFix(meta || {})]
    );
  } catch {}
}

async function dbCreateNotification(db, { recipient = "ceo", type = "info", title = "", body = "", payload = {} }) {
  const q = await db.query(
    `insert into notifications (recipient, type, title, body, payload)
     values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [recipient, type, fixText(title), fixText(body), deepFix(payload)]
  );
  return q.rows?.[0] || null;
}

async function dbListNotifications(db, { recipient = "ceo", unreadOnly = false, limit = 50 }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = unreadOnly ? `and read_at is null` : ``;

  const q = await db.query(
    `select id, recipient, type, title, body, payload, read_at, created_at
     from notifications
     where recipient = $1::text ${where}
     order by created_at desc
     limit ${lim}`,
    [recipient]
  );

  return (q.rows || []).map((x) => ({
    ...x,
    title: fixText(x.title),
    body: fixText(x.body),
    payload: deepFix(x.payload),
  }));
}

async function dbMarkNotificationRead(db, id) {
  const q = await db.query(
    `update notifications
     set read_at = coalesce(read_at, now())
     where id = $1::uuid
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [id]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  return { ...row, title: fixText(row.title), body: fixText(row.body), payload: deepFix(row.payload) };
}

async function dbCreateJob(db, { proposalId = null, type = "generic", status = "queued", input = {} }) {
  const q = await db.query(
    `insert into jobs (proposal_id, type, status, input)
     values ($1::uuid, $2::text, $3::text, $4::jsonb)
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [proposalId, type, status, deepFix(input)]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.input = deepFix(row.input);
  row.output = deepFix(row.output);
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
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
         started_at = case when $5::timestamptz is null then started_at else $5::timestamptz end,
         finished_at = case when $6::timestamptz is null then finished_at else $6::timestamptz end
     where id = $1::uuid
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [id, status, output ? deepFix(output) : output, error ? fixText(String(error)) : error, started, finished]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.input = deepFix(row.input);
  row.output = deepFix(row.output);
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}

/** ===========================
 * DB helpers: proposals (status transitions)
 * =========================== */
async function dbGetProposalById(db, idText) {
  const q = await db.query(
    `select id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by
     from proposals
     where id::text = $1::text
     limit 1`,
    [String(idText)]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.title = fixText(row.title);
  row.payload = deepFix(row.payload);
  return row;
}

async function dbSetProposalStatus(db, idText, status, patchPayload = {}) {
  const q = await db.query(
    `update proposals
     set status = $2::text,
         payload = (coalesce(payload,'{}'::jsonb) || $3::jsonb)
     where id::text = $1::text
     returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
    [String(idText), String(status), deepFix(patchPayload || {})]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.title = fixText(row.title);
  row.payload = deepFix(row.payload);
  return row;
}

/** ===========================
 * DB helpers: content_items (Draft)
 * =========================== */
async function dbGetLatestContentByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
     order by updated_at desc
     limit 1`,
    [proposalId]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

async function dbGetLatestDraftLikeByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
       and (status like 'draft.%' or status in ('draft.ready','draft.regenerating','draft.approved'))
     order by updated_at desc
     limit 1`,
    [proposalId]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

async function dbGetLatestApprovedDraftByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
       and status = 'draft.approved'
     order by updated_at desc
     limit 1`,
    [proposalId]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

async function dbCreateContentItem(db, {
  proposalId,
  threadId = null,
  jobId = null,
  status = "draft.ready",
  version = 1,
  contentPack = {},
  lastFeedback = "",
  publish = {},
}) {
  const q = await db.query(
    `insert into content_items (proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish)
     values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::int, $6::jsonb, $7::text, $8::jsonb)
     returning id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at`,
    [
      proposalId,
      threadId,
      jobId,
      fixText(status),
      Number(version) || 1,
      deepFix(contentPack || {}),
      fixText(lastFeedback || ""),
      deepFix(publish || {}),
    ]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

async function dbUpdateContentItem(db, id, patch = {}) {
  const status = patch.status ?? null;
  const lastFeedback = patch.last_feedback ?? patch.lastFeedback ?? null;
  const contentPack = patch.content_pack ?? patch.contentPack ?? null;
  const version = patch.version ?? null;
  const jobId = patch.job_id ?? patch.jobId ?? null;
  const publish = patch.publish ?? null;

  const q = await db.query(
    `update content_items
     set status = coalesce($2::text, status),
         version = coalesce($3::int, version),
         job_id = coalesce($4::uuid, job_id),
         last_feedback = coalesce($5::text, last_feedback),
         content_pack = case when $6::jsonb is null then content_pack else $6::jsonb end,
         publish = case when $7::jsonb is null then publish else (coalesce(publish,'{}'::jsonb) || $7::jsonb) end,
         updated_at = now()
     where id = $1::uuid
     returning id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at`,
    [
      id,
      status ? fixText(status) : null,
      version != null ? Number(version) : null,
      jobId || null,
      lastFeedback != null ? fixText(String(lastFeedback)) : null,
      contentPack ? deepFix(contentPack) : null,
      publish ? deepFix(publish) : null,
    ]
  );

  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

async function dbUpsertDraftFromCallback(db, { proposalId, threadId = null, jobId = null, status = "draft.ready", contentPack = {} }) {
  // Strategy:
  // - if exists: update same row; bump version +1
  // - else: create v1
  const existing = await dbGetLatestContentByProposal(db, proposalId);
  if (!existing) {
    return await dbCreateContentItem(db, {
      proposalId,
      threadId,
      jobId,
      status,
      version: 1,
      contentPack,
      lastFeedback: "",
      publish: {},
    });
  }
  const nextVersion = (Number(existing.version) || 1) + 1;
  return await dbUpdateContentItem(db, existing.id, {
    status,
    version: nextVersion,
    job_id: jobId || existing.job_id,
    content_pack: contentPack,
  });
}

/** ===========================
 * Router
 * =========================== */
export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  r.get("/", async (_req, res) => {
    await maybeCleanupExpired({ db });
    return okJson(res, {
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
        "GET /api/proposals?status=pending|in_progress|approved|published|rejected",
        "POST /api/proposals/:id/decision",
        "POST /api/proposals/:id/request-changes (loop: regenerate draft from latest)",
        "POST /api/proposals/:id/publish (publish latest approved draft)",
        "GET /api/notifications?recipient=ceo&unread=1",
        "POST /api/notifications/:id/read",
        "GET /api/push/vapid",
        "POST /api/push/subscribe",
        "POST /api/push/test (token if DEBUG_API_TOKEN set)",
        "GET /api/executions?status=&limit=&executionId=",
        "GET /api/executions/:id (uuid) OR /api/executions/:executionId (digits)",
        "POST /api/executions/callback (token)",
        "GET /api/content?proposalId=",
        "POST /api/content/:id/feedback",
        "POST /api/content/:id/approve",
        "POST /api/content/:id/publish",
        "POST /api/debug/openai (token if DEBUG_API_TOKEN set)",
      ],
      telegram: { enabled: Boolean(cfg.TELEGRAM_ENABLED) },
      push: { enabled: Boolean(cfg.PUSH_ENABLED), vapidPublicKey: cfg.VAPID_PUBLIC_KEY ? "set" : "missing" },
    });
  });

  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));

  /** ===========================
   * Push: VAPID public key
   * =========================== */
  r.get("/push/vapid", (_req, res) => {
    if (!cfg.PUSH_ENABLED) return okJson(res, { ok: false, error: "push disabled" });

    const publicKey = String(cfg.VAPID_PUBLIC_KEY || "").trim();
    if (!publicKey) return okJson(res, { ok: false, error: "VAPID_PUBLIC_KEY not set" });

    return okJson(res, { ok: true, publicKey });
  });

  /** ===========================
   * Push: subscribe
   * =========================== */
  r.get("/push/subscribe", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST /api/push/subscribe" });
  });

  r.post("/push/subscribe", async (req, res) => {
    const recipient = fixText(String(req.body?.recipient || "ceo").trim()) || "ceo";
    const sub = req.body?.subscription || req.body?.sub || null;
    const endpoint = String(sub?.endpoint || "").trim();
    const p256dh = String(sub?.keys?.p256dh || "").trim();
    const auth = String(sub?.keys?.auth || "").trim();
    const ua = String(req.headers["user-agent"] || "").trim();

    if (!endpoint || !p256dh || !auth) {
      return okJson(res, { ok: false, error: "subscription {endpoint, keys.p256dh, keys.auth} required" });
    }

    try {
      if (!isDbReady(db)) {
        mem.pushSubs.set(endpoint, { recipient, endpoint, p256dh, auth, user_agent: ua, created_at: nowIso() });
        return okJson(res, { ok: true, dbDisabled: true });
      }

      await dbUpsertPushSub(db, { recipient, endpoint, p256dh, auth, userAgent: ua });
      return okJson(res, { ok: true });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Push: TEST SEND ✅
   * =========================== */
  r.post("/push/test", async (req, res) => {
    if (!requireDebugToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (missing/invalid debug token)" });
    }

    if (!cfg.PUSH_ENABLED) return okJson(res, { ok: false, error: "push disabled" });

    const title = fixText(String(req.body?.title || "AI HQ Test").trim());
    const body = fixText(String(req.body?.body || "Push is working ✅").trim());
    const data = req.body?.data && typeof req.body.data === "object" ? deepFix(req.body.data) : { type: "push.test" };

    try {
      await pushBroadcastToCeo({ db, title, body, data });

      let notif = null;

      if (!isDbReady(db)) {
        notif = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Push Test Sent",
          body,
          payload: { title, body, data },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });
        memAudit("system", "push.test", "push", null, { title });
        return okJson(res, { ok: true, sent: true, notification: notif, dbDisabled: true });
      }

      notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Push Test Sent",
        body,
        payload: { title, body, data },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });
      await dbAudit(db, "system", "push.test", "push", null, { title });

      return okJson(res, { ok: true, sent: true, notification: notif });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Notifications
   * =========================== */
  r.get("/notifications", async (req, res) => {
    const recipient = fixText(String(req.query.recipient || "ceo").trim()) || "ceo";
    const unreadOnly = String(req.query.unread || "").trim() === "1";
    const limit = clamp(req.query.limit ?? 50, 1, 200);

    try {
      await maybeCleanupExpired({ db });

      if (!isDbReady(db)) {
        const rows = memListNotifications({ recipient, unreadOnly, limit });
        return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows, dbDisabled: true });
      }
      const rows = await dbListNotifications(db, { recipient, unreadOnly, limit });
      return okJson(res, { ok: true, recipient, unreadOnly, notifications: rows });
    } catch (e) {
      const details = serializeError(e);
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
        wsHub?.broadcast?.({ type: "notification.read", notification: row });
        memAudit("ceo", "notification.read", "notification", id, {});
        return okJson(res, { ok: true, notification: row, dbDisabled: true });
      }

      const row = await dbMarkNotificationRead(db, id);
      if (!row) return okJson(res, { ok: false, error: "not found" });
      wsHub?.broadcast?.({ type: "notification.read", notification: row });
      await dbAudit(db, "ceo", "notification.read", "notification", String(row.id), {});
      return okJson(res, { ok: true, notification: row });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Content (Draft) — GET by proposalId
   * =========================== */
  r.get("/content", async (req, res) => {
    const proposalId = String(req.query.proposalId || "").trim();
    if (!proposalId) return okJson(res, { ok: false, error: "proposalId required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposalId must be uuid" });

    try {
      if (!isDbReady(db)) {
        const row = memGetLatestContentByProposal(proposalId);
        return okJson(res, { ok: true, content: row || null, dbDisabled: true });
      }
      const row = await dbGetLatestContentByProposal(db, proposalId);
      return okJson(res, { ok: true, content: row || null });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Content — feedback (Request changes) => loop => n8n content.revise
   * - Works in Drafting
   * - Also works after Approved (we push proposal back to in_progress)
   * =========================== */
  r.post("/content/:id/feedback", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const feedback = fixText(String(req.body?.feedback || req.body?.text || "").trim());
    const by = fixText(String(req.body?.by || "ceo").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!id) return okJson(res, { ok: false, error: "content id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "content id must be uuid" });
    if (!feedback) return okJson(res, { ok: false, error: "feedback required" });

    try {
      // MEMORY mode
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id);
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        // If proposal already approved/published -> move back to in_progress (loop)
        const p = row.proposal_id ? mem.proposals.get(String(row.proposal_id)) : null;
        if (p && (p.status === "approved" || p.status === "published")) {
          p.status = "in_progress";
          p.payload = deepFix(p.payload && typeof p.payload === "object" ? p.payload : {});
          p.payload.loop = { by, at: nowIso(), reason: "request_changes", feedback };
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          memAudit(by, "proposal.loop", "proposal", String(p.id), { from: "approved/published", to: "in_progress" });
        }

        memPatchContentItem(id, { status: "draft.regenerating", last_feedback: feedback });

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(id) });
        memAudit(by, "content.feedback", "content", id, {});

        const n = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Draft: changes requested",
          body: `Draft regenerating…`,
          payload: { contentId: id, proposalId: row.proposal_id },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: n });

        await pushBroadcastToCeo({
          db,
          title: "Draft update",
          body: "Changes requested — regenerating…",
          data: { type: "content.updated", contentId: id, status: "draft.regenerating" },
        });

        notifyN8n("content.revise", null, {
          tenantId,
          by,
          proposalId: row.proposal_id,
          threadId: row.thread_id,
          contentItemId: id,
          status: "draft.regenerating",
          feedback,
          contentPack: row.content_pack || {},
          jobId: row.job_id || null,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: true,
        });

        return okJson(res, { ok: true, content: mem.contentItems.get(id), notification: n, proposal: p || null, dbDisabled: true });
      }

      // DB mode
      const cur = await db.query(
        `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback
         from content_items
         where id = $1::uuid
         limit 1`,
        [id]
      );
      const row = cur.rows?.[0] || null;
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      // If proposal already approved/published -> move back to in_progress (loop)
      try {
        await db.query(
          `update proposals
           set status = 'in_progress',
               payload = (coalesce(payload,'{}'::jsonb) || jsonb_build_object('loop', jsonb_build_object(
                 'by', $2::text, 'at', now(), 'reason', 'request_changes', 'feedback', $3::text
               )))
           where id = $1::uuid and status in ('approved','published')`,
          [String(row.proposal_id), by, feedback]
        );
      } catch {}

      const updated = await dbUpdateContentItem(db, id, { status: "draft.regenerating", last_feedback: feedback });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      await dbAudit(db, by, "content.feedback", "content", String(id), {});

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Draft: changes requested",
        body: "Draft regenerating…",
        payload: { contentId: id, proposalId: String(row.proposal_id) },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft update",
        body: "Changes requested — regenerating…",
        data: { type: "content.updated", contentId: id, status: "draft.regenerating" },
      });

      notifyN8n("content.revise", null, {
        tenantId,
        by,
        proposalId: String(row.proposal_id),
        threadId: row.thread_id ? String(row.thread_id) : null,
        contentItemId: id,
        status: "draft.regenerating",
        feedback,
        contentPack: deepFix(row.content_pack || {}),
        jobId: row.job_id ? String(row.job_id) : null,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        dbDisabled: false,
      });

      const proposalAfter = await dbGetProposalById(db, String(row.proposal_id));

      return okJson(res, { ok: true, content: updated, notification: notif, proposal: proposalAfter || null });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Content — approve draft (FINAL approve) ✅
   * - content status => draft.approved
   * - proposal status => approved (final)
   * - n8n event => content.approved
   * =========================== */
  r.post("/content/:id/approve", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const by = fixText(String(req.body?.by || "ceo").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!id) return okJson(res, { ok: false, error: "content id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "content id must be uuid" });

    try {
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id);
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        const updated = memPatchContentItem(id, { status: "draft.approved" });
        wsHub?.broadcast?.({ type: "content.updated", content: updated });
        memAudit(by, "content.approve", "content", id, {});

        // ✅ FINAL: proposal becomes approved here
        const p = row.proposal_id ? mem.proposals.get(String(row.proposal_id)) : null;
        if (p && !isFinalStatus(p.status)) {
          p.status = "approved";
          p.decided_at = p.decided_at || nowIso();
          p.decision_by = by;
          p.payload = deepFix(p.payload && typeof p.payload === "object" ? p.payload : {});
          p.payload.decision = { by, decision: "approved", reason: "", at: p.decided_at, via: "content.approve" };
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          memAudit(by, "proposal.finalize", "proposal", String(p.id), { via: "content.approve" });
        }

        const n = memCreateNotification({
          recipient: "ceo",
          type: "success",
          title: "Draft approved",
          body: "Draft is approved and ready to publish.",
          payload: { contentId: id, proposalId: row.proposal_id },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: n });

        await pushBroadcastToCeo({
          db,
          title: "Draft approved",
          body: "Ready to publish.",
          data: { type: "content.updated", contentId: id, status: "draft.approved" },
        });

        notifyN8n("content.approved", null, {
          tenantId,
          by,
          proposalId: row.proposal_id,
          threadId: row.thread_id,
          contentItemId: id,
          status: "draft.approved",
          contentPack: row.content_pack || {},
          jobId: row.job_id || null,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: true,
        });

        return okJson(res, { ok: true, content: updated, notification: n, proposal: p || null, dbDisabled: true });
      }

      // DB
      const cur = await db.query(
        `select id, proposal_id, thread_id, job_id, content_pack
         from content_items
         where id = $1::uuid
         limit 1`,
        [id]
      );
      const row = cur.rows?.[0] || null;
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      const updated = await dbUpdateContentItem(db, id, { status: "draft.approved" });
      if (!updated) return okJson(res, { ok: false, error: "content not found" });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      await dbAudit(db, by, "content.approve", "content", String(id), {});

      // ✅ FINAL: proposal becomes approved here
      let proposalRow = null;
      if (row.proposal_id) {
        const uq = await db.query(
          `update proposals
           set status = 'approved',
               decided_at = coalesce(decided_at, now()),
               decision_by = $2::text,
               payload = (coalesce(payload,'{}'::jsonb) ||
                        jsonb_build_object(
                          'decision',
                          jsonb_build_object(
                            'by', $2::text,
                            'decision', 'approved',
                            'reason', '',
                            'at', now(),
                            'via', 'content.approve'
                          )
                        ))
           where id = $1::uuid
             and status <> 'approved'
             and status <> 'rejected'
             and status <> 'published'
           returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
          [String(row.proposal_id), by]
        );
        proposalRow = uq.rows?.[0] || null;
        if (proposalRow) {
          proposalRow.title = fixText(proposalRow.title);
          proposalRow.payload = deepFix(proposalRow.payload);
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: proposalRow });
          await dbAudit(db, by, "proposal.finalize", "proposal", String(proposalRow.id), { via: "content.approve" });
        }
      }

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "success",
        title: "Draft approved",
        body: "Draft is approved and ready to publish.",
        payload: { contentId: id, proposalId: String(updated.proposal_id) },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Draft approved",
        body: "Ready to publish.",
        data: { type: "content.updated", contentId: id, status: "draft.approved" },
      });

      notifyN8n("content.approved", null, {
        tenantId,
        by,
        proposalId: String(row.proposal_id),
        threadId: row.thread_id ? String(row.thread_id) : null,
        contentItemId: id,
        status: "draft.approved",
        contentPack: deepFix(row.content_pack || {}),
        jobId: row.job_id ? String(row.job_id) : null,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        dbDisabled: false,
      });

      return okJson(res, { ok: true, content: updated, notification: notif, proposal: proposalRow || null });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Content — publish trigger => n8n content.publish
   * - requires draft.approved (manual gate)
   * =========================== */
  r.post("/content/:id/publish", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const by = fixText(String(req.body?.by || "ceo").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!id) return okJson(res, { ok: false, error: "content id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "content id must be uuid" });

    try {
      // MEMORY
      if (!isDbReady(db)) {
        const row = mem.contentItems.get(id);
        if (!row) return okJson(res, { ok: false, error: "content not found", dbDisabled: true });

        if (String(row.status) !== "draft.approved") {
          return okJson(res, { ok: false, error: "draft must be approved before publish", status: row.status, dbDisabled: true });
        }

        const updated = memPatchContentItem(id, { status: "publishing" });
        wsHub?.broadcast?.({ type: "content.updated", content: updated });
        memAudit(by, "content.publish", "content", id, {});

        const n = memCreateNotification({
          recipient: "ceo",
          type: "info",
          title: "Publishing started",
          body: "Publishing via n8n…",
          payload: { contentId: id, proposalId: row.proposal_id },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: n });

        await pushBroadcastToCeo({
          db,
          title: "Publishing",
          body: "Draft is being published…",
          data: { type: "content.updated", contentId: id, status: "publishing" },
        });

        notifyN8n("content.publish", null, {
          tenantId,
          by,
          proposalId: row.proposal_id,
          threadId: row.thread_id,
          contentItemId: id,
          status: "publishing",
          contentPack: row.content_pack || {},
          jobId: row.job_id || null,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: true,
        });

        return okJson(res, { ok: true, content: updated, notification: n, dbDisabled: true });
      }

      // DB
      const cur = await db.query(
        `select id, proposal_id, thread_id, job_id, status, version, content_pack
         from content_items
         where id = $1::uuid
         limit 1`,
        [id]
      );
      const row = cur.rows?.[0] || null;
      if (!row) return okJson(res, { ok: false, error: "content not found" });

      if (String(row.status) !== "draft.approved") {
        return okJson(res, { ok: false, error: "draft must be approved before publish", status: row.status });
      }

      const updated = await dbUpdateContentItem(db, id, { status: "publishing" });

      wsHub?.broadcast?.({ type: "content.updated", content: updated });
      await dbAudit(db, by, "content.publish", "content", String(id), {});

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: "info",
        title: "Publishing started",
        body: "Publishing via n8n…",
        payload: { contentId: id, proposalId: String(row.proposal_id) },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "Publishing",
        body: "Draft is being published…",
        data: { type: "content.updated", contentId: id, status: "publishing" },
      });

      notifyN8n("content.publish", null, {
        tenantId,
        by,
        proposalId: String(row.proposal_id),
        threadId: row.thread_id ? String(row.thread_id) : null,
        contentItemId: id,
        status: "publishing",
        contentPack: deepFix(row.content_pack || {}),
        jobId: row.job_id ? String(row.job_id) : null,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        dbDisabled: false,
      });

      return okJson(res, { ok: true, content: updated, notification: notif });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Proposal: Request changes (loop helper)
   * - Finds latest draft-like content and triggers feedback flow
   * - Works even when proposal is approved (will push back to in_progress)
   * =========================== */
  r.post("/proposals/:id/request-changes", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();
    const feedback = fixText(String(req.body?.feedback || req.body?.text || "").trim());
    const by = fixText(String(req.body?.by || "ceo").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!proposalId) return okJson(res, { ok: false, error: "proposal id required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposal id must be uuid" });
    if (!feedback) return okJson(res, { ok: false, error: "feedback required" });

    try {
      if (!isDbReady(db)) {
        const p = mem.proposals.get(proposalId);
        if (!p) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        const c = memGetLatestContentByProposal(proposalId);
        if (!c) return okJson(res, { ok: false, error: "no draft found for proposal", dbDisabled: true });

        // reuse content feedback route logic by calling the same logic here:
        c.last_feedback = feedback;
        memPatchContentItem(c.id, { status: "draft.regenerating", last_feedback: feedback });

        if (p.status === "approved" || p.status === "published") {
          p.status = "in_progress";
          p.payload = deepFix(p.payload || {});
          p.payload.loop = { by, at: nowIso(), reason: "request_changes", feedback };
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
        }

        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(c.id) });

        notifyN8n("content.revise", null, {
          tenantId,
          by,
          proposalId,
          threadId: p.thread_id || null,
          contentItemId: c.id,
          status: "draft.regenerating",
          feedback,
          contentPack: c.content_pack || {},
          jobId: c.job_id || null,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: true,
        });

        return okJson(res, { ok: true, proposal: p, content: mem.contentItems.get(c.id), dbDisabled: true });
      }

      const p = await dbGetProposalById(db, proposalId);
      if (!p) return okJson(res, { ok: false, error: "proposal not found" });

      const c = await dbGetLatestDraftLikeByProposal(db, proposalId);
      if (!c) return okJson(res, { ok: false, error: "no draft found for proposal" });

      // move proposal back to in_progress if needed
      if (p.status === "approved" || p.status === "published") {
        await dbSetProposalStatus(db, proposalId, "in_progress", {
          loop: { by, at: nowIso(), reason: "request_changes", feedback },
        });
      }

      const updated = await dbUpdateContentItem(db, c.id, { status: "draft.regenerating", last_feedback: feedback });

      wsHub?.broadcast?.({ type: "proposal.updated", proposal: await dbGetProposalById(db, proposalId) });
      wsHub?.broadcast?.({ type: "content.updated", content: updated });

      notifyN8n("content.revise", null, {
        tenantId,
        by,
        proposalId,
        threadId: p.thread_id || null,
        contentItemId: String(c.id),
        status: "draft.regenerating",
        feedback,
        contentPack: deepFix(c.content_pack || {}),
        jobId: c.job_id ? String(c.job_id) : null,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        dbDisabled: false,
      });

      return okJson(res, { ok: true, proposal: await dbGetProposalById(db, proposalId), content: updated });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Proposal: Publish latest approved draft
   * - Finds latest content_item with status=draft.approved and triggers publish
   * =========================== */
  r.post("/proposals/:id/publish", async (req, res) => {
    const proposalId = String(req.params.id || "").trim();
    const by = fixText(String(req.body?.by || "ceo").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!proposalId) return okJson(res, { ok: false, error: "proposal id required" });
    if (!isUuid(proposalId)) return okJson(res, { ok: false, error: "proposal id must be uuid" });

    try {
      if (!isDbReady(db)) {
        const p = mem.proposals.get(proposalId);
        if (!p) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        const approved = Array.from(mem.contentItems.values())
          .filter((x) => String(x.proposal_id) === proposalId && String(x.status) === "draft.approved")
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];

        if (!approved) return okJson(res, { ok: false, error: "no approved draft to publish", dbDisabled: true });

        memPatchContentItem(approved.id, { status: "publishing" });
        wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(approved.id) });

        notifyN8n("content.publish", null, {
          tenantId,
          by,
          proposalId,
          threadId: p.thread_id || null,
          contentItemId: approved.id,
          status: "publishing",
          contentPack: approved.content_pack || {},
          jobId: approved.job_id || null,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: true,
        });

        return okJson(res, { ok: true, proposal: p, content: mem.contentItems.get(approved.id), dbDisabled: true });
      }

      const p = await dbGetProposalById(db, proposalId);
      if (!p) return okJson(res, { ok: false, error: "proposal not found" });

      const approved = await dbGetLatestApprovedDraftByProposal(db, proposalId);
      if (!approved) return okJson(res, { ok: false, error: "no approved draft to publish" });

      const updated = await dbUpdateContentItem(db, approved.id, { status: "publishing" });
      wsHub?.broadcast?.({ type: "content.updated", content: updated });

      notifyN8n("content.publish", null, {
        tenantId,
        by,
        proposalId,
        threadId: p.thread_id || null,
        contentItemId: String(approved.id),
        status: "publishing",
        contentPack: deepFix(approved.content_pack || {}),
        jobId: approved.job_id ? String(approved.job_id) : null,
        callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
        dbDisabled: false,
      });

      return okJson(res, { ok: true, proposal: p, content: updated });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * n8n -> HQ callback (job updates) + AUTO DRAFT save
   * - Also handles publish success (permalink/assetUrls) and can mark proposal published
   * =========================== */
  r.post("/executions/callback", async (req, res) => {
    if (!requireCallbackToken(req)) return okJson(res, { ok: false, error: "forbidden (missing/invalid token)" });

    const jobId = String(req.body?.jobId || req.body?.id || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();
    const result = req.body?.result && typeof req.body.result === "object" ? deepFix(req.body.result) : {};
    const error = fixText(String(req.body?.error || "").trim());

    if (!jobId) return okJson(res, { ok: false, error: "jobId required" });
    if (!isUuid(jobId)) return okJson(res, { ok: false, error: "jobId must be uuid" });
    if (!["running", "completed", "failed"].includes(status)) {
      return okJson(res, { ok: false, error: 'status must be "running"|"completed"|"failed"' });
    }

    // Draft pack (generation workflow)
    const maybeContentPack = result?.contentPack || result?.content_pack || result?.draft || result?.draftPack || null;

    let contentPackObj = null;
    if (maybeContentPack && typeof maybeContentPack === "object") contentPackObj = maybeContentPack;
    if (typeof maybeContentPack === "string") {
      try {
        contentPackObj = JSON.parse(maybeContentPack);
      } catch {
        contentPackObj = { text: String(maybeContentPack) };
      }
    }

    // Publish outputs (publish workflow)
    const publishInfo = deepFix(result?.publish || result?.published || {});
    const permalink =
      fixText(String(result?.permalink || result?.url || publishInfo?.permalink || publishInfo?.url || "")).trim();
    const assetUrls = Array.isArray(result?.assetUrls)
      ? result.assetUrls.map((x) => String(x || "").trim()).filter(Boolean)
      : Array.isArray(publishInfo?.assetUrls)
        ? publishInfo.assetUrls.map((x) => String(x || "").trim()).filter(Boolean)
        : [];

    try {
      const patch = {
        status,
        output: result || {},
        error: error || null,
        started_at: status === "running" ? nowIso() : undefined,
        finished_at: status === "completed" || status === "failed" ? nowIso() : undefined,
      };

      if (!isDbReady(db)) {
        const row = memUpdateJob(jobId, {
          status: patch.status,
          output: { ...(mem.jobs.get(jobId)?.output || {}), ...(patch.output || {}) },
          error: patch.error ?? null,
          ...(patch.started_at ? { started_at: patch.started_at } : {}),
          ...(patch.finished_at ? { finished_at: patch.finished_at } : {}),
        });
        if (!row) return okJson(res, { ok: false, error: "job not found", dbDisabled: true });

        let content = null;

        // Draft save on completed generation
        if (contentPackObj && row.proposal_id && status === "completed") {
          content = memUpsertContentItem({
            proposalId: row.proposal_id,
            threadId: null,
            jobId: jobId,
            status: "draft.ready",
            contentPack: contentPackObj,
            feedbackText: "",
          });
          wsHub?.broadcast?.({ type: "content.updated", content });
        }

        // Publish success (permalink) -> mark content published + proposal published
        if (permalink && row.proposal_id && status === "completed") {
          const latest = memGetLatestContentByProposal(row.proposal_id);
          if (latest) {
            memPatchContentItem(latest.id, {
              status: "published",
              publish: { permalink, assetUrls, publishedAt: nowIso() },
            });
            wsHub?.broadcast?.({ type: "content.updated", content: mem.contentItems.get(latest.id) });
          }
          const p = mem.proposals.get(String(row.proposal_id));
          if (p) {
            p.status = "published";
            p.payload = deepFix(p.payload || {});
            p.payload.publish = { permalink, assetUrls, at: nowIso() };
            wsHub?.broadcast?.({ type: "proposal.updated", proposal: p });
          }
        }

        wsHub?.broadcast?.({ type: "job.updated", job: row });
        memAudit("n8n", "job.update", "job", jobId, { status });

        const n = memCreateNotification({
          recipient: "ceo",
          type: status === "completed" ? "success" : status === "failed" ? "danger" : "info",
          title: `Execution ${status.toUpperCase()}`,
          body: status === "failed" ? error || "Execution failed" : "Execution update received",
          payload: { jobId, status, result },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: n });

        await pushBroadcastToCeo({
          db,
          title: "AI HQ Execution",
          body: `${status.toUpperCase()} — job ${jobId.slice(0, 8)}`,
          data: { type: "job.updated", jobId, status },
        });

        return okJson(res, { ok: true, job: row, notification: n, content, dbDisabled: true });
      }

      const dbPatch = {
        status: patch.status,
        output: patch.output || {},
        error: patch.error || null,
        started_at: patch.started_at || null,
        finished_at: patch.finished_at || null,
      };

      const row = await dbUpdateJob(db, jobId, dbPatch);
      if (!row) return okJson(res, { ok: false, error: "job not found" });

      let content = null;

      // Draft save on completed generation
      if (contentPackObj && row.proposal_id && status === "completed") {
        content = await dbUpsertDraftFromCallback(db, {
          proposalId: String(row.proposal_id),
          threadId: null,
          jobId: String(row.id),
          status: "draft.ready",
          contentPack: contentPackObj,
        });
        wsHub?.broadcast?.({ type: "content.updated", content });
        await dbAudit(db, "n8n", "content.upsert", "content", String(content?.id || ""), { proposalId: String(row.proposal_id) });
      }

      // Publish success
      if (permalink && row.proposal_id && status === "completed") {
        // mark latest content published (best-effort)
        const latest = await dbGetLatestContentByProposal(db, String(row.proposal_id));
        if (latest) {
          const updated = await dbUpdateContentItem(db, latest.id, {
            status: "published",
            publish: { permalink, assetUrls, publishedAt: nowIso() },
          });
          wsHub?.broadcast?.({ type: "content.updated", content: updated });
        }

        // mark proposal published
        try {
          const pq = await db.query(
            `update proposals
             set status = 'published',
                 payload = (coalesce(payload,'{}'::jsonb) || jsonb_build_object('publish', jsonb_build_object(
                   'permalink', $2::text, 'assetUrls', $3::jsonb, 'at', now()
                 )))
             where id = $1::uuid
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [String(row.proposal_id), permalink, deepFix(assetUrls)]
          );
          const pRow = pq.rows?.[0] || null;
          if (pRow) {
            pRow.title = fixText(pRow.title);
            pRow.payload = deepFix(pRow.payload);
            wsHub?.broadcast?.({ type: "proposal.updated", proposal: pRow });
          }
        } catch {}
      }

      wsHub?.broadcast?.({ type: "job.updated", job: row });
      await dbAudit(db, "n8n", "job.update", "job", String(jobId), { status });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: status === "completed" ? "success" : status === "failed" ? "danger" : "info",
        title: `Execution ${status.toUpperCase()}`,
        body: status === "failed" ? error || "Execution failed" : "Execution update received",
        payload: { jobId, status, result },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "AI HQ Execution",
        body: `${status.toUpperCase()} — job ${jobId.slice(0, 8)}`,
        data: { type: "job.updated", jobId, status },
      });

      return okJson(res, { ok: true, job: row, notification: notif, content });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Executions (Jobs) list + detail ✅
   * =========================== */
  r.get("/executions", async (req, res) => {
    const status = String(req.query.status || "").trim().toLowerCase();
    const limit = clamp(req.query.limit ?? 50, 1, 200);
    const executionId = String(req.query.executionId || "").trim();

    try {
      await maybeCleanupExpired({ db });

      if (!isDbReady(db)) {
        let rows = Array.from(mem.jobs.values());
        if (status) rows = rows.filter((j) => String(j.status || "").toLowerCase() === status);
        if (executionId) {
          rows = rows.filter((j) => String(j?.output?.executionId || j?.output?.execution_id || "").trim() === executionId);
        }
        rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        rows = rows.slice(0, limit);
        return okJson(res, { ok: true, executions: rows, dbDisabled: true });
      }

      const where = [];
      const params = [];

      if (status) {
        params.push(status);
        where.push(`status = $${params.length}::text`);
      }
      if (executionId) {
        params.push(executionId);
        where.push(`(output->>'executionId' = $${params.length}::text or output->>'execution_id' = $${params.length}::text)`);
      }

      const whereSql = where.length ? `where ${where.join(" and ")}` : ``;

      const q = await db.query(
        `select id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
         from jobs
         ${whereSql}
         order by created_at desc
         limit ${limit}`,
        params
      );

      const rows = (q.rows || []).map((x) => ({
        ...x,
        input: deepFix(x.input),
        output: deepFix(x.output),
        error: x.error ? fixText(String(x.error)) : null,
      }));

      return okJson(res, { ok: true, executions: rows });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  r.get("/executions/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "execution id required" });

    try {
      await maybeCleanupExpired({ db });

      if (!isDbReady(db)) {
        const byId = mem.jobs.get(id);
        if (byId) return okJson(res, { ok: true, execution: byId, dbDisabled: true });

        if (isDigits(id)) {
          for (const j of mem.jobs.values()) {
            const ex = String(j?.output?.executionId || j?.output?.execution_id || "").trim();
            if (ex === id) return okJson(res, { ok: true, execution: j, dbDisabled: true });
          }
        }

        return okJson(res, { ok: false, error: "not found", dbDisabled: true });
      }

      if (isUuid(id)) {
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
      }

      if (isDigits(id)) {
        const q = await db.query(
          `select id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
           from jobs
           where (output->>'executionId' = $1::text or output->>'execution_id' = $1::text)
           order by created_at desc
           limit 1`,
          [id]
        );

        const row = q.rows?.[0] || null;
        if (!row) return okJson(res, { ok: false, error: "not found" });

        row.input = deepFix(row.input);
        row.output = deepFix(row.output);
        row.error = row.error ? fixText(String(row.error)) : null;

        return okJson(res, { ok: true, execution: row, resolvedBy: "output.executionId" });
      }

      return okJson(res, { ok: false, error: "id must be uuid (or digits executionId)" });
    } catch (e) {
      const details = serializeError(e);
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
        const messages = (mem.messages.get(threadId) || []).map((m) => ({
          ...m,
          content: fixText(m.content),
          meta: deepFix(m.meta),
        }));
        return okJson(res, { ok: true, threadId, messages, dbDisabled: true });
      }

      const q = await db.query(
        `select id, thread_id, role, agent, content, meta, created_at
         from messages
         where thread_id = $1::uuid
         order by created_at asc`,
        [threadId]
      );

      const rows = (q.rows || []).map((m) => ({ ...m, content: fixText(m.content), meta: deepFix(m.meta) }));
      return okJson(res, { ok: true, threadId, messages: rows });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Proposals list (WITH latestDraft) ✅
   * =========================== */
  r.get("/proposals", async (req, res) => {
    const status = String(req.query.status || "pending").trim();

    try {
      // MEM mode
      if (!isDbReady(db)) {
        const proposals = memListProposals(status).map((p) => {
          const latest = memGetLatestContentByProposal(p.id);
          const latestDraft = latest
            ? {
                id: latest.id,
                status: fixText(latest.status),
                updatedAt: latest.updated_at || latest.updatedAt || null,
                version: Number(latest.version || 1),
                contentPack: deepFix(latest.content_pack || latest.contentPack || {}),
                lastFeedback: fixText(latest.last_feedback || latest.lastFeedback || ""),
                publish: deepFix(latest.publish || {}),
              }
            : null;

          return {
            ...p,
            title: fixText(p.title),
            payload: deepFix(p.payload),
            latestDraft,
          };
        });

        return okJson(res, { ok: true, status, proposals, dbDisabled: true });
      }

      // DB mode (LATERAL join latest draft.*)
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

          ci.id           as latest_draft_id,
          ci.status       as latest_draft_status,
          ci.version      as latest_draft_version,
          ci.updated_at   as latest_draft_updated_at,
          ci.content_pack as latest_draft_content_pack,
          ci.last_feedback as latest_draft_last_feedback,
          ci.publish      as latest_draft_publish

        from proposals p
        left join lateral (
          select id, status, version, updated_at, content_pack, last_feedback, publish
          from content_items
          where proposal_id = p.id
          order by updated_at desc
          limit 1
        ) ci on true

        where p.status = $1::text
        order by p.created_at desc
        limit 100
        `,
        [status]
      );

      const proposals = (q.rows || []).map((row) => {
        const latestDraft = row.latest_draft_id
          ? {
              id: String(row.latest_draft_id),
              status: fixText(row.latest_draft_status),
              updatedAt: row.latest_draft_updated_at || null,
              version: Number(row.latest_draft_version || 1),
              contentPack: deepFix(row.latest_draft_content_pack || {}),
              lastFeedback: fixText(row.latest_draft_last_feedback || ""),
              publish: deepFix(row.latest_draft_publish || {}),
            }
          : null;

        delete row.latest_draft_id;
        delete row.latest_draft_status;
        delete row.latest_draft_version;
        delete row.latest_draft_updated_at;
        delete row.latest_draft_content_pack;
        delete row.latest_draft_last_feedback;
        delete row.latest_draft_publish;

        return {
          ...row,
          title: fixText(row.title),
          payload: deepFix(row.payload),
          latestDraft,
        };
      });

      return okJson(res, { ok: true, status, proposals });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Decision + Job + n8n + notify + push
   *
   * ✅ NEW FLOW:
   * - decision=approved => proposal.status becomes "in_progress" (NOT approved),
   *   job created + n8n proposal.approved
   * - decision=rejected => proposal.status="rejected" (final)
   * =========================== */
  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = normalizeDecision(req.body?.decision);
    const by = fixText(String(req.body?.by || "ceo").trim());
    const reason = fixText(String(req.body?.reason || req.body?.note || "").trim());
    const tenantId = fixText(String(req.body?.tenantId || "default").trim()) || "default";

    if (!id) return okJson(res, { ok: false, error: "proposal id required" });
    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, { ok: false, error: 'decision must be "approved" or "rejected" (or approve/reject)' });
    }

    // approve => in_progress
    const nextStatus = decision === "approved" ? "in_progress" : "rejected";

    try {
      if (!isDbReady(db)) {
        const row = mem.proposals.get(id);
        if (!row) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        // Only allow decisions while pending
        if (row.status !== "pending") {
          return okJson(res, { ok: false, error: "proposal already decided", proposal: row, dbDisabled: true });
        }

        row.status = nextStatus;
        row.decided_at = nowIso();
        row.decision_by = by;
        row.title = fixText(row.title || "");
        row.payload = deepFix(row.payload && typeof row.payload === "object" ? row.payload : {});
        row.payload.decision = {
          by,
          decision: decision, // approved/rejected (logical)
          status: nextStatus, // in_progress/rejected
          reason: decision === "rejected" ? reason : "",
          at: row.decided_at,
        };

        wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
        memAudit(by, "proposal.decision", "proposal", id, { decision, status: nextStatus });

        const notif = memCreateNotification({
          recipient: "ceo",
          type: decision === "approved" ? "info" : "warning",
          title: decision === "approved" ? "Proposal Approved → Drafting" : "Proposal Rejected",
          body: row.title || "",
          payload: { proposalId: row.id, threadId: row.thread_id, decision, status: nextStatus, reason },
        });
        wsHub?.broadcast?.({ type: "notification.created", notification: notif });

        await pushBroadcastToCeo({
          db,
          title: "AI HQ Proposal",
          body: `${nextStatus.toUpperCase()} — ${row.title || "Proposal"}`,
          data: { type: "proposal.updated", proposalId: row.id, decision, status: nextStatus },
        });

        await maybeTelegram(`AI HQ: proposal ${nextStatus}\n${row.title || row.id}`);

        let job = null;
        if (decision === "approved") {
          job = memCreateJob({
            proposalId: row.id,
            type: String(row.type || "generic"),
            status: "queued",
            input: { tenantId, proposal: row },
          });
          wsHub?.broadcast?.({ type: "job.updated", job });
          memAudit("system", "job.create", "job", job.id, { proposalId: row.id });

          notifyN8n("proposal.approved", row, {
            tenantId,
            by,
            decision: "approved",
            status: "in_progress",
            jobId: job.id,
            callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
            dbDisabled: true,
          });
        } else {
          notifyN8n("proposal.rejected", row, { tenantId, by, decision: "rejected", status: "rejected", reason, dbDisabled: true });
        }

        return okJson(res, { ok: true, proposal: row, notification: notif, job, dbDisabled: true });
      }

      // DB mode: allow decision only while status='pending'
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
                          'decision', $3::text,
                          'status', $1::text,
                          'reason', $4::text,
                          'at', now()
                        ),
                        'tenantId', $6::text
                      ))
         where id::text = $5::text
           and status = 'pending'
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [
          nextStatus,                             // $1
          by,                                     // $2
          decision,                               // $3
          decision === "rejected" ? reason : "",   // $4
          id,                                     // $5 (legacy-safe)
          tenantId,                               // $6
        ]
      );

      let row = q.rows?.[0] || null;
      if (!row) {
        const existing = await dbGetProposalById(db, id);
        if (!existing) return okJson(res, { ok: false, error: "proposal not found" });
        return okJson(res, { ok: false, error: "proposal already decided", proposal: existing });
      }

      row = { ...row, title: fixText(row.title), payload: deepFix(row.payload) };

      wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
      await dbAudit(db, by, "proposal.decision", "proposal", String(row.id), { decision, status: nextStatus });

      const notif = await dbCreateNotification(db, {
        recipient: "ceo",
        type: decision === "approved" ? "info" : "warning",
        title: decision === "approved" ? "Proposal Approved → Drafting" : "Proposal Rejected",
        body: row.title || "",
        payload: {
          proposalId: row.id,
          threadId: row.thread_id,
          decision,
          status: nextStatus,
          reason: decision === "rejected" ? reason : "",
        },
      });
      wsHub?.broadcast?.({ type: "notification.created", notification: notif });

      await pushBroadcastToCeo({
        db,
        title: "AI HQ Proposal",
        body: `${nextStatus.toUpperCase()} — ${row.title || "Proposal"}`,
        data: { type: "proposal.updated", proposalId: String(row.id), decision, status: nextStatus },
      });

      await maybeTelegram(`AI HQ: proposal ${nextStatus}\n${row.title || row.id}`);

      let job = null;
      if (decision === "approved") {
        job = await dbCreateJob(db, {
          proposalId: row.id,
          type: String(row.type || "generic"),
          status: "queued",
          input: { tenantId, proposal: row },
        });

        wsHub?.broadcast?.({ type: "job.updated", job });
        await dbAudit(db, "system", "job.create", "job", String(job.id), { proposalId: String(row.id) });

        notifyN8n("proposal.approved", row, {
          tenantId,
          by,
          decision: "approved",
          status: "in_progress",
          jobId: job.id,
          callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
          dbDisabled: false,
        });
      } else {
        notifyN8n("proposal.rejected", row, { tenantId, by, decision: "rejected", status: "rejected", reason, dbDisabled: false });
      }

      return okJson(res, { ok: true, proposal: row, notification: notif, job });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Chat
   * =========================== */
  r.post("/chat", async (req, res) => {
    const message = fixText(String(req.body?.message || "")).trim();
    const agent = fixText(String(req.body?.agent || req.body?.agentId || "")).trim();
    const threadIdIn = String(req.body?.threadId || "").trim();
    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: {} });

        const out = await kernelHandle({ message, agentHint: agent || undefined });
        const replyText = fixText(out.replyText || "");

        memAddMessage(threadId, { role: "assistant", agent: out.agent || null, content: replyText, meta: {} });
        wsHub?.broadcast?.({
          type: "thread.message",
          threadId,
          message: { role: "assistant", agent: out.agent, content: replyText, at: nowIso() },
        });

        return okJson(res, {
          ok: true,
          threadId,
          agent: out.agent,
          replyText: replyText || "(no text)",
          proposal: null,
          dbDisabled: true,
        });
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
      const replyText = fixText(out.replyText || "");

      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)`,
        [threadId, out.agent || null, replyText, {}]
      );

      wsHub?.broadcast?.({
        type: "thread.message",
        threadId,
        message: { role: "assistant", agent: out.agent, content: replyText, at: nowIso() },
      });

      return okJson(res, {
        ok: true,
        threadId,
        agent: out.agent,
        replyText: replyText || "(no text)",
        proposal: null,
      });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Debate
   * =========================== */
  r.post("/debate", async (req, res) => {
    const message = fixText(String(req.body?.message || "")).trim();
    const agent = fixText(String(req.body?.agent || "")).trim();
    const threadIdIn = String(req.body?.threadId || "").trim();
    const rounds = clamp(req.body?.rounds ?? 2, 1, 3);

    let mode = String(req.body?.mode || "proposal").trim().toLowerCase();
    if (mode !== "proposal" && mode !== "answer") mode = "proposal";

    let agents = Array.isArray(req.body?.agents) ? req.body.agents : ["orion", "nova", "atlas", "echo"];
    agents = agents.map((x) => fixText(String(x || "").trim())).filter(Boolean);
    if (agents.length === 0) agents = ["orion", "nova", "atlas", "echo"];

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
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

      let synthesisText = fixText(String(out.finalAnswer || "")).trim();
      if (!synthesisText) synthesisText = fallbackSynthesisFromNotes(out);

      if (!isDbReady(db)) {
        memAddMessage(threadId, {
          role: "assistant",
          agent: "kernel",
          content: synthesisText,
          meta: { kind: "debate.synthesis" },
        });
      } else {
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1::uuid, 'assistant', $2::text, $3::text, $4::jsonb)`,
          [threadId, "kernel", synthesisText, { kind: "debate.synthesis" }]
        );
      }

      let savedProposal = null;
      if (out.proposal && typeof out.proposal === "object") {
        const p = deepFix(out.proposal || {});
        const type = fixText(String(p.type || "plan"));
        const title = fixText(String(p.title || "Debate Proposal"));
        const payload = deepFix(p.payload || p || {});

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
          if (savedProposal) {
            savedProposal.title = fixText(savedProposal.title);
            savedProposal.payload = deepFix(savedProposal.payload);
          }
        }

        wsHub?.broadcast?.({ type: "proposal.created", proposal: savedProposal });

        const notifPayload = { proposalId: savedProposal?.id, threadId };
        let notif = null;

        if (!isDbReady(db)) {
          notif = memCreateNotification({
            recipient: "ceo",
            type: "info",
            title: "New Proposal Needs Review",
            body: savedProposal?.title || "",
            payload: notifPayload,
          });
          wsHub?.broadcast?.({ type: "notification.created", notification: notif });
        } else {
          notif = await dbCreateNotification(db, {
            recipient: "ceo",
            type: "info",
            title: "New Proposal Needs Review",
            body: savedProposal?.title || "",
            payload: notifPayload,
          });
          wsHub?.broadcast?.({ type: "notification.created", notification: notif });
          await dbAudit(db, "kernel", "proposal.create", "proposal", String(savedProposal?.id || ""), { type });
        }

        await pushBroadcastToCeo({
          db,
          title: "New Proposal",
          body: savedProposal?.title || "New proposal needs review",
          data: { type: "proposal.created", proposalId: String(savedProposal?.id || "") },
        });

        await maybeTelegram(`AI HQ: new proposal\n${savedProposal?.title || savedProposal?.id}`);
      }

      return okJson(res, {
        ok: true,
        threadId,
        finalAnswer: synthesisText,
        agentNotes: deepFix(out.agentNotes || []),
        proposal: savedProposal,
        dbDisabled: !isDbReady(db),
      });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  /** ===========================
   * Debug OpenAI
   * =========================== */
  r.post("/debug/openai", async (req, res) => {
    if (!requireDebugToken(req)) return okJson(res, { ok: false, error: "forbidden (missing/invalid debug token)" });

    try {
      const agent = fixText(String(req.body?.agent || "orion").trim());
      const message = fixText(String(req.body?.message || "ping").trim());

      const out = await debugOpenAI({ agent, message });
      const raw = fixText(String(out.raw || ""));

      return okJson(res, {
        ok: Boolean(out.ok),
        status: out.status || null,
        agent: out.agent,
        extractedText: fixText(out.extractedText || ""),
        raw: raw.slice(0, 4000),
      });
    } catch (e) {
      const details = serializeError(e);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  return r;
}