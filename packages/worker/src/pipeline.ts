import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import {
  getVideo,
  setStatus,
  setMetadata,
  setMasterKey,
  updateJob,
  appendLog,
  setError,
  userDurationSeconds,
} from "./db.js";
import { BUCKETS, downloadTo, deletePrefix, inputKey } from "./storage.js";

// Per-user total upload budget in seconds (default 10 minutes).
const MAX_USER_SECONDS = Number(process.env.MAX_VIDEO_SECONDS_PER_USER ?? 600);
import { probe } from "./ffmpeg/probe.js";
import { selectRenditions } from "./renditions.js";
import { transcode } from "./stages/transcode.js";
import { thumbnails } from "./stages/thumbnails.js";
import { packageHls } from "./stages/package.js";
import { finalize } from "./stages/finalize.js";

/** Raised when the video row disappears mid-pipeline (the user deleted it). */
class VideoDeleted extends Error {
  constructor(videoId: string) {
    super(`video ${videoId} was deleted during processing`);
  }
}

/**
 * Abort if the video is gone. Deleting a video removes its row and files, but
 * a job already running cannot be cancelled from the API — without this check
 * the pipeline would happily upload outputs afterwards, leaving objects that
 * no row references and the retention sweep never reaches.
 */
async function assertStillExists(videoId: string): Promise<void> {
  if (!(await getVideo(videoId))) throw new VideoDeleted(videoId);
}

/** Throttle progress writes to one DB update per whole-percent change. */
function makeReporter(videoId: string): (pct: number) => void {
  let last = -1;
  return (pct) => {
    const p = Math.round(pct);
    if (p !== last) {
      last = p;
      void updateJob(videoId, { progress: p }).catch(() => {});
    }
  };
}

/**
 * Run the full pipeline for one video. On any failure, marks the video
 * `failed` and persists a readable error, then rethrows so BullMQ retries.
 * Stages write to deterministic keys, so retries are idempotent.
 */
export async function processVideo(videoId: string): Promise<void> {
  const video = await getVideo(videoId);
  if (!video) throw new Error(`video ${videoId} not found`);

  const workDir = path.join(os.tmpdir(), `vp-${videoId}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const report = makeReporter(videoId);

  try {
    const source = path.join(workDir, "source");
    await downloadTo(BUCKETS.inputs, inputKey(videoId, video.original_filename), source);

    // 1. Analyze
    await setStatus(videoId, "analyzing");
    await updateJob(videoId, { stage: "analyze" });
    const meta = await probe(source);
    await setMetadata(videoId, meta);
    await appendLog(videoId, `[analyze] ${meta.width ?? "?"}x${meta.height} ${meta.duration}s\n`);

    // Enforce the per-user upload budget now that we know this video's duration.
    // Over-budget uploads are failed and their source deleted — no retry.
    const used = await userDurationSeconds(video.user_id, videoId);
    if (used + meta.duration > MAX_USER_SECONDS) {
      const limitMin = Math.round(MAX_USER_SECONDS / 60);
      const msg =
        `Upload rejected: this ${Math.round(meta.duration)}s video would exceed your ` +
        `${limitMin}-minute total upload limit (${Math.round(used)}s already used).`;
      await setStatus(videoId, "failed");
      await setError(videoId, msg);
      await deletePrefix(BUCKETS.inputs, `${videoId}/`).catch(() => {});
      await appendLog(videoId, `[analyze] ${msg}\n`);
      return; // nothing to retry
    }
    report(5);

    const renditions = selectRenditions(meta.height);

    // 2. Transcode
    await setStatus(videoId, "transcoding");
    await updateJob(videoId, { stage: "transcode" });
    await appendLog(videoId, `[transcode] ${renditions.map((r) => `${r.height}p`).join(", ")}\n`);
    const rends = await transcode(source, workDir, renditions, meta.duration, report);

    // 3. Thumbnails
    await setStatus(videoId, "thumbnails");
    await updateJob(videoId, { stage: "thumbnails" });
    const thumbs = await thumbnails(source, workDir, meta.duration, report);

    // 4. Package HLS
    await setStatus(videoId, "packaging");
    await updateJob(videoId, { stage: "package" });
    const outDir = await packageHls(rends, workDir, meta, report);

    // 5. Finalize
    await assertStillExists(videoId); // don't upload outputs for a deleted video
    await updateJob(videoId, { stage: "finalize" });
    await finalize(videoId, outDir, thumbs, report);
    await assertStillExists(videoId); // deleted while uploading — clean up below
    await setMasterKey(videoId, `${videoId}/master.m3u8`);
    await setStatus(videoId, "completed");
    await updateJob(videoId, { progress: 100 });
    await appendLog(videoId, "[done] completed\n");
  } catch (err) {
    if (err instanceof VideoDeleted) {
      // No row to mark and nothing to retry; just remove anything we uploaded.
      await Promise.all([
        deletePrefix(BUCKETS.outputs, `${videoId}/`),
        deletePrefix(BUCKETS.thumbs, `${videoId}/`),
        deletePrefix(BUCKETS.inputs, `${videoId}/`),
      ]).catch(() => {});
      console.log(err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(videoId, "failed").catch(() => {});
    await setError(videoId, message).catch(() => {});
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
