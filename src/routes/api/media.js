// src/routes/api/media.js
//
// FINAL v2.0 — Together image route for premium tech-scene pipeline
//
// Goals:
// ✅ Accept prompt
// ✅ Accept topic + visualPreset for stronger image direction
// ✅ Normalize aspect ratio / width / height
// ✅ Keep Together pipeline compatible with final togetherImage.js
// ✅ Return useful debug/meta fields for n8n / backend inspection

import express from "express";
import { okJson, clamp } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { togetherGenerateImage } from "../../services/togetherImage.js";

function clean(x) {
  return String(x || "").trim();
}

function normalizeAspectRatio(x) {
  const v = clean(x);
  if (v === "9:16" || v === "4:5" || v === "1:1") return v;
  return "1:1";
}

function normalizeVisualPreset(x) {
  const v = clean(x);
  if (
    v === "robotic_unit" ||
    v === "ai_core" ||
    v === "automation_device" ||
    v === "abstract_tech_scene"
  ) {
    return v;
  }
  return "";
}

function pickDimsFromAspectRatio(aspectRatio) {
  const ar = normalizeAspectRatio(aspectRatio);
  if (ar === "9:16") return { width: 1080, height: 1920 };
  if (ar === "4:5") return { width: 1080, height: 1350 };
  return { width: 1080, height: 1080 };
}

function positiveNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function mediaRoutes() {
  const r = express.Router();

  r.post("/media/image", async (req, res) => {
    const prompt = fixText(clean(req.body?.prompt));
    const topic = fixText(clean(req.body?.topic));
    const visualPreset = normalizeVisualPreset(req.body?.visualPreset);
    const n = clamp(req.body?.n ?? 1, 1, 4);

    const aspectRatio = normalizeAspectRatio(req.body?.aspectRatio || "1:1");
    const dims = pickDimsFromAspectRatio(aspectRatio);

    const width = positiveNum(req.body?.width, dims.width);
    const height = positiveNum(req.body?.height, dims.height);

    if (!prompt) {
      return okJson(res, { ok: false, error: "prompt required" });
    }

    try {
      const out = await togetherGenerateImage({
        prompt,
        topic,
        visualPreset,
        n,
        width,
        height,
        aspectRatio,
      });

      return okJson(res, {
        ok: true,
        url: out.url,
        urls: out.urls || [out.url],
        model: out.usedModel,
        aspectRatio,
        width,
        height,
        visualPreset: out?.meta?.visualPreset || visualPreset || null,
        topicFamily: out?.meta?.topicFamily || null,
        debug: {
          usedPrompt: out.usedPrompt,
          usedNegativePrompt: out.usedNegativePrompt,
          meta: out.meta || null,
        },
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "image_generation_failed",
        details: {
          message: String(e?.message || e),
        },
      });
    }
  });

  return r;
}