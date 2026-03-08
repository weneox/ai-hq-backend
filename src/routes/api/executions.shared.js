import { cfg } from "../../config.js";
import { deepFix, fixText } from "../../utils/textFix.js";

export function pickJobId(req) {
  return String(req.body?.jobId || req.body?.job_id || req.body?.id || "").trim();
}

export function normalizeStatus(x) {
  const s = String(x || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "complete") return "completed";
  if (s === "done") return "completed";
  if (s === "ok") return "completed";
  if (s === "success") return "completed";
  return s;
}

export function pickTenantIdFromResult(result) {
  return (
    fixText(
      String(result?.tenantId || result?.tenant_id || cfg.DEFAULT_TENANT_KEY || "default").trim()
    ) || "default"
  );
}

export function pickThreadId(result, jobInput) {
  return (
    result?.threadId ||
    result?.thread_id ||
    jobInput?.threadId ||
    jobInput?.thread_id ||
    null
  );
}

export function pickContentId(result, jobInput) {
  const cid =
    result?.contentId ||
    result?.content_id ||
    result?.draftId ||
    result?.draft_id ||
    (jobInput && typeof jobInput === "object"
      ? (jobInput.contentId || jobInput.content_id || jobInput.draftId || jobInput.draft_id)
      : null) ||
    null;

  return cid ? String(cid) : null;
}

export function jobTypeLc(x) {
  return String(x || "").trim().toLowerCase();
}

export function isDraftJobType(jt) {
  return (
    jt.startsWith("draft") ||
    jt === "content.draft" ||
    jt === "draft.generate" ||
    jt === "draft.regen"
  );
}

export function isAssetJobType(jt) {
  return (
    jt === "asset.generate" ||
    jt === "content.assets.generate" ||
    jt === "content.asset.generate" ||
    jt === "video.generate" ||
    jt === "content.video.generate" ||
    jt === "reel.generate" ||
    jt === "reel.render" ||
    jt === "video.render"
  );
}

export function isPublishJobType(jt) {
  return jt === "publish" || jt === "content.publish";
}

export function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : null;
}

export function safeLower(x) {
  return String(x || "").trim().toLowerCase();
}

export function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (s) return s;
  }
  return null;
}

export function buildNotificationCopy(status, jt, errorText) {
  const completedTitle =
    isPublishJobType(jt)
      ? "Published"
      : isAssetJobType(jt)
      ? "Assets ready"
      : "Draft ready";

  const completedBody =
    isPublishJobType(jt)
      ? "Instagram paylaşımı edildi."
      : isAssetJobType(jt)
      ? "Assets hazır oldu."
      : "Draft hazır oldu.";

  return {
    type: status === "completed" ? "success" : status === "running" ? "info" : "error",
    title:
      status === "completed"
        ? completedTitle
        : status === "running"
        ? "Execution running"
        : "Execution failed",
    body:
      status === "completed"
        ? completedBody
        : status === "running"
        ? "İcra gedir…"
        : (errorText || "n8n failed"),
  };
}