// The workflow stream carries no cursor to resume from, so a stream that ends and is opened again
// cannot replay what moved in the gap: the Runs tab reads its runs again, and a run that finished
// while nothing was heard draws its new status. A re-open that throws is drawn on the strip in
// place of the hold switch, over the list and a run's page alike, until a re-open works; so is a
// first open that throws, which is tried again rather than left down until the tab is left.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  WorkflowRunListResponse,
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import { WORKFLOW_NOTICE_STREAM } from "#renderer/services/daemon/session/event/session-event-streams.js";
import { isRunsTableRead, mountWorkflowsScreen } from "./WorkflowsScreen.test-support.js";

afterEach(cleanup);

const LINK_FAILED: DaemonSubscriptionEnd = { reason: "failed", message: "the link went away" };

/** What the strip reads while the stream is down and a re-open threw. */
const REOPEN_REFUSED_DETAIL = "Live updates stopped and could not start again; still trying.";

/** What the strip reads while the stream's first open threw. */
const FIRST_OPEN_REFUSED_DETAIL = "Live updates could not start; still trying.";

/** The waiting run as the daemon holds it once it finished in the gap. */
function finished(run: WorkflowRunSummary): WorkflowRunSummary {
  const { liveStep: _liveStep, waitCause: _waitCause, resumeAt: _resumeAt, ...settled } = run;
  return { ...settled, status: "succeeded", durationMs: 31 * 60_000 };
}

/** The status cell of the table row at `index`, rows in the order the daemon listed them. */
function statusAt(index: number): string {
  const row = document.querySelectorAll("tbody tr")[index];
  return row?.querySelectorAll("td")[0]?.textContent ?? "";
}

describe("the workflows screen — a stream that ends and opens again", () => {
  it("reads the runs again, so a run that finished in the gap draws its new status", async () => {
    let hasFinished = false;
    let rowIndex = -1;
    const workflowStreamEnds: ((end: DaemonSubscriptionEnd) => void)[] = [];
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        if (!isRunsTableRead(call)) {
          return reply;
        }
        const page = reply as WorkflowRunListResponse;
        rowIndex = page.runs.findIndex(
          (run) => run.workflowRunId === WORKFLOW_RUN_IDS.waitingApproval,
        );
        return hasFinished
          ? {
              ...page,
              runs: page.runs.map((run) =>
                run.workflowRunId === WORKFLOW_RUN_IDS.waitingApproval ? finished(run) : run,
              ),
            }
          : page;
      },
      openStream: (passThrough, _handler, _request, onEnded, event) => {
        if (event === WORKFLOW_NOTICE_STREAM && onEnded !== undefined) {
          workflowStreamEnds.push(onEnded);
        }
        return passThrough();
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(statusAt(rowIndex)).toMatch(/^Waiting/u);
    });
    expect(workflowStreamEnds).toHaveLength(1);

    // The run finishes while the stream is down, so no frame names it.
    hasFinished = true;
    await act(async () => {
      workflowStreamEnds[0]?.(LINK_FAILED);
      await crossMacrotaskBoundary();
    });
    expect(workflowStreamEnds).toHaveLength(2);
    await advanceScenarioUntil(mounted.engine, () => {
      expect(statusAt(rowIndex)).toBe("Succeeded");
    });
    mounted.unmount();
  });

  it("draws a re-open that throws on the strip, and the hold switch again once one works", async () => {
    let isRefusing = false;
    const workflowStreamEnds: ((end: DaemonSubscriptionEnd) => void)[] = [];
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      openStream: (passThrough, _handler, _request, onEnded, event) => {
        if (event === WORKFLOW_NOTICE_STREAM) {
          if (isRefusing) {
            throw new Error("the daemon declined the stream");
          }
          if (onEnded !== undefined) {
            workflowStreamEnds.push(onEnded);
          }
        }
        return passThrough();
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(
        screen.getByRole("switch", { name: /Pause new runs/u }).getAttribute("aria-disabled"),
      ).not.toBe("true");
    });
    expect(screen.getByText("live through one subscription")).not.toBeNull();

    isRefusing = true;
    await act(async () => {
      workflowStreamEnds[0]?.(LINK_FAILED);
      await crossMacrotaskBoundary();
    });
    expect(screen.getByText(REOPEN_REFUSED_DETAIL)).not.toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("live through one subscription")).toBeNull();

    isRefusing = false;
    await advanceScenarioUntil(mounted.engine, () => {
      expect(
        screen.getByRole("switch", { name: /Pause new runs/u }).getAttribute("aria-disabled"),
      ).not.toBe("true");
    });
    expect(screen.queryByText(REOPEN_REFUSED_DETAIL)).toBeNull();
    expect(screen.getByText("live through one subscription")).not.toBeNull();
    mounted.unmount();
  });

  it("draws a first open that throws on the strip, and the hold switch once a retry works", async () => {
    let isRefusing = true;
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      openStream: (passThrough, _handler, _request, _onEnded, event) => {
        if (event === WORKFLOW_NOTICE_STREAM && isRefusing) {
          throw new Error("the daemon declined the stream");
        }
        return passThrough();
      },
    });
    await act(crossMacrotaskBoundary);
    expect(screen.getByText(FIRST_OPEN_REFUSED_DETAIL)).not.toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();

    isRefusing = false;
    await advanceScenarioUntil(mounted.engine, () => {
      expect(
        screen.getByRole("switch", { name: /Pause new runs/u }).getAttribute("aria-disabled"),
      ).not.toBe("true");
    });
    expect(screen.queryByText(FIRST_OPEN_REFUSED_DETAIL)).toBeNull();
    mounted.unmount();
  });
});
