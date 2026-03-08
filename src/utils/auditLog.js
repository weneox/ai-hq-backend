// src/utils/auditLog.js
function s(v) {
  return String(v ?? "").trim();
}

export async function writeAudit(db, entry = {}) {
  try {
    if (!db || typeof db.query !== "function") return null;

    const actor = s(entry.actor || "system") || "system";
    const action = s(entry.action || "unknown") || "unknown";
    const objectType = s(entry.objectType || "unknown") || "unknown";
    const objectId = s(entry.objectId || "") || null;
    const meta =
      entry.meta && typeof entry.meta === "object" ? entry.meta : {};

    const result = await db.query(
      `
      insert into audit_log (
        actor,
        action,
        object_type,
        object_id,
        meta
      )
      values (
        $1::text,
        $2::text,
        $3::text,
        $4::text,
        $5::jsonb
      )
      returning id, actor, action, object_type, object_id, meta, created_at
      `,
      [
        actor,
        action,
        objectType,
        objectId,
        JSON.stringify(meta),
      ]
    );

    return result.rows?.[0] || null;
  } catch {
    return null;
  }
}