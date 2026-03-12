// src/routes/api/channelConnect.js

import express from "express";
import crypto from "crypto";

import { cfg } from "../../config.js";
import { requireUserSession } from "../../utils/adminAuth.js";
import { dbGetTenantByKey, dbUpsertTenantChannel } from "../../db/helpers/settings.js";
import {
  dbUpsertTenantSecret,
  dbDeleteTenantSecret,
  dbGetTenantProviderSecrets,
} from "../../db/helpers/tenantSecrets.js";
import { dbAudit } from "../../db/helpers/audit.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function lower(v, d = "") {
  return s(v, d).toLowerCase();
}

function cleanNullable(v) {
  const x = s(v);
  return x || null;
}

function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

function bad(res, error, extra = {}) {
  return res.status(400).json({ ok: false, error, ...extra });
}

function unauth(res, error = "Unauthorized", extra = {}) {
  return res.status(401).json({ ok: false, error, ...extra });
}

function serverErr(res, error, extra = {}) {
  return res.status(500).json({ ok: false, error, ...extra });
}

function stateSecret() {
  return s(
    cfg.USER_SESSION_SECRET || cfg.ADMIN_SESSION_SECRET || cfg.META_APP_SECRET,
    ""
  );
}

function signState(payload) {
  const json = JSON.stringify(payload || {});
  const body = Buffer.from(json, "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(raw) {
  try {
    const token = s(raw);
    if (!token || !token.includes(".")) return null;

    const [body, sig] = token.split(".");
    if (!body || !sig) return null;

    const expected = crypto
      .createHmac("sha256", stateSecret())
      .update(body)
      .digest("base64url");

    if (expected !== sig) return null;

    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;

    const now = Date.now();
    const exp = Number(parsed.exp || 0);
    if (!Number.isFinite(exp) || now > exp) return null;

    return parsed;
  } catch {
    return null;
  }
}

function redirectBase() {
  const x = s(cfg.CHANNELS_RETURN_URL);
  if (x) return x;

  const firstCors = s(cfg.CORS_ORIGIN)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)[0];

  return firstCors || "";
}

function buildRedirectUrl(params = {}) {
  const base = redirectBase();
  if (!base) return "";

  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function metaGraphBase() {
  return `https://graph.facebook.com/${s(cfg.META_API_VERSION, "v23.0")}`;
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = await readJsonSafe(res);

  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

async function exchangeCodeForUserToken(code) {
  const url = new URL("https://graph.facebook.com/oauth/access_token");
  url.searchParams.set("client_id", s(cfg.META_APP_ID));
  url.searchParams.set("client_secret", s(cfg.META_APP_SECRET));
  url.searchParams.set("redirect_uri", s(cfg.META_REDIRECT_URI));
  url.searchParams.set("code", s(code));
  return fetchJson(url.toString());
}

async function getPagesForUserToken(userAccessToken) {
  const url = new URL(`${metaGraphBase()}/me/accounts`);
  url.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}"
  );
  url.searchParams.set("access_token", s(userAccessToken));

  const json = await fetchJson(url.toString());
  return Array.isArray(json?.data) ? json.data : [];
}

function pickBestInstagramPage(pages = []) {
  for (const page of pages) {
    const ig =
      page?.instagram_business_account ||
      page?.connected_instagram_account ||
      null;

    if (page?.id && ig?.id && page?.access_token) {
      return {
        pageId: s(page.id),
        pageName: s(page.name),
        pageAccessToken: s(page.access_token),
        igUserId: s(ig.id),
        igUsername: s(ig.username),
      };
    }
  }

  return null;
}

async function auditSafe(db, actor, tenant, action, objectType, objectId, meta = {}) {
  try {
    await dbAudit(
      db,
      s(actor, "system"),
      action,
      objectType,
      objectId,
      {
        tenantId: tenant?.id || null,
        tenantKey: tenant?.tenant_key || null,
        ...meta,
      }
    );
  } catch {}
}

function getReqTenantKey(req) {
  return lower(req?.auth?.tenantKey || "");
}

function getReqActor(req) {
  return s(req?.auth?.email || req?.auth?.userId || "system");
}

