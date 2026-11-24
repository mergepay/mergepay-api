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
    $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg({}) : Promise.all(arg))),
  },
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

describe("expense create validation details (#1031)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    vi.clearAllMocks();
    h.groupFindUnique.mockResolvedValue({ id: "g1", currency: "USD", status: "active" });
    h.memberFindUnique.mockResolvedValue({ groupId: "g1", userId: "u1", role: "member" });
    h.idempotencyFindUnique.mockResolvedValue(null);
    h.idempotencyCreate.mockResolvedValue({});
    app = await buildApp();
  });

  it("returns machine-readable Zod details for invalid expense payload", async () => {
    const token = signToken({ id: "u1", stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" } as any);
    const res = await app.inject({
      method: "POST",
      url: "/groups/g1/expenses",
      headers: {
        authorization: `Bearer ${token}`,
        "x-idempotency-key": "expense-validation-details",
      },
      payload: { description: "", total: "-1", currency: "usd" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details[0]).toEqual(
      expect.objectContaining({ field: expect.any(String), message: expect.any(String), code: expect.any(String) })
    );
  });
});
