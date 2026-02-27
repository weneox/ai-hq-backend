// src/utils/n8n.js
// n8n webhook client (Node 18+ fetch)

export async function postToN8n({ url, token = "", timeoutMs = 10_000, payload }) {
  if (!url) return { ok: false, skipped: true, reason: "N8N_WEBHOOK_URL missing" };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 10_000));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(token ? { "x-webhook-token": token } : {}),
      },
      body: JSON.stringify(payload ?? {}),
      signal: ctrl.signal,
    });

    // n8n bəzən plain text qaytarır ("Workflow was started")
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}