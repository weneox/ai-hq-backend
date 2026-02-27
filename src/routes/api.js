import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db/index.js";
import { makeAssistantProposal } from "../kernel/agentKernel.js";

export const api = express.Router();

// --- schemas
const CreateConversation = z.object({
  title: z.string().min(1).max(120).optional()
});

const SendMessage = z.object({
  text: z.string().min(1).max(5000)
});

// --- routes

api.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

api.post("/conversations", async (req, res) => {
  const body = CreateConversation.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const id = uuidv4();
  const title = body.data.title || "New conversation";
  await pool.query(`INSERT INTO conversations (id, title) VALUES ($1,$2)`, [id, title]);

  res.json({ ok: true, conversation: { id, title } });
});

api.get("/conversations", async (req, res) => {
  const r = await pool.query(`SELECT id, title, created_at FROM conversations ORDER BY created_at DESC LIMIT 50`);
  res.json({ ok: true, conversations: r.rows });
});

api.get("/conversations/:id/messages", async (req, res) => {
  const id = String(req.params.id || "");
  const r = await pool.query(
    `SELECT id, role, agent_key, content, meta, created_at
     FROM messages WHERE conversation_id=$1
     ORDER BY created_at ASC LIMIT 500`,
    [id]
  );
  res.json({ ok: true, messages: r.rows });
});

api.post("/conversations/:id/messages", async (req, res) => {
  const conversationId = String(req.params.id || "");
  const body = SendMessage.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  // store user message
  const userMsgId = uuidv4();
  await pool.query(
    `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1,$2,'user',$3)`,
    [userMsgId, conversationId, body.data.text]
  );

  // create assistant proposal (stub)
  const proposal = makeAssistantProposal({ conversationId, userText: body.data.text });

  // store proposal
  await pool.query(
    `INSERT INTO proposals (id, conversation_id, agent_key, type, payload, status)
     VALUES ($1,$2,$3,$4,$5,'proposed')`,
    [proposal.id, conversationId, proposal.agentKey, proposal.type, proposal.payload]
  );

  // for Phase 1 we also store the assistant message immediately
  // (Later we will require explicit approval before execution.)
  const assistantMsgId = uuidv4();
  await pool.query(
    `INSERT INTO messages (id, conversation_id, role, agent_key, content, meta)
     VALUES ($1,$2,'assistant',$3,$4,$5)`,
    [assistantMsgId, conversationId, proposal.agentKey, proposal.payload.text, { proposalId: proposal.id }]
  );

  res.json({
    ok: true,
    userMessageId: userMsgId,
    proposal,
    assistantMessageId: assistantMsgId
  });
});

api.get("/proposals", async (req, res) => {
  const r = await pool.query(
    `SELECT id, conversation_id, agent_key, type, payload, status, created_at, decided_at
     FROM proposals ORDER BY created_at DESC LIMIT 50`
  );
  res.json({ ok: true, proposals: r.rows });
});

api.post("/proposals/:id/decide", async (req, res) => {
  const id = String(req.params.id || "");
  const schema = z.object({ decision: z.enum(["approved", "rejected"]) });
  const body = schema.safeParse(req.body || {});
  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  await pool.query(`UPDATE proposals SET status=$1, decided_at=NOW() WHERE id=$2`, [body.data.decision, id]);
  res.json({ ok: true });
});