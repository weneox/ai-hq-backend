import { cfg } from "../../config.js";

function clean(x) {
  return String(x || "").trim();
}

function getApiKey() {
  return clean(cfg.ELEVENLABS_API_KEY);
}

function getDefaultVoiceId() {
  return clean(cfg.ELEVENLABS_VOICE_ID);
}

function getModelId() {
  return clean(cfg.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2");
}

async function elevenFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is missing");
  }

  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...options,
    headers: {
      "xi-api-key": apiKey,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `ElevenLabs API error (${res.status})`);
  }

  return res;
}

export async function elevenlabsGenerateSpeech({
  text,
  voiceId,
  modelId,
  outputFormat = "mp3_44100_128",
} = {}) {
  const finalText = clean(text);
  if (!finalText) throw new Error("text is required");

  const finalVoiceId = clean(voiceId || getDefaultVoiceId());
  if (!finalVoiceId) throw new Error("ELEVENLABS_VOICE_ID is missing");

  const finalModelId = clean(modelId || getModelId());

  const body = {
    text: finalText,
    model_id: finalModelId,
    output_format: outputFormat,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.8,
      style: 0.2,
      use_speaker_boost: true,
    },
  };

  const res = await elevenFetch(`/v1/text-to-speech/${finalVoiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);

  return {
    ok: true,
    provider: "elevenlabs",
    voiceId: finalVoiceId,
    modelId: finalModelId,
    mimeType: "audio/mpeg",
    buffer,
    bytes: buffer.length,
    ext: "mp3",
  };
}