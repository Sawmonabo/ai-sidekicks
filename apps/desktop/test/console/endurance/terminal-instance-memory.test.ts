// @vitest-environment happy-dom
//
// The terminal-instance memory budget, measured — Plan-023 Phase 1C (T-023p-1C-7).
//
// `Spec-023 §Console Design (Meridian)` §Budgets bounds "one `terminal` pane
// instance at the default scrollback" at 20 MiB, and `budgets.json` carries the
// ceiling. This file is that row's `measuredBy`.
//
// WHY THE READING IS TAKEN HERE AND NOT BESIDE THE ADAPTER
//
// The row's own subject names three things — "the `@xterm/xterm` instance, its
// WebGL renderer, and the pane's own state" — and only one of them is reachable
// from a Node process driving `XtermTerminalAdapter` under a DOM shim. That
// arrangement was this row's gate for one day, 2026-09-02, and was withdrawn: the
// shim has no WebGL2, so every instance settled on the fallback renderer, and the
// pane's React tree, its lease fold, and its store state could not move the number
// the gate read. A measurement narrower than the budget it claims to enforce can
// report green over a pane well past the ceiling, which is the one failure a budget
// exists to catch.
//
// So the pane is held WHOLE here: the built console in a real Electron window, a
// `terminal` pane resolved out of the deck's own registry and mounted through a
// real React commit, its emulator on a live WebGL2 context, bound to a session the
// scenario engine has delivered into. The three claims that make that true are
// asserted rather than assumed — the renderer mode each instance REPORTS, the
// canvas the WebGL renderer draws into, and the session store's admitted event
// count — and each of them fails the run rather than degrading it. The window-side
// instrument that opens and proves the panes is `terminal-pane-harness.ts`; the heap
// reading itself is the tier's, from `heap-instrument.ts`.
//
// ONE SUBJECT, ONE VERDICT — AND WHY THE FIGURE IS A SUM
//
// The row bounds a populated terminal, so the gate has to price one. Its two
// components are not measurable in the same process in this revision, and pricing
// them SEPARATELY against the same ceiling is not a gate at all: each half would
// receive the whole 20 MiB, and a 19.5 MiB buffer beside a 1 MiB pane would pass
// two green checks while the instance the row names sat 500 kB over its ceiling.
// So both halves are measured here, at one width and one scrollback depth, and
// `evaluateBudget` is called ONCE, on their sum:
//
//   • the pane's standing cost — the emulator, its addons, its WebGL renderer, the
//     React tree, the lease fold, and the store state it reads — as the difference
//     one mounted pane makes to the real window's settled heap;
//   • what a FULL scrollback retains, driven through the real parser at the same
//     width by `measureFullScrollbackRetainedBytes`.
//
// The second half is measured in THIS process rather than in the window, and not by
// choice: the byte stream, the scrollback, and the resize report are `Plan-023
// §Console growth slate` row 3, which the growth port refuses by name, so no wire
// in this revision can put a line into a mounted pane. The sum is therefore a
// conservative reading of one terminal — two allocators, so the halves do not share
// a page — and it is the reading the ceiling is compared against. The day slate row
// 3 lands, the second half moves into the window and the sum becomes one delta.
//
// WHY THE BASELINE IS TAKEN AFTER A WARM-UP CYCLE
//
// `@xterm/xterm`, its five addons, and its stylesheet arrive across an `import()`
// the first time any terminal mounts, and that chunk is paid ONCE for the page.
// Measured from a cold baseline, the first instance's delta would carry the whole
// library and the run's own slope check — the control that keeps a fixed cost from
// being reported as the instance — would be comparing a library against a terminal.
// So one instance is opened and closed before the baseline is read; the scrollback
// half takes a warm-up fill before ITS baseline for the same reason.
//
// WHAT THIS FILE DOES NOT OWN. The adapter-level claims — that the scrollback
// evicts rather than grows, that a disposal gives the bytes back, and that a
// working day of open-and-close cycles leaves the page where it started — are
// `terminal-endurance.test.ts`'s and are not restated here. That file makes no
// ceiling claim of its own: this row has one gate, and it is below.
//
// Nor does it own the pane-count sweep. Opening the instances, reading the heap
// around each one, and deciding whether those readings agree well enough to be
// evidence about a pane is `terminal-instance-series.ts`'s, with its own cases beside
// it driving the rule over hand-written readings rather than over a window. What
// stays here is what the budget row says: which subject is priced, why the figure is
// a sum, and what fails the run.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedConsole } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { HeapSampler } from "../heap-sampling.js";
import { enduranceLaunchOptions } from "./console-workload.js";
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
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";
import {
  TERMINAL_BUDGET_MEASUREMENT_COLUMNS,
  TERMINAL_DEFAULT_SCROLLBACK_LINES,
} from "../../../src/renderer/src/console/core/constants.js";
import { TerminalRendererPool } from "../../../src/renderer/src/console/terminal/emulator/renderer-pool.js";
import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const TERMINAL_INSTANCE_BUDGET_ID = "terminal-instance-memory";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(TERMINAL_INSTANCE_BUDGET_ID);

