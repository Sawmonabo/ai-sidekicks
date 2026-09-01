// The `driver.*` JSON-RPC handler suite — Plan-005 Phase 4, T4.1.
//
// Everything here drives the REAL `MethodRegistryImpl` and, for the streaming
// method, the REAL `StreamingPrimitive`. A mock registry would prove only that
// the handler bodies run; the properties this suite is for — that malformed
// params never reach a handler, that a duplicate binding is refused at
// register-time, that a result is validated before it reaches the wire, that the
// four lifecycle operations are unreachable — are all properties OF the registry
// binding, and asserting them against a double would assert nothing.
//
// The four things worth stating up front, because they are the reason this file
// is long:
//   * DECISION #2 IS ENFORCED BY ABSENCE. `driver.createSession`,
//     `driver.resumeSession`, `driver.startRun`, and `driver.closeSession` are
//     registered nowhere, so a client that guesses the name gets
//     `method_not_found` from the substrate. That is asserted directly, because
//     "we did not write that code" is not a guarantee a future edit preserves.
//   * PROVIDER-LAYER ERRORS MUST REACH THE WIRE AS THEIR REGISTERED CODES. The
//     translation tests go one step past the thrown object and through
//     `mapJsonRpcError`, because the whole point of the translation is what the
//     CLIENT sees — and an untranslated `DriverUnavailableError` reaches it as a
//     bare `-32603` that looks exactly like a daemon crash.
//   * TWO OF THE NINE VERBS ARE IMPLEMENTED BY NEITHER SHIPPED DRIVER. That is
//     the state at this task's landing, so the unimplemented-operation refusal
//     is a live path rather than a defensive one.
//   * THE EVENT FILTER IS A GUARANTEE, NOT A CONVENIENCE. A non-driver event
//     parses cleanly against `SessionEventSchema`, so nothing on this side of
//     the wire would notice one leaking onto a driver subscription. The SDK's
//     `DriverEventSchema` catches such a leak, but by ENDING the subscription —
//     that is the client's backstop against a broken daemon, not a reason this
//     filter may relax.
//
// Refs: Plan-005 §Phase 4 / T4.1, invariants I-005-1 / I-005-2,
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants` I-007-6 … I-007-10.

import { describe, expect, it, vi } from "vitest";

import type {
  ApplyInterventionParams,
  DriverCapabilityFlag,
  DriverCapabilityReport,
  GetCapabilitiesResult,
  HandlerContext,
  JsonRpcNotification,
  ParticipantId,
  ProviderCommandBindingGroup,
  ProviderDriver,
  RunId,
  SessionEvent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DRIVER_CAPABILITY_FLAGS, JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";
import { StreamingPrimitive } from "../../streaming-primitive.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  ProviderRegistry,
} from "../../../provider/provider-registry.js";

import {
  registerDriverApplyIntervention,
  registerDriverCompactContext,
  registerDriverInterruptRun,
  registerDriverListCapabilities,
  registerDriverListModels,
  registerDriverListModes,
  registerDriverListProviderCommands,
  registerDriverRespondToRequest,
  type DriverCatalogDeps,
  type DriverCompactContextDeps,
  type DriverDispatchDeps,
  type DriverListCapabilitiesDeps,
  type DriverListProviderCommandsDeps,
} from "../driver-handlers.js";
import {
  registerDriverSubscribeEvents,
  type DriverSubscribeEventsDeps,
} from "../driver-subscribe.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001" as ParticipantId;
const TEST_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-00000000000a";
const NO_TRANSPORT: HandlerContext = {};
const TRANSPORT: HandlerContext = { transportId: 7 };

/**
 * Build a partial driver as a `ProviderDriver`.
 *
 * The cast mirrors production rather than papering over it: BOTH shipped drivers
 * are `Pick`-narrowed classes registered into a registry typed on the full
 * eighteen-operation contract, so a partially-implemented driver instance is the
 * shape these handlers actually receive.
 */
function driverDouble(operations: Partial<ProviderDriver>): ProviderDriver {
  return operations as ProviderDriver;
}

function capabilityReport(driverName: string): DriverCapabilityReport {
  // Flags built from the declared set rather than hand-listed: the reply is
  // validated against the REAL `ListCapabilitiesResultSchema`, whose flag record
  // is total, so a partial literal would fail result validation and mask
  // whatever the test was actually about.
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { driverName, capabilities: { flags, contractVersion: "1.0.0" } };
}

/** An `assistant_output` event — one of the seven driver categories. */
function buildDriverEvent(sequence: number): SessionEvent {
  return {
    id: `evt-${sequence}`,
    sessionId: TEST_SESSION_ID,
    sequence,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "assistant_output",
    type: "assistant.message",
    actor: TEST_PARTICIPANT_ID,
    version: "1.0" as SessionEvent["version"],
    payload: { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID },
  };
}

/** A `session_lifecycle` event — NOT one of the seven driver categories. */
function buildNonDriverEvent(): SessionEvent {
  return {
    id: "evt-non-driver",
    sessionId: TEST_SESSION_ID,
    sequence: 99,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: TEST_PARTICIPANT_ID,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: TEST_SESSION_ID,
      config: { resourceLimits: { sessions: 10 } },
      metadata: { source: "cli" },
    },
  };
}

/**
 * The `data` payload a thrown value projects into on the wire.
 *
 * The assertions go through the real mapper rather than reading `error.code` off
 * the thrown object, because the property under test is what the CLIENT sees: an
 * untranslated provider-layer error reaches it as a bare `-32603` with no
 * `data.type`, indistinguishable from a daemon crash, and only the mapper's
 * output can tell the two apart.
 */
function wireErrorData(thrown: unknown): { type?: string; fields?: Record<string, unknown> } {
  return (mapJsonRpcError(thrown, 1).error.data ?? {}) as {
    type?: string;
    fields?: Record<string, unknown>;
  };
}

function catalogDeps(drivers: Record<string, ProviderDriver>): DriverCatalogDeps {
  return {
    providerRegistry: {
      listAvailable: () => Object.keys(drivers),
      lookup: (driverId: string) => drivers[driverId],
    },
  };
}

function dispatchDeps(
  drivers: Record<string, ProviderDriver>,
  resolveDriverForRun: (runId: RunId) => string | undefined,
): DriverDispatchDeps {
  return {
    providerRegistry: { lookup: (driverId: string) => drivers[driverId] },
    resolveDriverForRun,
  };
}

const TEST_AGENT_ID = "770e8400-e29b-41d4-a716-446655440002";
const SECOND_SESSION_ID = "990e8400-e29b-41d4-a716-446655440003" as SessionId;
const TEST_BINDING_ID = "binding-1";

/**
 * The fail-closed capability gate as a double for the ADMITTING default paths:
 * `!== true` refuses with the registry's own error class, mirroring
 * `ProviderRegistry.checkCapability`. The two capability-REFUSAL tests do NOT
 * inject it — a double restating the guard it refuses with proves nothing
 * about the shipped gate, so they drive a real registry built by
 * `realProviderRegistry` instead.
 */
function capabilityGate(
  flagsByDriver: Record<string, Partial<Record<DriverCapabilityFlag, boolean>>>,
): (driverId: string, flag: DriverCapabilityFlag) => void {
  return (driverId, flag) => {
    if (flagsByDriver[driverId]?.[flag] !== true) {
      throw new DriverCapabilityUnsupportedError(driverId, flag);
    }
  };
}

/**
 * A REAL `ProviderRegistry`, seeded through its own `register()` round-trip.
 *
 * Injected by the two capability-refusal tests so the refusing gate under test
 * is the SHIPPED fail-close (`!== true`) inside `checkCapability` — a
 * `capabilityGate` double would keep those tests green if the real gate ever
 * went fail-open. Only `getCapabilities` carries seeding behavior (the one
 * member `register()` consumes); `operations` is the caller's dispatch spies,
 * so a dispatch that slipped past the real gate still fails the zero-call
 * assertions. The partial-driver cast is `driverDouble`'s own
 * production-mirroring idiom.
 */
async function realProviderRegistry(
  driverSeeds: Record<
    string,
    {
      flags: Partial<Record<DriverCapabilityFlag, boolean>>;
      operations: Partial<ProviderDriver>;
    }
  >,
): Promise<ProviderRegistry> {
  const providerRegistry = new ProviderRegistry();
  for (const [driverName, seed] of Object.entries(driverSeeds)) {
    // Total flag record derived from the declared set (the structural half of
    // I-005-2): undeclared flags are explicitly false, never absent.
    const flags = Object.fromEntries(
      DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, seed.flags[flag] ?? false]),
    ) as Record<DriverCapabilityFlag, boolean>;
    const capabilitiesResult: GetCapabilitiesResult = {
      capabilities: { flags, contractVersion: "1.0.0" },
      tools: [],
      cliVersion: { raw: "test-provider-cli 0.0.1", semver: "0.0.1" },
    };
    await providerRegistry.register(
      driverName,
      driverDouble({ ...seed.operations, getCapabilities: async () => capabilitiesResult }),
    );
  }
  return providerRegistry;
}

/**
 * Deps for `driver.compactContext` with a fully-admitting default path — member
 * session, permitted caller, one live `claude` binding, the capability declared
 * — so each test overrides exactly the seam it is about.
 */
function compactContextDeps(
  drivers: Record<string, ProviderDriver>,
  overrides: Partial<DriverCompactContextDeps> = {},
): DriverCompactContextDeps {
  return {
    providerRegistry: {
      lookup: (driverId: string) => drivers[driverId],
      checkCapability: capabilityGate({ claude: { context_compaction: true } }),
    },
    resolveSessionAccess: () => true,
    evaluateInterveneAction: () => "permit",
    resolveRunBinding: () => ({
      kind: "bound",
      driverName: "claude",
      bindingId: TEST_BINDING_ID,
    }),
    ...overrides,
  };
}

/** Deps for `driver.listProviderCommands`, same default-admitting shape. */
function listProviderCommandsDeps(
  drivers: Record<string, ProviderDriver>,
  overrides: Partial<DriverListProviderCommandsDeps> = {},
): DriverListProviderCommandsDeps {
  return {
    providerRegistry: {
      lookup: (driverId: string) => drivers[driverId],
      checkCapability: capabilityGate({ claude: { provider_commands: true } }),
    },
    resolveSessionAccess: () => true,
    resolveAgentBindings: () => ({
      kind: "bound",
      bindings: [{ driverName: "claude", bindingId: TEST_BINDING_ID }],
    }),
    ...overrides,
  };
}

/** One binding's group as its driver composes it — the handler must not touch it. */
function commandGroup(driverName: string, complete = true): ProviderCommandBindingGroup {
  return {
    runId: TEST_RUN_ID,
    binding: { driverName, providerAccountId: null },
    entries: [
      { name: "compact", kind: "command", binding: { driverName, providerAccountId: null } },
    ],
    complete,
  };
}

// ----------------------------------------------------------------------------
// Registration surface
// ----------------------------------------------------------------------------

describe("driver.* registration surface", () => {
  function bindAll(registry: MethodRegistryImpl): void {
    const drivers = { claude: driverDouble({}) };
    registerDriverListCapabilities(registry, {
      providerRegistry: { listAvailable: () => [] },
      capabilityCache: { read: capabilityReport },
    });
    registerDriverListModels(registry, catalogDeps(drivers));
    registerDriverListModes(registry, catalogDeps(drivers));
    registerDriverInterruptRun(
      registry,
      dispatchDeps(drivers, () => "claude"),
    );
    registerDriverApplyIntervention(
      registry,
      dispatchDeps(drivers, () => "claude"),
    );
    registerDriverRespondToRequest(
      registry,
      dispatchDeps(drivers, () => "claude"),
    );
    registerDriverCompactContext(registry, compactContextDeps(drivers));
    registerDriverListProviderCommands(registry, listProviderCommandsDeps(drivers));
    registerDriverSubscribeEvents(registry, {
      streamingPrimitive: new StreamingPrimitive({ send: () => undefined, registry }),
      subscribeToDriverEvents: () => () => undefined,
    });
  }

  it("binds exactly the nine client-facing names, with the ratified mutating flags", () => {
    const registry = new MethodRegistryImpl();
    bindAll(registry);

    // `false` on the reads and on subscribe so a version-mismatched connection
    // keeps read-only access (Spec-007 §Fallback Behavior); `true` on the four
    // that drive a live run.
    expect(registry.isMutating("driver.listCapabilities")).toBe(false);
    expect(registry.isMutating("driver.listModels")).toBe(false);
    expect(registry.isMutating("driver.listModes")).toBe(false);
    expect(registry.isMutating("driver.listProviderCommands")).toBe(false);
    expect(registry.isMutating("driver.subscribeEvents")).toBe(false);
    expect(registry.isMutating("driver.interruptRun")).toBe(true);
    expect(registry.isMutating("driver.applyIntervention")).toBe(true);
    expect(registry.isMutating("driver.respondToRequest")).toBe(true);
    expect(registry.isMutating("driver.compactContext")).toBe(true);
  });

  it("registers NONE of the four lifecycle operations NOR the four R8 parity operations", async () => {
    // Plan-005 §Phase 4 decision #2, enforced rather than documented: the
    // lifecycle four establish, restore, start, or tear down a domain object,
    // so a client reaching them would mint runtime state behind the
    // orchestrator's back. The R8 parity four (T4.8's absence half) stay
    // daemon-internal for the reason that decision records — each already has
    // its own client route (rollback through Plan-004's intervention path,
    // goals through Plan-016's surface, auth probes through the account
    // plane), and a second route here would fork one operation's authority.
    const registry = new MethodRegistryImpl();
    bindAll(registry);

    for (const method of [
      "driver.createSession",
      "driver.resumeSession",
      "driver.startRun",
      "driver.closeSession",
      "driver.rollbackTo",
      "driver.setSessionGoal",
      "driver.clearSessionGoal",
      "driver.probeAuth",
    ]) {
      expect(registry.has(method)).toBe(false);
      await expect(registry.dispatch(method, {}, NO_TRANSPORT)).rejects.toBeInstanceOf(
        RegistryDispatchError,
      );
    }
  });

  it("REFUSES a duplicate binding at register-time (I-007-6)", () => {
    const registry = new MethodRegistryImpl();
    const deps: DriverListCapabilitiesDeps = {
      providerRegistry: { listAvailable: () => [] },
      capabilityCache: { read: capabilityReport },
    };
    registerDriverListCapabilities(registry, deps);
    expect(() => {
      registerDriverListCapabilities(registry, deps);
    }).toThrowError(RegistryRegistrationError);
  });

  it("REFUSES a duplicate binding of either console-parity verb (I-007-6)", () => {
    const registry = new MethodRegistryImpl();
    const drivers = { claude: driverDouble({}) };
    const compactDeps = compactContextDeps(drivers);
    registerDriverCompactContext(registry, compactDeps);
    expect(() => {
      registerDriverCompactContext(registry, compactDeps);
    }).toThrowError(RegistryRegistrationError);

    const listDeps = listProviderCommandsDeps(drivers);
    registerDriverListProviderCommands(registry, listDeps);
    expect(() => {
      registerDriverListProviderCommands(registry, listDeps);
    }).toThrowError(RegistryRegistrationError);
  });
});

// ----------------------------------------------------------------------------
// driver.listCapabilities
// ----------------------------------------------------------------------------

describe("driver.listCapabilities", () => {
  it("serves the whole roster from the cache, sorted, with no driver round-trip", async () => {
    const registry = new MethodRegistryImpl();
    const read = vi.fn(capabilityReport);
    registerDriverListCapabilities(registry, {
      // Deliberately UNSORTED, so the sort is observed rather than inherited.
      providerRegistry: { listAvailable: () => ["codex", "claude"] },
      capabilityCache: { read },
    });

    const result = (await registry.dispatch("driver.listCapabilities", {}, NO_TRANSPORT)) as {
      drivers: DriverCapabilityReport[];
    };

    expect(result.drivers.map((entry) => entry.driverName)).toStrictEqual(["claude", "codex"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("REFUSES a payload carrying a driver selector (I-007-7, before the handler runs)", async () => {
    // The read is no-arg by ratified signature. The handler must never see the
    // request at all — a caller who believed `{ driverName }` filtered the reply
    // would otherwise get the whole roster and no indication it was ignored.
    const registry = new MethodRegistryImpl();
    const read = vi.fn(capabilityReport);
    registerDriverListCapabilities(registry, {
      providerRegistry: { listAvailable: () => ["claude"] },
      capabilityCache: { read },
    });

    await expect(
      registry.dispatch("driver.listCapabilities", { driverName: "claude" }, NO_TRANSPORT),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(read).not.toHaveBeenCalled();
  });

  it("fails the WHOLE read when one driver cannot be substantiated", async () => {
    // Omitting the driver would read to a client as "that driver declares no
    // capabilities", which is a different and false claim — the omission-versus-
    // empty confusion I-005-2 exists to prevent.
    const registry = new MethodRegistryImpl();
    registerDriverListCapabilities(registry, {
      providerRegistry: { listAvailable: () => ["claude", "codex"] },
      capabilityCache: {
        read: (driverName: string) => {
          if (driverName === "codex") {
            throw new DriverUnavailableError(driverName);
          }
          return capabilityReport(driverName);
        },
      },
    });

    await expect(registry.dispatch("driver.listCapabilities", {}, NO_TRANSPORT)).rejects.toThrow();
  });

  it("projects a provider-layer refusal onto its REGISTERED wire code", async () => {
    // The payoff of translating at this seam, asserted where it matters: without
    // it the envelope is a bare `-32603` with no `data.type` and a client cannot
    // tell an unavailable driver from a crashed daemon.
    const registry = new MethodRegistryImpl();
    registerDriverListCapabilities(registry, {
      providerRegistry: { listAvailable: () => ["codex"] },
      capabilityCache: {
        read: (driverName: string) => {
          throw new DriverUnavailableError(driverName);
        },
      },
    });

    const thrown = await registry
      .dispatch("driver.listCapabilities", {}, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.unavailable");
    expect(wireError.fields).toMatchObject({ driverId: "codex" });
  });
});

// ----------------------------------------------------------------------------
// driver.listModels / driver.listModes
// ----------------------------------------------------------------------------

describe("driver.listModels and driver.listModes", () => {
  it("groups each driver's catalog under its own name", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverListModels(
      registry,
      catalogDeps({
        codex: driverDouble({
          listModels: async () => [{ id: "gpt-5.6-luna", name: "Luna", capabilities: [] }],
        }),
        claude: driverDouble({
          listModels: async () => [{ id: "claude-haiku-4-5", name: "Haiku", capabilities: [] }],
        }),
      }),
    );

    const result = (await registry.dispatch("driver.listModels", {}, NO_TRANSPORT)) as {
      drivers: { driverName: string; models: { id: string }[] }[];
    };

    expect(result.drivers.map((entry) => entry.driverName)).toStrictEqual(["claude", "codex"]);
    expect(result.drivers[0]?.models[0]?.id).toBe("claude-haiku-4-5");
  });

  it("REFUSES an operation the resolved driver does not implement", async () => {
    // NOT hypothetical: neither shipped driver implements `listModes` at this
    // task's landing. Without the guard the call is `TypeError: driver.listModes
    // is not a function`, which reaches the client as a bare `-32603` — the
    // daemon reporting a crash for a driver that simply does not offer the
    // operation.
    const registry = new MethodRegistryImpl();
    registerDriverListModes(registry, catalogDeps({ claude: driverDouble({}) }));

    const thrown = await registry
      .dispatch("driver.listModes", {}, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.capability_unsupported");
    expect(wireError.fields).toMatchObject({ driverId: "claude", operation: "listModes" });
  });

  it("fails the whole read when one driver's catalog read rejects", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverListModels(
      registry,
      catalogDeps({
        claude: driverDouble({ listModels: async () => [] }),
        codex: driverDouble({
          listModels: async () => {
            throw new DriverUnavailableError("codex");
          },
        }),
      }),
    );

    const thrown = await registry
      .dispatch("driver.listModels", {}, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBe("driver.unavailable");
  });

  it("answers an empty roster with an empty group list", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverListModels(registry, catalogDeps({}));
    await expect(registry.dispatch("driver.listModels", {}, NO_TRANSPORT)).resolves.toStrictEqual({
      drivers: [],
    });
  });
});

