// src/routes/api/team.js

import express from "express";
import { hashUserPassword } from "../../utils/adminAuth.js";
import { dbGetTenantByKey } from "../../db/helpers/settings.js";
import {
  dbListTenantUsers,
  dbGetTenantUserById,
  dbGetTenantUserByEmail,
  dbCreateTenantUser,
  dbUpdateTenantUser,
  dbSetTenantUserStatus,
  dbDeleteTenantUser,
} from "../../db/helpers/tenantUsers.js";
import { dbAudit } from "../../db/helpers/audit.js";

function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

function bad(res, error, extra = {}) {
  return res.status(400).json({ ok: false, error, ...extra });
}

function forbidden(res, error = "Forbidden", extra = {}) {
  return res.status(403).json({ ok: false, error, ...extra });
}

function unauth(res, error = "Unauthorized", extra = {}) {
  return res.status(401).json({ ok: false, error, ...extra });
}

function serverErr(res, error, extra = {}) {
  return res.status(500).json({ ok: false, error, ...extra });
}

function safeJsonObj(v, fallback = {}) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return fallback;
}

function cleanString(v, fallback = "") {
  if (v === null || v === undefined) return String(fallback ?? "").trim();
  const s = String(v).trim();
  if (!s) return String(fallback ?? "").trim();
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") {
    return String(fallback ?? "").trim();
  }
  return s;
}

function cleanNullableString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
  return s;
}

function cleanLower(v, fallback = "") {
  return cleanString(v, fallback).toLowerCase();
}

function getAuthTenantKey(req) {
  return cleanLower(req.auth?.tenantKey || "");
}

function getAuthRole(req) {
  return cleanLower(req.auth?.role || "member");
}

function getAuthActor(req) {
  return cleanString(req.auth?.email || req.auth?.userId || "user");
}

function canReadUsers(role) {
  return ["owner", "admin", "operator"].includes(cleanLower(role));
}

function canWriteUsers(role) {
  return ["owner", "admin"].includes(cleanLower(role));
}

function requireTenant(req, res) {
  const tenantKey = getAuthTenantKey(req);
  if (!tenantKey) {
    unauth(res, "Missing authenticated tenant context");
    return null;
  }
  return tenantKey;
}

async function auditSafe(db, req, tenant, action, objectType, objectId, meta = {}) {
  try {
    await dbAudit(db, getAuthActor(req), action, objectType, objectId, {
      tenantId: tenant?.id || null,
      tenantKey: tenant?.tenant_key || null,
      viewerRole: getAuthRole(req),
      ...meta,
    });
  } catch {}
}

function buildUserInput(body = {}) {
  const input = safeJsonObj(body, {});
  return {
    user_email: cleanLower(input.user_email),
    full_name: cleanString(input.full_name),
    role: cleanLower(input.role || "member"),
    status: cleanLower(input.status || "invited"),
    permissions: safeJsonObj(input.permissions, {}),
    meta: safeJsonObj(input.meta, {}),
    password_hash: Object.prototype.hasOwnProperty.call(input, "password")
      ? (cleanString(input.password) ? hashUserPassword(cleanString(input.password)) : null)
      : undefined,
    auth_provider: "local",
    email_verified: true,
    last_seen_at: input.last_seen_at || null,
  };
}

export function teamRoutes({ db }) {
  const router = express.Router();

  router.get("/team", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canReadUsers(role)) {
        return forbidden(res, "You do not have access to team data");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const status = cleanLower(req.query.status || "");
      const userRole = cleanLower(req.query.role || "");

      const users = await dbListTenantUsers(db, tenant.id, {
        status: status || undefined,
        role: userRole || undefined,
      });

      return ok(res, {
        users,
        viewerRole: role,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load team");
    }
  });

  router.get("/team/:id", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canReadUsers(role)) {
        return forbidden(res, "You do not have access to team data");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const user = await dbGetTenantUserById(db, tenant.id, req.params.id);
      if (!user) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      return ok(res, { user, viewerRole: role });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load user");
    }
  });

  router.post("/team", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canWriteUsers(role)) {
        return forbidden(res, "You do not have permission to manage team");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const input = buildUserInput(req.body);
      if (!input.user_email) {
        return bad(res, "user_email is required");
      }

      const existing = await dbGetTenantUserByEmail(db, tenant.id, input.user_email);
      if (existing?.id) {
        return bad(res, "User already exists for this tenant", {
          userId: existing.id,
        });
      }

      const user = await dbCreateTenantUser(db, tenant.id, input);

      await auditSafe(db, req, tenant, "team.user.created", "tenant_user", user?.id, {
        user_email: input.user_email,
        role: input.role,
        status: input.status,
      });

      return ok(res, { user });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to create user");
    }
  });

  router.patch("/team/:id", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canWriteUsers(role)) {
        return forbidden(res, "You do not have permission to manage team");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const current = await dbGetTenantUserById(db, tenant.id, req.params.id);
      if (!current?.id) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const patch = safeJsonObj(req.body, {});
      const merged = {
        ...current,
        ...patch,
      };

      const input = buildUserInput(merged);
      const user = await dbUpdateTenantUser(db, tenant.id, req.params.id, input);

      await auditSafe(db, req, tenant, "team.user.updated", "tenant_user", user?.id, {
        user_email: user?.user_email,
        role: user?.role,
        status: user?.status,
      });

      return ok(res, { user });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to update user");
    }
  });

  router.post("/team/:id/status", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canWriteUsers(role)) {
        return forbidden(res, "You do not have permission to manage team");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const status = cleanLower(req.body?.status || "");
      if (!status) {
        return bad(res, "status is required");
      }

      const user = await dbSetTenantUserStatus(db, tenant.id, req.params.id, status);
      if (!user?.id) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      await auditSafe(db, req, tenant, "team.user.status.updated", "tenant_user", user.id, {
        status: user.status,
      });

      return ok(res, { user });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to update user status");
    }
  });

  router.post("/team/:id/password", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canWriteUsers(role)) {
        return forbidden(res, "You do not have permission to manage passwords");
      }

      const password = cleanString(req.body?.password || "");
      if (!password) {
        return bad(res, "password is required");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const current = await dbGetTenantUserById(db, tenant.id, req.params.id);
      if (!current?.id) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const user = await dbUpdateTenantUser(db, tenant.id, req.params.id, {
        ...current,
        password_hash: hashUserPassword(password),
        auth_provider: "local",
        email_verified: true,
      });

      await auditSafe(db, req, tenant, "team.user.password.updated", "tenant_user", user?.id, {
        user_email: user?.user_email,
      });

      return ok(res, {
        user,
        passwordUpdated: true,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to update password");
    }
  });

  router.delete("/team/:id", async (req, res) => {
    try {
      const tenantKey = requireTenant(req, res);
      if (!tenantKey) return;

      const role = getAuthRole(req);
      if (!canWriteUsers(role)) {
        return forbidden(res, "You do not have permission to manage team");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const current = await dbGetTenantUserById(db, tenant.id, req.params.id);
      if (!current?.id) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }

      const deleted = await dbDeleteTenantUser(db, tenant.id, req.params.id);
      if (!deleted) {
        return res.status(400).json({ ok: false, error: "Delete failed" });
      }

      await auditSafe(db, req, tenant, "team.user.deleted", "tenant_user", current.id, {
        user_email: current.user_email,
      });

      return ok(res, { deleted: true, id: current.id });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to delete user");
    }
  });

  return router;
}