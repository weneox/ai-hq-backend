import { deepFix, fixText } from "../../utils/textFix.js";

function cleanText(v, fallback = null) {
  const s = fixText(v == null ? "" : String(v)).trim();
  return s || fallback;
}

export async function dbAudit(db, actor, action, objectType, objectId, meta = {}) {
  try {
    const safeMeta = deepFix(meta || {});

    const tenantId =
      safeMeta.tenantId ||
      safeMeta.tenant_id ||
      null;

    const tenantKey =
      cleanText(safeMeta.tenantKey) ||
      cleanText(safeMeta.tenant_key) ||
      null;

    await db.query(
      `insert into audit_log (
        tenant_id,
        tenant_key,
        actor,
        action,
        object_type,
        object_id,
        meta
      )
      values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb)`,
      [
        tenantId,
        tenantKey,
        cleanText(actor, "system"),
        cleanText(action, "unknown.action"),
        cleanText(objectType, "unknown"),
        objectId == null ? null : String(objectId),
        safeMeta,
      ]
    );
  } catch {}
}