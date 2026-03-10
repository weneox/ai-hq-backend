// src/utils/roles.js
// FINAL — role matrix + permission helpers for AI HQ

const ROLE_ORDER = ["member", "operator", "marketer", "analyst", "admin", "owner"];

const ROLE_PERMISSIONS = {
  owner: {
    settings: { read: true, write: true },
    workspace: { manage: true },
    channels: { read: true, write: true },
    agents: { read: true, write: true },
    inbox: { read: true, write: true, handoff: true },
    leads: { read: true, write: true },
    comments: { read: true, write: true },
    proposals: { read: true, write: true, decide: true, publish: true },
    content: { read: true, write: true, approve: true, publish: true },
    executions: { read: true, write: true },
    analytics: { read: true, write: true },
    audit: { read: true },
    users: { read: true, write: true },
  },

  admin: {
    settings: { read: true, write: true },
    workspace: { manage: true },
    channels: { read: true, write: true },
    agents: { read: true, write: true },
    inbox: { read: true, write: true, handoff: true },
    leads: { read: true, write: true },
    comments: { read: true, write: true },
    proposals: { read: true, write: true, decide: true, publish: true },
    content: { read: true, write: true, approve: true, publish: true },
    executions: { read: true, write: true },
    analytics: { read: true, write: true },
    audit: { read: true },
    users: { read: true, write: true },
  },

  operator: {
    settings: { read: true, write: false },
    workspace: { manage: false },
    channels: { read: true, write: false },
    agents: { read: true, write: false },
    inbox: { read: true, write: true, handoff: true },
    leads: { read: true, write: true },
    comments: { read: true, write: true },
    proposals: { read: true, write: false, decide: false, publish: false },
    content: { read: true, write: false, approve: false, publish: false },
    executions: { read: true, write: false },
    analytics: { read: true, write: false },
    audit: { read: false },
    users: { read: false, write: false },
  },

  marketer: {
    settings: { read: true, write: false },
    workspace: { manage: false },
    channels: { read: true, write: false },
    agents: { read: true, write: false },
    inbox: { read: true, write: false, handoff: false },
    leads: { read: true, write: false },
    comments: { read: true, write: true },
    proposals: { read: true, write: true, decide: false, publish: false },
    content: { read: true, write: true, approve: false, publish: false },
    executions: { read: true, write: false },
    analytics: { read: true, write: true },
    audit: { read: false },
    users: { read: false, write: false },
  },

  analyst: {
    settings: { read: true, write: false },
    workspace: { manage: false },
    channels: { read: true, write: false },
    agents: { read: true, write: false },
    inbox: { read: true, write: false, handoff: false },
    leads: { read: true, write: false },
    comments: { read: true, write: false },
    proposals: { read: true, write: false, decide: false, publish: false },
    content: { read: true, write: false, approve: false, publish: false },
    executions: { read: true, write: false },
    analytics: { read: true, write: true },
    audit: { read: true },
    users: { read: false, write: false },
  },

  member: {
    settings: { read: true, write: false },
    workspace: { manage: false },
    channels: { read: true, write: false },
    agents: { read: true, write: false },
    inbox: { read: true, write: false, handoff: false },
    leads: { read: true, write: false },
    comments: { read: true, write: false },
    proposals: { read: true, write: false, decide: false, publish: false },
    content: { read: true, write: false, approve: false, publish: false },
    executions: { read: true, write: false },
    analytics: { read: true, write: false },
    audit: { read: false },
    users: { read: false, write: false },
  },
};

export function normalizeRole(role) {
  const r = String(role || "").trim().toLowerCase();
  return ROLE_PERMISSIONS[r] ? r : "member";
}

export function getRoleRank(role) {
  return ROLE_ORDER.indexOf(normalizeRole(role));
}

export function hasMinRole(role, minRole) {
  return getRoleRank(role) >= getRoleRank(minRole);
}

export function getRolePermissions(role) {
  return ROLE_PERMISSIONS[normalizeRole(role)];
}

export function can(role, resource, action = "read") {
  const perms = getRolePermissions(role);
  return !!perms?.[resource]?.[action];
}

export function canManageSettings(role) {
  return can(role, "settings", "write");
}

export function canWriteWorkspace(role) {
  return can(role, "settings", "write");
}

export function canWriteChannel(role) {
  return can(role, "channels", "write");
}

export function canWriteAgent(role) {
  return can(role, "agents", "write");
}

export function canReadAudit(role) {
  return can(role, "audit", "read");
}

export function canReadUsers(role) {
  return can(role, "users", "read");
}

export function canWriteUsers(role) {
  return can(role, "users", "write");
}

export function canWriteInbox(role) {
  return can(role, "inbox", "write");
}

export function canWriteLeads(role) {
  return can(role, "leads", "write");
}

export function canWriteComments(role) {
  return can(role, "comments", "write");
}

export function canWriteContent(role) {
  return can(role, "content", "write");
}

export function canApproveContent(role) {
  return can(role, "content", "approve");
}

export function canPublishContent(role) {
  return can(role, "content", "publish");
}

export function canDecideProposal(role) {
  return can(role, "proposals", "decide");
}

export function isOwner(role) {
  return normalizeRole(role) === "owner";
}

export function isAdminLike(role) {
  const r = normalizeRole(role);
  return r === "owner" || r === "admin";
}

export function safeViewerRole(role) {
  return normalizeRole(role);
}