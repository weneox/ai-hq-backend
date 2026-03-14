// src/config/features.js

import { cfg } from "../config.js";

function has(v) {
  return String(v ?? "").trim().length > 0;
}

export function getProviderState() {
  return {
    ai: {
      openai: has(cfg.ai.openaiApiKey),
      gemini: has(cfg.ai.geminiApiKey),
      anthropic: has(cfg.ai.anthropicApiKey),
    },

    media: {
      runway: has(cfg.media.runwayApiKey),
      pika: has(cfg.media.pikaApiKey),
      elevenlabs: has(cfg.media.elevenlabsApiKey),
      creatomate: has(cfg.media.creatomateApiKey),
    },

    meta: {
      oauth:
        has(cfg.meta.appId) &&
        has(cfg.meta.appSecret) &&
        has(cfg.meta.redirectUri),
      pageAccess: has(cfg.meta.pageAccessToken),
      gateway:
        has(cfg.gateway.metaGatewayBaseUrl) &&
        has(cfg.gateway.metaGatewayInternalToken),
    },

    n8n: {
      enabled:
        has(cfg.n8n.webhookUrl) ||
        has(cfg.n8n.webhookBase) ||
        has(cfg.n8n.webhookProposalApprovedUrl) ||
        has(cfg.n8n.webhookPublishUrl) ||
        has(cfg.n8n.scheduleDraftUrl),
      scheduleDraft: has(cfg.n8n.scheduleDraftUrl),
    },

    telegram: {
      enabled: cfg.telegram.enabled && has(cfg.telegram.botToken),
    },

    push: {
      enabled:
        cfg.push.enabled &&
        has(cfg.push.vapidPublicKey) &&
        has(cfg.push.vapidPrivateKey),
    },

    db: {
      enabled: has(cfg.db.url),
    },

    ws: {
      enabled: has(cfg.ws.authToken),
    },
  };
}

export function getFeatureFlags() {
  const providers = getProviderState();

  return {
    core: {
      auth: true,
      adminPanel: cfg.auth.adminPanelEnabled,
      db: providers.db.enabled,
      ws: providers.ws.enabled,
      auditLog: true,
      team: true,
      tenants: true,
      settings: true,
    },

    inbox: {
      inbox: true,
      leads: true,
      comments: true,
      metaConnect: providers.meta.oauth,
      metaDm: providers.meta.gateway || providers.meta.pageAccess,
      outboundRetry: cfg.workers.outboundRetryEnabled,
    },

    content: {
      content: providers.ai.openai || providers.ai.gemini || providers.ai.anthropic,
      analyze: providers.ai.openai || providers.ai.gemini || providers.ai.anthropic,
      debate: providers.ai.openai,
      propose: providers.ai.openai || providers.ai.gemini || providers.ai.anthropic,
      draftSchedule: cfg.workers.draftScheduleWorkerEnabled && providers.n8n.scheduleDraft,
      publish: providers.n8n.enabled || providers.meta.pageAccess,
    },

    media: {
      render: providers.media.creatomate || providers.media.runway,
      imageGeneration: providers.media.runway || providers.media.pika,
      videoGeneration: providers.media.runway || providers.media.pika,
      tts: providers.media.elevenlabs,
      mediaWorker: cfg.workers.mediaJobWorkerEnabled,
    },

    channels: {
      telegram: providers.telegram.enabled,
      push: providers.push.enabled,
      meta: providers.meta.oauth || providers.meta.pageAccess || providers.meta.gateway,
    },

    workflows: {
      n8n: providers.n8n.enabled,
      cron: has(cfg.security.cronSecret),
      internalCallbacks: has(cfg.n8n.callbackToken),
    },

    billing: {
      usageMetering: false,
      pricing: false,
      overage: false,
    },
  };
}

export function hasFeature(path) {
  const flags = getFeatureFlags();
  const parts = String(path || "").split(".").filter(Boolean);

  let cur = flags;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return false;
    cur = cur[p];
  }

  return Boolean(cur);
}