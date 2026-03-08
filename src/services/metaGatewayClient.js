function s(v) {
  return String(v ?? "").trim();
}

function trimSlash(v) {
  return s(v).replace(/\/+$/, "");
}

async function safeReadJson(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function sendOutboundViaMetaGateway(payload) {
  const base = trimSlash(process.env.META_GATEWAY_BASE_URL || "");
  const token = s(process.env.META_GATEWAY_INTERNAL_TOKEN || "");
  const timeoutMs = Number(process.env.META_GATEWAY_TIMEOUT_MS || 20000);

  if (!base) {
    return {
      ok: false,
      status: 0,
      error: "META_GATEWAY_BASE_URL missing",
      json: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${base}/internal/outbound/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        ...(token ? { "x-internal-token": token } : {}),
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const json = await safeReadJson(res);

    return {
      ok: res.ok && json?.ok !== false,
      status: res.status,
      error: res.ok ? null : json?.error || json?.message || "meta gateway send failed",
      json,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error:
        err?.name === "AbortError"
          ? "meta gateway timeout"
          : String(err?.message || err),
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}