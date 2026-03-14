// src/prompts/industries/index.js
// FINAL v2.0 — industry prompt registry + schema-aware tenant vars

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function s(v) {
  return String(v ?? "").trim();
}

function asObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function asArr(v) {
  return Array.isArray(v) ? v : [];
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

function readTextFile(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), "utf8");
  } catch (err) {
    console.error(
      `[prompts/industries] failed to read ${filename}:`,
      err?.message || err
    );
    return "";
  }
}

function getTenantView(vars = {}) {
  const tenant = asObj(vars?.tenant);
  const profile = asObj(tenant.profile);
  const brand = asObj(tenant.brand);
  const aiPolicy = asObj(tenant.ai_policy || tenant.aiPolicy);
  const extra = asObj(vars?.extra);

  const companyName =
    s(
      brand.displayName ||
        brand.name ||
        profile.displayName ||
        profile.companyName ||
        tenant.companyName ||
        tenant.brandName ||
        tenant.name
    ) || "This company";

  const brandName =
    s(
      brand.displayName ||
        brand.name ||
        tenant.brandName ||
        profile.displayName ||
        profile.companyName ||
        tenant.companyName ||
        tenant.name
    ) || companyName;

  const industryKey =
    s(
      tenant.industryKey ||
        profile.industryKey ||
        tenant.industry ||
        profile.industry ||
        extra.industryKey
    ) || "generic_business";

  const outputLanguage =
    s(
      vars?.outputLanguage ||
        vars?.language ||
        tenant.outputLanguage ||
        profile.outputLanguage ||
        tenant.defaultLanguage ||
        profile.defaultLanguage
    ) || "az";

  const defaultLanguage =
    s(tenant.defaultLanguage || profile.defaultLanguage || outputLanguage) || "az";

  const visualTheme =
    s(
      tenant.visualTheme ||
        brand.visualTheme ||
        profile.visualTheme ||
        extra.visualTheme
    ) || "premium_modern";

  const ctaStyle =
    s(tenant.ctaStyle || profile.ctaStyle || extra.ctaStyle) || "contact";

  const toneText =
    s(
      tenant.toneText ||
        profile.toneText ||
        aiPolicy.toneText ||
        extra.toneText
    ) || "";

  const businessContext =
    s(
      tenant.businessContext ||
        profile.businessContext ||
        aiPolicy.businessContext ||
        extra.businessContext
    ) || "";

  const servicesText =
    s(tenant.servicesText || profile.servicesText || extra.servicesText) ||
    joinText(tenant.services, "");

  const audiencesText =
    s(tenant.audiencesText || profile.audiencesText || extra.audiencesText) ||
    joinText(tenant.audiences, "");

  const requiredHashtagsText =
    s(
      tenant.requiredHashtagsText ||
        profile.requiredHashtagsText ||
        extra.requiredHashtagsText
    ) || joinText(tenant.requiredHashtags, "");

  const preferredPresetsText =
    s(
      tenant.preferredPresetsText ||
        profile.preferredPresetsText ||
        extra.preferredPresetsText
    ) || joinText(tenant.preferredPresets, "");

  return {
    tenant,
    profile,
    brand,
    aiPolicy,
    extra,
    companyName,
    brandName,
    industryKey,
    outputLanguage,
    defaultLanguage,
    visualTheme,
    ctaStyle,
    toneText,
    businessContext,
    servicesText,
    audiencesText,
    requiredHashtagsText,
    preferredPresetsText,
  };
}

function applyVars(template, vars = {}) {
  const text = String(template || "");
  if (!text) return "";

  const view = getTenantView(vars);
  const tenant = view.tenant;
  const extra = view.extra;

  const map = {
    today: vars?.today || "",
    format: vars?.format || "",
    language: view.outputLanguage,
    outputLanguage: view.outputLanguage,

    tenantId:
      vars?.tenantId ||
      tenant?.tenantId ||
      tenant?.tenantKey ||
      tenant?.id ||
      "default",

    tenantKey: tenant?.tenantKey || tenant?.tenantId || tenant?.id || "default",

    companyName: view.companyName,
    brandName: view.brandName,
    industryKey: view.industryKey,

    defaultLanguage: view.defaultLanguage,
    visualTheme: view.visualTheme,
    ctaStyle: view.ctaStyle,

    toneText: view.toneText,
    businessContext: view.businessContext,
    servicesText: view.servicesText,
    audiencesText: view.audiencesText,
    requiredHashtagsText: view.requiredHashtagsText,
    preferredPresetsText: view.preferredPresetsText,

    ...extra,
  };

  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const k = String(key || "").trim();
    if (!k) return "";

    if (Object.prototype.hasOwnProperty.call(map, k)) {
      return String(map[k] ?? "");
    }

    const parts = k.split(".");
    let cur = {
      vars,
      tenant,
      extra,
      map,
      view,
      profile: view.profile,
      brand: view.brand,
      aiPolicy: view.aiPolicy,
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
  generic_business: readTextFile("generic_business.txt"),
  technology: readTextFile("technology.txt"),
  clinic: readTextFile("clinic.txt"),
  restaurant: readTextFile("restaurant.txt"),
  hospitality: readTextFile("hospitality.txt"),
  retail: readTextFile("retail.txt"),
  real_estate: readTextFile("real_estate.txt"),
  education: readTextFile("education.txt"),
  beauty: readTextFile("beauty.txt"),
  finance: readTextFile("finance.txt"),
  legal: readTextFile("legal.txt"),
  automotive: readTextFile("automotive.txt"),
  logistics: readTextFile("logistics.txt"),
  creative_agency: readTextFile("creative_agency.txt"),
  ecommerce: readTextFile("ecommerce.txt"),
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

export default {
  listIndustryKeys,
  normalizeIndustryKey,
  hasIndustryPrompt,
  getRawIndustryPrompt,
  getIndustryPrompt,
};