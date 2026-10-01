// The `driver.*` handlers through the real method registry and streaming primitive. The four
// lifecycle and four daemon-internal operations are registered nowhere, and a second binding of
// either provider-command verb is refused. Refusals are read through `mapJsonRpcError`, because the client
// sees the wire envelope: an untranslated provider error would be a bare `-32603` that looks like
// a daemon crash.

import { describe, expect, it, vi } from "vitest";

import type {
  AgentId,
  ApplyInterventionParams,
  DriverCapabilityFlag,
  DriverCapabilityReport,
  HandlerContext,
  JsonRpcNotification,
  UserId,
  ProviderCommandBindingGroup,
  ProviderName,
  RunId,
  SessionEvent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DRIVER_CAPABILITY_FLAGS, JsonRpcErrorCode, PROVIDER_NAMES } from "@ai-sidekicks/contracts";

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
  CodexInterventionDispatcher,
  type CodexSteerAcknowledgement,
  type CodexSteerRunRequest,
} from "../../../provider/drivers/codex/intervention.js";

import {
  registerDriverApplyIntervention,
  registerDriverCompactContext,
  registerDriverInterruptRun,
  registerDriverListCapabilities,
  registerDriverListModels,
  registerDriverListModes,
  registerDriverListProviderCommands,
  type DriverCatalogDeps,
  type DriverCompactContextDeps,
  type DriverDispatchDeps,
  type DriverListProviderCommandsDeps,
} from "../driver-handlers.js";
import {
  registerDriverSubscribeEvents,
  type DriverSubscribeEventsDeps,
} from "../driver-subscribe.js";
import type { GetCapabilitiesResult, ProviderDriver } from "../../../provider/provider-driver.js";

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const TEST_ACTOR_ID = "660e8400-e29b-41d4-a716-446655440001" as UserId;
const TEST_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as RunId;
const TEST_IDEMPOTENCY_KEY = "00000000-0000-4000-8000-00000000000a";
const NO_TRANSPORT: HandlerContext = {};
const TRANSPORT: HandlerContext = { transportId: 7 };

/**
 * A partial driver typed as a `ProviderDriver`. Both shipped drivers are `Pick`-narrowed classes
 * registered as the full contract, so a partial driver is what the handlers really receive.
 */
function driverDouble(operations: Partial<ProviderDriver>): ProviderDriver {
  return operations as ProviderDriver;
}

function capabilityReport(driverName: ProviderName): DriverCapabilityReport {
  // The result schema's flag record is total, so a partial literal would fail validation.
  const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false])) as Record<
    DriverCapabilityFlag,
    boolean
  >;
  return { driverName, capabilities: { flags, contractVersion: "1.0.0" }, builtInTools: [] };
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
    actor: TEST_ACTOR_ID,
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
    actor: TEST_ACTOR_ID,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: TEST_SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444" as AgentId,
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}

/**
 * The `data` payload a thrown value becomes on the wire. Read through the real mapper because
 * the client sees that envelope: an untranslated provider-layer error is a bare `-32603` with no
 * `data.type`.
 */
function wireErrorData(thrown: unknown): { type?: string; fields?: Record<string, unknown> } {
  return (mapJsonRpcError(thrown, 1).error.data ?? {}) as {
    type?: string;
    fields?: Record<string, unknown>;
  };
}

/**
 * Dispatches a method that must reject and returns the thrown value. `mapJsonRpcError` turns any
 * input, including `undefined` from a dispatch that succeeded, into a bare `-32603`, so an
 * internal-error assertion would pass even with the guard deleted. Typed-code assertions fail on
 * a resolved dispatch anyway and use the plain `.then().catch()` idiom.
 */
async function dispatchExpectingRejection(
  registry: MethodRegistryImpl,
  method: string,
  params: unknown,
): Promise<unknown> {
  const settlement = await registry.dispatch(method, params, NO_TRANSPORT).then(
    () => ({ rejected: false as const }),
    (error: unknown) => ({ rejected: true as const, thrown: error }),
  );
  if (!settlement.rejected) {
    throw new Error(`${method} resolved where the test requires a rejection`);
  }
  return settlement.thrown;
}

