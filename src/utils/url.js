import { cfg } from "../config.js";

export function baseUrl() {
  const b = String(cfg.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return b || "";
}

export function absoluteCallbackUrl(pathname) {
  const b = baseUrl();
  const p = String(pathname || "").trim();
  if (!p) return p;
  if (/^https?:\/\//i.test(p)) return p;
  if (!b) return p;
  return `${b}${p.startsWith("/") ? "" : "/"}${p}`;
}