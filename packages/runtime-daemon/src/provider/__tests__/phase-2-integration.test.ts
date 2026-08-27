// Phase-2 end-to-end integration — RuntimeBindingStore + ProviderRegistry +
// DriverCapabilitiesWriter wired together over ONE real Local SQLite handle
// (Plan-005 §Phase 2 / T2.5).
//
// This is the CROSS-COMPONENT integration suite. Each of the three components
// owns its own unit suite (`runtime-binding-store.test.ts`,
// `provider-registry.test.ts`, `driver-capabilities-writer.test.ts`); this file
// deliberately does NOT duplicate that per-component coverage. It exercises the
// round-trip that only emerges when the three are composed over a shared
// connection plus a single mock at the conceptually-remote provider boundary —
// the `ProviderDriver`. The composition mirrors the production root:
//   SessionService(db) → RuntimeNodeEventEmitter({ sessionEvents, newEventId })
//   → DriverCapabilitiesWriter(db, emitter, now), with RuntimeBindingStore(db)
//   and ProviderRegistry() over the SAME `db` (the T2.5 wiring contract — the
//   writer's atomic dual-write depends on the emitter appending on this
//   connection).
//
// Coverage map (cites are the authoritative contract, not just the ACs):
//   * `Spec-005 §Required Behavior` (the runtime treats undeclared capabilities as unsupported):
//     `checkCapability` gates the integration boundary across registry-A,
//     the cold-start re-seeded registry-B, and the refreshed registry.
//   * `Spec-005 §Required Behavior` (drivers persist provider-owned resume handles separately
//     from canonical session/run ids): `RuntimeBindingStore.create` carries the
//     opaque `resumeHandle` beside the DAEMON-owned `spawnConfig` record (T2.6),
//     and the binding round-trips through a FRESH store over the same `db` with
//     both halves intact.
//   * T2.6 (the durable `driver_contract_meta` CLI-version pair): the
//     COMPOSITION-level consequence, not the per-component persistence proof
//     (`driver-capabilities-writer.test.ts` owns that) — a hydration hit now
//     re-seeds a cold-start registry UNAIDED, and a NULL pair collapses that
//     path into a `cli_version_missing` miss whose only remedy is a refresh from
//     the live driver.
//   * `Spec-005 §Acceptance Criteria` (AC2 — unsupported capabilities remain unavailable and
//     cannot be invoked accidentally): the capability round-trip + cold-start
//     re-seed proves the durable cache reconstitutes the gating set identically
//     across a daemon restart.
//   * `Spec-005 §Required Behavior` + ADR-011 (intervention dispatch routes by type to the driver;
//     a driver lacking native support returns a `degraded` result): the gate's
//     SCOPE boundary — `applyIntervention` is NOT pre-gated, so a `steer:false`
//     driver still receives the steer call and degrades.
//   * CP-005-5 (the emitted `capability` is the `"provider-driver-<driverName>"`
//     suffixed key): asserted as the literal `"provider-driver-claude"`.
//   * I-005-1 (driver authority remains local even when the provider endpoint is
//     remote): the run↔driver binding, the capability cache, and the registry
//     all resolve to the SAME daemon-local driver identity; no state is sourced
//     from the mock (conceptually-remote) provider beyond the opaque strings it
//     declared, and the binding survives a fresh-store cold read.
//   * I-005-2 (undeclared capability = unsupported): the gate matrix at the
//     integration boundary (unregistered → `driver.unavailable`; declared-false
//     → `driver.capability_unsupported`; declared-true → void).
//
// Refs: Plan-005 §Phase 2 / T2.5 + T2.6, `Spec-005 §Required Behavior` + `Spec-005 §Acceptance Criteria` (AC2),
// CP-005-1, CP-005-5, ADR-011, invariants I-005-1 + I-005-2.

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
  type SessionId,
} from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../../events/signer.js";
import type { DaemonSigningKeySource } from "../../events/signing-key-source.js";
import { RuntimeNodeEventEmitter } from "../../node/node-event-emitter.js";
import { openDatabase } from "../../session/migration-runner.js";
import { SessionService } from "../../session/session-service.js";
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

