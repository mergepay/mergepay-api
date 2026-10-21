/**
 * Stellar transaction XDR helpers (issue #419).
 *
 * Endpoints that accept Stellar transactions in XDR format must reject
 * malformed input *before* it reaches the SDK-backed business logic, so
 * untrusted payloads fail fast with a validation error instead of surfacing
 * as an opaque parse failure deep inside a handler.
 *
 * This module stays deliberately dependency-free: it is a pure parse check
 * imported by request schemas, and importing `src/services/stellar` from here
 * would drag the database, config, and every test double of that service into
 * schema validation. Horizon I/O and transaction construction still live in
 * `src/services/`; nothing here contacts the network or builds an envelope.
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
 * network passphrase but does not verify signatures or transaction intent.
 * That deeper validation has exactly one home — `src/services/stellar.ts` for
 * the submission paths that throw, and `src/services/xdr-inspection.ts` for
 * callers that want the diverging field reported instead (issue #694). A
 * second intent validator used to live in this module and was weaker than
 * both: it never checked signatures or sequence numbers, compared amounts as
 * raw strings, and mis-reported fee-bump envelopes. Add nothing of that kind
 * here.
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
