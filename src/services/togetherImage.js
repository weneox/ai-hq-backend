// src/services/togetherImage.js

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildNegativePrompt() {
  return clean(`
readable text, letters, words, numbers, typography, captions, subtitles, labels,
logo, logo mark, monogram, watermark, signature,
website, web page, landing page, homepage, hero section, browser window, browser chrome,
dashboard, admin panel, analytics screen, saas ui, ui design, interface, interface mockup,
mobile app, app screen, app ui, phone ui, tablet ui,
navigation bar, navbar, menu, header, footer, button, cta button, search bar,
widget grid, card ui, chart ui, graph ui,
fake brand text, fake product text, fake labels, fake buttons,
screenshot, screen capture, figma mockup, dribbble shot,
busy layout, clutter, low quality, blurry details
  `);
}

function hardenPrompt(prompt) {
  const p = clean(prompt);

  return clean(`
${p}

HARD REQUIREMENTS:
- Generate TEXT-FREE visual artwork only.
- No readable text anywhere in the image.
- No letters, no words, no numbers, no labels.
- No logos or logo-like symbols.
- No website sections.
- No landing page hero.
- No browser window framing.
- No dashboard interface.
- No mobile app interface.
- No buttons, menus, navigation, or UI widgets.
- This must look like premium commercial campaign artwork, not a product UI shot.
- Focus on atmosphere, composition, premium lighting, focal subject, materials, depth, and elegant negative space.
- Keep a clean copy-safe zone for later typography overlay.
- The result must be visually premium, polished, and text-free.
  `);
}

export async function togetherGenerateImage({
  prompt,
  n = 1,
  width,
  height,
}) {
  const apiKey = String(process.env.TOGETHER_API_KEY || "").trim();
  if (!apiKey) throw new Error("TOGETHER_API_KEY not set");

  const model = String(
    process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell-Free"
  ).trim();

  const safePrompt = hardenPrompt(prompt);
  const negativePrompt = buildNegativePrompt();

  const body = {
    model,
    prompt: safePrompt,
    negative_prompt: negativePrompt,
    n: Number(n) || 1,
    response_format: "url",
  };

  // ideogram üçün width/height göndərmə
  // flux üçün width/height göndərmək olar
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