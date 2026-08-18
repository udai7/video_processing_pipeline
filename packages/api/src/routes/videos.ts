import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { BUCKETS, inputKey, uploadStream, deletePrefix } from "../storage/s3.js";
import { enqueueTranscode } from "../queue/producer.js";

/** Video routes, mounted under /api/videos. All require authentication. */
export async function videoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // POST /api/videos — stream upload into MinIO, create rows, enqueue transcode.
  app.post("/", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "file is required" });

    const titleField = data.fields.title;
    const title =
      titleField && !Array.isArray(titleField) && titleField.type === "field"
        ? String(titleField.value)
        : data.filename;

    const videoId = randomUUID();
    const key = inputKey(videoId, data.filename);
    await uploadStream(BUCKETS.inputs, key, data.file, data.mimetype);

    if (data.file.truncated) {
      // exceeded MAX_UPLOAD_BYTES — drop the partial object, don't create rows
      await deletePrefix(BUCKETS.inputs, `${videoId}/`);
      return reply.code(413).send({ error: "file too large" });
    }

    await pool.query(
      `INSERT INTO videos (id, user_id, title, original_filename, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [videoId, req.user.id, title, data.filename]
    );
    await pool.query("INSERT INTO jobs (video_id) VALUES ($1)", [videoId]);
    await enqueueTranscode(videoId);

    return reply.code(202).send({ id: videoId, status: "pending" });
  });

  // GET /api/videos — list the current user's videos.
  app.get("/", async (req) => {
    const { rows } = await pool.query(
      `SELECT v.id, v.title, v.original_filename, v.status, v.visibility, v.metadata,
              v.master_playlist_key, v.created_at,
              j.progress, j.stage, j.error_message
       FROM videos v
       LEFT JOIN jobs j ON j.video_id = v.id
       WHERE v.user_id = $1 ORDER BY v.created_at DESC`,
      [req.user.id]
    );
    return { videos: rows };
  });

  // GET /api/videos/:id — detail incl. live progress, stage, and logs.
  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `SELECT v.id, v.title, v.original_filename, v.status, v.visibility, v.metadata,
              v.master_playlist_key, v.created_at,
              j.progress, j.stage, j.logs, j.error_message, j.attempts
       FROM videos v
       LEFT JOIN jobs j ON j.video_id = v.id
       WHERE v.id = $1 AND v.user_id = $2`,
      [id, req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  // PATCH /api/videos/:id — rename (title) and/or set visibility.
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { visibility, title } = (req.body ?? {}) as { visibility?: string; title?: string };

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (visibility !== undefined) {
      if (visibility !== "public" && visibility !== "private")
        return reply.code(400).send({ error: "visibility must be 'public' or 'private'" });
      sets.push(`visibility = $${sets.length + 1}`);
      vals.push(visibility);
    }
    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed) return reply.code(400).send({ error: "title cannot be empty" });
      sets.push(`title = $${sets.length + 1}`);
      vals.push(trimmed);
    }
    if (sets.length === 0) return reply.code(400).send({ error: "nothing to update" });

    vals.push(id, req.user.id);
    const { rows, rowCount } = await pool.query(
      `UPDATE videos SET ${sets.join(", ")}
       WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
       RETURNING id, title, visibility`,
      vals
    );
    if (!rowCount) return reply.code(404).send({ error: "not found" });
    return rows[0];
  });

  // GET /api/videos/:id/download — mint a short-lived URL to the original file.
  // The token lets a plain browser navigation stream the file (see /:id/file).
  app.get("/:id/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      "SELECT original_filename FROM videos WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "not found" });

    const token = app.jwt.sign({ vid: id, scope: "download" }, { expiresIn: 300 });
    return { url: `/api/videos/${id}/file?token=${token}`, filename: rows[0].original_filename };
  });

  // DELETE /api/videos/:id — remove DB rows (jobs cascade) + all stored objects.
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rowCount } = await pool.query(
      "DELETE FROM videos WHERE id = $1 AND user_id = $2",
      [id, req.user.id]
    );
    if (!rowCount) return reply.code(404).send({ error: "not found" });

    await Promise.all([
      deletePrefix(BUCKETS.inputs, `${id}/`),
      deletePrefix(BUCKETS.outputs, `${id}/`),
      deletePrefix(BUCKETS.thumbs, `${id}/`),
    ]);
    return reply.code(204).send();
  });
}
