/**
 * Unit tests for group member role and removal schemas — Issue #1145.
 *
 * Verifies that the Zod schemas used by the group member role-update route
 * (`PATCH /groups/:id/members/:memberId`) and the removal route
 * (`DELETE /groups/:id/members/:memberId`) accept valid payloads, reject
 * invalid ones, and enforce strict mode (no unknown keys silently dropped).
 */
import { describe, it, expect } from "vitest";
import {
  memberRoleSchema,
  changeMemberRoleSchema,
  groupMemberParamsSchema,
  groupParamsSchema,
} from "../groups";

// ---------------------------------------------------------------------------
// memberRoleSchema — body of PATCH /groups/:id/members/:memberId
// ---------------------------------------------------------------------------

describe("memberRoleSchema — valid role assignments", () => {
  it("accepts role=admin", () => {
    const result = memberRoleSchema.safeParse({ role: "admin" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("admin");
  });

  it("accepts role=member", () => {
    const result = memberRoleSchema.safeParse({ role: "member" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("member");
  });
});

describe("memberRoleSchema — invalid inputs", () => {
  it("rejects an unrecognised role string", () => {
    const result = memberRoleSchema.safeParse({ role: "owner" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("role"))).toBe(true);
    }
  });

  it("rejects an empty role string", () => {
    const result = memberRoleSchema.safeParse({ role: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing role field", () => {
    const result = memberRoleSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = memberRoleSchema.safeParse({ role: "admin", extra: true });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// changeMemberRoleSchema — body of POST /groups/:id/members/role
// ---------------------------------------------------------------------------

describe("changeMemberRoleSchema — valid payloads", () => {
  it("accepts a valid userId and role=admin", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "usr_abc123",
      role: "admin",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.userId).toBe("usr_abc123");
      expect(result.data.role).toBe("admin");
    }
  });

  it("accepts a valid userId and role=member", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "usr_xyz789",
      role: "member",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a userId at the maximum length (64 chars)", () => {
    const userId = "a".repeat(64);
    const result = changeMemberRoleSchema.safeParse({ userId, role: "member" });
    expect(result.success).toBe(true);
  });
});

describe("changeMemberRoleSchema — invalid inputs", () => {
  it("rejects a missing userId", () => {
    const result = changeMemberRoleSchema.safeParse({ role: "admin" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("userId"))).toBe(true);
    }
  });

  it("rejects a missing role", () => {
    const result = changeMemberRoleSchema.safeParse({ userId: "usr_abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognised role", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "usr_abc",
      role: "superadmin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a userId that is too long (over 64 chars)", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "a".repeat(65),
      role: "member",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a userId with illegal characters (spaces)", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "usr abc",
      role: "member",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = changeMemberRoleSchema.safeParse({
      userId: "usr_abc",
      role: "admin",
      extraField: "unexpected",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupMemberParamsSchema — path params { id, memberId }
// ---------------------------------------------------------------------------

describe("groupMemberParamsSchema — valid route parameters", () => {
  it("accepts valid id and memberId", () => {
    const result = groupMemberParamsSchema.safeParse({
      id: "group_abc123",
      memberId: "usr_xyz789",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("group_abc123");
      expect(result.data.memberId).toBe("usr_xyz789");
    }
  });

  it("accepts ids with hyphens and underscores", () => {
    const result = groupMemberParamsSchema.safeParse({
      id: "grp-01_ABC",
      memberId: "usr-99_XYZ",
    });
    expect(result.success).toBe(true);
  });

  it("accepts ids at the maximum length (64 chars)", () => {
    const result = groupMemberParamsSchema.safeParse({
      id: "a".repeat(64),
      memberId: "b".repeat(64),
    });
    expect(result.success).toBe(true);
  });
});

describe("groupMemberParamsSchema — invalid route parameters", () => {
  it("rejects a missing id", () => {
    const result = groupMemberParamsSchema.safeParse({ memberId: "usr_abc" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing memberId", () => {
    const result = groupMemberParamsSchema.safeParse({ id: "grp_abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an id that is too long (over 64 chars)", () => {
    const result = groupMemberParamsSchema.safeParse({
      id: "a".repeat(65),
      memberId: "usr_abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an id with invalid characters (spaces)", () => {
    const result = groupMemberParamsSchema.safeParse({
      id: "grp abc",
      memberId: "usr_abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty id string", () => {
    const result = groupMemberParamsSchema.safeParse({ id: "", memberId: "usr_abc" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty memberId string", () => {
    const result = groupMemberParamsSchema.safeParse({ id: "grp_abc", memberId: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupParamsSchema — path params { id } used for group-level routes
// ---------------------------------------------------------------------------

describe("groupParamsSchema — valid and invalid id", () => {
  it("accepts a valid group id", () => {
    const result = groupParamsSchema.safeParse({ id: "cld123abc" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty id", () => {
    const result = groupParamsSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized id (over 64 chars)", () => {
    const result = groupParamsSchema.safeParse({ id: "x".repeat(65) });
    expect(result.success).toBe(false);
  });

  it("rejects an id with invalid characters (slash)", () => {
    const result = groupParamsSchema.safeParse({ id: "grp/abc" });
    expect(result.success).toBe(false);
  });
});
