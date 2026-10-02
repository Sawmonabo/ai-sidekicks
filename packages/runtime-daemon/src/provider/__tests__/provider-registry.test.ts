// The provider registry's capability gate: it refuses fail-closed with the wire's `driver.*`
// codes, a failed registration leaves no entry, and the latest registration's snapshot wins.

import {
  type ApplyInterventionParams,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type DriverCompactionResult,
  type DriverInterventionResult,
  type InterruptRunParams,
  type ProviderCommandListResult,
  type ProviderModel,
  type ProviderMode,
  type ProviderName,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CLI_VERSION_REPORT, makeFlags } from "../__fixtures__/capability-results.js";
import { captureThrow } from "../__fixtures__/capture-throw.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../provider-registry.js";
import type {
  ClearSessionGoalParams,
  CloseSessionParams,
  CompactContextParams,
  CreateSessionParams,
  DriverGoalResult,
  DriverAuthProbeResult,
  DriverResumeResult,
  ForkConversationResult,
  GetCapabilitiesResult,
  ListProviderCommandsParams,
  ProviderDriver,
  ProviderSessionHandle,
  RespondToRequestParams,
  ResumeSessionParams,
  ForkConversationParams,
  SetSessionGoalParams,
  StartRunParams,
} from "../provider-driver.js";

const DRIVER_ID: ProviderName = "claude";

/**
 * A minimal fake `ProviderDriver`. Only `getCapabilities` works, reporting a caller-chosen flags
 * record; the other operations throw, so any call to one fails the test loudly.
 */
class FakeProviderDriver implements ProviderDriver {
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

describe("ProviderRegistry — register", () => {
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

describe("ProviderRegistry — checkCapability gate", () => {
  it("rejects a flag declared false with driver.capability_unsupported", async () => {
    const registry = new ProviderRegistry();
    // `steer: false` is the explicit declared-but-unsupported case.
    await registry.register(DRIVER_ID, new FakeProviderDriver(makeFlags({ steer: false })));

    const refusal = captureThrow(() => registry.checkCapability(DRIVER_ID, "steer"));
    expect(refusal).toBeInstanceOf(DriverCapabilityUnsupportedError);
    expect((refusal as DriverCapabilityUnsupportedError).code).toBe(
      "driver.capability_unsupported",
    );
    expect((refusal as DriverCapabilityUnsupportedError).fields).toEqual({
      driverId: DRIVER_ID,
      flag: "steer",
    });
  });

  it("rejects a check against an unregistered driver with driver.unavailable", () => {
    const registry = new ProviderRegistry();

    const refusal = captureThrow(() => registry.checkCapability("codex", "steer"));
    expect(refusal).toBeInstanceOf(DriverUnavailableError);
    expect((refusal as DriverUnavailableError).code).toBe("driver.unavailable");
    expect((refusal as DriverUnavailableError).fields).toEqual({ driverId: "codex" });
  });
});

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
    const driverA = new DeferredProviderDriver(makeFlags({ steer: true, tool_calls: false }));
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

describe("ProviderRegistry — re-register", () => {
  it("re-registering an id overwrites the cached capability snapshot", async () => {
    const registry = new ProviderRegistry();
    // First registration: steer supported, tool_calls not.
    const driver = new FakeProviderDriver(makeFlags({ steer: true, tool_calls: false }));
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
});

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
});
