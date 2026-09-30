/**
 * Idempotent demo seed for local development.
 *
 * `npm run db:seed` converges on the same dataset every time: user identity
 * comes from deterministic Stellar keypairs, and every other row carries a
 * fixed id (or another natural unique key) and is written with an upsert. A
 * second run therefore never trips a unique constraint, never duplicates
 * data, and restores any seed-owned row to its canonical demo values.
 *
 * The data covers the standard group-expense settlement scenarios:
 *
 *  - expenses whose payer share is already settled,
 *  - a confirmed settlement (share `settled`, on-chain hash recorded),
 *  - a pending settlement awaiting a signature (share `settling`),
 *  - a failed settlement left retryable (share `settling`),
 *  - untouched shares a developer can settle through the API,
 *  - a treasury-enabled group with confirmed and pending treasury deposits,
 *  - an invite code for the demo group.
 *
 * ⚠️ Demo credentials only. Keypairs are derived from public labels
 * (`mergepay:demo:…`), so anyone can recompute these secret keys. Never fund
 * them with anything of value and never reuse them outside a disposable
 * local/testnet database.
 */

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type UserSlug = "ada" | "kola" | "zo" | "tunde";

const USER_SPECS: ReadonlyArray<{ slug: UserSlug; displayName: string }> = [
  { slug: "ada", displayName: "Ada" },
  { slug: "kola", displayName: "Kola" },
  { slug: "zo", displayName: "Zo" },
  { slug: "tunde", displayName: "Tunde" },
];

/**
 * A deterministic id for a row this script owns. Routes treat ids as opaque
 * strings capped at 64 characters (src/plugins/group-access.ts), so the cap is
 * enforced here rather than discovered at request time.
 */
function seedId(kind: string, slug: string): string {
  const id = `seed_${kind}_${slug}`;
  if (Buffer.byteLength(id, "utf8") > 64) {
    throw new Error(`seed id exceeds the 64-character route limit: ${id}`);
  }
  return id;
}

/** Deterministic demo keypair — the same label always yields the same keys. */
function demoKeypair(label: string): Keypair {
  const seed = createHash("sha256").update(`mergepay:demo:${label}`).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/** Deterministic 64-hex string shaped like a Stellar transaction hash. */
function demoTxHash(label: string): string {
  return createHash("sha256").update(`mergepay:demo:tx:${label}`).digest("hex");
}

/** `MP:<code>` payment memo — same convention as src/services/memo.ts. */
function memoFor(code: string): string {
  return `MP:${code}`;
}

interface SeededUsers {
  ids: Record<UserSlug, string>;
  keypairs: Record<UserSlug, Keypair>;
}

async function seedUsers(): Promise<SeededUsers> {
  const ids = {} as Record<UserSlug, string>;
  const keypairs = {} as Record<UserSlug, Keypair>;

  for (const spec of USER_SPECS) {
    const keypair = demoKeypair(`user:${spec.slug}`);
    // Upsert on the natural unique key so a row that already exists under a
    // generated id is updated instead of duplicated.
    const user = await prisma.user.upsert({
      where: { stellarPublicKey: keypair.publicKey() },
      update: { displayName: spec.displayName },
      create: {
        id: seedId("user", spec.slug),
        stellarPublicKey: keypair.publicKey(),
        displayName: spec.displayName,
      },
    });
    ids[spec.slug] = user.id;
    keypairs[spec.slug] = keypair;
  }

  return { ids, keypairs };
}

async function seedMember(groupId: string, userId: string, role: string): Promise<void> {
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: { role },
    create: { groupId, userId, role },
  });
}

interface ExpenseSpec {
  id: string;
  groupId: string;
  payerUserId: string;
  title: string;
  description: string;
  amount: string;
  splitType: string;
  memo: string;
  /** Share rows: fixed id, participant, amount and lifecycle status. */
  shares: ReadonlyArray<{
    id: string;
    userId: string;
    shareAmount: string;
    status: "pending" | "settling" | "settled";
  }>;
}

