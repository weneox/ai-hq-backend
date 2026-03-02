// src/utils/metaIg.js
import { cfg } from "../config.js";

function q(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    p.set(k, String(v));
  }
  return p;
}

async function graph(path, { method = "GET", params, body } = {}) {
  const ver = String(cfg.META_API_VERSION || "v23.0").trim();
  const token = String(cfg.META_PAGE_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN missing");

  const url = new URL(`https://graph.facebook.com/${ver}/${path.replace(/^\//, "")}`);
  if (params) url.search = q({ ...params, access_token: token }).toString();
  else url.search = q({ access_token: token }).toString();

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json || {};
}

// 1) create media container (image)
export async function igCreateImageContainer({ igUserId, imageUrl, caption }) {
  return graph(`/${igUserId}/media`, {
    method: "POST",
    params: {
      image_url: imageUrl,
      caption: caption || "",
    },
  });
}

// 2) publish container
export async function igPublishContainer({ igUserId, creationId }) {
  return graph(`/${igUserId}/media_publish`, {
    method: "POST",
    params: { creation_id: creationId },
  });
}