import express from "express";
import { okJson, isDbReady, isUuid } from "../../utils/http.js";
import { requireInternalToken } from "../../utils/auth.js";
import { deepFix, fixText } from "../../utils/textFix.js";

function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeThread(row) {
  if (!row) return row;
  return {
    ...row,
    customer_name: fixText(row.customer_name || ""),
    external_username: fixText(row.external_username || ""),
    assigned_to: fixText(row.assigned_to || ""),
    labels: Array.isArray(row.labels) ? row.labels.map((x) => fixText(String(x))) : [],
    meta: deepFix(row.meta || {}),
  };
}

function normalizeMessage(row) {
  if (!row) return row;
  return {
    ...row,
    text: fixText(row.text || ""),
    attachments: Array.isArray(row.attachments) ? deepFix(row.attachments) : [],
    meta: deepFix(row.meta || {}),
  };
}

export function inboxRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/inbox/ingest
  r.post("/inbox/ingest", async (req, res) => {
    if (!requireInternalToken(req)) {
      return okJson(res, { ok: false, error: "unauthorized" });
    }
  
    const tenantKey = String(req.body?.tenantKey || "neox").trim() || "neox";
    const channel = String(req.body?.channel || "instagram").trim().toLowerCase() || "instagram";

    const externalThreadId =
      fixText(String(req.body?.externalThreadId || req.body?.userId || "").trim()) || null;

    const externalUserId =
      fixText(String(req.body?.externalUserId || req.body?.userId || "").trim()) || null;

    const externalUsername =
      fixText(String(req.body?.externalUsername || "").trim()) || null;

    const customerName =
      fixText(String(req.body?.customerName || "").trim()) || null;

    const externalMessageId =
      fixText(String(req.body?.externalMessageId || "").trim()) || null;

    const text = fixText(String(req.body?.text || "").trim());
    const timestamp = req.body?.timestamp || null;

    const raw = req.body?.raw && typeof req.body.raw === "object" ? req.body.raw : {};
    const meta = {
      source: fixText(String(req.body?.source || "meta").trim()) || "meta",
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
        });
      }

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
          [
            thread.id,
            externalUserId,
            externalUsername,
            customerName,
          ]
        );

        thread = updated.rows?.[0] || thread;
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
      const normalizedThread = normalizeThread(thread);

      try {
        wsHub?.broadcast?.("inbox.message.created", {
          type: "inbox.message.created",
          threadId: thread.id,
          message,
        });
      } catch {}

      return okJson(res, {
        ok: true,
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

  // GET /api/inbox/threads
  r.get("/inbox/threads", async (req, res) => {
    const tenantKey = String(req.query?.tenantKey || "neox").trim() || "neox";
    const status = String(req.query?.status || "").trim().toLowerCase();
    const q = fixText(String(req.query?.q || "").trim());
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

  // GET /api/inbox/threads/:id
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

      const row = result.rows?.[0] || null;
      return okJson(res, { ok: true, thread: normalizeThread(row) });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  // GET /api/inbox/threads/:id/messages
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

  // POST /api/inbox/threads
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

      return okJson(res, { ok: true, thread });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  // POST /api/inbox/threads/:id/messages
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
          end
        where id = $1::uuid
        `,
        [threadId, direction]
      );

      try {
        wsHub?.broadcast?.("inbox.message.created", {
          type: "inbox.message.created",
          threadId,
          message,
        });
      } catch {}

      return okJson(res, { ok: true, message });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  // POST /api/inbox/threads/:id/read
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
        set unread_count = 0
        where id = $1::uuid
        `,
        [threadId]
      );

      try {
        wsHub?.broadcast?.("inbox.thread.read", {
          type: "inbox.thread.read",
          threadId,
        });
      } catch {}

      return okJson(res, { ok: true, threadId });
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