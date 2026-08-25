/**
 * Controlled audit-event vocabulary for treasury and settlement mutations.
 * Issue #131: "Add structured audit events for treasury and settlement
 * mutations."
 *
 * `AuditLog.action` (schema.prisma) is a free-form `String`, matching every
 * other state field in this schema (e.g. `Settlement.status`) — there is no
 * Prisma enum to hang this off. This module is the enum substitute: routes
 * and services import `AuditAction` instead of writing action strings by
 * hand, so the set of things that get logged is closed and discoverable in
 * one place instead of scattered, ad hoc literals.
 *
 * ## Coverage
 *
 * Every mutation named in the issue has a wired action below, EXCEPT three
 * that don't correspond to any mutation that exists in this codebase today:
 *
 *   - `TREASURY_MEMBER_ADDED` / `TREASURY_MEMBER_REMOVED` — there is no
 *     treasury-specific membership concept. Group membership changes
 *     (invite/join/leave/remove) already go through generic `group.*` audit
 *     actions in src/routes/groups.ts, regardless of whether the group has a
 *     treasury enabled.
 *   - `SETTLEMENT_CANCELLED` — there is no settlement-cancellation endpoint
 *     or code path. The nearest concept, an unsigned intent whose signing
 *     window lapses, is a passively-computed public status
 *     (src/services/settlement-status.ts) and never a persisted `Settlement`
 *     transition, so nothing mutates for it to be an audit event of.
 *
 * These three are still defined below (as documented, unwired constants) so
 * the full vocabulary the issue named is discoverable and ready to wire up
 * the day a corresponding mutation is added — not fabricated by building
 * new endpoints to give them somewhere to fire, which would be scope this
 * issue didn't ask for.
 *
 * `TREASURY_SIGNER_CHANGED` is wired to `POST /groups/:id/treasury/enable`
 * (src/routes/treasury.ts) — the only mutation in this codebase that writes
 * the treasury account's signer configuration (`treasuryAccountPublicKey`,
 * `treasuryRequiredSigners`). There is no separate endpoint that submits an
 * on-chain `set_options` signer/weight change.
 *
 * ## Outcome values
 *
 * `AuditParams.outcome` (src/services/audit.ts): `"success"`, `"failure"`,
 * or `"rejected"`. `"rejected"` is for a request the API itself declined
 * before anything reached Stellar (signed-XDR/intent mismatch, an
 * unauthorized confirm attempt) — distinct from `"failure"`, which is a
 * downstream/on-chain failure (Horizon rejected the transaction, a worker
 * exhausted its retries).
 *
 * ## metadata guidance (per action)
 *
 * `metadata` is a Json blob (no schema-level allowlist), so this is the
 * documented contract; src/services/audit.ts additionally enforces a
 * runtime denylist of secret-shaped keys as a backstop. Never include a
 * private key, a signed or unsigned XDR, an auth/session token, or more
 * personal data than the entity ids already on the record.
 *
 *   TREASURY_SIGNER_CHANGED      { publicKey, requiredSigners }
 *   TREASURY_DEPOSIT_CREATED     { amount, assetCode, assetIssuer }
 *   TREASURY_WITHDRAWAL_CREATED  { amount, assetCode, assetIssuer, destination }
 *   TREASURY_TX_CONFIRMED        { direction, stellarTxHash }
 *   TREASURY_TX_FAILED           { direction, reason }
 *   TREASURY_PROPOSAL_CREATED    { destination, amount, assetCode, threshold }
 *   TREASURY_PROPOSAL_SIGNED     { signatureCount, threshold }
 *   TREASURY_PROPOSAL_SUBMITTED  { signatureCount, threshold, stellarTxHash }
 *   TREASURY_PROPOSAL_FAILED     { signatureCount, threshold, reason }
 *   SETTLEMENT_CREATED           { amount, assetCode, assetIssuer, toUserId }
 *   SETTLEMENT_XDR_SUBMITTED     { }
 *   SETTLEMENT_REJECTED          { reason }
 *   SETTLEMENT_RETRIED           { previousFailure }
 *   SETTLEMENT_CONFIRMED         { stellarTxHash, source }
 *   SETTLEMENT_FAILED            { reason, source, retryCount? }
 */

export const AuditAction = {
  // -- treasury -----------------------------------------------------------
  TREASURY_SIGNER_CHANGED: "treasury.signer_changed",
  TREASURY_DEPOSIT_CREATED: "treasury.deposit_created",
  TREASURY_WITHDRAWAL_CREATED: "treasury.withdrawal_created",
  TREASURY_TX_CONFIRMED: "treasury.transaction_confirmed",
  TREASURY_TX_FAILED: "treasury.transaction_failed",
  TREASURY_PROPOSAL_CREATED: "treasury.proposal_created",
  TREASURY_PROPOSAL_SIGNED: "treasury.proposal_signed",
  TREASURY_PROPOSAL_SUBMITTED: "treasury.proposal_submitted",
  TREASURY_PROPOSAL_FAILED: "treasury.proposal_failed",
  /** Reserved — no treasury-specific membership mutation exists. See module doc. */
  TREASURY_MEMBER_ADDED: "treasury.member_added",
  /** Reserved — no treasury-specific membership mutation exists. See module doc. */
  TREASURY_MEMBER_REMOVED: "treasury.member_removed",

  // -- settlement -----------------------------------------------------------
  SETTLEMENT_CREATED: "settlement.created",
  SETTLEMENT_XDR_SUBMITTED: "settlement.xdr_submitted",
  SETTLEMENT_REJECTED: "settlement.rejected",
  SETTLEMENT_RETRIED: "settlement.retried",
  SETTLEMENT_CONFIRMED: "settlement.confirmed",
  SETTLEMENT_FAILED: "settlement.failed",
  /** Reserved — no settlement-cancellation mutation exists. See module doc. */
  SETTLEMENT_CANCELLED: "settlement.cancelled",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
