// src/prompts/index.js
//
// FINAL v2.0 — template vars + dot keys + safe file loading + cache helpers

import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "src", "prompts");
const cache = new Map();

function clean(x) {
  return String(x || "").trim();
}

function normalizeRel(relPath) {
  return String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function readRel(relPath) {
  const rel = normalizeRel(relPath);
  const full = path.join(ROOT, rel);

  if (cache.has(full)) return cache.get(full);

  try {
    if (!fs.existsSync(full)) {
      console.error("[prompts] missing file:", full);
      cache.set(full, "");
      return "";
    }

    const txt = fs.readFileSync(full, "utf8");
    cache.set(full, txt);
    return txt;
  } catch (e) {
    console.error("[prompts] read error:", full, String(e?.message || e));
    cache.set(full, "");
    return "";
  }
}

function escapeVal(v) {
  if (v === null || v === undefined) return "";

  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// supports {{key}} and dot keys like {{a.b.c}}
function renderTemplate(tpl, vars = {}) {
  const src = String(tpl || "");
  const ctx = vars && typeof vars === "object" ? vars : {};

  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const parts = String(key || "").split(".");
    let cur = ctx;

    for (const p of parts) {
      if (!cur || typeof cur !== "object") return "";
      cur = cur[p];
    }

    return escapeVal(cur);
  });
}

export function getGlobalPolicy(vars) {
  const base = readRel("policy.global.txt").trim();
  return vars ? renderTemplate(base, vars) : base;
}

// usecase: "content.draft" => "usecases/content.draft.txt"
export function getUsecasePrompt(usecase, vars) {
  const uc = clean(usecase);
  if (!uc) return "";

  const rel = `usecases/${uc}.txt`;
  const base = readRel(rel).trim();

  return vars ? renderTemplate(base, vars) : base;
}

export function clearPromptCache() {
  cache.clear();
}

export function getPromptRoot() {
  return ROOT;
}