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

describe("CallbackToolHost — the allow round-trip (T3.15 leg 3)", () => {
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

    const result = await harness.host.dispatch(
      makeInvocation({ toolCallId: "subagent-call-7" }),
      null,
    );

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

    await harness.host.dispatch(makeInvocation(), null);

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
    // The RUNTIME backstop: the provider carries a registration this daemon
    // never performed, so the invocation arrives despite the spawn withholding.
    const harness = buildHarness({ withSeam: false });
    harness.host.resolveSpawnRegistry({
      sessionId: TEST_SESSION_ID,
      requestedTools: [SEARCH_TOOL],
      providerRegistrationAvailable: true,
      providerRegistrationUnavailableDetail: "unused",
    });

    const result = await harness.host.dispatch(makeInvocation(), null);

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

    const result = await harness.host.dispatch(makeInvocation(), null);

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

    expect(binding.resolution.admitted).toBe(true);
    expect(binding.resolution.admitted ? binding.resolution.tools : null).toStrictEqual([
      SEARCH_TOOL,
    ]);
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
      // Explicitly `false` rather than absent: a record that carried the
      // truncation flag only when it fired would make "no flag" ambiguous
      // between an in-bounds value and an older record shape.
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

describe("composeCallbackToolContentItems — per-arm required members (codex round 1)", () => {
  // `DynamicToolCallOutputContentItem` is a closed union whose arms each carry
  // ONE required member beside the discriminator. A predicate that checked only
  // the discriminator shipped `{ type: "inputImage" }` — an image with no image
  // — as a well-formed SUCCESS the model reads as an empty answer it cannot
  // distinguish from a real one.
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

    // WHOLE-VALUE fallback, never a per-item drop: rendering only the surviving
    // items would silently delete content the executor composed, which is the
    // same invisible loss stated one layer down.
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0]).toMatchObject({ type: "inputText" });
    expect((contentItems[0] as { text: string }).text).toContain("type");
  });

  it("REBUILDS an admitted item, dropping siblings the provider's union does not declare", () => {
    // The second silent-loss arm: a well-formed item may carry executor-supplied
    // siblings, and the provider frame is serialized DOWNSTREAM of this function
    // and outside its try. One `BigInt` sibling threw at the write and left the
    // callback ask unanswered — the provider waiting forever on a tool that had
    // already run. The rebuild makes the result serializable BY CONSTRUCTION.
    const contentItems = composeCallbackToolContentItems([
      { type: "inputText", text: "found 2 matches", metadata: 1n },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png", cache: { hit: true } },
    ]);

    expect(contentItems).toStrictEqual([
      { type: "inputText", text: "found 2 matches" },
      { type: "inputImage", imageUrl: "https://example.invalid/a.png" },
    ]);
    // The guarantee, asserted as the operation that used to throw.
    expect(() => JSON.stringify(contentItems)).not.toThrow();
  });

  it("REBUILDS an item whose sibling is a cycle rather than answering with an unwritable frame", () => {
    const cyclic: Record<string, unknown> = { type: "inputText", text: "alpha" };
    cyclic["self"] = cyclic;

    const contentItems = composeCallbackToolContentItems([cyclic]);

    // Every ITEM survives — the loss is confined to members the pinned union
    // does not declare, which the provider would have ignored or rejected.
    expect(contentItems).toStrictEqual([{ type: "inputText", text: "alpha" }]);
    expect(() => JSON.stringify(contentItems)).not.toThrow();
  });

  it("returns a rebuilt array a caller cannot mutate back into the executor's value", () => {
    // The rebuild is also what keeps the executor's own objects out of the
    // frame: mutating the returned item must not reach back into the output.
    const composed = [{ type: "inputText", text: "alpha" }];

    const contentItems = composeCallbackToolContentItems(composed);

    expect(contentItems[0]).not.toBe(composed[0]);
    expect(contentItems[0]).toStrictEqual(composed[0]);
  });

  it("treats an empty required member as absent, because both read as no answer", () => {
    // `imageUrl: ""` is the same invisible answer a missing `imageUrl` is; a
    // length check is what keeps the two from being classified differently.
    expect(composeCallbackToolContentItems([{ type: "inputText", text: "" }])).toStrictEqual([
      { type: "inputText", text: '[{"type":"inputText","text":""}]' },
    ]);
  });
});

