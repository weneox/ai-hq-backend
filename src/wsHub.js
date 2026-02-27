import { WebSocketServer } from "ws";
import { config } from "./config.js";

/**
 * Simple WS hub:
 * - URL: ws://localhost:8080/ws?token=...
 * - If WS_AUTH_TOKEN empty => allow
 */
export function setupWs(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  const clients = new Set();

  function isAllowed(req) {
    const required = String(config.auth.wsToken || "").trim();
    if (!required) return true;

    try {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token") || "";
      return token === required;
    } catch {
      return false;
    }
  }

  function safeSend(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function broadcast(obj) {
    for (const ws of clients) safeSend(ws, obj);
  }

  wss.on("connection", (ws, req) => {
    if (!isAllowed(req)) {
      try {
        ws.close(1008, "Unauthorized");
      } catch {}
      return;
    }

    clients.add(ws);
    safeSend(ws, { type: "hello", ts: Date.now() });

    ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(String(raw || ""));
      } catch {
        safeSend(ws, { type: "error", error: "invalid_json" });
        return;
      }
      // For now: echo back + broadcast event bus style
      broadcast({ type: "ws.event", ts: Date.now(), payload: msg });
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  return {
    broadcast,
    clientCount: () => clients.size
  };
}