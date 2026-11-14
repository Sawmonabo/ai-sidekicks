// `Retry from this step` acts only on the latest execution of a node whose step failed, on a run
// no longer going: a run still going, a step that did not fail and an earlier pass a later one
// superseded each refuse in their own words, so the panel never offers a retry that cannot act.
// `Resume` acts on a waiting run only where a wait the person's answer does not lift holds it.

import { describe, expect, it } from "vitest";

import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow/run/records";

import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "#fixtures/data/workflow/run/records.js";
import { retryAvailability, runHeaderControlAvailability } from "./controls.js";

function fixtureRun(workflowRunId: string): WorkflowRunReadResponse {
  const record = WORKFLOW_RUN_RECORDS.find((run) => run.read.workflowRunId === workflowRunId);
  if (record === undefined) {
    throw new Error(`the fixture daemon holds no run ${workflowRunId}`);
  }
  return record.read;
}

function failedRun(): WorkflowRunReadResponse {
  return fixtureRun(WORKFLOW_RUN_IDS.failed);
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

    const { finishedAt: _finishedAt, error: _error, review: _review, ...going } = run;
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

describe("Resume", () => {
  it("refuses a run whose waiting steps all wait on the person, and acts on a spent account", () => {
    for (const workflowRunId of [
      WORKFLOW_RUN_IDS.waitingApproval,
      WORKFLOW_RUN_IDS.waitingForm,
      WORKFLOW_RUN_IDS.waitingReply,
      WORKFLOW_RUN_IDS.chainHeld,
    ]) {
      const run = fixtureRun(workflowRunId);
      expect(run.status).toBe("waiting");
      expect(runHeaderControlAvailability("resume", run)).toStrictEqual({
        kind: "refused",
        reason: "Resume · this run is waiting on you",
      });
    }
    expect(
      runHeaderControlAvailability("resume", fixtureRun(WORKFLOW_RUN_IDS.waitingAccount)),
    ).toStrictEqual({ kind: "allowed" });
  });
});
