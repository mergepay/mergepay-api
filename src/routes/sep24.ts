/**
 * SEP-24 anchor callback endpoint.
 *
 * Registered outside the authenticated route scopes: an anchor has no Mergepay
 * session and never will. Its credential is the JWT it signs with its SEP-10
 * key, verified in src/services/sep24.ts against the key published in that
 * anchor's own stellar.toml.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { ipKey } from "../services/rate-limit-keys";
import {
  applySep24Callback,
  sep24CallbackSchema,
  verifyAnchorToken,
} from "../services/sep24";

export default async function sep24Routes(app: FastifyInstance) {
  // Rate limiting here is abuse protection for an endpoint that is
  // unauthenticated until the token is checked. It never substitutes for that
  // check, which remains the authorization gate. Keyed by IP because there is
  // no authenticated user to key by.
  app.post(
    "/api/sep24/callback",
    {
      config: {
        rateLimit: {
          max: config.SEP24_RATE_LIMIT_MAX,
          timeWindow: config.SEP24_RATE_LIMIT_WINDOW_MS,
          keyGenerator: ipKey("sep24.callback"),
        },
      },
    },
    async (req, reply) => {
      // Verified before the body is parsed, so an unauthenticated caller never
      // reaches the schema, the database, or the audit log.
      await verifyAnchorToken(req.headers.authorization);

      const callback = sep24CallbackSchema.parse(req.body ?? {});
      const result = await applySep24Callback(callback);

      // 200 even when no session matched or the transition was disallowed.
      // Anchors retry non-2xx responses, so returning an error for a callback
      // that was correctly processed as a no-op only amplifies load.
      return reply.code(200).send({
        received: true,
        status: result.status,
        matched: result.matched,
        updated: result.updated,
      });
    }
  );
}
