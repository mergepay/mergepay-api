import { describe, it, expect } from "vitest";
import {
  formatStellarAmount,
  formatStellarAmountHuman,
  parseStellarAmount,
  isValidStellarAmount,
  addStellarAmounts,
  subtractStellarAmounts,
  compareStellarAmounts,
} from "../../src/utils/stellar-amount";

describe("formatStellarAmount (wire format - exactly 7dp)", () => {
  it("formats whole numbers with 7 decimal places", () => {
    expect(formatStellarAmount("100")).toBe("100.0000000");
    expect(formatStellarAmount("0")).toBe("0.0000000");
    expect(formatStellarAmount("1")).toBe("1.0000000");
  });

  it("formats fractional amounts with 7 decimal places", () => {
    expect(formatStellarAmount("10.5")).toBe("10.5000000");
    expect(formatStellarAmount("0.0000001")).toBe("0.0000001");
    expect(formatStellarAmount("123.456789")).toBe("123.4567890");
  });

  it("accepts BigInt stroops directly", () => {
    expect(formatStellarAmount(1000000000n)).toBe("100.0000000");
    expect(formatStellarAmount(1n)).toBe("0.0000001");
    expect(formatStellarAmount(10500000n)).toBe("1.0500000");
  });

  it("accepts number stroops directly", () => {
    expect(formatStellarAmount(1000000000)).toBe("100.0000000");
    expect(formatStellarAmount(1)).toBe("0.0000001");
  });

  it("throws on invalid decimal string", () => {
    expect(() => formatStellarAmount("not-a-number")).toThrow();
    expect(() => formatStellarAmount("-10")).toThrow();
    expect(() => formatStellarAmount("1.12345678")).toThrow(); // 8dp
  });

  it("throws on out of range values", () => {
    expect(() => formatStellarAmount("922337203685.4775808")).toThrow(); // > MAX
    expect(() => formatStellarAmount(-1n)).toThrow();
    expect(() => formatStellarAmount(-1)).toThrow();
  });

  it("throws on non-safe-integer number", () => {
    expect(() => formatStellarAmount(1.5)).toThrow();
    expect(() => formatStellarAmount(9007199254740993)).toThrow(); // > MAX_SAFE_INTEGER
  });
});

describe("formatStellarAmountHuman (human-readable, trimmed)", () => {
  it("formats whole numbers without decimal places", () => {
    expect(formatStellarAmountHuman("100")).toBe("100");
    expect(formatStellarAmountHuman("0")).toBe("0");
    expect(formatStellarAmountHuman("1")).toBe("1");
  });

  it("formats fractional amounts with trimmed trailing zeros", () => {
    expect(formatStellarAmountHuman("10.5")).toBe("10.5");
    expect(formatStellarAmountHuman("10.5000000")).toBe("10.5");
    expect(formatStellarAmountHuman("0.0000001")).toBe("0.0000001");
    expect(formatStellarAmountHuman("123.456789")).toBe("123.456789");
  });

  it("accepts BigInt stroops directly", () => {
    expect(formatStellarAmountHuman(1000000000n)).toBe("100");
    expect(formatStellarAmountHuman(1n)).toBe("0.0000001");
    expect(formatStellarAmountHuman(10500000n)).toBe("1.05");
  });

  it("accepts number stroops directly", () => {
    expect(formatStellarAmountHuman(1000000000)).toBe("100");
    expect(formatStellarAmountHuman(1)).toBe("0.0000001");
  });

  it("throws on invalid inputs", () => {
    expect(() => formatStellarAmountHuman("not-a-number")).toThrow();
    expect(() => formatStellarAmountHuman("-10")).toThrow();
  });
});

describe("parseStellarAmount", () => {
  it("parses whole numbers to stroops", () => {
    expect(parseStellarAmount("100")).toBe(1000000000n);
    expect(parseStellarAmount("0")).toBe(0n);
  });

  it("parses fractional amounts to stroops", () => {
    expect(parseStellarAmount("10.5")).toBe(105000000n);
    expect(parseStellarAmount("0.0000001")).toBe(1n);
    expect(parseStellarAmount("123.456789")).toBe(1234567890n);
  });

  it("throws on invalid inputs", () => {
    expect(() => parseStellarAmount("not-a-number")).toThrow();
    expect(() => parseStellarAmount("-10")).toThrow();
    expect(() => parseStellarAmount("1.12345678")).toThrow();
  });
});

describe("isValidStellarAmount", () => {
  it("returns true for valid amounts", () => {
    expect(isValidStellarAmount("100")).toBe(true);
    expect(isValidStellarAmount("10.5")).toBe(true);
    expect(isValidStellarAmount("0.0000001")).toBe(true);
    expect(isValidStellarAmount(1000000000n)).toBe(true);
    expect(isValidStellarAmount(1000000000)).toBe(true);
  });

  it("returns false for invalid amounts", () => {
    expect(isValidStellarAmount("not-a-number")).toBe(false);
    expect(isValidStellarAmount("-10")).toBe(false);
    expect(isValidStellarAmount("1.12345678")).toBe(false);
    expect(isValidStellarAmount(-1n)).toBe(false);
    expect(isValidStellarAmount(1.5)).toBe(false);
  });
});

describe("addStellarAmounts", () => {
  it("adds whole numbers", () => {
    expect(addStellarAmounts("10", "20")).toBe("30");
    expect(addStellarAmounts(100000000n, 200000000n)).toBe("30");
  });

  it("adds fractional amounts", () => {
    expect(addStellarAmounts("10.5", "20.25")).toBe("30.75");
    expect(addStellarAmounts("0.0000001", "0.0000002")).toBe("0.0000003");
  });

  it("throws on overflow", () => {
    expect(() => addStellarAmounts("922337203685.4775807", "1")).toThrow();
  });
});

describe("subtractStellarAmounts", () => {
  it("subtracts whole numbers", () => {
    expect(subtractStellarAmounts("30", "10")).toBe("20");
  });

  it("subtracts fractional amounts", () => {
    expect(subtractStellarAmounts("30.75", "20.25")).toBe("10.5");
  });

  it("throws on negative result", () => {
    expect(() => subtractStellarAmounts("10", "20")).toThrow("Amount cannot be negative");
  });
});

describe("compareStellarAmounts", () => {
  it("returns 0 for equal amounts", () => {
    expect(compareStellarAmounts("100", "100")).toBe(0);
    expect(compareStellarAmounts("10.5", "10.5000000")).toBe(0);
  });

  it("returns -1 when left < right", () => {
    expect(compareStellarAmounts("10", "20")).toBe(-1);
    expect(compareStellarAmounts("10.5", "10.6")).toBe(-1);
  });

  it("returns 1 when left > right", () => {
    expect(compareStellarAmounts("20", "10")).toBe(1);
    expect(compareStellarAmounts("10.6", "10.5")).toBe(1);
  });
});