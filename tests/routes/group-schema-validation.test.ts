/**
 * Issue #707 — comprehensive schema validation on the group surface.
 *
 * Group payloads used to be validated by loose inline shapes: a group id was
 * `z.string()` with no bound, the legacy invite body accepted any numeric
 * `maxUses`, and unknown keys were silently stripped. `src/schemas/groups.ts`
 * replaces that with a strict contract, and this suite pins both halves of
 * it:
 *
 *   1. schema-level — each strict schema rejects the malformed shapes it
 *      exists to stop (whitespace-only names, oversized fields, unknown keys,
 *      non-ed25519 Stellar keys, out-of-range invite bounds, unknown roles);
 *   2. route-level — via the real buildApp() + app.inject(), every invalid
 *      payload surfaces as 400 VALIDATION_ERROR, and the new
 *      `PATCH /groups/:id` route trims/updates through the same schema.
 *
 * Route-level requests drive a mocked Prisma, like every suite under
 * tests/routes/, so no database or network is needed and the suite is
 * deterministic. Authorization mocks (admin membership) are arranged up
 * front because the guards run *before* body validation — an invalid payload
 * must still be a 400 for an authorized caller.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "row_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    accountBalance: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  const mockFetchBaseFee = vi.fn(async () => 100);
  return { prisma, mockFetchBaseFee };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: h.mockFetchBaseFee,
        feeStats: h.mockFetchBaseFee,
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import {
  createGroupSchema,
  updateGroupSchema,
  directInviteSchema,
  legacyInviteSchema,
  joinGroupSchema,
  memberRoleSchema,
  changeMemberRoleSchema,
  groupMemberParamsSchema,
} from "../../src/schemas/groups";
import {
  validateCreateGroupPayload,
  validateUpdateGroupPayload,
} from "../../src/services/groups";


const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_1";
const ADMIN_ID = "user_admin";
const INVITEE_ID = "user_invitee";

/** A pool of stable Stellar public keys, one per named user. */
const keys = new Map<string, string>();
function keyOf(userId: string): string {
  if (!keys.has(userId)) keys.set(userId, Keypair.random().publicKey());
  return keys.get(userId)!;
}

