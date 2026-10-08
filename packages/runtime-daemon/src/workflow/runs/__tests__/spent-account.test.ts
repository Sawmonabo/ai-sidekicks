// A healed session can hold a step parked on a spent provider account removed since, so the run
// read and the runs-needing-you section must still read: one failed read would blank the run's
// page and the whole section above the runs table.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import {
  createFixtureRun,
  insertFixtureStep,
  insertWorkflowVersion,
  setFixtureRunStatus,
} from "../__fixtures__/rows.js";
import { WorkflowRunAttentionList } from "../attention.js";
import { WorkflowRunStore } from "../store.js";

const REMOVED_ACCOUNT_ID = "00000000-0000-7000-8000-0000000000aa";

let database: ScratchDatabase;

beforeEach(async () => {
  database = await openScratchDatabase();
});

afterEach(async () => {
  await database.close();
});

describe("a wait on a provider account that was removed", () => {
  it("reads in the run and in the runs-needing-you section, named by its id alone", async () => {
    const versionId = await insertWorkflowVersion(database.writer, "Nightly review");
    const workflowRunId = await createFixtureRun(database.writer, versionId);
    await setFixtureRunStatus(database.writer, workflowRunId, "waiting", null);
    await insertFixtureStep(database.writer, workflowRunId, {
      executionIndex: 0,
      status: "waiting",
      waitCause: "account",
      waitAccountId: REMOVED_ACCOUNT_ID,
    });

    const [step] = new WorkflowRunStore(database).read(workflowRunId).steps;
    expect(step?.waitCause).toBe("account");
    expect(step?.waitAccountId).toBe(REMOVED_ACCOUNT_ID);
    expect(step?.waitAccountName).toBeUndefined();

    const section = new WorkflowRunAttentionList(database).read();
    expect(section.entries).toEqual([
      {
        kind: "account",
        providerAccountId: REMOVED_ACCOUNT_ID,
        accountName: undefined,
        affectedRunCount: 1,
        waitingSince: expect.any(String),
        resumeAt: undefined,
      },
    ]);
    expect(section.waitingOnPersonCount).toBe(0);
  });
});
