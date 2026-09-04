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
// So the subject is held WHOLE here: the built console in a real Electron window,
// a `terminal` pane resolved out of the deck's own registry and mounted through a
// real React commit, its emulator on a live WebGL2 context, bound to a session the
// scenario engine has delivered into. The three claims that make that true are
// asserted rather than assumed — the renderer mode each instance REPORTS, the
// canvas the WebGL renderer draws into, and the session store's admitted event
// count — and each of them fails the run rather than degrading it.
//
// WHAT THE HARNESS IS, AND WHY IT IS NOT A DECK
//
// Nothing in this revision mounts a registered pane: `registerConsolePanes` claims
// the `terminal` kind and the deck that would resolve a descriptor out of that
// registry is a later family's. `console/frame/PaneHarnessSurface.tsx` is the
// smallest honest door — a `define`-gated fixture surface, reached at
// `#/pane-harness/<paneKind>/<sessionId>`, that resolves the body through
// `ConsolePaneRegistry` and mounts one more of it per press. It is deliberately not
// a deck: a reading taken inside one would fold the deck's tab strip, layout, and
// drag machinery into a figure the row scopes to a pane INSTANCE, and would report
// a pane over budget for the deck's own cost. The deck's absence from the subject
// is closer to the row's sentence than its presence would be.
//
// WHY THE BASELINE IS TAKEN AFTER A WARM-UP CYCLE
//
// `@xterm/xterm`, its five addons, and its stylesheet arrive across an `import()`
// the first time any terminal mounts, and that chunk is paid ONCE for the page.
// Measured from a cold baseline, the first instance's delta would carry the whole
// library and the run's own slope check — the control that keeps a fixed cost from
// being reported as the instance — would be comparing a library against a terminal.
// So one instance is opened and closed before the baseline is read, which is the
// same discipline `terminal-endurance.test.ts` applies to its churn reading.
//
// WHAT THE FIGURE COVERS, AND THE ONE HALF IT CANNOT YET
//
// The emulator this pane mounts has an empty BUFFER, and not by choice: the byte
// stream, the scrollback, and the resize report are `Plan-023 §Console growth
// slate` row 3, which the growth port refuses by name, so no wire in this revision
// can put a line into a terminal pane. The figure is therefore the pane's own
// standing cost — the emulator, its addons, its WebGL renderer, the React tree, the
// lease fold, and the store state it reads — at the default scrollback SETTING,
// with nothing scrolled back. The other half of this ceiling, what a FULL buffer
// costs, is bounded against this same row by `terminal-endurance.test.ts`, which
// drives twice the default scrollback through the real parser in process and
// compares the retained bytes to this budget as a reference figure. The two
// together cover the row; neither covers it alone, and the day slate row 3 lands
// this harness drives bytes into the mounted pane and the figure moves.
//
// WHAT THIS FILE DOES NOT OWN. The adapter-level claims — that the scrollback
// evicts rather than grows, that a disposal gives the bytes back, and that a
// working day of open-and-close cycles leaves the page where it started — are
// `terminal-endurance.test.ts`'s and are not restated here. This file reads that
// file's subject one level up and adds the only claim it cannot make: what a whole
// pane costs.

import process from "node:process";

import { describe, expect, it } from "vitest";

import type { CDPSession } from "@playwright/test";

import {
  fixtureBundleExists,
  launchConsole,
  type ConsoleApplication,
} from "../electron-harness.js";
import {
  advanceScenario,
  readAppliedEventCount,
  readSettledHeapBytes,
} from "./console-workload.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../../src/renderer/src/console/core/constants.js";
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

/** The pane kind the address names. The harness is per kind; this row is this one. */
const MEASURED_PANE_KIND = "terminal";

/** Where the harness opens, with the pane kind and the session it binds to. */
const HARNESS_ROUTE = `#/pane-harness/${MEASURED_PANE_KIND}/${encodeURIComponent(TERMINAL_SCENARIO.sessionId)}`;

/** The harness surface's accessible name, and the control it offers. */
const HARNESS_SURFACE_SELECTOR = '[aria-label="Pane harness"]';
const OPEN_CONTROL_NAME = "Open a pane";
const CLOSE_CONTROL_NAME = "Close the newest pane";

/** The emulator's mount box, and the attribute on which it reports its renderer. */
const TERMINAL_HOST_SELECTOR = ".meridian-terminal-host";

/**
 * How many instances the slope is read over.
 *
 * Three: one gives a delta and no slope, two give a slope from a single interval
 * whose noise is the whole reading, and three give two intervals whose agreement is
 * itself evidence. More would spend a WebGL context per instance against a page
 * ledger capped at twelve for reasons `terminal/renderer-pool.ts` records.
 */
const MEASURED_INSTANCE_COUNT = 3;

