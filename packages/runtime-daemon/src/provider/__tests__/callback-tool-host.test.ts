// Callback-tool host: every invocation is answered and adjudicated, and nothing bypasses approval.
//   * an allow round-trip answers `completed`, a deny round-trip answers `denied`, and a stray
//     invocation against a seamless host answers `denied` with a diagnostic rather than hanging;
//   * the pipeline is consulted first (visible in `approvalBasis` and in the seam going
//     unconsulted for a pre-check refusal);
//   * a subagent's tool calls go through the same host as the parent's.

import { describe, expect, it } from "vitest";

import type {
  CallbackToolInvocation,
  CallbackToolResult,
  RunId,
  SessionCallbackTool,
  SessionId,
} from "@ai-sidekicks/contracts";

import {
  bindCallbackToolsForSpawn,
  CallbackToolHost,
  composeCallbackToolContentItems,
  createCallbackToolAskResponder,
  describeArgumentRefusal,
  resolveRegisteredCallbackToolName,
  type CallbackToolActivityRecord,
  type CallbackToolApprovalOutcome,
  type CallbackToolApprovalRequest,
  type CallbackToolSpawnBinding,
  type RoutedProviderAsk,
  type RoutedProviderAskResponder,
} from "../callback-tool-host.js";
import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../driver-diagnostics.js";

const TEST_SESSION_ID: SessionId = "11111111-1111-4111-8111-111111111111" as SessionId;
const TEST_RUN_ID: RunId = "22222222-2222-4222-8222-222222222222" as RunId;

const SEARCH_TOOL: SessionCallbackTool = {
  name: "search_workspace",
  description: "Searches the session's mounted workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

interface HostHarness {
  readonly host: CallbackToolHost;
  readonly diagnostics: DriverDiagnosticsEmitter;
  readonly emittedDiagnostics: DriverDiagnosticRecord[];
  readonly activityRecords: CallbackToolActivityRecord[];
  readonly evaluatedRequests: CallbackToolApprovalRequest[];
  readonly executedInvocations: CallbackToolInvocation[];
}

function buildHarness(options?: {
  readonly outcome?: CallbackToolApprovalOutcome;
  readonly withSeam?: boolean;
  readonly executeResult?: CallbackToolResult;
  readonly executeThrows?: Error;
  readonly evaluateThrows?: unknown;
}): HostHarness {
  const emittedDiagnostics: DriverDiagnosticRecord[] = [];
  const activityRecords: CallbackToolActivityRecord[] = [];
  const evaluatedRequests: CallbackToolApprovalRequest[] = [];
  const executedInvocations: CallbackToolInvocation[] = [];
  const diagnostics = new DriverDiagnosticsEmitter({
    logSink: { record: (record) => emittedDiagnostics.push(record) },
    counterSink: { increment: () => undefined },
  });
  const outcome: CallbackToolApprovalOutcome = options?.outcome ?? {
    decision: "allow",
    basis: "policy",
  };
  const host = new CallbackToolHost({
    provider: "claude",
    diagnostics,
    executor: {
      execute: async (invocation) => {
        executedInvocations.push(invocation);
        if (options?.executeThrows !== undefined) {
          throw options.executeThrows;
        }
        return await Promise.resolve(
          options?.executeResult ?? { status: "completed", output: { hits: 0 } },
        );
      },
    },
    activitySink: { record: (record) => activityRecords.push(record) },
    ...(options?.withSeam === false
      ? {}
      : {
          approvalSeam: {
            evaluate: async (request) => {
              evaluatedRequests.push(request);
              if (options?.evaluateThrows !== undefined) {
                throw options.evaluateThrows;
              }
              return await Promise.resolve(outcome);
            },
          },
        }),
  });
  return {
    host,
    diagnostics,
    emittedDiagnostics,
    activityRecords,
    evaluatedRequests,
    executedInvocations,
  };
}

function makeInvocation(overrides?: Partial<CallbackToolInvocation>): CallbackToolInvocation {
  return {
    toolName: SEARCH_TOOL.name,
    arguments: { query: "needle" },
    toolCallId: "call-1",
    sessionId: TEST_SESSION_ID,
    runId: TEST_RUN_ID,
    ...overrides,
  };
}

describe("CallbackToolHost — the allow round-trip (leg 3)", () => {
  it("answers `completed` and lands the outcome as a `tool_activity` row", async () => {
    const harness = buildHarness();
    const resolution = harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    expect(resolution.admitted).toBe(true);
    expect(resolution.admitted ? resolution.tools : null).toStrictEqual([SEARCH_TOOL]);

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({ status: "completed", output: { hits: 0 } });
    // The pipeline ran before the executor, so no call completes without a policy decision.
    expect(harness.evaluatedRequests).toHaveLength(1);
    expect(harness.evaluatedRequests[0]?.arguments).toStrictEqual({ query: "needle" });
    expect(harness.executedInvocations).toHaveLength(1);
    expect(harness.activityRecords).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        toolName: SEARCH_TOOL.name,
        toolCallId: "call-1",
        disposition: "completed",
        approvalBasis: "policy",
      },
    ]);
  });

  it("routes a subagent-originated invocation through the same pipeline", async () => {
    // A child's calls are adjudicated by the parent's pipeline, so the host's answer is the same.
    const harness = buildHarness();
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(
      makeInvocation({ toolCallId: "subagent-call-7" }),
      null,
    );

    expect(result.status).toBe("completed");
    expect(harness.activityRecords[0]?.toolCallId).toBe("subagent-call-7");
    expect(harness.activityRecords[0]?.approvalBasis).toBe("policy");
  });

  it("records a remembered-rule allow as its own basis, never as a user grant", async () => {
    const harness = buildHarness({ outcome: { decision: "allow", basis: "remembered-rule" } });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    await harness.host.dispatch(makeInvocation(), null);

    expect(harness.activityRecords[0]?.approvalBasis).toBe("remembered-rule");
  });
});

