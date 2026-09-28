/**
 * Stellar transaction XDR helpers (issue #419).
 *
 * Endpoints that accept Stellar transactions in XDR format must reject
 * malformed input *before* it reaches the SDK-backed business logic, so
 * untrusted payloads fail fast with a validation error instead of surfacing
 * as an opaque parse failure deep inside a handler.
 */
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../config";

/**
 * Whether `xdr` is a base64-encoded Stellar transaction envelope that the
 * SDK can parse.
 *
 * Catches every common failure mode in one place:
 *   - non-string or empty input;
 *   - strings that are not valid base64 (e.g. `"not-xdr!!"`);
 *   - valid base64 that does not decode to an XDR structure;
 *   - truncated or otherwise corrupted envelopes.
 *
 * The check is parse-level: it confirms the envelope decodes for the given
 * network passphrase but does not verify signatures or transaction intent —
 * that deeper validation lives with the handlers that need it (see
 * `validateSignedXdr` in src/services/stellar.ts).
 *
 * @param xdr - Candidate base64 XDR string.
 * @param networkPassphrase - Defaults to the configured Stellar network; the
 *   passphrase is required by the SDK to decode an envelope, and a mismatch
 *   still parses (network binding is only observable when verifying
 *   signatures).
 * @returns `true` when the string parses as a transaction envelope.
 */
export function isValidXdr(
  xdr: string,
  networkPassphrase: string = config.networkPassphrase
): boolean {
  if (typeof xdr !== "string" || xdr.trim().length === 0) {
    return false;
  }
  try {
    TransactionBuilder.fromXDR(xdr, networkPassphrase);
    return true;
  } catch {
    return false;
  }
}
