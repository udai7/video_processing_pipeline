import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runFfmpeg } from "../ffmpeg/run.js";
import type { Rendition } from "../renditions.js";

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
  const names = renditions.map((r) => `${r.height}p`);
  // The hls muxer writes into these but will not create them.
  await Promise.all(names.map((n) => mkdir(path.join(outDir, n), { recursive: true })));

  // [0:v]split=N[v0]…[vN-1];[v0]scale=-2:h[v0o];…
  const split = `[0:v]split=${renditions.length}${renditions.map((_, i) => `[v${i}]`).join("")}`;
  const scales = renditions.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}o]`);
  const filter = [split, ...scales].join(";");

  const args = ["-i", source, "-filter_complex", filter];

  renditions.forEach((r, i) => {
    args.push(
      "-map", `[v${i}o]`,
      `-c:v:${i}`, "libx264",
      "-profile:v", "main",
      "-preset", process.env.FFMPEG_PRESET ?? "veryfast",
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