describe("CallbackToolHost — the deny round-trip (leg 3)", () => {
  it("answers `denied` without executing, and lands it as a `tool_activity` row", async () => {
    const harness = buildHarness({
      outcome: { decision: "deny", basis: "policy", reason: "workspace search is not permitted" },
    });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({
      status: "denied",
      error: "workspace search is not permitted",
    });
    expect(harness.executedInvocations).toHaveLength(0);
    expect(harness.activityRecords).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        toolName: SEARCH_TOOL.name,
        toolCallId: "call-1",
        disposition: "denied-by-policy",
        approvalBasis: "policy",
      },
    ]);
  });
});

describe("CallbackToolHost — the no-seam spawn and the stray invocation", () => {
  it("withholds the registry at spawn and records why", () => {
    const harness = buildHarness({ withSeam: false });

    const resolution = harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    expect(harness.host.canAdjudicate).toBe(false);
    expect(resolution.admitted).toBe(false);
    expect(resolution.admitted === false ? resolution.reason : undefined).toBe("no-approval-seam");
    const withholdings = harness.diagnostics.recentRecordsOfKind("callback_tool_registry_withheld");
    expect(withholdings).toHaveLength(1);
    expect(withholdings[0]?.details["withheldToolCount"]).toBe(1);
  });

  it("answers a stray invocation `denied` with a diagnostic, never `completed`", async () => {
    // The provider carries a registration this daemon never performed, so the call arrives anyway.
    const harness = buildHarness({ withSeam: false });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    // `denied`, not `failed`: the call is well-formed and the daemon is the one refusing it.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toHaveLength(0);
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.activityRecords[0]?.approvalBasis).toBeNull();
  });

  it("refuses on the seam BEFORE the registry, so the arm is reachable at all", async () => {
    // A seamless host refuses an invocation naming an unresolved session with the same
    // `denied-no-seam` answer; checking the registry first would answer `failed-unknown-tool`
    // and the `denied` arm could never fire.
    const harness = buildHarness({ withSeam: false });

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result.status).toBe("denied");
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
  });

  it("withholds for an unavailable provider registration and names that reason", () => {
    const harness = buildHarness();

    const resolution = harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: false,
      providerRegistrationUnavailableDetail: "the negotiated posture registers no dynamic tools",
    });

    expect(resolution.admitted).toBe(false);
    expect(resolution.admitted === false ? resolution.reason : undefined).toBe(
      "provider-registration-unavailable",
    );
  });
});

