import express from "express";
import { okJson, clamp, isDbReady, isUuid } from "../../utils/http.js";
import { requireInternalToken } from "../../utils/auth.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { writeAudit } from "../../utils/auditLog.js";

function s(v) {
  return String(v ?? "").trim();
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
    extra: deepFix(row.extra || {}),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
    stage: fixText(s(body?.stage || "new")).toLowerCase() || "new",
    score: num(body?.score, 0),
    status: fixText(s(body?.status || "open")).toLowerCase() || "open",
    extra: body?.extra && typeof body.extra === "object" ? body.extra : {},
  };
}

export function leadsRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/leads/ingest
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
            extra = coalesce(extra, '{}'::jsonb) || $14::jsonb,
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
            JSON.stringify(data.extra),
          ]
        );

        const lead = normalizeLead(result.rows?.[0] || null);

        try {
          wsHub?.broadcast?.("lead.updated", {
            type: "lead.updated",
            lead,
          });
        } catch {}

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
          $16::jsonb
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
          JSON.stringify(data.extra),
        ]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("lead.created", {
          type: "lead.created",
          lead,
        });
      } catch {}

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

  // GET /api/leads
  r.get("/leads", async (req, res) => {
    const tenantKey = fixText(String(req.query?.tenantKey || "neox").trim()) || "neox";
    const stage = fixText(String(req.query?.stage || "").trim()).toLowerCase();
    const status = fixText(String(req.query?.status || "").trim()).toLowerCase();
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

  // GET /api/leads/:id
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
          extra,
          created_at,
          updated_at
        from leads
        where id = $1::uuid
        limit 1
        `,
        [id]
      );

      const lead = normalizeLead(result.rows?.[0] || null);
      return okJson(res, { ok: true, lead });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  // POST /api/leads
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
          $16::jsonb
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
          JSON.stringify(data.extra),
        ]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("lead.created", {
          type: "lead.created",
          lead,
        });
      } catch {}

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

  // POST /api/leads/:id
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
        values.push(fixText(String(req.body.stage || "").trim()).toLowerCase() || "new");
      }

      if (req.body?.score !== undefined) {
        fields.push(`score = $${n++}::int`);
        values.push(num(req.body.score, 0));
      }

      if (req.body?.status !== undefined) {
        fields.push(`status = $${n++}::text`);
        values.push(fixText(String(req.body.status || "").trim()).toLowerCase() || "open");
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
          extra,
          created_at,
          updated_at
        `,
        values
      );

      const lead = normalizeLead(result.rows?.[0] || null);
      if (!lead) return okJson(res, { ok: false, error: "not found" });

      try {
        wsHub?.broadcast?.("lead.updated", {
          type: "lead.updated",
          lead,
        });
      } catch {}

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

  return r;
}