import express from "express";
import { okJson, clamp } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { togetherGenerateImage } from "../../services/togetherImage.js";

export function mediaRoutes() {
  const r = express.Router();

  r.post("/media/image", async (req, res) => {
    const prompt = fixText(String(req.body?.prompt || "").trim());
    const n = clamp(req.body?.n ?? 1, 1, 4);

    if (!prompt) return okJson(res, { ok: false, error: "prompt required" });

    try {
      const out = await togetherGenerateImage({ prompt, n });
      return okJson(res, { ok: true, url: out.url });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  return r;
}