// Auth middleware. Phase 1 runs fully local: AUTH_MODE="local" injects a
// fixed user identity on every /api request so all tables keep real user_id
// columns (multi-user later is a migration, not a rewrite).
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "@omni/env-config";

export type AuthenticatedRequest = FastifyRequest & {
  userId: string;
  userEmail: string;
  accessToken: string;
};

export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (env.AUTH_MODE === "local") {
    const req = request as AuthenticatedRequest;
    req.userId = env.LOCAL_USER_ID;
    req.userEmail = env.LOCAL_USER_EMAIL;
    req.accessToken = "local";
    return;
  }
  // AUTH_MODE === "supabase": deliberately unimplemented in Phase 1.
  // When multi-user lands, this branch verifies the Bearer JWT against
  // Supabase auth and populates userId/userEmail/accessToken from it
  // (see Flo101's middleware/auth.ts for the reference implementation).
  throw new Error("AUTH_MODE=supabase is not implemented");
}
