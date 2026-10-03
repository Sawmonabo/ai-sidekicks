import { useCallback, useSyncExternalStore } from "react";

import type { PushDrivenRead, PushDrivenReadState } from "../push-driven-read.js";

/**
 * Reads one {@link PushDrivenRead} from React.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, since the model already is an
 * external store and mirroring it would be a second copy. The model is constructed by whoever
 * owns its lifetime, never in a render body.
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
