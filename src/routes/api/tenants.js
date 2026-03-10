// src/routes/api/tenants.js
// FINAL v1.6 — platform tenant onboarding routes + channel resolver + JSON/CSV/ZIP export

import express from "express";
import archiver from "archiver";
import {
  dbGetTenantByKey,
  dbGetWorkspaceSettings,
  dbUpsertTenantCore,
  dbUpsertTenantProfile,
  dbUpsertTenantAiPolicy,
  dbUpsertTenantChannel,
  dbUpsertTenantAgent,
} from "../../db/helpers/settings.js";
import {
  dbCreateTenantUser,
  dbGetTenantUserByEmail,
} from "../../db/helpers/tenantUsers.js";
import { dbAudit } from "../../db/helpers/audit.js";
import {
  dbExportTenantBundle,
  dbExportTenantCsvBundle,
} from "../../db/helpers/tenantExport.js";
import {
  requireInternalToken,
  getAuthRole,
  getAuthActor,
} from "../../utils/auth.js";

function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

function bad(res, error, extra = {}) {
  return res.status(400).json({ ok: false, error, ...extra });
}

function unauth(res, error = "Unauthorized", extra = {}) {
  return res.status(401).json({ ok: false, error, ...extra });
}

function serverErr(res, error, extra = {}) {
  return res.status(500).json({ ok: false, error, ...extra });
}

function rowOrNull(r) {
  return r?.rows?.[0] || null;
}

function rows(r) {
  return Array.isArray(r?.rows) ? r.rows : [];
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

function cleanUpper(v, fallback = "") {
  return cleanString(v, fallback).toUpperCase();
}

function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

function asJsonObj(v, fallback = {}) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
}

function asJsonArr(v, fallback = []) {
  return Array.isArray(v) ? v : fallback;
}

function slugTenantKey(v) {
  const raw = cleanLower(v);
  if (!raw) return "";
  return raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 64);
}

function validTenantKey(v) {
  return /^[a-z0-9][a-z0-9_]{1,63}$/.test(String(v || ""));
}

function safeEmail(v) {
  return cleanLower(v);
}

function isLikelyEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

function defaultEnabledLanguages(input) {
  const arr = asJsonArr(input, ["az"])
    .map((x) => cleanLower(x))
    .filter(Boolean);
  return arr.length ? [...new Set(arr)] : ["az"];
}

function isOwnerOrAdmin(req) {
  const role = cleanLower(getAuthRole(req), "member");
  return role === "owner" || role === "admin";
}

function canAccessTenantsApi(req) {
  try {
    if (requireInternalToken(req) === true) return true;
  } catch {}
  return isOwnerOrAdmin(req);
}

function getActor(req) {
  const authActor = cleanNullableString(getAuthActor(req));
  if (authActor) return authActor;

  return (
    cleanString(req.headers["x-actor-email"]) ||
    cleanString(req.headers["x-actor"]) ||
    (isOwnerOrAdmin(req) ? "admin" : "platform")
  );
}

function buildTenantCoreInput(body = {}) {
  const tenant = asJsonObj(body.tenant, body);

  const tenantKey = slugTenantKey(tenant.tenant_key || tenant.tenantKey || "");
  const companyName = cleanString(tenant.company_name || tenant.companyName || "");
  const legalName = cleanNullableString(tenant.legal_name || tenant.legalName);
  const industryKey = cleanLower(
    tenant.industry_key || tenant.industryKey || "generic_business"
  );
  const countryCode = cleanUpper(tenant.country_code || tenant.countryCode || "AZ");
  const timezone = cleanString(tenant.timezone || "Asia/Baku");
  const defaultLanguage = cleanLower(
    tenant.default_language || tenant.defaultLanguage || "az"
  );
  const enabledLanguages = defaultEnabledLanguages(
    tenant.enabled_languages || tenant.enabledLanguages || [defaultLanguage]
  );
  const marketRegion = cleanNullableString(
    tenant.market_region || tenant.marketRegion
  );

  return {
    tenant_key: tenantKey,
    company_name: companyName,
    legal_name: legalName,
    industry_key: industryKey,
    country_code: countryCode,
    timezone,
    default_language: defaultLanguage,
    enabled_languages: enabledLanguages,
    market_region: marketRegion,
  };
}

