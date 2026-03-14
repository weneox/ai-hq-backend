import { deepFix, fixText } from "../../utils/textFix.js";

function clean(v) {
  return String(v || "").trim();
}

function isUuidLike(x) {
  const s = clean(x);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function uuidOrNull(x) {
  const s = clean(x);
  return s && isUuidLike(s) ? s : null;
}

export async function dbCreateJob(
  db,
  {
    tenantId = null,
    tenantKey = null,
    proposalId = null,
    type = "generic",
    status = "queued",
    input = {},
  }
) {
  const q = await db.query(
    `insert into jobs (tenant_id, tenant_key, proposal_id, type, status, input)
     values ($1::uuid, $2::text, $3::uuid, $4::text, $5::text, $6::jsonb)
     returning id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [
      uuidOrNull(tenantId),
      clean(tenantKey) || null,
      uuidOrNull(proposalId),
      clean(type) || "generic",
      clean(status) || "queued",
      deepFix(input),
    ]
  );

  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.input = deepFix(row.input);
  row.output = deepFix(row.output);
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}

export async function dbUpdateJob(db, id, patch) {
  const status = patch?.status ?? null;
  const output = patch?.output ?? null;
  const error = patch?.error ?? null;
  const started = patch?.started_at ?? null;
  const finished = patch?.finished_at ?? null;

  const q = await db.query(
    `update jobs
     set status = coalesce($2::text, status),
         output = case when $3::jsonb is null then output else (coalesce(output,'{}'::jsonb) || $3::jsonb) end,
         error = coalesce($4::text, error),
         started_at = case when $5::timestamptz is null then started_at else $5::timestamptz end,
         finished_at = case when $6::timestamptz is null then finished_at else $6::timestamptz end
     where id = $1::uuid
     returning id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [
      id,
      status,
      output ? deepFix(output) : output,
      error ? fixText(String(error)) : error,
      started,
      finished,
    ]
  );

  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.input = deepFix(row.input);
  row.output = deepFix(row.output);
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}