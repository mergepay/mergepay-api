import { describe, expect, it } from "vitest";
import { booleanQuerySchema, composeWhere, dateRangeWhere } from "../src/schemas/common";
import { groupListQuerySchema, groupMemberListQuerySchema } from "../src/schemas/groups";
import {
  anchorSessionListQuerySchema,
  sep24TransactionsQuerySchema,
} from "../src/validations/sep24";
import {
  treasuryHistoryQuerySchema,
  treasuryProposalListQuerySchema,
} from "../src/validations/treasury";
import {
  deliveryFilters,
  deliveryListQuerySchema,
  webhookFilters,
  webhookListQuerySchema,
} from "../src/services/webhook-listing";

describe("shared list filter primitives", () => {
  it("parses query booleans without coercing the string false to true", () => {
    expect(booleanQuerySchema.parse("false")).toBe(false);
    expect(booleanQuerySchema.parse("true")).toBe(true);
    expect(booleanQuerySchema.safeParse("1").success).toBe(false);
  });

  it("builds inclusive date bounds only when a bound was supplied", () => {
    expect(dateRangeWhere({})).toBeUndefined();
    expect(
      dateRangeWhere({
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      })
    ).toEqual({
      gte: new Date("2026-01-01T00:00:00.000Z"),
      lte: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("flattens compatible filters into the cursor where clause", () => {
    expect(
      composeWhere(
        [{ userId: "user_1" }, { status: "confirmed" }],
        { OR: [{ createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") } }] }
      )
    ).toEqual({
      userId: "user_1",
      status: "confirmed",
      OR: [{ createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") } }],
    });
  });

  it("merges nested filters that share a relation key", () => {
    const cursor = { OR: [{ createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") } }] };
    expect(
      composeWhere(
        [{ group: { archived: false } }, { group: { treasuryEnabled: true } }],
        cursor
      )
    ).toEqual({
      group: { archived: false, treasuryEnabled: true },
      OR: cursor.OR,
    });
  });
});

describe("group list filter schemas", () => {
  it("accepts membership and group filters with the shared pagination keys", () => {
    expect(
      groupListQuerySchema.parse({
        role: "admin",
        archived: "false",
        treasuryEnabled: "true",
        createdByUserId: "user_1",
        limit: "25",
      })
    ).toMatchObject({
      role: "admin",
      archived: false,
      treasuryEnabled: true,
      createdByUserId: "user_1",
      limit: 25,
    });
  });

  it("accepts member filters and rejects unknown keys", () => {
    expect(
      groupMemberListQuerySchema.parse({
        role: "admin",
        userId: "user_1",
        search: "alice",
      })
    ).toMatchObject({ role: "admin", userId: "user_1", search: "alice" });
    expect(groupMemberListQuerySchema.safeParse({ nope: "1" }).success).toBe(false);
  });
});

describe("anchor and treasury list filter schemas", () => {
  it("accepts stored-session filters on the authenticated anchor session list", () => {
    expect(
      anchorSessionListQuerySchema.parse({
        kind: "withdrawal",
        status: "completed",
        assetCode: "USDC",
        startDate: "2026-01-01T00:00:00.000Z",
      })
    ).toMatchObject({ kind: "withdrawal", status: "completed", assetCode: "USDC" });
  });

  it("rejects an unknown anchor status instead of returning an empty list", () => {
    expect(anchorSessionListQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  it("accepts the SEP-24 asset_code and additive status/date filters", () => {
    expect(
      sep24TransactionsQuerySchema.parse({
        asset_code: "USDC",
        status: "completed",
        endDate: "2026-01-02T00:00:00.000Z",
      })
    ).toMatchObject({ asset_code: "USDC", status: "completed" });
  });

  it("accepts treasury history filters", () => {
    expect(
      treasuryHistoryQuerySchema.parse({
        direction: "withdrawal",
        status: "confirmed",
        assetCode: "XLM",
        userId: "user_1",
      })
    ).toMatchObject({
      direction: "withdrawal",
      status: "confirmed",
      assetCode: "XLM",
      userId: "user_1",
    });
  });

  it("rejects an unsupported treasury history direction", () => {
    expect(treasuryHistoryQuerySchema.safeParse({ direction: "mint" }).success).toBe(false);
  });

  it("accepts treasury proposal filters", () => {
    expect(
      treasuryProposalListQuerySchema.parse({
        status: "awaiting_signatures",
        creatorId: "user_1",
      })
    ).toMatchObject({ status: "awaiting_signatures", creatorId: "user_1" });
  });
});

describe("webhook list filters", () => {
  it("accepts endpoint enabled and event filters", () => {
    expect(
      webhookListQuerySchema.parse({
        enabled: "false",
        event: "expense.created",
      })
    ).toMatchObject({ enabled: false, event: "expense.created" });
  });

  it("accepts delivery date bounds", () => {
    expect(
      deliveryListQuerySchema.parse({
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      })
    ).toMatchObject({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-02T00:00:00.000Z",
    });
  });

  it("builds webhook and delivery filter conditions", () => {
    expect(webhookFilters("group_1", { enabled: true, event: "expense.created" })).toEqual([
      { groupId: "group_1" },
      { enabled: true },
      { events: { has: "expense.created" } },
    ]);
    expect(
      deliveryFilters("hook_1", {
        status: "failed",
        event: "settlement.failed",
        startDate: "2026-01-01T00:00:00.000Z",
      })
    ).toEqual([
      { webhookId: "hook_1" },
      { status: "failed" },
      { eventType: "settlement.failed" },
      { createdAt: { gte: new Date("2026-01-01T00:00:00.000Z") } },
    ]);
  });
});
