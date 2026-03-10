// src/utils/tenantSecretsCrypto.js

import crypto from "crypto";
import { cfg } from "../config.js";

function s(v) {
  return String(v ?? "").trim();
}

function getMasterKeyBuffer() {
  const raw = s(cfg.TENANT_SECRET_MASTER_KEY);

  if (!raw) {
    throw new Error("TENANT_SECRET_MASTER_KEY is missing");
  }

  // 64 hex => exactly 32 bytes
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) {
      throw new Error("TENANT_SECRET_MASTER_KEY hex must decode to 32 bytes");
    }
    return buf;
  }

  // fallback: derive stable 32-byte key from plain string
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function fromBase64(value, fieldName) {
  const raw = s(value);
  if (!raw) {
    throw new Error(`${fieldName} is missing`);
  }

  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${fieldName} is invalid base64`);
  }
}

export function maskSecret(value) {
  const v = s(value);
  if (!v) return "";

  if (v.length <= 4) {
    return `${v.slice(0, 1)}***`;
  }

  if (v.length <= 8) {
    return `${v.slice(0, 2)}***${v.slice(-1)}`;
  }

  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

export function encryptTenantSecret(value) {
  const plain = s(value);
  if (!plain) {
    throw new Error("Secret value is required");
  }

  const key = getMasterKeyBuffer();
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Invalid tenant secret master key length");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const enc1 = cipher.update(plain, "utf8");
  const enc2 = cipher.final();
  const tag = cipher.getAuthTag();

  return {
    secret_value_enc: Buffer.concat([enc1, enc2]).toString("base64"),
    secret_value_iv: iv.toString("base64"),
    secret_value_tag: tag.toString("base64"),
  };
}

export function decryptTenantSecret(row) {
  if (!row || typeof row !== "object") {
    throw new Error("Encrypted secret row is missing");
  }

  const enc = fromBase64(row.secret_value_enc, "secret_value_enc");
  const iv = fromBase64(row.secret_value_iv, "secret_value_iv");
  const tag = fromBase64(row.secret_value_tag, "secret_value_tag");

  if (iv.length !== 12) {
    throw new Error("secret_value_iv must be 12 bytes for aes-256-gcm");
  }

  if (tag.length !== 16) {
    throw new Error("secret_value_tag must be 16 bytes for aes-256-gcm");
  }

  const key = getMasterKeyBuffer();
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Invalid tenant secret master key length");
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const dec1 = decipher.update(enc);
    const dec2 = decipher.final();

    return Buffer.concat([dec1, dec2]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt tenant secret");
  }
}