// The endurance tier's driving vocabulary, shared by the files in it.
//
// Two tests in this tier drive the same console in the same way — one measures
// how the heap MOVES over sustained use, the other what it IS once the console
// has settled — and both need the same three things: a route observed, the
// scenario advanced, and the store read back. A copy of any of those in each
// file would be two drivers that drift, and the drift would not be loud: a route
// wait that stopped waiting still passes. The heap itself is read through
// `heap-instrument.ts`, which measures rather than drives.
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
// Both are production markup, and neither is a test-only attribute added to the
// renderer to make this observable.
//
// Each locator names a STRUCTURE only its own route mounts, and both routes have
// shipped their surface now. The settings destination is the settings frame, so its
// locator is that frame's own section rail; the session screen is the transcript, so
// its locator is the scroll container the whole surface is built around. Neither was
// always so: each was an absence class while its surface was a reserved slot, and the
// pair stopped being route-exclusive the moment either family shipped — the transcript
// renders its own `empty` when a session has no rows yet, and the settings pages
// render `not-checked` absences of their own.
//
// When either surface changes shape, its locator stops matching and this tier fails
// on a wait timeout naming the selector. That is the right direction: a driver that
// can no longer see the surface it drives should stop, not continue measuring an
// unobserved loop.

import { expect } from "vitest";

import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import type { AppUnderTest, LaunchAppOptions } from "../helpers/electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { ENDURANCE_BODY_ALLOWANCE_MS } from "../helpers/launch-budgets.js";
import { closePalette, openPalette } from "../helpers/palette-interaction.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
} from "@renderer/app/fixture-global-names.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { type ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import { TRANSCRIPT_ROW_BOX_SELECTOR } from "./transcript-window-read.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";

/**
 * How every launch in this tier is asked for: the concurrent-streaming script, and the
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
export function enduranceLaunchOptions(scenarioId: string): LaunchAppOptions {
  return {
    scenarioId,
    bodyAllowanceMs: ENDURANCE_BODY_ALLOWANCE_MS,
    // Every launch in this tier reads a heap, and every figure it gates is a
    // DIFFERENCE of two such readings. See `readSettledHeapBytes` for why the
    // default instrument cannot carry one.
    isPreciseHeapReadingRequired: true,
  };
}

export const ENDURANCE_LAUNCH_OPTIONS: LaunchAppOptions = enduranceLaunchOptions(
  CONCURRENT_STREAMING_SCENARIO.id,
);

export const CONCURRENT_STREAMING_SESSION_ID: string = CONCURRENT_STREAMING_SCENARIO.sessionId;

export const CONCURRENT_STREAMING_SESSION_ROUTE: string = `#/session/${encodeURIComponent(CONCURRENT_STREAMING_SESSION_ID)}`;

export const SETTINGS_ROUTE: string = "#/settings";

/**
 * What the settings route renders and the session screen does not.
 *
 * Anchored under the frame's screen slot, so an element of the same class mounted
 * in the rail, a banner, or an overlay cannot satisfy the wait for a surface that
 * never mounted.
 *
 * The section rail rather than one of the surface's absences: the pages inside the
 * settings frame render absences of their own — several of them `not-checked`,
 * because the reads behind them are unregistered — so an absence-kind selector here
 * would no longer be route-exclusive against the session screen's. The rail is the one
 * piece of markup that exists if and only if this surface mounted.
 */
export const SETTINGS_SCREEN_SELECTOR: string = ".meridian-frame__surface .meridian-settings__rail";

/**
 * What the session screen renders and the settings route does not.
 *
 * The transcript PANE, which the session screen mounts on every session route whether or not
 * that session has rows yet — so the wait observes the MOUNT rather than the arrival of
 * content, which is what a churn cycle needs it to observe.
 *
 * NOT the transcript's body, which was this selector until the provenance rail was removed:
 * that box is a container whose children are all conditional, so before the session's
 * first read settles it holds a virtualized list with nothing in it and has no box at
 * all. It satisfied a visibility wait only because the rail beside the window drew an
 * unconditional strip — a wait that passed on the presence of a surface it was not
 * asking about. The pane is the element the ROUTE mounts, which is the claim this
 * constant is making.
 */
