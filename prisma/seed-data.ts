/**
 * The demo dataset `npm run db:seed` writes, separated from the database.
 *
 * Issue #670. The seed has long *claimed* to be idempotent, and a claim a test
 * cannot reach is not a property anyone can rely on: `prisma/seed.ts` built its
 * rows and wrote them in the same breath, so nothing outside a live database
 * could inspect what it would produce. This module splits the two halves —
 * `buildDataset()` is pure and deterministic, `runSeed(db)` only writes — so
 *
 *   - the dataset's internal consistency (every foreign key resolves, share
 *     sums match their expense, no two rows fight over a unique column) is
 *     assertable with no database at all (`tests/seed-dataset.test.ts`), and
 *   - the idempotency claim itself is assertable against real Postgres, by
 *     replaying `runSeed` twice inside a transaction that is rolled back
 *     (`tests/integration/seed-multisig.test.ts`).
 *
 * Both halves are also what the seed's own `main()` uses, so the file that
 * `tsx prisma/seed.ts` runs and the file the tests import cannot drift apart.
 *
 * Determinism
 * -----------
 * Every row is keyed by a fixed id (`seedId`) or another natural unique column,
 * every keypair is derived from a public label (`demoKeypair`), and the only
 * clock-dependent values are the demo timestamps, which are all derived from the
 * `now` passed in. `buildDataset(now)` called twice with the same `now` is
 * therefore byte-identical, which is what makes the second run's convergence
 * checkable rather than merely hoped for.
 *
 * ⚠️ Demo credentials only. Keypairs are derived from public labels
 * (`mergepay:demo:…`), so anyone can recompute these secret keys. Never fund
 * them with anything of value and never reuse them outside a disposable
 * local/testnet database.
 */
import { createHash } from "node:crypto";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
} from "@stellar/stellar-sdk";
import type { Prisma, PrismaClient } from "@prisma/client";

/** The client `runSeed` writes through: a `PrismaClient`, or a transaction. */
export type SeedClient = PrismaClient | Prisma.TransactionClient;

/** Testnet is the only network demo data could ever mean. */
export const DEMO_NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * Seconds since the epoch a seeded multisig envelope stays signed until.
 *
 * A fixed date rather than "now + N": the envelope's expiry is part of its
 * bytes, so a moving deadline would make `xdr`, `txHash` and every signature
 * differ between runs, and "converges on the same dataset every time" would no
 * longer be checkable. This one is decades out, so the fixtures stay usable for
 * a developer who seeds a database and leaves it sitting.
 */
export const DEMO_SIGNING_DEADLINE_EPOCH = Math.floor(
  Date.UTC(2036, 0, 1) / 1000
);

export type UserSlug = "ada" | "kola" | "zo" | "tunde";

export const USER_SPECS: ReadonlyArray<{ slug: UserSlug; displayName: string }> =
  [
    { slug: "ada", displayName: "Ada" },
    { slug: "kola", displayName: "Kola" },
    { slug: "zo", displayName: "Zo" },
    { slug: "tunde", displayName: "Tunde" },
  ];

/**
 * A deterministic id for a row this dataset owns. Routes treat ids as opaque
 * strings capped at 64 characters (src/plugins/group-access.ts), so the cap is
 * enforced here rather than discovered at request time.
 */
export function seedId(kind: string, slug: string): string {
  const id = `seed_${kind}_${slug}`;
  if (Buffer.byteLength(id, "utf8") > 64) {
    throw new Error(`seed id exceeds the 64-character route limit: ${id}`);
  }
  return id;
}

