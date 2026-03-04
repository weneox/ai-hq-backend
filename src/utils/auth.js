import { cfg } from "../config.js";

export function requireDebugToken(req) {
  const expected = String(cfg.DEBUG_API_TOKEN || "").trim();
  if (!expected) return true;
  const token = String(
    req.headers["x-debug-token"] || req.query.token || req.body?.token || ""
  ).trim();
  return Boolean(token) && token === expected;
}

export function callbackTokenExpected() {
  return String(cfg.N8N_CALLBACK_TOKEN || cfg.N8N_WEBHOOK_TOKEN || "").trim();
}

export function requireCallbackToken(req) {
  const expected = callbackTokenExpected();
  if (!expected) return true;
  const got = String(
    req.headers["x-webhook-token"] ||
      req.headers["x-callback-token"] ||
      req.body?.token ||
      ""
  ).trim();
  return Boolean(got) && got === expected;
}