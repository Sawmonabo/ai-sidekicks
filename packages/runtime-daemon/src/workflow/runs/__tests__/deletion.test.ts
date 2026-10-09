// Deleting runs removes stored history for good: a delete must refuse a run still going or parked
// on its failed step, and a chain's first run while a later run of the chain is going, without
// touching a row or the log; leave nothing of a run it deletes while answering the git folder its
// snapshot refs live in, and append the one deleted event a rebuild of the runs from the log needs
// to leave it out; and in bulk remove exactly what its preview counted while sparing kept, waiting
// and parked runs, even a run kept after the delete read it, without losing the runs written beside
// it, each run's event in its own session, and a failed write reported only once every other write
// has settled.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import { WORKFLOW_RUN_NOT_DELETABLE_CODE } from "@ai-sidekicks/contracts/workflow/run/records";
import type { WorkflowRunStatus } from "@ai-sidekicks/contracts/workflow/run/status";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import type { SessionEventLog } from "../../../events/session/appender.js";
import {
  createFixtureRun,
  FIXTURE_SESSION_ID,
  insertExecutionContextCheckout,
  insertFixtureFormDraft,
  insertFixtureStep,
  insertWorkflowVersion,
  readRunRows,
  setFixtureRunStatus,
  type FixtureStep,
} from "../__fixtures__/rows.js";
import type { WorkflowRunExecutionContext } from "../creation.js";
import { WorkflowRunDeletion, WorkflowRunsDeleteIncompleteError } from "../deletion.js";

const OLD_START = "2026-10-01T00:00:00.000Z";
const OLD_FINISH = "2026-10-01T00:05:00.000Z";
const RECENT_START = "2026-10-06T00:00:00.000Z";
const RECENT_FINISH = "2026-10-06T00:05:00.000Z";
const CUTOFF = "2026-10-05T00:00:00.000Z";
const NO_ROWS = { run: [], steps: [], formDrafts: [], executionContext: [] };
// A second session, ordered after the fixture session, so bulk delete writes its runs apart.
const OTHER_SESSION_ID = "00000000-0000-7000-8000-000000000002" as SessionId;

let database: ScratchDatabase;
let deletion: WorkflowRunDeletion;
let versionId: string;
let checkout: WorkflowRunExecutionContext;

// The daemon's event log over the scratch database, which logs nothing in these tests.
function eventLogOver(scratch: ScratchDatabase): EventLogService {
  return new EventLogService({
    writer: scratch.writer,
    reader: scratch.reader,
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
  });
}

beforeEach(async () => {
  database = await openScratchDatabase();
  // A run's gate answers reference the approval requests table, which the daemon schema does not
  // hold; with foreign keys on, any delete from the answers needs that table to exist.
  await database.writer.write([
    { sql: "CREATE TABLE approval_requests (id TEXT PRIMARY KEY) STRICT" },
  ]);
  deletion = new WorkflowRunDeletion(database, eventLogOver(database));
  versionId = await insertWorkflowVersion(database.writer, "Nightly review");
  checkout = await insertExecutionContextCheckout(database.writer);
});

afterEach(async () => {
  await database.close();
});

// A run with an execution context, one step and a form draft, at `status`, in the fixture session
// unless another is named; a run that joins a chain names the chain's first run.
async function storeRun(
  status: WorkflowRunStatus,
  startedAt: string,
  finishedAt: string | null,
  step: FixtureStep,
  chainRootRunId?: WorkflowRunId,
  sessionId: SessionId = FIXTURE_SESSION_ID,
): Promise<WorkflowRunId> {
  const workflowRunId = await createFixtureRun(database.writer, versionId, {
    sessionId,
    startedAt,
    executionContext: checkout,
    chain:
      chainRootRunId === undefined
        ? { kind: "starts" }
        : { kind: "joins", chainRootRunId, isFromError: false },
  });
  await setFixtureRunStatus(database.writer, workflowRunId, status, finishedAt);
  await insertFixtureStep(database.writer, workflowRunId, step);
  await insertFixtureFormDraft(database.writer, workflowRunId);
  return workflowRunId;
}

interface DeletedEvent {
  readonly appendedTo: string;
  readonly payload: Record<string, string>;
}

