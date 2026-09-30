// Integration of RuntimeBindingStore, ProviderRegistry and DriverCapabilitiesWriter over one real
// SQLite handle, with a single mock at the provider boundary (`ProviderDriver`). Each component
// owns its unit suite; this file covers only what emerges when they are composed.
//
//   * `checkCapability` gates identically for the live registry, a registry re-seeded from the
//     hydrated cache after a restart, and a refreshed registry.
//   * A NULL cli-version pair makes hydration miss with `cli_version_missing`, so the only remedy
//     is a refresh from the live driver.
//   * `applyIntervention` is not pre-gated: a `steer:false` driver still receives the call.
//   * A runtime binding keeps the provider's opaque `resumeHandle` beside the daemon-owned
//     `spawnConfig` and reads back intact through a fresh store over the same db.
//   * Gate matrix: unregistered -> `driver.unavailable`; declared false ->
//     `driver.capability_unsupported`; declared true -> returns void.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type ApplyInterventionParams,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type DriverInterventionResult,
  type ExecutionPosture,
  type GetCapabilitiesResult,
  type ProviderDriver,
  type RunId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  DriverCapabilitiesWriter,
  type DriverCapabilityHydrationResult,
} from "../driver-capabilities-writer.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../provider-registry.js";
import { RuntimeBindingStore, type RuntimeBindingSpawnConfig } from "../runtime-binding-store.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const DRIVER_NAME: string = "claude";
// Canonical semver accepted by the contract-version check on both write seams. One shared version
// makes the binding and the capability cache agree by construction.
const CONTRACT_VERSION: string = "1.2.3";

// ----------------------------------------------------------------------------
// Flag and result fixtures
// ----------------------------------------------------------------------------

// Every flag from `DRIVER_CAPABILITY_FLAGS` defaults false, then `resume` and `tool_calls` are
// true, then the per-test overrides apply.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

// The required cli-version reading. The writer persists it, so a cold-start re-seed carries it out
// of the cache instead of re-attaching it from the live driver.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// A spawn-bound record: the sandbox posture plus the resolved executable path. Two members are
// enough to show the record survives the cold read with content; the binding-store suite covers
// the full key set.
const EXECUTION_POSTURE: ExecutionPosture = {
  networkAccess: "none",
  writableRoots: ["/workspace/repo"],
  mode: "trusted",
};

const SPAWN_CONFIG: RuntimeBindingSpawnConfig = {
  executionPosture: EXECUTION_POSTURE,
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
};

// The driver's advertised snapshot. Tools are already in canonical order with an explicit
// `idempotency_class`, so a hydrate round-trip is an identity check.
// identity check rather than a normalize-and-sort comparison.
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

/**
 * Narrows a hydration result to its hit arm and throws on a miss, naming the miss reason so a
 * regression that turns a hit into a miss says why. A throw, not an early return, so a failure
 * cannot pass silently. Local to this file so the two suites' fixtures stay independent.
 */
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}

// ----------------------------------------------------------------------------
// Mock ProviderDriver: the only test double
// ----------------------------------------------------------------------------

interface MockProviderDriver extends ProviderDriver {
  // Interventions that reached the driver.
  readonly interventionCalls: ApplyInterventionParams[];
}

// Builds a driver that advertises `capabilitiesResult` and records each `applyIntervention`. A
// factory, because the registry caches `getCapabilities()` once per registration and a test needs
// a different result per registration. The methods this suite does not exercise reject, so a
// stray call fails the test.
function makeMockDriver(capabilitiesResult: GetCapabilitiesResult): MockProviderDriver {
  const interventionCalls: ApplyInterventionParams[] = [];
  return {
    interventionCalls,
    getCapabilities(): Promise<GetCapabilitiesResult> {
      return Promise.resolve(capabilitiesResult);
    },
    applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
      interventionCalls.push(params);
      // A driver without native support degrades so the orchestration layer can fall back.
      return Promise.resolve({ status: "degraded", fallbackAction: "queue_and_interrupt" });
    },
    createSession(): Promise<never> {
      return Promise.reject(new Error("createSession not exercised in this integration suite"));
    },
    resumeSession(): Promise<never> {
      return Promise.reject(new Error("resumeSession not exercised in this integration suite"));
    },
    startRun(): Promise<never> {
      return Promise.reject(new Error("startRun not exercised in this integration suite"));
    },
    interruptRun(): Promise<never> {
      return Promise.reject(new Error("interruptRun not exercised in this integration suite"));
    },
    forkConversation(): Promise<never> {
      return Promise.reject(new Error("forkConversation not exercised in this integration suite"));
    },
    respondToRequest(): Promise<never> {
      return Promise.reject(new Error("respondToRequest not exercised in this integration suite"));
    },
    setSessionGoal(): Promise<never> {
      return Promise.reject(new Error("setSessionGoal not exercised in this integration suite"));
    },
    clearSessionGoal(): Promise<never> {
      return Promise.reject(new Error("clearSessionGoal not exercised in this integration suite"));
    },
    closeSession(): Promise<never> {
      return Promise.reject(new Error("closeSession not exercised in this integration suite"));
    },
    listModels(): Promise<never> {
      return Promise.reject(new Error("listModels not exercised in this integration suite"));
    },
    listModes(): Promise<never> {
      return Promise.reject(new Error("listModes not exercised in this integration suite"));
    },
    probeAuth(): Promise<never> {
      return Promise.reject(new Error("probeAuth not exercised in this integration suite"));
    },
    exportTranscript(): Promise<never> {
      return Promise.reject(new Error("exportTranscript not exercised in this integration suite"));
    },
    replayTranscript(): Promise<never> {
      return Promise.reject(new Error("replayTranscript not exercised in this integration suite"));
    },
    compactContext(): Promise<never> {
      return Promise.reject(new Error("compactContext not exercised in this integration suite"));
    },
    listProviderCommands(): Promise<never> {
      return Promise.reject(
        new Error("listProviderCommands not exercised in this integration suite"),
      );
    },
  };
}

