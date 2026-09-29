// The real-window side of the terminal-instance budget: opening panes and proving
// each one is drawing before anything is measured.
//
// Split from `terminal-instance-memory.test.ts` so that file is its budget row's
// argument — what the subject is, what the figure covers, and what fails the run —
// rather than that argument buried under the Playwright plumbing that produces it.
// Everything here is instrument: the address the harness opens at, the wait that
// makes a reading admissible, and the readiness this row's subject is asserted by.
// The heap reading itself is `heap-instrument.ts`'s — it is a reading of the
// renderer and not of a terminal pane, and it moved there when the tier's other two
// figures needed the same forced collection this row already took.
//
// WHAT THE HARNESS IS, AND WHY IT IS NOT A PANE LAYOUT
//
// The harness mounts a registered pane body without a pane layout: `registerTerminalPane` claims
// the `terminal` kind, and the pane harness is the smallest honest way in — a fixture
// route the fixture launch registers, reached at
// `#/pane-harness/<paneKind>/<sessionId>`, that resolves the body through
// `PaneRegistry` and mounts one more of it per press. It is deliberately not
// a pane layout: a reading taken inside one would fold the pane layout's tab strip, layout, and
// drag machinery into a figure the row scopes to a pane INSTANCE, and would report
// a pane over budget for the pane layout's own cost. The pane layout's absence from the subject
// is closer to the row's sentence than its presence would be.

import { expect } from "vitest";

import type { AppUnderTest } from "../helpers/electron-harness.js";
import { advanceScenario, readAppliedEventCount } from "./endurance-workload.js";
import { TERMINAL_LEASE_SCENARIO } from "../../fixtures/scenarios/terminal-lease.js";

/** The pane kind the address names. The harness is per kind; this row is this one. */
const MEASURED_PANE_KIND = "terminal";

/** Where the harness opens, with the pane kind and the session it binds to. */
const HARNESS_ROUTE = `#/pane-harness/${MEASURED_PANE_KIND}/${encodeURIComponent(TERMINAL_LEASE_SCENARIO.sessionId)}`;

/** The harness region's accessible name, and the controls it offers. */
const HARNESS_REGION_SELECTOR = '[aria-label="Pane harness"]';
const OPEN_CONTROL_NAME = "Open a pane";
const CLOSE_CONTROL_NAME = "Close the newest pane";

/** The emulator's mount box, on which it reports the renderer it settled on. */
const TERMINAL_MOUNT_POINT_SELECTOR = ".meridian-terminal-mount-point";

/**
 * How long a pane may take to mount its emulator and settle on a renderer.
 *
 * A CEILING for one step and never the bound itself: every wait below is passed
 * through `bodyAllowance.boundedMs`, so what a step actually gets is the smaller of
 * this figure and what is left of the tier's registered body allowance. A step
 * bounded by a local constant alone outlives the allowance it was supposed to spend
 * and fails under vitest's generic kill instead of the harness's own sentence.
 */
const PANE_READINESS_TIMEOUT_MS = 60_000;

/** How long the harness region itself may take to appear. Bounded the same way. */
const ROUTE_TRANSITION_TIMEOUT_MS = 30_000;

/** How many advances the terminal script is walked in, and how many drain it. */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/** What every mounted emulator reports about itself, read in one round trip. */
interface MountedTerminalReadings {
  readonly mountPointCount: number;
  readonly rendererModes: readonly string[];
  readonly canvasCount: number;
}

function readMountedTerminals(consoleApplication: AppUnderTest): Promise<MountedTerminalReadings> {
  return consoleApplication.window.evaluate((mountPointSelector: string) => {
    const mountPoints = [...document.querySelectorAll(mountPointSelector)];
    return {
      mountPointCount: mountPoints.length,
      rendererModes: mountPoints.map(
        (mountPoint) => mountPoint.getAttribute("data-renderer") ?? "absent",
      ),
      // The WebGL renderer draws into canvases it appends inside the terminal; the
      // DOM renderer draws rows of spans and appends none. Counted as corroboration
      // that a frame was actually produced, beside the mode each mount point REPORTS.
      canvasCount: mountPoints.reduce(
        (total, mountPoint) => total + mountPoint.querySelectorAll("canvas").length,
        0,
      ),
    };
  }, TERMINAL_MOUNT_POINT_SELECTOR);
}

