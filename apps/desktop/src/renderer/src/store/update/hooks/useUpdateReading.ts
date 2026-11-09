import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { UpdaterReadingHolder, type UpdaterCalls, type UpdateReading } from "../reading.js";

/** The window's reading of the updater, and the act that reads it again after a failed read. */
export interface UpdateReadingBinding {
  readonly reading: UpdateReading;
  readonly readAgain: () => void;
}

/**
 * Bind this window's one reading of the updater; called once per window, which hands the reading
 * to every reader.
 *
 * The holder is constructed in a `useMemo` keyed on the updater and opened in an
 * effect, never in a render body. The sequencing between the subscription and the
 * opening read is the holder's, not this hook's.
 */
export function useUpdateReading(updater: UpdaterCalls): UpdateReadingBinding {
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
  const { reading } = useSyncExternalStore(subscribe, read, read);
  const readAgain = useCallback(() => {
    holder.open();
  }, [holder]);
  return { reading, readAgain };
}
