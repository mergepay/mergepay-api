/**
 * Simple in-memory circuit breaker for anchor providers.
 *
 * State is per-process; for multi-process deployments a shared store would
 * be needed, but a single-process circuit still protects the local process
 * and is better than nothing. The circuit opens after repeated consecutive
 * failures and closes after a cooldown or a single successful probe.
 */
export type CircuitState = "closed" | "open" | "half-open";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface ProviderCircuit {
  readonly provider: string;
  state: CircuitState;
  failures: number;
  openedAt: number | null;
  lastFailureAt: number | null;
}

export class AnchorCircuitBreaker {
  private readonly circuits = new Map<string, ProviderCircuit>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(opts?: { failureThreshold?: number; cooldownMs?: number; clock?: () => number }) {
    this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = opts?.clock ?? (() => Date.now());
  }

  get(provider: string): ProviderCircuit {
    const existing = this.circuits.get(provider);
    if (existing) return existing;
    const created: ProviderCircuit = {
      provider,
      state: "closed",
      failures: 0,
      openedAt: null,
      lastFailureAt: null,
    };
    this.circuits.set(provider, created);
    return created;
  }

  /** Mark a failure for the provider. Returns true if the circuit just opened. */
  recordFailure(provider: string): boolean {
    const circuit = this.get(provider);
    const updated: ProviderCircuit = {
      provider: circuit.provider,
      state: circuit.state,
      failures: circuit.failures + 1,
      openedAt: circuit.openedAt,
      lastFailureAt: this.clock(),
    };
    if (updated.failures >= this.failureThreshold && circuit.state === "closed") {
      updated.state = "open";
      updated.openedAt = updated.lastFailureAt;
      this.circuits.set(provider, updated);
      return true;
    }
    this.circuits.set(provider, updated);
    return false;
  }

  /** Mark a successful interaction; closes an open/half-open circuit. */
  recordSuccess(provider: string): void {
    const circuit = this.get(provider);
    if (circuit.state !== "closed") {
      this.circuits.set(provider, {
        provider: circuit.provider,
        state: "closed",
        failures: 0,
        openedAt: null,
        lastFailureAt: null,
      });
    }
  }

  /** Whether the provider is currently blocked. */
  isOpen(provider: string): boolean {
    const circuit = this.get(provider);
    if (circuit.state === "closed") return false;
    if (circuit.state === "half-open") return false;

    // Open: check cooldown
    if (!circuit.openedAt) return false;
    const elapsed = this.clock() - circuit.openedAt;
    if (elapsed >= this.cooldownMs) {
      // Transition to half-open on expiry
      this.circuits.set(provider, {
        provider: circuit.provider,
        state: "half-open",
        failures: circuit.failures,
        openedAt: circuit.openedAt,
        lastFailureAt: circuit.lastFailureAt,
      });
      return false;
    }
    return true;
  }

  reset(provider: string): void {
    const circuit = this.get(provider);
    this.circuits.set(provider, {
      provider: circuit.provider,
      state: "closed",
      failures: 0,
      openedAt: null,
      lastFailureAt: null,
    });
  }
}

export const anchorCircuit = new AnchorCircuitBreaker();