/**
 * Open one more pane and wait until every instance is drawing on a WebGL context.
 *
 * The wait is on the renderer mode leaving `"pending"` rather than on the box
 * appearing: `XtermMountPoint` mounts its box on the commit that attaches the adapter and
 * reports the settled mode immediately after, so a wait on the box alone would
 * return before the renderer had been selected and a reading taken there would
 * measure a terminal that had not drawn.
 *
 * A run that settles on the DOM renderer FAILS rather than continuing. The row's
 * subject includes the WebGL renderer, so a figure taken over the fallback is a
 * figure for a different pane — and passing on it would restore, one renderer down,
 * exactly the too-narrow subject that sent this row back to `n/a`.
 */
export async function openPaneAndAwaitWebglReadiness(
  consoleApplication: AppUnderTest,
  expectedInstanceCount: number,
): Promise<void> {
  await consoleApplication.window.getByRole("button", { name: OPEN_CONTROL_NAME }).click();
  await consoleApplication.window.waitForFunction(
    ([mountPointSelector, wanted]: [string, number]) => {
      const mountPoints = [...document.querySelectorAll(mountPointSelector)];
      return (
        mountPoints.length === wanted &&
        mountPoints.every(
          (mountPoint) => (mountPoint.getAttribute("data-renderer") ?? "pending") !== "pending",
        )
      );
    },
    [TERMINAL_MOUNT_POINT_SELECTOR, expectedInstanceCount] as [string, number],
    { timeout: consoleApplication.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
  );

  const readings = await readMountedTerminals(consoleApplication);
  expect(readings.mountPointCount).toBe(expectedInstanceCount);
  expect(
    readings.rendererModes.every((mode) => mode === "webgl"),
    `every instance must be drawing on a WebGL2 context for this row's subject to be whole; ` +
      `the ${String(readings.mountPointCount)} mounted emulator(s) report [${readings.rendererModes.join(", ")}]. ` +
      "A `dom` reading means this launch reached the renderer with no WebGL2. The launcher supplies " +
      "a GPU-less host its own software GL stack (tests/helpers/launch-args.ts), so the question is " +
      "whether those switches reached Chromium and were honored — read the GPU process's own " +
      "`eglInitialize` lines with `--enable-logging=stderr`; it is the graphics stack that failed " +
      "here and not the console.",
  ).toBe(true);
  expect(
    readings.canvasCount,
    "the WebGL renderer draws into canvases it appends inside the terminal, and none is present, " +
      "so nothing has been drawn on the context the mode reports",
  ).toBeGreaterThanOrEqual(expectedInstanceCount);
}

/** Close every open pane and wait for the harness to report none mounted. */
export async function closeEveryPane(
  consoleApplication: AppUnderTest,
  openInstanceCount: number,
): Promise<void> {
  for (let closed = 0; closed < openInstanceCount; closed += 1) {
    await consoleApplication.window.getByRole("button", { name: CLOSE_CONTROL_NAME }).click();
  }
  await consoleApplication.window.waitForFunction(
    (mountPointSelector: string) => document.querySelectorAll(mountPointSelector).length === 0,
    TERMINAL_MOUNT_POINT_SELECTOR,
    { timeout: consoleApplication.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
  );
}

/**
 * Open the harness at this row's address, with the session it binds to delivered.
 *
 * The script is walked BEFORE any measurement, so every reading is taken over a
 * settled store rather than one still being written into: the pane folds its lease and
 * its transition ledger off this session's timeline, and those are part of what the row
 * bounds.
 */
export async function openHarnessOnDeliveredSession(
  consoleApplication: AppUnderTest,
): Promise<void> {
  await consoleApplication.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, HARNESS_ROUTE);
  await consoleApplication.window.locator(HARNESS_REGION_SELECTOR).waitFor({
    state: "visible",
    timeout: consoleApplication.bodyAllowance.boundedMs(ROUTE_TRANSITION_TIMEOUT_MS),
  });

  const scriptSpanMs = TERMINAL_LEASE_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const stepMs = Math.max(1, Math.ceil(scriptSpanMs / SCENARIO_DELIVERY_STEP_COUNT));
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT; step += 1) {
    deliveredBeatCount = await advanceScenario(consoleApplication, stepMs);
  }
  expect(
    deliveredBeatCount,
    "the scenario handle is not exposed by this build, so nothing drove content into the session the panes bind to",
  ).not.toBeNull();
  expect(Number(deliveredBeatCount)).toBe(TERMINAL_LEASE_SCENARIO.beats.length);

  const appliedEventCount = await readAppliedEventCount(
    consoleApplication,
    TERMINAL_LEASE_SCENARIO.sessionId,
  );
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so the panes below would fold a lease off an empty log",
  ).toBeGreaterThan(0);
}
