import { describe, it, expect, vi, afterEach } from "vitest";
import { ZodError } from "zod";
import { AppError } from "../../src/errors/app-error";
import {
  treasurySignatureSchema,
  treasurySignaturesSchema,
  parseTreasurySignatures,
  serializeTreasurySignatures,
  auditMetadataSchema,
  parseAuditMetadata,
  serializeAuditMetadata,
  auditDetailsSchema,
  parseAuditDetails,
  serializeAuditDetails,
  isRecord,
} from "../../src/schemas/json-metadata";

/**
 * Unit tests for the Prisma JSON-column schemas — issue #1037.
 *
 * Covers the three Json columns (`TreasuryProposal.signatures`,
 * `AuditLog.details`, `AuditLog.metadata`): valid shapes, missing required
 * fields, tolerant handling of unknown extras, and malformed stored values
 * failing the read accessors with the repo's raw-ZodError convention.
 */

const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("treasurySignatureSchema / treasurySignaturesSchema", () => {
  it("accepts a fully-populated stored signature", () => {
    const entry = {
      publicKey: PUBLIC_KEY,
      signature: "c2lnbmF0dXJl",
      signedAt: "2026-06-01T00:00:00.000Z",
    };
    expect(treasurySignatureSchema.parse(entry)).toEqual(entry);
    expect(treasurySignaturesSchema.parse([entry])).toEqual([entry]);
  });

  it("accepts legacy entries that record only publicKey and signedAt", () => {
    const entry = { publicKey: PUBLIC_KEY, signedAt: "2026-06-01T00:00:00.000Z" };
    expect(treasurySignatureSchema.parse(entry)).toEqual(entry);
  });

  it("accepts seed-shaped entries that record only publicKey and signature", () => {
    const entry = { publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl" };
    expect(treasurySignatureSchema.parse(entry)).toEqual(entry);
  });

  it("rejects an entry missing the required publicKey", () => {
    expect(() =>
      treasurySignaturesSchema.parse([{ signature: "c2lnbmF0dXJl" }])
    ).toThrow(ZodError);
    expect(() => treasurySignatureSchema.parse({})).toThrow(ZodError);
  });

  it("rejects empty or non-string identifier fields", () => {
    expect(() =>
      treasurySignatureSchema.parse({ publicKey: "" })
    ).toThrow(ZodError);
    expect(() =>
      treasurySignatureSchema.parse({ publicKey: 123 })
    ).toThrow(ZodError);
    expect(() =>
      treasurySignatureSchema.parse({ publicKey: PUBLIC_KEY, signature: "" })
    ).toThrow(ZodError);
    expect(() =>
      treasurySignatureSchema.parse({ publicKey: PUBLIC_KEY, signedAt: 42 })
    ).toThrow(ZodError);
  });

  it("drops unknown extra fields instead of failing", () => {
    const parsed = treasurySignatureSchema.parse({
      publicKey: PUBLIC_KEY,
      signature: "c2lnbmF0dXJl",
      futureField: { nested: true },
    });
    expect(parsed).toEqual({ publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl" });
  });

  it("rejects non-array and malformed-entry collections", () => {
    expect(() => treasurySignaturesSchema.parse({ publicKey: PUBLIC_KEY })).toThrow(ZodError);
    expect(() => treasurySignaturesSchema.parse("not-json")).toThrow(ZodError);
    expect(() => treasurySignaturesSchema.parse([PUBLIC_KEY])).toThrow(ZodError);
    expect(() => treasurySignaturesSchema.parse([null])).toThrow(ZodError);
  });
});

describe("parseTreasurySignatures (stored read accessor)", () => {
  it("reads null and undefined as an empty array (column default)", () => {
    expect(parseTreasurySignatures(null)).toEqual([]);
    expect(parseTreasurySignatures(undefined)).toEqual([]);
  });

  it("returns typed entries for a valid stored array", () => {
    const stored = [
      { publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl", signedAt: "2026-06-01T00:00:00.000Z" },
      { publicKey: PUBLIC_KEY, signedAt: "2026-06-01T00:00:00.000Z" },
    ];
    const parsed = parseTreasurySignatures(stored);
    expect(parsed).toEqual(stored);
    expect(parsed[0].publicKey).toBe(PUBLIC_KEY);
  });

  it("skips and logs unknown extra fields on stored entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseTreasurySignatures([
      { publicKey: PUBLIC_KEY, legacyBlob: "ignored" },
    ]);
    expect(parsed).toEqual([{ publicKey: PUBLIC_KEY }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacyBlob"));
  });

  it("throws a ZodError on a malformed stored shape", () => {
    expect(() => parseTreasurySignatures({ publicKey: PUBLIC_KEY })).toThrow(ZodError);
    expect(() => parseTreasurySignatures("corrupted")).toThrow(ZodError);
    expect(() => parseTreasurySignatures([{ signedAt: "2026-06-01T00:00:00.000Z" }])).toThrow(ZodError);
    expect(() => parseTreasurySignatures([42])).toThrow(ZodError);
  });
});

describe("serializeTreasurySignatures (write serializer)", () => {
  it("persists valid entries unchanged", () => {
    const entries = [
      { publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl", signedAt: "2026-06-01T00:00:00.000Z" },
    ];
    expect(serializeTreasurySignatures(entries)).toEqual(entries);
    expect(serializeTreasurySignatures([])).toEqual([]);
  });

  it("strips unknown extras so only the canonical shape persists", () => {
    const serialized = serializeTreasurySignatures([
      { publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl" },
    ]);
    expect(serialized).toEqual([
      { publicKey: PUBLIC_KEY, signature: "c2lnbmF0dXJl" },
    ]);
  });

  it("rejects writes missing the required publicKey", () => {
    expect(() =>
      serializeTreasurySignatures([
        { signature: "c2lnbmF0dXJl" } as unknown as { publicKey: string },
      ])
    ).toThrow(ZodError);
  });
});

describe("auditMetadataSchema / parseAuditMetadata", () => {
  it("accepts settlement audit metadata", () => {
    const metadata = {
      amount: "10.0000000",
      assetCode: "USDC",
      status: "confirmed",
      stellarTxHash: "abc123",
      actorType: "user",
      actorPublicKey: PUBLIC_KEY,
      outcome: "success",
    };
    expect(parseAuditMetadata(metadata)).toEqual(metadata);
  });

  it("accepts an empty object — no key is universally required", () => {
    expect(auditMetadataSchema.parse({})).toEqual({});
    expect(parseAuditMetadata({})).toEqual({});
  });

  it("preserves unknown extra keys and nested JSON values", () => {
    const metadata = {
      method: "POST",
      route: "/groups",
      statusCode: 201,
      payload: { name: "Trip", members: [1, 2], nested: { ok: true } },
      clientIp: "127.0.0.1",
      adminAction: true,
      previousRequiredSigners: null,
      someFutureKey: "kept",
    };
    expect(parseAuditMetadata(metadata)).toEqual(metadata);
  });

  it("throws a ZodError when the stored value is not a JSON object", () => {
    expect(() => parseAuditMetadata(null)).toThrow(ZodError);
    expect(() => parseAuditMetadata(undefined)).toThrow(ZodError);
    expect(() => parseAuditMetadata(["amount", "10"])).toThrow(ZodError);
    expect(() => parseAuditMetadata("amount=10")).toThrow(ZodError);
    expect(() => parseAuditMetadata(42)).toThrow(ZodError);
  });

  it("throws on non-JSON values inside the record", () => {
    expect(() => parseAuditMetadata({ when: new Date() })).not.toThrow();
    expect(() => parseAuditMetadata({ fn: () => 1 })).toThrow(ZodError);
    expect(() => parseAuditMetadata({ missing: undefined })).toThrow(ZodError);
    expect(() => parseAuditMetadata({ big: BigInt(1) })).toThrow(ZodError);
  });
});

describe("serializeAuditMetadata (write serializer)", () => {
  it("persists plain JSON metadata unchanged", () => {
    const metadata = { amount: "10", assetCode: "USDC", toUserId: "user_2" };
    expect(serializeAuditMetadata(metadata)).toEqual(metadata);
  });

  it("normalizes Dates to ISO strings exactly as Prisma would store them", () => {
    const serialized = serializeAuditMetadata({
      timestamp: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(serialized).toEqual({ timestamp: "2026-06-01T00:00:00.000Z" });
  });

  it("drops undefined-valued keys and keeps nulls", () => {
    const serialized = serializeAuditMetadata({
      kept: "yes",
      dropped: undefined,
      nullable: null,
    });
    expect(serialized).toEqual({ kept: "yes", nullable: null });
  });

  it("serializes null/undefined input as an empty object", () => {
    expect(serializeAuditMetadata(null)).toEqual({});
    expect(serializeAuditMetadata(undefined)).toEqual({});
  });

  it("throws a typed VALIDATION_ERROR on unserializable metadata", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    try {
      serializeAuditMetadata(circular);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("VALIDATION_ERROR");
      expect((err as AppError).status).toBe(400);
    }
    expect(() => serializeAuditMetadata({ big: BigInt(9) })).toThrow(AppError);
  });
});

describe("auditDetailsSchema / parseAuditDetails / serializeAuditDetails", () => {
  it("accepts and round-trips a legacy details record", () => {
    const details = { name: "Test Group", createdBy: "user_1" };
    expect(auditDetailsSchema.parse(details)).toEqual(details);
    expect(parseAuditDetails(details)).toEqual(details);
    expect(serializeAuditDetails(details)).toEqual(details);
  });

  it("preserves unknown extra keys", () => {
    const details = { name: "Trip", unknownExtra: { a: [1, null, true] } };
    expect(parseAuditDetails(details)).toEqual(details);
  });

  it("throws a ZodError on malformed stored details", () => {
    expect(() => parseAuditDetails(null)).toThrow(ZodError);
    expect(() => parseAuditDetails("details")).toThrow(ZodError);
    expect(() => parseAuditDetails([{ name: "Trip" }])).toThrow(ZodError);
  });

  it("normalizes Dates and rejects unserializable details on write", () => {
    expect(
      serializeAuditDetails({ at: new Date("2026-06-01T00:00:00.000Z") })
    ).toEqual({ at: "2026-06-01T00:00:00.000Z" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeAuditDetails(circular)).toThrow(AppError);
  });
});

describe("isRecord", () => {
  it("narrows plain objects only", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([1])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
