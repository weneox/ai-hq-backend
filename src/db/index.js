// src/db/index.js
// (FINAL v1.5 — smart SSL + safe migrate + clearer errors)
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

function shouldUseSsl(url) {
  try {
    const u = new URL(url);

    // Explicit sslmode=require (or similar)
    const sslmode = (u.searchParams.get("sslmode") || "").toLowerCase();
    if (sslmode === "require" || sslmode === "verify-full" || sslmode === "verify-ca") return true;

    // Common hosted db hints
    const host = (u.hostname || "").toLowerCase();
    if (host.includes("railway")) return true;
    if (host.includes("render")) return true;
    if (host.includes("supabase")) return true;
    if (host.includes("neon")) return true;

    return false;
  } catch {
    return true; // safest default if URL parsing fails
  }
}

let _db = null;

export function getDb() {
  return _db;
}

export async function initDb() {
  const url = String(cfg.DATABASE_URL || "").trim();

  // No DATABASE_URL => DB OFF
  if (!url) {
    _db = null;
    return null;
  }

  const useSsl = shouldUseSsl(url);

  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 7_000,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
    await pool.query("select 1 as ok");
    console.log("[ai-hq] DB=ON", redact(url), `ssl=${useSsl ? "on" : "off"}`);
    _db = pool;
    return pool;
  } catch (e) {
    console.error("[ai-hq] DB connect failed:", redact(url));
    console.error("[ai-hq] ", e?.code || "", String(e?.message || e));
    try {
      await pool.end();
    } catch {}
    _db = null;
    return null;
  }
}

export async function migrate() {
  const db = _db;
  if (!db) return { ok: false, reason: "DATABASE_URL not configured (skip)" };

  try {
    const schemaPath = path.resolve(process.cwd(), "src", "db", "schema.sql");
    if (!fs.existsSync(schemaPath)) {
      return { ok: false, error: `schema.sql not found at ${schemaPath}` };
    }

    const sql = fs.readFileSync(schemaPath, "utf8");

    // Default: run inside transaction for consistency
    // Set DB_MIGRATE_TX=0 if you ever hit "cannot run inside a transaction block"
    const useTx = String(cfg.DB_MIGRATE_TX ?? "1") !== "0";

    if (useTx) await db.query("begin");
    await db.query(sql);
    if (useTx) await db.query("commit");

    return { ok: true };
  } catch (e) {
    try {
      const useTx = String(cfg.DB_MIGRATE_TX ?? "1") !== "0";
      if (useTx) await _db?.query?.("rollback");
    } catch {}

    return {
      ok: false,
      error: String(e?.message || e),
      code: e?.code || null,
      detail: e?.detail || null,
      hint: e?.hint || null,
      where: e?.where || null,
      stack: e?.stack || null,
    };
  }
}