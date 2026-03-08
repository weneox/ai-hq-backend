import { isUuid } from "../../utils/http.js";
import {
  dbGetLatestContentByProposal,
  dbGetLatestDraftLikeByProposal,
} from "../../db/helpers/content.js";

export async function dbFindContentItemById(db, id) {
  if (!id || !isUuid(id)) return null;

  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, content_pack, publish, created_at, updated_at
     from content_items
     where id = $1::uuid
     limit 1`,
    [id]
  );

  return q.rows?.[0] || null;
}

export async function resolveDbContentRowForUpdate(db, proposalId, contentId) {
  if (contentId && isUuid(contentId)) {
    const exact = await dbFindContentItemById(db, contentId);
    if (exact) return exact;
  }

  const latestDraftLike = await dbGetLatestDraftLikeByProposal(db, proposalId);
  if (latestDraftLike) return latestDraftLike;

  return await dbGetLatestContentByProposal(db, proposalId);
}