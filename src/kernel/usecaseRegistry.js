// src/kernel/usecaseRegistry.js
//
// Professional usecase registry for AI HQ kernel
//
// Purpose:
// - define default agent per usecase
// - define output mode per usecase
// - define schema expectations
// - support future content analyze / fix plan flows

function s(v, d = "") {
  return String(v ?? d).trim();
}

function normalizeOutputMode(v, fallback = "text") {
  const x = s(v, fallback).toLowerCase();
  if (x === "json") return "json";
  return "text";
}

function normalizeUsecaseKey(v, fallback = "general.chat") {
  return s(v, fallback);
}

function makeUsecase(def = {}) {
  return {
    key: normalizeUsecaseKey(def.key, "general.chat"),
    defaultAgent: s(def.defaultAgent, "orion"),
    outputMode: normalizeOutputMode(def.outputMode, "text"),
    schemaKey: s(def.schemaKey, ""),
    retryLimit: Number.isFinite(Number(def.retryLimit))
      ? Number(def.retryLimit)
      : 0,
    description: s(def.description),
  };
}

const USECASE_REGISTRY = {
  "general.chat": makeUsecase({
    key: "general.chat",
    defaultAgent: "orion",
    outputMode: "text",
    description: "General AI HQ chat and reasoning.",
  }),

  "strategy.chat": makeUsecase({
    key: "strategy.chat",
    defaultAgent: "orion",
    outputMode: "text",
    description: "Business strategy, planning, and decision support.",
  }),

  "sales.chat": makeUsecase({
    key: "sales.chat",
    defaultAgent: "atlas",
    outputMode: "text",
    description: "Sales, funnel, and conversion-oriented support.",
  }),

  "analytics.chat": makeUsecase({
    key: "analytics.chat",
    defaultAgent: "echo",
    outputMode: "text",
    description: "Analytics, KPI, and measurement support.",
  }),

  "trend.research": makeUsecase({
    key: "trend.research",
    defaultAgent: "echo",
    outputMode: "text",
    description: "Trend research and signal extraction.",
  }),

  "content.draft": makeUsecase({
    key: "content.draft",
    defaultAgent: "nova",
    outputMode: "json",
    schemaKey: "content_draft",
    retryLimit: 1,
    description: "Generate production-ready daily social content draft JSON.",
  }),

  "content.revise": makeUsecase({
    key: "content.revise",
    defaultAgent: "director",
    outputMode: "json",
    schemaKey: "content_draft",
    retryLimit: 1,
    description: "Revise an existing content draft while preserving schema.",
  }),

  "content.publish": makeUsecase({
    key: "content.publish",
    defaultAgent: "nova",
    outputMode: "json",
    schemaKey: "content_publish_pack",
    retryLimit: 1,
    description: "Prepare final publish-ready social pack JSON.",
  }),

  "content.analyze": makeUsecase({
    key: "content.analyze",
    defaultAgent: "critic",
    outputMode: "json",
    schemaKey: "content_analysis",
    retryLimit: 1,
    description: "Analyze approved content quality and publish readiness.",
  }),

  "content.fix_plan": makeUsecase({
    key: "content.fix_plan",
    defaultAgent: "director",
    outputMode: "json",
    schemaKey: "content_fix_plan",
    retryLimit: 1,
    description: "Create targeted fix plan without regenerating from scratch.",
  }),

  "proposal.review": makeUsecase({
    key: "proposal.review",
    defaultAgent: "orion",
    outputMode: "text",
    description: "Review or critique proposal quality and business direction.",
  }),

  "lead.score": makeUsecase({
    key: "lead.score",
    defaultAgent: "atlas",
    outputMode: "json",
    schemaKey: "lead_score",
    retryLimit: 1,
    description: "Score a lead and return structured qualification output.",
  }),

  "performance.review": makeUsecase({
    key: "performance.review",
    defaultAgent: "echo",
    outputMode: "text",
    description: "Review performance data and summarize implications.",
  }),
};

export function listUsecasesDetailed() {
  return Object.values(USECASE_REGISTRY).map((x) => ({ ...x }));
}

export function hasUsecase(usecase = "") {
  return !!USECASE_REGISTRY[normalizeUsecaseKey(usecase, "")];
}

export function getUsecase(usecase = "general.chat") {
  return (
    USECASE_REGISTRY[normalizeUsecaseKey(usecase, "general.chat")] ||
    USECASE_REGISTRY["general.chat"]
  );
}

export function getUsecaseDefaultAgent(usecase = "general.chat") {
  return s(getUsecase(usecase)?.defaultAgent, "orion");
}

export function getUsecaseOutputMode(usecase = "general.chat") {
  return normalizeOutputMode(getUsecase(usecase)?.outputMode, "text");
}

export function getUsecaseSchemaKey(usecase = "general.chat") {
  return s(getUsecase(usecase)?.schemaKey);
}

export function getUsecaseRetryLimit(usecase = "general.chat") {
  const v = Number(getUsecase(usecase)?.retryLimit);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}