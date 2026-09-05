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
// instrument that produces those readings is `terminal-pane-harness.ts`.
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

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedConsole } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { HeapSampler } from "../heap-sampling.js";
import { enduranceLaunchOptions } from "./console-workload.js";
import { expectPreciseHeapInstrument } from "./heap-instrument.js";
import {
  measureFullScrollbackRetainedBytes,
  requireHeapCollector,
  TerminalAdapterWorkload,
} from "./terminal-adapter-workload.js";
import {
  closeEveryPane,
  openHarnessOnDeliveredSession,
  openPaneAndAwaitWebglReadiness,
  RendererHeapProbe,
} from "./terminal-pane-harness.js";
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
 * How many instances the slope is read over.
 *
 * Three: one gives a delta and no slope, two give a slope from a single interval
 * whose noise is the whole reading, and three give two intervals whose agreement is
 * itself evidence. More would spend a WebGL context per instance against a page
 * ledger capped at twelve for reasons `terminal/emulator/renderer-pool.ts` records.
 */
const MEASURED_INSTANCE_COUNT = 3;

/**
 * How far the later instances' slope may sit from the first instance's delta.
 *
 * A FACTOR rather than a byte figure, because a tolerance tight enough to mean
 * something at this revision's ~940 kB pane reading would be inside the noise once
 * the output stream lands and the same pane holds a filled buffer.
 *
 * The LOWER bound is the load-bearing half and the reason this control exists: a
 * first delta inflated by a one-time cost — the emulator chunk, a lazily created
 * texture atlas, a page-wide allocation the second instance reuses — shows up as a
 * slope that is a small FRACTION of it, which is precisely the shape of "a fixed
 * cost reported as the instance". That is not hypothetical here: before the
 * readings were taken behind a forced collection, this run measured a first
 * instance at 4,165 kB and a slope of MINUS 5,765 kB, because a later mount
 * triggered the collection the baseline had not had. The upper bound catches the
 * mirror image — a first instance costing less than its successors, which would
 * mean the gated figure is not the worst case it claims to be.
 *
 * The band is wide against what the instrument actually delivers: measured on macOS
 * over five runs, a first instance of 937-942 kB against a slope of 824-827 kB. The
 * absolute figures move by a few kilobytes between runs and the RATIO does not — it
 * read 0.88 in every one — which is the quantity this control is about. The width is
 * headroom for a different runner's allocator rather than slack this reading needs.
 *
 * Read against the PANE half alone, deliberately. The slope is a claim about what a
 * second pane costs, and the scrollback half is measured once for the subject rather
 * than per mounted instance.
 */
const SLOPE_AGREEMENT_LOWER_FACTOR = 0.5;
const SLOPE_AGREEMENT_UPPER_FACTOR = 2;

/**
 * How much of one pane's cost may still be held after every pane is closed.
 *
 * One pane's own figure. Three came and went, so a per-instance retention would
 * show three times over; anything under one instance cannot be a per-instance leak.
 * The claim is deliberately the weaker one — this file owns the pane-shaped
 * teardown, and the adapter's own churn accounting over a working day of cycles is
 * `terminal-endurance.test.ts`'s and is not duplicated here.
 */
