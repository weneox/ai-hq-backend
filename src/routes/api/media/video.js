// src/routes/api/media/video.js
//
// FINAL v1.1 — Runway video task routes
//
// Mounted from:
//   mediaRoutes() => r.use("/media", videoRouter)
// Final endpoints:
//   POST /api/media/video/runway
//   GET  /api/media/video/runway/:taskId

import express from "express";
import {
  runwayCreateVideoTask,
  runwayGetTask,
  pickRunwayVideoUrl,
} from "../../../services/media/runwayVideo.js";

const router = express.Router();

function clean(s) {
  return String(s || "").trim();
}

function positiveNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

router.post("/video/runway", async (req, res) => {
  try {
    const promptText = clean(req.body?.promptText || req.body?.prompt || "");
    const duration = positiveNum(req.body?.duration, 5);

    if (!promptText) {
      return res.status(400).json({
        ok: false,
        error: "promptText is required",
      });
    }

    const result = await runwayCreateVideoTask({
      promptText,
      ratio: "720:1280",
      duration,
      seed: req.body?.seed,
    });

    return res.json({
      ok: true,
      provider: "runway",
      taskId: result?.id || result?.taskId || null,
      status: result?.status || "PENDING",
      raw: result,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

router.get("/video/runway/:taskId", async (req, res) => {
  try {
    const result = await runwayGetTask(req.params.taskId);
    const videoUrl = pickRunwayVideoUrl(result);

    return res.json({
      ok: true,
      provider: "runway",
      taskId: req.params.taskId,
      status: result?.status || null,
      videoUrl: videoUrl || null,
      raw: result,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

export default router;