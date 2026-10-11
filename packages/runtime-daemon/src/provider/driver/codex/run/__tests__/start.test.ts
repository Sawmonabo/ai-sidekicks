// Starting a run on a Codex session: the run's binding becomes the session's, a start that fails
// gives it back only while no later start has taken it since, and while a turn the daemon stopped
// still ends no turn starts, within one deadline for the whole start, no turn the daemon starts is
// taken, no fork runs, and a goal and an `Allow once` wait for that end. A goal goes apart from
// the session's turn starts until the turn it starts begins, and an `Allow once` waits for a turn
// still starting to run.

import { describe, expect, it } from "vitest";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { SESSION_ALREADY_CLOSED_CODE } from "@ai-sidekicks/contracts/session/methods";

import { captureRejection } from "../../../../../__fixtures__/capture-failure.js";
import { drainMicrotasks } from "../../../../__fixtures__/drain-microtasks.js";
import { STAGED_ATTACHMENT_IDS } from "../../../__fixtures__/attachment-doubles.js";
import type { RuntimeBindingRebind } from "../../../../runtime-binding-store.js";
import {
  AGENT_ID,
  createHarness,
  createdSession,
  type Harness,
  type HarnessOptions,
  RUN_ID,
  runConfig,
  SECOND_RUN_ID,
  SESSION_ID,
  THREAD_ID,
  turnCompletedFrame,
} from "../../__fixtures__/app-server-doubles.js";

// Apart from every other deadline the harness arms, so a test fires the start's alone.
const START_DEADLINE_MS = 5_000;
const REQUEST_DEADLINE_MS = 60_000;
const GOAL_PARAMS = { sessionId: SESSION_ID, bindingId: "binding-abc", runId: RUN_ID };

// A live session whose `turn/start` answers name `turn-1`, `turn-2` and on, and whose interrupts
// Codex accepts.
async function stoppableSession(options: HarnessOptions = {}): Promise<Harness> {
  const harness = createHarness(options);
  let started = 0;
  harness.server.on("turn/start", () => {
    started += 1;
    return { result: { turn: { id: `turn-${started}` } } };
  });
  harness.server.on("turn/interrupt", () => ({ result: {} }));
  await createdSession(harness);
  return harness;
}

// Interrupts the run's turn `turn-1`, which Codex runs on until its end, and names it.
async function interruptFirstTurn(harness: Harness): Promise<string> {
  await harness.driver.interruptRun({ runId: RUN_ID });
  return "turn-1";
}

// With no daemon hook, a pause interrupts the run's turn at its next step's end.
async function pauseAtStepEnd(harness: Harness, turnId: string): Promise<void> {
  await harness.driver.pauseRun({ sessionId: SESSION_ID, runId: RUN_ID });
  harness.server.emitFrame({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: THREAD_ID, turnId, item: { type: "agentMessage", id: "item-1" } },
  });
  await drainMicrotasks();
}

describe("two starts on one binding", () => {
  it("keeps the binding the second start set when the first start fails after it", async () => {
    // Given back, the session would hold no binding, so its next fork would record nowhere and a
    // daemon restart would resume the conversation it left.
    const rebinds: RuntimeBindingRebind[] = [];
    const harness = createHarness({
      rebindRuntimeBinding: async (rebind) => {
        rebinds.push(rebind);
        await Promise.resolve();
      },
    });
    await createdSession(harness);
    let started = 0;
    harness.server.on("turn/start", () => {
      started += 1;
      return started === 1
        ? { error: { code: -32600, message: "turn refused" } }
        : { result: { turn: { id: `turn-${started}` } } };
    });
    const releaseStarts = harness.server.holdAnswers("turn/start");
    const refused = harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("first") });
    await drainMicrotasks();
    const second = harness.driver.startRun({
      runId: SECOND_RUN_ID,
      agentConfig: runConfig("second"),
    });
    await drainMicrotasks();

    releaseStarts();
    await expect(refused).rejects.toThrow("turn refused");
    await second;
    harness.server.emitFrame(turnCompletedFrame("turn-2", "completed"));
    await drainMicrotasks();
    // A level move forks the idle conversation onto the session's own binding.
    await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
    await drainMicrotasks();

    expect(rebinds.map((rebind) => rebind.bindingId)).toStrictEqual(["binding-abc"]);
  });
});

