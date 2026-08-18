import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildHlsArgs } from "../src/stages/hls.js";
import { selectRenditions } from "../src/renditions.js";

/** Value following `flag` in an argv array. */
function argFor(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe("buildHlsArgs", () => {
  const ladder = selectRenditions(1080); // 360p, 480p, 720p

  test("decodes the source once and splits it per rendition", () => {
    const args = buildHlsArgs("/in/source", "/out", ladder, true);
    assert.equal(args.filter((a) => a === "-i").length, 1);
    assert.equal(
      argFor(args, "-filter_complex"),
      "[0:v]split=3[v0][v1][v2];[v0]scale=-2:360[v0o];[v1]scale=-2:480[v1o];[v2]scale=-2:720[v2o]"
    );
  });

  test("names variants by height so the output keys stay stable", () => {
    const args = buildHlsArgs("/in/source", "/out", ladder, true);
    assert.equal(argFor(args, "-var_stream_map"), "v:0,a:0,name:360p v:1,a:1,name:480p v:2,a:2,name:720p");
    assert.equal(argFor(args, "-hls_segment_filename"), "/out/%v/seg_%03d.ts");
    assert.equal(argFor(args, "-master_pl_name"), "master.m3u8");
    assert.equal(args.at(-1), "/out/%v/index.m3u8");
  });

  test("omits all audio mapping when the source has no audio track", () => {
    const args = buildHlsArgs("/in/source", "/out", ladder, false);
    assert.equal(args.includes("a:0"), false);
    assert.equal(args.some((a) => a.startsWith("-c:a")), false);
    assert.equal(argFor(args, "-var_stream_map"), "v:0,name:360p v:1,name:480p v:2,name:720p");
  });

  test("caps the bitrate of every rendition", () => {
    const args = buildHlsArgs("/in/source", "/out", ladder, true);
    ladder.forEach((r, i) => {
      assert.equal(argFor(args, `-b:v:${i}`), r.videoBitrate);
      assert.equal(argFor(args, `-maxrate:v:${i}`), r.videoBitrate);
      assert.equal(argFor(args, `-bufsize:v:${i}`), r.videoBitrate);
    });
  });

  test("handles a single-rendition ladder", () => {
    const args = buildHlsArgs("/in/source", "/out", selectRenditions(240), true);
    assert.equal(argFor(args, "-filter_complex"), "[0:v]split=1[v0];[v0]scale=-2:240[v0o]");
    assert.equal(argFor(args, "-var_stream_map"), "v:0,a:0,name:240p");
  });
});
