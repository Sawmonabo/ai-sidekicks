// A restart's recovery pass over a real database. A run the restart left running ends failed and
// needing recovery, a run whose interrupt was accepted ends interrupted with the interrupt applied,
// and a pass with nothing damaged records its counts as succeeded. A session whose history cannot
// be rebuilt whole is copied aside, once for the same damage across restarts, and opens at its
// last good point, read no further, its damaged events kept in place and its runs left as they
// are, while every other session takes its writes; `Continue from here` skips the damaged events,
// settles the run the restart left live past every version the skipped rows hold, and the session
// takes new work; a session with no readable event can only be deleted. While the pass runs, every
// mutating call but the restart is refused.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event/envelope";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { NodeIdSchema } from "@ai-sidekicks/contracts/runtime-node/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { EventLogService } from "../../events/log-service.js";
import { SessionEventAppender } from "../../events/session/appender.js";
import { SessionPurge } from "../../events/session/purge.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { KeyedLock } from "../../keyed-lock.js";
import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { insertQueuedRunStatement, RUNS_PROJECTION } from "../../session/run/projection.js";
import { SessionService } from "../../session/service.js";
import { DamagedHistory } from "../damaged-history.js";
import { ProjectionRebuildService, REBUILD_PAGE_SIZE } from "../projection-rebuild.js";
import { refuseEventOfDamagedSession } from "../session-write-refusal.js";
import { StartupRecovery } from "../startup.js";
import { RecoveryStatusTracker } from "../status.js";
import { RecoveryWriteGate } from "../write-gate.js";

const OCCURRED_AT = "2026-10-07T12:00:00.000Z";
// The agent every queued run is created for.
const QUEUED_AGENT_ID = randomUUID();

