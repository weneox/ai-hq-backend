import { cfg } from "../../config.js";

function clean(x) {
  return String(x || "").trim();
}

function getApiKey() {
  return clean(cfg.CREATOMATE_API_KEY);
}

function getApiBase() {
  return clean(cfg.CREATOMATE_API_BASE || "https://api.creatomate.com/v1");
}

async function creatomateFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("CREATOMATE_API_KEY is missing");

  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text().catch(() => "");
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(json?.message || json?.error || json?.raw || `Creatomate API error (${res.status})`);
  }

  return json;
}

export async function creatomateCreateRender({
  templateId,
  modifications = {},
} = {}) {
  const finalTemplateId = clean(templateId || cfg.CREATOMATE_TEMPLATE_ID_REEL);
  if (!finalTemplateId) throw new Error("Creatomate templateId missing");

  return creatomateFetch("/renders", {
    method: "POST",
    body: JSON.stringify({
      template_id: finalTemplateId,
      modifications,
    }),
  });
}

export async function creatomateGetRender(renderId) {
  const id = clean(renderId);
  if (!id) throw new Error("renderId is required");

  return creatomateFetch(`/renders/${id}`, {
    method: "GET",
  });
}

export function pickCreatomateRenderUrl(render) {
  return (
    render?.url ||
    render?.result_url ||
    render?.video_url ||
    render?.download_url ||
    ""
  );
}