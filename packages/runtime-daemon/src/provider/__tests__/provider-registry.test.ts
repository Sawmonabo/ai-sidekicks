// ProviderRegistry — Plan-005 Phase 2 (T2.3).
//
// Exercises the in-memory registry + the capability-flag gate against a
// hand-rolled fake `ProviderDriver`. The fake implements all 10 contract ops;
// only `getCapabilities` carries behavior (a controllable `flags` record + a call
// counter), the other nine throw "not implemented in test" because no path here
// invokes them — proving the gate reads the CACHED snapshot, never the driver.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * Spec-005:41 (every provider integration implements a normalized driver
//     contract): the register + lookup round-trip keys a `ProviderDriver`
//     instance under its canonical id.
//   * Spec-005:48 + I-005-2 (runtime treats undeclared capabilities as
//     unsupported): the declared-`false` AND fail-closed undeclared-flag cases
//     both throw `driver.capability_unsupported`; a declared-`true` flag passes.
//
// Refs: Plan-005 §Phase 2 / T2.3, Spec-005 lines 41 + 48, invariant I-005-2,
// error-contracts.md line 302 (`driver.unavailable`) + line 303
// (`driver.capability_unsupported`).

import type {
  ApplyInterventionParams,
  CloseSessionParams,
  CreateSessionParams,
  DriverCapabilities,
  DriverCapabilityFlag,
  DriverInterventionResult,
  DriverResumeResult,
  GetCapabilitiesResult,
  InterruptRunParams,
  ProviderDriver,
  ProviderModel,
  ProviderMode,
  ProviderSessionHandle,
  RespondToRequestParams,
  ResumeSessionParams,
  StartRunParams,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../provider-registry.js";

// ----------------------------------------------------------------------------
// Fixtures — a controllable fake ProviderDriver
// ----------------------------------------------------------------------------

const DRIVER_ID: string = "claude";
const OTHER_DRIVER_ID: string = "codex";

/**
 * Build a complete `Record<DriverCapabilityFlag, boolean>` from a partial
 * override. Every one of the 7 flags MUST be answered (the contract `Record` is
 * total — the structural half of I-005-2), so this defaults all to `false` and
 * lets a test flip just the flags it cares about.
 */
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  return {
    resume: false,
    steer: false,
    interactive_requests: false,
    mcp: false,
    tool_calls: false,
    reasoning_stream: false,
    model_mutation: false,
    ...overrides,
  };
}

/**
 * A minimal fake `ProviderDriver`. Only `getCapabilities` is meaningful: it
 * returns a caller-chosen `flags` record and counts its own invocations so a test
 * can assert the registry snapshots it EXACTLY ONCE. The other nine ops throw —
 * if the registry ever calls one, the test fails loudly.
 */
class FakeProviderDriver implements ProviderDriver {
  public getCapabilitiesCallCount: number = 0;
  #flags: Record<DriverCapabilityFlag, boolean>;
  readonly #contractVersion: string;

  constructor(flags: Record<DriverCapabilityFlag, boolean>, contractVersion: string = "1.0.0") {
    this.#flags = flags;
    this.#contractVersion = contractVersion;
  }

  /** Repoint the flags the NEXT `getCapabilities()` will report (used to prove a
   *  re-register snapshots the new value). */
  setFlags(flags: Record<DriverCapabilityFlag, boolean>): void {
    this.#flags = flags;
  }

  getCapabilities(): Promise<GetCapabilitiesResult> {
    this.getCapabilitiesCallCount += 1;
    const capabilities: DriverCapabilities = {
      flags: this.#flags,
      contractVersion: this.#contractVersion,
    };
    return Promise.resolve({ capabilities, tools: [] });
  }

