// Covers `index.ts`, the composition root: every normalized operation is reachable through one
// driver object with the signatures `ClaudeDriverOperations` binds, a steer degrades, a native
// interrupt reaches the channel the lifecycle bound the run to, and `listModels()` answers the
// bound exchange's catalog, or the declaration only where a composition binds none.

import { describe, expect, it } from "vitest";

import type { CallbackToolInvocation, SessionCallbackTool } from "@ai-sidekicks/contracts";

import {
  ClaudeDriver,
  ClaudeSessionUnavailableError,
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_STEER_FALLBACK_ACTION,
  composeClaudeProviderToolName,
  type ClaudeDriverOperations,
  type ClaudeHandshakeDeclaration,
} from "../index.js";
import {
  bindCallbackToolsForSpawn,
  CallbackToolHost,
  resolveRegisteredCallbackToolName,
  type CallbackToolSpawnBinding,
} from "../../../callback-tool-host.js";
import {
  DriverDiagnosticsEmitter,
  type DriverDiagnosticRecord,
} from "../../../driver-diagnostics.js";
import { CLAUDE_DECLARED_MODEL_CATALOG, CLAUDE_DRIVER_NAME } from "../capabilities.js";
import {
  buildCreateSessionParams,
  buildInterruptParams,
  buildSteerParams,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  makeSilentDriverDiagnostics,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SESSION_ID,
} from "./claude-test-doubles.js";

interface DriverHarness {
  readonly driver: ClaudeDriver;
  readonly transport: FakeClaudeSessionTransport;
  readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
  readonly textNeutralizationFailureDetails: string[];
}

function buildHarness(): DriverHarness {
  const transport = new FakeClaudeSessionTransport();
  const runDispatchResolver = new FakeClaudeRunDispatchResolver();
  const textNeutralizationFailureDetails: string[] = [];
  runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
    sessionId: TEST_SESSION_ID,
    openingText: "review the diff",
  });
  const driver = new ClaudeDriver({
    transport,
    // Explicit `null`: no live `list_models` read is bound, so `listModels()` answers the
    // declared catalog.
    modelCatalogExchange: null,
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    // Recorded, not ignored, so a neutralization failure inside a composition test surfaces.
    onTextNeutralizationFailure: (_sessionId, _runId, failure) => {
      textNeutralizationFailureDetails.push(failure.providerFailureDetail);
    },
  });
  return { driver, transport, runDispatchResolver, textNeutralizationFailureDetails };
}

