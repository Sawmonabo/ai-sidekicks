// The endurance tier's driving vocabulary, shared by the files in it.
//
// Two tests in this tier drive the same console in the same way — one measures
// how the heap MOVES over sustained use, the other what it IS once the console
// has settled — and both need the same four things: a route observed, the
// scenario advanced, the store read back, and the heap read after a settle. A
// copy of any of those in each file would be two drivers that drift, and the
// drift would not be loud: a route wait that stopped waiting still passes.
//
// WHY THE ROUTE WAITS NAME A SURFACE AND NOT THE FRAME
//
// `.meridian-frame` is the window's permanent shell. It is on the page before a
// route change and still there after, so a wait on it returns immediately and
// the next navigation can land before React has mounted anything — which is a
// churn loop that reports clean heap growth precisely because it never performed
// the mount and unmount it claims to measure.
//
// So each transition waits on something only its own destination renders, and
// the two locators below are asserted route-EXCLUSIVE by
// `steady-state.test.ts` — the assertion that fails the day either one goes back
// to naming the shell.
//
// Both are production markup. `Spec-023 §Console Design (Meridian)` rule 8's five
// kinds of nothing carry a per-kind class, and the two routes this tier walks
// render different kinds today: the settings slot has no registered surface, so
// the frame says the surface is reserved rather than stubbed (`empty`), while the
// session workspace mounts a shipped Tier-1 family that reads the installed
// bridge, which under the fixture is a question nobody put (`not-checked`). No
// test-only attribute is added to the renderer to make this observable.
//
// When either surface ships for real, its locator stops matching and this tier
// fails on a wait timeout naming the selector. That is the right direction: a
// driver that can no longer see the surface it drives should stop, not continue
// measuring an unobserved loop.

import { expect } from "vitest";

