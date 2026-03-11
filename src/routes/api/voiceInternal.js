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

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeDepartmentMap(input) {
  const src = isObj(input) ? input : {};
  const out = {};

  for (const [rawKey, rawValue] of Object.entries(src)) {
    const key = s(rawKey).toLowerCase();
    if (!key) continue;

    const item = isObj(rawValue) ? rawValue : {};
    out[key] = {
      enabled: String(item.enabled ?? "true").trim() !== "false",
      label: s(item.label || key),
      phone: s(item.phone),
      callerId: s(item.callerId),
      fallbackDepartment: s(item.fallbackDepartment).toLowerCase(),
      keywords: toArray(item.keywords).map((x) => s(x)).filter(Boolean),
      businessHours: isObj(item.businessHours) ? item.businessHours : {},
      meta: isObj(item.meta) ? item.meta : {},
    };
  }

  return out;
}

function buildOperatorRouting(meta = {}, operator = {}, voiceProfile = {}) {
  const routing =
    isObj(operator.routing) ? operator.routing :
    isObj(meta.operatorRouting) ? meta.operatorRouting :
    isObj(meta.operator_routing) ? meta.operator_routing :
    {};

  const departments = normalizeDepartmentMap(
    routing.departments ||
      operator.departments ||
      operator.department ||
      meta.operatorDepartments ||
      meta.operator_departments ||
      {}
  );

  const defaultDepartment = s(
    routing.defaultDepartment ||
      operator.defaultDepartment ||
      meta.defaultOperatorDepartment ||
      meta.default_operator_department
  ).toLowerCase();

  const mode = s(
    routing.mode ||
      operator.mode ||
      voiceProfile.transferMode ||
      "manual"
  ).toLowerCase();

  return {
    mode: mode || "manual",
    defaultDepartment: defaultDepartment || "",
    departments,
  };
}

function buildVoiceConfigFromTenantRow(row, { tenantKey, toNumber }) {
  const meta = isObj(row?.meta) ? row.meta : {};
  const voice = isObj(meta.voice) ? meta.voice : {};
  const contact = isObj(meta.contact) ? meta.contact : {};
  const operator = isObj(meta.operator) ? meta.operator : {};
  const realtime = isObj(meta.realtime) ? meta.realtime : {};

  const voiceProfile =
    isObj(voice.voiceProfile)
      ? voice.voiceProfile
      : isObj(meta.voiceProfile)
      ? meta.voiceProfile
      : {};

  const resolvedTenantKey = s(row?.tenant_key || tenantKey || "default");
  const companyName = s(
    row?.company_name || voiceProfile.companyName || resolvedTenantKey || "Company"
  );
  const defaultLanguage = s(
    row?.default_language || voiceProfile.defaultLanguage || "en"
  ).toLowerCase();

  const operatorRouting = buildOperatorRouting(meta, operator, voiceProfile);

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
      website: s(contact.website || meta.website || ""),
    },
    operator: {
      phone: s(operator.phone || meta.operator_phone || ""),
      callerId: s(operator.callerId || meta.twilio_caller_id || ""),
      mode: s(operator.mode || "manual").toLowerCase(),
    },
    operatorRouting,
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
      tone: s(voiceProfile.tone || "professional"),
      answerStyle: s(voiceProfile.answerStyle || "short_clear"),
      askStyle: s(voiceProfile.askStyle || "single_question"),
      businessSummary: s(
        voiceProfile.businessSummary ||
          meta.business_summary ||
          "Help callers clearly and accurately using only the configured company information."
      ),
      allowedTopics: toArray(voiceProfile.allowedTopics),
      forbiddenTopics: toArray(voiceProfile.forbiddenTopics),
      leadCaptureMode: s(voiceProfile.leadCaptureMode || "none"),
      transferMode: s(voiceProfile.transferMode || operatorRouting.mode || "manual"),
      contactPolicy:
        isObj(voiceProfile.contactPolicy)
          ? voiceProfile.contactPolicy
          : {
              sharePhone: false,
              shareEmail: false,
              shareWebsite: false,
            },
      texts: isObj(voiceProfile.texts) ? voiceProfile.texts : {},
    },
  };
}

export function voiceInternalRoutes({ db }) {
  const r = express.Router();

  r.post("/internal/voice/tenant-config", requireInternalToken, async (req, res) => {
    try {
      const tenantKey = s(req.body?.tenantKey);
      const toNumber = s(req.body?.toNumber);

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

  r.post("/internal/voice/report", requireInternalToken, async (_req, res) => {
    try {
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