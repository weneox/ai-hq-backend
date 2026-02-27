// src/utils/n8n.js (FINAL v1.2)
// - UTF-8 JSON
// - timeout -> AbortController
// - consistent return shape
// - safe token header
export async function postToN8n({ url, token = "", timeoutMs = 10000, payload }) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "missing url" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10_000));

  try {
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (token) headers["x-webhook-token"] = String(token).trim();

    const resp = await fetch(u, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const text = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : String(e?.message || e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}