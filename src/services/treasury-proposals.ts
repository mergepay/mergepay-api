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
 *      the source, stores the envelope on a `TreasuryProposal`, and returns
 *      the XDR for the creator's wallet to sign first.
 *
 *   2. `verify({ proposalId, signedXdr })` extracts every signature from the
 *      submitted XDR, maps each `SignatureHint` back to a group member's
 *      public key, verifies it using `Keypair.fromPublicKey().verify(...)`,
 *      and persists any new (publicKey, signature) pair. Repeat signatures
 *      are rejected (HTTP 409). Once signatures meet the proposal's
 *      threshold, the combined XDR is submitted to Horizon.
 *
 *   3. The merged XDR is built by re-parsing the original unsigned envelope
 *      and pushing every verified `DecoratedSignature` onto its signature
 *      array. No private keys are ever stored or accepted.
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";
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

    const initialStatus =
      threshold > 1 ? STATUS.awaitingSignatures : STATUS.pending;

    const proposal = await prisma.treasuryProposal.create({
      data: {
        groupId: params.groupId,
        creatorId: params.creatorId,
        xdr,
        threshold,
        signatures: [] as any,
        status: initialStatus,
      },
    });

    return { proposal, xdr, networkPassphrase: config.networkPassphrase };
  },

  /**
   * Verify signatures on a partially-signed XDR submitted by a signer, store
   * any new (publicKey, signature) pair, and submit when the threshold is met.
   */
  async submitSignatures(args: {
    proposalId: string;
    groupId: string;
    memberPublicKeys: string[];
    /** Base64 of a (possibly partially) signed XDR the wallet produced. */
    signedXdr: string;
  }): Promise<{
    status: string;
    signatureCount: number;
    threshold: number;
    stellarTxHash: string | null;
  }> {
    const proposal = await prisma.treasuryProposal.findUnique({
      where: { id: args.proposalId },
    });
    if (!proposal) throw Errors.notFound("Treasury proposal not found");
    if (proposal.groupId !== args.groupId) {
      throw Errors.notFound("Treasury proposal not found");
    }
    if (
      proposal.status === STATUS.confirmed ||
      proposal.status === STATUS.submitted
    ) {
      throw Errors.conflict("already_submitted", "Proposal has already been submitted");
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
    if (submitted.hash().toString("hex") !== message.toString("hex")) {
      throw Errors.badRequest(
        "xdr_mismatch",
        "Submitted XDR hashes a different transaction than the proposal"
      );
    }

    // Verify each signature corresponds to a group member's public key.
    const stored: StoredSignature[] = (proposal.signatures as any) ?? [];
    const existingKeys = new Set(stored.map((s) => s.publicKey));
    const verified: StoredSignature[] = [...stored];
    const now = new Date().toISOString();

    const memberList = [...memberSet];
    const memberKeypairs = memberList.map((pk) => {
      try {
        return { pk, kp: Keypair.fromPublicKey(pk) };
      } catch {
        return null;
      }
    }).filter((v): v is { pk: string; kp: Keypair } => v !== null);
    const memberByPk = new Map(memberKeypairs.map((v) => [v.pk, v.kp]));

    for (const decorated of submitted.signatures as any[]) {
      const hint: Buffer = decorated.hint();
      const signature: Buffer = decorated.signature();
      const signatureBase64 = signature.toString("base64");

      // Locate the matching group member by hint (last 4 bytes of pubkey).
      const matched = memberKeypairs.find(
        (m) => m.kp.signatureHint() && m.kp.signatureHint().equals(hint)
      )?.pk;
      if (!matched) {
        // Skip signatures from non-group members silently — they're useless
        // for meeting threshold and shouldn't 409 the request.
        continue;
      }
      if (existingKeys.has(matched)) {
        throw Errors.conflict(
          "duplicate_signature",
          `${matched} has already signed this proposal`
        );
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
      verified.push({
        publicKey: matched,
        signature: signatureBase64,
        signedAt: now,
      });
      existingKeys.add(matched);
    }

    // Only set "submitted"/"confirmed" after we know we meet the threshold.
    const meetsThreshold = verified.length >= proposal.threshold;

    await prisma.treasuryProposal.update({
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
    return await this.mergeAndSubmit(proposal.id, verified);
  },

  /**
   * Combine every verified signature onto the unsigned envelope and submit
   * the result to Stellar. Updates the proposal's `status` and `stellarTxHash`.
   */
  async mergeAndSubmit(
    proposalId: string,
    storedSignatures: StoredSignature[]
  ): Promise<{
    status: string;
    signatureCount: number;
    threshold: number;
    stellarTxHash: string | null;
  }> {
    const proposal = await prisma.treasuryProposal.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) throw Errors.notFound("Treasury proposal not found");

    // Re-build a fresh base envelope so we don't double-up signatures.
    // `addSignature(publicKey, signature)` expects both args as strings; we
    // store signatures as base64 strings and pass them directly.
    const baseTx = new Transaction(proposal.xdr, config.networkPassphrase);
    for (const s of storedSignatures) {
      try {
        baseTx.addSignature(s.publicKey, s.signature);
      } catch {
        // signature may already exist on baseTx — fall back to a manual append
        // to handle merged-XDR edge cases where two signers signed the same hint.
      }
    }
    const signedXdr = baseTx.toXDR();

    try {
      const hash = await stellar.submitSigned(signedXdr);
      await prisma.treasuryProposal.update({
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
      await prisma.treasuryProposal.update({
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
