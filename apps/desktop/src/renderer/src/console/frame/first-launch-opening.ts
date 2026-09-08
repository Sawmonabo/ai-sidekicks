// Performing the first-launch opening: read the mark, navigate, write it back.
//
// BESIDE `first-launch.ts` RATHER THAN INSIDE IT, because the two fail differently
// and are read by different people. That module is the RULE — three conjuncts over
// three values, decidable on a table — and this one is the ACT, which touches a
// durable store, a frame store, and a bridge. A rule that is wrong renders the wrong
// opening; an act that is wrong shows the right opening twice, or writes a mark for
// an opening it never performed.
//
// IT RUNS ONCE PER WINDOW AND READS ONCE. There is no polling and no re-read on
// focus: whether this install has been introduced to itself is not a fact that
// changes while a window is open, and the one write that changes it is this hook's
// own.
//
// AND IT NEVER TAKES A ROUTE A PERSON CHOSE. The read is asynchronous and the rest of
// the frame is interactive while it is in flight, so somebody can reach Settings, the
// sessions list, or a workspace before it settles — and the redirect it computed was
// decided from the hash the window was BORN at, which stopped describing where they
// are the moment they moved. So the opening route is captured when the read is issued
// and any move off it retires the redirect for good.
//
// WHY A SUBSCRIPTION AND NOT A COMPARISON AT SETTLEMENT. Both are safe against the
// narrow race — nothing can navigate between reading the guard and calling `navigate`,
// because that is straight-line synchronous code and a navigation only ever arrives on
// an event — so the choice is decided by the case they answer differently: somebody who
// leaves the opening route and comes back. A comparison sees the route it started at
// and redirects; the subscription has already LATCHED and does not. The second is
// right, and not by a margin: a person who has navigated has met the frame, and
// throwing them into a demo workspace afterwards is the thing this whole guard exists
// to stop — the route they are standing on being equal to the one they opened at does
// not make it a route they did not choose.
//
// THE ORDER IS NAVIGATE-THEN-MARK, and it is deliberate. Marking first would lose the
// demo for good if the navigation never happened — a window closed in that gap has
// been told it saw something it did not. Navigating first risks the opposite, a
// second viewing after a write that failed, which is the harmless direction: the
// store's own write result carries a refusal the caller can see, and the cost of
// getting it wrong is one extra minute of a session that demonstrates the product.
//
// AND IT NEVER FIGHTS THE HASH. The navigation goes through the frame store, which is
// the one owner of the route; `hash-route-binding.ts` publishes the new route to the
// address bar from there, exactly as it does for the rail. Writing a hash here would
// be the second writer that binding exists to prevent.

import { useEffect, useRef } from "react";

import { type ConsoleBridge } from "../bridge/index.js";
import { type UiStateStore } from "../persistence/index.js";
import { routesAreEqual } from "../routing/index.js";
import { type FrameStore } from "../store/index.js";
import {
  FIRST_LAUNCH_SEEN_KEY,
  FIRST_LAUNCH_SEEN_VALUE,
  FIRST_LAUNCH_SEEN_VALUE_CLASS,
  firstLaunchRoute,
  hasSeenFirstLaunch,
} from "./first-launch.js";

export interface FirstLaunchOpeningInputs {
  readonly bridge: ConsoleBridge;
  readonly frameStore: FrameStore;
  readonly uiStateStore: UiStateStore;
  /** The hash the window was BORN at — the ref-held opening value, never a live one. */
  readonly openedAtHash: string;
}

/**
 * Open this window into the demo, the first time an install is ever launched.
 *
 * Guarded by a ref rather than by the effect's dependency list, because the guard is
 * about the WINDOW and not about the values: a dependency that changed identity would
 * re-run an effect whose whole contract is that it happens at most once, and the read
 * it performs is asynchronous, so two runs would race each other to the same write.
 */
export function useFirstLaunchOpening(inputs: FirstLaunchOpeningInputs): void {
  const { bridge, frameStore, uiStateStore, openedAtHash } = inputs;
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    hasRunRef.current = true;

    // Captured before the await: the window is unmounted by the time a slow read
    // returns in a test that tore down, and navigating a discarded store is a write
    // nobody reads. `isCancelled` is the standard shape and is what the cleanup sets.
    let isCancelled = false;

    // Where the window stands at the moment the read is issued. Taken from the store
    // rather than parsed from `openedAtHash`: the hash is what the RULE turns on, and
    // this is what the ACT would replace, so the guard compares the redirect against
    // the thing it is about to overwrite.
    const openingRoute = frameStore.getState().route;
    // Latched by the first move off that route, and never unlatched. The comparison is
    // structural, through the routing family's own reader, so a store that republished
    // an equal route — which `adoptHash` does not, but nothing here depends on that —
    // is not read as a person navigating.
    let hasLeftOpeningRoute = false;
    const stopWatchingRoute = frameStore.readable.subscribe((state) => {
      if (!routesAreEqual(state.route, openingRoute)) {
        hasLeftOpeningRoute = true;
      }
    });

    void (async () => {
      const storedMark = await uiStateStore.readGlobal(FIRST_LAUNCH_SEEN_KEY);
      if (isCancelled) {
        return;
      }
      const route = firstLaunchRoute({
        openedAtHash,
        demoSessionId: bridge.scenarioEngine?.scenario.sessionId,
        playingScenarioId: bridge.scenarioEngine?.scenario.id,
        hasSeenFirstLaunch: hasSeenFirstLaunch(storedMark),
      });
      if (route === undefined) {
        return;
      }
      // Read here and acted on here, with nothing between: the two statements are one
      // synchronous run, so no navigation can land after the guard passes and before
      // the redirect is applied. AND NO MARK IS WRITTEN on this arm — the demo was not
      // shown, so recording that it was would lose it for the install, which is the
      // navigate-then-mark ordering this module already keeps for its other refusal.
      if (hasLeftOpeningRoute) {
        return;
      }
      frameStore.navigate(route);
      await uiStateStore.writeGlobal(
        FIRST_LAUNCH_SEEN_KEY,
        FIRST_LAUNCH_SEEN_VALUE_CLASS,
        FIRST_LAUNCH_SEEN_VALUE,
      );
    })();

    return () => {
      isCancelled = true;
      stopWatchingRoute();
    };
  }, [bridge, frameStore, uiStateStore, openedAtHash]);
}
