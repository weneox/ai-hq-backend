import { cfg } from "../../config.js";
import { deepFix } from "../../utils/textFix.js";
import { dbUpdateJob } from "../../db/helpers/jobs.js";
import { elevenlabsGenerateSpeech } from "./elevenlabsVoice.js";
import {
  cloudinaryUploadBuffer,
  cloudinaryUploadFromUrl,
} from "./cloudinaryUpload.js";
import {
  runwayCreateVideoTask,
  runwayGetTask,
  pickRunwayVideoUrl,
} from "./runwayVideo.js";
import {
  creatomateCreateRender,
  creatomateGetRender,
  pickCreatomateRenderUrl,
} from "./creatomateRender.js";

function clean(x) {
  return String(x || "").trim();
}

function lower(x) {
  return clean(x).toLowerCase();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = clean(v);
    if (s) return s;
  }
  return "";
}

function normalizeAspectRatioToRunwayRatio(input) {
  const x = clean(input);
  if (x === "16:9") return "1280:720";
  if (x === "1:1") return "1080:1080";
  if (x === "4:5") return "864:1080";
  if (x === "9:16") return "720:1280";
  if (
    x === "1280:720" ||
    x === "1080:1080" ||
    x === "864:1080" ||
    x === "720:1280"
  ) {
    return x;
  }
  return "720:1280";
}

function normalizeDuration(v, fallback = 5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(10, Math.round(n)));
}

function callbackUrl() {
  const base = clean(cfg.PUBLIC_BASE_URL);
  if (!base) throw new Error("PUBLIC_BASE_URL is missing");
  return `${base.replace(/\/+$/, "")}/api/executions/callback`;
}

async function postExecutionCallback({ jobId, status, result = {}, error = "" }) {
  const token = clean(cfg.N8N_CALLBACK_TOKEN);
  if (!token) throw new Error("N8N_CALLBACK_TOKEN is missing");

  const res = await fetch(callbackUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-token": token,
    },
    body: JSON.stringify({
      jobId,
      status,
      ...(error ? { error } : {}),
      result: deepFix(result),
    }),
  });

  const text = await res.text().catch(() => "");
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok || json?.ok === false) {
    throw new Error(
      json?.error || json?.raw || `callback_failed_${res.status}`
    );
  }

  return json;
}

async function getJobById(db, jobId) {
  const q = await db.query(
    `select id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
     from jobs
     where id = $1::uuid
     limit 1`,
    [jobId]
  );

  const row = q.rows?.[0] || null;
  if (!row) return null;

  row.input = deepFix(row.input || {});
  row.output = deepFix(row.output || {});
  return row;
}

async function markRunning(db, jobId, outputPatch = {}) {
  return dbUpdateJob(db, jobId, {
    status: "running",
    started_at: new Date().toISOString(),
    output: deepFix(outputPatch),
  });
}

function buildVoiceInput(job) {
  const input = isObject(job?.input) ? job.input : {};
  const cp = isObject(input?.contentPack) ? input.contentPack : {};

  return {
    text: firstNonEmpty(
      input?.voiceoverText,
      input?.voiceover_text,
      cp?.voiceoverText,
      cp?.voiceover_text,
      cp?.caption,
      cp?.copy?.caption,
      cp?.post?.caption
    ),
    voiceId: firstNonEmpty(
      input?.voiceId,
      input?.voice_id,
      cp?.voiceId,
      cp?.voice_id
    ),
    tenantKey: clean(job?.tenant_key || input?.tenantKey || input?.tenant_key),
  };
}

function buildVideoInput(job) {
  const input = isObject(job?.input) ? job.input : {};
  const cp = isObject(input?.contentPack) ? input.contentPack : {};

  return {
    promptText: firstNonEmpty(
      input?.videoPrompt,
      input?.video_prompt,
      cp?.videoPrompt,
      cp?.video_prompt,
      cp?.visualPlan?.prompt,
      cp?.caption
    ),
    promptImage: firstNonEmpty(
      input?.promptImage,
      input?.imageUrl,
      input?.image_url,
      cp?.imageUrl,
      cp?.image_url,
      cp?.coverUrl
    ),
    aspectRatio: firstNonEmpty(
      input?.aspectRatio,
      input?.aspect_ratio,
      cp?.aspectRatio,
      cp?.aspect_ratio,
      "9:16"
    ),
    duration: normalizeDuration(input?.duration || cp?.duration || 5, 5),
    seed: input?.seed ?? cp?.seed ?? null,
    tenantKey: clean(job?.tenant_key || input?.tenantKey || input?.tenant_key),
  };
}

