// @vitest-environment happy-dom
//
// The terminal-instance memory budget: one `terminal` pane instance at the default scrollback is
// bounded at 20 MiB in `budgets.json`, and this file is that row's `measuredBy`.
//
// The reading is taken in a real window, not beside the adapter: the row's subject is the
// `@xterm/xterm` instance, its WebGL renderer and the pane's own state, and a Node process
// driving `XtermTerminalAdapter` under a DOM shim reaches only the first (no WebGL2, so every
// instance settles on the fallback renderer, and the React tree, lease fold and store state
// cannot move the number). A measurement narrower than the budget can report green over a pane
// well past the ceiling. So the pane is held whole: the built app in Electron, a `terminal`
// pane resolved from the pane layout's registry through a real React commit, its emulator on a
// live WebGL2 context, bound to a session the scenario engine has delivered into. The renderer
// mode each instance reports, the canvas the WebGL renderer draws into and the session store's
// admitted event count are asserted, and each fails the run rather than degrading it.
// `terminal-pane-harness.ts` is the window-side instrument; the heap reading is
// `heap-instrument.ts`'s.
//
// The figure is a sum priced once by `evaluateBudget`. Pricing the pane and the scrollback
// separately against the same ceiling is not a gate: each half would receive the whole 20 MiB,
// and a 19.5 MiB buffer beside a 1 MiB pane would pass two checks while the instance sat 500 kB
// over. The halves, at one width and scrollback depth:
//   - the pane's standing cost (emulator, addons, WebGL renderer, React tree, lease fold, store
//     state), as the difference one mounted pane makes to the window's settled heap;
//   - what a full scrollback retains, driven through the real parser by
//     `measureFullScrollbackRetainedBytes` in this process, because the byte stream, scrollback
//     and resize report have no wire yet to put a line into a mounted pane. The sum is
//     conservative for one terminal (two allocators, so the halves share no page).
//
// The baseline follows a warm-up cycle: `@xterm/xterm`, its five addons and its stylesheet
// arrive across an `import()` on the first mount, paid once for the page, and a cold baseline
// would make the first delta carry the library and the slope check compare a library against a
// terminal. The scrollback half takes a warm-up fill for the same reason.
//
// Not owned here: adapter-level claims (eviction, disposal giving bytes back, a working day of
// churn) are `xterm-adapter.test.ts`'s, and the pane-count sweep and its admissibility rule are
// `terminal-instance-series.ts`'s.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { HeapSampler } from "./heap-sampling.js";
import { enduranceLaunchOptions } from "./endurance-workload.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./heap-instrument.js";
import {
  measureFullScrollbackRetainedBytes,
  requireHeapCollector,
  TerminalAdapterWorkload,
} from "./terminal-adapter-workload.js";
import {
  closeEveryPane,
  openHarnessOnDeliveredSession,
  openPaneAndAwaitWebglReadiness,
} from "./terminal-pane-harness.js";
import {
  admissibilityOf,
  measureTerminalInstanceSeries,
  MEASURED_INSTANCE_COUNT,
  TEARDOWN_RESIDUE_FACTOR,
  type TerminalInstanceSeries,
} from "./terminal-instance-series.js";
import { TERMINAL_LEASE_SCENARIO } from "../../fixtures/scenarios/terminal-lease.js";
import {
  TERMINAL_BUDGET_MEASUREMENT_COLUMNS,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
} from "@renderer/features/terminal/terminal-caps.js";
import { TerminalRendererPool } from "@renderer/features/terminal/emulator/renderer-pool.js";
import { BudgetRegistry } from "../../scripts/budget/budget-registry.mts";
import { evaluateBudget } from "../../scripts/budget/budget-evaluation.mts";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const TERMINAL_INSTANCE_BUDGET_ID = "terminal-instance-memory";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(TERMINAL_INSTANCE_BUDGET_ID);

/** This file's collector and settling loop, for the half measured in process. */
const heapSampler = new HeapSampler();

