import { cfg } from "../config.js";

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

export function requireDebugToken(req) {
  const expected = cleanString(cfg.DEBUG_API_TOKEN);
  if (!expected) return true;

  const token = cleanString(
    req.headers["x-debug-token"] || req.query.token || req.body?.token || ""
  );

  return Boolean(token) && token === expected;
}

export function callbackTokenExpected() {
  return cleanString(cfg.N8N_CALLBACK_TOKEN || cfg.N8N_WEBHOOK_TOKEN || "");
}

export function requireCallbackToken(req) {
  const expected = callbackTokenExpected();
  if (!expected) return true;

  const got = cleanString(
    req.headers["x-webhook-token"] ||
      req.headers["x-callback-token"] ||
      req.body?.token ||
      ""
  );

  return Boolean(got) && got === expected;
}

export function internalTokenExpected() {
  return cleanString(cfg.AIHQ_INTERNAL_TOKEN || "");
}

export function requireInternalToken(req) {
  const expected = internalTokenExpected();
  if (!expected) return true;

  const got = cleanString(
    req.headers["x-internal-token"] ||
      req.headers["authorization"] ||
      req.body?.internalToken ||
      ""
  ).replace(/^Bearer\s+/i, "").trim();

  return Boolean(got) && got === expected;
}

export function getAuthTenantKey(req) {
  return cleanLower(
    req?.auth?.tenantKey ||
      req?.auth?.tenant_key ||
      req?.user?.tenantKey ||
      req?.user?.tenant_key ||
      req?.tenant?.key ||
      req?.tenantKey ||
      ""
  );
}

export function getAuthRole(req) {
  return cleanLower(
    req?.auth?.role ||
      req?.user?.role ||
      req?.membership?.role ||
      req?.tenantRole ||
      "member"
  );
}

export function getAuthActor(req) {
  return (
    cleanString(req?.auth?.email) ||
    cleanString(req?.user?.email) ||
    cleanString(req?.auth?.userId) ||
    cleanString(req?.user?.id) ||
    "system"
  );
}

export function getAuthContext(req) {
  return {
    tenantKey: getAuthTenantKey(req),
    role: getAuthRole(req),
    actor: getAuthActor(req),
  };
}