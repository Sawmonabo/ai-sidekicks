// Mounting the composed window once for every suite that drives it. The `AppProviders` suites
// drive the real composition root against the fixture bridge, and one copy of the mount gives
// one answer to "when has the console settled".

import { act, render, type RenderResult } from "@testing-library/react";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/AppProviders.js";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "../../fixtures/scenarios/transcript-states.js";
import { crossMacrotaskBoundary } from "./macrotask-boundary.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/**
 * Mount the console playing the transcript-states scenario, and let the settled promises land.
 *
 * The scenario is the busy transcript because a window with rows exercises what these suites
 * drive. `AppProviders` opens persistence on mount and swaps the durable adapter in when it
 * settles, so asserting straight after `render` would see a half-settled tree and a state update
 * outside `act`. It flushes twice (`act`, then a macrotask boundary) because the open resolves a
 * promise whose continuation schedules another.
 */
export async function mountApp(): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  await act(async () => {
    mounted = render(
      <AppProviders composition={createFixtureComposition(TRANSCRIPT_STATES_SCENARIO_ID)} />,
    );
    await crossMacrotaskBoundary();
  });
  if (mounted === undefined) {
    throw new Error("the console never mounted");
  }
  return mounted;
}
