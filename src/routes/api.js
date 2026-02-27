// src/routes/api.js (FINAL)
import express from "express";
import crypto from "crypto";
import { cfg } from "../config.js";
import { runDebate, DEBATE_ENGINE_VERSION } from "../kernel/debateEngine.js";
import { kernelHandle, listAgents, debugOpenAI } from "../kernel/agentKernel.js";
import { postToN8n } from "../utils/n8n.js";

function okJson(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(payload);
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function requireDebugToken(req) {
  const expected = String(cfg.DEBUG_API_TOKEN || "").trim();
  if (!expected) return false;
  const token = String(req.headers["x-debug-token"] || req.query.token || "").trim();
  return Boolean(token) && token === expected;
}

function isDbReady(db) {
  return Boolean(db && typeof db.query === "function");
}

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

const mem = {
  threads: new Map(),
  messages: new Map(),
  proposals: new Map(),
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

function notifyN8n(event, proposal, extra = {}) {
  const url = String(cfg.N8N_WEBHOOK_URL || "").trim();
  if (!url) return;

  const payload = {
    event,
    proposalId: proposal?.id,
    threadId: proposal?.thread_id,
    by: proposal?.decision_by || extra.by || "unknown",
    decidedAt: proposal?.decided_at || null,
    proposal,
    ...extra,
  };

  postToN8n({
    url,
    token: String(cfg.N8N_WEBHOOK_TOKEN || "").trim(),
    timeoutMs: Number(cfg.N8N_TIMEOUT_MS || 10_000),
    payload,
  })
    .then((r) => console.log(`[n8n] ${event} →`, r.ok, r.status || r.error, (r.text || "").slice(0, 120)))
    .catch((e) => console.log("[n8n] error", String(e?.message || e)));
}

function fallbackSynthesisFromNotes(out) {
  const notes = Array.isArray(out?.agentNotes) ? out.agentNotes : [];
  const parts = [];
  for (const n of notes) {
    const t = String(n?.text || "").trim();
    if (!t) continue;
    parts.push(`### ${n.agentId}\n${t}`);
  }
  return parts.join("\n\n").trim();
}

export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  r.get("/", (_req, res) =>
    okJson(res, {
      ok: true,
      service: "ai-hq-backend",
      db: { enabled: isDbReady(db) },
      debateEngine: DEBATE_ENGINE_VERSION,
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

  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));

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

  r.post("/proposals/:id/decision", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const decision = String(req.body?.decision || "").trim(); // approved|rejected
    const by = String(req.body?.by || "ceo").trim();
    const reason = String(req.body?.reason || "").trim();

    if (!id) return okJson(res, { ok: false, error: "proposal id required" });
    if (decision !== "approved" && decision !== "rejected") {
      return okJson(res, { ok: false, error: 'decision must be "approved" or "rejected"' });
    }

    try {
      if (!isDbReady(db)) {
        const row = mem.proposals.get(id);
        if (!row) return okJson(res, { ok: false, error: "proposal not found", dbDisabled: true });

        row.status = decision;
        row.decided_at = new Date().toISOString();
        row.decision_by = by;

        try {
          wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });
        } catch {}

        notifyN8n(decision === "approved" ? "proposal.approved" : "proposal.rejected", row, {
          by,
          reason: decision === "rejected" ? reason : undefined,
          dbDisabled: true,
        });

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

      notifyN8n(decision === "approved" ? "proposal.approved" : "proposal.rejected", row, {
        by,
        reason: decision === "rejected" ? reason : undefined,
        dbDisabled: false,
      });

      return okJson(res, { ok: true, proposal: row });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/proposals/:id/decision] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  r.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: {} });

        const out = await kernelHandle({ message, agentHint: agent || undefined });

        memAddMessage(threadId, { role: "assistant", agent: out.agent || null, content: out.replyText || "", meta: {} });

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
          proposal: null,
          dbDisabled: true,
        });
      }

      if (!threadIdIn) {
        const t = await db.query(`insert into threads (title) values ($1) returning id`, [`Thread ${new Date().toISOString()}`]);
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

      try {
        wsHub?.broadcast?.({
          type: "thread.message",
          threadId,
          message: { role: "assistant", agent: out.agent, content: out.replyText, at: new Date().toISOString() },
        });
      } catch {}

      return okJson(res, { ok: true, threadId, agent: out.agent, replyText: out.replyText || "(no text)", proposal: null });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/chat] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

  r.post("/debate", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = String(req.body?.agent || "").trim();
    const threadIdIn = String(req.body?.threadId || "").trim();
    const rounds = clamp(req.body?.rounds ?? 2, 1, 3);

    let mode = String(req.body?.mode || "proposal").trim().toLowerCase();
    if (mode !== "proposal" && mode !== "answer") mode = "proposal";

    let agents = Array.isArray(req.body?.agents) ? req.body.agents : ["orion", "nova", "atlas", "echo"];
    agents = agents.map((x) => String(x || "").trim()).filter(Boolean);
    if (agents.length === 0) agents = ["orion", "nova", "atlas", "echo"];

    if (!message) return okJson(res, { ok: false, error: "message required" });

    let threadId = threadIdIn || crypto.randomUUID();

    try {
      console.log("[api/debate] start", { engine: DEBATE_ENGINE_VERSION, mode, rounds, agents });

      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: agent || null, content: message, meta: { kind: "debate" } });
      } else {
        if (!threadIdIn) {
          const t = await db.query(`insert into threads (title) values ($1) returning id`, [`Thread ${new Date().toISOString()}`]);
          threadId = t.rows?.[0]?.id || threadId;
        }
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1, 'user', $2, $3, $4)`,
          [threadId, agent || null, message, { kind: "debate" }]
        );
      }

      const out = await runDebate({ message, agents, rounds, mode });

      let synthesisText = String(out.finalAnswer || "").trim();

      // ✅ if empty, build fallback from agent notes (should not be empty now, but keep)
      if (!synthesisText) synthesisText = fallbackSynthesisFromNotes(out);

      // persist synthesis message
      if (!isDbReady(db)) {
        memAddMessage(threadId, { role: "assistant", agent: "kernel", content: synthesisText, meta: { kind: "debate.synthesis" } });
      } else {
        await db.query(
          `insert into messages (thread_id, role, agent, content, meta)
           values ($1, 'assistant', $2, $3, $4)`,
          [threadId, "kernel", synthesisText, { kind: "debate.synthesis" }]
        );
      }

      let savedProposal = null;
      if (out.proposal && typeof out.proposal === "object") {
        const p = out.proposal || {};
        const type = String(p.type || "plan");
        const title = String(p.title || "Debate Proposal");
        const payload = p.payload || p || {};

        if (!isDbReady(db)) {
          savedProposal = memCreateProposal(threadId, { agent: "kernel", type, title, payload });
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

      const debug = {
        engineVersion: DEBATE_ENGINE_VERSION,
        mode,
        rounds,
        agents,
        synthesisLen: synthesisText.length,
        hasProposal: Boolean(savedProposal),
        agentLens: (out.agentNotes || []).map((x) => ({
          agentId: x.agentId,
          len: String(x.text || "").length,
        })),
      };

      console.log("[api/debate] done", debug);

      return okJson(res, {
        ok: true,
        threadId,
        finalAnswer: synthesisText,
        agentNotes: out.agentNotes || [],
        proposal: savedProposal,
        dbDisabled: !isDbReady(db),
        debug,
      });
    } catch (e) {
      const details = serializeError(e);
      console.error("[api/debate] ERROR", details);
      return okJson(res, { ok: false, error: details.name, details });
    }
  });

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