// Routed server requests against a fake provider: every ask the provider raises is answered,
// in the method's own refusal shape when the daemon does not allow it.

import { describe, expect, it } from "vitest";

import { CODEX_MAX_LINE_LENGTH, type CodexServerRequestDecision } from "../index.js";
import { CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON } from "../server-requests.js";
import { RUN_ID, SESSION_ID, TURN_ID, routedAskHarness } from "./codex-test-doubles.js";

// --------------------------------------------------------------------------
// Routed server requests reach the daemon, and every path answers.
// --------------------------------------------------------------------------
//
// A responder that is absent, refuses or throws answers the method's own refusal shape:
// never `-32601` (a protocol error where a decision was asked for), never an allow, never
// silence. An unrouted method+id frame still answers, so no provider turn hangs on a
// method this pin never saw.

describe("CodexAppServerConnection routed server requests", () => {
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
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
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

  it("REFUSES rather than truncates an answer larger than the outbound bound", async () => {
    // `CODEX_MAX_LINE_LENGTH` also bounds a composed answer, in encoded bytes. A truncated tool
    // output looks complete to the model; a refusal is one it can act on.
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({
          decision: "allow",
          payload: {
            contentItems: [{ type: "inputText", text: "x".repeat(CODEX_MAX_LINE_LENGTH + 1) }],
          },
        }),
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
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
      limit: CODEX_MAX_LINE_LENGTH,
    });
  }, 30_000);

  it(
    "REFUSES an approval whose named turn is " +
      "unresolvable, never attributing it to another run",
    async () => {
      // A request that names a turn claims which run raised it. Falling back to the sole active run
      // would decide a retired turn's approval under a newer run; a decline is visible and
      // retryable.
      const attributedRuns: Array<string | null> = [];
      const { harness, askProvider, driverDiagnosticRecords } = await routedAskHarness({
        answer: async (request): Promise<CodexServerRequestDecision> => {
          attributedRuns.push(request.runId);
          return await Promise.resolve({ decision: "allow" });
        },
      });
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
      });

      const answer = await askProvider("item/commandExecution/requestApproval", {
        turnId: "turn-that-already-retired",
      });

      // The method's own refusal vocabulary, not a protocol error.
      expect(answer["result"]).toStrictEqual({ decision: "decline" });
      // Refused before the responder ran.
      expect(attributedRuns).toStrictEqual([]);
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
    const attributedRuns: Array<string | null> = [];
    const { harness, askProvider } = await routedAskHarness({
      answer: async (request): Promise<CodexServerRequestDecision> => {
        attributedRuns.push(request.runId);
        return await Promise.resolve({ decision: "allow" });
      },
    });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await harness.driver.startRun({
      runId: RUN_ID,
      agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
    });

    const answer = await askProvider("item/commandExecution/requestApproval", {
      turnId: "t".repeat(4096),
    });

    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    expect(attributedRuns).toStrictEqual([]);
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

  it(
    "still attributes an approval whose named turn " +
      "IS live — the eligible shape stays eligible",
    async () => {
      // Control for the refusals above: an approval naming its live turn reaches the responder
      // stamped with that turn's run.
      const attributedRuns: Array<string | null> = [];
      const { harness, askProvider } = await routedAskHarness({
        answer: async (request): Promise<CodexServerRequestDecision> => {
          attributedRuns.push(request.runId);
          return await Promise.resolve({ decision: "allow" });
        },
      });
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await harness.driver.startRun({
        runId: RUN_ID,
        agentConfig: { sessionId: SESSION_ID, input: "search the workspace" },
      });

      const answer = await askProvider("item/commandExecution/requestApproval", {
        turnId: TURN_ID,
      });

      expect(answer["result"]).toStrictEqual({ decision: "accept" });
      expect(attributedRuns).toStrictEqual([RUN_ID]);
      expect(
        harness.diagnostics.filter(
          (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
        ),
      ).toStrictEqual([]);
    },
  );

  it(
    "records nothing and still ATTRIBUTES a legacy " + "approval that publishes no turn id at all",
    async () => {
      // `ExecCommandApprovalParams` has no `turnId` member, so the ask claims no turn: the
      // sole-active fallback is its attribution and nothing is recorded.
      const { harness, askProvider } = await routedAskHarness({
        answer: async (): Promise<CodexServerRequestDecision> =>
          await Promise.resolve({ decision: "allow" }),
      });

      const answer = await askProvider("execCommandApproval", { callId: "call-9" });

      expect(answer["result"]).toStrictEqual({ decision: "approved" });
      expect(
        harness.diagnostics.filter(
          (diagnostic) => diagnostic.kind === "routed-ask-turn-unresolved",
        ),
      ).toStrictEqual([]);
    },
  );

  it("refuses each approval spelling in that method's own vocabulary, never `-32601`", async () => {
    // Each method has its own refusal shape (from the pinned response types); one shape shared
    // across methods would violate the protocol on the others.
    const { askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "refuse", reason: "policy denied" }),
    });

    const answer = await askProvider("item/commandExecution/requestApproval");

    // `-32601` would be a protocol error where a decision was asked for.
    expect(answer["error"]).toBeUndefined();
    expect(answer["result"]).toStrictEqual({ decision: "decline" });

    expect((await askProvider("execCommandApproval"))["result"]).toStrictEqual({
      decision: { denied: { rejection: "policy denied" } },
    });
    expect((await askProvider("item/permissions/requestApproval"))["result"]).toStrictEqual({
      permissions: {},
      scope: "turn",
    });
    expect((await askProvider("mcpServer/elicitation/request"))["result"]).toStrictEqual({
      action: "decline",
    });
  });

  it("refuses when NO responder is registered rather than leaving the ask unanswered", async () => {
    const { harness, askProvider } = await routedAskHarness(undefined);

    const answer = await askProvider("item/tool/call");

    expect((answer["result"] as Record<string, unknown>)["success"]).toBe(false);
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "unrouted-server-request-refused",
      ),
    ).toHaveLength(1);
  });

  it("treats a THROWING responder as undecided, which is a refusal", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> => {
        await Promise.resolve();
        throw new Error("the approval pipeline is down");
      },
    });

    const answer = await askProvider("item/fileChange/requestApproval");

    // A throwing responder is never an allow and never leaves the ask unanswered.
    expect(answer["result"]).toStrictEqual({ decision: "decline" });
    expect(
      harness.diagnostics.filter(
        (diagnostic) => diagnostic.kind === "server-request-responder-failed",
      ),
    ).toHaveLength(1);
  });

  it("records a rejected answer write rather than swallowing it", async () => {
    const { harness, askProvider } = await routedAskHarness({
      answer: async (): Promise<CodexServerRequestDecision> =>
        await Promise.resolve({ decision: "refuse", reason: "policy denied" }),
    });
    harness.server.rejectNextWriteWith = new Error("pty write failed: broken pipe");

    // The ask is never answered on the wire. The exit path records that a process died, not that
    // this one ask will go unanswered.
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
        detail: "pty write failed: broken pipe",
      },
    ]);
  });
});
