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

function normalizeAspectRatio(x) {
  const v = String(x || "").trim();
  if (v === "9:16" || v === "4:5" || v === "1:1") return v;
  return "1:1";
}

export function mediaRoutes() {
  const r = express.Router();

  r.post("/media/image", async (req, res) => {
    const prompt = fixText(String(req.body?.prompt || "").trim());
    const n = clamp(req.body?.n ?? 1, 1, 4);
    const aspectRatio = normalizeAspectRatio(req.body?.aspectRatio || "1:1");
    const dims = pickDimsFromAspectRatio(aspectRatio);

    const width =
      Number(req.body?.width) > 0 ? Number(req.body.width) : dims.width;
    const height =
      Number(req.body?.height) > 0 ? Number(req.body.height) : dims.height;

    if (!prompt) {
      return okJson(res, { ok: false, error: "prompt required" });
    }

    try {
      const out = await togetherGenerateImage({
        prompt,
        n,
        width,
        height,
        aspectRatio,
      });

      return okJson(res, {
        ok: true,
        url: out.url,
        model: out.usedModel,
        aspectRatio,
        width,
        height,
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