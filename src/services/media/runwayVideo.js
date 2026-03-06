// src/services/media/runwayVideo.js

const RUNWAY_API_BASE = "https://api.dev.runwayml.com";
const RUNWAY_API_VERSION = "2024-11-06";

function clean(s) {
  return String(s || "").trim();
}

function getApiKey() {
  return clean(process.env.RUNWAY_API_KEY);
}

function getModel() {
  // Official docs currently show gen4.5 for text-to-video examples.
  return clean(process.env.RUNWAY_VIDEO_MODEL || "gen4.5");
}

function getDurationSeconds(duration) {
  const n = Number(duration || 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(2, Math.min(10, Math.round(n)));
}

function getRatio(input) {
  const v = clean(input);
  if (v === "720:1280" || v === "1280:720" || v === "1080:1920" || v === "1920:1080") {
    return v;
  }
  return "720:1280";
}

async function runwayFetch(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("RUNWAY_API_KEY is missing");
  }

  const res = await fetch(`${RUNWAY_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": RUNWAY_API_VERSION,
      ...(options.headers || {}),
    },
  });

  const text = await res.text().catch(() => "");
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      json?.error ||
        json?.message ||
        json?.raw ||
        `Runway API error (${res.status})`
    );
  }

  return json;
}

export async function runwayCreateVideoTask({
  promptText,
  ratio = "720:1280",
  duration = 5,
  seed,
  promptImage = "",
}) {
  const prompt = clean(promptText);
  if (!prompt) {
    throw new Error("promptText is required");
  }

  const body = {
    model: getModel(),
    promptText: prompt,
    ratio: getRatio(ratio),
    duration: getDurationSeconds(duration),
  };

  // Optional image-to-video mode
  if (clean(promptImage)) {
    body.promptImage = clean(promptImage);
  }

  if (Number.isFinite(Number(seed))) {
    body.seed = Number(seed);
  }

  // Official endpoint for text-to-video / image-to-video generation
  return runwayFetch("/v1/text_to_video", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function runwayGetTask(taskId) {
  const id = clean(taskId);
  if (!id) throw new Error("taskId is required");

  return runwayFetch(`/v1/tasks/${id}`, {
    method: "GET",
  });
}

export function pickRunwayVideoUrl(task) {
  const output = task?.output;

  if (Array.isArray(output) && output[0]) {
    if (typeof output[0] === "string") return output[0];
    if (typeof output[0]?.url === "string") return output[0].url;
  }

  if (typeof output === "string") return output;
  if (typeof output?.url === "string") return output.url;

  // some tasks may expose url in nested fields depending on response shape
  if (typeof task?.artifactURL === "string") return task.artifactURL;
  if (typeof task?.videoUrl === "string") return task.videoUrl;

  return "";
}