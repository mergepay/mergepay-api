import { FastifyInstance } from "fastify";
import { getExchangeRate } from "../services/exchange";

export default async function exchangeRateRoutes(app: FastifyInstance) {
  app.get("/api/exchange-rates", async () => ({
    rates: await Promise.all([getExchangeRate("XLM", "USDC"), getExchangeRate("USDC", "XLM")]),
  }));
}
