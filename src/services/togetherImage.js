// src/services/togetherImage.js
//
// FINAL v3.0 — tech-scene-first Together image generation
//
// Goals:
// ✅ Stop poster / ad / hero / website associations
// ✅ Push model toward clean technology scene generation
// ✅ Prefer one strong object / robotic / automation / AI-related subject
// ✅ Keep output text-free
// ✅ Reduce baked typography / fake UI / fake branding risk

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

    /\bposter\b/gi,
    /\bcampaign\b/gi,
    /\badvertisement\b/gi,
    /\badvertising\b/gi,
    /\bcommercial\b/gi,
    /\bkey art\b/gi,
    /\beditorial\b/gi,
    /\bbranded\b/gi,
    /\bbrand visual\b/gi,
    /\bmarketing\b/gi,
    /\bproduct marketing\b/gi,
    /\bsocial cover\b/gi,
    /\bcarousel cover\b/gi,
    /\bthumbnail design\b/gi,

    /\breadable text\b/gi,
    /\btypography\b/gi,
    /\bletters\b/gi,
    /\bwords\b/gi,
    /\bnumbers\b/gi,
    /\blogo\b/gi,
    /\blogomark\b/gi,
    /\bmonogram\b/gi,
    /\bwatermark\b/gi,
    /\bsignature\b/gi,
    /\blabel\b/gi,
    /\blabels\b/gi,
    /\bsubtitle\b/gi,
    /\bheadline\b/gi,
    /\bcaption\b/gi,
    /\bcopy\b/gi,
    /\bcopy-safe\b/gi,
    /\bcopy safe\b/gi,
    /\btext-safe\b/gi,
    /\btext safe\b/gi,
    /\btitle area\b/gi,
    /\bheadline area\b/gi,
    /\bcopy area\b/gi,
    /\btext area\b/gi,
    /\bnegative space\b/gi,
  ];

  for (const re of patterns) t = t.replace(re, " ");

  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function normalizeCorePrompt(prompt) {
  const raw = clean(prompt);
  const stripped = stripForbiddenTerms(raw);

  if (stripped) return truncate(stripped, 1100);

  return "minimal futuristic technology object in a dark studio, premium industrial design, controlled blue cyan lighting, clean composition";
}

function aspectRatioDirection(aspectRatio) {
  const ar = String(aspectRatio || "").trim();
  if (ar === "9:16") {
    return "Vertical 9:16 framing. Clean technology scene. One dominant focal subject. Strong upper or central composition.";
  }
  if (ar === "4:5") {
    return "Vertical 4:5 framing. Clean technology scene. One dominant focal subject. Balanced composition.";
  }
  return "Square 1:1 framing. Clean technology scene. One dominant focal subject. Stable centered or slightly offset composition.";
}

function buildPositivePrompt({ prompt, aspectRatio }) {
  const core = normalizeCorePrompt(prompt);
  const arLine = aspectRatioDirection(aspectRatio);

  return clean(`
Create a text-free futuristic technology scene.

${core}

Visual direction:
- one dominant technology-related focal subject
- premium industrial design object, robotic element, automation device, AI core, or elegant machine-like form
- dark minimal studio environment
- graphite, black metal, glass, premium engineered materials
- subtle cyan and blue lighting
- soft reflections
- cinematic depth
- controlled glow
- clean uncluttered composition
- minimal number of objects
- no decorative poster layout

Device rule:
- if a screen, phone, panel, monitor, or device appears, keep it abstract and unreadable
- use only ambient gradients, reflections, glow, or abstract light waves on screens
- no interface details

Scene rule:
- prefer object rendering, studio scene, premium product-like technology object, robotic form, automation hardware, abstract AI machinery, or futuristic engineered device
- avoid busy scenes
- avoid crowded multi-object compositions
- avoid graphic design layout
- avoid poster-like arrangement

${arLine}

Absolute requirements:
- no readable text
- no letters
- no words
- no numbers
- no symbols
- no logo
- no label
- no fake branding
- no interface
- no website-like composition
- no app-like composition
  `);
}

function buildNegativePrompt() {
  return clean(`
text, readable text, letters, words, numbers, typography, subtitles, labels,
logo, logomark, monogram, watermark, signature, branding, fake brand text,
website, web page, landing page, homepage, hero section, browser window, browser chrome,
dashboard, admin panel, analytics screen, saas ui, ui design, user interface, interface mockup,
mobile app, app screen, app ui, phone ui, tablet ui, software screen,
navigation bar, navbar, menu, header, footer, button, cta button, search bar,
widget grid, card ui, chart ui, graph ui,
poster, campaign poster, ad poster, social media cover, thumbnail layout,
screenshot, screen capture, figma mockup, dribbble shot,
fake labels, fake buttons, fake interface, startup homepage look,
busy layout, clutter, crowded composition, cheap template look, blurry text
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

  // ideogram üçün width/height göndərmirik
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