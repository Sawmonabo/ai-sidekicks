// The two-way binding between the window's location hash and the frame's route. The hash
// drives the route when a window is opened by URL, the address is edited or Back is pressed; the
// route drives the hash when the rail or palette navigates, as a new history entry or, for a move
// that only follows a cursor or one the address already entered, in place of the current one.
//
// Two rules make the loop terminate. A write is not news: writing the hash raises `hashchange`,
// and adopting that echo can revert a route the person chose in the same commit and flip the
// window between two destinations, so the binding ignores exactly the one hash it wrote, once.
// And the hash projects the route the store holds now, not the one a render closed over: an
// adopt earlier in the same commit has already moved the store on.
//
// An address change a screen holding unsaved edits has not let go of (its question is open, or
// it answered no) puts the address back on the route still shown as a new entry, so a refused
// Back keeps the entry it would have returned to. A yes then steps back over that entry to the
// address the change named, so the window's history holds no copy of it and the next Back moves.

import { useEffect, useRef } from "react";

import { formatRoute } from "#renderer/routing/routes.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { type WindowStore } from "#renderer/store/window/store.js";

/**
 * Bind `ownerWindow`'s location hash to its route, in both directions.
 *
 * @param hash The caller's live hash subscription, passed in so the window holds one
 *   `hashchange` subscription: the same value seeds the store and drives this binding.
 */
export function useHashRouteBinding(
  frameStore: WindowStore,
  hash: string,
  ownerWindow: Window,
): void {
  // The hash this binding wrote and has not yet heard back; a ref, since nothing renders from it.
  const unheardWrite = useRef<string | undefined>(undefined);
  // The hash a refused address change pushed back, once a yes means the next route write steps
  // back over it.
  const restoredEntry = useRef<string | undefined>(undefined);

  const route = useWindowStore(frameStore, (state) => state.route);

  useEffect(() => {
    const echo = unheardWrite.current;
    unheardWrite.current = undefined;
    // Set only once this change is put back, so a move that commits at once steps over nothing.
    const putBack: { hash?: string } = {};
    const stepBackOverRestored = (): void => {
      restoredEntry.current = putBack.hash;
    };
    if (hash === echo || frameStore.adoptHash(hash, stepBackOverRestored)) {
      return;
    }
    // The route did not move, so the route → hash effect below will not run for it.
    const shown = frameStore.getState().route;
    if (shown.kind === "not-found") {
      return;
    }
    putBack.hash = formatRoute(shown);
    unheardWrite.current = putBack.hash;
    ownerWindow.location.hash = putBack.hash;
  }, [frameStore, hash, ownerWindow]);

  // Route → hash. A `not-found` route is left unpublished: formatting it back would destroy
  // the text the person typed before they could fix it.
  useEffect(() => {
    const { route: current, routeHistoryWrite } = frameStore.getState();
    // Taken before any return, so it applies to this write alone.
    const restored = restoredEntry.current;
    restoredEntry.current = undefined;
    if (current.kind === "not-found") {
      return;
    }
    const desired = formatRoute(current);
    if (ownerWindow.location.hash === desired) {
      return;
    }
    unheardWrite.current = desired;
    if (restored !== undefined && ownerWindow.location.hash === restored) {
      // The entry before the restored one is the address the yes followed.
      ownerWindow.history.back();
    } else if (routeHistoryWrite === "replace") {
      ownerWindow.location.replace(desired);
    } else {
      ownerWindow.location.hash = desired;
    }
  }, [frameStore, route, ownerWindow]);
}
