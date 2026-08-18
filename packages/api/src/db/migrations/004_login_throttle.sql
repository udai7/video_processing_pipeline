-- Per-account login throttling.
--
-- Rate limiting is keyed on client IP, which a distributed credential-stuffing
-- run walks straight through. These columns throttle by account instead, so
-- attempts against one email are capped no matter where they come from.

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
