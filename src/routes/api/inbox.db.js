import { isDbReady, isUuid } from "../../utils/http.js";
import { getDefaultTenantKey, resolveTenantKey } from "../../tenancy/index.js";
import {
  normalizeMessage,
  normalizeTenant,
  normalizeThread,
} from "./inbox.shared.js";

function toAttempt(row) {
  if (!row) return null;
  return {
    ...row,
    payload: row?.payload && typeof row.payload === "object" ? row.payload : {},
    provider_response:
      row?.provider_response && typeof row.provider_response === "object"
        ? row.provider_response
        : {},
  };
}

export async function getTenantByKey(db, tenantKey) {
  if (!isDbReady(db)) return null;

  const resolvedTenantKey = resolveTenantKey(tenantKey);

  try {
    const result = await db.query(
      `
      select
        id,
        tenant_key,
        name,
        active,
        brand,
        meta,
        schedule,
        inbox_policy,
        providers,
        features,
        timezone,
        created_at,
        updated_at
      from tenants
      where tenant_key = $1::text
      limit 1
      `,
      [resolvedTenantKey]
    );

    return normalizeTenant(result.rows?.[0] || null);
  } catch {
    return null;
  }
}

export async function findExistingInboundMessage({
  db,
  tenantKey,
  threadId,
  externalMessageId,
}) {
  if (!isDbReady(db)) return null;
  if (!threadId || !isUuid(threadId)) return null;
  if (!externalMessageId) return null;

  const resolvedTenantKey = resolveTenantKey(tenantKey);

  const result = await db.query(
    `
    select
      id,
      thread_id,
      tenant_key,
      direction,
      sender_type,
      external_message_id,
      message_type,
      text,
      attachments,
      meta,
      sent_at,
      created_at
    from inbox_messages
    where tenant_key = $1::text
      and thread_id = $2::uuid
      and direction = 'inbound'
      and external_message_id = $3::text
    order by created_at desc
    limit 1
    `,
    [resolvedTenantKey, threadId, externalMessageId]
  );

  return normalizeMessage(result.rows?.[0] || null);
}

export async function findExistingOutboundMessage({
  db,
  tenantKey,
  threadId,
  externalMessageId,
}) {
  if (!isDbReady(db)) return null;
  if (!threadId || !isUuid(threadId)) return null;
  if (!externalMessageId) return null;

  const resolvedTenantKey = resolveTenantKey(tenantKey);

  const result = await db.query(
    `
    select
      id,
      thread_id,
      tenant_key,
      direction,
      sender_type,
      external_message_id,
      message_type,
      text,
      attachments,
      meta,
      sent_at,
      created_at
    from inbox_messages
    where tenant_key = $1::text
      and thread_id = $2::uuid
      and direction = 'outbound'
      and external_message_id = $3::text
    order by created_at desc
    limit 1
    `,
    [resolvedTenantKey, threadId, externalMessageId]
  );

  return normalizeMessage(result.rows?.[0] || null);
}

export async function refreshThread(db, threadId, fallback = null) {
  if (!threadId || !isUuid(threadId)) return fallback;

  const refreshed = await db.query(
    `
    select
      id,
      tenant_key,
      channel,
      external_thread_id,
      external_user_id,
      external_username,
      customer_name,
      status,
      last_message_at,
      last_inbound_at,
      last_outbound_at,
      unread_count,
      assigned_to,
      labels,
      meta,
      handoff_active,
      handoff_reason,
      handoff_priority,
      handoff_at,
      handoff_by,
      created_at,
      updated_at
    from inbox_threads
    where id = $1::uuid
    limit 1
    `,
    [threadId]
  );

  return normalizeThread(refreshed.rows?.[0] || fallback);
}

export async function getThreadById(db, threadId) {
  if (!isDbReady(db)) return null;
  if (!threadId || !isUuid(threadId)) return null;

  const result = await db.query(
    `
    select
      id,
      tenant_key,
      channel,
      external_thread_id,
      external_user_id,
      external_username,
      customer_name,
      status,
      last_message_at,
      last_inbound_at,
      last_outbound_at,
      unread_count,
      assigned_to,
      labels,
      meta,
      handoff_active,
      handoff_reason,
      handoff_priority,
      handoff_at,
      handoff_by,
      created_at,
      updated_at
    from inbox_threads
    where id = $1::uuid
    limit 1
    `,
    [threadId]
  );

  return normalizeThread(result.rows?.[0] || null);
}

export async function getMessageById(db, messageId) {
  if (!isDbReady(db)) return null;
  if (!messageId || !isUuid(messageId)) return null;

  const result = await db.query(
    `
    select
      id,
      thread_id,
      tenant_key,
      direction,
      sender_type,
      external_message_id,
      message_type,
      text,
      attachments,
      meta,
      sent_at,
      created_at
    from inbox_messages
    where id = $1::uuid
    limit 1
    `,
    [messageId]
  );

  return normalizeMessage(result.rows?.[0] || null);
}

