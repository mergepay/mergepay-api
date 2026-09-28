# Issue #405: Prisma query performance index confirmation

This PR confirms the query-performance indexes for the issue are already present in the Prisma schema and linked to issue #405.

## Confirmed schema indexes

- `Group`: `@@index([createdByUserId])`
- `GroupMember`: `@@index([groupId])`
- `Expense`: `@@index([groupId, createdAt, id])`
- `ExpenseShare`: `@@index([expenseId, userId])`
- `Settlement`: `@@index([groupId])`

## Why this PR exists

The underlying database fix is already implemented in [prisma/schema.prisma](prisma/schema.prisma). This PR records the verification and links the issue closure to the concrete schema evidence so issue #405 can be closed cleanly.

Closes #405