function buildProfileInput(body = {}, core = {}) {
  const p = asJsonObj(body.profile, {});

  return {
    brand_name: cleanString(
      p.brand_name || p.brandName || core.company_name || ""
    ),
    website_url: cleanNullableString(p.website_url || p.websiteUrl),
    public_email: cleanNullableString(p.public_email || p.publicEmail),
    public_phone: cleanNullableString(p.public_phone || p.publicPhone),
    audience_summary: cleanString(p.audience_summary || p.audienceSummary || ""),
    services_summary: cleanString(p.services_summary || p.servicesSummary || ""),
    value_proposition: cleanString(
      p.value_proposition || p.valueProposition || ""
    ),
    brand_summary: cleanString(p.brand_summary || p.brandSummary || ""),
    tone_of_voice: cleanLower(
      p.tone_of_voice || p.toneOfVoice || "professional"
    ),
    preferred_cta: cleanString(p.preferred_cta || p.preferredCta || ""),
    banned_phrases: asJsonArr(p.banned_phrases || p.bannedPhrases, []),
    communication_rules: asJsonObj(
      p.communication_rules || p.communicationRules,
      {}
    ),
    visual_style: asJsonObj(p.visual_style || p.visualStyle, {}),
    extra_context: asJsonObj(p.extra_context || p.extraContext, {}),
  };
}

function buildAiPolicyInput(body = {}) {
  const x = asJsonObj(body.aiPolicy, {});

  return {
    auto_reply_enabled: asBool(x.auto_reply_enabled, true),
    suppress_ai_during_handoff: asBool(x.suppress_ai_during_handoff, true),
    mark_seen_enabled: asBool(x.mark_seen_enabled, true),
    typing_indicator_enabled: asBool(x.typing_indicator_enabled, true),
    create_lead_enabled: asBool(x.create_lead_enabled, true),
    approval_required_content: asBool(x.approval_required_content, true),
    approval_required_publish: asBool(x.approval_required_publish, true),
    quiet_hours_enabled: asBool(x.quiet_hours_enabled, false),
    quiet_hours: asJsonObj(x.quiet_hours, { startHour: 0, endHour: 0 }),
    inbox_policy: asJsonObj(x.inbox_policy, {}),
    comment_policy: asJsonObj(x.comment_policy, {}),
    content_policy: asJsonObj(x.content_policy, {}),
    escalation_rules: asJsonObj(x.escalation_rules, {}),
    risk_rules: asJsonObj(x.risk_rules, {}),
    lead_scoring_rules: asJsonObj(x.lead_scoring_rules, {}),
    publish_policy: asJsonObj(x.publish_policy, {}),
  };
}

function buildOwnerInput(body = {}, core = {}) {
  const owner = asJsonObj(body.owner, {});

  return {
    user_email: safeEmail(owner.user_email || owner.email || ""),
    full_name: cleanString(
      owner.full_name || owner.fullName || core.company_name || "Owner"
    ),
    role: "owner",
    status: "active",
    permissions: asJsonObj(owner.permissions, {}),
    meta: asJsonObj(owner.meta, {}),
    last_seen_at: null,
  };
}

function pickDefaultAgents(body = {}) {
  const agents = asJsonArr(body.defaultAgents, []);
  if (agents.length) return agents;

  return [
    {
      agent_key: "orion",
      display_name: "Orion",
      role_summary: "Strategic planner and high-level business thinker.",
      enabled: true,
      model: "gpt-5",
      temperature: 0.4,
      prompt_overrides: {},
      tool_access: {},
      limits: {},
    },
    {
      agent_key: "nova",
      display_name: "Nova",
      role_summary: "Creative and content generation specialist.",
      enabled: true,
      model: "gpt-5",
      temperature: 0.8,
      prompt_overrides: {},
      tool_access: {},
      limits: {},
    },
    {
      agent_key: "atlas",
      display_name: "Atlas",
      role_summary: "Sales, operations, CRM and inbox specialist.",
      enabled: true,
      model: "gpt-5",
      temperature: 0.5,
      prompt_overrides: {},
      tool_access: {},
      limits: {},
    },
    {
      agent_key: "echo",
      display_name: "Echo",
      role_summary: "Analytics, QA and insight specialist.",
      enabled: true,
      model: "gpt-5",
      temperature: 0.3,
      prompt_overrides: {},
      tool_access: {},
      limits: {},
    },
  ];
}

function pickChannels(body = {}) {
  return asJsonArr(body.channels, []);
}

async function auditSafe(db, actor, action, objectType, objectId, meta = {}) {
  try {
    await dbAudit(db, actor || "system", action, objectType, objectId, meta);
  } catch {}
}

