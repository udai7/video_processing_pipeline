import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { makeApp, teardown } from "./helpers.js";

describe("health", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await makeApp();
  });
  after(async () => teardown(app));

  test("liveness answers without touching dependencies", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  test("readiness reports every dependency", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ready");
    assert.deepEqual(
      body.checks.map((c: { name: string }) => c.name).sort(),
      ["postgres", "redis", "storage"]
    );
    assert.ok(body.checks.every((c: { ok: boolean }) => c.ok));
  });
});
