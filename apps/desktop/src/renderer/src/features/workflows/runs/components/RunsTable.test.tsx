// `Delete run` on a run still going is refused in place with `Cancel it first.`, and pressing it
// asks nothing: no confirm opens and nothing is sent, so a run's steps and their data are not
// deleted from under it. The same press on a finished run opens the confirm.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
  summaryOfRun,
} from "@fixtures/data/workflow/runs.js";
import { bridgeAnswering } from "@test/helpers/fixture/bridge.js";
import { RunsTable } from "./RunsTable.js";

function playbackRun(workflowRunId: string): ReturnType<typeof summaryOfRun> {
  const run = WORKFLOW_RUN_RECORDS.find((record) => record.read.workflowRunId === workflowRunId);
  if (run === undefined) {
    throw new Error(`the playback has no run ${workflowRunId}`);
  }
  return summaryOfRun(run);
}

describe("the runs table's `Delete run`", () => {
  it("refuses a waiting run in place and sends no delete, where a finished run asks", () => {
    const waiting = playbackRun(WORKFLOW_RUN_IDS.waitingApproval);
    const finished = playbackRun(WORKFLOW_RUN_IDS.succeeded);
    const { bridge, calls } = bridgeAnswering(async (_call, passThrough) => passThrough());
    render(
      <RunsTable
        runs={[waiting, finished]}
        accountLabel={() => undefined}
        bridge={bridge}
        onOpenRun={() => undefined}
        nowMs={0}
      />,
    );
    const [waitingRow, finishedRow] = screen.getAllByRole("row").slice(1);
    if (waitingRow === undefined || finishedRow === undefined) {
      throw new Error("the table drew fewer than two runs");
    }

    fireEvent.click(within(waitingRow).getByRole("button", { name: "Delete run" }));
    expect(within(waitingRow).getByText("Cancel it first.")).toBeTruthy();
    expect(within(waitingRow).queryByRole("group", { name: "Delete this run" })).toBeNull();

    fireEvent.click(within(finishedRow).getByRole("button", { name: "Delete run" }));
    expect(within(finishedRow).getByRole("group", { name: "Delete this run" })).toBeTruthy();
    expect(calls.filter((call) => call.method === "workflow.runDelete")).toStrictEqual([]);
  });
});
