import { cfg } from "../config.js";
import { getAuthTenantKey, getAuthTenantId } from "../utils/auth.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function lower(v, d = "") {
  return s(v, d).toLowerCase();
}

export function getDefaultTenantKey() {
  return lower(cfg.DEFAULT_TENANT_KEY, "default");
}

export function resolveTenantKey(input, fallback = "") {
  const x = lower(input);
  if (x) return x;

  const f = lower(fallback);
  if (f) return f;

  return getDefaultTenantKey();
}

export function resolveTenantId(input, fallback = "") {
  const x = s(input);
  if (x) return x;

  const f = s(fallback);
  if (f) return f;

  return "";
}

export function resolveTenantKeyFromReq(req, fallback = "") {
  return resolveTenantKey(
    getAuthTenantKey(req) ||
      req?.headers?.["x-tenant-key"] ||
      req?.body?.tenantKey ||
      req?.body?.tenant_key ||
      req?.query?.tenantKey ||
      req?.query?.tenant_key ||
      "",
    fallback
  );
}

export function resolveTenantIdFromReq(req, fallback = "") {
  return resolveTenantId(
    getAuthTenantId(req) ||
      req?.headers?.["x-tenant-id"] ||
      req?.body?.tenantId ||
      req?.body?.tenant_id ||
      req?.query?.tenantId ||
      req?.query?.tenant_id ||
      "",
    fallback
  );
}