// ----------------------------------------------------------------------------
// Per-test lifecycle and composition root
// ----------------------------------------------------------------------------
// Each call returns a distinct timestamp so writes get distinct times.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

interface Stack {
  readonly writer: DriverCapabilitiesWriter;
  readonly bindingStore: RuntimeBindingStore;
  readonly registry: ProviderRegistry;
}

let db: DatabaseType;

// Wires the object graph over the current `db`.
function makeStack(): Stack {
  const clock: () => string = makeAdvancingClock();
  const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(db, clock);
  const bindingStore: RuntimeBindingStore = new RuntimeBindingStore(db, {
    now: makeAdvancingClock(),
    newId: (() => {
      let bindingIdCounter: number = 0;
      return () => `binding-${(bindingIdCounter++).toString()}`;
    })(),
  });
  const registry: ProviderRegistry = new ProviderRegistry();
  return { writer, bindingStore, registry };
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.open) {
    db.close();
  }
});

// ----------------------------------------------------------------------------
// Capability round-trip and cold-start re-seed
// ----------------------------------------------------------------------------

describe("Phase 2 integration — capability round-trip + cold-start re-seed", () => {
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
});

// ----------------------------------------------------------------------------
// Gate matrix at the integration boundary
// ----------------------------------------------------------------------------

