// src/routes/api/media.js
import express from "express";
import { okJson, clamp } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { togetherGenerateImage } from "../../services/togetherImage.js";

function pickDimsFromAspectRatio(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "9:16") return { width: 1080, height: 1920 };
  if (ar === "4:5") return { width: 1080, height: 1350 };
  return { width: 1080, height: 1080 };
}

export function mediaRoutes() {
  const r = express.Router();

  r.post("/media/image", async (req, res) => {
    const prompt = fixText(String(req.body?.prompt || "").trim());
    const n = clamp(req.body?.n ?? 1, 1, 4);

    const aspectRatio = String(req.body?.aspectRatio || "1:1").trim();
    const dims = pickDimsFromAspectRatio(aspectRatio);

    if (!prompt) {
      return okJson(res, { ok: false, error: "prompt required" });
    }

    try {
      const out = await togetherGenerateImage({
        prompt,
        n,
        width: req.body?.width || dims.width,
        height: req.body?.height || dims.height,
      });

      return okJson(res, {
        ok: true,
        url: out.url,
        model: out.usedModel,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  return r;
}