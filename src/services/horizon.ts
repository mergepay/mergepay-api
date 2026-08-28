/**
 * Trustline lookups against Horizon.
 *
 * A Stellar account can only hold a non-native asset it has explicitly
 * trusted. Without that trustline a payment of the asset fails on submission
 * with `op_no_trust` — after the expense exists, after members have been asked
 * to settle, and at the point where the failure is most expensive to explain.
 *
 * Checking at expense creation moves that failure forward to the moment
 * someone can still act on it: the creator picks a different asset, or tells
 * the member to add the trustline first.
 *
 * ## Why this is a read, and what that buys
 *
 * Every call here is a Horizon account read, so it inherits the shared timeout
 * and is safe to repeat. `stellar.loadAccount` already reports an unfunded
 * account as `exists: false` rather than throwing, which matters: an account
 * that does not exist yet cannot hold a trustline either, and both cases are
 * reported the same way to the caller.
 *
 * ## Failing open vs failing closed
 *
 * When Horizon itself is unavailable this module raises, and the caller turns
 * that into a 502 rather than silently allowing the expense. Allowing it would
 * defeat the check exactly when the network is least healthy — the conditions
 * under which a settlement is most likely to fail later anyway.
 */
import { Errors } from "../errors";
import { stellar } from "./stellar";
import { toAppError } from "./timeout";

/** One account's trustline status for a single asset. */
export interface TrustlineStatus {
  /** The account checked. */
  publicKey: string;
  /** Whether the account trusts the asset (always true for native XLM). */
  hasTrustline: boolean;
  /** False when the account is not funded on the network at all. */
  accountExists: boolean;
}

/**
 * Whether a loaded account holds a trustline for an issued asset.
 *
 * Matching is on the (code, issuer) pair, not the code alone: two issuers can
 * both mint an asset called "USDC", and a trustline to the wrong one will not
 * settle the payment this expense will build.
 */
function holdsAsset(
  balances: { assetCode: string; assetIssuer: string | null; balance: string }[],
  assetCode: string,
  assetIssuer: string | null
): boolean {
  return balances.some(
    (balance) =>
      balance.assetCode === assetCode &&
      (assetIssuer === null || balance.assetIssuer === assetIssuer)
  );
}

/**
 * Look up trustlines for several accounts at once.
 *
 * Horizon has no batch account endpoint, so this fans out one read per account
 * and runs them concurrently — a group of ten members costs one round trip's
 * latency rather than ten. Duplicate keys are collapsed first, since the same
 * member can appear more than once in a caller's list.
 *
 * A failure from any single lookup fails the whole call: a partial answer here
 * would report "everyone has a trustline" while one account was never actually
 * checked.
 */
export async function fetchTrustlines(params: {
  publicKeys: string[];
  assetCode: string;
  assetIssuer: string | null;
}): Promise<TrustlineStatus[]> {
  const { publicKeys, assetCode, assetIssuer } = params;
  const unique = [...new Set(publicKeys)];

  try {
    return await Promise.all(
      unique.map(async (publicKey) => {
        const account = await stellar.loadAccount(publicKey);

        if (!account.exists) {
          return { publicKey, hasTrustline: false, accountExists: false };
        }

        return {
          publicKey,
          hasTrustline: holdsAsset(account.balances, assetCode, assetIssuer),
          accountExists: true,
        };
      })
    );
  } catch (error) {
    // Horizon's own error text can carry account identifiers and upstream
    // detail, so it is mapped to the repository's stable upstream shape rather
    // than forwarded. The original stays available to the logs.
    throw toAppError(error, "Could not verify trustlines with the Stellar network");
  }
}

/** A participant who cannot receive the asset, as reported to the client. */
export interface MissingTrustline {
  userId: string;
  publicKey: string;
  /** Distinguishes "never funded" from "funded but has not trusted the asset". */
  reason: "no_trustline" | "account_not_found";
}

/**
 * Verify every participant can hold an issued asset, and raise a structured
 * 400 naming those who cannot.
 *
 * Native XLM needs no trustline, so callers should skip this entirely for it —
 * the guard here is a safety net, not the decision point.
 *
 * The error lists every missing participant rather than the first one found.
 * Reporting them one at a time would make a group of five with two gaps take
 * two failed attempts to diagnose.
 */
export async function assertParticipantsCanHoldAsset(params: {
  participants: { userId: string; stellarPublicKey: string }[];
  assetCode: string;
  assetIssuer: string | null;
}): Promise<void> {
  const { participants, assetCode, assetIssuer } = params;
  if (participants.length === 0) return;

  const statuses = await fetchTrustlines({
    publicKeys: participants.map((p) => p.stellarPublicKey),
    assetCode,
    assetIssuer,
  });

  const byKey = new Map(statuses.map((status) => [status.publicKey, status]));

  const missing: MissingTrustline[] = [];
  for (const participant of participants) {
    const status = byKey.get(participant.stellarPublicKey);
    if (!status || status.hasTrustline) continue;

    missing.push({
      userId: participant.userId,
      publicKey: participant.stellarPublicKey,
      reason: status.accountExists ? "no_trustline" : "account_not_found",
    });
  }

  if (missing.length > 0) {
    throw Errors.badRequest(
      "missing_trustlines",
      `${missing.length} participant(s) cannot receive ${assetCode}. Each must add a trustline for this asset before the expense can be created.`,
      { assetCode, assetIssuer, missing }
    );
  }
}
