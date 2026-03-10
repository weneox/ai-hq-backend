// src/services/tenantProviderSecrets.js

import { dbGetTenantByKey } from "../db/helpers/settings.js";
import { dbGetTenantProviderSecrets } from "../db/helpers/tenantSecrets.js";

function s(v, d = "") {
  const x = String(v ?? "").trim();
  return x || d;
}

function lower(v, d = "") {
  return s(v, d).toLowerCase();
}

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

export async function getTenantByKeyOrThrow(db, tenantKey) {
  const key = lower(tenantKey);
  if (!db) throw new Error("Database not available");
  if (!key) throw new Error("tenantKey is required");

  const tenant = await dbGetTenantByKey(db, key);
  if (!tenant?.id) {
    throw new Error(`Tenant not found: ${key}`);
  }

  return tenant;
}

export async function getTenantSecretsByProvider(db, tenantKey, provider) {
  const tenant = await getTenantByKeyOrThrow(db, tenantKey);
  const secrets = await dbGetTenantProviderSecrets(db, tenant.id, provider);

  return {
    tenant,
    provider: lower(provider),
    secrets: asObj(secrets),
  };
}

export async function getTenantTogetherConfig(db, tenantKey) {
  const { tenant, secrets } = await getTenantSecretsByProvider(
    db,
    tenantKey,
    "together"
  );

  return {
    tenant,
    apiKey: s(secrets.api_key),
    model: s(secrets.image_model || secrets.model),
  };
}

export async function getTenantMetaConfig(db, tenantKey) {
  const { tenant, secrets } = await getTenantSecretsByProvider(
    db,
    tenantKey,
    "meta"
  );

  return {
    tenant,
    pageAccessToken: s(secrets.page_access_token),
    pageId: s(secrets.page_id),
    igUserId: s(secrets.ig_user_id),
    appSecret: s(secrets.app_secret),
  };
}

export async function getTenantCloudinaryConfig(db, tenantKey) {
  const { tenant, secrets } = await getTenantSecretsByProvider(
    db,
    tenantKey,
    "cloudinary"
  );

  return {
    tenant,
    cloudName: s(secrets.cloud_name),
    apiKey: s(secrets.api_key),
    apiSecret: s(secrets.api_secret),
    folder: s(secrets.folder),
  };
}

export async function getTenantTwilioConfig(db, tenantKey) {
  const { tenant, secrets } = await getTenantSecretsByProvider(
    db,
    tenantKey,
    "twilio"
  );

  return {
    tenant,
    accountSid: s(secrets.account_sid),
    authToken: s(secrets.auth_token),
    apiKey: s(secrets.api_key),
    apiSecret: s(secrets.api_secret),
    phoneNumber: s(secrets.phone_number),
  };
}

export async function getTenantOpenAIConfig(db, tenantKey) {
  const { tenant, secrets } = await getTenantSecretsByProvider(
    db,
    tenantKey,
    "openai"
  );

  return {
    tenant,
    apiKey: s(secrets.api_key),
    model: s(secrets.model),
  };
}