// Plan-001 PR #1 sanity test — proves Vitest is wired and exercises the runtime.
//
// "Trivial sanity check that Vitest is wired" per docs/plans/001-shared-session-core.md
// § PR #1 — Workspace Bootstrap (Test And Verification Plan).
//
// We deliberately exercise vi.fn (mock factory + invocation tracking) plus an async
// assertion so the test path touches the parts of Vitest that PR #2's contract tests
// will rely on, rather than being a constant equality check the test runner can short-
// circuit.
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