describe("a turn the daemon stopped, until Codex ends it", () => {
  // Mutations: leaving out the start's wait before the run's binding is recorded lets the
  // interrupted turn's end forget the continue's binding, so its turn's frames reach no run;
  // leaving out the waits sends a `turn/start` Codex folds into the turn still ending.
  it.each<[string, RunId]>([
    ["another run's start", SECOND_RUN_ID],
    ["the stopped run's own continue", RUN_ID],
  ])("holds %s until that turn's end, then starts it on its run", async (_case, runId) => {
    const harness = await stoppableSession();
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    const stoppedTurnId = await interruptFirstTurn(harness);
    const start = async (): Promise<void> => {
      await harness.driver.startRun({ runId, agentConfig: runConfig("next") });
    };

    const started = start();
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);

    harness.server.emitFrame(turnCompletedFrame(stoppedTurnId, "interrupted"));
    await started;
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
    harness.server.emitFrame(turnCompletedFrame("turn-2", "completed"));
    await drainMicrotasks();
    expect(
      harness.diagnostics.filter((diagnostic) => diagnostic.kind === "unattributed-turn-frame"),
    ).toStrictEqual([]);
  });

  // Mutations: leaving the stopped turns out of what counts as a turn in flight sends the review
  // into the ending turn and forks the conversation under it; leaving out a pause's interrupted
  // turn does so for the pause; letting go of that turn only after the fork's settle check leaves
  // the fork owed past the turn's end.
  it.each<[string, (harness: Harness) => Promise<unknown>]>([
    ["an interrupt", async (harness) => await interruptFirstTurn(harness)],
    ["a pause", async (harness) => await pauseAtStepEnd(harness, "turn-1")],
  ])(
    "refuses a turn the daemon starts and holds a fork while a turn %s stopped ends",
    async (_case, stop) => {
      const harness = await stoppableSession();
      await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
      await stop(harness);

      await expect(
        harness.driver.startReview({ sessionId: SESSION_ID, target: "workingTree" }),
      ).rejects.toMatchObject({ fields: { reason: "session_turn_in_flight" } });
      expect(harness.server.framesForMethod("review/start")).toHaveLength(0);
      await harness.driver.updatePermissionLevel({ sessionId: SESSION_ID, level: "yolo" });
      await drainMicrotasks();
      expect(harness.server.framesForMethod("thread/fork")).toHaveLength(0);

      harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));
      await drainMicrotasks();
      expect(harness.server.framesForMethod("thread/fork")).toHaveLength(1);
    },
  );

  // Mutations: refusing the goal while the stopped turn ends, as for a turn running, fails a goal
  // set right after an interrupt; sending a set or a clear at once records it in the turn still
  // ending; waiting with no deadline holds the goal for good when Codex never ends the turn.
  it.each<[string, (harness: Harness) => Promise<unknown>]>([
    [
      "thread/goal/set",
      async (harness) =>
        await harness.driver.setSessionGoal({ ...GOAL_PARAMS, goalText: "ship the fix" }),
    ],
    ["thread/goal/clear", async (harness) => await harness.driver.clearSessionGoal(GOAL_PARAMS)],
  ])(
    "sends %s once the turn an interrupt stopped ends, and refuses it past the deadline",
    async (method, changeGoal) => {
      const harness = await stoppableSession({ turnStartTimeoutMs: START_DEADLINE_MS });
      harness.server.on(method, () => ({ result: {} }));
      await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
      await interruptFirstTurn(harness);

      const changed = changeGoal(harness);
      await drainMicrotasks();
      expect(harness.server.framesForMethod(method)).toHaveLength(0);
      harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));
      await drainMicrotasks();
      // A set waits for the turn its goal starts, which Codex did not start here.
      harness.scheduler.fireDelay(START_DEADLINE_MS);
      await expect(changed).resolves.toStrictEqual({ status: "applied" });
      expect(harness.server.framesForMethod(method)).toHaveLength(1);

      await harness.driver.startRun({ runId: SECOND_RUN_ID, agentConfig: runConfig("next") });
      await harness.driver.interruptRun({ runId: SECOND_RUN_ID });
      const refused = captureRejection(changeGoal(harness));
      await drainMicrotasks();
      harness.scheduler.fireDelay(REQUEST_DEADLINE_MS);
      expect(await refused).toMatchObject({ fields: { reason: "session_turn_in_flight" } });
      expect(harness.server.framesForMethod(method)).toHaveLength(1);
    },
  );

  // Mutations: sending a turn while a goal set waits for Codex's answer, or once it answered and
  // before the goal's own turn starts, lets the two reach Codex together; waiting with no deadline
  // holds every start for good when Codex starts no turn for the goal.
  it.each([{ doesGoalTurnStart: true }, { doesGoalTurnStart: false }])(
    "sends a run's turn only once a goal set after the same turn's end started its own (starts: $doesGoalTurnStart)",
    async ({ doesGoalTurnStart }) => {
      // The goal's run opens only when the test lets it, so the start goes on at the turn's start.
      const goalRunOpening = Promise.withResolvers<void>();
      const harness = await stoppableSession({
        turnStartTimeoutMs: START_DEADLINE_MS,
        openDaemonTurnBinding: async () => {
          await goalRunOpening.promise;
          return { bindingId: "binding-goal", agentId: AGENT_ID as AgentId };
        },
      });
      harness.server.on("thread/goal/set", () => ({ result: {} }));
      await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
      await interruptFirstTurn(harness);
      const goal = harness.driver.setSessionGoal({ ...GOAL_PARAMS, goalText: "ship the fix" });
      let isGoalSettled = false;
      void goal.finally(() => {
        isGoalSettled = true;
      });
      // Settles with the start's refusal, or with nothing once it went.
      const started = harness.driver
        .startRun({ runId: SECOND_RUN_ID, agentConfig: runConfig("next") })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const releaseGoal = harness.server.holdAnswers("thread/goal/set");
      await drainMicrotasks();

      harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));
      await drainMicrotasks();
      expect(harness.server.framesForMethod("thread/goal/set")).toHaveLength(1);
      releaseGoal();
      await drainMicrotasks();
      expect(isGoalSettled).toBe(false);
      expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);

      if (doesGoalTurnStart) {
        harness.server.emitFrame({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId: THREAD_ID, turn: { id: "turn-goal", status: "inProgress" } },
        });
        await expect(goal).resolves.toStrictEqual({ status: "applied" });
        goalRunOpening.resolve();
        expect(await started).toMatchObject({ fields: { reason: "session_turn_in_flight" } });
        expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
      } else {
        harness.scheduler.fireDelay(START_DEADLINE_MS);
        await expect(goal).resolves.toStrictEqual({ status: "applied" });
        expect(await started).toBeUndefined();
        expect(harness.server.framesForMethod("turn/start")).toHaveLength(2);
      }
    },
  );

  // Mutations: answering while the run's turn is still starting refuses `Allow once`, since a turn
  // the daemon starts waits for it; approving into a turn still ending, as into a live one, makes
  // Codex start a turn for it that no run holds once the stopped turn ends.
  it("sends `Allow once` into a turn once it starts, and after a stopped turn's end as the session's own run", async () => {
    const harness = await stoppableSession();
    harness.server.on("thread/approveGuardianDeniedAction", () => ({ result: {} }));
    const allowOnce = async (): Promise<void> => {
      await harness.driver.overrideDenial({
        sessionId: SESSION_ID,
        providerDenial: { threadId: THREAD_ID, action: "rm -rf build" },
      });
    };
    const releaseStart = harness.server.holdAnswers("turn/start");
    const started = harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    await drainMicrotasks();
    const allowedWhileStarting = allowOnce();
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(0);
    releaseStart();
    await started;
    await allowedWhileStarting;
    expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(1);
    expect(harness.daemonTurnRunIds).toHaveLength(0);
    await interruptFirstTurn(harness);

    const allowed = allowOnce();
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(1);
    harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));
    await drainMicrotasks();
    expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(2);
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "turn-allowed" } },
    });
    await allowed;
    expect(harness.daemonTurnRunIds).toHaveLength(1);
  });

  // Mutations: giving each wait its own deadline lets the start wait a fresh one for a turn
  // stopped after its first wait ended; bounding the waits by the request deadline keeps it
  // waiting past the start's own.
  it("gives up a start once its one deadline passed, though the turn it waits on stopped later", async () => {
    const filesRead = Promise.withResolvers<void>();
    const harness = await stoppableSession({
      turnStartTimeoutMs: START_DEADLINE_MS,
      // The start reads its files after its first wait, while Codex starts a turn of its own.
      attachments: {
        resolveAttachments: async (_sessionId, artifactIds) => {
          await filesRead.promise;
          return artifactIds.map((artifactId) => ({
            kind: "unresolved",
            artifactId,
            cause: "deleted",
          }));
        },
      },
      // The run of a turn Codex started cannot open while the start's run is live, so the daemon
      // stops that turn.
      runEngine: {
        startDaemonTurn: () => Promise.reject(new Error("A lead run of the session is live.")),
        endTurnOnProcessExit: () => Promise.resolve(),
        recordSettledOutputSpeed: () => Promise.resolve(),
      },
    });
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    await interruptFirstTurn(harness);

    const refused = captureRejection(
      harness.driver.startRun({
        runId: SECOND_RUN_ID,
        agentConfig: { ...runConfig("next"), attachments: [STAGED_ATTACHMENT_IDS.deleted] },
      }),
    );
    await drainMicrotasks();
    harness.server.emitFrame(turnCompletedFrame("turn-1", "interrupted"));
    await drainMicrotasks();
    harness.server.emitFrame({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "turn-own" } },
    });
    await drainMicrotasks();
    expect(harness.server.framesForMethod("turn/interrupt")).toHaveLength(2);
    // The start's deadline, begun at its first wait, passes while it reads its files.
    expect(harness.scheduler.fireDelay(START_DEADLINE_MS)).toBe(1);
    filesRead.resolve();

    expect(await refused).toMatchObject({ fields: { reason: "session_turn_in_flight" } });
    expect(harness.server.framesForMethod("turn/start")).toHaveLength(1);
  });

  // Mutation: leaving the waits asleep when Codex refuses the interrupt holds `Allow once` until
  // its deadline, though the turn it waits on runs on as the run's.
  it.each([
    {
      stop: "a faster-model retry",
      stopTurn: async (harness: Harness): Promise<{ readonly stopped: Promise<unknown> }> => {
        const retried = captureRejection(
          harness.driver.retryTurnOnFasterModel({
            sessionId: SESSION_ID,
            runId: RUN_ID,
            expectedTurnId: "turn-1",
            model: "gpt-5.5-mini",
          }),
        );
        await drainMicrotasks();
        return { stopped: retried };
      },
    },
    {
      stop: "a pause",
      stopTurn: async (harness: Harness): Promise<{ readonly stopped: Promise<unknown> }> => {
        await pauseAtStepEnd(harness, "turn-1");
        return { stopped: Promise.resolve() };
      },
    },
  ])(
    "sends `Allow once` into the turn once Codex refuses $stop's interrupt",
    async ({ stopTurn }) => {
      const harness = await stoppableSession();
      harness.server.on("thread/approveGuardianDeniedAction", () => ({ result: {} }));
      await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
      harness.server.on("turn/interrupt", () => ({
        error: { code: -32600, message: "interrupt refused" },
      }));
      const releaseInterrupt = harness.server.holdAnswers("turn/interrupt");
      const { stopped } = await stopTurn(harness);

      const allowed = harness.driver.overrideDenial({
        sessionId: SESSION_ID,
        providerDenial: { threadId: THREAD_ID, action: "rm -rf build" },
      });
      await drainMicrotasks();
      expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(0);
      releaseInterrupt();
      await allowed;
      await stopped;

      expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(1);
      expect(harness.daemonTurnRunIds).toHaveLength(0);
    },
  );

  // Mutations: leaving a wait on a record that left holds `Allow once` until its deadline, though no
  // turn of a closed session will end; settling it as not ended refuses it as a turn in flight.
  it("refuses `Allow once` waiting on a stopped turn as closed when the session closes", async () => {
    const harness = await stoppableSession();
    harness.server.on("thread/unsubscribe", () => ({ result: {} }));
    await harness.driver.startRun({ runId: RUN_ID, agentConfig: runConfig("go") });
    await interruptFirstTurn(harness);
    const refused = captureRejection(
      harness.driver.overrideDenial({
        sessionId: SESSION_ID,
        providerDenial: { threadId: THREAD_ID, action: "rm -rf build" },
      }),
    );
    await drainMicrotasks();

    await harness.driver.closeSession({ sessionId: SESSION_ID });

    expect(await refused).toMatchObject({ code: SESSION_ALREADY_CLOSED_CODE });
    expect(harness.server.framesForMethod("thread/approveGuardianDeniedAction")).toHaveLength(0);
  });
});