async function seedExpense(spec: ExpenseSpec): Promise<void> {
  await prisma.expense.upsert({
    where: { id: spec.id },
    update: {
      groupId: spec.groupId,
      payerUserId: spec.payerUserId,
      title: spec.title,
      description: spec.description,
      amount: spec.amount,
      assetCode: "XLM",
      assetIssuer: null,
      splitType: spec.splitType,
      memo: spec.memo,
      receiptUrl: null,
    },
    create: {
      id: spec.id,
      groupId: spec.groupId,
      payerUserId: spec.payerUserId,
      title: spec.title,
      description: spec.description,
      amount: spec.amount,
      assetCode: "XLM",
      assetIssuer: null,
      splitType: spec.splitType,
      memo: spec.memo,
    },
  });

  for (const share of spec.shares) {
    await prisma.expenseShare.upsert({
      where: { id: share.id },
      update: {
        expenseId: spec.id,
        userId: share.userId,
        shareAmount: share.shareAmount,
        status: share.status,
      },
      create: {
        id: share.id,
        expenseId: spec.id,
        userId: share.userId,
        shareAmount: share.shareAmount,
        status: share.status,
      },
    });
  }
}

interface SettlementSpec {
  id: string;
  /** 10-character code from the short-code alphabet (src/services/codes.ts). */
  shortCode: string;
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amount: string;
  expenseId: string;
  expenseShareId: string;
  status: "pending" | "submitted" | "verifying" | "confirmed" | "failed";
  submittedAt?: Date;
  confirmedAt?: Date;
  stellarTxHash?: string;
  retryCount?: number;
  errorCategory?: string | null;
  failureReason?: string | null;
  failureCategory?: string | null;
}

async function seedSettlement(spec: SettlementSpec): Promise<void> {
  const shared = {
    shortCode: spec.shortCode,
    groupId: spec.groupId,
    fromUserId: spec.fromUserId,
    toUserId: spec.toUserId,
    amount: spec.amount,
    assetCode: "XLM",
    assetIssuer: null,
    // No deadline on seeded intents: `expiresAt === null` means "no recorded
    // deadline" to the API (src/lib/time-bounds.ts), so demo rows stay
    // actionable instead of expiring while the database sits idle.
    expiresAt: null,
    memo: memoFor(spec.shortCode),
    expenseId: spec.expenseId,
    expenseShareId: spec.expenseShareId,
    status: spec.status,
    submittedAt: spec.submittedAt ?? null,
    confirmedAt: spec.confirmedAt ?? null,
    stellarTxHash: spec.stellarTxHash ?? null,
    transactionXdr: null,
    retryCount: spec.retryCount ?? 0,
    nextAttemptAt: null,
    errorCategory: spec.errorCategory ?? null,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    failureReason: spec.failureReason ?? null,
    failureCategory: spec.failureCategory ?? null,
    idempotencyKey: null,
  };

  await prisma.settlement.upsert({
    where: { id: spec.id },
    update: shared,
    create: { id: spec.id, ...shared },
  });
}

interface StatusHistorySpec {
  id: string;
  entityId: string;
  status: string;
  reason: string;
  createdAt: Date;
}

async function seedStatusHistory(spec: StatusHistorySpec): Promise<void> {
  await prisma.statusHistory.upsert({
    where: { id: spec.id },
    update: {
      entityType: "settlement",
      entityId: spec.entityId,
      status: spec.status,
      reason: spec.reason,
      source: "seed",
      createdAt: spec.createdAt,
    },
    create: {
      id: spec.id,
      entityType: "settlement",
      entityId: spec.entityId,
      status: spec.status,
      reason: spec.reason,
      source: "seed",
      createdAt: spec.createdAt,
    },
  });
}

interface TreasuryTxSpec {
  id: string;
  shortCode: string;
  groupId: string;
  userId: string;
  destination: string;
  amount: string;
  direction: "deposit" | "withdrawal";
  status: "pending" | "confirmed" | "failed";
  stellarTxHash?: string;
}

