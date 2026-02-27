// src/config.js (FINAL)
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
  // server
  PORT: n(process.env.PORT, 8080),
  APP_ENV: s(process.env.APP_ENV, process.env.NODE_ENV || "production"),
  TRUST_PROXY: b(process.env.TRUST_PROXY, false),

  // cors
  // Use "*" for local dev; for prod use comma-separated list: "https://a.com,https://b.com"
  CORS_ORIGIN: s(process.env.CORS_ORIGIN, "*"),

  // db + ws
  DATABASE_URL: s(process.env.DATABASE_URL, ""),
  WS_AUTH_TOKEN: s(process.env.WS_AUTH_TOKEN, ""),

  // debug endpoint auth
  DEBUG_API_TOKEN: s(process.env.DEBUG_API_TOKEN, ""),

  // openai
  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),

  // default for /api/chat (agentKernel)
  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 450),

  // debate engine behavior
  OPENAI_TIMEOUT_MS: n(process.env.OPENAI_TIMEOUT_MS, 25_000),
  OPENAI_DEBATE_CONCURRENCY: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),

  // ✅ IMPORTANT: prevents "completed but empty" in debate
  OPENAI_DEBATE_AGENT_TOKENS: n(process.env.OPENAI_DEBATE_AGENT_TOKENS, 900),
  OPENAI_DEBATE_SYNTH_TOKENS: n(process.env.OPENAI_DEBATE_SYNTH_TOKENS, 1200),

  // Optional: make debate less "reasoning-hungry"
  // (your debateEngine uses reasoning.effort="low" already, this is here if you want to branch later)
  OPENAI_DEBATE_TEMPERATURE: n(process.env.OPENAI_DEBATE_TEMPERATURE, 0.6),

  // n8n webhook
  N8N_WEBHOOK_URL: s(process.env.N8N_WEBHOOK_URL, ""),
  N8N_WEBHOOK_TOKEN: s(process.env.N8N_WEBHOOK_TOKEN, ""),
  N8N_TIMEOUT_MS: n(process.env.N8N_TIMEOUT_MS, 10_000),

  // ops toggles (optional)
  LOG_LEVEL: s(process.env.LOG_LEVEL, "info"), // "debug" | "info" | "warn" | "error"
  DEBUG_DEBATE_RAW: b(process.env.DEBUG_DEBATE_RAW, false), // if you want to print raw openai responses in debate
};