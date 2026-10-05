// A run's header over contract-shaped runs from the fixture daemon: a waiting run says what it
// waits on and when it resumes from its own step, or that no instant is armed; a stopped step is
// named by its node's kind; a going run reads its time so far, moving each second, and a finished
// one how long it took; a run that joined a chain keeps who started it beside the link to the
// chain's first run; a control the run's state does not allow stands refused with its reason and
// never reaches the daemon, a failed run parked on its step offers Resume and Cancel and one that
// ended refuses both; and only a finished run opens Review, on its own start and end snapshots,
// its door staying in place saying why when the end snapshot could not be taken.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { WorkflowNodeId } from "@ai-sidekicks/contracts/workflow-definition";
import { WORKFLOW_STEP_TIMED_OUT_CODE } from "@ai-sidekicks/contracts/workflow-run";
import type { WorkflowRunReadResponse } from "@ai-sidekicks/contracts/workflow-run-records";

import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import {
  WORKFLOW_FIXTURE_NOW_MS,
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
} from "@fixtures/data/workflow-runs.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { MILLISECONDS_PER_DAY } from "@renderer/lib/instant.js";
import { formatDayClock } from "@renderer/lib/wire-figures.js";
import { RunHeader } from "./RunHeader.js";

const NODE_KINDS: Readonly<Record<string, string>> = {
  review: "agent.run",
  summary: "developer.run-tests",
  approve: "human.approval",
};

function fixtureRun(workflowRunId: string): WorkflowRunReadResponse {
  const record = WORKFLOW_RUN_RECORDS.find((run) => run.read.workflowRunId === workflowRunId);
  if (record === undefined) {
    throw new Error(`the fixture daemon holds no run ${workflowRunId}`);
  }
  return record.read;
}

/** The two snapshot points each `Open in Review` press asked for. */
type ReviewRequest = readonly [WorkflowRunSnapshotPoint, WorkflowRunSnapshotPoint];

/** The header over `run`, on a bridge that records every call and answers each as the fixture. */
function renderHeader(
  run: WorkflowRunReadResponse,
  reviews: ReviewRequest[] = [],
  openedRuns: string[] = [],
  nodeKind: (nodeId: string) => string | undefined = (nodeId) => NODE_KINDS[nodeId],
  clock: ManualClock = new ManualClock(WORKFLOW_FIXTURE_NOW_MS),
): readonly RecordedDaemonCall[] {
  const { bridge, calls } = bridgeAnswering(async (_call, passThrough) => passThrough());
  render(
    <RunHeader
      run={run}
      workflowName="Nightly digest"
      versionNumber={2}
      nodeKind={nodeKind}
      accountLabel={() => undefined}
      bridge={bridge}
      onOpenRun={(workflowRunId) => {
        openedRuns.push(workflowRunId);
      }}
      onOpenSession={() => undefined}
      onOpenMessage={() => undefined}
      onOpenWorkflow={() => undefined}
      onOpenReview={(from, to) => {
        reviews.push([from, to]);
      }}
    />,
    { wrapper: bridgeWrapper(bridge, clock) },
  );
  return calls;
}

