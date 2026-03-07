// src/config.js

function s(v, d = "") {
  return String(v ?? d).trim();
}
function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function b(v, d = false) {
  const x = String(v ?? "").trim().toLowerCase();
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function mode(v, d = "manual") {
  const x = String(v ?? "").trim().toLowerCase();
  if (x === "auto" || x === "manual") return x;
  return d;
}

export const cfg = {
  PORT: n(process.env.PORT, 8080),
  APP_ENV: s(process.env.APP_ENV, process.env.NODE_ENV || "production"),
  TRUST_PROXY: b(process.env.TRUST_PROXY, false),

  CORS_ORIGIN: s(process.env.CORS_ORIGIN, "*"),

  DATABASE_URL: s(process.env.DATABASE_URL, ""),
  WS_AUTH_TOKEN: s(process.env.WS_AUTH_TOKEN, ""),

  PUBLIC_BASE_URL: s(process.env.PUBLIC_BASE_URL, ""),

  DEBUG_API_TOKEN: s(process.env.DEBUG_API_TOKEN, ""),

  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),

  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 800),
  OPENAI_TIMEOUT_MS: n(process.env.OPENAI_TIMEOUT_MS, 25_000),
  OPENAI_DEBATE_CONCURRENCY: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),
  OPENAI_DEBATE_AGENT_TOKENS: n(process.env.OPENAI_DEBATE_AGENT_TOKENS, 900),
  OPENAI_DEBATE_SYNTH_TOKENS: n(process.env.OPENAI_DEBATE_SYNTH_TOKENS, 1400),

  RUNWAY_API_KEY: s(process.env.RUNWAY_API_KEY, ""),
  RUNWAY_VIDEO_MODEL: s(process.env.RUNWAY_VIDEO_MODEL, "gen4.5"),

  N8N_WEBHOOK_BASE: s(process.env.N8N_WEBHOOK_BASE, ""),
  N8N_WEBHOOK_URL: s(process.env.N8N_WEBHOOK_URL, ""),
  N8N_WEBHOOK_PROPOSAL_APPROVED_URL: s(process.env.N8N_WEBHOOK_PROPOSAL_APPROVED_URL, ""),
  N8N_WEBHOOK_PUBLISH_URL: s(process.env.N8N_WEBHOOK_PUBLISH_URL, ""),
  N8N_WEBHOOK_TOKEN: s(process.env.N8N_WEBHOOK_TOKEN, ""),
  N8N_TIMEOUT_MS: n(process.env.N8N_TIMEOUT_MS, 10_000),
  N8N_RETRIES: n(process.env.N8N_RETRIES, 2),
  N8N_BACKOFF_MS: n(process.env.N8N_BACKOFF_MS, 500),

  N8N_CALLBACK_TOKEN: s(process.env.N8N_CALLBACK_TOKEN, ""),

  TELEGRAM_ENABLED: b(process.env.TELEGRAM_ENABLED, false),
  TELEGRAM_BOT_TOKEN: s(process.env.TELEGRAM_BOT_TOKEN, ""),
  TELEGRAM_CHAT_ID: s(process.env.TELEGRAM_CHAT_ID, ""),

  PUSH_ENABLED: b(process.env.PUSH_ENABLED, true),
  VAPID_PUBLIC_KEY: s(process.env.VAPID_PUBLIC_KEY, ""),
  VAPID_PRIVATE_KEY: s(process.env.VAPID_PRIVATE_KEY, ""),
  VAPID_SUBJECT: s(process.env.VAPID_SUBJECT, "mailto:info@weneox.com"),

  DEFAULT_TENANT_KEY: s(process.env.DEFAULT_TENANT_KEY, "neox"),
  DEFAULT_TIMEZONE: s(process.env.DEFAULT_TIMEZONE, "Asia/Baku"),
  DAILY_PUBLISH_HOUR_LOCAL: n(process.env.DAILY_PUBLISH_HOUR_LOCAL, 10),
  DAILY_PUBLISH_MINUTE_LOCAL: n(process.env.DAILY_PUBLISH_MINUTE_LOCAL, 0),

  DEFAULT_MODE: mode(process.env.DEFAULT_MODE, "manual"),

  CRON_SECRET: s(process.env.CRON_SECRET, ""),

  META_PAGE_ACCESS_TOKEN: s(process.env.META_PAGE_ACCESS_TOKEN, ""),
  META_PAGE_ID: s(process.env.META_PAGE_ID, "1034647199727587"),
  META_IG_USER_ID: s(process.env.META_IG_USER_ID, "17841473956986087"),
  META_API_VERSION: s(process.env.META_API_VERSION, "v23.0"),

  LOG_LEVEL: s(process.env.LOG_LEVEL, "info"),
  DEBUG_DEBATE_RAW: b(process.env.DEBUG_DEBATE_RAW, false),
};