describe("CallbackToolHost — refusals that precede the pipeline", () => {
  it("refuses an unknown tool name WITHOUT consulting the seam", async () => {
    const harness = buildHarness();
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(
      makeInvocation({ toolName: "delete_everything" }),
      null,
    );

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-unknown-tool");
  });

  it("refuses schema-invalid arguments WITHOUT consulting the seam", async () => {
    const harness = buildHarness();
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation({ arguments: {} }), null);

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-invalid-arguments");
  });

  it("refuses an invocation naming a session this host never resolved", async () => {
    const harness = buildHarness();

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result.status).toBe("failed");
    expect(result.error ?? "").toContain("no registered callback-tool registry");
    expect(harness.evaluatedRequests).toHaveLength(0);
  });

  it("refuses again after `forgetSession`", async () => {
    const harness = buildHarness();
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    harness.host.forgetSession(TEST_SESSION_ID, null);

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
  });
});

describe("CallbackToolHost — execution outcomes are the tool's, not the pipeline's", () => {
  it("records an executor throw as an allowed row that failed, never as a refusal", async () => {
    const harness = buildHarness({ executeThrows: new Error("the workspace mount vanished") });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result).toStrictEqual({ status: "failed", error: "the workspace mount vanished" });
    expect(harness.activityRecords[0]?.disposition).toBe("failed-in-execution");
    // The invocation was adjudicated, so the row keeps its basis instead of reading as a refusal.
    expect(harness.activityRecords[0]?.approvalBasis).toBe("policy");
  });

  it("refuses when the approval seam THROWS, rather than completing unadjudicated", async () => {
    const harness = buildHarness({ evaluateThrows: new Error("the policy store is unreachable") });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    // A rejected evaluation is an unanswered one: letting it escape would read as a driver fault
    // the provider retries, and proceeding would run the tool unadjudicated. Refusing matches the
    // missing-seam answer.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toStrictEqual([]);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    // The cause travels so an operator can tell an absent seam from a failing one.
    expect(result.error).toContain("the policy store is unreachable");
  });

  it("refuses on a seam REJECTION that carries no Error instance", async () => {
    const harness = buildHarness({ evaluateThrows: "policy store said no" });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toStrictEqual([]);
  });

  it("normalizes a detail-free throw rather than answering with an empty error", async () => {
    const harness = buildHarness({ executeThrows: new Error("") });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

    expect(result.error).toBe("The callback-tool executor failed with no describable detail.");
  });
});

describe("describeArgumentRefusal — the named subset, and nothing beyond it", () => {
  it("admits arguments whose declared required properties are all present", () => {
    expect(describeArgumentRefusal(SEARCH_TOOL, { query: "needle", extra: 1 })).toBeNull();
  });

  it("names every missing required property in one refusal", () => {
    const twoRequired: SessionCallbackTool = {
      ...SEARCH_TOOL,
      inputSchema: { type: "object", required: ["query", "scope"] },
    };
    expect(describeArgumentRefusal(twoRequired, {})).toContain("query, scope");
  });

  it("refuses a non-object input schema as uninvocable by construction", () => {
    const arrayTool: SessionCallbackTool = {
      ...SEARCH_TOOL,
      inputSchema: { type: "array" },
    };
    expect(describeArgumentRefusal(arrayTool, {})).toContain("non-object input schema");
  });

  it("admits a schema declaring no `required` array rather than guessing", () => {
    const looseTool: SessionCallbackTool = { ...SEARCH_TOOL, inputSchema: { type: "object" } };
    expect(describeArgumentRefusal(looseTool, {})).toBeNull();
  });
});

// The composition-root binder and the routed-ask adapter: an ask that cannot become an
// invocation is still answered and recorded, and an approval ask with no responder bound is
// refused.

/** The wire method name of a dynamic tool-call ask. */
const TOOL_CALL_METHOD = "item/tool/call";

function buildAskResponder(harness: HostHarness, approval?: RoutedProviderAskResponder | null) {
  return createCallbackToolAskResponder({
    host: harness.host,
    approvalAskResponder: approval ?? null,
  });
}

function makeToolCallAsk(overrides?: Partial<RoutedProviderAsk>): RoutedProviderAsk {
  return {
    method: TOOL_CALL_METHOD,
    askKind: "callback-tool",
    params: {
      tool: SEARCH_TOOL.name,
      callId: "call-1",
      arguments: { query: "needle" },
      threadId: "thread-1",
      turnId: "turn-1",
    },
    sessionId: TEST_SESSION_ID,
    runId: TEST_RUN_ID,
    ...overrides,
  };
}

