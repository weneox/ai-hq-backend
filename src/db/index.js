import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { cfg } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

export const db = new Pool(
  cfg.DATABASE_URL
    ? {
        connectionString: cfg.DATABASE_URL,
        ssl: cfg.APP_ENV === "production" ? { rejectUnauthorized: false } : undefined
      }
    : undefined
);

// If DATABASE_URL missing, Pool() will still exist but queries will fail;
// we simply skip migrate and routes handle gracefully where needed.

export async function migrate() {
  try {
    const sqlPath = path.join(__dirname, "schema.sql");
    if (!fs.existsSync(sqlPath)) return { ok: false, reason: "schema.sql not found (skip migrate)" };

    const sql = fs.readFileSync(sqlPath, "utf8").trim();
    if (!sql) return { ok: false, reason: "schema.sql empty (skip migrate)" };

    await db.query(sql);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}