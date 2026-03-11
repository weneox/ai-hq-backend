import express from "express";
import crypto from "crypto";
import {
  getVoiceCallByProviderSid,
  createVoiceCall,
  updateVoiceCall,
  appendVoiceCallEvent,
  getVoiceCallSessionByProviderCallSid,
  createVoiceCallSession,
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

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
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
    tenantId: s(row?.id),
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

function buildConferenceName({ tenantKey, providerCallSid }) {
  return `${s(tenantKey, "default")}:${s(providerCallSid, "call")}`;
}

function normalizeTranscriptItem(input = {}) {
  return {
    ts: s(input.ts || new Date().toISOString()),
    role: s(input.role || "customer"),
    text: s(input.text),
  };
}

async function upsertCallAndSession(db, body = {}) {
  const providerCallSid = s(body.providerCallSid || body.callSid);
  if (!providerCallSid) {
    throw new Error("provider_call_sid_required");
  }

  let call = await getVoiceCallByProviderSid(db, providerCallSid);

  if (!call) {
    call = await createVoiceCall(db, {
      tenantId: s(body.tenantId) || null,
      tenantKey: s(body.tenantKey),
      provider: s(body.provider, "twilio"),
      providerCallSid,
      providerStreamSid: s(body.providerStreamSid || body.streamSid) || null,
      direction: s(body.direction, "outbound"),
      status: s(body.callStatus || body.status || "in_progress"),
      fromNumber: s(body.fromNumber || body.from) || null,
      toNumber: s(body.toNumber || body.to) || null,
      callerName: s(body.customerName || body.callerName) || null,
      startedAt: body.startedAt || new Date().toISOString(),
      language: s(body.language, "en"),
      agentMode: s(body.agentMode, "assistant"),
      handoffRequested: b(body.handoffRequested, false),
      handoffCompleted: b(body.handoffCompleted, false),
      handoffTarget: s(body.handoffTarget) || null,
      callbackRequested: b(body.callbackRequested, false),
      callbackPhone: s(body.callbackPhone) || null,
      leadId: s(body.leadId) || null,
      inboxThreadId: s(body.inboxThreadId) || null,
      transcript: s(body.transcript),
      summary: s(body.summary),
      outcome: s(body.outcome, "unknown"),
      intent: s(body.intent) || null,
      sentiment: s(body.sentiment) || null,
      metrics: isObj(body.metrics) ? body.metrics : {},
      extraction: isObj(body.extraction) ? body.extraction : {},
      meta: isObj(body.meta) ? body.meta : {},
    });
  } else {
    call = await updateVoiceCall(db, call.id, {
      tenantId: s(body.tenantId) || call.tenantId || null,
      tenantKey: s(body.tenantKey || call.tenantKey),
      providerStreamSid: s(body.providerStreamSid || body.streamSid) || call.providerStreamSid || null,
      status: s(body.callStatus || body.status || call.status),
      fromNumber: s(body.fromNumber || body.from || call.fromNumber) || null,
      toNumber: s(body.toNumber || body.to || call.toNumber) || null,
      callerName: s(body.customerName || body.callerName || call.callerName) || null,
      answeredAt: body.answeredAt || call.answeredAt || null,
      endedAt: body.endedAt || call.endedAt || null,
      durationSeconds: n(body.durationSeconds, call.durationSeconds || 0),
      language: s(body.language || call.language, "en"),
      agentMode: s(body.agentMode || call.agentMode, "assistant"),
      handoffRequested: b(
        body.handoffRequested,
        call.handoffRequested
      ),
      handoffCompleted: b(
        body.handoffCompleted,
        call.handoffCompleted
      ),
      handoffTarget: s(body.handoffTarget || call.handoffTarget) || null,
      callbackRequested: b(
        body.callbackRequested,
        call.callbackRequested
      ),
      callbackPhone: s(body.callbackPhone || call.callbackPhone) || null,
      leadId: s(body.leadId || call.leadId) || null,
      inboxThreadId: s(body.inboxThreadId || call.inboxThreadId) || null,
      transcript: s(body.transcript || call.transcript),
      summary: s(body.summary || call.summary),
      outcome: s(body.outcome || call.outcome, "unknown"),
      intent: s(body.intent || call.intent) || null,
      sentiment: s(body.sentiment || call.sentiment) || null,
      metrics: isObj(body.metrics) ? body.metrics : call.metrics,
      extraction: isObj(body.extraction) ? body.extraction : call.extraction,
      meta: isObj(body.meta) ? body.meta : call.meta,
    });
  }

  let session = await getVoiceCallSessionByProviderCallSid(db, providerCallSid);

  if (!session) {
    session = await createVoiceCallSession(db, {
      tenantId: s(body.tenantId) || null,
      tenantKey: s(body.tenantKey),
      voiceCallId: call.id,
      provider: s(body.provider, "twilio"),
      providerCallSid,
      providerConferenceSid: s(body.providerConferenceSid || body.conferenceSid) || null,
      conferenceName:
        s(body.conferenceName) || buildConferenceName({ tenantKey: body.tenantKey, providerCallSid }),
      customerNumber: s(body.customerNumber || body.fromNumber || body.from) || null,
      customerName: s(body.customerName || body.callerName) || null,
      direction: s(body.sessionDirection || "outbound_callback"),
      status: s(body.sessionStatus || "bot_active"),
      requestedDepartment: s(body.requestedDepartment) || null,
      resolvedDepartment: s(body.resolvedDepartment) || null,
      operatorUserId: s(body.operatorUserId) || null,
      operatorName: s(body.operatorName) || null,
      operatorJoinMode: s(body.operatorJoinMode || "live"),
      botActive: b(body.botActive, true),
      operatorJoinRequested: b(body.operatorJoinRequested, false),
      operatorJoined: b(body.operatorJoined, false),
      whisperActive: b(body.whisperActive, false),
      takeoverActive: b(body.takeoverActive, false),
      leadPayload: isObj(body.leadPayload) ? body.leadPayload : {},
      transcriptLive: Array.isArray(body.transcriptLive) ? body.transcriptLive : [],
      summary: s(body.summary),
      meta: isObj(body.sessionMeta) ? body.sessionMeta : {},
      startedAt: body.startedAt || new Date().toISOString(),
      operatorRequestedAt: body.operatorRequestedAt || null,
      operatorJoinedAt: body.operatorJoinedAt || null,
      endedAt: body.endedAt || null,
    });
  } else {
    session = await updateVoiceCallSession(db, session.id, {
      tenantId: s(body.tenantId) || session.tenantId || null,
      tenantKey: s(body.tenantKey || session.tenantKey),
      voiceCallId: call.id,
      providerConferenceSid:
        s(body.providerConferenceSid || body.conferenceSid || session.providerConferenceSid) || null,
      conferenceName:
        s(body.conferenceName || session.conferenceName) ||
        buildConferenceName({ tenantKey: body.tenantKey || session.tenantKey, providerCallSid }),
      customerNumber:
        s(body.customerNumber || body.fromNumber || body.from || session.customerNumber) || null,
      customerName: s(body.customerName || body.callerName || session.customerName) || null,
      direction: s(body.sessionDirection || session.direction || "outbound_callback"),
      status: s(body.sessionStatus || session.status || "bot_active"),
      requestedDepartment: s(body.requestedDepartment || session.requestedDepartment) || null,
      resolvedDepartment: s(body.resolvedDepartment || session.resolvedDepartment) || null,
      operatorUserId: s(body.operatorUserId || session.operatorUserId) || null,
      operatorName: s(body.operatorName || session.operatorName) || null,
      operatorJoinMode: s(body.operatorJoinMode || session.operatorJoinMode || "live"),
      botActive: b(body.botActive, session.botActive),
      operatorJoinRequested: b(body.operatorJoinRequested, session.operatorJoinRequested),
      operatorJoined: b(body.operatorJoined, session.operatorJoined),
      whisperActive: b(body.whisperActive, session.whisperActive),
      takeoverActive: b(body.takeoverActive, session.takeoverActive),
      leadPayload: isObj(body.leadPayload) ? body.leadPayload : session.leadPayload,
      transcriptLive: Array.isArray(body.transcriptLive) ? body.transcriptLive : session.transcriptLive,
      summary: s(body.summary || session.summary),
      meta: isObj(body.sessionMeta) ? body.sessionMeta : session.meta,
      operatorRequestedAt: body.operatorRequestedAt || session.operatorRequestedAt || null,
      operatorJoinedAt: body.operatorJoinedAt || session.operatorJoinedAt || null,
      endedAt: body.endedAt || session.endedAt || null,
    });
  }

  return { call, session };
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

  r.post("/internal/voice/session/upsert", requireInternalToken, async (req, res) => {
    try {
      if (!db?.query) {
        return res.status(503).json({
          ok: false,
          error: "db_unavailable",
        });
      }

      const body = isObj(req.body) ? req.body : {};
      const tenantKey = s(body.tenantKey);
      const providerCallSid = s(body.providerCallSid || body.callSid);

      if (!tenantKey) {
        return res.status(400).json({
          ok: false,
          error: "tenant_key_required",
        });
      }

      if (!providerCallSid) {
        return res.status(400).json({
          ok: false,
          error: "provider_call_sid_required",
        });
      }

      const { call, session } = await upsertCallAndSession(db, body);

      await appendVoiceCallEvent(db, {
        callId: call.id,
        tenantId: call.tenantId,
        tenantKey: call.tenantKey,
        eventType: "session_upserted",
        actor: "voice_backend",
        payload: {
          callStatus: call.status,
          sessionStatus: session.status,
          conferenceName: session.conferenceName,
        },
      }).catch(() => {});

      return res.status(200).json({
        ok: true,
        call,
        session,
      });
    } catch (err) {
      console.error("[voiceInternal/session/upsert] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_session_upsert_failed",
      });
    }
  });

  r.post("/internal/voice/session/transcript", requireInternalToken, async (req, res) => {
    try {
      if (!db?.query) {
        return res.status(503).json({
          ok: false,
          error: "db_unavailable",
        });
      }

      const providerCallSid = s(req.body?.providerCallSid || req.body?.callSid);
      const text = s(req.body?.text);
      const role = s(req.body?.role, "customer");
      const ts = s(req.body?.ts || new Date().toISOString());

      if (!providerCallSid) {
        return res.status(400).json({
          ok: false,
          error: "provider_call_sid_required",
        });
      }

      if (!text) {
        return res.status(400).json({
          ok: false,
          error: "transcript_text_required",
        });
      }

      const session = await getVoiceCallSessionByProviderCallSid(db, providerCallSid);
      if (!session) {
        return res.status(404).json({
          ok: false,
          error: "voice_session_not_found",
        });
      }

      const transcriptLive = Array.isArray(session.transcriptLive)
        ? [...session.transcriptLive]
        : [];

      transcriptLive.push(normalizeTranscriptItem({ ts, role, text }));
      while (transcriptLive.length > 100) transcriptLive.shift();

      const updatedSession = await updateVoiceCallSession(db, session.id, {
        transcriptLive,
      });

      const call = await getVoiceCallByProviderSid(db, providerCallSid);
      let updatedCall = call;

      if (call) {
        const prev = s(call.transcript);
        const nextTranscript = prev ? `${prev}\n[${role}] ${text}` : `[${role}] ${text}`;

        updatedCall = await updateVoiceCall(db, call.id, {
          transcript: nextTranscript.slice(-30000),
        });

        await appendVoiceCallEvent(db, {
          callId: call.id,
          tenantId: call.tenantId,
          tenantKey: call.tenantKey,
          eventType: "transcript_appended",
          actor: "voice_backend",
          payload: { role, text, ts },
        }).catch(() => {});
      }

      return res.status(200).json({
        ok: true,
        call: updatedCall,
        session: updatedSession,
      });
    } catch (err) {
      console.error("[voiceInternal/session/transcript] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_transcript_append_failed",
      });
    }
  });

  r.post("/internal/voice/session/state", requireInternalToken, async (req, res) => {
    try {
      if (!db?.query) {
        return res.status(503).json({
          ok: false,
          error: "db_unavailable",
        });
      }

      const providerCallSid = s(req.body?.providerCallSid || req.body?.callSid);
      if (!providerCallSid) {
        return res.status(400).json({
          ok: false,
          error: "provider_call_sid_required",
        });
      }

      const session = await getVoiceCallSessionByProviderCallSid(db, providerCallSid);
      if (!session) {
        return res.status(404).json({
          ok: false,
          error: "voice_session_not_found",
        });
      }

      const patch = {
        status: s(req.body?.status || session.status),
        requestedDepartment: s(req.body?.requestedDepartment || session.requestedDepartment) || null,
        resolvedDepartment: s(req.body?.resolvedDepartment || session.resolvedDepartment) || null,
        operatorUserId: s(req.body?.operatorUserId || session.operatorUserId) || null,
        operatorName: s(req.body?.operatorName || session.operatorName) || null,
        operatorJoinMode: s(req.body?.operatorJoinMode || session.operatorJoinMode || "live"),
        botActive: b(req.body?.botActive, session.botActive),
        operatorJoinRequested: b(req.body?.operatorJoinRequested, session.operatorJoinRequested),
        operatorJoined: b(req.body?.operatorJoined, session.operatorJoined),
        whisperActive: b(req.body?.whisperActive, session.whisperActive),
        takeoverActive: b(req.body?.takeoverActive, session.takeoverActive),
        summary: s(req.body?.summary || session.summary),
        endedAt: req.body?.endedAt || session.endedAt || null,
      };

      if (req.body?.operatorRequestedAt) patch.operatorRequestedAt = req.body.operatorRequestedAt;
      if (req.body?.operatorJoinedAt) patch.operatorJoinedAt = req.body.operatorJoinedAt;
      if (isObj(req.body?.leadPayload)) patch.leadPayload = req.body.leadPayload;
      if (isObj(req.body?.meta)) patch.meta = req.body.meta;

      const updatedSession = await updateVoiceCallSession(db, session.id, patch);

      const call = await getVoiceCallByProviderSid(db, providerCallSid);
      let updatedCall = call;

      if (call) {
        updatedCall = await updateVoiceCall(db, call.id, {
          status:
            patch.status === "completed"
              ? "completed"
              : patch.status === "failed"
              ? "failed"
              : call.status,
          handoffRequested: patch.operatorJoinRequested,
          handoffCompleted: patch.operatorJoined || patch.takeoverActive,
          handoffTarget: patch.resolvedDepartment || call.handoffTarget || null,
          summary: patch.summary || call.summary,
          endedAt: patch.endedAt || call.endedAt || null,
          meta: isObj(req.body?.callMeta) ? req.body.callMeta : call.meta,
        });

        await appendVoiceCallEvent(db, {
          callId: call.id,
          tenantId: call.tenantId,
          tenantKey: call.tenantKey,
          eventType: s(req.body?.eventType || "session_state_updated"),
          actor: "voice_backend",
          payload: {
            sessionStatus: updatedSession.status,
            requestedDepartment: updatedSession.requestedDepartment,
            resolvedDepartment: updatedSession.resolvedDepartment,
            operatorJoinRequested: updatedSession.operatorJoinRequested,
            operatorJoined: updatedSession.operatorJoined,
            whisperActive: updatedSession.whisperActive,
            takeoverActive: updatedSession.takeoverActive,
          },
        }).catch(() => {});
      }

      return res.status(200).json({
        ok: true,
        call: updatedCall,
        session: updatedSession,
      });
    } catch (err) {
      console.error("[voiceInternal/session/state] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_session_state_update_failed",
      });
    }
  });

  r.post("/internal/voice/session/operator-join", requireInternalToken, async (req, res) => {
    try {
      if (!db?.query) {
        return res.status(503).json({
          ok: false,
          error: "db_unavailable",
        });
      }

      const providerCallSid = s(req.body?.providerCallSid || req.body?.callSid);
      if (!providerCallSid) {
        return res.status(400).json({
          ok: false,
          error: "provider_call_sid_required",
        });
      }

      const session = await getVoiceCallSessionByProviderCallSid(db, providerCallSid);
      if (!session) {
        return res.status(404).json({
          ok: false,
          error: "voice_session_not_found",
        });
      }

      const joinMode = s(req.body?.operatorJoinMode || req.body?.joinMode || "live").toLowerCase();
      const updatedSession = await updateVoiceCallSession(db, session.id, {
        status: joinMode === "whisper" ? "agent_whisper" : "agent_live",
        operatorUserId: s(req.body?.operatorUserId || session.operatorUserId) || null,
        operatorName: s(req.body?.operatorName || session.operatorName) || null,
        operatorJoinMode: joinMode,
        operatorJoinRequested: true,
        operatorJoined: true,
        whisperActive: joinMode === "whisper",
        takeoverActive: joinMode === "live" ? b(req.body?.takeoverActive, false) : false,
        botActive: b(req.body?.botActive, joinMode !== "live" ? true : false),
        operatorJoinedAt: req.body?.operatorJoinedAt || new Date().toISOString(),
      });

      const call = await getVoiceCallByProviderSid(db, providerCallSid);
      let updatedCall = call;

      if (call) {
        updatedCall = await updateVoiceCall(db, call.id, {
          handoffRequested: true,
          handoffCompleted: true,
          handoffTarget:
            updatedSession.resolvedDepartment ||
            updatedSession.requestedDepartment ||
            call.handoffTarget ||
            null,
          agentMode: joinMode === "live" ? "human" : "hybrid",
        });

        await appendVoiceCallEvent(db, {
          callId: call.id,
          tenantId: call.tenantId,
          tenantKey: call.tenantKey,
          eventType: "operator_joined",
          actor: "operator",
          payload: {
            operatorUserId: updatedSession.operatorUserId,
            operatorName: updatedSession.operatorName,
            operatorJoinMode: updatedSession.operatorJoinMode,
            takeoverActive: updatedSession.takeoverActive,
          },
        }).catch(() => {});
      }

      return res.status(200).json({
        ok: true,
        call: updatedCall,
        session: updatedSession,
      });
    } catch (err) {
      console.error("[voiceInternal/session/operator-join] error:", err);
      return res.status(500).json({
        ok: false,
        error: "voice_operator_join_update_failed",
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