// An interrupt's choice for the messages waiting for the run it ends, through the daemon's own
// intervention service: sent back to the draft they are canceled with the run's end, Claude Code
// first giving back what it holds, and nothing goes on; sent as the next turn they continue the
// same run, the one `Send now` named first, unless Claude Code kept them for a turn of its own. An
// interrupt during the run's start leaves its opening to that choice, and a run that ended before
// the interrupt could end it still has its messages sent back. A send continues an interrupted run,
// unless a turn Codex started itself runs first and takes its messages; such a turn opens no run
// while a lead run waits to start.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import {
  QUEUE_CHANGE_REFUSED_CODE,
  type QueueItemCreateResponse,
  type QueueItemId,
} from "@ai-sidekicks/contracts/run/queue";

import {
  refuseDriverInterrupt,
  TEST_EXECUTION_POSTURE,
} from "../../session/run/__tests__/engine.test-support.js";
import {
  openRunQueueFixture,
  startFirstRun,
  waitForOpening,
  type RunQueueFixture,
  type RunQueueFixtureOptions,
} from "./service.test-support.js";

const PROVIDERS: readonly ProviderName[] = ["claude", "codex"];

// The one time the engine and the queue read, so a row stamped from another clock stands out.
const DAEMON_CLOCK = "2026-10-11T15:00:00.000Z";

