// ProviderRegistry and its capability-flag gate, tested against a hand-rolled fake
// `ProviderDriver`.
// The fake implements all 18 contract operations, but only `getCapabilities` has behavior (a
// controllable flags record and a call counter); the other seventeen throw, which proves the gate
// reads the cached snapshot and never the driver.
//
//   * `register` and `lookup` round-trip a driver under its id.
//   * A declared-false flag and an undeclared flag both throw `driver.capability_unsupported`
//     (fail-closed); a declared-true flag passes.
//   * A refused capability check leaves the driver's operation call count at zero.

import {
  DRIVER_CAPABILITY_FLAGS,
  type ApplyInterventionParams,
  type ClearSessionGoalParams,
  type CloseSessionParams,
  type CompactContextParams,
  type CreateSessionParams,
  type DriverAuthProbeResult,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type DriverCompactionResult,
  type DriverInterventionResult,
  type DriverResumeResult,
  type ForkConversationResult,
  type DriverTranscriptExportResult,
  type DriverTranscriptReplayResult,
  type ExportTranscriptParams,
  type GetCapabilitiesResult,
  type InterruptRunParams,
  type ListProviderCommandsParams,
  type ProviderCommandListResult,
  type ProviderDriver,
  type ProviderModel,
  type ProviderMode,
  type ProviderSessionHandle,
  type RespondToRequestParams,
  type ReplayTranscriptParams,
  type ResumeSessionParams,
  type ForkConversationParams,
  type SetSessionGoalParams,
  type StartRunParams,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../provider-registry.js";

// ----------------------------------------------------------------------------
// Fixtures: a controllable fake ProviderDriver
// ----------------------------------------------------------------------------

const DRIVER_ID: string = "claude";
const OTHER_DRIVER_ID: string = "codex";

/**
 * Builds a complete flag record from a partial override, defaulting every flag to false. The base
 * is derived from `DRIVER_CAPABILITY_FLAGS` so widening the flag union leaves no stale copy here.
 */
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, ...overrides };
}

/**
 * A well-formed `cliVersion` reading, required on `GetCapabilitiesResult`. The registry caches
 * only `result.capabilities`, so no assertion reads it; it keeps the fakes contract-valid without
 * a cast.
 */
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

/**
 * A minimal fake `ProviderDriver`. Only `getCapabilities` works: it reports a caller-chosen flags
 * record and counts its calls so a test can assert the registry snapshots it exactly once. The
 * other seventeen operations throw, so any call to one fails the test loudly.
 */
class FakeProviderDriver implements ProviderDriver {
  public getCapabilitiesCallCount: number = 0;
  #flags: Record<DriverCapabilityFlag, boolean>;
  readonly #contractVersion: string;

  constructor(flags: Record<DriverCapabilityFlag, boolean>, contractVersion: string = "1.0.0") {
    this.#flags = flags;
    this.#contractVersion = contractVersion;
  }

  /** Sets the flags the next `getCapabilities()` reports, to prove a re-register re-snapshots. */
  setFlags(flags: Record<DriverCapabilityFlag, boolean>): void {
    this.#flags = flags;
  }

  getCapabilities(): Promise<GetCapabilitiesResult> {
    this.getCapabilitiesCallCount += 1;
    const capabilities: DriverCapabilities = {
      flags: this.#flags,
      contractVersion: this.#contractVersion,
    };
    return Promise.resolve({ capabilities, tools: [], cliVersion: CLI_VERSION_REPORT });
  }

