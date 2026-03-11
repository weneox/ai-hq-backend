import express from "express";
import {
  getTenantVoiceSettings,
  upsertTenantVoiceSettings,
  listVoiceCalls,
  getVoiceCallById,
  listVoiceCallEvents,
  getVoiceDailyUsage,
} from "../../db/helpers/voice.js";

function s(v, d = "") {
  return String(v ?? d).trim();
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function b(v, d = false) {
  if (typeof v === "boolean") return v;
  const x = String(v ?? "").trim().toLowerCase();
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function getActor(req) {
  return (
    s(req.user?.email) ||
    s(req.user?.user_email) ||
    s(req.session?.user?.email) ||
    s(req.auth?.email) ||
    "unknown"
  );
}

function getTenantId(req) {
  return (
    s(req.user?.tenantId) ||
    s(req.user?.tenant_id) ||
    s(req.session?.tenantId) ||
    s(req.session?.tenant_id) ||
    s(req.tenant?.id) ||
    s(req.tenantId)
  );
}

function getTenantKey(req) {
  return (
    s(req.user?.tenantKey) ||
    s(req.user?.tenant_key) ||
    s(req.session?.tenantKey) ||
    s(req.session?.tenant_key) ||
    s(req.tenant?.tenant_key) ||
    s(req.tenant?.key) ||
    s(req.tenantKey)
  );
}

function normalizeSettingsInput(body = {}) {
  return {
    enabled: b(body.enabled, false),
    provider: s(body.provider, "twilio"),
    mode: s(body.mode, "assistant"),

    displayName: s(body.displayName),
    defaultLanguage: s(body.defaultLanguage, "az"),
    supportedLanguages: Array.isArray(body.supportedLanguages)
      ? body.supportedLanguages.map((x) => s(x)).filter(Boolean)
      : ["az"],

    greeting: isObj(body.greeting) ? body.greeting : {},
    fallbackGreeting: isObj(body.fallbackGreeting) ? body.fallbackGreeting : {},
    businessContext: s(body.businessContext),
    instructions: s(body.instructions),

    businessHoursEnabled: b(body.businessHoursEnabled, false),
    businessHours: isObj(body.businessHours) ? body.businessHours : {},

    operatorEnabled: b(body.operatorEnabled, true),
    operatorPhone: s(body.operatorPhone),
    operatorLabel: s(body.operatorLabel),
    transferStrategy: s(body.transferStrategy, "handoff"),

    callbackEnabled: b(body.callbackEnabled, true),
    callbackMode: s(body.callbackMode, "lead_only"),

    maxCallSeconds: Math.max(15, Math.min(3600, n(body.maxCallSeconds, 180))),
    silenceHangupSeconds: Math.max(3, Math.min(120, n(body.silenceHangupSeconds, 12))),

    captureRules: isObj(body.captureRules) ? body.captureRules : {},
    leadRules: isObj(body.leadRules) ? body.leadRules : {},
    escalationRules: isObj(body.escalationRules) ? body.escalationRules : {},
    reportingRules: isObj(body.reportingRules) ? body.reportingRules : {},

    twilioPhoneNumber: s(body.twilioPhoneNumber),
    twilioPhoneSid: s(body.twilioPhoneSid),
    twilioConfig: isObj(body.twilioConfig) ? body.twilioConfig : {},

    costControl: isObj(body.costControl) ? body.costControl : {},
    meta: isObj(body.meta) ? body.meta : {},
  };
}

export function voiceRoutes({ db, dbDisabled = false, audit } = {}) {
  const r = express.Router();

  r.get("/settings/voice", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          settings: null,
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const settings = await getTenantVoiceSettings(db, tenantId);

      return ok(res, {
        settings,
      });
    } catch (err) {
      console.error("[voice/settings:get] error", err);
      return fail(res, 500, "voice_settings_read_failed");
    }
  });

  r.post("/settings/voice", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const input = normalizeSettingsInput(req.body || {});
      const settings = await upsertTenantVoiceSettings(db, tenantId, input);

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.settings.updated",
            objectType: "tenant_voice_settings",
            objectId: tenantId,
            meta: {
              enabled: settings?.enabled ?? input.enabled,
              provider: settings?.provider ?? input.provider,
              mode: settings?.mode ?? input.mode,
            },
          });
        }
      } catch {}

      return ok(res, {
        settings,
      });
    } catch (err) {
      console.error("[voice/settings:post] error", err);
      return fail(res, 500, "voice_settings_save_failed");
    }
  });

  r.post("/voice/toggle", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const current = await getTenantVoiceSettings(db, tenantId);
      const enabled = b(req.body?.enabled, !current?.enabled);

      const settings = await upsertTenantVoiceSettings(db, tenantId, {
        ...(current || {}),
        enabled,
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: enabled ? "voice.enabled" : "voice.disabled",
            objectType: "tenant_voice_settings",
            objectId: tenantId,
            meta: { enabled },
          });
        }
      } catch {}

      return ok(res, {
        settings,
      });
    } catch (err) {
      console.error("[voice/toggle] error", err);
      return fail(res, 500, "voice_toggle_failed");
    }
  });

  r.get("/voice/calls", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          calls: [],
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const calls = await listVoiceCalls(db, {
        tenantId,
        status: s(req.query?.status),
        limit: Math.max(1, Math.min(200, n(req.query?.limit, 50))),
      });

      return ok(res, {
        calls,
      });
    } catch (err) {
      console.error("[voice/calls:list] error", err);
      return fail(res, 500, "voice_calls_list_failed");
    }
  });

  r.get("/voice/calls/:id", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const call = await getVoiceCallById(db, s(req.params?.id));
      if (!call) return fail(res, 404, "voice_call_not_found");

      if (s(call.tenantId) !== s(tenantId)) {
        return fail(res, 403, "forbidden");
      }

      const events = await listVoiceCallEvents(db, call.id);

      return ok(res, {
        call,
        events,
      });
    } catch (err) {
      console.error("[voice/calls:get] error", err);
      return fail(res, 500, "voice_call_read_failed");
    }
  });

  r.get("/voice/usage", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          usage: [],
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const usage = await getVoiceDailyUsage(
        db,
        tenantId,
        Math.max(1, Math.min(365, n(req.query?.limit, 30)))
      );

      return ok(res, {
        usage,
      });
    } catch (err) {
      console.error("[voice/usage] error", err);
      return fail(res, 500, "voice_usage_read_failed");
    }
  });

  r.post("/voice/test", async (req, res) => {
    try {
      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      let settings = null;
      if (!dbDisabled && db) {
        settings = await getTenantVoiceSettings(db, tenantId);
      }

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.test.requested",
            objectType: "voice_test",
            objectId: tenantId,
            meta: {
              hasSettings: !!settings,
              provider: settings?.provider || "twilio",
            },
          });
        }
      } catch {}

      return ok(res, {
        message: "voice_test_ready",
        settings,
      });
    } catch (err) {
      console.error("[voice/test] error", err);
      return fail(res, 500, "voice_test_failed");
    }
  });

  return r;
}