import "dotenv/config";

import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { config } from "./src/config.js";
import { migrate, pingDb, pool } from "./src/db/index.js";
import { setupWs } from "./src/wsHub.js";
import { api } from "./src/routes/api.js";
import { ensureDefaultAgents } from "./src/kernel/agentKernel.js";

const app = express();

/* ---------------- Security ---------------- */
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: browser-də origin var, server-to-server-də Origin olmur.
// Ona görə Origin yoxdursa allow edək.
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = config.app.corsOrigin;

      // no-origin requests (curl, webhook, server)
      if (!origin) return cb(null, true);

      // allow all
      if (allowed === "*") return cb(null, true);

      // single origin string
      if (typeof allowed === "string") return cb(null, origin === allowed);

      // fallback allow
      return cb(null, false);
    }
  })
);

app.use(express.json({ limit: "2mb" }));

/* ---------------- Routes ---------------- */
app.get("/", (req, res) => res.send("AI HQ Running"));

// Heç vaxt 500 qaytarmayaq: DB səhv olsa da health yaşıl görünsün
app.get("/health", async (req, res) => {
  const db = await pingDb();
  res.status(200).json({
    ok: true,
    env: config.app.env,
    db
  });
});

app.use("/api", api);

/* ---------------- Server + WS ---------------- */
const server = http.createServer(app);
const ws = setupWs(server);

const PORT = config.app.port;

server.listen(PORT, async () => {
  console.log("[ai-hq] listening on", PORT, "wsClients=", ws.clientCount());

  // migrate + default agents: “fatal” olmasın, sadəcə log etsin
  const mig = await migrate();
  console.log("[ai-hq] migrate:", mig);

  if (pool && mig.ok) {
    try {
      await ensureDefaultAgents(pool);
      console.log("[ai-hq] default agents ensured");
    } catch (e) {
      console.error("[ai-hq] ensureDefaultAgents failed:", e?.message || e);
    }
  } else {
    console.log("[ai-hq] DB not ready -> skipping ensureDefaultAgents");
  }
});

/* ---------------- Graceful shutdown ---------------- */
async function shutdown() {
  console.log("\n[ai-hq] shutting down...");
  try {
    if (pool) await pool.end();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);