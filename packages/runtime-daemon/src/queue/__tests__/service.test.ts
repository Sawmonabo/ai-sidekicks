// The run queue over a real database, writer, event log and run engine: a send is one write or
// nothing, a retried send saves nothing twice, a picked skill reaches Codex only as the file Codex
// listed, Codex's held messages go together at a tool boundary, what a turn left waiting becomes
// the next run, a message Claude Code kept or took late is admitted on its replay, and a run the
// memory gate never admits leaves its message not delivered. A skill read that starts Codex's
// service waits at the memory gate, and a run opens its provider session after its setup gates.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DriverInterventionResult } from "@ai-sidekicks/contracts/provider/driver/intervention";
import {
  QUEUE_CHANGE_REFUSED_CODE,
  QUEUE_PERSISTENCE_UNAVAILABLE_CODE,
  type QueueItemCreateResponse,
} from "@ai-sidekicks/contracts/run/queue";
import { SESSION_ALREADY_CLOSED_CODE } from "@ai-sidekicks/contracts/session/methods";
import { SKILL_PATH_REFUSED_CODE } from "@ai-sidekicks/contracts/skill";

import { SteerTurnEndedError } from "../../provider/driver/run-control.js";

import {
  openRunQueueFixture,
  startFirstRun,
  waitForOpening,
  type RunQueueFixture,
} from "./service.test-support.js";

