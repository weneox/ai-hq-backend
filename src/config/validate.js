// src/config/validate.js

import { cfg } from "../config.js";

function isNonEmpty(v) {
  return String(v ?? "").trim().length > 0;
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function pushIssue(list, level, key, message) {
  list.push({
    level,
    key,
    message,
  });
}

export function getConfigIssues() {
  const issues = [];

  const env = String(cfg?.app?.env || "").trim().toLowerCase();
  const isProd = env === "production";

  const draftScheduleWorkerEnabled = Boolean(
    cfg?.workers?.draftScheduleWorkerEnabled ?? false
  );
  const scheduleDraftUrl = String(cfg?.n8n?.scheduleDraftUrl || "").trim();

  if (!isNonEmpty(cfg?.app?.env)) {
    pushIssue(issues, "error", "app.env", "APP_ENV is missing.");
  }

  if (!isNonEmpty(cfg?.app?.defaultTimezone)) {
    pushIssue(
      issues,
      "warning",
      "app.defaultTimezone",
      "DEFAULT_TIMEZONE is empty."
    );
  }

  if (!isNonEmpty(cfg?.db?.url)) {
    pushIssue(
      issues,
      "warning",
      "db.url",
      "DATABASE_URL is not set. App may run in dbDisabled mode."
    );
  }

  if (cfg?.auth?.adminPanelEnabled) {
    if (!isNonEmpty(cfg?.auth?.adminPasscodeHash)) {
      pushIssue(
        issues,
        "warning",
        "auth.adminPasscodeHash",
        "ADMIN_PANEL_ENABLED=true but ADMIN_PANEL_PASSCODE_HASH is missing."
      );
    }

    if (!isNonEmpty(cfg?.auth?.adminSessionSecret)) {
      pushIssue(
        issues,
        "error",
        "auth.adminSessionSecret",
        "ADMIN_PANEL_ENABLED=true but ADMIN_SESSION_SECRET is missing."
      );
    }
  }

  if (!isNonEmpty(cfg?.auth?.userSessionSecret)) {
    pushIssue(
      issues,
      "error",
      "auth.userSessionSecret",
      "USER_SESSION_SECRET is missing."
    );
  }

  if (
    isProd &&
    !isNonEmpty(cfg?.auth?.sessionCookieDomain) &&
    !isNonEmpty(cfg?.auth?.cookieDomain) &&
    !isNonEmpty(cfg?.auth?.userCookieDomain)
  ) {
    pushIssue(
      issues,
      "warning",
      "auth.cookieDomain",
      "Production mode without explicit cookie domain config may cause session/cookie issues."
    );
  }

  if (!isNonEmpty(cfg?.security?.aihqInternalToken)) {
    pushIssue(
      issues,
      "warning",
      "security.aihqInternalToken",
      "AIHQ_INTERNAL_TOKEN is missing."
    );
  }

  if (!isNonEmpty(cfg?.security?.cronSecret)) {
    pushIssue(
      issues,
      "warning",
      "security.cronSecret",
      "CRON_SECRET is missing."
    );
  }

  if (!isNonEmpty(cfg?.security?.tenantSecretMasterKey)) {
    pushIssue(
      issues,
      "warning",
      "security.tenantSecretMasterKey",
      "TENANT_SECRET_MASTER_KEY is missing."
    );
  }

  const hasAnyAiProvider =
    isNonEmpty(cfg?.ai?.openaiApiKey) ||
    isNonEmpty(cfg?.ai?.geminiApiKey) ||
    isNonEmpty(cfg?.ai?.anthropicApiKey);

  if (!hasAnyAiProvider) {
    pushIssue(
      issues,
      "warning",
      "ai",
      "No AI provider API key is configured."
    );
  }

  if (n(cfg?.ai?.openaiMaxOutputTokens, 0) <= 0) {
    pushIssue(
      issues,
      "error",
      "ai.openaiMaxOutputTokens",
      "OPENAI_MAX_OUTPUT_TOKENS must be greater than 0."
    );
  }

  if (n(cfg?.ai?.openaiTimeoutMs, 0) < 1000) {
    pushIssue(
      issues,
      "warning",
      "ai.openaiTimeoutMs",
      "OPENAI_TIMEOUT_MS looks too low."
    );
  }

  if (n(cfg?.ai?.openaiDebateConcurrency, 0) < 1) {
    pushIssue(
      issues,
      "error",
      "ai.openaiDebateConcurrency",
      "OPENAI_DEBATE_CONCURRENCY must be at least 1."
    );
  }

  const hasAnyMediaProvider =
    isNonEmpty(cfg?.media?.runwayApiKey) ||
    isNonEmpty(cfg?.media?.pikaApiKey) ||
    isNonEmpty(cfg?.media?.creatomateApiKey) ||
    isNonEmpty(cfg?.media?.elevenlabsApiKey);

  if (cfg?.workers?.mediaJobWorkerEnabled && !hasAnyMediaProvider) {
    pushIssue(
      issues,
      "warning",
      "workers.mediaJobWorkerEnabled",
      "MEDIA_JOB_WORKER_ENABLED=true but no media provider is configured."
    );
  }

  if (
    isNonEmpty(cfg?.media?.elevenlabsApiKey) &&
    !isNonEmpty(cfg?.media?.elevenlabsVoiceId)
  ) {
    pushIssue(
      issues,
      "warning",
      "media.elevenlabsVoiceId",
      "ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is empty."
    );
  }

  const hasMetaOauthPartial =
    isNonEmpty(cfg?.meta?.appId) ||
    isNonEmpty(cfg?.meta?.appSecret) ||
    isNonEmpty(cfg?.meta?.redirectUri);

  const hasMetaOauthFull =
    isNonEmpty(cfg?.meta?.appId) &&
    isNonEmpty(cfg?.meta?.appSecret) &&
    isNonEmpty(cfg?.meta?.redirectUri);

  if (hasMetaOauthPartial && !hasMetaOauthFull) {
    pushIssue(
      issues,
      "error",
      "meta.oauth",
      "META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI must all be set together."
    );
  }

  const hasN8nAny =
    isNonEmpty(cfg?.n8n?.webhookBase) ||
    isNonEmpty(cfg?.n8n?.webhookUrl) ||
    isNonEmpty(cfg?.n8n?.webhookProposalApprovedUrl) ||
    isNonEmpty(cfg?.n8n?.webhookPublishUrl) ||
    isNonEmpty(scheduleDraftUrl);

  if (hasN8nAny && !isNonEmpty(cfg?.n8n?.webhookToken)) {
    pushIssue(
      issues,
      "warning",
      "n8n.webhookToken",
      "n8n is configured but N8N_WEBHOOK_TOKEN is missing."
    );
  }

  if (hasN8nAny && !isNonEmpty(cfg?.n8n?.callbackToken)) {
    pushIssue(
      issues,
      "warning",
      "n8n.callbackToken",
      "n8n is configured but N8N_CALLBACK_TOKEN is missing."
    );
  }

  if (n(cfg?.n8n?.timeoutMs, 0) < 1000) {
    pushIssue(
      issues,
      "warning",
      "n8n.timeoutMs",
      "N8N_TIMEOUT_MS looks too low."
    );
  }

  if (n(cfg?.n8n?.retries, 0) < 0) {
    pushIssue(
      issues,
      "error",
      "n8n.retries",
      "N8N_RETRIES cannot be negative."
    );
  }

  if (draftScheduleWorkerEnabled && !scheduleDraftUrl) {
    pushIssue(
      issues,
      "warning",
      "workers.draftScheduleWorkerEnabled",
      "Draft schedule worker is enabled but n8n.scheduleDraftUrl is missing."
    );
  }

  if (cfg?.telegram?.enabled) {
    if (!isNonEmpty(cfg?.telegram?.botToken)) {
      pushIssue(
        issues,
        "error",
        "telegram.botToken",
        "TELEGRAM_ENABLED=true but TELEGRAM_BOT_TOKEN is missing."
      );
    }

    if (!isNonEmpty(cfg?.telegram?.chatId)) {
      pushIssue(
        issues,
        "warning",
        "telegram.chatId",
        "TELEGRAM_ENABLED=true but TELEGRAM_CHAT_ID is missing."
      );
    }
  }

  if (cfg?.push?.enabled) {
    if (!isNonEmpty(cfg?.push?.vapidPublicKey)) {
      pushIssue(
        issues,
        "error",
        "push.vapidPublicKey",
        "PUSH_ENABLED=true but VAPID_PUBLIC_KEY is missing."
      );
    }

    if (!isNonEmpty(cfg?.push?.vapidPrivateKey)) {
      pushIssue(
        issues,
        "error",
        "push.vapidPrivateKey",
        "PUSH_ENABLED=true but VAPID_PRIVATE_KEY is missing."
      );
    }
  }

  const hasMetaGatewayPartial =
    isNonEmpty(cfg?.gateway?.metaGatewayBaseUrl) ||
    isNonEmpty(cfg?.gateway?.metaGatewayInternalToken);

  const hasMetaGatewayFull =
    isNonEmpty(cfg?.gateway?.metaGatewayBaseUrl) &&
    isNonEmpty(cfg?.gateway?.metaGatewayInternalToken);

  if (hasMetaGatewayPartial && !hasMetaGatewayFull) {
    pushIssue(
      issues,
      "warning",
      "gateway.metaGateway",
      "META_GATEWAY_BASE_URL and META_GATEWAY_INTERNAL_TOKEN should be set together."
    );
  }

  if (n(cfg?.workers?.outboundRetryBatchSize, 0) < 1) {
    pushIssue(
      issues,
      "error",
      "workers.outboundRetryBatchSize",
      "OUTBOUND_RETRY_BATCH_SIZE must be at least 1."
    );
  }

  if (n(cfg?.workers?.mediaJobWorkerBatchSize, 0) < 1) {
    pushIssue(
      issues,
      "error",
      "workers.mediaJobWorkerBatchSize",
      "MEDIA_JOB_WORKER_BATCH_SIZE must be at least 1."
    );
  }

  return issues;
}

export function getConfigErrors() {
  return getConfigIssues().filter((x) => x.level === "error");
}

export function getConfigWarnings() {
  return getConfigIssues().filter((x) => x.level === "warning");
}

export function printConfigReport(logger = console) {
  const issues = getConfigIssues();
  const errors = issues.filter((x) => x.level === "error");
  const warnings = issues.filter((x) => x.level === "warning");

  if (!issues.length) {
    logger.log("[config] OK: no validation issues found.");
    return {
      ok: true,
      errors: [],
      warnings: [],
      issues: [],
    };
  }

  for (const item of warnings) {
    logger.warn(`[config][warning] ${item.key}: ${item.message}`);
  }

  for (const item of errors) {
    logger.error(`[config][error] ${item.key}: ${item.message}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
  };
}

export function assertConfigValid(logger = console) {
  const report = printConfigReport(logger);

  if (!report.ok) {
    const summary = report.errors
      .map((x) => `${x.key}: ${x.message}`)
      .join("\n");

    throw new Error(`Config validation failed:\n${summary}`);
  }

  return report;
}