/** This file's collector and settling loop, for the half measured in process. */
const heapSampler = new HeapSampler();

/**
 * The split this gate exists to catch, priced in bytes.
 *
 * Not a plausible reading and not measured from anything: it is the arithmetic
 * Codex's own counterexample names, held here so the combining is asserted rather
 * than merely performed. Each half passes the row's ceiling on its own and the sum
 * does not — which is exactly the state two separately gated halves would have
 * reported green.
 */
const PLANTED_SPLIT_PANE_BYTES = 1024 * 1024;
const PLANTED_SPLIT_SCROLLBACK_BYTES = Math.round(19.5 * 1024 * 1024);

/**
 * The row rewritten with a ceiling one byte under whatever was measured.
 *
 * The negative control, and it drives the REAL comparison rather than a
 * re-implementation of `<=`: without it, an `evaluateBudget` that returned
 * `withinBudget: true` unconditionally would satisfy the assertion above it and
 * this gate would report green over any pane at all.
 */
function budgetWithCeilingBelow(measuredCanonicalValue: number): ConsoleBudget {
  return {
    ...budget,
    limit: { ...budget.limit, canonicalValue: measuredCanonicalValue - 1 },
  };
}

describe("the terminal-instance memory budget row", () => {
  // The ceiling, the unit, and the row's `n/a`-versus-`enforced` consistency are the
  // budget tier's to hold (`test/console/budget/budgets.test.ts`) and are deliberately
  // not restated here. What only THIS file can say is that it is the harness the row
  // names — so a reading that moves away, or a row flipped back to ungated while this
  // gate keeps running and passing, fails here.
  it("is the harness the row names as its measurer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe(
      "apps/desktop/test/console/endurance/terminal-instance-memory.test.ts",
    );
    expect(budget.producedBy).toBe("T-023p-1C-7");
  });

  // The combining, asserted on figures rather than on a reading: two halves that each
  // pass the ceiling and together do not. This is the negative control for the sum —
  // without it, a gate that quietly went back to comparing one half would keep passing
  // every assertion in this file.
  it("fails a split that passes each half and exceeds the ceiling together", () => {
    expect(evaluateBudget(budget, PLANTED_SPLIT_PANE_BYTES).withinBudget).toBe(true);
    expect(evaluateBudget(budget, PLANTED_SPLIT_SCROLLBACK_BYTES).withinBudget).toBe(true);
    expect(
      evaluateBudget(budget, PLANTED_SPLIT_PANE_BYTES + PLANTED_SPLIT_SCROLLBACK_BYTES)
        .withinBudget,
      "a 1 MiB pane holding a 19.5 MiB buffer is over this row's ceiling, and a gate that " +
        "priced the two halves separately would have called it green twice",
    ).toBe(false);
  });
});

