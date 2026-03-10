// src/services/togetherImage.js
//
// FINAL v4.1 — premium tech-scene-first Together image generation
//
// Goals:
// ✅ Stop poster / website / dashboard / UI associations harder
// ✅ Push model toward premium text-free technology scene generation
// ✅ Support wider business-topic families through preset-aware prompting
// ✅ Keep one dominant subject and cleaner left side
// ✅ Reduce left blur / left fog / muddy overlay look
// ✅ Reduce fake typography / fake UI / baked branding risk
// ✅ Keep prompts commercially usable for render-later pipeline
// ✅ Tenant-aware Together credentials support
// ✅ Falls back to global env if tenant secret not set

import { getTenantTogetherConfig } from "./tenantProviderSecrets.js";

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

function uniq(arr) {
  return [...new Set((arr || []).map((x) => clean(x)).filter(Boolean))];
}

function safeLower(s) {
  return String(s || "").toLowerCase().trim();
}

function stripForbiddenTerms(input) {
  let t = clean(input);

  const patterns = [
    /\bwebsite\b/gi,
    /\bweb page\b/gi,
    /\blanding page\b/gi,
    /\bhomepage\b/gi,
    /\bhero section\b/gi,
    /\bhero banner\b/gi,
    /\bsite hero\b/gi,
    /\bweb hero\b/gi,
    /\bdashboard\b/gi,
    /\badmin panel\b/gi,
    /\banalytics panel\b/gi,
    /\banalytics screen\b/gi,
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
    /\btablet ui\b/gi,
    /\bsoftware screen\b/gi,
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
    /\bad poster\b/gi,
    /\bcampaign\b/gi,
    /\badvertisement\b/gi,
    /\badvertising\b/gi,
    /\bcommercial layout\b/gi,
    /\bkey art\b/gi,
    /\beditorial\b/gi,
    /\bbranded\b/gi,
    /\bbrand visual\b/gi,
    /\bmarketing\b/gi,
    /\bproduct marketing\b/gi,
    /\bsocial cover\b/gi,
    /\bcarousel cover\b/gi,
    /\bthumbnail design\b/gi,
    /\bcover design\b/gi,
    /\bposter design\b/gi,

    /\breadable text\b/gi,
    /\btext\b/gi,
    /\btypography\b/gi,
    /\bletters\b/gi,
    /\bwords\b/gi,
    /\bnumbers\b/gi,
    /\bheadline\b/gi,
    /\bsubheadline\b/gi,
    /\bsubtitle\b/gi,
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

    /\blogo\b/gi,
    /\blogomark\b/gi,
    /\bmonogram\b/gi,
    /\bwatermark\b/gi,
    /\bsignature\b/gi,
    /\blabel\b/gi,
    /\blabels\b/gi,
    /\bbrand name\b/gi,
    /\bproduct name\b/gi,
  ];

  for (const re of patterns) {
    t = t.replace(re, " ");
  }

  return clean(t);
}

function normalizeCorePrompt(prompt) {
  const raw = clean(prompt);
  const stripped = stripForbiddenTerms(raw);

  if (stripped) return truncate(stripped, 1400);

  return "premium futuristic automation device in a dark studio, engineered industrial materials, controlled cyan blue lighting, text-free clean composition";
}

function detectAspectRatio(aspectRatio, width, height) {
  const ar = clean(aspectRatio);

  if (ar === "9:16" || ar === "4:5" || ar === "1:1") return ar;

  const w = Number(width) || 0;
  const h = Number(height) || 0;

  if (w > 0 && h > 0) {
    const ratio = w / h;
    if (Math.abs(ratio - 1) < 0.08) return "1:1";
    if (Math.abs(ratio - 0.8) < 0.08) return "4:5";
    if (Math.abs(ratio - 0.5625) < 0.08) return "9:16";
  }

  return "1:1";
}

function aspectRatioDirection(aspectRatio) {
  if (aspectRatio === "9:16") {
    return clean(`
Vertical 9:16 framing.
One dominant focal subject.
Premium cinematic vertical composition.
Keep the left side calmer and cleaner, but not fogged out.
Avoid large blur masses.
Strong central or upper-right visual gravity.
    `);
  }

  if (aspectRatio === "4:5") {
    return clean(`
Vertical 4:5 framing.
Balanced premium social composition.
One dominant focal subject.
Keep the left side visually cleaner with reduced haze.
Avoid muddy dark blur overlays.
Prefer a strong right or center-right focal subject.
    `);
  }

  return clean(`
Square 1:1 framing.
Stable premium composition.
One dominant focal subject.
Keep the composition balanced and uncluttered.
Avoid heavy left-side blur or fog.
  `);
}