function catalogDeps(drivers: Partial<Record<ProviderName, ProviderDriver>>): DriverCatalogDeps {
  return {
    providerRegistry: {
      listAvailable: () => PROVIDER_NAMES.filter((driverName) => drivers[driverName] !== undefined),
      lookup: (driverId: ProviderName) => drivers[driverId],
    },
  };
}

function dispatchDeps(
  drivers: Partial<Record<ProviderName, ProviderDriver>>,
  resolveDriverForRun: (runId: RunId) => ProviderName | undefined,
): DriverDispatchDeps {
  return {
    providerRegistry: { lookup: (driverId: ProviderName) => drivers[driverId] },
    resolveDriverForRun,
  };
}

const TEST_AGENT_ID = "770e8400-e29b-41d4-a716-446655440002";
const SECOND_SESSION_ID = "990e8400-e29b-41d4-a716-446655440003" as SessionId;
const TEST_BINDING_ID = "binding-1";

/**
 * A capability gate double for the paths that admit: anything but `true` refuses, like
 * `ProviderRegistry.checkCapability`. The refusal tests use `realProviderRegistry` instead, so
 * the shipped gate is what refuses.
 */
function capabilityGate(
  flagsByDriver: Record<string, Partial<Record<DriverCapabilityFlag, boolean>>>,
): (driverId: ProviderName, flag: DriverCapabilityFlag) => void {
  return (driverId, flag) => {
    if (flagsByDriver[driverId]?.[flag] !== true) {
      throw new DriverCapabilityUnsupportedError(driverId, flag);
    }
  };
}

/**
 * A real `ProviderRegistry` seeded through its own `register()`, so the capability-refusal tests
 * exercise the shipped fail-closed gate. `operations` are the caller's spies, so a dispatch that
 * got past the gate still fails the zero-call assertions.
 */
async function realProviderRegistry(
  driverSeeds: Partial<
    Record<
      ProviderName,
      {
        flags: Partial<Record<DriverCapabilityFlag, boolean>>;
        operations: Partial<ProviderDriver>;
      }
    >
  >,
): Promise<ProviderRegistry> {
  const providerRegistry = new ProviderRegistry();
  for (const driverName of PROVIDER_NAMES) {
    const seed = driverSeeds[driverName];
    if (seed === undefined) {
      continue;
    }
    // Undeclared flags are false, never absent.
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
 * Deps for `driver.compactContext` that admit everything (a session bound to this node, a
 * permitted caller, one live `claude` binding, the capability declared), so a test overrides
 * only the seam it is about.
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
      // Matches the `null` account the `commandGroup` fixture stamps.
      bindings: [{ driverName: "claude", bindingId: TEST_BINDING_ID, providerAccountId: null }],
    }),
    ...overrides,
  };
}

