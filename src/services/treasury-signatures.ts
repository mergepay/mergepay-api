/**
 * Treasury transaction signature-collector service.
 *
 * Complements `src/services/treasury-proposals.ts`, which always builds its
 * own payment XDR server-side. This flow instead accepts an unsigned XDR an
 * admin already built through external coordination (Stellar Laboratory, a
 * CLI, another signer's wallet) for the group's multisig treasury account,
 * stores it as a `TreasuryTxProposal`, and lets other group admins sign it
 * independently. Every signature is verified against the stored envelope's
 * hash and against the source account's *live* on-chain signer list before
 * being persisted as a `TreasurySignature`. Once the signers' summed
 * on-chain weight meets the account's threshold, the merged envelope is
 * submitted to Horizon automatically.
 *
 * Design
 * ------
 *   1. `createProposal({ groupId, creatorId, xdr })` parses the caller's
 *      unsigned XDR with `TransactionBuilder.fromXDR`, requires its source
 *      to be the group's configured treasury account, and stores it with a
 *      computed `txHash` that every later signature is bound to.
 *
 *   2. `submitSignature({ proposalId, signedXdr, ... })` runs inside a
 *      database transaction with a row-level lock on the proposal. It loads
 *      the source account fresh from Horizon, restricts authorized signers
 *      to group *admins* whose Stellar key currently carries on-chain
 *      signing weight, verifies every new signature on the submitted
 *      envelope against that set, and rejects the whole request with 400 if
 *      any signature does not verify or does not belong to an authorized
 *      admin signer. New signatures are persisted with the signer's weight
 *      at verification time. Once the summed weight meets the account's
 *      threshold, every stored signature is merged onto a fresh copy of the
 *      original envelope and submitted to Horizon.
 *
 * State machine: PENDING_SIGNATURES -> READY -> SUBMITTED / FAILED.
 *
 * Security properties
 * --------------------
 *   - Every signature is bound to the proposal's `txHash`; a submission for
 *     a modified transaction is rejected before any signature is inspected.
 *   - Only group admins whose public key is a live, positive-weight signer
 *     on the source account may contribute weight — a valid signature from
 *     a non-admin or removed signer is rejected outright, not silently
 *     ignored.
 *   - Concurrent submissions are serialized by `prisma.$transaction` row
 *     locking, so the threshold decision is made against a consistent view.
 *   - No private key material is ever accepted or stored — only signatures
 *     already present on a submitted envelope are read and verified.
 */

import {
  Keypair,
  Transaction,
  TransactionBuilder,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { Errors } from "../errors";
import { prisma } from "../db";
import { stellar } from "./stellar";
import { auditTx } from "./audit";
import { AuditAction } from "./audit-actions";

export const STATUS = {
  pendingSignatures: "PENDING_SIGNATURES",
  ready: "READY",
  submitted: "SUBMITTED",
  failed: "FAILED",
} as const;

export interface CreateTxProposalParams {
  groupId: string;
  creatorId: string;
  /** Unsigned base64 XDR, built externally, sourced from the treasury account. */
  xdr: string;
}

export interface SubmitSignatureParams {
  proposalId: string;
  groupId: string;
  userId: string;
  /** Base64 XDR carrying one or more new signatures over the proposal's envelope. */
  signedXdr: string;
}

export interface SignatureSubmissionResult {
  status: string;
  totalWeight: number;
  requiredWeight: number;
  stellarTxHash: string | null;
}

/**
 * Parse an untrusted envelope, rejecting anything that isn't a plain
 * (non-fee-bump) transaction for our configured network.
 */
function parseXdr(xdr: string, malformedMessage: string): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("xdr_malformed", malformedMessage);
  }
  if (parsed instanceof FeeBumpTransaction) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Fee-bump transaction envelopes are not accepted"
    );
  }
  return parsed;
}

