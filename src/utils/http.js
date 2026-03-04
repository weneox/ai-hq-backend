export function okJson(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(payload);
}

export function clamp(nv, a, b) {
  const x = Number(nv);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

export function serializeError(err) {
  const e = err || {};
  const isAgg = e && (e.name === "AggregateError" || Array.isArray(e.errors));
  const base = {
    name: e.name || "Error",
    message: e.message || String(e),
    stack: e.stack || null,
  };
  if (isAgg) {
    base.errors = (e.errors || []).map((x) => ({
      name: x?.name || "Error",
      message: x?.message || String(x),
      stack: x?.stack || null,
    }));
  }
  if (e.cause) {
    base.cause = {
      name: e.cause?.name,
      message: e.cause?.message || String(e.cause),
      stack: e.cause?.stack || null,
    };
  }
  return base;
}

export function isUuid(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

export function isDigits(v) {
  const s = String(v || "").trim();
  return /^[0-9]{1,12}$/.test(s);
}

export function nowIso() {
  return new Date().toISOString();
}

export function isDbReady(db) {
  return Boolean(db && typeof db.query === "function");
}

export function normalizeDecision(d) {
  let decision = String(d || "").trim().toLowerCase();
  if (decision === "approve") decision = "approved";
  if (decision === "reject") decision = "rejected";
  return decision;
}

export function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "approved" || s === "rejected" || s === "published";
}