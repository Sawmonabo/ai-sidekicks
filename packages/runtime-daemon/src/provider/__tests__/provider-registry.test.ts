// ProviderRegistry — Plan-005 Phase 2 (T2.3), extended by Phase 4 (T4.6).
//
// Exercises the in-memory registry + the capability-flag gate against a
// hand-rolled fake `ProviderDriver`. The fake implements all 18 contract ops;
// only `getCapabilities` carries behavior (a controllable `flags` record + a call
// counter), the other seventeen throw "not implemented in test" because no path
// here invokes them — proving the gate reads the CACHED snapshot, never the driver.
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * `Spec-005 §Required Behavior` (every provider integration implements a normalized driver
//     contract): the register + lookup round-trip keys a `ProviderDriver`
//     instance under its canonical id.
//   * `Spec-005 §Required Behavior` + I-005-2 (runtime treats undeclared capabilities as
//     unsupported): the declared-`false` AND fail-closed undeclared-flag cases
//     both throw `driver.capability_unsupported`; a declared-`true` flag passes.
//   * T4.6 / AC2: the refusal happens AT the orchestration-to-driver boundary —
//     a capability-bound invocation is refused with the driver's own operation
//     call count at zero, and with the gate having consulted no driver method,
//     which is what "before it reaches the driver" means in assertable form.
//
// Refs: Plan-005 §Phase 2 / T2.3 and §Phase 4 / T4.6, `Spec-005 §Required Behavior`,
// invariant I-005-2,
// `docs/architecture/contracts/error-contracts.md §Driver`
// (`driver.unavailable` + `driver.capability_unsupported`).

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
  type DriverGoalResult,
  type DriverInterventionResult,
  type DriverResumeResult,
  type DriverRollbackResult,
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
  type RollbackToParams,
  type SessionId,
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
// Fixtures — a controllable fake ProviderDriver
// ----------------------------------------------------------------------------

const DRIVER_ID: string = "claude";
const OTHER_DRIVER_ID: string = "codex";

/**
 * Build a complete `Record<DriverCapabilityFlag, boolean>` from a partial
 * override. EVERY canonical flag MUST be answered (the contract `Record` is
 * total — the structural half of I-005-2), so this defaults all to `false` and
 * lets a test flip just the flags it cares about.
 *
 * The base record is DERIVED from `DRIVER_CAPABILITY_FLAGS` rather than spelled
 * out, so widening the contract's flag union cannot leave a stale hand-written
 * copy behind here (the same derivation `driver-capabilities-writer.test.ts`
 * uses).
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
 * A well-formed `cliVersion` reading. REQUIRED on `GetCapabilitiesResult` (T1.8):
 * a capability report without a parseable provider version never reaches the
 * daemon. The registry caches `result.capabilities` ONLY, so no assertion here
 * reads this — it exists so the fakes satisfy the contract honestly instead of
 * being cast past it.
 */
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

/**
 * A minimal fake `ProviderDriver`. Only `getCapabilities` is meaningful: it
 * returns a caller-chosen `flags` record and counts its own invocations so a test
 * can assert the registry snapshots it EXACTLY ONCE. The other seventeen ops throw —
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
    return Promise.resolve({ capabilities, tools: [], cliVersion: CLI_VERSION_REPORT });
  }

  // The remaining seventeen ops are never exercised here — the gate reads the
  // cached snapshot, not the live driver — so they throw to catch any accidental
  // call. Declared in contract order.
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
  rollbackTo(_params: RollbackToParams): Promise<DriverRollbackResult> {
    throw new Error("not implemented in test");
  }
  respondToRequest(_params: RespondToRequestParams): Promise<void> {
    throw new Error("not implemented in test");
  }
  setSessionGoal(_params: SetSessionGoalParams): Promise<DriverGoalResult> {
    throw new Error("not implemented in test");
  }
  clearSessionGoal(_params: ClearSessionGoalParams): Promise<DriverGoalResult> {
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
// register + lookup — `Spec-005 §Required Behavior` (normalized contract keyed by id)
// ----------------------------------------------------------------------------

describe("ProviderRegistry — register + lookup (`Spec-005 §Required Behavior`)", () => {
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
// checkCapability — `Spec-005 §Required Behavior` + I-005-2 (undeclared capability = unsupported)
// ----------------------------------------------------------------------------

describe("ProviderRegistry — checkCapability gate (`Spec-005 §Required Behavior`, I-005-2)", () => {
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
// Immutable capability snapshot — register clones, never aliases (FIX 1)
// ----------------------------------------------------------------------------

describe("ProviderRegistry — immutable capability snapshot (defensive clone)", () => {
  it("a post-register driver-side MUTATION of the flags object does NOT drift the gate", async () => {
    const registry = new ProviderRegistry();
    // The fake stores its `flags` arg BY REFERENCE and returns it BY REFERENCE,
    // so mutating this object IN PLACE after register() reproduces the aliasing
    // bug — pre-fix the gate (reading the aliased object) would see the mutation.
    const mutableFlags = makeFlags({ tool_calls: true });
    await registry.register(DRIVER_ID, new FakeProviderDriver(mutableFlags));

    // The register-time snapshot supports `tool_calls`.
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();

    // Mutate the SAME object the driver advertised, AFTER registration. With a
    // defensive clone the cached snapshot is unaffected; with the old by-reference
    // alias this would flip the gate to "unsupported".
    mutableFlags.tool_calls = false;

    // The gate still reflects the immutable register-time snapshot, not the
    // later mutation (the class-header "snapshot resolved ONCE at registration").
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// Last-call-wins registration race guard (FIX 3) — the LATEST-INITIATED register
// wins regardless of which getCapabilities() resolves first.
// ----------------------------------------------------------------------------

/**
 * A fake whose `getCapabilities()` returns a promise the TEST resolves manually,
 * so two overlapping `register()` calls can be ordered deterministically: A is
 * initiated first, B second, but B's promise is resolved FIRST. Without manual
 * promise control this race cannot be reproduced deterministically.
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

  /** Resolve this driver's pending `getCapabilities()` with its own flags. */
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
    // A is initiated first (steer supported); B second (tool_calls supported).
    const driverA = new DeferredProviderDriver(makeFlags({ steer: true }));
    const driverB = new DeferredProviderDriver(makeFlags({ tool_calls: true }));

    const registerA = registry.register(DRIVER_ID, driverA);
    const registerB = registry.register(DRIVER_ID, driverB);

    // Resolve B FIRST, then A — so the EARLIER-initiated call (A) resolves LAST.
    // A naive last-to-resolve-wins implementation would install A's stale snapshot.
    driverB.settle();
    driverA.settle();
    await Promise.all([registerA, registerB]);

    // The registry holds B's snapshot (the latest-initiated call): tool_calls
    // passes, and A's steer is NOT installed (A's late resolution was dropped).
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
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

// ----------------------------------------------------------------------------
// T4.6 — the gate refuses AT the orchestration-to-driver boundary (I-005-2, AC2)
// ----------------------------------------------------------------------------

/**
 * A fake that COUNTS the capability-bound operations instead of only throwing on
 * them. `FakeProviderDriver`'s bare `throw` proves a call was a mistake but not
 * that no call happened — an assertion needs a counter, because a gate that let
 * the call through and a driver that refused it produce the same failed test for
 * different reasons.
 *
 * The overrides still throw after counting, so the loud-failure property the
 * base class provides for every OTHER test in this file is preserved.
 */
class CallCountingProviderDriver extends FakeProviderDriver {
  /** Total capability-bound operation invocations, across all counted ops. */
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

/** A low-entropy sentinel session id — no real identifier is involved. */
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

const COMPACT_CONTEXT_PARAMS: CompactContextParams = {
  sessionId: TEST_SESSION_ID,
  bindingId: "binding-under-test",
};

describe("ProviderRegistry — refusal precedes the driver call (`Spec-005 §Required Behavior`, I-005-2, AC2)", () => {
  it("refuses a capability-bound invocation with the registered code and never invokes the operation", async () => {
    const registry = new ProviderRegistry();
    // The driver declares `tool_calls` true and `context_compaction` FALSE —
    // `makeFlags` answers every flag, so this is the declared-`false` shape. The
    // absent-flag shape is the next test; both must refuse, and separating them
    // keeps each one's failure legible.
    const driver = new CallCountingProviderDriver(makeFlags({ tool_calls: true }));
    await registry.register(DRIVER_ID, driver);

    // The orchestration-to-driver boundary in the order the caller runs it: gate
    // first, dispatch second. The gate is the real `ProviderRegistry` method —
    // nothing about the guard is restated here, only the caller's ordering.
    const capabilityBoundInvocation = (): Promise<DriverCompactionResult> => {
      registry.checkCapability(DRIVER_ID, "context_compaction");
      return driver.compactContext(COMPACT_CONTEXT_PARAMS);
    };

    expect(capabilityBoundInvocation).toThrow(DriverCapabilityUnsupportedError);

    // The claim this test exists for: the refusal happened BEFORE the driver was
    // reached. Not "the driver refused" and not "the driver threw" — the driver
    // was never asked.
    expect(driver.operationCallCount).toBe(0);
    // And the gate itself consulted no driver method either: `getCapabilities`
    // is still at the single call `register` made. A gate that had to ask the
    // driver at decision time would read 2 here, which would mean an unreachable
    // or hung provider process could not be refused without first being
    // contacted.
    expect(driver.getCapabilitiesCallCount).toBe(1);
  });

  it("refuses an UNDECLARED flag at the boundary too, with the operation call count still zero", async () => {
    const registry = new ProviderRegistry();
    // A flags record with `context_compaction` ABSENT rather than `false`. The
    // cast is the honest reproduction of the hazard: the contract `Record` is
    // total, so this shape can only arrive through an untyped boundary — a
    // hand-edited cache row, a driver built against an older flag union — which
    // is exactly when a gate keyed on `=== false` would silently admit the call.
    const partialFlags = { ...makeFlags({ tool_calls: true }) } as Record<
      DriverCapabilityFlag,
      boolean
    >;
    delete (partialFlags as Partial<Record<DriverCapabilityFlag, boolean>>).context_compaction;

    const driver = new CallCountingProviderDriver(partialFlags);
    await registry.register(DRIVER_ID, driver);

    const capabilityBoundInvocation = (): Promise<DriverCompactionResult> => {
      registry.checkCapability(DRIVER_ID, "context_compaction");
      return driver.compactContext(COMPACT_CONTEXT_PARAMS);
    };

    expect(capabilityBoundInvocation).toThrow(DriverCapabilityUnsupportedError);
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

    // The dotted code is what the IPC layer maps onto the wire; asserting only
    // the class would pass against a refusal that reached a client as an
    // untyped internal error.
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

    // The other refusal branch, and the sharper one: this driver DECLARES the
    // capability, so a gate keyed on the flag alone would have let the call
    // through. It is refused because the id was never registered — the gate has
    // no snapshot to consult, and the fail-closed answer is refusal rather than
    // a live lookup on an unknown driver.
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
