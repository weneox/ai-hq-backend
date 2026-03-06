// src/kernel/debate/utils.js

export function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

export function withTimeout(promise, ms, label = "timeout") {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), t)),
  ]);
}

export async function mapLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  let i = 0;

  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await worker(arr[idx], idx);
    }
  });

  await Promise.all(runners);
  return out;
}

export function s(x) {
  return typeof x === "string" ? x : "";
}

export function sDeep(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    if (typeof x.value === "string") return x.value;
    if (typeof x.text === "string") return x.text;
  }
  return "";
}

export function asObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

export function asArr(x) {
  return Array.isArray(x) ? x : [];
}

export function uniqStrings(arr = []) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function truncate(s0, n) {
  const t = String(s0 || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)).trim() + "…";
}

export function fixMojibake(input) {
  const t = String(input || "");
  if (!t) return t;
  if (!/[ÃÂ]|â€™|â€œ|â€�|â€“|â€”|â€¦/.test(t)) return t;

  try {
    const fixed = Buffer.from(t, "latin1").toString("utf8");
    if (/[�]/.test(fixed) && !/[�]/.test(t)) return t;
    return fixed;
  } catch {
    return t;
  }
}

export function cleanText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lower(input) {
  return cleanText(input).toLowerCase();
}

export function extractText(resp) {
  if (!resp) return "";

  const direct = s(resp.output_text).trim();
  if (direct) return fixMojibake(direct);

  const out = resp.output;
  if (Array.isArray(out)) {
    const parts = [];

    for (const item of out) {
      if (item?.type === "message" && Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (block?.type === "output_text") {
            const t = sDeep(block?.text).trim();
            if (t) parts.push(t);
          } else {
            const t1 = sDeep(block?.text).trim();
            if (t1) parts.push(t1);
            const tr = sDeep(block?.transcript).trim();
            if (tr) parts.push(tr);
          }
        }
        continue;
      }

      const content = item?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "output_text") {
            const t = sDeep(block?.text).trim();
            if (t) parts.push(t);
            continue;
          }
          const t1 = sDeep(block?.text).trim();
          if (t1) parts.push(t1);
          const tr = sDeep(block?.transcript).trim();
          if (tr) parts.push(tr);
        }
      } else if (typeof content === "string") {
        const t = content.trim();
        if (t) parts.push(t);
      }

      const tItem = sDeep(item?.text).trim();
      if (tItem) parts.push(tItem);
    }

    const joined = parts.join("\n").trim();
    if (joined) return fixMojibake(joined);
  }

  try {
    const seen = new Set();
    const parts = [];

    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (typeof node.output_text === "string") parts.push(node.output_text);

      if (node.type === "output_text") {
        const t = sDeep(node.text);
        if (t) parts.push(t);
      }

      if (typeof node.text === "string") parts.push(node.text);
      if (
        node.text &&
        typeof node.text === "object" &&
        typeof node.text.value === "string"
      ) {
        parts.push(node.text.value);
      }

      if (typeof node.transcript === "string") parts.push(node.transcript);

      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") walk(v);
      }
    };

    walk(resp);
    const joined = parts.join("\n").trim();
    if (joined) return fixMojibake(joined);
  } catch {}

  return "";
}

export function stripLeadingJunkToJsonCandidate(t) {
  const s0 = String(t || "").trim();
  if (!s0) return "";
  const fence = s0.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return String(fence[1] || "").trim();
  const start = s0.indexOf("{");
  const end = s0.lastIndexOf("}");
  if (start >= 0 && end > start) return s0.slice(start, end + 1).trim();
  return s0;
}

export function extractJsonFromText(text) {
  const s0 = String(text || "").trim();
  if (!s0) return null;

  try {
    return JSON.parse(s0);
  } catch {}

  const cand = stripLeadingJunkToJsonCandidate(s0);
  if (cand && cand !== s0) {
    try {
      return JSON.parse(cand);
    } catch {}
  }

  return null;
}