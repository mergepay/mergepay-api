/**
 * SEP-24 request schemas — issue #366.
 *
 * The canonical Zod schemas for SEP-24 deposit/withdrawal initialization and
 * status requests live in `src/validations/sep24.ts`, which the anchor routes
 * (src/routes/anchors.ts) apply inside their handlers so malformed payloads
 * are rejected with a 400 VALIDATION_ERROR before any anchor I/O happens.
 *
 * This module re-exports them under the location the issue names so callers
 * have a single import point and there is exactly one source of truth — the
 * earlier divergent schema that lived here (regex-only account checks, no
 * amount/memo rules) was never wired into a route and has been removed rather
 * than left as a weaker duplicate.
 */
export {
  sep24AccountSchema,
  sep24AmountSchema,
  sep24AssetCodeSchema,
  sep24DepositRequestSchema,
  sep24InteractiveRequestSchema,
  sep24MemoSchema,
  sep24MemoTypeSchema,
  sep24WithdrawRequestSchema,
  type Sep24InteractiveRequest,
  type Sep24DepositRequest,
  type Sep24WithdrawRequest,
} from "../validations/sep24";
