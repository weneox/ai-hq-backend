import {
  normalizeContentPack,
  normalizeLooseObject,
  normalizeHashtagsValue,
  safeLower,
  statusLc,
  isAssetReadyStatus,
} from "./content.shared.js";

function addUrl(out, value) {
  const s = String(value || "").trim();
  if (!s) return;
  if (/^https?:\/\//i.test(s)) out.push(s);
}

export function collectUrlsDeep(node, out, depth = 0) {
  if (!node || depth > 6) return;

  if (typeof node === "string") {
    addUrl(out, node);
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) collectUrlsDeep(item, out, depth + 1);
    return;
  }

  if (typeof node !== "object") return;

  addUrl(out, node.url);
  addUrl(out, node.secure_url);
  addUrl(out, node.publicUrl);
  addUrl(out, node.public_url);

  addUrl(out, node.imageUrl);
  addUrl(out, node.image_url);
  addUrl(out, node.videoUrl);
  addUrl(out, node.video_url);
  addUrl(out, node.coverUrl);
  addUrl(out, node.cover_url);
  addUrl(out, node.thumbnailUrl);
  addUrl(out, node.thumbnail_url);
  addUrl(out, node.permalink);

  const likelyChildren = [
    node.assets,
    node.media,
    node.images,
    node.videos,
    node.publish,
    node.result,
    node.output,
    node.contentPack,
    node.content_pack,
    node.payload,
    node.data,
    node.item,
    node.items,
  ];

  for (const child of likelyChildren) {
    collectUrlsDeep(child, out, depth + 1);
  }
}

export function getAllAssetUrlsFromRow(row) {
  const out = [];

  const contentPack = normalizeContentPack(row?.content_pack) || null;
  const publishObj = normalizeLooseObject(row?.publish) || null;
  const outputObj = normalizeLooseObject(row?.output) || null;
  const resultObj = normalizeLooseObject(row?.result) || null;
  const payloadObj = normalizeLooseObject(row?.payload) || null;

  collectUrlsDeep(contentPack, out);
  collectUrlsDeep(publishObj, out);
  collectUrlsDeep(outputObj, out);
  collectUrlsDeep(resultObj, out);
  collectUrlsDeep(payloadObj, out);
  collectUrlsDeep(row?.assets, out);
  collectUrlsDeep(row?.media, out);
  collectUrlsDeep(row, out);

  return Array.from(new Set(out));
}

export function pickFirstAssetUrl(contentPack, row = null) {
  if (contentPack && typeof contentPack === "object") {
    const direct =
      contentPack.videoUrl ||
      contentPack.video_url ||
      contentPack.imageUrl ||
      contentPack.image_url ||
      contentPack.coverUrl ||
      contentPack.cover_url ||
      contentPack.thumbnailUrl ||
      contentPack.thumbnail_url ||
      null;

    if (direct) return String(direct);

    const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
    if (assets.length) {
      const preferredVideo = assets.find((a) => {
        const kind = safeLower(a?.kind || a?.type || a?.mime || "");
        return kind.includes("video");
      });

      const preferredImage = assets.find((a) => {
        const kind = safeLower(a?.kind || a?.type || a?.mime || "");
        const role = safeLower(a?.role || "");
        return kind.includes("image") || role === "thumbnail" || role === "cover";
      });

      const chosen = preferredVideo || preferredImage || assets[0] || null;
      const u = chosen?.url || chosen?.secure_url || chosen?.publicUrl || chosen?.public_url || null;
      if (u) return String(u);
    }
  }

  if (row) {
    const urls = getAllAssetUrlsFromRow(row);
    if (urls.length) return urls[0];
  }

  return null;
}

export function pickThumbnailUrl(contentPack, row = null) {
  if (contentPack && typeof contentPack === "object") {
    const direct =
      contentPack.thumbnailUrl ||
      contentPack.thumbnail_url ||
      contentPack.coverUrl ||
      contentPack.cover_url ||
      null;

    if (direct) return String(direct);

    const assets = Array.isArray(contentPack.assets) ? contentPack.assets : [];
    const chosen =
      assets.find((a) => safeLower(a?.role || "") === "thumbnail") ||
      assets.find((a) => safeLower(a?.role || "") === "cover") ||
      assets.find((a) => safeLower(a?.kind || a?.type || "") === "image") ||
      null;

    const u = chosen?.url || chosen?.secure_url || chosen?.publicUrl || chosen?.public_url || null;
    if (u) return String(u);
  }

  if (row) {
    const all = getAllAssetUrlsFromRow(row);
    const thumb =
      all.find((u) => /thumbnail|thumb|cover/i.test(String(u))) ||
      all.find((u) => /\.(png|jpe?g|webp)(\?|$)/i.test(String(u))) ||
      null;
    if (thumb) return String(thumb);
  }

  return null;
}

export function buildCaption(contentPack) {
  if (!contentPack || typeof contentPack !== "object") return "";

  const captionText = String(contentPack.caption || contentPack.text || "").trim();
  const hashtagsText = normalizeHashtagsValue(contentPack.hashtags);

  return [captionText, hashtagsText].filter(Boolean).join("\n\n");
}

export function canPublishRow(row) {
  const contentPack = normalizeContentPack(row?.content_pack) || {};
  const assetUrl = pickFirstAssetUrl(contentPack, row);
  return Boolean(assetUrl) && isAssetReadyStatus(statusLc(row?.status));
}