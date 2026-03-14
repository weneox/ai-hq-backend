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
  LOG_LEVEL: s(process.env.LOG_LEVEL, "info"),

  CORS_ORIGIN: s(process.env.CORS_ORIGIN, "*"),
  PUBLIC_BASE_URL: s(process.env.PUBLIC_BASE_URL, ""),

  DATABASE_URL: s(process.env.DATABASE_URL, ""),
  DB_MIGRATE_TX: b(process.env.DB_MIGRATE_TX, true),
  WS_AUTH_TOKEN: s(process.env.WS_AUTH_TOKEN, ""),

  DEBUG_API_TOKEN: s(process.env.DEBUG_API_TOKEN, ""),
  AIHQ_INTERNAL_TOKEN: s(process.env.AIHQ_INTERNAL_TOKEN, ""),
  CRON_SECRET: s(process.env.CRON_SECRET, ""),

  ADMIN_PANEL_ENABLED: b(process.env.ADMIN_PANEL_ENABLED, true),
  ADMIN_PANEL_PASSCODE_HASH: s(process.env.ADMIN_PANEL_PASSCODE_HASH, ""),
  ADMIN_SESSION_SECRET: s(process.env.ADMIN_SESSION_SECRET, ""),
  ADMIN_SESSION_COOKIE_NAME: s(
    process.env.ADMIN_SESSION_COOKIE_NAME,
    "aihq_admin"
  ),
  ADMIN_SESSION_TTL_HOURS: n(process.env.ADMIN_SESSION_TTL_HOURS, 12),
  ADMIN_RATE_LIMIT_WINDOW_MS: n(
    process.env.ADMIN_RATE_LIMIT_WINDOW_MS,
    15 * 60 * 1000
  ),
  ADMIN_RATE_LIMIT_MAX_ATTEMPTS: n(
    process.env.ADMIN_RATE_LIMIT_MAX_ATTEMPTS,
    5
  ),

  USER_SESSION_SECRET: s(
    process.env.USER_SESSION_SECRET,
    process.env.ADMIN_SESSION_SECRET || ""
  ),
  USER_SESSION_COOKIE_NAME: s(
    process.env.USER_SESSION_COOKIE_NAME,
    "aihq_user"
  ),
  USER_SESSION_TTL_HOURS: n(process.env.USER_SESSION_TTL_HOURS, 24 * 7),

  SESSION_COOKIE_DOMAIN: s(process.env.SESSION_COOKIE_DOMAIN, ""),
  COOKIE_DOMAIN: s(process.env.COOKIE_DOMAIN, ""),
  USER_COOKIE_DOMAIN: s(process.env.USER_COOKIE_DOMAIN, ""),

  TENANT_SECRET_MASTER_KEY: s(process.env.TENANT_SECRET_MASTER_KEY, ""),
  AIHQ_SECRETS_PATH: s(process.env.AIHQ_SECRETS_PATH, "/api/settings/secrets"),

  DEFAULT_TENANT_KEY: s(process.env.DEFAULT_TENANT_KEY, "default"),
  DEFAULT_TIMEZONE: s(process.env.DEFAULT_TIMEZONE, "Asia/Baku"),
  DEFAULT_MODE: mode(process.env.DEFAULT_MODE, "manual"),
  DAILY_PUBLISH_HOUR_LOCAL: n(process.env.DAILY_PUBLISH_HOUR_LOCAL, 10),
  DAILY_PUBLISH_MINUTE_LOCAL: n(process.env.DAILY_PUBLISH_MINUTE_LOCAL, 0),

  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),
  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 800),
  OPENAI_TIMEOUT_MS: n(process.env.OPENAI_TIMEOUT_MS, 25_000),
  OPENAI_DEBATE_CONCURRENCY: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),
  OPENAI_DEBATE_AGENT_TOKENS: n(
    process.env.OPENAI_DEBATE_AGENT_TOKENS,
    900
  ),
  OPENAI_DEBATE_SYNTH_TOKENS: n(
    process.env.OPENAI_DEBATE_SYNTH_TOKENS,
    1400
  ),

  GEMINI_API_KEY: s(process.env.GEMINI_API_KEY, ""),
  ANTHROPIC_API_KEY: s(process.env.ANTHROPIC_API_KEY, ""),

  RUNWAY_API_KEY: s(process.env.RUNWAY_API_KEY, ""),
  RUNWAY_VIDEO_MODEL: s(process.env.RUNWAY_VIDEO_MODEL, "gen4.5"),

  PIKA_API_KEY: s(process.env.PIKA_API_KEY, ""),

  ELEVENLABS_API_KEY: s(process.env.ELEVENLABS_API_KEY, ""),
  ELEVENLABS_VOICE_ID: s(process.env.ELEVENLABS_VOICE_ID, ""),
  ELEVENLABS_MODEL_ID: s(
    process.env.ELEVENLABS_MODEL_ID,
    "eleven_multilingual_v2"
  ),

  CREATOMATE_API_KEY: s(process.env.CREATOMATE_API_KEY, ""),
  CREATOMATE_API_BASE: s(
    process.env.CREATOMATE_API_BASE,
    "https://api.creatomate.com/v1"
  ),
  CREATOMATE_TEMPLATE_ID_REEL: s(
    process.env.CREATOMATE_TEMPLATE_ID_REEL,
    ""
  ),
  CREATOMATE_TEMPLATE_ID_CAROUSEL_VIDEO: s(
    process.env.CREATOMATE_TEMPLATE_ID_CAROUSEL_VIDEO,
    ""
  ),

  META_PAGE_ACCESS_TOKEN: s(process.env.META_PAGE_ACCESS_TOKEN, ""),
  META_API_VERSION: s(process.env.META_API_VERSION, "v23.0"),

  META_APP_ID: s(process.env.META_APP_ID, ""),
  META_APP_SECRET: s(process.env.META_APP_SECRET, ""),
  META_REDIRECT_URI: s(process.env.META_REDIRECT_URI, ""),
  CHANNELS_RETURN_URL: s(process.env.CHANNELS_RETURN_URL, ""),

  N8N_WEBHOOK_BASE: s(process.env.N8N_WEBHOOK_BASE, ""),
  N8N_WEBHOOK_URL: s(process.env.N8N_WEBHOOK_URL, ""),
  N8N_WEBHOOK_PROPOSAL_APPROVED_URL: s(
    process.env.N8N_WEBHOOK_PROPOSAL_APPROVED_URL,
    ""
  ),
  N8N_WEBHOOK_PUBLISH_URL: s(process.env.N8N_WEBHOOK_PUBLISH_URL, ""),
  N8N_WEBHOOK_TOKEN: s(process.env.N8N_WEBHOOK_TOKEN, ""),
  N8N_CALLBACK_TOKEN: s(process.env.N8N_CALLBACK_TOKEN, ""),
  N8N_TIMEOUT_MS: n(process.env.N8N_TIMEOUT_MS, 10_000),
  N8N_RETRIES: n(process.env.N8N_RETRIES, 2),
  N8N_BACKOFF_MS: n(process.env.N8N_BACKOFF_MS, 500),

  TELEGRAM_ENABLED: b(process.env.TELEGRAM_ENABLED, false),
  TELEGRAM_BOT_TOKEN: s(process.env.TELEGRAM_BOT_TOKEN, ""),
  TELEGRAM_CHAT_ID: s(process.env.TELEGRAM_CHAT_ID, ""),

  PUSH_ENABLED: b(process.env.PUSH_ENABLED, true),
  VAPID_PUBLIC_KEY: s(process.env.VAPID_PUBLIC_KEY, ""),
  VAPID_PRIVATE_KEY: s(process.env.VAPID_PRIVATE_KEY, ""),
  VAPID_SUBJECT: s(process.env.VAPID_SUBJECT, "mailto:info@example.com"),

  META_GATEWAY_BASE_URL: s(process.env.META_GATEWAY_BASE_URL, ""),
  META_GATEWAY_INTERNAL_TOKEN: s(process.env.META_GATEWAY_INTERNAL_TOKEN, ""),
  META_GATEWAY_TIMEOUT_MS: n(process.env.META_GATEWAY_TIMEOUT_MS, 20_000),

  OUTBOUND_RETRY_ENABLED: b(process.env.OUTBOUND_RETRY_ENABLED, true),
  OUTBOUND_RETRY_INTERVAL_MS: n(
    process.env.OUTBOUND_RETRY_INTERVAL_MS,
    15_000
  ),
  OUTBOUND_RETRY_BATCH_SIZE: n(process.env.OUTBOUND_RETRY_BATCH_SIZE, 10),

  DEBUG_DEBATE_RAW: b(process.env.DEBUG_DEBATE_RAW, false),
};