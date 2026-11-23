import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("Expense listing composite indexes", () => {
  const schemaPath = path.join(__dirname, "../../prisma/schema.prisma");
  const migrationPath = path.join(
    __dirname,
    "../../prisma/migrations/20261123000000_add_expense_listing_indexes/migration.sql"
  );

  it("declares Expense(group_id, asset_code, created_at, id) in Prisma schema", () => {
    const schema = fs.readFileSync(schemaPath, "utf8");
    expect(schema).toContain("@@index([groupId, assetCode, createdAt, id])");
  });

  it("declares ExpenseShare(expenseId, status) in Prisma schema", () => {
    const schema = fs.readFileSync(schemaPath, "utf8");
    expect(schema).toContain("@@index([expenseId, status])");
  });

  it("creates the matching migration indexes", () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toContain(
      'CREATE INDEX "expenses_group_id_asset_code_created_at_id_idx" ON "expenses"("group_id", "asset_code", "created_at", "id");'
    );
    expect(sql).toContain(
      'CREATE INDEX "expense_shares_expense_id_status_idx" ON "expense_shares"("expense_id", "status");'
    );
  });
});