describe.skipIf(!bundleIsBuilt)("endurance — one populated terminal pane, held whole", () => {
  it("holds one populated pane instance under the budget's ceiling, and gives it back", async () => {
    // The scrollback half first, and given back before the window opens: the figure
    // is what a filled buffer retains, not what this process happens to be holding
    // while it drives another one.
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

    await withLaunchedConsole(
      enduranceLaunchOptions(TERMINAL_SCENARIO.id),
      async (consoleApplication) => {
        const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
        try {
          await openHarnessOnDeliveredSession(consoleApplication);
          // Every figure this case gates is a DIFFERENCE of two heap readings — the
          // pane's standing cost, the slope across instances, the teardown residue.
          // A launch reading Blink's default quantized, cached MemoryInfo reports
          // those as rounding, and the slope band swallows them, so the instrument
          // is proved before the arithmetic rather than assumed from a launch flag.
          await expectPreciseHeapInstrument(consoleApplication);

          // The warm-up cycle. Its whole purpose is to move the emulator chunk and every
          // other one-time page cost to the LEFT of the baseline, so the first instance's
          // delta below is an instance and not a library. It is paid here rather than
          // inside the sweep because a second sweep must not pay it again.
          await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
          await closeEveryPane(consoleApplication, 1);

          // ONE RE-MEASURE, AND ONLY ONE. Every figure below is a difference of two
          // ~13 MB heap readings, and the slope is a ratio of two of those, so a single
          // stochastic sweep cannot carry a hard gate: a loaded machine has produced a
          // 0.15 ratio on a tree whose idle ratio is 0.87. A sweep the rule rejects is
          // therefore taken again — once, so a genuine regression still fails rather
          // than retrying until the run gives the answer the gate wants.
          let series: TerminalInstanceSeries = await measureTerminalInstanceSeries(
            consoleApplication,
            heapProbe,
          );
          let admissibility = admissibilityOf(series);
          if (!admissibility.admissible) {
            process.stdout.write(
              `[console-endurance] re-measuring the terminal pane sweep: ${admissibility.reason}\n`,
            );
            series = await measureTerminalInstanceSeries(consoleApplication, heapProbe);
            admissibility = admissibilityOf(series);
          }

          // One subject, one verdict.
          const populatedInstanceBytes = series.paneStandingBytes + fullScrollbackBytes;
          const verdict = evaluateBudget(budget, populatedInstanceBytes);

          // Reported before the assertions, on the reason the two readings beside it in
          // this tier print theirs: a gate that speaks only when it fails gives a
          // reviewer no way to watch a margin shrink over months until the day it
          // crosses. Both halves are named, because a sum that moved is a question about
          // which half moved — and the per-instance intervals with them, because the
          // slope is now a claim about readings a reader can check against each other.
          process.stdout.write(
            `[console-endurance] populated terminal pane ` +
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
              `${String(Math.round(series.teardownResidueBytes / 1024))} kB still held after closing ` +
              `${String(MEASURED_INSTANCE_COUNT)}\n`,
          );

          // The slope control, and the first thing asserted: every figure under it is
          // arithmetic on the same readings, so a sweep that is not evidence about a
          // pane is not evidence about a budget either. The sentence names which of the
          // rule's three tests failed and what it read.
          expect(
            admissibility.admissible,
            admissibility.admissible
              ? ""
              : `the terminal pane sweep was inadmissible twice: ${admissibility.reason}`,
          ).toBe(true);

          // The verdict is taken on the SUM, and this is the assertion that keeps it
          // there: a gate quietly returned to pricing one half would still satisfy every
          // other expectation in this case.
          expect(
            verdict.measuredCanonicalValue,
            "this row's verdict must be taken on the populated pane, not on either half of it",
          ).toBe(series.paneStandingBytes + fullScrollbackBytes);

          expect(
            verdict.withinBudget,
            `${budget.label}: ${String(populatedInstanceBytes)} B (pane ${String(series.paneStandingBytes)} B ` +
              `+ scrollback ${String(fullScrollbackBytes)} B) against a ` +
              `${String(budget.limit.canonicalValue)} B ceiling`,
          ).toBe(true);

          // Each half has to be a figure. A pane delta at or below zero means the reading
          // moved the wrong way, and a scrollback half at zero means the sum above was
          // the pane alone — the exact state this gate was rebuilt to end. The pane half
          // is already past the noise floor by the time this runs; the floor is the
          // instrument's claim and this is the subject's.
          expect(
            series.paneStandingBytes,
            "mounting a terminal pane did not raise the renderer's heap at all, so the comparison above measured nothing",
          ).toBeGreaterThan(0);
          expect(
            fullScrollbackBytes,
            "a full scrollback retained nothing, so the gated sum is the empty pane again",
          ).toBeGreaterThan(0);

          // The leak half, pane-shaped: three whole panes came and went and the page is
          // back within one pane of where it started. Scaled by the sweep's per-instance
          // figure over all three observations, never by the first delta alone — both
          // bounds hung off that one difference, so a single under-read tightened this
          // one in the same run that made the slope fail, and one wobble failed two
          // controls as if they were two findings.
          expect(
            series.teardownResidueBytes,
            `${String(MEASURED_INSTANCE_COUNT)} panes were closed and ${String(Math.round(series.teardownResidueBytes / 1024))} kB is still held, ` +
              `against a per-instance cost of ${String(Math.round(series.perInstanceBytes / 1024))} kB`,
          ).toBeLessThan(series.perInstanceBytes * TEARDOWN_RESIDUE_FACTOR);

          // A ceiling planted one byte under the reading must fail the same comparison
          // this gate just passed.
          expect(
            evaluateBudget(budgetWithCeilingBelow(populatedInstanceBytes), populatedInstanceBytes)
              .withinBudget,
          ).toBe(false);
        } finally {
          // Detached before the wrapper closes the window: detaching a DevTools
          // session from a closed application raises, and the raise would replace
          // whatever the body was failing on with a teardown error. The window
          // itself is `withLaunchedConsole`'s to close.
          await heapProbe.detach();
        }
      },
    );
  });
});
