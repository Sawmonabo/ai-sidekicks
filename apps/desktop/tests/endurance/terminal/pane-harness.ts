// The real-window side of the terminal-instance budget: opening panes and proving each one is
// drawing before anything is measured. `instance/memory.test.ts` holds the budget row's
// argument (what the subject is, what the figure covers, what fails the run); everything here is
// instrument. The heap reading is `heap/instrument.ts`'s, being a reading of the renderer and
// not of a terminal pane.
//
// The harness mounts a registered pane body without a pane layout: `registerTerminalPane`
// claims the `terminal` kind, and a fixture route the fixture launch registers, reached at
// `#/pane-harness/<paneKind>/<sessionId>`, resolves the body through `PaneRegistry` and mounts
// one more of it per press. It is not a pane layout because a reading taken inside one would
// fold the layout's tab strip and drag machinery into a figure the row scopes to a pane
// instance, reporting the pane over budget for the layout's own cost.

import { expect } from "vitest";

import type { AppUnderTest } from "../../helpers/electron/harness.js";
import { scenarioDeliverySchedule } from "../scenario-delivery-schedule.js";
import {
  CLOSE_CONTROL_LABEL,
  OPEN_CONTROL_LABEL,
  PANE_HARNESS_LABEL,
} from "#renderer/app/pane-harness/PaneHarnessFrame.js";
import { advanceScenario, readAppliedEventCount } from "../workload.js";
import { TERMINAL_LEASE_SCENARIO } from "#fixtures/scenarios/terminal-lease.js";

/** The pane kind the address names. The harness is per kind; this row is this one. */
const MEASURED_PANE_KIND = "terminal";

/** Where the harness opens, with the pane kind and the session it binds to. */
const HARNESS_ROUTE =
  `#/pane-harness/${MEASURED_PANE_KIND}/` +
  `${encodeURIComponent(TERMINAL_LEASE_SCENARIO.sessionId)}`;

/** The harness region, found by its accessible name. */
const HARNESS_REGION_SELECTOR = `[aria-label="${PANE_HARNESS_LABEL}"]`;

/** The emulator's mount box, on which it reports the renderer it settled on. */
const TERMINAL_MOUNT_POINT_SELECTOR = ".meridian-terminal-mount-point";

/**
 * How long a pane may take to mount its emulator and settle on a renderer.
 *
 * A ceiling for one step, not the bound itself: every wait is passed through
 * `bodyAllowance.boundedMs`, so a step gets the smaller of this and what is left of the tier's
 * body allowance. A step bounded by a local constant alone outlives the allowance and fails
 * under vitest's generic kill instead of the harness's own sentence.
 */
const PANE_READINESS_TIMEOUT_MS = 60_000;

/** How long the harness region itself may take to appear. Bounded the same way. */
const ROUTE_TRANSITION_TIMEOUT_MS = 30_000;

/** What every mounted emulator reports about itself, read in one round trip. */
interface MountedTerminalReadings {
  readonly mountPointCount: number;
  readonly rendererModes: readonly string[];
  readonly canvasCount: number;
}

function readMountedTerminals(appUnderTest: AppUnderTest): Promise<MountedTerminalReadings> {
  return appUnderTest.window.evaluate((mountPointSelector: string) => {
    const mountPoints = [...document.querySelectorAll(mountPointSelector)];
    return {
      mountPointCount: mountPoints.length,
      rendererModes: mountPoints.map(
        (mountPoint) => mountPoint.getAttribute("data-renderer") ?? "absent",
      ),
      // The WebGL renderer draws into canvases it appends inside the terminal; the DOM renderer
      // appends none. Counted as corroboration that a frame was produced, beside the mode each
      // mount point reports.
      canvasCount: mountPoints.reduce(
        (total, mountPoint) => total + mountPoint.querySelectorAll("canvas").length,
        0,
      ),
    };
  }, TERMINAL_MOUNT_POINT_SELECTOR);
}

