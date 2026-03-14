// src/routes/api/settings.js
// FINAL v2.8.0 — workspace settings routes + auth debug probes
// ✅ fixed imports
// ✅ db guards
// ✅ owner/admin/internal auth handling
// ✅ tenant secrets routes
// ✅ publish_policy.schedule + publish_policy.automation normalization
// ✅ backward-compatible with older draftSchedule payloads
// ✅ DEBUG: /settings/__debug-auth

import express from "express";
import {
  dbGetWorkspaceSettings,
  dbUpsertTenantCore,
  dbUpsertTenantProfile,
  dbUpsertTenantAiPolicy,
  dbListTenantChannels,
  dbUpsertTenantChannel,
  dbListTenantAgents,
  dbUpsertTenantAgent,
} from "../../db/helpers/settings.js";
import { dbGetTenantByKey } from "../../db/helpers/tenants.js";
import { dbListTenantUsers } from "../../db/helpers/tenantUsers.js";
import {
  dbListTenantSecretsMasked,
  dbGetTenantProviderSecrets,
  dbUpsertTenantSecret,
  dbDeleteTenantSecret,
} from "../../db/helpers/tenantSecrets.js";
import { dbAudit } from "../../db/helpers/audit.js";
import {
  requireInternalToken,
  getAuthTenantKey,
  getAuthRole,
  getAuthActor,
} from "../../utils/auth.js";

function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

function bad(res, error, extra = {}) {
  return res.status(400).json({ ok: false, error, ...extra });
}

function forbidden(res, error = "Forbidden", extra = {}) {
  return res.status(403).json({ ok: false, error, ...extra });
}

function unauth(res, error = "Unauthorized", extra = {}) {
  return res.status(401).json({ ok: false, error, ...extra });
}

function serverErr(res, error, extra = {}) {
  return res.status(500).json({ ok: false, error, ...extra });
}

function safeJsonObj(v, fallback = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return fallback;
}

function safeJsonArr(v, fallback = []) {
  return Array.isArray(v) ? v : fallback;
}

function cleanString(v, fallback = "") {
  if (v === null || v === undefined) return String(fallback ?? "").trim();
  const s = String(v).trim();
  if (!s) return String(fallback ?? "").trim();
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") {
    return String(fallback ?? "").trim();
  }
  return s;
}

function cleanNullableString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
  return s;
}

function cleanLower(v, fallback = "") {
  return cleanString(v, fallback).toLowerCase();
}

function normalizeBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

function normalizeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeJsonDateish(v) {
  const s = cleanNullableString(v);
  return s || null;
}

function hasDb(db) {
  return !!db?.query;
}

function isInternalServiceRequest(req) {
  try {
    return requireInternalToken(req) === true;
  } catch {
    return false;
  }
}

function getUserRole(req) {
  return cleanLower(getAuthRole(req), "member");
}

function getActor(req) {
  return cleanNullableString(getAuthActor(req)) || "system";
}

function resolveTenantKey(req) {
  if (isInternalServiceRequest(req)) {
    const internalTenantKey =
      req.query?.tenantKey ||
      req.query?.tenant_key ||
      req.body?.tenantKey ||
      req.body?.tenant_key ||
      req.headers["x-tenant-key"] ||
      "";

    return cleanLower(internalTenantKey);
  }

  return cleanLower(getAuthTenantKey(req));
}

function requireTenant(req, res) {
  const tenantKey = resolveTenantKey(req);
  if (!tenantKey) {
    unauth(res, "Missing tenant context");
    return null;
  }
  return tenantKey;
}

function requireOwnerOrAdmin(req, res) {
  if (isInternalServiceRequest(req)) {
    return "internal";
  }

  const role = getUserRole(req);
  if (role !== "owner" && role !== "admin") {
    forbidden(res, "Only owner/admin can manage settings");
    return null;
  }
  return role;
}

function requireDb(res, db) {
  if (hasDb(db)) return true;
  serverErr(res, "Database is not available");
  return false;
}

function buildTenantCoreSaveInput(input = {}, role = "member") {
  const out = {
    company_name: cleanString(input.company_name),
    industry_key: cleanLower(input.industry_key || "generic_business"),
    country_code: cleanString(input.country_code || "AZ").toUpperCase(),
    timezone: cleanString(input.timezone || "Asia/Baku"),
    default_language: cleanLower(input.default_language || "az"),
    enabled_languages: safeJsonArr(input.enabled_languages, ["az"])
      .map((x) => cleanLower(x))
      .filter(Boolean),
    market_region: cleanString(input.market_region),
  };

  if (!out.enabled_languages.length) {
    out.enabled_languages = ["az"];
  }

  if (role === "owner") {
    out.legal_name = cleanString(input.legal_name);
  }

  return out;
}

