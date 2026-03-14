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
import { createMediaJobWorker } from "./src/workers/mediaJobWorker.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function buildAllowedOrigins() {
  const raw = s(cfg.CORS_ORIGIN, "");
  if (!raw) return [];
  if (raw === "*") return ["*"];

  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function createAuditLogger(db) {
  return {
    async log({
      tenantId = null,
      tenantKey = "",
      actor = "system",
      action = "",
      objectType = "unknown",
      objectId = null,
      meta = {},
    } = {}) {
      if (!db || !action) return null;

      try {
        await db.query(
          `
            insert into audit_log (
              tenant_id,
              tenant_key,
              actor,
              action,
              object_type,
              object_id,
              meta
            )
            values ($1,$2,$3,$4,$5,$6,$7::jsonb)
          `,
          [
            s(tenantId) || null,
            s(tenantKey) || null,
            s(actor, "system"),
            s(action),
            s(objectType, "unknown"),
            s(objectId) || null,
            JSON.stringify(meta && typeof meta === "object" ? meta : {}),
          ]
        );
      } catch (e) {
        console.error("[audit] log failed:", String(e?.message || e));
      }
    },
  };
}

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

  const allowedOrigins = buildAllowedOrigins();

  const corsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes("*")) {
        return cb(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }

      console.error(
        `[cors] blocked origin=${origin} allowed=${allowedOrigins.join(",")}`
      );
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-internal-token",
      "x-webhook-token",
      "x-callback-token",
      "x-debug-token",
      "x-tenant-key",
      "Accept",
    ],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));

  app.use(express.json({ limit: "8mb" }));
  app.use(express.urlencoded({ extended: false }));

  const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
  app.use("/assets", express.static(UPLOADS_DIR, { maxAge: "1h" }));

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      marker: "ROOT_BUILD_V2_MEDIA",
      endpoints: [
        "GET /health",
        "GET /__whoami",
        "GET /__buildcheck",
        "GET /api/__buildcheck",
        "POST /api/__voice-test",
        "GET /api/admin-auth/me",
        "POST /api/admin-auth/login",
        "POST /api/admin-auth/logout",
        "POST /api/auth/login",
        "POST /api/auth/logout",
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
      hasDatabaseUrl: Boolean(s(cfg.DATABASE_URL)),
      hasOpenAI: Boolean(s(cfg.OPENAI_API_KEY)),
      hasRunway: Boolean(s(cfg.RUNWAY_API_KEY)),
      hasElevenLabs: Boolean(s(cfg.ELEVENLABS_API_KEY)),
      hasCreatomate: Boolean(s(cfg.CREATOMATE_API_KEY)),
      adminPanelEnabled: !!cfg.ADMIN_PANEL_ENABLED,
      hasAdminPasscodeHash: Boolean(s(cfg.ADMIN_PANEL_PASSCODE_HASH)),
      hasAdminSessionSecret: Boolean(s(cfg.ADMIN_SESSION_SECRET)),
      hasUserSessionSecret: Boolean(s(cfg.USER_SESSION_SECRET)),
      hasScheduleWebhook: Boolean(
        s(process.env.N8N_WEBHOOK_SCHEDULE_DRAFT_URL)
      ),
      hasWsAuthToken: Boolean(s(cfg.WS_AUTH_TOKEN)),
      now: new Date().toISOString(),
      corsOrigin: s(cfg.CORS_ORIGIN),
      allowedOrigins,
      marker: "WHOAMI_BUILD_V2_MEDIA",
    });
  });

  app.get("/__buildcheck", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      marker: "BUILD_CHECK_V2_MEDIA",
      env: cfg.APP_ENV,
      port: cfg.PORT,
      time: new Date().toISOString(),
      publicBaseUrl: s(cfg.PUBLIC_BASE_URL),
      userSessionCookieName: s(cfg.USER_SESSION_COOKIE_NAME),
      hasUserSessionSecret: Boolean(s(cfg.USER_SESSION_SECRET)),
    });
  });

  app.get("/health", async (_req, res) => {
    const hasDbUrl = Boolean(s(cfg.DATABASE_URL));
    const db = getDb();

    const out = {
      ok: true,
      service: "ai-hq-backend",
      env: cfg.APP_ENV,
      marker: "HEALTH_BUILD_V2_MEDIA",
      db: {
        enabled: hasDbUrl,
        ok: false,
      },
      providers: {
        openai: !!cfg.OPENAI_API_KEY,
        runway: !!cfg.RUNWAY_API_KEY,
        elevenlabs: !!cfg.ELEVENLABS_API_KEY,
        creatomate: !!cfg.CREATOMATE_API_KEY,
      },
      workers: {
        outboundRetryEnabled: !!cfg.OUTBOUND_RETRY_ENABLED,
        draftScheduleEnabled:
          s(process.env.DRAFT_SCHEDULE_WORKER_ENABLED, "1") !== "0",
        mediaJobWorkerEnabled: !!cfg.MEDIA_JOB_WORKER_ENABLED,
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
  const dbDisabled = !db;
  const audit = createAuditLogger(db);

  app.locals.db = db;

  const server = http.createServer(app);
  const wsHub = createWsHub({
    server,
    token: cfg.WS_AUTH_TOKEN,
  });

  app.post("/api/__voice-test", (req, res) => {
    console.log("[server] __voice-test HIT", {
      body: req.body,
      hasInternalToken: !!req.headers["x-internal-token"],
      hasWebhookToken: !!req.headers["x-webhook-token"],
    });

    return res.status(200).json({
      ok: true,
      route: "__voice-test",
      marker: "VOICE_TEST_BUILD_V2_MEDIA",
      body: req.body || null,
      hasInternalToken: !!req.headers["x-internal-token"],
      hasWebhookToken: !!req.headers["x-webhook-token"],
    });
  });

  app.get("/api/__buildcheck", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      marker: "API_BUILD_CHECK_V2_MEDIA",
      env: cfg.APP_ENV,
      port: cfg.PORT,
      time: new Date().toISOString(),
      publicBaseUrl: s(cfg.PUBLIC_BASE_URL),
      userSessionCookieName: s(cfg.USER_SESSION_COOKIE_NAME),
      hasUserSessionSecret: Boolean(s(cfg.USER_SESSION_SECRET)),
    });
  });

  app.use("/api", adminAuthRoutes({ db, wsHub }));

  app.use(
    "/api",
    apiRouter({
      db,
      wsHub,
      audit,
      dbDisabled,
    })
  );

  const outboundRetryWorker = startOutboundRetryWorker({
    db,
    wsHub,
  });

  const draftScheduleWorker = createDraftScheduleWorker({
    db,
  });

  const mediaJobWorker = createMediaJobWorker({
    db,
  });

  draftScheduleWorker.start();
  mediaJobWorker.start();

  app.use((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(404).json({
      ok: false,
      error: "Not found",
      path: req.path,
    });
  });

  app.use((err, req, res, _next) => {
    const msg = String(err?.message || err || "Server error");
    console.error("[api] error:", msg);

    if (msg.toLowerCase().includes("cors")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(403).json({
        ok: false,
        error: msg,
        origin: req.headers.origin || null,
      });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: s(process.env.NODE_ENV) !== "production" ? msg : undefined,
    });
  });

  server.listen(cfg.PORT, () => {
    const hasDb = Boolean(db);

    console.log(`[ai-hq] listening on :${cfg.PORT} env=${cfg.APP_ENV}`);
    console.log(`[ai-hq] CORS_ORIGIN=${cfg.CORS_ORIGIN}`);
    console.log(
      `[ai-hq] allowedOrigins=${allowedOrigins.join(",") || "(empty)"}`
    );
    console.log(`[ai-hq] DB=${hasDb ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] OpenAI=${cfg.OPENAI_API_KEY ? "ON" : "OFF"} model=${cfg.OPENAI_MODEL}`
    );
    console.log(
      `[ai-hq] Runway=${cfg.RUNWAY_API_KEY ? "ON" : "OFF"} model=${cfg.RUNWAY_VIDEO_MODEL}`
    );
    console.log(
      `[ai-hq] ElevenLabs=${cfg.ELEVENLABS_API_KEY ? "ON" : "OFF"} voice=${cfg.ELEVENLABS_VOICE_ID ? "SET" : "MISSING"}`
    );
    console.log(
      `[ai-hq] Creatomate=${cfg.CREATOMATE_API_KEY ? "ON" : "OFF"} templateReel=${cfg.CREATOMATE_TEMPLATE_ID_REEL ? "SET" : "MISSING"}`
    );
    console.log(
      `[ai-hq] mediaJobWorker=${cfg.MEDIA_JOB_WORKER_ENABLED ? "ON" : "OFF"} interval=${Number(cfg.MEDIA_JOB_WORKER_INTERVAL_MS || 15000)}ms batch=${Number(cfg.MEDIA_JOB_WORKER_BATCH_SIZE || 10)}`
    );
    console.log(`[ai-hq] WS_AUTH_TOKEN=${cfg.WS_AUTH_TOKEN ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] META_GATEWAY=${cfg.META_GATEWAY_BASE_URL ? "ON" : "OFF"} retryWorker=${
        cfg.OUTBOUND_RETRY_ENABLED ? "ON" : "OFF"
      }`
    );
    console.log(
      `[ai-hq] draftScheduleWorker=${
        s(process.env.DRAFT_SCHEDULE_WORKER_ENABLED, "1") !== "0" ? "ON" : "OFF"
      } interval=${Number(process.env.DRAFT_SCHEDULE_WORKER_INTERVAL_MS || 60000)}ms webhook=${
        s(process.env.N8N_WEBHOOK_SCHEDULE_DRAFT_URL) ? "ON" : "OFF"
      }`
    );
    console.log(
      `[ai-hq] adminAuth enabled=${cfg.ADMIN_PANEL_ENABLED ? "ON" : "OFF"} passcodeHash=${
        cfg.ADMIN_PANEL_PASSCODE_HASH ? "ON" : "OFF"
      } sessionSecret=${cfg.ADMIN_SESSION_SECRET ? "ON" : "OFF"}`
    );
    console.log(
      `[ai-hq] build markers: ROOT_BUILD_V2_MEDIA / WHOAMI_BUILD_V2_MEDIA / BUILD_CHECK_V2_MEDIA / API_BUILD_CHECK_V2_MEDIA`
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
      mediaJobWorker?.stop?.();
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