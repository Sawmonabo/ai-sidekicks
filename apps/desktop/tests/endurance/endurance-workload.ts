// The endurance tier's driving vocabulary, shared by the files in it.
//
// Two tests drive the same app the same way (one measures how the heap moves over
// sustained use, the other what it is once the app has settled) and both need a route
// observed, the scenario advanced and the store read back. A copy in each file would be two
// drivers that drift silently, since a route wait that stopped waiting still passes. The heap
// itself is read through `heap-instrument.ts`, which measures rather than drives.
//
// The route waits name a screen, not the frame. `.meridian-frame` is permanent chrome, on the
// page before and after a route change, so a wait on it returns at once and the next navigation
// can land before React mounted anything, giving a churn loop that reports clean heap growth
// because it never performed the mount and unmount it claims to measure. Each transition waits
// on something only its destination renders; the route locators below are production markup.
//
// Each locator names a structure only its own route mounts: the settings frame's section rail,
// and the transcript pane. An empty-state class would not do, because the transcript renders its
// own `empty` when a session has no rows and the settings pages render `not-checked` empty
// states.
// When a screen changes shape, its locator stops matching and this tier fails on a wait timeout
// naming the selector, which is right: a driver that cannot see the screen it drives should
// stop, not keep measuring an unobserved loop.

import { expect } from "vitest";

import type { AppUnderTest, LaunchAppOptions } from "../helpers/electron-harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { ENDURANCE_BODY_ALLOWANCE_MS } from "../helpers/launch-budgets.js";
import { closePalette, openPalette } from "../helpers/palette-interaction.js";
import {
  scenarioDeliverySchedule,
  type ScenarioDeliverySchedule,
} from "./scenario-delivery-schedule.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
} from "@renderer/app/fixture-global-names.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { type ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import { TRANSCRIPT_ROW_BOX_SELECTOR } from "./transcript-window-read.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";

/**
 * How every launch in this tier is asked for: the given script and the tier's own body
 * allowance. An endurance body drives hundreds of churn cycles with settling heap samples
 * either side, so the tier has its own registered figure, and its `testTimeout` derives from the
 * same figure (`tierTimeoutFor`); the default allowance would bound a launch far more tightly
 * than the tier that runs it.
 */
export function enduranceLaunchOptions(scenarioId: string): LaunchAppOptions {
  return {
    scenarioId,
    bodyAllowanceMs: ENDURANCE_BODY_ALLOWANCE_MS,
    // Every figure this tier gates is a difference of two heap readings; see
    // `readSettledHeapBytes` in `heap-instrument.ts` for why the default instrument cannot carry
    // one.
    isPreciseHeapReadingRequired: true,
  };
}

/** Launch options for the concurrent-streaming script. */
export const ENDURANCE_LAUNCH_OPTIONS: LaunchAppOptions = enduranceLaunchOptions(
  CONCURRENT_STREAMING_SCENARIO.id,
);

/** The session id the concurrent-streaming script plays into. */
export const CONCURRENT_STREAMING_SESSION_ID: string = CONCURRENT_STREAMING_SCENARIO.sessionId;

/** The hash route of the concurrent-streaming session. */
export const CONCURRENT_STREAMING_SESSION_ROUTE: string = `#/session/${encodeURIComponent(CONCURRENT_STREAMING_SESSION_ID)}`;

/** The hash route of the settings destination. */
export const SETTINGS_ROUTE: string = "#/settings";

/**
 * What the settings route renders and the session screen does not: the section rail, the one
 * piece of markup that exists if and only if this screen mounted. It is anchored under the
 * frame's screen region so a same-class element in the rail, a banner or an overlay cannot
 * satisfy the wait.
 */
export const SETTINGS_SCREEN_SELECTOR: string = ".meridian-frame__screen .meridian-settings__rail";

/**
 * What the session screen renders and the settings route does not: the transcript pane, which
 * every session route mounts whether or not the session has rows yet, so the wait observes the
 * mount rather than the arrival of content. The transcript's body would not do, since its
 * children are all conditional and before the first read settles it has no box at all.
 */
export const SESSION_SCREEN_SELECTOR: string = ".meridian-frame__screen .meridian-pane--transcript";

/**
 * One transcript row, anchored under the frame's screen region. The pane says the session
 * screen mounted; a row says the projection, the window fold and the viewport's reconcile have
 * run and something is on screen. The churn loop needs the first and the budget readings the
 * second, so both selectors live here.
 */
export const TRANSCRIPT_ROW_SELECTOR: string =
  ".meridian-frame__screen .meridian-transcript-row-layout";

/**
 * Assign the hash and wait for the screen only that route mounts. The wait carries
 * `IN_WINDOW_STEP_TIMEOUT_MS` (a route change is one store update and one React commit, so it
 * bounds an app that stopped navigating) and is also held to what is left of the body's
 * allowance, so the enclosing race does not replace the selector's name with the generic
 * overrun.
 */
