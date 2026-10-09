// The provider registry's capability gate: it refuses fail-closed with the wire's `driver.*`
// codes, and a re-registration's snapshot replaces the one before it.

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { describe, expect, it } from "vitest";

import { makeFlags } from "../../capability/__fixtures__/results.js";
import { captureThrow } from "../../../__fixtures__/capture-failure.js";
import { FakeProviderDriver } from "../__fixtures__/contract-doubles.js";
import type { CompactContextParams, ListProviderCommandsParams } from "../contract.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../registry.js";

const DRIVER_ID: ProviderName = "claude";

// The gate reads the snapshot it was handed, so no test here reads a driver's capabilities.
const refuseCapabilityRead = (): Promise<never> =>
  Promise.reject(new Error("the gate never reads a driver's capabilities"));

function capabilitiesWith(flags: Record<DriverCapabilityFlag, boolean>): DriverCapabilities {
  return { flags, contractVersion: "1.0.0" };
}

describe("ProviderRegistry — checkCapability gate", () => {
  it("rejects a flag declared false with driver.capability_unsupported", () => {
    const registry = new ProviderRegistry();
    // `steer: false` is the explicit declared-but-unsupported case.
    registry.register(
      DRIVER_ID,
      new FakeProviderDriver(refuseCapabilityRead),
      capabilitiesWith(makeFlags({ steer: false })),
    );

    const refusal = captureThrow(() => registry.checkCapability(DRIVER_ID, "steer"));
    expect(refusal).toBeInstanceOf(DriverCapabilityUnsupportedError);
    expect((refusal as DriverCapabilityUnsupportedError).code).toBe(
      "driver.capability_unsupported",
    );
    expect((refusal as DriverCapabilityUnsupportedError).detail).toEqual({
      driverId: DRIVER_ID,
      flag: "steer",
    });
  });

  it("rejects a check against an unregistered driver with driver.unavailable", () => {
    const registry = new ProviderRegistry();

    const refusal = captureThrow(() => registry.checkCapability("codex", "steer"));
    expect(refusal).toBeInstanceOf(DriverUnavailableError);
    expect((refusal as DriverUnavailableError).code).toBe("driver.unavailable");
    expect((refusal as DriverUnavailableError).detail).toEqual({ driverId: "codex" });
  });
});

describe("ProviderRegistry — re-register", () => {
  it("re-registering an id overwrites the cached capability snapshot", () => {
    const registry = new ProviderRegistry();
    const driver = new FakeProviderDriver(refuseCapabilityRead);
    // First registration: steer supported, tool_calls not.
    registry.register(
      DRIVER_ID,
      driver,
      capabilitiesWith(makeFlags({ steer: true, tool_calls: false })),
    );
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // Refresh: the same id with the flags flipped.
    registry.register(DRIVER_ID, driver, capabilitiesWith(makeFlags({ tool_calls: true })));

    // The gate now reflects the refreshed snapshot.
    expect(() => registry.checkCapability(DRIVER_ID, "tool_calls")).not.toThrow();
    expect(() => registry.checkCapability(DRIVER_ID, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
  });
});

/**
 * A driver that counts the capability-bound operations before throwing. A bare throw shows a call
 * was a mistake but not that none happened; the counter proves the gate itself dispatches nothing.
 */
class CallCountingProviderDriver extends FakeProviderDriver {
  /** Total capability-bound operation invocations across the counted operations. */
  public operationCallCount: number = 0;

  override compactContext(_params: CompactContextParams): Promise<DriverCompactionResult> {
    this.operationCallCount += 1;
    throw new Error("compactContext reached the driver: the capability gate did not refuse");
  }

  override listProviderCommands(
    _params: ListProviderCommandsParams,
  ): Promise<ProviderCommandListResult> {
    this.operationCallCount += 1;
    throw new Error("listProviderCommands reached the driver: the capability gate did not refuse");
  }
}

describe("ProviderRegistry.checkCapability — fail-closed refusal", () => {
  it("refuses an UNDECLARED flag too: the gate keys on `!== true`, never `=== false`", () => {
    const registry = new ProviderRegistry();
    // `context_compaction` is absent rather than false. The cast reproduces an untyped-boundary
    // input (a hand-edited cache row, a driver built against an older flag union), where a gate
    // keyed on `=== false` would silently admit the call.
    const partialFlags = { ...makeFlags({ tool_calls: true }) } as Record<
      DriverCapabilityFlag,
      boolean
    >;
    delete (partialFlags as Partial<Record<DriverCapabilityFlag, boolean>>).context_compaction;

    const driver = new CallCountingProviderDriver(refuseCapabilityRead);
    registry.register(DRIVER_ID, driver, capabilitiesWith(partialFlags));

    expect(() => registry.checkCapability(DRIVER_ID, "context_compaction")).toThrow(
      DriverCapabilityUnsupportedError,
    );
    expect(driver.operationCallCount).toBe(0);
  });
});
