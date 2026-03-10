// src/routes/api/media.js
//
// FINAL v3.0 — media gateway
//
// Goals:
// ✅ Keep /api/media/image working
// ✅ Keep /api/media/video/runway + status working
// ✅ Add /api/media/upload
// ✅ Add /api/media/carousel/render
// ✅ Tenant-aware image credentials
// ✅ Tenant-aware Cloudinary upload fallback
// ✅ Single media router entrypoint

import express from "express";
import path from "path";
import { okJson, clamp } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { togetherGenerateImage } from "../../services/togetherImage.js";
import { cloudinaryUploadFromUrl } from "../../services/media/cloudinaryUpload.js";
import { renderSlidesToPng } from "../../render/renderSlides.js";
import videoRouter from "./media/video.js";

function clean(x) {
  return String(x || "").trim();
}

function lower(x) {
  return clean(x).toLowerCase();
}

function getAuthTenantKey(req) {
  return lower(
    req?.auth?.tenantKey ||
      req?.auth?.tenant_key ||
      req?.user?.tenantKey ||
      req?.user?.tenant_key ||
      req?.tenant?.key ||
      req?.tenantKey ||
      req?.query?.tenantKey ||
      req?.query?.tenant_key ||
      req?.body?.tenantKey ||
      req?.body?.tenant_key ||
      req?.headers?.["x-tenant-key"] ||
      ""
  );
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

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeSlidesInput(slides = [], fallback = {}) {
  return arr(slides)
    .map((slide, i) => {
      const x = isObject(slide) ? slide : {};
      const aspectRatio = normalizeAspectRatio(
        x.aspectRatio || x?.visualMeta?.aspectRatio || fallback.aspectRatio || "1:1"
      );

      return {
        title: clean(x.title || x.headline || x.text || `Slide ${i + 1}`),
        subtitle: clean(x.subtitle || x.subline || x.kicker || ""),
        cta: clean(x.cta || fallback.cta || ""),
        badge: clean(x.badge || fallback.badge || "BRAND"),
        align: clean(x.align || fallback.align || "left"),
        theme: clean(x.theme || fallback.theme || "premium_dark"),
        slideNumber: Number(x.slideNumber || i + 1),
        totalSlides: Number(x.totalSlides || slides.length || 1),
        bgImageUrl: clean(
          x.bgImageUrl ||
            x.backgroundUrl ||
            x.imageUrl ||
            x.image_url ||
            x.url ||
            ""
        ),
        logoText: clean(
          x.logoText || x.brandName || fallback.logoText || fallback.brandName || "BRAND"
        ),
        language: lower(x.language || x.lang || fallback.language || "az") || "az",
        aspectRatio,
        renderHints: {
          layoutFamily:
            clean(x?.renderHints?.layoutFamily || fallback?.renderHints?.layoutFamily) ||
            "editorial_left",
          textPosition:
            clean(x?.renderHints?.textPosition || x.align || fallback?.renderHints?.textPosition) ||
            "left",
          safeArea:
            clean(x?.renderHints?.safeArea || fallback?.renderHints?.safeArea) ||
            "left-heavy",
          overlayStrength:
            clean(
              x?.renderHints?.overlayStrength || fallback?.renderHints?.overlayStrength
            ) || "medium",
          focalBias:
            clean(x?.renderHints?.focalBias || fallback?.renderHints?.focalBias) || "right",
        },
      };
    })
    .filter((x) => x.title);
}

export function mediaRoutes({ db } = {}) {
  const r = express.Router();

  // =========================
  // IMAGE
  // POST /api/media/image
  // =========================
  r.post("/media/image", async (req, res) => {
    const prompt = fixText(clean(req.body?.prompt));
    const topic = fixText(clean(req.body?.topic));
    const visualPreset = normalizeVisualPreset(req.body?.visualPreset);
    const n = clamp(req.body?.n ?? 1, 1, 4);

    const aspectRatio = normalizeAspectRatio(req.body?.aspectRatio || "1:1");
    const dims = pickDimsFromAspectRatio(aspectRatio);

    const width = positiveNum(req.body?.width, dims.width);
    const height = positiveNum(req.body?.height, dims.height);

    const tenantKey = getAuthTenantKey(req);

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
        db,
        tenantKey,
      });

      return okJson(res, {
        ok: true,
        url: out.url,
        urls: out.urls || [out.url],
        model: out.usedModel,
        aspectRatio,
        width,
        height,
        tenantKey: tenantKey || null,
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

  // =========================
  // UPLOAD
  // POST /api/media/upload
  // body:
  // {
  //   sourceUrl,
  //   folder?,
  //   publicId?,
  //   resourceType?, // image | video | raw
  //   tags?,
  //   context?,
  //   tenantKey?
  // }
  // =========================
  r.post("/media/upload", async (req, res) => {
    try {
      const tenantKey = getAuthTenantKey(req);

      const sourceUrl = clean(req.body?.sourceUrl || req.body?.url || "");
      const folder = clean(req.body?.folder || "");
      const publicId = clean(req.body?.publicId || req.body?.public_id || "");
      const resourceType = clean(req.body?.resourceType || "image") || "image";
      const tags = arr(req.body?.tags).map(clean).filter(Boolean);
      const context = isObject(req.body?.context) ? req.body.context : {};

      if (!sourceUrl) {
        return okJson(res, { ok: false, error: "sourceUrl required" });
      }

      const out = await cloudinaryUploadFromUrl({
        sourceUrl,
        db,
        tenantKey,
        folder,
        publicId,
        resourceType,
        tags,
        context,
      });

      return okJson(res, {
        ok: true,
        tenantKey: tenantKey || null,
        provider: out.provider,
        source: out.source,
        resourceType: out.resourceType,
        folder: out.folder,
        publicId: out.publicId,
        version: out.version,
        width: out.width,
        height: out.height,
        bytes: out.bytes,
        format: out.format,
        url: out.url,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "upload_failed",
        details: {
          message: String(e?.message || e),
        },
      });
    }
  });

  // =========================
  // CAROUSEL RENDER
  // POST /api/media/carousel/render
  //
  // body:
  // {
  //   slides: [...],
  //   aspectRatio?: "1:1" | "4:5" | "9:16",
  //   brandName?: "...",
  //   badge?: "...",
  //   cta?: "...",
  //   language?: "az",
  //   folder?: "...",          // optional cloudinary folder
  //   upload?: true|false      // default true
  // }
  //
  // returns:
  // {
  //   assetsLocal: [...]
  //   uploaded: [...]
  // }
  // =========================
  r.post("/media/carousel/render", async (req, res) => {
    try {
      const tenantKey = getAuthTenantKey(req);
      const aspectRatio = normalizeAspectRatio(req.body?.aspectRatio || "1:1");
      const upload = req.body?.upload !== false;

      const fallback = {
        aspectRatio,
        brandName: clean(req.body?.brandName || req.body?.logoText || "BRAND"),
        logoText: clean(req.body?.logoText || req.body?.brandName || "BRAND"),
        badge: clean(req.body?.badge || "BRAND"),
        cta: clean(req.body?.cta || ""),
        align: clean(req.body?.align || "left"),
        theme: clean(req.body?.theme || "premium_dark"),
        language: lower(req.body?.language || "az") || "az",
        renderHints: isObject(req.body?.renderHints) ? req.body.renderHints : {},
      };

      const slides = normalizeSlidesInput(req.body?.slides, fallback);

      if (!slides.length) {
        return okJson(res, { ok: false, error: "slides[] required" });
      }

      const uploadsDir = path.resolve(process.cwd(), "uploads");
      const renderDir = path.join(uploadsDir, "renders", tenantKey || "public");

      const publicBaseUrl = clean(process.env.PUBLIC_BASE_URL || "");
      if (!publicBaseUrl) {
        return okJson(res, {
          ok: false,
          error: "PUBLIC_BASE_URL missing",
        });
      }

      const assetsLocal = await renderSlidesToPng({
        slides,
        outDir: renderDir,
        publicBaseUrl,
      });

      let uploaded = [];
      if (upload) {
        const folder =
          clean(req.body?.folder || "") ||
          [tenantKey || "public", "carousel"].filter(Boolean).join("/");

        for (let i = 0; i < assetsLocal.length; i++) {
          const asset = assetsLocal[i];

          const up = await cloudinaryUploadFromUrl({
            sourceUrl: asset.url,
            db,
            tenantKey,
            folder,
            publicId: clean(req.body?.publicIdPrefix || "")
              ? `${clean(req.body?.publicIdPrefix)}_${i + 1}`
              : "",
            resourceType: "image",
            tags: ["carousel", tenantKey || "public"],
            context: {
              tenantKey: tenantKey || "",
              slide: String(i + 1),
            },
          });

          uploaded.push({
            index: i,
            localUrl: asset.url,
            localPath: asset.localPath,
            width: asset.width,
            height: asset.height,
            provider: up.provider,
            source: up.source,
            url: up.url,
            publicId: up.publicId,
            version: up.version,
            format: up.format,
            bytes: up.bytes,
          });
        }
      }

      return okJson(res, {
        ok: true,
        tenantKey: tenantKey || null,
        aspectRatio,
        slidesCount: slides.length,
        assetsLocal,
        uploaded,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "carousel_render_failed",
        details: {
          message: String(e?.message || e),
        },
      });
    }
  });

  // =========================
  // VIDEO
  // /api/media/video/runway
  // =========================
  r.use("/media", videoRouter);

  return r;
}