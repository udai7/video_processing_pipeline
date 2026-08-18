import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import FormData from "form-data";
import type { FastifyInstance } from "fastify";
import { teardown, registerUser } from "./helpers.js";

/**
 * Oversized uploads, exercised against an app built with a tiny
 * MAX_UPLOAD_BYTES so the limit is reachable in a test.
 */
describe("upload limits", () => {
  let app: FastifyInstance;
  let token: string;

  before(async () => {
    process.env.MAX_UPLOAD_BYTES = "64";
    const { buildApp } = await import("../src/server.js");
    app = await buildApp({ logger: false });
    token = await registerUser(app);
  });
  after(async () => {
    delete process.env.MAX_UPLOAD_BYTES;
    await teardown(app);
  });

  test("a file over the limit is rejected with 413 and creates no video", async () => {
    const form = new FormData();
    form.append("file", Buffer.alloc(4096, "x"), {
      filename: "big.mp4",
      contentType: "video/mp4",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/videos",
      headers: { ...form.getHeaders(), authorization: `Bearer ${token}` },
      payload: form.getBuffer(),
    });
    assert.equal(res.statusCode, 413);

    const list = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(list.json().videos, []);
  });
});
