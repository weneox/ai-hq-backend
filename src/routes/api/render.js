// src/routes/api/render.js
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { cfg } from "../../config.js";
import { okJson } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { baseUrl } from "../../utils/url.js";
import { renderSlidesToPng } from "../../render/renderSlides.js";

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function asArr(x) {
  return Array.isArray(x) ? x : [];
}

function pickAspectRatioFromFormat(format) {
  const f = String(format || "").trim().toLowerCase();
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

function pickSlides(body) {
  const b = asObj(body);

  const direct = asArr(b.slides);
  if (direct.length) return direct;

  const contentPackSlides = asArr(asObj(b.contentPack).slides);
  if (contentPackSlides.length) return contentPackSlides;

  const proposalSlides = asArr(asObj(asObj(b.proposal).payload).slides);
  if (proposalSlides.length) return proposalSlides;

  const payloadSlides = asArr(asObj(b.payload).slides);
  if (payloadSlides.length) return payloadSlides;

  return [];
}

function normalizeSlides(rawSlides, body) {
  const b = asObj(body);
  const contentPack = asObj(b.contentPack);
  const payload = asObj(b.payload);
  const proposalPayload = asObj(asObj(b.proposal).payload);

  const format =
    String(
      b.format ||
        contentPack.format ||
        payload.format ||
        proposalPayload.format ||
        "carousel"
    )
      .trim()
      .toLowerCase();

  const aspectRatio =
    String(
      b.aspectRatio ||
        contentPack.aspectRatio ||
        payload.aspectRatio ||
        proposalPayload.aspectRatio ||
        pickAspectRatioFromFormat(format)
    ).trim() || pickAspectRatioFromFormat(format);

  return asArr(rawSlides).map((slide, i) => {
    const s = asObj(slide);

    return {
      ...s,
      slideNumber: Number(s.slideNumber || s.index || i + 1),
      totalSlides: Number(s.totalSlides || rawSlides.length),
      aspectRatio:
        String(
          s.aspectRatio ||
            asObj(s.visualMeta).aspectRatio ||
            aspectRatio
        ).trim() || aspectRatio,
      bgImageUrl: String(
        s.bgImageUrl ||
          s.backgroundUrl ||
          s.imageUrl ||
          s.assetUrl ||
          ""
      ).trim(),
      renderHints: {
        layoutFamily:
          s?.renderHints?.layoutFamily || "editorial_left",
        textPosition:
          s?.renderHints?.textPosition || s.align || "left",
        safeArea:
          s?.renderHints?.safeArea || "left-heavy",
        overlayStrength:
          s?.renderHints?.overlayStrength || "medium",
        focalBias:
          s?.renderHints?.focalBias || "right",
      },
    };
  });
}

export function renderRoutes() {
  const r = express.Router();

  r.post("/render/slides", async (req, res) => {
    const tenantId = fixText(
      String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()
    );

    const rawSlides = pickSlides(req.body);
    if (!rawSlides.length) {
      return okJson(res, {
        ok: false,
        error: "slides[] required",
      });
    }

    try {
      const base = baseUrl();
      if (!base) {
        return okJson(res, {
          ok: false,
          error: "PUBLIC_BASE_URL required for assets URLs",
        });
      }

      const slides = normalizeSlides(rawSlides, req.body);
      const renderId = crypto.randomUUID();
      const outDir = path.resolve(
        process.cwd(),
        "uploads",
        "renders",
        tenantId,
        renderId
      );

      fs.mkdirSync(outDir, { recursive: true });

      const assets = await renderSlidesToPng({
        slides,
        outDir,
        publicBaseUrl: base,
      });

      return okJson(res, {
        ok: true,
        renderId,
        count: assets.length,
        assets,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Render failed",
        details: {
          message: String(e?.message || e),
        },
      });
    }
  });

  return r;
}