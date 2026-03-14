// src/config.js

function s(v, d = "") {
  return String(v ?? d).trim();
}

function n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function b(v, d = false) {
  const x = String(v ?? "").trim().toLowerCase();
  if (!x) return d;
  if (["1", "true", "yes", "y", "on"].includes(x)) return true;
  if (["0", "false", "no", "n", "off"].includes(x)) return false;
  return d;
}

function mode(v, d = "manual") {
  const x = String(v ?? "").trim().toLowerCase();
  if (x === "auto" || x === "manual") return x;
  return d;
}

export const cfg = {
  app: {
    port: n(process.env.PORT, 8080),
    env: s(process.env.APP_ENV, process.env.NODE_ENV || "production"),
    trustProxy: b(process.env.TRUST_PROXY, false),
    logLevel: s(process.env.LOG_LEVEL, "info"),
    defaultTimezone: s(process.env.DEFAULT_TIMEZONE, "Asia/Baku"),
    defaultMode: mode(process.env.DEFAULT_MODE, "manual"),
  },

  urls: {
    corsOrigin: s(process.env.CORS_ORIGIN, "*"),
    publicBaseUrl: s(process.env.PUBLIC_BASE_URL, ""),
    channelsReturnUrl: s(process.env.CHANNELS_RETURN_URL, ""),
    aihqSecretsPath: s(process.env.AIHQ_SECRETS_PATH, "/api/settings/secrets"),
  },

  db: {
    url: s(process.env.DATABASE_URL, ""),
    migrateTx: b(process.env.DB_MIGRATE_TX, true),
  },

  ws: {
    authToken: s(process.env.WS_AUTH_TOKEN, ""),
  },

  security: {
    debugApiToken: s(process.env.DEBUG_API_TOKEN, ""),
    aihqInternalToken: s(process.env.AIHQ_INTERNAL_TOKEN, ""),
    cronSecret: s(process.env.CRON_SECRET, ""),
    tenantSecretMasterKey: s(process.env.TENANT_SECRET_MASTER_KEY, ""),
  },

  auth: {
    adminPanelEnabled: b(process.env.ADMIN_PANEL_ENABLED, true),

    adminPasscodeHash: s(process.env.ADMIN_PANEL_PASSCODE_HASH, ""),
    adminSessionSecret: s(process.env.ADMIN_SESSION_SECRET, ""),
    adminSessionCookieName: s(
      process.env.ADMIN_SESSION_COOKIE_NAME,
      "aihq_admin"
    ),
    adminSessionTtlHours: n(process.env.ADMIN_SESSION_TTL_HOURS, 12),
    adminRateLimitWindowMs: n(
      process.env.ADMIN_RATE_LIMIT_WINDOW_MS,
      15 * 60 * 1000
    ),
    adminRateLimitMaxAttempts: n(
      process.env.ADMIN_RATE_LIMIT_MAX_ATTEMPTS,
      5
    ),

    userSessionSecret: s(
      process.env.USER_SESSION_SECRET,
      process.env.ADMIN_SESSION_SECRET || ""
    ),
    userSessionCookieName: s(
      process.env.USER_SESSION_COOKIE_NAME,
      "aihq_user"
    ),
    userSessionTtlHours: n(process.env.USER_SESSION_TTL_HOURS, 24 * 7),

    sessionCookieDomain: s(process.env.SESSION_COOKIE_DOMAIN, ""),
    cookieDomain: s(process.env.COOKIE_DOMAIN, ""),
    userCookieDomain: s(process.env.USER_COOKIE_DOMAIN, ""),
  },

  tenant: {
    defaultTenantKey: s(process.env.DEFAULT_TENANT_KEY, "default"),
    dailyPublishHourLocal: n(process.env.DAILY_PUBLISH_HOUR_LOCAL, 10),
    dailyPublishMinuteLocal: n(process.env.DAILY_PUBLISH_MINUTE_LOCAL, 0),
  },

  ai: {
    openaiApiKey: s(process.env.OPENAI_API_KEY, ""),
    openaiModel: s(process.env.OPENAI_MODEL, "gpt-5"),
    openaiMaxOutputTokens: n(process.env.OPENAI_MAX_OUTPUT_TOKENS, 800),
    openaiTimeoutMs: n(process.env.OPENAI_TIMEOUT_MS, 25_000),

    openaiDebateConcurrency: n(process.env.OPENAI_DEBATE_CONCURRENCY, 2),
    openaiDebateAgentTokens: n(
      process.env.OPENAI_DEBATE_AGENT_TOKENS,
      900
    ),
    openaiDebateSynthTokens: n(
      process.env.OPENAI_DEBATE_SYNTH_TOKENS,
      1400
    ),

    geminiApiKey: s(process.env.GEMINI_API_KEY, ""),
    anthropicApiKey: s(process.env.ANTHROPIC_API_KEY, ""),
  },

  media: {
    runwayApiKey: s(process.env.RUNWAY_API_KEY, ""),
    runwayVideoModel: s(process.env.RUNWAY_VIDEO_MODEL, "gen4.5"),

    pikaApiKey: s(process.env.PIKA_API_KEY, ""),

    elevenlabsApiKey: s(process.env.ELEVENLABS_API_KEY, ""),
    elevenlabsVoiceId: s(process.env.ELEVENLABS_VOICE_ID, ""),
    elevenlabsModelId: s(
      process.env.ELEVENLABS_MODEL_ID,
      "eleven_multilingual_v2"
    ),

    creatomateApiKey: s(process.env.CREATOMATE_API_KEY, ""),
    creatomateApiBase: s(
      process.env.CREATOMATE_API_BASE,
      "https://api.creatomate.com/v1"
    ),
    creatomateTemplateIdReel: s(
      process.env.CREATOMATE_TEMPLATE_ID_REEL,
      ""
    ),
    creatomateTemplateIdCarouselVideo: s(
      process.env.CREATOMATE_TEMPLATE_ID_CAROUSEL_VIDEO,
      ""
    ),
  },

  meta: {
    pageAccessToken: s(process.env.META_PAGE_ACCESS_TOKEN, ""),
    apiVersion: s(process.env.META_API_VERSION, "v23.0"),

    appId: s(process.env.META_APP_ID, ""),
    appSecret: s(process.env.META_APP_SECRET, ""),
    redirectUri: s(process.env.META_REDIRECT_URI, ""),
  },

  n8n: {
    webhookBase: s(process.env.N8N_WEBHOOK_BASE, ""),
    webhookUrl: s(process.env.N8N_WEBHOOK_URL, ""),
    webhookProposalApprovedUrl: s(
      process.env.N8N_WEBHOOK_PROPOSAL_APPROVED_URL,
      ""
    ),
    webhookPublishUrl: s(process.env.N8N_WEBHOOK_PUBLISH_URL, ""),
    webhookToken: s(process.env.N8N_WEBHOOK_TOKEN, ""),
    callbackToken: s(process.env.N8N_CALLBACK_TOKEN, ""),
    timeoutMs: n(process.env.N8N_TIMEOUT_MS, 10_000),
    retries: n(process.env.N8N_RETRIES, 2),
    backoffMs: n(process.env.N8N_BACKOFF_MS, 500),

    scheduleDraftUrl: s(process.env.N8N_WEBHOOK_SCHEDULE_DRAFT_URL, ""),
  },

  telegram: {
    enabled: b(process.env.TELEGRAM_ENABLED, false),
    botToken: s(process.env.TELEGRAM_BOT_TOKEN, ""),
    chatId: s(process.env.TELEGRAM_CHAT_ID, ""),
  },

  push: {
    enabled: b(process.env.PUSH_ENABLED, true),
    vapidPublicKey: s(process.env.VAPID_PUBLIC_KEY, ""),
    vapidPrivateKey: s(process.env.VAPID_PRIVATE_KEY, ""),
    vapidSubject: s(
      process.env.VAPID_SUBJECT,
      "mailto:info@example.com"
    ),
  },

  gateway: {
    metaGatewayBaseUrl: s(process.env.META_GATEWAY_BASE_URL, ""),
    metaGatewayInternalToken: s(
      process.env.META_GATEWAY_INTERNAL_TOKEN,
      ""
    ),
    metaGatewayTimeoutMs: n(
      process.env.META_GATEWAY_TIMEOUT_MS,
      20_000
    ),
  },

  workers: {
    outboundRetryEnabled: b(process.env.OUTBOUND_RETRY_ENABLED, true),
    outboundRetryIntervalMs: n(
      process.env.OUTBOUND_RETRY_INTERVAL_MS,
      15_000
    ),
    outboundRetryBatchSize: n(
      process.env.OUTBOUND_RETRY_BATCH_SIZE,
      10
    ),

    draftScheduleWorkerEnabled: b(
      process.env.DRAFT_SCHEDULE_WORKER_ENABLED,
      true
    ),
    draftScheduleWorkerIntervalMs: n(
      process.env.DRAFT_SCHEDULE_WORKER_INTERVAL_MS,
      60_000
    ),

    mediaJobWorkerEnabled: b(
      process.env.MEDIA_JOB_WORKER_ENABLED,
      true
    ),
    mediaJobWorkerIntervalMs: n(
      process.env.MEDIA_JOB_WORKER_INTERVAL_MS,
      15_000
    ),
    mediaJobWorkerBatchSize: n(
      process.env.MEDIA_JOB_WORKER_BATCH_SIZE,
      10
    ),
  },

  debug: {
    debateRaw: b(process.env.DEBUG_DEBATE_RAW, false),
  },
};