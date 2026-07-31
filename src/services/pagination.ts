import { z } from "zod";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  assetCode: z.string().optional(),
  status: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface CursorParams {
  createdAt: Date;
  id: string;
}

export function encodeCursor(params: CursorParams): string {
  const data = JSON.stringify({
    createdAt: params.createdAt.getTime(),
    id: params.id,
  });
  return Buffer.from(data).toString("base64");
}

export function decodeCursor(cursor: string): CursorParams {
  try {
    const data = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    return {
      createdAt: new Date(data.createdAt),
      id: data.id,
    };
  } catch {
    throw new Error("Invalid cursor");
  }
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildPaginatedResponse<T extends { createdAt: Date; id: string }>(
  items: T[],
  limit: number
): PaginatedResponse<T> {
  let nextCursor: string | null = null;

  if (items.length > limit) {
    const lastItem = items[limit - 1];
    nextCursor = encodeCursor({
      createdAt: lastItem.createdAt,
      id: lastItem.id,
    });
    items = items.slice(0, limit);
  }

  return {
    items,
    nextCursor,
  };
}