/** Deterministic demo keypair — the same label always yields the same keys. */
export function demoKeypair(label: string): Keypair {
  const seed = createHash("sha256").update(`mergepay:demo:${label}`).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

/** Deterministic 64-hex string shaped like a Stellar transaction hash. */
export function demoTxHash(label: string): string {
  return createHash("sha256").update(`mergepay:demo:tx:${label}`).digest("hex");
}

/** `MP:<code>` payment memo — same convention as src/services/memo.ts. */
export function memoFor(code: string): string {
  return `MP:${code}`;
}

function minutesAgo(minutes: number, now: Date): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

/**
 * Build the unsigned envelope a demo multisig proposal spends.
 *
 * Deliberately shaped the way the collector's own policy requires
 * (src/services/treasury-stellar.ts, issue #666): sourced from the treasury
 * account, one payment operation, a fee inside the band the payment path uses,
 * and an expiring window that has not lapsed. Seed data that the API's own
 * validator would refuse would demo nothing but a broken fixture.
 */
export function demoTreasuryEnvelope(params: {
  treasuryPublicKey: string;
  destination: string;
  amount: string;
  memo: string;
  /** Sequence the demo treasury account is assumed to be at. */
  sequence?: string;
}): string {
  const tx = new TransactionBuilder(
    new Account(params.treasuryPublicKey, params.sequence ?? "1"),
    {
      fee: "200",
      networkPassphrase: DEMO_NETWORK_PASSPHRASE,
      timebounds: {
        minTime: 0,
        maxTime: DEMO_SIGNING_DEADLINE_EPOCH,
      },
    }
  )
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: new Asset("XLM"),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(params.memo))
    .build();
  return tx.toXDR();
}

/** Decode an envelope so its hash and signatures can be computed for fixtures. */
function decodeTreasuryEnvelope(xdr: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(xdr, DEMO_NETWORK_PASSPHRASE);
  if (!(parsed instanceof Transaction)) {
    throw new Error("seed envelopes must be transaction envelopes, not fee bumps");
  }
  return parsed;
}

/**
 * Everything `runSeed` writes, as data.
 *
 * Field names follow `schema.prisma`. The per-table arrays are the rows in the
 * order they must be written, because the foreign keys are real: a share before
 * its expense, a signature before its proposal's group exists, and so on.
 */
export interface SeedDataset {
  users: Array<{
    id: string;
    stellarPublicKey: string;
    displayName: string;
  }>;
  groups: Array<{
    id: string;
    name: string;
    description: string;
    createdByUserId: string;
    treasuryEnabled: boolean;
    treasuryAccountPublicKey: string | null;
    treasuryRequiredSigners: number | null;
    archived: boolean;
  }>;
  groupMembers: Array<{ groupId: string; userId: string; role: string }>;
  expenses: Array<{
    id: string;
    groupId: string;
    payerUserId: string;
    title: string;
    description: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    splitType: string;
    memo: string;
    receiptUrl: null;
  }>;
  expenseShares: Array<{
    id: string;
    expenseId: string;
    userId: string;
    shareAmount: string;
    status: "pending" | "settling" | "settled";
  }>;
  settlements: Array<{
    id: string;
    shortCode: string;
    groupId: string;
    fromUserId: string;
    toUserId: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    expiresAt: null;
    memo: string;
    expenseId: string;
    expenseShareId: string;
    status: string;
    submittedAt: Date | null;
    confirmedAt: Date | null;
    stellarTxHash: string | null;
    transactionXdr: null;
    retryCount: number;
    nextAttemptAt: null;
    errorCategory: string | null;
    claimedBy: null;
    claimedAt: null;
    leaseExpiresAt: null;
    failureReason: string | null;
    failureCategory: string | null;
    idempotencyKey: null;
  }>;
  statusHistory: Array<{
    id: string;
    entityType: "settlement";
    entityId: string;
    status: string;
    reason: string;
    source: "seed";
    createdAt: Date;
  }>;
  treasuryTransactions: Array<{
    id: string;
    shortCode: string;
    groupId: string;
    userId: string;
    direction: "deposit" | "withdrawal";
    amount: string;
    assetCode: string;
    assetIssuer: null;
    destination: string;
    status: string;
    memo: string;
    intendedTxHash: null;
    expiresAt: null;
    stellarTxHash: string | null;
  }>;
  invites: Array<{
    id: string;
    groupId: string;
    code: string;
    expiresAt: null;
    createdByUserId: string;
    maxUses: number;
    uses: number;
  }>;
  treasuryTxProposals: Array<{
    id: string;
    groupId: string;
    creatorId: string;
    xdr: string;
    description: string;
    txHash: string;
    sourceAccount: string;
    requiredWeight: number;
    status: string;
    stellarTxHash: string | null;
    failureReason: string | null;
  }>;
  treasurySignatures: Array<{
    id: string;
    proposalId: string;
    signerUserId: string;
    signerPublicKey: string;
    /** Base64 ed25519 signature over the proposal envelope's hash. */
    signature: string;
    weight: number;
    createdAt: Date;
  }>;
  treasuryProposals: Array<{
    id: string;
    groupId: string;
    creatorId: string;
    xdr: string;
    txHash: string;
    threshold: number;
    /** `{ publicKey, signature }` records, as the route stores them. */
    signatures: Array<{ publicKey: string; signature: string }>;
    status: string;
    stellarTxHash: string | null;
    failureReason: string | null;
  }>;
  treasuryApprovals: Array<{
    id: string;
    proposalId: string;
    userId: string;
    txHash: string;
    signature: string;
    signedAt: Date;
  }>;
}

