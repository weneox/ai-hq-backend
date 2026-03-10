// src/routes/api/debate.js
// FINAL — cron draft + formatHint wired to engine + proposal+content_items persist
// ✅ passes tenant + extra into debate engine
// ✅ keeps DB/mem persistence
// ✅ keeps cron draft/trend fallback
// ✅ supports richer prompt pipeline

import express from "express";
import crypto from "crypto";

import { cfg } from "../../config.js";
import { okJson, clamp, isDbReady } from "../../utils/http.js";
import { deepFix, fixText } from "../../utils/textFix.js";
import { runDebate } from "../../kernel/debateEngine.js";
import {
  memEnsureThread,
  memAddMessage,
  memCreateProposal,
} from "../../utils/memStore.js";

function normalizeMode(mode) {
  const m = String(mode || "answer").trim().toLowerCase();
  if (m === "content.draft" || m === "content_draft") return "draft";
  if (m === "content.revise" || m === "content_revise") return "revise";
  if (m === "content.publish" || m === "content_publish") return "publish";
  if (m === "trend.research" || m === "trend_research") return "trend";
  if (m === "meta.comment_reply" || m === "meta_comment_reply") return "meta_comment";
  return m;
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

// debateEngine returns:
// - for mode="proposal": proposal is proposal JSON
// - for mode="draft"/"trend"/"publish"/"revise": proposal is wrapper {type,title,payload} or payload
function unwrapContentPackFromProposalPayload(p) {
  if (!p || typeof p !== "object") return null;
  if (p.payload && typeof p.payload === "object") return deepFix(p.payload);
  return deepFix(p);
}

function statusForMode(mode) {
  const m = normalizeMode(mode);
  if (m === "draft") return "in_progress";
  if (m === "revise") return "in_progress";
  if (m === "publish") return "approved";
  if (m === "trend") return "approved";
  if (m === "proposal") return "pending";
  return "pending";
}

function buildTenantRuntimeFromRequest(req, tenantId) {
  const bodyTenant = obj(req.body?.tenant);
  const brand = obj(bodyTenant.brand);
  const meta = obj(bodyTenant.meta);

  return deepFix({
    tenantId,
    tenantKey: tenantId,
    companyName:
      fixText(
        bodyTenant.companyName ||
          bodyTenant.name ||
          brand.companyName ||
          brand.name ||
          meta.companyName ||
          tenantId
      ) || tenantId,
    industryKey:
      fixText(
        bodyTenant.industryKey ||
          bodyTenant.industry ||
          brand.industryKey ||
          brand.industry ||
          meta.industryKey ||
          "generic_business"
      ) || "generic_business",
    defaultLanguage:
      fixText(
        bodyTenant.defaultLanguage ||
          bodyTenant.language ||
          brand.defaultLanguage ||
          brand.language ||
          "az"
      ) || "az",
    outputLanguage:
      fixText(
        bodyTenant.outputLanguage ||
          brand.outputLanguage ||
          bodyTenant.language ||
          brand.language ||
          ""
      ) || "",
    ctaStyle:
      fixText(bodyTenant.ctaStyle || brand.ctaStyle || meta.ctaStyle || "contact") || "contact",
    visualTheme:
      fixText(bodyTenant.visualTheme || brand.visualTheme || "premium_modern") || "premium_modern",
    brand: {
      name: fixText(brand.name),
      companyName: fixText(brand.companyName),
      industryKey: fixText(brand.industryKey),
      defaultLanguage: fixText(brand.defaultLanguage || brand.language),
      outputLanguage: fixText(brand.outputLanguage),
      ctaStyle: fixText(brand.ctaStyle),
      visualTheme: fixText(brand.visualTheme),
      tone: Array.isArray(brand.tone) ? brand.tone : [],
      services: Array.isArray(brand.services) ? brand.services : [],
      audiences: Array.isArray(brand.audiences) ? brand.audiences : [],
      requiredHashtags: Array.isArray(brand.requiredHashtags) ? brand.requiredHashtags : [],
      preferredPresets: Array.isArray(brand.preferredPresets) ? brand.preferredPresets : [],
      visualStyle: obj(brand.visualStyle),
    },
    tone: Array.isArray(bodyTenant.tone) ? bodyTenant.tone : [],
    services: Array.isArray(bodyTenant.services) ? bodyTenant.services : [],
    audiences: Array.isArray(bodyTenant.audiences) ? bodyTenant.audiences : [],
    requiredHashtags: Array.isArray(bodyTenant.requiredHashtags) ? bodyTenant.requiredHashtags : [],
    preferredPresets: Array.isArray(bodyTenant.preferredPresets) ? bodyTenant.preferredPresets : [],
    meta,
  });
}

function buildDebateExtra(req, { tenantId, formatHint, mode }) {
  const body = req.body || {};
  const extra = obj(body.extra);

  return deepFix({
    ...extra,
    tenantId,
    language: fixText(body.language || extra.language || ""),
    format: fixText(formatHint || body.format || extra.format || ""),
    topicHint: fixText(body.topicHint || extra.topicHint || ""),
    goalHint: fixText(body.goalHint || extra.goalHint || ""),
    feedback: fixText(body.feedback || extra.feedback || ""),
    previousDraft: body.previousDraft || extra.previousDraft || body.draft || extra.draft || null,
    approvedDraft:
      body.approvedDraft ||
      extra.approvedDraft ||
      body.content ||
      extra.content ||
      body.contentPack ||
      extra.contentPack ||
      null,
    assetUrls: body.assetUrls || extra.assetUrls || body.generatedAssetUrls || extra.generatedAssetUrls || [],
    platform: fixText(body.platform || extra.platform || "instagram").toLowerCase() || "instagram",
    commentText: fixText(body.commentText || extra.commentText || body.comment || extra.comment || ""),
    authorName: fixText(body.authorName || extra.authorName || body.username || extra.username || ""),
    postTopic: fixText(body.postTopic || extra.postTopic || body.topic || extra.topic || ""),
    market: fixText(body.market || extra.market || ""),
    region: fixText(body.region || extra.region || ""),
    audienceFocus: fixText(body.audienceFocus || extra.audienceFocus || ""),
    categoryFocus: fixText(body.categoryFocus || extra.categoryFocus || ""),
    competitors: Array.isArray(body.competitors)
      ? body.competitors
      : Array.isArray(extra.competitors)
      ? extra.competitors
      : [],
    sourceNotes: fixText(body.sourceNotes || extra.sourceNotes || ""),
    timeWindow: fixText(body.timeWindow || extra.timeWindow || ""),
    goals: Array.isArray(body.goals) ? body.goals : Array.isArray(extra.goals) ? extra.goals : [],
    mode,
  });
}

export function debateRoutes({ db, wsHub }) {
  const r = express.Router();

  // POST /api/debate
  r.post("/debate", async (req, res) => {
    const tenantId =
      fixText(String(req.body?.tenantId || cfg.DEFAULT_TENANT_KEY || "default").trim()) || "default";

    let message = fixText(String(req.body?.message || "").trim());
    const mode = normalizeMode(req.body?.mode);
    const rounds = clamp(req.body?.rounds ?? 1, 1, 5);
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : null;

    // Accept from n8n: formatHint | FORMAT | format
    const formatHintRaw = req.body?.formatHint ?? req.body?.FORMAT ?? req.body?.format ?? "";
    const formatHint = fixText(String(formatHintRaw || "").trim());

    let threadId = String(req.body?.threadId || "").trim();
    if (!threadId) threadId = crypto.randomUUID();

    const tenant = buildTenantRuntimeFromRequest(req, tenantId);
    const debateExtra = buildDebateExtra(req, { tenantId, formatHint, mode });

    // CRON SUPPORT
    if (!message) {
      const today = new Date().toISOString().slice(0, 10);

      if (mode === "draft") {
        message = `
AUTO_DRAFT (${today})
Tenant=${tenantId}
${formatHint ? `Preferred format: ${formatHint}` : ""}

Generate today's social content draft for this tenant.
Return STRICT JSON ONLY as usecase requires.
        `.trim();
      } else if (mode === "trend") {
        message = `
AUTO_TREND (${today})
Tenant=${tenantId}

Generate a practical trend brief for this tenant.
Return STRICT JSON ONLY as usecase requires.
        `.trim();
      } else {
        return okJson(res, { ok: false, error: "message required" });
      }
    }

    try {
      // 1) Store user message
      if (!isDbReady(db)) {
        memEnsureThread(threadId);
        memAddMessage(threadId, { role: "user", agent: null, content: message });
      } else {
        await db.query(
          `insert into threads (id, title) values ($1::uuid, $2::text)
           on conflict (id) do nothing`,
          [threadId, "Debate"]
        );

        await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'user', null, $2::text, $3::jsonb)`,
          [threadId, message, { mode, tenantId, formatHint: formatHint || null }]
        );
      }

      // 2) Run debate engine
      const out = await runDebate({
        message,
        mode,
        rounds,
        agents,
        tenantId,
        tenant,
        threadId,
        formatHint: formatHint || null,
        extra: debateExtra,
      });

      const finalAnswer = fixText(String(out?.finalAnswer || "").trim());
      const agentNotes = deepFix(out?.agentNotes || []);
      const debug = deepFix({
        promptBundle: out?.promptBundle || null,
        normalizedPromptInput: out?.normalizedPromptInput || null,
      });

      // 3) Store assistant message
      if (!isDbReady(db)) {
        const row = memAddMessage(threadId, {
          role: "assistant",
          agent: "debate",
          content: finalAnswer,
          meta: { agentNotes, mode, tenantId, formatHint: formatHint || null },
        });
        wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
      } else {
        const q = await db.query(
          `insert into messages (thread_id, role, agent_key, content, meta)
           values ($1::uuid, 'assistant', 'debate', $2::text, $3::jsonb)
           returning id, thread_id, role, agent_key, content, meta, created_at`,
          [threadId, finalAnswer, { agentNotes, mode, tenantId, formatHint: formatHint || null }]
        );
        const row = q.rows?.[0] || null;
        if (row) {
          row.content = fixText(row.content);
          row.meta = deepFix(row.meta);
          wsHub?.broadcast?.({ type: "thread.message", threadId, message: row });
        }
      }

      // 4) Persist proposal + content_items
      let proposal = null;
      let content = null;

      if (out?.proposal && typeof out.proposal === "object") {
        const payload = deepFix(out.proposal);

        const title =
          fixText(payload.title || payload.name || payload.summary || payload.goal || payload.topic || "") ||
          `Draft ${new Date().toISOString()}`;

        const status = statusForMode(mode);
        const type = String(payload.type || mode || "draft");

        if (!isDbReady(db)) {
          proposal = memCreateProposal(threadId, { agent: "debate", type, title, payload });
          wsHub?.broadcast?.({ type: "proposal.created", proposal });
        } else {
          const q2 = await db.query(
            `insert into proposals (thread_id, agent, type, status, title, payload)
             values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb)
             returning id, thread_id, agent, type, status, title, payload, created_at, decided_at, decision_by`,
            [threadId, "debate", type, status, title, payload]
          );

          proposal = q2.rows?.[0] || null;
          if (proposal) {
            proposal.title = fixText(proposal.title);
            proposal.payload = deepFix(proposal.payload);
            wsHub?.broadcast?.({ type: "proposal.created", proposal });
          }

          if (proposal && mode === "draft") {
            const contentPack = unwrapContentPackFromProposalPayload(payload);

            const q3 = await db.query(
              `insert into content_items (proposal_id, status, content_pack, last_feedback)
               values ($1::uuid, $2::text, $3::jsonb, null)
               returning id, proposal_id, status, content_pack, last_feedback, job_id, created_at, updated_at`,
              [proposal.id, "draft.ready", contentPack]
            );

            content = q3.rows?.[0] || null;
            if (content) {
              content.content_pack = deepFix(content.content_pack);
              wsHub?.broadcast?.({ type: "content.updated", content });
            }
          }
        }
      }

      return okJson(res, {
        ok: true,
        tenantId,
        threadId,
        mode,
        formatHint: formatHint || null,
        finalAnswer,
        agentNotes,
        proposal,
        content,
        dbDisabled: !isDbReady(db),
        debug,
      });
    } catch (e) {
      return okJson(res, {
        ok: false,
        error: "Error",
        details: { message: String(e?.message || e) },
      });
    }
  });

  return r;
}