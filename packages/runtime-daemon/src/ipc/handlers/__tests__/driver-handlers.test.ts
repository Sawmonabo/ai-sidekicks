// The `driver.*` handlers through the real method registry and streaming primitive: each refusal
// fires before any driver runs, a driver's answer is checked against the binding it was asked
// for, and a subscription loses no event. Refusals are read through `mapJsonRpcError`, because
// the client sees the wire envelope.

import { describe, expect, it, vi } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent-definition";
import type {
  ApplyInterventionParams,
  DriverCapabilityFlag,
  RunId,
} from "@ai-sidekicks/contracts/provider-driver";
import type { HandlerContext } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type { JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc";
import type { UserId, SessionId } from "@ai-sidekicks/contracts/session";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider-driver-transcript";
import type { DriverCapabilityReport } from "@ai-sidekicks/contracts/provider-driver-wire";
import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import type { SessionEvent } from "@ai-sidekicks/contracts/event-variant-types";
import { DRIVER_CAPABILITY_FLAGS } from "@ai-sidekicks/contracts/provider-driver";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc";
import { PROVIDER_NAMES } from "@ai-sidekicks/contracts/provider-account";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { mapJsonRpcError } from "../../jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../../registry.js";
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
  type DriverCatalogDeps,
  type DriverCompactContextDeps,
  type DriverListProviderCommandsDeps,
} from "../driver-handlers.js";
import {
  registerDriverSubscribeEvents,
  type DriverSubscribeEventsDeps,
} from "../driver-subscribe.js";
import type { GetCapabilitiesResult, ProviderDriver } from "../../../provider/provider-driver.js";

const TEST_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000" as SessionId;
const SECOND_SESSION_ID = "990e8400-e29b-41d4-a716-446655440003" as SessionId;
const TEST_ACTOR_ID = "660e8400-e29b-41d4-a716-446655440001" as UserId;
const TEST_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as RunId;
const UNKNOWN_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3399" as RunId;
const TEST_AGENT_ID = "770e8400-e29b-41d4-a716-446655440002";
const UNKNOWN_AGENT_ID = "770e8400-e29b-41d4-a716-446655440099";
const TEST_BINDING_ID = "binding-1";
const NO_TRANSPORT: HandlerContext = {};
const TRANSPORT: HandlerContext = { transportId: 7 };

/**
 * A partial driver typed as a `ProviderDriver`. Both shipped drivers are `Pick`-narrowed classes
 * registered as the full contract, so a partial driver is what the handlers really receive.
 */
function driverDouble(operations: Partial<ProviderDriver>): ProviderDriver {
  return operations as ProviderDriver;
}

/** The `data` payload a thrown value becomes on the wire. */
function wireErrorData(thrown: unknown): { type?: string; fields?: Record<string, unknown> } {
  return (mapJsonRpcError(thrown, 1).error.data ?? {}) as {
    type?: string;
    fields?: Record<string, unknown>;
  };
}

/**
 * Dispatches a method that must reject and returns the thrown value. `mapJsonRpcError` turns any
 * input, `undefined` from a dispatch that succeeded included, into a bare internal error, so an
 * assertion on the envelope alone would pass with the guard deleted.
 */
async function rejectionOf(
  registry: MethodRegistryImpl,
  method: string,
  params: unknown,
): Promise<unknown> {
  return captureRejection(registry.dispatch(method, params, NO_TRANSPORT));
}

/**
 * A capability gate for the paths that admit: anything but `true` refuses, like
 * `ProviderRegistry.checkCapability`. The refusal test uses `realProviderRegistry` instead.
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

/** A real `ProviderRegistry` seeded through its own `register()`, so the shipped gate refuses. */
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
    const flags = Object.fromEntries(
      DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, seed.flags[flag] ?? false]),
    ) as Record<DriverCapabilityFlag, boolean>;
    const capabilitiesResult: GetCapabilitiesResult = {
      capabilities: { flags, contractVersion: "1.0.0" },
      tools: [],
      cliVersion: { rawVersion: "test-provider-cli 0.0.1", parsedVersion: "0.0.1" },
    };
    await providerRegistry.register(
      driverName,
      driverDouble({ ...seed.operations, getCapabilities: async () => capabilitiesResult }),
    );
  }
  return providerRegistry;
}