export async function updateOutboundMessageProviderId({
  db,
  messageId,
  providerMessageId,
  providerResponse = {},
}) {
  if (!isDbReady(db)) return null;
  if (!messageId || !isUuid(messageId)) return null;

  const result = await db.query(
    `
    update inbox_messages
    set
      external_message_id = coalesce($2::text, external_message_id),
      meta = coalesce(meta, '{}'::jsonb) || $3::jsonb
    where id = $1::uuid
    returning
      id,
      thread_id,
      tenant_key,
      direction,
      sender_type,
      external_message_id,
      message_type,
      text,
      attachments,
      meta,
      sent_at,
      created_at
    `,
    [
      messageId,
      providerMessageId || null,
      JSON.stringify({
        providerResponse: providerResponse || null,
      }),
    ]
  );

  return normalizeMessage(result.rows?.[0] || null);
}

export async function createOutboundAttempt({
  db,
  messageId,
  threadId,
  tenantKey = getDefaultTenantKey(),
  channel = "instagram",
  provider = "meta",
  recipientId = null,
  payload = {},
  status = "queued",
  maxAttempts = 5,
  nextRetryAt = null,
}) {
  if (!isDbReady(db)) return null;
  if (!messageId || !isUuid(messageId)) return null;
  if (!threadId || !isUuid(threadId)) return null;

  const resolvedTenantKey = resolveTenantKey(tenantKey);

  const result = await db.query(
    `
    insert into inbox_outbound_attempts (
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      payload,
      status,
      max_attempts,
      next_retry_at
    )
    values (
      $1::uuid,
      $2::uuid,
      $3::text,
      $4::text,
      $5::text,
      $6::text,
      $7::jsonb,
      $8::text,
      $9::int,
      $10::timestamptz
    )
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [
      messageId,
      threadId,
      resolvedTenantKey,
      channel,
      provider,
      recipientId,
      JSON.stringify(payload || {}),
      status,
      Number(maxAttempts || 5),
      nextRetryAt || null,
    ]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function getOutboundAttemptById(db, attemptId) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const result = await db.query(
    `
    select
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    from inbox_outbound_attempts
    where id = $1::uuid
    limit 1
    `,
    [attemptId]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function findLatestAttemptByMessageId(db, messageId) {
  if (!isDbReady(db)) return null;
  if (!messageId || !isUuid(messageId)) return null;

  const result = await db.query(
    `
    select
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    from inbox_outbound_attempts
    where message_id = $1::uuid
    order by created_at desc
    limit 1
    `,
    [messageId]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function listOutboundAttemptsByThread(db, threadId, limit = 100) {
  if (!isDbReady(db)) return [];
  if (!threadId || !isUuid(threadId)) return [];

  const result = await db.query(
    `
    select
      a.id,
      a.message_id,
      a.thread_id,
      a.tenant_key,
      a.channel,
      a.provider,
      a.recipient_id,
      a.provider_message_id,
      a.payload,
      a.provider_response,
      a.status,
      a.attempt_count,
      a.max_attempts,
      a.queued_at,
      a.first_attempt_at,
      a.last_attempt_at,
      a.next_retry_at,
      a.sent_at,
      a.last_error,
      a.last_error_code,
      a.created_at,
      a.updated_at,
      m.text as message_text,
      m.sender_type,
      m.message_type
    from inbox_outbound_attempts a
    left join inbox_messages m on m.id = a.message_id
    where a.thread_id = $1::uuid
    order by a.created_at desc
    limit $2::int
    `,
    [threadId, Number(limit || 100)]
  );

  return (result.rows || []).map((row) => ({
    ...toAttempt(row),
    message_text: row.message_text || "",
    sender_type: row.sender_type || "",
    message_type: row.message_type || "",
  }));
}

export async function listRetryableOutboundAttempts(db, limit = 50) {
  if (!isDbReady(db)) return [];

  const result = await db.query(
    `
    select
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    from inbox_outbound_attempts
    where status in ('queued','failed','retrying')
      and coalesce(next_retry_at, now()) <= now()
      and coalesce(attempt_count, 0) < coalesce(max_attempts, 5)
    order by coalesce(next_retry_at, created_at) asc, created_at asc
    limit $1::int
    `,
    [Number(limit || 50)]
  );

  return (result.rows || []).map(toAttempt);
}

export async function markOutboundAttemptSending(db, attemptId) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const result = await db.query(
    `
    update inbox_outbound_attempts
    set
      status = 'sending',
      attempt_count = coalesce(attempt_count, 0) + 1,
      first_attempt_at = coalesce(first_attempt_at, now()),
      last_attempt_at = now(),
      next_retry_at = null,
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [attemptId]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function markOutboundAttemptSent({
  db,
  attemptId,
  providerMessageId = null,
  providerResponse = {},
}) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const result = await db.query(
    `
    update inbox_outbound_attempts
    set
      status = 'sent',
      provider_message_id = coalesce($2::text, provider_message_id),
      provider_response = coalesce($3::jsonb, '{}'::jsonb),
      sent_at = now(),
      next_retry_at = null,
      last_error = null,
      last_error_code = null,
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [attemptId, providerMessageId, JSON.stringify(providerResponse || {})]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function markOutboundAttemptFailed({
  db,
  attemptId,
  error = "send failed",
  errorCode = "",
  providerResponse = {},
  retryDelaySeconds = 120,
}) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const existing = await getOutboundAttemptById(db, attemptId);
  if (!existing) return null;

  const attempts = Number(existing.attempt_count || 0);
  const maxAttempts = Number(existing.max_attempts || 5);
  const dead = attempts >= maxAttempts;
  const nextStatus = dead ? "dead" : "failed";

  const result = await db.query(
    `
    update inbox_outbound_attempts
    set
      status = $2::text,
      provider_response = coalesce($3::jsonb, '{}'::jsonb),
      last_error = $4::text,
      last_error_code = nullif($5::text, ''),
      next_retry_at = case
        when $2::text = 'dead' then null
        else now() + make_interval(secs => $6::int)
      end,
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [
      attemptId,
      nextStatus,
      JSON.stringify(providerResponse || {}),
      String(error || "send failed"),
      String(errorCode || ""),
      Number(retryDelaySeconds || 120),
    ]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function scheduleOutboundRetry({
  db,
  attemptId,
  retryDelaySeconds = 120,
}) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const result = await db.query(
    `
    update inbox_outbound_attempts
    set
      status = 'retrying',
      next_retry_at = now() + make_interval(secs => $2::int),
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [attemptId, Number(retryDelaySeconds || 120)]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function markOutboundAttemptDead(db, attemptId) {
  if (!isDbReady(db)) return null;
  if (!attemptId || !isUuid(attemptId)) return null;

  const result = await db.query(
    `
    update inbox_outbound_attempts
    set
      status = 'dead',
      next_retry_at = null,
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      message_id,
      thread_id,
      tenant_key,
      channel,
      provider,
      recipient_id,
      provider_message_id,
      payload,
      provider_response,
      status,
      attempt_count,
      max_attempts,
      queued_at,
      first_attempt_at,
      last_attempt_at,
      next_retry_at,
      sent_at,
      last_error,
      last_error_code,
      created_at,
      updated_at
    `,
    [attemptId]
  );

  return toAttempt(result.rows?.[0] || null);
}

export async function getOutboundAttemptsSummary(
  db,
  tenantKey = getDefaultTenantKey()
) {
  const resolvedTenantKey = resolveTenantKey(tenantKey);

  if (!isDbReady(db)) {
    return {
      tenantKey: resolvedTenantKey,
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      retrying: 0,
      dead: 0,
      total: 0,
    };
  }

  const result = await db.query(
    `
    select
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'sending')::int as sending,
      count(*) filter (where status = 'sent')::int as sent,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'retrying')::int as retrying,
      count(*) filter (where status = 'dead')::int as dead,
      count(*)::int as total
    from inbox_outbound_attempts
    where tenant_key = $1::text
    `,
    [resolvedTenantKey]
  );

  const row = result.rows?.[0] || {};
  return {
    tenantKey: resolvedTenantKey,
    queued: Number(row.queued || 0),
    sending: Number(row.sending || 0),
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0),
    retrying: Number(row.retrying || 0),
    dead: Number(row.dead || 0),
    total: Number(row.total || 0),
  };
}

export async function listFailedOutboundAttempts(
  db,
  {
    tenantKey = getDefaultTenantKey(),
    limit = 50,
    status = "",
  } = {}
) {
  if (!isDbReady(db)) return [];

  const resolvedTenantKey = resolveTenantKey(tenantKey);
  const allowed = new Set(["failed", "retrying", "dead", "queued", "sending", "sent"]);
  const useStatus = allowed.has(String(status || "").trim()) ? String(status).trim() : "";

  const values = [resolvedTenantKey];
  let where = `where a.tenant_key = $1::text`;

  if (useStatus) {
    values.push(useStatus);
    where += ` and a.status = $${values.length}::text`;
  } else {
    where += ` and a.status in ('failed','retrying','dead')`;
  }

  values.push(Number(limit || 50));

  const result = await db.query(
    `
    select
      a.id,
      a.message_id,
      a.thread_id,
      a.tenant_key,
      a.channel,
      a.provider,
      a.recipient_id,
      a.provider_message_id,
      a.payload,
      a.provider_response,
      a.status,
      a.attempt_count,
      a.max_attempts,
      a.queued_at,
      a.first_attempt_at,
      a.last_attempt_at,
      a.next_retry_at,
      a.sent_at,
      a.last_error,
      a.last_error_code,
      a.created_at,
      a.updated_at,

      m.text as message_text,
      m.sender_type,
      m.message_type,

      t.external_username,
      t.external_user_id,
      t.customer_name
    from inbox_outbound_attempts a
    left join inbox_messages m on m.id = a.message_id
    left join inbox_threads t on t.id = a.thread_id
    ${where}
    order by coalesce(a.updated_at, a.created_at) desc
    limit $${values.length}::int
    `,
    values
  );

  return (result.rows || []).map((row) => ({
    ...toAttempt(row),
    message_text: row.message_text || "",
    sender_type: row.sender_type || "",
    message_type: row.message_type || "",
    external_username: row.external_username || "",
    external_user_id: row.external_user_id || "",
    customer_name: row.customer_name || "",
  }));
}