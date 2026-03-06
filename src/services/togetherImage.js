// src/services/togetherImage.js

function clean(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  const t = clean(s);
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)).trim() + "…";
}

function stripForbiddenTerms(input) {
  let t = clean(input);

  const patterns = [
    /\bwebsite\b/gi,
    /\bweb page\b/gi,
    /\blanding page\b/gi,
    /\bhomepage\b/gi,
    /\bhero section\b/gi,
    /\bsite hero\b/gi,
    /\bdashboard\b/gi,
    /\badmin panel\b/gi,
    /\banalytics panel\b/gi,
    /\bsaas ui\b/gi,
    /\bui\b/gi,
    /\buser interface\b/gi,
    /\binterface\b/gi,
    /\binterface mockup\b/gi,
    /\bui mockup\b/gi,
    /\bapp ui\b/gi,
    /\bapp screen\b/gi,
    /\bmobile app\b/gi,
    /\bphone ui\b/gi,
    /\bbrowser window\b/gi,
    /\bbrowser chrome\b/gi,
    /\bnavbar\b/gi,
    /\bnavigation bar\b/gi,
    /\bmenu\b/gi,
    /\bheader\b/gi,
    /\bfooter\b/gi,
    /\bbutton\b/gi,
    /\bcta button\b/gi,
    /\bwidget\b/gi,
    /\bcard ui\b/gi,
    /\bchart ui\b/gi,
    /\bgraph ui\b/gi,
    /\bscreenshot\b/gi,
    /\bscreen capture\b/gi,
    /\bfigma mockup\b/gi,
    /\bdribbble shot\b/gi,
    /\breadable text\b/gi,
    /\btypography\b/gi,
    /\bletters\b/gi,
    /\bwords\b/gi,
    /\bnumbers\b/gi,
    /\blogo\b/gi,
    /\bmonogram\b/gi,
    /\bwatermark\b/gi,
    /\bsubtitle\b/gi,
    /\bheadline\b/gi,
    /\bcaption\b/gi,
    /\bcopy\b/gi,
  ];

  for (const re of patterns) t = t.replace(re, " ");

  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function normalizeCorePrompt(prompt) {
  const raw = clean(prompt);
  const stripped = stripForbiddenTerms(raw);

  if (stripped) return truncate(stripped, 1400);

  return "premium futuristic campaign artwork, elegant tech atmosphere, strong focal subject, cinematic lighting, polished materials, clean negative space";
}

function aspectRatioDirection(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "9:16") {
    return "Vertical 9:16 composition, premium social video cover framing, strong upper/mid focal subject, generous text-safe negative space.";
  }
  if (ar === "4:5") {
    return "Vertical 4:5 composition, premium social campaign poster framing, balanced focal subject with elegant text-safe negative space.";
  }
  return "Square 1:1 composition, premium carousel cover framing, strong visual center with clean text-safe negative space.";
}

function buildPositivePrompt({ prompt, aspectRatio }) {
  const core = normalizeCorePrompt(prompt);
  const arLine = aspectRatioDirection(aspectRatio);

  return clean(`
Premium commercial campaign artwork for a high-end AI automation and digital technology brand.
Text-free background visual only.
${core}

Art direction:
- polished advertising-grade composition
- cinematic premium lighting
- modern futuristic atmosphere
- elegant depth and premium materials
- visually memorable but clean
- strong focal subject
- controlled glow, not cluttered
- clear text-safe negative space for later overlay
- commercial key-art quality
- editorial tech poster mood, not interface design

Device rule:
- if a phone, tablet, or screen appears, keep the screen abstract, ambient, and unreadable
- use only soft gradients, light waves, reflections, or abstract glow on screens
- no interface details

Composition rule:
- prioritize one main focal subject
- keep the layout clean and premium
- avoid busy multi-object clutter
- leave breathing room for later typography placement

${arLine}

Absolute requirement:
- no readable text inside the image
- no fake branding inside the image
- no UI-like composition
  `);
}

function buildNegativePrompt() {
  return clean(`
readable text, letters, words, numbers, typography, captions, subtitles, labels,
logo, logomark, monogram, watermark, signature,
website, web page, landing page, homepage, hero section, browser window, browser chrome,
dashboard, admin panel, analytics screen, saas ui, ui design, user interface, interface mockup,
mobile app, app screen, app ui, phone ui, tablet ui,
navigation bar, navbar, menu, header, footer, button, cta button, search bar,
widget grid, card ui, chart ui, graph ui,
fake brand text, fake product text, fake labels, fake buttons,
screenshot, screen capture, figma mockup, dribbble shot,
busy layout, clutter, cheap template look, startup homepage look, blurry text
  `);
}

export async function togetherGenerateImage({
  prompt,
  n = 1,
  width,
  height,
  aspectRatio = "1:1",
}) {
  const apiKey = String(process.env.TOGETHER_API_KEY || "").trim();
  if (!apiKey) throw new Error("TOGETHER_API_KEY not set");

  const model = String(
    process.env.TOGETHER_IMAGE_MODEL || "ideogram/ideogram-3.0"
  ).trim();

  const safePrompt = buildPositivePrompt({ prompt, aspectRatio });
  const negativePrompt = buildNegativePrompt();

  const body = {
    model,
    prompt: safePrompt,
    negative_prompt: negativePrompt,
    n: Number(n) || 1,
    response_format: "url",
  };

  if (!/ideogram/i.test(model)) {
    if (Number(width) > 0) body.width = Number(width);
    if (Number(height) > 0) body.height = Number(height);
  }

  const r = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `Together error (${r.status})`;
    throw new Error(msg);
  }

  const url = data?.data?.[0]?.url || "";
  if (!url) throw new Error("Together returned no url");

  return {
    url,
    raw: data,
    usedModel: model,
    usedPrompt: safePrompt,
    usedNegativePrompt: negativePrompt,
  };
}