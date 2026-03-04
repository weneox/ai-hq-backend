import express from "express";
import { cfg } from "../../config.js";
import { okJson, isDbReady } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { mem } from "../../utils/memStore.js";
import { dbGetTenantMode, dbSetTenantMode } from "../../db/helpers/tenants.js";

function normalizeMode(x) {
  const s = String(x || "").trim().toLowerCase();
  return s === "auto" ? "auto" : "manual";
}

async function getTenantMode({ db, tenantId }) {
  const tid = String(tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim() || "default";

  if (!isDbReady(db)) {
    const v = mem.tenantMode.get(tid);
    return normalizeMode(v || cfg.DEFAULT_MODE || "manual");
  }

  try {
    const row = await dbGetTenantMode(db, tid);
    return normalizeMode(row?.mode || cfg.DEFAULT_MODE || "manual");
  } catch {
    return normalizeMode(cfg.DEFAULT_MODE || "manual");
  }
}

async function setTenantMode({ db, tenantId, mode }) {
  const tid = String(tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim() || "default";
  const m = normalizeMode(mode);

  if (!isDbReady(db)) {
    mem.tenantMode.set(tid, m);
    return { key: tid, mode: m, dbDisabled: true };
  }

  const row = await dbSetTenantMode(db, tid, m);
  if (row) return { key: row.key, mode: normalizeMode(row.mode), dbDisabled: false };

  mem.tenantMode.set(tid, m);
  return { key: tid, mode: m, dbDisabled: false, warning: "tenant row not updated; using memory fallback" };
}

export function modeRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/mode", async (req, res) => {
    const tenantId =
      fixText(String(req.query.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";
    try {
      const mode = await getTenantMode({ db, tenantId });
      return okJson(res, { ok: true, tenantId, mode });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  r.post("/mode", async (req, res) => {
    const tenantId =
      fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";
    const mode = normalizeMode(req.body?.mode);

    try {
      const out = await setTenantMode({ db, tenantId, mode });
      wsHub?.broadcast?.({ type: "tenant.mode", tenantId: out.key, mode: out.mode });
      return okJson(res, { ok: true, tenantId: out.key, mode: out.mode, ...(out.warning ? { warning: out.warning } : {}), dbDisabled: out.dbDisabled });
    } catch (e) {
      return okJson(res, { ok: false, error: "Error", details: { message: String(e?.message || e) } });
    }
  });

  // export for other route files if you need
  r.get("/__mode_internal_test", async (_req, res) => okJson(res, { ok: true }));

  return r;
}

// ✅ export helpers for auto-advance usage (optional)
export { getTenantMode, normalizeMode };