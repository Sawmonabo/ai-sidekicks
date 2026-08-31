// Callback-tool host suite (Plan-005 Phase 3, T3.15 leg 3).
//
// Spec coverage under test:
//   • `Spec-005 §Required Behavior` — the driver answers EVERY callback-tool
//     invocation and invents no approval bypass. Asserted as: an allow
//     round-trip answers `completed`, a deny round-trip answers `denied`, and
//     a stray invocation against a seamless host answers `denied` with a
//     `DriverDiagnosticRecord` rather than hanging or completing.
//   • `Spec-012 §Required Behavior` — every tool invocation is adjudicated. The
//     evaluate-first ordering is asserted through the recorded `approvalBasis`
//     and through the seam never being consulted for a pre-check refusal.
//   • `Spec-016 §Provider-Native Subagents` — a child's tool calls route
//     through the same pipeline as the parent's; asserted as the same host
//     answering an invocation carrying a subagent-originated call id.
//
// Verifies invariant: I-005-4 (an unavailable capability degrades rather than
// throwing — the seamless host DENIES and records, and never rejects).

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

describe("CallbackToolHost — the allow round-trip (T3.15 leg 3)", () => {
  it("answers `completed` and lands the outcome as a `tool_activity` row", async () => {
    const harness = buildHarness();
    const resolution = harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });
    expect(resolution).toStrictEqual({ admitted: true, tools: [SEARCH_TOOL] });

    const result = await harness.host.dispatch(makeInvocation());

    expect(result).toStrictEqual({ status: "completed", output: { hits: 0 } });
    // The pipeline was consulted BEFORE the executor ran, which is what makes
    // "never completed without Cedar" observable rather than merely intended.
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
    // `Spec-016 §Provider-Native Subagents`: a child's calls are adjudicated by
    // the parent's pipeline, so nothing about the host's answer changes.
    const harness = buildHarness();
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation({ toolCallId: "subagent-call-7" }));

    expect(result.status).toBe("completed");
    expect(harness.activityRecords[0]?.toolCallId).toBe("subagent-call-7");
    expect(harness.activityRecords[0]?.approvalBasis).toBe("policy");
  });

  it("records a remembered-rule allow as its own basis, never as a participant grant", async () => {
    const harness = buildHarness({ outcome: { decision: "allow", basis: "remembered-rule" } });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    await harness.host.dispatch(makeInvocation());

    expect(harness.activityRecords[0]?.approvalBasis).toBe("remembered-rule");
  });
});

