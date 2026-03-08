import { deepFix } from "../../utils/textFix.js";
import { firstNonEmpty, safeLower } from "./executions.shared.js";

export function normalizeAssetItem(a) {
  if (!a || typeof a !== "object") return null;

  const url = firstNonEmpty(a.url, a.secure_url, a.publicUrl, a.public_url);
  if (!url) return null;

  return deepFix({
    kind: a.kind || a.type || "image",
    type: a.type || a.kind || "image",
    role: a.role || "primary",
    provider: a.provider || null,
    url,
    secure_url: a.secure_url || null,
    publicUrl: a.publicUrl || null,
    public_url: a.public_url || null,
    thumbnailUrl: a.thumbnailUrl || a.thumbnail_url || null,
    durationSec: a.durationSec ?? a.duration_sec ?? null,
    aspectRatio: a.aspectRatio || a.aspect_ratio || null,
    taskId: a.taskId || a.task_id || null,
  });
}

export function pickImageInfo(result) {
  const image =
    (result?.image && typeof result.image === "object" ? result.image : null) ||
    (result?.asset && typeof result.asset === "object" ? result.asset : null) ||
    null;

  const imageUrl = firstNonEmpty(
    result?.imageUrl,
    result?.image_url,
    result?.assetUrl,
    result?.asset_url,
    result?.url,
    image?.imageUrl,
    image?.image_url,
    image?.assetUrl,
    image?.asset_url,
    image?.url
  );

  const coverUrl = firstNonEmpty(
    result?.coverUrl,
    result?.cover_url,
    result?.thumbnailUrl,
    result?.thumbnail_url,
    image?.coverUrl,
    image?.cover_url,
    image?.thumbnailUrl,
    image?.thumbnail_url
  );

  const provider = firstNonEmpty(
    result?.provider,
    result?.engine,
    image?.provider
  );

  const aspectRatio = firstNonEmpty(
    result?.aspectRatio,
    result?.aspect_ratio,
    image?.aspectRatio,
    image?.aspect_ratio
  );

  if (!imageUrl && !coverUrl && !image) return null;

  return deepFix({
    provider: provider ? String(provider) : null,
    imageUrl: imageUrl ? String(imageUrl) : null,
    coverUrl: coverUrl ? String(coverUrl) : null,
    aspectRatio: aspectRatio ? String(aspectRatio) : null,
    raw: image ? deepFix(image) : null,
  });
}

export function pickVideoInfo(result) {
  const video =
    (result?.video && typeof result.video === "object" ? result.video : null) ||
    (result?.render && typeof result.render === "object" ? result.render : null) ||
    (result?.runway && typeof result.runway === "object" ? result.runway : null) ||
    null;

  const videoUrl =
    result?.videoUrl ||
    result?.video_url ||
    video?.videoUrl ||
    video?.video_url ||
    video?.url ||
    null;

  const thumbnailUrl =
    result?.thumbnailUrl ||
    result?.thumbnail_url ||
    result?.posterUrl ||
    result?.poster_url ||
    video?.thumbnailUrl ||
    video?.thumbnail_url ||
    video?.posterUrl ||
    video?.poster_url ||
    null;

  const provider =
    result?.provider ||
    result?.engine ||
    video?.provider ||
    (video?.taskId || video?.task_id ? "runway" : null) ||
    null;

  const taskId =
    result?.taskId ||
    result?.task_id ||
    result?.runwayTaskId ||
    result?.runway_task_id ||
    video?.taskId ||
    video?.task_id ||
    null;

  const durationSec =
    result?.durationSec ||
    result?.duration_sec ||
    result?.duration ||
    video?.durationSec ||
    video?.duration_sec ||
    video?.duration ||
    null;

  const aspectRatio =
    result?.aspectRatio ||
    result?.aspect_ratio ||
    video?.aspectRatio ||
    video?.aspect_ratio ||
    null;

  if (!videoUrl && !thumbnailUrl && !taskId && !video) return null;

  return deepFix({
    provider: provider ? String(provider) : null,
    taskId: taskId ? String(taskId) : null,
    videoUrl: videoUrl ? String(videoUrl) : null,
    thumbnailUrl: thumbnailUrl ? String(thumbnailUrl) : null,
    durationSec: durationSec == null ? null : Number(durationSec),
    aspectRatio: aspectRatio ? String(aspectRatio) : null,
    raw: video ? deepFix(video) : null,
  });
}

