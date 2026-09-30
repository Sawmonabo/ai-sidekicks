// Callback-tool host and the provider ask responder: every tool call is answered, nothing runs
// without the approval seam's allow, a registry answers only for the spawn that installed it, and
// the answer is always a content-item frame the provider accepts.

import { describe, expect, it } from "vitest";

import type { RunId, SessionCallbackTool, SessionId } from "@ai-sidekicks/contracts";

import {
  bindCallbackToolsForSpawn,
  CallbackToolHost,
  type CallbackToolActivityRecord,
  type CallbackToolApprovalOutcome,
  type CallbackToolApprovalRequest,
  type CallbackToolSpawnBinding,
} from "../callback-tool-host.js";
import {
  composeCallbackToolContentItems,
  createCallbackToolAskResponder,
  type RoutedProviderAsk,
} from "../callback-tool-ask-responder.js";
import { DriverDiagnosticsEmitter, type DriverDiagnosticRecord } from "../driver-diagnostics.js";
import type { CallbackToolInvocation, CallbackToolResult } from "../provider-driver.js";

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

describe("CallbackToolHost — the allow round-trip", () => {
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
});

describe("CallbackToolHost — the deny round-trip", () => {
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
});

/** The wire method name of a dynamic tool-call ask. */
const TOOL_CALL_METHOD = "item/tool/call";

function buildAskResponder(harness: HostHarness) {
  return createCallbackToolAskResponder({ host: harness.host, approvalAskResponder: null });
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

describe("bindCallbackToolsForSpawn — release", () => {
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
  it("renders an un-serializable output as a visible item rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const contentItems = composeCallbackToolContentItems(cyclic);

    expect(contentItems).toHaveLength(1);
    expect((contentItems[0] as { text: string }).text).toContain("could not render");
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
});
