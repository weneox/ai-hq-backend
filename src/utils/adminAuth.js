import crypto from "crypto";
import { cfg } from "../config.js";

const memoryAttempts = new Map();

function s(v, d = "") {
  return String(v ?? d).trim();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function unbase64url(input) {
  const x = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = x.length % 4 === 0 ? "" : "=".repeat(4 - (x.length % 4));
  return Buffer.from(x + pad, "base64");
}

function safeEqBuffer(a, b) {
  const aa = Buffer.isBuffer(a) ? a : Buffer.from(a || "");
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b || "");
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function cookieDomain() {
  const isProd = s(cfg.APP_ENV).toLowerCase() === "production";
  if (!isProd) return undefined;

  const explicit = s(
    cfg.SESSION_COOKIE_DOMAIN ||
      cfg.COOKIE_DOMAIN ||
      cfg.USER_COOKIE_DOMAIN ||
      ""
  );
  if (explicit) return explicit;

  return ".hq.weneox.com";
}

export function getAdminCookieName() {
  return s(cfg.ADMIN_SESSION_COOKIE_NAME, "aihq_admin");
}

export function getUserCookieName() {
  return s(cfg.USER_SESSION_COOKIE_NAME, "aihq_user");
}

export function adminCookieOptions() {
  const isProd = s(cfg.APP_ENV).toLowerCase() === "production";
  const maxAgeMs =
    Math.max(1, Number(cfg.ADMIN_SESSION_TTL_HOURS || 12)) * 60 * 60 * 1000;

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    domain: cookieDomain(),
    maxAge: maxAgeMs,
  };
}

export function userCookieOptions() {
  const isProd = s(cfg.APP_ENV).toLowerCase() === "production";
  const maxAgeMs =
    Math.max(1, Number(cfg.USER_SESSION_TTL_HOURS || 24 * 7)) * 60 * 60 * 1000;

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    domain: cookieDomain(),
    maxAge: maxAgeMs,
  };
}

export function clearAdminCookie(res) {
  const isProd = s(cfg.APP_ENV).toLowerCase() === "production";
  res.clearCookie(getAdminCookieName(), {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    domain: cookieDomain(),
  });
}

export function clearUserCookie(res) {
  const isProd = s(cfg.APP_ENV).toLowerCase() === "production";
  res.clearCookie(getUserCookieName(), {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
    domain: cookieDomain(),
  });
}

export function parseCookies(req) {
  const raw = req?.headers?.cookie || "";
  const out = {};

  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i <= 0) return;

    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;

    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  });

  return out;
}

function getAdminSessionSecret() {
  return s(cfg.ADMIN_SESSION_SECRET);
}

function getUserSessionSecret() {
  return s(cfg.USER_SESSION_SECRET || cfg.ADMIN_SESSION_SECRET);
}

export function isAdminAuthConfigured() {
  return Boolean(
    cfg.ADMIN_PANEL_ENABLED &&
      s(cfg.ADMIN_PANEL_PASSCODE_HASH) &&
      s(cfg.ADMIN_SESSION_SECRET)
  );
}

export function isUserAuthConfigured() {
  return Boolean(s(getUserSessionSecret()));
}

export function createAdminSessionToken(meta = {}) {
  const secret = getAdminSessionSecret();
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not configured");
  }

  const iat = nowSec();
  const exp =
    iat + Math.max(1, Number(cfg.ADMIN_SESSION_TTL_HOURS || 12)) * 60 * 60;

  const payload = {
    typ: "admin_session",
    v: 1,
    iat,
    exp,
    nonce: crypto.randomBytes(16).toString("hex"),
    meta: {
      ip: s(meta.ip),
      ua: s(meta.ua).slice(0, 300),
    },
  };

  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();

  return `${payloadB64}.${base64url(sig)}`;
}

export function verifyAdminSessionToken(token) {
  try {
    const secret = getAdminSessionSecret();
    if (!secret) return { ok: false, error: "session secret missing" };

    const raw = s(token);
    if (!raw || !raw.includes(".")) {
      return { ok: false, error: "invalid token format" };
    }

    const [payloadB64, sigB64] = raw.split(".");
    if (!payloadB64 || !sigB64) {
      return { ok: false, error: "invalid token parts" };
    }

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payloadB64)
      .digest();

    const gotSig = unbase64url(sigB64);
    if (!safeEqBuffer(expectedSig, gotSig)) {
      return { ok: false, error: "bad signature" };
    }

    const payloadJson = unbase64url(payloadB64).toString("utf8");
    const payload = JSON.parse(payloadJson || "{}");

    if (payload?.typ !== "admin_session") {
      return { ok: false, error: "invalid token type" };
    }

    const now = nowSec();
    if (!Number.isFinite(payload?.exp) || now >= Number(payload.exp)) {
      return { ok: false, error: "token expired" };
    }

    if (!Number.isFinite(payload?.iat)) {
      return { ok: false, error: "invalid token iat" };
    }

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || "verify failed") };
  }
}

export function createUserSessionToken(user = {}, meta = {}) {
  const secret = getUserSessionSecret();
  if (!secret) {
    throw new Error("USER_SESSION_SECRET is not configured");
  }

  const iat = nowSec();
  const exp =
    iat + Math.max(1, Number(cfg.USER_SESSION_TTL_HOURS || 24 * 7)) * 60 * 60;

  const payload = {
    typ: "tenant_user_session",
    v: 1,
    iat,
    exp,
    nonce: crypto.randomBytes(16).toString("hex"),

    userId: s(user.id),
    tenantId: s(user.tenant_id || user.tenantId),
    tenantKey: s(user.tenant_key || user.tenantKey),
    email: s(user.user_email || user.email).toLowerCase(),
    fullName: s(user.full_name || user.fullName),
    role: s(user.role, "member"),
    sessionVersion: Number(user.session_version ?? user.sessionVersion ?? 1),

    meta: {
      ip: s(meta.ip),
      ua: s(meta.ua).slice(0, 300),
    },
  };

  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();

  return `${payloadB64}.${base64url(sig)}`;
}

