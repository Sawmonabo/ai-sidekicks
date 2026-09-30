// DriverCapabilityCache behavior. Three properties:
//   * a cache-served reply carries the same `outputSpeedLevels` as a live read, compared reply to
//     reply (inspecting the cache would only show that some member was stored);
//   * the vocabulary is never stored: the answer tracks the driver's table at each read;
//   * an undeclared capability is unsupported: a driver without `output_speed` gets no vocabulary
//     member at all, not an empty one.

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  DriverCapabilityReportSchema,
  type DriverCapabilities,
  type DriverCapabilityFlag,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import { DriverCapabilityCache } from "../capability-cache.js";
import type { DriverCapabilityHydrationResult } from "../driver-capabilities-writer.js";
import { declaredOutputSpeedLevelsFor } from "../driver-output-speed.js";
import { CLAUDE_BUILT_IN_TOOLS } from "../drivers/claude/tools.js";
import { CODEX_BUILT_IN_TOOLS } from "../drivers/codex/tools.js";

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

describe("DriverCapabilityCache — served from cache, never from the driver", () => {
  it("performs ONE durable read for repeated reads of the same driver", () => {
    // A hit consults nothing outside the cache, so even the durable read happens once.
    const hydrate = vi.fn(() => hydrationHit(flagsWith({ output_speed: true }), "claude"));
    const cache = new DriverCapabilityCache({ hydrateDurableCapabilities: hydrate });

    cache.read("claude");
    cache.read("claude");
    cache.read("claude");

    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("re-hydrates after an explicit invalidate, and after invalidateAll", () => {
    const hydrate = vi.fn(() => hydrationHit(flagsWith({}), "codex"));
    const cache = new DriverCapabilityCache({ hydrateDurableCapabilities: hydrate });

    cache.read("codex");
    cache.invalidate("codex");
    cache.read("codex");
    expect(hydrate).toHaveBeenCalledTimes(2);

    cache.invalidateAll();
    cache.read("codex");
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it("tolerates invalidating a driver it has never read", () => {
    // The source reports whichever driver was re-declared; a never-read name is normal.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({}), "codex"),
    });
    expect(() => {
      cache.invalidate("never-read");
    }).not.toThrow();
  });
});

describe("DriverCapabilityCache — outputSpeedLevels is re-derived, never stored", () => {
  it("serves the SAME vocabulary from cache that the live read served", () => {
    // Read one hydrates (live); read two is served from the entry. The last assertion pins both
    // to the driver's own table, so a cache that consistently served a wrong vocabulary fails.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "claude"),
    });

    const liveRead = cache.read("claude");
    const cacheServedRead = cache.read("claude");

    expect(cacheServedRead.outputSpeedLevels).toStrictEqual(liveRead.outputSpeedLevels);
    expect(cacheServedRead.outputSpeedLevels).toStrictEqual([
      ...declaredOutputSpeedLevelsFor("claude"),
    ]);
  });

  it("tracks the driver's table at the MOMENT of each read, which no stored column could", () => {
    // The resolver's answer changes between two reads of one cached driver, so the second reply
    // must carry the new answer. A cache that stored the vocabulary would keep serving the first
    // and go stale across a redeploy.
    const vocabularies = [
      ["off", "on"],
      ["off", "on", "turbo"],
    ];
    let readIndex = 0;
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "claude"),
      resolveOutputSpeedLevels: () => vocabularies[readIndex++] ?? [],
    });

    const first = cache.read("claude");
    const second = cache.read("claude");

    expect(first.outputSpeedLevels).toStrictEqual(["off", "on"]);
    expect(second.outputSpeedLevels).toStrictEqual(["off", "on", "turbo"]);
    expect(readIndex).toBe(2);
  });

  it("hands out a COPY, so a consumer cannot rewrite the shared table", () => {
    // The table is deep-frozen and shared; returning it would make a consumer that sorts the
    // reply throw.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "claude"),
    });

    const report = cache.read("claude");
    expect(Object.isFrozen(report.outputSpeedLevels)).toBe(false);
    report.outputSpeedLevels?.push("mutated");
    expect(cache.read("claude").outputSpeedLevels).toStrictEqual([
      ...declaredOutputSpeedLevelsFor("claude"),
    ]);
  });
});

describe("DriverCapabilityCache — undeclared is unsupported", () => {
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
});

describe("DriverCapabilityCache — each driver's built-in tools ride every read", () => {
  it("answers each driver's own tool list, whether or not it declares an output speed", () => {
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: (driverName) =>
        hydrationHit(flagsWith({ output_speed: driverName === "claude" }), driverName),
    });

    expect(cache.read("claude").builtInTools).toStrictEqual([...CLAUDE_BUILT_IN_TOOLS]);
    expect(cache.read("codex").builtInTools).toStrictEqual([...CODEX_BUILT_IN_TOOLS]);
  });

  it("hands out a copy, so a reader that edits its reply changes no later read", () => {
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({}), "codex"),
    });

    cache.read("codex").builtInTools.push("mutated");
    expect(cache.read("codex").builtInTools).toStrictEqual([...CODEX_BUILT_IN_TOOLS]);
  });

  it("REFUSES a cached driver that has no tool list, rather than answering without one", () => {
    // An empty list would read as a provider that carries no tools of its own.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({}), "gemini"),
    });

    expect(() => cache.read("gemini")).toThrow(
      /no built-in tools are declared for driver 'gemini'/,
    );
  });
});

describe("DriverCapabilityCache — the report is the client-facing projection", () => {
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

  it("answers every declared flag, so a client never reads absence as unknown", () => {
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ steer: true }), "claude"),
    });

    const report = cache.read("claude");
    expect(Object.keys(report.capabilities.flags).sort()).toStrictEqual(
      [...DRIVER_CAPABILITY_FLAGS].sort(),
    );
    expect(report.capabilities.flags.steer).toBe(true);
  });

  it("hands out a fresh flags object per read, so a mutating consumer cannot poison the cache", () => {
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ steer: true }), "claude"),
    });

    const first = cache.read("claude");
    first.capabilities.flags.steer = false;

    expect(cache.read("claude").capabilities.flags.steer).toBe(true);
  });
});

describe("DriverCapabilityCache — invalidation source lifecycle", () => {
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

  it("leaves other drivers cached when one is invalidated", () => {
    let publish: ((driverName: string) => void) | undefined;
    const hydrate = vi.fn((driverName: string) => hydrationHit(flagsWith({}), driverName));
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: hydrate,
      subscribeToCapabilityUpdates: (onCapabilityUpdated) => {
        publish = onCapabilityUpdated;
        return () => undefined;
      },
    });

    cache.read("claude");
    cache.read("codex");
    publish?.("claude");
    cache.read("codex");

    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("close() unsubscribes exactly once and drops every entry", () => {
    // After close nothing can invalidate the entries, so they must not be served.
    const unsubscribe = vi.fn();
    const hydrate = vi.fn(() => hydrationHit(flagsWith({}), "claude"));
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: hydrate,
      subscribeToCapabilityUpdates: () => unsubscribe,
    });

    cache.read("claude");
    cache.close();
    cache.close();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    cache.read("claude");
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("close() is safe with no invalidation source wired", () => {
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({}), "claude"),
    });
    expect(() => {
      cache.close();
    }).not.toThrow();
  });
});
