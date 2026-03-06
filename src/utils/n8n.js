// src/utils/n8n.js
// FINAL v3.0 — Enterprise grade
// ✅ UTF-8 safe
// ✅ structured JSON normalize
// ✅ circular-safe stringify
// ✅ exponential retry
// ✅ Retry-After support
// ✅ idempotency + correlation id
// ✅ text/json response tolerant
// ✅ n8n / Runway friendly diagnostics

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
    const seen = new WeakSet();

    return JSON.stringify(normalizeForJson(obj ?? {}), (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
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

function parseRetryAfterMs(resp) {
  try {
    const raw = resp?.headers?.get?.("retry-after");
    if (!raw) return 0;

    const sec = Number(raw);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;

    const dt = new Date(raw).getTime();
    if (Number.isFinite(dt)) {
      const diff = dt - Date.now();
      return diff > 0 ? diff : 0;
    }

    return 0;
  } catch {
    return 0;
  }
}

function buildErrorMessage(json, text, fallback = "HTTP error") {
  if (json && typeof json === "object") {
    return (
      json.error ||
      json.message ||
      json.details?.message ||
      text ||
      fallback
    );
  }
  return text || fallback;
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
  const correlationId =
    requestId ||
    (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : generateIdempotencyKey());

  const body = safeJsonStringify(payload);

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json, text/plain;q=0.9, */*;q=0.8",
        "x-idempotency-key": idempotencyKey,
        "x-correlation-id": correlationId,
      };

      if (token) headers["x-webhook-token"] = String(token).trim();
      if (executionId) headers["x-execution-id"] = String(executionId);

      const resp = await fetch(u, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      const rawText = await resp.text().catch(() => "");
      const text = fixMojibake(rawText);
      const json = safeJsonParse(text);
      const data = json ?? text;

      if (resp.ok) {
        return {
          ok: true,
          status: resp.status,
          data,
          textPreview: typeof text === "string" ? text.slice(0, 300) : "",
          correlationId,
          idempotencyKey,
          attempt,
        };
      }

      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(resp.status);

      lastErr = {
        ok: false,
        status: resp.status,
        error: fixMojibake(buildErrorMessage(json, text, "HTTP error")),
        data,
        textPreview: typeof text === "string" ? text.slice(0, 300) : "",
        correlationId,
        idempotencyKey,
        attempt,
      };

      if (!retryable || attempt === maxAttempts) return lastErr;

      const retryAfterMs = parseRetryAfterMs(resp);
      const expBackoff = Math.max(0, Number(baseBackoffMs) || 500) * Math.pow(2, attempt - 1);
      const wait = Math.max(retryAfterMs, expBackoff);

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
        idempotencyKey,
        attempt,
      };

      if (attempt === maxAttempts) return lastErr;

      const wait = Math.max(0, Number(baseBackoffMs) || 500) * Math.pow(2, attempt - 1);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  return lastErr || { ok: false, error: "unknown error" };
}