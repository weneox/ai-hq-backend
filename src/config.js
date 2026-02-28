// src/config.js (FINAL v2.3)
// - Telegram toggle (default OFF)
// - Web Push (VAPID) config
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

export const cfg = {
  PORT: n(process.env.PORT, 8080),
  APP_ENV: s(process.env.APP_ENV, process.env.NODE_ENV || "production"),
  TRUST_PROXY: b(process.env.TRUST_PROXY, false),

  CORS_ORIGIN: s(process.env.CORS_ORIGIN, "*"),

  DATABASE_URL: s(process.env.DATABASE_URL, ""),
  WS_AUTH_TOKEN: s(process.env.WS_AUTH_TOKEN, ""),

  DEBUG_API_TOKEN: s(process.env.DEBUG_API_TOKEN, ""),

  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),

  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 800),
  OPENAI_TIMEOUT_MS: n(process.env.OPENAI_TIMEOUT_MS, 25_000),
  OPENAI_DEBATE_CONCURRENCY: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),
  OPENAI_DEBATE_AGENT_TOKENS: n(process.env.OPENAI_DEBATE_AGENT_TOKENS, 900),
  OPENAI_DEBATE_SYNTH_TOKENS: n(process.env.OPENAI_DEBATE_SYNTH_TOKENS, 1400),

  // HQ -> n8n
  N8N_WEBHOOK_URL: s(process.env.N8N_WEBHOOK_URL, ""),
  N8N_WEBHOOK_TOKEN: s(process.env.N8N_WEBHOOK_TOKEN, ""),
  N8N_TIMEOUT_MS: n(process.env.N8N_TIMEOUT_MS, 10_000),
  // n8n -> HQ callback
  N8N_CALLBACK_TOKEN: s(process.env.N8N_CALLBACK_TOKEN, ""),

  // ✅ Telegram (DEFAULT OFF)
  TELEGRAM_ENABLED: b(process.env.TELEGRAM_ENABLED, false),
  TELEGRAM_BOT_TOKEN: s(process.env.TELEGRAM_BOT_TOKEN, ""),
  TELEGRAM_CHAT_ID: s(process.env.TELEGRAM_CHAT_ID, ""),

  // ✅ Web Push (DEFAULT ON/OFF)
  PUSH_ENABLED: b(process.env.PUSH_ENABLED, true),
  VAPID_PUBLIC_KEY: s(process.env.VAPID_PUBLIC_KEY, ""),
  VAPID_PRIVATE_KEY: s(process.env.VAPID_PRIVATE_KEY, ""),
  VAPID_SUBJECT: s(process.env.VAPID_SUBJECT, "mailto:info@weneox.com"),

  LOG_LEVEL: s(process.env.LOG_LEVEL, "info"),
  DEBUG_DEBATE_RAW: b(process.env.DEBUG_DEBATE_RAW, false),
};