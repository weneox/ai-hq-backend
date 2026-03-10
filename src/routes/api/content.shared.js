import { deepFix, fixText } from "../../utils/textFix.js";
import { resolveTenantKeyFromReq } from "../../tenancy/index.js";

export function normalizeContentPack(x) {
  if (!x) return null;
  if (typeof x === "string") {
    try {
      const o = JSON.parse(x);
      return typeof o === "object" && o ? deepFix(o) : null;
    } catch {
      return null;
    }
  }
  if (typeof x === "object") return deepFix(x);
  return null;
}

export function normalizeLooseObject(x) {
  if (!x) return null;
  if (typeof x === "string") {
    try {
      const o = JSON.parse(x);
      return typeof o === "object" && o ? deepFix(o) : null;
    } catch {
      return null;
    }
  }
  if (typeof x === "object" && !Array.isArray(x)) return deepFix(x);
  return null;
}

export function pickTenantId(req) {
  return resolveTenantKeyFromReq(req);
}

export function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

export function safeLower(x) {
  return String(x || "").trim().toLowerCase();
}

export function packType(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(pack.post_type || pack.postType || pack.format || pack.type || "").toLowerCase();
}

export function pickAspectRatio(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(pack.aspectRatio || pack.aspect_ratio || pack?.visualPlan?.aspectRatio || "").trim();
}

export function pickVisualPreset(pack) {
  if (!pack || typeof pack !== "object") return "";
  return String(pack?.visualPlan?.visualPreset || pack?.visualPreset || "").trim();
}

export function pickImagePrompt(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(String(pack.imagePrompt || pack?.assetBrief?.imagePrompt || "").trim());
}

export function pickVideoPrompt(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(String(pack.videoPrompt || pack?.assetBrief?.videoPrompt || "").trim());
}

export function pickVoiceoverText(pack) {
  if (!pack || typeof pack !== "object") return "";
  return fixText(String(pack.voiceoverText || pack?.assetBrief?.voiceoverText || "").trim());
}

export function pickNeededAssets(pack) {
  if (!pack || typeof pack !== "object") return [];
  const a = pack.neededAssets || pack?.assetBrief?.neededAssets || [];
  return Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
}

export function pickReelMeta(pack) {
  if (!pack || typeof pack !== "object") return null;
  const rm = asObj(pack.reelMeta);
  return Object.keys(rm).length ? deepFix(rm) : null;
}

export function normalizeHashtagsValue(v) {
  if (!v) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(" ");
  if (typeof v === "string") return fixText(v.trim());
  try {
    return fixText(JSON.stringify(v));
  } catch {
    return "";
  }
}

export function buildCaption(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return "";

  const captionText = fixText(String(contentPack.caption || contentPack.text || "").trim());
  const hashtagsText = normalizeHashtagsValue(contentPack.hashtags);

  return [captionText, hashtagsText].filter(Boolean).join("\n\n");
}

export function statusLc(x) {
  return String(x || "").trim().toLowerCase();
}

export function isDraftReadyStatus(s) {
  const v = statusLc(s);
  return (
    v === "draft.ready" ||
    v === "draft" ||
    v === "in_progress" ||
    v === "approved" ||
    v === "draft.approved" ||
    v.startsWith("draft.")
  );
}

export function isAssetReadyStatus(s) {
  const v = statusLc(s);
  return (
    v === "asset.ready" ||
    v === "assets.ready" ||
    v === "publish.ready" ||
    v === "approved" ||
    v === "draft.approved" ||
    v === "content.approved"
  );
}

export function isPublishRequestedStatus(s) {
  const v = statusLc(s);
  return v === "publish.requested" || v === "publish.queued" || v === "publish.running";
}

export function isReelPack(contentPack) {
  return packType(contentPack) === "reel";
}

export function pickAssetGenerationEvent(contentPack) {
  return isReelPack(contentPack) ? "content.video.generate" : "content.assets.generate";
}

export function pickAssetGenerationJobType(contentPack) {
  return isReelPack(contentPack) ? "video.generate" : "asset.generate";
}