export async function dbGetTenantMode(db, tenantId) {
  const q = await db.query(
    `select key, mode from tenants where key = $1::text limit 1`,
    [String(tenantId)]
  );
  return q.rows?.[0] || null;
}

export async function dbSetTenantMode(db, tenantId, mode) {
  const q = await db.query(
    `update tenants set mode = $2::text where key = $1::text returning key, mode`,
    [String(tenantId), String(mode)]
  );
  return q.rows?.[0] || null;
}