const TEARDOWN_RESIDUE_FACTOR = 1;

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
          // delta below is an instance and not a library.
          await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
          await closeEveryPane(consoleApplication, 1);

          const baselineHeapBytes = await heapProbe.readSettledBytes();

          await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
          const oneInstanceHeapBytes = await heapProbe.readSettledBytes();
          const paneStandingBytes = oneInstanceHeapBytes - baselineHeapBytes;

          for (let instance = 2; instance <= MEASURED_INSTANCE_COUNT; instance += 1) {
            await openPaneAndAwaitWebglReadiness(consoleApplication, instance);
          }
          const everyInstanceHeapBytes = await heapProbe.readSettledBytes();
          const laterInstanceBytes =
            (everyInstanceHeapBytes - oneInstanceHeapBytes) / (MEASURED_INSTANCE_COUNT - 1);

          await closeEveryPane(consoleApplication, MEASURED_INSTANCE_COUNT);
          const afterTeardownHeapBytes = await heapProbe.readSettledBytes();
          const teardownResidueBytes = Math.max(0, afterTeardownHeapBytes - baselineHeapBytes);

          // One subject, one verdict.
          const populatedInstanceBytes = paneStandingBytes + fullScrollbackBytes;
          const verdict = evaluateBudget(budget, populatedInstanceBytes);

          // Reported before the assertions, on the reason the two readings beside it in
          // this tier print theirs: a gate that speaks only when it fails gives a
          // reviewer no way to watch a margin shrink over months until the day it
          // crosses. Both halves are named, because a sum that moved is a question about
          // which half moved.
          process.stdout.write(
            `[console-endurance] populated terminal pane ` +
              `${String(Math.round(populatedInstanceBytes / 1024))} kB ` +
              `of ${String(Math.round(budget.limit.canonicalValue / 1024))} kB ` +
              `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) = ` +
              `pane ${String(Math.round(paneStandingBytes / 1024))} kB + scrollback ` +
              `${String(Math.round(fullScrollbackBytes / 1024))} kB at ` +
              `${String(TERMINAL_DEFAULT_SCROLLBACK_LINES)} lines × ` +
              `${String(TERMINAL_BUDGET_MEASUREMENT_COLUMNS)} columns; ` +
              `later panes ${String(Math.round(laterInstanceBytes / 1024))} kB each; ` +
              `${String(Math.round(teardownResidueBytes / 1024))} kB still held after closing ` +
              `${String(MEASURED_INSTANCE_COUNT)}\n`,
          );

          // The verdict is taken on the SUM, and this is the assertion that keeps it
          // there: a gate quietly returned to pricing one half would still satisfy every
          // other expectation in this case.
          expect(
            verdict.measuredCanonicalValue,
            "this row's verdict must be taken on the populated pane, not on either half of it",
          ).toBe(paneStandingBytes + fullScrollbackBytes);

          expect(
            verdict.withinBudget,
            `${budget.label}: ${String(populatedInstanceBytes)} B (pane ${String(paneStandingBytes)} B ` +
              `+ scrollback ${String(fullScrollbackBytes)} B) against a ` +
              `${String(budget.limit.canonicalValue)} B ceiling`,
          ).toBe(true);

          // Each half has to be a figure. A pane delta at or below zero means the reading
          // moved the wrong way, and a scrollback half at zero means the sum above was
          // the pane alone — the exact state this gate was rebuilt to end.
          expect(
            paneStandingBytes,
            "mounting a terminal pane did not raise the renderer's heap at all, so the comparison above measured nothing",
          ).toBeGreaterThan(0);
          expect(
            fullScrollbackBytes,
            "a full scrollback retained nothing, so the gated sum is the empty pane again",
          ).toBeGreaterThan(0);

          // The slope control: the later panes cost about what the first one did, so the
          // pane half of the gated figure is the price of an instance rather than a
          // one-time cost the first instance happened to carry.
          expect(
            laterInstanceBytes,
            `later panes cost ${String(Math.round(laterInstanceBytes / 1024))} kB against the first pane's ` +
              `${String(Math.round(paneStandingBytes / 1024))} kB, so the gated figure is dominated by a cost that is ` +
              "paid once rather than per instance",
          ).toBeGreaterThan(paneStandingBytes * SLOPE_AGREEMENT_LOWER_FACTOR);
          expect(laterInstanceBytes).toBeLessThan(paneStandingBytes * SLOPE_AGREEMENT_UPPER_FACTOR);

          // The leak half, pane-shaped: three whole panes came and went and the page is
          // back within one pane of where it started.
          expect(
            teardownResidueBytes,
            `${String(MEASURED_INSTANCE_COUNT)} panes were closed and ${String(Math.round(teardownResidueBytes / 1024))} kB is still held`,
          ).toBeLessThan(paneStandingBytes * TEARDOWN_RESIDUE_FACTOR);

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
