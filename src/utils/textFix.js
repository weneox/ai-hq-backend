const MOJIBAKE_RE = /Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦|Ð.|Ñ.|Ø.|Þ.|Ý.|ý|þ|ð/;

function scoreTextQuality(s) {
  if (typeof s !== "string") return 0;
  const str = s;

  const moj = (str.match(MOJIBAKE_RE) || []).length;
  const repl = (str.match(/\uFFFD/g) || []).length;
  const good = (str.match(/[əğıöüşçƏĞİÖÜŞÇ]/g) || []).length;
  const letters =
    (str.match(/[A-Za-z0-9\u00C0-\u024F\u0400-\u04FFəğıöüşçƏĞİÖÜŞÇ]/g) || [])
      .length;
  const total = Math.max(1, str.length);

  return good * 3 + (letters / total) * 10 - moj * 4 - repl * 20;
}

function tryFixMojibake(s) {
  if (typeof s !== "string") return s;
  const str = s;
  if (!MOJIBAKE_RE.test(str)) return str;

  let candidate = str;
  try {
    candidate = Buffer.from(str, "latin1").toString("utf8");
  } catch {
    return str;
  }

  const a = scoreTextQuality(str);
  const b = scoreTextQuality(candidate);
  return b > a ? candidate : str;
}

export function fixText(x) {
  if (typeof x !== "string") return x;
  return tryFixMojibake(x);
}

export function deepFix(obj) {
  if (obj == null) return obj;
  if (typeof obj === "string") return fixText(obj);
  if (Array.isArray(obj)) return obj.map(deepFix);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepFix(v);
    return out;
  }
  return obj;
}