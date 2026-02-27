// src/config.js
function s(v, d = "") {
  return String(v ?? d).trim();
}
function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

export const cfg = {
  PORT: n(process.env.PORT, 8080),
  APP_ENV: s(process.env.APP_ENV, process.env.NODE_ENV || "production"),
  TRUST_PROXY: s(process.env.TRUST_PROXY, "0") === "1",

  CORS_ORIGIN: s(process.env.CORS_ORIGIN, "*"),

  DATABASE_URL: s(process.env.DATABASE_URL, ""),
  WS_AUTH_TOKEN: s(process.env.WS_AUTH_TOKEN, ""),

  DEBUG_API_TOKEN: s(process.env.DEBUG_API_TOKEN, ""),

  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),
  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 450),

  // ✅ debate timeouts/concurrency
  OPENAI_TIMEOUT_MS: n(process.env.OPENAI_TIMEOUT_MS, 25_000),
  OPENAI_DEBATE_CONCURRENCY: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),

  // ✅ n8n webhook
  N8N_WEBHOOK_URL: s(process.env.N8N_WEBHOOK_URL, ""),
  N8N_WEBHOOK_TOKEN: s(process.env.N8N_WEBHOOK_TOKEN, ""),
  N8N_TIMEOUT_MS: n(process.env.N8N_TIMEOUT_MS, 10_000),
};