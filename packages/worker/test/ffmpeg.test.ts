import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseTimeSeconds } from "../src/ffmpeg/run.js";

describe("parseTimeSeconds", () => {
  test("parses an ffmpeg progress line", () => {
    assert.equal(
      parseTimeSeconds("frame= 120 fps= 30 q=28.0 size=  512kB time=00:00:04.00 bitrate="),
      4
    );
  });

  test("handles hours, minutes and fractional seconds together", () => {
    assert.equal(parseTimeSeconds("time=01:02:03.50"), 3723.5);
  });

  test("returns null when the line carries no timestamp", () => {
    assert.equal(parseTimeSeconds("[libx264 @ 0x55] using cpu capabilities: MMX2 SSE2"), null);
    assert.equal(parseTimeSeconds(""), null);
  });
});
