import { prisma } from "../db";

export async function log(
  action: string,
  userId?: string | null,
  groupId?: string | null,
  details?: Record<string, unknown> | null
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId: userId ?? null,
        groupId: groupId ?? null,
        details: details ? (details as any) : undefined,
      },
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export const auditLog = {
  log,
};