/**
 * Fixed-key {@link DaemonSigningKeySource} — this suite is about the producer's
 * dual-write, not key custody (`signing-key-source.test.ts` owns that).
 */
class FixedDaemonSigningKeySource implements DaemonSigningKeySource {
  readonly #privateKey: Ed25519PrivateKey = new Uint8Array(32).fill(7) as Ed25519PrivateKey;

  read(_sessionId: SessionId): Promise<Ed25519PrivateKey> {
    return Promise.resolve(this.#privateKey);
  }

  create(_sessionId: SessionId): Promise<{ readonly publicKey: Ed25519PublicKey }> {
    return Promise.reject(
      new Error("FixedDaemonSigningKeySource.create is not used by this suite"),
    );
  }
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const NODE_ID: string = "node-01J0ND0000NN5J5J5J5J5J5J";
const DRIVER_NAME: string = "claude";
// Canonical semver — accepted by the write-seam `assertValidContractVersion`
// used by BOTH the capability declare AND the binding `create`. Sharing ONE
// version across the two write seams is what makes the I-005-1 coherence
// assertion (binding.contractVersion === hydrated.contractVersion) hold by
// construction, not by coincidence.
const CONTRACT_VERSION: string = "1.2.3";
// The CP-005-5 suffixed capability key for this driver — the literal the writer
// must emit on every `runtime_node.capability_*` event.
const CAPABILITY_KEY: string = "provider-driver-claude";

// ----------------------------------------------------------------------------
// Flag + result fixtures (sourced from the canonical DRIVER_CAPABILITY_FLAGS —
// NO hardcoded copy of the flag set)
// ----------------------------------------------------------------------------

// The full flag matrix every snapshot must answer (Record<DriverCapabilityFlag>
// — un-omittable by the contract type). Every flag defaults false, then the
// baseline-true pair (`resume`, `tool_calls`), then per-test overrides.
function makeFlags(
  overrides: Partial<Record<DriverCapabilityFlag, boolean>> = {},
): Record<DriverCapabilityFlag, boolean> {
  const base = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { ...base, resume: true, tool_calls: true, ...overrides };
}

// The REQUIRED `cliVersion` reading (T1.8) every advertised snapshot carries.
// Post-T2.6 it is ALSO a durable property of the capability cache: the writer
// persists the `driver_contract_meta.cli_version_raw` / `cli_version_semver`
// pair on every mutating declare, so `hydrate()` reproduces this exact reading
// and the cold-start re-seeds below carry it out of the CACHE rather than
// re-attaching it from the live driver.
const CLI_VERSION_REPORT: DriverCliVersionReport = {
  raw: "mock-provider-cli 2.1.234 (build 7)",
  semver: "2.1.234",
};

// The spawn-bound record a REAL spawn of this stack would realize (T2.6,
// CP-005-1): the posture the process was sandboxed under plus the executable
// path the spawn resolved. Two members rather than the full closed key set —
// this suite's claim is that the daemon-local record survives the cold read
// intact, not that every member parses (`runtime-binding-store.test.ts` owns the
// full-key-set round-trip). `{}` would have satisfied the compiler and proved
// nothing.
const EXECUTION_POSTURE: ExecutionPosture = {
  networkAccess: "none",
  writableRoots: ["/workspace/repo"],
  mode: "trusted",
};

const SPAWN_CONFIG: RuntimeBindingSpawnConfig = {
  executionPosture: EXECUTION_POSTURE,
  resolvedExecutablePath: "/opt/homebrew/bin/claude",
};

// The driver's advertised snapshot. Tools are declared already in canonical
// (name-ascending) order WITH an explicit `idempotency_class`, so the declared
// input is byte-identical to the `hydrate()` output — the AC2 round-trip is then
// an identity check rather than a normalize-and-sort comparison.
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
 * Narrow a {@link DriverCapabilityHydrationResult} to its HIT arm, throwing a
 * reason-carrying error on a miss.
 *
 * Deliberately a THROW rather than the `expect(x).toBeDefined(); if (x ===
 * undefined) return;` shape this file used pre-T2.6: that guard's early return
 * made a hydration failure PASS the test silently. Post-T2.6 `hydrate()` cannot
 * return `undefined` at all — it returns an explicit miss whose `reason` this
 * helper surfaces in the failure message, so a regression that turns a hit into
 * a miss names its own cause.
 *
 * Defined locally rather than imported from `driver-capabilities-writer.test.ts`
 * (test files are leaves; a cross-suite import would couple two independent
 * suites' fixtures).
 */
function expectHydrationHit(hydrated: DriverCapabilityHydrationResult): GetCapabilitiesResult {
  if (!hydrated.hit) {
    throw new Error(`expected a hydration HIT; got a miss with reason "${hydrated.reason}"`);
  }
  return hydrated.result;
}

// ----------------------------------------------------------------------------
// Mock ProviderDriver — the ONLY test double (the conceptually-remote provider
// boundary). Implements every method the `ProviderDriver` interface requires.
// ----------------------------------------------------------------------------

interface MockProviderDriver extends ProviderDriver {
  // The interventions the registry let through to the driver (the "reached the
  // mock" evidence for the gate-scope boundary test).
  readonly interventionCalls: ApplyInterventionParams[];
}

// Build a mock driver that advertises `capabilitiesResult` and records every
// `applyIntervention` it receives. A factory so registry-B (cold-start re-seed)
// and the refresh seam can each hand a DIFFERENT advertised result — the
// registry caches `getCapabilities()` once per registration, so a distinct
// result per registration is what drives the gate to behave differently.
//
// The 12 methods this suite does not exercise are throwing stubs (typed
// `Promise<never>`, assignable to every declared return) — a call to one is a
// test bug, not a silent no-op. `getCapabilities` + `applyIntervention` carry
// REAL behavior.
function makeMockDriver(capabilitiesResult: GetCapabilitiesResult): MockProviderDriver {
  const interventionCalls: ApplyInterventionParams[] = [];
  return {
    interventionCalls,
    getCapabilities(): Promise<GetCapabilitiesResult> {
      return Promise.resolve(capabilitiesResult);
    },
    applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult> {
      interventionCalls.push(params);
      // A driver lacking native support for the requested intervention returns a
      // `degraded` result so the orchestration layer can fall back (`Spec-005 §Required Behavior`,
      // ADR-011). `fallbackAction` is the suggested fallback hint.
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
    rollbackTo(): Promise<never> {
      return Promise.reject(new Error("rollbackTo not exercised in this integration suite"));
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
  };
}

// ----------------------------------------------------------------------------
// Per-test lifecycle + composition root
// ----------------------------------------------------------------------------

// An ADVANCING clock: each call returns a distinct timestamp, so capability and
// binding writes get monotonically distinct `refreshed_at` / timestamp values.
function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}

interface Stack {
  readonly sessionService: SessionService;
  readonly writer: DriverCapabilitiesWriter;
  readonly bindingStore: RuntimeBindingStore;
  readonly registry: ProviderRegistry;
}

let db: DatabaseType;

// Wire the Phase-2 object graph over the current `db`. A collision-free
// deterministic event-id source so `session_events.id` (TEXT PRIMARY KEY) never
// collides across the multiple emits a declared→updated sequence produces. The
// seam is ASYNC-TRANSACTIONAL post the Plan-006 T3.1 re-point
// (node-event-emitter.ts's header owns the contract): `EventLogService.append`
// over the SAME connection backs it, which is what lets every producer's
// prelude join the append's transaction.
function makeStack(): Stack {
  let eventIdCounter: number = 0;
  const emitter: RuntimeNodeEventEmitter = new RuntimeNodeEventEmitter({
    // The production append path over the SAME connection every producer in this
    // graph uses — the preludes must join its transaction.
    sessionEvents: new EventLogService({
      db,
      signingKeySource: new FixedDaemonSigningKeySource(),
    }),
    newEventId: () => `evt-${(eventIdCounter++).toString()}`,
  });
  const clock: () => string = makeAdvancingClock();
  const writer: DriverCapabilitiesWriter = new DriverCapabilitiesWriter(db, emitter, clock);
  const bindingStore: RuntimeBindingStore = new RuntimeBindingStore(db, {
    now: makeAdvancingClock(),
    newId: (() => {
      let bindingIdCounter: number = 0;
      return () => `binding-${(bindingIdCounter++).toString()}`;
    })(),
  });
  const registry: ProviderRegistry = new ProviderRegistry();
  // READ-ONLY SessionService: `readEvents` needs no append opt-in, and the
  // writes in this stack now go through EventLogService. Constructing it
  // WITHOUT the capability token is the point — nothing in this graph may reach
  // the guarded placeholder append any more.
  const sessionService: SessionService = new SessionService(db);
  return { sessionService, writer, bindingStore, registry };
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  // The per-session append lock is a module singleton — reset between cases so
  // a leftover queue entry cannot stall the next case as an unrelated timeout.
  __resetSessionAppendLocksForTest();
  if (db.open) {
    db.close();
  }
});

// ----------------------------------------------------------------------------
// (1) AC2 — capability round-trip + cold-start re-seed (`Spec-005 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — AC2 capability round-trip + cold-start re-seed", () => {
  it("registry gate, declare, hydrate, and a re-seeded registry-B all agree on the gating set across a daemon restart", async () => {
    const { sessionService, writer, registry } = makeStack();

    // The mock advertises: steer:false, resume:true, tool_calls:true, plus a
    // non-empty tools array.
    const advertised: GetCapabilitiesResult = makeResult({
      capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
    });
    const driver = makeMockDriver(advertised);

    // --- registry-A: the LIVE gate reads the snapshot resolved at register ---
    await registry.register(DRIVER_NAME, driver);
    // A declared-true flag passes (returns void).
    expect(registry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
    // A declared-false flag is gated.
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

    // --- declare: persist the snapshot to the durable cache + emit the event ---
    expect(
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: advertised,
      }),
    ).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // Read the emitted event back off SessionService (same connection): exactly
    // one capability_declared carrying the CP-005-5 suffixed key.
    const events = sessionService.readEvents(SESSION_ID);
    expect(events).toHaveLength(1);
    const declaredEvent = events[0];
    expect(declaredEvent).toBeDefined();
    if (declaredEvent === undefined) return;
    expect(declaredEvent.type).toBe("runtime_node.capability_declared");
    expect(declaredEvent.payload["capability"]).toBe(CAPABILITY_KEY);

    // --- hydrate: the durable cache reconstructs the nested wrapper faithfully ---
    // Asserted as the WHOLE `GetCapabilitiesResult` (not member-by-member): post
    // T2.6 the hit arm carries `cliVersion` too, so the cache round-trip is now a
    // whole-object identity against what the driver advertised. A member-wise
    // assertion would let a silently-dropped `cliVersion` pass.
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated).toEqual(advertised);
    expect(hydrated.capabilities.flags).toEqual(makeFlags({ steer: false }));
    expect(hydrated.capabilities.contractVersion).toBe(CONTRACT_VERSION);
    expect(hydrated.tools).toEqual([
      { name: "search", idempotency_class: "idempotent", description: "search the web" },
    ]);
    expect(hydrated.cliVersion).toEqual(CLI_VERSION_REPORT);

    // --- cold-start re-seed: registry-B is fed the HYDRATED cache (NOT the live
    // driver). It must gate IDENTICALLY to registry-A — the AC2 round-trip proof
    // that the persisted cache reconstitutes the gating set across a restart. ---
    const registryB: ProviderRegistry = new ProviderRegistry();
    // The hydrated snapshot is now a COMPLETE `GetCapabilitiesResult` — T2.6's
    // durable version pair means the re-seed hands the cache's own object across
    // UNMODIFIED. It is deliberately NOT spread with a re-attached
    // `CLI_VERSION_REPORT` any more: doing so would re-inject the live reading
    // and mask a cache that had dropped it.
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
// (2) I-005-2 — gate matrix at the integration boundary (`Spec-005 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — I-005-2 gate matrix at the integration boundary", () => {
  it("unregistered driver → driver.unavailable; declared-false → driver.capability_unsupported; declared-true → void", async () => {
    const { registry } = makeStack();

    // Unregistered id — the registry has never seen it.
    try {
      registry.checkCapability("ghost", "resume");
      expect.unreachable("checkCapability against an unregistered driver must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverUnavailableError);
      expect((error as DriverUnavailableError).code).toBe("driver.unavailable");
    }

    // Register a driver that declares `steer:false`, `resume:true`.
    await registry.register(
      DRIVER_NAME,
      makeMockDriver(
        makeResult({
          capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        }),
      ),
    );

    // Registered, flag declared false → capability_unsupported.
    try {
      registry.checkCapability(DRIVER_NAME, "steer");
      expect.unreachable("checkCapability against a declared-false flag must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((error as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
    }

    // Registered, flag declared true → void.
    expect(registry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// (3) I-005-2 gate SCOPE / ADR-011 non-gating boundary (`Spec-005 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — gate scope: applyIntervention is NOT pre-gated (ADR-011)", () => {
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

    // ...but `applyIntervention` is OUTSIDE that gate's scope: the orchestration
    // layer reaches the driver directly so it can return a degraded fallback. The
    // registry exposes the driver via `lookup`, and there is NO branch that
    // blocks the steer intervention before it reaches the mock.
    const resolved = registry.lookup(DRIVER_NAME);
    expect(resolved).toBe(driver);
    if (resolved === undefined) return;

    const steerParams: ApplyInterventionParams = {
      type: "steer",
      targetRunId: "run-1" as RunId,
      expectedRunVersion: 1,
      // The requester-generated dedupe key the contract makes mandatory on every
      // dispatch arm. Carried honestly (a real UUID, the shape a caller mints)
      // rather than stubbed, so this fixture stays a legitimate steer dispatch —
      // the gate-scope claim is about what the registry does NOT block, and a
      // malformed param would muddy which layer let the call through.
      clientIdempotencyKey: "00000000-0000-4000-8000-000000000001",
      payload: { content: "please change direction" },
    };
    const result = await resolved.applyIntervention(steerParams);

    // The call REACHED the mock (it was not blocked by a capability gate)...
    expect(driver.interventionCalls).toHaveLength(1);
    expect(driver.interventionCalls[0]?.type).toBe("steer");
    // ...and degraded per ADR-011 / `Spec-005 §Required Behavior`.
    expect(result.status).toBe("degraded");
  });
});

// ----------------------------------------------------------------------------
// (4) I-005-1 — daemon-local authority (binding linkage + fresh-store cold read)
//     (`Spec-005 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — I-005-1 daemon-local authority (binding linkage)", () => {
  it("a runtime binding round-trips through findById/findByRun AND a FRESH store over the same db, cohering with the registered + hydrated driver identity", async () => {
    const { writer, bindingStore, registry } = makeStack();

    // Establish the driver across all three component identities over one db:
    //   registry (live), capability cache (declare/hydrate), binding (create).
    const advertised: GetCapabilitiesResult = makeResult();
    await registry.register(DRIVER_NAME, makeMockDriver(advertised));
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: advertised,
    });
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));

    // The provider's ONLY contribution is the opaque strings it declared — here
    // the `resumeHandle` (`Spec-005 §Required Behavior`, persisted separately from canonical
    // session/run ids). Authority over the run↔driver binding stays daemon-local.
    //
    // `spawnConfig` is the DAEMON-owned half of that split and is REQUIRED at
    // this seam (T2.6): every binding write IS a spawn, and the record here is
    // what recovery re-reads to rebuild `ResumeSessionParams`. It carries the two
    // legs a real spawn of this stack realizes — the execution posture the
    // process was sandboxed under and the executable path the spawn resolved —
    // rather than `{}`, so the cold read below proves the daemon-local record
    // survives with CONTENT rather than merely parsing.
    const created = bindingStore.create({
      runId: "run-1",
      driverName: DRIVER_NAME,
      contractVersion: CONTRACT_VERSION,
      resumeHandle: "opaque-provider-resume-handle-abc",
      spawnConfig: SPAWN_CONFIG,
    });

    // Read back via both store accessors on the live store.
    expect(bindingStore.findById(created.id)).toEqual(created);
    expect(bindingStore.findByRun("run-1")).toEqual([created]);

    // FRESH store over the SAME db (a store cold-start, proving durability +
    // daemon-local authority — the binding is read back from disk-equivalent
    // SQLite state, not from in-memory store state).
    const freshStore: RuntimeBindingStore = new RuntimeBindingStore(db, {});
    const reread = freshStore.findById(created.id);
    expect(reread).toBeDefined();
    if (reread === undefined) return;

    // The run↔driver binding, the capability cache, and the registry all resolve
    // to the SAME daemon-local driver identity.
    expect(reread.driverName).toBe(DRIVER_NAME);
    expect(registry.lookup(DRIVER_NAME)).toBeDefined();
    // contract_version coheres across the binding cache and the capability cache.
    expect(reread.contractVersion).toBe(CONTRACT_VERSION);
    expect(reread.contractVersion).toBe(hydrated.capabilities.contractVersion);
    // The opaque provider-owned handle survived the cold read.
    expect(reread.resumeHandle).toBe("opaque-provider-resume-handle-abc");
    // ...and so did the DAEMON-owned half of the split: the spawn-bound record
    // recovery re-reads to rebuild `ResumeSessionParams`. `toStrictEqual`, not
    // `toEqual`, so an absent member cannot pass as `undefined` — the failure
    // this pins is a posture-less resume relaunching UNSANDBOXED after a
    // cold start.
    expect(reread.spawnConfig).toStrictEqual(SPAWN_CONFIG);
    expect(reread.spawnConfig.executionPosture).toStrictEqual(EXECUTION_POSTURE);
  });
});

