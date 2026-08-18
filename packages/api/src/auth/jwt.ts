import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";

/** A session token. Its subject is a *user*. */
export interface UserToken {
  id: string;
  email: string;
}

/**
 * A short-lived token scoped to a single *video*, minted for browser
 * navigations that cannot carry an Authorization header (downloads) or for
 * nested HLS requests. Deliberately uses `vid` rather than `id` so a resource
 * token can never be mistaken for a user token — the two are signed with the
 * same secret, so only the claim names keep them apart.
 */
export interface ResourceToken {
  vid: string;
  scope: "download" | "stream";
}

export type AnyToken = UserToken | ResourceToken;

/** Narrow a decoded token to the video-scoped variant. */
export function isResourceToken(token: AnyToken): token is ResourceToken {
  return typeof (token as ResourceToken).vid === "string";
}

// The shape of our JWT payload and the decoded `request.user`.
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AnyToken;
    // Routes behind `authenticate` only ever see session tokens.
    user: UserToken;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that rejects requests without a valid Bearer token. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Register the JWT plugin and an `authenticate` preHandler on the app.
 * Must be awaited at the top level so child route plugins inherit both.
 */
export async function registerAuth(app: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  await app.register(fastifyJwt, {
    secret,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" },
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const token = (await req.jwtVerify()) as AnyToken;
      // A video-scoped token must never authenticate a user-level route.
      if (isResourceToken(token)) throw new Error("not a session token");
    } catch {
      reply.code(401).send({ error: "unauthorized" });
    }
  });
}
