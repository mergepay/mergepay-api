/**
 * Issue #1183 — strict Zod validation for group expense creation, currency
 * denomination, and member split allocations.
 *
 * The schemas and route wiring already exist in src/validations/expense.ts and
 * src/routes/expenses.ts; this suite locks the acceptance criteria at both
 * layers:
 *
 *  - schema: negative amounts, unsupported assets, duplicate participants,
 *    missing/zero percentages, and custom sums that do not add up are refused
 *    before the settlement engine sees them;
 *  - HTTP: a malformed expense payload is a 400 VALIDATION_ERROR carrying
 *    per-field details, not a 500 or a persisted obligation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  idempotencyFindUnique: vi.fn(),
  idempotencyCreate: vi.fn(),
  idempotencyUpdate: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: {
    group: { findUnique: h.groupFindUnique },
    groupMember: { findUnique: h.memberFindUnique },
    idempotencyKey: {
      findUnique: h.idempotencyFindUnique,
      create: h.idempotencyCreate,
      update: h.idempotencyUpdate,
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg({}) : Promise.all(arg)
    ),
  },
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { createExpenseSchema } from "../src/validations/expense";

const validBase = {
  title: "Dinner",
  amount: "30",
  assetCode: "XLM",
  splitType: "equal" as const,
  shares: [{ userId: "user_1" }],
};

describe("issue #1183 — schema-level split validation", () => {
  it("accepts a well-formed equal split", () => {
    expect(createExpenseSchema.safeParse(validBase).success).toBe(true);
  });

  it("rejects a negative total amount", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      amount: "-10",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero and sub-stroop amounts", () => {
    for (const amount of ["0", "0.00000001"]) {
      expect(createExpenseSchema.safeParse({ ...validBase, amount }).success).toBe(
        false
      );
    }
  });

  it("rejects an unsupported currency code", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      assetCode: "BTC",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("assetCode"))).toBe(
        true
      );
    }
  });

  it("rejects USDC with an issuer that does not match the configured one", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      assetCode: "USDC",
      // A well-formed but unconfigured issuer: the code alone is supported,
      // this pair is not.
      assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("assetIssuer"))).toBe(
        true
      );
    }
  });

  it("rejects a negative custom share even when the sum happens to match", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      amount: "10",
      splitType: "custom",
      shares: [
        { userId: "user_1", amount: "20" },
        { userId: "user_2", amount: "-10" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a custom split whose shares do not sum to the total", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      amount: "30",
      splitType: "custom",
      shares: [
        { userId: "user_1", amount: "20" },
        { userId: "user_2", amount: "5" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("sum"))).toBe(true);
    }
  });

  it("rejects a participant appearing more than once", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      shares: [{ userId: "user_1" }, { userId: "user_1" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes("only once"))
      ).toBe(true);
    }
  });

  it("rejects a percentage split with a share that states no percent", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      splitType: "percentage",
      shares: [
        { userId: "user_1", percent: 100 },
        { userId: "user_2" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path.includes("percent") && i.message.includes("Missing percent")
        )
      ).toBe(true);
    }
  });

  it("rejects a percentage split with a zero-percent participant", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      splitType: "percentage",
      shares: [
        { userId: "user_1", percent: 100 },
        { userId: "user_2", percent: 0 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path.includes("percent") && i.message.includes("greater than zero")
        )
      ).toBe(true);
    }
  });

  it("accepts a percentage split where every participant has a positive share", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      splitType: "percentage",
      shares: [
        { userId: "user_1", percent: 60 },
        { userId: "user_2", percent: 40 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("issue #1183 — malformed expense payloads return 400", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.groupFindUnique.mockResolvedValue({
      id: "g1",
      currency: "USD",
      status: "active",
    });
    h.memberFindUnique.mockResolvedValue({
      groupId: "g1",
      userId: "u1",
      role: "member",
    });
    h.idempotencyFindUnique.mockResolvedValue(null);
    h.idempotencyCreate.mockResolvedValue({});
    app = await buildApp();
  });

  const token = () =>
    signToken({
      id: "u1",
      stellarPublicKey:
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    } as any);

  async function createExpense(payload: unknown, key: string) {
    return app.inject({
      method: "POST",
      url: "/groups/g1/expenses",
      headers: {
        authorization: `Bearer ${token()}`,
        "x-idempotency-key": key,
      },
      payload: payload as any,
    });
  }

  const malformed: Array<[string, Record<string, unknown>]> = [
    [
      "negative amount",
      {
        title: "Dinner",
        amount: "-5",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: "u1" }],
      },
    ],
    [
      "custom shares that do not sum to the total",
      {
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: "u1", amount: "20" },
          { userId: "u2", amount: "5" },
        ],
      },
    ],
    [
      "percentage shares that do not sum to 100",
      {
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        splitType: "percentage",
        shares: [
          { userId: "u1", percent: 60 },
          { userId: "u2", percent: 30 },
        ],
      },
    ],
    [
      "a duplicate participant",
      {
        title: "Dinner",
        amount: "30",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: "u1" }, { userId: "u1" }],
      },
    ],
    [
      "an unsupported currency",
      {
        title: "Dinner",
        amount: "30",
        assetCode: "BTC",
        splitType: "equal",
        shares: [{ userId: "u1" }],
      },
    ],
  ];

  it.each(malformed)("rejects %s with a 400 validation envelope", async (_label, payload) => {
    const res = await createExpense(payload, `expense-1183-${_label}`);

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });
});
