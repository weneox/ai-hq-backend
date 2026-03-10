import { cfg } from "../config.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

export function getDefaultTenantKey() {
  return s(cfg.DEFAULT_TENANT_KEY, "default");
}

export function resolveTenantKey(input, fallback = "") {
  const x = s(input);
  if (x) return x;

  const f = s(fallback);
  if (f) return f;

  return getDefaultTenantKey();
}

export function resolveTenantKeyFromReq(req, fallback = "") {
  return resolveTenantKey(
    req?.headers?.["x-tenant-key"] ||
      req?.body?.tenantKey ||
      req?.body?.tenant_id ||
      req?.query?.tenantKey ||
      req?.query?.tenant_id,
    fallback
  );
}