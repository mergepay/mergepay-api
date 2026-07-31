/**
 * Tests for treasury signer validation service.
 */

import { describe, it, expect } from "vitest";
import {
  isValidStellarPublicKey,
  isValidSignerWeight,
  isValidThreshold,
  hasDuplicateSigners,
  canSatisfyThreshold,
  validateProposedSignerConfig,
  validateSignerChangeAgainstAccount,
  snapshotToSignerConfig,
  type ProposedSignerConfig,
} from "../src/services/treasury-validation";
import { Errors } from "../src/errors";

describe("treasury-validation", () => {
  describe("isValidStellarPublicKey", () => {
    it("rejects invalid public keys", () => {
      expect(isValidStellarPublicKey("invalid")).toBe(false);
      expect(isValidStellarPublicKey("")).toBe(false);
      expect(isValidStellarPublicKey("too-short")).toBe(false);
    });
  });

  describe("isValidSignerWeight", () => {
    it("accepts valid weights", () => {
      expect(isValidSignerWeight(0)).toBe(true);
      expect(isValidSignerWeight(1)).toBe(true);
      expect(isValidSignerWeight(100)).toBe(true);
      expect(isValidSignerWeight(255)).toBe(true);
    });

    it("rejects invalid weights", () => {
      expect(isValidSignerWeight(-1)).toBe(false);
      expect(isValidSignerWeight(256)).toBe(false);
      expect(isValidSignerWeight(1.5)).toBe(false);
    });
  });

  describe("isValidThreshold", () => {
    it("accepts valid thresholds", () => {
      expect(isValidThreshold(0)).toBe(true);
      expect(isValidThreshold(1)).toBe(true);
      expect(isValidThreshold(100)).toBe(true);
      expect(isValidThreshold(255)).toBe(true);
    });

    it("rejects invalid thresholds", () => {
      expect(isValidThreshold(-1)).toBe(false);
      expect(isValidThreshold(256)).toBe(false);
      expect(isValidThreshold(1.5)).toBe(false);
    });
  });

  describe("hasDuplicateSigners", () => {
    it("detects duplicate public keys", () => {
      const signers = [
        { publicKey: "KEY1", weight: 1 },
        { publicKey: "KEY1", weight: 2 },
      ];
      expect(hasDuplicateSigners(signers)).toBe(true);
    });

    it("returns false for unique signers", () => {
      const signers = [
        { publicKey: "KEY1", weight: 1 },
        { publicKey: "KEY2", weight: 2 },
      ];
      expect(hasDuplicateSigners(signers)).toBe(false);
    });
  });

  describe("canSatisfyThreshold", () => {
    it("returns true when total weight meets threshold", () => {
      const config: ProposedSignerConfig = {
        signers: [
          { publicKey: "KEY1", weight: 3 },
          { publicKey: "KEY2", weight: 2 },
        ],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      expect(canSatisfyThreshold(config)).toBe(true);
    });

    it("returns false when total weight insufficient", () => {
      const config: ProposedSignerConfig = {
        signers: [
          { publicKey: "KEY1", weight: 1 },
          { publicKey: "KEY2", weight: 1 },
        ],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      expect(canSatisfyThreshold(config)).toBe(false);
    });
  });

  describe("validateProposedSignerConfig", () => {
    it("validates a correct configuration (without key validation)", () => {
      const config: ProposedSignerConfig = {
        signers: [
          { publicKey: "KEY1", weight: 3 },
          { publicKey: "KEY2", weight: 2 },
        ],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const result = validateProposedSignerConfig(config);
      // Will fail key validation but should pass other checks
      expect(result.errors).toContain("Invalid Stellar public key: KEY1");
    });

    it("rejects invalid weights", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 256 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const result = validateProposedSignerConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("Invalid weight"))).toBe(true);
    });

    it("rejects duplicate signers", () => {
      const config: ProposedSignerConfig = {
        signers: [
          { publicKey: "KEY1", weight: 1 },
          { publicKey: "KEY1", weight: 2 },
        ],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const result = validateProposedSignerConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Duplicate public keys in signer list");
    });

    it("rejects invalid threshold hierarchy", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 5 }],
        thresholds: { low: 5, med: 2, high: 1 },
      };
      const result = validateProposedSignerConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Low threshold cannot exceed medium threshold");
    });

    it("rejects insufficient signer weights", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 1 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const result = validateProposedSignerConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Signer weights insufficient to satisfy high threshold");
    });
  });

  describe("validateSignerChangeAgainstAccount", () => {
    it("throws for unfunded accounts", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 1 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const snapshot = {
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      };

      expect(() => validateSignerChangeAgainstAccount(config, snapshot)).toThrow(
        "Treasury account does not exist on-chain"
      );
    });

    it("throws for invalid configuration", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "invalid", weight: 1 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const snapshot = {
        exists: true,
        sequence: "123456",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      };

      expect(() => validateSignerChangeAgainstAccount(config, snapshot)).toThrow();
    });

    it("throws for threshold mismatch", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 5 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const snapshot = {
        exists: true,
        sequence: "123456",
        balances: [],
        signers: [{ key: "KEY1", weight: 5 }],
        thresholds: { low: 1, med: 2, high: 10 },
      };

      expect(() => validateSignerChangeAgainstAccount(config, snapshot)).toThrow(
        "does not match current account threshold"
      );
    });

    it("passes for valid configuration matching account", () => {
      const config: ProposedSignerConfig = {
        signers: [{ publicKey: "KEY1", weight: 5 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };
      const snapshot = {
        exists: true,
        sequence: "123456",
        balances: [],
        signers: [{ key: "KEY1", weight: 5 }],
        thresholds: { low: 1, med: 2, high: 5 },
      };

      expect(() => validateSignerChangeAgainstAccount(config, snapshot)).not.toThrow();
    });
  });

  describe("snapshotToSignerConfig", () => {
    it("converts snapshot to signer config", () => {
      const snapshot = {
        exists: true,
        sequence: "123456",
        balances: [],
        signers: [
          { key: "KEY1", weight: 3 },
          { key: "KEY2", weight: 2 },
        ],
        thresholds: { low: 1, med: 2, high: 5 },
      };

      const config = snapshotToSignerConfig(snapshot);
      expect(config.signers).toHaveLength(2);
      expect(config.signers[0].publicKey).toBe("KEY1");
      expect(config.signers[0].weight).toBe(3);
      expect(config.thresholds).toEqual({ low: 1, med: 2, high: 5 });
    });
  });
});
