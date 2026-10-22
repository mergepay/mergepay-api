/**
 * Zod schemas for the SEP-24 anchor responses Mergepay consumes.
 *
 * Only `GET /transaction` is read today (the worker's status poll); `/info`
 * and `/transactions` are not called, so they have no schema here. Every type
 * describing an anchor response is derived from these schemas with `z.infer`
 * — there is no hand-written interface to drift from what is validated.
 *
 * ## Validation rules
 *
 *  - **Required fields** (`id`, `kind`, `status`) must be present and valid.
 *    A response missing one is not a SEP-24 transaction and fails parsing.
 *  - **Optional fields** that are malformed (e.g. an amount sent as a JSON
 *    number) are dropped and reported in `droppedFields`, not fatal: a
 *    cosmetic deviation in an optional field must not stop Mergepay tracking
 *    an otherwise valid transaction.
 *  - **Unknown fields** are stripped. Anchors add fields freely; they are
 *    neither rejected nor carried forward (they may hold PII such as bank
 *    details that Mergepay has no reason to hold).
 *  - **Amounts** stay decimal strings end to end. JSON numbers are rejected
 *    rather than stringified: by the time `JSON.parse` returns they are
 *    already floats, and a float is never an acceptable money value.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#single-historical-transaction
 */
import { z } from "zod";
import {
  isSep24TransactionStatus,
  type Sep24TransactionStatus,
} from "./sep24-types";

/** A non-negative decimal string, e.g. "100", "0.5", "12.0000001". */
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

const sep24AmountSchema = z
  .string()
  .regex(DECIMAL_AMOUNT, "must be a non-negative decimal string");

export const sep24TransactionKindSchema = z.enum(["deposit", "withdrawal"]);

export const sep24RefundPaymentSchema = z.object({
  id: z.string().min(1),
  id_type: z.enum(["stellar", "external"]),
  amount: sep24AmountSchema,
  fee: sep24AmountSchema,
});

export const sep24RefundsSchema = z.object({
  amount_refunded: sep24AmountSchema,
  amount_fee: sep24AmountSchema,
  payments: z.array(sep24RefundPaymentSchema),
});

/** Fields a SEP-24 transaction cannot be interpreted without. */
const REQUIRED_TRANSACTION_FIELDS = ["id", "kind", "status"] as const;

export const sep24AnchorTransactionSchema = z.object({
  id: z.string().trim().min(1).max(255),
  kind: sep24TransactionKindSchema,
  /**
   * Kept as the anchor's raw (trimmed, lower-cased) string rather than
   * narrowed to the status union: an unrecognized status is a valid response
   * that `resolveSep24Status` classifies, not a malformed one.
   */
  status: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((status) => status.toLowerCase()),
  status_eta: z.number().int().nonnegative().nullish(),
  more_info_url: z.string().url().nullish(),
  amount_in: sep24AmountSchema.nullish(),
  amount_in_asset: z.string().max(128).nullish(),
  amount_out: sep24AmountSchema.nullish(),
  amount_out_asset: z.string().max(128).nullish(),
  amount_fee: sep24AmountSchema.nullish(),
  amount_fee_asset: z.string().max(128).nullish(),
  started_at: z.string().max(64).nullish(),
  updated_at: z.string().max(64).nullish(),
  completed_at: z.string().max(64).nullish(),
  stellar_transaction_id: z.string().max(128).nullish(),
  external_transaction_id: z.string().max(255).nullish(),
  message: z.string().max(1024).nullish(),
  /** Deprecated in favour of `refunds`, still sent by older anchors. */
  refunded: z.boolean().nullish(),
  refunds: sep24RefundsSchema.nullish(),
});

/** `GET /transaction` response envelope. */
export const sep24TransactionResponseSchema = z.object({
  transaction: sep24AnchorTransactionSchema,
});

