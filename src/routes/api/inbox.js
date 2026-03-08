import express from "express";
import { okJson, isDbReady, isUuid } from "../../utils/http.js";
import { requireInternalToken } from "../../utils/auth.js";
import { fixText } from "../../utils/textFix.js";
import { buildInboxActions } from "../../services/inboxBrain.js";
import { writeAudit } from "../../utils/auditLog.js";

import {
  clamp,
  normalizeMessage,
  normalizeThread,
  s,
  toInt,
  truthy,
} from "./inbox.shared.js";

import {
  findExistingInboundMessage,
  findExistingOutboundMessage,
  getTenantByKey,
  getThreadById,
  refreshThread,
} from "./inbox.db.js";

import {
  applyHandoffActions,
  persistLeadActions,
} from "./inbox.mutations.js";

export function inboxRoutes({ db, wsHub }) {
  const r = express.Router();

  r.post("/inbox/ingest", async (req, res) => {
    if (!requireInternalToken(req)) {
      return okJson(res, { ok: false, error: "unauthorized" });
    }

    const tenantKey = s(req.body?.tenantKey || "neox") || "neox";
    const channel = s(req.body?.channel || "instagram").toLowerCase() || "instagram";

    const externalThreadId =
      fixText(s(req.body?.externalThreadId || req.body?.userId)) || null;

    const externalUserId =
      fixText(s(req.body?.externalUserId || req.body?.userId)) || null;

    const externalUsername = fixText(s(req.body?.externalUsername)) || null;
    const customerName = fixText(s(req.body?.customerName)) || null;
    const externalMessageId = fixText(s(req.body?.externalMessageId)) || null;

    const text = fixText(s(req.body?.text));
    const timestamp = req.body?.timestamp || null;

    const raw = req.body?.raw && typeof req.body.raw === "object" ? req.body.raw : {};
    const meta = {
      source: fixText(s(req.body?.source || "meta")) || "meta",
      platform: fixText(s(req.body?.platform || "instagram")) || "instagram",
      timestamp,
      raw,
    };

    if (!text) {
      return okJson(res, { ok: false, error: "text required" });
    }

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: false,
          error: "db disabled",
          dbDisabled: true,
          actions: [],
        });
      }

      const tenant = await getTenantByKey(db, tenantKey);
      let thread = null;

      if (externalThreadId) {
        const existing = await db.query(
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
          where tenant_key = $1::text
            and channel = $2::text
            and external_thread_id = $3::text
          limit 1
          `,
          [tenantKey, channel, externalThreadId]
        );

        thread = existing.rows?.[0] || null;
      }

      if (!thread) {
        const created = await db.query(
          `
          insert into inbox_threads (
            tenant_key,
            channel,
            external_thread_id,
            external_user_id,
            external_username,
            customer_name,
            status,
            assigned_to,
            labels,
            meta,
            last_message_at,
            last_inbound_at,
            unread_count
          )
          values (
            $1::text,
            $2::text,
            $3::text,
            $4::text,
            $5::text,
            $6::text,
            'open',
            null,
            '[]'::jsonb,
            $7::jsonb,
            now(),
            now(),
            1
          )
          returning
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
          `,
          [
            tenantKey,
            channel,
            externalThreadId,
            externalUserId,
            externalUsername,
            customerName,
            JSON.stringify(meta),
          ]
        );

        thread = created.rows?.[0] || null;

        try {
          wsHub?.broadcast?.("inbox.thread.created", {
            type: "inbox.thread.created",
            thread: normalizeThread(thread),
          });
        } catch {}

        try {
          await writeAudit(db, {
            actor: "meta_gateway",
            action: "inbox.thread.created",
            objectType: "inbox_thread",
            objectId: String(thread?.id || ""),
            meta: {
              tenantKey,
              channel,
              externalThreadId,
              externalUserId,
            },
          });
        } catch {}
      } else {
        const updated = await db.query(
          `
          update inbox_threads
          set
            external_user_id = coalesce($2::text, external_user_id),
            external_username = coalesce($3::text, external_username),
            customer_name = coalesce($4::text, customer_name),
            last_message_at = now(),
            last_inbound_at = now(),
            unread_count = coalesce(unread_count, 0) + 1,
            updated_at = now()
          where id = $1::uuid
          returning
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
          `,
          [thread.id, externalUserId, externalUsername, customerName]
        );

        thread = updated.rows?.[0] || thread;
      }

      if (externalMessageId && thread?.id) {
        const existingMessage = await findExistingInboundMessage({
          db,
          tenantKey,
          threadId: thread.id,
          externalMessageId,
        });

        if (existingMessage) {
          await writeAudit(db, {
            actor: "meta_gateway",
            action: "inbox.inbound.deduped",
            objectType: "inbox_message",
            objectId: String(existingMessage?.id || ""),
            meta: {
              tenantKey,
              channel,
              threadId: String(thread?.id || ""),
              externalMessageId: String(externalMessageId || ""),
            },
          });

          return okJson(res, {
            ok: true,
            duplicate: true,
            deduped: true,
            thread: normalizeThread(thread),
            message: existingMessage,
            actions: [],
            leadResults: [],
            handoffResults: [],
          });
        }
      }

      const insertedMessage = await db.query(
        `
        insert into inbox_messages (
          thread_id,
          tenant_key,
          direction,
          sender_type,
          external_message_id,
          message_type,
          text,
          attachments,
          meta,
          sent_at
        )
        values (
          $1::uuid,
          $2::text,
          'inbound',
          'customer',
          $3::text,
          'text',
          $4::text,
          '[]'::jsonb,
          $5::jsonb,
          coalesce(to_timestamp($6::double precision / 1000.0), now())
        )
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
          thread.id,
          tenantKey,
          externalMessageId,
          text,
          JSON.stringify(meta),
          Number(timestamp || Date.now()),
        ]
      );

      const message = normalizeMessage(insertedMessage.rows?.[0] || null);
      let normalizedThread = normalizeThread(thread);

      try {
        wsHub?.broadcast?.("inbox.message.created", {
          type: "inbox.message.created",
          threadId: thread.id,
          message,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: "meta_gateway",
          action: "inbox.inbound.created",
          objectType: "inbox_message",
          objectId: String(message?.id || ""),
          meta: {
            tenantKey,
            channel,
            threadId: String(thread?.id || ""),
            externalMessageId: String(externalMessageId || ""),
          },
        });
      } catch {}

      const brain = await buildInboxActions({
        text,
        channel,
        externalUserId,
        tenantKey,
        thread: normalizedThread,
        message,
        tenant,
      });

      const actions = Array.isArray(brain?.actions) ? brain.actions : [];

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "inbox.brain.executed",
          objectType: "inbox_message",
          objectId: String(message?.id || ""),
          meta: {
            tenantKey,
            intent: String(brain?.intent || "general"),
            leadScore: Number(brain?.leadScore || 0),
            actionCount: actions.length,
            threadId: String(thread?.id || ""),
          },
        });
      } catch {}

      const leadResults = await persistLeadActions({
        db,
        wsHub,
        tenantKey,
        actions,
      });

      const handoffResults = await applyHandoffActions({
        db,
        wsHub,
        threadId: normalizedThread?.id,
        actions,
      });

      if (handoffResults.length && normalizedThread?.id) {
        normalizedThread = await refreshThread(db, normalizedThread.id, normalizedThread);
      }

      return okJson(res, {
        ok: true,
        duplicate: false,
        deduped: false,
        thread: normalizedThread,
        message,
        tenant: tenant
          ? {
              tenant_key: tenant.tenant_key,
              name: tenant.name,
              timezone: tenant.timezone,
              inbox_policy: tenant.inbox_policy || {},
            }
          : null,
        intent: brain?.intent || "general",
        leadScore: Number(brain?.leadScore || 0),
        policy: brain?.policy || null,
        actions,
        leadResults,
        handoffResults,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
        actions: [],
      });
    }
  });

  r.post("/inbox/outbound", async (req, res) => {
    if (!requireInternalToken(req)) {
      return okJson(res, { ok: false, error: "unauthorized" });
    }

    const threadId = s(req.body?.threadId || "");
    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });
    if (!isUuid(threadId)) return okJson(res, { ok: false, error: "threadId must be uuid" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      const existingThread = await getThreadById(db, threadId);
      if (!existingThread) {
        return okJson(res, { ok: false, error: "thread not found" });
      }

      const tenantKey =
        s(req.body?.tenantKey || existingThread?.tenant_key || "neox") || "neox";

      const channel =
        s(req.body?.channel || existingThread?.channel || "instagram").toLowerCase() || "instagram";

      const recipientId = fixText(s(req.body?.recipientId || "")) || null;
      const senderType = s(req.body?.senderType || "ai").toLowerCase() || "ai";
      const externalMessageId =
        fixText(s(req.body?.providerMessageId || req.body?.externalMessageId || "")) || null;
      const messageType = s(req.body?.messageType || "text").toLowerCase() || "text";
      const text = fixText(s(req.body?.text || ""));
      const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};

      if (!text && attachments.length === 0) {
        return okJson(res, { ok: false, error: "text or attachments required" });
      }

      if (externalMessageId) {
        const existingMessage = await findExistingOutboundMessage({
          db,
          tenantKey,
          threadId,
          externalMessageId,
        });

        if (existingMessage) {
          await writeAudit(db, {
            actor: "meta_gateway",
            action: "inbox.outbound.deduped",
            objectType: "inbox_message",
            objectId: String(existingMessage?.id || ""),
            meta: {
              tenantKey,
              channel,
              threadId,
              externalMessageId: String(externalMessageId || ""),
            },
          });

          return okJson(res, {
            ok: true,
            duplicate: true,
            deduped: true,
            thread: existingThread,
            message: existingMessage,
          });
        }
      }

      const mergedMeta = {
        ...meta,
        recipientId,
        provider: s(req.body?.provider || "meta") || "meta",
        operatorName: s(req.body?.operatorName || ""),
      };

      const inserted = await db.query(
        `
        insert into inbox_messages (
          thread_id,
          tenant_key,
          direction,
          sender_type,
          external_message_id,
          message_type,
          text,
          attachments,
          meta,
          sent_at
        )
        values (
          $1::uuid,
          $2::text,
          'outbound',
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::jsonb,
          $8::jsonb,
          now()
        )
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
          threadId,
          tenantKey,
          senderType,
          externalMessageId,
          messageType,
          text,
          JSON.stringify(attachments),
          JSON.stringify(mergedMeta),
        ]
      );

      const message = normalizeMessage(inserted.rows?.[0] || null);

      await db.query(
        `
        update inbox_threads
        set
          last_message_at = now(),
          last_outbound_at = now(),
          external_user_id = coalesce($2::text, external_user_id),
          updated_at = now()
        where id = $1::uuid
        `,
        [threadId, recipientId]
      );

      const normalizedThread = await refreshThread(db, threadId, existingThread);

      try {
        wsHub?.broadcast?.("inbox.message.created", {
          type: "inbox.message.created",
          threadId,
          message,
        });
      } catch {}

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread: normalizedThread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: senderType === "agent" ? "operator" : "meta_gateway",
          action: "inbox.outbound.created",
          objectType: "inbox_message",
          objectId: String(message?.id || ""),
          meta: {
            tenantKey,
            channel,
            threadId,
            externalMessageId: String(externalMessageId || ""),
            senderType,
          },
        });
      } catch {}

      return okJson(res, {
        ok: true,
        duplicate: false,
        deduped: false,
        thread: normalizedThread,
        message,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/inbox/threads", async (req, res) => {
    const tenantKey = String(req.query?.tenantKey || "neox").trim() || "neox";
    const status = String(req.query?.status || "").trim().toLowerCase();
    const q = fixText(String(req.query?.q || "").trim());
    const handoffOnly = truthy(req.query?.handoffOnly);
    const limit = clamp(toInt(req.query?.limit, 30), 1, 200);

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: true,
          tenantKey,
          threads: [],
          dbDisabled: true,
        });
      }

      const values = [tenantKey];
      let where = `where t.tenant_key = $1::text`;

      if (status) {
        values.push(status);
        where += ` and t.status = $${values.length}::text`;
      }

      if (handoffOnly) {
        where += ` and coalesce(t.meta->'handoff'->>'active', 'false') = 'true'`;
      }

      if (q) {
        values.push(`%${q}%`);
        const i = values.length;
        where += `
          and (
            coalesce(t.customer_name, '') ilike $${i}
            or coalesce(t.external_username, '') ilike $${i}
            or coalesce(t.external_user_id, '') ilike $${i}
            or coalesce(t.external_thread_id, '') ilike $${i}
          )
        `;
      }

      values.push(limit);

      const sql = `
        select
          t.id,
          t.tenant_key,
          t.channel,
          t.external_thread_id,
          t.external_user_id,
          t.external_username,
          t.customer_name,
          t.status,
          t.last_message_at,
          t.last_inbound_at,
          t.last_outbound_at,
          t.unread_count,
          t.assigned_to,
          t.labels,
          t.meta,
          t.created_at,
          t.updated_at,
          (
            select m.text
            from inbox_messages m
            where m.thread_id = t.id
            order by m.sent_at desc, m.created_at desc
            limit 1
          ) as last_message_text
        from inbox_threads t
        ${where}
        order by coalesce(t.last_message_at, t.updated_at, t.created_at) desc
        limit $${values.length}::int
      `;

      const result = await db.query(sql, values);
      const threads = (result.rows || []).map((row) => ({
        ...normalizeThread(row),
        last_message_text: fixText(row.last_message_text || ""),
      }));

      return okJson(res, { ok: true, tenantKey, threads });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/inbox/threads/:id", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: true, thread: null, dbDisabled: true });
      }

      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const row = await getThreadById(db, threadId);
      return okJson(res, { ok: true, thread: row });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/inbox/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    const limit = clamp(toInt(req.query?.limit, 200), 1, 1000);

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: true,
          threadId,
          messages: [],
          dbDisabled: true,
        });
      }

      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

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
        where thread_id = $1::uuid
        order by sent_at asc, created_at asc
        limit $2::int
        `,
        [threadId, limit]
      );

      const messages = (result.rows || []).map(normalizeMessage);
      return okJson(res, { ok: true, threadId, messages });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads", async (req, res) => {
    const tenantKey = String(req.body?.tenantKey || "neox").trim() || "neox";
    const channel = String(req.body?.channel || "instagram").trim().toLowerCase() || "instagram";
    const externalThreadId = fixText(String(req.body?.externalThreadId || "").trim()) || null;
    const externalUserId = fixText(String(req.body?.externalUserId || "").trim()) || null;
    const externalUsername = fixText(String(req.body?.externalUsername || "").trim()) || null;
    const customerName = fixText(String(req.body?.customerName || "").trim());
    const status = String(req.body?.status || "open").trim().toLowerCase() || "open";
    const assignedTo = fixText(String(req.body?.assignedTo || "").trim()) || null;
    const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      const result = await db.query(
        `
        insert into inbox_threads (
          tenant_key,
          channel,
          external_thread_id,
          external_user_id,
          external_username,
          customer_name,
          status,
          assigned_to,
          labels,
          meta,
          last_message_at
        )
        values (
          $1::text,
          $2::text,
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::text,
          $8::text,
          $9::jsonb,
          $10::jsonb,
          now()
        )
        returning
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
        `,
        [
          tenantKey,
          channel,
          externalThreadId,
          externalUserId,
          externalUsername,
          customerName,
          status,
          assignedTo,
          JSON.stringify(labels),
          JSON.stringify(meta),
        ]
      );

      const thread = normalizeThread(result.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("inbox.thread.created", {
          type: "inbox.thread.created",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "inbox.thread.manual_created",
          objectType: "inbox_thread",
          objectId: String(thread?.id || ""),
          meta: {
            tenantKey,
            channel,
            externalThreadId: String(externalThreadId || ""),
          },
        });
      } catch {}

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/messages", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    const tenantKey = String(req.body?.tenantKey || "neox").trim() || "neox";
    const direction = String(req.body?.direction || "inbound").trim().toLowerCase() || "inbound";
    const senderType = String(req.body?.senderType || "customer").trim().toLowerCase() || "customer";
    const externalMessageId = fixText(String(req.body?.externalMessageId || "").trim()) || null;
    const messageType = String(req.body?.messageType || "text").trim().toLowerCase() || "text";
    const text = fixText(String(req.body?.text || "").trim());
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};
    const releaseHandoff = truthy(req.body?.releaseHandoff);

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });
    if (!text && attachments.length === 0) {
      return okJson(res, { ok: false, error: "text or attachments required" });
    }

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const existingThread = await getThreadById(db, threadId);
      if (!existingThread) {
        return okJson(res, { ok: false, error: "thread not found" });
      }

      const insert = await db.query(
        `
        insert into inbox_messages (
          thread_id,
          tenant_key,
          direction,
          sender_type,
          external_message_id,
          message_type,
          text,
          attachments,
          meta,
          sent_at
        )
        values (
          $1::uuid,
          $2::text,
          $3::text,
          $4::text,
          $5::text,
          $6::text,
          $7::text,
          $8::jsonb,
          $9::jsonb,
          now()
        )
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
          threadId,
          tenantKey,
          direction,
          senderType,
          externalMessageId,
          messageType,
          text,
          JSON.stringify(attachments),
          JSON.stringify(meta),
        ]
      );

      const message = normalizeMessage(insert.rows?.[0] || null);

      await db.query(
        `
        update inbox_threads
        set
          last_message_at = now(),
          last_inbound_at = case when $2::text = 'inbound' then now() else last_inbound_at end,
          last_outbound_at = case when $2::text = 'outbound' then now() else last_outbound_at end,
          unread_count = case
            when $2::text = 'inbound' then coalesce(unread_count, 0) + 1
            else unread_count
          end,
          meta = case
            when $3::boolean = true then
              jsonb_set(
                coalesce(meta, '{}'::jsonb),
                '{handoff}',
                '{"active":false,"reason":"","priority":"","at":null}'::jsonb,
                true
              )
            else coalesce(meta, '{}'::jsonb)
          end,
          updated_at = now()
        where id = $1::uuid
        `,
        [threadId, direction, releaseHandoff]
      );

      const thread = await refreshThread(db, threadId, null);

      try {
        wsHub?.broadcast?.("inbox.message.created", {
          type: "inbox.message.created",
          threadId,
          message,
        });
      } catch {}

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: senderType === "agent" ? (s(req.body?.operatorName || "operator")) : "ai_hq",
          action: "inbox.message.manual_created",
          objectType: "inbox_message",
          objectId: String(message?.id || ""),
          meta: {
            tenantKey,
            threadId,
            direction,
            senderType,
            externalMessageId: String(externalMessageId || ""),
            releaseHandoff,
          },
        });
      } catch {}

      return okJson(res, { ok: true, message, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/read", async (req, res) => {
    const threadId = String(req.params.id || "").trim();
    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      await db.query(
        `
        update inbox_threads
        set unread_count = 0, updated_at = now()
        where id = $1::uuid
        `,
        [threadId]
      );

      const thread = await refreshThread(db, threadId, null);

      try {
        wsHub?.broadcast?.("inbox.thread.read", {
          type: "inbox.thread.read",
          threadId,
        });
      } catch {}

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "inbox.thread.read",
          objectType: "inbox_thread",
          objectId: threadId,
          meta: {},
        });
      } catch {}

      return okJson(res, { ok: true, threadId, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/assign", async (req, res) => {
    const threadId = s(req.params.id);
    const assignedTo = fixText(s(req.body?.assignedTo || ""));
    const actor = fixText(s(req.body?.actor || assignedTo || "operator")) || "operator";

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });
    if (!assignedTo) return okJson(res, { ok: false, error: "assignedTo required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }
      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const updated = await db.query(
        `
        update inbox_threads
        set
          assigned_to = $2::text,
          updated_at = now()
        where id = $1::uuid
        returning
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
        `,
        [threadId, assignedTo]
      );

      const thread = normalizeThread(updated.rows?.[0] || null);
      if (!thread) return okJson(res, { ok: false, error: "thread not found" });

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "inbox.thread.assigned",
          objectType: "inbox_thread",
          objectId: threadId,
          meta: { assignedTo },
        });
      } catch {}

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/handoff/activate", async (req, res) => {
    const threadId = s(req.params.id);
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const assignedTo = fixText(s(req.body?.assignedTo || "")) || "human_handoff";
    const reason = fixText(s(req.body?.reason || "manual_review")) || "manual_review";
    const priority = fixText(s(req.body?.priority || "high")).toLowerCase() || "high";

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }
      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const existing = await getThreadById(db, threadId);
      if (!existing) return okJson(res, { ok: false, error: "thread not found" });

      const meta = {
        ...(existing.meta && typeof existing.meta === "object" ? existing.meta : {}),
        handoff: {
          active: true,
          reason,
          priority,
          at: new Date().toISOString(),
        },
      };

      const updated = await db.query(
        `
        update inbox_threads
        set
          assigned_to = coalesce(nullif($2::text, ''), assigned_to),
          status = 'open',
          labels = (
            select jsonb_agg(distinct v)
            from jsonb_array_elements_text(
              coalesce(labels, '[]'::jsonb) || to_jsonb(array['handoff', $3::text]::text[])
            ) as t(v)
          ),
          meta = $4::jsonb,
          updated_at = now()
        where id = $1::uuid
        returning
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
        `,
        [threadId, assignedTo, priority, JSON.stringify(meta)]
      );

      const thread = normalizeThread(updated.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "inbox.handoff.activated",
          objectType: "inbox_thread",
          objectId: threadId,
          meta: { assignedTo, reason, priority },
        });
      } catch {}

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/handoff/release", async (req, res) => {
    const threadId = s(req.params.id);
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }
      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const existing = await getThreadById(db, threadId);
      if (!existing) return okJson(res, { ok: false, error: "thread not found" });

      const meta = {
        ...(existing.meta && typeof existing.meta === "object" ? existing.meta : {}),
        handoff: {
          active: false,
          reason: "",
          priority: "",
          at: null,
        },
      };

      const updated = await db.query(
        `
        update inbox_threads
        set
          meta = $2::jsonb,
          updated_at = now()
        where id = $1::uuid
        returning
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
        `,
        [threadId, JSON.stringify(meta)]
      );

      const thread = normalizeThread(updated.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "inbox.handoff.released",
          objectType: "inbox_thread",
          objectId: threadId,
          meta: {},
        });
      } catch {}

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/inbox/threads/:id/status", async (req, res) => {
    const threadId = s(req.params.id);
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const status = fixText(s(req.body?.status || "")).toLowerCase();

    if (!threadId) return okJson(res, { ok: false, error: "threadId required" });
    if (!status) return okJson(res, { ok: false, error: "status required" });

    const allowed = new Set(["open", "pending", "resolved", "closed", "spam"]);
    if (!allowed.has(status)) {
      return okJson(res, { ok: false, error: "invalid status" });
    }

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }
      if (!isUuid(threadId)) {
        return okJson(res, { ok: false, error: "threadId must be uuid" });
      }

      const updated = await db.query(
        `
        update inbox_threads
        set
          status = $2::text,
          updated_at = now()
        where id = $1::uuid
        returning
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
        `,
        [threadId, status]
      );

      const thread = normalizeThread(updated.rows?.[0] || null);
      if (!thread) return okJson(res, { ok: false, error: "thread not found" });

      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "inbox.thread.status_changed",
          objectType: "inbox_thread",
          objectId: threadId,
          meta: { status },
        });
      } catch {}

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  return r;
}