  // Never exercised: the gate reads the cached snapshot, so these throw to catch a stray call.
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
  forkConversation(_params: ForkConversationParams): Promise<ForkConversationResult> {
    throw new Error("not implemented in test");
  }
  respondToRequest(_params: RespondToRequestParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  setSessionGoal(_params: SetSessionGoalParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  clearSessionGoal(_params: ClearSessionGoalParams): Promise<void> {
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
  probeAuth(): Promise<DriverAuthProbeResult> {
    throw new Error("not implemented in test");
  }
  exportTranscript(_params: ExportTranscriptParams): Promise<DriverTranscriptExportResult> {
    throw new Error("not implemented in test");
  }
  replayTranscript(_params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult> {
    throw new Error("not implemented in test");
  }
  compactContext(_params: CompactContextParams): Promise<DriverCompactionResult> {
    throw new Error("not implemented in test");
  }
  listProviderCommands(_params: ListProviderCommandsParams): Promise<ProviderCommandListResult> {
    throw new Error("not implemented in test");
  }
}

/**
 * A fake whose `getCapabilities()` rejects. `register` awaits it before the synchronous
 * `#drivers.set(...)`, so a rejection must propagate and leave the map unwritten.
 */
class RejectingProviderDriver extends FakeProviderDriver {
  override getCapabilities(): Promise<GetCapabilitiesResult> {
    return Promise.reject(new Error("getCapabilities failed in test"));
  }
}

// ----------------------------------------------------------------------------
// Register and lookup
// ----------------------------------------------------------------------------

describe("ProviderRegistry — register + lookup", () => {
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
    // Gate calls after registration must not re-invoke the driver.
    registry.checkCapability(DRIVER_ID, "steer");
    registry.checkCapability(DRIVER_ID, "steer");
    registry.checkCapability(DRIVER_ID, "steer");

    expect(driver.getCapabilitiesCallCount).toBe(1);
  });

  it("propagates a getCapabilities() rejection and leaves NO half-written entry", async () => {
    const registry = new ProviderRegistry();
    const rejectingDriver = new RejectingProviderDriver(makeFlags());

    // The rejection propagates; `register` does not swallow it.
    await expect(registry.register(DRIVER_ID, rejectingDriver)).rejects.toThrow(
      "getCapabilities failed in test",
    );

    // The await precedes the synchronous `#drivers.set(...)`, so the map was never written. A
    // refactor that moves the set before the await, or swallows the error, regresses this.
    expect(registry.lookup(DRIVER_ID)).toBeUndefined();
    expect(registry.listAvailable()).not.toContain(DRIVER_ID);
  });
});

// ----------------------------------------------------------------------------
// checkCapability gate
// ----------------------------------------------------------------------------

describe("ProviderRegistry — checkCapability gate", () => {
  it("passes (returns void, does not throw) for a flag declared true", async () => {
    const registry = new ProviderRegistry();
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ tool_calls: true })));

    expect(registry.checkCapability(DRIVER_ID, "tool_calls")).toBeUndefined();
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
  });

  it("rejects a flag declared false with driver.capability_unsupported", async () => {
    const registry = new ProviderRegistry();
    // `steer: false` is the explicit declared-but-unsupported case.
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

  it("FAIL-CLOSED: rejects an undeclared/bogus flag (cached value undefined) with driver.capability_unsupported", async () => {
    const registry = new ProviderRegistry();
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ tool_calls: true })));

    // A flag missing from the cached record resolves to `undefined`. The gate tests `!== true`, so
    // it is rejected like `false`. The cast reproduces an untyped-boundary input that the total
    // `Record` type otherwise prevents.
    const bogusFlag = "not_a_real_flag" as DriverCapabilityFlag;

    expect(() => registry.checkCapability(DRIVER_ID, bogusFlag)).toThrow(
      DriverCapabilityUnsupportedError,
    );
    // Pin `.code` and check the bogus flag is threaded into `fields` as on the declared-false path.
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
// Immutable capability snapshot: register clones, never aliases
// ----------------------------------------------------------------------------

describe("ProviderRegistry — immutable capability snapshot (defensive clone)", () => {
  it("a post-register driver-side MUTATION of the flags object does NOT drift the gate", async () => {
    const registry = new ProviderRegistry();
    // The fake stores and returns `flags` by reference, so mutating it in place after register()
    // would reveal an aliasing bug.
    const mutableFlags = makeFlags({ tool_calls: true });
    await registry.register(DRIVER_ID, new FakeProviderDriver(mutableFlags));

    // The register-time snapshot supports `tool_calls`.
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();

    // Mutating the advertised object after registration must not change the cached snapshot; an
    // alias would flip the gate to unsupported.
    mutableFlags.tool_calls = false;

    // The gate still reflects the register-time snapshot.
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// Last-call-wins registration: the latest-initiated register wins whichever resolves first
// ----------------------------------------------------------------------------

/**
 * A fake whose `getCapabilities()` promise the test resolves manually, so two overlapping
 * `register()` calls can be ordered deterministically.
 */
class DeferredProviderDriver extends FakeProviderDriver {
  #resolve: ((result: GetCapabilitiesResult) => void) | undefined;
  readonly #pending: Promise<GetCapabilitiesResult>;
  readonly #flagsToReport: Record<DriverCapabilityFlag, boolean>;

  constructor(flags: Record<DriverCapabilityFlag, boolean>) {
    super(flags);
    this.#flagsToReport = flags;
    this.#pending = new Promise<GetCapabilitiesResult>((resolve) => {
      this.#resolve = resolve;
    });
  }

  override getCapabilities(): Promise<GetCapabilitiesResult> {
    return this.#pending;
  }

  /** Resolves this driver's pending `getCapabilities()` with its own flags. */
  settle(): void {
    this.#resolve?.({
      capabilities: { flags: this.#flagsToReport, contractVersion: "1.0.0" },
      tools: [],
      cliVersion: CLI_VERSION_REPORT,
    });
  }
}

describe("ProviderRegistry — last-call-wins registration race (latest-initiated wins)", () => {
  it("the LATER-initiated register wins even when its getCapabilities() resolves LAST", async () => {
    const registry = new ProviderRegistry();
    // A is initiated first (steer supported), B second (tool_calls supported).
    const driverA = new DeferredProviderDriver(makeFlags({ steer: true }));
    const driverB = new DeferredProviderDriver(makeFlags({ tool_calls: true }));

    const registerA = registry.register(DRIVER_ID, driverA);
    const registerB = registry.register(DRIVER_ID, driverB);

    // B resolves first, so the earlier-initiated A resolves last; a last-to-resolve-wins
    // implementation would install A's stale snapshot.
    driverB.settle();
    driverA.settle();
    await Promise.all([registerA, registerB]);

    // The registry holds B's snapshot: tool_calls passes and A's steer was dropped.
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
  });
});

// ----------------------------------------------------------------------------
// Re-register (idempotent upsert) and listAvailable
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

    // Refresh: flip the flags and re-register the same id.
    driver.setFlags(makeFlags({ tool_calls: true }));
    await registry.register(DRIVER_ID, driver);

    // The gate now reflects the refreshed snapshot.
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
    // Re-registering an existing id must not create a duplicate entry.
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags()));

    const available = registry.listAvailable();
    expect([...available].sort()).toEqual([OTHER_DRIVER_ID, DRIVER_ID].sort());
    expect(available).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// The capability gate refuses fail-closed and touches no driver
