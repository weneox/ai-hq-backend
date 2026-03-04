import "dotenv/config";

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";

import { cfg } from "./src/config.js";
import { initDb, getDb, migrate } from "./src/db/index.js";
import { createWsHub } from "./src/wsHub.js";
import { apiRouter } from "./src/routes/api.js";

async function main() {
  const app = express();

  if (cfg.TRUST_PROXY) app.set("trust proxy", 1);

  // security headers
  app.use(helmet());

  // CORS: allow server-to-server (no Origin) + allow listed origins
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // server-to-server / curl / powershell

        const allowed =
          cfg.CORS_ORIGIN === "*" ||
          String(cfg.CORS_ORIGIN || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .includes(origin);

        return allowed ? cb(null, true) : cb(new Error("CORS blocked"));
      },
      credentials: true,
    })
  );

  // Body parsers
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  // ================================
  // Static uploads (ASSETS)
  // ================================
  const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
  app.use("/assets", express.static(UPLOADS_DIR, { maxAge: "1h" }));
  // ================================

  // Root info
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      endpoints: ["GET /health", "GET /__whoami", "GET /api"],
    });
  });

  app.get("/__whoami", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      port: cfg.PORT,
      hasDatabaseUrl: Boolean(String(cfg.DATABASE_URL || "").trim()),
      hasOpenAI: Boolean(String(cfg.OPENAI_API_KEY || "").trim()),
      now: new Date().toISOString(),
    });
  });

  app.get("/health", async (_req, res) => {
    const hasDbUrl = Boolean(String(cfg.DATABASE_URL || "").trim());
    const db = getDb();

    const out = {
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      db: { enabled: hasDbUrl, ok: false },
    };

    if (!hasDbUrl || !db) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json(out);
    }

    try {
      const r = await db.query("select 1 as ok");
      out.db.ok = r?.rows?.[0]?.ok === 1;
    } catch {
      out.db.ok = false;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(out);
  });

  // init DB BEFORE routes
  try {
    await initDb();
    const m = await migrate();
    console.log(
      "[ai-hq] migrate:",
      m.ok ? "ok" : `skip/fail (${m.reason || m.error || "unknown"})`
    );
  } catch (e) {
    console.log("[ai-hq] migrate error:", String(e?.message || e));
  }

  const server = http.createServer(app);
  const wsHub = createWsHub({ server, token: cfg.WS_AUTH_TOKEN });

  // mount routes
  app.use("/api", apiRouter({ db: getDb(), wsHub }));

  // Fallback 404
  app.use((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(404).json({ ok: false, error: "Not found", path: req.path });
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    console.error("[api] error:", err?.message || err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(500).json({ ok: false, error: "Server error" });
  });

  server.listen(cfg.PORT, () => {
    const hasDb = Boolean(getDb());
    console.log(`[ai-hq] listening on :${cfg.PORT} env=${cfg.APP_ENV}`);
    console.log(`[ai-hq] CORS_ORIGIN=${cfg.CORS_ORIGIN}`);
    console.log(`[ai-hq] DB=${hasDb ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] OpenAI=${cfg.OPENAI_API_KEY ? "ON" : "OFF"} model=${cfg.OPENAI_MODEL}`
    );
    console.log(
      `[ai-hq] WS_AUTH_TOKEN=${cfg.WS_AUTH_TOKEN ? "ON" : "OFF"}`
    );
  });

  async function shutdown() {
    try {
      const db = getDb();
      if (db) await db.end();
    } catch {}
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[ai-hq] fatal:", String(e?.message || e));
  process.exit(1);
});