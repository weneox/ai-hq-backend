// src/prompts/index.js (FINAL — template vars + dot keys + json safe)

import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "src", "prompts");
const cache = new Map();

function readRel(relPath) {
  const full = path.join(ROOT, relPath);

  if (cache.has(full)) return cache.get(full);

  if (!fs.existsSync(full)) {
    console.error("[prompts] missing file:", full);
    return "";
  }

  const txt = fs.readFileSync(full, "utf8");
  cache.set(full, txt);
  return txt;
}

function escapeVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// very small mustache-like: {{key}}  (supports dot keys: a.b.c)
function renderTemplate(tpl, vars = {}) {
  const src = String(tpl || "");
  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const k = String(key);
    const parts = k.split(".");
    let cur = vars;

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
  const uc = String(usecase || "").trim();
  if (!uc) return "";
  const base = readRel(`usecases/${uc}.txt`).trim();
  return vars ? renderTemplate(base, vars) : base;
}