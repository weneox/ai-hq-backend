// src/prompts/industries/index.js
// FINAL v1.0 — industry prompt registry + normalization
//
// ✅ central industry registry
// ✅ alias normalization
// ✅ safe fallback to generic_business
// ✅ vars passthrough into template renderer
// ✅ future-proof for many industries

import genericBusiness from "./generic_business.txt";
import technology from "./technology.txt";
import clinic from "./clinic.txt";
import restaurant from "./restaurant.txt";
import hospitality from "./hospitality.txt";
import retail from "./retail.txt";
import realEstate from "./real_estate.txt";
import education from "./education.txt";
import beauty from "./beauty.txt";
import finance from "./finance.txt";
import legal from "./legal.txt";
import automotive from "./automotive.txt";
import logistics from "./logistics.txt";
import creativeAgency from "./creative_agency.txt";
import ecommerce from "./ecommerce.txt";

function s(v) {
  return String(v ?? "").trim();
}

function applyVars(template, vars = {}) {
  const text = String(template || "");
  if (!text) return "";

  const tenant = vars?.tenant || {};
  const extra = vars?.extra || {};

  const map = {
    today: vars?.today || "",
    format: vars?.format || "",
    language: vars?.language || vars?.outputLanguage || tenant?.outputLanguage || "az",
    outputLanguage: vars?.outputLanguage || tenant?.outputLanguage || "az",

    tenantId: vars?.tenantId || tenant?.tenantId || tenant?.tenantKey || "default",
    tenantKey: tenant?.tenantKey || tenant?.tenantId || "default",

    companyName: tenant?.companyName || "This company",
    brandName: tenant?.brandName || tenant?.companyName || "This company",
    industryKey: tenant?.industryKey || "generic_business",

    defaultLanguage: tenant?.defaultLanguage || "az",
    visualTheme: tenant?.visualTheme || "premium_modern",
    ctaStyle: tenant?.ctaStyle || "contact",

    toneText: tenant?.toneText || "",
    servicesText: tenant?.servicesText || "",
    audiencesText: tenant?.audiencesText || "",
    requiredHashtagsText: tenant?.requiredHashtagsText || "",
    preferredPresetsText: tenant?.preferredPresetsText || "",

    ...extra,
  };

  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const k = String(key || "").trim();
    if (!k) return "";

    if (Object.prototype.hasOwnProperty.call(map, k)) {
      return String(map[k] ?? "");
    }

    // support dot access like tenant.companyName / extra.foo
    const parts = k.split(".");
    let cur = {
      vars,
      tenant,
      extra,
      map,
    };

    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = cur[part];
      } else {
        cur = "";
        break;
      }
    }

    return String(cur ?? "");
  });
}

const INDUSTRY_REGISTRY = {
  generic_business: genericBusiness,
  technology,
  clinic,
  restaurant,
  hospitality,
  retail,
  real_estate: realEstate,
  education,
  beauty,
  finance,
  legal,
  automotive,
  logistics,
  creative_agency: creativeAgency,
  ecommerce,
};

const INDUSTRY_ALIASES = {
  generic: "generic_business",
  generic_business: "generic_business",
  business: "generic_business",
  services: "generic_business",

  tech: "technology",
  technology: "technology",
  ai: "technology",
  automation: "technology",
  software: "technology",
  saas: "technology",
  digital_agency: "technology",

  clinic: "clinic",
  healthcare: "clinic",
  health: "clinic",
  medical: "clinic",
  dental: "clinic",
  aesthetic_clinic: "clinic",

  restaurant: "restaurant",
  cafe: "restaurant",
  food: "restaurant",
  food_service: "restaurant",

  hospitality: "hospitality",
  hotel: "hospitality",
  resort: "hospitality",
  guest_experience: "hospitality",
  travel_hospitality: "hospitality",

  retail: "retail",
  store: "retail",
  shop: "retail",
  product_business: "retail",

  real_estate: "real_estate",
  realestate: "real_estate",
  property: "real_estate",
  development: "real_estate",
  developer: "real_estate",

  education: "education",
  academy: "education",
  training: "education",
  learning: "education",
  school: "education",
  course: "education",

  beauty: "beauty",
  salon: "beauty",
  aesthetic: "beauty",
  personal_care: "beauty",
  skincare: "beauty",

  finance: "finance",
  accounting: "finance",
  tax: "finance",
  bookkeeping: "finance",
  advisory: "finance",
  financial_services: "finance",

  legal: "legal",
  law: "legal",
  law_firm: "legal",
  attorney: "legal",
  lawyer: "legal",

  automotive: "automotive",
  auto: "automotive",
  dealership: "automotive",
  auto_service: "automotive",
  car_service: "automotive",
  mobility: "automotive",

  logistics: "logistics",
  delivery: "logistics",
  transport: "logistics",
  supply_chain: "logistics",
  shipping: "logistics",
  freight: "logistics",

  creative_agency: "creative_agency",
  agency: "creative_agency",
  creative: "creative_agency",
  marketing_agency: "creative_agency",
  branding_agency: "creative_agency",
  content_studio: "creative_agency",

  ecommerce: "ecommerce",
  e_commerce: "ecommerce",
  online_store: "ecommerce",
  d2c: "ecommerce",
  dtc: "ecommerce",
};

export function listIndustryKeys() {
  return Object.keys(INDUSTRY_REGISTRY);
}

export function normalizeIndustryKey(input = "") {
  const raw = s(input).toLowerCase();
  if (!raw) return "generic_business";

  const cleaned = raw
    .replace(/&/g, "and")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[-\s]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (INDUSTRY_ALIASES[cleaned]) return INDUSTRY_ALIASES[cleaned];
  if (INDUSTRY_REGISTRY[cleaned]) return cleaned;

  return "generic_business";
}

export function hasIndustryPrompt(industryKey = "") {
  const key = normalizeIndustryKey(industryKey);
  return Boolean(INDUSTRY_REGISTRY[key]);
}

export function getRawIndustryPrompt(industryKey = "") {
  const key = normalizeIndustryKey(industryKey);
  return INDUSTRY_REGISTRY[key] || INDUSTRY_REGISTRY.generic_business || "";
}

export function getIndustryPrompt(industryKey = "", vars = {}) {
  const raw = getRawIndustryPrompt(industryKey);
  return applyVars(raw, vars);
}