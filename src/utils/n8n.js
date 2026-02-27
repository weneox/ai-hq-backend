// src/utils/n8n.js
export async function postToN8n({ url, token = "", timeoutMs = 10000, payload }) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "missing url" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10000));

  try {
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (token) headers["x-webhook-token"] = token;

    const resp = await fetch(u, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const text = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}