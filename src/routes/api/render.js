// src/routes/api/render.js
//
// FINAL v3.0 — tenant-safe + robust render route normalization
//
// Goals:
// ✅ Accept slides from direct body, contentPack, payload, proposal.payload
// ✅ Normalize format / aspectRatio correctly
// ✅ Normalize bgImageUrl from multiple possible fields
// ✅ Keep renderHints stable for renderer
// ✅ Work cleanly with renderSlides.js final renderer
// ✅ Return consistent render payload
// ✅ Remove hardcoded brand fallback
// ✅ Resolve tenantKey safely

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { cfg } from "../../config.js";
import { okJson } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { baseUrl } from "../../utils/url.js";
import { renderSlidesToPng } from "../../render/renderSlides.js";
import { getDefaultTenantKey, resolveTenantKey } from "../../tenancy/index.js";

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function asArr(x) {
  return Array.isArray(x) ? x : [];
}

function clean(x) {
  return String(x || "").trim();
}

function resolveTenant(v) {
  return resolveTenantKey(v, getDefaultTenantKey());
}

function pickAspectRatioFromFormat(format) {
  const f = clean(format).toLowerCase();
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

function normalizeAspectRatio(v, format = "") {
  const x = clean(v);
  if (x === "1:1" || x === "4:5" || x === "9:16") return x;
  return pickAspectRatioFromFormat(format);
}

function normalizeFormat(v) {
  const f = clean(v).toLowerCase();
  if (f === "image" || f === "carousel" || f === "reel") return f;
  return "carousel";
}

function pickSlides(body) {
  const b = asObj(body);

  const directSlides = asArr(b.slides);
  if (directSlides.length) return directSlides;

  const contentPackSlides = asArr(asObj(b.contentPack).slides);
  if (contentPackSlides.length) return contentPackSlides;

  const payloadSlides = asArr(asObj(b.payload).slides);
  if (payloadSlides.length) return payloadSlides;

  const proposalPayloadSlides = asArr(asObj(asObj(b.proposal).payload).slides);
  if (proposalPayloadSlides.length) return proposalPayloadSlides;

  const resultSlides = asArr(asObj(b.result).slides);
  if (resultSlides.length) return resultSlides;

  const resultContentPackSlides = asArr(asObj(asObj(b.result).contentPack).slides);
  if (resultContentPackSlides.length) return resultContentPackSlides;

  return [];
}

function pickTopLevelSources(body) {
  const b = asObj(body);

  const contentPack = asObj(b.contentPack);
  const payload = asObj(b.payload);
  const proposalPayload = asObj(asObj(b.proposal).payload);
  const result = asObj(b.result);
  const resultContentPack = asObj(result.contentPack);

  return { b, contentPack, payload, proposalPayload, result, resultContentPack };
}

function pickFormat(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return normalizeFormat(
    b.format ||
      contentPack.format ||
      payload.format ||
      proposalPayload.format ||
      result.format ||
      resultContentPack.format ||
      "carousel"
  );
}

function pickAspectRatio(body, format) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return normalizeAspectRatio(
    b.aspectRatio ||
      asObj(contentPack.visualPlan).aspectRatio ||
      contentPack.aspectRatio ||
      asObj(payload.visualPlan).aspectRatio ||
      payload.aspectRatio ||
      asObj(proposalPayload.visualPlan).aspectRatio ||
      proposalPayload.aspectRatio ||
      asObj(result.visualPlan).aspectRatio ||
      result.aspectRatio ||
      asObj(resultContentPack.visualPlan).aspectRatio ||
      resultContentPack.aspectRatio ||
      pickAspectRatioFromFormat(format),
    format
  );
}

function pickGlobalLogoText(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return clean(
    b.logoText ||
      b.brandName ||
      asObj(b.brand).logoText ||
      asObj(b.brand).name ||
      contentPack.logoText ||
      contentPack.brandName ||
      payload.logoText ||
      payload.brandName ||
      proposalPayload.logoText ||
      proposalPayload.brandName ||
      result.logoText ||
      result.brandName ||
      resultContentPack.logoText ||
      resultContentPack.brandName ||
      "Brand"
  );
}

function pickGlobalBadge(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return clean(
    b.badge ||
      contentPack.badge ||
      payload.badge ||
      proposalPayload.badge ||
      result.badge ||
      resultContentPack.badge ||
      ""
  );
}

function pickGlobalCta(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return clean(
    b.cta ||
      contentPack.cta ||
      payload.cta ||
      proposalPayload.cta ||
      result.cta ||
      resultContentPack.cta ||
      "Contact us for details"
  );
}