export const treasurySignaturesService = {
  /**
   * Store a new signature-collection proposal from a caller-supplied unsigned XDR.
   *
   * @param params - `{ groupId, creatorId, xdr }`. `xdr` is a base64 unsigned
   *   Stellar transaction envelope, built externally, whose source account must be
   *   the group's configured treasury account.
   * @returns The created `TreasuryTxProposal` row and the `networkPassphrase` the
   *   envelope was parsed against.
   * @throws {AppError} `treasury_disabled` / `treasury_unfunded` if the group
   *   treasury is off or unfunded; `bad_request` for a malformed, fee-bump, signed,
   *   or source-mismatched XDR.
   */
  async createProposal(params: CreateTxProposalParams) {
    const group = await prisma.group.findUnique({ where: { id: params.groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled for this group"
      );
    }

    const tx = parseXdr(params.xdr, "Could not parse transaction XDR");
    if (tx.signatures.length > 0) {
      throw Errors.badRequest(
        "xdr_not_unsigned",
        "Expected an unsigned transaction envelope"
      );
    }
    if (tx.source !== group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Transaction source must be the group's treasury account"
      );
    }

    const account = await stellar.loadAccount(group.treasuryAccountPublicKey);
    if (!account.exists) {
      throw Errors.badRequest(
        "treasury_unfunded",
        "Treasury account is not funded on-chain"
      );
    }

    const txHash = tx.hash().toString("hex");
    const treasuryAccountPublicKey = group.treasuryAccountPublicKey;

    const proposal = await prisma.$transaction(async (db) => {
      const created = await db.treasuryTxProposal.create({
        data: {
          groupId: params.groupId,
          creatorId: params.creatorId,
          xdr: params.xdr,
          txHash,
          sourceAccount: treasuryAccountPublicKey,
          requiredWeight: account.thresholds.high,
          status: STATUS.pendingSignatures,
        },
      });
      await auditTx(db, {
        userId: params.creatorId,
        groupId: params.groupId,
        action: AuditAction.TREASURY_TX_PROPOSAL_CREATED,
        entityType: "treasury_tx_proposal",
        entityId: created.id,
        metadata: {
          sourceAccount: created.sourceAccount,
          requiredWeight: created.requiredWeight,
        },
      });
      return created;
    });

    return { proposal, networkPassphrase: config.networkPassphrase };
  },

  /**
   * Verify every new signature on a submitted envelope, persist it, and
   * submit to Horizon once the summed admin signer weight meets the source
   * account's live threshold.
   *
   * @param args - `{ proposalId, groupId, userId, signedXdr }`. `signedXdr` is the
   *   envelope carrying one or more new signatures over the proposal's stored
   *   transaction.
   * @returns `{ status, totalWeight, requiredWeight, stellarTxHash }` reflecting the
   *   proposal's state after the call — `PENDING_SIGNATURES`, `READY` (registered
   *   but not yet submitted), `SUBMITTED` (with a non-null `stellarTxHash`), or
   *   `FAILED`.
   * @throws {AppError} `not_found` / `conflict` for unknown or terminal proposals,
   *   `bad_request` for an envelope containing a non-admin/unauthorized signer or a
   *   signature that fails verification, and `upstream` when Stellar rejects the
   *   merged transaction.
   */
  async submitSignature(
    args: SubmitSignatureParams
  ): Promise<SignatureSubmissionResult> {
    return prisma.$transaction(
      async (db) => {
        // Lock the proposal row for the duration of this transaction so two
        // concurrent signers can't both pass the threshold decision.
        const proposal = await db.treasuryTxProposal.findUnique({
          where: { id: args.proposalId },
        });
        if (!proposal || proposal.groupId !== args.groupId) {
          throw Errors.notFound("Treasury proposal not found");
        }
        if (proposal.status === STATUS.submitted) {
          throw Errors.conflict(
            "already_submitted",
            "Proposal has already been submitted"
          );
        }
        if (proposal.status === STATUS.failed) {
          throw Errors.conflict(
            "proposal_failed",
            "Proposal is in a failed state and cannot accept signatures"
          );
        }

        // Authorized signers are group admins whose Stellar key currently
        // carries positive signing weight on the source account — read
        // fresh from Horizon so a since-removed or reweighted signer can
        // never contribute stale weight.
        const admins = await db.groupMember.findMany({
          where: { groupId: args.groupId, role: "admin" },
          select: { userId: true, user: { select: { stellarPublicKey: true } } },
        });
        const account = await stellar.loadAccount(proposal.sourceAccount);
        if (!account.exists) {
          throw Errors.badRequest(
            "treasury_unfunded",
            "Treasury account is not funded on-chain"
          );
        }
        const onChainWeight = new Map(account.signers.map((s) => [s.key, s.weight]));
        const authorizedAdmins = admins
          .map((a) => ({
            userId: a.userId,
            publicKey: a.user.stellarPublicKey,
            weight: onChainWeight.get(a.user.stellarPublicKey) ?? 0,
          }))
          .filter((a) => a.weight > 0);

        const submitted = parseXdr(args.signedXdr, "Could not parse signed XDR");
        const submittedHash = submitted.hash().toString("hex");
        if (submittedHash !== proposal.txHash) {
          throw Errors.badRequest(
            "xdr_mismatch",
            "Submitted XDR does not match the proposal's transaction"
          );
        }
        if (submitted.signatures.length === 0) {
          throw Errors.badRequest(
            "xdr_unsigned",
            "Submitted XDR carries no signatures"
          );
        }

        const existing = await db.treasurySignature.findMany({
          where: { proposalId: proposal.id },
        });
        const signedUserIds = new Set(existing.map((s) => s.signerUserId));

        // Every signature on the envelope must be attributable to an
        // authorized admin signer and must cryptographically verify — an
        // envelope carrying any other signature is rejected outright rather
        // than having the offending signature silently ignored.
        const newSignatures: {
          userId: string;
          publicKey: string;
          weight: number;
          signature: string;
        }[] = [];
        const seenThisRequest = new Set<string>();
        for (const decorated of submitted.signatures as any[]) {
          const hint: Buffer = decorated.hint();
          const signature: Buffer = decorated.signature();

          const matched = authorizedAdmins.find((a) => {
            try {
              return Keypair.fromPublicKey(a.publicKey).signatureHint().equals(hint);
            } catch {
              return false;
            }
          });
          if (!matched) {
            throw Errors.badRequest(
              "unauthorized_signer",
              "Transaction contains a signature from a non-admin or unauthorized signer"
            );
          }

          let verified = false;
          try {
            verified = Keypair.fromPublicKey(matched.publicKey).verify(
              submitted.hash(),
              signature
            );
          } catch {
            verified = false;
          }
          if (!verified) {
            throw Errors.badRequest(
              "invalid_signature",
              `Signature for ${matched.publicKey} did not verify against the proposed transaction`
            );
          }

          // Already recorded (from a prior request or earlier in this same
          // envelope) — skip without error so re-submitting a previously
          // accepted signature is idempotent.
          if (signedUserIds.has(matched.userId) || seenThisRequest.has(matched.userId)) {
            continue;
          }
          seenThisRequest.add(matched.userId);
          newSignatures.push({
            userId: matched.userId,
            publicKey: matched.publicKey,
            weight: matched.weight,
            signature: signature.toString("base64"),
          });
        }

        for (const sig of newSignatures) {
          try {
            await db.treasurySignature.create({
              data: {
                proposalId: proposal.id,
                signerUserId: sig.userId,
                signerPublicKey: sig.publicKey,
                signature: sig.signature,
                weight: sig.weight,
              },
            });
          } catch (e) {
            // P2002 = unique constraint violation — a concurrent request
            // already recorded this signer's signature. Treat as idempotent.
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
              continue;
            }
            throw e;
          }
          await auditTx(db, {
            userId: sig.userId,
            groupId: proposal.groupId,
            action: AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED,
            entityType: "treasury_tx_proposal",
            entityId: proposal.id,
            metadata: { signerPublicKey: sig.publicKey, weight: sig.weight },
          });
        }

        const allSignatures = await db.treasurySignature.findMany({
          where: { proposalId: proposal.id },
        });
        const totalWeight = allSignatures.reduce((sum, s) => sum + s.weight, 0);
        const requiredWeight = account.thresholds.high;

        if (totalWeight < requiredWeight) {
          await db.treasuryTxProposal.update({
            where: { id: proposal.id },
            data: { status: STATUS.pendingSignatures, requiredWeight },
          });
          return {
            status: STATUS.pendingSignatures,
            totalWeight,
            requiredWeight,
            stellarTxHash: null,
          };
        }

        await db.treasuryTxProposal.update({
          where: { id: proposal.id },
          data: { status: STATUS.ready, requiredWeight },
        });
        await auditTx(db, {
          groupId: proposal.groupId,
          action: AuditAction.TREASURY_TX_PROPOSAL_READY,
          entityType: "treasury_tx_proposal",
          entityId: proposal.id,
          metadata: { totalWeight, requiredWeight },
        });

        // Merge every stored signature onto a fresh copy of the original
        // envelope (never the just-submitted one) so a signature collected
        // on an earlier request can't be dropped or duplicated.
        const base = parseXdr(proposal.xdr, "Stored proposal envelope is corrupt");
        for (const s of allSignatures) {
          try {
            base.addSignature(s.signerPublicKey, s.signature);
          } catch {
            // Signature already present on this envelope instance — skip.
          }
        }
        const mergedXdr = base.toXDR();

        try {
          const hash = await stellar.submitSigned(mergedXdr);
          await db.treasuryTxProposal.update({
            where: { id: proposal.id },
            data: { status: STATUS.submitted, stellarTxHash: hash },
          });
          await auditTx(db, {
            groupId: proposal.groupId,
            action: AuditAction.TREASURY_TX_PROPOSAL_SUBMITTED,
            entityType: "treasury_tx_proposal",
            entityId: proposal.id,
            metadata: { stellarTxHash: hash, totalWeight, requiredWeight },
          });
          return {
            status: STATUS.submitted,
            totalWeight,
            requiredWeight,
            stellarTxHash: hash,
          };
        } catch (e: any) {
          const reason = e instanceof Error ? e.message : String(e);
          await db.treasuryTxProposal.update({
            where: { id: proposal.id },
            data: { status: STATUS.failed, failureReason: reason },
          });
          await auditTx(db, {
            groupId: proposal.groupId,
            action: AuditAction.TREASURY_TX_PROPOSAL_FAILED,
            entityType: "treasury_tx_proposal",
            entityId: proposal.id,
            outcome: "failure",
            metadata: { reason, totalWeight, requiredWeight },
          });
          throw Errors.upstream(`Stellar rejected the multisig transaction: ${reason}`);
        }
      },
      { timeout: 15_000 }
    );
  },
};
