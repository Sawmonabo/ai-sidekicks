// The time-to-first-transcript-row budget, measured from window show, in fixture mode.
// This file is the row's `measuredBy`, and it compares through the registry's own
// `evaluateBudget`, so the gate and the budget row share one number in one file.
//
// The instant a window is shown is a main-process act, and in an automated launch on macOS it
// is never performed: `src/main/windows/reveal.ts` leaves the window hidden with
// background throttling off, because a revealed one steals the person's focus and Space. So
// there is no `show` timestamp, and a wall clock read in either process would compare two clocks
// across a process boundary. The renderer records the instant itself: `revealWindow` runs from
// the console view's `did-finish-load`, so the window is shown no earlier than the page has
// drawn, and the renderer's own `first-contentful-paint` entry is the instant the window had
// something to show. It sits on
// `performance`'s monotonic transcript, where the end of the interval is also read, so the whole
// measurement is one clock in one process.
//
// The session route is opened, the frozen clock is walked over the concurrent-streaming script, and
// the first painted transcript row ends the interval, all inside one page function so no driver
// round trip sits between the steps. The one round trip inside the interval is the gap between the
// launch handshake settling and this function starting; it is reported separately rather than
// subtracted. The clock is walked because a fixture build's clock is frozen: the script's opening
// beats are what a live daemon would deliver at launch, and a run that never advanced would time a
// session that had not arrived.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { SCENARIO_FIXTURE_GLOBAL } from "#renderer/app/fixture/global-names.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  CONCURRENT_STREAMING_SESSION_ROUTE,
  TRANSCRIPT_ROW_SELECTOR,
  SESSION_SCREEN_SELECTOR,
  concurrentStreamingDeliverySchedule,
} from "./workload.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { BudgetRegistry } from "#scripts/budget/budget-registry.mts";
import { evaluateBudget } from "#scripts/budget/evaluation.mts";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const FIRST_TRANSCRIPT_ROW_BUDGET_ID = "time-to-first-transcript-row";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(FIRST_TRANSCRIPT_ROW_BUDGET_ID);

/**
 * How long the page function waits for each paint before giving up. Far above the budget: it
 * bounds an app that never mounted the transcript, not a slow one, and must be loose enough
 * that runner contention is not mistaken for it. Well under the tier's timeout so the failure
 * names the selector.
 */
const PAINT_WAIT_BUDGET_MS = 30_000;

/**
 * The stall the negative control plants, in milliseconds: over the row's ceiling on its own, so
 * the verdict does not depend on machine speed.
 */
const PLANTED_PAINT_STALL_MS: number = budget.limit.canonicalValue + 100;

/**
 * Why a launch produced no reading, one arm per place the page function gives up. The first two
 * say the instrument was not ready (no start instant, or no scenario handle); the last two say
 * the app did not paint (a body that never mounted, or one with no transcript row), which is
 * the regression this row exists to catch. One collapsed sentence would read as a harness
 * failure the person retries rather than investigates.
 */
type UnmeasuredLaunchCause =
  | "no-paint-entry"
  | "no-scenario-handle"
  | "pane-never-painted"
  | "row-never-painted";

/** A launch that produced no reading, and which of the four reasons it was. */
interface UnmeasuredLaunch {
  readonly unmeasured: UnmeasuredLaunchCause;
}

/** What one launch measured, on the renderer's own monotonic transcript. */
interface FirstTranscriptRowReading {
  /** `first-contentful-paint`, which is when the window was shown. */
  readonly windowShownAtMs: number;
  /** When this page function started — the driver's share of the interval. */
  readonly measurementStartedAtMs: number;
  /** The animation frame after the first row element was laid out. */
  readonly firstRowPaintedAtMs: number;
  readonly rowCount: number;
  readonly deliveredBeatCount: number;
}

/** One launch's outcome: the reading, or the reason there is none. */
type FirstTranscriptRowOutcome = FirstTranscriptRowReading | UnmeasuredLaunch;

/**
 * Open the concurrent-streaming session, deliver its script, and time the first painted row.
 *
 * Everything happens inside the renderer for one reason: a step issued from the
 * driver process costs a round trip, and a round trip inside an interval this short is the
 * harness measuring itself. The stall is an argument rather than a
 * second copy of this function, so the negative control drives the REAL instrument
 * rather than a re-implementation of it.
 */
