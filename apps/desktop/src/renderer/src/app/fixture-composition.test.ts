// The fixture launch as the renderer takes it: which scenario plays, which session opens, and
// the handles a driver in another process reads off the page. A missing handle makes an Electron
// tier measure nothing and still pass, so each case reads the page as a driver does and the
// launch cases carry the control that fails without them.

import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { formatRoute } from "@renderer/routing/routes.js";
import type { ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import type { Clock } from "@renderer/lib/clock.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { FIXTURE_APP_META } from "@renderer/services/platform/platform-bridge.fixture.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { FIXTURE_LAUNCH_GLOBAL } from "@shared/fixture-launch.js";
import { createStubBridge } from "@shared/preload-api.js";
import { FIRST_RUN_SCENARIO_ID } from "../../../../fixtures/scenarios/first-run.js";
import {
  CONCURRENT_STREAMING_SCENARIO_ID,
  CONCURRENT_STREAMING_SCENARIO,
} from "../../../../fixtures/scenarios/concurrent-streaming.js";
import { composeFixtureLaunch, createFixtureComposition } from "./fixture-composition.js";
import {
  SCENARIO_FIXTURE_GLOBAL,
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  TRIPWIRE_FIXTURE_GLOBAL,
} from "./fixture-global-names.js";

const page = globalThis as unknown as Record<string, unknown>;

function scenarioControlOnPage(): ScenarioFixtureHandle | undefined {
  return page[SCENARIO_FIXTURE_GLOBAL] as ScenarioFixtureHandle | undefined;
}

const NO_DIAGNOSTICS: SessionDiagnostics = {
  openSessionIds: () => [],
  appliedEventCountFor: () => 0,
  boundSessionIds: () => [],
  transcriptWindowFor: () => null,
};

afterEach(() => {
  delete page[FIXTURE_LAUNCH_GLOBAL];
  delete page["desktopBridge"];
  window.location.hash = "";
});

/** Mount a window the way `App` does, and hand back the clock its screens read. */
function windowClock(launched: ReturnType<typeof composeFixtureLaunch>): Clock {
  const seen: Clock[] = [];
  function ClockProbe(): null {
    seen.push(useClock());
    return null;
  }
  render(
    createElement(PlatformBridgeProvider, {
      children: createElement(ClockProbe),
      ...(launched === undefined ? {} : { composition: launched }),
    }),
  );
  const clock = seen.at(-1);
  if (clock === undefined) {
    throw new Error("the window rendered no screen to read its clock");
  }
  return clock;
}

describe("composeFixtureLaunch — the launch the preload exposed", () => {
  it("composes nothing for a window started without a launch", () => {
    expect(composeFixtureLaunch()).toBeUndefined();
  });

  it("plays the named scenario and opens the named session before the first render", () => {
    page[FIXTURE_LAUNCH_GLOBAL] = {
      scenarioId: CONCURRENT_STREAMING_SCENARIO_ID,
      sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    };

    const remove = composeFixtureLaunch()?.createBridge().installHandles();

    expect(scenarioControlOnPage()?.scenarioId).toBe(CONCURRENT_STREAMING_SCENARIO_ID);
    remove?.();
    expect(window.location.hash).toBe(
      formatRoute({ kind: "session", sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId }),
    );
  });

  it("leaves the address alone for a launch that names no session", () => {
    page[FIXTURE_LAUNCH_GLOBAL] = { scenarioId: FIRST_RUN_SCENARIO_ID };

    const remove = composeFixtureLaunch()?.createBridge().installHandles();

    expect(scenarioControlOnPage()?.scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
    remove?.();
    expect(window.location.hash).toBe("");
  });
});

describe("createFixtureComposition — the handles a driver reads", () => {
  it("hangs the running scenario's control and the tripwire registry, and takes both down", () => {
    const composed = createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID).createBridge();

    const remove = composed.installHandles();

    const control = scenarioControlOnPage();
    expect(control?.scenarioId).toBe(CONCURRENT_STREAMING_SCENARIO_ID);
    // The control drives this bridge's engine: the window's clock moves.
    const before = composed.clock.now();
    control?.advance(1);
    expect(control?.deliveredBeatCount()).toBeGreaterThan(0);
    expect(composed.clock.now()).toBe(before + 1);
    expect(page[TRIPWIRE_FIXTURE_GLOBAL]).toBe(windowTripwires);

    remove();
    expect(scenarioControlOnPage()).toBeUndefined();
    expect(page[TRIPWIRE_FIXTURE_GLOBAL]).toBeUndefined();
  });

  it("a superseded window's teardown leaves the live window's handles up", () => {
    // Several consoles mount into one document in the browser tiers; an unconditional delete
    // would strip the second window's handles.
    const first = createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const second = createFixtureComposition(FIRST_RUN_SCENARIO_ID);
    const removeFirst = first.createBridge().installHandles();
    const removeSecond = second.createBridge().installHandles();
    const removeFirstDiagnostics = first.installSessionDiagnostics(NO_DIAGNOSTICS);
    const liveDiagnostics: SessionDiagnostics = { ...NO_DIAGNOSTICS };
    const removeSecondDiagnostics = second.installSessionDiagnostics(liveDiagnostics);

    removeFirst();
    removeFirstDiagnostics();

    expect(scenarioControlOnPage()?.scenarioId).toBe(FIRST_RUN_SCENARIO_ID);
    expect(page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL]).toBe(liveDiagnostics);

    removeSecond();
    removeSecondDiagnostics();
    expect(scenarioControlOnPage()).toBeUndefined();
    expect(page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL]).toBeUndefined();
  });
});

describe("the clock a window runs on", () => {
  it("runs a fixture-launched window on the scenario's frozen clock", () => {
    page[FIXTURE_LAUNCH_GLOBAL] = { scenarioId: CONCURRENT_STREAMING_SCENARIO_ID };

    const clock = windowClock(composeFixtureLaunch());
    const scenarioStart = parseInstant(
      CONCURRENT_STREAMING_SCENARIO.startedAtIso,
    ).epochMilliseconds;

    expect(clock.now()).toBe(scenarioStart);
    // Frozen: only the scenario moves it, through the control on the page.
    scenarioControlOnPage()?.advance(250);
    expect(clock.now()).toBe((scenarioStart ?? 0) + 250);
  });

  it("runs a window started without a launch on real time", () => {
    page["desktopBridge"] = createStubBridge(FIXTURE_APP_META);

    const clock = windowClock(composeFixtureLaunch());

    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
  });
});
