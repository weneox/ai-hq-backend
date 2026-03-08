import express from "express";
import { okJson, clamp, isDbReady, isUuid } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";

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

export function leadsRoutes({ db, wsHub }) {
  const r = express.Router();

  // GET /api/leads
  r.get("/leads", async (req, res) => {
    const tenantKey = fixText(String(req.query.tenantKey || "neox").trim()) || "neox";
    const stage = fixText(String(req.query.stage || "").trim()).toLowerCase();
    const status = fixText(String(req.query.status || "").trim()).toLowerCase();
    const q = fixText(String(req.query.q || "").trim());
    const limit = clamp(req.query.limit ?? 50, 1, 200);

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
        order by created_at desc
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
    const tenantKey = fixText(String(req.body?.tenantKey || "neox").trim()) || "neox";
    const source = fixText(String(req.body?.source || "manual").trim()) || "manual";
    const sourceRef = fixText(String(req.body?.sourceRef || "").trim()) || null;

    const inboxThreadId = String(req.body?.inboxThreadId || "").trim() || null;
    const proposalId = String(req.body?.proposalId || "").trim() || null;

    const fullName = fixText(String(req.body?.fullName || "").trim());
    const username = fixText(String(req.body?.username || "").trim()) || null;
    const company = fixText(String(req.body?.company || "").trim()) || null;
    const phone = fixText(String(req.body?.phone || "").trim()) || null;
    const email = fixText(String(req.body?.email || "").trim()) || null;
    const interest = fixText(String(req.body?.interest || "").trim()) || null;
    const notes = fixText(String(req.body?.notes || "").trim());

    const stage = fixText(String(req.body?.stage || "new").trim()).toLowerCase() || "new";
    const score = Number.isFinite(Number(req.body?.score)) ? Number(req.body.score) : 0;
    const status = fixText(String(req.body?.status || "open").trim()).toLowerCase() || "open";

    const extra = req.body?.extra && typeof req.body.extra === "object" ? req.body.extra : {};

    try {
      if (!isDbReady(db)) {
        return okJson(res, { ok: false, error: "db disabled", dbDisabled: true });
      }

      if (!fullName && !phone && !email && !username) {
        return okJson(res, {
          ok: false,
          error: "fullName, phone, email or username required",
        });
      }

      if (inboxThreadId && !isUuid(inboxThreadId)) {
        return okJson(res, { ok: false, error: "inboxThreadId must be uuid" });
      }

      if (proposalId && !isUuid(proposalId)) {
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
          tenantKey,
          source,
          sourceRef,
          inboxThreadId,
          proposalId,
          fullName,
          username,
          company,
          phone,
          email,
          interest,
          notes,
          stage,
          score,
          status,
          JSON.stringify(extra),
        ]
      );

      const lead = normalizeLead(result.rows?.[0] || null);

      try {
        wsHub?.broadcast?.({
          type: "lead.created",
          lead,
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
        values.push(Number.isFinite(Number(req.body.score)) ? Number(req.body.score) : 0);
      }

      if (req.body?.status !== undefined) {
        fields.push(`status = $${n++}::text`);
        values.push(fixText(String(req.body.status || "").trim()).toLowerCase() || "open");
      }

      if (req.body?.extra !== undefined) {
        fields.push(`extra = $${n++}::jsonb`);
        values.push(JSON.stringify(req.body.extra && typeof req.body.extra === "object" ? req.body.extra : {}));
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
        wsHub?.broadcast?.({
          type: "lead.updated",
          lead,
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