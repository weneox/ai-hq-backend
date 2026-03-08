import { isDbReady, isUuid } from "../../utils/http.js";
import {
  normalizeMessage,
  normalizeTenant,
  normalizeThread,
} from "./inbox.shared.js";

export async function getTenantByKey(db, tenantKey) {
  if (!isDbReady(db)) return null;

  try {
    const result = await db.query(
      `
      select
        id,
        tenant_key,
        name,
        timezone,
        inbox_policy,
        meta,
        created_at,
        updated_at
      from tenants
      where tenant_key = $1::text
      limit 1
      `,
      [tenantKey]
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
    [tenantKey, threadId, externalMessageId]
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
    [tenantKey, threadId, externalMessageId]
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