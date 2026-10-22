/**
 * The seed's idempotency claim, replayed against real Postgres.
 *
 * Issue #670. `tests/seed-dataset.test.ts` proves the demo dataset is
 * internally consistent; it cannot prove that *writing* it twice is safe,
 * because "safe to re-run" is a property of unique constraints and foreign
 * keys, and those only exist in a database. A mock cannot fail an insert that a
 * real index would refuse — which is exactly how a seed that aborts on its
 * second run stays undetected until someone reruns it on a Friday afternoon.
 *
 * So this file runs `runSeed` inside an interactive transaction that it always
 * rolls back, which gives it three things at once:
 *
 *  - real `UNIQUE` indexes and real FK checks are exercised (the harness
 *    provisions the actual schema),
 *  - the shared integration database is left exactly as `globalSetup` emptied
 *    it, so the other files in this suite see no seed rows and no
 *    order-dependence is introduced, and
 *  - "the second run changes nothing" is checkable as a state comparison
 *    inside one transaction, instead of inferred from the absence of an error.
 *
 * What is asserted, in order: a first run writes every row and a second run
 * leaves one copy of each; a seed-owned row a developer has edited is restored
 * to its canonical demo values rather than skipped; rows the seed does not own
 * survive untouched (so re-seeding a database with real data in it is not
 * destructive); and the multisig envelopes and base64 signatures round-trip
 * through `TEXT` and `JSON` columns intact, still verifying.
 */
import { describe, expect, it } from "vitest";
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../src/db";
import {
  DEMO_NETWORK_PASSPHRASE,
  buildDataset,
  demoKeypair,
  runSeed,
} from "../../prisma/seed-data";

/** Fixed clock: two `buildDataset` calls must describe the same demo rows. */
const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");
const dataset = buildDataset(FIXED_NOW);

/** Thrown at the end of every transaction below to force the rollback. */
const ROLLBACK = "seed-multisig: rollback";

type Tx = Prisma.TransactionClient;

/**
 * Run `work` in a transaction, then roll it back.
 *
 * Assertion failures propagate (Prisma re-throws whatever the callback threw,
 * after rolling back), so a failing expect still leaves the database clean for
 * the next test.
 */
async function withRollback(work: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await work(tx);
        throw new Error(ROLLBACK);
      },
      // ~50 upserts per run, several runs per test, and CI Postgres is slower
      // than the local instance; the default 5s is a timeout this file would
      // hit for reasons unrelated to what it is testing.
      { timeout: 25_000, maxWait: 10_000 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === ROLLBACK) return;
    throw error;
  }
}

/** Count rows this dataset names, by the primary key it wrote them under. */
async function countByIds(tx: Tx, model: keyof Tx, ids: string[]): Promise<number> {
  const delegate = (tx as unknown as Record<string, { count: (args: unknown) => Promise<number> }>)[
    model
  ];
  return delegate.count({ where: { id: { in: ids } } });
}

/** The columns that make a re-run "one copy", per table, by natural key. */
async function assertOneCopyOfEveryRow(tx: Tx): Promise<void> {
  const perNaturalKey: Array<[string, () => Promise<number>, number]> = [
    [
      "user.stellarPublicKey",
      () =>
        tx.user.count({
          where: { stellarPublicKey: { in: dataset.users.map((row) => row.stellarPublicKey) } },
        }),
      dataset.users.length,
    ],
    [
      "settlement.shortCode",
      () =>
        tx.settlement.count({
          where: { shortCode: { in: dataset.settlements.map((row) => row.shortCode) } },
        }),
      dataset.settlements.length,
    ],
    [
      "treasuryTransaction.shortCode",
      () =>
        tx.treasuryTransaction.count({
          where: { shortCode: { in: dataset.treasuryTransactions.map((row) => row.shortCode) } },
        }),
      dataset.treasuryTransactions.length,
    ],
    [
      "invite.code",
      () => tx.invite.count({ where: { code: { in: dataset.invites.map((row) => row.code) } } }),
      dataset.invites.length,
    ],
    [
      "groupMember.(groupId,userId)",
      () =>
        tx.groupMember.count({
          where: {
            OR: dataset.groupMembers.map((row) => ({ groupId: row.groupId, userId: row.userId })),
          },
        }),
      dataset.groupMembers.length,
    ],
    [
      "treasurySignature.(proposalId,signerUserId)",
      () =>
        tx.treasurySignature.count({
          where: {
            OR: dataset.treasurySignatures.map((row) => ({
              proposalId: row.proposalId,
              signerUserId: row.signerUserId,
            })),
          },
        }),
      dataset.treasurySignatures.length,
    ],
    [
      "treasuryApproval.(proposalId,userId)",
      () =>
        tx.treasuryApproval.count({
          where: {
            OR: dataset.treasuryApprovals.map((row) => ({
              proposalId: row.proposalId,
              userId: row.userId,
            })),
          },
        }),
      dataset.treasuryApprovals.length,
    ],
  ];

  for (const [label, count, expected] of perNaturalKey) {
    expect(await count(), `${label}: a re-run left more than one copy`).toBe(expected);
  }

  const perId: Array<[keyof Tx, string[]]> = [
    ["group", dataset.groups.map((row) => row.id)],
    ["expense", dataset.expenses.map((row) => row.id)],
    ["expenseShare", dataset.expenseShares.map((row) => row.id)],
    ["settlement", dataset.settlements.map((row) => row.id)],
    ["statusHistory", dataset.statusHistory.map((row) => row.id)],
    ["treasuryTransaction", dataset.treasuryTransactions.map((row) => row.id)],
    ["invite", dataset.invites.map((row) => row.id)],
    ["treasuryTxProposal", dataset.treasuryTxProposals.map((row) => row.id)],
    ["treasurySignature", dataset.treasurySignatures.map((row) => row.id)],
    ["treasuryProposal", dataset.treasuryProposals.map((row) => row.id)],
    ["treasuryApproval", dataset.treasuryApprovals.map((row) => row.id)],
  ];
  for (const [model, ids] of perId) {
    expect(await countByIds(tx, model, ids), `${model}: rows missing after a re-run`).toBe(
      ids.length
    );
  }
}

