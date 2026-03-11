import { randomUUID } from "crypto";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function b(v, d = false) {
  if (typeof v === "boolean") return v;
  const x = String(v ?? "").trim().toLowerCase();
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function j(v, d = {}) {
  if (isObj(v) || Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return d;
    }
  }
  return d;
}

function nowIso(x) {
  try {
    if (!x) return null;
    return new Date(x).toISOString();
  } catch {
    return null;
  }
}

function safeUuid(v) {
  const x = s(v);
  return x || randomUUID();
}

function normalizeVoiceSettings(row = {}) {
  return {
    tenantId: s(row.tenant_id),
    enabled: b(row.enabled, false),
    provider: s(row.provider, "twilio"),
    mode: s(row.mode, "assistant"),

    displayName: s(row.display_name),
    defaultLanguage: s(row.default_language, "az"),
    supportedLanguages: Array.isArray(row.supported_languages)
      ? row.supported_languages
      : j(row.supported_languages, ["az"]),

    greeting: j(row.greeting, {}),
    fallbackGreeting: j(row.fallback_greeting, {}),
    businessContext: s(row.business_context),
    instructions: s(row.instructions),

    businessHoursEnabled: b(row.business_hours_enabled, false),
    businessHours: j(row.business_hours, {}),

    operatorEnabled: b(row.operator_enabled, true),
    operatorPhone: s(row.operator_phone),
    operatorLabel: s(row.operator_label),
    transferStrategy: s(row.transfer_strategy, "handoff"),

    callbackEnabled: b(row.callback_enabled, true),
    callbackMode: s(row.callback_mode, "lead_only"),

    maxCallSeconds: n(row.max_call_seconds, 180),
    silenceHangupSeconds: n(row.silence_hangup_seconds, 12),

    captureRules: j(row.capture_rules, {}),
    leadRules: j(row.lead_rules, {}),
    escalationRules: j(row.escalation_rules, {}),
    reportingRules: j(row.reporting_rules, {}),

    twilioPhoneNumber: s(row.twilio_phone_number),
    twilioPhoneSid: s(row.twilio_phone_sid),
    twilioConfig: j(row.twilio_config, {}),

    costControl: j(row.cost_control, {}),
    meta: j(row.meta, {}),

    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

function normalizeVoiceCall(row = {}) {
  return {
    id: s(row.id),
    tenantId: s(row.tenant_id),
    tenantKey: s(row.tenant_key),

    provider: s(row.provider, "twilio"),
    providerCallSid: s(row.provider_call_sid),
    providerStreamSid: s(row.provider_stream_sid),

    direction: s(row.direction, "inbound"),
    status: s(row.status, "queued"),

    fromNumber: s(row.from_number),
    toNumber: s(row.to_number),
    callerName: s(row.caller_name),

    startedAt: nowIso(row.started_at),
    answeredAt: nowIso(row.answered_at),
    endedAt: nowIso(row.ended_at),
    durationSeconds: n(row.duration_seconds, 0),

    language: s(row.language, "az"),
    agentMode: s(row.agent_mode, "assistant"),

    handoffRequested: b(row.handoff_requested, false),
    handoffCompleted: b(row.handoff_completed, false),
    handoffTarget: s(row.handoff_target),

    callbackRequested: b(row.callback_requested, false),
    callbackPhone: s(row.callback_phone),

    leadId: s(row.lead_id),
    inboxThreadId: s(row.inbox_thread_id),

    transcript: s(row.transcript),
    summary: s(row.summary),
    outcome: s(row.outcome, "unknown"),
    intent: s(row.intent),
    sentiment: s(row.sentiment),

    costAmount: Number(row.cost_amount || 0),
    costCurrency: s(row.cost_currency, "USD"),

    metrics: j(row.metrics, {}),
    extraction: j(row.extraction, {}),
    meta: j(row.meta, {}),

    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

function normalizeVoiceCallEvent(row = {}) {
  return {
    id: s(row.id),
    callId: s(row.call_id),
    tenantId: s(row.tenant_id),
    tenantKey: s(row.tenant_key),
    eventType: s(row.event_type),
    actor: s(row.actor, "system"),
    payload: j(row.payload, {}),
    createdAt: nowIso(row.created_at),
  };
}

function normalizeVoiceUsageRow(row = {}) {
  return {
    id: s(row.id),
    tenantId: s(row.tenant_id),
    tenantKey: s(row.tenant_key),
    usageDate: row.usage_date || null,
    provider: s(row.provider, "twilio"),
    callCount: n(row.call_count, 0),
    inboundCount: n(row.inbound_count, 0),
    outboundCount: n(row.outbound_count, 0),
    totalDurationSeconds: n(row.total_duration_seconds, 0),
    totalCostAmount: Number(row.total_cost_amount || 0),
    costCurrency: s(row.cost_currency, "USD"),
    metrics: j(row.metrics, {}),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

async function one(db, sql, params = []) {
  const q = await db.query(sql, params);
  return q?.rows?.[0] || null;
}

async function many(db, sql, params = []) {
  const q = await db.query(sql, params);
  return Array.isArray(q?.rows) ? q.rows : [];
}

export async function getTenantVoiceSettings(db, tenantId) {
  if (!db || !tenantId) return null;

  const row = await one(
    db,
    `
      select *
      from tenant_voice_settings
      where tenant_id = $1
      limit 1
    `,
    [tenantId]
  );

  return row ? normalizeVoiceSettings(row) : null;
}

export async function upsertTenantVoiceSettings(db, tenantId, input = {}) {
  if (!db || !tenantId) return null;

  const payload = {
    enabled: b(input.enabled, false),
    provider: s(input.provider, "twilio"),
    mode: s(input.mode, "assistant"),

    display_name: s(input.displayName),
    default_language: s(input.defaultLanguage, "az"),
    supported_languages: JSON.stringify(
      Array.isArray(input.supportedLanguages) && input.supportedLanguages.length
        ? input.supportedLanguages
        : ["az"]
    ),

    greeting: JSON.stringify(j(input.greeting, {})),
    fallback_greeting: JSON.stringify(j(input.fallbackGreeting, {})),
    business_context: s(input.businessContext),
    instructions: s(input.instructions),

    business_hours_enabled: b(input.businessHoursEnabled, false),
    business_hours: JSON.stringify(j(input.businessHours, {})),

    operator_enabled: b(input.operatorEnabled, true),
    operator_phone: s(input.operatorPhone),
    operator_label: s(input.operatorLabel),
    transfer_strategy: s(input.transferStrategy, "handoff"),

    callback_enabled: b(input.callbackEnabled, true),
    callback_mode: s(input.callbackMode, "lead_only"),

    max_call_seconds: n(input.maxCallSeconds, 180),
    silence_hangup_seconds: n(input.silenceHangupSeconds, 12),

    capture_rules: JSON.stringify(j(input.captureRules, {})),
    lead_rules: JSON.stringify(j(input.leadRules, {})),
    escalation_rules: JSON.stringify(j(input.escalationRules, {})),
    reporting_rules: JSON.stringify(j(input.reportingRules, {})),

    twilio_phone_number: s(input.twilioPhoneNumber),
    twilio_phone_sid: s(input.twilioPhoneSid),
    twilio_config: JSON.stringify(j(input.twilioConfig, {})),

    cost_control: JSON.stringify(j(input.costControl, {})),
    meta: JSON.stringify(j(input.meta, {})),
  };

  const row = await one(
    db,
    `
      insert into tenant_voice_settings (
        tenant_id,
        enabled,
        provider,
        mode,
        display_name,
        default_language,
        supported_languages,
        greeting,
        fallback_greeting,
        business_context,
        instructions,
        business_hours_enabled,
        business_hours,
        operator_enabled,
        operator_phone,
        operator_label,
        transfer_strategy,
        callback_enabled,
        callback_mode,
        max_call_seconds,
        silence_hangup_seconds,
        capture_rules,
        lead_rules,
        escalation_rules,
        reporting_rules,
        twilio_phone_number,
        twilio_phone_sid,
        twilio_config,
        cost_control,
        meta
      )
      values (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,$25::jsonb,$26,$27,$28::jsonb,$29::jsonb,$30::jsonb
      )
      on conflict (tenant_id) do update
      set
        enabled = excluded.enabled,
        provider = excluded.provider,
        mode = excluded.mode,
        display_name = excluded.display_name,
        default_language = excluded.default_language,
        supported_languages = excluded.supported_languages,
        greeting = excluded.greeting,
        fallback_greeting = excluded.fallback_greeting,
        business_context = excluded.business_context,
        instructions = excluded.instructions,
        business_hours_enabled = excluded.business_hours_enabled,
        business_hours = excluded.business_hours,
        operator_enabled = excluded.operator_enabled,
        operator_phone = excluded.operator_phone,
        operator_label = excluded.operator_label,
        transfer_strategy = excluded.transfer_strategy,
        callback_enabled = excluded.callback_enabled,
        callback_mode = excluded.callback_mode,
        max_call_seconds = excluded.max_call_seconds,
        silence_hangup_seconds = excluded.silence_hangup_seconds,
        capture_rules = excluded.capture_rules,
        lead_rules = excluded.lead_rules,
        escalation_rules = excluded.escalation_rules,
        reporting_rules = excluded.reporting_rules,
        twilio_phone_number = excluded.twilio_phone_number,
        twilio_phone_sid = excluded.twilio_phone_sid,
        twilio_config = excluded.twilio_config,
        cost_control = excluded.cost_control,
        meta = excluded.meta,
        updated_at = now()
      returning *
    `,
    [
      tenantId,
      payload.enabled,
      payload.provider,
      payload.mode,
      payload.display_name,
      payload.default_language,
      payload.supported_languages,
      payload.greeting,
      payload.fallback_greeting,
      payload.business_context,
      payload.instructions,
      payload.business_hours_enabled,
      payload.business_hours,
      payload.operator_enabled,
      payload.operator_phone,
      payload.operator_label,
      payload.transfer_strategy,
      payload.callback_enabled,
      payload.callback_mode,
      payload.max_call_seconds,
      payload.silence_hangup_seconds,
      payload.capture_rules,
      payload.lead_rules,
      payload.escalation_rules,
      payload.reporting_rules,
      payload.twilio_phone_number,
      payload.twilio_phone_sid,
      payload.twilio_config,
      payload.cost_control,
      payload.meta,
    ]
  );

  return row ? normalizeVoiceSettings(row) : null;
}

export async function listVoiceCalls(db, opts = {}) {
  if (!db) return [];

  const tenantId = s(opts.tenantId);
  const status = s(opts.status);
  const limit = Math.max(1, Math.min(200, n(opts.limit, 50)));

  const params = [];
  const where = [];

  if (tenantId) {
    params.push(tenantId);
    where.push(`tenant_id = $${params.length}`);
  }

  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  params.push(limit);

  const rows = await many(
    db,
    `
      select *
      from voice_calls
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by created_at desc
      limit $${params.length}
    `,
    params
  );

  return rows.map(normalizeVoiceCall);
}

export async function getVoiceCallById(db, id) {
  if (!db || !id) return null;

  const row = await one(
    db,
    `
      select *
      from voice_calls
      where id = $1
      limit 1
    `,
    [id]
  );

  return row ? normalizeVoiceCall(row) : null;
}

export async function getVoiceCallByProviderSid(db, providerCallSid) {
  if (!db || !providerCallSid) return null;

  const row = await one(
    db,
    `
      select *
      from voice_calls
      where provider_call_sid = $1
      order by created_at desc
      limit 1
    `,
    [providerCallSid]
  );

  return row ? normalizeVoiceCall(row) : null;
}

export async function createVoiceCall(db, input = {}) {
  if (!db) return null;

  const row = await one(
    db,
    `
      insert into voice_calls (
        id,
        tenant_id,
        tenant_key,
        provider,
        provider_call_sid,
        provider_stream_sid,
        direction,
        status,
        from_number,
        to_number,
        caller_name,
        started_at,
        answered_at,
        ended_at,
        duration_seconds,
        language,
        agent_mode,
        handoff_requested,
        handoff_completed,
        handoff_target,
        callback_requested,
        callback_phone,
        lead_id,
        inbox_thread_id,
        transcript,
        summary,
        outcome,
        intent,
        sentiment,
        cost_amount,
        cost_currency,
        metrics,
        extraction,
        meta
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb,$33::jsonb,$34::jsonb
      )
      returning *
    `,
    [
      safeUuid(input.id),
      s(input.tenantId) || null,
      s(input.tenantKey),
      s(input.provider, "twilio"),
      s(input.providerCallSid) || null,
      s(input.providerStreamSid) || null,
      s(input.direction, "inbound"),
      s(input.status, "queued"),
      s(input.fromNumber) || null,
      s(input.toNumber) || null,
      s(input.callerName) || null,
      input.startedAt || null,
      input.answeredAt || null,
      input.endedAt || null,
      n(input.durationSeconds, 0),
      s(input.language, "az"),
      s(input.agentMode, "assistant"),
      b(input.handoffRequested, false),
      b(input.handoffCompleted, false),
      s(input.handoffTarget) || null,
      b(input.callbackRequested, false),
      s(input.callbackPhone) || null,
      s(input.leadId) || null,
      s(input.inboxThreadId) || null,
      s(input.transcript),
      s(input.summary),
      s(input.outcome, "unknown"),
      s(input.intent) || null,
      s(input.sentiment) || null,
      Number(input.costAmount || 0),
      s(input.costCurrency, "USD"),
      JSON.stringify(j(input.metrics, {})),
      JSON.stringify(j(input.extraction, {})),
      JSON.stringify(j(input.meta, {})),
    ]
  );

  return row ? normalizeVoiceCall(row) : null;
}

export async function updateVoiceCall(db, id, patch = {}) {
  if (!db || !id) return null;

  const current = await getVoiceCallById(db, id);
  if (!current) return null;

  const merged = {
    ...current,
    ...patch,
    metrics: isObj(patch.metrics) ? patch.metrics : current.metrics,
    extraction: isObj(patch.extraction) ? patch.extraction : current.extraction,
    meta: isObj(patch.meta) ? patch.meta : current.meta,
  };

  const row = await one(
    db,
    `
      update voice_calls
      set
        tenant_id = $2,
        tenant_key = $3,
        provider = $4,
        provider_call_sid = $5,
        provider_stream_sid = $6,
        direction = $7,
        status = $8,
        from_number = $9,
        to_number = $10,
        caller_name = $11,
        started_at = $12,
        answered_at = $13,
        ended_at = $14,
        duration_seconds = $15,
        language = $16,
        agent_mode = $17,
        handoff_requested = $18,
        handoff_completed = $19,
        handoff_target = $20,
        callback_requested = $21,
        callback_phone = $22,
        lead_id = $23,
        inbox_thread_id = $24,
        transcript = $25,
        summary = $26,
        outcome = $27,
        intent = $28,
        sentiment = $29,
        cost_amount = $30,
        cost_currency = $31,
        metrics = $32::jsonb,
        extraction = $33::jsonb,
        meta = $34::jsonb,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      id,
      s(merged.tenantId) || null,
      s(merged.tenantKey),
      s(merged.provider, "twilio"),
      s(merged.providerCallSid) || null,
      s(merged.providerStreamSid) || null,
      s(merged.direction, "inbound"),
      s(merged.status, "queued"),
      s(merged.fromNumber) || null,
      s(merged.toNumber) || null,
      s(merged.callerName) || null,
      merged.startedAt || null,
      merged.answeredAt || null,
      merged.endedAt || null,
      n(merged.durationSeconds, 0),
      s(merged.language, "az"),
      s(merged.agentMode, "assistant"),
      b(merged.handoffRequested, false),
      b(merged.handoffCompleted, false),
      s(merged.handoffTarget) || null,
      b(merged.callbackRequested, false),
      s(merged.callbackPhone) || null,
      s(merged.leadId) || null,
      s(merged.inboxThreadId) || null,
      s(merged.transcript),
      s(merged.summary),
      s(merged.outcome, "unknown"),
      s(merged.intent) || null,
      s(merged.sentiment) || null,
      Number(merged.costAmount || 0),
      s(merged.costCurrency, "USD"),
      JSON.stringify(j(merged.metrics, {})),
      JSON.stringify(j(merged.extraction, {})),
      JSON.stringify(j(merged.meta, {})),
    ]
  );

  return row ? normalizeVoiceCall(row) : null;
}

export async function appendVoiceCallEvent(db, input = {}) {
  if (!db || !input.callId) return null;

  const row = await one(
    db,
    `
      insert into voice_call_events (
        id,
        call_id,
        tenant_id,
        tenant_key,
        event_type,
        actor,
        payload
      )
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)
      returning *
    `,
    [
      safeUuid(input.id),
      s(input.callId),
      s(input.tenantId) || null,
      s(input.tenantKey),
      s(input.eventType),
      s(input.actor, "system"),
      JSON.stringify(j(input.payload, {})),
    ]
  );

  return row ? normalizeVoiceCallEvent(row) : null;
}

export async function listVoiceCallEvents(db, callId) {
  if (!db || !callId) return [];

  const rows = await many(
    db,
    `
      select *
      from voice_call_events
      where call_id = $1
      order by created_at asc
    `,
    [callId]
  );

  return rows.map(normalizeVoiceCallEvent);
}

export async function upsertVoiceDailyUsage(db, input = {}) {
  if (!db || !input.tenantId || !input.usageDate) return null;

  const row = await one(
    db,
    `
      insert into voice_daily_usage (
        tenant_id,
        tenant_key,
        usage_date,
        provider,
        call_count,
        inbound_count,
        outbound_count,
        total_duration_seconds,
        total_cost_amount,
        cost_currency,
        metrics
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb
      )
      on conflict (tenant_id, provider, usage_date) do update
      set
        tenant_key = excluded.tenant_key,
        call_count = excluded.call_count,
        inbound_count = excluded.inbound_count,
        outbound_count = excluded.outbound_count,
        total_duration_seconds = excluded.total_duration_seconds,
        total_cost_amount = excluded.total_cost_amount,
        cost_currency = excluded.cost_currency,
        metrics = excluded.metrics,
        updated_at = now()
      returning *
    `,
    [
      s(input.tenantId),
      s(input.tenantKey),
      input.usageDate,
      s(input.provider, "twilio"),
      n(input.callCount, 0),
      n(input.inboundCount, 0),
      n(input.outboundCount, 0),
      n(input.totalDurationSeconds, 0),
      Number(input.totalCostAmount || 0),
      s(input.costCurrency, "USD"),
      JSON.stringify(j(input.metrics, {})),
    ]
  );

  return row ? normalizeVoiceUsageRow(row) : null;
}

export async function getVoiceDailyUsage(db, tenantId, limit = 30) {
  if (!db || !tenantId) return [];

  const rows = await many(
    db,
    `
      select *
      from voice_daily_usage
      where tenant_id = $1
      order by usage_date desc
      limit $2
    `,
    [tenantId, Math.max(1, Math.min(365, n(limit, 30)))]
  );

  return rows.map(normalizeVoiceUsageRow);
}