import { deepFix, fixText } from "../../utils/textFix.js";

export async function dbCreateJob(db, { proposalId=null, type="generic", status="queued", input={} }) {
  const q = await db.query(
    `insert into jobs (proposal_id, type, status, input)
     values ($1::uuid, $2::text, $3::text, $4::jsonb)
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [proposalId, type, status, deepFix(input)]
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
     returning id, proposal_id, type, status, input, output, error, created_at, started_at, finished_at`,
    [id, status, output ? deepFix(output) : output, error ? fixText(String(error)) : error, started, finished]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  row.input = deepFix(row.input);
  row.output = deepFix(row.output);
  row.error = row.error ? fixText(String(row.error)) : row.error;
  return row;
}