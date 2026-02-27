import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config, IS_PROD } from "../config.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalize(s) {
  return String(s || "").trim();
}

function isValidDbUrl(url) {
  if (!url) return false;
  const u = String(url).trim();
  return u.startsWith("postgres://") || u.startsWith("postgresql://");
}

/**
 * Railway-də bəzən yanlışlıqla DATABASE_URL-ə host (məs: switchyard.proxy.rlwy.net)
 * qoyulur və pg bunu new URL(...) ilə parse edəndə "Invalid URL" atır.
 *
 * Bu səbəbdən:
 * 1) Əgər connectionString valid-dirsə -> ondan istifadə edirik
 * 2) Deyilsə -> PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT ilə config qururuq
 */
function buildPgConfig() {
  // 1) Əsas: config.db.url (səndə buradan gəlir)
  const fromConfig = normalize(config?.db?.url);

  // 2) Fallback: ENV
  const fromEnv = normalize(process.env.DATABASE_URL);

  const connectionString = isValidDbUrl(fromConfig)
    ? fromConfig
    : isValidDbUrl(fromEnv)
    ? fromEnv
    : "";

  const ssl = IS_PROD ? { rejectUnauthorized: false } : undefined;

  if (connectionString) {
    return { connectionString, ssl };
  }

  // 3) Parts fallback (Railway Postgres plugin bunu həmişə verir)
  const host = normalize(process.env.PGHOST);
  const user = normalize(process.env.PGUSER);
  const password = normalize(process.env.PGPASSWORD);
  const database = normalize(process.env.PGDATABASE || process.env.POSTGRES_DB);
  const portRaw = normalize(process.env.PGPORT);
  const port = portRaw ? Number(portRaw) : undefined;

  if (host && user && password && database && port) {
    return { host, user, password, database, port, ssl };
  }

  // heç nə yoxdursa
  return null;
}

const pgConfig = buildPgConfig();

export const pool = pgConfig ? new Pool(pgConfig) : null;

export async function pingDb() {
  if (!pool) return { ok: false, reason: "DB not configured (DATABASE_URL/PG* missing)" };

  try {
    const r = await pool.query("select 1 as ok");
    return { ok: true, row: r.rows?.[0] || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function migrate() {
  if (!pool) return { ok: false, reason: "DB not configured (skip migrate)" };

  const sqlPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(sqlPath)) {
    return { ok: false, reason: "schema.sql not found (skip migrate)" };
  }

  const sql = fs.readFileSync(sqlPath, "utf8").trim();
  if (!sql) {
    return { ok: false, reason: "schema.sql is empty (skip migrate)" };
  }

  try {
    await pool.query(sql);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}