describe("the run queue", () => {
  let fixture: RunQueueFixture | undefined;

  afterEach(async () => {
    expect(fixture?.serviceLog).toEqual([]);
    await fixture?.close();
    fixture = undefined;
  });

  function countRows(sql: string): number {
    if (fixture === undefined) {
      throw new Error("The fixture is not open");
    }
    return fixture.engine.database.reader.prepare<[], { count: number }>(sql).get()?.count ?? 0;
  }

  // Mutation: writing the queue row in a write of its own ahead of the event append leaves the row
  // of a send whose events were refused.
  it("writes a send's row, transcript row and run in one write, or none of them", async () => {
    fixture = await openRunQueueFixture({ driverName: "codex" });
    await fixture.engine.database.writer.write([
      {
        sql: `CREATE TRIGGER refuse_user_message BEFORE INSERT ON session_events
                WHEN NEW.type = 'user.message'
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);

    const refused: unknown = await fixture.send("Add the retry").catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: QUEUE_PERSISTENCE_UNAVAILABLE_CODE });
    expect(countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(0);
    expect(countRows("SELECT COUNT(*) AS count FROM runs")).toBe(0);
    expect(fixture.readEventTypes()).toEqual([]);

    await fixture.engine.database.writer.write([{ sql: "DROP TRIGGER refuse_user_message" }]);
    const sent = await fixture.send("Add the retry");

    const item = fixture.readItem(sent.queueItemId);
    expect(item).toMatchObject({ body: { content: "Add the retry" } });
    expect(fixture.readEventTypes().slice(0, 3)).toEqual([
      "run.queued",
      "queue_item.created",
      "user.message",
    ]);
    const message = fixture.engine.database.reader
      .prepare<
        [],
        { payload: string; correlation_id: string }
      >("SELECT payload, correlation_id FROM session_events WHERE type = 'user.message'")
      .get();
    expect(message?.correlation_id).toBe(sent.queueItemId);
    expect(JSON.parse(message?.payload ?? "{}")).toMatchObject({
      queueItemId: sent.queueItemId,
      runId: item?.targetRunId,
      message: "Add the retry",
    });
    expect(countRows("SELECT COUNT(*) AS count FROM runs")).toBe(1);
    await waitForOpening(fixture, sent);
  });

  // Mutation: dropping the read of the saved send makes the retry's insert meet the spent key, and
  // the retry throws instead of answering what was saved.
  it("answers a retried send with what the first saved, writing nothing more", async () => {
    fixture = await openRunQueueFixture({ driverName: "codex" });
    const key = randomUUID();

    const first = await fixture.send("Add the retry", key);
    await waitForOpening(fixture, first);
    const retried = await fixture.send("Add the retry", key);

    // The retry answers the saved message as it stands now, taken by the run it started.
    expect(retried).toEqual({ ...first, state: "admitted" });
    expect(countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(1);
    expect(countRows("SELECT COUNT(*) AS count FROM runs")).toBe(1);
    expect(fixture.readEventTypes().filter((type) => type === "user.message")).toHaveLength(1);
  });

  // Mutations: keeping the client's picks unresolved, or matching them by name alone, writes the
  // send whose folder Codex never listed.
  it("refuses a skill Codex does not list, and hands Codex the file it listed for the pick", async () => {
    fixture = await openRunQueueFixture({ driverName: "codex" });
    fixture.skillFiles = [
      { name: "deploy", path: "/home/person/.codex/skills/deploy/SKILL.md" },
      { name: "deploy", path: "/work/app/.codex/skills/deploy/SKILL.md" },
    ];

    const refused: unknown = await fixture
      .send("Ship it", undefined, [{ name: "deploy", folderPath: "/tmp/planted/deploy" }])
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: SKILL_PATH_REFUSED_CODE,
      detail: { path: "/tmp/planted/deploy", reason: "not_listed" },
    });
    expect(countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(0);
    expect(fixture.readEventTypes()).toEqual([]);

    const sent = await fixture.send("Ship it", undefined, [
      { name: "deploy", folderPath: "/work/app/.codex/skills/deploy/" },
    ]);
    await waitForOpening(fixture, sent);
    expect(fixture.startedRuns[0]?.agentConfig["skills"]).toStrictEqual([
      { name: "deploy", path: "/work/app/.codex/skills/deploy/SKILL.md" },
    ]);
  });

  // Mutation: opening the provider session ahead of the run's start opens it before the setup gates
  // have made the session's working folder.
  it("opens the session's provider session only once the run's setup gates have passed", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    queueFixture.engine.engine.registerSetupGate({
      assertRunReady: () => {
        queueFixture.startSteps.push("gates");
        return Promise.resolve();
      },
    });

    await waitForOpening(queueFixture, await queueFixture.send("Add the retry"));

    expect(queueFixture.startSteps).toEqual(["gates", "open"]);
  });

  // Mutations: reading Codex's skills without waiting at the gate starts the account's service
  // while the gate holds every start; waiting with no deadline leaves the send hanging for good.
  it("waits at the memory gate, within the delivery timeout, before a skill read that starts Codex's service", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
      deliveryTimeoutMs: 50,
    });
    fixture = queueFixture;
    queueFixture.startsCodexAccountService = true;
    queueFixture.skillFiles = [{ name: "deploy", path: "/work/app/.codex/skills/deploy/SKILL.md" }];
    const pick = [{ name: "deploy", folderPath: "/work/app/.codex/skills/deploy" }];
    // Admitted first, so the read behind it waits for memory that never frees.
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });

    const refused: unknown = await queueFixture
      .send("Ship it", undefined, pick)
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: "driver.timeout" });
    expect(queueFixture.skillReads).toBe(0);
    expect(countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(0);
    expect(queueFixture.readEventTypes()).toEqual([]);

    blocker.release();
    await waitForOpening(queueFixture, await queueFixture.send("Ship it", undefined, pick));
    expect(queueFixture.skillReads).toBe(1);
  });

  // Mutation: resolving the picks under the session's lock holds the lock the run ahead at the gate
  // needs to start, and neither send ever settles.
  it("resolves a skill pick behind a run waiting at the gate without holding the session", async () => {
    const queueFixture = await openRunQueueFixture({
      driverName: "codex",
      availableMemoryBytes: 0,
    });
    fixture = queueFixture;
    queueFixture.startsCodexAccountService = true;
    queueFixture.skillFiles = [{ name: "deploy", path: "/work/app/.codex/skills/deploy/SKILL.md" }];
    // The first run's start brings the account's service up.
    queueFixture.engine.engine.registerSetupGate({
      assertRunReady: () => {
        queueFixture.startsCodexAccountService = false;
        return Promise.resolve();
      },
    });
    const blocker = queueFixture.memoryGate.enqueue({ kind: "provider", provider: "claude" });
    const first = await queueFixture.send("Add the retry");
    const sending = queueFixture.send("Ship it", undefined, [
      { name: "deploy", folderPath: "/work/app/.codex/skills/deploy" },
    ]);

    blocker.release();
    const sent = await sending;

    await waitForOpening(queueFixture, first);
    const [firstRunId] = queueFixture.startedRunIds();
    expect(queueFixture.startedRunIds()).toHaveLength(1);
    expect(queueFixture.readItem(sent.queueItemId)).toMatchObject({
      state: "queued",
      targetRunId: firstRunId,
      body: { skills: [{ name: "deploy", path: "/work/app/.codex/skills/deploy/SKILL.md" }] },
    });
    expect(queueFixture.skillReads).toBe(1);
  });

  // Mutation: awaiting each steer before handing the next leaves the later two unhanded while the
  // first is unanswered; handing them in reverse fails the order.
  it("holds Codex's messages and hands them all at once, in send order, at a tool boundary", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const held: QueueItemCreateResponse[] = [];
    for (const content of ["Then the tests", "Then the docs", "Then the changelog"]) {
      held.push(await queueFixture.send(content));
    }
    expect(queueFixture.steers).toEqual([]);
    const answers: PromiseWithResolvers<DriverInterventionResult>[] = [];
    queueFixture.answerSteer = () => {
      const answer = Promise.withResolvers<DriverInterventionResult>();
      answers.push(answer);
      return answer.promise;
    };

    queueFixture.queue.delivery.onToolBoundary({ sessionId: queueFixture.engine.sessionId, runId });

    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(3);
    });
    expect(queueFixture.steers.map((steer) => steer.clientIdempotencyKey)).toEqual(
      held.map((item) => item.queueItemId),
    );
    expect(
      queueFixture.steers.map((steer) => (steer.type === "steer" ? steer.payload.content : "")),
    ).toEqual(["Then the tests", "Then the docs", "Then the changelog"]);
    for (const item of held) {
      expect(queueFixture.readItem(item.queueItemId)?.state).toBe("queued");
    }
    for (const answer of answers) {
      answer.resolve({ status: "applied" });
    }
    await vi.waitFor(() => {
      for (const item of held) {
        expect(queueFixture.readItem(item.queueItemId)?.state).toBe("admitted");
      }
    });
  });

  // Mutation: leaving a run's waiting messages where they are at its end never starts the next run.
  it("makes the messages a turn ended without taking the next run's, the first its opening", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const firstRunId = await startFirstRun(queueFixture, "Add the retry");
    const next = await queueFixture.send("Then the tests");
    const after = await queueFixture.send("Then the docs");

    await queueFixture.engine.engine.transition({
      runId: firstRunId,
      newState: "completed",
      completionKind: "turn",
    });

    await waitForOpening(queueFixture, next);
    const [, secondRun] = queueFixture.startedRuns;
    expect(secondRun?.runId).not.toBe(firstRunId);
    expect(secondRun?.agentConfig).toMatchObject({
      input: "Then the tests",
      clientUserMessageId: next.queueItemId,
    });
    expect(queueFixture.readItem(after.queueItemId)).toMatchObject({
      state: "queued",
      targetRunId: secondRun?.runId,
    });
    expect(queueFixture.steers).toEqual([]);
  });

  // Mutation: a recovery that reads no session leaves the message waiting for a run that ended.
  it("makes what waited for a run that ended unseen the next run, when the record is read again", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const firstRunId = await startFirstRun(queueFixture, "Add the retry");
    // The queue misses the run's end, as across a restart.
    queueFixture.stopFollowing();
    const next = await queueFixture.send("Then the tests");
    await queueFixture.engine.engine.transition({
      runId: firstRunId,
      newState: "completed",
      completionKind: "turn",
    });

    await queueFixture.queue.recover();

    await waitForOpening(queueFixture, next);
    const [, secondRun] = queueFixture.startedRuns;
    expect(secondRun?.runId).not.toBe(firstRunId);
    expect(secondRun?.agentConfig).toMatchObject({
      input: "Then the tests",
      clientUserMessageId: next.queueItemId,
    });
  });

  // Mutations: admitting what Claude Code was handed at its run's end reads the kept message
  // admitted before Claude Code takes it; moving it with the run's other waiting messages makes it
  // the next run's opening, sent a second time.
  it("leaves a message Claude Code kept past its run's end queued until its replay admits it", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const kept = await queueFixture.send("Cover the timeout too");
    await vi.waitFor(() => {
      expect(queueFixture.steers.map((steer) => steer.clientIdempotencyKey)).toEqual([
        kept.queueItemId,
      ]);
    });

    await queueFixture.engine.engine.transition({
      runId,
      newState: "completed",
      completionKind: "turn",
    });
    await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);
    await queueFixture.queue.delivery.settle(queueFixture.engine.sessionId);

    expect(queueFixture.readItem(kept.queueItemId)).toMatchObject({ state: "queued" });
    expect(queueFixture.startedRuns).toHaveLength(1);
    expect(queueFixture.readEventTypes().filter((type) => type === "run.queued")).toHaveLength(1);

    queueFixture.queue.delivery.messageTaken(
      queueFixture.engine.sessionId,
      kept.queueItemId,
      runId,
    );
    await vi.waitFor(() => {
      expect(queueFixture.readItem(kept.queueItemId)?.state).toBe("admitted");
    });
  });

  // Mutation: keeping a handed message past its run's end whatever became of the process it went
  // to leaves it waiting for a turn no process will start, never sent again.
  it("makes a message the next run's opening when the Claude Code process it went to is gone", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const lost = await queueFixture.send("Cover the timeout too");
    await vi.waitFor(() => {
      expect(queueFixture.steers.map((steer) => steer.clientIdempotencyKey)).toEqual([
        lost.queueItemId,
      ]);
    });

    // The process exited and the session was started again in a new one.
    queueFixture.providerProcessId = 5151;
    await queueFixture.engine.engine.transition({
      runId,
      newState: "completed",
      completionKind: "turn",
    });

    await waitForOpening(queueFixture, lost);
    const [, nextRunId] = queueFixture.startedRunIds();
    expect(nextRunId).not.toBe(runId);
    expect(queueFixture.readItem(lost.queueItemId)?.targetRunId).toBe(nextRunId);
  });

  // Mutation: admitting only a message still handed leaves one Claude Code took after its
  // withdraw failed reading not delivered.
  it("admits a message read not delivered once Claude Code shows it took it after all", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const handed = await queueFixture.send("Cover the timeout too");
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(1);
    });
    queueFixture.answerWithdraw = () => Promise.reject(new Error("the process stopped answering"));

    const refused: unknown = await queueFixture.queue
      .cancel({ queueItemId: handed.queueItemId })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: QUEUE_CHANGE_REFUSED_CODE });
    expect(queueFixture.readItem(handed.queueItemId)).toMatchObject({
      state: "not_delivered",
      notDeliveredReason: "failed",
    });
    expect(queueFixture.serviceLog).toEqual([
      expect.stringContaining(`the withdraw of message ${handed.queueItemId} failed`),
    ]);
    queueFixture.serviceLog.length = 0;

    queueFixture.queue.delivery.messageTaken(
      queueFixture.engine.sessionId,
      handed.queueItemId,
      runId,
    );

    await vi.waitFor(() => {
      expect(queueFixture.readItem(handed.queueItemId)).toMatchObject({ state: "admitted" });
    });
    expect(queueFixture.readItem(handed.queueItemId)?.notDeliveredReason).toBeUndefined();
    expect(queueFixture.readEventTypes().at(-1)).toBe("queue_item.admitted");
  });

  // Mutation: letting both the early read and the write's own guard pass a closed session queues a
  // message no run will ever take.
  it("refuses a send to a closed session, writing nothing", async () => {
    fixture = await openRunQueueFixture({ driverName: "codex" });
    await fixture.engine.database.writer.write([
      {
        sql: "UPDATE sessions SET state = 'closed' WHERE id = ?",
        bindings: [fixture.engine.sessionId],
      },
    ]);

    const refused: unknown = await fixture.send("Add the retry").catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: SESSION_ALREADY_CLOSED_CODE });
    expect(countRows("SELECT COUNT(*) AS count FROM queue_items")).toBe(0);
    expect(fixture.readEventTypes()).toEqual([]);
  });

  // Mutation: reading a live run again without handing it what waits leaves a message sent while
  // the queue missed the run's return to work waiting for good.
  it("hands a live run what waits for it, when the record is read again", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "claude" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    queueFixture.stopFollowing();
    for (const newState of ["pausing", "paused"] as const) {
      await queueFixture.engine.engine.transition({ runId, newState });
    }
    // A paused run is handed nothing; the queue misses its return to work.
    await queueFixture.send("Cover the timeout too");
    await queueFixture.engine.engine.transition({ runId, newState: "running" });
    expect(queueFixture.steers).toEqual([]);

    await queueFixture.queue.lifecycle.reconcile(queueFixture.engine.sessionId);

    await vi.waitFor(() => {
      expect(
        queueFixture.steers.map((steer) => (steer.type === "steer" ? steer.payload.content : "")),
      ).toEqual(["Cover the timeout too"]);
    });
  });

  // Mutation: settling a steer whose turn ended before it was sent as a failed hand reads the
  // message not delivered, though the next run takes it.
  it("leaves a message whose Codex turn ended before its steer for the next run", async () => {
    const queueFixture = await openRunQueueFixture({ driverName: "codex" });
    fixture = queueFixture;
    const runId = await startFirstRun(queueFixture, "Add the retry");
    const left = await queueFixture.send("Then the tests");
    queueFixture.answerSteer = () => Promise.reject(new SteerTurnEndedError(runId));

    queueFixture.queue.delivery.onToolBoundary({ sessionId: queueFixture.engine.sessionId, runId });
    await vi.waitFor(() => {
      expect(queueFixture.steers).toHaveLength(1);
    });
    await queueFixture.queue.delivery.settle(queueFixture.engine.sessionId);
    expect(queueFixture.readItem(left.queueItemId)?.state).toBe("queued");

    await queueFixture.engine.engine.transition({
      runId,
      newState: "completed",
      completionKind: "turn",
    });

    await waitForOpening(queueFixture, left);
    expect(queueFixture.readItem(left.queueItemId)?.targetRunId).not.toBe(runId);
  });
});
