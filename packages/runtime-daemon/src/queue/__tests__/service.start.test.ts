// A queued run's start that does not reach the provider's turn: a run the gate holds past the
// delivery timeout, and one whose start fails before its driver has it, ends failed with its
// messages not delivered and gives up its place at the gate, so the next send starts a run, and a
// retry of a message not delivered sends its words again as a new message; an opening the driver
// took is never handed again while its outcome waits to be written.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUEUE_CHANGE_REFUSED_CODE,
  type QueueItemCreateResponse,
  type QueueItemId,
} from "@ai-sidekicks/contracts/run/queue";

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

  // Sends `failed` again in `content`, under `clientIdempotencyKey`, by default the failed id.
  function retry(
    queueFixture: RunQueueFixture,
    failed: QueueItemId,
    content: string,
    clientIdempotencyKey: string = failed,
  ): Promise<QueueItemCreateResponse> {
    return queueFixture.queue.create(
      {
        sessionId: queueFixture.engine.sessionId,
        clientIdempotencyKey,
        content,
        replacesQueueItemId: failed,
      },
      queueFixture.deviceId,
    );
  }

  // Leaves `content`, at `outputSpeedForTurn` when one is given, not delivered: the gate holds its
  // run past the delivery timeout, and the returned release frees the memory that run waited for.
  async function sendUndelivered(
    queueFixture: RunQueueFixture,
    content: string,
    outputSpeedForTurn?: string,
  ): Promise<{ readonly failed: QueueItemId; readonly release: () => void }> {
    // Admitted first, so the run behind it waits for memory that never frees.
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });
    expect(blocker.state).toBe("admitted");
    const sent = await queueFixture.queue.create(
      {
        sessionId: queueFixture.engine.sessionId,
        clientIdempotencyKey: randomUUID(),
        content,
        ...(outputSpeedForTurn === undefined ? {} : { outputSpeedForTurn }),
      },
      queueFixture.deviceId,
    );
    await vi.waitFor(() => {
      expect(queueFixture.readItem(sent.queueItemId)).toMatchObject({
        state: "not_delivered",
        notDeliveredReason: "timed_out",
      });
    });
    return {
      failed: sent.queueItemId,
      release: () => {
        blocker.release();
      },
    };
  }

  // Mutation: waiting for the gate with no deadline leaves the message queued for good.
  it("leaves a message not delivered, and ends its run, when the gate holds the run past the timeout", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
      deliveryTimeoutMs: 20,
    });
    fixture = queueFixture;

    const { failed, release } = await sendUndelivered(queueFixture, "Add the retry");

    const runId = queueFixture.readItem(failed)?.targetRunId;
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
    release();
  });

  // Mutations: editing a not-delivered message as a waiting one refuses the retry; leaving the
  // failed message as it was keeps it not delivered beside its retry; accepting other words sends
  // what the failed message never said; taking the body from the request drops what the failed
  // message carried; refusing a second press under another key as taken misnames it.
  it("sends a not-delivered message again as a new message, once, with its own words", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
      deliveryTimeoutMs: 20,
    });
    fixture = queueFixture;
    const { failed, release } = await sendUndelivered(queueFixture, "Add the retry", "standard");

    await expect(
      retry(queueFixture, failed, "Add the retries", randomUUID()),
    ).rejects.toMatchObject({
      code: QUEUE_CHANGE_REFUSED_CODE,
      detail: { reason: "not_delivered" },
    });
    release();
    const retried = await retry(queueFixture, failed, "Add the retry");
    // A second press under the same key answers the first; under another, the failed message has
    // left the queue.
    expect(await retry(queueFixture, failed, "Add the retry")).toEqual(retried);
    await expect(retry(queueFixture, failed, "Add the retry", randomUUID())).rejects.toMatchObject({
      code: QUEUE_CHANGE_REFUSED_CODE,
      message: `Queue item ${failed} has left the queue`,
    });

    expect(queueFixture.readItem(failed)?.state).toBe("superseded");
    expect(queueFixture.readItem(retried.queueItemId)?.body).toEqual({
      content: "Add the retry",
      outputSpeedForTurn: "standard",
    });
    expect(queueFixture.readItem(retried.queueItemId)?.position).toBeGreaterThan(
      queueFixture.readItem(failed)?.position ?? Number.POSITIVE_INFINITY,
    );
    expect(queueFixture.readEventTypes().slice(-4)).toEqual([
      "run.queued",
      "queue_item.created",
      "queue_item.superseded",
      "user.message",
    ]);
    // It waits as any send does: the failed message's run ended, so it starts one of its own.
    await waitForOpening(queueFixture, retried);
    const failedRunId = queueFixture.readItem(failed)?.targetRunId;
    if (failedRunId === undefined) {
      throw new Error("The failed message names no run");
    }
    expect(queueFixture.readItem(retried.queueItemId)?.targetRunId).not.toBe(failedRunId);

    // Mutation: dropping the line leaves no trace that the agent has the message twice.
    const { sessionId } = queueFixture.engine;
    queueFixture.queue.delivery.messageTaken(sessionId, failed, failedRunId);
    await queueFixture.queue.delivery.settle(sessionId);
    expect(queueFixture.readItem(failed)?.state).toBe("superseded");
    expect(queueFixture.serviceLog).toEqual([
      `run queue: the agent took message ${failed} after a retry sent it again, so it has it twice`,
    ]);
    queueFixture.serviceLog.length = 0;
  });

  // Mutation: letting the refused superseding's write refusal through answers the retry with a raw
  // store error instead of a refused change.
  it("refuses a retry whose failed message moved during its write, writing nothing", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
      deliveryTimeoutMs: 20,
    });
    fixture = queueFixture;
    const { failed, release } = await sendUndelivered(queueFixture, "Add the retry");
    // The agent takes the failed message between the retry's read and its write.
    await queueFixture.engine.database.writer.write([
      {
        sql: `CREATE TRIGGER take_for_test BEFORE INSERT ON queue_items
                BEGIN UPDATE queue_items SET state = 'admitted', not_delivered_reason = NULL
                  WHERE id = '${failed}'; END`,
      },
    ]);

    await expect(retry(queueFixture, failed, "Add the retry")).rejects.toMatchObject({
      code: QUEUE_CHANGE_REFUSED_CODE,
    });
    expect(queueFixture.readItem(failed)?.state).toBe("not_delivered");
    expect(
      queueFixture.queue.list({ sessionId: queueFixture.engine.sessionId }).items,
    ).toHaveLength(1);
    await queueFixture.engine.database.writer.write([{ sql: "DROP TRIGGER take_for_test" }]);
    release();
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
