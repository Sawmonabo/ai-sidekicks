import { useCallback, useSyncExternalStore } from "react";

import type { PushDrivenRead, PushDrivenReadState } from "../push-driven.js";

/**
 * Reads one {@link PushDrivenRead} from React.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, since the model already is an
 * external store and mirroring it would be a second copy. The model is constructed by whoever
 * owns its lifetime, never in a render body; with none, while nothing on screen draws it, the
 * state is `not-loaded`.
 */
export function usePushDrivenRead<TValue>(
  model: PushDrivenRead<TValue> | undefined,
): PushDrivenReadState<TValue> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => model?.onChange(onStoreChange) ?? (() => undefined),
    [model],
  );
  const read = useCallback((): PushDrivenReadState<TValue> => model?.state ?? NOT_LOADED, [model]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The state of a read nothing holds. */
const NOT_LOADED = { kind: "not-loaded" } as const;