function detectVisualPreset(prompt, visualPreset) {
  const preset = clean(visualPreset);
  if (
    preset === "robotic_unit" ||
    preset === "ai_core" ||
    preset === "automation_device" ||
    preset === "abstract_tech_scene"
  ) {
    return preset;
  }

  const p = safeLower(prompt);

  if (
    /\b(chatbot|assistant|receptionist|support agent|voice assistant|service robot|customer support)\b/.test(
      p
    )
  ) {
    return "robotic_unit";
  }

  if (
    /\b(crm|workflow|lead|pipeline|reporting|operations|onboarding|routing|automation|process|sales automation|follow-up|ticket)\b/.test(
      p
    )
  ) {
    return "automation_device";
  }

  if (
    /\b(future|innovation|intelligence|transformation|infrastructure|neural|core|ai system|ai energy)\b/.test(
      p
    )
  ) {
    return "ai_core";
  }

  return "abstract_tech_scene";
}

function detectTopicFamily(prompt, topic) {
  const t = safeLower(`${topic || ""} ${prompt || ""}`);

  if (/\b(chatbot|assistant|dm|whatsapp|messenger|website assistant|support)\b/.test(t)) {
    return "conversational_ai";
  }
  if (/\b(lead|qualification|pipeline|follow-up|crm|sales)\b/.test(t)) {
    return "sales_automation";
  }
  if (/\b(onboarding|hr|recruitment|screening|employee)\b/.test(t)) {
    return "hr_automation";
  }
  if (/\b(reporting|analytics|insight|brief|summary|dashboard)\b/.test(t)) {
    return "insight_automation";
  }
  if (/\b(content|caption|comment|publishing|social media)\b/.test(t)) {
    return "content_automation";
  }
  if (/\b(appointment|booking|clinic|healthcare)\b/.test(t)) {
    return "booking_automation";
  }
  if (/\b(e-commerce|cart|retention|upsell|reactivation|order)\b/.test(t)) {
    return "commerce_automation";
  }
  if (/\b(logistics|field|operations|coordination|routing)\b/.test(t)) {
    return "ops_automation";
  }
  if (/\b(education|enrollment|course|student)\b/.test(t)) {
    return "education_automation";
  }
  if (/\b(real estate|property|inquiry)\b/.test(t)) {
    return "real_estate_automation";
  }

  return "general_automation";
}

function buildPresetBlock(visualPreset) {
  if (visualPreset === "robotic_unit") {
    return clean(`
Preset focus: robotic_unit.
Create a premium robotic or semi-robotic hero object.
Elegant service-robot form, intelligent machine silhouette, sculptural industrial design.
Dark premium studio environment.
High-end materials, refined contours, believable engineered surfaces.
Keep the robot/object iconic, minimal, and commercially usable.
    `);
  }

  if (visualPreset === "ai_core") {
    return clean(`
Preset focus: ai_core.
Create an abstract intelligent AI core, neural nucleus, or central energy module.
Iconic, atmospheric, premium, futuristic, layered depth.
Controlled light emission, refined glow, elegant central form.
Less literal product design, more visionary but still believable.
    `);
  }

  if (visualPreset === "automation_device") {
    return clean(`
Preset focus: automation_device.
Create a premium engineered automation device, control module, smart terminal, or system-grade hardware object.
The object must feel precise, functional, intelligent, and product-grade.
Use premium industrial materials and believable engineering detail.
    `);
  }

  return clean(`
Preset focus: abstract_tech_scene.
Create a premium high-tech environment or spatial technology scene.
Elegant futuristic architecture, engineered structures, refined light forms, spatial depth.
Atmospheric but still clean, minimal, and commercially usable.
  `);
}