// Each `workflow.run_deleted` in the log: the session it was appended to and its payload, in the
// order of the runs it names.
function readDeletedEvents(): DeletedEvent[] {
  return database.reader
    .prepare<[], { session_id: string; payload: string }>(
      `SELECT session_id, payload FROM session_events WHERE type = 'workflow.run_deleted'
       ORDER BY json_extract(payload, '$.workflowRunId')`,
    )
    .all()
    .map((row) => ({
      appendedTo: row.session_id,
      payload: JSON.parse(row.payload) as Record<string, string>,
    }));
}

// The event a delete of `workflowRunId`, a run of the fixture version in `sessionId`, appends.
function deletedEventOf(
  workflowRunId: WorkflowRunId,
  sessionId: SessionId = FIXTURE_SESSION_ID,
): DeletedEvent {
  const version = database.reader
    .prepare<
      [string],
      { definition_id: string }
    >("SELECT definition_id FROM workflow_versions WHERE id = ?")
    .get(versionId);
  return {
    appendedTo: sessionId,
    payload: {
      sessionId,
      workflowRunId,
      definitionId: version?.definition_id ?? "",
      workflowVersionId: versionId,
    },
  };
}

const SETTLED_STEP: FixtureStep = { executionIndex: 0, status: "succeeded" };
const WAITING_STEP: FixtureStep = { executionIndex: 0, status: "waiting", waitCause: "approval" };
const FAILED_STEP: FixtureStep = { executionIndex: 0, status: "failed" };

describe("deleting one run", () => {
  it("refuses a going or parked run or its chain's first run and empties an ended one", async () => {
    const chainRootRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const runningRunId = await storeRun(
      "running",
      OLD_START,
      null,
      { executionIndex: 0, status: "running" },
      chainRootRunId,
    );
    const waitingRunId = await storeRun("waiting", OLD_START, null, WAITING_STEP);
    const parkedRunId = await storeRun("failed", OLD_START, null, FAILED_STEP);
    const finishedRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const refusedRows = [
      { workflowRunId: chainRootRunId, why: "A later run of its chain is still going." },
      { workflowRunId: runningRunId, why: "The run is running." },
      { workflowRunId: waitingRunId, why: "The run is waiting." },
      { workflowRunId: parkedRunId, why: "The run is parked on its failed step." },
    ].map((refused) => ({ ...refused, rows: readRunRows(database.reader, refused.workflowRunId) }));

    for (const { workflowRunId, why } of refusedRows) {
      await expect(deletion.delete(workflowRunId)).rejects.toMatchObject({
        code: WORKFLOW_RUN_NOT_DELETABLE_CODE,
        message: `${why} Cancel it first.`,
      });
    }
    for (const refused of refusedRows) {
      expect(readRunRows(database.reader, refused.workflowRunId)).toEqual(refused.rows);
    }
    expect(readDeletedEvents()).toEqual([]);

    expect(await deletion.delete(finishedRunId)).toEqual({
      workflowRunId: finishedRunId,
      gitCommonDir: checkout.gitCommonDir,
    });
    expect(readRunRows(database.reader, finishedRunId)).toEqual(NO_ROWS);
    expect(readDeletedEvents()).toEqual([deletedEventOf(finishedRunId)]);
    for (const refused of refusedRows) {
      expect(readRunRows(database.reader, refused.workflowRunId)).toEqual(refused.rows);
    }
  });
});

