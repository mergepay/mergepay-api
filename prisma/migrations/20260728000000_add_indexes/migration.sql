-- AddIndex
CREATE INDEX "expenses_payer_user_id_idx" ON "expenses"("payer_user_id");

-- AddIndex
CREATE INDEX "group_members_group_id_idx" ON "group_members"("group_id");
