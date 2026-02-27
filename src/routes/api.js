import express from "express";
import { kernelHandle, listAgents } from "../kernel/agentKernel.js";

function ok(res, data) {
  res.json({ ok: true, ...data });
}
function bad(res, message, code = 400) {
  res.status(code).json({ ok: false, error: message });
}

export function apiRouter({ db, wsHub }) {
  const r = express.Router();

  r.get("/", (_req, res) => ok(res, { service: "ai-hq-backend", endpoints: ["GET /agents","POST /chat","GET /threads","GET /threads/:id/messages","GET /proposals","POST /proposals/:id/approve","POST /proposals/:id/reject"] }));

  r.get("/agents", (_req, res) => ok(res, { agents: listAgents() }));

  // Threads
  r.get("/threads", async (_req, res) => {
    try {
      const q = await db.query(
        `select id, title, created_at
         from threads
         order by created_at desc
         limit 100`
      );
      ok(res, { threads: q.rows });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  r.post("/threads", async (req, res) => {
    const title = String(req.body?.title || "").trim() || "New thread";
    try {
      const q = await db.query(
        `insert into threads (title) values ($1) returning id, title, created_at`,
        [title]
      );
      ok(res, { thread: q.rows[0] });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  r.get("/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return bad(res, "threadId required");

    try {
      const q = await db.query(
        `select id, role, agent, content, meta, created_at
         from messages
         where thread_id = $1
         order by created_at asc
         limit 500`,
        [threadId]
      );
      ok(res, { messages: q.rows });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  // CEO Chat (MVP)
  r.post("/chat", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const agent = req.body?.agent ? String(req.body.agent).trim() : "";
    let threadId = req.body?.threadId ? String(req.body.threadId).trim() : "";

    if (!message) return bad(res, "message required");

    try {
      // ensure thread
      if (!threadId) {
        const t = await db.query(
          `insert into threads (title) values ($1) returning id`,
          [message.slice(0, 48)]
        );
        threadId = t.rows[0].id;
      }

      // store user msg
      const userMsg = await db.query(
        `insert into messages (thread_id, role, agent, content)
         values ($1,'user',null,$2)
         returning id, created_at`,
        [threadId, message]
      );

      const k = await kernelHandle({ message, agentHint: agent || undefined });

      // store assistant msg
      const assistantMsg = await db.query(
        `insert into messages (thread_id, role, agent, content, meta)
         values ($1,'assistant',$2,$3,$4)
         returning id, created_at`,
        [threadId, k.agent, k.replyText, JSON.stringify({ agentName: k.agentName })]
      );

      let proposalRow = null;

      if (k.proposal && typeof k.proposal === "object") {
        const type = String(k.proposal.type || "generic");
        const title = String(k.proposal.title || "").trim() || `${k.agentName} proposal`;
        const payload = k.proposal.payload && typeof k.proposal.payload === "object" ? k.proposal.payload : k.proposal;

        const p = await db.query(
          `insert into proposals (thread_id, agent, type, status, title, payload)
           values ($1,$2,$3,'pending',$4,$5)
           returning id, status, type, title, payload, created_at`,
          [threadId, k.agent, type, title, JSON.stringify(payload)]
        );
        proposalRow = p.rows[0];
      }

      // WS events
      wsHub?.broadcast?.({
        type: "chat.message",
        threadId,
        user: { id: userMsg.rows[0].id, role: "user", content: message, created_at: userMsg.rows[0].created_at },
        assistant: { id: assistantMsg.rows[0].id, role: "assistant", agent: k.agent, content: k.replyText, created_at: assistantMsg.rows[0].created_at },
        proposal: proposalRow
      });

      ok(res, {
        threadId,
        agent: k.agent,
        replyText: k.replyText,
        proposal: proposalRow
      });
    } catch (e) {
      bad(res, `error: ${String(e.message || e)}`, 500);
    }
  });

  // Proposals (approval flow)
  r.get("/proposals", async (req, res) => {
    const status = String(req.query?.status || "").trim();
    const where = status ? `where status = $1` : "";
    const args = status ? [status] : [];

    try {
      const q = await db.query(
        `select id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by
         from proposals
         ${where}
         order by created_at desc
         limit 200`,
        args
      );
      ok(res, { proposals: q.rows });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  r.post("/proposals/:id/approve", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const by = String(req.body?.by || "ceo").trim();

    try {
      const q = await db.query(
        `update proposals
         set status='approved', decided_at=now(), decision_by=$2
         where id=$1
         returning *`,
        [id, by]
      );

      const row = q.rows[0] || null;
      wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });

      ok(res, { proposal: row });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  r.post("/proposals/:id/reject", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const by = String(req.body?.by || "ceo").trim();

    try {
      const q = await db.query(
        `update proposals
         set status='rejected', decided_at=now(), decision_by=$2
         where id=$1
         returning *`,
        [id, by]
      );

      const row = q.rows[0] || null;
      wsHub?.broadcast?.({ type: "proposal.updated", proposal: row });

      ok(res, { proposal: row });
    } catch (e) {
      bad(res, `DB error: ${String(e.message || e)}`, 500);
    }
  });

  return r;
}