  // The remaining nine ops are never exercised here — the gate reads the cached
  // snapshot, not the live driver — so they throw to catch any accidental call.
  createSession(_params: CreateSessionParams): Promise<ProviderSessionHandle> {
    throw new Error("not implemented in test");
  }
  resumeSession(_params: ResumeSessionParams): Promise<DriverResumeResult> {
    throw new Error("not implemented in test");
  }
  startRun(_params: StartRunParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  interruptRun(_params: InterruptRunParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  applyIntervention(_params: ApplyInterventionParams): Promise<DriverInterventionResult> {
    throw new Error("not implemented in test");
  }
  respondToRequest(_params: RespondToRequestParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  closeSession(_params: CloseSessionParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  listModels(): Promise<ProviderModel[]> {
    throw new Error("not implemented in test");
  }
  listModes(): Promise<ProviderMode[]> {
    throw new Error("not implemented in test");
  }
}

/**
 * A fake whose `getCapabilities()` REJECTS — used to pin `register()`'s
 * no-half-write guarantee: because `register` `await`s `getCapabilities()`
 * BEFORE the synchronous `#drivers.set(...)`, a rejection must propagate and the
 * Map must never be written. Otherwise identical to `FakeProviderDriver`.
 */
class RejectingProviderDriver extends FakeProviderDriver {
  override getCapabilities(): Promise<GetCapabilitiesResult> {
    return Promise.reject(new Error("getCapabilities failed in test"));
  }
}

// ----------------------------------------------------------------------------
// register + lookup — Spec-005:41 (normalized contract keyed by id)
// ----------------------------------------------------------------------------

describe("ProviderRegistry — register + lookup (Spec-005:41)", () => {
  it("round-trips a registered driver via lookup", async () => {
    const registry = new ProviderRegistry();
    const driver = new FakeProviderDriver(makeFlags());

    await registry.register(DRIVER_ID, driver);

    expect(registry.lookup(DRIVER_ID)).toBe(driver);
  });

  it("returns undefined for an unregistered id (non-throwing accessor)", () => {
    const registry = new ProviderRegistry();

    expect(registry.lookup("never-registered")).toBeUndefined();
  });

  it("snapshots getCapabilities() exactly once — the gate reads the cache, not the driver", async () => {
    const registry = new ProviderRegistry();
    const driver = new FakeProviderDriver(makeFlags({ steer: true }));

    await registry.register(DRIVER_ID, driver);
    // Several gate calls AFTER registration must NOT re-invoke the driver.
    registry.checkCapability(DRIVER_ID, "steer");
    registry.checkCapability(DRIVER_ID, "steer");
    registry.checkCapability(DRIVER_ID, "steer");

    expect(driver.getCapabilitiesCallCount).toBe(1);
  });

  it("propagates a getCapabilities() rejection and leaves NO half-written entry", async () => {
    const registry = new ProviderRegistry();
    const rejectingDriver = new RejectingProviderDriver(makeFlags());

    // The rejection must propagate to the caller — `register` does not swallow it.
    await expect(registry.register(DRIVER_ID, rejectingDriver)).rejects.toThrow(
      "getCapabilities failed in test",
    );

    // And the registry must be in a clean state: because the `await` precedes the
    // synchronous `#drivers.set(...)`, a rejection means the Map was never
    // written — no half-write, no torn entry. (A future refactor moving the `set`
    // before the await, or wrapping the body in a swallowing try, regresses this.)
    expect(registry.lookup(DRIVER_ID)).toBeUndefined();
    expect(registry.listAvailable()).not.toContain(DRIVER_ID);
  });
});

// ----------------------------------------------------------------------------
// checkCapability — Spec-005:48 + I-005-2 (undeclared capability = unsupported)
// ----------------------------------------------------------------------------

describe("ProviderRegistry — checkCapability gate (Spec-005:48, I-005-2)", () => {
  it("passes (returns void, does not throw) for a flag declared true", async () => {
    const registry = new ProviderRegistry();
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ tool_calls: true })));

    expect(registry.checkCapability(DRIVER_ID, "tool_calls")).toBeUndefined();
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
  });

  it("rejects a flag declared false with driver.capability_unsupported (I-005-2)", async () => {
    const registry = new ProviderRegistry();
    // `steer: false` is the explicit "declared, but not supported" case.
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ steer: false })));

    expect(() => registry.checkCapability(DRIVER_ID, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
    try {
      registry.checkCapability(DRIVER_ID, "steer");
      expect.unreachable("checkCapability should have thrown for a declared-false flag");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      expect((error as DriverCapabilityUnsupportedError).fields).toEqual({
        driverId: DRIVER_ID,
        flag: "steer",
      });
    }
  });

  it("FAIL-CLOSED: rejects an undeclared/bogus flag (cached value undefined) with driver.capability_unsupported (I-005-2)", async () => {
    const registry = new ProviderRegistry();
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ tool_calls: true })));

    // A flag that is NOT in the cached `flags` record resolves to `undefined`.
    // The gate tests `!== true`, so `undefined` is rejected exactly like
    // `false`. The cast manufactures the untyped-boundary scenario the total
    // `Record<DriverCapabilityFlag, boolean>` type otherwise prevents.
    const bogusFlag = "not_a_real_flag" as DriverCapabilityFlag;

    expect(() => registry.checkCapability(DRIVER_ID, bogusFlag)).toThrow(
      DriverCapabilityUnsupportedError,
    );
    // Symmetry with the declared-false / unregistered cases: pin `.code` and
    // confirm the bogus flag is threaded into `fields` on the undefined-value
    // path exactly as it is on the declared-false path.
    try {
      registry.checkCapability(DRIVER_ID, bogusFlag);
      expect.unreachable("checkCapability should have thrown for a bogus/undeclared flag");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
      expect((error as DriverCapabilityUnsupportedError).fields).toEqual({
        driverId: DRIVER_ID,
        flag: bogusFlag,
      });
    }
  });

  it("rejects a check against an unregistered driver with driver.unavailable", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.checkCapability("never-registered", "steer")).toThrow(
      DriverUnavailableError,
    );
    try {
      registry.checkCapability("never-registered", "steer");
      expect.unreachable("checkCapability should have thrown for an unregistered driver");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverUnavailableError);
      expect((error as DriverUnavailableError).code).toBe("driver.unavailable");
      expect((error as DriverUnavailableError).fields).toEqual({ driverId: "never-registered" });
    }
  });
});

// ----------------------------------------------------------------------------
// re-register (idempotent upsert) + listAvailable
// ----------------------------------------------------------------------------

describe("ProviderRegistry — re-register refresh seam + listAvailable", () => {
  it("re-registering an id overwrites the cached capability snapshot", async () => {
    const registry = new ProviderRegistry();
    // First registration: steer supported, tool_calls not.
    const driver = new FakeProviderDriver(makeFlags({ steer: true }));
    await registry.register(DRIVER_ID, driver);
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // Refresh: flip the flags and re-register the SAME id.
    driver.setFlags(makeFlags({ tool_calls: true }));
    await registry.register(DRIVER_ID, driver);

    // The gate now reflects the refreshed snapshot (B), not the original (A).
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
  });

  it("lists registered ids, with a re-registered id appearing exactly once", async () => {
    const registry = new ProviderRegistry();
    expect(registry.listAvailable()).toEqual([]);

    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags()));
    await registry.register(OTHER_DRIVER_ID, new FakeProviderDriver(makeFlags()));
    // Re-register an existing id — must NOT create a duplicate entry.
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags()));

    const available = registry.listAvailable();
    expect([...available].sort()).toEqual([OTHER_DRIVER_ID, DRIVER_ID].sort());
    expect(available).toHaveLength(2);
  });
});
