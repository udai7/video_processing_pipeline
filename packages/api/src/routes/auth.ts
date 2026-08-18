import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { OAuth2Client } from "google-auth-library";
import { pool } from "../db/pool.js";
import { createOtp, verifyOtp, type OtpPurpose } from "../auth/otp.js";
import { sendOtpEmail, smtpConfigured } from "../email/mailer.js";

interface RegisterBody {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
}

interface UserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email_verified: boolean;
  created_at: string;
}

/** Public shape returned to clients (camelCase, no password hash). */
function toUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
  };
}

const USER_COLS = "id, email, first_name, last_name, phone, email_verified, created_at";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 2FA is on by default; set TWO_FACTOR_ENABLED=false to issue tokens directly.
const twoFactorEnabled = process.env.TWO_FACTOR_ENABLED !== "false";
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

/** Per-route rate limits for the sensitive auth endpoints (ignored under test,
 * where the rate-limit plugin isn't registered). Keyed by client IP. */
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

/** Auth routes, mounted under /api/auth. */
export async function authRoutes(app: FastifyInstance) {
  /** Issue + deliver an OTP, returning the dev code only when SMTP is unconfigured. */
  async function challenge(userId: string, email: string, purpose: OtpPurpose) {
    const code = await createOtp(userId, purpose);
    await sendOtpEmail(email, code);
    if (!smtpConfigured) {
      app.log.info({ email, purpose, code }, "OTP (dev mode — SMTP not configured)");
    }
    return { challenge: "otp" as const, email, ...(smtpConfigured ? {} : { devCode: code }) };
  }

  function tokenFor(user: ReturnType<typeof toUser>) {
    return app.jwt.sign({ id: user.id, email: user.email });
  }

  // GET /api/auth/config — public capabilities so the UI can adapt.
  app.get("/config", async () => ({
    twoFactor: twoFactorEnabled,
    emailDelivery: smtpConfigured,
    google: Boolean(googleClient),
  }));

  // POST /api/auth/register — validate, create user, then start a 2FA challenge.
  app.post("/register", limit(5), async (req, reply) => {
    const body = (req.body ?? {}) as Partial<RegisterBody>;
    const email = body.email?.trim().toLowerCase();
    const firstName = body.firstName?.trim();
    const lastName = body.lastName?.trim();
    const phone = body.phone?.trim();
    const { password } = body;

    if (!email || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: "a valid email is required" });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    if (!firstName || !lastName) {
      return reply.code(400).send({ error: "first and last name are required" });
    }
    if (!phone || phone.replace(/\D/g, "").length < 7) {
      return reply.code(400).send({ error: "a valid phone number is required" });
    }

    const passwordHash = await argon2.hash(password);
    try {
      const { rows } = await pool.query<UserRow>(
        `INSERT INTO users (email, password_hash, first_name, last_name, phone, email_verified)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${USER_COLS}`,
        [email, passwordHash, firstName, lastName, phone, !twoFactorEnabled]
      );
      const user = toUser(rows[0]);

      if (!twoFactorEnabled) {
        return reply.code(201).send({ token: tokenFor(user), user });
      }
      return reply.code(201).send(await challenge(user.id, user.email, "register"));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "email already registered" });
      }
      throw err;
    }
  });

  // POST /api/auth/login — verify password, then start a 2FA challenge.
  app.post("/login", limit(10), async (req, reply) => {
    const body = (req.body ?? {}) as Partial<RegisterBody>;
    const email = body.email?.trim().toLowerCase();
    const { password } = body;
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }

    const { rows } = await pool.query<UserRow & { password_hash: string | null }>(
      `SELECT ${USER_COLS}, password_hash FROM users WHERE email = $1`,
      [email]
    );
    const row = rows[0];

    if (!row || !row.password_hash || !(await argon2.verify(row.password_hash, password))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const user = toUser(row);
    if (!twoFactorEnabled) {
      return reply.send({ token: tokenFor(user), user });
    }
    return reply.send(await challenge(user.id, user.email, "login"));
  });

  // POST /api/auth/verify-otp — exchange a valid code for a token.
  app.post("/verify-otp", limit(10), async (req, reply) => {
    const { email, code, purpose } = (req.body ?? {}) as {
      email?: string;
      code?: string;
      purpose?: OtpPurpose;
    };
    if (!email || !code || (purpose !== "register" && purpose !== "login")) {
      return reply.code(400).send({ error: "email, code and purpose are required" });
    }

    const { rows } = await pool.query<UserRow>(
      `SELECT ${USER_COLS} FROM users WHERE email = $1`,
      [email.trim().toLowerCase()]
    );
    const row = rows[0];
    if (!row) return reply.code(400).send({ error: "invalid or expired code" });

    const ok = await verifyOtp(row.id, purpose, code.trim());
    if (!ok) return reply.code(400).send({ error: "invalid or expired code" });

    if (purpose === "register" && !row.email_verified) {
      await pool.query("UPDATE users SET email_verified = true WHERE id = $1", [row.id]);
      row.email_verified = true;
    }

    const user = toUser(row);
    return reply.send({ token: tokenFor(user), user });
  });

  // POST /api/auth/resend-otp — re-issue a code for an in-flight challenge.
  app.post("/resend-otp", limit(3), async (req, reply) => {
    const { email, purpose } = (req.body ?? {}) as { email?: string; purpose?: OtpPurpose };
    if (!email || (purpose !== "register" && purpose !== "login")) {
      return reply.code(400).send({ error: "email and purpose are required" });
    }

    const { rows } = await pool.query<UserRow>("SELECT id, email FROM users WHERE email = $1", [
      email.trim().toLowerCase(),
    ]);
    const row = rows[0];
    // Don't reveal whether the account exists.
    if (!row) return reply.send({ challenge: "otp", email });
    return reply.send(await challenge(row.id, row.email, purpose));
  });

  // POST /api/auth/google — verify a Google ID token and sign in (no 2FA needed).
  app.post("/google", limit(10), async (req, reply) => {
    if (!googleClient || !googleClientId) {
      return reply.code(503).send({ error: "google sign-in is not configured" });
    }
    const { credential } = (req.body ?? {}) as { credential?: string };
    if (!credential) return reply.code(400).send({ error: "credential is required" });

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
      payload = ticket.getPayload();
    } catch {
      return reply.code(401).send({ error: "invalid Google credential" });
    }
    if (!payload?.email || !payload.sub) {
      return reply.code(401).send({ error: "invalid Google credential" });
    }
    // Google does not guarantee a verified address (Workspace domains can issue
    // unverified ones). Without this check the ON CONFLICT (email) below would
    // link the Google identity to an existing password account with that
    // address — an account-takeover path.
    if (payload.email_verified !== true) {
      return reply.code(401).send({ error: "google account email is not verified" });
    }

    const email = payload.email.toLowerCase();
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, google_id, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE
         SET google_id = COALESCE(users.google_id, EXCLUDED.google_id),
             email_verified = true
       RETURNING ${USER_COLS}`,
      [email, payload.sub, payload.given_name ?? null, payload.family_name ?? null]
    );
    const user = toUser(rows[0]);
    return reply.send({ token: tokenFor(user), user });
  });

  // GET /api/auth/me — protected; returns the authenticated user's full profile.
  app.get("/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { rows } = await pool.query<UserRow>(
      `SELECT ${USER_COLS} FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "user not found" });
    return { user: toUser(rows[0]) };
  });
}
