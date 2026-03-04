// src/render/renderSlides.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeText(s, max = 220) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function buildHtml({ slides, theme = "hybrid" }) {
  // Minimal pro template (hybrid tech + viral)
  // 1080x1080
  const css = `
  html,body{margin:0;padding:0}
  .page{width:1080px;height:1080px;display:flex;align-items:stretch;justify-content:stretch;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .card{flex:1;border-radius:0;position:relative;overflow:hidden}
  .bg{position:absolute;inset:0;background:
      radial-gradient(900px 700px at 15% 20%, rgba(0,255,200,.22), transparent 60%),
      radial-gradient(900px 700px at 85% 80%, rgba(120,100,255,.22), transparent 60%),
      linear-gradient(180deg, #070A12 0%, #0A1024 60%, #070A12 100%);
  }
  .grain{position:absolute;inset:0;opacity:.10;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E");mix-blend-mode:overlay}
  .wrap{position:relative;z-index:2;padding:84px 86px;display:flex;flex-direction:column;height:100%;box-sizing:border-box}
  .brand{display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.85);font-weight:700;letter-spacing:.14em;font-size:18px}
  .dot{width:10px;height:10px;border-radius:999px;background:linear-gradient(135deg,#00FFD1,#7C5CFF)}
  .kicker{margin-top:54px;color:rgba(255,255,255,.70);font-size:22px;line-height:1.25;max-width:820px}
  h1{margin:18px 0 0 0;color:white;font-size:74px;line-height:1.03;letter-spacing:-0.02em;max-width:920px}
  .footer{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;color:rgba(255,255,255,.68);font-size:18px}
  .pill{padding:10px 14px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(255,255,255,.06);backdrop-filter: blur(10px)}
  .num{font-weight:800;color:white}
  `;
  const slidePages = slides.map((s, idx) => {
    const title = safeText(s.title || s.headline || s.text || "");
    const kicker = safeText(s.kicker || s.subtitle || "", 160);
    const cta = safeText(s.cta || "NEOX • AI HQ", 60);
    return `
    <div class="page">
      <div class="card">
        <div class="bg"></div>
        <div class="grain"></div>
        <div class="wrap">
          <div class="brand"><span class="dot"></span><span>NEOX</span></div>
          ${kicker ? `<div class="kicker">${kicker}</div>` : `<div class="kicker">AI komandası. CEO nəzarəti. Real nəticə.</div>`}
          <h1>${title || "Untitled Slide"}</h1>
          <div class="footer">
            <div class="pill">${cta}</div>
            <div class="pill"><span class="num">${idx + 1}</span> / ${slides.length}</div>
          </div>
        </div>
      </div>
    </div>`;
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=1080,height=1080"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${css}</style>
</head>
<body>
${slidePages.join("\n")}
</body>
</html>`;
}

export async function renderSlidesToPng({
  slides,
  outDir,
  publicBaseUrl,
}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error("slides[] required");
  }
  ensureDir(outDir);

  const html = buildHtml({ slides });

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });

    await page.setContent(html, { waitUntil: "load" });

    // each slide is one .page element
    const pages = await page.$$(".page");
    const assets = [];

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const filename = `slide-${i + 1}.png`;
      const filePath = path.join(outDir, filename);
      await p.screenshot({ path: filePath });
      const url = `${publicBaseUrl}/assets/${path.relative(path.resolve(process.cwd(), "uploads"), filePath).replace(/\\/g, "/")}`;
      assets.push({ url, width: 1080, height: 1080, file: filename });
    }
    return assets;
  } finally {
    await browser.close();
  }
}