import type { ConsoleApplication, LaunchConsoleOptions } from "../electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../launch-body.js";
import { ENDURANCE_BODY_ALLOWANCE_MS } from "../launch-budgets.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  type ConsoleSessionDiagnostics,
  type ScenarioFixtureHandle,
} from "../fixture-handles.js";
import { FLAGSHIP_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";

/**
 * How every launch in this tier is asked for: the flagship script, and the
 * tier's OWN body allowance.
 *
 * Stated once rather than at each launch, because both halves are properties of
 * the tier rather than of a case. The allowance is the second: an endurance body
 * drives hundreds of churn cycles with settling heap samples either side, which
 * is a different subject from an end-to-end body and is why this tier has a
 * registered figure of its own — and the tier's own `testTimeout` is derived from
 * that same figure (`tierTimeoutFor`, `vitest.config.ts`). A launch that took the
 * default would be bounded nine times more tightly than the tier that runs it.
 */
export function enduranceLaunchOptions(scenarioId: string): LaunchConsoleOptions {
  return {
    scenarioId,
    bodyAllowanceMs: ENDURANCE_BODY_ALLOWANCE_MS,
    // Every launch in this tier reads a heap, and every figure it gates is a
    // DIFFERENCE of two such readings. See `readSettledHeapBytes` for why the
    // default instrument cannot carry one.
    isPreciseHeapReadingRequired: true,
  };
}

export const ENDURANCE_LAUNCH_OPTIONS: LaunchConsoleOptions = enduranceLaunchOptions(
  FLAGSHIP_SCENARIO.id,
);

export const FLAGSHIP_SESSION_ID: string = FLAGSHIP_SCENARIO.sessionId;

export const FLAGSHIP_SESSION_ROUTE: string = `#/session/${encodeURIComponent(FLAGSHIP_SESSION_ID)}`;

export const SETTINGS_ROUTE: string = "#/settings";

/**
 * What the settings route renders and the session workspace does not.
 *
 * Anchored under the frame's surface slot, so a `Nothing` of the same kind
 * mounted in the rail, a banner, or an overlay cannot satisfy the wait for a
 * surface that never mounted.
 */
export const SETTINGS_SURFACE_SELECTOR: string =
  ".meridian-frame__surface .meridian-nothing--block.meridian-nothing--empty";

/** What the session workspace renders and the settings route does not. */
export const WORKSPACE_SURFACE_SELECTOR: string =
  ".meridian-frame__surface .meridian-nothing--block.meridian-nothing--not-checked";

/**
 * Assign the hash and wait for the surface only that route mounts.
 *
 * The wait carries `IN_WINDOW_STEP_TIMEOUT_MS` — a route change is a store update
 * and one React commit, so that figure bounds a console that has STOPPED
 * navigating rather than one being slow — and it is additionally held to what is
 * left of the body's allowance. Both halves matter: without the first, a stalled
 * route reports as a body that ran long; without the second, a transition
 * declared at ten seconds outlives an allowance with a second left on it and the
 * enclosing race replaces the selector's name with the generic overrun.
 */
async function openRoute(
  consoleApplication: ConsoleApplication,
  hash: string,
  surfaceSelector: string,
): Promise<void> {
  await consoleApplication.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, hash);
  await consoleApplication.window.locator(surfaceSelector).waitFor({
    state: "visible",
    timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
}

export async function openSettingsRoute(consoleApplication: ConsoleApplication): Promise<void> {
  await openRoute(consoleApplication, SETTINGS_ROUTE, SETTINGS_SURFACE_SELECTOR);
}

export async function openFlagshipSessionRoute(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  await openRoute(consoleApplication, FLAGSHIP_SESSION_ROUTE, WORKSPACE_SURFACE_SELECTOR);
}

/**
 * Read the renderer's heap after asking it to collect.
 *
 * `--expose-gc` is not passed and deliberately not required: the reading is taken
 * as the MINIMUM over several samples with a yield between them, which lets the
 * incremental collector run and gives a floor that is far more stable than a
 * single sample.
 *
 * `usedJSHeapSize` counts what is allocated and not yet collected, so this figure
 * is at or above the retained heap it stands in for — which is the safe direction
 * for a ceiling: a budget satisfied by this reading is satisfied by the retained
 * heap too. THAT ARGUMENT IS ABOUT COLLECTOR LAG AND HOLDS ONLY AT PRECISE
 * PRECISION. At Blink's default the figure is quantized into buckets and served
 * from a long-interval cache, so it is neither a measurement of this instant nor
 * wrong in a known direction — a difference of two such readings is rounding in
 * both, and a fully cached one is a difference of zero. Every launch in this tier
 * therefore carries `isPreciseHeapReadingRequired`, and
 * {@link expectPreciseHeapInstrument} is what proves the flag arrived rather than
 * trusting that it did.
 */
/**
 * How many doubles the precision probe holds.
 *
 * A plain array assigned doubles is V8's packed-double backing store — eight bytes
 * an element, allocated once on the JS heap, with none of the copying a `push` loop
 * leaves behind. Half a million of them is four megabytes, which is the figure the
 * window below is drawn around.
 */
const PRECISION_PROBE_ELEMENT_COUNT = 500_000;

const PRECISION_PROBE_NOMINAL_BYTES = PRECISION_PROBE_ELEMENT_COUNT * 8;

/**
 * The window the probe's own growth has to land in.
 *
 * Both ends are the assertion, and each end rules out one way the default
 * instrument fails. BELOW: a reading served from Blink's long-interval cache does
 * not move at all, so the second read equals the first and the delta is zero.
 * ABOVE: a reading quantized onto Blink's bucket grid is one of a coarse set of
 * sizes whose smallest step is far larger than this probe, so it either does not
 * move or jumps a whole bucket — and a jump lands well past the ceiling.
 *
 * A window and not a floor, because a floor alone passes a quantized instrument
 * that happened to step a bucket, which is the failure this precondition exists
 * for. The ends are loose against the nominal figure so ordinary collector
 * activity between the two reads cannot decide the verdict.
 *
 * Measured rather than assumed: with the flag dropped from this tier's launch, the
 * same probe moved the reading by exactly 0 B (macOS, Electron 44, 2026-09-05) —
 * the cached form, reciting one value for both reads.
 */
const PRECISION_PROBE_MIN_OBSERVED_BYTES = PRECISION_PROBE_NOMINAL_BYTES / 2;

const PRECISION_PROBE_MAX_OBSERVED_BYTES = PRECISION_PROBE_NOMINAL_BYTES * 2;

/**
 * Prove `performance.memory` is measuring this renderer rather than reciting a
 * cached bucket.
 *
 * The tier's gated figures are DIFFERENCES of two heap readings taken seconds
 * apart — a pane's standing cost, a slope across instances, a teardown residue —
 * and every one of them is arithmetic on an instrument whose default form is
 * quantized and cached. A launch that lost `--enable-precise-memory-info` would not
 * fail loudly: it would report differences that are rounding, and the slope band
 * would swallow them.
 *
 * So the flag is not trusted. A known allocation is made between two reads and the
 * growth has to track it, which is a claim about the instrument rather than about
 * the console — and it is asserted by the cases that spend the instrument, not
 * inside the reader, so it costs one round trip per tier case rather than one per
 * sample.
 */
export async function expectPreciseHeapInstrument(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  const probe = await consoleApplication.window.evaluate((elementCount: number) => {
    const readHeapBytes = (): number | null => {
      const memory = (
        performance as Performance & { readonly memory?: { readonly usedJSHeapSize: number } }
      ).memory;
      return memory === undefined ? null : memory.usedJSHeapSize;
    };
    const beforeBytes = readHeapBytes();
    const retained = new Array<number>(elementCount);
    for (let element = 0; element < elementCount; element += 1) {
      retained[element] = element + 0.5;
    }
    const afterBytes = readHeapBytes();
    // Read AFTER the second sample so the array is still reachable across it — a
    // probe V8 may collect before the reading it is the subject of proves nothing.
    return { beforeBytes, afterBytes, retainedCount: retained.length };
  }, PRECISION_PROBE_ELEMENT_COUNT);

  expect(
    probe.beforeBytes,
    "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it",
  ).not.toBeNull();
  expect(probe.retainedCount).toBe(PRECISION_PROBE_ELEMENT_COUNT);
  const observedBytes = Number(probe.afterBytes) - Number(probe.beforeBytes);
  expect(
    observedBytes,
    `a ${String(PRECISION_PROBE_NOMINAL_BYTES)} B allocation moved the renderer's heap reading by ` +
      `${String(observedBytes)} B, which is not a measurement of it — this launch is reading ` +
      "Blink's default quantized, cached MemoryInfo rather than the precise one",
  ).toBeGreaterThanOrEqual(PRECISION_PROBE_MIN_OBSERVED_BYTES);
  expect(observedBytes).toBeLessThanOrEqual(PRECISION_PROBE_MAX_OBSERVED_BYTES);
}

export async function readSettledHeapBytes(
  consoleApplication: ConsoleApplication,
): Promise<number> {
  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
    const sample = await consoleApplication.window.evaluate(async () => {
      // Two frames plus a macrotask: enough for the collector to run its
      // incremental steps between samples without pinning the main thread.
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 0);
          });
        });
      });
      const memory = (
        performance as Performance & { readonly memory?: { readonly usedJSHeapSize: number } }
      ).memory;
      return memory === undefined ? null : memory.usedJSHeapSize;
    });
    if (sample === null) {
      throw new Error(
        "performance.memory is unavailable in this renderer; the endurance tier cannot measure a heap without it",
      );
    }
    samples.push(sample);
  }
  return Math.min(...samples);
}

