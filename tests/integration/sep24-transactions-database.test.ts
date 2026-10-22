/**
 * Issue #655 — `GET /api/sep24/transactions` run against a real Postgres.
 *
 * `tests/sep24-transactions-list.test.ts` covers this route with a mocked
 * `src/db`, which is the right shape for asserting the response contract but
 * cannot answer the questions a database raises:
 *
 *   - does the keyset cursor really page a caller's transactions without
 *     repeating or dropping a row — including the two rows that share one
 *     `created_at`, where only the `(created_at, id)` tie-break decides?
 *   - does `kind=deposit` really match the row whose stored kind is neither of
 *     the two directions, the way `toSep24Kind` renders it?
 *   - do the timeline rows read back per transaction actually belong to that
 *     transaction once Postgres, not the mock, is deciding the ordering?
 *   - does the endpoint still answer a valid `?limit=2`? A documented query
 *     string schema with `type: "integer"` would 400 it, because ajv runs with
 *     coercion off (src/app.ts) and a query string carries strings.
 *
 * Real Prisma client, real Fastify instance, real HTTP path; nothing on the
 * database path is stubbed. `src/services/anchor` is replaced with spies — not
 * to make the route faster but to prove it never reaches the anchor, which
 * CONTRIBUTING requires anyway (no network) and this endpoint promises in its
 * own comment.
 *
 * The limiter is switched off for this file (`rateLimit: "off"`, #658): the
 * budgets key on the authenticated user, so paging through a list in a loop is
 * throttled by the suite's own volume rather than by anything under test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";

const anchor = vi.hoisted(() => ({
  getToml: vi.fn(),
  getChallenge: vi.fn(),
  getToken: vi.fn(),
  startInteractive: vi.fn(),
}));

vi.mock("../../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/anchor")>();
  return {
    ...actual,
    anchorService: { ...(actual as any).anchorService, ...anchor },
  };
});

import { buildApp } from "../../src/app";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";

interface Actor {
  id: string;
  publicKey: string;
  token: string;
}

let app: FastifyInstance;
let alice: Actor;
/** A second caller, whose transactions must never appear in Alice's page. */
let bob: Actor;

/** Session ids seeded for Alice, newest first as the route must return them. */
let aliceIds: string[] = [];
/** Named rows, so tests refer to a row by its role rather than by position. */
const seed: Record<string, string> = {};
/**
 * The two rows sharing one `created_at`, in the order the `(created_at, id)`
 * tie-break puts them. They land at indices 2 and 3 of `aliceIds`, so a page
 * of three ends exactly between them.
 */
let tiedFirst = "";
let tiedSecond = "";

async function createActor(displayName: string): Promise<Actor> {
  const keypair = Keypair.random();
  const user = await prisma.user.create({
    data: { stellarPublicKey: keypair.publicKey(), displayName },
    select: { id: true, stellarPublicKey: true },
  });
  return { id: user.id, publicKey: user.stellarPublicKey, token: signToken({ id: user.id, stellarPublicKey: keypair.publicKey() }) };
}

function call(url: string, actor: Actor | null) {
  return app.inject({
    method: "GET",
    url,
    headers: actor ? { authorization: `Bearer ${actor.token}` } : {},
  });
}

const list = (query = "", actor: Actor | null = alice) =>
  call(`/api/sep24/transactions${query ? `?${query}` : ""}`, actor);

/**
 * A session row written directly, so a test can state the stored data rather
 * than reproduce the interactive flow that would produce it. `createdAt` is
 * given explicitly because the whole point of the cursor tests is a known
 * ordering.
 */
async function seedSession(
  userId: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  const row = await prisma.anchorSession.create({
    data: {
      userId,
      anchorName: "Integration Anchor",
      kind: "deposit",
      assetCode: "USDC",
      status: "pending_user_transfer_start",
      ...over,
    },
    select: { id: true },
  });
  return row.id;
}

async function seedHistory(
  entityId: string,
  rows: { status: string; at: Date; reason?: string; source?: string }[]
) {
  for (const row of rows) {
    await prisma.statusHistory.create({
      data: {
        entityType: "anchor_session",
        entityId,
        status: row.status,
        reason: row.reason ?? null,
        source: row.source ?? "worker",
        createdAt: row.at,
      },
    });
  }
}

/** Timestamps chosen before seeding, so tests can name the same instants. */
const T0 = new Date("2026-03-01T10:00:00.000Z");
const T1 = new Date("2026-03-02T10:00:00.000Z");
const T2 = new Date("2026-03-03T10:00:00.000Z");
const T3 = new Date("2026-03-04T10:00:00.000Z");
/**
 * A distinct instant for the second transition. Chosen deliberately: two
 * `status_history` rows sharing one `created_at` render in whichever order
 * Postgres returns them, because the view sorts by `createdAt` alone and the
 * table has no insertion-order column. That is a pre-existing gap in
 * `toSep24TransactionView` (reported in this issue's PR), not a property this
 * file should encode as expected behaviour.
 */
