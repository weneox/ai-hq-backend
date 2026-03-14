// src/routes/api/media/video.js
//
// FINAL v2.0 — Runway video routes
//
// Endpoints:
//   POST /api/media/video/generate
//   POST /api/media/video/runway
//   GET  /api/media/video/status/:taskId
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

function normalizeAspectRatio(input) {
  const x = clean(input);
  if (x === "9:16") return "720:1280";
  if (x === "16:9") return "1280:720";
  if (x === "1:1") return "1080:1080";
  if (x === "4:5") return "864:1080";
  if (
    x === "720:1280" ||
    x === "1280:720" ||
    x === "1080:1080" ||
    x === "864:1080"
  ) {
    return x;
  }
  return "720:1280";
}

function normalizeDuration(v) {
  return Math.max(2, Math.min(10, positiveNum(v, 5)));
}

function buildOkTask(result, extra = {}) {
  return {
    ok: true,
    provider: "runway",
    taskId: result?.id || result?.taskId || extra.taskId || null,
    status: result?.status || extra.status || "PENDING",
    videoUrl: pickRunwayVideoUrl(result) || null,
    raw: result,
  };
}

async function createTaskFromBody(body = {}) {
  const promptText = clean(
    body?.promptText ||
      body?.prompt ||
      body?.videoPrompt ||
      body?.video_prompt ||
      body?.contentPack?.videoPrompt ||
      body?.contentPack?.video_prompt ||
      ""
  );

  const promptImage = clean(
    body?.promptImage ||
      body?.imageUrl ||
      body?.image_url ||
      body?.contentPack?.imageUrl ||
      body?.contentPack?.image_url ||
      body?.contentPack?.coverUrl ||
      ""
  );

  const duration = normalizeDuration(body?.duration);
  const ratio = normalizeAspectRatio(
    body?.aspectRatio ||
      body?.aspect_ratio ||
      body?.ratio ||
      body?.contentPack?.aspectRatio ||
      body?.contentPack?.aspect_ratio ||
      "9:16"
  );

  if (!promptText) {
    throw new Error("promptText is required");
  }

  return runwayCreateVideoTask({
    promptText,
    ratio,
    duration,
    seed: body?.seed,
    promptImage,
  });
}

router.post("/video/generate", async (req, res) => {
  try {
    const result = await createTaskFromBody(req.body || {});
    return res.json(buildOkTask(result));
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

router.post("/video/runway", async (req, res) => {
  try {
    const result = await createTaskFromBody(req.body || {});
    return res.json(buildOkTask(result));
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

router.get("/video/status/:taskId", async (req, res) => {
  try {
    const result = await runwayGetTask(req.params.taskId);
    return res.json(buildOkTask(result, { taskId: req.params.taskId }));
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
    return res.json(buildOkTask(result, { taskId: req.params.taskId }));
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

export default router;