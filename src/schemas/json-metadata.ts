/**
 * Zod schemas for the Prisma JSON columns — issue #1037.
 *
 * The schema has exactly three Json columns: `TreasuryProposal.signatures`,
 * `AuditLog.details`, and `AuditLog.metadata` (settlement metadata is audit
 * metadata for `entityType = "settlement"` rows). Every read of those columns
 * goes through a `parse*` accessor and every write through a `serialize*`
 * helper, so only validated shapes are persisted or consumed.
 *
 * Error semantics follow the repo convention: accessors call `.parse()` and
 * throw the raw `ZodError`, which src/plugins/error-handler.ts renders as a
 * 400 VALIDATION_ERROR. Unknown extra fields on signature entries are dropped
 * (and logged); audit metadata/details are open-ended records, so every key is
 * preserved and only non-JSON values are rejected.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { Errors } from "../lib/errors";

/**
 * Any value Prisma can persist inside a Json column, including nested nulls.
 * `Date` is accepted because sanitized caller metadata may carry Dates;
 * Prisma (and the JSON round-trip in `serialize*`) stores them as ISO strings.
 */
const jsonNullableValueSchema: z.ZodType<Prisma.InputJsonValue | null> = z.lazy(
  () =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(jsonNullableValueSchema),
      z.record(z.string(), jsonNullableValueSchema),
      z.date(),
    ])
);

/** A non-null Json value (Prisma models column-level nulls with JsonNull). */
export const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonNullableValueSchema),
    z.record(z.string(), jsonNullableValueSchema),
    z.date(),
  ])
);

/**
 * One stored treasury signature. `publicKey` is the only universally required
 * field: legacy rows and fixtures record `{ publicKey, signedAt }` without the
 * base64 `signature`, so `signature`/`signedAt` are optional rather than
 * inventing a requirement existing data does not meet.
 */
export const treasurySignatureSchema = z.object({
  publicKey: z.string().min(1),
  signature: z.string().min(1).optional(),
  signedAt: z.string().min(1).optional(),
});

export type StoredTreasurySignature = z.infer<typeof treasurySignatureSchema>;

export const treasurySignaturesSchema = z.array(treasurySignatureSchema);

const KNOWN_SIGNATURE_KEYS: ReadonlySet<string> = new Set([
  "publicKey",
  "signature",
  "signedAt",
]);

/**
 * Read accessor for `TreasuryProposal.signatures`. Null/undefined (the column
 * default is `[]`) reads as an empty array; a malformed stored shape throws a
 * ZodError. Unknown extra keys on entries are dropped and logged.
 */
export function parseTreasurySignatures(
  value: Prisma.JsonValue | null | undefined
): StoredTreasurySignature[] {
  if (value === null || value === undefined) return [];
  const parsed = treasurySignaturesSchema.parse(value);
  if (Array.isArray(value)) {
    const dropped = new Set<string>();
    for (const entry of value) {
      if (isRecord(entry)) {
        for (const key of Object.keys(entry)) {
          if (!KNOWN_SIGNATURE_KEYS.has(key)) dropped.add(key);
        }
      }
    }
    if (dropped.size > 0) {
      console.warn(
        `[json-metadata] dropped unknown treasury signature fields: ${[...dropped].join(", ")}`
      );
    }
  }
  return parsed;
}

/** Write serializer for `TreasuryProposal.signatures` — only valid shapes persist. */
export function serializeTreasurySignatures(
  signatures: readonly StoredTreasurySignature[]
): Prisma.InputJsonValue {
  return treasurySignaturesSchema.parse(signatures);
}

/**
 * Audit metadata is an open-ended operational breadcrumb (settlement amounts,
 * treasury hashes, worker outcomes, route payloads, ...), so no key is
 * universally required; the record must simply be a JSON object.
 */
export const auditMetadataSchema = z.record(z.string(), jsonNullableValueSchema);

export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

/** Read accessor for `AuditLog.metadata`. Throws a ZodError on a non-object shape. */
export function parseAuditMetadata(value: unknown): AuditMetadata {
  return auditMetadataSchema.parse(value);
}

/** Write serializer for `AuditLog.metadata`. */
export function serializeAuditMetadata(
  metadata: Record<string, unknown> | null | undefined
): AuditMetadata {
  return auditMetadataSchema.parse(normalizeJson(metadata ?? {}, "Audit metadata"));
}

/** Legacy write-only `AuditLog.details` column — same open record contract. */
export const auditDetailsSchema = z.record(z.string(), jsonNullableValueSchema);

export type AuditDetails = z.infer<typeof auditDetailsSchema>;

/** Read accessor for `AuditLog.details`. Throws a ZodError on a non-object shape. */
export function parseAuditDetails(value: unknown): AuditDetails {
  return auditDetailsSchema.parse(value);
}

/** Write serializer for `AuditLog.details`. */
export function serializeAuditDetails(
  details: Record<string, unknown> | null | undefined
): AuditDetails {
  return auditDetailsSchema.parse(normalizeJson(details ?? {}, "Audit details"));
}

/** Type guard for spreading sanitized (unknown-typed) metadata safely. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduce a value to the plain JSON Prisma will store: Dates become ISO strings
 * (via toJSON), undefined-valued keys drop, class instances flatten to their
 * enumerable properties — exactly what JSON.stringify does inside Prisma.
 * Circular references and BigInts cannot be persisted and throw a typed 400.
 */
function normalizeJson(value: unknown, label: string): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw Errors.validation(
      `${label} is not JSON-serializable`,
      err instanceof Error ? err.message : undefined
    );
  }
  return json === undefined ? null : JSON.parse(json);
}