/**
 * Deps for `driver.compactContext` that admit everything (a reachable session, a permitted caller,
 * one live `claude` binding, the capability declared), so a test overrides only its own seam.
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
    resolveRunBinding: () => ({ kind: "bound", driverName: "claude", bindingId: TEST_BINDING_ID }),
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
      checkCapability: capabilityGate({
        claude: { provider_commands: true },
        codex: { provider_commands: true },
      }),
    },
    resolveSessionAccess: () => true,
    resolveAgentBindings: () => ({
      kind: "bound",
      bindings: [{ driverName: "claude", bindingId: TEST_BINDING_ID, providerAccountId: null }],
    }),
    ...overrides,
  };
}

/** One binding's group as its driver composes it, stamped with the binding's routing pair. */
function commandGroup(driverName: ProviderName): ProviderCommandBindingGroup {
  return {
    runId: TEST_RUN_ID,
    binding: { driverName, providerAccountId: null },
    entries: [
      { name: "compact", kind: "command", binding: { driverName, providerAccountId: null } },
    ],
    complete: true,
  };
}

const COMPACT_REQUEST = { sessionId: TEST_SESSION_ID, runId: TEST_RUN_ID };
const COMMANDS_REQUEST = { sessionId: TEST_SESSION_ID, agentId: TEST_AGENT_ID };

