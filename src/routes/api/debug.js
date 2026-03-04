import express from "express";
import { okJson } from "../../utils/http.js";
import { requireDebugToken } from "../../utils/auth.js";
import { debugOpenAI } from "../../kernel/agentKernel.js";

export function debugRoutes() {
  const r = express.Router();

  // POST /api/debug/openai  (token-protected)
  r.post("/debug/openai", async (req, res) => {
    if (!requireDebugToken(req)) return okJson(res, { ok: false, error: "forbidden (invalid debug token)" });

    try {
      const out = await debugOpenAI();
      return okJson(res, { ok: true, out });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}