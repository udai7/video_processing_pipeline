import argon2 from "argon2";
import { randomInt } from "node:crypto";
import { pool } from "../db/pool.js";

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export type OtpPurpose = "register" | "login";

/**
 * Random 6-digit code (100000–999999) from the CSPRNG. Must not use
 * Math.random(): its output is predictable from previously observed values,
 * which would let an attacker who can request their own codes guess someone
 * else's.
 */
function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Issue a fresh OTP for a user+purpose, invalidating any prior unconsumed ones.
 * Returns the plaintext code (to email / log); only its hash is stored.
 */
export async function createOtp(userId: string, purpose: OtpPurpose): Promise<string> {
  const code = generateCode();
  const codeHash = await argon2.hash(code);

  await pool.query(
    `UPDATE email_otps SET consumed_at = now()
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose]
  );
  await pool.query(
    `INSERT INTO email_otps (user_id, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [userId, codeHash, purpose, String(TTL_MINUTES)]
  );
  return code;
}

/**
 * Verify a submitted code for a user+purpose. Consumes the code on success;
 * counts failed attempts and locks the code after MAX_ATTEMPTS.
 */
export async function verifyOtp(userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  const { rows } = await pool.query<{ id: string; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM email_otps
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  );
  const otp = rows[0];
  if (!otp || otp.attempts >= MAX_ATTEMPTS) return false;

  const ok = await argon2.verify(otp.code_hash, code).catch(() => false);
  if (!ok) {
    await pool.query("UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1", [otp.id]);
    return false;
  }

  await pool.query("UPDATE email_otps SET consumed_at = now() WHERE id = $1", [otp.id]);
  return true;
}

/** Delete OTP rows that are consumed or expired so the table doesn't grow unbounded. */
export async function cleanupExpiredOtps(): Promise<number> {
  const { rowCount } = await pool.query(
    "DELETE FROM email_otps WHERE consumed_at IS NOT NULL OR expires_at < now()"
  );
  return rowCount ?? 0;
}
