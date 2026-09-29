import { useCallback, useContext, useSyncExternalStore } from "react";

import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { RowRevealContext } from "../components/RowRevealProvider.js";

/** Nothing to unsubscribe from. Module-scope, so the subscribe callback stays stable. */
const NO_REVEAL_SUBSCRIPTION: Unsubscribe = () => {};

/**
 * The text the reveal engine is publishing for this lane right now.
 *
 * `undefined` when the row is not a lane, when no lane by that name has been seen, or
 * outside a transcript: in each case there is no live text, so the stored body applies.
 */
export function useRowReveal(laneId: string | undefined): string | undefined {
  const channel = useContext(RowRevealContext);
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      channel === undefined ? NO_REVEAL_SUBSCRIPTION : channel.subscribe(onChange),
    [channel],
  );
  const readPublishedText = useCallback(
    (): string | undefined =>
      channel === undefined || laneId === undefined ? undefined : channel.publishedTextFor(laneId),
    [channel, laneId],
  );
  return useSyncExternalStore(subscribe, readPublishedText);
}
