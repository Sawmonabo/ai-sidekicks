import { useCallback, useSyncExternalStore } from "react";

import type { PushDrivenRead, PushDrivenReadState } from "../push-driven-read.js";

/**
 * Read one {@link PushDrivenRead} from React.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect: the model already
 * is an external store, and mirroring its state into component state would be the
 * second copy this whole module exists to avoid. The model is constructed by
 * whoever owns its lifetime — never in a render body.
 */
export function usePushDrivenRead<TValue>(
  model: PushDrivenRead<TValue>,
): PushDrivenReadState<TValue> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => model.onChange(onStoreChange),
    [model],
  );
  const read = useCallback(() => model.state, [model]);
  return useSyncExternalStore(subscribe, read, read);
}