export function verifyUserSessionToken(token) {
  try {
    const secret = getUserSessionSecret();
    if (!secret) return { ok: false, error: "session secret missing" };

    const raw = s(token);
    if (!raw || !raw.includes(".")) {
      return { ok: false, error: "invalid token format" };
    }

    const [payloadB64, sigB64] = raw.split(".");
    if (!payloadB64 || !sigB64) {
      return { ok: false, error: "invalid token parts" };
    }

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payloadB64)
      .digest();

    const gotSig = unbase64url(sigB64);
    if (!safeEqBuffer(expectedSig, gotSig)) {
      return { ok: false, error: "bad signature" };
    }

    const payloadJson = unbase64url(payloadB64).toString("utf8");
    const payload = JSON.parse(payloadJson || "{}");

    if (payload?.typ !== "tenant_user_session") {
      return { ok: false, error: "invalid token type" };
    }

    const now = nowSec();
    if (!Number.isFinite(payload?.exp) || now >= Number(payload.exp)) {
      return { ok: false, error: "token expired" };
    }

    if (!Number.isFinite(payload?.iat)) {
      return { ok: false, error: "invalid token iat" };
    }

    if (
      !payload?.userId ||
      !payload?.tenantId ||
      !payload?.tenantKey ||
      !payload?.email
    ) {
      return { ok: false, error: "invalid session payload" };
    }

    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || "verify failed") };
  }
}

export function verifyAdminPasscode(passcode) {
  try {
    const stored = s(cfg.ADMIN_PANEL_PASSCODE_HASH);
    const input = s(passcode);

    if (!stored || !input) return false;

    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== "s2") {
      return false;
    }

    const saltHex = parts[1];
    const hashHex = parts[2];

    const derived = crypto.scryptSync(input, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");

    return safeEqBuffer(derived, expected);
  } catch {
    return false;
  }
}

export function makeAdminPasscodeHash(passcode) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(passcode || ""), salt, 64);
  return `s2:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function hashUserPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password || ""), salt, 64);
  return `s2u:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyUserPassword(password, storedHash) {
  try {
    const input = s(password);
    const stored = s(storedHash);

    if (!input || !stored) return false;

    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== "s2u") {
      return false;
    }

    const saltHex = parts[1];
    const hashHex = parts[2];

    const derived = crypto.scryptSync(input, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");

    return safeEqBuffer(derived, expected);
  } catch {
    return false;
  }
}

function getClientIp(req) {
  const xfwd = s(req?.headers?.["x-forwarded-for"]);
  if (xfwd) return xfwd.split(",")[0].trim();
  return s(req?.ip) || s(req?.socket?.remoteAddress) || "unknown";
}

function attemptKey(req, type = "admin") {
  return `${type}:${getClientIp(req)}`;
}

export function checkAdminRateLimit(req) {
  const key = attemptKey(req, "admin");
  const now = Date.now();
  const windowMs = Number(cfg.ADMIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
  const max = Number(cfg.ADMIN_RATE_LIMIT_MAX_ATTEMPTS || 5);

  const rec = memoryAttempts.get(key) || {
    count: 0,
    resetAt: now + windowMs,
  };

  if (now > rec.resetAt) {
    const fresh = { count: 0, resetAt: now + windowMs };
    memoryAttempts.set(key, fresh);
    return {
      ok: true,
      remaining: max,
      resetAt: fresh.resetAt,
    };
  }

  if (rec.count >= max) {
    return {
      ok: false,
      remaining: 0,
      resetAt: rec.resetAt,
    };
  }

  return {
    ok: true,
    remaining: Math.max(0, max - rec.count),
    resetAt: rec.resetAt,
  };
}

export function registerAdminFailedAttempt(req) {
  const key = attemptKey(req, "admin");
  const now = Date.now();
  const windowMs = Number(cfg.ADMIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);

  const rec = memoryAttempts.get(key) || {
    count: 0,
    resetAt: now + windowMs,
  };

  if (now > rec.resetAt) {
    memoryAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  rec.count += 1;
  memoryAttempts.set(key, rec);
}

export function clearAdminFailedAttempts(req) {
  memoryAttempts.delete(attemptKey(req, "admin"));
}

export function readAdminSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[getAdminCookieName()] || "";
  return verifyAdminSessionToken(token);
}

export function readUserSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[getUserCookieName()] || "";
  return verifyUserSessionToken(token);
}

export function requireAdminSession(req, res, next) {
  if (!cfg.ADMIN_PANEL_ENABLED) {
    return res.status(403).json({
      ok: false,
      error: "Admin panel disabled",
    });
  }

  const session = readAdminSessionFromRequest(req);
  if (!session?.ok) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  req.adminSession = session.payload;
  return next();
}

export function requireUserSession(req, res, next) {
  const session = readUserSessionFromRequest(req);
  if (!session?.ok) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  req.adminSession = null;
  req.auth = {
    userId: session.payload.userId,
    tenantId: session.payload.tenantId,
    tenantKey: session.payload.tenantKey,
    email: session.payload.email,
    fullName: session.payload.fullName || "",
    role: session.payload.role || "member",
    sessionVersion: Number(session.payload.sessionVersion || 1),
  };

  return next();
}