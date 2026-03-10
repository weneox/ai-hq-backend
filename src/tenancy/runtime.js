// src/tenancy/runtime.js

import { getDefaultTenantKey, resolveTenantKey } from "./index.js";

function s(v, d = "") {
  const x = String(v ?? "").trim();
  return x || d;
}

function b(v, d = false) {
  if (typeof v === "boolean") return v;
  const x = String(v ?? "").trim().toLowerCase();
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function normalizeTenantRuntime(tenant) {
  const t = asObj(tenant);
  const brand = asObj(t.brand);
  const meta = asObj(t.meta);
  const schedule = asObj(t.schedule);
  const inboxPolicy = asObj(t.inbox_policy || t.inboxPolicy);
  const providers = asObj(t.providers);
  const features = asObj(t.features);

  return {
    tenantKey: s(t.tenant_key || t.tenantKey, getDefaultTenantKey()),
    name: s(t.name),
    active: b(t.active, true),
    timezone: s(t.timezone, "Asia/Baku"),

    brand: {
      displayName: s(brand.displayName || brand.name || t.name),
      email: s(brand.email),
      phone: s(brand.phone),
      website: s(brand.website),
      logoUrl: s(brand.logoUrl || brand.logo_url),
    },

    meta: {
      pageId: s(meta.pageId || meta.page_id),
      igUserId: s(meta.igUserId || meta.ig_user_id),
    },

    schedule: {
      tz: s(schedule.tz || t.timezone, "Asia/Baku"),
      publishHourLocal: n(schedule.publishHourLocal, 10),
      publishMinuteLocal: n(schedule.publishMinuteLocal, 0),
    },

    inboxPolicy: {
      autoReplyEnabled: b(inboxPolicy.autoReplyEnabled, true),
      createLeadEnabled: b(inboxPolicy.createLeadEnabled, true),
      handoffEnabled: b(inboxPolicy.handoffEnabled, true),
      markSeenEnabled: b(inboxPolicy.markSeenEnabled, true),
      typingIndicatorEnabled: b(inboxPolicy.typingIndicatorEnabled, true),
      suppressAiDuringHandoff: b(inboxPolicy.suppressAiDuringHandoff, true),
      autoReleaseOnOperatorReply: b(inboxPolicy.autoReleaseOnOperatorReply, false),
      allowedChannels: Array.isArray(inboxPolicy.allowedChannels)
        ? inboxPolicy.allowedChannels.map((x) => String(x).trim()).filter(Boolean)
        : [],
      quietHoursEnabled: b(inboxPolicy.quietHoursEnabled, false),
      quietHoursStart: n(inboxPolicy.quietHoursStart, 0),
      quietHoursEnd: n(inboxPolicy.quietHoursEnd, 0),
      humanKeywords: Array.isArray(inboxPolicy.humanKeywords)
        ? inboxPolicy.humanKeywords.map((x) => String(x).trim()).filter(Boolean)
        : [],
    },

    providers: {
      llm: s(providers.llm, "openai"),
      image: s(providers.image, "openai_images"),
      video: s(providers.video, "runway"),
      storage: s(providers.storage, "cloudinary"),
      publish: s(providers.publish, "meta"),
      tts: s(providers.tts, "openai"),
    },

    features: {
      comments: b(features.comments, true),
      inbox: b(features.inbox, true),
      leads: b(features.leads, true),
      content: b(features.content, true),
      publishing: b(features.publishing, true),
    },
  };
}

export async function getTenantRuntimeByKey({ db, getTenantByKey, tenantKey }) {
  const resolvedTenantKey = resolveTenantKey(tenantKey);

  if (!db || typeof getTenantByKey !== "function") {
    return normalizeTenantRuntime({ tenant_key: resolvedTenantKey });
  }

  const tenant = await getTenantByKey(db, resolvedTenantKey);
  if (!tenant) {
    return normalizeTenantRuntime({ tenant_key: resolvedTenantKey });
  }

  return normalizeTenantRuntime(tenant);
}