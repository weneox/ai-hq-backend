import { cfg } from "../config.js";
import { deepFix } from "../utils/textFix.js";
import { pollMediaJob } from "../services/media/mediaExecutionRunner.js";

function clean(x) {
  return String(x || "").trim();
}

export function createMediaJobWorker({ db }) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running || !db) return;
    running = true;

    try {
      const q = await db.query(
        `select id, tenant_id, tenant_key, proposal_id, type, status, input, output, error, created_at, started_at, finished_at
         from jobs
         where status = 'running'
           and type in ('video.generate','assembly.render')
         order by created_at asc
         limit $1`,
        [Number(cfg.MEDIA_JOB_WORKER_BATCH_SIZE || 10)]
      );

      for (const row of q.rows || []) {
        try {
          row.input = deepFix(row.input || {});
          row.output = deepFix(row.output || {});
          await pollMediaJob({ db, job: row });
        } catch (e) {
          console.error(
            "[media-worker] poll failed",
            row.id,
            clean(e?.message || e)
          );
        }
      }
    } catch (e) {
      console.error("[media-worker] tick error:", clean(e?.message || e));
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (!cfg.MEDIA_JOB_WORKER_ENABLED || timer) return;
      timer = setInterval(
        tick,
        Number(cfg.MEDIA_JOB_WORKER_INTERVAL_MS || 15000)
      );
      timer.unref?.();
      tick().catch(() => {});
      console.log(
        `[media-worker] started interval=${Number(
          cfg.MEDIA_JOB_WORKER_INTERVAL_MS || 15000
        )}ms batch=${Number(cfg.MEDIA_JOB_WORKER_BATCH_SIZE || 10)}`
      );
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log("[media-worker] stopped");
    },
  };
}