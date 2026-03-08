import { deepFix, fixText } from "../../utils/textFix.js";

export function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

export function safePayload(p) {
  return asObj(p?.payload);
}

export function safeTitle(p) {
  const payload = safePayload(p);
  const t =
    payload?.topic ||
    payload?.title ||
    payload?.name ||
    payload?.summary ||
    payload?.goal ||
    p?.title ||
    "";
  return fixText(String(t || "").trim());
}

export function safeTopic(p) {
  const payload = safePayload(p);
  return fixText(
    String(payload?.topic || payload?.title || p?.title || "").trim()
  );
}

export function safeFormat(p) {
  const payload = safePayload(p);
  return fixText(
    String(
      payload?.format || payload?.postType || payload?.post_type || ""
    )
      .trim()
      .toLowerCase()
  );
}

export function safeAspectRatio(p) {
  const payload = safePayload(p);
  return fixText(
    String(
      payload?.aspectRatio ||
        payload?.aspect_ratio ||
        payload?.visualPlan?.aspectRatio ||
        ""
    ).trim()
  );
}

export function safeVisualPreset(p) {
  const payload = safePayload(p);
  return fixText(
    String(payload?.visualPlan?.visualPreset || payload?.visualPreset || "").trim()
  );
}

export function safeImagePrompt(p) {
  const payload = safePayload(p);
  return fixText(
    String(payload?.imagePrompt || payload?.assetBrief?.imagePrompt || "").trim()
  );
}

export function safeVideoPrompt(p) {
  const payload = safePayload(p);
  return fixText(
    String(payload?.videoPrompt || payload?.assetBrief?.videoPrompt || "").trim()
  );
}

export function safeVoiceoverText(p) {
  const payload = safePayload(p);
  return fixText(
    String(payload?.voiceoverText || payload?.assetBrief?.voiceoverText || "").trim()
  );
}

export function safeNeededAssets(p) {
  const payload = safePayload(p);
  const arr = payload?.neededAssets || payload?.assetBrief?.neededAssets || [];
  return Array.isArray(arr)
    ? arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
    : [];
}

export function safeReelMeta(p) {
  const payload = safePayload(p);
  const rm = asObj(payload?.reelMeta);
  return Object.keys(rm).length ? deepFix(rm) : null;
}

export function normalizeRequestedStatus(x) {
  const s = fixText(String(x || "").trim()).toLowerCase() || "draft";
  const allowed = new Set([
    "draft",
    "pending",
    "in_progress",
    "approved",
    "published",
    "rejected",
  ]);
  return allowed.has(s) ? s : "draft";
}

export function lc(x) {
  return String(x || "").trim().toLowerCase();
}

export function parseMaybeJson(x) {
  if (!x) return null;
  if (typeof x === "object") return x;
  if (typeof x === "string") {
    try {
      const o = JSON.parse(x);
      return o && typeof o === "object" ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}