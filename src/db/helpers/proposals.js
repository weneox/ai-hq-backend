import { deepFix, fixText } from "../../utils/textFix.js";

export async function dbGetProposalById(db, idText) {
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

export async function dbSetProposalStatus(db, idText, status, patchPayload = {}) {
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