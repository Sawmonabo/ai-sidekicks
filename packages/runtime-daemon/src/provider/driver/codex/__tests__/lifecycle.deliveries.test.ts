// What a live Codex turn's frames become for the run engine: an interrupt's end is the run
// engine's to write, the reviewer's warnings land on the reviews or the stopped turn they belong
// to, a helper's on its child run, a model switch carries its sentence, a retry never resends a
// reply already under way, the reply and the plan stream as pieces of their message, the plan
// ending as its record, and a running command's output reaches the running-commands stream as it
// prints.

import { describe, expect, it, vi } from "vitest";

import { drainMicrotasks } from "../../../__fixtures__/drain-microtasks.js";
import type { CommandOutputPublisher } from "../../../port/command-output-publisher.js";
import type { ProviderReviewerDenial } from "../../../port/reviewer-denial.js";
import {
  AGENT_ID,
  announceChildThread,
  CHILD_THREAD_ID,
  childRunId,
  createdSession,
  createHarness,
  deliveriesOf,
  type Harness,
  type HarnessOptions,
  RUN_ID,
  runConfig,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  turnCompletedFrame,
} from "../__fixtures__/app-server-doubles.js";

/** A session with the test run's turn live. */
async function liveRun(options: HarnessOptions = {}): Promise<Harness> {
  const harness = createHarness(options);
  await createdSession(harness);
  harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
  await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
  return harness;
}

/** Sends one notification on the live turn of the session's thread. */
function emitOnTurn(harness: Harness, method: string, params: Record<string, unknown>): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  });
}

