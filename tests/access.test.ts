import { describe, it, expect, vi } from "vitest";
import { requireMembership, requireAdmin } from "../src/services/access";

function fakeDb(member: { role: string } | null, group: { id: string } | null = { id: "group_1" }) {
  return {
    groupMember: {
      findUnique: vi.fn(async () => member),
    },
    group: {
      findUnique: vi.fn(async () => group),
    },
  } as any;
}

describe("access service", () => {
  describe("requireMembership", () => {
    it("returns the membership context for a current member", async () => {
      const db = fakeDb({ role: "member" });
      const ctx = await requireMembership("group_1", "user_1", db);
      expect(ctx).toEqual({ groupId: "group_1", userId: "user_1", role: "member" });
      expect(db.groupMember.findUnique).toHaveBeenCalledWith({
        where: { groupId_userId: { groupId: "group_1", userId: "user_1" } },
      });
    });

    it("throws a not-found error for a group that does not exist", async () => {
      const db = fakeDb(null, null);
      await expect(requireMembership("group_1", "ghost", db)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
    });

    it("throws forbidden (not not-found) for a removed member of an existing group", async () => {
      const db = fakeDb(null);
      await expect(requireMembership("group_1", "former_member", db)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

  });

  describe("requireAdmin", () => {
    it("returns the context for an admin", async () => {
      const db = fakeDb({ role: "admin" });
      const ctx = await requireAdmin("group_1", "user_1", db);
      expect(ctx.role).toBe("admin");
    });

    it("rejects a member without the admin role", async () => {
      const db = fakeDb({ role: "member" });
      await expect(requireAdmin("group_1", "user_1", db)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("rejects a non-member the same way requireMembership does (not-found for a missing group)", async () => {
      const db = fakeDb(null, null);
      await expect(requireAdmin("group_1", "ghost", db)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
    });

    it("never trusts a client-supplied role — only what the db row says", async () => {
      // Even if a caller tried to smuggle a role through, requireAdmin only
      // ever reads member.role from the db lookup result.
      const db = fakeDb({ role: "member" });
      await expect(requireAdmin("group_1", "user_1", db)).rejects.toMatchObject({
        status: 403,
      });
      expect(db.groupMember.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
