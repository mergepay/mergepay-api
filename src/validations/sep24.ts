/**
 * Shared Zod schemas for SEP-24 (anchor) deposit and withdrawal requests.
 *
 * Centralizes the request-shape validation for the SEP-24 flows so every entry
 * point — the interactive deposit/withdraw start (`POST /anchors/*` in
 * src/routes/anchors.ts) and any future SEP-24 surface — rejects malformed
 * payloads with the same rules, before they reach a service or the database:
 *
 *   - asset code: alphanumeric, 1-12 chars (upper-cased on parse);
 *   - amount: a positive, precision-safe Stellar decimal when supplied;
 *   - account / `to`: a checksum-validated ed25519 Stellar public key;
 *   - memo: a short, alphanumeric anchor memo (no arbitrary bytes).
 *
 * Supported-asset and network checks intentionally stay in the handler via
 * `validateAsset` (src/services/assets.ts) so they keep their existing error
 * contract — this module only enforces *shape*.
 */
import { z } from "zod";
import {
  stellarAmountSchema,
  stellarPublicKeySchema,
} from "../lib/stellar-validation";

/** A Stellar public key ("G…"), checksum-validated via StrKey. Alias for readability. */
export const sep24AccountSchema = stellarPublicKeySchema;

/** SEP-24 asset code: alphanumeric, 1-12 chars, normalised to upper case. */
export const sep24AssetCodeSchema = z
  .string()
  .min(1, "assetCode is required")
  .max(12, "assetCode must be at most 12 characters")
  .regex(/^[A-Za-z0-9]+$/, "assetCode may only contain letters and digits")
  .transform((value) => value.toUpperCase());

/** SEP-24 amount: positive decimal with Stellar's 7-decimal precision. */
export const sep24AmountSchema = stellarAmountSchema;

/** SEP-24 memo: short alphanumeric anchor-side memo. */
export const sep24MemoSchema = z
  .string()
  .max(28, "memo must be at most 28 characters")
  .regex(/^[A-Za-z0-9]+$/, "memo may only contain letters and digits")
  .optional();

/**
 * Fields shared by SEP-24 deposit and withdrawal initiation.
 *
 * `amount`, `account`/`to`, and `memo` are optional here because the start
 * request only *begins* a flow; the interactive part carries the final
 * transfer parameters. Supplied values are validated strictly so a malformed
 * amount or a bogus Stellar address is rejected at the door.
 */
export const sep24InteractiveRequestSchema = z
  .object({
    assetCode: sep24AssetCodeSchema,
    assetIssuer: z.string().nullable().optional(),
    amount: sep24AmountSchema.optional(),
    // The Stellar account funding a deposit or receiving a withdrawal.
    account: sep24AccountSchema.optional(),
    to: sep24AccountSchema.optional(),
    memo: sep24MemoSchema,
    anchorName: z.string().max(64).optional(),
  })
  .refine(
    (val) => {
      // A native asset (XLM) must never be given an issuer.
      return !(val.assetCode === "XLM" && val.assetIssuer);
    },
    {
      message: "XLM is a native asset and does not take an issuer",
      path: ["assetIssuer"],
    }
  );

export type Sep24InteractiveRequest = z.infer<typeof sep24InteractiveRequestSchema>;

/**
 * A concrete SEP-24 withdrawal request (as distinct from merely starting an
 * interactive flow): requires the amount to be settled now.
 */
export const sep24WithdrawRequestSchema = z
  .object({
    assetCode: sep24AssetCodeSchema,
    assetIssuer: z.string().nullable().optional(),
    amount: sep24AmountSchema,
    account: sep24AccountSchema.optional(),
    to: sep24AccountSchema.optional(),
    memo: sep24MemoSchema,
    anchorName: z.string().max(64).optional(),
  })
  .refine(
    (val) => !(val.assetCode === "XLM" && val.assetIssuer),
    {
      message: "XLM is a native asset and does not take an issuer",
      path: ["assetIssuer"],
    }
  );

export type Sep24WithdrawRequest = z.infer<typeof sep24WithdrawRequestSchema>;