describe("seed: replaying it against Postgres converges on one copy of every row", () => {
  it("writes everything once, in dependency order, and adds nothing on the second run", async () => {
    await withRollback(async (tx) => {
      // A first run from an empty database is also the FK-ordering proof: a
      // child written before its parent aborts the transaction here.
      await runSeed(tx, dataset);
      await assertOneCopyOfEveryRow(tx);

      // Second run with a freshly built dataset (its own `new Date()`): the
      // demo rows are keyed by fixed ids and deterministic keys, so the clock
      // difference must not create a second copy of anything.
      await runSeed(tx, buildDataset());
      await assertOneCopyOfEveryRow(tx);

      // And the rows still carry the demo values the dataset describes, not
      // whatever the second run's timestamps happened to produce for identity.
      const studio = await tx.group.findUnique({ where: { id: "seed_group_studio_coop" } });
      expect(studio).not.toBeNull();
      expect(studio!.name).toBe("Studio Co-op");
      expect(studio!.treasuryRequiredSigners).toBe(2);
      expect(studio!.treasuryAccountPublicKey).toBe(
        demoKeypair("treasury:studio_coop").publicKey()
      );
      const proposal = await tx.treasuryTxProposal.findFirst({
        where: { groupId: "seed_group_studio_coop", status: "PENDING_SIGNATURES" },
      });
      expect(proposal!.requiredWeight).toBe(2);
      expect(proposal!.sourceAccount).toBe(studio!.treasuryAccountPublicKey);
    });
  });

  it("restores a seed-owned row a developer edited instead of skipping it", async () => {
    await withRollback(async (tx) => {
      await runSeed(tx, dataset);

      // Simulate the realistic case: someone used the demo data, so rows the
      // seed owns now hold other values. An upsert that only fills missing
      // columns would leave these stale forever.
      await tx.group.update({
        where: { id: "seed_group_studio_coop" },
        data: { name: "Renamed by a developer", archived: true },
      });
      await tx.expenseShare.update({
        where: { id: "seed_share_dinner_kola" },
        data: { status: "pending" },
      });
      await tx.treasurySignature.update({
        where: {
          proposalId_signerUserId: {
            proposalId: "seed_tx_proposal_studio_rent",
            signerUserId: "seed_user_ada",
          },
        },
        data: { weight: 99, signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      });

      await runSeed(tx, dataset);

      const group = await tx.group.findUnique({ where: { id: "seed_group_studio_coop" } });
      expect(group!.name).toBe("Studio Co-op");
      expect(group!.archived).toBe(false);
      const share = await tx.expenseShare.findUnique({ where: { id: "seed_share_dinner_kola" } });
      expect(share!.status).toBe("settled");
      const signature = await tx.treasurySignature.findFirst({
        where: { proposalId: "seed_tx_proposal_studio_rent", signerUserId: "seed_user_ada" },
      });
      expect(signature!.weight).toBe(1);
      expect(await countByIds(tx, "treasurySignature", ["seed_signature_studio_rent_ada"])).toBe(1);

      // The restored signature is the real one again, so it verifies.
      const proposal = await tx.treasuryTxProposal.findUnique({
        where: { id: "seed_tx_proposal_studio_rent" },
      });
      const tx1 = TransactionBuilder.fromXDR(
        proposal!.xdr,
        DEMO_NETWORK_PASSPHRASE
      ) as Transaction;
      expect(
        Keypair.fromPublicKey(signature!.signerPublicKey).verify(
          tx1.hash(),
          Buffer.from(signature!.signature, "base64")
        )
      ).toBe(true);
    });
  });

  it("leaves rows it does not own alone", async () => {
    await withRollback(async (tx) => {
      // A developer's own account and group, present before the seed runs.
      const outsider = Keypair.random();
      const user = await tx.user.create({
        data: { stellarPublicKey: outsider.publicKey(), displayName: "Priya" },
      });
      const group = await tx.group.create({
        data: { name: "My real group", description: "not demo data", createdByUserId: user.id },
      });
      await tx.groupMember.create({
        data: { groupId: group.id, userId: user.id, role: "admin" },
      });

      await runSeed(tx, dataset);
      await runSeed(tx, dataset);

      const kept = await tx.group.findUnique({ where: { id: group.id } });
      expect(kept!.name).toBe("My real group");
      expect(kept!.archived).toBe(false);
      expect(
        await tx.groupMember.count({ where: { groupId: group.id } })
      ).toBe(1);
      expect(await tx.user.count({ where: { id: user.id } })).toBe(1);
      // The outsider is not silently enrolled in the demo groups either: the
      // seed writes its own memberships, nobody else's.
      expect(
        await tx.groupMember.count({ where: { userId: user.id, groupId: "seed_group_lagos_trip" } })
      ).toBe(0);
    });
  });

  it("round-trips the multisig envelopes and JSON signatures through Postgres", async () => {
    await withRollback(async (tx) => {
      await runSeed(tx, dataset);

      const proposals = await tx.treasuryTxProposal.findMany({
        where: { id: { in: dataset.treasuryTxProposals.map((row) => row.id) } },
        include: { signatures: true },
      });
      expect(proposals).toHaveLength(dataset.treasuryTxProposals.length);

      for (const stored of proposals) {
        // `xdr` is a TEXT column: a stray newline or a truncation here would
        // break every signature check downstream, so re-derive the hash from
        // what the database gave back.
        const envelope = TransactionBuilder.fromXDR(stored.xdr, DEMO_NETWORK_PASSPHRASE);
        expect(envelope).toBeInstanceOf(Transaction);
        const decoded = envelope as Transaction;
        expect(decoded.hash().toString("hex")).toBe(stored.txHash);
        expect(decoded.signatures).toHaveLength(0);

        expect(stored.signatures).toHaveLength(
          dataset.treasurySignatures.filter((row) => row.proposalId === stored.id).length
        );
        for (const signature of stored.signatures) {
          expect(
            Keypair.fromPublicKey(signature.signerPublicKey).verify(
              decoded.hash(),
              Buffer.from(signature.signature, "base64")
            ),
            `signature ${signature.id} did not survive the write`
          ).toBe(true);
        }
      }

      // The other multisig stack stores its signers in a JSON column, which is
      // where a cast can quietly produce `"[]"` or a stringified array.
      const legacy = await tx.treasuryProposal.findUnique({
        where: { id: dataset.treasuryProposals[0].id },
        include: { approvals: true },
      });
      expect(Array.isArray(legacy!.signatures)).toBe(true);
      expect(legacy!.signatures).toHaveLength(1);
      const [record] = legacy!.signatures as Array<{ publicKey: string; signature: string }>;
      expect(record.publicKey).toBe(demoKeypair("user:zo").publicKey());
      const legacyEnvelope = TransactionBuilder.fromXDR(
        legacy!.xdr,
        DEMO_NETWORK_PASSPHRASE
      ) as Transaction;
      expect(
        Keypair.fromPublicKey(record.publicKey).verify(
          legacyEnvelope.hash(),
          Buffer.from(record.signature, "base64")
        )
      ).toBe(true);
      expect(legacy!.approvals).toHaveLength(1);
      expect(legacy!.approvals[0].signature).toBe(record.signature);
      expect(legacy!.approvals[0].txHash).toBe(legacyEnvelope.hash().toString("hex"));
    });
  });

  it("rolls every run back, so the shared test database stays empty", async () => {
    // Last: this is also the proof that the transactions above cleaned up. If
    // any of them had committed, this suite would leave seed rows behind for
    // every other integration file — a hang-on-CI generator in disguise.
    const byId = [
      ["group", dataset.groups.map((row) => row.id)],
      ["expense", dataset.expenses.map((row) => row.id)],
      ["expenseShare", dataset.expenseShares.map((row) => row.id)],
      ["settlement", dataset.settlements.map((row) => row.id)],
      ["statusHistory", dataset.statusHistory.map((row) => row.id)],
      ["treasuryTransaction", dataset.treasuryTransactions.map((row) => row.id)],
      ["invite", dataset.invites.map((row) => row.id)],
      ["treasuryTxProposal", dataset.treasuryTxProposals.map((row) => row.id)],
      ["treasurySignature", dataset.treasurySignatures.map((row) => row.id)],
      ["treasuryProposal", dataset.treasuryProposals.map((row) => row.id)],
      ["treasuryApproval", dataset.treasuryApprovals.map((row) => row.id)],
    ] as const;
    for (const [model, ids] of byId) {
      expect(await countByIds(prisma, model, ids), `${model}: a rolled-back run left rows behind`).toBe(
        0
      );
    }
    expect(
      await prisma.user.count({
        where: { stellarPublicKey: { in: dataset.users.map((row) => row.stellarPublicKey) } },
      })
    ).toBe(0);
  });
});
