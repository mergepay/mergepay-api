/**
 * Re-exports from `src/lib/errors.ts`.
 *
 * All existing imports of `AppError` and `Errors` from `"../errors"` (or
 * `"./errors"`) continue to work without change.  New code should prefer
 * importing directly from `"./lib/errors"`.
 */
export { AppError, Errors, ErrorCode } from "./lib/errors";