describe("an interrupt's choice for the waiting messages", () => {
  let fixture: RunQueueFixture | undefined;

  afterEach(async () => {
    expect(fixture?.serviceLog).toEqual([]);
    await fixture?.close();
    fixture = undefined;
  });

  async function openFixture(
    driverName: ProviderName,
    options: Omit<RunQueueFixtureOptions, "driverName"> = {},
  ): Promise<RunQueueFixture> {
    await fixture?.close();
    fixture = await openRunQueueFixture({ driverName, ...options });
    return fixture;
  }

  async function sendAll(
    queueFixture: RunQueueFixture,
    contents: readonly string[],
  ): Promise<QueueItemCreateResponse[]> {
    const sent: QueueItemCreateResponse[] = [];
    for (const content of contents) {
      sent.push(await queueFixture.send(content));
    }
    return sent;
  }

  // Settles once Claude Code has been handed every one of `count` steers.
  async function waitForSteers(queueFixture: RunQueueFixture, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(count);
    });
  }

  // Settles once the run reads `state` and the queue has followed every change before it.
  async function waitForRunState(
    queueFixture: RunQueueFixture,
    runId: RunId,
    state: string,
  ): Promise<void> {
    await vi.waitFor(() => {
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe(state);
    });
    await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);
  }

  // Mutations: leaving out Claude Code's withdraw before the interrupt leaves it holding the
  // message the draft took back; leaving out the cancels lets the messages become the next run.
  it("takes back and cancels every waiting message with the run's end on either provider", async () => {
    for (const driverName of PROVIDERS) {
      const queueFixture = await openFixture(driverName);
      const runId = await startFirstRun(queueFixture, "Add the retry");
      const waiting = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
      if (driverName === "claude") {
        await waitForSteers(queueFixture, 2);
      }
      let withdrawsBeforeInterrupt: string[] = [];
      queueFixture.answerInterrupt = () => {
        withdrawsBeforeInterrupt = queueFixture.withdraws.map(
          (params) => params.clientIdempotencyKey,
        );
        return Promise.resolve({ status: "applied" });
      };

      const answer = await queueFixture.interrupt(runId, "returnToDraft");

      expect(answer.state).toBe("applied");
      expect(withdrawsBeforeInterrupt).toEqual(
        driverName === "claude" ? waiting.map((item) => item.queueItemId) : [],
      );
      for (const item of waiting) {
        expect(queueFixture.readItem(item.queueItemId)?.state).toBe("canceled");
      }
      // The cancels ride the run's end, in its write.
      expect(queueFixture.readEventTypes().slice(-4)).toEqual([
        "intervention.applied",
        "queue_item.canceled",
        "queue_item.canceled",
        "run.interrupted",
      ]);
      await waitForRunState(queueFixture, runId, "interrupted");
      expect(queueFixture.startedRuns).toHaveLength(1);
    }
  });

  // Mutations: answering a send to an interrupted run with a new run starts another run id;
  // enqueuing the continue at the memory gate again, over the reservation parked for it, takes a
  // second place.
  it("continues the interrupted run with a send, on its parked reservation, on either provider", async () => {
    for (const driverName of PROVIDERS) {
      const queueFixture = await openFixture(driverName);
      const runId = await startFirstRun(queueFixture, "Add the retry");
      await queueFixture.interrupt(runId, "returnToDraft");
      await waitForRunState(queueFixture, runId, "interrupted");

      const sent = await queueFixture.send("Then the docs");

      await waitForOpening(queueFixture, sent);
      expect(queueFixture.readItem(sent.queueItemId)?.targetRunId).toBe(runId);
      expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
      expect(queueFixture.openings).toEqual(["Add the retry", "Then the docs"]);
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("running");
      expect(queueFixture.enqueuedWork).toHaveLength(1);
    }
  });

  // Mutation: leaving out the new places opens the continued turn with the first message sent.
  it("continues the same run with the message Send now named, the rest after it in order", async () => {
    const queueFixture = await openFixture("codex");
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const [tests, docs, changelog] = await sendAll(queueFixture, [
      "Then the tests",
      "Then the docs",
      "Then the changelog",
    ]);
    if (tests === undefined || docs === undefined || changelog === undefined) {
      throw new Error("A send answered nothing");
    }

    await queueFixture.interrupt(runId, "nextTurn", changelog.queueItemId);

    await waitForOpening(queueFixture, changelog);
    expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
    expect(queueFixture.openings.at(-1)).toBe("Then the changelog");
    const { items } = queueFixture.queue.list({ sessionId: queueFixture.engine.sessionId });
    expect(items.filter((item) => item.state === "queued").map((item) => item.id)).toEqual([
      tests.queueItemId,
      docs.queueItemId,
    ]);
  });

  // Mutation: taking back what Claude Code holds only for `returnToDraft` leaves both with it, so
  // its own next turn delivers the changelog second.
  it("takes back what Claude Code holds and resends it in the order Send now named", async () => {
    const queueFixture = await openFixture("claude");
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const [tests, changelog] = await sendAll(queueFixture, [
      "Then the tests",
      "Then the changelog",
    ]);
    if (tests === undefined || changelog === undefined) {
      throw new Error("A send answered nothing");
    }
    await waitForSteers(queueFixture, 2);

    await queueFixture.interrupt(runId, "nextTurn", changelog.queueItemId);

    await waitForOpening(queueFixture, changelog);
    expect(queueFixture.withdraws.map((params) => params.clientIdempotencyKey)).toEqual([
      tests.queueItemId,
      changelog.queueItemId,
    ]);
    expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
    expect(queueFixture.openings.at(-1)).toBe("Then the changelog");
    // The rest is handed into the continued turn after its opening.
    await waitForSteers(queueFixture, 3);
    expect(queueFixture.steers.at(-1)?.clientIdempotencyKey).toBe(tests.queueItemId);
  });

  // Mutation: continuing an interrupted run whatever Claude Code holds sends the kept message
  // again as the opening of a turn while Claude Code starts its own with it.
  it("leaves Claude Code the messages it keeps for the turn it continues the run with", async () => {
    const queueFixture = await openFixture("claude");
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const kept = await queueFixture.send("Cover the timeout too");
    await waitForSteers(queueFixture, 1);

    await queueFixture.interrupt(runId, "nextTurn");
    await waitForRunState(queueFixture, runId, "interrupted");

    expect(queueFixture.withdraws).toEqual([]);
    expect(queueFixture.readItem(kept.queueItemId)?.state).toBe("queued");
    expect(queueFixture.queue.delivery.isHanded(kept.queueItemId)).toBe(true);
    expect(queueFixture.startedRuns).toHaveLength(1);
  });

  // Holds the first run's start in its setup gates until `release` is called; later gates pass.
  function holdFirstStartInGates(queueFixture: RunQueueFixture): { release: () => void } {
    const released = Promise.withResolvers<void>();
    let isFirst = true;
    queueFixture.engine.engine.registerSetupGate({
      assertRunReady: async () => {
        if (isFirst) {
          isFirst = false;
          await released.promise;
        }
      },
    });
    return { release: () => released.resolve() };
  }

  async function interruptDuringStart(
    queueFixture: RunQueueFixture,
    pending: "returnToDraft" | "nextTurn",
  ): Promise<{ readonly runId: RunId; readonly opening: QueueItemCreateResponse }> {
    const gate = holdFirstStartInGates(queueFixture);
    const opening = await queueFixture.send("Add the retry");
    const runId = queueFixture.readItem(opening.queueItemId)?.targetRunId;
    if (runId === undefined) {
      throw new Error("The send queued no run");
    }
    await vi.waitFor(() => {
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("starting");
    });
    expect((await queueFixture.interrupt(runId, pending)).state).toBe("applied");
    gate.release();
    return { runId, opening };
  }

  // Mutation: leaving a starting run's opening out of the interrupt's write keeps it waiting, so
  // the run is continued with it after all.
  it("cancels the opening of a run interrupted during its start when it returns to the draft", async () => {
    const queueFixture = await openFixture("codex");

    const { runId, opening } = await interruptDuringStart(queueFixture, "returnToDraft");

    await waitForRunState(queueFixture, runId, "interrupted");
    await queueFixture.queue.admission.settled(runId);
    expect(queueFixture.readItem(opening.queueItemId)?.state).toBe("canceled");
    expect(queueFixture.startedRuns).toEqual([]);
  });

  // Mutation: writing the opening not delivered when the interrupted start throws ends the turn
  // the person asked to go on with.
  it("sends the opening of a run interrupted during its start as the continued run's turn", async () => {
    const queueFixture = await openFixture("codex");

    const { runId, opening } = await interruptDuringStart(queueFixture, "nextTurn");

    await waitForOpening(queueFixture, opening);
    expect(queueFixture.startedRunIds()).toEqual([runId]);
    expect(queueFixture.openings).toEqual(["Add the retry"]);
    expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("running");
  });

  // Mutation: holding nothing while the interrupt is under way lets the run's end make its
  // messages the next run before the interrupt's choice is read.
  it("cancels the messages of a run that ended before the interrupt could end it", async () => {
    const queueFixture = await openFixture("codex");
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const waiting = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    queueFixture.answerInterrupt = async () => {
      await queueFixture.engine.engine.applyProviderStateChange({
        runId,
        newState: "completed",
        completionKind: "turn",
      });
      // The queue has seen the run's end before the interrupt's choice is read.
      await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);
      return { status: "applied" };
    };

    await queueFixture.interrupt(runId, "returnToDraft");
    await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);

    expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("completed");
    for (const item of waiting) {
      expect(queueFixture.readItem(item.queueItemId)?.state).toBe("canceled");
    }
    expect(queueFixture.startedRuns).toHaveLength(1);
  });

  // Mutation: applying the choice only to what still waits for the ended run leaves the moved
  // messages to start the next run once memory frees.
  it("cancels the messages a run's end moved to the next run when an interrupt pressed before that end returns them to the draft", async () => {
    const queueFixture = await openFixture("codex", { availableMemoryBytes: 0 });
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const pressedAtVersion = queueFixture.engine.runs.getRun(runId)?.version;
    // Behind this, the next run waits for memory that does not free until the test lets it go.
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });
    const waiting = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    // The run's end lands before the interrupt pressed while it ran reaches the daemon.
    await queueFixture.engine.engine.applyProviderStateChange({
      runId,
      newState: "completed",
      completionKind: "turn",
    });
    await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);
    const [first] = waiting;
    const nextRunId =
      first === undefined ? undefined : queueFixture.readItem(first.queueItemId)?.targetRunId;
    if (nextRunId === undefined || nextRunId === runId) {
      throw new Error("The run's end moved its messages to no next run");
    }
    expect(queueFixture.engine.runs.getRun(nextRunId)?.state).toBe("queued");

    const answer = await queueFixture.interrupt(
      runId,
      "returnToDraft",
      undefined,
      pressedAtVersion,
    );

    // The run's end moved its version on, so the interrupt itself expires; its choice still holds.
    expect(answer.state).toBe("expired");
    for (const item of waiting) {
      expect(queueFixture.readItem(item.queueItemId)?.state).toBe("canceled");
    }
    expect(queueFixture.engine.runs.getRun(nextRunId)?.state).toBe("failed");
    blocker.release();
    await queueFixture.queue.admission.settled(nextRunId);
    expect(queueFixture.startedRunIds()).toEqual([runId]);
  });

  // Holds the starts of `runId` after its first in the setup gates until `release` is called.
  function holdContinueInGates(
    queueFixture: RunQueueFixture,
    runId: RunId,
  ): { readonly reached: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    queueFixture.engine.engine.registerSetupGate({
      assertRunReady: async (context) => {
        if (context.runId === runId) {
          reached.resolve();
          await released.promise;
        }
      },
    });
    return { reached: reached.promise, release: () => released.resolve() };
  }

  // Mutation: starting a daemon turn whatever waits for the session's interrupted run starts a
  // second turn on the provider session beside the continue.
  it("refuses a daemon turn while a send continues the session's interrupted run", async () => {
    const queueFixture = await openFixture("codex");
    const runId = await startFirstRun(queueFixture, "Add the retry");
    await queueFixture.interrupt(runId, "returnToDraft");
    await waitForRunState(queueFixture, runId, "interrupted");
    const gate = holdContinueInGates(queueFixture, runId);
    const sent = await queueFixture.send("Then the docs");
    await gate.reached;
    const startTurn = vi.fn(() => Promise.resolve());

    const refused: unknown = await queueFixture.engine.engine
      .startDaemonTurn({
        sessionId: queueFixture.engine.sessionId,
        provider: "codex",
        admittedProviderAccountId: null,
        executionPosture: TEST_EXECUTION_POSTURE,
        isProviderStarted: false,
        interruptTurn: refuseDriverInterrupt,
        startTurn,
      })
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: "driver.unavailable",
      detail: { reason: "session_turn_in_flight" },
    });
    expect(startTurn).not.toHaveBeenCalled();
    gate.release();
    await waitForOpening(queueFixture, sent);
    expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
    expect(queueFixture.readEventTypes().filter((type) => type === "run.queued")).toHaveLength(1);
  });

  // Mutations: leaving the take-over out of the provider's run's write leaves the messages on the
  // interrupted run, which its continue sends; holding a moved opening back as the continue's
  // hands the provider's turn the second message alone; starting the continue's turn after its
  // opening moved sends the opening into a second run; marking the opening not delivered when
  // the continue gives up, without checking which run it waits for, loses it; stamping the
  // take-over from the database's clock stamps it apart from every other queue row.
  it("hands the messages a continue would send to a turn Codex started itself, in their order", async () => {
    // The provider's turn reaches its tool boundary before, and after, the continue gives up.
    for (const isBoundaryFirst of [true, false]) {
      const queueFixture = await openFixture("codex", { now: () => DAEMON_CLOCK });
      const { sessionId } = queueFixture.engine;
      const runId = await startFirstRun(queueFixture, "Add the retry");
      await queueFixture.interrupt(runId, "returnToDraft");
      await waitForRunState(queueFixture, runId, "interrupted");
      const gate = holdContinueInGates(queueFixture, runId);
      const tests = (await queueFixture.send("Then the tests")).queueItemId;
      const docs = (await queueFixture.send("Then the docs")).queueItemId;
      await gate.reached;
      let targetsAtStart: (RunId | undefined)[] = [];

      const providerRunId = await queueFixture.engine.engine.startDaemonTurn({
        sessionId,
        provider: "codex",
        admittedProviderAccountId: null,
        executionPosture: TEST_EXECUTION_POSTURE,
        isProviderStarted: true,
        interruptTurn: refuseDriverInterrupt,
        startTurn: () => {
          targetsAtStart = [tests, docs].map(
            (itemId) => queueFixture.readItem(itemId)?.targetRunId,
          );
          return Promise.resolve();
        },
      });

      // Moved in the write that made the provider's run run, on the daemon's clock.
      expect(targetsAtStart).toEqual([runId, runId]);
      for (const itemId of [tests, docs]) {
        expect(queueFixture.readItem(itemId)).toMatchObject({
          targetRunId: providerRunId,
          updatedAt: DAEMON_CLOCK,
        });
      }
      if (!isBoundaryFirst) {
        gate.release();
        await queueFixture.queue.admission.settled(runId);
        for (const itemId of [tests, docs]) {
          expect(queueFixture.readItem(itemId)).toMatchObject({
            state: "queued",
            targetRunId: providerRunId,
          });
        }
      }
      queueFixture.queue.delivery.onToolBoundary({ sessionId, runId: providerRunId });

      await vi.waitFor(() => {
        expect(queueFixture.readItem(docs)?.state).toBe("admitted");
      });
      expect(
        queueFixture.steers.map((params) => [params.clientIdempotencyKey, params.targetRunId]),
      ).toEqual([
        [tests, providerRunId],
        [docs, providerRunId],
      ]);
      expect(queueFixture.readItem(tests)).toMatchObject({
        state: "admitted",
        targetRunId: providerRunId,
      });
      gate.release();
      await queueFixture.queue.admission.settled(runId);
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("interrupted");
      expect(queueFixture.startedRunIds()).toEqual([runId]);
      expect(queueFixture.serviceLog).toEqual([]);
    }
  });

  // Mutations: queuing the provider's run, or a turn the daemon starts, beside a lead run that
  // waits to start lets two lead runs hold the session, each sending its own turn.
  it.each([
    ["a turn Codex started itself", true],
    ["a turn the daemon starts", false],
  ])("queues no run for %s while a lead run waits to start", async (_case, isProviderStarted) => {
    const queueFixture = await openFixture("codex");
    const gate = holdFirstStartInGates(queueFixture);
    const opening = await queueFixture.send("Add the retry");
    const runId = queueFixture.readItem(opening.queueItemId)?.targetRunId;
    if (runId === undefined) {
      throw new Error("The send queued no run");
    }
    await vi.waitFor(() => {
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe("starting");
    });
    const startTurn = vi.fn(() => Promise.resolve());

    const refused: unknown = await queueFixture.engine.engine
      .startDaemonTurn({
        sessionId: queueFixture.engine.sessionId,
        provider: "codex",
        admittedProviderAccountId: null,
        executionPosture: TEST_EXECUTION_POSTURE,
        isProviderStarted,
        interruptTurn: refuseDriverInterrupt,
        startTurn,
      })
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: "driver.unavailable",
      detail: { reason: "session_turn_in_flight" },
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(queueFixture.readEventTypes().filter((type) => type === "run.queued")).toHaveLength(1);
    gate.release();
    await waitForOpening(queueFixture, opening);
    expect(queueFixture.startedRunIds()).toEqual([runId]);
  });

  // Mutation: holding a turn in a process of its own behind the live lead run refuses Claude Code's
  // review of the staged set while the lead works.
  it("starts a turn in a process of its own beside a live lead run", async () => {
    const queueFixture = await openFixture("claude");
    const leadRunId = await startFirstRun(queueFixture, "Add the retry");
    const startTurn = vi.fn(() => Promise.resolve());

    const reviewRunId = await queueFixture.engine.engine.startDaemonTurn({
      sessionId: queueFixture.engine.sessionId,
      provider: "claude",
      admittedProviderAccountId: null,
      executionPosture: TEST_EXECUTION_POSTURE,
      isProviderStarted: false,
      isApart: true,
      interruptTurn: refuseDriverInterrupt,
      startTurn,
    });

    expect(startTurn).toHaveBeenCalledWith(reviewRunId);
    expect(queueFixture.engine.runs.getRun(reviewRunId)?.state).toBe("running");
    expect(queueFixture.engine.runs.getRun(leadRunId)?.state).toBe("running");
  });

  // Mutations: taking the messages over in the write that queues the provider's run, which then
  // fails to open, starts a next run with them while the continue sends its opening too; ending
  // that run without waiting for the continue starts a next run beside it for a message sent
  // meanwhile; letting the newer run take a continue's reservation runs the continue with none;
  // reading a continue the driver refused once its messages moved as a failed one writes it to
  // the service log.
  it("sends the waiting messages once whether a turn Codex started opens its run or fails to", async () => {
    for (const doesOpen of [false, true]) {
      const queueFixture = await openFixture("codex");
      const { sessionId } = queueFixture.engine;
      const runId = await startFirstRun(queueFixture, "Add the retry");
      await queueFixture.interrupt(runId, "returnToDraft");
      await waitForRunState(queueFixture, runId, "interrupted");
      // As Codex does, the driver holds the continue back while the provider's turn opens its
      // run, and refuses it once that run runs.
      const reached = Promise.withResolvers<void>();
      const opened = Promise.withResolvers<boolean>();
      queueFixture.answerStart = async () => {
        reached.resolve();
        if (await opened.promise) {
          throw new Error("Codex runs a turn it started itself, so this one waits");
        }
      };
      const tests = (await queueFixture.send("Then the tests")).queueItemId;
      const docs = (await queueFixture.send("Then the docs")).queueItemId;
      await reached.promise;
      let changelog: QueueItemId | undefined;

      const providerRunId = await queueFixture.engine.engine
        .startDaemonTurn({
          sessionId,
          provider: "codex",
          admittedProviderAccountId: null,
          executionPosture: TEST_EXECUTION_POSTURE,
          isProviderStarted: true,
          // A send while the provider's run opens goes to that run.
          interruptTurn: refuseDriverInterrupt,
          startTurn: async () => {
            changelog = (await queueFixture.send("Then the changelog")).queueItemId;
            if (!doesOpen) {
              throw new Error("No binding opened");
            }
          },
        })
        .catch(() => undefined);
      opened.resolve(doesOpen);
      await queueFixture.queue.admission.settled(runId);
      const takerRunId = doesOpen ? providerRunId : runId;
      if (takerRunId === undefined) {
        throw new Error("The provider's turn opened no run");
      }
      await vi.waitFor(() => {
        expect(queueFixture.engine.runs.getRun(takerRunId)?.state).toBe("running");
      });
      queueFixture.queue.delivery.onToolBoundary({ sessionId, runId: takerRunId });

      await vi.waitFor(() => {
        expect(changelog === undefined ? undefined : queueFixture.readItem(changelog)?.state).toBe(
          "admitted",
        );
      });
      expect(queueFixture.readItem(tests)).toMatchObject({
        state: "admitted",
        targetRunId: takerRunId,
      });
      expect(
        queueFixture.steers.map((params) => [params.clientIdempotencyKey, params.targetRunId]),
      ).toEqual([
        ...(doesOpen ? [[tests, takerRunId]] : []),
        [docs, takerRunId],
        [changelog, takerRunId],
      ]);
      // The continue's start reached the driver once, and no other run was queued or started.
      expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
      expect(queueFixture.readEventTypes().filter((type) => type === "run.queued")).toHaveLength(2);
      expect(queueFixture.engine.runs.getRun(runId)?.state).toBe(
        doesOpen ? "interrupted" : "running",
      );
      expect(queueFixture.queue.admission.isAdmitting(runId)).toBe(!doesOpen);
      expect(queueFixture.serviceLog).toEqual([]);
    }
  });

  // Mutations: reading the session's newest lead run, the failed one among them, as the one a send
  // continues starts a next run with the message beside the interrupted run, after its continue
  // and after the failed run's end alike.
  it("keeps the interrupted run the one a send continues after a turn Codex started fails to open its run", async () => {
    // The interrupted run's continue is under way while the provider's run fails, or none is.
    for (const isContinuing of [true, false]) {
      const queueFixture = await openFixture("codex");
      const { sessionId } = queueFixture.engine;
      const runId = await startFirstRun(queueFixture, "Add the retry");
      await queueFixture.interrupt(runId, "returnToDraft");
      await waitForRunState(queueFixture, runId, "interrupted");
      const opened = Promise.withResolvers<void>();
      if (isContinuing) {
        const reached = Promise.withResolvers<void>();
        queueFixture.answerStart = async () => {
          reached.resolve();
          await opened.promise;
        };
        await queueFixture.send("Then the tests");
        await reached.promise;
      }
      let changelog: QueueItemCreateResponse | undefined;

      await queueFixture.engine.engine
        .startDaemonTurn({
          sessionId,
          provider: "codex",
          admittedProviderAccountId: null,
          executionPosture: TEST_EXECUTION_POSTURE,
          isProviderStarted: true,
          interruptTurn: refuseDriverInterrupt,
          startTurn: async () => {
            changelog = await queueFixture.send("Then the changelog");
            throw new Error("No binding opened");
          },
        })
        .catch(() => undefined);
      opened.resolve();
      if (changelog === undefined) {
        throw new Error("The provider's run took no send");
      }
      const sentChangelog = changelog;
      await waitForRunState(queueFixture, runId, "running");
      if (isContinuing) {
        // The continued run takes the message at its next tool boundary.
        await vi.waitFor(() => {
          expect(queueFixture.readItem(sentChangelog.queueItemId)?.targetRunId).toBe(runId);
        });
        queueFixture.queue.delivery.onToolBoundary({ sessionId, runId });
      }
      await waitForOpening(queueFixture, sentChangelog);
      expect(queueFixture.readItem(sentChangelog.queueItemId)?.targetRunId).toBe(runId);

      // Interrupted again, the run is still the one the next send continues.
      await queueFixture.interrupt(runId, "returnToDraft");
      await waitForRunState(queueFixture, runId, "interrupted");
      const readme = await queueFixture.send("Then the readme");
      await waitForOpening(queueFixture, readme);

      expect(queueFixture.readItem(readme.queueItemId)?.targetRunId).toBe(runId);
      expect(queueFixture.startedRunIds()).toEqual([runId, runId, runId]);
      expect(queueFixture.readEventTypes().filter((type) => type === "run.queued")).toHaveLength(2);
      expect(queueFixture.serviceLog).toEqual([]);
    }
  });

  // Kept by Claude Code for its own turn after a `nextTurn` interrupt, then removed by the person
  // under a withdraw Claude Code does not answer in time.
  async function keepUnansweredWithdraw(queueFixture: RunQueueFixture): Promise<{
    readonly runId: RunId;
    readonly kept: QueueItemCreateResponse;
    readonly answer: (status: "withdrawn" | "already_delivered") => void;
  }> {
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const kept = await queueFixture.send("Cover the timeout too");
    await waitForSteers(queueFixture, 1);
    await queueFixture.interrupt(runId, "nextTurn");
    await waitForRunState(queueFixture, runId, "interrupted");
    const late = Promise.withResolvers<"withdrawn" | "already_delivered">();
    queueFixture.answerWithdraw = async () => ({ status: await late.promise });

    await expect(
      queueFixture.queue.cancel({ queueItemId: kept.queueItemId }),
    ).rejects.toMatchObject({
      code: QUEUE_CHANGE_REFUSED_CODE,
      detail: { reason: "not_delivered" },
    });
    expect(queueFixture.readItem(kept.queueItemId)?.state).toBe("not_delivered");
    expect(queueFixture.serviceLog).toEqual([
      `run queue: the withdraw of message ${kept.queueItemId} was not answered within the deadline`,
    ]);
    queueFixture.serviceLog.length = 0;
    return { runId, kept, answer: (status) => late.resolve(status) };
  }

  // Mutation: forgetting the message at the deadline lets a send continue the run while Claude
  // Code may still start its own turn with the message it kept.
  it("continues the interrupted run only once Claude Code gives back a message whose withdraw timed out", async () => {
    const queueFixture = await openFixture("claude", { withdrawDeadlineMs: 1 });
    const { runId, kept, answer } = await keepUnansweredWithdraw(queueFixture);

    const sent = await queueFixture.send("Then the docs");
    await queueFixture.queue.admission.settled(runId);
    expect(queueFixture.startedRunIds()).toEqual([runId]);

    answer("withdrawn");
    await waitForOpening(queueFixture, sent);
    expect(queueFixture.startedRunIds()).toEqual([runId, runId]);
    expect(queueFixture.openings.at(-1)).toBe("Then the docs");
    expect(queueFixture.readItem(kept.queueItemId)?.state).toBe("not_delivered");
    expect(queueFixture.serviceLog).toEqual([
      `run queue: Claude Code answered the withdraw of message ${kept.queueItemId} after the ` +
        "deadline: withdrawn",
    ]);
    queueFixture.serviceLog.length = 0;
  });

  // Mutation: leaving a replayed message that reads not delivered as it is lets the person send
  // again what the agent already took.
  it("admits a message whose withdraw timed out when Claude Code replays it as taken", async () => {
    const queueFixture = await openFixture("claude", { withdrawDeadlineMs: 1 });
    const { runId, kept } = await keepUnansweredWithdraw(queueFixture);

    queueFixture.queue.delivery.messageTaken(
      queueFixture.engine.sessionId,
      kept.queueItemId,
      runId,
    );

    await vi.waitFor(() => {
      expect(queueFixture.readItem(kept.queueItemId)).toMatchObject({
        state: "admitted",
        targetRunId: runId,
      });
    });
    expect(
      queueFixture.queue.delivery.isMessageKeptForRun(queueFixture.engine.sessionId, runId),
    ).toBe(false);
  });
});
