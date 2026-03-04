import express from "express";

import { cfg } from "../../config.js";
import { DEBATE_ENGINE_VERSION } from "../../kernel/debateEngine.js";
import { okJson, isDbReady } from "../../utils/http.js";

export function healthRoutes({ db }) {
  const r = express.Router();

  r.get("/", async (_req, res) => {
    return okJson(res, {
      ok: true,
      service: "ai-hq-backend",
      db: { enabled: isDbReady(db) },
      debateEngine: DEBATE_ENGINE_VERSION,
      endpoints: [
        "GET /api",
        "GET /api/mode?tenantId=",
        "POST /api/mode {tenantId, mode}",
        "GET /api/agents",
        "POST /api/chat",
        "POST /api/debate",
        "GET /api/threads/:id/messages",
        "GET /api/proposals?status=pending|in_progress|approved|published|rejected",
        "POST /api/proposals/:id/decision",
        "POST /api/proposals/:id/request-changes",
        "POST /api/proposals/:id/publish",
        "GET /api/notifications?recipient=ceo&unread=1",
        "POST /api/notifications/:id/read",
        "GET /api/push/vapid",
        "POST /api/push/subscribe",
        "POST /api/push/test",
        "GET /api/executions?status=&limit=&executionId=",
        "GET /api/executions/:id",
        "POST /api/executions/callback",
        "GET /api/content?proposalId=",
        "POST /api/content/:id/feedback",
        "POST /api/content/:id/approve",
        "POST /api/content/:id/publish",
        "POST /api/render/slides",
        "POST /api/media/image",
        "POST /api/debug/openai"
      ],
      defaults: {
        tenant: cfg.DEFAULT_TENANT_KEY,
        mode: cfg.DEFAULT_MODE
      }
    });
  });

  return r;
}