describe("ClaudeDriver", () => {
  it("satisfies the slice of the ProviderDriver contract this task owns", () => {
    const harness = buildHarness();
    // Compile-time check: the `Pick` binds every signature to the contract.
    const operations: ClaudeDriverOperations = harness.driver;

    expect(typeof operations.createSession).toBe("function");
    expect(typeof operations.resumeSession).toBe("function");
    expect(typeof operations.startRun).toBe("function");
    expect(typeof operations.interruptRun).toBe("function");
    expect(typeof operations.applyIntervention).toBe("function");
    expect(typeof operations.closeSession).toBe("function");
    expect(typeof operations.compactContext).toBe("function");
    expect(typeof operations.listProviderCommands).toBe("function");
    // Refusals stamp the same driver name the capability registry keys its rows on.
    const refusal = new ClaudeSessionUnavailableError("no_live_run", { runId: TEST_RUN_ID });
    expect(refusal.fields.driverId).toBe(CLAUDE_DRIVER_NAME);
  });

  it("delegates both console-parity operations through to the lifecycle band", async () => {
    // The entry point has no logic of its own; this pins that both operations reach the
    // lifecycle rather than answering from the wrapper.
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());

    const commands = await harness.driver.listProviderCommands({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-console-parity",
    });
    const compaction = await harness.driver.compactContext({
      sessionId: TEST_SESSION_ID,
      bindingId: "binding-console-parity",
    });

    expect(commands.bindings).toHaveLength(1);
    expect(commands.bindings[0]?.binding.driverName).toBe(CLAUDE_DRIVER_NAME);
    // No handshake has been observed, so the presence guard refuses and writes nothing.
    expect(compaction).toStrictEqual({ status: "refused", reason: "command_absent" });
    expect(harness.transport.spawnedChannels[0]?.sentWireTexts).toStrictEqual([]);
  });

  it("serves the binding-held output-speed observation through the EXTERNALLY reachable driver", async () => {
    // The lifecycle is a private field, so a `ProviderRegistry` caller reaches the held state
    // only through this driver accessor.
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());

    // Absent before the handshake: neither create nor resume blocks on it or spends a turn.
    expect(harness.driver.observedOutputSpeedFor(TEST_SESSION_ID)).toBeUndefined();

    harness.transport.spawnedChannels[0]?.emitStreamFrame("system/init", {
      handshake: {
        slashCommands: ["compact"],
        skills: [],
        terminalSlashCommands: [],
        fastModeState: "off",
        fastModeDisabledReason: "sdk_opt_in_required",
      } satisfies ClaudeHandshakeDeclaration,
    });

    expect(harness.driver.observedOutputSpeedFor(TEST_SESSION_ID)).toStrictEqual({
      declared: "off",
      reason: "sdk_opt_in_required",
    });
  });

  it("keeps the output-speed read OFF the contract operation surface", () => {
    // The accessor is deliberately not a `ProviderDriver` operation: widening the contract for
    // it would force a throwing stub onto the other driver, which has no such axis.
    const operations: ClaudeDriverOperations = buildHarness().driver;

    expect("observedOutputSpeedFor" in operations).toBe(true);
    expect((operations as Record<string, unknown>)["observedOutputSpeedFor"]).toBeInstanceOf(
      Function,
    );
    // @ts-expect-error `observedOutputSpeedFor` is not among the picked operations.
    void operations.observedOutputSpeedFor;
  });

  it("drives a session from create through run start to close", async () => {
    const harness = buildHarness();

    const handle = await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());
    await harness.driver.interruptRun({ runId: TEST_RUN_ID });
    await harness.driver.closeSession({ sessionId: TEST_SESSION_ID });

    expect(handle.resumeHandle).toBe(TEST_PINNED_PROVIDER_SESSION_ID);
    const channel = harness.transport.spawnedChannels[0];
    expect(channel?.sentWireTexts).toStrictEqual(["review the diff"]);
    expect(channel?.controlRequests).toStrictEqual([{ subtype: "interrupt", cancelQueued: false }]);
    expect(channel?.disposals).toStrictEqual(["session_closed"]);
  });

  it("dispatches a native interrupt to the channel the lifecycle band bound the run to", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());

    const result = await harness.driver.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.transport.spawnedChannels[0]?.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
  });

  it("degrades a steer through the composed entry without sending anything", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());

    const result = await harness.driver.applyIntervention(buildSteerParams("try the other fix"));

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: CLAUDE_STEER_FALLBACK_ACTION,
    });
    // Only the opening frame was written; the steer added none.
    expect(harness.transport.spawnedChannels[0]?.sentTextFrames).toHaveLength(1);
  });

  it("stops routing interventions once the session is closed", async () => {
    const harness = buildHarness();
    await harness.driver.createSession(buildCreateSessionParams());
    await harness.driver.startRun(buildStartRunParams());
    await harness.driver.closeSession({ sessionId: TEST_SESSION_ID });

    await expect(harness.driver.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });

  it("surfaces a resume failure through the driver entry as the typed failed arm", async () => {
    const harness = buildHarness();
    harness.transport.resumeFailure = new Error("claude exited before init");

    const result = await harness.driver.resumeSession({
      sessionId: TEST_SESSION_ID,
      resumeHandle: "provider-session-earlier",
    });

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("bindingId");
  });
});

