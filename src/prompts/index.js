// src/prompts/index.js
//
// FINAL v3.1 — tenant-ready templates + dot vars + safe file loading + registry helpers
//
// ✅ safe prompt root resolution
// ✅ safe relative path handling
// ✅ dot var template rendering
// ✅ global policy loader
// ✅ usecase prompt loader
// ✅ usecase existence helpers
// ✅ cache helpers
// ✅ future-proof for multi-tenant prompt architecture

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePromptRoot() {
  const candidates = [
    path.resolve(process.cwd(), "src", "prompts"),
    path.resolve(__dirname),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p;
      }
    } catch {
      // ignore
    }
  }

  return path.resolve(process.cwd(), "src", "prompts");
}

const ROOT = resolvePromptRoot();
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

function isSafeInsideRoot(fullPath) {
  const rel = path.relative(ROOT, fullPath);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readRel(relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) return "";

  const full = path.resolve(ROOT, rel);

  if (!isSafeInsideRoot(full)) {
    console.error("[prompts] blocked unsafe path:", rel);
    return "";
  }

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

function getByPath(obj, dottedKey) {
  const parts = String(dottedKey || "").split(".");
  let cur = obj;

  for (const p of parts) {
    if (!cur || typeof cur !== "object") return "";
    cur = cur[p];
  }

  return cur;
}

// supports {{key}} and dot keys like {{a.b.c}}
function renderTemplate(tpl, vars = {}) {
  const src = String(tpl || "");
  const ctx = vars && typeof vars === "object" ? vars : {};

  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const value = getByPath(ctx, key);
    return escapeVal(value);
  });
}

function normalizeUsecaseKey(usecase) {
  return clean(usecase)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.txt$/i, "")
    .trim();
}

function getUsecaseRelPath(usecase) {
  const uc = normalizeUsecaseKey(usecase);
  if (!uc) return "";

  // only allow names like content.draft, meta.comment_reply, content/publish
  const safe = uc.replace(/[^a-zA-Z0-9._/-]/g, "").trim();
  if (!safe) return "";

  return `usecases/${safe}.txt`;
}

export function getGlobalPolicy(vars) {
  const base = readRel("policy.global.txt").trim();
  return vars ? renderTemplate(base, vars) : base;
}

export function hasUsecasePrompt(usecase) {
  const rel = getUsecaseRelPath(usecase);
  if (!rel) return false;

  const full = path.resolve(ROOT, rel);
  if (!isSafeInsideRoot(full)) return false;

  try {
    return fs.existsSync(full);
  } catch {
    return false;
  }
}

export function getRawUsecasePrompt(usecase) {
  const rel = getUsecaseRelPath(usecase);
  if (!rel) return "";
  return readRel(rel).trim();
}

// usecase: "content.draft" => "usecases/content.draft.txt"
export function getUsecasePrompt(usecase, vars) {
  const base = getRawUsecasePrompt(usecase);
  return vars ? renderTemplate(base, vars) : base;
}

export function listKnownUsecases() {
  const dir = path.resolve(ROOT, "usecases");

  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return [];
    }

    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".txt"))
      .map((d) => d.name.replace(/\.txt$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

export function clearPromptCache() {
  cache.clear();
}

export function getPromptRoot() {
  return ROOT;
}

export function renderPromptTemplate(template, vars = {}) {
  return renderTemplate(template, vars);
}