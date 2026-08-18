import { Pool } from "pg";
import type { JobStage, VideoStatus, VideoMetadata } from "@vp/shared";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function getVideo(
  id: string
): Promise<{ original_filename: string; user_id: string } | undefined> {
  const { rows } = await pool.query<{ original_filename: string; user_id: string }>(
    "SELECT original_filename, user_id FROM videos WHERE id = $1",
    [id]
  );
  return rows[0];
}

/**
 * Total seconds of successfully-processed video a user already has, excluding
 * one video (the one being processed). Failed videos don't count against the
 * budget. Used to enforce the per-user upload limit.
 */
export async function userDurationSeconds(userId: string, excludeVideoId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM((metadata->>'duration')::float), 0) AS total
       FROM videos
      WHERE user_id = $1 AND id <> $2 AND status <> 'failed'`,
    [userId, excludeVideoId]
  );
  return Number(rows[0]?.total ?? 0);
}

/** IDs of videos older than `days`, for the retention reaper. */
export async function expiredVideoIds(days: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM videos WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return rows.map((r) => r.id);
}

/** Delete a video row (jobs cascade). Storage is cleared separately. */
export async function deleteVideoRow(id: string): Promise<void> {
  await pool.query("DELETE FROM videos WHERE id = $1", [id]);
}

/**
 * Mark a video failed from outside the pipeline, for jobs that died without
 * their catch block running (crash, SIGKILL, stalled out of retries). Leaves
 * videos that already reached a terminal state alone.
 */
export async function failVideo(videoId: string, message: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE videos SET status = 'failed'
      WHERE id = $1 AND status NOT IN ('completed', 'failed')`,
    [videoId]
  );
  if (!rowCount) return false;
  await pool.query(
    `UPDATE jobs
        SET error_message = $2, logs = logs || $3, updated_at = now()
      WHERE video_id = $1`,
    [videoId, message, `\n[error] ${message}\n`]
  );
  return true;
}

/**
 * Fail videos left mid-pipeline with no job progress for `staleMinutes` — the
 * case where the queue entry itself is gone (Redis wiped, job dropped) so no
 * failure event will ever arrive. Returns the ids it reaped.
 */
export async function failStalledVideos(staleMinutes: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH stalled AS (
       SELECT v.id FROM videos v
         JOIN jobs j ON j.video_id = v.id
        WHERE v.status NOT IN ('completed', 'failed')
          AND j.updated_at < now() - ($1 || ' minutes')::interval
     ), marked AS (
       UPDATE videos SET status = 'failed'
        WHERE id IN (SELECT id FROM stalled) RETURNING id
     )
     UPDATE jobs
        SET error_message = 'Processing stalled — no progress reported; marked failed.',
            logs = logs || '\n[error] processing stalled; marked failed\n',
            updated_at = now()
      WHERE video_id IN (SELECT id FROM marked)
     RETURNING video_id AS id`,
    [String(staleMinutes)]
  );
  return rows.map((r) => r.id);
}

export async function setStatus(videoId: string, status: VideoStatus): Promise<void> {
  await pool.query("UPDATE videos SET status = $2 WHERE id = $1", [videoId, status]);
}

export async function setMetadata(videoId: string, metadata: VideoMetadata): Promise<void> {
  await pool.query("UPDATE videos SET metadata = $2::jsonb WHERE id = $1", [
    videoId,
    JSON.stringify(metadata),
  ]);
}

export async function setMasterKey(videoId: string, key: string): Promise<void> {
  await pool.query("UPDATE videos SET master_playlist_key = $2 WHERE id = $1", [videoId, key]);
}

/** Update the job's progress and/or current stage. */
export async function updateJob(
  videoId: string,
  fields: { progress?: number; stage?: JobStage }
): Promise<void> {
  await pool.query(
    `UPDATE jobs
       SET progress = COALESCE($2, progress),
           stage = COALESCE($3, stage),
           updated_at = now()
     WHERE video_id = $1`,
    [videoId, fields.progress ?? null, fields.stage ?? null]
  );
}

/** Append to the job's running log. */
export async function appendLog(videoId: string, text: string): Promise<void> {
  await pool.query(
    "UPDATE jobs SET logs = logs || $2, updated_at = now() WHERE video_id = $1",
    [videoId, text]
  );
}

/** Record a failure: persist the error message and append it to the logs. */
export async function setError(videoId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE jobs
       SET error_message = $2,
           logs = logs || $3,
           attempts = attempts + 1,
           updated_at = now()
     WHERE video_id = $1`,
    [videoId, message, `\n[error] ${message}\n`]
  );
}