export type Sep24TransactionKind = z.infer<typeof sep24TransactionKindSchema>;
export type Sep24Refunds = z.infer<typeof sep24RefundsSchema>;
export type Sep24AnchorTransaction = z.infer<typeof sep24AnchorTransactionSchema>;
export type Sep24TransactionResponse = z.infer<typeof sep24TransactionResponseSchema>;

const OPTIONAL_TRANSACTION_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(sep24AnchorTransactionSchema.shape).filter(
    (field) => !(REQUIRED_TRANSACTION_FIELDS as readonly string[]).includes(field)
  )
);

export type Sep24TransactionParseResult =
  | {
      success: true;
      transaction: Sep24AnchorTransaction;
      /** Optional fields that were present but invalid, and so were dropped. */
      droppedFields: string[];
    }
  | {
      success: false;
      /** Dotted paths of the invalid fields, e.g. `transaction.kind`. */
      fields: string[];
    };

function issuePaths(error: z.ZodError): string[] {
  const paths = error.issues.map((issue) => issue.path.join(".") || "(root)");
  return [...new Set(paths)];
}

/** The optional transaction field an issue is about, if it is about one. */
function optionalFieldOf(issue: z.ZodIssue): string | null {
  const [root, field] = issue.path;
  if (root !== "transaction" || typeof field !== "string") return null;
  return OPTIONAL_TRANSACTION_FIELDS.has(field) ? field : null;
}

/**
 * Parse a `GET /transaction` response body.
 *
 * Fails only when the envelope or a required field is invalid. Invalid
 * optional fields are removed and the body re-parsed, so a bad `amount_fee`
 * costs the fee, not the status update.
 */
export function parseSep24TransactionResponse(body: unknown): Sep24TransactionParseResult {
  const first = sep24TransactionResponseSchema.safeParse(body);
  if (first.success) {
    return { success: true, transaction: first.data.transaction, droppedFields: [] };
  }

  const fields = first.error.issues.map(optionalFieldOf);
  const dropped = fields.filter((field): field is string => field !== null);
  if (dropped.length !== fields.length) {
    return { success: false, fields: issuePaths(first.error) };
  }

  // Every issue is on an optional field, so the envelope is an object with a
  // `transaction` object; strip the offending fields and parse again.
  const droppedFields = [...new Set(dropped)];
  const envelope = body as { transaction: Record<string, unknown> };
  const transaction = { ...envelope.transaction };
  for (const field of droppedFields) delete transaction[field];

  const second = sep24TransactionResponseSchema.safeParse({ transaction });
  if (!second.success) {
    return { success: false, fields: issuePaths(second.error) };
  }
  return {
    success: true,
    transaction: second.data.transaction,
    droppedFields: droppedFields.map((field) => `transaction.${field}`),
  };
}

// ─── Status resolution ──────────────────────────────────────────────────────

/**
 * Deprecated SEP-24 statuses and the current status each one means. Older
 * anchors still emit them; both describe a transfer the anchor is processing.
 */
const LEGACY_STATUS_MAP: Readonly<Record<string, Sep24TransactionStatus>> = {
  pending_user_transfer_complete: "pending_anchor",
  pending_external: "pending_anchor",
};

export type ResolvedSep24Status =
  | { recognized: true; status: Sep24TransactionStatus; legacy: boolean }
  | { recognized: false; status: null };

/**
 * Classify a raw anchor status.
 *
 * An unrecognized status resolves to `{ recognized: false, status: null }`
 * rather than to a guessed local state. Callers must not persist it: the
 * session keeps the last status Mergepay understood, and the next poll is
 * free to report something known.
 */
export function resolveSep24Status(raw: string): ResolvedSep24Status {
  const normalized = raw.trim().toLowerCase();
  if (isSep24TransactionStatus(normalized)) {
    return { recognized: true, status: normalized, legacy: false };
  }
  const legacy = LEGACY_STATUS_MAP[normalized];
  if (legacy) return { recognized: true, status: legacy, legacy: true };
  return { recognized: false, status: null };
}
