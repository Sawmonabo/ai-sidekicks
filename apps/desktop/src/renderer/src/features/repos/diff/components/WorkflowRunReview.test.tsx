// Review over a workflow run, read from the fixture daemon: a run that changed files draws them
// with the step that changed each, a run that changed nothing says so, and a refused read shows
// the daemon's refusal rather than an empty change set, with a `Try again` that reads it again.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WORKFLOW_OWN_SESSION, WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import type { ScenarioEngine } from "#renderer/services/daemon/engine.fixture.js";
import { paneContext } from "#test/helpers/pane-context.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import type { WorkflowRunComparisonRef } from "#renderer/routing/panes/pane-address.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { installDiffPaneLayout } from "./DiffPane.test-support.js";
import { DiffPane } from "./DiffPane.js";

installDiffPaneLayout();

/** The finished digest run, compared from its start to its end. */
const FINISHED_RUN: WorkflowRunComparisonRef = {
  kind: "workflow-run",
  id: WORKFLOW_RUN_IDS.succeeded,
  from: { epoch: 1, point: "start" },
  to: { epoch: 1, point: "end" },
};

/** The release run waiting on its approval, compared from its start to that pause. */
const PAUSED_RUN: WorkflowRunComparisonRef = {
  kind: "workflow-run",
  id: WORKFLOW_RUN_IDS.waitingApproval,
  from: { epoch: 1, point: "start" },
  to: { epoch: 1, point: "pause", pauseNumber: 1 },
};

/**
 * Review over `comparison`, at the address the run page's `Open in Review` writes, in the run's
 * session, on a bridge the case answers. Returns the calls made and the engine driving the frozen
 * clock, once `settled` holds.
 */
async function renderRunReview(
  comparison: WorkflowRunComparisonRef,
  answer: (call: RecordedDaemonCall, passThrough: () => Promise<unknown>) => Promise<unknown>,
  settled: () => void,
): Promise<{ readonly calls: readonly RecordedDaemonCall[]; readonly engine: ScenarioEngine }> {
  const { bridge, calls, engine } = bridgeAnswering(answer);
  render(
    <DiffPane
      context={paneContext(
        { kind: "diff", entity: comparison },
        { bridge, sessionStore: new SessionStore({ sessionId: WORKFLOW_OWN_SESSION }) },
      )}
    />,
    { wrapper: bridgeWrapper(bridge, engine.clock) },
  );
  await advanceScenarioUntil(engine, settled);
  return { calls, engine };
}

describe("Review over a workflow run", () => {
  it("draws the files the run changed, each marked with the step that changed it", async () => {
    const { calls } = await renderRunReview(
      FINISHED_RUN,
      async (_call, passThrough) => passThrough(),
      () => {
        expect(screen.getByRole("button", { name: /reviews\/pr-412\.md/u })).toBeDefined();
      },
    );

    expect(calls.map((call) => call.params)).toStrictEqual([
      {
        sessionId: WORKFLOW_OWN_SESSION,
        scope: "workflow_run",
        workflowRunId: FINISHED_RUN.id,
        from: FINISHED_RUN.from,
        to: FINISHED_RUN.to,
      },
    ]);
    const reviewRow = screen.getByRole("button", { name: /reviews\/pr-412\.md/u });
    expect(reviewRow.textContent).toContain("Review one PR");
    expect(screen.getByRole("button", { name: /digest\/summary\.md/u }).textContent).toContain(
      "Save the notes",
    );
    // An edit someone else made in the checkout shows too, with no step's name on it.
    const othersEdit = screen.getByRole("button", { name: /notes\/todo\.txt/u });
    expect(othersEdit.querySelector(".meridian-diff-files__step")).toBeNull();
    expect(screen.queryByText("This run changed no files")).toBeNull();
  });

  it("says the run changed no files when its comparison holds none", async () => {
    await renderRunReview(
      PAUSED_RUN,
      async (_call, passThrough) => passThrough(),
      () => {
        expect(screen.getByText("This run changed no files")).toBeDefined();
      },
    );

    expect(screen.queryByRole("button", { name: /All files/u })).toBeNull();
  });

  it("shows the daemon's refusal, not an empty change set, and reads again on Try again", async () => {
    let diffReads = 0;
    const { calls, engine } = await renderRunReview(
      FINISHED_RUN,
      async (call, passThrough) => {
        if (call.method === "gitflow.diffRead") {
          diffReads += 1;
          if (diffReads === 1) {
            throw {
              code: "gitflow.read_failed",
              message: "The run's snapshots could not be read.",
            };
          }
        }
        return passThrough();
      },
      () => {
        expect(screen.getByText("Could not load what this run changed")).toBeDefined();
      },
    );

    expect(screen.getByText("The run's snapshots could not be read.")).toBeDefined();
    expect(screen.queryByText("This run changed no files")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await advanceScenarioUntil(engine, () => {
      expect(screen.getByRole("button", { name: /reviews\/pr-412\.md/u })).toBeDefined();
    });
    expect(calls.filter((call) => call.method === "gitflow.diffRead")).toHaveLength(2);
    expect(screen.queryByText("Could not load what this run changed")).toBeNull();
  });
});
