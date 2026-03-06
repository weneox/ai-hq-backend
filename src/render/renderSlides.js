// src/render/renderSlides.js
//
// FINAL v4.1 — hard-clean premium slide renderer
//
// Goals:
// ✅ Kill baked ghost text harder
// ✅ Strong left text-safe zone
// ✅ Bottom-right cleanup patch
// ✅ Cleaner premium composition
// ✅ Stable 1:1 / 4:5 / 9:16 output
//
// Input:
// [
//   {
//     title,
//     subtitle,
//     cta,
//     badge,
//     align,
//     theme,
//     slideNumber,
//     totalSlides,
//     bgImageUrl,
//     logoText,
//     aspectRatio,
//     renderHints: {
//       layoutFamily,
//       textPosition,
//       safeArea,
//       overlayStrength,
//       focalBias
//     }
//   }
// ]
//
// Output:
// [
//   { url, file, width, height, localPath }
// ]

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function esc(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeText(s, max = 220) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

function normalizeOverlayStrength(v) {
  const x = String(v || "").toLowerCase();
  if (x === "soft" || x === "medium" || x === "strong") return x;
  return "medium";
}

function normalizeTextPosition(v) {
  const x = String(v || "").toLowerCase();
  if (["center", "top-left", "bottom-left", "left"].includes(x)) return x;
  return "left";
}

function normalizeSafeArea(v) {
  const x = String(v || "").toLowerCase();
  if (["left-heavy", "centered", "top-left", "bottom-left"].includes(x)) return x;
  return "left-heavy";
}

function normalizeLayoutFamily(v) {
  const x = String(v || "").toLowerCase();
  if (
    ["editorial_left", "cinematic_center", "luxury_top_left", "dramatic_bottom_left"].includes(
      x
    )
  ) {
    return x;
  }
  return "editorial_left";
}

function normalizeFocalBias(v) {
  const x = String(v || "").toLowerCase();
  if (["right", "center", "lower-right", "upper-right"].includes(x)) return x;
  return "right";
}

function normalizeAspectRatio(v) {
  const x = String(v || "").trim();
  if (x === "4:5" || x === "9:16" || x === "1:1") return x;
  return "1:1";
}

function dimsByAspectRatio(v) {
  const ar = normalizeAspectRatio(v);
  if (ar === "4:5") return { width: 1080, height: 1350 };
  if (ar === "9:16") return { width: 1080, height: 1920 };
  return { width: 1080, height: 1080 };
}

function backgroundPositionByFocalBias(v) {
  const x = normalizeFocalBias(v);
  if (x === "center") return "center center";
  if (x === "lower-right") return "68% 66%";
  if (x === "upper-right") return "68% 34%";
  return "76% center";
}

function logoSizeByAspectRatio(ar) {
  if (ar === "9:16") return { dot: 14, text: 22, gap: 13 };
  if (ar === "4:5") return { dot: 13, text: 21, gap: 12 };
  return { dot: 12, text: 20, gap: 12 };
}

function typeScaleByAspectRatio(ar, layoutFamily) {
  if (ar === "9:16") {
    return {
      subtitle: layoutFamily === "cinematic_center" ? 28 : 26,
      title: layoutFamily === "cinematic_center" ? 86 : 80,
      cta: 19,
      badge: 15,
      counter: 18,
    };
  }
  if (ar === "4:5") {
    return {
      subtitle: layoutFamily === "cinematic_center" ? 26 : 24,
      title: layoutFamily === "cinematic_center" ? 74 : 70,
      cta: 18,
      badge: 14,
      counter: 17,
    };
  }
  return {
    subtitle: layoutFamily === "cinematic_center" ? 24 : 23,
    title: layoutFamily === "cinematic_center" ? 68 : 64,
    cta: 17,
    badge: 14,
    counter: 17,
  };
}

function layoutMetrics({ textPosition, layoutFamily, aspectRatio }) {
  const isVertical = aspectRatio === "9:16";
  const isFourFive = aspectRatio === "4:5";

  let padX = 74;
  let padTop = 68;
  let padBottom = 60;
  let copyMax = 420;
  let copyMarginTop = 170;

  if (isFourFive) {
    padX = 76;
    padTop = 72;
    padBottom = 62;
    copyMax = 450;
    copyMarginTop = 190;
  }

  if (isVertical) {
    padX = 72;
    padTop = 80;
    padBottom = 72;
    copyMax = 520;
    copyMarginTop = 275;
  }

  const base = {
    padX,
    padTop,
    padBottom,
    copyMax,
    copyMarginTop,
    alignItems: "flex-start",
    textAlign: "left",
    copyMarginLeft: "0",
    copyMarginRight: "0",
  };

  if (layoutFamily === "cinematic_center" || textPosition === "center") {
    return {
      ...base,
      copyMax: isVertical ? 720 : isFourFive ? 660 : 640,
      copyMarginTop: isVertical ? 360 : isFourFive ? 240 : 205,
      alignItems: "center",
      textAlign: "center",
      copyMarginLeft: "auto",
      copyMarginRight: "auto",
    };
  }

  if (layoutFamily === "luxury_top_left" || textPosition === "top-left") {
    return {
      ...base,
      copyMax: isVertical ? 500 : 430,
      copyMarginTop: isVertical ? 188 : isFourFive ? 116 : 110,
    };
  }

  if (layoutFamily === "dramatic_bottom_left" || textPosition === "bottom-left") {
    return {
      ...base,
      copyMax: isVertical ? 520 : 450,
      copyMarginTop: isVertical ? 1030 : isFourFive ? 900 : 780,
    };
  }

  return base;
}

function gradientByStrength(v, layoutFamily = "editorial_left") {
  const lf = normalizeLayoutFamily(layoutFamily);

  if (lf === "cinematic_center") {
    if (v === "soft") {
      return `
        radial-gradient(78% 62% at 50% 46%, rgba(4,8,18,.18) 0%, rgba(4,8,18,.34) 52%, rgba(4,8,18,.64) 100%),
        linear-gradient(180deg, rgba(4,8,18,.16) 0%, rgba(4,8,18,.08) 44%, rgba(4,8,18,.34) 100%)
      `;
    }
    if (v === "strong") {
      return `
        radial-gradient(78% 62% at 50% 46%, rgba(4,8,18,.30) 0%, rgba(4,8,18,.54) 52%, rgba(4,8,18,.82) 100%),
        linear-gradient(180deg, rgba(4,8,18,.24) 0%, rgba(4,8,18,.10) 44%, rgba(4,8,18,.44) 100%)
      `;
    }
    return `
      radial-gradient(78% 62% at 50% 46%, rgba(4,8,18,.24) 0%, rgba(4,8,18,.44) 52%, rgba(4,8,18,.72) 100%),
      linear-gradient(180deg, rgba(4,8,18,.20) 0%, rgba(4,8,18,.08) 44%, rgba(4,8,18,.38) 100%)
    `;
  }

  if (lf === "luxury_top_left") {
    if (v === "soft") {
      return `
        linear-gradient(180deg, rgba(4,8,18,.58) 0%, rgba(4,8,18,.26) 34%, rgba(4,8,18,.12) 66%, rgba(4,8,18,.08) 100%),
        linear-gradient(90deg, rgba(4,8,18,.60) 0%, rgba(4,8,18,.30) 34%, rgba(4,8,18,.10) 68%, rgba(4,8,18,.04) 100%)
      `;
    }
    if (v === "strong") {
      return `
        linear-gradient(180deg, rgba(4,8,18,.84) 0%, rgba(4,8,18,.48) 34%, rgba(4,8,18,.18) 66%, rgba(4,8,18,.10) 100%),
        linear-gradient(90deg, rgba(4,8,18,.86) 0%, rgba(4,8,18,.44) 34%, rgba(4,8,18,.16) 68%, rgba(4,8,18,.06) 100%)
      `;
    }
    return `
      linear-gradient(180deg, rgba(4,8,18,.72) 0%, rgba(4,8,18,.36) 34%, rgba(4,8,18,.14) 66%, rgba(4,8,18,.09) 100%),
      linear-gradient(90deg, rgba(4,8,18,.74) 0%, rgba(4,8,18,.36) 34%, rgba(4,8,18,.14) 68%, rgba(4,8,18,.05) 100%)
    `;
  }

  if (lf === "dramatic_bottom_left") {
    if (v === "soft") {
      return `
        linear-gradient(0deg, rgba(4,8,18,.62) 0%, rgba(4,8,18,.28) 30%, rgba(4,8,18,.10) 64%, rgba(4,8,18,.04) 100%),
        linear-gradient(90deg, rgba(4,8,18,.62) 0%, rgba(4,8,18,.28) 38%, rgba(4,8,18,.10) 70%, rgba(4,8,18,.04) 100%)
      `;
    }
    if (v === "strong") {
      return `
        linear-gradient(0deg, rgba(4,8,18,.88) 0%, rgba(4,8,18,.48) 30%, rgba(4,8,18,.18) 64%, rgba(4,8,18,.08) 100%),
        linear-gradient(90deg, rgba(4,8,18,.88) 0%, rgba(4,8,18,.42) 38%, rgba(4,8,18,.16) 70%, rgba(4,8,18,.08) 100%)
      `;
    }
    return `
      linear-gradient(0deg, rgba(4,8,18,.78) 0%, rgba(4,8,18,.36) 30%, rgba(4,8,18,.14) 64%, rgba(4,8,18,.06) 100%),
      linear-gradient(90deg, rgba(4,8,18,.78) 0%, rgba(4,8,18,.36) 38%, rgba(4,8,18,.14) 70%, rgba(4,8,18,.06) 100%)
    `;
  }

  if (v === "soft") {
    return `
      linear-gradient(90deg, rgba(6,10,18,.62) 0%, rgba(6,10,18,.30) 40%, rgba(6,10,18,.10) 72%, rgba(6,10,18,.04) 100%),
      linear-gradient(180deg, rgba(4,8,18,.24) 0%, rgba(4,8,18,.08) 48%, rgba(4,8,18,.32) 100%)
    `;
  }
  if (v === "strong") {
    return `
      linear-gradient(90deg, rgba(4,8,18,.88) 0%, rgba(4,8,18,.60) 42%, rgba(4,8,18,.24) 72%, rgba(4,8,18,.10) 100%),
      linear-gradient(180deg, rgba(4,8,18,.40) 0%, rgba(4,8,18,.10) 45%, rgba(4,8,18,.44) 100%)
    `;
  }
  return `
    linear-gradient(90deg, rgba(4,8,18,.78) 0%, rgba(4,8,18,.42) 42%, rgba(4,8,18,.16) 72%, rgba(4,8,18,.08) 100%),
    linear-gradient(180deg, rgba(4,8,18,.30) 0%, rgba(4,8,18,.08) 45%, rgba(4,8,18,.36) 100%)
  `;
}

function leftPanelByLayout({ layoutFamily, aspectRatio, overlayStrength }) {
  const lf = normalizeLayoutFamily(layoutFamily);
  const strength = normalizeOverlayStrength(overlayStrength);

  const alpha =
    strength === "soft"
      ? { solid: 0.68, fade: 0.18 }
      : strength === "strong"
      ? { solid: 0.90, fade: 0.28 }
      : { solid: 0.82, fade: 0.22 };

  let width = "42%";
  if (aspectRatio === "9:16") width = "50%";
  if (aspectRatio === "4:5") width = "46%";
  if (lf === "luxury_top_left") width = aspectRatio === "9:16" ? "48%" : "44%";
  if (lf === "dramatic_bottom_left") width = aspectRatio === "9:16" ? "48%" : "44%";
  if (lf === "cinematic_center") width = "0%";

  if (lf === "cinematic_center") {
    return {
      display: "none",
      background: "none",
      width,
    };
  }

  return {
    display: "block",
    width,
    background: `
      linear-gradient(90deg,
        rgba(4,8,18,${alpha.solid}) 0%,
        rgba(4,8,18,${alpha.solid}) 54%,
        rgba(4,8,18,${alpha.fade}) 84%,
        rgba(4,8,18,0) 100%
      )
    `,
  };
}

function leftScrubByLayout({ safeArea, layoutFamily, overlayStrength }) {
  const strength = normalizeOverlayStrength(overlayStrength);
  const safe = normalizeSafeArea(safeArea);
  const lf = normalizeLayoutFamily(layoutFamily);

  const alpha =
    strength === "soft"
      ? { heavy: 0.58, medium: 0.22, blur: 20 }
      : strength === "strong"
      ? { heavy: 0.88, medium: 0.38, blur: 30 }
      : { heavy: 0.76, medium: 0.30, blur: 26 };

  if (lf === "cinematic_center" || safe === "centered") {
    return {
      display: "block",
      inset: "16% 14% 26% 14%",
      blur: alpha.blur,
      background: `
        radial-gradient(58% 42% at 50% 40%, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 54%, rgba(4,8,18,0) 100%)
      `,
    };
  }

  if (lf === "luxury_top_left" || safe === "top-left") {
    return {
      display: "block",
      inset: "0% 28% 30% 0%",
      blur: alpha.blur,
      background: `
        radial-gradient(98% 78% at 18% 14%, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 48%, rgba(4,8,18,0) 100%),
        linear-gradient(90deg, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 44%, rgba(4,8,18,0) 100%)
      `,
    };
  }

  if (lf === "dramatic_bottom_left" || safe === "bottom-left") {
    return {
      display: "block",
      inset: "34% 28% 0% 0%",
      blur: alpha.blur,
      background: `
        radial-gradient(98% 78% at 18% 86%, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 48%, rgba(4,8,18,0) 100%),
        linear-gradient(90deg, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 44%, rgba(4,8,18,0) 100%)
      `,
    };
  }

  return {
    display: "block",
    inset: "0% 24% 0% 0%",
    blur: alpha.blur,
    background: `
      linear-gradient(90deg, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 46%, rgba(4,8,18,0) 86%),
      radial-gradient(80% 96% at 12% 44%, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 48%, rgba(4,8,18,0) 100%)
    `,
  };
}

function bottomRightPatch({ overlayStrength, aspectRatio }) {
  const strength = normalizeOverlayStrength(overlayStrength);

  const alpha =
    strength === "soft"
      ? { heavy: 0.34, medium: 0.16, blur: 16 }
      : strength === "strong"
      ? { heavy: 0.56, medium: 0.24, blur: 24 }
      : { heavy: 0.46, medium: 0.20, blur: 20 };

  let inset = "72% 0% 0% 70%";
  if (aspectRatio === "4:5") inset = "76% 0% 0% 66%";
  if (aspectRatio === "9:16") inset = "80% 0% 0% 60%";

  return {
    inset,
    blur: alpha.blur,
    background: `
      radial-gradient(90% 90% at 88% 88%, rgba(4,8,18,${alpha.heavy}) 0%, rgba(4,8,18,${alpha.medium}) 48%, rgba(4,8,18,0) 100%)
    `,
  };
}

function decorativeGlowByLayout(layoutFamily) {
  const lf = normalizeLayoutFamily(layoutFamily);

  if (lf === "cinematic_center") {
    return {
      a: "radial-gradient(520px 340px at 50% 30%, rgba(66,180,255,.16), transparent 62%)",
      b: "radial-gradient(480px 300px at 50% 84%, rgba(124,92,255,.12), transparent 64%)",
    };
  }

  if (lf === "luxury_top_left") {
    return {
      a: "radial-gradient(460px 300px at 18% 12%, rgba(66,180,255,.12), transparent 62%)",
      b: "radial-gradient(560px 360px at 84% 78%, rgba(124,92,255,.10), transparent 66%)",
    };
  }

  if (lf === "dramatic_bottom_left") {
    return {
      a: "radial-gradient(520px 340px at 18% 84%, rgba(124,92,255,.12), transparent 62%)",
      b: "radial-gradient(500px 320px at 86% 20%, rgba(66,180,255,.12), transparent 64%)",
    };
  }

  return {
    a: "radial-gradient(540px 360px at 82% 26%, rgba(66,180,255,.14), transparent 62%)",
    b: "radial-gradient(500px 320px at 14% 84%, rgba(124,92,255,.10), transparent 64%)",
  };
}

function buildPageHtml(slide, idx, total) {
  const title = esc(safeText(slide.title || "Untitled Slide", 120));
  const subtitle = esc(safeText(slide.subtitle || "", 180));
  const cta = esc(safeText(slide.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın", 72));
  const badge = esc(safeText(slide.badge || "NEOX", 24));
  const logoText = esc(safeText(slide.logoText || "NEOX", 18));
  const bgImageUrl = String(slide.bgImageUrl || "").trim();

  const aspectRatio = normalizeAspectRatio(slide.aspectRatio || "1:1");
  const dims = dimsByAspectRatio(aspectRatio);

  const layoutFamily = normalizeLayoutFamily(slide?.renderHints?.layoutFamily);
  const textPosition = normalizeTextPosition(
    slide?.renderHints?.textPosition || slide.align || "left"
  );
  const safeArea = normalizeSafeArea(slide?.renderHints?.safeArea || "left-heavy");
  const overlayStrength = normalizeOverlayStrength(
    slide?.renderHints?.overlayStrength || "medium"
  );
  const focalBias = normalizeFocalBias(slide?.renderHints?.focalBias || "right");

  const metrics = layoutMetrics({
    textPosition,
    layoutFamily,
    aspectRatio,
  });

  const scale = typeScaleByAspectRatio(aspectRatio, layoutFamily);
  const logoScale = logoSizeByAspectRatio(aspectRatio);
  const leftPanel = leftPanelByLayout({
    layoutFamily,
    aspectRatio,
    overlayStrength,
  });
  const leftScrub = leftScrubByLayout({
    safeArea,
    layoutFamily,
    overlayStrength,
  });
  const brPatch = bottomRightPatch({
    overlayStrength,
    aspectRatio,
  });
  const glow = decorativeGlowByLayout(layoutFamily);

  const bgLayer = bgImageUrl
    ? `
      <div class="bg-image"
        style="
          background-image:url('${esc(bgImageUrl)}');
          background-position:${backgroundPositionByFocalBias(focalBias)};
        "
      ></div>
      <div class="bg-dim bg-dim-${idx}"></div>
    `
    : `
      <div class="bg-fallback"></div>
      <div class="bg-dim bg-dim-${idx}"></div>
    `;

  return `
  <section
    class="page aspect-${aspectRatio.replace(":", "-")} layout-${layoutFamily} textpos-${textPosition} safe-${safeArea}"
    style="width:${dims.width}px;height:${dims.height}px;"
  >
    <div class="card" style="width:${dims.width}px;height:${dims.height}px;">
      ${bgLayer}

      <div
        class="left-panel"
        style="
          display:${leftPanel.display};
          width:${leftPanel.width};
          background:${leftPanel.background};
        "
      ></div>

      <div
        class="left-scrub"
        style="
          display:${leftScrub.display};
          inset:${leftScrub.inset};
          background:${leftScrub.background};
          filter:blur(${leftScrub.blur}px);
        "
      ></div>

      <div
        class="bottom-right-scrub"
        style="
          inset:${brPatch.inset};
          background:${brPatch.background};
          filter:blur(${brPatch.blur}px);
        "
      ></div>

      <div class="brand-glow brand-glow-a" style="background:${glow.a};"></div>
      <div class="brand-glow brand-glow-b" style="background:${glow.b};"></div>
      <div class="noise"></div>

      <div
        class="content"
        style="
          padding:${metrics.padTop}px ${metrics.padX}px ${metrics.padBottom}px;
          align-items:${metrics.alignItems};
          text-align:${metrics.textAlign};
        "
      >
        <div class="topbar">
          <div class="brand" style="gap:${logoScale.gap}px;">
            <span
              class="brand-mark"
              style="width:${logoScale.dot}px;height:${logoScale.dot}px;"
            ></span>
            <span class="brand-text" style="font-size:${logoScale.text}px;">${logoText}</span>
          </div>
          <div class="badge" style="font-size:${scale.badge}px;">${badge}</div>
        </div>

        <div
          class="copy"
          style="
            max-width:${metrics.copyMax}px;
            margin-top:${metrics.copyMarginTop}px;
            margin-left:${metrics.copyMarginLeft};
            margin-right:${metrics.copyMarginRight};
          "
        >
          ${
            subtitle
              ? `<div class="subtitle" style="font-size:${scale.subtitle}px;">${subtitle}</div>`
              : ""
          }
          <h1 style="font-size:${scale.title}px;">${title}</h1>
        </div>

        <div class="footer">
          <div class="cta" style="font-size:${scale.cta}px;">${cta}</div>
          <div class="counter" style="font-size:${scale.counter}px;"><span class="num">${idx + 1}</span> / ${total}</div>
        </div>
      </div>
    </div>
  </section>
  `;
}

function buildHtml({ slides }) {
  const pages = slides
    .map((slide, idx) => {
      const aspectRatio = normalizeAspectRatio(slide.aspectRatio || "1:1");
      const dims = dimsByAspectRatio(aspectRatio);
      const overlayStrength = normalizeOverlayStrength(
        slide?.renderHints?.overlayStrength || "medium"
      );
      const layoutFamily = normalizeLayoutFamily(slide?.renderHints?.layoutFamily);

      return `
        <div class="page-wrap page-${idx}" style="width:${dims.width}px;height:${dims.height}px;">
          <style>
            .page-${idx} .bg-dim-${idx}{
              background:${gradientByStrength(overlayStrength, layoutFamily)};
            }
          </style>
          ${buildPageHtml(slide, idx, slides.length)}
        </div>
      `;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #05070d;
    font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  }

  .page-wrap {
    overflow: hidden;
    position: relative;
  }

  .page {
    position: relative;
    display: flex;
  }

  .card {
    position: relative;
    overflow: hidden;
    background: #070b14;
  }

  .bg-image,
  .bg-fallback,
  .bg-dim,
  .left-panel,
  .left-scrub,
  .bottom-right-scrub,
  .brand-glow,
  .noise {
    position: absolute;
  }

  .bg-image,
  .bg-fallback,
  .bg-dim,
  .brand-glow,
  .noise {
    inset: 0;
  }

  .bg-image {
    z-index: 0;
    background-size: cover;
    transform: scale(1.04);
    filter: saturate(1.03) contrast(1.03);
  }

  .bg-fallback {
    z-index: 0;
    background:
      radial-gradient(880px 640px at 18% 22%, rgba(0,245,210,.16), transparent 58%),
      radial-gradient(760px 700px at 84% 82%, rgba(90,92,255,.18), transparent 58%),
      linear-gradient(180deg, #060911 0%, #0A1123 55%, #060911 100%);
  }

  .bg-dim {
    z-index: 1;
  }

  .left-panel {
    z-index: 2;
    inset: 0 auto 0 0;
    pointer-events: none;
  }

  .left-scrub {
    z-index: 3;
    pointer-events: none;
    opacity: 1;
  }

  .bottom-right-scrub {
    z-index: 3;
    pointer-events: none;
    opacity: 1;
  }

  .brand-glow {
    z-index: 4;
    pointer-events: none;
  }

  .noise {
    z-index: 5;
    opacity: .05;
    mix-blend-mode: overlay;
    background-image:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.28'/%3E%3C/svg%3E");
  }

  .content {
    position: relative;
    z-index: 6;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
  }

  .brand-mark {
    border-radius: 999px;
    background: linear-gradient(135deg, #00F5D2 0%, #61AFFF 45%, #8B5CFF 100%);
    box-shadow: 0 0 18px rgba(0,245,210,.24);
    flex: 0 0 auto;
  }

  .brand-text {
    color: rgba(255,255,255,.94);
    font-weight: 800;
    letter-spacing: .16em;
  }

  .badge {
    color: rgba(255,255,255,.86);
    font-weight: 700;
    letter-spacing: .06em;
    padding: 11px 16px;
    border-radius: 999px;
    background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.10);
    backdrop-filter: blur(16px);
  }

  .copy {
    position: relative;
  }

  .subtitle {
    color: rgba(196,224,255,.92);
    line-height: 1.24;
    font-weight: 500;
    margin-bottom: 16px;
    text-wrap: balance;
    max-width: 100%;
    text-shadow: 0 6px 18px rgba(0,0,0,.26);
  }

  h1 {
    margin: 0;
    color: #fff;
    line-height: .98;
    letter-spacing: -0.045em;
    font-weight: 900;
    text-wrap: balance;
    max-width: 100%;
    text-shadow: 0 10px 28px rgba(0,0,0,.28);
  }

  .footer {
    margin-top: auto;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
  }

  .cta,
  .counter {
    color: rgba(255,255,255,.94);
    font-weight: 700;
    line-height: 1;
    padding: 14px 18px;
    border-radius: 999px;
    background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.12);
    backdrop-filter: blur(16px);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  }

  .counter {
    color: rgba(255,255,255,.82);
    min-width: 86px;
    text-align: center;
  }

  .num {
    color: #fff;
    font-weight: 900;
  }

  .layout-editorial_left .copy {
    max-width: 420px;
  }

  .layout-luxury_top_left .copy {
    max-width: 430px;
  }

  .layout-dramatic_bottom_left .copy {
    max-width: 450px;
  }

  .layout-cinematic_center .copy {
    max-width: 640px;
  }

  .textpos-center .copy,
  .textpos-center .subtitle,
  .textpos-center h1 {
    text-align: center;
  }

  .textpos-center .subtitle,
  .textpos-center .copy {
    margin-left: auto !important;
    margin-right: auto !important;
  }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

function buildAssetUrl({ publicBaseUrl, uploadsDir, filePath }) {
  const rel = path.relative(uploadsDir, filePath).replace(/\\/g, "/");
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  return `${base}/assets/${rel}`;
}

export async function renderSlidesToPng({
  slides,
  outDir,
  publicBaseUrl,
}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error("slides[] required");
  }
  if (!publicBaseUrl) {
    throw new Error("publicBaseUrl required");
  }
  if (!outDir) {
    throw new Error("outDir required");
  }

  const normalizedSlides = slides.map((slide, i) => {
    const aspectRatio = normalizeAspectRatio(
      slide.aspectRatio ||
        slide?.visualMeta?.aspectRatio ||
        "1:1"
    );

    return {
      title: safeText(slide.title || slide.headline || slide.text || "Untitled Slide", 120),
      subtitle: safeText(slide.subtitle || slide.subline || slide.kicker || "", 180),
      cta: safeText(slide.cta || "Daha çox məlumat üçün bizimlə əlaqə saxlayın", 72),
      badge: safeText(slide.badge || "NEOX", 24),
      align: slide.align || "left",
      theme: slide.theme || "neox_dark",
      slideNumber: Number(slide.slideNumber || i + 1),
      totalSlides: Number(slide.totalSlides || slides.length),
      bgImageUrl: String(slide.bgImageUrl || slide.backgroundUrl || "").trim(),
      logoText: safeText(slide.logoText || "NEOX", 18),
      aspectRatio,
      renderHints: {
        layoutFamily: slide?.renderHints?.layoutFamily || "editorial_left",
        textPosition: slide?.renderHints?.textPosition || slide.align || "left",
        safeArea: slide?.renderHints?.safeArea || "left-heavy",
        overlayStrength: slide?.renderHints?.overlayStrength || "medium",
        focalBias: slide?.renderHints?.focalBias || "right",
      },
    };
  });

  ensureDir(outDir);

  const html = buildHtml({ slides: normalizedSlides });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  try {
    const firstDims = dimsByAspectRatio(normalizedSlides[0].aspectRatio);
    const page = await browser.newPage({
      viewport: { width: firstDims.width, height: firstDims.height },
      deviceScaleFactor: 1,
    });

    await page.setContent(html, { waitUntil: "networkidle" });

    const uploadsDir = path.resolve(process.cwd(), "uploads");
    const pageNodes = await page.$$(".page-wrap");
    const assets = [];

    for (let i = 0; i < pageNodes.length; i++) {
      const node = pageNodes[i];
      const dims = dimsByAspectRatio(normalizedSlides[i].aspectRatio);
      const hash = crypto
        .createHash("md5")
        .update(`${Date.now()}-${i}-${normalizedSlides[i].title}`)
        .digest("hex")
        .slice(0, 10);

      const filename = `slide-${i + 1}-${hash}.png`;
      const filePath = path.join(outDir, filename);

      await node.screenshot({
        path: filePath,
        type: "png",
      });

      assets.push({
        file: filename,
        localPath: filePath,
        width: dims.width,
        height: dims.height,
        url: buildAssetUrl({
          publicBaseUrl,
          uploadsDir,
          filePath,
        }),
      });
    }

    return assets;
  } finally {
    await browser.close();
  }
}