// ----------------------------------------------------------------------------
//
// This suite owns the gate itself: fail-closed on `!== true`, the registered dotted code, no
// driver method consulted at decision time, and refusal of an unregistered id without driver
// contact. That production dispatch runs the gate before the driver operation is asserted in the
// `driver.*` handler tests, not here.
/**
 * A fake that counts the capability-bound operations before throwing. A bare throw shows a call
 * was a mistake but not that none happened; the counter proves the gate itself dispatches nothing.
 */
class CallCountingProviderDriver extends FakeProviderDriver {
  /** Total capability-bound operation invocations across the counted operations. */
  public operationCallCount: number = 0;

  override compactContext(_params: CompactContextParams): Promise<DriverCompactionResult> {
    this.operationCallCount += 1;
    throw new Error("compactContext reached the driver — the capability gate did not refuse");
  }

  override listProviderCommands(
    _params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    this.operationCallCount += 1;
    throw new Error("listProviderCommands reached the driver — the capability gate did not refuse");
  }
}

describe("ProviderRegistry.checkCapability — fail-closed refusal", () => {
  it("refuses a declared-false flag with the registered error, consulting no driver at decision time", async () => {
    const registry = new ProviderRegistry();
    // `tool_calls` true and `context_compaction` false: the declared-false shape. The absent-flag
    // shape is the next test; separating them keeps each failure legible.
    const driver = new CallCountingProviderDriver(makeFlags({ tool_calls: true }));
    await registry.register(DRIVER_ID, driver);

    expect(() => registry.checkCapability(DRIVER_ID, "context_compaction")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // The gate dispatched nothing on its way to refusing.
    expect(driver.operationCallCount).toBe(0);
    // Nor did it consult the driver: `getCapabilities` is still at the one call `register` made.
    // A gate that asked the driver at decision time could not refuse a hung provider process
    // without first contacting it.
    expect(driver.getCapabilitiesCallCount).toBe(1);
  });

  it("refuses an UNDECLARED flag the same way — the gate keys on `!== true`, never `=== false`", async () => {
    const registry = new ProviderRegistry();
    // `context_compaction` is absent rather than false. The cast reproduces an untyped-boundary
    // input (a hand-edited cache row, a driver built against an older flag union), where a gate
    // keyed on `=== false` would silently admit the call.
    const partialFlags = { ...makeFlags({ tool_calls: true }) } as Record<
      DriverCapabilityFlag,
      boolean
    >;
    delete (partialFlags as Partial<Record<DriverCapabilityFlag, boolean>>).context_compaction;

    const driver = new CallCountingProviderDriver(partialFlags);
    await registry.register(DRIVER_ID, driver);

    expect(() => registry.checkCapability(DRIVER_ID, "context_compaction")).toThrow(
      DriverCapabilityUnsupportedError,
    );
    expect(driver.operationCallCount).toBe(0);
  });

  it("carries the dotted `driver.capability_unsupported` code, not just an Error class", async () => {
    const registry = new ProviderRegistry();
    const driver = new CallCountingProviderDriver(makeFlags());
    await registry.register(DRIVER_ID, driver);

    let caught: unknown = null;
    try {
      registry.checkCapability(DRIVER_ID, "provider_commands");
    } catch (error) {
      caught = error;
    }

    // The IPC layer maps the dotted code onto the wire; asserting only the class would pass for a
    // refusal that reached a client as an untyped internal error.
    expect(caught).toBeInstanceOf(DriverCapabilityUnsupportedError);
    if (caught instanceof DriverCapabilityUnsupportedError) {
      expect(caught.code).toBe("driver.capability_unsupported");
    }
    expect(driver.operationCallCount).toBe(0);
  });

  it("refuses an unregistered driver as `driver.unavailable` without touching any driver", () => {
    const registry = new ProviderRegistry();
    const unregisteredDriver = new CallCountingProviderDriver(
      makeFlags({ context_compaction: true }),
    );

    // This driver declares the capability, so a gate keyed on the flag alone would let the call
    // through. It is refused because the id was never registered: there is no snapshot to consult,
    // and the fail-closed answer is refusal, not a live lookup.
    let caught: unknown = null;
    try {
      registry.checkCapability("never-registered", "context_compaction");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DriverUnavailableError);
    if (caught instanceof DriverUnavailableError) {
      expect(caught.code).toBe("driver.unavailable");
    }
    expect(unregisteredDriver.operationCallCount).toBe(0);
  });
});
