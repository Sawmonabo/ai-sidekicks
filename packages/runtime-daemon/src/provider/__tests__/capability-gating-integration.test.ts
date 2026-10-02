// ProviderRegistry and DriverCapabilitiesWriter composed over one real SQLite handle, with the
// driver as the only double: capability gating agrees between the live registry, a registry
// re-seeded from the durable cache after a restart, and a refreshed registry.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type ProviderName,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { makeAdvancingClock } from "../__fixtures__/advancing-clock.js";
import {
  DriverCapabilitiesWriter,
  type DriverCapabilityHydrationResult,
} from "../driver-capabilities-writer.js";
import { DriverCapabilityUnsupportedError, ProviderRegistry } from "../provider-registry.js";
import type {
  DriverCliVersionReport,
  GetCapabilitiesResult,
  ProviderDriver,
} from "../provider-driver.js";

const DRIVER_NAME: ProviderName = "claude";
// One shared version makes the binding and the capability cache agree by construction.
const CONTRACT_VERSION: string = "1.2.3";

// Every flag defaults false, then `resume` and `tool_calls` are true, then the overrides apply.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

// The writer persists the reading, so a cold-start re-seed carries it out of the cache instead of
// re-attaching it from the live driver.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// Tools are already in canonical order with an explicit `idempotency_class`, so a hydrate
// round-trip is an identity check.
function makeResult(overrides: Partial<GetCapabilitiesResult> = {}): GetCapabilitiesResult {
  return {
    capabilities: {
      flags: makeFlags(),
      contractVersion: CONTRACT_VERSION,
    },
    tools: [{ name: "search", idempotency_class: "idempotent", description: "search the web" }],
    cliVersion: CLI_VERSION_REPORT,
    ...overrides,
  };
}

// Throws on a miss, naming its reason, so a hit that became a miss cannot pass silently.
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}

// The registry caches `getCapabilities()` once per registration, so each registration gets its own
// driver. Every other method rejects, so a stray call fails the test.
function makeMockDriver(capabilitiesResult: GetCapabilitiesResult): ProviderDriver {
  return {
    getCapabilities(): Promise<GetCapabilitiesResult> {
      return Promise.resolve(capabilitiesResult);
    },
    createSession(): Promise<never> {
      return Promise.reject(new Error("createSession is not exercised by this suite"));
    },
    resumeSession(): Promise<never> {
      return Promise.reject(new Error("resumeSession is not exercised by this suite"));
    },
    startRun(): Promise<never> {
      return Promise.reject(new Error("startRun is not exercised by this suite"));
    },
    interruptRun(): Promise<never> {
      return Promise.reject(new Error("interruptRun is not exercised by this suite"));
    },
    forkConversation(): Promise<never> {
      return Promise.reject(new Error("forkConversation is not exercised by this suite"));
    },
    respondToRequest(): Promise<never> {
      return Promise.reject(new Error("respondToRequest is not exercised by this suite"));
    },
    setSessionGoal(): Promise<never> {
      return Promise.reject(new Error("setSessionGoal is not exercised by this suite"));
    },
    clearSessionGoal(): Promise<never> {
      return Promise.reject(new Error("clearSessionGoal is not exercised by this suite"));
    },
    closeSession(): Promise<never> {
      return Promise.reject(new Error("closeSession is not exercised by this suite"));
    },
    listModels(): Promise<never> {
      return Promise.reject(new Error("listModels is not exercised by this suite"));
    },
    listModes(): Promise<never> {
      return Promise.reject(new Error("listModes is not exercised by this suite"));
    },
    probeAuth(): Promise<never> {
      return Promise.reject(new Error("probeAuth is not exercised by this suite"));
    },
    compactContext(): Promise<never> {
      return Promise.reject(new Error("compactContext is not exercised by this suite"));
    },
    listProviderCommands(): Promise<never> {
      return Promise.reject(new Error("listProviderCommands is not exercised by this suite"));
    },
    applyIntervention(): Promise<never> {
      return Promise.reject(new Error("applyIntervention is not exercised by this suite"));
    },
  };
}

interface Stack {
  readonly writer: DriverCapabilitiesWriter;
  readonly registry: ProviderRegistry;
}

let db: DatabaseType;

function makeStack(): Stack {
  return {
    writer: new DriverCapabilitiesWriter(db, makeAdvancingClock()),
    registry: new ProviderRegistry(),
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

describe("capability gating across the registry, the durable cache and a restart", () => {
  it("registry gate, declare, hydrate, and a re-seeded registry-B all agree on the gating set across a daemon restart", async () => {
    const { writer, registry } = makeStack();

    // steer:false, resume:true, tool_calls:true, and a non-empty tools array.
    const advertised: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
    });
    const driver = makeMockDriver(advertised);

    // Registry A: the live gate reads the snapshot resolved at register.
    await registry.register(DRIVER_NAME, driver);
    // A declared-true flag returns void.
    expect(registry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
    // A declared-false flag throws.
    expect(() => registry.checkCapability(DRIVER_NAME, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );
    try {
      registry.checkCapability(DRIVER_NAME, "steer");
      expect.unreachable("checkCapability(steer) must throw");
    } catch (error) {
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
    }

    // Persist the snapshot to the durable cache.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: advertised,
      }),
    ).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // Hydrate reproduces the whole result, `cliVersion` included; a member-wise check would let a
    // dropped `cliVersion` pass.
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated).toEqual(advertised);
    expect(hydrated.capabilities.flags).toEqual(makeFlags({ steer: false }));
    expect(hydrated.capabilities.contractVersion).toBe(CONTRACT_VERSION);
    expect(hydrated.tools).toEqual([
      { name: "search", idempotency_class: "idempotent", description: "search the web" },
    ]);
    expect(hydrated.cliVersion).toEqual(CLI_VERSION_REPORT);

    // Cold-start re-seed: registry B is fed the hydrated cache, not the live driver, and must gate
    // identically to registry A.
    const registryB: ProviderRegistry = new ProviderRegistry();
    // The cache's own object is handed over unmodified; re-attaching `CLI_VERSION_REPORT` would
    // mask a cache that dropped it.
    await registryB.register(DRIVER_NAME, makeMockDriver(hydrated));
    expect(registryB.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
    try {
      registryB.checkCapability(DRIVER_NAME, "steer");
      expect.unreachable("registry-B checkCapability(steer) must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
    }
  });

  it("steer false→true reports changed and the refreshed registry passes steer", async () => {
    const { writer } = makeStack();

    // Initial declare: steer:false.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // Refreshed declare: steer:true is a real change.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({
      snapshotChange: "changed",
      // False on purpose: only the capability matrix changed, and `makeResult` re-declares the same
      // `CLI_VERSION_REPORT`. A flag wired to "a statement ran" would report true.
      cliVersionRefreshed: false,
    });

    // Re-hydrate and register from the refreshed cache: steer now passes.
    const refreshed: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(refreshed.capabilities.flags["steer"]).toBe(true);
    // The refresh must not drop the version pair.
    expect(refreshed.cliVersion).toEqual(CLI_VERSION_REPORT);

    const refreshedRegistry: ProviderRegistry = new ProviderRegistry();
    // Handed across unmodified, as for registry B above.
    await refreshedRegistry.register(DRIVER_NAME, makeMockDriver(refreshed));
    expect(refreshedRegistry.checkCapability(DRIVER_NAME, "steer")).toBeUndefined();
  });
});
