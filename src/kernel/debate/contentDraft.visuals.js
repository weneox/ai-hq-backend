// src/kernel/debate/contentDraft.visuals.js

import {
  asArr,
  asObj,
  fixMojibake,
  lower,
  truncate,
  uniqStrings,
} from "./utils.js";
import { normalizeIndustryKey } from "../../prompts/industries/index.js";

const ALLOWED_FORMATS = ["image", "carousel", "reel"];
const ALLOWED_VISUAL_PRESETS = [
  "robotic_unit",
  "ai_core",
  "automation_device",
  "abstract_tech_scene",
  "chatbot_operator",
  "sales_flow_machine",
  "support_ai_hub",
  "workflow_engine",
];

function s(v) {
  return String(v ?? "").trim();
}

function normalizeLang(v, fallback = "az") {
  const x = s(v).toLowerCase();
  if (!x) return fallback;
  if (["az", "aze", "azerbaijani"].includes(x)) return "az";
  if (["en", "eng", "english"].includes(x)) return "en";
  if (["ru", "rus", "russian"].includes(x)) return "ru";
  if (["tr", "tur", "turkish"].includes(x)) return "tr";
  return x;
}

function joinText(arr = [], fallback = "") {
  const out = asArr(arr)
    .map((x) => {
      if (typeof x === "string") return s(x);
      if (x && typeof x === "object") {
        return s(x.name || x.title || x.label || x.value || "");
      }
      return "";
    })
    .filter(Boolean);

  return out.length ? out.join(", ") : fallback;
}

function getTenantRuntime(payloadOrVars = {}) {
  const src = asObj(payloadOrVars);
  const tenant = asObj(src.tenant || src.vars?.tenant || {});
  const tenantProfile = asObj(tenant.profile);
  const tenantBrand = asObj(tenant.brand);
  const tenantAiPolicy = asObj(tenant.ai_policy || tenant.aiPolicy);

  const tenantId =
    s(
      src.tenantId ||
        src.vars?.tenantId ||
        tenant.tenantId ||
        tenant.tenantKey ||
        tenant.id ||
        "default"
    ) || "default";

  const companyName =
    s(
      tenantBrand.displayName ||
        tenantBrand.name ||
        tenantProfile.displayName ||
        tenantProfile.companyName ||
        tenant.companyName ||
        tenant.brandName ||
        tenant.name
    ) || tenantId;

  const outputLanguage = normalizeLang(
    tenant.outputLanguage ||
      tenant.language ||
      tenantProfile.outputLanguage ||
      tenantProfile.language ||
      tenant.defaultLanguage ||
      tenantProfile.defaultLanguage ||
      src.language ||
      src.vars?.language ||
      "az",
    "az"
  );

  const visualTheme =
    s(
      tenant.visualTheme ||
        tenantBrand.visualTheme ||
        tenantProfile.visualTheme ||
        src.theme ||
        src.vars?.theme ||
        "premium_modern"
    ) || "premium_modern";

  const industryKey = normalizeIndustryKey(
    tenant.industryKey ||
      tenantProfile.industryKey ||
      tenant.industry ||
      tenantProfile.industry ||
      src.industryKey ||
      src.vars?.industryKey ||
      "generic_business"
  );

  const businessContext =
    s(
      tenant.businessContext ||
        tenantProfile.businessContext ||
        tenantAiPolicy.businessContext ||
        src.businessContext ||
        src.vars?.businessContext
    ) || "";

  const servicesText =
    s(tenant.servicesText || tenantProfile.servicesText || src.servicesText || src.vars?.servicesText) ||
    joinText(tenant.services);

  const audiencesText =
    s(tenant.audiencesText || tenantProfile.audiencesText || src.audiencesText || src.vars?.audiencesText) ||
    joinText(tenant.audiences);

  return {
    tenantId,
    companyName,
    outputLanguage,
    visualTheme,
    industryKey,
    businessContext,
    servicesText,
    audiencesText,
  };
}

function defaultBrandBadge() {
  return "SYSTEM";
}

function buildNoTextRules() {
  return [
    "Absolutely no readable text anywhere in the image.",
    "Do not generate any letters, words, sentences, captions, slogans, labels, UI text, or typographic elements.",
    "Do not generate logos, brand marks, monograms, icons with letters, numbers, symbols, signs, watermarks, or signatures.",
    "Do not generate posters, ads, banners, packaging text, interface cards, dashboards, app screens, websites, browser windows, or presentation boards.",
    "If any panel, device, display, glass surface, packaging, signage, or interface-like object appears, it must remain fully abstract, blurred, ambient, and unreadable.",
    "No typography, no alphanumeric characters, no calligraphy, no glyphs, no symbolic marks, no fake text.",
    "This image is background artwork only. Text will be added later by a separate render engine.",
  ];
}

function isTechnologyIndustry(industryKey = "") {
  return normalizeIndustryKey(industryKey) === "technology";
}

