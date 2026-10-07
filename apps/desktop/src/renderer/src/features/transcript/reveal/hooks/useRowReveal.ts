import { useCallback, useContext, useSyncExternalStore } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { RowRevealContext } from "../components/RowRevealProvider.js";
import { type PublishedText } from "../published-text.js";

/** Nothing to unsubscribe from. Module-scope, so the subscribe callback stays stable. */
const NO_REVEAL_SUBSCRIPTION: Unsubscribe = () => {};

/**
 * The text the reveal engine is publishing for this lane, as the lane's stable handle; the row
 * re-renders on each frame that changed it, and reads its `revision` for what to memoize on.
 *
 * `undefined` when the row is not a lane, when no lane by that name has been seen, or
 * outside a transcript: in each case there is no live text, so the stored body applies.
 */
export function useRowReveal(laneId: string | undefined): PublishedText | undefined {
  const channel = useContext(RowRevealContext);
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      channel === undefined ? NO_REVEAL_SUBSCRIPTION : channel.subscribe(onChange),
    [channel],
  );
  const readPublishedText = useCallback(
    (): PublishedText | undefined =>
      channel === undefined || laneId === undefined ? undefined : channel.publishedTextFor(laneId),
    [channel, laneId],
  );
  const readRevision = useCallback(
    (): number | undefined => readPublishedText()?.revision,
    [readPublishedText],
  );
  // The handle stays the same while its text grows, so it alone would never re-render the row;
  // the revision does, and the handle catches a lane replaced under the same name.
  useSyncExternalStore(subscribe, readRevision);
  return useSyncExternalStore(subscribe, readPublishedText);
}