export const SESSION_SCREEN_SELECTOR: string =
  ".meridian-frame__surface .meridian-pane--transcript";

/**
 * One transcript row, anchored under the frame's surface.
 *
 * The PANE says the session screen mounted; a ROW says the projection, the window
 * fold and the viewport's reconcile have all run and something is on screen. The
 * two budget readings in this tier need the second claim and the churn loop needs
 * the first, so both selectors live here and neither tier spells one itself.
 */
export const TRANSCRIPT_ROW_SELECTOR: string =
  ".meridian-frame__surface .meridian-transcript-row-layout";

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
  consoleApplication: AppUnderTest,
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

export async function openSettingsRoute(consoleApplication: AppUnderTest): Promise<void> {
  await openRoute(consoleApplication, SETTINGS_ROUTE, SETTINGS_SCREEN_SELECTOR);
}

export async function openConcurrentStreamingSessionRoute(
  consoleApplication: AppUnderTest,
): Promise<void> {
  await openRoute(consoleApplication, CONCURRENT_STREAMING_SESSION_ROUTE, SESSION_SCREEN_SELECTOR);
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
  consoleApplication: AppUnderTest,
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
  consoleApplication: AppUnderTest,
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
  consoleApplication: AppUnderTest,
  sessionId: string,
): Promise<number | null> {
  return consoleApplication.window.evaluate(
    ([globalName, targetSessionId]: [string, string]) => {
      const sessions = (globalThis as unknown as Record<string, SessionDiagnostics | undefined>)[
        globalName
      ];
      return sessions === undefined ? null : sessions.appliedEventCountFor(targetSessionId);
    },
    [SESSION_DIAGNOSTICS_FIXTURE_GLOBAL, sessionId] as [string, string],
  );
}

/** Sessions this window holds a wire subscription for, or `null` with no handle. */
export async function readBoundSessionIds(
  consoleApplication: AppUnderTest,
): Promise<readonly string[] | null> {
  return consoleApplication.window.evaluate((globalName: string) => {
    const sessions = (globalThis as unknown as Record<string, SessionDiagnostics | undefined>)[
      globalName
    ];
    return sessions === undefined ? null : [...sessions.boundSessionIds()];
  }, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL);
}

/**
 * What one churn cycle saw, in the two registers a caller can be fooled in.
 *
 * THE ROW COUNT IS HERE BECAUSE THE ROUTE WAIT STOPPED CARRYING IT. The session screen
 * wait names the transcript PANE, which mounts its chrome whether or not the transcript
 * inside it ever draws a row — so a run whose transcript never mounted churns the whole
 * loop, waits successfully every time, and reports clean heap growth over a surface
 * that is not there. The pane says the route arrived; this says the surface under it
 * came up.
 */