/**
 * How far the later instances' slope may sit from the first instance's delta.
 *
 * A FACTOR rather than a byte figure, because a tolerance tight enough to mean
 * something at this revision's ~940 kB reading would be inside the noise once the
 * output stream lands and the same pane holds a filled buffer.
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
 */
const SLOPE_AGREEMENT_LOWER_FACTOR = 0.5;
const SLOPE_AGREEMENT_UPPER_FACTOR = 2;

/**
 * How much of one instance's cost may still be held after every pane is closed.
 *
 * One instance's own figure. Three came and went, so a per-instance retention would
 * show three times over; anything under one instance cannot be a per-instance leak.
 * The claim is deliberately the weaker one — this file owns the pane-shaped
 * teardown, and the adapter's own churn accounting over a working day of cycles is
 * `terminal-endurance.test.ts`'s and is not duplicated here.
 */
const TEARDOWN_RESIDUE_FACTOR = 1;

/** How long a pane may take to mount its emulator and settle on a renderer. */
const PANE_READINESS_TIMEOUT_MS = 60_000;

/** How long the harness surface itself may take to appear after the navigation. */
const ROUTE_TRANSITION_TIMEOUT_MS = 30_000;

/** How many advances the terminal script is walked in, and how many drain it. */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * How many collect-and-yield rounds precede a reading.
 *
 * The same number and the same reasoning as `test/console/heap-sampling.ts`'s
 * `SETTLE_ROUNDS`, one process over: one collection reclaims what is unreachable at
 * that instant, and a disposed emulator releases its observers, its listeners, and
 * its detached canvas across a task boundary rather than inside the call that
 * disposed it.
 */
const COLLECTION_ROUNDS = 4;

/**
 * The renderer's heap, read after its garbage has actually been collected.
 *
 * WHY A FORCED COLLECTION AND NOT THE SAMPLER ALONE. `readSettledHeapBytes` takes
 * the minimum over settling samples, which is the right discipline for a figure
 * bounded ONCE — the tier's at-rest ceiling — because the incremental collector
 * gets several chances to run and the smallest reading is the floor. It is not
 * enough for a DIFFERENCE of a few megabytes taken five times across one run: the
 * first pane's mount leaves the emulator chunk's own allocations uncollected, a
 * later mount triggers a major collection that reclaims them, and the second
 * instance then reads as NEGATIVE — measured on this code, −5.8 MB per instance,
 * against a real per-instance cost of about 4 MB. The sampling discipline is kept
 * and a collection is put in front of it, which is exactly what
 * `test/console/heap-sampling.ts` does for the two tiers that measure in process.
 *
 * WHY CDP AND NOT `--js-flags=--expose-gc`. The flag would have to be passed at
 * launch, and the launcher is shared with every other file in this tier and with
 * the end-to-end tier — so one file's instrument would change what all of them
 * measure. A DevTools session is scoped to this run and to this window, and
 * `HeapProfiler.collectGarbage` is the same collection the flag would expose.
 */
class RendererHeapProbe {
  readonly #consoleApplication: ConsoleApplication;
  readonly #cdpSession: CDPSession;

  private constructor(consoleApplication: ConsoleApplication, cdpSession: CDPSession) {
    this.#consoleApplication = consoleApplication;
    this.#cdpSession = cdpSession;
  }

  public static async attachTo(consoleApplication: ConsoleApplication): Promise<RendererHeapProbe> {
    const cdpSession = await consoleApplication.application
      .context()
      .newCDPSession(consoleApplication.window);
    return new RendererHeapProbe(consoleApplication, cdpSession);
  }

  /** Collect, let finalisation run, and read the settled heap. */
  public async readSettledBytes(): Promise<number> {
    for (let round = 0; round < COLLECTION_ROUNDS; round += 1) {
      await this.#cdpSession.send("HeapProfiler.collectGarbage");
      await this.#consoleApplication.window.evaluate(
        async () =>
          new Promise((resolve) => {
            setTimeout(resolve, 0);
          }),
      );
    }
    return readSettledHeapBytes(this.#consoleApplication);
  }

  public async detach(): Promise<void> {
    await this.#cdpSession.detach();
  }
}

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

/** What every mounted emulator reports about itself, read in one round trip. */
interface MountedTerminalReadings {
  readonly hostCount: number;
  readonly rendererModes: readonly string[];
  readonly canvasCount: number;
}

