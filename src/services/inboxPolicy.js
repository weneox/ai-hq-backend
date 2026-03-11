// src/services/inboxPolicy.js
// FINAL v4.1 — tenant-safe + new tenant schema aware + strict policy normalization

import { getDefaultTenantKey, resolveTenantKey } from "../tenancy/index.js";

function s(v) {
  return String(v ?? "").trim();
}

function lower(v) {
  return s(v).toLowerCase();
}

function b(v, d = true) {
  if (typeof v === "boolean") return v;
  const x = lower(v);
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function toHour(v, d = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  if (n < 0) return 0;
  if (n > 23) return 23;
  return Math.floor(n);
}

function getDefaultTimezone() {
  return "Asia/Baku";
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function normalizeInboxChannel(v) {
  const ch = lower(v);

  if (!ch) return "";
  if (ch === "ig") return "instagram";
  if (ch === "insta") return "instagram";
  if (ch === "fb") return "facebook";
  if (ch === "messenger") return "facebook";
  if (ch === "wa") return "whatsapp";

  return ch;
}

const DEFAULT_POLICY = {
  autoReplyEnabled: true,
  createLeadEnabled: true,
  handoffEnabled: true,
  markSeenEnabled: true,
  typingIndicatorEnabled: true,
  suppressAiDuringHandoff: true,
  autoReleaseOnOperatorReply: false,
  allowedChannels: ["instagram", "facebook", "whatsapp"],
  quietHoursEnabled: false,
  quietHoursStart: 0,
  quietHoursEnd: 0,
  humanKeywords: [
    "operator",
    "menecer",
    "manager",
    "human",
    "adamla danışım",
    "adamla danisim",
    "real adam",
    "zəng edin",
    "zeng edin",
    "call me",
    "əlaqə",
    "elaqe",
  ],
};

function uniqueLowerList(list) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(list) ? list : []) {
    const x = normalizeInboxChannel(item);
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }

  return out;
}

function normalizeKeywordList(list, fallback = []) {
  if (!Array.isArray(list)) {
    return fallback.map((x) => lower(x)).filter(Boolean);
  }

  return list.map((x) => lower(x)).filter(Boolean);
}

function pickPolicyRoot(tenant = null) {
  if (!isObj(tenant)) return {};
  if (isObj(tenant.ai_policy)) return tenant.ai_policy;
  return {};
}

function pickInboxPolicyBlock(tenant = null) {
  if (!isObj(tenant)) return {};

  if (isObj(tenant.inbox_policy)) {
    return tenant.inbox_policy;
  }

  if (isObj(tenant.ai_policy) && isObj(tenant.ai_policy.inbox_policy)) {
    return tenant.ai_policy.inbox_policy;
  }

  return {};
}

function pickQuietHoursBlock(tenant = null) {
  if (!isObj(tenant)) return {};

  if (isObj(tenant.quiet_hours)) {
    return tenant.quiet_hours;
  }

  if (isObj(tenant.ai_policy) && isObj(tenant.ai_policy.quiet_hours)) {
    return tenant.ai_policy.quiet_hours;
  }

  return {};
}

