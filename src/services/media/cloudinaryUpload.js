// src/services/media/cloudinaryUpload.js
//
// FINAL v1.1 — tenant-aware Cloudinary upload helper
//
// Goals:
// ✅ Tenant-specific Cloudinary secrets support
// ✅ Global env fallback support
// ✅ Upload by remote URL
// ✅ Image / video / raw resource type support
// ✅ Simple signed upload flow
// ✅ Safe for shared multi-tenant backend

import crypto from "crypto";

function clean(x) {
  return String(x || "").trim();
}

function lower(x) {
  return clean(x).toLowerCase();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sha1Hex(input) {
  return crypto.createHash("sha1").update(String(input || "")).digest("hex");
}

function signCloudinary(paramsToSign, apiSecret) {
  const sorted = Object.keys(paramsToSign)
    .filter((k) => {
      const v = paramsToSign[k];
      return v !== undefined && v !== null && String(v) !== "";
    })
    .sort()
    .map((k) => `${k}=${paramsToSign[k]}`)
    .join("&");

  return sha1Hex(`${sorted}${apiSecret}`);
}

async function fetchTenantCloudinarySecrets(db, tenantKey) {
  if (!db || !tenantKey) return null;

  const q = await db.query(
    `
      select ts.secret_key, ts.secret_value
      from tenant_secrets ts
      join tenants t on t.id = ts.tenant_id
      where lower(t.tenant_key) = $1
        and lower(ts.provider) = 'cloudinary'
    `,
    [lower(tenantKey)]
  );

  const rows = Array.isArray(q?.rows) ? q.rows : [];
  if (!rows.length) return null;

  const out = {};
  for (const row of rows) {
    const k = lower(row?.secret_key);
    if (!k) continue;
    out[k] = clean(row?.secret_value);
  }

  return out;
}

async function resolveCloudinaryConfig({ db, tenantKey }) {
  const tenantSecrets = await fetchTenantCloudinarySecrets(db, tenantKey).catch(
    () => null
  );

  const cloudName =
    clean(tenantSecrets?.cloud_name) || clean(process.env.CLOUDINARY_CLOUD_NAME);

  const apiKey =
    clean(tenantSecrets?.api_key) || clean(process.env.CLOUDINARY_API_KEY);

  const apiSecret =
    clean(tenantSecrets?.api_secret) || clean(process.env.CLOUDINARY_API_SECRET);

  const folder =
    clean(tenantSecrets?.folder) || clean(process.env.CLOUDINARY_FOLDER);

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary config missing");
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder,
    source: tenantSecrets ? "tenant" : "global",
  };
}

function buildContextString(context) {
  if (!isObject(context)) return "";
  return Object.entries(context)
    .map(([k, v]) => `${k}=${String(v ?? "")}`)
    .filter(Boolean)
    .join("|");
}

function normalizeResourceType(v) {
  const x = lower(v);
  if (x === "image" || x === "video" || x === "raw") return x;
  return "image";
}

export async function cloudinaryUploadFromUrl({
  sourceUrl,
  db,
  tenantKey,
  folder = "",
  publicId = "",
  resourceType = "image",
  tags = [],
  context = {},
} = {}) {
  const src = clean(sourceUrl);
  if (!src) throw new Error("sourceUrl required");

  const cfg = await resolveCloudinaryConfig({ db, tenantKey });
  const timestamp = Math.floor(Date.now() / 1000);

  const finalFolder = clean(folder || cfg.folder);
  const finalPublicId = clean(publicId);
  const finalResourceType = normalizeResourceType(resourceType);
  const finalTags = Array.isArray(tags) ? tags.map(clean).filter(Boolean) : [];
  const contextString = buildContextString(context);

  const paramsForSignature = {
    timestamp,
    folder: finalFolder || undefined,
    public_id: finalPublicId || undefined,
    tags: finalTags.length ? finalTags.join(",") : undefined,
    context: contextString || undefined,
  };

  const signature = signCloudinary(paramsForSignature, cfg.apiSecret);

  const params = new URLSearchParams();
  params.set("file", src);
  params.set("api_key", cfg.apiKey);
  params.set("timestamp", String(timestamp));
  params.set("signature", signature);

  if (finalFolder) params.set("folder", finalFolder);
  if (finalPublicId) params.set("public_id", finalPublicId);
  if (finalTags.length) params.set("tags", finalTags.join(","));
  if (contextString) params.set("context", contextString);

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${finalResourceType}/upload`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const text = await r.text().catch(() => "");
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { raw: text };
  }

  if (!r.ok) {
    throw new Error(j?.error?.message || j?.raw || "cloudinary_upload_failed");
  }

  return {
    ok: true,
    provider: "cloudinary",
    source: cfg.source,
    cloudName: cfg.cloudName,
    folder: finalFolder || null,
    publicId: j.public_id || null,
    version: j.version || null,
    resourceType: j.resource_type || finalResourceType,
    format: j.format || null,
    width: j.width || null,
    height: j.height || null,
    duration: j.duration || null,
    bytes: j.bytes || null,
    url: j.secure_url || j.url || null,
    raw: j,
  };
}