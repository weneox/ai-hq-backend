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

router.post("/render/generate", async (req, res) => {
  try {
    const templateId = clean(req.body?.templateId || "");
    const videoUrl = clean(req.body?.videoUrl || "");
    const voiceoverUrl = clean(req.body?.voiceoverUrl || "");
    const caption = clean(req.body?.caption || "");
    const cta = clean(req.body?.cta || "");
    const logoUrl = clean(req.body?.logoUrl || "");

    const render = await creatomateCreateRender({
      templateId,
      modifications: {
        video: videoUrl,
        voiceover: voiceoverUrl,
        caption,
        cta,
        logo: logoUrl,
      },
    });

    return res.json({
      ok: true,
      provider: "creatomate",
      renderId: render?.id || null,
      status: render?.status || null,
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