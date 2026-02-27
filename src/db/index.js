import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { config, IS_PROD } from "../config.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isValidDbUrl(url) {
  if (!url) return false;
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

const dbUrl = String(config.db.url || "").trim();

export const pool = isValidDbUrl(dbUrl)
  ? new Pool({
      connectionString: dbUrl,
      ssl: IS_PROD ? { rejectUnauthorized: false } : undefined
    })
  : null;

export async function pingDb() {
  if (!pool) return { ok: false, reason: "DATABASE_URL not configured" };
  const r = await pool.query("select 1 as ok");
  return { ok: true, row: r.rows[0] };
}

export async function migrate() {
  if (!pool) return { ok: false, reason: "DATABASE_URL not configured" };

  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  await pool.query(sql);
  return { ok: true };
}