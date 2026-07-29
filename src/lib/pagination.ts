import { z } from "zod";

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}_${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const parts = decoded.split("_");
    if (parts.length !== 2) return null;
    const timestamp = Number(parts[0]);
    if (Number.isNaN(timestamp)) return null;
    return { createdAt: new Date(timestamp), id: parts[1] };
  } catch {
    return null;
  }
}