describe("bindCallbackToolsForSpawn — the composition root's three steps as one value", () => {
  it("offers the admitted tools and binds a dispatcher that reaches the host", async () => {
    const harness = buildHarness();

    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    expect(binding.resolution.admitted).toBe(true);
    expect(binding.resolution.admitted ? binding.resolution.tools : null).toStrictEqual([
      SEARCH_TOOL,
    ]);
    expect(binding.callbackTools).toStrictEqual([SEARCH_TOOL]);
    // The binder installs the registry before handing over the dispatcher, so it resolves at once.
    await expect(binding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
  });

  it("still binds a dispatcher on a withholding so a stray invocation is recorded", async () => {
    const harness = buildHarness({ withSeam: false });

    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    expect(binding.resolution.admitted).toBe(false);
    expect(binding.callbackTools).toStrictEqual([]);
    // The dispatcher stays bound so a registration this daemon never performed is refused and
    // recorded rather than left unanswered.
    const result = await binding.onCallbackToolCall(makeInvocation());
    expect(result.status).toBe("denied");
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toContain(
      "callback_tool_seam_absent",
    );
  });

  it("releases the session's registry, so a later invocation names no registry", async () => {
    const harness = buildHarness();
    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    binding.release();
    // A teardown path that runs twice must not throw.
    binding.release();

    const result = await binding.onCallbackToolCall(makeInvocation());
    expect(result).toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
  });

  it("hands over a fresh tool array rather than the host's own answer", () => {
    const harness = buildHarness();
    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    binding.callbackTools.push({ ...SEARCH_TOOL, name: "smuggled_tool" });

    // The spawn params declare a mutable array; the resolution must not move if a driver edits it.
    expect(binding.resolution.admitted).toBe(true);
    expect(binding.resolution.admitted ? binding.resolution.tools : null).toStrictEqual([
      SEARCH_TOOL,
    ]);
  });
});

describe("createCallbackToolAskResponder — the callback-tool arm", () => {
  it("turns one routed ask into an adjudicated invocation and answers with content items", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const decision = await buildAskResponder(harness).answer(makeToolCallAsk());

    expect(decision).toStrictEqual({
      decision: "allow",
      payload: { contentItems: [{ type: "inputText", text: '{"hits":0}' }] },
    });
    // `tool` is the registry name and `callId` is copied verbatim for tool pairing.
    expect(harness.executedInvocations[0]?.toolName).toBe(SEARCH_TOOL.name);
    expect(harness.executedInvocations[0]?.toolCallId).toBe("call-1");
  });

  it("refuses and RECORDS an ask raised with no turn active", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const decision = await buildAskResponder(harness).answer(makeToolCallAsk({ runId: null }));

    expect(decision.decision).toBe("refuse");
    // The refusal precedes the host's dispatcher, so this record is the only trace of the drop.
    const refusals = harness.emittedDiagnostics.filter(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.details).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      runId: null,
      toolName: SEARCH_TOOL.name,
      // Always present, so a missing flag never means either an in-bounds value or an older shape.
      toolNameTruncated: false,
      toolCallId: "call-1",
      toolCallIdTruncated: false,
    });
    expect(harness.evaluatedRequests).toHaveLength(0);
  });

  it("refuses and RECORDS a non-object `arguments` payload the provider may legally send", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    // The provider's schema allows any JSON value for `arguments`, so this shape can arrive.
    const decision = await buildAskResponder(harness).answer(
      makeToolCallAsk({
        params: { tool: SEARCH_TOOL.name, callId: "call-2", arguments: "needle" },
      }),
    );

    expect(decision.decision).toBe("refuse");
    const refusals = harness.emittedDiagnostics.filter(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusals[0]?.details["toolCallId"]).toBe("call-2");
    expect(harness.evaluatedRequests).toHaveLength(0);
  });

  it("carries a `null` name into the record when the provider supplied none", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    await buildAskResponder(harness).answer(makeToolCallAsk({ params: { threadId: "t" } }));

    const refusals = harness.emittedDiagnostics.filter(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusals[0]?.details["toolName"]).toBeNull();
    expect(refusals[0]?.details["toolCallId"]).toBeNull();
  });

  it("relays the host's own refusal reason rather than inventing one", async () => {
    const harness = buildHarness({
      outcome: { decision: "deny", basis: "policy", reason: "workspace search is not permitted" },
    });
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const decision = await buildAskResponder(harness).answer(makeToolCallAsk());

    expect(decision).toStrictEqual({
      decision: "refuse",
      reason: "workspace search is not permitted",
    });
  });
});

