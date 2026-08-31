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
//   * TWO OF THE SEVEN VERBS ARE IMPLEMENTED BY NEITHER SHIPPED DRIVER. That is
//     the state at this task's landing, so the unimplemented-operation refusal
//     is a live path rather than a defensive one.
//   * THE EVENT FILTER IS A GUARANTEE, NOT A CONVENIENCE. A non-driver event
//     parses cleanly against `SessionEventSchema`, so nothing downstream would
//     notice one leaking onto a driver subscription.
//
// Refs: Plan-005 §Phase 4 / T4.1, invariants I-005-1 / I-005-2,
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants` I-007-6 … I-007-10.

import { describe, expect, it, vi } from "vitest";

import type {
  ApplyInterventionParams,
  DriverCapabilityFlag,
  DriverCapabilityReport,
  HandlerContext,
  JsonRpcNotification,
  ParticipantId,
  ProviderDriver,
  RunId,
  SessionEvent,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DRIVER_CAPABILITY_FLAGS } from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../jsonrpc-error-mapping.js";
import {
  MethodRegistryImpl,
  RegistryDispatchError,
  RegistryRegistrationError,
} from "../../registry.js";
import { StreamingPrimitive } from "../../streaming-primitive.js";
import { DriverUnavailableError } from "../../../provider/provider-registry.js";

import {
  registerDriverApplyIntervention,
  registerDriverInterruptRun,
  registerDriverListCapabilities,
  registerDriverListModels,
  registerDriverListModes,
  registerDriverRespondToRequest,
  registerDriverSubscribeEvents,
  type DriverCatalogDeps,
  type DriverDispatchDeps,
  type DriverListCapabilitiesDeps,
  type DriverSubscribeEventsDeps,
} from "../driver-handlers.js";

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
    registerDriverSubscribeEvents(registry, {
      streamingPrimitive: new StreamingPrimitive({ send: () => undefined, registry }),
      subscribeToDriverEvents: () => () => undefined,
    });
  }

  it("binds exactly the seven client-facing names, with the ratified mutating flags", () => {
    const registry = new MethodRegistryImpl();
    bindAll(registry);

    // `false` on the reads and on subscribe so a version-mismatched connection
    // keeps read-only access (Spec-007 §Fallback Behavior); `true` on the three
    // that drive a live run.
    expect(registry.isMutating("driver.listCapabilities")).toBe(false);
    expect(registry.isMutating("driver.listModels")).toBe(false);
    expect(registry.isMutating("driver.listModes")).toBe(false);
    expect(registry.isMutating("driver.subscribeEvents")).toBe(false);
    expect(registry.isMutating("driver.interruptRun")).toBe(true);
    expect(registry.isMutating("driver.applyIntervention")).toBe(true);
    expect(registry.isMutating("driver.respondToRequest")).toBe(true);
  });

  it("registers NONE of the four session/run lifecycle operations", async () => {
    // Plan-005 §Phase 4 decision #2, enforced rather than documented: these
    // establish, restore, start, or tear down a domain object, so a client
    // reaching them would mint runtime state behind the orchestrator's back.
    const registry = new MethodRegistryImpl();
    bindAll(registry);

    for (const method of [
      "driver.createSession",
      "driver.resumeSession",
      "driver.startRun",
      "driver.closeSession",
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
    // and nothing downstream would notice.
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
