// Deleting runs removes stored history for good: a delete must refuse a run still going without
// touching a row, leave nothing of a run it deletes, and in bulk remove exactly what its preview
// counted while sparing kept and waiting runs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/id";
import { WORKFLOW_RUN_NOT_DELETABLE_CODE } from "@ai-sidekicks/contracts/workflow/run/records";
import type { WorkflowRunStatus } from "@ai-sidekicks/contracts/workflow/run/status";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import {
  createFixtureRun,
  insertExecutionContextCheckout,
  insertFixtureFormDraft,
  insertFixtureStep,
  insertWorkflowVersion,
  readRunRows,
  setFixtureRunStatus,
  type FixtureStep,
} from "../__fixtures__/rows.js";
import type { WorkflowRunExecutionContext } from "../creation.js";
import { WorkflowRunDeletion } from "../deletion.js";

const OLD_START = "2026-10-01T00:00:00.000Z";
const OLD_FINISH = "2026-10-01T00:05:00.000Z";
const RECENT_START = "2026-10-06T00:00:00.000Z";
const RECENT_FINISH = "2026-10-06T00:05:00.000Z";
const CUTOFF = "2026-10-05T00:00:00.000Z";
const NO_ROWS = { run: [], steps: [], formDrafts: [], executionContext: [] };

let database: ScratchDatabase;
let deletion: WorkflowRunDeletion;
let versionId: string;
let checkout: WorkflowRunExecutionContext;

beforeEach(async () => {
  database = await openScratchDatabase();
  // A run's gate answers reference the approval requests table, which the schema does not hold
  // yet; with foreign keys on, any delete from the answers needs that table to exist.
  await database.writer.write([
    { sql: "CREATE TABLE approval_requests (id TEXT PRIMARY KEY) STRICT" },
  ]);
  deletion = new WorkflowRunDeletion(database);
  versionId = await insertWorkflowVersion(database.writer, "Nightly review");
  checkout = await insertExecutionContextCheckout(database.writer);
});

afterEach(async () => {
  await database.close();
});

// A run with an execution context, one step and a form draft, at `status`.
async function storeRun(
  status: WorkflowRunStatus,
  startedAt: string,
  finishedAt: string | null,
  step: FixtureStep,
): Promise<WorkflowRunId> {
  const workflowRunId = await createFixtureRun(database.writer, versionId, {
    executionContext: checkout,
  });
  await setFixtureRunStatus(database.writer, workflowRunId, status, startedAt, finishedAt);
  await insertFixtureStep(database.writer, workflowRunId, step);
  await insertFixtureFormDraft(database.writer, workflowRunId);
  return workflowRunId;
}

const SETTLED_STEP: FixtureStep = { executionIndex: 0, status: "succeeded" };
const WAITING_STEP: FixtureStep = { executionIndex: 0, status: "waiting", waitCause: "approval" };

describe("deleting one run", () => {
  it("refuses a running or waiting run untouched and leaves no row of a finished one", async () => {
    const runningRunId = await storeRun("running", OLD_START, null, {
      executionIndex: 0,
      status: "running",
    });
    const waitingRunId = await storeRun("waiting", OLD_START, null, WAITING_STEP);
    const finishedRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const runningRows = readRunRows(database.reader, runningRunId);
    const waitingRows = readRunRows(database.reader, waitingRunId);

    for (const workflowRunId of [runningRunId, waitingRunId]) {
      await expect(deletion.delete(workflowRunId)).rejects.toMatchObject({
        code: WORKFLOW_RUN_NOT_DELETABLE_CODE,
      });
    }
    expect(readRunRows(database.reader, runningRunId)).toEqual(runningRows);
    expect(readRunRows(database.reader, waitingRunId)).toEqual(waitingRows);

    await deletion.delete(finishedRunId);
    expect(readRunRows(database.reader, finishedRunId)).toEqual(NO_ROWS);
    expect(readRunRows(database.reader, runningRunId)).toEqual(runningRows);
  });
});

describe("deleting runs older than an instant", () => {
  it("removes what its preview counted and spares kept, waiting and newer runs", async () => {
    const oldFinishedRunIds = [
      await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP),
      await storeRun("failed", OLD_START, OLD_FINISH, { executionIndex: 0, status: "failed" }),
    ];
    const keptRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    await deletion.setKeep({ workflowRunId: keptRunId, keep: true });
    const waitingRunId = await storeRun("waiting", OLD_START, null, WAITING_STEP);
    const recentRunId = await storeRun("succeeded", RECENT_START, RECENT_FINISH, SETTLED_STEP);
    const survivors = [keptRunId, waitingRunId, recentRunId].map((workflowRunId) => ({
      workflowRunId,
      rows: readRunRows(database.reader, workflowRunId),
    }));

    const preview = deletion.previewDeleteOlderThan(CUTOFF);
    expect(preview).toEqual({ deleteCount: 2, keptCount: 1, waitingCount: 1 });

    const deleted = await deletion.deleteOlderThan(CUTOFF);
    expect(deleted.deletedRunIds).toHaveLength(preview.deleteCount);
    expect([...deleted.deletedRunIds].sort()).toEqual([...oldFinishedRunIds].sort());
    for (const workflowRunId of oldFinishedRunIds) {
      expect(readRunRows(database.reader, workflowRunId)).toEqual(NO_ROWS);
    }
    for (const survivor of survivors) {
      expect(readRunRows(database.reader, survivor.workflowRunId)).toEqual(survivor.rows);
    }
  });
});
