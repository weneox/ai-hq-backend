// src/prompts/index.js (FINAL)

import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "src", "prompts");
const cache = new Map();

function readRel(relPath) {
  const full = path.join(ROOT, relPath);

  if (cache.has(full)) {
    return cache.get(full);
  }

  try {
    const txt = fs.readFileSync(full, "utf8");
    const cleaned = String(txt || "").trim();
    cache.set(full, cleaned);
    return cleaned;
  } catch (err) {
    console.error("[prompts] failed to load:", full);
    return "";
  }
}

export function getGlobalPolicy() {
  return readRel("policy.global.txt");
}

// usecase: "content.draft" => usecases/content.draft.txt
export function getUsecasePrompt(usecase) {
  const uc = String(usecase || "").trim();

  if (!uc) {
    console.warn("[prompts] empty usecase requested");
    return "";
  }

  return readRel(`usecases/${uc}.txt`);
}