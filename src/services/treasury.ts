/**
 * Treasury multisig proposal + signature collection service.
 *
 * Builds an unsigned payment envelope (XDR) sourced from a group's multisig
 * treasury account, lets authorized group admins sign it incrementally with
 * their own wallets, verifies each signature against the signer's on-chain
 * signing weight, and submits the merged envelope to Horizon once the
 * collected weight reaches the account's threshold.
 *
 * No private key or seed is ever accepted or stored — only base64 signatures
 * and the public keys they verify against.
 *
 * Status lifecycle: PENDING_SIGNATURES -> READY -> SUBMITTED / FAILED.
 */

import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { prisma } from "../db";
import { stellar } from "./stellar";
import { audit } from "./audit";

export const TreasuryProposalStatus = {
  PENDING_SIGNATURES: "PENDING_SIGNATURES",
  READY: "READY",
  SUBMITTED: "SUBMITTED",
  FAILED: "FAILED",
} as const;

export type TreasuryProposalStatusValue =
  (typeof TreasuryProposalStatus)[keyof typeof TreasuryProposalStatus];

export interface CreateProposalParams {
  groupId: string;
  creatorId: string;
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string | null;
}

export interface SubmitSignatureParams {
  proposalId: string;
  groupId: string;
  submittedByUserId: string;
  /** Base64 of a (possibly partially) signed XDR the wallet produced. */
  signedXdr: string;
}

export interface SubmitSignatureResult {
  status: TreasuryProposalStatusValue;
  signatureWeight: number;
  threshold: number;
  stellarTxHash: string | null;
}

/**
 * Parse a base64 envelope with `TransactionBuilder.fromXDR`, rejecting
 * fee-bump envelopes (a treasury proposal is always a single inner
 * transaction).
 */
function parseTransaction(xdr: string, context: string): Transaction {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  } catch (e: any) {
    throw Errors.badRequest("invalid_xdr", e?.message ?? `Could not parse ${context}`);
  }
  if (!(parsed instanceof Transaction)) {
    throw Errors.badRequest(
      "invalid_xdr",
      `${context} must be a single transaction envelope, not a fee-bump transaction`
    );
  }
  return parsed;
}

/** Group admins' Stellar public keys, mapped to their user id. */
async function loadAuthorizedAdminSigners(groupId: string): Promise<Map<string, string>> {
  const admins = await prisma.groupMember.findMany({
    where: { groupId, role: "admin" },
    include: { user: true },
  });
  const map = new Map<string, string>();
  for (const admin of admins) {
    if (admin.user?.stellarPublicKey) {
      map.set(admin.user.stellarPublicKey, admin.userId);
    }
  }
  return map;
}

