// The real-window side of the terminal-instance budget: opening panes and reading
// the renderer's settled heap.
//
// Split from `terminal-instance-memory.test.ts` so that file is its budget row's
// argument — what the subject is, what the figure covers, and what fails the run —
// rather than that argument buried under the Playwright plumbing that produces it.
// Everything here is instrument: the address the harness opens at, the wait that
// makes a reading admissible, and the DevTools session the collection runs over.
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

import { expect } from "vitest";

import type { CDPSession } from "@playwright/test";

import type { ConsoleApplication } from "../electron-harness.js";
import { SETTLE_ROUNDS } from "../heap-sampling.js";
import { advanceScenario, readAppliedEventCount } from "./console-workload.js";
import { readSettledHeapBytes } from "./heap-instrument.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";

/** The pane kind the address names. The harness is per kind; this row is this one. */
const MEASURED_PANE_KIND = "terminal";

/** Where the harness opens, with the pane kind and the session it binds to. */
const HARNESS_ROUTE = `#/pane-harness/${MEASURED_PANE_KIND}/${encodeURIComponent(TERMINAL_SCENARIO.sessionId)}`;

/** The harness surface's accessible name, and the controls it offers. */
const HARNESS_SURFACE_SELECTOR = '[aria-label="Pane harness"]';
const OPEN_CONTROL_NAME = "Open a pane";
const CLOSE_CONTROL_NAME = "Close the newest pane";

/** The emulator's mount box, on which it reports the renderer it settled on. */
const TERMINAL_HOST_SELECTOR = ".meridian-terminal-host";

/**
 * How long a pane may take to mount its emulator and settle on a renderer.
 *
 * A CEILING for one step and never the bound itself: every wait below is passed
 * through `bodyAllowance.boundedMs`, so what a step actually gets is the smaller of
 * this figure and what is left of the tier's registered body allowance. A step
 * bounded by a local constant alone outlives the allowance it was supposed to spend
 * and fails under vitest's generic kill instead of the harness's own sentence, which
 * is what `body-allowance-consumption.test.ts` fails a wait for.
 */
const PANE_READINESS_TIMEOUT_MS = 60_000;

/** How long the harness surface itself may take to appear. Bounded the same way. */
const ROUTE_TRANSITION_TIMEOUT_MS = 30_000;

/** How many advances the terminal script is walked in, and how many drain it. */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

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
export class RendererHeapProbe {
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

  /**
   * Collect, let finalisation run, and read the settled heap.
   *
   * The loop is this process's own — it collects over a DevTools session rather than
   * through a resolved collector — but the ROUND COUNT is `heap-sampling.ts`'s, which
   * is the console's declared home for the settling discipline. A local copy of the
   * number would go on collecting four times after that one was raised, and the row
   * would read a floor the in-process tier no longer reaches with nothing failing.
   */
  public async readSettledBytes(): Promise<number> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
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
export async function openPaneAndAwaitWebglReadiness(
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
    { timeout: consoleApplication.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
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
export async function closeEveryPane(
  consoleApplication: ConsoleApplication,
  openInstanceCount: number,
): Promise<void> {
  for (let closed = 0; closed < openInstanceCount; closed += 1) {
    await consoleApplication.window.getByRole("button", { name: CLOSE_CONTROL_NAME }).click();
  }
  await consoleApplication.window.waitForFunction(
    (hostSelector: string) => document.querySelectorAll(hostSelector).length === 0,
    TERMINAL_HOST_SELECTOR,
    { timeout: consoleApplication.bodyAllowance.boundedMs(PANE_READINESS_TIMEOUT_MS) },
  );
}

/**
 * Open the harness at this row's address, with the session it binds to delivered.
 *
 * The script is walked BEFORE any measurement, so every reading is taken over a
 * settled store rather than one still being written into: the pane folds its lease,
 * its transition ledger, and its host-presence reading off this session's timeline,
 * and those are part of what the row bounds.
 */
export async function openHarnessOnDeliveredSession(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  await consoleApplication.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, HARNESS_ROUTE);
  await consoleApplication.window.locator(HARNESS_SURFACE_SELECTOR).waitFor({
    state: "visible",
    timeout: consoleApplication.bodyAllowance.boundedMs(ROUTE_TRANSITION_TIMEOUT_MS),
  });

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
