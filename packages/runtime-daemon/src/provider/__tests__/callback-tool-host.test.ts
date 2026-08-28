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
  CallbackToolHost,
  describeArgumentRefusal,
  type CallbackToolActivityRecord,
  type CallbackToolApprovalOutcome,
  type CallbackToolApprovalRequest,
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