/** The ids and keys a caller (seed output, tests) needs to name the rows. */
export interface SeedRefs {
  userIds: Record<UserSlug, string>;
  keypairs: Record<UserSlug, Keypair>;
  /** Flat 12B's treasury account. */
  treasuryPublicKey: string;
  /** Studio Co-op's 2-of-3 treasury account. */
  multisigTreasuryPublicKey: string;
}

export function seedRefs(): SeedRefs {
  const userIds = {} as Record<UserSlug, string>;
  const keypairs = {} as Record<UserSlug, Keypair>;
  for (const spec of USER_SPECS) {
    userIds[spec.slug] = seedId("user", spec.slug);
    keypairs[spec.slug] = demoKeypair(`user:${spec.slug}`);
  }
  return {
    userIds,
    keypairs,
    treasuryPublicKey: demoKeypair("treasury:flat_12b").publicKey(),
    multisigTreasuryPublicKey: demoKeypair("treasury:studio_coop").publicKey(),
  };
}

/**
 * The full demo dataset. Pure: no database, no clock read of its own.
 *
 * @param now - Timestamp the relative demo timestamps hang off. Pass a fixed
 *   date to get a byte-identical dataset back every time.
 */
export function buildDataset(now: Date = new Date()): SeedDataset {
  const refs = seedRefs();
  const { userIds, keypairs } = refs;
  const ada = userIds.ada;
  const kola = userIds.kola;
  const zo = userIds.zo;
  const tunde = userIds.tunde;

  const lagosTrip = seedId("group", "lagos_trip");
  const flat12b = seedId("group", "flat_12b");
  const studioCoop = seedId("group", "studio_coop");
  const rentPayer = demoKeypair("merchant:rent_payee").publicKey();

  // -- treasury multisig fixtures -----------------------------------------
  //
  // Two envelopes, both policy-shaped: one still collecting signatures, one
  // complete and submitted. Signatures below are real ed25519 signatures over
  // the envelope hash, so a developer can copy a row into a verifier and have
  // it check out — a placeholder string would demo a multisig flow that could
  // never actually have produced it.
  const collectingXdr = demoTreasuryEnvelope({
    treasuryPublicKey: refs.multisigTreasuryPublicKey,
    destination: rentPayer,
    amount: "120.0000000",
    memo: "MP:SEEDRENT1",
  });
  const collectingTx = decodeTreasuryEnvelope(collectingXdr);
  const collectingHash = collectingTx.hash().toString("hex");

  const submittedXdr = demoTreasuryEnvelope({
    treasuryPublicKey: refs.multisigTreasuryPublicKey,
    destination: demoKeypair("merchant:gear_lease").publicKey(),
    amount: "45.0000000",
    memo: "MP:SEEDGEAR2",
    sequence: "2",
  });
  const submittedTx = decodeTreasuryEnvelope(submittedXdr);
  const submittedHash = submittedTx.hash().toString("hex");

  const signatureOf = (tx: Transaction, signer: Keypair): string =>
    signer.sign(tx.hash()).toString("base64");

  const adaSignature = signatureOf(collectingTx, keypairs.ada);
  const kolaSignature = signatureOf(submittedTx, keypairs.kola);
  const zoSignature = signatureOf(submittedTx, keypairs.zo);

  // The other multisig stack (src/routes/treasury-proposals.ts) builds its own
  // payment XDR server-side and stores approvals as JSON on the proposal; one
  // pending proposal with a single recorded approval demos that flow too.
  const serverBuiltXdr = demoTreasuryEnvelope({
    treasuryPublicKey: refs.multisigTreasuryPublicKey,
    destination: demoKeypair("member:utilities_payee").publicKey(),
    amount: "30.0000000",
    memo: "MP:SEEDLIGHT3",
    sequence: "3",
  });
  const serverBuiltTx = decodeTreasuryEnvelope(serverBuiltXdr);
  const serverBuiltHash = serverBuiltTx.hash().toString("hex");
  const zoApproval = signatureOf(serverBuiltTx, keypairs.zo);

  return {
    users: USER_SPECS.map((spec) => ({
      id: userIds[spec.slug],
      stellarPublicKey: keypairs[spec.slug].publicKey(),
      displayName: spec.displayName,
    })),

    groups: [
      {
        id: lagosTrip,
        name: "Lagos Trip",
        description: "Weekend getaway expenses",
        createdByUserId: ada,
        treasuryEnabled: false,
        treasuryAccountPublicKey: null,
        treasuryRequiredSigners: null,
        archived: false,
      },
      {
        id: flat12b,
        name: "Flat 12B",
        description: "Shared flat expenses with a group treasury",
        createdByUserId: ada,
        treasuryEnabled: true,
        treasuryAccountPublicKey: refs.treasuryPublicKey,
        treasuryRequiredSigners: 1,
        archived: false,
      },
      {
        // A second, *multisig* treasury: the single-signer group above cannot
        // exercise the signature collector at all — with a threshold of one the
        // first signature submits the transaction — so 2-of-3 is the shape that
        // lets a developer see PENDING_SIGNATURES -> SUBMITTED.
        id: studioCoop,
        name: "Studio Co-op",
        description: "Shared studio, funded through a 2-of-3 multisig treasury",
        createdByUserId: ada,
        treasuryEnabled: true,
        treasuryAccountPublicKey: refs.multisigTreasuryPublicKey,
        treasuryRequiredSigners: 2,
        archived: false,
      },
    ],

    groupMembers: [
      { groupId: lagosTrip, userId: ada, role: "admin" },
      { groupId: lagosTrip, userId: kola, role: "member" },
      { groupId: lagosTrip, userId: zo, role: "member" },
      { groupId: lagosTrip, userId: tunde, role: "member" },
      { groupId: flat12b, userId: ada, role: "admin" },
      { groupId: flat12b, userId: zo, role: "member" },
      { groupId: flat12b, userId: tunde, role: "member" },
      // All three are admins because a treasury signature may only be
      // contributed by a group admin (src/services/treasury-signatures.ts).
      { groupId: studioCoop, userId: ada, role: "admin" },
      { groupId: studioCoop, userId: kola, role: "admin" },
      { groupId: studioCoop, userId: zo, role: "admin" },
    ],

    expenses: [
      {
        id: seedId("expense", "dinner"),
        groupId: lagosTrip,
        payerUserId: ada,
        title: "Dinner",
        description: "Farewell dinner at the beachfront restaurant",
        amount: "40",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "equal",
        memo: "dinner",
        receiptUrl: null,
      },
      {
        id: seedId("expense", "airport"),
        groupId: lagosTrip,
        payerUserId: tunde,
        title: "Airport transfer",
        description: "Private SUV from the airport to the hotel",
        amount: "24",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "equal",
        memo: "airport",
        receiptUrl: null,
      },
      {
        id: seedId("expense", "market"),
        groupId: lagosTrip,
        payerUserId: kola,
        title: "Groceries",
        description: "Market run for the weekend",
        amount: "55",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "custom",
        memo: "market",
        receiptUrl: null,
      },
      {
        id: seedId("expense", "wifi"),
        groupId: flat12b,
        payerUserId: zo,
        title: "Wi-Fi subscription",
        description: "Monthly fibre internet for the flat",
        amount: "15",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "equal",
        memo: "wifi",
        receiptUrl: null,
      },
      {
        id: seedId("expense", "rent"),
        groupId: studioCoop,
        payerUserId: kola,
        title: "Studio rent",
        description: "Monthly rent, paid from the group treasury",
        amount: "120",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "equal",
        memo: "rent",
        receiptUrl: null,
      },
    ],

    expenseShares: [
      { id: seedId("share", "dinner_ada"), expenseId: seedId("expense", "dinner"), userId: ada, shareAmount: "10", status: "settled" },
      { id: seedId("share", "dinner_kola"), expenseId: seedId("expense", "dinner"), userId: kola, shareAmount: "10", status: "settled" },
      { id: seedId("share", "dinner_zo"), expenseId: seedId("expense", "dinner"), userId: zo, shareAmount: "10", status: "settling" },
      { id: seedId("share", "dinner_tunde"), expenseId: seedId("expense", "dinner"), userId: tunde, shareAmount: "10", status: "pending" },

      { id: seedId("share", "airport_ada"), expenseId: seedId("expense", "airport"), userId: ada, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_kola"), expenseId: seedId("expense", "airport"), userId: kola, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_zo"), expenseId: seedId("expense", "airport"), userId: zo, shareAmount: "6", status: "pending" },
      { id: seedId("share", "airport_tunde"), expenseId: seedId("expense", "airport"), userId: tunde, shareAmount: "6", status: "settled" },

      { id: seedId("share", "market_ada"), expenseId: seedId("expense", "market"), userId: ada, shareAmount: "20", status: "pending" },
      { id: seedId("share", "market_kola"), expenseId: seedId("expense", "market"), userId: kola, shareAmount: "15", status: "settled" },
      { id: seedId("share", "market_zo"), expenseId: seedId("expense", "market"), userId: zo, shareAmount: "10", status: "pending" },
      { id: seedId("share", "market_tunde"), expenseId: seedId("expense", "market"), userId: tunde, shareAmount: "10", status: "pending" },

      { id: seedId("share", "wifi_ada"), expenseId: seedId("expense", "wifi"), userId: ada, shareAmount: "5", status: "settling" },
      { id: seedId("share", "wifi_zo"), expenseId: seedId("expense", "wifi"), userId: zo, shareAmount: "5", status: "settled" },
      { id: seedId("share", "wifi_tunde"), expenseId: seedId("expense", "wifi"), userId: tunde, shareAmount: "5", status: "pending" },

      { id: seedId("share", "rent_ada"), expenseId: seedId("expense", "rent"), userId: ada, shareAmount: "40", status: "settled" },
      { id: seedId("share", "rent_kola"), expenseId: seedId("expense", "rent"), userId: kola, shareAmount: "40", status: "settled" },
      { id: seedId("share", "rent_zo"), expenseId: seedId("expense", "rent"), userId: zo, shareAmount: "40", status: "settled" },
    ],

    settlements: [
      {
        id: seedId("settlement", "kola_dinner"),
        shortCode: "SEEDSETTLE",
        groupId: lagosTrip,
        fromUserId: kola,
        toUserId: ada,
        amount: "10",
        assetCode: "XLM",
        assetIssuer: null,
        expiresAt: null,
        memo: memoFor("SEEDSETTLE"),
        expenseId: seedId("expense", "dinner"),
        expenseShareId: seedId("share", "dinner_kola"),
        status: "confirmed",
        submittedAt: minutesAgo(90, now),
        confirmedAt: minutesAgo(75, now),
        stellarTxHash: demoTxHash("settlement:kola-dinner"),
        transactionXdr: null,
        retryCount: 0,
        nextAttemptAt: null,
        errorCategory: null,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        failureReason: null,
        failureCategory: null,
        idempotencyKey: null,
      },
      {
        id: seedId("settlement", "zo_dinner"),
        shortCode: "SEEDQUEUE2",
        groupId: lagosTrip,
        fromUserId: zo,
        toUserId: ada,
        amount: "10",
        assetCode: "XLM",
        assetIssuer: null,
        expiresAt: null,
        memo: memoFor("SEEDQUEUE2"),
        expenseId: seedId("expense", "dinner"),
        expenseShareId: seedId("share", "dinner_zo"),
        status: "pending",
        submittedAt: null,
        confirmedAt: null,
        stellarTxHash: null,
        transactionXdr: null,
        retryCount: 0,
        nextAttemptAt: null,
        errorCategory: null,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        failureReason: null,
        failureCategory: null,
        idempotencyKey: null,
      },
      {
        id: seedId("settlement", "ada_wifi"),
        shortCode: "SEEDRETRY2",
        groupId: flat12b,
        fromUserId: ada,
        toUserId: zo,
        amount: "5",
        assetCode: "XLM",
        assetIssuer: null,
        expiresAt: null,
        memo: memoFor("SEEDRETRY2"),
        expenseId: seedId("expense", "wifi"),
        expenseShareId: seedId("share", "wifi_ada"),
        status: "failed",
        submittedAt: minutesAgo(45, now),
        confirmedAt: null,
        stellarTxHash: null,
        transactionXdr: null,
        retryCount: 1,
        nextAttemptAt: null,
        errorCategory: "permanent",
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        failureReason: "Source account could not fund the payment",
        failureCategory: "insufficient_funds",
        idempotencyKey: null,
      },
    ],

    statusHistory: [
      {
        id: seedId("status", "kola_dinner_pending"),
        entityType: "settlement",
        entityId: seedId("settlement", "kola_dinner"),
        status: "pending",
        reason: "Settlement created for the Dinner expense",
        source: "seed",
        createdAt: minutesAgo(90, now),
      },
      {
        id: seedId("status", "kola_dinner_confirmed"),
        entityType: "settlement",
        entityId: seedId("settlement", "kola_dinner"),
        status: "confirmed",
        reason: "Payment confirmed on the ledger",
        source: "seed",
        createdAt: minutesAgo(75, now),
      },
      {
        id: seedId("status", "zo_dinner_pending"),
        entityType: "settlement",
        entityId: seedId("settlement", "zo_dinner"),
        status: "pending",
        reason: "Settlement created for the Dinner expense",
        source: "seed",
        createdAt: minutesAgo(10, now),
      },
      {
        id: seedId("status", "ada_wifi_pending"),
        entityType: "settlement",
        entityId: seedId("settlement", "ada_wifi"),
        status: "pending",
        reason: "Settlement created for the Wi-Fi subscription expense",
        source: "seed",
        createdAt: minutesAgo(45, now),
      },
      {
        id: seedId("status", "ada_wifi_failed"),
        entityType: "settlement",
        entityId: seedId("settlement", "ada_wifi"),
        status: "failed",
        reason: "Payment submission failed",
        source: "seed",
        createdAt: minutesAgo(40, now),
      },
    ],

    treasuryTransactions: [
      {
        id: seedId("treasury_tx", "deposit_confirmed"),
        shortCode: "SEEDTREASR",
        groupId: flat12b,
        userId: ada,
        direction: "deposit",
        amount: "100",
        assetCode: "XLM",
        assetIssuer: null,
        destination: refs.treasuryPublicKey,
        status: "confirmed",
        memo: memoFor("SEEDTREASR"),
        intendedTxHash: null,
        expiresAt: null,
        stellarTxHash: demoTxHash("treasury:deposit:confirmed"),
      },
      {
        id: seedId("treasury_tx", "deposit_pending"),
        shortCode: "SEEDGRANT2",
        groupId: flat12b,
        userId: tunde,
        direction: "deposit",
        amount: "50",
        assetCode: "XLM",
        assetIssuer: null,
        destination: refs.treasuryPublicKey,
        status: "pending",
        memo: memoFor("SEEDGRANT2"),
        intendedTxHash: null,
        expiresAt: null,
        stellarTxHash: null,
      },
    ],

    invites: [
      {
        id: seedId("invite", "lagos_trip"),
        groupId: lagosTrip,
        code: "SEEDCLUB",
        expiresAt: null,
        createdByUserId: ada,
        maxUses: 10,
        uses: 0,
      },
    ],

    treasuryTxProposals: [
      {
        id: seedId("tx_proposal", "studio_rent"),
        groupId: studioCoop,
        creatorId: ada,
        xdr: collectingXdr,
        description: "January studio rent, awaiting a second signature",
        txHash: collectingHash,
        sourceAccount: refs.multisigTreasuryPublicKey,
        requiredWeight: 2,
        status: "PENDING_SIGNATURES",
        stellarTxHash: null,
        failureReason: null,
      },
      {
        id: seedId("tx_proposal", "gear_lease"),
        groupId: studioCoop,
        creatorId: kola,
        xdr: submittedXdr,
        description: "Camera gear lease, co-signed and submitted",
        txHash: submittedHash,
        sourceAccount: refs.multisigTreasuryPublicKey,
        requiredWeight: 2,
        status: "SUBMITTED",
        stellarTxHash: demoTxHash("treasury:proposal:gear-lease"),
        failureReason: null,
      },
    ],

    treasurySignatures: [
      {
        id: seedId("signature", "studio_rent_ada"),
        proposalId: seedId("tx_proposal", "studio_rent"),
        signerUserId: ada,
        signerPublicKey: keypairs.ada.publicKey(),
        signature: adaSignature,
        weight: 1,
        createdAt: minutesAgo(60, now),
      },
      {
        id: seedId("signature", "gear_lease_kola"),
        proposalId: seedId("tx_proposal", "gear_lease"),
        signerUserId: kola,
        signerPublicKey: keypairs.kola.publicKey(),
        signature: kolaSignature,
        weight: 1,
        createdAt: minutesAgo(200, now),
      },
      {
        id: seedId("signature", "gear_lease_zo"),
        proposalId: seedId("tx_proposal", "gear_lease"),
        signerUserId: zo,
        signerPublicKey: keypairs.zo.publicKey(),
        signature: zoSignature,
        weight: 1,
        createdAt: minutesAgo(190, now),
      },
    ],

    treasuryProposals: [
      {
        id: seedId("proposal", "utilities"),
        groupId: studioCoop,
        creatorId: ada,
        xdr: serverBuiltXdr,
        txHash: serverBuiltHash,
        threshold: 2,
        signatures: [{ publicKey: keypairs.zo.publicKey(), signature: zoApproval }],
        status: "PENDING",
        stellarTxHash: null,
        failureReason: null,
      },
    ],

    treasuryApprovals: [
      {
        id: seedId("approval", "utilities_zo"),
        proposalId: seedId("proposal", "utilities"),
        userId: zo,
        txHash: serverBuiltHash,
        signature: zoApproval,
        signedAt: minutesAgo(30, now),
      },
    ],
  };
}