async function dbListTenants(db, opts = {}) {
  const status = cleanLower(opts.status || "");
  const activeOnly = opts.activeOnly === true;
  const clauses = [];
  const params = [];
  let i = 1;

  if (status) {
    clauses.push(`status = $${i++}`);
    params.push(status);
  }

  if (activeOnly) {
    clauses.push(`active = true`);
  }

  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";

  const q = await db.query(
    `
      select
        id,
        tenant_key,
        company_name,
        legal_name,
        industry_key,
        country_code,
        timezone,
        default_language,
        enabled_languages,
        market_region,
        plan_key,
        status,
        active,
        onboarding_completed_at,
        created_at,
        updated_at
      from tenants
      ${where}
      order by created_at desc
    `,
    params
  );

  return rows(q);
}

async function dbGetTenantDetail(db, tenantKey) {
  const tenant = await dbGetTenantByKey(db, tenantKey);
  if (!tenant?.id) return null;
  return dbGetWorkspaceSettings(db, tenant.tenant_key);
}

async function dbPatchTenantByKey(db, tenantKey, input = {}) {
  const current = await dbGetTenantByKey(db, tenantKey);
  if (!current?.id) return null;

  const allowed = {
    company_name: cleanString(input.company_name, current.company_name || ""),
    legal_name: Object.prototype.hasOwnProperty.call(input, "legal_name")
      ? cleanNullableString(input.legal_name)
      : current.legal_name,
    industry_key: cleanLower(
      input.industry_key,
      current.industry_key || "generic_business"
    ),
    country_code: cleanUpper(input.country_code, current.country_code || "AZ"),
    timezone: cleanString(input.timezone, current.timezone || "Asia/Baku"),
    default_language: cleanLower(
      input.default_language,
      current.default_language || "az"
    ),
    enabled_languages: defaultEnabledLanguages(
      Object.prototype.hasOwnProperty.call(input, "enabled_languages")
        ? input.enabled_languages
        : current.enabled_languages || ["az"]
    ),
    market_region: Object.prototype.hasOwnProperty.call(input, "market_region")
      ? cleanNullableString(input.market_region)
      : current.market_region,
    plan_key: cleanLower(input.plan_key, current.plan_key || "starter"),
    status: cleanLower(input.status, current.status || "active"),
    active: Object.prototype.hasOwnProperty.call(input, "active")
      ? asBool(input.active, true)
      : current.active,
    onboarding_completed_at: Object.prototype.hasOwnProperty.call(
      input,
      "onboarding_completed_at"
    )
      ? cleanNullableString(input.onboarding_completed_at)
      : current.onboarding_completed_at,
  };

  const q = await db.query(
    `
      update tenants
      set
        company_name = $2,
        legal_name = $3,
        industry_key = $4,
        country_code = $5,
        timezone = $6,
        default_language = $7,
        enabled_languages = $8::jsonb,
        market_region = $9,
        plan_key = $10,
        status = $11,
        active = $12,
        onboarding_completed_at = $13
      where lower(tenant_key) = $1
      returning *
    `,
    [
      cleanLower(tenantKey),
      allowed.company_name,
      allowed.legal_name,
      allowed.industry_key,
      allowed.country_code,
      allowed.timezone,
      allowed.default_language,
      JSON.stringify(allowed.enabled_languages),
      allowed.market_region,
      allowed.plan_key,
      allowed.status,
      allowed.active,
      allowed.onboarding_completed_at,
    ]
  );

  return rowOrNull(q);
}

async function dbResolveTenantChannel(
  db,
  { channel, recipientId, pageId, igUserId }
) {
  if (!db) return null;

  const safeChannel = cleanLower(channel);
  const safeRecipientId = cleanNullableString(recipientId);
  const safePageId = cleanNullableString(pageId);
  const safeIgUserId = cleanNullableString(igUserId);

  if (!safeChannel) return null;
  if (!safeRecipientId && !safePageId && !safeIgUserId) return null;

  const q = await db.query(
    `
      select
        tc.id,
        tc.tenant_id,
        tc.channel_type,
        tc.provider,
        tc.display_name,
        tc.external_account_id,
        tc.external_page_id,
        tc.external_user_id,
        tc.external_username,
        tc.status,
        tc.is_primary,
        tc.config,
        tc.secrets_ref,
        tc.health,
        tc.last_sync_at,
        tc.created_at,
        tc.updated_at,
        t.tenant_key,
        t.company_name,
        t.legal_name,
        t.industry_key,
        t.country_code,
        t.timezone,
        t.default_language,
        t.enabled_languages,
        t.market_region,
        t.plan_key,
        t.status as tenant_status,
        t.active as tenant_active
      from tenant_channels tc
      join tenants t on t.id = tc.tenant_id
      where tc.channel_type = $1
        and (
          ($2::text is not null and tc.external_page_id = $2)
          or ($3::text is not null and tc.external_user_id = $3)
          or ($4::text is not null and tc.external_account_id = $4)
        )
      order by
        tc.is_primary desc,
        tc.updated_at desc,
        tc.created_at desc
      limit 1
    `,
    [safeChannel, safePageId, safeRecipientId, safeIgUserId]
  );

  return rowOrNull(q);
}

