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

/** What a caller may vary about the mount: this window's opening, and one seam. */
export interface MountConsoleOptions {
  /**
   * Which fixture scenario the window plays.
   *
   * Omitted, the window opens on the default scenario exactly as a launch does. A
   * suite names one when the composition it is asserting about is a scenario's to
   * script — a scripted handshake refusal, say, which no window reaches by default.
   */
  readonly scenarioId?: string;
  /**
   * The address the window is BORN at, put in place before the first render.
   *
   * Omitted, a mount with no address at all is given the sessions list's, and an
   * address the case set for itself is left exactly as the case set it.
   *
   * THAT DEFAULT IS LOAD-BEARING RATHER THAN TIDY. A window born at no address is an
   * install's first launch, and a fixture build opens one into the demonstration
   * session instead of the sessions list — a different composition, whose deck pulls
   * its pane chunks in while the mount is still settling, so the mount settles in
   * hundreds of milliseconds rather than tens and the window's own idle warm walk
   * reaches the surface board inside it. A unit suite is not an install's first
   * launch and does not become one by saying nothing; the three suites that set an
   * address in a `beforeEach` already said so, and this is the same statement made
   * once for the suites that do not. A case that MEANS the first launch names the
   * empty address and gets it.
   */
  readonly openedAtHash?: string;
  /**
   * The whole surface context the frame built, handed back once per render.
   *
   * That context is what the frame builds and hands to every surface, so it is the
   * one seam that reports what the composition root wired without replacing any of
   * it — and a second observer beside it would be a second such seam.
   */
  readonly observe?: (context: ConsoleSurfaceContext) => void;
  /**
   * What goes in the window-scoped overlay slot the observer leaves empty.
   *
   * A second ROLE rather than a second observer: `App.tsx` composes the real
   * window-scoped overlays into this same slot, so a case about what one of them
   * does to the frame around it has to put the real component there.
   */
  readonly renderOverlay?: (context: ConsoleSurfaceContext) => ReactNode;
}

/**
 * Mount and let the settled promises land.
 *
 * `ConsoleRoot` starts the persistence open on mount and swaps the durable adapter
 * in when it settles, so a test that asserted straight after `render` would assert
 * against a half-settled tree and leave a state update landing outside `act`. Two
 * flushes rather than one: the open resolves a promise whose continuation schedules
 * another.
 *
 * `renderOverlay` fills the slot the observer leaves empty, and it is a second ROLE
 * rather than a second observer: `App.tsx` composes the window-scoped overlays into
 * this same slot, so a case about what one of them does to the frame around it has
 * to put the real component there. Both callbacks take the context because both jobs
 * need it, and the slot stays empty for every case that asks for neither.
 *
 * `scenarioId` names which scripted session the fixture plays, for the suites whose
 * claim is about what a scenario DELIVERS rather than about the shell. Absent, the
 * window opens on the first-run scenario, which is what every other suite drives.
 */
export async function mountConsole(options: MountConsoleOptions = {}): Promise<RenderResult> {
  let mounted: RenderResult | undefined;
  const { scenarioId, observe, renderOverlay } = options;
  openWindowAt(options.openedAtHash);
  const props: ConsoleRootProps = {
    // Spread rather than passed as `scenarioId={scenarioId}`: the prop is optional
    // under `exactOptionalPropertyTypes`, so an explicit `undefined` is a different
    // value from an absent prop — and an absent one is what makes the window open on
    // the first-run scenario every other suite drives.
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(observe === undefined && renderOverlay === undefined
      ? {}
      : {
          renderOverlays: (context: ConsoleSurfaceContext) => {
            observe?.(context);
            return renderOverlay === undefined ? null : renderOverlay(context);
          },
        }),
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
 * Put this window's opening address in place, before anything reads it.
 *
 * WRITTEN ONTO THE WINDOW RATHER THAN PASSED AS A PROP, because that is where the
 * console reads it from: the frame store parses `window.location.hash` in its own
 * constructor and the first-launch rule is decided on the same value, so an address
 * handed through a prop would be an address neither of them consults.
 *
 * THE EMPTY READING IS THE ONLY ONE IT OVERRIDES. A case that set an address before
 * mounting is stating the window's opening, and a helper that overwrote it would be
 * the second writer `hash-route-binding.ts` exists to keep off this value.
 */
function openWindowAt(openedAtHash: string | undefined): void {
  if (openedAtHash !== undefined) {
    window.location.hash = openedAtHash;
    return;
  }
  if (window.location.hash === "") {
    window.location.hash = SESSIONS_HASH;
  }
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