async function openRoute(
  appUnderTest: AppUnderTest,
  hash: string,
  screenSelector: string,
): Promise<void> {
  await appUnderTest.window.evaluate((targetHash: string) => {
    globalThis.location.hash = targetHash;
  }, hash);
  await appUnderTest.window.locator(screenSelector).waitFor({
    state: "visible",
    timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
}

/** Open the settings route and wait for its screen. */
export async function openSettingsRoute(appUnderTest: AppUnderTest): Promise<void> {
  await openRoute(appUnderTest, SETTINGS_ROUTE, SETTINGS_SCREEN_SELECTOR);
}

/** Open the concurrent-streaming session and wait for its screen. */
export async function openConcurrentStreamingSessionRoute(
  appUnderTest: AppUnderTest,
): Promise<void> {
  await openRoute(appUnderTest, CONCURRENT_STREAMING_SESSION_ROUTE, SESSION_SCREEN_SELECTOR);
}

/**
 * Move the scenario on, and report how many beats it has delivered. `null` means the handle is
 * not on the page, which this tier treats as a failure and never a reason to skip: a run that
 * could not drive the workload measured an idle app.
 */
export async function advanceScenario(
  appUnderTest: AppUnderTest,
  milliseconds: number,
): Promise<number | null> {
  return appUnderTest.window.evaluate(
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

/** Which scenario the launched app is actually playing, or `null`. */
export async function readPlayingScenarioId(appUnderTest: AppUnderTest): Promise<string | null> {
  return appUnderTest.window.evaluate((globalName: string) => {
    const control = (globalThis as unknown as Record<string, ScenarioFixtureHandle | undefined>)[
      globalName
    ];
    return control === undefined ? null : control.scenarioId;
  }, SCENARIO_FIXTURE_GLOBAL);
}

/**
 * How many events the store for one session has admitted to the apply chokepoint, or `null`.
 * It differs from the beats the engine delivered and from the transcript's row count, and
 * answers whether a stream reached this window's stores at all.
 */
export async function readAppliedEventCount(
  appUnderTest: AppUnderTest,
  sessionId: string,
): Promise<number | null> {
  return appUnderTest.window.evaluate(
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
  appUnderTest: AppUnderTest,
): Promise<readonly string[] | null> {
  return appUnderTest.window.evaluate((globalName: string) => {
    const sessions = (globalThis as unknown as Record<string, SessionDiagnostics | undefined>)[
      globalName
    ];
    return sessions === undefined ? null : [...sessions.boundSessionIds()];
  }, SESSION_DIAGNOSTICS_FIXTURE_GLOBAL);
}

/**
 * What one churn cycle saw, in the two registers a caller can be fooled in. The row count is
 * here because the session screen wait names the transcript pane, which mounts its chrome
 * whether or not a row is ever drawn; without the count, a run whose transcript never mounted
 * would report clean heap growth over a transcript that is not there.
 */
export interface ChurnCycleReading {
  /** Beats the engine has delivered, or `null` where the handle is not on the page. */
  readonly deliveredBeatCount: number | null;
  /** Row boxes the virtualizer had placed when the cycle closed. */
  readonly transcriptRowCount: number;
}

/**
 * One cycle of the work an app does while a person watches it: navigation and palette use,
 * not synthetic allocation, because leaks live in the machinery those exercise (subscriptions,
 * effects, portals, the listener table). The clock moves once per cycle so the scenario delivers
 * into that machinery while it is churned. Each route change is observed before the next is
 * issued, since the mount and unmount are the subject. Returns what the cycle saw, so a caller
 * can assert the workload progressed over a transcript.
 */
export async function churnOnce(
  appUnderTest: AppUnderTest,
  advanceMilliseconds: number,
): Promise<ChurnCycleReading> {
  const appWindow = appUnderTest.window;
  // The shared palette helper waits for the input to hold focus. Typing into an unfocused
  // palette is silent: the keystrokes go to the document and the cycle reports a clean churn
  // over machinery it did not touch.
  await openPalette(appUnderTest);
  await appWindow.keyboard.type("Go to");
  await closePalette(appUnderTest);

  // Route changes mount and unmount the screen subtree through the error boundary's keyed
  // remount, the path most likely to strand a listener. One route is the scenario's own session,
  // so the cycle also re-reads the store the beats land in.
  await openSettingsRoute(appUnderTest);
  await openConcurrentStreamingSessionRoute(appUnderTest);

  const deliveredBeatCount = await advanceScenario(appUnderTest, advanceMilliseconds);
  // Counted after the advance, so it reports the transcript the just-delivered beats landed in.
  // A count and not a wait: early cycles legitimately have no row, as the script is walked over
  // the whole run, and a wait would spend the body's allowance on an expected state.
  const transcriptRowCount = await appWindow.locator(TRANSCRIPT_ROW_BOX_SELECTOR).count();
  return { deliveredBeatCount, transcriptRowCount };
}

/** The walk that puts the whole concurrent-streaming script in and leaves nothing queued. */
export function concurrentStreamingDeliverySchedule(): ScenarioDeliverySchedule {
  return scenarioDeliverySchedule(CONCURRENT_STREAMING_SCENARIO.beats.at(-1)?.atMs ?? 0);
}

/**
 * Play the concurrent-streaming script to its end and let the stores settle on it. Returns the
 * beats delivered so a caller can assert the session has content.
 */
export async function deliverWholeScenario(appUnderTest: AppUnderTest): Promise<number | null> {
  const { stepMilliseconds, stepCount } = concurrentStreamingDeliverySchedule();
  let deliveredBeatCount: number | null = null;
  for (let step = 0; step < stepCount; step += 1) {
    deliveredBeatCount = await advanceScenario(appUnderTest, stepMilliseconds);
  }
  return deliveredBeatCount;
}

/**
 * Assert this window's session store holds the concurrent-streaming script's events: the
 * steady-state run needs the workload to have been one, and the at-rest reading needs one open
 * session with content on screen when the heap is read.
 */
export async function expectConcurrentStreamingSessionCarriesContent(
  appUnderTest: AppUnderTest,
): Promise<void> {
  const appliedEventCount = await readAppliedEventCount(
    appUnderTest,
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
  expect(await readBoundSessionIds(appUnderTest)).toContain(CONCURRENT_STREAMING_SESSION_ID);
}
