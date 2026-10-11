// A turn Codex starts by itself: its run opens once, a failed open lets the turn's frames go on
// without trying again and ends the turn, which a start waits for, even one already past its
// checks, and an ask raised while the run opens waits for it rather than being refused.

import { describe, expect, it } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";

import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import { STAGED_ATTACHMENT_IDS } from "../../../__fixtures__/attachment-doubles.js";
import type { ProviderAttachment } from "../../../attachments.js";
import { CODEX_THREAD_FRAME_ROUTER_CONFIG } from "../../session/state.js";
import {
  AGENT_ID,
  createHarness,
  createdSession,
  deliveriesOf,
  forkedThreadId,
  type Harness,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SESSION_ID,
  THREAD_ID,
  TURN_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";

const GOAL_TURN_ID = "turn-goal";
// Apart from every other deadline the harness arms, so a test fires the turn start's alone.
const START_DEADLINE_MS = 5_000;

function emitGoalTurnStarted(harness: Harness): void {
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: THREAD_ID, turn: { id: GOAL_TURN_ID, status: "inProgress" } },
  });
}

describe("a turn Codex started by itself", () => {
  // Mutations: trying again from the released `turn/started` writes a queued and a failed run
  // forever; leaving out the interrupt leaves the turn running with no run; sending a start, or a
  // goal, before the turn's end folds it into that turn, and refusing the goal fails the person's
  // goal for the daemon's own stop.
  it("tries its run once when the open fails, ends the turn, and starts the next after it", async () => {
    // A second open never settles, so a try again shows as a second run, not as a loop.
    let openCount = 0;
    const harness = createHarness({
      turnStartTimeoutMs: START_DEADLINE_MS,
      openDaemonTurnBinding: async () => {
        openCount += 1;
        if (openCount > 1) {
          return await new Promise<never>(() => undefined);
        }
        throw new Error("the run queue is not registered");
      },
    });
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    harness.server.on("thread/goal/set", () => ({ result: {} }));
    await createdSession(harness);

    emitGoalTurnStarted(harness);
    await drainMicrotasks();

    expect(harness.daemonTurnRunIds).toHaveLength(1);
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "provider-turn-run-failed"),
    ).toHaveLength(1);
    expect(
      harness.server.framesForMethod("turn/interrupt").map((frame) => frame["params"]),
    ).toEqual([{ threadId: THREAD_ID, turnId: GOAL_TURN_ID }]);

    const started = harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    const goal = harness.driver.setSessionGoal({
      sessionId: SESSION_ID,
      bindingId: "binding-abc",
      runId: RUN_ID,
      goalText: "ship the fix",
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
    expect(harness.server.framesForMethod("thread/goal/set")).toHaveLength(0);
    harness.server.emitFrame(turnCompletedFrame(GOAL_TURN_ID, "interrupted"));
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/goal/set")).toHaveLength(1);
    // Codex started no turn for the goal this time, so the start goes once the wait's bound passes.
    harness.scheduler.fireDelay(START_DEADLINE_MS);
    await started;
    await expect(goal).resolves.toStrictEqual({ status: "applied" });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  // Mutation: taking a turn whose end already went by as one no run holds leaves it in flight for
  // good, so it is interrupted and every later start waits on an end that never comes.
  it("lets a turn whose end came before its run failed to open go, and starts the next at once", async () => {
    const opening = Promise.withResolvers<{ bindingId: string; agentId: AgentId }>();
    const harness = createHarness({ openDaemonTurnBinding: async () => await opening.promise });
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await createdSession(harness);
    emitGoalTurnStarted(harness);
    // The hold fills and lets the turn's frames go on, its end last, while the run still opens.
    for (let frame = 2; frame < CODEX_THREAD_FRAME_ROUTER_CONFIG.maxPendingHoldFrames; frame += 1) {
      emitGoalTurnStarted(harness);
    }
    harness.server.emitFrame(turnCompletedFrame(GOAL_TURN_ID, "completed"));
    await drainMicrotasks();

    opening.reject(new Error("the run queue is not registered"));
    await drainMicrotasks();

    expect(harness.server.framesForMethod("turn/interrupt")).toStrictEqual([]);
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  // Mutations: sending the start's `turn/start` without waiting out a turn Codex started while the
  // start bound its files folds it into that turn, whose run is either the provider's own or none;
  // refusing before that turn's run opened refuses before the run took over what the start would
  // send; moving the conversation for a change owed meanwhile before refusing waits out that
  // whole turn while every other send waits too.
  it.each([
    { doesOpen: false, isForkOwed: false },
    { doesOpen: true, isForkOwed: false },
    { doesOpen: true, isForkOwed: true },
  ])(
    "waits out a turn Codex started while a start bound its files, refusing it once its run opens (opens: $doesOpen, fork owed: $isForkOwed)",
    async ({ doesOpen, isForkOwed }) => {
      const filesBound = Promise.withResolvers<ProviderAttachment[]>();
      const runOpening = Promise.withResolvers<void>();
      const harness = createHarness({
        attachments: { resolveAttachments: async () => await filesBound.promise },
        openDaemonTurnBinding: async () => {
          await runOpening.promise;
          if (!doesOpen) {
            throw new Error("the run queue is not registered");
          }
          return { bindingId: "binding-goal", agentId: AGENT_ID as AgentId };
        },
      });
      harness.server.on("turn/interrupt", () => ({ result: {} }));
      harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
      await createdSession(harness);
      let isSettled = false;
      const started = harness.driver
        .startRun({
          runId: RUN_ID,
          agentConfig: { ...runConfig("go on"), attachments: [STAGED_ATTACHMENT_IDS.picture] },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          isSettled = true;
        });
      await drainMicrotasks();

      emitGoalTurnStarted(harness);
      await drainMicrotasks();
      filesBound.resolve([]);
      await drainMicrotasks();
      // A change that moves the conversation, owed while the start waits for that turn's run.
      if (isForkOwed) {
        await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
      }
      expect(isSettled).toBe(false);
      runOpening.resolve();
      await drainMicrotasks();

      expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
      if (doesOpen) {
        await expect(started).resolves.toMatchObject({
          fields: { reason: "session_turn_in_flight" },
        });
        expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);
      }
      harness.server.emitFrame(turnCompletedFrame(GOAL_TURN_ID, "interrupted"));
      await drainMicrotasks();
      if (doesOpen) {
        await harness.driver.startRun({ runId: SECOND_RUN_ID, agentConfig: runConfig("go on") });
      } else {
        await expect(started).resolves.toBeUndefined();
      }
      expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
    },
  );

  // Mutation: checking for a turn in flight before the daemon's turn binds the session's first run,
  // not after, sends the review into the turn Codex started meanwhile, whose run opened.
  it("refuses a turn the daemon starts once a turn Codex started opened its run meanwhile", async () => {
    const rebound = Promise.withResolvers<void>();
    const harness = createHarness({ rebindRuntimeBinding: async () => await rebound.promise });
    harness.server.on("review/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await createdSession(harness);
    // A fork before the session's first run leaves a conversation that run's binding records.
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();
    const review = harness.driver
      .startReview({ sessionId: SESSION_ID, target: "workingTree" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await drainMicrotasks();

    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: forkedThreadId(1), turn: { id: GOAL_TURN_ID, status: "inProgress" } },
    });
    await drainMicrotasks();
    rebound.resolve();

    await expect(review).resolves.toMatchObject({ fields: { reason: "session_turn_in_flight" } });
    expect(harness.server.framesForMethod("review/start")).toHaveLength(0);
    expect(harness.daemonTurnRunIds).toHaveLength(2);
  });

  // Mutation: interrupting a turn no run took though its run's failed start interrupted it already
  // sends Codex a second interrupt of the same turn.
  it("waits out a turn its run's failed start interrupted, interrupting it once", async () => {
    const harness = createHarness({
      runEngine: {
        // The run opens the turn, then its `running` write fails, as the run engine reports it.
        startDaemonTurn: async (request) => {
          const runId = SECOND_RUN_ID;
          await request.startTurn(runId);
          await request.interruptTurn(runId);
          throw new Error("database or disk is full");
        },
        endTurnOnProcessExit: () => Promise.resolve(),
        recordSettledOutputSpeed: () => Promise.resolve(),
      },
    });
    harness.server.on("turn/interrupt", () => ({ result: {} }));
    harness.server.on("turn/start", () => ({ result: { turn: { id: TURN_ID } } }));
    await createdSession(harness);
    emitGoalTurnStarted(harness);
    await drainMicrotasks();

    const started = harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go on") });
    await drainMicrotasks();
    expect(harness.server.paramsFor("turn/interrupt")).toStrictEqual([
      { threadId: THREAD_ID, turnId: GOAL_TURN_ID },
    ]);
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(0);

    harness.server.emitFrame(turnCompletedFrame(GOAL_TURN_ID, "interrupted"));
    await started;
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  it("holds an approval raised while the run opens, then asks it on that run", async () => {
    const opened = Promise.withResolvers<{ bindingId: string; agentId: AgentId }>();
    const harness = createHarness({ openDaemonTurnBinding: async () => await opened.promise });
    await createdSession(harness);
    emitGoalTurnStarted(harness);
    await drainMicrotasks();

    const asked = harness.server.askProvider("item/commandExecution/requestApproval", {
      threadId: THREAD_ID,
      turnId: GOAL_TURN_ID,
    });
    // Not refused while the turn has no route yet: the ask waits for the run.
    await expect(asked).rejects.toThrow("never answered");
    expect(deliveriesOf(harness, "permission_ask")).toStrictEqual([]);

    opened.resolve({ bindingId: "binding-goal", agentId: AGENT_ID as AgentId });
    await drainMicrotasks();

    expect(deliveriesOf(harness, "permission_ask").map((ask) => ask.bindingId)).toStrictEqual([
      "binding-goal",
    ]);
  });
});