function buildTopicBlock(topicFamily) {
  const map = {
    conversational_ai: `
Topic family: conversational AI.
Use subtle communication energy, listening intelligence, service presence, soft signal arcs, assistant-like machine behavior.
Avoid chat windows, message bubbles, UI panels, or readable interface.
    `,
    sales_automation: `
Topic family: sales automation.
Use concepts like flow, routing, precision intake, sequencing, conversion movement, structured signal transfer.
Represent these through engineered hardware, light rails, data capsules, modular pathways, or smart terminal forms.
    `,
    hr_automation: `
Topic family: HR / recruitment automation.
Use ideas like screening, sorting, qualification, onboarding flow, structured evaluation.
Represent these through clean intelligent modules, precision channels, staged signal movement, or organized machine systems.
    `,
    insight_automation: `
Topic family: insight automation.
Use ideas like intelligence condensation, signal synthesis, executive clarity, smart summarization.
Represent through compact premium cores, layered light volumes, refined system nodes, or information distilled into a single engineered object.
    `,
    content_automation: `
Topic family: content automation.
Use ideas like creative engine, production flow, orchestration, controlled generation, premium output system.
Represent through futuristic production modules, elegant energy channels, synchronized machine elements, or refined multi-stage automation hardware.
    `,
    booking_automation: `
Topic family: booking / appointment automation.
Use ideas like scheduling flow, confirmation routing, precision intake, service coordination.
Represent through sleek terminal systems, routing channels, signal docking, or elegant service hardware.
    `,
    commerce_automation: `
Topic family: commerce automation.
Use ideas like retention, reactivation, order flow, lifecycle movement, intelligent touchpoints.
Represent through modular product-grade systems, elegant throughput channels, smart capsules, or precision commerce-related automation hardware.
    `,
    ops_automation: `
Topic family: operations automation.
Use ideas like orchestration, routing, timing, coordination, process integrity.
Represent through industrial system modules, controlled flow tracks, logistics-like signal movement, or engineered machine systems.
    `,
    education_automation: `
Topic family: education automation.
Use ideas like guided progression, enrollment flow, structured learning support, knowledge pathways.
Represent through clean system modules, subtle intelligence layers, progression channels, or supportive tech apparatus.
    `,
    real_estate_automation: `
Topic family: real estate automation.
Use ideas like inquiry routing, matching, fast qualification, premium lead handling.
Represent through elegant terminal hardware, precision intake forms, or signal-routing automation objects.
    `,
    general_automation: `
Topic family: general business automation.
Use ideas like speed, precision, operational intelligence, workflow control, cost-saving, time-saving, smart systems.
Represent through premium engineered automation hardware, AI-driven modules, or clean high-tech system objects.
    `,
  };

  return clean(map[topicFamily] || map.general_automation);
}

function buildPositivePrompt({
  prompt,
  aspectRatio,
  visualPreset,
  topic,
  topicFamily,
}) {
  const core = normalizeCorePrompt(prompt);
  const presetBlock = buildPresetBlock(visualPreset);
  const topicBlock = buildTopicBlock(topicFamily);
  const arLine = aspectRatioDirection(aspectRatio);

  return truncate(
    clean(`
Create a premium TEXT-FREE futuristic technology scene.

Core idea:
${core}

Topic context:
${clean(topic || "")}

${presetBlock}

${topicBlock}

Visual direction:
- one dominant focal subject
- premium engineered object, robotic element, AI core, automation hardware, or elegant futuristic machine-like form
- dark minimal studio environment or clean premium high-tech spatial scene
- graphite, obsidian, black metal, smoked glass, polished composite surfaces, premium industrial materials
- subtle cyan and blue lighting with restrained white highlights
- refined reflections
- cinematic depth
- controlled glow only
- commercially usable realism
- minimal number of objects
- clean uncluttered composition
- balanced premium framing
- left side slightly calmer for later render placement
- NO heavy blur fog wall on the left side
- NO muddy black gradient mass on the left side
- NO oversized bloom cloud on the left side
- keep the left side clean, elegant, and lightly open
- make the subject clear and strong, not buried in atmosphere

Scene quality:
- premium industrial design language
- elegant shape language
- believable object construction
- subtle volumetric light
- refined atmosphere
- clean depth separation
- premium studio-grade lighting
- no cheap sci-fi clutter
- no fantasy chaos
- no cartoon style
- no startup website aesthetic

Device rule:
- if any screen, monitor, panel, phone, or terminal appears, it must remain abstract and unreadable
- screens may only show ambient gradients, soft reflections, abstract light waves, or non-readable luminous surfaces
- absolutely no interface details

Composition rule:
- do not make it look like a website section
- do not make it look like a poster
- do not make it look like a software UI
- do not make it look like a social template
- do not create floating dashboard cards
- do not arrange the scene like a banner layout
- do not center everything in a flat generic way
- preserve depth, object hierarchy, and premium tension
- prefer right-side or center-right focal bias when helpful
- keep the frame usable for future text rendering without obvious text placeholders

${arLine}

Absolute requirements:
- no readable text
- no letters
- no words
- no numbers
- no symbols
- no logo
- no label
- no signage
- no fake branding
- no interface
- no dashboard
- no website-like composition
- no app-like composition
- no poster-like composition
    `),
    2600
  );
}

