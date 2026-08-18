import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import { registerAuth } from "./auth/jwt.js";
import { authRoutes } from "./routes/auth.js";
import { videoRoutes } from "./routes/videos.js";
import { streamRoutes } from "./routes/streams.js";
import { ensureBuckets } from "./storage/s3.js";
import { cleanupExpiredOtps } from "./auth/otp.js";
import { pool } from "./db/pool.js";
import { transcodeQueue } from "./queue/producer.js";

const port = Number(process.env.API_PORT ?? 3000);

/**
 * Build the fully-wired Fastify app without listening. Exported so tests can
 * drive it via `app.inject(...)`; `start()` adds the network listener.
 */
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // trustProxy so rate-limiting keys on the real client IP (nginx sets
  // X-Forwarded-For), not the gateway's address.
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true });

  // Global rate limit (generous default). Sensitive auth routes tighten this
  // per-route via `config.rateLimit`. Skipped entirely under test.
  if (process.env.NODE_ENV !== "test") {
    await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  }

  // JWT plugin + `authenticate` preHandler (awaited so routes inherit them).
  await registerAuth(app);

  // Streaming multipart uploads (single file, capped at MAX_UPLOAD_BYTES).
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 ** 3),
      files: 1,
    },
    throwFileSizeLimit: false,
  });

  // Best-effort bucket creation; don't block API boot if MinIO is down.
  try {
    await ensureBuckets();
  } catch (err) {
    app.log.warn({ err }, "could not ensure MinIO buckets at startup");
  }

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(videoRoutes, { prefix: "/api/videos" });
  await app.register(streamRoutes, { prefix: "/api/videos" });

  return app;
}

async function start() {
  const app = await buildApp();

  // Periodically purge consumed/expired OTP rows (hourly). unref so it never
  // holds the process open on its own.
  const otpSweep = setInterval(() => {
    cleanupExpiredOtps()
      .then((n) => n && app.log.info(`cleaned up ${n} expired OTP row(s)`))
      .catch((err) => app.log.warn({ err }, "OTP cleanup failed"));
  }, 3_600_000);
  otpSweep.unref();

  // Drain in-flight requests and release the pool/queue connections on the
  // signals Docker and Ctrl-C send, rather than dropping them on SIGKILL.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received — draining requests`);
    try {
      await app.close();
      await transcodeQueue.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host: "0.0.0.0" });
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
