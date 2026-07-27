import crypto from "node:crypto";
import { Keypair, StrKey, Transaction } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { stellar, type AssetSpec } from "./stellar";

export interface TreasurySignature {
  publicKey: string;
  signature: string;
}

export interface TreasuryProposalRecord {
  id: string;
  groupId: string;
  creatorId: string;
  xdr: string;
  status: string;
  signatures: TreasurySignature[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TreasuryProposalIntent {
  sourcePublicKey: string;
  destination: string;
  amount: string;
  asset: AssetSpec;
  memoCode: string;
}

function proposalRow(row: any): TreasuryProposalRecord {
  const signatures = Array.isArray(row.signatures)
    ? row.signatures
    : JSON.parse(row.signatures ?? "[]");

  return {
    id: row.id,
    groupId: row.groupId,
    creatorId: row.creatorId,
    xdr: row.xdr,
    status: row.status,
    signatures,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export async function buildPaymentXdr(
  treasuryAccount: string,
  destination: string,
  amount: string,
  asset: AssetSpec,
): Promise<string> {
  const account = await stellar.loadAccount(treasuryAccount);
  if (!account.exists) {
    throw Errors.badRequest("treasury_unfunded", "Treasury account is not funded");
  }

  return stellar.buildPayment({
    sourcePublicKey: treasuryAccount,
    sourceSequence: account.sequence,
    destination,
    asset,
    amount,
    memoCode: `TR${Date.now().toString(36)}`.slice(-10),
  });
}

export function addSignature(
  xdr: string,
  publicKey: string,
  signature: string,
): { xdr: string; signature: TreasurySignature } {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw Errors.badRequest("invalid_public_key", "Not a valid Stellar public key");
  }

  let tx: Transaction;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("invalid_xdr", "Invalid Stellar transaction XDR");
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    throw Errors.badRequest("invalid_signature", "Invalid signature encoding");
  }

  if (signatureBytes.length !== 64) {
    throw Errors.badRequest("invalid_signature", "Invalid Stellar signature");
  }

  if (!Keypair.fromPublicKey(publicKey).verify(tx.hash(), signatureBytes)) {
    throw Errors.badRequest(
      "invalid_signature",
      "Signature does not match the transaction",
    );
  }

  const existing = tx.signatures.some(
    (entry: any) => Buffer.from(entry.signature).toString("base64") === signature,
  );
  if (existing) {
    throw Errors.conflict(
      "duplicate_signature",
      "This signature has already been added",
    );
  }

  tx.addSignature(publicKey, signatureBytes);
  return {
    xdr: tx.toXDR(),
    signature: { publicKey, signature },
  };
}

export function transactionIntent(xdr: string): TreasuryProposalIntent {
  let tx: Transaction;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("invalid_xdr", "Invalid Stellar transaction XDR");
  }

  if (
    tx.operations.length !== 1 ||
    (tx.operations[0] as any).type !== "payment"
  ) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Treasury proposals must contain one payment",
    );
  }

  const operation = tx.operations[0] as any;
  const memo =
    tx.memo && (tx.memo as any).value
      ? String((tx.memo as any).value)
      : "";

  if (!memo.startsWith("MP:") && !memo.startsWith("TR")) {
    throw Errors.badRequest("xdr_mismatch", "Treasury transaction memo is missing");
  }

  const asset = operation.asset;
  return {
    sourcePublicKey: tx.source,
    destination: operation.destination,
    amount: operation.amount,
    asset: asset.isNative()
      ? { code: "XLM", issuer: null }
      : { code: asset.code, issuer: asset.issuer },
    memoCode: memo.startsWith("MP:") ? memo.slice(3) : memo,
  };
}

export async function checkThresholdAndSubmit(
  proposal: TreasuryProposalRecord,
  threshold: number,
): Promise<{ status: string; transactionHash?: string }> {
  if (proposal.status === "submitted" || proposal.status === "confirmed") {
    return { status: proposal.status };
  }

  if (proposal.signatures.length < threshold) {
    return { status: "pending" };
  }

  const intent = transactionIntent(proposal.xdr);
  try {
    const transactionHash = await stellar.submitPayment(proposal.xdr, intent);
    await prisma.$executeRawUnsafe(
      'UPDATE "TreasuryProposal" SET status = $1, "updatedAt" = NOW() WHERE id = $2',
      "submitted",
      proposal.id,
    );
    return { status: "submitted", transactionHash };
  } catch (error) {
    await prisma.$executeRawUnsafe(
      'UPDATE "TreasuryProposal" SET status = $1, "updatedAt" = NOW() WHERE id = $2',
      "failed",
      proposal.id,
    );
    throw error;
  }
}

export async function findProposal(
  id: string,
): Promise<TreasuryProposalRecord | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    'SELECT id, "groupId", "creatorId", xdr, status, signatures, "createdAt", "updatedAt" FROM "TreasuryProposal" WHERE id = $1',
    id,
  );
  return rows.length ? proposalRow(rows[0]) : null;
}

export async function listProposals(
  groupId: string,
): Promise<TreasuryProposalRecord[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    'SELECT id, "groupId", "creatorId", xdr, status, signatures, "createdAt", "updatedAt" FROM "TreasuryProposal" WHERE "groupId" = $1 ORDER BY "createdAt" DESC',
    groupId,
  );
  return rows.map(proposalRow);
}

export async function createProposal(
  groupId: string,
  creatorId: string,
  xdr: string,
): Promise<TreasuryProposalRecord> {
  const id = crypto.randomUUID();

  await prisma.$executeRawUnsafe(
    'INSERT INTO "TreasuryProposal" (id, "groupId", "creatorId", xdr, status, signatures, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())',
    id,
    groupId,
    creatorId,
    xdr,
    "pending",
    "[]",
  );

  const proposal = await findProposal(id);
  if (!proposal) {
    throw Errors.internal("Unable to create treasury proposal");
  }
  return proposal;
}

export async function updateProposalSignatures(
  id: string,
  signatures: TreasurySignature[],
  xdr: string,
  status: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    'UPDATE "TreasuryProposal" SET xdr = $1, signatures = $2::jsonb, status = $3, "updatedAt" = NOW() WHERE id = $4',
    xdr,
    JSON.stringify(signatures),
    status,
    id,
  );
}
