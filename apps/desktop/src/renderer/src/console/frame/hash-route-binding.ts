// The two-way binding between the window's location hash and the frame's route.
//
// Both directions are real. The Window menu opens auxiliary windows BY URL and a
// person can edit or go back in the address, so the hash drives the route; the rail
// and the palette navigate in-window, so the route drives the hash. Two directions
// over one value is a loop by construction, and the two rules below are what make it
// terminate — each for its own reason, neither standing in for the other.
//
// **A write is not news.** Writing the hash raises `hashchange`, so the binding hears
// its own write come back. Re-adopting that echo is not idempotent the way it looks:
// by the time the echo arrives the person may have navigated again, and the browser
// may deliver the echo in the SAME commit as that navigation — a hash the binding
// itself put there then reverts a route the person just chose, whereupon the writer
// puts the old hash back, and the window flips between two destinations until React
// gives up with a depth error. So the binding remembers the one hash it wrote and
// ignores exactly that echo, once. Anything else — a back button, an edited address,
// a second window's link — is news and is adopted.
//
// **The hash is a projection of the route the store holds NOW.** The writer reads the
// store rather than the route its render closed over. Effects in one commit run in
// order, so an adopt that lands first has already moved the store on; a writer using
// the render's route would publish a destination the store has left, which is the
// same flip from the other side. Reading live cannot loop: every write publishes the
// current route, so the next echo always matches.
//
// Both directions live here rather than beside each other in the frame's render body
// because they are one mechanism with one piece of state, and a rule that lives in
// two effects in two places is a rule with two chances to be wrong.

import { useEffect, useRef } from "react";

import { formatRoute } from "../routing/index.js";
import { useFrameStore, type FrameStore } from "../store/index.js";

/**
 * Bind this window's location hash to its route, in both directions.
 *
 * @param frameStore This window's frame store — the route's one owner.
 * @param hash The caller's live hash subscription. Passed in rather than read again
 *   here so the window holds ONE `hashchange` subscription: the same value seeds the
 *   store at construction and drives this binding afterwards, and two subscriptions
 *   to one browser value are two answers to the same question.
 */
export function useHashRouteBinding(frameStore: FrameStore, hash: string): void {
  // The hash this binding wrote and has not yet heard back. A ref rather than state:
  // nothing renders from it, and re-rendering the window to record what it just did
  // would be a pass that changes no pixel.
  const unheardWrite = useRef<string | undefined>(undefined);

  const route = useFrameStore(frameStore, (state) => state.route);

  // Hash → route.
  useEffect(() => {
    const echo = unheardWrite.current;
    unheardWrite.current = undefined;
    if (hash === echo) {
      return;
    }
    frameStore.adoptHash(hash);
  }, [frameStore, hash]);

  // Route → hash.
  //
  // `route` is the dependency — it is what changed — but the value published is the
  // store's, for the reason at the top of this file. A `not-found` route is left
  // unpublished: it is what an unparseable hash BECAME, and formatting it back over
  // the address would destroy the text the person typed before they could fix it.
  useEffect(() => {
    const current = frameStore.getState().route;
    if (current.kind === "not-found") {
      return;
    }
    const desired = formatRoute(current);
    if (window.location.hash === desired) {
      return;
    }
    unheardWrite.current = desired;
    window.location.hash = desired;
  }, [frameStore, route]);
}