async function seedTreasuryTx(spec: TreasuryTxSpec): Promise<void> {
  const shared = {
    shortCode: spec.shortCode,
    groupId: spec.groupId,
    userId: spec.userId,
    direction: spec.direction,
    amount: spec.amount,
    assetCode: "XLM",
    assetIssuer: null,
    destination: spec.destination,
    status: spec.status,
    memo: memoFor(spec.shortCode),
    // Null on purpose: an unset intent hash lets a developer build and sign
    // the matching envelope themselves and still pass the confirm endpoint's
    // envelope-binding check (src/routes/treasury.ts skips it when unset).
    intendedTxHash: null,
    expiresAt: null,
    stellarTxHash: spec.stellarTxHash ?? null,
  };

  await prisma.treasuryTransaction.upsert({
    where: { id: spec.id },
    update: shared,
    create: { id: spec.id, ...shared },
  });
}

/**
 * "Lagos Trip": four members, three expenses, and the settlement scenarios
 * (confirmed, pending, and shares still open for the API to settle).
 */
async function seedLagosTrip(users: SeededUsers): Promise<void> {
  const groupId = seedId("group", "lagos_trip");
  const { ids } = users;

  await prisma.group.upsert({
    where: { id: groupId },
    update: {
      name: "Lagos Trip",
      description: "Weekend getaway expenses",
      createdByUserId: ids.ada,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
    },
    create: {
      id: groupId,
      name: "Lagos Trip",
      description: "Weekend getaway expenses",
      createdByUserId: ids.ada,
    },
  });

  await seedMember(groupId, ids.ada, "admin");
  await seedMember(groupId, ids.kola, "member");
  await seedMember(groupId, ids.zo, "member");
  await seedMember(groupId, ids.tunde, "member");

  // 40 XLM, split equally (10 each). Ada paid and her own share is settled;
  // Kola has already paid back, Zo has an unsigned intent in flight, and
  // Tunde still owes — the shape most group expense apps start from.
  await seedExpense({
    id: seedId("expense", "dinner"),
    groupId,
    payerUserId: ids.ada,
    title: "Dinner",
    description: "Farewell dinner at the beachfront restaurant",
    amount: "40",
    splitType: "equal",
    memo: "dinner",
    shares: [
      { id: seedId("share", "dinner_ada"), userId: ids.ada, shareAmount: "10", status: "settled" },
      { id: seedId("share", "dinner_kola"), userId: ids.kola, shareAmount: "10", status: "settled" },
      { id: seedId("share", "dinner_zo"), userId: ids.zo, shareAmount: "10", status: "settling" },
      { id: seedId("share", "dinner_tunde"), userId: ids.tunde, shareAmount: "10", status: "pending" },
    ],
  });

  // 24 XLM, split equally (6 each). Nothing settled yet: every non-payer
  // share is a fresh target for POST /settlements.
  await seedExpense({
    id: seedId("expense", "airport"),
    groupId,
    payerUserId: ids.tunde,
    title: "Airport transfer",
    description: "Private SUV from the airport to the hotel",
    amount: "24",
    splitType: "equal",
    memo: "airport",
    shares: [
      { id: seedId("share", "airport_ada"), userId: ids.ada, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_kola"), userId: ids.kola, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_zo"), userId: ids.zo, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_tunde"), userId: ids.tunde, shareAmount: "6", status: "settled" },
    ],
  });

  // Uneven split (20 + 15 + 10 + 10 = 55) to exercise the custom split type.
  await seedExpense({
    id: seedId("expense", "market"),
    groupId,
    payerUserId: ids.kola,
    title: "Groceries",
    description: "Market run for the weekend",
    amount: "55",
    splitType: "custom",
    memo: "market",
    shares: [
      { id: seedId("share", "market_ada"), userId: ids.ada, shareAmount: "20", status: "pending" },
      { id: seedId("share", "market_kola"), userId: ids.kola, shareAmount: "15", status: "settled" },
      { id: seedId("share", "market_zo"), userId: ids.zo, shareAmount: "10", status: "pending" },
      { id: seedId("share", "market_tunde"), userId: ids.tunde, shareAmount: "10", status: "pending" },
    ],
  });

  const submittedAt = minutesAgo(90);
  const confirmedAt = minutesAgo(75);
  const pendingAt = minutesAgo(10);

  // Confirmed: Kola paid Ada back, share settled, ledger hash recorded.
  await seedSettlement({
    id: seedId("settlement", "kola_dinner"),
    shortCode: "SEEDSETTLE",
    groupId,
    fromUserId: ids.kola,
    toUserId: ids.ada,
    amount: "10",
    expenseId: seedId("expense", "dinner"),
    expenseShareId: seedId("share", "dinner_kola"),
    status: "confirmed",
    submittedAt,
    confirmedAt,
    stellarTxHash: demoTxHash("settlement:kola-dinner"),
  });

  // Pending: Zo's intent is built but unsigned — the demo signing flow.
  await seedSettlement({
    id: seedId("settlement", "zo_dinner"),
    shortCode: "SEEDQUEUE2",
    groupId,
    fromUserId: ids.zo,
    toUserId: ids.ada,
    amount: "10",
    expenseId: seedId("expense", "dinner"),
    expenseShareId: seedId("share", "dinner_zo"),
    status: "pending",
  });

  await seedStatusHistory({
    id: seedId("status", "kola_dinner_pending"),
    entityId: seedId("settlement", "kola_dinner"),
    status: "pending",
    reason: "Settlement created for the Dinner expense",
    createdAt: submittedAt,
  });
  await seedStatusHistory({
    id: seedId("status", "kola_dinner_confirmed"),
    entityId: seedId("settlement", "kola_dinner"),
    status: "confirmed",
    reason: "Payment confirmed on the ledger",
    createdAt: confirmedAt,
  });
  await seedStatusHistory({
    id: seedId("status", "zo_dinner_pending"),
    entityId: seedId("settlement", "zo_dinner"),
    status: "pending",
    reason: "Settlement created for the Dinner expense",
    createdAt: pendingAt,
  });

  // Invite code the join flow accepts (SEEDCLUB: 8 chars, short-code alphabet).
  await prisma.invite.upsert({
    where: { id: seedId("invite", "lagos_trip") },
    update: {
      groupId,
      code: "SEEDCLUB",
      expiresAt: null,
      createdByUserId: ids.ada,
      maxUses: 10,
      uses: 0,
    },
    create: {
      id: seedId("invite", "lagos_trip"),
      groupId,
      code: "SEEDCLUB",
      expiresAt: null,
      createdByUserId: ids.ada,
      maxUses: 10,
    },
  });
}

