import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { cfg } from "../../config.js";
import { okJson } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { baseUrl } from "../../utils/url.js";
import { renderSlidesToPng } from "../../render/renderSlides.js";

export function renderRoutes() {
  const r = express.Router();

  r.post("/render/slides", async (req, res) => {
    const slides = req.body?.slides || req.body?.contentPack?.slides || null;
    const tenantId = fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim());

    if (!Array.isArray(slides) || slides.length === 0) {
      return okJson(res, { ok: false, error: "slides[] required" });
    }

    try {
      const base = baseUrl();
      if (!base) return okJson(res, { ok: false, error: "PUBLIC_BASE_URL required for assets URLs" });

      const renderId = crypto.randomUUID();
      const outDir = path.resolve(process.cwd(), "uploads", "renders", tenantId, renderId);
      fs.mkdirSync(outDir, { recursive: true });

      const assets = await renderSlidesToPng({ slides, outDir, publicBaseUrl: base });
      return okJson(res, { ok: true, renderId, assets });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}