describe("Phase 2 integration — gate matrix at the integration boundary", () => {
  it("unregistered driver → driver.unavailable; declared-false → driver.capability_unsupported; declared-true → void", async () => {
    const { registry } = makeStack();

    // An id the registry has never seen.
    try {
      registry.checkCapability("ghost", "resume");
      expect.unreachable("checkCapability against an unregistered driver must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverUnavailableError);
      expect((error as DriverUnavailableError).code).toBe("driver.unavailable");
    }

    // A driver declaring `steer:false` and `resume:true`.
    await registry.register(
      DRIVER_NAME,
      makeMockDriver(
        makeResult({
          capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        }),
      ),
    );

    // Declared false: capability_unsupported.
    try {
      registry.checkCapability(DRIVER_NAME, "steer");
      expect.unreachable("checkCapability against a declared-false flag must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
    }

    // Declared true: void.
    expect(registry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Gate scope: applyIntervention is not gated
// ----------------------------------------------------------------------------

describe("Phase 2 integration — gate scope: applyIntervention is NOT pre-gated", () => {
  it("a steer:false driver still receives applyIntervention(steer) directly and returns a degraded result", async () => {
    const { registry } = makeStack();

    const driver = makeMockDriver(
      makeResult({
        capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
      }),
    );
    await registry.register(DRIVER_NAME, driver);

    // The registry gates `steer` for a direct capability-bound call...
    expect(() => registry.checkCapability(DRIVER_NAME, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // ...but `applyIntervention` is outside the gate: the orchestration layer reaches the driver
    // through `lookup` so it can return a degraded fallback.
    const resolved = registry.lookup(DRIVER_NAME);
    expect(resolved).toBe(driver);
    if (resolved === undefined) return;

    const steerParams: ApplyInterventionParams = {
      type: "steer",
      targetRunId: "run-1" as RunId,
      expectedRunVersion: 1,
      // A real UUID, the shape a caller mints, so the fixture stays a legitimate steer dispatch and
      // a malformed param cannot muddy which layer let the call through.
      clientIdempotencyKey: "00000000-0000-4000-8000-000000000001",
      payload: { content: "please change direction" },
    };
    const result = await resolved.applyIntervention(steerParams);

    // The call reached the mock...
    expect(driver.interventionCalls).toHaveLength(1);
    expect(driver.interventionCalls[0]?.type).toBe("steer");
    expect(result.status).toBe("degraded");
  });
});

// ----------------------------------------------------------------------------
// Daemon-local authority: binding linkage and fresh-store cold read
// ----------------------------------------------------------------------------

describe("Phase 2 integration — daemon-local authority (binding linkage)", () => {
  it("a runtime binding round-trips through findById/findByRun AND a FRESH store over the same db, cohering with the registered + hydrated driver identity", async () => {
    const { writer, bindingStore, registry } = makeStack();

    // Establish the driver in the registry, the capability cache and the binding over one db.
    const advertised: GetCapabilitiesResult = makeResult();
    await registry.register(DRIVER_NAME, makeMockDriver(advertised));
    await writer.declare({
      driverName: DRIVER_NAME,
      result: advertised,
    });
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));

    // The provider contributes only opaque strings, here the `resumeHandle`; the run-to-driver
    // binding stays daemon-local. The spawn config carries real content (posture and executable
    // path) so the cold read shows the record survives, not merely parses.
    const created = bindingStore.create({
      runId: "run-1",
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "opaque-provider-resume-handle-abc",
      spawnConfig: SPAWN_CONFIG,
    });

    // Read back through both accessors on the live store.
    expect(bindingStore.findById(created.id)).toEqual(created);
    expect(bindingStore.findByRun("run-1")).toEqual([created]);

    // A fresh store over the same db reads the binding from SQLite, not from in-memory state.
    const freshStore: RuntimeBindingStore = new RuntimeBindingStore(db, {});
    const reread = freshStore.findById(created.id);
    expect(reread).toBeDefined();
    if (reread === undefined) return;

    // The binding, the capability cache and the registry resolve to the same driver identity.
    expect(reread.driverName).toBe(DRIVER_NAME);
    expect(registry.lookup(DRIVER_NAME)).toBeDefined();
    // The contract version agrees across the binding and the capability cache.
    expect(reread.contractVersion).toBe(CONTRACT_VERSION);
    expect(reread.contractVersion).toBe(hydrated.capabilities.contractVersion);
    // The opaque provider handle survived the cold read...
    expect(reread.resumeHandle).toBe("opaque-provider-resume-handle-abc");
    // ...and so did the daemon-owned spawn config that recovery re-reads to rebuild the resume
    // params. `toStrictEqual` so an absent member cannot pass as `undefined`: a resume without its
    // posture would relaunch unsandboxed.
    expect(reread.spawnConfig).toStrictEqual(SPAWN_CONFIG);
    expect(reread.spawnConfig.executionPosture).toStrictEqual(EXECUTION_POSTURE);
  });
});

// ----------------------------------------------------------------------------
// Refresh: a changed declare flips the registry gate
// ----------------------------------------------------------------------------

describe("refresh seam coherence (changed → re-hydrate → registry gate flips)", () => {
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

// ----------------------------------------------------------------------------
// The durable cli-version pair enables the cold-start re-seed
// ----------------------------------------------------------------------------

describe("Phase 2 integration — durable cliVersion currency gates the cold-start re-seed", () => {
  it("a declared cliVersion round-trips out of the cache and re-seeds registry-B unaided; NULLing the pair makes hydration miss with cli_version_missing so the stack must refresh from the live driver", async () => {
    const { writer, registry } = makeStack();

    const advertised: GetCapabilitiesResult = makeResult();
    await registry.register(DRIVER_NAME, makeMockDriver(advertised));
    await writer.declare({
      driverName: DRIVER_NAME,
      result: advertised,
    });

    // The hit arm carries the declared reading out of the durable cache. The writer suite proves
    // the pair persists; only the composition shows the re-seed needs no live `cliVersion` from
    // the caller.
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.cliVersion).toEqual(CLI_VERSION_REPORT);

    // The cache's own object registers with nothing spread onto it, and the re-seeded registry
    // gates identically.
    const registryB: ProviderRegistry = new ProviderRegistry();
    await registryB.register(DRIVER_NAME, makeMockDriver(hydrated));
    expect(registryB.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
    expect(() => registryB.checkCapability(DRIVER_NAME, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // A NULL-pair row, staged by direct SQL because the write seam cannot produce one. Both columns
    // go in one statement because the both-or-neither CHECK rejects NULLing just one.
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);

    // Hydration now misses and names the cause. The capability rows are intact; the miss is about
    // the version, which must not be fabricated because the attach-time floor gate fails closed on
    // it.
    expect(writer.hydrate(DRIVER_NAME)).toEqual({
      hit: false,
      reason: "cli_version_missing",
    });

    // No cached snapshot remains to re-seed from, so the only remedy is the live driver.
    // Registering from it still gates as before, so the miss is a refresh instruction, not an
    // outage.
    const coldRegistry: ProviderRegistry = new ProviderRegistry();
    await coldRegistry.register(DRIVER_NAME, makeMockDriver(advertised));
    expect(coldRegistry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();

    // Re-declaring with a live reading repairs the pair (capabilities unchanged) and hydration hits
    // again; without that the driver would never hydrate on a cold start.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: advertised,
      }),
    ).toEqual({ snapshotChange: "unchanged", cliVersionRefreshed: true });
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME))).toEqual(advertised);
  });
});