describe.skipIf(!bundleIsBuilt)("endurance — one populated terminal pane, held whole", () => {
  it(
    "holds one populated pane instance under " + "the budget's ceiling, and gives it back",
    async () => {
      // The scrollback half first, and given back before the window opens: the figure is what a
      // filled buffer retains, not what this process holds while it drives another one.
      requireHeapCollector(heapSampler);
      const adapterWorkload = new TerminalAdapterWorkload();
      let fullScrollbackBytes: number;
      try {
        fullScrollbackBytes = await measureFullScrollbackRetainedBytes(
          adapterWorkload,
          new TerminalRendererPool(),
          heapSampler,
        );
      } finally {
        adapterWorkload.disposeEverything();
      }

      await withLaunchedApp(
        enduranceLaunchOptions(TERMINAL_LEASE_SCENARIO.id),
        async (appUnderTest) => {
          const heapProbe = await RendererHeapProbe.attachTo(appUnderTest);
          try {
            await openHarnessOnDeliveredSession(appUnderTest);
            // Every figure gated here is a difference of two heap readings, and a launch reading
            // Blink's default quantized, cached MemoryInfo reports those as rounding that the slope
            // band swallows, so the instrument is proved before the arithmetic.
            await expectPreciseHeapInstrument(appUnderTest, heapProbe);

            // The warm-up cycle moves the emulator chunk and every other one-time page cost left of
            // the baseline, so the first instance's delta is an instance and not a library. It is
            // paid here rather than in the sweep because a second sweep must not pay it again.
            await openPaneAndAwaitWebglReadiness(appUnderTest, 1);
            await closeEveryPane(appUnderTest, 1);

            // One re-measure, and only one. Every figure is a difference of two ~13 MB heap
            // readings and the slope a ratio of two of those, so one stochastic sweep cannot carry
            // a hard gate: a loaded machine produced a 0.15 ratio where idle reads 0.87. A rejected
            // sweep is taken again once, so a genuine regression still fails rather than retrying
            // until the gate gets the answer it wants.
            let series: TerminalInstanceSeries = await measureTerminalInstanceSeries(
              appUnderTest,
              heapProbe,
            );
            let admissibility = admissibilityOf(series);
            if (!admissibility.admissible) {
              process.stdout.write(
                `[endurance] re-measuring the terminal pane sweep: ${admissibility.reason}\n`,
              );
              series = await measureTerminalInstanceSeries(appUnderTest, heapProbe);
              admissibility = admissibilityOf(series);
            }

            // One subject, one verdict.
            const populatedInstanceBytes = series.paneStandingBytes + fullScrollbackBytes;
            const verdict = evaluateBudget(budget, populatedInstanceBytes);

            // Reported before the assertions so a shrinking margin is visible. Both halves are
            // named because a sum that moved raises which half moved, and the per-instance
            // intervals so the slope's readings can be checked against each other.
            process.stdout.write(
              `[endurance] populated terminal pane ` +
                `${String(Math.round(populatedInstanceBytes / 1024))} kB ` +
                `of ${String(Math.round(budget.limit.canonicalValue / 1024))} kB ` +
                `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) = ` +
                `pane ${String(Math.round(series.paneStandingBytes / 1024))} kB + scrollback ` +
                `${String(Math.round(fullScrollbackBytes / 1024))} kB at ` +
                `${String(TERMINAL_DEFAULT_SCROLLBACK_LINES)} lines × ` +
                `${String(TERMINAL_BUDGET_MEASUREMENT_COLUMNS)} columns; ` +
                `later panes ${String(Math.round(series.laterInstanceBytes / 1024))} kB each ` +
                `[${series.perInstanceIntervalBytes
                  .map((interval) => `${String(Math.round(interval / 1024))} kB`)
                  .join(", ")}]; ` +
                `${String(Math.round(series.teardownResidueBytes / 1024))}` +
                ` kB still held after closing ` +
                `${String(MEASURED_INSTANCE_COUNT)}\n`,
            );

            // The slope control comes first: every figure below is arithmetic on the same
            // readings, so a sweep that is not evidence about a pane is not evidence about a
            // budget. The sentence names which of the rule's three tests failed and what it read.
            expect(
              admissibility.admissible,
              admissibility.admissible
                ? ""
                : `the terminal pane sweep was inadmissible twice: ${admissibility.reason}`,
            ).toBe(true);

            // The verdict is taken on the sum; a gate that returned to pricing one half would
            // still satisfy every other expectation here.
            expect(
              verdict.measuredCanonicalValue,
              "this row's verdict must be taken on the populated pane, not on either half of it",
            ).toBe(series.paneStandingBytes + fullScrollbackBytes);

            expect(
              verdict.withinBudget,
              `${budget.label}: ${String(populatedInstanceBytes)} ` +
                `B (pane ${String(series.paneStandingBytes)} B ` +
                `+ scrollback ${String(fullScrollbackBytes)} B) against a ` +
                `${String(budget.limit.canonicalValue)} B ceiling`,
            ).toBe(true);

            // Each half has to be a figure. A pane delta at or below zero means the reading moved
            // the wrong way, and a scrollback half at zero means the sum was the pane alone. The
            // pane half is already past the noise floor by now; the floor is the instrument's
            // claim and this is the subject's.
            expect(
              series.paneStandingBytes,
              "mounting a terminal pane did not raise the renderer's " +
                "heap at all, so the comparison above measured nothing",
            ).toBeGreaterThan(0);
            expect(
              fullScrollbackBytes,
              "a full scrollback retained nothing, so the gated sum is the empty pane again",
            ).toBeGreaterThan(0);

            // The leak half, pane-shaped: three whole panes came and went and the page is back
            // within one pane of where it started. Scaled by the sweep's per-instance figure over
            // all three observations, never the first delta alone, so one under-read cannot
            // tighten this bound in the same run that fails the slope.
            expect(
              series.teardownResidueBytes,
              `${String(MEASURED_INSTANCE_COUNT)} panes were closed and ` +
                `${String(Math.round(series.teardownResidueBytes / 1024))} kB is still held, ` +
                `against a per-instance cost of ` +
                `${String(Math.round(series.perInstanceBytes / 1024))} kB`,
            ).toBeLessThan(series.perInstanceBytes * TEARDOWN_RESIDUE_FACTOR);
          } finally {
            // Detached before the window closes: detaching from a closed application raises and
            // would replace whatever the body was failing on. `withLaunchedApp` closes the window.
            await heapProbe.detach();
          }
        },
      );
    },
  );
});
