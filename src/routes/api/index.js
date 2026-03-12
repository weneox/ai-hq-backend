import express from "express";
import {
  requireUserSession,
  readUserSessionFromRequest,
} from "../../utils/adminAuth.js";

import { healthRoutes } from "./health.js";
import { modeRoutes } from "./mode.js";
import { agentsRoutes } from "./agents.js";
import { renderRoutes } from "./render.js";
import { mediaRoutes } from "./media.js";
import { pushRoutes } from "./push.js";
import { notificationsRoutes } from "./notifications.js";
import { contentRoutes } from "./content.js";
import { proposalsRoutes } from "./proposals.js";
import { executionsRoutes } from "./executions.js";
import { threadsRoutes } from "./threads.js";
import { chatRoutes } from "./chat.js";
import { debateRoutes } from "./debate.js";
import { debugRoutes } from "./debug.js";
import { inboxRoutes } from "./inbox.js";
import { leadsRoutes } from "./leads.js";
import { commentsRoutes } from "./comments.js";
import { settingsRoutes } from "./settings.js";
import { teamRoutes } from "./team.js";
import { tenantsRoutes } from "./tenants.js";
import { voiceInternalRoutes } from "./voiceInternal.js";
import { voiceRoutes } from "./voice.js";
import { channelConnectRoutes } from "./channelConnect.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

export function apiRouter({ db, wsHub, audit, dbDisabled = false }) {
  const r = express.Router();

  // -----------------------------
  // PUBLIC / DEBUG BEFORE GUARD
  // -----------------------------
  r.get("/__guard-before", (req, res) => {
    const session = readUserSessionFromRequest(req);

    return res.status(200).json({
      ok: true,
      marker: "API_GUARD_BEFORE_V1",
      hasCookieHeader: Boolean(s(req.headers.cookie)),
      cookieHeaderLength: s(req.headers.cookie).length,
      verify: {
        ok: !!session?.ok,
        error: session?.error || null,
      },
      payload: session?.ok ? session.payload : null,
    });
  });

  // public / infra
  r.use("/", healthRoutes({ db }));

  // internal / helper routes
  r.use("/", voiceInternalRoutes({ db }));
  r.use("/", tenantsRoutes({ db }));

  // public oauth / connect callback flow
  r.use("/", channelConnectRoutes({ db }));

  // -----------------------------
  // REQUIRE USER SESSION
  // -----------------------------
  r.use(requireUserSession);

  // -----------------------------
  // DEBUG AFTER GUARD
  // -----------------------------
  r.get("/__guard-after", (req, res) => {
    return res.status(200).json({
      ok: true,
      marker: "API_GUARD_AFTER_V1",
      auth: req.auth || null,
      user: req.user || null,
    });
  });

  // authenticated app routes
  r.use("/", modeRoutes({ db, wsHub }));
  r.use("/", agentsRoutes());
  r.use("/", renderRoutes());
  r.use("/", mediaRoutes({ db }));
  r.use("/", pushRoutes({ db, wsHub }));
  r.use("/", notificationsRoutes({ db, wsHub }));
  r.use("/", contentRoutes({ db, wsHub }));
  r.use("/", proposalsRoutes({ db, wsHub }));
  r.use("/", executionsRoutes({ db, wsHub }));
  r.use("/", threadsRoutes({ db }));
  r.use("/", chatRoutes({ db, wsHub }));
  r.use("/", debateRoutes({ db, wsHub }));
  r.use("/", inboxRoutes({ db, wsHub }));
  r.use("/", leadsRoutes({ db, wsHub }));
  r.use("/", commentsRoutes({ db, wsHub }));
  r.use("/", settingsRoutes({ db }));
  r.use("/", debugRoutes());
  r.use("/", teamRoutes({ db }));

  r.use(
    "/",
    voiceRoutes({
      db,
      dbDisabled,
      audit,
    })
  );

  return r;
}