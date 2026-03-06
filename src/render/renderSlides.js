// src/render/renderSlides.js
//
// FINAL v2.0 — premium branded slide renderer
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
//     renderHints: { textPosition, safeArea, overlayStrength }
//   }
// ]
//
// Output:
// [
//   { url, file, width, height, localPath }
// ]
//
// Notes:
// - Renderer adds all readable text itself
// - AI-generated image should be text-free
// - Designed for premium square carousel first

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
  if (x === "center") return "center";
  return "left";
}

function gradientByStrength(v) {
  if (v === "soft") {
    return `
      linear-gradient(90deg, rgba(6,10,18,.58) 0%, rgba(6,10,18,.28) 42%, rgba(6,10,18,.10) 70%, rgba(6,10,18,.04) 100%),
      linear-gradient(180deg, rgba(4,8,18,.28) 0%, rgba(4,8,18,.08) 48%, rgba(4,8,18,.34) 100%)
    `;
  }
  if (v === "strong") {
    return `
      linear-gradient(90deg, rgba(4,8,18,.86) 0%, rgba(4,8,18,.58) 42%, rgba(4,8,18,.24) 72%, rgba(4,8,18,.10) 100%),
      linear-gradient(180deg, rgba(4,8,18,.42) 0%, rgba(4,8,18,.10) 45%, rgba(4,8,18,.44) 100%)
    `;
  }
  return `
    linear-gradient(90deg, rgba(4,8,18,.74) 0%, rgba(4,8,18,.42) 42%, rgba(4,8,18,.16) 72%, rgba(4,8,18,.08) 100%),
    linear-gradient(180deg, rgba(4,8,18,.34) 0%, rgba(4,8,18,.08) 45%, rgba(4,8,18,.38) 100%)
  `;
}

function buildPageHtml(slide, idx, total) {
  const title = esc(safeText(slide.title || "Untitled Slide", 120));
  const subtitle = esc(safeText(slide.subtitle || "", 180));
  const cta = esc(safeText(slide.cta || "NEOX • AI Automation", 72));
  const badge = esc(safeText(slide.badge || "NEOX", 24));
  const logoText = esc(safeText(slide.logoText || "NEOX", 18));
  const bgImageUrl = String(slide.bgImageUrl || "").trim();
  const textPosition = normalizeTextPosition(slide?.renderHints?.textPosition || slide.align || "left");
  const overlayStrength = normalizeOverlayStrength(slide?.renderHints?.overlayStrength || "medium");

  const bgLayer = bgImageUrl
    ? `
      <div class="bg-image" style="background-image:url('${esc(bgImageUrl)}')"></div>
      <div class="bg-dim"></div>
    `
    : `
      <div class="bg-fallback"></div>
    `;

  return `
  <section class="page ${textPosition === "center" ? "centered" : "lefted"}">
    <div class="card">
      ${bgLayer}
      <div class="brand-glow brand-glow-a"></div>
      <div class="brand-glow brand-glow-b"></div>
      <div class="noise"></div>

      <div class="content">
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark"></span>
            <span class="brand-text">${logoText}</span>
          </div>
          <div class="badge">${badge}</div>
        </div>

        <div class="copy">
          ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ""}
          <h1>${title}</h1>
        </div>

        <div class="footer">
          <div class="cta">${cta}</div>
          <div class="counter"><span class="num">${idx + 1}</span> / ${total}</div>
        </div>
      </div>
    </div>
  </section>
  `;
}

