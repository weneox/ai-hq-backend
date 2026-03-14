import crypto from "crypto";
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

function stripBearer(v) {
  return cleanString(v).replace(/^Bearer\s+/i, "").trim();
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;

  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function readHeader(req, name) {
  return cleanString(req?.headers?.[name]);
}

export function requireDebugToken(req) {
  const expected = cleanString(cfg?.security?.debugApiToken);
  if (!expected) return true;

  const got = cleanString(
    readHeader(req, "x-debug-token") ||
      req?.query?.token ||
      req?.body?.token ||
      ""
  );

  return Boolean(got) && safeEq(got, expected);
}

export function callbackTokenExpected() {
  return cleanString(
    cfg?.n8n?.callbackToken || cfg?.n8n?.webhookToken || ""
  );
}

export function requireCallbackToken(req) {
  const expected = callbackTokenExpected();
  if (!expected) return true;

  const got = cleanString(
    readHeader(req, "x-webhook-token") ||
      readHeader(req, "x-callback-token") ||
      req?.body?.token ||
      ""
  );

  return Boolean(got) && safeEq(got, expected);
}

export function internalTokenExpected() {
  return cleanString(cfg?.security?.aihqInternalToken || "");
}

export function requireInternalToken(req) {
  const expected = internalTokenExpected();
  if (!expected) return true;

  const got = stripBearer(
    readHeader(req, "x-internal-token") ||
      readHeader(req, "authorization") ||
      req?.body?.internalToken ||
      ""
  );

  return Boolean(got) && safeEq(got, expected);
}

export function getAuthTenantKey(req) {
  return cleanLower(
    req?.auth?.tenantKey ||
      req?.auth?.tenant_key ||
      req?.user?.tenantKey ||
      req?.user?.tenant_key ||
      req?.tenant?.tenant_key ||
      req?.tenant?.key ||
      req?.tenantKey ||
      readHeader(req, "x-tenant-key") ||
      req?.body?.tenantKey ||
      req?.body?.tenant_key ||
      req?.query?.tenantKey ||
      req?.query?.tenant_key ||
      ""
  );
}

export function getAuthTenantId(req) {
  return cleanString(
    req?.auth?.tenantId ||
      req?.auth?.tenant_id ||
      req?.user?.tenantId ||
      req?.user?.tenant_id ||
      req?.tenant?.id ||
      req?.tenantId ||
      readHeader(req, "x-tenant-id") ||
      req?.body?.tenantId ||
      req?.body?.tenant_id ||
      req?.query?.tenantId ||
      req?.query?.tenant_id ||
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
    tenantId: getAuthTenantId(req),
    role: getAuthRole(req),
    actor: getAuthActor(req),
  };
}