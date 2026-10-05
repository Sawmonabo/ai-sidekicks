// The runs table reads a page at a time: `Load earlier` asks for the page after the one drawn with
// that page's own cursor, so a run arriving between two pages neither drops a loaded run nor draws
// one twice, and the notice for it puts it on top with every loaded run kept. A deleted run costs
// one read, however many pages are open. A page `Load earlier` could not read keeps the rows above
// it, with its error and `Try again` below them.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRunSummary } from "@ai-sidekicks/contracts/workflow/run/records";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import { compareInstants, parseInstant } from "#renderer/lib/instant.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import { mountWorkflowsScreen, press } from "../WorkflowsScreen.test-support.js";
import { RUNS_PAGE_SIZE } from "./list-pages.js";
import { RunListDaemon, mintedRunId, playbackRunRows } from "./run-list-daemon.test-support.js";

afterEach(cleanup);

/**
 * The playback's runs, each named for its own id, so the table's names are the run ids it drew.
 * More of them than one page holds, so the table pages at all.
 */
function runsNamedById(): WorkflowRunSummary[] {
  return playbackRunRows().map((run) => ({ ...run, definitionName: run.workflowRunId }));
}

/** The run id of every row the runs table draws, top to bottom. */
function drawnRunIds(): string[] {
  const table = screen.getByRole("columnheader", { name: "Started by" }).closest("table");
  if (table === null) {
    throw new Error("the runs table is not drawn");
  }
  return Array.from(
    table.querySelectorAll("tbody th[scope='row']"),
    (cell) => cell.textContent ?? "",
  );
}

function idsOf(runs: readonly WorkflowRunSummary[]): string[] {
  return runs.map((run) => run.workflowRunId);
}

describe("the runs table's pages", () => {
  it("reads page 2 after page 1's cursor, keeping every loaded run once as new ones arrive", async () => {
    const daemon = new RunListDaemon(runsNamedById());
    const loaded = daemon.rows;
    expect(loaded.length).toBeGreaterThan(RUNS_PAGE_SIZE);
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: daemon.answer,
      openStream: daemon.open,
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual(idsOf(loaded.slice(0, RUNS_PAGE_SIZE)));
    });

    // A run starts mid-walk and its notice has not landed: the next page still begins where
    // page 1 ended, so no loaded run is pushed onto page 2 and drawn twice.
    const arrived = {
      ...loaded[0]!,
      workflowRunId: mintedRunId(1),
      definitionName: mintedRunId(1),
    };
    daemon.arrive(arrived, { isNotified: false });
    await press("Load earlier");
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual(idsOf(loaded));
    });
    const pageReads = mounted.calls
      .filter((call) => call.method === "workflow.runList")
      .map((call) => (call.params as { readonly cursor?: string }).cursor);
    expect(pageReads.at(-1)).toBe(loaded[RUNS_PAGE_SIZE - 1]?.workflowRunId);
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();

    // Its notice lands: it stands on top, and every run already loaded stays below it.
    await act(async () => {
      daemon.notify(arrived);
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual([arrived.workflowRunId, ...idsOf(loaded)]);
    });
  });

  it("reads once when the last run drawn is deleted, stopping at the run below it", async () => {
    const daemon = new RunListDaemon(runsNamedById());
    const loaded = daemon.rows;
    const removed = loaded[RUNS_PAGE_SIZE - 1];
    const below = loaded[RUNS_PAGE_SIZE];
    if (removed === undefined || below === undefined) {
      throw new Error("the playback holds no run past the first page");
    }
    // The run below started before the one removed, which is how the read knows it went past.
    const belowStart = parseInstant(below.startedAt);
    const removedStart = parseInstant(removed.startedAt);
    expect(compareInstants(belowStart, removedStart)).toBe(-1);
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: daemon.answer,
      openStream: daemon.open,
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual(idsOf(loaded.slice(0, RUNS_PAGE_SIZE)));
    });
    const pageReads = () => mounted.calls.filter((call) => call.method === "workflow.runList");
    const readsBefore = pageReads().length;

    await act(async () => {
      daemon.remove(removed.workflowRunId);
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual([
        ...idsOf(loaded.slice(0, RUNS_PAGE_SIZE - 1)),
        below.workflowRunId,
      ]);
    });
    expect(pageReads().length - readsBefore).toBe(1);
  });

  it("keeps the rows drawn when Load earlier fails, with the error and Try again below", async () => {
    const daemon = new RunListDaemon(runsNamedById());
    const loaded = daemon.rows;
    let isPageRefused = true;
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: async (call, passThrough) => {
        if (
          call.method === "workflow.runList" &&
          isPageRefused &&
          (call.params as { cursor?: string }).cursor !== undefined
        ) {
          throw new Error("The background service dropped the page.");
        }
        return daemon.answer(call, passThrough);
      },
      openStream: daemon.open,
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual(idsOf(loaded.slice(0, RUNS_PAGE_SIZE)));
    });

    await press("Load earlier");
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText("Could not load earlier runs")).toBeDefined();
    });
    // A rejection with no code of its own reads as the service not answering.
    expect(screen.getByText("The background service is not answering.")).toBeDefined();
    expect(drawnRunIds()).toStrictEqual(idsOf(loaded.slice(0, RUNS_PAGE_SIZE)));
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();

    isPageRefused = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(drawnRunIds()).toStrictEqual(idsOf(loaded));
    });
    expect(screen.queryByText("Could not load earlier runs")).toBeNull();
  });
});
