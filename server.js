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
app.use(
  cors({
    origin: config.app.corsOrigin === "*" ? true : config.app.corsOrigin
  })
);
app.use(express.json({ limit: "2mb" }));

/* ---------------- Routes ---------------- */
app.get("/", (req, res) => res.send("AI HQ Running"));

app.get("/health", async (req, res) => {
  try {
    const db = await pingDb();
    res.json({
      ok: true,
      env: config.app.env,
      db
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
});

app.use("/api", api);

/* ---------------- Server + WS ---------------- */
const server = http.createServer(app);
const ws = setupWs(server);

const PORT = config.app.port;

server.listen(PORT, async () => {
  console.log("[ai-hq] listening on", PORT, "wsClients=", ws.clientCount());

  try {
    const mig = await migrate();
    console.log("[ai-hq] migrate:", mig);

    if (pool) {
      await ensureDefaultAgents(pool);
      console.log("[ai-hq] default agents ensured");
    }
  } catch (e) {
    console.error("[ai-hq] boot failed:", e.message);
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