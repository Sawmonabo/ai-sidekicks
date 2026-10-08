// The endurance tier's driving vocabulary, shared by the files in it.
//
// Two tests drive the same app the same way (one measures how the heap moves over
// sustained use, the other what it is once the app has settled) and both need a route
// observed, the scenario advanced and the store read back. A copy in each file would be two
// drivers that drift silently, since a route wait that stopped waiting still passes. The heap
// itself is read through `heap/instrument.ts`, which measures rather than drives.
//
// The route waits name a screen, not the frame. `.meridian-frame` is permanent chrome, on the
// page before and after a route change, so a wait on it returns at once and the next navigation
// can land before React mounted anything, giving a churn loop that reports clean heap growth
// because it never performed the mount and unmount it claims to measure. Each transition waits
// on something only its destination renders; the route locators below are production markup.
//
// Each locator names a structure only its own route mounts: the settings frame's page list pane,
// and the transcript pane. An empty-state class would not do, because the transcript renders its
// own `empty` when a session has no rows and the settings pages render `not-checked` empty
// states.
// When a screen changes shape, its locator stops matching and this tier fails on a wait timeout
// naming the selector, which is right: a driver that cannot see the screen it drives should
// stop, not keep measuring an unobserved loop.

import { expect } from "vitest";

import type { AppUnderTest, LaunchAppOptions } from "../helpers/electron/harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";
import { ENDURANCE_BODY_ALLOWANCE_MS } from "../helpers/launch/budgets.js";
import { closePalette, openPalette } from "../helpers/palette-interaction.js";
import {
  scenarioDeliverySchedule,
  type ScenarioDeliverySchedule,
} from "./scenario-delivery-schedule.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
} from "#renderer/app/fixture/global-names.js";
import type { SessionDiagnostics } from "#renderer/services/session-events/diagnostics-handle.js";
import { type ScenarioFixtureHandle } from "#renderer/services/daemon/selection.fixture.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { TRANSCRIPT_ROW_BOX_SELECTOR } from "./transcript/window-read.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";

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
    // `readSettledHeapBytes` in `heap/instrument.ts` for why the default instrument cannot carry
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
export const CONCURRENT_STREAMING_SESSION_ROUTE: string = formatRoute({
  kind: "session",
  sessionId: CONCURRENT_STREAMING_SESSION_ID,
});

/** The hash route of the settings destination. */
export const SETTINGS_ROUTE: string = "#/settings";

/**
 * What the settings route renders and the session screen does not: the page list pane, the one
 * piece of markup that exists if and only if this screen mounted. It is anchored under the
 * frame's screen region so a same-class element in the rail, a banner or an overlay cannot
 * satisfy the wait.
 */
export const SETTINGS_SCREEN_SELECTOR: string =
  ".meridian-frame__screen .meridian-settings__list-pane";

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

/** The conversation's scroller in the frame's screen region. */
export const CONVERSATION_SCROLLER_SELECTOR: string =
  ".meridian-frame__screen .meridian-transcript-viewport__scroll-container";

/**
 * Assign the hash and wait for the screen only that route mounts. The wait carries
 * `IN_WINDOW_STEP_TIMEOUT_MS` (a route change is one store update and one React commit, so it
 * bounds an app that stopped navigating) and is also held to what is left of the body's
 * allowance, so the enclosing race does not replace the selector's name with the generic
 * overrun.
 */
