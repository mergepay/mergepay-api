/**
 * Structured audit action vocabulary — Issue #131.
 *
 * Every state-changing operation that must be auditable uses one of these
 * constants as its `action` field. Callers never supply free-form strings,
 * which makes it possible to filter, aggregate, and alert on specific
 * event types without pattern-matching.
 *
 * Naming convention:
 *   <domain>.<resource>.<verb>[.<qualifier>]
 *
 * Example: `treasury.deposit.create`, `settlement.confirm.submitted`
 */
export const AuditAction = {
  // ── Group / membership ──────────────────────────────────────────────
  GROUP_CREATE: "group.create",
  GROUP_ARCHIVE: "group.archive",
  GROUP_INVITE: "group.invite",
  GROUP_INVITE_CODE_CREATE: "group.invite_code_create",
  GROUP_JOIN: "group.join",
  GROUP_LEAVE: "group.leave",
  GROUP_MEMBER_REMOVE: "group.member_remove",

  // ── Treasury ────────────────────────────────────────────────────────
  TREASURY_ENABLE: "treasury.enable",
  TREASURY_DEPOSIT_CREATE: "treasury.deposit.create",
  TREASURY_WITHDRAW_CREATE: "treasury.withdraw.create",
  TREASURY_CONFIRM: "treasury.confirm",
  TREASURY_CONFIRM_FAILED: "treasury.confirm.failed",
  TREASURY_SIGNER_VALIDATION: "treasury.signer_validation",

  // ── Treasury proposals (multisig) ───────────────────────────────────
  TREASURY_PROPOSAL_CREATED: "treasury.proposal.created",
  TREASURY_PROPOSAL_SIGNED: "treasury.proposal.signed",
  TREASURY_PROPOSAL_SUBMITTED: "treasury.proposal.submitted",
  TREASURY_PROPOSAL_FAILED: "treasury.proposal.failed",

  // ── Settlements ─────────────────────────────────────────────────────
  SETTLEMENT_CREATED: "settlement.created",
  SETTLEMENT_CONFIRM_RETRY: "settlement.confirm.retry",
  SETTLEMENT_CONFIRM_SUBMITTED: "settlement.confirm.submitted",
  SETTLEMENT_CONFIRM_VALIDATION_FAILED: "settlement.confirm.validation_failed",
  SETTLEMENT_CONFIRM_REJECTED: "settlement.confirm.rejected",
  SETTLEMENT_XDR_SUBMITTED: "settlement.xdr_submitted",
  SETTLEMENT_CONFIRMED: "settlement.confirmed",
  SETTLEMENT_FAILED: "settlement.failed",
  SETTLEMENT_RETRIED: "settlement.retried",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
