// The time-to-first-ledger-row budget, measured — Plan-023 Phase 1C.
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds "time to first ledger row
// on launch" at 800 ms from window show, in fixture mode. This file is the row's
// `measuredBy`, and it compares through the registry's own `evaluateBudget`, so
// the number this gate uses and the number the spec wrote are one number read from
// one file.
//
// WHAT STANDS IN FOR "WINDOW SHOW", AND WHY IT IS NOT A CLOCK READ
//
// The instant a window is put on screen is a MAIN-process act, and in an automated
// launch on macOS it is deliberately never performed at all: `src/main/window-reveal.ts`
// leaves the window hidden with background throttling off, because a revealed one
// steals the operator's focus and Space. So there is no `show` timestamp to read,
// and reading a wall clock in either process to manufacture one would be comparing
// two clocks across a process boundary to answer a question about one renderer.
//
// The renderer records the instant itself. `revealWindow` is called from
// `ready-to-show`, which Electron emits once the web page has been rendered, so the
// renderer's own `first-contentful-paint` entry IS the instant the window became
// showable and was shown or deliberately left hidden. It sits on
// `performance`'s monotonic timeline, which is also where the end of the interval
// is read, so the whole measurement is one clock in one process.
//
// WHAT THE INTERVAL CONTAINS
//
// The session route is opened, the frozen clock is walked over the flagship script,
// and the first painted ledger row ends the interval — all inside ONE page function,
// so no driver round trip sits between the steps. The one round trip that IS inside
// the interval is the gap between the launch handshake settling and this page
// function starting; it is reported separately rather than subtracted, because a
// figure with a correction in it is a figure nobody can check. Measured on this
// machine that share is 15–23 ms of a 45–50 ms reading.
//
// The clock has to be walked at all because a fixture build's clock is frozen and
// moves only when told to: the flagship script's opening beats are what a live
// daemon would deliver on its own at launch, and a run that never advanced would be
// timing a session that had not arrived.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedConsole, type ConsoleApplication } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { SCENARIO_FIXTURE_GLOBAL } from "../fixture-handles.js";
import {
  ENDURANCE_LAUNCH_OPTIONS,
  FLAGSHIP_SESSION_ROUTE,
  LEDGER_ROW_SELECTOR,
  WORKSPACE_SURFACE_SELECTOR,
  flagshipDeliverySchedule,
} from "./console-workload.js";
import { FLAGSHIP_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";
import { ConsoleBudgetRegistry, evaluateBudget } from "../../../scripts/budget/budget-registry.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const FIRST_LEDGER_ROW_BUDGET_ID = "time-to-first-ledger-row";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(FIRST_LEDGER_ROW_BUDGET_ID);

/**
 * How long the page function waits for a surface before giving up on it.
 *
 * Far above the budget it is measuring — this bounds a console that never mounted
 * the ledger at all, which is a different failure from a slow one, and it has to
 * be loose enough that runner contention is never mistaken for it. Well under the
 * tier's own timeout, so the failure names the selector rather than the whole test.
 */
const SURFACE_WAIT_BUDGET_MS = 30_000;

/**
 * The stall the negative control plants, in milliseconds.
 *
 * Comfortably over the 800 ms ceiling on its own, so the control's verdict does not
 * depend on how fast the machine underneath it happens to be: a run where the
 * console's own work is free still crosses, and a run on a slow machine crosses by
 * more. Measured 931 ms against a 45–50 ms clean reading on an eight-core laptop.
 */
const PLANTED_PAINT_STALL_MS = 900;

/**
 * Why a launch produced no reading — one arm per place the page function gives up.
 *
 * Four arms rather than one `null`, because they are not one condition and they are
 * not even one KIND of condition. The first two say the instrument was not ready:
 * no start instant to measure from, or no scenario handle to deliver the script
 * through. The last two say the console did not paint — a body that never mounted,
 * or a body that mounted with no ledger row in it — which is precisely the
 * regression this budget row exists to catch. Reported as one sentence they are
 * indistinguishable, and the sentence a collapsed failure has to use is the harness
 * one, which is the message an operator retries rather than investigates.
 */
type UnmeasuredLaunchCause =
  | "no-paint-entry"
  | "no-scenario-handle"
  | "body-never-painted"
  | "row-never-painted";

/** A launch that produced no reading, and which of the four reasons it was. */
interface UnmeasuredLaunch {
  readonly unmeasured: UnmeasuredLaunchCause;
}

/** What one launch measured, on the renderer's own monotonic timeline. */
interface FirstLedgerRowReading {
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
type FirstLedgerRowOutcome = FirstLedgerRowReading | UnmeasuredLaunch;

/**
 * Open the flagship session, deliver its script, and time the first painted row.
 *
 * Everything happens inside the renderer for one reason: a step issued from the
 * driver process costs a round trip, and a round trip inside an interval bounded at
 * 800 ms is the harness measuring itself. The stall is an argument rather than a
 * second copy of this function, so the negative control drives the REAL instrument
 * rather than a re-implementation of it.
 */
async function measureFirstLedgerRow(
  consoleApplication: ConsoleApplication,
  plantedStallMilliseconds: number,
): Promise<FirstLedgerRowOutcome> {
  const { stepMilliseconds, stepCount } = flagshipDeliverySchedule();
  return consoleApplication.window.evaluate(
    async ([
      sessionRouteHash,
      bodySelector,
      rowSelector,
      scenarioGlobalName,
      advanceMilliseconds,
      advanceCount,
      stallMilliseconds,
      surfaceWaitBudgetMs,
    ]: [
      string,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
    ]): Promise<FirstLedgerRowOutcome> => {
      const paintEntry = performance
        .getEntriesByType("paint")
        .find((entry) => entry.name === "first-contentful-paint");
      if (paintEntry === undefined) {
        return { unmeasured: "no-paint-entry" };
      }
      const scenarioControl = (
        globalThis as unknown as Record<
          string,
          { advance(milliseconds: number): void; deliveredBeatCount(): number } | undefined
        >
      )[scenarioGlobalName];
      if (scenarioControl === undefined) {
        return { unmeasured: "no-scenario-handle" };
      }
      const measurementStartedAtMs = performance.now();

      // Resolved on the animation frame AFTER the element is in the layout, which
      // is the frame it is painted in. `null` means it never arrived inside the
      // budget, which the caller reports as a failure rather than as a slow figure.
      const paintedAt = (selector: string): Promise<number | null> =>
        new Promise((resolve) => {
          const resolveOnNextFrame = (): void => {
            requestAnimationFrame(() => {
              resolve(performance.now());
            });
          };
          // Already there: nothing is armed at all, so there is nothing to leave
          // running either.
          if (document.querySelector(selector) !== null) {
            resolveOnNextFrame();
            return;
          }
          // AND THE WAIT IS STOPPED ON THE PATH THAT SUCCEEDS, not only on the one
          // that fires it. A resolved wait used to leave a 30 s timer armed for the
          // rest of the launch — two of them per measured run, inside the very
          // process whose steady-state heap and frame time the sibling endurance
          // files read.
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
          }, surfaceWaitBudgetMs);
          observer.observe(document.documentElement, { childList: true, subtree: true });
        });

      // Armed before the navigation, so a row that arrives in the same commit as
      // the body is still seen: an observer installed afterwards would miss it and
      // then wait out the whole budget for a row already on the page.
      const firstRowPainted = paintedAt(rowSelector);
      globalThis.location.hash = sessionRouteHash;
      const bodyPainted = await paintedAt(bodySelector);
      if (bodyPainted === null) {
        return { unmeasured: "body-never-painted" };
      }

      // The planted slow paint. A synchronous busy-wait on the main thread between
      // the window being shown and the first row being drawn — which is exactly the
      // shape of the defect this budget exists to catch, rather than a synthetic
      // delay bolted onto the measurement.
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
        windowShownAtMs: paintEntry.startTime,
        measurementStartedAtMs,
        firstRowPaintedAtMs,
        rowCount: document.querySelectorAll(rowSelector).length,
        deliveredBeatCount: scenarioControl.deliveredBeatCount(),
      };
    },
    [
      FLAGSHIP_SESSION_ROUTE,
      WORKSPACE_SURFACE_SELECTOR,
      LEDGER_ROW_SELECTOR,
      SCENARIO_FIXTURE_GLOBAL,
      stepMilliseconds,
      stepCount,
      plantedStallMilliseconds,
      SURFACE_WAIT_BUDGET_MS,
    ] as [string, string, string, string, number, number, number, number],
  );
}