describe("the recovery pass at a restart", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function acceptInterrupt(runId: RunId): Promise<string> {
    const interventionId = randomUUID();
    await fixture.database.writer.write([
      {
        sql: `INSERT INTO interventions
                (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
                 created_at)
              VALUES (?, ?, 'interrupt', 'accepted', 2, ?, ?)`,
        bindings: [interventionId, runId, randomUUID(), new Date().toISOString()],
      },
    ]);
    return interventionId;
  }

  // Writes `rows` as a session's log from sequence 0, each payload stored as given.
  async function writeLog(
    sessionId: SessionId,
    rows: readonly { type: string; payload: string }[],
  ): Promise<void> {
    await fixture.database.writer.write(
      rows.map((row, sequence) => ({
        sql: `INSERT INTO session_events
                (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
              VALUES (?, ?, ?, ?, 0, 'run_lifecycle', ?, ?)`,
        bindings: [randomUUID(), sessionId, sequence, OCCURRED_AT, row.type, row.payload],
      })),
    );
  }

  function runEvents(sessionId: SessionId, runId: RunId): { type: string; payload: string }[] {
    const change = (runVersion: number, previousState: string, newState: string) => ({
      type: `run.${newState}`,
      payload: JSON.stringify({ sessionId, runId, runVersion, previousState, newState }),
    });
    return [
      {
        type: "run.queued",
        payload: JSON.stringify({
          sessionId,
          runId,
          runVersion: 0,
          newState: "queued",
          agentId: QUEUED_AGENT_ID,
        }),
      },
      change(1, "queued", "starting"),
      change(2, "starting", "running"),
    ];
  }

  // A session whose log holds a running run and queued runs filling the rebuild's first page, then
  // on the next page a run's start with no queued run before it, which no live write would have
  // written, so its rows cannot be rebuilt past the first page.
  async function writeUnfoldableSession(): Promise<{ sessionId: SessionId; liveRunId: RunId }> {
    const sessionId = SessionIdSchema.parse(randomUUID());
    const liveRunId = RunIdSchema.parse(randomUUID());
    const rows = runEvents(sessionId, liveRunId);
    while (rows.length < REBUILD_PAGE_SIZE) {
      const runId = RunIdSchema.parse(randomUUID());
      rows.push({
        type: "run.queued",
        payload: JSON.stringify({
          sessionId,
          runId,
          runVersion: 0,
          newState: "queued",
          agentId: QUEUED_AGENT_ID,
        }),
      });
    }
    const unqueuedRunId = RunIdSchema.parse(randomUUID());
    rows.push({
      type: "run.starting",
      payload: JSON.stringify({
        sessionId,
        runId: unqueuedRunId,
        runVersion: 1,
        previousState: "queued",
        newState: "starting",
      }),
    });
    await writeLog(sessionId, rows);
    return { sessionId, liveRunId };
  }

  // A session whose running run's fourth row is not JSON, with the run's end stored after it.
  async function writeSessionWithUnreadableRow(): Promise<{ sessionId: SessionId; runId: RunId }> {
    const sessionId = SessionIdSchema.parse(randomUUID());
    const runId = RunIdSchema.parse(randomUUID());
    await writeLog(sessionId, [
      ...runEvents(sessionId, runId),
      { type: "run.running", payload: "{not json" },
      {
        type: "run.completed",
        payload: JSON.stringify({
          sessionId,
          runId,
          runVersion: 3,
          previousState: "running",
          newState: "completed",
        }),
      },
    ]);
    return { sessionId, runId };
  }

  interface PassParts {
    readonly status: RecoveryStatusTracker;
    readonly damagedHistory: DamagedHistory;
    /** The event log every write of the daemon goes through, refusing a damaged session's. */
    readonly sessionEvents: EventLogService;
    readonly pass: StartupRecovery;
  }

  // The copies taken aside, kept across the restarts of one test as the data folder keeps them.
  interface AsideCopies {
    count: number;
    readonly sessions: Set<string>;
  }

  // The pass as the daemon builds it, with the sessions it rebuilds pushed onto `rebuiltSessions`.
  function buildPass(
    rebuiltSessions: SessionId[] = [],
    asideCopies: AsideCopies = { count: 0, sessions: new Set() },
  ): PassParts {
    const { reader, writer } = fixture.database;
    const status = new RecoveryStatusTracker();
    const sessionEvents = new EventLogService({
      writer,
      reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
      refuseSessionWrite: (sessionId, eventType) => {
        refuseEventOfDamagedSession(status, sessionId, eventType);
      },
    });
    const projectionRebuild = new ProjectionRebuildService({
      reader,
      writer,
      sessionEvents: new SessionService(reader),
      projections: [RUNS_PROJECTION],
    });
    const nodeId = NodeIdSchema.parse(randomUUID());
    const damagedHistory = new DamagedHistory({
      reader,
      sessionEvents: new SessionService(reader),
      eventLog: sessionEvents,
      projectionRebuild,
      // The purge's folder removal, list refresh and re-scoring have nothing to act on here.
      purge: new SessionPurge({
        writer,
        nodeId,
        eventLog: sessionEvents,
        managedWorkspaces: { deleteFolder: () => Promise.resolve() },
        sessionLock: new KeyedLock<SessionId>(),
        sessionList: { refresh: () => {} },
        relatedRanking: { rescoreAround: () => {} },
      }),
      runs: fixture.runs,
      runEngine: fixture.restartEngine(),
      status,
    });
    const pass = new StartupRecovery({
      nodeId,
      reader,
      sessionEvents,
      projectionRebuild: {
        listSessionsToRebuild: () => projectionRebuild.listSessionsToRebuild(),
        rebuild: (request) => {
          rebuiltSessions.push(request.sessionId);
          return projectionRebuild.rebuild(request);
        },
      },
      damagedHistory,
      storeAside: {
        copy: () => {
          asideCopies.count += 1;
          return Promise.resolve(`/aside/${String(asideCopies.count)}`);
        },
        findCopyOfSession: (sessionId, headSequence) =>
          Promise.resolve(
            asideCopies.sessions.has(`${sessionId} ${String(headSequence)}`) ? "/aside" : undefined,
          ),
        recordSession: (_folder, sessionId, headSequence) => {
          asideCopies.sessions.add(`${sessionId} ${String(headSequence)}`);
          return Promise.resolve();
        },
      },
      runs: fixture.runs,
      runEngine: fixture.restartEngine(),
      status,
      now: () => new Date(OCCURRED_AT),
      writeServiceLog: () => {},
    });
    return { status, damagedHistory, sessionEvents, pass };
  }

  function readRecoveryEvents(): { type: string; payload: Record<string, unknown> }[] {
    return fixture.database.reader
      .prepare<[string], { type: string; payload: string }>(
        "SELECT type, payload FROM session_events WHERE session_id = ? ORDER BY sequence",
      )
      .all(DAEMON_SCOPE_SENTINEL_SESSION_ID)
      .map((row) => ({
        type: row.type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }));
  }

  function countStoredRows(sessionId: SessionId): number {
    return (
      fixture.database.reader
        .prepare<
          [SessionId],
          { count: number }
        >("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?")
        .get(sessionId)?.count ?? 0
    );
  }

  // Queues a run in `sessionId` through `sessionEvents`, as admission does.
  async function queueRunThrough(
    sessionEvents: EventLogService,
    sessionId: SessionId,
  ): Promise<RunId> {
    const runId = RunIdSchema.parse(randomUUID());
    const payload = { sessionId, runId, runVersion: 0, newState: "queued" as const };
    await new SessionEventAppender(
      { sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    ).append("run.queued", payload, { transactionalPrelude: [insertQueuedRunStatement(payload)] });
    return runId;
  }

  it("ends each live run and records the pass's counts as succeeded", async () => {
    const crashed = await fixture.runThrough(["starting", "running"]);
    const stopped = await fixture.runThrough(["starting", "running"]);
    const interventionId = await acceptInterrupt(stopped);
    const queued = await fixture.queueRun();
    // Every session is rebuilt, as on a store whose projection cursors are gone.
    await fixture.database.writer.write([{ sql: "DELETE FROM projection_cursors" }]);
    const { status, pass } = buildPass();

    await pass.run();

    expect(fixture.readRunEvents(crashed).at(-1)).toMatchObject({
      type: "run.failed",
      payload: { failureCategory: "provider failure", recoveryCondition: "recovery-needed" },
    });
    expect(fixture.readRunEvents(stopped).at(-1)?.type).toBe("run.interrupted");
    expect(
      fixture.database.reader
        .prepare("SELECT state FROM interventions WHERE id = ?")
        .get(interventionId),
    ).toStrictEqual({ state: "applied" });
    expect(fixture.runs.getRun(queued)?.state).toBe("queued");
    expect(status.read()).toStrictEqual({ overall: "healthy", sessions: [] });
    // Two runs of three events each and one queued run: seven events rebuilt, two runs settled.
    expect(readRecoveryEvents()).toMatchObject([
      { type: "recovery.attempted", payload: { attemptNumber: 1, priorFailureCount: 0 } },
      {
        type: "recovery.succeeded",
        payload: {
          attemptNumber: 1,
          phase: "run_resumption",
          eventsApplied: 7,
          bindingsRestored: 0,
          runsResumed: 0,
          runsFailedDeterministically: 1,
          runsHaltedForReconciliation: 0,
          runsInterrupted: 1,
          completedAt: OCCURRED_AT,
        },
      },
    ]);
  });

  it("opens a session it cannot rebuild at its last good point and keeps its damaged events", async () => {
    const unfoldable = await writeUnfoldableSession();
    const asideCopies: AsideCopies = { count: 0, sessions: new Set() };
    const { status, pass } = buildPass([], asideCopies);

    await pass.run();

    expect(asideCopies.count).toBe(1);
    expect(status.read()).toStrictEqual({
      overall: "degraded",
      sessions: [
        {
          sessionId: unfoldable.sessionId,
          state: "degraded",
          failureCategory: "projection failure",
          lastAppliedSequence: REBUILD_PAGE_SIZE - 1,
          lastAppliedAt: OCCURRED_AT,
          damagedFromSequence: REBUILD_PAGE_SIZE,
        },
      ],
    });
    // The rows reflect every event before the damaged one, and the damaged one is still stored.
    expect(fixture.runs.getRun(unfoldable.liveRunId)?.state).toBe("running");
    expect(countStoredRows(unfoldable.sessionId)).toBe(REBUILD_PAGE_SIZE + 1);
    expect(
      fixture.database.reader
        .prepare("SELECT last_sequence FROM projection_cursors WHERE session_id = ?")
        .get(unfoldable.sessionId),
    ).toStrictEqual({ last_sequence: REBUILD_PAGE_SIZE - 1 });

    // A restart heals it again first with no second copy of the same damage, and rebuilds no
    // other session.
    const rebuiltOnRestart: SessionId[] = [];
    await buildPass(rebuiltOnRestart, asideCopies).pass.run();

    expect(new Set(rebuiltOnRestart)).toStrictEqual(new Set([unfoldable.sessionId]));
    expect(asideCopies.count).toBe(1);
    expect(readRecoveryEvents()).toMatchObject([
      { type: "recovery.attempted", payload: { attemptNumber: 1, priorFailureCount: 0 } },
      {
        type: "recovery.failed",
        payload: {
          attemptNumber: 1,
          phase: "projection_rebuild",
          failureKind: "projection_rebuild_failed",
        },
      },
      { type: "recovery.attempted", payload: { attemptNumber: 2, priorFailureCount: 1 } },
      { type: "recovery.failed", payload: { attemptNumber: 2 } },
    ]);
  });

  it("refuses the damaged session's writes and takes every other session's", async () => {
    const unfoldable = await writeUnfoldableSession();
    const { status, sessionEvents, pass } = buildPass();
    const registry = new RecoveryWriteGate(status).wrap(new MethodRegistryImpl());
    const sessionTarget = z.object({ sessionId: z.string() }).strict();
    for (const method of ["session.rename", "daemon.restart"]) {
      registry.register(
        method,
        sessionTarget.partial(),
        sessionTarget.partial(),
        () => Promise.resolve({}),
        { mutating: true },
      );
    }

    // While the pass runs nothing is admitted but the restart.
    await expect(
      registry.dispatch("session.rename", { sessionId: fixture.sessionId }, {}),
    ).rejects.toMatchObject({ code: "daemon.write_refused", detail: { recovery: "rebuilding" } });
    await expect(registry.dispatch("daemon.restart", {}, {})).resolves.toStrictEqual({});

    await pass.run();

    await expect(
      registry.dispatch("session.rename", { sessionId: fixture.sessionId }, {}),
    ).resolves.toStrictEqual({});
    await expect(
      registry.dispatch("session.rename", { sessionId: unfoldable.sessionId }, {}),
    ).rejects.toMatchObject({
      code: "session.write_refused",
      detail: { sessionId: unfoldable.sessionId, recovery: "degraded" },
    });
    // The same session spelled in capitals meets the same refusal.
    await expect(
      registry.dispatch("session.rename", { sessionId: unfoldable.sessionId.toUpperCase() }, {}),
    ).rejects.toMatchObject({ code: "session.write_refused" });
    // Whoever writes, the append itself refuses the damaged session and takes the other.
    const queued = await queueRunThrough(sessionEvents, fixture.sessionId);
    expect(fixture.runs.getRun(queued)?.state).toBe("queued");
    await expect(queueRunThrough(sessionEvents, unfoldable.sessionId)).rejects.toMatchObject({
      code: "session.write_refused",
    });
    expect(countStoredRows(unfoldable.sessionId)).toBe(REBUILD_PAGE_SIZE + 1);
  });

  it("continues a damaged session from its last good point, and it takes new work", async () => {
    const { sessionId, runId } = await writeSessionWithUnreadableRow();
    const { status, damagedHistory, sessionEvents, pass } = buildPass();
    await pass.run();
    expect(status.read().sessions).toMatchObject([
      { sessionId, state: "degraded", lastAppliedSequence: 2, damagedFromSequence: 3 },
    ]);
    // Until it is continued, a read of the session stops at its last good point.
    const boundedReads = new SessionService(fixture.database.reader, (id) =>
      status.readDamagedFromSequence(id),
    );
    expect(boundedReads.readEvents(sessionId).map((event) => event.sequence)).toStrictEqual([
      0, 1, 2,
    ]);

    await damagedHistory.continueFromLastGoodPoint(sessionId);

    expect(status.read()).toStrictEqual({ overall: "healthy", sessions: [] });
    // The run the restart left live ends past the version its skipped end holds.
    expect(fixture.runs.getRun(runId)).toMatchObject({ state: "failed", version: 4 });
    const queued = await queueRunThrough(sessionEvents, sessionId);
    expect(fixture.runs.getRun(queued)?.state).toBe("queued");
    // The damaged rows stay stored, every read skips them, and a restart rebuilds past them.
    expect(countStoredRows(sessionId)).toBe(8);
    expect(
      boundedReads.readEvents(sessionId).map((event) => [event.sequence, event.type]),
    ).toStrictEqual([
      [0, "run.queued"],
      [1, "run.starting"],
      [2, "run.running"],
      [5, "recovery.damaged_events_skipped"],
      [6, "run.failed"],
      [7, "run.queued"],
    ]);
    const restarted = buildPass();
    await fixture.database.writer.write([{ sql: "DELETE FROM projection_cursors" }]);
    await restarted.pass.run();
    expect(restarted.status.read()).toStrictEqual({ overall: "healthy", sessions: [] });
    await expect(damagedHistory.continueFromLastGoodPoint(sessionId)).rejects.toMatchObject({
      code: "session.recovery_refused",
      detail: { sessionId, reason: "not_damaged" },
    });
  });

  it("offers a session with no readable event only its deletion", async () => {
    const sessionId = SessionIdSchema.parse(randomUUID());
    const runId = RunIdSchema.parse(randomUUID());
    await writeLog(sessionId, [
      { type: "run.queued", payload: "[]" },
      ...runEvents(sessionId, runId).slice(1),
    ]);
    const { status, damagedHistory, pass } = buildPass();
    await pass.run();
    expect(status.read()).toStrictEqual({
      overall: "degraded",
      sessions: [{ sessionId, state: "damaged", failureCategory: "projection failure" }],
    });

    await expect(damagedHistory.continueFromLastGoodPoint(sessionId)).rejects.toMatchObject({
      code: "session.recovery_refused",
      detail: { sessionId, reason: "no_readable_event" },
    });
    await damagedHistory.deleteSession(sessionId);

    expect(status.read()).toStrictEqual({ overall: "healthy", sessions: [] });
    expect(countStoredRows(sessionId)).toBe(0);
  });
});
