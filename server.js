import "dotenv/config";

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { cfg } from "./src/config.js";
import { db, migrate } from "./src/db/index.js";
import { createWsHub } from "./src/wsHub.js";
import { apiRouter } from "./src/routes/api.js";

const app = express();

if (cfg.TRUST_PROXY) app.set("trust proxy", 1);

app.use(helmet());

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server + curl + no-origin
      if (!origin) return cb(null, true);

      const allowed =
        cfg.CORS_ORIGIN === "*" ||
        cfg.CORS_ORIGIN
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .includes(origin);

      return allowed ? cb(null, true) : cb(new Error("CORS blocked"));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "1mb" }));

// ✅ DEBUG: confirm which server is running in prod
app.get("/__whoami", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-hq-backend",
    env: cfg.APP_ENV,
    port: cfg.PORT,
    hasApiMounted: true,
    hasDatabaseUrl: Boolean(cfg.DATABASE_URL),
    hasOpenAI: Boolean(cfg.OPENAI_API_KEY),
    now: new Date().toISOString()
  });
});

app.get("/health", async (_req, res) => {
  const out = {
    ok: true,
    service: "ai-hq-backend",
    env: cfg.APP_ENV,
    db: { enabled: Boolean(cfg.DATABASE_URL), ok: false }
  };

  if (!cfg.DATABASE_URL) return res.json(out);

  try {
    const r = await db.query("select 1 as ok");
    out.db.ok = r?.rows?.[0]?.ok === 1;
  } catch {
    out.db.ok = false;
  }

  res.json(out);
});

// attach ws hub for routes
const server = http.createServer(app);
const wsHub = createWsHub({ server, token: cfg.WS_AUTH_TOKEN });

// routes
app.use("/api", apiRouter({ db, wsHub }));

// fallback: make it obvious if /api not found for some reason
app.use((req, res, _next) => {
  res.status(404).json({ ok: false, error: "Not found", path: req.path });
});

// boot
(async () => {
  try {
    if (cfg.DATABASE_URL) {
      const m = await migrate();
      console.log("[ai-hq] migrate:", m.ok ? "ok" : `skip/fail (${m.reason || m.error || "unknown"})`);
    } else {
      console.log("[ai-hq] migrate: DATABASE_URL not configured (skip)");
    }
  } catch (e) {
    console.log("[ai-hq] migrate error:", String(e?.message || e));
  }

  server.listen(cfg.PORT, () => {
    console.log(`[ai-hq] listening on :${cfg.PORT} env=${cfg.APP_ENV}`);
    console.log(`[ai-hq] CORS_ORIGIN=${cfg.CORS_ORIGIN}`);
    console.log(`[ai-hq] DB=${cfg.DATABASE_URL ? "ON" : "OFF"}`);
    console.log(`[ai-hq] OpenAI=${cfg.OPENAI_API_KEY ? "ON" : "OFF"} model=${cfg.OPENAI_MODEL}`);
    console.log(`[ai-hq] WS_AUTH_TOKEN=${cfg.WS_AUTH_TOKEN ? "ON" : "OFF"}`);
  });
})();

// graceful shutdown
process.on("SIGTERM", async () => {
  try {
    await db.end();
  } catch {}
  process.exit(0);
});