async function measureFirstTranscriptRow(
  appUnderTest: AppUnderTest,
  plantedStallMilliseconds: number,
): Promise<FirstTranscriptRowOutcome> {
  const { stepMilliseconds, stepCount } = concurrentStreamingDeliverySchedule();
  return appUnderTest.window.evaluate(
    async ([
      sessionRouteHash,
      paneSelector,
      rowSelector,
      scenarioGlobalName,
      advanceMilliseconds,
      advanceCount,
      stallMilliseconds,
      paintWaitBudgetMs,
    ]: [
      string,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
    ]): Promise<FirstTranscriptRowOutcome> => {
      // The start instant is waited for, not read once: `first-contentful-paint` is recorded
      // when the renderer first paints content, and this function can begin before that because
      // the launch handshake settles on the window being ready. Waiting costs the measurement
      // nothing, as the entry carries the instant it happened, and the row cannot paint before
      // its document.
      const windowShownAtMs = await new Promise<number | null>((resolve) => {
        const recordedPaint = (): PerformanceEntry | undefined =>
          performance
            .getEntriesByType("paint")
            .find((entry) => entry.name === "first-contentful-paint");
        const alreadyRecorded = recordedPaint();
        if (alreadyRecorded !== undefined) {
          resolve(alreadyRecorded.startTime);
          return;
        }
        const observer = new PerformanceObserver(() => {
          const entry = recordedPaint();
          if (entry === undefined) {
            return;
          }
          observer.disconnect();
          clearTimeout(paintWaitTimer);
          resolve(entry.startTime);
        });
        const paintWaitTimer = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, paintWaitBudgetMs);
        // `buffered` so an entry recorded between the read above and this call is not lost.
        observer.observe({ type: "paint", buffered: true });
      });
      if (windowShownAtMs === null) {
        return { unmeasured: "no-paint-entry" };
      }
      // The scenario's handle is the console document's, which opened this window.
      const scenarioControl = (
        (window.opener ?? globalThis) as unknown as Record<
          string,
          { advance(milliseconds: number): void; deliveredBeatCount(): number } | undefined
        >
      )[scenarioGlobalName];
      if (scenarioControl === undefined) {
        return { unmeasured: "no-scenario-handle" };
      }
      const measurementStartedAtMs = performance.now();

      // Resolved on the animation frame after the element is in the layout, the frame it is
      // painted in. `null` means it never arrived inside the budget, reported as a failure and
      // not a slow figure.
      const paintedAt = (selector: string): Promise<number | null> =>
        new Promise((resolve) => {
          const resolveOnNextFrame = (): void => {
            requestAnimationFrame(() => {
              resolve(performance.now());
            });
          };
          // Already there: nothing is armed, so nothing is left running.
          if (document.querySelector(selector) !== null) {
            resolveOnNextFrame();
            return;
          }
          // The wait is stopped on the path that succeeds too, so no 30 s timer stays armed in
          // the process whose steady-state heap and frame time the sibling files read.
          const observer = new MutationObserver(() => {
            if (document.querySelector(selector) === null) {
              return;
            }
            observer.disconnect();
            clearTimeout(waitTimer);
            resolveOnNextFrame();
          });
          const waitTimer = setTimeout(() => {
            observer.disconnect();
            resolve(null);
          }, paintWaitBudgetMs);
          observer.observe(document.documentElement, { childList: true, subtree: true });
        });

      // Armed before the navigation, so a row arriving in the same commit as the pane is seen
      // rather than waited on for the whole budget.
      const firstRowPainted = paintedAt(rowSelector);
      globalThis.location.hash = sessionRouteHash;
      const panePainted = await paintedAt(paneSelector);
      if (panePainted === null) {
        return { unmeasured: "pane-never-painted" };
      }

      // The planted slow paint: a synchronous busy-wait on the main thread between window show
      // and the first row, the shape of the defect this budget exists to catch.
      if (stallMilliseconds > 0) {
        const stallUntil = performance.now() + stallMilliseconds;
        while (performance.now() < stallUntil) {
          /* hold the main thread, the way a slow boot path does */
        }
      }

      for (let step = 0; step < advanceCount; step += 1) {
        scenarioControl.advance(advanceMilliseconds);
      }

      const firstRowPaintedAtMs = await firstRowPainted;
      if (firstRowPaintedAtMs === null) {
        return { unmeasured: "row-never-painted" };
      }
      return {
        windowShownAtMs,
        measurementStartedAtMs,
        firstRowPaintedAtMs,
        rowCount: document.querySelectorAll(rowSelector).length,
        deliveredBeatCount: scenarioControl.deliveredBeatCount(),
      };
    },
    [
      CONCURRENT_STREAMING_SESSION_ROUTE,
      SESSION_SCREEN_SELECTOR,
      TRANSCRIPT_ROW_SELECTOR,
      SCENARIO_FIXTURE_GLOBAL,
      stepMilliseconds,
      stepCount,
      plantedStallMilliseconds,
      appUnderTest.bodyAllowance.boundedMs(PAINT_WAIT_BUDGET_MS),
    ] as [string, string, string, string, number, number, number, number],
  );
}

