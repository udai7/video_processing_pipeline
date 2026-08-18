import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

const useSsl = process.env.MINIO_USE_SSL === "true";
const endpoint = `${useSsl ? "https" : "http"}://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`;

/** Bucket names (configurable via env, defaults match architecture.md §4). */
export const BUCKETS = {
  inputs: process.env.BUCKET_INPUTS ?? "inputs",
  outputs: process.env.BUCKET_OUTPUTS ?? "outputs",
  thumbs: process.env.BUCKET_THUMBS ?? "thumbnails",
} as const;

// MinIO is S3-compatible; path-style + static creds. Swap endpoint -> S3/R2 by config only.
export const s3 = new S3Client({
  endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER ?? "",
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? "",
  },
});

/**
 * Reduce a client-supplied filename to a single safe path segment.
 *
 * The raw value is attacker-controlled and ends up in an object key, in the
 * database, and in a Content-Disposition header. Separators would let a key
 * escape its `<videoId>/` prefix, and CR/LF would break the header.
 */
export function safeFilename(name: string | undefined): string {
  const base = (name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_") // keep it to an unambiguous alphabet
    .replace(/^\.+/, "") // no leading dots: no "..", no hidden files
    .slice(0, 200);
  return cleaned || "upload";
}

/** Deterministic key for a video's source upload (worker reconstructs the same key). */
export function inputKey(videoId: string, filename: string): string {
  return `${videoId}/${filename}`;
}

/** Create any missing buckets. Called once at startup. */
export async function ensureBuckets(): Promise<void> {
  for (const bucket of Object.values(BUCKETS)) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}

/** Stream a body into object storage without buffering the whole file in memory. */
export async function uploadStream(
  bucket: string,
  key: string,
  body: Readable,
  contentType?: string
): Promise<void> {
  await new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
  }).done();
}

/** Delete every object under a key prefix (used when removing a video). */
export async function deletePrefix(bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    const objects = list.Contents?.map((o) => ({ Key: o.Key! })) ?? [];
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}
