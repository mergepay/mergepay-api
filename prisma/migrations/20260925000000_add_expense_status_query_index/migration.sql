-- AddIndex
CREATE INDEX "expense_shares_status_expense_id_idx" ON "expense_shares"("status", "expense_id");