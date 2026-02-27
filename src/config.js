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

  OPENAI_API_KEY: s(process.env.OPENAI_API_KEY, ""),
  OPENAI_MODEL: s(process.env.OPENAI_MODEL, "gpt-5"),
  OPENAI_MAX_OUTPUT_TOKENS: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 450)
};