// src/db/helpers/content.js (FINAL — versioned drafts + safe uuid)
// - Keeps history by inserting a new row on new jobId callbacks (v1, v2, v3...)
// - Avoids uuid cast errors when threadId/jobId is missing
// - Normalizes json/text outputs for frontend

import { deepFix, fixText } from "../../utils/textFix.js";

function isUuidLike(x) {
  const s = String(x || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function normUuidOrNull(x) {
  const s = String(x || "").trim();
  if (!s) return null;
  return isUuidLike(s) ? s : null;
}

function normTextOrNull(x) {
  if (x === null || x === undefined) return null;
  const s = fixText(String(x)).trim();
  return s ? s : null;
}

function normalizeRow(row) {
  if (!row) return null;
  row.content_pack = deepFix(row.content_pack);
  row.last_feedback = fixText(row.last_feedback || "");
  row.status = fixText(row.status || "");
  row.publish = deepFix(row.publish || {});
  return row;
}

export async function dbGetLatestContentByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
     order by updated_at desc nulls last, created_at desc
     limit 1`,
    [proposalId]
  );
  return normalizeRow(q.rows?.[0] || null);
}

export async function dbGetLatestDraftLikeByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
       and (status like 'draft.%' or status in ('draft.ready','draft.regenerating','draft.approved'))
     order by updated_at desc nulls last, created_at desc
     limit 1`,
    [proposalId]
  );
  return normalizeRow(q.rows?.[0] || null);
}

export async function dbGetLatestApprovedDraftByProposal(db, proposalId) {
  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at
     from content_items
     where proposal_id = $1::uuid
       and status = 'draft.approved'
     order by updated_at desc nulls last, created_at desc
     limit 1`,
    [proposalId]
  );
  return normalizeRow(q.rows?.[0] || null);
}

export async function dbUpdateContentItem(db, id, patch = {}) {
  const status = normTextOrNull(patch.status);
  const lastFeedback = patch.last_feedback ?? patch.lastFeedback ?? null;
  const contentPack = patch.content_pack ?? patch.contentPack ?? null;
  const version = patch.version ?? null;
  const jobId = normUuidOrNull(patch.job_id ?? patch.jobId);
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
      status,
      version != null ? Number(version) : null,
      jobId,
      lastFeedback != null ? fixText(String(lastFeedback)) : null,
      contentPack != null ? deepFix(contentPack) : null,
      publish != null ? deepFix(publish) : null,
    ]
  );

  return normalizeRow(q.rows?.[0] || null);
}

/**
 * Inserts a new content_items row (new version).
 * Use this when a new generation job completes (v2, v3...).
 */
export async function dbInsertContentItem(db, {
  proposalId,
  threadId = null,
  jobId = null,
  status = "draft.ready",
  version = 1,
  contentPack = {},
  lastFeedback = "",
  publish = {},
}) {
  const tId = normUuidOrNull(threadId);
  const jId = normUuidOrNull(jobId);
  const st = normTextOrNull(status) || "draft.ready";

  const q = await db.query(
    `insert into content_items (proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish)
     values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::int, $6::jsonb, $7::text, $8::jsonb)
     returning id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at`,
    [
      proposalId,
      tId,
      jId,
      st,
      Number(version) || 1,
      deepFix(contentPack || {}),
      fixText(String(lastFeedback || "")),
      deepFix(publish || {}),
    ]
  );

  return normalizeRow(q.rows?.[0] || null);
}

/**
 * Used by /api/executions/callback for "draft" generation / revise:
 * - If no existing content row => insert v1
 * - If callback has a NEW jobId (different from latest) => insert v(next)
 * - Else => update latest row
 *
 * This preserves history: v1, v2, v3...
 */
export async function dbUpsertDraftFromCallback(db, {
  proposalId,
  threadId = null,
  jobId = null,
  status = "draft.ready",
  contentPack = {},
  publish = null,       // optional
  lastFeedback = null,  // optional
}) {
  const existing = await dbGetLatestContentByProposal(db, proposalId);

  // v1
  if (!existing) {
    return await dbInsertContentItem(db, {
      proposalId,
      threadId,
      jobId,
      status,
      version: 1,
      contentPack,
      lastFeedback: "",
      publish: publish || {},
    });
  }

  const incomingJob = normUuidOrNull(jobId);
  const existingJob = normUuidOrNull(existing.job_id);

  // If new generation job => new row with version+1 (keeps history)
  if (incomingJob && incomingJob !== existingJob) {
    const nextVersion = (Number(existing.version) || 1) + 1;
    return await dbInsertContentItem(db, {
      proposalId,
      threadId: threadId || existing.thread_id || null,
      jobId: incomingJob,
      status,
      version: nextVersion,
      contentPack,
      lastFeedback: lastFeedback != null ? lastFeedback : (existing.last_feedback || ""),
      publish: publish || {},
    });
  }

  // Otherwise update latest row (same job or no jobId)
  return await dbUpdateContentItem(db, existing.id, {
    status,
    job_id: incomingJob || existing.job_id || null,
    content_pack: contentPack,
    ...(lastFeedback != null ? { last_feedback: lastFeedback } : {}),
    ...(publish != null ? { publish } : {}),
    // version stays as-is here
  });
}