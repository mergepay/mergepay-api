/**
 * The seed dataset checked as data, with no database involved.
 *
 * Issue #670. `prisma/seed.ts` claimed to be idempotent and covered "groups,
 * members, expenses and a treasury", but nothing could show its work: the rows
 * were built and written in the same function, so the only way to learn that a
 * share sum didn't match its expense, or that two rows collided on a unique
 * column, was to run the seed against a live Postgres and read the error — or
 * not, because a broken FK in a column nothing queried stays invisible.
 *
 * `prisma/seed-data.ts` exposes the rows as data, so the properties that make
 * the demo usable are assertable here:
 *
 *  - every foreign key names a row the dataset itself contains,
 *  - no two rows fight over a column the schema declares unique (that is the
 *    precondition of "safe to re-run" — a collision would abort the second run
 *    on a P2002 no upsert can paper over),
 *  - each expense's shares sum to its amount,
 *  - each settlement binds a share of that expense, from its owner to its
 *    payer, for its amount,
 *  - the multisig fixtures are shaped the way the treasury routes require: a
 *    threshold admins can actually reach, envelopes that decode and hash to the
 *    stored `txHash`, payment envelopes sourced from the group's own treasury
 *    account with a window that has not lapsed, and signatures that verify
 *    against the envelope they are recorded for,
 *  - and building the dataset twice with the same clock yields the same bytes.
 *
 * The write half — "run it twice against real Postgres and the tables hold one
 * copy of each row" — needs a database and lives in
 * `tests/integration/seed-multisig.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  FeeBumpTransaction,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  DEMO_NETWORK_PASSPHRASE,
  DEMO_SIGNING_DEADLINE_EPOCH,
  USER_SPECS,
  buildDataset,
  demoKeypair,
  demoTxHash,
  memoFor,
  seedId,
  seedRefs,
} from "../prisma/seed-data";
import { ALPHABET } from "../src/services/codes";
import { assertTreasuryEnvelopePolicy } from "../src/services/treasury-stellar";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const dataset = buildDataset(NOW);
const refs = seedRefs();

/** XLM has 7 decimals; Stellar amounts are compared as integer stroop units. */
const UNITS = 10_000_000n;

/** A decimal amount string as integer units. Throws on a malformed amount. */
function units(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) throw new Error(`not a valid Stellar amount: ${amount}`);
  return BigInt(match[1]) * UNITS + BigInt((match[2] ?? "").padEnd(7, "0"));
}

/** Every code this dataset hands to a user or puts in a memo. */
const CODE_LENGTHS = { invite: 8, short: 10 } as const;

function expectAlphabetCode(value: string, length: number, label: string): void {
  expect(value, `${label} length`).toHaveLength(length);
  for (const char of value) {
    expect(ALPHABET.includes(char), `${label} "${value}" uses "${char}"`).toBe(true);
  }
}

function uniqueIds<T>(rows: ReadonlyArray<T>, label: string): Set<string> {
  const ids = rows.map((row) => (row as { id: string }).id);
  expect(new Set(ids).size, `${label}: duplicate id`).toBe(ids.length);
  for (const id of ids) {
    expect(id.length, `${label} id "${id}" exceeds the 64-char route cap`).toBeLessThanOrEqual(64);
  }
  return new Set(ids);
}

