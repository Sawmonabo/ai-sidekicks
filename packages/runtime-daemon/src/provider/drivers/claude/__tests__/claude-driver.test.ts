// Coverage map for `index.ts` (Plan-005 Phase 3, T3.6 composition root):
//   * `Spec-005 §Required Behavior` — the six normalized operations this PR owns are reachable
//     through one driver object, with the signatures the `ProviderDriver`
//     contract declares (bound by the `ClaudeDriverOperations` `Pick`).
//   * I-005-4 / I-005-5 end-to-end through the composed entry: a steer degrades
//     and a native interrupt reaches the very channel the lifecycle band bound
//     the run to, which is the one coupling between the two bands.
//   * T3.12 C-8 — `listModels()` is reachable through the composed entry and
//     answers the catalog the bound exchange decides, the declaration standing
//     in only where a composition explicitly binds none.

import { describe, expect, it } from "vitest";

import type { CallbackToolInvocation, SessionCallbackTool } from "@ai-sidekicks/contracts";

import {
  ClaudeDriver,
  ClaudeSessionUnavailableError,
  CLAUDE_CALLBACK_MCP_SERVER_NAME,
  CLAUDE_STEER_FALLBACK_ACTION,
  composeClaudeProviderToolName,
  type ClaudeDriverOperations,
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
    // Explicit `null`: this test binds no live `list_models` read, so
    // `listModels()` answers the module's declared catalog. The dependency is
    // required precisely so that choice is written down rather than defaulted.
    modelCatalogExchange: null,
    runDispatchResolver,
    diagnostics: makeSilentDriverDiagnostics(),
    mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
    mintBindingId: () => TEST_BINDING_ID,
    // Required rather than optional: the tripwire's run terminal is the only
    // user-visible surface a swallowed turn has, so a construction site cannot
    // leave it unbound. Recorded rather than ignored here so a trip inside a
    // composition test would surface instead of vanishing.
    onTextNeutralizationFailure: (_sessionId, _runId, failure) => {
      textNeutralizationFailureDetails.push(failure.providerFailureDetail);
    },
  });
  return { driver, transport, runDispatchResolver, textNeutralizationFailureDetails };
}

describe("ClaudeDriver", () => {
  it("satisfies the slice of the ProviderDriver contract this task owns", () => {
    const harness = buildHarness();
    // A compile-time assertion first: the `Pick` is what keeps every signature
    // bound to the contract with zero drift.
    const operations: ClaudeDriverOperations = harness.driver;

    expect(typeof operations.createSession).toBe("function");
    expect(typeof operations.resumeSession).toBe("function");
    expect(typeof operations.startRun).toBe("function");
    expect(typeof operations.interruptRun).toBe("function");
    expect(typeof operations.applyIntervention).toBe("function");
    expect(typeof operations.closeSession).toBe("function");
    // One identity for the driver, not two: the refusals this band raises stamp
    // the same constant the capability registry keys its rows on, so a rename
    // cannot leave an error envelope pointing at a driver name that no longer
    // exists.
    const refusal = new ClaudeSessionUnavailableError("no_live_run", { runId: TEST_RUN_ID });
    expect(refusal.fields.driverId).toBe(CLAUDE_DRIVER_NAME);
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
    // The opening frame is the only text ever written; the steer added none.
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

describe("ClaudeDriver model catalog (T3.12 C-8)", () => {
  it("serves the declared catalog through the composed entry", async () => {
    const harness = buildHarness();

    const models = await harness.driver.listModels();

    expect(models.map((model) => model.id)).toEqual(
      CLAUDE_DECLARED_MODEL_CATALOG.map((model) => model.id),
    );
    // The member the currency duty exists for, reachable from the driver object
    // rather than only from the module that declares it.
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

    // A level this file never enumerates: the vocabulary is the build's, not
    // this driver's, which is what keeps the catalog current without an edit.
    expect(models).toEqual([
      {
        id: "claude-future-9",
        name: "Future",
        capabilities: [],
        effortLevels: ["low", "ludicrous"],
      },
    ]);
  });
});

// --------------------------------------------------------------------------
// T3.15 leg 3 — the callback-tool host reaches the Claude spawn end to end.
// --------------------------------------------------------------------------
//
// WHAT "END TO END" MEANS ON THIS LEG, AND WHY IT DIFFERS FROM CODEX'S. The
// Codex band translates the provider's wire request itself, so its round-trip
// test drives real driver code. Claude's dispatch is a TRANSPORT OBLIGATION
// instead: the daemon-hosted ephemeral MCP server that receives the provider's
// tool call is realized by the transport (`--mcp-config`), and this driver's
// job ends at handing that transport a served registry, its provider-facing
// name map, and a dispatcher. So these tests assert the CONTRACT A TRANSPORT
// MUST SATISFY — reading the legs off the recorded spawn request and performing
// the translate-then-dispatch step a real transport performs — rather than
// asserting code this driver runs.
//
// Spec coverage under test:
//   `Spec-005 §Required Behavior` — the driver answers every callback-tool
//     invocation and invents no approval bypass; a spawn with no dispatcher
//     bound serves no registry at all.
//   `Spec-012 §Required Behavior` — the invocation reaching the host is
//     adjudicated before it is executed.

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
    // The driver's OWN withholding diagnostic lands here, which is what the
    // no-dispatcher case below reads.
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

describe("ClaudeDriver callback-tool spawn wiring (T3.15 leg 3)", () => {
  it("serves the admitted registry with the provider-facing names a transport must use", async () => {
    const harness = await callbackToolSpawnHarness();

    const callbackToolServer = harness.transport.spawnRequests[0]?.callbackToolServer;

    expect(callbackToolServer?.serverName).toBe(CLAUDE_CALLBACK_MCP_SERVER_NAME);
    expect(callbackToolServer?.tools).toStrictEqual([SEARCH_CALLBACK_TOOL]);
    // The map is the transport's whole reason for receiving a descriptor rather
    // than a bare tool list: the provider answers with the mangled name.
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

    // The transport's own step, performed here exactly as it must be performed
    // there: the provider calls the MANGLED name, and the registry name is
    // recovered from the descriptor's map before dispatch.
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

    // The failure mode the translation exists to prevent, reached from the other
    // direction: a served tool whose invocations the host cannot recognize.
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

    // Withheld rather than served-and-refused: a tool the model never learns
    // exists costs it no turns.
    expect(harness.transport.spawnRequests[0]?.callbackToolServer).toBeUndefined();
    expect(harness.transport.spawnRequests[0]?.callbackTools).toBeUndefined();
    expect(
      harness.withheldDiagnostics.filter(
        (record) => record.kind === "callback_tool_registry_withheld",
      ),
    ).toHaveLength(1);
  });
});