/** The measured interval, from the two instants the reading carries. */
function elapsedFromWindowShow(reading: FirstLedgerRowReading): number {
  return reading.firstRowPaintedAtMs - reading.windowShownAtMs;
}

/**
 * What each unmeasured launch means, and — the load-bearing half — whose fault it is.
 *
 * The first two sentences say the figure would have been the harness's. The last two
 * say the opposite in as many words: the instrument worked, the console did not
 * paint, and that is the defect this row measures rather than a reason to re-run.
 * Keyed by the cause so the set is closed here and a fifth arm is a compile error.
 */
const UNMEASURED_LAUNCH_SENTENCES: Readonly<Record<UnmeasuredLaunchCause, string>> = {
  "no-paint-entry":
    "the launched console recorded no first-contentful-paint entry, so the interval has no start " +
    "instant: nothing was timed, and reporting a figure would be reporting the harness",
  "no-scenario-handle":
    "the launched console exposed no scenario handle, so the flagship script was never delivered: " +
    "nothing was timed, and reporting a figure would be reporting the harness",
  "body-never-painted":
    `the console never painted the workspace body inside ${String(SURFACE_WAIT_BUDGET_MS)} ms. ` +
    "The instrument was ready and the console did not mount — this is a console failure, not a " +
    "harness that was not there yet, and re-running it will not change the answer",
  "row-never-painted":
    `the console painted its workspace body but no ledger row inside ${String(SURFACE_WAIT_BUDGET_MS)} ms. ` +
    "A console that mounts no ledger row at all is the regression this budget row exists to catch — " +
    "this is a console failure, not a harness that was not there yet",
};

