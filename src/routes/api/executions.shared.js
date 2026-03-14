import { deepFix, fixText } from "../../utils/textFix.js";

export function pickJobId(req) {
  return String(
    req.body?.jobId || req.body?.job_id || req.body?.id || ""
  ).trim();
}

export function normalizeStatus(x) {
  const s = String(x || "").trim().toLowerCase();
  if (!s) return "";
  if (["complete", "done", "ok", "success"].includes(s)) return "completed";
  return s;
}

export function pickTenantIdFromResult(result) {
  const v = String(result?.tenantId || result?.tenant_id || "").trim();
  return v || null;
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
      ? jobInput.contentId ||
        jobInput.content_id ||
        jobInput.draftId ||
        jobInput.draft_id
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
    jt === "draft.regen" ||
    jt === "content.revise"
  );
}

export function isVoiceJobType(jt) {
  return (
    jt === "voice.generate" ||
    jt === "content.voice.generate" ||
    jt === "voiceover.generate" ||
    jt === "tts.generate"
  );
}

export function isSceneJobType(jt) {
  return (
    jt === "video.generate" ||
    jt === "content.video.generate" ||
    jt === "scene.generate" ||
    jt === "scene.video.generate" ||
    jt === "scene.image.generate" ||
    jt === "content.scene.generate" ||
    jt === "runway.generate" ||
    jt === "reel.generate" ||
    jt === "video.render" ||
    jt === "reel.render"
  );
}

export function isRenderJobType(jt) {
  return (
    jt === "assembly.render" ||
    jt === "content.render" ||
    jt === "render.generate" ||
    jt === "creatomate.render"
  );
}

export function isQaJobType(jt) {
  return jt === "qa.check" || jt === "content.qa.check";
}

export function isAssetJobType(jt) {
  return (
    jt === "asset.generate" ||
    jt === "content.assets.generate" ||
    jt === "content.asset.generate" ||
    isVoiceJobType(jt) ||
    isSceneJobType(jt) ||
    isRenderJobType(jt) ||
    isQaJobType(jt)
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

export function pickNextJobTypeAfter(jt, contentPack = {}, automation = {}) {
  const cp = asObj(contentPack) || {};
  const media = asObj(cp.media) || {};
  const format = safeLower(cp.format || "");
  const hasVoiceText = !!firstNonEmpty(cp.voiceoverText, cp.voiceover_text);
  const hasVoiceReady = !!firstNonEmpty(cp.voiceoverUrl, cp.voiceover?.url);
  const hasVideoPrompt = !!firstNonEmpty(cp.videoPrompt, cp.video_prompt);
  const hasVideoReady = !!firstNonEmpty(cp.videoUrl, cp.video?.videoUrl);
  const hasRenderReady = !!firstNonEmpty(cp.renderUrl, cp.render?.url);

  const wantsVoice =
    media.generateVoiceover === true ||
    cp.voiceoverEnabled === true ||
    hasVoiceText;

  const wantsScene =
    media.generateScenes === true ||
    media.generateVideo === true ||
    format === "reel" ||
    hasVideoPrompt ||
    !!cp.visualPlan ||
    !!cp.visual_plan;

  const wantsRender =
    media.renderVideo === true ||
    format === "reel" ||
    hasVideoReady ||
    hasVoiceReady;

  const wantsQa = media.runQa !== false;

  if (isDraftJobType(jt)) {
    if (wantsVoice && !hasVoiceReady) return "voice.generate";
    if (wantsScene && !hasVideoReady) return "video.generate";
    if (wantsRender && !hasRenderReady) return "assembly.render";
    if (wantsQa) return "qa.check";
    return automation?.autoPublish ? "publish" : null;
  }

  if (isVoiceJobType(jt)) {
    if (wantsScene && !hasVideoReady) return "video.generate";
    if (wantsRender && !hasRenderReady) return "assembly.render";
    if (wantsQa) return "qa.check";
    return automation?.autoPublish ? "publish" : null;
  }

  if (isSceneJobType(jt)) {
    if (wantsRender && !hasRenderReady) return "assembly.render";
    if (wantsQa) return "qa.check";
    return automation?.autoPublish ? "publish" : null;
  }

  if (isRenderJobType(jt)) {
    if (wantsQa) return "qa.check";
    return automation?.autoPublish ? "publish" : null;
  }

  if (isQaJobType(jt)) {
    return automation?.autoPublish ? "publish" : null;
  }

  return null;
}

export function buildNotificationCopy(status, jt, errorText) {
  let completedTitle = "Draft ready";
  let completedBody = "Draft hazır oldu.";

  if (isVoiceJobType(jt)) {
    completedTitle = "Voice ready";
    completedBody = "Voiceover hazır oldu.";
  } else if (isSceneJobType(jt)) {
    completedTitle = "Scenes ready";
    completedBody = "Scene/video asset hazır oldu.";
  } else if (isRenderJobType(jt)) {
    completedTitle = "Render ready";
    completedBody = "Final render hazır oldu.";
  } else if (isQaJobType(jt)) {
    completedTitle = "QA checked";
    completedBody = "Media QA tamamlandı.";
  } else if (isPublishJobType(jt)) {
    completedTitle = "Published";
    completedBody = "Instagram paylaşımı edildi.";
  } else if (isAssetJobType(jt)) {
    completedTitle = "Assets ready";
    completedBody = "Assets hazır oldu.";
  }

  return {
    type:
      status === "completed"
        ? "success"
        : status === "running"
        ? "info"
        : "error",
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
        : errorText || "n8n failed",
  };
}

export function buildNextJobInput({
  proposalId,
  threadId,
  tenantId,
  contentId,
  contentPack,
  currentResult,
  nextJobType,
  automation,
}) {
  const cp = deepFix(contentPack || {});
  const result = deepFix(currentResult || {});

  return deepFix({
    proposalId: proposalId || null,
    threadId: threadId || null,
    tenantId: tenantId || null,
    contentId: contentId || null,
    type: nextJobType,

    contentPack: cp,

    format: cp.format || result.format || null,
    aspectRatio:
      cp.aspectRatio || result.aspectRatio || result.aspect_ratio || null,

    visualPlan: cp.visualPlan || cp.visual_plan || null,

    videoPrompt:
      cp.videoPrompt ||
      cp.video_prompt ||
      result.videoPrompt ||
      result.video_prompt ||
      null,

    voiceoverText:
      cp.voiceoverText ||
      cp.voiceover_text ||
      result.voiceoverText ||
      result.voiceover_text ||
      null,

    voiceoverUrl:
      cp.voiceoverUrl ||
      cp.voiceover?.url ||
      result.voiceoverUrl ||
      result.voiceover?.url ||
      null,

    renderUrl:
      cp.renderUrl ||
      cp.render?.url ||
      result.renderUrl ||
      result.render?.url ||
      null,

    voiceover: cp.voiceover || result.voiceover || null,
    video: cp.video || result.video || null,

    imageUrl: cp.imageUrl || result.imageUrl || null,
    videoUrl: cp.videoUrl || result.videoUrl || null,
    thumbnailUrl: cp.thumbnailUrl || result.thumbnailUrl || null,

    automationMode: automation?.mode || "manual",
    autoPublish: automation?.autoPublish === true,
  });
}