describe("seed dataset: foreign keys resolve inside the dataset", () => {
  const userIds = uniqueIds(dataset.users, "users");
  const groupIds = uniqueIds(dataset.groups, "groups");
  const expenseIds = uniqueIds(dataset.expenses, "expenses");
  const shareIds = uniqueIds(dataset.expenseShares, "expenseShares");
  const settlementIds = uniqueIds(dataset.settlements, "settlements");
  const treasuryTxIds = uniqueIds(dataset.treasuryTransactions, "treasuryTransactions");
  const inviteIds = uniqueIds(dataset.invites, "invites");
  const txProposalIds = uniqueIds(dataset.treasuryTxProposals, "treasuryTxProposals");
  const signatureIds = uniqueIds(dataset.treasurySignatures, "treasurySignatures");
  const proposalIds = uniqueIds(dataset.treasuryProposals, "treasuryProposals");
  const approvalIds = uniqueIds(dataset.treasuryApprovals, "treasuryApprovals");

  it("names a known user wherever the schema has a user foreign key", () => {
    const offenders: string[] = [];
    const check = (table: string, field: string, id: string): void => {
      if (!userIds.has(id)) offenders.push(`${table}.${field} -> ${id}`);
    };
    dataset.groups.forEach((row) => check("groups", "createdByUserId", row.createdByUserId));
    dataset.groupMembers.forEach((row) => check("groupMembers", "userId", row.userId));
    dataset.expenses.forEach((row) => check("expenses", "payerUserId", row.payerUserId));
    dataset.expenseShares.forEach((row) => check("expenseShares", "userId", row.userId));
    dataset.settlements.forEach((row) => {
      check("settlements", "fromUserId", row.fromUserId);
      check("settlements", "toUserId", row.toUserId);
    });
    dataset.treasuryTransactions.forEach((row) => check("treasuryTransactions", "userId", row.userId));
    dataset.invites.forEach((row) => check("invites", "createdByUserId", row.createdByUserId));
    dataset.treasuryTxProposals.forEach((row) => check("treasuryTxProposals", "creatorId", row.creatorId));
    dataset.treasurySignatures.forEach((row) => check("treasurySignatures", "signerUserId", row.signerUserId));
    dataset.treasuryProposals.forEach((row) => check("treasuryProposals", "creatorId", row.creatorId));
    dataset.treasuryApprovals.forEach((row) => check("treasuryApprovals", "userId", row.userId));
    expect(offenders, "unresolved user references").toEqual([]);
  });

  it("names a known group wherever the schema has a group foreign key", () => {
    const offenders: string[] = [];
    const check = (table: string, id: string): void => {
      if (!groupIds.has(id)) offenders.push(`${table} -> ${id}`);
    };
    dataset.groupMembers.forEach((row) => check("groupMembers", row.groupId));
    dataset.expenses.forEach((row) => check("expenses", row.groupId));
    dataset.settlements.forEach((row) => check("settlements", row.groupId));
    dataset.treasuryTransactions.forEach((row) => check("treasuryTransactions", row.groupId));
    dataset.invites.forEach((row) => check("invites", row.groupId));
    dataset.treasuryTxProposals.forEach((row) => check("treasuryTxProposals", row.groupId));
    dataset.treasuryProposals.forEach((row) => check("treasuryProposals", row.groupId));
    expect(offenders, "unresolved group references").toEqual([]);
  });

  it("binds expenses, shares, settlements, proposals and approvals to real parents", () => {
    const offenders: string[] = [];
    const check = (label: string, id: string, parents: Set<string>): void => {
      if (!parents.has(id)) offenders.push(`${label} -> ${id}`);
    };
    dataset.expenseShares.forEach((row) => check("expenseShare.expenseId", row.expenseId, expenseIds));
    dataset.settlements.forEach((row) => {
      check("settlement.expenseId", row.expenseId, expenseIds);
      check("settlement.expenseShareId", row.expenseShareId, shareIds);
    });
    dataset.statusHistory.forEach((row) =>
      check("statusHistory.entityId", row.entityId, settlementIds)
    );
    dataset.treasurySignatures.forEach((row) =>
      check("treasurySignature.proposalId", row.proposalId, txProposalIds)
    );
    dataset.treasuryApprovals.forEach((row) =>
      check("treasuryApproval.proposalId", row.proposalId, proposalIds)
    );
    // Columns the schema types as non-null references, checked for the same
    // reason: an empty string violates the FK the same way an unknown id does.
    const notEmpty = [
      ...dataset.treasuryTransactions.map((row) => [row.id, row.destination] as const),
      ...dataset.treasuryTxProposals.map((row) => [row.id, row.sourceAccount] as const),
      ...dataset.expenses.map((row) => [row.id, row.assetCode] as const),
    ];
    for (const [id, value] of notEmpty) {
      expect(value, `${id} has an empty required column`).not.toBe("");
    }
    expect(offenders, "unresolved parent references").toEqual([]);
    expect(treasuryTxIds.size + inviteIds.size + signatureIds.size + approvalIds.size).toBeGreaterThan(0);
  });

  it("only settles a member of the expense's own group", () => {
    const groupOf = new Map(dataset.groups.map((row) => [row.id, row.name]));
    const members = new Set(
      dataset.groupMembers.map((row) => `${row.groupId}:${row.userId}`)
    );
    const offenders: string[] = [];
    for (const expense of dataset.expenses) {
      if (!members.has(`${expense.groupId}:${expense.payerUserId}`)) {
        offenders.push(`${expense.title}: payer is not a member of ${groupOf.get(expense.groupId)}`);
      }
      for (const share of dataset.expenseShares.filter((s) => s.expenseId === expense.id)) {
        if (!members.has(`${expense.groupId}:${share.userId}`)) {
          offenders.push(`${expense.title}: share owner is not a member`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("seed dataset: money adds up", () => {
  it("splits every expense into shares that sum to its amount", () => {
    for (const expense of dataset.expenses) {
      const shares = dataset.expenseShares.filter((s) => s.expenseId === expense.id);
      expect(shares.length, `${expense.title} has no shares`).toBeGreaterThan(0);
      const sum = shares.reduce((total, s) => total + units(s.shareAmount), 0n);
      expect(sum.toString(), `${expense.title} share sum`).toBe(units(expense.amount).toString());
    }
  });

  it("binds each settlement to the share it pays, with the same amount", () => {
    const shareById = new Map(dataset.expenseShares.map((s) => [s.id, s]));
    const expenseById = new Map(dataset.expenses.map((e) => [e.id, e]));
    for (const settlement of dataset.settlements) {
      const share = shareById.get(settlement.expenseShareId);
      expect(share, `settlement ${settlement.id} has no share`).toBeDefined();
      const expense = expenseById.get(settlement.expenseId);
      expect(expense, `settlement ${settlement.id} has no expense`).toBeDefined();
      expect(share!.expenseId, `${settlement.shortCode} share belongs to another expense`).toBe(
        settlement.expenseId
      );
      expect(settlement.groupId, `${settlement.shortCode} cross-group settlement`).toBe(expense!.groupId);
      expect(settlement.fromUserId, `${settlement.shortCode} is not owed by its debtor`).toBe(share!.userId);
      expect(settlement.toUserId, `${settlement.shortCode} does not pay the payer`).toBe(expense!.payerUserId);
      expect(settlement.amount, `${settlement.shortCode} amount`).toBe(share!.shareAmount);
      expect(settlement.memo, `${settlement.shortCode} memo`).toBe(memoFor(settlement.shortCode));
    }
  });

  it("records a confirmed settlement as a settled share, and only those", () => {
    const byId = new Map(dataset.expenseShares.map((s) => [s.id, s]));
    for (const settlement of dataset.settlements) {
      const share = byId.get(settlement.expenseShareId)!;
      if (settlement.status === "confirmed") {
        expect(share.status, `${settlement.shortCode} confirmed but share not settled`).toBe("settled");
        expect(settlement.confirmedAt, `${settlement.shortCode} confirmed without a timestamp`).not.toBeNull();
        expect(settlement.stellarTxHash).not.toBeNull();
      } else {
        expect(["pending", "settling", "failed"], `${settlement.shortCode} share status`).toContain(share.status);
      }
    }
    // Every settlement state the demo is meant to advertise is present, so a
    // regression that dropped one scenario would fail here rather than silently
    // shrinking the demo.
    const statuses = new Set(dataset.settlements.map((s) => s.status));
    expect([...statuses].sort()).toEqual(["confirmed", "failed", "pending"]);
  });

  it("keeps each settlement on its own share so the pair unique key cannot collide", () => {
    const shareIds = dataset.settlements.map((s) => s.expenseShareId);
    expect(new Set(shareIds).size).toBe(shareIds.length);
  });
});

describe("seed dataset: codes, memos and identities", () => {
  it("uses the short-code alphabet for every user-visible code", () => {
    const seen = new Set<string>();
    for (const settlement of dataset.settlements) {
      expectAlphabetCode(settlement.shortCode, CODE_LENGTHS.short, "settlement shortCode");
      seen.add(settlement.shortCode);
    }
    for (const treasury of dataset.treasuryTransactions) {
      expectAlphabetCode(treasury.shortCode, CODE_LENGTHS.short, "treasury shortCode");
      seen.add(treasury.shortCode);
    }
    expect(new Set(seen).size, "duplicate short code across tables").toBe(seen.size);
    for (const invite of dataset.invites) {
      expectAlphabetCode(invite.code, CODE_LENGTHS.invite, "invite code");
    }
    // A short code is unique across settlements *and* treasury transactions
    // because both are resolved from a memo by the same lookup.
    for (const row of [...dataset.settlements, ...dataset.treasuryTransactions]) {
      expect(row.memo, "memo does not carry the row's own code").toBe(memoFor(row.shortCode));
    }
  });

  it("derives identity from deterministic demo keypairs and matching public keys", () => {
    expect(dataset.users.map((u) => u.displayName)).toEqual(USER_SPECS.map((s) => s.displayName));
    const keys = new Set<string>();
    for (const user of dataset.users) {
      expect(StrKey.isValidEd25519PublicKey(user.stellarPublicKey)).toBe(true);
      keys.add(user.stellarPublicKey);
      const slug = USER_SPECS.find((s) => s.displayName === user.displayName)!.slug;
      expect(user.stellarPublicKey).toBe(demoKeypair(`user:${slug}`).publicKey());
      expect(user.id).toBe(seedId("user", slug));
    }
    expect(keys.size).toBe(dataset.users.length);
  });

  it("keeps seedRefs() in step with the rows it prints", () => {
    // `prisma/seed.ts` writes `dataset` but prints `seedRefs()` as the accounts
    // a developer should sign in with. If the two disagreed, the seed would
    // hand out a public key that has no row in the database.
    for (const spec of USER_SPECS) {
      const user = dataset.users.find((row) => row.id === refs.userIds[spec.slug]);
      expect(user, `seedRefs has no dataset row for ${spec.slug}`).toBeDefined();
      expect(user!.stellarPublicKey).toBe(refs.keypairs[spec.slug].publicKey());
    }
    expect(
      dataset.groups.some((group) => group.treasuryAccountPublicKey === refs.treasuryPublicKey)
    ).toBe(true);
    expect(
      dataset.groups.some((group) => group.treasuryAccountPublicKey === refs.multisigTreasuryPublicKey)
    ).toBe(true);
  });

  it("keeps the 64-character id cap the routes enforce", () => {
    expect(seedId("group", "lagos_trip")).toBe("seed_group_lagos_trip");
    expect(() => seedId("kind", "x".repeat(64))).toThrow(/64-character/);
  });

  it("produces tx hashes that are shaped like ledger hashes and unique", () => {
    const hashes = [
      ...dataset.settlements.map((s) => s.stellarTxHash),
      ...dataset.treasuryTransactions.map((t) => t.stellarTxHash),
      ...dataset.treasuryTxProposals.map((p) => p.stellarTxHash),
    ].filter((hash): hash is string => hash !== null);
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(demoTxHash("a")).not.toBe(demoTxHash("b"));
  });
});

describe("seed dataset: treasury multisig is usable by the API that reads it", () => {
  const studio = dataset.groups.find((group) => group.treasuryRequiredSigners === 2)!;

  it("gives the multisig group at least as many admins as its threshold", () => {
    expect(studio, "no 2-of-3 treasury group in the demo data").toBeDefined();
    expect(studio.treasuryEnabled).toBe(true);
    const admins = dataset.groupMembers.filter(
      (member) => member.groupId === studio.id && member.role === "admin"
    );
    // A threshold no admin set can reach means PENDING_SIGNATURES forever:
    // signatures may only come from admins (src/services/treasury-signatures.ts).
    expect(admins.length).toBeGreaterThanOrEqual(studio.treasuryRequiredSigners!);
  });

  it("records proposals against that group's own treasury account", () => {
    for (const proposal of dataset.treasuryTxProposals) {
      expect(proposal.groupId).toBe(studio.id);
      expect(proposal.sourceAccount).toBe(studio.treasuryAccountPublicKey);
      expect(proposal.requiredWeight).toBe(studio.treasuryRequiredSigners);
      const recorded = dataset.treasurySignatures.filter((s) => s.proposalId === proposal.id);
      const weight = recorded.reduce((total, s) => total + s.weight, 0);
      if (proposal.status === "PENDING_SIGNATURES") {
        expect(weight).toBeLessThan(proposal.requiredWeight);
      } else {
        expect(weight).toBeGreaterThanOrEqual(proposal.requiredWeight);
      }
      // A creator must be able to sign their own proposal.
      expect(
        dataset.groupMembers.some(
          (m) => m.groupId === proposal.groupId && m.userId === proposal.creatorId && m.role === "admin"
        ),
        `proposal ${proposal.id} created by a non-admin`
      ).toBe(true);
    }
  });

  it("stores unsigned payment envelopes that decode and hash to the recorded txHash", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const proposal of [...dataset.treasuryTxProposals, ...dataset.treasuryProposals]) {
      const parsed = TransactionBuilder.fromXDR(proposal.xdr, DEMO_NETWORK_PASSPHRASE);
      expect(
        parsed,
        `${proposal.id}: xdr is not a transaction envelope`
      ).toBeInstanceOf(Transaction);
      expect(parsed, `${proposal.id}: a fee bump cannot be co-signed`).not.toBeInstanceOf(
        FeeBumpTransaction
      );
      const tx = parsed as Transaction;
      expect(tx.hash().toString("hex"), `${proposal.id}: stored txHash is not the envelope's`).toBe(
        proposal.txHash
      );
      // The envelope must be the treasury's own spend, on the network the demo
      // data claims, and unsigned: POST /proposals refuses an envelope that
      // already carries signatures (xdr_not_unsigned, src/services/treasury-signatures.ts:140).
      expect(tx.source).toBe(studio.treasuryAccountPublicKey);
      expect(tx.signatures).toHaveLength(0);
      expect(tx.operations).toHaveLength(1);
      const [operation] = tx.operations as Array<{
        type: string;
        amount?: string;
        destination?: string;
      }>;
      expect(operation.type).toBe("payment");
      expect(Number(operation.amount)).toBeGreaterThan(0);
      expect(
        StrKey.isValidEd25519PublicKey(operation.destination!) ||
          StrKey.isValidMed25519PublicKey(operation.destination!)
      ).toBe(true);
      expect((tx.memo as { type: string }).type).toBe("text");
      expect(String((tx.memo as { value: string }).value).startsWith("MP:")).toBe(true);
      // A window that has already closed makes the row unactionable, and one
      // that is unbounded is not a transaction the API would ever build.
      expect(tx.timeBounds, `${proposal.id}: no time bounds`).not.toBeNull();
      expect(Number(tx.timeBounds!.minTime)).toBeLessThanOrEqual(nowSeconds);
      expect(Number(tx.timeBounds!.maxTime)).toBeGreaterThan(nowSeconds);
      expect(Number(tx.timeBounds!.maxTime)).toBe(DEMO_SIGNING_DEADLINE_EPOCH);
      // And the envelope clears the treasury's own envelope policy
      // (`assertTreasuryEnvelopePolicy`, issue #666): source account, operation
      // shape and fee band. Seed data the API would refuse demos nothing but a
      // broken fixture, and this is the check that a re-cut envelope cannot
      // quietly become one.
      expect(() =>
        assertTreasuryEnvelopePolicy(tx, {
          treasuryAccountPublicKey: studio.treasuryAccountPublicKey!,
        })
      ).not.toThrow();
    }
  });

  it("records signatures that verify against the envelope they are stored for", () => {
    // Same primitive the collector uses: Keypair.fromPublicKey(...).verify(tx.hash(), sig).
    for (const signature of dataset.treasurySignatures) {
      const proposal = dataset.treasuryTxProposals.find((p) => p.id === signature.proposalId)!;
      const signer = dataset.users.find((u) => u.id === signature.signerUserId)!;
      expect(signature.signerPublicKey).toBe(signer.stellarPublicKey);
      const tx = TransactionBuilder.fromXDR(proposal.xdr, DEMO_NETWORK_PASSPHRASE) as Transaction;
      // The recorded hash is the envelope's own, so verifying against it is
      // verifying against what the collector will re-derive from the stored xdr.
      expect(Buffer.from(proposal.txHash, "hex")).toEqual(tx.hash());
      expect(
        Keypair.fromPublicKey(signature.signerPublicKey).verify(
          tx.hash(),
          Buffer.from(signature.signature, "base64")
        ),
        `signature ${signature.id} does not verify`
      ).toBe(true);
      // The same signature over a different envelope must NOT verify, which is
      // what makes the assertion above a check rather than a tautology.
      const other = dataset.treasuryTxProposals.find((p) => p.id !== signature.proposalId)!;
      expect(
        Keypair.fromPublicKey(signature.signerPublicKey).verify(
          Buffer.from(other.txHash, "hex"),
          Buffer.from(signature.signature, "base64")
        )
      ).toBe(false);
    }
  });

  it("keeps the approval JSON in sync with its proposal and its own table", () => {
    for (const proposal of dataset.treasuryProposals) {
      const approvals = dataset.treasuryApprovals.filter((a) => a.proposalId === proposal.id);
      expect(proposal.signatures).toHaveLength(approvals.length);
      for (const approval of approvals) {
        expect(approval.txHash).toBe(proposal.txHash);
        const stored = proposal.signatures.find((s) =>
          s.publicKey ===
          dataset.users.find((u) => u.id === approval.userId)!.stellarPublicKey
        );
        expect(stored, `approval ${approval.id} has no JSON twin`).toBeDefined();
        expect(stored!.signature).toBe(approval.signature);
        expect(
          Keypair.fromPublicKey(stored!.publicKey).verify(
            Buffer.from(proposal.txHash, "hex"),
            Buffer.from(stored!.signature, "base64")
          )
        ).toBe(true);
      }
    }
  });
});

describe("seed dataset: determinism", () => {
  it("rebuilds byte-identically for the same clock", () => {
    expect(buildDataset(NOW)).toEqual(dataset);
  });

  it("keeps ids, envelopes and signatures independent of the clock", () => {
    const later = buildDataset(new Date(NOW.getTime() + 3_600_000));
    const keysOf = (rows: Array<Record<string, unknown>>, fields: string[]) =>
      rows.map((row) => fields.map((field) => String(row[field])).join("|")).sort();

    expect(keysOf(later.users as Array<Record<string, unknown>>, ["id", "stellarPublicKey"])).toEqual(
      keysOf(dataset.users as Array<Record<string, unknown>>, ["id", "stellarPublicKey"])
    );
    expect(later.treasuryTxProposals.map((p) => `${p.xdr}:${p.txHash}`)).toEqual(
      dataset.treasuryTxProposals.map((p) => `${p.xdr}:${p.txHash}`)
    );
    expect(later.treasurySignatures.map((s) => s.signature)).toEqual(
      dataset.treasurySignatures.map((s) => s.signature)
    );
    // Only demo timestamps move with `now` — which is why the envelopes can be
    // signed once and stay valid: their deadline is a fixed epoch, not now + N.
    expect(later.settlements.map((s) => s.id)).toEqual(dataset.settlements.map((s) => s.id));
    expect(later.statusHistory.map((s) => s.createdAt.getTime())).not.toEqual(
      dataset.statusHistory.map((s) => s.createdAt.getTime())
    );
  });
});
