// A queued run's start that does not reach the provider's turn: a run the gate holds past the
// delivery timeout, and one whose start fails before its driver has it, ends failed with its
// messages not delivered and gives up its place at the gate, so the next send starts a run; an
// opening the driver took is never handed again while its outcome waits to be written.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openRunQueueFixture,
  waitForOpening,
  type RunQueueFixture,
} from "./service.test-support.js";

describe("a queued run's start", () => {
  let fixture: RunQueueFixture | undefined;

  afterEach(async () => {
    expect(fixture?.serviceLog).toEqual([]);
    await fixture?.close();
    fixture = undefined;
  });

  // Refuses every event of `type` the session's log is asked to append, until the test drops it.
  async function refuseEvents(queueFixture: RunQueueFixture, type: string): Promise<void> {
    await queueFixture.engine.database.writer.write([
      {
        sql: `CREATE TRIGGER refuse_for_test BEFORE INSERT ON session_events
                WHEN NEW.type = '${type}'
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);
  }

  async function acceptEvents(queueFixture: RunQueueFixture): Promise<void> {
    await queueFixture.engine.database.writer.write([{ sql: "DROP TRIGGER refuse_for_test" }]);
  }

  // Mutation: waiting for the gate with no deadline leaves the message queued for good.
  it("leaves a message not delivered, and ends its run, when the gate holds the run past the timeout", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
      deliveryTimeoutMs: 20,
    });
    fixture = queueFixture;
    // Admitted first, so the run behind it waits for memory that never frees.
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });
    expect(blocker.state).toBe("admitted");

    const sent = await queueFixture.send("Add the retry");

    await vi.waitFor(() => {
      expect(queueFixture.readItem(sent.queueItemId)).toMatchObject({
        state: "not_delivered",
        notDeliveredReason: "timed_out",
      });
    });
    const runId = queueFixture.readItem(sent.queueItemId)?.targetRunId;
    expect(runId === undefined ? undefined : queueFixture.engine.runs.getRun(runId)?.state).toBe(
      "failed",
    );
    expect(queueFixture.readEventTypes()).toEqual([
      "run.queued",
      "queue_item.created",
      "user.message",
      "queue_item.not_delivered",
      "run.failed",
    ]);
    expect(queueFixture.startedRuns).toEqual([]);

    // Sent again from its row, the message starts a run of its own once memory frees.
    blocker.release();
    await waitForOpening(queueFixture, await queueFixture.send("Add the retry"));
  });

  // Mutation: leaving a run whose start failed queued takes every later send into a run that never
  // starts.
  it("ends a run whose first write failed, so the next send starts a run of its own", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
    });
    fixture = queueFixture;
    await refuseEvents(queueFixture, "run.starting");

    const failed = await queueFixture.send("Add the retry");

    await vi.waitFor(() => {
      expect(queueFixture.readItem(failed.queueItemId)).toMatchObject({
        state: "not_delivered",
        notDeliveredReason: "failed",
      });
    });
    const failedRunId = queueFixture.readItem(failed.queueItemId)?.targetRunId;
    expect(
      failedRunId === undefined ? undefined : queueFixture.engine.runs.getRun(failedRunId)?.state,
    ).toBe("failed");
    expect(queueFixture.serviceLog).toEqual([
      expect.stringContaining(`starting run ${failedRunId} of session`),
    ]);
    queueFixture.serviceLog.length = 0;

    await acceptEvents(queueFixture);
    const next = await queueFixture.send("Add the retry");

    await waitForOpening(queueFixture, next);
    expect(queueFixture.readItem(next.queueItemId)?.targetRunId).not.toBe(failedRunId);
  });

  // Mutations: forgetting the opening before its outcome is written hands Claude Code the opening a
  // second time once its run runs; leaving its outcome unwritten at the run's end makes it the next
  // run's opening, sent again.
  it("never hands Claude Code the opening again when its outcome could not be written", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    await refuseEvents(queueFixture, "queue_item.admitted");

    const opening = await queueFixture.send("Add the retry");

    await vi.waitFor(() => {
      expect(queueFixture.startedRuns).toHaveLength(1);
      expect(queueFixture.serviceLog).toHaveLength(1);
    });
    queueFixture.serviceLog.length = 0;
    const [runId] = queueFixture.startedRunIds();
    if (runId === undefined) {
      throw new Error("The opening started no run");
    }
    const { sessionId } = queueFixture.engine;
    await queueFixture.queue.lifecycle.reconcile(sessionId);
    await queueFixture.queue.delivery.settle(sessionId);
    expect(queueFixture.steers).toEqual([]);

    await acceptEvents(queueFixture);
    await queueFixture.engine.engine.transition({
      runId,
      newState: "completed",
      completionKind: "turn",
    });

    await waitForOpening(queueFixture, opening);
    await queueFixture.queue.lifecycle.reconcile(sessionId);
    expect(queueFixture.startedRuns).toHaveLength(1);
  });
});
