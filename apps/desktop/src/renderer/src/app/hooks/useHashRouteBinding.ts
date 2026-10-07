// The two-way binding between the window's location hash and the frame's route. The hash
// drives the route when a window is opened by URL or the address is edited; the route drives the
// hash when the rail or palette navigates, as a new history entry or, for a move that only follows
// a cursor, in place of the current one.
//
// Two rules make the loop terminate. A write is not news: writing the hash raises `hashchange`,
// and adopting that echo can revert a route the person chose in the same commit and flip the
// window between two destinations, so the binding ignores exactly the one hash it wrote, once.
// And the hash projects the route the store holds now, not the one a render closed over: an
// adopt earlier in the same commit has already moved the store on.

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

  const route = useWindowStore(frameStore, (state) => state.route);

  useEffect(() => {
    const echo = unheardWrite.current;
    unheardWrite.current = undefined;
    if (hash === echo) {
      return;
    }
    frameStore.adoptHash(hash);
  }, [frameStore, hash]);

  // Route → hash. A `not-found` route is left unpublished: formatting it back would destroy
  // the text the person typed before they could fix it.
  useEffect(() => {
    const { route: current, routeHistoryWrite } = frameStore.getState();
    if (current.kind === "not-found") {
      return;
    }
    const desired = formatRoute(current);
    if (ownerWindow.location.hash === desired) {
      return;
    }
    unheardWrite.current = desired;
    if (routeHistoryWrite === "replace") {
      ownerWindow.location.replace(desired);
    } else {
      ownerWindow.location.hash = desired;
    }
  }, [frameStore, route, ownerWindow]);
}
