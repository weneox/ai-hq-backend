import { deepFix, fixText } from "../../utils/textFix.js";

export function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function s(v) {
  return String(v ?? "").trim();
}

export function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

function toMs(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

export function sortMessagesChronologically(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort(
    (a, b) => toMs(a?.sent_at || a?.created_at) - toMs(b?.sent_at || b?.created_at)
  );
}

export function normalizeThread(row) {
  if (!row) return row;

  const meta = row.meta && typeof row.meta === "object" ? deepFix(row.meta) : {};
  const handoff = meta?.handoff && typeof meta.handoff === "object" ? meta.handoff : {};

  return {
    ...row,
    customer_name: fixText(row.customer_name || ""),
    external_username: fixText(row.external_username || ""),
    assigned_to: fixText(row.assigned_to || ""),
    labels: Array.isArray(row.labels) ? row.labels.map((x) => fixText(String(x))) : [],
    meta,
    handoff_active: Boolean(handoff?.active),
    handoff_reason: fixText(s(handoff?.reason || "")),
    handoff_priority: fixText(s(handoff?.priority || "")),
    handoff_at: handoff?.at || null,
  };
}

export function normalizeMessage(row) {
  if (!row) return row;
  return {
    ...row,
    text: fixText(row.text || ""),
    attachments: Array.isArray(row.attachments) ? deepFix(row.attachments) : [],
    meta: deepFix(row.meta || {}),
  };
}

export function normalizeLead(row) {
  if (!row) return row;
  return {
    ...row,
    full_name: fixText(row.full_name || ""),
    username: fixText(row.username || ""),
    company: fixText(row.company || ""),
    phone: fixText(row.phone || ""),
    email: fixText(row.email || ""),
    interest: fixText(row.interest || ""),
    notes: fixText(row.notes || ""),
    extra: deepFix(row.extra || {}),
  };
}

export function normalizeTenant(row) {
  if (!row) return null;
  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    name: fixText(row.name || ""),
    timezone: fixText(row.timezone || ""),
    inbox_policy:
      row.inbox_policy && typeof row.inbox_policy === "object" ? deepFix(row.inbox_policy) : {},
    meta: row.meta && typeof row.meta === "object" ? deepFix(row.meta) : {},
  };
}