function readMountedTerminals(
  consoleApplication: ConsoleApplication,
): Promise<MountedTerminalReadings> {
  return consoleApplication.window.evaluate((hostSelector: string) => {
    const hosts = [...document.querySelectorAll(hostSelector)];
    return {
      hostCount: hosts.length,
      rendererModes: hosts.map((host) => host.getAttribute("data-renderer") ?? "absent"),
      // The WebGL renderer draws into canvases it appends inside the terminal; the
      // DOM renderer draws rows of spans and appends none. Counted as corroboration
      // that a frame was actually produced, beside the mode each host REPORTS.
      canvasCount: hosts.reduce((total, host) => total + host.querySelectorAll("canvas").length, 0),
    };
  }, TERMINAL_HOST_SELECTOR);
}

/**
 * Open one more pane and wait until every instance is drawing on a WebGL context.
 *
 * The wait is on the renderer mode leaving `"pending"` rather than on the box
 * appearing: `XtermHost` mounts its box on the commit that attaches the adapter and
 * reports the settled mode immediately after, so a wait on the box alone would
 * return before the renderer had been selected and a reading taken there would
 * measure a terminal that had not drawn.
 *
 * A run that settles on the DOM renderer FAILS rather than continuing. The row's
 * subject includes the WebGL renderer, so a figure taken over the fallback is a
 * figure for a different pane — and passing on it would restore, one renderer down,
 * exactly the too-narrow subject that sent this row back to `n/a`.
 */
async function openPaneAndAwaitWebglReadiness(
  consoleApplication: ConsoleApplication,
  expectedInstanceCount: number,
): Promise<void> {
  await consoleApplication.window.getByRole("button", { name: OPEN_CONTROL_NAME }).click();
  await consoleApplication.window.waitForFunction(
    ([hostSelector, wanted]: [string, number]) => {
      const hosts = [...document.querySelectorAll(hostSelector)];
      return (
        hosts.length === wanted &&
        hosts.every((host) => (host.getAttribute("data-renderer") ?? "pending") !== "pending")
      );
    },
    [TERMINAL_HOST_SELECTOR, expectedInstanceCount] as [string, number],
    { timeout: PANE_READINESS_TIMEOUT_MS },
  );

  const readings = await readMountedTerminals(consoleApplication);
  expect(readings.hostCount).toBe(expectedInstanceCount);
  expect(
    readings.rendererModes.every((mode) => mode === "webgl"),
    `every instance must be drawing on a WebGL2 context for this row's subject to be whole; ` +
      `the ${String(readings.hostCount)} mounted emulator(s) report [${readings.rendererModes.join(", ")}]. ` +
      "A `dom` reading means this runner gave the renderer no WebGL2 — on a headless Linux runner " +
      "that is the display server and the GL stack, not the console, and the endurance job must " +
      "supply software GL (`--use-gl=angle --use-angle=swiftshader`) before this budget can be read there.",
  ).toBe(true);
  expect(
    readings.canvasCount,
    "the WebGL renderer draws into canvases it appends inside the terminal, and none is present, " +
      "so nothing has been drawn on the context the mode reports",
  ).toBeGreaterThanOrEqual(expectedInstanceCount);
}

/** Close every open pane and wait for the harness to report none mounted. */
async function closeEveryPane(
  consoleApplication: ConsoleApplication,
  openInstanceCount: number,
): Promise<void> {
  for (let closed = 0; closed < openInstanceCount; closed += 1) {
    await consoleApplication.window.getByRole("button", { name: CLOSE_CONTROL_NAME }).click();
  }
  await consoleApplication.window.waitForFunction(
    (hostSelector: string) => document.querySelectorAll(hostSelector).length === 0,
    TERMINAL_HOST_SELECTOR,
    { timeout: PANE_READINESS_TIMEOUT_MS },
  );
}

/**
 * Open the harness at this row's address, with the session it binds to delivered.
 *
 * The script is walked BEFORE any measurement, so every reading below is taken over
 * a settled store rather than one still being written into: the pane folds its
 * lease, its transition ledger, and its host-presence reading off this session's
 * timeline, and those are part of what the row bounds.
 */
async function openHarnessOnDeliveredSession(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  await consoleApplication.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, HARNESS_ROUTE);
  await consoleApplication.window
    .locator(HARNESS_SURFACE_SELECTOR)
    .waitFor({ state: "visible", timeout: ROUTE_TRANSITION_TIMEOUT_MS });

  const scriptSpanMs = TERMINAL_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const stepMs = Math.max(1, Math.ceil(scriptSpanMs / SCENARIO_DELIVERY_STEP_COUNT));
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT; step += 1) {
    deliveredBeatCount = await advanceScenario(consoleApplication, stepMs);
  }
  expect(
    deliveredBeatCount,
    "the scenario handle is not exposed by this build, so nothing drove content into the session the panes bind to",
  ).not.toBeNull();
  expect(Number(deliveredBeatCount)).toBe(TERMINAL_SCENARIO.beats.length);

  const appliedEventCount = await readAppliedEventCount(
    consoleApplication,
    TERMINAL_SCENARIO.sessionId,
  );
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so the panes below would fold a lease off an empty log",
  ).toBeGreaterThan(0);
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
});

