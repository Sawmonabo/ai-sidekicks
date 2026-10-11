// A person's changes to their waiting messages, asserted on what each provider is handed: a removed
// message never reaches it, removing the last message of a run not yet started ends that run, an
// edit keeps its message's place and is refused once the agent took the message, and a reorder
// names exactly the waiting messages of the one queue it reorders.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChildHandleSchema } from "@ai-sidekicks/contracts/agent/tree";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import {
  QUEUE_CHANGE_REFUSED_CODE,
  QueueItemIdSchema,
  type QueueItemCreateResponse,
  type QueueItemId,
} from "@ai-sidekicks/contracts/run/queue";

import type { WithdrawQueuedMessageResult } from "../../provider/driver/run-control.js";
import {
  openRunQueueFixture,
  startFirstRun,
  type RunQueueFixture,
} from "./service.test-support.js";

describe("a change to a waiting message", () => {
  let fixture: RunQueueFixture | undefined;

  afterEach(async () => {
    expect(fixture?.serviceLog).toEqual([]);
    await fixture?.close();
    fixture = undefined;
  });

  async function sendAll(
    queueFixture: RunQueueFixture,
    contents: readonly string[],
  ): Promise<QueueItemId[]> {
    const sent: QueueItemCreateResponse[] = [];
    for (const content of contents) {
      sent.push(await queueFixture.send(content));
    }
    return sent.map((item) => item.queueItemId);
  }

  // The words of each message the driver was handed, in the order it was handed them.
  function handedContents(queueFixture: RunQueueFixture): string[] {
    return queueFixture.steers.map((steer) =>
      steer.type === "steer" ? steer.payload.content : "",
    );
  }

  function edit(queueFixture: RunQueueFixture, replaces: QueueItemId, content: string) {
    return queueFixture.queue.create(
      {
        sessionId: queueFixture.engine.sessionId,
        clientIdempotencyKey: randomUUID(),
        content,
        replacesQueueItemId: replaces,
      },
      queueFixture.deviceId,
    );
  }

  function waitingIds(queueFixture: RunQueueFixture): QueueItemId[] {
    return queueFixture.queue
      .list({ sessionId: queueFixture.engine.sessionId, state: "queued" })
      .items.map((item) => item.id);
  }

  // Mutation: answering the removal without writing it leaves the message waiting, and Codex is
  // handed it at the next tool boundary.
  it("never hands Codex a message removed while it waited", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const [removed] = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    if (removed === undefined) {
      throw new Error("A send answered nothing");
    }

    await expect(queueFixture.queue.cancel({ queueItemId: removed })).resolves.toEqual({
      queueItemId: removed,
      state: "canceled",
    });
    queueFixture.queue.delivery.onToolBoundary({ sessionId: queueFixture.engine.sessionId, runId });

    await vi.waitFor(() => {
      expect(handedContents(queueFixture)).toEqual(["Then the docs"]);
    });
    expect(queueFixture.readItem(removed)?.state).toBe("canceled");
  });

  // Mutation: removing the last message without ending its run leaves a queued run with nothing to
  // start it with, holding every later send.
  it("ends a run not yet started when its last message is removed, in the removal's write", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
    });
    fixture = queueFixture;
    // Admitted first, so the run waits at the gate while its message is removed.
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });
    const sent = await queueFixture.send("Add the retry");
    const runId = queueFixture.readItem(sent.queueItemId)?.targetRunId;

    await queueFixture.queue.cancel({ queueItemId: sent.queueItemId });
    blocker.release();

    expect(runId === undefined ? undefined : queueFixture.engine.runs.getRun(runId)?.state).toBe(
      "failed",
    );
    expect(queueFixture.readEventTypes()).toEqual([
      "run.queued",
      "queue_item.created",
      "user.message",
      "queue_item.canceled",
      "run.failed",
    ]);
    expect(queueFixture.startedRuns).toEqual([]);
  });

  // Mutation: placing the edit as a new message at the end hands Codex the edited words last.
  it("hands Codex an edited message in the place of the message it replaced", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const [, edited] = await sendAll(queueFixture, [
      "Then the tests",
      "Then the docs",
      "Then ship",
    ]);
    if (edited === undefined) {
      throw new Error("A send answered nothing");
    }

    await edit(queueFixture, edited, "Then the docs and the changelog");
    queueFixture.queue.delivery.onToolBoundary({ sessionId: queueFixture.engine.sessionId, runId });

    await vi.waitFor(() => {
      expect(handedContents(queueFixture)).toEqual([
        "Then the tests",
        "Then the docs and the changelog",
        "Then ship",
      ]);
    });
    expect(queueFixture.readItem(edited)?.state).toBe("superseded");
  });

  // Mutation: leaving out the re-hand after the edit's write leaves Claude Code without the edited
  // message and the one after it, which it gave back.
  it("hands Claude Code the edited message and every one after it again, in order", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    await startFirstRun(queueFixture, "Add the retry");
    const [, edited] = await sendAll(queueFixture, [
      "Then the tests",
      "Then the docs",
      "Then ship",
    ]);
    if (edited === undefined) {
      throw new Error("A send answered nothing");
    }
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(3);
    });

    await edit(queueFixture, edited, "Then the docs and the changelog");

    await vi.waitFor(() => {
      expect(handedContents(queueFixture).slice(3)).toEqual([
        "Then the docs and the changelog",
        "Then ship",
      ]);
    });
  });

  // Mutations: answering the edit as written once Claude Code says it delivered the message writes
  // an edit the agent never reads; leaving out the re-hand strands the message after it.
  it("refuses an edit of a message Claude Code already took, changing nothing", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    await startFirstRun(queueFixture, "Add the retry");
    const [taken, after] = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    if (taken === undefined || after === undefined) {
      throw new Error("A send answered nothing");
    }
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(2);
    });
    queueFixture.answerWithdraw = (params) =>
      Promise.resolve(
        params.clientIdempotencyKey === taken
          ? { status: "already_delivered" }
          : { status: "withdrawn" },
      );

    const refused: unknown = await edit(queueFixture, taken, "Then the integration tests").catch(
      (error: unknown) => error,
    );

    expect(refused).toMatchObject({
      code: QUEUE_CHANGE_REFUSED_CODE,
      detail: { reason: "already_taken" },
    });
    expect(queueFixture.readItem(taken)?.state).toBe("admitted");
    expect(queueFixture.readEventTypes()).not.toContain("queue_item.superseded");
    // Only the message after it still waits; no edit was queued.
    expect(
      queueFixture.queue
        .list({ sessionId: queueFixture.engine.sessionId })
        .items.map((item) => item.id),
    ).toEqual([after]);
    await vi.waitFor(() => {
      expect(handedContents(queueFixture).slice(2)).toEqual(["Then the docs"]);
    });
  });

  // Mutations: leaving out the re-hand after the reorder's write leaves Claude Code without the
  // messages it gave back; accepting a list one short reorders a queue the person never saw whole;
  // withdrawing one message after another holds the session's every change for each deadline.
  it("reorders exactly the waiting messages and hands them to Claude Code again in the new order", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    await startFirstRun(queueFixture, "Add the retry");
    const [tests, docs] = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    if (tests === undefined || docs === undefined) {
      throw new Error("A send answered nothing");
    }
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(2);
    });

    for (const queueItemIds of [[docs], [docs, tests, QueueItemIdSchema.parse(randomUUID())]]) {
      const refused: unknown = await queueFixture.queue
        .reorder({ sessionId: queueFixture.engine.sessionId, queueItemIds })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: QUEUE_CHANGE_REFUSED_CODE,
        detail: { reason: "order_mismatch" },
      });
    }
    expect(waitingIds(queueFixture)).toEqual([tests, docs]);

    // Both withdraws go out before Claude Code answers either, under one deadline.
    const withdraws: PromiseWithResolvers<WithdrawQueuedMessageResult>[] = [];
    queueFixture.answerWithdraw = () => {
      const withdraw = Promise.withResolvers<WithdrawQueuedMessageResult>();
      withdraws.push(withdraw);
      return withdraw.promise;
    };
    const reordering = queueFixture.queue.reorder({
      sessionId: queueFixture.engine.sessionId,
      queueItemIds: [docs, tests],
    });
    await vi.waitFor(() => {
      expect(withdraws).toHaveLength(2);
    });
    for (const withdraw of withdraws) {
      withdraw.resolve({ status: "withdrawn" });
    }
    await reordering;

    expect(waitingIds(queueFixture)).toEqual([docs, tests]);
    await vi.waitFor(() => {
      expect(handedContents(queueFixture).slice(2)).toEqual(["Then the docs", "Then the tests"]);
    });
  });

  // Mutation: reordering by session alone moves the lead's waiting messages with the child's.
  it("reorders a child's waiting messages and leaves the lead's where they are", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const lead = await sendAll(queueFixture, ["Then the tests", "Then the docs"]);
    const childHandle = ChildHandleSchema.parse("reviewer");
    const [first, second] = await insertChildMessages(queueFixture, runId, childHandle, 2);
    if (first === undefined || second === undefined) {
      throw new Error("No child message was written");
    }

    await queueFixture.queue.reorder({
      sessionId: queueFixture.engine.sessionId,
      childHandle,
      queueItemIds: [second, first],
    });

    expect(
      queueFixture.queue
        .list({ sessionId: queueFixture.engine.sessionId, childHandle, state: "queued" })
        .items.map((item) => item.id),
    ).toEqual([second, first]);
    expect(waitingIds(queueFixture)).toEqual(lead);
  });
});

// Writes `count` messages waiting in the child's own queue under `runId`, as its steer box sends
// them, and answers their ids in order.
async function insertChildMessages(
  queueFixture: RunQueueFixture,
  runId: RunId,
  childHandle: string,
  count: number,
): Promise<QueueItemId[]> {
  const now = new Date().toISOString();
  const ids = Array.from({ length: count }, () => QueueItemIdSchema.parse(randomUUID()));
  await queueFixture.engine.database.writer.write(
    ids.map((id, position) => ({
      sql: `INSERT INTO queue_items
              (id, session_id, state, payload, target_run_id, device_id, child_handle, position,
               client_idempotency_key, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?, NULL, ?, ?, ?, ?, ?)`,
      bindings: [
        id,
        queueFixture.engine.sessionId,
        JSON.stringify({ content: `Child step ${position}` }),
        runId,
        childHandle,
        position,
        randomUUID(),
        now,
        now,
      ],
    })),
  );
  return ids;
}