export interface ChurnCycleReading {
  /** Beats the engine has delivered, or `null` where the handle is not on the page. */
  readonly deliveredBeatCount: number | null;
  /** Row boxes the virtualizer had placed when the cycle closed. */
  readonly transcriptRowCount: number;
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
 * Returns what the cycle saw, so a caller can assert the workload progressed and
 * that it progressed over a transcript, without paying for a second round trip.
 */
export async function churnOnce(
  consoleApplication: AppUnderTest,
  advanceMilliseconds: number,
): Promise<ChurnCycleReading> {
  const consoleWindow = consoleApplication.window;
  // Through the shared door, which waits for the input to hold focus before this
  // returns. Typing into an unfocused palette is silent here rather than red — the
  // keystrokes go to the document, the filter never runs, and the cycle reports a
  // clean churn over machinery it did not touch. That is the worse failure of the
  // two, because a measurement nobody can tell was not taken keeps being trusted.
  await openPalette(consoleApplication);
  await consoleWindow.keyboard.type("Go to");
  await closePalette(consoleApplication);

  // Route changes mount and unmount the surface subtree through the error
  // boundary's keyed remount — the path most likely to strand a listener. One of
  // the two routes is the scenario's own session, so the cycle also opens and
  // re-reads the store the beats are landing in.
  await openSettingsRoute(consoleApplication);
  await openConcurrentStreamingSessionRoute(consoleApplication);

  const deliveredBeatCount = await advanceScenario(consoleApplication, advanceMilliseconds);
  // Counted AFTER the advance, so the cycle reports the transcript the beats it just
  // delivered landed in. A count and not a wait: the early cycles legitimately have
  // no row — the concurrent-streaming script is walked over the whole run — so a wait here would
  // spend the body's allowance on a state the run is expecting. What the caller does
  // with the sequence of counts is the claim; this only reports them.
  const transcriptRowCount = await consoleWindow.locator(TRANSCRIPT_ROW_BOX_SELECTOR).count();
  return { deliveredBeatCount, transcriptRowCount };
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

/** How the frozen clock is walked over the concurrent-streaming script, and how far. */
export interface ScenarioDeliverySchedule {
  readonly stepMilliseconds: number;
  readonly stepCount: number;
}

/**
 * The walk that puts the whole concurrent-streaming script in and leaves nothing queued.
 *
 * One derivation rather than three: this tier walks the script from the driver
 * process and the two budget readings walk it from INSIDE the renderer, where a
 * round trip per advance would be the thing being measured. All three ask for the
 * same walk, and a copy of this arithmetic in each would be three places for a
 * beat to be left queued behind a deadline nothing reaches.
 *
 * The step is floored at one coalescing window, so every step also drains the
 * batch the step before it delivered. Today's script makes that floor inert — its
 * span over twenty steps is comfortably wider than the 16 ms window — and it is
 * stated anyway, because a shorter script would otherwise deliver beats no advance
 * in the loop ever released, and the failure would be a quiet one.
 */
export function concurrentStreamingDeliverySchedule(): ScenarioDeliverySchedule {
  const scriptSpanMs = CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0;
  return {
    stepMilliseconds: Math.max(
      APPLY_COALESCE_MS + 1,
      Math.ceil(scriptSpanMs / SCENARIO_DELIVERY_STEP_COUNT),
    ),
    stepCount: SCENARIO_DELIVERY_STEP_COUNT + SCENARIO_DRAIN_STEP_COUNT,
  };
}

/**
 * Play the concurrent-streaming script to its end and let the stores settle on it.
 *
 * Returns the beats delivered, so a caller can assert the session it is about to
 * measure actually has content rather than being an empty store with a route
 * pointed at it.
 */
export async function deliverWholeScenario(
  consoleApplication: AppUnderTest,
): Promise<number | null> {
  const { stepMilliseconds, stepCount } = concurrentStreamingDeliverySchedule();
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < stepCount; step += 1) {
    deliveredBeatCount = await advanceScenario(consoleApplication, stepMilliseconds);
  }
  return deliveredBeatCount;
}

/**
 * Assert this window's session store holds the concurrent-streaming script's events.
 *
 * Shared because both files need it for different reasons: the steady-state run
 * needs the workload to have been a workload, and the at-rest reading needs the
 * budget's subject — ONE SESSION OPEN, with content — to be what was on screen
 * when the heap was read.
 */
export async function expectConcurrentStreamingSessionCarriesContent(
  consoleApplication: AppUnderTest,
): Promise<void> {
  const appliedEventCount = await readAppliedEventCount(
    consoleApplication,
    CONCURRENT_STREAMING_SESSION_ID,
  );
  expect(
    appliedEventCount,
    `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, so nothing can be shown about where the workload's events went`,
  ).not.toBeNull();
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so the session on screen is empty",
  ).toBeGreaterThan(0);
  expect(await readBoundSessionIds(consoleApplication)).toContain(CONCURRENT_STREAMING_SESSION_ID);
}