function getIndustryVisualPack(industryKey = "") {
  const key = normalizeIndustryKey(industryKey);

  const map = {
    clinic: {
      style:
        "Clean premium healthcare visual, reassuring and professional atmosphere, refined medical interior realism, hygienic surfaces, calm balanced light, trust-first clinical elegance",
      composition:
        "One coherent clinic or consultation scene, calm spatial order, welcoming front-desk or treatment-adjacent environment, open composition, no chaos, no tech fantasy",
      elements: [
        "modern clinic reception",
        "clean consultation environment",
        "calm professional medical interior",
        "organized patient-support atmosphere",
      ],
      negative: [
        "no gore",
        "no disturbing medical imagery",
        "no fear-driven atmosphere",
        "no cyberpunk or robotic medical world",
      ],
    },
    restaurant: {
      style:
        "Premium hospitality food visual, rich texture realism, warm inviting dining mood, believable plating, elegant restaurant or cafe atmosphere, appetizing but controlled styling",
      composition:
        "One coherent food or dining scene with strong appetite appeal, premium table or service setting, warm spatial depth, natural hospitality composition",
      elements: [
        "inviting plated food",
        "warm dining atmosphere",
        "clean table styling",
        "hospitality-led scene",
      ],
      negative: [
        "no robots",
        "no unrelated tech objects",
        "no fake menu typography",
        "no sci-fi restaurant imagery",
      ],
    },
    hospitality: {
      style:
        "Calm premium hospitality visual, elegant interiors, warm guest-centered atmosphere, polished room or reception experience, reassuring service feel, destination-worthy but believable",
      composition:
        "One coherent stay or guest-experience scene, calm open layout, polished hospitality environment, comfort-first composition, no clutter",
      elements: [
        "premium room or suite atmosphere",
        "welcoming lobby or reception",
        "guest comfort cues",
        "calm elegant hospitality interior",
      ],
      negative: [
        "no robotic service fantasy",
        "no fake luxury overload",
        "no travel-poster clutter",
        "no dashboard-like tech scene",
      ],
    },
    beauty: {
      style:
        "Polished beauty-service visual, elegant salon or studio atmosphere, premium textures, refined self-care mood, clean and modern styling, confidence-supportive without exaggeration",
      composition:
        "One coherent beauty-service or studio scene, premium spatial balance, tasteful focus, soft controlled lighting, no medical coldness unless clearly aesthetic-medical",
      elements: [
        "elegant salon environment",
        "refined beauty workstation",
        "premium self-care atmosphere",
        "clean stylish service setting",
      ],
      negative: [
        "no robots",
        "no harsh clinical lab feel",
        "no tacky before-after ad vibe",
        "no fake glamour overload",
      ],
    },
    legal: {
      style:
        "Refined professional legal visual, composed advisory atmosphere, premium office realism, serious but approachable environment, clear order, calm authority, trust-led corporate polish",
      composition:
        "One coherent advisory or consultation environment, clean desk or meeting setting, strong spatial order, restrained premium tone, no drama",
      elements: [
        "professional office setting",
        "consultation table or advisory desk",
        "document-review atmosphere",
        "structured legal workspace",
      ],
      negative: [
        "no courtroom fantasy drama",
        "no justice-symbol spam",
        "no robots",
        "no flashy tech-world imagery",
      ],
    },
    finance: {
      style:
        "Clean premium financial-services visual, structured corporate atmosphere, precise and calm business environment, responsible advisory tone, minimal refined professionalism",
      composition:
        "One coherent advisory, reporting, or consultation scene, orderly workspace, calm authority, polished but restrained office composition",
      elements: [
        "professional advisory setting",
        "organized desk or review space",
        "structured financial workflow mood",
        "premium corporate clarity",
      ],
      negative: [
        "no crypto-fantasy imagery",
        "no wealth-glamour excess",
        "no robots",
        "no chaotic trading-screen world",
      ],
    },
    education: {
      style:
        "Modern educational visual, supportive and aspirational learning atmosphere, clear structured environment, motivated but realistic learner energy, trustworthy academic or training mood",
      composition:
        "One coherent classroom, workshop, or learning-support scene, strong focus, organized study environment, positive progress feel, no chaos",
      elements: [
        "modern learning environment",
        "mentor or instructor guidance",
        "organized educational materials",
        "focused student atmosphere",
      ],
      negative: [
        "no robots",
        "no unrelated tech fantasy",
        "no fake graduation-poster vibe",
        "no dashboard-heavy business scene",
      ],
    },
    retail: {
      style:
        "Clean product-led retail visual, attractive merchandising, trust-oriented shopping atmosphere, commercially useful presentation, brand-appropriate realism, conversion-friendly clarity",
      composition:
        "One coherent product or store scene, organized display, clear focal product story, clean commercial depth, no cluttered marketplace spam",
      elements: [
        "clean product presentation",
        "organized retail display",
        "shopping confidence cues",
        "brand-aware merchandising",
      ],
      negative: [
        "no robots",
        "no unrelated AI worlds",
        "no cluttered promo-poster layout",
        "no noisy discount chaos",
      ],
    },
    ecommerce: {
      style:
        "Premium ecommerce product visual, clean shoppable composition, attractive product focus, purchase-oriented lifestyle context, modern commercial polish, conversion-friendly clarity",
      composition:
        "One coherent product-led scene, strong focal product, clean surrounding support elements, ecommerce-ready commercial balance",
      elements: [
        "clean product-led composition",
        "lifestyle product context",
        "campaign-ready merchandising",
        "shopping-confidence atmosphere",
      ],
      negative: [
        "no robots",
        "no irrelevant tech cores",
        "no cluttered sales-poster look",
        "no unreadable UI overlays",
      ],
    },
    real_estate: {
      style:
        "Polished real-estate visual, credible architectural clarity, aspirational but grounded property atmosphere, premium interior or exterior realism, trust-led presentation",
      composition:
        "One coherent property or architectural scene, clean lines, spatial calm, premium but realistic staging, no fake luxury overload",
      elements: [
        "premium interior or exterior",
        "architectural clarity",
        "lifestyle-fit property scene",
        "credible development presentation",
      ],
      negative: [
        "no robots",
        "no tech dashboard world",
        "no fake fantasy mansion excess",
        "no cluttered listing-poster layout",
      ],
    },
    logistics: {
      style:
        "Modern logistics visual, structured operational environment, clean industrial professionalism, route and movement realism, dependable execution feel, business-ready clarity",
      composition:
        "One coherent logistics or fulfillment scene, visible movement or coordination logic, clean industrial order, no chaos",
      elements: [
        "modern dispatch or warehouse atmosphere",
        "shipment or route coordination scene",
        "operational flow cues",
        "trustworthy logistics environment",
      ],
      negative: [
        "no robots",
        "no sci-fi transport fantasy",
        "no unrelated dashboards",
        "no action-movie chaos",
      ],
    },
    creative_agency: {
      style:
        "Premium editorial creative visual, modern art-directed brand world, polished studio or campaign atmosphere, strategically creative, high-taste commercial styling",
      composition:
        "One coherent brand or production scene, art-directed but usable, clean premium depth, no template clutter, no random trend chaos",
      elements: [
        "editorial brand atmosphere",
        "modern studio or creative setting",
        "campaign-ready composition",
        "polished visual direction",
      ],
      negative: [
        "no robots unless explicitly concept-fit",
        "no random sci-fi world",
        "no buzzword-poster aesthetics",
        "no messy social-template clutter",
      ],
    },
    automotive: {
      style:
        "Clean modern automotive visual, credible service or dealership atmosphere, polished vehicle presentation, trustworthy technical care mood, capable commercial realism",
      composition:
        "One coherent vehicle-care, service-bay, or dealership scene, strong focal vehicle or service environment, practical clarity, no macho exaggeration",
      elements: [
        "clean workshop or dealership setting",
        "polished vehicle presentation",
        "trusted technician or service environment",
        "automotive care atmosphere",
      ],
      negative: [
        "no robots",
        "no childish futurism",
        "no racing-fantasy chaos",
        "no macho-poster clichés",
      ],
    },
    technology: {
      style:
        "Premium business-technology visual, intelligent modern systems atmosphere, clean futuristic but commercially credible environment, elegant digital infrastructure feel, sharp high-end execution",
      composition:
        "One coherent business-tech scene with strong focal structure, premium depth, controlled glow, useful futuristic logic, no childish sci-fi chaos",
      elements: [
        "intelligent system architecture",
        "modern business-tech environment",
        "assistant or automation presence where relevant",
        "premium digital infrastructure",
      ],
      negative: [
        "no gamer-like sci-fi chaos",
        "no cartoon robots",
        "no crypto-fantasy",
        "no meaningless neon overload",
      ],
    },
    generic_business: {
      style:
        "Premium business-appropriate visual scene, modern commercial atmosphere, credible brand-safe realism, polished materials, clear focal subject, industry-natural styling",
      composition:
        "One coherent brand-appropriate scene, clean spatial order, premium commercial balance, realistic and uncluttered",
      elements: [
        "brand-appropriate focal subject",
        "commercially usable environment",
        "clean premium composition",
        "credible industry-fit atmosphere",
      ],
      negative: [
        "no robots unless clearly relevant",
        "no irrelevant tech fantasy",
        "no cluttered poster look",
        "no baked text",
      ],
    },
  };

  return map[key] || map.generic_business;
}

