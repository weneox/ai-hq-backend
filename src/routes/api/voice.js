import express from "express";
import {
  getTenantVoiceSettings,
  upsertTenantVoiceSettings,
  listVoiceCalls,
  getVoiceCallById,
  listVoiceCallEvents,
  getVoiceDailyUsage,
  listVoiceCallSessions,
  getVoiceCallSessionById,
  updateVoiceCallSession,
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
    defaultLanguage: s(body.defaultLanguage, "en"),
    supportedLanguages: Array.isArray(body.supportedLanguages)
      ? body.supportedLanguages.map((x) => s(x)).filter(Boolean)
      : ["en"],

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

function isLiveVoiceStatus(v) {
  const x = String(v || "").trim().toLowerCase();
  return ["live", "active", "in_progress", "ongoing", "ringing", "queued", "bridged"].includes(x);
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

  r.get("/voice/settings", async (req, res) => {
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
      console.error("[voice/settings-alias:get] error", err);
      return fail(res, 500, "voice_settings_read_failed");
    }
  });

  r.post("/voice/settings", async (req, res) => {
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
      console.error("[voice/settings-alias:post] error", err);
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

  r.get("/voice/overview", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          overview: {
            liveCalls: 0,
            totalCalls: 0,
            totalMinutes: 0,
            defaultLanguage: "en",
          },
          liveCalls: 0,
          totalCalls: 0,
          totalMinutes: 0,
          defaultLanguage: "en",
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const settings = await getTenantVoiceSettings(db, tenantId);
      const calls = await listVoiceCalls(db, {
        tenantId,
        status: s(req.query?.status),
        limit: Math.max(1, Math.min(200, n(req.query?.limit, 100))),
      });

      const liveCalls = calls.filter((x) =>
        isLiveVoiceStatus(x?.status || x?.callStatus || x?.call_status)
      ).length;

      const totalCalls = calls.length;
      const totalSeconds = calls.reduce(
        (sum, x) => sum + Number(x?.durationSec ?? x?.duration_sec ?? x?.duration ?? 0),
        0
      );
      const totalMinutes = Math.floor(totalSeconds / 60);
      const defaultLanguage = settings?.defaultLanguage || "en";

      return ok(res, {
        overview: {
          liveCalls,
          totalCalls,
          totalMinutes,
          defaultLanguage,
        },
        liveCalls,
        totalCalls,
        totalMinutes,
        defaultLanguage,
      });
    } catch (err) {
      console.error("[voice/overview] error", err);
      return fail(res, 500, "voice_overview_failed");
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

  r.get("/voice/calls/:id/events", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          events: [],
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const call = await getVoiceCallById(db, s(req.params?.id));
      if (!call) return fail(res, 404, "voice_call_not_found");
      if (s(call.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const events = await listVoiceCallEvents(db, call.id);

      return ok(res, {
        events,
      });
    } catch (err) {
      console.error("[voice/calls:events] error", err);
      return fail(res, 500, "voice_call_events_failed");
    }
  });

  r.get("/voice/calls/:id/sessions", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, {
          sessions: [],
          dbDisabled: true,
        });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const call = await getVoiceCallById(db, s(req.params?.id));
      if (!call) return fail(res, 404, "voice_call_not_found");
      if (s(call.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const allSessions = await listVoiceCallSessions(db, {
        tenantId,
        status: s(req.query?.status),
        limit: Math.max(1, Math.min(200, n(req.query?.limit, 100))),
      });

      const callId = s(call.id);
      const sessions = allSessions.filter((x) => {
        return (
          s(x?.callId) === callId ||
          s(x?.call_id) === callId ||
          s(x?.voiceCallId) === callId ||
          s(x?.voice_call_id) === callId
        );
      });

      return ok(res, {
        sessions,
      });
    } catch (err) {
      console.error("[voice/calls:sessions] error", err);
      return fail(res, 500, "voice_call_sessions_failed");
    }
  });

  r.post("/voice/calls/:id/join", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const callId = s(req.params?.id);
      const providedSessionId = s(req.body?.sessionId);

      const call = await getVoiceCallById(db, callId);
      if (!call) return fail(res, 404, "voice_call_not_found");
      if (s(call.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      let session = null;

      if (providedSessionId) {
        session = await getVoiceCallSessionById(db, providedSessionId);
        if (!session) return fail(res, 404, "voice_session_not_found");
        if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");
      } else {
        const allSessions = await listVoiceCallSessions(db, {
          tenantId,
          limit: 100,
        });

        session =
          allSessions.find((x) => s(x?.callId) === callId) ||
          allSessions.find((x) => s(x?.call_id) === callId) ||
          allSessions.find((x) => s(x?.voiceCallId) === callId) ||
          allSessions.find((x) => s(x?.voice_call_id) === callId) ||
          null;

        if (!session) return fail(res, 404, "voice_session_not_found");
      }

      const joinMode = s(req.body?.joinMode || req.body?.mode, "live").toLowerCase();
      const operatorName = s(req.body?.operatorName || actor);
      const operatorUserId =
        s(req.body?.operatorUserId) ||
        s(req.user?.id) ||
        s(req.user?.user_id) ||
        null;

      const normalizedJoinMode = ["live", "whisper", "monitor"].includes(joinMode)
        ? joinMode
        : "live";

      const updated = await updateVoiceCallSession(db, session.id, {
        status: normalizedJoinMode === "whisper" ? "agent_whisper" : "agent_live",
        operatorJoinRequested: true,
        operatorJoined: true,
        operatorJoinMode: normalizedJoinMode,
        operatorName,
        operatorUserId,
        operatorRequestedAt: new Date().toISOString(),
        operatorJoinedAt: new Date().toISOString(),
        whisperActive: normalizedJoinMode === "whisper",
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.joined_from_call_view",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: {
              joinMode: updated?.operatorJoinMode || normalizedJoinMode,
              callId,
            },
          });
        }
      } catch {}

      return ok(res, {
        session: updated,
      });
    } catch (err) {
      console.error("[voice/calls:join] error", err);
      return fail(res, 500, "voice_join_failed");
    }
  });

  r.post("/voice/calls/:id/end", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const callId = s(req.params?.id);
      const providedSessionId = s(req.body?.sessionId);

      const call = await getVoiceCallById(db, callId);
      if (!call) return fail(res, 404, "voice_call_not_found");
      if (s(call.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      let session = null;

      if (providedSessionId) {
        session = await getVoiceCallSessionById(db, providedSessionId);
        if (!session) return fail(res, 404, "voice_session_not_found");
        if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");
      } else {
        const allSessions = await listVoiceCallSessions(db, {
          tenantId,
          limit: 100,
        });

        session =
          allSessions.find((x) => s(x?.callId) === callId) ||
          allSessions.find((x) => s(x?.call_id) === callId) ||
          allSessions.find((x) => s(x?.voiceCallId) === callId) ||
          allSessions.find((x) => s(x?.voice_call_id) === callId) ||
          null;

        if (!session) return fail(res, 404, "voice_session_not_found");
      }

      const updated = await updateVoiceCallSession(db, session.id, {
        status: "completed",
        botActive: false,
        endedAt: new Date().toISOString(),
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.ended_from_call_view",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: { callId },
          });
        }
      } catch {}

      return ok(res, {
        session: updated,
      });
    } catch (err) {
      console.error("[voice/calls:end] error", err);
      return fail(res, 500, "voice_end_failed");
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

  r.get("/voice/live", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return ok(res, { sessions: [], dbDisabled: true });
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const sessions = await listVoiceCallSessions(db, {
        tenantId,
        status: s(req.query?.status),
        limit: Math.max(1, Math.min(200, n(req.query?.limit, 50))),
      });

      return ok(res, { sessions });
    } catch (err) {
      console.error("[voice/live:list] error", err);
      return fail(res, 500, "voice_live_list_failed");
    }
  });

  r.get("/voice/live/:id", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      if (!tenantId) return fail(res, 400, "tenant_required");

      const session = await getVoiceCallSessionById(db, s(req.params?.id));
      if (!session) return fail(res, 404, "voice_session_not_found");
      if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      return ok(res, { session });
    } catch (err) {
      console.error("[voice/live:get] error", err);
      return fail(res, 500, "voice_live_read_failed");
    }
  });

  r.post("/voice/live/:id/request-handoff", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const session = await getVoiceCallSessionById(db, s(req.params?.id));
      if (!session) return fail(res, 404, "voice_session_not_found");
      if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const joinMode = s(req.body?.joinMode || req.body?.mode, "live").toLowerCase();
      const operatorName = s(req.body?.operatorName || actor);
      const operatorUserId =
        s(req.body?.operatorUserId) ||
        s(req.user?.id) ||
        s(req.user?.user_id) ||
        null;

      const updated = await updateVoiceCallSession(db, session.id, {
        status: "handoff_requested",
        operatorJoinRequested: true,
        operatorJoinMode: ["live", "whisper", "monitor"].includes(joinMode)
          ? joinMode
          : "live",
        operatorName,
        operatorUserId,
        operatorRequestedAt: new Date().toISOString(),
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.handoff_requested",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: {
              joinMode: updated?.operatorJoinMode || joinMode,
              requestedDepartment: updated?.requestedDepartment || session.requestedDepartment,
            },
          });
        }
      } catch {}

      return ok(res, { session: updated });
    } catch (err) {
      console.error("[voice/live:request-handoff] error", err);
      return fail(res, 500, "voice_handoff_request_failed");
    }
  });

  r.post("/voice/live/:id/joined", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const session = await getVoiceCallSessionById(db, s(req.params?.id));
      if (!session) return fail(res, 404, "voice_session_not_found");
      if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const updated = await updateVoiceCallSession(db, session.id, {
        status: session.operatorJoinMode === "whisper" ? "agent_whisper" : "agent_live",
        operatorJoined: true,
        whisperActive: session.operatorJoinMode === "whisper",
        operatorJoinRequested: true,
        operatorJoinedAt: new Date().toISOString(),
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.operator_joined",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: {
              joinMode: updated?.operatorJoinMode || session.operatorJoinMode,
            },
          });
        }
      } catch {}

      return ok(res, { session: updated });
    } catch (err) {
      console.error("[voice/live:joined] error", err);
      return fail(res, 500, "voice_operator_join_failed");
    }
  });

  r.post("/voice/live/:id/takeover", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const session = await getVoiceCallSessionById(db, s(req.params?.id));
      if (!session) return fail(res, 404, "voice_session_not_found");
      if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const updated = await updateVoiceCallSession(db, session.id, {
        status: "agent_live",
        operatorJoined: true,
        takeoverActive: true,
        whisperActive: false,
        botActive: false,
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.takeover",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: {},
          });
        }
      } catch {}

      return ok(res, { session: updated });
    } catch (err) {
      console.error("[voice/live:takeover] error", err);
      return fail(res, 500, "voice_takeover_failed");
    }
  });

  r.post("/voice/live/:id/end", async (req, res) => {
    try {
      if (dbDisabled || !db) {
        return fail(res, 503, "db_unavailable");
      }

      const tenantId = getTenantId(req);
      const tenantKey = getTenantKey(req);
      const actor = getActor(req);

      if (!tenantId) return fail(res, 400, "tenant_required");

      const session = await getVoiceCallSessionById(db, s(req.params?.id));
      if (!session) return fail(res, 404, "voice_session_not_found");
      if (s(session.tenantId) !== s(tenantId)) return fail(res, 403, "forbidden");

      const updated = await updateVoiceCallSession(db, session.id, {
        status: "completed",
        botActive: false,
        endedAt: new Date().toISOString(),
      });

      try {
        if (audit?.log) {
          await audit.log({
            tenantId,
            tenantKey,
            actor,
            action: "voice.session.ended",
            objectType: "voice_call_session",
            objectId: session.id,
            meta: {},
          });
        }
      } catch {}

      return ok(res, { session: updated });
    } catch (err) {
      console.error("[voice/live:end] error", err);
      return fail(res, 500, "voice_end_failed");
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