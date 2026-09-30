/**
 * Group management service and validation module.
 *
 * Provides functions to validate group creation and update payloads against
 * Zod schemas before database operations.
 */
import { Errors } from "../errors";
import {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
} from "../schemas/groups";

/**
 * Validate a group creation request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateCreateGroupPayload(payload: unknown): CreateGroupInput {
  const result = createGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group payload"}`);
  }
  return result.data;
}

/**
 * Validate a group update request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateUpdateGroupPayload(payload: unknown): UpdateGroupInput {
  const result = updateGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group update payload"}`);
  }
  return result.data;
}

export {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
};
