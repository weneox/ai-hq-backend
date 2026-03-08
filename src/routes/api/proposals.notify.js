import { deepFix } from "../../utils/textFix.js";
import {
  safeTitle,
  safeTopic,
  safeFormat,
  safeAspectRatio,
  safeVisualPreset,
  safeImagePrompt,
  safeVideoPrompt,
  safeVoiceoverText,
  safeNeededAssets,
  safeReelMeta,
} from "./proposals.shared.js";

export function buildN8nExtra({
  tenantId,
  proposal,
  jobId = null,
  reason = "",
}) {
  return deepFix({
    tenantId,
    proposalId: String(proposal?.id || ""),
    threadId: String(proposal?.thread_id || ""),
    jobId: jobId || null,
    reason: reason || "",
    title: safeTitle(proposal),
    topic: safeTopic(proposal),
    format: safeFormat(proposal),
    aspectRatio: safeAspectRatio(proposal),
    visualPreset: safeVisualPreset(proposal),
    imagePrompt: safeImagePrompt(proposal),
    videoPrompt: safeVideoPrompt(proposal),
    voiceoverText: safeVoiceoverText(proposal),
    neededAssets: safeNeededAssets(proposal),
    reelMeta: safeReelMeta(proposal),
    payload: deepFix(proposal?.payload || {}),
    callback: {
      url: "/api/executions/callback",
      tokenHeader: "x-webhook-token",
    },
  });
}