// `Retry from this step` acts only on the latest execution of a node whose step failed, on a run
// no longer going: a run still going, a step that did not fail and an earlier pass a later one
// superseded each refuse in their own words, so the panel never offers a retry that cannot act.

import { describe, expect, it } from "vitest";

import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "#fixtures/data/workflow/run/records.js";
import { retryAvailability } from "./controls.js";

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
      reason: "Retry · this step has a later run",
    });
  });

  it("refuses a run still going and a step that did not fail, each in its own words", () => {
    const run = failedRun();
    const failed = run.steps.find((step) => step.status === "failed");
    const succeeded = run.steps.find((step) => step.status === "succeeded");
    if (failed === undefined || succeeded === undefined) {
      throw new Error("the fixture's failed run has no failed or no succeeded step");
    }

    const { finishedAt: _finishedAt, ...going } = run;
    expect(retryAvailability({ ...going, status: "running" }, failed)).toStrictEqual({
      kind: "refused",
      reason: "Retry · this run is still going",
    });
    expect(retryAvailability(run, succeeded)).toStrictEqual({
      kind: "refused",
      reason: "Retry · this step did not fail",
    });
  });
});
