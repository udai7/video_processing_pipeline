import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { makeApp, teardown, registerPayload } from "./helpers.js";

/**
 * Account lockout at the default threshold. The thresholds are read when the
 * route module is first evaluated, which ESM does before this file's own
 * statements run, so a test cannot lower them — it uses the real defaults.
 * The IP-keyed limiter is off under NODE_ENV=test, so this exercises the
 * per-account path in isolation, which is the point of it.
 */
const THRESHOLD = 10;
describe("login throttle", () => {
  let app: FastifyInstance;
  const payload = registerPayload();

  before(async () => {
    app = await makeApp();
    await app.inject({ method: "POST", url: "/api/auth/register", payload });
  });
  after(async () => teardown(app));

  const attempt = (password: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: payload.email, password },
    });

  test("locks the account after repeated failures, then rejects even the right password", async () => {
    for (let i = 0; i < THRESHOLD; i++) {
      assert.equal((await attempt("wrong-password")).statusCode, 401);
    }

    // Locked: further attempts are refused before the password is checked,
    // so a stuffing run gains nothing by continuing.
    const locked = await attempt("wrong-password");
    assert.equal(locked.statusCode, 429);

    const correct = await attempt(payload.password as string);
    assert.equal(correct.statusCode, 429);
  });

  test("an unrelated account is unaffected", async () => {
    const other = registerPayload();
    await app.inject({ method: "POST", url: "/api/auth/register", payload: other });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: other.email, password: other.password },
    });
    assert.equal(res.statusCode, 200);
  });
});
