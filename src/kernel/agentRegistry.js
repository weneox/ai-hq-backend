// src/kernel/agentRegistry.js
//
// Professional agent registry for AI HQ kernel
//
// Purpose:
// - centralize agent definitions
// - support model routing
// - support output mode routing
// - support future analyze / fix planner agents

function s(v, d = "") {
  return String(v ?? d).trim();
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeOutputMode(v, fallback = "text") {
  const x = s(v, fallback).toLowerCase();
  if (x === "json") return "json";
  return "text";
}

function normalizeAgentId(v, fallback = "orion") {
  const x = s(v, fallback).toLowerCase();
  return x || fallback;
}

function makeAgent(def = {}) {
  return {
    id: normalizeAgentId(def.id, "orion"),
    name: s(def.name, "Agent"),
    role: s(def.role, "General"),
    system: s(def.system),
    defaultModel: s(def.defaultModel, ""),
    outputMode: normalizeOutputMode(def.outputMode, "text"),
    maxOutputTokens: Number.isFinite(Number(def.maxOutputTokens))
      ? Number(def.maxOutputTokens)
      : null,
    supportedUsecases: arr(def.supportedUsecases)
      .map((x) => s(x))
      .filter(Boolean),
  };
}

const AGENT_REGISTRY = {
  orion: makeAgent({
    id: "orion",
    name: "Orion",
    role: "Strategist",
    outputMode: "text",
    supportedUsecases: [
      "general.chat",
      "strategy.chat",
      "proposal.review",
    ],
    system:
      "You are Orion, a business strategist. Give structured, commercially useful, concise guidance. If asked for a plan, give numbered steps. Be clear, grounded, and decision-maker friendly.",
  }),

  nova: makeAgent({
    id: "nova",
    name: "Nova",
    role: "Content & Creative",
    outputMode: "json",
    supportedUsecases: [
      "content.draft",
      "content.revise",
      "content.publish",
      "content.analyze",
      "content.fix_plan",
    ],
    system:
      "You are Nova, a premium social content and creative systems specialist. You think like a senior content strategist, creative director, and production planner. Your outputs must be commercially strong, brand-aware, production-usable, and clean.",
  }),

  atlas: makeAgent({
    id: "atlas",
    name: "Atlas",
    role: "Sales & Funnel",
    outputMode: "text",
    supportedUsecases: [
      "general.chat",
      "sales.chat",
      "lead.score",
      "proposal.review",
    ],
    system:
      "You are Atlas, a sales, pipeline, and funnel specialist. Focus on conversion logic, qualification, objections, routing, and commercial usefulness. Be structured and concise.",
  }),

  echo: makeAgent({
    id: "echo",
    name: "Echo",
    role: "Analytics",
    outputMode: "text",
    supportedUsecases: [
      "general.chat",
      "analytics.chat",
      "trend.research",
      "performance.review",
    ],
    system:
      "You are Echo, an analytics and performance specialist. Focus on signal, KPIs, measurement, clarity, and decision-support. Be concise and structured.",
  }),

  critic: makeAgent({
    id: "critic",
    name: "Critic",
    role: "Creative QA Critic",
    outputMode: "json",
    supportedUsecases: [
      "content.analyze",
      "content.qa.review",
      "content.fix_plan",
    ],
    system:
      "You are Critic, a strict premium creative QA reviewer. You evaluate content drafts, visuals, reels, carousels, and publish packs with professional honesty. You must be specific, commercially grounded, and production-aware. Do not be vague. Do not overpraise weak work. Identify what is strong, what is weak, what should change, and whether the asset is publish-ready.",
  }),

  director: makeAgent({
    id: "director",
    name: "Director",
    role: "Revision & Fix Planner",
    outputMode: "json",
    supportedUsecases: [
      "content.fix_plan",
      "content.revise",
    ],
    system:
      "You are Director, a senior creative revision planner. Your job is to preserve what is already strong and produce targeted, implementation-ready fixes. You do not regenerate from scratch unless absolutely necessary. You think in terms of selective revisions, coherence, production realism, and premium output quality.",
  }),
};

export function listAgentsDetailed() {
  return Object.values(AGENT_REGISTRY).map((x) => ({ ...x }));
}

export function listAgents() {
  return Object.values(AGENT_REGISTRY).map((x) => ({
    id: x.id,
    name: x.name,
    role: x.role,
  }));
}

export function hasAgent(agentId) {
  const id = normalizeAgentId(agentId, "");
  return !!AGENT_REGISTRY[id];
}

export function getAgent(agentId = "orion") {
  const id = normalizeAgentId(agentId, "orion");
  return AGENT_REGISTRY[id] || AGENT_REGISTRY.orion;
}

export function getAgentSystem(agentId = "orion") {
  return s(getAgent(agentId)?.system);
}

export function getAgentOutputMode(agentId = "orion") {
  return normalizeOutputMode(getAgent(agentId)?.outputMode, "text");
}

export function getAgentDefaultModel(agentId = "orion") {
  return s(getAgent(agentId)?.defaultModel);
}

export function getAgentMaxOutputTokens(agentId = "orion") {
  const v = Number(getAgent(agentId)?.maxOutputTokens);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function getAgentSupportedUsecases(agentId = "orion") {
  return arr(getAgent(agentId)?.supportedUsecases);
}

export function agentSupportsUsecase(agentId = "orion", usecase = "") {
  const uc = s(usecase);
  if (!uc) return true;

  const supported = getAgentSupportedUsecases(agentId);
  if (!supported.length) return true;

  return supported.includes(uc);
}