describe("createCallbackToolAskResponder — the approval arm", () => {
  it("delegates an approval ask to the bound responder verbatim", async () => {
    const harness = buildHarness();
    const delegatedAsks: RoutedProviderAsk[] = [];
    const responder = buildAskResponder(harness, {
      answer: async (request) => {
        delegatedAsks.push(request);
        return await Promise.resolve({ decision: "allow" as const });
      },
    });

    const approvalAsk: RoutedProviderAsk = {
      method: "item/commandExecution/requestApproval",
      askKind: "approval",
      params: { command: "ls" },
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    };
    const decision = await responder.answer(approvalAsk);

    expect(decision).toStrictEqual({ decision: "allow" });
    expect(delegatedAsks).toStrictEqual([approvalAsk]);
    // The callback-tool host is not involved: an approval is not a tool call.
    expect(harness.executedInvocations).toHaveLength(0);
  });

  it("refuses an approval ask with no responder bound, naming the method", async () => {
    const harness = buildHarness();

    const decision = await buildAskResponder(harness).answer({
      method: "item/fileChange/requestApproval",
      askKind: "approval",
      params: {},
      sessionId: TEST_SESSION_ID,
      runId: TEST_RUN_ID,
    });

    expect(decision.decision).toBe("refuse");
    expect(decision.decision === "refuse" && decision.reason).toContain(
      "item/fileChange/requestApproval",
    );
    // Not a callback-tool diagnostic: those kinds name this host's conditions.
    expect(harness.emittedDiagnostics).toHaveLength(0);
  });
});

describe("composeCallbackToolContentItems — the silent-loss guard", () => {
  it("answers an absent output as a genuine empty result", () => {
    expect(composeCallbackToolContentItems(undefined)).toStrictEqual([]);
  });

  it("passes an already-well-formed content-item array through untouched", () => {
    const composed = [
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
    ];
    expect(composeCallbackToolContentItems(composed)).toStrictEqual(composed);
  });

  it("wraps a string output rather than answering success with nothing", () => {
    expect(composeCallbackToolContentItems("found 2 matches")).toStrictEqual([
      { type: "inputText", text: "found 2 matches" },
    ]);
  });

  it("wraps a plain array, which the provider's closed union would reject", () => {
    // A raw pass-through would answer `success: true` with an array the response type rejects.
    expect(composeCallbackToolContentItems(["alpha", "beta"])).toStrictEqual([
      { type: "inputText", text: '["alpha","beta"]' },
    ]);
  });

  it("renders an un-serializable output as a visible item rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const contentItems = composeCallbackToolContentItems(cyclic);

    expect(contentItems).toHaveLength(1);
    expect((contentItems[0] as { text: string }).text).toContain("could not render");
  });

  it("renders an output JSON cannot represent at all as a visible item", () => {
    const contentItems = composeCallbackToolContentItems(() => undefined);

    expect((contentItems[0] as { text: string }).text).toContain("could not render");
  });
});

describe("resolveRegisteredCallbackToolName — the provider-facing name map", () => {
  it("translates a mangled provider-facing name back to the registry name", () => {
    const registryNamesByProviderName = new Map([
      ["mcp__sessions__search_workspace", SEARCH_TOOL.name],
    ]);

    expect(
      resolveRegisteredCallbackToolName(
        registryNamesByProviderName,
        "mcp__sessions__search_workspace",
      ),
    ).toBe(SEARCH_TOOL.name);
  });

  it("passes an unknown name through so the host's refusal names what arrived", () => {
    expect(resolveRegisteredCallbackToolName(new Map(), "mcp__other__tool")).toBe(
      "mcp__other__tool",
    );
  });
});

