import { test, describe } from "node:test";
import assert from "node:assert/strict";
import "./env.js";
import { safeFilename } from "../src/storage/s3.js";

describe("safeFilename", () => {
  test("keeps an ordinary name intact", () => {
    assert.equal(safeFilename("my-clip_v2.mp4"), "my-clip_v2.mp4");
  });

  test("strips directory separators", () => {
    assert.equal(safeFilename("../../etc/passwd"), "passwd");
    assert.equal(safeFilename("a/b/c.mp4"), "c.mp4");
    assert.equal(safeFilename("C:\\windows\\evil.mp4"), "evil.mp4");
  });

  test("never yields a traversal segment or a dotfile", () => {
    assert.equal(safeFilename(".."), "upload");
    assert.equal(safeFilename("..."), "upload");
    assert.equal(safeFilename(".hidden"), "hidden");
  });

  test("removes characters that would break a header", () => {
    assert.equal(safeFilename('a"b\r\nX-Evil: 1.mp4'), "a_b__X-Evil__1.mp4");
  });

  test("falls back for empty or missing input", () => {
    assert.equal(safeFilename(""), "upload");
    assert.equal(safeFilename(undefined), "upload");
  });

  test("caps the length", () => {
    assert.equal(safeFilename("a".repeat(500)).length, 200);
  });
});