describe("CallbackToolHost — the registry is scoped to the spawn that installed it", () => {
  // THE RACE. A resume or relaunch installs a new registry for the same session
  // before the superseded spawn's teardown runs. Without a per-binding token the
  // old `release()` deletes the NEW registry, and the old process's callbacks
  // are adjudicated against the replacement.
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

    // The live binding still dispatches: its registry was not deleted by a
    // teardown that belonged to a process that is already gone.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    expect(harness.emittedDiagnostics.map((record) => record.kind)).toStrictEqual([
      // The supersession itself, then the ignored release.
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
    // Never adjudicated: a same-named tool in the replacement registry must not
    // launder a dead process's call into the live spawn's approval seam.
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

  // THE OTHER ENTRY POINT. The three cases above drive the spawn-bound closure,
  // which carries a token. The routed-ask responder does not — it is bound once
  // per driver and dispatches UNSCOPED — so the property that keeps it honest is
  // a different one, and it is pinned here rather than left to the doc comment:
  // the responder addresses the registry installed NOW. A tool only a superseded
  // spawn served is unreachable through it, and the live spawn's own tool is
  // reachable, which is what makes the negative half of this pair non-vacuous.
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
  // THE ARM `release()` CANNOT COVER. Step 1 installs before step 2 spawns, so a
  // resume whose spawn then FAILS has already superseded a predecessor that the
  // Codex resume path deliberately leaves alive. Releasing the failed
  // replacement deletes only the replacement, and the surviving process's
  // closure then dispatches against a registry that is simply absent — every
  // later tool call from a healthy session refused, permanently.
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

    // The predecessor's OWN token addresses the restored registry again — the
    // property that matters, since its closure holds that token and nothing
    // else.
    await expect(liveBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "completed",
      output: { hits: 0 },
    });
    // The restore is a registry replacement like any other and is RECORDED as
    // one, so an operator's model does not go stale at the supersede it undoes.
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
    // Same failure, wrong call. This is the defect verbatim: the predecessor is
    // alive and its every later callback is refused for an absent registry.
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
    // What makes `rollback` safe to call unconditionally on a failed spawn: a
    // first spawn has no predecessor, and the correct end state is an empty one.
    const harness = buildHarness();
    const onlyBinding = bindSpawn(harness, [SEARCH_TOOL]);

    onlyBinding.rollback();

    await expect(onlyBinding.onCallbackToolCall(makeInvocation())).resolves.toStrictEqual({
      status: "failed",
      error: "invocation names a session with no registered callback-tool registry",
    });
    // Nothing was superseded, so no REGISTRY record is emitted either — the one
    // diagnostic here is the refused dispatch the assertion above provoked.
    expect(
      harness.emittedDiagnostics
        .map((record) => record.kind)
        .filter((kind) => kind.startsWith("callback_tool_registry_")),
    ).toStrictEqual([]);
  });

  it("ignores a rollback whose installation a THIRD spawn already superseded", async () => {
    // Undoing here would tear down a live registry to restore a dead one. Same
    // condition as a late release, so it takes the same recorded kind.
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
    // Depth one is a correctness bound before it is a memory bound: an
    // installation two supersedes back was displaced by a spawn that SUCCEEDED,
    // so restoring it would revive a registry whose process is gone.
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
    // 128 is `DRIVER_TOOL_NAME_MAX_LEN`, the same bound the wire contract holds
    // the field to — so an unbounded identifier cannot ride an unparseable
    // frame into the 256-record buffer and the log sink behind it.
    expect(refusal?.details["toolName"]).toBe("z".repeat(128));
    expect(refusal?.details["toolNameTruncated"]).toBe(true);
    // The ORIGINAL length is kept beside the truncation, so the record still
    // says how far past the bound the provider was.
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
    // ONE leading ASCII unit shifts the 128-unit cut onto a pair's HIGH half,
    // which a naive `slice` turns into a lone surrogate that no longer
    // round-trips through a JSON log sink. Without the leading unit the cut
    // lands on a pair boundary and nothing is trimmed — both are asserted,
    // because a guard that always trimmed one unit would pass the split case
    // and quietly corrupt the aligned one.
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

    // `SessionCallbackTool` declares mutable members, so a driver CAN write
    // here; what must not happen is the host's own registry moving with it.
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

    // The CALLER's descriptor stays writable — the host froze its own copy, not
    // the object it was given, which is not the host's to freeze.
    expect(binding.callbackTools[0]).not.toBe(SEARCH_TOOL);
    expect(binding.callbackTools[0]).toStrictEqual(SEARCH_TOOL);
    expect(Object.isFrozen(SEARCH_TOOL)).toBe(false);
  });
});
