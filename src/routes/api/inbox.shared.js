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

function asObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? deepFix(x) : {};
}

export function sortMessagesChronologically(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort(
    (a, b) => toMs(a?.sent_at || a?.created_at) - toMs(b?.sent_at || b?.created_at)
  );
}

export function normalizeThread(row) {
  if (!row) return row;

  const meta = asObject(row.meta);
  const handoffMeta = asObject(meta.handoff);

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    channel: fixText(row.channel || ""),
    external_thread_id: fixText(row.external_thread_id || ""),
    external_user_id: fixText(row.external_user_id || ""),
    external_username: fixText(row.external_username || ""),
    customer_name: fixText(row.customer_name || ""),
    status: fixText(row.status || ""),
    assigned_to: fixText(row.assigned_to || ""),
    labels: Array.isArray(row.labels) ? row.labels.map((x) => fixText(String(x))).filter(Boolean) : [],
    meta,

    // prefer real DB columns, fallback to meta.handoff only if needed
    handoff_active:
      typeof row.handoff_active === "boolean"
        ? row.handoff_active
        : Boolean(handoffMeta.active),

    handoff_reason: fixText(
      row.handoff_reason || handoffMeta.reason || ""
    ),

    handoff_priority: fixText(
      row.handoff_priority || handoffMeta.priority || ""
    ),

    handoff_at: row.handoff_at || handoffMeta.at || null,
    handoff_by: fixText(row.handoff_by || handoffMeta.by || ""),
  };
}

export function normalizeMessage(row) {
  if (!row) return row;
  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    direction: fixText(row.direction || ""),
    sender_type: fixText(row.sender_type || ""),
    external_message_id: fixText(row.external_message_id || ""),
    message_type: fixText(row.message_type || ""),
    text: fixText(row.text || ""),
    attachments: Array.isArray(row.attachments) ? deepFix(row.attachments) : [],
    meta: asObject(row.meta),
  };
}

export function normalizeLead(row) {
  if (!row) return row;
  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    source: fixText(row.source || ""),
    source_ref: fixText(row.source_ref || ""),
    full_name: fixText(row.full_name || ""),
    username: fixText(row.username || ""),
    company: fixText(row.company || ""),
    phone: fixText(row.phone || ""),
    email: fixText(row.email || ""),
    interest: fixText(row.interest || ""),
    notes: fixText(row.notes || ""),
    stage: fixText(row.stage || ""),
    status: fixText(row.status || ""),
    owner: fixText(row.owner || ""),
    priority: fixText(row.priority || ""),
    next_action: fixText(row.next_action || ""),
    won_reason: fixText(row.won_reason || ""),
    lost_reason: fixText(row.lost_reason || ""),
    extra: asObject(row.extra),
  };
}

export function normalizeTenant(row) {
  if (!row) return null;

  const brand = asObject(row.brand);
  const meta = asObject(row.meta);
  const schedule = asObject(row.schedule);
  const inbox_policy = asObject(row.inbox_policy);
  const providers = asObject(row.providers);
  const features = asObject(row.features);

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    name: fixText(row.name || ""),
    active: row.active !== false,
    timezone: fixText(row.timezone || ""),

    brand: {
      ...brand,
      displayName: fixText(brand.displayName || brand.name || row.name || ""),
      email: fixText(brand.email || ""),
      phone: fixText(brand.phone || ""),
      website: fixText(brand.website || ""),
      logoUrl: fixText(brand.logoUrl || brand.logo_url || ""),
    },

    meta: {
      ...meta,
      pageId: fixText(meta.pageId || meta.page_id || ""),
      igUserId: fixText(meta.igUserId || meta.ig_user_id || ""),
    },

    schedule: {
      ...schedule,
      tz: fixText(schedule.tz || row.timezone || ""),
      publishHourLocal:
        Number.isFinite(Number(schedule.publishHourLocal))
          ? Number(schedule.publishHourLocal)
          : null,
      publishMinuteLocal:
        Number.isFinite(Number(schedule.publishMinuteLocal))
          ? Number(schedule.publishMinuteLocal)
          : null,
    },

    inbox_policy,

    providers: {
      llm: fixText(providers.llm || ""),
      image: fixText(providers.image || ""),
      video: fixText(providers.video || ""),
      storage: fixText(providers.storage || ""),
      publish: fixText(providers.publish || ""),
      tts: fixText(providers.tts || ""),
      ...providers,
    },

    features: {
      comments: Boolean(features.comments),
      inbox: Boolean(features.inbox),
      leads: Boolean(features.leads),
      content: Boolean(features.content),
      publishing: Boolean(features.publishing),
      ...features,
    },
  };
}