/**
 * "Flat 12B": a treasury-enabled group with a failed (retryable) settlement
 * and the treasury deposit scenarios.
 */
async function seedFlat12B(users: SeededUsers): Promise<void> {
  const groupId = seedId("group", "flat_12b");
  const { ids } = users;
  // The shared treasury account is itself a deterministic demo keypair.
  const treasuryPublicKey = demoKeypair("treasury:flat_12b").publicKey();

  await prisma.group.upsert({
    where: { id: groupId },
    update: {
      name: "Flat 12B",
      description: "Shared flat expenses with a group treasury",
      createdByUserId: ids.ada,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryPublicKey,
      treasuryRequiredSigners: 1,
      archived: false,
    },
    create: {
      id: groupId,
      name: "Flat 12B",
      description: "Shared flat expenses with a group treasury",
      createdByUserId: ids.ada,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryPublicKey,
      treasuryRequiredSigners: 1,
    },
  });

  await seedMember(groupId, ids.ada, "admin");
  await seedMember(groupId, ids.zo, "member");
  await seedMember(groupId, ids.tunde, "member");

  // 15 XLM Wi-Fi bill (5 each). Ada's attempt failed and is retryable, so the
  // failure path (failureCategory / errorCategory) is visible in the data.
  await seedExpense({
    id: seedId("expense", "wifi"),
    groupId,
    payerUserId: ids.zo,
    title: "Wi-Fi subscription",
    description: "Monthly fibre internet for the flat",
    amount: "15",
    splitType: "equal",
    memo: "wifi",
    shares: [
      { id: seedId("share", "wifi_ada"), userId: ids.ada, shareAmount: "5", status: "settling" },
      { id: seedId("share", "wifi_zo"), userId: ids.zo, shareAmount: "5", status: "settled" },
      { id: seedId("share", "wifi_tunde"), userId: ids.tunde, shareAmount: "5", status: "pending" },
    ],
  });

  const failedAt = minutesAgo(40);
  const failedPendingAt = minutesAgo(45);

  await seedSettlement({
    id: seedId("settlement", "ada_wifi"),
    shortCode: "SEEDRETRY2",
    groupId,
    fromUserId: ids.ada,
    toUserId: ids.zo,
    amount: "5",
    expenseId: seedId("expense", "wifi"),
    expenseShareId: seedId("share", "wifi_ada"),
    status: "failed",
    retryCount: 1,
    errorCategory: "permanent",
    failureReason: "Source account could not fund the payment",
    failureCategory: "insufficient_funds",
  });

  await seedStatusHistory({
    id: seedId("status", "ada_wifi_pending"),
    entityId: seedId("settlement", "ada_wifi"),
    status: "pending",
    reason: "Settlement created for the Wi-Fi subscription expense",
    createdAt: failedPendingAt,
  });
  await seedStatusHistory({
    id: seedId("status", "ada_wifi_failed"),
    entityId: seedId("settlement", "ada_wifi"),
    status: "failed",
    reason: "Payment submission failed",
    createdAt: failedAt,
  });

  // Treasury deposits: one already on-chain, one still waiting for a signature
  // (memo MP:SEEDGRANT2, 50 XLM to the treasury account).
  await seedTreasuryTx({
    id: seedId("treasury_tx", "deposit_confirmed"),
    shortCode: "SEEDTREASR",
    groupId,
    userId: ids.ada,
    destination: treasuryPublicKey,
    amount: "100",
    direction: "deposit",
    status: "confirmed",
    stellarTxHash: demoTxHash("treasury:deposit:confirmed"),
  });
  await seedTreasuryTx({
    id: seedId("treasury_tx", "deposit_pending"),
    shortCode: "SEEDGRANT2",
    groupId,
    userId: ids.tunde,
    destination: treasuryPublicKey,
    amount: "50",
    direction: "deposit",
    status: "pending",
  });
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

async function main() {
  const users = await seedUsers();
  await seedLagosTrip(users);
  await seedFlat12B(users);

  const treasuryPublicKey = demoKeypair("treasury:flat_12b").publicKey();

  // eslint-disable-next-line no-console
  console.log("Seeded demo data (idempotent — safe to re-run):");
  // eslint-disable-next-line no-console
  console.log("  groups:   Lagos Trip (4 members), Flat 12B (3 members, treasury enabled)");
  // eslint-disable-next-line no-console
  console.log("  expenses: Dinner, Airport transfer, Groceries, Wi-Fi subscription");
  // eslint-disable-next-line no-console
  console.log("  settlements: confirmed, pending and failed examples with status history");
  // eslint-disable-next-line no-console
  console.log("  treasury: confirmed + pending deposits; invite code SEEDCLUB (Lagos Trip)");
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("Demo accounts (deterministic testnet keys — never send real funds):");
  for (const spec of USER_SPECS) {
    // eslint-disable-next-line no-console
    console.log(`  ${spec.displayName}: ${users.keypairs[spec.slug].publicKey()}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  treasury (Flat 12B): ${treasuryPublicKey}`);
  if (process.env.SEED_PRINT_SECRETS === "1") {
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Demo secret seeds (testnet only — derive them any time with SEED_PRINT_SECRETS=1):");
    for (const spec of USER_SPECS) {
      // eslint-disable-next-line no-console
      console.log(`  ${spec.displayName}: ${users.keypairs[spec.slug].secret()}`);
    }
    // eslint-disable-next-line no-console
    console.log(`  treasury: ${demoKeypair("treasury:flat_12b").secret()}`);
  } else {
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Run SEED_PRINT_SECRETS=1 npm run db:seed to print their demo secret seeds.");
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
