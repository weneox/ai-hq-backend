// src/services/promptBundle.js
// FINAL v4.1 — universal multi-industry + multi-tenant prompt bundle builder
//
// ✅ tenant-aware
// ✅ industry-aware
// ✅ profile/brand/root/ai_policy/meta aware
// ✅ explicit tenant prompt layer
// ✅ event -> usecase mapping
// ✅ recomputes derived tenant text fields after extra merge
// ✅ stable language / format normalization
// ✅ safer multi-tenant merging
// ✅ future-proof for any business type
// ✅ inbox.reply usecase support

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

function uniqStrings(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const v = s(item);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function normalizeTextList(input = [], fallback = "") {
  const list = uniqStrings(
    arr(input)
      .map((x) => {
        if (typeof x === "string") return fixText(String(x || "").trim());
        if (x && typeof x === "object") {
          return fixText(
            String(
              x.name ||
                x.title ||
                x.label ||
                x.value ||
                x.key ||
                ""
            ).trim()
          );
        }
        return "";
      })
      .filter(Boolean)
  );

  if (!list.length) return fallback;
  return list.join(", ");
}

function normalizeHashtagList(input = [], fallback = "") {
  const list = uniqStrings(
    arr(input)
      .map((x) => {
        const raw =
          typeof x === "string"
            ? String(x || "").trim()
            : String(
                x?.name ||
                  x?.title ||
                  x?.label ||
                  x?.value ||
                  x?.key ||
                  ""
              ).trim();

        if (!raw) return "";
        return raw.startsWith("#") ? raw : `#${raw}`;
      })
      .filter(Boolean)
  );

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

function normalizeFormat(v, fallback = "") {
  const x = s(v).toLowerCase();
  if (x === "image") return "image";
  if (x === "carousel") return "carousel";
  if (x === "reel") return "reel";
  return fallback ? s(fallback).toLowerCase() : x;
}

function usecaseForEvent(event) {
  const e = s(event).toLowerCase();

  if (!e) return "";

  if (
    e === "content.draft" ||
    e === "draft" ||
    e === "content_draft" ||
    e === "proposal.approved"
  ) return "content.draft";

  if (
    e === "content.revise" ||
    e === "revise" ||
    e === "content_revise"
  ) return "content.revise";

  if (
    e === "content.publish" ||
    e === "publish" ||
    e === "content_publish" ||
    e === "content.approved"
  ) return "content.publish";

  if (
    e === "meta.comment_reply" ||
    e === "comment" ||
    e === "meta_comment_reply"
  ) return "meta.comment_reply";

  if (
    e === "trend.research" ||
    e === "trend" ||
    e === "trend_research"
  ) return "trend.research";

  if (
    e === "content.analyze" ||
    e === "analyze" ||
    e === "content_analyze"
  ) return "content.analyze";

  if (
    e === "content.fix_plan" ||
    e === "fix_plan" ||
    e === "content_fix_plan"
  ) return "content.fix_plan";

  if (
    e === "inbox.reply" ||
    e === "inbox_reply" ||
    e === "dm.reply" ||
    e === "dm_reply" ||
    e === "message.reply" ||
    e === "message_reply"
  ) return "inbox.reply";

  return "";
}

function pickFirstNonEmpty(...values) {
  for (const v of values) {
    const t = s(v);
    if (t) return t;
  }
  return "";
}

function finalizeTenantDerivedFields(raw = {}) {
  const t = obj(raw);

  const tone = uniqStrings(arr(t.tone));
  const services = uniqStrings(arr(t.services));
  const audiences = uniqStrings(arr(t.audiences));
  const requiredHashtags = uniqStrings(
    arr(t.requiredHashtags).map((x) => {
      const tag = s(x);
      if (!tag) return "";
      return tag.startsWith("#") ? tag : `#${tag}`;
    })
  ).filter(Boolean);

  const preferredPresets = uniqStrings(arr(t.preferredPresets));

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
      "industry-appropriate premium visual direction"
    ),
  };
}

