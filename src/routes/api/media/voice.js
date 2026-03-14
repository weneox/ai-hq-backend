import express from "express";
import { elevenlabsGenerateSpeech } from "../../../services/media/elevenlabsVoice.js";
import { cloudinaryUploadFromUrl } from "../../../services/media/cloudinaryUpload.js";

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
    const text = clean(req.body?.text || req.body?.voiceoverText || "");
    const voiceId = clean(req.body?.voiceId || "");
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

    const dataUri = `data:${out.mimeType};base64,${out.buffer.toString("base64")}`;

    const uploaded = await cloudinaryUploadFromUrl({
      sourceUrl: dataUri,
      db: req.app?.locals?.db || null,
      tenantKey,
      folder: [tenantKey || "public", "voiceovers"].join("/"),
      resourceType: "video",
      tags: ["voiceover", tenantKey || "public"],
      context: {
        tenantKey: tenantKey || "",
        provider: "elevenlabs",
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