function control(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("a run's header", () => {
  it("says what a waiting run waits on and when it resumes or gives up, with its day", () => {
    const run = fixtureRun(WORKFLOW_RUN_IDS.waitingAccount);
    const waiting = run.steps.find((step) => step.status === "waiting");
    if (waiting?.resumeAt === undefined) {
      throw new Error("the fixture's account wait carries no resume time");
    }
    // Read a day early, so the resume time names its day.
    const dayBeforeMs = WORKFLOW_FIXTURE_NOW_MS - MILLISECONDS_PER_DAY;
    renderHeader(run, [], [], undefined, new ManualClock(dayBeforeMs));

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "The run step is waiting on a spent account",
    );
    const resumes = formatDayClock(waiting.resumeAt, dayBeforeMs);
    expect(screen.getByText(`It resumes itself at ${resumes}, or press Resume`)).toBeDefined();
    expect(screen.getByText(`resumes itself at ${resumes}`)).toBeDefined();
    cleanup();

    // With no instant armed the park says so, rather than inventing a time.
    const { resumeAt: _armed, ...unarmed } = waiting;
    renderHeader({
      ...run,
      steps: run.steps.map((step) => (step === waiting ? unarmed : step)),
    });
    expect(screen.getByText("Awaiting resume — no instant is armed.")).toBeDefined();
    expect(screen.getByText("awaiting resume — no instant is armed")).toBeDefined();
    cleanup();

    // A wait on a person with a time limit names the instant it gives up, with its day.
    const approval = fixtureRun(WORKFLOW_RUN_IDS.waitingApproval);
    const deadline = approval.steps.find((step) => step.status === "waiting")?.waitDeadlineAt;
    if (deadline === undefined) {
      throw new Error("the fixture's approval wait carries no time limit");
    }
    renderHeader(approval, [], [], undefined, new ManualClock(dayBeforeMs));
    expect(
      screen.getByText(`waiting on your approval until ${formatDayClock(deadline, dayBeforeMs)}`),
    ).toBeDefined();
  });

  it("names the stopped step by its node's kind, and no kind before the version is read", () => {
    const failed = fixtureRun(WORKFLOW_RUN_IDS.failed);
    renderHeader(failed);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "The run tests step failed twice",
    );
    expect(screen.getByText("Fix it and press Resume, or cancel the run")).toBeDefined();
    cleanup();

    const timedOut: WorkflowRunReadResponse = {
      ...failed,
      steps: failed.steps.map((step) =>
        step.status === "failed"
          ? {
              ...step,
              nodeId: "approve" as WorkflowNodeId,
              error: { code: WORKFLOW_STEP_TIMED_OUT_CODE, message: "Nobody answered in time." },
            }
          : step,
      ),
    };
    renderHeader(timedOut);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "The approval step timed out",
    );
    cleanup();

    renderHeader(failed, [], [], () => undefined);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("A step failed twice");
  });

  it("reads a going run's time so far each second, and a finished run's duration", async () => {
    const clock = new ManualClock(WORKFLOW_FIXTURE_NOW_MS);
    const running = fixtureRun(WORKFLOW_RUN_IDS.running);
    renderHeader(running, [], [], (nodeId) => NODE_KINDS[nodeId], clock);
    const duration = (): string | null | undefined =>
      screen.getByText("Duration", { selector: "dt" }).nextElementSibling?.textContent;
    const soFar = duration();
    await act(async () => {
      clock.advance(1_000);
    });
    expect(duration()).not.toBe(soFar);
    expect(duration()).toMatch(/^\d+ m \d+ s$/u);
    cleanup();

    renderHeader(fixtureRun(WORKFLOW_RUN_IDS.succeeded));
    expect(duration()).toBe("6 m 0 s");
  });

  it("keeps who started a chained run beside the link to the chain's first run", () => {
    const chained = fixtureRun(WORKFLOW_RUN_IDS.chained);
    const openedRuns: string[] = [];
    renderHeader(chained, [], openedRuns);
    const chainLink = `Started by ${chained.chainRoot.workflowName} · ${formatDayClock(
      chained.chainRoot.startedAt,
      WORKFLOW_FIXTURE_NOW_MS,
    )}`;
    const startedBy = screen.getByText("Started by", { selector: "dt" }).nextElementSibling;
    expect(startedBy?.textContent).toBe(`A file event · ${chainLink}`);
    fireEvent.click(screen.getByRole("button", { name: chainLink }));
    expect(openedRuns).toStrictEqual([chained.chainRoot.runId]);
  });

  it("refuses the controls a run's state does not allow, and only an allowed press is sent", () => {
    const endedCalls = renderHeader(fixtureRun(WORKFLOW_RUN_IDS.succeeded));
    const endedCancel = control("Cancel");
    const endedResume = control("Resume");
    expect(endedCancel).toHaveProperty("disabled", true);
    expect(endedCancel.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByText("This run has already ended.")).toBeDefined();
    expect(endedResume).toHaveProperty("disabled", true);
    expect(screen.getByText("This run has ended.")).toBeDefined();
    // A new run of the pinned version can start beside a run in any state.
    expect(control("Re-run")).toHaveProperty("disabled", false);
    fireEvent.click(endedCancel);
    fireEvent.click(endedResume);
    expect(endedCalls.map((call) => call.method)).toStrictEqual([]);
    cleanup();

    const goingCalls = renderHeader(fixtureRun(WORKFLOW_RUN_IDS.running));
    expect(control("Resume")).toHaveProperty("disabled", true);
    expect(screen.getByText("This run is not waiting on anything.")).toBeDefined();
    fireEvent.click(control("Resume"));
    fireEvent.click(control("Cancel"));
    expect(goingCalls.map((call) => call.method)).toStrictEqual(["workflow.runCancel"]);
    cleanup();

    // A failed run parked on its failed step has not ended: Resume picks it up, Cancel ends it.
    const parked = fixtureRun(WORKFLOW_RUN_IDS.failed);
    const failedCalls = renderHeader(parked);
    fireEvent.click(control("Resume"));
    fireEvent.click(control("Cancel"));
    expect(failedCalls.map((call) => call.method)).toStrictEqual([
      "workflow.runResume",
      "workflow.runCancel",
    ]);
    cleanup();

    // A failed run that ended refuses both, in words.
    const endedFailedCalls = renderHeader({ ...parked, endedAt: parked.startedAt });
    expect(control("Resume")).toHaveProperty("disabled", true);
    expect(control("Cancel")).toHaveProperty("disabled", true);
    expect(screen.getByText("This run has ended.")).toBeDefined();
    expect(screen.getByText("This run has already ended.")).toBeDefined();
    fireEvent.click(control("Resume"));
    fireEvent.click(control("Cancel"));
    expect(endedFailedCalls.map((call) => call.method)).toStrictEqual([]);
  });

  it("opens Review from start to end on a finished run, and none on a going one", () => {
    const reviews: ReviewRequest[] = [];
    renderHeader(fixtureRun(WORKFLOW_RUN_IDS.succeeded), reviews);
    fireEvent.click(control("Open in Review"));
    expect(reviews).toStrictEqual([
      [
        { epoch: 1, point: "start" },
        { epoch: 1, point: "end" },
      ],
    ]);
    cleanup();

    renderHeader(fixtureRun(WORKFLOW_RUN_IDS.running));
    expect(screen.queryByRole("button", { name: "Open in Review" })).toBeNull();
    cleanup();

    const reason = "The checkout could not be snapshotted: the disk is full.";
    renderHeader(
      { ...fixtureRun(WORKFLOW_RUN_IDS.succeeded), review: { state: "missing", reason } },
      reviews,
    );
    const door = control("Open in Review");
    expect(door).toHaveProperty("disabled", true);
    expect(screen.getByText(reason)).toBeDefined();
    fireEvent.click(door);
    expect(reviews).toHaveLength(1);
  });
});
