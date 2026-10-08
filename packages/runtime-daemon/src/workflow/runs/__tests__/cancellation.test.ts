// A cancel must leave no live wait behind on any step of the run, however many branches were
// waiting, or a resume timer or the attention list would act on a run that has ended; it must
// touch no other run, and it must never overwrite the end of a run that has already ended.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WriteRefusedError } from "../../../database/writer.js";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import {
  createFixtureRun,
  insertFixtureStep,
  insertWorkflowVersion,
  readRunRows,
  setFixtureRunStatus,
} from "../__fixtures__/rows.js";
import { workflowRunCancellationStatements } from "../cancellation.js";

const CANCELED_AT = new Date("2026-10-02T00:10:00.000Z");
const CANCELED_AT_TEXT = CANCELED_AT.toISOString();
const NO_WAIT = {
  wait_cause: null,
  resume_at: null,
  wait_deadline_at: null,
  wait_account_id: null,
  wait_started_at: null,
};

let database: ScratchDatabase;

beforeEach(async () => {
  database = await openScratchDatabase();
});

afterEach(async () => {
  await database.close();
});

describe("applying a cancel to a run's rows", () => {
  it("cancels both waiting branches, keeps a pending step and clears its waits", async () => {
    const versionId = await insertWorkflowVersion(database.writer, "Fan out");
    const canceledRunId = await createFixtureRun(database.writer, versionId);
    await setFixtureRunStatus(database.writer, canceledRunId, "waiting", null);
    await insertFixtureStep(database.writer, canceledRunId, {
      executionIndex: 0,
      status: "succeeded",
    });
    await insertFixtureStep(database.writer, canceledRunId, {
      executionIndex: 1,
      status: "waiting",
      waitCause: "account",
      waitAccountId: "account-one",
      resumeAt: "2026-10-02T05:00:00.000Z",
    });
    await insertFixtureStep(database.writer, canceledRunId, {
      executionIndex: 2,
      status: "waiting",
      waitCause: "account",
      waitAccountId: "account-two",
    });
    await insertFixtureStep(database.writer, canceledRunId, {
      executionIndex: 3,
      status: "pending",
    });
    const otherRunId = await createFixtureRun(database.writer, versionId);
    await setFixtureRunStatus(database.writer, otherRunId, "waiting", null);
    await insertFixtureStep(database.writer, otherRunId, {
      executionIndex: 0,
      status: "waiting",
      waitCause: "approval",
      waitDeadlineAt: "2026-10-03T00:00:00.000Z",
    });
    const otherRunRows = readRunRows(database.reader, otherRunId);

    await database.writer.write(
      workflowRunCancellationStatements({
        workflowRunId: canceledRunId,
        finishedAt: CANCELED_AT,
      }),
    );

    expect(
      database.reader
        .prepare("SELECT status, finished_at FROM workflow_runs WHERE id = ?")
        .get(canceledRunId),
    ).toEqual({ status: "canceled", finished_at: CANCELED_AT_TEXT });
    expect(
      database.reader
        .prepare(
          `SELECT execution_index, status, finished_at, wait_cause, resume_at, wait_deadline_at,
                  wait_account_id, wait_started_at
             FROM workflow_steps WHERE workflow_run_id = ? ORDER BY execution_index`,
        )
        .all(canceledRunId),
    ).toEqual([
      { ...NO_WAIT, execution_index: 0, status: "succeeded", finished_at: null },
      { ...NO_WAIT, execution_index: 1, status: "canceled", finished_at: CANCELED_AT_TEXT },
      { ...NO_WAIT, execution_index: 2, status: "canceled", finished_at: CANCELED_AT_TEXT },
      { ...NO_WAIT, execution_index: 3, status: "pending", finished_at: null },
    ]);
    expect(readRunRows(database.reader, otherRunId)).toEqual(otherRunRows);
  });

  it("refuses a run that has ended and leaves its rows as they were", async () => {
    const versionId = await insertWorkflowVersion(database.writer, "Done already");
    const endedRunId = await createFixtureRun(database.writer, versionId);
    await setFixtureRunStatus(database.writer, endedRunId, "succeeded", "2026-10-02T00:05:00.000Z");
    await insertFixtureStep(database.writer, endedRunId, {
      executionIndex: 0,
      status: "succeeded",
    });
    const endedRunRows = readRunRows(database.reader, endedRunId);

    await expect(
      database.writer.write(
        workflowRunCancellationStatements({ workflowRunId: endedRunId, finishedAt: CANCELED_AT }),
      ),
    ).rejects.toBeInstanceOf(WriteRefusedError);
    expect(readRunRows(database.reader, endedRunId)).toEqual(endedRunRows);
  });
});
