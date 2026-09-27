/**
 * Shared Zod schemas for group creation, update, and member management —
 * issue #707.
 *
 * Group payloads were validated in `src/routes/groups.ts` with loose shapes:
 * a group id was `z.string()` with no bound, the legacy invite body accepted
 * any numeric `maxUses`, and unknown keys were silently stripped rather than
 * rejected, so a client with a typo could send a request that looked accepted
 * while the field it meant to set was dropped. This module is the strict
 * contract:
 *
 * - **`.strict()` on every request body.** Unknown keys are a validation
 *   error, not silent data loss — the same precedent as the shared pagination
 *   schema, where `?page=3` is a client bug rather than an ignored key.
 * - **Stellar public keys validated through `stellarAccountIdSchema`** (the
 *   SDK's ed25519 checksum rules), so a malformed member address can never
 *   reach a lookup or the database. The treasury-enabling key is validated
 *   the same way — that field is the security-critical half of a group's
 *   on-chain configuration.
 * - **Role assignments are closed enums.** A role outside `admin`/`member`
 *   is rejected before the handler, so no payload can carry an unrecognised
 *   role toward a membership row (the authorization guards remain the real
 *   authority — this is input validation, not access control).
 * - **Route params are bounded.** Every id is 1–64 identifier characters,
 *   matching what a cuid actually is, so an oversized path is a 400 instead
 *   of an arbitrary string handed to Prisma.
 *
 * The route file imports these for both handler parsing and its OpenAPI
 * annotations, so the documented shape and the enforced shape are the same
 * objects and cannot drift.
 */

import { z } from "zod";
import { stellarAccountIdSchema } from "../lib/stellar-validation";

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

/** Roles a group member can hold. Deliberately closed — no "owner" alias. */
export const GROUP_ROLES = ["admin", "member"] as const;

export const groupRoleSchema = z.enum(GROUP_ROLES);

/**
 * A group id (or member user id) in a path parameter: 1–64 identifier
 * characters. A cuid is 25 characters, but the bound is deliberately loose —
 * it exists to reject oversized or maliciously-shaped strings, not to pin a
 * format the schema layer does not own.
 */
export const groupIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Not a valid group identifier"
  );

/** A member's user id in a path parameter, bounded the same way. */
export const memberIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Not a valid member identifier"
  );

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

/** `{ id }` for routes addressed by a group id. */
export const groupParamsSchema = z.object({ id: groupIdSchema });

/** `{ id, memberId }` for routes addressing one member of a group. */
export const groupMemberParamsSchema = z.object({
  id: groupIdSchema,
  memberId: memberIdSchema,
});

// ---------------------------------------------------------------------------
// Group creation
// ---------------------------------------------------------------------------

/** Currencies supported for shared expense groups. */
export const GROUP_CURRENCIES = ["XLM", "USDC"] as const;
export type GroupCurrency = (typeof GROUP_CURRENCIES)[number];

export const groupCurrencySchema = z.enum(GROUP_CURRENCIES, {
  errorMap: () => ({ message: "Currency must be XLM or USDC" }),
});

/** Member item payload for group creation/update lists. */
export const groupMemberInputSchema = z.union([
  z.string().min(1).max(64),
  z
    .object({
      userId: z.string().min(1).max(64).optional(),
      publicKey: stellarAccountIdSchema.optional(),
      role: groupRoleSchema.optional(),
    })
    .strict(),
]);

/** Group metadata constraints schema. */
export const groupMetadataSchema = z.record(z.unknown());

/** Body of `POST /groups`. */
export const createGroupSchema = z
  .object({
    /** 1–60 visible characters; whitespace-only names are rejected. */
    name: z.string().trim().min(1, "name is required").max(60),
    description: z.string().max(280).nullable().optional(),
    currency: groupCurrencySchema.optional(),
    currencyType: groupCurrencySchema.optional(),
    defaultCurrency: groupCurrencySchema.optional(),
    members: z.array(groupMemberInputSchema).optional(),
    metadata: groupMetadataSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Group update
// ---------------------------------------------------------------------------

/**
 * Body of `PATCH /groups/:id`.
 *
 * At least one field must be present (`refine` below): an empty object would
 * otherwise be an accepted no-op write, and a client that believes it updated
 * a field it misspelled would get silent confirmation of nothing. Treasury
 * configuration is deliberately not updatable here — enabling or rotating the
 * treasury account has its own admin route (`/groups/:id/treasury/enable`)
 * with funding checks and a dedicated audit action, so a metadata update must
 * never be able to touch it.
 */
export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(60).optional(),
    description: z.string().max(280).nullable().optional(),
    currency: groupCurrencySchema.optional(),
    currencyType: groupCurrencySchema.optional(),
    defaultCurrency: groupCurrencySchema.optional(),
    members: z.array(groupMemberInputSchema).optional(),
    metadata: groupMetadataSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.currency !== undefined ||
      v.currencyType !== undefined ||
      v.defaultCurrency !== undefined ||
      v.members !== undefined ||
      v.metadata !== undefined,
    {
      message: "At least one of name, description, currency, members, or metadata is required",
    }
  );


// ---------------------------------------------------------------------------
// Member invitation
// ---------------------------------------------------------------------------

/**
 * Body of `POST /groups/:id/invite` — direct branch: invite a Stellar account
 * by public key. The key is checksum-validated (`G…`, ed25519), so a malformed
 * address is a 400 before any lookup runs.
 */
export const directInviteSchema = z
  .object({
    publicKey: stellarAccountIdSchema,
  })
  .strict();

/**
 * Body of `POST /groups/:id/invite` — legacy branch: mint a reusable invite
 * code. Both fields are positive integers with explicit upper bounds, so a
 * payload cannot mint an effectively unlimited-use code (`maxUses: 1e9`) or
 * an effectively never-expiring one (`expiresInHours: 1e9`). A body with both
 * a `publicKey` and legacy fields is rejected: the branches are disjoint.
 */
export const legacyInviteSchema = z
  .object({
    maxUses: z.number().int().min(1).max(1000).optional(),
    expiresInHours: z.number().int().min(1).max(8760).optional(), // 1 year
  })
  .strict();

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/** Body of `POST /groups/join`. Codes are 8 characters from the app's alphabet. */
export const joinGroupSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(32)
      .regex(
        /^[A-Za-z0-9]+$/,
        "Invite codes may only contain letters and digits"
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Role management
// ---------------------------------------------------------------------------

/** Body of `PATCH /groups/:id/members/:memberId` (role alias). */
export const memberRoleSchema = z
  .object({ role: groupRoleSchema })
  .strict();

/** Body of `POST /groups/:id/members/role`. */
export const changeMemberRoleSchema = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "Not a valid user identifier"
      ),
    role: groupRoleSchema,
  })
  .strict();

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type DirectInviteInput = z.infer<typeof directInviteSchema>;
export type LegacyInviteInput = z.infer<typeof legacyInviteSchema>;
export type GroupRole = z.infer<typeof groupRoleSchema>;