export async function openRoute(
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
  return appUnderTest.consolePage.evaluate(
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
  return appUnderTest.consolePage.evaluate((globalName: string) => {
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
  return appUnderTest.consolePage.evaluate(
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
  return appUnderTest.consolePage.evaluate((globalName: string) => {
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
    `${SESSION_DIAGNOSTICS_FIXTURE_GLOBAL} is not exposed by this build, ` +
      `so nothing can be shown about where the workload's events went`,
  ).not.toBeNull();
  expect(
    Number(appliedEventCount),
    "no event reached this window's session store, so the session on screen is empty",
  ).toBeGreaterThan(0);
  expect(await readBoundSessionIds(appUnderTest)).toContain(CONCURRENT_STREAMING_SESSION_ID);
}

/** How many beats the scenario has delivered; throws when the build exposes no scenario handle. */
export async function readDeliveredBeatCount(appUnderTest: AppUnderTest): Promise<number> {
  const beatCount = await advanceScenario(appUnderTest, 0);
  if (beatCount === null) {
    throw new Error(`${SCENARIO_FIXTURE_GLOBAL} is not exposed by this build`);
  }
  return beatCount;
}

/** Waits, on the window's own frames, until the scenario has delivered `beatCount` beats. */
export async function waitForDeliveredBeats(
  appUnderTest: AppUnderTest,
  beatCount: number,
): Promise<void> {
  await appUnderTest.window.waitForFunction(
    ([scenarioGlobalName, targetBeatCount]: [string, number]) => {
      // The scenario's handle is the console document's, which opened this window.
      const consoleRealm = (window.opener ?? globalThis) as unknown as Record<
        string,
        { deliveredBeatCount(): number } | undefined
      >;
      return (consoleRealm[scenarioGlobalName]?.deliveredBeatCount() ?? 0) >= targetBeatCount;
    },
    [SCENARIO_FIXTURE_GLOBAL, beatCount] as [string, number],
    { timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS) },
  );
}

/**
 * Waits for the window's next idle period, which is when a bar that waits for idle starts, so a
 * gesture lands on the scrollers as a person who paused over them finds them.
 */
export async function waitForIdleWindow(appUnderTest: AppUnderTest): Promise<void> {
  await appUnderTest.window.evaluate(
    async (timeoutMs: number) =>
      await new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: timeoutMs });
      }),
    appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  );
}

/** A stretch of the script the window delivers at a steady pace, in scenario milliseconds. */
export interface PacedDelivery {
  /** Scenario time moved at once, before the pace starts. */
  readonly leadInMs: number;
  /** Scenario time moved across the pace, a frame at a time. */
  readonly stretchMs: number;
  /** Wall-clock time the stretch is spread across; the clock stops at its end. */
  readonly durationMs: number;
}

/** How far a paced delivery got: the delivered beats when the pace started and when it stopped. */
export interface PacedDeliveryReading {
  readonly beatsAtStart: number;
  readonly beatsAtStop: number;
}

/**
 * Moves the scenario's clock by the lead-in, then on every frame of the window by the share of the
 * stretch the elapsed wall-clock time has reached, so the stretch is delivered evenly however fast
 * the display refreshes. Returns the call that stops the pace and reads how far it got.
 */
export async function startPacedDelivery(
  appUnderTest: AppUnderTest,
  delivery: PacedDelivery,
): Promise<() => Promise<PacedDeliveryReading>> {
  // Wrapped in an object, because a handle to a promise would wait for it to settle.
  const pace = await appUnderTest.window.evaluateHandle(
    ([scenarioGlobalName, leadInMs, stretchMs, durationMs]: [string, number, number, number]) => {
      const consoleRealm = (window.opener ?? globalThis) as unknown as Record<
        string,
        { advance(milliseconds: number): void; deliveredBeatCount(): number } | undefined
      >;
      const scenarioControl = consoleRealm[scenarioGlobalName];
      if (scenarioControl === undefined) {
        throw new Error(`${scenarioGlobalName} is not exposed by this build`);
      }
      scenarioControl.advance(leadInMs);
      const beatsAtStart = scenarioControl.deliveredBeatCount();
      const startedAtMs = performance.now();
      let deliveredMs = 0;
      let isPacing = true;
      const onFrame = (): void => {
        if (!isPacing) {
          return;
        }
        const shareReached = Math.min(1, (performance.now() - startedAtMs) / durationMs);
        // Whole milliseconds, the clock's own step.
        const dueMs = Math.floor(stretchMs * shareReached) - deliveredMs;
        if (dueMs > 0) {
          scenarioControl.advance(dueMs);
          deliveredMs += dueMs;
        }
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      return {
        stop: () => {
          isPacing = false;
          return { beatsAtStart, beatsAtStop: scenarioControl.deliveredBeatCount() };
        },
      };
    },
    [SCENARIO_FIXTURE_GLOBAL, delivery.leadInMs, delivery.stretchMs, delivery.durationMs] as [
      string,
      number,
      number,
      number,
    ],
  );
  return async () => {
    const reading = await pace.evaluate((running) => running.stop());
    await pace.dispose();
    return reading;
  };
}
