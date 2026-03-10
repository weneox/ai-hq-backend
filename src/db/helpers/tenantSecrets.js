// src/db/helpers/tenantSecrets.js

import {
  encryptTenantSecret,
  decryptTenantSecret,
  maskSecret,
} from "../../utils/tenantSecretsCrypto.js";

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

function cleanLower(v, fallback = "") {
  return cleanString(v, fallback).toLowerCase();
}

function cleanNullableString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
  return s;
}

function toMaskedRow(row) {
  let masked = "";
  try {
    masked = maskSecret(decryptTenantSecret(row));
  } catch {
    masked = "***";
  }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider,
    secret_key: row.secret_key,
    masked_value: masked,
    version: row.version,
    is_active: row.is_active,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRawSecretRow(row) {
  let value = null;
  try {
    value = decryptTenantSecret(row);
  } catch {
    value = null;
  }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider,
    secret_key: row.secret_key,
    value,
    version: row.version,
    is_active: row.is_active,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function dbListTenantSecrets(db, tenantId, provider = "") {
  if (!db || !tenantId) return [];

  const safeProvider = cleanLower(provider);
  const params = [tenantId];
  let where = `where tenant_id = $1`;

  if (safeProvider) {
    params.push(safeProvider);
    where += ` and provider = $2`;
  }

  const q = await db.query(
    `
      select
        id,
        tenant_id,
        provider,
        secret_key,
        version,
        is_active,
        created_by,
        updated_by,
        created_at,
        updated_at
      from tenant_secrets
      ${where}
      order by provider asc, secret_key asc, updated_at desc
    `,
    params
  );

  return rows(q);
}

export async function dbGetTenantSecretRow(db, tenantId, provider, secretKey) {
  if (!db || !tenantId || !provider || !secretKey) return null;

  const q = await db.query(
    `
      select *
      from tenant_secrets
      where tenant_id = $1
        and provider = $2
        and secret_key = $3
        and is_active = true
      limit 1
    `,
    [tenantId, cleanLower(provider), cleanLower(secretKey)]
  );

  return rowOrNull(q);
}

export async function dbGetTenantSecretValue(db, tenantId, provider, secretKey) {
  const row = await dbGetTenantSecretRow(db, tenantId, provider, secretKey);
  if (!row) return null;
  return decryptTenantSecret(row);
}

export async function dbGetTenantProviderSecrets(db, tenantId, provider) {
  if (!db || !tenantId || !provider) return {};

  const q = await db.query(
    `
      select *
      from tenant_secrets
      where tenant_id = $1
        and provider = $2
        and is_active = true
      order by secret_key asc
    `,
    [tenantId, cleanLower(provider)]
  );

  const out = {};
  for (const row of rows(q)) {
    try {
      out[row.secret_key] = decryptTenantSecret(row);
    } catch {
      out[row.secret_key] = null;
    }
  }

  return out;
}

export async function dbUpsertTenantSecret(
  db,
  tenantId,
  provider,
  secretKey,
  secretValue,
  actor = "system"
) {
  if (!db || !tenantId || !provider || !secretKey) return null;

  const safeProvider = cleanLower(provider);
  const safeSecretKey = cleanLower(secretKey);
  const safeActor = cleanNullableString(actor) || "system";
  const encrypted = encryptTenantSecret(secretValue);

  const q = await db.query(
    `
      insert into tenant_secrets (
        tenant_id,
        provider,
        secret_key,
        secret_value_enc,
        secret_value_iv,
        secret_value_tag,
        version,
        is_active,
        created_by,
        updated_by
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        1,
        true,
        $7,
        $7
      )
      on conflict (tenant_id, provider, secret_key) do update
      set
        secret_value_enc = excluded.secret_value_enc,
        secret_value_iv = excluded.secret_value_iv,
        secret_value_tag = excluded.secret_value_tag,
        version = tenant_secrets.version + 1,
        is_active = true,
        updated_by = excluded.updated_by
      returning
        id,
        tenant_id,
        provider,
        secret_key,
        version,
        is_active,
        created_by,
        updated_by,
        created_at,
        updated_at
    `,
    [
      tenantId,
      safeProvider,
      safeSecretKey,
      encrypted.secret_value_enc,
      encrypted.secret_value_iv,
      encrypted.secret_value_tag,
      safeActor,
    ]
  );

  return rowOrNull(q);
}

export async function dbDeleteTenantSecret(db, tenantId, provider, secretKey) {
  if (!db || !tenantId || !provider || !secretKey) return false;

  const q = await db.query(
    `
      delete from tenant_secrets
      where tenant_id = $1
        and provider = $2
        and secret_key = $3
    `,
    [tenantId, cleanLower(provider), cleanLower(secretKey)]
  );

  return (q?.rowCount || 0) > 0;
}

export async function dbListTenantSecretsMasked(db, tenantId, provider = "") {
  if (!db || !tenantId) return [];

  const safeProvider = cleanLower(provider);
  const params = [tenantId];
  let where = `where tenant_id = $1`;

  if (safeProvider) {
    params.push(safeProvider);
    where += ` and provider = $2`;
  }

  const q = await db.query(
    `
      select *
      from tenant_secrets
      ${where}
      order by provider asc, secret_key asc, updated_at desc
    `,
    params
  );

  return rows(q).map(toMaskedRow);
}

export async function dbGetTenantSecretsForProvider(db, tenantId, provider) {
  if (!db || !tenantId || !provider) return [];

  const q = await db.query(
    `
      select *
      from tenant_secrets
      where tenant_id = $1
        and provider = $2
        and is_active = true
      order by secret_key asc
    `,
    [tenantId, cleanLower(provider)]
  );

  return rows(q).map(toRawSecretRow);
}