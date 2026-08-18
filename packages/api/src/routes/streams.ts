import type { FastifyInstance } from "fastify";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import path from "node:path";
import { pool } from "../db/pool.js";
import { s3, BUCKETS } from "../storage/s3.js";
import { isResourceToken, type AnyToken } from "../auth/jwt.js";

// How long a private-stream token stays valid (seconds).
const TTL = Number(process.env.SIGNED_URL_TTL ?? 3600);

const HLS_CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};

async function ownsVideo(userId: string, videoId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM videos WHERE id = $1 AND user_id = $2",
    [videoId, userId]
  );
  return !!rowCount;
}

/**
 * Streaming routes, mounted under /api/videos (separate plugin so they don't
 * inherit the CRUD routes' blanket auth preHandler).
 *
 * All HLS bytes are proxied from a *private* MinIO outputs bucket through the API:
 * public videos are served anonymously (and cacheably), private videos require a
 * short-lived stream token carried on every request by hls.js's xhrSetup.
 */
export async function streamRoutes(app: FastifyInstance) {
  // GET /api/videos/:id/file?token=… — stream the original upload as a download.
  // Authorized by a short-lived download token minted at /:id/download.
  app.get("/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { token } = req.query as { token?: string };
    if (!token) return reply.code(401).send({ error: "unauthorized" });

    try {
      const decoded = app.jwt.verify(token) as AnyToken;
      if (!isResourceToken(decoded) || decoded.scope !== "download" || decoded.vid !== id) {
        throw new Error("bad token");
      }
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const { rows } = await pool.query(
      "SELECT original_filename FROM videos WHERE id = $1",
      [id]
    );
    const filename = rows[0]?.original_filename;
    if (!filename) return reply.code(404).send({ error: "not found" });

    try {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: BUCKETS.inputs, Key: `${id}/${filename}` })
      );
      reply.header("content-type", "application/octet-stream");
      reply.header("content-disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
      if (obj.ContentLength) reply.header("content-length", String(obj.ContentLength));
      return reply.send(obj.Body as Readable);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // GET /api/videos/:id/stream — resolve the playback URL for a completed video.
  app.get("/:id/stream", { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `SELECT status, visibility, master_playlist_key
       FROM videos WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    const v = rows[0];
    if (!v) return reply.code(404).send({ error: "not found" });
    if (v.status !== "completed" || !v.master_playlist_key)
      return reply.code(409).send({ error: "video is not ready for streaming" });

    const url = `/api/videos/${id}/hls/master.m3u8`;
    if (v.visibility === "public") {
      // No token needed; the /hls proxy serves public videos anonymously.
      return { visibility: "public", url };
    }

    // Private: mint a short-lived token scoped to this video. hls.js attaches it
    // as a Bearer header on every (nested) request, so segments stay authorized.
    const token = app.jwt.sign({ vid: id, scope: "stream" }, { expiresIn: TTL });
    return { visibility: "private", url, token, expiresIn: TTL };
  });

  // GET /api/videos/:id/hls/* — auth-aware proxy of HLS objects from MinIO outputs.
  app.get("/:id/hls/*", async (req, reply) => {
    const { id } = req.params as { id: string };
    const subPath = (req.params as Record<string, string>)["*"];

    const { rows } = await pool.query(
      "SELECT visibility, status FROM videos WHERE id = $1",
      [id]
    );
    const v = rows[0];
    if (!v || v.status !== "completed") return reply.code(404).send({ error: "not found" });

    if (v.visibility === "private") {
      let ok = false;
      try {
        const decoded = (await req.jwtVerify()) as AnyToken;
        ok = isResourceToken(decoded)
          ? decoded.scope === "stream" && decoded.vid === id // stream token for this video
          : await ownsVideo(decoded.id, id); // owner's session token
      } catch {
        ok = false;
      }
      if (!ok) return reply.code(401).send({ error: "unauthorized" });
    }

    // Guard against path traversal out of the video's output prefix.
    const safe = path.posix.normalize(subPath);
    if (safe.startsWith("..") || path.posix.isAbsolute(safe))
      return reply.code(400).send({ error: "bad path" });

    try {
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: BUCKETS.outputs, Key: `${id}/${safe}` })
      );
      reply.header(
        "content-type",
        HLS_CONTENT_TYPES[path.extname(safe)] ?? "application/octet-stream"
      );
      reply.header(
        "cache-control",
        v.visibility === "public"
          ? "public, max-age=31536000, immutable" // CDN-cacheable (Step 8)
          : "private, no-store"
      );
      return reply.send(obj.Body as Readable);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });
}
