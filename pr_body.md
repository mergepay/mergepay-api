## Summary
This PR implements automated validation for signed XDR transaction payloads against expected group expense intents as well as Zod validation schemas for group creation and update payloads.

## Key Changes
1. **Automated XDR Validation for Group Expense Intents**:
   - Created `src/services/expense-xdr.ts` containing `validateExpenseXdr`, `expensePaymentIntent`, and `ExpenseIntentRecord`.
   - Decodes signed XDR payloads using `@stellar/stellar-sdk` (`TransactionBuilder.fromXDR`), inspecting operations, source/destination accounts, asset types/issuers, amounts, memos, time bounds, and signatures against stored expense intent records.
   - Rejects mismatched parameters, tampered amounts/destinations, fee-bump wrappers, or invalid signatures with a 400 Bad Request error (`XDR_MISMATCH`, `XDR_MALFORMED`, `INTENT_EXPIRED`).
   - Re-exported expense XDR validation helpers in `src/services/expenses.ts`.
   - Added comprehensive unit test suite in `tests/expense-xdr-validation.test.ts` covering valid XDRs and tampering scenarios.

2. **Group Creation & Update Zod Payload Validation**:
   - Updated `createGroupSchema` and `updateGroupSchema` in `src/schemas/groups.ts` to validate group name (1-60 non-whitespace chars), description, supported currency types (`XLM`, `USDC`), member lists, and metadata constraints.
   - Created `src/services/groups.ts` providing `validateCreateGroupPayload` and `validateUpdateGroupPayload` validation helpers.
   - Applied Zod schemas to Fastify route handlers for `/groups` endpoints.
   - Added unit tests in `tests/routes/group-schema-validation.test.ts` verifying validation failures for invalid payloads (e.g. invalid currency, empty/whitespace names, oversized descriptions, unknown keys).

## Acceptance Criteria Checklist
- [x] Implement validation logic that decodes signed XDR payloads and inspects operations.
- [x] Compare XDR operation details (destination, amount, asset) against expected database records for the given intent.
- [x] Reject transactions with mismatched parameters with a 400 Bad Request error.
- [x] Add unit tests covering valid XDRs and various tampering scenarios.
- [x] Create Zod schemas for group creation and group update request bodies.
- [x] Apply the schemas to Fastify route handlers for group endpoints.
- [x] Add unit tests verifying validation failures for invalid group payloads.

Closes #
