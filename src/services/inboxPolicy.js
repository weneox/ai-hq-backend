// src/services/inboxPolicy.js
// FINAL v2.0 — tenant timezone aware + channel aliases + stricter normalization

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

export function normalizePolicy(raw = {}) {
  const allowedChannels = uniqueLowerList(
    Array.isArray(raw.allowedChannels)
      ? raw.allowedChannels
      : DEFAULT_POLICY.allowedChannels
  );

  const humanKeywords = Array.isArray(raw.humanKeywords)
    ? raw.humanKeywords.map((x) => lower(x)).filter(Boolean)
    : DEFAULT_POLICY.humanKeywords.map((x) => lower(x));

  return {
    autoReplyEnabled: b(raw.autoReplyEnabled, DEFAULT_POLICY.autoReplyEnabled),
    createLeadEnabled: b(raw.createLeadEnabled, DEFAULT_POLICY.createLeadEnabled),
    handoffEnabled: b(raw.handoffEnabled, DEFAULT_POLICY.handoffEnabled),
    markSeenEnabled: b(raw.markSeenEnabled, DEFAULT_POLICY.markSeenEnabled),
    typingIndicatorEnabled: b(
      raw.typingIndicatorEnabled,
      DEFAULT_POLICY.typingIndicatorEnabled
    ),
    suppressAiDuringHandoff: b(
      raw.suppressAiDuringHandoff,
      DEFAULT_POLICY.suppressAiDuringHandoff
    ),
    autoReleaseOnOperatorReply: b(
      raw.autoReleaseOnOperatorReply,
      DEFAULT_POLICY.autoReleaseOnOperatorReply
    ),
    allowedChannels: allowedChannels.length
      ? allowedChannels
      : DEFAULT_POLICY.allowedChannels.slice(),
    quietHoursEnabled: b(raw.quietHoursEnabled, DEFAULT_POLICY.quietHoursEnabled),
    quietHoursStart: toHour(raw.quietHoursStart, DEFAULT_POLICY.quietHoursStart),
    quietHoursEnd: toHour(raw.quietHoursEnd, DEFAULT_POLICY.quietHoursEnd),
    humanKeywords,
  };
}

export function getLocalHourForTimezone(timezone = "Asia/Baku") {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "Asia/Baku",
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
  const nowHour = getLocalHourForTimezone(policy?.timezone || "Asia/Baku");

  if (start === end) return false;

  if (start < end) {
    return nowHour >= start && nowHour < end;
  }

  return nowHour >= start || nowHour < end;
}

export function getInboxPolicy({ tenantKey, channel, tenant = null } = {}) {
  const policyFromTenant =
    tenant?.inbox_policy && typeof tenant.inbox_policy === "object"
      ? tenant.inbox_policy
      : {};

  const policy = normalizePolicy(policyFromTenant);
  const ch = normalizeInboxChannel(channel);
  const timezone = s(tenant?.timezone || "Asia/Baku") || "Asia/Baku";

  return {
    ...policy,
    tenantKey: s(tenantKey || tenant?.tenant_key || "neox"),
    channel: ch,
    timezone,
    channelAllowed: !ch || policy.allowedChannels.includes(ch),
  };
}