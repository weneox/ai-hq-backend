import { dbGetTenantByKey } from "./tenants.js";

function rowOrNull(r) {
  return r?.rows?.[0] || null;
}

function rows(r) {
  return Array.isArray(r?.rows) ? r.rows : [];
}

function clean(v) {
  return String(v || "").trim().toLowerCase();
}

async function safeQuery(db, sql, params = [], fallback = []) {
  try {
    const r = await db.query(sql, params);
    return rows(r);
  } catch {
    return fallback;
  }
}

async function safeQueryOne(db, sql, params = [], fallback = null) {
  try {
    const r = await db.query(sql, params);
    return rowOrNull(r) || fallback;
  } catch {
    return fallback;
  }
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function jsonCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function escapeCsvCell(v) {
  const s = jsonCell(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function rowsToCsv(inputRows = []) {
  const rowsArr = Array.isArray(inputRows) ? inputRows : [];
  if (!rowsArr.length) return "";

  const headers = Array.from(
    rowsArr.reduce((set, row) => {
      if (isObject(row)) {
        for (const k of Object.keys(row)) set.add(k);
      }
      return set;
    }, new Set())
  );

  const out = [];
  out.push(headers.map(escapeCsvCell).join(","));

  for (const row of rowsArr) {
    const vals = headers.map((h) => escapeCsvCell(row?.[h]));
    out.push(vals.join(","));
  }

  return out.join("\n");
}

function makeMetaRow(bundle) {
  return [
    {
      exportedAt: bundle.exportedAt,
      tenantKey: bundle.tenantKey,
      tenantId: bundle.tenantId,
      companyName: bundle?.tenant?.company_name || "",
    },
  ];
}

async function fetchTenantExportData(db, tenantKey) {
  if (!db) throw new Error("Database not available");

  const key = clean(tenantKey);
  if (!key) throw new Error("tenantKey is required");

  const tenant = await dbGetTenantByKey(db, key);
  if (!tenant?.id) {
    throw new Error(`Tenant not found: ${key}`);
  }

  const tenantId = tenant.id;

  const [
    profile,
    aiPolicy,
    channels,
    users,
    leads,
    inboxThreads,
    inboxMessages,
    comments,
    proposals,
    contentItems,
    jobs,
    notifications,
  ] = await Promise.all([
    safeQueryOne(
      db,
      `
        select *
        from tenant_profiles
        where tenant_id = $1
        limit 1
      `,
      [tenantId],
      null
    ),

    safeQueryOne(
      db,
      `
        select *
        from tenant_ai_policies
        where tenant_id = $1
        limit 1
      `,
      [tenantId],
      null
    ),

    safeQuery(
      db,
      `
        select *
        from tenant_channels
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select
          id,
          tenant_id,
          user_email,
          full_name,
          role,
          status,
          permissions,
          meta,
          last_seen_at,
          created_at,
          updated_at
        from tenant_users
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from leads
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from inbox_threads
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from inbox_messages
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from comments
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from proposals
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from content_items
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from jobs
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),

    safeQuery(
      db,
      `
        select *
        from notifications
        where tenant_id = $1
        order by created_at asc
      `,
      [tenantId]
    ),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    tenantKey: tenant.tenant_key,
    tenantId,
    tenant,
    profile,
    aiPolicy,
    channels,
    users,
    leads,
    inboxThreads,
    inboxMessages,
    comments,
    proposals,
    contentItems,
    jobs,
    notifications,
  };
}

export async function dbExportTenantBundle(db, tenantKey) {
  return fetchTenantExportData(db, tenantKey);
}

export async function dbExportTenantCsvBundle(db, tenantKey) {
  const bundle = await fetchTenantExportData(db, tenantKey);

  return {
    exportedAt: bundle.exportedAt,
    tenantKey: bundle.tenantKey,
    tenantId: bundle.tenantId,
    files: {
      "00_meta.csv": rowsToCsv(makeMetaRow(bundle)),
      "01_tenant.csv": rowsToCsv(bundle.tenant ? [bundle.tenant] : []),
      "02_profile.csv": rowsToCsv(bundle.profile ? [bundle.profile] : []),
      "03_ai_policy.csv": rowsToCsv(bundle.aiPolicy ? [bundle.aiPolicy] : []),
      "04_channels.csv": rowsToCsv(bundle.channels),
      "05_users.csv": rowsToCsv(bundle.users),
      "06_leads.csv": rowsToCsv(bundle.leads),
      "07_inbox_threads.csv": rowsToCsv(bundle.inboxThreads),
      "08_inbox_messages.csv": rowsToCsv(bundle.inboxMessages),
      "09_comments.csv": rowsToCsv(bundle.comments),
      "10_proposals.csv": rowsToCsv(bundle.proposals),
      "11_content_items.csv": rowsToCsv(bundle.contentItems),
      "12_jobs.csv": rowsToCsv(bundle.jobs),
      "13_notifications.csv": rowsToCsv(bundle.notifications),
    },
  };
}