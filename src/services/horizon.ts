/**
 * Shared Horizon client.
 *
 * This is the only place a `Horizon.Server` is constructed. Every service that
 * talks to Horizon (`stellar.ts`, `network.ts`) goes through `horizonServer()`,
 * so a test can mock this one module to put a fake Horizon behind the real
 * service code, and production keeps a single connection-pooled client.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { config } from "../config";
import { TransportError } from "./timeout";

/** The subset of `Horizon.Server` Mergepay actually uses. */
export type HorizonClient = Pick<
  Horizon.Server,
  "loadAccount" | "submitTransaction" | "transactions" | "feeStats"
>;

let client: HorizonClient | null = null;

export function horizonServer(): HorizonClient {
  if (!client) client = new Horizon.Server(config.HORIZON_URL);
  return client;
}

/**
 * `withTimeout` wraps any non-timeout rejection in a `TransportError`. When
 * Horizon actually answered (a 404, a 400 with result codes), the SDK error
 * carries a `response`, and that is an upstream answer rather than a transport
 * failure. Return the original SDK error in that case so callers can inspect
 * its status and result codes; return everything else unchanged.
 */
export function unwrapHorizonError(e: unknown): unknown {
  if (e instanceof TransportError) {
    const cause = e.cause as { response?: unknown; name?: string } | undefined;
    if (cause && (cause.response !== undefined || cause.name === "NotFoundError")) {
      return cause;
    }
  }
  return e;
}

/** True when `e` is Horizon reporting that the resource does not exist. */
export function isHorizonNotFound(e: unknown): boolean {
  const err = unwrapHorizonError(e) as { response?: { status?: number }; name?: string };
  return err?.response?.status === 404 || err?.name === "NotFoundError";
}

/** Horizon result codes from a rejected submission, if it returned any. */
export function horizonResultCodes(e: unknown): unknown {
  const err = unwrapHorizonError(e) as {
    response?: { data?: { extras?: { result_codes?: unknown }; result_codes?: unknown } };
  };
  return err?.response?.data?.extras?.result_codes ?? err?.response?.data?.result_codes;
}
