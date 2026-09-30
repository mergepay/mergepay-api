/**
 * Issue #424 — currency validation on the group create/update schemas.
 *
 * The shared schemas in `src/schemas/groups.ts` already cover the group create
 * and update payloads and validate the currency code against the supported
 * Stellar assets (XLM/USDC). This suite pins that contract, and the one gap it
 * closes: the currency setting can be declared through three aliases
 * (`currency`, `currencyType`, `defaultCurrency`), and a body that supplies
 * two of them with different values was accepted even though only one could be
 * honoured. Such a payload is now a validation error, matching the strict
 * schemas' rule that a request which cannot be honoured as written is a 400.
 *
 * Schema-level only — no app, database, or network — so it is deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
} from "../src/schemas/groups";

describe("supported group currencies (#424)", () => {
  it("supports exactly XLM and USDC", () => {
    expect(GROUP_CURRENCIES).toEqual(["XLM", "USDC"]);
  });

  it.each(["XLM", "USDC"])("accepts the supported currency %s", (code) => {
    expect(groupCurrencySchema.safeParse(code).success).toBe(true);
  });

  it("rejects codes outside the supported set", () => {
    for (const code of ["EUR", "usdc", "xlm", "", "BTC"]) {
      expect(groupCurrencySchema.safeParse(code).success).toBe(false);
    }
  });
});

describe("createGroupSchema currency field (#424)", () => {
  it.each(["currency", "currencyType", "defaultCurrency"] as const)(
    "accepts XLM and USDC through the %s alias",
    (field) => {
      for (const code of ["XLM", "USDC"]) {
        expect(
          createGroupSchema.safeParse({ name: "Trip", [field]: code }).success
        ).toBe(true);
      }
    }
  );

  it("rejects an unsupported currency code", () => {
    const res = createGroupSchema.safeParse({ name: "Trip", currency: "EUR" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toContain("Currency must be XLM or USDC");
    }
  });

  it("rejects contradictory currency aliases", () => {
    const res = createGroupSchema.safeParse({
      name: "Trip",
      currency: "XLM",
      currencyType: "USDC",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].message).toMatch(/must agree/);
    }
  });

  it("accepts aliases that agree", () => {
    expect(
      createGroupSchema.safeParse({
        name: "Trip",
        currency: "USDC",
        currencyType: "USDC",
        defaultCurrency: "USDC",
      }).success
    ).toBe(true);
  });
});

describe("updateGroupSchema currency field (#424)", () => {
  it.each(["currency", "currencyType", "defaultCurrency"] as const)(
    "accepts XLM and USDC through the %s alias",
    (field) => {
      for (const code of ["XLM", "USDC"]) {
        expect(updateGroupSchema.safeParse({ [field]: code }).success).toBe(true);
      }
    }
  );

  it("rejects an unsupported currency code", () => {
    expect(updateGroupSchema.safeParse({ currency: "GBP" }).success).toBe(false);
  });

  it("rejects contradictory currency aliases", () => {
    expect(
      updateGroupSchema.safeParse({ currency: "XLM", defaultCurrency: "USDC" }).success
    ).toBe(false);
    expect(
      updateGroupSchema.safeParse({ currencyType: "USDC", defaultCurrency: "XLM" }).success
    ).toBe(false);
  });

  it("accepts aliases that agree", () => {
    expect(
      updateGroupSchema.safeParse({ currency: "XLM", currencyType: "XLM" }).success
    ).toBe(true);
  });
});
