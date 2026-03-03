// src/utils/n8n.js
// FINAL v2.0 — Enterprise grade (UTF-8 safe + structured JSON + exponential retry + idempotent + execution aware)

import crypto from "crypto";

function fixMojibake(input) {
  const t = String(input || "");
  if (!t) return t;
  if (!/[ÃÂ]|â€™|â€œ|â€�|â€“|â€”|â€¦/.test(t)) return t;

  try {
    const fixed = Buffer.from(t, "latin1").toString("utf8");
    if (/[�]/.test(fixed) && !/[�]/.test(t)) return t;
    return fixed;
  } catch {
    return t;
  }
}

function normalizeForJson(x) {
  if (x == null) return x;
  if (typeof x === "string") return fixMojibake(x);
  if (Array.isArray(x)) return x.map(normalizeForJson);

  if (typeof x === "object") {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      out[k] = normalizeForJson(v);
    }
    return out;
  }

  return x;
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(normalizeForJson(obj ?? {}));
  } catch {
    return JSON.stringify({});
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateIdempotencyKey() {
  return crypto.randomBytes(16).toString("hex");
}

export async function postToN8n({
  url,
  token = "",
  timeoutMs = 10_000,
  payload,
  retries = 2,
  baseBackoffMs = 500,
  requestId,
  executionId,
}) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "missing url" };

  const maxAttempts = Math.max(1, Number(retries) + 1);
  const timeout = Math.max(1500, Number(timeoutMs) || 10_000);

  const idempotencyKey = generateIdempotencyKey();
  const correlationId = requestId || crypto.randomUUID?.() || generateIdempotencyKey();

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "x-idempotency-key": idempotencyKey,
        "x-correlation-id": correlationId,
      };

      if (token) headers["x-webhook-token"] = String(token).trim();
      if (executionId) headers["x-execution-id"] = String(executionId);

      const body = safeJsonStringify(payload);

      const resp = await fetch(u, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      const rawText = await resp.text().catch(() => "");
      const text = fixMojibake(rawText);
      const json = safeJsonParse(text);

      if (resp.ok) {
        return {
          ok: true,
          status: resp.status,
          data: json ?? text,
          correlationId,
          idempotencyKey,
        };
      }

      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(resp.status);

      lastErr = {
        ok: false,
        status: resp.status,
        error: json?.error || text || "HTTP error",
        correlationId,
      };

      if (!retryable || attempt === maxAttempts) return lastErr;

      const wait = baseBackoffMs * Math.pow(2, attempt - 1); // exponential
      await sleep(wait);
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "timeout"
          : fixMojibake(String(e?.message || e));

      lastErr = {
        ok: false,
        error: msg,
        correlationId,
      };

      if (attempt === maxAttempts) return lastErr;

      const wait = baseBackoffMs * Math.pow(2, attempt - 1);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  return lastErr || { ok: false, error: "unknown error" };
}