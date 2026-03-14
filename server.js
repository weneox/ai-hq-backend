import "dotenv/config";

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";

import { cfg } from "./src/config.js";
import { assertConfigValid } from "./src/config/validate.js";
import { printFeatureReport } from "./src/config/featureReport.js";
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
  const raw = s(cfg.urls.corsOrigin, "");
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
  assertConfigValid(console);
  printFeatureReport(console);

  const app = express();

  if (cfg.app.trustProxy) {
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

  const uploadsDir = path.resolve(process.cwd(), "uploads");
  app.use("/assets", express.static(uploadsDir, { maxAge: "1h" }));

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      env: cfg.app.env,
      marker: "ROOT_BUILD_V4_FEATURES",
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
      env: cfg.app.env,
      port: cfg.app.port,
      hasDatabaseUrl: Boolean(s(cfg.db.url)),
      hasOpenAI: Boolean(s(cfg.ai.openaiApiKey)),
      hasRunway: Boolean(s(cfg.media.runwayApiKey)),
      hasElevenLabs: Boolean(s(cfg.media.elevenlabsApiKey)),
      hasCreatomate: Boolean(s(cfg.media.creatomateApiKey)),
      adminPanelEnabled: !!cfg.auth.adminPanelEnabled,
      hasAdminPasscodeHash: Boolean(s(cfg.auth.adminPasscodeHash)),
      hasAdminSessionSecret: Boolean(s(cfg.auth.adminSessionSecret)),
      hasUserSessionSecret: Boolean(s(cfg.auth.userSessionSecret)),
      hasScheduleWebhook: Boolean(s(cfg.n8n.scheduleDraftUrl)),
      hasWsAuthToken: Boolean(s(cfg.ws.authToken)),
      now: new Date().toISOString(),
      corsOrigin: s(cfg.urls.corsOrigin),
      allowedOrigins,
      marker: "WHOAMI_BUILD_V4_FEATURES",
    });
  });

  app.get("/__buildcheck", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      service: "ai-hq-backend",
      marker: "BUILD_CHECK_V4_FEATURES",
      env: cfg.app.env,
      port: cfg.app.port,
      time: new Date().toISOString(),
      publicBaseUrl: s(cfg.urls.publicBaseUrl),
      userSessionCookieName: s(cfg.auth.userSessionCookieName),
      hasUserSessionSecret: Boolean(s(cfg.auth.userSessionSecret)),
    });
  });

  app.get("/health", async (_req, res) => {
    const hasDbUrl = Boolean(s(cfg.db.url));
    const db = getDb();

    const out = {
      ok: true,
      service: "ai-hq-backend",
      env: cfg.app.env,
      marker: "HEALTH_BUILD_V4_FEATURES",
      db: {
        enabled: hasDbUrl,
        ok: false,
      },
      providers: {
        openai: !!cfg.ai.openaiApiKey,
        runway: !!cfg.media.runwayApiKey,
        elevenlabs: !!cfg.media.elevenlabsApiKey,
        creatomate: !!cfg.media.creatomateApiKey,
      },
      workers: {
        outboundRetryEnabled: !!cfg.workers.outboundRetryEnabled,
        draftScheduleEnabled: !!cfg.workers.draftScheduleWorkerEnabled,
        mediaJobWorkerEnabled: !!cfg.workers.mediaJobWorkerEnabled,
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
    token: cfg.ws.authToken,
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
      marker: "VOICE_TEST_BUILD_V4_FEATURES",
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
      marker: "API_BUILD_CHECK_V4_FEATURES",
      env: cfg.app.env,
      port: cfg.app.port,
      time: new Date().toISOString(),
      publicBaseUrl: s(cfg.urls.publicBaseUrl),
      userSessionCookieName: s(cfg.auth.userSessionCookieName),
      hasUserSessionSecret: Boolean(s(cfg.auth.userSessionSecret)),
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

  if (cfg.workers.draftScheduleWorkerEnabled) {
    draftScheduleWorker.start();
  }

  if (cfg.workers.mediaJobWorkerEnabled) {
    mediaJobWorker.start();
  }

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
      details: cfg.app.env !== "production" ? msg : undefined,
    });
  });

  server.listen(cfg.app.port, () => {
    const hasDb = Boolean(db);

    console.log(`[ai-hq] listening on :${cfg.app.port} env=${cfg.app.env}`);
    console.log(`[ai-hq] CORS_ORIGIN=${cfg.urls.corsOrigin}`);
    console.log(
      `[ai-hq] allowedOrigins=${allowedOrigins.join(",") || "(empty)"}`
    );
    console.log(`[ai-hq] DB=${hasDb ? "ON" : "OFF"}`);
    console.log(
      `[ai-hq] OpenAI=${cfg.ai.openaiApiKey ? "ON" : "OFF"} model=${cfg.ai.openaiModel}`
    );
    console.log(
      `[ai-hq] Runway=${cfg.media.runwayApiKey ? "ON" : "OFF"} model=${cfg.media.runwayVideoModel}`
    );
    console.log(
      `[ai-hq] ElevenLabs=${cfg.media.elevenlabsApiKey ? "ON" : "OFF"} voice=${cfg.media.elevenlabsVoiceId ? "SET" : "MISSING"}`
    );
    console.log(
      `[ai-hq] Creatomate=${cfg.media.creatomateApiKey ? "ON" : "OFF"} templateReel=${cfg.media.creatomateTemplateIdReel ? "SET" : "MISSING"}`
    );
    console.log(
      `[ai-hq] mediaJobWorker=${cfg.workers.mediaJobWorkerEnabled ? "ON" : "OFF"} interval=${Number(cfg.workers.mediaJobWorkerIntervalMs || 15000)}ms batch=${Number(cfg.workers.mediaJobWorkerBatchSize || 10)}`
    );
    console.log(
      `[ai-hq] WS_AUTH_TOKEN=${cfg.ws.authToken ? "ON" : "OFF"}`
    );
    console.log(
      `[ai-hq] META_GATEWAY=${cfg.gateway.metaGatewayBaseUrl ? "ON" : "OFF"} retryWorker=${cfg.workers.outboundRetryEnabled ? "ON" : "OFF"}`
    );
    console.log(
      `[ai-hq] draftScheduleWorker=${cfg.workers.draftScheduleWorkerEnabled ? "ON" : "OFF"} interval=${Number(cfg.workers.draftScheduleWorkerIntervalMs || 60000)}ms webhook=${cfg.n8n.scheduleDraftUrl ? "ON" : "OFF"}`
    );
    console.log(
      `[ai-hq] adminAuth enabled=${cfg.auth.adminPanelEnabled ? "ON" : "OFF"} passcodeHash=${cfg.auth.adminPasscodeHash ? "ON" : "OFF"} sessionSecret=${cfg.auth.adminSessionSecret ? "ON" : "OFF"}`
    );
    console.log(
      "[ai-hq] build markers: ROOT_BUILD_V4_FEATURES / WHOAMI_BUILD_V4_FEATURES / BUILD_CHECK_V4_FEATURES / API_BUILD_CHECK_V4_FEATURES"
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