describe("composeCallbackToolContentItems — per-arm required members", () => {
  // `DynamicToolCallOutputContentItem` is a closed union whose arms each carry one required
  // member beside the discriminator. A check on the discriminator alone would ship
  // `{ type: "inputImage" }` as a success the model reads as an empty answer.
  it("passes each arm through when its required member is present", () => {
    const composed = [
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
      { type: "inputAudio", audioUrl: "https://example.invalid/a.wav" },
    ];

    expect(composeCallbackToolContentItems(composed)).toStrictEqual(composed);
  });

  it.each([
    ["inputText missing `text`", [{ type: "inputText" }]],
    ["inputImage missing `imageUrl`", [{ type: "inputImage" }]],
    ["inputAudio missing `audioUrl`", [{ type: "inputAudio" }]],
    ["inputText with a non-string `text`", [{ type: "inputText", text: 7 }]],
    ["inputImage with an EMPTY `imageUrl`", [{ type: "inputImage", imageUrl: "" }]],
    ["an unknown discriminator", [{ type: "inputVideo", videoUrl: "https://example.invalid/a" }]],
    [
      "one malformed item beside two well-formed ones",
      [
        { type: "inputText", text: "alpha" },
        { type: "inputImage" },
        { type: "inputText", text: "beta" },
      ],
    ],
  ])("renders %s as text rather than shipping it as a malformed success", (_label, output) => {
    const contentItems = composeCallbackToolContentItems(output);

    // Fall back for the whole value, never per item: dropping items would silently lose content.
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0]).toMatchObject({ type: "inputText" });
    expect((contentItems[0] as { text: string }).text).toContain("type");
  });

  it("REBUILDS an admitted item, dropping siblings the provider's union does not declare", () => {
    // A well-formed item may carry executor-supplied siblings, and the provider frame is
    // serialized after this function returns. A `BigInt` sibling once threw at the write and left
    // the ask unanswered. The rebuild makes the result serializable by construction.
    const contentItems = composeCallbackToolContentItems([
      { type: "inputText", text: "found 2 matches", metadata: 1n },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png", cache: { hit: true } },
    ]);

    expect(contentItems).toStrictEqual([
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
    ]);
    // The operation that used to throw.
    expect(() => JSON.stringify(contentItems)).not.toThrow();
  });

  it("REBUILDS an item whose sibling is a cycle rather than answering with an unwritable frame", () => {
    const cyclic: Record<string, unknown> = { type: "inputText", text: "alpha" };
    cyclic["self"] = cyclic;

    const contentItems = composeCallbackToolContentItems([cyclic]);

    // Every item survives; only members the union does not declare are lost.
    expect(contentItems).toStrictEqual([{ type: "inputText", text: "alpha" }]);
    expect(() => JSON.stringify(contentItems)).not.toThrow();
  });

  it("returns a rebuilt array a caller cannot mutate back into the executor's value", () => {
    // The rebuild also keeps the executor's own objects out of the frame.
    const composed = [{ type: "inputText", text: "alpha" }];

    const contentItems = composeCallbackToolContentItems(composed);

    expect(contentItems[0]).not.toBe(composed[0]);
    expect(contentItems[0]).toStrictEqual(composed[0]);
  });

  it("treats an empty required member as absent, because both read as no answer", () => {
    // An empty `imageUrl` is as invisible an answer as a missing one, so both are treated alike.
    expect(composeCallbackToolContentItems([{ type: "inputText", text: "" }])).toStrictEqual([
      { type: "inputText", text: '[{"type":"inputText","text":""}]' },
    ]);
  });
});

describe("CallbackToolHost — the registry is scoped to the spawn that installed it", () => {
  // A resume or relaunch installs a new registry for the same session before the superseded
  // spawn's teardown runs. Without a per-binding token, the old `release()` would delete the new
  // registry and the old process's callbacks would be adjudicated against the replacement.
  it("makes a superseded binding's release a no-op, recorded rather than silent", async () => {
    const harness = buildHarness();
    const supersededBinding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const liveBinding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    supersededBinding.release();

    // The live binding still dispatches: the old teardown did not delete its registry.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      // The supersession, then the ignored release.
      "callback_tool_registry_superseded",
      "callback_tool_registry_release_ignored",
    ]);
  });

  it("refuses a superseded binding's dispatch rather than adjudicating it against the live registry", async () => {
    const harness = buildHarness();
    const supersededBinding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await supersededBinding.onCallbackToolCall(makeInvocation());

    expect(result.status).toBe("failed");
    // A same-named tool in the replacement registry must not carry a dead process's call into
    // the live spawn's approval seam.
    expect(harness.evaluatedRequests).toStrictEqual([]);
    expect(harness.executedInvocations).toStrictEqual([]);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-superseded-binding");
  });

  it("keeps the live binding's own release effective after a superseded one was ignored", async () => {
    const harness = buildHarness();
    const supersededBinding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const liveBinding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    supersededBinding.release();

    liveBinding.release();

    const result = await liveBinding.onCallbackToolCall(makeInvocation());
    expect(result).toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
  });

  // The routed-ask responder is bound once per driver and dispatches without a token, so it
  // addresses whichever registry is installed now: a tool only a superseded spawn served is
  // unreachable through it, and the live spawn's tool is reachable, which keeps the negative half
  // of this pair from passing vacuously.
  it("answers the routed-ask path from the live registry, never a superseded one", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const replacementTool: SessionCallbackTool = { ...SEARCH_TOOL, name: "read_workspace" };
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [replacementTool],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const responder = buildAskResponder(harness);

    const supersededToolDecision = await responder.answer(makeToolCallAsk());

    expect(supersededToolDecision.decision).toBe("refuse");
    expect(harness.evaluatedRequests).toStrictEqual([]);
    expect(harness.executedInvocations).toStrictEqual([]);

    const liveToolDecision = await responder.answer(
      makeToolCallAsk({
        params: {
          tool: replacementTool.name,
          callId: "call-2",
          arguments: { query: "needle" },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
    );

    expect(liveToolDecision.decision).toBe("allow");
    expect(harness.executedInvocations.map((invocation) => invocation.toolName)).toStrictEqual([
      replacementTool.name,
    ]);
  });
});

