// Mounting the composed window, once, for every suite that drives it.
//
// The three `ConsoleRoot` suites each drive the REAL composition root against the
// fixture bridge the `console-unit` project compiles in, so the mount is the one
// piece of scaffolding all of them share — and a second copy of it would be a
// second answer to "when has the console settled", which is exactly the question
// the two flushes below exist to answer once.

import { act, render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import { ConsoleRoot, type ConsoleRootProps } from "./ConsoleRoot.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";

/** Where a window with no particular address lands. */
export const SESSIONS_HASH = "#/sessions";

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 *
 * The observer is handed the whole surface context rather than the route alone.
 * That context is what the frame builds and hands to every surface, so it is the
 * one seam that reports what the composition root wired without replacing any of
 * it — and a second observer beside it would be a second such seam.
 *
 * `renderOverlay` fills the slot the observer leaves empty, and it is a second ROLE
 * rather than a second observer: `App.tsx` composes the window-scoped overlays into
 * this same slot, so a case about what one of them does to the frame around it has
 * to put the real component there. Both callbacks take the context because both jobs
 * need it, and the slot stays empty for every case that asks for neither.
 */
export async function mountConsole(
  observe?: (context: ConsoleSurfaceContext) => void,
  renderOverlay?: (context: ConsoleSurfaceContext) => ReactNode,
): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  const props: ConsoleRootProps =
    observe === undefined && renderOverlay === undefined
      ? {}
      : {
          renderOverlays: (context) => {
            observe?.(context);
            return renderOverlay === undefined ? null : renderOverlay(context);
          },
        };
  await act(async () => {
    mounted = render(<ConsoleRoot {...props} />);
    await crossMacrotaskBoundary();
  });
  if (mounted === undefined) {
    throw new Error("the console never mounted");
  }
  return mounted;
}

/**
 * Let every registered SURFACE body finish arriving.
 *
 * THE ONE ANSWER TO "HAS THE DESTINATION LANDED", for every suite that drives the
 * composed window. A family's destination is a dynamic import behind the surface board,
 * so the frame commits the reserved region first and the body one or more macrotasks
 * later; a case that counted boundaries instead would be asserting how many turns a
 * chunk takes to arrive, and it would start failing the day a family gained an import.
 * Awaiting the board's own `preload` is the deterministic wait — the same call the idle
 * warm walk and the rail's press make — so the assertions below it are about what the
 * surface renders and never about timing.
 *
 * THE PANE BOARD IS DELIBERATELY NOT WALKED HERE. A surface is what a rail destination
 * mounts, and that is what these suites drive; the pane board holds every kind a deck
 * can seat, including ones whose modules stand up an emulator or a hosted view, and
 * loading all of them at every `ConsoleRoot` mount stands up machinery no case asked
 * for. The pane side has its own answer next door — `test/console/console-harness.tsx`
 * preloads the pane board inside `renderSettled`, where a case is actually seating one.
 *
 * EVERY REGISTERED SLOT, NOT THE UNLOADED ONES. `unloadedKeys()` reports the slots
 * nothing has ASKED for yet, and the press this helper follows is itself an ask: it warms
 * its destination before it navigates, so by the time a case waits the slot it is waiting
 * on has already left that list and a walk over it would await nothing at all and return
 * while the body was still in flight. Whether the assertion then passed came down to how
 * many macrotasks the mount happened to take, which is the timing dependence this helper
 * exists to remove — it showed up as a case that passed alone and failed in a full tier
 * run. `preload` settles immediately for a body already in hand and joins the one promise
 * for a body in flight, so walking the registered slots is idempotent and is the wait.
 *
 * CALLED WHERE A CASE REACHES A LOADER-BACKED DESTINATION, and deliberately not from
 * {@link mountConsole} itself. A window opens on the sessions route, whose surface is
 * registered in component form, so a blanket walk at every mount would compile and
 * evaluate every other family's chunk to settle a body no case is about to read — cost
 * paid fifteen times over for the one navigation that needs it. The call belongs at the
 * press that warms the destination, which is where the wait is real.
 */
export async function settleRegisteredBodies(): Promise<void> {
  await act(async () => {
    await Promise.all(
      consoleSurfaceRegistry.registeredSlots().map((slot) => consoleSurfaceRegistry.preload(slot)),
    );
    await crossMacrotaskBoundary();
  });
}
