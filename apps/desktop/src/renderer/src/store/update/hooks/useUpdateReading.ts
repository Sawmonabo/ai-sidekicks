import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { UpdaterReadingHolder, type UpdaterCalls, type UpdateReading } from "../updater-reading.js";

/**
 * Bind this window's one reading of the updater; called once per window, which hands the reading
 * to every reader.
 *
 * The holder is constructed in a `useMemo` keyed on the updater and opened in an
 * effect, never in a render body. The sequencing between the subscription and the
 * opening read is the holder's, not this hook's.
 */
export function useUpdateReading(updater: UpdaterCalls): UpdateReading {
  const holder = useMemo(() => new UpdaterReadingHolder(updater), [updater]);
  useEffect(() => {
    holder.open();
    return () => {
      holder.close();
    };
  }, [holder]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => holder.subscribe(onStoreChange),
    [holder],
  );
  const read = useCallback(() => holder.snapshot(), [holder]);
  return useSyncExternalStore(subscribe, read, read).reading;
}
