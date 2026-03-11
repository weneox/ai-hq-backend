import express from "express";
import crypto from "crypto";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function normalizePhone(v) {
  return s(v).replace(/[^\d+]/g, "");
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function readInternalToken(req) {
  const auth = s(req.headers.authorization);
  return (
    s(req.headers["x-internal-token"]) ||
    s(req.headers["x-webhook-token"]) ||
    auth.replace(/^Bearer\s+/i, "")
  );
}

function requireInternalToken(req, res, next) {
  const expected =
    s(process.env.AIHQ_INTERNAL_TOKEN) ||
    s(process.env.INTERNAL_API_TOKEN) ||
    s(process.env.N8N_WEBHOOK_TOKEN);

  if (!expected) {
    return res.status(500).json({
      ok: false,
      error: "internal_token_not_configured",
    });
  }

  const got = readInternalToken(req);

  if (!got || !safeEq(got, expected)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized_internal",
    });
  }

  return next();
}

async function findTenantByKeyOrPhone(db, { tenantKey, toNumber }) {
  const key = s(tenantKey).toLowerCase();
  const to = normalizePhone(toNumber);

  if (!db?.query) return null;

  if (key) {
    const q = await db.query(
      `
      select
        id,
        tenant_key,
        company_name,
        timezone,
        default_language,
        meta,
        inbox_policy
      from tenants
      where lower(tenant_key) = lower($1)
      limit 1
      `,
      [key]
    );

    if (q.rows?.[0]) return q.rows[0];
  }

  if (to) {
    const q = await db.query(
      `
      select
        id,
        tenant_key,
        company_name,
        timezone,
        default_language,
        meta,
        inbox_policy
      from tenants
      where
        regexp_replace(coalesce(meta->>'twilio_phone',''), '[^0-9+]', '', 'g') = $1
        or regexp_replace(coalesce(meta->>'phone',''), '[^0-9+]', '', 'g') = $1
      limit 1
      `,
      [to]
    );

    if (q.rows?.[0]) return q.rows[0];
  }

  return null;
}

function buildVoiceConfigFromTenantRow(row, { tenantKey, toNumber }) {
  const meta = row?.meta && typeof row.meta === "object" ? row.meta : {};
  const voice = meta.voice && typeof meta.voice === "object" ? meta.voice : {};
  const contact = meta.contact && typeof meta.contact === "object" ? meta.contact : {};
  const operator = meta.operator && typeof meta.operator === "object" ? meta.operator : {};
  const realtime = meta.realtime && typeof meta.realtime === "object" ? meta.realtime : {};

  const voiceProfile =
    voice.voiceProfile && typeof voice.voiceProfile === "object"
      ? voice.voiceProfile
      : meta.voiceProfile && typeof meta.voiceProfile === "object"
      ? meta.voiceProfile
      : {};

  const resolvedTenantKey = s(row?.tenant_key || tenantKey || "default");
  const companyName = s(
    row?.company_name || voiceProfile.companyName || resolvedTenantKey || "Company"
  );
  const defaultLanguage = s(
    row?.default_language || voiceProfile.defaultLanguage || "az"
  ).toLowerCase();

  return {
    ok: true,
    tenantKey: resolvedTenantKey,
    companyName,
    defaultLanguage,
    match: {
      tenantKey: s(tenantKey),
      toNumber: s(toNumber),
    },
    contact: {
      phoneLocal: s(contact.phoneLocal || meta.phone_local || ""),
      phoneIntl: s(contact.phoneIntl || meta.phone_intl || meta.phone || ""),
      emailLocal: s(contact.emailLocal || meta.email_local || ""),
      emailIntl: s(contact.emailIntl || meta.email_intl || meta.email || ""),
    },
    operator: {
      phone: s(operator.phone || meta.operator_phone || ""),
      callerId: s(operator.callerId || meta.twilio_caller_id || ""),
    },
    realtime: {
      model: s(realtime.model || voice.realtimeModel || "gpt-4o-realtime-preview"),
      voice: s(realtime.voice || voice.realtimeVoice || "alloy"),
      instructions: s(realtime.instructions || ""),
    },
    voiceProfile: {
      companyName,
      assistantName: s(voiceProfile.assistantName || "Virtual Assistant"),
      roleLabel: s(voiceProfile.roleLabel || "virtual assistant"),
      defaultLanguage,
      purpose: s(voiceProfile.purpose || "general"),
      tone: s(voiceProfile.tone || "warm_professional"),
      answerStyle: s(voiceProfile.answerStyle || "short_clear"),
      askStyle: s(voiceProfile.askStyle || "single_question"),
      businessSummary: s(
        voiceProfile.businessSummary ||
          meta.business_summary ||
          `${companyName} üçün gələn zənglərdə istifadəçiyə qısa və düzgün kömək et.`
      ),
      allowedTopics: Array.isArray(voiceProfile.allowedTopics)
        ? voiceProfile.allowedTopics
        : [],
      forbiddenTopics: Array.isArray(voiceProfile.forbiddenTopics)
        ? voiceProfile.forbiddenTopics
        : [],
      leadCaptureMode: s(voiceProfile.leadCaptureMode || "name_phone"),
      transferMode: s(voiceProfile.transferMode || "operator"),
      contactPolicy:
        voiceProfile.contactPolicy && typeof voiceProfile.contactPolicy === "object"
          ? voiceProfile.contactPolicy
          : {
              sharePhone: true,
              shareEmail: true,
              shareWebsite: false,
            },
      texts:
        voiceProfile.texts && typeof voiceProfile.texts === "object"
          ? voiceProfile.texts
          : {},
    },
  };
}

export function voiceInternalRoutes({ db }) {
  const r = express.Router();

  r.post("/internal/voice/tenant-config", requireInternalToken, async (req, res) => {
    try {
      const tenantKey = s(req.body?.tenantKey);
      const toNumber = s(req.body?.toNumber);

      console.log("[voiceInternal] tenant-config request", {
        tenantKey,
        toNumber,
        hasToken: !!readInternalToken(req),
      });

      const tenant = await findTenantByKeyOrPhone(db, { tenantKey, toNumber });

      if (!tenant) {
        return res.status(404).json({
          ok: false,
          error: "tenant_not_found",
          tenantKey,
          toNumber,
        });
      }

      const payload = buildVoiceConfigFromTenantRow(tenant, { tenantKey, toNumber });
      return res.status(200).json(payload);
    } catch (err) {
      console.error("[voiceInternal/tenant-config] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_tenant_config_failed",
      });
    }
  });

  r.post("/internal/voice/report", requireInternalToken, async (req, res) => {
    try {
      console.log("[voiceInternal] report request", {
        tenantKey: s(req.body?.tenantKey),
        hasToken: !!readInternalToken(req),
      });

      return res.status(200).json({
        ok: true,
        accepted: true,
      });
    } catch (err) {
      console.error("[voiceInternal/report] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_report_failed",
      });
    }
  });

  return r;
}