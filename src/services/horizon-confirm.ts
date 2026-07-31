import { config } from "../config";
import { stellar } from "./stellar";

export type HorizonConfirmation =
  | { status: "confirmed"; successful: true }
  | { status: "failed"; successful: false; resultCode?: string }
  | { status: "not_found" }
  | { status: "timeout" };

export interface HorizonConfirmDeps {
  getTransaction: (hash: string) => ReturnType<typeof stellar.getTransaction>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
