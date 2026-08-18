import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectRenditions } from "../src/renditions.js";

describe("selectRenditions", () => {
  test("drops rungs taller than the source — never upscales", () => {
    assert.deepEqual(
      selectRenditions(480).map((r) => r.height),
      [360, 480]
    );
  });

  test("returns the full ladder for a tall source", () => {
    assert.deepEqual(
      selectRenditions(1080).map((r) => r.height),
      [360, 480, 720]
    );
  });

  test("includes a rung exactly matching the source height", () => {
    assert.deepEqual(
      selectRenditions(720).map((r) => r.height),
      [360, 480, 720]
    );
  });

  test("encodes at source height when the source is below the ladder", () => {
    assert.deepEqual(selectRenditions(240), [
      { height: 240, videoBitrate: "600k", audioBitrate: "96k" },
    ]);
  });

  test("rounds an odd source height down to even (H.264 needs even dimensions)", () => {
    assert.equal(selectRenditions(241)[0].height, 240);
  });

  test("never produces a height below 2", () => {
    assert.equal(selectRenditions(1)[0].height, 2);
    assert.equal(selectRenditions(0)[0].height, 2);
  });
});