export function channelConnectRoutes({ db }) {
  const r = express.Router();

  r.get("/channels/meta/connect", requireUserSession, async (req, res) => {
    try {
      const tenantKey = getReqTenantKey(req);
      if (!tenantKey) return unauth(res, "Missing tenant context");

      if (!s(cfg.META_APP_ID) || !s(cfg.META_APP_SECRET) || !s(cfg.META_REDIRECT_URI)) {
        return bad(res, "Meta OAuth env missing");
      }

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) return bad(res, "Tenant not found");

      const state = signState({
        tenantKey,
        actor: getReqActor(req),
        exp: Date.now() + 10 * 60 * 1000,
      });

      const url = new URL("https://www.facebook.com/v23.0/dialog/oauth");
      url.searchParams.set("client_id", s(cfg.META_APP_ID));
      url.searchParams.set("redirect_uri", s(cfg.META_REDIRECT_URI));
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set(
        "scope",
        [
          "pages_show_list",
          "instagram_basic",
          "instagram_manage_messages",
          "business_management",
        ].join(",")
      );

      return res.redirect(url.toString());
    } catch (err) {
      return serverErr(res, err?.message || "Failed to start Meta connect");
    }
  });

  r.get("/channels/meta/callback", async (req, res) => {
    try {
      const code = s(req.query.code);
      const error = s(req.query.error);
      const errorCode = s(req.query.error_code);
      const errorMessage = s(req.query.error_message);
      const stateRaw = s(req.query.state);

      if (error || errorCode || errorMessage) {
        const redirectUrl = buildRedirectUrl({
          section: "channels",
          meta_error: errorMessage || error || "Meta connect failed",
        });

        if (redirectUrl) return res.redirect(redirectUrl);
        return bad(res, errorMessage || error || "Meta connect failed");
      }

      const state = verifyState(stateRaw);
      if (!state?.tenantKey) return bad(res, "Invalid connect state");
      if (!code) return bad(res, "Missing code");

      const tenant = await dbGetTenantByKey(db, state.tenantKey);
      if (!tenant?.id) return bad(res, "Tenant not found");

      const tokenJson = await exchangeCodeForUserToken(code);
      const userAccessToken = s(tokenJson?.access_token);
      if (!userAccessToken) {
        throw new Error("Meta user access token missing");
      }

      const pages = await getPagesForUserToken(userAccessToken);
      const selected = pickBestInstagramPage(pages);

      if (!selected?.pageAccessToken || !selected?.pageId || !selected?.igUserId) {
        throw new Error("No Instagram Business page found on connected Meta account");
      }

      await dbUpsertTenantSecret(
        db,
        tenant.id,
        "meta",
        "page_access_token",
        selected.pageAccessToken,
        state.actor || "system"
      );

      await dbUpsertTenantChannel(db, tenant.id, "instagram", {
        provider: "meta",
        display_name: selected.igUsername
          ? `Instagram · @${selected.igUsername}`
          : selected.pageName || "Instagram",
        external_page_id: selected.pageId,
        external_user_id: selected.igUserId,
        external_username: cleanNullable(selected.igUsername),
        status: "connected",
        is_primary: true,
        config: {
          connected_via: "oauth",
        },
        secrets_ref: "meta",
        health: {
          oauth_connected: true,
        },
        last_sync_at: new Date().toISOString(),
      });

      await auditSafe(
        db,
        state.actor || "system",
        tenant,
        "settings.channel.meta.connected",
        "tenant_channel",
        "instagram",
        {
          pageId: selected.pageId,
          igUserId: selected.igUserId,
          igUsername: selected.igUsername || null,
        }
      );

      const redirectUrl = buildRedirectUrl({
        section: "channels",
        meta_connected: "1",
        channel: "instagram",
      });

      if (redirectUrl) return res.redirect(redirectUrl);

      return ok(res, {
        connected: true,
        channel: "instagram",
        pageId: selected.pageId,
        igUserId: selected.igUserId,
        igUsername: selected.igUsername || null,
      });
    } catch (err) {
      const redirectUrl = buildRedirectUrl({
        section: "channels",
        meta_error: s(err?.message || "Meta callback failed"),
      });

      if (redirectUrl) return res.redirect(redirectUrl);

      return serverErr(res, err?.message || "Failed to complete Meta connect");
    }
  });

  r.get("/channels/meta/status", requireUserSession, async (req, res) => {
    try {
      const tenantKey = getReqTenantKey(req);
      if (!tenantKey) return unauth(res, "Missing tenant context");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) return bad(res, "Tenant not found");

      const q = await db.query(
        `
          select *
          from tenant_channels
          where tenant_id = $1
            and channel_type = 'instagram'
          order by is_primary desc, updated_at desc
          limit 1
        `,
        [tenant.id]
      );

      const channel = q?.rows?.[0] || null;
      const secrets = await dbGetTenantProviderSecrets(db, tenant.id, "meta");
      const hasToken = Boolean(s(secrets?.page_access_token));

      return ok(res, {
        connected:
          Boolean(channel) &&
          lower(channel?.status) === "connected" &&
          hasToken,
        channel: channel
          ? {
              id: channel.id,
              channel_type: channel.channel_type,
              provider: channel.provider,
              display_name: channel.display_name,
              external_page_id: channel.external_page_id,
              external_user_id: channel.external_user_id,
              external_username: channel.external_username,
              status: channel.status,
              is_primary: channel.is_primary,
              last_sync_at: channel.last_sync_at,
            }
          : null,
        hasToken,
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to load Meta status");
    }
  });

  r.post("/channels/meta/disconnect", requireUserSession, async (req, res) => {
    try {
      const tenantKey = getReqTenantKey(req);
      if (!tenantKey) return unauth(res, "Missing tenant context");

      const tenant = await dbGetTenantByKey(db, tenantKey);
      if (!tenant?.id) return bad(res, "Tenant not found");

      await dbDeleteTenantSecret(db, tenant.id, "meta", "page_access_token");

      await db.query(
        `
          update tenant_channels
          set
            status = 'disconnected',
            display_name = 'Instagram',
            external_page_id = null,
            external_user_id = null,
            external_username = null,
            secrets_ref = null,
            health = '{}'::jsonb,
            last_sync_at = null
          where tenant_id = $1
            and channel_type = 'instagram'
        `,
        [tenant.id]
      );

      await auditSafe(
        db,
        getReqActor(req),
        tenant,
        "settings.channel.meta.disconnected",
        "tenant_channel",
        "instagram"
      );

      return ok(res, {
        disconnected: true,
        channel: "instagram",
      });
    } catch (err) {
      return serverErr(res, err?.message || "Failed to disconnect Meta");
    }
  });

  return r;
}