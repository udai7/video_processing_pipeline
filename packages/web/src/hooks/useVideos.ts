import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Video } from "../types";

const TERMINAL = new Set(["completed", "failed"]);

// Poll fast right after something changes, then ease off. A transcode can run
// for minutes; a fixed 1s interval meant one full list query per second per
// open tab for the entire duration.
const MIN_DELAY = 1000;
const MAX_DELAY = 10_000;
const FACTOR = 1.5;

/** Changes when any video's progress or status moves. */
function signature(videos: Video[]): string {
  return videos.map((v) => `${v.id}:${v.status}:${v.progress ?? ""}`).join("|");
}

/**
 * Polls the video list while any video is still processing, backing off from
 * 1s to 10s while nothing changes and snapping back to 1s as soon as something
 * does. Stops once everything is in a terminal state; calling `refresh` after
 * an upload brings back a pending video and restarts it.
 */
export function useVideos(enabled: boolean) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [error, setError] = useState<string | null>(null);
  const delay = useRef(MIN_DELAY);
  const previous = useRef("");

  const refresh = useCallback(async () => {
    try {
      const next = await api.listVideos();
      const sig = signature(next);
      delay.current =
        sig === previous.current ? Math.min(delay.current * FACTOR, MAX_DELAY) : MIN_DELAY;
      previous.current = sig;
      setVideos(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load videos");
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      previous.current = "";
      delay.current = MIN_DELAY;
      setVideos([]);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  // Each refresh produces a new `videos` array, re-running this effect and
  // scheduling the next poll — a self-driving loop that halts on its own once
  // nothing is in flight.
  const pending = videos.some((v) => !TERMINAL.has(v.status));
  useEffect(() => {
    if (!enabled || !pending) return;
    const id = window.setTimeout(() => void refresh(), delay.current);
    return () => window.clearTimeout(id);
  }, [enabled, pending, videos, refresh]);

  return { videos, error, refresh };
}
