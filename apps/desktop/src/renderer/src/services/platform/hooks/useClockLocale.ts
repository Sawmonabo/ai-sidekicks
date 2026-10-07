import { useCallback, useSyncExternalStore } from "react";

import { usePlatformBridge } from "./usePlatformBridge.js";

/**
 * The locale every clock figure and date on screen is written in, from the region and the 12- or
 * 24-hour clock of the machine as they stand now; the tag to pass as a clock or date formatter's
 * locale. A change of either setting re-renders every caller.
 */
export function useClockLocale(): string {
  const { clockLocale } = usePlatformBridge();
  const subscribe = useCallback(
    (onStoreChange: () => void) => clockLocale.subscribe(onStoreChange),
    [clockLocale],
  );
  const read = useCallback(() => clockLocale.current, [clockLocale]);
  return useSyncExternalStore(subscribe, read);
}
