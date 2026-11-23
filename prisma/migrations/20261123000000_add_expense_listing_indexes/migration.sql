CREATE INDEX "expenses_group_id_asset_code_created_at_id_idx" ON "expenses"("group_id", "asset_code", "created_at", "id");
CREATE INDEX "expense_shares_expense_id_status_idx" ON "expense_shares"("expense_id", "status");
