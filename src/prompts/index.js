import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "src", "prompts");
const cache = new Map();

function readRel(relPath) {
  const full = path.join(ROOT, relPath);

  if (cache.has(full)) {
    return cache.get(full);
  }

  if (!fs.existsSync(full)) {
    console.error("[prompts] missing file:", full);
    return "";
  }

  const txt = fs.readFileSync(full, "utf8");
  cache.set(full, txt);

  return txt;
}

export function getGlobalPolicy() {
  return readRel("policy.global.txt").trim();
}

// usecase: "content.draft" => "usecases/content.draft.txt"
export function getUsecasePrompt(usecase) {
  const uc = String(usecase || "").trim();

  if (!uc) return "";

  return readRel(`usecases/${uc}.txt`).trim();
}