function authHeader(userId = ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({
      id: userId,
      stellarPublicKey: keyOf(userId),
    })}`,
  };
}

const GROUP_ROW = {
  id: GROUP_ID,
  name: "Trip",
  description: null,
  createdByUserId: ADMIN_ID,
  treasuryEnabled: false,
  treasuryAccountPublicKey: null,
  treasuryRequiredSigners: null,
  archived: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * Resolve every groupMember.findUnique by (groupId, userId): the caller is a
 * group admin. The guards run before body validation, so every 400 asserted
 * below is a validation outcome for an authorized caller — the schema layer's
 * own verdict, not a side effect of a 401/403.
 */
function arrangeAdmin() {
  prisma.groupMember.findUnique.mockImplementation(async (args: any) => {
    const composite = args?.where?.groupId_userId;
    if (composite?.groupId === GROUP_ID && composite.userId === ADMIN_ID) {
      return { groupId: GROUP_ID, userId: ADMIN_ID, role: "admin" };
    }
    return null;
  });
  prisma.group.findUnique.mockResolvedValue({ ...GROUP_ROW });
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  arrangeAdmin();
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
  prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
    for (const [userId, pk] of keys) {
      if (pk === where.stellarPublicKey) return { id: userId, stellarPublicKey: pk };
    }
    return null;
  });
});

// ---------------------------------------------------------------------------
// 1. Schema-level rejections
// ---------------------------------------------------------------------------

describe("schema: createGroupSchema (#707)", () => {
  it("accepts a valid body and trims the name", () => {
    const parsed = createGroupSchema.parse({
      name: "  Lagos Trip  ",
      description: "Spending for December",
    });
    expect(parsed.name).toBe("Lagos Trip");
  });

  it("rejects a whitespace-only name", () => {
    expect(createGroupSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects a name over 60 characters", () => {
    expect(createGroupSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
  });

  it("rejects a description over 280 characters", () => {
    expect(
      createGroupSchema.safeParse({ name: "Trip", description: "x".repeat(281) }).success
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      createGroupSchema.safeParse({ name: "Trip", treasuryEnabled: true }).success
    ).toBe(false);
  });

  it("accepts valid currency types XLM and USDC", () => {
    expect(createGroupSchema.safeParse({ name: "Trip", currency: "XLM" }).success).toBe(true);
    expect(createGroupSchema.safeParse({ name: "Trip", currency: "USDC" }).success).toBe(true);
    expect(createGroupSchema.safeParse({ name: "Trip", currencyType: "USDC" }).success).toBe(true);
    expect(createGroupSchema.safeParse({ name: "Trip", defaultCurrency: "XLM" }).success).toBe(true);
  });

  it("rejects invalid currency type", () => {
    const res = createGroupSchema.safeParse({ name: "Trip", currency: "EUR" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toContain("Currency must be XLM or USDC");
    }
  });

  it("accepts valid member lists and metadata constraints", () => {
    const res = createGroupSchema.safeParse({
      name: "Trip",
      currency: "USDC",
      members: ["user_1", { userId: "user_2", role: "member" }],
      metadata: { category: "Travel", isPrivate: false },
    });
    expect(res.success).toBe(true);
  });
});

describe("schema: updateGroupSchema (#707)", () => {
  it("accepts a name-only update and a null description", () => {
    expect(updateGroupSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateGroupSchema.safeParse({ description: null }).success).toBe(true);
  });

  it("accepts valid currency update", () => {
    expect(updateGroupSchema.safeParse({ currency: "USDC" }).success).toBe(true);
    expect(updateGroupSchema.safeParse({ currencyType: "XLM" }).success).toBe(true);
  });

  it("rejects invalid currency update", () => {
    expect(updateGroupSchema.safeParse({ currency: "INVALID" }).success).toBe(false);
  });

  it("rejects an empty body — an accepted no-op write is silent data loss", () => {
    expect(updateGroupSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(updateGroupSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects unknown keys — including treasury fields", () => {
    expect(
      updateGroupSchema.safeParse({
        name: "Renamed",
        treasuryAccountPublicKey: keyOf(INVITEE_ID),
      }).success
    ).toBe(false);
  });
});


describe("schema: invitation schemas (#707)", () => {
  it("directInviteSchema rejects a malformed Stellar public key", () => {
    expect(directInviteSchema.safeParse({ publicKey: "not-a-key" }).success).toBe(false);
    // Well-formed prefix but not a valid ed25519 checksum body.
    expect(
      directInviteSchema.safeParse({
        publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }).success
    ).toBe(false);
  });

  it("directInviteSchema rejects unknown keys", () => {
    expect(
      directInviteSchema.safeParse({ publicKey: keyOf(INVITEE_ID), maxUses: 5 }).success
    ).toBe(false);
  });

  it("legacyInviteSchema bounds maxUses to 1..1000 and rejects non-integers", () => {
    expect(legacyInviteSchema.safeParse({ maxUses: 0 }).success).toBe(false);
    expect(legacyInviteSchema.safeParse({ maxUses: 1001 }).success).toBe(false);
    expect(legacyInviteSchema.safeParse({ maxUses: 2.5 }).success).toBe(false);
    expect(legacyInviteSchema.safeParse({ maxUses: 1000 }).success).toBe(true);
  });

  it("legacyInviteSchema bounds expiresInHours to 1..8760", () => {
    expect(legacyInviteSchema.safeParse({ expiresInHours: 0 }).success).toBe(false);
    expect(legacyInviteSchema.safeParse({ expiresInHours: 8761 }).success).toBe(false);
    expect(legacyInviteSchema.safeParse({ expiresInHours: 8760 }).success).toBe(true);
  });

  it("legacyInviteSchema rejects unknown keys — a body with both branches is rejected", () => {
    expect(
      legacyInviteSchema.safeParse({ maxUses: 5, publicKey: keyOf(INVITEE_ID) }).success
    ).toBe(false);
  });
});

describe("schema: join and role schemas (#707)", () => {
  it("joinGroupSchema rejects codes with non-alphanumeric characters", () => {
    expect(joinGroupSchema.safeParse({ code: "SEED CLUB!" }).success).toBe(false);
  });

  it("joinGroupSchema rejects oversized and empty codes", () => {
    expect(joinGroupSchema.safeParse({ code: "A".repeat(33) }).success).toBe(false);
    expect(joinGroupSchema.safeParse({ code: "" }).success).toBe(false);
  });

  it("joinGroupSchema rejects unknown keys", () => {
    expect(joinGroupSchema.safeParse({ code: "SEEDCLUB", groupId: GROUP_ID }).success).toBe(false);
  });

  it("memberRoleSchema rejects roles outside admin|member — no 'owner' alias", () => {
    expect(memberRoleSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(memberRoleSchema.safeParse({ role: "member" }).success).toBe(true);
  });

  it("changeMemberRoleSchema rejects malformed userIds and unknown keys", () => {
    expect(
      changeMemberRoleSchema.safeParse({ userId: "bad;user", role: "admin" }).success
    ).toBe(false);
    expect(
      changeMemberRoleSchema.safeParse({ userId: "u1", role: "member", token: "x" }).success
    ).toBe(false);
  });

  it("groupMemberParamsSchema bounds path parameters", () => {
    expect(
      groupMemberParamsSchema.safeParse({
        id: GROUP_ID,
        memberId: "m".repeat(65),
      }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Route-level 400s and success paths
// ---------------------------------------------------------------------------

describe("POST /groups — validation (#707)", () => {
  it.each([
    ["whitespace-only name", { name: "   " }],
    ["name over 60 characters", { name: "x".repeat(61) }],
    ["description over 280 characters", { name: "Trip", description: "x".repeat(281) }],
    ["unknown key", { name: "Trip", treasuryEnabled: true }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.group.create).not.toHaveBeenCalled();
  });

  it("trims the name and creates the group through the schema", async () => {
    prisma.group.create.mockImplementation(async ({ data }: any) => ({
      ...GROUP_ROW,
      id: "group_new",
      name: data.name,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "  Trip  " },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.group.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Trip" }) })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.create" }),
      })
    );
  });
});

describe("PATCH /groups/:id — validation (#707)", () => {
  it.each([
    ["an empty body", {}],
    ["a whitespace-only name", { name: "   " }],
    ["an unknown key", { name: "New", treasuryAccountPublicKey: "GA" }],
    ["a treasury field smuggled into a metadata update", { treasuryRequiredSigners: 2 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}`,
      headers: authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("updates through the schema as an admin", async () => {
    prisma.group.update.mockResolvedValue({ ...GROUP_ROW, name: "Renamed" });

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}`,
      headers: authHeader(),
      payload: { name: "  Renamed  " },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().group.name).toBe("Renamed");
    expect(prisma.group.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Renamed" } })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.update" }),
      })
    );
  });
});

describe("POST /groups/:id/invite — validation (#707)", () => {
  it.each([
    ["a malformed public key", { publicKey: "not-a-key" }],
    ["both invite branches at once", { publicKey: keyOf(INVITEE_ID), maxUses: 5 }],
    ["maxUses below 1", { maxUses: 0 }],
    ["maxUses above 1000", { maxUses: 1001 }],
    ["expiresInHours of 0", { expiresInHours: 0 }],
    ["expiresInHours above a year", { expiresInHours: 8761 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/invite`,
      headers: authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.invitation.create).not.toHaveBeenCalled();
    expect(prisma.invite.create).not.toHaveBeenCalled();
  });

  it("mints a legacy invite code through the legacy schema", async () => {
    prisma.invite.create.mockResolvedValue({
      id: "invite_1",
      groupId: GROUP_ID,
      code: "SEEDCLUB",
      createdByUserId: ADMIN_ID,
      maxUses: 10,
      expiresAt: null,
      uses: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/invite`,
      headers: authHeader(),
      payload: { maxUses: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.invite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ maxUses: 10 }) })
    );
  });

  it("creates a direct invitation through the direct schema", async () => {
    prisma.invitation.create.mockResolvedValue({
      id: "inv_1",
      groupId: GROUP_ID,
      inviteePublicKey: keyOf(INVITEE_ID),
      status: "PENDING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/invite`,
      headers: authHeader(),
      payload: { publicKey: keyOf(INVITEE_ID) },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().invitation.inviteePublicKey).toBe(keyOf(INVITEE_ID));
  });
});