/**
 * Write `dataset` with upserts, converging on it regardless of prior state.
 *
 * Every row is written through its natural unique key, and the `update` branch
 * carries every non-key field, so a re-run neither duplicates a row nor leaves
 * an earlier one on stale demo values. Nothing here reads the database: the
 * seed's contract is "after this, the tables look like `dataset`", and a run
 * that started from a conditional read would converge only as often as the read
 * happened to agree.
 *
 * @param db - A `PrismaClient`, or the transaction client of an interactive
 *   transaction (so a caller can roll the write back after asserting on it).
 * @param dataset - Built by `buildDataset`; defaults to a fresh, clock-based one.
 */
export async function runSeed(
  db: SeedClient,
  dataset: SeedDataset = buildDataset()
): Promise<void> {
  for (const row of dataset.users) {
    const { id, ...fields } = row;
    // Keyed by id, not by `stellarPublicKey`: every foreign key in `dataset`
    // already names these ids, so writing a row to some other primary key would
    // strand the children. A demo wallet that was registered under a
    // non-seed id fails loudly on the unique index instead of quietly having
    // the demo dataset re-pointed at it.
    await db.user.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.groups) {
    const { id, ...fields } = row;
    await db.group.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.groupMembers) {
    await db.groupMember.upsert({
      where: { groupId_userId: { groupId: row.groupId, userId: row.userId } },
      update: { role: row.role },
      create: row,
    });
  }
  for (const row of dataset.expenses) {
    const { id, ...fields } = row;
    await db.expense.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.expenseShares) {
    const { id, ...fields } = row;
    await db.expenseShare.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.settlements) {
    const { id, ...fields } = row;
    await db.settlement.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.statusHistory) {
    const { id, ...fields } = row;
    await db.statusHistory.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.treasuryTransactions) {
    const { id, ...fields } = row;
    await db.treasuryTransaction.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.invites) {
    const { id, ...fields } = row;
    await db.invite.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.treasuryTxProposals) {
    const { id, ...fields } = row;
    await db.treasuryTxProposal.upsert({ where: { id }, update: fields, create: row });
  }
  for (const row of dataset.treasurySignatures) {
    const { id, proposalId, signerUserId, ...fields } = row;
    await db.treasurySignature.upsert({
      where: { proposalId_signerUserId: { proposalId, signerUserId } },
      update: fields,
      create: row,
    });
  }
  for (const row of dataset.treasuryProposals) {
    const { id, signatures, ...fields } = row;
    await db.treasuryProposal.upsert({
      where: { id },
      // `signatures` is a JSON column, so the demo value is written verbatim
      // rather than merged — a stale array must not survive a re-seed.
      update: { ...fields, signatures: signatures as unknown as Prisma.InputJsonValue },
      create: {
        ...row,
        signatures: row.signatures as unknown as Prisma.InputJsonValue,
      },
    });
  }
  for (const row of dataset.treasuryApprovals) {
    const { id, proposalId, userId, ...fields } = row;
    await db.treasuryApproval.upsert({
      where: { proposalId_userId: { proposalId, userId } },
      update: fields,
      create: row,
    });
  }
}
