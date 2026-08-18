import { Queue } from "bullmq";
import { TRANSCODE_QUEUE, type TranscodeJobData } from "@vp/shared";

const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: url.hostname, port: Number(url.port) || 6379 };

export const transcodeQueue = new Queue<TranscodeJobData>(TRANSCODE_QUEUE, { connection });

/**
 * Enqueue a transcode job. Retries with exponential backoff are handled by
 * BullMQ. The job id is the video id so the job stays addressable — see
 * cancelTranscode.
 */
export async function enqueueTranscode(videoId: string): Promise<void> {
  await transcodeQueue.add(
    "transcode",
    { videoId },
    {
      jobId: videoId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}

/**
 * Drop a video's queued job, best effort. Returns false when the job is
 * already running — BullMQ will not remove a locked job, so the worker
 * re-checks that the video still exists before it writes anything.
 */
export async function cancelTranscode(videoId: string): Promise<boolean> {
  try {
    const job = await transcodeQueue.getJob(videoId);
    if (!job) return true;
    await job.remove();
    return true;
  } catch {
    return false;
  }
}
