// src/db/index.js
import pg from "pg";
import fs from "fs";
import path from "path";
import { cfg } from "../config.js";

const { Pool } = pg;

function redact(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

let _db = null;

export function getDb() {
  return _db;
}

export async function initDb() {
  const url = String(cfg.DATABASE_URL || "").trim();

  // ✅ No DATABASE_URL => DB OFF
  if (!url) {
    _db = null;
    return null;
  }

  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  // ✅ Connectivity test (fail fast, but don't crash local dev)
  try {
    await pool.query("select 1 as ok");
    console.log("[ai-hq] DB=ON", redact(url));
    _db = pool;
    return pool;
  } catch (e) {
    console.error("[ai-hq] DB connect failed:", redact(url));
    console.error(String(e?.message || e));
    try { await pool.end(); } catch {}
    _db = null;
    return null;
  }
}

export async function migrate() {
  const db = _db;
  if (!db) return { ok: false, reason: "DATABASE_URL not configured (skip)" };

  try {
    const schemaPath = path.resolve(process.cwd(), "src", "db", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    await db.query(sql);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}