function buildRenderInput(job) {
  const input = isObject(job?.input) ? job.input : {};
  const cp = isObject(input?.contentPack) ? input.contentPack : {};

  return {
    templateId: clean(
      input?.templateId ||
        input?.template_id ||
        cp?.templateId ||
        cp?.template_id ||
        cfg.CREATOMATE_TEMPLATE_ID_REEL
    ),
    videoUrl: firstNonEmpty(
      input?.videoUrl,
      input?.video_url,
      cp?.renderUrl,
      cp?.render_url,
      cp?.videoUrl,
      cp?.video?.videoUrl
    ),
    voiceoverUrl: firstNonEmpty(
      input?.voiceoverUrl,
      input?.voiceover_url,
      cp?.voiceoverUrl,
      cp?.voiceover?.url
    ),
    caption: firstNonEmpty(
      input?.caption,
      cp?.caption,
      cp?.copy?.caption,
      cp?.post?.caption
    ),
    cta: firstNonEmpty(input?.cta, cp?.cta, cp?.post?.cta),
    logoUrl: firstNonEmpty(input?.logoUrl, input?.logo_url, cp?.logoUrl),
    headline: firstNonEmpty(
      input?.headline,
      input?.title,
      cp?.title,
      cp?.headline,
      cp?.hook
    ),
    tenantKey: clean(job?.tenant_key || input?.tenantKey || input?.tenant_key),
  };
}

export async function runMediaJobNow({ db, jobId }) {
  const job = await getJobById(db, jobId);
  if (!job) throw new Error("job_not_found");

  const jt = lower(job.type);

  if (job.status === "completed" || job.status === "failed") {
    return { ok: true, skipped: true, reason: "already_finished" };
  }

  if (jt === "voice.generate") {
    const voice = buildVoiceInput(job);
    if (!voice.text) throw new Error("voice_text_missing");

    await markRunning(db, job.id, { phase: "voice.generating" });

    const out = await elevenlabsGenerateSpeech({
      text: voice.text,
      voiceId: voice.voiceId || undefined,
    });

    const uploaded = await cloudinaryUploadBuffer({
      buffer: out.buffer,
      filename: `voiceover-${job.id}.${out.ext || "mp3"}`,
      mimeType: out.mimeType || "audio/mpeg",
      db,
      tenantKey: voice.tenantKey || null,
      folder: [voice.tenantKey || "public", "voiceovers"].join("/"),
      resourceType: "video",
      tags: ["voiceover", "elevenlabs", voice.tenantKey || "public"],
      context: {
        tenantKey: voice.tenantKey || "",
        provider: "elevenlabs",
        kind: "voiceover",
        jobId: String(job.id),
      },
    });

    await postExecutionCallback({
      jobId: job.id,
      status: "completed",
      result: {
        proposalId: job.proposal_id,
        tenantId: job.tenant_id,
        tenantKey: job.tenant_key,
        provider: "elevenlabs",
        voiceover: {
          provider: "elevenlabs",
          url: uploaded.url,
        },
        voiceoverUrl: uploaded.url,
      },
    });

    return { ok: true, jobId: job.id, type: jt, mode: "sync_complete" };
  }

  if (jt === "video.generate") {
    const video = buildVideoInput(job);
    if (!video.promptText) throw new Error("video_prompt_missing");

    const task = await runwayCreateVideoTask({
      promptText: video.promptText,
      ratio: normalizeAspectRatioToRunwayRatio(video.aspectRatio),
      duration: video.duration,
      seed: video.seed,
      promptImage: video.promptImage,
    });

    await markRunning(db, job.id, {
      phase: "video.generating",
      runway: {
        taskId: task?.id || task?.taskId || null,
        status: task?.status || "PENDING",
      },
      taskId: task?.id || task?.taskId || null,
      provider: "runway",
    });

    return {
      ok: true,
      jobId: job.id,
      type: jt,
      mode: "async_started",
      taskId: task?.id || task?.taskId || null,
    };
  }

  if (jt === "assembly.render") {
    const render = buildRenderInput(job);
    if (!render.videoUrl) throw new Error("render_video_missing");

    const created = await creatomateCreateRender({
      templateId: render.templateId,
      modifications: {
        video: render.videoUrl,
        voiceover: render.voiceoverUrl,
        caption: render.caption,
        cta: render.cta,
        logo: render.logoUrl,
        headline: render.headline,
      },
    });

    await markRunning(db, job.id, {
      phase: "render.generating",
      creatomate: {
        renderId: created?.id || null,
        status: created?.status || null,
      },
      renderId: created?.id || null,
      provider: "creatomate",
    });

    return {
      ok: true,
      jobId: job.id,
      type: jt,
      mode: "async_started",
      renderId: created?.id || null,
    };
  }

  if (jt === "qa.check") {
    const input = isObject(job?.input) ? job.input : {};
    const cp = isObject(input?.contentPack) ? input.contentPack : {};

    const hasVideo = !!firstNonEmpty(
      cp?.renderUrl,
      cp?.videoUrl,
      input?.videoUrl
    );
    const hasVoice = !!firstNonEmpty(
      cp?.voiceoverUrl,
      cp?.voiceover?.url,
      input?.voiceoverUrl
    );
    const hasCaption = !!firstNonEmpty(
      cp?.caption,
      cp?.copy?.caption,
      cp?.post?.caption
    );

    const score = hasVideo ? (hasVoice ? 92 : 78) : 40;
    const qaStatus = score >= 80 ? "passed" : score >= 60 ? "warning" : "failed";

    await markRunning(db, job.id, { phase: "qa.checking" });

    await postExecutionCallback({
      jobId: job.id,
      status: "completed",
      result: {
        proposalId: job.proposal_id,
        tenantId: job.tenant_id,
        tenantKey: job.tenant_key,
        provider: "ai_hq",
        qaStatus,
        score,
        checks: {
          hasVideo,
          hasVoice,
          hasCaption,
        },
        summary:
          qaStatus === "passed"
            ? "Media pack QA passed."
            : qaStatus === "warning"
            ? "Media pack QA warning."
            : "Media pack QA failed.",
      },
    });

    return { ok: true, jobId: job.id, type: jt, mode: "sync_complete" };
  }

  return { ok: true, skipped: true, reason: "not_media_job", type: jt };
}