function buildIndustryNegativeRules(industryKey = "") {
  const pack = getIndustryVisualPack(industryKey);
  return asArr(pack.negative).map((x) => String(x).trim()).filter(Boolean);
}

export function normalizeFormat(format) {
  const f = String(format || "").trim().toLowerCase();
  if (ALLOWED_FORMATS.includes(f)) return f;
  return "image";
}

export function pickAspectRatio(format) {
  const f = normalizeFormat(format);
  if (f === "reel") return "9:16";
  if (f === "image") return "4:5";
  return "1:1";
}

export function normalizeAspectRatio(aspectRatio, format) {
  const a = String(aspectRatio || "").trim();
  if (a === "1:1" || a === "4:5" || a === "9:16") return a;
  return pickAspectRatio(format);
}

export function sanitizeVisualText(x, max = 260) {
  let t = fixMojibake(String(x || "").trim());
  if (!t) return "";

  t = t
    .replace(/\b(navbar|navigation|menu|header|footer|button|cta button)\b/gi, "")
    .replace(
      /\b(website|landing page|web page|homepage|site hero|hero section|hero banner)\b/gi,
      ""
    )
    .replace(
      /\b(dashboard|admin panel|analytics panel|saas ui|ui screen|app screen|app ui|browser window|software screen)\b/gi,
      ""
    )
    .replace(
      /\b(mockup of a website|interface mockup|ui mockup|screen mockup|figma mockup|dribbble shot)\b/gi,
      ""
    )
    .replace(
      /\b(poster|campaign|advertisement|advertising|commercial layout|editorial layout|branded layout|marketing layout|social cover|cover design|thumbnail design)\b/gi,
      ""
    )
    .replace(
      /\b(copy-safe|copy safe|text-safe|text safe|headline area|title area|copy area|negative space|text area)\b/gi,
      ""
    )
    .replace(
      /\b(readable text|letters|words|numbers|logo|label|branding|symbols|typography|title|headline|caption|slogan|watermark|signage|monogram|glyphs)\b/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .trim();

  return truncate(t, max);
}

export function sanitizeVisualElements(arr = []) {
  const bad = [
    "website",
    "landing page",
    "dashboard",
    "ui",
    "screen ui",
    "browser",
    "navbar",
    "menu",
    "button",
    "interface",
    "app screen",
    "admin panel",
    "poster",
    "campaign",
    "advertising",
    "marketing layout",
    "copy-safe",
    "headline area",
    "title area",
    "logo",
    "label",
    "readable text",
    "typography",
    "caption",
    "slogan",
    "watermark",
    "signage",
  ];

  const out = [];
  for (const item of asArr(arr)) {
    const v = sanitizeVisualText(item, 120);
    if (!v) continue;
    const low = v.toLowerCase();
    if (bad.some((b) => low.includes(b))) continue;
    out.push(v);
  }
  return uniqStrings(out).slice(0, 10);
}

export function detectTopicFamily(topic, hook, caption) {
  const t = lower([topic, hook, caption].filter(Boolean).join(" "));

  if (
    /\b(chatbot|assistant|virtual assistant|voice assistant|customer support|support|receptionist|call handling|whatsapp|instagram dm|messenger|faq|conversation|reply)\b/.test(
      t
    )
  ) {
    return "conversational_ai";
  }
  if (
    /\b(lead|qualification|sales|crm|pipeline|follow-up|conversion|missed lead|lead capture|upsell|cross-sell)\b/.test(
      t
    )
  ) {
    return "sales_automation";
  }
  if (/\b(hr|recruitment|screening|employee onboarding|onboarding|hiring)\b/.test(t)) {
    return "hr_automation";
  }
  if (
    /\b(reporting|analytics|insight|brief|summary|dashboard insight|ceo brief)\b/.test(t)
  ) {
    return "insight_automation";
  }
  if (
    /\b(content|caption|comment reply|publishing|social media|content approval|creative|post generation)\b/.test(
      t
    )
  ) {
    return "content_automation";
  }
  if (/\b(appointment|booking|clinic|healthcare|consultation|reservation)\b/.test(t)) {
    return "booking_automation";
  }
  if (
    /\b(e-commerce|ecommerce|cart|retention|reactivation|order tracking|customer journey|checkout|online store)\b/.test(
      t
    )
  ) {
    return "commerce_automation";
  }
  if (
    /\b(logistics|routing|field operations|service routing|coordination|workflow|task routing|operations|process)\b/.test(
      t
    )
  ) {
    return "ops_automation";
  }
  if (/\b(education|enrollment|course|student|learning)\b/.test(t)) {
    return "education_automation";
  }
  if (/\b(real estate|property|inquiry routing)\b/.test(t)) {
    return "real_estate_automation";
  }
  if (
    /\b(transformation|innovation|future|ai infrastructure|intelligence|automation systems)\b/.test(
      t
    )
  ) {
    return "future_ai";
  }

  return "general_automation";
}

export function pickVisualPresetFromTopicFamily(topicFamily, currentPreset, industryKey = "") {
  const p = String(currentPreset || "").trim();
  if (ALLOWED_VISUAL_PRESETS.includes(p)) return p;

  const techOnly = isTechnologyIndustry(industryKey);

  if (!techOnly) {
    if (topicFamily === "booking_automation") return "support_ai_hub";
    return "abstract_tech_scene";
  }

  if (topicFamily === "conversational_ai") return "chatbot_operator";
  if (topicFamily === "sales_automation") return "sales_flow_machine";
  if (topicFamily === "hr_automation") return "workflow_engine";
  if (topicFamily === "insight_automation") return "ai_core";
  if (topicFamily === "content_automation") return "automation_device";
  if (topicFamily === "booking_automation") return "support_ai_hub";
  if (topicFamily === "commerce_automation") return "sales_flow_machine";
  if (topicFamily === "ops_automation") return "workflow_engine";
  if (topicFamily === "education_automation") return "abstract_tech_scene";
  if (topicFamily === "real_estate_automation") return "support_ai_hub";
  if (topicFamily === "future_ai") return "ai_core";

  return "abstract_tech_scene";
}

export function presetStyleBlock(preset) {
  if (preset === "robotic_unit") {
    return {
      style:
        "Premium robotic object render, dark studio environment, sculptural service-machine design, elegant industrial surfaces, controlled cyan-blue glow, believable premium engineering",
      composition:
        "One dominant robotic or semi-robotic hero subject, strong right-side or center-right focal bias, clean left side, balanced premium depth, no heavy blur wall",
      elements: [
        "premium robotic unit",
        "service-machine silhouette",
        "engineered metal surfaces",
        "subtle communication light arcs",
      ],
    };
  }

  if (preset === "chatbot_operator") {
    return {
      style:
        "Premium conversational AI visual, elegant humanoid or device-like assistant presence, dark studio atmosphere, refined cyan edge light, premium industrial design, believable futuristic service aesthetic",
      composition:
        "One dominant assistant-like subject, premium center-right or right focal bias, calm open surrounding space, cinematic depth, no interface clutter",
      elements: [
        "assistant-like machine presence",
        "communication light arcs",
        "subtle signal particles",
        "premium service intelligence motif",
      ],
    };
  }

  if (preset === "support_ai_hub") {
    return {
      style:
        "Premium service orchestration hub visual, dark graphite environment, elegant communication energy routes, refined AI support atmosphere, believable futuristic business-tech realism",
      composition:
        "One dominant central support hub or communication core, clean surrounding negative space, premium depth layering, controlled glow and signal rhythm",
      elements: [
        "support hub",
        "communication signal routes",
        "service coordination energy",
        "refined intelligent control center",
      ],
    };
  }

  if (preset === "sales_flow_machine") {
    return {
      style:
        "Premium sales automation machine visual, engineered funnel-like technology object, dark studio environment, glass-metal precision detailing, refined luminous data movement",
      composition:
        "One dominant funnel or routing machine object, lower-right or center-right subject placement, premium spacious composition, controlled depth and material clarity",
      elements: [
        "sales routing machine",
        "structured data capsules",
        "conversion flow channels",
        "precision automation rails",
      ],
    };
  }

  if (preset === "workflow_engine") {
    return {
      style:
        "Premium workflow engine visual, industrial-grade orchestration module, deep graphite space, cyan-blue signal lines, elegant moving energy channels, believable system logic made physical",
      composition:
        "One dominant engine-like subject, right-side or central focal mass, clean calm support space, premium cinematic depth, no UI fragments",
      elements: [
        "workflow engine",
        "orchestration rails",
        "signal routes",
        "precision system chambers",
      ],
    };
  }

  if (preset === "ai_core") {
    return {
      style:
        "Abstract intelligent AI core visual, layered futuristic nucleus, controlled light emission, refined glow, premium dark atmosphere, elegant technological depth",
      composition:
        "One iconic central or slightly offset AI core subject, high-end depth separation, refined atmosphere, calm left side, reduced fog mass, premium futuristic balance",
      elements: [
        "AI core",
        "energy nucleus",
        "layered luminous structure",
        "refined light depth",
      ],
    };
  }

  if (preset === "automation_device") {
    return {
      style:
        "Premium automation hardware visual, product-grade engineered system object, dark studio scene, graphite and glass materials, precision industrial detailing, controlled cyan light",
      composition:
        "One dominant automation device or smart module, right-side or lower-right focal object, cleaner left side for render, strong material readability, no muddy overlays",
      elements: [
        "automation device",
        "smart control module",
        "engineered hardware",
        "precision signal rails",
      ],
    };
  }

  return {
    style:
      "Premium abstract technology scene, elegant futuristic spatial composition, engineered structures, high-end atmosphere, controlled glow, cinematic depth, clean dark environment",
    composition:
      "One dominant spatial technology structure or atmospheric focal area, balanced open composition, cleaner left side, refined light layering, no poster layout feel",
    elements: [
      "abstract technology environment",
      "engineered light structure",
      "premium spatial depth",
      "futuristic architectural form",
    ],
  };
}

export function topicFamilyElements(topicFamily, industryKey = "") {
  const techOnly = isTechnologyIndustry(industryKey);

  if (!techOnly) {
    return [];
  }

  const map = {
    conversational_ai: [
      "communication signal arcs",
      "assistant-like intelligence presence",
      "service response energy",
    ],
    sales_automation: [
      "routing channels",
      "structured data capsules",
      "sequenced automation flow",
    ],
    hr_automation: [
      "qualification channels",
      "sorted intelligence pathways",
      "structured decision modules",
    ],
    insight_automation: [
      "condensed intelligence core",
      "signal synthesis layers",
      "executive clarity motif",
    ],
    content_automation: [
      "creative production engine",
      "orchestrated system flow",
      "premium generation module",
    ],
    booking_automation: [
      "scheduling routes",
      "service coordination signals",
      "precision intake pathways",
    ],
    commerce_automation: [
      "retention flow channels",
      "commerce signal movement",
      "lifecycle automation modules",
    ],
    ops_automation: [
      "process orchestration rails",
      "timing control paths",
      "operations coordination structure",
    ],
    education_automation: [
      "guided progression channels",
      "knowledge pathways",
      "supportive system layers",
    ],
    real_estate_automation: [
      "inquiry intake structure",
      "matching signal routes",
      "premium lead routing motif",
    ],
    future_ai: [
      "visionary intelligence glow",
      "futuristic system energy",
      "next-generation infrastructure forms",
    ],
    general_automation: [
      "automation pathways",
      "intelligent system channels",
      "premium operational flow",
    ],
  };

  return map[topicFamily] || map.general_automation;
}

function inferIndustryElements(industryKey = "") {
  const pack = getIndustryVisualPack(industryKey);
  return asArr(pack.elements);
}

function inferIndustryStyle(industryKey = "") {
  return s(getIndustryVisualPack(industryKey)?.style);
}

function inferIndustryComposition(industryKey = "") {
  return s(getIndustryVisualPack(industryKey)?.composition);
}

export function normalizeFrame(frame, idx, format) {
  const f = asObj(frame);
  const typeByFormat = format === "reel" ? "scene" : idx === 1 ? "cover" : "slide";

  return {
    index: Number(f.index || idx),
    frameType: String(f.frameType || typeByFormat),
    headline: truncate(fixMojibake(f.headline || ""), 140),
    subline: truncate(fixMojibake(f.subline || ""), 240),
    layout: sanitizeVisualText(f.layout || "", 260),
    visualElements: sanitizeVisualElements(asArr(f.visualElements)),
    motion: truncate(fixMojibake(f.motion || ""), 180),
    durationSec: Number.isFinite(Number(f.durationSec)) ? Number(f.durationSec) : 0,
  };
}

export function buildFallbackFrame({
  idx,
  format,
  total,
  cta,
  topic,
  preset,
  topicFamily,
  vars = {},
}) {
  const tenant = getTenantRuntime(vars);
  const lang = tenant.outputLanguage;
  const presetPack = presetStyleBlock(preset);
  const topicEls = topicFamilyElements(topicFamily, tenant.industryKey);
  const industryEls = inferIndustryElements(tenant.industryKey);

  const isCover = idx === 1;
  const isLast = idx === total;

  let headline =
    lang === "az"
      ? "Daha ağıllı və aydın xidmət təcrübəsi"
      : "A smarter and clearer service experience";

  let subline =
    lang === "az"
      ? "Daha sistemli, daha rahat və daha keyfiyyətli müştəri axını"
      : "A more structured, smoother, and higher-quality customer journey";

  if (isTechnologyIndustry(tenant.industryKey)) {
    headline =
      lang === "az" ? "Daha ağıllı sistem qurun" : "Build a smarter system";
    subline =
      lang === "az"
        ? "Daha sürətli, daha sistemli və daha keyfiyyətli iş axını qurun"
        : "Create a faster, more structured, and higher-quality workflow";
  }

  if (isCover) {
    headline =
      topic && topic.length > 4
        ? truncate(topic, 110)
        : lang === "az"
        ? "Bu təcrübə daha aydın və güclü ola bilər"
        : "This experience can be clearer and stronger";

    subline =
      lang === "az"
        ? "Praktik dəyər, aydın proses və daha güclü müştəri təcrübəsi"
        : "Practical value, clearer process, and a stronger customer experience";
  } else if (isLast) {
    headline =
      lang === "az"
        ? "Biznesinizə uyğun doğru həll quraq"
        : "Let’s shape the right solution for your business";

    subline = truncate(
      cta ||
        (lang === "az"
          ? `Daha uyğun həll üçün ${tenant.companyName} ilə əlaqə saxlayın`
          : `Contact ${tenant.companyName} to explore the right solution`),
      180
    );
  } else {
    headline =
      lang === "az"
        ? `Əsas istifadə sahəsi ${idx - 1}`
        : `Core use case ${idx - 1}`;

    subline =
      lang === "az"
        ? "Daha rahat təcrübə, daha aydın proses və daha güclü nəticə"
        : "A smoother experience, clearer process, and stronger outcomes";
  }

  return normalizeFrame(
    {
      index: idx,
      frameType: format === "reel" ? "scene" : isCover ? "cover" : "slide",
      layout:
        idx === 1
          ? "clean premium composition with one dominant focal subject, calm open space, elegant commercial depth, clear usable scene"
          : isLast
          ? "clean balanced composition with one strong focal subject, open side for later overlay, refined premium atmosphere"
          : "clean industry-appropriate scene with one dominant object or coherent environment, controlled atmosphere, strong commercial clarity",
      headline,
      subline,
      visualElements: uniqStrings([
        ...industryEls,
        ...presetPack.elements,
        ...topicEls,
      ]).slice(0, 6),
      motion:
        format === "reel"
          ? idx === 1
            ? "slow cinematic push-in"
            : idx === total
            ? "controlled resolving camera drift"
            : "subtle premium camera motion"
          : "",
      durationSec: format === "reel" ? (idx === 1 ? 4 : idx === total ? 3 : 3) : 0,
    },
    idx,
    format
  );
}

export function ensureFrames(
  frames,
  format,
  cta = "",
  topic = "",
  preset = "",
  topicFamily = "",
  vars = {}
) {
  let out = asArr(frames)
    .map((f, i) => normalizeFrame(f, i + 1, format))
    .filter((x) => x.headline || x.subline || x.layout || x.visualElements.length);

  if (format === "image") {
    if (!out.length) {
      out = [
        buildFallbackFrame({
          idx: 1,
          format,
          total: 1,
          cta,
          topic,
          preset,
          topicFamily,
          vars,
        }),
      ];
    }
    return [out[0]];
  }

  if (format === "carousel") {
    if (out.length < 5) {
      const base = [...out];
      while (base.length < 5) {
        const idx = base.length + 1;
        base.push(
          buildFallbackFrame({
            idx,
            format,
            total: 5,
            cta,
            topic,
            preset,
            topicFamily,
            vars,
          })
        );
      }
      out = base;
    }

    if (out.length > 8) out = out.slice(0, 8);

    return out.map((x, i) => ({
      ...x,
      index: i + 1,
      frameType: i === 0 ? "cover" : "slide",
    }));
  }

  if (format === "reel") {
    if (out.length < 3) {
      const base = [...out];
      while (base.length < 3) {
        const idx = base.length + 1;
        base.push(
          buildFallbackFrame({
            idx,
            format,
            total: 3,
            cta,
            topic,
            preset,
            topicFamily,
            vars,
          })
        );
      }
      out = base;
    }

    if (out.length > 4) out = out.slice(0, 4);

    return out.map((x, i) => ({
      ...x,
      index: i + 1,
      frameType: "scene",
      durationSec:
        Number.isFinite(Number(x.durationSec)) && Number(x.durationSec) > 0
          ? Math.max(2, Math.min(5, Number(x.durationSec)))
          : i === 0
          ? 4
          : i === out.length - 1
          ? 3
          : 3,
    }));
  }

  return out;
}

export function pickLayoutFamily({ format, idx, totalSlides, layoutText }) {
  const lt = String(layoutText || "").toLowerCase();

  if (format === "reel") {
    if (lt.includes("center")) return "cinematic_center";
    if (lt.includes("top-left")) return "luxury_top_left";
    if (lt.includes("bottom-left")) return "dramatic_bottom_left";
    return idx === 1 ? "cinematic_center" : "editorial_left";
  }

  if (format === "carousel") {
    if (idx === 1) return "editorial_left";
    if (idx === totalSlides) return "dramatic_bottom_left";
    if (lt.includes("center")) return "cinematic_center";
    if (lt.includes("top-left")) return "luxury_top_left";
    if (lt.includes("bottom-left")) return "dramatic_bottom_left";
    return idx % 2 === 0 ? "luxury_top_left" : "editorial_left";
  }

  if (lt.includes("center")) return "cinematic_center";
  if (lt.includes("top-left")) return "luxury_top_left";
  if (lt.includes("bottom-left")) return "dramatic_bottom_left";
  return "editorial_left";
}

export function buildRenderHints(frame, format, idx, totalSlides) {
  const f = asObj(frame);
  const layoutText = String(f.layout || "").toLowerCase();

  const layoutFamily = pickLayoutFamily({
    format,
    idx,
    totalSlides,
    layoutText,
  });

  let textPosition = "left";
  if (layoutFamily === "cinematic_center") textPosition = "center";
  if (layoutFamily === "luxury_top_left") textPosition = "top-left";
  if (layoutFamily === "dramatic_bottom_left") textPosition = "bottom-left";

  let safeArea = "left-heavy";
  if (layoutFamily === "cinematic_center") safeArea = "centered";
  if (layoutFamily === "luxury_top_left") safeArea = "top-left";
  if (layoutFamily === "dramatic_bottom_left") safeArea = "bottom-left";

  let overlayStrength = "soft";
  if (idx === 1) overlayStrength = "medium";
  if (format === "reel") overlayStrength = "medium";

  let focalBias = "right";
  if (layoutFamily === "cinematic_center") focalBias = "center";
  if (layoutFamily === "luxury_top_left") focalBias = "lower-right";
  if (layoutFamily === "dramatic_bottom_left") focalBias = "upper-right";

  return {
    layoutFamily,
    textPosition,
    safeArea,
    overlayStrength,
    focalBias,
  };
}

export function buildFallbackImagePrompt(payload) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
  const format = normalizeFormat(p.format || "image");
  const visualPlan = asObj(p.visualPlan);
  const frames = asArr(visualPlan.frames);
  const first = asObj(frames[0]);
  const topicFamily = detectTopicFamily(p.topic, p.hook, p.caption);
  const preset = pickVisualPresetFromTopicFamily(
    topicFamily,
    visualPlan.visualPreset,
    tenant.industryKey
  );

  const aspectLine =
    format === "reel"
      ? "Vertical 9:16 framing."
      : format === "carousel"
      ? "Square 1:1 framing."
      : "Vertical 4:5 framing.";

  const presetBlock = presetStyleBlock(preset);
  const noTextRules = buildNoTextRules();
  const industryPack = getIndustryVisualPack(tenant.industryKey);
  const industryNegative = buildIndustryNegativeRules(tenant.industryKey);

  const lines = [
    `Create a premium text-free tenant-appropriate visual scene for ${tenant.companyName}.`,
    `Industry context: ${tenant.industryKey}.`,
    p.topic
      ? `Topic context for visual meaning only: ${sanitizeVisualText(p.topic, 180)}.`
      : "",
    p.hook
      ? `Emotional communication direction only, not literal text: ${sanitizeVisualText(p.hook, 160)}.`
      : "",
    first.headline
      ? `Primary message mood only, do not render as text: ${sanitizeVisualText(first.headline, 120)}.`
      : "",
    first.subline
      ? `Secondary message mood only, do not render as text: ${sanitizeVisualText(first.subline, 140)}.`
      : "",
    tenant.businessContext
      ? `Business context: ${sanitizeVisualText(tenant.businessContext, 220)}.`
      : "",
    tenant.servicesText
      ? `Services or product context: ${sanitizeVisualText(tenant.servicesText, 180)}.`
      : "",
    `Visual preset: ${preset}. Use it only as a composition aid, not as a reason to force unrelated technology imagery.`,
    visualPlan.style
      ? `Style direction: ${sanitizeVisualText(visualPlan.style, 220)}.`
      : `Style direction: ${industryPack.style || presetBlock.style}.`,
    visualPlan.colorNotes
      ? `Color palette: ${sanitizeVisualText(visualPlan.colorNotes, 180)}.`
      : isTechnologyIndustry(tenant.industryKey)
      ? "Color palette: deep graphite, premium dark contrast, refined cyan-blue light, subtle metallic reflections, controlled glow."
      : "Color palette: premium industry-appropriate tones, refined contrast, believable materials, calm professional atmosphere.",
    visualPlan.composition
      ? `Composition: ${sanitizeVisualText(visualPlan.composition, 220)}.`
      : `Composition: ${industryPack.composition || presetBlock.composition}.`,
    first.layout
      ? `Layout mood: ${sanitizeVisualText(first.layout, 160)}.`
      : "",
    asArr(first.visualElements).length
      ? `Scene elements: ${asArr(first.visualElements).join(", ")}.`
      : `Scene elements: ${uniqStrings([
          ...asArr(industryPack.elements),
          ...(isTechnologyIndustry(tenant.industryKey) ? asArr(presetBlock.elements) : []),
        ]).join(", ")}.`,
    "Use one dominant focal subject and only a few supporting elements.",
    "Create clean premium background art suitable for later text overlay by a separate render system.",
    "The scene must feel natural for the tenant’s real industry and business category.",
    "Do not force robots, AI cores, automation hardware, futuristic machines, dashboards, software interfaces, or sci-fi environments unless the tenant is genuinely technology-related.",
    "Keep one side calmer and compositionally cleaner for later overlay, but do not create poster layout or fake text zones.",
    "Avoid UI, product packaging text, signage, labels, billboards, interface fragments, template look, and promo poster aesthetics.",
    "Use cinematic realism, elegant depth, premium materials, controlled reflections, believable light, refined atmosphere.",
    ...industryNegative,
    ...noTextRules,
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2800);
}