export const treasuryService = {
  STATUS: TreasuryProposalStatus,

  /** Build and persist a new unsigned multisig proposal from the group's treasury account. */
  async createProposal(params: CreateProposalParams) {
    const group = await prisma.group.findUnique({ where: { id: params.groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled for this group");
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    if (!snapshot.exists) {
      throw Errors.badRequest("treasury_unfunded", "Treasury account is not funded on the Stellar network");
    }

    const memo = params.memo ?? `MP:${randomMemoSuffix()}`;
    const xdr = stellar.buildPayment({
      sourcePublicKey: group.treasuryAccountPublicKey,
      sourceSequence: snapshot.sequence,
      destination: params.destination,
      asset: { code: params.assetCode, issuer: params.assetIssuer },
      amount: params.amount,
      memoCode: memo,
    });

    const proposal = await prisma.treasuryProposal.create({
      data: {
        groupId: params.groupId,
        creatorId: params.creatorId,
        xdr,
        threshold: snapshot.thresholds.high || group.treasuryRequiredSigners || 1,
        status: TreasuryProposalStatus.PENDING_SIGNATURES,
      },
    });

    await audit({
      userId: params.creatorId,
      groupId: params.groupId,
      action: "treasury.proposal.created",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: {
        destination: params.destination,
        amount: params.amount,
        assetCode: params.assetCode,
        threshold: proposal.threshold,
      },
    });

    return { proposal, xdr, networkPassphrase: config.networkPassphrase };
  },

  /**
   * Verify and append every new signature found on `signedXdr`, then submit
   * once the accumulated signer weight reaches the proposal's threshold.
   */
  async submitSignatures(args: SubmitSignatureParams): Promise<SubmitSignatureResult> {
    const proposal = await prisma.treasuryProposal.findUnique({
      where: { id: args.proposalId },
      include: { signatures: true },
    });
    if (!proposal || proposal.groupId !== args.groupId) {
      throw Errors.notFound("Treasury proposal not found");
    }
    if (proposal.status === TreasuryProposalStatus.SUBMITTED) {
      throw Errors.conflict("already_submitted", "Proposal has already been submitted");
    }
    if (proposal.status === TreasuryProposalStatus.FAILED) {
      throw Errors.conflict(
        "proposal_failed",
        "Proposal is in a failed state and cannot accept signatures"
      );
    }

    const group = await prisma.group.findUnique({ where: { id: args.groupId } });
    if (!group?.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled for this group");
    }

    const baseTx = parseTransaction(proposal.xdr, "the stored proposal envelope");
    const message = baseTx.hash();
    const submitted = parseTransaction(args.signedXdr, "the signed XDR");
    if (!submitted.hash().equals(message)) {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Submitted XDR hashes a different transaction than the proposal"
      );
    }

    const adminsByKey = await loadAuthorizedAdminSigners(args.groupId);
    if (adminsByKey.size === 0) {
      throw Errors.badRequest(
        "invalid_treasury_policy",
        "The treasury has no configured admin signers"
      );
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    const onChainWeightByKey = new Map(snapshot.signers.map((s) => [s.key, s.weight]));

    const existingKeys = new Set(proposal.signatures.map((s) => s.signerPublicKey));
    const adminKeypairs = [...adminsByKey.keys()]
      .map((pk) => {
        try {
          return { pk, kp: Keypair.fromPublicKey(pk) };
        } catch {
          return null;
        }
      })
      .filter((v): v is { pk: string; kp: Keypair } => v !== null);

    const newlyVerified: { publicKey: string; signature: string; weight: number }[] = [];

    for (const decorated of submitted.signatures) {
      const hint = decorated.hint();
      const signature = decorated.signature();

      const matched = adminKeypairs.find((m) => m.kp.signatureHint().equals(hint));
      if (!matched) {
        // Not a recognized admin signer's hint — it can't contribute to the
        // threshold, and silently ignoring it (rather than 400ing the whole
        // request) lets a wallet attach unrelated hints without failing an
        // otherwise-valid submission.
        continue;
      }
      if (existingKeys.has(matched.pk)) {
        throw Errors.conflict(
          "duplicate_signature",
          `${matched.pk} has already signed this proposal`
        );
      }

      const weight = onChainWeightByKey.get(matched.pk) ?? 0;
      if (weight <= 0) {
        throw Errors.badRequest(
          "unauthorized_signer",
          `${matched.pk} is not an active signer on the treasury account`
        );
      }

      let ok = false;
      try {
        ok = matched.kp.verify(message, signature);
      } catch {
        ok = false;
      }
      if (!ok) {
        throw Errors.badRequest(
          "invalid_signature",
          `Signature for ${matched.pk} did not verify against the proposed transaction`
        );
      }

      newlyVerified.push({
        publicKey: matched.pk,
        signature: signature.toString("base64"),
        weight,
      });
      existingKeys.add(matched.pk);
    }

    if (newlyVerified.length === 0) {
      throw Errors.badRequest(
        "no_new_signatures",
        "The submitted XDR carried no new signatures from an authorized admin signer"
      );
    }

    await prisma.treasurySignature.createMany({
      data: newlyVerified.map((s) => ({
        proposalId: proposal.id,
        signerPublicKey: s.publicKey,
        signature: s.signature,
        weight: s.weight,
      })),
    });

    await audit({
      userId: args.submittedByUserId,
      groupId: args.groupId,
      action: "treasury.proposal.signed",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: { signers: newlyVerified.map((s) => s.publicKey) },
    });

    const totalWeight =
      proposal.signatures.reduce((sum, s) => sum + s.weight, 0) +
      newlyVerified.reduce((sum, s) => sum + s.weight, 0);

    // Recheck against the live account threshold rather than the value
    // captured at proposal creation, so a signer-config change made in the
    // meantime is honored.
    const requiredWeight = snapshot.thresholds.high || proposal.threshold;

    if (totalWeight < requiredWeight) {
      await prisma.treasuryProposal.update({
        where: { id: proposal.id },
        data: { status: TreasuryProposalStatus.PENDING_SIGNATURES },
      });
      return {
        status: TreasuryProposalStatus.PENDING_SIGNATURES,
        signatureWeight: totalWeight,
        threshold: requiredWeight,
        stellarTxHash: null,
      };
    }

    await prisma.treasuryProposal.update({
      where: { id: proposal.id },
      data: { status: TreasuryProposalStatus.READY },
    });
    await audit({
      userId: args.submittedByUserId,
      groupId: args.groupId,
      action: "treasury.proposal.ready",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: { signatureWeight: totalWeight, threshold: requiredWeight },
    });

    return this.mergeAndSubmit(proposal.id, args.submittedByUserId);
  },

  /**
   * Combine every verified signature onto the unsigned envelope and submit
   * the result to Horizon. Updates the proposal's `status` and
   * `stellarTxHash` (or `failureReason` on rejection).
   */
  async mergeAndSubmit(proposalId: string, actorUserId: string): Promise<SubmitSignatureResult> {
    const proposal = await prisma.treasuryProposal.findUnique({
      where: { id: proposalId },
      include: { signatures: true },
    });
    if (!proposal) throw Errors.notFound("Treasury proposal not found");

    const baseTx = parseTransaction(proposal.xdr, "the stored proposal envelope");
    for (const sig of proposal.signatures) {
      try {
        baseTx.addSignature(sig.signerPublicKey, sig.signature);
      } catch {
        // Signature may already be present on a re-parsed envelope — skip
        // rather than double it up.
      }
    }
    const signedXdr = baseTx.toXDR();
    const totalWeight = proposal.signatures.reduce((sum, s) => sum + s.weight, 0);

    try {
      const hash = await stellar.submitSigned(signedXdr);
      await prisma.treasuryProposal.update({
        where: { id: proposal.id },
        data: { status: TreasuryProposalStatus.SUBMITTED, stellarTxHash: hash },
      });
      await audit({
        userId: actorUserId,
        groupId: proposal.groupId,
        action: "treasury.proposal.submitted",
        entityType: "treasury_proposal",
        entityId: proposal.id,
        metadata: { stellarTxHash: hash, signatureWeight: totalWeight },
      });
      return {
        status: TreasuryProposalStatus.SUBMITTED,
        signatureWeight: totalWeight,
        threshold: proposal.threshold,
        stellarTxHash: hash,
      };
    } catch (e: any) {
      const reason = e?.message ?? "submit failed";
      await prisma.treasuryProposal.update({
        where: { id: proposal.id },
        data: { status: TreasuryProposalStatus.FAILED, failureReason: reason },
      });
      await audit({
        userId: actorUserId,
        groupId: proposal.groupId,
        action: "treasury.proposal.failed",
        entityType: "treasury_proposal",
        entityId: proposal.id,
        outcome: "failure",
        metadata: { reason },
      });
      throw Errors.upstream(`Stellar rejected the multisig transaction: ${reason}`);
    }
  },
};

/** Tiny alphanumeric rune used for default memo text when none provided. */
function randomMemoSuffix(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
