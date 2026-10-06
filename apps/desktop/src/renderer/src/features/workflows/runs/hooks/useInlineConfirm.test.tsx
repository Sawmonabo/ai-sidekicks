// Escape closes an inline confirm before anything behind it hears the key: a run's `Delete run`
// confirm and each step of `Delete runs older than…` close as their `Cancel` does, and a screen's
// own Escape (closing a panel, leaving a run) never fires on the same press.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
  summaryOfRun,
} from "#fixtures/data/workflow/run/records.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { DeleteOlderRuns } from "../components/DeleteOlderRuns.js";
import { RunsTable } from "../components/RunsTable.js";

afterEach(cleanup);

describe("an inline confirm's Escape", () => {
  it("closes each confirm in turn and never reaches the screen behind it", () => {
    const succeeded = WORKFLOW_RUN_RECORDS.find(
      (run) => run.read.workflowRunId === WORKFLOW_RUN_IDS.succeeded,
    );
    if (succeeded === undefined) {
      throw new Error("the playback has no succeeded run");
    }
    const { bridge, engine, calls } = bridgeAnswering(async (_call, passThrough) => passThrough());
    const Host = bridgeWrapper(bridge, engine.clock);
    const screenEscape = vi.fn();
    render(
      <Host>
        <div onKeyDown={screenEscape}>
          <DeleteOlderRuns bridge={bridge} />
          <RunsTable
            runs={[summaryOfRun(succeeded)]}
            accountLabel={() => undefined}
            bridge={bridge}
            onOpenRun={() => undefined}
            onRunDeleted={() => undefined}
            nowMs={engine.clock.now()}
          />
        </div>
      </Host>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    const rowConfirm = screen.getByRole("group", { name: "Delete this run?" });
    // The confirm takes focus as it opens, so the next key reaches it.
    expect(rowConfirm.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? rowConfirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Delete this run?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete run" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete runs older than…" }));
    const choice = screen.getByRole("group", { name: "Delete runs older than…" });
    expect(choice.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? choice, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Delete runs older than…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete runs older than…" })).toBeTruthy();

    expect(screenEscape).not.toHaveBeenCalled();
    expect(
      calls.filter(
        (call) => call.method === "workflow.runDelete" || call.method === "workflow.runsDelete",
      ),
    ).toStrictEqual([]);
  });
});
