// Test environment defaults, in a module of their own.
//
// These MUST be set before any application module is evaluated, because
// modules like src/storage/s3.ts read process.env at import time. ESM hoists
// all static imports and evaluates them before the importing module's own
// statements run, so assignments written above the imports in helpers.ts would
// still land too late. A side-effect-only import placed first does work, since
// imported modules are evaluated in source order.
//
// Real values (set by CI or the shell) always win.
process.env.NODE_ENV ||= "test"; // disables rate limiting so tests can hammer auth
process.env.JWT_SECRET ||= "test-secret-please-ignore-0123456789";
process.env.DATABASE_URL ||= "postgres://vp:secret@localhost:5432/video_processing";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.MINIO_ENDPOINT ||= "localhost";
process.env.MINIO_PORT ||= "9000";
process.env.MINIO_USE_SSL ||= "false";
process.env.MINIO_ROOT_USER ||= "minioadmin";
process.env.MINIO_ROOT_PASSWORD ||= "minioadmin";
process.env.BUCKET_INPUTS ||= "inputs";
process.env.BUCKET_OUTPUTS ||= "outputs";
process.env.BUCKET_THUMBS ||= "thumbnails";
process.env.SIGNED_URL_TTL ||= "3600";