describe("driver.* — a refusal fires before any driver runs", () => {
  it(
    "dispatches to the target the address resolves " + "to, and refuses one that resolves nowhere",
    async () => {
      // The run id stops at the daemon: the driver is addressed by the binding it resolves to, and
      // the run resolver is scoped to the session, so another session's run does not resolve.
      const cases = [
        {
          method: "driver.interruptRun",
          register: (registry: MethodRegistryImpl) => {
            const interruptRun = vi.fn(async () => undefined);
            registerDriverInterruptRun(registry, {
              providerRegistry: { lookup: () => driverDouble({ interruptRun }) },
              resolveDriverForRun: (runId) => (runId === TEST_RUN_ID ? "claude" : undefined),
            });
            return interruptRun;
          },
          resolved: { runId: TEST_RUN_ID },
          result: {},
          driverCall: { runId: TEST_RUN_ID },
          unresolved: { runId: UNKNOWN_RUN_ID },
          refusal: { type: "run.not_found", fields: { runId: UNKNOWN_RUN_ID } },
        },
        {
          method: "driver.compactContext",
          register: (registry: MethodRegistryImpl) => {
            const compactContext = vi.fn(
              async () => ({ status: "applied", boundaryPosition: 41 }) as const,
            );
            registerDriverCompactContext(
              registry,
              compactContextDeps(
                { claude: driverDouble({ compactContext }) },
                {
                  resolveRunBinding: (sessionId) =>
                    sessionId === SECOND_SESSION_ID
                      ? { kind: "bound", driverName: "claude", bindingId: TEST_BINDING_ID }
                      : { kind: "unknown-run" },
                },
              ),
            );
            return compactContext;
          },
          resolved: { sessionId: SECOND_SESSION_ID, runId: TEST_RUN_ID },
          result: { status: "applied", boundaryPosition: 41 },
          driverCall: { sessionId: SECOND_SESSION_ID, bindingId: TEST_BINDING_ID },
          unresolved: COMPACT_REQUEST,
          refusal: { type: "run.not_found", fields: { runId: TEST_RUN_ID } },
        },
        {
          method: "driver.listProviderCommands",
          register: (registry: MethodRegistryImpl) => {
            const listProviderCommands = vi.fn(async () => ({
              bindings: [commandGroup("claude")],
            }));
            registerDriverListProviderCommands(
              registry,
              listProviderCommandsDeps(
                { claude: driverDouble({ listProviderCommands }) },
                {
                  resolveAgentBindings: (_sessionId, agentId) =>
                    agentId === TEST_AGENT_ID
                      ? {
                          kind: "bound",
                          bindings: [
                            {
                              driverName: "claude",
                              bindingId: TEST_BINDING_ID,
                              providerAccountId: null,
                            },
                          ],
                        }
                      : { kind: "unknown-agent" },
                },
              ),
            );
            return listProviderCommands;
          },
          resolved: COMMANDS_REQUEST,
          result: { bindings: [commandGroup("claude")] },
          driverCall: { sessionId: TEST_SESSION_ID, bindingId: TEST_BINDING_ID },
          unresolved: { sessionId: TEST_SESSION_ID, agentId: UNKNOWN_AGENT_ID },
          refusal: { type: "agent.not_found", fields: { agentId: UNKNOWN_AGENT_ID } },
        },
      ];

      for (const addressCase of cases) {
        const registry = new MethodRegistryImpl();
        const driverOperation = addressCase.register(registry);

        await expect(
          registry.dispatch(addressCase.method, addressCase.resolved, NO_TRANSPORT),
          addressCase.method,
        ).resolves.toStrictEqual(addressCase.result);
        expect(driverOperation, addressCase.method).toHaveBeenCalledWith(addressCase.driverCall);

        const wireError = wireErrorData(
          await rejectionOf(registry, addressCase.method, addressCase.unresolved),
        );
        expect(wireError.type, addressCase.method).toBe(addressCase.refusal.type);
        expect(wireError.fields, addressCase.method).toMatchObject(addressCase.refusal.fields);
        expect(driverOperation, addressCase.method).toHaveBeenCalledTimes(1);
      }
    },
  );

  it(
    "refuses a session it cannot reach " + "identically whether or not the session exists",
    async () => {
      // One resolver answer stands for a missing session and one not bound to this node; any
      // difference in message, fields or code would reveal which applied.
      const cases = [
        {
          method: "driver.compactContext",
          register: (registry: MethodRegistryImpl, downstream: ReturnType<typeof vi.fn>) =>
            registerDriverCompactContext(
              registry,
              compactContextDeps(
                { claude: driverDouble({}) },
                {
                  resolveSessionAccess: () => false,
                  resolveRunBinding:
                    downstream as unknown as DriverCompactContextDeps["resolveRunBinding"],
                },
              ),
            ),
          params: (sessionId: SessionId) => ({ sessionId, runId: TEST_RUN_ID }),
        },
        {
          method: "driver.listProviderCommands",
          register: (registry: MethodRegistryImpl, downstream: ReturnType<typeof vi.fn>) =>
            registerDriverListProviderCommands(
              registry,
              listProviderCommandsDeps(
                { claude: driverDouble({}) },
                {
                  resolveSessionAccess: () => false,
                  resolveAgentBindings:
                    downstream as unknown as DriverListProviderCommandsDeps["resolveAgentBindings"],
                },
              ),
            ),
          params: (sessionId: SessionId) => ({ sessionId, agentId: TEST_AGENT_ID }),
        },
      ];

      for (const accessCase of cases) {
        const registry = new MethodRegistryImpl();
        const downstream = vi.fn();
        accessCase.register(registry, downstream);

        const notBoundHere = await rejectionOf(
          registry,
          accessCase.method,
          accessCase.params(TEST_SESSION_ID),
        );
        const unknown = await rejectionOf(
          registry,
          accessCase.method,
          accessCase.params(SECOND_SESSION_ID),
        );

        const envelope = mapJsonRpcError(notBoundHere, 7);
        expect(envelope, accessCase.method).toStrictEqual(mapJsonRpcError(unknown, 7));
        expect(envelope.error.message, accessCase.method).toBe(
          "Session does not exist or is not accessible",
        );
        expect(Object.hasOwn(wireErrorData(notBoundHere), "fields"), accessCase.method).toBe(false);
        expect(downstream, accessCase.method).not.toHaveBeenCalled();
      }
    },
  );

  it(
    "settles a compaction the caller may not " + "perform as a refusal, and never compacts",
    async () => {
      // An evaluator answering neither literal is a broken implementor, and fails closed.
      for (const verdict of ["deny", undefined]) {
        const registry = new MethodRegistryImpl();
        const compactContext = vi.fn();
        registerDriverCompactContext(
          registry,
          compactContextDeps(
            { claude: driverDouble({ compactContext }) },
            {
              evaluateInterveneAction: (() =>
                verdict) as unknown as DriverCompactContextDeps["evaluateInterveneAction"],
            },
          ),
        );

        await expect(
          registry.dispatch("driver.compactContext", COMPACT_REQUEST, NO_TRANSPORT),
        ).resolves.toStrictEqual({ status: "refused", reason: "not_permitted" });
        expect(compactContext).not.toHaveBeenCalled();
      }
    },
  );

  it(
    "refuses a driver that does not declare the " + "capability before dispatching to any binding",
    async () => {
      // A partial command list would tell the caller the gated binding has none, so every binding
      // is gated before any is dispatched. `claude` declares the flag, so the refusal is `codex`'s.
      const compactContext = vi.fn();
      const claudeList = vi.fn(async () => ({ bindings: [commandGroup("claude")] }));
      const codexList = vi.fn(async () => ({ bindings: [commandGroup("codex")] }));

      const compactRegistry = new MethodRegistryImpl();
      registerDriverCompactContext(
        compactRegistry,
        compactContextDeps(
          {},
          {
            providerRegistry: await realProviderRegistry({
              claude: { flags: { context_compaction: false }, operations: { compactContext } },
            }),
          },
        ),
      );
      const commandsRegistry = new MethodRegistryImpl();
      registerDriverListProviderCommands(
        commandsRegistry,
        listProviderCommandsDeps(
          {},
          {
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

      for (const [registry, method, params, fields] of [
        [
          compactRegistry,
          "driver.compactContext",
          COMPACT_REQUEST,
          { driverId: "claude", flag: "context_compaction" },
        ],
        [
          commandsRegistry,
          "driver.listProviderCommands",
          COMMANDS_REQUEST,
          { driverId: "codex", flag: "provider_commands" },
        ],
      ] as const) {
        const wireError = wireErrorData(await rejectionOf(registry, method, params));
        expect(wireError.type, method).toBe("driver.capability_unsupported");
        expect(wireError.fields, method).toMatchObject(fields);
      }
      expect(compactContext).not.toHaveBeenCalled();
      expect(claudeList).not.toHaveBeenCalled();
      expect(codexList).not.toHaveBeenCalled();
    },
  );

  it("refuses a steer carrying attachments rather than dropping them", async () => {
    // No driver resolves an attachment id to bytes, so forwarding the steer would lose them.
    const registry = new MethodRegistryImpl();
    const applyIntervention = vi.fn(async () => ({ status: "applied" as const }));
    registerDriverApplyIntervention(registry, {
      providerRegistry: { lookup: () => driverDouble({ applyIntervention }) },
      resolveDriverForRun: () => "codex",
    });
    const steer: ApplyInterventionParams = {
      type: "steer",
      targetRunId: TEST_RUN_ID,
      expectedRunVersion: 3,
      clientIdempotencyKey: "00000000-0000-4000-8000-00000000000a",
      payload: { content: "use the other branch" },
    };

    const thrown = await rejectionOf(registry, "driver.applyIntervention", {
      ...steer,
      payload: { ...steer.payload, attachments: ["018f3a4c-7b21-7e55-9c04-2b6d9f1e77a0"] },
    });
    expect(mapJsonRpcError(thrown, 1).error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(wireErrorData(thrown)).toMatchObject({
      type: "driver.capability_unsupported",
      fields: { driverId: "codex", operation: "applyIntervention" },
    });
    expect(applyIntervention).not.toHaveBeenCalled();

    // An empty or omitted attachment list carries nothing to lose, so the steer goes through.
    for (const params of [{ ...steer, payload: { ...steer.payload, attachments: [] } }, steer]) {
      await expect(
        registry.dispatch("driver.applyIntervention", params, NO_TRANSPORT),
      ).resolves.toStrictEqual({ status: "applied" });
    }
    expect(applyIntervention).toHaveBeenCalledTimes(2);
  });
});

describe(
  "driver.listCapabilities, listModels and " + "listModes — one unreadable driver fails the read",
  () => {
    function catalogDeps(
      drivers: Partial<Record<ProviderName, ProviderDriver>>,
    ): DriverCatalogDeps {
      return {
        providerRegistry: {
          listAvailable: () =>
            PROVIDER_NAMES.filter((driverName) => drivers[driverName] !== undefined),
          lookup: (driverId: ProviderName) => drivers[driverId],
        },
      };
    }

    it("fails the whole capability read when one driver cannot be substantiated", async () => {
      // Leaving the driver out would tell the client it declares no capabilities, which is false.
      const registry = new MethodRegistryImpl();
      registerDriverListCapabilities(registry, {
        providerRegistry: { listAvailable: () => ["claude", "codex"] },
        capabilityCache: {
          read: (driverName: ProviderName): DriverCapabilityReport => {
            if (driverName === "codex") {
              throw new DriverUnavailableError(driverName);
            }
            const flags = Object.fromEntries(
              DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, false]),
            ) as Record<DriverCapabilityFlag, boolean>;
            return {
              driverName,
              capabilities: { flags, contractVersion: "1.0.0" },
              builtInTools: [],
            };
          },
        },
      });

      const wireError = wireErrorData(await rejectionOf(registry, "driver.listCapabilities", {}));
      expect(wireError.type).toBe("driver.unavailable");
      expect(wireError.fields).toMatchObject({ driverId: "codex" });
    });

    it("refuses an operation the resolved driver does not implement", async () => {
      // Neither shipped driver implements `listModes`. Without the guard the call would be a
      // `TypeError` and reach the client as a bare `-32603`, a crash report for a missing feature.
      const registry = new MethodRegistryImpl();
      registerDriverListModes(registry, catalogDeps({ claude: driverDouble({}) }));

      const wireError = wireErrorData(await rejectionOf(registry, "driver.listModes", {}));
      expect(wireError.type).toBe("driver.capability_unsupported");
      expect(wireError.fields).toMatchObject({ driverId: "claude", operation: "listModes" });
    });

    it("fails the whole catalog read when one driver's read rejects", async () => {
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

      const thrown = await rejectionOf(registry, "driver.listModels", {
        sessionId: TEST_SESSION_ID,
      });
      expect(wireErrorData(thrown).type).toBe("driver.unavailable");
    });
  },
);

describe("driver.listProviderCommands — a driver's answer is checked against its binding", () => {
  it(
    "merges each binding's group in resolver order, and fails the read on a group stamped for " +
      "another binding",
    async () => {
      // A caller routes each command by the binding stamped on it, so a mis-stamped group or entry
      // would send a command to the wrong provider or account. The mismatch is a driver contract
      // violation, an internal error, not a refusal the caller can act on.
      const claudeGroup = commandGroup("claude");
      const codexGroup = commandGroup("codex");
      const claudeList = vi.fn(async () => ({ bindings: [claudeGroup] }));
      const codexList = vi.fn(async () => ({ bindings: [codexGroup] }));
      const mergingRegistry = new MethodRegistryImpl();
      registerDriverListProviderCommands(
        mergingRegistry,
        listProviderCommandsDeps(
          {
            claude: driverDouble({ listProviderCommands: claudeList }),
            codex: driverDouble({ listProviderCommands: codexList }),
          },
          {
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

      await expect(
        mergingRegistry.dispatch("driver.listProviderCommands", COMMANDS_REQUEST, NO_TRANSPORT),
      ).resolves.toStrictEqual({ bindings: [claudeGroup, codexGroup] });
      expect(claudeList).toHaveBeenCalledWith({
        sessionId: TEST_SESSION_ID,
        bindingId: "binding-claude",
      });
      expect(codexList).toHaveBeenCalledWith({
        sessionId: TEST_SESSION_ID,
        bindingId: "binding-codex",
      });

      const violations: readonly [string, ProviderCommandBindingGroup[]][] = [
        ["two groups for one binding", [claudeGroup, claudeGroup]],
        ["a group stamped with another driver", [codexGroup]],
        [
          "one entry stamped with another driver inside an honest group",
          [
            {
              ...claudeGroup,
              entries: [
                ...claudeGroup.entries,
                {
                  name: "review",
                  kind: "command",
                  binding: { driverName: "codex", providerAccountId: null },
                },
              ],
            },
          ],
        ],
        [
          "a group stamped with another account on the same driver",
          [
            {
              ...claudeGroup,
              binding: { driverName: "claude", providerAccountId: "acct-somebody-else" },
            },
          ],
        ],
      ];
      for (const [name, bindings] of violations) {
        const registry = new MethodRegistryImpl();
        registerDriverListProviderCommands(
          registry,
          listProviderCommandsDeps({
            claude: driverDouble({ listProviderCommands: async () => ({ bindings }) }),
          }),
        );

        const thrown = await rejectionOf(registry, "driver.listProviderCommands", COMMANDS_REQUEST);

        expect(wireErrorData(thrown).type, name).toBeUndefined();
        expect(mapJsonRpcError(thrown, 1).error.code, name).toBe(JsonRpcErrorCode.InternalError);
      }
    },
  );
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

  /** An `assistant_output` event, one of the seven driver categories. */
  function driverEvent(sequence: number): SessionEvent {
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

  /** A `session.created` event: valid as a session event, but outside the driver categories. */
  function sessionLifecycleEvent(): SessionEvent {
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

  it(
    "holds setup-time events until after the " + "response, and forwards only driver events",
    async () => {
      // The source may replay synchronously; a notify frame ahead of the response carries a
      // subscription id the client does not know yet, so it drops the event. A source wired to a
      // session-wide feed would push lifecycle rows onto one run's driver stream.
      let live: ((event: SessionEvent) => void) | undefined;
      const { registry, frames } = buildSubscribeHarness((_runId, onEvent) => {
        onEvent(sessionLifecycleEvent());
        onEvent(driverEvent(1));
        onEvent(driverEvent(2));
        live = onEvent;
        return () => undefined;
      });

      await registry.dispatch("driver.subscribeEvents", { runId: TEST_RUN_ID }, TRANSPORT);
      expect(frames).toHaveLength(0);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(frames).toHaveLength(2);

      live?.(sessionLifecycleEvent());
      live?.(driverEvent(3));
      expect(frames).toHaveLength(3);
    },
  );

  it("tears the upstream source down when the subscription is cancelled", async () => {
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
});
