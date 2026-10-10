// Routed server requests against a fake service: an approval is held for its card and answered
// through the driver, a callback tool call goes to the host, and every ask the daemon does not
// allow is answered in the method's own refusal shape.

import { describe, expect, it } from "vitest";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import type { ProviderPermissionAsk } from "../../../port/permission-ask.js";

import {
  CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON,
  type CodexServerRequestDecision,
  type CodexSessionServerRequestResponder,
} from "../server-requests.js";
import {
  announceChildThread,
  CHILD_THREAD_ID,
  childRunId,
  createHarness,
  createdSession,
  deliveriesOf,
  type Harness,
  RUN_ID,
  runConfig,
  THREAD_ID,
  TURN_ID,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";

/** A live test session whose callback tool calls reach `responder`, and a way to raise asks. */
async function routedAskHarness(
  responder: CodexSessionServerRequestResponder | undefined,
): Promise<{
  harness: Harness;
  askProvider: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  driverDiagnosticRecords: Harness["driverDiagnosticRecords"];
}> {
  const harness = createHarness(
    responder === undefined ? {} : { answerCallbackToolCall: responder },
  );
  await createdSession(harness);
  harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
  return {
    harness,
    // Every modern ask names its thread, which is how a shared service routes it.
    askProvider: async (method, params = {}) =>
      await harness.server.askProvider(method, { threadId: THREAD_ID, ...params }),
    driverDiagnosticRecords: harness.driverDiagnosticRecords,
  };
}

// --------------------------------------------------------------------------
// Routed server requests reach the daemon, and every path answers.
// --------------------------------------------------------------------------
//
// A responder that is absent, refuses or throws answers the method's own refusal shape:
// never `-32601` (a protocol error where a decision was asked for), never an allow, never
// silence. An unrouted method+id frame still answers, so no provider turn hangs on a
// method this pin never saw.

describe("Codex routed server requests", () => {
  it("answers an allowed `item/tool/call` with the provider's own success shape", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: { contentItems: [{ type: "inputText", text: "ok" }] },
        }),
    });
    // A callback-tool ask is attributed by its own `turnId` and refused when that cannot be
    // resolved, so the allow arm needs a live routed turn.
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: runConfig("search the workspace"),
    });

    const answer = await askProvider("item/tool/call", {
      toolName: "search",
      arguments: {},
      turnId: TURN_ID,
    });

    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });

  it("REFUSES rather than truncates an answer larger than the service says it takes", async () => {
    // Codex closes its socket on a message past the limit it names, so an answer that would not
    // fit, in encoded bytes, is refused. A truncated tool output looks complete to the model; a
    // refusal is one it can act on.
    const namedLimit = 4096;
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: {
            contentItems: [{ type: "inputText", text: "x".repeat(namedLimit + 1) }],
          },
        }),
    });
    harness.server.sentMessageByteLimit = namedLimit;
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: runConfig("search the workspace"),
    });

    const answer = await askProvider("item/tool/call", {
      toolName: "search",
      arguments: {},
      turnId: TURN_ID,
    });

    // The provider still gets a well-formed answer in the method's refusal shape; silence would
    // hang the turn.
    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({
      success: false,
      contentItems: [{ type: "inputText", text: CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON }],
    });
    const oversized = harness.diagnostics.filter(
      (diagnostic) => diagnostic.kind === "server-request-answer-oversized",
    );
    expect(oversized).toHaveLength(1);
    expect(oversized[0]).toMatchObject({
      kind: "server-request-answer-oversized",
      method: "item/tool/call",
      limit: namedLimit,
    });
  });

  it(
    "REFUSES an approval whose named turn is " +
      "unresolvable, never attributing it to another run",
    async () => {
      // A request that names a turn claims which run raised it. Falling back to the sole active run
      // would decide a retired turn's approval under a newer run; a decline is visible and
      // retryable.
      const { harness, askProvider, driverDiagnosticRecords } = await routedAskHarness(undefined);
      await harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: runConfig("search the workspace"),
      });

      const answer = await askProvider("item/commandExecution/requestApproval", {
        turnId: "turn-that-already-retired",
      });

      // The method's own refusal vocabulary, not a protocol error.
      expect(answer["result"]).toStrictEqual({ decision: "decline" });
      // Refused before it was asked.
      expect(deliveriesOf(harness, "permission_ask")).toStrictEqual([]);
      expect(
        harness.diagnostics.filter(
          (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
        ),
      ).toStrictEqual([
        {
          kind: "routed-ask-turn-unresolved",
          method: "item/commandExecution/requestApproval",
          turnId: "turn-that-already-retired",
          turnIdTruncated: false,
          disposition: "refused",
        },
      ]);
      // `callback_tool_invocation_refused` counts callback-tool refusals only; an approval refusal
      // must not reach it.
      expect(driverDiagnosticRecords).toStrictEqual([]);
    },
  );

  it("REFUSES an approval whose named turn is past the reader's bound", async () => {
    // A turn id past the bound is named but unresolvable; resolving a truncated prefix could match
    // the wrong run.
    const { harness, askProvider } = await routedAskHarness(undefined);
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: runConfig("search the workspace"),
    });

    const answer = await askProvider("item/commandExecution/requestApproval", {
      turnId: "t".repeat(4096),
    });

    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    expect(deliveriesOf(harness, "permission_ask")).toStrictEqual([]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([
      {
        kind: "routed-ask-turn-unresolved",
        method: "item/commandExecution/requestApproval",
        turnId: "t".repeat(256),
        turnIdTruncated: true,
        disposition: "refused",
      },
    ]);
  });

  it("holds an approval for its card on its run and answers it through the driver", async () => {
    // Control for the refusals above. A legacy approval names no turn, so the sole live run is its
    // attribution; a modern one is attributed by the turn it names.
    const { harness } = await routedAskHarness(undefined);
    const taken: ProviderPermissionAsk[] = [];
    harness.ports.permissionAsks.register({
      takeAsk: async (ask) => {
        taken.push(ask);
      },
      withdrawAsk: async () => undefined,
    });
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: runConfig("search the workspace"),
    });

    const named = harness.server.askProvider("item/commandExecution/requestApproval", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      reason: "run the tests",
    });
    const legacy = harness.server.askProvider("execCommandApproval", {
      conversationId: THREAD_ID,
      callId: "call-9",
    });
    // Held, not answered: the card answers.
    await expect(named).rejects.toThrow("never answered");
    await expect(legacy).rejects.toThrow("never answered");
    await drainMicrotasks();

    expect(deliveriesOf(harness, "permission_ask").map((ask) => ask.bindingId)).toStrictEqual([
      "binding-abc",
      "binding-abc",
    ]);
    expect(taken.map((ask) => [ask.runId, ask.toolName, ask.prompt])).toStrictEqual([
      [RUN_ID, "commandExecution", "run the tests"],
      [RUN_ID, "commandExecution", undefined],
    ]);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved"),
    ).toStrictEqual([]);

    for (const ask of taken) {
      await harness.driver.respondToRequest({
        runId: RUN_ID,
        requestId: ask.requestId,
        response: { decision: "allow" },
      });
    }
    const answers = harness.server
      .writtenFrames()
      .filter((frame) => taken.some((ask) => String(frame["id"]) === ask.requestId));
    expect(answers.map((frame) => frame["result"])).toStrictEqual([
      { decision: "accept" },
      { decision: "approved" },
    ]);
  });

  it("asks a helper's approval on the helper's child run, never declining it", async () => {
    // A helper's thread belongs to the session, but its turn is none of the lead's turns.
    const { harness } = await routedAskHarness(undefined);
    const taken: ProviderPermissionAsk[] = [];
    harness.ports.permissionAsks.register({
      takeAsk: async (ask) => {
        taken.push(ask);
      },
      withdrawAsk: async () => undefined,
    });
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("delegate") });
    announceChildThread(harness, "subAgent");
    await drainMicrotasks();

    const asked = harness.server.askProvider("item/commandExecution/requestApproval", {
      threadId: CHILD_THREAD_ID,
      turnId: "turn-of-the-helper",
      reason: "run the helper's tests",
    });
    await expect(asked).rejects.toThrow("never answered");
    await drainMicrotasks();

    expect(deliveriesOf(harness, "permission_ask").map((ask) => ask.bindingId)).toStrictEqual([
      "binding-abc",
    ]);
    expect(taken.map((ask) => ask.runId)).toStrictEqual([childRunId(1)]);
  });

  it("keeps an admitted approval pending while no approvals owner is registered", async () => {
    // Answering it in the owner's place would decide what only the person may.
    const { harness } = await routedAskHarness(undefined);
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("search") });

    const asked = harness.server.askProvider("item/commandExecution/requestApproval", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    await expect(asked).rejects.toThrow("never answered");
    expect(deliveriesOf(harness, "permission_ask")).toHaveLength(1);
  });

  it("withdraws a held question's card when Codex settles it or its turn ends", async () => {
    // A card left open after Codex stopped waiting takes an answer nothing can deliver.
    const { harness } = await routedAskHarness(undefined);
    const taken: string[] = [];
    const withdrawn: string[] = [];
    harness.ports.questions.register({
      takeQuestion: async (question) => {
        taken.push(question.requestId);
      },
      withdrawQuestion: async (withdrawal) => {
        withdrawn.push(withdrawal.requestId);
      },
    });
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("ask me") });
    const question = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "item-1",
      questions: [
        {
          id: "q1",
          header: "Pick",
          question: "Which one?",
          isOther: false,
          isSecret: false,
          options: [{ label: "A", description: "the first" }],
        },
      ],
    };
    for (let held = 0; held < 2; held += 1) {
      await expect(
        harness.server.askProvider("item/tool/requestUserInput", question),
      ).rejects.toThrow("never answered");
    }
    await drainMicrotasks();
    const [settledId = "", endedId = ""] = taken;

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: { threadId: THREAD_ID, requestId: Number(settledId) },
    });
    await drainMicrotasks();
    expect(withdrawn).toStrictEqual([settledId]);

    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "completed"));
    await drainMicrotasks();
    expect(withdrawn).toStrictEqual([settledId, endedId]);
    // Codex holds neither any more, so neither takes an answer.
    await expect(
      harness.driver.respondToRequest({
        runId: RUN_ID,
        requestId: endedId,
        response: { answers: [{ kind: "picked", labels: ["A"] }] },
      }),
    ).rejects.toThrow("No Codex service holds");
  });

  it("refuses each approval spelling in that method's own vocabulary, never `-32601`", async () => {
    // Each method has its own refusal shape (from the pinned response types); one shape shared
    // across methods would violate the protocol on the others. No run is live, so none is asked.
    const { askProvider } = await routedAskHarness(undefined);

    const answer = await askProvider("item/commandExecution/requestApproval");

    // `-32601` would be a protocol error where a decision was asked for.
    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({ decision: "decline" });

    expect((await askProvider("execCommandApproval"))["result"]).toMatchObject({
      decision: { denied: { rejection: expect.stringContaining("belongs to no run") } },
    });
    expect((await askProvider("item/permissions/requestApproval"))["result"]).toStrictEqual({
      permissions: {},
      scope: "turn",
    });
    expect((await askProvider("mcpServer/elicitation/request"))["result"]).toStrictEqual({
      action: "decline",
    });
  });

  it("refuses a tool call when NO callback-tool host is registered", async () => {
    const { harness, askProvider } = await routedAskHarness(undefined);
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("search") });

    const answer = await askProvider("item/tool/call", { turnId: TURN_ID });

    expect(answer["result"]).toStrictEqual({
      success: false,
      contentItems: [
        { type: "inputText", text: 'The daemon has no callback-tool host for "item/tool/call".' },
      ],
    });
  });

  it("treats a THROWING responder as undecided, which is a refusal", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> => {
        await Promise.resolve();
        throw new Error("the callback-tool host is down");
      },
    });
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("search") });

    const answer = await askProvider("item/tool/call", { turnId: TURN_ID });

    // A throwing responder is never an allow and never leaves the ask unanswered.
    expect((answer["result"] as Record<string, unknown>)["success"]).toBe(false);
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "server-request-responder-failed",
      ),
    ).toHaveLength(1);
  });

  it("records a rejected answer write rather than swallowing it", async () => {
    const { harness, askProvider } = await routedAskHarness(undefined);
    harness.server.rejectNextSendWith = new Error("socket write failed: broken pipe");

    // The ask is never answered on the wire, and nothing else records that it will go unanswered.
    await expect(askProvider("item/commandExecution/requestApproval")).rejects.toThrow(
      "never answered",
    );

    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "server-request-answer-write-failed",
      ),
    ).toStrictEqual([
      {
        kind: "server-request-answer-write-failed",
        method: "item/commandExecution/requestApproval",
        detail: "socket write failed: broken pipe",
      },
    ]);
  });
});
