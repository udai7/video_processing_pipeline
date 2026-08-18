// Env defaults must be applied before any application module is imported —
// see ./env.ts for why this is a separate side-effect import.
import "./env.js";

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { pool } from "../src/db/pool.js";
import { transcodeQueue } from "../src/queue/producer.js";

export async function makeApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

/** Release shared singletons so the test process can exit cleanly. */
export async function teardown(app: FastifyInstance): Promise<void> {
  await app.close();
  await transcodeQueue.close();
  await pool.end();
}

export const uniqueEmail = (): string =>
  `t_${Date.now()}_${Math.random().toString(36).slice(2)}@test.com`;

/** A complete registration payload; override fields as needed. */
export const registerPayload = (over: Record<string, unknown> = {}) => ({
  email: uniqueEmail(),
  password: "password123",
  firstName: "Test",
  lastName: "User",
  phone: "+1 555 0100",
  ...over,
});

/**
 * Register a fresh user and return their bearer token, completing the email
 * OTP challenge when 2FA is enabled (the dev code is returned by the API when
 * SMTP is unconfigured, as it is in tests).
 */
export async function registerUser(app: FastifyInstance): Promise<string> {
  const payload = registerPayload();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload });
  const body = reg.json();
  if (body.token) return body.token as string; // 2FA disabled

  const ver = await app.inject({
    method: "POST",
    url: "/api/auth/verify-otp",
    payload: { email: payload.email, code: body.devCode, purpose: "register" },
  });
  return ver.json().token as string;
}
