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
 *   - memo: a short, alphanumeric anchor memo (no arbitrary bytes);
 *   - unexpected fields: rejected outright — both request objects are strict,
 *     so a misspelled or unsupported field is a 400, never a silent drop.
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

// ─── Callback query-parameter schema ─────────────────────────────────────────

/**
 * Optional query parameters an anchor may include on a SEP-24 callback.
 *
 * The SEP-24 spec does not mandate specific query parameters, but anchors
 * sometimes send `lang` or anchor-specific identifiers. This schema
 * rejects unknown query parameters at the route boundary so an unexpected
 * key (e.g. a crafted injection attempt) never reaches downstream logic.
 */
export const sep24CallbackQuerySchema = z
  .object({
    lang: z.string().min(2).max(10).optional(),
  })
  .strict();

/**
 * Query parameters accepted when *starting* a SEP-24 deposit or withdrawal.
 *
 * The initiation endpoints take their whole request in the JSON body (see
 * `sep24DepositRequestSchema` / `sep24WithdrawRequestSchema`), so the query
 * string carries no part of the contract: there is nothing in the body a query
 * parameter could legitimately override. It is parsed anyway, strictly, so a
 * typo (`?asset_code=XLM`, the SEP-24 wire spelling, against a camelCase body)
 * or an injected key is answered with a 400 naming the offending parameter
 * rather than being silently dropped while the body it contradicts is honoured.
 *
 * `lang` is the one exception, tolerated for parity with the callback above so
 * a client that localises every anchor call it makes is not turned away at the
 * door; it is bounded like the callback's and never reaches the anchor.
 */
export const sep24InitQuerySchema = z
  .object({
    lang: z.string().min(2).max(10).optional(),
  })
  .strict();

/** A Stellar transaction hash is a 32-byte value encoded as 64 hex chars. */
export const sep24StellarTransactionHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hexadecimal Stellar transaction hash");

/** A Stellar public key (G…), checksum-validated via StrKey. */
export const sep24AccountSchema = stellarPublicKeySchema;

/**
 * SEP-24 asset code *shape*: alphanumeric, 1-12 chars. Format only — callers
 * that want case normalisation use `sep24AssetCodeSchema`; callers with their
 * own exact-match support list (POST /withdraw keeps a case-sensitive
 * `UNSUPPORTED_ASSET` contract) validate the shape here and match there.
 */
export const sep24AssetCodeShapeSchema = z
  .string()
  .min(1, "assetCode is required")
  .max(12, "assetCode must be at most 12 characters")
  .regex(/^[A-Za-z0-9]+$/, "assetCode may only contain letters and digits");

/** SEP-24 asset code: alphanumeric, 1-12 chars, normalised to upper case. */
export const sep24AssetCodeSchema = sep24AssetCodeShapeSchema.transform((value) =>
  value.toUpperCase()
);

/**
 * SEP-24 amount *shape*: a plain decimal with at most 7 fractional digits.
 * Deliberately positivity-agnostic — `POST /withdraw` owns its
 * `INVALID_AMOUNT` error contract for zero/negative values in the handler
 * (see src/routes/withdraw.ts), so shape and positivity are validated in
 * sequence rather than one swallowing the other's error code.
 */
export const sep24AmountShapeSchema = z
  .string()
  .min(1, "amount is required")
  .max(40, "amount is too long")
  .regex(/^\d+(?:\.\d{1,7})?$/, "amount must be a decimal with at most 7 decimal places");

/** SEP-24 amount: positive decimal with Stellar's 7-decimal precision. */
export const sep24AmountSchema = stellarAmountSchema;

/** Longest valid memo of any type: a base64-encoded 32-byte hash (44 chars). */
const SEP24_MEMO_MAX_LENGTH = 44;

/** Stellar MEMO_TEXT holds at most 28 bytes. */
const MEMO_TEXT_MAX_BYTES = 28;

/** Stellar MEMO_ID is an unsigned 64-bit integer. */
const MEMO_ID_MAX = 18446744073709551615n;

/** A 32-byte value in padded base64 is 43 alphabet characters plus one `=`. */
const MEMO_HASH_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

