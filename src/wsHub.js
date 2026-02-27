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
      try { ws.send(payload); } catch {}
    }
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const t = url.searchParams.get("token") || "";

    if (token && t !== token) {
      ws.close(1008, "unauthorized");
      return;
    }

    clients.add(ws);
    send(ws, { type: "hello", ts: Date.now() });

    ws.on("close", () => clients.delete(ws));
  });

  return {
    broadcast
  };
}