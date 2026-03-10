import express from "express";
import {
  isAdminAuthConfigured,
  verifyAdminPasscode,
  createAdminSessionToken,
  adminCookieOptions,
  clearAdminCookie,
  checkAdminRateLimit,
  registerAdminFailedAttempt,
  clearAdminFailedAttempts,
  readAdminSessionFromRequest,
} from "../../utils/adminAuth.js";
import { cfg } from "../../config.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function getIp(req) {
  const xfwd = s(req?.headers?.["x-forwarded-for"]);
  if (xfwd) return xfwd.split(",")[0].trim();
  return s(req?.ip) || s(req?.socket?.remoteAddress) || "unknown";
}

export function adminAuthRoutes() {
  const r = express.Router();

  r.get("/admin-auth/me", (req, res) => {
    const session = readAdminSessionFromRequest(req);

    return res.status(200).json({
      ok: true,
      enabled: !!cfg.ADMIN_PANEL_ENABLED,
      configured: isAdminAuthConfigured(),
      authenticated: !!session?.ok,
      session: session?.ok
        ? {
            exp: session.payload?.exp || null,
            iat: session.payload?.iat || null,
          }
        : null,
    });
  });

  r.post("/admin-auth/login", (req, res) => {
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

    res.cookie(
      cfg.ADMIN_SESSION_COOKIE_NAME,
      token,
      adminCookieOptions()
    );

    return res.status(200).json({
      ok: true,
      authenticated: true,
    });
  });

  r.post("/admin-auth/logout", (req, res) => {
    clearAdminCookie(res);
    return res.status(200).json({
      ok: true,
      loggedOut: true,
    });
  });

  return r;
}