/**
 * Move the scenario on, and report how far it has got.
 *
 * `null` means the handle is not on the page at all — which this tier treats as a
 * failure and never as a reason to skip, on the same reasoning the tripwire
 * assertion carries: a run that could not drive the workload measured an idle
 * console, and reporting that as a pass is worse than not running.
 */
export async function advanceScenario(
  consoleApplication: ConsoleApplication,
  milliseconds: number,
): Promise<number | null> {
  return consoleApplication.window.evaluate(
    ([globalName, deltaMs]: [string, number]) => {
      const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
        globalName
      ];
      if (control === undefined) {
        return null;
      }
      control.advance(deltaMs);
      return control.deliveredBeatCount();
    },
    [SCENARIO_FIXTURE_GLOBAL, milliseconds] as [string, number],
  );
}

/** Which scenario the launched console is actually playing, or `null`. */
export async function readPlayingScenarioId(
  consoleApplication: ConsoleApplication,
): Promise<string | null> {
  return consoleApplication.window.evaluate((globalName: string) => {
    const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
      globalName
    ];
    return control === undefined ? null : control.scenarioId;
  }, SCENARIO_FIXTURE_GLOBAL);
}

/**
 * How many events the store for one session has ADMITTED, or `null`.
 *
 * Admitted to the apply chokepoint, which is a different number from the beats
 * the engine delivered and from anything a timeline is long. That is why both are
 * read: they answer different questions, and this one answers whether a stream
 * reached this window's stores at all.
 */
export async function readAppliedEventCount(
  consoleApplication: ConsoleApplication,
  sessionId: string,
): Promise<number | null> {
  return consoleApplication.window.evaluate(
    ([globalName, targetSessionId]: [string, string]) => {
      const sessions = (
        globalThis as unknown as Record<string, ConsoleSessionDiagnostics | undefined>
      )[globalName];
      return sessions === undefined ? null : sessions.appliedEventCountFor(targetSessionId);
    },
    [SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, sessionId] as [string, string],
  );
}

