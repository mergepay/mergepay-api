import { FastifyInstance } from "fastify";
import { getExchangeRate } from "../services/exchange";
import { rateLimited } from "../lib/rate-limit";

export default async function exchangeRateRoutes(app: FastifyInstance) {
  app.get("/api/exchange-rates", rateLimited("exchangeRates"), async () => ({
    rates: await Promise.all([getExchangeRate("XLM", "USDC"), getExchangeRate("USDC", "XLM")]),
  }));
}
