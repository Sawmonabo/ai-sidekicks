// The workflows screen's times move once a second for every going run together, on the clock's
// whole second, rather than waking the view at each run's own offset: a table of going runs
// started at scattered instants is woken once a second, not once per run. With nothing going, the
// view still wakes at midnight, where `8:30 AM` becomes `Yesterday 8:30 AM`.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunSummary } from "@ai-sidekicks/contracts/workflow/run/records";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { WORKFLOW_FIXTURE_NOW_MS } from "#fixtures/data/workflow/clock.js";
import {
  WORKFLOW_RUN_IDS,
  WORKFLOW_RUN_RECORDS,
  summaryOfRun,
} from "#fixtures/data/workflow/run/records.js";
import { useRunTimesNow } from "./useRunTimesNow.js";

/** A clock whose host can sleep: its reading moves on while no timer fires. */
class SleepingClock extends ManualClock {
  #sleptMs = 0;

  public override now(): number {
    return super.now() + this.#sleptMs;
  }

  public sleep(durationMs: number): void {
    this.#sleptMs += durationMs;
  }
}

/** Going runs started at scattered instants within the second. */
function scatteredGoingRuns(count: number): WorkflowRunSummary[] {
  const running = WORKFLOW_RUN_RECORDS.find(
    (run) => run.read.workflowRunId === WORKFLOW_RUN_IDS.running,
  );
  if (running === undefined) {
    throw new Error("the playback has no running run");
  }
  return Array.from({ length: count }, (_unused, index) => ({
    ...summaryOfRun(running),
    workflowRunId: `${running.read.workflowRunId.slice(0, -3)}${String(900 + index)}`,
    startedAt: new Date(WORKFLOW_FIXTURE_NOW_MS - 60_000 - index * 137).toISOString(),
  })) as WorkflowRunSummary[];
}

describe("the workflows screen's times", () => {
  it("wake once a second for every going run together", async () => {
    const clock = new SleepingClock(WORKFLOW_FIXTURE_NOW_MS + 250);
    const { bridge } = bridgeAnswering(async (_call, passThrough) => passThrough());
    const runs = scatteredGoingRuns(7);
    const instants: number[] = [];
    renderHook(
      () => {
        const instant = useRunTimesNow({
          drawn: [runs],
          isTicking: true,
          namesDays: true,
          isPartOfDayShown: false,
        });
        if (instants.at(-1) !== instant) {
          instants.push(instant);
        }
      },
      { wrapper: bridgeWrapper(bridge, clock) },
    );

    for (let step = 0; step < 300; step += 1) {
      await act(async () => {
        clock.advance(10);
      });
    }

    // A wake-up that lands late, after the host slept, catches up to the last whole second in
    // one step rather than to the late instant or one second at a time.
    clock.sleep(2_500);
    await act(async () => {
      clock.advance(750);
    });

    // The first reading, then one per whole second the clock crossed.
    expect(instants).toStrictEqual([
      WORKFLOW_FIXTURE_NOW_MS + 250,
      WORKFLOW_FIXTURE_NOW_MS + 1_000,
      WORKFLOW_FIXTURE_NOW_MS + 2_000,
      WORKFLOW_FIXTURE_NOW_MS + 3_000,
      WORKFLOW_FIXTURE_NOW_MS + 6_000,
    ]);
  });

  it("wake at midnight with nothing going, so a day's figures take their day word", async () => {
    const finished = WORKFLOW_RUN_RECORDS.find(
      (run) => run.read.workflowRunId === WORKFLOW_RUN_IDS.succeeded,
    );
    if (finished === undefined) {
      throw new Error("the playback has no succeeded run");
    }
    const midnight = new Date(2026, 8, 30).getTime();
    const clock = new ManualClock(midnight - 400);
    const { bridge } = bridgeAnswering(async (_call, passThrough) => passThrough());
    const runs = [summaryOfRun(finished)];
    const { result } = renderHook(
      () =>
        useRunTimesNow({
          drawn: [runs],
          isTicking: false,
          namesDays: true,
          isPartOfDayShown: false,
        }),
      { wrapper: bridgeWrapper(bridge, clock) },
    );

    expect(result.current).toBe(midnight - 400);
    await act(async () => {
      clock.advance(400);
    });
    expect(result.current).toBe(midnight);
  });
});