describe("CallbackToolHost — a failed replacement spawn rolls its registry back", () => {
  // Installing a replacement before its spawn means a failed resume has already superseded a
  // predecessor that the Codex resume path deliberately leaves alive. `release()` would delete only
  // the replacement, and the surviving process would then dispatch against an absent registry and
  // be refused on every later call.
  function bindSpawn(
    harness: ReturnType<typeof buildHarness>,
    requestedTools: readonly SessionCallbackTool[],
  ): CallbackToolSpawnBinding {
    return bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools,
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
  }

  it("restores the predecessor's registry, so the surviving process keeps dispatching", async () => {
    const harness = buildHarness();
    const liveBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const failedReplacement = bindSpawn(harness, [{ ...SEARCH_TOOL, name: "read_workspace" }]);

    failedReplacement.rollback();

    // The predecessor's own token addresses the restored registry again; its closure holds
    // nothing else.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    // The restore is a registry replacement like any other and is recorded as one.
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      "callback_tool_registry_superseded",
      "callback_tool_registry_superseded",
    ]);
    expect(harness.emittedDiagnostics[1]?.dispositionReason).toContain("rolled");
    expect(harness.emittedDiagnostics[1]?.details["installedInstallation"]).toBe(
      harness.emittedDiagnostics[0]?.details["supersededInstallation"],
    );
  });

  it("is NOT interchangeable with release — the negative control for the arm above", async () => {
    // Same failure, wrong call: the predecessor is alive and every later callback is refused.
    const harness = buildHarness();
    const liveBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const failedReplacement = bindSpawn(harness, [{ ...SEARCH_TOOL, name: "read_workspace" }]);

    failedReplacement.release();

    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
  });

  it("degenerates to a release where the failed spawn displaced nothing", async () => {
    // A first spawn has no predecessor, so rolling back must leave an empty end state.
    const harness = buildHarness();
    const onlyBinding = bindSpawn(harness, [SEARCH_TOOL]);

    onlyBinding.rollback();

    await expect(onlyBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
    // Nothing was superseded, so no registry record is emitted; the one diagnostic here is the
    // refused dispatch above.
    expect(
      harness.emittedDiagnostics
        .map((record) => record.kind)
        .filter((kind) => kind.startsWith("callback_tool_registry_")),
    ).toStrictEqual([]);
  });

  it("ignores a rollback whose installation a THIRD spawn already superseded", async () => {
    // Undoing here would tear down a live registry to restore a dead one; it is recorded as an
    // ignored release, like a late release.
    const harness = buildHarness();
    bindSpawn(harness, [SEARCH_TOOL]);
    const middleBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const liveBinding = bindSpawn(harness, [SEARCH_TOOL]);

    middleBinding.rollback();

    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      "callback_tool_registry_superseded",
      "callback_tool_registry_superseded",
      "callback_tool_registry_release_ignored",
    ]);
  });

  it("restores exactly ONE installation back, never a chain", async () => {
    // An installation two supersedes back was displaced by a spawn that succeeded, so restoring
    // it would revive a registry whose process is gone.
    const harness = buildHarness();
    const oldestBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const middleBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const failedReplacement = bindSpawn(harness, [SEARCH_TOOL]);

    failedReplacement.rollback();

    await expect(middleBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    const oldestResult = await oldestBinding.onCallbackToolCall(makeInvocation());
    expect(oldestResult.status).toBe("failed");
    expect(harness.activityRecords.at(-1)?.disposition).toBe("failed-superseded-binding");
  });

  it("is idempotent: a second rollback finds a token it no longer owns", async () => {
    const harness = buildHarness();
    const liveBinding = bindSpawn(harness, [SEARCH_TOOL]);
    const failedReplacement = bindSpawn(harness, [SEARCH_TOOL]);

    failedReplacement.rollback();
    failedReplacement.rollback();

    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.at(-1)?.kind).toBe("callback_tool_registry_release_ignored");
  });
});