function hasControlCharacter(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * SEP-24 memo. The shape is only bounded here; the value is checked against
 * its `memoType` (text / id / hash) by `refineMemoValue` once both are known.
 */
export const sep24MemoSchema = z
  .string()
  .max(SEP24_MEMO_MAX_LENGTH, `memo must be at most ${SEP24_MEMO_MAX_LENGTH} characters`)
  .optional();

/** The Stellar transaction-memo kind accompanying `memo`. */
export const sep24MemoTypeSchema = z.enum(["text", "id", "hash"]);

type Sep24MemoType = z.infer<typeof sep24MemoTypeSchema>;

/**
 * Check a memo value against the Stellar memo type it will be sent as:
 *   - text: at most 28 UTF-8 bytes, no control characters;
 *   - id:   an unsigned 64-bit integer in decimal;
 *   - hash: 32 bytes, base64-encoded (as SEP-24 specifies for hash memos).
 */
function refineMemoValue(
  memo: string,
  memoType: Sep24MemoType,
  field: string,
  ctx: z.RefinementCtx
): void {
  let message: string | undefined;
  if (memoType === "text") {
    if (Buffer.byteLength(memo, "utf8") > MEMO_TEXT_MAX_BYTES) {
      message = `${field} must be at most ${MEMO_TEXT_MAX_BYTES} UTF-8 bytes for memo type "text"`;
    } else if (hasControlCharacter(memo)) {
      message = `${field} must not contain control characters`;
    }
  } else if (memoType === "id") {
    if (!/^\d{1,20}$/.test(memo) || BigInt(memo) > MEMO_ID_MAX) {
      message = `${field} must be an unsigned 64-bit integer for memo type "id"`;
    }
  } else if (!MEMO_HASH_BASE64.test(memo) || Buffer.from(memo, "base64").length !== 32) {
    message = `${field} must be a base64-encoded 32-byte value for memo type "hash"`;
  }
  if (message) {
    ctx.addIssue({ code: "custom", path: [field], message });
  }
}

function refineMemoPairing(
  value: { memo?: string; memoType?: "text" | "id" | "hash" },
  ctx: z.RefinementCtx
): void {
  if (value.memo && !value.memoType) {
    ctx.addIssue({
      code: "custom",
      path: ["memoType"],
      message: "memoType is required when memo is supplied",
    });
  }
  if (value.memoType && !value.memo) {
    ctx.addIssue({
      code: "custom",
      path: ["memo"],
      message: "memo is required when memoType is supplied",
    });
  }
  if (value.memo && value.memoType) {
    refineMemoValue(value.memo, value.memoType, "memo", ctx);
  }
}

function refineRefundMemoPairing(
  value: { refundMemo?: string; refundMemoType?: "text" | "id" | "hash" },
  ctx: z.RefinementCtx
): void {
  if (value.refundMemo && !value.refundMemoType) {
    ctx.addIssue({
      code: "custom",
      path: ["refundMemoType"],
      message: "refundMemoType is required when refundMemo is supplied",
    });
  }
  if (value.refundMemoType && !value.refundMemo) {
    ctx.addIssue({
      code: "custom",
      path: ["refundMemo"],
      message: "refundMemo is required when refundMemoType is supplied",
    });
  }
  if (value.refundMemo && value.refundMemoType) {
    refineMemoValue(value.refundMemo, value.refundMemoType, "refundMemo", ctx);
  }
}

const SEP24_EXTRA_METADATA_MAX_KEYS = 20;
const SEP24_EXTRA_METADATA_MAX_BYTES = 2048;

function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Infinity;
  }
}

/** Free-form client metadata, bounded so it cannot carry an unbounded payload. */
export const sep24ExtraMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length <= SEP24_EXTRA_METADATA_MAX_KEYS, {
    message: `extraMetadata may have at most ${SEP24_EXTRA_METADATA_MAX_KEYS} keys`,
  })
  .refine((value) => serializedByteLength(value) <= SEP24_EXTRA_METADATA_MAX_BYTES, {
    message: `extraMetadata must be at most ${SEP24_EXTRA_METADATA_MAX_BYTES} bytes when serialized`,
  });

const sharedFields = {
  assetCode: sep24AssetCodeSchema,
  assetIssuer: sep24AccountSchema.nullable().optional(),
  amount: sep24AmountSchema.optional(),
  account: sep24AccountSchema.optional(),
  to: sep24AccountSchema.optional(),
  memo: sep24MemoSchema,
  memoType: sep24MemoTypeSchema.optional(),
  walletName: z.string().trim().min(1).max(120).optional(),
  anchorName: z.string().max(64).optional(),
  refundAddress: sep24AccountSchema.optional(),
  refundMemo: sep24MemoSchema,
  refundMemoType: sep24MemoTypeSchema.optional(),
  extraMetadata: sep24ExtraMetadataSchema.optional(),
};

function validateNativeIssuer<
  T extends {
    assetCode: string;
    assetIssuer?: string | null;
    memo?: string;
    memoType?: "text" | "id" | "hash";
    refundMemo?: string;
    refundMemoType?: "text" | "id" | "hash";
  }
>(schema: z.ZodType<T>) {
  return schema
    .refine(
      (value) => !(value.assetCode === "XLM" && value.assetIssuer),
      {
        message: "XLM is a native asset and does not take an issuer",
        path: ["assetIssuer"],
      }
    )
    .superRefine(refineMemoPairing)
    .superRefine(refineRefundMemoPairing);
}

/** Strict request schema for starting either SEP-24 interactive flow. */
export const sep24InteractiveRequestSchema = validateNativeIssuer(
  z.object(sharedFields).strict()
);

/** Deposit initiation uses the shared interactive request contract. */
export const sep24DepositRequestSchema = sep24InteractiveRequestSchema;

/**
 * Strict concrete withdrawal request. Unlike a generic interactive start, a
 * withdrawal must include the amount that is being settled.
 */
export const sep24WithdrawRequestSchema = validateNativeIssuer(
  z.object({ ...sharedFields, amount: sep24AmountSchema }).strict()
);

export type Sep24InteractiveRequest = z.infer<typeof sep24InteractiveRequestSchema>;
export type Sep24DepositRequest = z.infer<typeof sep24DepositRequestSchema>;
export type Sep24WithdrawRequest = z.infer<typeof sep24WithdrawRequestSchema>;
export type Sep24CallbackQuery = z.infer<typeof sep24CallbackQuerySchema>;
export type Sep24InitQuery = z.infer<typeof sep24InitQuerySchema>;
