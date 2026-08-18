import path from "node:path";
import { runFfmpeg } from "../ffmpeg/run.js";

const COUNT = 6;

/**
 * Stage 3 — extract 6 evenly-spaced JPEG frames.
 * Reports progress across the 95%→98% band. Returns the local file paths.
 */
export async function thumbnails(
  source: string,
  workDir: string,
  duration: number,
  report: (pct: number) => void
): Promise<string[]> {
  const files: string[] = [];

  for (let i = 0; i < COUNT; i++) {
    const t = duration > 0 ? (duration * (i + 0.5)) / COUNT : 0;
    const file = path.join(workDir, `thumb_${i}.jpg`);
    // Input seeking (-ss before -i) is fast and accurate enough for thumbnails.
    await runFfmpeg(["-ss", String(t), "-i", source, "-frames:v", "1", "-vf", "scale=-2:360", file]);
    report(95 + ((i + 1) / COUNT) * 3);
    files.push(file);
  }

  return files;
}
