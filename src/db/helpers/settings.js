// src/db/helpers/settings.js
// FINAL v1.1 — tenant settings helpers (hardened)

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

function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

function asNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asJsonObject(v, fallback = {}) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
}

function asJsonArray(v, fallback = []) {
  return Array.isArray(v) ? v : fallback;
}

function json(v, fallback) {
  try {
    return JSON.stringify(v ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

export async function dbGetTenantByKey(db, tenantKey) {
  if (!db || !tenantKey) return null;

  const key = cleanLower(tenantKey);
  if (!key) return null;

  const q = await db.query(
    `
      select *
      from tenants
      where lower(tenant_key) = $1
      limit 1
    `,
    [key]
  );

  return rowOrNull(q);
}

export async function dbGetWorkspaceSettings(db, tenantKey) {
  if (!db || !tenantKey) return null;

  const tenant = await dbGetTenantByKey(db, tenantKey);
  if (!tenant) return null;

  const [profileQ, policyQ, channelsQ, agentsQ, usersQ] = await Promise.all([
    db.query(
      `
        select *
        from tenant_profiles
        where tenant_id = $1
        limit 1
      `,
      [tenant.id]
    ),
    db.query(
      `
        select *
        from tenant_ai_policies
        where tenant_id = $1
        limit 1
      `,
      [tenant.id]
    ),
    db.query(
      `
        select *
        from tenant_channels
        where tenant_id = $1
        order by channel_type asc, created_at asc
      `,
      [tenant.id]
    ),
    db.query(
      `
        select *
        from tenant_agent_configs
        where tenant_id = $1
        order by agent_key asc
      `,
      [tenant.id]
    ),
    db.query(
      `
        select
          id,
          tenant_id,
          user_email,
          full_name,
          role,
          status,
          permissions,
          meta,
          last_seen_at,
          created_at,
          updated_at
        from tenant_users
        where tenant_id = $1
        order by created_at asc
      `,
      [tenant.id]
    ),
  ]);

  return {
    tenant,
    profile: rowOrNull(profileQ),
    aiPolicy: rowOrNull(policyQ),
    channels: rows(channelsQ),
    agents: rows(agentsQ),
    users: rows(usersQ),
  };
}

export async function dbUpsertTenantCore(db, tenantKey, input = {}) {
  if (!db || !tenantKey) return null;

  const key = cleanLower(tenantKey);
  if (!key) return null;

  const companyName = cleanString(input.company_name, "");
  const legalName =
    Object.prototype.hasOwnProperty.call(input, "legal_name")
      ? cleanNullableString(input.legal_name)
      : null;

  const industryKey = cleanLower(input.industry_key, "generic_business");
  const countryCode = cleanNullableString(input.country_code)?.toUpperCase() || null;
  const timezone = cleanString(input.timezone, "Asia/Baku");
  const defaultLanguage = cleanLower(input.default_language, "az");

  let enabledLanguages = asJsonArray(input.enabled_languages, ["az"])
    .map((x) => cleanLower(x))
    .filter(Boolean);

  if (!enabledLanguages.length) enabledLanguages = ["az"];

  const marketRegion = cleanNullableString(input.market_region);

  const q = await db.query(
    `
      insert into tenants (
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
        onboarding_completed_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        'starter',
        'active',
        true,
        null
      )
      on conflict (tenant_key) do update
      set
        company_name = excluded.company_name,
        legal_name = coalesce(excluded.legal_name, tenants.legal_name),
        industry_key = excluded.industry_key,
        country_code = excluded.country_code,
        timezone = excluded.timezone,
        default_language = excluded.default_language,
        enabled_languages = excluded.enabled_languages,
        market_region = excluded.market_region
      returning *
    `,
    [
      key,
      companyName,
      legalName,
      industryKey,
      countryCode,
      timezone,
      defaultLanguage,
      json(enabledLanguages, ["az"]),
      marketRegion,
    ]
  );

  return rowOrNull(q);
}

export async function dbUpsertTenantProfile(db, tenantId, input = {}) {
  if (!db || !tenantId) return null;

  const q = await db.query(
    `
      insert into tenant_profiles (
        tenant_id,
        brand_name,
        website_url,
        public_email,
        public_phone,
        audience_summary,
        services_summary,
        value_proposition,
        brand_summary,
        tone_of_voice,
        preferred_cta,
        banned_phrases,
        communication_rules,
        visual_style,
        extra_context
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb,
        $13::jsonb,
        $14::jsonb,
        $15::jsonb
      )
      on conflict (tenant_id) do update
      set
        brand_name = excluded.brand_name,
        website_url = excluded.website_url,
        public_email = excluded.public_email,
        public_phone = excluded.public_phone,
        audience_summary = excluded.audience_summary,
        services_summary = excluded.services_summary,
        value_proposition = excluded.value_proposition,
        brand_summary = excluded.brand_summary,
        tone_of_voice = excluded.tone_of_voice,
        preferred_cta = excluded.preferred_cta,
        banned_phrases = excluded.banned_phrases,
        communication_rules = excluded.communication_rules,
        visual_style = excluded.visual_style,
        extra_context = excluded.extra_context
      returning *
    `,
    [
      tenantId,
      cleanString(input.brand_name, ""),
      cleanNullableString(input.website_url),
      cleanNullableString(input.public_email),
      cleanNullableString(input.public_phone),
      cleanString(input.audience_summary, ""),
      cleanString(input.services_summary, ""),
      cleanString(input.value_proposition, ""),
      cleanString(input.brand_summary, ""),
      cleanLower(input.tone_of_voice, "professional"),
      cleanString(input.preferred_cta, ""),
      json(asJsonArray(input.banned_phrases, []), []),
      json(asJsonObject(input.communication_rules, {}), {}),
      json(asJsonObject(input.visual_style, {}), {}),
      json(asJsonObject(input.extra_context, {}), {}),
    ]
  );

  return rowOrNull(q);
}

export async function dbUpsertTenantAiPolicy(db, tenantId, input = {}) {
  if (!db || !tenantId) return null;

  const q = await db.query(
    `
      insert into tenant_ai_policies (
        tenant_id,
        auto_reply_enabled,
        suppress_ai_during_handoff,
        mark_seen_enabled,
        typing_indicator_enabled,
        create_lead_enabled,
        approval_required_content,
        approval_required_publish,
        quiet_hours_enabled,
        quiet_hours,
        inbox_policy,
        comment_policy,
        content_policy,
        escalation_rules,
        risk_rules,
        lead_scoring_rules,
        publish_policy
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        $13::jsonb,
        $14::jsonb,
        $15::jsonb,
        $16::jsonb,
        $17::jsonb
      )
      on conflict (tenant_id) do update
      set
        auto_reply_enabled = excluded.auto_reply_enabled,
        suppress_ai_during_handoff = excluded.suppress_ai_during_handoff,
        mark_seen_enabled = excluded.mark_seen_enabled,
        typing_indicator_enabled = excluded.typing_indicator_enabled,
        create_lead_enabled = excluded.create_lead_enabled,
        approval_required_content = excluded.approval_required_content,
        approval_required_publish = excluded.approval_required_publish,
        quiet_hours_enabled = excluded.quiet_hours_enabled,
        quiet_hours = excluded.quiet_hours,
        inbox_policy = excluded.inbox_policy,
        comment_policy = excluded.comment_policy,
        content_policy = excluded.content_policy,
        escalation_rules = excluded.escalation_rules,
        risk_rules = excluded.risk_rules,
        lead_scoring_rules = excluded.lead_scoring_rules,
        publish_policy = excluded.publish_policy
      returning *
    `,
    [
      tenantId,
      asBool(input.auto_reply_enabled, true),
      asBool(input.suppress_ai_during_handoff, true),
      asBool(input.mark_seen_enabled, true),
      asBool(input.typing_indicator_enabled, true),
      asBool(input.create_lead_enabled, true),
      asBool(input.approval_required_content, true),
      asBool(input.approval_required_publish, true),
      asBool(input.quiet_hours_enabled, false),
      json(asJsonObject(input.quiet_hours, {}), {}),
      json(asJsonObject(input.inbox_policy, {}), {}),
      json(asJsonObject(input.comment_policy, {}), {}),
      json(asJsonObject(input.content_policy, {}), {}),
      json(asJsonObject(input.escalation_rules, {}), {}),
      json(asJsonObject(input.risk_rules, {}), {}),
      json(asJsonObject(input.lead_scoring_rules, {}), {}),
      json(asJsonObject(input.publish_policy, {}), {}),
    ]
  );

  return rowOrNull(q);
}

export async function dbListTenantChannels(db, tenantId) {
  if (!db || !tenantId) return [];

  const q = await db.query(
    `
      select *
      from tenant_channels
      where tenant_id = $1
      order by channel_type asc, created_at asc
    `,
    [tenantId]
  );

  return rows(q);
}

export async function dbUpsertTenantChannel(db, tenantId, channelType, input = {}) {
  if (!db || !tenantId || !channelType) return null;

  const safeChannelType = cleanLower(channelType);
  const provider = cleanLower(input.provider, "meta");

  const externalAccountId = cleanNullableString(input.external_account_id);
  const externalPageId = cleanNullableString(input.external_page_id);
  const externalUserId = cleanNullableString(input.external_user_id);
  const externalUsername = cleanNullableString(input.external_username);

  const existing = await db.query(
    `
      select id
      from tenant_channels
      where tenant_id = $1
        and channel_type = $2
        and provider = $3
        and coalesce(external_account_id, '') = coalesce($4, '')
        and coalesce(external_page_id, '') = coalesce($5, '')
        and coalesce(external_user_id, '') = coalesce($6, '')
      limit 1
    `,
    [
      tenantId,
      safeChannelType,
      provider,
      externalAccountId,
      externalPageId,
      externalUserId,
    ]
  );

  const current = rowOrNull(existing);

  if (current?.id) {
    const q = await db.query(
      `
        update tenant_channels
        set
          display_name = $2,
          external_account_id = $3,
          external_page_id = $4,
          external_user_id = $5,
          external_username = $6,
          status = $7,
          is_primary = $8,
          config = $9::jsonb,
          secrets_ref = $10,
          health = $11::jsonb,
          last_sync_at = $12
        where id = $1
        returning *
      `,
      [
        current.id,
        cleanString(input.display_name, ""),
        externalAccountId,
        externalPageId,
        externalUserId,
        externalUsername,
        cleanLower(input.status, "disconnected"),
        asBool(input.is_primary, false),
        json(asJsonObject(input.config, {}), {}),
        cleanNullableString(input.secrets_ref),
        json(asJsonObject(input.health, {}), {}),
        cleanNullableString(input.last_sync_at),
      ]
    );

    return rowOrNull(q);
  }

  const q = await db.query(
    `
      insert into tenant_channels (
        tenant_id,
        channel_type,
        provider,
        display_name,
        external_account_id,
        external_page_id,
        external_user_id,
        external_username,
        status,
        is_primary,
        config,
        secrets_ref,
        health,
        last_sync_at
      )
      values (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,$11::jsonb,$12,$13::jsonb,$14
      )
      returning *
    `,
    [
      tenantId,
      safeChannelType,
      provider,
      cleanString(input.display_name, ""),
      externalAccountId,
      externalPageId,
      externalUserId,
      externalUsername,
      cleanLower(input.status, "disconnected"),
      asBool(input.is_primary, false),
      json(asJsonObject(input.config, {}), {}),
      cleanNullableString(input.secrets_ref),
      json(asJsonObject(input.health, {}), {}),
      cleanNullableString(input.last_sync_at),
    ]
  );

  return rowOrNull(q);
}

export async function dbListTenantAgents(db, tenantId) {
  if (!db || !tenantId) return [];

  const q = await db.query(
    `
      select *
      from tenant_agent_configs
      where tenant_id = $1
      order by agent_key asc
    `,
    [tenantId]
  );

  return rows(q);
}

export async function dbUpsertTenantAgent(db, tenantId, agentKey, input = {}) {
  if (!db || !tenantId || !agentKey) return null;

  const safeAgentKey = cleanLower(agentKey);

  const q = await db.query(
    `
      insert into tenant_agent_configs (
        tenant_id,
        agent_key,
        display_name,
        role_summary,
        enabled,
        model,
        temperature,
        prompt_overrides,
        tool_access,
        limits
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb
      )
      on conflict (tenant_id, agent_key) do update
      set
        display_name = excluded.display_name,
        role_summary = excluded.role_summary,
        enabled = excluded.enabled,
        model = excluded.model,
        temperature = excluded.temperature,
        prompt_overrides = excluded.prompt_overrides,
        tool_access = excluded.tool_access,
        limits = excluded.limits
      returning *
    `,
    [
      tenantId,
      safeAgentKey,
      cleanString(input.display_name, ""),
      cleanString(input.role_summary, ""),
      asBool(input.enabled, true),
      cleanNullableString(input.model),
      asNumberOrNull(input.temperature),
      json(asJsonObject(input.prompt_overrides, {}), {}),
      json(asJsonObject(input.tool_access, {}), {}),
      json(asJsonObject(input.limits, {}), {}),
    ]
  );

  return rowOrNull(q);
}

export async function dbListTenantUsers(db, tenantId) {
  if (!db || !tenantId) return [];

  const q = await db.query(
    `
      select
        id,
        tenant_id,
        user_email,
        full_name,
        role,
        status,
        permissions,
        meta,
        last_seen_at,
        created_at,
        updated_at
      from tenant_users
      where tenant_id = $1
      order by created_at asc
    `,
    [tenantId]
  );

  return rows(q);
}