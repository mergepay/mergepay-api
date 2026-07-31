import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  CONFIRM_POLL_MAX_ATTEMPTS: 3,
  CONFIRM_POLL_DELAY_MS: 100,
}));

vi.mock("../src/config", () => ({
  config: {
    CONFIRM_POLL_MAX_ATTEMPTS: h.CONFIRM_POLL_MAX_ATTEMPTS,
    CONFIRM_POLL_DELAY_MS: h.CONFIRM_POLL_DELAY_MS,
  },
}));

import { pollForConfirmation } from "../src/services/horizon-confirm";
import type { HorizonConfirmDeps } from "../src/services/horizon-confirm";

function makeDeps(getTransaction?: HorizonConfirmDeps["getTransaction"]): HorizonConfirmDeps {
  return {
    getTransaction: getTransaction ?? vi.fn<HorizonConfirmDeps["getTransaction"]>(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

function advanceTimers(): Promise<void> {
  return vi.runAllTimersAsync();
}

describe("pollForConfirmation", () => {
  it("returns confirmed when transaction is successful on first attempt", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi.fn().mockResolvedValue({ successful: true });

    const result = await pollForConfirmation("hash_abc", deps);

    expect(result).toEqual({ status: "confirmed", successful: true });
    expect(deps.getTransaction).toHaveBeenCalledWith("hash_abc");
    expect(deps.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns failed when Horizon reports unsuccessful transaction", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi.fn().mockResolvedValue({ successful: false });

    const result = await pollForConfirmation("hash_bad", deps);

    expect(result).toEqual({ status: "failed", successful: false });
    expect(deps.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("retries when transaction is not yet visible and returns confirmed once found", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ successful: true });

    const promise = pollForConfirmation("hash_late", deps);
    await advanceTimers();
    const result = await promise;

    expect(result).toEqual({ status: "confirmed", successful: true });
    expect(deps.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("returns not_found when transaction never appears within max attempts", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi.fn().mockResolvedValue(null);

    const promise = pollForConfirmation("hash_ghost", deps);
    await advanceTimers();
    const result = await promise;

    expect(result).toEqual({ status: "not_found" });
    expect(deps.getTransaction).toHaveBeenCalledTimes(h.CONFIRM_POLL_MAX_ATTEMPTS);
  });

  it("returns timeout when getTransaction throws on every attempt", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi.fn().mockRejectedValue(new Error("Horizon unavailable"));

    const promise = pollForConfirmation("hash_down", deps);
    await advanceTimers();
    const result = await promise;

    expect(result).toEqual({ status: "timeout" });
    expect(deps.getTransaction).toHaveBeenCalledTimes(h.CONFIRM_POLL_MAX_ATTEMPTS);
  });

  it("recovers from a transport error and returns confirmed", async () => {
    const deps = makeDeps();
    deps.getTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ successful: true });

    const promise = pollForConfirmation("hash_recovered", deps);
    await advanceTimers();
    const result = await promise;

    expect(result).toEqual({ status: "confirmed", successful: true });
    expect(deps.getTransaction).toHaveBeenCalledTimes(2);
  });

  it("accepts a custom getTransaction via deps", async () => {
    const customGetTx = vi.fn().mockResolvedValue({ successful: true });
    const result = await pollForConfirmation("hash_custom", {
      getTransaction: customGetTx,
    });

    expect(result).toEqual({ status: "confirmed", successful: true });
    expect(customGetTx).toHaveBeenCalledWith("hash_custom");
  });
});
