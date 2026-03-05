// src/utils/url.js (FIXED)

import { cfg } from "../config.js";

export function baseUrl() {
  const b = String(
    cfg.PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");

  return b || "";
}

export function absoluteCallbackUrl(pathname) {
  const p = String(pathname || "").trim();
  if (!p) return p;

  // already absolute
  if (/^https?:\/\//i.test(p)) return p;

  const b = baseUrl();
  if (!b) return p;

  return `${b}${p.startsWith("/") ? "" : "/"}${p}`;
}