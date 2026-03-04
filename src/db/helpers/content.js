import { deepFix, fixText } from "../../utils/textFix.js";

export async function dbGetLatestContentByProposal(db, proposalId) {
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

export async function dbGetLatestDraftLikeByProposal(db, proposalId) {
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

export async function dbGetLatestApprovedDraftByProposal(db, proposalId) {
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

export async function dbUpdateContentItem(db, id, patch = {}) {
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

export async function dbUpsertDraftFromCallback(db, { proposalId, threadId=null, jobId=null, status="draft.ready", contentPack={} }) {
  const existing = await dbGetLatestContentByProposal(db, proposalId);
  if (!existing) {
    const q = await db.query(
      `insert into content_items (proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish)
       values ($1::uuid, $2::uuid, $3::uuid, $4::text, 1, $5::jsonb, '', '{}'::jsonb)
       returning id, proposal_id, thread_id, job_id, status, version, content_pack, last_feedback, publish, created_at, updated_at`,
      [proposalId, threadId, jobId, fixText(status), deepFix(contentPack || {})]
    );
    const row = q.rows?.[0] || null;
    if (!row) return null;
    row.content_pack = deepFix(row.content_pack);
    row.last_feedback = fixText(row.last_feedback || "");
    row.status = fixText(row.status || "");
    row.publish = deepFix(row.publish || {});
    return row;
  }
  const nextVersion = (Number(existing.version) || 1) + 1;
  return await dbUpdateContentItem(db, existing.id, {
    status,
    version: nextVersion,
    job_id: jobId || existing.job_id,
    content_pack: contentPack,
  });
}