describe("Codex turn deliveries", () => {
  it("never delivers an interrupt's confirming frame as a second terminal", async () => {
    const harness = await liveRun();
    harness.server.on("turn/interrupt", () => ({ result: {} }));

    await harness.driver.interruptRun({ runId: RUN_ID });
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, "interrupted"));
    await drainMicrotasks();

    // The run engine writes the interrupt's end; a second terminal would end the run twice.
    expect(deliveriesOf(harness, "run_lifecycle")).toStrictEqual([]);
  });

  it("flags a warning on a review that asks the person or the turn it stops, never on an approval or a block", async () => {
    const turnEventId = "turn-started-event";
    const toolCallEventId = "tool-call-event";
    const harness = await liveRun({
      answerDelivery: (delivery) => {
        if (delivery.kind === "run_marker") {
          return { disposition: "appended", eventId: turnEventId };
        }
        return delivery.kind === "session_row" && delivery.row.type === "tool.invoked"
          ? { disposition: "appended", eventId: toolCallEventId }
          : undefined;
      },
    });
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID } },
    });
    // A required review names no item, so its flag is about the turn.
    emitOnTurn(harness, "autoApprovalReview/strictReviewRequired", { startedAtMs: 1 });
    const denials: ProviderReviewerDenial[] = [];
    harness.ports.reviewerDenials.register({
      takeDenial: async (denial) => {
        denials.push(denial);
      },
    });
    const review = (reviewId: string, status: string): Record<string, unknown> => ({
      reviewId,
      targetItemId: `call-${reviewId}`,
      review: { status, rationale: `rationale ${reviewId}` },
    });

    emitOnTurn(harness, "guardianWarning", { message: "about an approval" });
    emitOnTurn(harness, "item/autoApprovalReview/completed", review("1", "approved"));
    // A block's words are on its own row, so its warning draws none.
    emitOnTurn(harness, "guardianWarning", { message: "about the block" });
    emitOnTurn(harness, "item/autoApprovalReview/completed", review("2", "denied"));
    emitOnTurn(harness, "item/autoApprovalReview/completed", review("3", "timedOut"));
    // A review that falls back to the person is flagged on the tool call it reviewed.
    emitOnTurn(harness, "item/started", {
      item: { type: "commandExecution", id: "call-4", command: "pnpm test", status: "inProgress" },
    });
    emitOnTurn(harness, "guardianWarning", { message: "about a review that asks the person" });
    emitOnTurn(harness, "item/autoApprovalReview/completed", review("4", "aborted"));
    // Codex's reviewer stops the turn with a warning no review follows, carrying its arm only in
    // strict mode and sending no error frame either way.
    const stopWarning =
      "Automatic approval review rejected too many approval requests for this turn.";
    emitOnTurn(harness, "guardianWarning", { message: stopWarning });
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: THREAD_ID,
        turn: {
          id: TURN_ID,
          status: "interrupted",
          items: [],
          error: {
            message: stopWarning,
            codexErrorInfo: "tooManyDenials",
            additionalDetails: null,
            misalignment: null,
          },
        },
      },
    });
    await drainMicrotasks();

    // Each flag is written once the event it points at is, so their order follows those writes.
    const flags = deliveriesOf(harness, "unstamped_row").map((delivery) => delivery.row);
    expect(flags).toHaveLength(3);
    expect(flags).toStrictEqual(
      expect.arrayContaining([
        {
          type: "moderation.review_flagged",
          payload: {
            sessionId: SESSION_ID,
            runId: RUN_ID,
            agentId: AGENT_ID,
            eventId: toolCallEventId,
            signal: "review_warning",
            text: "about a review that asks the person",
          },
        },
        {
          type: "moderation.review_flagged",
          payload: {
            sessionId: SESSION_ID,
            runId: RUN_ID,
            agentId: AGENT_ID,
            eventId: turnEventId,
            signal: "review_required",
            text: "This request requires additional safety checks, some tool calls might take extra time",
          },
        },
        {
          type: "moderation.review_flagged",
          payload: {
            sessionId: SESSION_ID,
            runId: RUN_ID,
            agentId: AGENT_ID,
            eventId: turnEventId,
            signal: "review_warning",
            text: stopWarning,
          },
        },
      ]),
    );
    // A stop is no failure: the run ends interrupted, with no failure category.
    expect(deliveriesOf(harness, "run_lifecycle").map((delivery) => delivery.change)).toStrictEqual(
      [{ runId: RUN_ID, newState: "interrupted" }],
    );
    // Only a denied block is the person's to overrule.
    expect(denials.map((denial) => [denial.toolCallId, denial.overridable])).toStrictEqual([
      ["call-2", true],
      ["call-3", false],
    ]);
  });

  it.each([
    { label: "ends completed", stopByDaemon: false, status: "completed" },
    { label: "is interrupted by the daemon", stopByDaemon: true, status: "interrupted" },
  ])("flags no waiting warning when the turn $label", async ({ stopByDaemon, status }) => {
    const harness = await liveRun({
      answerDelivery: (delivery) =>
        delivery.kind === "run_marker"
          ? { disposition: "appended", eventId: "turn-event" }
          : undefined,
    });
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID } },
    });
    emitOnTurn(harness, "guardianWarning", { message: "a warning no review answered" });
    if (stopByDaemon) {
      harness.server.on("turn/interrupt", () => ({ result: {} }));
      await harness.driver.interruptRun({ runId: RUN_ID });
    }
    harness.server.emitFrame(turnCompletedFrame(TURN_ID, status));
    await drainMicrotasks();

    expect(deliveriesOf(harness, "unstamped_row")).toStrictEqual([]);
  });

  it("reports a review's end no run holds rather than dropping its block", async () => {
    const harness = await liveRun();

    emitOnTurn(harness, "item/autoApprovalReview/completed", {
      turnId: "turn-of-no-run",
      targetItemId: "call-1",
      review: { status: "denied", rationale: "blocked" },
    });
    await drainMicrotasks();

    expect(harness.diagnostics).toContainEqual({
      kind: "unattributed-turn-frame",
      method: "item/autoApprovalReview/completed",
      turnId: "turn-of-no-run",
    });
  });

  it("reports a warning on a helper no run could own, holding nothing for it", async () => {
    // With no live run the helper has no parent to start beneath, so it has no child run.
    const harness = createHarness();
    await createdSession(harness);
    announceChildThread(harness, "subAgent");

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "guardianWarning",
      params: { threadId: CHILD_THREAD_ID, turnId: "helper-turn", message: "a warning" },
    });
    await drainMicrotasks();

    expect(harness.diagnostics).toContainEqual({
      kind: "unattributed-turn-frame",
      method: "guardianWarning",
      turnId: "helper-turn",
    });
  });

  it("flags a helper's reviewer warnings on its child run and hands its blocks over", async () => {
    const startRowEventId = "helper-started-event";
    const toolCallEventId = "helper-tool-call-event";
    const harness = await liveRun({
      answerDelivery: (delivery) => {
        if (delivery.kind !== "session_row") {
          return undefined;
        }
        if (delivery.row.type === "subagent.started") {
          return { disposition: "appended", eventId: startRowEventId };
        }
        return delivery.row.type === "tool.invoked"
          ? { disposition: "appended", eventId: toolCallEventId }
          : undefined;
      },
    });
    const denials: ProviderReviewerDenial[] = [];
    harness.ports.reviewerDenials.register({
      takeDenial: async (denial) => {
        denials.push(denial);
      },
    });
    announceChildThread(harness, "subAgent");
    const emitOnHelper = (method: string, params: Record<string, unknown>): void => {
      harness.server.emitFrame({
        jsonrpc: "2.0",
        method,
        params: { threadId: CHILD_THREAD_ID, turnId: "helper-turn", ...params },
      });
    };
    emitOnHelper("item/started", {
      item: {
        type: "commandExecution",
        id: "helper-call",
        command: "rm -rf build",
        status: "inProgress",
      },
    });
    emitOnHelper("item/autoApprovalReview/completed", {
      reviewId: "helper-review",
      targetItemId: "helper-call",
      review: { status: "denied", rationale: "deletes the build" },
    });
    emitOnHelper("autoApprovalReview/strictReviewRequired", { startedAtMs: 1 });
    const stopWarning =
      "Automatic approval review rejected too many approval requests for this turn.";
    emitOnHelper("guardianWarning", { message: stopWarning });
    harness.server.emitFrame(turnCompletedFrame("helper-turn", "interrupted", CHILD_THREAD_ID));
    await drainMicrotasks();

    // A helper's turns write no start of their own, so its turn-wide flags are about its start row.
    const flag = (signal: string, text: string): Record<string, unknown> => ({
      type: "moderation.review_flagged",
      payload: {
        sessionId: SESSION_ID,
        runId: childRunId(1),
        agentId: AGENT_ID,
        eventId: startRowEventId,
        signal,
        text,
      },
    });
    expect(deliveriesOf(harness, "unstamped_row").map((delivery) => delivery.row)).toStrictEqual([
      flag(
        "review_required",
        "This request requires additional safety checks, some tool calls might take extra time",
      ),
      flag("review_warning", stopWarning),
    ]);
    expect(denials.map((denial) => [denial.runId, denial.toolCallId])).toStrictEqual([
      [childRunId(1), "helper-call"],
    ]);
  });

  it("gives a model switch its sentence, never a provider warning of its own", async () => {
    const harness = await liveRun();

    emitOnTurn(harness, "model/rerouted", {
      fromModel: "gpt-5.5",
      toModel: "gpt-5.5-mini",
      reason: "highRiskCyberActivity",
    });
    emitOnTurn(harness, "warning", { message: "This turn moved to a safer model." });
    await drainMicrotasks();

    expect(deliveriesOf(harness, "session_row").map((delivery) => delivery.row)).toStrictEqual([
      {
        type: "usage.model_rerouted",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          fromModel: "gpt-5.5",
          toModel: "gpt-5.5-mini",
          scope: "turn",
          cause: "safety",
          safetyCategory: "cyber",
          sentence: "This turn moved to a safer model.",
        },
      },
    ]);
    const warnings = deliveriesOf(harness, "session_notice").filter(
      (delivery) => delivery.notice.kind === "provider_warning",
    );
    expect(warnings).toStrictEqual([]);
  });

  it("refuses a faster-model retry once the turn's reply has started", async () => {
    const harness = await liveRun();
    emitOnTurn(harness, "item/started", { item: { type: "agentMessage", id: "message-1" } });
    await drainMicrotasks();

    await expect(
      harness.driver.retryTurnOnFasterModel({
        sessionId: SESSION_ID,
        runId: RUN_ID,
        expectedTurnId: TURN_ID,
        model: "gpt-5.5-mini",
      }),
    ).resolves.toStrictEqual({
      state: "rejected",
      rejectionReason: "The turn's reply has started.",
    });
    // Sending the message again would repeat a reply the person already reads.
    expect(harness.server.framesForMethod("turn/interrupt")).toStrictEqual([]);
    expect(harness.server.framesForMethod("thread/fork")).toStrictEqual([]);
  });

  it("streams the reply and the plan as pieces before their items end, and records the plan", async () => {
    const harness = await liveRun();
    const piecesOf = (itemId: string): string[] =>
      deliveriesOf(harness, "session_row").flatMap((delivery) =>
        delivery.row.type === "assistant.message" &&
        delivery.row.payload.providerMessageId === itemId
          ? [delivery.content?.body ?? ""]
          : [],
      );
    const planText = "# Add the flag\n\n1. Edit `src/flags.ts`\n2. Test `src/flags.test.ts`\n";

    emitOnTurn(harness, "item/started", {
      item: { type: "agentMessage", id: "reply-1", text: "" },
    });
    emitOnTurn(harness, "item/agentMessage/delta", { itemId: "reply-1", delta: "Here is " });
    emitOnTurn(harness, "item/agentMessage/delta", { itemId: "reply-1", delta: "the plan" });
    emitOnTurn(harness, "item/plan/delta", { itemId: `${TURN_ID}-plan`, delta: planText });
    // Each piece reaches the event log while its item is still being written.
    await vi.waitFor(() => {
      expect(piecesOf("reply-1").join("")).toBe("Here is the plan");
      expect(piecesOf(`${TURN_ID}-plan`).join("")).toBe(planText);
    });
    expect(deliveriesOf(harness, "unstamped_row")).toStrictEqual([]);

    emitOnTurn(harness, "item/completed", {
      item: { type: "agentMessage", id: "reply-1", text: "Here is the plan." },
    });
    emitOnTurn(harness, "item/completed", {
      item: { type: "plan", id: `${TURN_ID}-plan`, text: planText },
    });
    await drainMicrotasks();

    // Joined in order, a message's pieces are its final text, nothing written twice.
    expect(piecesOf("reply-1").join("")).toBe("Here is the plan.");
    expect(piecesOf(`${TURN_ID}-plan`).join("")).toBe(planText);
    expect(deliveriesOf(harness, "unstamped_row").map((delivery) => delivery.row)).toMatchObject([
      {
        type: "plan.proposed",
        payload: {
          runId: RUN_ID,
          title: "Add the flag",
          text: planText,
          stepCount: 2,
          fileCount: 2,
        },
      },
    ]);
  });

  it("streams a running command's output as it prints, before its item ends", async () => {
    const harness = await liveRun();
    const published: Parameters<CommandOutputPublisher["publish"]>[0][] = [];
    harness.ports.commandOutput.register({ publish: (frame) => published.push(frame) });

    emitOnTurn(harness, "item/started", {
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "pnpm test",
        status: "inProgress",
      },
    });
    emitOnTurn(harness, "item/commandExecution/outputDelta", {
      itemId: "command-1",
      delta: "ok 1\n",
    });
    emitOnTurn(harness, "item/commandExecution/outputDelta", {
      itemId: "command-1",
      delta: "ok 2\n",
    });
    await drainMicrotasks();

    expect(published).toStrictEqual([
      { kind: "output", sessionId: SESSION_ID, commandId: "command-1", data: "ok 1\n" },
      { kind: "output", sessionId: SESSION_ID, commandId: "command-1", data: "ok 2\n" },
    ]);
  });
});