describe("deleting runs older than an instant", () => {
  it("removes what its preview counted and spares kept, going, parked and newer runs", async () => {
    const oldFinishedRunIds = [
      await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP),
      await storeRun("failed", OLD_START, OLD_FINISH, FAILED_STEP),
    ];
    const keptRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    await deletion.setKeep({ workflowRunId: keptRunId, keep: true });
    // An ended first run stays while a later run of its chain waits.
    const chainRootRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const waitingRunId = await storeRun("waiting", OLD_START, null, WAITING_STEP, chainRootRunId);
    const parkedRunId = await storeRun("failed", OLD_START, null, FAILED_STEP);
    const recentRunId = await storeRun("succeeded", RECENT_START, RECENT_FINISH, SETTLED_STEP);
    const survivors = [keptRunId, chainRootRunId, waitingRunId, parkedRunId, recentRunId].map(
      (workflowRunId) => ({ workflowRunId, rows: readRunRows(database.reader, workflowRunId) }),
    );

    const preview = deletion.previewDeleteOlderThan(CUTOFF);
    expect(preview).toEqual({ deleteCount: 2, keptCount: 1, waitingCount: 2 });

    const deleted = await deletion.deleteOlderThan(CUTOFF);
    expect(deleted).toHaveLength(preview.deleteCount);
    expect(deleted.map((run) => run.workflowRunId).sort()).toEqual([...oldFinishedRunIds].sort());
    expect(deleted.every((run) => run.gitCommonDir === checkout.gitCommonDir)).toBe(true);
    for (const workflowRunId of oldFinishedRunIds) {
      expect(readRunRows(database.reader, workflowRunId)).toEqual(NO_ROWS);
    }
    expect(readDeletedEvents()).toEqual(
      [...oldFinishedRunIds].sort().map((id) => deletedEventOf(id)),
    );
    for (const survivor of survivors) {
      expect(readRunRows(database.reader, survivor.workflowRunId)).toEqual(survivor.rows);
    }
  });

  it("leaves a run kept after the delete read it and deletes the runs beside it", async () => {
    const otherRunIds = [
      await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP),
      await storeRun("failed", OLD_START, OLD_FINISH, FAILED_STEP),
    ];
    const keptLateRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);

    // The Keep write is queued first, so it commits before the delete's guards read the runs, while
    // the delete reads the runs before the Keep has committed; all three share one write.
    const keeping = deletion.setKeep({ workflowRunId: keptLateRunId, keep: true });
    const deleted = await deletion.deleteOlderThan(CUTOFF);
    await keeping;

    expect(deleted.map((run) => run.workflowRunId).sort()).toEqual([...otherRunIds].sort());
    expect(readRunRows(database.reader, keptLateRunId)).toMatchObject({
      run: [{ id: keptLateRunId, kept: 1 }],
      steps: [{ status: "succeeded" }],
    });
    for (const workflowRunId of otherRunIds) {
      expect(readRunRows(database.reader, workflowRunId)).toEqual(NO_ROWS);
    }
    expect(readDeletedEvents()).toEqual([...otherRunIds].sort().map((id) => deletedEventOf(id)));
  });

  it("appends each run's deleted event to that run's own session", async () => {
    const runs = [
      {
        sessionId: FIXTURE_SESSION_ID,
        workflowRunId: await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP),
      },
      {
        sessionId: OTHER_SESSION_ID,
        workflowRunId: await storeRun(
          "succeeded",
          OLD_START,
          OLD_FINISH,
          SETTLED_STEP,
          undefined,
          OTHER_SESSION_ID,
        ),
      },
      {
        sessionId: FIXTURE_SESSION_ID,
        workflowRunId: await storeRun("failed", OLD_START, OLD_FINISH, FAILED_STEP),
      },
    ].sort((left, right) => left.workflowRunId.localeCompare(right.workflowRunId));

    const deleted = await deletion.deleteOlderThan(CUTOFF);

    expect(deleted.map((run) => run.workflowRunId).sort()).toEqual(
      runs.map((run) => run.workflowRunId),
    );
    expect(readDeletedEvents()).toEqual(
      runs.map((run) => deletedEventOf(run.workflowRunId, run.sessionId)),
    );
  });

  it("settles every session's write before reporting one that failed", async () => {
    const failedRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const otherRunId = await storeRun(
      "succeeded",
      OLD_START,
      OLD_FINISH,
      SETTLED_STEP,
      undefined,
      OTHER_SESSION_ID,
    );
    const failedRunRows = readRunRows(database.reader, failedRunId);
    const appendFailure = new Error("the disk is full");
    // The fixture session's write, which goes first, fails; the other session's still goes.
    const sessionEvents = eventLogOver(database);
    const failingSessionEvents: SessionEventLog = {
      append: (envelope, options) =>
        envelope.sessionId === FIXTURE_SESSION_ID
          ? Promise.reject(appendFailure)
          : sessionEvents.append(envelope, options),
    };
    const failingDeletion = new WorkflowRunDeletion(database, failingSessionEvents);

    const failure: unknown = await failingDeletion
      .deleteOlderThan(CUTOFF)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowRunsDeleteIncompleteError);
    expect(failure).toMatchObject({
      cause: appendFailure,
      deleted: [{ workflowRunId: otherRunId, gitCommonDir: checkout.gitCommonDir }],
    });
    expect(readRunRows(database.reader, otherRunId)).toEqual(NO_ROWS);
    expect(readRunRows(database.reader, failedRunId)).toEqual(failedRunRows);
    expect(readDeletedEvents()).toEqual([deletedEventOf(otherRunId, OTHER_SESSION_ID)]);
  });
});
