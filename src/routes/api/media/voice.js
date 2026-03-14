import express from "express";
import { elevenlabsGenerateSpeech } from "../../../services/media/elevenlabsVoice.js";
import { cloudinaryUploadBuffer } from "../../../services/media/cloudinaryUpload.js";

const router = express.Router();

function clean(x) {
  return String(x || "").trim();
}

function lower(x) {
  return clean(x).toLowerCase();
}

function getTenantKey(req) {
  return lower(
    req?.auth?.tenantKey ||
      req?.auth?.tenant_key ||
      req?.body?.tenantKey ||
      req?.body?.tenant_key ||
      req?.query?.tenantKey ||
      req?.query?.tenant_key ||
      req?.headers?.["x-tenant-key"] ||
      ""
  );
}

router.post("/voice/generate", async (req, res) => {
  try {
    const text = clean(
      req.body?.text ||
        req.body?.voiceoverText ||
        req.body?.voiceover_text ||
        ""
    );
    const voiceId = clean(req.body?.voiceId || req.body?.voice_id || "");
    const tenantKey = getTenantKey(req);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "text is required",
      });
    }

    const out = await elevenlabsGenerateSpeech({
      text,
      voiceId,
    });

    const uploaded = await cloudinaryUploadBuffer({
      buffer: out.buffer,
      filename: `voiceover-${Date.now()}.${out.ext || "mp3"}`,
      mimeType: out.mimeType || "audio/mpeg",
      db: req.app?.locals?.db || null,
      tenantKey,
      folder: [tenantKey || "public", "voiceovers"].join("/"),
      publicId: "",
      resourceType: "video",
      tags: ["voiceover", "elevenlabs", tenantKey || "public"],
      context: {
        tenantKey: tenantKey || "",
        provider: "elevenlabs",
        kind: "voiceover",
      },
    });

    return res.json({
      ok: true,
      provider: "elevenlabs",
      voiceId: out.voiceId,
      modelId: out.modelId,
      mimeType: out.mimeType,
      bytes: out.bytes,
      url: uploaded.url,
      upload: uploaded,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

export default router;