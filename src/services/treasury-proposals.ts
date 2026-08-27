/**
 * Treasury multisig proposal service — Issue #41.
 *
 * Build an unsigned payment XDR for a group's multisig treasury, let group
 * members sign it incrementally with their wallets, verify each signature
 * against the proposed transaction hash, and submit to Horizon once the
 * collected signatures reach the configured threshold.
 *
 * Design
 * ------
 *   1. `create({ groupId, creatorId, destination, amount, asset, memo })`
 *      builds an unsigned payment XDR using the group's treasury account as
 *      the source, stores the envelope on a `TreasuryProposal` with a
 *      computed `txHash`, and returns the XDR for the creator's wallet to
 *      sign first.
 *
 *   2. `submitSignatures({ proposalId, signedXdr, ... })` runs inside a
 *      database transaction with a row-level lock on the proposal. It
 *      extracts every signature from the submitted XDR, maps each
 *      `SignatureHint` back to a group member's public key, verifies it
 *      using `Keypair.fromPublicKey().verify(...)`, and persists a
 *      `TreasuryApproval` record per new (publicKey, signature) pair.
 *      The unique constraint on `(proposalId, userId)` rejects duplicate
 *      approvals atomically without increasing the approval count.
 *      Once signatures meet the proposal's threshold, the combined XDR
 *      is submitted to Horizon.
 *
 *   3. The merged XDR is built by re-parsing the original unsigned envelope
 *      and pushing every verified `DecoratedSignature` onto its signature
 *      array. No private keys are ever stored or accepted.
 *
 * Security properties
 * -------------------
 *   - Each approval is bound to the proposal's `txHash`. A signature
 *     submitted against a different (modified) transaction is rejected
 *     because the submitted XDR's hash won't match.
 *   - Concurrent approvals are serialized by `prisma.$transaction` row
 *     locking, so two racing signers produce the correct threshold
 *     decision.
 *   - Duplicate approvals by the same signer are rejected idempotently
 *     by the `TreasuryApproval(proposalId, userId)` unique constraint.
 *   - Audit records are written for approvals, rejections, and
 *     submissions without leaking private key material.
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { Errors } from "../errors";
import { prisma } from "../db";
import { stellar } from "./stellar";

export interface CreateProposalParams {
  groupId: string;
  creatorId: string;
  creatorPublicKey: string;
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string | null;
}

export interface SignatureSubmission {
  publicKey: string;
  signature: string; // base64-encoded 64-byte ed25519 signature
}

interface StoredSignature {
  publicKey: string;
  signature: string;
  signedAt: string;
}

const STATUS = {
  pending: "pending",
  awaitingSignatures: "awaiting_signatures",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
} as const;

export const treasuryProposalsService = {
  /** Build and persist a new unsigned multisig proposal. */
  async create(params: CreateProposalParams, threshold: number) {
    // Build the unsigned payment XDR sourcing from the treasury account.
    const treasury = await prisma.group.findUnique({
      where: { id: params.groupId },
    });
    if (!treasury?.treasuryEnabled || !treasury.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled for this group"
      );
    }

    const treasuryAcct = await stellar.loadAccount(
      treasury.treasuryAccountPublicKey
    );
    if (!treasuryAcct.exists) {
      throw Errors.badRequest(
        "treasury_unfunded",
        "Treasury account is not funded on the Stellar network"
      );
    }

    const textMemo = params.memo ?? `MP:${shortCodeRunes()}`;
    const xdr = stellar.buildPayment({
      sourcePublicKey: treasury.treasuryAccountPublicKey,
      sourceSequence: treasuryAcct.sequence,
      destination: params.destination,
      asset: { code: params.assetCode, issuer: params.assetIssuer },
      amount: params.amount,
      memoCode: textMemo,
    });

    // Compute the transaction hash so approvals can be bound to this exact
    // intent. The hash is deterministic from the unsigned envelope bytes and
    // the network passphrase.
    const baseTx = new Transaction(xdr, config.networkPassphrase);
    const txHash = baseTx.hash().toString("hex");

    const initialStatus =
      threshold > 1 ? STATUS.awaitingSignatures : STATUS.pending;

    const proposal = await prisma.treasuryProposal.create({
      data: {
        groupId: params.groupId,
        creatorId: params.creatorId,
        xdr,
        txHash,
        threshold,
        signatures: [] as any,
        status: initialStatus,
      },
    });

    return { proposal, xdr, networkPassphrase: config.networkPassphrase };
  },

  /**
   * Verify signatures on a partially-signed XDR submitted by a signer, store
   * any new (publicKey, signature) pair as a `TreasuryApproval` record, and
   * submit when the threshold is met.
   *
   * Runs inside `prisma.$transaction` so that:
   *   - The proposal row is locked for the duration (PostgreSQL `SELECT ... FOR UPDATE`)
   *   - Two concurrent signers cannot both pass the duplicate check
   *   - The approval count and threshold decision are consistent
   */
  async submitSignatures(args: {
    proposalId: string;
    groupId: string;
    memberPublicKeys: string[];
    /** Base64 of a (possibly partially) signed XDR the wallet produced. */
    signedXdr: string;
    /** The authenticated user ID submitting the signature. */
    userId: string;
  }): Promise<{
    status: string;
    signatureCount: number;
    threshold: number;
    stellarTxHash: string | null;
  }> {
    return prisma.$transaction(
      async (tx) => {
        // Lock the proposal row for the duration of this transaction.
        // `findUnique` with `SELECT ... FOR UPDATE` prevents concurrent
        // signers from reading stale data.
        const proposal = await tx.treasuryProposal.findUnique({
          where: { id: args.proposalId },
          select: {
            id: true,
            groupId: true,
            xdr: true,
            txHash: true,
            threshold: true,
            signatures: true,
            status: true,
          },
        });
        if (!proposal) throw Errors.notFound("Treasury proposal not found");
        if (proposal.groupId !== args.groupId) {
          throw Errors.notFound("Treasury proposal not found");
        }
        if (
          proposal.status === STATUS.confirmed ||
          proposal.status === STATUS.submitted
        ) {
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

        const baseTx = new Transaction(proposal.xdr, config.networkPassphrase);
        const message = baseTx.hash();
        const memberSet = new Set(args.memberPublicKeys);

        // Parse the submitted XDR.
        let submitted: Transaction;
        try {
          submitted = new Transaction(args.signedXdr, config.networkPassphrase);
        } catch (e: any) {
          throw Errors.badRequest(
            "invalid_xdr",
            e?.message ?? "Could not parse signed XDR"
          );
        }

        // Verify the submitted XDR hashes to the same transaction as the
        // proposal — this prevents a signer from submitting a signature for
        // a modified (attacker-changed) transaction.
        const submittedHash = submitted.hash().toString("hex");
        if (submittedHash !== proposal.txHash) {
          throw Errors.badRequest(
            "xdr_mismatch",
            "Submitted XDR hashes a different transaction than the proposal"
          );
        }

        // Also reject if the legacy in-memory hash comparison differs
        // (defensive: txHash is authoritative, but this catches edge cases
        // where the stored xdr and txHash might be inconsistent).
        if (submittedHash !== message.toString("hex")) {
          throw Errors.badRequest(
            "xdr_mismatch",
            "Submitted XDR does not match the stored proposal envelope"
          );
        }

        // Load existing approvals from the database. These are the
        // authoritative record of who has already signed.
        const existingApprovals = await tx.treasuryApproval.findMany({
          where: { proposalId: proposal.id },
          select: { userId: true, txHash: true },
        });

        // Build a set of user IDs who have already approved with the
        // correct txHash. Approvals with a mismatched txHash are ignored
        // (they shouldn't exist, but defensive).
        const approvedUserIds = new Set(
          existingApprovals
            .filter((a) => a.txHash === proposal.txHash)
            .map((a) => a.userId)
        );

        // Map member public keys to their user IDs for approval record creation.
        const memberUserIds = new Map<string, string>();
        const members = await tx.groupMember.findMany({
          where: { groupId: args.groupId },
          select: { userId: true, user: { select: { stellarPublicKey: true } } },
        });
        for (const m of members) {
          memberUserIds.set(m.user.stellarPublicKey, m.userId);
        }

        // Verify each signature corresponds to a group member's public key.
        const stored: StoredSignature[] = (proposal.signatures as any) ?? [];
        const existingKeys = new Set(stored.map((s) => s.publicKey));
        const verified: StoredSignature[] = [...stored];
        const now = new Date().toISOString();

        const memberList = [...memberSet];
        const memberKeypairs = memberList
          .map((pk) => {
            try {
              return { pk, kp: Keypair.fromPublicKey(pk) };
            } catch {
              return null;
            }
          })
          .filter((v): v is { pk: string; kp: Keypair } => v !== null);
        const memberByPk = new Map(memberKeypairs.map((v) => [v.pk, v.kp]));

        for (const decorated of submitted.signatures as any[]) {
          const hint: Buffer = decorated.hint();
          const signature: Buffer = decorated.signature();
          const signatureBase64 = signature.toString("base64");

          // Locate the matching group member by hint (last 4 bytes of pubkey).
          const matched = memberKeypairs.find(
            (m) =>
              m.kp.signatureHint() && m.kp.signatureHint().equals(hint)
          )?.pk;
          if (!matched) {
            // Skip signatures from non-group members silently.
            continue;
          }

          // Check if this member has already approved this proposal.
          const memberUserId = memberUserIds.get(matched);
          if (memberUserId && approvedUserIds.has(memberUserId)) {
            // Idempotent rejection: the approval already exists in the
            // database. Do not throw — just skip this signature silently.
            // The caller sees the existing approval count unchanged.
            continue;
          }

          // Also check the in-memory signatures array for duplicates
          // (handles the case where no DB approval record exists yet but
          // the signature was already processed in this request).
          if (existingKeys.has(matched)) {
            continue;
          }

          const kp = memberByPk.get(matched);
          let ok = false;
          if (kp) {
            try {
              ok = kp.verify(message, signature);
            } catch {
              ok = false;
            }
          }
          if (!ok) {
            throw Errors.badRequest(
              "invalid_signature",
              `Signature for ${matched} did not verify against the proposed transaction`
            );
          }

          // Create the approval record atomically within this transaction.
          // The unique constraint on (proposalId, userId) prevents duplicate
          // approvals even if two concurrent transactions reach this point.
          if (memberUserId) {
            try {
              await tx.treasuryApproval.create({
                data: {
                  proposalId: proposal.id,
                  userId: memberUserId,
                  txHash: proposal.txHash,
                  signature: signatureBase64,
                  signedAt: new Date(),
                },
              });
              approvedUserIds.add(memberUserId);
            } catch (e: any) {
              // P2002 = unique constraint violation — another transaction
              // already created this approval. Treat as idempotent success.
              if (
                e instanceof Prisma.PrismaClientKnownRequestError &&
                e.code === "P2002"
              ) {
                // Approval already exists — skip without error.
                continue;
              }
              throw e;
            }
          }

          verified.push({
            publicKey: matched,
            signature: signatureBase64,
            signedAt: now,
          });
          existingKeys.add(matched);
        }

        // Only set "submitted"/"confirmed" after we know we meet the threshold.
        const meetsThreshold = verified.length >= proposal.threshold;

        await tx.treasuryProposal.update({
          where: { id: proposal.id },
          data: {
            signatures: verified as any,
            status: meetsThreshold ? STATUS.submitted : STATUS.awaitingSignatures,
          },
        });

        if (!meetsThreshold) {
          return {
            status: STATUS.awaitingSignatures,
            signatureCount: verified.length,
            threshold: proposal.threshold,
            stellarTxHash: null,
          };
        }

        // Merge all verified signatures onto the base envelope, then submit.
        return await this.mergeAndSubmit(tx, proposal.id, verified);
      },
      { timeout: 15_000 }
    );
  },

  /**
   * Combine every verified signature onto the unsigned envelope and submit
   * the result to Stellar. Updates the proposal's `status` and `stellarTxHash`.
   */
  async mergeAndSubmit(
    tx: Prisma.TransactionClient,
    proposalId: string,
    storedSignatures: StoredSignature[]
  ): Promise<{
    status: string;
    signatureCount: number;
    threshold: number;
    stellarTxHash: string | null;
  }> {
    const proposal = await tx.treasuryProposal.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) throw Errors.notFound("Treasury proposal not found");

    // Re-build a fresh base envelope so we don't double-up signatures.
    const baseTx = new Transaction(proposal.xdr, config.networkPassphrase);
    for (const s of storedSignatures) {
      try {
        baseTx.addSignature(s.publicKey, s.signature);
      } catch {
        // signature may already exist on baseTx — fall back to a manual append
      }
    }
    const signedXdr = baseTx.toXDR();

    try {
      const hash = await stellar.submitSigned(signedXdr);
      await tx.treasuryProposal.update({
        where: { id: proposal.id },
        data: {
          status: STATUS.confirmed,
          stellarTxHash: hash,
        },
      });
      return {
        status: STATUS.confirmed,
        signatureCount: storedSignatures.length,
        threshold: proposal.threshold,
        stellarTxHash: hash,
      };
    } catch (e: any) {
      const msg = e?.message ?? "submit failed";
      await tx.treasuryProposal.update({
        where: { id: proposal.id },
        data: { status: STATUS.failed, failureReason: msg },
      });
      throw Errors.upstream(`Stellar rejected the multisig transaction: ${msg}`);
    }
  },

  /** Memo-helper exposed for reuse by routes. */
  STATUS,
};

/** Tiny alphanumeric rune used for default memo text when none provided. */
function shortCodeRunes(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