export async function pollMediaJob({ db, job }) {
  const jt = lower(job?.type);

  if (jt === "video.generate") {
    const taskId = clean(
      job?.output?.taskId ||
        job?.output?.runway?.taskId ||
        job?.output?.runway?.task_id
    );
    if (!taskId) return { ok: false, reason: "missing_task_id" };

    const task = await runwayGetTask(taskId);
    const status = lower(task?.status);

    if (status === "succeeded" || status === "completed") {
      const videoUrl = pickRunwayVideoUrl(task);
      if (!videoUrl) return { ok: false, reason: "missing_video_url" };

      let uploaded = null;
      try {
        uploaded = await cloudinaryUploadFromUrl({
          sourceUrl: videoUrl,
          db,
          tenantKey: clean(job?.tenant_key),
          folder: [clean(job?.tenant_key) || "public", "runway"].join("/"),
          resourceType: "video",
          tags: ["runway", clean(job?.tenant_key) || "public"],
          context: {
            tenantKey: clean(job?.tenant_key),
            provider: "runway",
            kind: "scene_video",
            jobId: String(job.id),
          },
        });
      } catch {
        uploaded = null;
      }

      await postExecutionCallback({
        jobId: job.id,
        status: "completed",
        result: {
          proposalId: job.proposal_id,
          tenantId: job.tenant_id,
          tenantKey: job.tenant_key,
          provider: "runway",
          video: {
            provider: "runway",
            taskId,
            videoUrl: uploaded?.url || videoUrl,
          },
          videoUrl: uploaded?.url || videoUrl,
        },
      });

      return { ok: true, done: true };
    }

    if (status === "failed" || status === "canceled") {
      await postExecutionCallback({
        jobId: job.id,
        status: "failed",
        error: task?.failure || task?.error || "runway_failed",
        result: {
          proposalId: job.proposal_id,
          tenantId: job.tenant_id,
          tenantKey: job.tenant_key,
          provider: "runway",
          taskId,
        },
      });
      return { ok: true, done: true };
    }

    return { ok: true, done: false, status: task?.status || null };
  }

  if (jt === "assembly.render") {
    const renderId = clean(
      job?.output?.renderId || job?.output?.creatomate?.renderId
    );
    if (!renderId) return { ok: false, reason: "missing_render_id" };

    const render = await creatomateGetRender(renderId);
    const status = lower(render?.status);
    const url = pickCreatomateRenderUrl(render);

    if (status === "succeeded" || status === "completed") {
      await postExecutionCallback({
        jobId: job.id,
        status: "completed",
        result: {
          proposalId: job.proposal_id,
          tenantId: job.tenant_id,
          tenantKey: job.tenant_key,
          provider: "creatomate",
          render: {
            provider: "creatomate",
            renderId,
            url: url || null,
          },
          renderUrl: url || null,
          videoUrl: url || null,
        },
      });
      return { ok: true, done: true };
    }

    if (status === "failed") {
      await postExecutionCallback({
        jobId: job.id,
        status: "failed",
        error: render?.error || "creatomate_failed",
        result: {
          proposalId: job.proposal_id,
          tenantId: job.tenant_id,
          tenantKey: job.tenant_key,
          provider: "creatomate",
          renderId,
        },
      });
      return { ok: true, done: true };
    }

    return { ok: true, done: false, status: render?.status || null };
  }

  return { ok: true, skipped: true };
}