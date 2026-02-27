import express from "express";
import crypto from "crypto";
import { cfg } from "../config.js";
import { runDebate } from "../kernel/debateEngine.js";
import { kernelHandle, listAgents, debugOpenAI } from "../kernel/agentKernel.js";

/**
 * Always 200 JSON (PowerShell friendly)
 */
function okJson(res, payload) {
  return res.status(200).json(payload);
}

/**
 * Debug token check
 */
function requireDebugToken(req) {
  const expected = String(cfg.DEBUG_API_TOKEN || "").trim();
  if (!expected) return false;
  const token = String(req.headers["x-debug-token"] || req.query.token || "").trim();
  return Boolean(token) && token === expected;
}

/**
 * Detect DB availability
 */
function isDbReady(db) {
  return Boolean(db && typeof db.query === "function");
}

/**
 * Error serializer (includes AggregateError details)
 */
function serializeError(err) {
  const e = err || {};
  const isAgg = e && (e.name === "AggregateError" || Array.isArray(e.errors));

  const base = {
    name: e.name || "Error",
    message: e.message || String(e),
    stack: e.stack || null,
  };

  if (isAgg) {
    base.errors = (e.errors || []).map((x) => ({
      name: x?.name || "Error",
      message: x?.message || String(x),
      stack: x?.stack || null,
    }));
  }

  if (e.cause) {
    base.cause = {
      name: e.cause?.name,
      message: e.cause?.message || String(e.cause),
      stack: e.cause?.stack || null,
    };
  }

  return base;
}

/**
 * In-memory fallback store (only used when DB is OFF)
 * NOTE: resets on server restart (dev-friendly)
 */
const mem = {
  threads: new Map(), // threadId -> { id, title, created_at }
  messages: new Map(), // threadId -> array of messages
  proposals: new Map(), // proposalId -> proposal row
};

function memEnsureThread(threadId, title) {
  if (!mem.threads.has(threadId)) {
    mem.threads.set(threadId, {
      id: threadId,
      title: title || `Thread ${new Date().toISOString()}`,
      created_at: new Date().toISOString(),
    });
  }
  if (!mem.messages.has(threadId)) mem.messages.set(threadId, []);
  return mem.threads.get(threadId);
}

function memAddMessage(threadId, { role, agent, content, meta }) {
  memEnsureThread(threadId);
  const arr = mem.messages.get(threadId);
  const row = {
    id: crypto.randomUUID(),
    thread_id: threadId,
    role,
    agent: agent || null,
    content: content || "",
    meta: meta || {},
    created_at: new Date().toISOString(),
  };
  arr.push(row);
  return row;
}

function memCreateProposal(threadId, { agent, type, title, payload }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    thread_id: threadId,
    agent: agent || "orion",
    type: type || "generic",
    status: "pending",
    title: title || "",
    payload: payload || {},
    created_at: new Date().toISOString(),
    decided_at: null,
    decision_by: null,
  };
  mem.proposals.set(id, row);
  return row;
}

function memListProposals(status = "pending") {
  const out = [];
  for (const p of mem.proposals.values()) {
    if (String(p.status) === String(status)) out.push(p);
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, 100);
}

