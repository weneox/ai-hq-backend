// src/wsHub.js (FINAL v1.2)
import { WebSocketServer } from "ws";

export function createWsHub({ server, token }) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set();

  function send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  // heartbeat (Railway/Cloud timeouts üçün)
  const interval = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 30_000);

  wss.on("close", () => clearInterval(interval));

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const t = url.searchParams.get("token") || "";

    if (token && t !== token) {
      ws.close(1008, "unauthorized");
      return;
    }

    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    clients.add(ws);
    send(ws, { type: "hello", ts: Date.now() });

    ws.on("close", () => clients.delete(ws));
  });

  return { broadcast, send };
}