export function tenantsRoutes({ db }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!canAccessTenantsApi(req)) {
      return unauth(res, "Unauthorized");
    }
    next();
  });

  router.get("/tenants/resolve-channel", async (req, res) => {
    try {
      const channel = cleanLower(req.query.channel || "");
      const recipientId = cleanNullableString(req.query.recipientId);
      const pageId = cleanNullableString(req.query.pageId);
      const igUserId = cleanNullableString(req.query.igUserId);

      if (!channel) return bad(res, "channel is required");
      if (!recipientId && !pageId && !igUserId) {
        return bad(res, "recipientId or pageId or igUserId is required");
      }

      const match = await dbResolveTenantChannel(db, {
        channel,
        recipientId,
        pageId,
        igUserId,
      });

      if (!match?.tenant_id) {
        return res.status(404).json({
          ok: false,
          error: "Tenant channel not found",
          channel,
          recipientId: recipientId || null,
          pageId: pageId || null,
          igUserId: igUserId || null,
        });
      }

      return ok(res, {
        tenantKey: match.tenant_key,
        tenantId: match.tenant_id,
        resolvedChannel: match.channel_type,
        tenant: {
          id: match.tenant_id,
          tenant_key: match.tenant_key,
          company_name: match.company_name,
          legal_name: match.legal_name,
          industry_key: match.industry_key,
          country_code: match.country_code,
          timezone: match.timezone,
          default_language: match.default_language,
          enabled_languages: match.enabled_languages,
          market_region: match.market_region,
          plan_key: match.plan_key,
          status: match.tenant_status,
          active: match.tenant_active,
        },
        channelConfig: {
          id: match.id,
          tenant_id: match.tenant_id,
          channel_type: match.channel_type,
          provider: match.provider,
          display_name: match.display_name,
          external_account_id: match.external_account_id,
          external_page_id: match.external_page_id,
          external_user_id: match.external_user_id,
          external_username: match.external_username,
          status: match.status,
          is_primary: match.is_primary,
          config: match.config,
          secrets_ref: match.secrets_ref,
          health: match.health,
          last_sync_at: match.last_sync_at,
          created_at: match.created_at,
          updated_at: match.updated_at,
        },
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to resolve tenant channel");
    }
  });

  router.get("/tenants", async (req, res) => {
    try {
      const status = cleanLower(req.query.status || "");
      const activeOnly = String(req.query.activeOnly || "").trim() === "1";

      const tenants = await dbListTenants(db, { status, activeOnly });
      return ok(res, { tenants });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to list tenants");
    }
  });

  router.get("/tenants/:key", async (req, res) => {
    try {
      const tenantKey = slugTenantKey(req.params.key);
      if (!tenantKey) return bad(res, "tenant key is required");

      const settings = await dbGetTenantDetail(db, tenantKey);
      if (!settings?.tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      return ok(res, settings);
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load tenant");
    }
  });

  router.get("/tenants/:key/export", async (req, res) => {
    try {
      const tenantKey = slugTenantKey(req.params.key);
      if (!tenantKey) return bad(res, "tenant key is required");

      const bundle = await dbExportTenantBundle(db, tenantKey);

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${tenantKey}-export.json"`
      );

      return res.status(200).json({
        ok: true,
        exportType: "json",
        export: bundle,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to export tenant");
    }
  });

  router.get("/tenants/:key/export/csv", async (req, res) => {
    try {
      const tenantKey = slugTenantKey(req.params.key);
      if (!tenantKey) return bad(res, "tenant key is required");

      const csvBundle = await dbExportTenantCsvBundle(db, tenantKey);

      return res.status(200).json({
        ok: true,
        exportType: "csv_bundle",
        tenantKey,
        exportedAt: csvBundle.exportedAt,
        files: csvBundle.files,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to export tenant csv");
    }
  });

  router.get("/tenants/:key/export/zip", async (req, res) => {
    try {
      const tenantKey = slugTenantKey(req.params.key);
      if (!tenantKey) return bad(res, "tenant key is required");

      const jsonBundle = await dbExportTenantBundle(db, tenantKey);
      const csvBundle = await dbExportTenantCsvBundle(db, tenantKey);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${tenantKey}-export.zip"`
      );

      const archive = archiver("zip", { zlib: { level: 9 } });

      archive.on("error", (err) => {
        throw err;
      });

      archive.pipe(res);

      archive.append(JSON.stringify(jsonBundle, null, 2), {
        name: `${tenantKey}/export.json`,
      });

      for (const [filename, content] of Object.entries(csvBundle.files || {})) {
        archive.append(content || "", {
          name: `${tenantKey}/csv/${filename}`,
        });
      }

      await archive.finalize();
    } catch (err) {
      return serverErr(res, err?.message || "Failed to export tenant zip");
    }
  });

  router.post("/tenants", async (req, res) => {
    try {
      const body = asJsonObj(req.body, {});
      const actor = getActor(req);

      const tenantCoreInput = buildTenantCoreInput(body);

      if (!tenantCoreInput.tenant_key) {
        return bad(res, "tenant.tenant_key is required");
      }

      if (!validTenantKey(tenantCoreInput.tenant_key)) {
        return bad(res, "tenant_key must match /^[a-z0-9][a-z0-9_]{1,63}$/");
      }

      if (!tenantCoreInput.company_name) {
        return bad(res, "tenant.company_name is required");
      }

      const ownerInput = buildOwnerInput(body, tenantCoreInput);
      if (!ownerInput.user_email) {
        return bad(res, "owner.user_email is required");
      }

      if (!isLikelyEmail(ownerInput.user_email)) {
        return bad(res, "owner.user_email is invalid");
      }

      const existing = await dbGetTenantByKey(db, tenantCoreInput.tenant_key);
      if (existing?.id) {
        return bad(res, "Tenant already exists", {
          tenantKey: existing.tenant_key,
          tenantId: existing.id,
        });
      }

      const tenantCore = await dbUpsertTenantCore(
        db,
        tenantCoreInput.tenant_key,
        tenantCoreInput
      );

      if (!tenantCore?.id) {
        return serverErr(res, "Tenant create failed");
      }

      const profileInput = buildProfileInput(body, tenantCoreInput);
      const aiPolicyInput = buildAiPolicyInput(body);

      await dbUpsertTenantProfile(db, tenantCore.id, profileInput);
      await dbUpsertTenantAiPolicy(db, tenantCore.id, aiPolicyInput);

      const alreadyOwner = await dbGetTenantUserByEmail(
        db,
        tenantCore.id,
        ownerInput.user_email
      );

      if (!alreadyOwner?.id) {
        await dbCreateTenantUser(db, tenantCore.id, ownerInput);
      }

      const agents = pickDefaultAgents(body);
      for (const agent of agents) {
        const agentKey = cleanLower(agent.agent_key || agent.key || "");
        if (!agentKey) continue;

        await dbUpsertTenantAgent(db, tenantCore.id, agentKey, {
          display_name: cleanString(
            agent.display_name || agent.displayName || agentKey
          ),
          role_summary: cleanString(
            agent.role_summary || agent.roleSummary || ""
          ),
          enabled: asBool(agent.enabled, true),
          model: cleanNullableString(agent.model || "gpt-5"),
          temperature: agent.temperature,
          prompt_overrides: asJsonObj(
            agent.prompt_overrides || agent.promptOverrides,
            {}
          ),
          tool_access: asJsonObj(agent.tool_access || agent.toolAccess, {}),
          limits: asJsonObj(agent.limits, {}),
        });
      }

      const channels = pickChannels(body);
      for (const channel of channels) {
        const channelType = cleanLower(
          channel.channel_type || channel.channelType || ""
        );
        if (!channelType) continue;

        await dbUpsertTenantChannel(db, tenantCore.id, channelType, {
          provider: cleanLower(channel.provider || "meta"),
          display_name: cleanString(
            channel.display_name || channel.displayName || ""
          ),
          external_account_id: cleanNullableString(
            channel.external_account_id || channel.externalAccountId
          ),
          external_page_id: cleanNullableString(
            channel.external_page_id || channel.externalPageId
          ),
          external_user_id: cleanNullableString(
            channel.external_user_id || channel.externalUserId
          ),
          external_username: cleanNullableString(
            channel.external_username || channel.externalUsername
          ),
          status: cleanLower(channel.status || "disconnected"),
          is_primary: asBool(channel.is_primary, false),
          config: asJsonObj(channel.config, {}),
          secrets_ref: cleanNullableString(
            channel.secrets_ref || channel.secretsRef
          ),
          health: asJsonObj(channel.health, {}),
          last_sync_at: cleanNullableString(
            channel.last_sync_at || channel.lastSyncAt
          ),
        });
      }

      await auditSafe(db, actor, "tenant.created", "tenant", tenantCore.id, {
        tenantId: tenantCore.id,
        tenantKey: tenantCore.tenant_key,
        companyName: tenantCore.company_name,
        ownerEmail: ownerInput.user_email,
      });

      const settings = await dbGetWorkspaceSettings(db, tenantCore.tenant_key);

      return ok(res, {
        tenant: settings?.tenant || tenantCore,
        profile: settings?.profile || null,
        aiPolicy: settings?.aiPolicy || null,
        channels: settings?.channels || [],
        agents: settings?.agents || [],
        users: settings?.users || [],
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to create tenant");
    }
  });

  router.patch("/tenants/:key", async (req, res) => {
    try {
      const actor = getActor(req);

      const tenantKey = slugTenantKey(req.params.key);
      if (!tenantKey) return bad(res, "tenant key is required");

      const current = await dbGetTenantByKey(db, tenantKey);
      if (!current?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const body = asJsonObj(req.body, {});
      const tenantPatch = asJsonObj(body.tenant, body);

      const updated = await dbPatchTenantByKey(db, tenantKey, tenantPatch);
      if (!updated?.id) {
        return serverErr(res, "Tenant update failed");
      }

      if (body.profile && typeof body.profile === "object") {
        await dbUpsertTenantProfile(db, updated.id, buildProfileInput(body, updated));
      }

      if (body.aiPolicy && typeof body.aiPolicy === "object") {
        await dbUpsertTenantAiPolicy(db, updated.id, buildAiPolicyInput(body));
      }

      if (Array.isArray(body.channels)) {
        for (const channel of body.channels) {
          const channelType = cleanLower(
            channel.channel_type || channel.channelType || ""
          );
          if (!channelType) continue;

          await dbUpsertTenantChannel(db, updated.id, channelType, {
            provider: cleanLower(channel.provider || "meta"),
            display_name: cleanString(
              channel.display_name || channel.displayName || ""
            ),
            external_account_id: cleanNullableString(
              channel.external_account_id || channel.externalAccountId
            ),
            external_page_id: cleanNullableString(
              channel.external_page_id || channel.externalPageId
            ),
            external_user_id: cleanNullableString(
              channel.external_user_id || channel.externalUserId
            ),
            external_username: cleanNullableString(
              channel.external_username || channel.externalUsername
            ),
            status: cleanLower(channel.status || "disconnected"),
            is_primary: asBool(channel.is_primary, false),
            config: asJsonObj(channel.config, {}),
            secrets_ref: cleanNullableString(
              channel.secrets_ref || channel.secretsRef
            ),
            health: asJsonObj(channel.health, {}),
            last_sync_at: cleanNullableString(
              channel.last_sync_at || channel.lastSyncAt
            ),
          });
        }
      }

      if (Array.isArray(body.agents)) {
        for (const agent of body.agents) {
          const agentKey = cleanLower(agent.agent_key || agent.key || "");
          if (!agentKey) continue;

          await dbUpsertTenantAgent(db, updated.id, agentKey, {
            display_name: cleanString(
              agent.display_name || agent.displayName || agentKey
            ),
            role_summary: cleanString(
              agent.role_summary || agent.roleSummary || ""
            ),
            enabled: asBool(agent.enabled, true),
            model: cleanNullableString(agent.model || "gpt-5"),
            temperature: agent.temperature,
            prompt_overrides: asJsonObj(
              agent.prompt_overrides || agent.promptOverrides,
              {}
            ),
            tool_access: asJsonObj(agent.tool_access || agent.toolAccess, {}),
            limits: asJsonObj(agent.limits, {}),
          });
        }
      }

      await auditSafe(db, actor, "tenant.updated", "tenant", updated.id, {
        tenantId: updated.id,
        tenantKey: updated.tenant_key,
      });

      const settings = await dbGetWorkspaceSettings(db, updated.tenant_key);
      return ok(res, settings || { tenant: updated });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to update tenant");
    }
  });

  return router;
}