import express from "express";
import {
  isAdminAuthConfigured,
  isUserAuthConfigured,
  verifyAdminPasscode,
  verifyUserPassword,
  createAdminSessionToken,
  createUserSessionToken,
  adminCookieOptions,
  userCookieOptions,
  clearAdminCookie,
  clearUserCookie,
  checkAdminRateLimit,
  registerAdminFailedAttempt,
  clearAdminFailedAttempts,
  readAdminSessionFromRequest,
  readUserSessionFromRequest,
  parseCookies,
  getAdminCookieName,
  getUserCookieName,
} from "../../utils/adminAuth.js";
import { cfg } from "../../config.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function lower(v) {
  return s(v).toLowerCase();
}

function getIp(req) {
  const xfwd = s(req?.headers?.["x-forwarded-for"]);
  if (xfwd) return xfwd.split(",")[0].trim();
  return s(req?.ip) || s(req?.socket?.remoteAddress) || "unknown";
}

function setNoStore(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

async function checkDb(db) {
  if (!db) return false;
  try {
    const q = await db.query("select 1 as ok");
    return q?.rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

async function findTenantUserForLogin(db, { email, tenantKey }) {
  if (!db) return null;

  const e = lower(email);
  const tk = s(tenantKey);

  if (!e) return null;

  const params = [e];
  let whereTenant = "";

  if (tk) {
    params.push(tk);
    whereTenant = `and t.tenant_key = $2`;
  }

  const sql = `
    select
      tu.id,
      tu.tenant_id,
      t.tenant_key,
      tu.user_email,
      tu.full_name,
      tu.role,
      tu.status,
      tu.password_hash,
      tu.auth_provider,
      tu.email_verified,
      tu.session_version,
      t.company_name
    from tenant_users tu
    join tenants t on t.id = tu.tenant_id
    where lower(tu.user_email) = $1
      ${whereTenant}
    order by
      case when tu.status = 'active' then 0 else 1 end,
      tu.updated_at desc nulls last,
      tu.created_at desc nulls last
    limit 1
  `;

  const q = await db.query(sql, params);
  return q?.rows?.[0] || null;
}

async function markUserLogin(db, userId) {
  if (!db || !userId) return;
  try {
    await db.query(
      `
      update tenant_users
      set
        last_login_at = now(),
        last_seen_at = now(),
        updated_at = now()
      where id = $1
      `,
      [userId]
    );
  } catch {}
}

export function adminAuthRoutes({ db, wsHub } = {}) {
  const r = express.Router();

  r.get("/admin-auth/me", async (req, res) => {
    setNoStore(res);

    const adminSession = readAdminSessionFromRequest(req);
    const userSession = readUserSessionFromRequest(req);
    const dbOk = await checkDb(db);

    return res.status(200).json({
      ok: true,
      enabled: !!cfg.ADMIN_PANEL_ENABLED,
      configured: {
        admin: isAdminAuthConfigured(),
        user: isUserAuthConfigured(),
      },
      authenticated: {
        admin: !!adminSession?.ok,
        user: !!userSession?.ok,
      },
      session: {
        admin: adminSession?.ok
          ? {
              exp: adminSession.payload?.exp || null,
              iat: adminSession.payload?.iat || null,
            }
          : null,
        user: userSession?.ok
          ? {
              userId: userSession.payload?.userId || null,
              tenantId: userSession.payload?.tenantId || null,
              tenantKey: userSession.payload?.tenantKey || null,
              email: userSession.payload?.email || null,
              fullName: userSession.payload?.fullName || "",
              role: userSession.payload?.role || null,
              exp: userSession.payload?.exp || null,
              iat: userSession.payload?.iat || null,
            }
          : {
              ok: false,
              error: userSession?.error || null,
            },
      },
      runtime: {
        env: cfg.APP_ENV,
        hasDb: !!db,
        dbOk,
        wsEnabled: !!wsHub,
      },
    });
  });

  r.get("/auth/me", async (req, res) => {
    setNoStore(res);

    const userSession = readUserSessionFromRequest(req);
    const dbOk = await checkDb(db);

    if (!userSession?.ok) {
      return res.status(401).json({
        ok: false,
        authenticated: false,
        error: "Unauthorized",
        reason: userSession?.error || "invalid_session",
        user: null,
        runtime: {
          env: cfg.APP_ENV,
          hasDb: !!db,
          dbOk,
        },
        marker: "AUTH_ME_DEBUG_V2",
      });
    }

    return res.status(200).json({
      ok: true,
      authenticated: true,
      user: {
        id: userSession.payload?.userId || null,
        tenantId: userSession.payload?.tenantId || null,
        tenantKey: userSession.payload?.tenantKey || null,
        email: userSession.payload?.email || null,
        fullName: userSession.payload?.fullName || "",
        role: userSession.payload?.role || "member",
        exp: userSession.payload?.exp || null,
        iat: userSession.payload?.iat || null,
      },
      runtime: {
        env: cfg.APP_ENV,
        hasDb: !!db,
        dbOk,
      },
      marker: "AUTH_ME_DEBUG_V2",
    });
  });

  r.get("/auth/debug-session", async (req, res) => {
    setNoStore(res);

    const cookies = parseCookies(req);
    const rawToken = cookies[getUserCookieName()] || "";
    const userSession = readUserSessionFromRequest(req);
    const dbOk = await checkDb(db);

    return res.status(200).json({
      ok: true,
      marker: "AUTH_DEBUG_SESSION_V2",
      cookieNames: Object.keys(cookies || {}),
      hasUserCookie: Boolean(rawToken),
      userCookieName: getUserCookieName(),
      rawTokenLength: rawToken ? rawToken.length : 0,
      verify: userSession?.ok
        ? {
            ok: true,
            error: null,
            payload: userSession.payload || null,
          }
        : {
            ok: false,
            error: userSession?.error || "unknown",
            payload: null,
          },
      runtime: {
        env: cfg.APP_ENV,
        hasDb: !!db,
        dbOk,
      },
    });
  });

  r.post("/admin-auth/login", (req, res) => {
    setNoStore(res);

    if (!cfg.ADMIN_PANEL_ENABLED) {
      return res.status(403).json({
        ok: false,
        error: "Admin panel disabled",
      });
    }

    if (!isAdminAuthConfigured()) {
      return res.status(500).json({
        ok: false,
        error: "Admin auth is not configured",
      });
    }

    const rl = checkAdminRateLimit(req);
    if (!rl.ok) {
      return res.status(429).json({
        ok: false,
        error: "Too many failed attempts. Try again later.",
        retryAfterMs: Math.max(0, Number(rl.resetAt || 0) - Date.now()),
      });
    }

    const passcode = s(req.body?.passcode || req.body?.code || "");
    if (!passcode) {
      return res.status(400).json({
        ok: false,
        error: "passcode is required",
      });
    }

    const valid = verifyAdminPasscode(passcode);
    if (!valid) {
      registerAdminFailedAttempt(req);
      return res.status(401).json({
        ok: false,
        error: "Invalid passcode",
      });
    }

    clearAdminFailedAttempts(req);

    const token = createAdminSessionToken({
      ip: getIp(req),
      ua: s(req.headers["user-agent"]),
    });

    clearAdminCookie(res);
    res.cookie(getAdminCookieName(), token, adminCookieOptions());

    return res.status(200).json({
      ok: true,
      authenticated: true,
      authType: "admin_passcode",
    });
  });

  r.post("/auth/login", async (req, res) => {
    setNoStore(res);

    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "Database is not available",
      });
    }

    if (!isUserAuthConfigured()) {
      return res.status(500).json({
        ok: false,
        error: "User auth is not configured",
      });
    }

    const email = lower(req.body?.email);
    const password = s(req.body?.password);
    const tenantKey = s(req.body?.tenantKey || req.body?.workspace || "");

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email is required",
      });
    }

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: "password is required",
      });
    }

    let user;
    try {
      user = await findTenantUserForLogin(db, { email, tenantKey });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: String(e?.message || e || "Login query failed"),
      });
    }

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Invalid credentials",
      });
    }

    if (s(user.status) !== "active") {
      return res.status(403).json({
        ok: false,
        error: "User is not active",
      });
    }

    if (s(user.auth_provider, "local") !== "local") {
      return res.status(400).json({
        ok: false,
        error: `This account uses ${s(user.auth_provider)} login`,
      });
    }

    if (!s(user.password_hash)) {
      return res.status(403).json({
        ok: false,
        error: "Password is not set for this account",
      });
    }

    const valid = verifyUserPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Invalid credentials",
      });
    }

    const token = createUserSessionToken(
      {
        id: user.id,
        tenant_id: user.tenant_id,
        tenant_key: user.tenant_key,
        user_email: user.user_email,
        full_name: user.full_name,
        role: user.role,
        session_version: user.session_version,
      },
      {
        ip: getIp(req),
        ua: s(req.headers["user-agent"]),
      }
    );

    clearUserCookie(res);
    res.cookie(getUserCookieName(), token, userCookieOptions());

    await markUserLogin(db, user.id);

    return res.status(200).json({
      ok: true,
      authenticated: true,
      authType: "tenant_user",
      user: {
        id: user.id,
        email: user.user_email,
        fullName: user.full_name || "",
        role: user.role,
        tenantId: user.tenant_id,
        tenantKey: user.tenant_key,
        companyName: user.company_name || "",
      },
    });
  });

  r.post("/admin-auth/logout", (_req, res) => {
    setNoStore(res);
    clearAdminCookie(res);

    return res.status(200).json({
      ok: true,
      loggedOut: true,
    });
  });

  r.post("/auth/logout", (_req, res) => {
    setNoStore(res);
    clearUserCookie(res);

    return res.status(200).json({
      ok: true,
      loggedOut: true,
    });
  });

  return r;
}