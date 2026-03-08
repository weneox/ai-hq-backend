import { deepFix, fixText } from "../../utils/textFix.js";
import { lc, parseMaybeJson } from "./proposals.shared.js";

export function hasPublishLink(latestContent) {
  if (!latestContent) return false;

  const publish = parseMaybeJson(latestContent.publish) || latestContent.publish || null;
  const contentPack =
    parseMaybeJson(latestContent.content_pack) || latestContent.content_pack || null;

  return !!(
    latestContent?.permalink ||
    publish?.permalink ||
    contentPack?.permalink ||
    contentPack?.publish?.permalink
  );
}

export function deriveUiStatusFromProposalAndContent(proposal, latestContent) {
  const pStatus = lc(proposal?.status);
  const cStatus = lc(latestContent?.status);
  const publishedByLink = hasPublishLink(latestContent);

  if (
    pStatus === "published" ||
    cStatus === "published" ||
    cStatus === "posted" ||
    cStatus === "live" ||
    cStatus === "publish.done" ||
    cStatus === "publish.completed" ||
    publishedByLink
  ) {
    return "published";
  }

  if (pStatus === "rejected") {
    return "rejected";
  }

  if (
    pStatus === "approved" ||
    cStatus === "approved" ||
    cStatus === "asset.ready" ||
    cStatus === "assets.ready" ||
    cStatus === "publish.ready" ||
    cStatus === "ready"
  ) {
    return "approved";
  }

  return "draft";
}

export function matchesRequestedUiStatus(requestedStatus, proposal, latestContent) {
  const uiStatus = deriveUiStatusFromProposalAndContent(proposal, latestContent);
  return uiStatus === requestedStatus;
}

export function mapLatestContent(row, includePack) {
  if (!row?.content_id) return null;

  const publishObj = deepFix(row.content_publish || null);

  return {
    id: row.content_id,
    status: row.content_status,
    updated_at: row.content_updated_at,
    last_feedback: row.content_last_feedback || null,
    publish: publishObj,
    ...(includePack ? { content_pack: deepFix(row.content_pack) } : {}),
  };
}

export function mapProposalRow(row, includeContent, includePack) {
  const p = {
    id: row.id,
    thread_id: row.thread_id,
    agent: row.agent,
    type: row.type,
    status: row.status,
    title: fixText(row.title),
    payload: deepFix(row.payload),
    created_at: row.created_at,
    decided_at: row.decided_at,
    decision_by: row.decision_by,
  };

  if (includeContent) {
    p.latestContent = mapLatestContent(row, includePack);
    p.uiStatus = deriveUiStatusFromProposalAndContent(p, p.latestContent);
  } else {
    p.uiStatus = deriveUiStatusFromProposalAndContent(p, null);
  }

  return p;
}