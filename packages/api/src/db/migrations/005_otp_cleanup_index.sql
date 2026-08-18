-- Index the columns the hourly OTP cleanup sweep filters on.
--
-- cleanupExpiredOtps() runs
--   DELETE FROM email_otps WHERE consumed_at IS NOT NULL OR expires_at < now()
-- which had no usable index and fell back to a sequential scan of the whole
-- table every hour.
--
-- A partial index on the live rows is what actually helps: it covers the
-- expiry half of the predicate and stays small, because rows leave it as soon
-- as they are consumed. Verification also reads exactly this set.

CREATE INDEX IF NOT EXISTS email_otps_live_idx
  ON email_otps (expires_at)
  WHERE consumed_at IS NULL;
