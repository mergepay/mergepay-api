import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config";

export default fp(async function rateLimitPlugin(app) {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW,
  });
});