describe("POST /groups/join — validation (#707)", () => {
  it.each([
    ["a code with special characters", { code: "SEED CLUB!" }],
    ["an oversized code", { code: "A".repeat(33) }],
    ["an unknown key", { code: "SEEDCLUB", groupId: GROUP_ID }],
  ])("rejects %s with 400", async (_label, payload) => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/join",
      headers: authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.invite.findUnique).not.toHaveBeenCalled();
  });
});

describe("role endpoints — validation (#707)", () => {
  it.each([
    ["an unknown role on the role-change route", "/groups/g1/members/role", { userId: "u1", role: "owner" }],
    ["a malformed userId on the role-change route", "/groups/g1/members/role", { userId: "bad;user", role: "admin" }],
    ["an unknown role on the member-patch alias", "/groups/g1/members/u1", { role: "owner" }],
  ])("rejects %s with 400", async (_label, url, payload) => {
    const res = await app.inject({
      method: url.endsWith("/role") ? "POST" : "PATCH",
      url,
      headers: authHeader(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
  });

  it("surfaces an invalid role as a 400 VALIDATION_ERROR envelope with field details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/g1/members/role",
      headers: authHeader(),
      payload: { userId: "u1", role: "owner" },
    });
    const body = res.json();
    expect(res.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    // The offending field is named — either by the Zod error handler (message
    // carries "path: message") or by the Fastify-schema handler (details carry
    // the field) — so a client can tell which part of the payload was wrong.
    const reported = `${body.error.message} ${JSON.stringify(body.error.details ?? "")}`;
    expect(reported).toContain("role");
  });
});

describe("src/services/groups.ts helper functions", () => {
  it("validateCreateGroupPayload validates valid creation payload", () => {
    const data = validateCreateGroupPayload({ name: "  Valid Group  ", currency: "USDC" });
    expect(data.name).toBe("Valid Group");
    expect(data.currency).toBe("USDC");
  });

  it("validateCreateGroupPayload throws 400 Bad Request on invalid payload", () => {
    expect(() => validateCreateGroupPayload({ name: "" })).toThrow(/name is required/);
    expect(() => validateCreateGroupPayload({ name: "Test", currency: "INVALID" })).toThrow(/Currency must be XLM or USDC/);
  });

  it("validateUpdateGroupPayload validates valid update payload", () => {
    const data = validateUpdateGroupPayload({ name: "New Name", currency: "XLM" });
    expect(data.name).toBe("New Name");
    expect(data.currency).toBe("XLM");
  });

  it("validateUpdateGroupPayload throws 400 Bad Request on invalid update payload", () => {
    expect(() => validateUpdateGroupPayload({})).toThrow(/At least one/);
    expect(() => validateUpdateGroupPayload({ currency: "INVALID" })).toThrow(/Currency must be XLM or USDC/);
  });
});