function normalizeTenantRuntime(raw = {}) {
  const tenant = obj(raw);
  const profile = obj(tenant.profile);
  const brand = obj(tenant.brand);
  const meta = obj(tenant.meta);
  const aiPolicy = obj(tenant.ai_policy || tenant.aiPolicy);
  const visualStyle = obj(
    brand.visualStyle ||
      profile.visualStyle ||
      tenant.visualStyle
  );

  const tenantKey =
    pickFirstNonEmpty(
      tenant.tenant_key,
      tenant.tenantKey,
      tenant.tenantId,
      profile.tenantKey,
      profile.tenantId,
      brand.tenantKey,
      meta.tenantKey,
      "default"
    ) || "default";

  const companyName =
    pickFirstNonEmpty(
      brand.displayName,
      brand.companyName,
      brand.name,
      profile.displayName,
      profile.companyName,
      tenant.companyName,
      tenant.brandName,
      tenant.name,
      meta.companyName,
      tenantKey,
      "This company"
    ) || "This company";

  const brandName =
    pickFirstNonEmpty(
      brand.displayName,
      brand.name,
      tenant.brandName,
      companyName
    ) || companyName;

  const industryKey = normalizeIndustryKey(
    pickFirstNonEmpty(
      tenant.industryKey,
      tenant.industry,
      profile.industryKey,
      profile.industry,
      brand.industryKey,
      brand.industry,
      meta.industryKey,
      meta.industry,
      "generic_business"
    )
  );

  const defaultLanguage = normalizeLang(
    pickFirstNonEmpty(
      tenant.defaultLanguage,
      tenant.language,
      profile.defaultLanguage,
      profile.language,
      brand.defaultLanguage,
      brand.language,
      meta.defaultLanguage,
      meta.language,
      "az"
    )
  );

  const outputLanguage = normalizeLang(
    pickFirstNonEmpty(
      tenant.outputLanguage,
      profile.outputLanguage,
      brand.outputLanguage,
      meta.outputLanguage,
      defaultLanguage
    )
  );

  const tone = uniqStrings([
    ...arr(tenant.tone),
    ...arr(profile.tone),
    ...arr(brand.tone),
  ]);

  const services = uniqStrings([
    ...arr(tenant.services),
    ...arr(profile.services),
    ...arr(brand.services),
  ]);

  const audiences = uniqStrings([
    ...arr(tenant.audiences),
    ...arr(profile.audiences),
    ...arr(brand.audiences),
  ]);

  const requiredHashtags = uniqStrings([
    ...arr(tenant.requiredHashtags),
    ...arr(profile.requiredHashtags),
    ...arr(brand.requiredHashtags),
  ]);

  const preferredPresets = uniqStrings([
    ...arr(tenant.preferredPresets),
    ...arr(profile.preferredPresets),
    ...arr(brand.preferredPresets),
    ...arr(visualStyle.preferredPresets),
  ]);

  return finalizeTenantDerivedFields({
    tenantKey,
    tenantId: tenantKey,

    companyName,
    brandName,
    industryKey,

    defaultLanguage,
    outputLanguage,
    language: outputLanguage,

    ctaStyle:
      pickFirstNonEmpty(
        tenant.ctaStyle,
        profile.ctaStyle,
        brand.ctaStyle,
        meta.ctaStyle,
        "contact"
      ) || "contact",

    visualTheme:
      pickFirstNonEmpty(
        tenant.visualTheme,
        profile.visualTheme,
        brand.visualTheme,
        visualStyle.theme,
        meta.visualTheme,
        "premium_modern"
      ) || "premium_modern",

    businessContext:
      pickFirstNonEmpty(
        tenant.businessContext,
        profile.businessContext,
        aiPolicy.businessContext,
        meta.businessContext
      ) || "",

    tone,
    services,
    audiences,
    requiredHashtags,
    preferredPresets,

    toneText:
      pickFirstNonEmpty(
        tenant.toneText,
        profile.toneText,
        brand.toneText,
        aiPolicy.toneText,
        meta.toneText
      ) || undefined,

    servicesText:
      pickFirstNonEmpty(
        tenant.servicesText,
        profile.servicesText,
        brand.servicesText,
        aiPolicy.servicesText,
        meta.servicesText
      ) || undefined,

    audiencesText:
      pickFirstNonEmpty(
        tenant.audiencesText,
        profile.audiencesText,
        brand.audiencesText,
        meta.audiencesText
      ) || undefined,

    requiredHashtagsText:
      pickFirstNonEmpty(
        tenant.requiredHashtagsText,
        profile.requiredHashtagsText,
        brand.requiredHashtagsText,
        meta.requiredHashtagsText
      ) || undefined,

    preferredPresetsText:
      pickFirstNonEmpty(
        tenant.preferredPresetsText,
        profile.preferredPresetsText,
        brand.preferredPresetsText,
        meta.preferredPresetsText
      ) || undefined,
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

TENANT BUSINESS CONTEXT:
${s(t.businessContext || "No extra business context provided.")}

TENANT BRAND TONE:
${s(t.toneText || "premium, modern, clear, commercially strong")}

TENANT SERVICES:
${s(t.servicesText || "general business services")}

TENANT AUDIENCES:
${s(t.audiencesText || "business owners, decision makers, customers")}

TENANT REQUIRED HASHTAGS:
${s(t.requiredHashtagsText || "#Business #Brand")}

TENANT PREFERRED VISUAL PRESETS:
${s(t.preferredPresetsText || "industry-appropriate premium visual direction")}

TENANT OUTPUT RULES:
- Keep output aligned with this tenant’s real business identity.
- Do not drift into another industry unless clearly relevant.
- Prefer topics that are commercially useful for this tenant.
- If the tenant is premium-positioned, preserve premium language and premium visual direction.
- If the tenant serves practical business needs, prioritize usefulness over abstract hype.
- Use outputLanguage for normal written content unless another language is explicitly requested.
- The tenant is NOT automatically a technology company.
- Do not force AI, robotics, futuristic technology, dashboards, software UI, or digital transformation imagery unless the tenant’s business and request clearly support it.
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

  mergedTenant.companyName =
    s(mergedTenant.companyName) ||
    s(normalizedTenant.companyName) ||
    "This company";

  mergedTenant.brandName =
    s(mergedTenant.brandName) ||
    s(mergedTenant.companyName) ||
    s(normalizedTenant.brandName) ||
    s(normalizedTenant.companyName) ||
    "This company";

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

  mergedTenant.visualTheme =
    s(mergedTenant.visualTheme) ||
    s(normalizedTenant.visualTheme) ||
    "premium_modern";

  mergedTenant.ctaStyle =
    s(mergedTenant.ctaStyle) ||
    s(normalizedTenant.ctaStyle) ||
    "contact";

  mergedTenant = finalizeTenantDerivedFields(mergedTenant);

  const normalizedEvent = s(eventFromExtra(x)).toLowerCase();
  const normalizedUsecase = usecaseForEvent(normalizedEvent);

  const normalizedFormat =
    normalizeFormat(format) ||
    normalizeFormat(x.format) ||
    (normalizedUsecase === "content.draft" ? "image" : "");

  return {
    today: s(today),
    format: normalizedFormat,
    tenant: mergedTenant,
    tenantId: mergedTenant.tenantId,
    language: mergedTenant.outputLanguage,
    outputLanguage: mergedTenant.outputLanguage,
    extra: x,
  };
}

function eventFromExtra(x = {}) {
  return s(x.event || x.mode || "");
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
    extra: {
      ...obj(extra),
      event: normalizedEvent,
    },
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
