import express from "express";
import { requireUserSession } from "../../utils/adminAuth.js";

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

export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  // public / infra
  r.use("/", healthRoutes({ db }));

  // internal / helper routes
  r.use("/", tenantsRoutes({ db }));
  r.use("/", voiceInternalRoutes({ db }));

  // authenticated app routes
  r.use(requireUserSession);

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

  return r;
}