/**
 * Opens one more pane and waits until every instance is drawing on a WebGL context.
 *
 * The wait is on the renderer mode leaving `"pending"`, not on the box appearing:
 * `XtermMountPoint` mounts its box on the commit that attaches the adapter and reports the
 * settled mode right after, so a wait on the box alone would return before the renderer was
 * selected. A run that settles on the DOM renderer fails rather than continuing, since the
 * row's subject includes the WebGL renderer and a figure over the fallback is for a different
 * pane.
 */
export async function openPaneAndAwaitWebglReadiness(
  appUnderTest: AppUnderTest,
  expectedInstanceCount: number,
): Promise<void> {
  await appUnderTest.window.getByRole("button", { name: OPEN_CONTROL_LABEL }).click();
  await appUnderTest.window.waitForFunction(
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
    { timeout: appUnderTest.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
  );

  const readings = await readMountedTerminals(appUnderTest);
  expect(readings.mountPointCount).toBe(expectedInstanceCount);
  expect(
    readings.rendererModes.every((mode) => mode === "webgl"),
    `every instance must be drawing on a WebGL2 context for this row's subject to be whole; ` +
      `the ${String(readings.mountPointCount)} mounted ` +
      `emulator(s) report [${readings.rendererModes.join(", ")}]. ` +
      "A `dom` reading means this launch reached the " +
      "renderer with no WebGL2. The launcher supplies " +
      "a GPU-less host its own software GL stack " +
      "(tests/helpers/launch/args.ts), so the question is " +
      "whether those switches reached Chromium and were honored — read the GPU process's own " +
      "`eglInitialize` lines with `--enable-logging=stderr`; " +
      "it is the graphics stack that failed " +
      "here and not the app.",
  ).toBe(true);
  expect(
    readings.canvasCount,
    "the WebGL renderer draws into canvases it appends inside the terminal, and none is present, " +
      "so nothing has been drawn on the context the mode reports",
  ).toBeGreaterThanOrEqual(expectedInstanceCount);
}

/** Close every open pane and wait for the harness to report none mounted. */
export async function closeEveryPane(
  appUnderTest: AppUnderTest,
  openInstanceCount: number,
): Promise<void> {
  for (let closed = 0; closed < openInstanceCount; closed += 1) {
    await appUnderTest.window.getByRole("button", { name: CLOSE_CONTROL_LABEL }).click();
  }
  await appUnderTest.window.waitForFunction(
    (mountPointSelector: string) => document.querySelectorAll(mountPointSelector).length === 0,
    TERMINAL_MOUNT_POINT_SELECTOR,
    { timeout: appUnderTest.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
  );
}

/**
 * Opens the harness at this row's address, with the session it binds to delivered.
 *
 * The script is walked before any measurement, so every reading is taken over a settled store:
 * the pane folds its lease off this session's transcript, and that is part
 * of what the row bounds.
 */
export async function openHarnessOnDeliveredSession(appUnderTest: AppUnderTest): Promise<void> {
  await appUnderTest.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, HARNESS_ROUTE);
  await appUnderTest.window.locator(HARNESS_REGION_SELECTOR).waitFor({
    state: "visible",
    timeout: appUnderTest.bodyAllowance.boundedMs(ROUTE_TRANSITION_TIMEOUT_MS),
  });

  const { stepMilliseconds, stepCount } = scenarioDeliverySchedule(
    TERMINAL_LEASE_SCENARIO.beats.at(-1)?.atMs ?? 0,
  );
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < stepCount; step += 1) {
    deliveredBeatCount = await advanceScenario(appUnderTest, stepMilliseconds);
  }
  expect(
    deliveredBeatCount,
    "the scenario handle is not exposed by this build, so " +
      "nothing drove content into the session the panes bind to",
  ).not.toBeNull();
  expect(Number(deliveredBeatCount)).toBe(TERMINAL_LEASE_SCENARIO.beats.length);

  const appliedEventCount = await readAppliedEventCount(
    appUnderTest,
    TERMINAL_LEASE_SCENARIO.sessionId,
  );
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so " +
      "the panes below would fold a lease off an empty log",
  ).toBeGreaterThan(0);
}
