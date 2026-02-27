import express from "express";
import { cfg } from "../config.js";
import { kernelHandle, listAgents, debugOpenAI } from "../kernel/agentKernel.js";

function okJson(res, payload) {
  // Always 200 to avoid PowerShell Invoke-RestMethod throwing.
  return res.status(200).json(payload);
}

function requireDebugToken(req) {
  const token = String(req.headers["x-debug-token"] || req.query.token || "").trim();
  return Boolean(cfg.DEBUG_API_TOKEN) && token && token === cfg.DEBUG_API_TOKEN;
}

export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  // Root
  r.get("/", (_req, res) =>
    okJson(res, {
      ok: true,
      service: "ai-hq-backend",
      endpoints: [
        "GET /api",
        "GET /api/agents",
        "POST /api/chat",
        "GET /api/threads/:id/messages",
        "GET /api/proposals?status=pending",
        "POST /api/proposals/:id/decision",
        "POST /api/debug/openai (token)"
      ]
    })
  );

  // Agents
  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));

  // Messages by thread
  r.get("/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "thread id required" });

    try {
      const q = await db.query(
        `select id, thread_id, role, agent, content, meta, created_at
         from messages
         where thread_id = $1
         order by created_at asc`,
        [threadId]
      );
      return okJson(res, { ok: true, threadId, messages: q.rows || [] });
    } catch (e) {
      return okJson(res, { ok: false, error: String(e?.message || e) });
    }
  });

  // Proposals list
  r.get("/proposals", async (req, res) => {
    const status = String(req.query.status || "pending").trim();
    try {
      const q = await db.query(
        `select id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by
         from proposals
         where status = $1
         order by created_at desc
         limit 100`,
        [status]
      );
      return okJson(res, { ok: true, status, proposals: q.rows || [] });
    } catch (e) {
      return okJson(res, { ok: false, error: String(e?.message || e) });
    }
  });

  // Decide proposal
  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = String(req.body?.decision || "").trim(); // approved|rejected
    const by = String(req.body?.by || "ceo").trim();

    if (!id) return okJson(res, { ok: false, error: "proposal id required" });
    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, { ok: false, error: 'decision must be "approved" or "rejected"' });
    }

    try {
      const q = await db.query(
        `update proposals
         set status = $1, decided_at = now(), decision_by = $2
         where id = $3
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [decision, by, id]
      );

      const row = q.rows?.[0];
      if (!row) return okJson(res, { ok: false, error: "proposal not found" });

      // WS broadcast (optional)
      try {
        wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
      } catch {}

      return okJson(res, { ok: true, proposal: row });
    } catch (e) {
      return okJson(res, { ok: false, error: String(e?.message || e) });
    }
  });

  // Chat
  r.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn;

    try {
      // Create thread if not provided
      if (!threadId) {
        const t = await db.query(
          `insert into threads (title) values ($1) returning id`,
          [`Thread ${new Date().toISOString()}`]
        );
        threadId = t.rows?.[0]?.id;
      }

      // Save user message
      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1, 'user', $2, $3, $4)`,
        [threadId, agent || null, message, {}]
      );

      // Ask kernel
      const out = await kernelHandle({ message, agentHint: agent || undefined });

      // Save assistant message
      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1, 'assistant', $2, $3, $4)`,
        [threadId, out.agent || null, out.replyText || "", {}]
      );

      // Save proposal if exists
      let savedProposal = null;
      if (out.proposal && typeof out.proposal === "object") {
        const p = out.proposal || {};
        const type = String(p.type || "generic");
        const title = String(p.title || "");
        const payload = p.payload || {};

        const ins = await db.query(
          `insert into proposals (thread_id, agent, type, status, title, payload)
           values ($1, $2, $3, 'pending', $4, $5)
           returning id, thread_id, agent, type, status, title, payload, created_at`,
          [threadId, out.agent || "orion", type, title, payload]
        );

        savedProposal = ins.rows?.[0] || null;

        try {
          wsHub?.broadcast?.({ type: "proposal.created", proposal: savedProposal });
        } catch {}
      }

      // WS broadcast message (optional)
      try {
        wsHub?.broadcast?.({
          type: "thread.message",
          threadId,
          message: { role: "assistant", agent: out.agent, content: out.replyText, at: new Date().toISOString() }
        });
      } catch {}

      return okJson(res, {
        ok: true,
        threadId,
        agent: out.agent,
        replyText: out.replyText || "(no text)",
        proposal: savedProposal
      });
    } catch (e) {
      // Always 200 to avoid PS throwing
      return okJson(res, { ok: false, error: String(e?.message || e) });
    }
  });

  // ✅ Debug OpenAI (token-protected)
  // POST /api/debug/openai
  // headers: x-debug-token: <DEBUG_API_TOKEN>
  // body: { agent: "nova", message: "..." }
  r.post("/debug/openai", async (req, res) => {
    if (!requireDebugToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (missing/invalid x-debug-token)" });
    }

    try {
      const agent = String(req.body?.agent || "orion").trim();
      const message = String(req.body?.message || "ping").trim();

      const out = await debugOpenAI({ agent, message });
      // keep raw limited to avoid huge payloads
      const raw = String(out.raw || "");
      return okJson(res, {
        ok: Boolean(out.ok),
        status: out.status || null,
        agent: out.agent,
        extractedText: out.extractedText || "",
        raw: raw.slice(0, 4000)
      });
    } catch (e) {
      return okJson(res, { ok: false, error: String(e?.message || e) });
    }
  });

  return r;
}