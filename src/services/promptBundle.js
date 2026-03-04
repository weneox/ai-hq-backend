import { deepFix, fixText } from "../utils/textFix.js";
import { getGlobalPolicy, getUsecasePrompt } from "../prompts/index.js";

function usecaseForEvent(event) {
  const e = String(event || "").trim();
  if (e === "proposal.approved") return "content.draft";
  if (e === "content.revise") return "content.revise";
  if (e === "content.publish") return "content.publish";
  if (e === "meta.comment_reply") return "meta.comment_reply";
  if (e === "trend.research") return "trend.research";
  if (e === "content.approved") return "content.publish";
  return "";
}

export function buildPromptBundle(event) {
  let globalPolicy = "";
  let usecaseKey = "";
  let usecasePrompt = "";

  try {
    globalPolicy = fixText(getGlobalPolicy() || "");
  } catch {
    globalPolicy = "";
  }

  usecaseKey = usecaseForEvent(event);
  if (usecaseKey) {
    try {
      usecasePrompt = fixText(getUsecasePrompt(usecaseKey) || "");
    } catch {
      usecasePrompt = "";
    }
  }

  return deepFix({ globalPolicy, usecaseKey, usecasePrompt });
}