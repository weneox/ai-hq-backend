import "dotenv/config";

const opt = (k, d = "") => String(process.env[k] || d).trim();

export const config = {
  app: {
    env: opt("APP_ENV", opt("NODE_ENV", "development")),
    port: Number(opt("PORT", "8080")) || 8080,
    corsOrigin: opt("CORS_ORIGIN", "*")
  },
  auth: {
    wsToken: opt("WS_AUTH_TOKEN", "")
  },
  db: {
    url: opt("DATABASE_URL", "")
  },
  openai: {
    apiKey: opt("OPENAI_API_KEY", ""),
    model: opt("OPENAI_MODEL", "gpt-5")
  }
};

export const IS_PROD = config.app.env === "production";