/** The measured interval, from the two instants the reading carries. */
function elapsedFromWindowShow(reading: FirstTranscriptRowReading): number {
  return reading.firstRowPaintedAtMs - reading.windowShownAtMs;
}

/**
 * What each unmeasured launch means and whose fault it is. The first two say the figure would
 * have been the harness's; the last two say the instrument worked and the app did not paint,
 * which is the defect this row measures, not a reason to re-run. Keyed by cause, so a fifth arm
 * is a compile error.
 */
const UNMEASURED_LAUNCH_SENTENCES: Readonly<Record<UnmeasuredLaunchCause, string>> = {
  "no-paint-entry":
    `the launched app recorded no first-contentful-paint ` +
    `entry inside ${String(PAINT_WAIT_BUDGET_MS)} ms, ` +
    "so the interval has no start instant: nothing was timed, and reporting a figure would be " +
    "reporting the harness",
  "no-scenario-handle":
    "the launched app exposed no scenario handle, so the " +
    "concurrent-streaming script was never delivered: " +
    "nothing was timed, and reporting a figure would be reporting the harness",
  "pane-never-painted":
    `the app never painted the session screen's pane inside ${String(PAINT_WAIT_BUDGET_MS)} ms. ` +
    "The instrument was ready and the app did not mount — this is an app failure, not a " +
    "harness that was not there yet, and re-running it will not change the answer",
  "row-never-painted":
    `the app painted the session screen's pane but no ` +
    `transcript row inside ${String(PAINT_WAIT_BUDGET_MS)} ms. ` +
    "An app that mounts no transcript row at all is the " +
    "regression this budget row exists to catch — " +
    "this is an app failure, not a harness that was not there yet",
};

/** The reading, or a failure naming which of the four things did not happen. */
function requireReading(outcome: FirstTranscriptRowOutcome): FirstTranscriptRowReading {
  if ("unmeasured" in outcome) {
    throw new Error(`${outcome.unmeasured}: ${UNMEASURED_LAUNCH_SENTENCES[outcome.unmeasured]}`);
  }
  return outcome;
}

/** One line per reading, printed whether it passed or failed. */
function reportReading(label: string, reading: FirstTranscriptRowReading): void {
  const verdict = evaluateBudget(budget, elapsedFromWindowShow(reading));
  process.stdout.write(
    `[endurance] ${label}: first transcript row ${elapsedFromWindowShow(reading).toFixed(1)} ms ` +
      `after window show, of a ${String(budget.limit.canonicalValue)} ms ceiling ` +
      `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
      `${(reading.measurementStartedAtMs - reading.windowShownAtMs).toFixed(1)} ms of it is the ` +
      `driver's launch handshake; ${String(reading.rowCount)} rows from ` +
      `${String(reading.deliveredBeatCount)} beats\n`,
  );
}

describe.skipIf(!bundleIsBuilt)("endurance — the first transcript row after launch", () => {
  it("paints the first transcript row inside the budget's ceiling", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      const reading = requireReading(await measureFirstTranscriptRow(appUnderTest, 0));

      // The run delivered a session rather than timing an empty one: the whole script is in and
      // it reached the screen.
      expect(reading.deliveredBeatCount).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
      expect(reading.rowCount).toBeGreaterThan(0);
      // The interval is a real one rather than two readings of the same instant.
      expect(reading.firstRowPaintedAtMs).toBeGreaterThan(reading.windowShownAtMs);

      reportReading("clean", reading);
      const verdict = evaluateBudget(budget, elapsedFromWindowShow(reading));
      expect(
        verdict.withinBudget,
        `${budget.label}: ${elapsedFromWindowShow(reading).toFixed(1)} ms against a ` +
          `${String(budget.limit.canonicalValue)} ms ceiling`,
      ).toBe(true);
    });
  });

  it("negative control: a planted slow paint crosses the same ceiling", async () => {
    // Without this the case above would pass over an instrument that reported a constant, or
    // whose two instants came from the same frame. The stall is a real synchronous hold on the
    // renderer's main thread driven through the same measurement function, so this gate's own
    // comparison is shown to fail on a slow boot.
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      const reading = requireReading(
        await measureFirstTranscriptRow(appUnderTest, PLANTED_PAINT_STALL_MS),
      );
      reportReading("planted stall", reading);

      expect(elapsedFromWindowShow(reading)).toBeGreaterThan(PLANTED_PAINT_STALL_MS);
      expect(
        evaluateBudget(budget, elapsedFromWindowShow(reading)).withinBudget,
        "an app that took longer than the ceiling to paint " +
          "its first row passed the budget, so this gate " +
          "would report green over the one failure it exists to catch",
      ).toBe(false);
    });
  });
});