describe("ClaudeDriver model catalog", () => {
  it("serves the declared catalog through the composed entry", async () => {
    const harness = buildHarness();

    const models = await harness.driver.listModels();

    expect(models.map((model) => model.id)).toEqual(
      CLAUDE_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
    // Effort levels are reachable from the driver object, not only from the declaring module.
    expect(models[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("serves a bound exchange's reading instead of the declaration", async () => {
    const driver = new ClaudeDriver({
      transport: new FakeClaudeSessionTransport(),
      runDispatchResolver: new FakeClaudeRunDispatchResolver(),
      diagnostics: makeSilentDriverDiagnostics(),
      mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
      mintBindingId: () => TEST_BINDING_ID,
      onTextNeutralizationFailure: () => undefined,
      modelCatalogExchange: async () => ({
        models: [
          {
            value: "future",
            resolvedModel: "claude-future-9",
            displayName: "Future",
            supportsEffort: true,
            supportedEffortLevels: ["low", "ludicrous"],
          },
        ],
      }),
    });

    const models = await driver.listModels();

    // A level the driver never enumerates: the effort vocabulary comes from the provider build.
    expect(models).toEqual([
      {
        id: "claude-future-9",
        name: "Future",
        capabilities: [],
        effortLevels: ["low", "ludicrous"],
        fast: false,
      },
    ]);
  });
});

// The Claude callback-tool dispatch is a transport obligation: the transport realizes the
// daemon-hosted MCP server (`--mcp-config`), and the driver only hands it a served registry, a
// provider-facing name map and a dispatcher. These tests therefore assert what a transport must
// satisfy, reading the recorded spawn request and performing the translate-then-dispatch step a
// real transport performs. A spawn with no dispatcher serves no registry.

const SEARCH_CALLBACK_TOOL: SessionCallbackTool = {
  name: "search_workspace",
  description: "Searches the session's mounted workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

interface CallbackToolSpawnHarness {
  readonly transport: FakeClaudeSessionTransport;
  readonly binding: CallbackToolSpawnBinding;
  readonly executedInvocations: CallbackToolInvocation[];
  readonly evaluatedToolNames: string[];
  readonly withheldDiagnostics: DriverDiagnosticRecord[];
}

async function callbackToolSpawnHarness(options?: {
  readonly bindDispatcher?: boolean;
}): Promise<CallbackToolSpawnHarness> {
  const executedInvocations: CallbackToolInvocation[] = [];
  const evaluatedToolNames: string[] = [];
  const withheldDiagnostics: DriverDiagnosticRecord[] = [];
  const hostDiagnostics = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => withheldDiagnostics.push(record) },
    counterSink: { increment: () => undefined },
  });
  const host = new CallbackToolHost({
    provider: "claude",
    diagnostics: hostDiagnostics,
    executor: {
      execute: async (invocation) => {
        executedInvocations.push(invocation);
        return await Promise.resolve({ status: "completed", output: "2 matches" });
      },
    },
    activitySink: { record: () => undefined },
    approvalSeam: {
      evaluate: async (request) => {
        evaluatedToolNames.push(request.toolName);
        return await Promise.resolve({ decision: "allow", basis: "policy" });
      },
    },
  });
  const binding = bindCallbackToolsForSpawn(host, {
    sessionId: TEST_SESSION_ID,
    requestedTools: [SEARCH_CALLBACK_TOOL],
    providerRegistrationAvailable: true,
    providerRegistrationUnavailableDetail: "unused",
  });
  const transport = new FakeClaudeSessionTransport();
  const driver = new ClaudeDriver({
    transport,
    modelCatalogExchange: null,
    runDispatchResolver: new FakeClaudeRunDispatchResolver(),
    // The driver's withholding diagnostic lands here; the no-dispatcher test reads it.
    diagnostics: hostDiagnostics,
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    onTextNeutralizationFailure: () => undefined,
  });
  await driver.createSession({
    ...buildCreateSessionParams(),
    callbackTools: binding.callbackTools,
    ...(options?.bindDispatcher === false
      ? {}
      : { onCallbackToolCall: binding.onCallbackToolCall }),
  });
  return { transport, binding, executedInvocations, evaluatedToolNames, withheldDiagnostics };
}

describe("ClaudeDriver callback-tool spawn wiring", () => {
  it("serves the admitted registry with the provider-facing names a transport must use", async () => {
    const harness = await callbackToolSpawnHarness();

    const callbackToolServer = harness.transport.spawnRequests[0]?.callbackToolServer;

    expect(callbackToolServer?.serverName).toBe(CLAUDE_CALLBACK_MCP_SERVER_NAME);
    expect(callbackToolServer?.tools).toStrictEqual([SEARCH_CALLBACK_TOOL]);
    // The provider calls the mangled name, so the transport needs the map to recover the
    // registry name.
    expect([...(callbackToolServer?.registryNamesByProviderName.entries() ?? [])]).toStrictEqual([
      [
        composeClaudeProviderToolName(CLAUDE_CALLBACK_MCP_SERVER_NAME, SEARCH_CALLBACK_TOOL.name),
        SEARCH_CALLBACK_TOOL.name,
      ],
    ]);
  });

  it("carries a translated provider invocation to the host and the answer back", async () => {
    const harness = await callbackToolSpawnHarness();
    const spawnRequest = harness.transport.spawnRequests[0];
    const callbackToolServer = spawnRequest?.callbackToolServer;
    const onCallbackToolCall = spawnRequest?.onCallbackToolCall;
    if (callbackToolServer === undefined || onCallbackToolCall === undefined) {
      throw new Error("the spawn served no callback-tool legs");
    }

    // The transport's step: recover the registry name from the descriptor's map before dispatch.
    const providerFacingToolName = composeClaudeProviderToolName(
      CLAUDE_CALLBACK_MCP_SERVER_NAME,
      SEARCH_CALLBACK_TOOL.name,
    );
    const result = await onCallbackToolCall({
      toolName: resolveRegisteredCallbackToolName(
        callbackToolServer.registryNamesByProviderName,
        providerFacingToolName,
      ),
      arguments: { query: "needle" },
      toolCallId: "toolu_01",
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });

    expect(harness.evaluatedToolNames).toStrictEqual([SEARCH_CALLBACK_TOOL.name]);
    expect(harness.executedInvocations[0]?.toolCallId).toBe("toolu_01");
    expect(result).toStrictEqual({ status: "completed", output: "2 matches" });
  });

  it("fails closed when a transport dispatches the un-translated provider name", async () => {
    const harness = await callbackToolSpawnHarness();
    const onCallbackToolCall = harness.transport.spawnRequests[0]?.onCallbackToolCall;
    if (onCallbackToolCall === undefined) {
      throw new Error("the spawn bound no dispatcher");
    }

    // Without the translation the host cannot recognize the served tool's invocations.
    const result = await onCallbackToolCall({
      toolName: composeClaudeProviderToolName(
        CLAUDE_CALLBACK_MCP_SERVER_NAME,
        SEARCH_CALLBACK_TOOL.name,
      ),
      arguments: { query: "needle" },
      toolCallId: "toolu_02",
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });

    expect(result).toStrictEqual({
      status: "failed",
      error: "invocation names no registered callback tool",
    });
    expect(harness.evaluatedToolNames).toStrictEqual([]);
  });

  it("serves no registry at all when the spawn binds no dispatcher", async () => {
    const harness = await callbackToolSpawnHarness({ bindDispatcher: false });

    // Withheld rather than served and refused, so the model never spends a turn on it.
    expect(harness.transport.spawnRequests[0]?.callbackToolServer).toBeUndefined();
    expect(harness.transport.spawnRequests[0]?.callbackTools).toBeUndefined();
    expect(
      harness.withheldDiagnostics.filter(
        (record) => record.kind === "callback_tool_registry_withheld",
      ),
    ).toHaveLength(1);
  });
});
