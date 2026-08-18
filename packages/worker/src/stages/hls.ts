import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runFfmpeg } from "../ffmpeg/run.js";
import type { Rendition } from "../renditions.js";

// Encoder settings. The defaults are pure software x264, which works
// everywhere. On a box with a GPU, set FFMPEG_VIDEO_ENCODER=h264_nvenc (plus a
// preset that encoder understands, e.g. FFMPEG_PRESET=p4) and optionally
// FFMPEG_HWACCEL=cuda to decode on the GPU too. Left unset, nothing changes.
const ENCODER = process.env.FFMPEG_VIDEO_ENCODER ?? "libx264";
const PRESET = process.env.FFMPEG_PRESET ?? "veryfast";
const HWACCEL = process.env.FFMPEG_HWACCEL;

/**
 * Assemble the ffmpeg arguments for the single-pass ladder. Split out from the
 * run itself so the command can be asserted on in tests without invoking
 * ffmpeg.
 */
export function buildHlsArgs(
  source: string,
  outDir: string,
  renditions: Rendition[],
  hasAudio: boolean
): string[] {
  const names = renditions.map((r) => `${r.height}p`);

  // [0:v]split=N[v0]…[vN-1];[v0]scale=-2:h[v0o];…
  const split = `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join("")}`;
  const scales = renditions.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}o]`);
  const filter = [split, ...scales].join(";");

  // -hwaccel without an output format leaves decoded frames in system memory,
  // so the split/scale filter chain below is unaffected by it.
  const args = [
    ...(HWACCEL ? ["-hwaccel", HWACCEL] : []),
    "-i", source,
    "-filter_complex", filter,
  ];

  renditions.forEach((r, i) => {
    args.push(
      "-map", `[v${i}o]`,
      `-c:v:${i}`, ENCODER,
      "-profile:v", "main",
      "-preset", PRESET,
      `-b:v:${i}`, r.videoBitrate,
      `-maxrate:v:${i}`, r.videoBitrate,
      `-bufsize:v:${i}`, r.videoBitrate
    );
  });

  // Sources without an audio track exist (screen recordings, silent clips);
  // mapping a:0 there would abort the run.
  if (hasAudio) {
    renditions.forEach((r, i) => {
      args.push("-map", "a:0", `-c:a:${i}`, "aac", `-b:a:${i}`, r.audioBitrate);
    });
  }

  const varStreamMap = names
    .map((name, i) => (hasAudio ? `v:${i},a:${i},name:${name}` : `v:${i},name:${name}`))
    .join(" ");

  args.push(
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outDir, "%v", "seg_%03d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varStreamMap,
    path.join(outDir, "%v", "index.m3u8")
  );

  return args;
}

/**
 * Build the whole ABR ladder in one ffmpeg invocation: decode once, split the
 * video into one branch per rendition, and let the hls muxer segment each
 * variant and write the master playlist.
 *
 * The previous shape encoded each rendition to an intermediate mp4 and then ran
 * a second ffmpeg per rendition to segment it — four decodes of the source and
 * a full set of temporary files for output we throw away. It also hand-wrote
 * the master playlist without CODECS attributes, so players could not tell what
 * they were about to fetch.
 *
 * Returns the local output dir, containing master.m3u8 and one dir per rendition.
 */
export async function packageHls(
  source: string,
  workDir: string,
  renditions: Rendition[],
  duration: number,
  hasAudio: boolean,
  report: (pct: number) => void
): Promise<string> {
  const outDir = path.join(workDir, "out");
  // The hls muxer writes into these but will not create them.
  await Promise.all(
    renditions.map((r) => mkdir(path.join(outDir, `${r.height}p`), { recursive: true }))
  );

  const args = buildHlsArgs(source, outDir, renditions, hasAudio);

  const START = 10;
  const SPAN = 85; // 10% → 95%; finalize owns the rest
  await runFfmpeg(args, {
    onProgress: (sec) => {
      const frac = duration > 0 ? Math.min(sec / duration, 1) : 0;
      report(START + frac * SPAN);
    },
  });
  report(START + SPAN);

  return outDir;
}