// ----------------------------------------------------------------------------
// (5) Refresh seam coherence — declare 'updated' ties to the registry refresh
//     (`Spec-005 §Required Behavior` + CP-005-5)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — refresh seam coherence (updated → re-hydrate → registry gate flips)", () => {
  it("flipping steer false→true emits capability_updated, re-hydrates, and a registry from the refreshed cache now passes steer", async () => {
    const { sessionService, writer } = makeStack();

    // Initial declare: steer:false.
    expect(
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({ emitted: "declared", cliVersionRefreshed: true });

    // Refreshed declare: steer:true — a real change → updated.
    expect(
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({
      emitted: "updated",
      // FALSE, and that is the discriminating value: the capability matrix
      // changed but `makeResult` re-declares the SAME `CLI_VERSION_REPORT`, so
      // the version pair this write restated did NOT differ from the pair the
      // deciding read observed. A `cliVersionRefreshed` wired to "a statement
      // ran" rather than "the pair changed" would report `true` here.
      cliVersionRefreshed: false,
    });

    // The timeline carries declared THEN updated, the update bearing the suffixed
    // capability key (CP-005-5).
    const events = sessionService.readEvents(SESSION_ID);
    expect(events.map((event) => event.type)).toEqual([
      "runtime_node.capability_declared",
      "runtime_node.capability_updated",
    ]);
    const updatedEvent = events[1];
    expect(updatedEvent).toBeDefined();
    if (updatedEvent === undefined) return;
    expect(updatedEvent.payload["capability"]).toBe(CAPABILITY_KEY);

    // Re-hydrate the refreshed cache and register a registry from it: the gate
    // FLIPS — steer now passes (it was gated before the refresh).
    const refreshed: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(refreshed.capabilities.flags["steer"]).toBe(true);
    // The refreshed cache still carries the version pair — a capability refresh
    // must not drop the currency reading on its way through.
    expect(refreshed.cliVersion).toEqual(CLI_VERSION_REPORT);

    const refreshedRegistry: ProviderRegistry = new ProviderRegistry();
    // Handed across UNMODIFIED (see the registry-B re-seed above).
    await refreshedRegistry.register(DRIVER_NAME, makeMockDriver(refreshed));
    expect(refreshedRegistry.checkCapability(DRIVER_NAME, "steer")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// (6) T2.6 — the durable cli_version pair is what makes the cold-start re-seed
//     SELF-SUFFICIENT (`Spec-005 §Required Behavior`)
// ----------------------------------------------------------------------------

describe("Phase 2 integration — durable cliVersion currency gates the cold-start re-seed", () => {
  it("a declared cliVersion round-trips out of the cache and re-seeds registry-B unaided; NULLing the pair makes hydration miss with cli_version_missing so the stack must refresh from the live driver", async () => {
    const { writer, registry } = makeStack();

    const advertised: GetCapabilitiesResult = makeResult();
    await registry.register(DRIVER_NAME, makeMockDriver(advertised));
    await writer.declare({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      driverName: DRIVER_NAME,
      result: advertised,
    });

    // --- the hit arm carries the DECLARED reading, out of the durable cache ---
    // `driver-capabilities-writer.test.ts` owns the per-component proof that the
    // pair persists and that a NULL pair reads as a miss. What only the
    // COMPOSITION can show is the consequence: whether the cold-start re-seed
    // path is self-sufficient. Pre-T2.6 it was not — the caller had to re-attach
    // a live `cliVersion` because the cache held none.
    const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(hydrated.cliVersion).toEqual(CLI_VERSION_REPORT);

    // Self-sufficiency, asserted by CONSTRUCTION rather than by inspection: the
    // cache's own object registers as a complete `GetCapabilitiesResult` with
    // nothing spread onto it, and the re-seeded registry gates identically.
    const registryB: ProviderRegistry = new ProviderRegistry();
    await registryB.register(DRIVER_NAME, makeMockDriver(hydrated));
    expect(registryB.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
    expect(() => registryB.checkCapability(DRIVER_NAME, "steer")).toThrow(
      DriverCapabilityUnsupportedError,
    );

    // --- the pre-T1.7 row shape: parent row present, currency pair NULL ---
    // Staged by direct SQL because the write seam makes it unrepresentable, and
    // BOTH columns in one statement because the table's both-or-neither CHECK
    // rejects NULLing just one.
    db.prepare(
      `UPDATE driver_contract_meta
          SET cli_version_raw = NULL, cli_version_semver = NULL
        WHERE driver_name = ?`,
    ).run(DRIVER_NAME);

    // Hydration now MISSES, naming the cause. The capability rows are all still
    // present and reconstructible — the miss is about the VERSION, which is why
    // fabricating one here (rather than missing) would feed a false reading into
    // the attach-time floor gate that is fail-closed precisely against it.
    expect(writer.hydrate(DRIVER_NAME)).toEqual({
      hit: false,
      reason: "cli_version_missing",
    });

    // And the integration consequence: there is NO cached snapshot to re-seed a
    // cold-start registry from at all, so the composed stack's only remedy is to
    // go back to the live driver. Registering from the live driver still works —
    // the gating set is unchanged — which is what makes the miss a REFRESH
    // instruction rather than an outage.
    const coldRegistry: ProviderRegistry = new ProviderRegistry();
    await coldRegistry.register(DRIVER_NAME, makeMockDriver(advertised));
    expect(coldRegistry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();

    // The refresh lands back as a declare with a live reading, which self-heals
    // the row: the capability snapshot is identical (so no event), but the pair
    // is repaired and hydration becomes a hit again. Without that side-write the
    // driver would be permanently un-hydratable across every future cold start.
    expect(
      await writer.declare({
        sessionId: SESSION_ID,
        nodeId: NODE_ID,
        driverName: DRIVER_NAME,
        result: advertised,
      }),
    ).toEqual({ emitted: "noop", cliVersionRefreshed: true });
    expect(expectHydrationHit(writer.hydrate(DRIVER_NAME))).toEqual(advertised);
  });
});
