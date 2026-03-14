import express from "express";
import {
  creatomateCreateRender,
  creatomateGetRender,
  pickCreatomateRenderUrl,
} from "../../../services/media/creatomateRender.js";

const router = express.Router();

function clean(x) {
  return String(x || "").trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = clean(v);
    if (s) return s;
  }
  return "";
}

function buildRenderMods(body = {}) {
  const contentPack = body?.contentPack && typeof body.contentPack === "object"
    ? body.contentPack
    : {};

  const videoUrl = firstNonEmpty(
    body?.videoUrl,
    body?.video_url,
    body?.renderUrl,
    body?.render_url,
    contentPack?.videoUrl,
    contentPack?.video_url,
    contentPack?.renderUrl,
    contentPack?.render_url
  );

  const voiceoverUrl = firstNonEmpty(
    body?.voiceoverUrl,
    body?.voiceover_url,
    body?.audioUrl,
    body?.audio_url,
    contentPack?.voiceoverUrl,
    contentPack?.voiceover_url
  );

  const caption = firstNonEmpty(
    body?.caption,
    contentPack?.caption,
    contentPack?.copy?.caption,
    contentPack?.post?.caption
  );

  const cta = firstNonEmpty(
    body?.cta,
    contentPack?.cta,
    contentPack?.post?.cta
  );

  const logoUrl = firstNonEmpty(
    body?.logoUrl,
    body?.logo_url,
    contentPack?.logoUrl,
    contentPack?.logo_url
  );

  const headline = firstNonEmpty(
    body?.headline,
    body?.title,
    contentPack?.title,
    contentPack?.headline,
    contentPack?.hook
  );

  return {
    video: videoUrl,
    voiceover: voiceoverUrl,
    caption,
    cta,
    logo: logoUrl,
    headline,
  };
}

router.post("/render/generate", async (req, res) => {
  try {
    const templateId = clean(req.body?.templateId || "");
    const modifications = buildRenderMods(req.body || {});
    const render = await creatomateCreateRender({
      templateId,
      modifications,
    });

    return res.json({
      ok: true,
      provider: "creatomate",
      renderId: render?.id || null,
      status: render?.status || null,
      url: pickCreatomateRenderUrl(render) || null,
      raw: render,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

router.get("/render/status/:renderId", async (req, res) => {
  try {
    const render = await creatomateGetRender(req.params.renderId);
    const url = pickCreatomateRenderUrl(render);

    return res.json({
      ok: true,
      provider: "creatomate",
      renderId: req.params.renderId,
      status: render?.status || null,
      url: url || null,
      raw: render,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

router.get("/render/:renderId", async (req, res) => {
  try {
    const render = await creatomateGetRender(req.params.renderId);
    const url = pickCreatomateRenderUrl(render);

    return res.json({
      ok: true,
      provider: "creatomate",
      renderId: req.params.renderId,
      status: render?.status || null,
      url: url || null,
      raw: render,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

export default router;