import { FastifyInstance } from "fastify";
import { getExchangeRate } from "../services/exchange";
import { rateLimited } from "../lib/rate-limit";

export default async function exchangeRateRoutes(app: FastifyInstance) {
  app.get("/exchange-rates", rateLimited("exchangeRates"), async (_request, reply) => {
    const rates = await Promise.all([
      getExchangeRate("XLM", "USDC"),
      getExchangeRate("USDC", "XLM"),
    ]);
    reply.header("Cache-Control", "public, max-age=30");
    return { rates };
  });
}
