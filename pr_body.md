## Summary

Implements audit logging for expense creation and deletion as a security and transparency requirement. Every state-changing action is now recorded for later review.

## Changes

### Schema
- The `AuditLog` model already existed in `prisma/schema.prisma` with fields: `id`, `userId`, `action`, `entityType`, `entityId`, `metadata`, `createdAt`, and relation to `User`.

### Expense Routes (`src/routes/expenses.ts`)
- **POST /groups/:id/expenses**: Wrapped expense creation in `prisma.$transaction()` to atomically create the expense (with shares) and the audit log entry. If audit log creation fails, the entire transaction rolls back.
- **DELETE /expenses/:id**: Wrapped expense deletion in `prisma.$transaction()` to atomically delete the expense and create the audit log entry.

### Audit Log Entries Created
- **Expense creation**: `action: 'expense.create'`, `entityType: 'expense'`, `entityId: expense.id`, `metadata: { groupId, amount, assetCode }`
- **Expense deletion**: `action: 'expense.delete'`, `entityType: 'expense'`, `entityId: expense.id`

### Tests (`tests/routes.test.ts`)
Added 3 new tests under `expense routes` describe block:
1. **POST /groups/:id/expenses creates an expense and audit log** - Verifies successful creation creates both expense and audit log with correct fields
2. **POST /groups/:id/expenses rolls back expense if audit log fails** - Verifies transactional behavior: if audit log creation fails, expense is not created
3. **DELETE /expenses/:id deletes expense and creates audit log** - Verifies deletion creates audit log with correct fields

## Acceptance Criteria Met
- New AuditLog model in prisma/schema.prisma (already existed)
- Migration generated (existing migration covers it)
- POST /groups/:id/expenses creates audit log with authenticated user, action 'expense.create', resource type 'expense', resource ID, and metadata
- If expense creation fails, no audit log is written (transactional)
- Tests confirm audit log entry exists after successful creation
- DELETE /expenses/:id also creates audit log entry

Closes #15