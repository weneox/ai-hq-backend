import { deepFix, fixText } from "../../utils/textFix.js";

export async function dbAudit(db, actor, action, objectType, objectId, meta) {
  try {
    await db.query(
      `insert into audit_log (actor, action, object_type, object_id, meta)
       values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)`,
      [fixText(actor || "system"), action, objectType || "unknown", objectId || null, deepFix(meta || {})]
    );
  } catch {}
}