function buildHtml({ slides }) {
  const pageCss = slides
    .map((slide, idx) => {
      const overlayStrength = normalizeOverlayStrength(slide?.renderHints?.overlayStrength || "medium");
      return `
        .page-${idx} .bg-dim{
          background: ${gradientByStrength(overlayStrength)};
        }
      `;
    })
    .join("\n");

  const pages = slides
    .map((slide, idx) => {
      return `<div class="page-wrap page-${idx}">${buildPageHtml(slide, idx, slides.length)}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=1080,height=1080" />
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
    width: 1080px;
    height: 1080px;
    overflow: hidden;
    position: relative;
  }

  .page {
    width: 1080px;
    height: 1080px;
    position: relative;
    display: flex;
  }

  .card {
    position: relative;
    width: 1080px;
    height: 1080px;
    overflow: hidden;
    background: #070b14;
  }

  .bg-image,
  .bg-fallback,
  .bg-dim,
  .brand-glow,
  .noise {
    position: absolute;
    inset: 0;
  }

  .bg-image {
    background-size: cover;
    background-position: center center;
    transform: scale(1.02);
    filter: saturate(1.03) contrast(1.02);
  }

  .bg-fallback {
    background:
      radial-gradient(880px 640px at 18% 22%, rgba(0,245,210,.18), transparent 58%),
      radial-gradient(760px 700px at 84% 82%, rgba(90,92,255,.20), transparent 58%),
      linear-gradient(180deg, #060911 0%, #0A1123 55%, #060911 100%);
  }

  .bg-dim {
    z-index: 2;
  }

  .brand-glow {
    z-index: 1;
    pointer-events: none;
  }

  .brand-glow-a {
    background:
      radial-gradient(560px 420px at 82% 28%, rgba(66,180,255,.22), transparent 60%);
  }

  .brand-glow-b {
    background:
      radial-gradient(520px 380px at 14% 84%, rgba(124,92,255,.16), transparent 60%);
  }

  .noise {
    z-index: 3;
    opacity: .08;
    mix-blend-mode: overlay;
    background-image:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.32'/%3E%3C/svg%3E");
  }

  .content {
    position: relative;
    z-index: 4;
    width: 100%;
    height: 100%;
    padding: 72px 74px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }

  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }

  .brand-mark {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: linear-gradient(135deg, #00F5D2 0%, #61AFFF 45%, #8B5CFF 100%);
    box-shadow: 0 0 24px rgba(0,245,210,.35);
    flex: 0 0 auto;
  }

  .brand-text {
    color: rgba(255,255,255,.92);
    font-size: 20px;
    font-weight: 800;
    letter-spacing: .16em;
  }

  .badge {
    color: rgba(255,255,255,.9);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: .08em;
    padding: 12px 18px;
    border-radius: 999px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.14);
    backdrop-filter: blur(18px);
  }

  .copy {
    margin-top: 126px;
    max-width: 580px;
  }

  .centered .copy {
    margin-top: 172px;
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
    text-align: center;
  }

  .lefted .copy {
    text-align: left;
  }

  .subtitle {
    color: rgba(190,220,255,.92);
    font-size: 28px;
    line-height: 1.28;
    font-weight: 500;
    max-width: 560px;
    margin-bottom: 18px;
    text-wrap: balance;
  }

  .centered .subtitle {
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
  }

  h1 {
    margin: 0;
    color: #fff;
    font-size: 78px;
    line-height: 0.98;
    letter-spacing: -0.04em;
    font-weight: 900;
    text-wrap: balance;
    max-width: 640px;
    text-shadow: 0 10px 30px rgba(0,0,0,.16);
  }

  .centered h1 {
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
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
    color: rgba(255,255,255,.95);
    font-size: 18px;
    font-weight: 700;
    line-height: 1;
    padding: 14px 18px;
    border-radius: 999px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.15);
    backdrop-filter: blur(18px);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
  }

  .counter {
    color: rgba(255,255,255,.86);
    min-width: 86px;
    text-align: center;
  }

  .num {
    color: #fff;
    font-weight: 900;
  }

  ${pageCss}
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

  const normalizedSlides = slides.map((slide, i) => ({
    title: safeText(slide.title || slide.headline || slide.text || "Untitled Slide", 120),
    subtitle: safeText(slide.subtitle || slide.subline || slide.kicker || "", 180),
    cta: safeText(slide.cta || "NEOX • AI Automation", 72),
    badge: safeText(slide.badge || "NEOX", 24),
    align: slide.align || "left",
    theme: slide.theme || "neox_dark",
    slideNumber: Number(slide.slideNumber || i + 1),
    totalSlides: Number(slide.totalSlides || slides.length),
    bgImageUrl: String(slide.bgImageUrl || slide.backgroundUrl || "").trim(),
    logoText: safeText(slide.logoText || "NEOX", 18),
    renderHints: {
      textPosition: slide?.renderHints?.textPosition || slide.align || "left",
      safeArea: slide?.renderHints?.safeArea || "left-heavy",
      overlayStrength: slide?.renderHints?.overlayStrength || "medium",
    },
  }));

  ensureDir(outDir);

  const html = buildHtml({ slides: normalizedSlides });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  try {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1080 },
      deviceScaleFactor: 1,
    });

    await page.setContent(html, { waitUntil: "networkidle" });

    const uploadsDir = path.resolve(process.cwd(), "uploads");
    const pageNodes = await page.$$(".page-wrap");
    const assets = [];

    for (let i = 0; i < pageNodes.length; i++) {
      const node = pageNodes[i];
      const hash = crypto.createHash("md5").update(`${Date.now()}-${i}-${normalizedSlides[i].title}`).digest("hex").slice(0, 10);
      const filename = `slide-${i + 1}-${hash}.png`;
      const filePath = path.join(outDir, filename);

      await node.screenshot({
        path: filePath,
        type: "png",
      });

      assets.push({
        file: filename,
        localPath: filePath,
        width: 1080,
        height: 1080,
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