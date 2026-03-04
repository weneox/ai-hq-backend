import express from "express";
import { okJson } from "../../utils/http.js";
import { listAgents } from "../../kernel/agentKernel.js";

export function agentsRoutes() {
  const r = express.Router();
  r.get("/agents", (_req, res) => okJson(res, { ok: true, agents: listAgents() }));
  return r;
}