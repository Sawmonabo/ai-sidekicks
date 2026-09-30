// Proves Vitest is wired. It uses `vi.fn` (a mock factory with call tracking) and an async
// assertion, the parts of Vitest the contract tests rely on, so it is not a constant equality
// check the runner could short-circuit.
import { describe, expect, it, vi } from "vitest";

describe("workspace bootstrap sanity", () => {
  it("vitest mock factory tracks invocation count and arguments", () => {
    const recorder = vi.fn((value: number) => value * 2);

    const result = recorder(21);

    expect(result).toBe(42);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith(21);
  });

  it("vitest awaits resolved promises in async expectations", async () => {
    await expect(Promise.resolve("ready")).resolves.toBe("ready");
  });
});