export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  // Root
  r.get("/", (_req, res) =>
    okJson(res, {
      ok: true,
      service: "ai-hq-backend",
      db: { enabled: isDbReady(db) },
      endpoints: [
        "GET /api",
        "GET /api/agents",
        "POST /api/chat",
        "POST /api/debate",
        "GET /api/threads/:id/messages",
        "GET /api/proposals?status=pending",
        "POST /api/proposals/:id/decision",
        "POST /api/debug/openai (token)",
      ],
    })
  );

  // Agents
  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));

  // Messages by thread
  r.get("/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "thread id required" });

    try {
      if (!isDbReady(db)) {
        const messages = mem.messages.get(threadId) || [];
        return okJson(res, { ok: true, threadId, messages, dbDisabled: true });
      }

      const q = await db.query(
        `select id, thread_id, role, agent, content, meta, created_at
         from messages
         where thread_id = $1
         order by created_at asc`,
        [threadId]
      );

      return okJson(res, { ok: true, threadId, messages: q.rows || [] });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/threads/:id/messages] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  // Proposals list
  r.get("/proposals", async (req, res) => {
    const status = String(req.query.status || "pending").trim();

    try {
      if (!isDbReady(db)) {
        const proposals = memListProposals(status);
        return okJson(res, { ok: true, status, proposals, dbDisabled: true });
      }

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
      const details = serializeError(e);
      console.error("[api/proposals] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
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
      // DB OFF fallback
      if (!isDbReady(db)) {
        const row = mem.proposals.get(id);
        if (!row) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        row.status = decision;
        row.decided_at = new Date().toISOString();
        row.decision_by = by;

        try {
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
        } catch {}

        return okJson(res, { ok: true, proposal: row, dbDisabled: true });
      }

      const q = await db.query(
        `update proposals
         set status = $1, decided_at = now(), decision_by = $2
         where id = $3
         returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
        [decision, by, id]
      );

      const row = q.rows?.[0];
      if (!row) return okJson(res, { ok: false, error: "proposal not found" });

      try {
        wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
      } catch {}

      return okJson(res, { ok: true, proposal: row });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/proposals/:id/decision] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  // Chat
  r.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      // ---- DB OFF MODE (in-memory) ----
      if (!isDbReady(db)) {
        memEnsureThread(threadId);

        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: {} });

        const out = await kernelHandle({ message, agentHint: agent || undefined });

        memAddMessage(threadId, {
          role: "assistant",
          agent: out.agent || null,
          content: out.replyText || "",
          meta: {},
        });

        let savedProposal = null;
        if (out.proposal && typeof out.proposal === "object") {
          const p = out.proposal || {};
          savedProposal = memCreateProposal(threadId, {
            agent: out.agent || "orion",
            type: String(p.type || "generic"),
            title: String(p.title || ""),
            payload: p.payload || {},
          });

          try {
            wsHub?.broadcast?.({ type: "proposal.created", proposal: savedProposal });
          } catch {}
        }

        try {
          wsHub?.broadcast?.({
            type: "thread.message",
            threadId,
            message: {
              role: "assistant",
              agent: out.agent,
              content: out.replyText,
              at: new Date().toISOString(),
            },
          });
        } catch {}

        return okJson(res, {
          ok: true,
          threadId,
          agent: out.agent,
          replyText: out.replyText || "(no text)",
          proposal: savedProposal,
          dbDisabled: true,
        });
      }

      // ---- DB ON MODE (Postgres) ----
      if (!threadIdIn) {
        const t = await db.query(`insert into threads (title) values ($1) returning id`, [
          `Thread ${new Date().toISOString()}`,
        ]);
        threadId = t.rows?.[0]?.id || threadId;
      }

      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1, 'user', $2, $3, $4)`,
        [threadId, agent || null, message, {}]
      );

      const out = await kernelHandle({ message, agentHint: agent || undefined });

      await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1, 'assistant', $2, $3, $4)`,
        [threadId, out.agent || null, out.replyText || "", {}]
      );

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

      try {
        wsHub?.broadcast?.({
          type: "thread.message",
          threadId,
          message: { role: "assistant", agent: out.agent, content: out.replyText, at: new Date().toISOString() },
        });
      } catch {}

      return okJson(res, {
        ok: true,
        threadId,
        agent: out.agent,
        replyText: out.replyText || "(no text)",
        proposal: savedProposal,
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/chat] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  // ✅ Debate (multi-agent internal discussion -> final answer -> proposal pending)
  r.post("/debate", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim(); // optional owner/hint
    const threadIdIn = String(req.body?.threadId || "").trim();
    const rounds = Number(req.body?.rounds || 2);
    const mode = String(req.body?.mode || "proposal").trim(); // default proposal
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : ["orion", "nova", "atlas", "echo"];

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      // Save user message into thread (so you can see history)
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: { kind: "debate" } });
      } else {
        if (!threadIdIn) {
          const t = await db.query(`insert into threads (title) values ($1) returning id`, [
            `Thread ${new Date().toISOString()}`,
          ]);
          threadId = t.rows?.[0]?.id || threadId;
        }
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1, 'user', $2, $3, $4)`,
          [threadId, agent || null, message, { kind: "debate" }]
        );
      }

      const out = await runDebate({
        message,
        agents,
        rounds: Math.max(1, Math.min(3, rounds)),
        mode,
      });

      // Save assistant synthesis message
      const synthesisText = String(out.finalAnswer || "").trim();

      if (!isDbReady(db)) {
        memAddMessage(threadId, {
          role: "assistant",
          agent: "kernel",
          content: synthesisText,
          meta: { kind: "debate.synthesis" },
        });
      } else {
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1, 'assistant', $2, $3, $4)`,
          [threadId, "kernel", synthesisText, { kind: "debate.synthesis" }]
        );
      }

      // If we have a proposal object, persist it as pending (so CEO can approve)
      let savedProposal = null;

      if (out.proposal && typeof out.proposal === "object") {
        const p = out.proposal || {};
        const type = String(p.type || "plan");
        const title = String(p.title || "Debate Proposal");
        const payload = p.payload || p || {};

        if (!isDbReady(db)) {
          savedProposal = memCreateProposal(threadId, {
            agent: "kernel",
            type,
            title,
            payload,
          });
        } else {
          const ins = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1, $2, $3, 'pending', $4, $5)
             returning id, thread_id, agent, type, status, title, payload, created_at`,
            [threadId, "kernel", type, title, payload]
          );
          savedProposal = ins.rows?.[0] || null;
        }

        try {
          wsHub?.broadcast?.({ type: "proposal.created", proposal: savedProposal });
        } catch {}
      }

      return okJson(res, {
        ok: true,
        threadId,
        finalAnswer: synthesisText,
        agentNotes: out.agentNotes || [],
        proposal: savedProposal,
        dbDisabled: !isDbReady(db),
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/debate] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  // Debug OpenAI (token-protected)
  r.post("/debug/openai", async (req, res) => {
    if (!requireDebugToken(req)) {
      return okJson(res, { ok: false, error: "forbidden (missing/invalid x-debug-token)" });
    }

    try {
      const agent = String(req.body?.agent || "orion").trim();
      const message = String(req.body?.message || "ping").trim();

      const out = await debugOpenAI({ agent, message });
      const raw = String(out.raw || "");

      return okJson(res, {
        ok: Boolean(out.ok),
        status: out.status || null,
        agent: out.agent,
        extractedText: out.extractedText || "",
        raw: raw.slice(0, 4000),
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/debug/openai] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  return r;
}