// Deleting runs removes stored history for good: a delete must refuse a run still going, and a
// chain's first run while a later run of the chain is going, without touching a row; leave nothing
// of a run it deletes while answering the git folder its snapshot refs live in; and in bulk remove
// exactly what its preview counted while sparing kept, waiting and parked runs.

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
  // A run's gate answers reference the approval requests table, which the daemon schema does not
  // hold; with foreign keys on, any delete from the answers needs that table to exist.
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

// A run with an execution context, one step and a form draft, at `status`; a run that joins a
// chain names the chain's first run.
async function storeRun(
  status: WorkflowRunStatus,
  startedAt: string,
  finishedAt: string | null,
  step: FixtureStep,
  chainRootRunId?: WorkflowRunId,
): Promise<WorkflowRunId> {
  const workflowRunId = await createFixtureRun(database.writer, versionId, {
    executionContext: checkout,
    chain:
      chainRootRunId === undefined
        ? { kind: "starts" }
        : { kind: "joins", chainRootRunId, isFromError: false },
  });
  await setFixtureRunStatus(database.writer, workflowRunId, status, startedAt, finishedAt);
  await insertFixtureStep(database.writer, workflowRunId, step);
  await insertFixtureFormDraft(database.writer, workflowRunId);
  return workflowRunId;
}

const SETTLED_STEP: FixtureStep = { executionIndex: 0, status: "succeeded" };
const WAITING_STEP: FixtureStep = { executionIndex: 0, status: "waiting", waitCause: "approval" };
const FAILED_STEP: FixtureStep = { executionIndex: 0, status: "failed" };

describe("deleting one run", () => {
  it("refuses a going run or its chain's first run and empties an ended one", async () => {
    const chainRootRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const runningRunId = await storeRun(
      "running",
      OLD_START,
      null,
      { executionIndex: 0, status: "running" },
      chainRootRunId,
    );
    const waitingRunId = await storeRun("waiting", OLD_START, null, WAITING_STEP);
    const finishedRunId = await storeRun("succeeded", OLD_START, OLD_FINISH, SETTLED_STEP);
    const refusedRows = [chainRootRunId, runningRunId, waitingRunId].map((workflowRunId) => ({
      workflowRunId,
      rows: readRunRows(database.reader, workflowRunId),
    }));

    for (const { workflowRunId } of refusedRows) {
      await expect(deletion.delete(workflowRunId)).rejects.toMatchObject({
        code: WORKFLOW_RUN_NOT_DELETABLE_CODE,
      });
    }
    for (const refused of refusedRows) {
      expect(readRunRows(database.reader, refused.workflowRunId)).toEqual(refused.rows);
    }

    expect(await deletion.delete(finishedRunId)).toEqual({
      workflowRunId: finishedRunId,
      gitCommonDir: checkout.gitCommonDir,
    });
    expect(readRunRows(database.reader, finishedRunId)).toEqual(NO_ROWS);
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
    for (const survivor of survivors) {
      expect(readRunRows(database.reader, survivor.workflowRunId)).toEqual(survivor.rows);
    }
  });
});
