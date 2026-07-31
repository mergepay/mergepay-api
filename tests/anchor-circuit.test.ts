import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnchorCircuitBreaker, anchorCircuit, type ProviderCircuit } from "../src/services/anchor-circuit";

describe("AnchorCircuitBreaker", () => {
  let breaker: AnchorCircuitBreaker;
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 1000 };
    breaker = new AnchorCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 5_000,
      clock: () => clock.now,
    });
  });

  it("starts closed and reports circuit state", () => {
    const circuit = breaker.get("anchor-a");
    expect(circuit.state).toBe("closed");
    expect(circuit.failures).toBe(0);
    expect(circuit.openedAt).toBeNull();
  });

  it("opens after threshold failures", () => {
    expect(breaker.recordFailure("anchor-a")).toBe(false);
    expect(breaker.recordFailure("anchor-a")).toBe(false);
    expect(breaker.recordFailure("anchor-a")).toBe(true);
    expect(breaker.isOpen("anchor-a")).toBe(true);
  });

  it("is not open before threshold", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(false);
  });

  it("closes on success", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(true);
    breaker.recordSuccess("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(false);
    const circuit = breaker.get("anchor-a");
    expect(circuit.failures).toBe(0);
    expect(circuit.state).toBe("closed");
  });

  it("transitions to half-open after cooldown", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(true);

    clock.now += 5_001;
    expect(breaker.isOpen("anchor-a")).toBe(false);
    const circuit = breaker.get("anchor-a");
    expect(circuit.state).toBe("half-open");
  });

  it("allows probing in half-open and closes on success", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    clock.now += 5_001;
    expect(breaker.isOpen("anchor-a")).toBe(false);

    breaker.recordSuccess("anchor-a");
    expect(breaker.get("anchor-a").state).toBe("closed");
  });

  it("isolates providers", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(true);
    expect(breaker.isOpen("anchor-b")).toBe(false);
  });

  it("supports manual reset", () => {
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    breaker.recordFailure("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(true);
    breaker.reset("anchor-a");
    expect(breaker.isOpen("anchor-a")).toBe(false);
    expect(breaker.get("anchor-a").failures).toBe(0);
  });
});