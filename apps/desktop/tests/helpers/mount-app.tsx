// Mounting the composed app once for every suite that drives it. The `AppProviders` suites drive
// the real composition root against the fixture bridge, and one copy of the mount gives one answer
// to "when has the app settled".

import { act, render } from "@testing-library/react";
import { onTestFinished } from "vitest";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/AppProviders.js";
import { FIXTURE_WINDOW_ID } from "@renderer/services/platform/platform-bridge.fixture.js";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "../../fixtures/scenarios/transcript-states.js";
import { FrameWindows } from "./frame-windows.js";
import { crossMacrotaskBoundary } from "./macrotask-boundary.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/** The mounted app: the window it opened first, and every window it opened. */
export interface MountedApp {
  /** The window used last at the scenario's launch, which the app opens first. */
  readonly ownerWindow: Window;
  readonly frames: FrameWindows;
}

/**
 * Mount the app playing the transcript-states scenario, and let the settled promises land. Its
 * windows are removed when the test finishes.
 *
 * The scenario is the busy transcript because a window with rows exercises what these suites
 * drive. `AppProviders` opens persistence on mount and swaps the durable adapter in when it
 * settles, so asserting straight after `render` would see a half-settled tree and a state update
 * outside `act`. It flushes twice (`act`, then a macrotask boundary) because the open resolves a
 * promise whose continuation schedules another.
 */
export async function mountApp(): Promise<MountedApp> {
  const frames = new FrameWindows();
  onTestFinished(() => {
    frames.removeAll();
  });
  await act(async () => {
    render(
      <AppProviders
        composition={createFixtureComposition(TRANSCRIPT_STATES_SCENARIO_ID)}
        openWindow={frames.open}
      />,
    );
    await crossMacrotaskBoundary();
  });
  return { ownerWindow: frames.windowNamed(FIXTURE_WINDOW_ID), frames };
}
