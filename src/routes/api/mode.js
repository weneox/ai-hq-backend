import express from "express";
import { cfg } from "../../config.js";
import { okJson, isDbReady } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { mem } from "../../utils/memStore.js";
import { dbGetTenantMode, dbSetTenantMode } from "../../db/helpers/tenants.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function normalizeMode(x) {
  const v = s(x).toLowerCase();
  return v === "auto" ? "auto" : "manual";
}

function resolveTenantKey(input) {
  return (
    fixText(s(input || cfg.tenant.defaultTenantKey || "default")) || "default"
  );
}

async function getTenantMode({ db, tenantKey }) {
  const tk = resolveTenantKey(tenantKey);

  if (!isDbReady(db)) {
    const v = mem.tenantMode.get(tk);
    return normalizeMode(v || cfg.app.defaultMode || "manual");
  }

  try {
    const row = await dbGetTenantMode(db, tk);
    return normalizeMode(row?.mode || cfg.app.defaultMode || "manual");
  } catch {
    return normalizeMode(cfg.app.defaultMode || "manual");
  }
}

async function setTenantMode({ db, tenantKey, mode }) {
  const tk = resolveTenantKey(tenantKey);
  const m = normalizeMode(mode);

  if (!isDbReady(db)) {
    mem.tenantMode.set(tk, m);
    return {
      tenant_key: tk,
      mode: m,
      dbDisabled: true,
    };
  }

  const row = await dbSetTenantMode(db, tk, m);

  if (row) {
    return {
      tenant_key: s(row.tenant_key || tk),
      mode: normalizeMode(row.mode),
      dbDisabled: false,
    };
  }

  mem.tenantMode.set(tk, m);
  return {
    tenant_key: tk,
    mode: m,
    dbDisabled: false,
    warning: "tenant row not updated; using memory fallback",
  };
}

export function modeRoutes({ db, wsHub }) {
  const r = express.Router();

  r.get("/mode", async (req, res) => {
    const tenantKey = resolveTenantKey(
      req.query.tenantKey ||
        req.query.tenant_key ||
        req.query.tenantId ||
        req.query.tenant_id
    );

    try {
      const mode = await getTenantMode({ db, tenantKey });
      return okJson(res, {
        ok: true,
        tenantKey,
        tenant_key: tenantKey,
        mode,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.post("/mode", async (req, res) => {
    const tenantKey = resolveTenantKey(
      req.body?.tenantKey ||
        req.body?.tenant_key ||
        req.body?.tenantId ||
        req.body?.tenant_id
    );

    const mode = normalizeMode(req.body?.mode);

    try {
      const out = await setTenantMode({ db, tenantKey, mode });

      wsHub?.broadcast?.({
        type: "tenant.mode",
        tenantKey: out.tenant_key,
        tenant_key: out.tenant_key,
        mode: out.mode,
      });

      return okJson(res, {
        ok: true,
        tenantKey: out.tenant_key,
        tenant_key: out.tenant_key,
        mode: out.mode,
        ...(out.warning ? { warning: out.warning } : {}),
        dbDisabled: out.dbDisabled,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  r.get("/__mode_internal_test", async (_req, res) => {
    return okJson(res, { ok: true });
  });

  return r;
}

export { getTenantMode, normalizeMode };