const T31 = new Date("2026-03-04T10:00:01.000Z");
const T4 = new Date("2026-03-05T10:00:00.000Z");

const TIMELINED = "it-655-timelined";

beforeAll(async () => {
  app = await buildApp({ rateLimit: "off" });
  alice = await createActor("SEP-24 list owner");
  bob = await createActor("SEP-24 list bystander");

  // Five deposits and two withdrawals, one of the deposits carrying a `kind`
  // the API would never write, so the filter's agreement with the view is
  // tested against data rather than against the API's own best case.
  seed.plain = await seedSession(alice.id, { externalTransactionId: "ext-655-plain", createdAt: T0, updatedAt: T0 });
  seed.corrupt = await seedSession(alice.id, { kind: "depositt", createdAt: T1, updatedAt: T1 });
  seed.tiedA = await seedSession(alice.id, { createdAt: T2, updatedAt: T2 });
  seed.tiedB = await seedSession(alice.id, { createdAt: T2, updatedAt: T2 });
  seed.timed = await seedSession(alice.id, { externalTransactionId: TIMELINED, status: "completed", createdAt: T3, updatedAt: T3 });
  seed.withdrawalNew = await seedSession(alice.id, { kind: "withdrawal", createdAt: T4, updatedAt: T4 });
  seed.withdrawalOld = await seedSession(alice.id, { kind: "withdrawal", createdAt: T1, updatedAt: T1 });
  seed.bobsDeposit = await seedSession(bob.id, { createdAt: T4, updatedAt: T4 });
  seed.bobsWithdrawal = await seedSession(bob.id, { kind: "withdrawal", createdAt: T3, updatedAt: T3 });

  await seedHistory(seed.timed, [
    { status: "incomplete", at: T3, reason: "Session created", source: "user" },
    { status: "pending_user_transfer_start", at: T31, reason: "Send your deposit", source: "user" },
    { status: "completed", at: T4, reason: "Deposited", source: "webhook" },
  ]);

  // The order the route promises, read back from the database rather than
  // assumed from the order the rows were written in.
  const rows = await prisma.anchorSession.findMany({
    where: { userId: alice.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
  aliceIds = rows.map((r) => r.id);
  const tied = rows.filter((r) => r.createdAt.getTime() === T2.getTime()).map((r) => r.id);
  expect(tied).toHaveLength(2);
  [tiedFirst, tiedSecond] = tied;

  // The page boundary the tie test below relies on: a page of three ends on
  // the first tied row, so the next page has to begin on the second.
  expect(aliceIds.slice(0, 3)).toEqual([seed.withdrawalNew, seed.timed, tiedFirst]);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("GET /api/sep24/transactions against a real database", () => {
  it("returns exactly the caller's transactions, newest first", async () => {
    const res = await list();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ hasMore: false, nextCursor: null, limit: 50 });
    expect(body.transactions.map((t: any) => t.session_id)).toEqual(aliceIds);
    expect(body.transactions).toHaveLength(7);
    // Bob's two sessions are not in there, and the route never asked for them.
    expect(body.transactions.some((t: any) => t.session_id.startsWith("bob"))).toBe(false);
  });

  it("never reaches the anchor while answering the poll", async () => {
    await list();
    await list("limit=2");
    await list("kind=withdrawal");

    expect(anchor.getToml).not.toHaveBeenCalled();
    expect(anchor.getChallenge).not.toHaveBeenCalled();
    expect(anchor.getToken).not.toHaveBeenCalled();
    expect(anchor.startInteractive).not.toHaveBeenCalled();
  });

  it("pages to the end without repeating or losing a transaction", async () => {
    // Three pages of three from seven rows: a mocked client cannot show that
    // Postgres applies the row-value comparison the cursor encodes, which is
    // the property that makes a page boundary stable while rows are written.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    for (; pages < 10; pages += 1) {
      const res = await list(cursor ? `limit=3&cursor=${cursor}` : "limit=3");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.transactions.length).toBeGreaterThan(0);
      seen.push(...body.transactions.map((t: any) => t.session_id));
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }

    expect(pages).toBe(2); // 3 + 3 + 1 rows: two cursors, then a final page
    expect(seen).toEqual(aliceIds);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("breaks a created_at tie by id so neither row is skipped or doubled", async () => {
    // A page of three ends on the first of the two rows sharing `T2`, so the
    // cursor it hands back encodes a `(created_at, id)` pair and the next page
    // has to begin on the other row. Under `ORDER BY created_at` alone this is
    // where a transaction disappears from a user's list.
    const page1 = (await list("limit=3")).json();
    expect(page1.transactions.map((t: any) => t.session_id)).toEqual([
      seed.withdrawalNew,
      seed.timed,
      tiedFirst,
    ]);

    const page2 = (await list(`limit=3&cursor=${page1.meta.nextCursor}`)).json();
    const ids = page2.transactions.map((t: any) => t.session_id);
    expect(ids[0]).toBe(tiedSecond);
    expect([...page1.transactions.map((t: any) => t.session_id), ...ids]).toEqual(aliceIds.slice(0, 6));
  });

  it("answers a valid ?limit=2 with a page, not a 400", async () => {
    // The regression guard: a `querystring` JSON schema documenting `limit` as
    // `type: "integer"` rejects the string `"2"` a query string actually
    // carries, because ajv does not coerce here by design.
    const res = await list("limit=2");

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(2);
    expect(res.json().meta.limit).toBe(2);
  });

  it("filters by kind against stored values, including a kind the API would not write", async () => {
    const deposits = (await list("kind=deposit")).json();
    const withdrawals = (await list("kind=withdrawal")).json();

    expect(withdrawals.transactions).toHaveLength(2);
    expect(withdrawals.transactions.map((t: any) => t.kind)).toEqual(["withdrawal", "withdrawal"]);

    // Five rows are not withdrawals, and the view renders each of them as a
    // deposit — including the one whose stored kind is `depositt`, which a
    // literal `kind = 'deposit'` filter would have dropped.
    expect(deposits.transactions).toHaveLength(5);
    expect(deposits.transactions.map((t: any) => t.session_id)).toContain(seed.corrupt);
    expect(deposits.transactions.every((t: any) => t.kind === "deposit")).toBe(true);
    expect(withdrawals.transactions.map((t: any) => t.session_id)).toEqual(
      expect.arrayContaining([seed.withdrawalNew, seed.withdrawalOld])
    );
    expect(deposits.meta.hasMore).toBe(false);
  });

  it("reads each transaction's own timeline back from status_history", async () => {
    const res = await list("kind=deposit");
    expect(res.statusCode).toBe(200);

    const listed = res.json().transactions.find((t: any) => t.id === TIMELINED);
    expect(listed.status).toBe("completed");
    expect(listed.status_history.map((h: any) => h.status)).toEqual([
      "incomplete",
      "pending_user_transfer_start",
      "completed",
    ]);
    // A transaction with no history rows says so with an empty timeline; the
    // route read them and found none, which is a different claim from not
    // looking.
    const other = res.json().transactions.find((t: any) => t.id !== TIMELINED);
    expect(other.status_history).toEqual([]);
  });

  it("stamps completed_at from the transition into the terminal status", async () => {
    const listed = (await list("kind=deposit"))
      .json()
      .transactions.find((t: any) => t.id === TIMELINED);

    // Read out of the timestamp column, not the value the test wrote, so a
    // precision or timezone surprise in the round trip is the test's problem
    // to catch.
    const row = await prisma.statusHistory.findFirstOrThrow({
      where: { entityType: "anchor_session", status: "completed" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    expect(listed.completed_at).toBe(row.createdAt.toISOString());
    expect(listed.message).toBe("Deposited");
  });

  it("lists exactly what the single-transaction poll answers for the same id", async () => {
    const res = await list("kind=deposit");
    const listed = res.json().transactions.find((t: any) => t.id === TIMELINED);

    const polled = await call(`/api/sep24/transaction?id=${TIMELINED}`, alice);
    expect(polled.statusCode).toBe(200);
    expect(listed).toEqual(polled.json());
  });

  it("rejects an unauthenticated poll and leaks nothing", async () => {
    const res = await list("", null);

    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty("transactions");
  });

  it("keeps a borrowed cursor inside the caller who replayed it", async () => {
    const asAlice = await list("limit=1", alice);
    const cursor = asAlice.json().meta.nextCursor;
    expect(cursor).toBeTruthy();

    // Bob replays Alice's cursor. A cursor carries only ordering coordinates,
    // so this can only change where Bob's own page starts.
    const asBob = await list(`limit=1&cursor=${cursor}`, bob);
    expect(asBob.statusCode).toBe(200);
    const bobIds = asBob.json().transactions.map((t: any) => t.session_id);
    expect(bobIds).toHaveLength(1);

    const owned = await prisma.anchorSession.findMany({
      where: { id: { in: bobIds } },
      select: { userId: true },
    });
    expect(owned.map((r) => r.userId)).toEqual([bob.id]);
  });

  it.each([
    ["kind=nope", "VALIDATION_ERROR", "an unknown direction is not silently an empty list"],
    ["page=2", "VALIDATION_ERROR", "offset paging is not implemented"],
    ["limit=0", "VALIDATION_ERROR", "an empty page is not a page"],
    ["limit=101", "VALIDATION_ERROR", "the ceiling is not a suggestion"],
    ["cursor=not-a-cursor", "INVALID_CURSOR", "a broken cursor restarts nothing"],
  ])("400s on %s — %s", async (query, code) => {
    const res = await list(query);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(code);
  });

  it("orders ascending when asked, oldest first", async () => {
    const res = await list("order=asc");
    expect(res.statusCode).toBe(200);

    const body = res.json();
    const times = body.transactions.map(
      (t: any) => Date.parse(t.started_at)
    );
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(body.meta.order).toBe("asc");
  });
});
