import crypto from "crypto";
import { deepFix, fixText } from "./textFix.js";
import { nowIso } from "./http.js";

export const mem = {
  threads: new Map(),
  messages: new Map(),
  proposals: new Map(),
  notifications: new Map(),
  jobs: new Map(),
  pushSubs: new Map(),
  contentItems: new Map(),
  contentByProposal: new Map(),
  audit: [],
  tenantMode: new Map(), // tenantId -> "manual"|"auto"
};

export function memEnsureThread(threadId, title) {
  if (!mem.threads.has(threadId)) {
    mem.threads.set(threadId, {
      id: threadId,
      title: fixText(title || `Thread ${nowIso()}`),
      created_at: nowIso(),
    });
  }
  if (!mem.messages.has(threadId)) mem.messages.set(threadId, []);
  return mem.threads.get(threadId);
}

export function memAddMessage(threadId, { role, agent, content, meta }) {
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

export function memCreateProposal(threadId, { agent, type, title, payload }) {
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

export function memListProposals(status = "pending") {
  const out = [];
  for (const p of mem.proposals.values()) {
    if (String(p.status) === String(status)) out.push(p);
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, 100);
}

export function memCreateNotification({
  recipient = "ceo",
  type = "info",
  title = "",
  body = "",
  payload = {},
}) {
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

export function memListNotifications({ recipient = "ceo", unreadOnly = false, limit = 50 }) {
  const rows = [];
  for (const n of mem.notifications.values()) {
    if (n.recipient !== recipient) continue;
    if (unreadOnly && n.read_at) continue;
    rows.push(n);
  }
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function memMarkRead(id) {
  const row = mem.notifications.get(id);
  if (!row) return null;
  if (!row.read_at) row.read_at = nowIso();
  return row;
}

export function memCreateJob({ proposalId = null, type = "generic", status = "queued", input = {} }) {
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

export function memUpdateJob(id, patch) {
  const row = mem.jobs.get(id);
  if (!row) return null;
  Object.assign(row, patch || {});
  row.input = deepFix(row.input || {});
  row.output = deepFix(row.output || {});
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}

export function memAudit(actor, action, objectType, objectId, meta = {}) {
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

/** content helpers */
export function memGetLatestContentByProposal(proposalId) {
  const id = mem.contentByProposal.get(String(proposalId));
  if (!id) return null;
  return mem.contentItems.get(id) || null;
}

export function memUpsertContentItem({
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
    publish: deepFix(existing?.publish || {}),
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };

  mem.contentItems.set(id, row);
  mem.contentByProposal.set(String(proposalId), id);
  return row;
}

export function memPatchContentItem(id, patch = {}) {
  const row = mem.contentItems.get(String(id));
  if (!row) return null;
  Object.assign(row, deepFix(patch));
  row.updated_at = nowIso();
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  return row;
}