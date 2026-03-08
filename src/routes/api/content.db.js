import { isUuid } from "../../utils/http.js";

export async function dbGetContentById(db, id) {
  if (!isUuid(id)) return null;

  const q = await db.query(
    `select id, proposal_id, thread_id, job_id, status, content_pack, publish, last_feedback, created_at, updated_at
     from content_items
     where id = $1::uuid
     limit 1`,
    [id]
  );

  return q.rows?.[0] || null;
}