export function mergePackAssets(result) {
  const rawPack =
    result?.contentPack ||
    result?.content_pack ||
    result?.draft ||
    result?.pack ||
    result?.content ||
    null;

  const assets = Array.isArray(result?.assets)
    ? result.assets.map(normalizeAssetItem).filter(Boolean)
    : [];

  const image = pickImageInfo(result);
  const video = pickVideoInfo(result);

  const topLevelPatch = deepFix({
    ...(image?.imageUrl ? { imageUrl: image.imageUrl } : {}),
    ...(image?.coverUrl ? { coverUrl: image.coverUrl, thumbnailUrl: image.coverUrl } : {}),
    ...(video?.videoUrl ? { videoUrl: video.videoUrl } : {}),
    ...(video?.thumbnailUrl ? { thumbnailUrl: video.thumbnailUrl } : {}),
    ...(image?.aspectRatio || video?.aspectRatio
      ? { aspectRatio: image?.aspectRatio || video?.aspectRatio }
      : {}),
  });

  if (rawPack && typeof rawPack === "object") {
    const rpAssets = Array.isArray(rawPack.assets)
      ? rawPack.assets.map(normalizeAssetItem).filter(Boolean)
      : [];

    return deepFix({
      ...rawPack,
      ...topLevelPatch,
      assets: [...rpAssets, ...assets],
    });
  }

  if (assets.length || Object.keys(topLevelPatch).length) {
    return deepFix({
      ...topLevelPatch,
      ...(assets.length ? { assets } : {}),
    });
  }

  return null;
}

export function pickPublishInfo(result) {
  const pub =
    (result?.publish && typeof result.publish === "object" ? result.publish : null) ||
    (result?.published && typeof result.published === "object" ? result.published : null) ||
    null;

  const publishedMediaId =
    result?.publishedMediaId ||
    result?.published_media_id ||
    pub?.publishedMediaId ||
    pub?.published_media_id ||
    pub?.mediaId ||
    pub?.id ||
    null;

  const permalink =
    result?.permalink ||
    result?.postUrl ||
    result?.post_url ||
    pub?.permalink ||
    pub?.url ||
    null;

  const platform = result?.platform || pub?.platform || "instagram";

  return deepFix({
    platform,
    publishedMediaId: publishedMediaId ? String(publishedMediaId) : null,
    permalink: permalink ? String(permalink) : null,
    raw: pub ? deepFix(pub) : null,
  });
}

export function buildMediaAssets(result) {
  const out = [];

  if (Array.isArray(result?.assets)) {
    for (const item of result.assets) {
      const normalized = normalizeAssetItem(item);
      if (normalized) out.push(normalized);
    }
  }

  const image = pickImageInfo(result);
  if (image?.imageUrl) {
    out.push(
      deepFix({
        kind: "image",
        type: "image",
        role: "primary",
        provider: image.provider || null,
        url: image.imageUrl,
        aspectRatio: image.aspectRatio || null,
      })
    );
  }

  if (image?.coverUrl) {
    out.push(
      deepFix({
        kind: "image",
        type: "image",
        role: "cover",
        provider: image.provider || null,
        url: image.coverUrl,
        aspectRatio: image.aspectRatio || null,
      })
    );
  }

  const video = pickVideoInfo(result);

  if (video?.videoUrl) {
    out.push(
      deepFix({
        kind: "video",
        type: "video",
        role: "primary",
        provider: video.provider || "runway",
        url: video.videoUrl,
        thumbnailUrl: video.thumbnailUrl || null,
        durationSec: video.durationSec ?? null,
        aspectRatio: video.aspectRatio || null,
        taskId: video.taskId || null,
      })
    );
  }

  if (video?.thumbnailUrl) {
    out.push(
      deepFix({
        kind: "image",
        type: "image",
        role: "thumbnail",
        provider: video.provider || "runway",
        url: video.thumbnailUrl,
        taskId: video.taskId || null,
      })
    );
  }

  return deepFix(out);
}

export function mergeContentPack(prevPack, incomingPack, result, jt) {
  const prev = deepFix(prevPack || {});
  const next = deepFix(incomingPack || {});
  const mergedAssets = [
    ...(Array.isArray(prev.assets) ? prev.assets : []),
    ...(Array.isArray(next.assets) ? next.assets : []),
    ...buildMediaAssets(result),
  ];

  const uniqueAssets = [];
  const seen = new Set();

  for (const a of mergedAssets) {
    const key = JSON.stringify([
      a?.kind || a?.type || "",
      a?.role || "",
      a?.url || "",
      a?.taskId || "",
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAssets.push(a);
  }

  const video = pickVideoInfo(result);
  const image = pickImageInfo(result);

  const merged = deepFix({
    ...prev,
    ...next,
    assets: uniqueAssets,
  });

  if (image?.imageUrl) merged.imageUrl = image.imageUrl;
  if (image?.coverUrl) {
    merged.coverUrl = image.coverUrl;
    if (!merged.thumbnailUrl) merged.thumbnailUrl = image.coverUrl;
  }
  if (image?.aspectRatio && !merged.aspectRatio) merged.aspectRatio = image.aspectRatio;

  if (video) {
    merged.video = deepFix({
      ...(prev.video && typeof prev.video === "object" ? prev.video : {}),
      ...video,
    });

    if (video.videoUrl) merged.videoUrl = video.videoUrl;
    if (video.thumbnailUrl) merged.thumbnailUrl = video.thumbnailUrl;
    if (video.aspectRatio) merged.aspectRatio = video.aspectRatio;
  }

  if (
    jt === "reel.generate" ||
    jt === "reel.render" ||
    jt === "video.generate" ||
    jt === "video.render" ||
    jt === "content.video.generate"
  ) {
    merged.format = merged.format || "reel";
    merged.mediaType = "video";
  }

  return deepFix(merged);
}