export function buildSlideVisualPrompt({
  payload,
  frame,
  totalSlides,
  format,
  visualPreset,
}) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
  const f = asObj(frame);
  const visualPlan = asObj(p.visualPlan);
  const topicFamily = detectTopicFamily(p.topic, p.hook, p.caption);
  const preset = String(
    visualPreset ||
      visualPlan.visualPreset ||
      pickVisualPresetFromTopicFamily(topicFamily, "", tenant.industryKey)
  );
  const noTextRules = buildNoTextRules();
  const industryPack = getIndustryVisualPack(tenant.industryKey);
  const industryNegative = buildIndustryNegativeRules(tenant.industryKey);

  const aspectLine =
    format === "reel"
      ? "Vertical 9:16 framing."
      : format === "carousel"
      ? "Square 1:1 framing."
      : "Vertical 4:5 framing.";

  const presetBlock = presetStyleBlock(preset);

  const lines = [
    format === "carousel"
      ? `Create a premium text-free tenant-appropriate visual scene for ${tenant.companyName} carousel slide ${f.index} of ${totalSlides}.`
      : format === "reel"
      ? `Create a premium text-free cinematic tenant-appropriate visual scene for ${tenant.companyName} reel scene ${f.index} of ${totalSlides}.`
      : `Create a premium text-free tenant-appropriate visual scene for ${tenant.companyName}.`,
    `Industry context: ${tenant.industryKey}.`,
    p.topic
      ? `Topic context for visual meaning only: ${sanitizeVisualText(p.topic, 180)}.`
      : "",
    tenant.businessContext
      ? `Business context: ${sanitizeVisualText(tenant.businessContext, 220)}.`
      : "",
    `Visual preset: ${preset}. Use it only when it remains natural for the industry.`,
    f.headline
      ? `Primary message mood only, do not render as text: ${sanitizeVisualText(f.headline, 120)}.`
      : "",
    f.subline
      ? `Secondary message mood only, do not render as text: ${sanitizeVisualText(f.subline, 140)}.`
      : "",
    visualPlan.style
      ? `Style direction: ${sanitizeVisualText(visualPlan.style, 220)}.`
      : `Style direction: ${industryPack.style || presetBlock.style}.`,
    visualPlan.colorNotes
      ? `Color palette: ${sanitizeVisualText(visualPlan.colorNotes, 180)}.`
      : isTechnologyIndustry(tenant.industryKey)
      ? "Color palette: deep graphite, premium dark contrast, refined cyan-blue light, subtle metallic reflections."
      : "Color palette: premium industry-appropriate tones, believable materials, calm contrast, refined commercial realism.",
    f.layout
      ? `Composition feel: ${sanitizeVisualText(f.layout, 180)}.`
      : `Composition feel: ${industryPack.composition || presetBlock.composition}.`,
    asArr(f.visualElements).length
      ? `Scene elements: ${asArr(f.visualElements).join(", ")}.`
      : `Scene elements: ${uniqStrings([
          ...asArr(industryPack.elements),
          ...(isTechnologyIndustry(tenant.industryKey) ? asArr(presetBlock.elements) : []),
        ]).join(", ")}.`,
    f.motion ? `Camera or motion feel: ${sanitizeVisualText(f.motion, 140)}.` : "",
    format === "reel"
      ? "This must feel like one coherent scene from a premium cinematic commercial sequence."
      : "This must feel like premium background artwork, not a poster or a designed social template.",
    "Use one dominant focal subject and a minimal number of supporting elements.",
    "The image must remain visually clean enough for later text overlay by a separate render engine.",
    "The scene must stay natural for the tenant’s actual industry and brand reality.",
    "Do not create fake title areas, fake UI cards, or poster composition blocks.",
    "Avoid landing pages, dashboards, app screens, websites, browser windows, infographics, packaging fronts, ad boards, and interface-like compositions.",
    "Do not force technology objects or futuristic machines for non-technology businesses.",
    "If any device or display appears, it must stay abstract, ambient, and unreadable.",
    "Use premium cinematic realism, elegant atmosphere, believable materials, refined light, and controlled depth.",
    ...industryNegative,
    ...noTextRules,
    aspectLine,
  ];

  return truncate(lines.filter(Boolean).join(" "), 2800);
}

