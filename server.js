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
import { adminAuthRoutes } from "./src/routes/api/adminAuth.js";

import { startOutboundRetryWorker } from "./src/workers/outboundRetryWorker.js";
import { createDraftScheduleWorker } from "./src/workers/draftScheduleWorker.js";

async function main() {
  const app = express();

  if (cfg.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);

        const allowedOrigins = String(cfg.CORS_ORIGIN || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const allowed =
          cfg.CORS_ORIGIN === "*" || allowedOrigins.includes(origin);

        return allowed ? cb(null, true) : cb(new Error("CORS blocked"));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
  app.use("/assets", express.static(UPLOADS_DIR, { maxAge: "1h" }));

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      endpoints: [
        "GET /health",
        "GET /__whoami",
        "GET /api/admin-auth/me",
        "POST /api/admin-auth/login",
        "POST /api/admin-auth/logout",
        "GET /api",
      ],
    });
  });

  app.get("/__whoami", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      port: cfg.PORT,
      hasDatabaseUrl: Boolean(String(cfg.DATABASE_URL || "").trim()),
      hasOpenAI: Boolean(String(cfg.OPENAI_API_KEY || "").trim()),
      adminPanelEnabled: !!cfg.ADMIN_PANEL_ENABLED,
      hasAdminPasscodeHash: Boolean(String(cfg.ADMIN_PANEL_PASSCODE_HASH || "").trim()),
      hasAdminSessionSecret: Boolean(String(cfg.ADMIN_SESSION_SECRET || "").trim()),
      hasUserSessionSecret: Boolean(String(cfg.USER_SESSION_SECRET || "").trim()),
      hasScheduleWebhook: Boolean(
        String(process.env.N8N_WEBHOOK_SCHEDULE_DRAFT_URL || "").trim()
      ),
      hasWsAuthToken: Boolean(String(cfg.WS_AUTH_TOKEN || "").trim()),
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
      db: {
        enabled: hasDbUrl,
        ok: false,
      },
      workers: {
        outboundRetryEnabled: !!cfg.OUTBOUND_RETRY_ENABLED,
        draftScheduleEnabled:
          String(process.env.DRAFT_SCHEDULE_WORKER_ENABLED || "1") !== "0",
      },
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

  try {
    await initDb();
    const m = await migrate();
    console.log(
      "[ai-hq] migrate:",
      m?.ok ? "ok" : `skip/fail (${m?.reason || m?.error || "unknown"})`
    );
  } catch (e) {
    console.log("[ai-hq] migrate error:", String(e?.message || e));
  }

  const db = getDb();

  const server = http.createServer(app);
  const wsHub = createWsHub({
    server,
    token: cfg.WS_AUTH_TOKEN,
  });

  app.use("/api", adminAuthRoutes({ db, wsHub }));

  app.use(
    "/api",
    apiRouter({
      db,
      wsHub,
    })
  );

  const outboundRetryWorker = startOutboundRetryWorker({
    db,
    wsHub,
  });

  const draftScheduleWorker = createDraftScheduleWorker({
    db,
  });

  draftScheduleWorker.start();

  app.use((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(404).json({
      ok: false,
      error: "Not found",
      path: req.path,
    });
  });

  app.use((err, _req, res, _next) => {
    console.error("[api] error:", err?.message || err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({
      ok: false,
      error: "Server error",
    });
  });

  server.listen(cfg.PORT, () => {
    const hasDb = Boolean(db);

    console.log(`[ai-hq] listening on :${cfg.PORT} env=${cfg.APP_ENV}`);
    console.log(`[ai-hq] CORS_ORIGIN=${cfg.CORS_ORIGIN}`);
    console.log(`[ai-hq] DB=${hasDb ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] OpenAI=${cfg.OPENAI_API_KEY ? "ON" : "OFF"} model=${cfg.OPENAI_MODEL}`
    );
    console.log(`[ai-hq] WS_AUTH_TOKEN=${cfg.WS_AUTH_TOKEN ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] META_GATEWAY=${cfg.META_GATEWAY_BASE_URL ? "ON" : "OFF"} retryWorker=${
        cfg.OUTBOUND_RETRY_ENABLED ? "ON" : "OFF"
      }`
    );
    console.log(
      `[ai-hq] draftScheduleWorker=${
        String(process.env.DRAFT_SCHEDULE_WORKER_ENABLED || "1") !== "0"
          ? "ON"
          : "OFF"
      } interval=${Number(
        process.env.DRAFT_SCHEDULE_WORKER_INTERVAL_MS || 60000
      )}ms webhook=${
        String(process.env.N8N_WEBHOOK_SCHEDULE_DRAFT_URL || "").trim()
          ? "ON"
          : "OFF"
      }`
    );
    console.log(
      `[ai-hq] adminAuth enabled=${cfg.ADMIN_PANEL_ENABLED ? "ON" : "OFF"} passcodeHash=${
        cfg.ADMIN_PANEL_PASSCODE_HASH ? "ON" : "OFF"
      } sessionSecret=${cfg.ADMIN_SESSION_SECRET ? "ON" : "OFF"}`
    );
  });

  async function shutdown(signal = "SIGTERM") {
    console.log(`[ai-hq] shutdown signal=${signal}`);

    try {
      outboundRetryWorker?.stop?.();
    } catch {}

    try {
      draftScheduleWorker?.stop?.();
    } catch {}

    try {
      if (db) {
        await db.end();
      }
    } catch {}

    try {
      server.close(() => {
        process.exit(0);
      });

      setTimeout(() => {
        process.exit(0);
      }, 3000).unref();
    } catch {
      process.exit(0);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[ai-hq] fatal:", String(e?.message || e));
  process.exit(1);
});