/** The reading, or a failure naming which of the four things did not happen. */
function requireReading(outcome: FirstLedgerRowOutcome): FirstLedgerRowReading {
  if ("unmeasured" in outcome) {
    // The arm is the asserted value, so the diff line names it and the message
    // explains it — a collapsed sentence is what made a console that mounts no
    // ledger read as a harness that was not ready.
    expect(outcome.unmeasured, UNMEASURED_LAUNCH_SENTENCES[outcome.unmeasured]).toBeUndefined();
    throw new Error("unreachable: the assertion above fails first");
  }
  return outcome;
}

/** One line per reading, printed whether it passed or failed. */
function reportReading(label: string, reading: FirstLedgerRowReading): void {
  const verdict = evaluateBudget(budget, elapsedFromWindowShow(reading));
  process.stdout.write(
    `[console-endurance] ${label}: first ledger row ${elapsedFromWindowShow(reading).toFixed(1)} ms ` +
      `after window show, of a ${String(budget.limit.canonicalValue)} ms ceiling ` +
      `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget); ` +
      `${(reading.measurementStartedAtMs - reading.windowShownAtMs).toFixed(1)} ms of it is the ` +
      `driver's launch handshake; ${String(reading.rowCount)} rows from ` +
      `${String(reading.deliveredBeatCount)} beats\n`,
  );
}

describe("the time-to-first-ledger-row budget row", () => {
  // The ceiling and the unit are the budget tier's to hold. What only THIS file can
  // say is that it is the harness the row names — so a reading that moves away, or a
  // row flipped back to ungated while this gate keeps running and passing, fails here.
  it("is the harness the row names as its measurer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe("apps/desktop/test/console/endurance/first-ledger-row.test.ts");
    expect(budget.notMeasurableReason).toBeNull();
  });
});

describe.skipIf(!bundleIsBuilt)("endurance — the first ledger row after launch", () => {
  it("paints the first ledger row inside the budget's ceiling", async () => {
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const reading = requireReading(await measureFirstLedgerRow(consoleApplication, 0));

      // The run delivered a session rather than timing an empty one. Both halves
      // are load-bearing: the whole script is in, and it reached the screen.
      expect(reading.deliveredBeatCount).toBe(FLAGSHIP_SCENARIO.beats.length);
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
    // Without this the case above would pass over an instrument that reported a
    // constant, or one whose two instants came from the same frame. The stall is a
    // real synchronous hold on the renderer's main thread, planted between the
    // window being shown and the ledger's first row, and it is driven through the
    // SAME measurement function — so what is shown is that this gate's own
    // comparison fails on a console that boots slowly.
    await withLaunchedConsole(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      const reading = requireReading(
        await measureFirstLedgerRow(consoleApplication, PLANTED_PAINT_STALL_MS),
      );
      reportReading("planted stall", reading);

      expect(elapsedFromWindowShow(reading)).toBeGreaterThan(PLANTED_PAINT_STALL_MS);
      expect(
        evaluateBudget(budget, elapsedFromWindowShow(reading)).withinBudget,
        "a console that took nearly a second to paint its first row passed the budget, so this gate " +
          "would report green over the one failure it exists to catch",
      ).toBe(false);
    });
  });
});
