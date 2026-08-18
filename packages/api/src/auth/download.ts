import type { FastifyRequest } from "fastify";

/** Cookie carrying a download grant, and how long that grant lives (seconds). */
export const DOWNLOAD_COOKIE = "vp_download";
export const DOWNLOAD_TTL = 300;

/**
 * Read one cookie off the raw Cookie header. The app sets a single, tightly
 * path-scoped cookie, so this avoids pulling in a cookie plugin.
 */
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
