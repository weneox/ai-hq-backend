// src/db/helpers/tenantUsers.js
// FINAL — tenant user helpers

function rowOrNull(r) {
  return r?.rows?.[0] || null;
}

function rows(r) {
  return Array.isArray(r?.rows) ? r.rows : [];
}

function cleanString(v, fallback = "") {
  if (v === null || v === undefined) return String(fallback ?? "").trim();
  const s = String(v).trim();
  if (!s) return String(fallback ?? "").trim();
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") {
    return String(fallback ?? "").trim();
  }
  return s;
}

function cleanNullableString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
  return s;
}

function cleanLower(v, fallback = "") {
  return cleanString(v, fallback).toLowerCase();
}

function asJsonObject(v, fallback = {}) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
}

function json(v, fallback) {
  try {
    return JSON.stringify(v ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function normalizeRole(role) {
  const r = cleanLower(role, "member");
  if (
    r === "owner" ||
    r === "admin" ||
    r === "operator" ||
    r === "member" ||
    r === "marketer" ||
    r === "analyst"
  ) {
    return r;
  }
  return "member";
}

function normalizeStatus(status) {
  const s = cleanLower(status, "invited");
  if (s === "invited" || s === "active" || s === "disabled" || s === "removed") {
    return s;
  }
  return "invited";
}

export async function dbGetTenantUserById(db, tenantId, userId) {
  if (!db || !tenantId || !userId) return null;

  const q = await db.query(
    `
      select
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
      from tenant_users
      where tenant_id = $1
        and id = $2
      limit 1
    `,
    [tenantId, userId]
  );

  return rowOrNull(q);
}

export async function dbGetTenantUserByEmail(db, tenantId, email) {
  if (!db || !tenantId || !email) return null;

  const q = await db.query(
    `
      select
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
      from tenant_users
      where tenant_id = $1
        and lower(user_email) = $2
      limit 1
    `,
    [tenantId, cleanLower(email)]
  );

  return rowOrNull(q);
}

export async function dbListTenantUsers(db, tenantId, opts = {}) {
  if (!db || !tenantId) return [];

  const status = cleanLower(opts.status || "");
  const role = cleanLower(opts.role || "");

  const clauses = [`tenant_id = $1`];
  const params = [tenantId];
  let i = 2;

  if (status) {
    clauses.push(`status = $${i++}`);
    params.push(status);
  }

  if (role) {
    clauses.push(`role = $${i++}`);
    params.push(role);
  }

  const q = await db.query(
    `
      select
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
      from tenant_users
      where ${clauses.join(" and ")}
      order by created_at asc
    `,
    params
  );

  return rows(q);
}

export async function dbCreateTenantUser(db, tenantId, input = {}) {
  if (!db || !tenantId) return null;

  const q = await db.query(
    `
      insert into tenant_users (
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at
      )
      values (
        $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8
      )
      returning
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
    `,
    [
      tenantId,
      cleanLower(input.user_email),
      cleanString(input.full_name, ""),
      normalizeRole(input.role),
      normalizeStatus(input.status),
      json(asJsonObject(input.permissions, {}), {}),
      json(asJsonObject(input.meta, {}), {}),
      cleanNullableString(input.last_seen_at),
    ]
  );

  return rowOrNull(q);
}

export async function dbUpsertTenantUserByEmail(db, tenantId, input = {}) {
  if (!db || !tenantId || !input?.user_email) return null;

  const existing = await dbGetTenantUserByEmail(db, tenantId, input.user_email);

  if (existing?.id) {
    const q = await db.query(
      `
        update tenant_users
        set
          full_name = $2,
          role = $3,
          status = $4,
          permissions = $5::jsonb,
          meta = $6::jsonb,
          last_seen_at = coalesce($7, last_seen_at)
        where id = $1
        returning
          id,
          tenant_id,
          user_email,
          full_name,
          role,
          status,
          permissions,
          meta,
          last_seen_at,
          created_at,
          updated_at
      `,
      [
        existing.id,
        cleanString(input.full_name, existing.full_name || ""),
        normalizeRole(input.role || existing.role),
        normalizeStatus(input.status || existing.status),
        json(asJsonObject(input.permissions, existing.permissions || {}), {}),
        json(asJsonObject(input.meta, existing.meta || {}), {}),
        cleanNullableString(input.last_seen_at),
      ]
    );

    return rowOrNull(q);
  }

  return dbCreateTenantUser(db, tenantId, input);
}

export async function dbUpdateTenantUser(db, tenantId, userId, input = {}) {
  if (!db || !tenantId || !userId) return null;

  const current = await dbGetTenantUserById(db, tenantId, userId);
  if (!current) return null;

  const q = await db.query(
    `
      update tenant_users
      set
        user_email = $2,
        full_name = $3,
        role = $4,
        status = $5,
        permissions = $6::jsonb,
        meta = $7::jsonb,
        last_seen_at = $8
      where id = $1
        and tenant_id = $9
      returning
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
    `,
    [
      userId,
      cleanLower(input.user_email || current.user_email),
      cleanString(input.full_name, current.full_name || ""),
      normalizeRole(input.role || current.role),
      normalizeStatus(input.status || current.status),
      json(asJsonObject(input.permissions, current.permissions || {}), {}),
      json(asJsonObject(input.meta, current.meta || {}), {}),
      cleanNullableString(input.last_seen_at) || current.last_seen_at,
      tenantId,
    ]
  );

  return rowOrNull(q);
}

export async function dbSetTenantUserStatus(db, tenantId, userId, status) {
  if (!db || !tenantId || !userId) return null;

  const q = await db.query(
    `
      update tenant_users
      set status = $3
      where id = $1
        and tenant_id = $2
      returning
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
    `,
    [userId, tenantId, normalizeStatus(status)]
  );

  return rowOrNull(q);
}

export async function dbDeleteTenantUser(db, tenantId, userId) {
  if (!db || !tenantId || !userId) return false;

  const q = await db.query(
    `
      delete from tenant_users
      where id = $1
        and tenant_id = $2
    `,
    [userId, tenantId]
  );

  return (q?.rowCount || 0) > 0;
}