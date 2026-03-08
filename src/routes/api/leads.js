import express from "express";
import { okJson, clamp, isDbReady, isUuid } from "../../utils/http.js";
import { requireInternalToken } from "../../utils/auth.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { writeAudit } from "../../utils/auditLog.js";

function s(v) {
  return String(v ?? "").trim();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePriority(v) {
  const x = fixText(s(v || "normal")).toLowerCase() || "normal";
  return ["low", "normal", "high", "urgent"].includes(x) ? x : "normal";
}

function normalizeStage(v) {
  const x = fixText(s(v || "new")).toLowerCase() || "new";
  return ["new", "contacted", "qualified", "proposal", "won", "lost"].includes(x) ? x : "new";
}

function normalizeStatus(v) {
  const x = fixText(s(v || "open")).toLowerCase() || "open";
  return ["open", "archived", "spam", "closed"].includes(x) ? x : "open";
}

function normalizeLead(row) {
  if (!row) return row;
  return {
    ...row,
    full_name: fixText(row.full_name || ""),
    username: fixText(row.username || ""),
    company: fixText(row.company || ""),
    phone: fixText(row.phone || ""),
    email: fixText(row.email || ""),
    interest: fixText(row.interest || ""),
    notes: fixText(row.notes || ""),
    owner: fixText(row.owner || ""),
    priority: normalizePriority(row.priority || "normal"),
    next_action: fixText(row.next_action || ""),
    won_reason: fixText(row.won_reason || ""),
    lost_reason: fixText(row.lost_reason || ""),
    value_azn: Number(row.value_azn || 0),
    extra: deepFix(row.extra || {}),
  };
}

function normalizeLeadEvent(row) {
  if (!row) return row;
  return {
    ...row,
    actor: fixText(row.actor || ""),
    type: fixText(row.type || ""),
    payload: deepFix(row.payload || {}),
  };
}

function cleanLeadPayload(body = {}) {
  return {
    tenantKey: fixText(s(body?.tenantKey || "neox")) || "neox",
    source: fixText(s(body?.source || "manual")) || "manual",
    sourceRef: fixText(s(body?.sourceRef || "")) || null,
    inboxThreadId: s(body?.inboxThreadId || "") || null,
    proposalId: s(body?.proposalId || "") || null,
    fullName: fixText(s(body?.fullName || "")) || null,
    username: fixText(s(body?.username || "")) || null,
    company: fixText(s(body?.company || "")) || null,
    phone: fixText(s(body?.phone || "")) || null,
    email: fixText(s(body?.email || "")) || null,
    interest: fixText(s(body?.interest || "")) || null,
    notes: fixText(s(body?.notes || "")) || "",
    stage: normalizeStage(body?.stage || "new"),
    score: num(body?.score, 0),
    status: normalizeStatus(body?.status || "open"),
    owner: fixText(s(body?.owner || "")) || null,
    priority: normalizePriority(body?.priority || "normal"),
    valueAzn: num(body?.valueAzn ?? body?.value_azn, 0),
    followUpAt: s(body?.followUpAt || body?.follow_up_at || "") || null,
    nextAction: fixText(s(body?.nextAction || body?.next_action || "")) || null,
    wonReason: fixText(s(body?.wonReason || body?.won_reason || "")) || null,
    lostReason: fixText(s(body?.lostReason || body?.lost_reason || "")) || null,
    extra: body?.extra && typeof body.extra === "object" ? body.extra : {},
  };
}

async function insertLeadEvent(db, {
  leadId,
  tenantKey = "neox",
  type,
  actor = "ai_hq",
  payload = {},
}) {
  if (!leadId || !isUuid(leadId) || !type) return null;

  const result = await db.query(
    `
    insert into lead_events (
      lead_id,
      tenant_key,
      type,
      actor,
      payload
    )
    values (
      $1::uuid,
      $2::text,
      $3::text,
      $4::text,
      $5::jsonb
    )
    returning
      id,
      lead_id,
      tenant_key,
      type,
      actor,
      payload,
      created_at
    `,
    [
      leadId,
      tenantKey,
      fixText(s(type)),
      fixText(s(actor || "ai_hq")) || "ai_hq",
      JSON.stringify(payload || {}),
    ]
  );

  return normalizeLeadEvent(result.rows?.[0] || null);
}

async function broadcastLead(wsHub, type, lead) {
  try {
    wsHub?.broadcast?.(type, {
      type,
      lead,
    });
  } catch {}
}

async function broadcastLeadEvent(wsHub, event) {
  try {
    wsHub?.broadcast?.("lead.event.created", {
      type: "lead.event.created",
      event,
    });
  } catch {}
}

async function fetchLeadById(db, id) {
  const result = await db.query(
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
      owner,
      priority,
      value_azn,
      follow_up_at,
      next_action,
      won_reason,
      lost_reason,
      extra,
      created_at,
      updated_at
    from leads
    where id = $1::uuid
    limit 1
    `,
    [id]
  );

  return normalizeLead(result.rows?.[0] || null);
}

export function leadsRoutes({ db, wsHub }) {
  const r = express.Router();

  r.post("/leads/ingest", async (req, res) => {
    if (!requireInternalToken(req)) {
      return okJson(res, { ok: false, error: "unauthorized" });
    }

    const data = cleanLeadPayload({
      ...req.body,
      source: req.body?.source || "meta",
    });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (
        !data.fullName &&
        !data.phone &&
        !data.email &&
        !data.username &&
        !data.inboxThreadId
      ) {
        return okJson(res, {
          ok: false,
          error: "fullName, phone, email, username or inboxThreadId required",
        });
      }

      if (data.inboxThreadId && !isUuid(data.inboxThreadId)) {
        return okJson(res, { ok: false, error: "inboxThreadId must be uuid" });
      }

      if (data.proposalId && !isUuid(data.proposalId)) {
        return okJson(res, { ok: false, error: "proposalId must be uuid" });
      }

      let existing = null;

      if (data.inboxThreadId) {
        const found = await db.query(
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
            owner,
            priority,
            value_azn,
            follow_up_at,
            next_action,
            won_reason,
            lost_reason,
            extra,
            created_at,
            updated_at
          from leads
          where tenant_key = $1::text
            and inbox_thread_id = $2::uuid
            and status <> 'closed'
          order by updated_at desc, created_at desc
          limit 1
          `,
          [data.tenantKey, data.inboxThreadId]
        );

        existing = found.rows?.[0] || null;
      }

      if (existing) {
        const before = normalizeLead(existing);

        const result = await db.query(
          `
          update leads
          set
            source_ref = coalesce($2::text, source_ref),
            proposal_id = coalesce($3::uuid, proposal_id),
            full_name = coalesce(nullif($4::text, ''), full_name),
            username = coalesce(nullif($5::text, ''), username),
            company = coalesce(nullif($6::text, ''), company),
            phone = coalesce(nullif($7::text, ''), phone),
            email = coalesce(nullif($8::text, ''), email),
            interest = coalesce(nullif($9::text, ''), interest),
            notes = case
              when nullif($10::text, '') is null then notes
              when coalesce(notes, '') = '' then $10::text
              else concat(notes, E'\n\n', $10::text)
            end,
            stage = coalesce(nullif($11::text, ''), stage),
            score = greatest(coalesce(score, 0), $12::int),
            status = coalesce(nullif($13::text, ''), status),
            owner = coalesce(nullif($14::text, ''), owner),
            priority = coalesce(nullif($15::text, ''), priority),
            value_azn = greatest(coalesce(value_azn, 0), $16::numeric(12,2)),
            follow_up_at = coalesce($17::timestamptz, follow_up_at),
            next_action = coalesce(nullif($18::text, ''), next_action),
            won_reason = coalesce(nullif($19::text, ''), won_reason),
            lost_reason = coalesce(nullif($20::text, ''), lost_reason),
            extra = coalesce(extra, '{}'::jsonb) || $21::jsonb,
            updated_at = now()
          where id = $1::uuid
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
            owner,
            priority,
            value_azn,
            follow_up_at,
            next_action,
            won_reason,
            lost_reason,
            extra,
            created_at,
            updated_at
          `,
          [
            existing.id,
            data.sourceRef,
            data.proposalId || null,
            data.fullName || "",
            data.username || "",
            data.company || "",
            data.phone || "",
            data.email || "",
            data.interest || "",
            data.notes || "",
            data.stage || "",
            data.score,
            data.status || "",
            data.owner || "",
            data.priority || "",
            data.valueAzn,
            data.followUpAt || null,
            data.nextAction || "",
            data.wonReason || "",
            data.lostReason || "",
            JSON.stringify(data.extra),
          ]
        );

        const lead = normalizeLead(result.rows?.[0] || null);

        const event = await insertLeadEvent(db, {
          leadId: lead?.id,
          tenantKey: data.tenantKey,
          type: "lead.updated",
          actor: "ai_hq",
          payload: {
            mode: "ingest",
            before,
            after: lead,
          },
        });

        await broadcastLead(wsHub, "lead.updated", lead);
        await broadcastLeadEvent(wsHub, event);

        try {
          await writeAudit(db, {
            actor: "ai_hq",
            action: "lead.updated",
            objectType: "lead",
            objectId: String(lead?.id || ""),
            meta: {
              tenantKey: data.tenantKey,
              inboxThreadId: data.inboxThreadId,
              stage: data.stage,
              status: data.status,
              score: data.score,
              mode: "ingest",
            },
          });
        } catch {}

        return okJson(res, { ok: true, mode: "updated", lead });
      }

      const result = await db.query(
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra
        )
        values (
          $1::text,
          $2::text,
          $3::text,
          $4::uuid,
          $5::uuid,
          $6::text,
          $7::text,
          $8::text,
          $9::text,
          $10::text,
          $11::text,
          $12::text,
          $13::text,
          $14::int,
          $15::text,
          $16::text,
          $17::text,
          $18::numeric(12,2),
          $19::timestamptz,
          $20::text,
          $21::text,
          $22::text,
          $23::jsonb
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [
          data.tenantKey,
          data.source,
          data.sourceRef,
          data.inboxThreadId,
          data.proposalId,
          data.fullName,
          data.username,
          data.company,
          data.phone,
          data.email,
          data.interest,
          data.notes,
          data.stage,
          data.score,
          data.status,
          data.owner,
          data.priority,
          data.valueAzn,
          data.followUpAt || null,
          data.nextAction,
          data.wonReason,
          data.lostReason,
          JSON.stringify(data.extra),
        ]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: lead?.id,
        tenantKey: data.tenantKey,
        type: "lead.created",
        actor: "ai_hq",
        payload: {
          mode: "ingest",
          lead,
        },
      });

      await broadcastLead(wsHub, "lead.created", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "lead.created",
          objectType: "lead",
          objectId: String(lead?.id || ""),
          meta: {
            tenantKey: data.tenantKey,
            inboxThreadId: data.inboxThreadId,
            stage: data.stage,
            status: data.status,
            score: data.score,
            mode: "ingest",
          },
        });
      } catch {}

      return okJson(res, { ok: true, mode: "created", lead });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/leads", async (req, res) => {
    const tenantKey = fixText(String(req.query?.tenantKey || "neox").trim()) || "neox";
    const stage = fixText(String(req.query?.stage || "").trim()).toLowerCase();
    const status = fixText(String(req.query?.status || "").trim()).toLowerCase();
    const owner = fixText(String(req.query?.owner || "").trim());
    const priority = fixText(String(req.query?.priority || "").trim()).toLowerCase();
    const q = fixText(String(req.query?.q || "").trim());
    const limit = clamp(Number(req.query?.limit ?? 50), 1, 200);

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: true, tenantKey, leads: [], dbDisabled: true });
      }

      const values = [tenantKey];
      const where = [`tenant_key = $1::text`];

      if (stage) {
        values.push(stage);
        where.push(`stage = $${values.length}::text`);
      }

      if (status) {
        values.push(status);
        where.push(`status = $${values.length}::text`);
      }

      if (owner) {
        values.push(owner);
        where.push(`coalesce(owner, '') = $${values.length}::text`);
      }

      if (priority) {
        values.push(priority);
        where.push(`priority = $${values.length}::text`);
      }

      if (q) {
        values.push(`%${q}%`);
        const i = values.length;
        where.push(`
          (
            coalesce(full_name, '') ilike $${i}
            or coalesce(username, '') ilike $${i}
            or coalesce(company, '') ilike $${i}
            or coalesce(phone, '') ilike $${i}
            or coalesce(email, '') ilike $${i}
            or coalesce(interest, '') ilike $${i}
            or coalesce(notes, '') ilike $${i}
            or coalesce(owner, '') ilike $${i}
            or coalesce(next_action, '') ilike $${i}
          )
        `);
      }

      values.push(limit);

      const sql = `
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        from leads
        where ${where.join(" and ")}
        order by updated_at desc, created_at desc
        limit $${values.length}::int
      `;

      const result = await db.query(sql, values);
      const leads = (result.rows || []).map(normalizeLead);

      return okJson(res, { ok: true, tenantKey, leads });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/leads/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: true, lead: null, dbDisabled: true });
      }

      if (!isUuid(id)) {
        return okJson(res, { ok: false, error: "lead id must be uuid" });
      }

      const lead = await fetchLeadById(db, id);
      return okJson(res, { ok: true, lead });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/leads/:id/events", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const limit = clamp(Number(req.query?.limit ?? 100), 1, 500);

    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: true, events: [], dbDisabled: true });
      }

      if (!isUuid(id)) {
        return okJson(res, { ok: false, error: "lead id must be uuid" });
      }

      const result = await db.query(
        `
        select
          id,
          lead_id,
          tenant_key,
          type,
          actor,
          payload,
          created_at
        from lead_events
        where lead_id = $1::uuid
        order by created_at desc
        limit $2::int
        `,
        [id, limit]
      );

      const events = (result.rows || []).map(normalizeLeadEvent);
      return okJson(res, { ok: true, leadId: id, events });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads", async (req, res) => {
    const data = cleanLeadPayload(req.body);

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (!data.fullName && !data.phone && !data.email && !data.username) {
        return okJson(res, {
          ok: false,
          error: "fullName, phone, email or username required",
        });
      }

      if (data.inboxThreadId && !isUuid(data.inboxThreadId)) {
        return okJson(res, { ok: false, error: "inboxThreadId must be uuid" });
      }

      if (data.proposalId && !isUuid(data.proposalId)) {
        return okJson(res, { ok: false, error: "proposalId must be uuid" });
      }

      const result = await db.query(
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra
        )
        values (
          $1::text,
          $2::text,
          $3::text,
          $4::uuid,
          $5::uuid,
          $6::text,
          $7::text,
          $8::text,
          $9::text,
          $10::text,
          $11::text,
          $12::text,
          $13::text,
          $14::int,
          $15::text,
          $16::text,
          $17::text,
          $18::numeric(12,2),
          $19::timestamptz,
          $20::text,
          $21::text,
          $22::text,
          $23::jsonb
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [
          data.tenantKey,
          data.source,
          data.sourceRef,
          data.inboxThreadId,
          data.proposalId,
          data.fullName,
          data.username,
          data.company,
          data.phone,
          data.email,
          data.interest,
          data.notes,
          data.stage,
          data.score,
          data.status,
          data.owner,
          data.priority,
          data.valueAzn,
          data.followUpAt || null,
          data.nextAction,
          data.wonReason,
          data.lostReason,
          JSON.stringify(data.extra),
        ]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: lead?.id,
        tenantKey: data.tenantKey,
        type: "lead.created",
        actor: "ai_hq",
        payload: {
          mode: "manual_create",
          lead,
        },
      });

      await broadcastLead(wsHub, "lead.created", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "lead.created",
          objectType: "lead",
          objectId: String(lead?.id || ""),
          meta: {
            tenantKey: data.tenantKey,
            stage: data.stage,
            status: data.status,
            score: data.score,
            mode: "manual_create",
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (!isUuid(id)) {
        return okJson(res, { ok: false, error: "lead id must be uuid" });
      }

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const fields = [];
      const values = [];
      let n = 1;

      if (req.body?.fullName !== undefined) {
        fields.push(`full_name = $${n++}::text`);
        values.push(fixText(String(req.body.fullName || "").trim()));
      }

      if (req.body?.username !== undefined) {
        fields.push(`username = $${n++}::text`);
        values.push(fixText(String(req.body.username || "").trim()) || null);
      }

      if (req.body?.company !== undefined) {
        fields.push(`company = $${n++}::text`);
        values.push(fixText(String(req.body.company || "").trim()) || null);
      }

      if (req.body?.phone !== undefined) {
        fields.push(`phone = $${n++}::text`);
        values.push(fixText(String(req.body.phone || "").trim()) || null);
      }

      if (req.body?.email !== undefined) {
        fields.push(`email = $${n++}::text`);
        values.push(fixText(String(req.body.email || "").trim()) || null);
      }

      if (req.body?.interest !== undefined) {
        fields.push(`interest = $${n++}::text`);
        values.push(fixText(String(req.body.interest || "").trim()) || null);
      }

      if (req.body?.notes !== undefined) {
        fields.push(`notes = $${n++}::text`);
        values.push(fixText(String(req.body.notes || "").trim()));
      }

      if (req.body?.stage !== undefined) {
        fields.push(`stage = $${n++}::text`);
        values.push(normalizeStage(req.body.stage || "new"));
      }

      if (req.body?.score !== undefined) {
        fields.push(`score = $${n++}::int`);
        values.push(num(req.body.score, 0));
      }

      if (req.body?.status !== undefined) {
        fields.push(`status = $${n++}::text`);
        values.push(normalizeStatus(req.body.status || "open"));
      }

      if (req.body?.owner !== undefined) {
        fields.push(`owner = $${n++}::text`);
        values.push(fixText(String(req.body.owner || "").trim()) || null);
      }

      if (req.body?.priority !== undefined) {
        fields.push(`priority = $${n++}::text`);
        values.push(normalizePriority(req.body.priority || "normal"));
      }

      if (req.body?.valueAzn !== undefined || req.body?.value_azn !== undefined) {
        fields.push(`value_azn = $${n++}::numeric(12,2)`);
        values.push(num(req.body.valueAzn ?? req.body.value_azn, 0));
      }

      if (req.body?.followUpAt !== undefined || req.body?.follow_up_at !== undefined) {
        fields.push(`follow_up_at = $${n++}::timestamptz`);
        values.push(s(req.body.followUpAt || req.body.follow_up_at || "") || null);
      }

      if (req.body?.nextAction !== undefined || req.body?.next_action !== undefined) {
        fields.push(`next_action = $${n++}::text`);
        values.push(
          fixText(String(req.body.nextAction || req.body.next_action || "").trim()) || null
        );
      }

      if (req.body?.wonReason !== undefined || req.body?.won_reason !== undefined) {
        fields.push(`won_reason = $${n++}::text`);
        values.push(
          fixText(String(req.body.wonReason || req.body.won_reason || "").trim()) || null
        );
      }

      if (req.body?.lostReason !== undefined || req.body?.lost_reason !== undefined) {
        fields.push(`lost_reason = $${n++}::text`);
        values.push(
          fixText(String(req.body.lostReason || req.body.lost_reason || "").trim()) || null
        );
      }

      if (req.body?.extra !== undefined) {
        fields.push(`extra = $${n++}::jsonb`);
        values.push(
          JSON.stringify(
            req.body.extra && typeof req.body.extra === "object" ? req.body.extra : {}
          )
        );
      }

      if (!fields.length) {
        return okJson(res, { ok: false, error: "no fields to update" });
      }

      values.push(id);

      const result = await db.query(
        `
        update leads
        set
          ${fields.join(", ")},
          updated_at = now()
        where id = $${n}::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        values
      );

      const lead = normalizeLead(result.rows?.[0] || null);
      if (!lead) return okJson(res, { ok: false, error: "not found" });

      const event = await insertLeadEvent(db, {
        leadId: lead?.id,
        tenantKey: lead?.tenant_key || "neox",
        type: "lead.updated",
        actor: "ai_hq",
        payload: {
          mode: "manual_update",
          before,
          after: lead,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor: "ai_hq",
          action: "lead.updated",
          objectType: "lead",
          objectId: String(lead?.id || ""),
          meta: {
            stage: lead?.stage,
            status: lead?.status,
            score: lead?.score,
            priority: lead?.priority,
            owner: lead?.owner,
            mode: "manual_update",
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id/stage", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const stage = normalizeStage(req.body?.stage || "new");
    const reason = fixText(s(req.body?.reason || "")) || null;

    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      if (!isUuid(id)) return okJson(res, { ok: false, error: "lead id must be uuid" });

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const result = await db.query(
        `
        update leads
        set
          stage = $2::text,
          updated_at = now()
        where id = $1::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [id, stage]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: id,
        tenantKey: lead?.tenant_key || before?.tenant_key || "neox",
        type: "lead.stage_changed",
        actor,
        payload: {
          from: before?.stage || null,
          to: lead?.stage || stage,
          reason,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor,
          action: "lead.stage_changed",
          objectType: "lead",
          objectId: id,
          meta: {
            from: before?.stage || null,
            to: lead?.stage || stage,
            reason,
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead, event });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id/status", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const status = normalizeStatus(req.body?.status || "open");
    const reason = fixText(s(req.body?.reason || "")) || null;

    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      if (!isUuid(id)) return okJson(res, { ok: false, error: "lead id must be uuid" });

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const result = await db.query(
        `
        update leads
        set
          status = $2::text,
          updated_at = now()
        where id = $1::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [id, status]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: id,
        tenantKey: lead?.tenant_key || before?.tenant_key || "neox",
        type: "lead.status_changed",
        actor,
        payload: {
          from: before?.status || null,
          to: lead?.status || status,
          reason,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor,
          action: "lead.status_changed",
          objectType: "lead",
          objectId: id,
          meta: {
            from: before?.status || null,
            to: lead?.status || status,
            reason,
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead, event });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id/owner", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const owner = fixText(s(req.body?.owner || "")) || null;

    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      if (!isUuid(id)) return okJson(res, { ok: false, error: "lead id must be uuid" });

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const result = await db.query(
        `
        update leads
        set
          owner = $2::text,
          updated_at = now()
        where id = $1::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [id, owner]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: id,
        tenantKey: lead?.tenant_key || before?.tenant_key || "neox",
        type: "lead.owner_changed",
        actor,
        payload: {
          from: before?.owner || null,
          to: lead?.owner || null,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor,
          action: "lead.owner_changed",
          objectType: "lead",
          objectId: id,
          meta: {
            from: before?.owner || null,
            to: lead?.owner || null,
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead, event });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id/followup", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const followUpAt = s(req.body?.followUpAt || req.body?.follow_up_at || "") || null;
    const nextAction = fixText(s(req.body?.nextAction || req.body?.next_action || "")) || null;

    if (!id) return okJson(res, { ok: false, error: "lead id required" });

    try {
      if (!isDbReady(db)) return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      if (!isUuid(id)) return okJson(res, { ok: false, error: "lead id must be uuid" });

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const result = await db.query(
        `
        update leads
        set
          follow_up_at = $2::timestamptz,
          next_action = $3::text,
          updated_at = now()
        where id = $1::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [id, followUpAt, nextAction]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: id,
        tenantKey: lead?.tenant_key || before?.tenant_key || "neox",
        type: "lead.followup_set",
        actor,
        payload: {
          fromFollowUpAt: before?.follow_up_at || null,
          toFollowUpAt: lead?.follow_up_at || null,
          fromNextAction: before?.next_action || null,
          toNextAction: lead?.next_action || null,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor,
          action: "lead.followup_set",
          objectType: "lead",
          objectId: id,
          meta: {
            followUpAt: lead?.follow_up_at || null,
            nextAction: lead?.next_action || null,
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead, event });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/leads/:id/note", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const actor = fixText(s(req.body?.actor || "operator")) || "operator";
    const note = fixText(s(req.body?.note || req.body?.notes || ""));

    if (!id) return okJson(res, { ok: false, error: "lead id required" });
    if (!note) return okJson(res, { ok: false, error: "note required" });

    try {
      if (!isDbReady(db)) return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      if (!isUuid(id)) return okJson(res, { ok: false, error: "lead id must be uuid" });

      const before = await fetchLeadById(db, id);
      if (!before) return okJson(res, { ok: false, error: "not found" });

      const result = await db.query(
        `
        update leads
        set
          notes = case
            when coalesce(notes, '') = '' then $2::text
            else concat(notes, E'\n\n', $2::text)
          end,
          updated_at = now()
        where id = $1::uuid
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
          owner,
          priority,
          value_azn,
          follow_up_at,
          next_action,
          won_reason,
          lost_reason,
          extra,
          created_at,
          updated_at
        `,
        [id, note]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      const event = await insertLeadEvent(db, {
        leadId: id,
        tenantKey: lead?.tenant_key || before?.tenant_key || "neox",
        type: "lead.note_added",
        actor,
        payload: {
          note,
        },
      });

      await broadcastLead(wsHub, "lead.updated", lead);
      await broadcastLeadEvent(wsHub, event);

      try {
        await writeAudit(db, {
          actor,
          action: "lead.note_added",
          objectType: "lead",
          objectId: id,
          meta: {
            notePreview: note.slice(0, 200),
          },
        });
      } catch {}

      return okJson(res, { ok: true, lead, event });
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