describe("CallbackToolHost — the deny round-trip (T3.15 leg 3)", () => {
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

    const result = await harness.host.dispatch(makeInvocation());

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
    // The RUNTIME backstop: the provider carries a registration this daemon
    // never performed, so the invocation arrives despite the spawn withholding.
    const harness = buildHarness({ withSeam: false });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation());

    // `denied`, not `failed`: the call is well-formed and the DAEMON is
    // refusing it. Blaming the provider for a registry the daemon itself
    // withheld would misreport whose decision this was.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toHaveLength(0);
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.activityRecords[0]?.approvalBasis).toBeNull();
  });

  it("refuses on the seam BEFORE the registry, so the arm is reachable at all", async () => {
    // Ordering assertion, not a duplicate: a seamless host refuses an
    // invocation naming a session it never resolved with the SAME
    // `denied-no-seam` answer. Were the registry checked first, every
    // invocation reaching a seamless host would answer `failed-unknown-tool`
    // and the `denied` arm the leg-3 rule names could never fire.
    const harness = buildHarness({ withSeam: false });

    const result = await harness.host.dispatch(makeInvocation());

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

    const result = await harness.host.dispatch(makeInvocation({ toolName: "delete_everything" }));

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

    const result = await harness.host.dispatch(makeInvocation({ arguments: {} }));

    expect(result.status).toBe("failed");
    expect(harness.evaluatedRequests).toHaveLength(0);
    expect(harness.activityRecords[0]?.disposition).toBe("failed-invalid-arguments");
  });

  it("refuses an invocation naming a session this host never resolved", async () => {
    const harness = buildHarness();

    const result = await harness.host.dispatch(makeInvocation());

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
    harness.host.forgetSession(TEST_SESSION_ID);

    const result = await harness.host.dispatch(makeInvocation());

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

    const result = await harness.host.dispatch(makeInvocation());

    expect(result).toStrictEqual({ status: "failed", error: "the workspace mount vanished" });
    expect(harness.activityRecords[0]?.disposition).toBe("failed-in-execution");
    // The basis survives: the invocation WAS adjudicated, and the row must not
    // read as though it had been refused before the pipeline.
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

    const result = await harness.host.dispatch(makeInvocation());

    // A rejected evaluation is an UNANSWERED one. Letting the rejection escape
    // would surface as a driver fault the provider retries; catching it and
    // proceeding would run the tool with no adjudication at all. Both are worse
    // than refusing, which is the same answer a missing seam already produces.
    expect(result.status).toBe("denied");
    expect(harness.executedInvocations).toStrictEqual([]);
    expect(harness.activityRecords[0]?.disposition).toBe("denied-no-seam");
    expect(harness.diagnostics.recentRecordsOfKind("callback_tool_seam_absent")).toHaveLength(1);
    // The cause travels: an operator must be able to tell a seam that is absent
    // from one that is present and failing.
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

    const result = await harness.host.dispatch(makeInvocation());

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

    const result = await harness.host.dispatch(makeInvocation());

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

// --------------------------------------------------------------------------
// The composition-root binder and the routed-ask adapter (T3.15 leg 3).
// --------------------------------------------------------------------------
//
// Spec coverage added here:
//   • `Spec-005 §Required Behavior` — the driver answers EVERY callback-tool
//     invocation. Asserted one layer earlier than the suite above does it: an
//     ask the driver band cannot even TURN INTO an invocation is still
//     answered, and still recorded.
//   • `Spec-012 §Required Behavior` — an approval ask reaching this adapter
//     with no Plan-012 responder bound is refused rather than allowed.

/** The two names the provider's `DynamicToolCallParams` supplies. */
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

    expect(binding.resolution).toStrictEqual({ admitted: true, tools: [SEARCH_TOOL] });
    expect(binding.callbackTools).toStrictEqual([SEARCH_TOOL]);
    // Step 1 ran inside the binder, so the dispatcher it hands over already has
    // a registry to resolve against — the ordering the host documents as
    // load-bearing is structural here rather than remembered.
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
    // The runtime backstop is the whole reason the dispatcher stays bound: a
    // provider carrying a registration this daemon never performed is refused
    // and recorded rather than left unanswered.
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
    // Idempotent: a teardown path that runs twice must not throw.
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

    // The spawn params declare a MUTABLE array, so a driver could mutate what
    // it was handed; the resolution the host answered must not move with it.
    expect(binding.resolution).toStrictEqual({ admitted: true, tools: [SEARCH_TOOL] });
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
    // The provider's own field names reached the invocation unchanged: `tool`
    // is the registry name and `callId` is copied verbatim for tool pairing.
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
    // The refusal happens BEFORE the host's dispatcher, so without this record
    // an operator would see a dropped tool call with nothing explaining it.
    const refusals = harness.emittedDiagnostics.filter(
      (record) => record.kind === "callback_tool_invocation_refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.details).toStrictEqual({
      sessionId: TEST_SESSION_ID,
      runId: null,
      toolName: SEARCH_TOOL.name,
      toolCallId: "call-1",
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

    // `DynamicToolCallParams.arguments` is schema-typed as ANY JSON value at
    // the pin, so this is a shape the provider is entitled to send rather than
    // a defensive hypothetical.
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
    // The callback-tool host is not in this path at all: an approval is not a
    // tool call, and routing one through the tool registry would adjudicate the
    // wrong question.
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
    // Deliberately NOT recorded as a callback-tool diagnostic: those kinds name
    // this host's conditions, and an approval refusal is not one of them.
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
    // The defect this function exists for: a raw pass-through would answer
    // `success: true` with an array the response type does not admit.
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
      ["mcp__sidekicks__search_workspace", SEARCH_TOOL.name],
    ]);

    expect(
      resolveRegisteredCallbackToolName(
        registryNamesByProviderName,
        "mcp__sidekicks__search_workspace",
      ),
    ).toBe(SEARCH_TOOL.name);
  });

  it("passes an unknown name through so the host's refusal names what arrived", () => {
    expect(resolveRegisteredCallbackToolName(new Map(), "mcp__other__tool")).toBe(
      "mcp__other__tool",
    );
  });
});
