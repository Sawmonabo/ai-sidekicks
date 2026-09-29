// The fixture launch as the renderer takes it: which scenario plays, which session opens,
// and the handles a driver in another process reads off the page.
//
// The Electron tiers drive a real window through those handles, so a handle missing from
// the page is a tier that measures nothing and passes. Each case therefore reads the page
// the way a driver does, and the launch cases each carry the control that fails without it.

import { afterEach, describe, expect, it } from "vitest";

import { windowTripwires } from "@renderer/lib/tripwires.js";
import { formatRoute } from "@renderer/routing/routes.js";
import type { ScenarioFixtureHandle } from "@renderer/services/daemon/selection.fixture.js";
import type { SessionDiagnostics } from "@renderer/services/session-events/session-diagnostics-handle.js";
import { FIXTURE_LAUNCH_GLOBAL } from "@shared/fixture-launch.js";
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
  ledgerWindowFor: () => null,
};

afterEach(() => {
  delete page[FIXTURE_LAUNCH_GLOBAL];
  window.location.hash = "";
});

describe("composeFixtureLaunch — the launch the preload exposed", () => {
  it("composes nothing for a window started without a launch", () => {
    expect(composeFixtureLaunch()).toBeUndefined();
  });

  it("plays the named scenario and opens the named session before the first render", () => {
    page[FIXTURE_LAUNCH_GLOBAL] = {
      scenarioId: CONCURRENT_STREAMING_SCENARIO_ID,
      sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
    };

    const composition = composeFixtureLaunch();

    expect(composition?.createBridge().scenarioEngine?.scenario.id).toBe(
      CONCURRENT_STREAMING_SCENARIO_ID,
    );
    expect(window.location.hash).toBe(
      formatRoute({ kind: "session", sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId }),
    );
  });

  it("leaves the address alone for a launch that names no session", () => {
    page[FIXTURE_LAUNCH_GLOBAL] = { scenarioId: FIRST_RUN_SCENARIO_ID };

    const composition = composeFixtureLaunch();

    expect(composition?.createBridge().scenarioEngine?.scenario.id).toBe(FIRST_RUN_SCENARIO_ID);
    expect(window.location.hash).toBe("");
  });
});

describe("createFixtureComposition — the handles a driver reads", () => {
  it("hangs the running scenario's control and the tripwire registry, and takes both down", () => {
    const composition = createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const bridge = composition.createBridge();

    const remove = composition.installBridgeHandles(bridge);

    const control = scenarioControlOnPage();
    expect(control?.scenarioId).toBe(CONCURRENT_STREAMING_SCENARIO_ID);
    // The control drives THIS bridge's engine, not one of its own.
    control?.advance(1);
    expect(bridge.scenarioEngine?.progress.deliveredBeatCount).toBeGreaterThan(0);
    expect(page[TRIPWIRE_FIXTURE_GLOBAL]).toBe(windowTripwires);

    remove();
    expect(scenarioControlOnPage()).toBeUndefined();
    expect(page[TRIPWIRE_FIXTURE_GLOBAL]).toBeUndefined();
  });

  it("a superseded window's teardown leaves the live window's handles up", () => {
    // Several consoles mount into one document in the browser tiers. An unconditional
    // delete on the first one's teardown would strip what the second had just put up.
    const first = createFixtureComposition(CONCURRENT_STREAMING_SCENARIO_ID);
    const second = createFixtureComposition(FIRST_RUN_SCENARIO_ID);
    const removeFirst = first.installBridgeHandles(first.createBridge());
    const removeSecond = second.installBridgeHandles(second.createBridge());
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
