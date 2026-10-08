// `Delete run` on a run still going or parked on its failed step is refused in place with
// `Cancel it first.`, and pressing it asks nothing: no confirm opens and nothing is sent, so a run's steps and their data are not
// deleted from under it. The same press on a finished run opens the confirm, and a delete the
// daemon served reads the list again, so the confirm never waits on a stream that may be down.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
  summaryOfRun,
} from "#fixtures/data/workflow/run/records.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { RunsTable } from "./RunsTable.js";

function playbackRun(workflowRunId: string): ReturnType<typeof summaryOfRun> {
  const run = WORKFLOW_RUN_RECORDS.find((record) => record.read.workflowRunId === workflowRunId);
  if (run === undefined) {
    throw new Error(`the playback has no run ${workflowRunId}`);
  }
  return summaryOfRun(run);
}

describe("the runs table's `Delete run`", () => {
  it("refuses a waiting or parked run in place, asks for a finished one and reads again once deleted", async () => {
    const waiting = playbackRun(WORKFLOW_RUN_IDS.waitingApproval);
    const parked = playbackRun(WORKFLOW_RUN_IDS.failed);
    const finished = playbackRun(WORKFLOW_RUN_IDS.succeeded);
    const { bridge, calls } = bridgeAnswering(async (call, passThrough) =>
      call.method === "workflow.runDelete"
        ? { workflowRunId: finished.workflowRunId, deleted: true }
        : passThrough(),
    );
    const onRunDeleted = vi.fn();
    render(
      <RunsTable
        runs={[waiting, parked, finished]}
        payerOf={() => ({ kind: "unread" })}
        bridge={bridge}
        onOpenRun={() => undefined}
        onRunDeleted={onRunDeleted}
        nowMs={0}
      />,
      { wrapper: bridgeWrapper(bridge) },
    );
    const [waitingRow, parkedRow, finishedRow] = screen.getAllByRole("row").slice(1);
    if (waitingRow === undefined || parkedRow === undefined || finishedRow === undefined) {
      throw new Error("the table drew fewer than three runs");
    }

    for (const refusedRow of [waitingRow, parkedRow]) {
      fireEvent.click(within(refusedRow).getByRole("button", { name: "Delete run" }));
      expect(within(refusedRow).getByText("Cancel it first.")).toBeTruthy();
      expect(within(refusedRow).queryByRole("group", { name: "Delete this run?" })).toBeNull();
    }

    fireEvent.click(within(finishedRow).getByRole("button", { name: "Delete run" }));
    const confirm = within(finishedRow).getByRole("group", { name: "Delete this run?" });
    expect(calls.filter((call) => call.method === "workflow.runDelete")).toStrictEqual([]);

    fireEvent.click(within(confirm).getByRole("button", { name: "Delete run" }));
    await waitFor(() => {
      expect(onRunDeleted).toHaveBeenCalledOnce();
    });
    expect(calls.filter((call) => call.method === "workflow.runDelete")).toHaveLength(1);
  });
});