function buildNegativePrompt() {
  return clean(`
text, readable text, letters, words, numbers, typography, headline, subtitle, caption, labels,
logo, logomark, monogram, watermark, signature, branding, brand name, product name,
website, web page, landing page, homepage, hero section, hero banner, browser window, browser chrome,
dashboard, admin panel, analytics screen, saas ui, ui design, user interface, interface mockup,
mobile app, app screen, app ui, phone ui, tablet ui, software screen,
navigation bar, navbar, menu, header, footer, button, cta button, search bar,
widget grid, card ui, chart ui, graph ui, floating ui cards,
poster, poster design, campaign poster, ad poster, social media cover, thumbnail layout, banner design,
screenshot, screen capture, figma mockup, dribbble shot,
fake labels, fake buttons, fake interface, startup homepage look,
copy space, text area, title area, headline area,
muddy left blur, oversized fog wall, blurry dark overlay, washed composition,
busy layout, clutter, crowded composition, cheap template look, blurry text
  `);
}

function clampN(n) {
  const v = Number(n) || 1;
  if (v < 1) return 1;
  if (v > 4) return 4;
  return v;
}

function shouldSendExplicitSize(model) {
  return !/ideogram/i.test(String(model || ""));
}

function mapAspectRatioToSize(aspectRatio, width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;

  if (w > 0 && h > 0) {
    return { width: w, height: h };
  }

  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  if (aspectRatio === "4:5") return { width: 1080, height: 1350 };
  return { width: 1080, height: 1080 };
}

function buildMeta({
  prompt,
  topic,
  visualPreset,
  topicFamily,
  aspectRatio,
  width,
  height,
  credentialSource,
  tenantKey,
}) {
  return {
    topic: clean(topic),
    visualPreset,
    topicFamily,
    aspectRatio,
    requestedWidth: Number(width) || null,
    requestedHeight: Number(height) || null,
    normalizedInputPrompt: normalizeCorePrompt(prompt),
    credentialSource: clean(credentialSource || "env"),
    tenantKey: clean(tenantKey || ""),
  };
}

async function resolveTogetherCredentials({ db, tenantKey }) {
  const envApiKey = String(process.env.TOGETHER_API_KEY || "").trim();
  const envModel = String(
    process.env.TOGETHER_IMAGE_MODEL || "ideogram/ideogram-3.0"
  ).trim();

  const safeTenantKey = clean(tenantKey);

  if (!db || !safeTenantKey) {
    return {
      apiKey: envApiKey,
      model: envModel,
      credentialSource: "env",
    };
  }

  try {
    const tenantCfg = await getTenantTogetherConfig(db, safeTenantKey);
    const tenantApiKey = clean(tenantCfg?.apiKey);
    const tenantModel = clean(tenantCfg?.model);

    if (tenantApiKey) {
      return {
        apiKey: tenantApiKey,
        model: tenantModel || envModel,
        credentialSource: "tenant_secret",
      };
    }
  } catch {
    // fallback
  }

  return {
    apiKey: envApiKey,
    model: envModel,
    credentialSource: "env",
  };
}

export async function togetherGenerateImage({
  prompt,
  topic = "",
  visualPreset = "",
  n = 1,
  width,
  height,
  aspectRatio = "1:1",
  db = null,
  tenantKey = "",
}) {
  const creds = await resolveTogetherCredentials({ db, tenantKey });
  const apiKey = clean(creds.apiKey);

  if (!apiKey) {
    throw new Error("TOGETHER_API_KEY not set and tenant secret not found");
  }

  const model = clean(creds.model || "ideogram/ideogram-3.0");

  const finalAspectRatio = detectAspectRatio(aspectRatio, width, height);
  const finalPreset = detectVisualPreset(prompt, visualPreset);
  const topicFamily = detectTopicFamily(prompt, topic);
  const explicitSize = mapAspectRatioToSize(finalAspectRatio, width, height);

  const safePrompt = buildPositivePrompt({
    prompt,
    topic,
    aspectRatio: finalAspectRatio,
    visualPreset: finalPreset,
    topicFamily,
  });

  const negativePrompt = buildNegativePrompt();

  const body = {
    model,
    prompt: safePrompt,
    negative_prompt: negativePrompt,
    n: clampN(n),
    response_format: "url",
  };

  if (shouldSendExplicitSize(model)) {
    body.width = explicitSize.width;
    body.height = explicitSize.height;
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
      data?.error ||
      `Together error (${r.status})`;
    throw new Error(String(msg));
  }

  const items = Array.isArray(data?.data) ? data.data : [];
  const urls = uniq(items.map((x) => x?.url).filter(Boolean));
  const url = urls[0] || "";

  if (!url) {
    throw new Error("Together returned no url");
  }

  return {
    url,
    urls,
    raw: data,
    usedModel: model,
    usedPrompt: safePrompt,
    usedNegativePrompt: negativePrompt,
    meta: buildMeta({
      prompt,
      topic,
      visualPreset: finalPreset,
      topicFamily,
      aspectRatio: finalAspectRatio,
      width: explicitSize.width,
      height: explicitSize.height,
      credentialSource: creds.credentialSource,
      tenantKey,
    }),
  };
} 
