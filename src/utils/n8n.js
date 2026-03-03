// src/utils/n8n.js (FINAL v1.4 — UTF-8 safe + no double-encode + retry/backoff + mojibake-fix)
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
    for (const [k, v] of Object.entries(x)) out[k] = normalizeForJson(v);
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function postToN8n({
  url,
  token = "",
  timeoutMs = 10_000,
  payload,
  retries = 2, // total attempts = 1 + retries
  backoffMs = 600,
}) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "missing url" };

  const maxAttempts = Math.max(1, Number(retries) + 1);
  const baseTimeout = Math.max(1200, Number(timeoutMs) || 10_000);

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), baseTimeout);

    try {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      };
      if (token) headers["x-webhook-token"] = String(token).trim();

      const body = safeJsonStringify(payload);

      const resp = await fetch(u, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      const text = fixMojibake(await resp.text().catch(() => ""));

      // success
      if (resp.ok) return { ok: true, status: resp.status, text };

      // retry only on transient-ish statuses
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(resp.status);
      lastErr = { ok: false, status: resp.status, text: text || "HTTP error" };

      if (!retryable || attempt === maxAttempts) return lastErr;

      const wait = backoffMs * attempt;
      await sleep(wait);
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "timeout"
          : fixMojibake(String(e?.message || e));

      // retry on network/timeout only
      lastErr = { ok: false, error: msg };

      if (attempt === maxAttempts) return lastErr;

      const wait = backoffMs * attempt;
      await sleep(wait);
    } finally {
      clearTimeout(t);
    }
  }

  return lastErr || { ok: false, error: "unknown" };
}