function pickGlobalTitleFallback(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return clean(
    b.title ||
      contentPack.topic ||
      contentPack.title ||
      payload.topic ||
      payload.title ||
      proposalPayload.topic ||
      proposalPayload.title ||
      result.topic ||
      result.title ||
      resultContentPack.topic ||
      resultContentPack.title ||
      "Untitled Slide"
  );
}

function pickGlobalSubtitleFallback(body) {
  const { b, contentPack, payload, proposalPayload, result, resultContentPack } =
    pickTopLevelSources(body);

  return clean(
    b.subtitle ||
      contentPack.hook ||
      payload.hook ||
      proposalPayload.hook ||
      result.hook ||
      resultContentPack.hook ||
      ""
  );
}

function pickBgImageUrl(slide) {
  const s = asObj(slide);
  const visualMeta = asObj(s.visualMeta);
  const media = asObj(s.media);
  const asset = asObj(s.asset);
  const image = asObj(s.image);

  return clean(
    s.bgImageUrl ||
      s.backgroundUrl ||
      s.backgroundImageUrl ||
      s.imageUrl ||
      s.coverUrl ||
      s.assetUrl ||
      s.url ||
      visualMeta.bgImageUrl ||
      visualMeta.backgroundUrl ||
      visualMeta.imageUrl ||
      media.bgImageUrl ||
      media.backgroundUrl ||
      media.imageUrl ||
      media.url ||
      asset.url ||
      image.url ||
      ""
  );
}

function normalizeRenderHints(slide) {
  const s = asObj(slide);
  const rh = asObj(s.renderHints);

  return {
    layoutFamily: clean(rh.layoutFamily || "editorial_left") || "editorial_left",
    textPosition: clean(rh.textPosition || s.align || "left") || "left",
    safeArea: clean(rh.safeArea || "left-heavy") || "left-heavy",
    overlayStrength: clean(rh.overlayStrength || "medium") || "medium",
    focalBias: clean(rh.focalBias || "right") || "right",
  };
}

function normalizeSlides(rawSlides, body) {
  const format = pickFormat(body);
  const aspectRatio = pickAspectRatio(body, format);
  const globalLogoText = pickGlobalLogoText(body);
  const globalBadge = pickGlobalBadge(body);
  const globalCta = pickGlobalCta(body);
  const globalTitleFallback = pickGlobalTitleFallback(body);
  const globalSubtitleFallback = pickGlobalSubtitleFallback(body);

  const total = asArr(rawSlides).length;

  return asArr(rawSlides).map((slide, i) => {
    const s = asObj(slide);
    const slideNumber = Number(s.slideNumber || s.index || i + 1) || i + 1;
    const totalSlides = Number(s.totalSlides || total) || total;

    const defaultBadge =
      format === "reel"
        ? "REEL"
        : slideNumber === 1
        ? globalBadge || globalLogoText
        : slideNumber === totalSlides
        ? "CTA"
        : "SLIDE";

    return {
      ...s,
      title: clean(s.title || s.headline || s.text || globalTitleFallback || "Untitled Slide"),
      subtitle: clean(
        s.subtitle || s.subline || s.kicker || globalSubtitleFallback || ""
      ),
      cta: clean(s.cta || (slideNumber === totalSlides ? globalCta : "")),
      badge: clean(s.badge || defaultBadge),
      logoText: clean(s.logoText || globalLogoText || "Brand"),
      align: clean(s.align || "left") || "left",
      theme: clean(s.theme || "brand_dark") || "brand_dark",
      slideNumber,
      totalSlides,
      aspectRatio: normalizeAspectRatio(
        s.aspectRatio || asObj(s.visualMeta).aspectRatio || aspectRatio,
        format
      ),
      bgImageUrl: pickBgImageUrl(s),
      renderHints: normalizeRenderHints(s),
    };
  });
}

export function renderRoutes() {
  const r = express.Router();

  r.post("/render/slides", async (req, res) => {
    const tenantKey = resolveTenant(
      clean(req.body?.tenantKey || req.body?.tenantId || cfg.DEFAULT_TENANT_KEY)
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

      const format = pickFormat(req.body);
      const aspectRatio = pickAspectRatio(req.body, format);
      const slides = normalizeSlides(rawSlides, req.body);

      const renderId = crypto.randomUUID();
      const outDir = path.resolve(
        process.cwd(),
        "uploads",
        "renders",
        tenantKey,
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
        tenantKey,
        renderId,
        format,
        aspectRatio,
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