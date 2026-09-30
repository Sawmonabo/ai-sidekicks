// Mounting the composed window once for every suite that drives it. The `AppProviders` suites
// drive the real composition root against the fixture bridge, and one copy of the mount gives
// one answer to "when has the console settled".

import { act, render, type RenderResult } from "@testing-library/react";

import { createFixtureComposition } from "@renderer/app/fixture-composition.js";
import { AppProviders } from "@renderer/app/providers.js";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "../../fixtures/scenarios/transcript-states.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
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

/**
 * Let every registered screen body finish arriving: the one answer to "has the destination
 * landed" for suites that drive the composed window.
 *
 * A destination is a dynamic import behind the screen board, so the frame commits the reserved
 * region first and the body later. Awaiting the board's `preload` is deterministic, where counting
 * boundaries would fail the day a feature gained an import. It walks every registered screen, not
 * `unloadedKeys()`: the press this helper follows already asked for its destination, so that list
 * would be empty and the walk would return with the body in flight.
 *
 * The pane board is not walked: these suites drive screens, and loading every pane kind would
 * stand up emulators and browser views no case asked for. `app-harness.ts` preloads panes inside
 * `renderSettled`. Call this where a case reaches a loader-backed destination, not from `mountApp`:
 * a window opens on the sessions route, registered in component form, and a blanket walk would
 * compile every feature's chunk at every mount.
 */
export async function settleRegisteredBodies(): Promise<void> {
  await act(async () => {
    await Promise.all(
      screenRegistry
        .registeredScreenNames()
        .map((screenName) => screenRegistry.preload(screenName)),
    );
    await crossMacrotaskBoundary();
  });
}