export function buildSlidesFromFrames(payload) {
  const p = asObj(payload);
  const tenant = getTenantRuntime(payload);
  const format = normalizeFormat(p.format || "image");
  const frames = asArr(asObj(p.visualPlan).frames);
  const totalSlides = frames.length;
  const topicFamily = detectTopicFamily(p.topic, p.hook, p.caption);
  const visualPreset = String(
    asObj(p.visualPlan).visualPreset ||
      pickVisualPresetFromTopicFamily(topicFamily, "", tenant.industryKey)
  );
  const brandBadge = defaultBrandBadge();
  const defaultCta =
    tenant.outputLanguage === "az"
      ? "Daha çox məlumat üçün bizimlə əlaqə saxlayın"
      : "Contact us to learn more";

  return frames.map((frame, i) => {
    const idx = i + 1;
    const f = asObj(frame);
    const isLast = idx === totalSlides;

    const badge =
      format === "carousel"
        ? idx === 1
          ? brandBadge
          : isLast
          ? "CTA"
          : "CONTENT"
        : format === "reel"
        ? "REEL"
        : brandBadge;

    const cta = isLast ? truncate(p.cta || defaultCta, 80) : "";

    return {
      id: `slide_${idx}`,
      index: idx,
      frameType: String(
        f.frameType || (format === "reel" ? "scene" : idx === 1 ? "cover" : "slide")
      ),
      title: truncate(f.headline || p.topic || tenant.companyName || "Draft", 120),
      subtitle: truncate(f.subline || p.hook || "", 180),
      cta,
      badge,
      align: "left",
      theme: s(p.theme || tenant.visualTheme || "premium_modern"),
      slideNumber: idx,
      totalSlides,
      renderHints: buildRenderHints(f, format, idx, totalSlides),
      visualDirection: truncate(
        [
          `Industry: ${tenant.industryKey}`,
          f.layout || "",
          asArr(f.visualElements).join(", "),
          f.motion ? `Motion mood: ${f.motion}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        400
      ),
      visualPrompt: buildSlideVisualPrompt({
        payload: p,
        frame,
        totalSlides,
        format,
        visualPreset,
      }),
    };
  });
}

export function normalizeNeededAssets(srcAssets, format) {
  const incoming = uniqStrings(asArr(srcAssets));
  if (incoming.length) return incoming.slice(0, 10);

  if (format === "reel") return ["video", "image", "thumbnail", "icons", "mockups"];
  return ["image", "icons", "mockups"];
}