export function normalizePolicy(raw = {}, root = {}) {
  const safeRaw = isObj(raw) ? raw : {};
  const safeRoot = isObj(root) ? root : {};

  const allowedChannels = uniqueLowerList(
    Array.isArray(safeRaw.allowedChannels)
      ? safeRaw.allowedChannels
      : Array.isArray(safeRaw.allowed_channels)
        ? safeRaw.allowed_channels
        : DEFAULT_POLICY.allowedChannels
  );

  const humanKeywords = normalizeKeywordList(
    Array.isArray(safeRaw.humanKeywords)
      ? safeRaw.humanKeywords
      : Array.isArray(safeRaw.human_keywords)
        ? safeRaw.human_keywords
        : DEFAULT_POLICY.humanKeywords,
    DEFAULT_POLICY.humanKeywords
  );

  return {
    autoReplyEnabled: b(
      safeRaw.autoReplyEnabled ?? safeRaw.auto_reply_enabled ?? safeRoot.auto_reply_enabled,
      DEFAULT_POLICY.autoReplyEnabled
    ),

    createLeadEnabled: b(
      safeRaw.createLeadEnabled ?? safeRaw.create_lead_enabled ?? safeRoot.create_lead_enabled,
      DEFAULT_POLICY.createLeadEnabled
    ),

    handoffEnabled: b(
      safeRaw.handoffEnabled ??
        safeRaw.handoff_enabled ??
        safeRaw.escalationEnabled ??
        safeRaw.escalation_enabled,
      DEFAULT_POLICY.handoffEnabled
    ),

    markSeenEnabled: b(
      safeRaw.markSeenEnabled ?? safeRaw.mark_seen_enabled ?? safeRoot.mark_seen_enabled,
      DEFAULT_POLICY.markSeenEnabled
    ),

    typingIndicatorEnabled: b(
      safeRaw.typingIndicatorEnabled ??
        safeRaw.typing_indicator_enabled ??
        safeRoot.typing_indicator_enabled,
      DEFAULT_POLICY.typingIndicatorEnabled
    ),

    suppressAiDuringHandoff: b(
      safeRaw.suppressAiDuringHandoff ??
        safeRaw.suppress_ai_during_handoff ??
        safeRoot.suppress_ai_during_handoff,
      DEFAULT_POLICY.suppressAiDuringHandoff
    ),

    autoReleaseOnOperatorReply: b(
      safeRaw.autoReleaseOnOperatorReply ?? safeRaw.auto_release_on_operator_reply,
      DEFAULT_POLICY.autoReleaseOnOperatorReply
    ),

    allowedChannels: allowedChannels.length
      ? allowedChannels
      : DEFAULT_POLICY.allowedChannels.slice(),

    quietHoursEnabled: b(
      safeRaw.quietHoursEnabled ??
        safeRaw.quiet_hours_enabled ??
        safeRoot.quiet_hours_enabled,
      DEFAULT_POLICY.quietHoursEnabled
    ),

    quietHoursStart: toHour(
      safeRaw.quietHoursStart ??
        safeRaw.quiet_hours_start ??
        safeRaw.startHour ??
        safeRaw.start_hour,
      DEFAULT_POLICY.quietHoursStart
    ),

    quietHoursEnd: toHour(
      safeRaw.quietHoursEnd ??
        safeRaw.quiet_hours_end ??
        safeRaw.endHour ??
        safeRaw.end_hour,
      DEFAULT_POLICY.quietHoursEnd
    ),

    humanKeywords,
  };
}

export function getLocalHourForTimezone(timezone = getDefaultTimezone()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || getDefaultTimezone(),
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());

    const hourPart = parts.find((p) => p.type === "hour")?.value;
    const hour = Number(hourPart);

    if (Number.isFinite(hour)) return hour;
    return new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

export function isPolicyQuietHours(policy) {
  if (!policy?.quietHoursEnabled) return false;

  const start = toHour(policy?.quietHoursStart, 0);
  const end = toHour(policy?.quietHoursEnd, 0);
  const nowHour = getLocalHourForTimezone(policy?.timezone || getDefaultTimezone());

  if (start === end) return false;

  if (start < end) {
    return nowHour >= start && nowHour < end;
  }

  return nowHour >= start || nowHour < end;
}

export function getInboxPolicy({ tenantKey, channel, tenant = null } = {}) {
  const rootPolicy = pickPolicyRoot(tenant);
  const inboxPolicy = pickInboxPolicyBlock(tenant);
  const quietHours = pickQuietHoursBlock(tenant);

  const mergedRaw = {
    ...inboxPolicy,

    quietHoursEnabled:
      inboxPolicy.quietHoursEnabled ??
      inboxPolicy.quiet_hours_enabled ??
      rootPolicy.quiet_hours_enabled ??
      DEFAULT_POLICY.quietHoursEnabled,

    quietHoursStart:
      inboxPolicy.quietHoursStart ??
      inboxPolicy.quiet_hours_start ??
      inboxPolicy.startHour ??
      inboxPolicy.start_hour ??
      quietHours.startHour ??
      quietHours.start_hour ??
      quietHours.quietHoursStart ??
      quietHours.quiet_hours_start ??
      DEFAULT_POLICY.quietHoursStart,

    quietHoursEnd:
      inboxPolicy.quietHoursEnd ??
      inboxPolicy.quiet_hours_end ??
      inboxPolicy.endHour ??
      inboxPolicy.end_hour ??
      quietHours.endHour ??
      quietHours.end_hour ??
      quietHours.quietHoursEnd ??
      quietHours.quiet_hours_end ??
      DEFAULT_POLICY.quietHoursEnd,
  };

  const policy = normalizePolicy(mergedRaw, rootPolicy);
  const ch = normalizeInboxChannel(channel);
  const timezone = s(tenant?.timezone || getDefaultTimezone()) || getDefaultTimezone();
  const resolvedTenantKey = resolveTenantKey(
    tenantKey || tenant?.tenant_key,
    getDefaultTenantKey()
  );

  return {
    ...policy,
    tenantKey: resolvedTenantKey,
    channel: ch,
    timezone,
    channelAllowed: !ch || policy.allowedChannels.includes(ch),
  };
}