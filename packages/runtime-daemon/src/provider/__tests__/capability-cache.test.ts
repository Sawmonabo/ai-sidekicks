// The capability cache behind `driver.listCapabilities`: the client-facing report, fail-closed
// reads of the durable row, and invalidation when a driver re-declares.

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  DriverCapabilityReportSchema,
  type DriverCapabilities,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts";

import { DriverCapabilityCache } from "../capability-cache.js";
import type { DriverCapabilityHydrationResult } from "../driver-capabilities-writer.js";
import { declaredOutputSpeedLevelsFor } from "../driver-output-speed.js";
import type { GetCapabilitiesResult } from "../provider-driver.js";

function flagsWith(overrides: Partial<Record<DriverCapabilityFlag, boolean>>): DriverCapabilities {
  const flags = Object.fromEntries(
    DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, overrides[flag] ?? false]),
  ) as Record<DriverCapabilityFlag, boolean>;
  return { flags, contractVersion: "1.0.0" };
}

/**
 * A durable-read hit carrying the full `GetCapabilitiesResult` (`tools` and `cliVersion`
 * included), so the cache is seen to drop the members that stop at the driver.
 */
function hydrationHit(
  capabilities: DriverCapabilities,
  driverName: string,
): DriverCapabilityHydrationResult {
  const result: GetCapabilitiesResult = {
    capabilities,
    tools: [{ name: "bash", idempotency_class: "manual_reconcile_only" }],
    cliVersion: { raw: "2.1.251 (Claude Code)", semver: "2.1.251" },
    ...(capabilities.flags.output_speed
      ? { outputSpeedLevels: [...declaredOutputSpeedLevelsFor(driverName)] }
      : {}),
  };
  return { hit: true, result };
}

describe("DriverCapabilityCache", () => {
  it("drops detectionSource, cliVersion, and tools, and parses against the wire schema", () => {
    // The wire schema is `.strict()`, so a report that leaked provenance fails this parse.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "claude"),
    });

    const report = cache.read("claude");
    expect(Object.keys(report).sort()).toStrictEqual([
      "builtInTools",
      "capabilities",
      "driverName",
      "outputSpeedLevels",
    ]);
    expect(DriverCapabilityReportSchema.safeParse(report).success).toBe(true);
    // The second read is served from the entry and must carry the driver's own vocabulary too.
    const declaredLevels = [...declaredOutputSpeedLevelsFor("claude")];
    expect(report.outputSpeedLevels).toStrictEqual(declaredLevels);
    expect(cache.read("claude").outputSpeedLevels).toStrictEqual(declaredLevels);
  });

  it("omits the vocabulary entirely for a driver that declares output_speed false", () => {
    // Absence means the axis is unsettable; an empty array would claim a settable axis with
    // nothing on it.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: false }), "codex"),
    });

    const report = cache.read("codex");
    expect(Object.hasOwn(report, "outputSpeedLevels")).toBe(false);
  });

  it("omits the vocabulary when the flag is ABSENT from the durable row", () => {
    // The cache fails closed on `!== true`: flags come from a durable row, so a missing key is
    // reachable, and it must read as unsupported.
    const capabilities = flagsWith({});
    const flagsWithoutOutputSpeed: Record<string, boolean> = { ...capabilities.flags };
    delete flagsWithoutOutputSpeed["output_speed"];
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => ({
        hit: true,
        result: {
          capabilities: {
            flags: flagsWithoutOutputSpeed as Record<DriverCapabilityFlag, boolean>,
            contractVersion: "1.0.0",
          },
          tools: [],
          cliVersion: { raw: "1.0.0", semver: "1.0.0" },
        },
      }),
      resolveOutputSpeedLevels: () => {
        throw new Error("the vocabulary must not be resolved for an undeclared flag");
      },
    });

    expect(Object.hasOwn(cache.read("claude"), "outputSpeedLevels")).toBe(false);
  });

  it("REFUSES a durable miss rather than reporting an unsubstantiated capability set", () => {
    // Both miss causes raise `driver.unavailable`: with no substantiated capability set, reporting
    // one would tell a client a control is available on no evidence.
    for (const reason of ["never_written", "cli_version_missing"] as const) {
      const cache = new DriverCapabilityCache({
        hydrateDurableCapabilities: () => ({ hit: false, reason }),
      });
      expect(() => cache.read("claude")).toThrowError(
        expect.objectContaining({ code: "driver.unavailable" }),
      );
    }
  });

  it("subscribes at CONSTRUCTION and invalidates the named driver", () => {
    // Subscribing at construction catches an update that lands before the first read; otherwise
    // the entry that read writes would be stale from birth.
    let publish: ((driverName: string) => void) | undefined;
    const hydrate = vi.fn(() => hydrationHit(flagsWith({}), "claude"));
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: hydrate,
      subscribeToCapabilityUpdates: (onCapabilityUpdated) => {
        publish = onCapabilityUpdated;
        return () => {
          publish = undefined;
        };
      },
    });

    expect(publish).toBeDefined();
    cache.read("claude");
    cache.read("claude");
    expect(hydrate).toHaveBeenCalledTimes(1);

    publish?.("claude");
    cache.read("claude");
    expect(hydrate).toHaveBeenCalledTimes(2);
  });
});
