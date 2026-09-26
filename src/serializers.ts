/**
 * Serializers: Prisma models -> API JSON contract (camelCase, Decimal->string,
 * Date->ISO). These shapes mirror mergepay-web/src/lib/types.ts exactly.
 */

import type { Prisma } from "@prisma/client";

function dec(v: Prisma.Decimal | string | number): string {
  return v.toString();
}

function iso(d: Date): string {
  return d.toISOString();
}

export function serializeStatusHistory(h: any) {
  return {
    id: h.id,
    entityType: h.entityType,
    entityId: h.entityId,
    status: h.status,
    reason: h.reason ?? null,
    source: h.source ?? null,
    createdAt: iso(h.createdAt),
  };
}

export function serializeUser(u: any) {
  return {
    id: u.id,
    stellarPublicKey: u.stellarPublicKey,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? null,
    createdAt: iso(u.createdAt),
  };
}

export function serializeGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    createdByUserId: g.createdByUserId,
    treasuryEnabled: g.treasuryEnabled,
    treasuryAccountPublicKey: g.treasuryAccountPublicKey ?? null,
    treasuryRequiredSigners: g.treasuryRequiredSigners ?? null,
    archived: g.archived,
    createdAt: iso(g.createdAt),
  };
}

export function serializeMember(m: any) {
  return {
    id: m.id,
    groupId: m.groupId,
    userId: m.userId,
    role: m.role,
    joinedAt: iso(m.joinedAt),
    user: serializeUser(m.user),
  };
}

export function serializeShare(s: any) {
  return {
    id: s.id,
    expenseId: s.expenseId,
    userId: s.userId,
    user: serializeUser(s.user),
    shareAmount: dec(s.shareAmount),
    status: s.status,
  };
}

export function serializeExpense(e: any) {
  return {
    id: e.id,
    groupId: e.groupId,
    payerUserId: e.payerUserId,
    payer: serializeUser(e.payer),
    title: e.title,
    description: e.description ?? null,
    amount: dec(e.amount),
    assetCode: e.assetCode,
    assetIssuer: e.assetIssuer ?? null,
    splitType: e.splitType,
    memo: e.memo ?? null,
    receiptUrl: e.receiptUrl ?? null,
    createdAt: iso(e.createdAt),
    shares: (e.shares ?? []).map(serializeShare),
  };
}

export function serializeSettlement(s: any) {
  return {
    id: s.id,
    groupId: s.groupId,
    fromUserId: s.fromUserId,
    from: serializeUser(s.from),
    toUserId: s.toUserId,
    to: serializeUser(s.to),
    amount: dec(s.amount),
    assetCode: s.assetCode,
    assetIssuer: s.assetIssuer ?? null,
    stellarTxHash: s.stellarTxHash ?? null,
    status: s.status,
    failureReason: s.failureReason ?? null,
    retryCount: s.retryCount,
    submittedAt: s.submittedAt ? iso(s.submittedAt) : null,
    confirmedAt: s.confirmedAt ? iso(s.confirmedAt) : null,
    memo: s.memo ?? null,
    expenseId: s.expenseId ?? null,
    expenseShareId: s.expenseShareId ?? null,
    createdAt: iso(s.createdAt),
    expiresAt: s.expiresAt ? iso(s.expiresAt) : null,
    statusHistory: (s.statusHistory ?? []).map(serializeStatusHistory),
  };
}

export function serializeTreasuryTx(t: any) {
  return {
    id: t.id,
    groupId: t.groupId,
    userId: t.userId ?? null,
    user: t.user ? serializeUser(t.user) : null,
    direction: t.direction,
    amount: dec(t.amount),
    assetCode: t.assetCode,
    assetIssuer: t.assetIssuer ?? null,
    destination: t.destination ?? null,
    stellarTxHash: t.stellarTxHash ?? null,
    status: t.status,
    memo: t.memo ?? null,
    expiresAt: t.expiresAt ? iso(t.expiresAt) : null,
    createdAt: iso(t.createdAt),
  };
}

export function serializeTreasuryProposal(p: any) {
  return {
    id: p.id,
    groupId: p.groupId,
    creatorId: p.creatorId,
    xdr: p.xdr,
    threshold: p.threshold,
    signatures: p.signatures ?? [],
    signatureCount: Array.isArray(p.signatures) ? p.signatures.length : 0,
    status: p.status,
    stellarTxHash: p.stellarTxHash ?? null,
    failureReason: p.failureReason ?? null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function serializeTreasurySignature(s: any) {
  return {
    id: s.id,
    signerPublicKey: s.signerPublicKey,
    weight: s.weight,
    createdAt: iso(s.createdAt),
  };
}

export function serializeTreasuryTxProposal(p: any) {
  return {
    id: p.id,
    groupId: p.groupId,
    creatorId: p.creatorId,
    xdr: p.xdr,
    sourceAccount: p.sourceAccount,
    requiredWeight: p.requiredWeight,
    signatures: Array.isArray(p.signatures)
      ? p.signatures.map(serializeTreasurySignature)
      : [],
    totalWeight: Array.isArray(p.signatures)
      ? p.signatures.reduce((sum: number, s: any) => sum + s.weight, 0)
      : undefined,
    status: p.status,
    stellarTxHash: p.stellarTxHash ?? null,
    failureReason: p.failureReason ?? null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function serializeInvitation(i: any) {
  return {
    id: i.id,
    groupId: i.groupId,
    inviteePublicKey: i.inviteePublicKey,
    status: i.status,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
  };
}

export function serializeInvite(i: any, webUrl: string) {
  return {
    id: i.id,
    groupId: i.groupId,
    code: i.code,
    url: `${webUrl}/join/${i.code}`,
    expiresAt: i.expiresAt ? iso(i.expiresAt) : null,
    maxUses: i.maxUses ?? null,
    uses: i.uses,
    createdAt: iso(i.createdAt),
  };
}

export function serializeAnchorSession(s: any) {
  return {
    id: s.id,
    userId: s.userId,
    anchorName: s.anchorName,
    kind: s.kind,
    assetCode: s.assetCode,
    interactiveUrl: s.interactiveUrl ?? null,
    externalTransactionId: s.externalTransactionId ?? null,
    status: s.status,
    statusHistory: (s.statusHistory ?? []).map(serializeStatusHistory),
    failureReason: s.failureReason ?? null,
    retryCount: s.retryCount ?? 0,
    lastPolledAt: s.lastPolledAt ? iso(s.lastPolledAt) : null,
    createdAt: iso(s.createdAt),
  };
}

// Metadata keys that must never reach the client, even if a future write
// path accidentally includes them (audit metadata is meant to be a small
// operational breadcrumb, not a payload dump).
const SENSITIVE_AUDIT_METADATA_KEYS = new Set([
  "signedxdr",
  "transactionxdr",
  "xdr",
  "token",
  "jwt",
  "secret",
  "password",
  "privatekey",
  "secretkey",
  "authorization",
]);

function redactAuditMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (SENSITIVE_AUDIT_METADATA_KEYS.has(key.toLowerCase())) continue;
    redacted[key] = value;
  }
  return redacted;
}

export function serializeAuditLogEntry(e: any) {
  return {
    id: e.id,
    createdAt: iso(e.createdAt),
    actorUserId: e.userId ?? null,
    actorDisplayName: e.user?.displayName ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    metadata: redactAuditMetadata(e.metadata),
  };
}
