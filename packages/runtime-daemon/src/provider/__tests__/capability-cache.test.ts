// DriverCapabilityCache — Plan-005 Phase 4, T4.5.
//
// The two properties this suite exists for are the two the plan row states, and
// both are asserted the way the row demands rather than the way that would be
// easiest:
//
//   * a cache-SERVED reply carries the same `outputSpeedLevels` a LIVE read
//     carries — asserted by comparing the two REPLIES, never by inspecting the
//     cache, because inspecting the cache would prove only that some member was
//     stored and this cache's whole claim is that none is;
//   * the durable round-trip adds NO column for the vocabulary — asserted by
//     showing the answer tracks the driver's own table at the moment of each
//     read (a resolver whose answer changes between two reads of one cached
//     driver changes the second reply), which is a property no stored value
//     could have.
//
// The third property is I-005-2's direction: an undeclared capability is
// unsupported, so a driver that does not declare `output_speed` gets no
// vocabulary member at all rather than an empty one.
//
// Refs: Plan-005 §Phase 4 / T4.5, `Spec-005 §Capability discovery`,
// `Spec-005 §The output-speed axis`, invariant I-005-2.

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

function flagsWith(overrides: Partial<Record<DriverCapabilityFlag, boolean>>): DriverCapabilities {
  const flags = Object.fromEntries(
    DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, overrides[flag] ?? false]),
  ) as Record<DriverCapabilityFlag, boolean>;
  return { flags, contractVersion: "1.0.0" };
}

/**
 * A hit arm carrying the FULL `GetCapabilitiesResult` the durable reader hands
 * back — `tools` and `cliVersion` included, and `outputSpeedLevels` composed by
 * that reader exactly as `hydrate()` composes it. The point of building the
 * whole wrapper here is that the cache must be seen to DROP the members that
 * stop at the driver, not merely to be handed a pre-narrowed shape.
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
    // The plan row's "no provider round-trip per call" realized at the seam this
    // class actually holds: a hit consults nothing outside this object, so even
    // the SQLite read happens once.
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
    // The invalidation source reports whichever driver was re-declared; a name
    // this cache has never seen is a normal case, not an error.
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
    // The mandatory comparison, made between the two REPLIES. Read one is the
    // live path (it hydrates); read two is served from the entry. If the
    // vocabulary were dropped, defaulted, or captured from a stale source, these
    // two would differ — and the third assertion pins both to the driver's own
    // table rather than merely to each other, so a cache that consistently
    // served the WRONG vocabulary could not pass by agreeing with itself.
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
    // The "adds no column" property, asserted positively. A resolver whose
    // answer changes between two reads of one CACHED driver: the second reply
    // must carry the new answer. A cache that stored the vocabulary — in an
    // entry field, in a column, anywhere — would keep serving the first, which
    // is exactly the redeploy-staleness the module refuses to make possible.
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
    // The table is deep-frozen and shared by every reader on both read paths.
    // Returning the frozen array itself would not corrupt anything, but it would
    // make an innocent consumer that sorts the reply throw at a distance.
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

describe("DriverCapabilityCache — I-005-2, undeclared is unsupported", () => {
  it("omits the vocabulary entirely for a driver that declares output_speed false", () => {
    // ABSENT, not empty. `Spec-005 §The output-speed axis` reads absence as "the
    // axis is unsettable"; an empty array would instead assert a settable axis
    // with nothing on it, which is a different and false claim.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: false }), "codex"),
    });

    const report = cache.read("codex");
    expect(Object.hasOwn(report, "outputSpeedLevels")).toBe(false);
  });

  it("omits the vocabulary when the flag is ABSENT from the durable row", () => {
    // Fail-closed on `!== true` rather than on `=== false`. The flags arrive
    // from a durable row through an untyped boundary, so a missing key is
    // reachable in a way the compiler cannot rule out — and "undeclared" must
    // read as unsupported, never as an invitation to resolve a vocabulary the
    // driver never claimed.
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
    // Both miss causes land on the same registered code: there is no capability
    // set this node can show the driver declared, and inventing one would tell a
    // client a control is available on no evidence. `driver.unavailable` (503)
    // is the honest reading — transient and retriable — and reusing the
    // registry's own error class keeps the driver namespace closed at seven.
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

describe("DriverCapabilityCache — the report is the client-facing projection", () => {
  it("drops detectionSource, cliVersion, and tools, and parses against the wire schema", () => {
    // The carve-out belongs in the composition, and the wire schema is the
    // backstop that proves it held: `.strict()` REJECTS an extra member, so a
    // report that leaked provenance would fail this parse rather than reach a
    // client.
    const cache = new DriverCapabilityCache({
      hydrateDurableCapabilities: () => hydrationHit(flagsWith({ output_speed: true }), "claude"),
    });

    const report = cache.read("claude");
    expect(Object.keys(report).sort()).toStrictEqual([
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
    // Construction rather than first read: an update landing before anything has
    // been read must still be seen, or the entry written by the next read would
    // be stale from birth with nothing left to invalidate it.
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
    // Dropping the entries is not housekeeping: after close nothing can
    // invalidate them, so a cache that kept serving them would grow staler with
    // every re-declaration it can no longer hear about.
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