function buildProfileSaveInput(input = {}) {
  return {
    brand_name: cleanString(input.brand_name),
    website_url: cleanString(input.website_url),
    public_email: cleanString(input.public_email),
    public_phone: cleanString(input.public_phone),
    audience_summary: cleanString(input.audience_summary),
    services_summary: cleanString(input.services_summary),
    value_proposition: cleanString(input.value_proposition),
    brand_summary: cleanString(input.brand_summary),
    tone_of_voice: cleanLower(input.tone_of_voice || "professional"),
    preferred_cta: cleanString(input.preferred_cta),
    banned_phrases: safeJsonArr(input.banned_phrases, []),
    communication_rules: safeJsonObj(input.communication_rules, {}),
    visual_style: safeJsonObj(input.visual_style, {}),
    extra_context: safeJsonObj(input.extra_context, {}),
  };
}

function normalizeTimeString(input, fallback = "10:00") {
  const raw = cleanString(input, fallback);
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (!m) return fallback;

  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function normalizeAutomationMode(v, fallback = "manual") {
  const x = cleanLower(v, fallback);
  if (x === "full_auto") return "full_auto";
  return "manual";
}

function buildNormalizedPublishPolicy(input = {}, tenantTimezone = "Asia/Baku") {
  const root = safeJsonObj(input, {});

  const oldDraftSchedule = safeJsonObj(root.draftSchedule, {});
  const rawSchedule = safeJsonObj(root.schedule, {});
  const rawAutomation = safeJsonObj(root.automation, {});

  const fallbackHour = Number.isFinite(Number(oldDraftSchedule.hour))
    ? Math.max(0, Math.min(23, Number(oldDraftSchedule.hour)))
    : 10;

  const fallbackMinute = Number.isFinite(Number(oldDraftSchedule.minute))
    ? Math.max(0, Math.min(59, Number(oldDraftSchedule.minute)))
    : 0;

  const fallbackTime = `${String(fallbackHour).padStart(2, "0")}:${String(
    fallbackMinute
  ).padStart(2, "0")}`;

  const schedule = {
    enabled:
      typeof rawSchedule.enabled === "boolean"
        ? rawSchedule.enabled
        : typeof oldDraftSchedule.enabled === "boolean"
        ? oldDraftSchedule.enabled
        : false,
    time: normalizeTimeString(rawSchedule.time || fallbackTime, fallbackTime),
    timezone: cleanString(
      rawSchedule.timezone || oldDraftSchedule.timezone || tenantTimezone || "Asia/Baku",
      "Asia/Baku"
    ),
  };

  const automationEnabled =
    typeof rawAutomation.enabled === "boolean"
      ? rawAutomation.enabled
      : normalizeAutomationMode(rawAutomation.mode, "manual") === "full_auto";

  const automationMode = normalizeAutomationMode(
    rawAutomation.mode,
    automationEnabled ? "full_auto" : "manual"
  );

  const automation = {
    enabled: automationEnabled,
    mode: automationMode,
  };

  return {
    ...root,
    schedule,
    automation,
    draftSchedule: {
      enabled: schedule.enabled,
      hour: Number(schedule.time.split(":")[0]),
      minute: Number(schedule.time.split(":")[1]),
      timezone: schedule.timezone,
      format: cleanLower(oldDraftSchedule.format || "image", "image"),
    },
  };
}

function buildAiPolicySaveInput(input = {}, role = "member", tenantInput = {}) {
  const tenantTimezone = cleanString(tenantInput?.timezone || "Asia/Baku", "Asia/Baku");

  const out = {
    auto_reply_enabled: normalizeBool(input.auto_reply_enabled, true),
    suppress_ai_during_handoff: normalizeBool(input.suppress_ai_during_handoff, true),
    mark_seen_enabled: normalizeBool(input.mark_seen_enabled, true),
    typing_indicator_enabled: normalizeBool(input.typing_indicator_enabled, true),
    create_lead_enabled: normalizeBool(input.create_lead_enabled, true),
    approval_required_content: normalizeBool(input.approval_required_content, true),
    approval_required_publish: normalizeBool(input.approval_required_publish, true),
    quiet_hours_enabled: normalizeBool(input.quiet_hours_enabled, false),
    quiet_hours: safeJsonObj(input.quiet_hours, { startHour: 0, endHour: 0 }),
    inbox_policy: safeJsonObj(input.inbox_policy, {}),
    comment_policy: safeJsonObj(input.comment_policy, {}),
    content_policy: safeJsonObj(input.content_policy, {}),
    escalation_rules: safeJsonObj(input.escalation_rules, {}),
  };

  if (role === "owner" || role === "admin" || role === "internal") {
    out.risk_rules = safeJsonObj(input.risk_rules, {});
    out.lead_scoring_rules = safeJsonObj(input.lead_scoring_rules, {});
    out.publish_policy = buildNormalizedPublishPolicy(
      safeJsonObj(input.publish_policy, {}),
      tenantTimezone
    );
  }

  return out;
}

function buildChannelSaveInput(input = {}, role = "member") {
  const out = {
    provider: cleanLower(input.provider || "meta"),
    display_name: cleanString(input.display_name),
    status: cleanLower(input.status || "disconnected"),
    is_primary: normalizeBool(input.is_primary, false),
    config: safeJsonObj(input.config, {}),
  };

  if (role === "owner" || role === "admin" || role === "internal") {
    out.external_account_id = cleanNullableString(input.external_account_id);
    out.external_page_id = cleanNullableString(input.external_page_id);
    out.external_user_id = cleanNullableString(input.external_user_id);
    out.external_username = cleanNullableString(input.external_username);
    out.secrets_ref = cleanNullableString(input.secrets_ref);
    out.health = safeJsonObj(input.health, {});
    out.last_sync_at = normalizeJsonDateish(input.last_sync_at);
  }

  return out;
}

function buildAgentSaveInput(input = {}, role = "member") {
  const out = {
    display_name: cleanString(input.display_name),
    role_summary: cleanString(input.role_summary),
    enabled: normalizeBool(input.enabled, true),
  };

  if (role === "owner" || role === "admin" || role === "internal") {
    out.model = cleanString(input.model);
    out.temperature = normalizeNumber(input.temperature, 0.2);
    out.prompt_overrides = safeJsonObj(input.prompt_overrides, {});
    out.tool_access = safeJsonObj(input.tool_access, {});
    out.limits = safeJsonObj(input.limits, {});
  }

  return out;
}

async function auditSafe(db, req, tenant, action, objectType, objectId, meta = {}) {
  try {
    await dbAudit(db, getActor(req), action, objectType, objectId, {
      tenantId: tenant?.id || null,
      tenantKey: tenant?.tenant_key || tenant?.tenantKey || null,
      viewerRole: isInternalServiceRequest(req) ? "internal" : getUserRole(req),
      ...meta,
    });
  } catch {}
}

export function settingsRoutes({ db }) {
  const router = express.Router();

  router.get("/settings/__debug-auth", async (req, res) => {
    return res.status(200).json({
      ok: true,
      marker: "SETTINGS_DEBUG_AUTH_V2",
      auth: req.auth || null,
      user: req.user || null,
      tenantKeyResolved: resolveTenantKey(req),
      roleResolved: getUserRole(req),
      isInternal: isInternalServiceRequest(req),
      hasDb: hasDb(db),
    });
  });

  router.get("/settings/workspace", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const settings = await dbGetWorkspaceSettings(db, tenantKey);
      if (!settings) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      return ok(res, {
        ...settings,
        viewerRole: isInternalServiceRequest(req) ? "internal" : getUserRole(req),
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load workspace settings");
    }
  });

  router.post("/settings/workspace", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = requireOwnerOrAdmin(req, res);
      if (!role) return;

      const body = safeJsonObj(req.body, {});
      const tenantInput = safeJsonObj(body.tenant, {});
      const profileInput = safeJsonObj(body.profile, {});
      const aiPolicyInput = safeJsonObj(body.aiPolicy, {});

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const tenantCoreInput = buildTenantCoreSaveInput(tenantInput, role);
      const profileSaveInput = buildProfileSaveInput(profileInput);
      const aiPolicySaveInput = buildAiPolicySaveInput(aiPolicyInput, role, tenantCoreInput);

      const tenantCore = await dbUpsertTenantCore(db, tenantKey, tenantCoreInput);
      const profile = await dbUpsertTenantProfile(db, tenant.id, profileSaveInput);
      const aiPolicy = await dbUpsertTenantAiPolicy(db, tenant.id, aiPolicySaveInput);

      const settings = await dbGetWorkspaceSettings(db, tenantKey);

      await auditSafe(db, req, tenant, "settings.workspace.updated", "tenant", tenant.id, {
        scope: "workspace",
      });

      return ok(res, {
        tenant: settings?.tenant || tenantCore,
        profile: settings?.profile || profile,
        aiPolicy: settings?.aiPolicy || aiPolicy,
        viewerRole: role,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to save workspace settings");
    }
  });

  router.get("/settings/channels", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const channels = await dbListTenantChannels(db, tenant.id);
      return ok(res, {
        channels,
        viewerRole: isInternalServiceRequest(req) ? "internal" : getUserRole(req),
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load channels");
    }
  });

  router.post("/settings/channels/:type", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = requireOwnerOrAdmin(req, res);
      if (!role) return;

      const channelType = cleanLower(req.params.type);
      if (!channelType) return bad(res, "channel type is required");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const body = safeJsonObj(req.body, {});
      const saveInput = buildChannelSaveInput(body, role);

      const channel = await dbUpsertTenantChannel(db, tenant.id, channelType, saveInput);

      await auditSafe(
        db,
        req,
        tenant,
        "settings.channel.updated",
        "tenant_channel",
        channel?.id || channelType,
        {
          channelType,
          provider: saveInput.provider,
        }
      );

      return ok(res, { channel, viewerRole: role });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to save channel");
    }
  });

  router.get("/settings/agents", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const agents = await dbListTenantAgents(db, tenant.id);
      return ok(res, {
        agents,
        viewerRole: isInternalServiceRequest(req) ? "internal" : getUserRole(req),
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load agents");
    }
  });

  router.post("/settings/agents/:key", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = requireOwnerOrAdmin(req, res);
      if (!role) return;

      const agentKey = cleanLower(req.params.key);
      if (!agentKey) return bad(res, "agent key is required");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const body = safeJsonObj(req.body, {});
      const saveInput = buildAgentSaveInput(body, role);

      const agent = await dbUpsertTenantAgent(db, tenant.id, agentKey, saveInput);

      await auditSafe(
        db,
        req,
        tenant,
        "settings.agent.updated",
        "tenant_agent",
        agent?.id || agentKey,
        {
          agentKey,
        }
      );

      return ok(res, { agent, viewerRole: role });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to save agent");
    }
  });

  router.get("/settings/team", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const users = await dbListTenantUsers(db, tenant.id);
      return ok(res, {
        users,
        viewerRole: isInternalServiceRequest(req) ? "internal" : getUserRole(req),
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load team");
    }
  });

  router.get("/settings/secrets", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const internal = isInternalServiceRequest(req);

      if (!internal) {
        const role = requireOwnerOrAdmin(req, res);
        if (!role) return;
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const provider = cleanLower(req.query.provider || "");

      if (internal) {
        const secrets = provider
          ? await dbGetTenantProviderSecrets(db, tenant.id, provider)
          : {};
        return ok(res, {
          secrets,
          viewerRole: "internal",
        });
      }

      const secrets = await dbListTenantSecretsMasked(db, tenant.id, provider);
      return ok(res, {
        secrets,
        viewerRole: getUserRole(req),
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load secrets");
    }
  });

  router.post("/settings/secrets/:provider/:key", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = requireOwnerOrAdmin(req, res);
      if (!role) return;

      const provider = cleanLower(req.params.provider);
      const secretKey = cleanLower(req.params.key);

      if (!provider) return bad(res, "provider is required");
      if (!secretKey) return bad(res, "secret key is required");

      const secretValue = cleanString(req.body?.value || req.body?.secret || "");
      if (!secretValue) return bad(res, "secret value is required");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const saved = await dbUpsertTenantSecret(
        db,
        tenant.id,
        provider,
        secretKey,
        secretValue,
        getActor(req)
      );

      await auditSafe(
        db,
        req,
        tenant,
        "settings.secret.updated",
        "tenant_secret",
        saved?.id || `${provider}:${secretKey}`,
        {
          provider,
          secretKey,
        }
      );

      return ok(res, {
        saved: true,
        secret: saved,
        viewerRole: role,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to save secret");
    }
  });

  router.delete("/settings/secrets/:provider/:key", async (req, res) => {
    try {
      if (!requireDb(res, db)) return;

      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = requireOwnerOrAdmin(req, res);
      if (!role) return;

      const provider = cleanLower(req.params.provider);
      const secretKey = cleanLower(req.params.key);

      if (!provider) return bad(res, "provider is required");
      if (!secretKey) return bad(res, "secret key is required");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const deleted = await dbDeleteTenantSecret(db, tenant.id, provider, secretKey);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: "Secret not found" });
      }

      await auditSafe(
        db,
        req,
        tenant,
        "settings.secret.deleted",
        "tenant_secret",
        `${provider}:${secretKey}`,
        {
          provider,
          secretKey,
        }
      );

      return ok(res, {
        deleted: true,
        provider,
        secretKey,
        viewerRole: role,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to delete secret");
    }
  });

  return router;
}