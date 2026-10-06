// The capability cache behind `driver.listCapabilities`: the client-facing report, fail-closed
// reads of the durable row, and invalidation when a driver re-declares.

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilities,
  type DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { DriverCapabilityReportSchema } from "@ai-sidekicks/contracts/provider/driver/methods";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { DriverCapabilityCache } from "../cache.js";
import type { DriverCapabilityHydrationResult } from "../../driver/driver-capabilities-writer.js";
import type { GetCapabilitiesResult } from "../../driver/provider-driver.js";
import { composeStaticOutputSpeedLevels } from "../../driver/provider-driver-descriptors.js";

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
  driverName: ProviderName,
): DriverCapabilityHydrationResult {
  const result: GetCapabilitiesResult = {
    capabilities,
    tools: [{ name: "bash", idempotency_class: "manual_reconcile_only" }],
    cliVersion: { rawVersion: "2.1.251 (Claude Code)", parsedVersion: "2.1.251" },
    ...composeStaticOutputSpeedLevels(driverName, capabilities.flags),
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
  });

  it("omits the vocabulary where the flag is false or the levels are read per model", () => {
    // Absence means no driver-wide set: with the flag false the axis is unsettable, and an empty
    // array would claim a settable axis with nothing on it.
    const withdrawn = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: false }), "claude"),
    });
    expect(Object.hasOwn(withdrawn.read("claude"), "outputSpeedLevels")).toBe(false);

    // Codex publishes its levels on each model of the catalog read, which the cache neither
    // stores nor flattens into one list some model in the catalog would contradict.
    const perModel = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "codex"),
    });
    expect(Object.hasOwn(perModel.read("codex"), "outputSpeedLevels")).toBe(false);
  });

  it("omits the vocabulary when the flag is ABSENT from the durable row", () => {
    // Flags come from a durable row, so a missing key is reachable, and the cache reads it as
    // unsupported, never as a settable axis.
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
          cliVersion: { rawVersion: "1.0.0", parsedVersion: "1.0.0" },
        },
      }),
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
    let publish: ((driverName: ProviderName) => void) | undefined;
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
