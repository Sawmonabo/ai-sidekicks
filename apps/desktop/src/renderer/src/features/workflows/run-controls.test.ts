// `Retry from this step` acts only on the latest execution of a node whose step failed: an
// earlier pass that a later one superseded refuses in words, so the panel never offers to retry
// a step the run has already moved past.

import { describe, expect, it } from "vitest";

import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "@fixtures/data/workflow/runs.js";
import { retryAvailability } from "./run-controls.js";

function failedRun(): WorkflowRunReadResponse {
  const record = WORKFLOW_RUN_RECORDS.find(
    (run) => run.read.workflowRunId === WORKFLOW_RUN_IDS.failed,
  );
  if (record === undefined) {
    throw new Error("the fixture daemon holds no failed run");
  }
  return record.read;
}

describe("Retry from this step", () => {
  it("acts on the latest failed execution of a node and refuses an earlier one", () => {
    const run = failedRun();
    const latest = run.steps.find((step) => step.status === "failed");
    if (latest === undefined) {
      throw new Error("the fixture's failed run has no failed step");
    }
    const earlier = { ...latest, executionIndex: latest.executionIndex - 1, attempt: 1 };
    const withEarlierPass = { ...run, steps: [...run.steps, earlier] };

    expect(retryAvailability(withEarlierPass, latest)).toStrictEqual({ kind: "allowed" });
    expect(retryAvailability(withEarlierPass, earlier)).toStrictEqual({
      kind: "refused",
      reason: "Only this step's latest run can be retried.",
    });
  });
});
