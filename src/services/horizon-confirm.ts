/**
 * Polling helper that turns a submitted transaction hash into a terminal
 * confirmation outcome.
 *
 * Horizon is eventually consistent: a transaction that was accepted is not
 * readable the instant it is submitted, and a lookup can fail transiently
 * while the network settles. This module hides that window behind a bounded
 * retry loop so callers (routes, worker) get one of four explicit answers
 * instead of a raw "not found yet" or a thrown network error.
 *
 * All Horizon I/O stays behind `stellar.getTransaction`, so tests inject a
 * fake via {@link HorizonConfirmDeps} without touching the network.
 */
import { config } from "../config";
import { stellar } from "./stellar";

/**
 * The four terminal answers from {@link pollForConfirmation}.
 *
 * - `confirmed` — the transaction is on chain and succeeded.
 * - `failed` — the transaction is on chain and was rejected by the network
 *   (`resultCode` is optional; Horizon's record is not guaranteed to carry one).
 * - `not_found` — every attempt returned 404; the transaction has not been
 *   ingested yet (or the hash never existed).
 * - `timeout` — the poll budget was exhausted on errors rather than on an
 *   answer; the transaction's fate is still unknown and must be reconciled
 *   later.
 */
export type HorizonConfirmation =
  | { status: "confirmed"; successful: true }
  | { status: "failed"; successful: false; resultCode?: string }
  | { status: "not_found" }
  | { status: "timeout" };

/**
 * Injectable Horizon dependency for {@link pollForConfirmation}.
 * Only `getTransaction` is needed; production code omits `deps` entirely.
 */
export interface HorizonConfirmDeps {
  getTransaction: (hash: string) => ReturnType<typeof stellar.getTransaction>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Look up a transaction hash on Horizon until it resolves or the configured
 * attempt budget is spent.
 *
 * Each attempt either answers or waits `CONFIRM_POLL_DELAY_MS` before the
 * next one; a thrown Horizon error is swallowed until the final attempt so a
 * brief network blip does not fail an otherwise healthy submission. The loop
 * never throws — every path returns a {@link HorizonConfirmation}.
 *
 * @param hash - The hex transaction hash returned by a submission.
 * @param deps - Optional `{ getTransaction }` override for tests; defaults to
 *   `stellar.getTransaction`, which applies its own timeout and retry policy.
 * @returns A terminal {@link HorizonConfirmation}. `not_found` means every
 *   attempt saw a 404; `timeout` means the attempts ran out while errors kept
 *   occurring (the outcome is unknown and should be reconciled, not resubmitted).
 */
export async function pollForConfirmation(
  hash: string,
  deps?: HorizonConfirmDeps
): Promise<HorizonConfirmation> {
  const getTx = deps?.getTransaction ?? stellar.getTransaction.bind(stellar);
  const maxAttempts = config.CONFIRM_POLL_MAX_ATTEMPTS;
  const delayMs = config.CONFIRM_POLL_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tx = await getTx(hash);
      if (tx === null) {
        if (attempt < maxAttempts) {
          await sleep(delayMs);
          continue;
        }
        return { status: "not_found" };
      }
      if (tx.successful) {
        return { status: "confirmed", successful: true };
      }
      return { status: "failed", successful: false };
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt) {
        return { status: "timeout" };
      }
      await sleep(delayMs);
    }
  }

  return { status: "timeout" };
}
