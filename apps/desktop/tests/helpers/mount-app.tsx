// Mounting the composed window, once, for every suite that drives it.
//
// The `AppProviders` suites each drive the REAL composition root against the
// fixture bridge the `console-unit` project compiles in, so the mount is the one
// piece of scaffolding all of them share — and a second copy of it would be a
// second answer to "when has the console settled", which is exactly the question
// the two flushes below exist to answer once.

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
 * One named scenario for every suite that mounts the whole window, and the busy transcript
 * because a window with rows exercises what these suites drive.
 *
 * `AppProviders` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
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
 * Let every registered SCREEN body finish arriving.
 *
 * THE ONE ANSWER TO "HAS THE DESTINATION LANDED", for every suite that drives the
 * composed window. A feature's destination is a dynamic import behind the screen board,
 * so the frame commits the reserved region first and the body one or more macrotasks
 * later; a case that counted boundaries instead would be asserting how many turns a
 * chunk takes to arrive, and it would start failing the day a feature gained an import.
 * Awaiting the board's own `preload` is the deterministic wait — the same call the idle
 * warm walk and the rail's press make — so the assertions below it are about what the
 * screen renders and never about timing.
 *
 * THE PANE BOARD IS DELIBERATELY NOT WALKED HERE. A screen is what a rail destination
 * mounts, and that is what these suites drive; the pane board holds every kind a pane
 * layout can hold, including ones whose modules stand up an emulator or a browser view,
 * and loading all of them at every `AppProviders` mount stands up machinery no case
 * asked for. The pane side has its own answer — `app-harness.ts` preloads the pane
 * board inside `renderSettled`, where a case is actually mounting one.
 *
 * EVERY REGISTERED SCREEN, NOT THE UNLOADED ONES. `unloadedKeys()` reports the screens
 * nothing has ASKED for yet, and the press this helper follows is itself an ask: it warms
 * its destination before it navigates, so by the time a case waits the screen it is waiting
 * on has already left that list and a walk over it would await nothing at all and return
 * while the body was still in flight. Whether the assertion then passed came down to how
 * many macrotasks the mount happened to take, which is the timing dependence this helper
 * exists to remove — it showed up as a case that passed alone and failed in a full tier
 * run. `preload` settles immediately for a body already in hand and joins the one promise
 * for a body in flight, so walking the registered screens is idempotent and is the wait.
 *
 * CALLED WHERE A CASE REACHES A LOADER-BACKED DESTINATION, and deliberately not from
 * {@link mountApp} itself. A window opens on the sessions route, whose screen is
 * registered in component form, so a blanket walk at every mount would compile and
 * evaluate every other feature's chunk to settle a body no case is about to read — cost
 * paid fifteen times over for the one navigation that needs it. The call belongs at the
 * press that warms the destination, which is where the wait is real.
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