// ----------------------------------------------------------------------------
// The three run-addressed verbs
// ----------------------------------------------------------------------------

describe("driver.interruptRun", () => {
  it("dispatches to the run's resolved driver and answers the empty ack", async () => {
    // `{}` and not `undefined`: the registry `safeParse`s the RESULT, so a
    // handler returning nothing would report a successful interrupt to the
    // client as an internal error.
    const registry = new MethodRegistryImpl();
    const interruptRun = vi.fn(async () => undefined);
    registerDriverInterruptRun(
      registry,
      dispatchDeps({ claude: driverDouble({ interruptRun }) }, () => "claude"),
    );

    await expect(
      registry.dispatch("driver.interruptRun", { runId: TEST_RUN_ID }, NO_TRANSPORT),
    ).resolves.toStrictEqual({});
    expect(interruptRun).toHaveBeenCalledWith({ runId: TEST_RUN_ID });
  });

  it("resolves the run ONCE per dispatch", async () => {
    // The resolver reads live binding state, so two calls can disagree and a
    // handler acting on one answer while reporting the other would attribute a
    // refusal to the wrong driver.
    const registry = new MethodRegistryImpl();
    const resolveDriverForRun = vi.fn(() => "claude");
    registerDriverInterruptRun(
      registry,
      dispatchDeps(
        { claude: driverDouble({ interruptRun: async () => undefined }) },
        resolveDriverForRun,
      ),
    );

    await registry.dispatch("driver.interruptRun", { runId: TEST_RUN_ID }, NO_TRANSPORT);
    expect(resolveDriverForRun).toHaveBeenCalledTimes(1);
  });

  it("refuses an unresolvable run as run.not_found, BEFORE any availability check", async () => {
    // Address first, availability second. Reporting a driver problem for a run
    // id that never existed sends a caller to fix the wrong thing.
    const registry = new MethodRegistryImpl();
    const lookup = vi.fn(() => undefined);
    registerDriverInterruptRun(registry, {
      providerRegistry: { lookup },
      resolveDriverForRun: () => undefined,
    });

    const thrown = await registry
      .dispatch("driver.interruptRun", { runId: TEST_RUN_ID }, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("run.not_found");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a run bound to a driver this node has not loaded", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverInterruptRun(
      registry,
      dispatchDeps({}, () => "codex"),
    );

    const thrown = await registry
      .dispatch("driver.interruptRun", { runId: TEST_RUN_ID }, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBe("driver.unavailable");
  });

  it("REFUSES a non-UUID run id before the resolver is consulted (I-007-7)", async () => {
    const registry = new MethodRegistryImpl();
    const resolveDriverForRun = vi.fn(() => "claude");
    registerDriverInterruptRun(registry, dispatchDeps({}, resolveDriverForRun));

    await expect(
      registry.dispatch("driver.interruptRun", { runId: "run-1" }, NO_TRANSPORT),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(resolveDriverForRun).not.toHaveBeenCalled();
  });
});

describe("driver.applyIntervention", () => {
  const steer: ApplyInterventionParams = {
    type: "steer",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
    payload: { content: "use the other branch" },
  };

  it("returns a DEGRADED envelope as data, not as an error (ADR-011)", async () => {
    // The reason this verb is not pre-gated by `checkCapability`: an unsupported
    // intervention must reach the driver so it can answer with a usable fallback
    // hint. A gate here would replace that hint with a refusal.
    const registry = new MethodRegistryImpl();
    registerDriverApplyIntervention(
      registry,
      dispatchDeps(
        {
          claude: driverDouble({
            applyIntervention: async () => ({
              status: "degraded",
              fallbackAction: "queue_and_interrupt",
            }),
          }),
        },
        () => "claude",
      ),
    );

    await expect(
      registry.dispatch("driver.applyIntervention", steer, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "degraded", fallbackAction: "queue_and_interrupt" });
  });

  it("REFUSES a rollback arm before the driver is resolved", async () => {
    const registry = new MethodRegistryImpl();
    const resolveDriverForRun = vi.fn(() => "claude");
    registerDriverApplyIntervention(registry, dispatchDeps({}, resolveDriverForRun));

    await expect(
      registry.dispatch(
        "driver.applyIntervention",
        { ...steer, type: "rollback", payload: {} },
        NO_TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(resolveDriverForRun).not.toHaveBeenCalled();
  });

  it("REFUSES a caller-chosen idempotency key that is not a UUID", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverApplyIntervention(
      registry,
      dispatchDeps({}, () => "claude"),
    );

    await expect(
      registry.dispatch(
        "driver.applyIntervention",
        { ...steer, clientIdempotencyKey: "my-key" },
        NO_TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
  });
});

describe("driver.respondToRequest", () => {
  it("forwards the answer and returns the empty ack", async () => {
    const registry = new MethodRegistryImpl();
    const respondToRequest = vi.fn(async () => undefined);
    registerDriverRespondToRequest(
      registry,
      dispatchDeps({ claude: driverDouble({ respondToRequest }) }, () => "claude"),
    );

    await expect(
      registry.dispatch(
        "driver.respondToRequest",
        { runId: TEST_RUN_ID, requestId: "req-42", response: { choice: "b" } },
        NO_TRANSPORT,
      ),
    ).resolves.toStrictEqual({});
    expect(respondToRequest).toHaveBeenCalledWith({
      runId: TEST_RUN_ID,
      requestId: "req-42",
      response: { choice: "b" },
    });
  });

  it("REFUSES a request that omits the answer, before the driver is consulted", async () => {
    // A provider blocked on a structured question must not be handed "no
    // answer" as though it were one.
    const registry = new MethodRegistryImpl();
    const respondToRequest = vi.fn(async () => undefined);
    registerDriverRespondToRequest(
      registry,
      dispatchDeps({ claude: driverDouble({ respondToRequest }) }, () => "claude"),
    );

    await expect(
      registry.dispatch(
        "driver.respondToRequest",
        { runId: TEST_RUN_ID, requestId: "req-42" },
        NO_TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(respondToRequest).not.toHaveBeenCalled();
  });

  it("REFUSES the operation on a driver that does not implement it", async () => {
    // Also not hypothetical — neither shipped driver implements this one either.
    const registry = new MethodRegistryImpl();
    registerDriverRespondToRequest(
      registry,
      dispatchDeps({ claude: driverDouble({}) }, () => "claude"),
    );

    const thrown = await registry
      .dispatch(
        "driver.respondToRequest",
        { runId: TEST_RUN_ID, requestId: "req-42", response: null },
        NO_TRANSPORT,
      )
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBe("driver.capability_unsupported");
  });
});

// ----------------------------------------------------------------------------
// driver.subscribeEvents
// ----------------------------------------------------------------------------

describe("driver.subscribeEvents", () => {
  function buildSubscribeHarness(
    subscribeToDriverEvents: DriverSubscribeEventsDeps["subscribeToDriverEvents"],
  ): { registry: MethodRegistryImpl; frames: JsonRpcNotification<unknown>[] } {
    const registry = new MethodRegistryImpl();
    const frames: JsonRpcNotification<unknown>[] = [];
    const streamingPrimitive = new StreamingPrimitive({
      send: (_transportId, frame) => {
        frames.push(frame);
      },
      registry,
    });
    registerDriverSubscribeEvents(registry, { streamingPrimitive, subscribeToDriverEvents });
    return { registry, frames };
  }

  /** Cross one `setImmediate` boundary — the flush point the handler schedules. */
  async function afterFlush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("answers with the shared subscription ack", async () => {
    const { registry } = buildSubscribeHarness(() => () => undefined);
    const result = (await registry.dispatch(
      "driver.subscribeEvents",
      { runId: TEST_RUN_ID },
      TRANSPORT,
    )) as { subscriptionId: string };
    expect(typeof result.subscriptionId).toBe("string");
  });

  it("buffers events raised during setup and flushes them after the response (I-007-10)", async () => {
    // The upstream source is permitted to replay synchronously, so without the
    // buffer those notify frames would reach the wire before the init response
    // and the SDK would drop them against an unregistered subscription id.
    const { registry, frames } = buildSubscribeHarness((_runId, onEvent) => {
      onEvent(buildDriverEvent(1));
      onEvent(buildDriverEvent(2));
      return () => undefined;
    });

    await registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT);
    expect(frames).toHaveLength(0);

    await afterFlush();
    expect(frames).toHaveLength(2);
  });

  it("DROPS events outside the seven driver categories, on both paths", async () => {
    // A `session.created` event parses cleanly against `SessionEventSchema`, so
    // a source wired to a session-wide feed would push memberships, approvals,
    // and audit rows onto a subscription opened for one run's driver activity
    // and nothing on this side would notice. (A leak past this filter reaches
    // the SDK's `DriverEventSchema`, which ends the subscription rather than
    // delivering the row — a loud client-side failure, not a silent rescue.)
    let live: ((event: SessionEvent) => void) | undefined;
    const { registry, frames } = buildSubscribeHarness((_runId, onEvent) => {
      onEvent(buildNonDriverEvent());
      onEvent(buildDriverEvent(1));
      live = onEvent;
      return () => undefined;
    });

    await registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT);
    await afterFlush();
    expect(frames).toHaveLength(1);

    live?.(buildNonDriverEvent());
    live?.(buildDriverEvent(2));
    expect(frames).toHaveLength(2);
  });

  it("registers the upstream detach handle so a cancel tears the source down", async () => {
    const unsubscribe = vi.fn();
    const { registry } = buildSubscribeHarness(() => unsubscribe);

    const result = (await registry.dispatch(
      "driver.subscribeEvents",
      { runId: TEST_RUN_ID },
      TRANSPORT,
    )) as { subscriptionId: string };
    await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: result.subscriptionId },
      TRANSPORT,
    );

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cancels the allocated subscription when setup throws, and projects the refusal", async () => {
    // Without the atomicity guard the streaming-primitive entry would orphan in
    // both of its maps until the transport closed.
    const { registry, frames } = buildSubscribeHarness(() => {
      throw new DriverUnavailableError("claude");
    });

    const thrown = await registry
      .dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBe("driver.unavailable");
    await afterFlush();
    expect(frames).toHaveLength(0);
  });

  it("refuses a call carrying no transport identity", async () => {
    const { registry } = buildSubscribeHarness(() => () => undefined);
    await expect(
      registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, NO_TRANSPORT),
    ).rejects.toThrow(/transportId/);
  });

  it("REFUSES an unknown key on the request (I-007-7)", async () => {
    const subscribeToDriverEvents = vi.fn(() => () => undefined);
    const { registry } = buildSubscribeHarness(subscribeToDriverEvents);

    await expect(
      registry.dispatch(
        "driver.subscribeEvents",
        { runId: TEST_RUN_ID, afterCursor: "c1" },
        TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(subscribeToDriverEvents).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// driver.compactContext (T4.9)
// ----------------------------------------------------------------------------

describe("driver.compactContext", () => {
  const request = { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID };

  it("dispatches to the resolved binding's driver and answers the discriminated result verbatim", async () => {
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn(
      async () => ({ status: "applied", boundaryPosition: 41 }) as const,
    );
    registerDriverCompactContext(
      registry,
      compactContextDeps({ claude: driverDouble({ compactContext }) }),
    );

    await expect(
      registry.dispatch("driver.compactContext", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "applied", boundaryPosition: 41 });

    // The DRIVER param shape is binding-addressed: the run id was the wire's
    // addressing key and stops at the daemon — the driver receives the resolved
    // binding and never re-derives what "this run's binding" means.
    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(compactContext).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
  });

  it("refuses a non-member BYTE-IDENTICALLY to an unknown session (no existence oracle)", async () => {
    // One resolver answer covers both readings — a session that does not exist
    // and one the caller is not a member of — because the mask deliberately
    // collapses them. The assertion compares the WHOLE mapped envelopes rather
    // than matching a code: byte-identity is the property, and two refusals
    // that differed in message, fields, or numeric would leak which reading
    // applied.
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    const resolveRunBinding = vi.fn();
    registerDriverCompactContext(
      registry,
      compactContextDeps(
        { claude: driverDouble({ compactContext }) },
        {
          resolveSessionAccess: () => false,
          resolveRunBinding:
            resolveRunBinding as unknown as DriverCompactContextDeps["resolveRunBinding"],
        },
      ),
    );

    const refusalOf = async (sessionId: SessionId): Promise<unknown> =>
      registry
        .dispatch("driver.compactContext", { sessionId, runId: TEST_RUN_ID }, NO_TRANSPORT)
        .then(() => undefined)
        .catch((error: unknown) => error);

    const nonMemberRefusal = await refusalOf(TEST_SESSION_ID);
    const unknownSessionRefusal = await refusalOf(SECOND_SESSION_ID);

    const nonMemberEnvelope = mapJsonRpcError(nonMemberRefusal, 7);
    expect(nonMemberEnvelope).toStrictEqual(mapJsonRpcError(unknownSessionRefusal, 7));
    expect(nonMemberEnvelope.error.message).toBe("Session does not exist or is not accessible");
    // No `fields` key at all — a masked refusal that carried per-cause fields
    // would stop being byte-identical the day either side added one.
    expect(Object.hasOwn(wireErrorData(nonMemberRefusal), "fields")).toBe(false);

    // The mask ran FIRST: nothing downstream was consulted for either caller.
    expect(resolveRunBinding).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("settles a viewer-role deny as not_permitted DATA, with zero gate and zero driver calls", async () => {
    // The adjudication precedes the capability gate AND the dispatch, and its
    // deny is a RESOLVED value on the operation's own refused arm — a viewer is
    // answered, not mis-addressed. Zero calls on the registry double prove the
    // ordering rather than assert it in prose.
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    const lookup = vi.fn();
    const checkCapability = vi.fn();
    const evaluateInterveneAction = vi.fn(() => "deny" as const);
    registerDriverCompactContext(registry, {
      providerRegistry: { lookup, checkCapability },
      resolveSessionAccess: () => true,
      evaluateInterveneAction,
      resolveRunBinding: () => ({
        kind: "bound",
        driverName: "claude",
        bindingId: TEST_BINDING_ID,
      }),
    });

    await expect(
      registry.dispatch("driver.compactContext", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "refused", reason: "not_permitted" });

    expect(evaluateInterveneAction).toHaveBeenCalledWith(TEST_SESSION_ID, TEST_RUN_ID);
    expect(lookup).not.toHaveBeenCalled();
    expect(checkCapability).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("treats a non-'permit' evaluator answer as a deny — fail-closed against a broken implementor", async () => {
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    registerDriverCompactContext(
      registry,
      compactContextDeps(
        { claude: driverDouble({ compactContext }) },
        {
          // A broken implementor answering neither literal must land on the
          // refusing arm, never fall through to the dispatch.
          evaluateInterveneAction: (() =>
            undefined) as unknown as DriverCompactContextDeps["evaluateInterveneAction"],
        },
      ),
    );

    await expect(
      registry.dispatch("driver.compactContext", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "refused", reason: "not_permitted" });
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("refuses another session's run as run.not_found, before adjudication, with zero driver calls", async () => {
    // The resolver is SESSION-SCOPED: the run is live under a different
    // session, so within the addressed one it does not resolve — the address
    // fails before the caller's permissions are even weighed.
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    const evaluateInterveneAction = vi.fn(() => "permit" as const);
    registerDriverCompactContext(
      registry,
      compactContextDeps(
        { claude: driverDouble({ compactContext }) },
        {
          evaluateInterveneAction,
          resolveRunBinding: (sessionId) =>
            sessionId === SECOND_SESSION_ID
              ? { kind: "bound", driverName: "claude", bindingId: TEST_BINDING_ID }
              : { kind: "unknown-run" },
        },
      ),
    );

    const thrown = await registry
      .dispatch("driver.compactContext", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("run.not_found");
    expect(wireError.fields).toMatchObject({ runId: TEST_RUN_ID });
    expect(evaluateInterveneAction).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("refuses a run holding no live binding as driver.unavailable, after adjudication permits", async () => {
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    const lookup = vi.fn();
    const evaluateInterveneAction = vi.fn(() => "permit" as const);
    registerDriverCompactContext(registry, {
      providerRegistry: { lookup, checkCapability: vi.fn() },
      resolveSessionAccess: () => true,
      evaluateInterveneAction,
      resolveRunBinding: () => ({ kind: "no-live-binding" }),
    });

    const thrown = await registry
      .dispatch("driver.compactContext", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.unavailable");
    // Deliberately NO data.fields: the caller named this run in the very
    // request being refused, and echoing it would mint a new fields shape on
    // a registered code (error-contracts.md documents none for this row).
    expect(Object.hasOwn(wireError, "fields")).toBe(false);
    // Adjudication ran (its deny would have settled first); liveness refused
    // after it, so a denied caller's answer never varies with binding state.
    expect(evaluateInterveneAction).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("refuses a declaring-false driver via driver.capability_unsupported, with zero dispatches", async () => {
    // The refusing gate here is the SHIPPED `ProviderRegistry.checkCapability`
    // over a registry seeded through its own `register()` — see
    // `realProviderRegistry`.
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn();
    registerDriverCompactContext(
      registry,
      compactContextDeps(
        {},
        {
          providerRegistry: await realProviderRegistry({
            claude: { flags: { context_compaction: false }, operations: { compactContext } },
          }),
        },
      ),
    );

    const thrown = await registry
      .dispatch("driver.compactContext", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.capability_unsupported");
    expect(wireError.fields).toMatchObject({ driverId: "claude", flag: "context_compaction" });
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("REFUSES a request carrying a bindingId, before the handler runs (I-007-7)", async () => {
    // No binding member exists on the wire — a caller naming one believes it
    // holds an addressing key the contract deliberately never published.
    const registry = new MethodRegistryImpl();
    const resolveSessionAccess = vi.fn(() => true);
    registerDriverCompactContext(
      registry,
      compactContextDeps({ claude: driverDouble({}) }, { resolveSessionAccess }),
    );

    await expect(
      registry.dispatch(
        "driver.compactContext",
        { ...request, bindingId: TEST_BINDING_ID },
        NO_TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(resolveSessionAccess).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// driver.listProviderCommands (T4.9)
// ----------------------------------------------------------------------------

describe("driver.listProviderCommands", () => {
  const request = { sessionId: TEST_SESSION_ID, agentId: TEST_AGENT_ID };

  it("fans out across the agent's live bindings and merges by concatenation, in resolver order", async () => {
    // ANY active role reads — these deps carry no adjudication seam at all,
    // which is the structural form of "the enumeration needs nothing beyond
    // membership". Each group arrives exactly as its driver composed it: the
    // runId attribution, the routing pair on every entry, and the order are
    // the drivers' own, concatenated and never re-shaped.
    const registry = new MethodRegistryImpl();
    const claudeGroup = commandGroup("claude");
    const codexGroup = commandGroup("codex");
    const claudeList = vi.fn(async () => ({ bindings: [claudeGroup] }));
    const codexList = vi.fn(async () => ({ bindings: [codexGroup] }));
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        {
          claude: driverDouble({ listProviderCommands: claudeList }),
          codex: driverDouble({ listProviderCommands: codexList }),
        },
        {
          providerRegistry: {
            lookup: (driverId: string) =>
              driverId === "claude"
                ? driverDouble({ listProviderCommands: claudeList })
                : driverDouble({ listProviderCommands: codexList }),
            checkCapability: capabilityGate({
              claude: { provider_commands: true },
              codex: { provider_commands: true },
            }),
          },
          resolveAgentBindings: () => ({
            kind: "bound",
            bindings: [
              { driverName: "claude", bindingId: "binding-claude" },
              { driverName: "codex", bindingId: "binding-codex" },
            ],
          }),
        },
      ),
    );

    await expect(
      registry.dispatch("driver.listProviderCommands", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ bindings: [claudeGroup, codexGroup] });

    expect(claudeList).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-claude",
    });
    expect(codexList).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-codex",
    });
  });

  it("passes a truncated group through with complete: false, untouched", async () => {
    const registry = new MethodRegistryImpl();
    const truncatedGroup = commandGroup("claude", false);
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({ bindings: [truncatedGroup] }),
        }),
      }),
    );

    const result = (await registry.dispatch(
      "driver.listProviderCommands",
      request,
      NO_TRANSPORT,
    )) as { bindings: { complete: boolean }[] };
    expect(result.bindings[0]?.complete).toBe(false);
  });

  it("reads for a viewer-role member — no adjudication seam is even expressible here", async () => {
    // The compile-time half of "any active role reads": unlike
    // `DriverCompactContextDeps`, this deps type declares NO
    // `evaluateInterveneAction` member, so a role gate on the enumeration is
    // not merely unwired but unrepresentable. Membership is the only
    // admission, and it answers the same for every active role — a viewer's
    // read is byte-for-byte a collaborator's.
    const registry = new MethodRegistryImpl();
    const viewerVisibleGroup = commandGroup("claude");
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({ bindings: [viewerVisibleGroup] }),
        }),
      }),
    );

    await expect(
      registry.dispatch("driver.listProviderCommands", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ bindings: [viewerVisibleGroup] });
  });

  it("refuses the WHOLE read when ONE binding's driver declares provider_commands false, with zero dispatches", async () => {
    // A partial group list would tell a caller the missing binding enumerates
    // nothing — the omission-versus-empty confusion I-005-2 forbids. Both
    // spies at zero prove every binding was gated before ANY was dispatched.
    const registry = new MethodRegistryImpl();
    const claudeList = vi.fn(async () => ({ bindings: [commandGroup("claude")] }));
    const codexList = vi.fn(async () => ({ bindings: [commandGroup("codex")] }));
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        {},
        {
          // The refusing gate is the SHIPPED `checkCapability` over a real
          // registry. `claude` declares true, so the refusal provably came
          // from `codex`'s row and not from a gate that refuses everything.
          providerRegistry: await realProviderRegistry({
            claude: {
              flags: { provider_commands: true },
              operations: { listProviderCommands: claudeList },
            },
            codex: {
              flags: { provider_commands: false },
              operations: { listProviderCommands: codexList },
            },
          }),
          resolveAgentBindings: () => ({
            kind: "bound",
            bindings: [
              { driverName: "claude", bindingId: "binding-claude" },
              { driverName: "codex", bindingId: "binding-codex" },
            ],
          }),
        },
      ),
    );

    const thrown = await registry
      .dispatch("driver.listProviderCommands", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.capability_unsupported");
    expect(wireError.fields).toMatchObject({ driverId: "codex", flag: "provider_commands" });
    expect(claudeList).not.toHaveBeenCalled();
    expect(codexList).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent as agent.not_found with zero driver calls", async () => {
    const registry = new MethodRegistryImpl();
    const listProviderCommands = vi.fn();
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        { claude: driverDouble({ listProviderCommands }) },
        { resolveAgentBindings: () => ({ kind: "unknown-agent" }) },
      ),
    );

    const thrown = await registry
      .dispatch("driver.listProviderCommands", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("agent.not_found");
    expect(wireError.fields).toMatchObject({ agentId: TEST_AGENT_ID });
    expect(listProviderCommands).not.toHaveBeenCalled();
  });

  it("refuses an agent holding no live binding as driver.unavailable with zero driver calls", async () => {
    const registry = new MethodRegistryImpl();
    const listProviderCommands = vi.fn();
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        { claude: driverDouble({ listProviderCommands }) },
        { resolveAgentBindings: () => ({ kind: "no-live-binding" }) },
      ),
    );

    const thrown = await registry
      .dispatch("driver.listProviderCommands", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.unavailable");
    // NO data.fields, matching the run arm — one registered envelope shape.
    expect(Object.hasOwn(wireError, "fields")).toBe(false);
    expect(listProviderCommands).not.toHaveBeenCalled();
  });

  it("refuses a non-member BYTE-IDENTICALLY to an unknown session on this verb too", async () => {
    const registry = new MethodRegistryImpl();
    const resolveAgentBindings = vi.fn();
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        { claude: driverDouble({}) },
        {
          resolveSessionAccess: () => false,
          resolveAgentBindings:
            resolveAgentBindings as unknown as DriverListProviderCommandsDeps["resolveAgentBindings"],
        },
      ),
    );

    const refusalOf = async (sessionId: SessionId): Promise<unknown> =>
      registry
        .dispatch(
          "driver.listProviderCommands",
          { sessionId, agentId: TEST_AGENT_ID },
          NO_TRANSPORT,
        )
        .then(() => undefined)
        .catch((error: unknown) => error);

    const nonMemberEnvelope = mapJsonRpcError(await refusalOf(TEST_SESSION_ID), 7);
    expect(nonMemberEnvelope).toStrictEqual(mapJsonRpcError(await refusalOf(SECOND_SESSION_ID), 7));
    expect(nonMemberEnvelope.error.message).toBe("Session does not exist or is not accessible");
    expect(resolveAgentBindings).not.toHaveBeenCalled();
  });

  it("fails the read as an internal error when a driver answers more than one group", async () => {
    // A driver contract violation, not a refusal a caller can act on — and the
    // alternative (silently flattening or picking one) would forge provenance.
    const registry = new MethodRegistryImpl();
    const doubledGroup = commandGroup("claude");
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({ bindings: [doubledGroup, doubledGroup] }),
        }),
      }),
    );

    const thrown = await registry
      .dispatch("driver.listProviderCommands", request, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBeUndefined();
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it("REFUSES a request carrying a bindingId, before the handler runs (I-007-7)", async () => {
    const registry = new MethodRegistryImpl();
    const resolveSessionAccess = vi.fn(() => true);
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({ claude: driverDouble({}) }, { resolveSessionAccess }),
    );

    await expect(
      registry.dispatch(
        "driver.listProviderCommands",
        { ...request, bindingId: TEST_BINDING_ID },
        NO_TRANSPORT,
      ),
    ).rejects.toBeInstanceOf(RegistryDispatchError);
    expect(resolveSessionAccess).not.toHaveBeenCalled();
  });
});