describe("CallbackToolHost — untrusted identifiers are bounded before they are recorded", () => {
  it("truncates an oversized tool name and marks the truncation explicitly", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const oversizedToolName = "z".repeat(4096);

    const decision = await buildAskResponder(harness).answer(
      makeToolCallAsk({ params: { tool: oversizedToolName, callId: "call-1", arguments: {} } }),
    );

    expect(decision.decision).toBe("refuse");
    const refusal = harness.emittedDiagnostics.find(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    // 128 is `DRIVER_TOOL_NAME_MAX_LEN`, so an unbounded identifier cannot reach the record buffer
    // or the log sink.
    expect(refusal?.details["toolName"]).toBe("z".repeat(128));
    expect(refusal?.details["toolNameTruncated"]).toBe(true);
    // The original length is kept beside the truncation.
    expect(refusal?.details["toolNameOriginalLength"]).toBe(4096);
  });

  it("truncates an oversized call id on the same record", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    await buildAskResponder(harness).answer(
      makeToolCallAsk({
        params: { tool: SEARCH_TOOL.name, callId: "c".repeat(1024), arguments: 7 },
      }),
    );

    const refusal = harness.emittedDiagnostics.find(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusal?.details["toolCallId"]).toBe("c".repeat(256));
    expect(refusal?.details["toolCallIdTruncated"]).toBe(true);
  });

  it("never splits a surrogate pair when it truncates", async () => {
    const harness = buildHarness();
    bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    // One leading ASCII unit moves the 128-unit cut onto a surrogate pair's high half, which a
    // naive `slice` leaves as a lone surrogate that does not round-trip through a JSON log sink.
    // Without it the cut lands on a pair boundary and nothing is trimmed. Both cases are asserted
    // so a guard that always trimmed one unit fails.
    const splittingToolName = `a${"\u{1F600}".repeat(200)}`;

    await buildAskResponder(harness).answer(
      makeToolCallAsk({ params: { tool: splittingToolName, callId: "call-1", arguments: {} } }),
    );

    const splitRefusal = harness.emittedDiagnostics.find(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    const recordedToolName = splitRefusal?.details["toolName"];
    expect(recordedToolName).toBe(`a${"\u{1F600}".repeat(63)}`);
    expect(JSON.parse(JSON.stringify(recordedToolName)) as unknown).toBe(recordedToolName);

    harness.emittedDiagnostics.length = 0;
    await buildAskResponder(harness).answer(
      makeToolCallAsk({
        params: { tool: "\u{1F600}".repeat(200), callId: "call-1", arguments: {} },
      }),
    );

    const alignedRefusal = harness.emittedDiagnostics.find(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(alignedRefusal?.details["toolName"]).toBe("\u{1F600}".repeat(64));
  });
});

describe("CallbackToolHost — descriptors handed to a driver are copies", () => {
  it("does not desync the served registry when a driver mutates what it was handed", async () => {
    const harness = buildHarness();
    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    const handedOver = binding.callbackTools[0];
    if (handedOver === undefined) {
      throw new Error("the binding served no descriptor");
    }

    // `SessionCallbackTool` declares mutable members, so a driver can write here; the host's own
    // registry must not move with it.
    expect(() => {
      (handedOver as { name: string }).name = "smuggled_tool";
    }).toThrow(TypeError);
    expect(() => {
      (handedOver.inputSchema as Record<string, unknown>)["required"] = ["smuggled"];
    }).toThrow(TypeError);

    expect(handedOver.name).toBe(SEARCH_TOOL.name);
    await expect(binding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
  });

  it("hands over a copy, so the caller's own descriptor object is never the registry's", () => {
    const harness = buildHarness();
    const binding = bindCallbackToolsForSpawn(harness.host, {
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    // The caller's descriptor stays writable: the host froze its own copy, not the given object.
    expect(binding.callbackTools[0]).not.toBe(SEARCH_TOOL);
    expect(binding.callbackTools[0]).toStrictEqual(SEARCH_TOOL);
    expect(Object.isFrozen(SEARCH_TOOL)).toBe(false);
  });
});