describe.skipIf(!bundleIsBuilt)("endurance — one terminal pane, held whole", () => {
  it("holds one pane instance under the budget's ceiling, and gives it back", async () => {
    const consoleApplication = await launchConsole({ scenarioId: TERMINAL_SCENARIO.id });
    const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
    try {
      await openHarnessOnDeliveredSession(consoleApplication);

      // The warm-up cycle. Its whole purpose is to move the emulator chunk and every
      // other one-time page cost to the LEFT of the baseline, so the first instance's
      // delta below is an instance and not a library.
      await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
      await closeEveryPane(consoleApplication, 1);

      const baselineHeapBytes = await heapProbe.readSettledBytes();

      await openPaneAndAwaitWebglReadiness(consoleApplication, 1);
      const oneInstanceHeapBytes = await heapProbe.readSettledBytes();
      const firstInstanceBytes = oneInstanceHeapBytes - baselineHeapBytes;

      for (let instance = 2; instance <= MEASURED_INSTANCE_COUNT; instance += 1) {
        await openPaneAndAwaitWebglReadiness(consoleApplication, instance);
      }
      const everyInstanceHeapBytes = await heapProbe.readSettledBytes();
      const laterInstanceBytes =
        (everyInstanceHeapBytes - oneInstanceHeapBytes) / (MEASURED_INSTANCE_COUNT - 1);

      await closeEveryPane(consoleApplication, MEASURED_INSTANCE_COUNT);
      const afterTeardownHeapBytes = await heapProbe.readSettledBytes();
      const teardownResidueBytes = Math.max(0, afterTeardownHeapBytes - baselineHeapBytes);

      const verdict = evaluateBudget(budget, firstInstanceBytes);

      // Reported before the assertions, on the reason the two readings beside it in
      // this tier print theirs: a gate that speaks only when it fails gives a
      // reviewer no way to watch a margin shrink over months until the day it
      // crosses.
      process.stdout.write(
        `[console-endurance] terminal pane instance ${String(Math.round(firstInstanceBytes / 1024))} kB ` +
          `of ${String(Math.round(budget.limit.canonicalValue / 1024))} kB ` +
          `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) at ` +
          `${String(TERMINAL_DEFAULT_SCROLLBACK_LINES)} lines of scrollback; ` +
          `later instances ${String(Math.round(laterInstanceBytes / 1024))} kB each; ` +
          `${String(Math.round(teardownResidueBytes / 1024))} kB still held after closing ` +
          `${String(MEASURED_INSTANCE_COUNT)}\n`,
      );

      expect(
        verdict.withinBudget,
        `${budget.label}: ${String(firstInstanceBytes)} B against a ${String(budget.limit.canonicalValue)} B ceiling`,
      ).toBe(true);

      // The figure has to be a figure. A delta at or below zero means the reading
      // moved the wrong way and the comparison above was vacuous.
      expect(
        firstInstanceBytes,
        "mounting a terminal pane did not raise the renderer's heap at all, so the comparison above measured nothing",
      ).toBeGreaterThan(0);

      // The slope control: the later instances cost about what the first one did, so
      // the figure this row gates on is the price of an instance rather than a
      // one-time cost the first instance happened to carry.
      expect(
        laterInstanceBytes,
        `later instances cost ${String(Math.round(laterInstanceBytes / 1024))} kB against the first instance's ` +
          `${String(Math.round(firstInstanceBytes / 1024))} kB, so the gated figure is dominated by a cost that is ` +
          "paid once rather than per instance",
      ).toBeGreaterThan(firstInstanceBytes * SLOPE_AGREEMENT_LOWER_FACTOR);
      expect(laterInstanceBytes).toBeLessThan(firstInstanceBytes * SLOPE_AGREEMENT_UPPER_FACTOR);

      // The leak half, pane-shaped: three whole panes came and went and the page is
      // back within one instance of where it started.
      expect(
        teardownResidueBytes,
        `${String(MEASURED_INSTANCE_COUNT)} panes were closed and ${String(Math.round(teardownResidueBytes / 1024))} kB is still held`,
      ).toBeLessThan(firstInstanceBytes * TEARDOWN_RESIDUE_FACTOR);

      // A ceiling planted one byte under the reading must fail the same comparison
      // this gate just passed.
      expect(
        evaluateBudget(budgetWithCeilingBelow(firstInstanceBytes), firstInstanceBytes).withinBudget,
      ).toBe(false);
    } finally {
      // The session before the window: detaching a DevTools session from a closed
      // application raises, and the raise would replace whatever the body was
      // failing on with a teardown error.
      await heapProbe.detach();
      await consoleApplication.close();
    }
  });
});
