/**
 * Idempotent demo seed for local development.
 *
 * `npm run db:seed` converges on the same dataset every time. The rows
 * themselves live in `prisma/seed-data.ts`, which is deliberately
 * database-free so the dataset can be inspected without a Postgres
 * (`tests/seed-dataset.test.ts`) and so the idempotency claim can be replayed
 * against real unique constraints (`tests/integration/seed-multisig.test.ts`).
 * This file is only the entry point: build the dataset, write it, then print
 * what a developer can now sign in as.
 *
 * The data covers the group-expense settlement scenarios (settled, confirmed,
 * pending and retryably-failed shares), a treasury-enabled group with deposits,
 * an invite code, and a 2-of-3 multisig treasury whose proposals carry real
 * ed25519 signatures over real transaction envelopes.
 *
 * ⚠️ Demo credentials only. Keypairs are derived from public labels
 * (`mergepay:demo:…`), so anyone can recompute these secret keys. Never fund
 * them with anything of value and never reuse them outside a disposable
 * local/testnet database.
 */

import { PrismaClient } from "@prisma/client";
import {
  USER_SPECS,
  buildDataset,
  demoKeypair,
  runSeed,
  seedRefs,
} from "./seed-data";

const prisma = new PrismaClient();

function describeGroups(
  groups: Array<{ id: string; name: string; treasuryEnabled: boolean; treasuryRequiredSigners: number | null }>,
  counts: (groupId: string) => { members: number; admins: number }
): string {
  return groups
    .map((group) => {
      const { members, admins } = counts(group.id);
      // The threshold is a count of *admin* signatures — only admins may sign a
      // treasury proposal — so it reads as "2-of-3 admins", not "2 of the 3
      // members".
      const treasury = group.treasuryEnabled
        ? `, treasury enabled, ${group.treasuryRequiredSigners}-of-${admins} admins`
        : "";
      return `${group.name} (${members} members${treasury})`;
    })
    .join(", ");
}

async function main(): Promise<void> {
  const dataset = buildDataset();
  await runSeed(prisma, dataset);

  const refs = seedRefs();
  const counts = (groupId: string): { members: number; admins: number } => {
    const members = dataset.groupMembers.filter((member) => member.groupId === groupId);
    return {
      members: members.length,
      admins: members.filter((member) => member.role === "admin").length,
    };
  };
  const displayName = (userId: string): string =>
    dataset.users.find((user) => user.id === userId)?.displayName ?? userId;

  const studioCoop = dataset.groups.find((group) => group.name === "Studio Co-op");
  const collecting = dataset.treasuryTxProposals.find(
    (proposal) => proposal.status === "PENDING_SIGNATURES"
  );
  const legacy = dataset.treasuryProposals[0];

  console.log("Seeded demo data (idempotent — safe to re-run):");
  console.log(`  groups:   ${describeGroups(dataset.groups, counts)}`);
  console.log(
    `  expenses: ${dataset.expenses.map((expense) => expense.title).join(", ")}`
  );
  console.log(
    "  settlements: confirmed, pending and failed examples with status history"
  );
  console.log(
    `  treasury: confirmed + pending deposits; invite code ${dataset.invites[0].code} (Lagos Trip)`
  );
  console.log(
    `  multisig: ${dataset.treasuryTxProposals.map((proposal) => `${proposal.description} [${proposal.status}]`).join(", ")}`
  );
  console.log(
    `            ${dataset.treasurySignatures.length} recorded signatures across ` +
      `${dataset.treasuryTxProposals.length} proposals; ` +
      `plus a legacy-stack proposal needing ${legacy.threshold} approvals`
  );
  console.log("");
  console.log("Demo accounts (deterministic testnet keys — never send real funds):");
  for (const spec of USER_SPECS) {
    console.log(`  ${spec.displayName}: ${refs.keypairs[spec.slug].publicKey()}`);
  }
  console.log(`  treasury (Flat 12B): ${refs.treasuryPublicKey}`);
  console.log(`  multisig treasury (${studioCoop?.name}): ${refs.multisigTreasuryPublicKey}`);

  if (collecting) {
    const signed = dataset.treasurySignatures.filter(
      (signature) => signature.proposalId === collecting.id
    );
    // Only a group admin may contribute a treasury signature
    // (src/services/treasury-signatures.ts), so the eligible co-signers are the
    // proposal group's admins who have not signed yet.
    const unsigned = dataset.groupMembers
      .filter(
        (member) =>
          member.groupId === collecting.groupId &&
          member.role === "admin" &&
          !signed.some((signature) => signature.signerUserId === member.userId)
      )
      .map((member) => displayName(member.userId));
    console.log("");
    console.log(
      `One signature is still missing on "${collecting.description}" ` +
        `(${collecting.id}): it needs weight ${collecting.requiredWeight}, has ${signed.length}` +
        `${signed.length > 0 ? ` (${signed.map((s) => displayName(s.signerUserId)).join(", ")})` : ""}.`
    );
    // The path the co-signature collector is mounted at (src/routes/treasury-multisig.ts:99).
    console.log(
      `  finish it with POST /treasury/${collecting.id}/sign — any of ${unsigned.join(", ")} can co-sign`
    );
  }

  if (process.env.SEED_PRINT_SECRETS === "1") {
    console.log("");
    console.log(
      "Demo secret seeds (testnet only — derive them any time with SEED_PRINT_SECRETS=1):"
    );
    for (const spec of USER_SPECS) {
      console.log(`  ${spec.displayName}: ${refs.keypairs[spec.slug].secret()}`);
    }
    console.log(`  treasury: ${demoKeypair("treasury:flat_12b").secret()}`);
    console.log(`  multisig treasury: ${demoKeypair("treasury:studio_coop").secret()}`);
  } else {
    console.log("");
    console.log(
      "Run SEED_PRINT_SECRETS=1 npm run db:seed to print their demo secret seeds."
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
