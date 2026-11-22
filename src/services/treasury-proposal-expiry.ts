import { z } from "zod";
import { Errors } from "../errors";

export const DEFAULT_TREASURY_PROPOSAL_EXPIRY_DAYS = 7;
export const MIN_TREASURY_PROPOSAL_EXPIRY_DAYS = 1;
export const MAX_TREASURY_PROPOSAL_EXPIRY_DAYS = 30;

export const OPEN_TREASURY_PROPOSAL_STATUSES = [
  "open",
  "pending",
  "awaiting_signatures",
] as const;

export const EXPIRED_TREASURY_PROPOSAL_STATUS = "expired";

export const treasuryProposalExpiryDaysSchema = z.coerce
  .number()
  .int()
  .min(MIN_TREASURY_PROPOSAL_EXPIRY_DAYS)
  .max(MAX_TREASURY_PROPOSAL_EXPIRY_DAYS)
  .default(DEFAULT_TREASURY_PROPOSAL_EXPIRY_DAYS);

export interface ProposalExpiryState {
  status: string;
  expiresAt?: Date | null;
  createdAt?: Date | null;
}

export function isOpenTreasuryProposalStatus(status: string): boolean {
  return (OPEN_TREASURY_PROPOSAL_STATUSES as readonly string[]).includes(status);
}

export function proposalExpiryDate(
  expiresInDays: number = DEFAULT_TREASURY_PROPOSAL_EXPIRY_DAYS,
  now: Date = new Date()
): Date {
  return new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);
}

export function effectiveProposalExpiry(proposal: ProposalExpiryState): Date | null {
  if (proposal.expiresAt) return proposal.expiresAt;
  if (!proposal.createdAt) return null;
  return proposalExpiryDate(
    DEFAULT_TREASURY_PROPOSAL_EXPIRY_DAYS,
    proposal.createdAt
  );
}

export function isProposalExpired(
  proposal: ProposalExpiryState,
  now: Date = new Date()
): boolean {
  const expiry = effectiveProposalExpiry(proposal);
  if (!expiry) return false;
  return now.getTime() >= expiry.getTime();
}

export function assertProposalActionable(
  proposal: ProposalExpiryState,
  now: Date = new Date()
): void {
  if (proposal.status === EXPIRED_TREASURY_PROPOSAL_STATUS || isProposalExpired(proposal, now)) {
    throw Errors.conflict(
      "proposal_expired",
      "Proposal has expired and can no longer be signed or submitted"
    );
  }
}
