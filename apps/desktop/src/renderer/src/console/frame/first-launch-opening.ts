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
      frameStore.navigate(route);
      await uiStateStore.writeGlobal(
        FIRST_LAUNCH_SEEN_KEY,
        FIRST_LAUNCH_SEEN_VALUE_CLASS,
        FIRST_LAUNCH_SEEN_VALUE,
      );
    })();

    return () => {
      isCancelled = true;
    };
  }, [bridge, frameStore, uiStateStore, openedAtHash]);
}