/** Sessions this window holds a wire subscription for, or `null` with no handle. */
export async function readBoundSessionIds(
  consoleApplication: ConsoleApplication,
): Promise<readonly string[] | null> {
  return consoleApplication.window.evaluate((globalName: string) => {
    const sessions = (
      globalThis as unknown as Record<string, ConsoleSessionDiagnostics | undefined>
    )[globalName];
    return sessions === undefined ? null : [...sessions.boundSessionIds()];
  }, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL);
}

/**
 * One cycle of the work a console does while a person watches it.
 *
 * Navigation and palette use rather than synthetic allocation, because the leaks
 * worth catching live in the machinery those exercise — subscriptions, effects,
 * portals, and the listener table — and a loop that allocated arrays would prove
 * only that V8 collects arrays. The clock moves once per cycle so the scenario is
 * delivering into that machinery while it is being churned, which is the state a
 * real session is in and the one a leak shows up in.
 *
 * Each route change is OBSERVED before the next one is issued: the mount and
 * unmount are the subject of the measurement, so a cycle that assigned two hashes
 * back to back would be a cycle that measured neither.
 *
 * Returns the delivered-beat count the advance reported, so a caller can assert
 * the workload progressed without paying for a second round trip.
 */
export async function churnOnce(
  consoleApplication: ConsoleApplication,
  advanceMilliseconds: number,
): Promise<number | null> {
  const consoleWindow = consoleApplication.window;
  await consoleWindow.keyboard.press("ControlOrMeta+KeyK");
  await consoleWindow.getByRole("dialog").waitFor({
    state: "visible",
    timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
  await consoleWindow.keyboard.type("Go to");
  await consoleWindow.keyboard.press("Escape");
  await consoleWindow.getByRole("dialog").waitFor({
    state: "hidden",
    timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });

  // Route changes mount and unmount the surface subtree through the error
  // boundary's keyed remount — the path most likely to strand a listener. One of
  // the two routes is the scenario's own session, so the cycle also opens and
  // re-reads the store the beats are landing in.
  await openSettingsRoute(consoleApplication);
  await openFlagshipSessionRoute(consoleApplication);

  return advanceScenario(consoleApplication, advanceMilliseconds);
}

/**
 * How many advances the whole script is walked in, and how many drain it.
 *
 * Steps rather than one jump because a beat delivered into a store is applied
 * through a coalescing window on the same frozen clock: one advance past the end
 * would deliver every beat and leave the last of them queued. The drain advances
 * carry that window past its deadline with nothing left to deliver, which is the
 * quiet point — every beat in, nothing in flight.
 */
const SCENARIO_DELIVERY_STEP_COUNT = 20;
const SCENARIO_DRAIN_STEP_COUNT = 5;

/**
 * Play the flagship script to its end and let the stores settle on it.
 *
 * Returns the beats delivered, so a caller can assert the session it is about to
 * measure actually has content rather than being an empty store with a route
 * pointed at it.
 */
export async function deliverWholeScenario(
  consoleApplication: ConsoleApplication,
): Promise<number | null> {
  const scriptSpanMs = FLAGSHIP_SCENARIO.beats.at(-1)?.atMs ?? 0;
  const stepMs = Math.max(1, Math.ceil(scriptSpanMs / SCENARIO_DELIVERY_STEP_COUNT));
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT; step += 1) {
    deliveredBeatCount = await advanceScenario(consoleApplication, stepMs);
  }
  return deliveredBeatCount;
}

/**
 * Assert this window's session store holds the flagship script's events.
 *
 * Shared because both files need it for different reasons: the steady-state run
 * needs the workload to have been a workload, and the at-rest reading needs the
 * budget's subject — ONE SESSION OPEN, with content — to be what was on screen
 * when the heap was read.
 */
export async function expectFlagshipSessionCarriesContent(
  consoleApplication: ConsoleApplication,
): Promise<void> {
  const appliedEventCount = await readAppliedEventCount(consoleApplication, FLAGSHIP_SESSION_ID);
  expect(
    appliedEventCount,
    `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, so nothing can be shown about where the workload's events went`,
  ).not.toBeNull();
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so the session on screen is empty",
  ).toBeGreaterThan(0);
  expect(await readBoundSessionIds(consoleApplication)).toContain(FLAGSHIP_SESSION_ID);
}
