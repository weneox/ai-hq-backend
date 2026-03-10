// src/services/promptBundle.js
// FINAL v3.2 — universal multi-industry + multi-tenant prompt bundle builder
//
// ✅ tenant-aware
// ✅ industry-aware
// ✅ explicit tenant prompt layer
// ✅ event -> usecase mapping
// ✅ recomputes derived tenant text fields after extra merge
// ✅ stable language / format normalization
// ✅ future-proof for any business type

import { deepFix, fixText } from "../utils/textFix.js";
import {
  getGlobalPolicy,
  getUsecasePrompt,
} from "../prompts/index.js";
import {
  getIndustryPrompt,
  normalizeIndustryKey,
} from "../prompts/industries/index.js";

function s(v) {
  return String(v ?? "").trim();
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function normalizeTextList(input = [], fallback = "") {
  const list = arr(input)
    .map((x) => fixText(String(x || "").trim()))
    .filter(Boolean);

  if (!list.length) return fallback;
  return list.join(", ");
}

function normalizeHashtagList(input = [], fallback = "") {
  const list = arr(input)
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((x) => (x.startsWith("#") ? x : `#${x}`));

  if (!list.length) return fallback;
  return list.join(" ");
}

function normalizeLang(v) {
  const x = s(v).toLowerCase();
  if (!x) return "az";
  if (["az", "aze", "azerbaijani"].includes(x)) return "az";
  if (["en", "eng", "english"].includes(x)) return "en";
  if (["ru", "rus", "russian"].includes(x)) return "ru";
  if (["tr", "tur", "turkish"].includes(x)) return "tr";
  return x;
}

function normalizeFormat(v) {
  const x = s(v).toLowerCase();
  if (x === "image") return "image";
  if (x === "carousel") return "carousel";
  if (x === "reel") return "reel";
  return x;
}

function usecaseForEvent(event) {
  const e = s(event).toLowerCase();

  if (e === "proposal.approved") return "content.draft";
  if (e === "content.revise") return "content.revise";
  if (e === "content.publish") return "content.publish";
  if (e === "content.approved") return "content.publish";
  if (e === "meta.comment_reply") return "meta.comment_reply";
  if (e === "trend.research") return "trend.research";

  return "";
}

function finalizeTenantDerivedFields(raw = {}) {
  const t = obj(raw);

  const tone = arr(t.tone);
  const services = arr(t.services);
  const audiences = arr(t.audiences);
  const requiredHashtags = arr(t.requiredHashtags);
  const preferredPresets = arr(t.preferredPresets);

  return {
    ...t,
    tone,
    services,
    audiences,
    requiredHashtags,
    preferredPresets,

    toneText: normalizeTextList(
      tone,
      "premium, modern, clear, commercially strong"
    ),

    servicesText: normalizeTextList(
      services,
      "general business services"
    ),

    audiencesText: normalizeTextList(
      audiences,
      "business owners, decision makers, customers"
    ),

    requiredHashtagsText: normalizeHashtagList(
      requiredHashtags,
      "#Business #Brand"
    ),

    preferredPresetsText: normalizeTextList(
      preferredPresets,
      "ai_core, automation_device, workflow_engine"
    ),
  };
}

function normalizeTenantRuntime(raw = {}) {
  const tenant = obj(raw);
  const brand = obj(tenant.brand);
  const meta = obj(tenant.meta);
  const visualStyle = obj(brand.visualStyle);

  const tenantKey =
    s(tenant.tenant_key) ||
    s(tenant.tenantKey) ||
    s(brand.tenantKey) ||
    s(meta.tenantKey) ||
    "default";

  const companyName =
    s(tenant.companyName) ||
    s(brand.companyName) ||
    s(brand.name) ||
    s(tenant.name) ||
    s(meta.companyName) ||
    tenantKey ||
    "This company";

  const industryKey = normalizeIndustryKey(
    brand.industryKey ||
      brand.industry ||
      tenant.industryKey ||
      tenant.industry ||
      meta.industryKey ||
      meta.industry ||
      "generic_business"
  );

  const defaultLanguage = normalizeLang(
    brand.defaultLanguage ||
      brand.language ||
      meta.defaultLanguage ||
      meta.language ||
      tenant.defaultLanguage ||
      tenant.language ||
      "az"
  );

  const outputLanguage = normalizeLang(
    brand.outputLanguage ||
      meta.outputLanguage ||
      tenant.outputLanguage ||
      defaultLanguage
  );

  return finalizeTenantDerivedFields({
    tenantKey,
    tenantId: tenantKey,

    companyName,
    brandName: s(brand.name) || companyName,
    industryKey,

    defaultLanguage,
    outputLanguage,
    language: outputLanguage,

    ctaStyle:
      s(brand.ctaStyle) ||
      s(meta.ctaStyle) ||
      "contact",

    visualTheme:
      s(visualStyle.theme) ||
      s(brand.visualTheme) ||
      "premium_modern",

    tone: arr(brand.tone),
    services: arr(brand.services),
    audiences: arr(brand.audiences),
    requiredHashtags: arr(brand.requiredHashtags),
    preferredPresets: arr(
      visualStyle.preferredPresets || brand.preferredPresets
    ),
  });
}

function buildTenantPrompt(tenant = {}) {
  const t = obj(tenant);

  return fixText(`
TENANT RUNTIME CONTEXT:
- tenantKey: ${s(t.tenantKey || "default")}
- tenantId: ${s(t.tenantId || t.tenantKey || "default")}
- companyName: ${s(t.companyName || "This company")}
- brandName: ${s(t.brandName || t.companyName || "This company")}
- industryKey: ${s(t.industryKey || "generic_business")}
- defaultLanguage: ${s(t.defaultLanguage || "az")}
- outputLanguage: ${s(t.outputLanguage || t.language || "az")}
- visualTheme: ${s(t.visualTheme || "premium_modern")}
- ctaStyle: ${s(t.ctaStyle || "contact")}

TENANT BRAND TONE:
${s(t.toneText || "premium, modern, clear, commercially strong")}

TENANT SERVICES:
${s(t.servicesText || "general business services")}

TENANT AUDIENCES:
${s(t.audiencesText || "business owners, decision makers, customers")}

TENANT REQUIRED HASHTAGS:
${s(t.requiredHashtagsText || "#Business #Brand")}

TENANT PREFERRED VISUAL PRESETS:
${s(t.preferredPresetsText || "ai_core, automation_device, workflow_engine")}

TENANT OUTPUT RULES:
- Keep output aligned with this tenant’s real business identity.
- Do not drift into another industry unless clearly relevant.
- Prefer topics that are commercially useful for this tenant.
- If the tenant is premium-positioned, preserve premium language and premium visual direction.
- If the tenant serves practical business needs, prioritize usefulness over abstract hype.
- Use outputLanguage for normal written content unless another language is explicitly requested.
`);
}

function buildPromptVars({
  tenant = null,
  today = "",
  format = "",
  extra = {},
} = {}) {
  const normalizedTenant = normalizeTenantRuntime(tenant || {});
  const x = obj(extra);
  const xTenant = obj(x.tenant);

  let mergedTenant = deepFix({
    ...normalizedTenant,
    ...xTenant,
  });

  mergedTenant.tenantKey =
    s(mergedTenant.tenantKey) ||
    s(normalizedTenant.tenantKey) ||
    "default";

  mergedTenant.tenantId =
    s(mergedTenant.tenantId) ||
    s(mergedTenant.tenantKey) ||
    "default";

  mergedTenant.industryKey = normalizeIndustryKey(
    mergedTenant.industryKey ||
      normalizedTenant.industryKey ||
      "generic_business"
  );

  mergedTenant.defaultLanguage = normalizeLang(
    mergedTenant.defaultLanguage ||
      normalizedTenant.defaultLanguage ||
      "az"
  );

  mergedTenant.outputLanguage = normalizeLang(
    mergedTenant.outputLanguage ||
      mergedTenant.language ||
      normalizedTenant.outputLanguage ||
      mergedTenant.defaultLanguage
  );

  mergedTenant.language = mergedTenant.outputLanguage;

  mergedTenant = finalizeTenantDerivedFields(mergedTenant);

  return {
    today: s(today),
    format: normalizeFormat(format),
    tenant: mergedTenant,
    tenantId: mergedTenant.tenantId,
    language: mergedTenant.outputLanguage,
    outputLanguage: mergedTenant.outputLanguage,
    extra: x,
  };
}

export function buildPromptBundle(
  event,
  {
    tenant = null,
    today = "",
    format = "",
    extra = {},
  } = {}
) {
  let globalPolicy = "";
  let tenantPrompt = "";
  let industryPrompt = "";
  let usecaseKey = "";
  let usecasePrompt = "";

  const normalizedEvent = s(event).toLowerCase();

  const vars = buildPromptVars({
    tenant,
    today,
    format,
    extra,
  });

  try {
    globalPolicy = fixText(getGlobalPolicy(vars) || "");
  } catch {
    globalPolicy = "";
  }

  try {
    tenantPrompt = fixText(buildTenantPrompt(vars.tenant) || "");
  } catch {
    tenantPrompt = "";
  }

  try {
    industryPrompt = fixText(
      getIndustryPrompt(vars?.tenant?.industryKey, vars) || ""
    );
  } catch {
    industryPrompt = "";
  }

  usecaseKey = usecaseForEvent(normalizedEvent);

  if (usecaseKey) {
    try {
      usecasePrompt = fixText(getUsecasePrompt(usecaseKey, vars) || "");
    } catch {
      usecasePrompt = "";
    }
  }

  return deepFix({
    event: normalizedEvent,
    usecaseKey,
    industryKey: s(vars?.tenant?.industryKey || "generic_business"),
    tenant: vars.tenant,
    vars,
    globalPolicy,
    tenantPrompt,
    industryPrompt,
    usecasePrompt,
    fullPrompt: [
      globalPolicy,
      tenantPrompt,
      industryPrompt,
      usecasePrompt,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}