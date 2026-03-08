import express from "express";
import { cfg } from "../../config.js";
import { okJson, clamp, isDbReady, isUuid } from "../../utils/http.js";
import { requireInternalToken } from "../../utils/auth.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { writeAudit } from "../../utils/auditLog.js";
import { classifyComment } from "../../services/commentBrain.js";

function s(v) {
  return String(v ?? "").trim();
}

function safeJson(v, fallback = {}) {
  if (!v || typeof v !== "object") return fallback;
  return v;
}

function normalizeTimestampMs(value) {
  if (value == null || value === "") return Date.now();

  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  const raw = String(value).trim();
  if (!raw) return Date.now();

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n > 1e12 ? n : n * 1000;
    }
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;

  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function trimSlash(x) {
  return String(x || "").trim().replace(/\/+$/, "");
}

async function safeReadJson(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function forwardCommentReplyToMetaGateway({
  tenantKey,
  channel,
  comment,
  replyText,
  actor,
}) {
  const base = trimSlash(
    cfg.META_GATEWAY_BASE_URL ||
      cfg.META_BOT_BACKEND_URL ||
      cfg.META_GATEWAY_URL ||
      ""
  );

  if (!base) {
    return {
      ok: false,
      status: 0,
      error: "META_GATEWAY_BASE_URL missing",
      skipped: true,
    };
  }

  const token = s(
    cfg.META_GATEWAY_INTERNAL_TOKEN ||
      cfg.META_BOT_INTERNAL_TOKEN ||
      cfg.INTERNAL_WEBHOOK_TOKEN ||
      ""
  );

  const payload = {
    tenantKey: s(tenantKey || "neox") || "neox",
    actions: [
      {
        type: "reply_comment",
        channel: s(channel || comment?.channel || "instagram").toLowerCase() || "instagram",
        commentId: s(comment?.external_comment_id || ""),
        text: s(replyText || ""),
        meta: {
          tenantKey: s(tenantKey || "neox") || "neox",
          commentId: s(comment?.id || ""),
          externalCommentId: s(comment?.external_comment_id || ""),
          externalPostId: s(comment?.external_post_id || ""),
          actor: s(actor || "operator"),
        },
      },
    ],
    context: {
      tenantKey: s(tenantKey || "neox") || "neox",
      channel: s(channel || comment?.channel || "instagram").toLowerCase() || "instagram",
      commentId: s(comment?.external_comment_id || ""),
      externalCommentId: s(comment?.external_comment_id || ""),
    },
  };

  try {
    const res = await fetch(`${base}/internal/comment-actions/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        ...(token ? { "x-internal-token": token } : {}),
      },
      body: JSON.stringify(payload),
    });

    const json = await safeReadJson(res);

    return {
      ok: Boolean(res.ok && json?.ok !== false),
      status: res.status,
      json,
      error: res.ok ? null : json?.error || json?.message || "meta gateway failed",
      skipped: false,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: String(e?.message || e),
      skipped: false,
    };
  }
}

function normalizeComment(row) {
  if (!row) return null;

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    channel: fixText(row.channel || ""),
    source: fixText(row.source || ""),
    external_comment_id: fixText(row.external_comment_id || ""),
    external_parent_comment_id: fixText(row.external_parent_comment_id || ""),
    external_post_id: fixText(row.external_post_id || ""),
    external_user_id: fixText(row.external_user_id || ""),
    external_username: fixText(row.external_username || ""),
    customer_name: fixText(row.customer_name || ""),
    text: fixText(row.text || ""),
    classification: deepFix(row.classification || {}),
    raw: deepFix(row.raw || {}),
  };
}

function normalizeLead(row) {
  if (!row) return null;

  return {
    ...row,
    tenant_key: fixText(row.tenant_key || ""),
    source: fixText(row.source || ""),
    source_ref: fixText(row.source_ref || ""),
    full_name: fixText(row.full_name || ""),
    username: fixText(row.username || ""),
    company: fixText(row.company || ""),
    phone: fixText(row.phone || ""),
    email: fixText(row.email || ""),
    interest: fixText(row.interest || ""),
    notes: fixText(row.notes || ""),
    stage: fixText(row.stage || ""),
    status: fixText(row.status || ""),
    extra: deepFix(row.extra || {}),
  };
}

function buildLeadPayloadFromComment(comment, classification) {
  return {
    source: "comment",
    sourceRef: s(comment?.external_comment_id || ""),
    fullName: s(comment?.customer_name || "") || null,
    username: s(comment?.external_username || "") || null,
    interest: s(classification?.category || "sales"),
    notes: s(comment?.text || ""),
    stage: "new",
    score:
      classification?.priority === "urgent"
        ? 95
        : classification?.priority === "high"
          ? 85
          : classification?.priority === "medium"
            ? 65
            : 40,
    status: "open",
    extra: {
      fromComment: true,
      commentId: s(comment?.id || ""),
      externalCommentId: s(comment?.external_comment_id || ""),
      postId: s(comment?.external_post_id || ""),
      channel: s(comment?.channel || ""),
      classification: deepFix(classification || {}),
    },
  };
}

function mergeClassificationForReview(classification, { status, actor, note, reason }) {
  const base = deepFix(classification || {});
  const moderation = safeJson(base.moderation, {});
  return {
    ...base,
    moderation: {
      ...moderation,
      status: s(status || moderation.status || "reviewed"),
      actor: s(actor || moderation.actor || "operator"),
      note: s(note || moderation.note || ""),
      reason: s(reason || moderation.reason || ""),
      updatedAt: nowIso(),
    },
  };
}

function mergeClassificationForReply(
  classification,
  { replyText, actor, approved = true, sent = false, provider = null, sendError = "" }
) {
  const base = deepFix(classification || {});
  const moderation = safeJson(base.moderation, {});
  const reply = safeJson(base.reply, {});

  return {
    ...base,
    shouldReply: false,
    replySuggestion: s(replyText || ""),
    moderation: {
      ...moderation,
      status: "replied",
      actor: s(actor || "operator"),
      approved: Boolean(approved),
      updatedAt: nowIso(),
    },
    reply: {
      ...reply,
      text: s(replyText || ""),
      actor: s(actor || "operator"),
      approved: Boolean(approved),
      sent: Boolean(sent),
      provider: provider ? deepFix(provider) : safeJson(reply.provider, {}),
      error: s(sendError || ""),
      createdAt: reply.createdAt || nowIso(),
      updatedAt: nowIso(),
    },
  };
}

function mergeClassificationForIgnore(classification, { actor, note }) {
  const base = deepFix(classification || {});
  const moderation = safeJson(base.moderation, {});
  return {
    ...base,
    moderation: {
      ...moderation,
      status: "ignored",
      actor: s(actor || "operator"),
      note: s(note || ""),
      updatedAt: nowIso(),
    },
  };
}

async function findExistingLeadByComment(db, tenantKey, externalCommentId) {
  const q = await db.query(
    `
    select
      id,
      tenant_key,
      source,
      source_ref,
      inbox_thread_id,
      proposal_id,
      full_name,
      username,
      company,
      phone,
      email,
      interest,
      notes,
      stage,
      score,
      status,
      extra,
      created_at,
      updated_at
    from leads
    where tenant_key = $1::text
      and source = 'comment'
      and source_ref = $2::text
    order by created_at desc
    limit 1
    `,
    [tenantKey, externalCommentId]
  );

  return normalizeLead(q.rows?.[0] || null);
}

async function createLeadFromComment({ db, wsHub, tenantKey, comment, classification }) {
  if (!classification?.shouldCreateLead) return null;

  const externalCommentId = s(comment?.external_comment_id || "");
  if (!externalCommentId) return null;

  const existingLead = await findExistingLeadByComment(db, tenantKey, externalCommentId);
  if (existingLead) return existingLead;

  const leadPayload = buildLeadPayloadFromComment(comment, classification);

  const leadInserted = await db.query(
    `
    insert into leads (
      tenant_key,
      source,
      source_ref,
      inbox_thread_id,
      proposal_id,
      full_name,
      username,
      company,
      phone,
      email,
      interest,
      notes,
      stage,
      score,
      status,
      extra
    )
    values (
      $1::text,
      $2::text,
      $3::text,
      null,
      null,
      $4::text,
      $5::text,
      null,
      null,
      null,
      $6::text,
      $7::text,
      $8::text,
      $9::int,
      $10::text,
      $11::jsonb
    )
    returning
      id,
      tenant_key,
      source,
      source_ref,
      inbox_thread_id,
      proposal_id,
      full_name,
      username,
      company,
      phone,
      email,
      interest,
      notes,
      stage,
      score,
      status,
      extra,
      created_at,
      updated_at
    `,
    [
      tenantKey,
      "comment",
      leadPayload.sourceRef,
      leadPayload.fullName || "",
      leadPayload.username,
      leadPayload.interest,
      leadPayload.notes,
      leadPayload.stage,
      leadPayload.score,
      leadPayload.status,
      JSON.stringify(leadPayload.extra),
    ]
  );

  const lead = normalizeLead(leadInserted.rows?.[0] || null);

  try {
    wsHub?.broadcast?.("lead.created", {
      type: "lead.created",
      lead,
    });
  } catch {}

  try {
    await writeAudit(db, {
      actor: "ai_hq",
      action: "lead.created_from_comment",
      objectType: "lead",
      objectId: String(lead?.id || ""),
      meta: {
        tenantKey,
        commentId: comment?.id,
        externalCommentId,
      },
    });
  } catch {}

  return lead;
}

async function getCommentById(db, id) {
  const result = await db.query(
    `
    select
      id,
      tenant_key,
      channel,
      source,
      external_comment_id,
      external_parent_comment_id,
      external_post_id,
      external_user_id,
      external_username,
      customer_name,
      text,
      classification,
      raw,
      created_at,
      updated_at
    from comments
    where id = $1::uuid
    limit 1
    `,
    [id]
  );

  return normalizeComment(result.rows?.[0] || null);
}

async function updateCommentState(db, id, nextClassification, nextRaw) {
  const result = await db.query(
    `
    update comments
    set
      classification = $2::jsonb,
      raw = $3::jsonb,
      updated_at = now()
    where id = $1::uuid
    returning
      id,
      tenant_key,
      channel,
      source,
      external_comment_id,
      external_parent_comment_id,
      external_post_id,
      external_user_id,
      external_username,
      customer_name,
      text,
      classification,
      raw,
      created_at,
      updated_at
    `,
    [id, JSON.stringify(nextClassification || {}), JSON.stringify(nextRaw || {})]
  );

  return normalizeComment(result.rows?.[0] || null);
}

export function commentsRoutes({ db, wsHub }) {
  const r = express.Router();

  r.post("/comments/ingest", async (req, res) => {
    if (!requireInternalToken(req)) {
      return okJson(res, { ok: false, error: "unauthorized" });
    }

    const tenantKey = s(req.body?.tenantKey || "neox") || "neox";
    const source = s(req.body?.source || "meta") || "meta";
    const platform = s(req.body?.platform || "instagram") || "instagram";
    const channel = (s(req.body?.channel || platform || "instagram") || "instagram").toLowerCase();

    const externalCommentId = fixText(s(req.body?.externalCommentId || "")) || null;
    const externalParentCommentId = fixText(s(req.body?.externalParentCommentId || "")) || null;
    const externalPostId = fixText(s(req.body?.externalPostId || "")) || null;

    const externalUserId = fixText(s(req.body?.externalUserId || "")) || null;
    const externalUsername = fixText(s(req.body?.externalUsername || "")) || null;
    const customerName = fixText(s(req.body?.customerName || "")) || null;

    const text = fixText(s(req.body?.text || ""));
    const timestampMs = normalizeTimestampMs(req.body?.timestamp);
    const raw = safeJson(req.body?.raw, {});

    if (!externalCommentId) {
      return okJson(res, { ok: false, error: "externalCommentId required" });
    }

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

      const existingQ = await db.query(
        `
        select
          id,
          tenant_key,
          channel,
          source,
          external_comment_id,
          external_parent_comment_id,
          external_post_id,
          external_user_id,
          external_username,
          customer_name,
          text,
          classification,
          raw,
          created_at,
          updated_at
        from comments
        where tenant_key = $1::text
          and channel = $2::text
          and external_comment_id = $3::text
        limit 1
        `,
        [tenantKey, channel, externalCommentId]
      );

      const existing = normalizeComment(existingQ.rows?.[0] || null);

      if (existing) {
        let lead = null;

        try {
          lead = await createLeadFromComment({
            db,
            wsHub,
            tenantKey,
            comment: existing,
            classification: existing.classification || {},
          });
        } catch {}

        return okJson(res, {
          ok: true,
          duplicate: true,
          deduped: true,
          comment: existing,
          classification: deepFix(existing.classification || {}),
          lead,
        });
      }

      const classification = await classifyComment({
        tenantKey,
        channel,
        externalUserId,
        externalUsername,
        customerName,
        text,
      });

      const inserted = await db.query(
        `
        insert into comments (
          tenant_key,
          channel,
          source,
          external_comment_id,
          external_parent_comment_id,
          external_post_id,
          external_user_id,
          external_username,
          customer_name,
          text,
          classification,
          raw,
          created_at,
          updated_at
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
          $9::text,
          $10::text,
          $11::jsonb,
          $12::jsonb,
          to_timestamp($13::double precision / 1000.0),
          now()
        )
        returning
          id,
          tenant_key,
          channel,
          source,
          external_comment_id,
          external_parent_comment_id,
          external_post_id,
          external_user_id,
          external_username,
          customer_name,
          text,
          classification,
          raw,
          created_at,
          updated_at
        `,
        [
          tenantKey,
          channel,
          source,
          externalCommentId,
          externalParentCommentId,
          externalPostId,
          externalUserId,
          externalUsername,
          customerName,
          text,
          JSON.stringify(classification || {}),
          JSON.stringify({
            platform,
            timestamp: req.body?.timestamp ?? null,
            raw,
          }),
          timestampMs,
        ]
      );

      const comment = normalizeComment(inserted.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("comment.created", {
          type: "comment.created",
          comment,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor: "meta_gateway",
          action: "comment.ingested",
          objectType: "comment",
          objectId: String(comment?.id || ""),
          meta: {
            tenantKey,
            channel,
            externalCommentId,
            externalPostId,
            classification,
          },
        });
      } catch {}

      let lead = null;

      try {
        lead = await createLeadFromComment({
          db,
          wsHub,
          tenantKey,
          comment,
          classification,
        });
      } catch {}

      return okJson(res, {
        ok: true,
        duplicate: false,
        deduped: false,
        comment,
        classification: deepFix(classification || {}),
        lead,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/comments", async (req, res) => {
    const tenantKey = fixText(s(req.query?.tenantKey || "neox")) || "neox";
    const channel = fixText(s(req.query?.channel || "")).toLowerCase();
    const category = fixText(s(req.query?.category || "")).toLowerCase();
    const q = fixText(s(req.query?.q || ""));
    const limit = clamp(Number(req.query?.limit ?? 50), 1, 200);

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: true,
          tenantKey,
          comments: [],
          dbDisabled: true,
        });
      }

      const values = [tenantKey];
      const where = [`tenant_key = $1::text`];

      if (channel) {
        values.push(channel);
        where.push(`channel = $${values.length}::text`);
      }

      if (category) {
        values.push(category);
        where.push(`coalesce(classification->>'category', '') = $${values.length}::text`);
      }

      if (q) {
        values.push(`%${q}%`);
        const i = values.length;
        where.push(`
          (
            coalesce(text, '') ilike $${i}
            or coalesce(external_username, '') ilike $${i}
            or coalesce(customer_name, '') ilike $${i}
            or coalesce(external_post_id, '') ilike $${i}
            or coalesce(external_comment_id, '') ilike $${i}
          )
        `);
      }

      values.push(limit);

      const result = await db.query(
        `
        select
          id,
          tenant_key,
          channel,
          source,
          external_comment_id,
          external_parent_comment_id,
          external_post_id,
          external_user_id,
          external_username,
          customer_name,
          text,
          classification,
          raw,
          created_at,
          updated_at
        from comments
        where ${where.join(" and ")}
        order by created_at desc, updated_at desc
        limit $${values.length}::int
        `,
        values
      );

      const comments = (result.rows || []).map(normalizeComment);

      return okJson(res, {
        ok: true,
        tenantKey,
        count: comments.length,
        comments,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/comments/:id", async (req, res) => {
    const id = s(req.params.id || "");
    if (!id) return okJson(res, { ok: false, error: "comment id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "comment id must be uuid" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: true,
          comment: null,
          dbDisabled: true,
        });
      }

      const comment = await getCommentById(db, id);

      return okJson(res, {
        ok: true,
        found: !!comment,
        comment,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/comments/:id/review", async (req, res) => {
    const id = s(req.params.id || "");
    const status = s(req.body?.status || "reviewed").toLowerCase();
    const actor = s(req.body?.actor || "operator");
    const note = s(req.body?.note || "");
    const reason = s(req.body?.reason || "");

    if (!id) return okJson(res, { ok: false, error: "comment id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "comment id must be uuid" });

    if (!["reviewed", "pending", "flagged", "approved", "manual_review"].includes(status)) {
      return okJson(res, { ok: false, error: "invalid review status" });
    }

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: false,
          error: "db disabled",
          dbDisabled: true,
        });
      }

      const existing = await getCommentById(db, id);
      if (!existing) {
        return okJson(res, { ok: false, error: "comment not found" });
      }

      const nextClassification = mergeClassificationForReview(existing.classification, {
        status,
        actor,
        note,
        reason,
      });

      const nextRaw = {
        ...(deepFix(existing.raw || {})),
        moderation: {
          ...(safeJson(existing.raw?.moderation, {})),
          status,
          actor,
          note,
          reason,
          updatedAt: nowIso(),
        },
      };

      const comment = await updateCommentState(db, id, nextClassification, nextRaw);

      try {
        wsHub?.broadcast?.("comment.updated", {
          type: "comment.updated",
          comment,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "comment.reviewed",
          objectType: "comment",
          objectId: String(comment?.id || ""),
          meta: {
            status,
            note,
            reason,
          },
        });
      } catch {}

      return okJson(res, {
        ok: true,
        comment,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/comments/:id/reply", async (req, res) => {
    const id = s(req.params.id || "");
    const replyText = s(req.body?.replyText || req.body?.text || "");
    const actor = s(req.body?.actor || "operator");
    const approved = req.body?.approved !== false;
    const executeNow = req.body?.executeNow !== false;

    if (!id) return okJson(res, { ok: false, error: "comment id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "comment id must be uuid" });
    if (!replyText) return okJson(res, { ok: false, error: "replyText required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: false,
          error: "db disabled",
          dbDisabled: true,
        });
      }

      const existing = await getCommentById(db, id);
      if (!existing) {
        return okJson(res, { ok: false, error: "comment not found" });
      }

      let sendResult = null;
      let sent = false;
      let sendError = "";

      if (executeNow) {
        sendResult = await forwardCommentReplyToMetaGateway({
          tenantKey: existing.tenant_key,
          channel: existing.channel,
          comment: existing,
          replyText,
          actor,
        });

        sent = Boolean(sendResult?.ok);
        sendError = sent ? "" : s(sendResult?.error || "");
      }

      const nextClassification = mergeClassificationForReply(existing.classification, {
        replyText,
        actor,
        approved,
        sent,
        provider: sendResult?.json || null,
        sendError,
      });

      const nextRaw = {
        ...(deepFix(existing.raw || {})),
        reply: {
          ...(safeJson(existing.raw?.reply, {})),
          text: replyText,
          actor,
          approved: Boolean(approved),
          sent: Boolean(sent),
          error: sendError,
          provider: sendResult?.json || null,
          createdAt: safeJson(existing.raw?.reply, {}).createdAt || nowIso(),
          updatedAt: nowIso(),
        },
        moderation: {
          ...(safeJson(existing.raw?.moderation, {})),
          status: "replied",
          actor,
          approved: Boolean(approved),
          updatedAt: nowIso(),
        },
      };

      const comment = await updateCommentState(db, id, nextClassification, nextRaw);

      try {
        wsHub?.broadcast?.("comment.updated", {
          type: "comment.updated",
          comment,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: sent ? "comment.reply_sent" : "comment.reply_saved",
          objectType: "comment",
          objectId: String(comment?.id || ""),
          meta: {
            approved: Boolean(approved),
            replyText,
            executeNow: Boolean(executeNow),
            sent: Boolean(sent),
            sendError,
            gatewayStatus: Number(sendResult?.status || 0),
          },
        });
      } catch {}

      return okJson(res, {
        ok: true,
        comment,
        replyQueued: false,
        replySaved: true,
        replySent: Boolean(sent),
        replyError: sendError || null,
        gateway: sendResult
          ? {
              ok: Boolean(sendResult.ok),
              status: Number(sendResult.status || 0),
              error: sendResult.error || null,
              skipped: Boolean(sendResult.skipped),
            }
          : null,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/comments/:id/ignore", async (req, res) => {
    const id = s(req.params.id || "");
    const actor = s(req.body?.actor || "operator");
    const note = s(req.body?.note || "");

    if (!id) return okJson(res, { ok: false, error: "comment id required" });
    if (!isUuid(id)) return okJson(res, { ok: false, error: "comment id must be uuid" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, {
          ok: false,
          error: "db disabled",
          dbDisabled: true,
        });
      }

      const existing = await getCommentById(db, id);
      if (!existing) {
        return okJson(res, { ok: false, error: "comment not found" });
      }

      const nextClassification = mergeClassificationForIgnore(existing.classification, {
        actor,
        note,
      });

      const nextRaw = {
        ...(deepFix(existing.raw || {})),
        moderation: {
          ...(safeJson(existing.raw?.moderation, {})),
          status: "ignored",
          actor,
          note,
          updatedAt: nowIso(),
        },
      };

      const comment = await updateCommentState(db, id, nextClassification, nextRaw);

      try {
        wsHub?.broadcast?.("comment.updated", {
          type: "comment.updated",
          comment,
        });
      } catch {}

      try {
        await writeAudit(db, {
          actor,
          action: "comment.ignored",
          objectType: "comment",
          objectId: String(comment?.id || ""),
          meta: {
            note,
          },
        });
      } catch {}

      return okJson(res, {
        ok: true,
        comment,
      });
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