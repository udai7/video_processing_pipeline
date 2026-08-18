import { Worker } from "bullmq";
import { TRANSCODE_QUEUE, type TranscodeJobData } from "@vp/shared";
import { processVideo } from "./pipeline.js";
import { startMaintenance } from "./maintenance.js";
import { pool, failVideo } from "./db.js";

const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
  maxRetriesPerRequest: null, // required by BullMQ workers
};
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

const worker = new Worker<TranscodeJobData>(
  TRANSCODE_QUEUE,
  async (job) => {
    await processVideo(job.data.videoId);
  },
  { connection, concurrency }
);

worker.on("completed", (job) => console.log(`completed ${job.data.videoId}`));
worker.on("failed", (job, err) => {
  console.error(`failed ${job?.data.videoId}: ${err.message}`);
  if (!job) return;

  // Once the retries are spent, make sure the video reaches a terminal state.
  // The pipeline's own catch handles ordinary errors, but a job that stalled
  // out (worker killed mid-encode) never ran it — the video would otherwise
  // sit in 'transcoding' forever and the dashboard would poll it forever.
  const remaining = (job.opts.attempts ?? 1) - job.attemptsMade;
  if (remaining > 0) return;
  failVideo(job.data.videoId, err.message)
    .then((changed) => changed && console.log(`marked ${job.data.videoId} failed`))
    .catch((e) => console.error("could not mark video failed:", e));
});

startMaintenance(); // periodic retention sweep (auto-delete old videos)

/**
 * Finish the in-flight transcode before exiting. Every `docker compose up -d`
 * sends SIGTERM; without this the container is SIGKILLed after the grace period
 * and an hour of encoding is thrown away mid-job. worker.close() stops taking
 * new jobs and waits for the active one, so the redeploy costs at most one
 * job's remaining runtime instead of losing it.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second signal must not race the first
  shuttingDown = true;
  console.log(`${signal} received — finishing in-flight job, then exiting`);
  try {
    await worker.close();
    await pool.end();
    console.log("worker shut down cleanly");
    process.exit(0);
  } catch (err) {
    console.error("error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`worker up — queue=${TRANSCODE_QUEUE} concurrency=${concurrency}`);