/** One binding's group as its driver composes it; the handler must pass it through untouched. */
function commandGroup(driverName: ProviderName, complete = true): ProviderCommandBindingGroup {
  return {
    runId: TEST_RUN_ID,
    binding: { driverName, providerAccountId: null },
    entries: [
      { name: "compact", kind: "command", binding: { driverName, providerAccountId: null } },
    ],
    complete,
  };
}

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
    registerDriverCompactContext(registry, compactContextDeps(drivers));
    registerDriverListProviderCommands(registry, listProviderCommandsDeps(drivers));
    registerDriverSubscribeEvents(registry, {
      streamingPrimitive: new StreamingPrimitive({ send: () => undefined, registry }),
      subscribeToDriverEvents: () => () => undefined,
    });
  }

  it("registers NONE of the four lifecycle operations NOR the four daemon-internal operations", async () => {
    // The lifecycle four create, restore, start or end runtime state, so a client reaching them
    // would bypass the orchestrator. The other four stay daemon-internal: the daemon forks the
    // conversation on a resend, and goals and auth probes have their own routes.
    const registry = new MethodRegistryImpl();
    bindAll(registry);

    for (const method of [
      "driver.createSession",
      "driver.resumeSession",
      "driver.startRun",
      "driver.closeSession",
      "driver.forkConversation",
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

  it("REFUSES a duplicate binding of driver.compactContext or driver.listProviderCommands", () => {
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

describe("driver.listCapabilities", () => {
  it("serves the whole roster from the cache, sorted, with no driver round-trip", async () => {
    const registry = new MethodRegistryImpl();
    const read = vi.fn(capabilityReport);
    registerDriverListCapabilities(registry, {
      // Unsorted on purpose, so the test sees the handler sort.
      providerRegistry: { listAvailable: () => ["codex", "claude"] },
      capabilityCache: { read },
    });

    const result = (await registry.dispatch("driver.listCapabilities", {}, NO_TRANSPORT)) as {
      drivers: DriverCapabilityReport[];
    };

    expect(result.drivers.map((entry) => entry.driverName)).toStrictEqual(["claude", "codex"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails the WHOLE read when one driver cannot be substantiated, with its registered wire code", async () => {
    // Leaving the driver out would tell the client it declares no capabilities, which is false.
    const registry = new MethodRegistryImpl();
    registerDriverListCapabilities(registry, {
      providerRegistry: { listAvailable: () => ["claude", "codex"] },
      capabilityCache: {
        read: (driverName: ProviderName) => {
          if (driverName === "codex") {
            throw new DriverUnavailableError(driverName);
          }
          return capabilityReport(driverName);
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

describe("driver.listModels and driver.listModes", () => {
  it("groups each driver's catalog under its own name", async () => {
    const registry = new MethodRegistryImpl();
    registerDriverListModels(
      registry,
      catalogDeps({
        codex: driverDouble({
          listModels: async () => [
            { id: "gpt-5.6-luna", name: "Luna", capabilities: [], fast: true },
          ],
        }),
        claude: driverDouble({
          listModels: async () => [
            { id: "claude-haiku-4-5", name: "Haiku", capabilities: [], fast: false },
          ],
        }),
      }),
    );

    const result = (await registry.dispatch(
      "driver.listModels",
      { sessionId: TEST_SESSION_ID },
      NO_TRANSPORT,
    )) as {
      drivers: { driverName: string; models: { id: string }[] }[];
    };

    expect(result.drivers.map((entry) => entry.driverName)).toStrictEqual(["claude", "codex"]);
    expect(result.drivers[0]?.models[0]?.id).toBe("claude-haiku-4-5");
  });

  it("REFUSES an operation the resolved driver does not implement", async () => {
    // Neither shipped driver implements `listModes`. Without the guard the call would be a
    // `TypeError` and reach the client as a bare `-32603`, a crash report for a missing feature.
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
      .dispatch("driver.listModels", { sessionId: TEST_SESSION_ID }, NO_TRANSPORT)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(wireErrorData(thrown).type).toBe("driver.unavailable");
  });
});

describe("driver.interruptRun", () => {
  it("dispatches to the run's resolved driver and answers the empty ack", async () => {
    // The registry validates the result, so returning nothing would turn a successful
    // interrupt into an internal error.
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

  it("refuses an unresolvable run as run.not_found, BEFORE any availability check", async () => {
    // A driver problem reported for a run that never existed would send the caller to fix the
    // wrong thing.
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
});

describe("driver.applyIntervention", () => {
  const steer: ApplyInterventionParams = {
    type: "steer",
    targetRunId: TEST_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: TEST_IDEMPOTENCY_KEY,
    payload: { content: "use the other branch" },
  };

  it("returns a DEGRADED envelope as data, not as an error", async () => {
    // No capability pre-gate: an unsupported intervention must reach the driver so it can
    // answer with a fallback hint instead of a refusal.
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

  // The next tests use the real `CodexInterventionDispatcher`. It builds `steerRun` from
  // the content and ids and never reads `payload.attachments`, so a steer with attachments must
  // be refused before it, or the attachments would be dropped silently.

  /** A real Codex dispatcher whose only fake is the provider runtime port. */
  function codexDriverWithSpiedSteer(): {
    driver: ProviderDriver;
    steerRun: ReturnType<typeof vi.fn>;
  } {
    const steerRun = vi.fn(
      async (request: CodexSteerRunRequest): Promise<CodexSteerAcknowledgement> => {
        const targetedTurnId = request.expectedTurnId ?? "turn-live";
        return { targetedTurnId, acknowledgedTurnId: targetedTurnId };
      },
    );
    const flags = Object.fromEntries(DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, true])) as Record<
      DriverCapabilityFlag,
      boolean
    >;
    const dispatcher = new CodexInterventionDispatcher({
      runtime: {
        steerRun,
        interruptRun: async (): Promise<void> => {},
        textNeutralizationDecisionForTurn: (): { readonly refused: boolean } => ({
          refused: false,
        }),
      },
      readCapabilities: () => ({ flags, contractVersion: "1.0.0" }),
    });
    return {
      driver: driverDouble({
        applyIntervention: (params) => dispatcher.applyIntervention(params),
      }),
      steerRun,
    };
  }

  const ARTIFACT_ID = "018f3a4c-7b21-7e55-9c04-2b6d9f1e77a0";

  it("REFUSES a steer carrying attachment references, before any driver method runs", async () => {
    const registry = new MethodRegistryImpl();
    const { driver, steerRun } = codexDriverWithSpiedSteer();
    registerDriverApplyIntervention(
      registry,
      dispatchDeps({ codex: driver }, () => "codex"),
    );

    const thrown = await dispatchExpectingRejection(registry, "driver.applyIntervention", {
      ...steer,
      payload: { content: "use the other branch", attachments: [ARTIFACT_ID] },
    });

    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    const wireError = wireErrorData(thrown);
    expect(wireError.type).toBe("driver.capability_unsupported");
    expect(wireError.fields).toMatchObject({
      driverId: "codex",
      operation: "applyIntervention",
    });
    expect(steerRun).not.toHaveBeenCalled();
  });

  it("dispatches a steer whose attachment list is EMPTY or omitted", async () => {
    const registry = new MethodRegistryImpl();
    const { driver, steerRun } = codexDriverWithSpiedSteer();
    registerDriverApplyIntervention(
      registry,
      dispatchDeps({ codex: driver }, () => "codex"),
    );

    await expect(
      registry.dispatch(
        "driver.applyIntervention",
        { ...steer, payload: { content: "use the other branch", attachments: [] } },
        NO_TRANSPORT,
      ),
    ).resolves.toStrictEqual({ status: "applied" });
    expect(steerRun).toHaveBeenCalledTimes(1);

    await expect(
      registry.dispatch("driver.applyIntervention", steer, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "applied" });
    expect(steerRun).toHaveBeenCalledTimes(2);
  });
});

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

  /** Waits one `setImmediate`, the point where the handler flushes held events. */
  async function afterFlush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("buffers events raised during setup and flushes them after the response", async () => {
    // The source may replay synchronously; without the buffer the notify frames would precede
    // the init response and the client would drop them as an unknown subscription id.
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
    // A `session.created` event passes `SessionEventSchema`, so a source wired to a session-wide
    // feed would push lifecycle rows onto a subscription for one run's driver activity, and only
    // this filter would stop it.
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

  it("projects a refusal thrown during setup onto its registered wire code and sends no frame", async () => {
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
});

describe("driver.compactContext", () => {
  const request = { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID };

  it("dispatches to the resolved binding's driver and answers the discriminated result verbatim", async () => {
    const registry = new MethodRegistryImpl();
    const compactContext = vi.fn(
      async () => ({ status: "applied", boundaryPosition: 41 }) as const,
    );
    const resolveSessionAccess = vi.fn(() => true);
    const resolveRunBinding = vi.fn<DriverCompactContextDeps["resolveRunBinding"]>(() => ({
      kind: "bound",
      driverName: "claude",
      bindingId: TEST_BINDING_ID,
    }));
    registerDriverCompactContext(
      registry,
      compactContextDeps(
        { claude: driverDouble({ compactContext }) },
        { resolveSessionAccess, resolveRunBinding },
      ),
    );

    await expect(
      registry.dispatch("driver.compactContext", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ status: "applied", boundaryPosition: 41 });

    // The access check ran on the asked-for session before the run was resolved.
    expect(resolveSessionAccess).toHaveBeenCalledTimes(1);
    expect(resolveSessionAccess).toHaveBeenCalledWith(TEST_SESSION_ID);
    expect(resolveRunBinding).toHaveBeenCalledWith(TEST_SESSION_ID, TEST_RUN_ID);

    // The run id stops at the daemon; the driver is addressed by the resolved binding.
    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(compactContext).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
    });
  });

  it("refuses a session not bound here BYTE-IDENTICALLY to an unknown session (no existence oracle)", async () => {
    // One resolver answer stands for both a missing session and one not bound to this node, since
    // the access check treats them alike. The whole envelopes are compared: a difference in
    // message, fields or code would reveal which case applied.
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

    const notBoundHereRefusal = await refusalOf(TEST_SESSION_ID);
    const unknownSessionRefusal = await refusalOf(SECOND_SESSION_ID);

    const notBoundHereEnvelope = mapJsonRpcError(notBoundHereRefusal, 7);
    expect(notBoundHereEnvelope).toStrictEqual(mapJsonRpcError(unknownSessionRefusal, 7));
    expect(notBoundHereEnvelope.error.message).toBe("Session does not exist or is not accessible");
    // No `fields` key, so the two refusals cannot differ by one.
    expect(Object.hasOwn(wireErrorData(notBoundHereRefusal), "fields")).toBe(false);

    // The access check runs first; nothing after it was consulted.
    expect(resolveRunBinding).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("settles an adjudicated deny as not_permitted DATA, with zero gate and zero driver calls", async () => {
    // The permission check runs before the capability gate and the dispatch, and a deny is an
    // ordinary result of the operation, not an error.
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
          // An evaluator that answers neither literal must be refused, not dispatched.
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
    // The resolver is scoped to the session: the run is live under a different one, so it does
    // not resolve here, and the address fails before permissions are checked.
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
    // No `data.fields`: the caller already named the run, and this error code carries none.
    expect(Object.hasOwn(wireError, "fields")).toBe(false);
    // The permission check ran first, so a denied caller's answer does not depend on binding
    // state.
    expect(evaluateInterveneAction).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("refuses a declaring-false driver via driver.capability_unsupported, with zero dispatches", async () => {
    // The refusal comes from the shipped `ProviderRegistry.checkCapability`.
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
});

describe("driver.listProviderCommands", () => {
  const request = { sessionId: TEST_SESSION_ID, agentId: TEST_AGENT_ID };

  it("fans out across the agent's live bindings and merges by concatenation, in resolver order", async () => {
    // These deps have no permission check: session access is enough. Each group keeps the run
    // attribution, routing pair and order its driver gave it, and the groups are concatenated.
    const registry = new MethodRegistryImpl();
    const claudeGroup = commandGroup("claude");
    const codexGroup = commandGroup("codex");
    const claudeList = vi.fn(async () => ({ bindings: [claudeGroup] }));
    const codexList = vi.fn(async () => ({ bindings: [codexGroup] }));
    const resolveSessionAccess = vi.fn(() => true);
    const resolveAgentBindings = vi.fn<DriverListProviderCommandsDeps["resolveAgentBindings"]>(
      () => ({
        kind: "bound",
        bindings: [
          { driverName: "claude", bindingId: "binding-claude", providerAccountId: null },
          { driverName: "codex", bindingId: "binding-codex", providerAccountId: null },
        ],
      }),
    );
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
          resolveSessionAccess,
          resolveAgentBindings,
        },
      ),
    );

    await expect(
      registry.dispatch("driver.listProviderCommands", request, NO_TRANSPORT),
    ).resolves.toStrictEqual({ bindings: [claudeGroup, codexGroup] });

    // The access check ran on the asked-for session before the agent was resolved.
    expect(resolveSessionAccess).toHaveBeenCalledTimes(1);
    expect(resolveSessionAccess).toHaveBeenCalledWith(TEST_SESSION_ID);
    expect(resolveAgentBindings).toHaveBeenCalledWith(TEST_SESSION_ID, TEST_AGENT_ID);

    expect(claudeList).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-claude",
    });
    expect(codexList).toHaveBeenCalledWith({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-codex",
    });
  });

  it("refuses the WHOLE read when ONE binding's driver declares provider_commands false, with zero dispatches", async () => {
    // A partial list would tell the caller the missing binding has no commands. Both spies at
    // zero show every binding was gated before any was dispatched.
    const registry = new MethodRegistryImpl();
    const claudeList = vi.fn(async () => ({ bindings: [commandGroup("claude")] }));
    const codexList = vi.fn(async () => ({ bindings: [commandGroup("codex")] }));
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps(
        {},
        {
          // `claude` declares the flag, so the refusal comes from `codex`, not from a gate that
          // refuses everything.
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
              { driverName: "claude", bindingId: "binding-claude", providerAccountId: null },
              { driverName: "codex", bindingId: "binding-codex", providerAccountId: null },
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
    // No `data.fields`, as for the run case.
    expect(Object.hasOwn(wireError, "fields")).toBe(false);
    expect(listProviderCommands).not.toHaveBeenCalled();
  });

  it("refuses a session not bound here BYTE-IDENTICALLY to an unknown session on this verb too", async () => {
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

    const notBoundHereEnvelope = mapJsonRpcError(await refusalOf(TEST_SESSION_ID), 7);
    expect(notBoundHereEnvelope).toStrictEqual(
      mapJsonRpcError(await refusalOf(SECOND_SESSION_ID), 7),
    );
    expect(notBoundHereEnvelope.error.message).toBe("Session does not exist or is not accessible");
    expect(resolveAgentBindings).not.toHaveBeenCalled();
  });

  it("fails the read as an internal error when a driver answers more than one group", async () => {
    // A driver contract violation, not a refusal the caller can act on; picking or flattening
    // the groups would misattribute commands.
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

    const thrown = await dispatchExpectingRejection(
      registry,
      "driver.listProviderCommands",
      request,
    );

    expect(wireErrorData(thrown).type).toBeUndefined();
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it("fails the read when a driver stamps its GROUP with another binding's routing pair", async () => {
    // The daemon dispatched to `claude`'s binding and the driver answered one well-formed group
    // stamped as `codex`. The stamp must be compared with the daemon's own record; a mismatch is
    // an internal error like the group-count check, not a caller refusal.
    const registry = new MethodRegistryImpl();
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({ bindings: [commandGroup("codex")] }),
        }),
      }),
    );

    const thrown = await dispatchExpectingRejection(
      registry,
      "driver.listProviderCommands",
      request,
    );

    expect(wireErrorData(thrown).type).toBeUndefined();
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it("fails the read when ONE ENTRY carries another binding's routing pair inside an honest group", async () => {
    // Each entry carries its own routing key, so each is checked; a correct group stamp must not
    // let a mis-stamped entry through to a caller that routes by it.
    const registry = new MethodRegistryImpl();
    const groupWithForeignEntry = commandGroup("claude");
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({
            bindings: [
              {
                ...groupWithForeignEntry,
                entries: [
                  ...groupWithForeignEntry.entries,
                  {
                    name: "review",
                    kind: "command",
                    binding: { driverName: "codex", providerAccountId: null },
                  },
                ],
              },
            ],
          }),
        }),
      }),
    );

    const thrown = await dispatchExpectingRejection(
      registry,
      "driver.listProviderCommands",
      request,
    );

    expect(wireErrorData(thrown).type).toBeUndefined();
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InternalError);
  });

  it("fails the read when the driver's stamped ACCOUNT differs on a shared driver name", async () => {
    // The account alone must refuse: same driver name, but an account the daemon's record does
    // not give this binding. A name-only comparison would pass it.
    const registry = new MethodRegistryImpl();
    const accountStampedGroup: ProviderCommandBindingGroup = {
      ...commandGroup("claude"),
      binding: { driverName: "claude", providerAccountId: "acct-somebody-else" },
    };
    registerDriverListProviderCommands(
      registry,
      listProviderCommandsDeps({
        claude: driverDouble({
          listProviderCommands: async () => ({ bindings: [accountStampedGroup] }),
        }),
      }),
    );

    const thrown = await dispatchExpectingRejection(
      registry,
      "driver.listProviderCommands",
      request,
    );

    expect(wireErrorData(thrown).type).toBeUndefined();
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InternalError);
  });
});
