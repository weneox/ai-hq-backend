import { deepFix } from "../../utils/textFix.js";
import {
  packType,
  pickAspectRatio,
  pickVisualPreset,
  pickImagePrompt,
  pickVideoPrompt,
  pickVoiceoverText,
  pickNeededAssets,
  pickReelMeta,
} from "./content.shared.js";
import { pickThumbnailUrl } from "./content.assets.js";

export function buildAssetNotifyExtra({
  tenantId,
  proposal,
  row,
  jobId,
  contentPack,
}) {
  return deepFix({
    tenantId,
    proposalId: String(proposal?.id || row?.proposal_id || ""),
    threadId: String(proposal?.thread_id || row?.thread_id || ""),
    jobId: jobId || null,
    contentId: String(row?.id || ""),
    postType: packType(contentPack),
    format: packType(contentPack),
    aspectRatio: pickAspectRatio(contentPack),
    visualPreset: pickVisualPreset(contentPack),
    imagePrompt: pickImagePrompt(contentPack),
    videoPrompt: pickVideoPrompt(contentPack),
    voiceoverText: pickVoiceoverText(contentPack),
    neededAssets: pickNeededAssets(contentPack),
    reelMeta: pickReelMeta(contentPack),
    contentPack,
    callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
  });
}

export function buildPublishNotifyExtra({
  tenantId,
  proposal,
  row,
  jobId,
  contentPack,
  assetUrl,
  caption,
}) {
  const thumbnailUrl = pickThumbnailUrl(contentPack, row);
  const kind = packType(contentPack);

  return deepFix({
    tenantId,
    proposalId: String(proposal?.id || row?.proposal_id || ""),
    threadId: String(proposal?.thread_id || row?.thread_id || ""),
    jobId: jobId || null,
    contentId: String(row?.id || ""),
    postType: kind,
    format: kind,
    aspectRatio: pickAspectRatio(contentPack),
    visualPreset: pickVisualPreset(contentPack),
    assetUrl,
    imageUrl: kind === "reel" ? null : assetUrl,
    videoUrl: kind === "reel" ? assetUrl : null,
    thumbnailUrl,
    coverUrl: thumbnailUrl || assetUrl,
    caption,
    contentPack,
    callback: { url: "/api/executions/callback", tokenHeader: "x-webhook-token" },
  });
}