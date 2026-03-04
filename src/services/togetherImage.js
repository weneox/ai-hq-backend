export async function togetherGenerateImage({ prompt, n = 1 }) {
  const apiKey = String(process.env.TOGETHER_API_KEY || "").trim();
  if (!apiKey) throw new Error("TOGETHER_API_KEY not set");

  const model = String(process.env.TOGETHER_IMAGE_MODEL || "ideogram/ideogram-3.0").trim();

  // FIX: ideogram-3.0 üçün steps/width/height göndərmirik
  const body = {
    model,
    prompt: String(prompt || "").trim(),
    n: Number(n) || 1,
    response_format: "url",
  };

  const r = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `Together error (${r.status})`;
    throw new Error(msg);
  }

  const url = data?.data?.[0]?.url || "";
  if (!url) throw new Error("Together returned no url");

  return { url, raw: data };
}